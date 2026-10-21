/* =============================================================
   Cliente minimo de Supabase para las funciones del servidor.

   Usa la API REST (PostgREST) con fetch nativo en vez de la
   libreria @supabase/supabase-js, para que el proyecto siga sin
   dependencias de npm y el despliegue en Vercel no requiera build.

   Se autentica con la llave de servicio (secreta nueva o service_role
   legacy), que se salta las reglas de seguridad (RLS) de la tabla.
   Por eso esa llave vive SOLO en las variables de entorno de Vercel
   y jamas en el navegador ni en el repositorio.

   Como se envia segun el formato de la llave lo decide _llave.js.

   -------------------------------------------------------------
   MULTI-RESTAURANTE: LA REGLA DE ESTE ARCHIVO
   -------------------------------------------------------------
   Como la llave secreta se salta RLS, la base NO protege al servidor de
   si mismo: una consulta sin filtro de restaurante mezclaria menus,
   cobros o mensajes de restaurantes distintos. Por eso:

     * TODA funcion que toca una tabla de negocio (pedidos, categorias,
       productos, configuracion, salud_notificaciones, tarifas_domicilio,
       restaurante_secretos, miembros) recibe el restaurante_id como
       PRIMER argumento y lo pone en el filtro (o en el cuerpo del
       insert). Sin un id valido, lanza un error: nunca consulta "a todo".
     * Hay tres excepciones deliberadas y comentadas: buscarPedidoPorReferenciaGlobal
       (el webhook aun no sabe de que restaurante es la referencia),
       limpiarHuerfanos (barrido global de pedidos sin pagar) y las
       tablas que NO son de un restaurante (restaurantes, restaurante_dominios,
       superadmins).

   El restaurante_id se valida como UUID antes de entrar en la URL: un
   valor raro no puede colar otros filtros de PostgREST.
============================================================= */

const { cabecerasSupabase, leerLlaveServicio } = require("./_llave.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function credenciales() {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("Falta SUPABASE_URL en las variables de entorno");
  }
  const key = leerLlaveServicio();
  return { url: url.replace(/\/$/, ""), key };
}

function cabeceras(key, extra) {
  return cabecerasSupabase(key, extra);
}

/* El id de restaurante que entra a una URL de PostgREST: debe ser un UUID. */
function exigirRestauranteId(rid) {
  if (typeof rid !== "string" || !UUID.test(rid)) {
    throw new Error("Falta el restaurante_id (o no es valido): no se consulta sin restaurante");
  }
  return rid.toLowerCase();
}

/* "restaurante_id=eq.<uuid>": el filtro que va en CADA consulta de negocio. */
function filtroRestaurante(rid) {
  return `restaurante_id=eq.${exigirRestauranteId(rid)}`;
}

/* Llama a PostgREST. Lanza un Error con .status si la respuesta no es 2xx.
   El mensaje nunca incluye la llave (solo la ruta y el cuerpo de la respuesta). */
async function pedir(etiqueta, ruta, opciones) {
  const { url, key } = credenciales();
  const opts = opciones || {};
  const resp = await fetch(`${url}/rest/v1/${ruta}`, {
    method: opts.metodo || "GET",
    headers: cabeceras(key, opts.cabeceras),
    body: opts.cuerpo === undefined ? undefined : JSON.stringify(opts.cuerpo)
  });

  const texto = await resp.text();
  if (!resp.ok) {
    const err = new Error(`Supabase ${etiqueta} fallo (${resp.status}): ${texto}`);
    err.status = resp.status;
    err.cuerpo = texto;
    throw err;
  }
  return texto ? JSON.parse(texto) : null;
}

/* ---------------------------------------------------------------
   PEDIDOS
--------------------------------------------------------------- */

/* Inserta un pedido del restaurante y devuelve la fila creada.
   El restaurante_id va EXPLICITO: ya no se depende del valor por defecto
   transitorio de la base. El numero de pedido lo asigna el trigger de la
   base con el contador atomico de ESE restaurante. */
async function insertarPedido(rid, pedido) {
  const filas = await pedir("insert", "pedidos", {
    metodo: "POST",
    cabeceras: { "Prefer": "return=representation" },
    cuerpo: Object.assign({}, pedido, { restaurante_id: exigirRestauranteId(rid) })
  });
  return filas[0];
}

/* Busca un pedido por su referencia DENTRO de un restaurante.
   Devuelve null si no existe en ese restaurante. */
async function buscarPedidoPorReferencia(rid, referencia) {
  const q = encodeURIComponent(referencia);
  const filas = await pedir("select",
    `pedidos?referencia=eq.${q}&${filtroRestaurante(rid)}&select=*`);
  return filas.length ? filas[0] : null;
}

/* Busca un pedido por su referencia SIN conocer el restaurante.
   EXCEPCION DELIBERADA: el webhook de Wompi es un unico endpoint para todos
   los restaurantes y solo trae la referencia; de ella se deduce el restaurante
   (pedido.restaurante_id) y a partir de ahi todo se hace con el. La referencia
   es unica en toda la base. NO usar en ningun otro sitio. */
async function buscarPedidoPorReferenciaGlobal(referencia) {
  const q = encodeURIComponent(referencia);
  const filas = await pedir("select", `pedidos?referencia=eq.${q}&select=*&limit=2`);
  // Una referencia repetida seria un error de datos: no se elige "una cualquiera".
  if (filas.length > 1) {
    throw new Error("Referencia de pedido repetida en la base");
  }
  return filas.length ? filas[0] : null;
}

/* Actualiza un pedido identificado por su referencia, dentro de su restaurante.
   'condicion' (opcional) es un filtro FIJO de PostgREST escrito por quien llama
   (p. ej. "estado_pago=neq.aprobado"): el cambio solo se aplica si la fila lo
   cumple EN ESE INSTANTE, y si no, devuelve null. Nunca armarlo con datos de la
   peticion. */
async function actualizarPedidoPorReferencia(rid, referencia, cambios, condicion) {
  const q = encodeURIComponent(referencia);
  const extra = condicion ? `&${condicion}` : "";
  const filas = await pedir("update",
    `pedidos?referencia=eq.${q}&${filtroRestaurante(rid)}${extra}`, {
      metodo: "PATCH",
      cabeceras: { "Prefer": "return=representation" },
      cuerpo: cambios
    });
  return filas.length ? filas[0] : null;
}

/* Registra que un pedido CANCELADO y ya cobrado fue reembolsado (columna
   reembolsado_en). Es condicional y atomico: solo cambia si el pedido es de ese
   restaurante, esta cancelado, tiene el pago aprobado y todavia no tenia fecha de
   reembolso. Devuelve la fila actualizada, o null si no se cumplia alguna condicion
   (por eso dos llamadas a la vez no pueden registrarlo dos veces). */
async function marcarReembolsado(rid, referencia, momento) {
  const q = encodeURIComponent(referencia);
  const filas = await pedir("reembolso",
    `pedidos?referencia=eq.${q}&${filtroRestaurante(rid)}&estado=eq.cancelado&estado_pago=eq.aprobado&reembolsado_en=is.null`, {
      metodo: "PATCH",
      cabeceras: { "Prefer": "return=representation" },
      cuerpo: { reembolsado_en: (momento || new Date()).toISOString() }
    });
  return filas.length ? filas[0] : null;
}

/* Busca pedidos del restaurante con un filtro libre de PostgREST.
   Ej: consultarPedidos(rid, "estado=eq.nuevo&alerta_enviada=is.false") */
async function consultarPedidos(rid, filtro) {
  return pedir("consulta", `pedidos?${filtro}&${filtroRestaurante(rid)}`);
}

/* Borra los pedidos que nunca se pagaron y llevan mas de 'horas' ahi.
   Devuelve cuantos borro.

   GLOBAL A PROPOSITO: la funcion de la base (limpiar_pedidos_huerfanos) barre
   toda la tabla y solo toca filas que ya nunca se van a cobrar
   (estado pendiente_pago, estado_pago pendiente, sin pagado_en, de mas de
   'horas'), de cualquier restaurante. No lee ni modifica nada de nadie mas y
   solo el servidor la puede ejecutar (SQL 10, paso 8.2). */
async function limpiarHuerfanos(horas) {
  return pedir("limpieza", "rpc/limpiar_pedidos_huerfanos", {
    metodo: "POST",
    cuerpo: { horas: horas || 24 }
  });
}

/* ---------------------------------------------------------------
   CONFIGURACION Y SALUD DEL WHATSAPP (una fila por restaurante)
--------------------------------------------------------------- */

/* Lee la fila de configuracion del restaurante (horarios, cerrado temporal...).
   Se filtra por restaurante_id, NO por id=1: la fila de Taqueiros es id=1 y las
   de los demas id=0. */
async function leerConfiguracion(rid) {
  const filas = await pedir("configuracion",
    `configuracion?${filtroRestaurante(rid)}&select=*`);
  return filas.length ? filas[0] : null;
}

/* Registra como salio el ultimo envio de WhatsApp automatico de ESE restaurante.
   El panel lee esta fila para avisar cuando el servicio esta caido. */
async function registrarSaludNotificacion(rid, ok, mensajeError) {
  // Los fallos se cuentan de forma acumulada; un envio bueno reinicia
  // el contador. Asi el panel puede distinguir un fallo puntual de un
  // servicio realmente caido.
  let fallosSeguidos = 0;
  if (!ok) {
    try {
      const filas = await pedir("salud",
        `salud_notificaciones?${filtroRestaurante(rid)}&select=fallos_seguidos`);
      fallosSeguidos = (filas[0] ? filas[0].fallos_seguidos : 0) + 1;
    } catch (e) {
      fallosSeguidos = 1;
    }
  }

  await pedir("salud", `salud_notificaciones?${filtroRestaurante(rid)}`, {
    metodo: "PATCH",
    cuerpo: {
      ultimo_intento: new Date().toISOString(),
      ultimo_ok: ok,
      ultimo_error: ok ? null : String(mensajeError || "").slice(0, 300),
      fallos_seguidos: fallosSeguidos
    }
  });
}

/* ---------------------------------------------------------------
   TABLAS DE NEGOCIO GENERICAS (menu, tarifas, miembros...)
--------------------------------------------------------------- */

/* Consulta a una tabla de negocio, SIEMPRE acotada al restaurante.
   Ej: consultarTabla(rid, "productos", "select=*&order=orden") */
async function consultarTabla(rid, tabla, filtro) {
  if (!/^[a-z_]+$/.test(String(tabla))) {
    throw new Error("Nombre de tabla invalido");
  }
  return pedir(tabla, `${tabla}?${filtro}&${filtroRestaurante(rid)}`);
}

/* Tarifas de domicilio del restaurante, de menor a mayor rango. */
async function leerTarifasDomicilio(rid) {
  return pedir("tarifas_domicilio",
    `tarifas_domicilio?select=hasta,precio&${filtroRestaurante(rid)}&order=hasta.asc`);
}

/* Fila de restaurante_secretos del restaurante, o null. SOLO el servidor puede
   leerla (RLS sin politicas). Quien la use no debe imprimirla ni devolverla. */
async function leerSecretosRestaurante(rid) {
  const filas = await pedir("secretos",
    `restaurante_secretos?${filtroRestaurante(rid)}&select=*`);
  return filas.length ? filas[0] : null;
}

/* ---------------------------------------------------------------
   TABLAS QUE NO SON DE UN RESTAURANTE
--------------------------------------------------------------- */

/* Columnas del restaurante que el servidor usa. Nunca incluye secretos
   (esos viven en otra tabla). */
const COLUMNAS_RESTAURANTE =
  "id,slug,nombre,estado,plan,modalidad_pago,vigente_hasta,dias_gracia,modulos,zona_horaria,hora_corte_jornada,config";

async function restauranteDeFila(filtro) {
  const filas = await pedir("restaurantes",
    `restaurantes?${filtro}&select=${COLUMNAS_RESTAURANTE}&limit=1`);
  return filas.length ? filas[0] : null;
}

async function buscarRestaurantePorId(id) {
  return restauranteDeFila(`id=eq.${exigirRestauranteId(id)}`);
}

async function buscarRestaurantePorSlug(slug) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(slug))) return null;
  return restauranteDeFila(`slug=eq.${slug}`);
}

/* Restaurante dueno de un host (tabla restaurante_dominios, SQL 11), o null.
   Lanza el error de PostgREST si la tabla aun no existe (ver _restaurante.js). */
async function buscarRestaurantePorHost(host) {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(String(host)) || host.length > 253) return null;
  const filas = await pedir("restaurante_dominios",
    `restaurante_dominios?host=eq.${encodeURIComponent(host)}&select=restaurante_id&limit=1`);
  if (!filas.length) return null;
  return buscarRestaurantePorId(filas[0].restaurante_id);
}

/* Todos los restaurantes (para los crons: alertas). */
async function listarRestaurantes() {
  return pedir("restaurantes",
    `restaurantes?select=${COLUMNAS_RESTAURANTE}&order=creado_en.asc`);
}

/* El usuario es superadmin? (tabla global, sin restaurante_id) */
async function esSuperadmin(userId) {
  if (typeof userId !== "string" || !UUID.test(userId)) return false;
  const filas = await pedir("superadmins", `superadmins?user_id=eq.${userId.toLowerCase()}&select=user_id&limit=1`);
  return filas.length > 0;
}

/* (La validacion de la sesion de un usuario vive en _sesion.js, un solo lugar.) */

/* La consulta mas liviana que existe: sirve para que Supabase cuente el
   proyecto como activo. Toca una tabla que no es de negocio. */
async function pingBase() {
  await pedir("ping", "restaurantes?select=id&limit=1");
}

module.exports = {
  exigirRestauranteId,
  filtroRestaurante,
  insertarPedido,
  consultarTabla,
  registrarSaludNotificacion,
  limpiarHuerfanos,
  buscarPedidoPorReferencia,
  buscarPedidoPorReferenciaGlobal,
  actualizarPedidoPorReferencia,
  leerConfiguracion,
  consultarPedidos,
  leerTarifasDomicilio,
  leerSecretosRestaurante,
  buscarRestaurantePorId,
  buscarRestaurantePorSlug,
  buscarRestaurantePorHost,
  listarRestaurantes,
  esSuperadmin,
  marcarReembolsado,
  pingBase,
  COLUMNAS_RESTAURANTE
};
