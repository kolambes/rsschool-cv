// Map Rendering Layer: MapLibre, слои GeoJSON, выбор объектов, анимация транспорта.
//
// Производительность:
//  - GeoJSON маршрутов/остановок строится один раз (см. demo-data.js);
//  - на каждый кадр обновляется ТОЛЬКО источник 'vehicles';
//  - обработчики move/zoom троттлятся;
//  - иконки транспорта — заранее отрисованные canvas-спрайты по цвету маршрута;
//  - в упрощённом режиме частота кадров снижается, glow-слои отключаются.

import {
  BASE_STYLES, CITY_BOUNDS, CITY_CENTER, DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM,
  VEHICLE_FRAME_INTERVAL, VEHICLE_FRAME_INTERVAL_SIMPLE,
} from './config.js';
import {
  ROUTES, DISTRICTS, routesGeoJson, stopsGeoJson, schemeRoadsGeoJson, getRoute,
} from './demo-data.js';
import { boundsOf, haversine } from './geo.js';
import { store, throttle } from './state.js';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

export class MapController {
  constructor() {
    this.map = null;
    this.ready = false;
    this.simplified = false;
    this._districtMarkers = [];
    this._pulseMarker = null;
    this._lastVehicleFrame = 0;
    this._pendingVehicles = null;
    this._rafId = null;
    this.handlers = {}; // события наружу: onStopClick, onVehicleClick, onRouteClick, onMapMove
  }

  async init(container) {
    const maplibregl = window.maplibregl;
    const styleDef = BASE_STYLES[store.get('baseStyle')] || BASE_STYLES.scheme;

    this.map = new maplibregl.Map({
      container,
      style: styleDef.style,
      center: CITY_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxBounds: [[CITY_BOUNDS[0][0] - 0.3, CITY_BOUNDS[0][1] - 0.2], [CITY_BOUNDS[1][0] + 0.3, CITY_BOUNDS[1][1] + 0.2]],
      attributionControl: { compact: true },
      fadeDuration: this.simplified ? 0 : 300,
    });

    await new Promise((resolve) => this.map.once('load', resolve));
    await this._buildOverlay();
    this._bindInteractions();
    this.ready = true;
  }

  // ── Иконки транспорта (canvas-спрайты по цвету маршрута) ──────────────────
  _makeBusIcon(color) {
    const s = 56;
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const ctx = c.getContext('2d');
    // свечение
    const grad = ctx.createRadialGradient(s / 2, s / 2, 6, s / 2, s / 2, s / 2);
    grad.addColorStop(0, color + 'aa');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    // корпус-стрелка (направление вверх; поворот делает MapLibre через icon-rotate)
    ctx.translate(s / 2, s / 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(8,12,20,.9)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(9, 7);
    ctx.quadraticCurveTo(0, 2, -9, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0b1020';
    ctx.beginPath();
    ctx.arc(0, -2, 2.6, 0, Math.PI * 2);
    ctx.fill();
    return ctx.getImageData(0, 0, s, s);
  }

  async _addBusIcons() {
    for (const r of ROUTES) {
      const name = `bus-${r.id}`;
      if (!this.map.hasImage(name)) {
        this.map.addImage(name, this._makeBusIcon(r.color), { pixelRatio: 2 });
      }
    }
  }

  // ── Слои поверх базового стиля ────────────────────────────────────────────
  async _buildOverlay() {
    const map = this.map;
    const isScheme = store.get('baseStyle') === 'scheme';
    const dark = BASE_STYLES[store.get('baseStyle')]?.dark !== false;

    // Декоративная сетка только для «Схемы»
    if (isScheme) {
      map.addSource('scheme-roads', { type: 'geojson', data: schemeRoadsGeoJson() });
      map.addLayer({
        id: 'scheme-roads', type: 'line', source: 'scheme-roads',
        paint: { 'line-color': '#1c2536', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 15, 7] },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }

    map.addSource('routes', { type: 'geojson', data: routesGeoJson(), promoteId: 'id' });
    map.addSource('stops', { type: 'geojson', data: stopsGeoJson(), promoteId: 'id' });
    map.addSource('vehicles', { type: 'geojson', data: this._pendingVehicles || EMPTY_FC, promoteId: 'id' });

    // Glow под линиями (отключается в упрощённом режиме)
    map.addLayer({
      id: 'route-glow', type: 'line', source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: this.simplified ? 'none' : 'visible' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 15, 16],
        'line-blur': 6,
        'line-opacity': 0.35,
      },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.2, 15, 6],
        'line-opacity': 0.95,
      },
    });

    map.addLayer({
      id: 'stops', type: 'circle', source: 'stops',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 7],
        'circle-color': dark ? '#0b1020' : '#ffffff',
        'circle-stroke-color': dark ? '#e2e8f0' : '#334155',
        'circle-stroke-width': 2,
      },
    });

    await this._addBusIcons();
    map.addLayer({
      id: 'vehicles', type: 'symbol', source: 'vehicles',
      layout: {
        'icon-image': ['concat', 'bus-', ['get', 'routeId']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.7, 15, 1.15],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });

    this._addDistrictLabels(isScheme || dark);
    this._applySelectionPaint();
  }

  // Подписи районов — HTML-маркеры (без glyph-серверов, полный контроль CSS)
  _addDistrictLabels(dark) {
    for (const m of this._districtMarkers) m.remove();
    this._districtMarkers = [];
    for (const d of DISTRICTS) {
      const el = document.createElement('div');
      el.className = `district-label${dark ? '' : ' district-label--light'}`;
      el.textContent = d.name;
      const marker = new window.maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(d.coord)
        .addTo(this.map);
      this._districtMarkers.push(marker);
    }
  }

  // ── Взаимодействия ────────────────────────────────────────────────────────
  _bindInteractions() {
    const map = this.map;

    for (const layer of ['stops', 'vehicles', 'route-line']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }

    map.on('click', 'stops', (e) => {
      e.preventDefault();
      const f = e.features && e.features[0];
      if (f) this.handlers.onStopClick?.(f.properties.id, e.lngLat);
    });
    map.on('click', 'vehicles', (e) => {
      e.preventDefault();
      const f = e.features && e.features[0];
      if (f) this.handlers.onVehicleClick?.(f.properties.id);
    });
    map.on('click', 'route-line', (e) => {
      if (e.defaultPrevented) return;
      const f = e.features && e.features[0];
      if (f) this.handlers.onRouteClick?.(f.properties.id);
    });
    map.on('click', (e) => {
      if (!e.defaultPrevented) {
        const hit = map.queryRenderedFeatures(e.point, { layers: ['stops', 'vehicles', 'route-line'] });
        if (!hit.length) this.handlers.onMapClick?.();
      }
    });

    // hover-подсказка по остановкам (троттлится)
    map.on('mousemove', 'stops', throttle((e) => {
      const f = e.features && e.features[0];
      if (f) this.handlers.onStopHover?.(f.properties, e.point);
    }, 80));
    map.on('mouseleave', 'stops', () => this.handlers.onStopHover?.(null));

    map.on('move', throttle(() => this.handlers.onMapMove?.(), 90));
    map.on('zoom', throttle(() => this.handlers.onMapMove?.(), 90));
    map.on('moveend', () => this.handlers.onMapMove?.());
  }

  // ── Выбор маршрута: подсветка выбранного, приглушение остальных ───────────
  _applySelectionPaint() {
    const map = this.map;
    if (!map.getLayer('route-line')) return;
    const sel = store.get('selectedRouteId');
    if (!sel) {
      map.setPaintProperty('route-line', 'line-opacity', 0.95);
      map.setPaintProperty('route-line', 'line-width', ['interpolate', ['linear'], ['zoom'], 11, 2.2, 15, 6]);
      if (map.getLayer('route-glow')) map.setPaintProperty('route-glow', 'line-opacity', 0.35);
      map.setPaintProperty('vehicles', 'icon-opacity', 1);
      map.setPaintProperty('stops', 'circle-opacity', 1);
      map.setPaintProperty('stops', 'circle-stroke-opacity', 1);
      return;
    }
    const isSel = ['==', ['get', 'id'], sel];
    map.setPaintProperty('route-line', 'line-opacity', ['case', isSel, 1, 0.18]);
    map.setPaintProperty('route-line', 'line-width', [
      'interpolate', ['linear'], ['zoom'],
      11, ['case', isSel, 3.5, 1.8],
      15, ['case', isSel, 8, 4],
    ]);
    if (map.getLayer('route-glow')) {
      map.setPaintProperty('route-glow', 'line-opacity', ['case', isSel, 0.5, 0.05]);
    }
    map.setPaintProperty('vehicles', 'icon-opacity', ['case', ['==', ['get', 'routeId'], sel], 1, 0.25]);
    const route = getRoute(sel);
    const stopIds = route ? route.stops : [];
    const stopSel = ['in', ['get', 'id'], ['literal', stopIds]];
    map.setPaintProperty('stops', 'circle-opacity', ['case', stopSel, 1, 0.3]);
    map.setPaintProperty('stops', 'circle-stroke-opacity', ['case', stopSel, 1, 0.3]);
  }

  selectRoute(routeId, { fit = true } = {}) {
    store.set({ selectedRouteId: routeId });
    if (!this.ready) return;
    this._applySelectionPaint();
    if (routeId && fit) this.fitRoute(routeId);
  }

  fitRoute(routeId) {
    const route = getRoute(routeId || store.get('selectedRouteId'));
    if (!route || !this.ready) {
      this.map?.fitBounds(CITY_BOUNDS, { padding: 80, duration: this._dur(900) });
      return;
    }
    const mobile = window.matchMedia('(max-width: 820px)').matches;
    this.map.fitBounds(boundsOf(route.coordinates), {
      padding: mobile
        ? { top: 250, bottom: Math.round(window.innerHeight * 0.5) + 40, left: 40, right: 40 }
        : { top: 130, bottom: 220, left: 400, right: 380 },
      duration: this._dur(900),
    });
  }

  flyTo(coord, zoom = 15) {
    this.map?.flyTo({ center: coord, zoom, duration: this._dur(900), essential: true });
  }

  _dur(ms) { return (this.simplified || store.get('reducedMotion')) ? 0 : ms; }

  // Пульсирующий маркер выбранной точки/остановки
  setPulse(coord) {
    if (this._pulseMarker) { this._pulseMarker.remove(); this._pulseMarker = null; }
    if (!coord || !this.ready) return;
    const el = document.createElement('div');
    el.className = 'pulse-marker';
    el.innerHTML = '<i></i><i></i><b></b>';
    this._pulseMarker = new window.maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(coord)
      .addTo(this.map);
  }

  // ── Транспорт: обновление только источника vehicles, с ограничением FPS ───
  updateVehicles(featureCollection) {
    this._pendingVehicles = featureCollection;
    if (!this.ready) return;
    const now = performance.now();
    const interval = this.simplified ? VEHICLE_FRAME_INTERVAL_SIMPLE : VEHICLE_FRAME_INTERVAL;
    if (now - this._lastVehicleFrame < interval) {
      if (!this._rafId) {
        this._rafId = requestAnimationFrame(() => {
          this._rafId = null;
          this.updateVehicles(this._pendingVehicles);
        });
      }
      return;
    }
    this._lastVehicleFrame = now;
    const src = this.map.getSource('vehicles');
    if (src) src.setData(featureCollection);
  }

  // ── Переключение базового стиля с восстановлением оверлея ─────────────────
  async setBaseStyle(name) {
    if (!BASE_STYLES[name] || !this.ready) return;
    store.set({ baseStyle: name });
    const map = this.map;
    map.setStyle(BASE_STYLES[name].style, { diff: false });
    await new Promise((resolve) => map.once('style.load', resolve));
    await this._buildOverlay();
    const stopId = store.get('selectedStopId');
    if (stopId) this.handlers.onStyleRestored?.();
  }

  setSimplified(value) {
    this.simplified = value;
    if (!this.ready) return;
    if (this.map.getLayer('route-glow')) {
      this.map.setLayoutProperty('route-glow', 'visibility', value ? 'none' : 'visible');
    }
  }

  project(coord) { return this.ready ? this.map.project(coord) : null; }

  getScale() {
    if (!this.ready) return null;
    const y = this.map.getContainer().clientHeight / 2;
    const a = this.map.unproject([0, y]);
    const b = this.map.unproject([100, y]);
    return haversine([a.lng, a.lat], [b.lng, b.lat]); // метров на 100px
  }

  locate(onError) {
    if (!('geolocation' in navigator)) { onError?.('Геолокация не поддерживается браузером'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coord = [pos.coords.longitude, pos.coords.latitude];
        this.setPulse(coord);
        this.flyTo(coord, 15);
      },
      () => onError?.('Не удалось определить местоположение'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  zoomIn() { this.map?.zoomIn({ duration: this._dur(250) }); }
  zoomOut() { this.map?.zoomOut({ duration: this._dur(250) }); }
}

export const mapController = new MapController();
