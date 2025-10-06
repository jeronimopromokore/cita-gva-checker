// check_cita_gva_playwright.js
// Chrome real + perfil persistente (reutiliza cookies/estado) + vídeo + traza + reintentos.

import { chromium, webkit } from "playwright";
import fs from "fs";
import path from "path";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "180000",
  HEADLESS = "false",
  BROWSER_CHANNEL = "chrome"
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 180000;

// Carpeta de perfil persistente (queda en el workspace del runner local)
const PROFILE_DIR = path.resolve("chrome-profile"); // se conserva entre runs
const VIDEOS_DIR = path.resolve("videos");
const TRACES_DIR = path.resolve("traces");
fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(TRACES_DIR, { recursive: true });

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
      await new Promise(r => setTimeout(r, 600));
      return true;
    }
    await new Promise(r => setTimeout(r, 350));
  }
  return false;
}

async function humanNudge(page) {
  try {
    await page.mouse.move(200, 200);
    await page.mouse.wheel(0, 600);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } catch {}
}

async function clickCTA(scope) {
  const candidates = [
    scope.getByText(/Solicitar cita previa/i).first(),
    scope.locator('button:has-text("Solicitar cita previa")').first(),
    scope.locator('a:has-text("Solicitar cita previa")').first(),
    scope.getByText(/Cita previa/i).first(),
    scope.locator('button:has-text("Cita previa")').first(),
    scope.locator('a:has-text("Cita previa")').first(),
  ];
  for (let pass = 0; pass < 2; pass++) {
    for (const l of candidates) {
      const v = await l.isVisible().catch(() => false);
      if (v) {
        await l.scrollIntoViewIfNeeded().catch(()=>{});
        await l.click({ timeout: 8000 }).catch(()=>{});
        await humanNudge(scope.page || scope);
        return true;
      }
    }
    await humanNudge(scope.page || scope);
  }
  return false;
}

async function waitAppointmentScreen(scope, totalWaitMs = 90000) {
  const end = Date.now() + totalWaitMs;
  const uiProbes = [
    /Centro y servicio/i, /Seleccione centro/i, /Seleccione servicio/i,
    /Siguiente|Següent/i, /Centre i servei/i, /Seleccione centre|servei/i
  ];
  while (Date.now() < end) {
    const gone = await waitMaskGone(scope, 5000);
    for (const re of uiProbes) {
      const loc = scope.locator(`text=/${re.source}/${re.flags}`).first();
      if (await loc.isVisible().catch(() => false)) return true;
    }
    const ok = await scope.waitForResponse(
      (res) => {
        const u = res.url();
        return /cita|appointment|slot|centro|servicio|agenda|disponible/i.test(u) && res.status() < 500;
      },
      { timeout: 2500 }
    ).then(()=>true).catch(()=>false);
    if (ok) return true;
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

async function launchPersistentChrome() {
  try {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS.toLowerCase() === "true" ? true : false,
      channel: BROWSER_CHANNEL || "chrome",
      viewport: null,                 // ventana “real”
      recordVideo: { dir: VIDEOS_DIR },
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    // Stealth básico
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    return context;
  } catch (e) {
    console.error("Fallo lanzando Chrome persistente, probando WebKit fallback:", e?.message || e);
    // Fallback a WebKit (por si Chrome falla)
    const wk = await webkit.launch({ headless: HEADLESS.toLowerCase() === "true" });
    const context = await wk.newContext({
      viewport: { width: 1366, height: 900 },
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      recordVideo: { dir: VIDEOS_DIR },
    });
    return context;
  }
}

/* ---------------- main ---------------- */

async function run() {
  const context = await launchPersistentChrome();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();

  page.on("requestfailed", (req) =>
    console.log("[req-failed]", req.method(), req.url(), req.failure()?.errorText)
  );

  try {
    let attempt = 0, ready = false;

    while (attempt < 3 && !ready) {
      attempt++;
      console.log(`== Intento ${attempt} ==`);

      await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
      await waitMaskGone(page, 20000);
      await closeCookiesIfAny(page);

      const cta1 = await clickCTA(page);
      if (!cta1) {
        await page.screenshot({ path: `home_${attempt}.png`, fullPage: true }).catch(() => {});
        fs.writeFileSync(`home_${attempt}.html`, await page.content());
        continue;
      }

      ready = await waitAppointmentScreen(page, 90000);

      if (!ready) {
        await page.screenshot({ path: `after_cta_${attempt}.png`, fullPage: true }).catch(() => {});
        fs.writeFileSync(`after_cta_${attempt}.html`, await page.content());
        // “soft refresh” para SPAs: volver a home y reentrar con estado mantenido por perfil
        try {
          await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
          await waitMaskGone(page, 15000);
          await closeCookiesIfAny(page);
          await clickCTA(page);
          ready = await waitAppointmentScreen(page, 40000);
        } catch {}
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
    await context.tracing.stop({ path: path.join(TRACES_DIR, "trace.zip") }).catch(() => {});
    await context.close();
  }
}

run();
