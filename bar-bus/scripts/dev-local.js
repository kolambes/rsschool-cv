const net = require("node:net");

process.env.DISABLE_TELEGRAM_POLLING = process.env.DISABLE_TELEGRAM_POLLING || "true";
process.env.NODE_ENV = process.env.NODE_ENV || "development";

const DEFAULT_PORT = 3000;
const MAX_PORT_ATTEMPTS = 25;

function canListen(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port);
  });
}

async function findAvailablePort(startPort) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    if (await canListen(port)) return port;
  }
  throw Object.assign(new Error(`No free local port found from ${startPort} to ${startPort + MAX_PORT_ATTEMPTS - 1}.`), {
    code: "NO_FREE_PORT"
  });
}

async function main() {
  const requestedPort = Number(process.env.PORT || DEFAULT_PORT);
  const port = await findAvailablePort(Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT);
  process.env.PORT = String(port);
  if (port !== requestedPort) {
    console.log(`Port ${requestedPort} is busy. Using http://localhost:${port} instead.`);
  }

  const { startApp } = require("../server");
  await startApp();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
