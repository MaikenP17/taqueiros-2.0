const crypto = require("crypto");
const { validarItems } = require("./_precios.js");
const { calcularDomicilio, coordenadasValidas } = require("./_domicilio.js");
const { estadoRestaurante } = require("./_horario.js");
const { verificarUbicacion } = require("./_ubicacion.js");
const { insertarPedido } = require("./_supabase.js");

/* =============================================================
   Crea el pedido ANTES de que el cliente pague.

   Por que existe: el webhook de Wompi solo informa referencia,
   monto y estado; no sabe que productos pidio el cliente. Si el
   pedido no se guarda antes, esa informacion se pierde.

   Ademas cierra un hueco de seguridad: el navegador NO decide el
   monto. Manda ids y cantidades, y el servidor calcula el total
   con el catalogo de _precios.js y firma ESE total. Asi nadie
   puede pagar menos manipulando el navegador.

   Devuelve: { referencia, total, firma }
============================================================= */

const TIPOS_VALIDOS = ["domicilio", "llevar", "local"];

function limpiar(texto, maximo) {
  return String(texto == null ? "" : texto).trim().slice(0, maximo);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  try {
    const { cliente, items, modo } = req.body || {};

    // ---- El restaurante debe estar abierto --------------------
    // Se valida AQUI, no solo en el navegador: cualquiera podria
    // saltarse la validacion del frontend desde la consola.
    const estado = await estadoRestaurante();
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
    const indicaciones = limpiar(cliente.indicaciones, 400);

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
    const revision = await validarItems(items);

    if (!revision.ok) {
      // 409 y no 400: no es que el cliente pidiera mal, es que el
      // menu cambio debajo de el. El front lo distingue para poder
      // quitar del carrito el producto agotado.
      res.status(409).json({ error: revision.error, agotado: revision.agotado || null });
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

      const calculo = calcularDomicilio(lat, lng);
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
        const revision = await verificarUbicacion(lat, lng, barrio);
        barrioDetectado = revision.barrioDetectado;
        ubicacionSospechosa = revision.sospechosa;
      } catch (err) {
        console.warn("[Pedido] No se pudo verificar la ubicacion:", err.message);
      }
    }

    total = subtotal + costoDomicilio;

    // ---- Referencia y firma de integridad --------------------
    const referencia = "TAQ-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
    const montoEnCentavos = total * 100;
    const moneda = "COP";

    const secreto = modo === "produccion"
      ? process.env.WOMPI_INTEGRITY_SECRET_PROD
      : process.env.WOMPI_INTEGRITY_SECRET_TEST;

    if (!secreto) {
      res.status(500).json({ error: "El secreto de integridad no está configurado en el servidor" });
      return;
    }

    const firma = crypto
      .createHash("sha256")
      .update(`${referencia}${montoEnCentavos}${moneda}${secreto}`)
      .digest("hex");

    // ---- Guardar el pedido como pendiente de pago ------------
    await insertarPedido({
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
      wompi_ambiente: modo === "produccion" ? "prod" : "test"
    });

    console.log("[Pedido] Creado pendiente de pago:", referencia,
      "subtotal:", subtotal, "domicilio:", costoDomicilio, "total:", total);

    res.status(200).json({
      referencia,
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
