const crypto = require("crypto");
const { PRECIOS } = require("./_precios.js");
const { calcularDomicilio, coordenadasValidas } = require("./_domicilio.js");
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
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "El pedido no tiene productos" });
      return;
    }

    const itemsValidados = [];
    let total = 0;

    for (const item of items) {
      const id = limpiar(item && item.id, 60);
      const cantidad = Number(item && item.cantidad);

      const producto = PRECIOS[id];
      if (!producto) {
        res.status(400).json({ error: `Producto desconocido: ${id}` });
        return;
      }
      if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {
        res.status(400).json({ error: `Cantidad inválida para ${id}` });
        return;
      }

      itemsValidados.push({
        id,
        nombre: producto.nombre,
        cantidad,
        precio: producto.precio
      });
      total += producto.precio * cantidad;
    }

    const subtotal = total;

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
