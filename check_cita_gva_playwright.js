// check_cita_gva_playwright.js
// Selección de SERVICIO con fallback: primera opción visible + teclado.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const {
  GVA_BASE = "https://sige.gva.es/qsige/citaprevia.justicia",
  APPOINTMENT_UUID,
  APPOINTMENT_URL,
  CENTRO_TEXT,
  SERVICIO_TEXT,
  SERVICIO_REGEX,          // opcional
  SERVICIO_INDEX,          // opcional (0 = primera opción)
  TIMEOUT_MS = "180000",
  HEADLESS = "false",
  BROWSER_CHANNEL = "chrome",
} = process.env;

if (!CENTRO_TEXT) {
  console.error("Falta la variable de entorno CENTRO_TEXT");
  process.exit(1);
}
const timeout = Number(TIMEOUT_MS) || 180000;
const VIDEOS_DIR = path.resolve("videos");
const TRACES_DIR = path.resolve("traces");
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(TRACES_DIR, { recursive: true });

const norm = (s) =>
  (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

function escRe(s){return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}

async function waitMaskGone(scope, maxMs = 45000) {
  const end = Date.now() + maxMs;
  const masks = [
    scope.locator(".loading-mask"),
    scope.locator('[aria-busy="true"]'),
    scope.locator(".v-progress-circular, .spinner, .loading"),
  ];
  while (Date.now() < end) {
    let any = false;
    for (const m of masks) if (await m.first().isVisible().catch(()=>false)) { any = true; break; }
    if (!any) {
      await scope.waitForLoadState?.("networkidle", { timeout: 8000 }).catch(()=>{});
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

/* -------- acordeones -------- */
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

/* -------- selección servicio -------- */
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

function rxFromEnv() {
  if (!SERVICIO_REGEX) return null;
  try { return new RegExp(SERVICIO_REGEX, "i"); } catch { console.warn("SERVICIO_REGEX inválido"); return null; }
}
function idxFromEnv() {
  if (SERVICIO_INDEX === undefined || SERVICIO_INDEX === null) return null;
  const n = Number(SERVICIO_INDEX);
  return Number.isFinite(n) ? n : null;
}

async function openServiceControl(container, page) {
  // intenta abrir dropdown/autocomplete/combobox del panel Servicio
  const trigger = container.locator(
    '.p-dropdown, .p-autocomplete, [role="combobox"], .p-listbox'
  ).first();
  const input = container.locator('input[type="text"], input[role="combobox"], .p-inputtext input, .p-dropdown-filter').first();

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
  return { trigger, input };
}
async function selectFromOverlay(page, target) {
  const overlay = page.locator('.p-dropdown-panel:visible, .p-autocomplete-panel:visible, .p-overlaypanel:visible, .p-select-overlay:visible').first();
  const visible = await overlay.isVisible().catch(()=>false);
  if (!visible) return false;

  // dumps
  try { fs.writeFileSync("overlay.html", await overlay.innerHTML()); await page.screenshot({path:"overlay.png", fullPage:true}).catch(()=>{}); } catch {}
  await dumpOptions(overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a'), "services_found.txt");

  // por índice directo
  const idx = idxFromEnv();
  if (idx !== null) {
    const all = overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a');
    const count = await all.count();
    if (count > idx) {
      const el = all.nth(idx);
      for (const f of [()=>el.click({timeout:1200}), ()=>el.click({timeout:1200,force:true}), ()=>el.evaluate(e=>e&&e.click())]) {
        try { await f(); return true; } catch {}
      }
    }
    return false;
  }

  // por regex/texto
  const rx = target instanceof RegExp ? target : new RegExp(escRe(target), "i");
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

  // scroll overlay y reintento
  for (let step=0; step<20; step++){
    const sc = await overlay.evaluate(node=>{
      const el = node; if (!el) return false;
      const before = el.scrollTop; el.scrollTop = Math.min(el.scrollTop + 400, el.scrollHeight);
      return el.scrollTop !== before;
    }).catch(()=>false);
    if (!sc) break;
    await dumpOptions(overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a'), "services_found.txt");
    if (await cand.isVisible().catch(()=>false)) {
      for (const f of [()=>cand.click({timeout:1200}), ()=>cand.click({timeout:1200,force:true}), ()=>cand.evaluate(e=>e&&e.click())]) {
        try { await f(); return true; } catch {}
      }
    }
  }
  return false;
}
async function selectFirstVisibleOption(page) {
  // overlay primero
  const overlay = page.locator('.p-dropdown-panel:visible, .p-autocomplete-panel:visible, .p-overlaypanel:visible, .p-select-overlay:visible').first();
  if (await overlay.isVisible().catch(()=>false)) {
    const all = overlay.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, li, label, button, a');
    // intenta la primera visible
    for (let i=0;i<Math.min(10, await all.count()); i++){
      const el = all.nth(i);
      if (await el.isVisible().catch(()=>false)) {
        for (const f of [()=>el.click({timeout:1000}), ()=>el.click({timeout:1000,force:true}), ()=>el.evaluate(e=>e&&e.click())]) {
          try { await f(); return true; } catch {}
        }
      }
    }
  }
  // si no hay overlay: cualquier opción visible global
  const any = page.locator('[role="option"], .p-dropdown-item, .p-autocomplete-item, .p-listbox li, li, label, button, a').filter({ hasText: /.+/ }).first();
  if (await any.isVisible().catch(()=>false)) {
    for (const f of [()=>any.click({timeout:1000}), ()=>any.click({timeout:1000,force:true}), ()=>any.evaluate(e=>e&&e.click())]) {
      try { await f(); return true; } catch {}
    }
  }
  return false;
}
async function selectServicio(page, container) {
  // 1) abre control
  const {trigger, input} = await openServiceControl(container, page);
  await page.waitForTimeout(250);

  // 2) si hay input y tenemos texto, filtra
  const targetRx = SERVICIO_REGEX ? new RegExp(SERVICIO_REGEX,"i") : null;
  const targetTxt = SERVICIO_TEXT || "";
  if (await input.isVisible().catch(()=>false) && targetTxt) {
    await input.fill(""); await input.type(targetTxt, {delay:25});
    await page.waitForTimeout(350);
  }

  // 3) intenta selección por overlay (regex/texto/índice)
  const target = targetRx ?? (targetTxt || "");
  if (target) {
    const ok = await selectFromOverlay(page, target);
    if (ok) return true;
  }

  // 4) si no, selección por índice si lo diste
  if (idxFromEnv() !== null) {
    const ok = await selectFromOverlay(page, 0); // overlay ya abierto -> primera
    if (ok) return true;
  }

  // 5) último recurso: tomar la **primera opción visible**
  const okFirst = await selectFirstVisibleOption(page);
  if (okFirst) return true;

  // 6) todavía: intenta teclado sobre el input/trigger
  if (await input.isVisible().catch(()=>false)) {
    await input.focus();
  } else if (await trigger.isVisible().catch(()=>false)) {
    await trigger.click({timeout:1000}).catch(()=>{});
  }
  await page.keyboard.press("ArrowDown").catch(()=>{});
  await page.keyboard.press("ArrowDown").catch(()=>{});
  await page.keyboard.press("Enter").catch(()=>{});
  await page.waitForTimeout(300);

  // verifica que algo quedó seleccionado (algún chip/label marcado)
  const selectedMark = container.locator('.p-dropdown-label:not(:empty), .p-autocomplete-multiple-container .p-autocomplete-token, .p-highlight');
  if (await selectedMark.first().isVisible().catch(()=>false)) return true;

  // dump de fallo
  fs.writeFileSync("fail_service.html", await page.content());
  await page.screenshot({path:"fail_service.png", fullPage:true}).catch(()=>{});
  return false;
}

/* -------- flujo principal -------- */
async function selectCenterAndService(page) {
  await expandAllAccordions(page);
  await ensurePanelOpen(page, /Centro|Centre/i);
  await ensurePanelOpen(page, /Servicio|Servei/i);

  // CENTRO
  {
    const cont = panelContent(page, /Centro|Centre/i);
    // estrategia simple: click por texto o primera opción visible
    const rx = new RegExp(escRe(CENTRO_TEXT), "i");
    let ok = await cont.getByRole("option",{name:rx}).first().click({timeout:1200}).then(()=>true).catch(()=>false);
    if (!ok) ok = await cont.locator(`text=/${rx.source}/${rx.flags}`).first().click({timeout:1200}).then(()=>true).catch(()=>false);
    if (!ok) {
      // tomar primera visible
      const any = cont.locator('[role="option"], li, label, button, a').first();
      if (await any.isVisible().catch(()=>false)) ok = await any.click({timeout:1200}).then(()=>true).catch(()=>false);
    }
    if (!ok) throw new Error(`No se pudo clicar el centro "${CENTRO_TEXT}"`);
  }

  // SERVICIO con fallback fuerte
  {
    const cont = panelContent(page, /Servicio|Servei/i);
    try { fs.writeFileSync("service_panel.html", await cont.innerHTML()); } catch {}
    const ok = await selectServicio(page, cont);
    if (!ok) throw new Error("No se pudo clicar el servicio según todos los métodos (texto/regex/índice/primera/teclado)");
  }

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
