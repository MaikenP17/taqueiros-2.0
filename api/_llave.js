/* =============================================================
   LLAVE DE SERVICIO DE SUPABASE — UN SOLO LUGAR

   Supabase tiene dos formatos de llave y se envian distinto:

     LEGACY   JWT largo ("eyJ...") con role=service_role.
              Va en 'apikey' Y en 'Authorization: Bearer'.

     NUEVA    "sb_secret_..." (o "sb_publishable_..." en el front).
              NO es un JWT. Va SOLO en 'apikey'. Mandarla tambien
              como Bearer hace que el gateway intente leerla como
              JWT y rechace la peticion.

   La variable de entorno sigue llamandose SUPABASE_SERVICE_ROLE_KEY
   y acepta cualquiera de las dos. Cambiar de una a otra en Vercel
   no requiere tocar codigo.

   Lo usan api/_supabase.js (todo el servidor) y los scripts de
   supabase/*.js, para que ninguno arme los encabezados por su cuenta.
============================================================= */

const NOMBRE_VARIABLE = "SUPABASE_SERVICE_ROLE_KEY";

/* "secreta" | "publicable" | "legacy" (JWT) */
function tipoDeLlave(key) {
  const k = String(key || "").trim();
  if (k.startsWith("sb_secret_")) return "secreta";
  if (k.startsWith("sb_publishable_")) return "publicable";
  return "legacy";
}

/* Encabezados para hablar con PostgREST / Storage con esa llave. */
function cabecerasSupabase(key, extra) {
  const k = String(key || "").trim();
  const base = { "apikey": k, "Content-Type": "application/json" };

  // Solo las legacy son JWT y van tambien como Bearer
  if (tipoDeLlave(k) === "legacy") {
    base["Authorization"] = `Bearer ${k}`;
  }

  return Object.assign(base, extra || {});
}

/* Lee la llave de servicio del entorno. Lanza un error claro (sin
   incluir el valor) si falta o es de un tipo que no sirve aqui. */
function leerLlaveServicio(env) {
  const origen = env || process.env;
  const key = String(origen[NOMBRE_VARIABLE] || "").trim();

  if (!key) {
    throw new Error(`Falta ${NOMBRE_VARIABLE} en las variables de entorno`);
  }

  // Una llave publicable no se salta RLS: el servidor fallaria de
  // formas confusas (pedidos que no se guardan). Mejor avisar claro.
  if (tipoDeLlave(key) === "publicable") {
    throw new Error(`${NOMBRE_VARIABLE} contiene una llave publicable (sb_publishable_...). Debe ser la secreta (sb_secret_...) o la service_role legacy`);
  }

  return key;
}

module.exports = { tipoDeLlave, cabecerasSupabase, leerLlaveServicio, NOMBRE_VARIABLE };
