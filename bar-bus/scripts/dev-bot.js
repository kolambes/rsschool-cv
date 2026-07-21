process.env.PORT = "3000";
process.env.DISABLE_TELEGRAM_POLLING = "false";
process.env.CLEAR_TELEGRAM_WEBHOOK_ON_POLLING = process.env.CLEAR_TELEGRAM_WEBHOOK_ON_POLLING || "true";
process.env.NODE_ENV = process.env.NODE_ENV || "development";

const { startApp } = require("../server");

startApp().catch((error) => {
  if (error?.code === "EADDRINUSE") {
    console.error("Port 3000 is already busy. Close the old local server window and run npm run dev:bot again.");
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
