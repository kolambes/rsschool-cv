const {
  parseDutyRoster,
  formatDutyRosterMessage
} = require("../duty-roster");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function row(cells) {
  return cells.join(";");
}

function makeRosterRow(first = {}, second = {}) {
  const cells = Array(20).fill("");
  cells[0] = first.exit || "";
  cells[1] = first.start || "";
  cells[2] = first.end || "";
  cells[6] = first.plate || "";
  cells[7] = first.garage || "";
  cells[8] = first.tab || "";
  cells[9] = first.driver || "";
  cells[10] = second.exit || "";
  cells[11] = second.start || "";
  cells[12] = second.end || "";
  cells[16] = second.plate || "";
  cells[17] = second.garage || "";
  cells[18] = second.tab || "";
  cells[19] = second.driver || "";
  return row(cells);
}

const header = row([
  "Выезд",
  "Время",
  "",
  "",
  "",
  "",
  "Гос",
  "Гараж",
  "Таб",
  "Водитель 1",
  "Выезд",
  "Время",
  "",
  "",
  "",
  "",
  "Гос",
  "Гараж",
  "Таб",
  "Водитель 2"
]);

const subHeader = row([
  "",
  "вых",
  "возвращ",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "вых",
  "возвращ",
  "",
  "",
  "",
  "",
  "",
  "",
  ""
]);

const parsed = parseDutyRoster([
  "Разнарядка на 15.06.2026",
  header,
  subHeader,
  makeRosterRow(
    { exit: "9", start: "08:00", end: "12:00", tab: "1001", driver: "ИВАНОВ И И" },
    { exit: "911", start: "07:30", end: "16:23", plate: "AE0128-1", garage: "11670", tab: "1002", driver: "ПЕТРОВ П П" }
  ),
  makeRosterRow(
    { exit: "9", start: "13:00", end: "18:00", plate: "AK1234-1", garage: "10100", tab: "1003", driver: "СИДОРОВ С С" },
    {}
  ),
  makeRosterRow(
    { exit: "919", start: "18:00", end: "20:00", tab: "1004", driver: "НИКОЛАЕВ Н Н" },
    {}
  )
].join("\n"));

const reserve = parsed.items.find((item) => item.tabNumber === "1001");
const routeNine = parsed.items.find((item) => item.tabNumber === "1002");
const shortRouteNine = parsed.items.find((item) => item.tabNumber === "1003");
const ambiguous = parsed.items.find((item) => item.tabNumber === "1004");

assert(reserve, "Reserve item should be parsed");
assert(reserve.assignmentType === "reserve", "Standalone code 9 without a vehicle should be reserve");
assert(!reserve.route, "Reserve should not be saved as route 9");
assert(formatDutyRosterMessage(reserve).includes("Резерв"), "Reserve message should mention reserve");
assert(!formatDutyRosterMessage(reserve).includes("Маршрут: 9"), "Reserve message should not mention route 9");

assert(routeNine, "Route 9 item should be parsed");
assert(routeNine.assignmentType === "route", "Code 911 should stay a route assignment");
assert(routeNine.route === "9", "Code 911 should parse route 9");
assert(routeNine.routeCarNumber === "1", "Code 911 should parse car number 1");
assert(routeNine.shift === "1", "Code 911 should parse shift 1");
assert(formatDutyRosterMessage(routeNine).includes("Маршрут: 9"), "Route 9 message should mention route 9");

assert(shortRouteNine, "Short route 9 item should be parsed");
assert(shortRouteNine.assignmentType === "route", "Standalone code 9 with a vehicle should be route 9");
assert(shortRouteNine.route === "9", "Standalone code 9 with a vehicle should parse route 9");

assert(ambiguous, "Ambiguous item should be parsed for review");
assert(ambiguous.assignmentType === "unknown", "Code 919 should not silently become route 9");
assert(!ambiguous.route, "Code 919 should not have a route without review");
assert(parsed.warnings.length === 1, "Code 919 should add one parser warning");

const invalidTimeParsed = parseDutyRoster([
  "Roster 16.06.2026",
  header,
  subHeader,
  makeRosterRow(
    { exit: "911", start: "24:30", end: "25:00", plate: "AK4321-1", garage: "10101", tab: "2001", driver: "TEST DRIVER" },
    {}
  )
].join("\n"));

assert(invalidTimeParsed.items.length === 1, "Invalid time row should still be available for review");
assert(invalidTimeParsed.warnings.length === 2, "Invalid start and end times should add parser warnings");
assert(invalidTimeParsed.warnings.every((warning) => /Invalid roster/.test(warning.message)), "Invalid time warnings should be explicit");

const duplicateCarParsed = parseDutyRoster([
  "Roster 17.06.2026",
  header,
  subHeader,
  makeRosterRow({ exit: "111", start: "08:00", end: "12:00", plate: "AA0001-1", garage: "11001", tab: "2101", driver: "DOUBLE DRIVER" }),
  makeRosterRow({ exit: "121", start: "08:00", end: "12:00", plate: "AA0001-1", garage: "11001", tab: "2101", driver: "DOUBLE DRIVER" })
].join("\n"));
const duplicateCarItems = duplicateCarParsed.items.filter((item) => item.tabNumber === "2101");
assert(duplicateCarItems.length === 2, "Different route car numbers should not be deduplicated");
assert(new Set(duplicateCarItems.map((item) => item.routeCarNumber)).size === 2, "Both route car numbers should survive deduplication");

const replacementParsed = parseDutyRoster([
  "Roster 18.06.2026",
  header,
  subHeader,
  makeRosterRow({ exit: "111", start: "06:00", end: "10:00", plate: "AA0002-1", garage: "11002", tab: "2201", driver: "FIRST DRIVER" }),
  makeRosterRow({ exit: "112", start: "10:00", end: "14:00", plate: "AA0002-1", garage: "11002", tab: "2202", driver: "SECOND DRIVER" }),
  makeRosterRow({ exit: "111", start: "14:00", end: "18:00", plate: "AA0002-1", garage: "11002", tab: "2203", driver: "THIRD DRIVER" })
].join("\n"));
const firstDriver = replacementParsed.items.find((item) => item.tabNumber === "2201");
assert(firstDriver.replacementTabNumber === "2202", "Replacement driver should be the next adjacent shift by time");

const invalidDateParsed = parseDutyRoster([
  "Roster 32.13.2026",
  header,
  subHeader,
  makeRosterRow({ exit: "111", start: "08:00", end: "12:00", plate: "AA0003-1", garage: "11003", tab: "2301", driver: "DATE DRIVER" })
].join("\n"));
assert(invalidDateParsed.scheduleDate !== "2026-13-32", "Invalid calendar dates should not be saved");
assert(invalidDateParsed.warnings.some((warning) => /Invalid roster date/.test(warning.message)), "Invalid calendar dates should add parser warnings");

const emptyRowParsed = parseDutyRoster([
  "Roster 19.06.2026",
  header,
  subHeader,
  makeRosterRow({ tab: "2401", driver: "EMPTY DRIVER" })
].join("\n"));
assert(emptyRowParsed.items.length === 0, "Rows with only tab number and driver name should be ignored");

const overlapParsed = parseDutyRoster([
  "Roster 20.06.2026",
  header,
  subHeader,
  makeRosterRow({ exit: "111", start: "08:00", end: "16:00", plate: "AA0004-1", garage: "11004", tab: "2501", driver: "OVERLAP DRIVER" }),
  makeRosterRow({ exit: "121", start: "09:00", end: "17:00", plate: "BB0004-1", garage: "22004", tab: "2501", driver: "OVERLAP DRIVER" })
].join("\n"));
assert(overlapParsed.warnings.some((warning) => /Overlapping roster shifts/.test(warning.message)), "Overlapping shifts for one driver should add parser warnings");

const overnightParsed = parseDutyRoster([
  "Roster 21.06.2026",
  header,
  subHeader,
  makeRosterRow({ exit: "111", start: "23:30", end: "01:00", plate: "AA0005-1", garage: "11005", tab: "2601", driver: "NIGHT DRIVER" })
].join("\n"));
const overnightItem = overnightParsed.items.find((item) => item.tabNumber === "2601");
assert(formatDutyRosterMessage(overnightItem).includes("(+1 day)"), "Overnight roster message should mark the next-day end time");

console.log(JSON.stringify({
  ok: true,
  items: parsed.items.length,
  reserve: reserve.assignmentType,
  routeNine: `${routeNine.route}-${routeNine.routeCarNumber}-${routeNine.shift}`,
  shortRouteNine: shortRouteNine.route,
  warnings: parsed.warnings.length
}, null, 2));
