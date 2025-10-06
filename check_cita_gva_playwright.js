// check_cita_gva_playwright.js
// Flujo robusto para una SPA donde la URL no cambia (como en el vídeo).
// 1) Carga la URL base
// 2) Clic por texto en "Solicitar cita previa"
// 3) Selecciona Centro y Servicio por texto
// 4) "Siguiente" y verifica disponibilidad
// 5) Telegram opcional con captura

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

// --- Utilidades --------------------------------------------------------------

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

async function closeCookiesIfAny(scope) {
  try {
    const candidates = [
      scope.locator('button:has-text("Aceptar")'),
      scope.locator('text=/Aceptar todas/i'),
      scope.getByRole?.("button", { name: /aceptar|acepto|consentir|aceptar todas/i }),
      scope.locator('text=/Acceptar totes/i'), // VA
    ].filter(Boolean);
    for (const c of candidates) {
      const v = await c.isVisible().catch(() => false);
      if (v) { await c.click({ timeout: 3000 }).catch(() => {}); break; }
    }
  } catch {}
}

async function clickByText(scope, regexp, clickTimeout = 5000) {
  const target = scope.locator(`text=${regexp}`).first();
  const visible = await target.isVisible().catch(() => false);
  if (visible) {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: clickTimeout }).catch(() => {});
    return true;
  }
  return false;
}

async function waitAnyText(scope, regexps, waitMs = 10000) {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    for (const re of regexps) {
      const loc = scope.locator(`text=${re}`).first();
      if (await loc.isVisible().catch(() => false)) return true;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// --- Lógica principal --------------------------------------------------------

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  let availabilityFound = false;

  try {
    // 1) Abrir SPA base
    await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
    await closeCookiesIfAny(page);

    // 2) Esperar el CTA por texto y hacer clic
    const ctaTexts = [/Solicitar cita previa/i, /Cita previa/i];
    const seenHome = await waitAnyText(page, ctaTexts, 20000);
    if (!seenHome) {
      await page.screenshot({ path: "home.png", fullPage: true }).catch(() => {});
      throw new Error('No aparece el texto "Solicitar cita previa" en el home');
    }

    let ctaClicked = false;
    // main
    for (const re of ctaTexts) {
      if (await clickByText(page, `/${re.source}/${re.flags}`, 7000)) { ctaClicked = true; break; }
    }
    // frames (por si el CTA está dentro de un iframe)
    if (!ctaClicked) {
      for (const f of page.frames()) {
        await closeCookiesIfAny(f);
        for (const re of ctaTexts) {
          if (await clickByText(f, `/${re.source}/${re.flags}`, 7000)) { ctaClicked = true; break; }
        }
        if (ctaClicked) break;
      }
    }
    if (!ctaClicked) {
      await page.screenshot({ path: "home.png", fullPage: true }).catch(() => {});
      throw new Error('No se pudo clicar "Solicitar cita previa"');
    }

    // 3) Esperar pantalla de "Centro y servicio" (texto genérico)
    const centreTexts = [
      /Centro y servicio/i,
      /Centro\s*$/i,
      /Servicio\s*$/i,
      /Seleccione centro/i,
      /Seleccione servicio/i,
      /Siguiente/i,
    ];
    const onCenter = await waitAnyText(page, centreTexts, 15000);
    if (!onCenter) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(() => {});
      throw new Error('No se cargó la pantalla "Centro y servicio"');
    }

    // Abrir acordeones si están colapsados (si existen)
    for (const re of [/^\s*Centro\s*$/i, /^\s*Servicio\s*$/i]) {
      const loc = page.locator(`text=/${re.source}/${re.flags}`).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 3000 }).catch(() => {}); // harmless si ya está abierto
      }
    }

    // Seleccionar centro y servicio por texto parcial
    const centro = page.locator(`text=/${CENTRO_TEXT}/i`).first();
    await centro.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
    await centro.click({ timeout });

    const servicio = page.locator(`text=/${SERVICIO_TEXT}/i`).first();
    await servicio.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
    await servicio.click({ timeout });

    // 4) Siguiente
    const nextOptions = [
      page.getByRole("button", { name: /Siguiente/i }),
      page.locator('button:has-text("Siguiente")').first(),
      page.locator('text=/Siguiente/i').first(),
    ];
    let nextClicked = false;
    for (const n of nextOptions) {
      const v = await n.isVisible().catch(() => false);
      if (v) { await n.click({ timeout }).catch(() => {}); nextClicked = true; break; }
    }
    if (!nextClicked) {
      await page.screenshot({ path: "center_service.png", fullPage: true }).catch(() => {});
      throw new Error('No se pudo pulsar "Siguiente"');
    }

    // 5) Verificar disponibilidad (SPA: esperar render)
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
    await page.waitForTimeout(1500);

    const noDaysLoc = page.locator('text=/No hay días disponibles/i').first();
    const noHoursLoc = page.locator('text=/No hay horas disponibles/i').first();
    const noDays = await noDaysLoc.isVisible().catch(() => false);
    const noHours = await noHoursLoc.isVisible().catch(() => false);

    if (!noDays || !noHours) {
      availabilityFound = true;
    } else {
      // heurística: ¿aparecen botones con dígitos (días)?
      const clickableDays = page.locator("button, [role='button']").filter({ hasText: /\b\d{1,2}\b/ });
      const count = await clickableDays.count();
      if (count > 0) availabilityFound = true;
    }

    const shot = "state.png";
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

    if (availabilityFound) {
      const msg = `⚠️ POSIBLE DISPONIBILIDAD de cita\nCentro: ${CENTRO_TEXT}\nServicio: ${SERVICIO_TEXT}`;
      console.log(msg);
      await notifyTelegram(msg, shot);
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
