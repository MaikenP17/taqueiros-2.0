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
  /* Se traen TODAS las categorias, tambien las desactivadas.
     Antes se filtraban aqui (activa=is.true) y eso causaba un fallo
     feo: al desactivar una categoria, seguia viendose hasta que
     vencia el cache de 5 minutos; y al reactivarla, justo entonces
     vencia el cache y desaparecia. El cliente veia el pasado
     llegando tarde.

     Ahora el catalogo dice lo que las cosas SON y CUESTAN, y quien
     decide que se puede pedir AHORA es /api/disponibilidad, que va
     casi sin cache. */
  const [categorias, productos] = await Promise.all([
    consultarTabla("categorias", "select=id,nombre,emoji,orden,activa&order=orden.asc"),
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

/* TODO lo que responde a "que se puede pedir ahora mismo":
     - productos agotados
     - categorias desactivadas

   Van juntos y por el endpoint rapido a proposito. La disponibilidad
   no tiene red de seguridad: si el cliente ve algo que el restaurante
   apago, arma un pedido que no se puede cumplir. Los precios si
   pueden ir en el catalogo lento, porque la validacion al pagar ya
   los protege.

   Sigue siendo la consulta mas barata posible: solo ids. */
async function leerEstadoMenu() {
  const [agotados, inactivas] = await Promise.all([
    consultarTabla("productos", "select=id&disponible=is.false"),
    consultarTabla("categorias", "select=id&activa=is.false")
  ]);

  return {
    agotados: agotados.map((f) => f.id),
    categoriasInactivas: inactivas.map((f) => f.id)
  };
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

module.exports = { leerMenu, menuDeRespaldo, leerEstadoMenu, leerCatalogoParaCobrar };
