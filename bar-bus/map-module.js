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

// Центр Барановичей — отправная точка схематичной раскладки демо-геоданных.
const CITY_CENTER = { lat: 53.1327, lng: 26.0139 };
const CITY_BOUNDS = { minLat: 52.95, maxLat: 53.32, minLng: 25.75, maxLng: 26.30 };

const MAP_DATA_CACHE_TTL_MS = 60 * 1000;
const VEHICLES_MIN_INTERVAL_MS = 2000; // сервер не пересчитывает демо-транспорт чаще
const DEMO_VEHICLES_PER_DIRECTION = 1;

let deps = null;
let tablesReady = false;
let mapDataCache = { data: null, expiresAt: 0 };
let vehiclesCache = { data: null, expiresAt: 0 };

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
  mapDataCache = { data: null, expiresAt: 0 };
  vehiclesCache = { data: null, expiresAt: 0 };
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
  const envForced = String(process.env.MAP_DEMO_VEHICLES || "").toLowerCase();
  if (["1", "true", "yes"].includes(envForced)) return true;
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
  const geometryRows = db
    .prepare("SELECT route_id AS routeId, direction_code AS directionCode, geometry, source FROM map_route_geometry")
    .all();
  const geometryByKey = new Map(geometryRows.map((row) => [`${row.routeId}:${row.directionCode}`, row]));

  const stopGeoRows = db.prepare("SELECT stop_key AS key, name, lat, lng, source FROM map_stop_geo").all();
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

function getMapData() {
  const now = Date.now();
  if (mapDataCache.data && mapDataCache.expiresAt > now) return mapDataCache.data;
  const data = buildMapData();
  mapDataCache = { data, expiresAt: now + MAP_DATA_CACHE_TTL_MS };
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
    const data = getMapData();
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
    const errors = [];
    if (!isValidCoordinate(position.lat, position.lng)) errors.push("Позиция вне зоны обслуживания");
    if (!position.routeId) errors.push("Не указан маршрут");
    return { ok: errors.length === 0, errors };
  }
};

let activeGpsProvider = null;

function resolveGpsProvider() {
  if (activeGpsProvider) return activeGpsProvider;
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
  const now = Date.now();
  let base = vehiclesCache.data && vehiclesCache.expiresAt > now ? vehiclesCache.data : null;

  if (!base) {
    const provider = resolveGpsProvider();
    if (!provider) {
      base = { ok: true, status: "offline", provider: null, vehicles: [], generatedAt: nowIso() };
    } else {
      let vehicles = [];
      let status = provider.isDemo ? "demo" : "live";
      try {
        const raw = await provider.fetchVehiclePositions();
        for (const item of raw) {
          const position = provider.normalizePosition(item);
          if (!position) continue;
          const check = provider.validatePosition(position);
          if (check.ok) vehicles.push(position);
        }
      } catch (error) {
        console.warn(`Map GPS provider "${provider.name}" failed: ${error.message || error}`);
        status = "error";
        vehicles = [];
      }
      base = { ok: true, status, provider: provider.name, vehicles, generatedAt: nowIso() };
    }
    vehiclesCache = { data: base, expiresAt: now + VEHICLES_MIN_INTERVAL_MS };
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
// Реальных координат в расписании нет. Для демонстрации карта раскладывает
// маршруты схематично: каждый маршрут получает свой «луч» из центра города,
// остановки размещаются вдоль него, общие остановки переиспользуют координаты.
// Все записи помечаются source='demo' — их видно в админке и на карте
// (бейдж «Схема (демо-геоданные)»), и их можно удалить одной кнопкой.

function seedDemoGeo(options = {}) {
  const db = getDb();
  const routes = listRoutes().filter((route) => (options.type ? route.type === options.type : true));
  if (!routes.length) return { routes: 0, stops: 0 };

  let stopCount = 0;
  let directionCount = 0;

  const insertGeoTx = () => {
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      // «Луч» маршрута: угол определяется номером маршрута — стабильно между запусками.
      const angle = ((hashCode(route.number) % 360) * Math.PI) / 180;

      for (const direction of route.directions || []) {
        const existing = db
          .prepare("SELECT source FROM map_route_geometry WHERE route_id = ? AND direction_code = ?")
          .get(route.id, direction.code);
        if (existing && existing.source !== "demo" && !options.overwrite) continue;

        const stops = direction.stops || [];
        if (stops.length < 2) continue;

        const points = [];
        for (let index = 0; index < stops.length; index++) {
          const stop = stops[index];
          const key = normalizeStopKey(stop.name);
          let geo = db.prepare("SELECT lat, lng FROM map_stop_geo WHERE stop_key = ?").get(key);
          if (!geo) {
            // Расстояние от центра растёт с позицией; лёгкая «змейка» поперёк луча,
            // чтобы линии не были идеально прямыми.
            const distanceKm = 0.4 + (index / Math.max(1, stops.length - 1)) * (2.2 + (hashCode(route.number) % 5) * 0.35);
            const wobble = Math.sin(index * 1.7 + routeIndex) * 0.13;
            const lat = CITY_CENTER.lat + (distanceKm / 111) * Math.cos(angle + wobble);
            const lng = CITY_CENTER.lng + (distanceKm / (111 * Math.cos((CITY_CENTER.lat * Math.PI) / 180))) * Math.sin(angle + wobble);
            db.prepare(`
              INSERT INTO map_stop_geo (stop_key, name, lat, lng, source, updated_at)
              VALUES (?, ?, ?, ?, 'demo', ?)
              ON CONFLICT(stop_key) DO NOTHING
            `).run(key, stop.name, Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, nowIso());
            geo = db.prepare("SELECT lat, lng FROM map_stop_geo WHERE stop_key = ?").get(key);
            stopCount += 1;
          }
          if (geo) points.push([geo.lng, geo.lat]);
        }

        if (points.length >= 2) {
          db.prepare(`
            INSERT INTO map_route_geometry (route_id, direction_code, geometry, source, updated_at)
            VALUES (?, ?, ?, 'demo', ?)
            ON CONFLICT(route_id, direction_code) DO UPDATE SET geometry = excluded.geometry,
              source = 'demo', updated_at = excluded.updated_at
          `).run(route.id, direction.code, JSON.stringify(points), nowIso());
          directionCount += 1;
        }
      }
    }
  };

  insertGeoTx();
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

// ── Health ───────────────────────────────────────────────────────────────────

function getMapHealth() {
  const data = getMapData();
  const provider = resolveGpsProvider();
  return {
    ok: true,
    coverage: data.coverage,
    demoGeo: data.demoGeo,
    vehicles: {
      provider: provider ? provider.name : null,
      status: provider ? (provider.isDemo ? "demo" : "live") : "offline"
    },
    alerts: listAlerts().length
  };
}

// ── HTTP API ─────────────────────────────────────────────────────────────────

// Публичные и пользовательские эндпоинты. Возвращает true, если запрос обработан.
async function handlePublicApi(req, res, url) {
  const { pathname } = url;
  const { sendJson, parseBody, getTelegramUser, requireVerifiedTelegramUser, enforceRateLimit, RATE_LIMITS } = deps;

  if (req.method === "GET" && pathname === "/api/map/data") {
    return sendJson(res, 200, getMapData()), true;
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
    return sendJson(res, 200, getMapHealth()), true;
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
    const data = getMapData();
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

  if (req.method === "POST" && pathname === "/api/admin/map/demo-seed") {
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
  getMapHealth,
  listAlerts,
  saveAlert,
  notifySubscribersAboutAlert,
  listSubscriptionsForUser,
  setSubscription
};
