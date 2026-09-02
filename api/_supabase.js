/* =============================================================
   Cliente minimo de Supabase para las funciones del servidor.

   Usa la API REST (PostgREST) con fetch nativo en vez de la
   libreria @supabase/supabase-js, para que el proyecto siga sin
   dependencias de npm y el despliegue en Vercel no requiera build.

   Se autentica con la SERVICE ROLE KEY, que se salta las reglas
   de seguridad (RLS) de la tabla. Por eso esa llave vive SOLO en
   las variables de entorno de Vercel y jamas en el navegador.
============================================================= */

function credenciales() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno");
  }
  return { url: url.replace(/\/$/, ""), key };
}

function cabeceras(key, extra) {
  return Object.assign({
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json"
  }, extra || {});
}

/* Inserta un pedido y devuelve la fila creada. */
async function insertarPedido(pedido) {
  const { url, key } = credenciales();
  const resp = await fetch(`${url}/rest/v1/pedidos`, {
    method: "POST",
    headers: cabeceras(key, { "Prefer": "return=representation" }),
    body: JSON.stringify(pedido)
  });

  const texto = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase insert fallo (${resp.status}): ${texto}`);
  }
  const filas = JSON.parse(texto);
  return filas[0];
}

/* Busca un pedido por su referencia. Devuelve null si no existe. */
async function buscarPedidoPorReferencia(referencia) {
  const { url, key } = credenciales();
  const q = encodeURIComponent(referencia);
  const resp = await fetch(`${url}/rest/v1/pedidos?referencia=eq.${q}&select=*`, {
    headers: cabeceras(key)
  });

  const texto = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase select fallo (${resp.status}): ${texto}`);
  }
  const filas = JSON.parse(texto);
  return filas.length ? filas[0] : null;
}

/* Actualiza un pedido identificado por su referencia. */
async function actualizarPedidoPorReferencia(referencia, cambios) {
  const { url, key } = credenciales();
  const q = encodeURIComponent(referencia);
  const resp = await fetch(`${url}/rest/v1/pedidos?referencia=eq.${q}`, {
    method: "PATCH",
    headers: cabeceras(key, { "Prefer": "return=representation" }),
    body: JSON.stringify(cambios)
  });

  const texto = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase update fallo (${resp.status}): ${texto}`);
  }
  const filas = JSON.parse(texto);
  return filas.length ? filas[0] : null;
}

module.exports = { insertarPedido, buscarPedidoPorReferencia, actualizarPedidoPorReferencia };
