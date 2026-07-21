// Единое состояние приложения + избранное/подписки/обращения в localStorage.
// Слой: Map UI Layer (state).

const LS_KEYS = {
  favorites: 'bp_map_favorites',
  subscriptions: 'bp_map_subscriptions',
  appeals: 'bp_map_appeals',
  simplified: 'bp_map_simplified',
  style: 'bp_map_style',
};

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ }
}

const state = {
  view: 'map',                    // активный раздел навигации
  selectedRouteId: null,
  selectedStopId: null,
  selectedVehicleId: null,
  filter: 'all',                  // фильтр списка маршрутов
  baseStyle: lsGet(LS_KEYS.style, 'scheme'),
  simplified: lsGet(LS_KEYS.simplified, false),
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  dataStatus: 'offline',
  lastUpdate: 0,
  favorites: lsGet(LS_KEYS.favorites, { routes: [], stops: [] }),
  subscriptions: lsGet(LS_KEYS.subscriptions, []),
  appeals: lsGet(LS_KEYS.appeals, []),
  panelCollapsed: false,
};

const listeners = new Map(); // key -> Set<fn>

export const store = {
  get: (key) => state[key],

  set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (state[k] !== v) { state[k] = v; changed.push(k); }
    }
    for (const k of changed) {
      const set = listeners.get(k);
      if (set) for (const fn of set) fn(state[k], state);
    }
    if (changed.includes('favorites')) lsSet(LS_KEYS.favorites, state.favorites);
    if (changed.includes('subscriptions')) lsSet(LS_KEYS.subscriptions, state.subscriptions);
    if (changed.includes('appeals')) lsSet(LS_KEYS.appeals, state.appeals);
    if (changed.includes('simplified')) lsSet(LS_KEYS.simplified, state.simplified);
    if (changed.includes('baseStyle')) lsSet(LS_KEYS.style, state.baseStyle);
  },

  subscribe(keys, fn) {
    for (const k of [].concat(keys)) {
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    }
    return () => { for (const k of [].concat(keys)) listeners.get(k)?.delete(fn); };
  },
};

// ── Избранное ───────────────────────────────────────────────────────────────
export function isFavRoute(id) { return state.favorites.routes.includes(id); }
export function isFavStop(id) { return state.favorites.stops.includes(id); }

export function toggleFavRoute(id) {
  const routes = isFavRoute(id)
    ? state.favorites.routes.filter((x) => x !== id)
    : [...state.favorites.routes, id];
  store.set({ favorites: { ...state.favorites, routes } });
  return routes.includes(id);
}

export function toggleFavStop(id) {
  const stops = isFavStop(id)
    ? state.favorites.stops.filter((x) => x !== id)
    : [...state.favorites.stops, id];
  store.set({ favorites: { ...state.favorites, stops } });
  return stops.includes(id);
}

// ── Подписки на изменения маршрутов ─────────────────────────────────────────
export function isSubscribed(routeId) { return state.subscriptions.includes(routeId); }
export function toggleSubscription(routeId) {
  const subs = isSubscribed(routeId)
    ? state.subscriptions.filter((x) => x !== routeId)
    : [...state.subscriptions, routeId];
  store.set({ subscriptions: subs });
  return subs.includes(routeId);
}

// ── Обращения ───────────────────────────────────────────────────────────────
export function addAppeal(appeal) {
  const appeals = [{ id: `ap${Date.now()}`, createdAt: Date.now(), status: 'Отправлено (демо)', ...appeal }, ...state.appeals];
  store.set({ appeals });
}

// ── Утилиты ────────────────────────────────────────────────────────────────
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const left = ms - (now - last);
    if (left <= 0) { last = now; fn(...args); }
    else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, left);
    }
  };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
