// ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ (mock/demo).
// Слой: Transport Domain Layer.
//
// ВАЖНО: геометрия маршрутов, остановки, интервалы и транспорт — демонстрационные
// и НЕ являются реальным расписанием или GPS-данными Автобусного парка.
// При подключении реального провайдера этот модуль заменяется данными API.

export const IS_DEMO_DATA = true;

// ── Маршруты ────────────────────────────────────────────────────────────────
export const ROUTES = [
  {
    id: 'r3', number: '3', name: 'Вокзал – Боровки', direction: 'Вокзал → Боровки',
    color: '#22d3ee', interval: 12, status: 'active',
    coordinates: [
      [26.0173, 53.1287], [26.0190, 53.1298], [26.0205, 53.1310], [26.0215, 53.1332],
      [26.0230, 53.1355], [26.0255, 53.1370], [26.0280, 53.1380], [26.0310, 53.1360],
      [26.0330, 53.1335], [26.0365, 53.1318], [26.0400, 53.1300], [26.0445, 53.1272],
      [26.0480, 53.1250], [26.0525, 53.1228], [26.0560, 53.1210], [26.0610, 53.1192],
      [26.0650, 53.1180],
    ],
    stops: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
  },
  {
    id: 'r6a', number: '6А', name: 'Вокзал – Текстильный', direction: 'Вокзал → Текстильный',
    color: '#a78bfa', interval: 15, status: 'active',
    coordinates: [
      [26.0173, 53.1287], [26.0148, 53.1274], [26.0120, 53.1260], [26.0085, 53.1250],
      [26.0050, 53.1240], [26.0005, 53.1220], [25.9960, 53.1200], [25.9920, 53.1185],
      [25.9880, 53.1170], [25.9855, 53.1160], [25.9830, 53.1150],
    ],
    stops: ['s1', 's8', 's9', 's10', 's11'],
  },
  {
    id: 'r10', number: '10', name: 'Вокзал – Речица', direction: 'Вокзал → Речица',
    color: '#34d399', interval: 10, status: 'delayed',
    coordinates: [
      [26.0173, 53.1287], [26.0190, 53.1298], [26.0205, 53.1310], [26.0215, 53.1332],
      [26.0230, 53.1355], [26.0265, 53.1388], [26.0300, 53.1420], [26.0350, 53.1450],
      [26.0400, 53.1480], [26.0440, 53.1500], [26.0480, 53.1520], [26.0515, 53.1535],
      [26.0550, 53.1550],
    ],
    stops: ['s1', 's2', 's3', 's12', 's13', 's14'],
  },
  {
    id: 'r22', number: '22', name: 'Вокзал – Северный', direction: 'Вокзал → Северный',
    color: '#f472b6', interval: 18, status: 'changed',
    coordinates: [
      [26.0173, 53.1287], [26.0162, 53.1308], [26.0150, 53.1330], [26.0140, 53.1365],
      [26.0130, 53.1400], [26.0115, 53.1440], [26.0100, 53.1480], [26.0085, 53.1520],
      [26.0070, 53.1560], [26.0060, 53.1605], [26.0050, 53.1650],
    ],
    stops: ['s1', 's15', 's16', 's17'],
  },
  {
    id: 'r25', number: '25', name: 'Вокзал – Фабричная', direction: 'Вокзал → Фабричная',
    color: '#fbbf24', interval: 20, status: 'active',
    coordinates: [
      [26.0173, 53.1287], [26.0148, 53.1294], [26.0120, 53.1300], [26.0085, 53.1315],
      [26.0050, 53.1330], [26.0000, 53.1355], [25.9950, 53.1380], [25.9900, 53.1400],
      [25.9850, 53.1420], [25.9800, 53.1435], [25.9750, 53.1450],
    ],
    stops: ['s1', 's18', 's19', 's20'],
  },
];

// ── Остановки ───────────────────────────────────────────────────────────────
export const STOPS = [
  { id: 's1',  name: 'Вокзал',                coord: [26.0173, 53.1287] },
  { id: 's2',  name: 'Ул. Фроленкова',        coord: [26.0205, 53.1310] },
  { id: 's3',  name: 'Ул. Ленина',            coord: [26.0230, 53.1355] },
  { id: 's4',  name: 'Площадь Ленина',        coord: [26.0280, 53.1380] },
  { id: 's5',  name: 'Ул. Советская',         coord: [26.0330, 53.1335] },
  { id: 's6',  name: 'Универмаг',             coord: [26.0400, 53.1300] },
  { id: 's7',  name: 'Мкр-н Боровки',         coord: [26.0650, 53.1180] },
  { id: 's8',  name: 'Автовокзал',            coord: [26.0120, 53.1260] },
  { id: 's9',  name: 'Ул. Брестская',         coord: [26.0050, 53.1240] },
  { id: 's10', name: 'Хлопчатобумажный комбинат', coord: [25.9880, 53.1170] },
  { id: 's11', name: 'Мкр-н Текстильный',     coord: [25.9830, 53.1150] },
  { id: 's12', name: 'Ул. Царюка',            coord: [26.0300, 53.1420] },
  { id: 's13', name: 'Ул. Наконечникова',     coord: [26.0400, 53.1480] },
  { id: 's14', name: 'Мкр-н Речица',          coord: [26.0550, 53.1550] },
  { id: 's15', name: 'Ул. Куйбышева',         coord: [26.0150, 53.1330] },
  { id: 's16', name: 'Ул. Профессиональная',  coord: [26.0100, 53.1480] },
  { id: 's17', name: 'Мкр-н Северный',        coord: [26.0050, 53.1650] },
  { id: 's18', name: 'Ул. Слонимская',        coord: [26.0050, 53.1330] },
  { id: 's19', name: 'Ул. Чернышевского',     coord: [25.9850, 53.1420] },
  { id: 's20', name: 'Мкр-н Фабричная',       coord: [25.9750, 53.1450] },
];

// ── Транспорт (демо-борта; позиции вычисляет mock-провайдер) ────────────────
export const VEHICLES = [
  { id: 'v1', routeId: 'r3',  board: 'AB 1234-1', type: 'Автобус', speed: 32, offset: 0.05, dir: 1 },
  { id: 'v2', routeId: 'r3',  board: 'AB 1287-1', type: 'Автобус', speed: 28, offset: 0.55, dir: -1 },
  { id: 'v3', routeId: 'r6a', board: 'AB 2011-1', type: 'Автобус', speed: 26, offset: 0.20, dir: 1 },
  { id: 'v4', routeId: 'r6a', board: 'AB 2045-1', type: 'Автобус', speed: 30, offset: 0.70, dir: -1 },
  { id: 'v5', routeId: 'r10', board: 'AB 3308-1', type: 'Автобус', speed: 24, offset: 0.10, dir: 1 },
  { id: 'v6', routeId: 'r10', board: 'AB 3312-1', type: 'Автобус', speed: 27, offset: 0.45, dir: -1 },
  { id: 'v7', routeId: 'r10', board: 'AB 3355-1', type: 'Автобус', speed: 22, offset: 0.80, dir: 1 },
  { id: 'v8', routeId: 'r22', board: 'AB 4102-1', type: 'Автобус', speed: 31, offset: 0.30, dir: 1 },
  { id: 'v9', routeId: 'r22', board: 'AB 4160-1', type: 'Автобус', speed: 29, offset: 0.75, dir: -1 },
  { id: 'v10', routeId: 'r25', board: 'AB 5210-1', type: 'Автобус', speed: 33, offset: 0.15, dir: 1 },
  { id: 'v11', routeId: 'r25', board: 'AB 5231-1', type: 'Автобус', speed: 25, offset: 0.60, dir: -1 },
];

// ── Изменения движения ──────────────────────────────────────────────────────
export const ALERTS = [
  {
    id: 'a1', routeId: 'r10', type: 'delay', typeLabel: 'Задержка',
    title: 'Ул. Ленина – Речица',
    text: 'Задержка движения до 7 минут. Ориентировочно до 18:00.',
    until: 'до 18:00',
  },
  {
    id: 'a2', routeId: 'r22', type: 'temp', typeLabel: 'Временное изменение',
    title: 'Объезд по ул. Куйбышева',
    text: 'Из-за ремонта участка дороги маршрут временно следует по ул. Куйбышева без заезда к остановке «Ул. Профессиональная».',
    until: 'до 25.07',
  },
  {
    id: 'a3', routeId: 'r25', type: 'roadwork', typeLabel: 'Ремонт',
    title: 'Ремонт на ул. Слонимской',
    text: 'Возможны небольшие задержки в часы пик из-за сужения проезжей части.',
    until: 'до конца месяца',
  },
];

// ── Районы / ключевые места (подписи на «Схеме», поиск по адресам) ──────────
export const DISTRICTS = [
  { id: 'd1', name: 'Центр',       coord: [26.0250, 53.1345] },
  { id: 'd2', name: 'Боровки',     coord: [26.0640, 53.1170] },
  { id: 'd3', name: 'Текстильный', coord: [25.9840, 53.1140] },
  { id: 'd4', name: 'Речица',      coord: [26.0560, 53.1560] },
  { id: 'd5', name: 'Северный',    coord: [26.0060, 53.1660] },
  { id: 'd6', name: 'Фабричная',   coord: [25.9740, 53.1460] },
];

// Декоративная дорожная сетка для стиля «Схема» (не является реальной картой улиц)
export const SCHEME_ROADS = [
  [[25.955, 53.128], [26.017, 53.129], [26.075, 53.115]],
  [[26.017, 53.129], [26.023, 53.136], [26.031, 53.145], [26.058, 53.158]],
  [[26.017, 53.129], [26.013, 53.140], [26.006, 53.168]],
  [[26.017, 53.129], [25.998, 53.134], [25.970, 53.147]],
  [[25.985, 53.108], [26.006, 53.124], [26.028, 53.138], [26.048, 53.152]],
  [[26.045, 53.105], [26.040, 53.130], [26.030, 53.142], [26.020, 53.160]],
  [[25.960, 53.140], [25.995, 53.136], [26.028, 53.138], [26.070, 53.135]],
];

const STATUS_LABELS = { active: 'На маршруте', delayed: 'Задержка', changed: 'Изменения' };
export function routeStatusLabel(status) {
  return STATUS_LABELS[status] || 'Нет данных';
}

export function getRoute(id) { return ROUTES.find((r) => r.id === id) || null; }
export function getStop(id) { return STOPS.find((s) => s.id === id) || null; }
export function getVehicle(id) { return VEHICLES.find((v) => v.id === id) || null; }
export function routesThroughStop(stopId) { return ROUTES.filter((r) => r.stops.includes(stopId)); }
export function alertsForRoute(routeId) { return ALERTS.filter((a) => a.routeId === routeId); }

// ── GeoJSON (строится один раз, не пересоздаётся) ───────────────────────────
let routesGeoJsonCache = null;
export function routesGeoJson() {
  if (!routesGeoJsonCache) {
    routesGeoJsonCache = {
      type: 'FeatureCollection',
      features: ROUTES.map((r) => ({
        type: 'Feature',
        properties: { id: r.id, number: r.number, color: r.color, status: r.status },
        geometry: { type: 'LineString', coordinates: r.coordinates },
      })),
    };
  }
  return routesGeoJsonCache;
}

let stopsGeoJsonCache = null;
export function stopsGeoJson() {
  if (!stopsGeoJsonCache) {
    stopsGeoJsonCache = {
      type: 'FeatureCollection',
      features: STOPS.map((s) => ({
        type: 'Feature',
        properties: { id: s.id, name: s.name, routes: routesThroughStop(s.id).map((r) => r.number).join(', ') },
        geometry: { type: 'Point', coordinates: s.coord },
      })),
    };
  }
  return stopsGeoJsonCache;
}

let roadsGeoJsonCache = null;
export function schemeRoadsGeoJson() {
  if (!roadsGeoJsonCache) {
    roadsGeoJsonCache = {
      type: 'FeatureCollection',
      features: SCHEME_ROADS.map((coords, i) => ({
        type: 'Feature',
        properties: { id: `road-${i}` },
        geometry: { type: 'LineString', coordinates: coords },
      })),
    };
  }
  return roadsGeoJsonCache;
}
