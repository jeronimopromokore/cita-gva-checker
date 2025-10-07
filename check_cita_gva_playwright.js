// check_cita_gva_playwright.js
// Deep-link + acordeones + selección de SERVICIO con REGEX/INDEX + volcados detallados.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const {
  GVA_BASE = "https://sige.gva.es/qsige/citaprevia.justicia",
  APPOINTMENT_UUID,
  APPOINTMENT_URL,
  CENTRO_TEXT,
  SERVICIO_TEXT,
  // NUEVO: overrides opcionales
  SERVICIO_REGEX,          // p.ej: "certificado\\s+de\\s+antecedentes"
  SERVICIO_INDEX,          // p.ej: "0" para la primera opción visible
  TIMEOUT_MS = "180000",
  HEADLESS = "false",
  BROWSER_CHANNEL = "chrome",
} = process.env;

if (!CENTRO_TEXT) {
  console.error("Falta la variable de entorno CENTRO_TEXT");
  process.exit(1);
}
if (!SERVICIO_TEXT && !SERVICIO_REGEX && (SERVICIO_INDEX === undefined)) {
  console.error("Debes definir al menos uno: SERVICIO_TEXT o SERVICIO_REGEX o SERVICIO_INDEX");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 180000;
const VIDEOS_DIR = path.resolve("videos");
const TRACES_DIR = path.resolve("traces");
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(TRACES_DIR, { recursive: true });

const norm = (s) =>
  (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function similarityScore(targetNorm, optionNorm) {
  const tks = targetNorm.split(/\s+/).filter(Boolean);
  let score = 0;
  if (optionNorm.includes(targetNorm)) score += 5;
  for (const tk of tks) if (tk.length > 2 && optionNorm.includes(tk)) score += 1;
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

/* ---------------- acordeones ---------------- */

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

/* ---------------- utilidades de selección ---------------- */

async function dumpOptions(locator, outPath) {
  try {
    const n = await locator.count();
    const out = [];
    for (let i = 0; i < n; i++) {
      const txt = await locator.nth(i).innerText().catch(() => "");
      if (txt && txt.trim()) out.push(norm(txt));
    }
    if (out.length) {
      fs.writeFileSync(outPath, out.join("\n"), "utf8");
      console.log(`→ Dump ${out.length} opciones en ${outPath}`);
    }
  } catch {}
}

function toRegexFromEnv() {
  if (!SERVICIO_REGEX) return null;
  try {
    return new RegExp(SERVICIO_REGEX, "i");
  } catch {
    console.warn("SERVICIO_REGEX inválido, se ignora.");
    return null;
  }
}

function targetRegexOrText() {
  const rx = toRegexFromEnv();
  if (rx) return rx;
  if (SERVICIO_TEXT) {
    const esc = SERVICIO_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(esc, "i");
  }
  return null;
}

function serviceIndexOrNull() {
  if (SERVICIO_INDEX === undefined || SERVICIO_INDEX === null) return null;
  const n = Number(SERVICIO_INDEX);
  return Number.isFinite(n) ? n : null;
}

async function selectFromGlobalOverlay(page, rxOrText) {
  const overlay = page.locator(
    '.p-dropdown-panel:visible, .p-autocomplete-panel:visible, .p-overlaypanel:visible, .p-select-overlay:visible'
  ).first();

  const visible = await overlay.isVisible().catch(()=>false);
  if (!visible) return false;

  // Guardar overlay para depurar
  try {
    fs.writeFileSync("overlay.html", await overlay.innerHTML());
    await page.screenshot({ path: "overlay.png", fullPage: true }).catch(()=>{});
  } catch {}

  // Dump opciones
  await dumpOptions(overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a'), "services_found.txt");

  const byIndex = serviceIndexOrNull();
  if (byIndex !== null) {
    const all = overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a');
    const count = await all.count();
    if (count > byIndex) {
      const el = all.nth(byIndex);
      for (const clickTry of [
        () => el.click({ timeout: 1500 }),
        () => el.click({ timeout: 1500, force: true }),
        () => el.evaluate(e => e && e.click()),
      ]) { try { await clickTry(); return true; } catch {} }
    }
    return false;
  }

  const rx = rxOrText instanceof RegExp ? rxOrText : new RegExp(rxOrText, "i");
  const candidate = overlay
    .getByRole("option", { name: rx }).first()
    .or(overlay.locator(`.p-dropdown-item:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`.p-autocomplete-item:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`li:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`label:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`button:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`a:has-text(/${rx.source}/${rx.flags})`).first());

  const vis = await candidate.isVisible().catch(()=>false);
  if (!vis) return false;

  for (const clickTry of [
    () => candidate.click({ timeout: 1500 }),
    () => candidate.click({ timeout: 1500, force: true }),
    () => candidate.evaluate(e => e && e.click()),
  ]) { try { await clickTry(); return true; } catch {} }

  return false;
}

async function selectFromContainer(container, page, rxOrText) {
  // Buscar triggers (dropdown/autocomplete/list/radio)
  const triggers = container.locator(
    '.p-dropdown, .p-autocomplete, .p-selectbutton, .p-listbox, .p-radiobutton, [role="combobox"], [role="listbox"]'
  );
  if (await triggers.count() > 0) {
    for (const pref of ['.p-dropdown', '.p-autocomplete', '[role="combobox"]', '.p-listbox']) {
      const t = triggers.locator(pref).first();
      if (await t.isVisible().catch(()=>false)) {
        const triggerBtn = t.locator('.p-dropdown-trigger, .p-autocomplete-dropdown, .p-dropdown-trigger-icon').first();
        const input = t.locator('input[type="text"], input[role="combobox"], .p-inputtext input, .p-dropdown-filter').first();
        if (await triggerBtn.isVisible().catch(()=>false)) {
          await triggerBtn.click({ timeout: 1500 }).catch(()=>{});
        } else if (await input.isVisible().catch(()=>false)) {
          await input.click({ timeout: 1500 }).catch(()=>{});
        } else {
          await t.click({ timeout: 1500 }).catch(()=>{});
        }
        await page.waitForTimeout(250);

        // Si hay input, filtra
        if (await input.isVisible().catch(()=>false) && typeof rxOrText === "string") {
          await input.fill("");
          await input.type(rxOrText, { delay: 25 });
          await page.waitForTimeout(350);
        }

        // Selección en overlay global
        const ok = await selectFromGlobalOverlay(page, rxOrText);
        if (ok) return true;
      }
    }
  }

  // Lista embebida: intenta por índice o texto
  const list = container.locator('[role="listbox"], .p-listbox, ul, .p-select-list, .p-radiobutton-group').first();
  const visible = await list.isVisible().catch(()=>false);
  if (visible) {
    await dumpOptions(list.locator('[role="option"], li, label, button, a'), "services_found.txt");

    const byIndex = serviceIndexOrNull();
    if (byIndex !== null) {
      const all = list.locator('[role="option"], li, label, button, a');
      const count = await all.count();
      if (count > byIndex) {
        const el = all.nth(byIndex);
        for (const clickTry of [
          () => el.click({ timeout: 1500 }),
          () => el.click({ timeout: 1500, force: true }),
          () => el.evaluate(e => e && e.click()),
        ]) { try { await clickTry(); return true; } catch {} }
      }
      return false;
    }

    const rx = rxOrText instanceof RegExp ? rxOrText : new RegExp(rxOrText, "i");
    const candidate = list
      .getByRole("option", { name: rx }).first()
      .or(list.locator(`li:has-text(/${rx.source}/${rx.flags})`).first())
      .or(list.locator(`label:has-text(/${rx.source}/${rx.flags})`).first())
      .or(list.locator(`button:has-text(/${rx.source}/${rx.flags})`).first())
      .or(list.locator(`a:has-text(/${rx.source}/${rx.flags})`).first());
    const vis2 = await candidate.isVisible().catch(()=>false);
    if (vis2) {
      for (const clickTry of [
        () => candidate.click({ timeout: 1500 }),
        () => candidate.click({ timeout: 1500, force: true }),
        () => candidate.evaluate(e => e && e.click()),
      ]) { try { await clickTry(); return true; } catch {} }
    }
  }

  // Último recurso: texto suelto en el contenedor
  const rx = rxOrText instanceof RegExp ? rxOrText : new RegExp(rxOrText, "i");
  const fallback = container.locator(`text=/${rx.source}/${rx.flags}`).first();
  if (await fallback.isVisible().catch(()=>false)) {
    for (const clickTry of [
      () => fallback.click({ timeout: 1500 }),
      () => fallback.click({ timeout: 1500, force: true }),
      () => fallback.evaluate(e => e && e.click()),
    ]) { try { await clickTry(); return true; } catch {} }
  }

  return false;
}

/* ---------------- flujo selección ---------------- */

async function selectCenterAndService(page) {
  await expandAllAccordions(page);
  await ensurePanelOpen(page, /Centro|Centre/i);
  await ensurePanelOpen(page, /Servicio|Servei/i);

  // CENTRO
  {
    const cont = panelContent(page, /Centro|Centre/i);
    const ok =
      (await selectFromContainer(cont, page, CENTRO_TEXT)) ||
      (await page.locator(`text=/${CENTRO_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/i`).first().click({ timeout: 1500 }).then(()=>true).catch(()=>false));
    if (!ok) throw new Error(`No se pudo clicar el centro "${CENTRO_TEXT}"`);
  }

  // SERVICIO (overlay-aware + regex/index)
  {
    const cont = panelContent(page, /Servicio|Servei/i);
    try { fs.writeFileSync("service_panel.html", await cont.innerHTML()); } catch {}
    const target = targetRegexOrText() ?? SERVICIO_TEXT ?? "";
    const ok =
      (await selectFromContainer(cont, page, target)) ||
      (await selectFromGlobalOverlay(page, target));
    if (!ok) throw new Error(`No se pudo clicar el servicio según SERVICIO_TEXT/SERVICIO_REGEX/SERVICIO_INDEX`);
  }

  // Siguiente
  for (const n of [
    page.getByRole("button", { name: /Siguiente|Següent/i }).first(),
    page.locator('button:has-text("Siguiente")').first(),
    page.locator('button:has-text("Següent")').first(),
    page.locator('text=/Siguiente|Següent/i').first(),
  ]) {
    const v = await n.isVisible().catch(() => false);
    if (v) {
      for (const clickTry of [
        () => n.click({ timeout: 1500 }),
        () => n.click({ timeout: 1500, force: true }),
        () => n.evaluate(e => e && e.click()),
      ]) { try { await clickTry(); return; } catch {} }
    }
  }
  throw new Error('No se pudo pulsar "Siguiente"');
}

/* ---------------- main ---------------- */

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
