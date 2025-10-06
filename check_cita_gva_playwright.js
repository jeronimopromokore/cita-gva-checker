// check_cita_gva_playwright.js
// SPA robusto con espera de máscara de carga (.loading-mask)

import { chromium } from "playwright";
import fs from "fs";

const {
  GVA_URL = "https://sige.gva.es/qsige/citaprevia.justicia/#/es/home",
  CENTRO_TEXT,
  SERVICIO_TEXT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TIMEOUT_MS = "120000", // 120s para entornos lentos
} = process.env;

if (!CENTRO_TEXT || !SERVICIO_TEXT) {
  console.error("Faltan variables de entorno: CENTRO_TEXT y/o SERVICIO_TEXT");
  process.exit(1);
}

const timeout = Number(TIMEOUT_MS) || 120000;

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
      scope.locator('button:has-text("Aceptar")'),
      scope.locator('text=/Aceptar todas/i'),
      scope.locator('text=/Acceptar totes/i'),
    ].filter(Boolean);
    for (const c of cands) {
      const v = await c.first().isVisible().catch(() => false);
      if (v) { await c.first().click({ timeout: 3000 }).catch(() => {}); break; }
    }
  } catch {}
}

async function waitLoadingMaskGone(page, label = "mask") {
  // Si aparece la máscara de carga, espera a que desaparezca
  const mask = page.locator(".loading-mask");
  const wasVisible = await mask.isVisible().catch(() => false);
  if (wasVisible) {
    await mask.waitFor({ state: "hidden", timeout }).catch(() => {});
  }
  // Seguridad extra tras “networkidle”
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(800); // pequeño respiro para render
}

async function clickCTA(page) {
  const variants = [/Solicitar cita previa/i, /Cita previa/i];

  // 1) Documento principal
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
        await l.click({ timeout: 8000 }).catch(() => {});
        return true;
      }
    }
  }

  // 2) Iframes (por si el CTA está dentro)
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
          await l.click({ timeout: 8000 }).catch(() => {});
          return true;
        }
      }
    }
  }
  return false;
}

async function waitForAppointmentScreen(page) {
  // Espera a que termine la carga
  await waitLoadingMaskGone(page, "after-cta");

  // Señales de “Centro y servicio” o equivalentes
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
    /Buscar centro/i, // por si hay campo de búsqueda
  ];

  const end = Date.now() + 30000;
  while (Date.now() < end) {
    for (const re of probes) {
      const loc = page.locator(`text=/${re.source}/${re.flags}`).first();
      if (await loc.isVisible().catch(() => false)) return true;
    }
    // Un intento extra: a veces la vista tarda en “hidratar”
    await page.waitForTimeout(300);
    await waitLoadingMaskGone(page, "loop");
  }
  return false;
}

async function selectCenterAndService(page) {
  // Abre acordeones si existen
  for (const title of [/^\s*Centro\s*$/i, /^\s*Servicio\s*$/i, /^\s*Centre\s*$/i, /^\s*Servei\s*$/i]) {
    const acc = page.locator(`text=/${title.source}/${title.flags}`).first();
    if (await acc.isVisible().catch(() => false)) {
      await acc.click({ timeout: 3000 }).catch(() => {});
    }
  }

  const centro = page.locator(`text=/${CENTRO_TEXT}/i`).first();
  await centro.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await centro.click({ timeout });

  const servicio = page.locator(`text=/${SERVICIO_TEXT}/i`).first();
  await servicio.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await servicio.click({ timeout });

  // “Siguiente” (ES/VA)
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
  await waitLoadingMaskGone(page, "after-next");
  const noDays = await page.locator('text=/No hay días disponibles|No hi ha dies disponibles/i').first().isVisible().catch(() => false);
  const noHours = await page.locator('text=/No hay horas disponibles|No hi ha hores disponibles/i').first().isVisible().catch(() => false);
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
    // HOME
    await page.goto(GVA_URL, { waitUntil: "domcontentloaded", timeout });
    await waitLoadingMaskGone(page, "home");
    await closeCookiesIfAny(page);
    await page.waitForTimeout(800);

    // CTA
    const ctaOk = await clickCTA(page);
    if (!ctaOk) {
      await page.screenshot({ path: "home.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("home.html", await page.content());
      throw new Error('No se pudo clicar "Solicitar cita previa"');
    }

    // CENTRO/SERVICIO
    const appointmentOk = await waitForAppointmentScreen(page);
    if (!appointmentOk) {
      await page.screenshot({ path: "after_cta.png", fullPage: true }).catch(() => {});
      fs.writeFileSync("after_cta.html", await page.content());
      throw new Error('No se cargó la pantalla "Centro y servicio"');
    }

    // Selección + Siguiente
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
