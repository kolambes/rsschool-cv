const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sourceDb = path.join(__dirname, "..", "data", "app.db");
const testDb = path.join(os.tmpdir(), `bar-bus-smoke-${Date.now()}.db`);
fsSync.copyFileSync(sourceDb, testDb);
process.env.DATABASE_PATH = testDb;
process.env.REQUIRE_TELEGRAM_AUTH = "false";
process.env.BOT_TOKEN = "";
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "smoke-test-admin-key-7f5d7a9d0b1e4c2a";
process.env.ALLOW_ADMIN_ROLE_OVERRIDE = "true";

const { startHttpServer } = require("../server");
const {
  upsertSubscriber,
  getDb,
  getSchedule,
  getTripTimeline,
  dayMaskIncludesServiceDate,
  saveAdmin,
  registerDriverUser,
  deleteDriverUser,
  createDutyRosterUpload
} = require("../db");
const { parseRouteFile } = require("../route-importer");

async function readJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(`${url} failed: ${data.error || response.status}`);
  }
  return data;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(`${url} failed: ${data.error || response.status}`);
  return data;
}

async function deleteJson(url, headers = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    headers
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(`${url} failed: ${data.error || response.status}`);
  return data;
}

async function readText(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return text;
}

async function readAsset(url) {
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return { contentType: response.headers.get("content-type") || "", bytes: buffer.length };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasForbiddenKey(value, forbiddenKeys) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, forbiddenKeys));
  return Object.entries(value).some(([key, nested]) => forbiddenKeys.has(key) || hasForbiddenKey(nested, forbiddenKeys));
}

(async () => {
  const configFailureCheck = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "-e",
      "const { startHttpServer } = require('./server'); (async () => { try { await startHttpServer(0); process.exit(1); } catch (error) { if (/REQUIRE_TELEGRAM_AUTH=true requires BOT_TOKEN/.test(error.message)) process.exit(0); console.error(error); process.exit(2); } })();"
    ],
    {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        DATABASE_PATH: testDb,
        NODE_ENV: "production",
        REQUIRE_TELEGRAM_AUTH: "true",
        BOT_TOKEN: "",
        DISABLE_TELEGRAM_POLLING: "true"
      },
      encoding: "utf8"
    }
  );
  assert(configFailureCheck.status === 0, `Production Telegram auth config should fail closed: ${configFailureCheck.stderr || configFailureCheck.stdout}`);

  const server = await startHttpServer(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminHeaders = {
    "x-admin-key": process.env.ADMIN_KEY,
    "x-admin-role": "admin"
  };

  try {
    const [home, appJs, adminHtml, adminJs, lightLogoAsset, health, bootstrap, adminBootstrap] = await Promise.all([
      readText(`${baseUrl}/`),
      readText(`${baseUrl}/app.js`),
      readText(`${baseUrl}/admin`),
      readText(`${baseUrl}/admin.js`),
      readAsset(`${baseUrl}/bus-park-logo-light-clean.png`),
      readJson(`${baseUrl}/api/health`),
      readJson(`${baseUrl}/api/bootstrap`),
      readJson(`${baseUrl}/api/admin/bootstrap`, adminHeaders)
    ]);
    const routeSearch = await readJson(
      `${baseUrl}/api/routes/search?from=${encodeURIComponent("Торговый дом Дедарина")}&to=${encodeURIComponent("Автовокзал")}&date=2026-06-27&time=08%3A00&limit=3`
    );

    assert(home.includes("quickRoutes"), "Quick route rail is missing");
    assert(
      home.includes("homeRouteSearchOpen") &&
        home.includes("homeRouteSearchMenu") &&
        home.includes("homeRouteSearchForm") &&
        home.includes("homeRouteResults"),
      "Home route search contextual menu is missing"
    );
    assert(appJs.includes("/api/routes/search") && appJs.includes("openHomeRouteResult"), "Home route search logic is missing");
    assert(routeSearch.results?.[0]?.routeNumber === "29" && routeSearch.results?.[0]?.departureTime === "08:09", "ДДМ to Автовокзал should find route 29 at 08:09");
    assert(home.includes("directionChips"), "Direction quick buttons are missing");
    assert(adminHtml.includes('value="staff"') && !adminHtml.includes('value="staff:ads_manager"'), "Notification targets should only include passengers and all staff");
    assert(adminHtml.includes("Работники") && adminHtml.includes("Сохранить работника"), "Workers tab/form labels are missing");
    assert(adminHtml.includes('id="adminSearch"') && adminHtml.includes('placeholder="Табельный № или ФИО"'), "Worker search by tab number and FIO is missing");
    assert(adminHtml.includes("data-driver-squad-field") && !adminHtml.includes('<option value="">Не водитель</option>'), "Driver squad field should not expose a non-driver option");
    assert(home.includes('class="view is-active" data-view="home"'), "Home should be the first visible passenger view");
    assert(!home.includes("homePromo") && !home.includes("home-stats"), "Home should not show promo or schedule stats blocks");
    assert(home.includes("home-actions"), "Home shortcut cards are missing");
    assert(home.includes("appLoader") && home.includes("loader-bus"), "Passenger loading bus screen is missing");
    assert(home.includes('data-open-view="routes"'), "Home schedule action is missing");
    assert(home.includes('data-open-view="service"') && home.includes("Услуги"), "Services home action is missing");
    assert(home.includes('data-nav="service"') && home.includes("nav-services"), "Services bottom tab is missing");
    assert(home.includes('data-nav="about"') && home.includes('data-view="about"') && home.includes("nav-about"), "About tab is missing");
    assert(home.includes("Расписание городских маршрутов"), "Route list schedule title is missing");
    assert(home.includes("schedule-hero"), "Simple route summary is missing from schedule");
    assert(home.includes("schedule-hidden-controls"), "Duplicate schedule selectors should be hidden from passengers");
    assert(home.includes('placeholder="Введите остановку"'), "Human stop search placeholder is missing");
    assert(home.includes('id="appealForm" hidden') && home.includes('class="client-chat" id="clientChat"'), "Appeal should start as one visible chat composer");
    // Extension-agnostic: the crest shipped as PNG historically and as WebP since Wave 40.
    assert(home.includes("/bus-park-logo-light-clean.") && !home.includes("/bus-park-logo-dark-clean."), "Mini App should use only the light park logo");
    assert(!home.includes("themeToggle") && !home.includes('class="theme-button"'), "Mini App theme switch should be removed");
    assert(home.includes('aria-label="Автобусный парк ОАО Барановичи"'), "Passenger logo should keep a readable label");
    assert(!home.includes('class="brand-title"'), "Passenger header should not duplicate logo text below the emblem");
    assert(home.includes("appeal-topic-tabs") && home.includes('value="Обращение"') && home.includes('value="Реклама"') && home.includes('value="СТО"'), "Appeal should keep only appeal, ads and STO tabs");
    assert(!home.includes("appeal-steps"), "Appeal progress stepper should be removed");
    assert(!home.includes('value="Вопрос"') && !home.includes('value="Жалоба"') && !home.includes('value="Предложение"') && !home.includes('value="Благодарность"'), "Old appeal categories should be removed");
    assert(home.includes("routeSearch"), "Route search input is missing");
    assert(appJs.includes("`Маршрут №${route.number}`") && !appJs.includes("`Автобус №${route.number}`"), "Route cards should say route number, not bus number");
    assert(!home.includes('data-nav="news"') && !home.includes("nav-news"), "News bottom tab should be removed");
    assert(!home.includes("newsUnreadDot"), "Unread news red dot should not render without a news tab");
    assert(!home.includes('data-open-view="news"'), "News home action should be removed");
    assert(!home.includes('data-view="news"') && !home.includes("newsFilters") && !appJs.includes('location.hash === "#news"'), "Public news view should stay removed from Mini App");
    assert(!home.includes("staffAdminEntry") && !home.includes("staff-settings-nav"), "Settings entry should not be pre-rendered for passengers");
    assert(home.includes('data-view="favorites"') && appJs.includes("favorite-menu-popover") && appJs.includes("openAlarmBottomSheet") && appJs.includes("ALARM_STATE_KEY"), "Favorites alarm bottom sheet UI is missing");
    assert(appJs.includes("Выключить будильник") && appJs.includes("confirmAndTurnOffFavoriteAlarm"), "Favorites should expose a direct alarm disable action");
    assert(home.includes("imageViewer"), "Image viewer is missing");
    assert(appJs.includes('location.hash === "#service"') && appJs.includes("openServiceDetail"), "Direct service route and detail logic are missing");
    assert(
      !appJs.includes("openServiceAppeal") && !appJs.includes("data-service-write") && !appJs.includes("serviceContinueButton"),
      "Services should be informational and should not open an appeal shortcut"
    );
    assert(appJs.includes('location.hash === "#about"'), "Direct about hash route is missing");
    assert(home.includes("ул. Тельмана, 102") && home.includes("+375 (163) 68-18-91") && home.includes("buspark@brest.by"), "About contacts are missing");
    assert(
      bootstrap.leadership?.some((contact) => contact.name === "Шестак Игорь Михайлович") &&
        bootstrap.leadership?.some((contact) => contact.name === "Мойсейчик Александр Анатольевич"),
      "About leadership cards are missing from bootstrap data"
    );
    const forbiddenPublicStatsKeys = new Set(["appeals", "subscribers", "subscribersToday", "latestImport", "source", "source_dir"]);
    assert(!hasForbiddenKey(bootstrap.stats, forbiddenPublicStatsKeys), "Public bootstrap should not expose operational stats or import metadata");
    assert(!hasForbiddenKey(health.stats, forbiddenPublicStatsKeys), "Public health should not expose operational stats or import metadata");
    assert((home.includes("Сервисный центр МАЗ") || home.includes("сервисный центр МАЗ")) && !home.includes("МАССА"), "Service center should be МАЗ, not МАССА");
    assert(home.includes("Ремонт двигателя") && home.includes("Лазерная очистка металла"), "STO services from the official list are missing");
    assert(home.includes("Аренда автобусов") && home.includes("Рынок «Кірмаш Палескі»"), "Additional services from the official list are missing");
    assert(appJs.includes("serviceCatalog") && appJs.includes("openServiceDetail"), "Service detail modal logic is missing");
    assert(appJs.includes("hashchange"), "Hash navigation listener is missing");
    assert(appJs.includes('setAppealCategory("Обращение")'), "Schedule appeal shortcut should default to appeal mode");
    assert(home.includes("attachmentFiles"), "Appeal attachment input is missing");
    assert(!home.includes("appealVoiceButton") && !home.includes("голосовое"), "Appeal voice recording UI should be removed");
    assert(!home.includes("home-gallery"), "Home image slider should stay removed");
    assert(!home.includes("statsStrip"), "Schedule summary strip should stay removed from the simple UI");
    assert(!home.includes('data-view="board"'), "Stop board view should stay removed");
    assert(adminHtml.includes("appealFilter"), "Appeal filter is missing");
    assert(adminHtml.includes("clearAppeals"), "Appeal clear button is missing");
    assert(adminHtml.includes("/bus-park-logo-light-clean.png") && !adminHtml.includes("/bus-park-logo-dark-clean.png"), "Admin should use only the light park logo");
    assert(adminHtml.includes("admin-hero-title") && adminHtml.includes("НАСТРОЙКИ"), "Settings management hero title is missing");
    assert(!adminHtml.includes("АВТОБУСНЫЙ ПАРК №1") && !adminHtml.includes("ОАО «БАРАНОВИЧИ»"), "Admin header should not duplicate the park name below the logo");
    assert(!adminHtml.includes("adminThemeToggle") && !adminHtml.includes("admin-theme-button"), "Admin theme switch should be removed");
    assert(adminJs.includes('theme = "comfort"') && adminJs.includes('classList.remove("is-dark")'), "Admin should force the comfort theme");
    assert(adminHtml.includes('data-admin-tab="about"') && adminHtml.includes('id="leadershipForm"') && adminJs.includes("loadLeadershipContacts"), "Admin editable About/leadership panel is missing");
    assert(adminHtml.includes('data-admin-tab="services"') && adminHtml.includes('id="serviceForm"') && adminJs.includes("loadServices"), "Admin editable services panel is missing");
    assert(
      adminHtml.includes('data-admin-tab="roster"') &&
        adminHtml.includes('id="rosterUploadForm"') &&
        adminHtml.includes('name="driverSquad"') &&
        adminHtml.includes("roster-driver-source") &&
        !adminHtml.includes('id="rosterDriverForm"'),
      "Admin duty roster panel should use workers as the driver source"
    );
    assert(adminJs.includes("hiddenAdminTabs") && adminJs.includes('"ads"'), "Admin advertising tab should stay hidden from the UI");
    assert(adminJs.includes("renderRosterDrivers") && adminJs.includes("uploadDutyRoster") && adminJs.includes("/api/admin/roster/upload"), "Admin duty roster upload logic is missing");
    assert(adminHtml.includes("clearRosterUploads") && adminJs.includes("clearDutyRosterUploads"), "Admin duty roster journal clear UI is missing");
    assert(appJs.includes("renderLeadership") && appJs.includes("state.data?.leadership"), "Mini App dynamic leadership rendering is missing");
    assert(adminHtml.includes('value="worker"') && adminHtml.includes('value="sto_manager"') && !adminHtml.includes('value="appeals_manager"'), "Worker role option should replace appeals role in Admin");
    assert(adminHtml.includes('<option value="open">Открытые</option>') && !adminHtml.includes('<option value="in_progress">В работе</option>'), "Appeal filter should use open/closed wording");
    assert(adminHtml.includes("subscribersDelta"), "Subscriber daily delta badge is missing");
    assert(
      adminHtml.includes('data-admin-tab="visits"') &&
        adminHtml.includes('data-admin-panel="visits"') &&
        adminHtml.includes("visitsTodayCount") &&
        adminHtml.includes("visitsWeekCount") &&
        adminHtml.includes("visitsMonthCount"),
      "Admin visit stats tab is missing"
    );
    assert(adminHtml.includes('id="saveKey" type="button">Принять'), "Admin access button should say accept");
    assert(!adminHtml.includes('id="newCount"'), "Standalone new counter should be removed");
    assert(adminHtml.includes("scheduleRouteSelect"), "Admin schedule editor is missing");
    assert(adminHtml.includes("scheduleImportForm") && adminHtml.includes("accept=\".xml,text/xml,application/xml\"") && adminHtml.includes('value="replace_all"'), "Admin XML schedule import UI is missing");
    assert(adminHtml.includes('name="transportType"') && adminHtml.includes('value="suburban"') && adminHtml.includes('value="intercity"'), "Admin transport type selector for XML import is missing");
    assert(adminHtml.includes("scheduleBackupList") && adminHtml.includes("Откат расписания"), "Admin schedule rollback UI is missing");
    assert(!adminHtml.includes('<option value="1111111">Каждый день</option>'), "Every-day schedule option should be removed from admin editor");
    assert(adminHtml.includes("saveScheduleTimeButton"), "Explicit add schedule time button is missing");
    assert(adminHtml.includes("clearScheduleAudit"), "Schedule audit clear button is missing");
    assert(adminHtml.includes("clearNotifications"), "Notification clear-all button is missing");
    assert(adminHtml.includes("clearNotificationForm"), "Notification form clear button is missing");
    assert(!adminHtml.includes('data-admin-tab="news"') && !adminHtml.includes('data-admin-panel="news"') && !adminHtml.includes('id="newsForm"'), "Admin news tab/form should be removed");
    assert(!adminJs.includes('can("news") ? loadNews()') && !adminJs.includes("newsFormJson") && !adminJs.includes("applyNewsFormat"), "Admin news editor logic should be removed");
    assert(lightLogoAsset.contentType.includes("image/png"), "Park logo is not served as PNG");
    assert(lightLogoAsset.bytes > 100000, "Park logo asset looks too small");
    const cityRoutes = bootstrap.routes.filter((route) => !String(route.id || "").includes(":"));
    const suburbanRoutes = bootstrap.routes.filter((route) => String(route.id || "").startsWith("suburban:"));
    const intercityRoutes = bootstrap.routes.filter((route) => String(route.id || "").startsWith("intercity:"));
    assert(cityRoutes.length === 33, "Bootstrap should contain all 33 city routes");
    assert(suburbanRoutes.length >= 100, "Bootstrap should contain imported suburban routes");
    assert(intercityRoutes.length >= 5, "Bootstrap should contain imported intercity routes");
    const route1 = bootstrap.routes.find((route) => route.number === "1");
    const route1Outbound = route1?.directions?.find((direction) => direction.from === "ГАЗ-Институт");
    assert(route1Outbound?.stops?.[0]?.name === "ГАЗ-Институт", "Route 1 passenger scheme should start from the declared main terminal");
    assert(
      route1Outbound?.extraStartStops?.some((stop) => stop.name === "Кладбище Русино"),
      "Route 1 should keep cemetery starts as additional starts, not the default scheme start"
    );
    const route5 = bootstrap.routes.find((route) => route.number === "5");
    const route5Outbound = route5?.directions?.find((direction) => direction.from === "Сквер Героя Карвата");
    assert(route5Outbound?.stops?.[0]?.name === "Сквер Героя Карвата", "Route 5 passenger scheme should start from the earlier main terminal Карвата");
    assert(
      route5Outbound?.extraStartStops?.some((stop) => stop.name === "Ул. 50 лет ВЛКСМ"),
      "Route 5 should keep ВЛКСМ starts as additional starts, not the default scheme start"
    );
    const route5ScheduleUrl = new URL(`${baseUrl}/api/schedule`);
    route5ScheduleUrl.searchParams.set("routeId", route5.id);
    route5ScheduleUrl.searchParams.set("directionCode", route5Outbound.code);
    route5ScheduleUrl.searchParams.set("stopUid", route5Outbound.stops[0].id);
    const route5Schedule = await readJson(route5ScheduleUrl.toString());
    const route5Times = route5Schedule.groups.flatMap((group) => (group.times || []).map((time) => ({ ...time, dayMask: group.dayMask })));
    const route5ExtraStartTime = route5Times.find((time) => time.originStop === "Ул. 50 лет ВЛКСМ");
    assert(route5ExtraStartTime, "Route 5 schedule from Карвата should still identify trips that start at ВЛКСМ");
    const route5TimelineUrl = new URL(`${baseUrl}/api/trip/timeline`);
    route5TimelineUrl.searchParams.set("routeId", route5.id);
    route5TimelineUrl.searchParams.set("directionCode", route5Outbound.code);
    route5TimelineUrl.searchParams.set("dayMask", route5ExtraStartTime.dayMask);
    route5TimelineUrl.searchParams.set("tripCode", route5ExtraStartTime.tripCode);
    route5TimelineUrl.searchParams.set("variantCode", route5ExtraStartTime.variantCode);
    const route5Timeline = await readJson(route5TimelineUrl.toString());
    assert(route5Timeline.timeline?.[0]?.stopName === "Ул. 50 лет ВЛКСМ", "Route 5 timeline should begin with the actual ВЛКСМ extra start");
    assert(route5Timeline.timeline?.[0]?.timelineOnly === true, "Route 5 extra start should be shown as timeline-only in the main scheme");
    assert(
      route5Timeline.timeline?.some((stop) => stop.stopName === "Сквер Героя Карвата" && !stop.timelineOnly),
      "Route 5 timeline should continue through the main Карвата terminal"
    );
    const route7 = bootstrap.routes.find((route) => route.number === "7");
    assert(
      route7?.directions?.some((direction) => direction.from === "С-П Магистральный" && direction.to === "ДЭС"),
      "Route 7 should include the passenger direction С-П Магистральный -> ДЭС"
    );
    assert(
      route7?.directions?.some((direction) => direction.from === "ДЭС" && direction.to === "С-П Магистральный"),
      "Route 7 should include the passenger direction ДЭС -> С-П Магистральный"
    );
    const route7Outbound = route7?.directions?.find((direction) => direction.to === "ДЭС");
    const route7FirstStop = route7Outbound?.stops?.[0];
    assert(route7Outbound && route7FirstStop, "Route 7 outbound direction should have a first stop");
    const route7ScheduleUrl = new URL(`${baseUrl}/api/schedule`);
    route7ScheduleUrl.searchParams.set("routeId", route7.id);
    route7ScheduleUrl.searchParams.set("directionCode", route7Outbound.code);
    route7ScheduleUrl.searchParams.set("stopUid", route7FirstStop.id);
    const route7Schedule = await readJson(route7ScheduleUrl.toString());
    const route7Times = route7Schedule.groups.flatMap((group) => (group.times || []).map((time) => ({ ...time, dayMask: group.dayMask })));
    assert(
      route7Times.some((time) => time.originStop === "Автобусный парк" && time.destinationStop === "ДЭС" && String(time.viaLabel || "").includes("Автобусного парка")),
      "Route 7 should keep feeder trips from Автобусный парк through С-П Магистральный"
    );
    const route7FeederTime = route7Times.find((time) => time.time === "06:17" && time.tripStopCount >= 27)
      || route7Times.find((time) => String(time.viaLabel || "").includes("Автобусного парка") && time.tripStopCount >= 27);
    assert(route7FeederTime, "Route 7 should expose a linked feeder departure for timeline checks");
    const route7TimelineUrl = new URL(`${baseUrl}/api/trip/timeline`);
    route7TimelineUrl.searchParams.set("routeId", route7.id);
    route7TimelineUrl.searchParams.set("directionCode", route7Outbound.code);
    route7TimelineUrl.searchParams.set("dayMask", route7FeederTime.dayMask);
    route7TimelineUrl.searchParams.set("tripCode", route7FeederTime.tripCode);
    route7TimelineUrl.searchParams.set("variantCode", route7FeederTime.variantCode);
    const route7Timeline = await readJson(route7TimelineUrl.toString());
    assert(route7Timeline.timeline?.[0]?.timelineOnly === true, "Route 7 feeder trip should show its primary origin in the route timeline");
    assert(route7Timeline.timeline?.[1]?.stopName === "С-П Магистральный", "Route 7 feeder timeline should continue through С-П Магистральный");
    const route18 = bootstrap.routes.find((route) => route.number === "18");
    const route18Loop = route18?.directions?.find((direction) => direction.from === "Ул. Королика" && direction.to === "Ул. Королика");
    const route18FirstStop = route18Loop?.stops?.[0];
    assert(route18Loop && route18FirstStop, "Route 18 loop direction should be available");
    const route18Schedule = getSchedule({ routeId: route18.id, directionCode: route18Loop.code, stopUid: route18FirstStop.id });
    const route18Times = route18Schedule.groups
      .flatMap((group) => (group.times || []).map((time) => ({ ...time, dayMask: group.dayMask })));
    const route18EarlyLoop = route18Times
      .find((time) => time.tripCode === "1857" && time.variantCode === "61");
    assert(route18EarlyLoop?.tripStopCount === 21, "Route 18 split XML trip should be linked into the full loop");
    assert(
      !route18Times.some((time) => time.time === "11:30" && time.tripCode === "1868" && time.variantCode === "61"),
      "Route 18 terminal arrival should not be listed as a departure from the first loop stop"
    );
    const route18MiddayLoop = route18Times
      .find((time) => time.time === "11:36" && time.tripCode === "1870" && time.variantCode === "61");
    assert(route18MiddayLoop?.tripStopCount === 21, "Route 18 next loop after a terminal arrival should remain selectable");
    const route18Timeline = getTripTimeline({
      routeId: route18.id,
      directionCode: route18Loop.code,
      dayMask: route18EarlyLoop.dayMask,
      tripCode: route18EarlyLoop.tripCode,
      variantCode: route18EarlyLoop.variantCode
    });
    assert(route18Timeline.some((stop) => stop.stopName === "Ул. Красноармейская" && stop.time === "06:27"), "Route 18 timeline should continue after Стройтрест");
    assert(route18Timeline.at(-1)?.stopName === "Ул. Королика", "Route 18 linked timeline should finish at Ул. Королика");
    const route18MiddayTimeline = getTripTimeline({
      routeId: route18.id,
      directionCode: route18Loop.code,
      dayMask: route18MiddayLoop.dayMask,
      tripCode: route18MiddayLoop.tripCode,
      variantCode: route18MiddayLoop.variantCode
    });
    assert(route18MiddayTimeline.length === 21, "Route 18 11:36 loop should include every loop stop");
    assert(route18MiddayTimeline.some((stop) => stop.position === 14 && stop.time === "12:11"), "Route 18 11:36 loop should continue after the midpoint");
    const route17 = bootstrap.routes.find((route) => route.number === "17");
    assert(route17 && route17.directions?.[0]?.stops?.length >= 10, "Route 17 schedule is missing");
    assert(bootstrap.stats.departures > 40000, "Departure count looks wrong");
    const duplicateAdjacentStops = getDb()
      .prepare(`
        SELECT current.stop_uid
        FROM stops current
        JOIN stops previous
          ON previous.route_id = current.route_id
         AND previous.direction_code = current.direction_code
         AND previous.position = current.position - 1
        WHERE previous.export_stop_id = current.export_stop_id
          AND previous.normalized_name = current.normalized_name
      `)
      .all();
    assert(duplicateAdjacentStops.length === 0, "Consecutive duplicate stops should be merged");
    const singleStopXmlTrips = getDb()
      .prepare(`
        WITH single_stop_trips AS (
          SELECT r.number, dep.route_id AS routeId, dep.direction_code AS directionCode,
                 dep.day_mask AS dayMask, dep.trip_code AS tripCode, dep.variant_code AS variantCode,
                 MIN(dep.stop_uid) AS stopUid,
                 MIN(dep.departure_minutes) AS departureMinutes,
                 MIN(s.position) AS position,
                 COUNT(DISTINCT dep.stop_uid) AS stopCount
          FROM departures dep
          JOIN routes r ON r.route_id = dep.route_id
          JOIN stops s ON s.stop_uid = dep.stop_uid
          WHERE COALESCE(r.source_file, '') LIKE '%.xml'
            AND COALESCE(dep.trip_code, '') <> ''
            AND COALESCE(dep.variant_code, '') <> ''
            AND COALESCE(dep.trip_code, '') NOT LIKE 'manual-%'
            AND LOWER(COALESCE(dep.variant_code, '')) <> 'manual'
          GROUP BY dep.route_id, dep.direction_code, dep.day_mask, dep.trip_code, dep.variant_code
          HAVING stopCount <= 1
        )
        SELECT *
        FROM single_stop_trips trip
        WHERE NOT EXISTS (
          SELECT 1
          FROM departures dep
          JOIN departures next_dep ON next_dep.route_id = dep.route_id
            AND next_dep.direction_code = dep.direction_code
            AND next_dep.day_mask = dep.day_mask
            AND next_dep.trip_code = dep.trip_code
            AND next_dep.variant_code = dep.variant_code
          JOIN stops next_stop ON next_stop.stop_uid = next_dep.stop_uid
          WHERE dep.route_id = trip.routeId
            AND dep.direction_code = trip.directionCode
            AND dep.day_mask = trip.dayMask
            AND dep.variant_code = trip.variantCode
            AND dep.trip_code <> trip.tripCode
            AND dep.stop_uid = trip.stopUid
            AND dep.departure_minutes BETWEEN trip.departureMinutes AND trip.departureMinutes + 5
            AND next_stop.position > trip.position
        )
      `)
      .all();
    assert(singleStopXmlTrips.length === 0, "XML import should not keep one-stop trip records");
    assert(dayMaskIncludesServiceDate("0000011", new Date(2026, 3, 20)), "Extra rest day should use weekend service masks");
    assert(!dayMaskIncludesServiceDate("1111100", new Date(2026, 3, 20)), "Extra rest day should not use weekday masks");
    assert(dayMaskIncludesServiceDate("1000000", new Date(2026, 3, 25)), "Extra work Saturday should use the replacement weekday mask");
    assert(!dayMaskIncludesServiceDate("0000011", new Date(2026, 3, 25)), "Extra work Saturday should not use weekend masks");
    const route28Schedule = getSchedule({ routeId: "186", directionCode: "1", stopUid: "186:1:19:85" });
    const route28EightOhTwo = route28Schedule.groups.flatMap((group) => group.times || []).filter((item) => item.time === "08:02");
    assert(route28EightOhTwo.length >= 2, "Schedule API should keep same-time trip variants separate");
    const route9DailyTimeline = getTripTimeline({
      routeId: "226",
      directionCode: "0",
      dayMask: "1111111",
      tripCode: "1122",
      variantCode: "45"
    });
    assert(route9DailyTimeline.length > 0, "Daily trip timeline should be fetched with the original day mask");
    assert(Number.isInteger(adminBootstrap.stats.subscribersToday), "Subscriber daily stat is missing");
    const adminVisitStats = await readJson(`${baseUrl}/api/admin/visits`, adminHeaders);
    assert(
      adminBootstrap.stats.visits &&
        adminVisitStats.visits &&
        Number.isInteger(adminVisitStats.visits.today) &&
        Number.isInteger(adminVisitStats.visits.week) &&
        Number.isInteger(adminVisitStats.visits.month),
      "Visit stats are missing from admin-only endpoint"
    );
    const dispatcherHeaders = { ...adminHeaders, "x-admin-role": "dispatcher" };
    const dispatcherBootstrap = await readJson(`${baseUrl}/api/admin/bootstrap`, dispatcherHeaders);
    assert(!dispatcherBootstrap.stats.visits, "Dispatcher bootstrap should not include visit stats");
    const dispatcherVisitStats = await fetch(`${baseUrl}/api/admin/visits`, { headers: dispatcherHeaders });
    assert(dispatcherVisitStats.status === 403, "Dispatcher should not access visit stats");
    await readText(`${baseUrl}/`);
    const adminVisitStatsAfterVisit = await readJson(`${baseUrl}/api/admin/visits`, adminHeaders);
    assert(
      adminVisitStatsAfterVisit.visits.today >= adminVisitStats.visits.today + 1,
      "Opening the public app should increment today's visit count"
    );
    assert(adminBootstrap.admin.role === "admin", "Admin bootstrap did not return admin role");
    upsertSubscriber({ telegramId: `700${Date.now()}`, firstName: "Smoke subscriber" });
    const adminBootstrapAfterSubscriber = await readJson(`${baseUrl}/api/admin/bootstrap`, adminHeaders);
    assert(adminBootstrapAfterSubscriber.stats.subscribers >= adminBootstrap.stats.subscribers + 1, "Subscriber total did not update");
    assert(
      adminBootstrapAfterSubscriber.stats.subscribersToday >= adminBootstrap.stats.subscribersToday + 1,
      "Subscriber daily delta did not update"
    );

    const rosterBefore = await readJson(`${baseUrl}/api/admin/roster`, adminHeaders);
    assert(Array.isArray(rosterBefore.drivers) && Array.isArray(rosterBefore.uploads), "Duty roster API did not return drivers and uploads");
    const blockedDriverTelegramId = `802${Date.now()}`;
    const blockedRosterDriverCreate = await fetch(`${baseUrl}/api/admin/roster/drivers`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({ telegramId: blockedDriverTelegramId, tabNumber: "4833", fullName: "Blocked Driver" })
    });
    assert(blockedRosterDriverCreate.status === 403, "ADMIN_KEY should not create persistent driver staff access");
    const blockedDriverRow = getDb().prepare("SELECT driver_id FROM driver_users WHERE telegram_id = ?").get(blockedDriverTelegramId);
    const blockedDriverAdminRow = getDb().prepare("SELECT admin_id FROM admins WHERE telegram_id = ?").get(blockedDriverTelegramId);
    assert(!blockedDriverRow && !blockedDriverAdminRow, "Blocked ADMIN_KEY driver creation should not persist staff rows");

    const savedRosterDriver = registerDriverUser({ telegramId: `800${Date.now()}`, tabNumber: "4832", fullName: "Smoke Driver" });
    assert(savedRosterDriver?.tabNumber === "4832", "Duty roster driver was not saved by tab number");
    const rosterWithDriver = await readJson(`${baseUrl}/api/admin/roster`, adminHeaders);
    assert(rosterWithDriver.drivers.some((driver) => driver.id === savedRosterDriver.id), "Saved duty roster driver is missing from the list");
    deleteDriverUser(savedRosterDriver.id);
    const rosterAfterDriverDelete = await readJson(`${baseUrl}/api/admin/roster`, adminHeaders);
    assert(!rosterAfterDriverDelete.drivers.some((driver) => driver.id === savedRosterDriver.id), "Duty roster driver was not deleted");
    const rosterUploadToClear = createDutyRosterUpload({
      fileName: "smoke-roster.csv",
      fileHash: `smoke-roster-${Date.now()}:city`,
      scheduleDate: "2026-06-19",
      status: "parsed",
      uploadedBy: "Smoke test",
      targetSquad: "city",
      items: [
        {
          scheduleDate: "2026-06-19",
          tabNumber: "4832",
          driverName: "Smoke Driver",
          route: "1"
        }
      ]
    });
    const rosterWithUpload = await readJson(`${baseUrl}/api/admin/roster`, adminHeaders);
    assert(rosterWithUpload.uploads.some((upload) => upload.id === rosterUploadToClear.id), "Duty roster test upload is missing before clear");
    const dispatcherRosterClear = await fetch(`${baseUrl}/api/admin/roster`, {
      method: "DELETE",
      headers: { ...adminHeaders, "x-admin-role": "dispatcher" }
    });
    assert(dispatcherRosterClear.status === 403, "Dispatcher should not clear duty roster uploads");
    const clearRosterUploads = await deleteJson(`${baseUrl}/api/admin/roster`, adminHeaders);
    assert(clearRosterUploads.deleted >= 1, "Duty roster journal clear did not delete uploads");
    const rosterAfterClear = await readJson(`${baseUrl}/api/admin/roster`, adminHeaders);
    assert(!rosterAfterClear.uploads.some((upload) => upload.id === rosterUploadToClear.id), "Duty roster journal was not cleared");

    const route = bootstrap.routes[0];
    const direction = route.directions[0];
    const stop = direction.stops[0];
    const scheduleUrl = new URL(`${baseUrl}/api/schedule`);
    scheduleUrl.searchParams.set("routeId", route.id);
    scheduleUrl.searchParams.set("directionCode", direction.code);
    scheduleUrl.searchParams.set("stopUid", stop.id);
    const schedule = await readJson(scheduleUrl.toString());
    assert(schedule.groups.length > 0, "Schedule groups are empty");
    assert(schedule.groups.some((group) => group.times.length > 0), "Schedule times are empty");
    const firstTimeGroup = schedule.groups.find((group) => group.times.length > 0);
    const firstTime = firstTimeGroup.times[0];
    assert(firstTime.destinationStop, "Schedule time should include final stop for the trip");
    const timelineUrl = new URL(`${baseUrl}/api/trip/timeline`);
    timelineUrl.searchParams.set("routeId", route.id);
    timelineUrl.searchParams.set("directionCode", direction.code);
    timelineUrl.searchParams.set("dayMask", firstTimeGroup.dayMask);
    timelineUrl.searchParams.set("tripCode", firstTime.tripCode);
    timelineUrl.searchParams.set("variantCode", firstTime.variantCode);
    const timeline = await readJson(timelineUrl.toString());
    assert(timeline.timeline.length > 1, "Trip timeline is empty");

    const searchUrl = new URL(`${baseUrl}/api/stops/search`);
    searchUrl.searchParams.set("q", stop.name);
    const search = await readJson(searchUrl.toString());
    assert(search.stops.length > 0, "Stop search did not find the selected stop");

    const [appeals, ads, adminNews, notifications, admins] = await Promise.all([
      readJson(`${baseUrl}/api/admin/appeals`, adminHeaders),
      readJson(`${baseUrl}/api/admin/ads`, adminHeaders),
      readJson(`${baseUrl}/api/admin/news`, adminHeaders),
      readJson(`${baseUrl}/api/admin/notifications`, adminHeaders),
      readJson(`${baseUrl}/api/admin/admins`, adminHeaders)
    ]);

    assert(Array.isArray(appeals.appeals), "Appeals API did not return a list");
    assert(Array.isArray(ads.ads), "Ads API did not return a list");
    assert(Array.isArray(adminNews.news), "Admin news API did not return a list");
    assert(Array.isArray(notifications.notifications), "Notifications API did not return a list");
    assert(Array.isArray(admins.admins), "Admins API did not return a list");
    const dispatcherNews = await fetch(`${baseUrl}/api/admin/news`, {
      headers: { ...adminHeaders, "x-admin-role": "dispatcher" }
    });
    assert(dispatcherNews.status === 403, "Dispatcher should not manage admin news");

    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const createdAd = await postJson(
      `${baseUrl}/api/admin/ads`,
      {
        title: "Smoke реклама с картинкой",
        text: "Проверка загрузки и удаления изображения",
        label: "Реклама",
        placement: "home",
        displaySeconds: 5,
        status: "active",
        startsAt: "2026-01-01",
        endsAt: "2026-12-31",
        imageName: "smoke.png",
        imageData: tinyPng
      },
      adminHeaders
    );
    assert(createdAd.ad.imageUrl?.startsWith("/uploads/ads/"), "Ad image was not saved");
    assert(createdAd.ad.placement === "home", "Home promo ad placement was not saved");
    assert(createdAd.ad.displaySeconds === 5, "Home promo display timer was not saved");
    const uploadedAdImage = await readAsset(`${baseUrl}${createdAd.ad.imageUrl}`);
    assert(uploadedAdImage.contentType.includes("image/png"), "Uploaded ad image is not served as PNG");
    await deleteJson(`${baseUrl}/api/admin/ads/${encodeURIComponent(createdAd.ad.id)}`, adminHeaders);
    const deletedAdImage = await fetch(`${baseUrl}${createdAd.ad.imageUrl}`);
    assert(deletedAdImage.status === 404, "Deleted ad image should be removed from public uploads");

    const createdNotification = await postJson(
      `${baseUrl}/api/admin/notifications`,
      {
        title: "Smoke уведомление",
        text: "Проверка удаления уведомления",
        sendNow: false
      },
      adminHeaders
    );
    await deleteJson(`${baseUrl}/api/admin/notifications/${encodeURIComponent(createdNotification.notification.id)}`, adminHeaders);
    await postJson(
      `${baseUrl}/api/admin/notifications`,
      { title: "Smoke clear one", text: "Clear notification one", sendNow: false },
      adminHeaders
    );
    await postJson(
      `${baseUrl}/api/admin/notifications`,
      { title: "Smoke clear two", text: "Clear notification two", sendNow: false },
      adminHeaders
    );
    const clearNotificationsResult = await deleteJson(`${baseUrl}/api/admin/notifications`, adminHeaders);
    assert(clearNotificationsResult.deleted >= 2, "Notification clear-all endpoint did not delete created items");
    const notificationsAfterClear = await readJson(`${baseUrl}/api/admin/notifications`, adminHeaders);
    assert(notificationsAfterClear.notifications.length === 0, "Notification list was not cleared");

    const blockedAdminTelegramId = `901${Date.now()}`;
    const blockedAdminCreate = await fetch(`${baseUrl}/api/admin/admins`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        telegramId: blockedAdminTelegramId,
        name: "Blocked key admin",
        role: "admin",
        active: true
      })
    });
    assert(blockedAdminCreate.status === 403, "ADMIN_KEY should not create persistent staff/admin accounts");
    const blockedAdminRow = getDb().prepare("SELECT admin_id FROM admins WHERE telegram_id = ?").get(blockedAdminTelegramId);
    assert(!blockedAdminRow, "Blocked ADMIN_KEY staff creation should not persist an admin row");

    const staffTelegramId = `900${Date.now()}`;
    const savedStaff = saveAdmin({
      telegramId: staffTelegramId,
      name: "Smoke staff",
      role: "ads_manager",
      driverSquad: "regional",
      active: true
    });
    assert(savedStaff.telegramId === staffTelegramId, "Admin employee Telegram ID was not saved");
    assert(savedStaff.role === "ads_manager", "Admin employee role was not saved");
    assert(!savedStaff.driverSquad, "Non-driver employee should not keep a driver squad");
    const notificationsWithStaff = await readJson(`${baseUrl}/api/admin/notifications`, adminHeaders);
    assert(
      notificationsWithStaff.staffRecipients.some((recipient) => recipient.telegramId === staffTelegramId),
      "Staff notification recipients should include active employees with Telegram ID"
    );
    const createdStaffNotification = await postJson(
      `${baseUrl}/api/admin/notifications`,
      {
        title: "Smoke staff notice",
        text: "Closed staff-only notification",
        target: "staff",
        sendNow: false
      },
      adminHeaders
    );
    assert(createdStaffNotification.notification.target === "staff", "Staff-only notification target was not saved");
    await deleteJson(`${baseUrl}/api/admin/notifications/${encodeURIComponent(createdStaffNotification.notification.id)}`, adminHeaders);
    const createdInvalidRoleNotification = await postJson(
      `${baseUrl}/api/admin/notifications`,
      {
        title: "Smoke invalid role notice",
        text: "Role notification target should fall back to passengers",
        target: "staff:ads_manager",
        sendNow: false
      },
      adminHeaders
    );
    assert(createdInvalidRoleNotification.notification.target === "all", "Unsupported role notification target should fall back to passengers");
    await deleteJson(`${baseUrl}/api/admin/notifications/${encodeURIComponent(createdInvalidRoleNotification.notification.id)}`, adminHeaders);

    const adminRoutes = await readJson(`${baseUrl}/api/admin/schedule/routes`, adminHeaders);
    assert(adminRoutes.routes.length >= 30, "Admin schedule route list is empty");
    const metaResult = await postJson(
      `${baseUrl}/api/admin/schedule/meta`,
      {
        routeId: route.id,
        directionCode: direction.code,
        stopUid: stop.id,
        routeName: route.name,
        origin: direction.from,
        destination: direction.to,
        stopName: stop.name,
        color: route.color || "#2563eb"
      },
      adminHeaders
    );
    assert(metaResult.ok, "Admin schedule meta editor did not save");
    const adminDeparturesUrl = new URL(`${baseUrl}/api/admin/schedule/departures`);
    adminDeparturesUrl.searchParams.set("routeId", route.id);
    adminDeparturesUrl.searchParams.set("directionCode", direction.code);
    adminDeparturesUrl.searchParams.set("stopUid", stop.id);
    const adminDepartures = await readJson(adminDeparturesUrl.toString(), adminHeaders);
    assert(adminDepartures.departures.length > 0, "Admin schedule departures are empty");
    const createdDeparture = await postJson(
      `${baseUrl}/api/admin/schedule/departures`,
      {
        routeId: route.id,
        directionCode: direction.code,
        stopUid: stop.id,
        dayMask: "1111111",
        time: "23:58",
        notes: "smoke schedule"
      },
      adminHeaders
    );
    assert(createdDeparture.departure.id, "Admin schedule did not create a departure");
    const updatedDeparture = await postJson(
      `${baseUrl}/api/admin/schedule/departures`,
      {
        id: createdDeparture.departure.id,
        dayMask: "1111111",
        time: "23:59",
        notes: "smoke schedule updated",
        applyToTrip: false
      },
      adminHeaders
    );
    assert(updatedDeparture.departure.time === "23:59", "Admin schedule did not update a departure");
    const deleteResponse = await fetch(`${baseUrl}/api/admin/schedule/departures/${createdDeparture.departure.id}`, {
      method: "DELETE",
      headers: adminHeaders
    });
    assert(deleteResponse.ok, "Admin schedule did not delete a departure");
    const audit = await readJson(`${baseUrl}/api/admin/schedule/audit`, adminHeaders);
    assert(audit.changes.length >= 3, "Schedule audit log did not record admin changes");
    const dispatcherAuditDelete = await fetch(`${baseUrl}/api/admin/schedule/audit/${audit.changes[0].id}`, {
      method: "DELETE",
      headers: { ...adminHeaders, "x-admin-role": "dispatcher" }
    });
    assert(dispatcherAuditDelete.status === 403, "Dispatcher should not delete individual schedule audit records");
    await deleteJson(`${baseUrl}/api/admin/schedule/audit/${audit.changes[0].id}`, adminHeaders);
    const auditAfterDelete = await readJson(`${baseUrl}/api/admin/schedule/audit`, adminHeaders);
    assert(!auditAfterDelete.changes.some((change) => change.id === audit.changes[0].id), "Schedule audit item was not deleted");
    const clearAudit = await deleteJson(`${baseUrl}/api/admin/schedule/audit`, adminHeaders);
    assert(clearAudit.deleted >= 1, "Schedule audit clear did not delete entries");
    const auditAfterClear = await readJson(`${baseUrl}/api/admin/schedule/audit`, adminHeaders);
    assert(auditAfterClear.changes.length === 0, "Schedule audit log was not cleared");

    const appealResult = await postJson(`${baseUrl}/api/appeals`, {
      category: "Жалоба",
      assignedRole: "driver",
      text: "Тестовое обращение для проверки чата",
      attachments: [{ data: tinyPng, name: "appeal-smoke.png" }]
    });
    assert(appealResult.appeal.clientToken, "Client chat token was not returned");
    const createdAppeals = await readJson(`${baseUrl}/api/admin/appeals`, adminHeaders);
    const createdAppeal = createdAppeals.appeals.find((appeal) => appeal.id === appealResult.appeal.id);
    assert(createdAppeal?.assignedRole === "moderator", "Client-supplied assignedRole should be ignored for public appeals");

    const profanityResponse = await fetch(`${baseUrl}/api/appeals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: "Жалоба",
        text: "Тест с б.л.я.дским словом для фильтра"
      })
    });
    const profanityResult = await profanityResponse.json();
    assert(profanityResponse.status === 400, "Profanity filter should reject dirty appeal text");
    assert(/ненормативную лексику/i.test(profanityResult.error || ""), "Profanity filter returned an unclear error");

    const clientMessages = await readJson(`${baseUrl}/api/appeals/${appealResult.appeal.id}/messages`, {
      "x-appeal-token": appealResult.appeal.clientToken
    });
    assert(clientMessages.messages.length === 1, "Initial client chat message is missing");
    assert(clientMessages.messages[0].attachments?.[0]?.type === "image", "Appeal image attachment was not saved");
    const signedAttachmentUrl = clientMessages.messages[0].attachments[0].url;
    const directAttachmentUrl = signedAttachmentUrl.replace(/^\/api\/files\/appeals\//, "/uploads/appeals/").split("?")[0];
    const directAttachment = await fetch(`${baseUrl}${directAttachmentUrl}`);
    assert(directAttachment.status === 403, "Private appeal attachment should not be served directly from public uploads");
    const signedAttachment = await readAsset(`${baseUrl}${signedAttachmentUrl}`);
    assert(signedAttachment.contentType.includes("image/png"), "Signed appeal attachment route should serve the uploaded image");
    const tamperedAttachmentUrl = new URL(signedAttachmentUrl, baseUrl);
    tamperedAttachmentUrl.searchParams.set("sig", "bad-signature");
    const tamperedAttachment = await fetch(tamperedAttachmentUrl);
    assert(tamperedAttachment.status === 403, "Tampered appeal attachment signature should be rejected");
    const expiredAttachmentUrl = new URL(signedAttachmentUrl, baseUrl);
    expiredAttachmentUrl.searchParams.set("expires", "1");
    const expiredAttachment = await fetch(expiredAttachmentUrl);
    assert(expiredAttachment.status === 403, "Expired appeal attachment signature should be rejected");

    await postJson(`${baseUrl}/api/appeals/${appealResult.appeal.id}/messages`, {
      clientToken: appealResult.appeal.clientToken,
      text: "Дополнительное сообщение клиента"
    });
    await postJson(`${baseUrl}/api/admin/appeals/${appealResult.appeal.id}/messages`, { text: "Ответ администратора" }, adminHeaders);
    const adminChat = await readJson(`${baseUrl}/api/admin/appeals/${appealResult.appeal.id}/messages`, adminHeaders);
    assert(adminChat.messages.length >= 3, "Admin chat did not collect messages");

    const adAppeal = await postJson(`${baseUrl}/api/appeals`, {
      category: "Реклама",
      text: "Тестовое рекламное обращение"
    });
    const adsRoleAppeals = await readJson(`${baseUrl}/api/admin/appeals`, {
      ...adminHeaders,
      "x-admin-role": "ads_manager"
    });
    assert(adsRoleAppeals.appeals.every((appeal) => appeal.category === "Реклама"), "Ads role can see non-ad appeals");
    assert(adsRoleAppeals.appeals.some((appeal) => appeal.id === adAppeal.appeal.id), "Ads role does not see ad appeal");

    const stoAppeal = await postJson(`${baseUrl}/api/appeals`, {
      category: "СТО",
      text: "Нужна консультация по СТО и сервисному центру МАЗ"
    });
    const stoRoleAppeals = await readJson(`${baseUrl}/api/admin/appeals`, {
      ...adminHeaders,
      "x-admin-role": "sto_manager"
    });
    assert(stoRoleAppeals.appeals.every((appeal) => appeal.category === "СТО"), "STO role can see non-service appeals");
    assert(stoRoleAppeals.appeals.some((appeal) => appeal.id === stoAppeal.appeal.id), "STO role does not see service appeal");

    const clearAppealsResult = await deleteJson(`${baseUrl}/api/admin/appeals`, adminHeaders);
    assert(clearAppealsResult.deleted >= 3, "Appeal clear endpoint did not delete created appeals");
    const appealsAfterClear = await readJson(`${baseUrl}/api/admin/appeals`, adminHeaders);
    assert(appealsAfterClear.appeals.length === 0, "Appeals list was not cleared");

    const endpointOnlyXml = `<?xml version="1.0" encoding="utf-8"?>
<Root>
  <Route id="smoke-single-stop-route">
    <num>92</num>
    <name>Маршрут №92 "Тест - Автобусный парк"</name>
    <dateStart>2026-01-01</dateStart>
    <nvid>городской</nvid>
  </Route>
  <BusStop id="start">
    <direction>1</direction>
    <num>1</num>
    <name>тест</name>
    <Day id="1111100"><name>Рабочие дни</name><Time><departureTime>08:10</departureTime><arrivalTime>08:10</arrivalTime><kodElem>1</kodElem><kodVariant>1</kodVariant></Time></Day>
  </BusStop>
  <BusStop id="park-main">
    <direction>1</direction>
    <num>2</num>
    <name>автобусный парк</name>
    <Day id="1111100"><name>Рабочие дни</name><Time><departureTime>08:15</departureTime><arrivalTime>08:15</arrivalTime><kodElem>1</kodElem><kodVariant>1</kodVariant></Time></Day>
  </BusStop>
  <BusStop id="park-extra">
    <direction>1</direction>
    <num>3</num>
    <name>автобусный парк</name>
    <Day id="1111100"><name>Рабочие дни</name><Time><departureTime>00:40</departureTime><arrivalTime>00:40</arrivalTime><kodElem>99</kodElem><kodVariant>1</kodVariant></Time></Day>
  </BusStop>
</Root>`;
    const endpointParsed = parseRouteFile(endpointOnlyXml, "endpoint-only.xml", 0);
    assert(!endpointParsed.departures.some((item) => item.departureTime === "00:40"), "XML import should drop one-stop terminal-only trips");
    assert(!endpointParsed.stops.some((item) => item.exportStopId === "park-extra"), "XML import should remove empty duplicate terminal stops");

    const minimalXml = `<?xml version="1.0" encoding="utf-8"?>
<Root>
  <Route id="smoke-xml-route">
    <num>91</num>
    <name>Маршрут №91 "Тест XML - Центр"</name>
    <dateStart>2026-01-01</dateStart>
    <nvid>городской</nvid>
  </Route>
  <BusStop id="s1">
    <direction>1</direction>
    <num>1</num>
    <name>тестовая остановка</name>
    <Day id="1111100"><name>Рабочие дни</name><Time><departureTime>08:10</departureTime><arrivalTime>08:10</arrivalTime><kodElem>1</kodElem><kodVariant>1</kodVariant></Time></Day>
  </BusStop>
  <BusStop id="s2">
    <direction>1</direction>
    <num>2</num>
    <name>центр</name>
    <Day id="1111100"><name>Рабочие дни</name><Time><departureTime>08:15</departureTime><arrivalTime>08:15</arrivalTime><kodElem>1</kodElem><kodVariant>1</kodVariant></Time></Day>
  </BusStop>
  <BusStop id="s3">
    <direction>1</direction>
    <num>3</num>
    <name>БСЗ ЗАО "Атлант"</name>
  </BusStop>
  <BusStop id="s4">
    <direction>1</direction>
    <num>4</num>
    <name>Автобусный парк</name>
    <Day id="1111100"><name>Рабочие дни</name><Time><departureTime>00:40</departureTime><arrivalTime>00:40</arrivalTime><kodElem>99</kodElem><kodVariant>1</kodVariant></Time></Day>
  </BusStop>
</Root>`;
    const xmlPayload = {
      confirmReplace: true,
      files: [
        {
          name: "расписание 91.xml",
          dataUrl: `data:text/xml;base64,${Buffer.from(minimalXml, "utf8").toString("base64")}`
        }
      ]
    };
    const deniedXmlImport = await fetch(`${baseUrl}/api/admin/schedule/import`, {
      method: "POST",
      headers: { ...adminHeaders, "x-admin-role": "ads_manager" },
      body: JSON.stringify(xmlPayload)
    });
    assert(deniedXmlImport.status === 403, "XML import should be restricted to admin and dispatcher roles");
    const xmlImportResult = await postJson(`${baseUrl}/api/admin/schedule/import`, xmlPayload, {
      ...adminHeaders,
      "x-admin-role": "dispatcher"
    });
    assert(xmlImportResult.routes >= 1 && xmlImportResult.departures >= 2, "XML schedule import did not load routes and departures");
    const importedRoutes = await readJson(`${baseUrl}/api/admin/schedule/routes`, adminHeaders);
    assert(importedRoutes.routes.some((item) => item.number === "91"), "Imported XML route is missing from admin schedule");
    assert(importedRoutes.routes.some((item) => item.number === "1"), "Single-route XML import should not remove existing routes");
    const serviceStops = importedRoutes.routes
      .find((item) => item.number === "91")
      ?.directions?.flatMap((direction) => direction.stops || [])
      ?.filter((stop) => /Атлант|Автобусный парк/i.test(stop.name)) || [];
    assert(serviceStops.length === 0, "XML import should remove service-only garage stops");
    const scheduleBackups = await readJson(`${baseUrl}/api/admin/schedule/backups`, {
      ...adminHeaders,
      "x-admin-role": "dispatcher"
    });
    assert(scheduleBackups.backups.length > 0, "XML import should create a rollback backup");
    const rollbackResult = await postJson(
      `${baseUrl}/api/admin/schedule/rollback`,
      { backupId: scheduleBackups.backups[0].id, confirmRollback: true },
      { ...adminHeaders, "x-admin-role": "dispatcher" }
    );
    assert(rollbackResult.ok, "Schedule rollback did not complete");
    const routesAfterRollback = await readJson(`${baseUrl}/api/admin/schedule/routes`, adminHeaders);
    assert(!routesAfterRollback.routes.some((item) => item.number === "91"), "Schedule rollback did not remove imported test route");

    const reminderResponse = await fetch(`${baseUrl}/api/reminders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ departureTime: firstTime.time, remindMinutes: 10, stopName: stop.name })
    });
    assert(reminderResponse.status === 401, "Reminder without Telegram auth should be rejected");

    const staticFiles = await Promise.all([
      fs.readFile("public/app.js", "utf8"),
      fs.readFile("public/admin.js", "utf8"),
      fs.readFile("public/styles.css", "utf8"),
      fs.readFile("public/admin.css", "utf8"),
      fs.readFile("public/bus-park-logo-light-clean.png")
    ]);
    const visualPolishCss = await fs.readFile("public/visual-polish.css", "utf8");
    const responsiveSystemCss = await fs.readFile("public/responsive-system.css", "utf8");
    const serverCode = await fs.readFile("server.js", "utf8");
    const dbCode = await fs.readFile("db.js", "utf8");
    const gitignoreCode = await fs.readFile(".gitignore", "utf8");
    assert(dbCode.includes("leadership_contacts") && serverCode.includes("/api/admin/leadership"), "Leadership database/API support is missing");
    [
      ".env.*",
      "*.db",
      "*.db-*",
      "browser-validation-*.db*",
      "data/uploads/",
      "outputs/",
      "tmp-*/",
      "tmp-*.png",
      "tmp-*.json",
      "public/uploads/appeals/"
    ].forEach((pattern) => assert(gitignoreCode.includes(pattern), `.gitignore should exclude ${pattern}`));
    assert(serverCode.includes("PRIVATE_UPLOAD_DIR") && serverCode.includes("process.env.PRIVATE_UPLOAD_DIR"), "Private upload root should be configurable outside public");
    assert(serverCode.includes("TRUSTED_PROXY_IPS") && serverCode.includes("shouldTrustForwardedFor"), "Proxy forwarding should require trusted proxy IPs");
    assert(serverCode.includes("requireVerifiedTelegramUser") && !serverCode.includes("REQUIRE_TELEGRAM_AUTH && BOT_TOKEN && !user?.isVerified"), "Telegram auth should fail closed without BOT_TOKEN");
    assert(serverCode.includes("isConfiguredOwnerTelegramId") && serverCode.includes("is not allowed to self-enroll"), "Telegram admin key enrollment should be owner-gated");
    assert(
      serverCode.includes("requireStoredAdmin") &&
        serverCode.includes("requireStoredOwnerAdmin") &&
        serverCode.includes("A saved administrator account is required"),
      "ADMIN_KEY should not mutate persistent staff access"
    );
    assert(dbCode.includes("assignedRole: resolveAppealAssignedRole(category)") && !dbCode.includes("input.assignedRole ||"), "Public appeals should derive assignedRole server-side");
    assert(dbCode.includes("normalizeAppealRecord") && dbCode.includes("return role === resolveAppealAssignedRole(appeal.category);"), "Appeal visibility should ignore stored tampered roles");
    const sendNotificationStart = serverCode.indexOf("async function sendNotification");
    const remindersStart = serverCode.indexOf("async function processDueReminders");
    const pollingStart = serverCode.indexOf("async function startTelegramPolling");
    assert(sendNotificationStart >= 0, "Telegram push notification sender is missing");
    assert(remindersStart >= 0, "Telegram reminder sender is missing");
    assert(pollingStart >= 0, "Telegram polling startup is missing");
    const sendNotificationCode = serverCode.slice(sendNotificationStart, remindersStart);
    const reminderNotificationCode = serverCode.slice(remindersStart, pollingStart);
    assert(!sendNotificationCode.includes("reply_markup"), "Push notifications should not include link buttons");
    assert(!reminderNotificationCode.includes("reply_markup"), "Reminder notifications should not include link buttons");
    assert(reminderNotificationCode.includes("До отправления:"), "Reminder should say how many minutes are left");
    assert(reminderNotificationCode.includes("Маршрут: ${reminderRouteNumberLabel(reminder.routeNumber)}"), "Reminder route number should include the № prefix");
    assert(reminderNotificationCode.includes("Направление:"), "Reminder should include the destination direction");
    assert(reminderNotificationCode.includes("Успейте выйти заранее."), "Reminder should include the early-exit hint");
    assert(!reminderNotificationCode.includes("Напоминание о рейсе"), "Reminder title should be short");
    assert(!reminderNotificationCode.includes("Отправление:"), "Reminder should not show the departure time line");
    assert(staticFiles.every((content) => content.length > 1000), "One of the UI files looks truncated");
    assert(staticFiles[0].includes("routesWithPlaceholders"), "Route placeholder logic is missing");
    assert(staticFiles[0].includes("exactRouteNumberQuery") && staticFiles[0].includes("routeNumberMatches"), "Route number search should use exact numeric matching");
    assert(!staticFiles[0].includes("(state.data.routes || []).slice(0, 18)"), "Quick route rail is still artificially limited");
    assert(staticFiles[0].includes("resetStopFilter"), "Stop filter reset logic is missing");
    assert(staticFiles[0].includes("shouldScrollToSchedule"), "Schedule result auto-scroll state is missing");
    assert(staticFiles[0].includes("scrollScheduleIntoView"), "Schedule result auto-scroll helper is missing");
    assert(staticFiles[0].includes("scrollScheduleTripToolsIntoView"), "Choosing a departure should scroll to the selected trip actions");
    assert(staticFiles[0].includes("scrollStopsIntoView"), "Stop search auto-scroll helper is missing");
    assert(staticFiles[0].includes("showAllStops"), "Collapsed stop list logic is missing");
    assert(staticFiles[0].includes("selected-stop-card"), "Selected stop summary is missing");
    assert(staticFiles[0].includes("appealButton"), "Schedule to appeal action is missing");
    assert(staticFiles[0].includes("serviceDayKind"), "Holiday service-day logic is missing");
    assert(staticFiles[0].includes("serviceDayMaskIndexes"), "Today schedule should match exact service-day masks");
    assert(staticFiles[0].includes("departureScheduleDayMask") && !staticFiles[0].includes("dayMask: effectiveDayMask"), "Passenger schedule should preserve original day masks for timelines and reminders");
    assert(staticFiles[0].includes("relativeDepartureMinutes"), "Cross-midnight departures should be compared by relative service minutes");
    assert(staticFiles[0].includes("departureHint"), "Trip destination labels are missing");
    assert(staticFiles[0].includes("directionLabel"), "Readable direction labels are missing");
    assert(responsiveSystemCss.includes("Final schedule state: passed departures") && responsiveSystemCss.includes(".time-chip.is-past:not(.is-selected):not(.is-next) strong"), "Passed departure chips need a distinct final visual state");
    assert(responsiveSystemCss.includes("display: grid !important;") && responsiveSystemCss.includes("display: flex !important;"), "Schedule time strip and stop search should not be hidden by responsive overrides");
    assert(responsiveSystemCss.includes("repeat(auto-fit, minmax(min(100%, 132px), 1fr))"), "Mobile route grid should keep route tiles wide enough");
    assert(!staticFiles[0].includes("appealRouteSelect"), "Appeal form still references route selector");
    assert(staticFiles[0].includes("routeFavorites"), "Passenger favorites are missing");
    assert(staticFiles[0].includes("ensureFavoriteForReminder") && staticFiles[0].includes("rememberAlarmState(favoriteResult.favorite"), "Reminder creation should add the stop to favorites with alarm state");
    assert(staticFiles[0].includes("`автобус ${route?.number || \"\"} Барановичи`.trim()"), "Yandex map query should include bus number and Baranovichi");
    assert(!staticFiles[0].includes('["Барановичи", `автобус'), "Yandex map query still includes extra search words");
    assert(staticFiles[1].includes("loadScheduleEditor"), "Admin schedule editor is missing");
    assert(staticFiles[1].includes("importScheduleXml") && staticFiles[1].includes("/api/admin/schedule/import"), "Admin XML import logic is missing");
    assert(staticFiles[1].includes("rollbackScheduleBackup") && staticFiles[1].includes("/api/admin/schedule/rollback"), "Admin XML rollback logic is missing");
    assert(staticFiles[1].includes("saveScheduleTime"), "Admin schedule save logic is missing");
    assert(staticFiles[1].includes('elements.dayMask.addEventListener("change", renderScheduleDepartures)'), "Admin schedule day filter should react to day changes");
    // The list shows ALL day-mask groups (hiding custom masks made them uneditable);
    // the selected day mode orders its groups first.
    assert(staticFiles[1].includes("byMask") && staticFiles[1].includes("selectedMask"), "Admin schedule list should group departures by day mask with the selected mode first");
    assert(staticFiles[1].includes("loadScheduleAudit"), "Admin schedule audit UI is missing");
    assert(staticFiles[1].includes("deleteScheduleAuditItem"), "Admin schedule audit item delete UI is missing");
    assert(staticFiles[1].includes("clearScheduleAudit"), "Admin schedule audit clear UI is missing");
    assert(staticFiles[1].includes("setScheduleTimeMode"), "Admin schedule add/edit mode UI is missing");
    assert(staticFiles[1].includes("clearAppeals"), "Admin appeals clear UI is missing");
    assert(staticFiles[1].includes("clearNotifications"), "Admin notification clear-all UI is missing");
    assert(staticFiles[1].includes("clearNotificationForm"), "Admin notification form clear UI is missing");
    assert(!staticFiles[1].includes('target?.startsWith("staff:")'), "Admin notification UI should not expose role-targeted recipients");
    assert(staticFiles[1].includes("Работник сохранён"), "Worker save status is missing");
    assert(staticFiles[1].includes("syncAdminDriverSquadField") && staticFiles[1].includes("filterAdmins") && staticFiles[1].includes("scrollToAdminMatch"), "Worker driver-squad lock, search filter or search scroll is missing");
    assert(!staticFiles[1].includes("selectedIndex = -1"), "Worker driver squad select should keep a stable placeholder state");
    assert(responsiveSystemCss.includes("light-only UI after removing the theme switch"), "Light-only theme override is missing");
    assert(!staticFiles[0].includes('const next = current === "dark" ? "comfort" : "dark"'), "Passenger theme switch logic should be removed");
    assert(!staticFiles[1].includes('const next = current === "dark" ? "comfort" : "dark"'), "Admin theme switch logic should be removed");
    assert(staticFiles[2].includes("home-promo") && staticFiles[2].includes("promoTicker"), "Home promo ticker styles are missing");
    assert(staticFiles[2].includes("home-promo-media") && staticFiles[2].includes("promoImageIn"), "Home promo image animation styles are missing");
    assert(staticFiles[2].includes("object-fit: contain") && staticFiles[2].includes("promoTimer"), "Home promo image containment and timer styles are missing");
    assert(!staticFiles[2].includes("home-slide"), "Home image slider styles should stay removed");
    assert(staticFiles[2].includes("nav-icon") && staticFiles[2].includes("nav-routes"), "Bottom navigation line icons are missing");
    assert(visualPolishCss.includes("alarm-sheet-panel") && visualPolishCss.includes("favorite-alarm-status"), "Favorites alarm sheet styles are missing");
    assert(!staticFiles[2].includes("Simple passenger mode"), "ZipiBus-like override styles should be removed");
    assert(staticFiles[0].includes("loadTimelineFor"), "Route timeline UI logic is missing");
    assert(staticFiles[0].includes("renderReminderPanel"), "Reminder UI logic is missing");
    assert(staticFiles[0].includes("renderClientChat"), "Client chat UI logic is missing");
    assert(staticFiles[0].includes("openAlarmBottomSheet") && staticFiles[0].includes("rememberAlarmState"), "Favorites alarm bottom sheet logic is missing");
    assert(staticFiles[0].includes("openImageViewer"), "Image viewer logic is missing");
    assert(!staticFiles[0].includes("appealVoiceButton"), "Appeal voice recording control should stay removed");
    assert(staticFiles[0].includes("appendAttachments"), "Appeal attachment rendering is missing");
    assert(staticFiles[0].includes("openServiceDetail") && staticFiles[0].includes("service-picker"), "Service/STO UI is missing");
    assert(!staticFiles[0].includes("openServiceAppeal") && !staticFiles[0].includes("serviceContinueButton"), "Service/STO UI should not keep appeal shortcut controls");
    assert(!staticFiles[0].includes("service-stepper") && !home.includes("service-flow"), "Service progress bar should stay removed");
    assert(staticFiles[0].includes('location.hash === "#about"') && staticFiles[2].includes("about-official-card") && staticFiles[2].includes("about-person"), "About UI is missing");
    assert(!home.includes('data-view="news"') && !home.includes("newsFilters"), "Public news section should not render in Mini App");
    assert(staticFiles[1].includes("openAdminChat"), "Admin chat UI logic is missing");
    assert(staticFiles[1].includes('appeal.status === "closed" ? "Открыть" : "Закрыть"'), "Appeal admin actions should only open or close chats");
    assert(staticFiles[1].includes("mimeTypeFromUrl") && staticFiles[1].includes("attachment-download"), "Admin audio playback fallback is missing");
    assert(staticFiles[1].includes("deleteAdItem"), "Admin ad delete UI is missing");
    assert(!staticFiles[1].includes("applyNewsFormat") && !staticFiles[1].includes("deleteNewsItem") && !staticFiles[1].includes("newsFormJson"), "Admin news editor logic should stay removed");
    assert(staticFiles[1].includes("deleteNotificationItem"), "Admin notification delete UI is missing");
    assert(staticFiles[1].includes("readFileAsDataUrl"), "Admin ad image upload logic is missing");
    assert(staticFiles[2].includes("ad-image"), "Mini App ad image styles are missing");
    assert(staticFiles[2].includes("image-viewer"), "Image viewer styles are missing");
    assert(staticFiles[2].includes("app-loader") && staticFiles[2].includes("busFloat"), "Loading bus animation styles are missing");
    assert(!home.includes("nav-news") && !home.includes("nav-unread-dot"), "Public news nav styles should not be used by Mini App");
    assert(staticFiles[2].includes("is-comfort"), "Comfort theme styles are missing");
    assert(!staticFiles[2].includes("body.is-light"), "Blue daytime theme should stay removed");
    assert(staticFiles[0].includes('theme = "comfort"') && staticFiles[0].includes('classList.remove("is-dark")'), "Passenger app should force the comfort theme");
    assert(staticFiles[2].includes("attachment-list"), "Attachment styles are missing");
    assert(staticFiles[2].includes("attachment-download"), "Attachment download fallback styles are missing");
    assert(staticFiles[3].includes("editor-toolbar"), "Admin editor toolbar styles are missing");
    assert(serverCode.includes("pendingAdminAccess"), "Telegram admin access key flow is missing");
    assert(
      serverCode.includes("Бот автобусного парка") &&
        serverCode.includes("Для пассажиров: быстро найти расписание") &&
        !serverCode.includes("транспортный помощник города") &&
        !serverCode.includes("Новости, контакты") &&
        !serverCode.includes("Узнать новости"),
      "Telegram welcome/help text should describe the bus park app without news"
    );
    assert(!serverCode.includes("Оставить обращение") && !serverCode.includes("appeal.id}:in_progress"), "Telegram bot start/status actions should stay simplified");
    assert(dbCode.includes("APPEAL_RETENTION_DAYS = 3") && dbCode.includes("purgeExpiredAppeals"), "Closed appeal retention cleanup is missing");
    assert(dbCode.includes("sto_manager") && dbCode.includes("isServiceCategory"), "STO manager role routing is missing");
    assert(serverCode.includes("sendAdminPanel"), "Telegram staff panel is missing");
    assert(serverCode.includes("notifyStaffAccessChanged"), "Admin add/update Telegram notification is missing");
    assert(serverCode.includes("bot:admin"), "Telegram staff panel callback is missing");
    assert(serverCode.includes("setChatMenuButton"), "Telegram staff menu button is missing");
    assert(serverCode.includes("configureStaffMenu"), "Telegram staff menu configuration is missing");
    assert(serverCode.includes("telegramMainKeyboard") && serverCode.includes("is_persistent"), "Telegram persistent bottom panel is missing");
    assert(serverCode.includes("sendChatPanelReset"), "Telegram chat clear action is missing");
    assert(serverCode.includes("configureDefaultMenu"), "Telegram default app menu is missing");
    assert(serverCode.includes("listStaffRecipients()"), "Server all-staff notification delivery is missing");
    assert(serverCode.includes("/api/admin/schedule/import") && serverCode.includes("importRoutesFromXmlFiles"), "Server XML schedule import endpoint is missing");
    assert(serverCode.includes("/api/admin/services") && dbCode.includes("CREATE TABLE IF NOT EXISTS services"), "Editable services API/storage is missing");
    assert(!dbCode.includes('requestedDriverSquad && requestedRole === "worker"'), "Server should not promote a worker to driver from driverSquad alone");
    assert(serverCode.includes("/api/admin/schedule/rollback") && serverCode.includes("restoreScheduleBackup"), "Server XML schedule rollback endpoint is missing");
    assert(dbCode.includes("invalidateScheduleCache"), "Schedule cache invalidation helper is missing");
    assert(dbCode.includes("schedule_backups") && dbCode.includes("createScheduleBackup"), "Schedule rollback backup storage is missing");
    assert(serverCode.includes("deleteScheduleAudit"), "Server schedule audit item delete support is missing");
    assert(serverCode.includes("clearScheduleAudit"), "Server schedule audit clear support is missing");
    assert(serverCode.includes("clearAppeals"), "Server appeals clear support is missing");
    assert(serverCode.includes("clearNotifications"), "Server notifications clear support is missing");
    assert(serverCode.includes("saveAdImage"), "Server ad image upload support is missing");
    assert(serverCode.includes("saveNewsImage"), "Server news image upload support is missing");
    assert(serverCode.includes("saveAppealAttachment"), "Server appeal attachment upload support is missing");
    assert(serverCode.includes("incrementNewsView") && serverCode.includes("setNewsLike"), "Server news counters support is missing");
    assert(serverCode.includes("deleteAd"), "Server ad delete support is missing");
    assert(dbCode.includes("appeal_attachments"), "Database appeal attachment support is missing");

    console.log(
      JSON.stringify(
        {
          ok: true,
          routes: bootstrap.routes.length,
          stops: bootstrap.stats.stops,
          departures: bootstrap.stats.departures,
          scheduleGroups: schedule.groups.length,
          timelineStops: timeline.timeline.length,
          chatMessages: adminChat.messages.length,
          adminSections: ["appeals", "schedule", "roster", "services", "notifications", "visits", "admins", "about"]
        },
        null,
        2
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
