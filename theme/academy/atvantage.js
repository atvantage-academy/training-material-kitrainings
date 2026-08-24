/* =============================================================================
   ATVANTAGE Brand – interaktives Verhalten
   -----------------------------------------------------------------------------
   Kleines, abhängigkeitsfreies Skript für markenweite Interaktionen, die in
   JEDER Unterlage verfügbar sein sollen. Bewusst schlank gehalten; unterlagen-
   spezifische Logik gehört in das Skript der jeweiligen Unterlage.

   Aktuell enthalten:
     - Theme-Umschaltung  (Elemente mit [data-avd-academy-theme-toggle])
     - "Kopieren"-Buttons an Code-Blöcken (<pre>)
     - Mobiles Aufklappen der Header-Navigation ([data-avd-academy-nav-toggle])
     - "Markdown kopieren" auf Übungsseiten ([data-avd-academy-copy-md])
     - QR-Code der Seiten-URL ([data-avd-academy-qr])

   Einbindung: <script src="<BASISPFAD>/atvantage.js" defer></script>
   ============================================================================= */
(function () {
  "use strict";

  /* Eigene Adresse merken, SOLANGE das Skript läuft: `document.currentScript` ist
     nur während der Ausführung gesetzt (bei `defer` also genau hier, nicht mehr in
     späteren Callbacks). Der QR-Code lädt seine Bibliothek relativ dazu nach – so
     braucht das Skript weder den Jekyll-`baseurl` noch einen fest verdrahteten
     Pfad. Inline eingebunden (kein `src`) bleibt der Wert leer; dann fällt der
     Nachladepfad auf die Dokument-Basis zurück. */
  var scriptUrl = (document.currentScript && document.currentScript.src) || "";

  /* --- Theme-Umschaltung -------------------------------------------------- */
  function initThemeToggle() {
    document.querySelectorAll("[data-avd-academy-theme-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var root = document.documentElement;
        var next = root.getAttribute("data-avd-academy-theme") === "dark" ? "light" : "dark";
        root.setAttribute("data-avd-academy-theme", next);
        try { localStorage.setItem("avd-academy-theme", next); } catch (e) { /* egal */ }
      });
    });
    try {
      var saved = localStorage.getItem("avd-academy-theme");
      if (saved) document.documentElement.setAttribute("data-avd-academy-theme", saved);
    } catch (e) { /* egal */ }
  }

  /* --- Kopieren-Buttons an Code-Blöcken ----------------------------------- */
  function initCopyButtons() {
    document.querySelectorAll("pre > code").forEach(function (code) {
      var pre = code.parentElement;
      if (pre.querySelector(".avd-academy-copy")) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "avd-academy-btn avd-academy-btn--primary avd-academy-copy";
      btn.title = "Kopieren";
      btn.setAttribute("aria-label", "Kopieren");
      btn.style.position = "absolute";
      btn.style.top = "0.5rem";
      btn.style.right = "0.5rem";
      pre.style.position = "relative";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(code.innerText).then(function () {
          btn.classList.add("is-copied");
          btn.title = "Kopiert!";
          setTimeout(function () {
            btn.classList.remove("is-copied");
            btn.title = "Kopieren";
          }, 1500);
        });
      });
      pre.appendChild(btn);
    });
  }

  /* --- Mobile Navigation --------------------------------------------------
     Der Burger klappt das per CSS (max-width) eingeklappte Nav auf/zu. Auf
     breiten Viewports ist der Burger ausgeblendet und das Nav ohnehin sichtbar;
     das Attribut [data-open] ist dort wirkungslos. */
  function closeAllNavs() {
    document.querySelectorAll("[data-avd-academy-nav-toggle]").forEach(function (btn) {
      var t = document.querySelector(btn.getAttribute("data-avd-academy-nav-toggle"));
      if (t) t.removeAttribute("data-open");
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function initNavToggle() {
    var toggles = document.querySelectorAll("[data-avd-academy-nav-toggle]");
    if (!toggles.length) return;

    toggles.forEach(function (btn) {
      var target = document.querySelector(btn.getAttribute("data-avd-academy-nav-toggle"));
      if (!target) return;
      btn.setAttribute("aria-expanded", "false");
      if (target.id) btn.setAttribute("aria-controls", target.id);

      btn.addEventListener("click", function () {
        var open = target.toggleAttribute("data-open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });

      /* Klick auf einen Link schließt das Menü (Zielseite wird geladen). */
      target.addEventListener("click", function (e) {
        if (e.target.closest("a")) closeAllNavs();
      });
    });

    /* Escape schließt; Klick außerhalb des Headers schließt. */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAllNavs();
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".avd-academy-header")) closeAllNavs();
    });
  }

  /* --- "Markdown kopieren" (Übungsseiten) ---------------------------------
     Kopiert den rohen Markdown-Inhalt aus dem versteckten <textarea>, auf das
     der Button per [data-avd-academy-copy-md="#id"] zeigt. */
  function initCopyMarkdown() {
    document.querySelectorAll("[data-avd-academy-copy-md]").forEach(function (btn) {
      var src = document.querySelector(btn.getAttribute("data-avd-academy-copy-md"));
      if (!src) return;
      btn.addEventListener("click", function () {
        var text = (src.value != null) ? src.value : src.textContent;
        navigator.clipboard.writeText(text).then(function () {
          var oldTitle = btn.title || btn.getAttribute("aria-label");
          btn.classList.add("is-copied");
          btn.title = "Kopiert!";
          setTimeout(function () {
            btn.classList.remove("is-copied");
            btn.title = oldTitle;
          }, 1500);
        });
      });
    });
  }

  /* --- Übung: Inhaltsverzeichnis automatisch aus Überschriften ------------- */
  function initGuideToc() {
    var toc = document.querySelector("[data-avd-academy-toc]");
    var main = document.querySelector(".avd-academy-guide-main, .avd-academy-doc-main");
    // Karte, die das Inhaltsverzeichnis trägt (Guide- oder Doc-Layout).
    var tocCard = toc && toc.closest(".avd-academy-guide-side, [data-avd-academy-toc-box]");

    if (toc && main) {
      // Nur Überschriften auf oberster Ebene (nicht in Karten/Zitaten verschachtelte).
      var heads = main.querySelectorAll(":scope > h2, :scope > h3");
      // Inhaltsverzeichnis erst ab mindestens ZWEI Überschriften anzeigen.
      if (heads.length >= 2) {
        heads.forEach(function (h) {
          if (!h.id) {
            h.id = (h.textContent || "").toLowerCase().trim()
              .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
          }
          var a = document.createElement("a");
          a.href = "#" + h.id;
          a.textContent = h.textContent;
          if (h.tagName === "H3") a.className = "avd-academy-toc--h3";
          toc.appendChild(a);
        });
        if (tocCard) {
          tocCard.hidden = false;
          /* ZUGEKLAPPT STARTEN, wenn das Verzeichnis lang ist – aber nur, wenn darunter
             ueberhaupt noch eine Karte sichtbar ist (Fortschritt, weiterfuehrende Links).
             Ist das Verzeichnis das letzte Element der Sidebar, verdeckt es nichts; dann
             es zuzuklappen wuerde dem Leser nur einen Klick abverlangen, ohne dass er
             etwas gewinnt. Die Fortschrittskarte blendet sich in initGuideProgress()
             selbst ein – die laeuft vorher, ihr [hidden] ist hier also endgueltig.
             Hat die Seite den Zustand selbst gesetzt, gilt sie und beides bleibt aussen vor. */
          var vorgabe = tocCard.getAttribute("data-avd-academy-toc-open");
          if (vorgabe !== null) {
            tocCard.open = vorgabe !== "false";
          } else {
            var darunter = false;
            for (var g = tocCard.nextElementSibling; g; g = g.nextElementSibling) {
              if (!g.hidden) { darunter = true; break; }
            }
            var grenze = parseInt(tocCard.getAttribute("data-avd-academy-toc-grenze"), 10);
            if (darunter && !isNaN(grenze) && grenze > 0 && heads.length > grenze) tocCard.open = false;
          }
        }
        if ("IntersectionObserver" in window) {
          var links = toc.querySelectorAll("a");
          var byId = {};
          links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
          var obs = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
              var a = byId[en.target.id];
              if (a && en.isIntersecting) {
                links.forEach(function (x) { x.removeAttribute("aria-current"); });
                a.setAttribute("aria-current", "true");
              }
            });
          }, { rootMargin: "0px 0px -75% 0px" });
          heads.forEach(function (h) { obs.observe(h); });
        }
      } else if (tocCard) {
        tocCard.hidden = true;
      }
    }

    // Doc-Layout: rechte Sidebar nur zeigen, wenn sie sichtbaren Inhalt hat
    // (Inhaltsverzeichnis mit >= 2 Einträgen und/oder „Weiterführende
    // Informationen“). Sonst einspaltig.
    var docLayout = document.querySelector(".avd-academy-doc-layout");
    if (docLayout) {
      var sidebar = docLayout.querySelector(".avd-academy-doc-sidebar");
      if (sidebar) {
        if (sidebar.querySelector(":scope > :not([hidden])")) {
          docLayout.classList.add("avd-academy-doc-layout--with-sidebar");
        } else {
          sidebar.hidden = true;
        }
      }
    }
  }

  /* --- Fortschritt aus Task-Listen-Checkboxen -----------------------------
     Funktioniert im Guide- wie im Doc-Layout (Definition of Done bzw.
     Voraussetzungen). Läuft VOR der Doc-Sidebar-Sichtbarkeitsprüfung in
     initGuideToc(), damit die (per [hidden]) versteckte Fortschrittskarte dort
     korrekt als „leer“ zählt. */
  function initGuideProgress() {
    var box = document.querySelector("[data-avd-academy-progress]");
    var main = document.querySelector(".avd-academy-guide-main, .avd-academy-doc-main");
    if (!box || !main) return;
    var checks = main.querySelectorAll('input[type="checkbox"]');
    if (!checks.length) { box.hidden = true; return; }
    box.hidden = false;
    var fill = box.querySelector(".avd-academy-progress__fill");
    var text = box.querySelector(".avd-academy-progress__text");
    function update() {
      var done = 0;
      checks.forEach(function (c) { if (c.checked) done++; });
      var pct = Math.round((done / checks.length) * 100);
      if (fill) fill.style.width = pct + "%";
      if (text) text.textContent = done + " / " + checks.length + " erledigt";
      // Vollständig erledigt → grüner Haken (Balken/Text bleiben sichtbar).
      box.classList.toggle("is-complete", done === checks.length);
    }
    checks.forEach(function (c) {
      c.disabled = false;
      c.addEventListener("change", update);
    });
    update();
  }

  /* --- Header-Untermenü (Dropdown / im Burger aufklappbar) ----------------- */
  function closeAllMenus(except) {
    document.querySelectorAll(".avd-academy-header__submenu[data-open]").forEach(function (s) {
      if (s === except) return;
      s.removeAttribute("data-open");
      var t = s.parentNode.querySelector(".avd-academy-header__grouptoggle");
      if (t) t.setAttribute("aria-expanded", "false");
    });
  }
  function initNavDropdown() {
    var groups = document.querySelectorAll("[data-avd-academy-menu]");
    if (!groups.length) return;
    groups.forEach(function (group) {
      var toggle = group.querySelector(".avd-academy-header__grouptoggle");
      var submenu = group.querySelector(".avd-academy-header__submenu");
      if (!toggle || !submenu) return;
      toggle.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var open = submenu.hasAttribute("data-open");
        closeAllMenus(submenu);
        if (open) {
          submenu.removeAttribute("data-open");
          toggle.setAttribute("aria-expanded", "false");
        } else {
          submenu.setAttribute("data-open", "");
          toggle.setAttribute("aria-expanded", "true");
        }
      });
    });
    document.addEventListener("click", function (e) {
      document.querySelectorAll("[data-avd-academy-menu]").forEach(function (group) {
        if (!group.contains(e.target)) {
          var s = group.querySelector(".avd-academy-header__submenu[data-open]");
          if (s) closeAllMenus();
        }
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAllMenus();
    });
  }

  /* --- Drucken-Button -----------------------------------------------------
     Löst den Druckdialog aus. Genutzt im Hero der Visualisierungs-Ansicht: Sie
     hat keine Kopfzeile und keine Sidebar, in der ein Weg zum Ausdruck stecken
     könnte. Ohne JavaScript bleibt der Knopf wirkungslos – wie die
     Kopier-Buttons, deren Funktion ebenfalls am Skript hängt. */
  function initPrintButtons() {
    document.querySelectorAll("[data-avd-academy-print]").forEach(function (btn) {
      btn.addEventListener("click", function () { window.print(); });
    });
  }

  /* --- QR-Code der Seiten-URL ---------------------------------------------
     Neben dem Drucken- bzw. Kopieren-Button steht ein QR-Code auf die Adresse
     der aktuellen Seite: „Diese Seite auf Deinem Smartphone öffnen“ – vom
     Beamer oder vom gedruckten Blatt in die eigene Hand, ohne Abtippen.

     Warum clientseitig: Die Adresse kennt erst der Browser. Zur Build-Zeit
     fehlen Host und `baseurl` (dieselbe Unterlage läuft unter github.io, im
     lokalen Jekyll-Server und in einem Fork), und das Fragment (#/3 der
     Präsentation) ändert sich sogar ohne Seitenwechsel.

     Das Layout stellt nur einen leeren, [hidden] gesetzten Platzhalter
     `<button class="avd-academy-qr" data-avd-academy-qr>` bereit. Der Code
     selbst wird hier gebaut und per DOM eingehängt, sobald die Bibliothek
     geladen und die Matrix berechnet ist. Ohne JavaScript (oder wenn das
     Nachladen scheitert) bleibt der Platzhalter verborgen – die Werkzeugzeile
     sieht dann aus wie zuvor.

     Die Matrix kommt aus der mitgelieferten Bibliothek `qrcode/` (MIT, siehe
     dortige README); das SVG baut das Theme selbst. */
  var QR_SVG_NS = "http://www.w3.org/2000/svg";
  /* Ruhezone in Modulen. ISO/IEC 18004 fordert 4 – ohne sie finden Scanner die
     Begrenzung des Codes nicht. */
  var QR_QUIET = 4;

  function buildQrSvg(factory, text) {
    /* 0 = kleinste Version, die die Nutzlast trägt; „M“ = 15 % Redundanz (guter
       Kompromiss: verzeiht Bildschirm-Spiegelungen und Druckraster, ohne die
       Module unnötig klein werden zu lassen). */
    var qr = factory(0, "M");
    qr.addData(text);
    qr.make();

    var count = qr.getModuleCount();
    var size = count + 2 * QR_QUIET;

    /* EIN Pfad für alle dunklen Module, zeilenweise zu waagerechten Läufen
       zusammengefasst. Ein Rechteck je Modul wäre ein Vielfaches an Knoten. */
    var d = "";
    for (var row = 0; row < count; row++) {
      var col = 0;
      while (col < count) {
        if (!qr.isDark(row, col)) { col++; continue; }
        var start = col;
        while (col < count && qr.isDark(row, col)) col++;
        var len = col - start;
        d += "M" + (start + QR_QUIET) + " " + (row + QR_QUIET) +
             "h" + len + "v1h-" + len + "z";
      }
    }

    var svg = document.createElementNS(QR_SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    /* Modulkanten scharf halten – weichgezeichnete Ränder kosten Lesbarkeit. */
    svg.setAttribute("shape-rendering", "crispEdges");
    /* Für Screenreader wertlos; die Beschriftung trägt der Button. */
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    /* Fläche und Module bleiben OHNE fill-Attribut: Die Farben setzt
       components.css aus den ATVANTAGE-Tokens (--avd-white/--avd-ink). Sie
       folgen bewusst NICHT dem Farbschema – ein invertierter QR-Code (hell auf
       dunkel) wird von vielen Scannern nicht gelesen. Die Fläche deckt auch die
       Ruhezone ab. */
    var bg = document.createElementNS(QR_SVG_NS, "rect");
    bg.setAttribute("width", String(size));
    bg.setAttribute("height", String(size));
    svg.appendChild(bg);

    var path = document.createElementNS(QR_SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);

    return svg;
  }

  function closeQrZoom() {
    document.querySelectorAll(".avd-academy-qr").forEach(function (host) {
      host.classList.remove("is-zoom");
      /* Auch den Fokus abgeben: Solange die Schaltfläche ihn hat, hält ihn
         `:focus-visible` vergrößert – Zuklappen sähe wirkungslos aus. Betrifft
         die Tastaturbedienung; wer klickt oder tippt, hat keinen sichtbaren
         Fokus und merkt davon nichts. */
      if (document.activeElement === host) host.blur();
    });
  }

  function initPageQr() {
    var hosts = document.querySelectorAll("[data-avd-academy-qr]");
    if (!hosts.length) return;
    /* Nur echte Web-Adressen. Ein QR-Code auf `file:///…` (lokal geöffnete
       Datei) oder `about:` führt auf dem Smartphone ins Leere; dort bleibt der
       Platzhalter besser verborgen als ein Code, der nicht funktioniert. */
    if (location.protocol !== "http:" && location.protocol !== "https:") return;

    var libUrl;
    try {
      libUrl = new URL("qrcode/qrcode.mjs", scriptUrl || document.baseURI).href;
    } catch (e) { return; }

    import(libUrl).then(function (mod) {
      var factory = mod.default;
      /* Zuletzt kodierte Adresse – schützt davor, bei jedem Ereignis dieselbe
         Matrix neu zu rechnen. */
      var shown = null;

      function render() {
        if (location.href === shown) return;
        shown = location.href;
        hosts.forEach(function (host) {
          var box = document.createElement("span");
          box.className = "avd-academy-qr__box";
          box.appendChild(buildQrSvg(factory, shown));
          host.replaceChildren(box);
          host.hidden = false;
        });
      }

      render();

      /* Die Adresse kann sich ohne Seitenwechsel ändern: Die Präsentation führt
         die aktuelle Folie im Fragment (#/3). Ohne Neuberechnung zeigte der Code
         auf eine Folie, die längst weitergeblättert ist.

         Zwei Ereignisse, weil eines nicht genügt: `hashchange` deckt Sprungmarken
         und Vor/Zurück ab; die Präsentation setzt das Fragment aber per
         `history.replaceState`, und das löst kein `hashchange` aus – dafür sendet
         presentation.js `avd-academy-urlchange`. */
      window.addEventListener("hashchange", render);
      window.addEventListener("avd-academy-urlchange", render);

      /* Vergrößern: Auf Zeigergeräten genügt CSS (:hover/:focus-visible). Touch
         kennt kein Überfahren – dort öffnet ein Tipp den Code, ein Tipp daneben
         oder Escape schließt ihn wieder. */
      hosts.forEach(function (host) {
        host.addEventListener("click", function () {
          host.classList.toggle("is-zoom");
        });
      });
      /* Klick daneben schließt. Bewusst OHNE `stopPropagation` am Knopf selbst:
         Das Ereignis soll weiterlaufen, damit die übrigen Zuhörer am Dokument
         (offenes Menü/Nav schließen) auch dann greifen, wenn der QR-Code
         angetippt wird. */
      document.addEventListener("click", function (e) {
        if (e.target.closest(".avd-academy-qr")) return;
        closeQrZoom();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeQrZoom();
      });
    }).catch(function () {
      /* Bibliothek nicht ladbar → Platzhalter bleibt [hidden]. */
    });
  }

  /* --- Zurück-Knopf ------------------------------------------------------------
     Ein Verweis auf „die übergeordnete Seite“ wäre geraten: Wir wissen nicht, wie
     jemand hergekommen ist – über das Modul, aus der Suche, per QR-Code vom
     Beamer, aus einem Chat. Deshalb kein Link auf eine gedachte Hierarchie,
     sondern der Weg zurück, den der Browser tatsächlich kennt.

     Der Knopf bleibt versteckt, wenn es nichts gibt, wohin er führen könnte –
     etwa beim Öffnen in einem frischen Tab. `history.length` ist dafür der
     einzige Anhaltspunkt, den eine Seite hat; er zählt auch Einträge fremder
     Herkunft, taugt aber, um den Knopf bei einem leeren Verlauf wegzulassen. */
  function initBackButtons() {
    var knoepfe = document.querySelectorAll("[data-avd-academy-back]");
    if (!knoepfe.length) return;
    var gibtVerlauf = window.history.length > 1;
    Array.prototype.forEach.call(knoepfe, function (knopf) {
      if (!gibtVerlauf) return;
      knopf.removeAttribute("hidden");
      knopf.addEventListener("click", function () { window.history.back(); });
    });
  }

  /* --- Aufdeckbarer Inhalt (`avd-academy-reveal`) --------------------------
     Die mittige Darstellung macht CSS an `[open]`; hier kommt nur dazu, was
     `<details>` nicht mitbringt:
       - ein Rahmen um den Inhalt (`__body`), damit Panel und Overlay getrennt
         liegen und das Panel eine eigene Fläche bekommt,
       - der Titel im Panel (aus dem `summary`), damit sichtbar bleibt, was
         geöffnet ist,
       - Klick daneben, ESC und ein Schließen-Kreuz.
     Ohne dieses Skript bleibt der Baustein ein gewöhnlicher Aufklapper – der
     Inhalt ist dann erreichbar, nur nicht mittig. Kein Schulungsinhalt hängt
     also am JavaScript. */
  function initReveals() {
    document.querySelectorAll("details.avd-academy-reveal").forEach(function (details) {
      var summary = details.querySelector(":scope > summary");
      if (!summary) return;

      var body = details.querySelector(":scope > .avd-academy-reveal__body");
      if (!body) {
        body = document.createElement("div");
        body.className = "avd-academy-reveal__body";
        // Alles außer dem summary in den Rahmen umhängen (Reihenfolge bleibt).
        var kinder = [];
        details.childNodes.forEach(function (n) { if (n !== summary) kinder.push(n); });
        kinder.forEach(function (n) { body.appendChild(n); });
        details.appendChild(body);
      }

      if (!body.querySelector(".avd-academy-reveal__title")) {
        var titel = document.createElement("p");
        titel.className = "avd-academy-reveal__title";
        titel.textContent = summary.textContent.trim();
        body.insertBefore(titel, body.firstChild);
      }

      if (!body.querySelector(".avd-academy-reveal__close")) {
        var knopf = document.createElement("button");
        knopf.type = "button";
        knopf.className = "avd-academy-reveal__close";
        knopf.setAttribute("aria-label", "Schließen");
        knopf.innerHTML = "&times;";
        knopf.addEventListener("click", function () { details.open = false; });
        body.appendChild(knopf);
      }

      /* Klick NEBEN das Panel schließt. Der Klick auf die Abdunkelung landet am
         `details` selbst (sie ist dessen ::before), Klicks im Panel nicht – die
         fängt der zweite Handler ab. */
      details.addEventListener("click", function (event) {
        if (!details.open) return;
        if (event.target === summary || summary.contains(event.target)) return;
        if (body.contains(event.target)) return;
        details.open = false;
      });
    });

    /* ESC schließt das oberste offene Panel. `<details>` kennt das nicht. */
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      var offen = document.querySelectorAll("details.avd-academy-reveal[open]");
      if (!offen.length) return;
      offen[offen.length - 1].open = false;
    });

    /* FÜR DEN AUSDRUCK AUFKLAPPEN. Das muss hier passieren und lässt sich NICHT
       in print.css lösen: Ein geschlossenes `<details>` verbirgt seinen Inhalt
       über einen Slot im Shadow DOM (`content-visibility`), nicht über ein
       `display: none` an den Kindern – von außen ist das per CSS nicht
       aufzuheben. print.css baut anschließend nur noch Overlay und Panelfläche
       zurück, damit der Inhalt eingebettet in der Seite steht.
       `--screen-only` bleibt zu (und wird in print.css ausgeblendet): Ein
       Ausdruck, der die Musterlösung mitbringt, nimmt der Übung den Sinn.
       Nach dem Druck wird der vorherige Zustand wiederhergestellt. */
    var fuerDruckGeoeffnet = [];
    function vorDemDruck() {
      fuerDruckGeoeffnet = [];
      document.querySelectorAll("details.avd-academy-reveal").forEach(function (d) {
        if (d.classList.contains("avd-academy-reveal--screen-only")) return;
        if (d.open) return;
        d.open = true;
        fuerDruckGeoeffnet.push(d);
      });
    }
    function nachDemDruck() {
      fuerDruckGeoeffnet.forEach(function (d) { d.open = false; });
      fuerDruckGeoeffnet = [];
    }
    window.addEventListener("beforeprint", vorDemDruck);
    window.addEventListener("afterprint", nachDemDruck);
    /* Älteres Safari kennt beforeprint/afterprint nicht, wohl aber den
       Medienwechsel. */
    if (window.matchMedia) {
      var mq = window.matchMedia("print");
      var beiWechsel = function (e) { if (e.matches) { vorDemDruck(); } else { nachDemDruck(); } };
      if (mq.addEventListener) { mq.addEventListener("change", beiWechsel); }
      else if (mq.addListener) { mq.addListener(beiWechsel); }
    }
  }

  function init() {
    initBackButtons();
    initThemeToggle();
    initCopyButtons();
    initNavToggle();
    initNavDropdown();
    initCopyMarkdown();
    initPrintButtons();
    initPageQr();
    initGuideProgress();
    initGuideToc();
    initReveals();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
