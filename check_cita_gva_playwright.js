// check_cita_gva_playwright.js
// Deep-link + acordeones + selección de SERVICIO por similitud + volcados de opciones.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const {
  GVA_BASE = "https://sige.gva.es/qsige/citaprevia.justicia",
  APPOINTMENT_UUID,
  APPOINTMENT_URL,
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TIMEOUT_MS = "180000",
  HEADLESS = "false",
  BROWSER_CHANNEL = "chrome",
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 180000;
const VIDEOS_DIR = path.resolve("videos");
const TRACES_DIR = path.resolve("traces");
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(TRACES_DIR, { recursive: true });

/* ---------- utilidades ---------- */

const norm = (s) =>
  (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function similarityScore(targetNorm, optionNorm) {
  // puntuación simple: presencia de tokens + contains global
  const tks = targetNorm.split(/\s+/).filter(Boolean);
  let score = 0;
  if (optionNorm.includes(targetNorm)) score += 5;
  for (const tk of tks) if (tk.length > 2 && optionNorm.includes(tk)) score += 1;
  // pequeño bonus por longitud parecida
  const lenDiff = Math.abs(optionNorm.length - targetNorm.length);
  if (lenDiff <= 5) score += 1;
  return score;
}

async function waitMaskGone(scope, maxMs = 45000) {
  const end = Date.now() + maxMs;
  const masks = [
    scope.locator(".loading-mask"),
    scope.locator('[aria-busy="true"]'),
    scope.locator(".v-progress-circular, .spinner, .loading"),
  ];
  while (Date.now() < end) {
    let anyVisible = false;
    for (const m of masks) {
      if (await m.first().isVisible().catch(() => false)) { anyVisible = true; break; }
    }
    if (!anyVisible) {
      await scope.waitForLoadState?.("networkidle", { timeout: 8000 }).catch(() => {});
      await scope.waitForTimeout?.(200);
      return true;
    }
    await scope.waitForTimeout?.(200);
  }
  return false;
}

async function closeCookiesIfAny(scope) {
  try {
    const cands = [
      scope.getByRole?.("button", { name: /acept(ar|o)|consentir|aceptar todas/i }),
      scope.locator?.('button:has-text("Aceptar")'),
      scope.locator?.('text=/Aceptar todas/i'),
      scope.locator?.('text=/Acceptar totes/i'),
    ].filter(Boolean);
    for (const c of cands) {
      const v = await c.first().isVisible().catch(() => false);
      if (v) { await c.first().click({ timeout: 3000 }).catch(() => {}); break; }
    }
  } catch {}
}

async function onAppointmentScreen(scope, totalWaitMs = 60000) {
  const end = Date.now() + totalWaitMs;
  const probes = [
    /Centro y servicio/i, /Seleccione centro/i, /Seleccione servicio/i,
    /Siguiente|Següent/i, /Centre i servei/i, /Seleccione centre|servei/i
  ];
  while (Date.now() < end) {
    const gone = await waitMaskGone(scope, 4000);
    for (const re of probes) {
      const el = scope.locator(`text=/${re.source}/${re.flags}`).first();
      if (await el.isVisible().catch(() => false)) return true;
    }
    if (!gone) await scope.waitForTimeout?.(250);
  }
  return false;
}

async function tryDeepLink(page) {
  const url = APPOINTMENT_URL
    ? APPOINTMENT_URL
    : (APPOINTMENT_UUID ? `${GVA_BASE}/#/es/appointment?uuid=${APPOINTMENT_UUID}` : null);

  if (!url) return false;
  console.log("→ Intentando deep-link:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await closeCookiesIfAny(page);
  const ok = await onAppointmentScreen(page, 90000);
  if (!ok) {
    await page.screenshot({ path: "after_deeplink.png", fullPage: true }).catch(() => {});
    fs.writeFileSync("after_deeplink.html", await page.content());
  }
  return ok;
}

/* ---------- acordeones ---------- */

async function expandAllAccordions(scope) {
  const headers = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link');
  const count = await headers.count();
  console.log(`→ Detectados ${count} acordeones`);
  for (let i = 0; i < count; i++) {
    const h = headers.nth(i);
    try {
      await h.scrollIntoViewIfNeeded().catch(() => {});
      const expanded = await h.getAttribute("aria-expanded").catch(() => null);
      if (expanded !== "true") {
        for (const tryClick of [
          () => h.click({ timeout: 1000 }),
          () => h.click({ timeout: 1000, force: true }),
          () => h.evaluate(el => el && el.click()),
        ]) { try { await tryClick(); break; } catch {} }
        await scope.waitForTimeout(120);
      }
    } catch {}
  }
}

async function ensurePanelOpen(scope, titleRe) {
  const headers = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link')
    .filter({ hasText: titleRe });
  const n = await headers.count();
  for (let i = 0; i < n; i++) {
    const h = headers.nth(i);
    try {
      await h.scrollIntoViewIfNeeded().catch(() => {});
      const expanded = await h.getAttribute("aria-expanded").catch(() => null);
      if (expanded !== "true") {
        for (const tryClick of [
          () => h.click({ timeout: 1000 }),
          () => h.click({ timeout: 1000, force: true }),
          () => h.evaluate(el => el && el.click()),
        ]) { try { await tryClick(); break; } catch {} }
        await scope.waitForTimeout(120);
      }
    } catch {}
  }
}

function panelContent(scope, titleRe) {
  const tab = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link').filter({ hasText: titleRe }).first();
  const container = tab.locator('xpath=following::*[contains(@class,"p-accordion-content") or @role="region" or contains(@class,"p-panel-content")][1]');
  return container;
}

/* ---------- extracción y selección por similitud ---------- */

async function listOptionsIn(container) {
  // Diferentes selectores típicos de PrimeNG
  const selectors = [
    'li', 'label', 'button', 'a',
    '[role="option"]', '[role="radio"]', '[role="menuitem"]', '[role="treeitem"]',
    '.p-dropdown-item', '.p-autocomplete-item', '.p-select-list-item', '.p-radiobutton-box + label'
  ];
  const texts = new Set();
  for (const sel of selectors) {
    const items = container.locator(sel);
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const t = norm(await items.nth(i).innerText().catch(() => ""));
      if (t) texts.add(t);
    }
  }
  const list = Array.from(texts);
  // dump para depurar
  try { fs.writeFileSync("services_found.txt", list.join("\n"), "utf8"); } catch {}
  return list;
}

async function chooseBestOption(container, targetText) {
  const target = norm(targetText);
  // 1) intenta inputs de búsqueda
  const inputs = container.locator('input[role="combobox"], input[type="search"], input[type="text"], .p-inputtext input, .p-autocomplete input, .p-dropdown-filter');
  if (await inputs.count() > 0) {
    const inp = inputs.first();
    try {
      await inp.scrollIntoViewIfNeeded().catch(()=>{});
      await inp.fill("");
      await inp.type(targetText, { delay: 25 });
      await container.waitForTimeout(600);
      // intenta seleccionar la primera opción visible
      const popup = container.locator('[role="option"], .p-autocomplete-item, .p-dropdown-item').filter({ hasText: new RegExp(targetText, "i") }).first();
      if (await popup.isVisible().catch(()=>false)) {
        for (const clickTry of [
          () => popup.click({ timeout: 1500 }),
          () => popup.click({ timeout: 1500, force: true }),
          () => popup.evaluate(el => el && el.click()),
        ]) { try { await clickTry(); return true; } catch {} }
      } else {
        // alternativo: Enter
        await inp.press("Enter").catch(()=>{});
        await container.waitForTimeout(400);
      }
    } catch {}
  }

  // 2) lista completa con scroll + similitud
  const MAX_STEPS = 30;
  let bestLoc = null, bestScore = -1, bestText = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const options = await listOptionsIn(container);
    for (const optText of options) {
      const score = similarityScore(target, optText);
      if (score > bestScore) {
        bestScore = score;
        bestText = optText;
      }
    }
    if (bestScore >= 2) {
      // obtiene locator del mejor candidato por texto
      const rx = new RegExp(bestText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      bestLoc = container.locator(`[role="option"] >> text=/${rx.source}/${rx.flags}`)
        .first()
        .or(container.locator(`.p-dropdown-item:has-text(/${rx.source}/${rx.flags})`).first())
        .or(container.locator(`.p-autocomplete-item:has-text(/${rx.source}/${rx.flags})`).first())
        .or(container.locator(`li:has-text(/${rx.source}/${rx.flags})`).first())
        .or(container.locator(`label:has-text(/${rx.source}/${rx.flags})`).first())
        .or(container.locator(`button:has-text(/${rx.source}/${rx.flags})`).first())
        .or(container.locator(`a:has-text(/${rx.source}/${rx.flags})`).first());
      if (bestLoc) break;
    }

    // scroll si aún no hay buen match
    const scrolled = await container.evaluate((node) => {
      if (!node) return false;
      const el = node;
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + 400, el.scrollHeight);
      return el.scrollTop !== before;
    }).catch(()=>false);
    if (!scrolled) { await container.page().mouse.wheel(0, 600).catch(()=>{}); }
    await container.page().waitForTimeout(180);
  }

  if (!bestLoc) return false;

  // 3) clic del candidato
  try {
    await bestLoc.scrollIntoViewIfNeeded().catch(()=>{});
    for (const clickTry of [
      () => bestLoc.click({ timeout: 1500 }),
      () => bestLoc.click({ timeout: 1500, force: true }),
      () => bestLoc.evaluate(el => el && el.click()),
      async () => {
        const box = await bestLoc.boundingBox();
        if (box) {
          await container.page().mouse.move(box.x + box.width/2, box.y + box.height/2);
          await container.page().mouse.down(); await container.page().mouse.up();
        } else {
          throw new Error("no-bbox");
        }
      },
    ]) { try { await clickTry(); return true; } catch {} }
  } catch {}
  return false;
}

/* ---------- flujo de selección ---------- */

async function selectCenterAndService(scope) {
  await expandAllAccordions(scope);
  await ensurePanelOpen(scope, /Centro|Centre/i);
  await ensurePanelOpen(scope, /Servicio|Servei/i);

  // CENTRO
  {
    const cont = panelContent(scope, /Centro|Centre/i);
    const ok =
      (await chooseBestOption(cont, CENTRO_TEXT)) ||
      (await scope.locator(`text=/${CENTRO_TEXT}/i`).first().click({ timeout: 1500 }).then(()=>true).catch(()=>false));
    if (!ok) throw new Error(`No se pudo clicar el centro "${CENTRO_TEXT}"`);
  }

  // SERVICIO (con dump de opciones)
  {
    const cont = panelContent(scope, /Servicio|Servei/i);
    try { fs.writeFileSync("service_panel.html", await cont.innerHTML()); } catch {}
    const ok =
      (await chooseBestOption(cont, SERVICIO_TEXT)) ||
      (await scope.locator(`text=/${SERVICIO_TEXT}/i`).first().click({ timeout: 1500 }).then(()=>true).catch(()=>false));
    if (!ok) throw new Error(`No se pudo clicar el servicio "${SERVICIO_TEXT}"`);
  }

  // Siguiente
  const nexts = [
    scope.getByRole?.("button", { name: /Siguiente|Següent/i }).first(),
    scope.locator('button:has-text("Siguiente")').first(),
    scope.locator('button:has-text("Següent")').first(),
    scope.locator('text=/Siguiente|Següent/i').first(),
  ].filter(Boolean);
  for (const n of nexts) {
    const v = await n.isVisible().catch(() => false);
    if (v) {
      for (const tryClick of [
        () => n.click({ timeout: 1500 }),
        () => n.click({ timeout: 1500, force: true }),
        () => n.evaluate(el => el && el.click()),
      ]) { try { await tryClick(); return; } catch {} }
    }
  }
  throw new Error('No se pudo pulsar "Siguiente"');
}

/* ---------- main ---------- */

async function run() {
  const browser = await chromium.launch({
    headless: HEADLESS.toLowerCase() === "true",
    channel: BROWSER_CHANNEL || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    recordVideo: { dir: VIDEOS_DIR },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();

  try {
    const ready = await tryDeepLink(page);
    if (!ready) throw new Error('No se cargó la pantalla "Centro y servicio"');

    await selectCenterAndService(page);

    await waitMaskGone(page, 5000);
    await page.screenshot({ path: "state.png", fullPage: true }).catch(() => {});
    console.log("Centro y servicio seleccionados correctamente.");
  } catch (e) {
    console.error("Error en la ejecución:", e);
  } finally {
    await context.tracing.stop({ path: path.join(TRACES_DIR, "trace.zip") }).catch(() => {});
    await context.close();
    await browser.close();
  }
}

run();
