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

/* Precio SIN el simbolo "$", a proposito.
   -------------------------------------------------------------
   BUG QUE ESTO EVITA: CallMeBot entrega los mensajes recortando
   el "$" junto con el digito que le sigue, asi que "$28.000"
   llegaba al WhatsApp como "8.000" y "$5.000" como ".000".
   Es la firma tipica de un texto usado como cadena de reemplazo
   en una expresion regular, donde "$2", "$1", "$5"... se toman
   como referencias a grupos de captura y se sustituyen por vacio.
   Ocurre dentro del servidor de CallMeBot: nuestro mensaje sale
   integro y con la codificacion correcta (verificado).

   Como no podemos arreglar su servidor, aqui simplemente no se
   manda el simbolo. El numero llega completo, que es lo que
   importa para leer la comanda.

   OJO: esto aplica SOLO al mensaje de WhatsApp. En panel.html y
   pedido.html los precios siguen con "$" porque ahi se muestran
   bien.
------------------------------------------------------------- */
function formatoPrecio(n) {
  return Number(n).toLocaleString("es-CO");
}

/* Arma la comanda en texto plano, lista para leer en el celular.
   Los asteriscos son el formato de negrita de WhatsApp. */
function construirComanda(pedido) {
  const lineas = [];

  lineas.push("\u{1F32E} *NUEVO PEDIDO PAGADO*");
  lineas.push(`Pedido #${String(pedido.id).padStart(3, "0")} \u00b7 ${pedido.referencia}`);
  lineas.push("");

  lineas.push(`\u{1F464} ${pedido.cliente_nombre}`);
  lineas.push(`\u{1F4DE} ${pedido.cliente_telefono}`);
  lineas.push(NOMBRES_TIPO[pedido.tipo_pedido] || pedido.tipo_pedido);

  if (pedido.tipo_pedido === "domicilio") {
    lineas.push(`\u{1F4CD} ${pedido.direccion}, ${pedido.barrio}`);
  }
  if (pedido.indicaciones) {
    lineas.push(`\u{1F4DD} ${pedido.indicaciones}`);
  }

  lineas.push("");

  (pedido.items || []).forEach((it) => {
    lineas.push(`${it.cantidad}x ${it.nombre} \u2014 ${formatoPrecio(it.precio * it.cantidad)}`);
  });

  if (pedido.tipo_pedido === "domicilio") {
    if (pedido.fuera_de_cobertura) {
      lineas.push("");
      lineas.push("\u26A0\uFE0F FUERA DE ZONA"
        + (pedido.distancia_km != null ? " (" + pedido.distancia_km + " km)" : "")
        + " \u2014 cobrar el domicilio aparte");
    } else if (Number(pedido.costo_domicilio) > 0) {
      lineas.push("\u{1F6F5} Domicilio"
        + (pedido.distancia_km != null ? " (" + pedido.distancia_km + " km)" : "")
        + " \u2014 " + formatoPrecio(pedido.costo_domicilio));
    }
  }

  lineas.push("");
  lineas.push(`\u{1F4B0} *TOTAL PAGADO: ${formatoPrecio(pedido.total)}*`);
  lineas.push("\u{1F4B3} Confirmado v\u00eda Wompi");

  // El mapa va al final: es lo que el domiciliario abre de un toque.
  if (pedido.tipo_pedido === "domicilio" && pedido.lat != null && pedido.lng != null) {
    lineas.push("\u{1F5FA}\uFE0F https://www.google.com/maps/search/?api=1&query="
      + pedido.lat + "," + pedido.lng);
  }

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
