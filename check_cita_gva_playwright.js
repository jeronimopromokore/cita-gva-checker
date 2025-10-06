// check_cita_gva_playwright.js
// Versión SPA con WebKit (Safari) para evitar bloqueos de render en CI.

import { webkit } from "playwright";
import fs from "fs";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "180000",
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 180000;

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

async function forceSpanish(scope) {
  const esBtn = scope.locator('text=/^\\s*ES\\s*$/').first();
  const visible = await esBtn.isVisible().catch(() => false);
  if (visible) { await esBtn.click({ timeout: 4000 }).catch(() => {}); await scope.waitForTimeout(500); }
}

async function waitMaskGone(scope, maxMs = 45000) {
  const end = Date.now() + maxMs;
  const masks = [
    scope.locator(".loading-mask"),
    scope.locator('[aria-busy="true"]'),
    scope.locator('.v-progress-circular, .spinner, .loading'),
  ];
  while (Date.now() < end) {
    let anyVisible = false;
    for (const m of masks) {
      const vis = await m.first().isVisible().catch(() => false);
      if (vis) { anyVisible = true; break; }
    }
    if (!anyVisible) {
      if (scope.waitForLoadState) {
        await scope.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 700));
      return true;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function clickCTA(scope) {
  const locs = [
    scope.getByText(/Solicitar cita previa/i).first(),
    scope.locator('button:has-text("Solicitar cita previa")').first(),
    scope.locator('a:has-text("Solicitar cita previa")').first(),
    scope.getByText(/Cita previa/i).first(),
    scope.locator('button:has-text("Cita previa")').first(),
    scope.locator('a:has-text("Cita previa")').first(),
  ];
  for (const l of locs) {
    const v = await l.isVisible().catch(() => false);
    if (v) { await l.scrollIntoViewIfNeeded().catch(()=>{}); await l.click({ timeout: 10000 }).catch(() => {}); return true; }
  }
  return false;
}

async function pressHome(scope) {
  const home = scope.locator(".home").first();
  const v = await home.isVisible().catch(() => false);
  if (v) { await home.click({ timeout: 5000 }).catch(() => {}); await scope.waitForTimeout(800); return true; }
  return false;
}

async function waitAppointmentScreen(scope, totalWaitMs = 80000) {
  const probes = [
    /Centro y servicio/i, /Seleccione centro/i, /Seleccione servicio/i,
    /Siguiente|Següent/i, /Centre i servei/i, /Seleccione centre|servei/i,
  ];
  const end = Date.now() + totalWaitMs;
  while (Date.now() < end) {
    const gone = await waitMaskGone(scope, 5000);
    for (const re of probes) {
      const loc = scope.locator(`text=/${re.source}/${re.flags}`).first();
      if (await loc.isVisible().catch(() => false)) return true;
    }
    if (!gone) await scope.waitForTimeout(600);
  }
  return false;
}

async function selectCenterAndService(scope) {
  for (const title of [/^\s*Centro\s*$/i, /^\s*Servicio\s*$/i, /^\s*Centre\s*$/i, /^\s*Servei\s*$/i]) {
    const acc = scope.locator(`text=/${title.source}/${title.flags}`).first();
    if (await acc.isVisible().catch(() => false)) { await acc.click({ timeout: 3000 }).catch(() => {}); }
  }
  const centro = scope.locator(`text=/${CENTRO_TEXT}/i`).first();
  await centro.scrollIntoViewIfNeeded().catch(() => {}); await centro.click({ timeout });

  const servicio = scope.locator(`text=/${SERVICIO_TEXT}/i`).first();
  await servicio.scrollIntoViewIfNeeded().catch(() => {}); await servicio.click({ timeout });

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

async function checkAvailability(scope) {
  await waitMaskGone(scope, 25000);
  const noDays = await scope.locator('text=/No hay días disponibles|No hi ha dies disponibles/i').first().isVisible().catch(() => false);
  const noHours = await scope.locator('text=/No hay horas disponibles|No hi ha hores disponibles/i').first().isVisible().catch(() => false);
  if (!noDays || !noHours) return true;
  const clickableDays = scope.locator("button, [role='button']").filter({ hasText: /\b\d{1,2}\b/ });
  return (await clickableDays.count()) > 0;
}

async function run() {
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
  });
  const page = await context.newPage();

  // logs de red/errores a consola del job
  page.on("console", (msg) => console.log("[console]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("requestfailed", (req) => console.log("[req-failed]", req.method(), req.url(), req.failure()?.errorText));

  try {
    let attempt = 0, ready = false;
    while (attempt < 3 && !ready) {
      attempt++;
      console.log(`== Intento ${attempt} ==`);

      await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
      await waitMaskGone(page, 20000);
      await closeCookiesIfAny(page);
      await forceSpanish(page);

      const ctaOk = await clickCTA(page);
      if (!ctaOk) {
        await page.screenshot({ path: `home_${attempt}.png`, fullPage: true }).catch(() => {});
        fs.writeFileSync(`home_${attempt}.html`, await page.content());
        await pressHome(page);
        continue;
      }

      ready = await waitAppointmentScreen(page, 90000);
      if (!ready) {
        await page.screenshot({ path: `after_cta_${attempt}.png`, fullPage: true }).catch(() => {});
        fs.writeFileSync(`after_cta_${attempt}.html`, await page.content());
        await pressHome(page);
      }
    }

    if (!ready) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("after_cta.html", await page.content());
      throw new Error('No se cargó la pantalla "Centro y servicio"');
    }

    await selectCenterAndService(page);

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
