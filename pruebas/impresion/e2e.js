/* =============================================================
   PRUEBAS DE NAVEGADOR DE LA IMPRESION AUTOMATICA (panel.html)

   Chrome sin interfaz + Supabase simulado (servidor-falso.js).
   NO usa la base real ni imprime en ningun papel: window.print() se
   sustituye por una grabadora que guarda el documento que se habria
   impreso.

   USO (Windows):
     node pruebas/impresion/e2e.js
   Variables opcionales:
     CHROME=C:\ruta\chrome.exe     navegador a usar
     CAPTURAS=C:\ruta\carpeta      si se define, guarda ahi las capturas
                                   a 360/390/768/1280 px
     TICKETS=C:\ruta\carpeta       si se define, guarda ahi el HTML de
                                   cada ticket que se "imprimio"
     PANEL_BASE=C:\ruta\panel.html version anterior del panel, para
                                   comparar capturas lado a lado
     SOLO="^(18|19)\."             corre solo los escenarios cuyo nombre
                                   case con la expresion
     FUENTES_REALES=1              deja cargar Google Fonts: las capturas
                                   salen con Anton / Libre Franklin, como
                                   las ve la cocina (necesita internet)

   Tarda ~2 minutos: respeta las pausas reales entre tickets.
============================================================= */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { crearServidor } = require("./servidor-falso.js");

const CHROME = process.env.CHROME || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find(p => fs.existsSync(p));

const PUERTO_WEB = 8098;
const PUERTO_CDP = 9333;
const PAUSA_TICKETS_MS = 2500;   // la misma que panel.html
// FUENTES_REALES=1 deja pasar Google Fonts (Anton / Libre Franklin) para que
// las capturas sean lo que ve la cocina. Sin esto salen con la fuente de
// respaldo del sistema, mas ancha, y el resultado es determinista sin red.
const FUENTES_REALES = process.env.FUENTES_REALES === "1";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- CDP minimo ---------------- */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pend = new Map();
    this.escuchas = [];
    this.abierto = new Promise((ok, mal) => {
      this.ws.onopen = ok;
      this.ws.onerror = mal;
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { ok, mal } = this.pend.get(m.id);
        this.pend.delete(m.id);
        if (m.error) mal(new Error(m.error.message)); else ok(m.result);
      } else if (m.method) {
        this.escuchas.forEach(f => f(m));
      }
    };
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((ok, mal) => this.pend.set(id, { ok, mal }));
  }
  on(f) { this.escuchas.push(f); }
}

/* Grabadora de window.print(): se inyecta en TODOS los marcos */
const SCRIPT_GRABADORA = `
(function(){
  window.print = function(){
    try{
      var top = window.top;
      top.__impresos = top.__impresos || [];
      var d = document;
      top.__impresos.push({
        t: Date.now(),
        enMarco: window !== top,
        texto: d.body ? d.body.innerText : "",
        pagina: (d.getElementById("pagina-ticket") || {}).textContent || null,
        html: "<!DOCTYPE html>" + d.documentElement.outerHTML
      });
    }catch(e){}
  };
  // Wake Lock simulado: cuenta cuantos bloqueos hay activos
  try{
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: {
      request: async function(){
        window.__wl = (window.__wl || 0) + 1;
        var oyentes = [];
        return { release: function(){ window.__wl--; oyentes.forEach(function(f){ f(); }); },
                 addEventListener: function(_, f){ oyentes.push(f); } };
      }
    }});
  }catch(e){}
})();`;

class Pagina {
  constructor(cdp, sessionId, nombre) {
    this.cdp = cdp; this.sid = sessionId; this.nombre = nombre;
    this.errores = [];
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.errores.push("EXCEPCION: " + (d.exception && d.exception.description || d.text));
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.errores.push("console.error: " + m.params.args.map(a => a.value || a.description || "").join(" "));
      } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error" &&
                 !/ERR_BLOCKED_BY_CLIENT/.test(m.params.entry.text + " " + (m.params.entry.url || ""))) {
        this.errores.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
      } else if (m.method === "Fetch.requestPaused") {
        const url = m.params.request.url;
        if (url.startsWith("http://127.0.0.1:" + PUERTO_WEB) ||
            (FUENTES_REALES && /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url))) {
          cdp.send("Fetch.continueRequest", { requestId: m.params.requestId }, sessionId).catch(() => {});
        } else {
          // Fuentes y CDN externos: respuesta vacia, sin ruido de red
          const css = /css|fonts/.test(url);
          cdp.send("Fetch.fulfillRequest", {
            requestId: m.params.requestId, responseCode: 200,
            responseHeaders: [{ name: "content-type", value: css ? "text/css" : "text/plain" }],
            body: ""
          }, sessionId).catch(() => {});
        }
      }
    });
  }
  async eval(expr) {
    const r = await this.cdp.send("Runtime.evaluate", {
      expression: expr, awaitPromise: true, returnByValue: true
    }, this.sid);
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async ir(url) {
    await this.cdp.send("Page.navigate", { url }, this.sid);
  }
  async esperar(fn, ms, etiqueta) {
    const fin = Date.now() + (ms || 8000);
    while (Date.now() < fin) {
      try { if (await this.eval("(" + fn + ")()")) return true; } catch (e) { /* aun cargando */ }
      await sleep(100);
    }
    throw new Error("Tiempo agotado esperando: " + (etiqueta || fn));
  }
  impresos() {
    return this.eval("(window.__impresos || []).map(function(x){return {t:x.t,enMarco:x.enMarco,texto:x.texto,pagina:x.pagina};})");
  }
  async htmlImpresos() {
    return this.eval("(window.__impresos || []).map(function(x){return x.html;})");
  }
  async captura(archivo, ancho, alto) {
    await this.cdp.send("Emulation.setDeviceMetricsOverride",
      { width: ancho, height: alto, deviceScaleFactor: 1, mobile: false }, this.sid);
    await sleep(400);
    const r = await this.cdp.send("Page.captureScreenshot", { format: "png" }, this.sid);
    fs.writeFileSync(archivo, Buffer.from(r.data, "base64"));
  }
  async tamano(ancho, alto) {
    await this.cdp.send("Emulation.setDeviceMetricsOverride",
      { width: ancho, height: alto, deviceScaleFactor: 1, mobile: false }, this.sid);
    await sleep(350);
  }
  /* Clic REAL con el mouse en el centro del elemento (o en x,y): si algo
     lo tapa, el clic cae en lo que lo tapa, igual que en la pantalla. */
  async clic(selector, x, y) {
    if (x === undefined) {
      const r = await this.eval("(function(){var e=document.querySelector(" + JSON.stringify(selector) +
        ");if(!e)return null;e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
      if (!r) throw new Error("clic: no existe " + selector);
      x = r.x; y = r.y;
    }
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.cdp.send("Input.dispatchMouseEvent",
        { type, x, y, button: "left", clickCount: 1 }, this.sid);
    }
    await sleep(60);
  }
  async tecla(key, extra) {
    const codigos = { Escape: 27, Tab: 9 };
    const p = { key, code: key, windowsVirtualKeyCode: codigos[key] || 0, ...(extra || {}) };
    await this.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...p }, this.sid);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...p }, this.sid);
    await sleep(60);
  }
}

/* ---------------- Datos ---------------- */
let relojBase = Date.now() - 20 * 60e3;
function pedido(id, extra) {
  relojBase += 1000;
  const t = new Date(relojBase).toISOString();
  // 'numero' = el del restaurante (pedidos.numero). Con un solo restaurante coincide con el id; un escenario
  // propio (21) prueba el caso en que difieren.
  return {
    id, numero: id, restaurante_id: RESTAURANTE_ID, referencia: "TAQ-" + id, estado: "nuevo", estado_pago: "aprobado",
    cliente_nombre: "Cliente " + id, cliente_telefono: "3001234567", cliente_email: null,
    tipo_pedido: "domicilio", direccion: "Calle 1 # 2-3", barrio: "Centro", indicaciones: null,
    items: [{ id: "t", nombre: "Tacos al pastor", cantidad: 2, precio: 12000 }],
    subtotal: 24000, costo_domicilio: 0, total: 24000, wompi_metodo_pago: "CARD",
    creado_en: t, pagado_en: t, actualizado_en: t, estado_cambiado_en: t,
    impreso_en: null, reimpresiones: 0, reimpreso_en: null,
    ...extra
  };
}

/* ---------------- Ejecucion ---------------- */
// El restaurante que simula el servidor de prueba (Taqueiros: su id fijo del SQL 10)
const RESTAURANTE_ID = "00000000-0000-4000-8000-000000000001";
const resultados = [];
function comprobar(ok, texto) {
  resultados.push({ ok, texto });
  console.log("   " + (ok ? "✅" : "❌") + " " + texto);
}
let alIniciarEscenario = async () => {};
async function escenario(nombre, fn) {
  // SOLO_CAPTURAS=1 salta lo demas (para iterar rapido sobre el diseno)
  if (process.env.SOLO_CAPTURAS && !/^Capturas/.test(nombre)) return;
  // SOLO="^(18|19|20)\." corre solo los escenarios cuyo nombre case
  if (process.env.SOLO && !new RegExp(process.env.SOLO).test(nombre)) return;
  console.log("\n▶ " + nombre);
  try { await alIniciarEscenario(); await fn(); }
  catch (e) { comprobar(false, "ERROR en el escenario: " + e.message); }
}

(async () => {
  if (!CHROME) { console.error("No encuentro Chrome. Define CHROME=ruta\\chrome.exe"); process.exit(2); }

  const extra = {};
  if (process.env.PANEL_BASE) extra["/panel-base.html"] = process.env.PANEL_BASE;
  const { servidor, estado } = crearServidor({ archivos: extra });
  await new Promise(r => servidor.listen(PUERTO_WEB, "127.0.0.1", r));
  const URL = "http://127.0.0.1:" + PUERTO_WEB;

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "taq-e2e-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=" + PUERTO_CDP, "--user-data-dir=" + perfil,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio",
    "--window-size=1280,900", "about:blank"
  ], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch("http://127.0.0.1:" + PUERTO_CDP + "/json/version")).json(); }
    catch (e) { await sleep(150); }
  }
  if (!version) { chrome.kill(); console.error("Chrome no abrio el puerto de depuracion"); process.exit(2); }

  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.abierto;

  const contextos = [];
  const paginasAbiertas = [];
  async function nuevaPagina(nombre, opciones) {
    const o = opciones || {};
    let ctx = o.contexto;
    if (!ctx) {
      ctx = (await cdp.send("Target.createBrowserContext")).browserContextId;
      contextos.push(ctx);
    }
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId: ctx });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const pg = new Pagina(cdp, sessionId, nombre);
    pg.contexto = ctx;
    pg.targetId = targetId;
    paginasAbiertas.push(pg);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    // Sin red externa: ni fuentes de Google ni CDN. Asi las capturas son
    // deterministas (siempre con las fuentes de respaldo del sistema).
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Network.setBlockedURLs", {
      urls: [...(FUENTES_REALES ? [] : ["https://fonts.googleapis.com/*", "https://fonts.gstatic.com/*"]),
             "https://*.jsdelivr.net/*", "https://unpkg.com/*", "https://checkout.wompi.co/*"]
    }, sessionId);
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SCRIPT_GRABADORA }, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    return pg;
  }

  /* Cada escenario parte de cero: las pestanas del anterior se cierran,
     si no seguirian vivas, escuchando Realtime y reclamando pedidos. */
  alIniciarEscenario = async () => {
    for (const pg of paginasAbiertas) {
      if (pg.cerrada) continue;
      pg.cerrada = true;
      try { await cdp.send("Target.closeTarget", { targetId: pg.targetId }); } catch (e) { /* ya cerrada */ }
    }
    await sleep(200);
  };

  const admin = {
    reset: (pedidos, modo) => fetch(URL + "/__admin/reset", { method: "POST", body: JSON.stringify({ pedidos, modo }) }),
    evento: (fila, tipo) => fetch(URL + "/__admin/evento", { method: "POST", body: JSON.stringify({ fila, tipo }) }),
    modo: (m) => fetch(URL + "/__admin/modo", { method: "POST", body: JSON.stringify(m) }),
    estado: async () => (await fetch(URL + "/__admin/estado")).json()
  };

  // Las preferencias del panel llevan el id del restaurante (panel-restaurante.js, PR.clave)
  const IMPRESION_KEY = "panel-imprimir-v2:" + RESTAURANTE_ID;
  const SONIDO_KEY = "panel-sonido-v2:" + RESTAURANTE_ID;

  /* Abre el panel; 'activo' deja el interruptor encendido o apagado
     como si el equipo ya lo tuviera guardado. */
  async function abrirPanel(nombre, activo, contexto) {
    const pg = await nuevaPagina(nombre, { contexto });
    await pg.ir(URL + "/panel.html");
    await pg.esperar("function(){return document.readyState==='complete' && !!window.TicketComanda;}", 10000, "carga");
    await pg.eval("localStorage.setItem('" + IMPRESION_KEY + "','" + (activo ? "on" : "off") + "'); true");
    await pg.ir(URL + "/panel.html");
    await pg.esperar("function(){return !document.getElementById('app').hidden && document.getElementById('connTxt').textContent==='En vivo';}",
      10000, "panel en vivo");
    return pg;
  }
  async function recargar(pg) {
    await pg.ir(URL + "/panel.html");
    await pg.esperar("function(){return !document.getElementById('app').hidden && document.getElementById('connTxt').textContent==='En vivo';}",
      10000, "panel en vivo tras recargar");
  }
  const numeros = (lista) => lista.map(x => (x.texto.match(/#\d{3,}/) || ["?"])[0]);

  try {
    /* ------------------------------------------------------------ */
    await escenario("1. Un pedido pagado que entra en vivo se imprime exactamente una vez", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", true);
      await admin.evento(pedido(101));
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "primer ticket");
      await sleep(PAUSA_TICKETS_MS + 2500);   // margen para detectar un duplicado
      const imp = await p.impresos();
      comprobar(imp.length === 1, "salieron " + imp.length + " tickets (esperado: 1)");
      comprobar(imp[0] && /#101/.test(imp[0].texto), "es el pedido #101");
      comprobar(imp[0] && imp[0].enMarco, "se imprimio el iframe oculto, no la pagina del panel");
      comprobar(imp[0] && /DOMICILIO · WEB · PAGADO/.test(imp[0].texto.replace(new RegExp(String.fromCharCode(0xA0), "g"), " ").replace(/\s+/g, " ")),
        "trae la franja DOMICILIO · WEB · PAGADO");
      comprobar(imp[0] && !/REIMPRESIÓN/.test(imp[0].texto), "no esta marcado como reimpresion");
      comprobar(imp[0] && !/COMANDAS|Sonido|Horario|Historial|Cerrar sesión|Nuevo|En preparación/.test(imp[0].texto),
        "el ticket no contiene nada del panel");
      comprobar(imp[0] && /@page\{size:80mm \d+mm;margin:0;\}/.test(imp[0].pagina || ""),
        "hoja de 80 mm con margen 0 y alto ajustado: " + (imp[0] && imp[0].pagina || "").slice(0, 40));
      const st = await admin.estado();
      comprobar(st.reclamos.filter(r => r.id === 101 && r.gano).length === 1, "la base entrego el pedido una sola vez");
      comprobar(await p.eval("document.querySelectorAll('iframe').length") === 0, "el iframe se retiro despues de imprimir");
      comprobar(await p.eval("![].some.call(document.querySelectorAll('style'), function(s){return /@page/.test(s.textContent);})"),
        "la regla @page temporal del panel se retiro tras imprimir");
    });

    /* ------------------------------------------------------------ */
    await escenario("2. Dos pantallas de cocina abiertas: solo una imprime", async () => {
      await admin.reset([]);
      const a = await abrirPanel("A", true);
      const b = await abrirPanel("B", true);   // otro contexto = otro localStorage
      await admin.evento(pedido(102));
      await sleep(PAUSA_TICKETS_MS + 4000);
      const ia = await a.impresos(), ib = await b.impresos();
      comprobar(ia.length + ib.length === 1, "tickets en A: " + ia.length + ", en B: " + ib.length + " (suma esperada: 1)");
      const st = await admin.estado();
      const rec = st.reclamos.filter(r => r.id === 102);
      comprobar(rec.length === 2 && rec.filter(r => r.gano).length === 1,
        "las dos pantallas pidieron el pedido y la base se lo dio a una sola (" + rec.length + " reclamos, " + rec.filter(r => r.gano).length + " ganador)");
    });

    /* ------------------------------------------------------------ */
    await escenario("3. Recargar la pagina no reimprime", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", true);
      await admin.evento(pedido(103));
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000);
      await sleep(PAUSA_TICKETS_MS + 1500);
      await recargar(p);
      await sleep(PAUSA_TICKETS_MS + 3000);
      const imp = await p.impresos();
      comprobar(imp.length === 0, "tras recargar salieron " + imp.length + " tickets (esperado: 0)");
      const st = await admin.estado();
      comprobar(st.reclamos.filter(r => r.id === 103).length === 1, "no se volvio ni a pedir el pedido a la base (el estado ya venia en la fila)");
    });

    /* ------------------------------------------------------------ */
    await escenario("4. Reconectar Realtime no reimprime (y recupera lo que se perdio)", async () => {
      await admin.reset([pedido(104, { impreso_en: new Date().toISOString() })]);
      const p = await abrirPanel("A", true);
      await sleep(1500);

      // Se cae el canal; mientras tanto entra un pedido que el panel NO ve
      await p.eval("window.__mock.canal('closed'); window.dispatchEvent(new Event('offline')); true");
      await admin.evento(pedido(105));
      await sleep(600);
      await p.eval("window.__mock.canal('joined'); window.dispatchEvent(new Event('online')); true");

      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "ticket recuperado");
      await sleep(PAUSA_TICKETS_MS + 3000);
      const imp = await p.impresos();
      comprobar(imp.length === 1 && /#105/.test(imp[0].texto),
        "al reconectar salio solo el pedido perdido (#105): " + numeros(imp).join(", "));

      // Una segunda reconexion ya no debe imprimir nada
      await p.eval("window.__mock.canal('closed'); window.dispatchEvent(new Event('offline')); true");
      await sleep(300);
      await p.eval("window.__mock.canal('joined'); window.dispatchEvent(new Event('online')); true");
      await sleep(PAUSA_TICKETS_MS + 2500);
      comprobar((await p.impresos()).length === 1, "una segunda reconexion no imprimio nada mas");
    });

    /* ------------------------------------------------------------ */
    await escenario("5. Con el interruptor apagado no se imprime nada", async () => {
      await admin.reset([pedido(110)]);
      const p = await abrirPanel("A", false);
      await admin.evento(pedido(111));
      await sleep(PAUSA_TICKETS_MS + 3000);
      comprobar((await p.impresos()).length === 0, "0 tickets con el interruptor apagado");
      const st = await admin.estado();
      comprobar(st.reclamos.length === 0, "tampoco reclamo ningun pedido a la base");
      const txt = await p.eval("document.getElementById('estadoImpresion').textContent");
      comprobar(txt === "INACTIVA", "el indicador dice INACTIVA");
      comprobar(await p.eval("document.getElementById('avisoImpresion').hidden"),
        "sin avisos nuevos en pantallas que no imprimen");
    });

    /* ------------------------------------------------------------ */
    await escenario("6. Pendiente de pago, entregados y cancelados nunca salen solos", async () => {
      await admin.reset([
        pedido(120, { estado: "entregado" }),
        pedido(121, { estado: "cancelado" }),
        pedido(122, { estado: "pendiente_pago", estado_pago: "pendiente" })
      ]);
      const p = await abrirPanel("A", true);
      await admin.evento(pedido(123, { estado: "pendiente_pago", estado_pago: "pendiente" }));
      await admin.evento(pedido(124, { estado: "entregado" }));
      await admin.evento(pedido(125, { estado: "cancelado" }));
      await sleep(PAUSA_TICKETS_MS + 3000);
      comprobar((await p.impresos()).length === 0, "0 tickets");
      comprobar((await admin.estado()).reclamos.length === 0, "ningun reclamo a la base");

      // Un pendiente de pago que se paga SI se imprime
      await admin.evento(pedido(122, { estado: "nuevo", estado_pago: "aprobado" }));
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "ticket del pago aprobado");
      comprobar(/#122/.test((await p.impresos())[0].texto), "en cuanto el pago se aprueba, el #122 si sale");
    });

    /* ------------------------------------------------------------ */
    await escenario("7. Ocho sin imprimir: aviso y boton, no se imprimen todos", async () => {
      const ocho = [];
      for (let i = 0; i < 8; i++) ocho.push(pedido(200 + i));
      await admin.reset(ocho);
      const p = await abrirPanel("A", true);
      await sleep(PAUSA_TICKETS_MS + 1500);
      comprobar((await p.impresos()).length === 0, "0 tickets al abrir con 8 pendientes");
      const aviso = await p.eval("(function(){var a=document.getElementById('avisoImpresion');return a.hidden?'':a.textContent;})()");
      comprobar(/8 pedidos pagados sin imprimir/.test(aviso), "aviso visible: «" + aviso.slice(0, 70) + "…»");
      comprobar(await p.eval("!!document.querySelector('#avisoImpresion button')"), "hay boton «Imprimir pendientes»");

      await p.eval("document.querySelector('#avisoImpresion button').click(); true");
      await p.esperar("function(){return (window.__impresos||[]).length>=8;}", 60000, "los 8 tickets");
      await sleep(1000);
      const imp = await p.impresos();
      const orden = numeros(imp);
      comprobar(imp.length === 8, "salieron " + imp.length + " tickets");
      comprobar(orden.join(",") === "#200,#201,#202,#203,#204,#205,#206,#207",
        "en orden de llegada: " + orden.join(" "));
      let minGap = Infinity;
      for (let i = 1; i < imp.length; i++) minGap = Math.min(minGap, imp[i].t - imp[i - 1].t);
      comprobar(minGap >= PAUSA_TICKETS_MS, "pausa minima entre tickets: " + minGap + " ms (>= " + PAUSA_TICKETS_MS + ")");
      comprobar(await p.eval("document.getElementById('avisoImpresion').hidden"), "el aviso desaparece al terminar");
    });

    /* ------------------------------------------------------------ */
    await escenario("8. Tres pendientes al abrir: salen solos, en orden, con pausa", async () => {
      await admin.reset([pedido(300), pedido(301), pedido(302)]);
      const p = await abrirPanel("A", true);
      await p.esperar("function(){return (window.__impresos||[]).length>=3;}", 30000, "3 tickets");
      await sleep(PAUSA_TICKETS_MS + 1500);
      const imp = await p.impresos();
      comprobar(numeros(imp).join(",") === "#300,#301,#302", "orden: " + numeros(imp).join(" "));
      comprobar(imp.length === 3, "exactamente 3 tickets");
      comprobar(imp[1].t - imp[0].t >= PAUSA_TICKETS_MS && imp[2].t - imp[1].t >= PAUSA_TICKETS_MS,
        "pausa entre tickets: " + (imp[1].t - imp[0].t) + " ms y " + (imp[2].t - imp[1].t) + " ms");
    });

    /* ------------------------------------------------------------ */
    await escenario("9. Cuatro pedidos a la vez: cola en orden de llegada", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", true);
      for (const id of [400, 401, 402, 403]) await admin.evento(pedido(id));
      await p.esperar("function(){return (window.__impresos||[]).length>=4;}", 40000, "4 tickets");
      await sleep(PAUSA_TICKETS_MS + 1500);
      const imp = await p.impresos();
      comprobar(imp.length === 4, "exactamente 4 tickets");
      comprobar(numeros(imp).join(",") === "#400,#401,#402,#403", "orden: " + numeros(imp).join(" "));
      let minGap = Infinity;
      for (let i = 1; i < imp.length; i++) minGap = Math.min(minGap, imp[i].t - imp[i - 1].t);
      comprobar(minGap >= PAUSA_TICKETS_MS, "pausa minima: " + minGap + " ms");
    });

    /* ------------------------------------------------------------ */
    await escenario("10. Reimprimir: sale marcado REIMPRESIÓN y no toca la marca original", async () => {
      const original = new Date(Date.now() - 600000).toISOString();
      await admin.reset([pedido(500, { impreso_en: original })]);
      const p = await abrirPanel("A", false);   // reimprimir funciona aunque la pantalla no auto-imprima
      await p.esperar("function(){return !!document.querySelector('[data-reimprimir=\"500\"]');}", 5000, "boton Reimprimir");
      await p.eval("document.querySelector('[data-reimprimir=\"500\"]').click(); true");
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "ticket reimpreso");
      await sleep(PAUSA_TICKETS_MS + 500);
      const imp = await p.impresos();
      comprobar(imp.length === 1, "1 ticket");
      comprobar(/REIMPRESIÓN/.test(imp[0].texto), "marcado REIMPRESIÓN");
      comprobar(/#500/.test(imp[0].texto), "es el #500");
      const st = await admin.estado();
      const fila = st.pedidos.find(x => x.id === 500);
      comprobar(fila.impreso_en === original, "impreso_en original intacto");
      comprobar(fila.reimpresiones === 1, "contador de reimpresiones = 1");
      comprobar(st.reclamos.length === 0, "no se reclamo la impresion automatica");
    });

    /* ------------------------------------------------------------ */
    await escenario("11. Sin el SQL: el panel funciona, avisa y no duplica", async () => {
      await admin.reset([pedido(600)], { columnas: false });
      const p = await abrirPanel("A", true);
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "ticket por respaldo local");
      await sleep(PAUSA_TICKETS_MS + 1500);
      comprobar((await p.impresos()).length === 1, "el pedido salio una vez con el respaldo local");
      const aviso = await p.eval("document.getElementById('avisoImpresion').textContent");
      comprobar(/Falta ejecutar el SQL 02 en Supabase/.test(aviso), "aviso: «Falta ejecutar el SQL 02 en Supabase»");
      comprobar(await p.eval("document.querySelectorAll('.pedido').length") === 1, "el tablero sigue mostrando el pedido");

      await admin.evento(pedido(601));
      await p.esperar("function(){return (window.__impresos||[]).length>=2;}", 8000, "segundo ticket");
      await sleep(PAUSA_TICKETS_MS + 1500);
      await recargar(p);
      await sleep(PAUSA_TICKETS_MS + 3000);
      comprobar((await p.impresos()).length === 0, "al recargar no reimprime (respaldo local)");

      // Reimprimir tambien funciona sin el SQL
      await p.eval("document.querySelector('[data-reimprimir=\"600\"]').click(); true");
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "reimpresion sin SQL");
      comprobar(/REIMPRESIÓN/.test((await p.impresos())[0].texto), "la reimpresion funciona sin el SQL");
      await sleep(PAUSA_TICKETS_MS);
    });

    /* ------------------------------------------------------------ */
    await escenario("12. Ticket de prueba y modal de impresion", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", false);
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('modalImpresion').classList.contains('open')"), "el modal abre");
      const lista = await p.eval("document.getElementById('impLista').textContent");
      comprobar(/INACTIVA/.test(lista) && /Lista: no repite entre pantallas/.test(lista), "el modal informa estado y base de datos");
      await p.eval("document.getElementById('impPruebaBtn').click(); true");
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "ticket de prueba");
      const t = (await p.impresos())[0].texto;
      comprobar(/TICKET DE PRUEBA/.test(t), "marcado TICKET DE PRUEBA");
      comprobar(/María del Pilar Muñoz/.test(t) && /ñ/.test(t), "trae ñ y tildes");
      await sleep(PAUSA_TICKETS_MS);
    });

    /* ------------------------------------------------------------ */
    await escenario("13. Pantalla encendida (Wake Lock) sigue al interruptor", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", false);
      comprobar((await p.eval("window.__wl || 0")) === 0, "apagado: sin bloqueo");
      await p.eval("document.getElementById('switchImpresion').click(); true");
      await p.esperar("function(){return window.__wl===1;}", 3000, "bloqueo activo");
      comprobar(true, "al encender: 1 bloqueo de pantalla activo");
      comprobar(await p.eval("document.getElementById('estadoImpresion').textContent") === "ACTIVA", "indicador ACTIVA");
      comprobar(await p.eval("localStorage.getItem('" + IMPRESION_KEY + "')") === "on", "guardado como 'on' en el navegador");
      await p.eval("document.getElementById('switchImpresion').click(); true");
      await p.esperar("function(){return window.__wl===0;}", 3000, "bloqueo liberado");
      comprobar(true, "al apagar: bloqueo liberado");
      comprobar(await p.eval("localStorage.getItem('" + IMPRESION_KEY + "')") === "off", "guardado como 'off'");
    });

    /* ------------------------------------------------------------ */
    await escenario("14. Ticket con datos hostiles: HTML, comillas y emojis como texto plano", async () => {
      const malo = pedido(700, {
        cliente_nombre: '<img src=x onerror="window.__xss=1"> "Pepe" & <b>Co</b> 🌮🔥',
        direccion: "<script>window.__xss=2</script> Calle \"7\" 🛵",
        indicaciones: "<svg onload=window.__xss=3> sin cebolla 😋\nsegunda línea",
        items: [{ id: "a", nombre: "<u>Taco</u> 🌮 \"especial\"", cantidad: 1, precio: 5000, nota: "<i>nota</i> ✅" }],
        subtotal: 5000, total: 5000
      });
      await admin.reset([]);
      const p = await abrirPanel("A", true);
      await admin.evento(malo);
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000);
      const t = (await p.impresos())[0].texto;
      comprobar(t.includes('<img src=x onerror="window.__xss=1">'), "las etiquetas salen como texto literal");
      comprobar(!/[\u{1F300}-\u{1FAFF}\u2705]/u.test(t), "sin emojis en el ticket");
      comprobar(!(await p.eval("window.__xss")), "no se ejecuto nada del texto del cliente");
      comprobar(t.includes('"Pepe"'), "las comillas se conservan");
      await sleep(PAUSA_TICKETS_MS);
    });

    /* ------------------------------------------------------------ */
    await escenario("15. Tamano del ticket: selector del panel, por equipo, en comandas y reimpresiones", async () => {
      const original = new Date(Date.now() - 600000).toISOString();
      await admin.reset([pedido(710, { impreso_en: original })]);
      const p = await abrirPanel("A", false);
      const escalaDe = (html) => (html.match(/--escala:\s*([\d.]+)/g) || []).shift();   // la 1a: el style de <html>, no el :root por defecto
      const KEY = "panel-ticket-tamano-v1";

      // Por defecto: Pequeno (.75)
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impTamano').value") === "pequeno", "el selector arranca en Pequeño");
      await p.eval("document.getElementById('impPruebaBtn').click(); true");
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 8000, "prueba pequena");
      await sleep(PAUSA_TICKETS_MS + 500);
      let htmls = await p.htmlImpresos();
      comprobar(/--escala:\s*0\.75/.test(escalaDe(htmls[0])), "ticket de prueba por defecto: --escala 0.75");

      // Cambiar a Normal: se guarda y vale para la reimpresion
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await p.eval("(function(){var s=document.getElementById('impTamano');s.value='normal';s.dispatchEvent(new Event('change'));})(); true");
      comprobar(await p.eval("localStorage.getItem('" + KEY + "')") === "normal", "se guardo 'normal' en este equipo");
      await p.eval("document.querySelector('[data-reimprimir=\"710\"]').click(); true");
      await p.esperar("function(){return (window.__impresos||[]).length>=2;}", 8000, "reimpresion normal");
      await sleep(PAUSA_TICKETS_MS + 500);
      htmls = await p.htmlImpresos();
      comprobar(/--escala:\s*0\.85/.test(escalaDe(htmls[1])), "la reimpresion usa --escala 0.85");
      comprobar(/REIMPRESIÓN/.test(htmls[1]), "y sigue marcada REIMPRESIÓN");

      // Grande en una comanda automatica nueva, y persiste al recargar
      await p.eval("(function(){var s=document.getElementById('impTamano');s.value='grande';s.dispatchEvent(new Event('change'));})(); true");
      await p.eval("document.getElementById('switchImpresion').click(); true");
      await admin.evento(pedido(711));
      await p.esperar("function(){return (window.__impresos||[]).length>=3;}", 10000, "comanda automatica grande");
      htmls = await p.htmlImpresos();
      comprobar(/#711/.test(htmls[2]) && /--escala:\s*1(?![.\d])/.test(escalaDe(htmls[2])), "la comanda automatica usa --escala 1");
      await sleep(PAUSA_TICKETS_MS);
      await recargar(p);
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impTamano').value") === "grande", "tras recargar el selector sigue en Grande");

      // Valor corrupto en el almacenamiento: vuelve a Pequeno
      await p.eval("localStorage.setItem('" + KEY + "','gigante'); true");
      await recargar(p);
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impTamano').value") === "pequeno", "un valor corrupto vuelve a Pequeño");
    });

    /* ------------------------------------------------------------ */
    await escenario("16. Modo de hoja: D por defecto, selector, por equipo, y lo usan prueba, reimpresion y calibracion", async () => {
      const original = new Date(Date.now() - 600000).toISOString();
      await admin.reset([pedido(720, { impreso_en: original })]);
      const p = await abrirPanel("A", false);
      const KEY = "panel-ticket-hoja-v1";
      const reglaDe = async (i) => (await p.impresos())[i].pagina || "";
      const elegir = (m) => p.eval("(function(){var s=document.getElementById('impModoHoja');s.value='" + m +
        "';s.dispatchEvent(new Event('change'));})(); true");
      let n = 0;
      const siguiente = async (que) => {
        n++;
        await p.esperar("function(){return (window.__impresos||[]).length>=" + n + ";}", 10000, que);
        await sleep(PAUSA_TICKETS_MS + 300);
      };

      // Por defecto D: hoja fija de 297 mm, y el selector lo marca como recomendado
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impModoHoja').value") === "D", "el selector arranca en D");
      comprobar(/recomendado para la DIG-POS892/.test(await p.eval(
        "document.querySelector('#impModoHoja option[value=D]').textContent")), "D dice (recomendado para la DIG-POS892)");
      comprobar(await p.eval("document.querySelectorAll('#impModoHoja option').length") === 4, "A, B y C siguen disponibles");
      comprobar(await p.eval("localStorage.getItem('" + KEY + "')") === null, "sin nada guardado hasta que se elige");
      await p.eval("document.getElementById('impPruebaBtn').click(); true");
      await siguiente("prueba en D por defecto");
      comprobar(/^@page\{size:80mm 297mm;margin:0;\}html,body\{height:auto;\}$/.test(await reglaDe(0)),
        "defecto D: hoja de 80 x 297 mm: " + (await reglaDe(0)));

      // A: alto medido (el de antes)
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await elegir("A");
      comprobar(await p.eval("localStorage.getItem('" + KEY + "')") === "A", "se guardo 'A' en este equipo");
      await p.eval("document.getElementById('impPruebaBtn').click(); true");
      await siguiente("prueba en A");
      comprobar(/^@page\{size:80mm \d+mm;margin:0;\}html,body\{height:\d+mm;overflow:hidden;\}$/.test(await reglaDe(1)),
        "A: alto medido con html/body fijos: " + (await reglaDe(1)));

      // B: automatico
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await elegir("B");
      comprobar(await p.eval("localStorage.getItem('" + KEY + "')") === "B", "se guardo 'B' en este equipo");
      await p.eval("document.querySelector('[data-reimprimir=\"720\"]').click(); true");
      await siguiente("reimpresion en B");
      comprobar(/^@page\{size:80mm auto;margin:0;\}/.test(await reglaDe(2)), "B en la reimpresion: " + (await reglaDe(2)));

      // C: medido + 1 mm. El alto de C es el de A + 1 para el mismo contenido
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await elegir("C");
      await p.eval("document.getElementById('impPruebaBtn').click(); true");
      await siguiente("prueba en C");
      const alto = (r) => Number((r.match(/size:80mm (\d+)mm/) || [])[1]);
      comprobar(/html,body\{height:auto;overflow:hidden;\}/.test(await reglaDe(3)), "C: html/body en auto y overflow hidden");
      comprobar(alto(await reglaDe(3)) === alto(await reglaDe(1)) + 1,
        "C pide " + alto(await reglaDe(3)) + " mm = A (" + alto(await reglaDe(1)) + ") + 1");

      // D elegido a mano; y la hoja de calibracion sale con el mismo modo
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await elegir("D");
      await p.eval("document.getElementById('impCalibracionBtn').click(); true");
      await siguiente("calibracion en D");
      const cal = (await p.impresos())[4];
      comprobar(/^@page\{size:80mm 297mm;margin:0;\}/.test(cal.pagina || ""), "D: @page de 80 x 297 mm");
      comprobar(cal.enMarco, "la calibracion se imprimio desde el iframe oculto, igual que una comanda");
      const t = cal.texto.replace(new RegExp(String.fromCharCode(0xA0), "g"), " ").replace(/\s+/g, " ");
      comprobar(/MODO: D · ALTO SOLICITADO: 297 mm · ANCHO: 80 mm/.test(t), "texto de calibracion: " + t.slice(0, 70));
      const geo = await p.eval("window.__impresos.length"); // la geometria se mide en el HTML guardado
      const htmls = await p.htmlImpresos();
      const h = htmls[4];
      comprobar(/class="cal-marco"[^>]*height:\s*297mm/.test(h), "marco del tamano de la pagina solicitada (297 mm)");
      comprobar((h.match(/class="cal-marca/g) || []).length === 29, "regla con marcas cada 10 mm hasta 290 mm");
      comprobar((h.match(/class="cal-num"/g) || []).length === 5, "un numero cada 50 mm (50 a 250)");
      comprobar((h.match(/class="cal-borde"/g) || []).length === 2, "linea gruesa arriba y abajo");
      comprobar(geo >= 5, "se imprimieron 5 documentos");

      // Un valor guardado se respeta al recargar (otro equipo que eligio C); uno corrupto vuelve a D
      await elegir("C");
      await recargar(p);
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impModoHoja').value") === "C", "tras recargar el selector sigue en C (valor guardado)");
      await p.eval("localStorage.setItem('" + KEY + "','Z'); true");
      await recargar(p);
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impModoHoja').value") === "D", "un valor corrupto vuelve a D");
    });

    /* ------------------------------------------------------------ */
    await escenario("17. Pedido de 30 productos: sale en dos hojas, sin partir productos y con linea de continuacion", async () => {
      const items = Array.from({ length: 30 }, (_, i) => {
        const k = String(i + 1).padStart(2, "0");
        return { id: "l" + k, nombre: "Taco numero " + k, cantidad: 1 + (i % 3), precio: 9000,
          nota: (i + 1) % 3 === 0 ? "Nota " + k + " sin cebolla\nNota " + k + " salsa aparte" : "" };
      });
      const subtotal = items.reduce((s, it) => s + it.cantidad * it.precio, 0);
      await admin.reset([]);
      const p = await abrirPanel("A", true);
      await admin.evento(pedido(730, { items, subtotal, total: subtotal }));
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 10000, "pedido largo");
      const doc = (await p.htmlImpresos())[0];
      const imp = (await p.impresos())[0];
      comprobar(/^@page\{size:80mm 297mm;margin:0;\}/.test(imp.pagina || ""), "sale en hoja fija de 297 mm (modo D por defecto)");
      comprobar((doc.match(/class="continuacion"/g) || []).length === 1, "una sola linea de continuacion (2 hojas)");
      comprobar(/class="continuacion">#730 · continuación</.test(doc), "dice \"#730 · continuación\"");
      // Cada producto con su nota esta dentro de un .item: nada se corta por la mitad
      comprobar((doc.match(/class="item"/g) || []).length === 30, "30 productos, cada uno en su bloque");
      const lineas = imp.texto.split("\n").map(l => l.trim()).filter(Boolean);
      const iCont = lineas.indexOf("#730 · continuación");
      comprobar(iCont > 0, "la linea de continuacion esta en el cuerpo del ticket");
      const antes = lineas.slice(0, iCont).join("\n"), despues = lineas.slice(iCont).join("\n");
      let partido = 0;
      for (let k = 3; k <= 30; k += 3) {
        const kk = String(k).padStart(2, "0");
        const enAntes = antes.includes("Taco numero " + kk), nota = "Nota " + kk + " salsa aparte";
        if (enAntes !== antes.includes(nota)) partido++;
      }
      comprobar(partido === 0, "ninguna nota quedo en otra hoja que su producto");
      comprobar(/TOTAL/.test(despues) && !/TOTAL/.test(antes), "los totales quedan enteros en la ultima hoja");
      await sleep(PAUSA_TICKETS_MS);
    });

    /* ------------------------------------------------------------ */
    await escenario("18. Menu lateral: abre y cierra con ☰, Esc, clic fuera y la X; cada opcion hace lo de siempre", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", false);
      await p.eval("window.__sentinela = 1; window.__notif = 0; window.__confirm = null;" +
        "Notification.requestPermission = function(){ window.__notif++; return Promise.resolve('default'); };" +
        // Los enlaces no navegan: se anota a donde irian (no se ensucia la consola con otras paginas)
        "document.addEventListener('click', function(e){ var a = e.target.closest && e.target.closest('a');" +
        "  if(a){ e.preventDefault(); window.__enlace = a.getAttribute('href'); } }, true); true");
      const m = () => p.eval("(function(){var m=document.getElementById('menuLateral'),b=document.getElementById('menuBtn');" +
        "var r=m.getBoundingClientRect();var cs=getComputedStyle(m);" +
        "return {abierto:m.classList.contains('open'),expandido:b.getAttribute('aria-expanded')," +
        "visibilidad:cs.visibility,izq:Math.round(r.left),ancho:Math.round(r.width)," +
        "foco:document.activeElement.id,focoDentro:m.contains(document.activeElement)};})()");
      const abrir = async () => { await p.clic("#menuBtn"); await sleep(450); };

      // Cerrado de inicio
      let s = await m();
      comprobar(!s.abierto && s.expandido === "false" && s.visibilidad === "hidden",
        "cerrado de inicio: aria-expanded=false y fuera del orden de tabulacion (visibility hidden)");
      comprobar(await p.eval("!document.querySelector('header.barra #horariosBtn, header.barra #impresionBtn, header.barra #notifBtn, header.barra #logoutBtn, header.barra a[href]')"),
        "la barra ya no tiene Horario, Configuracion, Notificaciones, Cerrar sesion, Menu ni Historial");

      // Abrir con ☰
      await abrir();
      s = await m();
      comprobar(s.abierto && s.expandido === "true" && s.visibilidad === "visible", "☰ lo abre y marca aria-expanded=true");
      comprobar(s.izq === 0 && s.ancho === 280, "panel de 280 px pegado a la izquierda: left=" + s.izq + " ancho=" + s.ancho);
      comprobar(s.focoDentro, "el foco entra al menu (activo: " + (await p.eval("document.activeElement.className || document.activeElement.id")) + ")");
      comprobar(await p.eval("(function(){var m=document.getElementById('menuLateral');return m.getAttribute('role')==='dialog'&&m.getAttribute('aria-modal')==='true'&&!!m.getAttribute('aria-label')&&document.getElementById('menuBtn').getAttribute('aria-controls')==='menuLateral';})()"),
        "role=dialog, aria-modal, aria-label y aria-controls en su sitio");
      const texto = await p.eval("Array.from(document.querySelectorAll('#menuLista .menu-item')).map(function(e){return e.querySelector('.menu-txt').firstChild.textContent;}).join('|')");
      comprobar(texto === "Historial|Menú|Horario|Configuración|Notificaciones|Cerrar sesión", "orden de opciones: " + texto);
      comprobar(await p.eval("(function(){var l=document.querySelectorAll('#menuLista .menu-item');var u=l[l.length-1],pen=l[l.length-2];return u.classList.contains('separado')&&u.getBoundingClientRect().top>pen.getBoundingClientRect().bottom+4;})()"),
        "Cerrar sesion va al final, separado");
      comprobar(await p.eval("['horariosBtn','impresionBtn','notifBtn','logoutBtn'].every(function(id){var e=document.getElementById(id);return e&&e.closest('#menuLateral');})"),
        "los IDs originales (horariosBtn, impresionBtn, notifBtn, logoutBtn) viven en el menu");
      comprobar(await p.eval("(function(){var a=document.querySelectorAll('#menuLista a');return a.length===2&&a[0].getAttribute('href')==='historial.html'&&a[1].getAttribute('href')==='menu-admin.html';})()"),
        "enlaces originales: historial.html y menu-admin.html");

      // Cerrar con Esc: el foco vuelve al boton ☰
      await p.tecla("Escape"); await sleep(450);
      s = await m();
      comprobar(!s.abierto && s.expandido === "false" && s.visibilidad === "hidden", "Esc lo cierra");
      comprobar(s.foco === "menuBtn", "el foco vuelve al boton ☰ (activo: " + s.foco + ")");

      // Clic fuera (sobre el fondo oscurecido, lejos del panel)
      await abrir();
      await p.clic(null, 900, 450); await sleep(450);
      s = await m();
      comprobar(!s.abierto && s.expandido === "false", "un clic fuera lo cierra");
      comprobar(s.foco === "menuBtn", "y el foco vuelve a ☰");

      // La X
      await abrir();
      await p.clic("#menuCerrar"); await sleep(450);
      comprobar(!(await m()).abierto, "la X lo cierra");

      // ☰ otra vez, con el menu abierto, lo cierra
      await abrir();
      await p.eval("document.getElementById('menuBtn').click(); true"); await sleep(450);
      comprobar(!(await m()).abierto, "☰ con el menu abierto lo vuelve a cerrar");

      // Tab no se escapa del menu
      await abrir();
      for (let i = 0; i < 8; i++) await p.tecla("Tab");
      comprobar((await m()).focoDentro, "con 8 Tab seguidos el foco sigue dentro del menu");
      await p.tecla("Escape"); await sleep(450);

      // --- Cada opcion dispara su accion original y cierra el menu ---
      await abrir();
      await p.clic("#horariosBtn"); await sleep(450);
      comprobar(await p.eval("document.getElementById('modalHorarios').classList.contains('open')"), "Horario abre el modal de horario");
      comprobar(!(await m()).abierto, "…y el menu se cerro");
      await p.clic("#cancelarHorarios"); await sleep(300);

      await abrir();
      await p.clic("#impresionBtn"); await sleep(450);
      comprobar(await p.eval("document.getElementById('modalImpresion').classList.contains('open')"), "Configuracion abre el modal de impresion");
      comprobar(await p.eval("['impTamano','impModoHoja','impPruebaBtn','impCalibracionBtn'].every(function(id){return !!document.getElementById(id);})"),
        "con tamano del ticket, modo de hoja, ticket de prueba y hoja de calibracion");
      comprobar(!(await m()).abierto, "…y el menu se cerro");
      await p.clic("#impCerrarBtn"); await sleep(300);

      await abrir();
      await p.clic("#notifBtn"); await sleep(300);
      const permiso = await p.eval("Notification.permission");
      comprobar(permiso === "granted" || (await p.eval("window.__notif")) === 1,
        "Notificaciones ejecuta su manejador original (permiso '" + permiso + "', requestPermission llamado " + (await p.eval("window.__notif")) + " vez)");
      const estadoNotif = await p.eval("document.querySelector('#notifBtn .menu-estado').textContent");
      comprobar(/^(Activas|Desactivadas|Bloqueadas)$/.test(estadoNotif), "muestra el estado del permiso: " + estadoNotif);
      comprobar(!(await m()).abierto, "…y el menu se cerro");

      await abrir();
      await p.clic("#menuLista a:nth-of-type(1)"); await sleep(300);
      comprobar(await p.eval("window.__enlace") === "historial.html", "Historial sigue el enlace historial.html");
      comprobar(!(await m()).abierto, "…y el menu se cerro");
      await abrir();
      await p.clic("#menuLista a:nth-of-type(2)"); await sleep(300);
      comprobar(await p.eval("window.__enlace") === "menu-admin.html", "Menu sigue el enlace menu-admin.html");
      comprobar(!(await m()).abierto, "…y el menu se cerro");

      // Cerrar sesion: pide confirmacion; si se cancela el panel sigue
      await p.eval("window.confirm = function(t){ window.__confirm = t; return false; }; true");
      await abrir();
      await p.clic("#logoutBtn"); await sleep(300);
      comprobar(/¿Cerrar sesión\?/.test(await p.eval("window.__confirm || ''")), "Cerrar sesion pide la confirmacion de siempre");
      comprobar(await p.eval("window.__sentinela") === 1 && await p.eval("!document.getElementById('app').hidden"),
        "al cancelar el panel sigue abierto");
      comprobar(!(await m()).abierto, "…y el menu se cerro");
      // Si se confirma: signOut y recarga
      await p.eval("window.confirm = function(){ return true; }; true");
      await abrir();
      await p.clic("#logoutBtn");
      await p.esperar("function(){return window.__sentinela === undefined && document.readyState==='complete';}", 8000, "recarga tras cerrar sesion");
      comprobar(true, "al confirmar, cierra sesion y recarga la pagina");
    });

    /* ------------------------------------------------------------ */
    await escenario("19. Barra superior: cabe en 1280, 768 y 390 px y sus interruptores siguen funcionando", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", false);
      const medir = () => p.eval("(function(){var ids=['menuBtn','conn','switchLocal','switchImpresion','soundBtn'];" +
        "var o={sinDesborde:document.documentElement.scrollWidth<=innerWidth,dentro:true,tops:{},alto:0};" +
        "ids.forEach(function(id){var r=document.getElementById(id).getBoundingClientRect();" +
        "if(!(r.width>0&&r.left>=0&&r.right<=innerWidth+0.5))o.dentro=false;o.tops[id]=Math.round(r.top+r.height/2);});" +
        "o.alto=Math.round(document.querySelector('header.barra').getBoundingClientRect().height);" +
        "o.solapa=(function(){var rs=ids.map(function(id){return document.getElementById(id).getBoundingClientRect();});" +
        "for(var i=0;i<rs.length;i++)for(var j=i+1;j<rs.length;j++){var a=rs[i],b=rs[j];" +
        "if(a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5)return true;}return false;})();" +
        "return o;})()");

      for (const ancho of [1280, 768, 390]) {
        await p.tamano(ancho, 900);
        const r = await medir();
        const cs = Object.values(r.tops); const unaFila = Math.max(...cs) - Math.min(...cs) < 6;
        const mismo = (x, y) => Math.abs(r.tops[x] - r.tops[y]) < 6;
        comprobar(r.dentro && r.sinDesborde && !r.solapa,
          ancho + " px: todo dentro de la pantalla, sin scroll horizontal ni botones encimados (alto de barra " + r.alto + " px)");
        if (ancho >= 768) comprobar(unaFila, ancho + " px: la barra es de una sola fila");
        else comprobar(mismo("switchLocal", "switchImpresion") && r.tops.switchLocal > r.tops.menuBtn + 20 &&
            mismo("menuBtn", "conn") && mismo("menuBtn", "soundBtn"),
          ancho + " px: dos filas ordenadas (menu, estado y sonido arriba; Abierto e Imprimir abajo)");
      }

      // Etiquetas: larga en monitor ancho, corta en el resto, nombre accesible siempre completo
      await p.tamano(1280, 900);
      comprobar(/Imprimir comandas en esta pantalla/.test(await p.eval("document.getElementById('switchImpresion').innerText")),
        "1280 px: el interruptor dice «Imprimir comandas en esta pantalla»");
      const textoImp = () => p.eval("document.getElementById('switchImpresion').innerText.replace(/\\s+/g,' ').trim()");
      await p.tamano(1000, 900);
      const t1000 = await textoImp();
      comprobar(/^.{1,4} Imprimir INACTIVA$/.test(t1000), "1000 px: etiqueta corta, con el estado visible: «" + t1000 + "»");
      await p.tamano(768, 900);
      const t768 = await textoImp();
      comprobar(/^.{1,4} INACTIVA$/.test(t768), "768 px: icono + estado, sin texto: «" + t768 + "»");
      comprobar(await p.eval("document.getElementById('conn').classList.contains('online')") &&
        (await p.eval("document.getElementById('connTxt').getBoundingClientRect().width")) <= 2,
        "768 px: conectado = solo el punto verde");
      await p.tamano(390, 900);
      const t390 = await textoImp();
      comprobar(/^.{1,4} Imprimir INACTIVA$/.test(t390), "390 px: hay sitio en la segunda fila: «" + t390 + "»");
      await p.tamano(768, 900);
      comprobar(await p.eval("document.getElementById('switchImpresion').getAttribute('aria-label')") === "Imprimir comandas en esta pantalla",
        "el nombre accesible del interruptor es siempre el completo");

      // Interruptores con clic real, en celular (el caso mas apretado)
      await p.tamano(390, 900);
      await p.eval("window.confirm = function(){ return true; }; true");
      await p.clic("#switchLocal");
      await p.esperar("function(){return document.getElementById('switchTexto').textContent==='Cerrado';}", 4000, "Cerrado");
      comprobar(await p.eval("document.getElementById('switchLocal').classList.contains('cerrado')"), "Abierto/Cerrado: el clic cierra el local");
      await p.clic("#switchLocal");
      await p.esperar("function(){return document.getElementById('switchTexto').textContent==='Abierto';}", 4000, "Abierto");
      comprobar(true, "y otro clic lo vuelve a abrir");

      await p.clic("#switchImpresion");
      await p.esperar("function(){return document.getElementById('estadoImpresion').textContent==='ACTIVA';}", 4000, "ACTIVA");
      comprobar(await p.eval("document.getElementById('switchImpresion').getAttribute('aria-checked')") === "true" &&
        await p.eval("localStorage.getItem('" + IMPRESION_KEY + "')") === "on", "Imprimir: ACTIVA, aria-checked=true y guardado en este equipo");
      await p.clic("#switchImpresion");
      await p.esperar("function(){return document.getElementById('estadoImpresion').textContent==='INACTIVA';}", 4000, "INACTIVA");
      comprobar(true, "y se apaga con otro clic");

      await p.clic("#soundBtn");
      comprobar(await p.eval("document.getElementById('soundBtn').getAttribute('aria-pressed')") === "false" &&
        await p.eval("localStorage.getItem('" + SONIDO_KEY + "')") === "off", "Sonido: se silencia y se guarda");
      comprobar(await p.eval("getComputedStyle(document.querySelector('#soundBtn .txt')).display") === "none" &&
        await p.eval("document.querySelector('#soundBtn .ico').textContent") === "🔇", "en celular el boton de sonido es solo icono (🔇)");
      await p.clic("#soundBtn");
      comprobar(await p.eval("localStorage.getItem('" + SONIDO_KEY + "')") === "on", "y se reactiva");

      // En vivo: punto en celular mientras todo va bien; la palabra aparece cuando se pierde
      comprobar(await p.eval("document.getElementById('conn').classList.contains('online')") &&
        (await p.eval("document.getElementById('connTxt').getBoundingClientRect().width")) <= 2,
        "390 px: conectado = solo el punto verde (el texto «En vivo» queda para lectores de pantalla)");
      comprobar(await p.eval("getComputedStyle(document.querySelector('#conn .dot')).backgroundColor") === "rgb(127, 168, 85)",
        "…y el punto es verde");
      await p.eval("window.__mock.canal('closed'); window.dispatchEvent(new Event('offline')); true");
      await p.esperar("function(){return document.getElementById('connTxt').textContent==='Desconectado';}", 5000, "Desconectado");
      comprobar(await p.eval("getComputedStyle(document.querySelector('#conn .dot')).backgroundColor") === "rgb(225, 74, 66)" &&
        await p.eval("document.getElementById('bannerCaido').classList.contains('visible')") &&
        (await p.eval("document.getElementById('bannerCaido').getBoundingClientRect().height")) > 30,
        "390 px: al perder la conexion el punto se pone rojo y sale el banner «SIN CONEXIÓN»");
      const r2 = await medir();
      comprobar(r2.dentro && r2.sinDesborde && !r2.solapa, "390 px: y la barra sigue cabiendo");
      // Tablet, con la peor combinacion: sin conexion + WhatsApp caido. El
      // nombre del restaurante y la fecha deben verse enteros.
      await p.tamano(768, 900);
      await p.eval("pintarSaludNotificaciones({ ultimo_ok: false, fallos_seguidos: 1, ultimo_error: 'x' }); true");
      const r3 = await medir();
      comprobar(r3.dentro && r3.sinDesborde && !r3.solapa && r3.alto < 80, "768 px: sin conexion y con WhatsApp caido la barra sigue en una fila y cabe");
      comprobar(await p.eval("(function(){var e=document.querySelector('.brand strong'),f=document.getElementById('fechaHoy');" +
        "return e.scrollWidth<=e.clientWidth && f.scrollWidth<=f.clientWidth;})()"),
        "768 px: el nombre y la fecha no se truncan (con la fuente real; con la de respaldo, mas ancha, puede variar)");
      await p.eval("pintarSaludNotificaciones({ ultimo_ok: true, fallos_seguidos: 0 }); true");
      await p.tamano(390, 900);
      await p.eval("window.__mock.canal('joined'); window.dispatchEvent(new Event('online')); true");
      await p.esperar("function(){return document.getElementById('connTxt').textContent==='En vivo';}", 8000, "En vivo otra vez");
      comprobar(true, "al volver la conexion vuelve «En vivo»");
    });

    /* ------------------------------------------------------------ */
    await escenario("20. Aviso de WhatsApp: icono pequeno que solo sale si falla, con el texto completo", async () => {
      await admin.reset([]);
      const p = await abrirPanel("A", false);
      for (const ancho of [1280, 390]) {
        await p.tamano(ancho, 900);
        await p.eval("pintarSaludNotificaciones({ ultimo_ok: true, fallos_seguidos: 0 }); true");
        comprobar(await p.eval("getComputedStyle(document.getElementById('avisoWhatsapp')).display") === "none",
          ancho + " px: con WhatsApp bien, el icono no aparece");
        await p.eval("pintarSaludNotificaciones({ ultimo_ok: false, fallos_seguidos: 3, ultimo_intento: new Date().toISOString(), ultimo_error: 'HTTP 500 prueba' }); true");
        const w = await p.eval("document.getElementById('avisoWhatsapp').getBoundingClientRect().width");
        comprobar(w > 0 && w <= 40, ancho + " px: con WhatsApp caido aparece un icono pequeno (" + Math.round(w) + " px)");
        const titulo = await p.eval("document.getElementById('avisoWhatsapp').title");
        comprobar(/WhatsApp automático no está funcionando/.test(titulo) && /HTTP 500 prueba/.test(titulo) && /3 fallos seguidos/.test(titulo) && /SI están llegando/.test(titulo),
          "tooltip con el texto completo y el motivo");
        comprobar(await p.eval("document.getElementById('avisoWhatsapp').getAttribute('aria-label')") === titulo, "mismo texto como nombre accesible");

        // Tocarlo muestra el recuadro; Esc y clic fuera lo cierran
        await p.clic("#avisoWhatsapp");
        comprobar(await p.eval("!document.getElementById('avisoWhatsappDetalle').hidden") &&
          /HTTP 500 prueba/.test(await p.eval("document.getElementById('avisoWhatsappDetalle').textContent")) &&
          await p.eval("document.getElementById('avisoWhatsapp').getAttribute('aria-expanded')") === "true",
          ancho + " px: al tocarlo se ve el texto completo");
        const caja = await p.eval("(function(){var r=document.getElementById('avisoWhatsappDetalle').getBoundingClientRect();return {l:r.left,r:r.right};})()");
        comprobar(caja.l >= 0 && caja.r <= ancho, "el recuadro cabe en la pantalla");
        await p.tecla("Escape");
        comprobar(await p.eval("document.getElementById('avisoWhatsappDetalle').hidden"), "Esc lo cierra");
        await p.clic("#avisoWhatsapp");
        await p.clic(null, 40, 600);
        comprobar(await p.eval("document.getElementById('avisoWhatsappDetalle').hidden"), "un clic fuera lo cierra");
        await p.eval("pintarSaludNotificaciones({ ultimo_ok: true, fallos_seguidos: 0 }); true");
      }
    });

    /* ------------------------------------------------------------ */
    await escenario("21. Numero de pedido: se ve pedidos.numero (no el id) en el tablero, el ticket, la reimpresion y los avisos", async () => {
      // dos restaurantes comparten la tabla: el id es 4521 pero para esta cocina es su pedido #7
      const raro = pedido(4521, { numero: 7, cliente_nombre: "Numero Distinto" });
      await admin.reset([]);
      const p = await abrirPanel("A", true);
      await admin.evento(raro);
      await p.esperar("function(){return (window.__impresos||[]).length>=1;}", 10000, "ticket impreso");
      const tablero = await p.eval("document.querySelector('.pedido .pedido-num').textContent");
      comprobar(tablero === "#007", "el tablero muestra #007 (el numero), no #4521: " + tablero);
      const t1 = (await p.impresos())[0].texto;
      comprobar(/#007/.test(t1) && !/#4521/.test(t1) && !/#021/.test(t1), "el ticket impreso lleva #007 y no el id");
      await sleep(PAUSA_TICKETS_MS);
      await p.eval("document.querySelector('[data-reimprimir=\"4521\"]').click(); true");
      await p.esperar("function(){return (window.__impresos||[]).length>=2;}", 10000, "reimpresion");
      const t2 = (await p.impresos())[1].texto;
      comprobar(/#007/.test(t2) && /REIMPRESI/.test(t2) && !/#4521/.test(t2), "la reimpresion tambien lleva #007");
      comprobar(await p.eval("numeroPedido({ id: 4521, numero: 7 })") === "#007" && await p.eval("numeroPedido({ id: 12 })") === "#012", "numeroPedido(): usa numero y, sin el, el id");
      comprobar(await p.eval("numeroPedido(pedidoPorId(4521))") === "#007", "los avisos del cronometro buscan el numero del pedido en el tablero");
      // el aviso de pedido nuevo (barra de avisos) usa el numero
      await p.eval("avisar(\"Nuevo pedido \" + numeroPedido(pedidos[0])); true");
      comprobar(!(await p.eval("document.body.innerText")).includes("#4521"), "en ningun lugar del panel aparece el id #4521");
      comprobar(p.errores.length === 0, "sin errores de JavaScript: " + p.errores.join(" | "));
    });

    /* ------------------------------------------------------------ */
    if (process.env.TICKETS) {
      fs.mkdirSync(process.env.TICKETS, { recursive: true });
      await escenario("Guardando los documentos de ticket que se imprimieron", async () => {
        await admin.reset([]);
        const p = await abrirPanel("A", true);
        const casos = {
          "01-normal": pedido(12, {
            cliente_nombre: "Juan Pérez", direccion: "Calle 10 # 5-20", barrio: "Caobos",
            indicaciones: "Casa blanca, portón verde", subtotal: 56000, total: 61000, costo_domicilio: 5000,
            wompi_metodo_pago: "NEQUI",
            items: [
              { id: "a", nombre: "Tacos de Birria", cantidad: 3, precio: 18000 },
              { id: "b", nombre: "Agua de Jamaica", cantidad: 2, precio: 4000 }
            ]
          }),
          "02-doce-items-notas-largas": pedido(13, {
            cliente_nombre: "Luisa Fernanda Rodríguez", direccion: "Avenida 5 # 12-30 Apto 301",
            barrio: "Centro", indicaciones: "Llamar al llegar. Dejar con el portero si no contesto.",
            subtotal: 143000, total: 143000, wompi_metodo_pago: "CARD",
            items: Array.from({ length: 12 }, (_, i) => ({
              id: "i" + i, nombre: ["Tacos de Birria", "Doriloco Especial", "Quesabirria", "Agua de Horchata",
                "Burrito Mixto", "Nachos con Queso", "Tostada de Tinga", "Elote Preparado", "Limonada de Coco",
                "Orden de Consomé", "Flan Casero", "Tres Leches"][i],
              cantidad: (i % 3) + 1, precio: 9000 + i * 500,
              nota: i % 2 ? "Sin cebolla ni cilantro, salsa verde aparte, bien doradito y con limón extra para la mesa" : ""
            }))
          }),
          "03-nombre-y-direccion-largos": pedido(14, {
            cliente_nombre: "María Fernanda de los Ángeles Quintero-Villamizar y Contreras de Santander",
            direccion: "Conjunto Residencial Torres del Parque Etapa Tres Torre Siete Apartamento 1502 Interior Doce Avenida Libertadores Diagonal Santander",
            barrio: "Urbanización Ciudad Jardín La Riviera Segunda Etapa", indicaciones:
              "Supercalifragilisticoespialidosoextraordinariamentelargapalabrasinespacios para probar el salto",
            subtotal: 18000, total: 18000
          }),
          "04-enie-y-tildes": pedido(15, {
            cliente_nombre: "Peña Muñoz, Ñandú Ángel", direccion: "Carrera 7ª # 3-45, Piñal",
            barrio: "El Páramo", indicaciones: "Señor Núñez: más picante, sin piña, añadir jalapeño. ¿Cuánto demora?",
            items: [{ id: "a", nombre: "Pastor con piña y jalapeño — súper", cantidad: 2, precio: 9000 }],
            subtotal: 18000, total: 18000
          }),
          "05-etiquetas-html-y-comillas": pedido(16, {
            cliente_nombre: '<b>"Hacker"</b> <script>alert(1)</script>',
            direccion: '<img src=x onerror=alert(1)> Calle "5" & 6', barrio: "<i>Centro</i>",
            indicaciones: "</div><h1>GRANDE</h1> 'comillas' \"dobles\" &amp; 🌮",
            items: [{ id: "a", nombre: '<a href="x">Taco</a> "grande"', cantidad: 1, precio: 9000 }],
            subtotal: 9000, total: 9000
          })
        };
        let n = 0;
        for (const [nombre, ped] of Object.entries(casos)) {
          await admin.evento(ped);
          n++;
          await p.esperar("function(){return (window.__impresos||[]).length>=" + n + ";}", 15000, nombre);
        }
        const htmls = await p.htmlImpresos();
        // Reimpresion del primero y ticket de prueba
        await p.eval("document.querySelector('[data-reimprimir=\"12\"]').click(); true");
        await p.esperar("function(){return (window.__impresos||[]).length>=" + (n + 1) + ";}", 15000, "reimpresion");
        await p.eval("document.getElementById('impPruebaBtn').click(); true");
        await p.esperar("function(){return (window.__impresos||[]).length>=" + (n + 2) + ";}", 15000, "prueba");
        const todos = await p.htmlImpresos();
        const nombres = Object.keys(casos).concat(["06-reimpresion", "07-ticket-de-prueba"]);
        todos.forEach((h, i) => fs.writeFileSync(path.join(process.env.TICKETS, nombres[i] + ".html"), h));
        comprobar(todos.length === 7, "guardados " + todos.length + " documentos en " + process.env.TICKETS);
      });
    }

    /* ------------------------------------------------------------ */
    if (process.env.CAPTURAS) {
      fs.mkdirSync(process.env.CAPTURAS, { recursive: true });
      await escenario("Capturas del tablero a 360, 390, 768 y 1280 px", async () => {
        const datos = [
          pedido(801, { impreso_en: new Date().toISOString(), indicaciones: "Sin cebolla", costo_domicilio: 5000, subtotal: 19000, total: 24000, distancia_km: 2.4 }),
          pedido(802, { estado: "en_preparacion", impreso_en: new Date().toISOString(), tipo_pedido: "llevar" }),
          pedido(803, { estado: "listo", impreso_en: new Date().toISOString() }),
          pedido(804, { estado: "entregado", impreso_en: new Date().toISOString() })
        ];
        const paginas = process.env.PANEL_BASE ? ["panel", "panel-base"] : ["panel"];
        for (const nombre of paginas) {
          await admin.reset(datos);
          const pg = await nuevaPagina(nombre);
          await pg.ir(URL + "/" + nombre + ".html");
          await pg.esperar("function(){return !document.getElementById('app').hidden && document.querySelectorAll('.pedido').length>0 && document.getElementById('connTxt').textContent==='En vivo';}", 10000, "tablero " + nombre);
          await sleep(500);
          // Para comparar: se congela el parpadeo y los cronometros
          await pg.eval("var s=document.createElement('style');s.textContent='*{animation:none!important;transition:none!important}';document.head.appendChild(s);document.querySelectorAll('.cronometro').forEach(function(c){c.textContent='T'});true");
          console.log("   fuentes (" + nombre + "):", await pg.eval(
            "JSON.stringify([...document.fonts].map(f=>f.family+':'+f.status)) + ' body=' + getComputedStyle(document.body).fontFamily"));
          for (const ancho of [360, 390, 768, 1280]) {
            await pg.captura(path.join(process.env.CAPTURAS, nombre + "-" + ancho + ".png"), ancho, 900);
          }
          comprobar(pg.errores.length === 0, nombre + ": sin errores de consola" +
            (pg.errores.length ? " -> " + pg.errores.slice(0, 3).join(" | ") : ""));
        }
      });

      // Pantalla de cocina con avisos: impresion activa, SQL sin correr y
      // mas de 5 pendientes.
      await escenario("Capturas de los avisos de impresion (pantalla de cocina)", async () => {
        const mucho = [];
        for (let i = 0; i < 7; i++) mucho.push(pedido(900 + i, { impreso_en: null }));
        await admin.reset(mucho, { columnas: false });
        const pg = await abrirPanel("avisos", true);
        await pg.esperar("function(){return !document.getElementById('avisoImpresion').hidden;}", 8000, "aviso");
        await sleep(500);
        await pg.eval("var s=document.createElement('style');s.textContent='*{animation:none!important;transition:none!important}';document.head.appendChild(s);true");
        for (const ancho of [390, 1280]) {
          await pg.captura(path.join(process.env.CAPTURAS, "avisos-" + ancho + ".png"), ancho, 900);
        }
        await pg.eval("document.getElementById('impresionBtn').click(); true");
        await sleep(300);
        await pg.captura(path.join(process.env.CAPTURAS, "modal-390.png"), 390, 900);
        comprobar(pg.errores.length === 0, "avisos: sin errores de consola");
      });

      // Barra superior y menu lateral, tal como los ve la cocina: impresion
      // ACTIVA, en 1280 (monitor), 768 (tablet) y 390 px (celular).
      await escenario("Capturas de la barra superior y del menu lateral a 1280, 768 y 390 px", async () => {
        const iso = new Date().toISOString();
        await admin.reset([
          pedido(811, { impreso_en: iso, indicaciones: "Sin cebolla", costo_domicilio: 5000, subtotal: 19000, total: 24000 }),
          pedido(812, { estado: "en_preparacion", impreso_en: iso, tipo_pedido: "llevar" }),
          pedido(813, { estado: "listo", impreso_en: iso })
        ]);
        const pg = await abrirPanel("barra", true);
        await pg.esperar("function(){return document.querySelectorAll('.pedido').length>0;}", 8000, "pedidos");
        await sleep(400);
        await pg.eval("var s=document.createElement('style');s.textContent='*{animation:none!important;transition:none!important}';document.head.appendChild(s);document.querySelectorAll('.cronometro').forEach(function(c){c.textContent='T'});true");
        const aqui = (n) => path.join(process.env.CAPTURAS, n);

        for (const ancho of [1280, 768, 390]) {
          await pg.tamano(ancho, 900);
          await pg.captura(aqui("barra-" + ancho + "-menu-cerrado.png"), ancho, 900);
          await pg.eval("document.getElementById('menuBtn').click(); document.activeElement.blur(); true");
          await pg.captura(aqui("barra-" + ancho + "-menu-abierto.png"), ancho, 900);
          await pg.eval("document.getElementById('menuBtn').click(); document.activeElement.blur(); true");
        }

        // Con todo lo que puede salir mal a la vez: WhatsApp caido, sin conexion, Cerrado
        await pg.eval("pintarSaludNotificaciones({ ultimo_ok: false, fallos_seguidos: 3, ultimo_intento: new Date().toISOString(), ultimo_error: 'HTTP 500' });" +
          "window.__mock.canal('closed'); window.dispatchEvent(new Event('offline')); true");
        await pg.esperar("function(){return document.getElementById('connTxt').textContent==='Desconectado';}", 5000, "Desconectado");
        await pg.eval("document.getElementById('avisoWhatsapp').click(); true");
        for (const ancho of [1280, 768, 390]) {
          await pg.captura(aqui("barra-" + ancho + "-con-avisos.png"), ancho, 900);
        }
        comprobar(pg.errores.length === 0, "barra y menu: sin errores de consola" +
          (pg.errores.length ? " -> " + pg.errores.slice(0, 3).join(" | ") : ""));
      });
    }

    /* ------------------------------------------------------------ */
    console.log("\n▶ Errores de consola en todas las paginas abiertas");
    const errores = paginasAbiertas.flatMap(pg => pg.errores.map(e => pg.nombre + ": " + e));
    comprobar(errores.length === 0, paginasAbiertas.length + " paginas abiertas, " + errores.length + " errores de consola" +
      (errores.length ? "\n      " + errores.slice(0, 8).join("\n      ") : ""));
  } finally {
    try { await cdp.send("Browser.close"); } catch (e) { /* ya cerrado */ }
    chrome.kill();
    servidor.close();
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* bloqueado por Windows */ }
  }

  const malos = resultados.filter(r => !r.ok);
  console.log("\n=============================================");
  console.log(resultados.length - malos.length + " comprobaciones correctas, " + malos.length + " fallidas.");
  if (malos.length) malos.forEach(m => console.log("  ❌ " + m.texto));
  process.exit(malos.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
