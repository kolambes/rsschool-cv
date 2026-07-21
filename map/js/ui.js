// Map UI Layer: панели, карточки, поиск, фильтры, модальные окна, bottom sheet.

import {
  ROUTES, STOPS, ALERTS, DISTRICTS, IS_DEMO_DATA,
  getRoute, getStop, getVehicle, routesThroughStop, alertsForRoute, routeStatusLabel,
} from './demo-data.js';
import { providerManager, getRouteGeometry } from './providers.js';
import { distanceAlongToPoint } from './geo.js';
import { DATA_STATUS_LABELS } from './config.js';
import {
  store, debounce, escapeHtml,
  isFavRoute, isFavStop, toggleFavRoute, toggleFavStop,
  isSubscribed, toggleSubscription, addAppeal,
} from './state.js';

const $ = (sel) => document.querySelector(sel);

let mapCtl = null;

const VIEW_TITLES = {
  map: 'Маршруты',
  routes: 'Маршруты',
  stops: 'Остановки',
  favorites: 'Избранное',
  changes: 'Изменения движения',
  subscriptions: 'Подписки',
  appeals: 'Обращения',
  help: 'Справка',
};

// ════════════════════════════════════════════════════════════════════════════
// Прибытия (демо-оценка по позициям mock-провайдера)
// ════════════════════════════════════════════════════════════════════════════
function arrivalsForStop(stopId, limit = 4) {
  const stop = getStop(stopId);
  if (!stop) return [];
  const result = [];
  for (const route of routesThroughStop(stopId)) {
    const geom = getRouteGeometry(route.id);
    const stopDist = distanceAlongToPoint(geom.coords, geom.cum, stop.coord);
    let bestMin = null;
    for (const p of providerManager.positions) {
      if (p.routeId !== route.id) continue;
      const speedMs = Math.max(4, (p.speedKmh * 1000) / 3600);
      let dist = null;
      if (p.forward && p.distanceAlong <= stopDist) dist = stopDist - p.distanceAlong;
      if (!p.forward && p.distanceAlong >= stopDist) dist = p.distanceAlong - stopDist;
      if (dist === null) continue;
      const min = Math.max(1, Math.round(dist / speedMs / 60));
      if (bestMin === null || min < bestMin) bestMin = min;
    }
    if (bestMin === null) bestMin = route.interval; // оценка по интервалу
    const endName = route.name.split('–').pop().trim();
    result.push({ route, dest: endName, minutes: bestMin });
  }
  return result.sort((a, b) => a.minutes - b.minutes).slice(0, limit);
}

function nextStopForVehicle(pos) {
  const route = getRoute(pos.routeId);
  const geom = getRouteGeometry(pos.routeId);
  if (!route || !geom) return null;
  const stopsAlong = route.stops
    .map((sid) => {
      const s = getStop(sid);
      return { stop: s, dist: distanceAlongToPoint(geom.coords, geom.cum, s.coord) };
    })
    .sort((a, b) => a.dist - b.dist);
  const ahead = pos.forward
    ? stopsAlong.filter((x) => x.dist > pos.distanceAlong + 30)
    : stopsAlong.filter((x) => x.dist < pos.distanceAlong - 30).reverse();
  if (!ahead.length) return null;
  const next = ahead[0];
  const speedMs = Math.max(4, (pos.speedKmh * 1000) / 3600);
  const meters = Math.abs(next.dist - pos.distanceAlong);
  return {
    stop: next.stop,
    minutes: Math.max(1, Math.round(meters / speedMs / 60)),
    stopsLeft: ahead.length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Тосты
// ════════════════════════════════════════════════════════════════════════════
export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast glass toast--${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 3600);
}

// ════════════════════════════════════════════════════════════════════════════
// Статусные чипы (актуальность, соединение)
// ════════════════════════════════════════════════════════════════════════════
function freshnessText() {
  const status = store.get('dataStatus');
  const last = store.get('lastUpdate');
  if (status === 'offline' || !last) return 'Данные недоступны';
  const sec = Math.max(0, Math.round((Date.now() - last) / 1000));
  const ago = sec < 5 ? 'только что' : sec < 60 ? `${sec} с назад` : `${Math.round(sec / 60)} мин назад`;
  if (status === 'stale') return `Данные устарели (${ago})`;
  return `Данные обновлены ${ago}`;
}

function renderStatusChips() {
  const status = store.get('dataStatus');
  $('#chip-freshness-text').textContent = freshnessText();
  const dot = $('#live-dot');
  dot.className = `live-dot live-dot--${status}`;
  $('#chip-freshness').title = DATA_STATUS_LABELS[status] || '';
  $('#demo-badge').hidden = status !== 'demo';
}

function renderConnection() {
  const el = $('#chip-connection-text');
  const bars = $('#signal-bars');
  let level = 4;
  let label = 'отличное';
  if (!navigator.onLine) { level = 0; label = 'нет сети'; }
  else {
    const conn = navigator.connection;
    const type = conn && conn.effectiveType;
    if (type === 'slow-2g' || type === '2g') { level = 1; label = 'слабое'; }
    else if (type === '3g') { level = 2; label = 'среднее'; }
    else if (type === '4g') { level = 4; label = 'отличное'; }
    else { level = 3; label = 'хорошее'; }
  }
  el.textContent = `Соединение: ${label}`;
  bars.dataset.level = String(level);
  if (level <= 1 && !store.get('simplified')) {
    // при слабом соединении провайдер сам переходит в редкие обновления
    providerManager.setDegraded(level === 1);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Карточки маршрутов и разделы левой панели
// ════════════════════════════════════════════════════════════════════════════
function routeCardHtml(route) {
  const vehicles = providerManager.positions.filter((p) => p.routeId === route.id).length;
  const fav = isFavRoute(route.id);
  const selected = store.get('selectedRouteId') === route.id;
  return `
    <article class="route-card${selected ? ' selected' : ''}" data-route="${route.id}" tabindex="0"
             role="button" aria-pressed="${selected}">
      <span class="route-badge" style="--rc:${route.color}">${escapeHtml(route.number)}</span>
      <div class="route-info">
        <div class="route-name">${escapeHtml(route.name)}</div>
        <div class="route-dir">${escapeHtml(route.direction)}</div>
        <div class="route-meta">
          <span class="rc-status rc-status--${route.status}">${routeStatusLabel(route.status)}</span>
          <span title="Интервал движения">⏱ ${route.interval} мин</span>
          <span title="Транспорта на линии">🚌 ${vehicles}</span>
        </div>
      </div>
      <button class="fav-btn${fav ? ' active' : ''}" data-fav-route="${route.id}"
              title="${fav ? 'Убрать из избранного' : 'В избранное'}" aria-label="Избранное">${fav ? '★' : '☆'}</button>
    </article>`;
}

function filteredRoutes() {
  const f = store.get('filter');
  return ROUTES.filter((r) => {
    if (f === 'active') return r.status === 'active';
    if (f === 'delayed') return r.status === 'delayed';
    if (f === 'changed') return r.status === 'changed';
    if (f === 'favorite') return isFavRoute(r.id);
    return true;
  });
}

function stopRowHtml(stop) {
  const routes = routesThroughStop(stop.id);
  const fav = isFavStop(stop.id);
  return `
    <article class="stop-row" data-stop="${stop.id}" tabindex="0" role="button">
      <span class="stop-dot" aria-hidden="true"></span>
      <div class="route-info">
        <div class="route-name">${escapeHtml(stop.name)}</div>
        <div class="stop-routes">${routes.map((r) => `<b style="--rc:${r.color}">${escapeHtml(r.number)}</b>`).join('')}</div>
      </div>
      <button class="fav-btn${fav ? ' active' : ''}" data-fav-stop="${stop.id}"
              title="${fav ? 'Убрать из избранного' : 'В избранное'}" aria-label="Избранное">${fav ? '★' : '☆'}</button>
    </article>`;
}

function alertHtml(a, compact = false) {
  const route = getRoute(a.routeId);
  return `
    <article class="alert-item alert--${a.type}" data-alert-route="${a.routeId}">
      <div class="alert-top">
        <span class="route-badge sm" style="--rc:${route.color}">${escapeHtml(route.number)}</span>
        <span class="alert-type">${escapeHtml(a.typeLabel)}</span>
        <span class="alert-until">${escapeHtml(a.until)}</span>
      </div>
      <div class="alert-title">${escapeHtml(a.title)}</div>
      ${compact ? '' : `<div class="alert-text">${escapeHtml(a.text)}</div>`}
    </article>`;
}

function renderPanel() {
  const view = store.get('view');
  const body = $('#panel-body');
  $('#panel-title').textContent = VIEW_TITLES[view] || 'Маршруты';
  const showRouteTools = view === 'map' || view === 'routes';
  $('#btn-filters').hidden = !showRouteTools;
  $('#panel-foot').hidden = !showRouteTools;
  if (!showRouteTools) $('#filters-row').hidden = true;

  if (view === 'map' || view === 'routes') {
    const routes = filteredRoutes();
    body.innerHTML = routes.length
      ? routes.map(routeCardHtml).join('')
      : '<p class="empty-note">Нет маршрутов по выбранному фильтру.</p>';
    return;
  }

  if (view === 'stops') {
    body.innerHTML = STOPS.map(stopRowHtml).join('');
    return;
  }

  if (view === 'favorites') {
    const favR = ROUTES.filter((r) => isFavRoute(r.id));
    const favS = STOPS.filter((s) => isFavStop(s.id));
    body.innerHTML = `
      <h4 class="sub-h">Маршруты</h4>
      ${favR.length ? favR.map(routeCardHtml).join('') : '<p class="empty-note">Добавьте маршруты в избранное — они появятся здесь.</p>'}
      <h4 class="sub-h">Остановки</h4>
      ${favS.length ? favS.map(stopRowHtml).join('') : '<p class="empty-note">Избранных остановок пока нет.</p>'}`;
    return;
  }

  if (view === 'changes') {
    body.innerHTML = ALERTS.map((a) => alertHtml(a)).join('');
    return;
  }

  if (view === 'subscriptions') {
    body.innerHTML = `
      <p class="hint-note">Подписка на изменения маршрута: уведомления придут в Telegram после подключения бота. Сейчас подписки сохраняются локально (демо).</p>
      ${ROUTES.map((r) => {
        const on = isSubscribed(r.id);
        return `
        <article class="sub-row" data-sub-route="${r.id}">
          <span class="route-badge sm" style="--rc:${r.color}">${escapeHtml(r.number)}</span>
          <div class="route-info"><div class="route-name">${escapeHtml(r.name)}</div></div>
          <label class="rail-simple sub-switch"><input type="checkbox" data-sub="${r.id}" ${on ? 'checked' : ''}><span class="switch"></span></label>
        </article>`;
      }).join('')}`;
    return;
  }

  if (view === 'appeals') {
    const appeals = store.get('appeals');
    body.innerHTML = `
      <button class="btn-primary wide" id="btn-new-appeal">Сообщить об ошибке</button>
      <h4 class="sub-h">Мои обращения</h4>
      ${appeals.length
        ? appeals.map((a) => `
          <article class="appeal-row">
            <div class="route-name">${escapeHtml(a.topic)}</div>
            <div class="route-dir">${escapeHtml(a.text)}</div>
            <div class="appeal-meta">${new Date(a.createdAt).toLocaleString('ru-RU')} · ${escapeHtml(a.status)}</div>
          </article>`).join('')
        : '<p class="empty-note">Обращений пока нет.</p>'}`;
    return;
  }

  if (view === 'help') {
    body.innerHTML = `
      <h4 class="sub-h">О карте</h4>
      <p class="hint-note">Интерактивная карта маршрутов Автобусного парка г. Барановичи. Сейчас отображаются <b>демонстрационные данные</b>: геометрия маршрутов, остановки и позиции транспорта не являются реальными.</p>
      <h4 class="sub-h">Статусы данных</h4>
      <ul class="help-list">
        <li><span class="live-dot live-dot--live"></span> актуальные — GPS обновляется</li>
        <li><span class="live-dot live-dot--stale"></span> устаревшие — обновлений нет дольше 30 с</li>
        <li><span class="live-dot live-dot--offline"></span> недоступны — провайдер не отвечает</li>
        <li><span class="live-dot live-dot--demo"></span> демо — тестовый провайдер</li>
      </ul>
      <h4 class="sub-h">Горячие клавиши</h4>
      <ul class="help-list">
        <li><kbd>Ctrl</kbd> + <kbd>K</kbd> — поиск</li>
        <li><kbd>F</kbd> — показать весь маршрут</li>
        <li><kbd>L</kbd> — моё местоположение</li>
        <li><kbd>+</kbd> / <kbd>−</kbd> — масштаб</li>
        <li><kbd>Esc</kbd> — закрыть карточку или окно</li>
      </ul>`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Плавающие карточки: остановка, транспорт, hover-подсказка
// ════════════════════════════════════════════════════════════════════════════
function positionFloatCard(el, coord) {
  const p = mapCtl.project(coord);
  if (!p) return;
  const mapEl = $('#map');
  const w = el.offsetWidth || 300;
  const h = el.offsetHeight || 200;
  let x = p.x + 16;
  let y = p.y - h / 2;
  if (x + w > mapEl.clientWidth - 12) x = p.x - w - 16;
  y = Math.max(70, Math.min(y, mapEl.clientHeight - h - 90));
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function renderStopCard() {
  const stopId = store.get('selectedStopId');
  const el = $('#stop-card');
  if (!stopId) { el.hidden = true; return; }
  const stop = getStop(stopId);
  const arrivals = arrivalsForStop(stopId);
  const routes = routesThroughStop(stopId);
  const fav = isFavStop(stopId);
  el.innerHTML = `
    <div class="fc-head">
      <div>
        <div class="fc-kicker">Остановка</div>
        <h3 class="fc-title">${escapeHtml(stop.name)}</h3>
      </div>
      <div class="fc-actions">
        <button class="fav-btn${fav ? ' active' : ''}" data-fav-stop="${stop.id}" aria-label="Избранное">${fav ? '★' : '☆'}</button>
        <button class="btn-icon" data-close-card="stop" aria-label="Закрыть">✕</button>
      </div>
    </div>
    <div class="fc-routes">${routes.map((r) => `<button class="chip-route" data-route-go="${r.id}" style="--rc:${r.color}">${escapeHtml(r.number)}</button>`).join('')}</div>
    <div class="fc-sub">Ближайшие прибытия ${IS_DEMO_DATA ? '<span class="mini-demo">демо</span>' : ''}</div>
    <ul class="arrivals">
      ${arrivals.map((a) => `
        <li>
          <span class="route-badge sm" style="--rc:${a.route.color}">${escapeHtml(a.route.number)}</span>
          <span class="arr-dest">${escapeHtml(a.dest)}</span>
          <b class="arr-min">${a.minutes} мин</b>
        </li>`).join('') || '<li class="empty-note">Нет данных о прибытиях</li>'}
    </ul>
    <button class="btn-primary wide" data-stop-all-routes="${stop.id}">Все маршруты на остановке</button>`;
  el.hidden = false;
  positionFloatCard(el, stop.coord);
}

function renderVehicleCard() {
  const vid = store.get('selectedVehicleId');
  const el = $('#vehicle-card');
  if (!vid) { el.hidden = true; return; }
  const pos = providerManager.positions.find((p) => p.id === vid);
  const meta = getVehicle(vid);
  if (!pos || !meta) { el.hidden = true; return; }
  const route = getRoute(pos.routeId);
  const next = nextStopForVehicle(pos);
  const ageSec = Math.max(0, Math.round((Date.now() - pos.timestamp) / 1000));
  const ageText = ageSec < 60 ? `${ageSec} с назад` : `${Math.round(ageSec / 60)} мин назад`;
  el.innerHTML = `
    <div class="fc-head">
      <div>
        <div class="fc-kicker">Транспорт на маршруте</div>
        <h3 class="fc-title"><span class="route-badge sm" style="--rc:${route.color}">${escapeHtml(route.number)}</span> ${escapeHtml(route.name)}</h3>
      </div>
      <button class="btn-icon" data-close-card="vehicle" aria-label="Закрыть">✕</button>
    </div>
    <ul class="veh-props">
      <li><span>Направление</span><b>${escapeHtml(pos.forward ? route.direction : route.direction.split('→').reverse().map(s => s.trim()).join(' → '))}</b></li>
      <li><span>Тип</span><b>${escapeHtml(pos.type)}</b></li>
      <li><span>Бортовой номер</span><b>${escapeHtml(pos.board)}</b></li>
      <li><span>Скорость</span><b>${pos.speedKmh} км/ч</b></li>
      ${next ? `<li><span>Следующая остановка</span><b>${escapeHtml(next.stop.name)}</b></li>
      <li><span>Прибытие</span><b>через ~${next.minutes} мин</b></li>` : ''}
      <li><span>Данные</span><b>актуальны ${ageText}${IS_DEMO_DATA ? ' · демо' : ''}</b></li>
    </ul>
    <button class="btn-primary wide" data-route-go="${route.id}">Подробнее о маршруте</button>`;
  el.hidden = false;
  positionFloatCard(el, [pos.lon, pos.lat]);
}

function repositionCards() {
  const stopId = store.get('selectedStopId');
  if (stopId) {
    const stop = getStop(stopId);
    if (stop) positionFloatCard($('#stop-card'), stop.coord);
  }
  const vid = store.get('selectedVehicleId');
  if (vid) {
    const pos = providerManager.positions.find((p) => p.id === vid);
    if (pos) positionFloatCard($('#vehicle-card'), [pos.lon, pos.lat]);
  }
}

function showTooltip(props, point) {
  const tip = $('#map-tooltip');
  if (!props) { tip.hidden = true; return; }
  tip.innerHTML = `<b>${escapeHtml(props.name)}</b><span>${escapeHtml(props.routes || '')}</span>`;
  tip.hidden = false;
  tip.style.transform = `translate(${point.x + 14}px, ${point.y - 10}px)`;
}

// ════════════════════════════════════════════════════════════════════════════
// Изменения движения (нижняя левая карточка)
// ════════════════════════════════════════════════════════════════════════════
function renderAlertsCard() {
  const card = $('#alerts-card');
  const primary = ALERTS[0];
  if (!primary) { card.hidden = true; return; }
  $('#alerts-body').innerHTML = alertHtml(primary);
  card.hidden = false;
}

// ════════════════════════════════════════════════════════════════════════════
// Поиск (маршруты, остановки, адреса-районы)
// ════════════════════════════════════════════════════════════════════════════
function searchAll(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return [];
  const res = [];
  for (const r of ROUTES) {
    if (r.number.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) {
      res.push({ kind: 'route', id: r.id, title: `Маршрут ${r.number}`, sub: r.name, color: r.color });
    }
  }
  for (const s of STOPS) {
    if (s.name.toLowerCase().includes(q)) {
      res.push({ kind: 'stop', id: s.id, title: s.name, sub: `Остановка · ${routesThroughStop(s.id).map((r) => r.number).join(', ')}` });
    }
  }
  for (const d of DISTRICTS) {
    if (d.name.toLowerCase().includes(q)) {
      res.push({ kind: 'district', id: d.id, title: d.name, sub: 'Район' });
    }
  }
  return res.slice(0, 8);
}

function renderSearchResults(items) {
  const box = $('#search-results');
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = items.map((it) => `
    <button class="sr-item" role="option" data-kind="${it.kind}" data-id="${it.id}">
      <span class="sr-ico">${it.kind === 'route' ? `<i class="route-badge sm" style="--rc:${it.color}">${escapeHtml(it.title.replace('Маршрут ', ''))}</i>` : it.kind === 'stop' ? '🚏' : '📍'}</span>
      <span class="sr-text"><b>${escapeHtml(it.title)}</b><small>${escapeHtml(it.sub)}</small></span>
    </button>`).join('');
  box.hidden = false;
}

// ════════════════════════════════════════════════════════════════════════════
// Модальные окна
// ════════════════════════════════════════════════════════════════════════════
function openModal(title, bodyHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-backdrop').hidden = false;
  requestAnimationFrame(() => $('#modal-backdrop').classList.add('open'));
}

export function closeModal() {
  const bd = $('#modal-backdrop');
  bd.classList.remove('open');
  setTimeout(() => { bd.hidden = true; }, 200);
}

function openReportModal(presetRouteId = '') {
  openModal('Сообщить об ошибке', `
    <form id="report-form" class="form">
      <label>Тема
        <select name="topic" required>
          <option value="Ошибка в маршруте">Ошибка в маршруте</option>
          <option value="Ошибка в остановке">Ошибка в остановке</option>
          <option value="Неверные данные транспорта">Неверные данные транспорта</option>
          <option value="Проблема с картой">Проблема с картой</option>
          <option value="Другое">Другое</option>
        </select>
      </label>
      <label>Маршрут (необязательно)
        <select name="routeId">
          <option value="">— не выбран —</option>
          ${ROUTES.map((r) => `<option value="${r.id}" ${r.id === presetRouteId ? 'selected' : ''}>${escapeHtml(r.number)} · ${escapeHtml(r.name)}</option>`).join('')}
        </select>
      </label>
      <label>Описание
        <textarea name="text" rows="4" required placeholder="Опишите проблему…"></textarea>
      </label>
      <label>Контакт для ответа (необязательно)
        <input name="contact" type="text" placeholder="e-mail или @telegram">
      </label>
      <p class="hint-note">Демо-режим: обращение сохранится локально в браузере и будет передано диспетчерской после подключения сервера.</p>
      <button class="btn-primary wide" type="submit">Отправить обращение</button>
    </form>`);
}

function openLoginModal() {
  openModal('Личный кабинет', `
    <p class="hint-note">Авторизация появится после подключения серверной части (вход по номеру телефона или через Telegram). Избранное и подписки уже сохраняются на этом устройстве.</p>
    <button class="btn-primary wide" id="btn-login-tg">Войти через Telegram (скоро)</button>`);
}

function openTelegram() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.initData) {
    toast('Карта уже открыта в Telegram Mini App');
    return;
  }
  openModal('Карта в Telegram', `
    <p class="hint-note">Telegram Mini App и бот Автобусного парка сейчас готовятся к публикации. После запуска здесь появится прямая ссылка, а кнопка будет открывать карту внутри Telegram с поддержкой избранного и подписок.</p>
    <button class="btn-primary wide" id="btn-tg-close">Понятно</button>`);
}

// ════════════════════════════════════════════════════════════════════════════
// Bottom sheet (мобильные)
// ════════════════════════════════════════════════════════════════════════════
function initBottomSheet() {
  const panel = $('#side-panel');
  const handle = $('#sheet-handle');
  const STATES = ['peek', 'half', 'full'];
  let stateIdx = 1;
  let startY = 0;
  let startIdx = 1;

  const apply = () => {
    panel.dataset.sheet = STATES[stateIdx];
  };
  apply();

  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    startIdx = stateIdx;
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - startY;
    if (dy < -60) stateIdx = Math.min(2, startIdx + 1);
    else if (dy > 60) stateIdx = Math.max(0, startIdx - 1);
    else stateIdx = startIdx;
    apply();
  }, { passive: true });

  handle.addEventListener('click', () => {
    stateIdx = stateIdx === 2 ? 1 : stateIdx + 1;
    apply();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Действия выбора
// ════════════════════════════════════════════════════════════════════════════
export function selectRoute(routeId, opts) {
  store.set({ selectedStopId: null, selectedVehicleId: null });
  mapCtl.setPulse(null);
  mapCtl.selectRoute(routeId, opts);
  renderPanel();
  renderStopCard();
  renderVehicleCard();
}

export function selectStop(stopId) {
  const stop = getStop(stopId);
  if (!stop) return;
  store.set({ selectedStopId: stopId, selectedVehicleId: null });
  mapCtl.setPulse(stop.coord);
  mapCtl.flyTo(stop.coord, Math.max(14, mapCtl.map?.getZoom() || 14));
  renderStopCard();
  renderVehicleCard();
}

export function selectVehicle(vehicleId) {
  store.set({ selectedVehicleId: vehicleId, selectedStopId: null });
  mapCtl.setPulse(null);
  const pos = providerManager.positions.find((p) => p.id === vehicleId);
  if (pos) mapCtl.flyTo([pos.lon, pos.lat], Math.max(14.5, mapCtl.map?.getZoom() || 14.5));
  renderVehicleCard();
  renderStopCard();
}

function clearSelection() {
  store.set({ selectedStopId: null, selectedVehicleId: null });
  mapCtl.setPulse(null);
  renderStopCard();
  renderVehicleCard();
}

// ════════════════════════════════════════════════════════════════════════════
// Инициализация UI
// ════════════════════════════════════════════════════════════════════════════
export function initUI(mapController) {
  mapCtl = mapController;

  // ── навигация ──
  $('#rail-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-item');
    if (!btn) return;
    document.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b === btn));
    store.set({ view: btn.dataset.view });
    document.body.dataset.view = btn.dataset.view;
    $('#side-panel').classList.remove('collapsed');
    $('#btn-panel-expand').hidden = true;
    renderPanel();
  });

  // ── панель: фильтры, сворачивание, «все маршруты» ──
  $('#btn-filters').addEventListener('click', () => {
    const row = $('#filters-row');
    row.hidden = !row.hidden;
    $('#btn-filters').setAttribute('aria-expanded', String(!row.hidden));
  });
  $('#filters-row').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    document.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    store.set({ filter: chip.dataset.filter });
    renderPanel();
  });
  $('#btn-panel-collapse').addEventListener('click', () => {
    $('#side-panel').classList.add('collapsed');
    $('#btn-panel-expand').hidden = false;
  });
  $('#btn-panel-expand').addEventListener('click', () => {
    $('#side-panel').classList.remove('collapsed');
    $('#btn-panel-expand').hidden = true;
  });
  $('#btn-all-routes').addEventListener('click', () => {
    store.set({ filter: 'all' });
    selectRoute(null);
    mapCtl.fitRoute(null);
    renderPanel();
  });

  // ── делегирование кликов по панели/карточкам ──
  document.body.addEventListener('click', (e) => {
    const favR = e.target.closest('[data-fav-route]');
    if (favR) {
      e.stopPropagation();
      const on = toggleFavRoute(favR.dataset.favRoute);
      toast(on ? 'Маршрут добавлен в избранное' : 'Маршрут убран из избранного');
      renderPanel(); renderStopCard();
      return;
    }
    const favS = e.target.closest('[data-fav-stop]');
    if (favS) {
      e.stopPropagation();
      const on = toggleFavStop(favS.dataset.favStop);
      toast(on ? 'Остановка добавлена в избранное' : 'Остановка убрана из избранного');
      renderPanel(); renderStopCard();
      return;
    }
    const card = e.target.closest('.route-card');
    if (card) { selectRoute(card.dataset.route); return; }
    const stopRow = e.target.closest('.stop-row');
    if (stopRow) { selectStop(stopRow.dataset.stop); return; }
    const goRoute = e.target.closest('[data-route-go]');
    if (goRoute) { selectRoute(goRoute.dataset.routeGo); return; }
    const allStopsBtn = e.target.closest('[data-stop-all-routes]');
    if (allStopsBtn) {
      store.set({ view: 'stops' });
      document.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'stops'));
      renderPanel();
      return;
    }
    const closeBtn = e.target.closest('[data-close-card]');
    if (closeBtn) { clearSelection(); return; }
    const alertItem = e.target.closest('[data-alert-route]');
    if (alertItem) { selectRoute(alertItem.dataset.alertRoute); return; }
    if (e.target.closest('#btn-new-appeal')) { openReportModal(); return; }
    if (e.target.closest('#btn-tg-close')) { closeModal(); return; }
    if (e.target.closest('#btn-login-tg')) { toast('Вход через Telegram появится после запуска бота'); return; }
  });

  // ── подписки (переключатели) ──
  document.body.addEventListener('change', (e) => {
    const sub = e.target.closest('[data-sub]');
    if (sub) {
      const on = toggleSubscription(sub.dataset.sub);
      const route = getRoute(sub.dataset.sub);
      toast(on
        ? `Подписка на маршрут ${route.number} оформлена (демо)`
        : `Подписка на маршрут ${route.number} отменена`);
    }
  });

  // ── верхняя панель ──
  $('#btn-report').addEventListener('click', () => openReportModal(store.get('selectedRouteId') || ''));
  $('#btn-topbar-fav').addEventListener('click', () => switchView('favorites'));
  $('#btn-login').addEventListener('click', openLoginModal);
  $('#btn-telegram').addEventListener('click', openTelegram);

  // ── модальные окна ──
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.body.addEventListener('submit', (e) => {
    if (e.target.id === 'report-form') {
      e.preventDefault();
      const fd = new FormData(e.target);
      addAppeal({
        topic: fd.get('topic'),
        routeId: fd.get('routeId') || null,
        text: fd.get('text'),
        contact: fd.get('contact') || '',
      });
      closeModal();
      toast('Обращение сохранено. Спасибо! (демо-режим)', 'success');
      if (store.get('view') === 'appeals') renderPanel();
    }
  });

  // ── изменения движения ──
  renderAlertsCard();
  $('#btn-alerts-close').addEventListener('click', () => { $('#alerts-card').hidden = true; });
  $('#btn-all-alerts').addEventListener('click', () => switchView('changes'));

  // ── поиск ──
  const input = $('#search-input');
  const runSearch = debounce(() => renderSearchResults(searchAll(input.value)), 200);
  input.addEventListener('input', runSearch);
  input.addEventListener('focus', () => { if (input.value) renderSearchResults(searchAll(input.value)); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-wrap')) $('#search-results').hidden = true;
  });
  $('#search-results').addEventListener('click', (e) => {
    const item = e.target.closest('.sr-item');
    if (!item) return;
    $('#search-results').hidden = true;
    input.blur();
    const { kind, id } = item.dataset;
    if (kind === 'route') selectRoute(id);
    if (kind === 'stop') selectStop(id);
    if (kind === 'district') {
      const d = DISTRICTS.find((x) => x.id === id);
      if (d) { mapCtl.setPulse(d.coord); mapCtl.flyTo(d.coord, 14); }
    }
  });

  // ── стиль карты ──
  document.querySelectorAll('.style-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('.style-btn').forEach((b) => b.classList.toggle('active', b === btn));
      await mapCtl.setBaseStyle(btn.dataset.style);
      toast(`Стиль карты: ${btn.textContent.trim()}`);
    });
  });
  const styleInit = store.get('baseStyle');
  document.querySelectorAll('.style-btn').forEach((b) => b.classList.toggle('active', b.dataset.style === styleInit));

  // ── управление картой ──
  $('#ctrl-zoom-in').addEventListener('click', () => mapCtl.zoomIn());
  $('#ctrl-zoom-out').addEventListener('click', () => mapCtl.zoomOut());
  $('#ctrl-fit').addEventListener('click', () => mapCtl.fitRoute(null));
  $('#ctrl-locate').addEventListener('click', () => mapCtl.locate((msg) => toast(msg, 'warn')));

  // ── нижняя панель ──
  document.querySelector('.bottom-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === 'favorites') switchView('favorites');
    if (a === 'routes') switchView('routes');
    if (a === 'subscriptions') switchView('subscriptions');
    if (a === 'report') openReportModal();
    if (a === 'filters') {
      switchView('routes');
      $('#filters-row').hidden = false;
      $('#btn-filters').setAttribute('aria-expanded', 'true');
    }
  });

  // ── упрощённый режим ──
  const simplifiedToggle = $('#toggle-simplified');
  simplifiedToggle.checked = store.get('simplified');
  document.body.classList.toggle('simplified', store.get('simplified'));
  simplifiedToggle.addEventListener('change', () => {
    store.set({ simplified: simplifiedToggle.checked });
    document.body.classList.toggle('simplified', simplifiedToggle.checked);
    mapCtl.setSimplified(simplifiedToggle.checked);
    toast(simplifiedToggle.checked ? 'Упрощённый режим включён' : 'Упрощённый режим выключен');
  });

  // ── горячие клавиши ──
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  $('#search-kbd').textContent = isMac ? '⌘ K' : 'Ctrl K';
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('#modal-backdrop').hidden) { closeModal(); return; }
      $('#search-results').hidden = true;
      clearSelection();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (typing) return;
    if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') mapCtl.fitRoute(null);
    if (e.key === 'l' || e.key === 'L' || e.key === 'д' || e.key === 'Д') mapCtl.locate((m) => toast(m, 'warn'));
    if (e.key === '+' || e.key === '=') mapCtl.zoomIn();
    if (e.key === '-') mapCtl.zoomOut();
  });

  // ── события карты ──
  mapCtl.handlers.onStopClick = (id) => selectStop(id);
  mapCtl.handlers.onVehicleClick = (id) => selectVehicle(id);
  mapCtl.handlers.onRouteClick = (id) => selectRoute(id, { fit: false });
  mapCtl.handlers.onMapClick = () => clearSelection();
  mapCtl.handlers.onStopHover = (props, point) => showTooltip(props, point || { x: 0, y: 0 });
  mapCtl.handlers.onMapMove = () => { repositionCards(); updateScalebar(); };
  mapCtl.handlers.onStyleRestored = () => {
    const stopId = store.get('selectedStopId');
    if (stopId) mapCtl.setPulse(getStop(stopId).coord);
  };

  // ── провайдер: обновление статусов и открытых карточек ──
  providerManager.onUpdate((positions, status, lastUpdate) => {
    store.set({ dataStatus: status, lastUpdate });
    renderStatusChips();
    if (store.get('selectedStopId')) renderStopCard();
    if (store.get('selectedVehicleId')) renderVehicleCard();
    if (['map', 'routes'].includes(store.get('view'))) renderPanel();
  });

  setInterval(renderStatusChips, 5000);
  renderConnection();
  window.addEventListener('online', renderConnection);
  window.addEventListener('offline', renderConnection);
  if (navigator.connection) navigator.connection.addEventListener?.('change', renderConnection);

  initBottomSheet();
  renderPanel();
  renderStatusChips();

  // Telegram Mini App: адаптация вьюпорта
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.initData) {
    tg.ready();
    tg.expand();
    document.body.classList.add('in-telegram');
  }
}

function switchView(view) {
  document.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  store.set({ view });
  document.body.dataset.view = view;
  $('#side-panel').classList.remove('collapsed');
  $('#btn-panel-expand').hidden = true;
  renderPanel();
}

// ── линейка масштаба ──
function updateScalebar() {
  const metersPer100 = mapCtl.getScale();
  if (!metersPer100) return;
  const targets = [50, 100, 200, 500, 1000, 2000, 5000];
  const target = targets.find((t) => (t / metersPer100) * 100 >= 60) || 5000;
  const px = Math.round((target / metersPer100) * 100);
  const bar = $('#scalebar');
  bar.querySelector('i').style.width = `${Math.min(px, 160)}px`;
  $('#scalebar-text').textContent = target >= 1000 ? `${target / 1000} км` : `${target} м`;
}
