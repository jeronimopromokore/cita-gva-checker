// check_cita_gva_playwright.js
// Uso local:
//   1) npm install
//   2) npx playwright install --with-deps chromium
//   3) Configure .env (copiar .env.example) y ejecute: npm run check
//
// Variables de entorno requeridas: CENTRO_TEXT, SERVICIO_TEXT
// Opcionales: GVA_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TIMEOUT_MS

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
    // Enviar texto
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

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  let availabilityFound = false;

  try {
    // 1) Home
    await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout });

    // 2) Click "Solicitar cita previa"
    await page.getByRole("button", { name: /Solicitar cita previa/i }).click({ timeout });

    // 3) Seleccionar centro
    await page.waitForLoadState("networkidle", { timeout });
    const centroLocator = page.getByText(CENTRO_TEXT, { exact: false });
    await centroLocator.scrollIntoViewIfNeeded({ timeout });
    await centroLocator.click({ timeout });

    // 4) Seleccionar servicio
    await page.waitForLoadState("networkidle", { timeout });
    const servicioLocator = page.getByText(SERVICIO_TEXT, { exact: false });
    await servicioLocator.scrollIntoViewIfNeeded({ timeout });
    await servicioLocator.click({ timeout });

    // 5) Siguiente
    await page.waitForLoadState("networkidle", { timeout });
    const nextBtn = page.getByRole("button", { name: /Siguiente/i });
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
      const clickableDays = page.locator("button, [role='button']").filter({ hasText: /\d{1,2}/ });
      const count = await clickableDays.count();
      if (count > 0) availabilityFound = true;
    }

    const screenshot = "state.png";
    await page.screenshot({ path: screenshot, fullPage: true });

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
