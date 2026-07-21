const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { assertCleanText } = require("./content-filter");

process.env.TZ = process.env.TZ || "Europe/Minsk";

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const configuredDbPath = process.env.DATABASE_PATH || "";
const DB_PATH = configuredDbPath
  ? path.resolve(ROOT_DIR, configuredDbPath)
  : path.join(DATA_DIR, "app.db");

const STATUS_LABELS = {
  new: "Открыто",
  in_progress: "Открыто",
  closed: "Закрыто"
};

const APPEAL_RETENTION_DAYS = 3;
const APPEAL_PURGE_INTERVAL_MS = Math.max(60_000, Number(process.env.APPEAL_PURGE_INTERVAL_MS) || 5 * 60 * 1000);
const SCHEDULE_CLEANUP_RETENTION_MS = 24 * 60 * 60 * 1000;
const EXTRA_REST_DAYS = new Set(["2026-04-20"]);
const EXTRA_WORK_DAY_REPLACEMENTS = new Map([["2026-04-25", 1]]);

const ROLE_LABELS = {
  admin: "Администратор",
  worker: "Работник",
  appeals_manager: "Обращения",
  dispatcher: "Диспетчер",
  moderator: "Модератор",
  ads_manager: "Реклама",
  sto_manager: "Услуги / СТО",
  driver: "Водитель"
};

const PERMISSIONS = {
  admin: ["appeals", "ads", "news", "notifications", "admins", "schedule", "about", "services", "roster", "visits"],
  worker: [],
  appeals_manager: ["appeals"],
  dispatcher: ["appeals", "roster"],
  moderator: ["appeals"],
  ads_manager: ["appeals"],
  sto_manager: ["appeals"],
  driver: []
};

const DRIVER_SQUAD_LABELS = {
  city: "1-й отряд — город",
  regional: "2-й отряд — пригород / межгород / международный"
};

Object.assign(STATUS_LABELS, {
  new: "Открыто",
  in_progress: "Открыто",
  closed: "Закрыто"
});

Object.assign(ROLE_LABELS, {
  admin: "Администратор",
  worker: "Работник",
  appeals_manager: "Обращения",
  dispatcher: "Диспетчер",
  moderator: "Модератор",
  ads_manager: "Реклама",
  sto_manager: "Услуги / СТО",
  driver: "Водитель"
});

let database;
let routesCache = { expiresAt: 0, data: null };
let statsCache = { expiresAt: 0, data: null };
let variantContextCache = new Map();
let linkedTripStopsCache = new Map();
const preparedStatements = new Map();
const CACHE_TTL_MS = 30_000;
const ROUTES_CACHE_TTL_MS = Math.max(CACHE_TTL_MS, Number(process.env.ROUTES_CACHE_TTL_MS) || 5 * 60 * 1000);
const VARIANT_CONTEXT_CACHE_LIMIT = Math.max(32, Number(process.env.VARIANT_CONTEXT_CACHE_LIMIT) || 256);
const LINKED_TRIP_STOPS_CACHE_LIMIT = Math.max(256, Number(process.env.LINKED_TRIP_STOPS_CACHE_LIMIT) || 4096);
const LINKED_SEGMENT_MAX_GAP_MINUTES = 5;
let lastAppealPurgeAt = 0;
const INFERRED_FEEDER_ORIGINS = [
  {
    routeNumber: "7",
    stopName: "С-П Магистральный",
    originName: "Автобусный парк"
  }
];

function invalidateStatsCache() {
  statsCache = { expiresAt: 0, data: null };
}

function invalidateScheduleCache() {
  routesCache = { expiresAt: 0, data: null };
  variantContextCache = new Map();
  linkedTripStopsCache = new Map();
  invalidateStatsCache();
}

function prepareCached(db, key, sql) {
  const cached = preparedStatements.get(key);
  if (cached) return cached;
  const statement = db.prepare(sql);
  preparedStatements.set(key, statement);
  return statement;
}

function rememberLimitedCache(cache, key, value, limit) {
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
  return value;
}

function getDb() {
  if (database) return database;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA temp_store = MEMORY");
  database.exec("PRAGMA cache_size = -20000");
  database.exec("PRAGMA mmap_size = 268435456");
  migrate(database);
  seed(database);
  return database;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      source_dir TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      route_count INTEGER NOT NULL DEFAULT 0,
      stop_count INTEGER NOT NULL DEFAULT 0,
      departure_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS routes (
      route_id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      name TEXT NOT NULL,
      raw_name TEXT NOT NULL,
      transport_type TEXT NOT NULL DEFAULT 'Автобус',
      color TEXT NOT NULL,
      date_start TEXT,
      date_exp TEXT,
      source_file TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS directions (
      direction_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
      direction_code TEXT NOT NULL,
      name TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(route_id, direction_code)
    );

    CREATE TABLE IF NOT EXISTS stops (
      stop_uid TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
      direction_code TEXT NOT NULL,
      export_stop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      position INTEGER NOT NULL,
      FOREIGN KEY(route_id, direction_code) REFERENCES directions(route_id, direction_code) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS departures (
      departure_id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id TEXT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
      direction_code TEXT NOT NULL,
      stop_uid TEXT NOT NULL REFERENCES stops(stop_uid) ON DELETE CASCADE,
      day_mask TEXT NOT NULL,
      day_name TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      departure_minutes INTEGER NOT NULL,
      arrival_time TEXT,
      trip_code TEXT,
      variant_code TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_routes_number ON routes(CAST(number AS INTEGER), number);
    CREATE INDEX IF NOT EXISTS idx_stops_route_direction ON stops(route_id, direction_code, position);
    CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_departures_stop ON departures(route_id, direction_code, stop_uid, day_mask, departure_minutes);
    CREATE INDEX IF NOT EXISTS idx_departures_trip ON departures(route_id, trip_code, variant_code);
    CREATE INDEX IF NOT EXISTS idx_departures_trip_lookup ON departures(route_id, direction_code, day_mask, trip_code, variant_code, departure_minutes, stop_uid);
    CREATE INDEX IF NOT EXISTS idx_departures_stop_uid_time ON departures(stop_uid, day_mask, departure_minutes);

    CREATE TABLE IF NOT EXISTS appeals (
      appeal_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'new',
      category TEXT NOT NULL,
      route_id TEXT,
      route_number TEXT,
      stop_name TEXT,
      text TEXT NOT NULL,
      contact TEXT,
      source TEXT NOT NULL,
      telegram_id TEXT,
      telegram_username TEXT,
      first_name TEXT,
      last_name TEXT,
      assigned_role TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS appeal_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      appeal_id TEXT NOT NULL REFERENCES appeals(appeal_id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      note TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS appeal_messages (
      message_id TEXT PRIMARY KEY,
      appeal_id TEXT NOT NULL REFERENCES appeals(appeal_id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,
      text TEXT NOT NULL,
      actor_name TEXT,
      telegram_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_appeals_closed_updated ON appeals(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_appeals_telegram ON appeals(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_appeal_messages ON appeal_messages(appeal_id, created_at);

    CREATE TABLE IF NOT EXISTS appeal_attachments (
      attachment_id TEXT PRIMARY KEY,
      appeal_id TEXT NOT NULL REFERENCES appeals(appeal_id) ON DELETE CASCADE,
      message_id TEXT REFERENCES appeal_messages(message_id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      name TEXT,
      mime_type TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_appeal_attachments_message ON appeal_attachments(message_id, created_at);

    CREATE TABLE IF NOT EXISTS ads (
      ad_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Реклама',
      url TEXT,
      image_url TEXT,
      placement TEXT NOT NULL DEFAULT 'top',
      display_seconds INTEGER NOT NULL DEFAULT 7,
      status TEXT NOT NULL DEFAULT 'active',
      starts_at TEXT,
      ends_at TEXT,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(status, starts_at, ends_at);

    CREATE TABLE IF NOT EXISTS services (
      service_id TEXT PRIMARY KEY,
      section TEXT NOT NULL DEFAULT 'sto',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'checklist',
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_services_section ON services(section, status, sort_order);

    CREATE TABLE IF NOT EXISTS news (
      news_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      image_url TEXT,
      views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'info',
      status TEXT NOT NULL DEFAULT 'published',
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS news_likes (
      news_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (news_id, voter_id),
      FOREIGN KEY (news_id) REFERENCES news(news_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_news_published ON news(status, published_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_likes_news ON news_likes(news_id);

    CREATE TABLE IF NOT EXISTS admins (
      admin_id TEXT PRIMARY KEY,
      telegram_id TEXT UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leadership_contacts (
      contact_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'Руководство',
      phone TEXT,
      phone_label TEXT,
      email TEXT,
      note TEXT,
      photo_url TEXT,
      featured INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_subscribers (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      subscribed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS driver_users (
      driver_id TEXT PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      tab_number TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_driver_users_tab ON driver_users(tab_number);

    CREATE TABLE IF NOT EXISTS notifications (
      notification_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'all',
      status TEXT NOT NULL DEFAULT 'draft',
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reminders (
      reminder_id TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      route_id TEXT,
      direction_code TEXT NOT NULL DEFAULT '',
      stop_uid TEXT NOT NULL DEFAULT '',
      route_number TEXT,
      direction_name TEXT,
      stop_name TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      day_mask TEXT NOT NULL DEFAULT '',
      trip_code TEXT NOT NULL DEFAULT '',
      variant_code TEXT NOT NULL DEFAULT '',
      departure_at TEXT NOT NULL,
      remind_minutes INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      sent_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, remind_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(telegram_id, status);

    CREATE TABLE IF NOT EXISTS schedule_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      route_id TEXT,
      direction_code TEXT,
      stop_uid TEXT,
      before_json TEXT,
      after_json TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_audit_created ON schedule_audit(created_at);
    CREATE INDEX IF NOT EXISTS idx_schedule_audit_route ON schedule_audit(route_id, created_at);

    CREATE TABLE IF NOT EXISTS schedule_backups (
      backup_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      route_count INTEGER NOT NULL DEFAULT 0,
      stop_count INTEGER NOT NULL DEFAULT 0,
      departure_count INTEGER NOT NULL DEFAULT 0,
      payload BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_backups_created ON schedule_backups(created_at);

    CREATE TABLE IF NOT EXISTS scheduled_route_imports (
      import_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      route_number TEXT NOT NULL,
      route_name TEXT,
      mode TEXT NOT NULL DEFAULT 'upsert',
      status TEXT NOT NULL DEFAULT 'pending',
      effective_at TEXT NOT NULL,
      files_payload BLOB NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      applied_batch_id TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_route_imports_due ON scheduled_route_imports(status, effective_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_route_imports_route ON scheduled_route_imports(route_number, effective_at);

    CREATE TABLE IF NOT EXISTS duty_roster_uploads (
      upload_id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      schedule_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'parsed',
      uploaded_by TEXT NOT NULL,
      assignment_count INTEGER NOT NULL DEFAULT 0,
      driver_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT,
      report_json TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_duty_roster_uploads_created ON duty_roster_uploads(created_at);
    CREATE INDEX IF NOT EXISTS idx_duty_roster_uploads_hash ON duty_roster_uploads(file_hash);
    CREATE INDEX IF NOT EXISTS idx_duty_roster_uploads_date ON duty_roster_uploads(schedule_date, created_at);

    CREATE TABLE IF NOT EXISTS duty_roster_items (
      item_id TEXT PRIMARY KEY,
      upload_id TEXT NOT NULL REFERENCES duty_roster_uploads(upload_id) ON DELETE CASCADE,
      schedule_date TEXT NOT NULL,
      tab_number TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      assignment_type TEXT NOT NULL DEFAULT 'route',
      route TEXT,
      route_car_number TEXT,
      shift TEXT,
      work_time_start TEXT,
      work_time_end TEXT,
      bus_plate_number TEXT,
      garage_number TEXT,
      replacement_driver_name TEXT,
      replacement_tab_number TEXT,
      is_line_change INTEGER NOT NULL DEFAULT 0,
      raw_data TEXT,
      send_status TEXT NOT NULL DEFAULT 'pending',
      sent_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_duty_roster_items_upload ON duty_roster_items(upload_id);
    CREATE INDEX IF NOT EXISTS idx_duty_roster_items_tab ON duty_roster_items(tab_number, schedule_date);

    CREATE TABLE IF NOT EXISTS duty_roster_daily_sends (
      schedule_date TEXT PRIMARY KEY,
      upload_id TEXT REFERENCES duty_roster_uploads(upload_id) ON DELETE SET NULL,
      source TEXT NOT NULL DEFAULT 'auto',
      sent_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      report_json TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_visits (
      visit_id TEXT PRIMARY KEY,
      visited_at TEXT NOT NULL,
      visited_on TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '/',
      visitor_hash TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_site_visits_date ON site_visits(visited_on);
    CREATE INDEX IF NOT EXISTS idx_site_visits_visitor_date ON site_visits(visitor_hash, visited_on);
  `);
  ensureColumn(db, "appeals", "client_token", "TEXT");
  ensureColumn(db, "appeals", "assigned_role", "TEXT");
  ensureColumn(db, "ads", "image_url", "TEXT");
  ensureColumn(db, "ads", "display_seconds", "INTEGER NOT NULL DEFAULT 7");
  ensureColumn(db, "services", "image_url", "TEXT");
  ensureColumn(db, "services", "category", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "services", "bullets", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "news", "image_url", "TEXT");
  ensureColumn(db, "news", "views", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "news", "likes", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "admins", "tab_number", "TEXT");
  ensureColumn(db, "admins", "driver_squad", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "driver_users", "driver_squad", "TEXT NOT NULL DEFAULT 'city'");
  ensureColumn(db, "duty_roster_uploads", "target_squad", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "duty_roster_uploads", "warnings_json", "TEXT");
  ensureColumn(db, "duty_roster_items", "assignment_type", "TEXT NOT NULL DEFAULT 'route'");
  ensureColumn(db, "scheduled_route_imports", "closed_at", "TEXT");
  ensureColumn(db, "reminders", "direction_code", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "reminders", "stop_uid", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "reminders", "repeat_mode", "TEXT NOT NULL DEFAULT 'once'");
  ensureColumn(db, "reminders", "repeat_days", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "reminders", "day_mask", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "reminders", "trip_code", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "reminders", "variant_code", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)");
  maybeRunScheduleCleanup(db);
  backfillServiceMeta(db);
}

// Категория-тег и список «Что входит» — новые поля услуг (редизайн 2026-07-12).
// Ключ — (section, icon): он стабилен и совпадает у сида и у макета, тогда как
// названия местами расходятся («Тормозная система» vs «Ремонт тормозной…»).
// Заполняем ТОЛЬКО пустые поля — правки владельца в админке не перетираем.
const SERVICE_META_SEED = {
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

function backfillServiceMeta(db) {
  if (getAppMeta(db, "services_meta_backfill_v1") === "done") return;
  try {
    const rows = db.prepare("SELECT service_id AS id, section, icon, category, bullets FROM services").all();
    const update = db.prepare("UPDATE services SET category = ?, bullets = ? WHERE service_id = ?");
    db.exec("BEGIN IMMEDIATE");
    try {
      rows.forEach((row) => {
        const meta = SERVICE_META_SEED[row.section]?.[row.icon];
        if (!meta) return;
        const category = row.category && row.category.trim() ? row.category : meta.category;
        const bullets = row.bullets && row.bullets.trim() ? row.bullets : meta.bullets.join("\n");
        if (category !== row.category || bullets !== row.bullets) update.run(category, bullets, row.id);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    setAppMeta(db, "services_meta_backfill_v1", "done");
  } catch (error) {
    console.warn("Service meta backfill skipped:", error.message || error);
  }
}

function getAppMeta(db, key) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setAppMeta(db, key, value) {
  db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

function scheduleContentSignature(db) {
  const sig = db.prepare(`
    SELECT (SELECT COUNT(*) FROM routes) AS routes,
           (SELECT COUNT(*) FROM departures) AS departures,
           (SELECT COALESCE(MAX(updated_at), '') FROM routes) AS updatedAt
  `).get();
  return `${sig.routes}:${sig.departures}:${sig.updatedAt}`;
}

// These self-joining cleanup scans used to run on every process start, taking write
// locks over the whole departures table each boot. They only matter after the data
// changes, so gate them behind a content signature: skip entirely when the schedule
// is unchanged since the last cleanup.
function maybeRunScheduleCleanup(db) {
  const signature = scheduleContentSignature(db);
  if (getAppMeta(db, "schedule_cleanup_signature") === signature) return;
  pruneSingleStopXmlTrips(db);
  mergeConsecutiveDuplicateStops(db);
  pruneDuplicateLoopEndpointDepartures(db);
  pruneSingleStopXmlTrips(db);
  setAppMeta(db, "schedule_cleanup_signature", scheduleContentSignature(db));
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function pruneSingleStopXmlTrips(db) {
  const candidates = db
    .prepare(`
      SELECT dep.route_id AS routeId, dep.direction_code AS directionCode,
             dep.day_mask AS dayMask, dep.trip_code AS tripCode, dep.variant_code AS variantCode,
             MIN(dep.stop_uid) AS stopUid,
             MIN(dep.departure_minutes) AS departureMinutes,
             MIN(s.position) AS position,
             COUNT(dep.departure_id) AS departureCount,
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
    `)
    .all();
  const rows = candidates.filter((row) => !hasLinkedContinuationXmlTrip(db, row));
  if (!rows.length) return { removedTrips: 0, removedDepartures: 0, removedStops: 0 };

  db.exec("BEGIN IMMEDIATE");
  try {
    const deleteTrip = db.prepare(`
      DELETE FROM departures
      WHERE route_id = ?
        AND direction_code = ?
        AND day_mask = ?
        AND trip_code = ?
        AND variant_code = ?
    `);
    const deleteUnusedStops = db.prepare(`
      DELETE FROM stops
      WHERE route_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM departures dep
          WHERE dep.stop_uid = stops.stop_uid
        )
    `);
    let removedDepartures = 0;
    let removedStops = 0;
    const routeIds = new Set();

    rows.forEach((row) => {
      removedDepartures += deleteTrip.run(
        row.routeId,
        row.directionCode,
        row.dayMask,
        row.tripCode,
        row.variantCode
      ).changes;
      routeIds.add(row.routeId);
    });
    routeIds.forEach((routeId) => {
      removedStops += deleteUnusedStops.run(routeId).changes;
    });

    db.exec("COMMIT");
    invalidateScheduleCache();
    return { removedTrips: rows.length, removedDepartures, removedStops };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function hasLinkedContinuationXmlTrip(db, row) {
  return Boolean(
    db
      .prepare(`
        SELECT 1
        FROM departures dep
        JOIN stops dep_stop ON dep_stop.stop_uid = dep.stop_uid
        JOIN departures next_dep ON next_dep.route_id = dep.route_id
          AND next_dep.direction_code = dep.direction_code
          AND next_dep.day_mask = dep.day_mask
          AND next_dep.trip_code = dep.trip_code
          AND next_dep.variant_code = dep.variant_code
        JOIN stops next_stop ON next_stop.stop_uid = next_dep.stop_uid
        WHERE dep.route_id = ?
          AND dep.direction_code = ?
          AND dep.day_mask = ?
          AND dep.variant_code = ?
          AND dep.trip_code <> ?
          AND (
            dep.stop_uid = ?
            OR dep_stop.position = ? + 1
          )
          AND dep.departure_minutes BETWEEN ? AND ?
          AND next_stop.position > ?
        LIMIT 1
      `)
      .get(
        row.routeId,
        row.directionCode,
        row.dayMask,
        row.variantCode,
        row.tripCode,
        row.stopUid,
        row.position,
        row.departureMinutes,
        row.departureMinutes + LINKED_SEGMENT_MAX_GAP_MINUTES,
        row.position
      )
  );
}

function mergeConsecutiveDuplicateStops(db) {
  const rows = db
    .prepare(`
      SELECT route_id AS routeId, direction_code AS directionCode, stop_uid AS stopUid,
             export_stop_id AS exportStopId, normalized_name AS normalizedName, position
      FROM stops
      ORDER BY route_id, direction_code, position, stop_uid
    `)
    .all();
  if (!rows.length) return { mergedStops: 0 };

  const merges = [];
  let groupKey = "";
  let previousKept = null;

  rows.forEach((row) => {
    const key = `${row.routeId}:${row.directionCode}`;
    if (key !== groupKey) {
      groupKey = key;
      previousKept = row;
      return;
    }

    const sameStop = previousKept
      && row.exportStopId === previousKept.exportStopId
      && row.normalizedName === previousKept.normalizedName;
    if (sameStop) {
      merges.push({ duplicateUid: row.stopUid, targetUid: previousKept.stopUid });
      return;
    }

    previousKept = row;
  });

  if (!merges.length) return { mergedStops: 0 };

  db.exec("BEGIN IMMEDIATE");
  try {
    const moveDepartures = db.prepare("UPDATE departures SET stop_uid = ? WHERE stop_uid = ?");
    const deleteStop = db.prepare("DELETE FROM stops WHERE stop_uid = ?");
    merges.forEach((item) => {
      moveDepartures.run(item.targetUid, item.duplicateUid);
      deleteStop.run(item.duplicateUid);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  invalidateScheduleCache();
  return { mergedStops: merges.length };
}

function pruneDuplicateLoopEndpointDepartures(db) {
  const rows = db
    .prepare(`
      SELECT early.departure_id AS departureId
      FROM departures early
      JOIN routes r ON r.route_id = early.route_id
      JOIN stops early_stop ON early_stop.stop_uid = early.stop_uid
      JOIN departures late ON late.route_id = early.route_id
        AND late.direction_code = early.direction_code
        AND late.day_mask = early.day_mask
        AND late.trip_code = early.trip_code
        AND late.variant_code = early.variant_code
        AND late.departure_minutes = early.departure_minutes
        AND late.arrival_time = early.arrival_time
        AND late.departure_id <> early.departure_id
      JOIN stops late_stop ON late_stop.stop_uid = late.stop_uid
      WHERE COALESCE(r.source_file, '') LIKE '%.xml'
        AND COALESCE(early.trip_code, '') <> ''
        AND COALESCE(early.variant_code, '') <> ''
        AND COALESCE(early.trip_code, '') NOT LIKE 'manual-%'
        AND LOWER(COALESCE(early.variant_code, '')) <> 'manual'
        AND early_stop.route_id = early.route_id
        AND early_stop.direction_code = early.direction_code
        AND late_stop.route_id = late.route_id
        AND late_stop.direction_code = late.direction_code
        AND early_stop.export_stop_id = late_stop.export_stop_id
        AND early_stop.normalized_name = late_stop.normalized_name
        AND early_stop.position < late_stop.position
      GROUP BY early.departure_id
    `)
    .all();
  if (!rows.length) return { removedDepartures: 0 };

  db.exec("BEGIN IMMEDIATE");
  try {
    const deleteDeparture = db.prepare("DELETE FROM departures WHERE departure_id = ?");
    rows.forEach((row) => deleteDeparture.run(row.departureId));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  invalidateScheduleCache();
  return { removedDepartures: rows.length };
}

function seed(db) {
  const now = new Date().toISOString();
  const adCount = db.prepare("SELECT COUNT(*) AS count FROM ads").get().count;
  if (adCount === 0) {
    db.prepare(`
      INSERT INTO ads (ad_id, title, text, label, url, placement, status, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "safety-2026",
      "Безопасная поездка",
      "Держитесь за поручни и заранее готовьте оплату проезда.",
      "Автобусный парк",
      "",
      "top",
      "active",
      "2026-01-01",
      "2026-12-31",
      now,
      now
    );
  }

  const newsCount = db.prepare("SELECT COUNT(*) AS count FROM news").get().count;
  if (newsCount === 0) {
    db.prepare(`
      INSERT INTO news (news_id, title, text, type, status, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "welcome",
      "Сервис готовится к запуску",
      "Расписание загружается из файлов маршрутов. Обращения пассажиров уже можно принимать через Telegram.",
      "info",
      "published",
      now,
      now,
      now
    );
  }

  const leadershipCount = db.prepare("SELECT COUNT(*) AS count FROM leadership_contacts").get().count;
  if (leadershipCount === 0) seedLeadershipContacts(db, now);

  const serviceCount = db.prepare("SELECT COUNT(*) AS count FROM services").get().count;
  if (serviceCount === 0) seedServices(db, now);

  ensureRoute17(db);
}

function seedServices(db, now) {
  const services = [
    ["sto-engine", "sto", "Ремонт двигателя", "Диагностика и ремонт двигателя любой сложности.", "Цена после диагностики", "Проверка состояния, поиск неисправностей, согласование работ и сроков.", "engine"],
    ["sto-brake", "sto", "Ремонт тормозной системы", "Замена колодок, дисков и диагностика тормозов.", "Цена после осмотра", "Специалист уточнит модель транспорта, симптомы и удобное время визита.", "brake"],
    ["sto-ac", "sto", "Заправка и ремонт кондиционера", "Заправка фреоном, диагностика и ремонт системы.", "Уточняет специалист", "Подходит для сезонной проверки и восстановления работы кондиционера.", "snow"],
    ["sto-gearbox", "sto", "Ремонт КПП и редукторов", "Ремонт механических узлов и редукторов.", "Цена по объему работ", "Можно описать шум, течь, переключение передач или другую проблему.", "gear"],
    ["sto-suspension", "sto", "Ремонт ходовой части", "Диагностика и ремонт подвески и ходовой части.", "Цена после диагностики", "Проверяются основные узлы, после чего согласуются работы.", "axle"],
    ["sto-electric", "sto", "Ремонт электрооборудования", "Диагностика и ремонт автомобильной электрики.", "Уточняет специалист", "Опишите проблему: запуск, свет, зарядка, датчики или проводка.", "bolt"],
    ["sto-welding", "sto", "Сварочные работы", "Сварка, подготовка и изготовление элементов.", "Цена по задаче", "Добавьте фото детали, чтобы специалист быстрее оценил задачу.", "weld"],
    ["sto-maintenance", "sto", "Плановое обслуживание", "ТО по регламенту, замена масел и расходников.", "По перечню работ", "Подходит для регулярного обслуживания транспорта.", "checklist"],
    ["sto-diagnostics", "sto", "Диагностика автомобиля", "Комплексная диагностика узлов автомобиля.", "Цена после запроса", "Специалист подскажет, что проверить и когда удобнее подъехать.", "car"],
    ["sto-laser", "sto", "Лазерная очистка металла", "Удаление ржавчины, краски и загрязнений.", "Цена по площади", "Можно приложить фото детали для предварительной оценки.", "spark"],
    ["sto-fluids", "sto", "Замена технических жидкостей", "Замена масла, антифриза и тормозной жидкости.", "По виду жидкости", "Уточните транспорт, жидкость и желаемое время обслуживания.", "drop"],
    ["sto-tire", "sto", "Шиномонтаж", "Монтаж, балансировка и ремонт шин.", "По размеру колеса", "Для записи укажите размер шин и удобный день.", "tire"],
    ["other-bus-rent", "other", "Аренда автобусов", "Пассажирские перевозки под заказ.", "Цена по маршруту", "Укажите дату, время, количество пассажиров и маршрут.", "bus"],
    ["other-premises", "other", "Аренда помещений", "Аренда залов, кабинетов и площадей.", "Уточняет специалист", "Специалист расскажет о свободных помещениях и условиях аренды.", "building"],
    ["other-canteen", "other", "Столовая", "Комплексные обеды и обслуживание.", "По меню", "Можно уточнить режим работы, меню и возможность обслуживания группы.", "meal"],
    ["other-medical", "other", "Медицинское и техническое освидетельствование", "Медосмотры, справки и технические проверки.", "Уточняет специалист", "Напишите, какое освидетельствование требуется и для кого.", "medical"],
    ["other-ad", "other", "Реклама на бортах автобуса", "Размещение рекламы на транспорте.", "По сроку и формату", "Укажите формат, срок размещения и желаемые маршруты.", "ad"],
    ["other-oil", "other", "Покупка отработанных масел", "Прием и покупка отработанных масел.", "По договоренности", "Специалист уточнит объем, условия и порядок передачи.", "oil"],
    ["other-station", "other", "Автовокзал", "Справочная информация и билеты.", "По тарифу перевозчика", "Можно уточнить рейсы, расписание и контактную информацию.", "station"],
    ["other-lyahovichi", "other", "Автостанция Ляховичи", "Справочная информация по автостанции.", "По тарифу перевозчика", "Уточните интересующий рейс или направление.", "pin"],
    ["other-market", "other", "Рынок «Кірмаш Палескі»", "Торговые ряды и аренда мест.", "Уточняет специалист", "Специалист подскажет условия аренды и свободные места.", "market"]
  ];

  const stmt = db.prepare(`
    INSERT INTO services (service_id, section, name, description, price, details, icon, status, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  services.forEach((item, index) => {
    stmt.run(item[0], item[1], item[2], item[3], item[4], item[5], item[6], index + 1, now, now);
  });
}

function seedLeadershipContacts(db, now) {
  const contacts = [
    ["Шестак Игорь Михайлович", "Директор", "Руководство", "(0163) 68 19 91", "приемная", "", "", 1],
    ["Мойсейчик Александр Анатольевич", "Главный инженер", "Руководство", "(0163) 68 19 99", "", "", "", 1],
    ["Климович Александр Леонидович", "Заместитель директора по перевозкам", "Перевозки", "(0163) 68 19 26", "", "", "", 1],
    ["Семашко Андрей Михайлович", "Заместитель директора по идеологической работе и безопасности", "Руководство", "(0163) 60 81 18", "", "", "", 1],
    ["Гундар Алексей Валерьевич", "Главный энергетик", "Техническая служба", "(0163) 68 19 13", "", "", "", 1],
    ["Осовец Светлана Ивановна", "Главный бухгалтер", "Бухгалтерия", "(0163) 68 19 15", "", "", "", 1],
    ["Климович Елена Владимировна", "Главный экономист, председатель первичной профсоюзной организации", "Бухгалтерия", "(0163) 68 19 16", "", "", "", 0],
    ["Манкевич Алексей Павлович", "Начальник центра сервисного обслуживания и ремонта транспортных средств", "Техническая служба", "(0163) 68 19 28", "", "", "", 0],
    ["Петрушко Игорь Борисович", "Начальник станции технического обслуживания", "Техническая служба", "(0163) 68 19 28", "", "", "", 0],
    ["Радченко Дмитрий Дмитриевич", "Начальник автоотряда городских перевозок", "Автовокзал", "(0163) 68 19 08", "", "", "", 0],
    ["Мастиловский Андрей Андреевич", "Начальник объединенного автовокзала «АВ Барановичи, АС Ляховичи»", "Автовокзал", "(0163) 64 18 28", "", "", "", 0],
    ["Чилик Игорь Анатольевич", "Заместитель начальника объединенного автовокзала «АВ Барановичи, АС Ляховичи»", "Автовокзал", "(0163) 64 18 28", "", "", "", 0],
    ["Автостанция г. Ляховичи", "Справочная информация", "Автовокзал", "(01633) 2-12-67", "", "", "", 0],
    ["Лопух Владимир Владимирович", "Начальник отдела безопасности", "Безопасность", "(0163) 68 19 29", "", "", "", 0],
    ["Михайлов Денис Сергеевич", "Начальник отдела организационно-кадровой и правовой работы", "Кадры", "(0163) 68 19 18", "", "", "", 0],
    ["Гутырчик Татьяна Алексеевна", "Начальник отдела производственно-технического и материального обеспечения", "Техническая служба", "(0163) 68 19 34", "", "", "", 0],
    ["Столяр Дарья Викторовна", "Инженер по охране труда", "Безопасность", "(0163) 68 19 14", "", "", "", 0],
    ["Диспетчерская автоотряда городских перевозок", "157 короткий номер доступен по г. Барановичи и Барановичскому району", "Перевозки", "(0163) 68 19 30", "", "", "", 0],
    ["Диспетчерская автоотряда пригородных, междугородных и международных перевозок", "Диспетчерская служба", "Перевозки", "(0163) 68 19 27", "", "", "", 0],
    ["Столовая", "Фельдман Галина Михайловна", "Прочие услуги", "(0163) 68 19 25", "", "", "", 0],
    ["Синекова Татьяна Владимировна", "Первичная профсоюзная организация", "Прочие услуги", "(0163) 68 19 26", "", "", "", 0]
  ];
  const stmt = db.prepare(`
    INSERT INTO leadership_contacts (
      contact_id, name, position, department, phone, phone_label, email, note, photo_url,
      featured, active, sort_order, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  contacts.forEach((item, index) => {
    stmt.run(createId(), item[0], item[1], item[2], item[3], item[4], item[5], item[6], "", item[7], index + 1, now, now);
  });
}

function ensureRoute17(db = getDb()) {
  const existing = db
    .prepare("SELECT route_id AS id FROM routes WHERE route_id = ? OR (number = ? AND route_id NOT LIKE ?)")
    .get("manual-route-17", "17", "%:%");
  if (existing) return { routeCount: 0, stopCount: 0, departureCount: 0 };

  const existingRoutes = db.prepare("SELECT COUNT(*) AS count FROM routes").get().count;
  if (existingRoutes === 0) return { routeCount: 0, stopCount: 0, departureCount: 0 };

  const now = new Date().toISOString();
  const routeId = "manual-route-17";
  const directionCode = "1";
  const directionId = `${routeId}:${directionCode}`;
  const stops = [
    ["Микрорайон Северный", "06:23"],
    ["Проспект Советский", "06:25"],
    ["Ледовый дворец", "06:28"],
    ["ТЭЦ", "06:30"],
    ["Ул. Брестская", "06:32"],
    ["Музыкальная школа", "06:34"],
    ["Ул. Красноармейская", "06:41"],
    ["ТЭЦ", "06:44"],
    ["Лицей", "06:46"],
    ["Ледовый дворец", "06:48"],
    ["Проспект Советский", "06:49"]
  ];

  db.prepare(`
    INSERT INTO routes (route_id, number, name, raw_name, transport_type, color, date_start, date_exp, source_file, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    routeId,
    "17",
    "Микрорайон Северный - Красноармейская - Микрорайон Северный",
    "Маршрут №17 «Микрорайон Северный - Красноармейская - Микрорайон Северный»",
    "городской",
    "#155eef",
    "2013-12-22",
    null,
    "bar-bus-route-17",
    now
  );

  db.prepare(`
    INSERT INTO directions (direction_id, route_id, direction_code, name, origin, destination, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    directionId,
    routeId,
    directionCode,
    "Северный → Красноармейская → Северный",
    "Микрорайон Северный",
    "Микрорайон Северный",
    0
  );

  const insertStop = db.prepare(`
    INSERT INTO stops (stop_uid, route_id, direction_code, export_stop_id, name, normalized_name, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDeparture = db.prepare(`
    INSERT INTO departures (
      route_id, direction_code, stop_uid, day_mask, day_name, departure_time, departure_minutes,
      arrival_time, trip_code, variant_code, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stops.forEach(([name, time], index) => {
    const position = index + 1;
    const exportStopId = `route17-${String(position).padStart(2, "0")}`;
    const stopUid = `${routeId}:${directionCode}:${position}:${exportStopId}`;
    insertStop.run(stopUid, routeId, directionCode, exportStopId, name, normalizeName(name), position);
    insertDeparture.run(
      routeId,
      directionCode,
      stopUid,
      "1111100",
      "Рабочие дни",
      time,
      minutesFromTime(time),
      time,
      "17-0623",
      "weekday-loop",
      "По выходным не курсирует"
    );
  });

  const latestImport = db.prepare("SELECT id FROM import_batches ORDER BY imported_at DESC LIMIT 1").get();
  if (latestImport) {
    db.prepare(`
      UPDATE import_batches
      SET route_count = route_count + 1,
          stop_count = stop_count + ?,
          departure_count = departure_count + ?
      WHERE id = ?
    `).run(stops.length, stops.length, latestImport.id);
  }

  routesCache = { expiresAt: 0, data: null };
  invalidateStatsCache();
  return { routeCount: 1, stopCount: stops.length, departureCount: stops.length };
}

function seedAdminsFromEnv(adminIds) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO admins (admin_id, telegram_id, name, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(telegram_id) DO NOTHING
  `);

  adminIds.forEach((telegramId) => {
    stmt.run(createId(), telegramId, `Telegram ${telegramId}`, "admin", now, now);
  });
}

function hasPermission(role, permission) {
  return (PERMISSIONS[role] || []).includes(permission);
}

function isAdvertisingCategory(category) {
  return normalizeName(category).includes("реклама");
}

function isServiceCategory(category) {
  const value = normalizeName(category);
  return (
    value.includes("сто") ||
    value.includes("сервис") ||
    value.includes("услуг") ||
    value.includes("аренда") ||
    value.includes("столовая") ||
    value.includes("освидетельствование") ||
    value.includes("автовокзал") ||
    value.includes("автостанция") ||
    value.includes("рынок") ||
    value.includes("масел")
  );
}

function isComplaintCategory(category) {
  const value = normalizeName(category);
  return (
    value.includes("жалоб") ||
    value.includes("претенз") ||
    value.includes("водител") ||
    value.includes("хамств") ||
    value.includes("безопасн") ||
    value.includes("опоздан") ||
    value.includes("не останов")
  );
}

function isScheduleCategory(category) {
  const value = normalizeName(category);
  return (
    value.includes("расписан") ||
    value.includes("маршрут") ||
    value.includes("останов") ||
    value.includes("рейс")
  );
}

// Authoritative mapping for the fixed appeal categories the bot offers. Exact
// matches win so a well-known category (e.g. "Жалоба") always routes to the right
// role, instead of being re-guessed by fragile substring matching where overlapping
// keywords ("жалоба на расписание") could resolve ambiguously.
const APPEAL_CATEGORY_ROLES = {
  "жалоба": "moderator",
  "расписание / остановка": "dispatcher",
  "реклама": "ads_manager",
  "сто / услуги": "sto_manager",
  "другая проблема": "appeals_manager"
};

function resolveAppealAssignedRole(category) {
  const exact = APPEAL_CATEGORY_ROLES[normalizeName(category)];
  if (exact) return exact;
  if (isAdvertisingCategory(category)) return "ads_manager";
  if (isServiceCategory(category)) return "sto_manager";
  if (isScheduleCategory(category)) return "dispatcher";
  if (isComplaintCategory(category)) return "moderator";
  return "appeals_manager";
}

function roleCanSeeAppeal(role, appeal) {
  if (role === "admin") return true;
  return role === resolveAppealAssignedRole(appeal.category);
}

function normalizeAppealRecord(appeal) {
  if (!appeal) return appeal;
  return {
    ...appeal,
    assignedRole: resolveAppealAssignedRole(appeal.category)
  };
}

function getAdminByTelegramId(telegramId) {
  if (!telegramId) return null;
  return getDb()
    .prepare("SELECT admin_id AS id, telegram_id AS telegramId, name, role, active FROM admins WHERE telegram_id = ? AND active = 1")
    .get(String(telegramId));
}

function listRoutes() {
  const now = Date.now();
  if (routesCache.data && routesCache.expiresAt > now) return routesCache.data;

  const db = getDb();
  const routes = db
    .prepare(`
      SELECT route_id AS id, number, name, raw_name AS rawName, transport_type AS type, color,
             date_start AS dateStart, date_exp AS dateExp, source_file AS sourceFile, updated_at AS updatedAt
      FROM routes
      ORDER BY CAST(number AS INTEGER), number
    `)
    .all();

  const directions = db
    .prepare(`
      SELECT direction_id AS id, route_id AS routeId, direction_code AS code, name, origin AS "from",
             destination AS "to", position
      FROM directions
      ORDER BY route_id, position
    `)
    .all();

  const stops = db
    .prepare(`
      SELECT stop_uid AS id, route_id AS routeId, direction_code AS directionCode, name, position
      FROM stops
      ORDER BY route_id, direction_code, position
    `)
    .all();

  const directionsByRoute = groupBy(directions, "routeId");
  const stopsByDirection = new Map();
  stops.forEach((stop) => {
    const key = `${stop.routeId}:${stop.directionCode}`;
    if (!stopsByDirection.has(key)) stopsByDirection.set(key, []);
    stopsByDirection.get(key).push({ id: stop.id, name: stop.name, position: stop.position });
  });

  const result = routes.map((route) => ({
    ...route,
    directions: (directionsByRoute.get(route.id) || []).map((direction) => ({
      ...direction,
      ...splitPassengerDirectionStops(stopsByDirection.get(`${route.id}:${direction.code}`) || [], direction)
    }))
  }));
  routesCache = { expiresAt: now + ROUTES_CACHE_TTL_MS, data: result };
  return result;
}

function splitPassengerDirectionStops(stops = [], direction = {}) {
  const ordered = [...(stops || [])].sort((a, b) => Number(a.position) - Number(b.position));
  if (!ordered.length) return { stops: [], extraStartStops: [], extraEndStops: [] };
  if (stopNamesMatch(direction.from, direction.to)) {
    return { stops: ordered.map((stop) => ({ ...stop })), extraStartStops: [], extraEndStops: [] };
  }

  const originIndex = findStopIndexByName(ordered, direction.from, { fallback: 0 });
  const destinationIndex = findStopIndexByName(ordered, direction.to, {
    startIndex: originIndex,
    preferLast: true,
    fallback: ordered.length - 1
  });

  const mainStart = Math.max(0, originIndex);
  const mainEnd = Math.max(mainStart, destinationIndex);
  return {
    stops: ordered.slice(mainStart, mainEnd + 1).map((stop) => ({ ...stop })),
    extraStartStops: ordered.slice(0, mainStart).map((stop) => ({ ...stop, extraBoundary: "start" })),
    extraEndStops: ordered.slice(mainEnd + 1).map((stop) => ({ ...stop, extraBoundary: "end" }))
  };
}

function findStopIndexByName(stops = [], stopName = "", options = {}) {
  if (!stopName) return Number.isInteger(options.fallback) ? options.fallback : -1;
  const startIndex = Math.max(0, Number(options.startIndex) || 0);
  const indexes = [];
  for (let index = startIndex; index < stops.length; index += 1) {
    if (stopNamesMatch(stops[index]?.name, stopName)) indexes.push(index);
  }
  if (indexes.length) return options.preferLast ? indexes[indexes.length - 1] : indexes[0];
  return Number.isInteger(options.fallback) ? options.fallback : -1;
}

function getSchedule({ routeId, directionCode, stopUid }) {
  const db = getDb();
  const selectedStop = db
    .prepare("SELECT stop_uid AS stopUid, name, position FROM stops WHERE stop_uid = ? AND route_id = ? AND direction_code = ?")
    .get(stopUid, routeId, directionCode);
  if (!selectedStop) throw httpError("Schedule stop not found for the selected route and direction.", 404);
  const rows = db
    .prepare(`
      SELECT day_mask AS dayMask, day_name AS dayName, departure_time AS time, arrival_time AS arrivalTime,
             trip_code AS tripCode, variant_code AS variantCode, notes
      FROM departures
      WHERE route_id = ? AND direction_code = ? AND stop_uid = ?
      ORDER BY day_mask, departure_minutes, departure_time
    `)
    .all(routeId, directionCode, stopUid);

  const variantContext = buildDirectionVariantContext(db, routeId, directionCode);
  const tripStopsCache = new Map();

  const groups = [];
  const byMask = new Map();
  rows.forEach((row) => {
    const tripKey = `${row.dayMask}:${row.tripCode}:${row.variantCode}`;
    if (!tripStopsCache.has(tripKey)) {
      tripStopsCache.set(tripKey, getTripStopsWithLinkedSegments(db, routeId, directionCode, row.dayMask, row.tripCode, row.variantCode));
    }
    const tripStops = tripStopsCache.get(tripKey);
    const tripBounds = tripTimeBounds(tripStops);
    const originStop = tripOriginName(tripStops, variantContext, row);
    const rawDestinationStop = row.destinationStop || tripStops[tripStops.length - 1]?.name || "";
    const rowWithTripContext = { ...row, originStop, destinationStop: rawDestinationStop };
    const variantInfo = buildTripVariantInfo(tripStops, variantContext, rowWithTripContext, selectedStop);
    const destinationStop = resolveTripDestinationStop(tripStops, variantContext, rowWithTripContext);
    const key = `${row.dayMask}:${row.dayName}`;
    if (!byMask.has(key)) {
      const group = { dayMask: row.dayMask, dayName: row.dayName, times: [] };
      byMask.set(key, group);
      groups.push(group);
    }
    byMask.get(key).times.push({
      time: row.time,
      arrivalTime: row.arrivalTime,
      tripCode: row.tripCode,
      variantCode: row.variantCode,
      notes: row.notes || "",
      originStop,
      destinationStop,
      rawDestinationStop,
      tripStartTime: tripBounds.tripStartTime,
      tripEndTime: tripBounds.tripEndTime,
      tripStartMinutes: tripBounds.tripStartMinutes,
      tripEndMinutes: tripBounds.tripEndMinutes,
      viaLabel: variantInfo.viaLabel,
      variantKind: variantInfo.kind,
      variantStops: variantInfo.stops,
      tripStopCount: tripStops.length,
      hasRouteVariants: variantContext.hasVariants
    });
  });
  groups.forEach((group) => {
    const seen = new Set();
    group.times = group.times.filter((item) => {
      const key = [
        item.time,
        item.arrivalTime,
        item.destinationStop || "",
        item.rawDestinationStop || "",
        item.tripStartTime || "",
        item.tripEndTime || "",
        item.tripCode || "",
        item.variantCode || "",
        item.viaLabel || "",
        item.variantKind || "",
        item.notes || ""
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  return { groups };
}

function tripTimeBounds(stops = []) {
  let dayOffset = 0;
  let previousMinutes = -1;
  let first = null;
  let last = null;

  stops.forEach((stop) => {
    const time = stop.time || stop.arrivalTime || "";
    if (!/^\d{1,2}:\d{2}$/.test(time)) return;
    const rawMinutes = minutesFromTime(time);
    if (rawMinutes + dayOffset < previousMinutes && isLikelyOvernightRollover(previousMinutes, rawMinutes)) {
      dayOffset += 1440;
    }
    const minutes = rawMinutes + dayOffset;
    previousMinutes = minutes;
    const point = { time, minutes };
    if (!first) first = point;
    last = point;
  });

  return {
    tripStartTime: first?.time || "",
    tripEndTime: last?.time || "",
    tripStartMinutes: Number.isFinite(first?.minutes) ? first.minutes : null,
    tripEndMinutes: Number.isFinite(last?.minutes) ? last.minutes : null
  };
}

function isLikelyOvernightRollover(previousMinutes, rawMinutes) {
  const previousDayMinutes = wrapDayMinutes(previousMinutes);
  return previousDayMinutes >= 18 * 60 && rawMinutes <= 6 * 60;
}

function buildDirectionVariantContext(db, routeId, directionCode) {
  const cacheKey = `${routeId}:${directionCode}`;
  if (variantContextCache.has(cacheKey)) return variantContextCache.get(cacheKey);

  const route = db
    .prepare("SELECT number, name FROM routes WHERE route_id = ?")
    .get(routeId);
  const direction = db
    .prepare("SELECT origin, destination FROM directions WHERE route_id = ? AND direction_code = ?")
    .get(routeId, directionCode);
  const routeStops = db
    .prepare("SELECT stop_uid AS stopUid, name, position FROM stops WHERE route_id = ? AND direction_code = ? ORDER BY position")
    .all(routeId, directionCode);
  const rows = db
    .prepare(`
      SELECT DISTINCT dep.day_mask AS dayMask, dep.trip_code AS tripCode, dep.variant_code AS variantCode
      FROM departures dep
      WHERE dep.route_id = ? AND dep.direction_code = ?
      ORDER BY dep.day_mask, dep.trip_code, dep.variant_code
    `)
    .all(routeId, directionCode);

  const trips = new Map();
  rows.forEach((row) => {
    const key = `${row.dayMask}:${row.tripCode}:${row.variantCode}`;
    if (isLinkedContinuationTrip(db, routeId, directionCode, row.dayMask, row.tripCode, row.variantCode)) return;
    if (!trips.has(key)) trips.set(key, new Set());
    getTripStopsWithLinkedSegments(db, routeId, directionCode, row.dayMask, row.tripCode, row.variantCode)
      .forEach((stop) => trips.get(key).add(stop.name));
  });

  const frequencyByName = new Map();
  const countedTrips = [...trips.values()].filter((names) => names.size > 1);
  const tripsForFrequency = countedTrips.length ? countedTrips : [...trips.values()];
  tripsForFrequency.forEach((names) => {
    names.forEach((name) => {
      const key = normalizeStopKey(name);
      if (key) frequencyByName.set(key, (frequencyByName.get(key) || 0) + 1);
    });
  });

  const tripCount = tripsForFrequency.length;
  const rawOptionalNames = new Set();
  const declaredOriginKey = normalizeStopKey(direction?.origin || "");
  const declaredDestinationKey = normalizeStopKey(direction?.destination || "");
  const circularDirection = stopNamesMatch(direction?.origin || "", direction?.destination || "");
  const declaredOriginIndex = findStopIndexByName(routeStops, direction?.origin || "", { fallback: 0 });
  const declaredDestinationIndex = circularDirection
    ? routeStops.length - 1
    : findStopIndexByName(routeStops, direction?.destination || "", {
      startIndex: Math.max(0, declaredOriginIndex),
      preferLast: true,
      fallback: routeStops.length - 1
    });
  const declaredOriginStop = routeStops[declaredOriginIndex] || null;
  const declaredDestinationStop = routeStops[declaredDestinationIndex] || null;
  frequencyByName.forEach((count, name) => {
    if (name === declaredOriginKey || name === declaredDestinationKey) return;
    if (count < tripCount) rawOptionalNames.add(name);
  });

  const stopsByName = new Map();
  routeStops.forEach((stop) => {
    const key = normalizeStopKey(stop.name);
    if (key && !stopsByName.has(key)) stopsByName.set(key, stop);
  });
  const commonPositions = routeStops
    .filter((stop) => {
      const key = normalizeStopKey(stop.name);
      return key && frequencyByName.get(key) === tripCount;
    })
    .map((stop) => Number(stop.position))
    .filter(Number.isFinite);
  const firstCommonPosition = commonPositions.length ? Math.min(...commonPositions) : null;
  const lastCommonPosition = commonPositions.length ? Math.max(...commonPositions) : null;
  const optionalNames = new Set();
  rawOptionalNames.forEach((name) => {
    const stop = stopsByName.get(name);
    const position = Number(stop?.position);
    const hasCommonCorridor = Number.isFinite(firstCommonPosition) && Number.isFinite(lastCommonPosition);
    if (hasCommonCorridor && Number.isFinite(position) && (position <= firstCommonPosition || position >= lastCommonPosition)) return;
    optionalNames.add(name);
  });
  const internalOptionalStops = routeStops
    .filter((stop) => optionalNames.has(normalizeStopKey(stop.name)))
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((stop) => stop.name);

  const context = {
    routeNumber: route?.number || "",
    routeName: route?.name || "",
    tripCount,
    optionalNames,
    internalOptionalStops,
    frequencyByName,
    stopsByName,
    originName: direction?.origin || "",
    destinationName: direction?.destination || "",
    originPosition: Number(declaredOriginStop?.position),
    destinationPosition: Number(declaredDestinationStop?.position),
    firstCommonPosition,
    lastCommonPosition,
    hasVariants: optionalNames.size > 0
  };
  return rememberLimitedCache(variantContextCache, cacheKey, context, VARIANT_CONTEXT_CACHE_LIMIT);
}

function tripOriginName(tripStops, context, row = {}) {
  return inferFeederOriginName(tripStops, context) || tripStops[0]?.name || row.originStop || "";
}

function inferFeederOriginName(tripStops, context = {}) {
  if (!Array.isArray(tripStops) || Number(tripStops.linkedSegmentCount || 0) < 2) return "";
  const firstStop = tripStops[0];
  if (!firstStop?.name) return "";
  const firstSegmentStopCount = tripStops.filter((stop) => stop.segmentIndex === 0).length;
  if (firstSegmentStopCount !== 1) return "";

  const rule = INFERRED_FEEDER_ORIGINS.find((item) => {
    return routeNumbersMatch(context.routeNumber, item.routeNumber)
      && stopNamesMatch(firstStop.name, item.stopName)
      && (!context.originName || stopNamesMatch(context.originName, item.stopName));
  });
  return rule?.originName || "";
}

function routeNumbersMatch(left, right) {
  const normalize = (value) => String(value || "").trim().toLocaleLowerCase("ru-RU");
  return normalize(left) === normalize(right);
}

function buildTripVariantInfo(tripStops, context, row, selectedStop = null) {
  const originName = row.originStop || tripStops[0]?.name || "";
  const origin = normalizeStopKey(originName);
  const destination = normalizeStopKey(row.destinationStop || "");
  const optionalStops = context.hasVariants
    ? uniqueByName(tripStops)
      .map((stop) => stop.name)
      .filter((name) => context.optionalNames.has(normalizeStopKey(name)))
      .filter((name) => isInternalVariantStop(name, context))
      .filter((name) => {
        const normalized = normalizeStopKey(name);
        return normalized && normalized !== origin && normalized !== destination;
      })
    : [];

  const labels = [];
  const originLabel = tripOriginLabel(originName, context, selectedStop);
  if (originLabel) labels.push(originLabel);

  const highlightedStops = compactVariantStopNames(optionalStops);
  if (highlightedStops.length) labels.push(`заезд: ${formatStopList(highlightedStops)}`);
  if (labels.length) return { kind: "via", viaLabel: labels.join(" · "), stops: highlightedStops };
  if (!context.hasVariants) return { kind: "regular", viaLabel: "", stops: [] };

  return {
    kind: "skip",
    viaLabel: skippedVariantLabel(context.internalOptionalStops || []),
    stops: compactVariantStopNames(context.internalOptionalStops || [])
  };
}

function tripOriginLabel(originName, context, selectedStop) {
  const originKey = normalizeStopKey(originName);
  const declaredOriginKey = normalizeStopKey(context.originName || "");
  if (!originKey || !declaredOriginKey || stopNamesMatch(originName, context.originName)) return "";

  const originStop = findStopByNameKey(context.stopsByName, originKey);
  const selectedPosition = Number(selectedStop?.position);
  const originPosition = Number(originStop?.position);
  if (Number.isFinite(selectedPosition) && Number.isFinite(originPosition) && selectedPosition <= originPosition) return "";

  return originPrepositionLabel(originName);
}

function originPrepositionLabel(originName) {
  if (stopNamesMatch(originName, "Автобусный парк")) return "от Автобусного парка";
  return `от ${originName}`;
}

function skippedVariantLabel(stops) {
  const highlightedStops = compactVariantStopNames(stops);
  if (!highlightedStops.length) return "прямой рейс";
  return `не заезжает: ${formatStopList(highlightedStops)}`;
}

function isInternalVariantStop(name, context) {
  if (!Number.isFinite(context.firstCommonPosition) || !Number.isFinite(context.lastCommonPosition)) return true;
  const stop = findStopByNameKey(context.stopsByName, normalizeStopKey(name));
  if (!stop) return true;
  const position = Number(stop.position);
  return position > context.firstCommonPosition && position < context.lastCommonPosition;
}

function resolveTripDestinationStop(tripStops, context, row) {
  const rawDestination = row.destinationStop || "";
  const declaredDestination = context.destinationName || "";
  if (!rawDestination) return declaredDestination;
  if (!declaredDestination) return rawDestination;

  const rawKey = normalizeStopKey(rawDestination);
  const declaredKey = normalizeStopKey(declaredDestination);
  const chainedDestination = tripStops[tripStops.length - 1]?.name || "";
  const chainedKey = normalizeStopKey(chainedDestination);
  if (stopNamesMatch(rawDestination, declaredDestination)) {
    return declaredDestination.length > rawDestination.length ? declaredDestination : rawDestination;
  }
  if (chainedKey && chainedKey !== rawKey) {
    return stopNamesMatch(chainedDestination, declaredDestination) ? declaredDestination : chainedDestination;
  }

  if (shouldUseDeclaredDestination(rawDestination, tripStops[tripStops.length - 1], context)) {
    return declaredDestination;
  }

  return rawDestination;
}

function shouldUseDeclaredDestination(rawDestination, rawStop, context) {
  const declaredKey = normalizeStopKey(context.destinationName || "");
  const rawKey = normalizeStopKey(rawDestination || rawStop?.name || "");
  if (!declaredKey || !rawKey || stopNamesMatch(rawDestination || rawStop?.name, context.destinationName)) return false;

  const declaredStop = findStopByNameKey(context.stopsByName, declaredKey);
  if (!rawStop || !declaredStop) return false;

  const positionGap = Number(declaredStop.position) - Number(rawStop.position);
  const declaredCoverage = context.tripCount
    ? (context.frequencyByName.get(declaredKey) || 0) / context.tripCount
    : 1;

  return positionGap > 0 && positionGap <= 2 && declaredCoverage <= 0.3;
}

function getTripStopsWithLinkedSegments(db, routeId, directionCode, dayMask, tripCode, variantCode) {
  const cacheKey = `${routeId}:${directionCode}:${dayMask}:${tripCode}:${variantCode}`;
  if (linkedTripStopsCache.has(cacheKey)) return linkedTripStopsCache.get(cacheKey);

  const selectTripStops = prepareCached(db, "trip-stops-with-linked-segments:select-trip-stops", `
    SELECT DISTINCT s.stop_uid AS stopUid, s.name, s.position,
           dep.departure_time AS time, dep.arrival_time AS arrivalTime,
           dep.departure_minutes AS minutes,
           dep.trip_code AS tripCode, dep.variant_code AS variantCode
    FROM departures dep
    JOIN stops s ON s.stop_uid = dep.stop_uid
    WHERE dep.route_id = ?
      AND dep.direction_code = ?
      AND dep.day_mask = ?
      AND dep.trip_code = ?
      AND dep.variant_code = ?
    ORDER BY s.position
  `);
  const findLinkedTrip = prepareCached(db, "trip-stops-with-linked-segments:find-linked-trip", `
    SELECT dep.trip_code AS tripCode, dep.variant_code AS variantCode,
           MIN(dep.departure_minutes - ?) AS gapMinutes,
           COUNT(next_dep.departure_id) AS tailStops
    FROM departures dep
    JOIN stops s ON s.stop_uid = dep.stop_uid
    JOIN departures next_dep ON next_dep.route_id = dep.route_id
      AND next_dep.direction_code = dep.direction_code
      AND next_dep.day_mask = dep.day_mask
      AND next_dep.trip_code = dep.trip_code
      AND next_dep.variant_code = dep.variant_code
    JOIN stops next_stop ON next_stop.stop_uid = next_dep.stop_uid
    WHERE dep.route_id = ?
      AND dep.direction_code = ?
      AND dep.day_mask = ?
      AND dep.variant_code = ?
      AND dep.trip_code <> ?
      AND dep.departure_minutes BETWEEN ? AND ?
      AND (
        dep.stop_uid = ?
        OR s.position = ? + 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM departures earlier_dep
        WHERE earlier_dep.route_id = dep.route_id
          AND earlier_dep.direction_code = dep.direction_code
          AND earlier_dep.day_mask = dep.day_mask
          AND earlier_dep.trip_code = dep.trip_code
          AND earlier_dep.variant_code = dep.variant_code
          AND earlier_dep.departure_minutes < dep.departure_minutes
      )
      AND next_stop.position > ?
    GROUP BY dep.trip_code, dep.variant_code
    ORDER BY gapMinutes, tailStops DESC, dep.trip_code
    LIMIT 1
  `);

  const result = [];
  const visitedTrips = new Set();
  let linkedSegmentCount = 0;
  let currentTripCode = tripCode;
  let currentVariantCode = variantCode;

  for (let segment = 0; segment < 6; segment += 1) {
    const key = `${dayMask}:${currentTripCode}:${currentVariantCode}`;
    if (visitedTrips.has(key)) break;
    visitedTrips.add(key);

    const segmentStops = selectTripStops.all(routeId, directionCode, dayMask, currentTripCode, currentVariantCode);
    const lastPosition = result.length ? Number(result[result.length - 1].position) : 0;
    const previousSegmentStopCount = segment > 0
      ? result.filter((stop) => stop.segmentIndex === segment - 1).length
      : 0;
    const lastResultStop = result[result.length - 1] || null;
    segmentStops
      .filter((stop, index) => {
        const position = Number(stop.position);
        if (position > lastPosition) return true;
        return index === 0
          && position === lastPosition
          && previousSegmentStopCount === 1
          && Number(stop.minutes) >= Number(lastResultStop?.minutes);
      })
      .forEach((stop) => result.push({ ...stop, segmentIndex: segment }));
    linkedSegmentCount += 1;

    const last = result[result.length - 1];
    const lastMinutes = Number(last?.minutes);
    if (!last?.stopUid || !Number.isFinite(lastMinutes)) break;

    const linked = findLinkedTrip.get(
      lastMinutes,
      routeId,
      directionCode,
      dayMask,
      currentVariantCode,
      currentTripCode,
      lastMinutes,
      lastMinutes + LINKED_SEGMENT_MAX_GAP_MINUTES,
      last.stopUid,
      Number(last.position),
      Number(last.position)
    );
    if (!linked?.tripCode) break;

    currentTripCode = linked.tripCode;
    currentVariantCode = linked.variantCode;
  }

  result.linkedSegmentCount = linkedSegmentCount;
  return rememberLimitedCache(linkedTripStopsCache, cacheKey, result, LINKED_TRIP_STOPS_CACHE_LIMIT);
}

function isLinkedContinuationTrip(db, routeId, directionCode, dayMask, tripCode, variantCode) {
  const first = prepareCached(db, "linked-continuation-trip:first-stop", `
      SELECT dep.stop_uid AS stopUid, dep.departure_time AS time, dep.departure_minutes AS minutes, s.position
      FROM departures dep
      JOIN stops s ON s.stop_uid = dep.stop_uid
      WHERE dep.route_id = ?
        AND dep.direction_code = ?
        AND dep.day_mask = ?
        AND dep.trip_code = ?
        AND dep.variant_code = ?
      ORDER BY dep.departure_minutes, s.position
      LIMIT 1
    `)
    .get(routeId, directionCode, dayMask, tripCode, variantCode);
  const firstMinutes = Number(first?.minutes);
  if (!first?.stopUid || !Number.isFinite(firstMinutes)) return false;

  const parent = prepareCached(db, "linked-continuation-trip:parent-trip", `
      SELECT parent.trip_code AS tripCode,
             MIN(? - parent.departure_minutes) AS gapMinutes
      FROM departures parent
      JOIN stops parent_stop ON parent_stop.stop_uid = parent.stop_uid
      WHERE parent.route_id = ?
        AND parent.direction_code = ?
        AND parent.day_mask = ?
        AND parent.variant_code = ?
        AND parent.trip_code <> ?
        AND parent.departure_minutes BETWEEN ? AND ?
        AND (
          parent.stop_uid = ?
          OR parent_stop.position = ? - 1
          OR parent_stop.position = ?
          OR EXISTS (
            SELECT 1
            FROM departures before_dep
            JOIN stops before_stop ON before_stop.stop_uid = before_dep.stop_uid
            WHERE before_dep.route_id = parent.route_id
              AND before_dep.direction_code = parent.direction_code
              AND before_dep.day_mask = parent.day_mask
              AND before_dep.trip_code = parent.trip_code
              AND before_dep.variant_code = parent.variant_code
              AND before_stop.position < ?
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM departures after_dep
          JOIN stops after_stop ON after_stop.stop_uid = after_dep.stop_uid
          WHERE after_dep.route_id = parent.route_id
            AND after_dep.direction_code = parent.direction_code
            AND after_dep.day_mask = parent.day_mask
            AND after_dep.trip_code = parent.trip_code
            AND after_dep.variant_code = parent.variant_code
            AND after_stop.position > ?
        )
      GROUP BY parent.trip_code
      ORDER BY gapMinutes
      LIMIT 1
    `)
    .get(
      firstMinutes,
      routeId,
      directionCode,
      dayMask,
      variantCode,
      tripCode,
      firstMinutes - LINKED_SEGMENT_MAX_GAP_MINUTES,
      firstMinutes,
      first.stopUid,
      Number(first.position),
      Number(first.position),
      Number(first.position),
      Number(first.position)
    );

  return Boolean(parent);
}

function uniqueByName(stops) {
  const seen = new Set();
  const result = [];
  stops.forEach((stop) => {
    const key = normalizeStopKey(stop.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(stop);
  });
  return result;
}

function normalizeStopKey(value) {
  return normalizeName(value)
    .replace(/^ооо\s+/u, "")
    .replace(/^кл\.?\s+/u, "кладбище ")
    .replace(/[«»"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stopNamesMatch(left, right) {
  const a = normalizeStopKey(left);
  const b = normalizeStopKey(right);
  if (!a || !b) return false;
  return a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));
}

function findStopByNameKey(stopsByName, key) {
  if (!key) return null;
  if (stopsByName.has(key)) return stopsByName.get(key);
  for (const [candidateKey, stop] of stopsByName.entries()) {
    if (stopNamesMatch(candidateKey, key)) return stop;
  }
  return null;
}

function tripStopsForTimeline(tripStops, context, tripKey = {}) {
  const stops = markExtraBoundaryStopsForTimeline(tripStops, context);
  const originName = inferFeederOriginName(tripStops, context);
  if (!originName || !stops[0]) return stops;
  const first = stops[0];
  const position = Number(first.position);
  const inferredOrigin = {
    ...first,
    stopUid: [
      "inferred-origin",
      tripKey.routeId,
      tripKey.directionCode,
      tripKey.dayMask,
      tripKey.tripCode,
      tripKey.variantCode
    ].filter(Boolean).join(":"),
    name: originName,
    position: Number.isFinite(position) ? position - 0.5 : 0,
    inferredOrigin: true,
    timelineOnly: true,
    timelineOnlyKind: "start"
  };
  return [inferredOrigin, ...stops.slice(1)];
}

function markExtraBoundaryStopsForTimeline(tripStops = [], context = {}) {
  const originPosition = Number(context.originPosition);
  const destinationPosition = Number(context.destinationPosition);
  const hasOrigin = Number.isFinite(originPosition);
  const hasDestination = Number.isFinite(destinationPosition);
  if (!hasOrigin && !hasDestination) return tripStops;

  return (tripStops || []).map((stop) => {
    const position = Number(stop.position);
    const beforeMainOrigin = hasOrigin && Number.isFinite(position) && position < originPosition;
    const afterMainDestination = hasDestination && Number.isFinite(position) && position > destinationPosition;
    if (!beforeMainOrigin && !afterMainDestination) return stop;
    return {
      ...stop,
      timelineOnly: true,
      timelineOnlyKind: beforeMainOrigin ? "start" : "end"
    };
  });
}

function compactVariantStopNames(stops) {
  const meaningful = stops.filter((name) => !isMinorVariantStopName(name));
  const source = meaningful.length ? meaningful : stops;
  return source.slice(0, 2);
}

function isMinorVariantStopName(name) {
  return /^(ул\.|улица|пер\.|переулок|пр-т|проспект)\s+/i.test(String(name || "").trim());
}

function formatStopList(stops) {
  if (stops.length <= 1) return stops[0] || "";
  return `${stops.slice(0, -1).join(", ")} и ${stops[stops.length - 1]}`;
}

function getTripTimeline({ routeId, directionCode, dayMask, tripCode, variantCode }) {
  if (!routeId || !directionCode || !dayMask || !tripCode || !variantCode) return [];

  const db = getDb();
  const context = buildDirectionVariantContext(db, routeId, directionCode);
  const tripStops = getTripStopsWithLinkedSegments(db, routeId, directionCode, dayMask, tripCode, variantCode);
  const timeline = tripStopsForTimeline(tripStops, context, { routeId, directionCode, dayMask, tripCode, variantCode })
    .map((stop) => ({
      stopUid: stop.stopUid,
      stopName: stop.name,
      position: stop.position,
      time: stop.time,
      arrivalTime: stop.arrivalTime,
      inferredOrigin: Boolean(stop.inferredOrigin),
      timelineOnly: Boolean(stop.timelineOnly),
      timelineOnlyKind: stop.timelineOnlyKind || ""
    }));

  const last = timeline[timeline.length - 1];
  if (last && stopNamesMatch(last.stopName, context.destinationName || "")) {
    last.stopName = context.destinationName || last.stopName;
  }
  if (last && shouldUseDeclaredDestination(last.stopName, { name: last.stopName, position: last.position }, context)) {
    const declaredStop = findStopByNameKey(context.stopsByName, normalizeStopKey(context.destinationName || ""));
    const alreadyShown = timeline.some((item) => stopNamesMatch(item.stopName, context.destinationName || ""));
    if (declaredStop && !alreadyShown) {
      timeline.push({
        stopUid: declaredStop.stopUid,
        stopName: declaredStop.name,
        position: declaredStop.position,
        time: "",
        arrivalTime: "",
        inferred: true
      });
    }
  }

  return timeline;
}

function listAdminDepartures({ routeId, directionCode, stopUid }) {
  if (!routeId || !directionCode || !stopUid) return [];

  const rows = getDb()
    .prepare(`
      SELECT departure_id AS id, route_id AS routeId, direction_code AS directionCode,
             stop_uid AS stopUid, day_mask AS dayMask, day_name AS dayName,
             departure_time AS time, departure_minutes AS minutes, arrival_time AS arrivalTime,
             trip_code AS tripCode, variant_code AS variantCode, notes
      FROM departures
      WHERE route_id = ? AND direction_code = ? AND stop_uid = ?
      ORDER BY day_mask, departure_minutes, departure_id
    `)
    .all(routeId, directionCode, stopUid);
  return deduplicateDepartureRecords(rows);
}

function deduplicateDepartureRecords(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [
      row.routeId,
      row.directionCode,
      row.stopUid,
      row.dayMask,
      row.time,
      row.arrivalTime || "",
      row.tripCode || "",
      row.variantCode || "",
      row.notes || ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function saveDeparture(input, actor = "admin") {
  const db = getDb();
  const id = Number(input.id || input.departureId || 0);
  const routeId = sanitizeText(input.routeId || "", 80);
  const directionCode = sanitizeText(input.directionCode || "", 40);
  const stopUid = sanitizeText(input.stopUid || "", 160);
  const dayMask = normalizeDayMask(input.dayMask || "1111100");
  const time = normalizeTime(input.time || input.departureTime);
  const arrivalTime = input.arrivalTime ? normalizeTime(input.arrivalTime) : "";
  const notes = sanitizeText(input.notes || "", 500);
  const applyToTrip = input.applyToTrip === true || input.applyToTrip === "true" || input.applyToTrip === "on";

  if (!time) throw httpError("Укажите время отправления.", 400);
  const minutes = minutesFromTime(time);

  if (id) {
    const existing = getDeparture(id);
    if (!existing) throw httpError("Время не найдено.", 404);

    if (applyToTrip && existing.tripCode && existing.variantCode) {
      const delta = minutes - existing.minutes;
      const tripBefore = listTripDepartures(existing);
      const rows = tripBefore.map((row) => ({ id: row.id, minutes: row.minutes }));
      const update = db.prepare(`
        UPDATE departures
        SET day_mask = ?, day_name = ?, departure_time = ?, departure_minutes = ?, notes = ?
        WHERE departure_id = ?
      `);
      // Shift every departure of the trip atomically: a crash mid-loop must not
      // leave the trip half-shifted.
      db.exec("BEGIN IMMEDIATE");
      try {
        rows.forEach((row) => {
          const nextMinutes = wrapDayMinutes(row.minutes + delta);
          update.run(dayMask, dayNameFromMask(dayMask), timeFromMinutes(nextMinutes), nextMinutes, notes, row.id);
        });
        const tripAfter = listTripDepartures({ ...existing, dayMask });
        logScheduleAudit(db, {
          action: "update_trip",
          entityType: "departure_trip",
          entityId: `${existing.tripCode}:${existing.variantCode}`,
          routeId: existing.routeId,
          directionCode: existing.directionCode,
          stopUid: existing.stopUid,
          before: tripBefore,
          after: tripAfter,
          actor
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      db.prepare(`
        UPDATE departures
        SET day_mask = ?, day_name = ?, departure_time = ?, departure_minutes = ?, arrival_time = ?, notes = ?
        WHERE departure_id = ?
      `).run(dayMask, dayNameFromMask(dayMask), time, minutes, arrivalTime, notes, id);
      logScheduleAudit(db, {
        action: "update",
        entityType: "departure",
        entityId: String(id),
        routeId: existing.routeId,
        directionCode: existing.directionCode,
        stopUid: existing.stopUid,
        before: existing,
        after: getDeparture(id),
        actor
      });
    }

    invalidateScheduleCache();
    return getDeparture(id);
  }

  if (!routeId || !directionCode || !stopUid) throw httpError("Выберите маршрут, направление и остановку.", 400);
  const stop = db.prepare("SELECT stop_uid FROM stops WHERE stop_uid = ? AND route_id = ? AND direction_code = ?").get(stopUid, routeId, directionCode);
  if (!stop) throw httpError("Остановка не найдена в выбранном направлении.", 404);

  const tripCode = sanitizeText(input.tripCode || `manual-${createId()}`, 80);
  const variantCode = sanitizeText(input.variantCode || "manual", 80);
  const duplicate = db.prepare(`
    SELECT departure_id AS id
    FROM departures
    WHERE route_id = ? AND direction_code = ? AND stop_uid = ?
      AND day_mask = ? AND departure_time = ?
      AND COALESCE(arrival_time, '') = ?
      AND (? = '' OR COALESCE(trip_code, '') = ?)
      AND (? = '' OR COALESCE(variant_code, '') = ?)
    LIMIT 1
  `).get(
    routeId,
    directionCode,
    stopUid,
    dayMask,
    time,
    arrivalTime,
    input.tripCode ? tripCode : "",
    tripCode,
    input.variantCode ? variantCode : "",
    variantCode
  );
  if (duplicate) throw httpError("Duplicate departure already exists in the schedule.", 409);
  db.prepare(`
    INSERT INTO departures (
      route_id, direction_code, stop_uid, day_mask, day_name,
      departure_time, departure_minutes, arrival_time, trip_code, variant_code, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(routeId, directionCode, stopUid, dayMask, dayNameFromMask(dayMask), time, minutes, arrivalTime, tripCode, variantCode, notes);

  invalidateScheduleCache();
  const created = db.prepare("SELECT last_insert_rowid() AS id").get().id;
  const departure = getDeparture(created);
  logScheduleAudit(db, {
    action: "create",
    entityType: "departure",
    entityId: String(created),
    routeId,
    directionCode,
    stopUid,
    before: null,
    after: departure,
    actor
  });
  return departure;
}

function deleteDeparture(id, { applyToTrip = false, actor = "admin" } = {}) {
  const db = getDb();
  const existing = getDeparture(id);
  if (!existing) throw httpError("Время не найдено.", 404);

  if (applyToTrip && existing.tripCode && existing.variantCode) {
    const tripBefore = listTripDepartures(existing);
    db.prepare(`
      DELETE FROM departures
      WHERE route_id = ? AND direction_code = ? AND day_mask = ? AND trip_code = ? AND variant_code = ?
    `).run(existing.routeId, existing.directionCode, existing.dayMask, existing.tripCode, existing.variantCode);
    logScheduleAudit(db, {
      action: "delete_trip",
      entityType: "departure_trip",
      entityId: `${existing.tripCode}:${existing.variantCode}`,
      routeId: existing.routeId,
      directionCode: existing.directionCode,
      stopUid: existing.stopUid,
      before: tripBefore,
      after: null,
      actor
    });
  } else {
    db.prepare("DELETE FROM departures WHERE departure_id = ?").run(existing.id);
    logScheduleAudit(db, {
      action: "delete",
      entityType: "departure",
      entityId: String(existing.id),
      routeId: existing.routeId,
      directionCode: existing.directionCode,
      stopUid: existing.stopUid,
      before: existing,
      after: null,
      actor
    });
  }

  invalidateScheduleCache();
  return { ok: true };
}

function updateScheduleMeta(input, actor = "admin") {
  const db = getDb();
  const routeId = sanitizeText(input.routeId || "", 80);
  const directionCode = sanitizeText(input.directionCode || "", 40);
  const stopUid = sanitizeText(input.stopUid || "", 160);
  if (!routeId) throw httpError("Выберите маршрут.", 400);

  const routeName = sanitizeText(input.routeName || input.name || "", 180);
  const color = sanitizeText(input.color || "", 20);
  const origin = sanitizeText(input.origin || "", 160);
  const destination = sanitizeText(input.destination || "", 160);
  const directionName = sanitizeText(input.directionName || (origin && destination ? `${origin} → ${destination}` : ""), 220);
  const stopName = sanitizeText(input.stopName || "", 160);
  const now = new Date().toISOString();
  const before = getScheduleMetaSnapshot({ routeId, directionCode, stopUid });

  // Route/direction/stop metadata is updated together; partial failure must not
  // leave inconsistent labels, so all writes share one transaction.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (routeName || color) {
      const route = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(routeId);
      if (!route) throw httpError("Маршрут не найден.", 404);
      db.prepare(`
        UPDATE routes
        SET name = COALESCE(NULLIF(?, ''), name),
            raw_name = COALESCE(NULLIF(?, ''), raw_name),
            color = COALESCE(NULLIF(?, ''), color),
            updated_at = ?
        WHERE route_id = ?
      `).run(routeName, routeName, color, now, routeId);
    }

    if (directionCode && (origin || destination || directionName)) {
      db.prepare(`
        UPDATE directions
        SET origin = COALESCE(NULLIF(?, ''), origin),
            destination = COALESCE(NULLIF(?, ''), destination),
            name = COALESCE(NULLIF(?, ''), name)
        WHERE route_id = ? AND direction_code = ?
      `).run(origin, destination, directionName, routeId, directionCode);
    }

    if (stopUid && stopName) {
      db.prepare("UPDATE stops SET name = ?, normalized_name = ? WHERE stop_uid = ?")
        .run(stopName, normalizeName(stopName), stopUid);
    }

    logScheduleAudit(db, {
      action: "update_meta",
      entityType: "schedule_meta",
      entityId: routeId,
      routeId,
      directionCode,
      stopUid,
      before,
      after: getScheduleMetaSnapshot({ routeId, directionCode, stopUid }),
      actor
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  invalidateScheduleCache();
  return { ok: true, routes: listRoutes() };
}

function listScheduleAudit(limit = 80) {
  const rows = getDb()
    .prepare(`
      SELECT audit_id AS id, action, entity_type AS entityType, entity_id AS entityId,
             route_id AS routeId, direction_code AS directionCode, stop_uid AS stopUid,
             before_json AS beforeJson, after_json AS afterJson, actor, created_at AS createdAt
      FROM schedule_audit
      ORDER BY created_at DESC, audit_id DESC
      LIMIT ?
    `)
    .all(Math.min(Math.max(Number(limit) || 80, 1), 200));

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    routeId: row.routeId,
    directionCode: row.directionCode,
    stopUid: row.stopUid,
    before: parseJson(row.beforeJson),
    after: parseJson(row.afterJson),
    actor: row.actor,
    createdAt: row.createdAt
  }));
}

function deleteScheduleAudit(id) {
  const auditId = Number(id || 0);
  if (!auditId) throw httpError("Запись журнала не найдена.", 404);
  const result = getDb().prepare("DELETE FROM schedule_audit WHERE audit_id = ?").run(auditId);
  if (!result.changes) throw httpError("Запись журнала не найдена.", 404);
  return { ok: true, deleted: result.changes };
}

function clearScheduleAudit() {
  const result = getDb().prepare("DELETE FROM schedule_audit").run();
  return { ok: true, deleted: result.changes };
}

function createScheduleBackup(input = {}, db = getDb()) {
  const now = new Date().toISOString();
  const snapshot = {
    routes: db.prepare("SELECT * FROM routes ORDER BY CAST(number AS INTEGER), number").all(),
    directions: db.prepare("SELECT * FROM directions ORDER BY route_id, position").all(),
    stops: db.prepare("SELECT * FROM stops ORDER BY route_id, direction_code, position").all(),
    departures: db.prepare("SELECT * FROM departures ORDER BY departure_id").all()
  };
  const backup = {
    id: createId(),
    label: sanitizeText(input.label || "Перед импортом XML", 160),
    actor: sanitizeText(input.actor || "admin", 120),
    createdAt: now,
    routeCount: snapshot.routes.length,
    stopCount: snapshot.stops.length,
    departureCount: snapshot.departures.length,
    payload: zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"))
  };

  db.prepare(`
    INSERT INTO schedule_backups (backup_id, label, created_by, created_at, route_count, stop_count, departure_count, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    backup.id,
    backup.label,
    backup.actor,
    backup.createdAt,
    backup.routeCount,
    backup.stopCount,
    backup.departureCount,
    backup.payload
  );

  pruneScheduleBackups(db);

  return {
    id: backup.id,
    label: backup.label,
    createdBy: backup.actor,
    createdAt: backup.createdAt,
    routeCount: backup.routeCount,
    stopCount: backup.stopCount,
    departureCount: backup.departureCount
  };
}

function listScheduleBackups(limit = 10) {
  cleanupScheduleMaintenanceRecords();
  return getDb()
    .prepare(`
      SELECT backup_id AS id, label, created_by AS createdBy, created_at AS createdAt,
             route_count AS routeCount, stop_count AS stopCount, departure_count AS departureCount
      FROM schedule_backups
      ORDER BY created_at DESC, backup_id DESC
      LIMIT ?
    `)
    .all(Math.max(1, Math.min(Number(limit) || 10, 30)));
}

function restoreScheduleBackup(id, actor = "admin") {
  const db = getDb();
  const backup = db
    .prepare(`
      SELECT backup_id AS id, label, created_by AS createdBy, created_at AS createdAt,
             route_count AS routeCount, stop_count AS stopCount, departure_count AS departureCount, payload
      FROM schedule_backups
      WHERE backup_id = ?
    `)
    .get(String(id || ""));
  if (!backup) throw httpError("Резервная копия расписания не найдена.", 404);

  const snapshot = JSON.parse(zlib.gunzipSync(Buffer.from(backup.payload)).toString("utf8"));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM routes");

    const insertRoute = db.prepare(`
      INSERT INTO routes (route_id, number, name, raw_name, transport_type, color, date_start, date_exp, source_file, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDirection = db.prepare(`
      INSERT INTO directions (direction_id, route_id, direction_code, name, origin, destination, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertStop = db.prepare(`
      INSERT INTO stops (stop_uid, route_id, direction_code, export_stop_id, name, normalized_name, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDeparture = db.prepare(`
      INSERT INTO departures (
        departure_id, route_id, direction_code, stop_uid, day_mask, day_name, departure_time, departure_minutes,
        arrival_time, trip_code, variant_code, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    (snapshot.routes || []).forEach((item) => {
      insertRoute.run(
        item.route_id,
        item.number,
        item.name,
        item.raw_name,
        item.transport_type,
        item.color,
        item.date_start,
        item.date_exp,
        item.source_file,
        item.updated_at
      );
    });
    (snapshot.directions || []).forEach((item) => {
      insertDirection.run(item.direction_id, item.route_id, item.direction_code, item.name, item.origin, item.destination, item.position);
    });
    (snapshot.stops || []).forEach((item) => {
      insertStop.run(item.stop_uid, item.route_id, item.direction_code, item.export_stop_id, item.name, item.normalized_name, item.position);
    });
    (snapshot.departures || []).forEach((item) => {
      insertDeparture.run(
        item.departure_id,
        item.route_id,
        item.direction_code,
        item.stop_uid,
        item.day_mask,
        item.day_name,
        item.departure_time,
        item.departure_minutes,
        item.arrival_time,
        item.trip_code,
        item.variant_code,
        item.notes
      );
    });

    logScheduleAudit(db, {
      action: "rollback_import",
      entityType: "schedule_backup",
      entityId: backup.id,
      after: {
        backupId: backup.id,
        createdAt: backup.createdAt,
        routes: backup.routeCount,
        stops: backup.stopCount,
        departures: backup.departureCount
      },
      actor
    });

    db.exec("COMMIT");
    invalidateScheduleCache();

    return {
      ok: true,
      backup: {
        id: backup.id,
        label: backup.label,
        createdBy: backup.createdBy,
        createdAt: backup.createdAt,
        routeCount: backup.routeCount,
        stopCount: backup.stopCount,
        departureCount: backup.departureCount
      }
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function pruneScheduleBackups(db) {
  const ids = db
    .prepare("SELECT backup_id AS id FROM schedule_backups ORDER BY created_at DESC, backup_id DESC LIMIT -1 OFFSET 10")
    .all()
    .map((item) => item.id);
  if (!ids.length) return;
  const remove = db.prepare("DELETE FROM schedule_backups WHERE backup_id = ?");
  ids.forEach((id) => remove.run(id));
}

function cleanupScheduleMaintenanceRecords(options = {}) {
  const db = options.db || getDb();
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoff = options.cutoff || new Date(now.getTime() - SCHEDULE_CLEANUP_RETENTION_MS).toISOString();

  const backups = db.prepare("DELETE FROM schedule_backups WHERE created_at < ?").run(cutoff).changes;
  const scheduledImports = db
    .prepare(`
      DELETE FROM scheduled_route_imports
      WHERE status IN ('applied', 'cancelled', 'failed')
        AND COALESCE(closed_at, applied_at, created_at) < ?
    `)
    .run(cutoff).changes;

  return {
    ok: true,
    retentionHours: 24,
    cutoff,
    backups,
    scheduledImports,
    ...purgeOldOperationalRecords(db, now)
  };
}

// Unbounded-growth guards: visits and finished reminders were never deleted.
function purgeOldOperationalRecords(db, now = new Date()) {
  const visitCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const reminderCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const visits = db.prepare("DELETE FROM site_visits WHERE visited_on < ?").run(visitCutoff).changes;
  const reminders = db
    .prepare("DELETE FROM reminders WHERE status IN ('sent', 'failed', 'cancelled', 'changed') AND COALESCE(sent_at, created_at) < ?")
    .run(reminderCutoff).changes;
  if (visits) invalidateStatsCache();
  return { visits, reminders };
}

function createScheduledRouteImport(input = {}, db = getDb()) {
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw httpError("Выберите XML-файл для отложенной замены маршрута.", 400);

  const routeNumber = sanitizeText(input.routeNumber || "", 32);
  if (!routeNumber) throw httpError("Выберите маршрут, который нужно заменить.", 400);

  const effectiveDate = new Date(input.effectiveAt || "");
  if (Number.isNaN(effectiveDate.getTime())) throw httpError("Укажите дату и время начала нового расписания.", 400);
  if (effectiveDate.getTime() <= Date.now()) {
    throw httpError("Для отложенной замены выберите будущую дату. Если нужно применить сейчас, оставьте дату пустой.", 400);
  }

  const now = new Date().toISOString();
  const item = {
    id: createId(),
    routeId: sanitizeText(input.routeId || "", 80),
    routeNumber,
    routeName: sanitizeText(input.routeName || "", 180),
    mode: input.mode === "replace_all" ? "replace_all" : "upsert",
    status: "pending",
    effectiveAt: effectiveDate.toISOString(),
    fileCount: files.length,
    summary: input.summary || null,
    createdBy: sanitizeText(input.createdBy || "admin", 120),
    createdAt: now,
    filesPayload: zlib.gzipSync(Buffer.from(JSON.stringify(files), "utf8"))
  };

  db.prepare(`
    INSERT INTO scheduled_route_imports (
      import_id, route_id, route_number, route_name, mode, status, effective_at,
      files_payload, file_count, summary_json, created_by, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.routeId,
    item.routeNumber,
    item.routeName,
    item.mode,
    item.status,
    item.effectiveAt,
    item.filesPayload,
    item.fileCount,
    JSON.stringify(item.summary || null),
    item.createdBy,
    item.createdAt
  );

  logScheduleAudit(db, {
    action: "schedule_xml_import",
    entityType: "scheduled_route_import",
    entityId: item.id,
    routeId: item.routeId,
    after: {
      routeNumber: item.routeNumber,
      routeName: item.routeName,
      effectiveAt: item.effectiveAt,
      files: item.fileCount,
      status: item.status
    },
    actor: item.createdBy
  });

  return scheduledRouteImportRow({
    import_id: item.id,
    route_id: item.routeId,
    route_number: item.routeNumber,
    route_name: item.routeName,
    mode: item.mode,
    status: item.status,
    effective_at: item.effectiveAt,
    file_count: item.fileCount,
    summary_json: JSON.stringify(item.summary || null),
    created_by: item.createdBy,
    created_at: item.createdAt
  });
}

function listScheduledRouteImports(limit = 30) {
  cleanupScheduleMaintenanceRecords();
  return getDb()
    .prepare(`
      SELECT import_id, route_id, route_number, route_name, mode, status, effective_at,
             file_count, summary_json, created_by, created_at, applied_at, applied_batch_id, error, closed_at
      FROM scheduled_route_imports
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'applying' THEN 1 WHEN 'failed' THEN 2 WHEN 'applied' THEN 3 ELSE 4 END,
        datetime(effective_at) ASC,
        datetime(created_at) DESC
      LIMIT ?
    `)
    .all(Math.max(1, Math.min(Number(limit) || 30, 80)))
    .map(scheduledRouteImportRow);
}

function listDueScheduledRouteImports(limit = 5) {
  return getDb()
    .prepare(`
      SELECT import_id, route_id, route_number, route_name, mode, status, effective_at,
             files_payload, file_count, summary_json, created_by, created_at, applied_at, applied_batch_id, error
      FROM scheduled_route_imports
      WHERE status = 'pending' AND datetime(effective_at) <= datetime('now')
      ORDER BY datetime(effective_at) ASC
      LIMIT ?
    `)
    .all(Math.max(1, Math.min(Number(limit) || 5, 20)))
    .map(scheduledRouteImportRowWithFiles);
}

function recoverStaleScheduledRouteImports(maxAgeMinutes = 30) {
  const db = getDb();
  const minutes = Math.max(5, Math.min(Number(maxAgeMinutes) || 30, 240));
  const result = db.prepare(`
    UPDATE scheduled_route_imports
    SET status = 'pending', error = ?
    WHERE status = 'applying'
      AND datetime(effective_at) <= datetime('now', ?)
  `).run(`Автоматически восстановлено после зависшего применения XML старше ${minutes} мин.`, `-${minutes} minutes`);

  return { ok: true, recovered: result.changes };
}

function claimScheduledRouteImport(id) {
  const db = getDb();
  const result = db
    .prepare("UPDATE scheduled_route_imports SET status = 'applying', error = NULL WHERE import_id = ? AND status = 'pending'")
    .run(String(id || ""));
  return result.changes > 0;
}

function completeScheduledRouteImport(id, result = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_route_imports
    SET status = 'applied', applied_at = ?, closed_at = ?, applied_batch_id = ?, error = NULL
    WHERE import_id = ?
  `).run(now, now, sanitizeText(result.batchId || "", 120), String(id || ""));
  logScheduleAudit(db, {
    action: "apply_scheduled_xml_import",
    entityType: "scheduled_route_import",
    entityId: id,
    routeId: result.routeId || "",
    after: {
      batchId: result.batchId,
      routes: result.routes,
      stops: result.stops,
      departures: result.departures,
      importedRoutes: result.importedRoutes,
      importedStops: result.importedStops,
      importedDepartures: result.importedDepartures
    },
    actor: result.actor || "system"
  });
  return { ok: true };
}

function failScheduledRouteImport(id, error, actor = "system") {
  const db = getDb();
  const now = new Date().toISOString();
  const message = sanitizeText(error?.message || error || "Не удалось применить отложенный импорт.", 500);
  db.prepare(`
    UPDATE scheduled_route_imports
    SET status = 'failed', error = ?, closed_at = ?
    WHERE import_id = ?
  `).run(message, now, String(id || ""));
  logScheduleAudit(db, {
    action: "fail_scheduled_xml_import",
    entityType: "scheduled_route_import",
    entityId: id,
    after: { error: message },
    actor
  });
  return { ok: true, error: message };
}

function cancelScheduledRouteImport(id, actor = "admin") {
  const db = getDb();
  const now = new Date().toISOString();
  const item = db
    .prepare("SELECT import_id, route_id, route_number, route_name, status, effective_at FROM scheduled_route_imports WHERE import_id = ?")
    .get(String(id || ""));
  if (!item) throw httpError("Отложенная замена маршрута не найдена.", 404);
  if (item.status !== "pending") throw httpError("Можно отменить только ожидающую замену.", 400);

  db.prepare("UPDATE scheduled_route_imports SET status = 'cancelled', closed_at = ? WHERE import_id = ?").run(now, item.import_id);
  logScheduleAudit(db, {
    action: "cancel_scheduled_xml_import",
    entityType: "scheduled_route_import",
    entityId: item.import_id,
    routeId: item.route_id,
    after: {
      routeNumber: item.route_number,
      routeName: item.route_name,
      effectiveAt: item.effective_at,
      status: "cancelled"
    },
    actor
  });
  return { ok: true, id: item.import_id };
}

function scheduledRouteImportRow(row) {
  return {
    id: row.import_id,
    routeId: row.route_id,
    routeNumber: row.route_number,
    routeName: row.route_name,
    mode: row.mode,
    status: row.status,
    effectiveAt: row.effective_at,
    fileCount: row.file_count,
    summary: parseJson(row.summary_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    appliedBatchId: row.applied_batch_id,
    closedAt: row.closed_at,
    error: row.error
  };
}

function scheduledRouteImportRowWithFiles(row) {
  const item = scheduledRouteImportRow(row);
  try {
    item.files = JSON.parse(zlib.gunzipSync(Buffer.from(row.files_payload)).toString("utf8"));
  } catch {
    item.files = [];
  }
  return item;
}

function stopSearchNeedles(query) {
  const normalized = normalizeName(query);
  if (!normalized) return [];

  const needles = [];
  const add = (value) => {
    const item = normalizeName(value);
    if (item && !needles.includes(item)) needles.push(item);
  };

  add(normalized);

  if (/(^|\s)\u0434\u0435\u0434\u0430\u0440/.test(normalized)) {
    add("\u0434\u0434\u043c");
  }
  if (/^(?:\u0442\u0434|td)\s+/i.test(normalized)) {
    add(normalized.replace(/^(?:\u0442\u0434|td)\s+/i, "\u0442\u043e\u0440\u0433\u043e\u0432\u044b\u0439 \u0434\u043e\u043c "));
  }

  return needles;
}

function searchStops(query, limit = 40) {
  const db = getDb();
  const needles = stopSearchNeedles(query);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 100));
  const whereSql = needles.length
    ? `WHERE ${needles.map(() => "normalized_name LIKE ? ESCAPE '\\'").join(" OR ")}`
    : "";
  const params = needles.length ? [...needles.map((item) => `%${escapeLikePattern(item)}%`), safeLimit] : [safeLimit];

  return db
    .prepare(`
      SELECT normalized_name AS normalizedName, MIN(name) AS name, COUNT(DISTINCT route_id) AS routeCount
      FROM stops
      ${whereSql}
      GROUP BY normalized_name
      ORDER BY name
      LIMIT ?
    `)
    .all(...params)
    .map((row) => ({ name: row.name, routeCount: row.routeCount }));
}

function getStopBoard(stopName) {
  const db = getDb();
  const normalized = normalizeName(stopName);
  if (!normalized) return [];

  return db
    .prepare(`
      SELECT DISTINCT r.route_id AS routeId, r.number, r.name AS routeName, r.color,
             d.direction_code AS directionCode, d.name AS directionName, d.destination,
             s.stop_uid AS stopUid, s.name AS stopName,
             dep.day_mask AS dayMask, dep.day_name AS dayName, dep.departure_time AS time,
             dep.departure_minutes AS minutes
      FROM stops s
      JOIN routes r ON r.route_id = s.route_id
      JOIN directions d ON d.route_id = s.route_id AND d.direction_code = s.direction_code
      JOIN departures dep ON dep.stop_uid = s.stop_uid
      WHERE s.normalized_name = ?
      ORDER BY CAST(r.number AS INTEGER), r.number, d.position, dep.day_mask, dep.departure_minutes
      LIMIT 2000
    `)
    .all(normalized);
}

function routeSearchStopCandidates(query, limit = 12) {
  const db = getDb();
  const needles = stopSearchNeedles(query);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 24));
  if (!needles.length) return [];

  const exactPlaceholders = needles.map(() => "?").join(", ");
  const exact = db
    .prepare(`
      SELECT normalized_name AS normalizedName, MIN(name) AS name, COUNT(DISTINCT route_id) AS routeCount
      FROM stops
      WHERE normalized_name IN (${exactPlaceholders})
      GROUP BY normalized_name
      ORDER BY routeCount DESC, name
      LIMIT ?
    `)
    .all(...needles, safeLimit);
  if (exact.length) return exact.map((row) => ({ name: row.name, normalizedName: row.normalizedName, routeCount: row.routeCount }));

  // Substring fallback only for needles of 2+ chars: a single common letter would
  // match the 12 busiest stops and feed a 12x12 self-join — a cheap unauthenticated
  // way to burn 100-400ms of synchronous CPU per request (DoS vector).
  const likeNeedles = needles.filter((item) => item.length >= 2);
  if (!likeNeedles.length) return [];

  const likeSql = likeNeedles.map(() => "normalized_name LIKE ? ESCAPE '\\'").join(" OR ");
  return db
    .prepare(`
      SELECT normalized_name AS normalizedName, MIN(name) AS name, COUNT(DISTINCT route_id) AS routeCount
      FROM stops
      WHERE ${likeSql}
      GROUP BY normalized_name
      ORDER BY routeCount DESC, name
      LIMIT ?
    `)
    .all(...likeNeedles.map((item) => `%${escapeLikePattern(item)}%`), safeLimit)
    .map((row) => ({ name: row.name, normalizedName: row.normalizedName, routeCount: row.routeCount }));
}

function searchRoutesBetweenStops(input = {}) {
  const fromQuery = sanitizeText(input.from || input.fromStop || "", 160);
  const toQuery = sanitizeText(input.to || input.toStop || "", 160);
  if (!fromQuery || !toQuery) throw httpError("Choose origin and destination stops.", 400);

  const serviceDate = parseRouteSearchDate(input.date);
  const startTime = parseRouteSearchTime(input.time);
  const startMinutes = minutesFromTime(startTime);
  const limit = Math.max(1, Math.min(Number(input.limit) || 4, 4));
  const fromMatches = routeSearchStopCandidates(fromQuery);
  const toMatches = routeSearchStopCandidates(toQuery);

  if (!fromMatches.length || !toMatches.length) {
    return {
      query: { from: fromQuery, to: toQuery, date: toLocalDateOnly(serviceDate), time: startTime },
      fromMatches,
      toMatches,
      results: []
    };
  }

  const rows = routeSearchRows(fromMatches, toMatches);
  const results = [];
  const seen = new Set();

  for (let offset = 0; offset <= 7 && results.length < limit * 20; offset += 1) {
    const date = addLocalDays(serviceDate, offset);
    rows.forEach((row) => {
      if (!dayMaskIncludesServiceDate(row.dayMask, date)) return;

      const fromMinutes = Number(row.departureMinutes);
      const arrivalMinutes = carriedArrivalMinutes(fromMinutes, Number(row.arrivalMinutes));
      if (!Number.isFinite(fromMinutes) || !Number.isFinite(arrivalMinutes)) return;
      if (arrivalMinutes < fromMinutes) return;

      const absoluteDeparture = offset * 1440 + fromMinutes;
      if (absoluteDeparture < startMinutes) return;

      const departureDate = addLocalMinutes(date, fromMinutes);
      const arrivalDate = addLocalMinutes(date, arrivalMinutes);
      const waitMinutes = absoluteDeparture - startMinutes;
      const durationMinutes = Math.max(0, arrivalMinutes - fromMinutes);
      const key = [
        row.routeId,
        row.directionCode,
        row.fromStopUid,
        row.toStopUid,
        row.dayMask,
        row.tripCode || "",
        row.variantCode || "",
        toLocalDateOnly(departureDate),
        row.departureTime
      ].join("|");
      if (seen.has(key)) return;
      seen.add(key);

      results.push({
        routeId: row.routeId,
        routeNumber: row.number,
        routeName: row.routeName,
        transportType: row.transportType,
        color: row.color,
        directionCode: row.directionCode,
        directionName: row.directionName,
        directionFrom: row.directionFrom,
        directionTo: row.directionTo,
        fromStopUid: row.fromStopUid,
        fromStopName: row.fromStopName,
        toStopUid: row.toStopUid,
        toStopName: row.toStopName,
        dayMask: row.dayMask,
        dayName: row.dayName,
        tripCode: row.tripCode || "",
        variantCode: row.variantCode || "",
        departureTime: row.departureTime,
        arrivalTime: row.arrivalTime || timeFromMinutes(arrivalMinutes),
        serviceDate: toLocalDateOnly(date),
        departureDate: toLocalDateOnly(departureDate),
        arrivalDate: toLocalDateOnly(arrivalDate),
        departureAt: departureDate.toISOString(),
        arrivalAt: arrivalDate.toISOString(),
        waitMinutes,
        durationMinutes
      });
    });
  }

  results.sort((left, right) => {
    if (left.waitMinutes !== right.waitMinutes) return left.waitMinutes - right.waitMinutes;
    if (left.durationMinutes !== right.durationMinutes) return left.durationMinutes - right.durationMinutes;
    return routeNumberSortValue(left.routeNumber) - routeNumberSortValue(right.routeNumber);
  });
  const uniqueResults = [];
  const seenRoutes = new Set();
  for (const result of results) {
    if (uniqueResults.length && result.waitMinutes > 1440) continue;
    const key = normalizeName([
      result.transportType || "",
      result.routeNumber || result.routeId || "",
      result.fromStopName || "",
      result.toStopName || ""
    ].join("|"));
    if (seenRoutes.has(key)) continue;
    seenRoutes.add(key);
    uniqueResults.push(result);
    if (uniqueResults.length >= limit) break;
  }

  // One-transfer itinerary through a shared hub stop. Two triggers:
  // 1) no direct route at all;
  // 2) the nearest direct departure is far away (later service day / long wait) —
  //    a rider asking "how do I get there NOW" is better served by a transfer
  //    leaving today than by a direct bus on Monday (owner report 2026-07-11:
  //    ВЛКСМ→вокзал on Saturday offered only the weekday №5 two days out).
  // Transfer scan is cheap (6-26 ms), so the extra work on trigger 2 is fine.
  let transferResults = [];
  // Guard: overlapping origin/destination names would produce nonsense circular
  // itineraries (ride out, ride straight back on the return direction).
  const fromNameSet = new Set(fromMatches.map((item) => item.normalizedName));
  const overlapsOrigin = toMatches.some((item) => fromNameSet.has(item.normalizedName));
  const bestDirectWait = uniqueResults.length ? uniqueResults[0].waitMinutes : Infinity;
  if (!overlapsOrigin && bestDirectWait > TRANSFER_FALLBACK_DIRECT_WAIT_MINUTES) {
    try {
      transferResults = searchTransferRoutes(fromMatches, toMatches, serviceDate, startMinutes, Math.min(limit, 2))
        // Alongside a direct option a transfer must WIN on departure time,
        // otherwise it is noise (nobody transfers to leave later).
        .filter((item) => item.waitMinutes < bestDirectWait);
    } catch (error) {
      console.warn("Transfer search failed:", error.message || error);
    }
  }

  const mergedResults = transferResults.length
    ? [...transferResults, ...uniqueResults]
      .sort((left, right) =>
        left.waitMinutes - right.waitMinutes || left.durationMinutes - right.durationMinutes)
      .slice(0, Math.max(limit, 2))
    : uniqueResults;

  return {
    query: { from: fromQuery, to: toQuery, date: toLocalDateOnly(serviceDate), time: startTime },
    fromMatches,
    toMatches,
    results: mergedResults
  };
}

function routeSearchRows(fromMatches, toMatches) {
  const fromPlaceholders = fromMatches.map(() => "?").join(", ");
  const toPlaceholders = toMatches.map(() => "?").join(", ");
  const params = [
    ...fromMatches.map((item) => item.normalizedName),
    ...toMatches.map((item) => item.normalizedName)
  ];

  return getDb()
    .prepare(`
      SELECT DISTINCT r.route_id AS routeId, r.number, r.name AS routeName, r.transport_type AS transportType, r.color,
             d.direction_code AS directionCode, d.name AS directionName, d.origin AS directionFrom, d.destination AS directionTo,
             fs.stop_uid AS fromStopUid, fs.name AS fromStopName, fs.position AS fromPosition,
             ts.stop_uid AS toStopUid, ts.name AS toStopName, ts.position AS toPosition,
             fd.day_mask AS dayMask, fd.day_name AS dayName,
             fd.departure_time AS departureTime, fd.departure_minutes AS departureMinutes,
             td.departure_time AS arrivalTime, td.departure_minutes AS arrivalMinutes,
             fd.trip_code AS tripCode, fd.variant_code AS variantCode
      FROM stops fs
      JOIN stops ts
        ON ts.route_id = fs.route_id
       AND ts.direction_code = fs.direction_code
       AND ts.position > fs.position
      JOIN departures fd
        ON fd.route_id = fs.route_id
       AND fd.direction_code = fs.direction_code
       AND fd.stop_uid = fs.stop_uid
      JOIN departures td
        ON td.route_id = fd.route_id
       AND td.direction_code = fd.direction_code
       AND td.stop_uid = ts.stop_uid
       AND td.day_mask = fd.day_mask
       AND COALESCE(td.trip_code, '') = COALESCE(fd.trip_code, '')
       AND COALESCE(td.variant_code, '') = COALESCE(fd.variant_code, '')
      JOIN routes r ON r.route_id = fs.route_id
      JOIN directions d ON d.route_id = fs.route_id AND d.direction_code = fs.direction_code
      WHERE fs.normalized_name IN (${fromPlaceholders})
        AND ts.normalized_name IN (${toPlaceholders})
      ORDER BY CAST(r.number AS INTEGER), r.number, d.position, fd.day_mask, fd.departure_minutes
    `)
    .all(...params);
}

// Hub candidates for a one-transfer trip: stop names reachable FROM the origin
// (downstream on some route) intersected with stop names that can REACH the
// destination (upstream on some route). Pure topology — no departure scans —
// so both queries are cheap; ranking prefers stops served by more routes.
const TRANSFER_MIN_WAIT_MINUTES = 4;
// Suburban routes can run a handful of trips per day — a strict window would
// discard perfectly usable (if patient) connections; sorting still prefers short waits.
const TRANSFER_MAX_WAIT_MINUTES = 240;
const TRANSFER_HUB_LIMIT = 6;
// A direct departure further out than this still triggers the transfer scan:
// two hours covers "the direct bus is done for today / runs only on weekdays"
// without spamming transfers when a direct bus is genuinely near.
const TRANSFER_FALLBACK_DIRECT_WAIT_MINUTES = 120;

function transferHubCandidates(fromMatches, toMatches) {
  const db = getDb();
  const fromPlaceholders = fromMatches.map(() => "?").join(", ");
  const toPlaceholders = toMatches.map(() => "?").join(", ");

  const reachableFromOrigin = db
    .prepare(`
      SELECT ts.normalized_name AS normalizedName, MIN(ts.name) AS name, COUNT(DISTINCT ts.route_id) AS routeCount
      FROM stops fs
      JOIN stops ts
        ON ts.route_id = fs.route_id
       AND ts.direction_code = fs.direction_code
       AND ts.position > fs.position
      WHERE fs.normalized_name IN (${fromPlaceholders})
      GROUP BY ts.normalized_name
    `)
    .all(...fromMatches.map((item) => item.normalizedName));

  const reachingDestination = db
    .prepare(`
      SELECT fs.normalized_name AS normalizedName, MIN(fs.name) AS name, COUNT(DISTINCT fs.route_id) AS routeCount
      FROM stops fs
      JOIN stops ts
        ON ts.route_id = fs.route_id
       AND ts.direction_code = fs.direction_code
       AND ts.position > fs.position
      WHERE ts.normalized_name IN (${toPlaceholders})
      GROUP BY fs.normalized_name
    `)
    .all(...toMatches.map((item) => item.normalizedName));

  const excluded = new Set([
    ...fromMatches.map((item) => item.normalizedName),
    ...toMatches.map((item) => item.normalizedName)
  ]);
  const destinationByName = new Map(reachingDestination.map((item) => [item.normalizedName, item]));

  return reachableFromOrigin
    .filter((item) => destinationByName.has(item.normalizedName) && !excluded.has(item.normalizedName))
    .map((item) => ({
      normalizedName: item.normalizedName,
      name: item.name,
      score: item.routeCount + destinationByName.get(item.normalizedName).routeCount
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, TRANSFER_HUB_LIMIT);
}

function searchTransferRoutes(fromMatches, toMatches, serviceDate, startMinutes, limit = 2) {
  const hubs = transferHubCandidates(fromMatches, toMatches);
  if (!hubs.length) return [];

  const candidates = [];
  for (const hub of hubs) {
    const hubMatch = [{ normalizedName: hub.normalizedName, name: hub.name }];
    const rowsToHub = routeSearchRows(fromMatches, hubMatch);
    if (!rowsToHub.length) continue;
    const rowsFromHub = routeSearchRows(hubMatch, toMatches);
    if (!rowsFromHub.length) continue;

    // Same service day only (v1): scan the next few days like the direct search.
    for (let offset = 0; offset <= 7 && candidates.length < limit * 8; offset += 1) {
      const date = addLocalDays(serviceDate, offset);
      const dayStart = offset === 0 ? startMinutes : 0;

      const legs1 = rowsToHub
        .filter((row) => dayMaskIncludesServiceDate(row.dayMask, date))
        .map((row) => ({
          row,
          dep: Number(row.departureMinutes),
          arr: carriedArrivalMinutes(Number(row.departureMinutes), Number(row.arrivalMinutes))
        }))
        .filter((leg) => Number.isFinite(leg.dep) && Number.isFinite(leg.arr) && offset * 1440 + leg.dep >= dayStart)
        .sort((left, right) => left.arr - right.arr)
        .slice(0, 30);
      if (!legs1.length) continue;

      const legs2 = rowsFromHub
        .filter((row) => dayMaskIncludesServiceDate(row.dayMask, date))
        .map((row) => ({
          row,
          dep: Number(row.departureMinutes),
          arr: carriedArrivalMinutes(Number(row.departureMinutes), Number(row.arrivalMinutes))
        }))
        .filter((leg) => Number.isFinite(leg.dep) && Number.isFinite(leg.arr))
        .sort((left, right) => left.dep - right.dep);
      if (!legs2.length) continue;

      let best = null;
      for (const first of legs1) {
        const second = legs2.find((leg) =>
          leg.dep >= first.arr + TRANSFER_MIN_WAIT_MINUTES
          && leg.dep <= first.arr + TRANSFER_MAX_WAIT_MINUTES
          && !(leg.row.routeId === first.row.routeId && leg.row.directionCode === first.row.directionCode)
        );
        if (!second) continue;
        if (!best || second.arr < best.second.arr) best = { first, second };
      }
      if (!best) continue;

      const departureDate = addLocalMinutes(date, best.first.dep);
      const arrivalDate = addLocalMinutes(date, best.second.arr);
      const legFields = (leg) => ({
        routeId: leg.row.routeId,
        routeNumber: leg.row.number,
        routeName: leg.row.routeName,
        transportType: leg.row.transportType,
        color: leg.row.color,
        directionCode: leg.row.directionCode,
        directionName: leg.row.directionName,
        fromStopUid: leg.row.fromStopUid,
        fromStopName: leg.row.fromStopName,
        toStopUid: leg.row.toStopUid,
        toStopName: leg.row.toStopName,
        dayMask: leg.row.dayMask,
        tripCode: leg.row.tripCode || "",
        variantCode: leg.row.variantCode || "",
        departureTime: timeFromMinutes(leg.dep % 1440),
        arrivalTime: timeFromMinutes(leg.arr % 1440),
        serviceDate: toLocalDateOnly(date),
        // Arrival may roll past midnight; give the leg its true calendar date.
        arrivalDate: toLocalDateOnly(addLocalMinutes(date, leg.arr))
      });

      candidates.push({
        type: "transfer",
        legs: [legFields(best.first), legFields(best.second)],
        transferStopName: hub.name,
        transferWaitMinutes: best.second.dep - best.first.arr,
        // Top-level fields mirror direct results so shared UI keeps working.
        routeId: best.first.row.routeId,
        routeNumber: `${best.first.row.number}+${best.second.row.number}`,
        transportType: best.first.row.transportType,
        color: best.first.row.color,
        directionCode: best.first.row.directionCode,
        fromStopUid: best.first.row.fromStopUid,
        fromStopName: best.first.row.fromStopName,
        toStopUid: best.second.row.toStopUid,
        toStopName: best.second.row.toStopName,
        dayMask: best.first.row.dayMask,
        tripCode: best.first.row.tripCode || "",
        variantCode: best.first.row.variantCode || "",
        departureTime: timeFromMinutes(best.first.dep % 1440),
        arrivalTime: timeFromMinutes(best.second.arr % 1440),
        serviceDate: toLocalDateOnly(date),
        departureDate: toLocalDateOnly(departureDate),
        arrivalDate: toLocalDateOnly(arrivalDate),
        departureAt: departureDate.toISOString(),
        arrivalAt: arrivalDate.toISOString(),
        waitMinutes: offset * 1440 + best.first.dep - startMinutes,
        durationMinutes: Math.max(0, best.second.arr - best.first.dep)
      });
      break; // one best option per hub is enough
    }
  }

  candidates.sort((left, right) =>
    left.waitMinutes - right.waitMinutes || left.durationMinutes - right.durationMinutes
  );
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    // Same route pair with the same departure and arrival is the SAME trip to the
    // rider — the hub choice is an implementation detail (e.g. leave №12 one stop
    // earlier or later to catch the same №7). Hub deliberately NOT in the key;
    // alternatives only count when the times actually differ.
    const key = normalizeName([
      candidate.legs[0].routeNumber,
      candidate.legs[1].routeNumber,
      candidate.departureTime,
      candidate.arrivalTime
    ].join("|"));
    if (seen.has(key)) continue;

    // Отсев доминируемых по Парето: не показываем вариант, для которого уже
    // отобрана альтернатива с не более поздней отправкой И не более ранним
    // приездом (та же/раньше посадка, но приезжает не позже) — это просто
    // медленный дубль без выигрыша. depAbs/arrAbs — минуты от старта поиска,
    // с учётом переноса за полночь (waitMinutes уже несёт offset*1440).
    const depAbs = candidate.waitMinutes;
    const arrAbs = candidate.waitMinutes + candidate.durationMinutes;
    const dominated = unique.some((kept) => {
      const keptDep = kept.waitMinutes;
      const keptArr = kept.waitMinutes + kept.durationMinutes;
      return keptDep >= depAbs && keptArr <= arrAbs && (keptDep > depAbs || keptArr < arrAbs);
    });
    if (dominated) continue;

    seen.add(key);
    unique.push(candidate);
    if (unique.length >= limit) break;
  }
  return unique;
}

function parseRouteSearchDate(value) {
  const raw = sanitizeText(value || "", 16);
  if (!raw) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw httpError("Choose a valid date.", 400);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime()) || toLocalDateOnly(date) !== raw) throw httpError("Choose a valid date.", 400);
  return date;
}

function parseRouteSearchTime(value) {
  const raw = sanitizeText(value || "", 16);
  if (!raw) {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw httpError("Choose a valid time.", 400);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw httpError("Choose a valid time.", 400);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function carriedArrivalMinutes(fromMinutes, arrivalMinutes) {
  if (!Number.isFinite(arrivalMinutes)) return NaN;
  return arrivalMinutes < fromMinutes ? arrivalMinutes + 1440 : arrivalMinutes;
}

function addLocalMinutes(date, minutes) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setMinutes(minutes);
  return next;
}

function routeNumberSortValue(value) {
  const number = Number.parseInt(String(value || "").replace(/\D+/g, ""), 10);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function getStats() {
  const now = Date.now();
  if (statsCache.data && statsCache.expiresAt > now) return statsCache.data;
  purgeExpiredAppeals();

  const db = getDb();
  const one = (sql) => db.prepare(sql).get().count;
  const latestImport = db
    .prepare("SELECT * FROM import_batches ORDER BY imported_at DESC LIMIT 1")
    .get();

  const result = {
    routes: one("SELECT COUNT(*) AS count FROM routes"),
    stops: one("SELECT COUNT(*) AS count FROM stops"),
    departures: one("SELECT COUNT(*) AS count FROM departures"),
    appeals: one("SELECT COUNT(*) AS count FROM appeals"),
    subscribers: one("SELECT COUNT(*) AS count FROM notification_subscribers WHERE subscribed = 1"),
    subscribersToday: one("SELECT COUNT(*) AS count FROM notification_subscribers WHERE subscribed = 1 AND date(created_at, 'localtime') = date('now', 'localtime')"),
    visits: getVisitStats(db),
    latestImport: latestImport || null
  };
  statsCache = { expiresAt: now + CACHE_TTL_MS, data: result };
  return result;
}

function recordSiteVisit(input = {}) {
  const db = getDb();
  const now = new Date();
  const visitorHash = sanitizeText(input.visitorHash, 96);
  if (!visitorHash) return null;

  const visit = {
    id: createId(),
    visitedAt: now.toISOString(),
    visitedOn: toLocalDateOnly(now),
    path: sanitizeText(input.path || "/", 160) || "/",
    visitorHash,
    userAgent: sanitizeText(input.userAgent || "", 240)
  };

  db.prepare(`
    INSERT INTO site_visits (visit_id, visited_at, visited_on, path, visitor_hash, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(visit.id, visit.visitedAt, visit.visitedOn, visit.path, visit.visitorHash, visit.userAgent);

  // Keep cached visit totals fresh without forcing aggregate recounts on every public page hit.
  incrementCachedVisitStats(visit.visitedOn);
  return visit;
}

function getVisitStats(db = getDb()) {
  const now = new Date();
  const today = toLocalDateOnly(now);
  const last7Days = toLocalDateOnly(addLocalDays(now, -6));
  const last30Days = toLocalDateOnly(addLocalDays(now, -29));
  const countSince = (date) =>
    db.prepare("SELECT COUNT(*) AS count FROM site_visits WHERE visited_on >= ?").get(date).count;

  return {
    today: db.prepare("SELECT COUNT(*) AS count FROM site_visits WHERE visited_on = ?").get(today).count,
    week: countSince(last7Days),
    month: countSince(last30Days),
    todayDate: today,
    weekFrom: last7Days,
    monthFrom: last30Days
  };
}

function incrementCachedVisitStats(visitedOn) {
  const visits = statsCache.data?.visits;
  if (!visits || !visitedOn) return;
  if (visits.todayDate === visitedOn) visits.today += 1;
  if (!visits.weekFrom || visitedOn >= visits.weekFrom) visits.week += 1;
  if (!visits.monthFrom || visitedOn >= visits.monthFrom) visits.month += 1;
}

function listActiveAds() {
  // Use the local date so ad start/end windows (entered as local dates by admins)
  // don't activate/expire a day early or late near midnight in UTC.
  const today = toLocalDateOnly(new Date());
  return getDb()
    .prepare(`
      SELECT ad_id AS id, title, text, label, url, image_url AS imageUrl, placement,
             display_seconds AS displaySeconds, status,
             starts_at AS startsAt, ends_at AS endsAt, impressions, clicks
      FROM ads
      WHERE status = 'active'
        AND (starts_at IS NULL OR starts_at = '' OR starts_at <= ?)
        AND (ends_at IS NULL OR ends_at = '' OR ends_at >= ?)
      ORDER BY placement, starts_at DESC, created_at DESC
    `)
    .all(today, today);
}

function listAds() {
  return getDb()
    .prepare(`
      SELECT ad_id AS id, title, text, label, url, image_url AS imageUrl, placement,
             display_seconds AS displaySeconds, status,
             starts_at AS startsAt, ends_at AS endsAt, impressions, clicks,
             created_at AS createdAt, updated_at AS updatedAt
      FROM ads
      ORDER BY created_at DESC
    `)
    .all();
}

function saveAd(input) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = sanitizeText(input.id || input.adId || createId(), 80);
  const existing = db.prepare("SELECT ad_id FROM ads WHERE ad_id = ?").get(id);
  const existingAd = existing ? getAd(id) : null;

  const ad = {
    id,
    title: sanitizeText(input.title, 120),
    text: sanitizeText(input.text, 500),
    label: sanitizeText(input.label || "Реклама", 40),
    url: sanitizeText(input.url || "", 500),
    imageUrl: input.imageUrl === undefined ? existingAd?.imageUrl || "" : sanitizeText(input.imageUrl || "", 500),
    placement: sanitizeText(input.placement || "top", 40),
    displaySeconds: normalizeDisplaySeconds(input.displaySeconds || input.display_seconds || existingAd?.displaySeconds),
    status: sanitizeText(input.status || "active", 30),
    startsAt: sanitizeText(input.startsAt || "", 20),
    endsAt: sanitizeText(input.endsAt || "", 20)
  };

  if (!ad.title || !ad.text) {
    throw httpError("Заполните название и текст рекламы.", 400);
  }
  assertCleanText(`${ad.title} ${ad.text}`);

  if (existing) {
    db.prepare(`
      UPDATE ads
      SET title = ?, text = ?, label = ?, url = ?, image_url = ?, placement = ?, display_seconds = ?, status = ?,
          starts_at = ?, ends_at = ?, updated_at = ?
      WHERE ad_id = ?
    `).run(ad.title, ad.text, ad.label, ad.url, ad.imageUrl, ad.placement, ad.displaySeconds, ad.status, ad.startsAt, ad.endsAt, now, id);
  } else {
    db.prepare(`
      INSERT INTO ads (ad_id, title, text, label, url, image_url, placement, display_seconds, status, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ad.title, ad.text, ad.label, ad.url, ad.imageUrl, ad.placement, ad.displaySeconds, ad.status, ad.startsAt, ad.endsAt, now, now);
  }

  return getAd(id);
}

function getAd(id) {
  return getDb()
    .prepare(`
      SELECT ad_id AS id, title, text, label, url, image_url AS imageUrl, placement,
             display_seconds AS displaySeconds, status,
             starts_at AS startsAt, ends_at AS endsAt, impressions, clicks,
             created_at AS createdAt, updated_at AS updatedAt
      FROM ads
      WHERE ad_id = ?
    `)
    .get(id);
}

function deleteAd(id) {
  const db = getDb();
  const ad = getAd(sanitizeText(id, 80));
  if (!ad) throw httpError("Реклама не найдена.", 404);
  db.prepare("DELETE FROM ads WHERE ad_id = ?").run(ad.id);
  return { ok: true, deleted: ad };
}

function normalizeServiceSection(value) {
  return value === "other" ? "other" : "sto";
}

function normalizeServiceStatus(value) {
  return ["active", "paused", "draft"].includes(value) ? value : "active";
}

function serviceRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    section: row.section,
    name: row.name,
    description: row.description || "",
    price: row.price || "",
    details: row.details || "",
    category: row.category || "",
    bullets: row.bullets || "",
    icon: row.icon || "checklist",
    imageUrl: row.imageUrl || "",
    status: row.status || "active",
    sortOrder: row.sortOrder || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getService(id) {
  const row = getDb()
    .prepare(`
      SELECT service_id AS id, section, name, description, price, details, category, bullets, icon,
             image_url AS imageUrl, status,
             sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt
      FROM services
      WHERE service_id = ?
    `)
    .get(sanitizeText(id, 80));
  return serviceRowToDto(row);
}

function listServices({ includeInactive = false } = {}) {
  const sql = `
    SELECT service_id AS id, section, name, description, price, details, category, bullets, icon,
           image_url AS imageUrl, status,
           sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt
    FROM services
    ${includeInactive ? "" : "WHERE status = 'active'"}
    ORDER BY CASE section WHEN 'sto' THEN 0 ELSE 1 END, sort_order, name
  `;
  return getDb().prepare(sql).all().map(serviceRowToDto);
}

function saveService(input = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = sanitizeText(input.id || input.serviceId || createId(), 80);
  const existing = db.prepare("SELECT service_id FROM services WHERE service_id = ?").get(id);
  const existingService = existing ? getService(id) : null;
  const sortOrderValue = Number(input.sortOrder ?? input.sort_order ?? existingService?.sortOrder ?? 0);
  const service = {
    id,
    section: normalizeServiceSection(sanitizeText(input.section || existingService?.section || "sto", 20)),
    name: sanitizeText(input.name, 160),
    description: sanitizeText(input.description || "", 600),
    price: sanitizeText(input.price || "", 180),
    details: sanitizeText(input.details || "", 1200),
    category: sanitizeText(input.category || "", 60),
    // «Что входит»: по пункту на строку. Нормализуем переносы, режем пустые строки.
    bullets: String(input.bullets == null ? "" : input.bullets)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => sanitizeText(line, 160))
      .filter(Boolean)
      .slice(0, 8)
      .join("\n"),
    icon: sanitizeText(input.icon || existingService?.icon || "checklist", 40),
    imageUrl: input.imageUrl === undefined ? existingService?.imageUrl || "" : sanitizeText(input.imageUrl || "", 500),
    status: normalizeServiceStatus(sanitizeText(input.status || existingService?.status || "active", 30)),
    sortOrder: Number.isFinite(sortOrderValue) ? Math.max(0, Math.round(sortOrderValue)) : 0
  };

  if (!service.name) {
    throw httpError("Укажите название услуги.", 400);
  }
  assertCleanText(`${service.name} ${service.description} ${service.price} ${service.details} ${service.category} ${service.bullets}`);

  if (existing) {
    db.prepare(`
      UPDATE services
      SET section = ?, name = ?, description = ?, price = ?, details = ?, category = ?, bullets = ?, icon = ?, image_url = ?, status = ?, sort_order = ?, updated_at = ?
      WHERE service_id = ?
    `).run(
      service.section,
      service.name,
      service.description,
      service.price,
      service.details,
      service.category,
      service.bullets,
      service.icon,
      service.imageUrl,
      service.status,
      service.sortOrder,
      now,
      id
    );
  } else {
    db.prepare(`
      INSERT INTO services (service_id, section, name, description, price, details, category, bullets, icon, image_url, status, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      service.section,
      service.name,
      service.description,
      service.price,
      service.details,
      service.category,
      service.bullets,
      service.icon,
      service.imageUrl,
      service.status,
      service.sortOrder,
      now,
      now
    );
  }

  return getService(id);
}

function deleteService(id) {
  const db = getDb();
  const service = getService(id);
  if (!service) throw httpError("Услуга не найдена.", 404);
  db.prepare("DELETE FROM services WHERE service_id = ?").run(service.id);
  return { ok: true, deleted: service };
}

function listNews({ includeDrafts = false } = {}) {
  const sql = `
    SELECT news_id AS id, title, text, image_url AS imageUrl, views, likes, type, status, published_at AS publishedAt,
           created_at AS createdAt, updated_at AS updatedAt
    FROM news
    ${includeDrafts ? "" : "WHERE status = 'published'"}
    ORDER BY published_at DESC, created_at DESC
  `;
  return getDb().prepare(sql).all();
}

function getNews(id) {
  return getDb()
    .prepare(`
      SELECT news_id AS id, title, text, image_url AS imageUrl, views, likes, type, status,
             published_at AS publishedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM news
      WHERE news_id = ?
    `)
    .get(id);
}

function incrementNewsView(id) {
  const newsId = sanitizeText(id, 80);
  const db = getDb();
  const item = getNews(newsId);
  if (!item) throw httpError("Новость не найдена.", 404);
  db.prepare("UPDATE news SET views = views + 1 WHERE news_id = ?").run(newsId);
  return getNews(newsId);
}

function setNewsLike(id, liked = true, voterId = "anonymous") {
  const newsId = sanitizeText(id, 80);
  const voter = sanitizeText(voterId || "anonymous", 120);
  const db = getDb();
  const item = getNews(newsId);
  if (!voter) throw httpError("Invalid like voter.", 400);
  if (!item) throw httpError("Новость не найдена.", 404);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (liked) {
      const result = db.prepare(`
        INSERT OR IGNORE INTO news_likes (news_id, voter_id, created_at)
        VALUES (?, ?, ?)
      `).run(newsId, voter, new Date().toISOString());
      if (result.changes) {
        db.prepare("UPDATE news SET likes = likes + 1 WHERE news_id = ?").run(newsId);
      }
    } else {
      const result = db.prepare("DELETE FROM news_likes WHERE news_id = ? AND voter_id = ?").run(newsId, voter);
      if (result.changes) {
        db.prepare("UPDATE news SET likes = CASE WHEN likes > 0 THEN likes - 1 ELSE 0 END WHERE news_id = ?").run(newsId);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getNews(newsId);
}

function saveNews(input) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = sanitizeText(input.id || input.newsId || createId(), 80);
  const existing = db.prepare("SELECT news_id FROM news WHERE news_id = ?").get(id);
  const existingNews = existing ? getNews(id) : null;
  const item = {
    id,
    title: sanitizeText(input.title, 160),
    text: sanitizeText(input.text, 1200),
    imageUrl: input.imageUrl === undefined ? existingNews?.imageUrl || "" : sanitizeText(input.imageUrl || "", 500),
    type: sanitizeText(input.type || "info", 40),
    status: sanitizeText(input.status || "published", 30),
    publishedAt: sanitizeText(input.publishedAt || now, 40)
  };

  if (!item.title || !item.text) {
    throw httpError("Заполните заголовок и текст новости.", 400);
  }
  assertCleanText(`${item.title} ${item.text}`);

  if (existing) {
    db.prepare(`
      UPDATE news
      SET title = ?, text = ?, image_url = ?, type = ?, status = ?, published_at = ?, updated_at = ?
      WHERE news_id = ?
    `).run(item.title, item.text, item.imageUrl, item.type, item.status, item.publishedAt, now, id);
  } else {
    db.prepare(`
      INSERT INTO news (news_id, title, text, image_url, type, status, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, item.title, item.text, item.imageUrl, item.type, item.status, item.publishedAt, now, now);
  }

  return getNews(id);
}

function deleteNews(id) {
  const newsId = sanitizeText(id, 80);
  const db = getDb();
  const item = getNews(newsId);
  if (!item) throw httpError("Новость не найдена.", 404);
  db.prepare("DELETE FROM news WHERE news_id = ?").run(newsId);
  return { ok: true, deleted: item };
}

function createAppeal(input, user) {
  const db = getDb();
  const now = new Date().toISOString();
  const category = sanitizeText(input.category || "Обращение", 64);
  const appeal = {
    id: createId(),
    status: "new",
    category,
    routeId: sanitizeText(input.routeId || "", 80),
    routeNumber: sanitizeText(input.routeNumber || input.routeId || "", 32),
    stopName: sanitizeText(input.stop || input.stopName || "", 140),
    text: sanitizeText(input.text || input.message || "", 3000),
    contact: sanitizeText(input.contact || "", 180),
    telegramId: user?.telegramId || "",
    telegramUsername: user?.username || "",
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    assignedRole: resolveAppealAssignedRole(category),
    source: sanitizeText(input.source || (user?.telegramId ? "telegram-mini-app" : "web"), 40),
    clientToken: crypto.randomBytes(16).toString("hex")
  };

  const attachments = normalizeAttachments(input.attachments);

  if (appeal.text.length < 8 && attachments.length === 0) {
    throw httpError("Опишите ситуацию чуть подробнее.", 400);
  }
  if (appeal.text) assertCleanText(appeal.text);

  db.prepare(`
    INSERT INTO appeals (
      appeal_id, status, category, route_id, route_number, stop_name, text, contact,
      source, telegram_id, telegram_username, first_name, last_name, assigned_role, client_token, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    appeal.id,
    appeal.status,
    appeal.category,
    appeal.routeId,
    appeal.routeNumber,
    appeal.stopName,
    appeal.text,
    appeal.contact,
    appeal.source,
    appeal.telegramId,
    appeal.telegramUsername,
    appeal.firstName,
    appeal.lastName,
    appeal.assignedRole,
    appeal.clientToken,
    now,
    now
  );

  db.prepare("INSERT INTO appeal_history (appeal_id, status, note, actor, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(appeal.id, "new", "Создано обращение", "system", now);
  addAppealMessage(appeal.id, {
    senderType: "client",
    text: appeal.text || "Вложение без текстового описания.",
    actorName: appeal.firstName || appeal.telegramUsername || "Клиент",
    telegramId: appeal.telegramId,
    attachments
  });
  invalidateStatsCache();

  if (appeal.telegramId) {
    upsertSubscriber({
      telegramId: appeal.telegramId,
      username: appeal.telegramUsername,
      firstName: appeal.firstName,
      lastName: appeal.lastName
    });
  }

  return getAppeal(appeal.id);
}

function getAppeal(id) {
  purgeExpiredAppeals();
  return normalizeAppealRecord(getDb()
    .prepare(`
      SELECT appeal_id AS id, status, category, route_id AS routeId, route_number AS routeNumber,
             stop_name AS stopName, text, contact, source, telegram_id AS telegramId,
             telegram_username AS telegramUsername, first_name AS firstName, last_name AS lastName,
             assigned_role AS assignedRole, client_token AS clientToken, created_at AS createdAt, updated_at AS updatedAt
      FROM appeals
      WHERE appeal_id = ?
    `)
    .get(id));
}

function listAppeals(role = "admin") {
  purgeExpiredAppeals();
  const appeals = getDb()
    .prepare(`
      SELECT appeal_id AS id, status, category, route_id AS routeId, route_number AS routeNumber,
             stop_name AS stopName, text, contact, source, telegram_id AS telegramId,
             telegram_username AS telegramUsername, first_name AS firstName, last_name AS lastName,
             assigned_role AS assignedRole, created_at AS createdAt, updated_at AS updatedAt
      FROM appeals
      ORDER BY created_at DESC
      LIMIT 500
    `)
    .all()
    .map(normalizeAppealRecord);
  return appeals.filter((appeal) => roleCanSeeAppeal(role, appeal));
}

function listAppealsForTelegram(telegramId) {
  const id = sanitizeText(telegramId || "", 60);
  if (!id) return [];
  purgeExpiredAppeals();
  return getDb()
    .prepare(`
      SELECT appeal_id AS id, status, category, route_id AS routeId, route_number AS routeNumber,
             stop_name AS stopName, text, source, assigned_role AS assignedRole,
             created_at AS createdAt, updated_at AS updatedAt
      FROM appeals
      WHERE telegram_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 50
    `)
    .all(id)
    .map(normalizeAppealRecord);
}

function clearAppeals(role = "admin") {
  const db = getDb();
  const appeals = listAppeals(role);
  const ids = appeals.map((appeal) => appeal.id);
  const doomedFiles = ids.length
    ? db
        .prepare(`SELECT url FROM appeal_attachments WHERE appeal_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids)
        .map((row) => row.url)
        .filter(Boolean)
    : [];
  const stmt = db.prepare("DELETE FROM appeals WHERE appeal_id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    ids.forEach((id) => stmt.run(id));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (appeals.length) invalidateStatsCache();
  notifyAppealFilesPurged(doomedFiles);
  return { ok: true, deleted: appeals.length };
}

function purgeExpiredAppeals() {
  const now = Date.now();
  if (now - lastAppealPurgeAt < APPEAL_PURGE_INTERVAL_MS) {
    return { ok: true, deleted: 0, skipped: true };
  }
  lastAppealPurgeAt = now;

  const cutoff = new Date(now - APPEAL_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  // Collect attachment files BEFORE the rows cascade away, so the retention
  // promise covers the uploaded files too, not only the DB rows.
  const doomedFiles = db
    .prepare(`
      SELECT a.url FROM appeal_attachments a
      JOIN appeals ap ON ap.appeal_id = a.appeal_id
      WHERE ap.status = 'closed' AND ap.updated_at <= ?
    `)
    .all(cutoff)
    .map((row) => row.url)
    .filter(Boolean);
  const result = db
    .prepare("DELETE FROM appeals WHERE status = 'closed' AND updated_at <= ?")
    .run(cutoff);
  if (result.changes) invalidateStatsCache();
  notifyAppealFilesPurged(doomedFiles);
  return { ok: true, deleted: result.changes };
}

let appealFileCleanupHandler = null;

function setAppealFileCleanupHandler(handler) {
  appealFileCleanupHandler = typeof handler === "function" ? handler : null;
}

function notifyAppealFilesPurged(urls) {
  if (!appealFileCleanupHandler || !Array.isArray(urls) || !urls.length) return;
  try {
    appealFileCleanupHandler(urls);
  } catch (error) {
    console.warn("Appeal file cleanup failed:", error.message || error);
  }
}

function getAppealSummary(role = "admin") {
  const appeals = listAppeals(role);
  const summary = {};
  Object.keys(STATUS_LABELS).forEach((status) => {
    summary[status] = appeals.filter((appeal) => appeal.status === status).length;
  });
  return {
    ok: true,
    summary,
    total: appeals.length
  };
}

function updateAppealStatus(id, status, actor) {
  if (!STATUS_LABELS[status]) {
    throw httpError("Неизвестный статус обращения.", 400);
  }

  const db = getDb();
  const appeal = getAppeal(id);
  if (!appeal) throw httpError("Обращение не найдено.", 404);

  const now = new Date().toISOString();
  db.prepare("UPDATE appeals SET status = ?, updated_at = ? WHERE appeal_id = ?").run(status, now, id);
  db.prepare("INSERT INTO appeal_history (appeal_id, status, note, actor, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, status, `Статус: ${STATUS_LABELS[status]}`, actor || "admin", now);

  return getAppeal(id);
}

function listAppealMessages(appealId) {
  const db = getDb();
  const messages = db
    .prepare(`
      SELECT message_id AS id, appeal_id AS appealId, sender_type AS senderType, text,
             actor_name AS actorName, telegram_id AS telegramId, created_at AS createdAt
      FROM appeal_messages
      WHERE appeal_id = ?
      ORDER BY created_at
    `)
    .all(appealId);
  return attachAppealFiles(db, messages);
}

function addAppealMessage(appealId, input) {
  const db = getDb();
  const appeal = getAppeal(appealId);
  if (!appeal) throw httpError("Обращение не найдено.", 404);
  if (appeal.status === "closed" && input.senderType !== "system") throw httpError("Чат уже закрыт.", 409);

  const now = new Date().toISOString();
  const attachments = normalizeAttachments(input.attachments);
  const message = {
    id: createId(),
    appealId,
    senderType: sanitizeText(input.senderType || "client", 30),
    text: sanitizeText(input.text || "", 3000),
    actorName: sanitizeText(input.actorName || "", 120),
    telegramId: sanitizeText(input.telegramId || "", 60),
    createdAt: now
  };

  if (message.text.length < 1 && attachments.length === 0) throw httpError("Сообщение пустое.", 400);
  if (message.text) assertCleanText(message.text);

  db.prepare(`
    INSERT INTO appeal_messages (message_id, appeal_id, sender_type, text, actor_name, telegram_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(message.id, message.appealId, message.senderType, message.text, message.actorName, message.telegramId, message.createdAt);
  saveAppealAttachments(db, appealId, message.id, message.senderType, attachments, now);
  db.prepare("UPDATE appeals SET updated_at = ? WHERE appeal_id = ?").run(now, appealId);
  return attachAppealFiles(db, [message])[0];
}

function normalizeAttachments(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => ({
      type: sanitizeText(item.type || "", 20),
      url: sanitizeText(item.url || "", 260),
      name: sanitizeText(item.name || "", 160),
      mimeType: sanitizeText(item.mimeType || item.mime || "", 80),
      size: Math.max(0, Number(item.size || 0))
    }))
    .filter((item) => /^(image|audio)$/.test(item.type) && /^\/uploads\/appeals\//.test(item.url))
    .slice(0, 4);
}

function saveAppealAttachments(db, appealId, messageId, senderType, attachments, createdAt) {
  if (!attachments.length) return;
  const stmt = db.prepare(`
    INSERT INTO appeal_attachments (
      attachment_id, appeal_id, message_id, sender_type, type, url, name, mime_type, size, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  attachments.forEach((item) => {
    stmt.run(createId(), appealId, messageId, senderType, item.type, item.url, item.name, item.mimeType, item.size, createdAt);
  });
}

function attachAppealFiles(db, messages) {
  if (!messages.length) return messages;
  const ids = messages.map((message) => message.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`
      SELECT attachment_id AS id, message_id AS messageId, type, url, name, mime_type AS mimeType, size, created_at AS createdAt
      FROM appeal_attachments
      WHERE message_id IN (${placeholders})
      ORDER BY created_at, attachment_id
    `)
    .all(...ids);
  const byMessage = groupBy(rows, "messageId");
  return messages.map((message) => ({ ...message, attachments: byMessage.get(message.id) || [] }));
}

function upsertSubscriber(user) {
  if (!user?.telegramId) return null;
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      INSERT INTO notification_subscribers (telegram_id, username, first_name, last_name, subscribed, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        subscribed = 1,
        updated_at = excluded.updated_at
    `)
    .run(user.telegramId, user.username || "", user.firstName || "", user.lastName || "", now, now);
  invalidateStatsCache();

  return getDb()
    .prepare("SELECT telegram_id AS telegramId, username, first_name AS firstName, last_name AS lastName FROM notification_subscribers WHERE telegram_id = ?")
    .get(user.telegramId);
}

function listSubscribers() {
  return getDb()
    .prepare(`
      SELECT telegram_id AS telegramId, username, first_name AS firstName, last_name AS lastName,
             subscribed, created_at AS createdAt, updated_at AS updatedAt
      FROM notification_subscribers
      WHERE subscribed = 1
      ORDER BY updated_at DESC
    `)
    .all();
}

// Called when Telegram reports the user blocked the bot / was deactivated, so
// broadcasts stop retrying dead chats forever.
function markSubscriberUnsubscribed(telegramId) {
  const id = sanitizeText(telegramId || "", 60);
  if (!id) return { ok: false };
  const result = getDb()
    .prepare("UPDATE notification_subscribers SET subscribed = 0, updated_at = ? WHERE telegram_id = ?")
    .run(new Date().toISOString(), id);
  if (result.changes) invalidateStatsCache();
  return { ok: true, changed: result.changes };
}

function listStaffRecipients(role = "") {
  const recipients = getDb()
    .prepare(`
      SELECT admin_id AS id, telegram_id AS telegramId, name, role
      FROM admins
      WHERE active = 1 AND telegram_id IS NOT NULL AND telegram_id <> ''
      ORDER BY updated_at DESC, created_at DESC
    `)
    .all();
  return ROLE_LABELS[role] ? recipients.filter((recipient) => recipient.role === role) : recipients;
}

function normalizeDriverSquad(value) {
  const normalized = sanitizeText(value || "", 40).toLowerCase();
  if (["regional", "second", "2", "2nd", "suburban"].includes(normalized)) return "regional";
  if (["city", "first", "1", "1st"].includes(normalized)) return "city";
  return normalized ? "city" : "";
}

function driverSquadLabel(value) {
  const normalized = normalizeDriverSquad(value) || "city";
  return DRIVER_SQUAD_LABELS[normalized] || DRIVER_SQUAD_LABELS.city;
}

function registerDriverUser(input) {
  const driverId = sanitizeText(input.id || input.driverId || "", 80);
  const telegramId = sanitizeText(input.telegramId, 60);
  const tabNumber = sanitizeText(input.tabNumber, 30).replace(/\D+/g, "");
  if (!/^\d{4,20}$/.test(telegramId)) throw httpError("Telegram ID водителя не определен.", 400);
  if (!/^\d{2,8}$/.test(tabNumber)) throw httpError("Введите корректный табельный номер.", 400);

  const db = getDb();
  // Compare canonical tab numbers (leading zeros stripped): "07" and "007" are the
  // same employee, and roster delivery matches by the canonical key — two rows with
  // colliding keys would silently receive each other's assignments.
  const canonicalTab = tabNumber.replace(/^0+/, "") || "0";
  const existingTab = db
    .prepare("SELECT driver_id AS id, telegram_id AS telegramId, tab_number AS tabNumber FROM driver_users WHERE driver_id <> ?")
    .all(driverId || "")
    .find((row) => (String(row.tabNumber || "").replace(/^0+/, "") || "0") === canonicalTab);
  if (existingTab) throw httpError("Этот табельный номер уже привязан к другому Telegram.", 409);

  const existingTelegram = db
    .prepare("SELECT driver_id AS id, tab_number AS tabNumber FROM driver_users WHERE telegram_id = ? AND driver_id <> ?")
    .get(telegramId, driverId || "");
  if (existingTelegram) throw httpError("Этот Telegram ID уже привязан к другому табельному номеру.", 409);

  const now = new Date().toISOString();
  const fullName = sanitizeText(input.fullName || input.name || "", 160);
  const driverSquad = normalizeDriverSquad(input.driverSquad) || "city";
  if (driverId) {
    const result = db.prepare(`
      UPDATE driver_users
      SET telegram_id = ?,
          tab_number = ?,
          full_name = ?,
          driver_squad = ?,
          updated_at = ?
      WHERE driver_id = ?
    `).run(telegramId, tabNumber, fullName, driverSquad, now, driverId);
    if (!result.changes) throw httpError("Водитель не найден.", 404);
    syncDriverAdmin({ telegramId, tabNumber, name: fullName, driverSquad, active: 1 });
    return getDriverByTelegramId(telegramId);
  }

  db.prepare(`
    INSERT INTO driver_users (driver_id, telegram_id, tab_number, full_name, driver_squad, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      tab_number = excluded.tab_number,
      full_name = COALESCE(NULLIF(excluded.full_name, ''), driver_users.full_name),
      driver_squad = excluded.driver_squad,
      updated_at = excluded.updated_at
  `).run(createId(), telegramId, tabNumber, fullName, driverSquad, now, now);

  syncDriverAdmin({ telegramId, tabNumber, name: fullName, driverSquad, active: 1 });
  return getDriverByTelegramId(telegramId);
}

function syncDriverAdmin(input) {
  const telegramId = sanitizeText(input.telegramId || "", 60);
  const tabNumber = sanitizeText(input.tabNumber || "", 30).replace(/\D+/g, "");
  if (!telegramId || !tabNumber) return null;
  const db = getDb();
  const now = new Date().toISOString();
  const name = sanitizeText(input.name || input.fullName || `Водитель ${tabNumber}`, 120);
  const driverSquad = normalizeDriverSquad(input.driverSquad) || "city";
  const active = input.active === false || input.active === 0 || input.active === "0" ? 0 : 1;
  const existing = db.prepare("SELECT admin_id AS id FROM admins WHERE telegram_id = ?").get(telegramId);
  if (existing) {
    db.prepare(`
      UPDATE admins
      SET name = ?,
          role = 'driver',
          active = ?,
          tab_number = ?,
          driver_squad = ?,
          updated_at = ?
      WHERE admin_id = ?
    `).run(name, active, tabNumber, driverSquad, now, existing.id);
    return existing.id;
  }
  const id = createId();
  db.prepare(`
    INSERT INTO admins (admin_id, telegram_id, name, role, active, tab_number, driver_squad, created_at, updated_at)
    VALUES (?, ?, ?, 'driver', ?, ?, ?, ?, ?)
  `).run(id, telegramId, name, active, tabNumber, driverSquad, now, now);
  return id;
}

function deleteDriverUser(id) {
  const driverId = sanitizeText(id, 80);
  if (!driverId) throw httpError("Driver not found.", 404);
  const db = getDb();
  const driver = db
    .prepare("SELECT driver_id AS id, telegram_id AS telegramId FROM driver_users WHERE driver_id = ?")
    .get(driverId);
  if (!driver) throw httpError("Driver not found.", 404);

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("DELETE FROM driver_users WHERE driver_id = ?").run(driverId);
    db.prepare("UPDATE admins SET active = 0, updated_at = ? WHERE role = 'driver' AND telegram_id = ?")
      .run(new Date().toISOString(), driver.telegramId);
    db.exec("COMMIT");
    return { ok: true, deleted: result.changes };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getDriverByTelegramId(telegramId) {
  if (!telegramId) return null;
  const db = getDb();
  const driver = db
    .prepare(`
      SELECT driver_id AS id, telegram_id AS telegramId, tab_number AS tabNumber,
             full_name AS fullName, driver_squad AS driverSquad,
             created_at AS createdAt, updated_at AS updatedAt
      FROM driver_users
      WHERE telegram_id = ?
    `)
    .get(String(telegramId));
  if (driver) return driver;
  return db
    .prepare(`
      SELECT admin_id AS id, telegram_id AS telegramId, tab_number AS tabNumber,
             name AS fullName, driver_squad AS driverSquad,
             created_at AS createdAt, updated_at AS updatedAt
      FROM admins
      WHERE telegram_id = ? AND role = 'driver' AND active = 1
    `)
    .get(String(telegramId));
}

function getDriverByTabNumber(tabNumber) {
  const normalized = sanitizeText(tabNumber, 30).replace(/\D+/g, "");
  if (!normalized) return null;
  const db = getDb();
  const driver = db
    .prepare(`
      SELECT driver_id AS id, telegram_id AS telegramId, tab_number AS tabNumber,
             full_name AS fullName, driver_squad AS driverSquad,
             created_at AS createdAt, updated_at AS updatedAt
      FROM driver_users
      WHERE tab_number = ?
    `)
    .get(normalized);
  if (driver) return driver;
  return db
    .prepare(`
      SELECT admin_id AS id, telegram_id AS telegramId, tab_number AS tabNumber,
             name AS fullName, driver_squad AS driverSquad,
             created_at AS createdAt, updated_at AS updatedAt
      FROM admins
      WHERE tab_number = ? AND role = 'driver' AND active = 1
    `)
    .get(normalized);
}

function listDriverUsers() {
  const db = getDb();
  const byTelegram = new Map();
  db.prepare(`
      SELECT driver_id AS id, telegram_id AS telegramId, tab_number AS tabNumber,
             full_name AS fullName, driver_squad AS driverSquad,
             created_at AS createdAt, updated_at AS updatedAt
      FROM driver_users
      ORDER BY CAST(tab_number AS INTEGER), tab_number
    `)
    .all()
    .forEach((driver) => {
      byTelegram.set(String(driver.telegramId || driver.id), driver);
    });

  db.prepare(`
      SELECT admin_id AS id, telegram_id AS telegramId, tab_number AS tabNumber,
             name AS fullName, driver_squad AS driverSquad,
             created_at AS createdAt, updated_at AS updatedAt
      FROM admins
      WHERE active = 1 AND role = 'driver' AND telegram_id IS NOT NULL AND telegram_id <> ''
    `)
    .all()
    .forEach((driver) => {
      const key = String(driver.telegramId || driver.id);
      if (!byTelegram.has(key)) byTelegram.set(key, driver);
    });

  return Array.from(byTelegram.values()).sort((left, right) => {
    const leftNumber = Number(left.tabNumber || 0);
    const rightNumber = Number(right.tabNumber || 0);
    if (leftNumber && rightNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
    return String(left.tabNumber || left.fullName || "").localeCompare(String(right.tabNumber || right.fullName || ""), "ru");
  });
}

function findSentDutyRosterUploadByHash(fileHash) {
  const hash = sanitizeText(fileHash, 128);
  if (!hash) return null;
  return getDb()
    .prepare(`
      SELECT upload_id AS id, file_name AS fileName, file_hash AS fileHash,
             schedule_date AS scheduleDate, status, uploaded_by AS uploadedBy,
             target_squad AS targetSquad,
             assignment_count AS assignmentCount, driver_count AS driverCount,
             sent_count AS sentCount, skipped_count AS skippedCount, failed_count AS failedCount,
             created_at AS createdAt, sent_at AS sentAt
      FROM duty_roster_uploads
      WHERE file_hash = ? AND status = 'sent'
      ORDER BY sent_at DESC, created_at DESC
      LIMIT 1
    `)
    .get(hash);
}

function getLatestDutyRosterUploadForDate(scheduleDate) {
  const date = sanitizeText(scheduleDate, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const upload = getDb()
    .prepare(`
      SELECT upload_id AS id, file_name AS fileName, file_hash AS fileHash,
             schedule_date AS scheduleDate, status, uploaded_by AS uploadedBy,
             target_squad AS targetSquad,
             assignment_count AS assignmentCount, driver_count AS driverCount,
             sent_count AS sentCount, skipped_count AS skippedCount, failed_count AS failedCount,
             warnings_json AS warningsJson, report_json AS reportJson, created_at AS createdAt, sent_at AS sentAt
      FROM duty_roster_uploads
      WHERE schedule_date = ?
      ORDER BY COALESCE(sent_at, created_at) DESC, created_at DESC
      LIMIT 1
    `)
    .get(date);
  return upload ? parseDutyRosterUploadRow(upload) : null;
}

function createDutyRosterUpload(input) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();
  const items = Array.isArray(input.items) ? input.items : [];
  const driverCount = new Set(items.map((item) => item.tabNumber).filter(Boolean)).size;
  const warnings = normalizeDutyRosterWarnings(input.warnings);
  const requestedStatus = sanitizeText(input.status || "parsed", 30);
  const status = ["blocked", "needs_review"].includes(requestedStatus) ? requestedStatus : "parsed";

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO duty_roster_uploads (
        upload_id, file_name, file_hash, schedule_date, status, uploaded_by, target_squad,
        assignment_count, driver_count, warnings_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sanitizeText(input.fileName || "roster.csv", 240),
      sanitizeText(input.fileHash || "", 128),
      sanitizeText(input.scheduleDate || "", 20),
      status,
      sanitizeText(input.uploadedBy || "Админ-панель", 160),
      normalizeDriverSquad(input.targetSquad || input.driverSquad),
      items.length,
      driverCount,
      warnings.length ? JSON.stringify(warnings) : null,
      now
    );

    const stmt = db.prepare(`
      INSERT INTO duty_roster_items (
        item_id, upload_id, schedule_date, tab_number, driver_name, assignment_type,
        route, route_car_number, shift, work_time_start, work_time_end, bus_plate_number, garage_number,
        replacement_driver_name, replacement_tab_number, is_line_change, raw_data
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item) => {
      stmt.run(
        createId(),
        id,
        sanitizeText(item.scheduleDate || input.scheduleDate || "", 20),
        sanitizeText(item.tabNumber || "", 30),
        sanitizeText(item.driverName || "", 160),
        sanitizeText(item.assignmentType || (item.route ? "route" : "unknown"), 20),
        sanitizeText(item.route || "", 20),
        sanitizeText(item.routeCarNumber || "", 20),
        sanitizeText(item.shift || "", 10),
        sanitizeText(item.workTimeStart || "", 10),
        sanitizeText(item.workTimeEnd || "", 10),
        sanitizeText(item.busPlateNumber || "", 40),
        sanitizeText(item.garageNumber || "", 40),
        sanitizeText(item.replacementDriverName || "", 160),
        sanitizeText(item.replacementTabNumber || "", 30),
        item.isLineChange ? 1 : 0,
        String(item.rawData || "").slice(0, 4000)
      );
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getDutyRosterUpload(id);
}

function listDutyRosterUploads(limit = 20) {
  return getDb()
    .prepare(`
      SELECT upload_id AS id, file_name AS fileName, file_hash AS fileHash,
             schedule_date AS scheduleDate, status, uploaded_by AS uploadedBy,
             target_squad AS targetSquad,
             assignment_count AS assignmentCount, driver_count AS driverCount,
             sent_count AS sentCount, skipped_count AS skippedCount, failed_count AS failedCount,
             warnings_json AS warningsJson, report_json AS reportJson, created_at AS createdAt, sent_at AS sentAt
      FROM duty_roster_uploads
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(Math.max(1, Math.min(100, Number(limit) || 20)))
    .map(parseDutyRosterUploadRow);
}

function clearDutyRosterUploads() {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const dailySends = db.prepare("DELETE FROM duty_roster_daily_sends").run();
    const uploads = db.prepare("DELETE FROM duty_roster_uploads").run();
    db.exec("COMMIT");
    return { ok: true, deleted: uploads.changes, dailySendsDeleted: dailySends.changes };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getDutyRosterUpload(id) {
  const uploadId = sanitizeText(id, 80);
  if (!uploadId) return null;
  const upload = getDb()
    .prepare(`
      SELECT upload_id AS id, file_name AS fileName, file_hash AS fileHash,
             schedule_date AS scheduleDate, status, uploaded_by AS uploadedBy,
             target_squad AS targetSquad,
             assignment_count AS assignmentCount, driver_count AS driverCount,
             sent_count AS sentCount, skipped_count AS skippedCount, failed_count AS failedCount,
             warnings_json AS warningsJson, report_json AS reportJson, created_at AS createdAt, sent_at AS sentAt
      FROM duty_roster_uploads
      WHERE upload_id = ?
    `)
    .get(uploadId);
  return upload ? parseDutyRosterUploadRow(upload) : null;
}

function listDutyRosterItems(uploadId) {
  return getDb()
    .prepare(`
      SELECT item_id AS id, upload_id AS uploadId, schedule_date AS scheduleDate,
             tab_number AS tabNumber, driver_name AS driverName,
             assignment_type AS assignmentType, route,
             route_car_number AS routeCarNumber, shift, work_time_start AS workTimeStart,
             work_time_end AS workTimeEnd, bus_plate_number AS busPlateNumber,
             garage_number AS garageNumber, replacement_driver_name AS replacementDriverName,
             replacement_tab_number AS replacementTabNumber, is_line_change AS isLineChange,
             raw_data AS rawData, send_status AS sendStatus, sent_at AS sentAt, error
      FROM duty_roster_items
      WHERE upload_id = ?
      ORDER BY CASE WHEN assignment_type = 'reserve' THEN 1 WHEN route = '' THEN 2 ELSE 0 END,
               CAST(route AS INTEGER), route, CAST(route_car_number AS INTEGER), shift, work_time_start, driver_name
    `)
    .all(sanitizeText(uploadId, 80))
    .map(normalizeDutyRosterItemRow);
}

function listDutyRosterUnregisteredTabs(uploadId) {
  return getDb()
    .prepare(`
      SELECT DISTINCT item.tab_number AS tabNumber, item.driver_name AS driverName
      FROM duty_roster_items item
      LEFT JOIN driver_users driver ON driver.tab_number = item.tab_number
      WHERE item.upload_id = ? AND driver.telegram_id IS NULL
      ORDER BY CAST(item.tab_number AS INTEGER), item.tab_number
    `)
    .all(sanitizeText(uploadId, 80));
}

function markDutyRosterItemSent(id, status, error = "") {
  getDb()
    .prepare(`
      UPDATE duty_roster_items
      SET send_status = ?, sent_at = ?, error = ?
      WHERE item_id = ?
    `)
    .run(sanitizeText(status || "sent", 30), new Date().toISOString(), sanitizeText(error, 500), sanitizeText(id, 80));
}

function markDutyRosterUploadSent(id, report) {
  const uploadId = sanitizeText(id, 80);
  const safeReport = report || {};
  getDb()
    .prepare(`
      UPDATE duty_roster_uploads
      SET status = 'sent',
          sent_count = ?,
          skipped_count = ?,
          failed_count = ?,
          report_json = ?,
          sent_at = ?
      WHERE upload_id = ?
    `)
    .run(
      Number(safeReport.sent || 0),
      Number(safeReport.skipped || 0),
      Number(safeReport.failed || 0),
      JSON.stringify(safeReport),
      new Date().toISOString(),
      uploadId
    );
  return getDutyRosterUpload(uploadId);
}

function getDutyRosterDailySend(scheduleDate) {
  const date = sanitizeText(scheduleDate, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const row = getDb()
    .prepare(`
      SELECT schedule_date AS scheduleDate, upload_id AS uploadId, source,
             sent_count AS sentCount, skipped_count AS skippedCount, failed_count AS failedCount,
             report_json AS reportJson, created_at AS createdAt, sent_at AS sentAt
      FROM duty_roster_daily_sends
      WHERE schedule_date = ?
    `)
    .get(date);
  return row ? { ...row, report: safeJsonParse(row.reportJson, null) } : null;
}

function markDutyRosterDailySend(scheduleDate, uploadId, report, source = "auto") {
  const date = sanitizeText(scheduleDate, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError("Дата разнарядки не определена.", 400);
  const safeReport = report || {};
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      INSERT INTO duty_roster_daily_sends (
        schedule_date, upload_id, source, sent_count, skipped_count, failed_count,
        report_json, created_at, sent_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_date) DO UPDATE SET
        upload_id = excluded.upload_id,
        source = excluded.source,
        sent_count = excluded.sent_count,
        skipped_count = excluded.skipped_count,
        failed_count = excluded.failed_count,
        report_json = excluded.report_json,
        sent_at = excluded.sent_at
    `)
    .run(
      date,
      sanitizeText(uploadId || "", 80) || null,
      sanitizeText(source || "auto", 40),
      Number(safeReport.sent || 0),
      Number(safeReport.skipped || 0),
      Number(safeReport.failed || 0),
      JSON.stringify(safeReport),
      now,
      now
    );
  return getDutyRosterDailySend(date);
}

function getLatestDutyRosterItemForTelegram(telegramId) {
  const driver = getDriverByTelegramId(telegramId);
  if (!driver) return null;
  const row = getDb()
    .prepare(`
      SELECT item.item_id AS id, item.upload_id AS uploadId, item.schedule_date AS scheduleDate,
             item.tab_number AS tabNumber, item.driver_name AS driverName,
             item.assignment_type AS assignmentType, item.route,
             item.route_car_number AS routeCarNumber, item.shift, item.work_time_start AS workTimeStart,
             item.work_time_end AS workTimeEnd, item.bus_plate_number AS busPlateNumber,
             item.garage_number AS garageNumber, item.replacement_driver_name AS replacementDriverName,
             item.replacement_tab_number AS replacementTabNumber, item.is_line_change AS isLineChange,
             item.raw_data AS rawData, item.send_status AS sendStatus, item.sent_at AS sentAt, item.error
      FROM duty_roster_items item
      JOIN duty_roster_uploads upload ON upload.upload_id = item.upload_id
      WHERE item.tab_number = ?
      ORDER BY item.schedule_date DESC, upload.created_at DESC
      LIMIT 1
    `)
    .get(driver.tabNumber);
  return row ? normalizeDutyRosterItemRow(row) : null;
}

function parseDutyRosterUploadRow(row) {
  if (!row) return null;
  return {
    ...row,
    assignmentCount: Number(row.assignmentCount || 0),
    driverCount: Number(row.driverCount || 0),
    sentCount: Number(row.sentCount || 0),
    skippedCount: Number(row.skippedCount || 0),
    failedCount: Number(row.failedCount || 0),
    warnings: safeJsonParse(row.warningsJson, []) || [],
    report: safeJsonParse(row.reportJson, null)
  };
}

function normalizeDutyRosterWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.slice(0, 200).map((warning) => ({
    row: Number(warning?.row || 0) || null,
    tabNumber: sanitizeText(warning?.tabNumber || "", 30),
    driverName: sanitizeText(warning?.driverName || "", 160),
    code: sanitizeText(warning?.code || "", 80),
    message: sanitizeText(warning?.message || "", 500)
  })).filter((warning) => warning.message || warning.code);
}

function normalizeDutyRosterItemRow(row) {
  return {
    ...row,
    assignmentType: row.assignmentType || (row.route ? "route" : "unknown"),
    isLineChange: Boolean(row.isLineChange)
  };
}

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function createNotification(input, actor) {
  const db = getDb();
  const now = new Date().toISOString();
  const target = normalizeNotificationTarget(input.target);
  const item = {
    id: createId(),
    title: sanitizeText(input.title, 120),
    text: sanitizeText(input.text, 2000),
    target,
    status: sanitizeText(input.status || "draft", 30),
    createdBy: actor || "admin"
  };

  if (!item.title || !item.text) {
    throw httpError("Заполните заголовок и текст уведомления.", 400);
  }
  assertCleanText(`${item.title} ${item.text}`);

  db.prepare(`
    INSERT INTO notifications (notification_id, title, text, target, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(item.id, item.title, item.text, item.target, item.status, item.createdBy, now);

  return getNotification(item.id);
}

function normalizeNotificationTarget(value) {
  const target = sanitizeText(value || "all", 80);
  if (target === "all" || target === "staff") return target;
  return "all";
}

function markNotificationSent(id, sentCount, failedCount) {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE notifications SET status = 'sent', sent_count = ?, failed_count = ?, sent_at = ? WHERE notification_id = ?")
    .run(sentCount, failedCount, now, id);
  return getNotification(id);
}

function getNotification(id) {
  return getDb()
    .prepare(`
      SELECT notification_id AS id, title, text, target, status, sent_count AS sentCount,
             failed_count AS failedCount, created_by AS createdBy, created_at AS createdAt, sent_at AS sentAt
      FROM notifications
      WHERE notification_id = ?
    `)
    .get(id);
}

function listNotifications() {
  return getDb()
    .prepare(`
      SELECT notification_id AS id, title, text, target, status, sent_count AS sentCount,
             failed_count AS failedCount, created_by AS createdBy, created_at AS createdAt, sent_at AS sentAt
      FROM notifications
      ORDER BY created_at DESC
      LIMIT 50
    `)
    .all();
}

function clearNotifications() {
  const result = getDb().prepare("DELETE FROM notifications").run();
  return { ok: true, deleted: result.changes };
}

function deleteNotification(id) {
  const notificationId = sanitizeText(id, 80);
  const db = getDb();
  const item = db.prepare("SELECT notification_id AS id FROM notifications WHERE notification_id = ?").get(notificationId);
  if (!item) throw httpError("Уведомление не найдено.", 404);
  db.prepare("DELETE FROM notifications WHERE notification_id = ?").run(notificationId);
  return { ok: true, deleted: item };
}

function createReminder(input, user) {
  if (!user?.telegramId) throw httpError("Telegram не передал ID пользователя, поэтому будильник нельзя сохранить для уведомления.", 401);

  const departureTime = sanitizeText(input.departureTime || "", 10);
  if (!/^\d{2}:\d{2}$/.test(departureTime)) throw httpError("Не выбрано время рейса.", 400);

  const remindMinutes = Math.round(Number(input.remindMinutes));
  if (!Number.isFinite(remindMinutes) || remindMinutes < 1 || remindMinutes > 360) {
    throw httpError("Укажите время напоминания от 1 до 360 минут.", 400);
  }

  const dayMask = normalizeReminderDayMask(input.dayMask || input.departureDayMask || "");
  const tripCode = sanitizeText(input.tripCode || "", 80);
  const variantCode = sanitizeText(input.variantCode || "", 80);
  const repeat = normalizeReminderRepeat(input.repeatMode, input.repeatDays);
  const scheduleDays = reminderDaysFromMask(dayMask);
  const schedulingDays = reminderSchedulingDays(repeat, scheduleDays);
  const storedRepeatDays = repeat.days.length ? schedulingDays : [];
  const now = new Date();
  let departureAt = nextReminderDepartureAt(departureTime, storedRepeatDays, now, dayMask);
  let remindAt = new Date(departureAt.getTime() - remindMinutes * 60 * 1000);
  if (remindAt <= now && (storedRepeatDays.length || dayMask)) {
    const after = new Date(now.getTime() + remindMinutes * 60 * 1000);
    departureAt = nextReminderDepartureAt(departureTime, storedRepeatDays, after, dayMask);
    remindAt = new Date(departureAt.getTime() - remindMinutes * 60 * 1000);
  }
  if (remindAt <= now) throw httpError("Для этого рейса выбранное предупреждение уже прошло.", 400);

  const reminder = {
    id: createId(),
    telegramId: user.telegramId,
    routeId: sanitizeText(input.routeId || "", 80),
    directionCode: sanitizeText(input.directionCode || "", 80),
    stopUid: sanitizeText(input.stopUid || "", 120),
    routeNumber: sanitizeText(input.routeNumber || "", 32),
    directionName: sanitizeText(input.directionName || "", 160),
    stopName: sanitizeText(input.stopName || "", 160),
    departureTime,
    dayMask,
    tripCode,
    variantCode,
    departureAt: departureAt.toISOString(),
    remindMinutes,
    remindAt: remindAt.toISOString(),
    repeatMode: repeat.mode,
    repeatDays: storedRepeatDays.join(","),
    createdAt: new Date().toISOString()
  };

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const replaced = db
      .prepare(`
        UPDATE reminders
        SET status = 'cancelled', sent_at = ?, error = 'replaced by newer reminder'
        WHERE status = 'pending'
          AND telegram_id = ?
          AND route_id = ?
          AND direction_code = ?
          AND stop_uid = ?
          AND departure_time = ?
          AND COALESCE(day_mask, '') = ?
          AND COALESCE(trip_code, '') = ?
          AND COALESCE(variant_code, '') = ?
      `)
      .run(
        reminder.createdAt,
        reminder.telegramId,
        reminder.routeId,
        reminder.directionCode,
        reminder.stopUid,
        reminder.departureTime,
        reminder.dayMask,
        reminder.tripCode,
        reminder.variantCode
      );

    db.prepare(`
      INSERT INTO reminders (
        reminder_id, telegram_id, route_id, direction_code, stop_uid, route_number, direction_name, stop_name,
        departure_time, day_mask, trip_code, variant_code, departure_at, remind_minutes, remind_at,
        repeat_mode, repeat_days, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `)
      .run(
        reminder.id,
        reminder.telegramId,
        reminder.routeId,
        reminder.directionCode,
        reminder.stopUid,
        reminder.routeNumber,
        reminder.directionName,
        reminder.stopName,
        reminder.departureTime,
        reminder.dayMask,
        reminder.tripCode,
        reminder.variantCode,
        reminder.departureAt,
        reminder.remindMinutes,
        reminder.remindAt,
        reminder.repeatMode,
        reminder.repeatDays,
        reminder.createdAt
      );

    db.exec("COMMIT");
    reminder.replacedCount = replaced.changes || 0;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return reminder;
}

function cancelReminder(id, user) {
  if (!user?.telegramId) throw httpError("Telegram не передал ID пользователя.", 401);
  const reminderId = sanitizeText(id, 80);
  const db = getDb();
  const item = db
    .prepare(`
      SELECT reminder_id AS id, departure_time AS departureTime, route_number AS routeNumber, stop_name AS stopName
      FROM reminders
      WHERE reminder_id = ? AND telegram_id = ? AND status = 'pending'
    `)
    .get(reminderId, user.telegramId);
  if (!item) throw httpError("Активный будильник не найден.", 404);

  db.prepare("UPDATE reminders SET status = 'cancelled', sent_at = ?, error = 'cancelled by user' WHERE reminder_id = ?")
    .run(new Date().toISOString(), reminderId);

  return { ok: true, reminder: item };
}

function listDueReminders(limit = 50) {
  return getDb()
    .prepare(`
      SELECT reminder_id AS id, telegram_id AS telegramId, route_id AS routeId,
             direction_code AS directionCode, stop_uid AS stopUid,
             route_number AS routeNumber, direction_name AS directionName, stop_name AS stopName,
             departure_time AS departureTime, day_mask AS dayMask, trip_code AS tripCode, variant_code AS variantCode,
             departure_at AS departureAt, remind_minutes AS remindMinutes,
             remind_at AS remindAt, repeat_mode AS repeatMode, repeat_days AS repeatDays, status
      FROM reminders
      WHERE status = 'pending' AND remind_at <= ?
      ORDER BY remind_at
      LIMIT ?
    `)
    .all(new Date().toISOString(), limit);
}

function markReminderDone(id, status, error = "") {
  getDb()
    .prepare("UPDATE reminders SET status = ?, sent_at = ?, error = ? WHERE reminder_id = ?")
    .run(status, new Date().toISOString(), sanitizeText(error, 500), id);
}

function rescheduleReminder(reminder) {
  const repeat = normalizeReminderRepeat(reminder.repeatMode, reminder.repeatDays);
  if (repeat.mode === "once" || !repeat.days.length) {
    markReminderDone(reminder.id, "sent");
    return null;
  }

  // Advance from max(old departure, now): after server downtime the old departure
  // can be days in the past, and stepping only +1 minute from it would make the
  // reminder due again on every 30s tick — a catch-up spam storm for the user.
  const base = Math.max(Date.parse(reminder.departureAt || "") || 0, Date.now());
  const after = new Date(base);
  after.setMinutes(after.getMinutes() + 1);
  const departureAt = nextReminderDepartureAt(reminder.departureTime, repeat.days, after, reminder.dayMask);
  const remindAt = new Date(departureAt.getTime() - Number(reminder.remindMinutes || 0) * 60 * 1000);
  getDb()
    .prepare("UPDATE reminders SET departure_at = ?, remind_at = ?, sent_at = ?, error = '' WHERE reminder_id = ?")
    .run(departureAt.toISOString(), remindAt.toISOString(), new Date().toISOString(), reminder.id);
  return { departureAt: departureAt.toISOString(), remindAt: remindAt.toISOString() };
}

function nextDateForTime(time, now) {
  const [hours, minutes] = time.split(":").map(Number);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function serviceIsoWeekdaysForDate(date) {
  const key = localServiceDateKey(date);
  if (EXTRA_WORK_DAY_REPLACEMENTS.has(key)) return [EXTRA_WORK_DAY_REPLACEMENTS.get(key)];
  if (EXTRA_REST_DAYS.has(key) || isBelarusHolidayDate(date)) return [6, 7];
  return [isoWeekday(date)];
}

function dayMaskIncludesServiceDate(dayMask, date) {
  const value = normalizeReminderDayMask(dayMask);
  if (!value) return false;
  return serviceIsoWeekdaysForDate(date).some((day) => value[day - 1] === "1");
}

function isBelarusHolidayDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const fixed = new Set(["01-01", "01-02", "01-07", "03-08", "05-01", "05-09", "07-03", "11-07", "12-25"]);
  if (fixed.has(`${month}-${day}`)) return true;

  const radunitsa = addCalendarDays(orthodoxEasterDate(date.getFullYear()), 9);
  return localServiceDateKey(date) === localServiceDateKey(radunitsa);
}

function orthodoxEasterDate(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return addCalendarDays(new Date(year, month - 1, day), 13);
}

function addCalendarDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localServiceDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeReminderRepeat(mode, daysInput) {
  const cleanMode = ["once", "weekdays", "weekends", "custom"].includes(String(mode || "")) ? String(mode) : "once";
  if (cleanMode === "weekdays") {
    const days = normalizeReminderRepeatDays(daysInput).filter((day) => day <= 5);
    return { mode: cleanMode, days: days.length ? days : [1, 2, 3, 4, 5] };
  }
  if (cleanMode === "weekends") {
    const days = normalizeReminderRepeatDays(daysInput).filter((day) => day >= 6);
    return { mode: cleanMode, days: days.length ? days : [6, 7] };
  }
  if (cleanMode === "custom") {
    const days = normalizeReminderRepeatDays(daysInput);
    if (days.length) return { mode: cleanMode, days };
  }
  return { mode: "once", days: [] };
}

function normalizeReminderRepeatDays(daysInput) {
  const rawDays = Array.isArray(daysInput) ? daysInput : String(daysInput || "").split(",");
  return [...new Set(rawDays.map((item) => Number(item)).filter((day) => day >= 1 && day <= 7))].sort((a, b) => a - b);
}

function normalizeReminderDayMask(mask) {
  const value = String(mask || "").padEnd(7, "0").slice(0, 7).replace(/[^1]/g, "0");
  return value.includes("1") ? value : "";
}

function reminderDaysFromMask(mask) {
  const value = normalizeReminderDayMask(mask);
  const days = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "1") days.push(index + 1);
  }
  return days;
}

function reminderSchedulingDays(repeat, scheduleDays) {
  if (!scheduleDays.length) return repeat.days;
  if (!repeat.days.length) return scheduleDays;

  const allowed = repeat.days.filter((day) => scheduleDays.includes(day));
  if (allowed.length) return allowed;

  throw httpError("Выбранный рейс не ходит в эти дни. Выберите дни из расписания этого рейса.", 400);
}

function nextReminderDepartureAt(time, repeatDays = [], now = new Date(), dayMask = "") {
  const hasScheduleMask = Boolean(normalizeReminderDayMask(dayMask));
  if (!repeatDays.length && !hasScheduleMask) return nextDateForTime(time, now);
  const [hours, minutes] = time.split(":").map(Number);
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate <= now) continue;
    if (hasScheduleMask && !dayMaskIncludesServiceDate(dayMask, candidate)) continue;
    if (repeatDays.length && !serviceIsoWeekdaysForDate(candidate).some((day) => repeatDays.includes(day))) continue;
    return candidate;
  }
  return nextDateForTime(time, now);
}

function listAdmins() {
  return getDb()
    .prepare(`
      SELECT admin_id AS id, telegram_id AS telegramId, name, role, active,
             tab_number AS tabNumber, driver_squad AS driverSquad,
             created_at AS createdAt, updated_at AS updatedAt
      FROM admins
      ORDER BY active DESC, role, name
    `)
    .all();
}

function saveAdmin(input) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = sanitizeText(input.id || input.adminId || createId(), 80);
  const existing = db
    .prepare("SELECT admin_id, telegram_id AS telegramId, role FROM admins WHERE admin_id = ?")
    .get(id);
  const telegramId = sanitizeText(input.telegramId || "", 60);
  if (telegramId && !/^\d{4,20}$/.test(telegramId)) {
    throw httpError("Telegram ID must contain only digits.", 400);
  }
  const requestedRole = ROLE_LABELS[input.role] ? input.role : "worker";
  const requestedDriverSquad = normalizeDriverSquad(input.driverSquad);
  const admin = {
    id,
    telegramId,
    name: sanitizeText(input.name || "Работник", 120),
    role: requestedRole,
    tabNumber: sanitizeText(input.tabNumber || "", 30).replace(/\D+/g, ""),
    driverSquad: requestedRole === "driver" ? requestedDriverSquad : "",
    active: input.active === false || input.active === 0 || input.active === "0" ? 0 : 1
  };
  if (admin.tabNumber && !/^\d{1,8}$/.test(admin.tabNumber)) {
    throw httpError("Введите корректный табельный номер.", 400);
  }
  if (admin.role === "driver") {
    if (!admin.telegramId) throw httpError("Для водителя нужен Telegram ID.", 400);
    if (!/^\d{2,8}$/.test(admin.tabNumber)) throw httpError("Для водителя укажите табельный номер.", 400);
    admin.driverSquad = admin.driverSquad || "city";
  } else {
    admin.driverSquad = "";
  }

  if (existing) {
    db.prepare("UPDATE admins SET telegram_id = ?, name = ?, role = ?, active = ?, tab_number = ?, driver_squad = ?, updated_at = ? WHERE admin_id = ?")
      .run(admin.telegramId, admin.name, admin.role, admin.active, admin.tabNumber || null, admin.driverSquad, now, id);
  } else {
    db.prepare("INSERT INTO admins (admin_id, telegram_id, name, role, active, tab_number, driver_squad, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, admin.telegramId || null, admin.name, admin.role, admin.active, admin.tabNumber || null, admin.driverSquad, now, now);
  }

  if (admin.role === "driver") {
    if (existing?.telegramId && existing.telegramId !== admin.telegramId) {
      db.prepare("DELETE FROM driver_users WHERE telegram_id = ?").run(existing.telegramId);
    }
    db.prepare(`
      INSERT INTO driver_users (driver_id, telegram_id, tab_number, full_name, driver_squad, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        tab_number = excluded.tab_number,
        full_name = excluded.full_name,
        driver_squad = excluded.driver_squad,
        updated_at = excluded.updated_at
    `).run(id, admin.telegramId, admin.tabNumber, admin.name, admin.driverSquad, now, now);
  } else {
    if (admin.telegramId) db.prepare("DELETE FROM driver_users WHERE telegram_id = ?").run(admin.telegramId);
    if (existing?.telegramId && existing.telegramId !== admin.telegramId) {
      db.prepare("DELETE FROM driver_users WHERE telegram_id = ?").run(existing.telegramId);
    }
  }

  return db
    .prepare("SELECT admin_id AS id, telegram_id AS telegramId, name, role, active, tab_number AS tabNumber, driver_squad AS driverSquad FROM admins WHERE admin_id = ?")
    .get(id);
}

function listLeadershipContacts(options = {}) {
  const includeInactive = options.includeInactive === true;
  const where = includeInactive ? "" : "WHERE active = 1";
  return getDb()
    .prepare(`
      SELECT contact_id AS id, name, position, department, phone, phone_label AS phoneLabel,
             email, note, photo_url AS photoUrl, featured, active, sort_order AS sortOrder,
             created_at AS createdAt, updated_at AS updatedAt
      FROM leadership_contacts
      ${where}
      ORDER BY active DESC, sort_order ASC, name ASC
    `)
    .all();
}

function saveLeadershipContact(input) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = sanitizeText(input.id || input.contactId || createId(), 80);
  const existing = db.prepare("SELECT contact_id FROM leadership_contacts WHERE contact_id = ?").get(id);
  const maxSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM leadership_contacts").get().value;
  const item = {
    id,
    name: sanitizeText(input.name, 160),
    position: sanitizeText(input.position, 220),
    department: sanitizeText(input.department || "Руководство", 120),
    phone: sanitizeText(input.phone || "", 80),
    phoneLabel: sanitizeText(input.phoneLabel || "", 80),
    email: sanitizeText(input.email || "", 160),
    note: sanitizeText(input.note || "", 300),
    photoUrl: sanitizeText(input.photoUrl || "", 500),
    featured: input.featured === true || input.featured === "on" || input.featured === "1" ? 1 : 0,
    active: input.active === false || input.active === 0 || input.active === "0" ? 0 : 1,
    sortOrder: Number.parseInt(input.sortOrder, 10) || maxSort + 1
  };
  if (!item.name || !item.position) throw new Error("Укажите имя и должность.");

  if (existing) {
    db.prepare(`
      UPDATE leadership_contacts
      SET name = ?, position = ?, department = ?, phone = ?, phone_label = ?, email = ?,
          note = ?, photo_url = ?, featured = ?, active = ?, sort_order = ?, updated_at = ?
      WHERE contact_id = ?
    `).run(
      item.name, item.position, item.department, item.phone, item.phoneLabel, item.email,
      item.note, item.photoUrl, item.featured, item.active, item.sortOrder, now, id
    );
  } else {
    db.prepare(`
      INSERT INTO leadership_contacts (
        contact_id, name, position, department, phone, phone_label, email, note, photo_url,
        featured, active, sort_order, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, item.name, item.position, item.department, item.phone, item.phoneLabel, item.email,
      item.note, item.photoUrl, item.featured, item.active, item.sortOrder, now, now
    );
  }

  return listLeadershipContacts({ includeInactive: true }).find((contact) => contact.id === id);
}

function deleteLeadershipContact(id) {
  const db = getDb();
  const contact = db
    .prepare(`
      SELECT contact_id AS id, name, position, department, phone, phone_label AS phoneLabel,
             email, note, photo_url AS photoUrl, featured, active, sort_order AS sortOrder
      FROM leadership_contacts
      WHERE contact_id = ?
    `)
    .get(id);
  if (!contact) throw new Error("Контакт не найден.");
  db.prepare("DELETE FROM leadership_contacts WHERE contact_id = ?").run(id);
  return { ok: true, deleted: contact };
}

function groupBy(rows, key) {
  const map = new Map();
  rows.forEach((row) => {
    const value = row[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  });
  return map;
}

function createId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function getDeparture(id) {
  return getDb()
    .prepare(`
      SELECT departure_id AS id, route_id AS routeId, direction_code AS directionCode,
             stop_uid AS stopUid, day_mask AS dayMask, day_name AS dayName,
             departure_time AS time, departure_minutes AS minutes, arrival_time AS arrivalTime,
             trip_code AS tripCode, variant_code AS variantCode, notes
      FROM departures
      WHERE departure_id = ?
    `)
    .get(Number(id));
}

function listTripDepartures(departure) {
  return getDb()
    .prepare(`
      SELECT dep.departure_id AS id, dep.route_id AS routeId, dep.direction_code AS directionCode,
             dep.stop_uid AS stopUid, s.name AS stopName, s.position,
             dep.day_mask AS dayMask, dep.day_name AS dayName,
             dep.departure_time AS time, dep.departure_minutes AS minutes,
             dep.arrival_time AS arrivalTime, dep.trip_code AS tripCode,
             dep.variant_code AS variantCode, dep.notes
      FROM departures dep
      JOIN stops s ON s.stop_uid = dep.stop_uid
      WHERE dep.route_id = ? AND dep.direction_code = ? AND dep.day_mask = ?
        AND dep.trip_code = ? AND dep.variant_code = ?
      ORDER BY s.position
    `)
    .all(departure.routeId, departure.directionCode, departure.dayMask, departure.tripCode, departure.variantCode);
}

function getScheduleMetaSnapshot({ routeId, directionCode, stopUid }) {
  const db = getDb();
  const route = routeId
    ? db.prepare("SELECT route_id AS id, number, name, color, updated_at AS updatedAt FROM routes WHERE route_id = ?").get(routeId)
    : null;
  const direction = routeId && directionCode
    ? db.prepare(`
        SELECT direction_code AS code, name, origin AS "from", destination AS "to", position
        FROM directions
        WHERE route_id = ? AND direction_code = ?
      `).get(routeId, directionCode)
    : null;
  const stop = stopUid
    ? db.prepare("SELECT stop_uid AS id, name, position FROM stops WHERE stop_uid = ?").get(stopUid)
    : null;
  return { route, direction, stop };
}

function logScheduleAudit(db, input) {
  db.prepare(`
    INSERT INTO schedule_audit (
      action, entity_type, entity_id, route_id, direction_code, stop_uid,
      before_json, after_json, actor, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sanitizeText(input.action || "update", 40),
    sanitizeText(input.entityType || "schedule", 60),
    sanitizeText(input.entityId || "", 120),
    sanitizeText(input.routeId || "", 80),
    sanitizeText(input.directionCode || "", 40),
    sanitizeText(input.stopUid || "", 160),
    input.before === undefined || input.before === null ? "" : JSON.stringify(input.before),
    input.after === undefined || input.after === null ? "" : JSON.stringify(input.after),
    sanitizeText(input.actor || "admin", 120),
    new Date().toISOString()
  );
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw httpError("Время должно быть в формате ЧЧ:ММ.", 400);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw httpError("Проверьте время отправления.", 400);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function minutesFromTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function timeFromMinutes(value) {
  const minutes = wrapDayMinutes(value);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function wrapDayMinutes(value) {
  return ((value % 1440) + 1440) % 1440;
}

function normalizeDayMask(value) {
  const mask = String(value || "").trim();
  if (!/^[01]{7}$/.test(mask)) throw httpError("Выберите дни движения.", 400);
  if (!mask.includes("1")) throw httpError("Нужен хотя бы один день движения.", 400);
  return mask;
}

function dayNameFromMask(mask) {
  if (mask === "1111100") return "Рабочие дни";
  if (mask === "0000011") return "Выходные дни";
  if (mask === "1111111") return "Ежедневно";
  return "Особый график";
}

function sanitizeText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeDisplaySeconds(value) {
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) return 7;
  return Math.max(3, Math.min(30, seconds));
}

// Memoized: stop/route names repeat thousands of times per schedule build, and
// toLocaleLowerCase("ru-RU") + 3 regexes measured at ~22% of the cold getSchedule
// path. Bounded cache; the name universe is small (~4k stops).
const normalizeNameCache = new Map();

function normalizeName(value) {
  const key = String(value || "");
  const cached = normalizeNameCache.get(key);
  if (cached !== undefined) return cached;
  const normalized = key
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalizeNameCache.size > 30000) normalizeNameCache.clear();
  normalizeNameCache.set(key, normalized);
  return normalized;
}

function escapeLikePattern(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addLocalDays(date, days) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function toLocalDateOnly(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = {
  DB_PATH,
  STATUS_LABELS,
  ROLE_LABELS,
  PERMISSIONS,
  getDb,
  invalidateScheduleCache,
  ensureRoute17,
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
  createScheduleBackup,
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
  getDriverByTelegramId,
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
  getLatestDutyRosterItemForTelegram,
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
  normalizeName,
  createId
};
