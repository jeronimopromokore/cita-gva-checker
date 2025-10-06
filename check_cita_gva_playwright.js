// check_cita_gva_playwright.js
// Versión SPA + iframe: tras pulsar el CTA, la app carga dentro de un <iframe>.
// El script detecta ese iframe, espera a que termine el "loading-mask" y opera dentro.

import { chromium } from "playwright";
import fs from "fs";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "120000",
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 120000;

/* ---------------- utils ---------------- */

async function notifyTelegram(message, screenshotPath) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const api = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  try {
    await fetch(`${api}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true }),
    });
    if (screenshotPath) {
      const form = new FormData();
      form.set("chat_id", TELEGRAM_CHAT_ID);
      form.set("caption", "Estado actual");
      form.set("photo", new Blob([fs.readFileSync(screenshotPath)]), "captura.png");
      await fetch(`${api}/sendPhoto`, { method: "POST", body: form });
    }
  } catch (e) {
    console.error("Error enviando Telegram:", e);
  }
}

async function closeCookiesIfAny(scope) {
  try {
    const cands = [
      scope.getByRole?.("button", { name: /aceptar|acepto|consentir|aceptar todas/i }),
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

async function waitLoadingMaskGone(scope) {
  const mask = scope.locator?.(".loading-mask");
  if (mask) {
    const wasVisible = await mask.isVisible().catch(() => false);
    if (wasVisible) {
      await mask.waitFor({ state: "hidden", timeout }).catch(() => {});
    }
  }
  if (scope.waitForLoadState) {
    await scope.waitForLoadState("networkidle", { timeout }).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 800));
}

async function clickCTA(page) {
  const variants = [/Solicitar cita previa/i, /Cita previa/i];
  // main
  for (const re of variants) {
    const locs = [
      page.getByText(re).first(),
      page.locator(`text=/${re.source}/${re.flags}`).first(),
      page.locator('button:has-text("Solicitar cita previa")').first(),
      page.locator('a:has-text("Solicitar cita previa")').first(),
      page.locator('button:has-text("Cita previa")').first(),
      page.locator('a:has-text("Cita previa")').first(),
    ];
    for (const l of locs) {
      const v = await l.isVisible().catch(() => false);
      if (v) { await l.click({ timeout: 8000 }).catch(() => {}); return true; }
    }
  }
  // iframes
  for (const f of page.frames()) {
    await closeCookiesIfAny(f);
    for (const re of variants) {
      const locs = [
        f.getByText(re).first(),
        f.locator(`text=/${re.source}/${re.flags}`).first(),
        f.locator('button:has-text("Solicitar cita previa")').first(),
        f.locator('a:has-text("Solicitar cita previa")').first(),
      ];
      for (const l of locs) {
        const v = await l.isVisible().catch(() => false);
        if (v) { await l.click({ timeout: 8000 }).catch(() => {}); return true; }
      }
    }
  }
  return false;
}

// Espera a que aparezca un iframe "vivo" que contenga la app (con algún texto clave)
async function getAppFrame(page) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    // refresca listado de iframes
    const frames = page.frames();
    for (const f of frames) {
      try {
        // señales de que ya cargó algo de la app dentro del iframe
        const anyMarker = [
          f.locator?.('text=/Centro y servicio|Seleccione centro|Seleccione servicio|Siguiente|Següent/i').first(),
          f.locator?.('[role="combobox"]').first(),
          f.locator?.('select').first(),
        ].filter(Boolean);
        for (const m of anyMarker) {
          if (await m.isVisible().catch(() => false)) return f;
        }
        // si existe máscara, esperamos a que desaparezca y reintentamos
        await waitLoadingMaskGone(f);
      } catch { /* intentar siguiente frame */ }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function waitAppointmentMarkers(scope) {
  const probes = [
    /Centro y servicio/i, /Seleccione centro/i, /Seleccione servicio/i, /Siguiente/i,
    /Centre i servei/i, /Seleccione centre/i, /Seleccione servei/i, /Següent/i,
  ];
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    for (const re of probes) {
      const loc = scope.locator?.(`text=/${re.source}/${re.flags}`).first();
      if (loc && await loc.isVisible().catch(() => false)) return true;
    }
    await waitLoadingMaskGone(scope);
  }
  return false;
}

async function selectCenterAndService(scope) {
  // abrir acordeones si existen
  for (const title of [/^\s*Centro\s*$/i, /^\s*Servicio\s*$/i, /^\s*Centre\s*$/i, /^\s*Servei\s*$/i]) {
    const acc = scope.locator(`text=/${title.source}/${title.flags}`).first();
    if (await acc.isVisible().catch(() => false)) {
      await acc.click({ timeout: 3000 }).catch(() => {});
    }
  }
  const centro = scope.locator(`text=/${CENTRO_TEXT}/i`).first();
  await centro.scrollIntoViewIfNeeded().catch(() => {});
  await centro.click({ timeout });

  const servicio = scope.locator(`text=/${SERVICIO_TEXT}/i`).first();
  await servicio.scrollIntoViewIfNeeded().catch(() => {});
  await servicio.click({ timeout });

  const nexts = [
    scope.getByRole?.("button", { name: /Siguiente|Següent/i }).first(),
    scope.locator('button:has-text("Siguiente")').first(),
    scope.locator('button:has-text("Següent")').first(),
    scope.locator('text=/Siguiente|Següent/i').first(),
  ].filter(Boolean);
  for (const n of nexts) {
    const v = await n.isVisible().catch(() => false);
    if (v) { await n.click({ timeout }); return; }
  }
  throw new Error('No se pudo pulsar "Siguiente"');
}

async function checkAvailability(scope, page) {
  await waitLoadingMaskGone(scope);
  const noDays = await scope.locator('text=/No hay días disponibles|No hi ha dies disponibles/i').first().isVisible().catch(() => false);
  const noHours = await scope.locator('text=/No hay horas disponibles|No hi ha hores disponibles/i').first().isVisible().catch(() => false);
  if (!noDays || !noHours) return true;

  const clickableDays = scope.locator("button, [role='button']").filter({ hasText: /\b\d{1,2}\b/ });
  const count = await clickableDays.count();
  return count > 0;
}

/* ---------------- main ---------------- */

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // HOME
    await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
    await waitLoadingMaskGone(page);
    await closeCookiesIfAny(page);
    await page.waitForTimeout(800);

    // CTA
    const ctaOk = await clickCTA(page);
    if (!ctaOk) {
      await page.screenshot({ path: "home.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("home.html", await page.content());
      throw new Error('No se pudo clicar "Solicitar cita previa"');
    }

    // Esperar a que aparezca la app dentro de un iframe y que esté lista
    const appFrame = await getAppFrame(page);
    if (!appFrame) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("after_cta.html", await page.content());
      throw new Error("No se detectó el iframe de la aplicación tras el CTA");
    }
    await waitLoadingMaskGone(appFrame);
    const ready = await waitAppointmentMarkers(appFrame);
    if (!ready) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(() => {});
      // volcado del HTML del iframe
      try { fs.writeFileSync("after_cta_iframe.html", await appFrame.content()); } catch {}
      throw new Error('No se cargó la pantalla "Centro y servicio" dentro del iframe');
    }

    // Selección dentro del iframe
    await selectCenterAndService(appFrame);

    // Comprobar disponibilidad dentro del iframe
    const available = await checkAvailability(appFrame, page);

    await page.screenshot({ path: "state.png", fullPage: true }).catch(() => {});
    if (available) {
      const msg = `⚠️ POSIBLE DISPONIBILIDAD de cita\nCentro: ${CENTRO_TEXT}\nServicio: ${SERVICIO_TEXT}`;
      console.log(msg);
      await notifyTelegram(msg, "state.png");
    } else {
      console.log(`Sin disponibilidad de cita por ahora (Centro: ${CENTRO_TEXT} · Servicio: ${SERVICIO_TEXT}).`);
    }
  } catch (e) {
    console.error("Error en la ejecución:", e);
  } finally {
    await context.close();
    await browser.close();
  }
}

run();
