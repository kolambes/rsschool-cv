// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «Карта» админ-панели: координаты остановок, геометрия маршрутов,
// изменения движения и демо-режим. Работает поверх admin.js через мост
// window.BarBusAdmin (api / can / setStatus) — авторизация и роли общие.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  "use strict";

  const panel = document.querySelector('[data-admin-panel="map"]');
  if (!panel) return;

  const els = {
    overview: document.querySelector("#mapAdminOverview"),
    refresh: document.querySelector("#mapAdminRefresh"),
    seedDemo: document.querySelector("#mapAdminSeedDemo"),
    clearDemo: document.querySelector("#mapAdminClearDemo"),
    demoVehicles: document.querySelector("#mapAdminDemoVehicles"),
    stopSearch: document.querySelector("#mapAdminStopSearch"),
    stopList: document.querySelector("#mapAdminStopList"),
    canvas: document.querySelector("#mapAdminCanvas"),
    canvasHint: document.querySelector("#mapAdminCanvasHint"),
    routeSelect: document.querySelector("#mapAdminRouteSelect"),
    directionSelect: document.querySelector("#mapAdminDirectionSelect"),
    buildFromStops: document.querySelector("#mapAdminBuildFromStops"),
    saveGeometry: document.querySelector("#mapAdminSaveGeometry"),
    deleteGeometry: document.querySelector("#mapAdminDeleteGeometry"),
    geometryText: document.querySelector("#mapAdminGeometryText"),
    alertRoute: document.querySelector("#mapAdminAlertRoute"),
    alertType: document.querySelector("#mapAdminAlertType"),
    alertTitle: document.querySelector("#mapAdminAlertTitle"),
    alertBody: document.querySelector("#mapAdminAlertBody"),
    alertUntil: document.querySelector("#mapAdminAlertUntil"),
    alertSave: document.querySelector("#mapAdminAlertSave"),
    alertList: document.querySelector("#mapAdminAlertList")
  };

  const state = {
    booted: false,
    map: null,
    stops: [],
    routes: [],
    alerts: [],
    selectedStopKey: "",
    stopFilter: "",
    editedGeometry: []
  };

  const bridge = () => window.BarBusAdmin || null;
  const api = (url, options) => bridge().api(url, options);
  const setStatus = (text, type) => bridge()?.setStatus?.(text, type);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  // ── Ленивая загрузка MapLibre и карта редактора ────────────────────────────

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

  async function ensureEditorMap() {
    if (state.map) return state.map;
    await loadMapLibre();
    state.map = new maplibregl.Map({
      container: els.canvas,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef1f6" } }]
      },
      center: [26.0139, 53.1327],
      zoom: 11.3,
      minZoom: 8,
      maxZoom: 17,
      attributionControl: false
    });
    await new Promise((resolve) => state.map.once("load", resolve));

    state.map.addSource("admin-stops", { type: "geojson", data: stopsGeoJson() });
    state.map.addSource("admin-geometry", { type: "geojson", data: geometryGeoJson() });
    state.map.addLayer({
      id: "admin-geometry",
      type: "line",
      source: "admin-geometry",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0f766e", "line-width": 3.5, "line-opacity": 0.85 }
    });
    state.map.addLayer({
      id: "admin-stops",
      type: "circle",
      source: "admin-stops",
      paint: {
        "circle-radius": ["case", ["get", "selected"], 8, 4.5],
        "circle-color": ["case", ["get", "selected"], "#0f766e", ["case", ["get", "demo"], "#a78bfa", "#2563eb"]],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5
      }
    });

    state.map.on("click", (event) => {
      if (state.selectedStopKey) {
        setStopCoordinates(state.selectedStopKey, event.lngLat.lat, event.lngLat.lng);
      } else {
        // без выбранной остановки клик добавляет точку в геометрию
        appendGeometryPoint(event.lngLat.lng, event.lngLat.lat);
      }
    });
    state.map.on("click", "admin-stops", (event) => {
      const feature = event.features?.[0];
      if (feature) {
        selectStop(feature.properties.key);
        event.preventDefault();
      }
    });
    return state.map;
  }

  function stopsGeoJson() {
    return {
      type: "FeatureCollection",
      features: state.stops
        .filter((stop) => Number.isFinite(stop.lat))
        .map((stop) => ({
          type: "Feature",
          properties: {
            key: stop.key,
            selected: stop.key === state.selectedStopKey,
            demo: stop.geoSource === "demo"
          },
          geometry: { type: "Point", coordinates: [stop.lng, stop.lat] }
        }))
    };
  }

  function geometryGeoJson() {
    return {
      type: "FeatureCollection",
      features: state.editedGeometry.length >= 2
        ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: state.editedGeometry } }]
        : []
    };
  }

  function refreshMapSources() {
    state.map?.getSource("admin-stops")?.setData(stopsGeoJson());
    state.map?.getSource("admin-geometry")?.setData(geometryGeoJson());
  }

  // ── Данные ─────────────────────────────────────────────────────────────────

  async function loadAll() {
    const [overview, stops, routes] = await Promise.all([
      api("/api/admin/map/overview"),
      api("/api/admin/map/stops"),
      api("/api/admin/map/routes")
    ]);
    state.stops = stops.stops || [];
    state.routes = routes.routes || [];
    state.alerts = overview.alerts || [];
    renderOverview(overview);
    renderStopList();
    renderRouteSelects();
    renderAlertList();
    els.demoVehicles.checked = Boolean(overview.demoVehicles);
    refreshMapSources();
  }

  function renderOverview(overview) {
    const coverage = overview.coverage || {};
    els.overview.innerHTML = `
      <h3>Покрытие геоданными</h3>
      <div class="map-admin-stats">
        <div><strong>${coverage.stopsWithGeo || 0} / ${coverage.stopsTotal || 0}</strong><span>остановок с координатами</span></div>
        <div><strong>${coverage.directionsWithGeometry || 0} / ${coverage.directionsTotal || 0}</strong><span>направлений с линией</span></div>
        <div><strong>${coverage.routesWithGeometry || 0} / ${coverage.routesTotal || 0}</strong><span>маршрутов на карте</span></div>
        <div><strong>${state.alerts.filter((alert) => alert.status === "active").length}</strong><span>активных изменений</span></div>
      </div>
      ${overview.demoGeo ? '<p class="map-admin-hint">⚠ Сейчас используются демо-геоданные: они схематичны и помечены на карте пользователя.</p>' : ""}`;
  }

  // ── Остановки ──────────────────────────────────────────────────────────────

  function filteredStops() {
    const query = state.stopFilter.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    let items = state.stops;
    if (query) items = items.filter((stop) => stop.key.includes(query));
    // сначала без координат — их нужно заполнить
    return [...items].sort((a, b) => Number(Number.isFinite(a.lat)) - Number(Number.isFinite(b.lat)) || a.name.localeCompare(b.name, "ru"));
  }

  function renderStopList() {
    const items = filteredStops().slice(0, 80);
    els.stopList.innerHTML = items.map((stop) => `
      <button type="button" class="map-admin-stop ${stop.key === state.selectedStopKey ? "is-active" : ""}" data-stop-key="${escapeHtml(stop.key)}">
        <span class="map-admin-stop-name">${escapeHtml(stop.name)}</span>
        <span class="map-admin-stop-meta">
          ${Number.isFinite(stop.lat) ? (stop.geoSource === "demo" ? "демо" : "✓") : "нет координат"}
          · ${stop.routeCount} маршр.
        </span>
      </button>`).join("") || '<p class="map-admin-hint">Ничего не найдено.</p>';
  }

  function selectStop(key) {
    state.selectedStopKey = state.selectedStopKey === key ? "" : key;
    renderStopList();
    refreshMapSources();
    const stop = state.stops.find((item) => item.key === state.selectedStopKey);
    if (stop && Number.isFinite(stop.lat)) {
      state.map?.flyTo({ center: [stop.lng, stop.lat], zoom: Math.max(13, state.map.getZoom()), duration: 400 });
    }
    els.canvasHint.textContent = state.selectedStopKey
      ? `Кликните по карте — остановка «${stop?.name || ""}» получит эти координаты.`
      : "Выберите остановку слева, затем кликните по карте, чтобы задать её координаты.";
  }

  async function setStopCoordinates(key, lat, lng) {
    try {
      await api("/api/admin/map/stops", {
        method: "POST",
        body: JSON.stringify({ key, lat, lng })
      });
      const stop = state.stops.find((item) => item.key === key);
      if (stop) {
        stop.lat = lat;
        stop.lng = lng;
        stop.geoSource = "admin";
      }
      renderStopList();
      refreshMapSources();
      setStatus(`Координаты остановки сохранены: ${stop?.name || key}.`, "success");
    } catch (error) {
      setStatus(error.message || "Не удалось сохранить координаты.", "error");
    }
  }

  // ── Геометрия маршрутов ────────────────────────────────────────────────────

  function renderRouteSelects() {
    const options = state.routes
      .map((route) => `<option value="${escapeHtml(route.id)}">${escapeHtml(route.number)} · ${escapeHtml(route.name)}</option>`)
      .join("");
    els.routeSelect.innerHTML = options;
    els.alertRoute.innerHTML = options;
    renderDirectionSelect();
  }

  function currentRoute() {
    return state.routes.find((route) => route.id === els.routeSelect.value) || state.routes[0] || null;
  }

  function renderDirectionSelect() {
    const route = currentRoute();
    els.directionSelect.innerHTML = (route?.directions || [])
      .map((direction) => `<option value="${escapeHtml(direction.code)}">${escapeHtml(direction.name)}${direction.geometrySource ? ` (линия: ${direction.geometrySource === "demo" ? "демо" : "есть"})` : ""}</option>`)
      .join("");
    loadGeometry();
  }

  async function loadGeometry() {
    const route = currentRoute();
    const directionCode = els.directionSelect.value;
    if (!route || !directionCode) {
      state.editedGeometry = [];
      els.geometryText.value = "";
      refreshMapSources();
      return;
    }
    try {
      const data = await api(`/api/admin/map/route-geometry?routeId=${encodeURIComponent(route.id)}&directionCode=${encodeURIComponent(directionCode)}`);
      state.editedGeometry = data.geometry || [];
      els.geometryText.value = state.editedGeometry.length ? JSON.stringify(state.editedGeometry) : "";
      refreshMapSources();
    } catch (error) {
      setStatus(error.message || "Не удалось загрузить геометрию.", "error");
    }
  }

  function appendGeometryPoint(lng, lat) {
    state.editedGeometry = [...state.editedGeometry, [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]];
    els.geometryText.value = JSON.stringify(state.editedGeometry);
    refreshMapSources();
  }

  // ── Изменения движения ─────────────────────────────────────────────────────

  function renderAlertList() {
    els.alertList.innerHTML = state.alerts.map((alert) => `
      <div class="map-admin-alert ${alert.status === "archived" ? "is-archived" : ""}">
        <div class="map-admin-alert-main">
          <strong>№ ${escapeHtml(alert.routeNumber)} · ${escapeHtml(alert.typeLabel)}</strong>
          <span>${escapeHtml(alert.title)}${alert.until ? ` · ${escapeHtml(alert.until)}` : ""}</span>
          <small>${alert.status === "active" ? "Активно" : "В архиве"}${alert.notifiedAt ? " · уведомления отправлены" : ""}</small>
        </div>
        <div class="map-admin-alert-buttons">
          ${alert.status === "active"
            ? `<button type="button" class="ghost-button" data-alert-archive="${escapeHtml(alert.id)}">В архив</button>`
            : `<button type="button" class="ghost-button danger-button" data-alert-delete="${escapeHtml(alert.id)}">Удалить</button>`}
        </div>
      </div>`).join("") || '<p class="map-admin-hint">Изменений движения пока нет.</p>';
  }

  // ── События ────────────────────────────────────────────────────────────────

  els.refresh?.addEventListener("click", () => {
    loadAll().catch((error) => setStatus(error.message, "error"));
  });

  els.seedDemo?.addEventListener("click", async () => {
    try {
      const result = await api("/api/admin/map/demo-seed", { method: "POST", body: JSON.stringify({}) });
      setStatus(`Демо-геоданные созданы: направлений — ${result.seeded?.directions || 0}, остановок — ${result.seeded?.stops || 0}.`, "success");
      await loadAll();
    } catch (error) {
      setStatus(error.message || "Не удалось создать демо-геоданные.", "error");
    }
  });

  els.clearDemo?.addEventListener("click", async () => {
    const confirmed = await bridge().confirmAction("Удалить все демо-геоданные (координаты и линии с пометкой «демо»)?");
    if (!confirmed) return;
    try {
      await api("/api/admin/map/demo-seed", { method: "POST", body: JSON.stringify({ clear: true }) });
      setStatus("Демо-геоданные удалены.", "success");
      await loadAll();
    } catch (error) {
      setStatus(error.message || "Не удалось удалить демо-геоданные.", "error");
    }
  });

  els.demoVehicles?.addEventListener("change", async () => {
    try {
      await api("/api/admin/map/settings", {
        method: "POST",
        body: JSON.stringify({ demoVehicles: els.demoVehicles.checked })
      });
      setStatus(els.demoVehicles.checked ? "Демо-транспорт включён." : "Демо-транспорт выключен.", "success");
    } catch (error) {
      els.demoVehicles.checked = !els.demoVehicles.checked;
      setStatus(error.message || "Не удалось изменить настройку.", "error");
    }
  });

  els.stopSearch?.addEventListener("input", () => {
    state.stopFilter = els.stopSearch.value;
    renderStopList();
  });

  els.stopList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-stop-key]");
    if (button) selectStop(button.dataset.stopKey);
  });

  els.routeSelect?.addEventListener("change", renderDirectionSelect);
  els.directionSelect?.addEventListener("change", loadGeometry);

  els.geometryText?.addEventListener("change", () => {
    try {
      const parsed = JSON.parse(els.geometryText.value || "[]");
      if (Array.isArray(parsed)) {
        state.editedGeometry = parsed;
        refreshMapSources();
      }
    } catch {
      setStatus("Геометрия должна быть JSON-массивом [[lng, lat], …].", "error");
    }
  });

  els.buildFromStops?.addEventListener("click", () => {
    // Линия через координаты остановок направления — быстрый черновик геометрии.
    const route = currentRoute();
    const direction = route?.directions.find((item) => item.code === els.directionSelect.value);
    if (!route || !direction) return;
    const stopsByKey = new Map(state.stops.map((stop) => [stop.key, stop]));
    const points = (direction.stopKeys || [])
      .map((key) => stopsByKey.get(key))
      .filter((stop) => stop && Number.isFinite(stop.lat))
      .map((stop) => [stop.lng, stop.lat]);
    if (points.length < 2) {
      setStatus("Недостаточно остановок с координатами: сначала расставьте остановки направления.", "error");
      return;
    }
    state.editedGeometry = points;
    els.geometryText.value = JSON.stringify(points);
    refreshMapSources();
    setStatus(`Черновик линии построен по ${points.length} остановкам. Проверьте и сохраните.`, "success");
  });

  els.saveGeometry?.addEventListener("click", async () => {
    const route = currentRoute();
    if (!route) return;
    try {
      await api("/api/admin/map/route-geometry", {
        method: "POST",
        body: JSON.stringify({
          routeId: route.id,
          directionCode: els.directionSelect.value,
          geometry: state.editedGeometry
        })
      });
      setStatus("Геометрия маршрута сохранена.", "success");
      await loadAll();
    } catch (error) {
      setStatus(error.message || "Не удалось сохранить геометрию.", "error");
    }
  });

  els.deleteGeometry?.addEventListener("click", async () => {
    const route = currentRoute();
    if (!route) return;
    const confirmed = await bridge().confirmAction("Удалить линию этого направления с карты?");
    if (!confirmed) return;
    try {
      await api("/api/admin/map/route-geometry", {
        method: "POST",
        body: JSON.stringify({ routeId: route.id, directionCode: els.directionSelect.value, remove: true })
      });
      state.editedGeometry = [];
      els.geometryText.value = "";
      refreshMapSources();
      setStatus("Линия направления удалена.", "success");
      await loadAll();
    } catch (error) {
      setStatus(error.message || "Не удалось удалить линию.", "error");
    }
  });

  els.alertSave?.addEventListener("click", async () => {
    try {
      await api("/api/admin/map/alerts", {
        method: "POST",
        body: JSON.stringify({
          routeId: els.alertRoute.value,
          type: els.alertType.value,
          title: els.alertTitle.value,
          body: els.alertBody.value,
          until: els.alertUntil.value
        })
      });
      els.alertTitle.value = "";
      els.alertBody.value = "";
      els.alertUntil.value = "";
      setStatus("Изменение опубликовано, подписчики уведомлены в Telegram.", "success");
      await loadAll();
    } catch (error) {
      setStatus(error.message || "Не удалось опубликовать изменение.", "error");
    }
  });

  els.alertList?.addEventListener("click", async (event) => {
    const archiveButton = event.target.closest("[data-alert-archive]");
    const deleteButton = event.target.closest("[data-alert-delete]");
    try {
      if (archiveButton) {
        const alert = state.alerts.find((item) => item.id === archiveButton.dataset.alertArchive);
        if (alert) {
          await api("/api/admin/map/alerts", {
            method: "POST",
            body: JSON.stringify({ ...alert, id: alert.id, status: "archived", notify: false })
          });
          setStatus("Изменение перенесено в архив.", "success");
          await loadAll();
        }
      }
      if (deleteButton) {
        const confirmed = await bridge().confirmAction("Удалить запись об изменении движения?");
        if (!confirmed) return;
        await api("/api/admin/map/alerts", {
          method: "POST",
          body: JSON.stringify({ id: deleteButton.dataset.alertDelete, delete: true })
        });
        setStatus("Запись удалена.", "success");
        await loadAll();
      }
    } catch (error) {
      setStatus(error.message || "Операция не выполнена.", "error");
    }
  });

  // ── Активация вкладки ──────────────────────────────────────────────────────

  async function bootTab() {
    if (state.booted) return;
    if (!bridge()) return;
    state.booted = true;
    try {
      await Promise.all([loadAll(), ensureEditorMap()]);
      refreshMapSources();
    } catch (error) {
      state.booted = false;
      setStatus(error.message || "Не удалось загрузить данные карты.", "error");
    }
  }

  const observer = new MutationObserver(() => {
    if (panel.classList.contains("is-active")) {
      bootTab();
      state.map?.resize();
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["class"] });
  if (panel.classList.contains("is-active")) bootTab();
})();
