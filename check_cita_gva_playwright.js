// check_cita_gva_playwright.js
// Versión SPA robusta + depuración (capturas y HTML).
// Estrategia:
//  - Carga URL base
//  - Clic por texto en "Solicitar cita previa" (main + iframes)
//  - Espera múltiples "marcadores" de la pantalla de selección (Centro/Servicio/combobox/botón Siguiente)
//  - Selecciona Centro y Servicio por texto
//  - Pulsa Siguiente y comprueba disponibilidad
//  - Siempre genera capturas y, si falla, guarda HTML para depurar

import { chromium } from "playwright";
import fs from "fs";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "90000", // subimos timeout
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 90000;

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
    const candidates = [
      scope.locator('button:has-text("Aceptar")'),
      scope.locator('text=/Aceptar todas/i'),
      scope.locator('text=/Acceptar totes/i'),
      scope.getByRole?.("button", { name: /aceptar|acepto|consentir|aceptar todas/i }),
    ].filter(Boolean);
    for (const c of candidates) {
      const v = await c.isVisible().catch(() => false);
      if (v) { await c.click({ timeout: 3000 }).catch(() => {}); break; }
    }
  } catch {}
}

async function clickCTA(page) {
  const ctaRegexes = [/Solicitar cita previa/i, /Cita previa/i];
  // 1) main
  for (const re of ctaRegexes) {
    const locs = [
      page.getByRole("button", { name: re }),
      page.locator(`button:has-text("${re.source ? re.source.replace(/\\//g,"") : re}")`).first(),
      page.locator(`a:has-text("${re.source ? re.source.replace(/\\//g,"") : re}")`).first(),
      page.locator(`text=/${re.source}/${re.flags}`).first(),
    ];
    for (const l of locs) {
      const v = await l.isVisible().catch(() => false);
      if (v) { await l.click({ timeout: 6000 }).catch(()=>{}); return true; }
    }
  }
  // 2) iframes
  for (const frame of page.frames()) {
    await closeCookiesIfAny(frame);
    for (const re of ctaRegexes) {
      const locs = [
        frame.getByRole("button", { name: re }),
        frame.locator(`button:has-text("${re.source ? re.source.replace(/\\//g,"") : re}")`).first(),
        frame.locator(`a:has-text("${re.source ? re.source.replace(/\\//g,"") : re}")`).first(),
        frame.locator(`text=/${re.source}/${re.flags}`).first(),
      ];
      for (const l of locs) {
        const v = await l.isVisible().catch(() => false);
        if (v) { await l.click({ timeout: 6000 }).catch(()=>{}); return true; }
      }
    }
  }
  return false;
}

async function waitForAppointmentScreen(page) {
  // Espera cualquiera de estos marcadores de UI típicos de “Centro y servicio”
  const probes = [
    'text=/Centro y servicio/i',
    'text=/Seleccione centro/i',
    'text=/Seleccione servicio/i',
    'text=/Centro\\s*$/i',
    'text=/Servicio\\s*$/i',
    'button:has-text("Siguiente")',
    '[role="combobox"]',
    'select',
    // variantes valenciano
    'text=/Centre i servei/i',
    'text=/Seleccione centre/i',
    'text=/Seleccione servei/i',
    'button:has-text("Següent")',
  ];
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    for (const p of probes) {
      const loc = page.locator(p).first();
      if (await loc.isVisible().catch(()=>false)) return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function selectCenterAndService(page) {
  // Intenta abrir acordeones si existen
  for (const title of [/^\s*Centro\s*$/i, /^\s*Servicio\s*$/i, /^\s*Centre\s*$/i, /^\s*Servei\s*$/i]) {
    const acc = page.locator(`text=/${title.source}/${title.flags}`).first();
    if (await acc.isVisible().catch(()=>false)) { await acc.click({ timeout: 3000 }).catch(()=>{}); }
  }

  // Selección por texto (no exacto, case-insensitive)
  const centro = page.locator(`text=/${CENTRO_TEXT}/i`).first();
  await centro.scrollIntoViewIfNeeded({ timeout }).catch(()=>{});
  await centro.click({ timeout });

  const servicio = page.locator(`text=/${SERVICIO_TEXT}/i`).first();
  await servicio.scrollIntoViewIfNeeded({ timeout }).catch(()=>{});
  await servicio.click({ timeout });

  // Botón "Siguiente" (ES/VA)
  const nexts = [
    page.getByRole("button", { name: /Siguiente|Següent/i }).first(),
    page.locator('button:has-text("Siguiente")').first(),
    page.locator('button:has-text("Següent")').first(),
    page.locator('text=/Siguiente|Següent/i').first(),
  ];
  for (const n of nexts) {
    const v = await n.isVisible().catch(()=>false);
    if (v) { await n.click({ timeout }); return; }
  }
  throw new Error('No se pudo pulsar "Siguiente"');
}

async function checkAvailability(page) {
  await page.waitForLoadState("networkidle", { timeout }).catch(()=>{});
  await page.waitForTimeout(1500);
  const noDays = await page.locator('text=/No hay días disponibles|No hi ha dies disponibles/i').first().isVisible().catch(()=>false);
  const noHours = await page.locator('text=/No hay horas disponibles|No hi ha hores disponibles/i').first().isVisible().catch(()=>false);
  if (!noDays || !noHours) return true;

  const clickableDays = page.locator("button, [role='button']").filter({ hasText: /\b\d{1,2}\b/ });
  const count = await clickableDays.count();
  return count > 0;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // 1) Home
    await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout }).catch(()=>{});
    await closeCookiesIfAny(page);
    await page.waitForTimeout(1200);

    // 2) Clic CTA
    const ctaOk = await clickCTA(page);
    if (!ctaOk) {
      await page.screenshot({ path: "home.png", fullPage: true }).catch(()=>{});
      fs.writeFileSync("home.html", await page.content());
      throw new Error('No se pudo clicar "Solicitar cita previa"');
    }

    // 3) Esperar pantalla "Centro y servicio"
    const appointmentOk = await waitForAppointmentScreen(page);
    if (!appointmentOk) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(()=>{});
      fs.writeFileSync("after_cta.html", await page.content());
      throw new Error('No se cargó la pantalla "Centro y servicio"');
    }

    // 4) Selección y Siguiente
    await selectCenterAndService(page);

    // 5) Disponibilidad
    const available = await checkAvailability(page);
    await page.screenshot({ path: "state.png", fullPage: true }).catch(()=>{});

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
