/* =============================================================
   PEDIDOS LARGOS: PARTICION EN HOJAS DE 297 MM (modo D)

   Dibuja un pedido de ~30 productos con el ticket-comanda.js REAL, en
   Chrome sin interfaz, lo imprime a PDF y comprueba, leyendo el texto de
   cada hoja con pdftotext:

     * que el PDF tenga tantas hojas como calculo el ticket (y todas de
       80 x 297 mm, sin una hoja de mas);
     * que ningun producto se corte: el nombre de cada producto y TODAS las
       lineas de su nota estan en la misma hoja, y cada una sale una vez;
     * que cada hoja despues de la primera empiece con
       "#<numero> · continuación", y la primera no la lleve;
     * que el encabezado (franja, numero, cliente) este en la 1a hoja y el
       bloque de totales y el pie, enteros, en la ultima;
     * lo mismo para un barrido de 20 a 60 productos, que pasa por el borde
       en que el pedido deja de caber en una hoja y por el de dos a tres.

   Deja el PDF de ejemplo del caso de 30 productos.

   USO:   node pruebas/impresion/ticket-largo.js
   Variables opcionales:
     CHROME=C:\ruta\chrome.exe       navegador a usar
     PDFTOTEXT=C:\ruta\pdftotext.exe lector de texto de PDF (poppler)
     SALIDA=C:\ruta\carpeta          donde dejar el PDF de ejemplo (por
                                     defecto, esta misma carpeta)

   OJO: valida el CSS y el calculo de corte en el motor de Chrome, NO la
   impresora ni su driver (ver docs/impresion-cocina.md, seccion 5.5).
============================================================= */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const url = require("node:url");

const CHROME = process.env.CHROME || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find(p => fs.existsSync(p));

const PDFTOTEXT = process.env.PDFTOTEXT || [
  "pdftotext",
  "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe"
].find(p => spawnSync(p, ["-v"]).status !== null && !spawnSync(p, ["-v"]).error);

const SALIDA = process.env.SALIDA || __dirname;
const FUENTE = fs.readFileSync(path.join(__dirname, "..", "..", "ticket-comanda.js"), "utf8");
const PUERTO_CDP = 9446;
const MM_POR_PT = 25.4 / 72;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ID_PEDIDO = 87;
const CONTINUACION = "#087 · continuación";

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pend = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { ok, mal } = this.pend.get(m.id);
        this.pend.delete(m.id);
        if (m.error) mal(new Error(m.error.message)); else ok(m.result);
      }
    };
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((ok, mal) => this.pend.set(id, { ok, mal }));
  }
}

/* Pedido de n productos. Cada producto trae un nombre con su numero y, uno
   de cada tres, una nota de DOS lineas con el mismo numero: asi se sabe, por
   el texto, si el nombre y su nota quedaron en la misma hoja. */
function pedidoLargo(n) {
  const items = [];
  for (let i = 1; i <= n; i++) {
    const k = String(i).padStart(2, "0");
    const it = { id: "p" + k, nombre: "Taco numero " + k, cantidad: 1 + (i % 3), precio: 9000 };
    if (i % 3 === 0) it.nota = "Nota " + k + " sin cebolla\nNota " + k + " salsa aparte";
    items.push(it);
  }
  const subtotal = items.reduce((s, it) => s + it.cantidad * it.precio, 0);
  return {
    id: ID_PEDIDO, estado: "nuevo", estado_pago: "aprobado", tipo_pedido: "domicilio",
    cliente_nombre: "Maria Fernanda Gomez", cliente_telefono: "3001234567",
    direccion: "Avenida 5 # 12-34 Torre 2 Apto 801", barrio: "Caobos",
    indicaciones: "Evento de oficina. Entregar en recepcion y pedir firma.",
    items, subtotal, costo_domicilio: 5000, total: subtotal + 5000, wompi_metodo_pago: "NEQUI",
    pagado_en: "2026-10-11T23:30:00Z", creado_en: "2026-10-11T23:30:00Z"
  };
}

/* Dibuja como imprimir(): plantilla + escala + pintar + ajustarHoja en modo D */
function expresion(pedido) {
  return "(function(){\n" + FUENTE + "\n" +
    "var T = window.TicketComanda;\n" +
    "document.open(); document.write(T.PLANTILLA); document.close();\n" +
    "T.aplicarEscala(document, 'pequeno');\n" +
    "T.pintar(document, T.preparar(" + JSON.stringify(pedido) + ", {}));\n" +
    "var plan = T.ajustarHoja(document, 'D');\n" +
    "return { html: '<!DOCTYPE html>' + document.documentElement.outerHTML,\n" +
    "         hojas: plan.hojas, cortes: plan.cortes, alto: plan.altoMm,\n" +
    "         continuaciones: document.querySelectorAll('.continuacion').length };\n" +
    "})()";
}

function imprimirAPdf(html, pdf, perfil) {
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + perfil,
    "--print-to-pdf=" + pdf, url.pathToFileURL(html).href];
  const r = spawnSync(CHROME, args, { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error("Chrome no genero " + pdf + ": " + (r.stderr || ""));
}

function infoPdf(pdf) {
  const s = fs.readFileSync(pdf).toString("latin1");
  const cajas = [...s.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
    .map(m => ({ ancho: (m[3] - m[1]) * MM_POR_PT, alto: (m[4] - m[2]) * MM_POR_PT }));
  const paginas = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  return { paginas, cajas };
}

function textoDeHoja(pdf, n) {
  const r = spawnSync(PDFTOTEXT, ["-enc", "UTF-8", "-f", String(n), "-l", String(n), pdf, "-"],
    { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error("pdftotext fallo en la hoja " + n + ": " + (r.stderr || ""));
  return r.stdout.replace(/\f/g, "");
}

/* Comprueba un PDF. Devuelve la lista de problemas (vacia = bien). */
function revisar(n, doc, pdf) {
  const mal = [];
  const info = infoPdf(pdf);
  if (info.paginas !== doc.hojas) mal.push("el PDF tiene " + info.paginas + " hojas y el ticket calculo " + doc.hojas);
  if (doc.continuaciones !== doc.hojas - 1) mal.push("lineas de continuacion: " + doc.continuaciones + " (esperadas " + (doc.hojas - 1) + ")");
  info.cajas.forEach((c, i) => {
    if (Math.abs(c.ancho - 80) > 0.5 || Math.abs(c.alto - 297) > 0.5) {
      mal.push("hoja " + (i + 1) + " mide " + c.ancho.toFixed(1) + " x " + c.alto.toFixed(1) + " mm");
    }
  });

  const hojas = [];
  for (let h = 1; h <= info.paginas; h++) hojas.push(textoDeHoja(pdf, h));

  /* Cada producto y cada linea de su nota: una sola vez, y en la hoja de su producto */
  const hojaDe = (re) => {
    const donde = [];
    hojas.forEach((t, i) => { const m = t.match(re); if (m) m.forEach(() => donde.push(i)); });
    return donde;
  };
  for (let i = 1; i <= n; i++) {
    const k = String(i).padStart(2, "0");
    const nombre = hojaDe(new RegExp("Taco numero " + k + "(?!\\d)", "g"));
    if (nombre.length !== 1) { mal.push("producto " + k + " sale " + nombre.length + " veces"); continue; }
    if (i % 3 === 0) {
      const l1 = hojaDe(new RegExp("Nota " + k + " sin cebolla", "g"));
      const l2 = hojaDe(new RegExp("Nota " + k + " salsa aparte", "g"));
      if (l1.length !== 1 || l2.length !== 1) mal.push("nota " + k + ": " + l1.length + " y " + l2.length + " apariciones");
      else if (l1[0] !== nombre[0] || l2[0] !== nombre[0]) {
        mal.push("producto " + k + " partido: nombre en la hoja " + (nombre[0] + 1) +
          ", nota en la " + (l1[0] + 1) + "/" + (l2[0] + 1));
      }
    }
  }

  /* Linea de continuacion: al principio de cada hoja >= 2, nunca en la 1a */
  hojas.forEach((t, i) => {
    const primera = t.split("\n").map(l => l.trim()).find(l => l !== "") || "";
    if (i === 0) {
      if (t.includes("continuación")) mal.push("la hoja 1 lleva la linea de continuacion");
      if (!/DOMICILIO/.test(t) || !t.includes("#087") || !t.includes("Maria Fernanda")) {
        mal.push("la hoja 1 no trae el encabezado (franja, numero, cliente)");
      }
    } else if (primera !== CONTINUACION) {
      mal.push("la hoja " + (i + 1) + " arranca con \"" + primera + "\" y no con \"" + CONTINUACION + "\"");
    }
  });

  /* Totales y pie: enteros, una vez, en la ultima hoja */
  const ultima = hojas[hojas.length - 1] || "";
  if ((ultima.match(/TOTAL/g) || []).length !== 1) mal.push("TOTAL no esta una sola vez en la ultima hoja");
  if (!/Pago: Nequi/.test(ultima) || !/LOS TAQUEIROS/.test(ultima)) mal.push("faltan el pago o el pie en la ultima hoja");
  hojas.slice(0, -1).forEach((t, i) => {
    if (/TOTAL|LOS TAQUEIROS/.test(t)) mal.push("totales o pie fuera de la ultima hoja (hoja " + (i + 1) + ")");
  });

  return mal;
}

(async () => {
  if (!CHROME) { console.error("No encuentro Chrome. Define CHROME=ruta\\chrome.exe"); process.exit(2); }
  if (!PDFTOTEXT) { console.error("No encuentro pdftotext (poppler). Define PDFTOTEXT=ruta\\pdftotext.exe"); process.exit(2); }
  fs.mkdirSync(SALIDA, { recursive: true });
  const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), "taq-largo-"));

  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PUERTO_CDP,
    "--user-data-dir=" + path.join(trabajo, "perfil-web"), "--no-first-run", "--disable-gpu", "about:blank"],
    { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch("http://127.0.0.1:" + PUERTO_CDP + "/json/version")).json(); }
    catch (e) { await sleep(150); }
  }
  if (!version) { chrome.kill(); console.error("Chrome no abrio el puerto de depuracion"); process.exit(2); }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, mal) => { ws.onopen = ok; ws.onerror = mal; });
  const cdp = new Cdp(ws);

  const filas = [];
  let fallos = 0;
  try {
    const casos = [];
    for (let n = 20; n <= 60; n += (n < 40 ? 1 : 5)) casos.push(n);
    for (const n of casos) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Runtime.enable", {}, sessionId);
      const r = await cdp.send("Runtime.evaluate",
        { expression: expresion(pedidoLargo(n)), returnByValue: true }, sessionId);
      await cdp.send("Target.closeTarget", { targetId });
      if (r.exceptionDetails) throw new Error("n=" + n + ": " + (r.exceptionDetails.exception.description || r.exceptionDetails.text));
      const doc = r.result.value;

      const html = path.join(trabajo, "largo-" + n + ".html");
      const pdf = path.join(trabajo, "largo-" + n + ".pdf");
      fs.writeFileSync(html, doc.html);
      imprimirAPdf(html, pdf, path.join(trabajo, "perfil-pdf"));

      const mal = revisar(n, doc, pdf);
      if (mal.length) fallos++;
      filas.push({ productos: n, hojas: doc.hojas, cortes_antes_de: doc.cortes.join(",") || "-",
        resultado: mal.length ? "FALLA" : "OK" });
      mal.forEach(m => console.log("  ! " + n + " productos: " + m));

      if (n === 30) fs.copyFileSync(pdf, path.join(SALIDA, "ticket-pedido-largo-pequeno.pdf"));
    }
  } finally {
    try { await cdp.send("Browser.close"); } catch (e) { /* ya cerrado */ }
    chrome.kill();
    try { fs.rmSync(trabajo, { recursive: true, force: true }); } catch (e) { /* bloqueado por Windows */ }
  }

  console.table(filas);
  const treinta = filas.find(f => f.productos === 30);
  if (!treinta || treinta.hojas < 2) { fallos++; console.log("  ! el caso de 30 productos deberia ocupar mas de una hoja"); }
  console.log("PDF de ejemplo: " + path.join(SALIDA, "ticket-pedido-largo-pequeno.pdf"));
  console.log(fallos ? fallos + " casos con problemas" : "Todo correcto: ningun producto partido, continuacion en cada hoja siguiente.");
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
