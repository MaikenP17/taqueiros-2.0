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

let ultimoMenuBueno = null;      // { categorias, productos, momento }

/* Menu completo, ordenado tal como debe pintarse. */
async function leerMenu() {
  const [categorias, productos] = await Promise.all([
    consultarTabla("categorias", "select=id,nombre,emoji,orden,activa&activa=is.true&order=orden.asc"),
    consultarTabla("productos", "select=id,nombre,descripcion,precio,categoria,orden,disponible,imagen&order=orden.asc")
  ]);

  const menu = {
    categorias,
    productos,
    momento: new Date().toISOString()
  };

  // Solo se guarda si trae algo: un menu vacio no sirve de respaldo
  if (categorias.length && productos.length) {
    ultimoMenuBueno = menu;
  }

  return menu;
}

/* Lo ultimo que se sirvio bien, o null si esta instancia nunca
   alcanzo a servir nada. */
function menuDeRespaldo() {
  return ultimoMenuBueno;
}

/* Solo los ids agotados. Es la consulta mas barata posible y va casi
   sin cache, para que agotar un producto se note en segundos. */
async function leerAgotados() {
  const filas = await consultarTabla("productos", "select=id&disponible=is.false");
  return filas.map((f) => f.id);
}

/* Precios y disponibilidad para validar un pedido.
   NO pasa por ningun cache: es la consulta que decide cuanto se
   cobra, y tiene que ver el estado real de la base en ese instante. */
async function leerCatalogoParaCobrar() {
  const filas = await consultarTabla("productos", "select=id,nombre,precio,disponible");

  const mapa = new Map();
  filas.forEach((f) => mapa.set(f.id, {
    nombre: f.nombre,
    precio: Number(f.precio),
    disponible: f.disponible !== false
  }));
  return mapa;
}

module.exports = { leerMenu, menuDeRespaldo, leerAgotados, leerCatalogoParaCobrar };
