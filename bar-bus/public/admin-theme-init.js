(function () {
  var theme = "comfort";

  try {
    if (window.localStorage) window.localStorage.removeItem("adminTheme");
  } catch (error) {
    theme = "comfort";
  }

  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.remove("is-dark");
  document.documentElement.classList.add("is-comfort");
  document.documentElement.style.colorScheme = "light";

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", "#f6f8fb");
})();
