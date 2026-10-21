const { contextoDomicilio } = require("./_domicilio.js");
const {
  RESTAURANTE_TAQUEIROS_ID, restauranteActivo, leerSecretos, modoDePago, secretosWompi
} = require("./_restaurante.js");
const { leerTarifasDomicilio } = require("./_supabase.js");
const { CONFIG_TAQUEIROS } = require("./_respaldo-taqueiros.js");

/* =============================================================
   DATOS PUBLICOS DE UN RESTAURANTE  (lo que leen las paginas y el manifest)

   Una sola funcion arma TODO lo que el navegador puede saber de un
   restaurante, y lo hace campo por campo: no se copia la fila ni se devuelve
   la config tal cual. Lo que no esta en las listas de abajo NO sale, aunque
   alguien lo guarde en restaurantes.config.

   POR QUE SE VALIDA AQUI Y OTRA VEZ EN EL NAVEGADOR
   restaurantes.config lo puede editar el dueno desde su panel (es "su"
   texto, pero se muestra a TODOS sus clientes). Un valor hostil no puede
   volverse HTML ni CSS:
     * los textos son texto plano (sin caracteres de control ni invisibles,
       una sola linea, con tope de largo); el navegador los inserta SOLO con
       textContent;
     * los colores deben ser #RRGGBB exactos (nada de "red;background:url(..)");
     * las URLs de logo e iconos son rutas relativas del sitio o http(s) del
       origen esperado (el de Supabase del proyecto);
       jamas javascript: ni data:;
     * numeros y telefonos se validan por formato.
   El navegador repite estas mismas reglas (restaurante-publico.js): defensa en
   capas, porque esta respuesta tambien la puede ver un intermediario.

   RESPALDO SOLO PARA TAQUEIROS
   Lo que su config todavia no traiga (antes de correr el SQL 12) se completa,
   campo por campo, con api/_respaldo-taqueiros.js y deja un aviso en el log.
   Nunca para otro restaurante: un restaurante sin datos se ve neutro.

   NO DEVUELVE NUNCA: plan, modalidad de pago, vigencia ni dias de gracia, el
   resto de config, nada de restaurante_secretos (solo se pregunta si hay
   modo de cobro y si existe el secreto de integridad, sin devolverlo) ni de
   miembros. Tampoco si el restaurante esta "en gracia": ahi dice "activo".
============================================================= */

/* ---------------------------------------------------------------
   VALIDADORES
--------------------------------------------------------------- */

/* Caracteres que nadie escribe a proposito en un texto de marca: controles,
   ancho cero y controles de direccion (bidi). Se arma desde codigos para que
   ningun editor deje caracteres invisibles escritos en este archivo. */
const CONTROLES = (() => {
  const barra = String.fromCharCode(92);
  const u = (n) => barra + "u" + n.toString(16).padStart(4, "0");
  const rangos = [[0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f], [0x202a, 0x202e],
                  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
  return new RegExp("[" + rangos.map(([a, b]) => u(a) + "-" + u(b)).join("") + "]", "g");
})();

const BLANCOS = new RegExp(String.fromCharCode(92) + "s+", "g");

/* Texto plano de una sola linea, o null. */
function texto(valor, maximo) {
  if (typeof valor !== "string") return null;
  const t = valor.replace(CONTROLES, " ").replace(BLANCOS, " ").trim().slice(0, maximo || 300);
  return t || null;
}

const COLOR = /^#[0-9A-Fa-f]{6}$/;
function color(valor) {
  return typeof valor === "string" && COLOR.test(valor.trim()) ? valor.trim() : null;
}

/* Ruta relativa del propio sitio ("Recursos/logo/logo.png"): sin esquema (no admite ':'),
   sin "//", sin "..". */
const RUTA_RELATIVA = /^\/?[A-Za-z0-9][A-Za-z0-9_\-./]*$/;

/* Origen desde el que se aceptan imagenes ademas de las rutas del propio sitio: el Supabase del
   proyecto (su Storage). Es la misma regla que aplica el navegador (restaurante-publico.js, que lo
   toma de supabase-publico.js): si se agregara otro origen, hay que agregarlo en los DOS lados. */
function origenesPermitidos(env) {
  const e = env || process.env;
  const lista = [];
  if (e.SUPABASE_URL) {
    try { lista.push(new URL(String(e.SUPABASE_URL).trim()).origin); } catch (err) { /* no es una URL */ }
  }
  return lista;
}

function urlSegura(valor, origenes) {
  if (typeof valor !== "string") return null;
  const s = valor.trim();
  if (!s || s.length > 500) return null;
  if (RUTA_RELATIVA.test(s) && !s.includes("..") && !s.includes("//")) return s;

  let u;
  try { u = new URL(s); } catch (err) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (!(origenes || []).includes(u.origin)) return null;
  return u.href;
}

function numeroEn(valor, min, max) {
  const n = typeof valor === "number" ? valor : (typeof valor === "string" && valor.trim() !== "" ? Number(valor) : NaN);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const WHATSAPP = /^\d{8,15}$/;
const USUARIO_RED = /^[A-Za-z0-9._]{1,60}$/;
const LLAVE_WOMPI = /^pub_(test|prod)_[A-Za-z0-9]{10,80}$/;

function objeto(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/* ---------------------------------------------------------------
   LISTAS DE LO QUE PUEDE SALIR
--------------------------------------------------------------- */

const COLORES = ["primario", "primario_oscuro", "primario_brillo", "claro", "claro_suave", "oscuro", "oscuro_2",
                 "acento", "positivo", "texto_secundario", "texto_tenue", "positivo_brillo"];

const TEXTOS = ["titulo_pagina", "descripcion_pagina", "eslogan", "tagline", "descripcion_pie", "servicios_linea",
                "pie_final", "ejemplo_nota", "banner_abierto_icono", "banner_abierto_titulo", "banner_abierto_texto",
                "banner_cerrado_icono", "banner_cerrado_mensaje"];

const TEXTOS_SEGUIMIENTO = ["tiempo_nuevo", "tiempo_preparacion", "tiempo_camino", "tiempo_recoger", "tiempo_entregado",
                            "frase_nuevo", "frase_preparacion", "frase_camino", "frase_recoger", "frase_entregado"];

const MODULOS = ["pasarela", "seguimiento", "comandas", "impresion"];

/* Tipografias que un restaurante puede elegir para las paginas del personal (marca.tipografia.titulos y
   .cuerpo). Es una LISTA DE NOMBRES: ningun valor de la config se vuelve URL ni CSS; el navegador arma la
   direccion de Google Fonts solo con las entradas de su propia copia de esta lista (restaurante-publico.js,
   RP.FUENTES). Si se agrega una, hay que agregarla en los DOS archivos (una prueba compara ambas listas). */
const FUENTES_PERMITIDAS = ["Anton", "Bebas Neue", "Oswald", "Montserrat", "Poppins", "Playfair Display", "Fredoka",
                            "Lora", "Merriweather", "Libre Franklin", "Open Sans", "Nunito", "Lato", "DM Sans",
                            "Work Sans", "Source Sans 3"];

function fuente(valor) {
  return typeof valor === "string" && FUENTES_PERMITIDAS.includes(valor.trim()) ? valor.trim() : null;
}

/* ---------------------------------------------------------------
   RESPALDO (solo Taqueiros)
--------------------------------------------------------------- */

const avisados = new Set();
function avisarUnaVez(clave, mensaje) {
  if (avisados.has(clave)) return;
  avisados.add(clave);
  console.warn(mensaje);
}

/* base <- sobre: gana 'sobre'; objetos se mezclan por dentro; null/undefined no pisan. Cuenta
   cuantos valores salieron del respaldo. */
function mezclar(base, sobre, cuenta) {
  if (sobre === undefined || sobre === null) { cuenta.n++; return base; }
  if (base && typeof base === "object" && !Array.isArray(base) && sobre && typeof sobre === "object" && !Array.isArray(sobre)) {
    const sal = {};
    for (const k of Object.keys(base)) sal[k] = mezclar(base[k], sobre[k], cuenta);
    for (const k of Object.keys(sobre)) if (!(k in sal)) sal[k] = sobre[k];
    return sal;
  }
  return sobre;
}

/* La config efectiva de un restaurante: la suya, y para Taqueiros completada con el respaldo. */
function configEfectiva(restaurante) {
  const cfg = objeto(restaurante && restaurante.config);
  if (!restaurante || restaurante.id !== RESTAURANTE_TAQUEIROS_ID) return cfg;

  const cuenta = { n: 0 };
  const completa = mezclar(CONFIG_TAQUEIROS, cfg, cuenta);
  if (cuenta.n > 0) {
    avisarUnaVez("respaldo-config",
      "[Publico] Taqueiros usa " + cuenta.n + " valores de respaldo del codigo porque su config no los trae: corre supabase/12-config-publica.sql.");
  }
  return completa;
}

/* ---------------------------------------------------------------
   CONSTRUCCION (pura: sin red)
--------------------------------------------------------------- */

function marcaPublica(m, origenes) {
  const marca = objeto(m);
  const colores = {};
  const entrada = objeto(marca.colores);
  for (const k of COLORES) { const c = color(entrada[k]); if (c) colores[k] = c; }

  const zonas = (Array.isArray(marca.colores_zonas) ? marca.colores_zonas : []).map(color).filter(Boolean).slice(0, 8);

  const sal = {
    logo: urlSegura(marca.logo, origenes),
    icono_192: urlSegura(marca.icono_192, origenes),
    icono_512: urlSegura(marca.icono_512, origenes),
    emoji: texto(marca.emoji, 8),
    colores,
    colores_zonas: zonas
  };

  // Solo sale si el restaurante eligio alguna (y de la lista); si no, las paginas usan las de siempre
  const tip = objeto(marca.tipografia);
  const tipografia = {};
  const titulos = fuente(tip.titulos);
  const cuerpo = fuente(tip.cuerpo);
  if (titulos) tipografia.titulos = titulos;
  if (cuerpo) tipografia.cuerpo = cuerpo;
  if (titulos || cuerpo) sal.tipografia = tipografia;

  return sal;
}

function textosPublicos(t) {
  const textos = objeto(t);
  const sal = {};
  for (const k of TEXTOS) { const v = texto(textos[k], 400); if (v) sal[k] = v; }
  const seg = objeto(textos.seguimiento);
  const segSal = {};
  for (const k of TEXTOS_SEGUIMIENTO) { const v = texto(seg[k], 200); if (v) segSal[k] = v; }
  sal.seguimiento = segSal;
  return sal;
}

function contactoPublico(c) {
  const contacto = objeto(c);
  const sal = {};
  const wa = typeof contacto.whatsapp === "string" ? contacto.whatsapp.replace(/[\s+()-]/g, "") : "";
  if (WHATSAPP.test(wa)) sal.whatsapp = wa;
  [["telefono", 40], ["direccion", 200], ["direccion_corta", 200], ["ciudad", 80], ["region", 80]].forEach(([k, max]) => {
    const v = texto(contacto[k], max);
    if (v) sal[k] = v;
  });
  ["instagram", "tiktok"].forEach((k) => {
    const v = typeof contacto[k] === "string" ? contacto[k].trim().replace(/^@/, "") : "";
    if (USUARIO_RED.test(v)) sal[k] = v;
  });
  return sal;
}

/* Llave publica de Wompi para un modo ("test" | "produccion"), o null. Debe ser del modo: una
   pub_test_ nunca se entrega como llave de produccion ni al reves. */
function llaveWompiDe(w, modo) {
  const wompi = objeto(w);
  const v = modo === "produccion" ? wompi.llave_publica_prod : wompi.llave_publica_test;
  const t = typeof v === "string" ? v.trim() : "";
  if (!LLAVE_WOMPI.test(t)) return null;
  return t.startsWith(modo === "produccion" ? "pub_prod_" : "pub_test_") ? t : null;
}

/* Arma la respuesta publica. 'extras' trae lo que sale de la red:
     tarifas        filas de tarifas_domicilio del restaurante
     modo           "test" | "produccion" | null  (lo decide el servidor)
     integridadOk   el restaurante tiene secreto de integridad para ese modo
     env            variables de entorno (para los origenes de imagenes)  */
function construirPublico(restaurante, extras, ahora) {
  const ex = extras || {};
  const cfg = configEfectiva(restaurante);
  const publico = objeto(cfg.publico);
  const origenes = origenesPermitidos(ex.env);
  const servicio = restauranteActivo(restaurante, ahora);

  const modulos = {};
  const m = objeto(restaurante.modulos);
  for (const k of MODULOS) modulos[k] = m[k] !== false;

  // Domicilio: lo calcula el servidor con la misma funcion que cobra (contextoDomicilio)
  const ctx = contextoDomicilio(Object.assign({}, restaurante, { config: cfg }), ex.tarifas);
  const domicilio = ctx
    ? {
        ofrece: true,
        factor_recorrido: ctx.factor,
        tarifas: ctx.tarifas.map((t) => ({ hasta: t.hasta, precio: t.precio }))
      }
    : { ofrece: false, factor_recorrido: null, tarifas: [] };
  const ubicacion = ctx ? { lat: ctx.origen.lat, lng: ctx.origen.lng } : null;

  const llave = ex.modo ? llaveWompiDe(publico.wompi, ex.modo) : null;
  const pago = {
    disponible: !!(ex.modo && llave && ex.integridadOk && modulos.pasarela),
    pasarela: "wompi",
    modo: ex.modo || null,
    llave_publica: ex.modo && llave && ex.integridadOk && modulos.pasarela ? llave : null
  };

  return {
    id: restaurante.id,
    slug: restaurante.slug,
    nombre: texto(restaurante.nombre, 120) || restaurante.slug,
    zona_horaria: restaurante.zona_horaria,
    moneda: "COP",
    modulos,
    servicio: {
      estado: servicio.sirve ? "activo" : "suspendido",
      sirve: servicio.sirve,
      motivo: servicio.sirve ? null : "servicio_suspendido"
    },
    marca: marcaPublica(publico.marca, origenes),
    textos: textosPublicos(publico.textos),
    contacto: contactoPublico(publico.contacto),
    ubicacion,
    domicilio,
    pago
  };
}

/* Lo que sale de la red para armar la respuesta: tarifas y modo de cobro. Los secretos se leen
   solo para saber SI hay modo y secreto de integridad; no se devuelven ni se guardan. */
async function datosPublicos(restaurante, env) {
  const [tarifas, secretos] = await Promise.all([
    leerTarifasDomicilio(restaurante.id).catch((err) => {
      console.error("[Publico] No se pudieron leer las tarifas:", err.message);
      return [];
    }),
    leerSecretos(restaurante).catch((err) => {
      console.error("[Publico] No se pudo leer el modo de cobro:", err.message);
      return null;
    })
  ]);

  let modo = null;
  let integridadOk = false;
  if (secretos) {
    modo = modoDePago(restaurante, secretos, undefined);
    integridadOk = !!(modo && secretosWompi(restaurante, secretos, modo, env).integridad);
  }
  return construirPublico(restaurante, { tarifas, modo, integridadOk, env });
}

/* Lo que necesita el manifest de la PWA (api/manifest.js): nombre, colores e iconos. */
function datosManifest(restaurante, env) {
  const cfg = configEfectiva(restaurante);
  const publico = objeto(cfg.publico);
  const marca = marcaPublica(publico.marca, origenesPermitidos(env));
  const pwa = objeto(publico.pwa);
  const nombre = texto(restaurante.nombre, 120) || restaurante.slug;
  return {
    nombre: texto(pwa.nombre, 45) || ("Panel " + nombre),
    nombreCorto: texto(pwa.nombre_corto, 12) || "Comandas",
    descripcion: "Panel de comandas de " + nombre + ": pedidos en tiempo real.",
    colorFondo: marca.colores.oscuro || "#1A1A1A",
    colorTema: marca.colores.primario || "#444444",
    logo: marca.logo,
    icono192: marca.icono_192 || marca.logo,
    icono512: marca.icono_512 || marca.logo
  };
}

module.exports = {
  texto, color, urlSegura, origenesPermitidos, configEfectiva,
  construirPublico, datosPublicos, datosManifest,
  COLORES, TEXTOS, TEXTOS_SEGUIMIENTO, FUENTES_PERMITIDAS
};
