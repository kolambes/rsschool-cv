"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Модуль карты: геоданные остановок и маршрутов, GeoJSON для Mini App,
// слой GPS-провайдеров (demo-провайдер + контракт для реального),
// изменения движения с рассылкой подписчикам, подписки на маршруты
// и серверная синхронизация избранного по Telegram ID.
//
// Подключается из server.js через init(deps) + handlePublicApi/handleAdminApi.
// Собственные таблицы создаёт сам (CREATE TABLE IF NOT EXISTS), чтобы
// не менять базовую схему в db.js.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("node:crypto");
const { getDb, listRoutes } = require("./db.js");
const geoNetwork = require("./map-geo-network.js");
const { RedisLite } = require("./redis-lite.js");

// ── Конфигурация через переменные окружения ─────────────────────────────────

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(raw).toLowerCase());
}

function envNum(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
}

// GPS_ALLOWED_BOUNDS: "minLat,minLng,maxLat,maxLng"
function parseBounds(raw, fallback) {
  const parts = String(raw || "").split(",").map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return { minLat: parts[0], minLng: parts[1], maxLat: parts[2], maxLng: parts[3] };
  }
  return fallback;
}

const MAP_ENV = {
  provider: process.env.MAP_PROVIDER || "maplibre",
  tileUrl: process.env.MAP_TILE_URL || "",
  styleUrl: process.env.MAP_STYLE_URL || "",
  schemeStyleUrl: process.env.MAP_SCHEME_STYLE_URL || "",
  satelliteTileUrl: process.env.MAP_SATELLITE_TILE_URL || "",
  hybridStyleUrl: process.env.MAP_HYBRID_STYLE_URL || "",
  defaultLat: envNum("MAP_DEFAULT_LAT", 53.1327, -90, 90),
  defaultLng: envNum("MAP_DEFAULT_LNG", 26.0139, -180, 180),
  defaultZoom: envNum("MAP_DEFAULT_ZOOM", 12, 3, 18),
  // Фиче-флаги. ENABLE_MOCK_GPS: пусто → управляется тумблером в админке,
  // явное true/false → жёстко включён/выключен независимо от админки.
  mapFeaturesEnabled: envBool("ENABLE_MAP_FEATURES", true),
  demoMapDataEnabled: envBool("ENABLE_DEMO_MAP_DATA", true),
  mockGpsEnv: process.env.ENABLE_MOCK_GPS ?? "",
  gpsPollSeconds: envNum("GPS_POLLING_INTERVAL_SECONDS", 15, 3, 300),
  gpsStaleSeconds: envNum("GPS_STALE_AFTER_SECONDS", 60, 10, 3600),
  gpsMaxSpeedKmh: envNum("GPS_MAX_SPEED_KMH", 100, 20, 300),
  mapCacheTtlMs: envNum("MAP_CACHE_TTL_SECONDS", 300, 5, 86400) * 1000,
  vehicleCacheTtlMs: envNum("LIVE_VEHICLE_CACHE_TTL_SECONDS", 30, 1, 600) * 1000,
};

// Центр Барановичей — отправная точка схематичной раскладки демо-геоданных.
const CITY_CENTER = { lat: MAP_ENV.defaultLat, lng: MAP_ENV.defaultLng };
const CITY_BOUNDS = parseBounds(process.env.GPS_ALLOWED_BOUNDS, {
  minLat: 52.95, maxLat: 53.32, minLng: 25.75, maxLng: 26.30,
});

const DEMO_VEHICLES_PER_DIRECTION = 1;
// Транспорт пересчитывается не чаще интервала опроса GPS (и не чаще 2 с)
const VEHICLES_MIN_INTERVAL_MS = Math.max(2000, Math.min(MAP_ENV.gpsPollSeconds * 1000, MAP_ENV.vehicleCacheTtlMs));

let deps = null;
let tablesReady = false;

// ── Кэш: память + опциональный Redis (REDIS_URL) ────────────────────────────
// Redis нужен для нескольких инстансов; при недоступности прозрачно
// работает только память — карта не деградирует.

const redis = process.env.REDIS_URL ? new RedisLite(process.env.REDIS_URL) : null;
const memoryCache = new Map(); // key → { value, expiresAt }

const mapCache = {
  async get(key) {
    const hit = memoryCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    memoryCache.delete(key);
    if (redis) {
      const raw = await redis.get(key).catch(() => null);
      if (raw) {
        try {
          const value = JSON.parse(raw);
          memoryCache.set(key, { value, expiresAt: Date.now() + 3000 }); // короткий L1
          return value;
        } catch { /* повреждённое значение игнорируем */ }
      }
    }
    return null;
  },
  async set(key, value, ttlMs) {
    memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (redis) await redis.set(key, JSON.stringify(value), ttlMs).catch(() => false);
  },
  async del(...keys) {
    for (const key of keys) memoryCache.delete(key);
    if (redis) await redis.del(...keys).catch(() => 0);
  },
};

const CACHE_KEYS = { data: "map:data:v2", vehicles: "map:vehicles:v2" };

// ── Инициализация ────────────────────────────────────────────────────────────

function init(injected) {
  deps = injected;
  ensureMapTables();
}

function ensureMapTables() {
  if (tablesReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS map_stop_geo (
      stop_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'admin',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS map_route_geometry (
      route_id TEXT NOT NULL,
      direction_code TEXT NOT NULL,
      geometry TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'admin',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (route_id, direction_code)
    );

    CREATE TABLE IF NOT EXISTS map_alerts (
      alert_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      alert_type TEXT NOT NULL DEFAULT 'delay',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      active_until_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      notified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_map_alerts_status ON map_alerts(status, updated_at);

    CREATE TABLE IF NOT EXISTS map_route_subscriptions (
      telegram_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (telegram_id, route_id)
    );
    CREATE INDEX IF NOT EXISTS idx_map_subs_route ON map_route_subscriptions(route_id);

    CREATE TABLE IF NOT EXISTS user_favorites_sync (
      telegram_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS map_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  tablesReady = true;
}

function nowIso() {
  return new Date().toISOString();
}

function invalidateMapCaches() {
  // синхронно чистим память, Redis — в фоне
  memoryCache.delete(CACHE_KEYS.data);
  memoryCache.delete(CACHE_KEYS.vehicles);
  mapCache.del(CACHE_KEYS.data, CACHE_KEYS.vehicles).catch(() => {});
}

// Зеркало normalizeName из db.js: ключ физической остановки — её
// нормализованное имя, общее для всех маршрутов через эту остановку.
function normalizeStopKey(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getMapSetting(key, fallback = "") {
  const row = getDb().prepare("SELECT value FROM map_settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setMapSetting(key, value) {
  getDb()
    .prepare("INSERT INTO map_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

function demoVehiclesEnabled() {
  // ENABLE_MOCK_GPS: явное значение главнее тумблера в админке
  const envValue = String(MAP_ENV.mockGpsEnv).toLowerCase();
  if (["true", "1", "yes", "on"].includes(envValue)) return true;
  if (["false", "0", "no", "off"].includes(envValue)) return false;
  // обратная совместимость со старой переменной
  if (["1", "true", "yes"].includes(String(process.env.MAP_DEMO_VEHICLES || "").toLowerCase())) return true;
  return getMapSetting("demo_vehicles", "0") === "1";
}

// ── Геоданные ────────────────────────────────────────────────────────────────

// Все физические остановки (уникальные по normalized_name) + координаты, если есть.
function listPhysicalStops() {
  const db = getDb();
  return db
    .prepare(`
      SELECT s.normalized_name AS key,
             MIN(s.name) AS name,
             COUNT(DISTINCT s.route_id) AS routeCount,
             g.lat AS lat, g.lng AS lng, g.source AS geoSource
      FROM stops s
      LEFT JOIN map_stop_geo g ON g.stop_key = s.normalized_name
      GROUP BY s.normalized_name
      ORDER BY MIN(s.name)
    `)
    .all();
}

function setStopGeo(stopKey, lat, lng, source = "admin") {
  const key = normalizeStopKey(stopKey);
  if (!key) throw deps.httpError("Не указана остановка.", 400);
  if (!isValidCoordinate(lat, lng)) throw deps.httpError("Координаты вне зоны обслуживания.", 400);
  const db = getDb();
  const nameRow = db.prepare("SELECT name FROM stops WHERE normalized_name = ? LIMIT 1").get(key);
  db.prepare(`
    INSERT INTO map_stop_geo (stop_key, name, lat, lng, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(stop_key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng,
      source = excluded.source, updated_at = excluded.updated_at
  `).run(key, nameRow?.name || stopKey, lat, lng, source, nowIso());
  invalidateMapCaches();
}

function removeStopGeo(stopKey) {
  getDb().prepare("DELETE FROM map_stop_geo WHERE stop_key = ?").run(normalizeStopKey(stopKey));
  invalidateMapCaches();
}

function isValidCoordinate(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= CITY_BOUNDS.minLat && lat <= CITY_BOUNDS.maxLat &&
    lng >= CITY_BOUNDS.minLng && lng <= CITY_BOUNDS.maxLng
  );
}

function parseGeometry(raw) {
  let geometry = raw;
  if (typeof raw === "string") {
    try {
      geometry = JSON.parse(raw);
    } catch {
      throw deps.httpError("Геометрия должна быть JSON-массивом координат [[lng, lat], ...].", 400);
    }
  }
  if (!Array.isArray(geometry) || geometry.length < 2) {
    throw deps.httpError("Геометрия должна содержать минимум две точки.", 400);
  }
  if (geometry.length > 2000) throw deps.httpError("Слишком длинная геометрия (максимум 2000 точек).", 400);
  const cleaned = geometry.map((point) => {
    const lng = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (!isValidCoordinate(lat, lng)) throw deps.httpError("Точка геометрии вне зоны обслуживания.", 400);
    return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
  });
  return cleaned;
}

function setRouteGeometry(routeId, directionCode, geometry, source = "admin") {
  const cleaned = parseGeometry(geometry);
  getDb().prepare(`
    INSERT INTO map_route_geometry (route_id, direction_code, geometry, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(route_id, direction_code) DO UPDATE SET geometry = excluded.geometry,
      source = excluded.source, updated_at = excluded.updated_at
  `).run(routeId, directionCode, JSON.stringify(cleaned), source, nowIso());
  invalidateMapCaches();
}

function removeRouteGeometry(routeId, directionCode) {
  getDb().prepare("DELETE FROM map_route_geometry WHERE route_id = ? AND direction_code = ?").run(routeId, directionCode);
  invalidateMapCaches();
}

// ── Публичные данные карты ───────────────────────────────────────────────────

// Статические данные карты собираются из расписания + геослоя и кэшируются.
// GeoJSON строится на клиенте из этого компактного ответа (reduced payload).
function buildMapData() {
  const db = getDb();
  const routes = listRoutes();
  // ENABLE_DEMO_MAP_DATA=false: демо-геоданные не отдаются наружу вовсе
  const demoFilter = MAP_ENV.demoMapDataEnabled ? "" : " WHERE source <> 'demo'";
  const geometryRows = db
    .prepare(`SELECT route_id AS routeId, direction_code AS directionCode, geometry, source FROM map_route_geometry${demoFilter}`)
    .all();
  const geometryByKey = new Map(geometryRows.map((row) => [`${row.routeId}:${row.directionCode}`, row]));

  const stopGeoRows = db.prepare(`SELECT stop_key AS key, name, lat, lng, source FROM map_stop_geo${demoFilter}`).all();
  const stopGeoByKey = new Map(stopGeoRows.map((row) => [row.key, row]));

  const stopRows = db
    .prepare("SELECT normalized_name AS key, name, route_id AS routeId FROM stops GROUP BY normalized_name, route_id")
    .all();
  const routeNumberById = new Map(routes.map((route) => [route.id, route.number]));
  const stopUsage = new Map();
  for (const row of stopRows) {
    if (!stopUsage.has(row.key)) stopUsage.set(row.key, { name: row.name, routeNumbers: new Set() });
    const number = routeNumberById.get(row.routeId);
    if (number) stopUsage.get(row.key).routeNumbers.add(number);
  }

  let demoGeo = false;
  const mapRoutes = [];
  for (const route of routes) {
    const directions = [];
    for (const direction of route.directions || []) {
      const geometryRow = geometryByKey.get(`${route.id}:${direction.code}`);
      if (!geometryRow) continue;
      if (geometryRow.source === "demo") demoGeo = true;
      directions.push({
        code: direction.code,
        name: direction.name,
        from: direction.from,
        to: direction.to,
        geometry: JSON.parse(geometryRow.geometry),
        stopKeys: (direction.stops || []).map((stop) => normalizeStopKey(stop.name))
      });
    }
    if (!directions.length) continue;
    mapRoutes.push({
      id: route.id,
      number: route.number,
      name: route.name,
      type: route.type,
      color: route.color,
      directions
    });
  }

  const mapStops = [];
  for (const [key, usage] of stopUsage) {
    const geo = stopGeoByKey.get(key);
    if (!geo) continue;
    if (geo.source === "demo") demoGeo = true;
    mapStops.push({
      key,
      name: usage.name,
      lat: geo.lat,
      lng: geo.lng,
      routes: [...usage.routeNumbers].sort((a, b) => String(a).localeCompare(String(b), "ru", { numeric: true }))
    });
  }

  const totalDirections = routes.reduce((sum, route) => sum + (route.directions?.length || 0), 0);
  return {
    ok: true,
    city: { lat: CITY_CENTER.lat, lng: CITY_CENTER.lng },
    demoGeo,
    coverage: {
      routesWithGeometry: mapRoutes.length,
      routesTotal: routes.length,
      directionsWithGeometry: geometryRows.length,
      directionsTotal: totalDirections,
      stopsWithGeo: mapStops.length,
      stopsTotal: stopUsage.size
    },
    routes: mapRoutes,
    stops: mapStops,
    generatedAt: nowIso()
  };
}

async function getMapData() {
  const cached = await mapCache.get(CACHE_KEYS.data);
  if (cached) return cached;
  const data = buildMapData();
  await mapCache.set(CACHE_KEYS.data, data, MAP_ENV.mapCacheTtlMs);
  return data;
}

// ── GPS-провайдеры ───────────────────────────────────────────────────────────
//
// Контракт провайдера (для реального GPS достаточно реализовать эти три метода
// и зарегистрировать провайдер вместо demo):
//
//   provider = {
//     name: string,
//     isDemo: boolean,
//     fetchVehiclePositions(): Promise<RawVehiclePosition[]>,
//     normalizePosition(raw): NormalizedVehiclePosition | null,
//     validatePosition(position): { ok: boolean, errors: string[] }
//   }

const demoGpsProvider = {
  name: "demo",
  isDemo: true,

  // Детерминированная симуляция: борт «едет» по сохранённой геометрии
  // направления туда-обратно. Позиция — функция времени, состояния нет.
  async fetchVehiclePositions() {
    const data = await getMapData();
    const nowSec = Date.now() / 1000;
    const raw = [];
    for (const route of data.routes) {
      route.directions.forEach((direction, dirIndex) => {
        const line = computeLineMeta(direction.geometry);
        if (!line.total) return;
        for (let i = 0; i < DEMO_VEHICLES_PER_DIRECTION; i++) {
          const seed = hashCode(`${route.id}:${direction.code}:${i}`);
          const speedKmh = 24 + (seed % 12); // 24–35 км/ч
          const speedMs = (speedKmh * 1000) / 3600;
          const offset = ((seed >> 4) % 1000) / 1000;
          const cycle = line.total * 2;
          let dist = ((offset * line.total + nowSec * speedMs) % cycle + cycle) % cycle;
          let forward = true;
          if (dist > line.total) {
            dist = cycle - dist;
            forward = false;
          }
          raw.push({
            id: `demo-${route.number}-${direction.code}-${i}`,
            routeId: route.id,
            routeNumber: route.number,
            directionCode: direction.code,
            directionName: forward ? direction.name : reverseDirectionName(direction),
            board: `ДЕМО ${route.number}-${dirIndex + 1}${i + 1}`,
            line,
            dist,
            forward,
            speedKmh
          });
        }
      });
    }
    return raw;
  },

  normalizePosition(raw) {
    const point = pointAlongLine(raw.line, raw.dist);
    if (!point) return null;
    return {
      id: raw.id,
      routeId: raw.routeId,
      routeNumber: raw.routeNumber,
      directionCode: raw.directionCode,
      directionName: raw.directionName,
      board: raw.board,
      lat: point.lat,
      lng: point.lng,
      bearing: raw.forward ? point.bearing : (point.bearing + 180) % 360,
      speedKmh: raw.speedKmh,
      timestamp: Date.now()
    };
  },

  validatePosition(position) {
    return validateGpsPosition(position);
  }
};

// Единая валидация позиций: границы GPS_ALLOWED_BOUNDS, скорость GPS_MAX_SPEED_KMH
function validateGpsPosition(position) {
  const errors = [];
  if (!isValidCoordinate(position.lat, position.lng)) errors.push("Позиция вне зоны обслуживания");
  if (!position.routeId) errors.push("Не указан маршрут");
  if (Number.isFinite(position.speedKmh) && position.speedKmh > MAP_ENV.gpsMaxSpeedKmh) {
    errors.push(`Скорость ${Math.round(position.speedKmh)} км/ч выше предела ${MAP_ENV.gpsMaxSpeedKmh}`);
  }
  return { ok: errors.length === 0, errors };
}

// ── Живой GPS: универсальный HTTP-провайдер ─────────────────────────────────
// Подключается к API автопарка (TRANSPORT_API_*) или Яндекс-совместимому
// endpoint'у (YANDEX_GPS_API_*). Ожидается JSON-массив позиций (или объект
// с полем vehicles/positions/data); поля распознаются по распространённым
// именам. Позиции никогда не выдумываются: нет данных — нет транспорта.
function createHttpGpsProvider(name, endpoint, apiKey) {
  return {
    name,
    isDemo: false,

    async fetchVehiclePositions() {
      const url = new URL(endpoint);
      if (apiKey && !url.searchParams.has("apikey")) url.searchParams.set("apikey", apiKey);
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
        },
        signal: AbortSignal.timeout(MAP_ENV.gpsPollSeconds * 1000),
      });
      if (!response.ok) throw new Error(`GPS API HTTP ${response.status}`);
      const payload = await response.json();
      const list = Array.isArray(payload)
        ? payload
        : payload.vehicles || payload.positions || payload.data || [];
      if (!Array.isArray(list)) throw new Error("GPS API вернул неожиданный формат");
      return list;
    },

    normalizePosition(raw) {
      const lat = Number(raw.lat ?? raw.latitude ?? raw.Lat);
      const lng = Number(raw.lng ?? raw.lon ?? raw.longitude ?? raw.Lon);
      const routeNumber = String(raw.routeNumber ?? raw.route ?? raw.route_no ?? "").trim();
      const routeId = String(raw.routeId ?? raw.route_id ?? "").trim() || routeIdByNumber(routeNumber);
      const tsRaw = raw.timestamp ?? raw.ts ?? raw.time ?? raw.updated_at;
      let timestamp = Date.now();
      if (Number.isFinite(Number(tsRaw))) {
        const num = Number(tsRaw);
        timestamp = num > 1e12 ? num : num * 1000; // сек → мс
      } else if (tsRaw) {
        const parsed = Date.parse(tsRaw);
        if (Number.isFinite(parsed)) timestamp = parsed;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !routeId) return null;
      return {
        id: String(raw.id ?? raw.board ?? raw.vehicleId ?? `${routeId}-${lat.toFixed(4)}`),
        routeId,
        routeNumber: routeNumber || routeNumberById(routeId),
        directionCode: String(raw.directionCode ?? raw.direction ?? ""),
        directionName: String(raw.directionName ?? ""),
        board: String(raw.board ?? raw.plate ?? raw.id ?? ""),
        lat,
        lng,
        bearing: Number(raw.bearing ?? raw.course ?? raw.heading ?? 0) || 0,
        speedKmh: Number(raw.speedKmh ?? raw.speed ?? 0) || 0,
        timestamp,
      };
    },

    validatePosition(position) {
      return validateGpsPosition(position);
    },
  };
}

let routeLookupCache = null;
function routeLookup() {
  if (!routeLookupCache) {
    const routes = listRoutes();
    routeLookupCache = {
      byNumber: new Map(routes.map((route) => [String(route.number), route.id])),
      byId: new Map(routes.map((route) => [route.id, String(route.number)])),
    };
  }
  return routeLookupCache;
}
const routeIdByNumber = (number) => routeLookup().byNumber.get(String(number)) || "";
const routeNumberById = (id) => routeLookup().byId.get(id) || "";

let activeGpsProvider = null;

// Приоритет источников GPS: явно зарегистрированный → API автопарка →
// Яндекс-совместимый endpoint → mock (если разрешён). Не выдумываем данные.
function resolveGpsProvider() {
  if (activeGpsProvider) return activeGpsProvider;
  if (process.env.TRANSPORT_API_ENDPOINT) {
    activeGpsProvider = createHttpGpsProvider("transport-api", process.env.TRANSPORT_API_ENDPOINT, process.env.TRANSPORT_API_KEY || "");
    return activeGpsProvider;
  }
  if (process.env.YANDEX_GPS_API_ENDPOINT) {
    activeGpsProvider = createHttpGpsProvider("yandex-gps", process.env.YANDEX_GPS_API_ENDPOINT, process.env.YANDEX_GPS_API_KEY || "");
    return activeGpsProvider;
  }
  if (demoVehiclesEnabled()) return demoGpsProvider;
  return null;
}

// Точка регистрации реального провайдера (например, из отдельного модуля).
function registerGpsProvider(provider) {
  activeGpsProvider = provider;
  invalidateMapCaches();
}

const VEHICLES_MAX_UNFILTERED = 120;

async function getVehicles(routeFilter = null) {
  let base = await mapCache.get(CACHE_KEYS.vehicles);

  if (!base) {
    const provider = resolveGpsProvider();
    if (!provider) {
      base = { ok: true, status: "offline", provider: null, vehicles: [], generatedAt: nowIso() };
    } else {
      let vehicles = [];
      let status = provider.isDemo ? "demo" : "live";
      try {
        const raw = await provider.fetchVehiclePositions();
        let staleCount = 0;
        for (const item of raw) {
          const position = provider.normalizePosition(item);
          if (!position) continue;
          // GPS_STALE_AFTER_SECONDS: устаревшие позиции не показываем
          if (Date.now() - (position.timestamp || 0) > MAP_ENV.gpsStaleSeconds * 1000) {
            staleCount += 1;
            continue;
          }
          const check = provider.validatePosition(position);
          if (check.ok) vehicles.push(position);
        }
        if (!vehicles.length && staleCount > 0) status = "stale";
      } catch (error) {
        console.warn(`Map GPS provider "${provider.name}" failed: ${error.message || error}`);
        status = "error";
        vehicles = [];
      }
      base = { ok: true, status, provider: provider.name, vehicles, generatedAt: nowIso() };
    }
    await mapCache.set(CACHE_KEYS.vehicles, base, VEHICLES_MIN_INTERVAL_MS);
  }

  // Reduced payload: клиент запрашивает борта только видимых маршрутов;
  // без фильтра отдаём не больше VEHICLES_MAX_UNFILTERED.
  if (routeFilter && routeFilter.size) {
    return { ...base, vehicles: base.vehicles.filter((vehicle) => routeFilter.has(vehicle.routeId)) };
  }
  if (base.vehicles.length > VEHICLES_MAX_UNFILTERED) {
    return { ...base, vehicles: base.vehicles.slice(0, VEHICLES_MAX_UNFILTERED), truncated: true };
  }
  return base;
}

// ── Геометрия: длины и интерполяция ─────────────────────────────────────────

const lineMetaCache = new Map();

function computeLineMeta(coords) {
  const cacheKey = JSON.stringify(coords[0]) + JSON.stringify(coords[coords.length - 1]) + coords.length;
  const cached = lineMetaCache.get(cacheKey);
  if (cached && cached.coords.length === coords.length) return cached;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
  }
  const meta = { coords, cum, total: cum[cum.length - 1] };
  if (lineMetaCache.size > 500) lineMetaCache.clear();
  lineMetaCache.set(cacheKey, meta);
  return meta;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pointAlongLine(line, dist) {
  const { coords, cum, total } = line;
  if (!total) return null;
  const d = Math.max(0, Math.min(dist, total));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const segLen = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / segLen;
  const [x1, y1] = coords[i - 1];
  const [x2, y2] = coords[i];
  const bearing = (Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI;
  return { lng: x1 + (x2 - x1) * t, lat: y1 + (y2 - y1) * t, bearing: (bearing + 360) % 360 };
}

function reverseDirectionName(direction) {
  if (direction.from && direction.to) return `${direction.to} → ${direction.from}`;
  return direction.name;
}

function hashCode(value) {
  let hash = 0;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ── Изменения движения ───────────────────────────────────────────────────────

const ALERT_TYPES = {
  delay: "Задержка",
  detour: "Временное изменение",
  roadwork: "Ремонт",
  closure: "Перекрытие",
  info: "Информация"
};

function listAlerts(options = {}) {
  const db = getDb();
  const rows = options.includeArchived
    ? db.prepare("SELECT * FROM map_alerts ORDER BY updated_at DESC LIMIT 200").all()
    : db.prepare("SELECT * FROM map_alerts WHERE status = 'active' ORDER BY updated_at DESC LIMIT 50").all();
  const routeById = new Map(listRoutes().map((route) => [route.id, route]));
  return rows.map((row) => ({
    id: row.alert_id,
    routeId: row.route_id,
    routeNumber: routeById.get(row.route_id)?.number || "",
    routeName: routeById.get(row.route_id)?.name || "",
    type: row.alert_type,
    typeLabel: ALERT_TYPES[row.alert_type] || row.alert_type,
    title: row.title,
    body: row.body,
    until: row.active_until_label,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notifiedAt: row.notified_at
  }));
}

function saveAlert(payload, options = {}) {
  const db = getDb();
  const routes = listRoutes();
  const route = routes.find((item) => item.id === String(payload.routeId || ""));
  if (!route) throw deps.httpError("Маршрут не найден.", 400);
  const type = ALERT_TYPES[payload.type] ? payload.type : "info";
  const title = String(payload.title || "").trim().slice(0, 160);
  const body = String(payload.body || "").trim().slice(0, 800);
  const until = String(payload.until || "").trim().slice(0, 80);
  if (!title) throw deps.httpError("Укажите заголовок изменения.", 400);

  const existing = payload.id ? db.prepare("SELECT * FROM map_alerts WHERE alert_id = ?").get(String(payload.id)) : null;
  const id = existing ? existing.alert_id : `al-${crypto.randomBytes(6).toString("hex")}`;
  const status = payload.status === "archived" ? "archived" : "active";

  if (existing) {
    db.prepare(`
      UPDATE map_alerts SET route_id = ?, alert_type = ?, title = ?, body = ?, active_until_label = ?,
        status = ?, updated_at = ? WHERE alert_id = ?
    `).run(route.id, type, title, body, until, status, nowIso(), id);
  } else {
    db.prepare(`
      INSERT INTO map_alerts (alert_id, route_id, alert_type, title, body, active_until_label, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, route.id, type, title, body, until, status, nowIso(), nowIso());
  }
  invalidateMapCaches();

  const alert = listAlerts({ includeArchived: true }).find((item) => item.id === id);
  if (status === "active" && options.notify !== false) {
    notifySubscribersAboutAlert(alert).catch((error) => {
      console.warn(`Map alert notification failed: ${error.message || error}`);
    });
  }
  return alert;
}

function deleteAlert(alertId) {
  getDb().prepare("DELETE FROM map_alerts WHERE alert_id = ?").run(String(alertId || ""));
  invalidateMapCaches();
}

// ── Подписки на изменения маршрутов ─────────────────────────────────────────

function listSubscriptionsForUser(telegramId) {
  return getDb()
    .prepare("SELECT route_id AS routeId FROM map_route_subscriptions WHERE telegram_id = ?")
    .all(String(telegramId))
    .map((row) => row.routeId);
}

function setSubscription(telegramId, routeId, enabled) {
  const db = getDb();
  const route = listRoutes().find((item) => item.id === String(routeId || ""));
  if (!route) throw deps.httpError("Маршрут не найден.", 400);
  if (enabled) {
    db.prepare(`
      INSERT INTO map_route_subscriptions (telegram_id, route_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT(telegram_id, route_id) DO NOTHING
    `).run(String(telegramId), route.id, nowIso());
  } else {
    db.prepare("DELETE FROM map_route_subscriptions WHERE telegram_id = ? AND route_id = ?").run(String(telegramId), route.id);
  }
  return listSubscriptionsForUser(telegramId);
}

function listSubscribersForRoute(routeId) {
  return getDb()
    .prepare("SELECT telegram_id AS telegramId FROM map_route_subscriptions WHERE route_id = ?")
    .all(String(routeId))
    .map((row) => row.telegramId);
}

// Рассылка изменения движения подписчикам маршрута через Telegram-бота.
// Дубликаты отсекаются по notified_at (обновление текста шлётся заново
// только если админ явно попросил повторное уведомление).
async function notifySubscribersAboutAlert(alert, options = {}) {
  if (!alert || !deps.sendTelegramMessage) return { sent: 0 };
  const db = getDb();
  const row = db.prepare("SELECT notified_at FROM map_alerts WHERE alert_id = ?").get(alert.id);
  if (row?.notified_at && !options.force) return { sent: 0, skipped: "already-notified" };

  const subscribers = listSubscribersForRoute(alert.routeId);
  const text = [
    `⚠️ Маршрут ${alert.routeNumber}: ${alert.typeLabel.toLowerCase()}`,
    "",
    alert.title,
    alert.body,
    alert.until ? `Срок: ${alert.until}` : ""
  ].filter(Boolean).join("\n");

  let sent = 0;
  for (const telegramId of subscribers) {
    try {
      await deps.sendTelegramMessage({
        chat_id: telegramId,
        text,
        reply_markup: {
          inline_keyboard: [[
            { text: "🗺 Открыть на карте", web_app: { url: deps.getPublicUrl(`/#map_route_${alert.routeId}`) } }
          ]]
        }
      });
      sent += 1;
    } catch (error) {
      console.warn(`Map alert to ${telegramId} failed: ${error.message || error}`);
    }
    // мягкий rate limit Telegram: не более ~20 сообщений в секунду
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  db.prepare("UPDATE map_alerts SET notified_at = ? WHERE alert_id = ?").run(nowIso(), alert.id);
  return { sent };
}

// ── Синхронизация избранного по Telegram ID ─────────────────────────────────

const FAVORITES_PAYLOAD_LIMIT = 64 * 1024;

function getFavoritesSync(telegramId) {
  const row = getDb()
    .prepare("SELECT payload, updated_at AS updatedAt FROM user_favorites_sync WHERE telegram_id = ?")
    .get(String(telegramId));
  if (!row) return { favorites: [], updatedAt: null };
  try {
    const parsed = JSON.parse(row.payload);
    return { favorites: Array.isArray(parsed) ? parsed : [], updatedAt: row.updatedAt };
  } catch {
    return { favorites: [], updatedAt: row.updatedAt };
  }
}

function saveFavoritesSync(telegramId, favorites) {
  if (!Array.isArray(favorites)) throw deps.httpError("Ожидается массив избранного.", 400);
  const payload = JSON.stringify(favorites.slice(0, 100));
  if (payload.length > FAVORITES_PAYLOAD_LIMIT) throw deps.httpError("Слишком большой список избранного.", 413);
  getDb().prepare(`
    INSERT INTO user_favorites_sync (telegram_id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(String(telegramId), payload, nowIso());
}

// ── Демо-геоданные ───────────────────────────────────────────────────────────
//
// Реальных координат в расписании нет. Демо-геометрия строится по уличной
// сети города (map-geo-network.js): городское кольцо — по улицам центра,
// пригородные маршруты — по общим магистральным коридорам своего направления
// с расхождением только у конечных. Линии идут «по дорогам» схемы, а не
// прямыми между остановками. Все записи помечаются source='demo' — их видно
// в админке и на карте (бейдж «Демо-данные»), и их можно удалить одной кнопкой.

function seedDemoGeo(options = {}) {
  const db = getDb();
  const routes = listRoutes().filter((route) => (options.type ? route.type === options.type : true));
  if (!routes.length) return { routes: 0, directions: 0, stops: 0 };

  let stopCount = 0;
  let directionCount = 0;

  for (const route of routes) {
    const geo = geoNetwork.buildDemoRouteGeo(route, normalizeStopKey);

    for (const [key, coord] of geo.stops) {
      const existing = db.prepare("SELECT source FROM map_stop_geo WHERE stop_key = ?").get(key);
      if (existing && existing.source !== "demo" && !options.overwrite) continue;
      const nameRow = db.prepare("SELECT name FROM stops WHERE normalized_name = ? LIMIT 1").get(key);
      db.prepare(`
        INSERT INTO map_stop_geo (stop_key, name, lat, lng, source, updated_at)
        VALUES (?, ?, ?, ?, 'demo', ?)
        ON CONFLICT(stop_key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng,
          source = 'demo', updated_at = excluded.updated_at
        WHERE map_stop_geo.source = 'demo'
      `).run(key, nameRow?.name || key, coord[1], coord[0], nowIso());
      if (!existing) stopCount += 1;
    }

    for (const [directionCode, coords] of geo.directions) {
      const existing = db
        .prepare("SELECT source FROM map_route_geometry WHERE route_id = ? AND direction_code = ?")
        .get(route.id, directionCode);
      if (existing && existing.source !== "demo" && !options.overwrite) continue;
      db.prepare(`
        INSERT INTO map_route_geometry (route_id, direction_code, geometry, source, updated_at)
        VALUES (?, ?, ?, 'demo', ?)
        ON CONFLICT(route_id, direction_code) DO UPDATE SET geometry = excluded.geometry,
          source = 'demo', updated_at = excluded.updated_at
      `).run(route.id, directionCode, JSON.stringify(coords), nowIso());
      directionCount += 1;
    }
  }

  invalidateMapCaches();
  return { routes: routes.length, directions: directionCount, stops: stopCount };
}

function clearDemoGeo() {
  const db = getDb();
  const stops = db.prepare("DELETE FROM map_stop_geo WHERE source = 'demo'").run();
  const geometry = db.prepare("DELETE FROM map_route_geometry WHERE source = 'demo'").run();
  invalidateMapCaches();
  return { stops: stops.changes, geometry: geometry.changes };
}

// ── MapDataProvider: внешние источники геоданных ────────────────────────────
//
// Контракт (переключение источников без переписывания интерфейса):
//
//   interface MapDataProvider {
//     name: string
//     available(): boolean
//     geocode?(query): Promise<GeocodeResult[]>            // адрес/остановка → координаты
//     getRouteGeometry?(points): Promise<[lng,lat][]>       // привязка линии к дорогам
//   }
//
// Яндекс API используется только в разрешённых сценариях: серверный
// HTTP-геокодер по ключу. Тайлы Яндекса в стороннем движке и iframe
// не используются (запрещено условиями сервиса). Привязка к дорогам —
// через OSRM (self-hosted или демо-сервер проекта OSRM для тестов).

const EXTERNAL_REQUEST_TIMEOUT_MS = 12000;

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "barbus-miniapp/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const yandexProvider = {
  name: "yandex-geocoder",
  available() {
    return Boolean(process.env.YANDEX_GEOCODER_API_KEY || process.env.YANDEX_MAPS_API_KEY);
  },
  // Геокодинг остановки/адреса в агломерации Барановичей
  async geocode(query) {
    const key = process.env.YANDEX_GEOCODER_API_KEY || process.env.YANDEX_MAPS_API_KEY;
    if (!key) throw new Error("Ключ Яндекс Геокодера не настроен (YANDEX_GEOCODER_API_KEY).");
    const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${encodeURIComponent(key)}&format=json&results=3&ll=26.014,53.132&spn=0.6,0.4&geocode=${encodeURIComponent(`Барановичи, ${query}`)}`;
    const data = await fetchJsonWithTimeout(url);
    const members = data?.response?.GeoObjectCollection?.featureMember || [];
    return members.map((member) => {
      const object = member.GeoObject || {};
      const [lng, lat] = String(object.Point?.pos || "").split(" ").map(Number);
      return {
        name: object.name || "",
        description: object.description || "",
        lat,
        lng,
        precision: object.metaDataProperty?.GeocoderMetaData?.precision || "",
      };
    }).filter((item) => isValidCoordinate(item.lat, item.lng));
  },
};

// Привязка к дорогам через Яндекс Router API (нужен тариф с роутингом).
const yandexRoutingProvider = {
  name: "yandex-routing",
  available() {
    return Boolean(process.env.YANDEX_ROUTING_API_KEY);
  },
  async getRouteGeometry(points) {
    const key = process.env.YANDEX_ROUTING_API_KEY;
    if (!key) throw new Error("Ключ Яндекс Роутинга не настроен (YANDEX_ROUTING_API_KEY).");
    if (!Array.isArray(points) || points.length < 2) throw new Error("Нужно минимум две точки.");
    const waypoints = points.slice(0, 50).map(([lng, lat]) => `${lat},${lng}`).join("|");
    const url = `https://api.routing.yandex.net/v2/route?apikey=${encodeURIComponent(key)}&waypoints=${encodeURIComponent(waypoints)}&mode=driving`;
    const data = await fetchJsonWithTimeout(url);
    // Формат ответа: route.legs[].steps[].polyline.points = [[lat,lng], ...]
    const legs = data?.route?.legs || [];
    const coords = [];
    for (const leg of legs) {
      for (const step of leg.steps || []) {
        for (const point of step.polyline?.points || []) {
          const [lat, lng] = point;
          if (Number.isFinite(lat) && Number.isFinite(lng)) coords.push([Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
        }
      }
    }
    if (coords.length < 2) throw new Error("Яндекс Роутинг вернул неожиданный формат ответа.");
    return coords;
  },
};

const osrmProvider = {
  name: "osrm",
  available() {
    return Boolean(process.env.OSRM_URL);
  },
  // Привязка последовательности точек (остановок) к дорожной сети
  async getRouteGeometry(points) {
    const base = String(process.env.OSRM_URL || "").replace(/\/$/, "");
    if (!base) throw new Error("Сервис привязки к дорогам не настроен (OSRM_URL).");
    if (!Array.isArray(points) || points.length < 2) throw new Error("Нужно минимум две точки.");
    const coords = points.slice(0, 80).map(([lng, lat]) => `${lng},${lat}`).join(";");
    const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=true`;
    const data = await fetchJsonWithTimeout(url);
    if (data.code !== "Ok" || !data.routes?.[0]?.geometry?.coordinates?.length) {
      throw new Error("Дорожная привязка не удалась: маршрут не построен.");
    }
    return data.routes[0].geometry.coordinates.map(([lng, lat]) => [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
  },
};

// ── Конфигурация карты: режимы и подложка «Схемы» ───────────────────────────

function externalTilesEnabled() {
  return String(process.env.MAP_EXTERNAL_TILES ?? "true").toLowerCase() !== "false";
}

const OSM_ATTRIBUTION = "© Участники OpenStreetMap";
const ESRI_ATTRIBUTION = "© Esri, Maxar, Earthstar Geographics";
const CARTO_ATTRIBUTION = "© OpenStreetMap, © CARTO";

const ESRI_DEFAULT_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

// Подложка «Схемы» по умолчанию: OpenFreeMap (данные OpenStreetMap) —
// реальные улицы, дома и подписи, бесплатно и без API-ключей.
// Клиент автоматически откатывается на встроенную схему, если стиль недоступен.
const OPENFREEMAP_ATTRIBUTION = "© Участники OpenStreetMap, OpenFreeMap";
const DEFAULT_SCHEME_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

function getMapConfig() {
  if (!MAP_ENV.mapFeaturesEnabled) {
    return { ok: true, enabled: false, message: "Карта временно отключена администратором." };
  }
  const tilesOn = externalTilesEnabled();

  // «Схема»: приоритет — внешний стиль (MAP_SCHEME_STYLE_URL/MAP_STYLE_URL),
  // затем растровые тайлы (MAP_TILE_URL), затем OpenFreeMap по умолчанию
  // (реальные улицы и дома; при MAP_EXTERNAL_TILES=false — встроенная подложка).
  const schemeStyleUrl = MAP_ENV.schemeStyleUrl || MAP_ENV.styleUrl || (tilesOn && !MAP_ENV.tileUrl ? DEFAULT_SCHEME_STYLE_URL : "");
  const scheme = schemeStyleUrl
    ? { title: "Схема", type: "style", styleUrl: schemeStyleUrl, attribution: OPENFREEMAP_ATTRIBUTION }
    : MAP_ENV.tileUrl
      ? { title: "Схема", type: "raster", enabled: true, tiles: [MAP_ENV.tileUrl], attribution: OSM_ATTRIBUTION }
      : { title: "Схема", type: "builtin" };

  const satelliteTiles = MAP_ENV.satelliteTileUrl || ESRI_DEFAULT_TILES;
  const hybrid = MAP_ENV.hybridStyleUrl
    ? { title: "Гибрид", type: "style", enabled: tilesOn, styleUrl: MAP_ENV.hybridStyleUrl }
    : {
        title: "Гибрид",
        type: "raster",
        enabled: tilesOn,
        tiles: [satelliteTiles],
        labels: ["https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png", "https://b.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png"],
        attribution: `${ESRI_ATTRIBUTION}; ${CARTO_ATTRIBUTION}`,
      };

  const gpsProvider = resolveGpsProvider();
  return {
    ok: true,
    enabled: true,
    engine: MAP_ENV.provider, // MAP_PROVIDER (сейчас поддерживается maplibre)
    center: { lat: CITY_CENTER.lat, lng: CITY_CENTER.lng, zoom: MAP_ENV.defaultZoom },
    modes: {
      scheme,
      satellite: {
        title: "Спутник",
        type: "raster",
        enabled: tilesOn,
        tiles: [satelliteTiles],
        attribution: MAP_ENV.satelliteTileUrl ? "" : ESRI_ATTRIBUTION,
      },
      hybrid,
    },
    basemap: geoNetwork.schemeBasemap(),
    gps: {
      pollSeconds: MAP_ENV.gpsPollSeconds,
      staleSeconds: MAP_ENV.gpsStaleSeconds,
      source: gpsProvider ? gpsProvider.name : null,
      demo: Boolean(gpsProvider?.isDemo),
      // ENABLE_MOCK_GPS задан явно → тумблер демо-транспорта в админке блокируется
      mockLocked: MAP_ENV.mockGpsEnv !== "",
    },
    demoDataEnabled: MAP_ENV.demoMapDataEnabled,
    providers: {
      yandexGeocoder: yandexProvider.available(),
      roadSnap: osrmProvider.available() || yandexRoutingProvider.available(),
      roadSnapSource: osrmProvider.available() ? "osrm" : yandexRoutingProvider.available() ? "yandex-routing" : null,
      gps: Boolean(gpsProvider),
    },
  };
}

// Origins внешних URL из env — для динамической сборки CSP в server.js
function getExternalOrigins() {
  const origins = new Set();
  const candidates = [
    MAP_ENV.tileUrl, MAP_ENV.styleUrl, MAP_ENV.schemeStyleUrl,
    MAP_ENV.satelliteTileUrl, MAP_ENV.hybridStyleUrl,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw.replace(/\{[a-z@]+\}/gi, "0")).origin);
    } catch { /* некорректный URL не попадает в CSP */ }
  }
  return [...origins];
}

function isMapEnabled() {
  return MAP_ENV.mapFeaturesEnabled;
}

// ── Health ───────────────────────────────────────────────────────────────────

async function getMapHealth() {
  const data = await getMapData();
  const provider = resolveGpsProvider();
  return {
    ok: true,
    enabled: MAP_ENV.mapFeaturesEnabled,
    coverage: data.coverage,
    demoGeo: data.demoGeo,
    cache: { redis: Boolean(redis), ttlSeconds: MAP_ENV.mapCacheTtlMs / 1000 },
    vehicles: {
      provider: provider ? provider.name : null,
      status: provider ? (provider.isDemo ? "demo" : "live") : "offline",
      pollSeconds: MAP_ENV.gpsPollSeconds
    },
    alerts: listAlerts().length
  };
}

// ── HTTP API ─────────────────────────────────────────────────────────────────

// Публичные и пользовательские эндпоинты. Возвращает true, если запрос обработан.
async function handlePublicApi(req, res, url) {
  const { pathname } = url;
  const { sendJson, parseBody, getTelegramUser, requireVerifiedTelegramUser, enforceRateLimit, RATE_LIMITS } = deps;

  if (req.method === "GET" && pathname === "/api/map/config") {
    return sendJson(res, 200, getMapConfig()), true;
  }

  // ENABLE_MAP_FEATURES=false: карта отключена целиком (кроме config,
  // из которого клиент узнаёт причину)
  if (!MAP_ENV.mapFeaturesEnabled && pathname.startsWith("/api/map/")) {
    return sendJson(res, 503, { ok: false, error: "Карта временно отключена." }), true;
  }

  if (req.method === "GET" && pathname === "/api/map/data") {
    return sendJson(res, 200, await getMapData()), true;
  }

  if (req.method === "GET" && pathname === "/api/map/vehicles") {
    const routesParam = String(url.searchParams.get("routes") || "").trim();
    const filter = routesParam ? new Set(routesParam.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 50)) : null;
    return sendJson(res, 200, await getVehicles(filter)), true;
  }

  if (req.method === "GET" && pathname === "/api/map/alerts") {
    return sendJson(res, 200, { ok: true, alerts: listAlerts() }), true;
  }

  if (req.method === "GET" && pathname === "/api/map/health") {
    return sendJson(res, 200, await getMapHealth()), true;
  }

  if (pathname === "/api/map/subscriptions") {
    const user = getTelegramUser(req);
    requireVerifiedTelegramUser(user, "Подписки доступны только в Telegram Mini App.");
    // REQUIRE_TELEGRAM_AUTH=false (локальная разработка) пропускает проверку выше,
    // но без Telegram ID подписки всё равно невозможны.
    if (!user?.telegramId) throw deps.httpError("Подписки доступны только в Telegram Mini App.", 401);
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, routeIds: listSubscriptionsForUser(user.telegramId) }), true;
    }
    if (req.method === "POST") {
      enforceRateLimit(req, user, "map-subscription", RATE_LIMITS.reminderCreate || { limit: 30, windowMs: 60 * 1000 });
      const body = await parseBody(req);
      const routeIds = setSubscription(user.telegramId, body.routeId, body.enabled !== false);
      return sendJson(res, 200, { ok: true, routeIds }), true;
    }
  }

  if (pathname === "/api/user/favorites") {
    const user = getTelegramUser(req);
    requireVerifiedTelegramUser(user, "Синхронизация избранного доступна только в Telegram Mini App.");
    if (!user?.telegramId) throw deps.httpError("Синхронизация избранного доступна только в Telegram Mini App.", 401);
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, ...getFavoritesSync(user.telegramId) }), true;
    }
    if (req.method === "POST") {
      enforceRateLimit(req, user, "favorites-sync", { limit: 30, windowMs: 60 * 1000 });
      const body = await parseBody(req);
      saveFavoritesSync(user.telegramId, body.favorites);
      return sendJson(res, 200, { ok: true }), true;
    }
  }

  return false;
}

// Админ-эндпоинты. Право «schedule» — им обладает только роль admin.
async function handleAdminApi(req, res, url) {
  const { pathname } = url;
  if (!pathname.startsWith("/api/admin/map/")) return false;
  const { sendJson, parseBody, requireAdmin } = deps;
  requireAdmin(req, url, "schedule");

  if (req.method === "GET" && pathname === "/api/admin/map/overview") {
    const data = await getMapData();
    return sendJson(res, 200, {
      ok: true,
      coverage: data.coverage,
      demoGeo: data.demoGeo,
      demoVehicles: demoVehiclesEnabled(),
      alerts: listAlerts({ includeArchived: true })
    }), true;
  }

  if (req.method === "GET" && pathname === "/api/admin/map/stops") {
    return sendJson(res, 200, { ok: true, stops: listPhysicalStops() }), true;
  }

  if (req.method === "POST" && pathname === "/api/admin/map/stops") {
    const body = await parseBody(req);
    if (body.remove) {
      removeStopGeo(body.key);
    } else {
      setStopGeo(body.key, Number(body.lat), Number(body.lng), "admin");
    }
    return sendJson(res, 200, { ok: true }), true;
  }

  if (req.method === "GET" && pathname === "/api/admin/map/routes") {
    const db = getDb();
    const geometryRows = db
      .prepare("SELECT route_id AS routeId, direction_code AS directionCode, source FROM map_route_geometry")
      .all();
    const geometryByKey = new Map(geometryRows.map((row) => [`${row.routeId}:${row.directionCode}`, row.source]));
    const routes = listRoutes().map((route) => ({
      id: route.id,
      number: route.number,
      name: route.name,
      type: route.type,
      directions: (route.directions || []).map((direction) => ({
        code: direction.code,
        name: direction.name,
        stops: (direction.stops || []).length,
        stopKeys: (direction.stops || []).map((stop) => normalizeStopKey(stop.name)),
        geometrySource: geometryByKey.get(`${route.id}:${direction.code}`) || ""
      }))
    }));
    return sendJson(res, 200, { ok: true, routes }), true;
  }

  if (req.method === "GET" && pathname === "/api/admin/map/route-geometry") {
    const routeId = url.searchParams.get("routeId") || "";
    const directionCode = url.searchParams.get("directionCode") || "";
    const row = getDb()
      .prepare("SELECT geometry, source, updated_at AS updatedAt FROM map_route_geometry WHERE route_id = ? AND direction_code = ?")
      .get(routeId, directionCode);
    return sendJson(res, 200, {
      ok: true,
      geometry: row ? JSON.parse(row.geometry) : [],
      source: row?.source || "",
      updatedAt: row?.updatedAt || null
    }), true;
  }

  if (req.method === "POST" && pathname === "/api/admin/map/route-geometry") {
    const body = await parseBody(req);
    const routeId = String(body.routeId || "");
    const directionCode = String(body.directionCode || "");
    if (!routeId || !directionCode) throw deps.httpError("Укажите маршрут и направление.", 400);
    if (body.remove) {
      removeRouteGeometry(routeId, directionCode);
    } else {
      setRouteGeometry(routeId, directionCode, body.geometry, "admin");
    }
    return sendJson(res, 200, { ok: true }), true;
  }

  if (req.method === "POST" && pathname === "/api/admin/map/alerts") {
    const body = await parseBody(req);
    if (body.delete && body.id) {
      deleteAlert(body.id);
      return sendJson(res, 200, { ok: true }), true;
    }
    const alert = saveAlert(body, { notify: body.notify !== false });
    if (body.renotify) await notifySubscribersAboutAlert(alert, { force: true });
    return sendJson(res, 200, { ok: true, alert }), true;
  }

  if (req.method === "POST" && pathname === "/api/admin/map/settings") {
    const body = await parseBody(req);
    if (body.demoVehicles !== undefined) {
      setMapSetting("demo_vehicles", body.demoVehicles ? "1" : "0");
      invalidateMapCaches();
    }
    return sendJson(res, 200, { ok: true, demoVehicles: demoVehiclesEnabled() }), true;
  }

  // Геокодинг остановок через Яндекс (нужен YANDEX_GEOCODER_API_KEY).
  // dry-run по умолчанию: показывает кандидатов, apply=true — сохраняет.
  if (req.method === "POST" && pathname === "/api/admin/map/geocode-stops") {
    if (!yandexProvider.available()) {
      throw deps.httpError("Ключ Яндекс Геокодера не настроен. Добавьте YANDEX_GEOCODER_API_KEY в .env (использование — по условиям Яндекс API).", 400);
    }
    const body = await parseBody(req);
    const limit = Math.min(25, Math.max(1, Number(body.limit) || 10));
    const onlyMissing = body.onlyMissing !== false;
    const stops = listPhysicalStops()
      .filter((stop) => (onlyMissing ? !Number.isFinite(stop.lat) || stop.geoSource === "demo" : true))
      .slice(0, limit);
    const results = [];
    for (const stop of stops) {
      try {
        const candidates = await yandexProvider.geocode(`остановка ${stop.name}`);
        const best = candidates[0] || null;
        if (best && body.apply === true) setStopGeo(stop.key, best.lat, best.lng, "yandex");
        results.push({ key: stop.key, name: stop.name, found: Boolean(best), candidate: best, applied: Boolean(best && body.apply === true) });
      } catch (error) {
        results.push({ key: stop.key, name: stop.name, found: false, error: error.message });
      }
      await new Promise((resolve) => setTimeout(resolve, 250)); // мягкий rate limit
    }
    return sendJson(res, 200, { ok: true, applied: body.apply === true, results }), true;
  }

  // Привязка линии направления к дорогам: OSRM (OSRM_URL) или
  // Яндекс Роутинг (YANDEX_ROUTING_API_KEY); OSRM в приоритете.
  if (req.method === "POST" && pathname === "/api/admin/map/snap-route") {
    const snapProvider = osrmProvider.available() ? osrmProvider : yandexRoutingProvider.available() ? yandexRoutingProvider : null;
    if (!snapProvider) {
      throw deps.httpError("Сервис привязки к дорогам не настроен. Укажите OSRM_URL или YANDEX_ROUTING_API_KEY в .env.", 400);
    }
    const body = await parseBody(req);
    const routeId = String(body.routeId || "");
    const directionCode = String(body.directionCode || "");
    const route = listRoutes().find((item) => item.id === routeId);
    const direction = route?.directions?.find((item) => item.code === directionCode);
    if (!route || !direction) throw deps.httpError("Маршрут или направление не найдены.", 400);
    const db = getDb();
    const points = [];
    for (const stop of direction.stops || []) {
      const geo = db.prepare("SELECT lat, lng FROM map_stop_geo WHERE stop_key = ?").get(normalizeStopKey(stop.name));
      if (geo) points.push([geo.lng, geo.lat]);
    }
    if (points.length < 2) throw deps.httpError("У направления меньше двух остановок с координатами — сначала задайте координаты остановок.", 400);
    const geometry = await snapProvider.getRouteGeometry(points);
    if (body.apply === true) setRouteGeometry(routeId, directionCode, geometry, snapProvider.name);
    return sendJson(res, 200, { ok: true, applied: body.apply === true, points: geometry.length, geometry }), true;
  }

  if (req.method === "POST" && pathname === "/api/admin/map/demo-seed") {
    if (!MAP_ENV.demoMapDataEnabled) {
      throw deps.httpError("Демо-геоданные отключены (ENABLE_DEMO_MAP_DATA=false).", 400);
    }
    const body = await parseBody(req);
    if (body.clear) {
      return sendJson(res, 200, { ok: true, cleared: clearDemoGeo() }), true;
    }
    const result = seedDemoGeo({ type: body.type || "", overwrite: body.overwrite === true });
    return sendJson(res, 200, { ok: true, seeded: result }), true;
  }

  return false;
}

module.exports = {
  init,
  handlePublicApi,
  handleAdminApi,
  registerGpsProvider,
  seedDemoGeo,
  clearDemoGeo,
  getMapData,
  getMapConfig,
  getMapHealth,
  getExternalOrigins,
  isMapEnabled,
  listAlerts,
  saveAlert,
  notifySubscribersAboutAlert,
  listSubscriptionsForUser,
  setSubscription
};
