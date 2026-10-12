/* =============================================================
   PDFs DE EJEMPLO DEL TICKET DE COMANDA (3 tamanos de texto)

   Dibuja el ticket con el ticket-comanda.js REAL, en Chrome sin
   interfaz, y lo imprime a PDF con el pipeline de impresion de Chrome
   (con su encabezado y pie ACTIVADOS, como en el dialogo normal).

   Ademas de dejar los PDFs, comprueba y reporta por cada uno:
     * que sea UNA sola pagina de 80 mm de ancho;
     * que el PDF con encabezado/pie activados sea byte a byte el mismo
       que con ellos desactivados (= Chrome no dibujo ni fecha, ni
       titulo, ni URL, ni "1/1");
     * cuantos mm de papel en blanco quedan bajo la ultima linea.

   USO:   node pruebas/impresion/generar-pdfs.js
   Variables opcionales:
     CHROME=C:\ruta\chrome.exe   navegador a usar
     SALIDA=C:\ruta\carpeta      donde dejar los PDF (por defecto, esta
                                 misma carpeta)

   OJO: valida el CSS en el motor de Chrome, NO la impresora ni su
   driver. Cortes, tildes en papel y margenes fisicos solo se ven
   imprimiendo (ver docs/impresion-cocina.md, seccion 5).
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

const SALIDA = process.env.SALIDA || __dirname;
const FUENTE = fs.readFileSync(path.join(__dirname, "..", "..", "ticket-comanda.js"), "utf8");
const PUERTO_CDP = 9445;
const PX_POR_MM = 96 / 25.4;
const MM_POR_PT = 25.4 / 72;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TAMANOS = ["pequeno", "normal", "grande"];

/* Pedido tipico de la cocina: lo que mas se imprime. */
const PEDIDO_TIPICO = {
  id: 12, estado: "nuevo", estado_pago: "aprobado", tipo_pedido: "domicilio",
  cliente_nombre: "Juan Pérez", cliente_telefono: "3001234567",
  direccion: "Calle 10 # 5-20", barrio: "Caobos",
  indicaciones: "Casa blanca, portón verde",
  items: [
    { id: "a", nombre: "Tacos de Birria", cantidad: 3, precio: 18000, nota: "Sin cebolla" },
    { id: "b", nombre: "Agua de Jamaica", cantidad: 2, precio: 4000 }
  ],
  subtotal: 56000, costo_domicilio: 5000, total: 61000, wompi_metodo_pago: "NEQUI",
  pagado_en: "2026-10-11T23:30:00Z", creado_en: "2026-10-11T23:30:00Z"
};

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

/* Dibuja el ticket como lo hace imprimir(): plantilla + escala + pintar +
   ajustarPagina. Devuelve el documento resultante y sus medidas. */
function expresion(caso, tamano) {
  return "(function(){\n" + FUENTE + "\n" +
    "var T = window.TicketComanda;\n" +
    "var pedido = " + (caso === "prueba" ? "T.pedidoDePrueba()" : JSON.stringify(PEDIDO_TIPICO)) + ";\n" +
    "document.open(); document.write(T.PLANTILLA); document.close();\n" +
    "T.aplicarEscala(document, " + JSON.stringify(tamano) + ");\n" +
    "T.pintar(document, T.preparar(pedido, " + (caso === "prueba" ? "{prueba:true}" : "{}") + "));\n" +
    "var mm = T.ajustarPagina(document);\n" +
    "var pie = document.querySelector('.pie').getBoundingClientRect();\n" +
    "return { html: '<!DOCTYPE html>' + document.documentElement.outerHTML, mm: mm,\n" +
    "         pieAbajoPx: pie.bottom, texto: document.body.innerText };\n" +
    "})()";
}

function imprimirAPdf(html, pdf, sinEncabezado, perfil) {
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + perfil,
    "--print-to-pdf=" + pdf];
  if (sinEncabezado) args.push("--no-pdf-header-footer");
  args.push(url.pathToFileURL(html).href);
  const r = spawnSync(CHROME, args, { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error("Chrome no genero " + pdf + ": " + (r.stderr || ""));
}

function infoPdf(pdf) {
  const s = fs.readFileSync(pdf).toString("latin1");
  const paginas = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const m = s.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  return {
    paginas,
    anchoMm: m ? (Number(m[3]) - Number(m[1])) * MM_POR_PT : NaN,
    altoMm: m ? (Number(m[4]) - Number(m[2])) * MM_POR_PT : NaN
  };
}

(async () => {
  if (!CHROME) { console.error("No encuentro Chrome. Define CHROME=ruta\\chrome.exe"); process.exit(2); }
  fs.mkdirSync(SALIDA, { recursive: true });
  const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), "taq-pdf-"));
  const perfilWeb = path.join(trabajo, "perfil-web");

  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PUERTO_CDP,
    "--user-data-dir=" + perfilWeb, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
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
    for (const caso of ["prueba", "pedido"]) {
      for (const tamano of TAMANOS) {
        const nombre = "ticket-" + caso + "-" + tamano;
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Runtime.enable", {}, sessionId);
        const r = await cdp.send("Runtime.evaluate",
          { expression: expresion(caso, tamano), returnByValue: true }, sessionId);
        await cdp.send("Target.closeTarget", { targetId });
        if (r.exceptionDetails) throw new Error(nombre + ": " + (r.exceptionDetails.exception.description || r.exceptionDetails.text));
        const doc = r.result.value;

        const html = path.join(trabajo, nombre + ".html");
        fs.writeFileSync(html, doc.html);
        const conHF = path.join(trabajo, nombre + "-con-hf.pdf");
        const sinHF = path.join(trabajo, nombre + "-sin-hf.pdf");
        imprimirAPdf(html, conHF, false, path.join(trabajo, "perfil-a"));
        imprimirAPdf(html, sinHF, true, path.join(trabajo, "perfil-b"));

        const info = infoPdf(conHF);
        /* Los PDF llevan fecha de creacion: se compara sin ella. */
        const sinFechas = (f) => fs.readFileSync(f).toString("latin1")
          .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, "");
        const sinEncabezado = sinFechas(conHF) === sinFechas(sinHF);
        const blancoMm = doc.mm - doc.pieAbajoPx / PX_POR_MM;
        const bien = info.paginas === 1 && Math.abs(info.anchoMm - 80) < 0.5 && sinEncabezado;
        if (!bien) fallos++;
        // Sin URL ni titulo dentro del ticket
        if (/https?:|about:|\.html|Comanda\b/.test(doc.texto)) { fallos++; console.log("  ! texto sospechoso en " + nombre); }

        fs.copyFileSync(conHF, path.join(SALIDA, nombre + ".pdf"));
        filas.push({
          pdf: nombre + ".pdf", paginas: info.paginas,
          ancho: info.anchoMm.toFixed(1) + " mm", alto: info.altoMm.toFixed(1) + " mm",
          blanco: blancoMm.toFixed(1) + " mm",
          encabezado: sinEncabezado ? "ninguno" : "DIBUJADO", ok: bien ? "OK" : "FALLA"
        });
      }
    }
  } finally {
    try { await cdp.send("Browser.close"); } catch (e) { /* ya cerrado */ }
    chrome.kill();
    try { fs.rmSync(trabajo, { recursive: true, force: true }); } catch (e) { /* bloqueado por Windows */ }
  }

  console.table(filas);
  console.log("PDFs en " + SALIDA);
  console.log(fallos ? fallos + " comprobaciones fallidas" : "Todo correcto: 1 pagina de 80 mm, sin encabezado ni pie.");
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
