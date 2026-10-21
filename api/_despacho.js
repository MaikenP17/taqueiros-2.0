/* =============================================================
   DESPACHO: UNA SOLA FUNCION DE VERCEL PARA VARIOS ENDPOINTS

   Vercel (plan Hobby) permite 12 funciones por despliegue y cada archivo de
   api/ que no empieza por guion bajo cuenta como una. Para dejar espacio, los
   endpoints parecidos viven como modulos en api/_modulos/ y las funciones
   reales (api/publico.js, api/cron.js) solo deciden a cual llamar. Los modulos
   son los mismos manejadores de siempre, movidos de archivo sin cambiar una
   linea de su logica.

   LAS URL NO CAMBIAN. vercel.json reescribe cada URL de siempre
   (/api/menu, /api/alertas, /manifest.json...) hacia la funcion agrupada con
   un parametro interno:

       /api/menu      ->  /api/publico?_ruta=menu
       /api/keep-alive->  /api/cron?_ruta=keep-alive

   Vercel conserva el resto de la consulta (?r=, ?clave=...), el metodo, las
   cabeceras y el cuerpo.

   COMO SE ELIGE EL MODULO (en este orden)
     1. El ultimo segmento del PATH, si es una ruta conocida (/api/menu) o un
        alias (manifest.json). Si Vercel conserva la URL original en req.url,
        esto alcanza; y como manda sobre el parametro, una consulta como
        /api/menu?_ruta=estado no puede cambiar de endpoint.
     2. Si no, el parametro _ruta que puso la reescritura, leido de req.query
        (el que arma Vercel) o de la propia URL: cubre el caso de que req.url
        traiga la direccion reescrita (/api/publico?_ruta=menu).
     Sin ninguna de las dos: 404 con el mismo cuerpo que un host desconocido.

   Elegir un modulo con ?_ruta= desde fuera solo da acceso a OTRO endpoint de la
   misma funcion, con exactamente las mismas protecciones que tiene por su URL
   normal (la autorizacion del cron, el host del restaurante...). Los endpoints
   delicados (webhook de Wompi, crear-pedido, generar-firma, reembolso) NO estan
   agrupados: siguen siendo sus propios archivos.
============================================================= */

/* nombre de ruta -> () => manejador. Los require llevan la ruta escrita completa
   para que el empaquetador de Vercel incluya cada modulo, y son perezosos para que
   un arranque en frio solo cargue lo que se usa. */
function crearDespachador(rutas, alias) {
  const conocidas = new Set(Object.keys(rutas));
  const nombres = Object.assign(Object.create(null), alias || {});
  for (const n of conocidas) nombres[n] = n;

  function nombreDeRuta(req) {
    let url;
    try {
      url = new URL((req && req.url) || "/", "http://localhost");
    } catch (e) {
      return null;
    }
    const ultimo = url.pathname.split("/").filter(Boolean).pop() || "";
    let porPath = ultimo;
    try { porPath = decodeURIComponent(ultimo); } catch (e) { /* se queda sin decodificar */ }
    if (nombres[porPath]) return nombres[porPath];

    const deVercel = req && req.query && typeof req.query._ruta === "string" ? req.query._ruta : null;
    for (const candidato of [deVercel, url.searchParams.get("_ruta")]) {
      if (candidato !== null && conocidas.has(candidato)) return candidato;
    }
    return null;
  }

  async function despachar(req, res) {
    const nombre = nombreDeRuta(req);
    if (!nombre) {
      res.setHeader && res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ error: "No encontrado" });
      return;
    }
    return rutas[nombre]()(req, res);
  }

  despachar.nombreDeRuta = nombreDeRuta;
  despachar.rutas = Array.from(conocidas);
  return despachar;
}

module.exports = { crearDespachador };
