const { leerCatalogoParaCobrar, leerOpcionesParaCobrar, esTablaDeOpcionesAusente } = require("./_menu.js");

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

/* =============================================================
   OPCIONES DE PRODUCTO EN EL PEDIDO (quitar ingredientes / extras con precio)

   CONTRATO (aditivo; sin 'opciones' todo funciona exactamente como siempre):
     cada item puede traer  opciones: ["sin-cebolla", "extra-queso"]
     = ids de opcion (texto), opcional, maximo 12, sin repetidos, con la forma de un id
     (minusculas, numeros y guiones). NUNCA nombres ni precios: si el navegador manda
     objetos, nombres o precios de opciones, el pedido se rechaza (no se usan).

   QUE HACE EL SERVIDOR con cada opcion pedida (carga la base en ese instante, sin cache):
     * debe EXISTIR, estar ACTIVA y ser de ESE producto de ESE restaurante;
     * precio unitario = precio base del producto + suma de los EXTRAS (los 'quitar' no suman);
     * el item guardado en el pedido trae  precio (= unitario FINAL, con extras: asi todo lo que ya
       suma items sigue cuadrando), precio_base y opciones: [{id, tipo, nombre, precio}] (copia
       tomada de la base, con el nombre saneado).
   Un item sin opciones se guarda con las 4 claves de siempre (id, nombre, cantidad, precio).

   Si algo no cuadra: 400 con un mensaje generico (no dice cual opcion ni por que).
============================================================= */
const MAX_OPCIONES_POR_ITEM = 12;
const ID_OPCION = /^[a-z0-9][a-z0-9-]{0,59}$/;
const TOPE_PRECIO_OPCION = 50000;

/* Evita que un total desborde la columna integer de la base (2147483647) y llegue como un 500. */
const TOPE_SUBTOTAL = 2000000000;

const MENSAJE_OPCIONES = "Alguna de las opciones elegidas no es válida o ya no está disponible. Actualiza la página e intenta de nuevo.";
const MENSAJE_OPCIONES_NO_DISPONIBLES = "Las opciones de producto todavía no están disponibles. Haz tu pedido sin opciones.";
const MENSAJE_OPCIONES_REINTENTAR = "No pudimos confirmar las opciones en este momento. Intenta de nuevo en unos segundos.";

/* Caracteres que no deben llegar a un ticket ni a un mensaje: controles, ancho cero y controles de
   direccion (bidi). Se arma desde codigos para que ningun editor deje caracteres invisibles escritos aqui. */
const CONTROLES = (() => {
  const barra = String.fromCharCode(92);
  const u = (n) => barra + "u" + n.toString(16).padStart(4, "0");
  const rangos = [[0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f], [0x202a, 0x202e],
                  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
  return new RegExp("[" + rangos.map(([a, b]) => u(a) + "-" + u(b)).join("") + "]", "g");
})();

/* Nombre de opcion para guardar en el pedido: texto plano de una linea, maximo 40 caracteres.
   El recorte cuenta CARACTERES (como char_length en la base), no unidades UTF-16: cortar un emoji por la mitad dejaba
   media pareja suelta, Postgres rechazaba el JSON y el pedido entero fallaba con 500. */
function nombreSaneado(valor) {
  const limpio = String(valor == null ? "" : valor).replace(CONTROLES, " ").replace(/\s+/g, " ").trim();
  return Array.from(limpio).slice(0, 40).join("");
}

/* Los ids de opcion que pide UN item, o null si vienen mal formados.
   Sin 'opciones' (ausente, null o arreglo vacio) devuelve [] = comportamiento de siempre. */
function idsDeOpciones(item) {
  const crudo = item && typeof item === "object" ? item.opciones : undefined;
  if (crudo === undefined || crudo === null) return [];
  if (!Array.isArray(crudo) || crudo.length > MAX_OPCIONES_POR_ITEM) return null;
  const ids = [];
  for (const o of crudo) {
    if (typeof o !== "string" || !ID_OPCION.test(o)) return null;
    ids.push(o);
  }
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

/* Una fila de la base -> la copia que se guarda en el pedido, o null si la fila no es usable
   (inactiva, tipo raro, precio fuera de rango, un 'quitar' con precio, nombre vacio). */
function copiaDeOpcion(fila) {
  if (!fila || fila.activa === false) return null;
  const tipo = fila.tipo;
  const precio = fila.precio;
  if (tipo !== "quitar" && tipo !== "extra") return null;
  // Debe ser un NUMERO entero de verdad: Number(null), Number("") y Number(true) darian 0 o 1 y pasarian por un precio valido.
  if (typeof precio !== "number" || !Number.isInteger(precio) || precio < 0 || precio > TOPE_PRECIO_OPCION) return null;
  if (tipo === "quitar" && precio !== 0) return null;
  const nombre = nombreSaneado(fila.nombre);
  if (!nombre) return null;
  return { id: String(fila.id), tipo, nombre, precio, orden: Number(fila.orden) || 0 };
}

/* Valida los productos de un pedido contra el menu de UN restaurante.

   MULTI-RESTAURANTE: el catalogo que se consulta es solo el de 'rid'. Un id de
   producto de otro restaurante no existe en ese catalogo, asi que cae en
   'desconocidos' y el pedido se rechaza (aunque el otro restaurante tenga un
   producto con el mismo id: los ids solo son unicos dentro de cada restaurante).

   Devuelve:
     { ok: true, items: [...], subtotal }
     { ok: false, error: "mensaje para el cliente" }
     { ok: false, codigo: 400 | 503, error }      opciones mal formadas / invalidas / no disponibles
                                                  (sin 'codigo' el que responde usa 409, como siempre)

   Los precios que se devuelven son SIEMPRE los de la base, nunca los
   que mando el navegador. */
async function validarItems(rid, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "El pedido no tiene productos" };
  }

  // Opciones pedidas por cada item. Mal formadas -> 400 sin tocar la base.
  const opcionesPedidas = items.map(idsDeOpciones);
  if (opcionesPedidas.some((ids) => ids === null)) {
    return { ok: false, codigo: 400, error: MENSAJE_OPCIONES };
  }

  let catalogo;
  try {
    catalogo = await leerCatalogoParaCobrar(rid);
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
  /* Opciones de los productos que SI estan en el catalogo y llevan alguna opcion. Se leen una sola vez, sin cache.
     Si no se pueden leer, el pedido con opciones no se cobra (sin opciones ni se consulta la tabla). */
  let opcionesDeLaBase = new Map();
  const productosConOpciones = [];
  items.forEach((item, i) => {
    if (!opcionesPedidas[i].length) return;
    const pid = String(item && item.id ? item.id : "").trim().slice(0, 60);
    if (catalogo.has(pid)) productosConOpciones.push(pid);
  });
  if (productosConOpciones.length) {
    try {
      opcionesDeLaBase = await leerOpcionesParaCobrar(rid, productosConOpciones);
    } catch (err) {
      if (esTablaDeOpcionesAusente(err)) {
        console.warn("[Precios] Pedido con opciones pero la tabla producto_opciones no existe: corre supabase/18-opciones-producto.sql.");
        return { ok: false, codigo: 400, error: MENSAJE_OPCIONES_NO_DISPONIBLES };
      }
      console.error("[Precios] No se pudieron leer las opciones:", err.message);
      return { ok: false, codigo: 503, error: MENSAJE_OPCIONES_REINTENTAR };
    }
  }

  const desconocidos = [];
  const agotados = [];
  const preciosCambiados = [];
  const validados = [];
  let opcionesInvalidas = false;
  let subtotal = 0;

  for (let indice = 0; indice < items.length; indice++) {
    const item = items[indice];
    const idsOpciones = opcionesPedidas[indice];
    const id = String(item && item.id ? item.id : "").trim().slice(0, 60);
    const cantidad = Number(item && item.cantidad);

    const producto = catalogo.get(id);
    if (!producto) { desconocidos.push(id); continue; }

    /* 'motivo' le dice al navegador POR QUE no se puede pedir, para
       que cuente la verdad:
         "agotado"           -> el producto se acabo ("se nos acabo")
         "categoria_apagada" -> la categoria esta desactivada ("no esta
                                disponible por ahora") */
    if (!producto.disponible) {
      agotados.push({ id, nombre: producto.nombre, motivo: "agotado" });
      continue;
    }

    /* Categoria apagada: el producto no se puede pedir aunque este
       marcado como disponible. Va en 'agotados' a proposito: es la
       lista que el navegador ya sabe tratar (saca el producto del
       carrito y avisa), asi el cliente no queda atrapado reintentando. */
    if (producto.categoriaActiva === false) {
      agotados.push({
        id,
        nombre: producto.nombre,
        motivo: "categoria_apagada",
        categoria: producto.categoriaNombre
      });
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

    /* Sin opciones: el item de siempre (4 claves). Con opciones: precio unitario FINAL = base + extras. */
    if (!idsOpciones.length) {
      validados.push({
        id,
        nombre: producto.nombre,
        cantidad,
        precio: producto.precio      // el de la base, no el del navegador
      });
      subtotal += producto.precio * cantidad;
      continue;
    }

    const delProducto = opcionesDeLaBase.get(id);
    const elegidas = [];
    for (const oid of idsOpciones) {
      const copia = copiaDeOpcion(delProducto && delProducto.get(oid));
      if (!copia) { elegidas.length = 0; break; }
      elegidas.push(copia);
    }
    if (elegidas.length !== idsOpciones.length) { opcionesInvalidas = true; continue; }

    elegidas.sort((a, b) => (a.orden - b.orden) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const extras = elegidas.reduce((suma, o) => suma + (o.tipo === "extra" ? o.precio : 0), 0);
    const precioUnitario = producto.precio + extras;

    validados.push({
      id,
      nombre: producto.nombre,
      cantidad,
      precio: precioUnitario,        // FINAL (base + extras): lo que ya suma ticket, panel, historial y reembolsos
      precio_base: producto.precio,  // el de la base, sin extras
      opciones: elegidas.map((o) => ({ id: o.id, tipo: o.tipo, nombre: o.nombre, precio: o.precio }))
    });
    subtotal += precioUnitario * cantidad;
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
    /* 'error' es para quien consuma la API sin el navegador (el
       navegador arma su propio mensaje con 'agotados'). Solo se
       escribe cuando hay productos que no se pueden pedir. */
    const error = agotados.length
      ? agotados.map((a) => a.motivo === "categoria_apagada"
          ? `"${a.nombre}" no está disponible por ahora (la categoría "${a.categoria}" está desactivada).`
          : `"${a.nombre}" está agotado en este momento.`
        ).join(" ")
      : null;

    return { ok: false, agotados, preciosCambiados, error };
  }

  // Opciones que no existen, estan apagadas, son de otro producto o de otro restaurante: 400 generico
  if (opcionesInvalidas) {
    return { ok: false, codigo: 400, error: MENSAJE_OPCIONES };
  }

  if (subtotal <= 0 || !Number.isSafeInteger(subtotal) || subtotal > TOPE_SUBTOTAL) {
    return { ok: false, error: "Total inválido" };
  }

  return { ok: true, items: validados, subtotal };
}

module.exports = { validarItems, idsDeOpciones, nombreSaneado, MAX_OPCIONES_POR_ITEM };
