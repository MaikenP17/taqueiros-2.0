/* =============================================================
   SESION DE UN USUARIO DEL PANEL — UN SOLO LUGAR

   Valida el JWT de sesion que el panel manda en
   "Authorization: Bearer <token>" y dice a que usuario pertenece.
   Lo usan los endpoints que son solo para gente con sesion
   (reembolso hoy; el panel de superadmin despues): ninguno debe
   armar esta validacion por su cuenta.

   COMO SE VALIDA (la forma documentada por Supabase para las llaves nuevas)
     GET {SUPABASE_URL}/auth/v1/user
       apikey:        una llave del PROYECTO (la publishable sb_publishable_...;
                      si no esta en SUPABASE_PUBLISHABLE_KEY, la secreta)
       Authorization: Bearer <token del USUARIO>
   Es Supabase Auth quien comprueba la firma, la caducidad y que la sesion
   siga viva. Nada se decodifica ni se verifica a mano: con las llaves JWT
   legacy desactivadas y las firmas asimetricas (JWKS), un secreto local ya
   no sirve ni hace falta.

   LO QUE NO SE HACE
     * La llave secreta (sb_secret_...) NO va en Authorization: no es un
       JWT y el gateway rechaza la peticion. Solo va en 'apikey'.
     * El token NO se rechaza "por su forma": un JWT real tiene letras,
       digitos, '-', '_' y puntos, y su largo cambia segun los claims.
       Solo se descartan los que no pueden ser un token (vacio, con
       espacios en blanco, descomunal, o con caracteres fuera del ASCII
       imprimible, que fetch ni siquiera acepta en una cabecera y harian
       responder 500 en vez de 401) para no mandarlos a la red.

   RESULTADO de usuarioDeToken / usuarioDeSolicitud
     { id }  -> sesion valida (id en minusculas)
     null    -> sin sesion o sesion no valida (401 para quien llama)
     throws  -> Supabase Auth no pudo responder (caido, 5xx, sin red,
                llave del proyecto rechazada): NO es "sesion invalida",
                quien llama debe responder 500 y no un 401 enganoso.

   NIVEL DE GARANTIA (aal) - sesionDeToken / sesionDeSolicitud  (solo lo usa api/superadmin.js; docs seccion 23)
     { id, aal }  con aal = "aal2" si la sesion se verifico con un segundo factor TOTP y "aal1" en cualquier otro caso.
     DE DONDE SALE: /auth/v1/user NO dice el aal (devuelve el usuario, no la sesion); el aal vive en los claims del JWT de
     acceso ("aal" y "amr"), que Supabase firma. Por eso se hace en este orden y no en otro:
       1. Supabase Auth valida ESE MISMO token (firma, caducidad, sesion viva). Si no lo valida: null (401). Un JWT con la
          carga cambiada o inventado ("aal":"aal2" a mano) falla aqui, porque su firma ya no coincide.
       2. SOLO ENTONCES se lee la carga (base64url) del token ya validado. No se vuelve a verificar la firma porque no hace
          falta ni se podria mejor: el token es byte por byte el que Auth acaba de aceptar. Nunca se lee de un cuerpo,
          cabecera o parametro que mande el cliente, ni de un token que Auth no haya aceptado.
       3. Defensa en profundidad: aal2 solo si (a) "sub" de la carga es el id que Auth devolvio, (b) aal es exactamente
          "aal2" y (c) "amr" trae un metodo TOTP. Cualquier duda (carga ilegible, claim ausente, otro tipo) es aal1: se
          falla hacia lo mas estricto, nunca hacia lo mas permisivo.
     No hay variable de entorno, parametro ni cabecera que cambie esto.
============================================================= */

const { leerLlaveServicio } = require("./_llave.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LARGO_MAXIMO_TOKEN = 4096;

/* El token de "Authorization: Bearer <token>" de una peticion, o "" si no hay. */
function tokenDeSolicitud(req) {
  const cabecera = String((req && req.headers && req.headers["authorization"]) || "");
  const m = /^Bearer\s+(.+)$/i.exec(cabecera);
  return m ? m[1].trim() : "";
}

/* Llave del proyecto para la cabecera 'apikey' de /auth/v1/user. */
function llaveDeProyecto() {
  const publicable = String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  return publicable || leerLlaveServicio();
}

/* El nivel de garantia de un JWT que Supabase Auth YA valido (ver el bloque de arriba). Devuelve "aal2" o "aal1". */
function nivelDeGarantia(token, idValidado) {
  try {
    const partes = String(token).split(".");
    if (partes.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(partes[1])) return "aal1";
    const carga = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
    if (!carga || typeof carga !== "object" || Array.isArray(carga)) return "aal1";
    if (typeof carga.sub !== "string" || carga.sub.toLowerCase() !== idValidado) return "aal1";
    if (carga.aal !== "aal2") return "aal1";
    const amr = Array.isArray(carga.amr) ? carga.amr : [];
    return amr.some((m) => m && typeof m === "object" && typeof m.method === "string" && /totp/i.test(m.method)) ? "aal2" : "aal1";
  } catch (e) {
    return "aal1";
  }
}

/* Quien es el dueno de un JWT de sesion y su nivel: { id, aal } o null si el token no es valido. */
async function sesionDeToken(token) {
  const t = String(token || "").trim();
  if (!t || t.length > LARGO_MAXIMO_TOKEN || /\s/.test(t) || /[^\x21-\x7E]/.test(t)) return null;
  // Una llave de proyecto (sb_secret_..., sb_publishable_...) nunca es la sesion de un usuario (esa es un JWT, "eyJ..."): se
  // descarta antes de la red, asi no depende de lo que el gateway conteste a una llave puesta como Bearer (R9, docs 18.1).
  if (/^sb_/i.test(t)) return null;

  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  if (!url) throw new Error("Falta SUPABASE_URL en las variables de entorno");

  const resp = await fetch(`${url}/auth/v1/user`, {
    headers: { "apikey": llaveDeProyecto(), "Authorization": `Bearer ${t}` }
  });
  const texto = await resp.text();

  // La llave del PROYECTO (apikey) rechazada no es culpa del token: es una configuracion rota del
  // servidor y hay que verla como error, no disfrazarla de "inicia sesion".
  if (resp.status === 401 && /api key/i.test(texto)) {
    const err = new Error("Supabase rechazo la llave del proyecto (apikey) al validar la sesion; revisa SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY");
    err.status = 401;
    throw err;
  }
  // Token invalido, caducado o sesion cerrada: el usuario no tiene sesion.
  if (resp.status === 400 || resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) {
    // Cualquier otra cosa no es culpa del token. Sin el cuerpo: no se filtra nada de la respuesta.
    const err = new Error(`Supabase Auth no pudo validar la sesion (HTTP ${resp.status})`);
    err.status = resp.status;
    throw err;
  }

  let u = null;
  try { u = JSON.parse(texto); } catch (e) { return null; }
  if (!(u && typeof u.id === "string" && UUID.test(u.id))) return null;
  const id = u.id.toLowerCase();
  return { id, aal: nivelDeGarantia(t, id) };
}

/* Quien es el dueno de un JWT de sesion: { id } o null si no es valido (lo que usan todos los endpoints menos el superadmin). */
async function usuarioDeToken(token) {
  const s = await sesionDeToken(token);
  return s ? { id: s.id } : null;
}

/* Lo mismo, leyendo el token de la cabecera Authorization de la peticion. */
async function usuarioDeSolicitud(req) {
  const token = tokenDeSolicitud(req);
  return token ? usuarioDeToken(token) : null;
}

/* Sesion con su nivel (aal), leyendo el token de la cabecera Authorization. */
async function sesionDeSolicitud(req) {
  const token = tokenDeSolicitud(req);
  return token ? sesionDeToken(token) : null;
}

module.exports = { usuarioDeToken, usuarioDeSolicitud, tokenDeSolicitud, sesionDeToken, sesionDeSolicitud, nivelDeGarantia };
