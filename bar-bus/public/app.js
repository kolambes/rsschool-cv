(function () {
  const tg = window.Telegram?.WebApp;
  const NEWS_VIEWED_KEY = "baranovichi_news_viewed";
  const NEWS_LIKED_KEY = "baranovichi_news_liked";
  const NEWS_LIKE_SYNC_KEY = "baranovichi_news_like_sync";
  const ALARM_STATE_KEY = "baranovichi_alarm_state";
  const LAST_ROUTE_SEARCH_KEY = "baranovichi_last_route_search";
  const CLIENT_ID_KEY = "baranovichi_client_id";
  const APPEAL_DRAFT_KEY = "baranovichi_appeal_draft";
  const PWA_INSTALL_LAST_PROMPT_KEY = "baranovichi_pwa_install_last_prompt";
  const PWA_INSTALL_ACCEPTED_KEY = "baranovichi_pwa_install_accepted";
  const PWA_INSTALL_AUTO_DELAY_MS = 1800;
  const PWA_INSTALL_AUTO_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  const APP_TIME_ZONE = "Europe/Minsk";
  const SCHEDULE_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  });
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const safeStorage = createSafeStorage();
  const TRANSPORT_MODES = {
    city: {
      label: "Городской",
      title: "Городское расписание",
      hint: "Маршруты по городу Барановичи",
      empty: "Городские маршруты пока не загружены."
    },
    suburban: {
      label: "Пригородный",
      title: "Пригородное расписание",
      hint: "Маршруты в населённые пункты района",
      empty: "Пригородное расписание появится после загрузки XML-файлов."
    },
    intercity: {
      label: "Междугородний",
      title: "Междугороднее расписание",
      hint: "Рейсы между городами",
      empty: "Междугороднее расписание появится после загрузки XML-файлов."
    },
    international: {
      label: "Международный",
      title: "Международное расписание",
      hint: "Международные рейсы",
      empty: "Международное расписание появится после загрузки XML-файлов."
    }
  };

  const state = {
    data: null,
    routeId: "",
    directionCode: "",
    stopUid: "",
    dayMode: "today",
    // True only after the rider taps a day tab themselves. Guards the auto-advance
    // in renderSchedule: a fresh open of an empty "today" jumps to the nearest
    // service day, but an explicit "Сегодня" tap stays and shows the empty card.
    dayModeExplicit: false,
    stopSearch: "",
    routeFilter: "",
    routeDayFilter: "all",
    transportType: "city",
    homeRouteSearch: {
      fromQuery: "",
      toQuery: "",
      date: "",
      time: "",
      isOpen: false,
      loading: false,
      error: "",
      results: [],
      fromMatches: [],
      toMatches: [],
      requestId: 0,
      stopOptionQuery: "",
      stopOptionTarget: "",
      stopOptionActiveIndex: -1,
      isCompact: false
    },
    missingRouteNumber: "",
    activeView: initialView(),
    schedule: { groups: [] },
    timeline: [],
    timelineKey: "",
    timelineCache: new Map(),
    timelineRequestId: 0,
    scheduleRequestId: 0,
    selectedDeparture: null,
    selectedDepartureMode: "auto",
    activeAppeal: readActiveAppeal(),
    userAppeals: [],
    favorites: readFavorites(),
    favoriteSchedules: new Map(),
    favoriteScheduleLoading: new Set(),
    alarms: readAlarmStates(),
    alarmSheet: null,
    pendingFavorite: null,
    chatTimer: null,
    appealFiles: [],
    chatFiles: [],
    showAllStops: false,
    shouldScrollToSchedule: false,
    viewedNews: readViewedNews(),
    likedNews: readLikedNews(),
    pendingNewsLikeSync: readPendingNewsLikeSync(),
    clientId: readClientId(),
    newsLikePending: new Set(),
    newsFilter: "all",
    openNewsId: "",
    homePromoIndex: 0,
    homePromoTimer: null,
    departuresExpanded: false,
    stopTimesSheet: null,
    aboutDepartment: "all",
    aboutTab: "all",
    aboutSearch: "",
    expandedDepartments: new Set(),
    serviceTab: "sto",
    viewScroll: Object.create(null),
    staffAccess: null
  };

  let internalViewHashUpdate = false;
  let deferredInstallPrompt = null;
  let installSheet = null;
  let installAutoTimer = null;
  let installRestoreFocus = null;
  let homeRouteSearchRestoreFocus = null;
  let homeStopOptionsHideTimer = null;
  let telegramHomeScreenStatus = "";
  let telegramHomeScreenCheckPending = false;

  function motionSafeBehavior(behavior = "auto") {
    if (behavior !== "smooth") return behavior;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth";
  }

  const SERVICE_CATALOG = {
    sto: {
      title: "Услуги СТО",
      subtitle: "Выберите тип обслуживания",
      category: "СТО",
      items: [
        { name: "Ремонт двигателя", icon: "engine" },
        { name: "Ремонт тормозной системы", icon: "brake" },
        { name: "Заправка и ремонт кондиционера", icon: "snow" },
        { name: "Ремонт КПП и редукторов", icon: "gear" },
        { name: "Ремонт ходовой части", icon: "axle" },
        { name: "Ремонт электрооборудования", icon: "bolt" },
        { name: "Сварочные работы", icon: "weld" },
        { name: "Плановое обслуживание", icon: "checklist" },
        { name: "Диагностика автомобиля", icon: "car" },
        { name: "Лазерная очистка металла", icon: "spark" },
        { name: "Замена технических жидкостей", icon: "drop" },
        { name: "Шиномонтаж", icon: "tire" }
      ]
    },
    other: {
      title: "Другие услуги",
      subtitle: "Короткие заявки без лишних форм",
      category: "СТО",
      items: [
        { name: "Аренда автобусов", icon: "bus" },
        { name: "Аренда помещений", icon: "building" },
        { name: "Столовая", icon: "meal" },
        { name: "Медицинское и техническое освидетельствование", icon: "medical" },
        { name: "Реклама на бортах автобуса", icon: "ad", category: "Реклама" },
        { name: "Покупка отработанных масел", icon: "oil" },
        { name: "Автовокзал", icon: "station" },
        { name: "Автостанция Ляховичи", icon: "pin" },
        { name: "Рынок «Кірмаш Палескі»", icon: "market" }
      ]
    }
  };

  // Категория-тег и «Что входит» по (section, icon) — клиентский фолбэк, когда
  // у услуги пусто (совпадает с бэкендовым SERVICE_META_SEED). Ключ по иконке
  // стабилен и переживает переименования.
  const SERVICE_ICON_META = {
    sto: {
      engine: { category: "Двигатель", bullets: ["Диагностика и дефектовка", "Замена ГРМ, прокладок, узлов", "Разборка, сборка, обкатка"] },
      brake: { category: "Тормоза", bullets: ["Замена колодок и дисков", "Ремонт суппортов", "Прокачка тормозной системы"] },
      snow: { category: "Климат", bullets: ["Проверка на утечки", "Дозаправка хладагента", "Замена компрессора и трубок"] },
      gear: { category: "Трансмиссия", bullets: ["Диагностика КПП", "Замена сцепления", "Ремонт редукторов мостов"] },
      axle: { category: "Ходовая", bullets: ["Замена амортизаторов", "Ремонт рычагов и сайлентблоков", "Замена ступичных подшипников"] },
      bolt: { category: "Электрика", bullets: ["Поиск неисправностей проводки", "Ремонт генераторов и стартеров", "Установка доп. оборудования"] },
      weld: { category: "Кузов", bullets: ["Устранение коррозии", "Ремонт рамы и днища", "Аргонная сварка"] },
      checklist: { category: "ТО", bullets: ["Замена масел и фильтров", "Проверка узлов по регламенту", "Отметка в сервисной книжке"] },
      car: { category: "Проверка", bullets: ["Считывание ошибок", "Проверка датчиков", "Заключение специалиста"] },
      spark: { category: "Металл", bullets: ["Очистка без абразива", "Подготовка к покраске", "Обработка сварных швов"] },
      drop: { category: "ТО", bullets: ["Слив и заливка масла", "Замена антифриза", "Обновление тормозной жидкости"] },
      tire: { category: "Колёса", bullets: ["Перебортовка колёс", "Балансировка", "Ремонт проколов"] }
    },
    other: {
      bus: { category: "Аренда", bullets: ["Комфортабельные автобусы", "Опытные водители", "Гибкие маршруты и время"] },
      building: { category: "Аренда", bullets: ["Отапливаемые боксы", "Складские помещения", "Долгосрочная аренда"] },
      meal: { category: "Питание", bullets: ["Комплексные обеды", "Домашняя кухня", "Доступные цены"] },
      medical: { category: "Документы", bullets: ["Медосмотр водителей", "Техконтроль транспорта", "Отметки в путевых листах"] },
      ad: { category: "Реклама", bullets: ["Брендирование бортов", "Широкий охват по городу", "Изготовление макета"] },
      oil: { category: "Приём", bullets: ["Приём по договору", "Собственный вывоз", "Экологичная утилизация"] },
      station: { category: "Транспорт", bullets: ["Продажа билетов", "Зал ожидания", "Справочная служба"] },
      pin: { category: "Локация", bullets: ["Расписание рейсов", "Продажа билетов", "Посадочные платформы"] },
      market: { category: "Торговля", bullets: ["Аренда торговых мест", "Удобное расположение", "Парковка для покупателей"] }
    }
  };

  const EXTRA_REST_DAYS = new Set(["2026-04-20"]);
  const EXTRA_WORK_DAYS = new Set(["2026-04-25"]);
  const EXTRA_WORK_DAY_REPLACEMENTS = new Map([["2026-04-25", 0]]);
  const TOUCH_PRESS_DELAY = 70;
  const PRESS_MOVE_LIMIT = 8;
  const HOME_FAVORITE_ROUTES_LIMIT = 3;
  const HOME_STOP_SUGGESTION_LIMIT = 7;
  const HOME_STOP_SUGGESTION_MIN_QUERY = 1;
  const MAX_APPEAL_ATTACHMENTS = 4;
  const MAX_APPEAL_ATTACHMENT_BYTES = 5 * 1024 * 1024;
  const TARGET_APPEAL_IMAGE_BYTES = 900 * 1024;
  const MAX_APPEAL_IMAGE_SIDE = 1280;
  const APPEAL_PLACEHOLDERS = {
    "Обращение": "Опишите ваш запрос или проблему.",
    "Реклама": "Напишите вопрос по рекламе: формат, сроки размещения, место и важные детали.",
    "СТО": "Опишите, какая услуга нужна: что случилось, какой транспорт и удобное время для связи."
  };
  let activePress = null;
  let aboutSearchScrollTimer = null;
  let timelineClockTimer = null;

  const els = {
    homePromo: document.querySelector("#homePromo"),
    homePromoTrack: document.querySelector("#homePromoTrack"),
    homePromoTitle: document.querySelector("#homePromoTitle"),
    homePromoText: document.querySelector("#homePromoText"),
    homePromoBadge: document.querySelector(".home-promo-badge"),
    homePromoMedia: document.querySelector("#homePromoMedia"),
    homePromoImage: document.querySelector("#homePromoImage"),
    homePromoCta: document.querySelector("#homePromoCta"),
    homePromoProgress: document.querySelector("#homePromoProgress"),
    homeFavoriteRoutes: document.querySelector("#homeFavoriteRoutes"),
    homeFavoriteRoutesList: document.querySelector("#homeFavoriteRoutesList"),
    homeRouteSearch: document.querySelector("#homeRouteSearch"),
    homeRouteSearchOpen: document.querySelector("#homeRouteSearchOpen"),
    homeRouteSearchMenu: document.querySelector("#homeRouteSearchMenu"),
    homeRouteSearchBackdrop: document.querySelector("#homeRouteSearchBackdrop"),
    homeRouteSearchClose: document.querySelector("#homeRouteSearchClose"),
    homeRouteSearchLauncherSummary: document.querySelector("#homeRouteSearchLauncherSummary"),
    homeRouteSearchForm: document.querySelector("#homeRouteSearchForm"),
    homeRouteSearchCompact: document.querySelector("#homeRouteSearchCompact"),
    homeRouteSearchCompactTitle: document.querySelector("#homeRouteSearchCompactTitle"),
    homeRouteSearchCompactMeta: document.querySelector("#homeRouteSearchCompactMeta"),
    homeRouteEditButton: document.querySelector("#homeRouteEditButton"),
    homeFromInput: document.querySelector("#homeFromInput"),
    homeToInput: document.querySelector("#homeToInput"),
    homeDateInput: document.querySelector("#homeDateInput"),
    homeTimeInput: document.querySelector("#homeTimeInput"),
    homeNowButton: document.querySelector("#homeNowButton"),
    homeRouteSwapButton: document.querySelector("#homeRouteSwapButton"),
    homeSearchButton: document.querySelector("#homeSearchButton"),
    homeRouteResults: document.querySelector("#homeRouteResults"),
    homeRouteSearchStatus: document.querySelector("#homeRouteSearchStatus"),
    homeStopOptions: document.querySelector("#homeStopOptions"),
    bottomNav: document.querySelector("#bottomNav"),
    staffSettingsButton: null,
    transportChoiceHint: document.querySelector("#transportChoiceHint"),
    scheduleMeta: document.querySelector("#scheduleMeta"),
    scheduleHero: document.querySelector("#scheduleHero"),
    routeSummary: document.querySelector("#routeSummary"),
    stopSummary: document.querySelector("#stopSummary"),
    changeRouteButton: document.querySelector("#changeRouteButton"),
    quickRoutes: document.querySelector("#quickRoutes"),
    directionChips: document.querySelector("#directionChips"),
    directionSwapButton: document.querySelector("#directionSwapButton"),
    favoritesPanel: document.querySelector("#favoritesPanel"),
    favoritesList: document.querySelector("#favoritesList"),
    favoritesCount: document.querySelector("#favoritesCount"),
    favoritesEmpty: document.querySelector("#favoritesEmpty"),
    favoritesNavBadge: document.querySelector("#favoritesNavBadge"),
    adRail: document.querySelector("#adRail"),
    routeSelect: document.querySelector("#routeSelect"),
    directionSelect: document.querySelector("#directionSelect"),
    stopSelect: document.querySelector("#stopSelect"),
    stopSearch: document.querySelector("#stopSearch"),
    nextPanel: document.querySelector("#nextPanel"),
    timesPanel: document.querySelector("#timesPanel"),
    stopsPanel: document.querySelector("#stopsPanel"),
    routeList: document.querySelector("#routeList"),
    routesTitle: document.querySelector("#routesTitle"),
    routeSearch: document.querySelector("#routeSearch"),
    appealForm: document.querySelector("#appealForm"),
    appealStatus: document.querySelector("#appealStatus"),
    appealTextCounter: document.querySelector("#appealTextCounter"),
    appealFileName: document.querySelector("#appealFileName"),
    appealFileCount: document.querySelector("#appealFileCount"),
    appealPreviewList: document.querySelector("#appealPreviewList"),
    appealBotButton: document.querySelector("#appealBotButton"),
    appealInboxList: document.querySelector("#appealInboxList"),
    serviceView: document.querySelector('[data-view="service"]'),
    clientChat: document.querySelector("#clientChat"),
    clientChatMeta: document.querySelector("#clientChatMeta"),
    clientChatStatus: document.querySelector("#clientChatStatus"),
    clientChatThread: document.querySelector("#clientChatThread"),
    clientChatForm: document.querySelector("#clientChatForm"),
    clientChatAttachmentInput: document.querySelector("#clientChatAttachmentInput"),
    clientChatAttachButton: document.querySelector("#clientChatAttachButton"),
    clientChatAttachmentPreview: document.querySelector("#clientChatAttachmentPreview"),
    clientChatAttachCount: document.querySelector("#clientChatAttachCount"),
    newsList: document.querySelector("#newsList"),
    newsUnreadDot: document.querySelector("#newsUnreadDot"),
    newsFilters: document.querySelector("#newsFilters"),
    aboutFeatured: document.querySelector("#aboutFeatured"),
    aboutDepartments: document.querySelector("#aboutDepartments"),
    aboutPeople: document.querySelector("#aboutPeople"),
    aboutSearch: document.querySelector("#aboutSearch"),
    aboutTabs: document.querySelector("#aboutTabs"),
    aboutFilterButton: document.querySelector("#aboutFilterButton"),
    aboutFilterSheet: document.querySelector("#aboutFilterSheet"),
    aboutFilterBackdrop: document.querySelector("#aboutFilterBackdrop"),
    aboutFilterClose: document.querySelector("#aboutFilterClose"),
    aboutFilterOptions: document.querySelector("#aboutFilterOptions"),
    aboutAlphaNav: document.querySelector("#aboutAlphaNav"),
    aboutShowAll: document.querySelector("#aboutShowAll"),
    imageViewer: document.querySelector("#imageViewer"),
    imageViewerBackdrop: document.querySelector("#imageViewerBackdrop"),
    imageViewerClose: document.querySelector("#imageViewerClose"),
    imageViewerImage: document.querySelector("#imageViewerImage"),
    newsDetailViewer: document.querySelector("#newsDetailViewer"),
    newsDetailBackdrop: document.querySelector("#newsDetailBackdrop"),
    newsDetailClose: document.querySelector("#newsDetailClose"),
    newsDetailContent: document.querySelector("#newsDetailContent"),
    appToast: document.querySelector("#appToast"),
    themeToggle: document.querySelector("#themeToggle"),
    themeIcon: document.querySelector("#themeIcon")
  };

  boot();

  async function boot() {
    setupTelegram();
    setupViewportStability();
    removeMiniAppAppealSurface();
    document.body.classList.remove("is-about-filter-open");
    renderServiceScreen();
    bindEvents();
    startTimelineClock();
    enhanceAboutPeople();
    setTheme(readTheme());
    setView(state.activeView);
    setupPwaInstallExperience();
    updateTopbarBell();

    try {
      const response = await fetch("/api/bootstrap", { headers: telegramHeaders() });
      if (!response.ok) throw new Error("Не удалось загрузить данные.");
      state.data = await response.json();
      setInitialSelection();
      loadStaffAccess();
      pullFavoritesFromServer();
      // News UI was removed from the Mini App; syncing stale pending likes from old
      // localStorage would post to an invisible feature. Intentionally not called.
      renderAll();
      if (state.activeView === "schedule") await loadSchedule();
      restoreLastHomeRouteSearch();
      subscribeForNotifications();
    } catch (error) {
      renderError(error.message);
    } finally {
      hideLoader();
    }
  }

  function setupTelegram() {
    if (!tg) return;
    tg.ready();
    tg.expand();

    tg.onEvent?.("themeChanged", () => {
      setTheme("comfort");
    });

    // Native Telegram back button: navigate between views instead of closing the
    // whole Mini App. On the home view, let Telegram close it as usual.
    tg.BackButton?.onClick?.(() => {
      if (state.activeView && state.activeView !== "home") setView("home");
      else tg.close?.();
    });

    // Pause the background chat poller while the app is hidden/minimised to save
    // battery and data; resume it when the user comes back to an open appeal.
    // (startClientChatPolling itself guards on appeal status and a live chat panel,
    // so token-authenticated browser sessions resume too.)
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopClientChatPolling();
      } else if (state.activeAppeal?.id) {
        startClientChatPolling();
      }
    });
  }

  function syncTelegramBackButton(view) {
    const backButton = tg?.BackButton;
    if (!backButton) return;
    if (view && view !== "home") backButton.show?.();
    else backButton.hide?.();
  }

  function removeMiniAppAppealSurface() {
    document.querySelectorAll('[data-open-view="appeal"], [data-nav="appeal"], .view[data-view="appeal"]').forEach((node) => node.remove());
  }

  function startTimelineClock() {
    if (timelineClockTimer) return;
    timelineClockTimer = window.setInterval(() => {
      if (document.hidden) return;
      if (state.activeView !== "schedule" || state.dayMode !== "today") return;
      const times = selectedTimes();
      const next = getNextDeparture(times);
      const fallbackDeparture = times.length && !next ? times[0] : null;
      const preferredDeparture = state.selectedDeparture || next || fallbackDeparture;
      if (preferredDeparture) loadBestTimelineFor(preferredDeparture, times, next, fallbackDeparture);
      renderStops();
    }, 30_000);
  }

  function setupViewportStability() {
    const root = document.documentElement;
    let lastWidth = Math.round(window.innerWidth || document.documentElement.clientWidth || 0);
    let lastHeight = 0;
    let frame = 0;

    function stableWidth() {
      const candidates = [
        Number(window.visualViewport?.width) || 0,
        Number(document.documentElement.clientWidth) || 0,
        Number(window.innerWidth) || 0
      ].filter((value) => value > 0);
      return Math.round(Math.min(...candidates));
    }

    function stableHeight() {
      const telegramHeight = Number(tg?.viewportStableHeight) || 0;
      const innerHeight = Number(window.innerHeight) || 0;
      const visualHeight = Number(window.visualViewport?.height) || 0;
      return Math.round(telegramHeight || innerHeight || visualHeight);
    }

    function applyViewportHeight(force = false) {
      const width = stableWidth() || lastWidth;
      const height = stableHeight();
      if (width) root.style.setProperty("--app-viewport-width", `${width}px`);
      if (!height || height < 320) return;

      const widthChanged = Math.abs(width - lastWidth) > 8;
      const heightChanged = Math.abs(height - lastHeight) > 24;
      if (!force && !widthChanged && !heightChanged) return;

      // Mobile WebViews often report small height changes while the user scrolls.
      // Ignoring those prevents the page from visually jumping and snapping back.
      if (!force && !widthChanged && lastHeight && Math.abs(height - lastHeight) < 96) return;

      root.style.setProperty("--app-viewport-height", `${height}px`);
      lastWidth = width || lastWidth;
      lastHeight = height;
    }

    function scheduleViewportHeight(force = false) {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        applyViewportHeight(force);
        scheduleRouteVehicleMarkerAlignment();
      });
    }

    applyViewportHeight(true);
    window.addEventListener("resize", () => scheduleViewportHeight(false), { passive: true });
    window.visualViewport?.addEventListener("resize", () => scheduleViewportHeight(false), { passive: true });
    window.addEventListener("orientationchange", () => {
      window.setTimeout(() => scheduleViewportHeight(true), 260);
    }, { passive: true });
    tg?.onEvent?.("viewportChanged", () => scheduleViewportHeight(false));
    window.setTimeout(() => scheduleViewportHeight(false), 450);
    window.setTimeout(() => scheduleViewportHeight(false), 1000);
  }

  function setupPwaInstallExperience() {
    registerServiceWorker();

    if (isStandaloneApp()) {
      safeStorage.setItem(PWA_INSTALL_ACCEPTED_KEY, "1");
      return;
    }

    setupTelegramHomeScreenEvents();

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      renderInstallEntryPoint();
      scheduleInstallSheet();
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      safeStorage.setItem(PWA_INSTALL_ACCEPTED_KEY, "1");
      closeInstallSheet({ remember: false, restoreFocus: false });
      renderInstallEntryPoint();
      showToast("Приложение добавлено на главный экран.");
    });

    renderInstallEntryPoint();
    scheduleInstallSheet();
  }

  function setupTelegramHomeScreenEvents() {
    if (!isTelegramWebView() || !supportsTelegramHomeScreenShortcut()) return;

    tg.onEvent?.("homeScreenAdded", handleTelegramHomeScreenAdded);
    tg.onEvent?.("homeScreenChecked", handleTelegramHomeScreenChecked);
    requestTelegramHomeScreenStatus();
  }

  function handleTelegramHomeScreenAdded() {
    telegramHomeScreenStatus = "added";
    safeStorage.setItem(PWA_INSTALL_ACCEPTED_KEY, "1");
    closeInstallSheet({ remember: false, restoreFocus: false });
    renderInstallEntryPoint();
    tg?.HapticFeedback?.notificationOccurred?.("success");
    showToast("Ярлык добавлен на главный экран.");
  }

  function handleTelegramHomeScreenChecked(event = {}) {
    const status = normalizeTelegramHomeScreenStatus(event.status);
    if (!status) return;

    telegramHomeScreenStatus = status;
    telegramHomeScreenCheckPending = false;
    if (status === "added") {
      safeStorage.setItem(PWA_INSTALL_ACCEPTED_KEY, "1");
      closeInstallSheet({ remember: false, restoreFocus: false });
    } else {
      safeStorage.removeItem(PWA_INSTALL_ACCEPTED_KEY);
    }
    renderInstallEntryPoint();
  }

  function requestTelegramHomeScreenStatus() {
    if (!supportsTelegramHomeScreenShortcut() || telegramHomeScreenCheckPending) return;
    telegramHomeScreenCheckPending = true;

    try {
      tg.checkHomeScreenStatus((status) => {
        handleTelegramHomeScreenChecked({ status });
      });
    } catch {
      telegramHomeScreenCheckPending = false;
    }
  }

  function isLocalHost() {
    const host = location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".local");
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;

    // On localhost the service worker's cache-first strategy hides code/CSS edits
    // (a change won't appear until caches are manually cleared). Disable it in
    // local dev and actively remove any SW left over from earlier runs, so what
    // you see is always what's on disk. Production keeps the full offline PWA.
    if (isLocalHost()) {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
        .then(() => (window.caches ? caches.keys() : []))
        .then((keys) => Promise.all((keys || []).map((key) => caches.delete(key))))
        .catch(() => {});
      return;
    }

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }

  function renderInstallEntryPoint() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;

    const existing = document.querySelector("[data-install-app]");
    if (!shouldShowInstallEntryPoint()) {
      existing?.remove();
      topbar.classList.remove("has-install-button");
      return;
    }

    const button = existing || create("button", "install-app-button");
    button.type = "button";
    button.dataset.installApp = "true";
    button.title = "Добавить приложение на главный экран";
    button.setAttribute("aria-label", button.title);
    if (!button.firstChild) {
      const icon = create("span", "install-app-button-icon");
      icon.setAttribute("aria-hidden", "true");
      button.append(icon, create("span", "install-app-button-text"));
      button.addEventListener("click", () => openInstallSheet({ source: "button" }));
    }
    button.querySelector(".install-app-button-text").textContent = installEntryPointLabel();
    topbar.classList.add("has-install-button");

    if (!existing) topbar.insertBefore(button, topbar.firstElementChild);
  }

  function shouldShowInstallEntryPoint() {
    if (isStandaloneApp()) return false;
    if (isTelegramWebView()) {
      if (telegramHomeScreenStatus === "added") return false;
      if (telegramHomeScreenStatus) return true;
      return safeStorage.getItem(PWA_INSTALL_ACCEPTED_KEY) !== "1";
    }
    if (safeStorage.getItem(PWA_INSTALL_ACCEPTED_KEY) === "1") return false;
    return true;
  }

  function installEntryPointLabel() {
    const mode = currentInstallMode();
    if (mode === "telegram-native") return "В Telegram";
    if (mode === "telegram-manual") return "Как добавить";
    return deferredInstallPrompt ? "Установить" : "На экран";
  }

  function scheduleInstallSheet() {
    window.clearTimeout(installAutoTimer);
    if (!shouldAutoShowInstallSheet()) return;

    installAutoTimer = window.setTimeout(() => {
      if (shouldAutoShowInstallSheet()) openInstallSheet({ source: "auto" });
    }, PWA_INSTALL_AUTO_DELAY_MS);
  }

  function shouldAutoShowInstallSheet() {
    if (!shouldShowInstallEntryPoint()) return false;
    if (!isMobileInstallContext() && !isTelegramWebView() && !deferredInstallPrompt) return false;

    const lastPromptAt = Number(safeStorage.getItem(PWA_INSTALL_LAST_PROMPT_KEY) || 0);
    return !lastPromptAt || Date.now() - lastPromptAt > PWA_INSTALL_AUTO_INTERVAL_MS;
  }

  function openInstallSheet(options = {}) {
    if (!shouldShowInstallEntryPoint()) return;
    if (installSheet) closeInstallSheet({ remember: false, restoreFocus: false });

    const copy = installSheetCopy();
    const root = create("div", "install-sheet");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "installSheetTitle");

    const backdrop = create("button", "install-sheet-backdrop");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Закрыть");
    backdrop.addEventListener("click", () => closeInstallSheet());

    const panel = create("section", "install-sheet-panel");
    const handle = create("span", "install-sheet-handle");
    handle.setAttribute("aria-hidden", "true");

    const header = create("div", "install-sheet-head");
    const titleBlock = create("div", "install-sheet-title");
    titleBlock.append(create("span", "install-sheet-kicker", copy.kicker));
    titleBlock.append(create("h2", "", copy.title));
    const closeButton = create("button", "install-sheet-close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Закрыть");
    closeButton.addEventListener("click", () => closeInstallSheet());
    header.append(titleBlock, closeButton);

    const intro = create("p", "install-sheet-lead", copy.lead);
    const preview = createInstallPreview();
    const steps = create("ol", "install-steps");
    copy.steps.forEach((step, index) => {
      const item = create("li");
      item.append(create("span", "install-step-number", String(index + 1)), create("span", "", step));
      steps.append(item);
    });

    const footer = create("div", "install-sheet-actions");
    const primary = create("button", "primary-button install-primary-button", copy.primaryLabel);
    primary.type = "button";
    primary.addEventListener("click", () => handleInstallPrimary(primary));
    const later = create("button", "install-secondary-button", copy.secondaryLabel);
    later.type = "button";
    later.addEventListener("click", () => closeInstallSheet());
    footer.append(primary, later);

    panel.append(handle, header, preview, intro, steps, footer);
    root.append(backdrop, panel);
    document.body.append(root);

    installSheet = root;
    installRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("is-install-sheet-open");
    document.addEventListener("keydown", handleInstallSheetKeydown);
    if (options.source === "auto") rememberInstallPrompt();
    requestAnimationFrame(() => root.classList.add("is-open"));
    window.setTimeout(() => primary.focus({ preventScroll: true }), 120);
  }

  function createInstallPreview() {
    const preview = create("div", "install-preview");
    const phone = create("div", "install-preview-phone");
    const icon = create("span", "install-preview-icon");
    const image = create("img");
    image.src = "/bus-park-logo-light-clean.webp?v=20260712-crest";
    image.alt = "";
    icon.append(image);
    phone.append(icon, create("strong", "", "Автобусы"), create("span", "", "Барановичи"));
    preview.append(phone, create("span", "install-preview-shadow"));
    return preview;
  }

  async function handleInstallPrimary(button) {
    const mode = currentInstallMode();

    if (mode === "telegram-native") {
      button.disabled = true;
      tg?.HapticFeedback?.impactOccurred?.("light");

      try {
        tg.addToHomeScreen();
        rememberInstallPrompt();
        showToast("Подтвердите добавление в окне Telegram.");
        window.setTimeout(requestTelegramHomeScreenStatus, 1600);
      } catch {
        telegramHomeScreenStatus = "unsupported";
        showToast("Этот Telegram не смог открыть установку.");
      } finally {
        button.disabled = false;
        renderInstallEntryPoint();
      }
      return;
    }

    if (mode === "native" && deferredInstallPrompt) {
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      button.disabled = true;

      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice?.outcome === "accepted") {
          safeStorage.setItem(PWA_INSTALL_ACCEPTED_KEY, "1");
          showToast("Приложение добавляется на главный экран.");
          closeInstallSheet({ remember: false, restoreFocus: false });
        } else {
          rememberInstallPrompt();
          showToast("Можно установить позже через кнопку в шапке.");
          closeInstallSheet({ remember: false });
        }
      } catch (error) {
        showToast("Откройте меню браузера и добавьте приложение на экран.");
      } finally {
        button.disabled = false;
        renderInstallEntryPoint();
      }
      return;
    }

    if (mode === "telegram-manual") {
      rememberInstallPrompt();
      showToast("Обновите Telegram и попробуйте снова.");
      return;
    }

    if (mode === "ios" && !isSafariBrowser()) {
      const copied = await copyText(window.location.href);
      showToast(copied ? "Ссылка скопирована. Откройте её в Safari." : "Откройте страницу в Safari и добавьте на экран.");
      rememberInstallPrompt();
      closeInstallSheet({ remember: false });
      return;
    }

    closeInstallSheet();
  }

  function closeInstallSheet(options = {}) {
    if (!installSheet) return;
    const node = installSheet;
    installSheet = null;

    if (options.remember !== false) rememberInstallPrompt();
    document.removeEventListener("keydown", handleInstallSheetKeydown);
    document.body.classList.remove("is-install-sheet-open");
    node.classList.remove("is-open");

    window.setTimeout(() => node.remove(), 220);
    if (options.restoreFocus !== false) {
      window.setTimeout(() => installRestoreFocus?.focus?.({ preventScroll: true }), 240);
    }
    installRestoreFocus = null;
  }

  function handleInstallSheetKeydown(event) {
    if (event.key === "Escape") closeInstallSheet();
  }

  function rememberInstallPrompt() {
    safeStorage.setItem(PWA_INSTALL_LAST_PROMPT_KEY, String(Date.now()));
  }

  function installSheetCopy() {
    const mode = currentInstallMode();

    if (mode === "native") {
      return {
        kicker: "Android / Chrome",
        title: "Добавить на главный экран",
        lead: "Браузер готов установить приложение. После установки оно откроется как отдельная иконка без поиска ссылки.",
        primaryLabel: "Установить",
        secondaryLabel: "Позже",
        steps: [
          "Нажмите «Установить».",
          "Подтвердите добавление в системном окне.",
          "Откройте «Автобусы» с главного экрана."
        ]
      };
    }

    if (mode === "telegram-native") {
      return {
        kicker: "Telegram",
        title: "Добавить из Telegram",
        lead: "Telegram может создать ярлык Mini App прямо на главном экране телефона. Браузер открывать не нужно.",
        primaryLabel: "Добавить на экран",
        secondaryLabel: "Позже",
        steps: [
          "Нажмите «Добавить на экран».",
          "В системном окне Telegram разрешите создание ярлыка.",
          "Откройте «Автобусы» с главного экрана — приложение запустится сразу в Telegram."
        ]
      };
    }

    if (mode === "telegram-manual") {
      return {
        kicker: "Telegram",
        title: "Нужен свежий Telegram",
        lead: "В этой версии Telegram нативное добавление на главный экран недоступно. Обычно помогает обновление приложения; если пункт уже есть в меню Mini App, используйте его.",
        primaryLabel: "Понятно",
        secondaryLabel: "Позже",
        steps: [
          "Обновите Telegram до последней версии.",
          "Откройте это Mini App снова из бота.",
          "Нажмите кнопку добавления в приложении или пункт «Добавить на главный экран» в меню Telegram."
        ]
      };
    }

    if (mode === "ios") {
      const isSafari = isSafariBrowser();
      return {
        kicker: "iPhone / Safari",
        title: "Добавить на экран «Домой»",
        lead: isSafari
          ? "На iPhone установка делается через меню Safari: «Поделиться» → «На экран Домой»."
          : "На iPhone добавление работает через Safari. Скопируйте ссылку, откройте её в Safari и добавьте на экран «Домой».",
        primaryLabel: isSafari ? "Понятно" : "Скопировать ссылку",
        secondaryLabel: "Позже",
        steps: [
          isSafari ? "Нажмите «Поделиться» внизу Safari." : "Откройте эту страницу в Safari.",
          "Выберите пункт «На экран Домой».",
          "Нажмите «Добавить» — иконка появится рядом с приложениями."
        ]
      };
    }

    if (mode === "android") {
      return {
        kicker: "Android",
        title: "Добавить на главный экран",
        lead: "Если системная кнопка установки не появилась, добавьте приложение через меню браузера.",
        primaryLabel: "Понятно",
        secondaryLabel: "Позже",
        steps: [
          "Откройте меню браузера в правом верхнем углу.",
          "Выберите «Установить приложение» или «Добавить на главный экран».",
          "Подтвердите добавление и откройте иконку «Автобусы»."
        ]
      };
    }

    return {
      kicker: "Быстрый доступ",
      title: "Добавить приложение",
      lead: "В поддерживаемом браузере приложение можно закрепить на главном экране и открывать одной кнопкой.",
      primaryLabel: "Понятно",
      secondaryLabel: "Позже",
      steps: [
        "Откройте приложение на телефоне.",
        "Используйте меню браузера или кнопку «Поделиться».",
        "Выберите добавление на главный экран."
      ]
    };
  }

  function currentInstallMode() {
    if (isTelegramWebView() && supportsTelegramHomeScreenShortcut() && telegramHomeScreenStatus !== "unsupported") return "telegram-native";
    if (isTelegramWebView()) return "telegram-manual";
    if (deferredInstallPrompt) return "native";
    if (isIosDevice()) return "ios";
    if (isAndroidDevice()) return "android";
    return "desktop";
  }

  function isStandaloneApp() {
    return Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator?.standalone);
  }

  function isMobileInstallContext() {
    return Boolean(isIosDevice() || isAndroidDevice() || window.matchMedia?.("(pointer: coarse)")?.matches);
  }

  function isTelegramWebView() {
    const platform = String(tg?.platform || "").toLowerCase();
    return Boolean(tg?.initData || (platform && platform !== "unknown"));
  }

  function supportsTelegramHomeScreenShortcut() {
    return Boolean(
      isTelegramWebView()
      && typeof tg?.addToHomeScreen === "function"
      && typeof tg?.checkHomeScreenStatus === "function"
      && (!tg.isVersionAtLeast || tg.isVersionAtLeast("8.0"))
    );
  }

  function normalizeTelegramHomeScreenStatus(value) {
    const status = String(value || "").trim().toLowerCase();
    return ["unsupported", "unknown", "added", "missed"].includes(status) ? status : "";
  }

  function isIosDevice() {
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isAndroidDevice() {
    return /Android/i.test(navigator.userAgent || "");
  }

  function isSafariBrowser() {
    const ua = navigator.userAgent || "";
    return /Safari/i.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|SamsungBrowser)/i.test(ua);
  }

  function openCurrentPageExternally() {
    const url = window.location.href;
    if (tg?.openLink) {
      tg.openLink(url);
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function bindEvents() {
    const renderRoutesDebounced = debounce(() => renderRoutes(), 380);
    const renderHomeStopOptionsDebounced = debounce(() => renderHomeStopOptions(), 120);
    ensureRoutesFilterTabs();
    if (els.routeSearch) {
      els.routeSearch.placeholder = "Номер маршрута или остановка";
    }

    window.addEventListener("hashchange", () => {
      if (internalViewHashUpdate) return;
      const view = initialView();
      if (view !== state.activeView) setView(view);
    });

    els.bottomNav?.addEventListener("click", (event) => {
      const settingsButton = event.target.closest("[data-settings-nav]");
      if (settingsButton) {
        event.preventDefault();
        openStaffSettings();
        return;
      }

      const button = event.target.closest("[data-nav]");
      if (!button || !els.bottomNav.contains(button)) return;
      event.preventDefault();
      if (button.dataset.nav === "appeal") {
        openFeedbackBot();
        return;
      }
      setView(button.dataset.nav, { source: "bottom-nav" });
    });
    document.querySelectorAll("[data-open-view]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (button.dataset.openView === "appeal") {
          openFeedbackBot();
          return;
        }
        if (button.dataset.routeNumber) {
          openRouteByNumber(button.dataset.routeNumber, button.dataset.transportType || "city");
          return;
        }
        if (button.dataset.openView === "routes" && button.dataset.transportType) {
          setTransportType(button.dataset.transportType || "city", {
            preserveRouteSearch: button.dataset.preserveRouteSearch === "true"
          });
          setView("routes", { source: "transport-choice", resetScroll: true });
          return;
        }
        setView(button.dataset.openView, { source: "button" });
      });
    });
    document.querySelectorAll("[data-transport-type]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.openView) return;
        setTransportType(button.dataset.transportType || "city", {
          preserveRouteSearch: button.dataset.preserveRouteSearch === "true"
        });
      });
    });
    els.aboutShowAll?.addEventListener("click", () => {
      state.aboutDepartment = "all";
      state.aboutTab = "all";
      state.aboutSearch = "";
      if (els.aboutSearch) els.aboutSearch.value = "";
      state.expandedDepartments.clear();
      renderLeadership();
      els.aboutPeople?.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "start" });
    });
    els.aboutSearch?.addEventListener("input", () => {
      state.aboutSearch = els.aboutSearch.value;
      renderLeadership();
      queueLeadershipSearchScroll();
    });
    els.aboutFilterButton?.addEventListener("click", openAboutFilterSheet);
    els.aboutFilterBackdrop?.addEventListener("click", closeAboutFilterSheet);
    els.aboutFilterClose?.addEventListener("click", closeAboutFilterSheet);
    els.serviceView?.addEventListener("click", handleServiceClick);
    els.newsFilters?.querySelectorAll("[data-news-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.newsFilter = button.dataset.newsFilter || "all";
        renderNews();
      });
    });
    document.querySelectorAll("[data-email-link]").forEach((link) => {
      link.addEventListener("click", handleEmailLink);
    });
    document.addEventListener("pointerdown", pressFeedback, { passive: true });
    document.addEventListener("pointermove", cancelPressOnMove, { passive: true });
    document.addEventListener("pointerup", clearPressFeedback, { passive: true });
    document.addEventListener("pointercancel", clearPressFeedback, { passive: true });
    document.addEventListener("click", closeFavoriteMenus);
    window.addEventListener("scroll", clearPressFeedback, { passive: true });

    const dayModeButtons = [...document.querySelectorAll("[data-day-mode]")];
    dayModeButtons.forEach((button, index) => {
      button.addEventListener("click", () => {
        state.dayMode = button.dataset.dayMode;
        state.dayModeExplicit = true;
        syncDayModeButtons();
        state.selectedDeparture = null;
        state.selectedDepartureMode = "auto";
        queueScheduleScroll();
        renderSchedule();
        flushScheduleScroll();
      });
      button.addEventListener("keydown", (event) => handleDayModeKeydown(event, dayModeButtons, index));
    });

    els.routeSelect.addEventListener("change", async () => {
      state.missingRouteNumber = "";
      state.routeId = els.routeSelect.value;
      const direction = defaultDirectionForRoute(activeRoute());
      state.directionCode = direction?.code || "";
      state.stopUid = defaultStopForDirection(direction)?.id || "";
      resetStopFilter();
      renderRouteSelectors();
      queueScheduleScroll();
      await loadSchedule();
    });

    els.directionSelect.addEventListener("change", async () => {
      state.missingRouteNumber = "";
      state.directionCode = els.directionSelect.value;
      state.stopUid = defaultStopForDirection(activeDirection())?.id || "";
      resetStopFilter();
      renderRouteSelectors();
      queueScheduleScroll();
      await loadSchedule();
    });

    els.stopSelect.addEventListener("change", async () => {
      state.missingRouteNumber = "";
      state.stopUid = els.stopSelect.value;
      queueScheduleScroll();
      await loadSchedule();
    });

    if (els.stopSearch) {
      els.stopSearch.addEventListener("input", () => {
        state.stopSearch = els.stopSearch.value.trim().toLocaleLowerCase("ru-RU");
        state.showAllStops = false;
        renderStops();
        if (state.stopSearch) scrollStopsIntoView();
      });
    }

    els.routeSearch.addEventListener("input", () => {
      state.routeFilter = els.routeSearch.value.trim();
      renderRoutesDebounced();
    });

    els.homeRouteSearchOpen?.addEventListener("click", () => openHomeRouteSearchMenu());
    els.homeRouteSearchClose?.addEventListener("click", () => closeHomeRouteSearchMenu());
    els.homeRouteSearchBackdrop?.addEventListener("click", () => closeHomeRouteSearchMenu());
    els.homeRouteSearchMenu?.addEventListener("keydown", handleHomeRouteSearchMenuKeydown);
    els.homeRouteSearchForm?.addEventListener("submit", handleHomeRouteSearchSubmit);
    els.homeRouteEditButton?.addEventListener("click", expandHomeRouteSearchForm);
    els.homeFromInput?.addEventListener("input", () => {
      updateHomeStopInput("from", els.homeFromInput.value);
      renderHomeRouteSearch();
      renderHomeStopOptionsDebounced();
    });
    els.homeToInput?.addEventListener("input", () => {
      updateHomeStopInput("to", els.homeToInput.value);
      renderHomeRouteSearch();
      renderHomeStopOptionsDebounced();
    });
    // После открытия экранной клавиатуры вьюпорт сжимается (meta
    // interactive-widget=resizes-content) — дотягиваем поле в видимую зону
    // скролла меню, иначе оно оказывается за клавиатурой (жалоба владельца).
    const scrollHomeInputIntoView = (input) => {
      window.setTimeout(() => {
        if (document.activeElement === input) input.scrollIntoView({ block: "nearest" });
      }, 260);
    };
    els.homeFromInput?.addEventListener("focus", () => {
      activateHomeStopOptions("from", els.homeFromInput.value);
      renderHomeStopOptions();
      scrollHomeInputIntoView(els.homeFromInput);
    });
    els.homeToInput?.addEventListener("focus", () => {
      activateHomeStopOptions("to", els.homeToInput.value);
      renderHomeStopOptions();
      scrollHomeInputIntoView(els.homeToInput);
    });
    els.homeFromInput?.addEventListener("blur", scheduleHideHomeStopOptions);
    els.homeToInput?.addEventListener("blur", scheduleHideHomeStopOptions);
    els.homeFromInput?.addEventListener("keydown", handleHomeStopInputKeydown);
    els.homeToInput?.addEventListener("keydown", handleHomeStopInputKeydown);
    els.homeDateInput?.addEventListener("change", () => {
      state.homeRouteSearch.date = els.homeDateInput.value;
    });
    els.homeTimeInput?.addEventListener("change", () => {
      state.homeRouteSearch.time = els.homeTimeInput.value;
    });
    els.homeNowButton?.addEventListener("click", () => {
      setHomeRouteSearchNow();
      handleHomeRouteSearchSubmit();
    });
    els.homeRouteSwapButton?.addEventListener("click", () => {
      const from = els.homeFromInput?.value || "";
      const to = els.homeToInput?.value || "";
      state.homeRouteSearch.fromQuery = to;
      state.homeRouteSearch.toQuery = from;
      if (els.homeFromInput) els.homeFromInput.value = to;
      if (els.homeToInput) els.homeToInput.value = from;
      state.homeRouteSearch.results = [];
      state.homeRouteSearch.error = "";
      state.homeRouteSearch.isCompact = false;
      hideHomeStopOptions();
      renderHomeRouteSearch();
    });

    els.changeRouteButton.addEventListener("click", () => setView("routes"));
    els.directionSwapButton?.addEventListener("click", () => switchDirection().catch((error) => console.error(error)));

    els.themeToggle?.remove();

    els.appealForm.addEventListener("submit", submitAppeal);
    els.appealForm.elements.text?.addEventListener("input", () => {
      updateAppealProgress();
      saveAppealDraft();
    });
    els.appealForm.elements.attachmentFiles?.addEventListener("change", handleAppealFilesChanged);
    els.appealForm.querySelectorAll('input[name="category"]').forEach((input) => {
      input.addEventListener("change", () => {
        updateAppealProgress();
        saveAppealDraft();
      });
    });
    restoreAppealDraft();
    updateAppealFileState();
    els.appealBotButton?.addEventListener("click", openFeedbackBot);
    els.clientChatForm.addEventListener("submit", sendClientChatMessage);
    els.clientChatForm.elements.text?.addEventListener("input", () => {
      syncAppealFormText(els.clientChatForm.elements.text.value);
      saveAppealDraft();
    });
    els.clientChatAttachButton?.addEventListener("click", () => els.clientChatAttachmentInput?.click());
    els.clientChatAttachmentInput?.addEventListener("change", handleClientChatFilesChanged);
    els.imageViewerBackdrop.addEventListener("click", closeImageViewer);
    els.imageViewerClose.addEventListener("click", closeImageViewer);
    els.newsDetailBackdrop?.addEventListener("click", closeNewsDetail);
    els.newsDetailClose?.addEventListener("click", closeNewsDetail);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeHomeRouteSearchMenu();
        closeImageViewer();
        closeNewsDetail();
        closeAboutFilterSheet();
        closeAlarmBottomSheet();
        closeServiceDetail();
      }
    });
  }

  function initialView() {
    // Deep-link карты из бота: #map, #map_route_<id>, #map_stop_<key>.
    // Точная цель сохраняется до того, как replaceViewHash перезапишет hash.
    const startParam = tg?.initDataUnsafe?.start_param || "";
    if (/^map(_|$)/.test(startParam)) {
      window.__mapDeepTarget = startParam;
      return "map";
    }
    if (location.hash === "#map" || location.hash.startsWith("#map_")) {
      window.__mapDeepTarget = location.hash.slice(1);
      return "map";
    }
    if (location.hash === "#routes") return "routes";
    if (location.hash === "#schedule") return "schedule";
    if (location.hash === "#favorites") return "favorites";
    if (location.hash === "#service") return "service";
    if (location.hash === "#about") return "about";
    return "home";
  }

  function rememberActiveViewScroll() {
    if (!state.activeView) return;
    state.viewScroll[viewScrollKey(state.activeView)] = Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || 0));
  }

  function viewScrollKey(view, type = state.transportType) {
    if (view === "routes" || view === "schedule") return `${view}:${type}`;
    return view;
  }

  function viewScrollTop(view) {
    return state.viewScroll[viewScrollKey(view)] || 0;
  }

  function resetTransportViewScroll(type = state.transportType) {
    state.viewScroll[viewScrollKey("routes", type)] = 0;
    state.viewScroll[viewScrollKey("schedule", type)] = 0;
  }

  function clampScrollTop(value) {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return Math.min(Math.max(0, Number(value) || 0), maxScroll);
  }

  function restoreViewScroll(view) {
    const target = viewScrollTop(view);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: clampScrollTop(target), left: 0, behavior: "auto" });
    });
  }

  function replaceViewHash(view) {
    const hashByView = {
      routes: "#routes",
      schedule: "#schedule",
      favorites: "#favorites",
      service: "#service",
      about: "#about",
      map: "#map"
    };
    const nextHash = hashByView[view] || "";
    const nextUrl = `${location.pathname}${location.search}${nextHash}`;
    const currentUrl = `${location.pathname}${location.search}${location.hash}`;
    if (nextUrl === currentUrl) return;

    internalViewHashUpdate = true;
    history.replaceState(null, "", nextUrl);
    window.setTimeout(() => {
      internalViewHashUpdate = false;
    }, 0);
  }

  function setInitialSelection() {
    const route = routesForActiveTransport()[0] || state.data.routes[0];
    const direction = defaultDirectionForRoute(route);
    state.routeId = route?.id || "";
    state.directionCode = direction?.code || "";
    state.stopUid = defaultStopForDirection(direction)?.id || "";
  }

  function renderAll() {
    renderTransportChoices();
    renderStaffSettingsNav();
    syncDayModeButtons();
    renderHomeRouteSearch();
    renderHomeStopOptions();
    renderHomePromo();
    renderAds();
    renderQuickRoutes();
    renderRouteSelectors();
    renderFavorites({ loadSchedules: state.activeView === "favorites" });
    renderHomeFavoriteRoutes({ loadSchedules: state.activeView === "home" });
    renderRoutes();
    renderLeadership();
    renderServiceScreen();
    renderClientChat();
  }

  function setTransportType(type, options = {}) {
    const nextType = TRANSPORT_MODES[type] ? type : "city";
    const preserveRouteSearch = options.preserveRouteSearch === true;
    const changedType = state.transportType !== nextType;
    const routesModeAnchor = changedType ? captureRoutesModeAnchor() : null;

    if (changedType) rememberActiveViewScroll();
    state.transportType = nextType;
    if (!preserveRouteSearch) {
      state.routeFilter = "";
      if (els.routeSearch) els.routeSearch.value = "";
    }
    state.missingRouteNumber = "";
    if (changedType) resetTransportViewScroll(nextType);

    if (changedType) {
      const route = routesForActiveTransport()[0];
      const direction = defaultDirectionForRoute(route);
      state.routeId = route?.id || "";
      state.directionCode = direction?.code || "";
      state.stopUid = defaultStopForDirection(direction)?.id || "";
      resetStopFilter();
    }
    renderTransportChoices();
    renderRouteSelectors();
    renderRoutes();
    restoreRoutesModeAnchor(routesModeAnchor);
    if (changedType && state.activeView === "schedule") {
      loadSchedule();
    }
  }

  function captureRoutesModeAnchor() {
    if (state.activeView !== "routes") return null;
    const switcher = document.querySelector(".routes-mode-switch");
    if (!switcher) return null;
    return {
      scrollY: Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || 0)),
      top: switcher.getBoundingClientRect().top
    };
  }

  function restoreRoutesModeAnchor(anchor) {
    if (!anchor || state.activeView !== "routes") return;
    let attempts = 0;
    const restore = () => {
      if (state.activeView !== "routes") return;
      const switcher = document.querySelector(".routes-mode-switch");
      if (!switcher) return;
      const delta = switcher.getBoundingClientRect().top - anchor.top;
      const currentTop = Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || 0));
      const targetTop = Math.abs(delta) >= 1 ? currentTop + delta : anchor.scrollY;
      window.scrollTo({ top: clampScrollTop(Math.max(anchor.scrollY, targetTop)), left: 0, behavior: "auto" });
      attempts += 1;
      if (attempts < 4) window.setTimeout(restore, attempts === 1 ? 40 : 80);
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
  }

  function renderTransportChoices() {
    document.querySelectorAll("[data-transport-type]").forEach((button) => {
      const isActive = button.dataset.transportType === state.transportType;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    document.querySelectorAll(".routes-mode-button[data-transport-type]").forEach((button) => {
      const type = button.dataset.transportType || "city";
      const config = TRANSPORT_MODES[type] || TRANSPORT_MODES.city;
      button.setAttribute("aria-label", config.label);
    });
    const config = activeTransportConfig();
    if (els.transportChoiceHint) {
      const count = routesForActiveTransport().length;
      els.transportChoiceHint.textContent = count
        ? "Выберите один из пунктов, чтобы продолжить"
        : config.empty;
    }
  }

  function activeTransportConfig() {
    return TRANSPORT_MODES[state.transportType] || TRANSPORT_MODES.city;
  }

  function ensureHomeRouteSearchDateTime() {
    if (!state.homeRouteSearch.date || !state.homeRouteSearch.time) {
      const now = new Date();
      if (!state.homeRouteSearch.date) state.homeRouteSearch.date = localDateKey(now);
      if (!state.homeRouteSearch.time) state.homeRouteSearch.time = timeInputValue(now);
    }
    if (els.homeDateInput) els.homeDateInput.value = state.homeRouteSearch.date;
    if (els.homeTimeInput) els.homeTimeInput.value = state.homeRouteSearch.time;
  }

  function setHomeRouteSearchNow() {
    const now = new Date();
    state.homeRouteSearch.date = localDateKey(now);
    state.homeRouteSearch.time = timeInputValue(now);
    if (els.homeDateInput) els.homeDateInput.value = state.homeRouteSearch.date;
    if (els.homeTimeInput) els.homeTimeInput.value = state.homeRouteSearch.time;
  }

  function updateHomeStopInput(target, value) {
    if (target === "from") state.homeRouteSearch.fromQuery = value;
    if (target === "to") state.homeRouteSearch.toQuery = value;
    state.homeRouteSearch.stopOptionTarget = target;
    state.homeRouteSearch.stopOptionQuery = value;
    state.homeRouteSearch.stopOptionActiveIndex = -1;
    state.homeRouteSearch.results = [];
    state.homeRouteSearch.error = "";
    state.homeRouteSearch.isCompact = false;
    cancelHomeStopOptionsHide();
  }

  function activateHomeStopOptions(target, value) {
    state.homeRouteSearch.stopOptionTarget = target;
    state.homeRouteSearch.stopOptionQuery = value;
    state.homeRouteSearch.stopOptionActiveIndex = -1;
    cancelHomeStopOptionsHide();
  }

  function cancelHomeStopOptionsHide() {
    if (!homeStopOptionsHideTimer) return;
    window.clearTimeout(homeStopOptionsHideTimer);
    homeStopOptionsHideTimer = null;
  }

  function scheduleHideHomeStopOptions() {
    cancelHomeStopOptionsHide();
    homeStopOptionsHideTimer = window.setTimeout(() => hideHomeStopOptions(), 120);
  }

  function hideHomeStopOptions() {
    cancelHomeStopOptionsHide();
    state.homeRouteSearch.stopOptionTarget = "";
    state.homeRouteSearch.stopOptionQuery = "";
    state.homeRouteSearch.stopOptionActiveIndex = -1;
    if (els.homeStopOptions) {
      clear(els.homeStopOptions);
      els.homeStopOptions.hidden = true;
    }
    syncHomeStopInputA11y(false);
  }

  function blurHomeRouteSearchInputs() {
    [els.homeFromInput, els.homeToInput, els.homeDateInput, els.homeTimeInput].forEach((input) => {
      if (input && typeof input.blur === "function") input.blur();
    });
  }

  function handleHomeStopInputKeydown(event) {
    const items = homeStopOptionItems();
    const hasItems = items.length > 0 && !els.homeStopOptions?.hidden;
    if (event.key === "ArrowDown" || event.key === "Down") {
      if (!items.length) return;
      event.preventDefault();
      state.homeRouteSearch.stopOptionActiveIndex =
        (state.homeRouteSearch.stopOptionActiveIndex + 1 + items.length) % items.length;
      renderHomeStopOptions();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "Up") {
      if (!items.length) return;
      event.preventDefault();
      state.homeRouteSearch.stopOptionActiveIndex =
        (state.homeRouteSearch.stopOptionActiveIndex - 1 + items.length) % items.length;
      renderHomeStopOptions();
      return;
    }
    if (event.key === "Enter" && hasItems && state.homeRouteSearch.stopOptionActiveIndex >= 0) {
      event.preventDefault();
      selectHomeStopOption(items[state.homeRouteSearch.stopOptionActiveIndex]);
      return;
    }
    if (event.key === "Escape" && hasItems) {
      event.preventDefault();
      hideHomeStopOptions();
    }
  }

  function selectHomeStopOption(name) {
    const target = state.homeRouteSearch.stopOptionTarget;
    const input = target === "from" ? els.homeFromInput : target === "to" ? els.homeToInput : null;
    if (target === "from") state.homeRouteSearch.fromQuery = name;
    if (target === "to") state.homeRouteSearch.toQuery = name;
    if (input) input.value = name;
    state.homeRouteSearch.results = [];
    state.homeRouteSearch.error = "";
    state.homeRouteSearch.isCompact = false;
    hideHomeStopOptions();
    renderHomeRouteSearch();
  }

  function expandHomeRouteSearchForm() {
    state.homeRouteSearch.isCompact = false;
    renderHomeRouteSearch();
    window.requestAnimationFrame(() => {
      els.homeRouteSearchMenu?.scrollTo({ top: 0, behavior: "auto" });
      const target = !state.homeRouteSearch.fromQuery.trim()
        ? els.homeFromInput
        : !state.homeRouteSearch.toQuery.trim()
          ? els.homeToInput
          : els.homeFromInput;
      target?.focus?.({ preventScroll: true });
      if (target) {
        activateHomeStopOptions(target === els.homeToInput ? "to" : "from", target.value);
        renderHomeStopOptions();
      }
    });
  }

  function openHomeRouteSearchMenu() {
    if (!els.homeRouteSearchMenu) return;
    const activeElement = document.activeElement;
    if (activeElement && typeof activeElement.focus === "function" && document.body.contains(activeElement)) {
      homeRouteSearchRestoreFocus = activeElement;
    }
    state.homeRouteSearch.isOpen = true;
    renderHomeRouteSearch();
    renderHomeStopOptions();
    window.requestAnimationFrame(() => focusHomeRouteSearchMenu());
  }

  function closeHomeRouteSearchMenu(options = {}) {
    if (!state.homeRouteSearch.isOpen) return;
    const restoreFocus = options.restoreFocus !== false;
    const focusTarget = homeRouteSearchRestoreFocus || els.homeRouteSearchOpen;
    hideHomeStopOptions();
    blurHomeRouteSearchInputs();
    state.homeRouteSearch.isOpen = false;
    renderHomeRouteSearch();
    homeRouteSearchRestoreFocus = null;
    if (restoreFocus && focusTarget && typeof focusTarget.focus === "function") {
      window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    }
  }

  function focusHomeRouteSearchMenu() {
    if (!state.homeRouteSearch.isOpen) return;
    if (isMobileInstallContext()) {
      els.homeRouteSearchMenu?.focus?.({ preventScroll: true });
      return;
    }
    const target = !state.homeRouteSearch.fromQuery.trim()
      ? els.homeFromInput
      : !state.homeRouteSearch.toQuery.trim()
        ? els.homeToInput
        : els.homeSearchButton;
    target?.focus?.({ preventScroll: true });
  }

  function handleHomeRouteSearchMenuKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeHomeRouteSearchMenu();
      return;
    }
    if (event.key !== "Tab" || !state.homeRouteSearch.isOpen) return;
    const focusable = homeRouteSearchFocusableNodes();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function homeRouteSearchFocusableNodes() {
    if (!els.homeRouteSearchMenu) return [];
    const selector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    return Array.from(els.homeRouteSearchMenu.querySelectorAll(selector))
      .filter((node) => !node.hidden && node.getClientRects().length > 0);
  }

  function syncHomeRouteSearchMenu() {
    const isOpen = Boolean(state.homeRouteSearch.isOpen);
    const isCompact = Boolean(state.homeRouteSearch.isCompact && state.homeRouteSearch.results.length);
    els.homeRouteSearch?.classList.toggle("is-menu-open", isOpen);
    if (els.homeRouteSearchOpen) {
      els.homeRouteSearchOpen.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }
    if (els.homeRouteSearchMenu) {
      els.homeRouteSearchMenu.hidden = !isOpen;
      els.homeRouteSearchMenu.classList.toggle("is-open", isOpen);
      els.homeRouteSearchMenu.classList.toggle("is-results-mode", isCompact);
      // Высоту шторки ограничивает CSS (min(88svh, 100vh-16px)): после того как
      // из view-enter убран transform, containing block меню — вьюпорт, и
      // потолок корректен сам по себе. JS-кламп по top здесь ЗАПРЕЩЁН: у
      // прибитой к низу шторки top = vh - height, и такой кламп рекурсивно
      // сжимает панель на 12px за вызов (баг 2026-07-12 на телефонах).
      if (!isOpen) {
        els.homeRouteSearchMenu.style.removeProperty("max-height");
      }
    }
    if (els.homeRouteSearchBackdrop) {
      els.homeRouteSearchBackdrop.hidden = !isOpen;
      els.homeRouteSearchBackdrop.classList.toggle("is-open", isOpen);
    }
    document.body.classList.toggle("is-home-route-search-open", isOpen);
  }

  // Structured launcher summary (mockup layout): route line, big route numbers,
  // time line with an amber "через N мин" accent. Falls back to plain text when
  // there is no live result.
  function renderLauncherSummary(node) {
    const launcher = els.homeRouteSearchOpen || document.getElementById("homeRouteSearchOpen");
    const etaEl = document.getElementById("homeRouteLauncherEta");
    const first = state.homeRouteSearch.results?.[0];
    if (!first || state.homeRouteSearch.loading) {
      node.textContent = homeRouteSearchLauncherSummary();
      if (launcher) launcher.classList.remove("has-eta");
      if (etaEl) etaEl.textContent = "";
      return;
    }
    clear(node);
    const shortStop = (value) => {
      const text = String(value || "").trim();
      return text.length > 18 ? `${text.slice(0, 17)}…` : text;
    };
    const from = shortStop(state.homeRouteSearch.fromQuery);
    const to = shortStop(state.homeRouteSearch.toQuery);
    if (from && to) node.append(create("span", "launcher-route", `${from} → ${to}`));
    const isTransferTrip = first.type === "transfer" && first.legs?.length === 2;
    const numbers = isTransferTrip
      ? `№${first.legs[0].routeNumber} → №${first.legs[1].routeNumber}`
      : `№${first.routeNumber || "—"}`;
    node.append(create("b", "launcher-numbers", numbers));
    // «№11 → №14» без пояснения непонятен — говорим прямо, что это пересадка,
    // И на какой остановке она (раньше остановку пересадки не было видно).
    if (isTransferTrip) {
      node.append(create("small", "launcher-transfer-note", "с пересадкой"));
      const transferStop = first.legs[0].toStopName || first.legs[1].fromStopName || "";
      if (transferStop) node.append(create("small", "launcher-transfer-stop", `пересадка на «${transferStop}»`));
    }
    const timeLine = create("span", "launcher-time");
    if (isTransferTrip) {
      // Раньше видели только время №12 — «когда идёт №14» было непонятно.
      // Теперь называем оба отправления явно.
      const l1 = first.legs[0];
      const l2 = first.legs[1];
      timeLine.append(document.createTextNode(`№${l1.routeNumber} в `));
      timeLine.append(create("b", "launcher-depart", l1.departureTime || "—"));
      timeLine.append(document.createTextNode(` → №${l2.routeNumber} в `));
      timeLine.append(create("b", "launcher-depart", l2.departureTime || "—"));
    } else {
      timeLine.append(document.createTextNode(`№${first.routeNumber || "—"} отправится в `));
      timeLine.append(create("b", "launcher-depart", first.departureTime || "—"));
    }
    const wait = formatRouteSearchWait(first.waitMinutes);
    if (wait) {
      timeLine.append(document.createTextNode(" · "));
      timeLine.append(create("em", "launcher-wait", wait));
    }
    node.append(timeLine);
    // Правый блок «Отправление через N» — только чистое значение («37 мин»),
    // слово «через» уже в подписи. Класс has-eta включает блок в CSS.
    const etaValue = wait ? wait.replace(/^через\s+/i, "") : "";
    if (etaEl) etaEl.textContent = etaValue;
    if (launcher) launcher.classList.toggle("has-eta", Boolean(etaValue));
  }

  function homeRouteSearchLauncherSummary() {
    if (state.homeRouteSearch.loading) return "Ищем ближайший рейс...";
    const from = compactHomeRouteStopLabel(state.homeRouteSearch.fromQuery);
    const to = compactHomeRouteStopLabel(state.homeRouteSearch.toQuery);
    const first = state.homeRouteSearch.results?.[0];
    if (first) {
      const wait = formatRouteSearchWait(first.waitMinutes);
      const isTransferTrip = first.type === "transfer" && first.legs?.length === 2;
      const numberLabel = isTransferTrip
        ? `№${first.legs[0].routeNumber}→№${first.legs[1].routeNumber} (с пересадкой)`
        : `№${first.routeNumber || "—"}`;
      const departLeg = isTransferTrip ? `№${first.legs[0].routeNumber}` : numberLabel;
      const tripLine = [`${numberLabel}: ${departLeg} отправится в ${first.departureTime || "—"}`, wait].filter(Boolean).join(" · ");
      // Two-line summary: the route (from -> to) plus the live answer. Tighter
      // truncation than the generic label so the route stays on one line at 375px.
      const shortStop = (value) => {
        const text = String(value || "").trim();
        return text.length > 16 ? `${text.slice(0, 15)}…` : text;
      };
      const shortFrom = shortStop(state.homeRouteSearch.fromQuery);
      const shortTo = shortStop(state.homeRouteSearch.toQuery);
      const routeLine = shortFrom && shortTo ? `${shortFrom} → ${shortTo}` : "";
      return routeLine ? `${routeLine}\n${tripLine}` : tripLine;
    }
    if (from && to) return `${from} → ${to}`;
    if (from) return `Откуда: ${from}`;
    if (to) return `Куда: ${to}`;
    return "Откуда, куда и время";
  }

  function compactHomeRouteStopLabel(value) {
    const text = String(value || "").trim();
    return text.length > 22 ? `${text.slice(0, 21)}…` : text;
  }

  function renderHomeRouteSearch() {
    if (!els.homeRouteSearchForm) return;
    syncHomeRouteSearchMenu();
    ensureHomeRouteSearchDateTime();
    if (els.homeFromInput && els.homeFromInput.value !== state.homeRouteSearch.fromQuery) {
      els.homeFromInput.value = state.homeRouteSearch.fromQuery;
    }
    if (els.homeToInput && els.homeToInput.value !== state.homeRouteSearch.toQuery) {
      els.homeToInput.value = state.homeRouteSearch.toQuery;
    }
    if (els.homeRouteSearchLauncherSummary) {
      renderLauncherSummary(els.homeRouteSearchLauncherSummary);
    }

    const isLoading = Boolean(state.homeRouteSearch.loading);
    const isCompact = Boolean(
      state.homeRouteSearch.isCompact
      && state.homeRouteSearch.results.length
      && !isLoading
      && !state.homeRouteSearch.error
    );
    els.homeRouteSearchForm.classList.toggle("is-compact", isCompact);
    if (els.homeRouteSearchCompact) {
      els.homeRouteSearchCompact.hidden = !isCompact;
    }
    if (els.homeRouteSearchCompactTitle) {
      els.homeRouteSearchCompactTitle.textContent = [
        compactHomeRouteStopLabel(state.homeRouteSearch.fromQuery) || "Откуда",
        compactHomeRouteStopLabel(state.homeRouteSearch.toQuery) || "Куда"
      ].join(" → ");
    }
    if (els.homeRouteSearchCompactMeta) {
      els.homeRouteSearchCompactMeta.textContent = [
        formatHomeRouteSearchDate(state.homeRouteSearch.date),
        state.homeRouteSearch.time || ""
      ].filter(Boolean).join(" · ");
    }
    if (els.homeSearchButton) {
      els.homeSearchButton.disabled = isLoading;
      els.homeSearchButton.hidden = isCompact;
      els.homeSearchButton.textContent = isLoading ? "Ищем ближайшие..." : "Показать ближайшие";
    }
    if (els.homeNowButton) els.homeNowButton.disabled = isLoading;
    if (els.homeRouteSwapButton) els.homeRouteSwapButton.disabled = isLoading;

    const status = state.homeRouteSearch.error || "";
    if (els.homeRouteSearchStatus) {
      els.homeRouteSearchStatus.hidden = !status;
      els.homeRouteSearchStatus.textContent = status;
      els.homeRouteSearchStatus.classList.toggle("is-error", Boolean(state.homeRouteSearch.error));
    }

    renderHomeRouteResults();
  }

  function formatHomeRouteSearchDate(value) {
    const date = parseLocalDateInput(value);
    if (!value || Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function renderHomeStopOptions() {
    if (!els.homeStopOptions) return;
    placeHomeStopOptions();
    clear(els.homeStopOptions);
    const items = homeStopOptionItems();
    const visible = state.homeRouteSearch.isOpen && items.length > 0;
    if (!visible) {
      els.homeStopOptions.hidden = true;
      state.homeRouteSearch.stopOptionActiveIndex = -1;
      syncHomeStopInputA11y(false);
      return;
    }

    const maxIndex = items.length - 1;
    if (state.homeRouteSearch.stopOptionActiveIndex > maxIndex) {
      state.homeRouteSearch.stopOptionActiveIndex = maxIndex;
    }
    if (state.homeRouteSearch.stopOptionActiveIndex < -1) {
      state.homeRouteSearch.stopOptionActiveIndex = -1;
    }

    els.homeStopOptions.hidden = false;
    items.forEach((name, index) => {
      const isActive = index === state.homeRouteSearch.stopOptionActiveIndex;
      const option = create("button", `home-stop-suggestion${isActive ? " is-active" : ""}`, name);
      option.id = `homeStopOption${index}`;
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", isActive ? "true" : "false");
      option.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        cancelHomeStopOptionsHide();
      });
      option.addEventListener("click", () => selectHomeStopOption(name));
      els.homeStopOptions.append(option);
    });
    syncHomeStopInputA11y(true);
  }

  function placeHomeStopOptions() {
    if (!els.homeStopOptions) return;
    const target = state.homeRouteSearch.stopOptionTarget;
    const input = target === "from" ? els.homeFromInput : target === "to" ? els.homeToInput : null;
    const host = input?.closest(".home-route-field") || els.homeRouteSearchForm;
    if (host && els.homeStopOptions.parentElement !== host) host.append(els.homeStopOptions);
  }

  function homeStopOptionItems() {
    const target = state.homeRouteSearch.stopOptionTarget;
    const query = normalizeStopHint(state.homeRouteSearch.stopOptionQuery || "");
    if (!target || query.length < HOME_STOP_SUGGESTION_MIN_QUERY) return [];
    const scored = [];
    homeStopNames().forEach(({ name, key }) => {
      if (!key.includes(query)) return;
      const words = key.split(/\s+/).filter(Boolean);
      const rank = key.startsWith(query) ? 0 : words.some((word) => word.startsWith(query)) ? 1 : 2;
      scored.push({ name, rank });
    });
    // Список уже отсортирован по алфавиту в кэше — стабильной сортировки по
    // rank достаточно, localeCompare на каждый тик больше не нужен.
    return scored
      .sort((left, right) => left.rank - right.rank)
      .slice(0, HOME_STOP_SUGGESTION_LIMIT)
      .map((item) => item.name);
  }

  function syncHomeStopInputA11y(isExpanded) {
    const target = state.homeRouteSearch.stopOptionTarget;
    const activeId = isExpanded && state.homeRouteSearch.stopOptionActiveIndex >= 0
      ? `homeStopOption${state.homeRouteSearch.stopOptionActiveIndex}`
      : "";
    [
      ["from", els.homeFromInput],
      ["to", els.homeToInput]
    ].forEach(([inputTarget, input]) => {
      if (!input) return;
      const active = isExpanded && target === inputTarget;
      input.setAttribute("aria-expanded", active ? "true" : "false");
      if (activeId && active) {
        input.setAttribute("aria-activedescendant", activeId);
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    });
  }

  // Кэш: без него КАЖДЫЙ тик подсказок обходил ~9000 остановок и сортировал
  // ~2000 имён через localeCompare("ru") — десятки мс на телефоне, «лагает»
  // при вводе (жалоба владельца 2026-07-12). Данные меняются только с новым
  // state.data — кэшируем по ссылке; ключ нормализуем один раз здесь же.
  let homeStopNamesCacheData = null;
  let homeStopNamesCacheList = [];
  function homeStopNames() {
    if (homeStopNamesCacheData === state.data) return homeStopNamesCacheList;
    const seen = new Set();
    const list = [];
    (state.data?.routes || []).forEach((route) => {
      (route.directions || []).forEach((direction) => {
        routeStopsForDirection(direction).forEach((stop) => {
          const name = stopDisplayName(stop);
          const key = normalizeStopHint(name);
          if (!name || !key || seen.has(key)) return;
          seen.add(key);
          list.push({ name, key });
        });
      });
    });
    list.sort((left, right) => left.name.localeCompare(right.name, "ru"));
    homeStopNamesCacheData = state.data;
    homeStopNamesCacheList = list;
    return list;
  }

  async function handleHomeRouteSearchSubmit(event) {
    event?.preventDefault?.();
    ensureHomeRouteSearchDateTime();
    state.homeRouteSearch.fromQuery = (els.homeFromInput?.value || "").trim();
    state.homeRouteSearch.toQuery = (els.homeToInput?.value || "").trim();
    state.homeRouteSearch.date = els.homeDateInput?.value || state.homeRouteSearch.date;
    state.homeRouteSearch.time = els.homeTimeInput?.value || state.homeRouteSearch.time;
    hideHomeStopOptions();
    blurHomeRouteSearchInputs();

    if (!state.homeRouteSearch.fromQuery || !state.homeRouteSearch.toQuery) {
      state.homeRouteSearch.error = "Выберите, откуда и куда ехать.";
      state.homeRouteSearch.results = [];
      state.homeRouteSearch.isCompact = false;
      renderHomeRouteSearch();
      return;
    }

    const requestId = state.homeRouteSearch.requestId + 1;
    state.homeRouteSearch.requestId = requestId;
    state.homeRouteSearch.loading = true;
    state.homeRouteSearch.error = "";
    state.homeRouteSearch.isCompact = false;
    renderHomeRouteSearch();

    try {
      const query = new URLSearchParams({
        from: state.homeRouteSearch.fromQuery,
        to: state.homeRouteSearch.toQuery,
        date: state.homeRouteSearch.date,
        time: state.homeRouteSearch.time,
        limit: "4"
      });
      const response = await fetch(`/api/routes/search?${query}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Поиск временно недоступен.");
      if (requestId !== state.homeRouteSearch.requestId) return;
      state.homeRouteSearch.results = compactHomeRouteResults(Array.isArray(data.results) ? data.results : []);
      state.homeRouteSearch.fromMatches = Array.isArray(data.fromMatches) ? data.fromMatches : [];
      state.homeRouteSearch.toMatches = Array.isArray(data.toMatches) ? data.toMatches : [];
      state.homeRouteSearch.error = state.homeRouteSearch.results.length ? "" : homeRouteSearchEmptyMessage();
      state.homeRouteSearch.isCompact = state.homeRouteSearch.results.length > 0;
      // Remember the route across sessions — daily riders reopen the app for the
      // same trip, so tomorrow's cold start can answer without any typing.
      if (state.homeRouteSearch.results.length) rememberLastHomeRouteSearch();
    } catch (error) {
      if (requestId !== state.homeRouteSearch.requestId) return;
      state.homeRouteSearch.results = [];
      state.homeRouteSearch.error = error.message || "Поиск временно недоступен.";
      state.homeRouteSearch.isCompact = false;
    } finally {
      if (requestId === state.homeRouteSearch.requestId) {
        state.homeRouteSearch.loading = false;
        renderHomeRouteSearch();
        if (state.homeRouteSearch.results.length) {
          scrollHomeRouteSearchToResults();
        }
      }
    }
  }

  function rememberLastHomeRouteSearch() {
    try {
      safeStorage.setItem(LAST_ROUTE_SEARCH_KEY, JSON.stringify({
        from: state.homeRouteSearch.fromQuery,
        to: state.homeRouteSearch.toQuery,
        savedAt: new Date().toISOString()
      }));
    } catch {
      /* storage full/blocked — nothing to do */
    }
  }

  // Cold-start memory: restore the last successful route search and re-run it for
  // the current date/time, so the hero answers the daily rider's question with
  // zero taps. First-time users keep the static hint (nothing stored).
  function restoreLastHomeRouteSearch() {
    let saved = null;
    try {
      saved = JSON.parse(safeStorage.getItem(LAST_ROUTE_SEARCH_KEY) || "null");
    } catch {
      return;
    }
    const from = String(saved?.from || "").trim();
    const to = String(saved?.to || "").trim();
    if (!from || !to) return;
    // Don't clobber anything the user already typed in this session.
    if (state.homeRouteSearch.fromQuery || state.homeRouteSearch.toQuery) return;

    state.homeRouteSearch.fromQuery = from;
    state.homeRouteSearch.toQuery = to;
    // Fresh date/time for today; the stored ones would be stale by definition.
    state.homeRouteSearch.date = "";
    state.homeRouteSearch.time = "";
    if (els.homeDateInput) els.homeDateInput.value = "";
    if (els.homeTimeInput) els.homeTimeInput.value = "";
    renderHomeRouteSearch();
    if (state.activeView === "home") {
      handleHomeRouteSearchSubmit().catch(() => {});
    }
  }

  function scrollHomeRouteSearchToResults() {
    if (!state.homeRouteSearch.isOpen || !els.homeRouteSearchMenu || !els.homeRouteResults) return;
    window.requestAnimationFrame(() => {
      if (!els.homeRouteSearchMenu || !els.homeRouteResults || !els.homeRouteResults.getClientRects().length) return;
      const scroller = els.homeRouteSearchMenu;
      els.homeRouteResults.scrollTop = 0;
      if (state.homeRouteSearch.isCompact) {
        scroller.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = els.homeRouteResults.getBoundingClientRect();
      const targetTop = scroller.scrollTop + targetRect.top - scrollerRect.top - 8;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTo({ top: Math.min(Math.max(targetTop, 0), maxTop), behavior: "auto" });
    });
  }

  function homeRouteSearchEmptyMessage() {
    if (!state.homeRouteSearch.fromMatches.length) return "Не нашли остановку отправления в текущем расписании.";
    if (!state.homeRouteSearch.toMatches.length) return "Не нашли остановку назначения в текущем расписании.";
    return "Подходящих прямых рейсов на выбранное время нет. Попробуйте другое время или направление.";
  }

  function renderHomeRouteResults() {
    if (!els.homeRouteResults) return;
    clear(els.homeRouteResults);
    if (state.homeRouteSearch.loading) {
      els.homeRouteResults.append(homeRouteSearchSkeleton());
      return;
    }
    const results = state.homeRouteSearch.results || [];
    if (results.length) {
      const head = create("div", "home-route-results-head");
      head.append(
        create("strong", "", "Скоро поедут"),
        create("small", "", "Сначала ближайший рейс от выбранного времени")
      );
      els.homeRouteResults.append(head);
    }
    results.forEach((result, index) => {
      els.homeRouteResults.append(renderHomeRouteResult(result, index));
    });
  }

  function compactHomeRouteResults(results) {
    const visible = [];
    const seen = new Set();
    results.forEach((result) => {
      // Transfer variants through different hubs with identical times are the
      // same trip to the rider — dedupe by route pair + times, not by hub.
      const key = [
        result.transportType || "",
        result.routeNumber || result.routeId || "",
        result.fromStopName || "",
        result.toStopName || "",
        result.type === "transfer" ? `${result.departureTime}|${result.arrivalTime}` : ""
      ].join("|").toLocaleLowerCase("ru-RU");
      if (visible.length && Number(result.waitMinutes) > 1440) return;
      if (!key.trim() || seen.has(key)) return;
      seen.add(key);
      visible.push(result);
    });
    return visible.slice(0, 4);
  }

  function homeRouteSearchSkeleton() {
    // Shimmer-ряды в форме будущих результатов (чип номера · две строки ·
    // пилюля «Ехать») вместо текстовой карточки — воспринимается быстрее.
    const wrap = create("div", "home-route-results-skeleton");
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-label", "Ищем ближайшие рейсы");
    for (let i = 0; i < 2; i += 1) {
      const row = create("div", "sk-row sk-result-row");
      row.setAttribute("aria-hidden", "true");
      const lines = create("div", "sk-lines");
      lines.append(create("i", `sk sk-line sk-strong sk-w${i ? 55 : 70}`), create("i", "sk sk-line sk-w40"));
      row.append(create("i", "sk sk-num"), lines, create("i", "sk sk-chip"));
      wrap.append(row);
    }
    return wrap;
  }

  function renderHomeRouteResult(result, index = 0) {
    const button = create("button", `home-route-result${index === 0 ? " is-nearest" : ""}`);
    button.type = "button";
    button.style.setProperty("--route-color", result.color || "#0f766e");
    button.addEventListener("click", () => openHomeRouteResult(result).catch((error) => {
      console.error(error);
      showToast("Не удалось открыть найденный рейс.");
    }));

    const isTransfer = result.type === "transfer" && Array.isArray(result.legs) && result.legs.length === 2;
    const number = create("span", "home-route-result-number", isTransfer ? result.legs[0].routeNumber || "—" : result.routeNumber || "—");
    number.dataset.len = String(number.textContent || "").trim().length;
    const main = create("span", "home-route-result-main");
    const title = create("strong", "home-route-result-title");
    title.append(create("span", "", isTransfer ? "С пересадкой" : `Маршрут №${result.routeNumber || "—"}`));
    if (index === 0) title.append(create("em", "", "Ближайший"));
    const path = create("small", "", `${result.fromStopName || "остановка"} → ${result.toStopName || "остановка"}`);
    // Время и подпись — ПРЯМЫЕ дети main, без span-обёртки: main рендерится
    // display:contents, и вложенный второй уровень contents-детей Chrome
    // не учитывает в высоте грид-рядов — на телефонах с крупным шрифтом
    // мета наезжала на таймлайн пересадки (баг владельца 2026-07-11).
    const metaTime = create("b", "home-route-result-time", `${result.departureTime || "—"} → ${result.arrivalTime || "—"}`);
    const metaNote = create("small", "home-route-result-note", [
      homeRouteDateLabel(result.serviceDate),
      formatRouteSearchDuration(result.durationMinutes),
      formatRouteSearchWait(result.waitMinutes)
    ].filter(Boolean).join(" · "));
    main.append(title, path, metaTime, metaNote);

    if (isTransfer) {
      // Step-by-step plan as a timeline: bold time column + plain-verb action.
      const [first, second] = result.legs;
      const steps = create("span", "home-route-result-transfer");
      const step = (time, text, extraClass = "") => {
        const row = create("small", `transfer-step ${extraClass}`.trim());
        row.append(create("b", "transfer-step-time", time), create("span", "transfer-step-text", text));
        return row;
      };
      steps.append(
        step(first.departureTime, `Сесть на №${first.routeNumber} — ост. «${first.fromStopName}»`),
        step(first.arrivalTime, `Выйти на «${first.toStopName}»`),
        step(formatTransferWait(result.transferWaitMinutes), "Подождать на остановке", "transfer-wait"),
        step(second.departureTime, `Сесть на №${second.routeNumber}`),
        step(second.arrivalTime, `Прибытие — «${second.toStopName}»`, "transfer-arrive")
      );
      main.append(steps);
    }

    const go = create("span", "home-route-result-go", "Открыть");
    button.append(number, main, go);
    return button;
  }

  function formatTransferWait(minutes) {
    const value = Math.max(0, Number(minutes) || 0);
    if (value < 60) return `${value} мин`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }

  async function openHomeRouteResult(result) {
    blurHomeRouteSearchInputs();
    hideHomeStopOptions();
    const route = (state.data?.routes || []).find((item) => item.id === result.routeId);
    if (!route) {
      showToast("Маршрут не найден в текущем расписании.");
      return;
    }
    const direction = route.directions.find((item) => item.code === result.directionCode) || defaultDirectionForRoute(route);
    const stop = selectableStopsForDirection(direction).find((item) => item.id === result.fromStopUid) || defaultStopForDirection(direction);
    if (!direction || !stop) {
      showToast("Остановка не найдена в текущем расписании.");
      return;
    }

    closeHomeRouteSearchMenu({ restoreFocus: false });

    const nextType = routeTransportKey(route);
    if (state.transportType !== nextType) {
      rememberActiveViewScroll();
      state.transportType = nextType;
      resetTransportViewScroll(nextType);
    }

    state.missingRouteNumber = "";
    state.routeId = route.id;
    state.directionCode = direction.code;
    state.stopUid = stop.id;
    state.dayMode = homeRouteResultDayMode(result);
    state.dayModeExplicit = true;
    resetStopFilter();
    syncDayModeButtons();
    renderTransportChoices();
    renderRouteSelectors();
    renderRoutes();
    setView("schedule", { source: "home-route-search", resetScroll: true });
    queueScheduleScroll();
    const loaded = await loadSchedule();
    if (loaded) selectHomeRouteDeparture(result);
  }

  function selectHomeRouteDeparture(result) {
    const times = selectedTimes();
    const match = times.find((item) => {
      const sameTrip = String(item.tripCode || "") === String(result.tripCode || "");
      const sameVariant = String(item.variantCode || "") === String(result.variantCode || "");
      const sameTime = item.time === result.departureTime;
      const sameMask = !result.dayMask || item.dayMask === result.dayMask || (item.sourceDayMasks || []).includes(result.dayMask);
      return sameTrip && sameVariant && sameTime && sameMask;
    });
    if (!match) return;
    state.selectedDeparture = match;
    state.selectedDepartureMode = "manual";
    renderSchedule();
  }

  function homeRouteResultDayMode(result) {
    if (result.serviceDate === localDateKey(new Date())) return "today";
    const date = parseLocalDateInput(result.serviceDate);
    const mask = normalizeDayMaskForUi(result.dayMask);
    const indexes = serviceDayMaskIndexes(date);
    if (indexes.some((index) => mask[index] === "1" && index >= 5)) return "weekend";
    return "weekday";
  }

  function parseLocalDateInput(value) {
    const [year, month, day] = String(value || "").split("-").map(Number);
    if (!year || !month || !day) return new Date();
    // Anchor at noon, not midnight: downstream code extracts Europe/Minsk date
    // parts, and device-local midnight on a UTC+9 phone is still the previous
    // Minsk day — weekday masks and "сегодня/завтра" labels shifted by one.
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function timeInputValue(date) {
    const parts = scheduleDateParts(date);
    return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  }

  function formatRouteSearchDuration(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return "";
    if (minutes < 60) return `${minutes} мин в пути`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} ч ${rest} мин в пути` : `${hours} ч в пути`;
  }

  function formatRouteSearchWait(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return "";
    if (minutes === 0) return "отправление сейчас";
    if (minutes < 60) return `через ${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `через ${hours} ч ${rest} мин` : `через ${hours} ч`;
  }

  function homeRouteDateLabel(value) {
    if (!value) return "";
    const date = parseLocalDateInput(value);
    if (value === localDateKey(new Date())) return "сегодня";
    const tomorrow = addDays(new Date(), 1);
    if (value === localDateKey(tomorrow)) return "завтра";
    return new Intl.DateTimeFormat("ru-BY", { day: "2-digit", month: "short" }).format(date);
  }

  function transportRoutesHeading() {
    switch (state.transportType) {
      case "suburban":
        return "Пригородные маршруты";
      case "intercity":
        return "Междугородние маршруты";
      case "international":
        return "Международные маршруты";
      default:
        return "Городские маршруты";
    }
  }

  function routesForActiveTransport() {
    return routesForTransport(state.transportType);
  }

  function routesForTransport(type = state.transportType) {
    return (state.data?.routes || []).filter((route) => routeMatchesTransportType(route, type));
  }

  function routeMatchesTransportType(route, type = state.transportType) {
    return routeTransportKey(route) === type;
  }

  function routeTransportKey(route) {
    const value = normalize(`${route?.type || route?.transportType || ""} ${route?.name || ""}`);
    if (value.includes("пригород")) return "suburban";
    if (value.includes("международ")) return "international";
    if (value.includes("междугород") || value.includes("межгород")) return "intercity";
    return "city";
  }

  function renderHomePromo() {
    if (!els.homePromo) {
      scheduleHomePromoRotation(0, 0);
      return;
    }
    const ads = (state.data?.ads || []).filter((ad) => ad.title || ad.text);
    const homeAds = ads.filter((ad) => ad.placement === "home");
    const visibleAds = homeAds.length ? homeAds : ads;
    const items = visibleAds.length ? visibleAds : [{
      title: "Безопасная поездка",
      text: "Напомните детям держаться за поручни и заранее готовиться к выходу.",
      label: "Важно"
    }];
    if (state.homePromoIndex >= items.length) state.homePromoIndex = 0;
    const activeAd = items[state.homePromoIndex];
    const title = activeAd?.title || "Информация";
    const text = activeAd?.text || "";
    const imageUrl = safeMediaUrl(activeAd?.imageUrl || "");
    const ctaUrl = safeExternalUrl(activeAd?.url || "");
    const displayMs = promoDisplaySeconds(activeAd) * 1000;
    if (els.homePromoBadge) els.homePromoBadge.textContent = activeAd?.label || (imageUrl ? "Реклама" : "Важно");
    if (els.homePromo) {
      els.homePromo.classList.toggle("has-image", Boolean(imageUrl));
      els.homePromo.classList.toggle("is-rotating", items.length > 1);
      els.homePromo.style.setProperty("--promo-duration", `${displayMs}ms`);
    }
    if (els.homePromoMedia && els.homePromoImage) {
      els.homePromoMedia.hidden = !imageUrl;
      if (imageUrl) {
        els.homePromoImage.src = imageUrl;
        els.homePromoImage.alt = title;
        els.homePromoMedia.setAttribute("role", "button");
        els.homePromoMedia.tabIndex = 0;
        els.homePromoMedia.title = "Открыть картинку";
        els.homePromoMedia.onclick = () => openImageViewer(imageUrl, title);
        els.homePromoMedia.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openImageViewer(imageUrl, title);
          }
        };
        els.homePromoMedia.classList.remove("is-visible");
        void els.homePromoMedia.offsetWidth;
        els.homePromoMedia.classList.add("is-visible");
      } else {
        els.homePromoImage.removeAttribute("src");
        els.homePromoImage.alt = "";
        els.homePromoMedia.removeAttribute("role");
        els.homePromoMedia.removeAttribute("tabindex");
        els.homePromoMedia.removeAttribute("title");
        els.homePromoMedia.onclick = null;
        els.homePromoMedia.onkeydown = null;
      }
    }
    if (els.homePromoTrack) {
      els.homePromoTrack.classList.remove("is-visible");
      renderHomePromoText({ title, text, imageUrl });
      void els.homePromoTrack.offsetWidth;
      els.homePromoTrack.classList.add("is-visible");
      els.homePromoTrack.classList.remove("is-marquee");
    }
    if (els.homePromoCta) {
      const hasUrl = Boolean(ctaUrl);
      els.homePromoCta.href = hasUrl ? ctaUrl : (imageUrl || "#");
      els.homePromoCta.target = hasUrl ? "_blank" : "";
      els.homePromoCta.rel = hasUrl ? "noopener" : "";
      els.homePromoCta.classList.toggle("is-link", hasUrl);
      els.homePromoCta.onclick = (event) => {
        if (hasUrl) return;
        event.preventDefault();
        if (imageUrl) {
          openImageViewer(imageUrl, title);
        } else {
          showToast("Ссылка для рекламы не указана.");
        }
      };
    }
    if (els.homePromoProgress) {
      els.homePromoProgress.classList.remove("is-running");
      void els.homePromoProgress.offsetWidth;
      els.homePromoProgress.classList.toggle("is-running", items.length > 1);
    }
    scheduleHomePromoRotation(items.length, displayMs);
  }

  function renderHomePromoText({ title, text }) {
    const track = els.homePromoTrack;
    if (!track) return;
    clear(track);

    track.append(create("strong", "home-promo-title", title));
    if (text) track.append(create("span", "home-promo-copy", text));
  }

  function promoDisplaySeconds(ad) {
    const seconds = Number.parseInt(ad?.displaySeconds, 10);
    if (!Number.isFinite(seconds)) return 7;
    return Math.max(3, Math.min(30, seconds));
  }

  function scheduleHomePromoRotation(count, displayMs) {
    if (state.homePromoTimer) clearTimeout(state.homePromoTimer);
    state.homePromoTimer = null;
    if (count < 2) return;
    state.homePromoTimer = setTimeout(() => {
      if (document.hidden) {
        scheduleHomePromoRotation(count, displayMs);
        return;
      }
      state.homePromoIndex = (state.homePromoIndex + 1) % count;
      renderHomePromo();
    }, displayMs);
  }

  function renderQuickRoutes() {
    clear(els.quickRoutes);
    let activeButton = null;
    routesWithPlaceholders().forEach((route) => {
      const isActive = route.missing ? state.missingRouteNumber === route.number : route.id === state.routeId;
      const button = create("button", `route-chip ${isActive ? "is-active" : ""} ${route.missing ? "is-missing" : ""}`, route.number);
      button.type = "button";
      button.style.setProperty("--route-color", route.color || "var(--accent)");
      button.title = route.missing ? `Маршрут ${route.number}: расписание не загружено` : route.name;
      button.addEventListener("click", () => openRoute(route));
      if (isActive) activeButton = button;
      els.quickRoutes.append(button);
    });
    if (activeButton && !els.quickRoutes.hidden && els.quickRoutes.offsetParent !== null) {
      requestAnimationFrame(() => activeButton.scrollIntoView({ block: "nearest", inline: "center" }));
    }
  }

  async function loadSchedule() {
    const route = activeRoute();
    const direction = activeDirection();
    const stop = activeStop();
    const requestId = state.scheduleRequestId + 1;
    state.scheduleRequestId = requestId;

    closeStopTimesSheet({ immediate: true });
    setScheduleBusy(true);
    clear(els.nextPanel);
    els.nextPanel.hidden = false;
    els.nextPanel.append(scheduleSkeleton("hero"));
    clear(els.timesPanel);
    els.timesPanel.hidden = true;
    clear(els.stopsPanel);
    els.stopsPanel.append(scheduleSkeleton("timeline"));
    state.timeline = [];
    state.timelineKey = "";
    state.selectedDeparture = null;
    state.selectedDepartureMode = "auto";

    if (!route || !direction || !stop) {
      if (requestId !== state.scheduleRequestId) return false;
      state.schedule = { groups: [] };
      renderSchedule();
      setScheduleBusy(false);
      flushScheduleScroll();
      return true;
    }

    try {
      const query = new URLSearchParams({
      routeId: route.id,
      directionCode: direction.code,
      stopUid: stop.id
    });
    const response = await fetch(`/api/schedule?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось получить расписание.");
    const schedule = await response.json();
    if (requestId !== state.scheduleRequestId) return false;
    state.schedule = schedule;
    state.timelineCache.clear();
    applyPendingFavorite();
      renderSchedule();
      // Автоскролл к автобусу: после осознанной навигации (маршрут/
      // направление/остановка) доводим взгляд до живого маркера, если он
      // оказался за пределами экрана. Периодические тики сюда не попадают.
      requestAnimationFrame(() => {
        if (state.activeView !== "schedule" || state.stopSearch) return;
        const marker = els.stopsPanel?.querySelector(".route-timeline .rs-bus-dot")
          || els.stopsPanel?.querySelector(".route-timeline .rs-bus-row, .route-timeline .is-live-stop");
        if (marker && !isComfortablyVisible(marker)) {
          marker.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "center", inline: "nearest" });
        }
      });
    } catch (error) {
      if (requestId !== state.scheduleRequestId) return false;
      state.schedule = { groups: [] };
      renderScheduleLoadError(error.message || "Расписание временно недоступно.");
    } finally {
      if (requestId === state.scheduleRequestId) {
        setScheduleBusy(false);
        flushScheduleScroll();
      }
    }
    return requestId === state.scheduleRequestId;
  }

  function queueScheduleScroll() {
    state.shouldScrollToSchedule = true;
  }

  function flushScheduleScroll() {
    if (!state.shouldScrollToSchedule) return;
    state.shouldScrollToSchedule = false;
    scrollScheduleIntoView();
  }

  // Автоскролл к автобусу: если на схеме есть живой маркер, центрируем его —
  // пользователь сразу видит, где автобус, без ручной прокрутки.
  function scrollBusMarkerIntoView(behavior = "smooth") {
    const marker = els.stopsPanel?.querySelector(".route-timeline .rs-bus-dot")
      || els.stopsPanel?.querySelector(".route-timeline .rs-bus-row, .route-timeline .is-live-stop");
    if (!marker) return false;
    marker.scrollIntoView({ behavior: motionSafeBehavior(behavior), block: "center", inline: "nearest" });
    return true;
  }

  function scrollScheduleIntoView() {
    if (state.activeView !== "schedule" || !els.nextPanel) return;
    requestAnimationFrame(() => {
      const target = els.stopsPanel || els.nextPanel;
      // Живой автобус важнее верха панели: центрируем его положение.
      if (scrollBusMarkerIntoView("smooth")) {
        scrollActiveDepartureChip("auto");
        return;
      }
      if (isComfortablyVisible(target)) {
        scrollActiveDepartureChip("auto");
        return;
      }
      const activeChip = els.timesPanel?.querySelector("[data-active-departure='true']");
      if (activeChip) {
        scrollActiveDepartureChip("smooth");
        target.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "start", inline: "nearest" });
        return;
      }
      target.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "start", inline: "nearest" });
    });
  }

  function isComfortablyVisible(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.top >= 8 && rect.top <= window.innerHeight * 0.72;
  }

  function scrollActiveDepartureChip(behavior = "auto") {
    const alignChip = (scrollBehavior) => {
      const activeChip = els.timesPanel?.querySelector("[data-active-departure='true']");
      const scroller = activeChip?.closest(".times-grid");
      if (!activeChip || !scroller) return;
      const chipRect = activeChip.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const isVisible = chipRect.left >= scrollerRect.left + 8 && chipRect.right <= scrollerRect.right - 8;
      if (isVisible && scrollBehavior !== "smooth") return;
      const centeredLeft = activeChip.offsetLeft - Math.max(0, (scroller.clientWidth - activeChip.offsetWidth) / 2);
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const left = Math.min(Math.max(0, centeredLeft), maxLeft);
      scroller.scrollTo({ left, behavior: motionSafeBehavior(scrollBehavior) });
    };
    requestAnimationFrame(() => {
      alignChip(behavior);
      requestAnimationFrame(() => alignChip("auto"));
      window.setTimeout(() => alignChip("auto"), 80);
    });
  }

  function alignTimesGridOrder(grid, times, focusKey) {
    if (!grid || !focusKey || !Array.isArray(times) || !times.length) return;
    const activeIndex = times.findIndex((item) => selectedDepartureKey(item) === focusKey);
    if (activeIndex < 0) return;
    requestAnimationFrame(() => {
      const activeChip = grid.querySelector("[data-active-departure='true']");
      if (!activeChip) return;
      const centeredLeft = activeChip.offsetLeft - Math.max(0, (grid.clientWidth - activeChip.offsetWidth) / 2);
      const maxLeft = Math.max(0, grid.scrollWidth - grid.clientWidth);
      grid.scrollLeft = Math.min(Math.max(0, centeredLeft), maxLeft);
    });
  }

  function scrollStopsIntoView() {
    if (state.activeView !== "schedule" || !els.stopsPanel) return;
    requestAnimationFrame(() => {
      els.stopsPanel.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "start" });
    });
  }

  function scrollScheduleTripToolsIntoView() {
    if (state.activeView !== "schedule") return;
    requestAnimationFrame(() => {
      const target = (!els.nextPanel?.hidden && els.nextPanel?.querySelector(".quick-actions"))
        || (!els.nextPanel?.hidden && els.nextPanel?.children.length ? els.nextPanel : null)
        || els.stopsPanel;
      if (!target) return;
      target.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "center", inline: "nearest" });
      scrollActiveDepartureChip("auto");
    });
  }

  function renderAds() {
    clear(els.adRail);
    els.adRail.hidden = true;
  }

  function renderRouteSelectors() {
    renderQuickRoutes();
    const routes = routesForActiveTransport();
    if (!routes.length) {
      state.routeId = "";
      state.directionCode = "";
      state.stopUid = "";
    }
    renderOptions(
      els.routeSelect,
      routes.map((route) => ({ value: route.id, label: `${route.number}. ${route.name}` })),
      state.routeId
    );

    const route = activeRoute();
    if (!route && routes[0]) {
      state.routeId = routes[0].id;
    }
    const selectedRoute = activeRoute();
    if (!selectedRoute?.directions.some((direction) => direction.code === state.directionCode)) {
      state.directionCode = defaultDirectionForRoute(selectedRoute)?.code || "";
    }

    renderOptions(
      els.directionSelect,
      (selectedRoute?.directions || []).map((direction) => ({ value: direction.code, label: directionLabel(selectedRoute, direction) })),
      state.directionCode
    );
    renderDirectionChips(selectedRoute);

    const direction = activeDirection();
    const selectableStops = selectableStopsForDirection(direction);
    if (!selectableStops.some((stop) => stop.id === state.stopUid)) {
      state.stopUid = defaultStopForDirection(direction)?.id || "";
    }

    renderOptions(
      els.stopSelect,
      selectableStops.map((stop, index) => ({ value: stop.id, label: stopOptionLabel(stop, index) })),
      state.stopUid
    );
    renderScheduleHero();
  }

  function renderScheduleHero() {
    const route = activeRoute();
    const direction = activeDirection();
    const stop = activeStop();
    const color = routeAccent(route);
    if (els.scheduleHero) {
      els.scheduleHero.style.setProperty("--route-color", color);
      els.scheduleHero.dataset.routeNumber = route?.number || "";
      els.scheduleHero.classList.toggle("has-route", Boolean(route));
    }
    if (els.routeSummary) {
      els.routeSummary.textContent = route ? `Маршрут №${route.number}` : "Маршрут не выбран";
    }
    if (els.stopSummary) {
      const directionText = routeDirectionDisplayLabel(route, direction);
      els.stopSummary.textContent = stop
        ? `${stopDisplayName(stop)}${directionText ? ` · ${directionText}` : ""}`
        : routeDisplayName(route) || "Выберите маршрут";
      els.stopSummary.title = els.stopSummary.textContent;
    }
  }

  function renderDirectionChips(route) {
    clear(els.directionChips);
    const directions = route?.directions || [];
    els.directionChips.hidden = directions.length < 2;
    els.directionChips.closest(".direction-panel")?.classList.toggle("has-direction-switch", directions.length > 1);
    if (els.directionSwapButton) {
      els.directionSwapButton.hidden = true;
      els.directionSwapButton.disabled = true;
    }
    directions.forEach((direction) => {
      const label = routeDirectionDisplayLabel(route, direction);
      const chip = create("button", `direction-chip ${direction.code === state.directionCode ? "is-active" : ""}`);
      // Макет: карточка направления в две строки — откуда тёмным, «→ куда» акцентом.
      const arrowAt = label.indexOf(" → ");
      if (arrowAt > 0) {
        chip.append(
          create("span", "direction-from", label.slice(0, arrowAt)),
          create("span", "direction-to", `→ ${label.slice(arrowAt + 3)}`)
        );
      } else {
        chip.textContent = label;
      }
      chip.type = "button";
      chip.title = label;
      chip.setAttribute("aria-pressed", direction.code === state.directionCode ? "true" : "false");
      chip.setAttribute("aria-current", direction.code === state.directionCode ? "true" : "false");
      chip.addEventListener("click", () => selectDirection(direction.code).catch((error) => console.error(error)));
      els.directionChips.append(chip);
    });
  }

  async function selectDirection(directionCode) {
    if (!directionCode || directionCode === state.directionCode) return;
    const route = activeRoute();
    const direction = route?.directions?.find((item) => item.code === directionCode);
    if (!direction) return;
    state.directionCode = direction.code;
    state.stopUid = defaultStopForDirection(direction)?.id || "";
    resetStopFilter();
    renderRouteSelectors();
    state.shouldScrollToSchedule = false;
    await loadSchedule();
  }

  async function switchDirection() {
    const route = activeRoute();
    const directions = route?.directions || [];
    if (directions.length < 2) return;
    const currentIndex = Math.max(0, directions.findIndex((direction) => direction.code === state.directionCode));
    const nextDirection = directions[(currentIndex + 1) % directions.length];
    state.directionCode = nextDirection.code;
    state.stopUid = defaultStopForDirection(nextDirection)?.id || "";
    resetStopFilter();
    renderRouteSelectors();
    queueScheduleScroll();
    await loadSchedule();
  }

  function scheduleSkeleton(kind = "hero") {
    // Скелетон повторяет ФОРМУ будущего контента (правило Google/Transit):
    // hero — колодец + три строки; timeline — ряды «точка · имя · чип времени».
    const node = create("div", `skeleton-card sk-${kind}`);
    node.setAttribute("aria-hidden", "true");
    if (kind === "timeline") {
      for (let i = 0; i < 4; i += 1) {
        const row = create("div", "sk-row");
        row.append(create("i", "sk sk-dot"), create("i", `sk sk-line sk-w${i % 2 ? 55 : 70}`), create("i", "sk sk-chip"));
        node.append(row);
      }
      return node;
    }
    const lines = create("div", "sk-lines");
    lines.append(create("i", "sk sk-line sk-w40"), create("i", "sk sk-line sk-strong sk-w70"), create("i", "sk sk-line sk-w55"));
    node.append(create("i", "sk sk-well"), lines);
    return node;
  }

  function setScheduleBusy(isBusy) {
    [els.nextPanel, els.timesPanel, els.stopsPanel].forEach((node) => {
      if (!node) return;
      node.toggleAttribute("aria-busy", Boolean(isBusy));
    });
  }

  function renderScheduleLoadError(message) {
    const retry = create("button", "mini-button", "Повторить");
    retry.type = "button";
    retry.addEventListener("click", () => loadSchedule());

    const panel = create("div", "empty-state schedule-error-state");
    panel.append(
      create("strong", "", "Не удалось загрузить расписание"),
      create("span", "", message),
      retry
    );

    clear(els.nextPanel);
    els.nextPanel.hidden = false;
    els.nextPanel.append(panel);
    clear(els.timesPanel);
    els.timesPanel.hidden = false;
    els.timesPanel.append(create("div", "empty-state", "Проверьте подключение и попробуйте ещё раз."));
    clear(els.stopsPanel);
    els.stopsPanel.append(create("div", "empty-state", "Схема маршрута появится после загрузки расписания."));
  }

  function renderSchedule(options = {}) {
    const route = activeRoute();
    const direction = activeDirection();
    const stop = activeStop();

    // Auto-advance an empty "today" to the nearest service day so the panel opens
    // straight on the real next trip, instead of a tap-to-reveal "рейсов нет" card.
    // Skipped when the rider chose "Сегодня" themselves (dayModeExplicit) — then the
    // empty-day card is the honest answer and must stay reachable.
    if (route && direction && stop && state.dayMode === "today" && !state.dayModeExplicit && !selectedTimes().length) {
      const nearest = findNearestServiceDayTrips();
      // Only advance when the target mode actually has trips for THIS stop.
      // findNearestServiceDayTrips buckets by per-date (holiday-substituted) mask
      // indexes, which can name a weekday/weekend mode whose stop-filtered times
      // are empty; landing there would swap one empty card for another. When that
      // happens we stay on "today" and let the empty card's own button jump.
      if (nearest && nearest.targetMode && nearest.targetMode !== "today"
        && selectedTimes(state.schedule, nearest.targetMode).length) {
        state.dayMode = nearest.targetMode;
        syncDayModeButtons();
        state.selectedDeparture = null;
        state.selectedDepartureMode = "auto";
      }
    }

    const times = selectedTimes();
    const next = getNextDeparture(times);
    const current = getCurrentDeparture(times);
    const hasPassedTodayDepartures = state.dayMode === "today" && times.length > 0 && !next;
    const fallbackDeparture = hasPassedTodayDepartures ? times[0] : null;
    if (state.selectedDeparture && !times.some((item) => selectedDepartureKey(item) === selectedDepartureKey(state.selectedDeparture))) {
      state.selectedDeparture = null;
      state.selectedDepartureMode = "auto";
    }
    const autoDeparture = current || next || fallbackDeparture;
    if (state.selectedDepartureMode !== "manual" && autoDeparture) {
      const autoKey = selectedDepartureKey(autoDeparture);
      state.selectedDeparture = (autoKey ? times.find((item) => selectedDepartureKey(item) === autoKey) : null) || times[0];
      state.selectedDepartureMode = "auto";
    }
    if (!state.selectedDeparture && times.length) {
      const autoKey = selectedDepartureKey(autoDeparture);
      state.selectedDeparture = (autoKey ? times.find((item) => selectedDepartureKey(item) === autoKey) : null) || times[0];
      state.selectedDepartureMode = "auto";
    }

    clear(els.nextPanel);
    clear(els.timesPanel);
    els.nextPanel.classList.toggle("is-empty-day", !times.length);
    els.nextPanel.hidden = true;
    els.timesPanel.hidden = true;

    if (!route || !direction || !stop) {
      els.scheduleMeta.textContent = "Маршруты пока не импортированы.";
      renderScheduleHero();
      els.nextPanel.hidden = false;
      els.nextPanel.append(create("div", "empty-state", "Нет данных расписания."));
      renderStops();
      return;
    }

    els.scheduleMeta.textContent = `Маршрут ${route.number}, ${stopDisplayName(stop)}`;
    renderScheduleHero();

    const activeDeparture = state.selectedDeparture || current || next || fallbackDeparture;
    const livePosition = routeVehiclePosition(state.timeline);
    const timelineMatchesActiveDeparture = Boolean(
      livePosition
      && selectedDepartureKey(state.selectedDeparture) === selectedDepartureKey(activeDeparture)
      && state.timelineKey === timelineKeyForDeparture(route, direction, activeDeparture)
    );
    const isLiveTrip = timelineMatchesActiveDeparture;
    const isTimetableActive = Boolean(activeDeparture && departureIsActiveNow(activeDeparture));
    const activeLivePosition = timelineMatchesActiveDeparture ? livePosition : null;
    const isFallbackNext = hasPassedTodayDepartures && selectedDepartureKey(activeDeparture) === selectedDepartureKey(fallbackDeparture);
    const activeDepartureIsPast = Boolean(
      activeDeparture
      && !isFallbackNext
      && !isLiveTrip
      && !isTimetableActive
      && departureHasPassedStop(activeDeparture)
    );
    if (activeDeparture) {
      els.nextPanel.hidden = false;
      els.nextPanel.append(renderNextTripCard(route, direction, stop, activeDeparture, next, {
        isFallbackNext,
        isLiveTrip,
        isTimetableActive,
        isPastDeparture: activeDepartureIsPast,
        livePosition: activeLivePosition
      }));
      els.nextPanel.append(renderQuickActions(route, direction, stop, activeDeparture || next || times[0]));
    } else if (!activeDeparture) {
      els.nextPanel.hidden = false;
      const noTrips = noTripsMessageForDay();
      els.nextPanel.append(renderNoTripsCard(noTrips.title, noTrips.text));
    }
    els.timesPanel.hidden = true;

    renderStops();
    if (!options.skipTimelineLoad) {
      loadBestTimelineFor(activeDeparture || next || fallbackDeparture, times, next, fallbackDeparture);
    }
  }

  // Scans up to 14 days ahead through ALL loaded schedule groups (any day mask)
  // and returns the nearest service day that has trips at this stop — the data is
  // already in memory, so the "no trips today" card can answer instead of dead-end.
  function findNearestServiceDayTrips() {
    const groups = state.schedule.groups || [];
    if (!groups.length) return null;
    const labels = ["в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу", "в воскресенье"];
    for (let offset = 1; offset <= 14; offset += 1) {
      const serviceDate = addDays(new Date(), offset);
      const indexes = serviceDayMaskIndexes(serviceDate);
      let matchIndex = null;
      let firstTime = "";
      groups.forEach((group) => {
        const mask = normalizeDayMaskForUi(group.dayMask);
        const index = indexes.find((item) => mask[item] === "1");
        if (!Number.isInteger(index)) return;
        (group.times || []).forEach((item) => {
          const time = String(item.time || "");
          if (!/^\d{2}:\d{2}$/.test(time)) return;
          if (!firstTime || time < firstTime) {
            firstTime = time;
            matchIndex = index;
          }
        });
      });
      if (firstTime) {
        // Label from the ACTUAL calendar weekday of serviceDate: on Belarus
        // holidays the mask index is substituted (weekend schedule on a Friday),
        // and naming the mask's day would tell the user the wrong day.
        const calendarIndex = (serviceDate.getDay() + 6) % 7;
        return {
          label: offset === 1 ? "завтра" : labels[calendarIndex],
          time: firstTime,
          targetMode: matchIndex <= 4 ? "weekday" : "weekend"
        };
      }
    }
    return null;
  }

  function switchDayMode(mode) {
    state.dayMode = mode;
    state.dayModeExplicit = true;
    syncDayModeButtons();
    state.selectedDeparture = null;
    state.selectedDepartureMode = "auto";
    queueScheduleScroll();
    renderSchedule();
    flushScheduleScroll();
  }

  function renderNoTripsCard(title, text) {
    const nearest = findNearestServiceDayTrips();
    // The arrow affordance is honest now: with a nearest day the card is a real
    // button that jumps to that day's timetable; without one there is no arrow.
    const emptyDay = create(
      nearest ? "button" : "article",
      "next-trip-card next-trip-card-empty schedule-empty-day"
    );
    const body = create("div", "next-trip-body");
    emptyDay.append(scheduleLineIcon("bus", "next-trip-icon schedule-empty-day-icon"), body);

    if (nearest) {
      emptyDay.type = "button";
      const modeLabel = nearest.targetMode === "weekday" ? "будней" : "выходных";
      body.append(
        create("span", "next-trip-kicker", title),
        create("strong", "next-trip-empty-title", `Ближайший рейс — ${nearest.label}, ${nearest.time}`),
        create("p", "next-trip-empty-text", `Показать расписание ${modeLabel}`)
      );
      emptyDay.append(create("span", "next-trip-arrow", "›"));
      emptyDay.addEventListener("click", () => switchDayMode(nearest.targetMode));
    } else {
      body.append(
        create("span", "next-trip-kicker", "Следующий рейс"),
        create("strong", "next-trip-empty-title", title),
        create("p", "next-trip-empty-text", text)
      );
    }
    return emptyDay;
  }

  function noTripsMessageForDay() {
    if (state.dayMode === "today") {
      return {
        title: "Сегодня рейсов нет",
        text: "Проверьте другой тип дня, направление или остановку."
      };
    }
    if (state.dayMode === "weekday") {
      return {
        title: "По будням рейсов нет",
        text: "Выберите «Сегодня» или «Выходные», если маршрут ходит по другому графику."
      };
    }
    return {
      title: "В выходные рейсов нет",
      text: "Выберите «Сегодня» или «Будни», если маршрут ходит по другому графику."
    };
  }

  function livePositionStatusLabel(position) {
    if (!position) return "на линии";
    if (position.status === "waiting") return "ожидает";
    if (position.status === "at-stop") return "у остановки";
    if (position.status === "between-stops") return "между";
    if (position.status === "finished") return "у конечной";
    return "на линии";
  }

  function compactLivePositionLabel(position) {
    const label = String(position?.label || "").trim();
    if (!label) return "Автобус на линии по расписанию";
    return label
      .replace(/^По расписанию\s+/i, "")
      .replace(/^автобус/i, "Автобус");
  }

  function renderNextTripCard(route, direction, stop, departure, next, options = {}) {
    const selectedIsNext = Boolean(selectedDepartureKey(departure)) && selectedDepartureKey(departure) === selectedDepartureKey(next);
    const isActive = Boolean(options.isLiveTrip || options.isTimetableActive);
    const isNextState = isActive || selectedIsNext || options.isFallbackNext;
    // Макет 2c: время бирюзовое для актуального/ближайшего рейса; для прошедшего
    // и явно выбранного (не ближайшего) — нейтральный тёмный.
    const mutedTime = Boolean(options.isPastDeparture) || !isNextState;

    const card = create("article", [
      "next-trip-card",
      options.isLiveTrip ? "is-live-trip" : "",
      options.isTimetableActive && !options.isLiveTrip ? "is-timetable-active" : "",
      options.isPastDeparture ? "is-past-departure" : "",
      mutedTime ? "is-muted-time" : ""
    ].filter(Boolean).join(" "));
    card.style.setProperty("--route-color", routeAccent(route));
    if (isActive) {
      card.setAttribute("aria-live", "polite");
      card.setAttribute("aria-label", options.livePosition?.label || "По расписанию рейс сейчас выполняется");
    }

    // Кикер одной строкой: «Ближайший рейс · через 9 мин» (заголовок + статус).
    const titleText = isActive
      ? "Ближайший рейс"
      : options.isPastDeparture
        ? "Прошедший рейс"
        : isNextState ? "Ближайший рейс" : "Выбранный рейс";
    const statusLabel = options.isLiveTrip
      ? livePositionStatusLabel(options.livePosition)
      : options.isTimetableActive
        ? "по расписанию"
        : options.isPastDeparture
          ? "уже прошёл"
        : options.isFallbackNext ? nextServiceDayLabel(departure) : departure ? departurePanelLabel(departure) : nextDepartureLabel(next);

    const body = create("div", "next-trip-body");
    const kicker = create("span", "next-trip-kicker", statusLabel ? `${titleText} · ${statusLabel}` : titleText);

    // Время + остановка посадки в одну baseline-строку.
    const timeRow = create("div", "next-trip-time-row");
    timeRow.append(create("strong", "next-trip-time", departure?.time || "—"));
    const boardingStop = stop?.name || "";
    if (boardingStop) timeRow.append(create("span", "next-trip-boarding", `от ${boardingStop}`));

    // Маршрут «начало → конечная» отдельной строкой.
    const directionStops = direction?.stops || [];
    const routeOrigin = departure?.originStop || direction?.from || directionStops[0]?.name || stop?.name || "";
    const routeDestination = departureDestination(departure, direction) || directionStops[directionStops.length - 1]?.name || "";
    const routePath = create("span", "next-trip-route-path", `${routeOrigin || "начало"} → ${routeDestination || "конечная"}`);

    body.append(kicker, timeRow, routePath);
    card.append(body);

    // Live-плашка — только для актуального рейса; дисклеймер «не GPS» в title/aria.
    const liveLabel = options.isLiveTrip
      ? compactLivePositionLabel(options.livePosition)
      : options.isTimetableActive
        ? "Рейс сейчас выполняется по расписанию"
        : "";
    if (liveLabel) {
      const live = create("div", "next-trip-live");
      live.append(create("span", "next-trip-live-dot"), create("span", "next-trip-live-text", liveLabel));
      const disclaimer = "Это расчёт по расписанию, не GPS.";
      live.title = options.livePosition?.label ? `${options.livePosition.label}. ${disclaimer}` : disclaimer;
      live.setAttribute("aria-label", `${liveLabel}. ${disclaimer}`);
      card.append(live);
    }

    return card;
  }

  function renderSelectedStopCard(route, direction, stop, departure, options = {}) {
    const card = create("article", `selected-stop-card ${options.isLiveTrip ? "is-live-trip" : ""} ${options.isTimetableActive && !options.isLiveTrip ? "is-timetable-active" : ""}`);
    const body = create("div", "selected-stop-body");
    const directionText = routeDirectionDisplayLabel(route, direction);
    const stopName = stopDisplayName(stop);
    const liveText = options.isLiveTrip
      ? compactLivePositionLabel(options.livePosition)
      : options.isTimetableActive
        ? "рейс выполняется по расписанию"
        : "";
    const details = [
      directionText ? `Направление: ${directionText}` : "",
      liveText,
      departure?.time ? `рейс ${departure.time}` : ""
    ].filter(Boolean).join(" · ");
    if (details) card.setAttribute("aria-label", `${stopName || "Остановка не выбрана"}. ${details}`);
    const changeButton = create("button", "mini-button", "Остановка");
    changeButton.type = "button";
    changeButton.title = "Выбрать другую остановку на схеме маршрута";
    changeButton.addEventListener("click", scrollStopsIntoView);
    card.append(
      scheduleLineIcon("map", "selected-stop-card-icon"),
      body,
      changeButton
    );
    body.append(
      create("span", "hero-label", "Выбранная остановка"),
      create("strong", "", stopName || "Остановка не выбрана"),
      create("small", "selected-stop-direction", directionText || "Выберите направление маршрута"),
      create("small", "selected-stop-help", departure?.time ? `Рейсы показаны от этой остановки · выбран ${departure.time}` : "Нажмите остановку на схеме, чтобы увидеть отправления от неё")
    );
    return card;
  }

  function nextServiceDayLabel(departure) {
    if (!departure?.dayMask) return "по расписанию";
    const mask = normalizeDayMaskForUi(departure.dayMask);
    const labels = ["в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу", "в воскресенье"];
    for (let offset = 1; offset <= 14; offset += 1) {
      const serviceDate = addDays(new Date(), offset);
      const matchIndex = serviceDayMaskIndexes(serviceDate).find((index) => mask[index] === "1");
      if (Number.isInteger(matchIndex)) return offset === 1 ? "завтра" : labels[matchIndex];
    }
    return "по расписанию";
  }

  function renderDepartureScroller(times, next) {
    const section = create("details", "departures-section departures-disclosure");
    section.open = Boolean(state.departuresExpanded);
    section.addEventListener("toggle", () => {
      state.departuresExpanded = section.open;
    });

    const summary = create("summary", "departures-summary");
    const summaryText = create("span", "departures-summary-copy");
    summaryText.append(
      create("strong", "", departureSectionTitle()),
      create("small", "", departureSummaryLabel(times, next))
    );
    summary.append(
      summaryText,
      create("span", "departures-summary-preview", departurePreviewLabel(times, next)),
      create("span", "departures-summary-chevron", "›")
    );
    section.append(summary);

    if (!times.length) {
      section.append(create("p", "muted", "Для выбранной остановки рейсов нет."));
      return { node: section, grid: null, stripTimes: [], stripFocusKey: "" };
    }

    const variantNotice = renderRouteVariantNotice(times);
    if (variantNotice) section.append(variantNotice);

    const timesGrid = create("div", "times-grid departure-scroller");
    const selectedDepartureKeyValue = selectedDepartureKey(state.selectedDeparture);
    const nextDepartureKeyValue = selectedDepartureKey(next);
    const route = activeRoute();
    const direction = activeDirection();
    const livePosition = routeVehiclePosition(state.timeline);
    const liveTimelineMatchesSelected = Boolean(
      livePosition
      && state.timelineKey
      && state.timelineKey === timelineKeyForDeparture(route, direction, state.selectedDeparture)
    );
    const liveDepartureKeyValue = liveTimelineMatchesSelected ? selectedDepartureKey(state.selectedDeparture) : "";
    const stripFocusDeparture = state.dayMode === "today" ? state.selectedDeparture || next : state.selectedDeparture || next;
    const stripFocusKey = selectedDepartureKey(stripFocusDeparture);
    const stripTimes = visibleTimesForStrip(times, stripFocusDeparture);
    timesGrid.dataset.focusKey = stripFocusKey || "";
    const nowMinutes = state.dayMode === "today" ? minutesFromDate(new Date()) : NaN;

    stripTimes.forEach((item) => {
      const itemKey = selectedDepartureKey(item);
      const isSelected = selectedDepartureKeyValue ? selectedDepartureKeyValue === itemKey : stripFocusKey === itemKey;
      const isLiveTrip = liveDepartureKeyValue && liveDepartureKeyValue === itemKey;
      const isNext = nextDepartureKeyValue && nextDepartureKeyValue === itemKey;
      const isPast = departureHasPassedStop(item, nowMinutes);
      const showPastBadge = isPast && !isLiveTrip && !isNext;
      const chip = create("button", `time-chip ${isSelected ? "is-selected" : ""} ${isPast ? "is-past" : ""}`);
      chip.type = "button";
      chip.setAttribute("aria-pressed", isSelected ? "true" : "false");
      if (stripFocusKey && stripFocusKey === itemKey) chip.dataset.activeDeparture = "true";
      if (isLiveTrip) chip.classList.add("is-live-trip");
      if (item.variantKind) chip.classList.add(`variant-${item.variantKind}`);
      const dayLabel = departureDayLabel(item);
      chip.append(create("strong", "", item.time));
      if (isLiveTrip) chip.append(create("span", "time-chip-live", "на линии"));
      if (showPastBadge) chip.append(create("span", "time-chip-past", "прошёл"));
      if (isNext) chip.append(create("span", "time-chip-next", "ближайший"));
      if (dayLabel) chip.append(create("span", "time-chip-day", dayLabel));
      const chipSupport = departureChipSupportLabel(item, { isLiveTrip, isNext, isSelected, isPast });
      if (chipSupport) chip.append(create("small", item.viaLabel ? "time-chip-variant" : "", chipSupport));
      if (isNext) chip.classList.add("is-next");
      const chipLabel = [
        isLiveTrip ? "Рейс на линии" : isNext ? "Ближайший рейс" : isPast ? "Прошедший рейс" : "Рейс",
        item.time,
        departureChipHint(item),
        isPast ? "уже прошёл" : "",
        isSelected ? "выбран" : ""
      ].filter(Boolean).join(", ");
      chip.setAttribute("aria-label", chipLabel);
      chip.title = chipLabel;
      chip.addEventListener("click", () => {
        const previousTimeScrollLeft = chip.closest(".times-grid")?.scrollLeft || 0;
        state.shouldScrollToSchedule = false;
        state.selectedDeparture = item;
        state.selectedDepartureMode = "manual";
        renderSchedule();
        const restoreTimeScroller = () => {
          const currentGrid = els.timesPanel?.querySelector(".times-grid");
          if (currentGrid) currentGrid.scrollLeft = previousTimeScrollLeft;
        };
        requestAnimationFrame(() => {
          restoreTimeScroller();
          scrollScheduleTripToolsIntoView();
          requestAnimationFrame(restoreTimeScroller);
        });
      });
      timesGrid.append(chip);
    });

    section.append(timesGrid);
    return { node: section, grid: timesGrid, stripTimes, stripFocusKey };
  }

  function chooseScheduleDeparture(departure, options = {}) {
    if (!departure) return;
    const preserveScroll = Boolean(options.preserveScroll);
    const previousScrollTop = preserveScroll ? (window.scrollY || document.documentElement.scrollTop || 0) : 0;
    state.shouldScrollToSchedule = false;
    state.selectedDeparture = departure;
    state.selectedDepartureMode = "manual";
    closeStopTimesSheet({ immediate: true });
    renderSchedule();
    if (preserveScroll) {
      const restoreScroll = () => window.scrollTo({ top: previousScrollTop, left: 0, behavior: "auto" });
      requestAnimationFrame(() => {
        restoreScroll();
        requestAnimationFrame(restoreScroll);
      });
    } else {
      scrollScheduleTripToolsIntoView();
    }
  }

  function openStopTimesSheet(stop = activeStop()) {
    const route = activeRoute();
    const direction = activeDirection();
    if (!route || !direction || !stop) return;
    closeFavoriteMenus();
    closeStopTimesSheet({ immediate: true });

    const times = selectedTimes();
    const next = getNextDeparture(times);
    const selectedKey = selectedDepartureKey(state.selectedDeparture);
    const root = create("div", "alarm-sheet stop-times-sheet");
    root.hidden = true;
    const backdrop = create("button", "alarm-sheet-backdrop stop-times-backdrop");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Закрыть отправления остановки");

    const panel = create("section", "alarm-sheet-panel stop-times-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const stopName = stopDisplayName(stop);
    panel.setAttribute("aria-label", `Отправления от остановки ${stopName}`);

    const handle = create("span", "alarm-sheet-handle stop-times-handle");
    const header = create("div", "alarm-sheet-head stop-times-head");
    const title = create("div", "stop-times-title");
    const subtitle = create("span", "stop-times-subtitle");
    subtitle.append(document.createTextNode(`${stopTimesModeLabel()} · №${route.number}`));
    if (next?.time) {
      subtitle.append(
        document.createTextNode(" · ближайший "),
        create("span", "stop-times-next-time", next.time)
      );
    }
    title.append(create("strong", "", stopName), subtitle);
    const close = favoriteActionButton("close", "Закрыть", "alarm-sheet-close stop-times-close");
    header.append(title, close);

    // Полный контекст рейса уходит в aria-label ячейки (в самой ячейке — только время).
    const dirContextLabel = routeDirectionDisplayLabel(route, direction) || "";
    const choiceAria = (item, passed) => {
      const parts = [`Отправление ${item.time}${passed ? " (прошёл)" : ""}`];
      if (dirContextLabel) parts.push(dirContextLabel);
      const day = departureDayLabel(item);
      if (day) parts.push(day);
      return parts.join(", ");
    };

    const body = create("div", "stop-times-body");
    if (!times.length) {
      body.append(create("p", "muted stop-times-empty", "Для этой остановки в выбранном режиме рейсов нет."));
    } else {
      const isToday = state.dayMode === "today";
      const nowMinutes = isToday ? minutesFromDate(new Date()) : NaN;
      let upcoming = isToday ? times.filter((item) => !departureHasPassedStop(item, nowMinutes)) : times;
      let past = isToday ? times.filter((item) => departureHasPassedStop(item, nowMinutes)) : [];
      // Сегодня все рейсы уже ушли — показываем их основной сеткой, без дубля в «Прошедших».
      if (isToday && !upcoming.length) {
        upcoming = times;
        past = [];
      }
      // По умолчанию подсвечена ближайшая (первая в сетке); ручной выбор пользователя
      // чтим, только если он попадает в видимую сетку предстоящих.
      const manualIndex = selectedKey
        ? upcoming.findIndex((item) => selectedDepartureKey(item) === selectedKey)
        : -1;
      const activeIndex = manualIndex >= 0 ? manualIndex : 0;

      const choices = create("div", "stop-times-choices");
      choices.setAttribute("role", "list");
      upcoming.forEach((item, index) => {
        const isSelected = index === activeIndex;
        const button = create("button", `stop-time-choice ${isSelected ? "is-selected" : ""}`.trim());
        button.type = "button";
        button.setAttribute("role", "listitem");
        button.setAttribute("aria-pressed", isSelected ? "true" : "false");
        button.setAttribute("aria-label", choiceAria(item, false));
        button.append(create("strong", "", item.time));
        button.addEventListener("click", () => chooseScheduleDeparture(item));
        choices.append(button);
      });
      body.append(choices);

      // Прошедшие — только в режиме «сегодня»: компактная приглушённая сетка.
      if (past.length) {
        const pastSection = create("div", "stop-times-past");
        pastSection.append(create("span", "stop-times-past-title", "Прошедшие"));
        const pastGrid = create("div", "stop-times-past-grid");
        pastGrid.setAttribute("role", "list");
        past.forEach((item) => {
          const cell = create("button", "stop-time-past");
          cell.type = "button";
          cell.setAttribute("role", "listitem");
          cell.setAttribute("aria-label", choiceAria(item, true));
          cell.append(create("span", "", item.time));
          cell.addEventListener("click", () => chooseScheduleDeparture(item));
          pastGrid.append(cell);
        });
        pastSection.append(pastGrid);
        body.append(pastSection);
      }
    }

    panel.append(handle, header, body);
    root.append(backdrop, panel);
    document.body.append(root);

    const onKeyDown = (event) => {
      if (event.key === "Escape") closeStopTimesSheet();
    };
    document.addEventListener("keydown", onKeyDown);
    state.stopTimesSheet = { root, panel, onKeyDown };

    backdrop.addEventListener("click", () => closeStopTimesSheet());
    close.addEventListener("click", () => closeStopTimesSheet());

    requestAnimationFrame(() => {
      root.hidden = false;
      document.body.classList.add("is-stop-times-sheet-open");
      requestAnimationFrame(() => {
        root.classList.add("is-open");
        // Move focus into the modal sheet so keyboard/screen-reader users are not
        // left interacting with the covered background.
        close.focus?.();
      });
    });
  }

  function closeStopTimesSheet(options = {}) {
    const current = state.stopTimesSheet;
    if (!current?.root) return;
    const { root, onKeyDown } = current;
    state.stopTimesSheet = null;
    document.body.classList.remove("is-stop-times-sheet-open");
    if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
    root.classList.remove("is-open");
    const remove = () => root.remove();
    if (options.immediate) remove();
    else window.setTimeout(remove, 220);
  }

  function stopTimesModeLabel() {
    if (state.dayMode === "today") return "Сегодня";
    if (state.dayMode === "weekday") return "Будни";
    return "Выходные";
  }

  function renderQuickActions(route, direction, stop, departure) {
    const actions = create("section", "quick-actions");
    actions.setAttribute("aria-label", "Быстрые действия с выбранным рейсом");
    actions.append(
      quickActionButton({
        icon: "bell",
        label: "Напомнить",
        hint: "за 5-120 мин",
        disabled: !departure,
        onClick: () => openReminderSettings({ route, direction, stop, departure })
      }),
      quickActionButton({
        icon: isFavoriteContext(route, direction, stop) ? "star-filled" : "star",
        label: isFavoriteContext(route, direction, stop) ? "В избранном" : "В избранное",
        hint: "быстрый доступ",
        active: isFavoriteContext(route, direction, stop),
        pressed: isFavoriteContext(route, direction, stop),
        disabled: !stop,
        onClick: () => toggleCurrentFavorite(departure)
      }),
      quickActionButton({
        icon: "map",
        label: "Карта маршрута",
        hint: "схема пути",
        disabled: !route,
        onClick: () => openRouteMap(route)
      })
    );
    return actions;
  }

  function quickActionButton({ icon, label, hint = "", active = false, pressed = null, disabled = false, onClick }) {
    const button = create("button", `quick-action-card ${active ? "is-active" : ""}`);
    button.type = "button";
    button.disabled = disabled;
    if (pressed !== null) button.setAttribute("aria-pressed", pressed ? "true" : "false");
    button.setAttribute("aria-label", hint ? `${label}: ${hint}` : label);
    button.title = hint ? `${label}: ${hint}` : label;
    button.append(scheduleLineIcon(icon, "quick-action-icon"), create("strong", "", label));
    if (hint) button.append(create("small", "", hint));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (!button.disabled) onClick?.();
    });
    return button;
  }

  function openReminderSettings({ route, direction, stop, departure } = {}) {
    if (!route || !direction || !stop || !departure) return;
    const favoriteId = routeFavoriteId(route, direction, stop);
    const favorite = state.favorites.find((item) => item.id === favoriteId) || null;
    const alarm = favorite ? alarmStateForFavorite(favorite, departure) : null;
    openAlarmBottomSheet({ favorite, departure, route, direction, stop, alarm });
  }

  function departureDestination(departure, direction) {
    return departure?.destinationStop || direction?.to || direction?.destination || "";
  }

  function departureSectionTitle() {
    if (state.dayMode === "today") return "Отправления сегодня";
    if (state.dayMode === "weekday") return "Отправления по будням";
    return "Отправления в выходные";
  }

  function departureSummaryLabel(times = [], next = null) {
    if (!times.length) return "для выбранной остановки рейсов нет";
    const value = state.dayMode === "today" ? remainingTimesCount(times) : times.length;
    const countText = value > 0 ? tripCountLabel(value) : "рейсов больше нет";
    if (state.dayMode === "today") {
      return next ? `${countText} впереди, ближайший ${next.time}` : countText;
    }
    return `${countText} в выбранном режиме`;
  }

  function departurePreviewLabel(times = [], next = null) {
    if (!times.length) return "Открыть";
    const focus = state.selectedDeparture || next || times[0];
    const preview = visibleTimesForStrip(times, focus).slice(0, 3).map((item) => item.time).filter(Boolean);
    const rest = Math.max(0, times.length - preview.length);
    return rest > 0 ? `${preview.join(" · ")} · ещё ${rest}` : preview.join(" · ");
  }

  function tripCountLabel(count) {
    const value = Number(count || 0);
    const mod10 = value % 10;
    const mod100 = value % 100;
    if (mod10 === 1 && mod100 !== 11) return `${value} рейс`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${value} рейса`;
    return `${value} рейсов`;
  }

  function renderStops() {
    const direction = activeDirection();
    const currentStop = activeStop();
    const vehiclePosition = routeVehiclePosition(state.timeline);
    clear(els.stopsPanel);
    els.stopsPanel.classList.toggle("is-full-route", state.showAllStops || Boolean(state.stopSearch));
    els.stopsPanel.classList.toggle("has-live-bus", Boolean(vehiclePosition));
    const title = create("h3", "", state.stopSearch ? "Найденные остановки" : "Схема маршрута");
    if (!state.stopSearch && vehiclePosition) {
      const badge = create("span", "route-live-badge");
      badge.append(create("span", "route-live-dot"), document.createTextNode("На линии"));
      title.append(badge);
    }
    els.stopsPanel.append(title);
    if (!state.stopSearch) {
      // Бус-строка внутри схемы несёт live-инфо (макет 2a) — отдельная
      // summary-карточка больше не нужна; всегда показываем короткий help.
      els.stopsPanel.append(create("p", "schedule-inline-help route-help", "Нажмите остановку — отправления от неё."));
    }
    const baseStops = routeStopsForDirection(direction);
    const allStops = state.stopSearch
      ? selectableStopsForDirection(direction)
      : mergeTimelineOnlyStops(baseStops, state.timeline);
    const stops = allStops.filter((stop) => {
      return !state.stopSearch || stopMatchesSearch(stop, state.stopSearch);
    });

    if (!stops.length) {
      els.stopsPanel.append(create("p", "muted", "По этому запросу остановок не найдено."));
      return;
    }

    // Компактная timeline-схема (хендофф «Схема маршрута» 2a): номерные точки,
    // приглушённый пройденный путь, акцент впереди, отдельная bus-строка,
    // gap-чипы «ещё N остановок». Данные/выбор видимых остановок — прежние.
    const list = create("ul", `stops-list route-timeline rs-timeline${state.stopSearch ? "" : " rs-compact"}`);
    const timelineByStop = new Map(state.timeline.map((item) => [item.stopUid, item]));
    const hasLoadedTimeline = state.timeline.length > 0;
    const previewSourceStops = stops;
    const terminalSourceStops = allStops;
    const lastSourceIndex = terminalSourceStops.length - 1;
    const vehicleFocusStop = vehiclePosition?.focusStopUid
      ? previewSourceStops.find((stop) => stop.id === vehiclePosition.focusStopUid)
        || terminalSourceStops.find((stop) => stop.id === vehiclePosition.focusStopUid)
      : null;
    const visibleStops = !state.stopSearch && !state.showAllStops
      ? routeTimelinePreviewStops(previewSourceStops, vehicleFocusStop || currentStop)
      : stops;
    // «Следы» автобуса: остановки ДО текущего положения помечаем is-passed.
    const vehicleAnchorId = vehiclePosition
      ? (vehiclePosition.kind === "between" ? vehiclePosition.fromStopUid : vehiclePosition.stopUid)
      : null;
    const vehicleAnchorIndex = vehicleAnchorId
      ? terminalSourceStops.findIndex((item) => item.id === vehicleAnchorId)
      : -1;

    const SEG_ACCENT = "var(--color-accent)";
    const SEG_PASSED = "var(--rsx-passed-line)";
    // Цвет сегмента между исходными остановками k и k+1 (или null = не рисуем).
    const segColor = (k) => {
      if (k < 0 || k >= lastSourceIndex) return null;
      if (!vehiclePosition || vehicleAnchorIndex < 0) return SEG_ACCENT;
      if (k < vehicleAnchorIndex) return SEG_PASSED;
      if (vehiclePosition.kind === "between" && k === vehicleAnchorIndex) return null; // рисует bus-строка
      return SEG_ACCENT;
    };

    const buildBusRow = () => {
      const busRow = create("li", "rs-row rs-bus-row");
      busRow.setAttribute("aria-hidden", "true");
      busRow.title = vehiclePosition.label || "";
      const marker = create("span", "rs-marker");
      marker.append(create("span", "rs-seg rs-bus-line"));
      const dot = create("span", "rs-dot rs-bus-dot");
      dot.append(scheduleLineIcon("bus", "route-bus-icon"));
      marker.append(dot);
      busRow.append(marker, create("span", "rs-bus-label", "в пути"));
      return busRow;
    };

    const buildGapRow = (count, sideColor) => {
      // Только пунктир-разрыв, без чипа «ещё N остановок» (решение владельца):
      // непрерывность схемы сохраняем, а счётчик скрытых остановок и так есть
      // в нижней кнопке «Показаны N из M».
      const gapRow = create("li", "rs-row rs-gap-row");
      gapRow.setAttribute("aria-hidden", "true");
      gapRow.style.setProperty("--rs-gap", sideColor || SEG_ACCENT);
      const marker = create("span", "rs-marker");
      marker.append(create("span", "rs-seg rs-gap-line"));
      gapRow.append(marker);
      return gapRow;
    };

    visibleStops.forEach((stop, index) => {
      const sourceIndex = terminalSourceStops.findIndex((item) => item.id === stop.id);
      const isStart = sourceIndex === 0;
      const isEnd = sourceIndex === lastSourceIndex;
      const isSelectedStop = stop.id === state.stopUid;
      const isVehicleStop = vehiclePosition && vehiclePosition.kind !== "between" && stop.id === vehiclePosition.stopUid;
      const nextVisibleStop = visibleStops[index + 1] || null;
      const isVehicleSegment = vehiclePosition?.kind === "between"
        && stop.id === vehiclePosition.fromStopUid
        && nextVisibleStop?.id === vehiclePosition.toStopUid;
      const isNextStop = vehiclePosition?.kind === "between" && stop.id === vehiclePosition.toStopUid;
      const isPassed = vehicleAnchorIndex >= 0 && sourceIndex >= 0 && !isVehicleStop
        && (sourceIndex < vehicleAnchorIndex || (sourceIndex === vehicleAnchorIndex && vehiclePosition.kind === "between"));
      const stopName = stopDisplayName(stop);
      const item = create("li", `stop-item rs-row ${isSelectedStop ? "is-selected-stop" : ""} ${isVehicleStop ? "is-current is-live-stop" : ""} ${isNextStop ? "is-next-stop" : ""} ${isPassed ? "is-passed" : ""} ${stop.extraBoundary ? "is-extra-boundary" : ""} ${isStart ? "is-terminal is-start" : ""} ${isEnd ? "is-terminal is-end" : ""}`);
      // Цвета верхнего/нижнего полусегментов линии — из сквозной раскраски.
      const topColor = segColor(sourceIndex - 1);
      const botColor = segColor(sourceIndex);
      item.style.setProperty("--rs-top", topColor || "transparent");
      item.style.setProperty("--rs-bot", botColor || "transparent");
      if (!stop.timelineOnly) {
        item.setAttribute("role", "button");
        item.tabIndex = 0;
        item.setAttribute("aria-label", `${stopName}. Открыть отправления от этой остановки`);
        item.setAttribute("aria-haspopup", "dialog");
        item.setAttribute("aria-pressed", isSelectedStop ? "true" : "false");
        if (isSelectedStop) item.setAttribute("aria-current", "true");
      } else {
        item.setAttribute("aria-disabled", "true");
      }
      const displayPosition = sourceIndex >= 0 ? sourceIndex + 1 : stop.position;
      const stopNote = stop.timelineOnly
        ? timelineOnlyStopNote(stop)
        : stop.extraBoundary
          ? extraBoundaryStopNote(stop)
          : isStart ? "Начальная остановка" : isEnd ? "Конечная остановка" : stopPositionLabel(displayPosition);
      // Колонка-маркер: два полусегмента + номерная точка (у автобуса — иконка).
      const marker = create("span", "rs-marker");
      marker.append(create("span", "rs-seg rs-seg-top"), create("span", "rs-seg rs-seg-bot"));
      const dot = create("span", "rs-dot");
      if (isVehicleStop) {
        dot.classList.add("rs-dot-bus");
        dot.append(scheduleLineIcon("bus", "route-bus-icon"));
        dot.title = vehiclePosition.label || "";
      } else {
        dot.textContent = String(displayPosition || "");
      }
      marker.append(dot);
      // Текстовая колонка.
      const stopText = create("span", "rs-text");
      const stopTitle = create("span", "rs-name-row");
      stopTitle.append(create("strong", "", stopName));
      if (isVehicleStop) stopTitle.append(create("em", "stop-inline-live", "сейчас"));
      stopText.append(stopTitle, create("small", "rs-note", stopNote));
      // Колонка времени.
      const stopStatus = create("span", "rs-time");
      const timelineItem = timelineByStop.get(stop.id);
      if (timelineItem?.time) {
        stopStatus.textContent = timelineItem.time;
      } else if (timelineItem?.inferred) {
        stopStatus.classList.add("is-note");
        stopStatus.textContent = "конечная";
      } else if (isSelectedStop && (state.selectedDeparture?.time || getNextDeparture(selectedTimes())?.time)) {
        stopStatus.textContent = state.selectedDeparture?.time || getNextDeparture(selectedTimes())?.time || "";
      }
      if (hasLoadedTimeline && !timelineItem) {
        item.classList.add("is-skipped");
        stopStatus.classList.add("is-note", "is-missed");
        stopStatus.textContent = "нет в рейсе";
      }
      if (stop.timelineOnly) {
        item.classList.add("is-timeline-only");
        item.setAttribute("aria-label", `${stopName}. ${stopNote}`);
      }
      item.append(marker, stopText, stopStatus);
      const selectStop = () => selectScheduleStop(stop).catch((error) => console.error(error));
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectStop();
      });
      item.addEventListener("click", selectStop);
      list.append(item);

      // Отдельная bus-строка «в пути ≈ ETA» между from и to.
      if (isVehicleSegment) {
        list.append(buildBusRow());
      } else if (!state.showAllStops && !state.stopSearch && nextVisibleStop) {
        // gap-чип «ещё N остановок» между несмежными видимыми остановками.
        const nextSourceIndex = terminalSourceStops.findIndex((source) => source.id === nextVisibleStop.id);
        const hidden = nextSourceIndex - sourceIndex - 1;
        if (hidden > 0) list.append(buildGapRow(hidden, isPassed ? SEG_PASSED : SEG_ACCENT));
      }
    });
    els.stopsPanel.append(list);

    if (!state.stopSearch) {
      const isCollapsedPreview = !state.showAllStops && visibleStops.length < stops.length;
      const showAllLabel = state.showAllStops
        ? "Свернуть список остановок"
        : isCollapsedPreview
          ? `Показаны ${visibleStops.length} из ${stops.length} · Открыть все`
          : "Полный список остановок";
      const showAll = create("button", "full-stops-button rs-toggle", showAllLabel);
      showAll.type = "button";
      showAll.title = state.showAllStops ? "Показать короткую схему маршрута" : "Показать все остановки маршрута";
      showAll.addEventListener("click", () => {
        state.showAllStops = !state.showAllStops;
        renderStops();
        if (!(state.showAllStops && scrollBusMarkerIntoView("smooth"))) {
          scrollStopsIntoView();
        }
      });
      els.stopsPanel.append(showAll);
    }
  }

  async function selectScheduleStop(stop) {
    if (!stop || stop.timelineOnly) return;
    if (state.stopUid === stop.id) {
      openStopTimesSheet(stop);
      return;
    }
    state.stopUid = stop.id;
    state.showAllStops = false;
    resetStopFilter();
    renderRouteSelectors();
    state.shouldScrollToSchedule = false;
    const loaded = await loadSchedule();
    if (loaded) openStopTimesSheet(activeStop() || stop);
  }

  function mergeTimelineOnlyStops(stops = [], timeline = []) {
    const byId = new Map((stops || []).map((stop) => [stop.id, stop]));
    const extras = (timeline || [])
      .filter((item) => item?.timelineOnly && item.stopUid && !byId.has(item.stopUid))
      .map((item) => ({
        id: item.stopUid,
        name: item.stopName,
        position: Number(item.position),
        timelineOnly: true,
        timelineOnlyKind: item.timelineOnlyKind || ""
      }))
      .filter((item) => item.name);

    if (!extras.length) return stops || [];
    return [...extras, ...(stops || [])].sort((a, b) => {
      const left = Number(a.position);
      const right = Number(b.position);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      if (a.timelineOnly !== b.timelineOnly) return a.timelineOnly ? -1 : 1;
      return 0;
    });
  }

  function renderRouteLiveSummary(position) {
    const summary = create("div", "route-live-summary");
    summary.setAttribute("role", "status");
    summary.setAttribute("aria-live", "polite");
    const label = compactLivePositionLabel(position);
    summary.append(
      scheduleLineIcon("bus", "route-live-summary-icon"),
      create("strong", "", "Расчёт по расписанию"),
      create("span", "", label),
      create("small", "", "Не GPS, а положение по времени рейса")
    );
    return summary;
  }

  function routeTimelinePreviewStops(stops, currentStop) {
    if (!Array.isArray(stops) || stops.length <= 6) return stops || [];
    const byId = new Map(stops.map((stop, index) => [stop.id, index]));
    const currentIndex = byId.has(currentStop?.id) ? byId.get(currentStop.id) : 0;
    const indexes = new Set([0, stops.length - 1, currentIndex]);
    for (let offset = -2; offset <= 2; offset += 1) {
      const index = currentIndex + offset;
      if (index > 0 && index < stops.length - 1) indexes.add(index);
    }
    return [...indexes]
      .sort((left, right) => left - right)
      .slice(0, 7)
      .map((index) => stops[index])
      .filter(Boolean);
  }

  function routeVehiclePosition(timeline = state.timeline) {
    if (state.dayMode !== "today" || !Array.isArray(timeline) || !timeline.length) return null;
    const points = normalizeTimelineMinutes(timeline);
    if (!points.length) return null;

    const first = points[0];
    const last = points[points.length - 1];
    let now = minutesFromDate(new Date());
    if (now < first.minutes - 180 && last.minutes >= 1440) now += 1440;
    if (now < first.minutes || now > last.minutes) return null;

    if (now <= first.minutes) {
      return {
        kind: "stop",
        status: "waiting",
        stopUid: first.stopUid,
        focusStopUid: first.stopUid,
        label: `По расписанию автобус ожидает отправления от ${first.stopName || "начальной остановки"} в ${first.time}`
      };
    }

    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (now === point.minutes) {
        return {
          kind: "stop",
          status: "at-stop",
          stopUid: point.stopUid,
          focusStopUid: point.stopUid,
          label: `По расписанию автобус у остановки ${point.stopName || ""}`.trim()
        };
      }

      const next = points[index + 1];
      if (!next || next.minutes <= point.minutes) continue;
      if (now > point.minutes && now < next.minutes) {
        const progress = (now - point.minutes) / (next.minutes - point.minutes);
        return {
          kind: "between",
          status: "between-stops",
          fromStopUid: point.stopUid,
          toStopUid: next.stopUid,
          focusStopUid: point.stopUid,
          progress: Math.min(Math.max(progress, 0.12), 0.88),
          label: `По расписанию автобус между ${point.stopName || "остановкой"} и ${next.stopName || "следующей остановкой"}`
        };
      }
    }

    return {
      kind: "stop",
      status: "finished",
      stopUid: last.stopUid,
      focusStopUid: last.stopUid,
      label: `По расписанию рейс прибыл на ${last.stopName || "конечную остановку"}`
    };
  }

  function normalizeTimelineMinutes(timeline) {
    let dayOffset = 0;
    let previousMinutes = -1;
    return timeline
      .map((item) => {
        const time = item.time || item.arrivalTime || "";
        const rawMinutes = safeMinutesFromTime(time);
        if (!Number.isFinite(rawMinutes)) return null;
        while (rawMinutes + dayOffset < previousMinutes) dayOffset += 1440;
        const minutes = rawMinutes + dayOffset;
        previousMinutes = minutes;
        return {
          stopUid: item.stopUid,
          stopName: item.stopName,
          time,
          minutes
        };
      })
      .filter((item) => item?.stopUid && Number.isFinite(item.minutes));
  }

  function safeMinutesFromTime(time) {
    const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return NaN;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return NaN;
    return hours * 60 + minutes;
  }

  function routeVehicleMarker(position) {
    const marker = create("span", "route-bus-marker");
    marker.title = position?.label || "";
    marker.setAttribute("aria-hidden", "true");
    marker.append(scheduleLineIcon("bus", "route-bus-icon"));
    return marker;
  }

  function routeVehicleMarkerFallbackY(progress) {
    const value = Number(progress);
    const bounded = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
    return Math.round(8 + bounded * 40);
  }

  function alignRouteVehicleMarker(list, vehiclePosition) {
    if (!list || vehiclePosition?.kind !== "between") return;
    const item = list.querySelector(".stop-item.is-live-segment");
    const fromDot = item?.querySelector(".stop-dot");
    const toDot = item?.nextElementSibling?.querySelector(".stop-dot");
    const marker = item?.querySelector(".route-bus-marker");
    if (!item || !fromDot || !toDot || !marker) return;

    const itemRect = item.getBoundingClientRect();
    const fromRect = fromDot.getBoundingClientRect();
    const toRect = toDot.getBoundingClientRect();
    if (!itemRect.height || !fromRect.height || !toRect.height) return;

    const progress = Math.min(Math.max(Number(vehiclePosition.progress) || 0, 0), 1);
    const fromY = fromRect.top + fromRect.height / 2 - itemRect.top;
    const toY = toRect.top + toRect.height / 2 - itemRect.top;
    item.style.setProperty("--live-y", `${Math.round(fromY + (toY - fromY) * progress)}px`);
  }

  function scheduleRouteVehicleMarkerAlignment() {
    if (state.activeView !== "schedule") return;
    window.requestAnimationFrame(() => {
      alignRouteVehicleMarker(els.stopsPanel?.querySelector(".route-timeline"), routeVehiclePosition(state.timeline));
    });
  }

  function scheduleLineIcon(name, className = "") {
    const icons = {
      bell: '<svg viewBox="0 0 24 24" focusable="false"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M13.7 21a2 2 0 0 1-3.4 0"></path></svg>',
      bus: '<svg viewBox="0 0 24 24" focusable="false"><path d="M7 17h10"></path><path d="M6 17V6.8C6 5.8 6.8 5 7.8 5h8.4c1 0 1.8.8 1.8 1.8V17"></path><path d="M6 10h12"></path><path d="M8 21l1.2-2"></path><path d="M14.8 19L16 21"></path><circle cx="9" cy="14" r="1"></circle><circle cx="15" cy="14" r="1"></circle></svg>',
      calendar: '<svg viewBox="0 0 24 24" focusable="false"><rect x="4" y="5.2" width="16" height="15" rx="3"></rect><path d="M8 3.5v4M16 3.5v4M4 10h16"></path><path d="M8 14h2M12 14h2M16 14h.01M8 17h2M12 17h2"></path></svg>',
      more: '<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="5.8" r="1.4"></circle><circle cx="12" cy="12" r="1.4"></circle><circle cx="12" cy="18.2" r="1.4"></circle></svg>',
      close: '<svg viewBox="0 0 24 24" focusable="false"><path d="M6.5 6.5 17.5 17.5"></path><path d="M17.5 6.5 6.5 17.5"></path></svg>',
      map: '<svg viewBox="0 0 24 24" focusable="false"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"></path><path d="M9 3v15"></path><path d="M15 6v15"></path></svg>',
      star: '<svg viewBox="0 0 24 24" focusable="false"><path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 3Z"></path></svg>',
      "star-filled": '<svg viewBox="0 0 24 24" focusable="false"><path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 3Z"></path></svg>'
    };
    const icon = create("span", `schedule-line-icon schedule-icon-${name} ${className}`.trim());
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = icons[name] || icons.bus;
    return icon;
  }

  function ensureRoutesFilterTabs() {
    document.querySelector("#routeFilterTabs")?.remove();
    state.routeDayFilter = "all";
  }

  function renderRoutesFilterTabs() {
    document.querySelectorAll("[data-route-day-filter]").forEach((button) => {
      const isActive = button.dataset.routeDayFilter === state.routeDayFilter;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  function syncDayModeButtons() {
    document.querySelectorAll("[data-day-mode]").forEach((item) => {
      const isActive = item.dataset.dayMode === state.dayMode;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", isActive ? "true" : "false");
      item.tabIndex = isActive ? 0 : -1;
    });
  }

  function handleDayModeKeydown(event, buttons, index) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key) || !buttons.length) return;
    event.preventDefault();
    const lastIndex = buttons.length - 1;
    let nextIndex = index;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = lastIndex;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = index <= 0 ? lastIndex : index - 1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = index >= lastIndex ? 0 : index + 1;
    const nextButton = buttons[nextIndex];
    nextButton?.focus();
    nextButton?.click();
  }

  function routeAccent(route) {
    if (route?.missing) return "#64748b";
    const palette = ["#2563eb", "#10b981", "#e11d48", "#8b5cf6", "#f97316", "#0891b2", "#f59e0b", "#db2777"];
    const number = Number.parseInt(route?.number, 10);
    return palette[((Number.isFinite(number) ? number : 1) - 1 + palette.length) % palette.length];
  }

  function routeColor(route) {
    return route?.color || routeAccent(route);
  }

  function routeDisplayName(route) {
    return String(route?.name || "")
      .replace(/\s+[-–—]\s+/g, " ↔ ")
      .replace(/\s*->\s*/g, " → ");
  }

  function routeTileName(route) {
    const direction = defaultDirectionForRoute(route);
    return (routeDirectionDisplayLabel(route, direction) || routeDisplayName(route) || `Маршрут ${route?.number || ""}`)
      .replace(/\s*[↔→]\s*|\s+-\s+/g, " – ")
      .replace(/Автобусный парк/giu, "Автопарк")
      .replace(/Сквер Героя Карвата/giu, "скв. Карвата")
      .replace(/Агрогородок\s+/giu, "аг. ")
      .replace(/ООО\s+"([^"]+)"/giu, "$1")
      .replace(/Магазин\s+"?ОМА"?/giu, "м-н ОМА")
      .replace(/Мкрн\.?\s+"([^"]+)"/giu, "м-н $1")
      .replace(/Мкрн\.?\s+([^–-]+)/giu, "м-н $1")
      .replace(/Мк-рн\s+"([^"]+)"/giu, "м-н $1")
      .replace(/Микрорайон\s+/giu, "м-н ")
      .replace(/Кладбище\s+/giu, "кл. ")
      .replace(/Ул\.\s*/giu, "ул. ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function routeFavoriteId(route, direction = defaultDirectionForRoute(route), stop = defaultStopForDirection(direction)) {
    return route && direction && stop ? `${route.id}:${direction.code}:${stop.id}` : "";
  }

  function isFavoriteContext(route, direction = defaultDirectionForRoute(route), stop = defaultStopForDirection(direction)) {
    const id = routeFavoriteId(route, direction, stop);
    return Boolean(id && state.favorites.some((item) => item.id === id));
  }

  function renderRoutes() {
    const routes = filteredRoutes();
    const config = activeTransportConfig();
    ensureRoutesFilterTabs();
    renderRoutesFilterTabs();
    if (els.routesTitle) els.routesTitle.textContent = transportRoutesHeading();
    clear(els.routeList);

    if (!routes.length) {
      els.routeList.append(createRoutesEmptyState(config));
      return;
    }

    routes.forEach((route) => {
      const accent = routeColor(route);
      const routeName = routeTileName(route);
      const card = create("div", `route-card route-tile ${route.missing ? "is-missing" : ""}`);
      const number = create("span", "route-number", route.number);
      // Длина номера → CSS уменьшает кегль, чтобы 3-4 знака не тёрлись о края
      // квадрата (508 «резался», жалоба владельца 2026-07-12).
      number.dataset.len = String(route.number || "").trim().length;
      const label = create("span", "route-tile-label", routeName || `Маршрут ${route.number}`);
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.style.setProperty("--route-color", accent);
      card.setAttribute("aria-label", `Открыть расписание маршрута ${route.number}${routeName ? `: ${routeName}` : ""}`);
      card.title = routeName ? `Маршрут ${route.number}: ${routeName}` : `Маршрут ${route.number}`;
      card.addEventListener("click", () => openRoute(route));
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openRoute(route);
      });
      number.style.background = accent;
      number.setAttribute("aria-hidden", "true");
      card.append(number, label);
      els.routeList.append(card);
    });
  }

  function renderFavorites(options = {}) {
    if (!els.favoritesList) return;
    const loadSchedules = options.loadSchedules ?? state.activeView === "favorites";
    clear(els.favoritesList);

    const favorites = Array.isArray(state.favorites) ? state.favorites : [];
    updateFavoritesNavBadge(favorites.length);
    if (els.favoritesPanel) els.favoritesPanel.hidden = false;
    if (els.favoritesCount) els.favoritesCount.textContent = favoriteCountLabel(favorites.length);
    if (els.favoritesEmpty) els.favoritesEmpty.hidden = favorites.length > 0;

    if (!favorites.length) {
      renderHomeFavoriteRoutes({ loadSchedules: false });
      return;
    }

    favorites.forEach((favorite) => {
      const card = renderFavoriteStopCard(favorite);
      els.favoritesList.append(card);
      if (loadSchedules) loadFavoriteSchedule(favorite);
    });

    renderHomeFavoriteRoutes({ loadSchedules: state.activeView === "home" });
  }

  function renderHomeFavoriteRoutes(options = {}) {
    if (!els.homeFavoriteRoutes || !els.homeFavoriteRoutesList) return;
    const loadSchedules = options.loadSchedules ?? state.activeView === "home";
    const favorites = Array.isArray(state.favorites) ? state.favorites : [];
    const visible = favorites
      .map((favorite) => ({ favorite, ...favoriteContext(favorite) }))
      .filter((item) => item.route && item.direction && item.stop)
      .slice(0, HOME_FAVORITE_ROUTES_LIMIT);

    els.homeFavoriteRoutes.hidden = visible.length === 0;
    clear(els.homeFavoriteRoutesList);
    if (!visible.length) return;

    visible.forEach((item) => {
      els.homeFavoriteRoutesList.append(renderHomeFavoriteRouteRow(item));
      if (loadSchedules) loadFavoriteSchedule(item.favorite);
    });
  }

  function renderHomeFavoriteRouteRow({ favorite, route, direction, stop }) {
    const accent = routeColor(route);
    const row = create("button", "favorite-ride-row");
    row.type = "button";
    row.style.setProperty("--route-color", accent);
    row.setAttribute("aria-label", `Открыть маршрут ${route.number}, ${stopDisplayName(stop)}, ${routeDirectionDisplayLabel(route, direction)}`);
    row.addEventListener("click", () => openFavorite(favorite));

    const badge = create("span", "ride-route-badge", route.number);
    const copy = create("span", "ride-copy");
    const directionText = compactHomeDirectionLabel(routeDirectionDisplayLabel(route, direction) || directionLabel(route, direction));
    copy.append(
      create("b", "", directionText || routeTileName(route) || `Маршрут №${route.number}`),
      create("small", "", stopDisplayName(stop) || favorite.stopName || "Выбранная остановка")
    );

    row.append(
      badge,
      copy,
      create("span", "ride-time", homeFavoriteTimeLabel(favorite)),
      create("span", "row-arrow", "›")
    );
    row.querySelector(".row-arrow")?.setAttribute("aria-hidden", "true");
    return row;
  }

  function compactHomeDirectionLabel(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/Автобусный парк/giu, "Автопарк")
      .replace(/Сквер Героя Карвата/giu, "скв. Карвата")
      .replace(/Агрогородок\s+/giu, "аг. ")
      .replace(/Микрорайон\s+/giu, "м-н ")
      .replace(/Мкрн\.?\s+/giu, "м-н ")
      .replace(/Мк-рн\s+/giu, "м-н ")
      .replace(/Кладбище\s+/giu, "кл. ")
      .replace(/Ул\.\s*/giu, "ул. ")
      .trim();
  }

  function homeFavoriteTimeLabel(favorite) {
    const key = favoriteScheduleKey(favorite);
    const cached = state.favoriteSchedules.get(key);
    if (cached?.error) return "не загрузилось";
    if (!cached?.data) return "ищем";

    const dayMode = favorite.dayMode || "today";
    const times = selectedTimes(cached.data, dayMode);
    const departure = findFavoriteDeparture(times, favorite)
      || getNextDeparture(times, dayMode)
      || (dayMode === "today" ? null : times[0] || null);

    if (!departure) return "нет";
    if (dayMode !== "today") return departure.time || "рейс";

    const minutes = Math.round(favoriteMinutesUntil(departure, dayMode));
    if (!Number.isFinite(minutes)) return departure.time || "рейс";
    if (minutes <= 1) return "сейчас";
    if (minutes < 60) return `${minutes} мин`;
    return departure.time || "рейс";
  }

  function renderFavoriteStopCard(favorite) {
    const context = favoriteContext(favorite);
    const card = create("article", "favorite-stop-card");
    card.dataset.favoriteId = favorite.id || "";

    if (!context.route || !context.direction || !context.stop) {
      card.classList.add("is-missing");
      card.append(
        create("strong", "", favorite.title || "Избранная остановка"),
        create("span", "muted", "Эта остановка больше не найдена в расписании."),
        favoriteRemoveButton(favorite.id)
      );
      return card;
    }

    const { route, direction, stop } = context;
    card.style.setProperty("--route-color", routeColor(route));
    const key = favoriteScheduleKey(favorite);
    const cached = state.favoriteSchedules.get(key);
    const schedule = cached?.data || null;
    const dayMode = favorite.dayMode || "today";
    const times = schedule ? selectedTimes(schedule, dayMode) : [];
    const next = schedule ? getNextDeparture(times, dayMode) : null;
    const favoriteDeparture = findFavoriteDeparture(times, favorite);
    const activeDeparture = favoriteDeparture || next || (dayMode === "today" ? null : times[0] || null);
    const exactAlarm = alarmStateForFavorite(favorite, activeDeparture);
    const alarm = exactAlarm || alarmStateForFavorite(favorite, null);

    const head = create("div", "favorite-stop-head");
    const badge = create("span", "route-badge", route.number);
    badge.style.background = routeColor(route);
    const title = create("div", "favorite-stop-title");
    title.append(
      create("strong", "", stop.name),
      create("span", "", `Маршрут №${route.number} · ${directionLabel(route, direction)}`)
    );
    const actions = create("div", "favorite-card-actions");
    const alarmButton = favoriteActionButton("bell", alarm ? "Выключить будильник" : "Поставить будильник", alarm ? "is-active" : "");
    alarmButton.setAttribute("aria-pressed", alarm ? "true" : "false");
    alarmButton.disabled = !activeDeparture && !alarm;
    alarmButton.addEventListener("click", async () => {
      if (alarm) {
        await confirmAndTurnOffFavoriteAlarm(favorite, alarmButton);
        return;
      }
      if (!activeDeparture) {
        showToast("Сегодня рейсов больше нет.");
        return;
      }
      openAlarmBottomSheet({ favorite, departure: activeDeparture, route, direction, stop, alarm: exactAlarm || alarm });
    });
    const scheduleButton = favoriteActionButton("calendar", "Открыть расписание");
    scheduleButton.addEventListener("click", () => openFavorite(favorite));
    actions.append(alarmButton, scheduleButton, favoriteMenuButton(favorite, { hasAlarm: Boolean(alarm) }));
    head.append(badge, title, actions);

    const status = create("div", "favorite-next-line");
    if (!schedule) {
      const skeletonTime = create("span", "favorite-skeleton favorite-skeleton-time");
      const skeletonText = create("span", "favorite-skeleton favorite-skeleton-text");
      const skeletonDot = create("span", "favorite-skeleton favorite-skeleton-dot");
      [skeletonTime, skeletonText, skeletonDot].forEach((node) => node.setAttribute("aria-hidden", "true"));
      status.classList.add("is-loading");
      status.append(skeletonTime, skeletonText, skeletonDot);
    } else if (activeDeparture) {
      const urgency = favoriteUrgencyClass(activeDeparture, dayMode);
      const left = create("span", "favorite-departure-left", favoriteDepartureLabel(activeDeparture, dayMode));
      left.append(create("i", `favorite-urgency-dot ${urgency}`));
      status.append(
        create("strong", "", activeDeparture.time),
        left
      );
    } else {
      status.classList.add("is-empty");
      status.append(create("strong", "", "Рейсов нет"), create("span", "", "Сегодня рейсов больше нет."));
    }

    const alarmStatus = create("div", `favorite-alarm-status ${alarm ? "is-on" : "is-off"}`);
    const statusIcon = scheduleLineIcon("bell", "favorite-alarm-status-icon");
    alarmStatus.append(statusIcon);
    if (alarm) {
      alarmStatus.append(
        create("span", "", `Будильник: ${alarm.departureTime || activeDeparture?.time || favorite.time || ""}`.trim()),
        create("b", "", `${alarmModeLabel(alarm.repeatMode, alarm.repeatDays)}, за ${formatReminderLead(alarm.remindMinutes)}`)
      );
    } else {
      alarmStatus.append(
        create("span", "", "Будильник выключен"),
        create("b", "", `режим: ${favoriteDayLabel(dayMode)}`)
      );
    }

    if (alarm && !alarm.departureTime && !activeDeparture?.time && !favorite.time) {
      clear(alarmStatus);
      alarmStatus.append(
        statusIcon,
        create("span", "", `Будильник: ${alarmModeLabel(alarm.repeatMode, alarm.repeatDays)}`),
        create("b", "", `за ${formatReminderLead(alarm.remindMinutes)}`)
      );
    }

    card.append(head, status, alarmStatus);
    return card;
  }

  function favoriteActionButton(icon, label, extraClass = "") {
    const button = create("button", `favorite-action-button ${extraClass}`.trim());
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(scheduleLineIcon(icon, "favorite-action-icon"));
    return button;
  }

  function favoriteMenuButton(favorite, options = {}) {
    const wrap = create("div", "favorite-menu");
    const button = favoriteActionButton("more", "Меню");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    const menu = create("div", "favorite-menu-popover");
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const open = create("button", "", "Открыть расписание");
    open.type = "button";
    open.setAttribute("role", "menuitem");
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      closeFavoriteMenus();
      openFavorite(favorite);
    });

    const disableAlarm = create("button", "", "Выключить будильник");
    disableAlarm.type = "button";
    disableAlarm.setAttribute("role", "menuitem");
    disableAlarm.hidden = !options.hasAlarm;
    disableAlarm.addEventListener("click", async (event) => {
      event.stopPropagation();
      closeFavoriteMenus();
      if (!alarmEntriesForFavorite(favorite.id).length) {
        showToast("Будильник уже выключен.");
        renderFavorites({ loadSchedules: state.activeView === "favorites" });
        return;
      }
      await confirmAndTurnOffFavoriteAlarm(favorite, button);
    });

    const remove = create("button", "is-danger", "Удалить из избранного");
    remove.type = "button";
    remove.setAttribute("role", "menuitem");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFavorite(favorite.id);
    });

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const shouldOpen = menu.hidden || !menu.classList.contains("is-open");
      closeFavoriteMenus();
      if (shouldOpen) openFavoriteMenu(menu, button);
    });

    menu.append(open, disableAlarm, remove);
    wrap.append(button, menu);
    return wrap;
  }

  function openFavoriteMenu(menu, button) {
    menu.hidden = false;
    menu.closest(".favorite-stop-card")?.classList.add("is-menu-open");
    button?.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      if (!menu.hidden) menu.classList.add("is-open");
    });
  }

  function closeFavoriteMenus(event) {
    const target = event?.target instanceof Element ? event.target : null;
    if (target?.closest(".favorite-menu")) return;
    document.querySelectorAll(".favorite-menu-popover").forEach((menu) => {
      menu.classList.remove("is-open");
      menu.closest(".favorite-stop-card")?.classList.remove("is-menu-open");
      menu.closest(".favorite-menu")?.querySelector(".favorite-action-button")?.setAttribute("aria-expanded", "false");
      window.setTimeout(() => {
        if (!menu.classList.contains("is-open")) menu.hidden = true;
      }, 130);
    });
  }

  function favoriteMinutesUntil(departure, dayMode) {
    if (!departure) return NaN;
    if (dayMode !== "today") return Number(departure.diff ?? departure.minutes);
    if (Number.isFinite(Number(departure.diff))) return Number(departure.diff);
    const now = minutesFromDate(new Date());
    const minutes = relativeDepartureMinutes(departure, now);
    if (Number.isFinite(minutes)) return minutes - now;
    return NaN;
  }

  function favoriteUrgencyClass(departure, dayMode) {
    const minutes = favoriteMinutesUntil(departure, dayMode);
    if (!Number.isFinite(minutes)) return "is-gray";
    if (minutes < 5) return "is-red";
    if (minutes <= 15) return "is-yellow";
    return "is-green";
  }

  function alarmKeyForFavorite(favorite, departure) {
    return [
      favorite?.id || "",
      departure?.time || "",
      departure?.dayMask || "",
      departure?.tripCode || "",
      departure?.variantCode || ""
    ].join("|");
  }

  function alarmStateForFavorite(favorite, departure) {
    if (!favorite) return null;
    const exact = departure ? state.alarms[alarmKeyForFavorite(favorite, departure)] : null;
    if (exact) return exact;
    if (departure) return null;
    return Object.values(state.alarms).find((item) => item.favoriteId === favorite.id) || null;
  }

  function alarmEntriesForFavorite(favoriteId) {
    if (!favoriteId) return [];
    return Object.entries(state.alarms || {})
      .filter(([, alarm]) => alarm?.favoriteId === favoriteId)
      .map(([key, alarm]) => ({ key, alarm }));
  }

  function reminderIdsForFavoriteAlarm(favoriteId) {
    return [...new Set(
      alarmEntriesForFavorite(favoriteId)
        .map(({ alarm }) => alarm?.reminderId)
        .filter(Boolean)
    )];
  }

  function deleteAlarmEntriesForFavorite(favoriteId) {
    alarmEntriesForFavorite(favoriteId).forEach(({ key }) => {
      delete state.alarms[key];
    });
    writeAlarmStates();
  }

  async function confirmAndTurnOffFavoriteAlarm(favorite, triggerButton = null) {
    if (!favorite?.id) return false;
    const confirmed = await confirmFavoriteAlarmDisable(favorite);
    if (!confirmed) return false;
    triggerButton?.setAttribute("aria-busy", "true");
    if (triggerButton) triggerButton.disabled = true;
    try {
      await turnOffFavoriteAlarm(favorite);
      tg?.HapticFeedback?.notificationOccurred?.("success");
      showToast("Будильник выключен. Избранное осталось.");
      return true;
    } catch (error) {
      tg?.HapticFeedback?.notificationOccurred?.("error");
      showToast(error?.message || "Не удалось выключить будильник.");
      if (triggerButton) {
        triggerButton.disabled = false;
        triggerButton.removeAttribute("aria-busy");
      }
      return false;
    }
  }

  function confirmFavoriteAlarmDisable(favorite) {
    const stopName = favorite?.stopName || favorite?.title || "этой остановки";
    const message = `Выключить будильник для ${stopName}? Избранное и расписание останутся.`;
    return askConfirmation({
      title: "Выключить будильник?",
      message,
      okText: "Выключить",
      cancelText: "Оставить"
    });
  }

  function askConfirmation({ title, message, okText = "Да", cancelText = "Нет" }) {
    return new Promise((resolve) => {
      if (tg?.showPopup) {
        tg.showPopup({
          title,
          message,
          buttons: [
            { id: "confirm", type: "destructive", text: okText },
            { id: "cancel", type: "cancel", text: cancelText }
          ]
        }, (buttonId) => resolve(buttonId === "confirm"));
        return;
      }
      resolve(window.confirm(`${title}\n\n${message}`));
    });
  }

  async function turnOffFavoriteAlarm(favorite) {
    const entries = alarmEntriesForFavorite(favorite.id);
    if (!entries.length) {
      renderFavorites();
      return;
    }

    const failures = [];
    const reminderIds = reminderIdsForFavoriteAlarm(favorite.id);
    if (reminderIds.length && !tg?.initData) {
      throw new Error("Telegram не передал ваш ID, поэтому будильник нельзя выключить для уведомления.");
    }

    if (reminderIds.length) {
      for (const reminderId of reminderIds) {
        try {
          const response = await fetch(`/api/reminders/${encodeURIComponent(reminderId)}`, {
            method: "DELETE",
            headers: telegramHeaders()
          });
          let data = null;
          try {
            data = await response.json();
          } catch {
            data = null;
          }
          if (!response.ok && response.status !== 404) {
            failures.push(data?.error || "Не удалось отменить будильник.");
          }
        } catch (error) {
          failures.push(error?.message || "Не удалось отменить будильник.");
        }
      }
    }

    if (failures.length) throw new Error(failures[0]);
    deleteAlarmEntriesForFavorite(favorite.id);
    renderFavorites({ loadSchedules: state.activeView === "favorites" });
    if (state.activeView === "schedule") renderSchedule({ skipTimelineLoad: true });
  }

  function rememberAlarmState(favorite, departure, reminder, remindMinutes, repeatOptions) {
    if (!favorite || !departure) return;
    const key = alarmKeyForFavorite(favorite, departure);
    state.alarms[key] = {
      key,
      favoriteId: favorite.id,
      reminderId: reminder?.id || "",
      departureTime: departure.time || "",
      dayMask: departure.dayMask || "",
      tripCode: departure.tripCode || "",
      variantCode: departure.variantCode || "",
      remindMinutes,
      repeatMode: repeatOptions.repeatMode || "once",
      repeatDays: Array.isArray(repeatOptions.repeatDays) ? repeatOptions.repeatDays : [],
      savedAt: new Date().toISOString()
    };
    writeAlarmStates();
  }

  function alarmModeLabel(mode, days = []) {
    if (mode === "weekdays") return alarmDaysLabel(days, [1, 2, 3, 4, 5]) || "Будни";
    if (mode === "weekends") return alarmDaysLabel(days, [6, 7]) || "Выходные";
    if (mode === "custom") return alarmDaysLabel(days) || "Свои дни";
    return "Один раз";
  }

  function alarmDaysLabel(days = [], fullSet = null) {
    const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    const selectedDays = [...new Set((days || []).map(Number).filter((day) => day >= 1 && day <= 7))].sort((left, right) => left - right);
    if (!selectedDays.length) return "";
    if (Array.isArray(fullSet) && selectedDays.length === fullSet.length && selectedDays.every((day, index) => day === fullSet[index])) return "";
    return selectedDays.map((day) => labels[day - 1]).filter(Boolean).join(", ");
  }

  function favoriteRemoveButton(id) {
    const remove = create("button", "favorite-remove-button", "×");
    remove.type = "button";
    remove.title = "Удалить из избранного";
    remove.setAttribute("aria-label", "Удалить из избранного");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFavorite(id);
    });
    return remove;
  }

  function favoriteContext(favorite) {
    const route = (state.data?.routes || []).find((item) => item.id === favorite.routeId);
    const direction = route?.directions?.find((item) => item.code === favorite.directionCode);
    const stop = selectableStopsForDirection(direction).find((item) => item.id === favorite.stopUid);
    return { route, direction, stop };
  }

  function favoriteScheduleKey(favorite) {
    return [favorite.routeId, favorite.directionCode, favorite.stopUid].filter(Boolean).join(":");
  }

  function findFavoriteDeparture(times, favorite) {
    if (!Array.isArray(times) || !times.length || !favorite?.time) return null;
    const sameFavoriteDay = (item) => {
      if (!favorite.dayMask) return true;
      return item.dayMask === favorite.dayMask || (item.sourceDayMasks || []).includes(favorite.dayMask);
    };
    const exact = times.find((item) => {
      if (item.time !== favorite.time || !sameFavoriteDay(item)) return false;
      if (favorite.tripCode && item.tripCode !== favorite.tripCode) return false;
      if (favorite.variantCode && item.variantCode !== favorite.variantCode) return false;
      return true;
    });
    return exact || times.find((item) => item.time === favorite.time) || null;
  }

  function visibleTimesForFavorite(times, activeDeparture, dayMode) {
    if (!Array.isArray(times) || times.length < 2) return times || [];
    if (dayMode === "today") return visibleTimesForStrip(times, activeDeparture);
    const activeKey = selectedDepartureKey(activeDeparture);
    const activeIndex = activeKey ? times.findIndex((item) => selectedDepartureKey(item) === activeKey) : -1;
    if (activeIndex <= 0) return times;
    return times.slice(activeIndex).concat(times.slice(0, activeIndex));
  }

  async function loadFavoriteSchedule(favorite, force = false) {
    const context = favoriteContext(favorite);
    if (!context.route || !context.direction || !context.stop) return;

    const key = favoriteScheduleKey(favorite);
    const cached = state.favoriteSchedules.get(key);
    // Errors retry sooner than fresh data, but still back off — otherwise two
    // failing favorites re-render each other into an endless fetch loop.
    const cacheTtl = cached?.error ? 15000 : 60000;
    if (!force && cached && Date.now() - cached.updatedAt < cacheTtl) return;
    if (state.favoriteScheduleLoading.has(key)) return;

    state.favoriteScheduleLoading.add(key);
    try {
      const query = new URLSearchParams({
        routeId: context.route.id,
        directionCode: context.direction.code,
        stopUid: context.stop.id
      });
      const response = await fetch(`/api/schedule?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Schedule failed");
      state.favoriteSchedules.set(key, { data: await response.json(), updatedAt: Date.now() });
      if (state.activeView === "favorites") renderFavorites();
      if (state.activeView === "home") renderHomeFavoriteRoutes({ loadSchedules: false });
    } catch {
      // Mark the entry as errored (not empty); the shorter error TTL above retries
      // it soon without looping. Render without triggering new loads.
      state.favoriteSchedules.set(key, { data: { groups: [] }, updatedAt: Date.now(), error: true });
      if (state.activeView === "favorites") renderFavorites({ loadSchedules: false });
      if (state.activeView === "home") renderHomeFavoriteRoutes({ loadSchedules: false });
    } finally {
      state.favoriteScheduleLoading.delete(key);
    }
  }

  function favoriteDayLabel(dayMode) {
    if (dayMode === "weekday") return "будни";
    if (dayMode === "weekend") return "выходные";
    return "сегодня";
  }

  function favoriteDepartureLabel(departure, dayMode) {
    if (!departure) return "рейсов нет";
    if (dayMode !== "today") return "по расписанию";
    const now = minutesFromDate(new Date());
    const minutes = Number.isFinite(Number(departure.diff)) ? Number(departure.diff) : relativeDepartureMinutes(departure, now) - now;
    if (!Number.isFinite(minutes)) return "по расписанию";
    return formatMinutes(Math.max(0, minutes));
  }

  function favoriteCountLabel(count) {
    const value = Number(count || 0);
    const mod10 = value % 10;
    const mod100 = value % 100;
    if (mod10 === 1 && mod100 !== 11) return `${value} остановка`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${value} остановки`;
    return `${value} остановок`;
  }

  function updateFavoritesNavBadge(count) {
    if (!els.favoritesNavBadge) return;
    const value = Number(count || 0);
    els.favoritesNavBadge.hidden = value <= 0;
    els.favoritesNavBadge.textContent = value > 99 ? "99+" : String(value);
    els.favoritesNavBadge.setAttribute("aria-label", `В избранном ${favoriteCountLabel(value)}`);
  }

  function openRoute(route) {
    if (route.missing) {
      state.missingRouteNumber = route.number;
      setView("schedule");
      renderMissingRoute(route.number);
      renderQuickRoutes();
      scrollActiveViewToTop();
      return;
    }
    state.missingRouteNumber = "";
    state.routeId = route.id;
    // Every route opens fresh on "today"; renderSchedule then auto-advances to the
    // nearest service day if today is empty. Without this reset a prior route's
    // advanced mode (e.g. "Будни") would leak in and suppress the per-route advance.
    state.dayMode = "today";
    state.dayModeExplicit = false;
    const direction = defaultDirectionForRoute(route);
    state.directionCode = direction?.code || "";
    state.stopUid = defaultStopForDirection(direction)?.id || "";
    resetStopFilter();
    renderRouteSelectors();
    setView("schedule");
    state.shouldScrollToSchedule = false;
    scrollActiveViewToTop();
    loadSchedule();
  }

  function openRouteByNumber(routeNumber, transportType = state.transportType) {
    const nextType = TRANSPORT_MODES[transportType] ? transportType : state.transportType;
    if (state.transportType !== nextType) setTransportType(nextType);

    const normalizedNumber = exactRouteNumberQuery(routeNumber) || String(Number(routeNumber) || routeNumber || "").trim();
    const route = routesWithPlaceholders().find((item) => routeNumberMatches(item.number, normalizedNumber));
    if (route) {
      openRoute(route);
      return;
    }

    state.routeFilter = normalizedNumber;
    if (els.routeSearch) els.routeSearch.value = normalizedNumber;
    renderRoutes();
    setView("routes", { source: "route-number" });
  }

  function scrollActiveViewToTop() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  }

  async function openFavorite(favorite) {
    const route = (state.data.routes || []).find((item) => item.id === favorite.routeId);
    if (!route) return;
    state.transportType = routeTransportKey(route);
    const direction = route.directions.find((item) => item.code === favorite.directionCode) || defaultDirectionForRoute(route);
    const stop = selectableStopsForDirection(direction).find((item) => item.id === favorite.stopUid) || defaultStopForDirection(direction);
    if (!direction || !stop) return;

    state.missingRouteNumber = "";
    state.routeId = route.id;
    state.directionCode = direction.code;
    state.stopUid = stop.id;
    state.dayMode = favorite.dayMode || "today";
    // Saved favorites carry a deliberate day + departure; don't auto-advance them.
    state.dayModeExplicit = true;
    state.pendingFavorite = favorite;
    resetStopFilter();
    syncDayModeButtons();
    renderRouteSelectors();
    setView("schedule");
    queueScheduleScroll();
    await loadSchedule();
  }

  function filteredRoutes() {
    const routes = routesWithPlaceholders().filter((route) => state.routeDayFilter === "all" || !route.missing);
    const query = normalizeStopHint(state.routeFilter);
    if (!query) return routes;
    return routes.filter((route) => routeMatchesFilter(route, query));
  }

  function routeMatchesFilter(route, query) {
    const exactNumber = exactRouteNumberQuery(query);
    if (exactNumber) return routeNumberMatches(route.number, exactNumber);

    const base = normalizeStopHint(`${route.number} ${route.name}`);
    const directions = (route.directions || []).map((direction) => normalizeStopHint(`${direction.from} ${direction.to}`)).join(" ");
    const stops = (route.directions || [])
      .flatMap((direction) => selectableStopsForDirection(direction).map((stop) => normalizeStopHint(stop.name)))
      .join(" ");
    return `${base} ${directions} ${stops}`.includes(query);
  }

  function routeSearchMatchesForTransport(type, rawQuery) {
    const query = normalizeStopHint(rawQuery);
    if (!query) return [];
    return routesWithPlaceholders(type).filter((route) => routeMatchesFilter(route, query));
  }

  function createRoutesEmptyState(config) {
    if (!state.routeFilter) return create("div", "empty-state", config.empty);

    const query = state.routeFilter.trim();
    const box = create("div", "routes-empty-state empty-state");
    box.append(
      create("strong", "", "Ничего не найдено"),
      create("span", "", `В текущем разделе нет совпадений по запросу «${query}».`)
    );

    const suggestions = ["city", "suburban", "intercity"]
      .filter((type) => type !== state.transportType)
      .map((type) => ({
        type,
        config: TRANSPORT_MODES[type],
        count: routeSearchMatchesForTransport(type, query).length
      }))
      .filter((item) => item.count > 0);

    if (suggestions.length) {
      const actions = create("div", "routes-empty-actions");
      suggestions.forEach((item) => {
        const button = create("button", "routes-empty-switch", item.config.label);
        button.type = "button";
        button.addEventListener("click", () => {
          setTransportType(item.type, { preserveRouteSearch: true });
          els.routeSearch?.focus({ preventScroll: true });
        });
        actions.append(button);
      });
      box.append(actions);
    } else {
      box.append(create("small", "", "Попробуйте другой номер, конечную или остановку."));
    }

    return box;
  }

  function exactRouteNumberQuery(query) {
    const match = String(query || "").match(/^(?:маршрут\s*)?(?:№\s*)?(\d{1,3})$/i);
    return match ? String(Number(match[1])) : "";
  }

  function routeNumberMatches(routeNumber, queryNumber) {
    const value = normalize(routeNumber);
    return value === queryNumber || String(Number(value)) === queryNumber;
  }

  function routesWithPlaceholders(type = state.transportType) {
    const routes = routesForTransport(type);
    const byNumber = new Map(routes.map((route) => [Number(route.number), route]));
    const maxNumber = Math.max(33, ...routes.map((route) => Number(route.number) || 0));
    const result = [];
    const shouldShowCityPlaceholders = type === "city";

    for (let number = 1; number <= maxNumber; number += 1) {
      if (byNumber.has(number)) {
        result.push(byNumber.get(number));
      } else if (shouldShowCityPlaceholders && number <= 33) {
        result.push({
          id: `missing-${number}`,
          number: String(number),
          name: `Маршрут ${number}`,
          type: "Автобус",
          color: "#64748b",
          directions: [],
          missing: true
        });
      }
    }

    return result;
  }

  function renderMissingRoute(number) {
    clear(els.nextPanel);
    clear(els.timesPanel);
    clear(els.stopsPanel);
    clear(els.directionChips);
    els.directionChips.hidden = true;
    els.scheduleMeta.textContent = `Маршрут ${number}: расписание не загружено`;
    els.nextPanel.append(create("div", "empty-state", `Маршрут ${number} есть в городском списке, но в импортированных XML его расписания нет.`));
    els.timesPanel.append(create("div", "empty-state", "После добавления файла расписания маршрут появится здесь автоматически."));
    els.stopsPanel.append(create("div", "empty-state", "Остановки и времена пока недоступны."));
  }

  function renderNews() {
    if (!els.newsList || !state.data) return;
    const news = state.data.news || [];
    clear(els.newsList);
    renderNewsFilters(news);
    if (!news.length) {
      els.newsList.append(create("div", "empty-state", "Новостей пока нет."));
      updateNewsUnreadBadge();
      return;
    }

    const visibleNews = state.newsFilter === "all"
      ? news
      : news.filter((item) => newsCategory(item).key === state.newsFilter);

    if (!visibleNews.length) {
      els.newsList.append(create("div", "empty-state", "В этом разделе пока нет новостей."));
      updateNewsUnreadBadge();
      return;
    }

    const featured = visibleNews[0];
    els.newsList.append(newsFeatureCard(featured));

    const latest = visibleNews.slice(1);
    if (latest.length) {
      const section = create("section", "news-latest");
      const head = create("div", "news-latest-head");
      head.append(create("h3", "", "Последние новости"), create("span", "", newsMaterialLabel(latest.length)));
      const list = create("div", "news-latest-list");
      latest.forEach((item) => list.append(newsCompactCard(item)));
      section.append(head, list);
      els.newsList.append(section);
    }

    updateNewsUnreadBadge();
  }

  function renderNewsFilters(news) {
    if (!els.newsFilters) return;
    const available = new Set(["all", ...news.map((item) => newsCategory(item).key)]);
    els.newsFilters.querySelectorAll("[data-news-filter]").forEach((button) => {
      const filter = button.dataset.newsFilter || "all";
      button.classList.toggle("is-active", filter === state.newsFilter);
      button.disabled = filter !== "all" && !available.has(filter);
    });
  }

  function newsFeatureCard(item) {
    const category = newsCategory(item);
    const card = create("article", `news-feature-card news-tone-${category.key}`);
    card.dataset.newsId = item.id || "";
    const featureImageUrl = safeMediaUrl(item.imageUrl);
    if (featureImageUrl) {
      const image = create("img", "news-feature-image");
      image.src = featureImageUrl;
      image.alt = displayText(item.title) || "Новость";
      image.addEventListener("click", () => openImageViewer(featureImageUrl, displayText(item.title) || "Новость"));
      card.append(image);
    } else {
      card.classList.add("no-image");
    }

    const content = create("div", "news-feature-content");
    const badge = create("span", "news-type-badge", category.label);
    const date = create("span", "news-date", formatDate(item.publishedAt || item.date));
    const title = create("h3", "", displayText(item.title) || "Новость");
    const text = richTextNode(item.text, "news-text news-feature-text");
    const metrics = create("div", "news-metrics");
    metrics.append(newsViews(item.views), newsLikeButton(item));

    const action = create("button", "news-read-more", "Читать подробнее");
    action.type = "button";
    action.addEventListener("click", () => openNewsDetail(item));

    content.append(badge, date, title, text, metrics, action);
    card.append(content);
    return card;
  }

  function newsCompactCard(item) {
    const category = newsCategory(item);
    const card = create("article", `news-compact-card news-tone-${category.key}`);
    card.dataset.newsId = item.id || "";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Открыть новость: ${displayText(item.title) || "Новость"}`);
    card.addEventListener("click", (event) => {
      if (event.target.closest(".news-like-button")) return;
      openNewsDetail(item);
    });
    card.addEventListener("keydown", (event) => {
      if (event.target.closest(".news-like-button")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openNewsDetail(item);
    });

    const media = create("button", "news-compact-media");
    media.type = "button";
    media.setAttribute("aria-label", "Открыть новость");
    const compactImageUrl = safeMediaUrl(item.imageUrl);
    if (compactImageUrl) {
      const image = create("img");
      image.src = compactImageUrl;
      image.alt = displayText(item.title) || "Новость";
      media.append(image);
      media.addEventListener("click", (event) => {
        event.stopPropagation();
        openNewsDetail(item);
      });
    } else {
      media.append(create("span", "", category.icon));
    }

    const body = create("div", "news-compact-body");
    const meta = create("div", "news-compact-meta");
    meta.append(create("span", "news-type-badge", category.label), create("span", "news-date", formatDate(item.publishedAt || item.date)));
    body.append(meta, create("h3", "", displayText(item.title) || "Новость"));
    const metrics = create("div", "news-metrics");
    metrics.append(newsViews(item.views), newsLikeButton(item));
    body.append(metrics);

    const arrow = create("span", "news-card-arrow", "›");
    card.append(media, body, arrow);
    return card;
  }

  function newsCategory(item) {
    const type = String(item?.type || "info").toLowerCase();
    if (["promo", "promotion", "sale", "action", "акция"].includes(type)) return { key: "promo", label: "Акция", icon: "%" };
    if (["event", "events", "событие"].includes(type)) return { key: "event", label: "Событие", icon: "◎" };
    if (["change", "changes", "update", "изменение"].includes(type)) return { key: "change", label: "Изменение", icon: "↔" };
    return { key: "announcement", label: type === "warning" ? "Важно" : "Объявление", icon: "!" };
  }

  function readTime(text) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.ceil(words / 160));
    const node = create("span", "news-read-time", `${minutes} мин чтения`);
    return node;
  }

  function newsMaterialLabel(count) {
    const value = Number(count || 0);
    const mod10 = value % 10;
    const mod100 = value % 100;
    if (mod10 === 1 && mod100 !== 11) return `${formatNumber(value)} материал`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${formatNumber(value)} материала`;
    return `${formatNumber(value)} материалов`;
  }

  function newsViews(value) {
    const views = create("span", "news-views");
    const eye = create("span", "news-eye");
    eye.setAttribute("aria-hidden", "true");
    views.append(eye, create("span", "", formatNumber(Number(value || 0))));
    views.title = "Просмотры";
    return views;
  }

  function newsLikeButton(item) {
    const liked = state.likedNews.has(item.id);
    const pending = state.newsLikePending.has(item.id);
    const button = create("button", `news-like-button ${liked ? "is-liked" : ""}`);
    button.type = "button";
    button.disabled = pending;
    button.title = liked ? "Вам понравилось" : "Поставить лайк";
    button.setAttribute("aria-label", liked ? "Убрать лайк" : "Поставить лайк");
    button.append(newsHeartIcon(liked), create("span", "", formatNumber(newsLikeCount(item))));
    button.addEventListener("click", () => toggleNewsLike(item, button));
    return button;
  }

  function newsHeartIcon(liked) {
    const icon = create("span", `news-heart ${liked ? "is-liked" : ""}`);
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 20.4s-6.9-4.3-9.4-8.2C.9 9.5 1.4 6.1 3.8 4.5c2.1-1.4 4.8-.8 6.3 1.1L12 8l1.9-2.4c1.5-1.9 4.2-2.5 6.3-1.1 2.4 1.6 2.9 5 .2 7.7C18.9 16.1 12 20.4 12 20.4Z"></path></svg>';
    return icon;
  }

  function newsLikeCount(item) {
    const serverLikes = Number(item.likes || 0);
    return state.likedNews.has(item.id) ? Math.max(serverLikes, 1) : serverLikes;
  }

  async function toggleNewsLike(item, button) {
    if (!item?.id || state.newsLikePending.has(item.id) || button.disabled) return;
    const shouldLike = !state.likedNews.has(item.id);
    const previousLikes = Number(item.likes || 0);
    state.newsLikePending.add(item.id);

    if (shouldLike) state.likedNews.add(item.id);
    else state.likedNews.delete(item.id);
    item.likes = Math.max(0, previousLikes + (shouldLike ? 1 : -1));
    writeLikedNews(state.likedNews);
    renderNews();
    refreshOpenNewsDetail();

    try {
      const response = await fetch(`/api/news/${encodeURIComponent(item.id)}/like`, {
        method: "POST",
        headers: { "content-type": "application/json", ...telegramHeaders() },
        body: JSON.stringify({ liked: shouldLike, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Не удалось сохранить лайк.");
      item.likes = Number(data.item?.likes ?? item.likes ?? 0);
      const current = state.data.news.find((newsItem) => newsItem.id === item.id);
      if (current) current.likes = item.likes;
      delete state.pendingNewsLikeSync[item.id];
      writePendingNewsLikeSync(state.pendingNewsLikeSync);
      tg?.HapticFeedback?.impactOccurred?.("light");
    } catch {
      item.likes = Math.max(0, previousLikes + (shouldLike ? 1 : -1));
      state.pendingNewsLikeSync[item.id] = shouldLike;
      writePendingNewsLikeSync(state.pendingNewsLikeSync);
      writeLikedNews(state.likedNews);
    } finally {
      state.newsLikePending.delete(item.id);
    }

    renderNews();
    refreshOpenNewsDetail();
  }

  function syncPendingNewsLikes() {
    const entries = Object.entries(state.pendingNewsLikeSync || {});
    if (!entries.length) return;
    entries.forEach(async ([id, liked]) => {
      try {
        const response = await fetch(`/api/news/${encodeURIComponent(id)}/like`, {
          method: "POST",
          headers: { "content-type": "application/json", ...telegramHeaders() },
          body: JSON.stringify({ liked, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error("Like sync failed");
        const current = state.data?.news?.find((item) => item.id === id);
        if (current) current.likes = Number(data.item?.likes ?? current.likes ?? 0);
        delete state.pendingNewsLikeSync[id];
        writePendingNewsLikeSync(state.pendingNewsLikeSync);
        renderNews();
        refreshOpenNewsDetail();
      } catch {
        // The next app start will try again.
      }
    });
  }

  function updateNewsUnreadBadge() {
    if (!els.newsUnreadDot) return;
    const hasUnread = (state.data?.news || []).some((item) => !state.viewedNews.has(newsViewKey(item)));
    els.newsUnreadDot.hidden = !hasUnread;
  }

  function markAllNewsViewed() {
    const news = state.data?.news || [];
    const unseen = news.filter((item) => !state.viewedNews.has(newsViewKey(item)));
    if (!unseen.length) {
      updateNewsUnreadBadge();
      return;
    }

    unseen.forEach((item) => {
      state.viewedNews.add(newsViewKey(item));
      item.views = Number(item.views || 0) + 1;
      fetch(`/api/news/${encodeURIComponent(item.id)}/view`, { method: "POST", headers: telegramHeaders() }).catch(() => {});
    });
    writeViewedNews(state.viewedNews);
    renderNews();
  }

  function newsViewKey(item) {
    return [item.id, item.updatedAt || item.publishedAt || item.createdAt || ""].filter(Boolean).join(":");
  }

  function openNewsDetail(item) {
    if (!item) return;
    markNewsViewed(item);
    state.openNewsId = item.id || "";
    renderNewsDetail(item);
    els.newsDetailViewer.hidden = false;
    document.body.classList.add("is-news-detail-open");
    tg?.HapticFeedback?.impactOccurred?.("light");
  }

  function renderNewsDetail(item) {
    if (!els.newsDetailContent) return;
    const category = newsCategory(item);
    clear(els.newsDetailContent);

    const article = create("div", `news-detail-article news-tone-${category.key}`);
    const detailImageUrl = safeMediaUrl(item.imageUrl);
    if (detailImageUrl) {
      const media = create("button", "news-detail-media");
      media.type = "button";
      media.setAttribute("aria-label", "Открыть картинку новости");
      const image = create("img");
      image.src = detailImageUrl;
      image.alt = displayText(item.title) || "Новость";
      media.append(image);
      media.addEventListener("click", () => openImageViewer(detailImageUrl, displayText(item.title) || "Новость"));
      article.append(media);
    }

    const body = create("div", "news-detail-body");
    const meta = create("div", "news-detail-meta");
    meta.append(create("span", "news-type-badge", category.label));
    const date = formatDate(item.publishedAt || item.date);
    if (date) meta.append(create("span", "news-date", date));

    const title = create("h2", "", displayText(item.title) || "Новость");
    const text = richTextNode(item.text, "news-detail-text");
    const metrics = create("div", "news-metrics news-detail-metrics");
    metrics.append(newsViews(item.views), newsLikeButton(item));

    body.append(meta, title, text, metrics);
    article.append(body);
    els.newsDetailContent.append(article);
  }

  function refreshOpenNewsDetail() {
    if (!state.openNewsId || !els.newsDetailViewer || els.newsDetailViewer.hidden) return;
    const item = state.data?.news?.find((newsItem) => newsItem.id === state.openNewsId);
    if (item) renderNewsDetail(item);
  }

  function closeNewsDetail() {
    if (!els.newsDetailViewer || els.newsDetailViewer.hidden) return;
    els.newsDetailViewer.hidden = true;
    state.openNewsId = "";
    clear(els.newsDetailContent);
    document.body.classList.remove("is-news-detail-open");
  }

  function markNewsViewed(item) {
    if (!item?.id) return;
    const key = newsViewKey(item);
    if (state.viewedNews.has(key)) return;
    state.viewedNews.add(key);
    item.views = Number(item.views || 0) + 1;
    writeViewedNews(state.viewedNews);
    updateNewsUnreadBadge();
    fetch(`/api/news/${encodeURIComponent(item.id)}/view`, { method: "POST", headers: telegramHeaders() }).catch(() => {});
  }

  let imageViewerReturnFocus = null;

  function openImageViewer(src, alt) {
    const safeSrc = safeMediaUrl(src);
    if (!safeSrc) return;
    els.imageViewerImage.src = safeSrc;
    els.imageViewerImage.alt = alt || "Картинка новости";
    els.imageViewer.hidden = false;
    document.body.classList.add("is-image-viewer-open");
    // Screen-reader/keyboard support: announce as a modal and move focus inside.
    imageViewerReturnFocus = document.activeElement;
    els.imageViewer.setAttribute("role", "dialog");
    els.imageViewer.setAttribute("aria-modal", "true");
    els.imageViewerClose?.focus?.();
  }

  function closeImageViewer() {
    if (!els.imageViewer || els.imageViewer.hidden) return;
    els.imageViewer.hidden = true;
    els.imageViewerImage.removeAttribute("src");
    document.body.classList.remove("is-image-viewer-open");
    if (imageViewerReturnFocus?.focus) imageViewerReturnFocus.focus();
    imageViewerReturnFocus = null;
  }

  async function submitAppeal(event) {
    event.preventDefault();
    setStatus("Новое обращение создаётся через Telegram-бота.", "");
    openFeedbackBot();
  }

  async function appealFormPayload(form) {
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    delete data.attachmentFiles;
    const attachments = [];
    for (const item of state.appealFiles.slice(0, MAX_APPEAL_ATTACHMENTS)) {
      setStatus("Подготавливаем фото к отправке...", "");
      attachments.push(await fileToAttachment(await prepareAppealImageFile(item.file)));
    }
    data.attachments = attachments.slice(0, 4);
    return data;
  }

  function clientChatTextInput() {
    return els.clientChatForm?.elements.text || null;
  }

  function selectedAppealCategory() {
    return els.appealForm?.querySelector('input[name="category"]:checked')?.value || "Обращение";
  }

  function syncAppealFormText(value) {
    if (els.appealForm?.elements.text) {
      els.appealForm.elements.text.value = value || "";
    }
    updateAppealProgress();
  }

  function setClientChatDraftText(value, { replace = false } = {}) {
    const input = clientChatTextInput();
    if (!input) return;
    if (replace || !input.value.trim()) {
      input.value = value || "";
      syncAppealFormText(input.value);
      saveAppealDraft();
    }
  }

  function handleAppealFilesChanged(event) {
    const selected = [...(event.currentTarget.files || [])];
    const incoming = selected.filter((file) => file.type.startsWith("image/"));
    const slots = MAX_APPEAL_ATTACHMENTS - totalAppealAttachments();
    incoming.slice(0, Math.max(0, slots)).forEach((file) => {
      state.appealFiles.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
        file,
        url: URL.createObjectURL(file)
      });
    });
    event.currentTarget.value = "";
    updateAppealFileState();
    if (incoming.length > slots) {
      setStatus(`Можно прикрепить не больше ${MAX_APPEAL_ATTACHMENTS} файлов.`, "error");
    } else if (selected.length !== incoming.length) {
      setStatus("В обращении можно прикреплять только изображения.", "error");
    }
  }

  function removeAppealFile(fileId) {
    const item = state.appealFiles.find((file) => file.id === fileId);
    revokeObjectUrl(item?.url);
    state.appealFiles = state.appealFiles.filter((file) => file.id !== fileId);
    updateAppealFileState();
  }

  function clearAppealFiles() {
    state.appealFiles.forEach((item) => revokeObjectUrl(item.url));
    state.appealFiles = [];
    if (els.appealForm?.elements.attachmentFiles) els.appealForm.elements.attachmentFiles.value = "";
    updateAppealFileState();
  }

  function handleClientChatFilesChanged(event) {
    const selected = [...(event.currentTarget.files || [])];
    const incoming = selected.filter((file) => file.type.startsWith("image/"));
    const slots = MAX_APPEAL_ATTACHMENTS - state.chatFiles.length;
    incoming.slice(0, Math.max(0, slots)).forEach((file) => {
      state.chatFiles.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
        file,
        url: URL.createObjectURL(file)
      });
    });
    event.currentTarget.value = "";
    renderClientChatFiles();
    if (incoming.length > slots) {
      setStatus(`В чат можно прикрепить не больше ${MAX_APPEAL_ATTACHMENTS} фото.`, "error");
    } else if (selected.length !== incoming.length) {
      setStatus("В чат можно прикреплять только изображения.", "error");
    }
  }

  function removeClientChatFile(fileId) {
    const item = state.chatFiles.find((file) => file.id === fileId);
    revokeObjectUrl(item?.url);
    state.chatFiles = state.chatFiles.filter((file) => file.id !== fileId);
    renderClientChatFiles();
  }

  function clearClientChatFiles() {
    state.chatFiles.forEach((item) => revokeObjectUrl(item.url));
    state.chatFiles = [];
    if (els.clientChatAttachmentInput) els.clientChatAttachmentInput.value = "";
    renderClientChatFiles();
  }

  function renderClientChatFiles() {
    if (!els.clientChatAttachmentPreview) return;
    clear(els.clientChatAttachmentPreview);
    const hasFiles = state.chatFiles.length > 0;
    els.clientChatAttachmentPreview.hidden = !hasFiles;
    if (els.clientChatAttachCount) {
      els.clientChatAttachCount.hidden = !hasFiles;
      els.clientChatAttachCount.textContent = hasFiles ? `${state.chatFiles.length}/${MAX_APPEAL_ATTACHMENTS} фото` : "";
    }
    state.chatFiles.forEach((item) => {
      const card = create("span", "chat-attachment-chip");
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = item.file.name || "Фото";
      image.loading = "lazy";
      const remove = create("button", "chat-attachment-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Убрать ${item.file.name || "фото"}`);
      remove.addEventListener("click", () => removeClientChatFile(item.id));
      card.append(image, remove);
      els.clientChatAttachmentPreview.append(card);
    });
  }

  async function clientChatAttachmentPayload() {
    const attachments = [];
    for (const item of state.chatFiles.slice(0, MAX_APPEAL_ATTACHMENTS)) {
      setStatus("Подготавливаем фото к отправке...", "");
      attachments.push(await fileToAttachment(await prepareAppealImageFile(item.file)));
    }
    return attachments;
  }

  function restoreAppealDraft() {
    if (!els.appealForm) return;
    const draft = readAppealDraft();
    if (!draft) return;
    const textInput = els.appealForm.elements.text;
    if (draft.text && textInput && !textInput.value) textInput.value = draft.text;
    const chatInput = clientChatTextInput();
    if (draft.text && chatInput && !chatInput.value) chatInput.value = draft.text;
    if (draft.category) setAppealCategory(draft.category);
    updateAppealProgress();
  }

  function saveAppealDraft() {
    if (!els.appealForm) return;
    const data = new FormData(els.appealForm);
    const chatText = clientChatTextInput()?.value;
    const draft = {
      category: String(data.get("category") || "Обращение"),
      text: String(chatText !== undefined ? chatText : data.get("text") || "")
    };
    try {
      if (draft.text.trim() || draft.category !== "Обращение") {
        safeStorage.setItem(APPEAL_DRAFT_KEY, JSON.stringify(draft));
      } else {
        safeStorage.removeItem(APPEAL_DRAFT_KEY);
      }
    } catch {
      // Draft persistence is only a convenience; sending must keep working without it.
    }
  }

  function clearAppealDraft() {
    try {
      safeStorage.removeItem(APPEAL_DRAFT_KEY);
    } catch {
      // Ignore storage errors.
    }
  }

  function updateAppealFileState() {
    const files = state.appealFiles;
    if (els.appealFileCount) els.appealFileCount.textContent = `${totalAppealAttachments()}/${MAX_APPEAL_ATTACHMENTS} вложения`;
    if (els.appealFileName) {
      els.appealFileName.textContent = files.length
        ? files.map((item) => item.file.name).join(", ")
        : "Файл не выбран";
    }
    renderAppealFilePreview();
    updateAppealProgress();
  }

  function renderAppealFilePreview() {
    if (!els.appealPreviewList) return;
    clear(els.appealPreviewList);
    els.appealPreviewList.hidden = state.appealFiles.length === 0;
    state.appealFiles.forEach((item) => {
      const file = item.file;
      const card = create("article", `appeal-preview-card ${file.type.startsWith("image/") ? "is-image" : "is-file"}`);
      if (file.type.startsWith("image/")) {
        const image = document.createElement("img");
        image.src = item.url;
        image.alt = file.name;
        card.append(image);
      } else {
        card.append(create("span", "appeal-preview-file-icon", file.type.startsWith("audio/") ? "🎧" : "📎"));
      }
      const caption = create("span", "appeal-preview-name", file.name);
      const remove = create("button", "appeal-remove-button", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Удалить ${file.name}`);
      remove.addEventListener("click", () => removeAppealFile(item.id));
      card.append(caption, remove);
      els.appealPreviewList.append(card);
    });
  }

  function totalAppealAttachments() {
    return state.appealFiles.length;
  }

  function updateAppealProgress() {
    if (!els.appealForm) return;
    updateAppealPlaceholder();
    const text = els.appealForm.elements.text?.value || "";
    const textLength = text.length;
    const fileCount = state.appealFiles.length;
    if (els.appealTextCounter) els.appealTextCounter.textContent = `${textLength}/1000`;
    els.appealForm.querySelectorAll(".appeal-topic-tab").forEach((tab) => {
      tab.classList.toggle("is-selected", Boolean(tab.querySelector('input[name="category"]')?.checked));
    });

    const stepState = {
      topic: true,
      text: text.trim().length > 0,
      file: fileCount > 0,
      send: text.trim().length > 0 || fileCount > 0
    };
    document.querySelectorAll("[data-appeal-step]").forEach((step) => {
      const key = step.dataset.appealStep;
      step.classList.toggle("is-complete", Boolean(stepState[key]));
      step.classList.toggle("is-active", key === "topic" || (key === "send" ? stepState.send : stepState[key]));
    });
  }

  function updateAppealPlaceholder() {
    if (!els.appealForm?.elements.text) return;
    const category = selectedAppealCategory();
    const placeholder = APPEAL_PLACEHOLDERS[category] || APPEAL_PLACEHOLDERS["Обращение"];
    els.appealForm.elements.text.placeholder = placeholder;
    const chatInput = clientChatTextInput();
    if (chatInput) chatInput.placeholder = category === "Обращение" ? "Сообщение администрации" : placeholder;
  }

  function feedbackBotUrl() {
    return state.data?.feedback?.botStartUrl || "";
  }

  function openFeedbackBot() {
    const url = feedbackBotUrl();
    if (url && tg?.openTelegramLink) {
      tg.openTelegramLink(url);
      return;
    }
    // Санитизируем перед location.href: только http/https, чтобы конфиг
    // не мог протащить javascript:-URL в обычном браузере (вне Telegram).
    const safeUrl = safeExternalUrl(url);
    if (safeUrl) {
      window.location.href = safeUrl;
      return;
    }
    setStatus("Откройте Telegram-бота и нажмите «Написать обращение».", "error");
  }

  async function loadUserAppeals() {
    if (!tg?.initData) {
      state.userAppeals = [];
      renderAppealInbox({ requiresTelegram: true });
      return;
    }

    const response = await fetch("/api/appeals", { headers: telegramHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "Не удалось загрузить обращения.");
    state.userAppeals = data.appeals || [];
    if (!state.activeAppeal?.id && state.userAppeals.length) {
      const openAppeal = state.userAppeals.find((item) => item.status !== "closed") || state.userAppeals[0];
      state.activeAppeal = { id: openAppeal.id, clientToken: "", status: openAppeal.status || "new" };
      safeStorage.setItem("activeAppeal", JSON.stringify(state.activeAppeal));
    }
    renderAppealInbox(data);
    if (state.activeAppeal?.id) {
      loadClientMessages().catch(() => {});
    }
  }

  function appealPreviewText(appeal, limit = 84) {
    const text = String(appeal?.text || "").replace(/\s+/g, " ").trim();
    if (!text) return "Вложение без текста";
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1).trimEnd()}…`;
  }

  function renderAppealInbox(options = {}) {
    if (!els.appealInboxList) return;
    clear(els.appealInboxList);
    if (options.requiresTelegram) {
      els.appealInboxList.append(create("p", "appeal-note", "История доступна при открытии через Telegram-бота."));
      return;
    }
    if (!state.userAppeals.length) {
      els.appealInboxList.append(create("p", "appeal-note", "Пока обращений нет. Новое обращение создаётся в Telegram-боте."));
      return;
    }

    const title = create("h3", "appeal-inbox-title", "Мои обращения");
    const list = create("div", "appeal-inbox-list");
    state.userAppeals.forEach((appeal) => {
      const button = create("button", `appeal-inbox-card ${state.activeAppeal?.id === appeal.id ? "is-active" : ""}`);
      button.type = "button";
      button.append(
        create("strong", "", `#${appeal.id}`),
        create("span", "", appealPreviewText(appeal)),
        create("small", "", `${appealStatusLabel(appeal.status)} · ${formatDateTime(appeal.updatedAt || appeal.createdAt)}`)
      );
      button.addEventListener("click", () => selectClientAppeal(appeal));
      list.append(button);
    });
    els.appealInboxList.append(title, list);
  }

  function selectClientAppeal(appeal) {
    state.activeAppeal = { id: appeal.id, clientToken: "", status: appeal.status || "new" };
    safeStorage.setItem("activeAppeal", JSON.stringify(state.activeAppeal));
    renderAppealInbox();
    renderClientChat();
    loadClientMessages();
  }

  function appealRoleLabel(role) {
    return {
      appeals_manager: "Обращения",
      moderator: "Модерация",
      dispatcher: "Диспетчер",
      ads_manager: "Реклама",
      sto_manager: "СТО / услуги"
    }[role] || role || "";
  }

  function appealStatusLabel(status) {
    return {
      new: "Открыто",
      in_progress: "В работе",
      closed: "Закрыто"
    }[status] || status || "Статус";
  }

  function renderClientChat() {
    if (!state.activeAppeal?.id || !state.activeAppeal?.clientToken) {
      els.clientChat.hidden = false;
      const activeFromInbox = state.activeAppeal?.id ? state.userAppeals.find((item) => item.id === state.activeAppeal.id) : null;
      const chatStatus = activeFromInbox?.status || state.activeAppeal?.status || "new";
      els.clientChatMeta.textContent = activeFromInbox
        ? `Обращение #${activeFromInbox.id}`
        : "Новое обращение создаётся в Telegram-боте.";
      els.clientChatStatus.textContent = activeFromInbox ? appealStatusLabel(chatStatus) : "Бот";
      els.clientChatStatus.dataset.status = chatStatus;
      els.clientChatForm.hidden = true;
      renderClientChatFiles();
      if (!state.activeAppeal?.id) renderClientMessages([]);
      if (state.activeAppeal?.id && state.activeAppeal.status !== "closed" && tg?.initData) {
        startClientChatPolling();
      } else {
        stopClientChatPolling();
      }
      return;
    }

    els.clientChat.hidden = false;
    els.clientChatMeta.textContent = `Обращение #${state.activeAppeal.id}`;
    els.clientChatStatus.textContent = state.activeAppeal.status === "closed" ? "Закрыт" : "Открыт";
    els.clientChatStatus.dataset.status = state.activeAppeal.status || "new";
    els.clientChatForm.hidden = state.activeAppeal.status === "closed";
    renderClientChatFiles();
    if (state.activeAppeal.status === "closed") stopClientChatPolling();
    startClientChatPolling();
  }

  async function loadClientMessages() {
    if (!state.activeAppeal?.id) return;

    const headers = { ...telegramHeaders() };
    if (state.activeAppeal.clientToken) headers["x-appeal-token"] = state.activeAppeal.clientToken;
    const response = await fetch(`/api/appeals/${encodeURIComponent(state.activeAppeal.id)}/messages`, {
      headers
    });
    if (!response.ok) return;
    const data = await response.json();
    state.activeAppeal.status = data.appeal?.status || state.activeAppeal.status;
    if (data.appeal?.id) {
      state.userAppeals = state.userAppeals.map((item) => (
        item.id === data.appeal.id
          ? { ...item, status: data.appeal.status || item.status, updatedAt: data.appeal.updatedAt || item.updatedAt }
          : item
      ));
      renderAppealInbox();
    }
    safeStorage.setItem("activeAppeal", JSON.stringify(state.activeAppeal));
    renderClientMessages(data.messages || []);
    renderClientChat();
  }

  function renderClientMessages(messages) {
    clear(els.clientChatThread);
    if (!messages.length) {
      const text = state.activeAppeal?.id
        ? "Сообщений пока нет."
        : "Напишите сообщение администрации. После отправки здесь появится переписка.";
      els.clientChatThread.append(create("div", "empty-state", text));
      return;
    }

    messages.forEach((message) => {
      const item = create("article", `chat-message ${message.senderType === "admin" ? "is-admin" : "is-client"}`);
      if (message.text) item.append(create("p", "", message.text));
      appendAttachments(item, message.attachments || []);
      item.append(create("span", "", formatChatTime(message.createdAt)));
      els.clientChatThread.append(item);
    });
    els.clientChatThread.scrollTop = els.clientChatThread.scrollHeight;
  }

  async function sendClientChatMessage(event) {
    event.preventDefault();
    const input = els.clientChatForm.elements.text;
    const button = els.clientChatForm.querySelector("button[type='submit']");
    const text = input.value.trim();
    if (!text && state.chatFiles.length === 0) return;

    input.disabled = true;
    if (button) button.disabled = true;
    if (els.clientChatAttachButton) els.clientChatAttachButton.disabled = true;
    try {
      const attachments = await clientChatAttachmentPayload();
      if (!state.activeAppeal?.id) {
        setStatus("Новое обращение создаётся в Telegram-боте.", "error");
        openFeedbackBot();
        return;
      }
      const headers = { "content-type": "application/json", ...telegramHeaders() };
      if (state.activeAppeal.clientToken) headers["x-appeal-token"] = state.activeAppeal.clientToken;
      const response = await fetch(`/api/appeals/${encodeURIComponent(state.activeAppeal.id)}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, attachments, clientToken: state.activeAppeal.clientToken || "" })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Не удалось отправить сообщение.");
      input.value = "";
      syncAppealFormText("");
      clearClientChatFiles();
      clearAppealDraft();
      await loadClientMessages();
      setStatus("Сообщение отправлено.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      input.disabled = false;
      if (button) button.disabled = false;
      if (els.clientChatAttachButton) els.clientChatAttachButton.disabled = false;
      input.focus();
    }
  }

  async function createAppealFromChat(text, attachments) {
    setStatus("Новое обращение создаётся через Telegram-бота.", "");
    openFeedbackBot();
  }

  function startClientChatPolling() {
    if (state.chatTimer || state.activeAppeal?.status === "closed") return;
    // The Mini App appeal surface is removed at boot (appeals live in the bot);
    // polling against a detached chat panel is pure network/battery waste.
    if (!els.clientChat || !document.body.contains(els.clientChat)) return;
    state.chatTimer = setInterval(loadClientMessages, 4000);
  }

  function stopClientChatPolling() {
    if (!state.chatTimer) return;
    clearInterval(state.chatTimer);
    state.chatTimer = null;
  }

  function selectedTimes(schedule = state.schedule, dayMode = state.dayMode) {
    const now = minutesFromDate(new Date());
    const map = new Map();
    (schedule.groups || [])
      .filter((group) => maskMatchesMode(group.dayMask, dayMode))
      .forEach((group) => {
        const displayDayMask = dayMaskForCurrentMode(group.dayMask, dayMode);
        (group.times || []).forEach((item) => {
          const minutes = relativeDepartureMinutes(item, now);
          const key = `${item.time}:${item.tripCode || ""}:${item.variantCode || ""}:${item.destinationStop || ""}:${item.tripStartTime || ""}:${item.tripEndTime || ""}:${item.viaLabel || ""}:${item.notes || ""}`;
          const existing = map.get(key);
          if (existing) {
            existing.displayDayMask = combineDayMasks(existing.displayDayMask || existing.dayMask, displayDayMask);
            existing.dayName = dayLabelFromMask(existing.displayDayMask) || existing.dayName;
            existing.sourceDayMasks = [...new Set([...(existing.sourceDayMasks || []), group.dayMask || ""])];
            existing.minutes = relativeDepartureMinutes(existing, now);
            existing.diff = nextDiff(existing.minutes, now);
            return;
          }
          map.set(key, {
            ...item,
            dayMask: group.dayMask || "",
            displayDayMask,
            sourceDayMasks: [group.dayMask || ""],
            dayName: dayLabelFromMask(displayDayMask) || group?.dayName || "",
            minutes,
            diff: nextDiff(minutes, now)
          });
        });
      });
    return [...map.values()].sort((a, b) => a.minutes - b.minutes);
  }

  function normalizeDayMaskForUi(mask) {
    return String(mask || "")
      .padEnd(7, "0")
      .slice(0, 7)
      .replace(/[^1]/g, "0");
  }

  function dayMaskForCurrentMode(mask, dayMode = state.dayMode) {
    const value = normalizeDayMaskForUi(mask);
    if (dayMode === "weekday") return `${value.slice(0, 5)}00`;
    if (dayMode === "weekend") return `00000${value.slice(5)}`;
    return value;
  }

  function relativeDepartureMinutes(item, now = minutesFromDate(new Date())) {
    const rawMinutes = safeMinutesFromTime(item?.time);
    if (!Number.isFinite(rawMinutes)) return NaN;

    const start = Number(item?.tripStartMinutes);
    const end = Number(item?.tripEndMinutes);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < 1440) return rawMinutes;

    const carriedEnd = end - 1440;
    const isAfterMidnightStop = rawMinutes < start && rawMinutes <= carriedEnd;
    if (!isAfterMidnightStop) return rawMinutes;

    return now <= carriedEnd ? rawMinutes : rawMinutes + 1440;
  }

  function combineDayMasks(left, right) {
    const a = normalizeDayMaskForUi(left);
    const b = normalizeDayMaskForUi(right);
    return Array.from({ length: 7 }, (_, index) => (a[index] === "1" || b[index] === "1" ? "1" : "0")).join("");
  }

  function dayLabelFromMask(mask) {
    const value = normalizeDayMaskForUi(mask);
    if (value === "1111111") return "Пн-Вс";
    if (value === "1111100") return "Пн-Пт";
    if (value === "0000011") return "Сб-Вс";

    const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    const parts = [];
    for (let index = 0; index < 7; index += 1) {
      if (value[index] !== "1") continue;
      let end = index;
      while (end + 1 < 7 && value[end + 1] === "1") end += 1;
      parts.push(index === end ? labels[index] : `${labels[index]}-${labels[end]}`);
      index = end;
    }
    return parts.join(", ");
  }

  function departureDayLabel(item) {
    if (!item || state.dayMode === "today") return "";
    const mask = normalizeDayMaskForUi(item.displayDayMask || item.dayMask);
    if (state.dayMode === "weekday" && mask === "1111100") return "";
    if (state.dayMode === "weekend" && mask === "0000011") return "";
    return dayLabelFromMask(mask);
  }

  function upcomingTimes(times, dayMode = state.dayMode) {
    if (dayMode !== "today") return times.slice(0, 3);
    const now = minutesFromDate(new Date());
    return [...times]
      .map((item) => ({ ...item, minutes: relativeDepartureMinutes(item, now) }))
      .filter((item) => item.minutes >= now)
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, 3);
  }

  function visibleTimesForStrip(times, activeDeparture) {
    if (!Array.isArray(times) || times.length < 2) return times || [];
    if (state.dayMode !== "today") return times;
    const focusDeparture = activeDeparture || getCurrentDeparture(times, "today") || getNextDeparture(times, "today");
    const activeKey = selectedDepartureKey(focusDeparture);
    const activeIndex = activeKey ? times.findIndex((item) => selectedDepartureKey(item) === activeKey) : -1;
    if (activeIndex <= 0) return times;
    return times.slice(activeIndex).concat(times.slice(0, activeIndex));
  }

  function applyPendingFavorite() {
    if (!state.pendingFavorite) return;
    const favorite = state.pendingFavorite;
    const match = selectedTimes().find((item) => {
      const sameTime = item.time === favorite.time;
      const sameTrip = !favorite.tripCode || item.tripCode === favorite.tripCode;
      const sameVariant = !favorite.variantCode || item.variantCode === favorite.variantCode;
      const sameDay = !favorite.dayMask || item.dayMask === favorite.dayMask || (item.sourceDayMasks || []).includes(favorite.dayMask);
      return sameTime && sameTrip && sameVariant && sameDay;
    }) || selectedTimes().find((item) => item.time === favorite.time);
    state.selectedDeparture = match || null;
    state.selectedDepartureMode = match ? "manual" : "auto";
    state.pendingFavorite = null;
  }

  function remainingTimesCount(times) {
    if (state.dayMode !== "today") return times.length;
    const now = minutesFromDate(new Date());
    return times.filter((item) => relativeDepartureMinutes(item, now) >= now).length;
  }

  function openAlarmBottomSheet({ favorite, departure, route, direction, stop, alarm }) {
    if (!departure || !route || !direction || !stop) return;
    closeFavoriteMenus();
    closeAlarmBottomSheet({ immediate: true });
    const alarmFavorite = favorite || buildFavorite(route, direction, stop, departure);

    const quickValues = [5, 10, 15, 30, 60, 120];
    const requestedMode = alarm?.repeatMode || defaultAlarmRepeatMode(alarmFavorite, departure);
    const defaultMode = alarmModeAllowedForDeparture(requestedMode, departure)
      ? requestedMode
      : defaultAlarmRepeatModeForDeparture(departure) || "once";
    const sheetState = {
      favorite: alarmFavorite,
      departure,
      route,
      direction,
      stop,
      selectedLead: normalizeReminderLead(alarm?.remindMinutes) || 10,
      repeatMode: defaultMode,
      repeatDays: Array.isArray(alarm?.repeatDays)
        ? normalizedAlarmDays(defaultMode, alarm.repeatDays, departure)
        : defaultAlarmDays(defaultMode, departure)
    };

    const root = create("div", "alarm-sheet");
    root.hidden = true;
    const backdrop = create("button", "alarm-sheet-backdrop");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Закрыть будильник");
    const panel = create("section", "alarm-sheet-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", `Будильник для ${stop.name}`);

    const handle = create("span", "alarm-sheet-handle");
    const header = create("div", "alarm-sheet-head");
    const title = create("div");
    title.append(
      create("strong", "", `Будильник для ${stop.name}`),
      create("span", "", `Рейс ${departure.time} · Маршрут №${route.number}`)
    );
    const close = favoriteActionButton("close", "Закрыть", "alarm-sheet-close");
    header.append(title, close);

    const modes = create("div", "alarm-mode-tabs");
    modes.setAttribute("role", "radiogroup");
    modes.setAttribute("aria-label", "Режим будильника");
    [
      { value: "once", label: "Один раз" },
      { value: "weekdays", label: "Будни" },
      { value: "weekends", label: "Выходные" },
      { value: "custom", label: "Свои дни" }
    ].forEach((mode) => {
      const button = create("button", "", mode.label);
      button.type = "button";
      // aria-checked (set in updateAlarmSheetControls) is only valid on a radio role.
      button.setAttribute("role", "radio");
      button.dataset.alarmMode = mode.value;
      button.addEventListener("click", () => {
        if (!alarmModeAllowedForDeparture(mode.value, departure)) return;
        const previousMode = sheetState.repeatMode;
        sheetState.repeatMode = mode.value;
        if (mode.value === "custom" && previousMode !== "custom") {
          sheetState.repeatDays = alarm?.repeatMode === "custom"
            ? normalizedAlarmDays("custom", sheetState.repeatDays, departure)
            : [];
        } else if (mode.value !== "custom") {
          sheetState.repeatDays = defaultAlarmDays(mode.value, departure);
        }
        updateAlarmSheetControls();
      });
      modes.append(button);
    });

    const daysWrap = create("div", "custom-days-selector");
    daysWrap.append(create("span", "alarm-section-label", "Выберите дни недели"));
    const daysGrid = create("div", "custom-days-grid");
    [
      { value: 1, label: "Пн" },
      { value: 2, label: "Вт" },
      { value: 3, label: "Ср" },
      { value: 4, label: "Чт" },
      { value: 5, label: "Пт" },
      { value: 6, label: "Сб" },
      { value: 7, label: "Вс" }
    ].forEach((day) => {
      const button = create("button", "", day.label);
      button.type = "button";
      button.dataset.alarmDay = String(day.value);
      button.addEventListener("click", () => {
        if (!alarmDayAllowedForDeparture(day.value, departure)) return;
        const value = day.value;
        sheetState.repeatDays = sheetState.repeatDays.includes(value)
          ? sheetState.repeatDays.filter((item) => item !== value)
          : [...sheetState.repeatDays, value].sort((left, right) => left - right);
        updateAlarmSheetControls();
      });
      daysGrid.append(button);
    });
    daysWrap.append(daysGrid);

    const reminder = create("div", "reminder-time-selector");
    reminder.append(create("span", "alarm-section-label", "Напомнить за"));
    const quick = create("div", "alarm-quick-times");
    quickValues.forEach((minutes) => {
      const button = create("button", "", formatReminderLead(minutes));
      button.type = "button";
      button.dataset.alarmLead = String(minutes);
      button.addEventListener("click", () => {
        sheetState.selectedLead = minutes;
        customInput.value = "";
        status.textContent = "";
        status.classList.remove("is-error", "is-success");
        updateAlarmSheetControls();
      });
      quick.append(button);
    });

    const customForm = create("form", "alarm-custom-time");
    const customField = create("label", "alarm-custom-field");
    const customInput = create("input");
    customInput.type = "number";
    customInput.min = "1";
    customInput.max = "360";
    customInput.step = "1";
    customInput.inputMode = "numeric";
    customInput.placeholder = "Своё время";
    const customUnit = create("span", "", "мин");
    const customSubmit = create("button", "", "Поставить");
    customSubmit.type = "submit";
    customField.append(customInput, customUnit);
    customForm.append(customField, customSubmit);
    customForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const minutes = normalizeReminderLead(customInput.value);
      if (!minutes) {
        status.textContent = "Укажите время от 1 до 360 минут.";
        status.classList.add("is-error");
        status.classList.remove("is-success");
        return;
      }
      sheetState.selectedLead = minutes;
      updateAlarmSheetControls();
    });
    reminder.append(quick, customForm);

    const status = create("p", "form-status alarm-sheet-status");
    const save = create("button", "primary-button alarm-save-button", "Сохранить");
    save.type = "button";
    save.addEventListener("click", async () => {
      const minutes = normalizeReminderLead(sheetState.selectedLead || customInput.value);
      if (!minutes) {
        status.textContent = "Выберите время напоминания.";
        status.classList.add("is-error");
        return;
      }
      const repeatOptions = {
        repeatMode: sheetState.repeatMode,
        repeatDays: normalizedAlarmDays(sheetState.repeatMode, sheetState.repeatDays, departure)
      };
      if (repeatOptions.repeatMode !== "once" && !repeatOptions.repeatDays.length) {
        status.textContent = "Выберите дни, когда этот рейс ходит.";
        status.classList.add("is-error");
        status.classList.remove("is-success");
        updateAlarmSheetControls();
        return;
      }

      save.disabled = true;
      await createReminder(departure, minutes, status, repeatOptions, { route, direction, stop }, {
        onSuccess: (_savedReminder, favoriteResult = {}) => {
          closeAlarmBottomSheet();
          if (state.activeView === "schedule") renderSchedule({ skipTimelineLoad: true });
          showToast(favoriteResult.added ? "Будильник сохранён, остановка в избранном." : "Будильник сохранён");
        },
        onError: () => {
          showToast("Не удалось сохранить будильник");
        }
      });
      if (state.alarmSheet?.root === root) updateAlarmSheetControls();
    });

    panel.append(handle, header, modes, daysWrap, reminder, status, save);
    root.append(backdrop, panel);
    document.body.append(root);
    state.alarmSheet = { root, panel, state: sheetState };

    function updateAlarmSheetControls() {
      modes.querySelectorAll("[data-alarm-mode]").forEach((button) => {
        const active = button.dataset.alarmMode === sheetState.repeatMode;
        const allowed = alarmModeAllowedForDeparture(button.dataset.alarmMode, departure);
        button.disabled = !allowed;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-checked", active ? "true" : "false");
      });
      daysWrap.hidden = sheetState.repeatMode !== "custom";
      daysGrid.querySelectorAll("[data-alarm-day]").forEach((button) => {
        const value = Number(button.dataset.alarmDay);
        const allowed = alarmDayAllowedForDeparture(value, departure);
        const active = allowed && sheetState.repeatDays.includes(value);
        button.disabled = !allowed;
        button.title = allowed ? "" : "Этот рейс не ходит в этот день";
        button.classList.toggle("is-active", active);
      });
      quick.querySelectorAll("[data-alarm-lead]").forEach((button) => {
        button.classList.toggle("is-active", Number(button.dataset.alarmLead) === Number(sheetState.selectedLead));
      });
      const repeatDays = normalizedAlarmDays(sheetState.repeatMode, sheetState.repeatDays, departure);
      const repeatModeInvalid = sheetState.repeatMode !== "once" && repeatDays.length === 0;
      save.disabled = Boolean(repeatModeInvalid || save.classList.contains("is-saving"));
    }

    backdrop.addEventListener("click", () => closeAlarmBottomSheet());
    close.addEventListener("click", () => closeAlarmBottomSheet());
    updateAlarmSheetControls();

    requestAnimationFrame(() => {
      root.hidden = false;
      document.body.classList.add("is-alarm-sheet-open");
      requestAnimationFrame(() => root.classList.add("is-open"));
    });
  }

  function closeAlarmBottomSheet(options = {}) {
    const current = state.alarmSheet;
    if (!current?.root) return;
    const root = current.root;
    state.alarmSheet = null;
    document.body.classList.remove("is-alarm-sheet-open");
    root.classList.remove("is-open");
    const remove = () => root.remove();
    if (options.immediate) remove();
    else window.setTimeout(remove, 220);
  }

  function defaultAlarmRepeatMode(favorite, departure = null) {
    const departureMode = defaultAlarmRepeatModeForDeparture(departure);
    if (departureMode) return departureMode;
    const mode = favorite?.dayMode || state.dayMode;
    if (mode === "weekday") return "weekdays";
    if (mode === "weekend") return "weekends";
    return "once";
  }

  function defaultAlarmRepeatModeForDeparture(departure) {
    const days = alarmDaysFromDeparture(departure);
    if (!days.length) return "";
    const isWeekdays = days.every((day) => day >= 1 && day <= 5);
    const isWeekends = days.every((day) => day >= 6);
    if (isWeekdays) return "weekdays";
    if (isWeekends) return "weekends";
    return "custom";
  }

  function alarmDaysFromDeparture(departure) {
    const mask = normalizeDayMaskForUi(departure?.dayMask || "");
    const days = [];
    for (let index = 0; index < 7; index += 1) {
      if (mask[index] === "1") days.push(index + 1);
    }
    return days;
  }

  function defaultAlarmDays(mode, departure = null) {
    const departureDays = alarmDaysFromDeparture(departure);
    if (mode === "weekdays") return departureDays.filter((day) => day <= 5).length ? departureDays.filter((day) => day <= 5) : [1, 2, 3, 4, 5];
    if (mode === "weekends") return departureDays.filter((day) => day >= 6).length ? departureDays.filter((day) => day >= 6) : [6, 7];
    if (mode === "custom") return departureDays;
    return [];
  }

  function alarmSelectableDays(departure = null) {
    const departureDays = alarmDaysFromDeparture(departure);
    return departureDays.length ? departureDays : [1, 2, 3, 4, 5, 6, 7];
  }

  function alarmDayAllowedForDeparture(day, departure = null) {
    return alarmSelectableDays(departure).includes(Number(day));
  }

  function filterAlarmDaysForDeparture(days, departure = null) {
    const allowed = new Set(alarmSelectableDays(departure));
    return [...new Set((days || []).map(Number).filter((day) => day >= 1 && day <= 7 && allowed.has(day)))]
      .sort((left, right) => left - right);
  }

  function alarmModeAllowedForDeparture(mode, departure = null) {
    if (mode === "weekdays") return filterAlarmDaysForDeparture([1, 2, 3, 4, 5], departure).length > 0;
    if (mode === "weekends") return filterAlarmDaysForDeparture([6, 7], departure).length > 0;
    return true;
  }

  function normalizedAlarmDays(mode, days, departure = null) {
    if (mode === "weekdays") return filterAlarmDaysForDeparture([1, 2, 3, 4, 5], departure);
    if (mode === "weekends") return filterAlarmDaysForDeparture([6, 7], departure);
    if (mode === "custom") return filterAlarmDaysForDeparture(days, departure);
    return [];
  }

  function renderReminderPanel(departure, context = {}) {
    const panel = document.createElement("details");
    panel.className = "reminder-panel";
    const summary = create("summary", "", "Будильник");
    panel.append(summary);
    if (!departure) {
      panel.append(create("p", "muted", "Выберите рейс, чтобы поставить будильник."));
      return panel;
    }

    const route = context.route || activeRoute();
    const direction = context.direction || activeDirection();
    const stop = context.stop || activeStop();
    const header = create("div", "reminder-head");
    header.append(create("strong", "", `Рейс ${departure.time}`), create("span", "", `Маршрут ${route?.number || ""} · ${stop?.name || ""}`));
    const repeat = renderReminderRepeatControls(departure);

    const status = create("p", "form-status");
    const leadTime = renderReminderLeadControls(departure, status, repeat, { route, direction, stop });

    panel.append(header, repeat.node, leadTime.node, status);
    panel.addEventListener("toggle", () => {
      if (!panel.open) return;
      requestAnimationFrame(() => {
        document.documentElement.scrollLeft = 0;
        document.body.scrollLeft = 0;
      });
    });
    return panel;
  }

  function renderReminderRepeatControls(departure) {
    const requestedDefaultMode = defaultAlarmRepeatModeForDeparture(departure) || (state.dayMode === "weekday" ? "weekdays" : state.dayMode === "weekend" ? "weekends" : "once");
    const defaultMode = alarmModeAllowedForDeparture(requestedDefaultMode, departure) ? requestedDefaultMode : "once";
    const groupName = `reminder-repeat-${departure.time.replace(/[^0-9]/g, "")}-${Math.random().toString(36).slice(2)}`;
    const wrap = create("div", "reminder-repeat");
    const modeRow = create("div", "reminder-repeat-modes");
    const dayRow = create("div", "reminder-repeat-days");
    const modes = [
      { value: "once", label: "Один раз" },
      { value: "weekdays", label: "Будни" },
      { value: "weekends", label: "Выходные" },
      { value: "custom", label: "Свои дни" }
    ];
    const days = [
      { value: 1, label: "Пн" },
      { value: 2, label: "Вт" },
      { value: 3, label: "Ср" },
      { value: 4, label: "Чт" },
      { value: 5, label: "Пт" },
      { value: 6, label: "Сб" },
      { value: 7, label: "Вс" }
    ];

    modes.forEach((mode) => {
      const label = create("label", "reminder-repeat-pill");
      const input = create("input");
      input.type = "radio";
      input.name = groupName;
      input.value = mode.value;
      input.disabled = !alarmModeAllowedForDeparture(mode.value, departure);
      input.checked = mode.value === defaultMode;
      label.append(input, create("span", "", mode.label));
      modeRow.append(label);
    });

    const initialDays = normalizedAlarmDays(defaultMode, defaultAlarmDays(defaultMode, departure), departure);
    days.forEach((day) => {
      const label = create("label", "reminder-day-pill");
      const input = create("input");
      input.type = "checkbox";
      input.value = String(day.value);
      input.disabled = !alarmDayAllowedForDeparture(day.value, departure);
      input.checked = initialDays.includes(day.value);
      label.append(input, create("span", "", day.label));
      dayRow.append(label);
    });

    const syncDays = () => {
      const mode = modeRow.querySelector("input:checked")?.value || "once";
      dayRow.hidden = mode !== "custom";
      if (mode === "weekdays" || mode === "weekends") {
        const activeDays = normalizedAlarmDays(mode, [], departure);
        dayRow.querySelectorAll("input").forEach((input) => {
          const value = Number(input.value);
          input.checked = activeDays.includes(value);
        });
      } else if (mode === "custom") {
        dayRow.querySelectorAll("input").forEach((input) => {
          if (input.disabled) input.checked = false;
        });
      }
    };
    modeRow.addEventListener("change", syncDays);
    syncDays();

    wrap.append(create("span", "reminder-repeat-title", "Повтор"), modeRow, dayRow);
    return {
      node: wrap,
      getValue() {
        const mode = modeRow.querySelector("input:checked")?.value || "once";
        const repeatDays = [...dayRow.querySelectorAll("input:checked")].map((input) => Number(input.value));
        return { repeatMode: mode, repeatDays: normalizedAlarmDays(mode, repeatDays, departure) };
      }
    };
  }

  function formatReminderLead(minutes) {
    const value = Number(minutes) || 0;
    if (value >= 60) {
      const hours = Math.floor(value / 60);
      const rest = value % 60;
      return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
    }
    return `${value} мин`;
  }

  function normalizeReminderLead(value) {
    const minutes = Math.round(Number(value));
    if (!Number.isFinite(minutes) || minutes < 1) return 0;
    return Math.min(minutes, 360);
  }

  function renderReminderLeadControls(departure, statusNode, repeat, context = {}) {
    const wrap = create("div", "reminder-lead");
    const quick = create("div", "reminder-options");
    const custom = create("form", "reminder-custom-time");
    const field = create("label", "reminder-custom-field");
    const input = create("input");
    const submit = create("button", "mini-button reminder-custom-submit", "Поставить");

    input.type = "number";
    input.min = "1";
    input.max = "360";
    input.step = "1";
    input.inputMode = "numeric";
    input.placeholder = "Своё время";
    submit.type = "submit";

    [5, 10, 15, 30, 60, 120].forEach((minutes) => {
      const button = create("button", "mini-button", formatReminderLead(minutes));
      button.type = "button";
      button.addEventListener("click", () => createReminder(departure, minutes, statusNode, repeat.getValue(), context));
      quick.append(button);
    });

    custom.addEventListener("submit", (event) => {
      event.preventDefault();
      const minutes = normalizeReminderLead(input.value);
      if (!minutes) {
        statusNode.textContent = "Укажите время от 1 до 360 минут.";
        statusNode.classList.add("is-error");
        statusNode.classList.remove("is-success");
        return;
      }
      createReminder(departure, minutes, statusNode, repeat.getValue(), context);
    });

    field.append(input, create("span", "", "мин"));
    custom.append(field, submit);
    wrap.append(create("span", "reminder-repeat-title", "Когда напомнить"), quick, custom);
    return { node: wrap };
  }

  function reminderRepeatLabel(options) {
    if (options.repeatMode === "weekdays") return "по будням";
    if (options.repeatMode === "weekends") return "по выходным";
    if (options.repeatMode === "custom") return "в выбранные дни";
    return "один раз";
  }

  function renderReminderStatus(statusNode, text, reminderId) {
    clear(statusNode);
    const label = create("span", "", text);
    statusNode.append(label);
    if (reminderId) {
      const cancel = create("button", "reminder-cancel-button", "Отменить");
      cancel.type = "button";
      cancel.addEventListener("click", () => cancelReminder(reminderId, statusNode));
      statusNode.append(cancel);
    }
  }

  async function cancelReminder(reminderId, statusNode) {
    if (!reminderId) return;
    renderReminderStatus(statusNode, "Отменяем будильник...", "");
    statusNode.classList.remove("is-error", "is-success");
    try {
      const response = await fetch(`/api/reminders/${encodeURIComponent(reminderId)}`, {
        method: "DELETE",
        headers: telegramHeaders()
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Не удалось отменить будильник.");
      renderReminderStatus(statusNode, "Будильник отменён.", "");
      statusNode.classList.add("is-success");
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } catch (error) {
      renderReminderStatus(statusNode, error.message, "");
      statusNode.classList.add("is-error");
      tg?.HapticFeedback?.notificationOccurred?.("error");
    }
  }

  async function createReminder(departure, remindMinutes, statusNode, repeatOptions = { repeatMode: "once", repeatDays: [] }, context = {}, options = {}) {
    if (!tg?.initData) {
      statusNode.textContent = "Telegram не передал ваш ID, поэтому будильник нельзя сохранить для уведомления.";
      statusNode.classList.add("is-error");
      options.onError?.(new Error(statusNode.textContent));
      return;
    }

    const route = context.route || activeRoute();
    const direction = context.direction || activeDirection();
    const stop = context.stop || activeStop();
    if (!route || !direction || !stop || !departure) {
      renderReminderStatus(statusNode, "Не удалось определить рейс для будильника.", "");
      statusNode.classList.add("is-error");
      options.onError?.(new Error("Не удалось определить рейс для будильника."));
      return;
    }
    renderReminderStatus(statusNode, "Ставим будильник...", "");
    statusNode.classList.remove("is-error", "is-success");

    try {
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: { "content-type": "application/json", ...telegramHeaders() },
        body: JSON.stringify({
          routeId: route.id,
          routeNumber: route.number,
          directionCode: direction.code,
          directionName: direction.name,
          stopUid: stop.id,
          stopName: stop.name,
          departureTime: departure.time,
          departureDayMask: departureScheduleDayMask(departure),
          tripCode: departure.tripCode || "",
          variantCode: departure.variantCode || "",
          remindMinutes,
          repeatMode: repeatOptions.repeatMode,
          repeatDays: repeatOptions.repeatDays
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Не удалось поставить будильник.");
      const favoriteResult = ensureFavoriteForReminder(route, direction, stop, departure);
      if (favoriteResult.favorite) {
        rememberAlarmState(favoriteResult.favorite, departure, data.reminder, remindMinutes, repeatOptions);
        renderFavorites();
      }
      const replacedText = data.reminder?.replacedCount ? " Старый будильник на этот рейс заменён." : "";
      const favoriteText = favoriteResult.added ? " Остановка добавлена в избранное." : "";
      renderReminderStatus(statusNode, `Готово: напомним за ${remindMinutes} мин, ${reminderRepeatLabel(repeatOptions)}.${replacedText}${favoriteText}`, data.reminder?.id || "");
      statusNode.classList.add("is-success");
      tg?.HapticFeedback?.notificationOccurred?.("success");
      options.onSuccess?.(data.reminder || null, favoriteResult);
      return data.reminder || null;
    } catch (error) {
      renderReminderStatus(statusNode, error.message, "");
      statusNode.classList.add("is-error");
      tg?.HapticFeedback?.notificationOccurred?.("error");
      options.onError?.(error);
      return null;
    }
  }

  function selectedDepartureKey(departure) {
    return departure ? `${departureScheduleDayMask(departure)}:${departure.tripCode}:${departure.variantCode}:${departure.time}` : "";
  }

  function departureScheduleDayMask(departure) {
    return departure?.dayMask || departure?.sourceDayMasks?.[0] || "";
  }

  function timelineKeyForDeparture(route, direction, departure) {
    const dayMask = departureScheduleDayMask(departure);
    return route && direction && departure?.tripCode && departure?.variantCode && dayMask
      ? `${route.id}:${direction.code}:${dayMask}:${departure.tripCode}:${departure.variantCode}`
      : "";
  }

  async function fetchTimelineForDeparture(route, direction, departure) {
    const key = timelineKeyForDeparture(route, direction, departure);
    if (!key) return { key: "", timeline: [] };
    if (state.timelineCache.has(key)) return { key, timeline: state.timelineCache.get(key) || [] };

    const query = new URLSearchParams({
      routeId: route.id,
      directionCode: direction.code,
      dayMask: departureScheduleDayMask(departure),
      tripCode: departure.tripCode,
      variantCode: departure.variantCode
    });
    const response = await fetch(`/api/trip/timeline?${query}`, { cache: "no-store" });
    if (!response.ok) return { key, timeline: [] };
    const data = await response.json();
    const timeline = data.timeline || [];
    state.timelineCache.set(key, timeline);
    return { key, timeline };
  }

  async function loadBestTimelineFor(preferredDeparture, times = selectedTimes(), next = getNextDeparture(times), fallbackDeparture = null) {
    const route = activeRoute();
    const direction = activeDirection();
    if (!route || !direction || !preferredDeparture?.tripCode || !preferredDeparture?.variantCode || !departureScheduleDayMask(preferredDeparture)) {
      state.timeline = [];
      state.timelineKey = "";
      renderStops();
      return;
    }

    const requestId = state.timelineRequestId + 1;
    state.timelineRequestId = requestId;

    try {
      const candidates = state.selectedDepartureMode === "manual"
        ? [preferredDeparture].filter(Boolean)
        : candidateDeparturesForLiveTrip(times, preferredDeparture, next, fallbackDeparture);
      let fallback = null;

      for (const departure of candidates) {
        const result = await fetchTimelineForDeparture(route, direction, departure);
        if (requestId !== state.timelineRequestId) return;
        if (!fallback && selectedDepartureKey(departure) === selectedDepartureKey(preferredDeparture)) {
          fallback = { departure, ...result };
        }
        if (state.dayMode === "today" && routeVehiclePosition(result.timeline)) {
          const preserveViewport = state.selectedDepartureMode === "manual";
          const scrollTop = preserveViewport ? (window.scrollY || document.documentElement.scrollTop || 0) : 0;
          state.selectedDeparture = departure;
          if (state.selectedDepartureMode !== "manual") state.selectedDepartureMode = "auto";
          state.timeline = result.timeline;
          state.timelineKey = result.key;
          renderSchedule({ skipTimelineLoad: true });
          if (preserveViewport) {
            const restoreScroll = () => window.scrollTo({ top: scrollTop, left: 0, behavior: "auto" });
            requestAnimationFrame(() => {
              restoreScroll();
              requestAnimationFrame(restoreScroll);
            });
          } else {
            scrollActiveDepartureChip("smooth");
          }
          return;
        }
      }

      const preferred = fallback || await fetchTimelineForDeparture(route, direction, preferredDeparture).then((result) => ({ departure: preferredDeparture, ...result }));
      if (requestId !== state.timelineRequestId) return;
      state.timeline = preferred.timeline || [];
      state.timelineKey = preferred.key || "";
      renderStops();
    } catch {
      state.timeline = [];
      state.timelineKey = "";
      renderStops();
    }
  }

  function candidateDeparturesForLiveTrip(times = [], preferredDeparture, nextDeparture, fallbackDeparture) {
    const unique = new Map();
    const add = (departure) => {
      const key = selectedDepartureKey(departure);
      if (key && !unique.has(key)) unique.set(key, departure);
    };

    add(preferredDeparture);
    add(nextDeparture);
    if (state.dayMode === "today" && times.length) {
      const now = minutesFromDate(new Date());
      times
        .filter((item) => departureIsActiveNow(item, now))
        .sort((a, b) => Math.abs(relativeDepartureMinutes(a, now) - now) - Math.abs(relativeDepartureMinutes(b, now) - now))
        .slice(0, 8)
        .forEach(add);
      const nextIndex = times.findIndex((item) => relativeDepartureMinutes(item, now) >= now);
      const center = nextIndex >= 0 ? nextIndex : times.length - 1;
      [center, center - 1, center - 2, center - 3, center - 4, center - 5, center - 6, center + 1].forEach((index) => {
        if (index >= 0 && index < times.length) add(times[index]);
      });
    }
    add(fallbackDeparture);
    return [...unique.values()];
  }

  async function loadTimelineFor(next) {
    return loadBestTimelineFor(next, selectedTimes(), getNextDeparture(selectedTimes()), null);
  }

  function getNextDeparture(times, dayMode = state.dayMode) {
    if (!times.length) return null;
    if (dayMode !== "today") return { ...times[0], minutes: times[0].minutes };
    const now = minutesFromDate(new Date());
    const next = [...times]
      .map((item) => ({ ...item, minutes: relativeDepartureMinutes(item, now) }))
      .filter((item) => item.minutes >= now)
      .sort((a, b) => a.minutes - b.minutes)[0];
    return next ? { ...next, diff: next.minutes - now } : null;
  }

  function getCurrentDeparture(times, dayMode = state.dayMode) {
    if (!times.length || dayMode !== "today") return null;
    const now = minutesFromDate(new Date());
    const current = times
      .filter((item) => departureIsActiveNow(item, now))
      .sort((a, b) => {
        const distance = Math.abs(relativeDepartureMinutes(a, now) - now) - Math.abs(relativeDepartureMinutes(b, now) - now);
        if (distance !== 0) return distance;
        return Number(b.tripStartMinutes ?? b.minutes ?? 0) - Number(a.tripStartMinutes ?? a.minutes ?? 0);
      })[0];
    return current || null;
  }

  function departureIsActiveNow(item, now = minutesFromDate(new Date())) {
    const start = Number(item?.tripStartMinutes);
    const end = Number(item?.tripEndMinutes);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
    let current = now;
    if (current < start && end >= 1440) current += 1440;
    return current >= start && current <= end;
  }

  function departureHasPassedStop(item, now = minutesFromDate(new Date())) {
    if (!item || state.dayMode !== "today") return false;
    const minutes = relativeDepartureMinutes(item, now);
    return Number.isFinite(minutes) && minutes < now;
  }

  function maskMatchesMode(mask, dayMode = state.dayMode) {
    const value = String(mask || "");
    if (dayMode === "today") return maskMatchesToday(value);
    if (dayMode === "weekday") return value.slice(0, 5).includes("1");
    if (dayMode === "weekend") return value.slice(5).includes("1");
    return true;
  }

  function maskMatchesToday(mask) {
    const today = new Date();
    const value = normalizeDayMaskForUi(mask);
    return serviceDayMaskIndexes(today).some((index) => value[index] === "1");
  }

  function dayTitle() {
    if (state.dayMode === "today") return `Отправления сегодня · ${serviceDayTitle(new Date())}`;
    if (state.dayMode === "weekday") return "Отправления по будням";
    return "Отправления в выходные";
  }

  function departureHint(item) {
    const direction = activeDirection();
    const destination = item?.destinationStop || direction?.to || "";
    return destination ? `до ${destination}` : "рейс";
  }

  function stopPositionLabel(position) {
    return `${position} ост.`;
  }

  function departureChipHint(item) {
    if (!item) return "";
    return item.viaLabel || departureHint(item);
  }

  function departureChipSupportLabel(item, flags = {}) {
    if (!item) return "";
    if (flags.isSelected && item.viaLabel) return item.viaLabel;
    if (flags.isLiveTrip) return "текущий рейс";
    if (flags.isNext) return item.viaLabel || shortDepartureDestination(item);
    if (flags.isPast) return item.viaLabel || shortDepartureDestination(item);
    if (flags.isSelected) return "выбран";
    if (item.viaLabel) return item.viaLabel;
    return shortDepartureDestination(item);
  }

  function shortDepartureDestination(item) {
    const destination = item?.destinationStop || activeDirection()?.to || "";
    if (!destination) return "по расписанию";
    return `до ${shortPlaceName(destination)}`;
  }

  function shortPlaceName(value) {
    return String(value || "")
      .replace(/^Сквер\s+Героя\s+/i, "Сквер ")
      .replace(/^Магазин\s+/i, "")
      .replace(/^Улица\s+/i, "ул. ")
      .replace(/^Ул\.\s*/i, "ул. ")
      .trim();
  }

  function departureDetailHint(item) {
    if (!item) return "";
    const destination = departureHint(item);
    if (!item.viaLabel) return destination;
    return `${destination} · ${item.viaLabel}`;
  }

  function renderRouteVariantNotice(times) {
    const labels = [...new Set((times || []).map((item) => item.viaLabel).filter(Boolean))];
    if (labels.length < 2) return null;

    const notice = create("div", "route-variant-notice");
    notice.append(
      create("strong", "", "Есть разные варианты рейса"),
      create("span", "", `Смотрите подпись под временем: ${labels.slice(0, 4).join(", ")}.`)
    );
    return notice;
  }

  function yandexButton(route, direction, stop, text = "Яндекс") {
    const button = create("button", "mini-button", text);
    button.type = "button";
    button.title = `Открыть автобус ${route?.number || ""} на Яндекс.Картах`;
    button.addEventListener("click", () => openRouteMap(route));
    return button;
  }

  function openRouteMap(route) {
    const query = `автобус ${route?.number || ""} Барановичи`.trim();
    const url = `https://yandex.by/maps/?text=${encodeURIComponent(query)}`;
    if (tg?.openLink) {
      tg.openLink(url);
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function favoriteButton(departure) {
    const route = activeRoute();
    const direction = activeDirection();
    const stop = activeStop();
    const active = isFavoriteContext(route, direction, stop);
    const button = create("button", `mini-button favorite-toggle ${active ? "is-active" : ""}`, active ? "В избранном" : "В избранное");
    button.type = "button";
    button.disabled = !stop;
    button.addEventListener("click", () => toggleCurrentFavorite(departure));
    return button;
  }

  function buildFavorite(route, direction, stop, departure) {
    if (!route || !direction || !stop) return;

    const suggested = `Маршрут №${route.number} · ${stop.name}`;

    return {
      id: `${route.id}:${direction.code}:${stop.id}`,
      title: suggested,
      routeId: route.id,
      routeNumber: route.number,
      routeName: route.name,
      directionCode: direction.code,
      stopUid: stop.id,
      stopName: stop.name,
      time: departure?.time || "",
      dayMask: departure?.dayMask || "",
      tripCode: departure?.tripCode || "",
      variantCode: departure?.variantCode || "",
      destinationStop: direction.to || departure?.destinationStop || "",
      dayMode: state.dayMode
    };
  }

  function saveFavorite(route, direction, stop, departure, message = "Остановка добавлена в избранное.") {
    const { favorite } = ensureFavoriteForReminder(route, direction, stop, departure);
    if (!favorite) return null;

    renderFavorites();
    showToast(message);
    return favorite;
  }

  function ensureFavoriteForReminder(route, direction, stop, departure) {
    const favorite = buildFavorite(route, direction, stop, departure);
    if (!favorite) return { favorite: null, added: false };

    const existing = state.favorites.find((item) => item.id === favorite.id);
    const nextFavorite = existing ? { ...existing, ...favorite } : favorite;
    state.favorites = [nextFavorite]
      .concat(state.favorites.filter((item) => item.id !== favorite.id));
    safeStorage.setItem("routeFavorites", JSON.stringify(state.favorites));
    queueFavoritesSync();
    return { favorite: nextFavorite, added: !existing };
  }

  function saveCurrentFavorite(departure) {
    return saveFavorite(activeRoute(), activeDirection(), activeStop(), departure);
  }

  function toggleCurrentFavorite(departure) {
    const route = activeRoute();
    const direction = activeDirection();
    const stop = activeStop();
    const id = routeFavoriteId(route, direction, stop);
    if (!id) return;
    if (state.favorites.some((item) => item.id === id)) {
      removeFavorite(id, { silent: true });
      showToast("Маршрут убран из избранного.");
    } else {
      saveFavorite(route, direction, stop, departure, "Маршрут добавлен в избранное.");
    }
    renderSchedule();
  }

  function cancelStoredFavoriteReminders(favoriteId) {
    if (!tg?.initData) return;
    reminderIdsForFavoriteAlarm(favoriteId).forEach((reminderId) => {
      fetch(`/api/reminders/${encodeURIComponent(reminderId)}`, {
        method: "DELETE",
        headers: telegramHeaders()
      }).catch((error) => console.warn("Failed to cancel favorite reminder", error));
    });
  }

  function removeFavorite(id, options = {}) {
    cancelStoredFavoriteReminders(id);
    state.favorites = state.favorites.filter((item) => item.id !== id);
    Object.keys(state.alarms || {}).forEach((key) => {
      if (state.alarms[key]?.favoriteId === id) delete state.alarms[key];
    });
    writeAlarmStates();
    safeStorage.setItem("routeFavorites", JSON.stringify(state.favorites));
    queueFavoritesSync();
    renderFavorites();
    if (!options.silent) showToast("Избранное обновлено.");
  }

  // ── Серверная синхронизация избранного по Telegram ID ──────────────────────
  // Избранное остаётся в localStorage (моментальный отклик), а в Telegram
  // дополнительно сохраняется на сервере: смена устройства не теряет список.
  let favoritesSyncTimer = null;

  function queueFavoritesSync() {
    if (!tg?.initData) return;
    window.clearTimeout(favoritesSyncTimer);
    favoritesSyncTimer = window.setTimeout(() => {
      fetch("/api/user/favorites", {
        method: "POST",
        headers: { "content-type": "application/json", ...telegramHeaders() },
        body: JSON.stringify({ favorites: state.favorites })
      }).catch((error) => console.warn("Favorites sync failed", error));
    }, 2500);
  }

  async function pullFavoritesFromServer() {
    if (!tg?.initData) return;
    try {
      const response = await fetch("/api/user/favorites", { headers: telegramHeaders() });
      if (!response.ok) return;
      const data = await response.json();
      const serverFavorites = Array.isArray(data.favorites) ? data.favorites : [];
      if (!serverFavorites.length) {
        // На сервере пусто, локально есть — первичная загрузка снапшота.
        if (state.favorites.length) queueFavoritesSync();
        return;
      }
      if (!state.favorites.length) {
        // Новое устройство: восстанавливаем избранное из Telegram-профиля.
        state.favorites = serverFavorites.filter((item) => item && typeof item === "object" && typeof item.id === "string");
        safeStorage.setItem("routeFavorites", JSON.stringify(state.favorites));
        renderFavorites();
        renderHomeFavoriteRoutes({ loadSchedules: state.activeView === "home" });
      }
    } catch (error) {
      console.warn("Favorites pull failed", error);
    }
  }

  function directionLabel(route, direction) {
    if (!direction) return "";
    const fallback = direction.name || `${direction.from || ""} - ${direction.to || ""}`;
    const parts = String(route?.name || "")
      .split(/\s+-\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const from = expandStopName(direction.from || "");
    const to = expandStopName(direction.to || "");

    if (parts.length < 2) return fallback.replace(/\s*→\s*/g, " - ");

    const first = parts[0];
    const last = parts[parts.length - 1];
    if (sameStop(from, first) && sameStop(to, last)) return parts.join(" - ");
    if (sameStop(from, last) && sameStop(to, first)) return [...parts].reverse().join(" - ");
    if (sameStop(to, last) && !parts.some((part) => sameStop(part, from))) return [from, ...parts].join(" - ");
    if (sameStop(from, last) && !parts.some((part) => sameStop(part, to))) return [from, ...parts.slice(0, -1).reverse(), to].join(" - ");
    return fallback.replace(/\s*→\s*/g, " - ");
  }

  function routeDirectionDisplayLabel(route, direction) {
    const from = expandStopName(direction?.from || direction?.origin || "");
    const to = expandStopName(direction?.to || direction?.destination || "");
    if (from && to) return `${from} → ${to}`;
    return directionLabel(route, direction).replace(/\s+-\s+/g, " → ");
  }

  function expandStopName(value) {
    return String(value || "").replace(/^Кл\.\s*/i, "Кладбище ");
  }

  function sameStop(left, right) {
    return normalize(left).replace(/^кладбище\s+/u, "") === normalize(right).replace(/^кладбище\s+/u, "");
  }

  function renderServiceScreen() {
    if (!els.serviceView) return;

    els.serviceView.classList.add("service-choice-view");
    els.serviceView.innerHTML = `
      <section class="service-choice-shell">
        <section class="service-picker" aria-labelledby="serviceChoiceTitle">
          <div class="section-heading service-choice-head">
            <h2 id="serviceChoiceTitle">Услуги</h2>
            <p id="serviceChoiceSubtitle">Справочник СТО и услуг автопарка</p>
          </div>
          <div class="service-tabs" role="tablist" aria-label="Раздел услуг">
            <button class="is-active" type="button" role="tab" aria-selected="true" data-service-tab="sto">Услуги СТО</button>
            <button type="button" role="tab" aria-selected="false" data-service-tab="other">Другие услуги</button>
          </div>
          <div class="service-list" id="serviceOptions" role="list" aria-live="polite"></div>
          <p class="service-choice-note">Карточки работают как справочник — откройте услугу для деталей</p>
        </section>
      </section>
    `;

    els.serviceOptions = els.serviceView.querySelector("#serviceOptions");
    renderServiceOptions();
  }

  function serviceCatalog() {
    const base = {
      sto: {
        title: "Услуги СТО",
        subtitle: "Выберите услугу и посмотрите детали.",
        category: "СТО",
        items: []
      },
      other: {
        title: "Другие услуги",
        subtitle: "Откройте карточку, чтобы узнать условия.",
        category: "Другие услуги",
        items: []
      }
    };

    const services = Array.isArray(state.data?.services) ? state.data.services : [];
    if (services.length) {
      services
        .filter((service) => service && service.status !== "draft" && service.status !== "archived")
        .forEach((service) => {
          const section = service.section === "other" ? "other" : "sto";
          base[section].items.push(normalizeServiceItem(service, base[section].category, section));
        });
      if (base.sto.items.length || base.other.items.length) return base;
    }

    Object.entries(SERVICE_CATALOG).forEach(([section, catalog]) => {
      const key = section === "other" ? "other" : "sto";
      base[key].items = (catalog.items || []).map((item, index) =>
        normalizeServiceItem({ ...item, id: `${key}-${index + 1}` }, item.category || base[key].category, key)
      );
    });
    return base;
  }

  function serviceBulletsToArray(value) {
    if (Array.isArray(value)) return value.map((line) => String(line).trim()).filter(Boolean);
    return String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function normalizeServiceItem(item, fallbackCategory, section = "sto") {
    const name = item.name || "";
    const normalizedSection = item.section === "other" || section === "other" ? "other" : "sto";
    const icon = item.icon || "checklist";
    const meta = SERVICE_ICON_META[normalizedSection]?.[icon] || null;
    // Категория: своя → по иконке → эвристика/дефолт. Пустую строку игнорируем.
    const category =
      (item.category && String(item.category).trim())
      || (meta && meta.category)
      || (normalizedSection === "other" && /реклам/i.test(name) ? "Реклама" : "");
    let bullets = serviceBulletsToArray(item.bullets);
    if (!bullets.length && meta) bullets = meta.bullets.slice();
    return {
      id: item.id || item.serviceId || name,
      section: normalizedSection,
      name,
      description: item.description || "",
      price: item.price || "",
      details: item.details || "",
      icon,
      imageUrl: item.imageUrl || "",
      category,
      bullets
    };
  }

  function findServiceById(id) {
    const catalogs = serviceCatalog();
    return [...catalogs.sto.items, ...catalogs.other.items].find((item) => String(item.id) === String(id));
  }

  function renderServiceOptions() {
    if (!els.serviceView || !els.serviceOptions) return;
    const catalogs = serviceCatalog();
    const catalog = catalogs[state.serviceTab] || catalogs.sto;

    els.serviceView.querySelectorAll("[data-service-tab]").forEach((button) => {
      const active = button.dataset.serviceTab === state.serviceTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });

    clear(els.serviceOptions);
    els.serviceOptions.classList.remove("is-visible");

    catalog.items.forEach((item) => {
      const category = item.category || catalog.category;
      const row = create("button", "service-row", "");
      row.type = "button";
      row.setAttribute("role", "listitem");
      row.dataset.serviceId = item.id;
      row.dataset.serviceName = item.name;
      row.dataset.serviceCategory = category;
      row.setAttribute("aria-haspopup", "dialog");

      const imageUrl = safeMediaUrl(item.imageUrl);
      row.classList.toggle("has-image", Boolean(imageUrl));
      const icon = create("span", "service-row-ic", "");
      if (imageUrl) {
        icon.classList.add("is-image");
        const image = create("img");
        image.src = imageUrl;
        image.alt = "";
        image.loading = "lazy";
        icon.append(image);
      } else {
        icon.innerHTML = serviceIconMarkup(item.icon);
      }

      const main = create("span", "service-row-main", "");
      const top = create("span", "service-row-top", "");
      top.append(create("b", "", item.name));
      if (category) {
        const tag = create("span", `service-row-tag${item.section === "other" ? " is-neutral" : ""}`, category);
        top.append(tag);
      }
      main.append(top);
      if (item.description) main.append(create("span", "service-row-desc", item.description));

      const chev = create("span", "service-row-chev", "");
      chev.setAttribute("aria-hidden", "true");
      chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

      row.append(icon, main, chev);
      els.serviceOptions.append(row);
    });

    window.requestAnimationFrame(() => els.serviceOptions?.classList.add("is-visible"));
  }

  function handleServiceClick(event) {
    const source = event.target instanceof Element ? event.target : null;
    if (!source) return;

    const tab = source.closest("[data-service-tab]");
    if (tab) {
      state.serviceTab = tab.dataset.serviceTab || "sto";
      renderServiceOptions();
      return;
    }

    const card = source.closest("[data-service-name]");
    if (card) {
      const service = findServiceById(card.dataset.serviceId) || {
        id: card.dataset.serviceId || card.dataset.serviceName || "",
        name: card.dataset.serviceName || "",
        category: card.dataset.serviceCategory || "СТО"
      };
      openServiceDetail(service);
      return;
    }
  }

  function openServiceDetail(service) {
    if (!service?.name) return;
    closeServiceDetail();
    const section = service.section === "other" ? "other" : "sto";
    const sectionLabel = section === "other" ? "Услуга" : "СТО";
    const kicker = service.category ? `${sectionLabel} · ${service.category}` : sectionLabel;
    const bullets = Array.isArray(service.bullets) ? service.bullets : serviceBulletsToArray(service.bullets);
    const noteBody =
      service.details
      || "Стоимость и сроки уточняйте у специалиста предприятия или через Telegram-бота в разделе «О нас».";

    const overlay = create("div", "service-sheet-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", service.name);
    overlay.innerHTML = `
      <div class="service-sheet-dim" data-close-service-detail></div>
      <div class="service-sheet" role="document">
        <button class="service-sheet-x" type="button" aria-label="Закрыть" data-close-service-detail>×</button>
        <div class="service-sheet-grab" aria-hidden="true"></div>
        <div class="service-sheet-head">
          <span class="service-sheet-ic"></span>
          <div class="service-sheet-headtext">
            <span class="service-sheet-kicker"></span>
            <h3></h3>
          </div>
        </div>
        <p class="service-sheet-desc"></p>
        <div class="service-sheet-price" hidden></div>
        <p class="service-sheet-label" hidden>Что входит</p>
        <ul class="service-sheet-bullets" hidden></ul>
        <div class="service-sheet-note">
          <b>Как уточнить услугу</b>
          <span></span>
        </div>
      </div>
    `;

    const iconEl = overlay.querySelector(".service-sheet-ic");
    const imageUrl = safeMediaUrl(service.imageUrl);
    if (imageUrl) {
      iconEl.classList.add("is-image");
      const image = create("img");
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      iconEl.append(image);
    } else {
      iconEl.innerHTML = serviceIconMarkup(service.icon);
    }

    overlay.querySelector(".service-sheet-kicker").textContent = kicker;
    overlay.querySelector("h3").textContent = service.name;
    overlay.querySelector(".service-sheet-desc").textContent =
      service.description || "Описание уточняется у специалиста предприятия.";
    if (service.price) {
      const priceEl = overlay.querySelector(".service-sheet-price");
      priceEl.textContent = service.price;
      priceEl.hidden = false;
    }
    if (bullets.length) {
      overlay.querySelector(".service-sheet-label").hidden = false;
      const list = overlay.querySelector(".service-sheet-bullets");
      list.hidden = false;
      bullets.forEach((text) => {
        const li = create("li", "");
        li.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>';
        li.append(document.createTextNode(text));
        list.append(li);
      });
    }
    overlay.querySelector(".service-sheet-note span").textContent = noteBody;

    overlay.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-close-service-detail]")) closeServiceDetail();
    });
    document.body.append(overlay);
    document.body.classList.add("is-service-detail-open");
    // Принудительный reflow вместо rAF: в фоновом webview (свёрнутый Telegram)
    // rAF не тикает и шторка не выезжала. getBoundingClientRect фиксирует
    // стартовый transform, затем класс включает переход синхронно.
    void overlay.getBoundingClientRect();
    overlay.classList.add("is-open");
  }

  function closeServiceDetail() {
    document.body.classList.remove("is-service-detail-open");
    document.querySelectorAll(".service-sheet-overlay").forEach((overlay) => {
      overlay.classList.remove("is-open");
      window.setTimeout(() => overlay.remove(), 280);
    });
  }

  function serviceIconMarkup(name) {
    const icons = {
      engine: '<path d="M5 12h3l2-2h4l2 2h3v7h-3l-2 2h-4l-2-2H5v-7Z"/><path d="M10 10V7h5v3M4 15H2m20 0h-2"/>',
      brake: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.6"/><path d="M18 6l2-2M4 20l2-2M6 6 4 4m16 16-2-2"/>',
      snow: '<path d="M12 3v18M5 7l14 10M19 7 5 17"/><path d="M8 5l4 3 4-3M8 19l4-3 4 3"/>',
      gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
      axle: '<path d="M5 8v8h4l3 3 3-3h4V8h-4l-3-3-3 3H5Z"/><path d="M8 12h8"/>',
      bolt: '<path d="M13 2 5 14h6l-1 8 8-12h-6l1-8Z"/>',
      weld: '<path d="M7 16l4-4 5 5-4 4H7v-5Z"/><path d="M14 9l2-2 3 3-2 2M4 5l3 3M3 11h4M9 3v4"/>',
      checklist: '<rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 9h6M9 13h6M9 17h4M9 6h6"/>',
      car: '<path d="M5 15l1.6-5h10.8L19 15v4h-2v-2H7v2H5v-4Z"/><path d="M7 15h10M8 19h0M16 19h0"/>',
      spark: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
      drop: '<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z"/>',
      tire: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M12 5v3M12 16v3M5 12h3M16 12h3"/>',
      bus: '<rect x="5" y="5" width="14" height="13" rx="3"/><path d="M8 18v2M16 18v2M5 10h14M8 14h.01M16 14h.01"/>',
      building: '<path d="M5 20V6l7-3 7 3v14"/><path d="M9 9h2M13 9h2M9 13h2M13 13h2M9 17h6"/>',
      meal: '<path d="M7 4v8M5 4v8M9 4v8M5 12h4v8M16 4v16M16 4c3 2 3 7 0 9"/>',
      medical: '<path d="M12 5v14M5 12h14"/><rect x="4" y="4" width="16" height="16" rx="4"/>',
      ad: '<path d="M4 13V7l12-3v16L4 17v-4Z"/><path d="M18 9h2M18 15h2M7 17l2 4"/>',
      oil: '<path d="M8 7h8v12H8z"/><path d="M10 4h4v3M16 11l3 2v4l-3 2"/>',
      station: '<path d="M6 20V5h12v15"/><path d="M9 9h6M9 13h6M8 20h8"/>',
      pin: '<path d="M12 21s7-5.4 7-11a7 7 0 0 0-14 0c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
      market: '<path d="M4 9h16l-2-5H6L4 9Z"/><path d="M6 9v10h12V9M9 13h6"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[name] || icons.checklist}</svg>`;
  }

  function appealButton(route, stop) {
    const button = create("button", "mini-button", "Сообщить");
    button.type = "button";
    button.addEventListener("click", () => {
      setView("appeal");
      openFeedbackBot();
    });
    return button;
  }

  function setAppealCategory(category) {
    const radios = els.appealForm?.querySelectorAll('input[name="category"]') || [];
    const target =
      [...radios].find((input) => input.value === category) ||
      [...radios].find((input) => input.value === "Обращение");
    if (target) {
      target.checked = true;
    } else if (els.appealForm?.elements.category) {
      els.appealForm.elements.category.value = category || "Обращение";
    }
    updateAppealProgress();
    saveAppealDraft();
  }

  async function handleEmailLink(event) {
    const link = event.currentTarget;
    const email = link.dataset.emailLink || "buspark@brest.by";
    if ((link.getAttribute("href") || "").startsWith("mailto:")) {
      copyText(email).then(() => showToast(`E-mail скопирован: ${email}`)).catch(() => {});
      if (tg?.HapticFeedback?.notificationOccurred) {
        tg.HapticFeedback.notificationOccurred("success");
      }
      return;
    }

    event.preventDefault();
    await copyText(email);
    showToast(`E-mail скопирован: ${email}`);

    if (tg?.HapticFeedback?.notificationOccurred) {
      tg.HapticFeedback.notificationOccurred("success");
    }
  }

  function renderLeadership() {
    const contacts = (state.data?.leadership || [])
      .filter((contact) => Number(contact.active) !== 0)
      .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0) || String(left.name || "").localeCompare(String(right.name || ""), "ru"));
    if (!els.aboutPeople || !contacts.length) {
      enhanceAboutPeople();
      return;
    }

    const departments = ["all", ...new Set(contacts.map((contact) => contact.department || "Руководство"))];
    if (!departments.includes(state.aboutDepartment)) state.aboutDepartment = "all";
    if (els.aboutSearch && els.aboutSearch.value !== state.aboutSearch) els.aboutSearch.value = state.aboutSearch;

    state.aboutTab = "all";
    if (els.aboutTabs) {
      clear(els.aboutTabs);
      els.aboutTabs.hidden = true;
    }
    if (els.aboutFeatured) clear(els.aboutFeatured);
    renderLeadershipDepartments(departments);
    renderAboutFilterOptions(departments);
    renderLeadershipDirectory(contacts);
  }

  function renderLeadershipTabs() {
    if (!els.aboutTabs) return;
    const tabs = [
      ["all", "Все"],
      ["management", "Руководство"],
      ["engineers", "Инженеры"],
      ["departments", "Отделы"]
    ];
    clear(els.aboutTabs);
    tabs.forEach(([id, label]) => {
      const button = create("button", "", label);
      button.type = "button";
      button.classList.toggle("is-active", state.aboutTab === id);
      button.addEventListener("click", () => {
        state.aboutTab = id;
        state.aboutSearch = "";
        if (els.aboutSearch) els.aboutSearch.value = "";
        renderLeadership();
      });
      els.aboutTabs.append(button);
    });
  }

  function renderLeadershipDepartments(departments) {
    if (!els.aboutDepartments) return;
    clear(els.aboutDepartments);
    if (els.aboutDepartments.tagName === "SELECT") {
      departments.forEach((department) => {
        const option = create("option", "", department === "all" ? "Все отделы" : department);
        option.value = department;
        option.selected = state.aboutDepartment === department;
        els.aboutDepartments.append(option);
      });
      els.aboutDepartments.onchange = () => {
        state.aboutDepartment = els.aboutDepartments.value || "all";
        state.aboutSearch = "";
        if (els.aboutSearch) els.aboutSearch.value = "";
        renderLeadership();
      };
      return;
    }
    departments.forEach((department) => {
      const label = department === "all" ? "Все" : department;
      const button = create("button", "", label);
      button.type = "button";
      button.classList.toggle("is-active", state.aboutDepartment === department);
      button.addEventListener("click", () => {
        state.aboutDepartment = department;
        state.aboutSearch = "";
        if (els.aboutSearch) els.aboutSearch.value = "";
        renderLeadership();
      });
      els.aboutDepartments.append(button);
    });
  }

  function renderAboutFilterOptions(departments) {
    if (!els.aboutFilterOptions) return;
    clear(els.aboutFilterOptions);
    departments.forEach((department) => {
      const label = department === "all" ? "Все отделы" : department;
      const button = create("button", "", label);
      button.type = "button";
      button.classList.toggle("is-active", state.aboutDepartment === department);
      button.addEventListener("click", () => {
        state.aboutDepartment = department;
        state.aboutSearch = "";
        if (els.aboutSearch) els.aboutSearch.value = "";
        closeAboutFilterSheet();
        renderLeadership();
      });
      els.aboutFilterOptions.append(button);
    });
  }

  function openAboutFilterSheet() {
    if (!els.aboutFilterSheet) return;
    els.aboutFilterSheet.hidden = false;
    document.body.classList.add("is-about-filter-open");
    tg?.HapticFeedback?.impactOccurred?.("light");
  }

  function closeAboutFilterSheet() {
    if (!els.aboutFilterSheet || els.aboutFilterSheet.hidden) return;
    els.aboutFilterSheet.hidden = true;
    document.body.classList.remove("is-about-filter-open");
  }

  function renderLeadershipFeatured(contacts) {
    if (!els.aboutFeatured) return;
    clear(els.aboutFeatured);
    const featured = contacts.filter((contact) => Number(contact.featured) !== 0);
    const topContacts = (featured.length ? featured : contacts).slice(0, 6);
    topContacts.forEach((contact) => els.aboutFeatured.append(leadershipCard(contact, "featured")));
  }

  function renderLeadershipDirectory(contacts) {
    clear(els.aboutPeople);
    const visibleContacts = contacts.filter(leadershipMatchesFilters);
    renderLeadershipAlphaNav(visibleContacts);
    if (!visibleContacts.length) {
      els.aboutPeople.append(create("div", "empty-state", "Контактов по этим фильтрам нет."));
      return;
    }

    const query = normalize(state.aboutSearch);
    if (query) {
      els.aboutPeople.append(leadershipDepartmentSection("search-results", "Результаты поиска", visibleContacts, true));
      return;
    }

    groupLeadershipContacts(visibleContacts).forEach(([department, items]) => {
      const key = `department:${department}`;
      const shouldOpen = state.aboutDepartment !== "all" || state.expandedDepartments.has(key);
      els.aboutPeople.append(leadershipDepartmentSection(key, department, items, shouldOpen));
    });
  }

  function leadershipDepartmentSection(key, title, contacts, open = false) {
    const section = create("details", "about-dept-section");
    section.dataset.department = key;
    section.open = Boolean(open);
    section.addEventListener("toggle", () => {
      if (section.open) state.expandedDepartments.add(key);
      else state.expandedDepartments.delete(key);
    });

    const summary = create("summary", `about-dept-summary dept-icon-${departmentIconKey(title)}`);
    summary.append(create("span", "", title));

    const list = create("div", "about-dept-list");
    contacts.forEach((contact) => list.append(leadershipCard(contact, "compact")));
    section.append(summary, list);
    return section;
  }

  // Semantic icon per department for the directory rows (CSS draws the glyph).
  function departmentIconKey(title) {
    const value = String(title || "").toLocaleLowerCase("ru-RU");
    if (/столов|питани|буфет/.test(value)) return "food";
    if (/руковод|директор|администрац/.test(value)) return "lead";
    if (/технич|ремонт|инженер|(^|[^а-я])сто([^а-я]|$)/.test(value)) return "tech";
    if (/перевоз|эксплуатац|движени|колонн/.test(value)) return "bus";
    if (/вокзал|касс|диспетчер/.test(value)) return "station";
    if (/бухгалтер|экономик|кадр|правов|организацион/.test(value)) return "docs";
    return "people";
  }

  function queueLeadershipSearchScroll() {
    if (aboutSearchScrollTimer) window.clearTimeout(aboutSearchScrollTimer);
    const query = normalize(state.aboutSearch);
    if (query.length < 2 || !els.aboutPeople) return;

    aboutSearchScrollTimer = window.setTimeout(() => {
      const cards = [...els.aboutPeople.querySelectorAll(".about-person")];
      const target = cards.find((card) => normalize(card.textContent).includes(query)) || cards[0];
      if (!target) return;

      cards.forEach((card) => card.classList.remove("is-search-target"));
      target.classList.add("is-search-target");
      target.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "center" });
      window.setTimeout(() => target.classList.remove("is-search-target"), 1400);
    }, 140);
  }

  function leadershipMatchesFilters(contact) {
    const department = contact.department || "Руководство";
    if (state.aboutDepartment !== "all" && department !== state.aboutDepartment) return false;
    const query = normalize(state.aboutSearch);
    if (!query) return true;
    return normalize([
      contact.name,
      contact.position,
      department,
      contact.phone,
      contact.phoneLabel,
      contact.email,
      contact.note
    ].filter(Boolean).join(" ")).includes(query);
  }

  function leadershipMatchesTab(contact, tab) {
    if (!tab || tab === "all") return true;
    const text = normalize([contact.name, contact.position, contact.department, contact.note].filter(Boolean).join(" "));
    if (tab === "management") return /директор|руковод|начальник|главн/.test(text);
    if (tab === "engineers") return /инженер|энергетик|механик|технич|сервис|ремонт|производ/.test(text);
    if (tab === "departments") return /отдел|диспетчер|автовокзал|автостанц|столов|служб|организац|бухгалтер|профсоюз/.test(text);
    return true;
  }

  function groupLeadershipContacts(contacts) {
    const groups = new Map();
    contacts.forEach((contact) => {
      const department = contact.department || "Руководство";
      if (!groups.has(department)) groups.set(department, []);
      groups.get(department).push(contact);
    });
    return [...groups.entries()];
  }

  function renderLeadershipAlphaNav(contacts) {
    if (!els.aboutAlphaNav) return;
    clear(els.aboutAlphaNav);
    els.aboutAlphaNav.hidden = true;
  }

  function contactAlpha(contact) {
    const first = String(contact?.name || "").trim()[0] || "";
    return first.toLocaleUpperCase("ru-RU");
  }

  function leadershipCard(contact, variant) {
    const card = create("article", `about-person about-person-${variant}`);
    card.dataset.initials = makeInitials(contact.name);
    card.dataset.alpha = contactAlpha(contact);

    const content = create("div", "about-person-content");
    content.append(create("strong", "", contact.name || "Специалист"));
    content.append(create("span", "", contact.position || contact.department || ""));
    if (contact.department && contact.department !== contact.position) {
      content.append(create("small", "about-person-department", contact.department));
    }
    if (contact.note) content.append(create("small", "", contact.note));
    if (contact.phone) {
      const phone = create("a", "about-phone", contact.phoneLabel || contact.phone);
      phone.href = phoneHref(contact.phone);
      content.append(phone);
    }

    card.append(content);
    return card;
  }

  function phoneHref(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "tel:";
    if (digits.startsWith("375")) return `tel:+${digits}`;
    if (digits.startsWith("80")) return `tel:+375${digits.slice(2)}`;
    if (digits.startsWith("0")) return `tel:+375${digits.slice(1)}`;
    return `tel:+375${digits}`;
  }

  function openContactAppeal(contact) {
    setView("appeal");
    const form = els.appealForm;
    if (!form) return;
    setAppealCategory("Обращение");
    const name = contact?.name || "специалистом";
    const position = contact?.position ? ` (${contact.position})` : "";
    setClientChatDraftText(`Здравствуйте. Хочу связаться с ${name}${position}. `);
    updateAppealProgress();
    clientChatTextInput()?.focus();
    els.clientChat?.scrollIntoView({ behavior: motionSafeBehavior("smooth"), block: "start" });
  }

  function enhanceAboutPeople() {
    document.querySelectorAll(".about-person").forEach((card) => {
      const title = card.querySelector("strong")?.textContent || "";
      card.dataset.initials = makeInitials(title);
    });
  }

  function makeInitials(value) {
    const words = String(value)
      .replace(/[«»"().,]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !/^\d+$/.test(word));
    if (!words.length) return "АП";
    return words.slice(0, 2).map((word) => word[0]).join("").toLocaleUpperCase("ru-RU");
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (error) {
      // Telegram WebView can block clipboard access; fallback below keeps the address usable.
    }

    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.top = "-1000px";
    document.body.append(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    input.remove();
    return copied;
  }

  function showToast(message) {
    if (!els.appToast) return;
    window.clearTimeout(showToast.timer);
    els.appToast.textContent = message;
    els.appToast.hidden = false;
    requestAnimationFrame(() => els.appToast.classList.add("is-visible"));
    showToast.timer = window.setTimeout(() => {
      els.appToast.classList.remove("is-visible");
      window.setTimeout(() => {
        if (!els.appToast.classList.contains("is-visible")) els.appToast.hidden = true;
      }, 180);
    }, 1800);
  }

  function fact(label, value) {
    const node = create("div", "fact-item");
    node.append(create("span", "", label), create("strong", "", value || "—"));
    return node;
  }

  function serviceDayTitle(date) {
    const kind = serviceDayKind(date);
    if (kind === "holiday") return "выходной график";
    if (kind === "workday") return "будний график";
    if (kind === "weekend") return "выходной график";
    return "будний график";
  }

  function serviceDayKind(date) {
    const key = localDateKey(date);
    if (EXTRA_WORK_DAYS.has(key) || EXTRA_WORK_DAY_REPLACEMENTS.has(key)) return "workday";
    if (EXTRA_REST_DAYS.has(key) || isBelarusHoliday(date)) return "holiday";
    const day = scheduleDateParts(date).weekday;
    if (day === 0 || day === 6) return "weekend";
    return "regular";
  }

  function serviceDayMaskIndexes(date) {
    const key = localDateKey(date);
    if (EXTRA_WORK_DAY_REPLACEMENTS.has(key)) return [EXTRA_WORK_DAY_REPLACEMENTS.get(key)];
    if (EXTRA_REST_DAYS.has(key) || isBelarusHoliday(date)) return [5, 6];
    const day = scheduleDateParts(date).weekday;
    return [day === 0 ? 6 : day - 1];
  }

  function isBelarusHoliday(date) {
    const { year, month, day } = scheduleDateParts(date);
    const fixed = new Set(["1-1", "1-2", "1-7", "3-8", "5-1", "5-9", "7-3", "11-7", "12-25"]);
    if (fixed.has(`${month}-${day}`)) return true;

    const radunitsa = addDays(orthodoxEaster(year), 9);
    return localDateKey(date) === localDateKey(radunitsa);
  }

  function orthodoxEaster(year) {
    const a = year % 4;
    const b = year % 7;
    const c = year % 19;
    const d = (19 * c + 15) % 30;
    const e = (2 * a + 4 * b - d + 34) % 7;
    const month = Math.floor((d + e + 114) / 31);
    const day = ((d + e + 114) % 31) + 1;
    const julianDate = new Date(year, month - 1, day);
    return addDays(julianDate, 13);
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function localDateKey(date) {
    const { year, month, day } = scheduleDateParts(date);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function scheduleDateParts(date = new Date()) {
    const parts = Object.fromEntries(SCHEDULE_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      weekday: WEEKDAY_INDEX[parts.weekday] ?? date.getDay()
    };
  }

  function resetStopFilter() {
    state.stopSearch = "";
    if (els.stopSearch) els.stopSearch.value = "";
    state.selectedDeparture = null;
    state.selectedDepartureMode = "auto";
    state.showAllStops = false;
  }

  function defaultDirectionForRoute(route) {
    return route?.directions?.[0] || null;
  }

  function defaultStopForDirection(direction) {
    const stops = direction?.stops || [];
    return stops[0] || null;
  }

  function selectableStopsForDirection(direction) {
    return routeStopsForDirection(direction);
  }

  function routeStopsForDirection(direction) {
    const seen = new Set();
    return [
      ...(direction?.extraStartStops || []),
      ...(direction?.stops || []),
      ...(direction?.extraEndStops || [])
    ].filter((stop) => {
      if (!stop?.id || seen.has(stop.id)) return false;
      seen.add(stop.id);
      return true;
    });
  }

  function stopOptionLabel(stop, index) {
    const prefix = `${index + 1}. ${stopDisplayName(stop)}`;
    if (stop?.extraBoundary === "start") return `${prefix} · доп. начало`;
    if (stop?.extraBoundary === "end") return `${prefix} · доп. конечная`;
    return prefix;
  }

  function timelineOnlyStopNote(stop) {
    if (stop?.timelineOnlyKind === "end") return "Доп. конечная";
    return "Доп. начало";
  }

  function extraBoundaryStopNote(stop) {
    if (stop?.extraBoundary === "end") return "Доп. конечная";
    return "Доп. начало";
  }

  function stopDisplayName(stop) {
    return expandStopName(stop?.name || "");
  }

  function stopMatchesSearch(stop, query) {
    const needle = normalizeStopHint(query);
    if (!needle) return true;
    return normalizeStopHint(stop?.name || "").includes(needle);
  }

  function normalizeStopHint(value) {
    return normalize(value)
      .replace(/(^|[\s.,;:()/-])кл\.?(?=$|[\s.,;:()/-])/giu, "$1кладбище")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function activeRoute() {
    return routesForActiveTransport().find((route) => route.id === state.routeId);
  }

  function activeDirection() {
    return activeRoute()?.directions.find((direction) => direction.code === state.directionCode);
  }

  function activeStop() {
    return selectableStopsForDirection(activeDirection()).find((stop) => stop.id === state.stopUid);
  }

  function setView(view, options = {}) {
    if (view === "appeal") {
      openFeedbackBot();
      view = "home";
    }
    const targetView = document.querySelector(`.view[data-view="${view}"]`) ? view : "home";
    const changedView = targetView !== state.activeView;
    const resetScroll = (options.source === "bottom-nav" || options.resetScroll === true) && changedView;

    if (changedView && targetView !== "home") closeHomeRouteSearchMenu({ restoreFocus: false });
    if (changedView) rememberActiveViewScroll();
    if (changedView) document.body.classList.add("is-view-switching");

    state.activeView = targetView;
    document.body.dataset.activeView = targetView;
    document.querySelectorAll(".view").forEach((item) => item.classList.toggle("is-active", item.dataset.view === targetView));
    document.querySelectorAll("[data-nav]").forEach((item) => {
      const navView = item.dataset.nav;
      const isActive = navView === targetView || (targetView === "schedule" && navView === "routes");
      item.classList.toggle("is-active", isActive);
      if (isActive) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });

    if (targetView === "about" && changedView) {
      state.expandedDepartments.clear();
      renderLeadership();
    }

    if (targetView === "appeal") {
      loadUserAppeals().catch(() => {});
      renderClientChat();
      if (state.activeAppeal?.id) loadClientMessages();
    }

    if (targetView === "favorites") renderFavorites({ loadSchedules: true });

    // Leaving the appeal chat: stop the background poller so it doesn't keep
    // fetching messages forever after the user navigates away.
    if (targetView !== "appeal") stopClientChatPolling();

    syncTelegramBackButton(targetView);
    updateNewsUnreadBadge();

    replaceViewHash(targetView);
    if (resetScroll) {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
    } else if (changedView) {
      // Views share the window scroll: without restoring, a view opened after deep
      // scrolling elsewhere inherits that offset (e.g. routes list opening far down).
      restoreViewScroll(targetView);
    }
    if (changedView) {
      window.requestAnimationFrame(() => {
        document.body.classList.remove("is-view-switching");
        focusActiveView(targetView);
      });
    }
  }

  function focusActiveView(view) {
    const activeView = document.querySelector(`.view[data-view="${view}"].is-active`);
    if (!activeView) return;
    const target = activeView.querySelector(".section-heading h2, h1, h2, [role='heading']") || activeView;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }

  function setStatus(text, type) {
    els.appealStatus.textContent = text;
    els.appealStatus.classList.toggle("is-success", type === "success");
    els.appealStatus.classList.toggle("is-error", type === "error");
  }

  function telegramHeaders() {
    return tg?.initData ? { "x-telegram-init-data": tg.initData } : {};
  }

  async function loadStaffAccess() {
    if (!tg?.initData) {
      state.staffAccess = { hasAccess: false };
      renderStaffSettingsNav();
      return;
    }

    try {
      const response = await fetch("/api/staff/access", { headers: telegramHeaders() });
      if (!response.ok) throw new Error("staff access unavailable");
      state.staffAccess = await response.json();
    } catch {
      state.staffAccess = { hasAccess: false };
    }
    renderStaffSettingsNav();
  }

  function renderStaffSettingsNav() {
    if (!els.bottomNav) return;

    if (!canRenderSettingsNav()) {
      els.staffSettingsButton?.remove();
      els.staffSettingsButton = null;
      els.bottomNav.classList.remove("has-settings");
      return;
    }

    if (!els.staffSettingsButton) {
      els.staffSettingsButton = createSettingsNavButton();
      els.bottomNav.append(els.staffSettingsButton);
    }
    els.bottomNav.classList.add("has-settings");
  }

  function canRenderSettingsNav() {
    return Boolean(state.staffAccess?.hasAccess);
  }

  function createSettingsNavButton() {
    const button = create("button", "staff-settings-nav");
    button.type = "button";
    button.dataset.settingsNav = "true";
    button.setAttribute("aria-label", "Настройки");
    button.title = "Настройки";
    button.innerHTML = `
      <svg class="nav-icon nav-settings" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6Z"></path>
        <path d="M12 3.6v2.2M12 18.2v2.2M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M3.6 12h2.2M18.2 12h2.2M5.9 18.1l1.6-1.6M16.5 7.5l1.6-1.6"></path>
      </svg>
      <span>Настройки</span>
    `;
    return button;
  }

  function openStaffSettings() {
    window.location.href = "/admin";
  }

  function revokeObjectUrl(url) {
    if (url) URL.revokeObjectURL(url);
  }

  function subscribeForNotifications() {
    if (!tg?.initData) return;
    fetch("/api/subscribe", { method: "POST", headers: telegramHeaders() }).catch(() => {});
  }

  function renderOptions(select, options, selectedValue) {
    clear(select);
    options.forEach((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      node.selected = option.value === selectedValue;
      select.append(node);
    });
  }

  function create(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function richTextNode(text, className = "rich-text") {
    const node = create("div", className);
    node.innerHTML = formatRichText(cleanTextArtifacts(text));
    return node;
  }

  function displayText(value) {
    return cleanTextArtifacts(value);
  }

  function cleanTextArtifacts(value) {
    return String(value || "")
      .normalize("NFC")
      .replace(/([\p{L}\p{N}])\*\*([\p{L}\p{N}])/gu, "$1$2")
      .replace(/([\p{L}\p{N}])__([\p{L}\p{N}])/gu, "$1$2")
      .replace(/[\u200B-\u200D\uFEFF]/g, "");
  }

  function formatRichText(value) {
    return escapeHtml(value)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>")
      .replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>")
      .replace(/^- (.*)$/gm, "<span class=\"rich-list-item\">$1</span>")
      .replace(/\n/g, "<br>");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function safeExternalUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const parsed = new URL(raw, window.location.origin);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function safeMediaUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
    try {
      const parsed = new URL(raw, window.location.origin);
      return ["http:", "https:", "blob:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function appendAttachments(parent, attachments) {
    if (!attachments.length) return;
    const list = create("div", "attachment-list");
    attachments.forEach((item) => {
      const itemUrl = safeMediaUrl(item.url);
      if (!itemUrl) return;
      if (item.type === "image") {
        const button = create("button", "attachment-image");
        button.type = "button";
        button.setAttribute("aria-label", "Открыть изображение");
        const img = create("img");
        img.src = itemUrl;
        img.alt = item.name || "Вложение";
        button.append(img);
        button.addEventListener("click", () => openImageViewer(itemUrl, item.name || "Вложение"));
        list.append(button);
      } else if (item.type === "audio") {
        const audio = create("audio", "attachment-audio");
        audio.controls = true;
        audio.preload = "metadata";
        const source = create("source");
        source.src = itemUrl;
        source.type = item.mimeType || mimeTypeFromUrl(itemUrl);
        audio.append(source);
        const link = create("a", "attachment-download", "Скачать файл");
        link.href = itemUrl;
        link.target = "_blank";
        link.rel = "noopener";
        list.append(audio, link);
      }
    });
    parent.append(list);
  }

  async function prepareAppealImageFile(file) {
    if (!file?.type?.startsWith("image/")) throw new Error("В обращении можно прикреплять только изображения.");
    if (file.type === "image/gif" && file.size <= MAX_APPEAL_ATTACHMENT_BYTES) return file;
    if (file.size <= TARGET_APPEAL_IMAGE_BYTES) return file;

    try {
      const image = await loadImageFromFile(file);
      const longestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
      const scale = Math.min(1, MAX_APPEAL_IMAGE_SIDE / Math.max(1, longestSide));
      const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
      const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Не удалось подготовить фото.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      const originalName = String(file.name || "photo").replace(/\.[^.]+$/, "");
      for (const quality of [0.82, 0.74, 0.66, 0.58, 0.5]) {
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        if (blob.size <= MAX_APPEAL_ATTACHMENT_BYTES) {
          return blobToNamedFile(blob, `${originalName || "photo"}.jpg`);
        }
      }
      if (file.size <= MAX_APPEAL_ATTACHMENT_BYTES) return file;
    } catch {
      if (file.size <= MAX_APPEAL_ATTACHMENT_BYTES) return file;
    }

    throw new Error("Фото слишком большое. Выберите изображение до 5 МБ или отправьте более лёгкую копию.");
  }

  function fileToAttachment(file) {
    return readFileAsDataUrl(file).then((data) => ({
      data,
      name: file.name,
      mimeType: file.type,
      size: file.size
    }));
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Не удалось подготовить фото."));
      };
      image.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Не удалось сжать фото."));
      }, type, quality);
    });
  }

  function blobToNamedFile(blob, name) {
    try {
      return new File([blob], name, { type: blob.type || "image/jpeg", lastModified: Date.now() });
    } catch {
      blob.name = name;
      return blob;
    }
  }

  function mimeTypeFromUrl(url) {
    const clean = String(url || "").split("?")[0].toLowerCase();
    if (clean.endsWith(".m4a") || clean.endsWith(".mp4")) return "audio/mp4";
    if (clean.endsWith(".ogg")) return "audio/ogg";
    if (clean.endsWith(".mp3")) return "audio/mpeg";
    if (clean.endsWith(".wav")) return "audio/wav";
    return "audio/webm";
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
      reader.readAsDataURL(file);
    });
  }

  function formatFileSize(value) {
    const size = Number(value || 0);
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`;
    return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function pressFeedback(event) {
    if (event.button !== 0) return;
    const source = event.target instanceof Element ? event.target : null;
    const target = source?.closest("button, .route-card, .stop-item, .live-bus-card");
    if (!target || target.disabled) return;

    clearPressFeedback();
    const delay = event.pointerType === "touch" ? TOUCH_PRESS_DELAY : 0;
    activePress = {
      target,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: null
    };

    const showPress = () => {
      if (activePress?.target === target) target.classList.add("is-pressing");
    };

    if (delay) {
      activePress.timer = window.setTimeout(showPress, delay);
    } else {
      showPress();
    }
  }

  function cancelPressOnMove(event) {
    if (!activePress || event.pointerId !== activePress.pointerId) return;
    const dx = event.clientX - activePress.startX;
    const dy = event.clientY - activePress.startY;
    if (Math.hypot(dx, dy) > PRESS_MOVE_LIMIT) clearPressFeedback();
  }

  function clearPressFeedback(event) {
    if (event?.pointerId && activePress && event.pointerId !== activePress.pointerId) return;
    if (!activePress) return;
    if (activePress.timer) window.clearTimeout(activePress.timer);
    activePress.target.classList.remove("is-pressing");
    activePress = null;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setTheme(theme) {
    theme = "comfort";
    const root = document.documentElement;
    const palette = themePalette();
    root.classList.add("is-switching-theme");
    root.dataset.theme = theme;
    document.body.dataset.theme = theme;
    root.classList.remove("is-dark");
    root.classList.add("is-comfort");
    document.body.classList.remove("is-dark");
    document.body.classList.add("is-comfort");
    root.style.colorScheme = "light";
    root.style.setProperty("--app-theme-bg", palette.bg);
    root.style.setProperty("--app-theme-surface", palette.surface);
    root.style.setProperty("--app-theme-text", palette.text);
    root.style.setProperty("--app-theme-muted", palette.muted);
    root.style.setProperty("--app-theme-accent", palette.accent);
    root.style.setProperty("--app-theme-accent-text", palette.accentText);
    const clearThemeSwitching = () => root.classList.remove("is-switching-theme");
    window.requestAnimationFrame?.(() => window.requestAnimationFrame?.(clearThemeSwitching));
    window.setTimeout(clearThemeSwitching, 160);
    if (tg?.setHeaderColor) tg.setHeaderColor(palette.themeColor);
    if (tg?.setBackgroundColor) tg.setBackgroundColor(palette.themeColor);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette.themeColor);
    syncThemeLogos("comfort");
    els.themeToggle?.remove();
  }

  function readTheme() {
    safeStorage.removeItem("theme");
    return "comfort";
  }

  function safeThemeColor(value, fallback) {
    const color = typeof value === "string" ? value.trim() : "";
    return /^(#[0-9a-f]{3,8}|rgba?\([^)]+\))$/i.test(color) ? color : fallback;
  }

  function themePalette() {
    // Single source of truth = tokens.css. Read the PRIMITIVE tokens (literal
    // hexes) from the computed root so the inline --app-theme-* values that the
    // schedule/legacy layers consume can never drift from the design system.
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
    const token = (name, fallback) => safeThemeColor(cs ? cs.getPropertyValue(name) : "", fallback);
    return {
      bg: token("--sand-200", "#f1ece2"),
      surface: token("--sand-50", "#fffefa"),
      text: token("--ink-900", "#1f2621"),
      muted: token("--ink-500", "#5c6660"),
      accent: token("--teal-600", "#0f766e"),
      accentText: "#ffffff",
      themeColor: token("--sand-200", "#f1ece2")
    };
  }

  function syncThemeLogos(theme) {
    document.querySelectorAll("[data-theme-logo]").forEach((image) => {
      const src = image.dataset.src || "";
      if (src && image.getAttribute("src") !== src) {
        image.src = src;
      }
    });
  }

  function readClientId() {
    try {
      const existing = safeStorage.getItem(CLIENT_ID_KEY);
      if (existing) return existing;
      const id = window.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      safeStorage.setItem(CLIENT_ID_KEY, id);
      return id;
    } catch {
      return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  function readActiveAppeal() {
    try {
      return JSON.parse(safeStorage.getItem("activeAppeal") || "null");
    } catch {
      return null;
    }
  }

  function readFavorites() {
    try {
      const parsed = JSON.parse(safeStorage.getItem("routeFavorites") || "[]");
      if (!Array.isArray(parsed)) return [];
      // Drop corrupt entries (null / wrong shape): one bad element used to crash
      // the whole favorites render every session until storage was cleared.
      return parsed.filter((item) => item && typeof item === "object" && typeof item.id === "string");
    } catch {
      return [];
    }
  }

  function readAlarmStates() {
    try {
      const parsed = JSON.parse(safeStorage.getItem(ALARM_STATE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      // One-time alarms fire once server-side; locally they used to stay "on"
      // forever. Drop entries whose departure day (saved date) has passed.
      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      let changed = false;
      for (const [key, item] of Object.entries(parsed)) {
        if (!item || typeof item !== "object") {
          delete parsed[key];
          changed = true;
          continue;
        }
        const savedAt = Date.parse(item.savedAt || "");
        if ((item.repeatMode || "once") === "once" && Number.isFinite(savedAt) && now - savedAt > dayMs) {
          delete parsed[key];
          changed = true;
        }
      }
      if (changed) safeStorage.setItem(ALARM_STATE_KEY, JSON.stringify(parsed));
      return parsed;
    } catch {
      return {};
    }
  }

  function writeAlarmStates() {
    safeStorage.setItem(ALARM_STATE_KEY, JSON.stringify(state.alarms || {}));
    updateTopbarBell();
  }

  // Bell in the top bar: badge counts active alarms, tap opens Favorites.
  function updateTopbarBell() {
    const bell = document.querySelector("#topbarBell");
    const badge = document.querySelector("#topbarBellBadge");
    if (!bell || !badge) return;
    bell.hidden = false;
    const count = Object.keys(state.alarms || {}).length;
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? "9+" : String(count);
  }

  function readAppealDraft() {
    try {
      const parsed = JSON.parse(safeStorage.getItem(APPEAL_DRAFT_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return null;
      return {
        category: String(parsed.category || "Обращение"),
        text: String(parsed.text || "")
      };
    } catch {
      return null;
    }
  }

  function readViewedNews() {
    try {
      const parsed = JSON.parse(safeStorage.getItem(NEWS_VIEWED_KEY) || "[]");
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  }

  function writeViewedNews(value) {
    safeStorage.setItem(NEWS_VIEWED_KEY, JSON.stringify([...value].slice(-300)));
  }

  function readLikedNews() {
    try {
      const parsed = JSON.parse(safeStorage.getItem(NEWS_LIKED_KEY) || "[]");
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  }

  function writeLikedNews(value) {
    safeStorage.setItem(NEWS_LIKED_KEY, JSON.stringify([...value].slice(-300)));
  }

  function readPendingNewsLikeSync() {
    try {
      const parsed = JSON.parse(safeStorage.getItem(NEWS_LIKE_SYNC_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writePendingNewsLikeSync(value) {
    safeStorage.setItem(NEWS_LIKE_SYNC_KEY, JSON.stringify(value || {}));
  }

  function createSafeStorage() {
    try {
      const storage = window.localStorage;
      const key = "__bar_bus_storage_test__";
      storage.setItem(key, "1");
      storage.removeItem(key);
      return storage;
    } catch {
      const memory = new Map();
      return {
        getItem(key) {
          return memory.has(key) ? memory.get(key) : null;
        },
        setItem(key, value) {
          memory.set(key, String(value));
        },
        removeItem(key) {
          memory.delete(key);
        }
      };
    }
  }

  function hideLoader() {
    const loader = document.querySelector("#appLoader");
    if (!loader) return;
    loader.classList.add("is-hidden");
    window.setTimeout(() => loader.remove(), 260);
  }

  function renderError(message) {
    const text = message || "Не удалось загрузить данные.";
    if (els.nextPanel) {
      clear(els.nextPanel);
      els.nextPanel.append(create("div", "empty-state", text));
    }
    document.querySelectorAll(".app-error-state").forEach((node) => node.remove());
    if (state.activeView === "schedule") return;
    const activeView = document.querySelector(".view.is-active") || document.querySelector(".main-content");
    if (!activeView) return;
    const errorNode = document.createElement("div");
    errorNode.className = "empty-state app-error-state";
    errorNode.setAttribute("role", "alert");
    errorNode.textContent = text;
    activeView.prepend(errorNode);
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function minutesFromTime(time) {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function minutesFromDate(date) {
    const parts = scheduleDateParts(date);
    return parts.hour * 60 + parts.minute;
  }

  function nextDiff(minutes, now) {
    return minutes >= now ? minutes - now : minutes + 24 * 60 - now;
  }

  function formatMinutes(value) {
    if (value === 0) return "сейчас";
    if (value < 60) return `через ${value} мин`;
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return minutes ? `через ${hours} ч ${minutes} мин` : `через ${hours} ч`;
  }

  function nextDepartureLabel(departure) {
    if (!departure) return "рейсов нет";
    if (state.dayMode !== "today") return "по расписанию";
    const diff = Number.isFinite(Number(departure.diff)) ? Number(departure.diff) : Number(departure.minutes);
    return formatMinutes(Math.max(0, diff));
  }

  function departurePanelLabel(departure) {
    if (!departure) return "рейсов нет";
    if (state.dayMode !== "today") return "по расписанию";
    const now = minutesFromDate(new Date());
    if (departureIsActiveNow(departure, now)) return "на линии";
    const minutes = relativeDepartureMinutes(departure, now);
    if (minutes < now) return "рейс прошел";
    return formatMinutes(minutes - now);
  }

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("ru-BY", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(value));
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ru-BY").format(value || 0);
  }

  function formatChatTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("ru-BY", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function normalize(value) {
    return String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
  }

  // ── Мост для экрана карты (map-screen.js) ──────────────────────────────────
  // Карта живёт в отдельном модуле и общается с приложением через этот
  // минимальный интерфейс: навигация, контекст расписания, тосты и заголовки
  // Telegram-авторизации. Отдельного входа нет — используется initData.
  window.BarBusApp = {
    setView(view, options) {
      setView(view, options);
    },
    openRouteById(routeId) {
      const route = (state.data?.routes || []).find((item) => item.id === routeId);
      if (route) openRoute(route);
      return Boolean(route);
    },
    getScheduleContext() {
      const route = activeRoute();
      const direction = activeDirection();
      const stop = activeStop();
      return {
        routeId: route?.id || "",
        routeNumber: route?.number || "",
        routeName: route?.name || "",
        directionCode: direction?.code || "",
        stopUid: stop?.id || "",
        stopName: stop?.name || "",
        transportType: state.transportType
      };
    },
    telegramHeaders,
    hasTelegram: () => Boolean(tg?.initData),
    showToast
  };
})();



