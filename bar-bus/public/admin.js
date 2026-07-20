(function () {
  const tg = window.Telegram?.WebApp;

  function createMemoryStorage() {
    const values = new Map();
    return {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        values.set(key, String(value));
      },
      removeItem(key) {
        values.delete(key);
      }
    };
  }

  function getSafeStorage(name) {
    try {
      const storage = window[name];
      const testKey = "__barbus_admin_storage_test__";
      storage.setItem(testKey, "1");
      storage.removeItem(testKey);
      return storage;
    } catch {
      return createMemoryStorage();
    }
  }

  const safeSessionStorage = getSafeStorage("sessionStorage");
  const safeLocalStorage = getSafeStorage("localStorage");
  const ADMIN_THEME_KEY = "adminTheme";
  const LOCAL_TELEGRAM_INIT_DATA_KEY = "adminTelegramInitData";

  const STATUS_LABELS = {
    new: "Открыто",
    in_progress: "Открыто",
    closed: "Закрыто",
    active: "Активна",
    paused: "Пауза",
    draft: "Черновик",
    archived: "Архив",
    published: "Опубликовано",
    parsed: "Загружено",
    needs_review: "С предупреждениями",
    blocked: "С предупреждениями",
    sent: "Отправлено"
  };

  const tabPermissions = {
    appeals: "appeals",
    schedule: "schedule",
    roster: "roster",
    ads: "ads",
    services: "services",
    notifications: "notifications",
    admins: "admins",
    about: "about",
    visits: "visits"
  };
  const hiddenAdminTabs = new Set(["ads", "appeals"]);
  const els = {
    loginPanel: document.querySelector("#loginPanel"),
    summaryPanel: document.querySelector("#summaryPanel"),
    actionsPanel: document.querySelector("#actionsPanel"),
    adminTabs: document.querySelector("#adminTabs"),
    adminPanels: document.querySelector("#adminPanels"),
    adminKey: document.querySelector("#adminKey"),
    adminRole: document.querySelector("#adminRole"),
    saveKey: document.querySelector("#saveKey"),
    resetKey: document.querySelector("#resetKey"),
    refreshAll: document.querySelector("#refreshAll"),
    appealFilter: document.querySelector("#appealFilter"),
    adminChat: document.querySelector("#adminChat"),
    adminChatTitle: document.querySelector("#adminChatTitle"),
    adminChatMeta: document.querySelector("#adminChatMeta"),
    adminChatThread: document.querySelector("#adminChatThread"),
    adminChatForm: document.querySelector("#adminChatForm"),
    closeChatButton: document.querySelector("#closeChatButton"),
    routesCount: document.querySelector("#routesCount"),
    departuresCount: document.querySelector("#departuresCount"),
    subscribersCount: document.querySelector("#subscribersCount"),
    subscribersDelta: document.querySelector("#subscribersDelta"),
    visitsTodayCount: document.querySelector("#visitsTodayCount"),
    visitsWeekCount: document.querySelector("#visitsWeekCount"),
    visitsMonthCount: document.querySelector("#visitsMonthCount"),
    appealsList: document.querySelector("#appealsList"),
    clearAppeals: document.querySelector("#clearAppeals"),
    adForm: document.querySelector("#adForm"),
    adsList: document.querySelector("#adsList"),
    serviceForm: document.querySelector("#serviceForm"),
    clearServiceForm: document.querySelector("#clearServiceForm"),
    servicesList: document.querySelector("#servicesList"),
    notificationForm: document.querySelector("#notificationForm"),
    clearNotificationForm: document.querySelector("#clearNotificationForm"),
    clearNotifications: document.querySelector("#clearNotifications"),
    notificationsList: document.querySelector("#notificationsList"),
    adminForm: document.querySelector("#adminForm"),
    adminSearch: document.querySelector("#adminSearch"),
    adminsList: document.querySelector("#adminsList"),
    leadershipForm: document.querySelector("#leadershipForm"),
    clearLeadershipForm: document.querySelector("#clearLeadershipForm"),
    leadershipList: document.querySelector("#leadershipList"),
    scheduleEditorTransportType: document.querySelector("#scheduleEditorTransportType"),
    scheduleRouteSelect: document.querySelector("#scheduleRouteSelect"),
    scheduleDirectionSelect: document.querySelector("#scheduleDirectionSelect"),
    scheduleStopSelect: document.querySelector("#scheduleStopSelect"),
    scheduleImportRoute: document.querySelector("#scheduleImportRoute"),
    scheduleImportForm: document.querySelector("#scheduleImportForm"),
    importScheduleFromTelegram: document.querySelector("#importScheduleFromTelegram"),
    clearScheduleImport: document.querySelector("#clearScheduleImport"),
    scheduleImportResult: document.querySelector("#scheduleImportResult"),
    refreshScheduledImports: document.querySelector("#refreshScheduledImports"),
    scheduledImportList: document.querySelector("#scheduledImportList"),
    refreshScheduleBackups: document.querySelector("#refreshScheduleBackups"),
    scheduleBackupList: document.querySelector("#scheduleBackupList"),
    scheduleRouteName: document.querySelector("#scheduleRouteName"),
    scheduleOrigin: document.querySelector("#scheduleOrigin"),
    scheduleDestination: document.querySelector("#scheduleDestination"),
    scheduleStopName: document.querySelector("#scheduleStopName"),
    scheduleColor: document.querySelector("#scheduleColor"),
    saveScheduleMeta: document.querySelector("#saveScheduleMeta"),
    scheduleTimeForm: document.querySelector("#scheduleTimeForm"),
    scheduleTimeMode: document.querySelector("#scheduleTimeMode"),
    saveScheduleTimeButton: document.querySelector("#saveScheduleTimeButton"),
    clearScheduleTime: document.querySelector("#clearScheduleTime"),
    scheduleTimeList: document.querySelector("#scheduleTimeList"),
    refreshScheduleAudit: document.querySelector("#refreshScheduleAudit"),
    clearScheduleAudit: document.querySelector("#clearScheduleAudit"),
    scheduleAuditList: document.querySelector("#scheduleAuditList"),
    rosterDriverForm: document.querySelector("#rosterDriverForm"),
    clearRosterDriverForm: document.querySelector("#clearRosterDriverForm"),
    rosterDriversList: document.querySelector("#rosterDriversList"),
    rosterUploadForm: document.querySelector("#rosterUploadForm"),
    uploadRosterFromTelegram: document.querySelector("#uploadRosterFromTelegram"),
    rosterPreview: document.querySelector("#rosterPreview"),
    refreshRosterUploads: document.querySelector("#refreshRosterUploads"),
    clearRosterUploads: document.querySelector("#clearRosterUploads"),
    rosterUploadsList: document.querySelector("#rosterUploadsList"),
    adminStatus: document.querySelector("#adminStatus"),
    themeToggle: document.querySelector("#adminThemeToggle"),
    themeIcon: document.querySelector("#adminThemeIcon")
  };

  const state = {
    key: safeSessionStorage.getItem("adminKey") || "",
    role: safeSessionStorage.getItem("adminRole") || "admin",
    permissions: [],
    activeTab: "schedule",
    appeals: [],
    routes: [],
    scheduleDepartures: [],
    services: [],
    visitStats: null,
    rosterUploads: [],
    rosterDrivers: [],
    admins: [],
    activeAppeal: null,
    chatTimer: null,
    chatLoading: "",
    chatRequestSeq: 0,
    lastChatSignature: "",
    roleLabels: {},
    leadershipContacts: [],
    scheduleTransportType: "city"
  };

  boot();

  function boot() {
    tg?.ready?.();
    tg?.expand?.();
    setTheme(readTheme());
    installAdminActionFeedback();

    els.adminKey.value = state.key;
    els.adminRole.value = state.role;

    els.themeToggle?.remove();
    els.saveKey.addEventListener("click", saveAccess);
    els.resetKey.addEventListener("click", resetAccess);
    els.refreshAll.addEventListener("click", () => withButtonAction(els.refreshAll, "Обновляем...", loadAll));
    els.appealFilter?.addEventListener("change", () => renderAppeals(state.appeals));
    els.clearAppeals?.addEventListener("click", clearAppeals);
    els.scheduleImportForm.addEventListener("submit", importScheduleXml);
    els.importScheduleFromTelegram?.addEventListener("click", importScheduleXmlFromTelegram);
    els.clearScheduleImport.addEventListener("click", clearScheduleImportForm);
    els.scheduleImportForm.elements.xmlFiles?.addEventListener("change", () => {
      const files = [...(els.scheduleImportForm.elements.xmlFiles.files || [])];
      if (files.length) setStatus(`Выбрано XML-файлов: ${files.length}. ${describeSelectedFiles(files)}`, "success");
    });
    els.refreshScheduledImports?.addEventListener("click", (event) => loadScheduledImports({ button: event.currentTarget, announce: true }));
    els.refreshScheduleBackups.addEventListener("click", refreshScheduleBackupsManual);
    els.scheduleEditorTransportType?.addEventListener("change", () => {
      state.scheduleTransportType = els.scheduleEditorTransportType.value || "city";
      renderScheduleRouteSelect();
      onScheduleRouteChange().catch((error) => setStatus(error.message, "error"));
    });
    els.scheduleImportForm.elements.transportType?.addEventListener("change", () => {
      renderScheduleRouteSelect({ routeId: els.scheduleRouteSelect.value });
    });
    els.scheduleRouteSelect.addEventListener("change", () => onScheduleRouteChange().catch((error) => setStatus(error.message, "error")));
    els.scheduleDirectionSelect.addEventListener("change", () => onScheduleDirectionChange().catch((error) => setStatus(error.message, "error")));
    els.scheduleStopSelect.addEventListener("change", () => onScheduleStopChange().catch((error) => setStatus(error.message, "error")));
    els.saveScheduleMeta.addEventListener("click", saveScheduleMeta);
    els.scheduleTimeForm.addEventListener("submit", saveScheduleTime);
    els.scheduleTimeForm.elements.dayMask.addEventListener("change", renderScheduleDepartures);
    els.clearScheduleTime.addEventListener("click", clearScheduleTimeForm);
    els.refreshScheduleAudit.addEventListener("click", (event) => loadScheduleAudit({ button: event.currentTarget, announce: true }));
    els.clearScheduleAudit.addEventListener("click", clearScheduleAudit);
    els.rosterDriverForm?.addEventListener("submit", saveRosterDriver);
    els.clearRosterDriverForm?.addEventListener("click", clearRosterDriverForm);
    els.rosterUploadForm?.addEventListener("submit", uploadDutyRoster);
    els.uploadRosterFromTelegram?.addEventListener("click", uploadDutyRosterFromTelegram);
    els.rosterUploadForm?.elements.csvFile?.addEventListener("change", () => {
      const file = els.rosterUploadForm.elements.csvFile.files?.[0];
      if (file) setStatus(`Файл разнарядки выбран: ${file.name || "без имени"} (${describeFileSize(file)}).`, "success");
    });
    els.refreshRosterUploads?.addEventListener("click", (event) => loadDutyRosters({ button: event.currentTarget, announce: true }));
    els.clearRosterUploads?.addEventListener("click", clearDutyRosterUploads);
    els.adForm?.addEventListener("submit", saveAd);
    els.serviceForm?.addEventListener("submit", saveService);
    els.clearServiceForm?.addEventListener("click", clearServiceForm);
    els.notificationForm.addEventListener("submit", saveNotification);
    els.clearNotificationForm.addEventListener("click", clearNotificationForm);
    els.clearNotifications.addEventListener("click", clearNotifications);
    els.adminForm.addEventListener("submit", saveAdmin);
    els.adminForm.elements.role?.addEventListener("input", syncAdminDriverSquadField);
    els.adminForm.elements.role?.addEventListener("change", syncAdminDriverSquadField);
    els.adminForm.elements.role?.addEventListener("blur", syncAdminDriverSquadField);
    els.adminSearch?.addEventListener("input", () => renderAdmins(state.admins, { scrollToMatch: true }));
    els.leadershipForm?.addEventListener("submit", saveLeadershipContact);
    els.clearLeadershipForm?.addEventListener("click", clearLeadershipForm);
    els.adminChatForm?.addEventListener("submit", sendAdminChatMessage);
    els.closeChatButton?.addEventListener("click", closeActiveChat);
    document.querySelectorAll("[data-admin-tab]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        setTab(button.dataset.adminTab, { source: "tabs" });
      });
    });

    syncAdminDriverSquadField();
    if (state.key || getTelegramInitData()) openPanel();
  }

  function isLocalAdminHost() {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
  }

  function getTelegramInitData() {
    if (tg?.initData) return tg.initData;
    if (!isLocalAdminHost()) return "";
    return safeSessionStorage.getItem(LOCAL_TELEGRAM_INIT_DATA_KEY) || "";
  }

  function installAdminActionFeedback() {
    document.addEventListener("pointerdown", (event) => {
      const button = event.target.closest("button");
      if (!button || button.disabled || !button.closest(".admin-shell")) return;
      pulseActionButton(button);
    }, true);
  }

  function pulseActionButton(button) {
    if (!button) return;
    button.classList.remove("is-pressed");
    void button.offsetWidth;
    button.classList.add("is-pressed");
    window.setTimeout(() => button.classList.remove("is-pressed"), 180);
  }

  function startButtonAction(button, busyText) {
    if (!button) return () => {};
    pulseActionButton(button);
    const originalText = button.dataset.actionOriginalText || button.textContent.trim();
    const wasDisabled = button.disabled;
    button.dataset.actionOriginalText = originalText;
    button.dataset.actionWasDisabled = wasDisabled ? "true" : "false";
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    if (busyText) button.textContent = busyText;

    return () => {
      button.disabled = button.dataset.actionWasDisabled === "true";
      button.classList.remove("is-loading", "is-pressed");
      button.removeAttribute("aria-busy");
      button.textContent = button.dataset.actionOriginalText || originalText;
      delete button.dataset.actionOriginalText;
      delete button.dataset.actionWasDisabled;
    };
  }

  async function withButtonAction(button, busyText, action) {
    const finishButtonAction = startButtonAction(button, busyText);
    try {
      return await action();
    } finally {
      finishButtonAction();
    }
  }

  function saveAccess() {
    state.key = els.adminKey.value.trim();
    state.role = els.adminRole.value;
    safeSessionStorage.setItem("adminKey", state.key);
    safeSessionStorage.setItem("adminRole", state.role);
    openPanel();
  }

  function resetAccess() {
    stopAdminChatPolling();
    state.activeAppeal = null;
    state.lastChatSignature = "";
    els.adminChat.hidden = true;
    clear(els.adminChatThread);
    state.key = "";
    state.role = "admin";
    els.adminKey.value = "";
    els.adminRole.value = state.role;
    safeSessionStorage.removeItem("adminKey");
    safeSessionStorage.removeItem("adminRole");
    safeSessionStorage.removeItem(LOCAL_TELEGRAM_INIT_DATA_KEY);
    showLoginPanel();
    setStatus("");
  }

  function showLoginPanel() {
    els.loginPanel.hidden = false;
    els.summaryPanel.hidden = true;
    els.actionsPanel.hidden = true;
    els.adminTabs.hidden = true;
    els.adminPanels.hidden = true;
  }

  function showAdminPanel() {
    els.loginPanel.hidden = true;
    els.summaryPanel.hidden = false;
    els.actionsPanel.hidden = false;
    els.adminTabs.hidden = false;
    els.adminPanels.hidden = false;
  }

  async function openPanel() {
    setStatus("Проверяем доступ...");
    const loaded = await loadAll();
    if (!loaded) {
      showLoginPanel();
      return;
    }
    showAdminPanel();
  }

  async function loadAll() {
    try {
      const bootstrap = await api("/api/admin/bootstrap");
      const role = bootstrap.admin.role;
      state.role = role;
      state.roleLabels = bootstrap.roles || state.roleLabels;
      state.permissions = normalizedPermissions(role, bootstrap.permissions || {});
      renderSummary(bootstrap);
      applyRoleTabs();

      await Promise.all([
        can("schedule") ? loadScheduleEditor() : Promise.resolve(),
        can("roster") ? loadDutyRosters() : Promise.resolve(),
        can("ads") && !hiddenAdminTabs.has("ads") ? loadAds() : Promise.resolve(),
        can("services") ? loadServices() : Promise.resolve(),
        can("notifications") ? loadNotifications() : Promise.resolve(),
        can("visits") ? loadVisitStats() : Promise.resolve(renderVisitStats({})),
        can("admins") ? loadAdmins() : Promise.resolve(),
        can("about") ? loadLeadershipContacts() : Promise.resolve()
      ]);
      setStatus("");
      return true;
    } catch (error) {
      setStatus(error.message, "error");
      resetLists();
      return false;
    }
  }

  function applyRoleTabs() {
    let firstVisible = "";
    document.querySelectorAll("[data-admin-tab]").forEach((button) => {
      const tab = button.dataset.adminTab;
      const visible = can(tabPermissions[tab]) && !hiddenAdminTabs.has(tab);
      button.hidden = !visible;
      if (visible && !firstVisible) firstVisible = tab;
    });

    if (!firstVisible) {
      state.activeTab = "";
      document.querySelectorAll("[data-admin-tab]").forEach((button) => button.classList.remove("is-active"));
      document.querySelectorAll("[data-admin-panel]").forEach((panel) => panel.classList.remove("is-active"));
      setStatus("Работа с обращениями перенесена в Telegram.", "success");
      return;
    }
    if (!can(tabPermissions[state.activeTab]) || hiddenAdminTabs.has(state.activeTab)) state.activeTab = firstVisible;
    updatePrivilegedControls();
    setTab(state.activeTab);
  }

  function firstAllowedTab() {
    return Object.keys(tabPermissions).find((tab) =>
      document.querySelector(`[data-admin-panel="${tab}"]`) &&
      can(tabPermissions[tab]) &&
      !hiddenAdminTabs.has(tab)
    ) || "";
  }

  function updatePrivilegedControls() {
    const isOwnerAdmin = state.role === "admin";
    [els.clearAppeals, els.clearScheduleAudit, els.clearRosterUploads, els.clearNotifications].forEach((button) => {
      if (button) button.hidden = !isOwnerAdmin;
    });
  }

  function normalizedPermissions(role, permissionsByRole) {
    const permissions = new Set(permissionsByRole[role] || []);
    if (role === "admin") {
      ["appeals", "ads", "notifications", "admins", "schedule", "about", "services", "roster", "visits"].forEach((permission) => permissions.add(permission));
    }
    return [...permissions];
  }

  function clampAdminScrollTop(value) {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return Math.min(Math.max(0, Number(value) || 0), maxScroll);
  }

  function setTab(tab, options = {}) {
    const hasPanel = !!document.querySelector(`[data-admin-panel="${tab}"]`);
    const isAllowed = hasPanel && can(tabPermissions[tab]) && !hiddenAdminTabs.has(tab);
    const nextTab = isAllowed ? tab : firstAllowedTab();
    if (!nextTab) {
      state.activeTab = "";
      document.querySelectorAll("[data-admin-tab]").forEach((button) => button.classList.remove("is-active"));
      document.querySelectorAll("[data-admin-panel]").forEach((panel) => panel.classList.remove("is-active"));
      return;
    }
    const changedTab = nextTab !== state.activeTab;
    const currentScroll = Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || 0));
    const panelsRect = els.adminPanels?.getBoundingClientRect();
    const panelsTop = els.adminPanels
      ? Math.max(0, Math.round(els.adminPanels.getBoundingClientRect().top + currentScroll - 10))
      : 0;
    const stableScroll = options.source === "tabs" ? Math.min(currentScroll, panelsTop) : currentScroll;
    const shouldRevealPanels =
      Boolean(panelsRect) &&
      (panelsRect.top < 0 || panelsRect.top > Math.max(220, window.innerHeight * 0.42));

    if (changedTab) {
      document.body.classList.add("is-admin-tab-switching");
    }

    state.activeTab = nextTab;
    if (nextTab !== "appeals") stopAdminChatPolling();
    document.querySelectorAll("[data-admin-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.adminTab === nextTab);
    });
    document.querySelectorAll("[data-admin-panel]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.adminPanel === nextTab);
    });

    if (changedTab) {
      window.requestAnimationFrame(() => {
        if (options.source === "tabs" && shouldRevealPanels) {
          window.scrollTo({ top: clampAdminScrollTop(stableScroll), left: 0, behavior: "auto" });
        }
        document.body.classList.remove("is-admin-tab-switching");
      });
    }
  }

  function renderSummary(data) {
    els.routesCount.textContent = data.stats?.routes || 0;
    els.departuresCount.textContent = formatNumber(data.stats?.departures || 0);
    els.subscribersCount.textContent = data.stats?.subscribers || 0;
    const subscribersToday = Number(data.stats?.subscribersToday || 0);
    if (els.subscribersDelta) {
      els.subscribersDelta.hidden = subscribersToday <= 0;
      els.subscribersDelta.textContent = subscribersToday > 0 ? `+${formatNumber(subscribersToday)}` : "";
      els.subscribersDelta.style.display = subscribersToday > 0 ? "" : "none";
    }
  }

  async function refreshAdminSummary() {
    const bootstrap = await api("/api/admin/bootstrap");
    renderSummary(bootstrap);
    if (can("visits")) await loadVisitStats();
  }

  async function loadVisitStats() {
    const data = await api("/api/admin/visits");
    state.visitStats = data.visits || {};
    renderVisitStats(state.visitStats);
  }

  function renderVisitStats(visits = {}) {
    if (els.visitsTodayCount) els.visitsTodayCount.textContent = formatNumber(visits.today || 0);
    if (els.visitsWeekCount) els.visitsWeekCount.textContent = formatNumber(visits.week || 0);
    if (els.visitsMonthCount) els.visitsMonthCount.textContent = formatNumber(visits.month || 0);
  }

  async function loadAppeals() {
    const data = await api("/api/admin/appeals");
    state.appeals = data.appeals || [];
    if (state.activeAppeal?.id) {
      const refreshedAppeal = state.appeals.find((appeal) => appeal.id === state.activeAppeal.id);
      if (refreshedAppeal) {
        state.activeAppeal = { ...state.activeAppeal, ...refreshedAppeal };
        syncAdminChatState();
      }
    }
    renderAppeals(state.appeals);
  }

  function renderAppeals(appeals) {
    clear(els.appealsList);
    const filter = els.appealFilter.value;
    const visibleAppeals =
      filter === "all"
        ? appeals
        : filter === "open"
          ? appeals.filter((appeal) => appeal.status !== "closed")
          : appeals.filter((appeal) => appeal.status === filter);

    if (!visibleAppeals.length) {
      els.appealsList.append(empty("Обращений пока нет."));
      return;
    }

    visibleAppeals.forEach((appeal) => {
      const card = create("article", "appeal-admin-card");
      card.classList.toggle("is-active", state.activeAppeal?.id === appeal.id);
      const top = create("div", "appeal-admin-top");
      const titleBox = create("div");
      titleBox.append(create("h2", "", `#${appeal.id}`), create("p", "muted", formatDateTime(appeal.createdAt)));
      const status = pill(appeal.status);
      top.append(titleBox, status);

      const meta = create("div", "appeal-meta");
      meta.append(create("span", "", appeal.category || "Обращение"));
      if (appeal.assignedRole) meta.append(create("span", "", roleLabel(appeal.assignedRole)));

      const actions = create("div", "status-actions");
      const chatButton = create("button", "mini-button", "Чат");
      chatButton.type = "button";
      chatButton.setAttribute("aria-pressed", state.activeAppeal?.id === appeal.id ? "true" : "false");
      chatButton.addEventListener("click", () => openAdminChat(appeal));
      actions.append(chatButton);
      const statusButton = create("button", "mini-button", appeal.status === "closed" ? "Открыть" : "Закрыть");
      statusButton.type = "button";
      statusButton.addEventListener("click", () => updateStatus(appeal.id, appeal.status === "closed" ? "new" : "closed"));
      actions.append(statusButton);

      card.append(top, meta, create("p", "appeal-text", appeal.text), actions);
      els.appealsList.append(card);
    });
  }

  async function clearAppeals() {
    if (!(await confirmAction("Удалить все обращения, которые доступны этой роли? Чаты тоже будут очищены?"))) return;
    try {
      setStatus("Очищаем обращения...");
      await api("/api/admin/appeals", { method: "DELETE" });
      stopAdminChatPolling();
      state.activeAppeal = null;
      els.adminChat.hidden = true;
      els.adminChatForm.reset();
      clear(els.adminChatThread);
      await loadAppeals();
      await refreshAdminSummary();
      setStatus("Обращения очищены.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function updateStatus(id, status) {
    try {
      setStatus("Обновляем статус...");
      const data = await api(`/api/admin/appeals/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      if (state.activeAppeal?.id === id && data.appeal) {
        state.activeAppeal = { ...state.activeAppeal, ...data.appeal };
        syncAdminChatState();
        if (state.activeAppeal.status === "closed") stopAdminChatPolling();
        else startAdminChatPolling();
      }
      await loadAppeals();
      setStatus("Статус обновлён.", "success");
      return data;
    } catch (error) {
      setStatus(error.message, "error");
      return null;
    }
  }

  async function openAdminChat(appeal) {
    try {
      state.activeAppeal = appeal;
      state.lastChatSignature = "";
      els.adminChat.hidden = false;
      els.adminChatTitle.textContent = `Чат #${appeal.id}`;
      els.adminChatMeta.textContent = [appeal.category || "Обращение", appeal.assignedRole ? roleLabel(appeal.assignedRole) : ""].filter(Boolean).join(" · ");
      renderAppeals(state.appeals);
      await loadAdminChatMessages({ force: true });
      startAdminChatPolling();
      const chatRect = els.adminChat.getBoundingClientRect();
      if (chatRect.top < 0 || chatRect.top > window.innerHeight - 140) {
        els.adminChat.scrollIntoView({ behavior: "auto", block: "nearest" });
      }
      if (state.activeAppeal?.status !== "closed") els.adminChatForm.elements.text?.focus({ preventScroll: true });
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function loadAdminChatMessages(options = {}) {
    const appealId = state.activeAppeal?.id;
    if (!appealId) return false;
    if (!options.force && state.chatLoading.startsWith(`${appealId}:`)) return false;
    const requestSeq = ++state.chatRequestSeq;
    const loadingToken = `${appealId}:${requestSeq}`;
    state.chatLoading = loadingToken;
    try {
      const data = await api(`/api/admin/appeals/${appealId}/messages`);
      if (state.activeAppeal?.id !== appealId || requestSeq !== state.chatRequestSeq) return false;
      state.activeAppeal = data.appeal || state.activeAppeal;
      renderAdminChatMessages(data.messages || []);
      syncAdminChatState();
      if (state.activeAppeal.status === "closed") stopAdminChatPolling();
      return true;
    } catch (error) {
      if (state.activeAppeal?.id !== appealId || requestSeq !== state.chatRequestSeq) return false;
      if ([401, 403, 404].includes(error.status)) {
        stopAdminChatPolling();
        setStatus(error.message, "error");
        await loadAppeals().catch(() => {});
        return false;
      }
      if (error.status === 429) {
        stopAdminChatPolling();
        setStatus("Слишком частые обновления чата. Обновите диалог чуть позже.", "error");
        return false;
      }
      if (!options.silent) setStatus(error.message, "error");
      return false;
    } finally {
      if (state.chatLoading === loadingToken) state.chatLoading = "";
    }
  }

  function renderAdminChatMessages(messages) {
    const thread = els.adminChatThread;
    const signature = messages.length
      ? messages.map((message) => [
        message.id,
        message.senderType,
        message.text || "",
        message.createdAt || "",
        (message.attachments || []).map((item) => item.id || item.url || item.name || "").join(",")
      ].join("|")).join("~")
      : "empty";
    if (signature === state.lastChatSignature) return;

    const bottomDistance = Math.max(0, thread.scrollHeight - thread.scrollTop - thread.clientHeight);
    const wasNearBottom = bottomDistance < 96;
    clear(thread);
    state.lastChatSignature = signature;
    if (!messages.length) {
      els.adminChatThread.append(empty("Сообщений пока нет."));
      return;
    }

    messages.forEach((message) => {
      const item = create("article", `chat-message ${message.senderType === "admin" ? "is-admin" : "is-client"}`);
      if (message.text) item.append(create("p", "", message.text));
      appendAttachments(item, message.attachments || []);
      item.append(create("span", "", `${message.actorName || message.senderType} · ${formatDateTime(message.createdAt)}`));
      thread.append(item);
    });
    if (wasNearBottom) {
      thread.scrollTop = thread.scrollHeight;
    } else {
      thread.scrollTop = Math.max(0, thread.scrollHeight - thread.clientHeight - bottomDistance);
    }
  }

  function syncAdminChatState() {
    const isClosed = state.activeAppeal?.status === "closed";
    els.adminChat.dataset.status = isClosed ? "closed" : "open";
    els.adminChatForm.hidden = isClosed;
    els.closeChatButton.disabled = isClosed;
  }

  async function sendAdminChatMessage(event) {
    event.preventDefault();
    if (!state.activeAppeal?.id) return;
    const input = els.adminChatForm.elements.text;
    const button = els.adminChatForm.querySelector("button[type='submit']");
    const text = input.value.trim();
    if (!text) return;

    input.disabled = true;
    if (button) button.disabled = true;
    try {
      await api(`/api/admin/appeals/${state.activeAppeal.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text })
      });
      input.value = "";
      state.lastChatSignature = "";
      await loadAdminChatMessages({ force: true });
      setStatus("Ответ отправлен.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      input.disabled = false;
      if (button) button.disabled = false;
      input.focus();
    }
  }

  async function closeActiveChat() {
    if (!state.activeAppeal?.id) return;
    const result = await updateStatus(state.activeAppeal.id, "closed");
    if (!result) return;
    await loadAdminChatMessages({ force: true });
  }

  function startAdminChatPolling() {
    stopAdminChatPolling();
    if (state.activeAppeal?.status === "closed") return;
    state.chatTimer = setInterval(() => loadAdminChatMessages({ silent: true }), 6000);
  }

  function stopAdminChatPolling() {
    if (!state.chatTimer) return;
    clearInterval(state.chatTimer);
    state.chatTimer = null;
  }

  async function loadScheduleEditor() {
    await refreshScheduleWorkspace();
  }

  async function refreshScheduleWorkspace(options = {}) {
    const previous = {
      routeId: options.routeId || els.scheduleRouteSelect.value || "",
      directionCode: options.directionCode || els.scheduleDirectionSelect.value || "",
      stopUid: options.stopUid || els.scheduleStopSelect.value || ""
    };
    const data = await api("/api/admin/schedule/routes");
    state.routes = data.routes || [];
    renderScheduleRouteSelect(previous);
    await onScheduleRouteChange(previous);
    await Promise.all([
      loadScheduleAudit(),
      loadScheduledImports(),
      loadScheduleBackups()
    ]);
  }

  // Sends a schedule import and, if the server refuses a destructive full replace
  // (it would delete more routes than the upload contains), asks for an explicit
  // confirmation and retries with confirmFullReplace.
  async function postScheduleImport(endpoint, payload) {
    try {
      return await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      if (error?.data?.code === "FULL_REPLACE_CONFIRMATION_REQUIRED") {
        const details = error.data.details || {};
        const question = `${error.message}\n\nУдалить ${details.existingCount ?? "все"} маршрутов и загрузить ${details.importedCount ?? "новые"}? Действие необратимо.`;
        if (!(await confirmAction(question))) {
          const cancelled = new Error("Полная замена расписания отменена.");
          cancelled.handled = true;
          throw cancelled;
        }
        return await api(endpoint, { method: "POST", body: JSON.stringify({ ...payload, confirmFullReplace: true }) });
      }
      throw error;
    }
  }

  async function importScheduleXml(event) {
    event.preventDefault();
    const button = event.submitter || els.scheduleImportForm.querySelector("button[type='submit']");
    pulseActionButton(button);
    const input = els.scheduleImportForm.elements.xmlFiles;
    const files = [...(input.files || [])];
    const confirmed = els.scheduleImportForm.elements.confirmReplace.checked;
    const mode = els.scheduleImportForm.elements.mode.value || "upsert";
    const transportType = els.scheduleImportForm.elements.transportType?.value || "";
    const effectiveAt = els.scheduleImportForm.elements.effectiveAt?.value || "";
    const targetRoute = selectedScheduleImportRoute();
    const isScheduled = effectiveAt && new Date(effectiveAt).getTime() > Date.now();

    if (!files.length) {
      setStatus("Выберите XML-файлы расписания.", "error");
      return;
    }
    if (!confirmed) {
      setStatus("Подтвердите замену текущего расписания.", "error");
      return;
    }
    if (isScheduled && !targetRoute) {
      setStatus("Для отложенной замены выберите конкретный маршрут.", "error");
      return;
    }
    if (isScheduled && mode === "replace_all") {
      setStatus("Отложенная загрузка должна менять один выбранный маршрут, а не всё расписание.", "error");
      return;
    }

    const finishButtonAction = startButtonAction(button, isScheduled ? "Планируем..." : "Загружаем...");
    clear(els.scheduleImportResult);

    try {
      setStatus(isScheduled ? "Проверяем XML-файл и планируем замену..." : "Читаем XML-файлы и обновляем расписание...");
      const payloadFiles = [];
      for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file, { required: true, typeLabel: "XML-файл расписания" });
        payloadFiles.push({
          name: file.name,
          size: dataUrlByteLength(dataUrl),
          dataUrl
        });
      }

      const result = await postScheduleImport("/api/admin/schedule/import", {
        confirmReplace: confirmed,
        mode,
        transportType,
        routeId: targetRoute?.id || "",
        routeNumber: targetRoute?.number || "",
        effectiveAt,
        files: payloadFiles
      });

      renderScheduleImportResult(result);
      clearScheduleImportForm({ keepResult: true });
      if (!result.scheduled) {
        await refreshAdminSummary();
        await refreshScheduleWorkspace({
          routeId: targetRoute?.id || els.scheduleRouteSelect.value || ""
        });
      } else {
        await Promise.all([loadScheduledImports(), loadScheduleBackups(), loadScheduleAudit()]);
      }
      setStatus(result.scheduled ? "Отложенная замена маршрута сохранена." : "XML-расписание загружено и применено.", "success");
    } catch (error) {
      setStatus(error.message, error.handled ? "warning" : "error");
    } finally {
      finishButtonAction();
    }
  }

  async function importScheduleXmlFromTelegram() {
    const confirmed = els.scheduleImportForm.elements.confirmReplace.checked;
    const mode = els.scheduleImportForm.elements.mode.value || "upsert";
    const transportType = els.scheduleImportForm.elements.transportType?.value || "";
    const effectiveAt = els.scheduleImportForm.elements.effectiveAt?.value || "";
    const targetRoute = selectedScheduleImportRoute();
    const isScheduled = effectiveAt && new Date(effectiveAt).getTime() > Date.now();

    if (!confirmed) {
      setStatus("Подтвердите замену текущего расписания.", "error");
      return;
    }
    if (isScheduled && !targetRoute) {
      setStatus("Для отложенной замены выберите конкретный маршрут.", "error");
      return;
    }
    if (isScheduled && mode === "replace_all") {
      setStatus("Отложенная загрузка должна менять один выбранный маршрут, а не всё расписание.", "error");
      return;
    }

    const button = els.importScheduleFromTelegram;
    const finishButtonAction = startButtonAction(button, "Берём из Telegram...");
    clear(els.scheduleImportResult);

    try {
      setStatus("Берём последний XML, отправленный боту...");
      const result = await postScheduleImport("/api/admin/schedule/import-telegram", {
        confirmReplace: confirmed,
        mode,
        transportType,
        routeId: targetRoute?.id || "",
        routeNumber: targetRoute?.number || "",
        effectiveAt
      });

      renderScheduleImportResult(result);
      clearScheduleImportForm({ keepResult: true });
      if (!result.scheduled) {
        await refreshAdminSummary();
        await refreshScheduleWorkspace({
          routeId: targetRoute?.id || els.scheduleRouteSelect.value || ""
        });
      } else {
        await Promise.all([loadScheduledImports(), loadScheduleBackups(), loadScheduleAudit()]);
      }
      const names = (result.telegramFiles || []).map((item) => item.fileName).filter(Boolean).join(", ");
      setStatus(result.scheduled ? `XML из Telegram запланирован${names ? `: ${names}` : ""}.` : `XML из Telegram применён${names ? `: ${names}` : ""}.`, "success");
    } catch (error) {
      setStatus(error.message, error.handled ? "warning" : "error");
    } finally {
      finishButtonAction();
    }
  }

  function renderScheduleImportResult(result) {
    clear(els.scheduleImportResult);
    const box = create("div", "import-result-card");
    if (result.scheduled) {
      const scheduled = result.scheduledImport || {};
      box.append(
        create("strong", "", "Замена маршрута запланирована"),
        create("span", "", `Маршрут ${scheduled.routeNumber || ""}`),
        create("span", "", `Старт: ${formatDateTime(scheduled.effectiveAt)}`),
        create("span", "", `Файлов: ${formatNumber(scheduled.fileCount || result.preview?.files?.length || 0)}`)
      );
      els.scheduleImportResult.append(box);
      return;
    }

    box.append(
      create("strong", "", "Расписание обновлено"),
      create("span", "", `Файлов: ${formatNumber(result.files || 0)}`),
      create("span", "", `Обновлено маршрутов: ${formatNumber(result.importedRoutes || result.routes || 0)}`),
      create("span", "", `Всего маршрутов: ${formatNumber(result.routes || 0)}`),
      create("span", "", `Всего отправлений: ${formatNumber(result.departures || 0)}`),
      create("span", "", `Будни: ${formatNumber(result.daySummary?.weekdays || 0)}`),
      create("span", "", `Выходные: ${formatNumber(result.daySummary?.weekends || 0)}`),
      create("span", "", `Пн-Вс: ${formatNumber(result.daySummary?.everyday || 0)}`)
    );
    els.scheduleImportResult.append(box);
  }

  function clearScheduleImportForm(options = {}) {
    els.scheduleImportForm.reset();
    if (!options.keepResult) clear(els.scheduleImportResult);
  }

  async function loadScheduledImports(options = {}) {
    if (!els.scheduledImportList) return;
    const finishButtonAction = options.button ? startButtonAction(options.button, "Обновляем...") : () => {};
    try {
      if (options.announce) setStatus("Обновляем запланированные замены...");
      const data = await api("/api/admin/schedule/scheduled-imports?limit=30");
      renderScheduledImports(data.imports || []);
      if (options.announce) setStatus("Запланированные замены обновлены.", "success");
    } catch (error) {
      clear(els.scheduledImportList);
      els.scheduledImportList.append(empty(error.message));
      if (options.announce) setStatus(error.message, "error");
    } finally {
      finishButtonAction();
    }
  }

  function renderScheduledImports(imports) {
    clear(els.scheduledImportList);
    if (!imports.length) {
      els.scheduledImportList.append(empty("Отложенных замен пока нет."));
      return;
    }

    imports.forEach((item) => {
      const row = create("article", "schedule-backup-item scheduled-import-item");
      row.dataset.status = item.status || "";
      const text = create("div");
      text.append(
        create("strong", "", `Маршрут ${item.routeNumber}${item.routeName ? ` — ${item.routeName}` : ""}`),
        create("span", "", `${scheduledImportStatus(item.status)} • старт ${formatDateTime(item.effectiveAt)} • файлов ${formatNumber(item.fileCount)}`),
        item.error ? create("span", "schedule-error-text", item.error) : create("span", "", `Создал: ${item.createdBy || "админ"}${item.appliedAt ? ` • применено ${formatDateTime(item.appliedAt)}` : ""}`)
      );
      row.append(text);
      if (item.status === "pending") {
        const cancel = create("button", "mini-button danger-button", "Отменить");
        cancel.type = "button";
        cancel.addEventListener("click", () => cancelScheduledImport(item));
        row.append(cancel);
      }
      els.scheduledImportList.append(row);
    });
  }

  function scheduledImportStatus(status) {
    return {
      pending: "Ожидает",
      applying: "Применяется",
      applied: "Применено",
      failed: "Ошибка",
      cancelled: "Отменено"
    }[status] || "Статус";
  }

  async function cancelScheduledImport(item) {
    if (!(await confirmAction(`Отменить запланированную замену маршрута ${item.routeNumber}?`))) return;
    try {
      setStatus("Отменяем отложенную замену...");
      await api(`/api/admin/schedule/scheduled-imports/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await loadScheduledImports();
      setStatus("Отложенная замена отменена.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function loadScheduleBackups() {
    try {
      const data = await api("/api/admin/schedule/backups?limit=10");
      renderScheduleBackups(data.backups || []);
    } catch (error) {
      clear(els.scheduleBackupList);
      els.scheduleBackupList.append(empty(error.message));
    }
  }

  async function refreshScheduleBackupsManual() {
    const button = els.refreshScheduleBackups;
    const finishButtonAction = startButtonAction(button, "Обновляем...");
    try {
      setStatus("Обновляем копии расписания...");
      await Promise.all([loadScheduleBackups(), loadScheduledImports(), loadScheduleAudit()]);
      setStatus("Копии и журнал расписания обновлены.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      finishButtonAction();
    }
  }

  function renderScheduleBackups(backups) {
    clear(els.scheduleBackupList);
    if (!backups.length) {
      els.scheduleBackupList.append(empty("Копий пока нет. Они появятся после первой XML-загрузки."));
      return;
    }

    backups.forEach((backup) => {
      const item = create("article", "schedule-backup-item");
      const text = create("div");
      text.append(
        create("strong", "", backup.label || "Копия расписания"),
        create("span", "", `${formatDateTime(backup.createdAt)} • маршрутов ${formatNumber(backup.routeCount)} • отправлений ${formatNumber(backup.departureCount)}`)
      );
      const rollback = create("button", "mini-button danger-button", "Откатить");
      rollback.type = "button";
      rollback.addEventListener("click", () => rollbackScheduleBackup(backup, rollback));
      item.append(text, rollback);
      els.scheduleBackupList.append(item);
    });
  }

  async function rollbackScheduleBackup(backup, button) {
    if (!(await confirmAction(`Откатить расписание к копии от ${formatDateTime(backup.createdAt)}? Текущее расписание будет заменено.`))) return;
    if (button) button.disabled = true;
    try {
      setStatus("Откатываем расписание...");
      await api("/api/admin/schedule/rollback", {
        method: "POST",
        body: JSON.stringify({
          backupId: backup.id,
          confirmRollback: true
        })
      });
      await refreshAdminSummary();
      await refreshScheduleWorkspace();
      setStatus("Расписание восстановлено из резервной копии.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderScheduleRouteSelect(selection = {}) {
    const editorRoutes = scheduleEditorRoutes();
    const selectedRoute = editorRoutes.some((route) => route.id === selection.routeId)
      ? selection.routeId
      : editorRoutes.some((route) => route.id === els.scheduleRouteSelect.value)
        ? els.scheduleRouteSelect.value
        : editorRoutes[0]?.id || "";
    renderOptions(
      els.scheduleRouteSelect,
      editorRoutes.map((route) => ({ value: route.id, label: `${route.number}. ${route.name}` })),
      selectedRoute
    );

    if (els.scheduleImportRoute) {
      const importTransportType = els.scheduleImportForm?.elements.transportType?.value || "";
      const importRoutes = importTransportType
        ? state.routes.filter((route) => routeTransportType(route) === importTransportType)
        : state.routes;
      const selectedImportRoute = importRoutes.some((route) => route.id === els.scheduleImportRoute.value)
        ? els.scheduleImportRoute.value
        : "";
      renderOptions(
        els.scheduleImportRoute,
        [
          { value: "", label: "Определить / добавить по XML" },
          ...importRoutes.map((route) => ({ value: route.id, label: `Маршрут ${route.number} — ${route.name}` }))
        ],
        selectedImportRoute
      );
    }
  }

  async function onScheduleRouteChange(selection = {}) {
    const route = selectedScheduleRoute();
    const selectedDirection = route?.directions.some((direction) => direction.code === selection.directionCode)
      ? selection.directionCode
      : route?.directions.some((direction) => direction.code === els.scheduleDirectionSelect.value)
        ? els.scheduleDirectionSelect.value
        : route?.directions[0]?.code || "";
    renderOptions(
      els.scheduleDirectionSelect,
      (route?.directions || []).map((direction) => ({ value: direction.code, label: `${direction.from} - ${direction.to}` })),
      selectedDirection
    );
    await onScheduleDirectionChange(selection);
  }

  async function onScheduleDirectionChange(selection = {}) {
    const direction = selectedScheduleDirection();
    const stops = scheduleStopsForDirection(direction);
    const selectedStop = stops.some((stop) => stop.id === selection.stopUid)
      ? selection.stopUid
      : stops.some((stop) => stop.id === els.scheduleStopSelect.value)
        ? els.scheduleStopSelect.value
        : stops[0]?.id || "";
    renderOptions(
      els.scheduleStopSelect,
      stops.map((stop) => ({ value: stop.id, label: `${stop.position}. ${stop.name}` })),
      selectedStop
    );
    await onScheduleStopChange();
  }

  async function onScheduleStopChange() {
    renderScheduleFields();
    clearScheduleTimeForm();
    await loadScheduleDepartures();
  }

  function renderScheduleFields() {
    const route = selectedScheduleRoute();
    const direction = selectedScheduleDirection();
    const stop = selectedScheduleStop();
    els.scheduleRouteName.value = route?.name || "";
    els.scheduleColor.value = route?.color || "#2563eb";
    els.scheduleOrigin.value = direction?.from || "";
    els.scheduleDestination.value = direction?.to || "";
    els.scheduleStopName.value = stop?.name || "";
  }

  let scheduleDeparturesRequestSeq = 0;

  async function loadScheduleDepartures() {
    const route = selectedScheduleRoute();
    const direction = selectedScheduleDirection();
    const stop = selectedScheduleStop();
    clear(els.scheduleTimeList);
    if (!route || !direction || !stop) {
      els.scheduleTimeList.append(empty("Выберите маршрут, направление и остановку."));
      return;
    }

    // Monotonic guard: rapid select changes fire overlapping requests, and a slow
    // older response must not render the previous stop's times under the new one.
    const requestSeq = ++scheduleDeparturesRequestSeq;
    const query = new URLSearchParams({ routeId: route.id, directionCode: direction.code, stopUid: stop.id });
    try {
      const data = await api(`/api/admin/schedule/departures?${query}`);
      if (requestSeq !== scheduleDeparturesRequestSeq) return;
      state.scheduleDepartures = data.departures || [];
      renderScheduleDepartures();
    } catch (error) {
      if (requestSeq !== scheduleDeparturesRequestSeq) return;
      clear(els.scheduleTimeList);
      els.scheduleTimeList.append(empty(`Не удалось загрузить времена: ${error.message}`));
      throw error;
    }
  }

  function renderScheduleDepartures() {
    clear(els.scheduleTimeList);
    if (!state.scheduleDepartures.length) {
      els.scheduleTimeList.append(empty("На этой остановке пока нет времени."));
      return;
    }

    // Show ALL day-mask groups: filtering by the form's selected mode used to hide
    // departures with custom masks (e.g. only-Saturday trips) entirely — they
    // became invisible and uneditable in the admin panel while passengers saw them.
    const selectedMask = els.scheduleTimeForm.elements.dayMask.value || "1111100";
    const byMask = new Map();
    state.scheduleDepartures.forEach((item) => {
      const key = `${item.dayMask}:${item.dayName}`;
      if (!byMask.has(key)) byMask.set(key, []);
      byMask.get(key).push(item);
    });

    // Groups matching the selected mode first, the rest after.
    const groups = [...byMask.entries()].sort(([leftKey], [rightKey]) => {
      const leftSelected = leftKey.startsWith(`${selectedMask}:`) ? 0 : 1;
      const rightSelected = rightKey.startsWith(`${selectedMask}:`) ? 0 : 1;
      return leftSelected - rightSelected || leftKey.localeCompare(rightKey);
    });

    groups.forEach(([key, items]) => {
      const group = create("section", "schedule-time-group");
      const [mask, dayName] = key.split(":");
      group.append(create("h3", "", dayName || dayMaskLabel(mask) || "График"));
      const grid = create("div", "schedule-time-grid");
      items.forEach((item) => grid.append(scheduleTimeCard(item)));
      group.append(grid);
      els.scheduleTimeList.append(group);
    });
  }

  function scheduleTimeCard(item) {
    const card = create("article", "schedule-time-card");
    const top = create("div", "schedule-time-top");
    top.append(create("strong", "", item.time), create("span", "", item.notes || item.tripCode || "рейс"));
    const actions = create("div", "status-actions");
    const edit = create("button", "mini-button", "Изменить");
    edit.type = "button";
    edit.addEventListener("click", () => fillScheduleTimeForm(item));
    const remove = create("button", "mini-button danger-button", "Удалить");
    remove.type = "button";
    remove.addEventListener("click", () => deleteScheduleTime(item));
    actions.append(edit, remove);
    card.append(top, create("p", "muted", dayMaskLabel(item.dayMask)), actions);
    return card;
  }

  function fillScheduleTimeForm(item) {
    els.scheduleTimeForm.elements.id.value = item.id;
    ensureDayMaskOption(item.dayMask, item.dayName);
    els.scheduleTimeForm.elements.dayMask.value = item.dayMask;
    els.scheduleTimeForm.elements.time.value = item.time;
    els.scheduleTimeForm.elements.notes.value = item.notes || "";
    els.scheduleTimeForm.elements.applyToTrip.checked = true;
    setScheduleTimeMode("edit");
    els.scheduleTimeForm.scrollIntoView({ behavior: "auto", block: "nearest" });
  }

  function clearScheduleTimeForm() {
    els.scheduleTimeForm.reset();
    removeTemporaryDayMaskOptions();
    els.scheduleTimeForm.elements.id.value = "";
    els.scheduleTimeForm.elements.dayMask.value = "1111100";
    els.scheduleTimeForm.elements.applyToTrip.checked = true;
    setScheduleTimeMode("create");
  }

  function setScheduleTimeMode(mode) {
    const editing = mode === "edit";
    els.scheduleTimeMode.textContent = editing ? "Редактирование выбранного времени" : "Добавление нового времени";
    els.saveScheduleTimeButton.textContent = editing ? "Сохранить изменение" : "Добавить время";
  }

  async function saveScheduleMeta() {
    const route = selectedScheduleRoute();
    const direction = selectedScheduleDirection();
    const stop = selectedScheduleStop();
    if (!route) {
      setStatus("Выберите маршрут расписания.", "error");
      return;
    }
    const finishButtonAction = startButtonAction(els.saveScheduleMeta, "Сохраняем...");
    try {
      setStatus("Сохраняем названия...");
      await api("/api/admin/schedule/meta", {
        method: "POST",
        body: JSON.stringify({
          routeId: route.id,
          directionCode: direction?.code || "",
          stopUid: stop?.id || "",
          routeName: els.scheduleRouteName.value,
          color: els.scheduleColor.value,
          origin: els.scheduleOrigin.value,
          destination: els.scheduleDestination.value,
          stopName: els.scheduleStopName.value
        })
      });
      await refreshScheduleWorkspace({
        routeId: route.id,
        directionCode: direction?.code || "",
        stopUid: stop?.id || ""
      });
      setStatus("Данные расписания сохранены.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      finishButtonAction();
    }
  }

  async function saveScheduleTime(event) {
    event.preventDefault();
    const route = selectedScheduleRoute();
    const direction = selectedScheduleDirection();
    const stop = selectedScheduleStop();
    const isEdit = Boolean(els.scheduleTimeForm.elements.id.value);
    const saved = await submitForm(els.scheduleTimeForm, "Время сохранено.", async () => {
      const data = formJson(els.scheduleTimeForm);
      data.applyToTrip = els.scheduleTimeForm.elements.applyToTrip.checked;
      data.routeId = route?.id || "";
      data.directionCode = direction?.code || "";
      data.stopUid = stop?.id || "";
      await api("/api/admin/schedule/departures", { method: "POST", body: JSON.stringify(data) });
      await loadScheduleDepartures();
      await loadScheduleAudit();
    }, {
      button: event.submitter || els.saveScheduleTimeButton,
      busyText: isEdit ? "Обновляем..." : "Добавляем...",
      statusText: isEdit ? "Обновляем время..." : "Добавляем время..."
    });
    if (saved) clearScheduleTimeForm();
  }

  async function deleteScheduleTime(item) {
    if (!(await confirmAction(`Удалить время ${item.time || ""} на этой остановке?`))) return;
    // Whole-trip deletion was previously dead code (applyToTrip hardcoded false),
    // leaving orphaned partial trips on other stops. Offer it as an explicit
    // second step when the departure belongs to a trip.
    let applyToTrip = false;
    if (item.tripCode && item.variantCode) {
      applyToTrip = await confirmAction(
        "Удалить этот рейс ЦЕЛИКОМ на всех остановках маршрута?\n\nОК — удалить весь рейс.\nОтмена — удалить только время на этой остановке."
      );
    }
    try {
      setStatus(applyToTrip ? "Удаляем рейс..." : "Удаляем время...");
      await api(`/api/admin/schedule/departures/${item.id}?applyToTrip=${applyToTrip}`, { method: "DELETE" });
      await loadScheduleDepartures();
      await loadScheduleAudit();
      setStatus(applyToTrip ? "Рейс удалён на всех остановках." : "Время удалено.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function selectedScheduleRoute() {
    const editorRoutes = scheduleEditorRoutes();
    return editorRoutes.find((route) => route.id === els.scheduleRouteSelect.value) || editorRoutes[0] || null;
  }

  function scheduleEditorRoutes() {
    const transportType = state.scheduleTransportType || "city";
    return state.routes.filter((route) => routeTransportType(route) === transportType);
  }

  function routeTransportType(route) {
    const explicitType = route?.transportType || route?.transport_type || route?.type;
    if (["city", "suburban", "intercity", "international"].includes(explicitType)) return explicitType;
    const id = String(route?.id || "");
    if (id.startsWith("suburban:")) return "suburban";
    if (id.startsWith("intercity:")) return "intercity";
    if (id.startsWith("international:")) return "international";
    return "city";
  }

  function selectedScheduleImportRoute() {
    const routeId = els.scheduleImportRoute?.value || "";
    if (!routeId) return null;
    return state.routes.find((route) => route.id === routeId) || null;
  }

  async function loadScheduleAudit(options = {}) {
    const finishButtonAction = options.button ? startButtonAction(options.button, "Обновляем...") : () => {};
    try {
      if (options.announce) setStatus("Обновляем журнал расписания...");
      const data = await api("/api/admin/schedule/audit?limit=40");
      renderScheduleAudit(data.changes || []);
      if (options.announce) setStatus("Журнал расписания обновлён.", "success");
    } catch (error) {
      if (options.announce) {
        setStatus(error.message, "error");
        return;
      }
      throw error;
    } finally {
      finishButtonAction();
    }
  }

  function renderScheduleAudit(changes) {
    clear(els.scheduleAuditList);
    if (!changes.length) {
      els.scheduleAuditList.append(empty("Изменений пока нет."));
      return;
    }

    changes.forEach((change) => {
      const item = create("article", "schedule-audit-item");
      const top = create("div", "schedule-audit-top");
      top.append(create("strong", "", auditActionLabel(change.action)), create("span", "", formatDateTime(change.createdAt)));
      const meta = create("div", "item-meta");
      [change.actor, change.routeId && `маршрут ${routeNumberById(change.routeId) || change.routeId}`, change.stopUid && stopNameFromChange(change)]
        .filter(Boolean)
        .forEach((value) => meta.append(create("span", "", value)));
      const actions = create("div", "status-actions");
      const remove = create("button", "mini-button danger-button", "Удалить запись");
      remove.type = "button";
      remove.addEventListener("click", () => deleteScheduleAuditItem(change));
      actions.append(remove);
      item.append(top, create("p", "muted", auditSummary(change)), meta, actions);
      els.scheduleAuditList.append(item);
    });
  }

  async function deleteScheduleAuditItem(change) {
    if (!(await confirmAction("Удалить эту запись из журнала изменений?"))) return;
    try {
      setStatus("Удаляем запись журнала...");
      await api(`/api/admin/schedule/audit/${change.id}`, { method: "DELETE" });
      await loadScheduleAudit();
      setStatus("Запись журнала удалена.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function clearScheduleAudit() {
    if (!(await confirmAction("Очистить весь журнал изменений расписания?"))) return;
    try {
      setStatus("Очищаем журнал...");
      await api("/api/admin/schedule/audit", { method: "DELETE" });
      await loadScheduleAudit();
      setStatus("Журнал изменений очищен.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function auditActionLabel(action) {
    return {
      create: "Добавлено время",
      update: "Изменено время",
      update_trip: "Сдвинут рейс",
      delete: "Удалено время",
      delete_trip: "Удалён рейс",
      update_meta: "Изменены данные",
      import_xml: "Импорт XML",
      schedule_xml_import: "Отложенный XML",
      apply_scheduled_xml_import: "Применен отложенный XML",
      fail_scheduled_xml_import: "Ошибка отложенного XML",
      cancel_scheduled_xml_import: "Отменен отложенный XML",
      rollback_import: "Откат расписания"
    }[action] || "Изменение";
  }

  function auditSummary(change) {
    const beforeTime = Array.isArray(change.before) ? change.before[0]?.time : change.before?.time;
    const afterTime = Array.isArray(change.after) ? change.after[0]?.time : change.after?.time;
    if (change.action === "update_meta") return "Название маршрута, направления или остановки.";
    if (change.action === "import_xml") {
      const after = change.after || {};
      return `Файлов: ${formatNumber(after.files?.length || 0)}, обновлено маршрутов: ${formatNumber(after.importedRoutes || after.routes || 0)}, отправлений: ${formatNumber(after.importedDepartures || after.departures || 0)}`;
    }
    if (change.action === "schedule_xml_import") {
      const after = change.after || {};
      return `Маршрут ${after.routeNumber || ""}: запуск ${formatDateTime(after.effectiveAt)}, файлов ${formatNumber(after.files || 0)}.`;
    }
    if (change.action === "apply_scheduled_xml_import") {
      const after = change.after || {};
      return `Отложенная замена применена. Отправлений: ${formatNumber(after.importedDepartures || after.departures || 0)}.`;
    }
    if (change.action === "fail_scheduled_xml_import") {
      return change.after?.error || "Отложенную замену не удалось применить.";
    }
    if (change.action === "cancel_scheduled_xml_import") {
      const after = change.after || {};
      return `Отменена замена маршрута ${after.routeNumber || ""} на ${formatDateTime(after.effectiveAt)}.`;
    }
    if (change.action === "rollback_import") {
      const after = change.after || {};
      return `Восстановлено из копии: маршрутов ${formatNumber(after.routes || 0)}, отправлений ${formatNumber(after.departures || 0)}`;
    }
    if (beforeTime && afterTime && beforeTime !== afterTime) return `${beforeTime} → ${afterTime}`;
    if (afterTime) return `Время ${afterTime}`;
    if (beforeTime) return `Было ${beforeTime}`;
    return change.entityId || "Расписание";
  }

  function routeNumberById(routeId) {
    return state.routes.find((route) => route.id === routeId)?.number || "";
  }

  function stopNameFromChange(change) {
    const value = Array.isArray(change.after) ? change.after[0] : change.after || change.before;
    if (Array.isArray(value)) return value[0]?.stopName || "";
    return value?.stopName || value?.stop?.name || "";
  }

  function selectedScheduleDirection() {
    const route = selectedScheduleRoute();
    return route?.directions.find((direction) => direction.code === els.scheduleDirectionSelect.value) || route?.directions[0];
  }

  function selectedScheduleStop() {
    const direction = selectedScheduleDirection();
    const stops = scheduleStopsForDirection(direction);
    return stops.find((stop) => stop.id === els.scheduleStopSelect.value) || stops[0];
  }

  function scheduleStopsForDirection(direction) {
    return [
      ...(direction?.extraStartStops || []),
      ...(direction?.stops || []),
      ...(direction?.extraEndStops || [])
    ];
  }

  function dayMaskLabel(mask) {
    if (mask === "1111100") return "Будни";
    if (mask === "0000011") return "Выходные";
    if (mask === "1111111") return "Пн-Вс";
    return mask;
  }

  function ensureDayMaskOption(mask, label) {
    if (!mask || ["1111100", "0000011"].includes(mask)) return;
    const select = els.scheduleTimeForm.elements.dayMask;
    if ([...select.options].some((option) => option.value === mask)) return;
    const option = new Option(label || dayMaskLabel(mask), mask);
    option.dataset.temporary = "true";
    select.append(option);
  }

  function removeTemporaryDayMaskOptions() {
    const select = els.scheduleTimeForm.elements.dayMask;
    [...select.options].forEach((option) => {
      if (option.dataset.temporary === "true") option.remove();
    });
  }

  async function loadDutyRosters(options = {}) {
    const finishButtonAction = options.button ? startButtonAction(options.button, "Обновляем...") : () => {};
    try {
      if (options.announce) setStatus("Обновляем журнал разнарядок...");
      const data = await api("/api/admin/roster");
      state.rosterUploads = data.uploads || [];
      state.rosterDrivers = data.drivers || [];
      renderRosterDrivers();
      renderDutyRosterUploads();
      if (options.announce) setStatus("Журнал разнарядок обновлён.", "success");
    } catch (error) {
      if (options.announce) {
        setStatus(error.message, "error");
        return;
      }
      throw error;
    } finally {
      finishButtonAction();
    }
  }

  async function clearDutyRosterUploads() {
    if (!(await confirmAction("Очистить весь журнал разнарядок?"))) return;
    const finishButtonAction = startButtonAction(els.clearRosterUploads, "Очищаем...");
    try {
      setStatus("Очищаем журнал разнарядок...");
      await api("/api/admin/roster", { method: "DELETE" });
      state.rosterUploads = [];
      if (els.rosterPreview) {
        clear(els.rosterPreview);
        els.rosterPreview.hidden = true;
      }
      await loadDutyRosters();
      setStatus("Журнал разнарядок очищен.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      finishButtonAction();
    }
  }

  async function saveRosterDriver(event) {
    event.preventDefault();
    const form = els.rosterDriverForm;
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      setStatus("Сохраняем водителя...");
      const data = await api("/api/admin/roster/drivers", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.rosterDrivers = data.drivers || [];
      renderRosterDrivers();
      clearRosterDriverForm();
      setStatus("Водитель сохранен.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function clearRosterDriverForm() {
    els.rosterDriverForm?.reset();
    if (els.rosterDriverForm?.elements.id) els.rosterDriverForm.elements.id.value = "";
    if (els.rosterDriverForm?.elements.driverSquad) els.rosterDriverForm.elements.driverSquad.value = "city";
  }

  function editRosterDriver(driver) {
    const form = els.rosterDriverForm;
    if (!form) return;
    form.elements.id.value = driver.id || "";
    form.elements.telegramId.value = driver.telegramId || "";
    form.elements.tabNumber.value = driver.tabNumber || "";
    form.elements.fullName.value = driver.fullName || "";
    if (form.elements.driverSquad) form.elements.driverSquad.value = driver.driverSquad || "city";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function removeRosterDriver(driver) {
    if (!driver?.id) return;
    const name = driver.fullName || `таб. №${driver.tabNumber}`;
    if (!(await confirmAction(`Удалить водителя ${name} из привязки Telegram?`))) return;
    try {
      setStatus("Удаляем водителя...");
      const data = await api(`/api/admin/roster/drivers/${encodeURIComponent(driver.id)}`, { method: "DELETE" });
      state.rosterDrivers = data.drivers || [];
      renderRosterDrivers();
      setStatus("Водитель удален.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  const ROSTER_DRIVER_SQUADS = [
    { value: "city", title: "1-й отряд", subtitle: "город" },
    { value: "regional", title: "2-й отряд", subtitle: "пригород / межгород / международный" }
  ];

  function normalizeRosterDriverSquad(value) {
    return value === "regional" ? "regional" : "city";
  }

  function compareRosterDrivers(a, b) {
    const nameA = (a.fullName || "").trim();
    const nameB = (b.fullName || "").trim();
    const nameCompare = nameA.localeCompare(nameB, "ru", { numeric: true, sensitivity: "base" });
    if (nameCompare) return nameCompare;
    return String(a.tabNumber || "").localeCompare(String(b.tabNumber || ""), "ru", { numeric: true, sensitivity: "base" });
  }

  function renderRosterDrivers() {
    if (!els.rosterDriversList) return;
    clear(els.rosterDriversList);
    if (!state.rosterDrivers.length) {
      els.rosterDriversList.append(empty("Водители берутся из вкладки «Работники». Добавьте сотрудника с ролью «Водитель», табельным номером и отрядом."));
      return;
    }

    const grouped = ROSTER_DRIVER_SQUADS.reduce((acc, group) => {
      acc[group.value] = [];
      return acc;
    }, {});

    state.rosterDrivers.forEach((driver) => {
      grouped[normalizeRosterDriverSquad(driver.driverSquad)].push(driver);
    });

    ROSTER_DRIVER_SQUADS.forEach((group) => {
      const drivers = grouped[group.value].sort(compareRosterDrivers);
      const column = create("section", "roster-driver-column");
      const head = create("div", "roster-driver-column-head");
      const title = create("div");
      title.append(
        create("h3", "", group.title),
        create("p", "muted", group.subtitle)
      );
      head.append(title, create("span", "roster-driver-count", formatNumber(drivers.length)));
      column.append(head);

      const list = create("div", "roster-driver-column-list");
      if (!drivers.length) {
        list.append(create("p", "muted roster-driver-empty", "В этом отряде пока нет водителей."));
      }

      drivers.forEach((driver) => {
        const node = adminItem(
          driver.fullName || `Таб. №${driver.tabNumber}`,
          `Telegram ID: ${driver.telegramId}`,
          `Таб. №${driver.tabNumber}`,
          [
            driver.updatedAt ? `обновлен ${formatDateTime(driver.updatedAt)}` : "",
            driver.createdAt ? `создан ${formatDateTime(driver.createdAt)}` : ""
          ],
          { editable: false }
        );
        node.classList.add("roster-driver-item");
        list.append(node);
      });

      column.append(list);
      els.rosterDriversList.append(column);
    });
  }

  async function uploadDutyRoster(event) {
    event.preventDefault();
    const button = event.submitter || els.rosterUploadForm.querySelector("button[type='submit']");
    pulseActionButton(button);
    const file = els.rosterUploadForm.elements.csvFile.files[0];
    if (!file) {
      setStatus("Выберите CSV-файл разнарядки.", "error");
      return;
    }

    const finishButtonAction = startButtonAction(button, "Загружаем...");
    try {
      setStatus("Загружаем и разбираем CSV разнарядки...");
      const result = await api("/api/admin/roster/upload", {
        method: "POST",
        body: JSON.stringify({
          driverSquad: els.rosterUploadForm.elements.driverSquad?.value || "city",
          fileName: file.name,
          fileData: await readFileAsDataUrl(file, { required: true, typeLabel: "CSV-файл разнарядки" })
        })
      });
      renderDutyRosterPreview(result);
      await loadDutyRosters();
      const warned = (result.warnings || []).length;
      setStatus(
        warned
          ? `Разнарядка загружена с предупреждениями (${warned}). Проверьте превью и подтвердите отправку.`
          : "Разнарядка загружена. Проверьте превью и нажмите «Отправить водителям».",
        warned ? "warning" : "success"
      );
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      finishButtonAction();
    }
  }

  async function uploadDutyRosterFromTelegram() {
    const button = els.uploadRosterFromTelegram;
    const finishButtonAction = startButtonAction(button, "Берём из Telegram...");
    try {
      setStatus("Берём последний CSV, отправленный боту, и разбираем его...");
      const result = await api("/api/admin/roster/upload", {
        method: "POST",
        body: JSON.stringify({
          useTelegramDocument: true,
          driverSquad: els.rosterUploadForm.elements.driverSquad?.value || "city"
        })
      });
      renderDutyRosterPreview(result);
      await loadDutyRosters();
      const names = (result.telegramFiles || []).map((item) => item.fileName).filter(Boolean).join(", ");
      const warned = (result.warnings || []).length;
      setStatus(
        warned
          ? `CSV из Telegram загружен с предупреждениями (${warned})${names ? `: ${names}` : ""}. Проверьте и подтвердите отправку.`
          : `CSV из Telegram загружен${names ? `: ${names}` : ""}. Проверьте превью и нажмите «Отправить водителям».`,
        warned ? "warning" : "success"
      );
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      finishButtonAction();
    }
  }

  function renderDutyRosterPreview(result) {
    const panel = els.rosterPreview;
    if (!panel) return;
    clear(panel);
    panel.hidden = false;

    const summary = result.summary || {};
    const upload = result.upload || {};
    const duplicate = result.duplicateSentUpload;
    const autoSend = result.autoSend || {};
    const canSend = result.canSend !== false;

    const head = create("div", "roster-preview-head");
    const titleBox = create("div");
    titleBox.append(
      create("h2", "", `Разнарядка на ${formatRosterDate(summary.scheduleDate || upload.scheduleDate)}`),
      create("p", "muted", upload.fileName || "CSV-файл")
    );
    head.append(titleBox);
    if (!autoSend.ok && canSend) {
      const readyToSend = Number(summary.readyToSend || 0);
      const sendButton = create(
        "button",
        "primary-button",
        duplicate ? "Отправить повторно" : readyToSend ? `Отправить водителям (${readyToSend})` : "Отправить водителям"
      );
      sendButton.type = "button";
      const sendInfo = { readyToSend, squadLabel: driverSquadLabel(summary.targetSquad || upload.targetSquad) };
      sendButton.addEventListener("click", () => sendDutyRoster(upload.id, sendButton, sendInfo));
      head.append(sendButton);
    }
    panel.append(head);

    if (duplicate && canSend) {
      panel.append(create("div", "roster-warning", `Этот CSV уже отправлялся: ${formatDateTime(duplicate.sentAt || duplicate.createdAt)}. Повторная отправка будет выполнена сразу.`));
    }

    (result.warnings || []).forEach((warning) => {
      panel.append(create("div", "roster-warning", `Строка ${warning.row || "?"}: ${warning.message || "неоднозначный код"}${warning.code ? ` (${warning.code})` : ""}`));
    });

    if (autoSend.ok) {
      const box = create("div", "roster-send-report");
      const report = autoSend.report || {};
      box.append(
        create("strong", "", "Отправлено автоматически"),
        create("p", "muted", `Отправлено: ${report.sent || 0}. Без Telegram: ${report.skipped || 0}. Ошибки: ${report.failed || 0}.`)
      );
      panel.append(box);
    } else if (autoSend.message) {
      panel.append(create("div", "roster-warning", autoSend.message));
    }

    const stats = create("div", "roster-stats");
    [
      ["Назначений", summary.assignments || upload.assignmentCount || 0],
      ["Водителей", summary.foundDrivers || upload.driverCount || 0],
      ["Готово к отправке", summary.readyToSend || 0],
      ["Без Telegram", summary.unregistered || 0]
    ].forEach(([label, value]) => {
      const card = create("div", "roster-stat-card");
      card.append(create("strong", "", formatNumber(value)), create("span", "", label));
      stats.append(card);
    });
    panel.append(stats);

    const unregistered = result.unregisteredTabs || [];
    if (unregistered.length) {
      const box = create("div", "roster-unregistered");
      box.append(create("strong", "", "Не зарегистрированы в Telegram"));
      box.append(create("p", "muted", unregistered.slice(0, 20).map((item) => `${item.tabNumber} ${item.driverName || ""}`.trim()).join(", ")));
      if (unregistered.length > 20) box.append(create("p", "muted", `И еще ${unregistered.length - 20}.`));
      panel.append(box);
    }

    const preview = create("div", "roster-preview-list");
    (result.preview || []).slice(0, 12).forEach((item) => {
      const row = create("article", "roster-preview-row");
      row.append(
        create("strong", "", item.driverName || `Таб. №${item.tabNumber}`),
        create("span", "", `Таб. №${item.tabNumber}`),
        create("span", "", rosterAssignmentLabel(item)),
        create("span", "", [item.workTimeStart, item.workTimeEnd].filter(Boolean).join("–") || "Время не указано")
      );
      preview.append(row);
    });
    if ((result.preview || []).length) panel.append(preview);
  }

  async function sendDutyRoster(uploadId, button, info = {}) {
    if (!uploadId) return;
    const readyCount = Number(info.readyToSend || 0);
    const squadLabel = info.squadLabel ? ` (${info.squadLabel})` : "";
    const question = readyCount
      ? `Отправить разнарядку ${readyCount} водителям в Telegram${squadLabel}? Отменить рассылку будет нельзя.`
      : `Отправить разнарядку водителям${squadLabel}? Отменить рассылку будет нельзя.`;
    if (!(await confirmAction(question))) return;

    const finishButtonAction = startButtonAction(button, "Отправляем...");
    try {
      setStatus("Отправляем разнарядку водителям...");
      let data;
      try {
        data = await api(`/api/admin/roster/${encodeURIComponent(uploadId)}/send`, {
          method: "POST",
          body: JSON.stringify({})
        });
      } catch (error) {
        // Server refuses to send a roster that needs review or is a duplicate
        // without an explicit force. Ask for a second confirmation, then force.
        if (/подтвержд|уже отправ|неоднознач|исправьте|повторн/i.test(error.message || "")) {
          if (!(await confirmAction(`${error.message}\n\nОтправить всё равно?`))) return;
          data = await api(`/api/admin/roster/${encodeURIComponent(uploadId)}/send`, {
            method: "POST",
            body: JSON.stringify({ force: true })
          });
        } else {
          throw error;
        }
      }
      renderDutyRosterSendReport(data);
      await loadDutyRosters();
      setStatus(`Разнарядка отправлена: ${data.report?.sent || 0}, без Telegram: ${data.report?.skipped || 0}.`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      finishButtonAction();
    }
  }

  function renderDutyRosterSendReport(data) {
    if (!els.rosterPreview) return;
    const report = data.report || {};
    const box = create("div", "roster-send-report");
    box.append(
      create("strong", "", "Отчет отправки"),
      create("p", "muted", `Отправлено: ${report.sent || 0}. Без Telegram: ${report.skipped || 0}. Ошибки: ${report.failed || 0}.`)
    );
    if (Array.isArray(report.errors) && report.errors.length) {
      box.append(create("p", "muted", report.errors.slice(0, 5).map((item) => `${item.tabNumber}: ${item.error}`).join("; ")));
    }
    els.rosterPreview.append(box);
  }

  function renderDutyRosterUploads() {
    if (!els.rosterUploadsList) return;
    clear(els.rosterUploadsList);
    if (!state.rosterUploads.length) {
      els.rosterUploadsList.append(empty("Разнарядки пока не загружались."));
      return;
    }

    state.rosterUploads.forEach((upload) => {
      const node = adminItem(
        `${formatRosterDate(upload.scheduleDate)} • ${upload.fileName}`,
        `Назначений: ${formatNumber(upload.assignmentCount || 0)} • водителей: ${formatNumber(upload.driverCount || 0)}`,
        upload.status,
        [
          `создал: ${upload.uploadedBy || "админка"}`,
          upload.targetSquad ? driverSquadLabel(upload.targetSquad) : "",
          upload.sentAt ? `отправлено ${formatDateTime(upload.sentAt)}` : `загружено ${formatDateTime(upload.createdAt)}`,
          Array.isArray(upload.warnings) && upload.warnings.length ? `${upload.warnings.length} предупреждений` : "",
          upload.sentCount ? `${upload.sentCount} отправлено` : "",
          upload.skippedCount ? `${upload.skippedCount} без Telegram` : "",
          upload.failedCount ? `${upload.failedCount} ошибок` : ""
        ],
        { editable: false }
      );
      node.classList.add("roster-upload-item");
      const actions = create("div", "admin-item-actions");
      const send = create("button", "mini-button", upload.status === "sent" ? "Отправить повторно" : "Отправить");
      send.type = "button";
      send.addEventListener("click", () => sendDutyRoster(upload.id, send));
      actions.append(send);
      node.append(actions);
      els.rosterUploadsList.append(node);
    });
  }

  function formatRosterDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return value || "дата не найдена";
    return `${match[3]}.${match[2]}.${match[1]}`;
  }

  function rosterAssignmentLabel(item) {
    if (item?.assignmentType === "reserve") return "Резерв";
    if (item?.route) return `Маршрут ${item.route}${item.routeCarNumber ? ` • машина №${item.routeCarNumber}` : ""}`;
    return "Маршрут не указан";
  }

  async function loadAds() {
    const data = await api("/api/admin/ads");
    renderAds(data.ads || []);
  }

  function renderAds(ads) {
    clear(els.adsList);
    if (!ads.length) {
      els.adsList.append(empty("Рекламы пока нет."));
      return;
    }

    ads.forEach((ad) => {
      const item = adminItem(ad.title, ad.text, ad.status, [
        adPlacementLabel(ad.placement),
        `${ad.displaySeconds || 7} сек. показ`,
        ad.label,
        ad.startsAt && `с ${ad.startsAt}`,
        ad.endsAt && `до ${ad.endsAt}`,
        ad.imageUrl && "есть картинка",
        `${ad.impressions || 0} показов`
      ]);
      item.classList.add("admin-ad-item");
      const adImageUrl = safeMediaUrl(ad.imageUrl);
      if (adImageUrl) {
        const image = create("img", "admin-ad-image");
        image.src = adImageUrl;
        image.alt = ad.title || "Картинка рекламы";
        item.insertBefore(image, item.querySelector(".item-meta"));
      }
      item.querySelector(".edit-button").addEventListener("click", () => fillAdForm(ad));
      appendDeleteAction(item, "Удалить рекламу", () => deleteAdItem(ad));
      els.adsList.append(item);
    });
  }

  function adPlacementLabel(placement) {
    if (placement === "home") return "главный инфоблок";
    return "обычная реклама";
  }

  async function saveAd(event) {
    event.preventDefault();
    await submitForm(els.adForm, "Реклама сохранена.", async () => {
      const data = await adFormJson();
      await api("/api/admin/ads", { method: "POST", body: JSON.stringify(data) });
      els.adForm.reset();
      await loadAds();
    });
  }

  async function adFormJson() {
    const data = formJson(els.adForm);
    const file = els.adForm.elements.imageFile.files[0];
    delete data.imageFile;
    data.removeImage = els.adForm.elements.removeImage.checked;
    if (file?.size) {
      data.imageName = file.name;
      data.imageType = file.type;
      data.imageData = await readFileAsDataUrl(file);
    }
    return data;
  }

  function fillAdForm(ad) {
    fillForm(els.adForm, ad);
    els.adForm.elements.imageFile.value = "";
    els.adForm.elements.removeImage.checked = false;
  }

  async function deleteAdItem(ad) {
    if (!(await confirmAction(`Удалить рекламу "${ad.title}"?`))) return;
    try {
      setStatus("Удаляем рекламу...");
      await api(`/api/admin/ads/${encodeURIComponent(ad.id)}`, { method: "DELETE" });
      await loadAds();
      setStatus("Реклама удалена.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function loadServices() {
    const data = await api("/api/admin/services");
    state.services = data.services || [];
    renderServices();
  }

  function renderServices() {
    if (!els.servicesList) return;
    clear(els.servicesList);
    if (!state.services.length) {
      els.servicesList.append(empty("Услуг пока нет."));
      return;
    }

    state.services.forEach((service) => {
      const section = service.section === "other" ? "Другие услуги" : "Услуги СТО";
      const node = adminItem(service.name, service.description || service.details || "Описание не заполнено.", service.status, [
        section,
        service.price,
        service.imageUrl && "картинка добавлена",
        service.icon && `иконка: ${service.icon}`,
        Number.isFinite(Number(service.sortOrder)) && `порядок: ${service.sortOrder}`
      ]);
      node.classList.add("admin-service-item");
      const imageUrl = safeMediaUrl(service.imageUrl);
      if (imageUrl) {
        const image = create("img", "admin-service-image");
        image.src = imageUrl;
        image.alt = "";
        image.loading = "lazy";
        node.prepend(image);
      }
      node.querySelector(".edit-button").addEventListener("click", () => fillServiceForm(service));
      appendDeleteAction(node, "Удалить услугу", () => deleteServiceItem(service));
      moveEditButtonToActions(node);
      els.servicesList.append(node);
    });
  }

  async function saveService(event) {
    event.preventDefault();
    await submitForm(els.serviceForm, "Услуга сохранена.", async () => {
      const data = await serviceFormJson();
      data.sortOrder = Number(data.sortOrder || 0);
      await api("/api/admin/services", { method: "POST", body: JSON.stringify(data) });
      clearServiceForm({ silent: true });
      await loadServices();
    });
  }

  async function serviceFormJson() {
    const data = formJson(els.serviceForm);
    const file = els.serviceForm.elements.imageFile?.files?.[0];
    delete data.imageFile;
    data.removeImage = Boolean(els.serviceForm.elements.removeImage?.checked);
    if (file?.size) {
      data.imageName = file.name;
      data.imageType = file.type;
      data.imageData = await readFileAsDataUrl(file);
    }
    return data;
  }

  function fillServiceForm(service) {
    fillForm(els.serviceForm, service);
    if (els.serviceForm.elements.imageFile) els.serviceForm.elements.imageFile.value = "";
    if (els.serviceForm.elements.removeImage) els.serviceForm.elements.removeImage.checked = false;
    els.serviceForm.scrollIntoView({ behavior: "auto", block: "nearest" });
  }

  function clearServiceForm(options = {}) {
    els.serviceForm.reset();
    els.serviceForm.elements.id.value = "";
    if (els.serviceForm.elements.imageUrl) els.serviceForm.elements.imageUrl.value = "";
    if (els.serviceForm.elements.imageFile) els.serviceForm.elements.imageFile.value = "";
    if (els.serviceForm.elements.removeImage) els.serviceForm.elements.removeImage.checked = false;
    els.serviceForm.elements.section.value = "sto";
    els.serviceForm.elements.status.value = "active";
    if (!options.silent) setStatus("Форма услуги очищена.", "success");
  }

  async function deleteServiceItem(service) {
    if (!(await confirmAction(`Удалить услугу "${service.name}"?`))) return;
    try {
      setStatus("Удаляем услугу...");
      await api(`/api/admin/services/${encodeURIComponent(service.id)}`, { method: "DELETE" });
      await loadServices();
      setStatus("Услуга удалена.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function loadNotifications() {
    const data = await api("/api/admin/notifications");
    renderNotifications(data.notifications || [], data.subscribers || [], data.staffRecipients || []);
  }

  function renderNotifications(items, subscribers, staffRecipients) {
    clear(els.notificationsList);
    els.notificationsList.append(empty(`Подписчиков: ${subscribers.length}. Сотрудников: ${staffRecipients.length}.`));
    items.forEach((item) => {
      const node = adminItem(
        item.title,
        item.text,
        item.status,
        [notificationTargetLabel(item.target), `отправлено ${item.sentCount || 0}`, `ошибок ${item.failedCount || 0}`, formatDateTime(item.createdAt)],
        { editable: false }
      );
      appendDeleteAction(node, "Удалить уведомление", () => deleteNotificationItem(item));
      els.notificationsList.append(node);
    });
  }

  async function saveNotification(event) {
    event.preventDefault();
    await submitForm(els.notificationForm, "Уведомление создано.", async () => {
      const data = formJson(els.notificationForm);
      data.sendNow = els.notificationForm.elements.sendNow.checked;
      await api("/api/admin/notifications", { method: "POST", body: JSON.stringify(data) });
      els.notificationForm.reset();
      els.notificationForm.elements.target.value = "all";
      els.notificationForm.elements.sendNow.checked = true;
      await loadNotifications();
      await loadAll();
    });
  }

  function clearNotificationForm() {
    els.notificationForm.reset();
    els.notificationForm.elements.target.value = "all";
    els.notificationForm.elements.sendNow.checked = true;
    setStatus("Форма уведомления очищена.", "success");
  }

  function notificationTargetLabel(target) {
    if (target === "staff") return "все сотрудники";
    return "пассажиры";
  }

  async function clearNotifications() {
    if (!(await confirmAction("Удалить все пуш-уведомления из журнала?"))) return;
    try {
      setStatus("Удаляем уведомления...");
      await api("/api/admin/notifications", { method: "DELETE" });
      await loadNotifications();
      setStatus("Уведомления очищены.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function deleteNotificationItem(item) {
    if (!(await confirmAction(`Удалить уведомление "${item.title}"?`))) return;
    try {
      setStatus("Удаляем уведомление...");
      await api(`/api/admin/notifications/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await loadNotifications();
      setStatus("Уведомление удалено.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function loadAdmins() {
    const data = await api("/api/admin/admins");
    state.roleLabels = data.roles || state.roleLabels;
    state.admins = data.admins || [];
    renderAdmins();
  }

  function renderAdmins(admins = state.admins, options = {}) {
    const query = els.adminSearch?.value || "";
    const visibleAdmins = filterAdmins(admins, query);
    clear(els.adminsList);
    if (!admins.length) {
      els.adminsList.append(empty("Работники пока не добавлены."));
      return;
    }
    if (!visibleAdmins.length) {
      els.adminsList.append(empty("Поиск не нашёл работников."));
      return;
    }

    visibleAdmins.forEach((admin) => {
      const item = adminItem(
        admin.name,
        admin.telegramId ? `Telegram ID: ${admin.telegramId}` : "Без Telegram ID",
        admin.active ? "active" : "archived",
        [
          workerRoleCaption(admin),
          admin.tabNumber ? `таб. №${admin.tabNumber}` : ""
        ]
      );
      item.classList.add("worker-card");
      item.querySelector(".item-meta span")?.classList.add("worker-role-pill");
      item.querySelector(".edit-button").addEventListener("click", () => fillAdminForm(admin));
      els.adminsList.append(item);
    });

    if (options.scrollToMatch && query.trim()) scrollToAdminMatch();
  }

  function scrollToAdminMatch() {
    const item = els.adminsList?.querySelector(".admin-item");
    if (!item) return;
    item.classList.add("is-search-match");
    window.requestAnimationFrame(() => {
      item.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      window.setTimeout(() => item.classList.remove("is-search-match"), 1200);
    });
  }

  function normalizeWorkerSearch(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^0-9a-zа-яіїєґў]+/gi, " ")
      .trim();
  }

  function filterAdmins(admins, query) {
    const tokens = normalizeWorkerSearch(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return admins;

    return admins.filter((admin) => {
      const haystack = normalizeWorkerSearch([admin.tabNumber, admin.name].filter(Boolean).join(" "));
      return tokens.every((token) => haystack.includes(token));
    });
  }

  function roleLabel(role) {
    return state.roleLabels?.[role] || role || "Работник";
  }

  function workerRoleCaption(admin) {
    if (admin?.role === "driver" || admin?.driverSquad) {
      return admin.driverSquad === "regional" ? "Водитель 2-го отряда" : "Водитель 1-го отряда";
    }
    return roleLabel(admin?.role);
  }

  function driverSquadLabel(value) {
    return value === "regional" ? "2-й отряд — пригород / межгород / международный" : "1-й отряд — город";
  }

  async function saveAdmin(event) {
    event.preventDefault();
    await submitForm(els.adminForm, "Работник сохранён.", async () => {
      const data = formJson(els.adminForm);
      data.active = els.adminForm.elements.active.checked;
      if (data.role !== "driver") data.driverSquad = "";
      if (data.role === "driver" && !data.driverSquad) data.driverSquad = "city";
      await api("/api/admin/admins", { method: "POST", body: JSON.stringify(data) });
      els.adminForm.reset();
      els.adminForm.elements.active.checked = true;
      syncAdminDriverSquadField();
      await loadAdmins();
      await loadDutyRosters();
    });
  }

  function syncAdminDriverSquadField() {
    const form = els.adminForm;
    const select = form?.elements.driverSquad;
    const role = form?.elements.role?.value || "worker";
    if (!select) return;

    const isDriver = role === "driver";
    const field = select.closest("[data-driver-squad-field]");
    select.disabled = !isDriver;
    select.required = isDriver;
    field?.classList.toggle("is-disabled", !isDriver);
    if (!isDriver) {
      select.value = "";
      return;
    }
    select.disabled = false;
    if (!select.value) select.value = "city";
  }

  async function loadLeadershipContacts() {
    const data = await api("/api/admin/leadership");
    state.leadershipContacts = data.contacts || [];
    renderLeadershipContacts(state.leadershipContacts);
  }

  function renderLeadershipContacts(contacts) {
    clear(els.leadershipList);
    if (!contacts.length) {
      els.leadershipList.append(empty("Контакты руководства пока не добавлены."));
      return;
    }

    contacts.forEach((contact) => {
      const item = adminItem(
        contact.name,
        contact.position,
        contact.active ? "active" : "archived",
        [
          contact.department || "Руководство",
          contact.phoneLabel || contact.phone,
          contact.email,
          contact.featured ? "основной контакт" : "",
          contact.sortOrder ? `порядок ${contact.sortOrder}` : ""
        ]
      );
      item.classList.add("leadership-admin-card");
      item.querySelector(".edit-button")?.addEventListener("click", () => fillLeadershipForm(contact));
      appendDeleteAction(item, "Удалить контакт", () => deleteLeadershipContact(contact));
      moveEditButtonToActions(item);
      els.leadershipList.append(item);
    });
  }

  async function saveLeadershipContact(event) {
    event.preventDefault();
    await submitForm(els.leadershipForm, "Контакт сохранён.", async () => {
      const data = formJson(els.leadershipForm);
      data.featured = els.leadershipForm.elements.featured.checked;
      data.active = els.leadershipForm.elements.active.checked;
      const photoFile = els.leadershipForm.elements.photoFile?.files?.[0];
      if (photoFile) {
        data.photoImageData = await readFileAsDataUrl(photoFile);
        data.photoImageName = photoFile.name;
      }
      delete data.photoFile;
      await api("/api/admin/leadership", { method: "POST", body: JSON.stringify(data) });
      clearLeadershipForm();
      await loadLeadershipContacts();
    });
  }

  function fillLeadershipForm(contact) {
    fillForm(els.leadershipForm, contact);
    els.leadershipForm.elements.featured.checked = Boolean(contact.featured);
    els.leadershipForm.elements.active.checked = Boolean(contact.active);
  }

  function clearLeadershipForm() {
    els.leadershipForm.reset();
    els.leadershipForm.elements.id.value = "";
    els.leadershipForm.elements.department.value = "Руководство предприятия";
    els.leadershipForm.elements.featured.checked = false;
    els.leadershipForm.elements.active.checked = true;
    setStatus("Форма контакта очищена.", "success");
  }

  async function deleteLeadershipContact(contact) {
    if (!(await confirmAction(`Удалить контакт "${contact.name}"?`))) return;
    try {
      setStatus("Удаляем контакт...");
      await api(`/api/admin/leadership/${encodeURIComponent(contact.id)}`, { method: "DELETE" });
      await loadLeadershipContacts();
      setStatus("Контакт удалён.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function confirmAction(message, options = {}) {
    const text = String(message || "").trim();
    if (!text) return Promise.resolve(true);

    if (tg?.showConfirm) {
      return new Promise((resolve) => {
        try {
          tg.showConfirm(text, (confirmed) => resolve(Boolean(confirmed)));
        } catch (error) {
          console.warn("Telegram confirmation failed, using inline dialog.", error);
          showInlineConfirm(text, options).then(resolve);
        }
      });
    }

    if (tg?.showPopup) {
      return new Promise((resolve) => {
        try {
          tg.showPopup(
            {
              title: options.title || "Подтверждение",
              message: text,
              buttons: [
                { id: "confirm", type: "destructive", text: options.confirmText || "Подтвердить" },
                { id: "cancel", type: "cancel", text: options.cancelText || "Отмена" }
              ]
            },
            (buttonId) => resolve(buttonId === "confirm")
          );
        } catch (error) {
          console.warn("Telegram popup failed, using inline dialog.", error);
          showInlineConfirm(text, options).then(resolve);
        }
      });
    }

    return showInlineConfirm(text, options);
  }

  function showInlineConfirm(message, options = {}) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const backdrop = create("div", "admin-confirm-backdrop");
      const dialog = create("section", "admin-confirm-dialog");
      const title = create("h2", "", options.title || "Подтверждение");
      const body = create("p", "", message);
      const actions = create("div", "admin-confirm-actions");
      const cancel = create("button", "ghost-button", options.cancelText || "Отмена");
      const confirm = create("button", "primary-button danger-button", options.confirmText || "Подтвердить");
      let settled = false;

      backdrop.setAttribute("role", "presentation");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "adminConfirmTitle");
      title.id = "adminConfirmTitle";
      cancel.type = "button";
      confirm.type = "button";

      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown);
        backdrop.remove();
        previousFocus?.focus?.();
        resolve(value);
      };

      function onKeydown(event) {
        if (event.key === "Escape") finish(false);
      }

      cancel.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) finish(false);
      });
      document.addEventListener("keydown", onKeydown);

      actions.append(cancel, confirm);
      dialog.append(title, body, actions);
      backdrop.append(dialog);
      document.body.append(backdrop);
      confirm.focus();
    });
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-admin-key": state.key,
        "x-admin-role": state.role,
        ...(getTelegramInitData() ? { "x-telegram-init-data": getTelegramInitData() } : {}),
        ...(options.headers || {})
      }
    });
    const contentType = response.headers.get("content-type") || "";
    let data = {};
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = { ok: false, error: text.trim() || "Ошибка запроса." };
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || "Ошибка запроса.");
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function adminItem(title, text, status, metaItems, options = {}) {
    const item = create("article", "admin-item");
    const top = create("div", "admin-item-top");
    const box = create("div");
    box.append(create("h2", "", title), create("p", "muted", text || ""));
    top.append(box, pill(status));
    if (options.editable !== false) {
      const edit = create("button", "mini-button edit-button", "Изменить");
      edit.type = "button";
      top.append(edit);
    }

    const meta = create("div", "item-meta");
    metaItems.filter(Boolean).forEach((value) => meta.append(create("span", "", value)));
    item.append(top, meta);
    return item;
  }

  function appendDeleteAction(item, label, onClick) {
    const actions = create("div", "admin-item-actions");
    const remove = create("button", "mini-button danger-button", "Удалить");
    remove.type = "button";
    remove.title = label;
    remove.addEventListener("click", onClick);
    actions.append(remove);
    item.append(actions);
  }

  function moveEditButtonToActions(item) {
    const edit = item.querySelector(".edit-button");
    if (!edit) return;
    let actions = item.querySelector(".admin-item-actions");
    if (!actions) {
      actions = create("div", "admin-item-actions");
      item.append(actions);
    }
    actions.prepend(edit);
  }

  function pill(status) {
    const node = create("span", "status-pill", STATUS_LABELS[status] || status || "Статус");
    node.dataset.status = status || "";
    return node;
  }

  function fillForm(form, item) {
    // Reset first: keys the new item lacks must not silently keep the previous
    // item's values (editing ad A then ad B used to carry A's fields into B).
    form.reset();
    Object.entries(item).forEach(([key, value]) => {
      if (form.elements[key]) form.elements[key].value = value ?? "";
    });
    const rect = form.getBoundingClientRect();
    if (rect.top < 0 || rect.top > window.innerHeight - 120) {
      window.scrollTo({ top: clampAdminScrollTop(form.offsetTop - 12), behavior: "auto" });
    }
  }

  function fillAdminForm(admin) {
    fillForm(els.adminForm, admin);
    els.adminForm.elements.active.checked = Boolean(admin.active);
    if (els.adminForm.elements.driverSquad) els.adminForm.elements.driverSquad.value = admin.driverSquad || "";
    syncAdminDriverSquadField();
  }

  function formJson(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function readFileAsDataUrl(file, options = {}) {
    const label = options.typeLabel || "Файл";
    const name = file?.name || "без имени";
    if (!file) throw new Error(`${label} не выбран.`);

    // Guard before base64-encoding: a huge file would freeze the tab and the
    // server would reject the oversized body anyway (its cap is 40MB for XML).
    const maxBytes = Number(options.maxBytes) || 40 * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new Error(`${label} «${name}» слишком большой (${Math.round(file.size / 1024 / 1024)} МБ). Максимум ${Math.round(maxBytes / 1024 / 1024)} МБ.`);
    }

    const attempts = [
      () => readFileViaFileReader(file),
      () => readFileViaArrayBuffer(file),
      () => readFileViaObjectUrl(file)
    ];
    const errors = [];

    for (const attempt of attempts) {
      try {
        const result = await attempt();
        if (!options.required || dataUrlByteLength(result)) return result;
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }

    const hint = !file.size
      ? "Telegram показывает размер 0 байт, но это может быть ошибка его выборщика файлов. Перешлите файл в «Избранное»/Saved Messages, сохраните его на диск и выберите именно сохраненную копию, либо откройте админку во внешнем браузере."
      : "Файл выбран, но браузер не отдал его содержимое.";
    const details = errors.length ? ` Детали: ${errors.join("; ")}` : "";
    throw new Error(`${label} "${name}" не удалось прочитать.${details} ${hint}`);
  }

  function readFileViaFileReader(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("FileReader не смог прочитать файл"));
      reader.readAsDataURL(file);
    });
  }

  async function readFileViaArrayBuffer(file) {
    if (typeof file.arrayBuffer !== "function") throw new Error("arrayBuffer недоступен");
    const buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) return "";
    const mimeType = file.type || "application/octet-stream";
    return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;
  }

  async function readFileViaObjectUrl(file) {
    if (!window.URL?.createObjectURL || typeof fetch !== "function") throw new Error("blob URL недоступен");
    const url = URL.createObjectURL(file);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`blob URL вернул ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (!buffer || !buffer.byteLength) return "";
      const mimeType = file.type || response.headers.get("content-type") || "application/octet-stream";
      return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function dataUrlByteLength(dataUrl) {
    const match = String(dataUrl || "").match(/^data:[^,]*;base64,([\s\S]*)$/i);
    if (!match) return 0;
    const base64 = match[1].replace(/\s/g, "");
    if (!base64) return 0;
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
  }

  function describeSelectedFiles(files) {
    const list = (files || []).slice(0, 3).map((file) => `${file.name || "без имени"} (${describeFileSize(file)})`);
    const rest = files.length > list.length ? ` и ещё ${files.length - list.length}` : "";
    return `${list.join(", ")}${rest}`;
  }

  function describeFileSize(file) {
    if (file && Number(file.size) > 0) return formatBytes(file.size);
    return "размер не передан Telegram";
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} байт`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function mimeTypeFromUrl(url) {
    const clean = String(url || "").split("?")[0].toLowerCase();
    if (clean.endsWith(".m4a") || clean.endsWith(".mp4")) return "audio/mp4";
    if (clean.endsWith(".ogg")) return "audio/ogg";
    if (clean.endsWith(".mp3")) return "audio/mpeg";
    if (clean.endsWith(".wav")) return "audio/wav";
    return "audio/webm";
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
        const link = create("a", "attachment-image");
        link.href = itemUrl;
        link.target = "_blank";
        link.rel = "noopener";
        const img = create("img");
        img.src = itemUrl;
        img.alt = item.name || "Вложение";
        img.loading = "lazy";
        img.decoding = "async";
        link.append(img);
        list.append(link);
      } else if (item.type === "audio") {
        const audio = create("audio", "attachment-audio");
        audio.controls = true;
        audio.preload = "metadata";
        const source = create("source");
        source.src = itemUrl;
        source.type = item.mimeType || mimeTypeFromUrl(itemUrl);
        audio.append(source);
        const link = create("a", "attachment-download", "Скачать голосовое");
        link.href = itemUrl;
        link.target = "_blank";
        link.rel = "noopener";
        list.append(audio, link);
      }
    });
    parent.append(list);
  }

  async function submitForm(form, successMessage, action, options = {}) {
    const button = options.button || form.querySelector("button[type='submit']");
    const statusText = options.statusText || "Сохраняем...";
    const busyText = options.busyText || statusText;
    const finishButtonAction = startButtonAction(button, busyText);
    try {
      setStatus(statusText);
      await action();
      setStatus(successMessage, "success");
      return true;
    } catch (error) {
      setStatus(error.message, "error");
      return false;
    } finally {
      finishButtonAction();
    }
  }

  function can(permission) {
    return state.permissions.includes(permission);
  }

  function resetLists() {
    [
      els.appealsList,
      els.scheduleTimeList,
      els.scheduleAuditList,
      els.rosterDriversList,
      els.rosterUploadsList,
      els.adsList,
      els.servicesList,
      els.notificationsList,
      els.adminsList,
      els.leadershipList
    ].forEach(clear);
    if (els.rosterPreview) {
      clear(els.rosterPreview);
      els.rosterPreview.hidden = true;
    }
  }

  function setStatus(text, type) {
    window.clearTimeout(setStatus.timer);
    const message = text || "";
    els.adminStatus.textContent = message;
    els.adminStatus.classList.toggle("is-success", type === "success");
    els.adminStatus.classList.toggle("is-error", type === "error");
    els.adminStatus.classList.toggle("is-warning", type === "warning");
    if (!message) return;

    // Warnings and errors stay longer so the operator can actually read them.
    const timeout = type === "error" ? 5200 : type === "warning" ? 5200 : 3200;
    setStatus.timer = window.setTimeout(() => {
      els.adminStatus.textContent = "";
      els.adminStatus.classList.remove("is-success", "is-error", "is-warning");
    }, timeout);
  }

  function empty(text) {
    return create("div", "empty-state", text);
  }

  function create(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function formatDateTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("ru-BY", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ru-BY").format(value || 0);
  }

  function setTheme(theme) {
    theme = "comfort";
    const root = document.documentElement;
    root.classList.add("is-switching-theme");
    root.dataset.theme = theme;
    document.body.dataset.theme = theme;
    root.classList.remove("is-dark");
    root.classList.add("is-comfort");
    document.body.classList.remove("is-dark");
    document.body.classList.add("is-comfort");
    root.style.colorScheme = "light";
    window.setTimeout(() => root.classList.remove("is-switching-theme"), 80);
    const themeColor = "#f6f8fb";
    if (tg?.setHeaderColor) tg.setHeaderColor(themeColor);
    if (tg?.setBackgroundColor) tg.setBackgroundColor(themeColor);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
    syncThemeLogos(theme);
    els.themeToggle?.remove();
  }

  function readTheme() {
    safeLocalStorage.removeItem(ADMIN_THEME_KEY);
    return "comfort";
  }

  function syncThemeLogos(theme) {
    document.querySelectorAll("[data-theme-logo]").forEach((image) => {
      const src = image.dataset.src || "";
      if (src && image.getAttribute("src") !== src) {
        image.src = src;
      }
    });
  }
})();
