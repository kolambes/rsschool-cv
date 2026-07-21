"use strict";

const MONTHS = {
  январ: 1,
  февраля: 2,
  феврал: 2,
  марта: 3,
  март: 3,
  апреля: 4,
  апрел: 4,
  мая: 5,
  май: 5,
  июня: 6,
  июнь: 6,
  июля: 7,
  июль: 7,
  августа: 8,
  август: 8,
  сентября: 9,
  сентябр: 9,
  октября: 10,
  октябр: 10,
  ноября: 11,
  ноябр: 11,
  декабря: 12,
  декабр: 12
};

function decodeRosterBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  // UTF-8 BOM -> decode as UTF-8 without the marker.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // Try strict UTF-8; Cyrillic saved as CP1251 produces invalid UTF-8 sequences
  // and throws, so we fall back. This makes Google Sheets / LibreOffice exports work.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

function parseRosterDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/i);
  if (!match) throw new Error("Загрузите CSV-файл разнарядки.");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length) throw new Error("CSV-файл пустой.");
  return decodeRosterBuffer(bytes);
}

const CSV_DELIMITERS = [";", ",", "\t"];

function detectCsvDelimiter(text) {
  // Count candidate delimiters outside quotes across the first lines only.
  const sample = String(text || "").slice(0, 20000);
  const counts = { ";": 0, ",": 0, "\t": 0 };
  let inQuotes = false;
  let lines = 0;
  for (let index = 0; index < sample.length && lines < 20; index += 1) {
    const char = sample[index];
    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === "\n") {
      lines += 1;
      continue;
    }
    if (counts[char] !== undefined) counts[char] += 1;
  }
  // Historical roster format is semicolon-delimited; a title line rich in commas
  // ("на 03.07.2026, четверг") must not flip the whole file to comma parsing.
  if (counts[";"] >= 3) return ";";
  let best = ";";
  let bestCount = counts[";"];
  for (const delimiter of CSV_DELIMITERS) {
    if (counts[delimiter] > bestCount) {
      bestCount = counts[delimiter];
      best = delimiter;
    }
  }
  return best;
}

function parseSemicolonCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const delimiter = detectCsvDelimiter(source);
  const rows = [];
  let row = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === "\"") {
        if (source[index + 1] === "\"") {
          current += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cleanCell(current));
      current = "";
      continue;
    }
    if (char === "\n") {
      row.push(cleanCell(current));
      rows.push(row);
      row = [];
      current = "";
      continue;
    }
    if (char === "\r") {
      if (source[index + 1] === "\n") continue; // let the \n terminate the record
      row.push(cleanCell(current));
      rows.push(row);
      row = [];
      current = "";
      continue;
    }
    current += char;
  }

  row.push(cleanCell(current));
  rows.push(row);
  // A trailing newline produces one empty record at the end; drop it.
  if (rows.length > 1 && rows[rows.length - 1].every((cell) => cell === "")) rows.pop();
  return rows;
}

function cleanCell(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return cleanCell(value).toLocaleLowerCase("ru-RU").replace(/\s+/g, "");
}

function findScheduleDate(rows) {
  const warnings = [];
  for (const [rowIndex, row] of rows.entries()) {
    const line = row.join(" ");
    const direct = line.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/);
    if (direct) {
      const scheduleDate = toDate(Number(direct[3]), Number(direct[2]), Number(direct[1]));
      if (scheduleDate) return { scheduleDate, warnings };
      warnings.push(invalidDateWarning(rowIndex, direct[0]));
      continue;
    }

    const text = line.replace(/["«»]/g, " ");
    const named = text.match(/(\d{1,2})\s+([А-Яа-яЁё]+)\s+(20\d{2})/);
    if (named) {
      const month = monthNumber(named[2]);
      if (month) {
        const scheduleDate = toDate(Number(named[3]), month, Number(named[1]));
        if (scheduleDate) return { scheduleDate, warnings };
        warnings.push(invalidDateWarning(rowIndex, named[0]));
      }
    }
  }
  return {
    scheduleDate: toDate(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()),
    warnings,
    assumed: true
  };
}

function invalidDateWarning(rowIndex, value) {
  return {
    row: rowIndex + 1,
    tabNumber: "",
    driverName: "",
    code: "",
    value: cleanCell(value),
    message: `Invalid roster date "${cleanCell(value)}".`
  };
}

function monthNumber(value) {
  const key = cleanCell(value).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  return MONTHS[key] || MONTHS[key.slice(0, 6)] || 0;
}

function toDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
  ) {
    return "";
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function displayDate(dateValue) {
  const match = String(dateValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateValue || "";
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function isRosterHeader(row) {
  // Match the singular "водитель" (with ь): footer/legend rows like
  // "Водители без табельных номеров" must not be mistaken for a header
  // and hijack the column layout mid-file.
  const hasDriver = row.some((cell) => /водитель/i.test(cell));
  const hasTab = row.some((cell) => /таб/i.test(compact(cell)));
  return hasDriver && hasTab;
}

function buildLayout(headerRow, subRow) {
  // Support any number of driver columns (single-shift, two-shift, or more).
  // Columns for a shift live to the left of its "Водитель" header cell.
  const driverIndices = [];
  headerRow.forEach((cell, index) => {
    if (/водитель/i.test(cell)) driverIndices.push(index);
  });
  if (!driverIndices.length) return null;

  const shifts = driverIndices.map((driverIndex, order) => {
    const from = order === 0 ? 0 : driverIndices[order - 1] + 1;
    return buildShiftLayout(headerRow, subRow, from, driverIndex, driverIndex, String(order + 1));
  });

  return { shifts, first: shifts[0] || null, second: shifts[1] || null };
}

function buildShiftLayout(headerRow, subRow, from, to, driverIndex, shift) {
  const timeIndex = findHeaderIndex(headerRow, /время/i, from, to);
  const startIndex = findSubIndex(subRow, /вых/i, timeIndex, to) ?? timeIndex;
  const endIndex = findSubIndex(subRow, /возвращ/i, startIndex + 1, to) ?? startIndex + 1;

  return {
    shift,
    exitIndex: findHeaderIndex(headerRow, /выезд/i, from, to),
    timeIndex,
    startIndex,
    endIndex,
    plateIndex: findHeaderIndex(headerRow, /гос/i, from, to),
    garageIndex: findHeaderIndex(headerRow, /гараж/i, from, to),
    tabIndex: findHeaderIndex(headerRow, /таб/i, from, to),
    driverIndex
  };
}

function findHeaderIndex(row, pattern, from, to) {
  for (let index = from; index <= to && index < row.length; index += 1) {
    if (pattern.test(compact(row[index]))) return index;
  }
  return -1;
}

function findSubIndex(row, pattern, from, to) {
  if (from < 0) return null;
  for (let index = from; index <= to + 2 && index < row.length; index += 1) {
    if (pattern.test(compact(row[index]))) return index;
  }
  return null;
}

function parseDutyRoster(text) {
  const rows = parseSemicolonCsv(text);
  const scheduleDateInfo = findScheduleDate(rows);
  const scheduleDate = scheduleDateInfo.scheduleDate;
  const dateAssumed = Boolean(scheduleDateInfo.assumed);
  const items = [];
  const warnings = [...scheduleDateInfo.warnings];
  let layout = null;
  let headerFound = false;
  let dataRows = 0;
  let skippedRows = 0;

  rows.forEach((row, rowIndex) => {
    if (isRosterHeader(row)) {
      layout = buildLayout(row, rows[rowIndex + 1] || []);
      if (layout) headerFound = true;
      return;
    }
    if (!layout) return;
    if (isServiceRow(row)) return;
    if (row.every((cell) => !cell)) return;

    dataRows += 1;
    const shiftItems = [];
    let inherited = null;
    for (const shiftLayout of layout.shifts) {
      const item = parseShift(row, shiftLayout, scheduleDate, rowIndex, inherited);
      shiftItems.push(item);
      if (item) inherited = item;
    }
    if (shiftItems.every((item) => !item)) {
      // Only warn about rows that actually named a driver (had a tab number) but
      // produced nothing — those are silently dropped drivers. Sub-header and
      // noise rows have no tab cell and are ignored quietly.
      const hasTabCell = layout.shifts.some(
        (shiftLayout) => shiftLayout.tabIndex >= 0 && cleanCell(row[shiftLayout.tabIndex])
      );
      if (hasTabCell) skippedRows += 1;
      return;
    }

    // Mark "line change" on consecutive same-vehicle shifts handed over at the same time.
    for (let index = 1; index < shiftItems.length; index += 1) {
      const previous = shiftItems[index - 1];
      const current = shiftItems[index];
      if (
        previous && current
          && isSameVehicle(previous, current)
          && previous.workTimeEnd && current.workTimeStart
          && previous.workTimeEnd === current.workTimeStart
      ) {
        previous.isLineChange = true;
        current.isLineChange = true;
      }
    }

    shiftItems.filter(Boolean).forEach((item) => {
      if (Array.isArray(item.parseWarnings)) {
        warnings.push(...item.parseWarnings);
        delete item.parseWarnings;
      }
      if (item.parseWarning) {
        warnings.push(item.parseWarning);
        delete item.parseWarning;
      }
      items.push(item);
    });
  });

  if (!headerFound) {
    warnings.push(rosterNotice(
      "Не найден заголовок разнарядки (нужны столбцы «Таб» и «Водитель»). Проверьте формат файла."
    ));
  }
  if (dateAssumed) {
    warnings.push(rosterNotice(
      `Дата в файле не распознана — используется ${displayDate(scheduleDate)}. Проверьте разнарядку перед отправкой.`
    ));
  }
  if (skippedRows > 0) {
    warnings.push(rosterNotice(
      `Пропущено строк без назначения: ${skippedRows}. Проверьте, что в них заполнены выезд/время/машина.`
    ));
  }

  const deduplicatedItems = deduplicateItems(items);
  attachReplacementDrivers(deduplicatedItems);
  attachDriverOverlapWarnings(deduplicatedItems, warnings);

  return {
    scheduleDate,
    displayDate: displayDate(scheduleDate),
    dateAssumed,
    dataRows,
    skippedRows,
    items: deduplicatedItems,
    warnings
  };
}

function rosterNotice(message) {
  return { row: 0, tabNumber: "", driverName: "", code: "", message };
}

function isServiceRow(row) {
  const joined = row.join(" ").toLocaleLowerCase("ru-RU");
  return /подпись|главный инженер|начальник|не планируются|выезды не запланированы|итого|водители|автобусы/.test(joined);
}

function parseShift(row, layout, scheduleDate, rowIndex, inherited = null) {
  if (!layout || layout.tabIndex < 0 || layout.driverIndex < 0) return null;

  const tabNumber = normalizeTabNumber(row[layout.tabIndex]);
  const driverName = normalizeDriverName(row[layout.driverIndex]);
  if (!tabNumber || !driverName) return null;

  const exitCell = row[layout.exitIndex];
  const rawWorkTimeStart = row[layout.startIndex] || row[layout.timeIndex];
  const rawWorkTimeEnd = row[layout.endIndex];
  const workTimeStart = normalizeTime(rawWorkTimeStart);
  const workTimeEnd = normalizeTime(rawWorkTimeEnd);
  const ownBusPlateNumber = normalizeBusPlate(row[layout.plateIndex]);
  const ownGarageNumber = normalizeGarageNumber(row[layout.garageIndex]);
  const hasAssignmentEvidence = Boolean(
    cleanCell(exitCell)
      || looksLikeEnteredTime(rawWorkTimeStart)
      || looksLikeEnteredTime(rawWorkTimeEnd)
      || ownBusPlateNumber
      || ownGarageNumber
  );
  if (!hasAssignmentEvidence) return null;

  const routeInfo = parseExitCode(exitCell, layout.shift, {
    hasVehicle: Boolean(ownBusPlateNumber || ownGarageNumber)
  });
  const busPlateNumber = ownBusPlateNumber || inherited?.busPlateNumber || "";
  const garageNumber = ownGarageNumber || inherited?.garageNumber || "";

  const parseWarnings = [];
  if (routeInfo.warning) {
    parseWarnings.push({
      row: rowIndex + 1,
      tabNumber,
      driverName,
      code: cleanCell(exitCell),
      message: routeInfo.warning
    });
  }
  [
    { field: "start", value: rawWorkTimeStart },
    { field: "end", value: rawWorkTimeEnd }
  ].forEach(({ field, value }) => {
    if (!looksLikeEnteredTime(value)) return;
    if (normalizeTime(value)) return;
    parseWarnings.push({
      row: rowIndex + 1,
      tabNumber,
      driverName,
      code: cleanCell(exitCell),
      field,
      value: cleanCell(value),
      message: `Invalid roster ${field} time "${cleanCell(value)}".`
    });
  });

  return {
    scheduleDate,
    tabNumber,
    driverName,
    assignmentType: routeInfo.assignmentType,
    route: routeInfo.route,
    routeCarNumber: routeInfo.carNumber,
    shift: routeInfo.shift || layout.shift,
    workTimeStart,
    workTimeEnd,
    busPlateNumber,
    garageNumber,
    replacementDriverName: "",
    replacementTabNumber: "",
    isLineChange: false,
    rawData: row.map(cleanCell).join("; "),
    sourceRow: rowIndex + 1,
    parseWarnings
  };
}

function normalizeTabNumber(value) {
  const valueDigits = digits(value);
  return valueDigits.length >= 2 && valueDigits.length <= 8 ? valueDigits : "";
}

// Canonical key for matching tab numbers across sources that disagree on leading
// zeros (e.g. CSV prints "007" while the driver registered as "7"). Both collapse
// to the same key so the driver still receives the roster.
function tabNumberKey(value) {
  const valueDigits = digits(value);
  if (!valueDigits) return "";
  const trimmed = valueDigits.replace(/^0+/, "");
  return trimmed || "0";
}

function normalizeDriverName(value) {
  const text = cleanCell(value);
  if (!text || !/[А-ЯЁA-Z]/i.test(text)) return "";
  if (/^\d+$/.test(text)) return "";
  return text;
}

function normalizeTime(value) {
  const match = cleanCell(value).match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return "";
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function looksLikeEnteredTime(value) {
  const text = cleanCell(value);
  if (!text) return false;
  return /\d{1,2}\s*[:.]\s*\d{2}/.test(text);
}

function normalizeBusPlate(value) {
  const text = cleanCell(value).toUpperCase();
  if (!text || text.length < 4 || !/[A-ZА-Я]/i.test(text)) return "";
  return text.replace(/\s+/g, "");
}

function normalizeGarageNumber(value) {
  const valueDigits = digits(value);
  return valueDigits.length >= 2 ? valueDigits : "";
}

function digits(value) {
  return cleanCell(value).replace(/\D+/g, "");
}

function minutesOfDay(time) {
  if (!/^\d{2}:\d{2}$/.test(String(time || ""))) return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function rosterInterval(item) {
  const start = minutesOfDay(item?.workTimeStart);
  const end = minutesOfDay(item?.workTimeEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    start,
    end: end <= start ? end + 1440 : end
  };
}

function isOvernightShift(item) {
  const start = minutesOfDay(item?.workTimeStart);
  const end = minutesOfDay(item?.workTimeEnd);
  return Number.isFinite(start) && Number.isFinite(end) && end <= start;
}

function parseExitCode(value, fallbackShift, context = {}) {
  const code = digits(value);
  const text = cleanCell(value);
  const hasRouteEvidence = Boolean(context.hasVehicle || hasRouteMarker(text));
  const isReserve = hasReserveMarker(text) || (code === "9" && !hasRouteEvidence);
  if (isReserve) {
    return { assignmentType: "reserve", route: "", carNumber: "", shift: fallbackShift };
  }
  if (!code) return { assignmentType: "unknown", route: "", carNumber: "", shift: fallbackShift };
  if (code.length < 3) {
    return hasRouteEvidence
      ? { assignmentType: "route", route: normalizeRouteNumber(code), carNumber: "", shift: fallbackShift }
      : { assignmentType: "unknown", route: "", carNumber: "", shift: fallbackShift };
  }

  const shift = code.slice(-1);
  const carNumber = code.slice(-2, -1);
  const route = code.slice(0, -2);
  if (shift !== "1" && shift !== "2") {
    return {
      assignmentType: "unknown",
      route: "",
      carNumber: "",
      shift: fallbackShift,
      warning: `Неоднозначный код выезда "${text || code}": последняя цифра должна быть сменой 1 или 2.`
    };
  }
  return {
    assignmentType: route ? "route" : "unknown",
    route: route ? String(Number(route)) : "",
    carNumber: carNumber ? String(Number(carNumber)) : "",
    shift
  };
}

function normalizeRouteNumber(code) {
  const route = String(Number(code || ""));
  return route === "0" || route === "NaN" ? "" : route;
}

function hasReserveMarker(value) {
  return /(^|[^а-яёa-z])(резерв|рез\.?)(?=$|[^а-яёa-z])/iu.test(cleanCell(value));
}

function hasRouteMarker(value) {
  return /(^|[^а-яёa-z])(маршрут|марш|м-т|м\/т|route)(?=$|[^а-яёa-z])/iu.test(cleanCell(value));
}

function isSameVehicle(left, right) {
  if (!left || !right) return false;
  if (left.busPlateNumber && right.busPlateNumber && left.busPlateNumber === right.busPlateNumber) return true;
  return Boolean(left.garageNumber && right.garageNumber && left.garageNumber === right.garageNumber);
}

function attachReplacementDrivers(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.busPlateNumber || (item.garageNumber ? `garage:${item.garageNumber}` : "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const group of groups.values()) {
    const unique = group.filter((item, index, list) => list.findIndex((candidate) => candidate.tabNumber === item.tabNumber) === index);
    if (unique.length < 2) continue;
    unique.sort(compareRosterItemsByTime);
    unique.forEach((item) => {
      const replacement = findNearestReplacementDriver(item, unique);
      if (!replacement) return;
      item.replacementDriverName = replacement.driverName;
      item.replacementTabNumber = replacement.tabNumber;
    });
  }
}

function compareRosterItemsByTime(left, right) {
  const leftInterval = rosterInterval(left);
  const rightInterval = rosterInterval(right);
  const leftStart = Number.isFinite(leftInterval?.start) ? leftInterval.start : Number.MAX_SAFE_INTEGER;
  const rightStart = Number.isFinite(rightInterval?.start) ? rightInterval.start : Number.MAX_SAFE_INTEGER;
  return leftStart - rightStart || String(left.shift).localeCompare(String(right.shift)) || String(left.driverName).localeCompare(String(right.driverName));
}

function findNearestReplacementDriver(item, group) {
  const current = rosterInterval(item);
  const candidates = group.filter((candidate) => candidate.tabNumber !== item.tabNumber);
  // Without a known time window we cannot prove a real hand-over, so leave it blank
  // instead of guessing an unrelated driver who merely shares the same vehicle.
  if (!candidates.length || !current) return null;

  const withIntervals = candidates
    .map((candidate) => ({ candidate, interval: rosterInterval(candidate) }))
    .filter((entry) => entry.interval);

  const next = withIntervals
    .filter((entry) => entry.interval.start >= current.end)
    .sort((left, right) => left.interval.start - right.interval.start)[0];
  if (next) return next.candidate;

  const previous = withIntervals
    .filter((entry) => entry.interval.end <= current.start)
    .sort((left, right) => right.interval.end - left.interval.end)[0];
  if (previous) return previous.candidate;

  // No adjacent shift -> no confirmed replacement.
  return null;
}

function attachDriverOverlapWarnings(items, warnings) {
  const byDriver = new Map();
  items.forEach((item) => {
    if (!item.tabNumber) return;
    const interval = rosterInterval(item);
    if (!interval) return;
    const key = `${item.scheduleDate}:${item.tabNumber}`;
    if (!byDriver.has(key)) byDriver.set(key, []);
    byDriver.get(key).push({ item, interval });
  });

  byDriver.forEach((entries) => {
    entries.sort((left, right) => left.interval.start - right.interval.start);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (current.interval.start >= previous.interval.end) continue;
      warnings.push({
        row: current.item.sourceRow,
        tabNumber: current.item.tabNumber,
        driverName: current.item.driverName,
        code: current.item.route || current.item.assignmentType,
        message: `Overlapping roster shifts for tab ${current.item.tabNumber}: ${previous.item.workTimeStart}-${previous.item.workTimeEnd} and ${current.item.workTimeStart}-${current.item.workTimeEnd}.`
      });
    }
  });
}

function deduplicateItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = [
      item.scheduleDate,
      item.tabNumber,
      item.assignmentType,
      item.route,
      item.routeCarNumber,
      item.shift,
      item.workTimeStart,
      item.workTimeEnd,
      item.busPlateNumber,
      item.garageNumber
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function formatDutyRosterMessage(item) {
  const routeLine = formatAssignmentLine(item);
  const overnightNote = isOvernightShift(item) ? " (+1 day)" : "";
  const timeLine = item.workTimeStart || item.workTimeEnd
    ? `🕒 ${[item.workTimeStart, item.workTimeEnd].filter(Boolean).join("–")}${overnightNote}`
    : "";

  return [
    `🚌 Разнарядка на ${displayDate(item.scheduleDate)}`,
    "",
    `👤 ${item.driverName}${item.tabNumber ? ` (${item.tabNumber})` : ""}`,
    "",
    routeLine,
    timeLine,
    "",
    item.busPlateNumber ? `🚍 ${item.busPlateNumber}` : "",
    item.garageNumber ? `🏢 Гар. №${item.garageNumber}` : "",
    "",
    item.replacementDriverName ? `👥 Сменщик: ${item.replacementDriverName}` : "",
    item.isLineChange ? "🔄 Смена на линии" : ""
  ]
    .filter((line, index, lines) => line || (lines[index - 1] && lines[index + 1]))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatAssignmentLine(item) {
  if (item.assignmentType === "reserve") return "🟡 Резерв: ожидание назначения";
  if (item.route) return `🛣️ Маршрут: ${item.route}${item.routeCarNumber ? ` • Машина №${item.routeCarNumber}` : ""}`;
  return "⚠️ Маршрут не определен";
}

function formatNoAssignmentMessage(user, scheduleDate) {
  return [
    `📅 Разнарядка на ${displayDate(scheduleDate)}`,
    "",
    `👤 ${user.fullName || user.name || `Таб. №${user.tabNumber}`}`,
    "",
    "✅ На завтра назначений нет"
  ].join("\n");
}

function summarizeParsedRoster(parsed, registeredUsers = []) {
  const registeredByKey = new Map();
  for (const user of registeredUsers) {
    const key = tabNumberKey(user.tabNumber);
    if (key) registeredByKey.set(key, { hasTelegram: Boolean(user.telegramId) });
  }

  const uniqueKeys = new Map();
  const unregistered = new Map();
  let readyToSend = 0;
  for (const item of parsed.items) {
    const key = tabNumberKey(item.tabNumber);
    if (!key) continue;
    if (!uniqueKeys.has(key)) uniqueKeys.set(key, item.tabNumber);
    const match = registeredByKey.get(key);
    if (match && match.hasTelegram) {
      readyToSend += 1; // one delivered message per assignment
    } else if (!unregistered.has(key)) {
      unregistered.set(key, item.tabNumber);
    }
  }

  const registered = [...uniqueKeys.keys()].filter((key) => registeredByKey.has(key)).length;
  const unregisteredTabs = [...unregistered.values()].sort(compareNumericStrings);
  return {
    scheduleDate: parsed.scheduleDate,
    displayDate: parsed.displayDate,
    dateAssumed: Boolean(parsed.dateAssumed),
    skippedRows: parsed.skippedRows || 0,
    foundDrivers: uniqueKeys.size,
    assignments: parsed.items.length,
    registered,
    unregistered: unregisteredTabs.length,
    readyToSend,
    unregisteredTabs
  };
}

function compareNumericStrings(left, right) {
  return Number(left) - Number(right) || String(left).localeCompare(String(right));
}

module.exports = {
  decodeRosterBuffer,
  parseRosterDataUrl,
  parseSemicolonCsv,
  parseDutyRoster,
  formatDutyRosterMessage,
  formatNoAssignmentMessage,
  summarizeParsedRoster,
  tabNumberKey,
  displayDate
};
