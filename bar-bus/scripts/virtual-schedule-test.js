const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sourceDb = path.join(__dirname, "..", "data", "app.db");
const testDb = path.join(os.tmpdir(), `bar-bus-virtual-schedule-${Date.now()}.db`);

fs.copyFileSync(sourceDb, testDb);
process.env.DATABASE_PATH = testDb;
process.env.REQUIRE_TELEGRAM_AUTH = "false";
process.env.BOT_TOKEN = "";
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "virtual-schedule-admin-key";
process.env.ALLOW_ADMIN_ROLE_OVERRIDE = "true";

const { startHttpServer } = require("../server");
const {
  createScheduledRouteImport,
  getDb,
  getSchedule,
  getTripTimeline,
  invalidateScheduleCache,
  listDueScheduledRouteImports,
  listRoutes,
  saveDeparture
} = require("../db");
const { inspectRouteImportFiles } = require("../route-importer");

const VIRTUAL_DEPARTURES = Math.max(60, Math.min(Number(process.env.VIRTUAL_SCHEDULE_DEPARTURES) || 360, 1440));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(action, message) {
  let threw = false;
  try {
    action();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

function toTime(totalMinutes) {
  const minutes = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function firstRouteWithTwoStops() {
  const route = listRoutes().find((candidate) =>
    (candidate.directions || []).some((direction) => (direction.stops || []).length >= 2)
  );
  const direction = route?.directions.find((candidate) => (candidate.stops || []).length >= 2);
  assert(route && direction, "Need at least one route direction with two stops for virtual checks");
  return { route, direction, stops: direction.stops.slice(0, 2) };
}

function insertDeparture(db, input) {
  db.prepare(`
    INSERT INTO departures (
      route_id, direction_code, stop_uid, day_mask, day_name,
      departure_time, departure_minutes, arrival_time, trip_code, variant_code, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.routeId,
    input.directionCode,
    input.stopUid,
    input.dayMask || "1111100",
    input.dayName || "Virtual weekdays",
    input.time,
    input.minutes,
    input.arrivalTime || input.time,
    input.tripCode,
    input.variantCode || "virtual",
    input.notes || "virtual schedule QA"
  );
}

function runCrossMidnightScenario(db, route, direction, stops) {
  const tripCode = `virtual-night-${Date.now()}`;
  insertDeparture(db, {
    routeId: route.id,
    directionCode: direction.code,
    stopUid: stops[0].id,
    time: "23:50",
    minutes: 23 * 60 + 50,
    tripCode
  });
  insertDeparture(db, {
    routeId: route.id,
    directionCode: direction.code,
    stopUid: stops[1].id,
    time: "00:10",
    minutes: 10,
    tripCode
  });
  invalidateScheduleCache();

  const schedule = getSchedule({ routeId: route.id, directionCode: direction.code, stopUid: stops[0].id });
  const nightTrip = schedule.groups.flatMap((group) => group.times).find((time) => time.tripCode === tripCode);
  assert(nightTrip, "Cross-midnight virtual trip should be visible at the first stop");
  assert(nightTrip.tripStartTime === "23:50", "Cross-midnight trip should keep the start time");
  assert(nightTrip.tripEndTime === "00:10", "Cross-midnight trip should keep the next-day end time");
  assert(nightTrip.tripEndMinutes > nightTrip.tripStartMinutes, "Cross-midnight trip should sort as next-day travel");

  const timeline = getTripTimeline({
    routeId: route.id,
    directionCode: direction.code,
    dayMask: "1111100",
    tripCode,
    variantCode: "virtual"
  });
  assert(timeline.some((stop) => stop.time === "23:50"), "Timeline should include the night trip start");
  assert(timeline.some((stop) => stop.time === "00:10"), "Timeline should include the night trip next-day stop");
  return tripCode;
}

function runGrowthScenario(db, route, direction, stop) {
  const prefix = `virtual-growth-${Date.now()}`;
  for (let index = 0; index < VIRTUAL_DEPARTURES; index += 1) {
    const minutes = (4 * 60 + index * 3) % 1440;
    insertDeparture(db, {
      routeId: route.id,
      directionCode: direction.code,
      stopUid: stop.id,
      time: toTime(minutes),
      minutes,
      tripCode: `${prefix}-${index}`,
      variantCode: "growth"
    });
  }
  invalidateScheduleCache();

  const started = performance.now();
  const schedule = getSchedule({ routeId: route.id, directionCode: direction.code, stopUid: stop.id });
  const elapsedMs = performance.now() - started;
  const virtualTimes = schedule.groups
    .flatMap((group) => group.times)
    .filter((time) => String(time.tripCode || "").startsWith(prefix));

  assert(virtualTimes.length === VIRTUAL_DEPARTURES, "Virtual schedule growth should not drop generated departures");
  assert(elapsedMs < 5000, `Virtual schedule lookup is unexpectedly slow: ${Math.round(elapsedMs)}ms`);
  return { prefix, elapsedMs, count: virtualTimes.length };
}

function runAdminValidationScenario(route, direction, stop) {
  expectThrow(
    () => saveDeparture({ routeId: route.id, directionCode: direction.code, stopUid: stop.id, dayMask: "0000000", time: "08:00" }),
    "Admin schedule editor should reject empty service-day masks"
  );
  expectThrow(
    () => saveDeparture({ routeId: route.id, directionCode: direction.code, stopUid: stop.id, dayMask: "1111100", time: "24:00" }),
    "Admin schedule editor should reject 24:00 as a manual departure time"
  );
  expectThrow(
    () => saveDeparture({ routeId: "missing", directionCode: direction.code, stopUid: stop.id, dayMask: "1111100", time: "08:00" }),
    "Admin schedule editor should reject stops outside the selected route"
  );
}

function routeXml({ number = "900", dayMask = "1111100", withDepartures = true } = {}) {
  const stops = ["Alpha", "Beta", "Gamma"];
  const trips = ["A", "B", "C"];
  const stopXml = stops.map((stopName, stopIndex) => {
    const times = withDepartures
      ? trips.map((trip, tripIndex) => {
        const minutes = 6 * 60 + tripIndex * 45 + stopIndex * 7;
        return [
          "<Time>",
          `<departureTime>${toTime(minutes)}</departureTime>`,
          `<arrivalTime>${toTime(minutes)}</arrivalTime>`,
          `<kodElem>${trip}</kodElem>`,
          "<kodVariant>main</kodVariant>",
          "</Time>"
        ].join("");
      }).join("")
      : "";
    return [
      `<BusStop id="${stopIndex + 1}">`,
      `<num>${stopIndex + 1}</num>`,
      `<name>${stopName}</name>`,
      "<direction>0</direction>",
      `<Day id="${dayMask}">`,
      "<name>Weekdays</name>",
      times,
      "</Day>",
      "</BusStop>"
    ].join("");
  }).join("");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Route id="${number}">`,
    `<num>${number}</num>`,
    `<name>Route ${number} Alpha - Gamma</name>`,
    "<nvid>city</nvid>",
    stopXml,
    "</Route>"
  ].join("");
}

function runXmlImportScenarios() {
  const validXml = routeXml({ number: "900" });
  const preview = inspectRouteImportFiles(
    [{ name: "900.xml", text: validXml }],
    { expectedRouteNumber: "900", transportType: "city" }
  );
  assert(preview.routes.length === 1, "Virtual XML preview should contain one route");
  assert(preview.routes[0].stops >= 2, "Virtual XML preview should contain passenger stops");
  assert(preview.daySummary.weekdays > 0, "Virtual XML preview should count weekday departures");

  expectThrow(
    () => inspectRouteImportFiles([{ name: "901.xml", text: routeXml({ number: "901", dayMask: "0000000" }) }]),
    "XML importer should reject empty day masks"
  );
  expectThrow(
    () => inspectRouteImportFiles([{ name: "902.xml", text: routeXml({ number: "902", withDepartures: false }) }]),
    "XML importer should reject routes without departures"
  );
  expectThrow(
    () => inspectRouteImportFiles([{ name: "900.xml", text: validXml }], { expectedRouteNumber: "901" }),
    "XML importer should reject a file for the wrong selected route"
  );

  return validXml;
}

function runScheduledImportScenario(validXml) {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduled = createScheduledRouteImport({
    routeNumber: "900",
    routeName: "Route 900 Alpha - Gamma",
    files: [{ name: "900.xml", text: validXml }],
    effectiveAt: future,
    createdBy: "virtual-schedule-test",
    summary: { transportType: "city" }
  });
  assert(scheduled.status === "pending", "Future virtual import should be stored as pending");
  assert(!listDueScheduledRouteImports(20).some((item) => item.id === scheduled.id), "Future virtual import should not be due early");
  return scheduled.id;
}

async function readJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return data;
}

(async () => {
  const db = getDb();
  const { route, direction, stops } = firstRouteWithTwoStops();

  const nightTrip = runCrossMidnightScenario(db, route, direction, stops);
  const growth = runGrowthScenario(db, route, direction, stops[0]);
  runAdminValidationScenario(route, direction, stops[0]);
  const validXml = runXmlImportScenarios();
  const scheduledImportId = runScheduledImportScenario(validXml);

  const server = await startHttpServer(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const query = new URLSearchParams({
      routeId: route.id,
      directionCode: direction.code,
      stopUid: stops[0].id
    });
    const apiSchedule = await readJson(`${baseUrl}/api/schedule?${query}`);
    assert(
      apiSchedule.groups.flatMap((group) => group.times).some((time) => time.tripCode === nightTrip),
      "Public schedule API should expose the virtual cross-midnight trip"
    );

    const badSchedule = await fetch(`${baseUrl}/api/schedule?routeId=bad-route&directionCode=bad-direction&stopUid=bad-stop`);
    assert(badSchedule.status === 404, "Public schedule API should reject mismatched route/direction/stop ids");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(JSON.stringify({
    ok: true,
    route: route.number,
    direction: direction.code,
    virtualDepartures: growth.count,
    scheduleLookupMs: Math.round(growth.elapsedMs),
    nightTrip,
    scheduledImportId,
    testDb
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
