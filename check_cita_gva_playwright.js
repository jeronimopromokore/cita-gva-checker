// check_cita_gva_playwright.js
// Deep-link + acordeones + scroll virtual + click nativo en ancestro clicable.

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

/* ---------- helpers genéricos ---------- */

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

/* ---------- acordeones y selección robusta ---------- */

async function expandAllAccordions(scope) {
  const headers = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link');
  const count = await headers.count();
  console.log(`→ Detectados ${count} acordeones`);
  for (let i = 0; i < count; i++) {
    const h = headers.nth(i);
    try {
      await h.scrollIntoViewIfNeeded().catch(() => {});
      let opened = false;
      for (const tryClick of [
        () => h.click({ timeout: 1200 }),
        () => h.click({ timeout: 1200, force: true }),
        () => h.evaluate(el => el && el.click()),
      ]) {
        try { await tryClick(); opened = true; break; } catch {}
      }
      if (opened) await scope.waitForTimeout(150);
    } catch {}
  }
}

async function ensurePanelOpen(scope, panelTitleRegex) {
  const headers = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link')
    .filter({ hasText: panelTitleRegex });
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
        await scope.waitForTimeout(200);
      }
    } catch {}
  }
}

/**
 * Busca el elemento por texto (regex), hace scroll dentro del panel de contenido
 * y hace click sobre el mejor ancestro clicable (button/a/label/li/[role=option]...).
 */
async function findAndClickOption(scope, panelRegex, optionRegex) {
  // 1) ubica el panel de contenido asociado (región debajo del header)
  const panelRegion = scope.locator(
    '.p-accordion-content, [role="region"], .p-panel-content'
  ).filter({ has: scope.locator(`text=/${panelRegex.source}/${panelRegex.flags}`) }).first();

  // si no encuentra por “has:”, cae al primer content visible
  const container = (await panelRegion.isVisible().catch(()=>false))
    ? panelRegion
    : scope.locator('.p-accordion-content:visible, [role="region"]:visible, .p-panel-content:visible').first();

  // 2) scroll incremental para encontrar el texto dentro del contenedor
  const MAX_STEPS = 20;
  for (let step = 0; step < MAX_STEPS; step++) {
    // Localizador del texto dentro del contenedor
    const textNode = container.locator(`text=/${optionRegex.source}/${optionRegex.flags}`).first();
    if (await textNode.isVisible().catch(()=>false)) {
      // 3) intenta click directo y ancestros clicables
      const candidates = [
        textNode,
        textNode.locator('xpath=ancestor-or-self::*[self::button or self::a or self::label or self::li or @role="option" or @role="radio" or @role="menuitem"][1]')
      ];
      for (const cand of candidates) {
        try {
          await cand.scrollIntoViewIfNeeded().catch(()=>{});
          for (const tryClick of [
            () => cand.click({ timeout: 2000 }),
            () => cand.click({ timeout: 2000, force: true }),
            () => cand.evaluate(el => {
              if (!el) return;
              const r = el.getBoundingClientRect();
              const x = r.left + r.width/2, y = r.top + r.height/2;
              const evt = (type) => el.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window, clientX:x, clientY:y}));
              evt('mouseover'); evt('mousedown'); evt('mouseup'); evt('click');
            }),
          ]) {
            try { await tryClick(); return true; } catch {}
          }
        } catch {}
      }
    }

    // 4) si no es visible aún, hace scroll del contenedor
    try {
      const scrolled = await container.evaluate((el) => {
        if (!el) return false;
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + 300, el.scrollHeight);
        return el.scrollTop !== before;
      }).catch(()=>false);
      if (!scrolled) {
        // si no se puede scrollear más, prueba a scrollear la página
        await scope.mouse.wheel(0, 500).catch(()=>{});
      }
    } catch {}
    await scope.waitForTimeout?.(200);
  }
  return false;
}

async function selectCenterAndService(scope) {
  await expandAllAccordions(scope);
  await ensurePanelOpen(scope, /Centro|Centre/i);
  await ensurePanelOpen(scope, /Servicio|Servei/i);

  // CENTRO
  const centroOK =
    (await findAndClickOption(scope, /Centro|Centre/i, new RegExp(CENTRO_TEXT, "i"))) ||
    (await scope.locator(`text=/${CENTRO_TEXT}/i`).first().click({ timeout: 2000 }).then(()=>true).catch(()=>false));
  if (!centroOK) throw new Error(`No se pudo clicar el centro "${CENTRO_TEXT}"`);

  // SERVICIO
  const servOK =
    (await findAndClickOption(scope, /Servicio|Servei/i, new RegExp(SERVICIO_TEXT, "i"))) ||
    (await scope.locator(`text=/${SERVICIO_TEXT}/i`).first().click({ timeout: 2000 }).then(()=>true).catch(()=>false));
  if (!servOK) throw new Error(`No se pudo clicar el servicio "${SERVICIO_TEXT}"`);

  // Siguiente
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
          () => n.click({ timeout: 1500 }),
          () => n.click({ timeout: 1500, force: true }),
          () => n.evaluate(el => el && el.click()),
        ]) { try { await tryClick(); clickedNext = true; break; } catch {} }
      }
      if (clickedNext) break;
    } catch {}
  }
  if (!clickedNext) throw new Error('No se pudo pulsar "Siguiente"');
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

    // Espera breve por transición de pantalla siguiente (calendario)
    await waitMaskGone(page, 5000);

    // Aquí puedes añadir el chequeo de disponibilidad si quieres continuar.
    console.log("Centro y servicio seleccionados correctamente.");
    await page.screenshot({ path: "state.png", fullPage: true }).catch(() => {});
  } catch (e) {
    console.error("Error en la ejecución:", e);
  } finally {
    await context.tracing.stop({ path: path.join(TRACES_DIR, "trace.zip") }).catch(() => {});
    await context.close();
    await browser.close();
  }
}

run();
