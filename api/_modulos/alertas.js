const { consultarPedidos, actualizarPedidoPorReferencia, listarRestaurantes } = require("../_supabase.js");
const { notificarWhatsApp } = require("../_notificar.js");
const { autorizadoCron } = require("../_cron.js");
const { restauranteActivo, leerSecretos, contactoAlertas } = require("../_restaurante.js");

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
   responde 401. Se acepta SOLO por cabecera (ver _cron.js):
     Authorization: Bearer <secreto>
   El parametro ?clave=<secreto> se retiro: responde 401 aunque sea el correcto.

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

   CON MUCHOS RESTAURANTES
     * Solo se avisan pedidos pagados en las ultimas VENTANA_MINUTOS: si a un
       restaurante se le carga el contacto despues (sus pedidos nunca se
       marcaron), no le llega un aluvion de pedidos viejos.
     * Se revisan EN_PARALELO restaurantes a la vez (uno lento no frena a los
       demas) y la corrida no empieza envios pasado TIEMPO_MAXIMO_MS (Vercel
       Hobby corta la funcion a los 10 s); cada envio se acorta a lo que quede.
       Lo que no alcanza queda sin marcar y sale en la siguiente pasada; cada
       pasada empieza por un restaurante al azar para que nadie quede siempre
       de ultimo.
============================================================= */

const MINUTOS_LIMITE = 5;
const VENTANA_MINUTOS = 120;
const TIEMPO_MAXIMO_MS = 8000;
const MINIMO_PARA_ENVIAR_MS = 1500;
const EN_PARALELO = 4;

/* Los pedidos sin atender de UN restaurante, avisados a SU contacto. */
async function alertarRestaurante(restaurante, limite, desde, fin) {
  const rid = restaurante.id;
  const contacto = contactoAlertas(restaurante, await leerSecretos(restaurante));

  if (!contacto.telefono || !contacto.apikey) {
    console.log("[Alertas] Sin contacto configurado, se salta:", restaurante.slug);
    return { revisados: 0, alertados: 0 };
  }

  // Pedidos pagados, sin atender, con mas de 5 minutos (y menos de la ventana) y sin avisar
  const pendientes = await consultarPedidos(
    rid,
    `estado=eq.nuevo&alerta_enviada=is.false&pagado_en=lt.${encodeURIComponent(limite)}&pagado_en=gt.${encodeURIComponent(desde)}&select=*&order=pagado_en.asc&limit=10`
  );

  let alertados = 0;

  for (const pedido of pendientes) {
    const restante = fin - Date.now();
    if (restante < MINIMO_PARA_ENVIAR_MS) break;   // lo que falta sale en la siguiente pasada
    const espera = Math.floor((Date.now() - new Date(pedido.pagado_en).getTime()) / 60000);

    try {
      const envio = await notificarWhatsApp(pedido, {
        encabezado: `⚠️ *PEDIDO #${String(pedido.numero != null ? pedido.numero : pedido.id).padStart(3, "0")} SIN ATENDER*`,
        subtitulo: `${espera} minutos esperando`,
        tiempoMaximoMs: restante - 500
      }, contacto);

      // notificarWhatsApp no lanza: devuelve { enviado:false } si CallMeBot no lo
      // encolo (tiempo agotado, apikey invalida, red). Solo se marca lo ENVIADO,
      // para que un fallo de envio se reintente en la siguiente pasada del cron.
      if (!envio || envio.enviado !== true) continue;
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
    const inicio = Date.now();
    const fin = inicio + TIEMPO_MAXIMO_MS;
    const limite = new Date(inicio - MINUTOS_LIMITE * 60 * 1000).toISOString();
    const desde = new Date(inicio - VENTANA_MINUTOS * 60 * 1000).toISOString();
    const lista = (await listarRestaurantes()).filter((r) => restauranteActivo(r).sirve);

    // Cada pasada empieza por un restaurante al azar (nadie queda siempre de ultimo)
    const giro = Math.floor(Math.random() * lista.length);
    const restaurantes = lista.slice(giro).concat(lista.slice(0, giro));

    let revisados = 0;
    let alertados = 0;
    let sinRevisar = 0;
    let siguiente = 0;

    async function trabajador() {
      while (siguiente < restaurantes.length) {
        const restaurante = restaurantes[siguiente++];
        if (fin - Date.now() < MINIMO_PARA_ENVIAR_MS) { sinRevisar++; continue; }
        try {
          const r = await alertarRestaurante(restaurante, limite, desde, fin);
          revisados += r.revisados;
          alertados += r.alertados;
        } catch (err) {
          // Un restaurante con problemas no deja sin aviso a los demas
          console.error("[Alertas] Fallo el restaurante", restaurante.slug, err.message);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(EN_PARALELO, restaurantes.length) }, trabajador));

    console.log(`[Alertas] Restaurantes ${restaurantes.length}, revisados ${revisados}, alertados ${alertados}, sin revisar por tiempo ${sinRevisar}`);
    res.status(200).json({ restaurantes: restaurantes.length, revisados, alertados, sinRevisar });
  } catch (err) {
    console.error("[Alertas] Error:", err);
    res.status(500).json({ error: "Error revisando pedidos" });
  }
};
