const { leerCatalogoParaCobrar } = require("./_menu.js");

/* =============================================================
   PRECIOS AUTORITATIVOS — AHORA SALEN DE LA BASE DE DATOS

   Antes este archivo tenia los 38 productos con sus precios escritos
   a mano, duplicando lo que ya estaba en index.html. Dos copias del
   mismo dato: cambiar un precio en una sola dejaba al cliente viendo
   un valor y pagando otro.

   Ahora la unica fuente es la tabla 'productos' de Supabase.

   -------------------------------------------------------------
   POR QUE ESTA LECTURA NO SE CACHEA NUNCA
   -------------------------------------------------------------
   /api/menu si se cachea, porque es solo lo que se MUESTRA. Esto es
   distinto: es lo que se COBRA. Se consulta la base directo, en cada
   pedido, para que el precio y la disponibilidad sean los reales en
   ese instante.

   Es una consulta por pedido. Comparado con cobrar mal o vender algo
   agotado, es gratis.
============================================================= */

/* Valida los productos de un pedido contra la base.

   Devuelve:
     { ok: true, items: [...], subtotal }
     { ok: false, error: "mensaje para el cliente" }

   Los precios que se devuelven son SIEMPRE los de la base, nunca los
   que mando el navegador. */
async function validarItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "El pedido no tiene productos" };
  }

  let catalogo;
  try {
    catalogo = await leerCatalogoParaCobrar();
  } catch (err) {
    console.error("[Precios] No se pudo leer el catalogo:", err.message);
    /* Si no se puede confirmar el precio, NO se cobra. Es preferible
       perder un pedido que cobrarle mal a un cliente. */
    return { ok: false, error: "No pudimos confirmar los precios en este momento. Intenta de nuevo en unos segundos." };
  }

  if (!catalogo.size) {
    return { ok: false, error: "No pudimos confirmar los precios en este momento. Intenta de nuevo en unos segundos." };
  }

  const validados = [];
  let subtotal = 0;

  for (const item of items) {
    const id = String(item && item.id ? item.id : "").trim().slice(0, 60);
    const cantidad = Number(item && item.cantidad);

    const producto = catalogo.get(id);
    if (!producto) {
      return { ok: false, error: `Uno de los productos ya no está en el menú. Actualiza la página e intenta de nuevo.` };
    }

    // Se agoto mientras el cliente tenia el menu viejo en pantalla
    if (!producto.disponible) {
      return {
        ok: false,
        agotado: id,
        error: `Se nos acabó "${producto.nombre}". Quítalo del carrito para continuar con el resto del pedido.`
      };
    }

    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {
      return { ok: false, error: `Cantidad inválida para "${producto.nombre}"` };
    }

    validados.push({
      id,
      nombre: producto.nombre,
      cantidad,
      precio: producto.precio      // el de la base, no el del navegador
    });
    subtotal += producto.precio * cantidad;
  }

  if (subtotal <= 0) {
    return { ok: false, error: "Total inválido" };
  }

  return { ok: true, items: validados, subtotal };
}

module.exports = { validarItems };
