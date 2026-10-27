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
     4. Guarda los dos valores en la fila del restaurante en la tabla
        restaurante_secretos (columnas callmebot_telefono y callmebot_apikey;
        con supabase/cargar-secretos.mjs). Formato del telefono: 57XXXXXXXXXX.
        (Mientras no esten ahi, SOLO Taqueiros usa de respaldo las variables
        de entorno CALLMEBOT_PHONE y CALLMEBOT_APIKEY de Vercel.)

   NO hay que tocar codigo ni redesplegar: se leen en cada envio.

   MULTI-RESTAURANTE: cada restaurante avisa SOLO a su propio contacto. El
   contacto llega como tercer argumento de notificarWhatsApp y debe ser el del
   mismo restaurante que el pedido; si no coincide, se lanza un error y no se
   envia nada (un pedido jamas sale por el WhatsApp de otro restaurante).

   OJO, son dos numeros distintos y no deben confundirse:
     - CALLMEBOT_PHONE: quien RECIBE las comandas automaticas.
     - WHATSAPP_NUMBER (en index.html): el numero de contacto que
       ve el cliente en la pagina. Ese es otro y se cambia aparte.

   -------------------------------------------------------------
   CANAL DE RESPALDO: EVALUADO Y DESCARTADO POR AHORA
   -------------------------------------------------------------
   Se evaluo agregar un segundo canal que se disparara solo cuando
   CallMeBot falle. Opciones y por que no se implemento ninguna:

     * TELEGRAM (era la recomendacion tecnica). API oficial, gratis,
       sin limites practicos, sin verificacion de Meta, y su
       fiabilidad no depende de un particular. Se descarto porque
       obliga al restaurante a instalar otra app, y en el momento de
       la decision el proyecto aun no estaba aceptado por ellos:
       anadia friccion a la presentacion.

     * CORREO (Resend, gratis hasta 3.000/mes). Fiable, pero nadie en
       una cocina revisa el correo en tiempo real. No resuelve el
       problema que importa: enterarse YA de un pedido.

     * WHATSAPP BUSINESS API (via Twilio). Lo mas solido y llega al
       mismo WhatsApp, sin friccion. Cuesta ~USD 0,005 por mensaje y
       exige verificar la empresa con Meta. Solo se justifica con
       volumen.

   COMO ACTIVAR TELEGRAM SI ALGUN DIA SE DECIDE:
     1. En Telegram, escribirle a @BotFather -> /newbot -> queda un
        token tipo 123456:AAG...
     2. El restaurante le escribe algo al bot, y luego se consulta
        https://api.telegram.org/bot<TOKEN>/getUpdates para sacar el
        chat id de la conversacion.
     3. Guardar TELEGRAM_TOKEN y TELEGRAM_CHAT_ID en Vercel.
     4. Aqui abajo, en notificarWhatsApp, cuando el envio falle
        (donde ya se llama a registrarSaludNotificacion con false),
        hacer un GET a:
        https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=<texto>
        El texto ya viene armado en la variable 'texto', no hay que
        construir nada nuevo.

   Mientras tanto el aviso vive en el panel: si el ultimo envio
   fallo, el restaurante ve una advertencia en la cabecera y sabe
   que solo puede confiar en la pantalla.

   -------------------------------------------------------------
   LIMITACIONES REALES
   -------------------------------------------------------------
   Es un servicio no oficial mantenido por un particular, sin
   garantia de disponibilidad ni soporte, y su licencia dice "solo
   para uso personal". Por eso NUNCA debe ser el unico canal: el
   canal principal es el panel de comandas.

   Si el restaurante no tiene contacto configurado, la funcion no hace nada y no
   rompe el webhook: simplemente se omite el respaldo.
============================================================= */

const { registrarSaludNotificacion } = require("./_supabase.js");

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

/* Los textos que escribio el CLIENTE van en una sola linea: un salto de linea
   en el nombre o la direccion fabricaria en la comanda una linea con la forma
   de un producto ("9x Taco - 90.000") que la cocina prepararia sin estar pagada. */
function unaLinea(texto) {
  return String(texto == null ? "" : texto).replace(/[\r\n]+/g, " ").trim();
}

/* Arma la comanda en texto plano, lista para leer en el celular.
   Los asteriscos son el formato de negrita de WhatsApp. */
function construirComanda(pedido, opciones) {
  const lineas = [];
  const op = opciones || {};

  // Por defecto es una comanda nueva; las alertas de pedidos sin
  // atender reutilizan el mismo formato con otro encabezado.
  lineas.push(op.encabezado || "\u{1F354} *NUEVO PEDIDO PAGADO*");
  // El numero que ve el restaurante es el de SU contador (pedidos.numero), no el id global de la tabla.
  lineas.push(`Pedido #${String(pedido.numero != null ? pedido.numero : pedido.id).padStart(3, "0")} \u00b7 ${pedido.referencia}`);
  if (op.subtitulo) lineas.push(`\u23F1 ${op.subtitulo}`);
  lineas.push("");

  lineas.push(`\u{1F464} ${unaLinea(pedido.cliente_nombre)}`);
  lineas.push(`\u{1F4DE} ${unaLinea(pedido.cliente_telefono)}`);
  lineas.push(NOMBRES_TIPO[pedido.tipo_pedido] || pedido.tipo_pedido);

  if (pedido.tipo_pedido === "domicilio") {
    lineas.push(`\u{1F4CD} ${unaLinea(pedido.direccion)}, ${unaLinea(pedido.barrio)}`);
  }
  if (pedido.indicaciones) {
    // Las indicaciones pueden traer varias lineas: CADA una va marcada como nota
    String(pedido.indicaciones).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .forEach((l) => lineas.push(`\u{1F4DD} ${l}`));
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

/* 'contacto' = { restauranteId, telefono, apikey } del restaurante DEL PEDIDO
   (ver contactoAlertas en _restaurante.js).
   'opciones.tiempoMaximoMs' acorta la espera a CallMeBot (por defecto 8 s): el
   cron de alertas la usa para no pasarse del limite de tiempo de Vercel. */
async function notificarWhatsApp(pedido, opciones, contacto) {
  const c = contacto || {};
  const espera = Math.max(500, Math.min(8000, Number(opciones && opciones.tiempoMaximoMs) || 8000));

  // Defensa en profundidad: el aviso de un restaurante solo puede salir por
  // el contacto de ese mismo restaurante.
  if (!pedido || !pedido.restaurante_id || !c.restauranteId || pedido.restaurante_id !== c.restauranteId) {
    throw new Error("El contacto de avisos no es del restaurante del pedido");
  }

  const telefono = c.telefono;      // formato: 57XXXXXXXXXX
  const apikey = c.apikey;

  if (!telefono || !apikey) {
    console.log("[Notificar] CallMeBot no esta configurado para este restaurante, se omite el respaldo por WhatsApp");
    return { enviado: false, motivo: "sin configurar" };
  }

  const texto = construirComanda(pedido, opciones);
  const url = "https://api.callmebot.com/whatsapp.php"
    + `?phone=${encodeURIComponent(telefono)}`
    + `&text=${encodeURIComponent(texto)}`
    + `&apikey=${encodeURIComponent(apikey)}`;

  // Timeout corto: el webhook no puede quedarse colgado esperando a
  // un servicio de terceros. El pedido ya esta guardado.
  const control = new AbortController();
  const alarma = setTimeout(() => control.abort(), espera);

  let ok = false;
  let detalleError = null;

  try {
    const resp = await fetch(url, { signal: control.signal });
    const cuerpo = await resp.text();
    const limpio = cuerpo.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

    /* Como se sabe si de verdad se envio:
         apikey valida   -> HTTP 200 + "Message queued. You will receive it..."
         apikey invalida -> HTTP 203 + "APIKey is invalid..."

       Dos trampas comprobadas en vivo:
         1. Un fallo NO devuelve un codigo de error: devuelve 203, que
            fetch considera exitoso. Por eso se compara con 200 exacto.
         2. El texto "Message to: +57..." aparece en AMBAS respuestas
            (es solo el eco de lo que se pidio), asi que NO sirve como
            senal de exito.

       Por eso se exige una senal POSITIVA de que quedo encolado, en
       vez de intentar adivinar los mensajes de error. */
    if (resp.status === 200 && /queued|message sent/i.test(limpio)) {
      ok = true;
    } else {
      // La respuesta empieza repitiendo el mensaje que se quiso
      // enviar y termina con el motivo real. Se toma el final, que es
      // lo unico que sirve para diagnosticar.
      const motivo = limpio.slice(-160).trim();
      detalleError = `CallMeBot respondio ${resp.status}: ...${motivo}`;
    }
  } catch (err) {
    detalleError = err.name === "AbortError"
      ? `CallMeBot no respondio en ${Math.round(espera / 1000)} segundos`
      : err.message;
  } finally {
    clearTimeout(alarma);
  }

  // La apikey nunca sale en el detalle (va al log y a salud_notificaciones, que
  // lee el panel): CallMeBot puede repetirla en su respuesta y un error de red
  // puede traer la URL completa.
  if (detalleError) {
    for (const v of [String(apikey), encodeURIComponent(apikey)]) {
      detalleError = detalleError.split(v).join("***");
    }
  }

  if (ok) {
    console.log("[Notificar] Comanda enviada al WhatsApp del restaurante:", pedido.referencia);
  } else {
    console.error("[Notificar] FALLO el envio:", pedido.referencia, "->", detalleError);
  }

  // Se deja constancia para que el panel pueda avisar. Un fallo aqui
  // NUNCA debe tumbar el flujo del pedido: el pedido ya esta guardado
  // y visible en el panel, que es el canal principal.
  try {
    await registrarSaludNotificacion(pedido.restaurante_id, ok, detalleError);
  } catch (err) {
    console.error("[Notificar] No se pudo registrar la salud:", err.message);
  }

  return { enviado: ok, motivo: detalleError };
}

module.exports = { notificarWhatsApp, construirComanda };
