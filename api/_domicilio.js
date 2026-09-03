/* =============================================================
   COSTO DE DOMICILIO — CALCULO AUTORITATIVO (lado servidor)

   El navegador muestra el precio para que el cliente lo vea, pero
   NO decide cuanto se cobra: manda solo las coordenadas y aqui se
   recalcula todo. Igual que con los precios de los productos.

   Si estos numeros cambian, hay que cambiarlos TAMBIEN en el mismo
   bloque de index.html (busca "TARIFAS_DOMICILIO").
============================================================= */

/* -------------------------------------------------------------
   COORDENADAS DEL RESTAURANTE
   Cl 1AN #3E-7, Barrio La Ceiba, Cucuta, Norte de Santander.

   Coordenadas confirmadas por el dueno desde Google Maps.

   Para cambiarlas: abre Google Maps, ubica el local, haz click
   derecho encima y copia las coordenadas del primer renglon del
   menu. Pegalas aqui Y en index.html: deben ser IDENTICAS en los
   dos archivos, o el cliente vera un precio y se le cobrara otro.
------------------------------------------------------------- */
const RESTAURANTE = {
  lat: 7.8997382,
  lng: -72.4968525
};

/* -------------------------------------------------------------
   TARIFAS POR DISTANCIA
   'hasta' = limite superior del rango, en kilometros.
   'precio' = null significa "fuera de cobertura", se coordina
   por WhatsApp y no se cobra automaticamente.

   Para cambiar precios, edita solo la columna 'precio'.
   Para cambiar los rangos, edita 'hasta'. Deben ir de menor a
   mayor.
------------------------------------------------------------- */
const TARIFAS_DOMICILIO = [
  { hasta: 2,   precio: 5000  },  // 0 – 2 km
  { hasta: 4,   precio: 7000  },  // 2 – 4 km
  { hasta: 6,   precio: 9000  },  // 4 – 6 km
  { hasta: 8,   precio: 12000 },  // 6 – 8 km
  { hasta: 999, precio: null  }   // +8 km → "Consultar por WhatsApp"
];

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

/* Distancia aproximada de recorrido desde el restaurante. */
function distanciaDesdeRestaurante(lat, lng) {
  const recta = haversineKm(RESTAURANTE.lat, RESTAURANTE.lng, lat, lng);
  return recta * FACTOR_RECORRIDO;
}

/* Tarifa que corresponde a una distancia dada.
   Devuelve { km, precio, fueraDeCobertura }. */
function calcularDomicilio(lat, lng) {
  const km = distanciaDesdeRestaurante(lat, lng);
  const tramo = TARIFAS_DOMICILIO.find((t) => km <= t.hasta);

  return {
    km: Math.round(km * 10) / 10,
    precio: tramo && tramo.precio != null ? tramo.precio : 0,
    fueraDeCobertura: !tramo || tramo.precio == null
  };
}

/* Valida que unas coordenadas sean numeros creibles. */
function coordenadasValidas(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180;
}

module.exports = {
  RESTAURANTE,
  TARIFAS_DOMICILIO,
  FACTOR_RECORRIDO,
  TOLERANCIA_KM,
  haversineKm,
  distanciaDesdeRestaurante,
  calcularDomicilio,
  coordenadasValidas
};
