const fs = require("node:fs/promises");
const { startHttpServer } = require("../server");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

(async () => {
  const server = await startHttpServer(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const [homeResponse, appJs, stylesCss] = await Promise.all([
      fetch(`${baseUrl}/`),
      fs.readFile("public/app.js", "utf8"),
      fs.readFile("public/styles.css", "utf8")
    ]);
    const home = await homeResponse.text();

    const activeViews = countMatches(home, /class="view is-active"/g);
    const navButtons = countMatches(home, /data-nav="/g);
    const scheduleControls = countMatches(home, /id="(routeSelect|directionSelect|stopSelect|stopSearch)"/g);

    const checks = [
      ["single start screen", activeViews === 1],
      ["starts on home", home.includes('class="view is-active" data-view="home"')],
      ["routes open as a separate view", home.includes('data-nav="routes"') && home.includes('data-view="routes"')],
      ["bottom menu stays compact", navButtons === 6],
      ["favorites are available in bottom menu", home.includes('data-nav="favorites"') && home.includes('data-view="favorites"')],
      ["services are available as a separate view", home.includes('data-nav="service"') && home.includes('data-view="service"')],
      ["about is available in bottom menu", home.includes('data-nav="about"') && home.includes('data-view="about"')],
      ["news is removed from public bottom menu", !home.includes('data-nav="news"') && !home.includes('data-open-view="news"')],
      ["settings are not pre-rendered for passengers", !home.includes("staff-settings-nav") && !home.includes("staffAdminEntry")],
      ["home has no slider", !home.includes("home-gallery") && !stylesCss.includes("home-slide")],
      ["appeal starts as one chat composer", home.includes('id="appealForm" hidden') && home.includes('class="client-chat" id="clientChat"') && home.includes('id="clientChatAttachButton"')],
      ["stop board is removed", !home.includes('data-view="board"') && !home.includes("statsStrip")],
      ["stop search scrolls to results", appJs.includes("scrollStopsIntoView")],
      ["main schedule fields are present", scheduleControls === 4],
      ["route is shown in one clear schedule hero", home.includes("schedule-hero") && home.includes("changeRouteButton")],
      ["duplicate native selects are hidden", home.includes("schedule-hidden-controls") && home.includes('id="quickRoutes"') && home.includes("hidden")],
      ["long stop list is collapsed by default", appJs.includes("showAllStops") && appJs.includes("selected-stop-card")],
      ["no old ZipiBus override remains", !stylesCss.includes("Simple passenger mode") && !stylesCss.includes("route-green")]
    ];

    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    assert(!failed.length, `UX-check failed: ${failed.join(", ")}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          simplicityScore: 100,
          activeViews,
          navButtons,
          scheduleControls,
          checks: checks.map(([name]) => name)
        },
        null,
        2
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
