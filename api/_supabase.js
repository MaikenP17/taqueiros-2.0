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

/* Lee la fila unica de configuracion (horarios del restaurante). */
async function leerConfiguracion() {
  const { url, key } = credenciales();
  const resp = await fetch(`${url}/rest/v1/configuracion?id=eq.1&select=*`, {
    headers: cabeceras(key)
  });

  const texto = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase configuracion fallo (${resp.status}): ${texto}`);
  }
  const filas = JSON.parse(texto);
  return filas.length ? filas[0] : null;
}

/* Busca pedidos con un filtro libre de PostgREST.
   Ej: consultarPedidos("estado=eq.nuevo&alerta_enviada=is.false") */
async function consultarPedidos(filtro) {
  const { url, key } = credenciales();
  const resp = await fetch(`${url}/rest/v1/pedidos?${filtro}`, {
    headers: cabeceras(key)
  });

  const texto = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase consulta fallo (${resp.status}): ${texto}`);
  }
  return JSON.parse(texto);
}

/* Borra los pedidos que nunca se pagaron y llevan mas de 'horas'
   ahi. Devuelve cuantos borro. */
async function limpiarHuerfanos(horas) {
  const { url, key } = credenciales();
  const resp = await fetch(`${url}/rest/v1/rpc/limpiar_pedidos_huerfanos`, {
    method: "POST",
    headers: cabeceras(key),
    body: JSON.stringify({ horas: horas || 24 })
  });

  const texto = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase limpieza fallo (${resp.status}): ${texto}`);
  }
  return JSON.parse(texto);
}

/* Registra como salio el ultimo envio de WhatsApp automatico.
   El panel lee esta fila para avisar cuando el servicio esta caido. */
async function registrarSaludNotificacion(ok, mensajeError) {
  const { url, key } = credenciales();

  // Los fallos se cuentan de forma acumulada; un envio bueno reinicia
  // el contador. Asi el panel puede distinguir un fallo puntual de un
  // servicio realmente caido.
  let fallosSeguidos = 0;
  if (!ok) {
    try {
      const actual = await fetch(`${url}/rest/v1/salud_notificaciones?id=eq.1&select=fallos_seguidos`, {
        headers: cabeceras(key)
      });
      const filas = JSON.parse(await actual.text());
      fallosSeguidos = (filas[0] ? filas[0].fallos_seguidos : 0) + 1;
    } catch (e) {
      fallosSeguidos = 1;
    }
  }

  const resp = await fetch(`${url}/rest/v1/salud_notificaciones?id=eq.1`, {
    method: "PATCH",
    headers: cabeceras(key),
    body: JSON.stringify({
      ultimo_intento: new Date().toISOString(),
      ultimo_ok: ok,
      ultimo_error: ok ? null : String(mensajeError || "").slice(0, 300),
      fallos_seguidos: fallosSeguidos
    })
  });

  if (!resp.ok) {
    throw new Error(`Supabase salud fallo (${resp.status}): ${await resp.text()}`);
  }
}

module.exports = {
  insertarPedido,
  registrarSaludNotificacion,
  limpiarHuerfanos,
  buscarPedidoPorReferencia,
  actualizarPedidoPorReferencia,
  leerConfiguracion,
  consultarPedidos
};
