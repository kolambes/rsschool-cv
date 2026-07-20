const { startHttpServer } = require("../server");

async function readText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

async function readJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

(async () => {
  const server = await startHttpServer(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const [health, home, admin, bootstrap] = await Promise.all([
      readJson(`${baseUrl}/api/health`),
      readText(`${baseUrl}/`),
      readText(`${baseUrl}/admin`),
      readJson(`${baseUrl}/api/bootstrap`)
    ]);

    const firstRoute = bootstrap.routes[0];
    const firstDirection = firstRoute?.directions[0];
    const firstStop = firstDirection?.stops[0];
    const schedule = firstStop
      ? await readJson(
          `${baseUrl}/api/schedule?routeId=${encodeURIComponent(firstRoute.id)}&directionCode=${encodeURIComponent(firstDirection.code)}&stopUid=${encodeURIComponent(firstStop.id)}`
        )
      : { groups: [] };
    const routeSearch = await readJson(
      `${baseUrl}/api/routes/search?from=${encodeURIComponent("Торговый дом Дедарина")}&to=${encodeURIComponent("Автовокзал")}&date=2026-06-27&time=08%3A00&limit=3`
    );
    const adminBootstrap = await readJson(`${baseUrl}/api/admin/bootstrap`, {
      "x-admin-key": process.env.ADMIN_KEY || "",
      "x-admin-role": "admin"
    });

    const result = {
      healthOk: health.ok === true,
      homeOk: home.includes("Расписание автобусов"),
      adminOk: admin.includes("НАСТРОЙКИ") && !admin.includes("АВТОБУСНЫЙ ПАРК №1"),
      routes: bootstrap.routes.length,
      stops: health.stats.stops,
      departures: health.stats.departures,
      ads: bootstrap.ads.length,
      scheduleGroups: schedule.groups.length,
      routeSearchTop: routeSearch.results?.[0]?.routeNumber,
      adminApiOk: adminBootstrap.ok === true
    };

    const routeSearchOk = routeSearch.results?.[0]?.routeNumber === "29" && routeSearch.results?.[0]?.departureTime === "08:09";
    if (!result.healthOk || !result.homeOk || !result.adminOk || result.routes === 0 || result.scheduleGroups === 0 || !routeSearchOk || !result.adminApiOk) {
      throw new Error(`Verification failed: ${JSON.stringify(result)}`);
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
