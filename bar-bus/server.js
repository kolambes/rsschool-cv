const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

process.env.TZ = process.env.TZ || "Europe/Minsk";

loadEnvFile(path.join(__dirname, ".env"));

const {
  STATUS_LABELS,
  ROLE_LABELS,
  PERMISSIONS,
  seedAdminsFromEnv,
  hasPermission,
  getAdminByTelegramId,
  listRoutes,
  getSchedule,
  searchRoutesBetweenStops,
  getTripTimeline,
  listAdminDepartures,
  saveDeparture,
  deleteDeparture,
  updateScheduleMeta,
  listScheduleAudit,
  deleteScheduleAudit,
  clearScheduleAudit,
  listScheduleBackups,
  restoreScheduleBackup,
  cleanupScheduleMaintenanceRecords,
  createScheduledRouteImport,
  listScheduledRouteImports,
  listDueScheduledRouteImports,
  recoverStaleScheduledRouteImports,
  claimScheduledRouteImport,
  completeScheduledRouteImport,
  failScheduledRouteImport,
  cancelScheduledRouteImport,
  searchStops,
  getStopBoard,
  getStats,
  recordSiteVisit,
  listActiveAds,
  listAds,
  getAd,
  saveAd,
  deleteAd,
  listServices,
  getService,
  saveService,
  deleteService,
  listNews,
  getNews,
  incrementNewsView,
  setNewsLike,
  saveNews,
  deleteNews,
  createAppeal,
  getAppeal,
  listAppeals,
  listAppealsForTelegram,
  clearAppeals,
  setAppealFileCleanupHandler,
  getAppealSummary,
  resolveAppealAssignedRole,
  updateAppealStatus,
  listAppealMessages,
  addAppealMessage,
  upsertSubscriber,
  listSubscribers,
  markSubscriberUnsubscribed,
  listStaffRecipients,
  registerDriverUser,
  deleteDriverUser,
  getDriverByTabNumber,
  listDriverUsers,
  findSentDutyRosterUploadByHash,
  getLatestDutyRosterUploadForDate,
  createDutyRosterUpload,
  listDutyRosterUploads,
  clearDutyRosterUploads,
  getDutyRosterUpload,
  listDutyRosterItems,
  listDutyRosterUnregisteredTabs,
  markDutyRosterItemSent,
  markDutyRosterUploadSent,
  getDutyRosterDailySend,
  markDutyRosterDailySend,
  createNotification,
  markNotificationSent,
  listNotifications,
  clearNotifications,
  deleteNotification,
  createReminder,
  cancelReminder,
  listDueReminders,
  markReminderDone,
  rescheduleReminder,
  dayMaskIncludesServiceDate,
  listAdmins,
  saveAdmin,
  listLeadershipContacts,
  saveLeadershipContact,
  deleteLeadershipContact,
  createId
} = require("./db");
const { importRoutesFromXmlFiles, inspectRouteImportFiles } = require("./route-importer");
const {
  parseRosterDataUrl,
  parseDutyRoster,
  formatDutyRosterMessage,
  formatNoAssignmentMessage,
  summarizeParsedRoster,
  tabNumberKey
} = require("./duty-roster");
const { assertCleanText } = require("./content-filter");
const mapModule = require("./map-module");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PRIVATE_UPLOAD_DIR = path.resolve(ROOT_DIR, process.env.PRIVATE_UPLOAD_DIR || path.join("data", "uploads"));
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const AD_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "ads");
const NEWS_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "news");
const SERVICE_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "services");
const APPEAL_UPLOAD_DIR = path.join(PRIVATE_UPLOAD_DIR, "appeals");
const LEGACY_APPEAL_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "appeals");
const LEADERSHIP_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "leadership");

const PORT = Number(process.env.PORT || 3000);
const CITY_NAME = process.env.CITY_NAME || "Барановичи";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = String(process.env.BOT_USERNAME || "").replace(/^@/, "").trim();
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const ADMIN_IDS = parseCsv(process.env.ADMIN_IDS);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const PORT_FALLBACK_ENABLED = !IS_PRODUCTION && process.env.PORT_FALLBACK_ENABLED !== "false";
const PORT_FALLBACK_ATTEMPTS = Math.max(1, Number(process.env.PORT_FALLBACK_ATTEMPTS) || 25);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ALLOW_ADMIN_QUERY_KEY = process.env.ALLOW_ADMIN_QUERY_KEY === "true";
const ALLOW_ADMIN_ROLE_OVERRIDE = process.env.ALLOW_ADMIN_ROLE_OVERRIDE === "true";
const REQUIRE_TELEGRAM_AUTH = process.env.REQUIRE_TELEGRAM_AUTH === "true";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const TRUSTED_PROXY_IPS = new Set(parseCsv(process.env.TRUSTED_PROXY_IPS).map(normalizeIpAddress).filter(Boolean));
const YANDEX_MAPS_API_KEY = process.env.YANDEX_MAPS_API_KEY || "";
const DISABLE_TELEGRAM_POLLING = process.env.DISABLE_TELEGRAM_POLLING === "true";
const CLEAR_TELEGRAM_WEBHOOK_ON_POLLING = process.env.CLEAR_TELEGRAM_WEBHOOK_ON_POLLING !== "false";
const DUTY_ROSTER_DAILY_ENABLED = process.env.DUTY_ROSTER_DAILY_ENABLED !== "false";
const DUTY_ROSTER_DAILY_SEND_TIME = process.env.DUTY_ROSTER_DAILY_SEND_TIME || "18:00";
const FILE_ACCESS_SECRET = process.env.FILE_ACCESS_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.FILE_ACCESS_SECRET && process.env.NODE_ENV === "production") {
  console.warn("[warn] FILE_ACCESS_SECRET is not set: signed attachment links will break on every restart. Set it in the environment.");
}
// Shorter default TTL keeps the leak window small if a signed link is exposed
// (referrer, proxy log, screenshot). Enough time to view an attachment in the panel.
const APPEAL_FILE_TTL_MS = Number(process.env.APPEAL_FILE_TTL_MS) || 15 * 60 * 1000;
const ADMIN_ACCESS_TTL_MS = 10 * 60 * 1000;
const ADMIN_ACCESS_MAX_ATTEMPTS = Math.max(1, Number(process.env.ADMIN_ACCESS_MAX_ATTEMPTS) || 5);
const TELEGRAM_INIT_DATA_TTL_MS = Math.max(60_000, Number(process.env.TELEGRAM_INIT_DATA_TTL_MS) || 6 * 60 * 60 * 1000);
const TELEGRAM_INIT_DATA_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_APPEAL_BODY_BYTES = 32 * 1024 * 1024;
const MAX_XML_IMPORT_BYTES = 40 * 1024 * 1024;
const MAX_DUTY_ROSTER_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const TELEGRAM_APPEAL_ATTACHMENT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav"
]);
const TELEGRAM_APPEAL_ATTACHMENT_EXTENSIONS = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav"
};
const PUBLIC_JSON_CACHE_TTL_MS = Math.max(1000, Number(process.env.PUBLIC_JSON_CACHE_TTL_MS) || 15 * 1000);
const PUBLIC_JSON_CACHE_LIMIT = Math.max(32, Number(process.env.PUBLIC_JSON_CACHE_LIMIT) || 512);
const PUBLIC_BOOTSTRAP_CACHE_KEY = "public:bootstrap:v2";
const STATIC_ASSET_MAX_AGE_SECONDS = Math.max(300, Number(process.env.STATIC_ASSET_MAX_AGE_SECONDS) || 24 * 60 * 60);
const IMMUTABLE_STATIC_MAX_AGE_SECONDS = Math.max(
  STATIC_ASSET_MAX_AGE_SECONDS,
  Number(process.env.IMMUTABLE_STATIC_MAX_AGE_SECONDS) || 365 * 24 * 60 * 60
);
const TEXT_COMPRESS_MIN_BYTES = 1024;
// Верхний предел синхронного gzip на event-loop: очень большие ответы отдаём
// без сжатия, чтобы одиночный zlib.gzipSync не стопорил поток для всех.
const TEXT_COMPRESS_MAX_BYTES = Math.max(TEXT_COMPRESS_MIN_BYTES, Number(process.env.TEXT_COMPRESS_MAX_BYTES) || 2 * 1024 * 1024);
const STATIC_COMPRESSED_CACHE_LIMIT = 64;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = Math.max(1000, Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS) || 65_000);
const SERVER_HEADERS_TIMEOUT_MS = Math.max(SERVER_KEEP_ALIVE_TIMEOUT_MS + 1000, Number(process.env.SERVER_HEADERS_TIMEOUT_MS) || 70_000);
const SERVER_REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.SERVER_REQUEST_TIMEOUT_MS) || 120_000);
const WARM_PUBLIC_CACHE_ON_START = process.env.WARM_PUBLIC_CACHE_ON_START !== "false";
const RATE_LIMITS = {
  adminAuth: { limit: 20, windowMs: 10 * 60 * 1000 },
  adminApi: { limit: 180, windowMs: 10 * 60 * 1000 },
  appealCreate: { limit: 5, windowMs: 10 * 60 * 1000 },
  appealMessage: { limit: 20, windowMs: 10 * 60 * 1000 },
  telegramAppealCreate: { limit: 4, windowMs: 10 * 60 * 1000 },
  telegramMessage: { limit: 30, windowMs: 60 * 1000 },
  reminderCreate: { limit: 12, windowMs: 10 * 60 * 1000 },
  reminderCancel: { limit: 30, windowMs: 10 * 60 * 1000 },
  newsView: { limit: 80, windowMs: 10 * 60 * 1000 },
  newsLike: { limit: 40, windowMs: 10 * 60 * 1000 },
  xmlImport: { limit: 6, windowMs: 30 * 60 * 1000 },
  rosterUpload: { limit: 8, windowMs: 30 * 60 * 1000 },
  rosterSend: { limit: 6, windowMs: 30 * 60 * 1000 },
  publicRead: {
    limit: Math.max(60, Number(process.env.PUBLIC_READ_RATE_LIMIT) || 1200),
    windowMs: Math.max(10_000, Number(process.env.PUBLIC_READ_RATE_WINDOW_MS) || 60 * 1000)
  },
  // Route search is the heaviest public path (synchronous multi-join SQL);
  // it gets its own much tighter bucket on top of publicRead.
  routeSearch: { limit: 60, windowMs: 60 * 1000 }
};

const PUBLIC_READ_API_PATHS = new Set([
  "/api/bootstrap",
  "/api/routes",
  "/api/routes/search",
  "/api/schedule",
  "/api/trip/timeline",
  "/api/stops/search",
  "/api/stops/board",
  "/api/ads",
  "/api/services",
  "/api/news",
  "/api/map/data",
  "/api/map/vehicles",
  "/api/map/alerts",
  "/api/map/health"
]);

const pendingAdminAccess = new Map();
const rateLimitBuckets = new Map();
const publicJsonCache = new Map();
const compressedStaticCache = new Map();
const telegramRecentMessages = new Map();
const pendingTelegramAppeals = new Map();
const activeTelegramAppeals = new Map();
const activeAdminAppeals = new Map();
const TELEGRAM_RECENT_LIMIT = 24;
const TELEGRAM_IMPORT_DOCUMENT_LIMIT = 24;
const TELEGRAM_IMPORT_DOCUMENT_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.TELEGRAM_IMPORT_DOCUMENT_TTL_MS) || 30 * 60 * 1000);
const telegramImportDocuments = [];
const TELEGRAM_PANEL = {
  app: "🚍 Открыть приложение",
  appeal: "💬 Написать обращение",
  myAppeals: "📨 Мои обращения",
  schedule: "📋 Расписание",
  map: "🗺 Карта",
  clear: "🧹 Очистить чат",
  help: "ℹ️ О боте",
  admin: "⚙ Настройки"
};

const APPEAL_BOT_CATEGORIES = [
  { key: "complaint", title: "Жалоба", role: "moderator" },
  { key: "schedule", title: "Расписание / остановка", role: "dispatcher" },
  { key: "ads", title: "Реклама", role: "ads_manager" },
  { key: "service", title: "СТО / услуги", role: "sto_manager" },
  { key: "general", title: "Другая проблема", role: "appeals_manager" }
];

Object.assign(TELEGRAM_PANEL, {
  app: "Открыть приложение",
  appeal: "Написать обращение",
  myAppeals: "Мои обращения",
  schedule: "Расписание",
  map: "Карта",
  clear: "Очистить чат",
  help: "О боте",
  admin: "Настройки"
});

APPEAL_BOT_CATEGORIES.splice(
  0,
  APPEAL_BOT_CATEGORIES.length,
  { key: "complaint", title: "Жалоба", role: "moderator" },
  { key: "schedule", title: "Расписание / остановка", role: "dispatcher" },
  { key: "ads", title: "Реклама", role: "ads_manager" },
  { key: "service", title: "СТО / услуги", role: "sto_manager" },
  { key: "general", title: "Другая проблема", role: "appeals_manager" }
);

seedAdminsFromEnv(ADMIN_IDS);

// Модуль карты получает зависимости сервера (функции объявлены ниже,
// но доступны здесь благодаря hoisting function declarations).
mapModule.init({
  sendJson,
  httpError,
  parseBody,
  requireAdmin,
  getTelegramUser,
  requireVerifiedTelegramUser,
  enforceRateLimit,
  sendTelegramMessage,
  getPublicUrl,
  RATE_LIMITS
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const COMPRESSIBLE_STATIC_EXTS = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".xml"]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // blob: — MapLibre GL создаёт из blob свой render-worker (экран «Карта»)
  "script-src 'self' https://telegram.org blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  // тайлы Спутник/Гибрид (Esri, CARTO) + пользовательские подложки из env
  // (MAP_TILE_URL и др.) MapLibre загружает через fetch → connect-src
  `connect-src 'self' https://api.telegram.org https://server.arcgisonline.com https://*.basemaps.cartocdn.com https://tiles.openfreemap.org${mapModule.getExternalOrigins().map((origin) => ` ${origin}`).join("")}`,
  "font-src 'self' data:",
  "object-src 'none'",
  // Telegram Web (web.telegram.org) embeds Mini Apps in an iframe — 'none' would
  // break the app for browser Telegram users while native clients keep working.
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  // No x-frame-options: it cannot express the telegram.org allow-list above and
  // DENY would override the CSP frame-ancestors in some browsers.
  "referrer-policy": "no-referrer",
  "x-permitted-cross-domain-policies": "none",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  // Ignored over plain HTTP, effective behind the HTTPS proxy.
  "strict-transport-security": "max-age=31536000"
};

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) return;

  const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRosterTargetSquad(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["city", "first", "1", "1st"].includes(normalized)) return "city";
  if (["regional", "second", "2", "2nd", "suburban"].includes(normalized)) return "regional";
  return "";
}

function validateRuntimeConfig() {
  if (IS_PRODUCTION && REQUIRE_TELEGRAM_AUTH && !BOT_TOKEN) {
    throw new Error("Unsafe config: REQUIRE_TELEGRAM_AUTH=true requires BOT_TOKEN in production.");
  }
  if (TRUST_PROXY && !TRUSTED_PROXY_IPS.size) {
    console.warn("TRUST_PROXY=true is ignored until TRUSTED_PROXY_IPS is configured.");
  }
  // fail-open-конфиги в проде: не бросаем (не бриковать живой деплой), но громко
  // предупреждаем, чтобы оператор увидел риск в логах старта.
  if (IS_PRODUCTION && !REQUIRE_TELEGRAM_AUTH) {
    console.warn("[security] REQUIRE_TELEGRAM_AUTH выключен в проде: эндпоинты обращений/контактов принимают неаутентифицированные, неатрибутированные заявки (спам, забивание загрузок). Включите REQUIRE_TELEGRAM_AUTH=true для fail-closed.");
  }
  if (IS_PRODUCTION && !TRUST_PROXY) {
    console.warn("[security] TRUST_PROXY выключен в проде: за обратным прокси все клиенты делят одну корзину rate-limit (self-DoS), а пер-IP троттлинг слеп. Если вы за прокси — задайте TRUST_PROXY=true и TRUSTED_PROXY_IPS.");
  }
  if (IS_PRODUCTION && ALLOW_ADMIN_QUERY_KEY) {
    console.warn("[security] ALLOW_ADMIN_QUERY_KEY включён: админ-ключ может попасть в URL и утечь в логи прокси, историю браузера и Referer. Используйте только заголовок x-admin-key.");
  }
  if (ADMIN_KEY && isWeakAdminKey(ADMIN_KEY)) {
    console.warn("[security] ADMIN_KEY задан, но слишком слабый (короткий или плейсхолдер): key-аутентификация админа отключена. Используйте случайный ключ 16+ символов.");
  }
}

function acceptsGzip(req) {
  const header = String(firstHeader(req?.headers?.["accept-encoding"]) || "");
  return /\bgzip\b/i.test(header);
}

function acceptsBrotli(req) {
  const header = String(firstHeader(req?.headers?.["accept-encoding"]) || "");
  return /\bbr\b/i.test(header);
}

function writeBufferResponse(res, statusCode, body, contentType, options = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  const headers = {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "cache-control": options.cacheControl || "no-store",
    "content-length": buffer.length
  };

  if (options.contentEncoding) {
    headers["content-encoding"] = options.contentEncoding;
    headers.vary = options.vary || "Accept-Encoding";
  }
  if (options.etag) headers.etag = options.etag;

  res.writeHead(statusCode, {
    ...headers
  });
  res.end(buffer);
}

function sendBody(res, statusCode, body, contentType, options = {}) {
  let buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  const shouldGzip = buffer.length >= TEXT_COMPRESS_MIN_BYTES
    && buffer.length <= TEXT_COMPRESS_MAX_BYTES
    && acceptsGzip(res._request);

  if (shouldGzip) {
    buffer = zlib.gzipSync(buffer, { level: 6 });
    return writeBufferResponse(res, statusCode, buffer, contentType, {
      ...options,
      contentEncoding: "gzip"
    });
  }

  return writeBufferResponse(res, statusCode, buffer, contentType, options);
}

function sendJson(res, statusCode, data, options = {}) {
  return sendBody(res, statusCode, JSON.stringify(data), "application/json; charset=utf-8", options);
}

function sendText(res, statusCode, text, options = {}) {
  return sendBody(res, statusCode, text, "text/plain; charset=utf-8", options);
}

function jsonEtag(buffer) {
  const hash = crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16);
  return `W/"json-${buffer.length.toString(16)}-${hash}"`;
}

function prunePublicJsonCache(now = Date.now()) {
  for (const [key, value] of publicJsonCache.entries()) {
    if (!value || value.expiresAt <= now) publicJsonCache.delete(key);
  }
  while (publicJsonCache.size > PUBLIC_JSON_CACHE_LIMIT) {
    const oldestKey = publicJsonCache.keys().next().value;
    if (!oldestKey) break;
    publicJsonCache.delete(oldestKey);
  }
}

function getCachedPublicJson(cacheKey, ttlMs, producer) {
  const now = Date.now();
  const cached = publicJsonCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached;
  if (cached) publicJsonCache.delete(cacheKey);

  const raw = Buffer.from(JSON.stringify(producer()));
  const compressible = raw.length >= TEXT_COMPRESS_MIN_BYTES;
  const entry = {
    expiresAt: now + ttlMs,
    raw,
    gzip: compressible ? zlib.gzipSync(raw, { level: 6 }) : null,
    // Brotli shaves ~15% vs gzip on JSON; compressed once per TTL refill.
    brotli: compressible
      ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : null,
    etag: jsonEtag(raw)
  };
  publicJsonCache.set(cacheKey, entry);
  prunePublicJsonCache(now);
  return entry;
}

function sendCachedJson(res, statusCode, cacheKey, ttlMs, producer) {
  const entry = getCachedPublicJson(cacheKey, ttlMs, producer);
  const cacheControl = `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}, stale-while-revalidate=30`;
  const req = res._request;

  if (entry.etag && firstHeader(req?.headers?.["if-none-match"]) === entry.etag) {
    const headers = {
      ...SECURITY_HEADERS,
      "cache-control": cacheControl,
      etag: entry.etag
    };
    if (entry.gzip) headers.vary = "Accept-Encoding";
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (entry.brotli && acceptsBrotli(res._request)) {
    return writeBufferResponse(res, statusCode, entry.brotli, "application/json; charset=utf-8", {
      cacheControl,
      contentEncoding: "br",
      etag: entry.etag
    });
  }

  if (entry.gzip && acceptsGzip(res._request)) {
    return writeBufferResponse(res, statusCode, entry.gzip, "application/json; charset=utf-8", {
      cacheControl,
      contentEncoding: "gzip",
      etag: entry.etag
    });
  }

  return writeBufferResponse(res, statusCode, entry.raw, "application/json; charset=utf-8", { cacheControl, etag: entry.etag });
}

function clearPublicJsonCache(...keys) {
  if (!keys.length) {
    publicJsonCache.clear();
    return;
  }
  keys.forEach((key) => publicJsonCache.delete(key));
}

function publicCacheKey(scope, parts = []) {
  const hash = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  return `public:${scope}:${hash}`;
}

function rememberCompressedStatic(cacheKey, buffer) {
  compressedStaticCache.set(cacheKey, buffer);
  if (compressedStaticCache.size <= STATIC_COMPRESSED_CACHE_LIMIT) return;
  const oldestKey = compressedStaticCache.keys().next().value;
  if (oldestKey) compressedStaticCache.delete(oldestKey);
}

function staticEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
}

function isImmutableStaticRequest(url, requestPath, ext) {
  if (ext === ".html") return false;
  if (url.searchParams.has("v") || url.searchParams.has("version")) return true;
  const normalizedPath = String(requestPath || "").replace(/\\/g, "/");
  const fileName = path.basename(normalizedPath);
  return normalizedPath.startsWith("/uploads/") && /^\d{10,}-[a-f0-9]{8,}-/i.test(fileName);
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isWeakAdminKey(value) {
  const key = String(value || "").trim();
  return !key || key === "change-me" || key.length < 16;
}

function safeEquals(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isInsideDirectory(parentDir, targetPath) {
  const relativePath = path.relative(parentDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeAppealFileName(value = "") {
  let decoded = "";
  try {
    decoded = decodeURIComponent(String(value || ""));
  } catch (error) {
    return "";
  }
  if (!decoded || /[\\/]/.test(decoded)) return "";
  const fileName = path.basename(decoded);
  return fileName === decoded ? fileName : "";
}

function safeDecodePathname(value = "") {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    throw httpError("Invalid request path.", 400);
  }
}

function getAppealFileName(fileUrl = "") {
  const pathname = String(fileUrl || "").split("?")[0];
  if (!pathname.startsWith("/uploads/appeals/")) return "";
  return normalizeAppealFileName(pathname.slice("/uploads/appeals/".length));
}

function createAppealFileSignature(fileName, expiresAt) {
  return crypto.createHmac("sha256", FILE_ACCESS_SECRET).update(`${fileName}.${expiresAt}`).digest("hex");
}

function signAppealFileUrl(fileUrl = "") {
  const fileName = getAppealFileName(fileUrl);
  if (!fileName) return fileUrl;
  const expiresAt = Date.now() + APPEAL_FILE_TTL_MS;
  const sig = createAppealFileSignature(fileName, expiresAt);
  return `/api/files/appeals/${encodeURIComponent(fileName)}?expires=${expiresAt}&sig=${sig}`;
}

function verifyAppealFileSignature(fileName, expiresAt, signature) {
  const expires = Number(expiresAt);
  if (!fileName || !Number.isFinite(expires) || expires <= Date.now()) return false;
  return safeEquals(signature, createAppealFileSignature(fileName, expires));
}

function signAppealMessage(message) {
  if (!message) return message;
  return {
    ...message,
    attachments: (message.attachments || []).map((item) => ({
      ...item,
      url: signAppealFileUrl(item.url)
    }))
  };
}

function signAppealMessages(messages) {
  return (messages || []).map(signAppealMessage);
}

function normalizeIpAddress(value = "") {
  return String(value || "").trim().replace(/^::ffff:/, "");
}

function shouldTrustForwardedFor(req) {
  if (!TRUST_PROXY || !TRUSTED_PROXY_IPS.size) return false;
  const socketIp = normalizeIpAddress(req.socket?.remoteAddress || "");
  return Boolean(socketIp && TRUSTED_PROXY_IPS.has(socketIp));
}

function getRequestIp(req) {
  const socketIp = normalizeIpAddress(req.socket?.remoteAddress || "local") || "local";
  if (!shouldTrustForwardedFor(req)) return socketIp;

  const forwarded = normalizeIpAddress(String(firstHeader(req.headers["x-forwarded-for"]) || "").split(",")[0]);
  return forwarded || socketIp;
}

function rateLimitIdentity(req, user) {
  if (user?.telegramId) return `tg:${user.telegramId}`;
  // IP only: including the User-Agent let attackers rotate the header to get a fresh
  // bucket per request and slip past the limit. IP-based buckets can't be spoofed
  // (behind the trusted proxy) so they actually throttle abuse.
  const fingerprint = getRequestIp(req);
  return `ip:${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
}

function recordPublicPageVisit(req, requestPath) {
  if (req.method !== "GET" || requestPath !== "/index.html") return;

  const fingerprint = `${getRequestIp(req)}:${firstHeader(req.headers["user-agent"]) || ""}`;
  try {
    recordSiteVisit({
      path: "/",
      visitorHash: crypto.createHash("sha256").update(fingerprint).digest("hex"),
      userAgent: firstHeader(req.headers["user-agent"]) || ""
    });
  } catch (error) {
    console.warn("Visit tracking failed:", error.message || error);
  }
}

function enforceRateLimit(req, user, bucket, options) {
  const now = Date.now();
  if (rateLimitBuckets.size > 10000) cleanupRateLimits();
  const key = `${bucket}:${rateLimitIdentity(req, user)}`;
  const current = rateLimitBuckets.get(key);
  if (!current || current.expiresAt <= now) {
    rateLimitBuckets.set(key, { count: 1, expiresAt: now + options.windowMs });
    return;
  }

  current.count += 1;
  if (current.count > options.limit) {
    const retryAfter = Math.max(1, Math.ceil((current.expiresAt - now) / 1000));
    const error = httpError("Слишком много запросов. Попробуйте немного позже.", 429);
    error.retryAfter = retryAfter;
    throw error;
  }
}

function enforcePublicReadLimit(req) {
  enforceRateLimit(req, null, "public-read", RATE_LIMITS.publicRead);
}

function limitedQueryParam(url, name, maxLength = 120) {
  const value = url.searchParams.get(name) || "";
  if (String(value).length > maxLength) throw httpError("Invalid request parameter.", 400);
  return value;
}

function enforceTelegramRateLimit(identity, bucket, options) {
  const now = Date.now();
  if (rateLimitBuckets.size > 10000) cleanupRateLimits();
  const safeIdentity = String(identity || "unknown").replace(/[^a-z0-9:_-]/gi, "").slice(0, 80) || "unknown";
  const key = `telegram:${bucket}:${safeIdentity}`;
  const current = rateLimitBuckets.get(key);
  if (!current || current.expiresAt <= now) {
    rateLimitBuckets.set(key, { count: 1, expiresAt: now + options.windowMs });
    return true;
  }

  current.count += 1;
  return current.count <= options.limit;
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, value] of rateLimitBuckets.entries()) {
    if (value.expiresAt <= now) rateLimitBuckets.delete(key);
  }
}

async function parseBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError("Слишком большой запрос.", 413);
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw httpError("Invalid JSON payload.", 400);
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return { text: raw };
}

function getPublicUrl(pathname = "/") {
  const base = WEBAPP_URL.endsWith("/") ? WEBAPP_URL.slice(0, -1) : WEBAPP_URL;
  return `${base}${pathname}`;
}

function getFeedbackBotStartUrl() {
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=appeal` : "";
}

function parseOptionalDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw httpError("Проверьте дату и время запуска расписания.", 400);
  return date;
}

function hashDutyRosterDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/i);
  if (!match) throw httpError("Загрузите CSV-файл разнарядки.", 400);
  const payload = match[2].replace(/\s/g, "");
  if (!payload) throw httpError("CSV-файл пустой.", 400);
  return crypto.createHash("sha256").update(Buffer.from(payload, "base64")).digest("hex");
}

function resolveScheduleImportRoute(body = {}) {
  const routeId = String(body.routeId || body.targetRouteId || "").trim();
  const routeNumber = normalizeRouteNumber(body.routeNumber || body.targetRouteNumber || "");
  if (!routeId && !routeNumber) return null;

  const routes = listRoutes();
  const route = routes.find((item) => item.id === routeId)
    || routes.find((item) => normalizeRouteNumber(item.number) === routeNumber);
  if (!route) throw httpError("Выбранный маршрут не найден в текущем расписании.", 404);
  return route;
}

function publicTelegramImportDocument(item) {
  return {
    id: item.id,
    kind: item.kind,
    fileName: item.fileName,
    size: item.size,
    uploadedBy: item.uploadedBy,
    createdAt: item.createdAt
  };
}

function telegramImportPayloads(admin, kind, options = {}) {
  const docs = listTelegramImportDocuments(admin, kind);
  const selected = options.multiple ? docs.slice(0, options.limit || 12).reverse() : docs.slice(0, 1);
  if (!selected.length) {
    const label = kind === "csv" ? "CSV разнарядки" : "XML расписания";
    throw httpError(`Сначала отправьте ${label} боту как документ, затем нажмите эту кнопку ещё раз.`, 404);
  }
  return {
    docs: selected,
    files: selected.map((item) => ({
      name: item.fileName,
      size: item.size,
      dataUrl: item.dataUrl
    }))
  };
}

function runScheduleXmlImport(body, admin, files) {
  const confirmed = body.confirmReplace === true || body.confirmReplace === "true" || body.confirmReplace === "on";
  if (!confirmed) {
    throw httpError("Подтвердите замену расписания загруженными XML-файлами.", 400);
  }

  const targetRoute = resolveScheduleImportRoute(body);
  const effectiveAt = parseOptionalDateTime(body.effectiveAt);
  const actor = admin.name || admin.role;
  const transportType = body.transportType || body.transportTypeOverride || "";

  if (effectiveAt && effectiveAt.getTime() > Date.now()) {
    if (body.mode === "replace_all") {
      throw httpError("Отложенная загрузка работает как точечная замена выбранного маршрута. Выберите режим обновления маршрута.", 400);
    }

    let preview;
    try {
      preview = inspectRouteImportFiles(files || [], {
        expectedRouteNumber: targetRoute?.number || "",
        transportType
      });
    } catch (error) {
      throw httpError(error.message || "Не удалось проверить XML-файл.", error.statusCode || 400);
    }
    if (!targetRoute && preview.routes.length !== 1) {
      throw httpError("Для отложенной замены или добавления загрузите один XML-файл одного маршрута.", 400);
    }
    const importRoute = targetRoute || preview.routes[0];

    const scheduledImport = createScheduledRouteImport({
      routeId: importRoute.id,
      routeNumber: importRoute.number,
      routeName: importRoute.name,
      mode: "upsert",
      files: files || [],
      effectiveAt: effectiveAt.toISOString(),
      summary: {
        routes: preview.routes,
        daySummary: preview.daySummary,
        transportType
      },
      createdBy: actor
    });

    return {
      ok: true,
      scheduled: true,
      scheduledImport,
      preview
    };
  }

  let result;
  try {
    result = importRoutesFromXmlFiles(files || [], {
      source: "admin-xml-upload",
      mode: body.mode,
      actor,
      expectedRouteNumber: body.mode === "replace_all" ? "" : targetRoute?.number,
      transportType,
      confirmFullReplace: body.confirmFullReplace === true || body.confirmFullReplace === "true"
    });
  } catch (error) {
    const wrapped = httpError(error.message || "Не удалось импортировать XML-расписание.", error.statusCode || 400);
    if (error.code) wrapped.code = error.code;
    if (error.details) wrapped.details = error.details;
    throw wrapped;
  }
  clearPublicJsonCache();
  return result;
}

function normalizeRouteNumber(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d+$/.test(text)) return String(Number(text));
  return text.toLocaleLowerCase("ru-RU");
}

function hasUploadMagic(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return false;
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (mimeType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mimeType === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "audio/ogg") return bytes.subarray(0, 4).toString("ascii") === "OggS";
  if (mimeType === "audio/mpeg") return (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) || bytes.subarray(0, 3).toString("ascii") === "ID3";
  if (mimeType === "audio/mp4") return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE";
  if (mimeType === "audio/webm") return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return false;
}

function isTelegramCommand(text, command) {
  const head = String(text || "").split(/\s+/)[0].toLowerCase();
  return head === `/${command}` || head.startsWith(`/${command}@`);
}

function isAdminAccessRequest(text) {
  const value = String(text || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/[.!?]+$/g, "");
  return [
    "админ",
    "админка",
    "админ панель",
    "админ-панель",
    "администратор",
    "admin",
    "admin panel",
    TELEGRAM_PANEL.admin.toLocaleLowerCase("ru-RU")
  ].includes(value);
}

function formatTelegramName(user = {}) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || "Работник";
}

async function saveImageUpload(dataUrl, originalName = "", kind = "ads") {
  if (!dataUrl) return "";

  const match = String(dataUrl).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw httpError("Загрузите картинку PNG, JPG, WEBP или GIF.", 400);

  const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif"
  }[mimeType];
  if (!extension) throw httpError("Этот формат картинки не поддерживается.", 400);

  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw httpError("Картинка должна быть не больше 5 МБ.", 413);
  }
  if (!hasUploadMagic(bytes, mimeType)) {
    throw httpError("Файл не похож на корректное изображение.", 400);
  }

  const uploadDir = kind === "news"
    ? NEWS_UPLOAD_DIR
    : kind === "leadership"
      ? LEADERSHIP_UPLOAD_DIR
      : kind === "services"
        ? SERVICE_UPLOAD_DIR
        : AD_UPLOAD_DIR;
  const folder = kind === "news" ? "news" : kind === "leadership" ? "leadership" : kind === "services" ? "services" : "ads";
  const defaultStem = kind === "news" ? "news" : kind === "leadership" ? "contact" : kind === "services" ? "service" : "ad";
  await fs.mkdir(uploadDir, { recursive: true });
  const safeStem = path
    .basename(String(originalName || defaultStem), path.extname(String(originalName || "")))
    .replace(/[^a-z0-9а-яё_-]+/gi, "-")
    .slice(0, 40) || defaultStem;
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeStem}.${extension}`;
  const filePath = path.join(uploadDir, fileName);
  if (!isInsideDirectory(uploadDir, filePath)) throw httpError("Некорректный путь файла.", 400);
  await fs.writeFile(filePath, bytes);
  return `/uploads/${folder}/${fileName}`;
}

async function saveAdImage(dataUrl, originalName = "") {
  return saveImageUpload(dataUrl, originalName, "ads");
}

async function saveNewsImage(dataUrl, originalName = "") {
  return saveImageUpload(dataUrl, originalName, "news");
}

async function saveLeadershipImage(dataUrl, originalName = "") {
  return saveImageUpload(dataUrl, originalName, "leadership");
}

async function saveServiceImage(dataUrl, originalName = "") {
  return saveImageUpload(dataUrl, originalName, "services");
}

async function saveAppealAttachment(dataUrl, originalName = "") {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw httpError("Поддерживаются картинки и аудио до 5 МБ.", 400);

  const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav"
  }[mimeType];
  const type = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "";
  if (!extension || !type) throw httpError("Поддерживаются картинки PNG, JPG, WEBP, GIF и аудио WEBM, OGG, MP3, M4A, WAV.", 400);

  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw httpError("Файл должен быть не больше 5 МБ.", 413);
  if (!hasUploadMagic(bytes, mimeType)) {
    throw httpError("Файл не совпадает с заявленным форматом.", 400);
  }

  await fs.mkdir(APPEAL_UPLOAD_DIR, { recursive: true });
  const safeStem = path
    .basename(String(originalName || type), path.extname(String(originalName || "")))
    .replace(/[^a-z0-9а-яё_-]+/gi, "-")
    .slice(0, 40) || type;
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeStem}.${extension}`;
  const filePath = path.join(APPEAL_UPLOAD_DIR, fileName);
  if (!isInsideDirectory(APPEAL_UPLOAD_DIR, filePath)) throw httpError("Некорректный путь файла.", 400);
  await fs.writeFile(filePath, bytes);
  return { type, url: `/uploads/appeals/${fileName}`, name: originalName || fileName, mimeType, size: bytes.length };
}

async function prepareAppealPayload(body) {
  const payload = { ...body };
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  payload.attachments = (
    await Promise.all(
      attachments.slice(0, 4).map((item) => saveAppealAttachment(item.data || item.dataUrl, item.name || "attachment"))
    )
  ).filter(Boolean);
  return payload;
}

// When appeals are purged/cleared, remove their uploaded files too — otherwise the
// 3-day retention promise only covers DB rows while images/audio live forever.
setAppealFileCleanupHandler((urls) => {
  for (const url of urls) {
    const fileName = normalizeAppealFileName(path.basename(String(url || "")));
    if (!fileName) continue;
    findAppealAttachmentFile(fileName)
      .then((file) => (file ? fs.unlink(file.filePath) : null))
      .catch(() => {});
  }
});

async function findAppealAttachmentFile(fileName) {
  for (const directory of [APPEAL_UPLOAD_DIR, LEGACY_APPEAL_UPLOAD_DIR]) {
    const filePath = path.join(directory, fileName);
    if (!isInsideDirectory(directory, filePath) || path.basename(filePath) !== fileName) continue;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isDirectory()) return { filePath, stat };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function sendAppealAttachmentFile(req, res, url, rawFileName) {
  const fileName = normalizeAppealFileName(rawFileName);
  if (!verifyAppealFileSignature(fileName, url.searchParams.get("expires"), url.searchParams.get("sig"))) {
    return sendText(res, 403, "Forbidden");
  }

  const file = await findAppealAttachmentFile(fileName);
  if (!file) return sendText(res, 404, "Not found");

  const ext = path.extname(file.filePath).toLowerCase();
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": "private, max-age=300",
    "content-length": file.stat.size
  });
  const stream = fsSync.createReadStream(file.filePath);
  // Without an error handler a mid-transfer read failure (file deleted/locked)
  // becomes an uncaught 'error' event and kills the process.
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function deletePublicUpload(fileUrl) {
  if (!fileUrl) return;
  const fileName = getAppealFileName(fileUrl);
  if (fileName) {
    await Promise.all(
      [APPEAL_UPLOAD_DIR, LEGACY_APPEAL_UPLOAD_DIR].map(async (directory) => {
        const filePath = path.join(directory, fileName);
        if (!isInsideDirectory(directory, filePath) || path.basename(filePath) !== fileName) return;
        await fs.unlink(filePath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      })
    );
    return;
  }
  if (!/^\/uploads\/(ads|news|leadership|services)\//.test(String(fileUrl))) return;
  const filePath = path.join(PUBLIC_DIR, String(fileUrl).replace(/^\//, ""));
  if (!isInsideDirectory(UPLOAD_DIR, filePath)) return;
  await fs.unlink(filePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw, WEBAPP_URL);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function normalizePublicUploadUrl(value, allowedFolders = ["ads", "news", "leadership", "services"]) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, WEBAPP_URL);
    const pathname = parsed.pathname || "";
    const folder = allowedFolders.find((item) => pathname.startsWith(`/uploads/${item}/`));
    if (!folder || parsed.origin !== new URL(WEBAPP_URL).origin && !raw.startsWith("/")) return "";
    const fileName = normalizeAppealFileName(pathname.slice(`/uploads/${folder}/`.length));
    return fileName ? `/uploads/${folder}/${encodeURIComponent(fileName)}` : "";
  } catch {
    return "";
  }
}

async function prepareAdPayload(body) {
  const payload = { ...body };
  const oldAd = payload.id ? getAd(payload.id) : null;
  const removeImage = payload.removeImage === true || payload.removeImage === "true" || payload.removeImage === "on";
  payload.url = normalizeHttpUrl(payload.url);

  if (payload.imageData) {
    payload.imageUrl = await saveAdImage(payload.imageData, payload.imageName);
  } else if (removeImage) {
    payload.imageUrl = "";
  } else if (payload.imageUrl !== undefined) {
    payload.imageUrl = normalizePublicUploadUrl(payload.imageUrl, ["ads"]);
  }

  delete payload.imageData;
  delete payload.imageName;
  delete payload.imageType;
  delete payload.removeImage;

  return { payload, oldImageUrl: oldAd?.imageUrl || "", removeImage };
}

async function prepareNewsPayload(body) {
  const payload = { ...body };
  const oldNews = payload.id ? getNews(payload.id) : null;
  const removeImage = payload.removeImage === true || payload.removeImage === "true" || payload.removeImage === "on";

  if (payload.imageData) {
    payload.imageUrl = await saveNewsImage(payload.imageData, payload.imageName);
  } else if (removeImage) {
    payload.imageUrl = "";
  } else if (payload.imageUrl !== undefined) {
    payload.imageUrl = normalizePublicUploadUrl(payload.imageUrl, ["news"]);
  }

  delete payload.imageData;
  delete payload.imageName;
  delete payload.imageType;
  delete payload.removeImage;

  return { payload, oldImageUrl: oldNews?.imageUrl || "", removeImage };
}

async function prepareServicePayload(body) {
  const payload = { ...body };
  const oldService = payload.id ? getService(payload.id) : null;
  const removeImage = payload.removeImage === true || payload.removeImage === "true" || payload.removeImage === "on";

  if (payload.imageData) {
    payload.imageUrl = await saveServiceImage(payload.imageData, payload.imageName);
  } else if (removeImage) {
    payload.imageUrl = "";
  } else if (payload.imageUrl !== undefined) {
    payload.imageUrl = normalizePublicUploadUrl(payload.imageUrl, ["services"]);
  }

  delete payload.imageData;
  delete payload.imageName;
  delete payload.imageType;
  delete payload.removeImage;

  return { payload, oldImageUrl: oldService?.imageUrl || "", removeImage };
}

function getTelegramUser(req) {
  const initData = req.headers["x-telegram-init-data"];
  if (!initData || !BOT_TOKEN) return null;

  const verification = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verification.ok) return null;

  const user = verification.user || {};
  return {
    isVerified: true,
    telegramId: user.id ? String(user.id) : "",
    firstName: user.first_name || "",
    lastName: user.last_name || "",
    username: user.username || "",
    languageCode: user.language_code || ""
  };
}

function requireVerifiedTelegramUser(user, message) {
  if (!REQUIRE_TELEGRAM_AUTH) return;
  if (!BOT_TOKEN) throw httpError("Telegram auth is required but BOT_TOKEN is not configured.", 500);
  if (!user?.isVerified) throw httpError(message, 401);
}

function verifyTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    if (!receivedHash) return { ok: false };

    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    const expected = Buffer.from(expectedHash, "hex");
    const received = Buffer.from(receivedHash, "hex");

    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return { ok: false };

    const authDate = Number(params.get("auth_date"));
    if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false };

    const authAgeMs = Date.now() - authDate * 1000;
    if (authAgeMs > TELEGRAM_INIT_DATA_TTL_MS || authAgeMs < -TELEGRAM_INIT_DATA_CLOCK_SKEW_MS) {
      return { ok: false };
    }

    const userRaw = params.get("user");
    return { ok: true, user: userRaw ? JSON.parse(userRaw) : null };
  } catch {
    return { ok: false };
  }
}

function createTelegramInitDataForLocalAdmin(admin, botToken) {
  const params = new URLSearchParams();
  const idNumber = Number(admin.telegramId);
  const user = {
    id: Number.isSafeInteger(idNumber) ? idNumber : String(admin.telegramId),
    first_name: String(admin.name || "Local Admin").trim().split(/\s+/)[0] || "Local Admin",
    last_name: "",
    username: "local_admin",
    language_code: "ru"
  };

  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", `local-${crypto.randomBytes(8).toString("hex")}`);
  params.set("user", JSON.stringify(user));

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex"));
  return params.toString();
}

function isLocalRequest(req) {
  const ip = normalizeIpAddress(req.socket?.remoteAddress || "");
  return ["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "localhost", "local"].includes(ip);
}

// Запрос, пришедший через обратный прокси (nginx/caddy/traefik → 127.0.0.1),
// несёт forwarding-заголовки, ДАЖЕ когда socket-IP — loopback. Настоящий
// localhost-запрос (dev) их не имеет. Считаем любой такой запрос НЕлокальным,
// чтобы эндпоинт локального входа (выдающий подписанную admin-сессию) нельзя
// было достать из интернета за прокси при забытом NODE_ENV=production.
function isProxiedRequest(req) {
  const h = req.headers || {};
  return Boolean(
    h["x-forwarded-for"] || h["x-forwarded-host"] || h["x-real-ip"] ||
    h["forwarded"] || h["cf-connecting-ip"] || h["x-forwarded-proto"]
  );
}

function getLocalLoginAdmin(url) {
  const telegramId = String(url.searchParams.get("telegramId") || "").trim();
  return listAdmins().find((admin) => {
    if (admin.role !== "admin" || Number(admin.active) === 0 || !admin.telegramId) return false;
    return !telegramId || String(admin.telegramId) === telegramId;
  });
}

function requireLocalAdminLogin(req, url) {
  if (IS_PRODUCTION || !isLocalRequest(req) || isProxiedRequest(req)) {
    throw httpError("Local admin login is available only from localhost in development.", 404);
  }
  if (!BOT_TOKEN) throw httpError("BOT_TOKEN is required for local admin login.", 500);
  const admin = getLocalLoginAdmin(url);
  if (!admin) throw httpError("No active saved administrator with Telegram ID was found.", 404);
  return admin;
}

function localLoginScriptUrl(url) {
  const params = new URLSearchParams();
  const telegramId = String(url.searchParams.get("telegramId") || "").trim();
  if (telegramId) params.set("telegramId", telegramId);
  return `/admin-local-login.js${params.size ? `?${params}` : ""}`;
}

function sendLocalAdminLoginPage(req, res, url) {
  requireLocalAdminLogin(req, url);
  return sendBody(res, 200, [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Local admin login</title></head>",
    "<body>",
    "<p>Opening local admin panel...</p>",
    `<script src="${localLoginScriptUrl(url)}"></script>`,
    "</body></html>"
  ].join(""), "text/html; charset=utf-8");
}

function sendLocalAdminLoginScript(req, res, url) {
  const admin = requireLocalAdminLogin(req, url);
  const initData = createTelegramInitDataForLocalAdmin(admin, BOT_TOKEN);
  const script = [
    `"use strict";`,
    `sessionStorage.setItem("adminTelegramInitData", ${JSON.stringify(initData)});`,
    `sessionStorage.removeItem("adminKey");`,
    `sessionStorage.setItem("adminRole", "admin");`,
    `location.replace("/admin");`
  ].join("\n");
  return sendBody(res, 200, script, "text/javascript; charset=utf-8");
}

function resolveAdmin(req, url) {
  const telegramUser = getTelegramUser(req);
  if (telegramUser?.telegramId) {
    const admin = getAdminByTelegramId(telegramUser.telegramId);
    if (admin) return { ...admin, source: "telegram" };
  }

  const headerKey = String(firstHeader(req.headers["x-admin-key"]) || "");
  const queryKey = ALLOW_ADMIN_QUERY_KEY ? url.searchParams.get("key") || "" : "";
  const key = headerKey || queryKey;
  const canUseAccessKey = ADMIN_KEY && !isWeakAdminKey(ADMIN_KEY);
  if (key && canUseAccessKey && safeEquals(key, ADMIN_KEY)) {
    const roleOverrideAllowed = ALLOW_ADMIN_ROLE_OVERRIDE;
    const role = roleOverrideAllowed
      ? firstHeader(req.headers["x-admin-role"]) || url.searchParams.get("role") || "admin"
      : "admin";
    return {
      id: "admin-key",
      name: "Настройки",
      role: ROLE_LABELS[role] ? role : "admin",
      source: "key"
    };
  }

  return null;
}

function requireAdmin(req, url, permission) {
  const admin = resolveAdmin(req, url);
  if (!admin) throw httpError("Нужен доступ администратора.", 401);
  if (permission && !hasPermission(admin.role, permission)) throw httpError("Для этой операции не хватает роли.", 403);
  return admin;
}

function requireOwnerAdmin(req, url, permission) {
  const admin = requireAdmin(req, url, permission);
  if (admin.role !== "admin") throw httpError("Only the administrator can perform this cleanup.", 403);
  return admin;
}

function requireStoredAdmin(req, url, permission) {
  const admin = requireAdmin(req, url, permission);
  if (admin.source === "key" || admin.id === "admin-key") {
    throw httpError("A saved administrator account is required for persistent staff access changes.", 403);
  }
  return admin;
}

function requireStoredOwnerAdmin(req, url, permission) {
  const admin = requireOwnerAdmin(req, url, permission);
  if (admin.source === "key" || admin.id === "admin-key") {
    throw httpError("A saved administrator account is required for staff access changes.", 403);
  }
  return admin;
}

function publicAppeal(appeal) {
  return {
    id: appeal.id,
    status: appeal.status,
    category: appeal.category,
    routeNumber: appeal.routeNumber,
    stopName: appeal.stopName,
    createdAt: appeal.createdAt,
    updatedAt: appeal.updatedAt
  };
}

// Staff view of an appeal. clientToken is the CLIENT's chat credential — leaking it
// to staff would let any staff role impersonate the client through the public API.
function staffAppeal(appeal) {
  if (!appeal) return appeal;
  const { clientToken, ...rest } = appeal;
  return rest;
}

function requireClientAppealAccess(req, url, appeal, body = {}) {
  const user = getTelegramUser(req);
  if (user?.telegramId && appeal.telegramId && user.telegramId === appeal.telegramId) return true;

  const token = body.clientToken || firstHeader(req.headers["x-appeal-token"]) || firstHeader(req.headers.authorization)?.replace(/^Bearer\s+/i, "");
  if (token && appeal.clientToken && safeEquals(token, appeal.clientToken)) return true;

  throw httpError("Нет доступа к этому чату.", 403);
}

function cleanClientId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9:_-]/gi, "")
    .slice(0, 96);
}

function getNewsVoterId(req, body = {}) {
  const user = getTelegramUser(req);
  if (user?.telegramId) return `tg:${user.telegramId}`;

  const clientId = cleanClientId(body.clientId);
  if (clientId) return `client:${clientId}`;

  const fingerprint = [
    getRequestIp(req),
    firstHeader(req.headers["user-agent"]) || "",
    firstHeader(req.headers["accept-language"]) || ""
  ].join("|");
  return `anon:${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

function ensureAdminCanOpenAppeal(admin, appealId) {
  if (!admin || !hasPermission(admin.role, "appeals")) throw httpError("Нет доступа к обращениям.", 403);
  const appeal = getAppeal(appealId);
  if (!appeal) throw httpError("Обращение не найдено.", 404);
  // Same rule listAppeals filters by, without scanning the whole table per message.
  const visible = admin.role === "admin" || admin.role === resolveAppealAssignedRole(appeal.category);
  if (!visible) throw httpError("Эта роль не видит данный чат.", 403);
  return appeal;
}

function getPublicStats() {
  const stats = getStats();
  return {
    routes: stats.routes,
    stops: stats.stops,
    departures: stats.departures
  };
}

function getAdminStats(admin) {
  const stats = getStats();
  if (admin?.role === "admin") return stats;
  const { visits, ...safeStats } = stats;
  return safeStats;
}

function getPublicBootstrapData() {
  return {
    cityName: CITY_NAME,
    // No timestamp on purpose: nothing consumes it, and it churned the ETag every
    // cache refill so returning clients could never get a 304 for this ~57KB payload.
    timeZone: "Europe/Minsk",
    webAppUrl: WEBAPP_URL,
    map: {
      yandexApiKey: YANDEX_MAPS_API_KEY,
      city: CITY_NAME
    },
    feedback: {
      botUsername: BOT_USERNAME,
      botStartUrl: getFeedbackBotStartUrl()
    },
    stats: getPublicStats(),
    routes: listRoutes(),
    ads: listActiveAds(),
    services: listServices(),
    news: listNews(),
    leadership: listLeadershipContacts()
  };
}

function warmPublicCaches() {
  try {
    getCachedPublicJson(PUBLIC_BOOTSTRAP_CACHE_KEY, PUBLIC_JSON_CACHE_TTL_MS, getPublicBootstrapData);
    getCachedPublicJson("public:routes:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listRoutes());
    getCachedPublicJson("public:ads:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listActiveAds());
    getCachedPublicJson("public:services:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listServices());
    getCachedPublicJson("public:news:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listNews());
  } catch (error) {
    console.warn(`Public cache warmup failed: ${error.message || error}`);
  }
}

async function getBootstrapData(req) {
  return getPublicBootstrapData();
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  const appealFileMatch = pathname.match(/^\/api\/files\/appeals\/([^/]+)$/);
  if (req.method === "GET" && appealFileMatch) {
    return sendAppealAttachmentFile(req, res, url, appealFileMatch[1]);
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, cityName: CITY_NAME, stats: getPublicStats() });
  }

  if (req.method === "GET" && PUBLIC_READ_API_PATHS.has(pathname)) {
    enforcePublicReadLimit(req);
  }

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    return sendCachedJson(res, 200, PUBLIC_BOOTSTRAP_CACHE_KEY, PUBLIC_JSON_CACHE_TTL_MS, getPublicBootstrapData);
  }

  if (req.method === "GET" && pathname === "/api/staff/access") {
    const user = getTelegramUser(req);
    const admin = user?.telegramId ? getAdminByTelegramId(user.telegramId) : null;
    const hasAccess = canOpenSettings(admin);
    return sendJson(res, 200, {
      ok: true,
      hasAccess,
      role: hasAccess ? admin.role : "",
      roleLabel: hasAccess ? ROLE_LABELS[admin.role] || admin.role : "",
      name: hasAccess ? admin.name || "" : ""
    });
  }

  if (req.method === "GET" && pathname === "/api/routes") {
    return sendCachedJson(res, 200, "public:routes:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listRoutes());
  }

  if (req.method === "GET" && pathname === "/api/routes/search") {
    enforceRateLimit(req, getTelegramUser(req), "route-search", RATE_LIMITS.routeSearch);
    const params = {
      from: limitedQueryParam(url, "from", 160),
      to: limitedQueryParam(url, "to", 160),
      date: limitedQueryParam(url, "date", 16),
      time: limitedQueryParam(url, "time", 16),
      limit: limitedQueryParam(url, "limit", 8)
    };
    // Normalized cache key: trim/case variants of the same query must hit the
    // same entry instead of each burning a fresh synchronous search.
    const cacheParams = {
      from: params.from.trim().toLocaleLowerCase("ru-RU"),
      to: params.to.trim().toLocaleLowerCase("ru-RU"),
      date: params.date.trim(),
      time: params.time.trim(),
      limit: params.limit.trim()
    };
    return sendCachedJson(res, 200, publicCacheKey("route-search", cacheParams), PUBLIC_JSON_CACHE_TTL_MS, () => ({
      ok: true,
      ...searchRoutesBetweenStops(params)
    }));
  }

  if (req.method === "GET" && pathname === "/api/schedule") {
    const routeId = limitedQueryParam(url, "routeId", 80);
    const directionCode = limitedQueryParam(url, "directionCode", 40);
    const stopUid = limitedQueryParam(url, "stopUid", 120);
    if (!routeId || !directionCode || !stopUid) throw httpError("Не выбран маршрут, направление или остановка.", 400);
    return sendCachedJson(res, 200, publicCacheKey("schedule", [routeId, directionCode, stopUid]), PUBLIC_JSON_CACHE_TTL_MS, () =>
      getSchedule({ routeId, directionCode, stopUid })
    );
  }

  if (req.method === "GET" && pathname === "/api/trip/timeline") {
    const params = {
      routeId: limitedQueryParam(url, "routeId", 80),
      directionCode: limitedQueryParam(url, "directionCode", 40),
      dayMask: limitedQueryParam(url, "dayMask", 20),
      tripCode: limitedQueryParam(url, "tripCode", 80),
      variantCode: limitedQueryParam(url, "variantCode", 80)
    };
    return sendCachedJson(res, 200, publicCacheKey("timeline", params), PUBLIC_JSON_CACHE_TTL_MS, () => ({
      ok: true,
      timeline: getTripTimeline(params)
    }));
  }

  if (req.method === "GET" && pathname === "/api/stops/search") {
    const query = limitedQueryParam(url, "q", 120);
    return sendCachedJson(res, 200, publicCacheKey("stops-search", [query]), PUBLIC_JSON_CACHE_TTL_MS, () => ({
      ok: true,
      stops: searchStops(query)
    }));
  }

  if (req.method === "GET" && pathname === "/api/stops/board") {
    const stopName = limitedQueryParam(url, "stop", 160);
    return sendCachedJson(res, 200, publicCacheKey("stops-board", [stopName]), PUBLIC_JSON_CACHE_TTL_MS, () => ({
      ok: true,
      board: getStopBoard(stopName)
    }));
  }

  if (req.method === "GET" && pathname === "/api/ads") {
    return sendCachedJson(res, 200, "public:ads:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listActiveAds());
  }

  if (req.method === "GET" && pathname === "/api/services") {
    return sendCachedJson(res, 200, "public:services:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listServices());
  }

  if (req.method === "GET" && pathname === "/api/news") {
    return sendCachedJson(res, 200, "public:news:v1", PUBLIC_JSON_CACHE_TTL_MS, () => listNews());
  }

  const newsViewMatch = pathname.match(/^\/api\/news\/([^/]+)\/view$/);
  if (req.method === "POST" && newsViewMatch) {
    enforceRateLimit(req, getTelegramUser(req), "news-view", RATE_LIMITS.newsView);
    return sendJson(res, 200, { ok: true, item: incrementNewsView(decodeURIComponent(newsViewMatch[1])) });
  }

  const newsLikeMatch = pathname.match(/^\/api\/news\/([^/]+)\/like$/);
  if (req.method === "POST" && newsLikeMatch) {
    const body = await parseBody(req);
    enforceRateLimit(req, getTelegramUser(req), "news-like", RATE_LIMITS.newsLike);
    return sendJson(res, 200, {
      ok: true,
      item: setNewsLike(decodeURIComponent(newsLikeMatch[1]), body.liked !== false, getNewsVoterId(req, body))
    });
  }

  if (req.method === "POST" && pathname === "/api/subscribe") {
    const user = getTelegramUser(req);
    if (!user?.telegramId) return sendJson(res, 200, { ok: false, subscribed: false });
    upsertSubscriber(user);
    return sendJson(res, 200, { ok: true, subscribed: true });
  }

  if (req.method === "GET" && pathname === "/api/appeals") {
    const user = getTelegramUser(req);
    requireVerifiedTelegramUser(user, "Open appeals through Telegram Mini App.");
    if (!user?.telegramId) return sendJson(res, 200, { ok: true, appeals: [], requiresTelegram: true });
    return sendJson(res, 200, { ok: true, appeals: listAppealsForTelegram(user.telegramId) });
  }

  if (req.method === "POST" && pathname === "/api/appeals") {
    const user = getTelegramUser(req);
    requireVerifiedTelegramUser(user, "Open the form through Telegram Mini App.");

    enforceRateLimit(req, user, "appeal-create", RATE_LIMITS.appealCreate);
    const appeal = createAppeal(await prepareAppealPayload(await parseBody(req, MAX_APPEAL_BODY_BYTES)), user);
    await notifyAdmins(appeal);
    return sendJson(res, 201, {
      ok: true,
      appeal: {
        id: appeal.id,
        clientToken: appeal.clientToken,
        status: appeal.status,
        createdAt: appeal.createdAt
      }
    });
  }

  const clientMessagesMatch = pathname.match(/^\/api\/appeals\/([^/]+)\/messages$/);
  if (clientMessagesMatch && req.method === "GET") {
    const appeal = getAppeal(clientMessagesMatch[1]);
    if (!appeal) throw httpError("Обращение не найдено.", 404);
    requireClientAppealAccess(req, url, appeal);
    return sendJson(res, 200, { ok: true, appeal: publicAppeal(appeal), messages: signAppealMessages(listAppealMessages(appeal.id)) });
  }

  if (clientMessagesMatch && req.method === "POST") {
    const appeal = getAppeal(clientMessagesMatch[1]);
    if (!appeal) throw httpError("Обращение не найдено.", 404);
    // Rate-limit BEFORE buffering the (up to 32MB) body, otherwise the limit
    // does not protect against upload floods at all.
    const user = getTelegramUser(req);
    enforceRateLimit(req, user, "appeal-message", RATE_LIMITS.appealMessage);
    const rawBody = await parseBody(req, MAX_APPEAL_BODY_BYTES);
    requireClientAppealAccess(req, url, appeal, rawBody);
    const body = await prepareAppealPayload(rawBody);
    const message = addAppealMessage(appeal.id, {
      senderType: "client",
      text: body.text,
      attachments: body.attachments,
      actorName: user?.firstName || appeal.firstName || appeal.telegramUsername || "Клиент",
      telegramId: user?.telegramId || appeal.telegramId || ""
    });
    await notifyAdmins({ ...appeal, text: `Новое сообщение в чате:\n${message.text || "Вложение без текста"}` });
    return sendJson(res, 201, { ok: true, message: signAppealMessage(message) });
  }

  if (req.method === "POST" && pathname === "/api/reminders") {
    const user = getTelegramUser(req);
    enforceRateLimit(req, user, "reminder-create", RATE_LIMITS.reminderCreate);
    const reminder = createReminder(await parseBody(req), user);
    return sendJson(res, 201, { ok: true, reminder });
  }

  const reminderMatch = pathname.match(/^\/api\/reminders\/([^/]+)$/);
  if (req.method === "DELETE" && reminderMatch) {
    const user = getTelegramUser(req);
    enforceRateLimit(req, user, "reminder-cancel", RATE_LIMITS.reminderCancel);
    return sendJson(res, 200, cancelReminder(decodeURIComponent(reminderMatch[1]), user));
  }

  if (pathname.startsWith("/api/map/") || pathname === "/api/user/favorites") {
    if (await mapModule.handlePublicApi(req, res, url)) return;
  }

  if (pathname.startsWith("/api/admin/")) {
    const user = getTelegramUser(req);
    enforceRateLimit(req, user, "admin-api", RATE_LIMITS.adminApi);
    if (pathname === "/api/admin/bootstrap") {
      enforceRateLimit(req, user, "admin-auth", RATE_LIMITS.adminAuth);
    }
    return await handleAdminApi(req, res, url);
  }

  throw httpError("API route not found", 404);
}

async function handleAdminApi(req, res, url) {
  const pathname = url.pathname;

  if (await mapModule.handleAdminApi(req, res, url)) return;

  if (req.method === "GET" && pathname === "/api/admin/bootstrap") {
    const admin = requireAdmin(req, url);
    // Roles without any panel permission (driver, worker) authenticate as staff
    // but must not receive operational stats (appeal/subscriber counts).
    const hasAnyPermission = (PERMISSIONS[admin.role] || []).length > 0;
    return sendJson(res, 200, {
      ok: true,
      admin,
      roles: ROLE_LABELS,
      permissions: PERMISSIONS,
      stats: hasAnyPermission ? getAdminStats(admin) : getPublicStats(),
      summary: hasAnyPermission ? getAppealSummary(admin.role).summary : {}
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/visits") {
    requireOwnerAdmin(req, url, "visits");
    return sendJson(res, 200, { ok: true, visits: getStats().visits || {} });
  }

  if (req.method === "GET" && pathname === "/api/admin/summary") {
    const admin = requireAdmin(req, url, "appeals");
    return sendJson(res, 200, getAppealSummary(admin.role));
  }

  if (req.method === "GET" && pathname === "/api/admin/appeals") {
    const admin = requireAdmin(req, url, "appeals");
    return sendJson(res, 200, { ok: true, appeals: listAppeals(admin.role) });
  }

  if (req.method === "DELETE" && pathname === "/api/admin/appeals") {
    const admin = requireOwnerAdmin(req, url, "appeals");
    return sendJson(res, 200, clearAppeals(admin.role));
  }

  if (req.method === "GET" && pathname === "/api/admin/schedule/routes") {
    requireAdmin(req, url, "schedule");
    return sendJson(res, 200, { ok: true, routes: listRoutes() });
  }

  if (req.method === "POST" && pathname === "/api/admin/schedule/import") {
    const admin = requireAdmin(req, url);
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Загрузка XML доступна только администратору и диспетчеру.", 403);
    }

    enforceRateLimit(req, admin, "xml-import", RATE_LIMITS.xmlImport);
    const body = await parseBody(req, MAX_XML_IMPORT_BYTES);
    const result = runScheduleXmlImport(body, admin, body.files || []);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/admin/schedule/import-telegram") {
    const admin = requireAdmin(req, url);
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Загрузка XML доступна только администратору и диспетчеру.", 403);
    }

    enforceRateLimit(req, admin, "xml-import", RATE_LIMITS.xmlImport);
    const body = await parseBody(req);
    const imported = telegramImportPayloads(admin, "xml", { multiple: true, limit: 12 });
    const result = runScheduleXmlImport(body, admin, imported.files);
    return sendJson(res, 200, {
      ...result,
      telegramFiles: imported.docs.map(publicTelegramImportDocument)
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/schedule/scheduled-imports") {
    const admin = requireAdmin(req, url);
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Отложенные замены доступны только администратору и диспетчеру.", 403);
    }
    const cleanup = cleanupScheduleMaintenanceRecords();
    return sendJson(res, 200, {
      ok: true,
      imports: listScheduledRouteImports(Number(url.searchParams.get("limit") || 30)),
      cleanup
    });
  }

  const scheduledImportMatch = pathname.match(/^\/api\/admin\/schedule\/scheduled-imports\/([A-Za-z0-9_-]+)$/);
  if (req.method === "DELETE" && scheduledImportMatch) {
    const admin = requireAdmin(req, url);
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Отменять отложенные замены может только администратор или диспетчер.", 403);
    }
    return sendJson(res, 200, cancelScheduledRouteImport(scheduledImportMatch[1], admin.name || admin.role));
  }

  if (req.method === "GET" && pathname === "/api/admin/schedule/backups") {
    const admin = requireAdmin(req, url);
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Откат расписания доступен только администратору и диспетчеру.", 403);
    }
    const cleanup = cleanupScheduleMaintenanceRecords();
    return sendJson(res, 200, {
      ok: true,
      backups: listScheduleBackups(Number(url.searchParams.get("limit") || 10)),
      cleanup
    });
  }

  if (req.method === "POST" && pathname === "/api/admin/schedule/rollback") {
    const admin = requireAdmin(req, url);
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Откат расписания доступен только администратору и диспетчеру.", 403);
    }
    const body = await parseBody(req);
    const confirmed = body.confirmRollback === true || body.confirmRollback === "true" || body.confirmRollback === "on";
    if (!confirmed) throw httpError("Подтвердите откат расписания.", 400);
    const result = restoreScheduleBackup(body.backupId, admin.name || admin.role);
    clearPublicJsonCache();
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && pathname === "/api/admin/schedule/departures") {
    requireAdmin(req, url, "schedule");
    return sendJson(res, 200, {
      ok: true,
      departures: listAdminDepartures({
        routeId: url.searchParams.get("routeId") || "",
        directionCode: url.searchParams.get("directionCode") || "",
        stopUid: url.searchParams.get("stopUid") || ""
      })
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/schedule/audit") {
    requireAdmin(req, url, "schedule");
    return sendJson(res, 200, { ok: true, changes: listScheduleAudit(Number(url.searchParams.get("limit") || 80)) });
  }

  if (req.method === "DELETE" && pathname === "/api/admin/schedule/audit") {
    requireOwnerAdmin(req, url, "schedule");
    return sendJson(res, 200, clearScheduleAudit());
  }

  const auditDeleteMatch = pathname.match(/^\/api\/admin\/schedule\/audit\/(\d+)$/);
  if (req.method === "DELETE" && auditDeleteMatch) {
    requireOwnerAdmin(req, url, "schedule");
    return sendJson(res, 200, deleteScheduleAudit(Number(auditDeleteMatch[1])));
  }

  if (req.method === "POST" && pathname === "/api/admin/schedule/departures") {
    const admin = requireAdmin(req, url, "schedule");
    const departure = saveDeparture(await parseBody(req), admin.name || admin.role);
    clearPublicJsonCache();
    return sendJson(res, 200, { ok: true, departure });
  }

  const departureDeleteMatch = pathname.match(/^\/api\/admin\/schedule\/departures\/(\d+)$/);
  if (req.method === "DELETE" && departureDeleteMatch) {
    const admin = requireAdmin(req, url, "schedule");
    const result = deleteDeparture(Number(departureDeleteMatch[1]), {
      applyToTrip: url.searchParams.get("applyToTrip") === "true",
      actor: admin.name || admin.role
    });
    clearPublicJsonCache();
    return sendJson(
      res,
      200,
      result
    );
  }

  if (req.method === "POST" && pathname === "/api/admin/schedule/meta") {
    const admin = requireAdmin(req, url, "schedule");
    const result = updateScheduleMeta(await parseBody(req), admin.name || admin.role);
    clearPublicJsonCache();
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && pathname === "/api/admin/roster") {
    requireAdmin(req, url, "roster");
    const uploads = listDutyRosterUploads(Number(url.searchParams.get("limit") || 20));
    return sendJson(res, 200, {
      ok: true,
      uploads,
      drivers: listDriverUsers()
    });
  }

  if (req.method === "DELETE" && pathname === "/api/admin/roster") {
    requireOwnerAdmin(req, url, "roster");
    return sendJson(res, 200, clearDutyRosterUploads());
  }

  if (req.method === "POST" && pathname === "/api/admin/roster/drivers") {
    const admin = requireStoredAdmin(req, url, "roster");
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Водителей разнарядки может менять только администратор или диспетчер.", 403);
    }
    const driver = registerDriverUser(await parseBody(req));
    return sendJson(res, 200, { ok: true, driver, drivers: listDriverUsers() });
  }

  const rosterDriverDeleteMatch = pathname.match(/^\/api\/admin\/roster\/drivers\/([^/]+)$/);
  if (req.method === "DELETE" && rosterDriverDeleteMatch) {
    const admin = requireStoredAdmin(req, url, "roster");
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Водителей разнарядки может менять только администратор или диспетчер.", 403);
    }
    const result = deleteDriverUser(decodeURIComponent(rosterDriverDeleteMatch[1]));
    return sendJson(res, 200, { ok: true, ...result, drivers: listDriverUsers() });
  }

  if (req.method === "POST" && pathname === "/api/admin/roster/upload") {
    const admin = requireAdmin(req, url, "roster");
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Разнарядку может загружать только администратор или диспетчер.", 403);
    }

    enforceRateLimit(req, admin, "roster-upload", RATE_LIMITS.rosterUpload);
    const body = await parseBody(req, MAX_DUTY_ROSTER_BYTES);
    let telegramFiles = [];
    if (body.useTelegramDocument === true || body.useTelegramDocument === "true") {
      const imported = telegramImportPayloads(admin, "csv");
      body.fileData = imported.files[0]?.dataUrl || "";
      body.fileName = imported.files[0]?.name || body.fileName || "telegram-roster.csv";
      telegramFiles = imported.docs.map(publicTelegramImportDocument);
    }
    const fileData = body.fileData || body.dataUrl || "";
    const targetSquad = normalizeRosterTargetSquad(body.driverSquad || body.targetSquad);
    if (!targetSquad) throw httpError("Выберите отряд водителей для отправки разнарядки.", 400);
    const fileHash = `${hashDutyRosterDataUrl(fileData)}:${targetSquad}`;
    const text = parseRosterDataUrl(fileData);
    const parsed = parseDutyRoster(text);
    if (!parsed.items.length) throw httpError("В CSV не найдены назначения водителей. Проверьте файл разнарядки.", 400);
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    const hasWarnings = warnings.length > 0;
    const targetDrivers = listDriverUsers().filter((driver) => normalizeRosterTargetSquad(driver.driverSquad) === targetSquad);

    const duplicateSentUpload = findSentDutyRosterUploadByHash(fileHash);
    // Rosters with parser warnings (ambiguous codes, assumed date, skipped rows)
    // are held for review so neither the manual send nor the daily job blasts them
    // out without an explicit confirmation.
    const upload = createDutyRosterUpload({
      fileName: body.fileName || "roster.csv",
      fileHash,
      scheduleDate: parsed.scheduleDate,
      status: hasWarnings ? "needs_review" : "parsed",
      uploadedBy: admin.name || ROLE_LABELS[admin.role] || "Админ-панель",
      targetSquad,
      warnings,
      items: parsed.items
    });
    const summary = {
      ...summarizeParsedRoster(parsed, targetDrivers),
      targetSquad,
      targetDrivers: targetDrivers.length
    };

    // No automatic broadcast on upload. Sending to drivers is an explicit,
    // confirmed action in the admin panel (or the opt-in daily auto-send job).
    return sendJson(res, 200, {
      ok: true,
      upload,
      summary,
      autoSend: {
        ok: false,
        status: "manual",
        message: hasWarnings
          ? "Разнарядка загружена с предупреждениями. Проверьте и подтвердите отправку."
          : "Разнарядка загружена. Проверьте превью и нажмите «Отправить водителям»."
      },
      warnings,
      duplicateSentUpload,
      telegramFiles,
      canSend: true,
      requiresConfirmation: true,
      preview: parsed.items.slice(0, 18),
      unregisteredTabs: listDutyRosterUnregisteredTabs(upload.id)
    });
  }

  const rosterSendMatch = pathname.match(/^\/api\/admin\/roster\/([^/]+)\/send$/);
  if (req.method === "POST" && rosterSendMatch) {
    const admin = requireAdmin(req, url, "roster");
    if (!["admin", "dispatcher"].includes(admin.role)) {
      throw httpError("Разнарядку может отправлять только администратор или диспетчер.", 403);
    }

    enforceRateLimit(req, admin, "roster-send", RATE_LIMITS.rosterSend);
    const body = await parseBody(req);
    // force is opt-in: an absent flag must NOT bypass the needs_review/duplicate
    // guards, otherwise the admin confirm flow is dead code.
    const force = body.force === true || body.force === "true";
    const result = await sendDutyRosterById(decodeURIComponent(rosterSendMatch[1]), {
      force,
      sendNoAssignment: body.sendNoAssignment === true || body.sendNoAssignment === "true"
    });
    return sendJson(res, 200, {
      ok: true,
      upload: result.upload,
      report: result.report,
      unregisteredTabs: listDutyRosterUnregisteredTabs(result.upload.id)
    });
  }

  const statusMatch = pathname.match(/^\/api\/admin\/appeals\/([^/]+)\/status$/);
  if (req.method === "PATCH" && statusMatch) {
    const admin = requireAdmin(req, url, "appeals");
    const body = await parseBody(req);
    ensureAdminCanOpenAppeal(admin, statusMatch[1]);
    const appeal = updateAppealStatus(statusMatch[1], body.status, admin.name || admin.role);
    if (body.status === "closed") {
      addAppealMessage(appeal.id, {
        senderType: "system",
        text: "Чат закрыт администрацией.",
        actorName: admin.name || admin.role
      });
      if (appeal.telegramId) {
        activeTelegramAppeals.delete(String(appeal.telegramId));
        await callTelegram("sendMessage", {
          chat_id: appeal.telegramId,
          text: "Чат закрыт. Спасибо за сообщение."
        }).catch(() => {});
      }
    }
    return sendJson(res, 200, { ok: true, appeal: staffAppeal(appeal) });
  }

  const adminMessagesMatch = pathname.match(/^\/api\/admin\/appeals\/([^/]+)\/messages$/);
  if (req.method === "GET" && adminMessagesMatch) {
    const admin = requireAdmin(req, url, "appeals");
    const appeal = ensureAdminCanOpenAppeal(admin, adminMessagesMatch[1]);
    return sendJson(res, 200, { ok: true, appeal: staffAppeal(appeal), messages: signAppealMessages(listAppealMessages(appeal.id)) });
  }

  if (req.method === "POST" && adminMessagesMatch) {
    const admin = requireAdmin(req, url, "appeals");
    const appeal = ensureAdminCanOpenAppeal(admin, adminMessagesMatch[1]);
    const body = await prepareAppealPayload(await parseBody(req, MAX_APPEAL_BODY_BYTES));
    const message = addAppealMessage(appeal.id, {
      senderType: "admin",
      text: body.text,
      attachments: body.attachments,
      actorName: admin.name || ROLE_LABELS[admin.role] || "Администратор"
    });
    if (appeal.status === "new") updateAppealStatus(appeal.id, "in_progress", admin.name || admin.role);
    const updatedAppeal = getAppeal(appeal.id) || appeal;
    if (appeal.telegramId) {
      activeTelegramAppeals.set(String(appeal.telegramId), appeal.id);
      await callTelegram("sendMessage", {
        chat_id: appeal.telegramId,
        text: message.text || "Вложение от администратора."
      }).catch(() => {});
    }
    return sendJson(res, 201, { ok: true, appeal: staffAppeal(updatedAppeal), message: signAppealMessage(message) });
  }

  if (req.method === "GET" && pathname === "/api/admin/ads") {
    requireAdmin(req, url, "ads");
    return sendJson(res, 200, { ok: true, ads: listAds() });
  }

  if (req.method === "POST" && pathname === "/api/admin/ads") {
    requireAdmin(req, url, "ads");
    const { payload, oldImageUrl, removeImage } = await prepareAdPayload(await parseBody(req));
    const ad = saveAd(payload);
    if ((removeImage || (payload.imageUrl && oldImageUrl !== payload.imageUrl)) && oldImageUrl) {
      await deletePublicUpload(oldImageUrl);
    }
    clearPublicJsonCache(PUBLIC_BOOTSTRAP_CACHE_KEY, "public:ads:v1");
    return sendJson(res, 200, { ok: true, ad });
  }

  const adDeleteMatch = pathname.match(/^\/api\/admin\/ads\/([^/]+)$/);
  if (req.method === "DELETE" && adDeleteMatch) {
    requireAdmin(req, url, "ads");
    const result = deleteAd(decodeURIComponent(adDeleteMatch[1]));
    await deletePublicUpload(result.deleted?.imageUrl);
    clearPublicJsonCache(PUBLIC_BOOTSTRAP_CACHE_KEY, "public:ads:v1");
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && pathname === "/api/admin/services") {
    requireAdmin(req, url, "services");
    return sendJson(res, 200, { ok: true, services: listServices({ includeInactive: true }) });
  }

  if (req.method === "POST" && pathname === "/api/admin/services") {
    requireAdmin(req, url, "services");
    const { payload, oldImageUrl, removeImage } = await prepareServicePayload(await parseBody(req));
    const service = saveService(payload);
    if ((removeImage || (payload.imageUrl && oldImageUrl !== payload.imageUrl)) && oldImageUrl) {
      await deletePublicUpload(oldImageUrl);
    }
    clearPublicJsonCache(PUBLIC_BOOTSTRAP_CACHE_KEY, "public:services:v1");
    return sendJson(res, 200, { ok: true, service });
  }

  const serviceDeleteMatch = pathname.match(/^\/api\/admin\/services\/([^/]+)$/);
  if (req.method === "DELETE" && serviceDeleteMatch) {
    requireAdmin(req, url, "services");
    const result = deleteService(decodeURIComponent(serviceDeleteMatch[1]));
    await deletePublicUpload(result.deleted?.imageUrl);
    clearPublicJsonCache(PUBLIC_BOOTSTRAP_CACHE_KEY, "public:services:v1");
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && pathname === "/api/admin/news") {
    requireAdmin(req, url, "news");
    return sendJson(res, 200, { ok: true, news: listNews({ includeDrafts: true }) });
  }

  if (req.method === "POST" && pathname === "/api/admin/news") {
    requireAdmin(req, url, "news");
    const { payload, oldImageUrl, removeImage } = await prepareNewsPayload(await parseBody(req));
    const item = saveNews(payload);
    if ((removeImage || (payload.imageUrl && oldImageUrl !== payload.imageUrl)) && oldImageUrl) {
      await deletePublicUpload(oldImageUrl);
    }
    clearPublicJsonCache(PUBLIC_BOOTSTRAP_CACHE_KEY, "public:news:v1");
    return sendJson(res, 200, { ok: true, item });
  }

  const newsDeleteMatch = pathname.match(/^\/api\/admin\/news\/([^/]+)$/);
  if (req.method === "DELETE" && newsDeleteMatch) {
    requireAdmin(req, url, "news");
    const result = deleteNews(decodeURIComponent(newsDeleteMatch[1]));
    await deletePublicUpload(result.deleted?.imageUrl);
    clearPublicJsonCache(PUBLIC_BOOTSTRAP_CACHE_KEY, "public:news:v1");
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && pathname === "/api/admin/notifications") {
    requireAdmin(req, url, "notifications");
    return sendJson(res, 200, {
      ok: true,
      notifications: listNotifications(),
      subscribers: listSubscribers(),
      staffRecipients: listStaffRecipients()
    });
  }

  if (req.method === "POST" && pathname === "/api/admin/notifications") {
    const admin = requireAdmin(req, url, "notifications");
    const body = await parseBody(req);
    const notification = createNotification(body, admin.name || admin.role);
    const sendNow = body.sendNow === true || body.sendNow === "true";
    if (sendNow) {
      const result = await sendNotification(notification);
      return sendJson(res, 200, { ok: true, notification: result });
    }
    return sendJson(res, 200, { ok: true, notification });
  }

  if (req.method === "DELETE" && pathname === "/api/admin/notifications") {
    requireOwnerAdmin(req, url, "notifications");
    return sendJson(res, 200, clearNotifications());
  }

  const notificationDeleteMatch = pathname.match(/^\/api\/admin\/notifications\/([^/]+)$/);
  if (req.method === "DELETE" && notificationDeleteMatch) {
    requireAdmin(req, url, "notifications");
    return sendJson(res, 200, deleteNotification(decodeURIComponent(notificationDeleteMatch[1])));
  }

  if (req.method === "GET" && pathname === "/api/admin/subscribers") {
    requireAdmin(req, url, "notifications");
    return sendJson(res, 200, { ok: true, subscribers: listSubscribers() });
  }

  if (req.method === "GET" && pathname === "/api/admin/admins") {
    requireAdmin(req, url, "admins");
    return sendJson(res, 200, { ok: true, admins: listAdmins(), roles: ROLE_LABELS });
  }

  if (req.method === "POST" && pathname === "/api/admin/admins") {
    const actor = requireStoredOwnerAdmin(req, url, "admins");
    const savedAdmin = saveAdmin(await parseBody(req));
    void notifyStaffAccessChanged(savedAdmin, actor.name || ROLE_LABELS[actor.role]).catch((error) => {
      console.warn(`Staff access notification failed: ${error.message}`);
    });
    return sendJson(res, 200, { ok: true, admin: savedAdmin, admins: listAdmins() });
  }

  if (req.method === "GET" && pathname === "/api/admin/leadership") {
    requireAdmin(req, url, "about");
    return sendJson(res, 200, { ok: true, contacts: listLeadershipContacts({ includeInactive: true }) });
  }

  if (req.method === "POST" && pathname === "/api/admin/leadership") {
    requireAdmin(req, url, "about");
    const body = await parseBody(req);
    const oldContact = body.id
      ? listLeadershipContacts({ includeInactive: true }).find((contact) => contact.id === body.id)
      : null;
    if (body.photoImageData) {
      body.photoUrl = await saveLeadershipImage(body.photoImageData, body.photoImageName || body.name || "contact");
    } else if (body.photoUrl !== undefined) {
      body.photoUrl = normalizePublicUploadUrl(body.photoUrl, ["leadership"]);
    }
    const contact = saveLeadershipContact(body);
    if (body.photoImageData && oldContact?.photoUrl && oldContact.photoUrl !== contact.photoUrl) {
      await deletePublicUpload(oldContact.photoUrl);
    }
    clearPublicJsonCache();
    return sendJson(res, 200, { ok: true, contact, contacts: listLeadershipContacts({ includeInactive: true }) });
  }

  const leadershipDeleteMatch = pathname.match(/^\/api\/admin\/leadership\/([^/]+)$/);
  if (req.method === "DELETE" && leadershipDeleteMatch) {
    requireAdmin(req, url, "about");
    const result = deleteLeadershipContact(decodeURIComponent(leadershipDeleteMatch[1]));
    await deletePublicUpload(result.deleted?.photoUrl);
    clearPublicJsonCache();
    return sendJson(res, 200, result);
  }

  throw httpError("Admin API route not found", 404);
}

async function serveStatic(req, res, url) {
  let requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (requestPath === "/admin") requestPath = "/admin.html";

  const cleanPath = path.normalize(safeDecodePathname(requestPath)).replace(/^(\.\.[/\\])+/, "");
  if (cleanPath.replace(/\\/g, "/").startsWith("/uploads/appeals/")) return sendText(res, 403, "Forbidden");

  const filePath = path.join(PUBLIC_DIR, cleanPath);

  if (!isInsideDirectory(PUBLIC_DIR, filePath)) return sendText(res, 403, "Forbidden");

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) return sendText(res, 404, "Not found");

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const etag = staticEtag(stat);
    const isImmutable = isImmutableStaticRequest(url, requestPath, ext);
    const cacheControl =
      ext === ".html"
        ? "no-cache"
        : isImmutable
          ? `public, max-age=${IMMUTABLE_STATIC_MAX_AGE_SECONDS}, immutable`
        : `public, max-age=${STATIC_ASSET_MAX_AGE_SECONDS}, stale-while-revalidate=${STATIC_ASSET_MAX_AGE_SECONDS * 7}`;

    if (firstHeader(req.headers["if-none-match"]) === etag) {
      res.writeHead(304, {
        ...SECURITY_HEADERS,
        "cache-control": cacheControl,
        etag
      });
      res.end();
      return;
    }

    recordPublicPageVisit(req, requestPath);

    const wantsBrotli = acceptsBrotli(req);
    if (COMPRESSIBLE_STATIC_EXTS.has(ext) && stat.size >= TEXT_COMPRESS_MIN_BYTES && (wantsBrotli || acceptsGzip(req))) {
      // Brotli shaves another ~15-20% off CSS/JS vs gzip. Compression happens once
      // per file version (result cached), so the synchronous cost is a one-time hit;
      // quality 5 keeps that hit small while still beating gzip level 6.
      const encoding = wantsBrotli ? "br" : "gzip";
      const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}:${encoding}`;
      let compressed = compressedStaticCache.get(cacheKey);
      if (!compressed) {
        const raw = await fs.readFile(filePath);
        compressed = wantsBrotli
          ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
          : zlib.gzipSync(raw, { level: 6 });
        rememberCompressedStatic(cacheKey, compressed);
      }

      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": contentType,
        "cache-control": cacheControl,
        "content-encoding": encoding,
        vary: "Accept-Encoding",
        etag,
        "content-length": compressed.length
      });
      res.end(compressed);
      return;
    }

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": contentType,
      "cache-control": cacheControl,
      etag,
      "content-length": stat.size
    });
    const stream = fsSync.createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") return sendText(res, 404, "Not found");
    throw error;
  }
}

async function requestHandler(req, res) {
  res._request = req;
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/admin-local-login") return sendLocalAdminLoginPage(req, res, url);
    if (req.method === "GET" && url.pathname === "/admin-local-login.js") return sendLocalAdminLoginScript(req, res, url);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message = statusCode === 500 ? "Внутренняя ошибка сервера." : error.message;
    if (statusCode === 500) console.error(error);
    const payload = { ok: false, error: message };
    if (statusCode !== 500 && error.code) payload.code = error.code;
    if (statusCode !== 500 && error.details) payload.details = error.details;
    return sendJson(res, statusCode, payload);
  }
}

const TELEGRAM_MAX_RETRIES = 3;
const TELEGRAM_RETRY_BASE_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callTelegram(method, payload, attempt = 0) {
  if (!BOT_TOKEN) return null;

  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    // A network failure is ambiguous: the request may have reached Telegram.
    // Retrying sendMessage could deliver duplicates, so only auto-retry
    // idempotent read-style methods; mutating calls surface the error.
    const isIdempotent = /^(get|delete|set)[A-Z]/.test(method);
    if (isIdempotent && attempt < TELEGRAM_MAX_RETRIES) {
      await delay(TELEGRAM_RETRY_BASE_MS * (attempt + 1));
      return callTelegram(method, payload, attempt + 1);
    }
    throw error;
  }

  const data = await response.json();
  if (data.ok) return data.result;

  // Respect Telegram flood control (HTTP 429) using the server-provided retry_after.
  const retryAfter = Number(data.parameters?.retry_after || 0);
  if ((response.status === 429 || retryAfter) && attempt < TELEGRAM_MAX_RETRIES) {
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : TELEGRAM_RETRY_BASE_MS * (attempt + 1);
    await delay(waitMs);
    return callTelegram(method, payload, attempt + 1);
  }
  throw new Error(`Telegram ${method}: ${data.description || "request failed"}`);
}

function isTelegramCsvMime(mime) {
  const value = String(mime || "").toLowerCase().trim();
  return [
    "text/csv",
    "text/x-csv",
    "text/plain",
    "text/comma-separated-values",
    "application/csv",
    "application/x-csv",
    "application/vnd.ms-excel"
  ].includes(value) || value.includes("csv") || value.includes("comma-separated-values");
}

function telegramImportKind(document) {
  const name = String(document?.file_name || "").toLowerCase();
  const mime = String(document?.mime_type || "").toLowerCase();
  if (name.endsWith(".xml") || mime.includes("xml")) return "xml";
  if (name.endsWith(".xls") || name.endsWith(".xlsx")) return "";
  if (name.endsWith(".csv") || isTelegramCsvMime(mime)) return "csv";
  return "";
}

function telegramImportDocumentName(document, kind) {
  const rawName = path.basename(String(document?.file_name || "").replace(/[\\/:*?"<>|]/g, "_"));
  if (rawName) return rawName;
  return kind === "csv" ? "telegram-roster.csv" : "telegram-schedule.xml";
}

function telegramImportDocumentMime(kind, document) {
  const mime = String(document?.mime_type || "").trim();
  if (mime) return mime;
  return kind === "csv" ? "text/csv" : "application/xml";
}

function bufferToDataUrl(buffer, mimeType) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  return `data:${mimeType || "application/octet-stream"};base64,${bytes.toString("base64")}`;
}

function normalizeTelegramAttachmentMime(mimeType) {
  return String(mimeType || "").toLowerCase().trim().replace("image/jpg", "image/jpeg");
}

function inferTelegramAttachmentMime(fileName = "") {
  return TELEGRAM_APPEAL_ATTACHMENT_EXTENSIONS[path.extname(String(fileName || "")).toLowerCase()] || "";
}

function telegramAppealAttachmentCandidate(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length) {
    const photo = photos.reduce((best, item) => {
      const bestScore = Number(best?.file_size || 0) || Number(best?.width || 0) * Number(best?.height || 0);
      const itemScore = Number(item?.file_size || 0) || Number(item?.width || 0) * Number(item?.height || 0);
      return itemScore >= bestScore ? item : best;
    }, photos[0]);
    if (photo?.file_id) {
      return {
        fileId: photo.file_id,
        fileSize: photo.file_size,
        mimeType: "image/jpeg",
        fileName: "telegram-photo.jpg"
      };
    }
  }

  const voice = message?.voice;
  if (voice?.file_id) {
    return {
      fileId: voice.file_id,
      fileSize: voice.file_size,
      mimeType: normalizeTelegramAttachmentMime(voice.mime_type) || "audio/ogg",
      fileName: "telegram-voice.ogg"
    };
  }

  const audio = message?.audio;
  if (audio?.file_id) {
    const mimeType = normalizeTelegramAttachmentMime(audio.mime_type) || inferTelegramAttachmentMime(audio.file_name);
    if (TELEGRAM_APPEAL_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      return {
        fileId: audio.file_id,
        fileSize: audio.file_size,
        mimeType,
        fileName: audio.file_name || "telegram-audio"
      };
    }
  }

  const document = message?.document;
  if (document?.file_id) {
    const mimeType = normalizeTelegramAttachmentMime(document.mime_type) || inferTelegramAttachmentMime(document.file_name);
    if (TELEGRAM_APPEAL_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      return {
        fileId: document.file_id,
        fileSize: document.file_size,
        mimeType,
        fileName: document.file_name || "telegram-attachment"
      };
    }
  }

  return null;
}

function telegramAppealMessageText(message) {
  return String(message?.text || message?.caption || "").trim();
}

function hasTelegramAttachmentPayload(message) {
  return Boolean(
    message?.photo?.length ||
    message?.document ||
    message?.audio ||
    message?.voice ||
    message?.video ||
    message?.animation ||
    message?.video_note ||
    message?.sticker
  );
}

async function downloadTelegramFile(fileId, fileSize, maxBytes) {
  if (!BOT_TOKEN) throw httpError("Telegram-токен не настроен, файл от бота получить нельзя.", 500);
  if (!fileId) throw httpError("Telegram не передал идентификатор файла.", 400);
  const size = Number(fileSize || 0);
  if (size > maxBytes) throw httpError("Файл слишком большой для загрузки через Telegram.", 413);
  const file = await callTelegram("getFile", { file_id: fileId });
  if (!file?.file_path) throw new Error("Telegram не вернул путь к файлу.");
  const safeFilePath = String(file.file_path).split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${safeFilePath}`);
  if (!response.ok) throw new Error(`Telegram file download: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw httpError("Telegram вернул пустой файл.", 400);
  if (buffer.length > maxBytes) throw httpError("Файл слишком большой для загрузки через Telegram.", 413);
  return buffer;
}

async function saveTelegramAppealAttachment(candidate) {
  if (!candidate) return null;
  const mimeType = normalizeTelegramAttachmentMime(candidate.mimeType);
  if (!TELEGRAM_APPEAL_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    throw httpError("Поддерживаются картинки PNG, JPG, WEBP, GIF и аудио WEBM, OGG, MP3, M4A, WAV.", 400);
  }
  const buffer = await downloadTelegramFile(candidate.fileId, candidate.fileSize, MAX_ATTACHMENT_BYTES);
  return saveAppealAttachment(bufferToDataUrl(buffer, mimeType), candidate.fileName || "telegram-attachment");
}

async function saveTelegramAppealAttachmentOrReply(chatId, fromId, candidate) {
  if (!candidate) return [];
  try {
    const attachment = await saveTelegramAppealAttachment(candidate);
    return attachment ? [attachment] : [];
  } catch (error) {
    await sendTelegramMessage({
      chat_id: chatId,
      text: `Не удалось прикрепить файл: ${error.message}`,
      reply_markup: telegramKeyboardForUser(fromId)
    });
    return null;
  }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} байт`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

// Staged docs live in-process as base64 data URLs; 24 x 40MB XML would be >1GB of
// heap. Cap the TOTAL staged bytes as well as the count.
const TELEGRAM_IMPORT_TOTAL_BYTES_LIMIT = 160 * 1024 * 1024;

function cleanupTelegramImportDocuments() {
  const minCreatedAt = Date.now() - TELEGRAM_IMPORT_DOCUMENT_TTL_MS;
  for (let index = telegramImportDocuments.length - 1; index >= 0; index -= 1) {
    if (new Date(telegramImportDocuments[index].createdAt).getTime() < minCreatedAt) {
      telegramImportDocuments.splice(index, 1);
    }
  }
  while (telegramImportDocuments.length > TELEGRAM_IMPORT_DOCUMENT_LIMIT) telegramImportDocuments.shift();
  let totalBytes = telegramImportDocuments.reduce((sum, item) => sum + (item.dataUrl?.length || 0), 0);
  while (totalBytes > TELEGRAM_IMPORT_TOTAL_BYTES_LIMIT && telegramImportDocuments.length) {
    totalBytes -= telegramImportDocuments[0].dataUrl?.length || 0;
    telegramImportDocuments.shift();
  }
}

function listTelegramImportDocuments(admin, kind) {
  cleanupTelegramImportDocuments();
  const telegramId = admin?.telegramId ? String(admin.telegramId) : "";
  return telegramImportDocuments
    .filter((item) => (!kind || item.kind === kind) && (!telegramId || item.telegramId === telegramId))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function resolveTelegramAdminById(fromId) {
  const telegramId = String(fromId || "");
  if (!telegramId) return null;
  const admin = getAdminByTelegramId(telegramId);
  if (admin) return admin;
  if (isConfiguredOwnerTelegramId(telegramId)) {
    return {
      id: `telegram-admin:${telegramId}`,
      telegramId,
      name: `Telegram ${telegramId}`,
      role: "admin"
    };
  }
  return null;
}

async function downloadTelegramDocument(document, maxBytes) {
  return downloadTelegramFile(document?.file_id, document?.file_size, maxBytes);
}

async function rememberTelegramImportDocument(message, admin, kind) {
  const document = message.document;
  const maxBytes = kind === "csv" ? MAX_DUTY_ROSTER_BYTES : MAX_XML_IMPORT_BYTES;
  const buffer = await downloadTelegramDocument(document, maxBytes);
  const mimeType = telegramImportDocumentMime(kind, document);
  const item = {
    id: createId(),
    kind,
    telegramId: String(message.from?.id || ""),
    chatId: String(message.chat?.id || ""),
    messageId: message.message_id,
    fileId: document.file_id,
    fileName: telegramImportDocumentName(document, kind),
    mimeType,
    size: buffer.length,
    dataUrl: bufferToDataUrl(buffer, mimeType),
    uploadedBy: admin?.name || ROLE_LABELS[admin?.role] || "Telegram",
    createdAt: new Date().toISOString()
  };
  telegramImportDocuments.push(item);
  cleanupTelegramImportDocuments();
  return item;
}

function telegramChatKey(chatId) {
  return String(chatId || "");
}

function rememberTelegramMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  const key = telegramChatKey(chatId);
  const messages = telegramRecentMessages.get(key) || [];
  messages.push(messageId);
  telegramRecentMessages.set(key, messages.slice(-TELEGRAM_RECENT_LIMIT));
}

async function deleteTelegramMessageSafe(chatId, messageId) {
  if (!chatId || !messageId || !BOT_TOKEN) return;
  try {
    await callTelegram("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    // Telegram can reject deletion of old/user messages. Cleanup is best-effort.
  }
}

async function clearRecentTelegramMessages(chatId, incomingMessageId = "") {
  const key = telegramChatKey(chatId);
  const messages = telegramRecentMessages.get(key) || [];
  telegramRecentMessages.delete(key);
  await Promise.allSettled(messages.map((messageId) => deleteTelegramMessageSafe(chatId, messageId)));
  await deleteTelegramMessageSafe(chatId, incomingMessageId);
}

async function sendTelegramMessage(payload) {
  const result = await callTelegram("sendMessage", payload);
  rememberTelegramMessage(result?.chat?.id || payload?.chat_id, result?.message_id);
  return result;
}

function telegramMainKeyboard(admin = null) {
  const appealsButton = hasPermission(admin?.role, "appeals") ? "Рабочие обращения" : TELEGRAM_PANEL.myAppeals;
  const keyboard = [
    [
      { text: TELEGRAM_PANEL.map },
      { text: TELEGRAM_PANEL.schedule }
    ],
    [
      { text: TELEGRAM_PANEL.appeal },
      { text: appealsButton }
    ],
    [
      { text: TELEGRAM_PANEL.clear },
      { text: TELEGRAM_PANEL.help }
    ]
  ];

  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Очистить чат или о боте"
  };
}

function canOpenAdminPanel(admin) {
  return Boolean(admin && Number(admin.active) !== 0 && (PERMISSIONS[admin.role] || []).length);
}

function isConfiguredOwnerTelegramId(telegramId) {
  const id = String(telegramId || "");
  return Boolean(id && (ADMIN_IDS.includes(id) || String(ADMIN_CHAT_ID || "") === id));
}

function canOpenSettings(admin) {
  return canOpenAdminPanel(admin);
}

function telegramKeyboardForUser(fromId) {
  return telegramMainKeyboard(getAdminByTelegramId(fromId));
}

async function configureDefaultMenu() {
  return callTelegram("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Открыть приложение",
      web_app: { url: getPublicUrl("/") }
    }
  });
}

async function configureBotCommands() {
  return callTelegram("setMyCommands", {
    commands: [
      { command: "start", description: "О боте и запуск приложения" },
      { command: "map", description: "Карта маршрутов и остановок" },
      { command: "appeal", description: "Написать обращение" },
      { command: "appeals", description: "Мои обращения" },
      { command: "work", description: "Рабочие обращения" },
      { command: "clear", description: "Очистить текущее действие" },
      { command: "help", description: "Что умеет бот" }
    ]
  });
}

async function sendAdminPanel(chatId, admin, options = {}) {
  const roleLabel = ROLE_LABELS[admin?.role] || admin?.role || "Работник";
  const prefix = options.prefix || "Служебная панель готова.";

  return sendTelegramMessage({
    chat_id: chatId,
    text: [
      prefix,
      "",
      `Роль: ${roleLabel}`,
      admin?.name ? `Профиль: ${admin.name}` : "",
      "",
      "Кнопка меню Telegram открывает приложение. Если админ-панель не открылась автоматически, перейдите в /admin и введите ключ доступа."
    ]
      .filter(Boolean)
      .join("\n"),
    reply_markup: telegramMainKeyboard(admin)
  });
}

async function configureStaffMenu(admin) {
  if (!admin?.telegramId) return;
  await callTelegram("setChatMenuButton", {
    chat_id: admin.telegramId,
    menu_button: {
      type: "web_app",
      text: "Открыть приложение",
      web_app: { url: getPublicUrl("/") }
    }
  });
}

async function syncStaffMenus() {
  const admins = listAdmins().filter((admin) => admin.telegramId);
  if (!admins.length) return;
  const results = await Promise.allSettled(admins.map((admin) => configureStaffMenu(admin)));
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) console.error(`Telegram staff menu sync failed for ${failed} users.`);
}

async function sendAdminAccessPrompt(chatId, fromId) {
  if (fromId) pendingAdminAccess.set(fromId, { expiresAt: Date.now() + ADMIN_ACCESS_TTL_MS, attempts: 0 });

  return sendTelegramMessage({
    chat_id: chatId,
    text: [
      "Введите ключ администратора одним сообщением.",
      "После проверки бот покажет вашу панель и роль."
    ].join("\n"),
    reply_markup: telegramMainKeyboard(null)
  });
}

async function handlePendingAdminAccess(message, text, fromId) {
  const pending = pendingAdminAccess.get(fromId);
  if (!pending || !text || text.startsWith("/")) return false;

  const chatId = message.chat.id;
  const expiresAt = typeof pending === "number" ? pending : pending.expiresAt;
  const attempts = typeof pending === "number" ? 0 : Number(pending.attempts || 0);
  if (Date.now() > expiresAt) {
    pendingAdminAccess.delete(fromId);
    await sendTelegramMessage({
      chat_id: chatId,
      text: "Срок ввода ключа истек. Нажмите /admin и попробуйте еще раз.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
    return true;
  }

  if (!ADMIN_KEY || isWeakAdminKey(ADMIN_KEY)) {
    pendingAdminAccess.delete(fromId);
    await sendTelegramMessage({
      chat_id: chatId,
      text: "Admin access key is not configured securely. Set a strong ADMIN_KEY and try again.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
    return true;
  }

  if (!safeEquals(text, ADMIN_KEY)) {
    const nextAttempts = attempts + 1;
    if (nextAttempts >= ADMIN_ACCESS_MAX_ATTEMPTS) {
      pendingAdminAccess.delete(fromId);
      await sendTelegramMessage({
        chat_id: chatId,
        text: "Too many invalid admin key attempts. Request admin access again later.",
        reply_markup: telegramKeyboardForUser(fromId)
      });
      return true;
    }
    pendingAdminAccess.set(fromId, { expiresAt, attempts: nextAttempts });
    await sendTelegramMessage({
      chat_id: chatId,
      text: "Ключ не подошел. Проверьте его и отправьте еще раз.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
    return true;
  }

  pendingAdminAccess.delete(fromId);
  const existingAdmin = getAdminByTelegramId(fromId);
  const ownerTelegramId = isConfiguredOwnerTelegramId(fromId);
  const existingFullAdmin = existingAdmin?.role === "admin" && Number(existingAdmin.active) !== 0;
  if (!ownerTelegramId && !existingFullAdmin) {
    await sendTelegramMessage({
      chat_id: chatId,
      text: [
        "Admin key accepted, but this Telegram ID is not allowed to self-enroll.",
        "Ask an existing owner to add your Telegram ID in the admin panel or ADMIN_IDS."
      ].join("\n"),
      reply_markup: telegramKeyboardForUser(fromId)
    });
    return true;
  }
  const admin = saveAdmin({
    id: existingAdmin?.id,
    telegramId: fromId,
    name: existingAdmin?.name || formatTelegramName(message.from),
    role: "admin",
    active: true
  });

  await configureStaffMenu(admin).catch(() => {});
  if (!canOpenAdminPanel(admin)) {
    await sendTelegramMessage({
      chat_id: chatId,
      text: [
        "Доступ подтвержден.",
        "",
        "Вы добавлены как работник автобусного парка.",
        "Вам будут приходить служебные уведомления."
      ].join("\n"),
      reply_markup: telegramMainKeyboard(null)
    });
    return true;
  }
  await sendAdminPanel(chatId, admin, { prefix: "Доступ подтвержден." });
  return true;
}

async function sendAdminPanelForUser(chatId, fromId) {
  if (!fromId) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Не удалось определить Telegram ID. Откройте бота из личного чата и повторите /admin.",
      reply_markup: telegramMainKeyboard(null)
    });
  }

  const admin = resolveTelegramAdminById(fromId);
  if (admin) {
    await configureStaffMenu(admin).catch(() => {});
    if (!canOpenAdminPanel(admin)) {
      return sendAdminAccessPrompt(chatId, fromId);
    }
    return sendAdminPanel(chatId, admin, { prefix: "Ваш доступ найден." });
  }
  return sendAdminAccessPrompt(chatId, fromId);
}

async function notifyStaffAccessChanged(admin, actor) {
  if (!admin?.telegramId) return;

  await configureStaffMenu(admin);

  if (Number(admin.active) === 0) {
    return sendTelegramMessage({
      chat_id: admin.telegramId,
      text: actor ? `${actor} отключил ваш служебный доступ.` : "Ваш служебный доступ отключён.",
      reply_markup: telegramMainKeyboard(null)
    });
  }

  if (!canOpenAdminPanel(admin)) {
    return sendTelegramMessage({
      chat_id: admin.telegramId,
      text: actor ? `${actor} добавил вас в список работников для служебных уведомлений.` : "Вы добавлены в список работников для служебных уведомлений.",
      reply_markup: telegramMainKeyboard(null)
    });
  }

  await sendAdminPanel(admin.telegramId, admin, {
    prefix: actor ? `${actor} обновил ваш доступ.` : "Ваш доступ обновлен."
  });
}

async function sendWelcome(chatId, fromId = "") {
  const admin = resolveTelegramAdminById(fromId);

  return sendTelegramMessage({
    chat_id: chatId,
    text: [
      `🚌 Бот автобусного парка г. ${CITY_NAME}`,
      "",
      "Для пассажиров: быстро найти расписание и связаться с автобусным парком.",
      "",
      "Что умеет:",
      "🕘 Расписание автобусов",
      "🗺 Карта маршрутов, остановок и изменений движения",
      "📍 Маршруты, направления и остановки",
      "⭐ Избранные остановки и рейсы",
      "🔔 Подписки на изменения маршрутов",
      "💬 Обращения и ответы по ним",
      "📞 Контакты и полезная информация",
      "",
      "Откройте приложение через кнопку меню Telegram."
    ].join("\n"),
    reply_markup: telegramMainKeyboard(admin)
  });
}

// Экран карты в Mini App: сообщение с web_app-кнопкой, открывающей нужный
// раздел через hash (#map, #map_route_<id>, #map_stop_<key>).
async function sendMapScreen(chatId, fromId = "", target = "map") {
  if (!mapModule.isMapEnabled()) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Карта временно недоступна. Расписание по-прежнему работает в приложении.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }
  const safeTarget = /^map(_[a-z]+_[\w:%-]+)?$/i.test(target) ? target : "map";
  return sendTelegramMessage({
    chat_id: chatId,
    text: [
      "🗺 Карта маршрутов и остановок",
      "",
      "На карте: линии маршрутов, остановки, изменения движения и транспорт (если подключён GPS).",
      "Откройте карту кнопкой ниже — вход не нужен, Telegram узнаёт вас автоматически."
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[
        { text: "Открыть карту", web_app: { url: getPublicUrl(`/#${safeTarget}`) } }
      ]]
    }
  });
}

async function sendRoutes(chatId, fromId = "") {
  const routes = listRoutes();
  const cityCount = routes.filter((route) => !String(route.id || "").includes(":")).length;
  const suburbanCount = routes.filter((route) => String(route.id || "").startsWith("suburban:")).length;
  const intercityCount = routes.filter((route) => String(route.id || "").startsWith("intercity:")).length;
  const routeLines = [
    "🚌 Расписание доступно в приложении.",
    "",
    `Городские маршруты: ${cityCount}`,
    `Пригородные маршруты: ${suburbanCount}`,
    `Междугородние маршруты: ${intercityCount}`,
    "",
    "Откройте приложение и выберите нужный тип расписания."
  ].join("\n");
  return sendTelegramMessage({
    chat_id: chatId,
    text: routeLines || "Маршруты пока не импортированы.",
    reply_markup: telegramKeyboardForUser(fromId)
  });
}

async function sendChatPanelReset(chatId, fromId = "", incomingMessageId = "") {
  if (fromId) pendingAdminAccess.delete(fromId);
  await clearRecentTelegramMessages(chatId, incomingMessageId);
  return sendTelegramMessage({
    chat_id: chatId,
    text: "Готово. Текущее действие в чате очищено, нижняя панель обновлена.",
    reply_markup: telegramKeyboardForUser(fromId)
  });
}

async function sendBotHelp(chatId, fromId = "") {
  return sendTelegramMessage({
    chat_id: chatId,
    text: [
      "ℹ️ Бот для пассажиров",
      "",
      "Помогает быстро пользоваться сервисами автобусного парка:",
      "",
      "🕘 Смотреть расписание",
      "🗺 Открыть карту маршрутов (/map)",
      "📍 Найти маршрут и остановку",
      "⭐ Сохранить избранное",
      "🔔 Подписаться на изменения маршрута",
      "💬 Написать обращение",
      "📨 Посмотреть свои обращения",
      "📞 Узнать контакты"
    ].join("\n"),
    reply_markup: telegramKeyboardForUser(fromId)
  });
}

function appealCategoryByKey(key) {
  return APPEAL_BOT_CATEGORIES.find((item) => item.key === key) || APPEAL_BOT_CATEGORIES.at(-1);
}

function appealRoleLabel(role) {
  return ROLE_LABELS[role] || role || "Ответственный";
}

function compactAppealPreview(text, limit = 72) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "Вложение без текста";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function appealButtonLabel(appeal) {
  const preview = compactAppealPreview(appeal.text, 44);
  return preview.length <= 64 ? preview : `${preview.slice(0, 63).trimEnd()}…`;
}

function findSingleOpenTelegramAppeal(fromId) {
  const openAppeals = listAppealsForTelegram(fromId).filter((appeal) => appeal.status !== "closed");
  return openAppeals.length === 1 ? openAppeals[0] : null;
}

function staffAppealButtonLabel(appeal) {
  const preview = compactAppealPreview(appeal.text, 46);
  return preview.length <= 64 ? preview : `${preview.slice(0, 63).trimEnd()}…`;
}

function appealClientLabel(appeal) {
  const name = [appeal.firstName, appeal.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (appeal.telegramUsername) return `@${String(appeal.telegramUsername).replace(/^@/, "")}`;
  return appeal.telegramId ? `Telegram ${appeal.telegramId}` : "Клиент";
}

function resolveAppealWorker(fromId) {
  const admin = resolveTelegramAdminById(fromId);
  return admin && hasPermission(admin.role, "appeals") ? admin : null;
}

async function sendStaffAppealsQueue(chatId, fromId = "") {
  const admin = resolveAppealWorker(fromId);
  if (!admin) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Рабочие обращения доступны только сотрудникам с нужной ролью."
    });
  }

  const appeals = listAppeals(admin.role).filter((appeal) => appeal.status !== "closed").slice(0, 10);
  if (!appeals.length) {
    activeAdminAppeals.delete(fromId);
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Открытых обращений для вашей роли сейчас нет."
    });
  }

  const inline_keyboard = appeals.map((appeal) => ([{
    text: staffAppealButtonLabel(appeal),
    callback_data: `staff:appeal:open:${appeal.id}`
  }]));
  return sendTelegramMessage({
    chat_id: chatId,
    text: "Выберите обращение:",
    reply_markup: { inline_keyboard }
  });
}

async function openStaffAppealChat(chatId, fromId, appealId, options = {}) {
  const admin = resolveAppealWorker(fromId);
  if (!admin) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Нет доступа к рабочим обращениям."
    });
  }

  let appeal;
  try {
    appeal = ensureAdminCanOpenAppeal(admin, appealId);
  } catch {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Не удалось открыть это обращение."
    });
  }

  const targetChatId = String(chatId) === String(fromId) ? chatId : fromId;
  if (appeal.status === "closed") {
    activeAdminAppeals.delete(fromId);
    return sendTelegramMessage({
      chat_id: targetChatId,
      text: "Это обращение уже закрыто."
    });
  }

  if (appeal.status === "new") {
    appeal = updateAppealStatus(appeal.id, "in_progress", admin.name || `telegram:${admin.telegramId || ""}`);
  }
  activeAdminAppeals.set(fromId, appeal.id);

  if (options.fromGroup) {
    await sendTelegramMessage({
      chat_id: chatId,
      text: "Открыл обращение в личном чате сотрудника."
    }).catch(() => {});
  }

  const openMessage = {
    chat_id: targetChatId,
    text: [
      "Рабочий чат открыт.",
      `Тема: ${appeal.category || "Обращение"}`,
      `Клиент: ${appealClientLabel(appeal)}`,
      "",
      appeal.text || "Вложение без текста.",
      "",
      "Пишите ответ следующим сообщением.",
      "/done — закрыть чат, /clear — выйти."
    ].join("\n")
  };

  try {
    return await sendTelegramMessage(openMessage);
  } catch (error) {
    activeAdminAppeals.delete(fromId);
    if (String(targetChatId) !== String(chatId)) {
      return sendTelegramMessage({
        chat_id: chatId,
        text: "Не смог открыть личный чат сотрудника. Напишите боту в личные сообщения и нажмите «Ответить» ещё раз."
      });
    }
    throw error;
  }
}

async function closeStaffAppealChat(chatId, fromId, appealId = "") {
  const admin = resolveAppealWorker(fromId);
  if (!admin) return false;
  const activeId = appealId || activeAdminAppeals.get(fromId);
  if (!activeId) return false;

  let appeal;
  try {
    ensureAdminCanOpenAppeal(admin, activeId);
    appeal = updateAppealStatus(activeId, "closed", admin.name || `telegram:${admin.telegramId || ""}`);
  } catch {
    activeAdminAppeals.delete(fromId);
    await sendTelegramMessage({ chat_id: chatId, text: "Не удалось закрыть это обращение." });
    return true;
  }

  addAppealMessage(appeal.id, {
    senderType: "system",
    text: "Чат закрыт администрацией.",
    actorName: admin.name || ROLE_LABELS[admin.role] || "Администратор"
  });
  activeAdminAppeals.delete(fromId);
  if (appeal.telegramId) {
    activeTelegramAppeals.delete(String(appeal.telegramId));
    await sendTelegramMessage({
      chat_id: appeal.telegramId,
      text: "Чат закрыт. Спасибо за сообщение."
    }).catch(() => {});
  }
  await sendTelegramMessage({ chat_id: chatId, text: "Чат закрыт." });
  return true;
}

async function handleActiveAdminAppealMessage(message, text, fromId, attachmentCandidate = null) {
  const hasAttachment = Boolean(attachmentCandidate);
  if (!fromId || (!text && !hasAttachment) || text.startsWith("/")) return false;
  if (String(message.chat?.id || "") !== String(fromId)) return false;

  const admin = resolveAppealWorker(fromId);
  if (!admin) return false;
  const appealId = activeAdminAppeals.get(fromId);
  if (!appealId) return false;

  let appeal;
  try {
    appeal = ensureAdminCanOpenAppeal(admin, appealId);
  } catch {
    activeAdminAppeals.delete(fromId);
    return false;
  }
  if (appeal.status === "closed") {
    activeAdminAppeals.delete(fromId);
    await sendTelegramMessage({ chat_id: message.chat.id, text: "Этот чат уже закрыт." });
    return true;
  }
  if (!appeal.telegramId) {
    await sendTelegramMessage({ chat_id: message.chat.id, text: "У клиента нет Telegram ID. Ответьте по указанному контакту." });
    return true;
  }

  const attachments = await saveTelegramAppealAttachmentOrReply(message.chat.id, fromId, attachmentCandidate);
  if (attachments === null) return true;
  if (text) assertCleanText(text);
  const saved = addAppealMessage(appeal.id, {
    senderType: "admin",
    text,
    actorName: admin.name || ROLE_LABELS[admin.role] || "Администратор",
    attachments
  });
  if (appeal.status === "new") {
    updateAppealStatus(appeal.id, "in_progress", admin.name || `telegram:${admin.telegramId || ""}`);
  }
  activeTelegramAppeals.set(String(appeal.telegramId), appeal.id);
  await sendTelegramMessage({
    chat_id: appeal.telegramId,
    text: saved.text || "Администратор отправил вложение. Откройте чат обращения в приложении."
  });
  return true;
}

async function sendAppealCategoryPicker(chatId, fromId = "") {
  if (fromId) pendingTelegramAppeals.delete(fromId);
  if (fromId) activeTelegramAppeals.delete(fromId);
  return sendTelegramMessage({
    chat_id: chatId,
    text: "Выберите тему:",
    reply_markup: {
      inline_keyboard: [
        ...APPEAL_BOT_CATEGORIES.map((item) => [{ text: item.title, callback_data: `appeal:cat:${item.key}` }]),
        [{ text: "Отмена", callback_data: "appeal:cancel" }]
      ]
    }
  });
}

async function sendUserAppeals(chatId, fromId = "") {
  if (!fromId) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Не удалось определить Telegram ID. Откройте бота из личного чата.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }

  const appeals = listAppealsForTelegram(fromId).slice(0, 8);
  if (!appeals.length) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "У вас пока нет обращений. Нажмите «Написать обращение», чтобы создать первое.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }

  if (appeals.length === 1) {
    return sendAppealThread(chatId, fromId, appeals[0].id);
  }

  const inline_keyboard = appeals.slice(0, 8).map((appeal) => ([{
    text: appealButtonLabel(appeal),
    callback_data: `appeal:open:${appeal.id}`
  }]));
  return sendTelegramMessage({
    chat_id: chatId,
    text: "Выберите чат:",
    reply_markup: { inline_keyboard }
  });
}

async function sendAppealThread(chatId, fromId, appealId) {
  const appeal = getAppeal(appealId);
  if (!appeal || String(appeal.telegramId || "") !== String(fromId || "")) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Не удалось открыть это обращение."
    });
  }

  if (appeal.status === "closed") {
    activeTelegramAppeals.delete(fromId);
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Это обращение закрыто."
    });
  }

  activeTelegramAppeals.set(fromId, appeal.id);
  return sendTelegramMessage({
    chat_id: chatId,
    text: "Готово, пишите сюда."
  });
}

async function startTelegramAppealTextStep(chatId, fromId, categoryKey) {
  const category = appealCategoryByKey(categoryKey);
  pendingTelegramAppeals.set(fromId, {
    step: "text",
    categoryKey: category.key,
    categoryTitle: category.title,
    assignedRole: category.role,
    expiresAt: Date.now() + 15 * 60 * 1000
  });

  return sendTelegramMessage({
    chat_id: chatId,
    text: "Напишите сообщение."
  });
}

async function handlePendingTelegramAppeal(message, text, fromId, attachmentCandidate = null) {
  if (!fromId) return false;
  const draft = pendingTelegramAppeals.get(fromId);
  if (!draft) return false;

  const chatId = message.chat.id;
  if (Date.now() > draft.expiresAt) {
    pendingTelegramAppeals.delete(fromId);
    await sendTelegramMessage({
      chat_id: chatId,
      text: "Черновик обращения устарел. Нажмите «Написать обращение» и начните заново.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
    return true;
  }

  const hasAttachment = Boolean(attachmentCandidate);
  if ((!text && !hasAttachment) || text.startsWith("/")) return false;
  if (!enforceTelegramRateLimit(fromId, "appeal-create", RATE_LIMITS.telegramAppealCreate)) {
    await sendTelegramMessage({
      chat_id: chatId,
      text: "Слишком много обращений за короткое время. Попробуйте немного позже.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
    return true;
  }

  const attachments = await saveTelegramAppealAttachmentOrReply(chatId, fromId, attachmentCandidate);
  if (attachments === null) return true;
  let appeal;
  try {
    appeal = createAppeal(
      {
        category: draft.categoryTitle,
        assignedRole: draft.assignedRole,
        source: "telegram-bot",
        text,
        attachments
      },
      {
        telegramId: fromId,
        firstName: message.from?.first_name || "",
        lastName: message.from?.last_name || "",
        username: message.from?.username || ""
      }
    );
  } catch (error) {
    // Validation errors (too-short text, profanity filter) must reach the user —
    // a silent drop makes them think the appeal was sent.
    if (error.statusCode && error.statusCode < 500) {
      await sendTelegramMessage({ chat_id: chatId, text: error.message });
      return true;
    }
    throw error;
  }
  pendingTelegramAppeals.delete(fromId);
  activeTelegramAppeals.set(fromId, appeal.id);
  await notifyAdmins({ ...appeal, text: appeal.text || (attachments.length ? "Вложение без текста" : "") });
  await sendTelegramMessage({
    chat_id: chatId,
    text: "Принято. Ответ придёт сюда."
  });
  return true;
}

async function handleActiveTelegramAppealMessage(message, text, fromId, attachmentCandidate = null) {
  const hasAttachment = Boolean(attachmentCandidate);
  if (!fromId || (!text && !hasAttachment) || text.startsWith("/")) return false;

  let activeId = activeTelegramAppeals.get(fromId);
  if (!activeId) {
    const onlyOpenAppeal = findSingleOpenTelegramAppeal(fromId);
    if (!onlyOpenAppeal) return false;
    activeId = onlyOpenAppeal.id;
    activeTelegramAppeals.set(fromId, activeId);
  }

  const appeal = getAppeal(activeId);
  if (!appeal || String(appeal.telegramId || "") !== String(fromId) || appeal.status === "closed") {
    activeTelegramAppeals.delete(fromId);
    return false;
  }

  if (!enforceTelegramRateLimit(fromId, "appeal-message", RATE_LIMITS.appealMessage)) {
    await sendTelegramMessage({
      chat_id: message.chat.id,
      text: "Слишком много сообщений за короткое время. Попробуйте немного позже."
    });
    return true;
  }

  const attachments = await saveTelegramAppealAttachmentOrReply(message.chat.id, fromId, attachmentCandidate);
  if (attachments === null) return true;
  let item;
  try {
    item = addAppealMessage(appeal.id, {
      senderType: "client",
      text,
      actorName: formatTelegramName(message.from) || appeal.firstName || appeal.telegramUsername || "Клиент",
      telegramId: fromId,
      attachments
    });
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) {
      await sendTelegramMessage({ chat_id: message.chat.id, text: error.message });
      return true;
    }
    throw error;
  }
  await notifyAdmins({ ...appeal, text: `Новое сообщение в чате:\n${item.text || "Вложение без текста"}` });
  return true;
}

async function notifyAdmins(appeal) {
  const assignedRole = appeal.assignedRole || resolveAppealAssignedRole(appeal.category);
  const roleTargets = listStaffRecipients(assignedRole)
    .map((item) => item.telegramId)
    .filter(Boolean);
  const fallbackTargets = [...ADMIN_IDS, ADMIN_CHAT_ID].filter(Boolean);
  const targets = [...new Set((roleTargets.length ? roleTargets : fallbackTargets).filter(Boolean))];
  if (!BOT_TOKEN || targets.length === 0) return;

  const text = [
    `Новое обращение #${appeal.id}`,
    `Категория: ${appeal.category}`,
    `Ответственный отдел: ${appealRoleLabel(assignedRole)}`,
    "",
    appeal.text || "Вложение без текста."
  ]
    .filter(Boolean)
    .join("\n");

  // Single reply_markup (a past bug set the key twice and dropped the keyboard).
  // web_app buttons are rejected by Telegram outside private chats (groups have
  // negative chat ids) and require HTTPS — build the keyboard per recipient.
  const adminUrl = getPublicUrl("/admin");
  const keyboardFor = (chatId) => {
    const rows = [[{ text: "Ответить", callback_data: `staff:appeal:open:${appeal.id}` }]];
    const isPrivateChat = !String(chatId).startsWith("-");
    if (isPrivateChat && /^https:\/\//i.test(adminUrl)) {
      rows.push([{ text: "Открыть админку", web_app: { url: adminUrl } }]);
    }
    rows.push([{ text: "Закрыть", callback_data: `staff:appeal:close:${appeal.id}` }]);
    return { inline_keyboard: rows };
  };

  await Promise.allSettled(
    targets.map((chatId) =>
      callTelegram("sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: keyboardFor(chatId)
      })
    )
  );
}

async function handleTelegramImportDocument(message, fromId) {
  const chatId = message.chat.id;
  const kind = telegramImportKind(message.document);
  if (!kind) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Этот файл не похож на XML расписания или CSV разнарядки. Отправьте файл как документ .xml или .csv."
    });
  }

  const admin = resolveTelegramAdminById(fromId);
  const permission = kind === "xml" ? "schedule" : "roster";
  if (!admin || !hasPermission(admin.role, permission)) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Нет доступа к загрузке этого файла. Отправлять XML/CSV может только администратор или диспетчер."
    });
  }

  try {
    const item = await rememberTelegramImportDocument(message, admin, kind);
    const title = kind === "xml" ? "XML расписания" : "CSV разнарядки";
    const action = kind === "xml"
      ? "Во вкладке «Расписание» нажмите «Взять XML из Telegram»."
      : "Во вкладке «Разнарядка» нажмите «Взять CSV из Telegram».";
    return sendTelegramMessage({
      chat_id: chatId,
      text: `${title} получен: ${item.fileName} (${formatBytes(item.size)}). ${action}`,
      reply_markup: {
        inline_keyboard: [[{ text: "Открыть админку", web_app: { url: getPublicUrl("/admin") } }]]
      }
    });
  } catch (error) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: `Не удалось получить файл из Telegram: ${error.message}`
    });
  }
}

async function handleTelegramMessage(message) {
  if (!message?.chat?.id) return;

  const chatId = message.chat.id;
  const text = telegramAppealMessageText(message);
  const fromId = message.from?.id ? String(message.from.id) : "";
  const attachmentCandidate = telegramAppealAttachmentCandidate(message);
  const hasAttachmentPayload = hasTelegramAttachmentPayload(message);
  const importDocumentKind = message.document && !attachmentCandidate ? telegramImportKind(message.document) : "";

  if (message.from?.id) {
    upsertSubscriber({
      telegramId: fromId,
      firstName: message.from.first_name || "",
      lastName: message.from.last_name || "",
      username: message.from.username || ""
    });
  }

  if (!enforceTelegramRateLimit(fromId || chatId, "message", RATE_LIMITS.telegramMessage)) return;

  const startPayload = text.match(/^\/start(?:@\w+)?\s+(.+)$/i)?.[1]?.trim() || "";
  if (startPayload === "appeal") return sendAppealCategoryPicker(chatId, fromId);
  if (startPayload === "map" || startPayload.startsWith("map_")) return sendMapScreen(chatId, fromId, startPayload);
  if (isTelegramCommand(text, "start") || text === TELEGRAM_PANEL.app) return sendWelcome(chatId, fromId);
  if (text === TELEGRAM_PANEL.clear || text === "🧹 Очистить" || isTelegramCommand(text, "clear")) {
    if (fromId) pendingTelegramAppeals.delete(fromId);
    if (fromId) activeTelegramAppeals.delete(fromId);
    if (fromId) activeAdminAppeals.delete(fromId);
    return sendChatPanelReset(chatId, fromId, message.message_id);
  }
  if (text === TELEGRAM_PANEL.help || text === "ℹ️ Помощь" || isTelegramCommand(text, "help")) return sendBotHelp(chatId, fromId);
  if (text === TELEGRAM_PANEL.appeal || isTelegramCommand(text, "appeal")) return sendAppealCategoryPicker(chatId, fromId);
  if (text === "Рабочие обращения" || isTelegramCommand(text, "work")) return sendStaffAppealsQueue(chatId, fromId);
  if (isTelegramCommand(text, "done")) {
    if (await closeStaffAppealChat(chatId, fromId)) return;
  }
  if (text === TELEGRAM_PANEL.myAppeals || isTelegramCommand(text, "appeals")) {
    return resolveAppealWorker(fromId) ? sendStaffAppealsQueue(chatId, fromId) : sendUserAppeals(chatId, fromId);
  }
  if (isTelegramCommand(text, "admin")) return sendAdminPanelForUser(chatId, fromId);
  if (isAdminAccessRequest(text)) return sendAdminPanelForUser(chatId, fromId);
  if (text === TELEGRAM_PANEL.schedule || isTelegramCommand(text, "routes")) return sendRoutes(chatId, fromId);
  if (text === TELEGRAM_PANEL.map || text === "🗺 Карта" || isTelegramCommand(text, "map")) return sendMapScreen(chatId, fromId);
  if (fromId && (await handlePendingAdminAccess(message, text, fromId))) return;
  if (fromId && (await handleActiveAdminAppealMessage(message, text, fromId, attachmentCandidate))) return;
  if (fromId && (await handlePendingTelegramAppeal(message, text, fromId, attachmentCandidate))) return;
  if (fromId && (await handleActiveTelegramAppealMessage(message, text, fromId, attachmentCandidate))) return;
  if (importDocumentKind) return handleTelegramImportDocument(message, fromId);
  if (hasAttachmentPayload && !attachmentCandidate) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Поддерживаются картинки и аудио до 5 МБ. Чтобы прикрепить файл, откройте или создайте обращение.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }
  if (!text && hasAttachmentPayload) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Сначала откройте или создайте обращение: нажмите «Написать обращение» или «Мои обращения». К обращению можно прикреплять фото и аудио.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }
  if (!text) return sendWelcome(chatId, fromId);
  if (isTelegramCommand(text, "schedule")) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Расписание открывается в мини-приложении.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }

  const replyMatch = text.match(/^\/reply\s+([a-z0-9-]+)\s+([\s\S]+)/i);
  if (replyMatch) {
    const admin = getAdminByTelegramId(fromId);
    if (!admin) {
      return sendTelegramMessage({ chat_id: chatId, text: "Нет доступа." });
    }
    return replyToAppeal(chatId, replyMatch[1], replyMatch[2], admin);
  }

  if (/^(жалоба|обращение|предложение|вопрос|проблема)\b/i.test(text)) {
    const shortcutMatch = text.match(/^(жалоба|обращение|предложение|вопрос|проблема)[:\s-]*(.*)$/i);
    const shortcutCategory = shortcutMatch?.[1] || "Обращение";
    const shortcutText = (shortcutMatch?.[2] || "").trim();
    if (shortcutText.length < 8) {
      return sendAppealCategoryPicker(chatId, fromId);
    }
    if (!enforceTelegramRateLimit(fromId || chatId, "appeal-create", RATE_LIMITS.telegramAppealCreate)) {
      return sendTelegramMessage({
        chat_id: chatId,
        text: "Слишком много обращений за короткое время. Попробуйте немного позже.",
        reply_markup: telegramKeyboardForUser(fromId)
      });
    }
    const attachments = await saveTelegramAppealAttachmentOrReply(chatId, fromId, attachmentCandidate);
    if (attachments === null) return;
    const appeal = createAppeal(
      {
        category: shortcutCategory,
        assignedRole: resolveAppealAssignedRole(shortcutCategory),
        source: "telegram-bot",
        text: shortcutText,
        attachments
      },
      {
        telegramId: fromId,
        firstName: message.from?.first_name || "",
        lastName: message.from?.last_name || "",
        username: message.from?.username || ""
      }
    );
    if (fromId) activeTelegramAppeals.set(fromId, appeal.id);
    await notifyAdmins(appeal);
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Принято. Ответ придёт сюда."
    });
  }

  if (hasAttachmentPayload) {
    return sendTelegramMessage({
      chat_id: chatId,
      text: "Вложение можно прикрепить к обращению после выбора чата. Поддерживаются фото и аудио: нажмите «Написать обращение» или «Мои обращения».",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }

  return sendTelegramMessage({
    chat_id: chatId,
    text: "Нажмите «Написать обращение» или «Мои обращения». Переписка по обращениям теперь ведется прямо здесь, в Telegram-чате.",
    reply_markup: telegramKeyboardForUser(fromId)
  });
}

async function replyToAppeal(chatId, appealId, replyText, admin) {
  let appeal;
  try {
    appeal = ensureAdminCanOpenAppeal(admin, appealId);
  } catch {
    return callTelegram("sendMessage", { chat_id: chatId, text: "Обращение не найдено." });
  }

  if (!appeal.telegramId) {
    return callTelegram("sendMessage", {
      chat_id: chatId,
      text: "У обращения нет Telegram ID пользователя. Ответьте по указанному контакту."
    });
  }

  assertCleanText(replyText);
  const message = addAppealMessage(appeal.id, {
    senderType: "admin",
    text: replyText,
    actorName: admin.name || ROLE_LABELS[admin.role] || "Администратор"
  });
  if (appeal.status === "new") {
    updateAppealStatus(appeal.id, "in_progress", admin.name || `telegram:${admin.telegramId || ""}`);
  }

  activeTelegramAppeals.set(String(appeal.telegramId), appeal.id);
  await callTelegram("sendMessage", {
    chat_id: appeal.telegramId,
    text: message.text
  });

  return callTelegram("sendMessage", { chat_id: chatId, text: "Ответ отправлен пользователю." });
}

async function clearCallbackInlineKeyboard(callbackQuery) {
  const message = callbackQuery?.message;
  if (!message?.chat?.id || !message.message_id) return;
  await callTelegram("editMessageReplyMarkup", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});
}

async function handleTelegramCallback(callbackQuery) {
  const data = String(callbackQuery.data || "");
  const fromId = callbackQuery.from?.id ? String(callbackQuery.from.id) : "";

  if (data === "bot:routes") {
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    return sendRoutes(callbackQuery.message.chat.id, fromId);
  }

  if (data === "bot:admin") {
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    return sendAdminPanelForUser(callbackQuery.message.chat.id, fromId);
  }

  const staffOpenMatch = data.match(/^staff:appeal:open:([a-z0-9-]+)$/i);
  if (staffOpenMatch) {
    const fromGroup = String(callbackQuery.message?.chat?.id || "") !== String(fromId || "");
    await callTelegram("answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: fromGroup ? "Открыл в личном чате." : "Открыто."
    });
    await clearCallbackInlineKeyboard(callbackQuery);
    return openStaffAppealChat(callbackQuery.message.chat.id, fromId, staffOpenMatch[1], { fromGroup });
  }

  const staffCloseMatch = data.match(/^staff:appeal:close:([a-z0-9-]+)$/i);
  if (staffCloseMatch) {
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Закрываю." });
    await clearCallbackInlineKeyboard(callbackQuery);
    return closeStaffAppealChat(callbackQuery.message.chat.id, fromId, staffCloseMatch[1]);
  }

  if (data === "appeal:cancel") {
    if (fromId) pendingTelegramAppeals.delete(fromId);
    if (fromId) activeTelegramAppeals.delete(fromId);
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Отменено" });
    await clearCallbackInlineKeyboard(callbackQuery);
    return sendTelegramMessage({
      chat_id: callbackQuery.message.chat.id,
      text: "Создание обращения отменено.",
      reply_markup: telegramKeyboardForUser(fromId)
    });
  }

  if (data === "appeal:list") {
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    await clearCallbackInlineKeyboard(callbackQuery);
    return sendUserAppeals(callbackQuery.message.chat.id, fromId);
  }

  if (data === "appeal:new") {
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    await clearCallbackInlineKeyboard(callbackQuery);
    return sendAppealCategoryPicker(callbackQuery.message.chat.id, fromId);
  }

  const openAppealMatch = data.match(/^appeal:open:([a-z0-9-]+)$/i);
  if (openAppealMatch) {
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    await clearCallbackInlineKeyboard(callbackQuery);
    return sendAppealThread(callbackQuery.message.chat.id, fromId, openAppealMatch[1]);
  }

  const categoryMatch = data.match(/^appeal:cat:([a-z0-9_-]+)$/i);
  if (categoryMatch) {
    await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    await clearCallbackInlineKeyboard(callbackQuery);
    return startTelegramAppealTextStep(callbackQuery.message.chat.id, fromId, categoryMatch[1]);
  }

  const statusMatch = data.match(/^appeal:status:([a-z0-9-]+):(new|closed)$/i);
  if (statusMatch) {
    if (statusMatch[2] === "closed") {
      await callTelegram("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Закрываю." });
      await clearCallbackInlineKeyboard(callbackQuery);
      return closeStaffAppealChat(callbackQuery.message.chat.id, fromId, statusMatch[1]);
    }

    const admin = getAdminByTelegramId(fromId);
    if (!admin) {
      return callTelegram("answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: "Доступно только администраторам.",
        show_alert: true
      });
    }

    let appeal;
    try {
      ensureAdminCanOpenAppeal(admin, statusMatch[1]);
      appeal = updateAppealStatus(statusMatch[1], statusMatch[2], `telegram:${fromId}`);
    } catch {
      return callTelegram("answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: "Нет доступа к этому обращению.",
        show_alert: true
      });
    }
    await callTelegram("answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: `Статус: ${STATUS_LABELS[appeal.status]}`
    });

    return callTelegram("sendMessage", {
      chat_id: callbackQuery.message.chat.id,
      text: `Обращение #${appeal.id}: ${STATUS_LABELS[appeal.status]}`
    });
  }
}

async function sendDutyRosterById(uploadId, options = {}) {
  const upload = getDutyRosterUpload(uploadId);
  if (!upload) throw httpError("Загрузка разнарядки не найдена.", 404);
  const force = options.force === true;
  if (upload.status === "sent" && !force) {
    throw httpError("Эта разнарядка уже отправлялась. Для повторной отправки нужно явное подтверждение.", 409);
  }
  if ((upload.status === "needs_review" || upload.status === "blocked") && !force) {
    throw httpError("Разнарядка содержит неоднозначные коды выезда. Исправьте CSV и загрузите его заново перед отправкой.", 409);
  }
  const duplicateSentUpload = findSentDutyRosterUploadByHash(upload.fileHash);
  if (duplicateSentUpload && duplicateSentUpload.id !== upload.id && !force) {
    throw httpError("Такой CSV уже отправлялся раньше. Повторная отправка доступна только после подтверждения.", 409);
  }
  const report = await sendDutyRosterUpload(upload, options);
  const updatedUpload = markDutyRosterUploadSent(upload.id, report);
  if (updatedUpload?.scheduleDate) {
    markDutyRosterDailySend(updatedUpload.scheduleDate, updatedUpload.id, report, options.source || "manual");
  }
  return { upload: updatedUpload, report };
}

async function sendDutyRosterUpload(upload, options = {}) {
  const items = listDutyRosterItems(upload.id);
  const targetSquad = normalizeRosterTargetSquad(upload.targetSquad);
  const users = listDriverUsers().filter((user) => !targetSquad || normalizeRosterTargetSquad(user.driverSquad) === targetSquad);
  // Match by canonical tab key so "007" and "7" resolve to the same driver.
  const usersByTab = new Map(users.map((user) => [tabNumberKey(user.tabNumber), user]).filter(([key]) => key));
  const allowedTabs = new Set(users.map((user) => tabNumberKey(user.tabNumber)).filter(Boolean));
  const itemsToSend = targetSquad ? items.filter((item) => allowedTabs.has(tabNumberKey(item.tabNumber))) : items;
  const assignedTabs = new Set(itemsToSend.map((item) => tabNumberKey(item.tabNumber)));
  const report = {
    uploadId: upload.id,
    scheduleDate: upload.scheduleDate,
    targetSquad,
    sent: 0,
    skipped: 0,
    failed: 0,
    noAssignmentSent: 0,
    unregisteredTabs: [],
    errors: []
  };

  if (!BOT_TOKEN) {
    throw httpError("Telegram-токен не настроен, отправка разнарядки невозможна.", 500);
  }

  for (const item of itemsToSend) {
    // A crashed/partial send must not re-message drivers who already got theirs:
    // items track per-driver send status, so skip delivered ones on retry.
    if (item.sendStatus === "sent" && !options.force) {
      report.sent += 1;
      continue;
    }
    const driver = usersByTab.get(tabNumberKey(item.tabNumber));
    if (!driver?.telegramId) {
      report.skipped += 1;
      report.unregisteredTabs.push({ tabNumber: item.tabNumber, driverName: item.driverName });
      markDutyRosterItemSent(item.id, "skipped", "driver is not registered");
      continue;
    }

    try {
      await callTelegram("sendMessage", {
        chat_id: driver.telegramId,
        text: formatDutyRosterMessage(item)
      });
      report.sent += 1;
      markDutyRosterItemSent(item.id, "sent");
    } catch (error) {
      report.failed += 1;
      report.errors.push({ tabNumber: item.tabNumber, driverName: item.driverName, error: error.message });
      markDutyRosterItemSent(item.id, "error", error.message);
    }
  }

  if (options.sendNoAssignment) {
    for (const user of users) {
      if (assignedTabs.has(tabNumberKey(user.tabNumber))) continue;
      try {
        await callTelegram("sendMessage", {
          chat_id: user.telegramId,
          text: formatNoAssignmentMessage(user, upload.scheduleDate)
        });
        report.noAssignmentSent += 1;
      } catch (error) {
        report.errors.push({ tabNumber: user.tabNumber, driverName: user.fullName || "", error: error.message });
      }
    }
  }

  report.unregisteredTabs = [...new Map(report.unregisteredTabs.map((item) => [item.tabNumber, item])).values()];
  return report;
}

let dutyRosterDailyProcessing = false;

function localDateOnly(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function tomorrowDateOnly() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return localDateOnly(date);
}

function isDutyRosterDailySendTime(now = new Date()) {
  const match = String(DUTY_ROSTER_DAILY_SEND_TIME || "").match(/^(\d{1,2}):(\d{2})$/);
  const targetHours = match ? Math.min(23, Number(match[1])) : 18;
  const targetMinutes = match ? Math.min(59, Number(match[2])) : 0;
  const target = targetHours * 60 + targetMinutes;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // Window runs from the target time until midnight: a roster uploaded late in the
  // evening still auto-sends the same day, and the daily-send record prevents
  // duplicate broadcasts on restarts.
  return nowMinutes >= target;
}

const dutyRosterBlockedNotified = new Set();

async function notifyDutyRosterBlockedOnce(scheduleDate, upload) {
  if (dutyRosterBlockedNotified.has(scheduleDate)) return;
  dutyRosterBlockedNotified.add(scheduleDate);
  if (dutyRosterBlockedNotified.size > 30) dutyRosterBlockedNotified.clear();
  const targets = [...new Set([ADMIN_CHAT_ID, ...ADMIN_IDS].filter(Boolean))];
  await Promise.allSettled(
    targets.map((chatId) =>
      callTelegram("sendMessage", {
        chat_id: chatId,
        text: [
          `Автоотправка разнарядки на ${scheduleDate} не выполнена.`,
          `Последняя загрузка (${upload.fileName || "CSV"}) в статусе «${upload.status}» — она требует проверки.`,
          "Откройте админ-панель, проверьте разнарядку и отправьте её вручную."
        ].join("\n")
      }).catch(() => {})
    )
  );
}

async function processDutyRosterDailySend() {
  if (!DUTY_ROSTER_DAILY_ENABLED || dutyRosterDailyProcessing || !BOT_TOKEN) return null;
  if (!isDutyRosterDailySendTime()) return null;

  const scheduleDate = tomorrowDateOnly();
  if (getDutyRosterDailySend(scheduleDate)) return null;

  const upload = getLatestDutyRosterUploadForDate(scheduleDate);
  if (!upload) return null;

  dutyRosterDailyProcessing = true;
  try {
    if (upload.status === "sent") {
      const report = upload.report || {
        sent: upload.sentCount || 0,
        skipped: upload.skippedCount || 0,
        failed: upload.failedCount || 0
      };
      return markDutyRosterDailySend(scheduleDate, upload.id, report, "already-sent");
    }
    if (upload.status !== "parsed") {
      // The newest upload for tomorrow is held for review (or blocked) — the auto
      // send silently does nothing in that state, so warn the admins once per date
      // instead of leaving drivers without a roster and nobody informed.
      await notifyDutyRosterBlockedOnce(scheduleDate, upload);
      return null;
    }

    const duplicateSentUpload = findSentDutyRosterUploadByHash(upload.fileHash);
    if (duplicateSentUpload && duplicateSentUpload.id !== upload.id) {
      const sentUpload = getDutyRosterUpload(duplicateSentUpload.id) || duplicateSentUpload;
      const report = sentUpload.report || {
        sent: sentUpload.sentCount || 0,
        skipped: sentUpload.skippedCount || 0,
        failed: sentUpload.failedCount || 0
      };
      return markDutyRosterDailySend(scheduleDate, sentUpload.id, report, "duplicate");
    }

    const result = await sendDutyRosterById(upload.id, { source: "daily" });
    console.log(`Duty roster for ${scheduleDate} sent automatically: ${result.report.sent} sent, ${result.report.skipped} without Telegram.`);
    return getDutyRosterDailySend(scheduleDate);
  } catch (error) {
    console.error(`Duty roster daily send failed for ${scheduleDate}: ${error.message}`);
    return null;
  } finally {
    dutyRosterDailyProcessing = false;
  }
}

async function sendNotification(notification) {
  const isStaffNotice = notification.target === "staff";
  const recipients = isStaffNotice ? listStaffRecipients() : listSubscribers();
  if (!BOT_TOKEN) return markNotificationSent(notification.id, 0, recipients.length);

  let sent = 0;
  let failed = 0;

  const text = isStaffNotice
    ? `Служебная информация для сотрудников\n\n${notification.title}\n\n${notification.text}`
    : `${notification.title}\n\n${notification.text}`;

  for (const recipient of recipients) {
    try {
      await callTelegram("sendMessage", {
        chat_id: recipient.telegramId,
        text
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      // Blocked/deactivated chats will fail on every future broadcast too;
      // unsubscribe them so campaigns stop wasting time on dead recipients.
      if (!isStaffNotice && /blocked|deactivated|chat not found/i.test(error.message || "")) {
        markSubscriberUnsubscribed(recipient.telegramId);
      }
    }
  }

  return markNotificationSent(notification.id, sent, failed);
}

function minuteWord(value) {
  const minutes = Math.abs(Number(value)) % 100;
  const lastDigit = minutes % 10;
  if (minutes > 10 && minutes < 20) return "минут";
  if (lastDigit === 1) return "минута";
  if (lastDigit >= 2 && lastDigit <= 4) return "минуты";
  return "минут";
}

function destinationFromDirection(directionName) {
  const value = String(directionName || "").trim();
  if (!value) return "";
  const parts = value.split(/\s*(?:→|->)\s*/).filter(Boolean);
  return (parts.length > 1 ? parts.at(-1) : value).trim();
}

function reminderRouteNumberLabel(routeNumber) {
  const value = String(routeNumber || "").trim().replace(/^№\s*/, "");
  return value ? `№${value}` : "";
}

function minutesFromTimeValue(time) {
  const [hours, minutes] = String(time || "").split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function minutesFromDateValue(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function validateReminderSchedule(reminder) {
  if (!reminder.routeId || !reminder.directionCode || !reminder.stopUid) return { ok: true };

  const departureDate = new Date(reminder.departureAt || Date.now());
  let schedule;
  try {
    schedule = getSchedule({
      routeId: reminder.routeId,
      directionCode: reminder.directionCode,
      stopUid: reminder.stopUid
    });
  } catch (error) {
    // Route/stop removed by a re-import: treat as "schedule changed" so the user
    // gets a notification instead of the reminder silently dying as "failed".
    if (error.statusCode === 404) return { ok: false, next: null };
    throw error;
  }
  const relevantTimes = (schedule.groups || [])
    .filter((group) => dayMaskIncludesServiceDate(group.dayMask, departureDate))
    .flatMap((group) => (group.times || []).map((item) => ({ ...item, dayMask: item.dayMask || group.dayMask || "" })))
    .map((item) => ({ ...item, minutes: minutesFromTimeValue(item.time) }))
    .filter((item) => item.time && Number.isFinite(item.minutes));

  const sameReminderTrip = (item) => {
    if (item.time !== reminder.departureTime) return false;
    if (reminder.dayMask && item.dayMask !== reminder.dayMask) return false;
    if (reminder.tripCode && item.tripCode !== reminder.tripCode) return false;
    if (reminder.variantCode && item.variantCode !== reminder.variantCode) return false;
    return true;
  };

  if (relevantTimes.some(sameReminderTrip)) return { ok: true };

  const nowMinutes = minutesFromDateValue(new Date());
  const next = relevantTimes
    .filter((item) => item.minutes >= nowMinutes)
    .sort((left, right) => left.minutes - right.minutes)[0] || null;

  return { ok: false, next };
}

let reminderProcessing = false;

async function processDueReminders() {
  if (reminderProcessing) return;
  reminderProcessing = true;

  try {
  const reminders = listDueReminders(50);
  if (!reminders.length) return;

  for (const reminder of reminders) {
    if (!BOT_TOKEN) {
      markReminderDone(reminder.id, "failed", "BOT_TOKEN is empty");
      continue;
    }

    try {
      const scheduleCheck = validateReminderSchedule(reminder);
      if (!scheduleCheck.ok) {
        await sendTelegramMessage({
          chat_id: reminder.telegramId,
          text: [
            "Расписание изменилось",
            "",
            `Будильник на ${reminder.departureTime} больше не совпадает с актуальным расписанием.`,
            reminder.routeNumber ? `Маршрут: ${reminderRouteNumberLabel(reminder.routeNumber)}` : "",
            reminder.stopName ? `Остановка: ${reminder.stopName}` : "",
            scheduleCheck.next?.time ? `Ближайший подходящий рейс: ${scheduleCheck.next.time}.` : "На сегодня подходящих рейсов по этому будильнику нет.",
            "",
            "Проверьте расписание и поставьте будильник заново."
          ].filter(Boolean).join("\n")
        });
        markReminderDone(reminder.id, "changed", "Schedule changed before reminder");
        continue;
      }

      const destination = destinationFromDirection(reminder.directionName);
      await sendTelegramMessage({
        chat_id: reminder.telegramId,
        text: [
          "🔔 Напоминание",
          `⏳ До отправления: ${reminder.remindMinutes} ${minuteWord(reminder.remindMinutes)}`,
          reminder.routeNumber ? `🚌 Маршрут: ${reminderRouteNumberLabel(reminder.routeNumber)}` : "",
          destination ? `➡️ Направление: ${destination}` : "",
          reminder.stopName ? `📍 Остановка: ${reminder.stopName}` : "",
          "⏰ Успейте выйти заранее."
        ].filter(Boolean).join("\n")
      });
      rescheduleReminder(reminder);
    } catch (error) {
      markReminderDone(reminder.id, "failed", error.message);
    }
  }
  } finally {
    reminderProcessing = false;
  }
}

let scheduledRouteImportProcessing = false;

async function processDueScheduledRouteImports() {
  if (scheduledRouteImportProcessing) return;
  scheduledRouteImportProcessing = true;

  try {
    recoverStaleScheduledRouteImports(30);
    const imports = listDueScheduledRouteImports(10);
    for (const item of imports) {
      if (!claimScheduledRouteImport(item.id)) continue;

      try {
        const result = importRoutesFromXmlFiles(item.files || [], {
          source: `scheduled-route-import:${item.id}`,
          mode: "upsert",
          actor: item.createdBy || "system",
          expectedRouteNumber: item.routeNumber,
          transportType: item.summary?.transportType || ""
        });
        completeScheduledRouteImport(item.id, {
          ...result,
          routeId: item.routeId,
          actor: item.createdBy || "system"
        });
        clearPublicJsonCache();
      } catch (error) {
        failScheduledRouteImport(item.id, error, item.createdBy || "system");
      }
    }
  } finally {
    scheduledRouteImportProcessing = false;
  }
}

async function startTelegramPolling() {
  if (DISABLE_TELEGRAM_POLLING) {
    console.log("Telegram polling is disabled for this run.");
    return;
  }

  if (!BOT_TOKEN) {
    console.log("BOT_TOKEN is empty. HTTP app is running without Telegram polling.");
    return;
  }

  if (CLEAR_TELEGRAM_WEBHOOK_ON_POLLING) {
    await callTelegram("deleteWebhook", { drop_pending_updates: false }).catch((error) => {
      console.error(`Telegram webhook cleanup failed: ${error.message}`);
    });
  }

  await configureDefaultMenu().catch((error) => console.error(`Telegram menu setup failed: ${error.message}`));
  await configureBotCommands().catch((error) => console.error(`Telegram commands setup failed: ${error.message}`));
  await syncStaffMenus().catch((error) => console.error(`Telegram staff menu sync failed: ${error.message}`));

  let offset = 0;
  console.log("Telegram bot polling started.");

  while (true) {
    try {
      const updates = await callTelegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        // Isolate each update: a failure handling one message must not abandon the
        // rest of the batch (offset is already advanced, so they'd be lost forever).
        try {
          if (update.message) await handleTelegramMessage(update.message);
          if (update.callback_query) await handleTelegramCallback(update.callback_query);
        } catch (updateError) {
          console.error(`Telegram update ${update.update_id} failed: ${updateError.message}`);
        }
      }
    } catch (error) {
      console.error(error.message);
      await delay(3000);
    }
  }
}

function createHttpServer() {
  const server = http.createServer(requestHandler);
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  return server;
}

function listenHttpServer(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function startHttpServer(port = PORT) {
  validateRuntimeConfig();
  if (WARM_PUBLIC_CACHE_ON_START) warmPublicCaches();

  const requestedPort = Number(port);
  const startPort = Number.isFinite(requestedPort) && requestedPort >= 0 ? requestedPort : PORT;
  // Port 0 asks the OS for an ephemeral port, so the +offset fallback is meaningless there.
  const attempts = PORT_FALLBACK_ENABLED && startPort !== 0 ? PORT_FALLBACK_ATTEMPTS : 1;
  let lastError = null;

  for (let offset = 0; offset < attempts; offset += 1) {
    const targetPort = startPort + offset;
    const server = createHttpServer();
    try {
      await listenHttpServer(server, targetPort);
      if (targetPort !== startPort) {
        console.log(`Port ${startPort} is busy. Using http://localhost:${targetPort} instead.`);
      }
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : targetPort;
      console.log(`Mini App server is running at http://localhost:${actualPort}`);
      console.log(`Admin panel: http://localhost:${actualPort}/admin`);
      return server;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EADDRINUSE" || offset === attempts - 1) throw error;
    }
  }

  throw lastError || new Error("Failed to start HTTP server.");
}

async function startApp() {
  const server = await startHttpServer(PORT);
  startTelegramPolling();
  // Each async job must swallow its own rejection: an unhandled rejection from a
  // bare setInterval callback would terminate the whole Node process.
  const logJobError = (error) => console.error(error?.message || error);
  const reminderTimer = setInterval(() => processDueReminders().catch(logJobError), 30_000);
  const scheduledImportTimer = setInterval(() => processDueScheduledRouteImports().catch(logJobError), 30_000);
  const dutyRosterDailyTimer = setInterval(() => processDutyRosterDailySend().catch(logJobError), 5 * 60 * 1000);
  const rateLimitCleanupTimer = setInterval(cleanupRateLimits, 10 * 60 * 1000);
  const scheduleCleanupTimer = setInterval(() => {
    try {
      cleanupScheduleMaintenanceRecords();
    } catch (error) {
      console.error(error.message);
    }
  }, 60 * 60 * 1000);
  server.once("close", () => {
    clearInterval(reminderTimer);
    clearInterval(scheduledImportTimer);
    clearInterval(dutyRosterDailyTimer);
    clearInterval(rateLimitCleanupTimer);
    clearInterval(scheduleCleanupTimer);
  });
  processDueReminders().catch((error) => console.error(error.message));
  processDueScheduledRouteImports().catch((error) => console.error(error.message));
  processDutyRosterDailySend().catch((error) => console.error(error.message));
  try {
    cleanupScheduleMaintenanceRecords();
  } catch (error) {
    console.error(error.message);
  }

  // Graceful shutdown: stop accepting connections, let in-flight requests drain
  // (server.close also clears the timers above), then exit. Force-exit as a backstop.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  return server;
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

if (require.main === module) {
  startApp().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  requestHandler,
  startApp,
  startHttpServer,
  verifyTelegramInitData
};
