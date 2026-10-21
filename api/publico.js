const { crearDespachador } = require("./_despacho.js");

/* =============================================================
   FUNCION AGRUPADA: LOS ENDPOINTS PUBLICOS (por host)

   Una sola funcion de Vercel para lo que cualquier visitante pide al
   restaurante de su dominio. Cada ruta es un modulo de api/_modulos/ con el
   mismo manejador de siempre; vercel.json reescribe las URL de siempre hacia
   aqui (ver _despacho.js):

     /api/menu            ->  menu            el menu para la pagina del cliente
     /api/estado          ->  estado          abierto o cerrado, horario
     /api/disponibilidad  ->  disponibilidad  agotados y categorias apagadas
     /api/restaurante     ->  restaurante     datos publicos (marca, textos, pago)
     /api/manifest        ->  manifest        manifest de la PWA del panel
     /manifest.json       ->  manifest        (la misma, con la URL que lee el navegador)
     (rastreadores)       ->  vista-previa    index.html / pedido.html con las
                                              etiquetas de vista previa del restaurante

   El webhook de Wompi, crear-pedido, generar-firma y reembolso NO estan aqui:
   son sus propios archivos, sin tocar.
============================================================= */
module.exports = crearDespachador({
  menu: () => require("./_modulos/menu.js"),
  estado: () => require("./_modulos/estado.js"),
  disponibilidad: () => require("./_modulos/disponibilidad.js"),
  restaurante: () => require("./_modulos/restaurante.js"),
  manifest: () => require("./_modulos/manifest.js"),
  "vista-previa": () => require("./_modulos/vista-previa.js")
}, { "manifest.json": "manifest" });
