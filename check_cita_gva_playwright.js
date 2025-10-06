// check_cita_gva_playwright.js
// Automatiza la búsqueda de cita en la web de la Generalitat Valenciana.
// Funciona en GitHub Actions y en local con Node.js + Playwright.

import { chromium } from "playwright";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "60000",
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 60000;

async function notifyTelegram(message, screenshotPath) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const api = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

  try {
    await fetch(`${api}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    if (screenshotPath) {
      const fs = await import("fs");
      const form = new FormData();
      form.set("chat_id", TELEGRAM_CHAT_ID);
      form.set("caption", "Captura del estado actual");
      form.set("photo", new Blob([fs.readFileSync(screenshotPath)]), "captura.png");
      await fetch(`${api}/sendPhoto`, { method: "POST", body: form });
    }
  } catch (e) {
    console.error("Error enviando Telegram:", e);
  }
}

async function ensureClosedCookies(page) {
  try {
    const candidates = [
      page.getByRole("button", { name: /aceptar|acepto|consentir|aceptar todas/i }),
      page.locator('button:has-text("Aceptar")').first(),
      page.locator('text=/Aceptar todas/i').first(),
    ];
    for (const c of candidates) {
      const visible = await c.isVisible().catch(() => false);
      if (visible) { await c.click({ timeout: 3000 }).catch(() => {}); break; }
    }
  } catch { /* no-op */ }
}

async function goDirectToAppointment(page) {
  // Fuerza entrada directa a la pantalla de "Centro y servicio"
  const base = GVA_URL.includes("#/")
    ? GVA_URL.split("#/")[0]
    : GVA_URL.replace(/#.*$/, "");
  // idioma ES por defecto; probamos ES y VA por si acaso
  const targets = [
    `${base}#/es/appointment`,
    `${base}#/va/appointment`,
    `${base}#/appointment`,
  ];
  for (const url of targets) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout });
      // Señal de estar en la pantalla correcta
      const centroHeader = page.locator('text=/Centro y servicio|Centro\\s*$|Servicio\\s*$/i').first();
      await centroHeader.waitFor({ timeout: 5000 });
      return true;
    } catch {
      // probar siguiente variante
    }
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  let availabilityFound = false;

  try {
    // 1) Intento directo a "appointment"
    await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
    await ensureClosedCookies(page);
    let onAppointment = await goDirectToAppointment(page);

    // 2) Si lo anterior falla, intentamos el CTA del home como respaldo
    if (!onAppointment) {
      try {
        await ensureClosedCookies(page);
        await page.waitForTimeout(1500);
        const homeReady = page.locator('text=/Cita previa|Sistema de gestión de citas previas/i').first();
        await homeReady.waitFor({ timeout: 8000 });

        let clicked = false;
        const targets = [
          page.getByRole("button", { name: /Solicitar cita previa/i }),
          page.locator('a:has-text("Solicitar cita previa")').first(),
          page.locator('button:has-text("Solicitar cita previa")').first(),
          page.locator('text=/Solicitar cita previa/i').first(),
        ];
        for (const t of targets) {
          const visible = await t.isVisible().catch(() => false);
          if (visible) {
            await t.scrollIntoViewIfNeeded().catch(() => {});
            await t.click({ timeout: 5000 }).catch(() => {});
            clicked = true;
            break;
          }
        }
        if (!clicked) throw new Error('No se encontró el botón "Solicitar cita previa"');

        await page.waitForLoadState("networkidle", { timeout });
        const centroHeader = page.locator('text=/Centro y servicio|Centro\\s*$|Servicio\\s*$/i').first();
        await centroHeader.waitFor({ timeout: 10000 });
        onAppointment = true;
      } catch (e) {
        await page.screenshot({ path: "home.png", fullPage: true }).catch(() => {});
        throw e;
      }
    }

    // 3) Seleccionar Centro (asegurando acordeón abierto)
    const centroAccordion = page.locator('text=/^\\s*Centro\\s*$/i').first();
    if (await centroAccordion.isVisible().catch(() => false)) {
      await centroAccordion.click({ timeout: 3000 }).catch(() => {}); // por si está colapsado
    }
    const centroLocator = page.getByText(CENTRO_TEXT, { exact: false });
    await centroLocator.scrollIntoViewIfNeeded({ timeout });
    await centroLocator.click({ timeout });

    // 4) Seleccionar Servicio (asegurando acordeón abierto)
    const servicioAccordion = page.locator('text=/^\\s*Servicio\\s*$/i').first();
    if (await servicioAccordion.isVisible().catch(() => false)) {
      await servicioAccordion.click({ timeout: 3000 }).catch(() => {}); // por si está colapsado
    }
    const servicioLocator = page.getByText(SERVICIO_TEXT, { exact: false });
    await servicioLocator.scrollIntoViewIfNeeded({ timeout });
    await servicioLocator.click({ timeout });

    // 5) Siguiente
    const nextBtn = page.getByRole("button", { name: /Siguiente/i }).first();
    await nextBtn.click({ timeout });

    // 6) Comprobar disponibilidad
    await page.waitForLoadState("networkidle", { timeout });

    const noDays = await page.getByText(/No hay días disponibles/i).first();
    const noHours = await page.getByText(/No hay horas disponibles/i).first();

    const noDaysVisible = await noDays.isVisible().catch(() => false);
    const noHoursVisible = await noHours.isVisible().catch(() => false);

    if (!noDaysVisible || !noHoursVisible) {
      availabilityFound = true;
    } else {
      const clickableDays = page
        .locator("button, [role='button']")
        .filter({ hasText: /\d{1,2}/ });
      const count = await clickableDays.count();
      if (count > 0) availabilityFound = true;
    }

    const screenshot = "state.png";
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});

    if (availabilityFound) {
      const msg = `⚠️ POSIBLE DISPONIBILIDAD de cita\nCentro: ${CENTRO_TEXT}\nServicio: ${SERVICIO_TEXT}\nURL: ${page.url()}`;
      console.log(msg);
      await notifyTelegram(msg, screenshot);
    } else {
      const msg = `Sin disponibilidad de cita por ahora (Centro: ${CENTRO_TEXT} · Servicio: ${SERVICIO_TEXT}).`;
      console.log(msg);
    }
  } catch (e) {
    console.error("Error en la ejecución:", e);
  } finally {
    await context.close();
    await browser.close();
  }
}

run();
