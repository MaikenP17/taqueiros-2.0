/* =============================================================
   DE QUE RESTAURANTE ES ESTA PETICION  (y que servicio tiene)

   Un solo despliegue en Vercel y una sola base en Supabase sirven a muchos
   restaurantes. Todo endpoint publico empieza por aqui: resolver el
   restaurante, y de ahi en adelante filtrar SIEMPRE por su id.

   -------------------------------------------------------------
   COMO SE RESUELVE (en este orden, y nada mas)
   -------------------------------------------------------------
     1. El encabezado Host EXACTO, buscado en restaurante_dominios
        (SQL 11). Ej: taqueiros-2-0.vercel.app, pedidos.lostaqueiros.com.
     2. Un subdominio bajo DOMINIO_BASE (variable de entorno) cuyo UNICO
        segmento anterior sea el slug de un restaurante.
        Ej: DOMINIO_BASE=midominio.com  ->  lostaqueiros.midominio.com.
     3. SOLO si VERCEL_ENV no es 'production' (previews y desarrollo local)
        Y ADEMAS RESTAURANTE_POR_PARAMETRO=1: el parametro ?r=<slug>, para
        poder probar sin dominios. Los previews de Vercel son publicos por
        defecto y usan las mismas variables (la misma base y la llave secreta)
        que produccion: sin ese interruptor explicito, cualquiera con la URL
        de un preview elegiria cualquier restaurante real.

   POR QUE ES SEGURO
     * Host lo pone la infraestructura (Vercel enruta por el dominio al que
       entro el cliente); no se lee x-forwarded-host ni ningun otro
       encabezado, y NUNCA el cuerpo de la peticion.
     * En produccion no existe ninguna forma de elegir restaurante con un
       dato que el cliente controle: solo cuentan dominios que Carlos dio de
       alta. ?r= esta apagado.
     * Un host desconocido responde 404 con el MISMO texto siempre, sin decir
       que restaurantes existen.
     * El slug de un subdominio se valida contra el formato antes de buscarlo.

   -------------------------------------------------------------
   CACHE (memoria de la instancia, 30 s)
   -------------------------------------------------------------
   Guarda solo el restaurante (nunca secretos: esos se leen en cada uso y
   no se conservan). Hay cache negativo de 10 s para no golpear la base con
   hosts inventados. Si Supabase falla, se usa una copia VIEJA de lo ultimo
   que se resolvio para ese host (hasta 6 h): el mapa host -> restaurante no
   es secreto y asi se conserva la red de seguridad del menu (_menu.js).
   invalidarCache() lo vacia (cuando cambie el estado de un restaurante).

   -------------------------------------------------------------
   TRANSICION
   -------------------------------------------------------------
   Si la tabla restaurante_dominios todavia no existe (SQL 11 sin correr) y
   el host es el de produccion de Taqueiros, se resuelve a Taqueiros con un
   aviso en el log. Solo ese host exacto y solo mientras falte la tabla.
============================================================= */

const {
  buscarRestaurantePorHost,
  buscarRestaurantePorSlug,
  buscarRestaurantePorId,
  leerSecretosRestaurante
} = require("./_supabase.js");

const RESTAURANTE_TAQUEIROS_ID = "00000000-0000-4000-8000-000000000001";
const HOSTS_TRANSITORIOS_TAQUEIROS = ["taqueiros-2-0.vercel.app"];

const TTL_MS = 30 * 1000;
const TTL_NEGATIVO_MS = 10 * 1000;
const VIDA_MAXIMA_VIEJO_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRADAS = 500;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/* clave -> { restaurante | null, expira, vence } */
const cache = new Map();

function avisarUnaVez(clave, ...texto) {
  if (avisarUnaVez.vistos.has(clave)) return;
  avisarUnaVez.vistos.add(clave);
  console.warn(...texto);
}
avisarUnaVez.vistos = new Set();

/* ---------------------------------------------------------------
   HOST
--------------------------------------------------------------- */

/* "LosTaqueiros.MiDominio.com:443." -> "lostaqueiros.midominio.com".
   null si no se parece a un nombre de host. */
function normalizarHost(valor) {
  let h = String(valor == null ? "" : valor).trim().toLowerCase();
  if (!h || h.length > 300) return null;
  h = h.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (h.length < 3 || h.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) || h.includes("..")) return null;
  return h;
}

function hostDe(req) {
  const h = req && req.headers ? req.headers.host : null;
  return normalizarHost(Array.isArray(h) ? h[0] : h);
}

function parametrosDe(req) {
  try {
    return new URL((req && req.url) || "/", "http://localhost").searchParams;
  } catch (e) {
    return new URLSearchParams();
  }
}

/* ---------------------------------------------------------------
   CACHE
--------------------------------------------------------------- */

function guardarEnCache(clave, restaurante, ahora) {
  if (cache.size >= MAX_ENTRADAS && !cache.has(clave)) {
    // Sin crecer sin limite: se descarta la entrada mas antigua
    cache.delete(cache.keys().next().value);
  }
  cache.delete(clave);
  cache.set(clave, {
    restaurante,
    expira: ahora + (restaurante ? TTL_MS : TTL_NEGATIVO_MS),
    vence: ahora + VIDA_MAXIMA_VIEJO_MS
  });
}

/* Resuelve con cache. 'buscar' devuelve el restaurante o null; si lanza, se
   usa la copia vieja (si la hay) en vez de caerse. */
async function conCache(clave, buscar) {
  const ahora = Date.now();
  const hit = cache.get(clave);
  if (hit && hit.expira > ahora) return hit.restaurante;

  try {
    const r = await buscar();
    guardarEnCache(clave, r || null, ahora);
    return r || null;
  } catch (err) {
    if (hit && hit.restaurante && hit.vence > ahora) {
      avisarUnaVez("viejo:" + clave, "[Restaurante] La base no respondio; se usa la ultima resolucion conocida de", clave);
      return hit.restaurante;
    }
    throw err;
  }
}

/* Vacia la cache. Sin argumento borra todo; con un id de restaurante, solo
   lo suyo. Llamarla cuando algo cambie el estado/plan/vigencia de un restaurante. */
function invalidarCache(restauranteId) {
  if (!restauranteId) { cache.clear(); return; }
  for (const [clave, e] of cache) {
    if (e.restaurante && e.restaurante.id === restauranteId) cache.delete(clave);
  }
}

/* ---------------------------------------------------------------
   RESOLUCION
--------------------------------------------------------------- */

function tablaDominiosAusente(err) {
  const t = String((err && err.cuerpo) || (err && err.message) || "");
  return !!err && (err.status === 404 || err.status === 400)
    && /restaurante_dominios/.test(t) && /(PGRST205|42P01|does not exist|not find)/i.test(t);
}

async function porHost(host) {
  return conCache("host:" + host, async () => {
    try {
      return await buscarRestaurantePorHost(host);
    } catch (err) {
      if (tablaDominiosAusente(err) && HOSTS_TRANSITORIOS_TAQUEIROS.includes(host)) {
        avisarUnaVez("sql11", "[Restaurante] Falta la tabla restaurante_dominios (SQL 11): " + host + " se resuelve a Taqueiros de forma transitoria. Corre supabase/11-dominios.sql.");
        return buscarRestaurantePorId(RESTAURANTE_TAQUEIROS_ID);
      }
      throw err;
    }
  });
}

async function porSlug(slug) {
  return conCache("slug:" + slug, () => buscarRestaurantePorSlug(slug));
}

/* Devuelve { restaurante, via } o null si no hay (host desconocido).
   Lanza si la base falla y no hay copia vieja. */
async function resolverRestaurante(req, env) {
  const entorno = env || process.env;
  const host = hostDe(req);

  // 1) Host exacto
  if (host) {
    const r = await porHost(host);
    if (r) return { restaurante: r, via: "host" };
  }

  // 2) <slug>.<DOMINIO_BASE>  (un solo segmento)
  const base = normalizarHost(entorno.DOMINIO_BASE);
  if (host && base && host.endsWith("." + base)) {
    const etiqueta = host.slice(0, host.length - base.length - 1);
    if (etiqueta.length >= 2 && etiqueta.length <= 40 && SLUG.test(etiqueta)) {
      const r = await porSlug(etiqueta);
      if (r) return { restaurante: r, via: "subdominio" };
    }
  }

  // 3) ?r=<slug>: solo fuera de produccion (previews y local) y si se activo a
  //    proposito (ver arriba: los previews son publicos y comparten la base)
  if (entorno.VERCEL_ENV !== "production" && entorno.RESTAURANTE_POR_PARAMETRO === "1") {
    const slug = String(parametrosDe(req).get("r") || "").trim().toLowerCase();
    if (slug && slug.length >= 2 && slug.length <= 40 && SLUG.test(slug)) {
      const r = await porSlug(slug);
      if (r) return { restaurante: r, via: "parametro" };
    }
  }

  return null;
}

/* Resuelve o RESPONDE: 404 (host desconocido, siempre el mismo texto) o 503
   (la base no responde y no hay nada que servir). Devuelve el restaurante, o
   null si ya respondio y el manejador debe terminar. */
async function exigirRestaurante(req, res, env) {
  let encontrado;
  try {
    encontrado = await resolverRestaurante(req, env);
  } catch (err) {
    console.error("[Restaurante] No se pudo resolver el restaurante:", err.message);
    res.setHeader && res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "Servicio no disponible en este momento" });
    return null;
  }

  if (!encontrado) {
    res.setHeader && res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "No encontrado" });
    return null;
  }
  return encontrado.restaurante;
}

/* Lee el restaurante otra vez SIN cache: para decidir si se aceptan pedidos
   (un restaurante suspendido deja de recibirlos en el acto, no en 30 s). */
async function restauranteFresco(restaurante) {
  const r = await buscarRestaurantePorId(restaurante.id);
  if (r) invalidarCache(r.id);
  return r || restaurante;
}

/* ---------------------------------------------------------------
   ESTADO DEL SERVICIO (mensualidad)
--------------------------------------------------------------- */

const DIA_MS = 24 * 60 * 60 * 1000;

/* "2026-10-20" en la zona horaria del restaurante. */
function fechaLocal(ahora, zona) {
  let z = zona || "America/Bogota";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
  } catch (e) {
    z = "America/Bogota";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: z, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(ahora);
}

function diaAMs(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(yyyyMmDd || ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/* Estado del servicio de un restaurante:
     { estado: "activo" | "gracia" | "suspendido", sirve: boolean, motivo, ... }
   - estado 'suspendido'              -> suspendido (motivo "suspendido")
   - vigente_hasta nulo               -> activo (sin vencimiento)
   - hoy <= vigente_hasta             -> activo   ('prueba' y 'activo' sirven)
   - hasta vigente_hasta + dias_gracia-> gracia (sigue sirviendo, con aviso)
   - despues                          -> suspendido (motivo "vencido")
   "Hoy" es la fecha en la zona horaria del restaurante. vigente_hasta cuenta
   completo: el dia que dice, todavia se sirve. */
function restauranteActivo(restaurante, ahora) {
  const momento = ahora instanceof Date ? ahora : new Date(ahora || Date.now());
  const r = restaurante || {};

  if (r.estado === "suspendido") {
    return { estado: "suspendido", sirve: false, motivo: "suspendido", vigenteHasta: r.vigente_hasta || null, diasDeGracia: 0 };
  }

  const hasta = diaAMs(r.vigente_hasta);
  if (r.vigente_hasta == null || hasta === null) {
    return { estado: "activo", sirve: true, motivo: null, vigenteHasta: null, diasDeGracia: 0 };
  }

  const hoy = diaAMs(fechaLocal(momento, r.zona_horaria));
  const gracia = Math.max(0, Number.isFinite(Number(r.dias_gracia)) ? Math.floor(Number(r.dias_gracia)) : 0);
  const vencidoHace = Math.round((hoy - hasta) / DIA_MS);

  if (vencidoHace <= 0) {
    return { estado: "activo", sirve: true, motivo: null, vigenteHasta: r.vigente_hasta, diasDeGracia: 0 };
  }
  if (vencidoHace <= gracia) {
    return { estado: "gracia", sirve: true, motivo: "en_gracia", vigenteHasta: r.vigente_hasta, diasDeGracia: gracia - vencidoHace };
  }
  return { estado: "suspendido", sirve: false, motivo: "vencido", vigenteHasta: r.vigente_hasta, diasDeGracia: 0 };
}

/* Para los endpoints publicos que RECIBEN pedidos: si el servicio no sirve,
   responde 403 con motivo 'servicio_suspendido' (sin borrar ni modificar nada)
   y devuelve false. El menu puede seguir mostrandose; lo que se bloquea es pedir. */
function exigirServicio(res, restaurante, ahora) {
  const servicio = restauranteActivo(restaurante, ahora);
  if (servicio.sirve) return servicio;

  res.status(403).json({
    error: "Este restaurante no está recibiendo pedidos en este momento.",
    motivo: "servicio_suspendido"
  });
  return null;
}

/* ---------------------------------------------------------------
   SECRETOS (solo el servidor; nada de esto se cachea ni se devuelve)
--------------------------------------------------------------- */

/* Lee los secretos del restaurante, EN CADA USO (no se guardan en cache: una
   llave en memoria mas tiempo del necesario es riesgo sin beneficio; es una
   consulta pequena). Nunca imprimir ni devolver el resultado. */
async function leerSecretos(restaurante) {
  return (await leerSecretosRestaurante(restaurante.id)) || {};
}

function vacio(v) {
  return v == null || String(v).trim() === "";
}

/* Respaldo con las variables de entorno actuales: SOLO para Taqueiros y solo
   donde su secreto no este en la base. Nunca para otro restaurante. */
function conRespaldoEnv(restaurante, valorDb, nombreVariable, env) {
  if (!vacio(valorDb)) return { valor: String(valorDb).trim(), origen: "db" };

  if (restaurante.id === RESTAURANTE_TAQUEIROS_ID) {
    const v = (env || process.env)[nombreVariable];
    if (!vacio(v)) {
      avisarUnaVez("env:" + nombreVariable,
        "[Secretos] Taqueiros usa la variable de entorno " + nombreVariable + " como respaldo: cargala en restaurante_secretos (supabase/cargar-secretos.mjs).");
      return { valor: String(v).trim(), origen: "env" };
    }
  }
  return { valor: null, origen: null };
}

/* Modo de cobro (prueba o produccion) que el SERVIDOR decide.
   - Si restaurante_secretos.otros.wompi_modo es 'test' o 'produccion', manda
     eso y se ignora lo que diga el navegador (un cliente no puede pedir "test"
     para pagar con tarjetas de prueba en un restaurante real).
   - Si no esta definido, solo Taqueiros conserva lo de siempre (el modo que
     manda su pagina); cualquier otro restaurante queda sin pagos hasta que se
     configure. Devuelve "test" | "produccion" | null. */
function modoDePago(restaurante, secretos, modoDelCliente) {
  const otros = (secretos && secretos.otros) || {};
  if (otros.wompi_modo === "test" || otros.wompi_modo === "produccion") return otros.wompi_modo;
  if (restaurante.id === RESTAURANTE_TAQUEIROS_ID) {
    return modoDelCliente === "produccion" ? "produccion" : "test";
  }
  return null;
}

/* Secretos de Wompi del restaurante para un modo: { integridad, eventos } */
function secretosWompi(restaurante, secretos, modo, env) {
  const prod = modo === "produccion";
  const s = secretos || {};
  return {
    integridad: conRespaldoEnv(restaurante, prod ? s.wompi_integridad_prod : s.wompi_integridad_test,
      prod ? "WOMPI_INTEGRITY_SECRET_PROD" : "WOMPI_INTEGRITY_SECRET_TEST", env).valor,
    eventos: conRespaldoEnv(restaurante, prod ? s.wompi_eventos_prod : s.wompi_eventos_test,
      prod ? "WOMPI_EVENTS_SECRET_PROD" : "WOMPI_EVENTS_SECRET_TEST", env).valor
  };
}

/* Contacto de alertas (CallMeBot) del restaurante: { telefono, apikey } */
function contactoAlertas(restaurante, secretos, env) {
  const s = secretos || {};
  return {
    restauranteId: restaurante.id,
    telefono: conRespaldoEnv(restaurante, s.callmebot_telefono, "CALLMEBOT_PHONE", env).valor,
    apikey: conRespaldoEnv(restaurante, s.callmebot_apikey, "CALLMEBOT_APIKEY", env).valor
  };
}

module.exports = {
  RESTAURANTE_TAQUEIROS_ID,
  normalizarHost,
  resolverRestaurante,
  exigirRestaurante,
  restauranteFresco,
  restauranteActivo,
  exigirServicio,
  invalidarCache,
  leerSecretos,
  modoDePago,
  secretosWompi,
  contactoAlertas
};
