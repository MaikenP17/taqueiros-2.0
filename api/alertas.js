const { consultarPedidos, actualizarPedidoPorReferencia, listarRestaurantes } = require("./_supabase.js");
const { notificarWhatsApp } = require("./_notificar.js");
const { autorizadoCron } = require("./_cron.js");
const { restauranteActivo, leerSecretos, contactoAlertas } = require("./_restaurante.js");

/* =============================================================
   ALERTA DE PEDIDOS SIN ATENDER

   Lo dispara un cron cada 2 minutos. Busca pedidos que llevan mas
   de MINUTOS_LIMITE en estado 'nuevo' (o sea: pagados y que nadie
   ha tocado) y manda un aviso al WhatsApp del restaurante.

   Cada pedido se avisa UNA sola vez: al enviarlo se marca la
   columna 'alerta_enviada'. Asi el cron puede correr cada 2 minutos
   sin convertirse en spam.

   COMO SE PROTEGE
   La URL es publica, asi que exige un secreto (CRON_SECRET). Sin el
   responde 401. Se acepta de dos formas (ver _cron.js):
     - cabecera:  Authorization: Bearer <secreto>   (preferida)
     - parametro: ?clave=<secreto>                   (se mantiene por ahora)

   MULTI-RESTAURANTE
   El cron no tiene host: recorre los restaurantes que estan sirviendo
   (activos, en prueba o en gracia; no los suspendidos) y, para cada uno:
     - busca SOLO sus pedidos sin atender (filtro por restaurante_id),
     - avisa SOLO a su propio contacto (CallMeBot de su fila en
       restaurante_secretos; Taqueiros usa las variables de entorno de
       respaldo mientras no las cargue alla),
     - registra la salud del WhatsApp en su propia fila,
     - marca alerta_enviada solo en sus pedidos.
   Un restaurante sin contacto configurado se salta (y sus pedidos NO se
   marcan como avisados). El fallo de un restaurante no detiene a los demas.
============================================================= */

const MINUTOS_LIMITE = 5;

/* Los pedidos sin atender de UN restaurante, avisados a SU contacto. */
async function alertarRestaurante(restaurante, limite) {
  const rid = restaurante.id;
  const contacto = contactoAlertas(restaurante, await leerSecretos(restaurante));

  if (!contacto.telefono || !contacto.apikey) {
    console.log("[Alertas] Sin contacto configurado, se salta:", restaurante.slug);
    return { revisados: 0, alertados: 0 };
  }

  // Pedidos pagados, sin atender, con mas de 5 minutos y sin avisar
  const pendientes = await consultarPedidos(
    rid,
    `estado=eq.nuevo&alerta_enviada=is.false&pagado_en=lt.${encodeURIComponent(limite)}&select=*&order=pagado_en.asc&limit=10`
  );

  let alertados = 0;

  for (const pedido of pendientes) {
    const espera = Math.floor((Date.now() - new Date(pedido.pagado_en).getTime()) / 60000);

    try {
      await notificarWhatsApp(pedido, {
        encabezado: `⚠️ *PEDIDO #${String(pedido.id).padStart(3, "0")} SIN ATENDER*`,
        subtitulo: `${espera} minutos esperando`
      }, contacto);

      // Se marca DESPUES de enviar, para que un fallo de envio
      // permita reintentar en la siguiente pasada del cron.
      await actualizarPedidoPorReferencia(rid, pedido.referencia, { alerta_enviada: true });
      alertados++;
    } catch (err) {
      console.error("[Alertas] No se pudo avisar del pedido", pedido.referencia, err.message);
    }
  }

  return { revisados: pendientes.length, alertados };
}

module.exports = async (req, res) => {
  if (!autorizadoCron(req)) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  try {
    const limite = new Date(Date.now() - MINUTOS_LIMITE * 60 * 1000).toISOString();
    const restaurantes = (await listarRestaurantes()).filter((r) => restauranteActivo(r).sirve);

    let revisados = 0;
    let alertados = 0;

    for (const restaurante of restaurantes) {
      try {
        const r = await alertarRestaurante(restaurante, limite);
        revisados += r.revisados;
        alertados += r.alertados;
      } catch (err) {
        // Un restaurante con problemas no deja sin aviso a los demas
        console.error("[Alertas] Fallo el restaurante", restaurante.slug, err.message);
      }
    }

    console.log(`[Alertas] Restaurantes ${restaurantes.length}, revisados ${revisados}, alertados ${alertados}`);
    res.status(200).json({ restaurantes: restaurantes.length, revisados, alertados });
  } catch (err) {
    console.error("[Alertas] Error:", err);
    res.status(500).json({ error: "Error revisando pedidos" });
  }
};
