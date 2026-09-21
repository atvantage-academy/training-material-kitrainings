/* =============================================================================
   a11y.mjs – misst das gebaute `_site` gegen die WCAG-Regeln von axe-core.
   -----------------------------------------------------------------------------
   Aufgerufen wird das Skript über `theme/jekyll/a11y.sh`; dort steht die Browsersuche und
   die Erklärung, wann der Lauf übersprungen wird. Hier steht die Mechanik.

   WARUM EIN EIGENER CDP-KLIENT UND KEIN PUPPETEER: Die Prüfung soll ohne
   Installation laufen – kein `npm install` in der Pipeline, kein Netz, kein
   nachgeladener Browser. Node bringt seit v22 `WebSocket` mit, und mehr braucht
   es nicht: Seite öffnen, axe hineinreichen, Ergebnis abholen. axe-core selbst
   liegt als Kopie daneben unter `vendor/axe-core/` (MPL-2.0) und wird mit dem
   npm-Paket ausgeliefert – die Schulungs-Repos messen damit dasselbe.

   WARUM EIN EIGENER SERVER UND NICHT `file://`: Das gebaute HTML verweist
   absolut (`/theme/academy/…`). Unter `file://` fände der Browser nichts davon,
   und gemessen würde eine Seite ohne Stylesheet – also nichts Belastbares.

   Aufruf:  node theme/jekyll/a11y.mjs --site _site --chrome «pfad» [--tags …]
   ============================================================================= */
import { createServer } from "node:http";
import { readFile, readdir, stat, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/* --- Aufrufparameter ------------------------------------------------------ */
const arg = (name, standard) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : standard;
};
const SITE = path.resolve(arg("site", "_site"));
const CHROME = arg("chrome", "");
const TAGS = arg("tags", "wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa").split(",");
const BREITEN = arg("widths", "1280,390").split(",").map(Number);
/* BEIDE FARBSCHEMATA, UND ZWAR AUSDRÜCKLICH. Ohne Vorgabe misst der Browser das
   Schema des Rechners, auf dem er läuft – und dann findet derselbe Lauf auf einem
   dunkel eingestellten Notebook nichts, was die Pipeline auf einem hellen Runner
   meldet. Genau so ist ein Kontrastfehler in einer Vorlage durchgerutscht: hell
   2,75:1, dunkel 4,49:1, gemessen wurde nur dunkel. */
const SCHEMATA = arg("schemes", "light,dark").split(",");
const JSONZIEL = arg("json", "");
const MDZIEL = arg("markdown", "");
const NICHT_SCHEITERN = process.argv.includes("--no-fail");
const AUSSCHLUSS = arg("exclude", "theme/atvantage,theme/academy").split(",").filter(Boolean);
const LAUT = process.argv.includes("--verbose");

/* Regeln, die hier NICHT gelten sollen, mit Begründung. Leer lassen ist die
   Regel; jeder Eintrag ist eine bewusste Entscheidung und gehört begründet. */
const AUSNAHMEN = {
  /* Beispiel: "color-contrast": "Markenfarbe, entschieden am …" */
};

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".webp": "image/webp", ".avif": "image/avif" };

/* --- Seitenliste ---------------------------------------------------------- */
async function seitenSammeln(wurzel) {
  const treffer = [];
  async function lauf(ordner) {
    for (const eintrag of await readdir(ordner, { withFileTypes: true })) {
      const voll = path.join(ordner, eintrag.name);
      const rel = path.relative(wurzel, voll);
      if (AUSSCHLUSS.some((a) => rel === a || rel.startsWith(a + path.sep))) continue;
      if (eintrag.isDirectory()) await lauf(voll);
      else if (eintrag.name.endsWith(".html")) treffer.push(rel.split(path.sep).join("/"));
    }
  }
  await lauf(wurzel);
  return treffer.sort();
}

/* --- Statischer Server ---------------------------------------------------- */
function serverStarten(wurzel) {
  return new Promise((fertig) => {
    const s = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
        let datei = path.join(wurzel, p);
        /* Kein Ausbrechen aus dem Wurzelverzeichnis. */
        if (!datei.startsWith(wurzel)) { res.writeHead(403).end(); return; }
        const s1 = await stat(datei).catch(() => null);
        if (s1 && s1.isDirectory()) datei = path.join(datei, "index.html");
        const inhalt = await readFile(datei);
        res.writeHead(200, { "content-type": MIME[path.extname(datei).toLowerCase()] || "application/octet-stream" });
        res.end(inhalt);
      } catch { res.writeHead(404).end("not found"); }
    });
    s.listen(0, "127.0.0.1", () => fertig({ server: s, port: s.address().port }));
  });
}

/* --- Chrome über das DevTools-Protokoll ----------------------------------- */
class Browser {
  constructor(ws) { this.ws = ws; this.id = 0; this.warten = new Map(); this.horcher = new Map(); }

  static async starten(chromePfad) {
    const profil = await mkdtemp(path.join(tmpdir(), "avd-a11y-"));
    const proc = spawn(chromePfad, [
      "--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profil,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
      "--disable-extensions", "--disable-dev-shm-usage", "--no-sandbox",
      "--force-device-scale-factor=1", "--disable-lcd-text", "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"] });

    /* Chrome schreibt die Adresse des Sockets auf stderr - mit Port 0 ist das
       der einzige Weg, den zufällig gewählten Port zu erfahren. */
    const url = await new Promise((fertig, fehler) => {
      let puffer = "";
      const zeit = setTimeout(() => fehler(new Error("Chrome meldet sich nicht (20 s)")), 20000);
      proc.stderr.on("data", (d) => {
        puffer += d.toString();
        const m = puffer.match(/ws:\/\/[^\s]+/);
        if (m) { clearTimeout(zeit); fertig(m[0]); }
      });
      proc.on("exit", (c) => { clearTimeout(zeit); fehler(new Error("Chrome beendet sich sofort (Code " + c + ")\n" + puffer.slice(0, 400))); });
    });

    const ws = new WebSocket(url);
    await new Promise((f, x) => { ws.onopen = f; ws.onerror = () => x(new Error("Kein Anschluss an " + url)); });
    const b = new Browser(ws);
    b.proc = proc;
    ws.onmessage = (e) => b.empfangen(JSON.parse(e.data));
    return b;
  }

  empfangen(n) {
    if (n.id && this.warten.has(n.id)) {
      const { fertig, fehler } = this.warten.get(n.id);
      this.warten.delete(n.id);
      n.error ? fehler(new Error(n.error.message)) : fertig(n.result);
      return;
    }
    const schluessel = (n.sessionId || "") + "|" + n.method;
    const h = this.horcher.get(schluessel);
    if (h) { this.horcher.delete(schluessel); h(n.params); }
  }

  /* JEDER AUFRUF HAT EINE FRIST. Ohne sie haengt der ganze Lauf, wenn eine
     einzige Seite den Browser beschaeftigt - und zwar ohne Ausgabe, weil der
     Bericht erst am Ende entsteht. Eine Pipeline, die stumm in ihr Zeitlimit
     laeuft, ist schlimmer als eine, die eine Seite nicht messen konnte. */
  ruf(methode, params = {}, sessionId, msFrist = 45000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method: methode, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((fertig, fehler) => {
      const uhr = setTimeout(() => {
        this.warten.delete(id);
        fehler(new Error(methode + " antwortet nicht (" + Math.round(msFrist / 1000) + " s)"));
      }, msFrist);
      this.warten.set(id, {
        fertig: (r) => { clearTimeout(uhr); fertig(r); },
        fehler: (e) => { clearTimeout(uhr); fehler(e); }
      });
    });
  }

  ereignis(methode, sessionId, msFrist) {
    return new Promise((fertig) => {
      const schluessel = (sessionId || "") + "|" + methode;
      this.horcher.set(schluessel, fertig);
      setTimeout(() => { if (this.horcher.get(schluessel)) { this.horcher.delete(schluessel); fertig(null); } }, msFrist);
    });
  }

  async seiteOeffnen() {
    const { targetId } = await this.ruf("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.ruf("Target.attachToTarget", { targetId, flatten: true });
    await this.ruf("Page.enable", {}, sessionId);
    await this.ruf("Runtime.enable", {}, sessionId);
    return { targetId, sessionId };
  }

  async seiteSchliessen(targetId) {
    try { await this.ruf("Target.closeTarget", { targetId }, undefined, 5000); } catch { /* egal */ }
  }

  async schliessen() {
    try { this.ws.close(); } catch { /* egal */ }
    try { this.proc.kill(); } catch { /* egal */ }
  }
}

/* --- Eine Seite messen ---------------------------------------------------- */
async function seiteMessen(b, sitzung, url, axeQuelle, breite, schema) {
  await b.ruf("Emulation.setDeviceMetricsOverride",
    { width: breite, height: 900, deviceScaleFactor: 1, mobile: breite < 700 }, sitzung);
  await b.ruf("Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: schema }] }, sitzung);
  const geladen = b.ereignis("Page.loadEventFired", sitzung, 30000);
  await b.ruf("Page.navigate", { url }, sitzung);
  await geladen;
  /* Kurz atmen lassen: Inhaltsverzeichnis, Fortschritt und Navigation entstehen
     erst im Browser, und genau die sollen mitgemessen werden. */
  await new Promise((f) => setTimeout(f, 400));
  await b.ruf("Runtime.evaluate", { expression: axeQuelle, returnByValue: false }, sitzung);
  const { result, exceptionDetails } = await b.ruf("Runtime.evaluate", {
    expression: `(async () => {
      if (document.fonts && document.fonts.ready) { await document.fonts.ready; }
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ${JSON.stringify(TAGS)} },
        resultTypes: ["violations"]
      });
      return JSON.stringify(r.violations.map(v => ({
        id: v.id, impact: v.impact, help: v.help, hilfe: v.helpUrl,
        stellen: v.nodes.length,
        beispiele: v.nodes.slice(0, 3).map(n => ({
          ziel: n.target.join(" "),
          markup: (n.html || "").replace(/\\s+/g, " ").slice(0, 160),
          grund: (n.any || []).concat(n.all || []).map(a => a.message).join("; ").slice(0, 200)
        }))
      })));
    })()`,
    awaitPromise: true, returnByValue: true
  }, sitzung);
  if (exceptionDetails) throw new Error(exceptionDetails.text || "axe ist gestolpert");
  return JSON.parse(result.value);
}

/* --- Hauptlauf ------------------------------------------------------------ */
const siteDa = await stat(SITE).catch(() => null);
if (!siteDa) { console.error("FEHLER: " + SITE + " gibt es nicht - erst bauen."); process.exit(2); }

const axeQuelle = await readFile(new URL("./vendor/axe-core/axe.min.js", import.meta.url), "utf8");
const AXE_VERSION = (axeQuelle.match(/axe\.version\s*=\s*["']([\d.]+)["']/) ||
                     axeQuelle.match(/version:\s*["']([\d.]+)["']/) || [, "?"])[1];
const seiten = await seitenSammeln(SITE);
const { server, port } = await serverStarten(SITE);

let b;
try { b = await Browser.starten(CHROME); }
catch (e) { server.close(); console.error("FEHLER beim Start von Chrome: " + e.message); process.exit(2); }

const funde = new Map();   // Regel -> { stellen, seiten:Set, beispiele[] }
let gemessen = 0, kaputt = [];

try {
 for (const schema of SCHEMATA) {
  for (const breite of BREITEN) {
    for (const seite of seiten) {
      const t0 = Date.now();
      /* EIN FRISCHER REITER JE SEITE. Mit einem einzigen, wiederverwendeten
         wurde der Lauf nach rund fünfzig Seiten immer langsamer und blieb dann
         stehen - jede Seite laesst Zuhoerer, Zeitgeber und Speicher zurueck, und
         axe misst am Ende gegen einen Browser, der schon muede ist. Ein neuer
         Reiter kostet etwa 50 ms und raeumt alles davon ab. */
      let ziel = null;
      try {
        ziel = await b.seiteOeffnen();
        const verstoesse = await seiteMessen(b, ziel.sessionId, `http://127.0.0.1:${port}/${seite}`, axeQuelle, breite, schema);
        gemessen++;
        if (LAUT) console.log(`  ${String(Date.now() - t0).padStart(5)} ms  ${seite} @${breite} ${schema}`);
        for (const v of verstoesse) {
          if (AUSNAHMEN[v.id]) continue;
          if (!funde.has(v.id)) funde.set(v.id, { ...v, stellen: 0, seiten: new Set(), beispiele: [] });
          const e = funde.get(v.id);
          e.stellen += v.stellen;
          e.seiten.add(seite + " @" + breite + " " + schema);
          for (const bsp of v.beispiele) if (e.beispiele.length < 3) e.beispiele.push(bsp);
        }
      } catch (e) {
        kaputt.push(seite + " @" + breite + " " + schema + ": " + e.message);
      } finally {
        if (ziel) await b.seiteSchliessen(ziel.targetId);
      }
    }
   }
  }
} finally {
  await b.schliessen();
  server.close();
}

/* --- Bericht -------------------------------------------------------------- */
const sortiert = [...funde.values()].sort((a, c) => c.stellen - a.stellen);
console.log(`Barrierefreiheit: ${gemessen} Messungen (${seiten.length} Seiten × ${BREITEN.length} Breiten × ${SCHEMATA.length} Farbschemata), Regelsatz ${TAGS.join(", ")}`);
if (kaputt.length) {
  console.log("\nNicht messbar:");
  kaputt.forEach((k) => console.log("  ! " + k));
}
for (const v of sortiert) {
  console.log(`\n[${v.impact}] ${v.id} – ${v.help}`);
  console.log(`  ${v.stellen} Stellen auf ${v.seiten.size} Seiten/Breiten: ` +
    [...v.seiten].slice(0, 4).join(", ") + (v.seiten.size > 4 ? " …" : ""));
  for (const bsp of v.beispiele) {
    console.log("  · " + bsp.ziel);
    console.log("      " + bsp.markup);
    if (bsp.grund) console.log("      → " + bsp.grund);
  }
  console.log("  " + v.hilfe);
}

/* --- Markdown fuer Laufzusammenfassung und PR-Kommentar ------------------- */
/* WARUM AUCH OHNE BEFUND EIN BERICHT ENTSTEHT: Eine Pruefung, von der man nur
   hoert, wenn sie etwas findet, ist von einer Pruefung, die gar nicht laeuft,
   nicht zu unterscheiden. Der Kommentar sagt deshalb immer, WAS geprueft wurde,
   WOMIT und mit welchem Ergebnis. */
if (MDZIEL) {
  const z = [];
  const summe = sortiert.reduce((n, v) => n + v.stellen, 0);
  z.push("<!-- avd-academy-a11y -->");
  z.push("## " + (sortiert.length ? "⚠️ Barrierefreiheit: " + sortiert.length + " Regel(n) verletzt" : "✅ Barrierefreiheit: keine Verletzung gefunden"));
  z.push("");
  z.push("Gemessen mit **axe-core " + AXE_VERSION + "** in Chrome – " + gemessen + " Messungen (" +
    seiten.length + " Seiten × " + BREITEN.join(" und ") + " Pixel Breite × Farbschema " +
    SCHEMATA.join(" und ") + "), Regelsatz `" + TAGS.join("`, `") + "`.");
  z.push("");
  if (sortiert.length) {
    z.push("| Regel | Schwere | Stellen | Was es bedeutet |");
    z.push("| --- | --- | --- | --- |");
    for (const v of sortiert) {
      z.push(`| [\`${v.id}\`](${v.hilfe}) | ${v.impact} | ${v.stellen} | ${v.help} |`);
    }
    z.push("");
    z.push("<details><summary>Beispiele</summary>");
    z.push("");
    for (const v of sortiert) {
      z.push("**" + v.id + "** – " + [...v.seiten].slice(0, 6).join(", ") + (v.seiten.size > 6 ? " …" : ""));
      z.push("");
      for (const bsp of v.beispiele) {
        z.push("- `" + bsp.ziel + "`" + (bsp.grund ? " – " + bsp.grund : ""));
      }
      z.push("");
    }
    z.push("</details>");
    z.push("");
    z.push("**Dieser Schritt blockiert nicht.** Er meldet, was mechanisch messbar ist – " +
      "nach verbreiteter Schätzung rund ein Drittel dessen, was Barrierefreiheit ausmacht. " +
      "Grün heißt „kein bekannter Fehler“, nicht „barrierefrei“.");
  } else {
    z.push("Keine der geprüften Regeln ist verletzt. Das Werkzeug misst, was mechanisch " +
      "entscheidbar ist – ob ein Alternativtext das Bild wiedergibt oder eine Simulation " +
      "ohne Maus zu Ende zu bedienen ist, sagt es nicht.");
  }
  if (kaputt.length) {
    z.push("");
    z.push("**Nicht messbar:** " + kaputt.length + " Seite(n) – " + kaputt.slice(0, 3).join("; "));
  }
  z.push("");
  z.push("<sub>Maßstab WCAG 2.2 AA · Erklärung: `docs/theme/barrierefreiheit.md` · lokal `make a11y`</sub>");
  await writeFile(MDZIEL, z.join("\n") + "\n");
  console.log("\nBericht (Markdown): " + MDZIEL);
}

if (JSONZIEL) {
  await writeFile(JSONZIEL, JSON.stringify(sortiert.map((v) => ({ ...v, seiten: [...v.seiten] })), null, 2));
  console.log("\nBericht: " + JSONZIEL);
}

const gesamtStellen = sortiert.reduce((n, v) => n + v.stellen, 0);
if (!sortiert.length && !kaputt.length) {
  console.log("\nOK – keine Verletzung der geprüften Regeln.");
} else {
  console.error(`\nBEFUND: ${sortiert.length} Regel(n), ${gesamtStellen} Stellen` +
    (kaputt.length ? `, ${kaputt.length} Seite(n) nicht messbar` : "") + ".");
}
/* `--no-fail` ist der Modus der Pipeline: Der Befund steht im Bericht und im
   Pull Request, aber er haelt den Build nicht an. Ohne den Schalter (also von
   Hand) scheitert der Lauf - dort will man den Fehlerstatus. */
if (!NICHT_SCHEITERN && (sortiert.length || kaputt.length)) process.exit(1);
