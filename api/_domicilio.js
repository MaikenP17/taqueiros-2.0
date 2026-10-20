/* =============================================================
   COSTO DE DOMICILIO — CALCULO AUTORITATIVO (lado servidor)

   El navegador muestra el precio para que el cliente lo vea, pero
   NO decide cuanto se cobra: manda solo las coordenadas y aqui se
   recalcula todo. Igual que con los precios de los productos.

   MULTI-RESTAURANTE: cada restaurante tiene SU origen, SU factor de
   recorrido y SUS tarifas:

     * Tarifas: tabla tarifas_domicilio (hasta km, precio; precio nulo =
       fuera de cobertura). Ya NO estan escritas en el codigo.
     * Origen (donde esta el local): restaurantes.config.ubicacion
       = { "lat": 7.89, "lng": -72.49 }
     * Opcional: restaurantes.config.domicilio = {
         "factor_recorrido": 1.3,
         "pin_minimo_metros": 100,
         "area": { "latMin": .., "latMax": .., "lngMin": .., "lngMax": .. } }

   Un restaurante sin tarifas o sin ubicacion NO ofrece domicilio: el pedido
   a domicilio se rechaza con un mensaje claro (nunca se inventan precios).

   TRANSITORIO (solo Taqueiros): mientras su config no traiga la ubicacion, se
   usan estas coordenadas de siempre. Si cambian, hay que cambiarlas TAMBIEN
   en el mismo bloque de index.html (busca "TARIFAS_DOMICILIO").
============================================================= */

const { RESTAURANTE_TAQUEIROS_ID } = require("./_restaurante.js");

/* -------------------------------------------------------------
   COORDENADAS DE TAQUEIROS (respaldo transitorio)
   Cl 1AN #3E-7, Barrio La Ceiba, Cucuta, Norte de Santander.
   Coordenadas confirmadas por el dueno desde Google Maps.
------------------------------------------------------------- */
const ORIGEN_TAQUEIROS = {
  lat: 7.8997382,
  lng: -72.4968525
};

/* -------------------------------------------------------------
   FACTOR DE RECORRIDO REAL
   Haversine da la distancia en linea recta ("vuelo de pajaro").
   Una moto recorre mas por las calles, asi que se multiplica.
   1.3 = 30% mas que la linea recta. Sube el numero si notas que
   el domicilio queda barato para lo que realmente se recorre.
------------------------------------------------------------- */
const FACTOR_RECORRIDO = 1.3;

/* Margen de tolerancia al comparar la distancia que reporto el
   navegador con la que calcula el servidor. Evita rechazar un
   pedido por diferencias de redondeo. */
const TOLERANCIA_KM = 0.05;

/* Distancia en linea recta entre dos puntos, en kilometros. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // radio de la Tierra en km
  const rad = (x) => (x * Math.PI) / 180;

  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);

  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function coordenadasValidas(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180;
}

/* Lo que hace falta para calcular el domicilio de UN restaurante:
     { origen: {lat, lng}, factor, tarifas: [{hasta, precio}], configurado }
   'restaurante' es su fila; 'filasTarifas' viene de tarifas_domicilio.
   Devuelve null si no se puede calcular (sin ubicacion o sin tarifas). */
function contextoDomicilio(restaurante, filasTarifas) {
  const cfg = (restaurante && restaurante.config) || {};
  const dom = (cfg.domicilio && typeof cfg.domicilio === "object") ? cfg.domicilio : {};

  let origen = null;
  const u = cfg.ubicacion;
  if (u && coordenadasValidas(Number(u.lat), Number(u.lng))) {
    origen = { lat: Number(u.lat), lng: Number(u.lng) };
  } else if (restaurante && restaurante.id === RESTAURANTE_TAQUEIROS_ID) {
    origen = ORIGEN_TAQUEIROS;   // transitorio
  }

  const tarifas = (Array.isArray(filasTarifas) ? filasTarifas : [])
    .map((t) => ({ hasta: Number(t.hasta), precio: t.precio == null ? null : Number(t.precio) }))
    .filter((t) => Number.isFinite(t.hasta) && (t.precio === null || Number.isFinite(t.precio)))
    .sort((a, b) => a.hasta - b.hasta);

  if (!origen || !tarifas.length) return null;

  const factor = Number(dom.factor_recorrido);
  return {
    origen,
    factor: Number.isFinite(factor) && factor > 0 ? factor : FACTOR_RECORRIDO,
    tarifas
  };
}

/* Distancia aproximada de recorrido desde el local. */
function distanciaDesdeRestaurante(lat, lng, ctx) {
  const recta = haversineKm(ctx.origen.lat, ctx.origen.lng, lat, lng);
  return recta * ctx.factor;
}

/* Tarifa que corresponde a unas coordenadas, con el contexto del restaurante.
   Devuelve { km, precio, fueraDeCobertura }. */
function calcularDomicilio(lat, lng, ctx) {
  const km = distanciaDesdeRestaurante(lat, lng, ctx);
  const tramo = ctx.tarifas.find((t) => km <= t.hasta);

  return {
    km: Math.round(km * 10) / 10,
    precio: tramo && tramo.precio != null ? tramo.precio : 0,
    fueraDeCobertura: !tramo || tramo.precio == null
  };
}

module.exports = {
  ORIGEN_TAQUEIROS,
  FACTOR_RECORRIDO,
  TOLERANCIA_KM,
  haversineKm,
  contextoDomicilio,
  distanciaDesdeRestaurante,
  calcularDomicilio,
  coordenadasValidas
};
