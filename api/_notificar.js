/* =============================================================
   RESPALDO: comanda automatica al WhatsApp del restaurante.

   Canal principal = el panel de comandas (panel.html), que recibe
   los pedidos por Supabase Realtime. Esto es SOLO un respaldo por
   si nadie esta mirando el panel.

   Se usa CallMeBot, un servicio gratuito de un tercero:
     - No requiere cuenta de Meta Business ni verificacion.
     - El numero que RECIBE los mensajes debe autorizar al bot una
       sola vez y obtener su apikey (ver instrucciones en el README).
   Limitaciones reales: es un servicio no oficial mantenido por un
   particular, sin garantia de disponibilidad ni soporte, y con
   limite de ~1 mensaje cada pocos segundos. Por eso NUNCA debe ser
   el unico canal.

   Si no hay variables configuradas, la funcion no hace nada y no
   rompe el webhook: simplemente se omite el respaldo.
============================================================= */

const NOMBRES_TIPO = {
  domicilio: "🛵 Domicilio",
  llevar: "🥡 Para llevar",
  local: "🍽️ En el local"
};

function formatoCOP(n) {
  return "$" + Number(n).toLocaleString("es-CO");
}

/* Arma la comanda en texto plano, lista para leer en el celular. */
function construirComanda(pedido) {
  const lineas = [];

  lineas.push("🌮 *NUEVO PEDIDO PAGADO*");
  lineas.push(`Pedido #${String(pedido.id).padStart(3, "0")} · ${pedido.referencia}`);
  lineas.push("");
  lineas.push(`👤 ${pedido.cliente_nombre}`);
  lineas.push(`📞 ${pedido.cliente_telefono}`);
  lineas.push(NOMBRES_TIPO[pedido.tipo_pedido] || pedido.tipo_pedido);

  if (pedido.tipo_pedido === "domicilio") {
    lineas.push(`📍 ${pedido.direccion}, ${pedido.barrio}`);
  }
  if (pedido.indicaciones) {
    lineas.push(`📝 ${pedido.indicaciones}`);
  }

  lineas.push("");
  (pedido.items || []).forEach((it) => {
    lineas.push(`${it.cantidad}x ${it.nombre} — ${formatoCOP(it.precio * it.cantidad)}`);
  });

  lineas.push("");
  lineas.push(`💰 *TOTAL PAGADO: ${formatoCOP(pedido.total)}*`);
  lineas.push("💳 Confirmado vía Wompi");

  return lineas.join("\n");
}

async function notificarWhatsApp(pedido) {
  const telefono = process.env.CALLMEBOT_PHONE;      // ej: 573125249438
  const apikey = process.env.CALLMEBOT_APIKEY;

  if (!telefono || !apikey) {
    console.log("[Notificar] CallMeBot no está configurado, se omite el respaldo por WhatsApp");
    return { enviado: false, motivo: "sin configurar" };
  }

  const texto = construirComanda(pedido);
  const url = "https://api.callmebot.com/whatsapp.php"
    + `?phone=${encodeURIComponent(telefono)}`
    + `&text=${encodeURIComponent(texto)}`
    + `&apikey=${encodeURIComponent(apikey)}`;

  // Timeout corto: el webhook no puede quedarse colgado esperando a
  // un servicio de terceros. El pedido ya esta guardado.
  const control = new AbortController();
  const alarma = setTimeout(() => control.abort(), 8000);

  try {
    const resp = await fetch(url, { signal: control.signal });
    const cuerpo = await resp.text();

    if (!resp.ok) {
      throw new Error(`CallMeBot respondió ${resp.status}: ${cuerpo.slice(0, 200)}`);
    }

    console.log("[Notificar] Comanda enviada al WhatsApp del restaurante:", pedido.referencia);
    return { enviado: true };
  } finally {
    clearTimeout(alarma);
  }
}

module.exports = { notificarWhatsApp, construirComanda };
