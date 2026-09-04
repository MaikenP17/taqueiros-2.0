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

  /* -------------------------------------------------------------
     SE RECORREN TODOS LOS PRODUCTOS ANTES DE RESPONDER

     Antes se devolvia al primer problema. Si habian cambiado dos
     precios, el cliente arreglaba uno, reintentaba, y se encontraba
     con el siguiente: un aviso por producto.

     Ahora se juntan todos y se devuelven de una vez, para que el
     cliente quede al dia en un solo paso.
  ------------------------------------------------------------- */
  const desconocidos = [];
  const agotados = [];
  const preciosCambiados = [];
  const validados = [];
  let subtotal = 0;

  for (const item of items) {
    const id = String(item && item.id ? item.id : "").trim().slice(0, 60);
    const cantidad = Number(item && item.cantidad);

    const producto = catalogo.get(id);
    if (!producto) { desconocidos.push(id); continue; }

    if (!producto.disponible) {
      agotados.push({ id, nombre: producto.nombre });
      continue;
    }

    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {
      return { ok: false, error: `Cantidad inválida para "${producto.nombre}"` };
    }

    /* El precio que el cliente tiene EN PANTALLA debe coincidir con el
       de la base. Si no, no se corrige en silencio: se informa.

       Por que importa: el catalogo se cachea 5 minutos. Si el dueno
       sube un producto, durante esos minutos el cliente veria un total
       y se le abriria Wompi con otro, justo cuando ya saco la tarjeta. */
    const precioMostrado = Number(item && item.precio);

    if (Number.isFinite(precioMostrado) && precioMostrado !== producto.precio) {
      preciosCambiados.push({
        id,
        nombre: producto.nombre,
        precioViejo: precioMostrado,
        precioNuevo: producto.precio,
        subio: producto.precio > precioMostrado
      });
      continue;
    }

    validados.push({
      id,
      nombre: producto.nombre,
      cantidad,
      precio: producto.precio      // el de la base, no el del navegador
    });
    subtotal += producto.precio * cantidad;
  }

  /* -------------------------------------------------------------
     LA RESPUESTA DESCRIBE HECHOS, NO PROMESAS

     Antes el mensaje decia "Actualizamos tu carrito", una afirmacion
     escrita aqui sobre algo que ocurre en el navegador. Cuando el
     navegador no lograba actualizarlo, el texto quedaba mintiendo y
     el cliente entraba en un bucle: pagar, mismo aviso, pagar.

     Ahora el servidor solo reporta QUE cambio y a cuanto. El mensaje
     que ve el cliente lo arma el navegador DESPUES de aplicar los
     cambios, contando lo que de verdad hizo.
  ------------------------------------------------------------- */
  if (desconocidos.length) {
    return {
      ok: false,
      desconocidos,
      error: "Uno de los productos ya no está en el menú. Actualiza la página e intenta de nuevo."
    };
  }

  if (agotados.length || preciosCambiados.length) {
    return { ok: false, agotados, preciosCambiados };
  }

  if (subtotal <= 0) {
    return { ok: false, error: "Total inválido" };
  }

  return { ok: true, items: validados, subtotal };
}

module.exports = { validarItems };
