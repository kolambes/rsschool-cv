const { TextDecoder } = require("node:util");
const { getDb, ensureRoute17, normalizeName, createId, invalidateScheduleCache, createScheduleBackup } = require("./db");

const decoder1251 = new TextDecoder("windows-1251");
const decoderUtf8 = new TextDecoder("utf-8");
const LINKED_SEGMENT_MAX_GAP_MINUTES = 5;
const colors = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#0891b2",
  "#ea580c",
  "#0f766e",
  "#be123c",
  "#4f46e5",
  "#65a30d"
];

function importRoutesFromXmlFiles(inputFiles, options = {}) {
  const { parsedFiles } = inspectRouteImportFiles(inputFiles, options);
  const mode = options.mode === "replace_all" ? "replace_all" : "upsert";
  const forcedKind = transportKindFromType(options.transportType || options.transportTypeOverride || "");

  if (mode === "replace_all" && !forcedKind) {
    throw new Error("Choose schedule type before full XML replace.");
  }

  const db = getDb();

  if (mode === "replace_all") {
    // Full replace deletes EVERY route of this transport kind, then loads only the
    // uploaded files. Importing a partial folder would silently wipe the rest, so
    // require an explicit confirmation whenever we'd delete more than we import.
    const importedNumbers = new Set(
      parsedFiles.map(({ parsed }) => normalizeRouteNumber(parsed.route.number)).filter(Boolean)
    );
    const existingCount = countRoutesByTransportKind(db, forcedKind);
    if (existingCount > importedNumbers.size && !options.confirmFullReplace) {
      const error = new Error(
        `Полная замена удалит ${existingCount} маршрутов этого типа, а в загрузке только ${importedNumbers.size}. `
          + "Подтвердите полную замену или используйте режим обновления (upsert), чтобы не удалить остальные маршруты."
      );
      error.statusCode = 409;
      error.code = "FULL_REPLACE_CONFIRMATION_REQUIRED";
      error.details = { existingCount, importedCount: importedNumbers.size, transportKind: forcedKind };
      throw error;
    }
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    const backup = createScheduleBackup(
      {
        label: mode === "replace_all" ? "Перед полной заменой XML" : "Перед обновлением XML",
        actor: options.actor || "admin"
      },
      db
    );

    if (mode === "replace_all") {
      deleteRoutesByTransportKind(db, forcedKind);
    } else {
      deleteExistingImportedRoutes(db, parsedFiles);
    }

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
        route_id, direction_code, stop_uid, day_mask, day_name, departure_time, departure_minutes,
        arrival_time, trip_code, variant_code, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBatch = db.prepare(`
      INSERT INTO import_batches (id, source_dir, imported_at, route_count, stop_count, departure_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertAudit = db.prepare(`
      INSERT INTO schedule_audit (
        action, entity_type, entity_id, route_id, direction_code, stop_uid,
        before_json, after_json, actor, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let routeCount = 0;
    let stopCount = 0;
    let departureCount = 0;
    const importedFiles = [];

    parsedFiles.forEach(({ file, parsed }) => {
      insertRoute.run(
        parsed.route.id,
        parsed.route.number,
        parsed.route.name,
        parsed.route.rawName,
        parsed.route.transportType,
        parsed.route.color,
        parsed.route.dateStart,
        parsed.route.dateExp,
        parsed.route.sourceFile,
        parsed.route.updatedAt
      );
      routeCount += 1;
      importedFiles.push(file.name);

      parsed.directions.forEach((direction) => {
        insertDirection.run(
          direction.id,
          parsed.route.id,
          direction.code,
          direction.name,
          direction.from,
          direction.to,
          direction.position
        );
      });

      parsed.stops.forEach((stop) => {
        insertStop.run(
          stop.uid,
          parsed.route.id,
          stop.directionCode,
          stop.exportStopId,
          stop.name,
          stop.normalizedName,
          stop.position
        );
        stopCount += 1;
      });

      parsed.departures.forEach((departure) => {
        insertDeparture.run(
          parsed.route.id,
          departure.directionCode,
          departure.stopUid,
          departure.dayMask,
          departure.dayName,
          departure.departureTime,
          departure.departureMinutes,
          departure.arrivalTime,
          departure.tripCode,
          departure.variantCode,
          departure.notes
        );
        departureCount += 1;
      });
    });

    const now = new Date().toISOString();
    const batchId = createId();
    const source = options.source || "admin-xml-upload";
    insertBatch.run(batchId, source, now, routeCount, stopCount, departureCount);

    const shouldEnsureRoute17 = parsedFiles.some(({ parsed }) => transportKindFromType(parsed.route.transportType) === "city");
    const supplemental = shouldEnsureRoute17 ? ensureRoute17(db) : { routeCount: 0, stopCount: 0, departureCount: 0 };
    routeCount += supplemental.routeCount;
    stopCount += supplemental.stopCount;
    departureCount += supplemental.departureCount;
    const daySummary = summarizeImportedDays(parsedFiles);

    insertAudit.run(
      "import_xml",
      "schedule_import",
      batchId,
      "",
      "",
      "",
      "",
      JSON.stringify({ mode, files: importedFiles, importedRoutes: routeCount, importedStops: stopCount, importedDepartures: departureCount, daySummary }),
      options.actor || "admin",
      now
    );

    const totals = {
      routes: db.prepare("SELECT COUNT(*) AS count FROM routes").get().count,
      stops: db.prepare("SELECT COUNT(*) AS count FROM stops").get().count,
      departures: db.prepare("SELECT COUNT(*) AS count FROM departures").get().count
    };

    db.exec("COMMIT");
    invalidateScheduleCache();
    return {
      ok: true,
      batchId,
      mode,
      backup,
      files: importedFiles.length,
      importedRoutes: routeCount,
      importedStops: stopCount,
      importedDepartures: departureCount,
      routes: totals.routes,
      stops: totals.stops,
      departures: totals.departures,
      daySummary,
      supplemental
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function inspectRouteImportFiles(inputFiles, options = {}) {
  const files = normalizeImportFiles(inputFiles);
  if (!files.length) throw new Error("Загрузите хотя бы один XML-файл расписания.");
  const parsedFiles = files.map((file, index) => ({
    file,
    parsed: parseRouteFile(decodeXmlBuffer(file.buffer), file.name, index, options)
  }));

  validateExpectedRoute(parsedFiles, options);

  return {
    files: parsedFiles.map(({ file }) => file.name),
    parsedFiles,
    routes: parsedFiles.map(({ file, parsed }) => ({
      file: file.name,
      id: parsed.route.id,
      number: parsed.route.number,
      name: parsed.route.name,
      transportType: parsed.route.transportType,
      stops: parsed.stops.length,
      departures: parsed.departures.length
    })),
    daySummary: summarizeImportedDays(parsedFiles)
  };
}

function validateExpectedRoute(parsedFiles, options = {}) {
  const expectedNumber = normalizeRouteNumber(options.expectedRouteNumber || options.routeNumber || "");
  if (!expectedNumber) return;

  const wrongRoute = parsedFiles
    .map(({ file, parsed }) => ({ file: file.name, number: parsed.route.number, normalized: normalizeRouteNumber(parsed.route.number) }))
    .find((item) => item.normalized !== expectedNumber);

  if (wrongRoute) {
    throw new Error(`Файл "${wrongRoute.file}" относится к маршруту ${wrongRoute.number || "без номера"}, а выбран маршрут ${options.expectedRouteNumber || options.routeNumber}. Импорт остановлен, чтобы не перепутать расписание.`);
  }
}

function deleteExistingImportedRoutes(db, parsedFiles) {
  const existingRoutes = db.prepare("SELECT route_id AS id, number, transport_type AS transportType FROM routes").all();
  const ids = new Set();

  parsedFiles.forEach(({ parsed }) => {
    const parsedKind = transportKindFromType(parsed.route.transportType);
    const parsedNumber = normalizeRouteNumber(parsed.route.number);

    existingRoutes.forEach((route) => {
      const sameId = route.id === parsed.route.id;
      const sameNumberAndKind = parsedNumber && normalizeRouteNumber(route.number) === parsedNumber && transportKindFromType(route.transportType) === parsedKind;
      if (sameId || sameNumberAndKind) ids.add(route.id);
    });
  });

  const remove = db.prepare("DELETE FROM routes WHERE route_id = ?");
  ids.forEach((id) => remove.run(id));
}

function countRoutesByTransportKind(db, kind) {
  return db.prepare("SELECT transport_type AS transportType FROM routes")
    .all()
    .filter((route) => transportKindFromType(route.transportType) === kind)
    .length;
}

function deleteRoutesByTransportKind(db, kind) {
  const remove = db.prepare("DELETE FROM routes WHERE route_id = ?");
  db.prepare("SELECT route_id AS id, transport_type AS transportType FROM routes")
    .all()
    .filter((route) => transportKindFromType(route.transportType) === kind)
    .forEach((route) => remove.run(route.id));
}

function summarizeImportedDays(parsedFiles) {
  const summary = {
    weekdays: 0,
    weekends: 0,
    everyday: 0,
    other: 0
  };
  parsedFiles.forEach(({ parsed }) => {
    parsed.departures.forEach((departure) => {
      if (departure.dayMask === "1111100") summary.weekdays += 1;
      else if (departure.dayMask === "0000011") summary.weekends += 1;
      else if (departure.dayMask === "1111111") summary.everyday += 1;
      else summary.other += 1;
    });
  });
  return summary;
}

function normalizeImportFiles(inputFiles) {
  if (!Array.isArray(inputFiles)) return [];

  return inputFiles
    .map((file, index) => {
      const rawName = normalizeSpaces(file?.name || "");
      const buffer = bufferFromUpload(file);
      const name = normalizeScheduleUploadName(rawName, buffer, index);
      if (!buffer.length) throw new Error(`Файл "${name}" пустой.`);

      return { name, buffer };
    })
    .sort((a, b) => routeNumberFromFile(a.name) - routeNumberFromFile(b.name) || a.name.localeCompare(b.name, "ru-RU"));
}

function normalizeScheduleUploadName(rawName, buffer, index) {
  const fallbackName = `schedule-${index + 1}.xml`;
  const name = normalizeSpaces(rawName || fallbackName);
  if (name.toLocaleLowerCase("ru-RU").endsWith(".xml")) return name;

  if (looksLikeRouteXml(buffer)) {
    return `${name || fallbackName}.xml`;
  }

  throw new Error(`Файл "${name}" не похож на XML расписания.`);
}

function looksLikeRouteXml(buffer) {
  if (!buffer?.length) return false;
  const xml = decodeXmlBuffer(buffer).replace(/^\uFEFF/, "").trimStart();
  return /^<\?xml\b/i.test(xml) || /^<Route\b/i.test(xml) || /<Route\b/i.test(xml.slice(0, 2000));
}

function bufferFromUpload(file) {
  if (Buffer.isBuffer(file?.buffer)) return file.buffer;
  if (file?.data && typeof file.data === "string") return Buffer.from(file.data, "base64");
  if (file?.text && typeof file.text === "string") return Buffer.from(file.text, "utf8");

  const dataUrl = String(file?.dataUrl || "");
  const match = dataUrl.match(/^data:[^,]*;base64,([\s\S]+)$/i);
  if (match) return Buffer.from(match[1].replace(/\s/g, ""), "base64");
  return Buffer.alloc(0);
}

function decodeXmlBuffer(buffer) {
  const head = buffer.subarray(0, 300).toString("ascii").toLowerCase();
  if (head.includes("utf-8") || head.includes("utf8")) return decoderUtf8.decode(buffer);
  return decoder1251.decode(buffer);
}

function parseRouteFile(xml, sourceFile, fileIndex, options = {}) {
  const routeNode = blocks(xml, "Route")[0];
  if (!routeNode) throw new Error(`В файле нет Route: ${sourceFile}`);

  const rawRouteId = routeNode.attrs.id || String(routeNumberFromFile(sourceFile));
  const routeNumberFromNum = element(routeNode.body, "num") || String(routeNumberFromFile(sourceFile));
  let routeNumber = routeNumberFromNum;
  const rawName = normalizeSpaces(element(routeNode.body, "name") || `Маршрут №${routeNumber}`);
  const routeNumberInName = routeNumberFromRouteName(rawName);
  if (routeNumberInName && !routeNumbersCompatible(routeNumberInName, routeNumberFromNum)) {
    throw new Error(
      `В файле "${sourceFile}" номер маршрута в поле num (${routeNumber}) не совпадает с названием (${routeNumberInName}). Импорт остановлен, чтобы не перепутать расписание.`
    );
  }
  routeNumber = routeNumberInName || routeNumberFromNum;
  const dateStart = normalizeSpaces(element(routeNode.body, "dateStart"));
  const dateExp = normalizeSpaces(element(routeNode.body, "dateExp"));
  const transportType = normalizeSpaces(element(routeNode.body, "nvid")) || "городской";
  const forcedTransportType = normalizeTransportTypeOverride(options.transportType || options.transportTypeOverride);
  const effectiveTransportType = forcedTransportType || transportType;
  const routeId = namespaceRouteId(rawRouteId, effectiveTransportType);
  const now = new Date().toISOString();

  const stops = [];
  const departures = [];
  const busStopNodes = blocks(xml, "BusStop");

  busStopNodes.forEach((stopNode, fallbackIndex) => {
    const exportStopId = stopNode.attrs.id || `${routeId}-${fallbackIndex + 1}`;
    const directionCode = normalizeSpaces(element(stopNode.body, "direction")) || "0";
    const position = Number(normalizeSpaces(element(stopNode.body, "num"))) || fallbackIndex + 1;
    const name = titleStopName(element(stopNode.body, "name"));
    const stopUid = `${routeId}:${directionCode}:${position}:${exportStopId}`;

    stops.push({
      uid: stopUid,
      exportStopId,
      directionCode,
      name,
      normalizedName: normalizeName(name),
      position
    });

    blocks(stopNode.body, "Day").forEach((dayNode) => {
      const dayMask = normalizeDayMask(dayNode.attrs.id, sourceFile);
      const dayName = normalizeSpaces(element(dayNode.body, "name")) || dayNameByMask(dayMask);
      assertDayNameMatchesMask(dayMask, dayName, sourceFile);

      blocks(dayNode.body, "Time").forEach((timeNode) => {
        const departureTime = normalizeTime(element(timeNode.body, "departureTime"));
        if (!departureTime) return;

        departures.push({
          directionCode,
          stopUid,
          dayMask,
          dayName,
          departureTime,
          departureMinutes: minutesFromTime(departureTime),
          arrivalTime: normalizeTime(element(timeNode.body, "arrivalTime")) || departureTime,
          tripCode: normalizeSpaces(element(timeNode.body, "kodElem")),
          variantCode: normalizeSpaces(element(timeNode.body, "kodVariant")),
          notes: normalizeSpaces(element(timeNode.body, "Notes"))
        });
      });
    });
  });

  const routeInfo = routeNameInfo(rawName, routeNumber);
  mergeCircularRouteDirections({ routeId, stops, departures, routeInfo });
  pruneSingleStopTripDepartures({ stops, departures });
  pruneStopsWithoutDepartures({ routeId, stops, departures });
  pruneServiceOnlyStops({ routeId, stops, departures, routeInfo });
  mergeConsecutiveDuplicateStops({ stops, departures });
  pruneDuplicateLoopEndpointDepartures({ stops, departures });
  pruneSingleStopTripDepartures({ stops, departures });
  pruneStopsWithoutDepartures({ routeId, stops, departures });
  renumberStopsByDirection({ routeId, stops, departures });
  deduplicateDepartures(departures);
  const directions = buildDirections(routeId, stops, departures, routeInfo);

  const parsed = {
    route: {
      id: routeId,
      number: routeNumber,
      name: cleanRouteName(rawName, routeNumber),
      rawName,
      transportType: effectiveTransportType,
      color: colors[fileIndex % colors.length],
      dateStart,
      dateExp,
      sourceFile,
      updatedAt: now
    },
    directions,
    stops,
    departures
  };
  validateParsedRoute(parsed, sourceFile);
  return parsed;
}

function deduplicateDepartures(departures) {
  const seen = new Set();
  const result = [];
  departures.forEach((departure) => {
    const key = [
      departure.directionCode,
      departure.stopUid,
      departure.dayMask,
      departure.departureTime,
      departure.arrivalTime,
      departure.tripCode,
      departure.variantCode,
      departure.notes
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    result.push(departure);
  });
  departures.splice(0, departures.length, ...result);
  return departures;
}

function validateParsedRoute(parsed, sourceFile) {
  const routeNumber = parsed.route.number || "без номера";
  if (!normalizeRouteNumber(parsed.route.number)) {
    throw new Error(`В файле "${sourceFile}" не указан номер маршрута. Импорт остановлен.`);
  }

  if (!parsed.stops.length) {
    throw new Error(`В файле "${sourceFile}" для маршрута ${routeNumber} нет остановок. Импорт остановлен.`);
  }

  if (!parsed.departures.length) {
    throw new Error(`В файле "${sourceFile}" для маршрута ${routeNumber} нет времени отправлений. Импорт остановлен.`);
  }

  if (!parsed.directions.length) {
    throw new Error(`В файле "${sourceFile}" для маршрута ${routeNumber} не удалось определить направления. Импорт остановлен.`);
  }

  const stopUids = new Set(parsed.stops.map((stop) => stop.uid));
  const brokenDeparture = parsed.departures.find((departure) => !stopUids.has(departure.stopUid));
  if (brokenDeparture) {
    throw new Error(
      `В файле "${sourceFile}" маршрут ${routeNumber}: найдено время без связанной остановки. Импорт остановлен.`
    );
  }

  const directionsWithDepartures = new Set(parsed.departures.map((departure) => departure.directionCode));
  const emptyDirection = parsed.directions.find((direction) => !directionsWithDepartures.has(direction.code));
  if (emptyDirection) {
    throw new Error(
      `В файле "${sourceFile}" маршрут ${routeNumber}: направление "${emptyDirection.from} - ${emptyDirection.to}" не содержит рейсов. Импорт остановлен.`
    );
  }
}

function mergeCircularRouteDirections({ routeId, stops, departures, routeInfo }) {
  if (!routeInfo?.isCircular) return false;
  const directionCodes = new Set(stops.map((stop) => stop.directionCode));
  if (directionCodes.size < 2) return false;

  const uidMap = new Map();
  const orderedStops = [...stops];

  orderedStops.forEach((stop, index) => {
    const previousUid = stop.uid;
    const position = index + 1;
    stop.position = position;
    stop.directionCode = "0";
    stop.uid = `${routeId}:0:${position}:${stop.exportStopId}`;
    uidMap.set(previousUid, stop.uid);
  });

  departures.forEach((departure) => {
    departure.directionCode = "0";
    departure.stopUid = uidMap.get(departure.stopUid) || departure.stopUid;
  });

  return true;
}

function pruneServiceOnlyStops({ routeId, stops, departures, routeInfo }) {
  const departureCountByStop = new Map();
  departures.forEach((departure) => {
    departureCountByStop.set(departure.stopUid, (departureCountByStop.get(departure.stopUid) || 0) + 1);
  });

  const removedUids = new Set();
  const groups = directionGroups(stops);

  groups.forEach((group) => {
    const counts = group.stops
      .map((stop) => departureCountByStop.get(stop.uid) || 0)
      .filter((count) => count > 0)
      .sort((a, b) => a - b);
    const mainCount = median(counts);
    const countsByCanonicalName = new Map();

    group.stops.forEach((stop) => {
      const canonicalName = canonicalStopName(stop.name);
      const count = departureCountByStop.get(stop.uid) || 0;
      const item = countsByCanonicalName.get(canonicalName) || { max: 0, total: 0 };
      item.max = Math.max(item.max, count);
      item.total += 1;
      countsByCanonicalName.set(canonicalName, item);
    });

    group.stops.forEach((stop) => {
      const count = departureCountByStop.get(stop.uid) || 0;
      if (count === 0) {
        removedUids.add(stop.uid);
        return;
      }

      if (!isGarageOnlyStopName(stop.name)) return;
      if (!isLowCoverageServiceStop(count, mainCount)) return;

      const sameName = countsByCanonicalName.get(canonicalStopName(stop.name));
      const hasStrongerDuplicate = Boolean(sameName && sameName.total > 1 && sameName.max >= Math.max(count + 2, count * 2));
      const routeEndpoint = isRouteNameEndpoint(stop.name, routeInfo);
      const atDirectionEdge = stop === group.stops[0] || stop === group.stops[group.stops.length - 1];

      if (stop === group.stops[0] || (routeEndpoint && atDirectionEdge)) return;

      if (!routeEndpoint || hasStrongerDuplicate || !atDirectionEdge) {
        removedUids.add(stop.uid);
      }
    });
  });

  if (!removedUids.size) return { removedStops: 0, removedDepartures: 0 };

  const originalDepartureCount = departures.length;
  const keptDepartures = departures.filter((departure) => !removedUids.has(departure.stopUid));
  const keptStops = stops.filter((stop) => !removedUids.has(stop.uid));
  const uidMap = new Map();

  directionGroups(keptStops).forEach((group) => {
    group.stops.forEach((stop, index) => {
      const previousUid = stop.uid;
      stop.position = index + 1;
      stop.uid = `${routeId}:${stop.directionCode}:${stop.position}:${stop.exportStopId}`;
      uidMap.set(previousUid, stop.uid);
    });
  });

  keptDepartures.forEach((departure) => {
    departure.stopUid = uidMap.get(departure.stopUid) || departure.stopUid;
  });

  stops.splice(0, stops.length, ...keptStops);
  departures.splice(0, departures.length, ...keptDepartures);

  return {
    removedStops: removedUids.size,
    removedDepartures: originalDepartureCount - keptDepartures.length
  };
}

function mergeConsecutiveDuplicateStops({ stops, departures }) {
  const uidMap = new Map();
  const keptStops = [];

  directionGroups(stops).forEach((group) => {
    let previousKept = null;
    group.stops.forEach((stop) => {
      const sameStop = previousKept
        && stop.exportStopId === previousKept.exportStopId
        && canonicalStopName(stop.name) === canonicalStopName(previousKept.name);
      if (sameStop) {
        uidMap.set(stop.uid, previousKept.uid);
        return;
      }
      keptStops.push(stop);
      previousKept = stop;
    });
  });

  if (!uidMap.size) return { mergedStops: 0, updatedDepartures: 0 };

  let updatedDepartures = 0;
  departures.forEach((departure) => {
    const nextUid = uidMap.get(departure.stopUid);
    if (!nextUid) return;
    departure.stopUid = nextUid;
    updatedDepartures += 1;
  });
  stops.splice(0, stops.length, ...keptStops);
  return { mergedStops: uidMap.size, updatedDepartures };
}

function pruneDuplicateLoopEndpointDepartures({ stops, departures }) {
  const stopByUid = new Map(stops.map((stop) => [stop.uid, stop]));
  const groups = new Map();

  departures.forEach((departure, index) => {
    const stop = stopByUid.get(departure.stopUid);
    if (!stop) return;
    const key = [
      departure.directionCode,
      departure.dayMask,
      departure.tripCode,
      departure.variantCode,
      departure.departureMinutes,
      departure.arrivalTime,
      stop.exportStopId,
      canonicalStopName(stop.name)
    ].join("|");
    const group = groups.get(key) || [];
    group.push({ index, position: Number(stop.position) || 0 });
    groups.set(key, group);
  });

  const removedIndexes = new Set();
  groups.forEach((group) => {
    if (group.length < 2) return;
    const positions = new Set(group.map((item) => item.position));
    if (positions.size < 2) return;
    const lastPosition = Math.max(...group.map((item) => item.position));
    group.forEach((item) => {
      if (item.position < lastPosition) removedIndexes.add(item.index);
    });
  });

  if (!removedIndexes.size) return { removedDepartures: 0 };

  const keptDepartures = departures.filter((_, index) => !removedIndexes.has(index));
  departures.splice(0, departures.length, ...keptDepartures);
  return { removedDepartures: removedIndexes.size };
}

function pruneSingleStopTripDepartures({ stops, departures }) {
  const stopByUid = new Map(stops.map((stop) => [stop.uid, stop]));
  const tripGroups = new Map();

  departures.forEach((departure, index) => {
    if (!departure.tripCode || !departure.variantCode) return;

    const key = [
      departure.directionCode,
      departure.dayMask,
      departure.tripCode,
      departure.variantCode
    ].join("|");
    const group = tripGroups.get(key) || { indexes: [], stopUids: new Set() };
    const stop = stopByUid.get(departure.stopUid);

    group.indexes.push(index);
    group.stopUids.add(stop?.uid || departure.stopUid);
    tripGroups.set(key, group);
  });

  const removedIndexes = new Set();
  tripGroups.forEach((group) => {
    if (group.stopUids.size > 1) return;
    if (hasLinkedContinuationTrip(group, departures, stopByUid)) return;
    group.indexes.forEach((index) => removedIndexes.add(index));
  });

  if (!removedIndexes.size) return { removedDepartures: 0 };

  const keptDepartures = departures.filter((_, index) => !removedIndexes.has(index));
  departures.splice(0, departures.length, ...keptDepartures);

  return { removedDepartures: removedIndexes.size };
}

function pruneStopsWithoutDepartures({ routeId, stops, departures }) {
  const usedStopUids = new Set(departures.map((departure) => departure.stopUid));
  const keptStops = stops.filter((stop) => usedStopUids.has(stop.uid));
  if (keptStops.length === stops.length) return { removedStops: 0, updatedDepartures: 0 };
  const removedStops = stops.length - keptStops.length;

  const uidMap = new Map();
  directionGroups(keptStops).forEach((group) => {
    group.stops.forEach((stop, index) => {
      const previousUid = stop.uid;
      stop.position = index + 1;
      stop.uid = `${routeId}:${stop.directionCode}:${stop.position}:${stop.exportStopId}`;
      if (previousUid !== stop.uid) uidMap.set(previousUid, stop.uid);
    });
  });

  let updatedDepartures = 0;
  departures.forEach((departure) => {
    const nextUid = uidMap.get(departure.stopUid);
    if (!nextUid) return;
    departure.stopUid = nextUid;
    updatedDepartures += 1;
  });

  stops.splice(0, stops.length, ...keptStops);
  return { removedStops, updatedDepartures };
}

function hasLinkedContinuationTrip(group, departures, stopByUid) {
  const departure = departures[group.indexes[0]];
  const stop = stopByUid.get(departure?.stopUid);
  if (!departure || !stop) return false;

  return departures.some((candidate) => {
    if (candidate.directionCode !== departure.directionCode) return false;
    if (candidate.dayMask !== departure.dayMask) return false;
    if (candidate.variantCode !== departure.variantCode) return false;
    if (candidate.tripCode === departure.tripCode) return false;
    if (candidate.departureMinutes < departure.departureMinutes) return false;
    if (candidate.departureMinutes > departure.departureMinutes + LINKED_SEGMENT_MAX_GAP_MINUTES) return false;
    const candidateStop = stopByUid.get(candidate.stopUid);
    const startsAtLinkedStop = candidate.stopUid === departure.stopUid
      || Number(candidateStop?.position) === Number(stop.position) + 1;
    if (!startsAtLinkedStop) return false;

    return departures.some((tail) => {
      if (tail.directionCode !== candidate.directionCode) return false;
      if (tail.dayMask !== candidate.dayMask) return false;
      if (tail.tripCode !== candidate.tripCode) return false;
      if (tail.variantCode !== candidate.variantCode) return false;
      const tailStop = stopByUid.get(tail.stopUid);
      return Number(tailStop?.position) > Number(stop.position);
    });
  });
}

function renumberStopsByDirection({ routeId, stops, departures }) {
  const uidMap = new Map();

  directionGroups(stops).forEach((group) => {
    group.stops.forEach((stop, index) => {
      const previousUid = stop.uid;
      const position = index + 1;
      const nextUid = `${routeId}:${stop.directionCode}:${position}:${stop.exportStopId}`;
      stop.position = position;
      stop.uid = nextUid;
      if (previousUid !== nextUid) uidMap.set(previousUid, nextUid);
    });
  });

  if (!uidMap.size) return { updatedStops: 0, updatedDepartures: 0 };

  let updatedDepartures = 0;
  departures.forEach((departure) => {
    const nextUid = uidMap.get(departure.stopUid);
    if (!nextUid) return;
    departure.stopUid = nextUid;
    updatedDepartures += 1;
  });

  return { updatedStops: uidMap.size, updatedDepartures };
}

function routeNameInfo(rawName, routeNumber) {
  const name = cleanRouteName(rawName, routeNumber);
  const parts = routeNameParts(name);
  const normalizedParts = parts.map((part) => normalizeName(part));
  const isExplicitCircle = /кольц|кругов/.test(normalizeName(name));
  const isReturnCircle = normalizedParts.length >= 3 && normalizedParts[0] === normalizedParts[normalizedParts.length - 1];
  const isCircular = isExplicitCircle || isReturnCircle;
  const endpoints = isCircular || parts.length < 2 ? [] : [parts[0], parts[parts.length - 1]];
  return {
    parts,
    endpoints,
    isCircular,
    label: parts[0] || ""
  };
}

function routeNameParts(name) {
  const text = normalizeSpaces(name);
  const spacedParts = text
    .split(/\s+[-–—]\s+/)
    .map((part) => normalizeSpaces(part))
    .filter(Boolean);
  if (spacedParts.length > 1) return spacedParts;

  return text
    .split(/\s*[-–—]\s*(?=(?:ул\.?|автобусный|кл\.?|агрогородок|центральная|рынок|бпхо|м-н|мк-рн|университет|спецавтобаза|бсз|газ|с-п|дэс|ооо))/i)
    .map((part) => normalizeSpaces(part))
    .filter(Boolean);
}

function blocks(xml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>`, "g");
  const result = [];
  let match;

  while ((match = pattern.exec(xml))) {
    result.push({
      attrs: attributes(match[1]),
      body: match[2]
    });
  }

  return result;
}

function attributes(raw) {
  const attrs = {};
  const pattern = /([:\w-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(raw || ""))) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function element(xml, tagName) {
  const full = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`).exec(xml || "");
  if (full) return decodeXml(full[1]);
  const empty = new RegExp(`<${tagName}\\b[^>]*/>`).exec(xml || "");
  return empty ? "" : "";
}

function cleanRouteName(rawName, routeNumber) {
  const withoutPrefix = rawName.replace(new RegExp(`^Маршрут\\s*№\\s*${escapeRegExp(routeNumber)}`, "i"), "").trim();
  return normalizeSpaces(withoutPrefix.replace(/^["«]\s*/, "").replace(/\s*["»]$/, "")) || rawName;
}

function titleStopName(value) {
  const text = normalizeSpaces(value);
  if (!text) return "Остановка";
  return text.charAt(0).toLocaleUpperCase("ru-RU") + text.slice(1);
}

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTime(value) {
  const text = normalizeSpaces(value);
  if (!text) return "";
  const [hours, minutes] = text.split(":").map((part) => Number(part));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "";
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function minutesFromTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function normalizeDayMask(value, sourceFile = "XML") {
  const mask = normalizeSpaces(value);
  if (/^[01]{7}$/.test(mask) && mask !== "0000000") return mask;
  throw new Error(`Некорректные дни движения в файле "${sourceFile}": "${mask || "пусто"}". Импорт остановлен, чтобы не перепутать будни и выходные.`);
}

function assertDayNameMatchesMask(dayMask, dayName, sourceFile) {
  const value = normalizeName(dayName);
  const looksWeekend = /выход|суб|воск|сб|вс/.test(value);
  const looksWeekday = /рабоч|будн|пн|вт|ср|чт|пт/.test(value);
  if (dayMask === "1111100" && looksWeekend && !looksWeekday) {
    throw new Error(`В файле "${sourceFile}" дни движения подписаны как выходные, но код стоит будний. Импорт остановлен.`);
  }
  if (dayMask === "0000011" && looksWeekday && !looksWeekend) {
    throw new Error(`В файле "${sourceFile}" дни движения подписаны как будни, но код стоит выходной. Импорт остановлен.`);
  }
}

function dayNameByMask(mask) {
  if (mask === "1111100") return "Рабочие дни";
  if (mask === "0000011") return "Выходные";
  if (mask === "1111111") return "Пн-Вс";
  return "По расписанию";
}

function directionGroups(stops) {
  const map = new Map();
  stops.forEach((stop) => {
    if (!map.has(stop.directionCode)) map.set(stop.directionCode, []);
    map.get(stop.directionCode).push(stop);
  });

  return [...map.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([code, items]) => ({
      code,
      stops: items.sort((a, b) => a.position - b.position)
    }));
}

function buildDirections(routeId, stops, departures, routeInfo = {}) {
  const stopByUid = new Map(stops.map((stop) => [stop.uid, stop]));
  const groups = directionGroups(stops);

  return groups.map((group, index) => {
    const first = group.stops[0]?.name || "Начало маршрута";
    const last = group.stops[group.stops.length - 1]?.name || "Конец маршрута";
    const isCircle = (routeInfo?.isCircular && group.code === "0") || namesMatch(first, last);
    const officialEndpoint = isCircle ? null : officialDirectionEndpoint(routeInfo, group, index, groups.length);
    const endpoint = isCircle ? null : dominantTripEndpoint(group.code, departures, stopByUid);
    const circleEndpoint = first || routeInfo?.label || last;
    const from = isCircle ? circleEndpoint : endpoint?.from || first;
    const to = isCircle ? circleEndpoint : officialEndpoint?.to || endpoint?.to || last;
    const displayFrom = officialEndpoint?.from || from;

    return {
      id: `${routeId}:${group.code}`,
      code: group.code,
      from: displayFrom,
      to,
      name: isCircle ? `Кольцевой: ${first}` : `${displayFrom} → ${to}`,
      position: index
    };
  });
}

function officialDirectionEndpoint(routeInfo, group, index, groupCount) {
  const endpoints = routeInfo?.endpoints || [];
  if (endpoints.length !== 2 || groupCount !== 2) return null;

  const [rawStart, rawEnd] = endpoints;
  const start = titleStopName(rawStart);
  const end = titleStopName(rawEnd);
  const stopNames = group.stops.map((stop) => stop.name);
  const first = stopNames[0] || "";

  const startsAtStart = namesMatch(first, start);
  const startsAtEnd = namesMatch(first, end);
  const hasStart = stopNames.some((name) => namesMatch(name, start));
  const hasEnd = stopNames.some((name) => namesMatch(name, end));

  if (startsAtStart && hasEnd) return { from: start, to: end };
  if (startsAtEnd && hasStart) return { from: end, to: start };

  const tail = stopNames.slice(-4);
  const endsNearStart = tail.some((name) => namesMatch(name, start));
  const endsNearEnd = tail.some((name) => namesMatch(name, end));
  if (endsNearEnd && hasStart) return { from: start, to: end };
  if (endsNearStart && hasEnd) return { from: end, to: start };

  if (index === 0 && hasStart && hasEnd) return { from: start, to: end };
  if (index === 1 && hasStart && hasEnd) return { from: end, to: start };
  return null;
}

function namesMatch(left, right) {
  const a = canonicalStopName(left);
  const b = canonicalStopName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function isRouteNameEndpoint(stopName, routeInfo = {}) {
  const parts = routeInfo.parts || [];
  return parts.some((part) => namesMatch(stopName, part));
}

function isGarageOnlyStopName(stopName) {
  const value = canonicalStopName(stopName);
  return (
    value.includes("автобусный парк") ||
    value.includes("автопарк") ||
    value.includes("атлант") ||
    value.includes("бсз")
  );
}

function isLowCoverageServiceStop(count, mainCount) {
  if (!mainCount) return count <= 1;
  return count <= Math.max(3, Math.floor(mainCount * 0.18));
}

function median(values) {
  if (!values.length) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
}

function canonicalStopName(value) {
  return normalizeName(value)
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\bул\b/g, "улица")
    .replace(/\bкл\b/g, "кладбище")
    .replace(/\bмк\s*рн\b/g, "микрорайон")
    .replace(/\bмкрн\b/g, "микрорайон")
    .replace(/\bм\s*н\b/g, "микрорайон")
    .replace(/\bагр\b/g, "агрогородок")
    .replace(/\s+/g, " ")
    .trim();
}

function dominantTripEndpoint(directionCode, departures, stopByUid) {
  const tripGroups = new Map();

  departures
    .filter((departure) => departure.directionCode === directionCode && departure.tripCode && departure.variantCode)
    .forEach((departure) => {
      const key = [departure.dayMask, departure.tripCode, departure.variantCode].join("|");
      if (!tripGroups.has(key)) tripGroups.set(key, []);
      tripGroups.get(key).push(departure);
    });

  const endpointGroups = new Map();

  tripGroups.forEach((items) => {
    const stopsInTrip = items
      .map((departure) => ({ departure, stop: stopByUid.get(departure.stopUid) }))
      .filter((item) => item.stop)
      .sort((a, b) => a.stop.position - b.stop.position || a.departure.departureMinutes - b.departure.departureMinutes);

    const first = stopsInTrip[0]?.stop;
    const last = stopsInTrip[stopsInTrip.length - 1]?.stop;
    if (!first || !last || first.uid === last.uid) return;

    const key = `${normalizeName(first.name)}>${normalizeName(last.name)}`;
    const group = endpointGroups.get(key) || {
      from: first.name,
      to: last.name,
      trips: 0,
      stopTotal: 0
    };
    group.trips += 1;
    group.stopTotal += stopsInTrip.length;
    endpointGroups.set(key, group);
  });

  return [...endpointGroups.values()].sort((a, b) => {
    if (b.trips !== a.trips) return b.trips - a.trips;
    return b.stopTotal - a.stopTotal;
  })[0];
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function routeNumberFromFile(fileName) {
  const match = String(fileName).match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function routeNumberFromRouteName(routeName) {
  const match = normalizeSpaces(routeName).match(/^Маршрут\s*№\s*([0-9A-Za-zА-Яа-я-]+)/i);
  return match ? match[1] : "";
}

function normalizeRouteNumber(value) {
  const text = normalizeSpaces(value);
  if (!text) return "";
  if (/^\d+$/.test(text)) return String(Number(text));
  return text.toLocaleLowerCase("ru-RU");
}

function routeNumberFromRouteName(routeName) {
  const text = normalizeSpaces(routeName);
  const match = text.match(/(?:\u2116|в„–)\s*([0-9][0-9\p{L}-]*)/iu)
    || text.match(/^\D*([0-9][0-9\p{L}-]*)/u);
  return match ? match[1] : "";
}

function routeNumberBase(value) {
  const match = String(value || "").match(/\d+/);
  return match ? String(Number(match[0])) : "";
}

function routeNumbersCompatible(left, right) {
  const normalizedLeft = normalizeRouteNumber(left);
  const normalizedRight = normalizeRouteNumber(right);
  if (!normalizedLeft || !normalizedRight) return true;
  if (normalizedLeft === normalizedRight) return true;
  return routeNumberBase(normalizedLeft) === routeNumberBase(normalizedRight);
}

function normalizeTransportTypeOverride(value) {
  const kind = transportKindFromType(value);
  if (kind === "suburban") return "пригородный";
  if (kind === "intercity") return "междугородный";
  if (kind === "international") return "международный";
  if (kind === "city") return "городской";
  return "";
}

function transportKindFromType(value) {
  const text = normalizeName(value);
  if (!text) return "";
  if (text.includes("suburban") || text.includes("пригород")) return "suburban";
  if (text.includes("international") || text.includes("международ")) return "international";
  if (text.includes("intercity") || text.includes("междугород") || text.includes("межгород")) return "intercity";
  if (text.includes("city") || text.includes("город")) return "city";
  return "";
}

function namespaceRouteId(routeId, transportType) {
  const cleanId = String(routeId || "").trim();
  if (!cleanId) return cleanId;
  const kind = transportKindFromType(transportType);
  if (!kind || kind === "city" || cleanId.startsWith(`${kind}:`)) return cleanId;
  return `${kind}:${cleanId}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  importRoutesFromXmlFiles,
  inspectRouteImportFiles,
  parseRouteFile,
  normalizeImportFiles
};
