/* =============================================================
   RESTAURANTE Y ACCESO DEL PERSONAL (una sola copia)

   panel.html, menu-admin.html e historial.html no llevan escrito nada de
   ningun restaurante. Al cargar:

     1. Piden /api/restaurante (el SERVIDOR decide el restaurante por el
        dominio, ver docs/multirestaurante.md 12.2) con restaurante-publico.js.
        Dominio desconocido o servidor caido: mensaje neutro, sin datos.
     2. Pintan la marca de ESE restaurante: nombre, logo, favicon, colores,
        tipografias (de una lista permitida) y color de la barra del navegador.
     3. Cuando alguien inicia sesion, comprueban que sea MIEMBRO ACTIVO de ese
        restaurante (tabla miembros) antes de pedir un solo dato.

   COMO SE USA (en este orden, al final del <body>)
     <script src="supabase-publico.js?v=2"></script>
     <script src="restaurante-publico.js?v=2"></script>
     <script src="panel-restaurante.js?v=1"></script>
   y en el script de la pagina:
     PR.arrancar({ tituloBase: "Panel de Comandas", alListo: function (R) { ... } });
   El HTML marca lo que muestra la marca:
     data-marca-nombre     -> recibe el nombre como texto
     data-marca-logo       -> <img>: recibe el logo (y el nombre como 'alt', salvo
                              que ademas lleve data-marca-decorativo)
     data-pr-rol           -> recibe el rol del usuario (Dueño / Cajero / Cocina)

   POR QUE LA COMPROBACION DE MEMBRESIA ES SEGURA
   No es lo que protege los datos: eso lo hace RLS en la base (cada consulta
   corre con la sesion del usuario). Esta comprobacion existe para dos cosas:
     * no mostrar el panel de un restaurante a quien no es de ahi (mensaje claro
       y cierre de sesion), y
     * que un usuario miembro de DOS restaurantes vea solo el del dominio donde
       entro: RLS le deja ver los dos, asi que la separacion la hace el
       restaurante_id explicito en cada consulta de las paginas.
   Quien la saltara editando el navegador no gana nada: RLS sigue mandando.

   SEGURIDAD DE LO QUE LLEGA DE LA BASE
   Todo es dato no confiable. Nombre y rol entran con textContent; los colores
   deben ser #RRGGBB exactos (restaurante-publico.js ya los valida) y se aplican
   con setProperty; las tipografias son NOMBRES de una lista (RP.FUENTES): la
   direccion de Google Fonts se arma aqui, nunca viene de la configuracion; las
   imagenes pasan por RP (rutas del sitio o http(s) del Supabase del proyecto).
============================================================= */
(function () {
  "use strict";

  var RP = window.RP;
  var PR = { R: null, rid: null, rol: null };
  window.PR = PR;

  /* Roles que existen en miembros.rol y como se muestran. Un rol que no esta aqui no entra. */
  var ROLES = { dueno: "Dueño", cajero: "Cajero", cocina: "Cocina" };
  PR.ROLES = ROLES;

  PR.MENSAJE_SIN_ACCESO = "Tu usuario no tiene acceso a este restaurante.";
  PR.MENSAJE_ERROR = "No pudimos verificar tu acceso. Revisa tu conexión; seguimos intentando.";

  var REINTENTO_MS = 8000;
  var RECHEQUEO_MS = 10 * 60 * 1000;

  /* ---------------------------------------------------------------
     COLORES (mismas variables CSS que usan las tres paginas)
  --------------------------------------------------------------- */
  var VARIABLES = {
    primario: "--rojo", primario_oscuro: "--rojo-oscuro", primario_brillo: "--rojo-brillo",
    claro: "--crema", claro_suave: "--crema-suave", oscuro: "--carbon", oscuro_2: "--carbon-2",
    acento: "--mostaza", positivo: "--verde", positivo_brillo: "--verde-brillo"
  };
  /* Los que la hoja de estilos usa tambien con transparencia: rgba(var(--x-rgb), .5) */
  var CON_RGB = {
    primario: "--rojo-rgb", primario_brillo: "--rojo-brillo-rgb", claro: "--crema-rgb", oscuro: "--carbon-rgb",
    oscuro_2: "--carbon-2-rgb", acento: "--mostaza-rgb", positivo: "--verde-rgb", positivo_brillo: "--verde-brillo-rgb"
  };
  var HEX = /^#[0-9A-Fa-f]{6}$/;

  function canal(hex, i) { return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16); }
  function aRgb(hex) { return canal(hex, 0) + "," + canal(hex, 1) + "," + canal(hex, 2); }
  function aHex(r, g, b) {
    return "#" + [r, g, b].map(function (n) { var h = n.toString(16); return h.length < 2 ? "0" + h : h; }).join("").toUpperCase();
  }

  /* Tercer nivel de superficie (--carbon-3): un paso mas alla de oscuro_2 en la misma direccion en la que
     oscuro_2 se aleja de oscuro. Con la paleta del primer restaurante da exactamente el tono que estas paginas tenian escrito. */
  function nivelTres(oscuro, oscuro2) {
    var c = [0, 1, 2].map(function (i) {
      var v = Math.round(canal(oscuro2, i) + 1.25 * (canal(oscuro2, i) - canal(oscuro, i)));
      return Math.max(0, Math.min(255, v));
    });
    return aHex(c[0], c[1], c[2]);
  }

  PR.aplicarColores = function (R) {
    var raiz = document.documentElement.style;
    var c = R.marca.colores;
    Object.keys(VARIABLES).forEach(function (k) {
      if (!c[k] || !HEX.test(c[k])) return;
      raiz.setProperty(VARIABLES[k], c[k]);
      if (CON_RGB[k]) raiz.setProperty(CON_RGB[k], aRgb(c[k]));
      if (k === "claro") raiz.setProperty("--texto-claro", c[k]);
    });
    /* En estas paginas el texto secundario es el 'tenue' de la marca (el mismo gris calido de siempre en el primer restaurante). */
    var sec = c.texto_tenue || c.texto_secundario;
    if (sec && HEX.test(sec)) raiz.setProperty("--texto-secundario", sec);
    if (c.oscuro && c.oscuro_2 && HEX.test(c.oscuro) && HEX.test(c.oscuro_2)) {
      raiz.setProperty("--carbon-3", nivelTres(c.oscuro, c.oscuro_2));
    }
  };

  /* ---------------------------------------------------------------
     TIPOGRAFIAS (nombres de la lista permitida; nunca una URL de la configuracion)
  --------------------------------------------------------------- */
  function pila(nombre) {
    var f = RP.FUENTES[nombre];
    return "'" + nombre + "', " + f.generica;
  }

  PR.urlFuentes = function (R) {
    var t = R.marca.tipografia;
    var nombres = [t.titulos];
    if (t.cuerpo !== t.titulos) nombres.push(t.cuerpo);
    return "https://fonts.googleapis.com/css2?" +
      nombres.map(function (n) { return "family=" + RP.FUENTES[n].familia; }).join("&") + "&display=swap";
  };

  PR.aplicarFuentes = function (R) {
    var t = R.marca.tipografia;
    if (!RP.FUENTES[t.titulos] || !RP.FUENTES[t.cuerpo]) return null;   // (normalizar ya lo garantiza)
    var raiz = document.documentElement.style;
    raiz.setProperty("--fuente-titulos", pila(t.titulos));
    raiz.setProperty("--fuente-cuerpo", pila(t.cuerpo));
    var enlace = document.createElement("link");
    enlace.setAttribute("rel", "stylesheet");
    enlace.setAttribute("href", PR.urlFuentes(R));
    document.head.appendChild(enlace);
    return enlace;
  };

  /* ---------------------------------------------------------------
     NOMBRE, LOGO, ICONOS Y TITULO
  --------------------------------------------------------------- */
  function rutaDeIcono(u) {
    return /^https?:/i.test(u) || u.charAt(0) === "/" ? u : "/" + u;
  }

  PR.aplicarIconos = function (R) {
    Array.prototype.slice.call(document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')).forEach(function (l) {
      l.parentNode.removeChild(l);
    });
    var url = R.marca.logo || R.marca.icono_192;
    if (!url) return;
    [["icon", "image/png"], ["apple-touch-icon", ""]].forEach(function (par) {
      var e = document.createElement("link");
      e.setAttribute("rel", par[0]);
      if (par[1]) e.setAttribute("type", par[1]);
      e.setAttribute("href", rutaDeIcono(url));
      document.head.appendChild(e);
    });
  };

  PR.aplicarNombreYLogo = function (R) {
    var nombres = document.querySelectorAll("[data-marca-nombre]");
    for (var i = 0; i < nombres.length; i++) nombres[i].textContent = R.nombre;

    var logos = document.querySelectorAll("[data-marca-logo]");
    for (var j = 0; j < logos.length; j++) {
      if (R.marca.logo) {
        logos[j].setAttribute("src", R.marca.logo);
        logos[j].setAttribute("alt", logos[j].hasAttribute("data-marca-decorativo") ? "" : R.nombre);
        logos[j].style.display = "";
      } else {
        logos[j].removeAttribute("src");
        logos[j].style.display = "none";
      }
    }
  };

  PR.aplicarMarca = function (R, tituloBase) {
    PR.aplicarColores(R);
    var fuentes = PR.aplicarFuentes(R);
    PR.aplicarIconos(R);
    PR.aplicarNombreYLogo(R);
    if (tituloBase) document.title = tituloBase + " | " + R.nombre;
    var tema = document.querySelector('meta[name="theme-color"]');
    if (tema && R.marca.colores.primario && HEX.test(R.marca.colores.primario)) {
      tema.setAttribute("content", R.marca.colores.primario);
    }
    return fuentes;
  };

  /* ---------------------------------------------------------------
     ARRANQUE: restaurante -> marca -> la pagina
  --------------------------------------------------------------- */
  PR.arrancar = function (opciones) {
    var o = opciones || {};
    var programado = null;

    function intentar() {
      if (programado) { clearTimeout(programado); programado = null; }
      RP.cargar().then(function (R) {
        PR.R = R;
        PR.rid = R.id;
        var fuentes = PR.aplicarMarca(R, o.tituloBase);
        PR.migrarClaves();
        /* El telon se levanta cuando las tipografias llegan (o a los 1,2 s): sin eso se veria un
           instante la letra del sistema. */
        var yaListo = false;
        function listo() {
          if (yaListo) return;
          yaListo = true;
          RP.listo();
          if (typeof o.alListo === "function") o.alListo(R);
        }
        if (fuentes) {
          fuentes.addEventListener("load", listo);
          fuentes.addEventListener("error", listo);
          setTimeout(listo, 1200);
        } else {
          listo();
        }
      }, function (err) {
        var tipo = err && err.tipo === "desconocido" ? "desconocido" : "error";
        RP.mostrarNeutral(tipo, intentar);
        // Un servidor caido o sin red se reintenta solo (la cocina no puede quedarse en una pantalla de error)
        if (tipo === "error") programado = setTimeout(intentar, REINTENTO_MS);
      });
    }
    intentar();
  };

  /* ---------------------------------------------------------------
     MEMBRESIA
  --------------------------------------------------------------- */

  /* { ok:true, rol, userId }  |  { ok:false, motivo:"sin_sesion"|"sin_acceso"|"error" }
     'sin_acceso' = la base respondio y este usuario no es miembro activo de ESTE restaurante.
     'error' = no se pudo saber (red, 5xx): NO es un rechazo y no cierra la sesion. */
  PR.verificarAcceso = async function (db) {
    if (!PR.rid) return { ok: false, motivo: "error" };
    try {
      var s = await db.auth.getSession();
      var ses = s && s.data && s.data.session;
      var uid = ses && ses.user && ses.user.id;
      if (!uid) return { ok: false, motivo: "sin_sesion" };

      var r = await db.from("miembros").select("rol, activo")
        .eq("user_id", uid).eq("restaurante_id", PR.rid).eq("activo", true).limit(1);
      if (r.error) return { ok: false, motivo: "error", error: r.error };

      var fila = r.data && r.data[0];
      if (!fila || fila.activo !== true || !Object.prototype.hasOwnProperty.call(ROLES, fila.rol)) {
        return { ok: false, motivo: "sin_acceso" };
      }
      return { ok: true, rol: fila.rol, userId: uid };
    } catch (e) {
      return { ok: false, motivo: "error", error: e };
    }
  };

  /* Igual, pero un 'error' (sin red) se reintenta cada 8 s en vez de rendirse. 'alReintentar' deja
     avisar en pantalla. Devuelve solo ok / sin_sesion / sin_acceso. */
  PR.verificarAccesoPersistente = async function (db, alReintentar) {
    for (;;) {
      var r = await PR.verificarAcceso(db);
      if (r.motivo !== "error") return r;
      if (typeof alReintentar === "function") alReintentar(r);
      await new Promise(function (ok) { setTimeout(ok, REINTENTO_MS); });
    }
  };

  /* Cierra la sesion SOLO en este navegador (scope local): quien entra por el dominio equivocado
     no debe cerrarle la sesion a la cocina de su propio restaurante, que usa la misma cuenta. */
  PR.cerrarSesionLocal = async function (db) {
    try { await db.auth.signOut({ scope: "local" }); } catch (e) { /* ya estaba cerrada */ }
  };

  PR.mostrarRol = function (rol) {
    PR.rol = rol || null;
    var etiqueta = rol && ROLES[rol] ? ROLES[rol] : "";
    var els = document.querySelectorAll("[data-pr-rol]");
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = etiqueta ? "Tu rol: " + etiqueta : "";
      els[i].hidden = !etiqueta;
    }
    /* Opciones que son solo de algunos roles: data-solo-rol="dueno" (o varios separados por espacio). Se
       muestran solo con ese rol. Esconderlas NO es lo que protege: la base rechaza lo que el rol no puede hacer. */
    var solo = document.querySelectorAll("[data-solo-rol]");
    for (var j = 0; j < solo.length; j++) {
      var roles = (solo[j].getAttribute("data-solo-rol") || "").split(" ");
      solo[j].hidden = !(rol && ROLES[rol] && roles.indexOf(rol) >= 0);
    }
    /* Si el rol cambia o se pierde con el formulario de datos abierto, se cierra */
    if (rol !== "dueno" && window.DatosRestaurante && typeof window.DatosRestaurante.cerrar === "function") window.DatosRestaurante.cerrar();
  };

  /* Vuelve a comprobar la membresia de vez en cuando (la quitaron mientras el panel seguia abierto).
     Solo un 'sin_acceso' firme dispara 'alPerder'; un error de red no hace nada. */
  PR.vigilarAcceso = function (db, alPerder) {
    var ultimo = Date.now();
    async function revisar() {
      ultimo = Date.now();
      var r = await PR.verificarAcceso(db);
      if (r.motivo === "sin_acceso") alPerder(r);
    }
    setInterval(revisar, RECHEQUEO_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && Date.now() - ultimo > 5 * 60 * 1000) revisar();
    });
  };

  /* ---------------------------------------------------------------
     ALMACENAMIENTO DEL NAVEGADOR
     localStorage es por origen y cada restaurante tiene el suyo; aun asi las claves de las
     preferencias del panel llevan el id del restaurante (un preview con ?r= comparte origen).
  --------------------------------------------------------------- */
  var MIGRACIONES = [
    // [nombre nuevo, nombre anterior, ¿lleva el id del restaurante?]
    ["panel-imprimir-v2", "taqueiros-panel-imprimir-v1", true],
    ["panel-sonido-v2", "taqueiros-panel-sonido-v1", true],
    ["panel-vistos-v2", "taqueiros-pedidos-vistos-v1", true],
    ["panel-impresos-local-v2", "taqueiros-impresos-local-v1", true],
    ["panel-depurar-conexion-v2", "taqueiros-depurar-conexion", true],
    ["panel-ticket-tamano-v1", "taqueiros-panel-ticket-tamano-v1", false],
    ["panel-ticket-hoja-v1", "taqueiros-panel-ticket-hoja-v1", false]
  ];
  /* Clave que dejo la sesion propia que se uso un tiempo (ver panel.html): ya no se lee. */
  var CLAVES_OBSOLETAS = ["taqueiros-panel-sesion"];

  PR.clave = function (nombre) { return nombre + ":" + PR.rid; };

  /* Las preferencias que ya tenia un equipo (impresion activa, sonido, tamano del ticket...) pasan a
     las claves nuevas UNA vez, para que el panel de la cocina no se "olvide" de nada al actualizar.
     No se migra con ?r= en la direccion (un preview no hereda las preferencias de otro restaurante). */
  PR.migrarClaves = function () {
    try {
      if (new URLSearchParams(location.search).get("r")) return;
      MIGRACIONES.forEach(function (m) {
        var nueva = m[2] ? PR.clave(m[0]) : m[0];
        if (localStorage.getItem(nueva) !== null) return;
        var vieja = localStorage.getItem(m[1]);
        if (vieja !== null) localStorage.setItem(nueva, vieja);
      });
      CLAVES_OBSOLETAS.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* sin almacenamiento: se parte de cero */ }
  };

  PR.leerLocal = function (nombre) {
    try { return localStorage.getItem(PR.clave(nombre)); } catch (e) { return null; }
  };
  PR.guardarLocal = function (nombre, valor) {
    try { localStorage.setItem(PR.clave(nombre), valor); return true; } catch (e) { return false; }
  };

  PR.MIGRACIONES = MIGRACIONES;   // para las pruebas
})();
