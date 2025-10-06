// check_cita_gva_playwright.js
// SPA sin iframe: maneja loading-mask persistente y reintenta tocando "home".

import { chromium } from "playwright";
import fs from "fs";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "150000", // 150s por si el backend tarda
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 150000;

/* ---------- util ---------- */

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
  } catch (e) { console.error("Error enviando Telegram:", e); }
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

async function waitMaskGone(page, maxMs = 40000) {
  const end = Date.now() + maxMs;
  const mask = page.locator(".loading-mask");
  while (Date.now() < end) {
    const vis = await mask.isVisible().catch(() => false);
    if (!vis) {
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function clickCTA(page) {
  const locs = [
    page.getByText(/Solicitar cita previa/i).first(),
    page.locator('button:has-text("Solicitar cita previa")').first(),
    page.locator('a:has-text("Solicitar cita previa")').first(),
    page.getByText(/Cita previa/i).first(),
    page.locator('button:has-text("Cita previa")').first(),
    page.locator('a:has-text("Cita previa")').first(),
  ];
  for (const l of locs) {
    const v = await l.isVisible().catch(() => false);
    if (v) { await l.click({ timeout: 8000 }).catch(() => {}); return true; }
  }
  return false;
}

async function goHomeAndRetry(page) {
  const home = page.locator(".home").first(); // header: “Cita Previa de Registros Civiles”
  const v = await home.isVisible().catch(() => false);
  if (v) {
    await home.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

async function waitAppointmentScreen(page, totalWaitMs = 60000) {
  const probes = [
    /Centro y servicio/i, /Seleccione centro/i, /Seleccione servicio/i,
    /Siguiente|Següent/i, /Centre i servei/i, /Seleccione centre|servei/i
  ];
  const end = Date.now() + totalWaitMs;
  while (Date.now() < end) {
    // 1) si hay máscara, espera a que se vaya
    const gone = await waitMaskGone(page, 5000);
    // 2) busca marcadores
    for (const re of probes) {
      const loc = page.locator(`text=/${re.source}/${re.flags}`).first();
      if (await loc.isVisible().catch(() => false)) return true;
    }
    // 3) si la máscara no se va en varios ciclos, toca “home” y reintenta
    if (!gone) {
      await goHomeAndRetry(page);
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function selectCenterAndService(page) {
  // acordeones opcionales
  for (const title of [/^\s*Centro\s*$/i, /^\s*Servicio\s*$/i, /^\s*Centre\s*$/i, /^\s*Servei\s*$/i]) {
    const acc = page.locator(`text=/${title.source}/${title.flags}`).first();
    if (await acc.isVisible().catch(() => false)) {
      await acc.click({ timeout: 3000 }).catch(() => {});
    }
  }
  const centro = page.locator(`text=/${CENTRO_TEXT}/i`).first();
  await centro.scrollIntoViewIfNeeded().catch(() => {});
  await centro.click({ timeout });

  const servicio = page.locator(`text=/${SERVICIO_TEXT}/i`).first();
  await servicio.scrollIntoViewIfNeeded().catch(() => {});
  await servicio.click({ timeout });

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
  await waitMaskGone(page, 20000);
  const noDays = await page.locator('text=/No hay días disponibles|No hi ha dies disponibles/i').first().isVisible().catch(() => false);
  const noHours = await page.locator('text=/No hay horas disponibles|No hi ha hores disponibles/i').first().isVisible().catch(() => false);
  if (!noDays || !noHours) return true;
  const clickableDays = page.locator("button, [role='button']").filter({ hasText: /\b\d{1,2}\b/ });
  return (await clickableDays.count()) > 0;
}

/* ---------- main ---------- */

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Logs de depuración (quedan en el output del job)
  page.on("console", (msg) => console.log("[console]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("requestfailed", (req) => console.log("[req-failed]", req.method(), req.url(), req.failure()?.errorText));

  try {
    // HOME
    await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
    await waitMaskGone(page, 15000);
    await closeCookiesIfAny(page);
    await page.waitForTimeout(800);

    // CTA
    const ctaOk = await clickCTA(page);
    if (!ctaOk) {
      await page.screenshot({ path: "home.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("home.html", await page.content());
      throw new Error('No se pudo clicar "Solicitar cita previa"');
    }

    // Pantalla Centro/Servicio (con reintentos: máscara + home)
    const ready = await waitAppointmentScreen(page, 90000);
    if (!ready) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("after_cta.html", await page.content());
      throw new Error('No se cargó la pantalla "Centro y servicio"');
    }

    // Seleccionar y continuar
    await selectCenterAndService(page);

    // Disponibilidad
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
