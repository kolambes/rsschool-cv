// Точка входа: ленивая загрузка MapLibre, запуск провайдера данных,
// анимация транспорта, деградация для слабых устройств.

import { MAPLIBRE_SOURCES } from './config.js';
import { providerManager, MockGpsProvider, getRouteGeometry } from './providers.js';
import { mapController } from './map-controller.js';
import { initUI, toast } from './ui.js';
import { store } from './state.js';
import { pointAlong } from './geo.js';

const $ = (sel) => document.querySelector(sel);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = resolve;
    l.onerror = resolve; // карта переживёт отсутствие css maplibre (стили частично свои)
    document.head.appendChild(l);
  });
}

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch { return false; }
}

// Автовключение упрощённого режима на слабых устройствах
function detectLowPerformance() {
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  return mem <= 2 || cores <= 2;
}

// ── Анимация транспорта ─────────────────────────────────────────────────────
// Между обновлениями провайдера позиции экстраполируются вдоль линии маршрута
// (dead reckoning) — так движение остаётся плавным и при реальном GPS.
const liveVehicles = new Map(); // id -> {pos, distanceAlong, forward}

providerManager.onUpdate((positions) => {
  const seen = new Set();
  for (const p of positions) {
    seen.add(p.id);
    liveVehicles.set(p.id, { ...p });
  }
  for (const id of liveVehicles.keys()) {
    if (!seen.has(id)) liveVehicles.delete(id); // борт ушёл с линии
  }
});

let lastFrame = performance.now();
function animateVehicles(now) {
  const dt = Math.min(2, (now - lastFrame) / 1000);
  lastFrame = now;
  if (liveVehicles.size && !document.hidden) {
    const features = [];
    for (const v of liveVehicles.values()) {
      const geom = getRouteGeometry(v.routeId);
      if (!geom) continue;
      const speedMs = (v.speedKmh * 1000) / 3600;
      v.distanceAlong += speedMs * dt * (v.forward ? 1 : -1);
      if (v.distanceAlong >= geom.total) { v.distanceAlong = geom.total; v.forward = false; }
      if (v.distanceAlong <= 0) { v.distanceAlong = 0; v.forward = true; }
      const { coord, bearing } = pointAlong(geom.coords, geom.cum, v.distanceAlong);
      v.lon = coord[0];
      v.lat = coord[1];
      v.bearing = v.forward ? bearing : (bearing + 180) % 360;
      features.push({
        type: 'Feature',
        properties: { id: v.id, routeId: v.routeId, bearing: v.bearing },
        geometry: { type: 'Point', coordinates: coord },
      });
    }
    // синхронизируем экстраполяцию с карточками (скорость/след. остановка)
    for (const p of providerManager.positions) {
      const v = liveVehicles.get(p.id);
      if (v) { p.lon = v.lon; p.lat = v.lat; p.distanceAlong = v.distanceAlong; p.forward = v.forward; }
    }
    mapController.updateVehicles({ type: 'FeatureCollection', features });
  }
  requestAnimationFrame(animateVehicles);
}

// ── Загрузка карты ──────────────────────────────────────────────────────────
async function bootMap() {
  const loader = $('#map-loader');
  const fallback = $('#map-fallback');
  fallback.hidden = true;
  loader.hidden = false;

  if (!hasWebGL()) {
    loader.hidden = true;
    fallback.hidden = false;
    $('#map-fallback-text').textContent =
      'Ваше устройство или браузер не поддерживает WebGL — карта не может быть отображена. Списки маршрутов и остановок доступны в панели слева.';
    return false;
  }

  try {
    // lazy-load: MapLibre подгружается только при открытии карты,
    // при недоступности основного CDN пробуем резервный
    let lastErr = null;
    for (const src of MAPLIBRE_SOURCES) {
      try {
        await Promise.all([loadCss(src.css), loadScript(src.js)]);
        lastErr = null;
        break;
      } catch (err) { lastErr = err; }
    }
    if (lastErr) throw lastErr;
    await mapController.init('map');
    loader.hidden = true;
    document.body.classList.add('map-ready');
    return true;
  } catch (err) {
    console.error('[map]', err);
    loader.hidden = true;
    fallback.hidden = false;
    return false;
  }
}

async function boot() {
  // упрощённый режим: сохранённый выбор, reduced-motion или слабое устройство
  if (!store.get('simplified') && (store.get('reducedMotion') || detectLowPerformance())) {
    store.set({ simplified: true });
  }
  mapController.setSimplified(store.get('simplified'));
  document.body.classList.toggle('simplified', store.get('simplified'));

  initUI(mapController);

  // Data Provider Layer: в статической сборке доступен только demo-провайдер.
  providerManager.registerProvider(new MockGpsProvider());
  providerManager.start();

  const ok = await bootMap();
  if (ok) {
    requestAnimationFrame(animateVehicles);
    if (store.get('simplified')) {
      toast('Включён упрощённый режим для стабильной работы');
    }
  }

  $('#btn-fallback-retry').addEventListener('click', () => window.location.reload());

  // экономия ресурсов: пауза live-обновлений в фоновой вкладке
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) providerManager.stop();
    else { providerManager.start(); lastFrame = performance.now(); }
  });
}

boot();
