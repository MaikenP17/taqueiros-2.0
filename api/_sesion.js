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

/* Quien es el dueno de un JWT de sesion: { id } o null si no es valido. */
async function usuarioDeToken(token) {
  const t = String(token || "").trim();
  if (!t || t.length > LARGO_MAXIMO_TOKEN || /\s/.test(t) || /[^\x21-\x7E]/.test(t)) return null;

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
  return u && typeof u.id === "string" && UUID.test(u.id) ? { id: u.id.toLowerCase() } : null;
}

/* Lo mismo, leyendo el token de la cabecera Authorization de la peticion. */
async function usuarioDeSolicitud(req) {
  const token = tokenDeSolicitud(req);
  return token ? usuarioDeToken(token) : null;
}

module.exports = { usuarioDeToken, usuarioDeSolicitud, tokenDeSolicitud };
