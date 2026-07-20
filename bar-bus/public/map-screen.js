// ─────────────────────────────────────────────────────────────────────────────
// Экран «Карта» Mini App + блок карты в расписании.
//
// Отдельный модуль поверх app.js: общается с приложением только через
// window.BarBusApp (навигация, контекст расписания, initData-заголовки).
// MapLibre и данные карты загружаются лениво — при первом открытии экрана.
// Пользователь не входит в аккаунт: подписки и избранное привязываются
// к Telegram ID через x-telegram-init-data.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  "use strict";

  const VEHICLES_POLL_MS = 8000;
  const ALERTS_POLL_MS = 60000;

  const els = {
    view: document.querySelector('.view[data-view="map"]'),
    meta: document.querySelector("#mapMeta"),
    statusRow: document.querySelector("#mapStatusRow"),
    demoBadge: document.querySelector("#mapDemoBadge"),
    liveBadge: document.querySelector("#mapLiveBadge"),
    alerts: document.querySelector("#mapAlerts"),
    shell: document.querySelector("#mapShell"),
    canvas: document.querySelector("#mapCanvas"),
    loading: document.querySelector("#mapLoading"),
    empty: document.querySelector("#mapEmpty"),
    objectCard: document.querySelector("#mapObjectCard"),
    zoomIn: document.querySelector("#mapZoomIn"),
    zoomOut: document.querySelector("#mapZoomOut"),
    locate: document.querySelector("#mapLocate"),
    fitAll: document.querySelector("#mapFitAll"),
    search: document.querySelector("#mapSearch"),
    searchResults: document.querySelector("#mapSearchResults"),
    routeList: document.querySelector("#mapRouteList"),
    scheduleBlock: document.querySelector("#scheduleMapBlock"),
    scheduleTitle: document.querySelector("#scheduleMapTitle"),
    scheduleOpen: document.querySelector("#scheduleMapOpen"),
    schedulePreview: document.querySelector("#scheduleMapPreview")
  };

  if (!els.view || !els.canvas) return;

  const state = {
    booted: false,
    booting: false,
    map: null,
    data: null,
    dataPromise: null,
    alerts: [],
    subscriptions: new Set(),
    selectedRouteId: "",
    selectedDirectionCode: "",
    selectedStopKey: "",
    vehiclesTimer: null,
    alertsTimer: null,
    vehiclesStatus: "offline",
    lastScheduleContextKey: ""
  };

  const app = () => window.BarBusApp || null;
  const tgHeaders = () => (app()?.telegramHeaders ? app().telegramHeaders() : {});
  const hasTelegram = () => Boolean(app()?.hasTelegram?.());
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function isDarkTheme() {
    return document.documentElement.dataset.theme === "dark";
  }

  // ── Загрузка данных и MapLibre ─────────────────────────────────────────────

  function loadMapData(force = false) {
    if (state.dataPromise && !force) return state.dataPromise;
    state.dataPromise = fetch("/api/map/data")
      .then((response) => {
        if (!response.ok) throw new Error("Не удалось загрузить данные карты.");
        return response.json();
      })
      .then((data) => {
        state.data = data;
        return data;
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

  // ── Построение карты ───────────────────────────────────────────────────────

  function palette() {
    const dark = isDarkTheme();
    return {
      bg: dark ? "#0e131f" : "#eef1f6",
      stopFill: dark ? "#101828" : "#ffffff",
      stopStroke: dark ? "#cbd5e1" : "#334155",
      dimOpacity: 0.16
    };
  }

  function routesGeoJson() {
    return {
      type: "FeatureCollection",
      features: (state.data?.routes || []).flatMap((route) =>
        route.directions.map((direction) => ({
          type: "Feature",
          properties: { routeId: route.id, direction: direction.code, number: route.number, color: route.color || "#2563eb" },
          geometry: { type: "LineString", coordinates: direction.geometry }
        }))
      )
    };
  }

  function stopsGeoJson() {
    return {
      type: "FeatureCollection",
      features: (state.data?.stops || []).map((stop) => ({
        type: "Feature",
        properties: { key: stop.key, name: stop.name, routes: stop.routes.join(", ") },
        geometry: { type: "Point", coordinates: [stop.lng, stop.lat] }
      }))
    };
  }

  function allBounds() {
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

  function busIconImage(color) {
    const size = 44;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.translate(size / 2, size / 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(8, 7);
    ctx.quadraticCurveTo(0, 2.5, -8, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  function ensureBusIcons() {
    for (const route of state.data?.routes || []) {
      const name = `bus-${route.id}`;
      if (!state.map.hasImage(name)) {
        state.map.addImage(name, busIconImage(route.color || "#2563eb"), { pixelRatio: 2 });
      }
    }
  }

  async function bootMap() {
    if (state.booted || state.booting) return;
    state.booting = true;
    els.loading.hidden = false;
    try {
      const [data] = await Promise.all([loadMapData(), loadMapLibre()]);
      if (!data.routes.length) {
        els.loading.hidden = true;
        els.empty.hidden = false;
        state.booting = false;
        renderStatusBadges();
        return;
      }

      const colors = palette();
      state.map = new maplibregl.Map({
        container: els.canvas,
        style: {
          version: 8,
          sources: {},
          layers: [{ id: "bg", type: "background", paint: { "background-color": colors.bg } }]
        },
        center: [data.city.lng, data.city.lat],
        zoom: 11.5,
        minZoom: 8,
        maxZoom: 16.5,
        attributionControl: false,
        fadeDuration: 0
      });

      await new Promise((resolve) => state.map.once("load", resolve));
      buildLayers();
      bindMapEvents();
      // Контейнер мог иметь нулевую высоту в момент создания карты
      // (анимация переключения view) — принудительно пересчитываем размер
      // сейчас и при каждом изменении габаритов контейнера.
      state.map.resize();
      new ResizeObserver(() => state.map?.resize()).observe(els.canvas);
      const bounds = allBounds();
      if (bounds) state.map.fitBounds(bounds, { padding: 32, duration: 0 });

      state.booted = true;
      els.loading.hidden = true;
      renderStatusBadges();
      renderRouteList();
      applyDeepTarget();
      refreshAlerts();
      loadSubscriptions();
    } catch (error) {
      console.warn("Map boot failed", error);
      els.loading.hidden = true;
      els.empty.hidden = false;
      els.empty.querySelector("p").textContent = error.message || "Не удалось загрузить карту. Попробуйте позже.";
    } finally {
      state.booting = false;
    }
  }

  function buildLayers() {
    const map = state.map;
    const colors = palette();

    map.addSource("routes", { type: "geojson", data: routesGeoJson() });
    map.addSource("stops", { type: "geojson", data: stopsGeoJson() });
    map.addSource("vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": isDarkTheme() ? "#0a0f1a" : "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 9],
        "line-opacity": 0.9
      }
    });
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 15, 6],
        "line-opacity": 0.95
      }
    });
    map.addLayer({
      id: "stops",
      type: "circle",
      source: "stops",
      minzoom: 10.2,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10.2, 2.5, 15, 6.5],
        "circle-color": colors.stopFill,
        "circle-stroke-color": colors.stopStroke,
        "circle-stroke-width": 1.6
      }
    });
    ensureBusIcons();
    map.addLayer({
      id: "vehicles",
      type: "symbol",
      source: "vehicles",
      layout: {
        "icon-image": ["concat", "bus-", ["get", "routeId"]],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 15, 1],
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true
      }
    });
  }

  function bindMapEvents() {
    const map = state.map;

    map.on("click", "stops", (event) => {
      event.preventDefault();
      const feature = event.features?.[0];
      if (feature) selectStop(feature.properties.key);
    });
    map.on("click", "route-line", (event) => {
      if (event.defaultPrevented) return;
      const feature = event.features?.[0];
      if (feature) selectRoute(feature.properties.routeId, { fit: false });
    });
    map.on("click", (event) => {
      if (event.defaultPrevented) return;
      const hits = map.queryRenderedFeatures(event.point, { layers: ["stops", "route-line"] });
      if (!hits.length) clearSelection();
    });
    for (const layer of ["stops", "route-line"]) {
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
  }

  // ── Выбор объектов ─────────────────────────────────────────────────────────

  function routeById(routeId) {
    return (state.data?.routes || []).find((route) => route.id === routeId) || null;
  }

  function stopByKey(key) {
    return (state.data?.stops || []).find((stop) => stop.key === key) || null;
  }

  function applySelectionPaint() {
    if (!state.booted) return;
    const map = state.map;
    const selected = state.selectedRouteId;
    if (!selected) {
      map.setPaintProperty("route-line", "line-opacity", 0.95);
      map.setPaintProperty("stops", "circle-opacity", 1);
      map.setPaintProperty("stops", "circle-stroke-opacity", 1);
      map.setPaintProperty("vehicles", "icon-opacity", 1);
      return;
    }
    const colors = palette();
    const match = ["==", ["get", "routeId"], selected];
    map.setPaintProperty("route-line", "line-opacity", ["case", match, 1, colors.dimOpacity]);
    const route = routeById(selected);
    const stopKeys = new Set();
    for (const direction of route?.directions || []) {
      for (const key of direction.stopKeys || []) stopKeys.add(key);
    }
    const stopMatch = ["in", ["get", "key"], ["literal", [...stopKeys]]];
    map.setPaintProperty("stops", "circle-opacity", ["case", stopMatch, 1, 0.25]);
    map.setPaintProperty("stops", "circle-stroke-opacity", ["case", stopMatch, 1, 0.25]);
    map.setPaintProperty("vehicles", "icon-opacity", ["case", match, 1, 0.2]);
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
      padding: { top: 40, bottom: 120, left: 32, right: 32 },
      duration: reducedMotion ? 0 : 650
    });
  }

  function selectRoute(routeId, options = {}) {
    const route = routeById(routeId);
    if (!route) return;
    state.selectedRouteId = routeId;
    state.selectedStopKey = "";
    state.selectedDirectionCode = options.directionCode || route.directions[0]?.code || "";
    applySelectionPaint();
    if (options.fit !== false) fitRoute(route);
    renderRouteList();
    renderObjectCard();
    refreshVehicles(true);
  }

  function selectStop(stopKey) {
    const stop = stopByKey(stopKey);
    if (!stop) return;
    state.selectedStopKey = stopKey;
    state.selectedRouteId = "";
    applySelectionPaint();
    state.map.flyTo({
      center: [stop.lng, stop.lat],
      zoom: Math.max(13.2, state.map.getZoom()),
      duration: reducedMotion ? 0 : 550
    });
    renderRouteList();
    renderObjectCard();
  }

  function clearSelection() {
    if (!state.selectedRouteId && !state.selectedStopKey) return;
    state.selectedRouteId = "";
    state.selectedStopKey = "";
    applySelectionPaint();
    renderRouteList();
    renderObjectCard();
    refreshVehicles(true);
  }

  // ── Карточка объекта ───────────────────────────────────────────────────────

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  function renderObjectCard() {
    const card = els.objectCard;
    const route = state.selectedRouteId ? routeById(state.selectedRouteId) : null;
    const stop = state.selectedStopKey ? stopByKey(state.selectedStopKey) : null;

    if (!route && !stop) {
      card.hidden = true;
      card.innerHTML = "";
      return;
    }

    if (route) {
      const direction = route.directions.find((item) => item.code === state.selectedDirectionCode) || route.directions[0];
      const routeAlerts = state.alerts.filter((alert) => alert.routeId === route.id);
      const subscribed = state.subscriptions.has(route.id);
      card.innerHTML = `
        <div class="map-card-head">
          <span class="map-route-badge" style="--route-color:${escapeHtml(route.color || "#2563eb")}">${escapeHtml(route.number)}</span>
          <div class="map-card-title">
            <strong>${escapeHtml(route.name)}</strong>
            <small>${escapeHtml(direction?.name || "")}</small>
          </div>
          <button type="button" class="map-card-close" data-map-action="close" aria-label="Закрыть">✕</button>
        </div>
        ${route.directions.length > 1 ? `
          <div class="map-direction-chips">
            ${route.directions.map((item) => `
              <button type="button" data-map-direction="${escapeHtml(item.code)}" class="${item.code === direction?.code ? "is-active" : ""}">${escapeHtml(item.name)}</button>
            `).join("")}
          </div>` : ""}
        ${routeAlerts.length ? `
          <div class="map-card-alerts">
            ${routeAlerts.map((alert) => `
              <div class="map-card-alert">
                <strong>⚠ ${escapeHtml(alert.typeLabel)}</strong>
                <span>${escapeHtml(alert.title)}${alert.until ? ` · ${escapeHtml(alert.until)}` : ""}</span>
              </div>`).join("")}
          </div>` : ""}
        <div class="map-card-actions">
          <button type="button" class="map-card-primary" data-map-action="schedule">Расписание</button>
          ${hasTelegram() ? `
            <button type="button" class="map-card-secondary ${subscribed ? "is-on" : ""}" data-map-action="subscribe">
              ${subscribed ? "🔔 Вы подписаны" : "🔕 Подписаться на изменения"}
            </button>` : ""}
          <button type="button" class="map-card-secondary" data-map-action="report">Сообщить о проблеме</button>
        </div>`;
      card.hidden = false;
      return;
    }

    const stopRoutes = (state.data?.routes || []).filter((item) => stop.routes.includes(item.number));
    card.innerHTML = `
      <div class="map-card-head">
        <span class="map-stop-dot" aria-hidden="true"></span>
        <div class="map-card-title">
          <strong>${escapeHtml(stop.name)}</strong>
          <small>Остановка · маршруты: ${escapeHtml(stop.routes.join(", ") || "—")}</small>
        </div>
        <button type="button" class="map-card-close" data-map-action="close" aria-label="Закрыть">✕</button>
      </div>
      ${stopRoutes.length ? `
        <div class="map-card-stop-routes">
          ${stopRoutes.map((item) => `
            <button type="button" data-map-route="${escapeHtml(item.id)}" class="map-route-chip" style="--route-color:${escapeHtml(item.color || "#2563eb")}">${escapeHtml(item.number)}</button>
          `).join("")}
        </div>` : ""}`;
    card.hidden = false;
  }

  // ── Список маршрутов и поиск ───────────────────────────────────────────────

  function renderRouteList() {
    if (!els.routeList || !state.data) return;
    const alertRouteIds = new Set(state.alerts.map((alert) => alert.routeId));
    els.routeList.innerHTML = (state.data.routes || []).slice(0, 60).map((route) => `
      <button type="button" class="map-route-item ${route.id === state.selectedRouteId ? "is-active" : ""}" data-map-route="${escapeHtml(route.id)}">
        <span class="map-route-badge" style="--route-color:${escapeHtml(route.color || "#2563eb")}">${escapeHtml(route.number)}</span>
        <span class="map-route-name">${escapeHtml(route.name)}</span>
        ${alertRouteIds.has(route.id) ? '<span class="map-route-warn" title="Есть изменения движения">⚠</span>' : ""}
      </button>`).join("");
  }

  function searchMap(query) {
    const normalized = query.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    if (normalized.length < 1) return [];
    const results = [];
    for (const route of state.data?.routes || []) {
      if (route.number.toLocaleLowerCase("ru-RU").includes(normalized) || route.name.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").includes(normalized)) {
        results.push({ kind: "route", id: route.id, title: `Маршрут ${route.number}`, subtitle: route.name, color: route.color });
      }
      if (results.length >= 8) return results;
    }
    for (const stop of state.data?.stops || []) {
      if (stop.key.includes(normalized)) {
        results.push({ kind: "stop", id: stop.key, title: stop.name, subtitle: `Остановка · ${stop.routes.join(", ")}` });
      }
      if (results.length >= 8) break;
    }
    return results;
  }

  function renderSearchResults(items) {
    if (!items.length) {
      els.searchResults.hidden = true;
      els.searchResults.innerHTML = "";
      return;
    }
    els.searchResults.innerHTML = items.map((item) => `
      <button type="button" data-map-search-kind="${item.kind}" data-map-search-id="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.subtitle)}</small>
      </button>`).join("");
    els.searchResults.hidden = false;
  }

  // ── Статусы, транспорт, изменения ──────────────────────────────────────────

  function renderStatusBadges() {
    const demo = Boolean(state.data?.demoGeo);
    els.demoBadge.hidden = !demo;
    let liveText = "";
    if (state.vehiclesStatus === "demo") liveText = "Транспорт: демо-данные";
    else if (state.vehiclesStatus === "live") liveText = "Транспорт: онлайн";
    els.liveBadge.textContent = liveText;
    els.liveBadge.hidden = !liveText;
    els.statusRow.hidden = els.demoBadge.hidden && els.liveBadge.hidden;
  }

  async function refreshVehicles(immediate = false) {
    if (!state.booted || document.hidden) return;
    try {
      const filter = state.selectedRouteId ? `?routes=${encodeURIComponent(state.selectedRouteId)}` : "";
      const response = await fetch(`/api/map/vehicles${filter}`);
      if (!response.ok) return;
      const data = await response.json();
      state.vehiclesStatus = data.status || "offline";
      const source = state.map.getSource("vehicles");
      if (source) {
        source.setData({
          type: "FeatureCollection",
          features: (data.vehicles || []).map((vehicle) => ({
            type: "Feature",
            properties: { routeId: vehicle.routeId, bearing: vehicle.bearing || 0 },
            geometry: { type: "Point", coordinates: [vehicle.lng, vehicle.lat] }
          }))
        });
      }
      renderStatusBadges();
    } catch {
      // сеть могла пропасть — просто дождёмся следующего опроса
    }
  }

  async function refreshAlerts() {
    try {
      const response = await fetch("/api/map/alerts");
      if (!response.ok) return;
      const data = await response.json();
      state.alerts = Array.isArray(data.alerts) ? data.alerts : [];
      renderAlerts();
      renderRouteList();
      if (state.selectedRouteId) renderObjectCard();
    } catch {
      // не критично
    }
  }

  function renderAlerts() {
    if (!state.alerts.length) {
      els.alerts.hidden = true;
      els.alerts.innerHTML = "";
      return;
    }
    els.alerts.innerHTML = state.alerts.slice(0, 6).map((alert) => `
      <button type="button" class="map-alert-chip" data-map-route="${escapeHtml(alert.routeId)}">
        <strong>⚠ ${escapeHtml(alert.routeNumber)}</strong>
        <span>${escapeHtml(alert.typeLabel)}: ${escapeHtml(alert.title)}</span>
      </button>`).join("");
    els.alerts.hidden = false;
  }

  // ── Подписки на изменения маршрутов ────────────────────────────────────────

  async function loadSubscriptions() {
    if (!hasTelegram()) return;
    try {
      const response = await fetch("/api/map/subscriptions", { headers: tgHeaders() });
      if (!response.ok) return;
      const data = await response.json();
      state.subscriptions = new Set(Array.isArray(data.routeIds) ? data.routeIds : []);
      if (state.selectedRouteId) renderObjectCard();
    } catch {
      // подписки не критичны для карты
    }
  }

  async function toggleSubscription(routeId) {
    if (!hasTelegram()) {
      app()?.showToast?.("Подписки работают в Telegram Mini App.");
      return;
    }
    const enabled = !state.subscriptions.has(routeId);
    try {
      const response = await fetch("/api/map/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", ...tgHeaders() },
        body: JSON.stringify({ routeId, enabled })
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      state.subscriptions = new Set(data.routeIds || []);
      renderObjectCard();
      app()?.showToast?.(enabled
        ? "Подписка оформлена. Изменения маршрута придут в Telegram."
        : "Подписка отменена.");
    } catch {
      app()?.showToast?.("Не удалось изменить подписку. Попробуйте позже.");
    }
  }

  // ── Deep-links из бота ─────────────────────────────────────────────────────

  function applyDeepTarget() {
    const target = String(window.__mapDeepTarget || "");
    window.__mapDeepTarget = "";
    if (!target || target === "map") return;
    const routeMatch = target.match(/^map_route_(.+)$/);
    if (routeMatch) {
      selectRoute(decodeURIComponent(routeMatch[1]));
      return;
    }
    const stopMatch = target.match(/^map_stop_(.+)$/);
    if (stopMatch) selectStop(decodeURIComponent(stopMatch[1]));
  }

  // ── Блок карты в расписании ────────────────────────────────────────────────

  function updateScheduleBlock() {
    if (!els.scheduleBlock) return;
    const context = app()?.getScheduleContext?.();
    if (!context?.routeId) {
      els.scheduleBlock.hidden = true;
      return;
    }
    loadMapData()
      .then((data) => {
        const route = (data.routes || []).find((item) => item.id === context.routeId);
        const direction = route?.directions.find((item) => item.code === context.directionCode) || route?.directions[0];
        if (!route || !direction) {
          els.scheduleBlock.hidden = true;
          return;
        }
        const contextKey = `${route.id}:${direction.code}:${context.stopName}:${isDarkTheme()}`;
        els.scheduleBlock.hidden = false;
        els.scheduleTitle.textContent = `Маршрут ${route.number} · ${direction.name}`;
        if (contextKey !== state.lastScheduleContextKey) {
          state.lastScheduleContextKey = contextKey;
          drawSchedulePreview(route, direction, context.stopName);
        }
      })
      .catch(() => {
        els.scheduleBlock.hidden = true;
      });
  }

  // Лёгкий 2D-превью маршрута (без MapLibre): линия, остановки и выбранная точка.
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
    const toXY = ([lng, lat]) => [
      offsetX + (lng - minLng) * scale,
      height - (offsetY + (lat - minLat) * scale)
    ];

    const dark = isDarkTheme();
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = route.color || "#2563eb";
    ctx.beginPath();
    points.forEach((point, index) => {
      const [x, y] = toXY(point);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Остановки направления
    const normalizedStop = String(stopName || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
    const stopsByKey = new Map((state.data?.stops || []).map((stop) => [stop.key, stop]));
    for (const key of direction.stopKeys || []) {
      const stop = stopsByKey.get(key);
      if (!stop) continue;
      const [x, y] = toXY([stop.lng, stop.lat]);
      const isCurrent = normalizedStop && key === normalizedStop;
      ctx.beginPath();
      ctx.arc(x, y, isCurrent ? 7 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isCurrent ? (route.color || "#2563eb") : (dark ? "#101828" : "#ffffff");
      ctx.fill();
      ctx.lineWidth = isCurrent ? 3 : 1.5;
      ctx.strokeStyle = isCurrent ? (dark ? "#e2e8f0" : "#ffffff") : (dark ? "#94a3b8" : "#475569");
      ctx.stroke();
    }
  }

  // ── Активация экрана ───────────────────────────────────────────────────────

  function startPolling() {
    stopPolling();
    state.vehiclesTimer = window.setInterval(refreshVehicles, VEHICLES_POLL_MS);
    state.alertsTimer = window.setInterval(refreshAlerts, ALERTS_POLL_MS);
    refreshVehicles(true);
  }

  function stopPolling() {
    window.clearInterval(state.vehiclesTimer);
    window.clearInterval(state.alertsTimer);
    state.vehiclesTimer = null;
    state.alertsTimer = null;
  }

  function onViewChange(activeView) {
    if (activeView === "map") {
      if (state.booted) {
        state.map.resize();
        startPolling();
        applyDeepTarget();
      } else {
        bootMap().then(() => {
          if (state.booted) startPolling();
        });
      }
    } else {
      stopPolling();
    }
    if (activeView === "schedule") updateScheduleBlock();
  }

  const viewObserver = new MutationObserver(() => {
    onViewChange(document.body.dataset.activeView || "");
  });
  viewObserver.observe(document.body, { attributes: true, attributeFilter: ["data-active-view"] });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else if (document.body.dataset.activeView === "map" && state.booted) startPolling();
  });

  // Смена маршрута/направления в расписании: обновляем превью, пока экран открыт.
  window.setInterval(() => {
    if (document.body.dataset.activeView === "schedule") updateScheduleBlock();
  }, 2000);

  // ── События UI ─────────────────────────────────────────────────────────────

  els.zoomIn?.addEventListener("click", () => state.map?.zoomIn({ duration: reducedMotion ? 0 : 200 }));
  els.zoomOut?.addEventListener("click", () => state.map?.zoomOut({ duration: reducedMotion ? 0 : 200 }));
  els.fitAll?.addEventListener("click", () => {
    clearSelection();
    const bounds = allBounds();
    if (bounds) state.map?.fitBounds(bounds, { padding: 32, duration: reducedMotion ? 0 : 650 });
  });
  els.locate?.addEventListener("click", () => {
    if (!navigator.geolocation) {
      app()?.showToast?.("Геолокация не поддерживается.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.map?.flyTo({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: 14,
          duration: reducedMotion ? 0 : 700
        });
      },
      () => app()?.showToast?.("Не удалось определить местоположение.")
    );
  });

  els.view.addEventListener("click", (event) => {
    const routeButton = event.target.closest("[data-map-route]");
    if (routeButton) {
      const routeId = routeButton.dataset.mapRoute;
      if (routeId === state.selectedRouteId) clearSelection();
      else selectRoute(routeId);
      return;
    }
    const directionButton = event.target.closest("[data-map-direction]");
    if (directionButton) {
      state.selectedDirectionCode = directionButton.dataset.mapDirection;
      renderObjectCard();
      return;
    }
    const actionButton = event.target.closest("[data-map-action]");
    if (actionButton) {
      const action = actionButton.dataset.mapAction;
      if (action === "close") clearSelection();
      if (action === "schedule" && state.selectedRouteId) {
        const opened = app()?.openRouteById?.(state.selectedRouteId);
        if (!opened) app()?.showToast?.("Маршрут не найден в расписании.");
      }
      if (action === "subscribe" && state.selectedRouteId) toggleSubscription(state.selectedRouteId);
      if (action === "report") app()?.setView?.("appeal");
      return;
    }
    const searchItem = event.target.closest("[data-map-search-id]");
    if (searchItem) {
      els.searchResults.hidden = true;
      els.search.value = "";
      if (searchItem.dataset.mapSearchKind === "route") selectRoute(searchItem.dataset.mapSearchId);
      else selectStop(searchItem.dataset.mapSearchId);
    }
  });

  let searchTimer = null;
  els.search?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      renderSearchResults(state.data ? searchMap(els.search.value) : []);
    }, 180);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".map-search-row")) els.searchResults.hidden = true;
  });

  els.scheduleOpen?.addEventListener("click", () => {
    const context = app()?.getScheduleContext?.();
    if (context?.routeId) {
      window.__mapDeepTarget = `map_route_${context.routeId}`;
    }
    app()?.setView?.("map");
  });

  // Экран мог быть открыт до загрузки этого скрипта (deep-link из бота).
  if (document.body.dataset.activeView === "map") onViewChange("map");
})();
