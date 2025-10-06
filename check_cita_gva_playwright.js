// check_cita_gva_playwright.js
// Versión SPA robusta sin interpolaciones problemáticas.
// Flujo:
// 1) Carga la URL base
// 2) Cierra cookies si aparecen
// 3) Clic en "Solicitar cita previa" (main + iframes) usando SOLO selectores por texto/regex
// 4) Espera pantalla "Centro y servicio"
// 5) Selecciona Centro y Servicio por texto
// 6) Pulsa "Siguiente" y comprueba disponibilidad
// 7) Capturas/HTML de depuración si falla (el workflow ya sube artefactos)

import { chromium } from "playwright";
import fs from "fs";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "90000",
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 90000;

// ---------------- Utilidades ----------------

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
      scope.getByRole?.("button", { name: /aceptar|acepto|consentir|aceptar todas/i }),
      scope.locator('button:has-text("Aceptar")'),
      scope.locator('text=/Aceptar todas/i'),
      scope.locator('text=/Acceptar totes/i'), // VA
    ].filter(Boolean);
    for (const c of candidates) {
      const v = await c.first().isVisible().catch(() => false);
      if (v) { await c.first().click({ timeout: 3000 }).catch(() => {}); break; }
    }
  } catch {}
}

async function waitAnyText(scope, regexps, waitMs = 15000) {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    for (const re of regexps) {
      const loc = scope.locator(`text=/${re.source}/${re.flags}`).first();
      if (await loc.isVisible().catch(() => false)) return true;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function clickCTA(page) {
  const variants = [/Solicitar cita previa/i, /Cita previa/i];

  // 1) En documento principal (varias formas)
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
      if (v) {
        await l.scrollIntoViewIfNeeded().catch(() => {});
        await l.click({ timeout: 6000 }).catch(() => {});
        return true;
      }
    }
  }

  // 2) Si no, intentar en iframes
  for (const frame of page.frames()) {
    await closeCookiesIfAny(frame);
    for (const re of variants) {
      const locs = [
        frame.getByText(re).first(),
        frame.locator(`text=/${re.source}/${re.flags}`).first(),
        frame.locator('button:has-text("Solicitar cita previa")').first(),
        frame.locator('a:has-text("Solicitar cita previa")').first(),
        frame.locator('button:has-text("Cita previa")').first(),
        frame.locator('a:has-text("Cita previa")').first(),
      ];
      for (const l of locs) {
        const v = await l.isVisible().catch(() => false);
        if (v) {
          await l.scrollIntoViewIfNeeded().catch(() => {});
          await l.click({ timeout: 6000 }).catch(() => {});
          return true;
        }
      }
    }
  }
  return false;
}

async function waitForAppointmentScreen(page) {
  // Señales típicas de la pantalla de selección
  const probes = [
    /Centro y servicio/i,
    /Seleccione centro/i,
    /Seleccione servicio/i,
    /Centro\s*$/i,
    /Servicio\s*$/i,
    /Siguiente/i,
    /Centre i servei/i,
    /Seleccione centre/i,
    /Seleccione servei/i,
    /Següent/i,
  ];
  return waitAnyText(page, probes, 25000);
}

async function selectCenterAndService(page) {
  // Abrir acordeones si existen
  for (const title of [/^\s*Centro\s*$/i, /^\s*Servicio\s*$/i, /^\s*Centre\s*$/i, /^\s*Servei\s*$/i]) {
    const acc = page.locator(`text=/${title.source}/${title.flags}`).first();
    if (await acc.isVisible().catch(() => false)) {
      await acc.click({ timeout: 3000 }).catch(() => {});
    }
  }

  // Selección por texto (case-insensitive, no exacto)
  const centro = page.locator(`text=/${CENTRO_TEXT}/i`).first();
  await centro.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await centro.click({ timeout });

  const servicio = page.locator(`text=/${SERVICIO_TEXT}/i`).first();
  await servicio.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await servicio.click({ timeout });

  // Botón "Siguiente" (ES/VA)
  const nexts = [
    page.getByRole("button", { name: /Siguiente|Següent/i }).first(),
    page.locator('button:has-text("Siguiente")').first(),
    page.locator('button:has-text("Següent")').first(),
    page.locator('text=/Siguiente|Següent/i').first(),
  ];
  for (const n of nexts) {
    const v = await n.isVisible().catch(() => false);
    if (v) { await n.click({ timeout }); return; }
  }
  throw new Error('No se pudo pulsar "Siguiente"');
}

async function checkAvailability(page) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(1500);
  const noDays = await page.locator('text=/No hay días disponibles|No hi ha dies disponibles/i').first().isVisible().catch(() => false);
  const noHours = await page.locator('text=/No hay horas disponibles|No hi ha hores disponibles/i').first().isVisible().catch(() => false);
  if (!noDays || !noHours) return true;

  const clickableDays = page.locator("button, [role='button']").filter({ hasText: /\b\d{1,2}\b/ });
  const count = await clickableDays.count();
  return count > 0;
}

// ---------------- Main ----------------

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
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
    await closeCookiesIfAny(page);
    await page.waitForTimeout(1200);

    // 2) Clic CTA
    const ctaOk = await clickCTA(page);
    if (!ctaOk) {
      await page.screenshot({ path: "home.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("home.html", await page.content());
      throw new Error('No se pudo clicar "Solicitar cita previa"');
    }

    // 3) Esperar "Centro y servicio"
    const appointmentOk = await waitForAppointmentScreen(page);
    if (!appointmentOk) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("after_cta.html", await page.content());
      throw new Error('No se cargó la pantalla "Centro y servicio"');
    }

    // 4) Selección y Siguiente
    await selectCenterAndService(page);

    // 5) Disponibilidad
    const available = await checkAvailability(page);
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
