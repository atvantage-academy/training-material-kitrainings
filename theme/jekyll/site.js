/* =============================================================================
   Web / GitHub Pages – Seitenverhalten
   -----------------------------------------------------------------------------
   Optionales Verhalten für Webseiten-Layouts, das ÜBER das markenweite
   theme/academy/atvantage.js hinausgeht (z. B. Hervorheben des aktiven Nav-Punkts).
   Abhängigkeitsfrei. Nur einbinden, wenn das Doku-Layout genutzt wird.
   ============================================================================= */
(function () {
  "use strict";

  /* Aktuellen Navigationspunkt anhand des Pfads markieren. */
  function markCurrentNav() {
    var here = location.pathname.replace(/\/index\.html$/, "/");
    document.querySelectorAll(".avd-academy-doc__nav a").forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href) return;
      var path = new URL(href, location.origin + location.pathname).pathname
        .replace(/\/index\.html$/, "/");
      if (path === here) a.setAttribute("aria-current", "page");
    });
  }

  /* Aktuelles Jahr in Footer einsetzen (Elemente mit [data-avd-academy-year]). */
  function fillYear() {
    var year = new Date().getFullYear();
    document.querySelectorAll("[data-avd-academy-year]").forEach(function (el) {
      el.textContent = year;
    });
  }

  function init() { markCurrentNav(); fillYear(); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
