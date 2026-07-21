const fs = require("node:fs");
const path = require("node:path");
const { importRoutesFromXmlFiles } = require("../route-importer");

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const SOURCE_DIR = positional[0] || process.env.XML_IMPORT_DIR;
const TRANSPORT_TYPE = positional[1] || process.env.XML_TRANSPORT_TYPE;
const MODE = flags.has("--upsert") ? "upsert" : "replace_all";
const CONFIRM_FULL_REPLACE = flags.has("--full-replace")
  || flags.has("--yes")
  || process.env.CONFIRM_FULL_REPLACE === "true";

if (!SOURCE_DIR) {
  console.error('Specify XML folder: node scripts/import-routes.js "C:\\path\\to\\routes" city|suburban|intercity [--full-replace|--upsert]');
  process.exit(1);
}

if (!["city", "suburban", "intercity"].includes(TRANSPORT_TYPE)) {
  console.error("Specify schedule type: city, suburban or intercity.");
  process.exit(1);
}

if (!fs.existsSync(SOURCE_DIR)) {
  console.error(`Folder not found: ${SOURCE_DIR}`);
  process.exit(1);
}

function collectXmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectXmlFiles(fullPath);
    if (!entry.isFile() || !entry.name.toLocaleLowerCase("ru-RU").endsWith(".xml")) return [];
    return [{
      name: path.relative(SOURCE_DIR, fullPath),
      buffer: fs.readFileSync(fullPath)
    }];
  });
}

const files = collectXmlFiles(SOURCE_DIR);

if (!files.length) {
  console.error("No XML files found.");
  process.exit(1);
}

try {
  const result = importRoutesFromXmlFiles(files, {
    source: SOURCE_DIR,
    actor: "cli-import",
    mode: MODE,
    transportType: TRANSPORT_TYPE,
    confirmFullReplace: CONFIRM_FULL_REPLACE
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.code === "FULL_REPLACE_CONFIRMATION_REQUIRED") {
    console.error(
      "\nЭта папка содержит меньше маршрутов, чем уже есть в базе. Варианты:\n"
        + "  • добавить/обновить только эти маршруты, не трогая остальные:  --upsert\n"
        + "  • действительно заменить ВСЕ маршруты этого типа целиком:      --full-replace"
    );
  }
  process.exit(1);
}
