"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Уличная сеть города Барановичи для карты Mini App.
//
// Два назначения:
//  1) Векторная подложка режима «Схема» (улицы, шоссе, ж/д, районы) —
//     самодостаточная, работает без внешних тайлов.
//  2) Демонстрационная геометрия маршрутов: линии идут по этим «улицам»
//     (общие магистральные коридоры, расхождение только у конечных),
//     а не хаотичными лучами. Данные ДЕМО: топология правдоподобна,
//     но не является точной геодезией — пользователь видит бейдж
//     «Демо-данные», реальная геометрия загружается через провайдеры
//     (Яндекс-геокодинг, OSRM road-snap) или админ-редактор.
// ─────────────────────────────────────────────────────────────────────────────

const CITY_CENTER = [26.014, 53.132];

// ── Городские улицы (для подложки «Схемы») ──────────────────────────────────
// class: 'major' — магистраль, 'street' — улица, 'rail' — железная дорога
const CITY_STREETS = [
  { name: "Ул. Ленина", class: "major", coords: [[26.000, 53.140], [26.008, 53.136], [26.017, 53.132], [26.026, 53.128], [26.034, 53.124]] },
  { name: "Ул. Советская", class: "major", coords: [[26.000, 53.124], [26.008, 53.128], [26.017, 53.132], [26.025, 53.136], [26.033, 53.140]] },
  { name: "Пр. Советский", class: "major", coords: [[26.008, 53.136], [26.003, 53.146], [25.999, 53.156], [25.996, 53.166]] },
  { name: "Ул. Тельмана", class: "street", coords: [[26.026, 53.128], [26.040, 53.135], [26.052, 53.142]] },
  { name: "Ул. Красноармейская", class: "street", coords: [[26.040, 53.135], [26.033, 53.140], [26.025, 53.136]] },
  { name: "Ул. Комсомольская", class: "street", coords: [[26.012, 53.138], [26.021, 53.134], [26.030, 53.130]] },
  { name: "Ул. Фроленкова", class: "street", coords: [[26.017, 53.124], [26.017, 53.132]] },
  { name: "Ул. Брестская", class: "major", coords: [[26.008, 53.128], [25.995, 53.121], [25.975, 53.112], [25.950, 53.100]] },
  { name: "Слонимское шоссе", class: "major", coords: [[26.000, 53.132], [25.985, 53.135], [25.965, 53.139], [25.940, 53.144]] },
  { name: "Минское шоссе", class: "major", coords: [[26.033, 53.140], [26.050, 53.150], [26.072, 53.162], [26.095, 53.175]] },
  { name: "Ляховичское направление", class: "major", coords: [[26.034, 53.124], [26.052, 53.120], [26.075, 53.114], [26.100, 53.108]] },
  { name: "Южное направление", class: "major", coords: [[26.017, 53.124], [26.020, 53.110], [26.024, 53.094], [26.028, 53.075]] },
  { name: "Направление Боровки", class: "street", coords: [[26.026, 53.124], [26.038, 53.116], [26.052, 53.108]] },
  { name: "Ул. Багрима", class: "street", coords: [[25.995, 53.121], [25.999, 53.130], [26.000, 53.140]] },
];

const RAILWAYS = [
  // Главный ход Брест — Минск через станцию Барановичи
  { coords: [[25.930, 53.104], [25.975, 53.116], [26.010, 53.126], [26.030, 53.133], [26.062, 53.148], [26.100, 53.166]] },
  // Ветка на юг (Лунинецкое направление)
  { coords: [[26.012, 53.1265], [26.008, 53.112], [26.004, 53.092]] },
];

const DISTRICTS = [
  { name: "Центр", coord: [26.016, 53.133] },
  { name: "Северный", coord: [25.995, 53.168] },
  { name: "Боровки", coord: [26.054, 53.106] },
  { name: "Текстильный", coord: [25.972, 53.110] },
  { name: "Восточный", coord: [26.056, 53.144] },
  { name: "Южный", coord: [26.022, 53.092] },
];

const LANDMARKS = [
  { name: "Автовокзал", coord: [26.0135, 53.1262] },
  { name: "Вокзал", coord: [26.0185, 53.1285] },
];

// ── Магистральные коридоры пригородных направлений ──────────────────────────
// Каждый начинается у автовокзала и уходит за город по «своему» шоссе.
// Пригородные маршруты одного направления идут по общему коридору
// (визуально — одна линия) и расходятся только на последнем участке.
const AV = [26.0135, 53.1262]; // Автовокзал — общая начальная точка

const CORRIDORS = [
  {
    id: "brest", title: "Брестское направление",
    match: ["полонка", "мышь", "столович", "гирмантовц", "тешевл", "медведич", "арабовщин"],
    coords: [AV, [26.008, 53.128], [25.995, 53.121], [25.975, 53.112], [25.950, 53.100], [25.915, 53.086], [25.872, 53.070], [25.828, 53.052]],
  },
  {
    id: "slonim", title: "Слонимское направление",
    match: ["слоним", "молчадь", "дворец", "вольно", "городищ", "новосёлк", "новоселк"],
    coords: [AV, [26.008, 53.128], [26.000, 53.132], [25.985, 53.135], [25.965, 53.139], [25.940, 53.144], [25.898, 53.152], [25.850, 53.161]],
  },
  {
    id: "north", title: "Северное направление",
    match: ["новогруд", "дятлов", "почапово", "щара", "вензовец", "ятвез"],
    coords: [AV, [26.008, 53.128], [26.008, 53.136], [26.003, 53.146], [25.999, 53.156], [25.996, 53.166], [25.993, 53.186], [25.990, 53.210]],
  },
  {
    id: "minsk", title: "Минское направление",
    match: ["минск", "столбц", "мир", "городе", "жуховичи", "турец", "кореличи"],
    coords: [AV, [26.017, 53.132], [26.025, 53.136], [26.033, 53.140], [26.050, 53.150], [26.072, 53.162], [26.095, 53.175], [26.128, 53.192]],
  },
  {
    id: "lyakhovichi", title: "Ляховичское направление",
    match: ["ляхович", "русинович", "медведичи", "кривошин", "липск", "святица"],
    coords: [AV, [26.017, 53.132], [26.026, 53.128], [26.034, 53.124], [26.052, 53.120], [26.075, 53.114], [26.100, 53.108], [26.132, 53.098]],
  },
  {
    id: "south", title: "Южное направление",
    match: ["ганцевич", "лунинец", "малаховц", "утёс", "утес", "лотвич", "мицкевич"],
    coords: [AV, [26.017, 53.124], [26.020, 53.110], [26.024, 53.094], [26.028, 53.075], [26.033, 53.052], [26.038, 53.028]],
  },
];

// Кольцо городского маршрута №17: Северный → центр → Красноармейская → Северный
const CITY_RING = [
  [25.996, 53.166], [25.999, 53.156], [26.003, 53.146], [26.008, 53.136],
  [26.017, 53.132], [26.026, 53.128], [26.034, 53.124], [26.040, 53.135],
  [26.033, 53.140], [26.025, 53.136], [26.012, 53.138], [26.008, 53.136],
  [26.003, 53.146], [25.999, 53.156], [25.996, 53.166],
];

// ── Геометрия: утилиты ──────────────────────────────────────────────────────

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1], coords[i]);
  return total;
}

// Обрезает линию до заданной длины (м), сохраняя изломы
function truncateLine(coords, maxMeters) {
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversineMeters(coords[i - 1], coords[i]);
    if (acc + seg >= maxMeters) {
      const t = (maxMeters - acc) / seg;
      out.push([
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ]);
      return out;
    }
    acc += seg;
    out.push(coords[i]);
  }
  return out;
}

// Точка на линии на расстоянии d от начала
function pointAt(coords, d) {
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversineMeters(coords[i - 1], coords[i]);
    if (acc + seg >= d) {
      const t = (d - acc) / seg;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ];
    }
    acc += seg;
  }
  return coords[coords.length - 1];
}

function hashCode(value) {
  let hash = 0;
  const text = String(value);
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// ── Демонстрационная геометрия маршрута ─────────────────────────────────────

function corridorForRoute(route) {
  const name = String(route.name || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  for (const corridor of CORRIDORS) {
    if (corridor.match.some((word) => name.includes(word))) return corridor;
  }
  return CORRIDORS[hashCode(route.number) % CORRIDORS.length];
}

// Путь пригородного маршрута: общий коридор + индивидуальный «хвост»
// к конечной (веер расходится только за городом, как в реальной сети).
function buildSuburbanPath(route, stopsCount) {
  const corridor = corridorForRoute(route);
  const corridorCoords = corridor.coords;
  const corridorLen = lineLength(corridorCoords);
  const seed = hashCode(`${route.number}:${route.name}`);

  // Длина пути растёт с числом остановок, но не выходит за коридор
  const targetLen = Math.min(corridorLen, Math.max(5000, 4000 + stopsCount * 900 + (seed % 5000)));
  const tailLen = 900 + (seed % 900); // индивидуальный съезд к деревне
  const trunk = truncateLine(corridorCoords, Math.max(3000, targetLen - tailLen));

  // Хвост: отклонение ±35° от направления коридора
  const last = trunk[trunk.length - 1];
  const prev = trunk[trunk.length - 2] || trunk[0];
  const bearing = Math.atan2(last[0] - prev[0], last[1] - prev[1]);
  const dev = (((seed >> 3) % 70) - 35) * (Math.PI / 180);
  const angle = bearing + dev;
  const dLat = (tailLen / 111000) * Math.cos(angle);
  const dLng = (tailLen / (111000 * Math.cos((last[1] * Math.PI) / 180))) * Math.sin(angle);
  const mid = [round6(last[0] + dLng * 0.55), round6(last[1] + dLat * 0.45)];
  const end = [round6(last[0] + dLng), round6(last[1] + dLat)];

  return { path: [...trunk.map((p) => [round6(p[0]), round6(p[1])]), mid, end], corridorId: corridor.id };
}

function isRingRoute(route) {
  const name = String(route.name || "").toLocaleLowerCase("ru-RU");
  const parts = name.split("-").map((p) => p.trim());
  return parts.length >= 2 && parts[0] === parts[parts.length - 1];
}

/**
 * Строит демо-геометрию и координаты остановок для маршрута.
 * @param route  { id, number, name, type, directions:[{code, stops:[{name}]}] }
 * @returns { directions: Map(code → coords[]), stops: Map(normName → [lng,lat]) }
 */
function buildDemoRouteGeo(route, normalizeName) {
  const directions = new Map();
  const stopCoords = new Map();

  for (const direction of route.directions || []) {
    const stops = direction.stops || [];
    if (stops.length < 2) continue;

    let path;
    if (route.type === "городской" && isRingRoute(route)) {
      path = CITY_RING;
    } else if (route.type === "городской") {
      path = truncateLine(CITY_RING, lineLength(CITY_RING) * 0.6);
    } else {
      path = buildSuburbanPath(route, stops.length).path;
    }

    directions.set(direction.code, path);

    // Остановки равномерно по дуге пути (не по прямой между точками)
    const total = lineLength(path);
    stops.forEach((stop, index) => {
      const key = normalizeName(stop.name);
      if (stopCoords.has(key)) return;
      const d = stops.length === 1 ? 0 : (index / (stops.length - 1)) * total;
      const point = pointAt(path, Math.min(d, total));
      stopCoords.set(key, [round6(point[0]), round6(point[1])]);
    });
  }

  return { directions, stops: stopCoords };
}

// ── Подложка «Схемы» ────────────────────────────────────────────────────────

function schemeBasemap() {
  return {
    center: CITY_CENTER,
    roads: {
      type: "FeatureCollection",
      features: [
        ...CITY_STREETS.map((street) => ({
          type: "Feature",
          properties: { class: street.class, name: street.name },
          geometry: { type: "LineString", coordinates: street.coords },
        })),
        ...CORRIDORS.map((corridor) => ({
          type: "Feature",
          properties: { class: "highway", name: corridor.title },
          geometry: { type: "LineString", coordinates: corridor.coords },
        })),
      ],
    },
    railways: {
      type: "FeatureCollection",
      features: RAILWAYS.map((rail) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: rail.coords },
      })),
    },
    districts: DISTRICTS,
    landmarks: LANDMARKS,
  };
}

module.exports = {
  CITY_CENTER,
  CORRIDORS,
  buildDemoRouteGeo,
  schemeBasemap,
  lineLength,
  haversineMeters,
};
