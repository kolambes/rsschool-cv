// Конфигурация карты и базовых стилей.
// Слой: Map Rendering Layer (конфигурация).

export const CITY_CENTER = [26.0173, 53.1315]; // Барановичи
export const CITY_BOUNDS = [
  [25.90, 53.06],
  [26.14, 53.22],
];
export const DEFAULT_ZOOM = 12.4;
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 17.5;

// Локальная копия (vendor, BSD-3-Clause) + резервные CDN
export const MAPLIBRE_SOURCES = [
  {
    js: 'vendor/maplibre-gl.js',
    css: 'vendor/maplibre-gl.css',
  },
  {
    js: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    css: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  },
  {
    js: 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.min.js',
    css: 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.min.css',
  },
];

// Интервалы обновления live-данных (мс)
export const LIVE_UPDATE_INTERVAL = 5000;        // опрос провайдера
export const LIVE_UPDATE_INTERVAL_SLOW = 15000;  // при деградации / высокой нагрузке
export const VEHICLE_FRAME_INTERVAL = 66;        // ~15 fps анимации транспорта
export const VEHICLE_FRAME_INTERVAL_SIMPLE = 1000; // упрощённый режим
export const GPS_TTL = 30000;                    // TTL позиции: старше — «устаревшие»

const OSM_ATTR = '© Участники <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

function rasterStyle(tiles, attribution) {
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles, tileSize: 256, attribution },
    },
    layers: [{ id: 'base-tiles', type: 'raster', source: 'base' }],
  };
}

// «Схема» — собственный самодостаточный тёмный стиль без внешних тайлов:
// фон + декоративная дорожная сетка добавляются оверлеем в map-controller.
const schemeStyle = {
  version: 8,
  sources: {},
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a0e17' } },
  ],
};

export const BASE_STYLES = {
  scheme: {
    title: 'Схема',
    dark: true,
    style: schemeStyle,
  },
  dark: {
    title: 'Тёмная',
    dark: true,
    style: rasterStyle(
      ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`),
      `${OSM_ATTR}, © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>`
    ),
  },
  light: {
    title: 'Светлая',
    dark: false,
    style: rasterStyle(
      ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png`),
      `${OSM_ATTR}, © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>`
    ),
  },
  hybrid: {
    title: 'Гибрид',
    dark: true,
    style: rasterStyle(
      ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      '© Esri, Maxar, Earthstar Geographics'
    ),
  },
};

// Статусы данных
export const DATA_STATUS = {
  LIVE: 'live',        // актуальные
  STALE: 'stale',      // устаревшие
  OFFLINE: 'offline',  // недоступны
  DEMO: 'demo',        // демо-данные
};

export const DATA_STATUS_LABELS = {
  live: 'Данные актуальны',
  stale: 'Данные устарели',
  offline: 'Данные недоступны',
  demo: 'Демо-данные',
};
