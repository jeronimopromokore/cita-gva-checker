// check_cita_gva_playwright.js
// Deep-link + acordeones + selección robusta para CENTRO y SERVICIO
// (texto, REGEX o índice), compatible con overlays PrimeNG y listas con scroll.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const {
  GVA_BASE = "https://sige.gva.es/qsige/citaprevia.justicia",
  APPOINTMENT_UUID,
  APPOINTMENT_URL,

  // ---- Centro
  CENTRO_TEXT,            // p.ej. "VALENCIA - Ciudad de la Justicia"
  CENTRO_REGEX,           // p.ej. "valen.*justicia"
  CENTRO_INDEX,           // p.ej. "0" (primera opción visible)

  // ---- Servicio
  SERVICIO_TEXT,
  SERVICIO_REGEX,
  SERVICIO_INDEX,

  TIMEOUT_MS = "180000",
  HEADLESS = "false",
  BROWSER_CHANNEL = "chrome",
} = process.env;

const timeout = Number(TIMEOUT_MS) || 180000;
const VIDEOS_DIR = path.resolve("videos");
const TRACES_DIR = path.resolve("traces");
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(TRACES_DIR, { recursive: true });

/* ---------------- utils ---------------- */

function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }

const norm = (s) =>
  (s || "").toString()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

async function waitMaskGone(scope, maxMs = 45000) {
  const end = Date.now() + maxMs;
  const masks = [
    scope.locator(".loading-mask"),
    scope.locator('[aria-busy="true"]'),
    scope.locator(".v-progress-circular, .spinner, .loading"),
  ];
  while (Date.now() < end) {
    let anyVisible = false;
    for (const m of masks) {
      if (await m.first().isVisible().catch(() => false)) { anyVisible = true; break; }
    }
    if (!anyVisible) {
      await scope.waitForLoadState?.("networkidle", { timeout: 8000 }).catch(() => {});
      await scope.waitForTimeout?.(200);
      return true;
    }
    await scope.waitForTimeout?.(200);
  }
  return false;
}

async function closeCookiesIfAny(scope) {
  for (const loc of [
    scope.getByRole?.("button",{name:/acept(ar|o)|consentir|aceptar todas/i}).first(),
    scope.locator?.('button:has-text("Aceptar")').first(),
    scope.locator?.('text=/Aceptar todas/i').first(),
    scope.locator?.('text=/Acceptar totes/i').first(),
  ].filter(Boolean)) {
    if (await loc.isVisible().catch(()=>false)) { await loc.click({timeout:1500}).catch(()=>{}); break; }
  }
}

async function onAppointmentScreen(scope, totalWaitMs = 60000) {
  const end = Date.now() + totalWaitMs;
  const probes = [/Centro y servicio/i,/Seleccione centro/i,/Seleccione servicio/i,/Siguiente|Següent/i,/Centre i servei/i];
  while (Date.now() < end) {
    await waitMaskGone(scope, 1500);
    for (const re of probes) {
      const el = scope.locator(`text=/${re.source}/${re.flags}`).first();
      if (await el.isVisible().catch(()=>false)) return true;
    }
    await scope.waitForTimeout(250);
  }
  return false;
}

async function tryDeepLink(page) {
  const url = APPOINTMENT_URL
    ? APPOINTMENT_URL
    : (APPOINTMENT_UUID ? `${GVA_BASE}/#/es/appointment?uuid=${APPOINTMENT_UUID}` : null);
  if (!url) return false;
  console.log("→ Intentando deep-link:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await closeCookiesIfAny(page);
  const ok = await onAppointmentScreen(page, 90000);
  if (!ok) {
    fs.writeFileSync("after_deeplink.html", await page.content());
    await page.screenshot({path:"after_deeplink.png", fullPage:true}).catch(()=>{});
  }
  return ok;
}

/* ---------------- acordeones ---------------- */

async function expandAllAccordions(scope) {
  const headers = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link');
  const n = await headers.count();
  console.log(`→ Detectados ${n} acordeones`);
  for (let i=0;i<n;i++){
    const h = headers.nth(i);
    const expanded = await h.getAttribute("aria-expanded").catch(()=>null);
    if (expanded !== "true") {
      for (const f of [()=>h.click({timeout:800}), ()=>h.click({timeout:800,force:true}), ()=>h.evaluate(el=>el&&el.click())]) {
        try { await f(); break; } catch {}
      }
      await scope.waitForTimeout(120);
    }
  }
}

async function ensurePanelOpen(scope, titleRe) {
  const h = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link').filter({hasText:titleRe}).first();
  const expanded = await h.getAttribute("aria-expanded").catch(()=>null);
  if (expanded !== "true") {
    for (const f of [()=>h.click({timeout:800}), ()=>h.click({timeout:800,force:true}), ()=>h.evaluate(el=>el&&el.click())]) {
      try { await f(); break; } catch {}
    }
    await scope.waitForTimeout(120);
  }
}

function panelContent(scope, titleRe) {
  const tab = scope.locator('a[role="tab"], .p-accordion-header, .p-accordion-header-link').filter({ hasText: titleRe }).first();
  return tab.locator('xpath=following::*[contains(@class,"p-accordion-content") or @role="region" or contains(@class,"p-panel-content")][1]');
}

/* ---------------- selección/overlay ---------------- */

function idxFromEnv(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function rxFromEnv(raw) {
  if (!raw) return null;
  try { return new RegExp(raw, "i"); } catch { console.warn("Regex inválida:", raw); return null; }
}

async function dumpOptions(locator, outPath) {
  try {
    const n = await locator.count();
    const out = [];
    for (let i=0;i<n;i++){
      const t = await locator.nth(i).innerText().catch(()=> "");
      if (t && t.trim()) out.push(norm(t));
    }
    if (out.length) { fs.writeFileSync(outPath, out.join("\n"), "utf8"); console.log(`→ Dump ${out.length} opciones en ${outPath}`); }
  } catch {}
}

async function openControl(container, page) {
  const trigger = container.locator(
    '.p-dropdown, .p-autocomplete, [role="combobox"], .p-listbox'
  ).first();
  const input = container.locator('input[type="text"], input[role="combobox"], .p-dropdown-filter, .p-inputtext input').first();

  if (await trigger.isVisible().catch(()=>false)) {
    const btn = trigger.locator('.p-dropdown-trigger, .p-autocomplete-dropdown, .p-dropdown-trigger-icon').first();
    if (await btn.isVisible().catch(()=>false)) {
      await btn.click({timeout:1200}).catch(()=>{});
    } else {
      await trigger.click({timeout:1200}).catch(()=>{});
    }
    await page.waitForTimeout(200);
  } else if (await input.isVisible().catch(()=>false)) {
    await input.click({timeout:1200}).catch(()=>{});
  }
  return {trigger, input};
}

async function selectFromGlobalOverlay(page, rxOrText, indexOrNull) {
  const overlay = page.locator('.p-dropdown-panel:visible, .p-autocomplete-panel:visible, .p-overlaypanel:visible, .p-select-overlay:visible').first();
  if (!(await overlay.isVisible().catch(()=>false))) return false;

  // dumps
  try { fs.writeFileSync("overlay.html", await overlay.innerHTML()); await page.screenshot({path:"overlay.png", fullPage:true}).catch(()=>{}); } catch {}
  await dumpOptions(overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a'), "options_overlay.txt");

  // por índice
  if (indexOrNull !== null) {
    const all = overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a');
    const count = await all.count();
    if (count > indexOrNull) {
      const el = all.nth(indexOrNull);
      for (const f of [()=>el.click({timeout:1200}), ()=>el.click({timeout:1200,force:true}), ()=>el.evaluate(e=>e&&e.click())]) {
        try { await f(); return true; } catch {}
      }
    }
    return false;
  }

  // por regex/texto
  if (!rxOrText) return false;
  const rx = rxOrText instanceof RegExp ? rxOrText : new RegExp(escRe(rxOrText), "i");
  const cand = overlay
    .getByRole("option",{name:rx}).first()
    .or(overlay.locator(`.p-dropdown-item:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`.p-autocomplete-item:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`li:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`label:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`button:has-text(/${rx.source}/${rx.flags})`).first())
    .or(overlay.locator(`a:has-text(/${rx.source}/${rx.flags})`).first());

  if (await cand.isVisible().catch(()=>false)) {
    for (const f of [()=>cand.click({timeout:1200}), ()=>cand.click({timeout:1200,force:true}), ()=>cand.evaluate(e=>e&&e.click())]) {
      try { await f(); return true; } catch {}
    }
  }

  // scroll y reintento
  for (let step=0; step<20; step++){
    const sc = await overlay.evaluate(node=>{
      const el = node; if (!el) return false;
      const before = el.scrollTop; el.scrollTop = Math.min(el.scrollTop + 400, el.scrollHeight);
      return el.scrollTop !== before;
    }).catch(()=>false);
    if (!sc) break;
    if (await cand.isVisible().catch(()=>false)) {
      for (const f of [()=>cand.click({timeout:1200}), ()=>cand.click({timeout:1200,force:true}), ()=>cand.evaluate(e=>e&&e.click())]) {
        try { await f(); return true; } catch {}
      }
    }
  }
  return false;
}

async function selectFromContainer(container, page, rxOrText, indexOrNull) {
  // intentar overlay vía trigger
  const {trigger, input} = await openControl(container, page);
  await page.waitForTimeout(200);

  // si hay input y tenemos texto, filtra
  if (await input.isVisible().catch(()=>false) && typeof rxOrText === "string" && rxOrText) {
    await input.fill(""); await input.type(rxOrText, {delay:25});
    await page.waitForTimeout(300);
  }

  // overlay si aparece
  const okOverlay = await selectFromGlobalOverlay(page, rxOrText, indexOrNull);
  if (okOverlay) return true;

  // lista embebida con scroll
  const list = container.locator('[role="listbox"], .p-listbox, ul, .p-select-list, .p-radiobutton-group').first();
  if (await list.isVisible().catch(()=>false)) {
    await dumpOptions(list.locator('[role="option"], li, label, button, a'), "options_list.txt");

    // por índice
    if (indexOrNull !== null) {
      const all = list.locator('[role="option"], li, label, button, a');
      if ((await all.count()) > indexOrNull) {
        const el = all.nth(indexOrNull);
        for (const f of [()=>el.click({timeout:1200}), ()=>el.click({timeout:1200,force:true}), ()=>el.evaluate(e=>e&&e.click())]) {
          try { await f(); return true; } catch {}
        }
      }
      return false;
    }

    // por regex/texto
    if (rxOrText) {
      const rx = rxOrText instanceof RegExp ? rxOrText : new RegExp(escRe(rxOrText), "i");
      const cand = list
        .getByRole("option",{name:rx}).first()
        .or(list.locator(`li:has-text(/${rx.source}/${rx.flags})`).first())
        .or(list.locator(`label:has-text(/${rx.source}/${rx.flags})`).first())
        .or(list.locator(`button:has-text(/${rx.source}/${rx.flags})`).first())
        .or(list.locator(`a:has-text(/${rx.source}/${rx.flags})`).first());
      if (await cand.isVisible().catch(()=>false)) {
        for (const f of [()=>cand.click({timeout:1200}), ()=>cand.click({timeout:1200,force:true}), ()=>cand.evaluate(e=>e&&e.click())]) {
          try { await f(); return true; } catch {}
        }
      }
    }
  }

  // último recurso: primer elemento visible
  const any = container.locator('[role="option"], li, label, button, a').first();
  if (await any.isVisible().catch(()=>false)) {
    for (const f of [()=>any.click({timeout:1200}), ()=>any.click({timeout:1200,force:true}), ()=>any.evaluate(e=>e&&e.click())]) {
      try { await f(); return true; } catch {}
    }
  }
  return false;
}

/* ---------------- flujo selección ---------------- */

async function selectByFlow(page, titleRe, outPrefix, textValue, regexValue, indexValue) {
  const cont = panelContent(page, titleRe);
  try { fs.writeFileSync(`${outPrefix}_panel.html`, await cont.innerHTML()); } catch {}
  const rx = rxFromEnv(regexValue);
  const idx = idxFromEnv(indexValue);
  const target = rx ?? (textValue || "");

  // 1) intenta overlay/list por target
  let ok = await selectFromContainer(cont, page, target, idx);
  if (ok) return true;

  // 2) si falla todo, intenta teclado (↓, Enter)
  const {input, trigger} = await openControl(cont, page);
  if (await input.isVisible().catch(()=>false)) {
    await input.focus().catch(()=>{});
  } else if (await trigger.isVisible().catch(()=>false)) {
    await trigger.click({timeout:1000}).catch(()=>{});
  }
  await page.keyboard.press("ArrowDown").catch(()=>{});
  await page.keyboard.press("Enter").catch(()=>{});
  await page.waitForTimeout(300);

  // 3) verifica algo seleccionado (label/valor no vacío)
  const selectedMark = cont.locator('.p-dropdown-label:not(:empty), .p-autocomplete-multiple-container .p-autocomplete-token, .p-highlight');
  if (await selectedMark.first().isVisible().catch(()=>false)) return true;

  // 4) dump de fallo
  fs.writeFileSync(`${outPrefix}_fail.html`, await page.content());
  await page.screenshot({ path: `${outPrefix}_fail.png`, fullPage: true }).catch(()=>{});
  return false;
}

async function selectCenterAndService(page) {
  await expandAllAccordions(page);
  await ensurePanelOpen(page, /Centro|Centre/i);
  await ensurePanelOpen(page, /Servicio|Servei/i);

  // CENTRO
  const centroOK = await selectByFlow(
    page,
    /Centro|Centre/i,
    "center",
    CENTRO_TEXT,
    CENTRO_REGEX,
    CENTRO_INDEX
  );
  if (!centroOK) throw new Error(`No se pudo clicar el centro (usa CENTRO_TEXT / CENTRO_REGEX / CENTRO_INDEX)`);

  // SERVICIO
  const servicioOK = await selectByFlow(
    page,
    /Servicio|Servei/i,
    "service",
    SERVICIO_TEXT,
    SERVICIO_REGEX,
    SERVICIO_INDEX
  );
  if (!servicioOK) throw new Error(`No se pudo clicar el servicio (usa SERVICIO_TEXT / SERVICIO_REGEX / SERVICIO_INDEX)`);

  // Siguiente
  for (const n of [
    page.getByRole("button", { name: /Siguiente|Següent/i }).first(),
    page.locator('button:has-text("Siguiente")').first(),
    page.locator('button:has-text("Següent")').first(),
    page.locator('text=/Siguiente|Següent/i').first(),
  ]) {
    const v = await n.isVisible().catch(()=>false);
    if (v) {
      for (const f of [()=>n.click({timeout:1200}), ()=>n.click({timeout:1200,force:true}), ()=>n.evaluate(e=>e&&e.click())]) {
        try { await f(); return; } catch {}
      }
    }
  }
  throw new Error('No se pudo pulsar "Siguiente"');
}

/* ---------------- main ---------------- */

async function run() {
  const browser = await chromium.launch({
    headless: HEADLESS.toLowerCase() === "true",
    channel: BROWSER_CHANNEL || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    recordVideo: { dir: VIDEOS_DIR },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  try {
    const ready = await tryDeepLink(page);
    if (!ready) throw new Error('No se cargó la pantalla "Centro y servicio"');

    await selectCenterAndService(page);

    await waitMaskGone(page, 5000);
    await page.screenshot({ path: "state.png", fullPage: true }).catch(()=>{});
    console.log("Centro y servicio seleccionados correctamente.");
  } catch (e) {
    console.error("Error en la ejecución:", e);
  } finally {
    await context.tracing.stop({ path: path.join(TRACES_DIR, "trace.zip") }).catch(()=>{});
    await context.close();
    await browser.close();
  }
}

run();
