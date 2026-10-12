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
        if (url.startsWith("http://127.0.0.1:" + PUERTO_WEB)) {
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
}

/* ---------------- Datos ---------------- */
let relojBase = Date.now() - 20 * 60e3;
function pedido(id, extra) {
  relojBase += 1000;
  const t = new Date(relojBase).toISOString();
  return {
    id, referencia: "TAQ-" + id, estado: "nuevo", estado_pago: "aprobado",
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
const resultados = [];
function comprobar(ok, texto) {
  resultados.push({ ok, texto });
  console.log("   " + (ok ? "✅" : "❌") + " " + texto);
}
let alIniciarEscenario = async () => {};
async function escenario(nombre, fn) {
  // SOLO_CAPTURAS=1 salta lo demas (para iterar rapido sobre el diseno)
  if (process.env.SOLO_CAPTURAS && !/^Capturas/.test(nombre)) return;
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
      urls: ["https://fonts.googleapis.com/*", "https://fonts.gstatic.com/*", "https://*.jsdelivr.net/*",
             "https://unpkg.com/*", "https://checkout.wompi.co/*"]
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

  const IMPRESION_KEY = "taqueiros-panel-imprimir-v1";

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
      const KEY = "taqueiros-panel-ticket-tamano-v1";

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
    await escenario("16. Modo de hoja: selector, por equipo, y lo usan prueba, reimpresion y calibracion", async () => {
      const original = new Date(Date.now() - 600000).toISOString();
      await admin.reset([pedido(720, { impreso_en: original })]);
      const p = await abrirPanel("A", false);
      const KEY = "taqueiros-panel-ticket-hoja-v1";
      const reglaDe = async (i) => (await p.impresos())[i].pagina || "";
      const elegir = (m) => p.eval("(function(){var s=document.getElementById('impModoHoja');s.value='" + m +
        "';s.dispatchEvent(new Event('change'));})(); true");
      let n = 0;
      const siguiente = async (que) => {
        n++;
        await p.esperar("function(){return (window.__impresos||[]).length>=" + n + ";}", 10000, que);
        await sleep(PAUSA_TICKETS_MS + 300);
      };

      // Por defecto A, y la prueba sale con alto medido (el de siempre)
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impModoHoja').value") === "A", "el selector arranca en A");
      comprobar(await p.eval("localStorage.getItem('" + KEY + "')") === null, "sin nada guardado hasta que se elige");
      await p.eval("document.getElementById('impPruebaBtn').click(); true");
      await siguiente("prueba en A");
      comprobar(/^@page\{size:80mm \d+mm;margin:0;\}html,body\{height:\d+mm;overflow:hidden;\}$/.test(await reglaDe(0)),
        "A: alto medido con html/body fijos: " + (await reglaDe(0)));

      // B: automatico
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await elegir("B");
      comprobar(await p.eval("localStorage.getItem('" + KEY + "')") === "B", "se guardo 'B' en este equipo");
      await p.eval("document.querySelector('[data-reimprimir=\"720\"]').click(); true");
      await siguiente("reimpresion en B");
      comprobar(/^@page\{size:80mm auto;margin:0;\}/.test(await reglaDe(1)), "B en la reimpresion: " + (await reglaDe(1)));

      // C: medido + 1 mm. El alto de C es el de A + 1 para el mismo contenido
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await elegir("C");
      await p.eval("document.getElementById('impPruebaBtn').click(); true");
      await siguiente("prueba en C");
      const alto = (r) => Number((r.match(/size:80mm (\d+)mm/) || [])[1]);
      comprobar(/html,body\{height:auto;overflow:hidden;\}/.test(await reglaDe(2)), "C: html/body en auto y overflow hidden");
      comprobar(alto(await reglaDe(2)) === alto(await reglaDe(0)) + 1,
        "C pide " + alto(await reglaDe(2)) + " mm = A (" + alto(await reglaDe(0)) + ") + 1");

      // D: hoja fija de 297 mm; y la hoja de calibracion sale con el mismo modo
      await p.eval("document.getElementById('impresionBtn').click(); true");
      await elegir("D");
      await p.eval("document.getElementById('impCalibracionBtn').click(); true");
      await siguiente("calibracion en D");
      const cal = (await p.impresos())[3];
      comprobar(/^@page\{size:80mm 297mm;margin:0;\}/.test(cal.pagina || ""), "D: @page de 80 x 297 mm");
      comprobar(cal.enMarco, "la calibracion se imprimio desde el iframe oculto, igual que una comanda");
      const t = cal.texto.replace(new RegExp(String.fromCharCode(0xA0), "g"), " ").replace(/\s+/g, " ");
      comprobar(/MODO: D · ALTO SOLICITADO: 297 mm · ANCHO: 80 mm/.test(t), "texto de calibracion: " + t.slice(0, 70));
      const geo = await p.eval("window.__impresos.length"); // la geometria se mide en el HTML guardado
      const htmls = await p.htmlImpresos();
      const h = htmls[3];
      comprobar(/class="cal-marco"[^>]*height:\s*297mm/.test(h), "marco del tamano de la pagina solicitada (297 mm)");
      comprobar((h.match(/class="cal-marca/g) || []).length === 29, "regla con marcas cada 10 mm hasta 290 mm");
      comprobar((h.match(/class="cal-num"/g) || []).length === 5, "un numero cada 50 mm (50 a 250)");
      comprobar((h.match(/class="cal-borde"/g) || []).length === 2, "linea gruesa arriba y abajo");
      comprobar(geo >= 4, "se imprimieron 4 documentos");

      // El modo se conserva al recargar; un valor corrupto vuelve a A
      await recargar(p);
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impModoHoja').value") === "D", "tras recargar el selector sigue en D");
      await p.eval("localStorage.setItem('" + KEY + "','Z'); true");
      await recargar(p);
      await p.eval("document.getElementById('impresionBtn').click(); true");
      comprobar(await p.eval("document.getElementById('impModoHoja').value") === "A", "un valor corrupto vuelve a A");
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
