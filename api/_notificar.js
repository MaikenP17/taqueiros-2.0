/* =============================================================
   RESPALDO: comanda automatica al WhatsApp del restaurante.

   Canal principal = el panel de comandas (panel.html), que recibe
   los pedidos por Supabase Realtime. Esto es SOLO un respaldo por
   si nadie esta mirando el panel.

   Se usa CallMeBot, un servicio gratuito de un tercero. No requiere
   cuenta de Meta Business ni verificacion.

   -------------------------------------------------------------
   COMO ACTIVARLO CUANDO CAMBIE EL NUMERO DEL RESTAURANTE
   -------------------------------------------------------------
   La apikey queda atada al numero que autorizo al bot. Si el
   restaurante cambia de numero, la apikey vieja DEJA DE SERVIR y
   hay que repetir esto:

     1. En el celular del NUEVO numero, guarda en contactos:
            +34 623 78 95 80
     2. Desde WhatsApp de ese numero, enviale este texto exacto:
            I allow callmebot to send me messages
     3. En un par de minutos responde:
            "API Activated for your phone number. Your APIKEY is 123456"
        Si no responde en ~10 minutos, hay que reintentar mas tarde
        (el servicio a veces tarda o ignora el primer intento).
     4. En Vercel -> Settings -> Environment Variables, actualiza:
            CALLMEBOT_PHONE  = el numero nuevo en formato 57XXXXXXXXXX
            CALLMEBOT_APIKEY = la apikey que respondio el bot
     5. Vercel -> Deployments -> ... -> Redeploy.

   NO hay que tocar codigo: ambos valores son variables de entorno.

   OJO, son dos numeros distintos y no deben confundirse:
     - CALLMEBOT_PHONE: quien RECIBE las comandas automaticas.
     - WHATSAPP_NUMBER (en index.html): el numero de contacto que
       ve el cliente en la pagina. Ese es otro y se cambia aparte.

   -------------------------------------------------------------
   LIMITACIONES REALES
   -------------------------------------------------------------
   Es un servicio no oficial mantenido por un particular, sin
   garantia de disponibilidad ni soporte, y su licencia dice "solo
   para uso personal". Por eso NUNCA debe ser el unico canal: el
   canal principal es el panel de comandas.

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

  if (pedido.tipo_pedido === "domicilio") {
    if (pedido.fuera_de_cobertura) {
      lineas.push("");
      lineas.push("⚠️ FUERA DE ZONA"
        + (pedido.distancia_km != null ? " (" + pedido.distancia_km + " km)" : "")
        + " — cobrar el domicilio aparte");
    } else if (Number(pedido.costo_domicilio) > 0) {
      lineas.push("🛵 Domicilio"
        + (pedido.distancia_km != null ? " (" + pedido.distancia_km + " km)" : "")
        + " — " + formatoCOP(pedido.costo_domicilio));
    }
    if (pedido.lat != null && pedido.lng != null) {
      lineas.push("🗺️ https://www.google.com/maps/search/?api=1&query="
        + pedido.lat + "," + pedido.lng);
    }
  }

  lineas.push("");
  lineas.push(`💰 *TOTAL PAGADO: ${formatoCOP(pedido.total)}*`);
  lineas.push("💳 Confirmado vía Wompi");

  return lineas.join("\n");
}

async function notificarWhatsApp(pedido) {
  const telefono = process.env.CALLMEBOT_PHONE;      // formato: 57XXXXXXXXXX
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
