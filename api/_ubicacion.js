const { haversineKm } = require("./_domicilio.js");
const { RESTAURANTE_TAQUEIROS_ID } = require("./_restaurante.js");

/* =============================================================
   VERIFICACION DEL PUNTO DE ENTREGA

   Un pin mal marcado le cuesta plata al restaurante: se cobra el
   domicilio de 2 km cuando en realidad son 8. Aqui se detectan las
   marcas sospechosas para que el panel avise ANTES de despachar.

   Nada de esto bloquea el pedido: solo lo senala para revisar.

   MULTI-RESTAURANTE: el origen (donde esta el local) y el area de cobertura son
   los del restaurante. El area sale de restaurantes.config.domicilio.area; si un
   restaurante no la define, no se hace esa comprobacion (solo Taqueiros
   conserva, de forma transitoria, la caja de Cucuta de abajo).
============================================================= */

/* Un pin a menos de 100 metros del local casi siempre significa que
   el cliente no movio el mapa y dejo el pin encima del restaurante. */
const METROS_MINIMOS = 100;

/* Caja aproximada del area urbana de Cucuta y su area metropolitana
   (Villa del Rosario, Los Patios, El Zulia). Un pin fuera de aqui
   es un error de marcado casi seguro.
   Para ampliar la cobertura, agranda estos limites.
   (Respaldo transitorio de Taqueiros; los demas la traen en su config.) */
const AREA_CUCUTA = {
  latMin: 7.75, latMax: 8.10,
  lngMin: -72.68, lngMax: -72.35
};

function areaValida(a) {
  return !!a && ["latMin", "latMax", "lngMin", "lngMax"].every((k) => Number.isFinite(Number(a[k])));
}

/* Opciones de verificacion de UN restaurante: { origen, area|null, metrosMinimos }.
   'ctx' es el resultado de contextoDomicilio (ya trae el origen). */
function opcionesUbicacion(restaurante, ctx) {
  const dom = (restaurante && restaurante.config && restaurante.config.domicilio) || {};
  let area = null;
  if (areaValida(dom.area)) {
    area = { latMin: Number(dom.area.latMin), latMax: Number(dom.area.latMax), lngMin: Number(dom.area.lngMin), lngMax: Number(dom.area.lngMax) };
  } else if (restaurante && restaurante.id === RESTAURANTE_TAQUEIROS_ID) {
    area = AREA_CUCUTA;
  }
  const minimo = Number(dom.pin_minimo_metros);
  return {
    origen: ctx.origen,
    area,
    metrosMinimos: Number.isFinite(minimo) && minimo >= 0 ? minimo : METROS_MINIMOS
  };
}

/* Normaliza un nombre de barrio para poder compararlo: sin tildes,
   sin mayusculas, sin palabras de relleno. */
function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // quita tildes
    .toLowerCase()
    .replace(/\b(barrio|urbanizacion|urb|conjunto|el|la|los|las|de|del)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/* Compara el barrio escrito con el detectado. Es deliberadamente
   permisivo: solo dice "no coinciden" cuando son claramente
   distintos, para no llenar el panel de avisos falsos. */
function barriosSeParecen(escrito, detectado) {
  const a = normalizar(escrito);
  const b = normalizar(detectado);

  if (!a || !b) return true;             // sin datos, no se opina
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // Comparten un trozo largo? (ej: "quintabosch" vs "laquintabosch")
  const corto = a.length < b.length ? a : b;
  const largo = a.length < b.length ? b : a;
  for (let i = 0; i + 5 <= corto.length; i++) {
    if (largo.includes(corto.slice(i, i + 5))) return true;
  }
  return false;
}

/* Pregunta a OpenStreetMap que barrio hay en unas coordenadas.
   Es de MEJOR ESFUERZO: si tarda o falla, devuelve null y el pedido
   sigue su curso normal. Nunca debe romper un pago. */
async function barrioSegunMapa(lat, lng) {
  const url = "https://nominatim.openstreetmap.org/reverse"
    + `?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`;

  const control = new AbortController();
  const alarma = setTimeout(() => control.abort(), 2500);

  try {
    const resp = await fetch(url, {
      signal: control.signal,
      headers: {
        /* La politica de uso de Nominatim exige identificar la
           aplicacion. Sin esto pueden bloquear el acceso sin avisar,
           y perderiamos la verificacion de barrio sin enterarnos.

           OJO: esto SOLO funciona desde el servidor. User-Agent es
           un "forbidden header name" en los navegadores: si este
           modulo se llamara desde el frontend, el navegador lo
           ignoraria en silencio. Por eso _ubicacion.js lo usa
           unicamente api/crear-pedido.js, que corre en Vercel. */
        "User-Agent": "Taqueiros/1.0 (bycharles54@gmail.com)"
      }
    });
    if (!resp.ok) return null;

    const datos = await resp.json();
    const d = datos && datos.address ? datos.address : {};
    return d.neighbourhood || d.suburb || d.quarter || d.city_district || d.residential || null;
  } catch (err) {
    console.warn("[Ubicacion] Nominatim no respondio:", err.message);
    return null;
  } finally {
    clearTimeout(alarma);
  }
}

/* Revisa el punto de entrega y devuelve:
     { barrioDetectado, sospechosa }
   'sospechosa' es null si todo se ve bien, o un texto corto con el
   motivo, que es lo que el panel muestra en el badge ambar. */
async function verificarUbicacion(lat, lng, barrioEscrito, opciones) {
  const { origen, area, metrosMinimos } = opciones;
  const metros = haversineKm(origen.lat, origen.lng, lat, lng) * 1000;

  // 1) Pin encima del restaurante
  if (metros < metrosMinimos) {
    return {
      barrioDetectado: null,
      sospechosa: "El pin quedó sobre el restaurante (" + Math.round(metros) + " m)"
    };
  }

  // 2) Pin fuera del area de cobertura de la ciudad
  if (area && (lat < area.latMin || lat > area.latMax
      || lng < area.lngMin || lng > area.lngMax)) {
    return {
      barrioDetectado: null,
      sospechosa: area === AREA_CUCUTA
        ? "El pin quedó fuera del área de Cúcuta"
        : "El pin quedó fuera del área de cobertura"
    };
  }

  // 3) El barrio escrito no cuadra con la zona del pin
  const barrioDetectado = await barrioSegunMapa(lat, lng);

  if (barrioDetectado && barrioEscrito && !barriosSeParecen(barrioEscrito, barrioDetectado)) {
    return {
      barrioDetectado,
      sospechosa: `Escribió "${barrioEscrito}" pero el pin cae en "${barrioDetectado}"`
    };
  }

  return { barrioDetectado, sospechosa: null };
}

module.exports = {
  verificarUbicacion,
  opcionesUbicacion,
  barriosSeParecen,
  normalizar,
  METROS_MINIMOS,
  AREA_CUCUTA
};
