// check_cita_gva_playwright.js
// Deep-link + acordeones robustos + múltiples estrategias de click.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const {
  GVA_BASE = "https://sige.gva.es/qsige/citaprevia.justicia",
  APPOINTMENT_UUID,
  APPOINTMENT_URL,
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
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

/* ---------------- utilidades ---------------- */

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
      await scope.waitForTimeout?.(300);
      return true;
    }
    await scope.waitForTimeout?.(250);
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
    if (!gone) await scope.waitForTimeout?.(300);
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

async function expandAllAccordions(scope) {
  // Abre TODOS los acordeones visibles (PrimeNG p-accordion)
  const headers = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link');
  const count = await headers.count();
  console.log(`→ Detectados ${count} acordeones`);
  for (let i = 0; i < count; i++) {
    const h = headers.nth(i);
    try {
      await h.scrollIntoViewIfNeeded().catch(() => {});
      // varios intentos de apertura
      let opened = false;
      for (const tryClick of [
        () => h.click({ timeout: 1500 }),
        () => h.click({ timeout: 1500, force: true }),
        () => h.evaluate(node => (node as HTMLElement).click()),
      ]) {
        try { await tryClick(); opened = true; break; } catch {}
      }
      if (opened) await scope.waitForTimeout(200);
    } catch {}
  }
}

async function ensurePanelOpen(scope, panelTitleRegex) {
  // Abre específicamente el panel cuyo header contenga "Centro" o "Servicio"
  const headers = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link')
    .filter({ hasText: panelTitleRegex });
  const count = await headers.count();
  for (let i = 0; i < count; i++) {
    const h = headers.nth(i);
    try {
      await h.scrollIntoViewIfNeeded().catch(() => {});
      // si está aria-expanded="true" lo dejamos
      const expanded = await h.getAttribute("aria-expanded").catch(() => null);
      if (expanded !== "true") {
        for (const tryClick of [
          () => h.click({ timeout: 1500 }),
          () => h.click({ timeout: 1500, force: true }),
          () => h.evaluate(node => (node as HTMLElement).click()),
        ]) {
          try { await tryClick(); break; } catch {}
        }
        await scope.waitForTimeout(250);
      }
    } catch {}
  }
}

async function robustClickText(scope, textRegex) {
  const t = scope.locator(`text=/${textRegex.source}/${textRegex.flags}`).first();
  await t.scrollIntoViewIfNeeded().catch(() => {});
  // 3 estrategias en cascada
  for (const tryClick of [
    () => t.click({ timeout: 4000 }),
    () => t.click({ timeout: 4000, force: true }),
    () => t.evaluate(node => (node as HTMLElement).click()),
  ]) {
    try { await tryClick(); return true; } catch {}
    await scope.waitForTimeout?.(150);
  }
  return false;
}

async function selectCenterAndService(scope) {
  // 1) abre todos y luego asegura paneles clave abiertos
  await expandAllAccordions(scope);
  await ensurePanelOpen(scope, /Centro|Centre/i);
  await ensurePanelOpen(scope, /Servicio|Servei/i);

  // 2) click centro + servicio con estrategia robusta
  const centroOK = await robustClickText(scope, new RegExp(CENTRO_TEXT, "i"));
  if (!centroOK) throw new Error(`No se pudo clicar el centro "${CENTRO_TEXT}"`);

  const servOK = await robustClickText(scope, new RegExp(SERVICIO_TEXT, "i"));
  if (!servOK) throw new Error(`No se pudo clicar el servicio "${SERVICIO_TEXT}"`);

  // 3) botón Siguiente
  const nexts = [
    scope.getByRole?.("button", { name: /Siguiente|Següent/i }).first(),
    scope.locator('button:has-text("Siguiente")').first(),
    scope.locator('button:has-text("Següent")').first(),
    scope.locator('text=/Siguiente|Següent/i').first(),
  ].filter(Boolean);
  let clickedNext = false;
  for (const n of nexts) {
    try {
      const v = await n.isVisible().catch(() => false);
      if (v) {
        for (const tryClick of [
          () => n.click({ timeout: 2000 }),
          () => n.click({ timeout: 2000, force: true }),
          () => n.evaluate(node => (node as HTMLElement).click()),
        ]) {
          try { await tryClick(); clickedNext = true; break; } catch {}
        }
      }
      if (clickedNext) break;
    } catch {}
  }
  if (!clickedNext) throw new Error('No se pudo pulsar "Siguiente"');
}

async function checkAvailability(scope) {
  await waitMaskGone(scope, 20000);
  const noDays  = await scope.locator('text=/No hay días disponibles|No hi ha dies disponibles/i').first().isVisible().catch(() => false);
  const noHours = await scope.locator('text=/No hay horas disponibles|No hi ha hores disponibles/i').first().isVisible().catch(() => false);
  if (!noDays || !noHours) return true;
  const clickableDays = scope.locator("button, [role='button']").filter({ hasText: /\b\d{1,2}\b/ });
  return (await clickableDays.count()) > 0;
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

    const available = await checkAvailability(page);
    await page.screenshot({ path: "state.png", fullPage: true }).catch(() => {});
    if (available) {
      console.log(`⚠️ POSIBLE DISPONIBILIDAD de cita\nCentro: ${CENTRO_TEXT}\nServicio: ${SERVICIO_TEXT}`);
    } else {
      console.log(`Sin disponibilidad de cita por ahora (Centro: ${CENTRO_TEXT} · Servicio: ${SERVICIO_TEXT}).`);
    }
  } catch (e) {
    console.error("Error en la ejecución:", e);
  } finally {
    await context.tracing.stop({ path: path.join(TRACES_DIR, "trace.zip") }).catch(() => {});
    await context.close();
    await browser.close();
  }
}

run();
