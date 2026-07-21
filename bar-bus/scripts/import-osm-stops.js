"use strict";

// Импорт реальных координат остановок из OpenStreetMap (Overpass API).
//
// Бесплатный способ получить настоящие координаты без API-ключей:
//  1) остановки внутри Барановичей (highway=bus_stop / public_transport=platform);
//  2) сёла и деревни района (place=village/hamlet) — названия пригородных
//     остановок в расписании чаще всего совпадают с названием населённого пункта.
//
// Сопоставление — по нормализованному названию (как в расписании). Найденные
// координаты пишутся в map_stop_geo с source='osm' и замещают демо-точки,
// но НЕ трогают координаты, выставленные администратором вручную.
//
// Использование:
//   node --no-warnings scripts/import-osm-stops.js --dry-run   # только отчёт
//   node --no-warnings scripts/import-osm-stops.js             # импорт
//   node --no-warnings scripts/import-osm-stops.js --from-file data.json
//     (data.json — заранее скачанный ответ Overpass, для офлайн-импорта)
//
// Данные OpenStreetMap распространяются по лицензии ODbL —
// «© Участники OpenStreetMap» уже присутствует в атрибуции карты.

const fs = require("node:fs");
const path = require("node:path");
process.chdir(path.join(__dirname, ".."));

const { getDb } = require("../db.js");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

// город: остановки; район (шире): населённые пункты
const CITY_BBOX = "53.06,25.85,53.21,26.16";
const RAION_BBOX = "52.55,25.20,53.65,26.95";

const OVERPASS_QUERY = `
[out:json][timeout:90];
(
  node["highway"="bus_stop"](${CITY_BBOX});
  node["public_transport"="platform"]["bus"="yes"](${CITY_BBOX});
  node["place"~"^(town|village|hamlet)$"](${RAION_BBOX});
);
out body center qt;
`;

function normalizeKey(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Варианты ключей для сопоставления: «мкр-н северный» ↔ «северный»,
// «аг. столовичи» ↔ «столовичи» и т.п.
function keyVariants(name) {
  const base = normalizeKey(name);
  const variants = new Set([base]);
  const stripped = base
    .replace(/^(аг\.|агрогородок|д\.|дер\.|деревня|п\.|пос\.|посёлок|поселок|г\.|гп\.|мкр-н|мкрн|микрорайон|ул\.|улица|ост\.|остановка)\s+/g, "")
    .trim();
  if (stripped) variants.add(stripped);
  return [...variants];
}

async function fetchOverpass() {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`Запрос Overpass: ${endpoint} …`);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(OVERPASS_QUERY)}`
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.warn(`  не удалось (${error.message || error}), пробуем следующий…`);
    }
  }
  throw new Error(
    "Overpass API недоступен. Скачайте ответ вручную (overpass-turbo.eu, запрос из этого файла) " +
    "и запустите с --from-file путь/к/файлу.json"
  );
}

function collectCandidates(overpassJson) {
  // name → массив точек; несколько одноимённых → усредняем (одна платформа
  // на каждой стороне дороги и т.п.)
  const byKey = new Map();
  for (const element of overpassJson.elements || []) {
    const name = element.tags?.name;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const isPlace = Boolean(element.tags.place);
    for (const key of keyVariants(name)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ lat, lon, isPlace, name });
    }
  }
  const resolved = new Map();
  for (const [key, points] of byKey) {
    // остановки приоритетнее населённых пунктов при совпадении имени
    const stopsOnly = points.filter((p) => !p.isPlace);
    const pool = stopsOnly.length ? stopsOnly : points;
    const lat = pool.reduce((sum, p) => sum + p.lat, 0) / pool.length;
    const lon = pool.reduce((sum, p) => sum + p.lon, 0) / pool.length;
    resolved.set(key, { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lon * 1e6) / 1e6, samples: pool.length });
  }
  return resolved;
}

function run(candidates, { dryRun }) {
  const db = getDb();
  const stops = db
    .prepare(`
      SELECT s.normalized_name AS key, MIN(s.name) AS name, g.source AS geoSource
      FROM stops s LEFT JOIN map_stop_geo g ON g.stop_key = s.normalized_name
      GROUP BY s.normalized_name
    `)
    .all();

  let matched = 0;
  let skippedAdmin = 0;
  const unmatched = [];

  const upsert = db.prepare(`
    INSERT INTO map_stop_geo (stop_key, name, lat, lng, source, updated_at)
    VALUES (?, ?, ?, ?, 'osm', ?)
    ON CONFLICT(stop_key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng,
      source = 'osm', updated_at = excluded.updated_at
    -- админские координаты не трогаем (проверка ниже, до вызова)
  `);

  for (const stop of stops) {
    if (stop.geoSource === "admin") { skippedAdmin += 1; continue; }
    let hit = null;
    for (const key of keyVariants(stop.name)) {
      if (candidates.has(key)) { hit = candidates.get(key); break; }
    }
    if (!hit) { unmatched.push(stop.name); continue; }
    matched += 1;
    if (!dryRun) upsert.run(stop.key, stop.name, hit.lat, hit.lng, new Date().toISOString());
  }

  console.log("");
  console.log(`Остановок в расписании: ${stops.length}`);
  console.log(`Сопоставлено с OSM:     ${matched}${dryRun ? " (dry-run, ничего не записано)" : ""}`);
  console.log(`Пропущено (админ):      ${skippedAdmin}`);
  console.log(`Не найдено в OSM:       ${unmatched.length}`);
  if (unmatched.length) {
    console.log("");
    console.log("Первые ненайденные (задайте вручную в админке или Яндекс-геокодером):");
    for (const name of unmatched.slice(0, 25)) console.log(`  · ${name}`);
    if (unmatched.length > 25) console.log(`  … и ещё ${unmatched.length - 25}`);
  }
  if (!dryRun && matched) {
    console.log("");
    console.log("Готово. Теперь в админке: «Привязать к дорогам» (OSRM) для линий маршрутов,");
    console.log("затем «Удалить демо-геоданные», чтобы убрать оставшиеся схематичные точки.");
  }
}

(async () => {
  const dryRun = process.argv.includes("--dry-run");
  const fileArgIndex = process.argv.indexOf("--from-file");
  let overpassJson;
  if (fileArgIndex !== -1) {
    const filePath = process.argv[fileArgIndex + 1];
    if (!filePath) throw new Error("Укажите файл: --from-file путь/к/файлу.json");
    overpassJson = JSON.parse(fs.readFileSync(filePath, "utf8"));
    console.log(`Читаем локальный файл: ${filePath}`);
  } else {
    overpassJson = await fetchOverpass();
  }
  const candidates = collectCandidates(overpassJson);
  console.log(`Кандидатов из OSM (уникальных названий): ${candidates.size}`);
  run(candidates, { dryRun });
})().catch((error) => {
  console.error(`Ошибка: ${error.message || error}`);
  process.exit(1);
});
