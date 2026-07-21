const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT_DIR = path.resolve(__dirname, "..");

loadEnvFile(path.join(ROOT_DIR, ".env"));

const { listAdmins } = require("../db");

const args = parseArgs(process.argv.slice(2));
const telegramId = args.telegramId || process.env.LOCAL_ADMIN_TELEGRAM_ID || "";
const admins = listAdmins();
const admin = findAdmin(admins, telegramId);

if (!process.env.BOT_TOKEN) {
  fail("BOT_TOKEN is required to sign Telegram initData.");
}

if (!admin) {
  const hint = telegramId
    ? `No active saved administrator was found for Telegram ID ${maskId(telegramId)}.`
    : "No active saved administrator with Telegram ID was found.";
  fail(`${hint}\nAdd your Telegram ID to ADMIN_IDS, restart the server once, then run this script again.`);
}

const initData = createInitData(admin, process.env.BOT_TOKEN);
const ttlMs = Math.max(60_000, Number(process.env.TELEGRAM_INIT_DATA_TTL_MS) || 24 * 60 * 60 * 1000);
const expiresAt = new Date(Date.now() + ttlMs).toISOString();

console.log(`Saved admin: ${admin.name || "Admin"} (${maskId(admin.telegramId)})`);
console.log(`Valid until about: ${expiresAt}`);
console.log("");
console.log("Paste this into DevTools Console on the localhost admin page:");
console.log(`sessionStorage.setItem("adminTelegramInitData", ${JSON.stringify(initData)}); location.reload();`);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
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

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg.startsWith("--telegram-id=")) parsed.telegramId = arg.slice("--telegram-id=".length).trim();
  }
  return parsed;
}

function findAdmin(admins, telegramId) {
  return admins.find((item) => {
    if (item.role !== "admin" || Number(item.active) === 0 || !item.telegramId) return false;
    return !telegramId || String(item.telegramId) === String(telegramId);
  });
}

function createInitData(admin, botToken) {
  const authDate = Math.floor(Date.now() / 1000);
  const idNumber = Number(admin.telegramId);
  const id = Number.isSafeInteger(idNumber) ? idNumber : String(admin.telegramId);
  const user = {
    id,
    first_name: firstName(admin.name),
    last_name: "",
    username: "local_admin",
    language_code: "ru"
  };

  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("query_id", `local-${crypto.randomBytes(8).toString("hex")}`);
  params.set("user", JSON.stringify(user));

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

function firstName(name) {
  return String(name || "Local Admin").trim().split(/\s+/)[0] || "Local Admin";
}

function maskId(value) {
  const text = String(value || "");
  if (text.length <= 3) return "***";
  return `${"*".repeat(Math.max(0, text.length - 3))}${text.slice(-3)}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
