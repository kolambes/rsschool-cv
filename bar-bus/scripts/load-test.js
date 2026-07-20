const { performance } = require("node:perf_hooks");
const { startHttpServer } = require("../server");

const TOTAL_REQUESTS = Number(process.env.LOAD_REQUESTS || 240);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 24);

async function requestJson(url) {
  const started = performance.now();
  const response = await fetch(url);
  await response.arrayBuffer();
  return {
    ok: response.ok,
    status: response.status,
    ms: performance.now() - started
  };
}

async function runPool(tasks, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = tasks[index];
      index += 1;
      results.push(await current());
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

(async () => {
  const server = await startHttpServer(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`).then((response) => response.json());
    const endpoints = [`${baseUrl}/api/bootstrap`, `${baseUrl}/api/routes`, `${baseUrl}/api/health`];

    bootstrap.routes.slice(0, 12).forEach((route) => {
      const direction = route.directions[0];
      const stop = direction?.stops[0];
      if (!direction || !stop) return;

      const schedule = new URL(`${baseUrl}/api/schedule`);
      schedule.searchParams.set("routeId", route.id);
      schedule.searchParams.set("directionCode", direction.code);
      schedule.searchParams.set("stopUid", stop.id);
      endpoints.push(schedule.toString());

      const board = new URL(`${baseUrl}/api/stops/board`);
      board.searchParams.set("stop", stop.name);
      endpoints.push(board.toString());
    });

    const tasks = Array.from({ length: TOTAL_REQUESTS }, (_, index) => {
      const url = endpoints[index % endpoints.length];
      return () => requestJson(url);
    });
    const started = performance.now();
    const results = await runPool(tasks, CONCURRENCY);
    const totalMs = performance.now() - started;
    const failures = results.filter((result) => !result.ok);
    const times = results.map((result) => result.ms);
    const report = {
      ok: failures.length === 0,
      totalRequests: results.length,
      concurrency: CONCURRENCY,
      totalMs: Math.round(totalMs),
      requestsPerSecond: Math.round((results.length / totalMs) * 1000),
      avgMs: Math.round(times.reduce((sum, item) => sum + item, 0) / times.length),
      p95Ms: Math.round(percentile(times, 95)),
      maxMs: Math.round(Math.max(...times)),
      failures: failures.length
    };

    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
