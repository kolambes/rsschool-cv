"use strict";

// Заполняет демо-геоданные карты (схематичные координаты остановок и линии
// маршрутов, помечены source='demo'). Использование:
//
//   node --no-warnings scripts/seed-demo-geo.js          # заполнить
//   node --no-warnings scripts/seed-demo-geo.js --clear  # удалить демо-записи
//
// Требуется заполненное расписание (npm run import:routes ...).

const path = require("node:path");
process.chdir(path.join(__dirname, ".."));

const mapModule = require("../map-module.js");

mapModule.init({
  httpError: (message, statusCode) => Object.assign(new Error(message), { statusCode })
});

if (process.argv.includes("--clear")) {
  const cleared = mapModule.clearDemoGeo();
  console.log(`Демо-геоданные удалены: остановок — ${cleared.stops}, линий — ${cleared.geometry}.`);
} else {
  const seeded = mapModule.seedDemoGeo();
  console.log(
    `Демо-геоданные созданы: маршрутов — ${seeded.routes}, направлений — ${seeded.directions}, новых остановок — ${seeded.stops}.`
  );
  mapModule.getMapHealth().then((health) => {
  console.log(`Покрытие: ${health.coverage.directionsWithGeometry}/${health.coverage.directionsTotal} направлений, ${health.coverage.stopsWithGeo}/${health.coverage.stopsTotal} остановок.`);
  });
}
