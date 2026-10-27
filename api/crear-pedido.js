const crypto = require("crypto");
const { validarItems } = require("./_precios.js");
const { contextoDomicilio, calcularDomicilio, coordenadasValidas } = require("./_domicilio.js");
const { estadoRestaurante } = require("./_horario.js");
const { verificarUbicacion, opcionesUbicacion } = require("./_ubicacion.js");
const { insertarPedido, leerTarifasDomicilio } = require("./_supabase.js");
const {
  exigirRestaurante, restauranteFresco, exigirServicio,
  leerSecretos, modoDePago, secretosWompi
} = require("./_restaurante.js");

/* =============================================================
   Crea el pedido ANTES de que el cliente pague.

   Por que existe: el webhook de Wompi solo informa referencia,
   monto y estado; no sabe que productos pidio el cliente. Si el
   pedido no se guarda antes, esa informacion se pierde.

   Ademas cierra un hueco de seguridad: el navegador NO decide el
   monto. Manda ids y cantidades, y el servidor calcula el total
   con el catalogo de _precios.js y firma ESE total. Asi nadie
   puede pagar menos manipulando el navegador.

   Devuelve: { referencia, numero, tokenSeguimiento, total, firma, ... }

   MULTI-RESTAURANTE: el restaurante sale del host (ver _restaurante.js), nunca
   del cuerpo de la peticion. Todo lo demas es de ESE restaurante: su menu y
   precios (un id de producto de otro restaurante se rechaza), su horario, sus
   tarifas de domicilio, sus llaves de Wompi y su contador de numero de pedido
   (lo asigna la base al insertar, con el contador atomico del restaurante).
   Si el servicio esta suspendido o vencido mas alla de la gracia, no se
   reciben pedidos (403, motivo 'servicio_suspendido'); no se toca ningun dato.
============================================================= */

const TIPOS_VALIDOS = ["domicilio", "llevar", "local"];

/* Un carrito real no pasa de unas decenas de lineas (el menu entero cabe). */
const MAX_LINEAS = 100;

/* Caracteres que nadie escribe en un formulario y que sirven para disfrazar
   texto en la comanda: controles (salvo tab y salto de linea, que se tratan
   aparte), ancho cero y controles de direccion (bidi). */
const INVISIBLES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/* 'conSaltos': solo las indicaciones conservan saltos de linea (el ticket las
   imprime como notas). En el resto un salto fabricaria lineas falsas en la
   comanda ("9x Taco - 90.000" dentro del nombre). */
function limpiar(texto, maximo, conSaltos) {
  let t = String(texto == null ? "" : texto).replace(/\r\n?/g, "\n").replace(INVISIBLES, " ");
  t = conSaltos ? t.replace(/\t/g, " ").replace(/\n{3,}/g, "\n\n") : t.replace(/[\t\n]+/g, " ");
  return t.trim().slice(0, maximo);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  // ---- De que restaurante es esta peticion ---------------------
  const restauranteCache = await exigirRestaurante(req, res);
  if (!restauranteCache) return;

  try {
    const { cliente, items, modo } = req.body || {};

    // ---- El servicio debe estar al dia ---------------------------
    // Se lee el restaurante SIN cache: una suspension rige en el acto.
    const restaurante = await restauranteFresco(restauranteCache);
    if (!exigirServicio(res, restaurante)) return;

    // ---- El restaurante debe estar abierto --------------------
    // Se valida AQUI, no solo en el navegador: cualquiera podria
    // saltarse la validacion del frontend desde la consola.
    const estado = await estadoRestaurante(restaurante);
    if (!estado.abierto) {
      res.status(409).json({
        error: estado.mensaje || "El restaurante está cerrado en este momento",
        cerrado: true
      });
      return;
    }

    // ---- Validar cliente -------------------------------------
    if (!cliente || typeof cliente !== "object") {
      res.status(400).json({ error: "Faltan los datos del cliente" });
      return;
    }

    const nombre = limpiar(cliente.nombre, 120);
    const telefono = limpiar(cliente.telefono, 20);
    const email = limpiar(cliente.email, 160);
    const tipoPedido = limpiar(cliente.tipoPedido, 20);

    if (nombre.length < 3) {
      res.status(400).json({ error: "Nombre inválido" });
      return;
    }
    if (!/^3\d{9}$/.test(telefono)) {
      res.status(400).json({ error: "Teléfono inválido" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Correo inválido" });
      return;
    }
    if (!TIPOS_VALIDOS.includes(tipoPedido)) {
      res.status(400).json({ error: "Tipo de pedido inválido" });
      return;
    }

    const direccion = limpiar(cliente.direccion, 200);
    const barrio = limpiar(cliente.barrio, 120);
    const indicaciones = limpiar(cliente.indicaciones, 400, true);

    if (tipoPedido === "domicilio" && (!direccion || !barrio)) {
      res.status(400).json({ error: "Un domicilio necesita dirección y barrio" });
      return;
    }

    // ---- Validar items y calcular el total en el servidor -----
    /* Los productos se validan CONTRA LA BASE, en este instante:
         - que existan
         - que sigan disponibles
         - y a que precio se cobran de verdad

       El navegador solo manda ids y cantidades. Los precios que se
       usan aqui son los de la base, nunca los que llegaron en la
       peticion. */
    if (Array.isArray(items) && items.length > MAX_LINEAS) {
      res.status(400).json({ error: "El pedido tiene demasiados productos" });
      return;
    }
    const revision = await validarItems(restaurante.id, items);

    if (!revision.ok) {
      // 409 y no 400: no es que el cliente pidiera mal, es que el
      // menu cambio debajo de el. El front lo distingue para poder
      // quitar del carrito el producto agotado.
      /* Se devuelven los HECHOS: que productos se agotaron y cuales
         cambiaron de precio, con sus valores nuevos. El mensaje que
         ve el cliente lo arma el navegador despues de aplicarlos. */
      res.status(409).json({
        error: revision.error || null,
        agotados: revision.agotados || [],
        preciosCambiados: revision.preciosCambiados || [],
        desconocidos: revision.desconocidos || []
      });
      return;
    }

    const itemsValidados = revision.items;
    let total = revision.subtotal;
    const subtotal = revision.subtotal;

    if (subtotal <= 0) {
      res.status(400).json({ error: "Total inválido" });
      return;
    }

    // ---- Costo del domicilio (calculado aqui, no en el navegador)
    let costoDomicilio = 0;
    let distanciaKm = null;
    let lat = null;
    let lng = null;
    let fueraDeCobertura = false;
    let barrioDetectado = null;
    let ubicacionSospechosa = null;

    if (tipoPedido === "domicilio") {
      const ubic = cliente.ubicacion || {};
      lat = Number(ubic.lat);
      lng = Number(ubic.lng);

      if (!coordenadasValidas(lat, lng)) {
        res.status(400).json({ error: "Falta marcar la ubicación en el mapa" });
        return;
      }

      // Tarifas y origen de ESTE restaurante (tabla tarifas_domicilio + su config)
      const ctxDomicilio = contextoDomicilio(restaurante, await leerTarifasDomicilio(restaurante.id));
      if (!ctxDomicilio) {
        res.status(400).json({ error: "Este restaurante no tiene domicilio configurado. Elige recoger en el local." });
        return;
      }

      const calculo = calcularDomicilio(lat, lng, ctxDomicilio);
      costoDomicilio = calculo.precio;
      distanciaKm = calculo.km;
      fueraDeCobertura = calculo.fueraDeCobertura;

      // Fuera de cobertura: el domicilio se acuerda por WhatsApp, no
      // se cobra en linea. El cliente solo paga los productos.
      if (fueraDeCobertura) costoDomicilio = 0;

      // Revision del punto de entrega. Es de MEJOR ESFUERZO: si algo
      // falla aqui el pedido sigue igual, solo se queda sin la senal
      // de aviso para el panel.
      try {
        const revision = await verificarUbicacion(lat, lng, barrio, opcionesUbicacion(restaurante, ctxDomicilio));
        barrioDetectado = revision.barrioDetectado;
        ubicacionSospechosa = revision.sospechosa;
      } catch (err) {
        console.warn("[Pedido] No se pudo verificar la ubicacion:", err.message);
      }
    }

    total = subtotal + costoDomicilio;

    // ---- Referencia y firma de integridad --------------------
    /* Prefijo NEUTRO ("PED-"): este archivo es compartido por todos los restaurantes y la referencia
       la ve el cliente, asi que no lleva la marca de ninguno. Los pedidos anteriores conservan su
       referencia "TAQ-..." y se siguen abriendo igual: nada valida el prefijo (solo la referencia
       completa), ver docs/multirestaurante.md seccion 20. */
    const referencia = "PED-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
    const montoEnCentavos = total * 100;
    const moneda = "COP";

    // Las llaves son del restaurante y se leen aqui, en el servidor, en cada uso.
    // El modo (prueba/produccion) lo decide el servidor; el del navegador solo
    // cuenta para Taqueiros mientras no se configure (ver modoDePago).
    const secretos = await leerSecretos(restaurante);
    const modoCobro = modoDePago(restaurante, secretos, modo);
    const secreto = modoCobro ? secretosWompi(restaurante, secretos, modoCobro).integridad : null;

    if (!secreto) {
      res.status(500).json({ error: "El secreto de integridad no está configurado en el servidor" });
      return;
    }

    const firma = crypto
      .createHash("sha256")
      .update(`${referencia}${montoEnCentavos}${moneda}${secreto}`)
      .digest("hex");

    // ---- Guardar el pedido como pendiente de pago ------------
    const pedidoGuardado = await insertarPedido(restaurante.id, {
      referencia,
      estado: "pendiente_pago",
      cliente_nombre: nombre,
      cliente_telefono: telefono,
      cliente_email: email,
      tipo_pedido: tipoPedido,
      direccion: tipoPedido === "domicilio" ? direccion : null,
      barrio: tipoPedido === "domicilio" ? barrio : null,
      indicaciones: indicaciones || null,
      items: itemsValidados,
      subtotal,
      costo_domicilio: costoDomicilio,
      distancia_km: distanciaKm,
      lat,
      lng,
      fuera_de_cobertura: fueraDeCobertura,
      barrio_detectado: barrioDetectado,
      ubicacion_sospechosa: ubicacionSospechosa,
      total,
      estado_pago: "pendiente",
      wompi_ambiente: modoCobro === "produccion" ? "prod" : "test"
    });

    console.log("[Pedido] Creado pendiente de pago:", referencia,
      "subtotal:", subtotal, "domicilio:", costoDomicilio, "total:", total);

    res.status(200).json({
      referencia,
      numero: pedidoGuardado ? pedidoGuardado.numero : null,
      // Enlace de seguimiento no adivinable (SQL 12). Antes del SQL 12 la columna no existe y el
      // navegador sigue con la referencia, que tambien abre el seguimiento de esos pedidos.
      tokenSeguimiento: pedidoGuardado && pedidoGuardado.token_seguimiento ? pedidoGuardado.token_seguimiento : null,
      subtotal,
      costoDomicilio,
      distanciaKm,
      fueraDeCobertura,
      total,
      firma
    });
  } catch (err) {
    console.error("[Pedido] Error creando el pedido:", err);
    res.status(500).json({ error: "No se pudo registrar el pedido" });
  }
};
