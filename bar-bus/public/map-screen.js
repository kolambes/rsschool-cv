// ─────────────────────────────────────────────────────────────────────────────
// Экран «Карта» Mini App (v2, immersive) + блок карты в расписании.
//
// Полноэкранный тёмный карт-модуль: векторная «Схема» (встроенная подложка
// улиц города, работает без внешних сервисов), режимы «Спутник» и «Гибрид»
// (внешние тайлы с атрибуцией и автоматическим откатом на «Схему»),
// glass-панели, лента маршрутов, карточки маршрута/остановки/транспорта,
// плавная анимация автобусов.
//
// Пользователь не входит в аккаунт: подписки и избранное привязываются
// к Telegram ID через x-telegram-init-data (валидируется сервером).
// Общение с app.js — только через мост window.BarBusApp.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  "use strict";

  const VEHICLES_POLL_MS = 6000;
  const VEHICLE_TWEEN_MS = 900;
  const ALERTS_POLL_MS = 60000;

  const $ = (sel) => document.querySelector(sel);

  const els = {
    view: $('.view[data-view="map"]'),
    stage: $("#mapxStage"),
    canvas: $("#mapxCanvas"),
    loading: $("#mapxLoading"),
    empty: $("#mapxEmpty"),
    demoChip: $("#mapxDemoChip"),
    liveChip: $("#mapxLiveChip"),
    modes: $("#mapxModes"),
    search: $("#mapxSearch"),
    searchResults: $("#mapxSearchResults"),
    alerts: $("#mapxAlerts"),
    fabZoomIn: $("#mapxZoomIn"),
    fabZoomOut: $("#mapxZoomOut"),
    fabLocate: $("#mapxLocate"),
    fabFit: $("#mapxFit"),
    hint: $("#mapxHint"),
    routes: $("#mapxRoutes"),
    card: $("#mapxCard"),
    scheduleBlock: $("#scheduleMapBlock"),
    scheduleTitle: $("#scheduleMapTitle"),
    scheduleOpen: $("#scheduleMapOpen"),
    schedulePreview: $("#scheduleMapPreview"),
  };

  if (!els.view || !els.canvas) return;

  const state = {
    booted: false,
    booting: false,
    map: null,
    config: null,
    data: null,
    dataPromise: null,
    mode: "scheme",
    alerts: [],
    subscriptions: new Set(),
    selection: null, // { kind: 'route'|'stop'|'vehicle', id, directionCode? }
    representatives: [], // маршруты, видимые в режиме обзора
    districtMarkers: [],
    pulseMarker: null,
    vehicles: new Map(), // id → { from:{lng,lat,bearing}, to:{...}, t0, props }
    vehiclesStatus: "offline",
    vehiclesTimer: null,
    alertsTimer: null,
    rafId: null,
    lastScheduleContextKey: "",
    tileFailNotified: false,
  };

  const app = () => window.BarBusApp || null;
  const tgHeaders = () => (app()?.telegramHeaders ? app().telegramHeaders() : {});
  const hasTelegram = () => Boolean(app()?.hasTelegram?.());
  const toast = (message) => app()?.showToast?.(message);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  const normalize = (value) => String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();

  // ════════════════════════════════════════════════════════════════════════
  // Загрузка данных и MapLibre
  // ════════════════════════════════════════════════════════════════════════

  function loadAllData(force = false) {
    if (state.dataPromise && !force) return state.dataPromise;
    state.dataPromise = Promise.all([
      fetch("/api/map/config").then((r) => { if (!r.ok) throw new Error("config"); return r.json(); }),
      fetch("/api/map/data").then((r) => { if (!r.ok) throw new Error("data"); return r.json(); }),
    ])
      .then(([config, data]) => {
        state.config = config;
        state.data = data;
        return { config, data };
      })
      .catch((error) => {
        state.dataPromise = null;
        throw error;
      });
    return state.dataPromise;
  }

  let maplibrePromise = null;
  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (maplibrePromise) return maplibrePromise;
    maplibrePromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/maplibre-gl.css";
      document.head.appendChild(css);
      const script = document.createElement("script");
      script.src = "/vendor/maplibre-gl.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Не удалось загрузить библиотеку карты."));
      document.head.appendChild(script);
    });
    return maplibrePromise;
  }

  // ── Базовые стили режимов ────────────────────────────────────────────────

  function schemeStyle() {
    // Самодостаточная тёмная подложка: улицы города из /api/map/config
    const basemap = state.config?.basemap;
    return {
      version: 8,
      sources: {
        "bm-roads": { type: "geojson", data: basemap?.roads || { type: "FeatureCollection", features: [] } },
        "bm-rail": { type: "geojson", data: basemap?.railways || { type: "FeatureCollection", features: [] } },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0a0f1c" } },
        {
          id: "bm-roads-casing", type: "line", source: "bm-roads",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#050a14",
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "class"], "highway", 5, "major", 4, 2.5], 15, ["match", ["get", "class"], "highway", 13, "major", 11, 7]],
          },
        },
        {
          id: "bm-roads", type: "line", source: "bm-roads",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["match", ["get", "class"], "highway", "#26334d", "major", "#222f47", "#1b2639"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "class"], "highway", 3, "major", 2.4, 1.4], 15, ["match", ["get", "class"], "highway", 9, "major", 7.5, 4.5]],
          },
        },
        {
          id: "bm-rail", type: "line", source: "bm-rail",
          paint: {
            "line-color": "#33415e",
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 15, 3],
            "line-dasharray": [3, 2.4],
          },
        },
      ],
    };
  }

  function rasterStyle(mode) {
    const modeConfig = state.config?.modes?.[mode];
    const sources = {
      base: { type: "raster", tiles: modeConfig.tiles, tileSize: 256, attribution: modeConfig.attribution || "" },
    };
    const layers = [
      { id: "bg", type: "background", paint: { "background-color": "#0a0f1c" } },
      { id: "base-raster", type: "raster", source: "base", paint: { "raster-fade-duration": 150 } },
    ];
    if (mode === "hybrid" && modeConfig.labels) {
      sources.labels = { type: "raster", tiles: modeConfig.labels, tileSize: 256 };
      layers.push({ id: "labels-raster", type: "raster", source: "labels", paint: { "raster-opacity": 0.95 } });
    }
    return { version: 8, sources, layers };
  }

  function styleForMode(mode) {
    if (mode === "satellite" || mode === "hybrid") {
      if (state.config?.modes?.[mode]?.enabled) return rasterStyle(mode);
      return schemeStyle();
    }
    return schemeStyle();
  }

  // ── Иконки транспорта ────────────────────────────────────────────────────

  function busIconImage(color) {
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    // свечение
    const glow = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
    glow.addColorStop(0, color + "88");
    glow.addColorStop(1, color + "00");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
    // стрелка-корпус
    ctx.translate(size / 2, size / 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(6,10,18,0.95)";
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(0, -11.5);
    ctx.lineTo(8.5, 7.5);
    ctx.quadraticCurveTo(0, 2.6, -8.5, 7.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(0, -2.5, 2.1, 0, Math.PI * 2);
    ctx.fill();
    return ctx.getImageData(0, 0, size, size);
  }

  function ensureBusIcons() {
    for (const route of state.data?.routes || []) {
      const name = `busx-${route.id}`;
      if (!state.map.hasImage(name)) {
        state.map.addImage(name, busIconImage(route.color || "#22d3ee"), { pixelRatio: 2 });
      }
    }
  }

  // ── GeoJSON-хелперы ──────────────────────────────────────────────────────

  function routeFeatures(routeIds) {
    const wanted = routeIds ? new Set(routeIds) : null;
    return (state.data?.routes || [])
      .filter((route) => !wanted || wanted.has(route.id))
      .flatMap((route) => route.directions.map((direction) => ({
        type: "Feature",
        properties: { routeId: route.id, direction: direction.code, number: route.number, color: route.color || "#22d3ee" },
        geometry: { type: "LineString", coordinates: direction.geometry },
      })));
  }

  function stopFeatures() {
    return (state.data?.stops || []).map((stop) => ({
      type: "Feature",
      properties: {
        key: stop.key,
        name: stop.name,
        routes: stop.routes.join(", "),
        major: stop.routes.length >= 4 ? 1 : 0,
      },
      geometry: { type: "Point", coordinates: [stop.lng, stop.lat] },
    }));
  }

  // Обзорный режим: чтобы карта не превращалась в клубок из 115 линий,
  // показываем по одному «представителю» каждого магистрального коридора
  // (пригородные маршруты одного направления идут по общей линии) + все
  // городские маршруты. Полный список доступен в ленте и поиске.
  function pickRepresentatives() {
    const seen = new Map();
    const representatives = [];
    for (const route of state.data?.routes || []) {
      if (route.type === "городской") {
        representatives.push(route.id);
        continue;
      }
      const geometry = route.directions[0]?.geometry;
      if (!geometry || geometry.length < 4) continue;
      const signature = geometry.slice(1, 4).map((p) => p.join(",")).join(";");
      if (!seen.has(signature)) {
        seen.set(signature, route.id);
        representatives.push(route.id);
      }
    }
    return representatives;
  }

  function cityBounds() {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const stop of state.data?.stops || []) {
      if (stop.lng < minLng) minLng = stop.lng;
      if (stop.lat < minLat) minLat = stop.lat;
      if (stop.lng > maxLng) maxLng = stop.lng;
      if (stop.lat > maxLat) maxLat = stop.lat;
    }
    if (!Number.isFinite(minLng)) return null;
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  // ════════════════════════════════════════════════════════════════════════
  // Построение карты
  // ════════════════════════════════════════════════════════════════════════

  async function bootMap() {
    if (state.booted || state.booting) return;
    state.booting = true;
    els.loading.hidden = false;
    try {
      const [{ data }] = await Promise.all([loadAllData(), loadMapLibre()]);
      if (!data.routes.length) {
        els.loading.hidden = true;
        els.empty.hidden = false;
        renderStatusChips();
        state.booting = false;
        return;
      }

      state.representatives = pickRepresentatives();
      const center = state.config?.center || { lat: 53.132, lng: 26.014 };

      state.map = new maplibregl.Map({
        container: els.canvas,
        style: styleForMode(state.mode),
        center: [center.lng, center.lat],
        zoom: 12.1,
        minZoom: 9,
        maxZoom: 17,
        attributionControl: { compact: true },
        fadeDuration: reducedMotion ? 0 : 200,
      });

      await new Promise((resolve) => state.map.once("load", resolve));
      state.map.resize();
      new ResizeObserver(() => state.map?.resize()).observe(els.canvas);
      buildOverlayLayers();
      bindMapEvents();

      // Ошибка загрузки тайлов Спутника/Гибрида → откат на «Схему»
      state.map.on("error", (event) => {
        const sourceId = event?.sourceId || event?.source?.id;
        if ((sourceId === "base" || sourceId === "labels") && state.mode !== "scheme" && !state.tileFailNotified) {
          state.tileFailNotified = true;
          toast("Спутниковая подложка недоступна — показана «Схема».");
          setMode("scheme");
        }
      });

      state.booted = true;
      // Хук для авто-тестов и отладки (данные и так публичные)
      window.__mapx = { map: state.map, selectRoute, selectStop, selectVehicle, setMode, state };
      els.loading.hidden = true;
      fitCity(0);
      renderStatusChips();
      renderModeButtons();
      renderRouteScroller();
      renderDistrictLabels(true);
      applyDeepTarget();
      refreshAlerts();
      loadSubscriptions();
      startVehicleLoop();
    } catch (error) {
      console.warn("Map boot failed", error);
      els.loading.hidden = true;
      els.empty.hidden = false;
      els.empty.querySelector("p").textContent = error.message || "Не удалось загрузить карту. Попробуйте позже.";
    } finally {
      state.booting = false;
    }
  }

  function buildOverlayLayers() {
    const map = state.map;
    const shown = state.selection?.kind === "route" ? [state.selection.id] : state.representatives;

    map.addSource("x-routes", { type: "geojson", data: { type: "FeatureCollection", features: routeFeatures(shown) } });
    map.addSource("x-stops", { type: "geojson", data: { type: "FeatureCollection", features: stopFeatures() } });
    map.addSource("x-vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

    // Свечение → тёмная подложка линии → цветная линия
    map.addLayer({
      id: "x-route-glow", type: "line", source: "x-routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 15, 18],
        "line-blur": 8,
        "line-opacity": reducedMotion ? 0.18 : 0.32,
      },
    });
    map.addLayer({
      id: "x-route-casing", type: "line", source: "x-routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#060b16",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4.6, 15, 10],
        "line-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "x-route-line", type: "line", source: "x-routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.6, 15, 6.5],
        "line-opacity": 0.96,
      },
    });

    // Остановки: крупные узлы видны раньше, остальные — при приближении
    map.addLayer({
      id: "x-stops-minor", type: "circle", source: "x-stops",
      minzoom: 12.6,
      filter: ["==", ["get", "major"], 0],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.6, 2.4, 16, 6],
        "circle-color": "#0d1526",
        "circle-stroke-color": "#dbe4f3",
        "circle-stroke-width": 1.6,
      },
    });
    map.addLayer({
      id: "x-stops-major", type: "circle", source: "x-stops",
      minzoom: 11,
      filter: ["==", ["get", "major"], 1],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.2, 16, 7.5],
        "circle-color": "#0d1526",
        "circle-stroke-color": "#f3f7ff",
        "circle-stroke-width": 2,
      },
    });

    ensureBusIcons();
    map.addLayer({
      id: "x-vehicles", type: "symbol", source: "x-vehicles",
      layout: {
        "icon-image": ["concat", "busx-", ["get", "routeId"]],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.62, 15, 1.05],
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });

    applySelectionPaint();
  }

  function renderDistrictLabels(create = false) {
    if (!create && !state.districtMarkers.length) return;
    for (const marker of state.districtMarkers) marker.remove();
    state.districtMarkers = [];
    if (state.mode !== "scheme") return; // на снимке районы подписаны самой подложкой
    const basemap = state.config?.basemap;
    for (const district of basemap?.districts || []) {
      const el = document.createElement("div");
      el.className = "mapx-district";
      el.textContent = district.name;
      state.districtMarkers.push(new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(district.coord).addTo(state.map));
    }
    for (const landmark of basemap?.landmarks || []) {
      const el = document.createElement("div");
      el.className = "mapx-landmark";
      el.textContent = landmark.name;
      state.districtMarkers.push(new maplibregl.Marker({ element: el, anchor: "top" }).setLngLat(landmark.coord).addTo(state.map));
    }
    syncLabelVisibility();
  }

  // Подписи ориентиров показываются только при приближении — на дальнем
  // зуме они наезжают друг на друга в центре города.
  function syncLabelVisibility() {
    const zoom = state.map?.getZoom() || 0;
    els.stage.classList.toggle("mapx-hide-landmarks", zoom < 12.2);
  }

  function bindMapEvents() {
    const map = state.map;
    map.on("click", "x-vehicles", (event) => {
      event.preventDefault();
      const feature = event.features?.[0];
      if (feature) selectVehicle(feature.properties.id);
    });
    for (const layer of ["x-stops-minor", "x-stops-major"]) {
      map.on("click", layer, (event) => {
        event.preventDefault();
        const feature = event.features?.[0];
        if (feature) selectStop(feature.properties.key);
      });
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
    map.on("click", "x-route-line", (event) => {
      if (event.defaultPrevented) return;
      const feature = event.features?.[0];
      if (feature) selectRoute(feature.properties.routeId, { fit: false });
    });
    map.on("click", (event) => {
      if (event.defaultPrevented) return;
      const hits = map.queryRenderedFeatures(event.point, { layers: ["x-vehicles", "x-stops-minor", "x-stops-major", "x-route-line"] });
      if (!hits.length) clearSelection();
    });
    map.on("zoom", () => syncLabelVisibility());
  }

  // ════════════════════════════════════════════════════════════════════════
  // Режимы карты
  // ════════════════════════════════════════════════════════════════════════

  function renderModeButtons() {
    const modes = state.config?.modes || {};
    els.modes.querySelectorAll("[data-mapx-mode]").forEach((button) => {
      const mode = button.dataset.mapxMode;
      const available = mode === "scheme" || modes[mode]?.enabled;
      button.hidden = !available;
      button.classList.toggle("is-active", mode === state.mode);
    });
  }

  async function setMode(mode) {
    if (!state.booted || state.mode === mode) return;
    state.mode = mode;
    renderModeButtons();
    const map = state.map;
    map.setStyle(styleForMode(mode), { diff: false });
    await new Promise((resolve) => map.once("style.load", resolve));
    buildOverlayLayers();
    renderDistrictLabels(true);
    restorePulse();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Выбор: маршрут / остановка / транспорт
  // ════════════════════════════════════════════════════════════════════════

  const routeById = (id) => (state.data?.routes || []).find((route) => route.id === id) || null;
  const stopByKey = (key) => (state.data?.stops || []).find((stop) => stop.key === key) || null;

  function setRoutesSource(routeIds) {
    state.map.getSource("x-routes")?.setData({ type: "FeatureCollection", features: routeFeatures(routeIds) });
  }

  function applySelectionPaint() {
    const map = state.map;
    if (!map?.getLayer("x-route-line")) return;
    const selectedRoute = state.selection?.kind === "route" ? state.selection.id : null;

    if (!selectedRoute) {
      map.setPaintProperty("x-route-line", "line-opacity", 0.96);
      map.setPaintProperty("x-route-glow", "line-opacity", reducedMotion ? 0.18 : 0.32);
      map.setLayoutProperty("x-stops-minor", "visibility", "visible");
      map.setPaintProperty("x-vehicles", "icon-opacity", 1);
      map.setFilter("x-stops-minor", ["==", ["get", "major"], 0]);
      map.setFilter("x-stops-major", ["==", ["get", "major"], 1]);
      map.setLayerZoomRange("x-stops-minor", 12.6, 24);
      return;
    }

    // Фокус на маршруте: его остановки видны всегда, чужие скрыты
    const route = routeById(selectedRoute);
    const keys = new Set();
    for (const direction of route?.directions || []) {
      for (const key of direction.stopKeys || []) keys.add(key);
    }
    const inKeys = ["in", ["get", "key"], ["literal", [...keys]]];
    map.setFilter("x-stops-minor", ["all", ["==", ["get", "major"], 0], inKeys]);
    map.setFilter("x-stops-major", ["any", ["==", ["get", "major"], 1], inKeys]);
    map.setLayerZoomRange("x-stops-minor", 10, 24);
    map.setPaintProperty("x-vehicles", "icon-opacity", ["case", ["==", ["get", "routeId"], selectedRoute], 1, 0.15]);
  }

  function fitCity(duration = 650) {
    const bounds = cityBounds();
    if (bounds) {
      state.map.fitBounds(bounds, {
        padding: { top: 150, bottom: 190, left: 36, right: 36 },
        duration: reducedMotion ? 0 : duration,
        maxZoom: 13.5,
      });
    }
  }

  function fitRoute(route) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const direction of route.directions) {
      for (const [lng, lat] of direction.geometry) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!Number.isFinite(minLng)) return;
    state.map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: { top: 160, bottom: 230, left: 40, right: 40 },
      duration: reducedMotion ? 0 : 700,
    });
  }

  function setPulse(coord) {
    state.pulseMarker?.remove();
    state.pulseMarker = null;
    if (!coord) return;
    const el = document.createElement("div");
    el.className = "mapx-pulse";
    el.innerHTML = "<i></i><i></i><b></b>";
    state.pulseMarker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(coord).addTo(state.map);
  }

  function restorePulse() {
    if (state.selection?.kind === "stop") {
      const stop = stopByKey(state.selection.id);
      if (stop) setPulse([stop.lng, stop.lat]);
    }
  }

  function selectRoute(routeId, options = {}) {
    const route = routeById(routeId);
    if (!route) return;
    state.selection = { kind: "route", id: routeId, directionCode: options.directionCode || route.directions[0]?.code || "" };
    setPulse(null);
    setRoutesSource([routeId]);
    applySelectionPaint();
    if (options.fit !== false) fitRoute(route);
    renderRouteScroller();
    renderCard();
    refreshVehicles(true);
  }

  function selectStop(stopKey) {
    const stop = stopByKey(stopKey);
    if (!stop) return;
    state.selection = { kind: "stop", id: stopKey };
    setRoutesSource(state.representatives);
    applySelectionPaint();
    setPulse([stop.lng, stop.lat]);
    state.map.flyTo({
      center: [stop.lng, stop.lat],
      zoom: Math.max(13.6, state.map.getZoom()),
      duration: reducedMotion ? 0 : 550,
      offset: [0, -60],
    });
    renderRouteScroller();
    renderCard();
  }

  function selectVehicle(vehicleId) {
    const vehicle = state.vehicles.get(vehicleId);
    if (!vehicle) return;
    state.selection = { kind: "vehicle", id: vehicleId };
    setPulse(null);
    renderCard();
  }

  function clearSelection() {
    if (!state.selection) return;
    state.selection = null;
    setPulse(null);
    setRoutesSource(state.representatives);
    applySelectionPaint();
    renderRouteScroller();
    renderCard();
    refreshVehicles(true);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Панели: статусы, режимы, лента маршрутов, карточка
  // ════════════════════════════════════════════════════════════════════════

  function renderStatusChips() {
    const demo = Boolean(state.data?.demoGeo);
    els.demoChip.hidden = !demo;
    let liveText = "";
    if (state.vehiclesStatus === "demo") liveText = "🚌 Транспорт: демо";
    else if (state.vehiclesStatus === "live") liveText = "🚌 Транспорт: онлайн";
    els.liveChip.textContent = liveText;
    els.liveChip.hidden = !liveText;
  }

  function renderRouteScroller() {
    const routes = state.data?.routes || [];
    if (!routes.length) return;
    const selectedId = state.selection?.kind === "route" ? state.selection.id : "";
    const alertIds = new Set(state.alerts.map((alert) => alert.routeId));
    const ordered = [...routes].sort((a, b) => {
      const cityFirst = Number(b.type === "городской") - Number(a.type === "городской");
      if (cityFirst) return cityFirst;
      return String(a.number).localeCompare(String(b.number), "ru", { numeric: true });
    });
    els.routes.innerHTML = [
      `<button type="button" class="mapx-route-pill mapx-route-pill--all ${selectedId ? "" : "is-active"}" data-mapx-all>Обзор</button>`,
      ...ordered.map((route) => `
        <button type="button" class="mapx-route-pill ${route.id === selectedId ? "is-active" : ""}" data-mapx-route="${escapeHtml(route.id)}" style="--rc:${escapeHtml(route.color || "#22d3ee")}">
          <b>${escapeHtml(route.number)}</b>
          <span>${escapeHtml(shortRouteName(route))}</span>
          ${alertIds.has(route.id) ? '<i title="Есть изменения движения">⚠</i>' : ""}
        </button>`),
    ].join("");
    if (selectedId) {
      els.routes.querySelector(".is-active")?.scrollIntoView({ inline: "center", block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    }
  }

  function shortRouteName(route) {
    const name = String(route.name || "");
    return name.length > 26 ? `${name.slice(0, 25)}…` : name;
  }

  function renderHint(text) {
    els.hint.textContent = text || "";
    els.hint.hidden = !text;
  }

  function renderCard() {
    const selection = state.selection;
    if (!selection) {
      els.card.hidden = true;
      els.card.innerHTML = "";
      renderHint(state.data?.demoGeo ? "Выберите маршрут — линия и остановки подсветятся" : "");
      return;
    }
    renderHint("");

    if (selection.kind === "route") {
      const route = routeById(selection.id);
      if (!route) { els.card.hidden = true; return; }
      const direction = route.directions.find((item) => item.code === selection.directionCode) || route.directions[0];
      const routeAlerts = state.alerts.filter((alert) => alert.routeId === route.id);
      const subscribed = state.subscriptions.has(route.id);
      els.card.innerHTML = `
        <div class="mapx-card-accent" style="--rc:${escapeHtml(route.color || "#22d3ee")}"></div>
        <div class="mapx-card-head">
          <span class="mapx-badge" style="--rc:${escapeHtml(route.color || "#22d3ee")}">${escapeHtml(route.number)}</span>
          <div class="mapx-card-title">
            <strong>${escapeHtml(route.name)}</strong>
            <small>${escapeHtml(route.type === "городской" ? "Городской маршрут" : route.type === "пригородный" ? "Пригородный маршрут" : "Междугородний маршрут")}${direction ? ` · ${escapeHtml(direction.name)}` : ""}</small>
          </div>
          <button type="button" class="mapx-close" data-mapx-action="close" aria-label="Закрыть">✕</button>
        </div>
        ${route.directions.length > 1 ? `
          <div class="mapx-dirs">
            ${route.directions.map((item) => `<button type="button" data-mapx-dir="${escapeHtml(item.code)}" class="${item.code === direction?.code ? "is-active" : ""}">${escapeHtml(item.name)}</button>`).join("")}
          </div>` : ""}
        ${routeAlerts.length ? `
          <div class="mapx-card-alerts">
            ${routeAlerts.map((alert) => `<div><b>⚠ ${escapeHtml(alert.typeLabel)}</b><span>${escapeHtml(alert.title)}${alert.until ? ` · ${escapeHtml(alert.until)}` : ""}</span></div>`).join("")}
          </div>` : ""}
        <div class="mapx-card-actions">
          <button type="button" class="mapx-btn-primary" data-mapx-action="schedule">Расписание</button>
          ${hasTelegram() ? `<button type="button" class="mapx-btn ${subscribed ? "is-on" : ""}" data-mapx-action="subscribe">${subscribed ? "🔔 Вы подписаны" : "Подписаться"}</button>` : ""}
          <button type="button" class="mapx-btn" data-mapx-action="report">Сообщить</button>
        </div>`;
      els.card.hidden = false;
      return;
    }

    if (selection.kind === "stop") {
      const stop = stopByKey(selection.id);
      if (!stop) { els.card.hidden = true; return; }
      const stopRoutes = (state.data?.routes || []).filter((route) => stop.routes.includes(route.number));
      els.card.innerHTML = `
        <div class="mapx-card-accent" style="--rc:#38bdf8"></div>
        <div class="mapx-card-head">
          <span class="mapx-stopdot" aria-hidden="true"></span>
          <div class="mapx-card-title">
            <strong>${escapeHtml(stop.name)}</strong>
            <small>Остановка · ${stop.routes.length} ${plural(stop.routes.length, "маршрут", "маршрута", "маршрутов")}</small>
          </div>
          <button type="button" class="mapx-close" data-mapx-action="close" aria-label="Закрыть">✕</button>
        </div>
        <div class="mapx-stop-routes">
          ${stopRoutes.slice(0, 14).map((route) => `<button type="button" data-mapx-route="${escapeHtml(route.id)}" style="--rc:${escapeHtml(route.color || "#22d3ee")}">${escapeHtml(route.number)}</button>`).join("")}
          ${stopRoutes.length > 14 ? `<span class="mapx-stop-more">ещё ${stopRoutes.length - 14}</span>` : ""}
        </div>`;
      els.card.hidden = false;
      return;
    }

    if (selection.kind === "vehicle") {
      const vehicle = state.vehicles.get(selection.id);
      const route = vehicle ? routeById(vehicle.props.routeId) : null;
      if (!vehicle || !route) { els.card.hidden = true; return; }
      els.card.innerHTML = `
        <div class="mapx-card-accent" style="--rc:${escapeHtml(route.color || "#22d3ee")}"></div>
        <div class="mapx-card-head">
          <span class="mapx-badge" style="--rc:${escapeHtml(route.color || "#22d3ee")}">${escapeHtml(route.number)}</span>
          <div class="mapx-card-title">
            <strong>${escapeHtml(vehicle.props.board || "Автобус")}</strong>
            <small>${escapeHtml(vehicle.props.directionName || route.name)}</small>
          </div>
          <button type="button" class="mapx-close" data-mapx-action="close" aria-label="Закрыть">✕</button>
        </div>
        <div class="mapx-veh-meta">
          <span>Скорость: <b>${Math.round(vehicle.props.speedKmh || 0)} км/ч</b></span>
          <span>Данные: <b>${state.vehiclesStatus === "demo" ? "демо" : "онлайн"}</b></span>
        </div>
        <div class="mapx-card-actions">
          <button type="button" class="mapx-btn-primary" data-mapx-action="focus-route" data-route="${escapeHtml(route.id)}">Показать маршрут</button>
        </div>`;
      els.card.hidden = false;
    }
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Транспорт: опрос + плавная анимация
  // ════════════════════════════════════════════════════════════════════════

  async function refreshVehicles(immediate = false) {
    if (!state.booted || document.hidden) return;
    try {
      // В обзоре запрашиваем борта только маршрутов-представителей коридоров,
      // иначе сотня демо-бортов превращает магистрали в «гирлянды».
      const routeIds = state.selection?.kind === "route"
        ? [state.selection.id]
        : state.representatives.slice(0, 40);
      const filter = routeIds.length ? `?routes=${encodeURIComponent(routeIds.join(","))}` : "";
      const response = await fetch(`/api/map/vehicles${filter}`);
      if (!response.ok) return;
      const payload = await response.json();
      state.vehiclesStatus = payload.status || "offline";
      const now = performance.now();
      const seen = new Set();
      for (const item of payload.vehicles || []) {
        seen.add(item.id);
        const existing = state.vehicles.get(item.id);
        const target = { lng: item.lng, lat: item.lat, bearing: item.bearing || 0 };
        if (existing) {
          existing.from = existing.current || existing.to;
          existing.to = target;
          existing.t0 = now;
          existing.props = item;
        } else {
          state.vehicles.set(item.id, { from: target, to: target, current: target, t0: now, props: item });
        }
      }
      for (const id of state.vehicles.keys()) {
        if (!seen.has(id)) state.vehicles.delete(id);
      }
      if (immediate) drawVehicles(1);
      renderStatusChips();
      if (state.selection?.kind === "vehicle") renderCard();
    } catch {
      // сеть вернётся — следующий опрос подхватит
    }
  }

  function lerpAngle(a, b, t) {
    let diff = ((b - a + 540) % 360) - 180;
    return a + diff * t;
  }

  function drawVehicles(forceT = null) {
    const source = state.map?.getSource("x-vehicles");
    if (!source) return;
    const now = performance.now();
    const features = [];
    for (const vehicle of state.vehicles.values()) {
      const t = forceT ?? (reducedMotion ? 1 : Math.min(1, (now - vehicle.t0) / VEHICLE_TWEEN_MS));
      const eased = t * (2 - t); // ease-out
      const current = {
        lng: vehicle.from.lng + (vehicle.to.lng - vehicle.from.lng) * eased,
        lat: vehicle.from.lat + (vehicle.to.lat - vehicle.from.lat) * eased,
        bearing: lerpAngle(vehicle.from.bearing, vehicle.to.bearing, eased),
      };
      vehicle.current = current;
      features.push({
        type: "Feature",
        properties: { id: vehicle.props.id, routeId: vehicle.props.routeId, bearing: current.bearing },
        geometry: { type: "Point", coordinates: [current.lng, current.lat] },
      });
    }
    source.setData({ type: "FeatureCollection", features });
  }

  function vehicleLoop() {
    state.rafId = null;
    if (!state.booted || document.hidden || document.body.dataset.activeView !== "map") return;
    drawVehicles();
    state.rafId = requestAnimationFrame(vehicleLoop);
  }

  function startVehicleLoop() {
    stopVehicleLoop();
    state.vehiclesTimer = window.setInterval(refreshVehicles, VEHICLES_POLL_MS);
    state.alertsTimer = window.setInterval(refreshAlerts, ALERTS_POLL_MS);
    refreshVehicles(true);
    if (!reducedMotion && !state.rafId) state.rafId = requestAnimationFrame(vehicleLoop);
  }

  function stopVehicleLoop() {
    window.clearInterval(state.vehiclesTimer);
    window.clearInterval(state.alertsTimer);
    state.vehiclesTimer = null;
    state.alertsTimer = null;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Изменения движения, подписки, поиск, deep-links
  // ════════════════════════════════════════════════════════════════════════

  async function refreshAlerts() {
    try {
      const response = await fetch("/api/map/alerts");
      if (!response.ok) return;
      const payload = await response.json();
      state.alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
      renderAlerts();
      renderRouteScroller();
      if (state.selection?.kind === "route") renderCard();
    } catch { /* не критично */ }
  }

  function renderAlerts() {
    if (!state.alerts.length) {
      els.alerts.hidden = true;
      els.alerts.innerHTML = "";
      return;
    }
    els.alerts.innerHTML = state.alerts.slice(0, 5).map((alert) => `
      <button type="button" data-mapx-route="${escapeHtml(alert.routeId)}">
        <b>⚠ ${escapeHtml(alert.routeNumber)}</b>
        <span>${escapeHtml(alert.typeLabel)}: ${escapeHtml(alert.title)}</span>
      </button>`).join("");
    els.alerts.hidden = false;
  }

  async function loadSubscriptions() {
    if (!hasTelegram()) return;
    try {
      const response = await fetch("/api/map/subscriptions", { headers: tgHeaders() });
      if (!response.ok) return;
      const payload = await response.json();
      state.subscriptions = new Set(payload.routeIds || []);
      if (state.selection?.kind === "route") renderCard();
    } catch { /* не критично */ }
  }

  async function toggleSubscription(routeId) {
    if (!hasTelegram()) {
      toast("Подписки работают в Telegram Mini App.");
      return;
    }
    const enabled = !state.subscriptions.has(routeId);
    try {
      const response = await fetch("/api/map/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", ...tgHeaders() },
        body: JSON.stringify({ routeId, enabled }),
      });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      state.subscriptions = new Set(payload.routeIds || []);
      renderCard();
      toast(enabled ? "Подписка оформлена: изменения маршрута придут в Telegram." : "Подписка отменена.");
    } catch {
      toast("Не удалось изменить подписку. Попробуйте позже.");
    }
  }

  function searchMap(query) {
    const normalized = normalize(query);
    if (!normalized) return [];
    const results = [];
    for (const route of state.data?.routes || []) {
      if (normalize(route.number).includes(normalized) || normalize(route.name).includes(normalized)) {
        results.push({ kind: "route", id: route.id, title: `Маршрут ${route.number}`, subtitle: route.name, color: route.color });
        if (results.length >= 8) return results;
      }
    }
    for (const stop of state.data?.stops || []) {
      if (stop.key.includes(normalized)) {
        results.push({ kind: "stop", id: stop.key, title: stop.name, subtitle: `Остановка · ${stop.routes.slice(0, 6).join(", ")}` });
        if (results.length >= 8) return results;
      }
    }
    for (const district of state.config?.basemap?.districts || []) {
      if (normalize(district.name).includes(normalized)) {
        results.push({ kind: "place", id: district.name, title: district.name, subtitle: "Район", coord: district.coord });
      }
    }
    return results.slice(0, 8);
  }

  function renderSearchResults(items) {
    if (!items.length) {
      els.searchResults.hidden = true;
      els.searchResults.innerHTML = "";
      return;
    }
    els.searchResults.innerHTML = items.map((item, index) => `
      <button type="button" data-mapx-search="${index}">
        ${item.kind === "route" ? `<i class="mapx-badge sm" style="--rc:${escapeHtml(item.color || "#22d3ee")}">${escapeHtml(item.title.replace("Маршрут ", ""))}</i>` : `<i class="mapx-search-ico">${item.kind === "stop" ? "🚏" : "📍"}</i>`}
        <span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.subtitle)}</small></span>
      </button>`).join("");
    els.searchResults.hidden = false;
    els.searchResults.dataset.items = JSON.stringify(items.map(({ kind, id, coord }) => ({ kind, id, coord })));
  }

  function applyDeepTarget() {
    const target = String(window.__mapDeepTarget || "");
    window.__mapDeepTarget = "";
    if (!target || target === "map") return;
    const routeMatch = target.match(/^map_route_(.+)$/);
    if (routeMatch) { selectRoute(decodeURIComponent(routeMatch[1])); return; }
    const stopMatch = target.match(/^map_stop_(.+)$/);
    if (stopMatch) selectStop(decodeURIComponent(stopMatch[1]));
  }

  // ════════════════════════════════════════════════════════════════════════
  // Блок карты в расписании (лёгкий canvas-превью)
  // ════════════════════════════════════════════════════════════════════════

  function updateScheduleBlock() {
    if (!els.scheduleBlock) return;
    const context = app()?.getScheduleContext?.();
    if (!context?.routeId) {
      els.scheduleBlock.hidden = true;
      return;
    }
    loadAllData()
      .then(({ data }) => {
        const route = (data.routes || []).find((item) => item.id === context.routeId);
        const direction = route?.directions.find((item) => item.code === context.directionCode) || route?.directions[0];
        if (!route || !direction) {
          els.scheduleBlock.hidden = true;
          return;
        }
        const contextKey = `${route.id}:${direction.code}:${context.stopName}`;
        els.scheduleBlock.hidden = false;
        els.scheduleTitle.textContent = `Маршрут ${route.number} · ${direction.name}`;
        if (contextKey !== state.lastScheduleContextKey) {
          state.lastScheduleContextKey = contextKey;
          drawSchedulePreview(route, direction, context.stopName);
        }
      })
      .catch(() => { els.scheduleBlock.hidden = true; });
  }

  function drawSchedulePreview(route, direction, stopName) {
    const canvas = els.schedulePreview;
    const ctx = canvas?.getContext?.("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    const points = direction.geometry;
    if (!points || points.length < 2) return;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const [lng, lat] of points) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    const pad = 22;
    const spanLng = Math.max(1e-6, maxLng - minLng);
    const spanLat = Math.max(1e-6, maxLat - minLat);
    const scale = Math.min((width - pad * 2) / spanLng, (height - pad * 2) / spanLat);
    const offsetX = (width - spanLng * scale) / 2;
    const offsetY = (height - spanLat * scale) / 2;
    const toXY = ([lng, lat]) => [offsetX + (lng - minLng) * scale, height - (offsetY + (lat - minLat) * scale)];

    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = route.color || "#0f766e";
    ctx.beginPath();
    points.forEach((point, index) => {
      const [x, y] = toXY(point);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const normalizedStop = normalize(stopName);
    const stopsByKey = new Map((state.data?.stops || []).map((stop) => [stop.key, stop]));
    for (const key of direction.stopKeys || []) {
      const stop = stopsByKey.get(key);
      if (!stop) continue;
      const [x, y] = toXY([stop.lng, stop.lat]);
      const isCurrent = normalizedStop && key === normalizedStop;
      ctx.beginPath();
      ctx.arc(x, y, isCurrent ? 7 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isCurrent ? (route.color || "#0f766e") : "#ffffff";
      ctx.fill();
      ctx.lineWidth = isCurrent ? 3 : 1.5;
      ctx.strokeStyle = isCurrent ? "#ffffff" : "#475569";
      ctx.stroke();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Активация экрана и события UI
  // ════════════════════════════════════════════════════════════════════════

  function onViewChange(activeView) {
    if (activeView === "map") {
      if (state.booted) {
        state.map.resize();
        startVehicleLoop();
        applyDeepTarget();
      } else {
        bootMap();
      }
    } else {
      stopVehicleLoop();
    }
    if (activeView === "schedule") updateScheduleBlock();
  }

  new MutationObserver(() => onViewChange(document.body.dataset.activeView || ""))
    .observe(document.body, { attributes: true, attributeFilter: ["data-active-view"] });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopVehicleLoop();
    else if (document.body.dataset.activeView === "map" && state.booted) startVehicleLoop();
  });

  window.setInterval(() => {
    if (document.body.dataset.activeView === "schedule") updateScheduleBlock();
  }, 2000);

  // Режимы
  els.modes?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mapx-mode]");
    if (button) setMode(button.dataset.mapxMode);
  });

  // FAB
  els.fabZoomIn?.addEventListener("click", () => state.map?.zoomIn({ duration: reducedMotion ? 0 : 200 }));
  els.fabZoomOut?.addEventListener("click", () => state.map?.zoomOut({ duration: reducedMotion ? 0 : 200 }));
  els.fabFit?.addEventListener("click", () => { clearSelection(); fitCity(); });
  els.fabLocate?.addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Геолокация не поддерживается."); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coord = [position.coords.longitude, position.coords.latitude];
        setPulse(coord);
        state.map?.flyTo({ center: coord, zoom: 14.5, duration: reducedMotion ? 0 : 700 });
      },
      () => toast("Не удалось определить местоположение.")
    );
  });

  // Делегирование кликов по панелям
  els.view.addEventListener("click", (event) => {
    const allButton = event.target.closest("[data-mapx-all]");
    if (allButton) { clearSelection(); fitCity(); return; }

    const routeButton = event.target.closest("[data-mapx-route]");
    if (routeButton) {
      const routeId = routeButton.dataset.mapxRoute;
      if (state.selection?.kind === "route" && state.selection.id === routeId) clearSelection();
      else selectRoute(routeId);
      return;
    }

    const dirButton = event.target.closest("[data-mapx-dir]");
    if (dirButton && state.selection?.kind === "route") {
      state.selection.directionCode = dirButton.dataset.mapxDir;
      renderCard();
      return;
    }

    const searchButton = event.target.closest("[data-mapx-search]");
    if (searchButton) {
      const items = JSON.parse(els.searchResults.dataset.items || "[]");
      const item = items[Number(searchButton.dataset.mapxSearch)];
      els.searchResults.hidden = true;
      els.search.value = "";
      els.search.blur();
      if (!item) return;
      if (item.kind === "route") selectRoute(item.id);
      else if (item.kind === "stop") selectStop(item.id);
      else if (item.coord) {
        setPulse(item.coord);
        state.map?.flyTo({ center: item.coord, zoom: 13.5, duration: reducedMotion ? 0 : 650 });
      }
      return;
    }

    const actionButton = event.target.closest("[data-mapx-action]");
    if (actionButton) {
      const action = actionButton.dataset.mapxAction;
      if (action === "close") clearSelection();
      if (action === "schedule" && state.selection?.kind === "route") {
        const opened = app()?.openRouteById?.(state.selection.id);
        if (!opened) toast("Маршрут не найден в расписании.");
      }
      if (action === "subscribe" && state.selection?.kind === "route") toggleSubscription(state.selection.id);
      if (action === "report") app()?.setView?.("appeal");
      if (action === "focus-route") selectRoute(actionButton.dataset.route);
    }
  });

  // Поиск
  let searchTimer = null;
  els.search?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => renderSearchResults(state.data ? searchMap(els.search.value) : []), 180);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".mapx-searchwrap")) els.searchResults.hidden = true;
  });

  // Блок в расписании
  els.scheduleOpen?.addEventListener("click", () => {
    const context = app()?.getScheduleContext?.();
    if (context?.routeId) window.__mapDeepTarget = `map_route_${context.routeId}`;
    app()?.setView?.("map");
  });

  // Экран мог быть открыт до загрузки скрипта (deep-link из бота)
  if (document.body.dataset.activeView === "map") onViewChange("map");
})();
