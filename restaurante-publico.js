/* =============================================================
   DATOS DEL RESTAURANTE PARA LAS PAGINAS PUBLICAS (una sola copia)

   index.html y pedido.html no llevan escrito nada de ningun restaurante:
   al cargar piden /api/restaurante (el servidor decide el restaurante por el
   dominio) y se pintan con lo que llega: nombre, logo, colores, textos,
   WhatsApp, ubicacion, tarifas de domicilio y llave publica de pago.

   COMO SE USA
     <script src="supabase-publico.js?v=2"></script>
     <script src="restaurante-publico.js?v=1"></script>
   y despues, en el script de la pagina:
     RP.cargar().then(function (R) { ... }, function (err) { RP.mostrarNeutral(err.tipo, ...) });

   SEGURIDAD (todo lo que llega de la base es dato no confiable)
     * Nada de esto se inserta con innerHTML: los textos van con textContent; los
       atributos (src, href) solo con valores validados aqui.
     * Los colores deben ser #RRGGBB exactos y se aplican con setProperty sobre
       variables CSS: ningun valor puede abrir CSS nuevo.
     * Las imagenes (logo, iconos) son rutas relativas del propio sitio o http(s) del
       origen del propio sitio o del Supabase del proyecto; nunca javascript: ni data:.
     * normalizar() reconstruye el objeto campo por campo: lo que el servidor mande de mas
       o con mala forma se descarta (el servidor ya valida lo mismo: defensa en capas).

   SI NO HAY RESTAURANTE (dominio desconocido, servidor caido, respuesta invalida)
   se muestra un mensaje neutro (mostrarNeutral) sin ningun dato de ningun restaurante.

   CACHE DEL NAVEGADOR
   localStorage y sessionStorage son POR ORIGEN (esquema + dominio + puerto): dos
   restaurantes en dos dominios no comparten nada. Aun asi, lo que se guarda aqui (menu,
   carrito, seguimiento) lleva el id del restaurante y se descarta si no coincide: asi un
   mismo origen que sirviera a dos restaurantes (un preview con ?r=) tampoco los mezcla.
============================================================= */
(function () {
  "use strict";

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var COLOR = /^#[0-9A-Fa-f]{6}$/;
  var RUTA = /^\/?[A-Za-z0-9][A-Za-z0-9_\-.\/]*$/;
  var LLAVE = /^pub_(test|prod)_[A-Za-z0-9]{10,80}$/;
  var WHATSAPP = /^\d{8,15}$/;
  var USUARIO_RED = /^[A-Za-z0-9._]{1,60}$/;

  /* Controles, ancho cero y controles de direccion: se arma desde codigos para que ningun
     editor deje caracteres invisibles escritos en este archivo. */
  var CONTROLES = (function () {
    var barra = String.fromCharCode(92);
    function u(n) { var h = n.toString(16); while (h.length < 4) h = "0" + h; return barra + "u" + h; }
    var rangos = [[0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f], [0x202a, 0x202e],
                  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
    return new RegExp("[" + rangos.map(function (r) { return u(r[0]) + "-" + u(r[1]); }).join("") + "]", "g");
  })();
  var BLANCOS = new RegExp(String.fromCharCode(92) + "s+", "g");

  /* variable CSS de cada color de la marca */
  var VARIABLES = {
    primario: "--rojo", primario_oscuro: "--rojo-oscuro", primario_brillo: "--rojo-brillo",
    claro: "--crema", claro_suave: "--crema-suave", oscuro: "--carbon", oscuro_2: "--carbon-2",
    acento: "--mostaza", positivo: "--verde", texto_secundario: "--texto-secundario",
    texto_tenue: "--texto-tenue", positivo_brillo: "--verde-brillo"
  };
  /* los colores que la hoja de estilos usa tambien con transparencia (rgba(var(--x-rgb), .5)) */
  var CON_RGB = { primario: "--rojo-rgb", primario_oscuro: "--rojo-oscuro-rgb", primario_brillo: "--rojo-brillo-rgb", claro: "--crema-rgb",
                  oscuro: "--carbon-rgb", oscuro_2: "--carbon-2-rgb", acento: "--mostaza-rgb", positivo: "--verde-rgb" };

  /* Textos neutros: lo que se muestra cuando el restaurante no define el suyo. Ninguno es de un restaurante. */
  var NEUTROS = {
    banner_abierto_icono: "\u{1F7E2}",
    banner_abierto_titulo: "¡Estamos atendiendo!",
    banner_abierto_texto: "Ahora mismo estamos recibiendo pedidos{cierre}.",
    banner_cerrado_icono: "\u{1F552}",
    banner_cerrado_mensaje: "Por ahora no estamos recibiendo pedidos.",
    ejemplo_nota: "Ej: sin cebolla, tocar el timbre..."
  };
  var NEUTROS_SEGUIMIENTO = {
    tiempo_nuevo: "Tu pedido está en la fila de preparación",
    tiempo_preparacion: "Lo estamos preparando",
    tiempo_camino: "Tu pedido va en camino",
    tiempo_recoger: "¡Ya puedes pasar por él!",
    tiempo_entregado: "¡Buen provecho!",
    frase_nuevo: "¡Recibimos tu pedido!",
    frase_preparacion: "Lo estamos preparando",
    frase_camino: "¡Va en camino!",
    frase_recoger: "¡Tu pedido está listo!",
    frase_entregado: "¡Entregado!"
  };
  var EMOJI_NEUTRO = "\u{1F37D}️";

  /* Tipografias permitidas para las paginas del personal. NUNCA una URL ni un nombre libre:
     lo unico que llega de la configuracion es uno de estos nombres, y la direccion de Google Fonts
     se arma aqui con 'familia'. Debe ser la misma lista de nombres que api/_publico.js
     (FUENTES_PERMITIDAS; una prueba las compara). 'familia' es el texto del parametro family= de
     la API css2 con los pesos que esa fuente SI tiene. */
  var FUENTES = {
    "Anton": { familia: "Anton", generica: "sans-serif" },
    "Bebas Neue": { familia: "Bebas+Neue", generica: "sans-serif" },
    "Oswald": { familia: "Oswald:wght@400;500;600;700", generica: "sans-serif" },
    "Montserrat": { familia: "Montserrat:wght@400;500;600;700;800", generica: "sans-serif" },
    "Poppins": { familia: "Poppins:wght@400;500;600;700;800", generica: "sans-serif" },
    "Playfair Display": { familia: "Playfair+Display:wght@400;500;600;700;800", generica: "serif" },
    "Fredoka": { familia: "Fredoka:wght@400;500;600;700", generica: "sans-serif" },
    "Lora": { familia: "Lora:wght@400;500;600;700", generica: "serif" },
    "Merriweather": { familia: "Merriweather:wght@400;700", generica: "serif" },
    "Libre Franklin": { familia: "Libre+Franklin:wght@400;500;600;700;800", generica: "sans-serif" },
    "Open Sans": { familia: "Open+Sans:wght@400;500;600;700;800", generica: "sans-serif" },
    "Nunito": { familia: "Nunito:wght@400;500;600;700;800", generica: "sans-serif" },
    "Lato": { familia: "Lato:wght@400;700", generica: "sans-serif" },
    "DM Sans": { familia: "DM+Sans:wght@400;500;600;700", generica: "sans-serif" },
    "Work Sans": { familia: "Work+Sans:wght@400;500;600;700;800", generica: "sans-serif" },
    "Source Sans 3": { familia: "Source+Sans+3:wght@400;500;600;700", generica: "sans-serif" }
  };
  var FUENTE_TITULOS = "Anton";           // las de siempre: lo que se usa si el restaurante no elige
  var FUENTE_CUERPO = "Libre Franklin";

  var RP = {};
  RP.datos = null;
  RP.FUENTES = FUENTES;

  /* ---------------------------------------------------------------
     VALIDADORES
  --------------------------------------------------------------- */
  function texto(v, maximo) {
    if (typeof v !== "string") return null;
    var t = v.replace(CONTROLES, " ").replace(BLANCOS, " ").trim().slice(0, maximo || 300);
    return t || null;
  }
  function color(v) { return typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : null; }
  function fuente(v) {
    return typeof v === "string" && Object.prototype.hasOwnProperty.call(FUENTES, v.trim()) ? v.trim() : null;
  }

  function origenesPermitidos() {
    var lista = [location.origin];
    try {
      var s = window.SUPABASE_PUBLICO && window.SUPABASE_PUBLICO.url;
      if (s) lista.push(new URL(s).origin);
    } catch (e) { /* sin Supabase configurado */ }
    return lista;
  }
  function urlSegura(v) {
    if (typeof v !== "string") return null;
    var s = v.trim();
    if (!s || s.length > 500) return null;
    if (RUTA.test(s) && s.indexOf("..") < 0 && s.indexOf("//") < 0) return s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return origenesPermitidos().indexOf(u.origin) >= 0 ? u.href : null;
  }
  function numero(v, min, max) {
    var n = typeof v === "number" ? v : NaN;
    return isFinite(n) && n >= min && n <= max ? n : null;
  }
  function objeto(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }

  /* ---------------------------------------------------------------
     NORMALIZAR: reconstruye lo que llego del servidor, solo lo valido
  --------------------------------------------------------------- */
  function normalizar(raw) {
    if (!raw || typeof raw !== "object" || !UUID.test(String(raw.id || ""))) return null;
    var nombre = texto(raw.nombre, 120);
    if (!nombre) return null;

    var mod = objeto(raw.modulos);
    var serv = objeto(raw.servicio);
    var marca = objeto(raw.marca);
    var colores = {};
    var entrada = objeto(marca.colores);
    Object.keys(VARIABLES).forEach(function (k) { var c = color(entrada[k]); if (c) colores[k] = c; });
    var zonas = (Array.isArray(marca.colores_zonas) ? marca.colores_zonas : []).map(color).filter(Boolean).slice(0, 8);

    var tx = objeto(raw.textos);
    var textos = {};
    Object.keys(NEUTROS).concat(["titulo_pagina", "descripcion_pagina", "eslogan", "tagline", "descripcion_pie",
                                 "servicios_linea", "pie_final"]).forEach(function (k) {
      var t = texto(tx[k], 400); if (t) textos[k] = t;
    });
    var seg = objeto(tx.seguimiento);
    var textosSeguimiento = {};
    Object.keys(NEUTROS_SEGUIMIENTO).forEach(function (k) { var t = texto(seg[k], 200); if (t) textosSeguimiento[k] = t; });

    var ct = objeto(raw.contacto);
    var contacto = {};
    if (typeof ct.whatsapp === "string" && WHATSAPP.test(ct.whatsapp)) contacto.whatsapp = ct.whatsapp;
    ["telefono", "direccion", "direccion_corta", "ciudad", "region"].forEach(function (k) {
      var t = texto(ct[k], 200); if (t) contacto[k] = t;
    });
    ["instagram", "tiktok"].forEach(function (k) {
      if (typeof ct[k] === "string" && USUARIO_RED.test(ct[k])) contacto[k] = ct[k];
    });

    var ub = objeto(raw.ubicacion);
    var lat = numero(ub.lat, -90, 90), lng = numero(ub.lng, -180, 180);
    var dom = objeto(raw.domicilio);
    var tarifas = (Array.isArray(dom.tarifas) ? dom.tarifas : []).map(function (t) {
      t = objeto(t);
      var hasta = numero(t.hasta, 0, 100000);
      var precio = t.precio === null ? null : numero(t.precio, 0, 100000000);
      return hasta === null || (t.precio !== null && precio === null) ? null : { hasta: hasta, precio: precio };
    }).filter(Boolean).sort(function (a, b) { return a.hasta - b.hasta; });
    var factor = numero(dom.factor_recorrido, 0.1, 10);

    var pg = objeto(raw.pago);
    var modo = pg.modo === "test" || pg.modo === "produccion" ? pg.modo : null;
    var llave = typeof pg.llave_publica === "string" && LLAVE.test(pg.llave_publica)
      && pg.llave_publica.indexOf(modo === "produccion" ? "pub_prod_" : "pub_test_") === 0 ? pg.llave_publica : null;

    return {
      id: String(raw.id).toLowerCase(),
      slug: texto(raw.slug, 40) || "",
      nombre: nombre,
      modulos: {
        pasarela: mod.pasarela !== false, seguimiento: mod.seguimiento !== false,
        comandas: mod.comandas !== false, impresion: mod.impresion !== false
      },
      servicio: { sirve: serv.sirve !== false },
      marca: {
        logo: urlSegura(marca.logo), icono_192: urlSegura(marca.icono_192), icono_512: urlSegura(marca.icono_512),
        emoji: texto(marca.emoji, 8), colores: colores, coloresZonas: zonas,
        tipografia: {
          titulos: fuente(objeto(marca.tipografia).titulos) || FUENTE_TITULOS,
          cuerpo: fuente(objeto(marca.tipografia).cuerpo) || FUENTE_CUERPO
        }
      },
      textos: textos,
      textosSeguimiento: textosSeguimiento,
      contacto: contacto,
      ubicacion: lat !== null && lng !== null ? { lat: lat, lng: lng } : null,
      domicilio: {
        ofrece: dom.ofrece === true && lat !== null && lng !== null && tarifas.length > 0,
        factor: factor === null ? 1.3 : factor,
        tarifas: tarifas
      },
      pago: {
        disponible: pg.disponible === true && !!modo && !!llave && mod.pasarela !== false,
        modo: modo,
        llave: llave
      }
    };
  }

  /* ---------------------------------------------------------------
     CARGA
  --------------------------------------------------------------- */

  /* Un preview con ?r=<slug> (solo si el servidor lo permite) lo pasa a TODAS las llamadas a la API.
     En produccion el servidor lo ignora: el restaurante sale solo del dominio. */
  var PARAMETRO_R = (function () {
    try {
      var r = new URLSearchParams(location.search).get("r");
      return r && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(r) && r.length <= 40 ? r : "";
    } catch (e) { return ""; }
  })();
  RP.api = function (ruta) {
    return PARAMETRO_R ? ruta + (ruta.indexOf("?") < 0 ? "?" : "&") + "r=" + encodeURIComponent(PARAMETRO_R) : ruta;
  };

  function fallo(tipo, mensaje) { var e = new Error(mensaje); e.tipo = tipo; return e; }

  RP.cargar = function () {
    return fetch(RP.api("/api/restaurante"), { cache: "no-store" }).then(function (resp) {
      if (resp.status === 404) throw fallo("desconocido", "host desconocido");
      if (!resp.ok) throw fallo("error", "HTTP " + resp.status);
      return resp.json();
    }, function () { throw fallo("error", "sin conexion"); }).then(function (raw) {
      var R = normalizar(raw);
      if (!R) throw fallo("error", "respuesta invalida");
      RP.datos = R;
      return R;
    });
  };

  /* ---------------------------------------------------------------
     APLICAR LA MARCA
  --------------------------------------------------------------- */
  function aRgb(hex) {
    return parseInt(hex.slice(1, 3), 16) + "," + parseInt(hex.slice(3, 5), 16) + "," + parseInt(hex.slice(5, 7), 16);
  }

  RP.aplicarColores = function (R) {
    var raiz = document.documentElement.style;
    Object.keys(VARIABLES).forEach(function (k) {
      var c = R.marca.colores[k];
      if (!c) return;
      raiz.setProperty(VARIABLES[k], c);
      if (CON_RGB[k]) raiz.setProperty(CON_RGB[k], aRgb(c));
      if (k === "claro") raiz.setProperty("--texto-claro", c);
    });
  };

  RP.aplicarIconos = function (R) {
    Array.prototype.slice.call(document.querySelectorAll('link[rel="icon"]')).forEach(function (l) {
      l.parentNode.removeChild(l);
    });
    var url = R.marca.logo || R.marca.icono_192;
    if (!url) return;
    var enlace = document.createElement("link");
    enlace.setAttribute("rel", "icon");
    enlace.setAttribute("type", "image/png");
    enlace.setAttribute("href", url);
    document.head.appendChild(enlace);
  };

  /* Cualquier elemento con data-rp-logo recibe el logo (o se oculta si no hay) y el nombre como alt. */
  RP.aplicarLogos = function (R) {
    Array.prototype.slice.call(document.querySelectorAll("[data-rp-logo]")).forEach(function (img) {
      if (R.marca.logo) {
        img.setAttribute("src", R.marca.logo);
        img.setAttribute("alt", (img.getAttribute("data-rp-alt") === "logo" ? "Logo " : "") + R.nombre);
        img.style.display = "";
      } else {
        img.removeAttribute("src");
        img.style.display = "none";    // (no 'hidden': la hoja de estilos le da display:block a las img)
      }
    });
  };

  RP.emoji = function (R) { return (R && R.marca.emoji) || EMOJI_NEUTRO; };

  /* Texto del restaurante, o el neutro. Las plantillas llevan {variable}. */
  RP.t = function (clave, vars) {
    var R = RP.datos;
    var t = (R && R.textos[clave]) || NEUTROS[clave] || "";
    return RP.plantilla(t, vars);
  };
  RP.ts = function (clave) {
    var R = RP.datos;
    return (R && R.textosSeguimiento[clave]) || NEUTROS_SEGUIMIENTO[clave] || "";
  };
  RP.plantilla = function (t, vars) {
    return String(t).replace(/\{([a-z_]+)\}/g, function (m, k) {
      return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : "";
    });
  };

  /* "Casa del Sol" -> { prefijo: "Casa del ", resaltado: "Sol" }: la ultima palabra va resaltada. */
  RP.partesNombre = function (nombre) {
    var p = String(nombre).split(" ");
    if (p.length < 2) return { prefijo: "", resaltado: nombre };
    var ultima = p.pop();
    return { prefijo: p.join(" ") + " ", resaltado: ultima };
  };

  /* Enlace de WhatsApp del restaurante (o null si no tiene). */
  RP.whatsappUrl = function (R, textoPlano) {
    var n = R && R.contacto.whatsapp;
    if (!n) return null;
    return "https://wa.me/" + n + (textoPlano ? "?text=" + encodeURIComponent(textoPlano) : "");
  };

  /* ---------------------------------------------------------------
     ALMACEN POR RESTAURANTE (localStorage con el id dentro)
  --------------------------------------------------------------- */
  RP.leer = function (clave) {
    var R = RP.datos;
    if (!R) return null;
    try {
      var crudo = localStorage.getItem(clave);
      if (!crudo) return null;
      var e = JSON.parse(crudo);
      if (e && e.rid === R.id) return e.v;
      localStorage.removeItem(clave);       // era de otro restaurante: no se muestra
    } catch (err) { /* sin almacenamiento o dato roto */ }
    return null;
  };
  RP.guardar = function (clave, valor) {
    var R = RP.datos;
    if (!R) return;
    try { localStorage.setItem(clave, JSON.stringify({ rid: R.id, v: valor })); } catch (err) { /* lleno o bloqueado */ }
  };
  RP.borrar = function (clave) { try { localStorage.removeItem(clave); } catch (err) { /* nada */ } };

  /* ---------------------------------------------------------------
     PANTALLA NEUTRA (sin restaurante) y de carga
  --------------------------------------------------------------- */
  function estado() { return document.getElementById("rp-estado"); }

  /* Quita la pantalla de carga: la pagina ya esta pintada con los datos del restaurante. */
  RP.listo = function () {
    var e = estado();
    if (e && e.parentNode) e.parentNode.removeChild(e);
    document.documentElement.classList.add("rp-listo");
  };

  /* tipo: "desconocido" (404) | "error" (cualquier otro). Sin ningun dato de ningun restaurante. */
  RP.mostrarNeutral = function (tipo, reintentar) {
    var e = estado();
    if (!e) return;
    var desconocido = tipo === "desconocido";
    while (e.firstChild) e.removeChild(e.firstChild);

    var caja = document.createElement("div");
    caja.className = "rp-caja";
    var ic = document.createElement("div");
    ic.className = "rp-ic";
    ic.textContent = EMOJI_NEUTRO;
    var h = document.createElement("h1");
    h.textContent = desconocido ? "Este sitio no está disponible" : "No pudimos cargar la página";
    var p = document.createElement("p");
    p.textContent = desconocido
      ? "No encontramos el restaurante que buscas. Revisa que el enlace sea el correcto."
      : "Estamos teniendo un problema técnico. Intenta de nuevo en unos minutos.";
    caja.appendChild(ic); caja.appendChild(h); caja.appendChild(p);
    if (!desconocido) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "Reintentar";
      b.addEventListener("click", function () {
        if (typeof reintentar === "function") reintentar(); else location.reload();
      });
      caja.appendChild(b);
    }
    e.appendChild(caja);
    e.className = "rp-neutro";
    document.title = desconocido ? "Sitio no disponible" : "Sin conexión";
  };

  RP.normalizar = normalizar;   // para las pruebas
  window.RP = RP;
})();
