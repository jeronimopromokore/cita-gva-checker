// check_cita_gva_playwright.js
// Deep-link + acordeones + selección robusta de SERVICIO (buscador, scroll virtual, click por bbox).

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
      await scope.waitForTimeout?.(250);
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
      // intenta abrir si no está expandido
      const expanded = await h.getAttribute("aria-expanded").catch(() => null);
      if (expanded !== "true") {
        for (const tryClick of [
          () => h.click({ timeout: 1200 }),
          () => h.click({ timeout: 1200, force: true }),
          () => h.evaluate(el => el && el.click()),
        ]) { try { await tryClick(); break; } catch {} }
        await scope.waitForTimeout(150);
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
          () => h.click({ timeout: 1200 }),
          () => h.click({ timeout: 1200, force: true }),
          () => h.evaluate(el => el && el.click()),
        ]) { try { await tryClick(); break; } catch {} }
        await scope.waitForTimeout(150);
      }
    } catch {}
  }
}

/* ---------- selección dentro del panel ---------- */

function panelContent(scope, titleRe) {
  // Encuentra el tab por título y luego su contenido asociado más cercano
  const tab = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link').filter({ hasText: titleRe }).first();
  const container = tab.locator('xpath=following::*[contains(@class,"p-accordion-content") or @role="region" or contains(@class,"p-panel-content")][1]');
  return container;
}

async function tryServiceSearch(container, text) {
  // Intenta escribir en inputs dentro del panel (PrimeNG: autocomplete / dropdown)
  const inputs = container.locator('input[role="combobox"], input[type="search"], input[type="text"], .p-inputtext input, .p-autocomplete input, .p-dropdown input').filter({ hasNot: container.locator('[type="hidden"]') });
  const k = await inputs.count();
  for (let i = 0; i < k; i++) {
    const inp = inputs.nth(i);
    try {
      await inp.scrollIntoViewIfNeeded().catch(()=>{});
      await inp.fill(""); await inp.type(text, { delay: 30 });
      await container.waitForTimeout(400);
      // Opciones emergentes habituales de PrimeNG
      const popupOptions = [
        container.getByRole("option", { name: new RegExp(text, "i") }),
        container.locator('.p-autocomplete-panel .p-autocomplete-items .p-autocomplete-item').filter({ hasText: new RegExp(text, "i") }),
        container.locator('.p-dropdown-items .p-dropdown-item').filter({ hasText: new RegExp(text, "i") }),
      ];
      for (const pop of popupOptions) {
        const vis = await pop.first().isVisible().catch(()=>false);
        if (vis) {
          for (const tryClick of [
            () => pop.first().click({ timeout: 1500 }),
            () => pop.first().click({ timeout: 1500, force: true }),
            () => pop.first().evaluate(el => el && el.click()),
          ]) { try { await tryClick(); return true; } catch {} }
        }
      }
    } catch {}
  }
  return false;
}

async function scrollAndClickOption(container, text) {
  // Busca elementos clicables por múltiples roles/selectores, con scroll incremental
  const re = new RegExp(text, "i");
  const MAX_STEPS = 30;
  for (let step = 0; step < MAX_STEPS; step++) {
    const candidates = [
      container.getByRole("option", { name: re }),
      container.getByRole("radio", { name: re }),
      container.locator('li, label, button, a, [role="menuitem"], [role="treeitem"]').filter({ hasText: re }),
      container.locator(`text=/${re.source}/${re.flags}`),
    ];
    for (const cand of candidates) {
      const el = cand.first();
      if (await el.isVisible().catch(()=>false)) {
        // 1) click normal / force
        for (const tryClick of [
          () => el.click({ timeout: 1500 }),
          () => el.click({ timeout: 1500, force: true }),
        ]) { try { await tryClick(); return true; } catch {} }
        // 2) click nativo por bbox si aún intercepta algo
        try {
          const box = await el.boundingBox();
          if (box) {
            await container.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await container.page().mouse.down(); await container.page().mouse.up();
            return true;
          }
        } catch {}
      }
    }
    // scroll del contenedor; si no se mueve, scroll global
    const scrolled = await container.evaluate((node) => {
      if (!node) return false;
      const el = node;
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + 350, el.scrollHeight);
      return el.scrollTop !== before;
    }).catch(()=>false);
    if (!scrolled) { await container.page().mouse.wheel(0, 600).catch(()=>{}); }
    await container.page().waitForTimeout(180);
  }
  return false;
}

async function selectCenterAndService(scope) {
  await expandAllAccordions(scope);
  await ensurePanelOpen(scope, /Centro|Centre/i);
  await ensurePanelOpen(scope, /Servicio|Servei/i);

  // CENTRO (similar al servicio, pero suele ser más sencillo)
  {
    const cont = panelContent(scope, /Centro|Centre/i);
    const ok =
      (await scrollAndClickOption(cont, CENTRO_TEXT)) ||
      (await scope.locator(`text=/${CENTRO_TEXT}/i`).first().click({ timeout: 1500 }).then(()=>true).catch(()=>false));
    if (!ok) throw new Error(`No se pudo clicar el centro "${CENTRO_TEXT}"`);
  }

  // SERVICIO: primero intenta buscador, luego scroll + múltiples selectores
  {
    const cont = panelContent(scope, /Servicio|Servei/i);
    // guarda HTML del panel para depuración si falla
    try { fs.writeFileSync("service_panel.html", await cont.innerHTML()); } catch {}
    const ok =
      (await tryServiceSearch(cont, SERVICIO_TEXT)) ||
      (await scrollAndClickOption(cont, SERVICIO_TEXT));
    if (!ok) throw new Error(`No se pudo clicar el servicio "${SERVICIO_TEXT}"`);
  }

  // Botón Siguiente
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
