const { consultarTabla } = require("./_supabase.js");

/* =============================================================
   LECTURA DEL MENU DESDE SUPABASE

   Los productos ya no estan escritos a mano en ningun archivo: la
   unica fuente es la tabla 'productos'. Este modulo es el unico
   sitio que sabe como leerla.

   -------------------------------------------------------------
   LA RED DE SEGURIDAD
   -------------------------------------------------------------
   Antes el menu vivia dentro del HTML, asi que la pagina SIEMPRE
   mostraba algo. Ahora, si Supabase se cae, el cliente podria abrir
   la pagina y no ver ni un producto: el restaurante sin vender.

   Aqui se guarda en memoria la ultima respuesta buena. No es una
   copia escrita en el codigo (eso reintroduciria la duplicacion que
   estamos eliminando): es una copia de lo ultimo que se sirvio bien,
   creada en tiempo de ejecucion.

   Alcance real, sin adornos: vive mientras la instancia de la
   funcion siga caliente. Si Vercel la recicla y Supabase sigue
   caido, el servidor ya no tiene nada que servir; a partir de ahi la
   red de seguridad es la del navegador (ver index.html, que guarda
   el ultimo menu bueno que recibio).
============================================================= */

/* MULTI-RESTAURANTE: la copia de respaldo es POR restaurante (id -> menu).
   Si fuera una sola, la instancia podria servirle a un restaurante el menu
   del otro cuando Supabase falle. */
const ultimoMenuBuenoPorRestaurante = new Map();   // id -> { categorias, productos, momento }

/* =============================================================
   OPCIONES DE PRODUCTO (quitar ingredientes / extras con precio)

   Viven en la tabla 'producto_opciones' (SQL 18). Dos usos MUY distintos:
     * leerOpcionesActivas: lo que se MUESTRA (va en el menu, que se cachea).
     * leerOpcionesParaCobrar: lo que se COBRA (sin cache, directo de la base).
   La cache del menu nunca es fuente de precios: el precio de un extra se lee
   de la base al crear el pedido (ver _precios.js).

   Antes de correr el SQL 18 la tabla no existe: el menu sigue igual (sin
   opciones) y un pedido sin opciones no se entera. Solo un pedido que PIDE
   opciones lo nota (ver esTablaDeOpcionesAusente).
============================================================= */

/* true si el error de PostgREST significa "esa tabla no existe todavia"
   (404 / PGRST205 en las versiones nuevas, 42P01 en las viejas). */
function esTablaDeOpcionesAusente(err) {
  const cuerpo = String((err && err.cuerpo) || "");
  return !!err && (err.status === 404 || /PGRST205|42P01/.test(cuerpo));
}

let avisoOpcionesAusentes = false;

/* Opciones ACTIVAS del restaurante, agrupadas por producto: Map(producto_id -> [{id,tipo,nombre,precio,orden}]).
   Si no se pueden leer (la tabla aun no existe, o un fallo de red) devuelve un Map vacio: el menu SIGUE
   funcionando, solo sin opciones, y el servidor igual rechaza o acepta cada opcion al cobrar. */
async function leerOpcionesActivas(rid) {
  let filas;
  try {
    filas = await consultarTabla(rid, "producto_opciones",
      "select=producto_id,id,tipo,nombre,precio,orden&activa=is.true&order=orden.asc");
  } catch (err) {
    if (esTablaDeOpcionesAusente(err)) {
      if (!avisoOpcionesAusentes) {
        avisoOpcionesAusentes = true;
        console.warn("[Menu] La tabla producto_opciones no existe todavia: el menu sale sin opciones. Corre supabase/18-opciones-producto.sql.");
      }
    } else {
      console.error("[Menu] No se pudieron leer las opciones de producto (el menu sale sin ellas):", err.message);
    }
    return new Map();
  }

  const porProducto = new Map();
  for (const f of Array.isArray(filas) ? filas : []) {
    if (!f || typeof f.producto_id !== "string") continue;
    if (!porProducto.has(f.producto_id)) porProducto.set(f.producto_id, []);
    porProducto.get(f.producto_id).push({
      id: f.id, tipo: f.tipo, nombre: f.nombre, precio: Number(f.precio), orden: Number(f.orden)
    });
  }
  for (const lista of porProducto.values()) {
    lista.sort((a, b) => (a.orden - b.orden) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return porProducto;
}

/* Menu completo del restaurante, ordenado tal como debe pintarse.
   Cada producto que tenga opciones ACTIVAS trae ademas  opciones: [{id, tipo, nombre, precio, orden}]
   (aditivo: un producto sin opciones queda exactamente como siempre, sin la clave). */
async function leerMenu(rid) {
  /* Se traen TODAS las categorias, tambien las desactivadas.
     Antes se filtraban aqui (activa=is.true) y eso causaba un fallo
     feo: al desactivar una categoria, seguia viendose hasta que
     vencia el cache de 5 minutos; y al reactivarla, justo entonces
     vencia el cache y desaparecia. El cliente veia el pasado
     llegando tarde.

     Ahora el catalogo dice lo que las cosas SON y CUESTAN, y quien
     decide que se puede pedir AHORA es /api/disponibilidad, que va
     casi sin cache. */
  const [categorias, filasProductos, opciones] = await Promise.all([
    consultarTabla(rid, "categorias", "select=id,nombre,emoji,orden,activa&order=orden.asc"),
    consultarTabla(rid, "productos", "select=id,nombre,descripcion,precio,categoria,orden,disponible,imagen&order=orden.asc"),
    leerOpcionesActivas(rid)
  ]);

  const productos = opciones.size
    ? filasProductos.map((p) => (opciones.has(p.id) ? Object.assign({}, p, { opciones: opciones.get(p.id) }) : p))
    : filasProductos;

  const menu = {
    categorias,
    productos,
    momento: new Date().toISOString()
  };

  // Solo se guarda si trae algo: un menu vacio no sirve de respaldo
  if (categorias.length && productos.length) {
    ultimoMenuBuenoPorRestaurante.set(rid, menu);
  }

  return menu;
}

/* Lo ultimo que se sirvio bien PARA ESE restaurante, o null si esta instancia
   nunca alcanzo a servir nada de el. */
function menuDeRespaldo(rid) {
  return ultimoMenuBuenoPorRestaurante.get(rid) || null;
}

/* TODO lo que responde a "que se puede pedir ahora mismo":
     - productos agotados
     - categorias desactivadas

   Van juntos y por el endpoint rapido a proposito. La disponibilidad
   no tiene red de seguridad: si el cliente ve algo que el restaurante
   apago, arma un pedido que no se puede cumplir. Los precios si
   pueden ir en el catalogo lento, porque la validacion al pagar ya
   los protege.

   Sigue siendo la consulta mas barata posible: solo ids. */
async function leerEstadoMenu(rid) {
  const [agotados, inactivas] = await Promise.all([
    consultarTabla(rid, "productos", "select=id&disponible=is.false"),
    consultarTabla(rid, "categorias", "select=id&activa=is.false")
  ]);

  return {
    agotados: agotados.map((f) => f.id),
    categoriasInactivas: inactivas.map((f) => f.id)
  };
}

/* Precios y disponibilidad para validar un pedido.
   NO pasa por ningun cache: es la consulta que decide cuanto se
   cobra, y tiene que ver el estado real de la base en ese instante.

   Tambien trae si la CATEGORIA del producto esta activa: el sitio
   esconde los productos de una categoria apagada, pero esconder no
   es impedir; quien impide es esta consulta. Si la lectura de
   categorias falla, falla todo (no se cobra a ciegas). */
async function leerCatalogoParaCobrar(rid) {
  const [filas, categorias] = await Promise.all([
    consultarTabla(rid, "productos", "select=id,nombre,precio,disponible,categoria"),
    consultarTabla(rid, "categorias", "select=id,nombre,activa")
  ]);

  const categoriaPorId = new Map();
  categorias.forEach((c) => categoriaPorId.set(c.id, {
    nombre: c.nombre,
    activa: c.activa !== false
  }));

  const mapa = new Map();
  filas.forEach((f) => {
    const cat = categoriaPorId.get(f.categoria);
    mapa.set(f.id, {
      nombre: f.nombre,
      precio: Number(f.precio),
      disponible: f.disponible !== false,
      categoriaNombre: cat ? cat.nombre : null,
      // Sin dato de categoria no se bloquea: el unico motivo para
      // rechazar es que la categoria exista Y este apagada.
      categoriaActiva: cat ? cat.activa : true
    });
  });
  return mapa;
}

/* Las opciones de los productos que se estan pidiendo, para validarlas y cobrarlas.
   NO pasa por ningun cache. Devuelve Map(producto_id -> Map(opcion_id -> fila)) con TODAS las opciones de esos
   productos (tambien las apagadas: quien llama decide, para poder rechazarlas por su nombre).
   Lanza el error de PostgREST si falla (y si la tabla no existe: ver esTablaDeOpcionesAusente). */
async function leerOpcionesParaCobrar(rid, productoIds) {
  const ids = Array.from(new Set((productoIds || []).map(String)));
  const mapa = new Map();
  if (!ids.length) return mapa;

  // in.("a","b"): los ids van entre comillas, con \ y " escapados, y todo el valor codificado para la URL
  const lista = ids.map((id) => '"' + id.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",");
  const filas = await consultarTabla(rid, "producto_opciones",
    "select=producto_id,id,tipo,nombre,precio,orden,activa&producto_id=in.(" + encodeURIComponent(lista) + ")");

  for (const f of filas) {
    if (!mapa.has(f.producto_id)) mapa.set(f.producto_id, new Map());
    mapa.get(f.producto_id).set(f.id, f);
  }
  return mapa;
}

module.exports = {
  leerMenu, menuDeRespaldo, leerEstadoMenu, leerCatalogoParaCobrar,
  leerOpcionesActivas, leerOpcionesParaCobrar, esTablaDeOpcionesAusente
};
