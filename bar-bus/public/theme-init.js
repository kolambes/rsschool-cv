(function () {
  var root = document.documentElement;
  var THEME_KEY = "theme";
  var theme = "comfort";

  function safeColor(value, fallback) {
    var color = typeof value === "string" ? value.trim() : "";
    return /^(#[0-9a-f]{3,8}|rgba?\([^)]+\))$/i.test(color) ? color : fallback;
  }

  function clearStoredTheme() {
    try {
      if (window.localStorage) window.localStorage.removeItem(THEME_KEY);
    } catch (error) {
      // Storage can be unavailable in private or embedded contexts.
    }
  }

  function apply(target) {
    if (!target) return;
    target.dataset.theme = theme;
    target.classList.remove("is-dark");
    target.classList.add("is-comfort");
  }

  function syncThemeLogos() {
    document.querySelectorAll("[data-theme-logo]").forEach(function (image) {
      var src = image.getAttribute("data-src") || "";
      if (src && image.getAttribute("src") !== src) {
        image.setAttribute("src", src);
      }
    });
  }

  clearStoredTheme();
  apply(root);
  root.style.colorScheme = "light";
  // Redesign palette: тёплый кремовый фон + глубокий teal-акцент.
  // Держим значения здесь, потому что они выставляются инлайном на <html>
  // и перебивают любые :root-правила в CSS.
  root.style.setProperty("--app-theme-bg", safeColor("", "#f1ece2"));
  root.style.setProperty("--app-theme-surface", safeColor("", "#fffdf7"));
  root.style.setProperty("--app-theme-text", safeColor("", "#1c2a28"));
  root.style.setProperty("--app-theme-muted", safeColor("", "#6f6a5e"));
  root.style.setProperty("--app-theme-accent", safeColor("", "#0f766e"));
  root.style.setProperty("--app-theme-accent-text", safeColor("", "#ffffff"));

  var themeColor = safeColor("", "#f1ece2");
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", themeColor);

  document.addEventListener("DOMContentLoaded", function () {
    apply(document.body);
    syncThemeLogos();
  }, { once: true });
})();
