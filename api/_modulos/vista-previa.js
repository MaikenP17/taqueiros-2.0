const fs = require("node:fs");
const path = require("node:path");
const { resolverRestaurante, normalizarHost } = require("../_restaurante.js");
const { datosVistaPrevia } = require("../_publico.js");

/* =============================================================
   VISTA PREVIA DE ENLACES POR RESTAURANTE

   Cuando alguien pega el enlace de un restaurante en WhatsApp, Instagram,
   Facebook, Telegram, X, Slack, LinkedIn o Discord, esas aplicaciones piden la
   pagina UNA vez, NO ejecutan JavaScript y arman la tarjeta con las etiquetas
   del HTML (title, description, og:*). index.html es un archivo estatico igual
   para todos los restaurantes (el nombre lo pone JavaScript), asi que la tarjeta
   salia con el titulo neutro. Este modulo le sirve al rastreador la MISMA pagina
   con las etiquetas del restaurante del host.

   COMO LLEGA UN RASTREADOR AQUI
   Solo ellos: una regla de vercel.json (por User-Agent) manda "/", "/index.html"
   y "/pedido.html" a esta funcion SOLO cuando el User-Agent es de un rastreador.
   Las personas siguen recibiendo el archivo estatico de siempre (rapido y sin
   pasar por aqui). Como Vercel da prioridad a los archivos sobre las
   reescrituras, la regla es una redireccion temporal (307), que se evalua antes.
   Ver docs/multirestaurante.md, seccion 17.

   QUE GARANTIZA
     * El restaurante sale del HOST, con la misma resolucion que el resto de la API
       (_restaurante.js). Un host desconocido, una base caida o cualquier fallo
       devuelve la pagina NEUTRA de siempre: nunca datos de otro restaurante.
     * Todo valor sale de _publico.js (mismas listas y validadores que
       /api/restaurante) y se ESCAPA para HTML y atributos: un dato hostil en la
       configuracion no puede inyectar nada.
     * La imagen es una ruta propia (completada con el host, https) o una URL https
       del Storage esperado; nada mas.
     * Sin cache compartida (Cache-Control: private, no-store): la respuesta
       depende del host y del User-Agent, y una invocacion por cada rastreo es
       poca cosa. Asi ninguna variante puede servirse a quien no debe.
     * Si lo pide una persona (User-Agent que no es de rastreador) no se le sirve
       nada de esto: se le manda a la direccion normal.
============================================================= */

/* User-Agent de los rastreadores de vista previa. vercel.json usa EXACTAMENTE esta lista
   (una prueba lo exige) y aqui se compara sin distinguir mayusculas, asi que todo lo que
   la redireccion manda aqui es un rastreador tambien para este modulo (sin bucles).
   No incluye "Instagram" a proposito: es el navegador interno de la app, que usan las
   PERSONAS que entran por el enlace de la biografia; la tarjeta de Instagram la arma el
   rastreador de Meta (facebookexternalhit / meta-externalagent). */
const RASTREADORES = [
  "WhatsApp", "facebookexternalhit", "Facebot", "meta-externalagent", "meta-externalfetcher",
  "TelegramBot", "Twitterbot", "Slackbot", "Slack-ImgProxy", "LinkedInBot", "Discordbot"
];
const ES_RASTREADOR = new RegExp("(" + RASTREADORES.join("|") + ")", "i");

const PAGINAS = {
  index: { archivo: "index.html", ruta: "/" },
  pedido: { archivo: "pedido.html", ruta: "/pedido.html" }
};

/* Lo unico que se necesita de la pagina estatica: el titulo, la descripcion vacia (que ya
   existe en el HTML) y el cierre del <head>. Si la pagina cambia y esto ya no calza, no se
   inyecta nada y se sirve la pagina tal cual (una prueba avisa). */
const DESCRIPCION_VACIA = '<meta name="description" content="">';

function esc(valor) {
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function etiquetas(d) {
  const filas = [
    '<meta name="description" content="' + esc(d.descripcion) + '">'
  ];
  if (d.colorTema) filas.push('<meta name="theme-color" content="' + esc(d.colorTema) + '">');
  filas.push(
    '<meta property="og:site_name" content="' + esc(d.nombre) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:locale" content="es_CO">',
    '<meta property="og:title" content="' + esc(d.titulo) + '">',
    '<meta property="og:description" content="' + esc(d.descripcion) + '">',
    '<meta property="og:url" content="' + esc(d.url) + '">'
  );
  if (d.imagen) {
    filas.push(
      '<meta property="og:image" content="' + esc(d.imagen) + '">',
      '<meta property="og:image:alt" content="' + esc(d.nombre) + '">'
    );
  }
  filas.push(
    '<meta name="twitter:card" content="summary">',
    '<meta name="twitter:title" content="' + esc(d.titulo) + '">',
    '<meta name="twitter:description" content="' + esc(d.descripcion) + '">'
  );
  if (d.imagen) filas.push('<meta name="twitter:image" content="' + esc(d.imagen) + '">');
  return filas.join("\n");
}

/* La pagina estatica con el <title> y las etiquetas del restaurante, o null si la pagina no
   tiene la forma esperada (un solo <title>, la descripcion vacia, ninguna etiqueta og: previa). */
function inyectar(html, d) {
  const abre = html.indexOf("<title>");
  if (abre < 0 || html.lastIndexOf("<title>") !== abre) return null;
  const cierra = html.indexOf("</title>", abre);
  if (cierra < 0) return null;
  const desc = html.indexOf(DESCRIPCION_VACIA);
  if (desc < 0 || html.lastIndexOf(DESCRIPCION_VACIA) !== desc) return null;
  if (html.includes('property="og:')) return null;

  let salida = html.slice(0, abre) + "<title>" + esc(d.titulo) + "</title>" + html.slice(cierra + "</title>".length);
  const i = salida.indexOf(DESCRIPCION_VACIA);
  salida = salida.slice(0, i) + etiquetas(d) + salida.slice(i + DESCRIPCION_VACIA.length);
  return salida;
}

/* ---- la pagina estatica del repositorio ----------------------------------------------------------
   vercel.json la incluye en la funcion (functions.includeFiles). Se lee una vez por instancia. */
const leidas = new Map();
function leerPagina(archivo) {
  if (leidas.has(archivo)) return leidas.get(archivo);
  const candidatas = [
    path.join(__dirname, "..", "..", archivo),
    path.join(process.cwd(), archivo)
  ];
  for (const ruta of candidatas) {
    try {
      const texto = fs.readFileSync(ruta, "utf8");
      leidas.set(archivo, texto);
      return texto;
    } catch (e) { /* se prueba la siguiente */ }
  }
  console.error("[VistaPrevia] No se pudo leer " + archivo + " (revisa functions.includeFiles en vercel.json)");
  return null;
}

/* Ultimo recurso si ni siquiera se puede leer el archivo: la pagina neutra de siempre, minima. */
function paginaMinima(pagina) {
  const titulo = pagina === "pedido" ? "Sigue tu pedido" : "Pedidos en línea";
  return '<!DOCTYPE html>\n<html lang="es">\n<head>\n<meta charset="UTF-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + "<title>" + titulo + "</title>\n" + DESCRIPCION_VACIA + "\n</head>\n<body></body>\n</html>\n";
}

function paginaPedida(req) {
  try {
    const q = new URL((req && req.url) || "/", "http://localhost").searchParams.get("_pagina");
    return q === "pedido" ? "pedido" : "index";
  } catch (e) {
    return "index";
  }
}

function responder(res, estado, html, cabeceras) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Host, User-Agent");
  for (const k of Object.keys(cabeceras || {})) res.setHeader(k, cabeceras[k]);
  res.status(estado).send(html);
}

module.exports = async (req, res) => {
  const pagina = paginaPedida(req);
  const { archivo, ruta } = PAGINAS[pagina];

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Cache-Control", "no-store");
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  // Una persona (o algo que no es un rastreador) no recibe esto: se le manda a la direccion normal.
  const ua = String((req.headers && req.headers["user-agent"]) || "");
  if (!ES_RASTREADOR.test(ua)) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "User-Agent");
    res.setHeader("Location", ruta);
    res.status(302).send("");
    return;
  }

  const html = leerPagina(archivo);
  let inyectada = null;
  try {
    const encontrado = await resolverRestaurante(req);
    const host = normalizarHost(req.headers && req.headers.host);
    if (encontrado && host && html) {
      inyectada = inyectar(html, datosVistaPrevia(encontrado.restaurante, host, pagina));
    }
  } catch (err) {
    // Base caida, datos raros...: se sirve la pagina neutra, jamas otra cosa
    console.error("[VistaPrevia] No se pudo armar la vista previa:", err.message);
  }

  responder(res, 200, inyectada || html || paginaMinima(pagina), { "X-Vista-Previa": inyectada ? "restaurante" : "neutra" });
};

module.exports.RASTREADORES = RASTREADORES;
module.exports.ES_RASTREADOR = ES_RASTREADOR;
module.exports.inyectar = inyectar;
module.exports.etiquetas = etiquetas;
module.exports.esc = esc;
