/* =============================================================
   PANTALLA DE SUPERADMINISTRACION: NUCLEO  (docs/multirestaurante.md, seccion 24)

   Este archivo trae: ayudas para armar la pagina SIN HTML, la sesion (Supabase Auth por fetch, sin librerias),
   la verificacion en dos pasos (MFA/TOTP), el cliente de POST /api/superadmin, la lista de restaurantes y la auditoria.
   Los otros archivos (superadmin-alta.js, -detalle.js, -lectura.js) cuelgan de window.SA; superadmin-inicio.js arranca todo.

   REGLAS QUE ESTE ARCHIVO CUMPLE (y que las pruebas vigilan)
     * Nada que venga del servidor o de la base se pinta como HTML: todo es createElement + textContent. No existe innerHTML,
       insertAdjacentHTML, document.write, eval ni new Function en ningun archivo superadmin*.js.
     * La sesion vive en sessionStorage (no localStorage, no cookies, nunca en la URL). No se imprime nada en consola.
     * Solo se usa la llave PUBLICABLE (supabase-publico.js). La llave secreta no llega jamas al navegador.
     * El servidor decide TODO: esta pantalla nunca escribe directo en la base; solo llama a POST /api/superadmin.
     * mfa_requerida -> pantalla del codigo, sin reintentar en bucle. 401 -> inicio de sesion. 429 -> aviso y espera.
============================================================= */
(function () {
  "use strict";

  var SA = window.SA = { vistas: {}, limpiadores: [], lista: null };
  var CFG = window.SUPABASE_PUBLICO;
  var AUTH = String(CFG.url).replace(/\/+$/, "") + "/auth/v1";
  var CLAVE_SESION = "sa-sesion-v1";

  /* ---------------------------------------------------------------
     ARMAR LA PAGINA SIN HTML
  --------------------------------------------------------------- */
  var PROHIBIDOS = /^(style|srcdoc|innerhtml|outerhtml|href|src|action|formaction|xlink:href)$/i;

  function h(etiqueta, atributos) {
    var el = document.createElement(etiqueta);
    if (atributos) {
      Object.keys(atributos).forEach(function (k) {
        var v = atributos[k];
        if (v === null || v === undefined || v === false) return;
        if (PROHIBIDOS.test(k)) throw new Error("atributo no permitido: " + k);
        if (k === "class") el.className = v;
        else if (k === "texto") el.textContent = v;
        else if (k.slice(0, 2) === "on") { if (typeof v === "function") el.addEventListener(k.slice(2), v); }
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) agregar(el, arguments[i]);
    return el;
  }
  function agregar(el, hijo) {
    if (hijo === null || hijo === undefined || hijo === false) return;
    if (Array.isArray(hijo)) { hijo.forEach(function (x) { agregar(el, x); }); return; }
    if (hijo instanceof Node) el.appendChild(hijo);
    else el.appendChild(document.createTextNode(String(hijo)));
  }

  /* Texto seguro para mostrar: los caracteres invisibles, de control y de direccion (los que sirven para disfrazar un nombre)
     se cambian por un cuadrito visible, y los textos enormes se cortan. */
  function esInvisible(c) {
    return c < 9 || c === 11 || c === 12 || (c >= 14 && c <= 31) || (c >= 127 && c <= 159) || c === 173 || c === 1564 || c === 4447 || c === 4448 || c === 6158 || c === 12644 || c === 65440 ||
      (c >= 8203 && c <= 8207) || (c >= 8232 && c <= 8238) || (c >= 8288 && c <= 8292) || (c >= 8294 && c <= 8303) || c === 65279 || (c >= 65529 && c <= 65531);
  }
  function cambiarInvisibles(s) {
    var o = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 56128 && i + 1 < s.length) { o += String.fromCharCode(9647); i++; continue; }   // etiquetas U+E0000 a U+E007F (par sustituto que empieza en 0xDB40)
      o += esInvisible(c) ? String.fromCharCode(9647) : s.charAt(i);
    }
    return o;
  }
  function t(valor, max) {
    if (valor === null || valor === undefined) return "";
    var s = (typeof valor === "string" ? valor : (typeof valor === "object" ? safeJson(valor) : String(valor)));
    s = cambiarInvisibles(s);
    max = max || 300;
    if (s.length > max) {
      s = s.slice(0, max);
      var ult = s.charCodeAt(s.length - 1);
      if (ult >= 0xD800 && ult <= 0xDBFF) s = s.slice(0, -1);
      s += "…";
    }
    return s;
  }
  function safeJson(o) { try { return JSON.stringify(o); } catch (e) { return "[dato no mostrable]"; } }
  SA.h = h; SA.t = t; SA.esInvisible = esInvisible;

  /* ---------------------------------------------------------------
     FECHAS Y DINERO  (las fechas de vigencia son 'AAAA-MM-DD' sin hora: se manejan como texto, sin zona)
  --------------------------------------------------------------- */
  var MESES = ["ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sep.", "oct.", "nov.", "dic."];
  var FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
  function fechaCorta(iso) {
    var m = FECHA.exec(String(iso || ""));
    if (!m) return iso ? t(iso, 30) : "—";
    return Number(m[3]) + " " + MESES[Number(m[2]) - 1] + " " + m[1];
  }
  function fechaHora(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return t(ts, 40);
    try { return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" }).format(d); }
    catch (e) { return d.toISOString(); }
  }
  function hoy() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function aUtc(iso) { var m = FECHA.exec(iso); return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])); }
  function diasEntre(desde, hasta) { return Math.round((aUtc(hasta) - aUtc(desde)) / 86400000); }
  function aIso(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function sumarDias(iso, n) { return aIso(aUtc(iso) + n * 86400000); }
  function sumarMeses(iso, n) {   // 31 ene + 1 mes = 28 feb (igual que la base)
    var m = FECHA.exec(iso); var y = Number(m[1]); var mes = Number(m[2]) - 1 + n; var dia = Number(m[3]);
    y += Math.floor(mes / 12); mes = ((mes % 12) + 12) % 12;
    var ultimo = new Date(Date.UTC(y, mes + 1, 0)).getUTCDate();
    return aIso(Date.UTC(y, mes, Math.min(dia, ultimo)));
  }
  function pesos(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    try { return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n); } catch (e) { return "$" + n; }
  }
  SA.fecha = { corta: fechaCorta, hora: fechaHora, hoy: hoy, entre: diasEntre, sumarDias: sumarDias, sumarMeses: sumarMeses, valida: function (s) { return FECHA.test(String(s || "")) && aIso(aUtc(s)) === s; } };
  SA.pesos = pesos;

  /* ---------------------------------------------------------------
     AVISOS, COPIAR, MODALES
  --------------------------------------------------------------- */
  var tAviso = null;
  function aviso(texto, ms) {
    var el = document.getElementById("sa-aviso");
    el.textContent = texto; el.hidden = false;
    clearTimeout(tAviso);
    if (ms !== 0) tAviso = setTimeout(function () { el.hidden = true; }, ms || 3500);
  }
  function ocultarAviso() { clearTimeout(tAviso); document.getElementById("sa-aviso").hidden = true; }
  SA.aviso = aviso;

  function copiar(texto) {
    var respaldo = function () {
      var ta = h("textarea", { "aria-hidden": "true", tabindex: "-1" });
      ta.value = texto; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.value = ""; ta.remove();
      return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(texto).then(function () { return true; }, function () { return respaldo(); });
    }
    return Promise.resolve(respaldo());
  }
  SA.copiar = function (texto, etiqueta) {
    return copiar(texto).then(function (ok) {
      aviso(ok ? (etiqueta || "Copiado") : "No se pudo copiar. Selecciónalo y cópialo a mano.", 2500);
      if (ok) programarVaciado();
      return ok;
    });
  };

  /* Portapapeles (R8): lo copiado queda ahi y esta pantalla NO copia nada sola. Mejor esfuerzo razonable: a los 60 segundos de copiar se intenta
     dejarlo vacio, SOLO si la pestana sigue visible y con foco (el navegador no deja escribir el portapapeles si no) y sin mostrar ningun
     error si no se puede. Limites: no borra el historial del portapapeles de Windows (Win+V) ni lo copiado desde otra aplicacion, y si
     en esos 60 segundos copiaste otra cosa estando en esta pestana, tambien se vacia. Cada copia nueva reinicia la cuenta. */
  var VACIAR_PORTAPAPELES_MS = 60000;
  var tVaciar = null;
  function programarVaciado() {
    clearTimeout(tVaciar);
    tVaciar = setTimeout(function () {
      tVaciar = null;
      try {
        if (document.visibilityState !== "visible" || !document.hasFocus()) return;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText("").then(function () { /* listo */ }, function () { /* el navegador no lo permitio: sin ruido */ });
      } catch (e) { /* el navegador no lo permite: sin ruido */ }
    }, VACIAR_PORTAPAPELES_MS);
  }
  /* El aviso corto que va junto a cada boton de copiar. */
  SA.avisoPortapapeles = function () {
    return h("p", { class: "sa-ayuda sa-aviso-copia", texto: "Ojo: lo que copias se queda en el portapapeles. Esta pantalla intenta vaciarlo a los 60 segundos; si no puede, copia cualquier otra cosa para borrarlo." });
  };

  /* Contrasena temporal (R4 y R6). La cuenta de los 3 minutos NO depende de que corra un temporizador: se guarda una HORA LIMITE absoluta
     (reloj del sistema y, de apoyo, performance.now) y se revisa cada segundo y tambien al volver a ver la pestana (visibilitychange,
     focus, pageshow). Si el computador se durmio o el navegador congelo la pestana, al volver ya vencio y se borra. Tambien se borra si la
     pestana estuvo oculta mas de un minuto. Mientras vive, la vista que la muestra NO se rearma si hay que volver a pedir el codigo (R6). */
  var MAX_OCULTA_MS = 60000;
  var clavesVivas = 0, vistasRetenidas = 0;
  SA.hayClaveViva = function () { return clavesVivas > 0; };
  SA.retenerVista = function () {   // devuelve la funcion que la libera (se puede llamar varias veces)
    var activa = true;
    vistasRetenidas++;
    return function () { if (activa) { activa = false; vistasRetenidas--; } };
  };
  SA.vigilarClave = function (o) {
    var ttl = (o.segundos || 180) * 1000;
    var finReloj = Date.now() + ttl, finMono = performance.now() + ttl;
    var oculto = document.hidden ? { reloj: Date.now(), mono: performance.now() } : null;
    var activo = true, intervalo = null;
    var liberar = SA.retenerVista();
    clavesVivas++;
    function restanteMs() { return Math.min(finReloj - Date.now(), finMono - performance.now()); }
    function parar() {
      if (!activo) return false;
      activo = false; clavesVivas--; liberar();
      clearInterval(intervalo);
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      window.removeEventListener("focus", revisar); window.removeEventListener("pageshow", revisar);
      return true;
    }
    function vencer(motivo) { if (parar() && o.alVencer) o.alVencer(motivo); }
    function revisar() {
      if (!activo) return;
      var r = restanteMs();
      if (r <= 0) { vencer("tiempo"); return; }
      if (o.alTic) o.alTic(Math.ceil(r / 1000));
    }
    function alCambiarVisibilidad() {
      if (!activo) return;
      if (document.hidden) { if (!oculto) oculto = { reloj: Date.now(), mono: performance.now() }; return; }
      if (oculto) {
        var fuera = Math.max(Date.now() - oculto.reloj, performance.now() - oculto.mono);
        oculto = null;
        if (fuera > MAX_OCULTA_MS) { vencer("oculta"); return; }
      }
      revisar();
    }
    intervalo = setInterval(revisar, 1000);
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    window.addEventListener("focus", revisar); window.addEventListener("pageshow", revisar);
    revisar();
    return { cancelar: parar, vivo: function () { return activo; } };
  };

  var modalAbierto = null;
  function abrirModal(titulo, cuerpo, botones) {
    cerrarModal();
    var previo = document.activeElement;
    var caja = h("div", { class: "sa-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "sa-modal-titulo", tabindex: "-1" },
      h("h2", { id: "sa-modal-titulo", texto: titulo }), cuerpo);
    var pie = h("div", { class: "sa-modal-botones" });
    var fondo = h("div", { class: "sa-modal-fondo" }, caja);
    var api = { el: caja, cuerpo: cuerpo, cerrar: cerrar, botones: {} };
    function cerrar() {
      if (modalAbierto !== api) return;
      modalAbierto = null; fondo.remove();
      document.removeEventListener("keydown", teclas, true);
      if (previo && previo.isConnected && previo.focus) previo.focus();
      if (api.alCerrar) api.alCerrar();
    }
    function teclas(ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); cerrar(); return; }
      if (ev.key !== "Tab") return;
      var f = caja.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      var primero = f[0], ultimo = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === primero) { ev.preventDefault(); ultimo.focus(); }
      else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primero.focus(); }
    }
    (botones || []).forEach(function (b) {
      var btn = h("button", { type: "button", class: "sa-btn " + (b.clase || ""), texto: b.texto });
      btn.addEventListener("click", function () { b.accion(api, btn); });
      api.botones[b.id || b.texto] = btn;
      pie.appendChild(btn);
    });
    if (pie.children.length) caja.appendChild(pie);
    document.getElementById("sa-modal-raiz").appendChild(fondo);
    document.addEventListener("keydown", teclas, true);
    modalAbierto = api;
    var primero = caja.querySelector("input:not([disabled]), select:not([disabled]), textarea") || pie.querySelector("button") || caja;
    primero.focus();
    return api;
  }
  function cerrarModal() { if (modalAbierto) modalAbierto.cerrar(); }
  SA.modal = abrirModal; SA.cerrarModal = cerrarModal;

  /* Confirmacion explicita: devuelve una promesa de true (confirmo) o false (cancelo o cerro). */
  SA.confirmar = function (o) {
    return new Promise(function (resolver) {
      var resuelta = false;
      var fin = function (v) { if (!resuelta) { resuelta = true; resolver(v); } };
      var cuerpo = h("div", null, (o.parrafos || [o.texto]).map(function (p) { return h("p", { texto: p }); }));
      var m = abrirModal(o.titulo, cuerpo, [
        { id: "cancelar", texto: o.cancelar || "Cancelar", clase: "sa-btn-fantasma", accion: function (mm) { fin(false); mm.cerrar(); } },
        { id: "confirmar", texto: o.boton || "Confirmar", clase: o.peligro ? "sa-btn-peligro" : "sa-btn-primario", accion: function (mm, btn) { if (btn.disabled) return; btn.disabled = true; fin(true); mm.cerrar(); } }
      ]);
      m.alCerrar = function () { fin(false); };
    });
  };

  /* ---------------------------------------------------------------
     ERRORES EN PANTALLA Y "UN SOLO ENVIO"
  --------------------------------------------------------------- */
  SA.mostrarError = function (area, e) {
    if (!area) return;
    if (e && e.silencioso) return;
    var texto = e && e.message ? e.message : "No se pudo completar la acción.";
    area.replaceChildren(h("div", { class: "sa-msj sa-msj-error", role: "alert", texto: t(texto, 600) }));
  };
  SA.mostrarOk = function (area, texto) { if (area) area.replaceChildren(h("div", { class: "sa-msj sa-msj-ok", role: "status", texto: texto })); };
  SA.limpiarMsj = function (area) { if (area) area.replaceChildren(); };

  /* Ejecuta fn() con el boton bloqueado hasta que termine: un doble clic no manda dos peticiones. */
  SA.enviar = function (btn, area, fn) {
    if (btn.getAttribute("data-ocupado") === "1") return Promise.resolve();
    btn.setAttribute("data-ocupado", "1"); btn.disabled = true;
    if (area) area.replaceChildren();
    var textoOriginal = btn.textContent;
    return Promise.resolve().then(fn).catch(function (e) { SA.mostrarError(area, e); })
      .then(function () {
        btn.removeAttribute("data-ocupado");
        if (btn.isConnected) { btn.disabled = false; btn.textContent = textoOriginal; }
      });
  };

  /* ---------------------------------------------------------------
     SESION (sessionStorage) Y LLAMADAS A SUPABASE AUTH (sin librerias)
  --------------------------------------------------------------- */
  var ses = null;               // { access, refresh, exp (segundos), email }
  var mfaEnCurso = false;       // true mientras se pide el codigo: no se llama a la API (evita bucles)
  var bloqueoHasta = 0;         // 429: no se llama a la API hasta esta hora (ms)
  var refrescando = null;
  var ultimoTic = 0;

  function leerSesionGuardada() {
    try {
      var s = JSON.parse(sessionStorage.getItem(CLAVE_SESION) || "null");
      if (s && typeof s.access === "string" && typeof s.refresh === "string" && typeof s.exp === "number") return s;
    } catch (e) { /* sin almacenamiento */ }
    return null;
  }
  function guardarSesion() {
    try { if (ses) sessionStorage.setItem(CLAVE_SESION, JSON.stringify(ses)); else sessionStorage.removeItem(CLAVE_SESION); } catch (e) { /* sin almacenamiento */ }
  }
  function aplicarSesion(j, correo) {
    if (!j || typeof j.access_token !== "string" || typeof j.refresh_token !== "string") return false;
    var exp = Number(j.expires_at) > 0 ? Number(j.expires_at) : Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600);
    ses = { access: j.access_token, refresh: j.refresh_token, exp: exp, email: correo || (j.user && j.user.email) || (ses && ses.email) || "" };
    guardarSesion();
    return true;
  }
  /* Solo para decidir que pantalla mostrar (el servidor vuelve a comprobarlo en CADA peticion). */
  function aalDe(token) {
    try {
      var p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      var c = JSON.parse(decodeURIComponent(escape(atob(p))));
      return c && c.aal === "aal2" ? "aal2" : "aal1";
    } catch (e) { return "aal1"; }
  }

  function authLlamar(metodo, ruta, cuerpo, token) {
    var cab = { apikey: CFG.publishableKey, "Content-Type": "application/json" };
    if (token) cab.Authorization = "Bearer " + token;
    return fetch(AUTH + ruta, {
      method: metodo, headers: cab, body: cuerpo === null || cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
        return { status: r.status, json: j, retry: r.headers.get("Retry-After") };
      });
    }, function () { return { status: 0, json: null }; });
  }

  /* ---------------------------------------------------------------
     CLIENTE DE POST /api/superadmin
  --------------------------------------------------------------- */
  function ErrApi(status, mensaje, codigo, cuerpo) {
    var e = new Error(mensaje); e.status = status; e.codigo = codigo || ""; e.cuerpo = cuerpo || null; return e;
  }
  function silencioso(motivo) { var e = new Error(motivo); e.silencioso = true; return e; }

  function llamarCrudo(accion, datos) {
    var cuerpo = { accion: accion };
    if (datos) Object.keys(datos).forEach(function (k) { cuerpo[k] = datos[k]; });
    return fetch("/api/superadmin", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ses.access },
      body: JSON.stringify(cuerpo), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
        return { status: r.status, json: j, retry: r.headers.get("Retry-After") };
      });
    }, function () { return { status: 0, json: null }; });
  }

  function api(accion, datos) {
    if (!ses) return Promise.reject(silencioso("sin-sesion"));
    if (mfaEnCurso) return Promise.reject(silencioso("mfa"));
    var ahora = Date.now();
    if (ahora < bloqueoHasta) {
      return Promise.reject(ErrApi(429, "Hay demasiados intentos seguidos. Espera " + Math.ceil((bloqueoHasta - ahora) / 1000) + " segundos e intenta de nuevo.", "limite"));
    }
    return llamarCrudo(accion, datos).then(function (r) {
      var j = r.json;
      if (r.status >= 200 && r.status < 300 && j) return j;
      if (r.status === 0) throw ErrApi(0, "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.", "red");
      if (r.status === 401) { sesionVencida("Tu sesión venció. Inicia sesión de nuevo."); throw silencioso("401"); }
      if (r.status === 403 && j && j.codigo === "mfa_requerida") {
        pedirCodigoOtraVez("Para seguir necesitas confirmar tu identidad con el código de tu app.");
        throw silencioso("mfa");
      }
      if (r.status === 403) { sesionVencida("Tu acceso ya no es válido. Inicia sesión de nuevo."); throw silencioso("403"); }
      if (r.status === 429) {
        var seg = Math.max(1, Math.min(900, Number(r.retry) || 60));
        bloqueoHasta = Date.now() + seg * 1000;
        aviso("Demasiados intentos. Espera " + seg + " segundos antes de volver a intentar.", Math.min(seg, 20) * 1000);
        throw ErrApi(429, "Hay demasiados intentos seguidos. Espera " + seg + " segundos e intenta de nuevo.", "limite");
      }
      throw ErrApi(r.status, (j && typeof j.error === "string" && j.error) || "No se pudo completar la acción (error " + r.status + ").", (j && j.codigo) || "", j);
    });
  }
  SA.api = api;

  /* Lecturas de "entrar como": una puerta aparte que SOLO deja pasar las 4 acciones de lectura. */
  var ACCIONES_LECTURA = ["ver_resumen", "ver_pedidos", "ver_menu", "ver_config"];
  SA.apiLectura = function (accion, datos) {
    if (ACCIONES_LECTURA.indexOf(accion) < 0) return Promise.reject(new Error("Acción no permitida en modo de solo lectura"));
    return api(accion, datos);
  };

  /* ---------------------------------------------------------------
     CAPAS DE LA PANTALLA
  --------------------------------------------------------------- */
  var capaPantalla, capaApp, barra, contenido, navBtns = {}, elEmail, elVence;

  function construirBase() {
    var raiz = document.getElementById("sa-raiz");
    capaPantalla = h("div", { id: "sa-capa-pantalla" });
    capaApp = h("div", { id: "sa-capa-app", hidden: true });
    raiz.replaceChildren(capaPantalla, capaApp);

    elEmail = h("span", { class: "sa-chico" });
    elVence = h("span", { class: "sa-vence", role: "timer", hidden: true });
    var cerrar = h("button", { type: "button", class: "sa-btn-fantasma", texto: "Cerrar sesión" });
    cerrar.addEventListener("click", function () { cerrarSesion("Cerraste sesión. Hasta pronto."); });
    var nav = h("nav", { class: "sa-nav", "aria-label": "Secciones" });
    [["lista", "Restaurantes"], ["alta", "Nuevo restaurante"], ["auditoria", "Auditoría"]].forEach(function (p) {
      var b = h("button", { type: "button", texto: p[1] });
      b.addEventListener("click", function () { SA.ir(p[0]); });
      navBtns[p[0]] = b; nav.appendChild(b);
    });
    barra = h("header", { class: "sa-barra" }, h("div", { class: "sa-marca" }, "RIVO ", h("span", { texto: "Administración" })), nav, h("div", { class: "sa-sesion" }, elEmail, elVence, cerrar));
    contenido = h("main", { class: "sa-contenedor", id: "sa-contenido", tabindex: "-1" });
    capaApp.appendChild(barra); capaApp.appendChild(contenido);
    SA.contenedorApp = function () { return capaApp; };
  }

  function mostrarPantalla(nodo) {
    capaApp.hidden = true;
    capaPantalla.hidden = false;
    capaPantalla.replaceChildren(nodo);
    window.scrollTo(0, 0);
  }
  function mostrarApp() {
    capaPantalla.replaceChildren(); capaPantalla.hidden = true;
    capaApp.hidden = false;
    elEmail.textContent = ses ? t(ses.email, 80) : "";
  }

  /* ---------------------------------------------------------------
     NAVEGACION INTERNA
  --------------------------------------------------------------- */
  var nav = 0, vistaActual = null;
  SA.vigente = function (n) { return n === nav; };
  SA.alSalirDeVista = function (fn) { SA.limpiadores.push(fn); };
  function limpiarVista() {
    var l = SA.limpiadores; SA.limpiadores = [];
    l.forEach(function (f) { try { f(); } catch (e) { /* una limpieza no debe frenar las demas */ } });
    cerrarModal();
    document.body.classList.remove("sa-en-lectura");
    barra.hidden = false;
  }
  SA.ir = function (nombre, params) {
    limpiarVista();
    nav++;
    vistaActual = { nombre: nombre, params: params || {} };
    Object.keys(navBtns).forEach(function (k) {
      if (k === nombre || (nombre === "detalle" && k === "lista")) navBtns[k].setAttribute("aria-current", "page"); else navBtns[k].removeAttribute("aria-current");
    });
    contenido.replaceChildren();
    var f = SA.vistas[nombre];
    if (f) f(contenido, vistaActual.params, nav);
    window.scrollTo(0, 0);
  };
  SA.recargarVista = function () { if (vistaActual) SA.ir(vistaActual.nombre, vistaActual.params); };
  SA.ocultarBarra = function (v) { barra.hidden = !!v; };

  /* ---------------------------------------------------------------
     CERRAR SESION / VENCIMIENTO
  --------------------------------------------------------------- */
  function limpiarTodo() {
    var habiaClave = clavesVivas > 0;   // R6: una contrasena temporal a la vista se pierde con la sesion; hay que avisarlo con claridad
    ses = null; mfaEnCurso = false; bloqueoHasta = 0; refrescando = null;
    try { sessionStorage.removeItem(CLAVE_SESION); } catch (e) { /* nada */ }
    limpiarVista();
    SA.lista = null; vistaActual = null; nav++;
    if (contenido) contenido.replaceChildren();
    if (elEmail) elEmail.textContent = "";
    if (elVence) elVence.hidden = true;
    cerrarModal(); ocultarAviso();
    return habiaClave;
  }
  function cerrarSesion(mensaje) {
    var token = ses && ses.access;
    limpiarTodo();
    if (token) authLlamar("POST", "/logout", null, token);
    mostrarEntrada(mensaje ? { tipo: "info", texto: mensaje } : null);
  }
  function sesionVencida(mensaje) {
    var token = ses && ses.access;
    var perdioClave = limpiarTodo();
    if (token) authLlamar("POST", "/logout", null, token);
    mostrarEntrada({ tipo: "aviso", texto: perdioClave
      ? mensaje + " La contraseña temporal que estaba en pantalla se borró y ya no se puede ver: si no alcanzaste a copiarla, crea otro usuario desde la pestaña Usuarios del restaurante o restablece la contraseña en Supabase."
      : mensaje });
  }
  SA.cerrarSesion = cerrarSesion;

  /* Renovar el token antes de que venza, con el flujo normal de Auth. */
  function refrescar() {
    if (refrescando || !ses) return refrescando;
    var miRefresh = ses.refresh;
    refrescando = authLlamar("POST", "/token?grant_type=refresh_token", { refresh_token: miRefresh }).then(function (r) {
      if (!ses) return;
      if (r.status === 200 && r.json && aplicarSesion(r.json)) {
        if (aalDe(ses.access) !== "aal2" && !mfaEnCurso && capaPantalla.hidden) {
          pedirCodigoOtraVez("Tu sesión se renovó, pero hay que confirmar de nuevo con el código de tu app.");
        }
        return;
      }
      if (r.status === 0 || r.status >= 500 || r.status === 429) return;   // fallo temporal: se reintenta en el siguiente tic
      sesionVencida("Tu sesión venció. Inicia sesión de nuevo.");
    }).then(function () { refrescando = null; }, function () { refrescando = null; });
    return refrescando;
  }
  function tic() {
    if (!ses) return;
    var restante = ses.exp - Math.floor(Date.now() / 1000);
    if (restante <= 90) refrescar();
    if (restante <= 120 && restante >= -5 && !capaApp.hidden) {
      var r = Math.max(0, restante);
      elVence.textContent = "La sesión vence en " + Math.floor(r / 60) + ":" + String(r % 60).padStart(2, "0");
      elVence.hidden = false;
    } else elVence.hidden = true;
    if (restante < -30 && !refrescando) sesionVencida("Tu sesión venció. Inicia sesión de nuevo.");
  }
  SA.iniciarReloj = function () { setInterval(tic, 5000); document.addEventListener("visibilitychange", function () { if (!document.hidden) tic(); }); };

  /* ---------------------------------------------------------------
     PANTALLA: INICIO DE SESION
  --------------------------------------------------------------- */
  var MSJ_GENERICO = "No pudimos iniciar sesión con esos datos. Revisa el correo y la contraseña.";

  function envolverPantalla(titulo, nodos) {
    return h("div", { class: "sa-centro" },
      h("div", { class: "sa-marca" }, "RIVO ", h("span", { texto: "Administración" })),
      h("div", { class: "sa-tarjeta" }, h("h1", { texto: titulo }), nodos));
  }
  function msjBloque(m) {
    if (!m) return null;
    return h("div", { class: "sa-msj " + (m.tipo === "error" ? "sa-msj-error" : m.tipo === "aviso" ? "sa-msj-aviso" : "sa-msj-info"), role: m.tipo === "error" ? "alert" : "status", texto: m.texto });
  }

  function mostrarEntrada(mensaje) {
    var area = h("div", { id: "sa-entrada-msj" });
    if (mensaje) area.appendChild(msjBloque(mensaje));
    var correo = h("input", { id: "sa-correo", type: "email", autocomplete: "username", required: true, inputmode: "email", maxlength: 254, autocapitalize: "off", spellcheck: "false" });
    var clave = h("input", { id: "sa-clave", type: "password", autocomplete: "current-password", required: true, maxlength: 200 });
    var btn = h("button", { type: "submit", class: "sa-btn sa-btn-primario", texto: "Entrar" });
    var form = h("form", { id: "sa-form-entrada", novalidate: true },
      h("div", { class: "sa-campo" }, h("label", { for: "sa-correo", texto: "Correo" }), correo),
      h("div", { class: "sa-campo" }, h("label", { for: "sa-clave", texto: "Contraseña" }), clave),
      btn);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var c = correo.value.trim(), p = clave.value;
      if (!c || !p) { area.replaceChildren(msjBloque({ tipo: "error", texto: "Escribe tu correo y tu contraseña." })); return; }
      SA.enviar(btn, null, function () {
        area.replaceChildren();
        return authLlamar("POST", "/token?grant_type=password", { email: c, password: p }).then(function (r) {
          clave.value = "";
          if (r.status === 200 && r.json && aplicarSesion(r.json, c)) { return continuarTrasClave(); }
          if (r.status === 429) { area.replaceChildren(msjBloque({ tipo: "error", texto: "Demasiados intentos. Espera unos minutos antes de volver a intentar." })); return; }
          if (r.status === 0 || r.status >= 500) { area.replaceChildren(msjBloque({ tipo: "error", texto: "No hay conexión con el servidor de acceso. Intenta de nuevo en un momento." })); return; }
          area.replaceChildren(msjBloque({ tipo: "error", texto: MSJ_GENERICO }));
        });
      });
    });
    mostrarPantalla(envolverPantalla("Entrar", [
      h("p", { class: "sa-tenue", texto: "Herramienta interna para administrar los restaurantes. Solo para quien opera el servicio." }),
      area, form]));
    correo.focus();
  }

  /* Despues de la contrasena: el SERVIDOR dice si es superadmin y con que nivel. Quien no lo es recibe EXACTAMENTE el mismo
     mensaje que con una contrasena mala, y se le cierra la sesion sin dar pistas. */
  function continuarTrasClave() {
    return llamarCrudo("mi_estado").then(function (r) {
      if (r.status === 200 && r.json && r.json.es_superadmin === true) {
        if (r.json.aal === "aal2") return entrarALaApp();
        return decidirMfa();
      }
      var token = ses && ses.access;
      limpiarTodo();
      if (token) authLlamar("POST", "/logout", null, token);
      if (r.status === 429) return mostrarEntrada({ tipo: "error", texto: "Demasiados intentos. Espera unos minutos antes de volver a intentar." });
      if (r.status === 0 || r.status >= 500) return mostrarEntrada({ tipo: "error", texto: "No pudimos verificar tu acceso. Intenta de nuevo en un momento." });
      mostrarEntrada({ tipo: "error", texto: MSJ_GENERICO });
    });
  }

  function entrarALaApp() {
    mfaEnCurso = false;
    mostrarApp();
    /* R6: si hay una contrasena temporal a la vista (o un alta a medias) y la pantalla tuvo que pedir el codigo otra vez, al confirmarlo se
       vuelve al MISMO lugar sin rearmar la vista: rearmarla borraria la contrasena (que vive solo en memoria y no se puede volver a ver). */
    if (vistaActual && vistasRetenidas > 0) { tic(); return; }
    if (SA.lista === null && !vistaActual) SA.ir("lista");
    else if (vistaActual) SA.recargarVista();
    else SA.ir("lista");
    tic();
  }

  /* ---------------------------------------------------------------
     VERIFICACION EN DOS PASOS (TOTP) POR LAS RUTAS DE AUTH
  --------------------------------------------------------------- */
  var enrolando = null;   // { id } mientras se muestra el QR; la clave en texto solo vive en el DOM

  function factoresDelUsuario() {
    return authLlamar("GET", "/user", null, ses.access).then(function (r) {
      if (r.status === 401) { sesionVencida("Tu sesión venció. Inicia sesión de nuevo."); throw silencioso("401"); }
      if (r.status !== 200 || !r.json) throw ErrApi(r.status, "No pudimos consultar tu verificación en dos pasos. Intenta de nuevo.");
      return Array.isArray(r.json.factors) ? r.json.factors : [];
    });
  }

  function decidirMfa() {
    return factoresDelUsuario().then(function (fs) {
      var ok = fs.filter(function (f) { return f && f.factor_type === "totp" && f.status === "verified"; })[0];
      if (ok) return mostrarCodigo(ok.id, null);
      return mostrarEnrolar(fs);
    }).catch(function (e) {
      if (e.silencioso) return;
      mostrarEntrada({ tipo: "error", texto: e.message });
    });
  }

  /* Un 403 mfa_requerida a mitad de sesion, o una renovacion que bajo a aal1: se pide el codigo (sin tocar la API mientras tanto). */
  function pedirCodigoOtraVez(texto) {
    if (mfaEnCurso || !ses) return;
    mfaEnCurso = true;
    factoresDelUsuario().then(function (fs) {
      var ok = fs.filter(function (f) { return f && f.factor_type === "totp" && f.status === "verified"; })[0];
      if (ok) mostrarCodigo(ok.id, { tipo: "aviso", texto: texto });
      else mostrarEnrolar(fs);
    }).catch(function (e) {
      if (e.silencioso) return;
      mfaEnCurso = false;
      sesionVencida("No pudimos confirmar tu verificación. Inicia sesión de nuevo.");
    });
  }

  function verificar(idFactor, codigo) {
    return authLlamar("POST", "/factors/" + encodeURIComponent(idFactor) + "/challenge", {}, ses.access).then(function (c) {
      if (c.status === 401) { sesionVencida("Tu sesión venció. Inicia sesión de nuevo."); throw silencioso("401"); }
      if (c.status === 429) return { ok: false, limite: true };
      if (c.status !== 200 || !c.json || typeof c.json.id !== "string") return { ok: false, error: true };
      return authLlamar("POST", "/factors/" + encodeURIComponent(idFactor) + "/verify", { challenge_id: c.json.id, code: codigo }, ses.access).then(function (v) {
        if (v.status === 200 && v.json && aplicarSesion(v.json)) return { ok: true };
        if (v.status === 401) { sesionVencida("Tu sesión venció. Inicia sesión de nuevo."); throw silencioso("401"); }
        if (v.status === 429) return { ok: false, limite: true };
        return { ok: false, malCodigo: v.status === 400 || v.status === 422 };
      });
    });
  }

  function confirmarAal2() {
    return llamarCrudo("mi_estado").then(function (r) {
      if (r.status === 200 && r.json && r.json.aal === "aal2") return true;
      return false;
    });
  }

  function mostrarCodigo(idFactor, mensaje) {
    mfaEnCurso = true;
    var area = h("div", { id: "sa-codigo-msj" });
    if (mensaje) area.appendChild(msjBloque(mensaje));
    var cod = h("input", { id: "sa-codigo", type: "text", class: "sa-codigo-entrada", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: 6, placeholder: "000000", "aria-describedby": "sa-codigo-ayuda" });
    var btn = h("button", { type: "submit", class: "sa-btn sa-btn-primario", texto: "Confirmar código" });
    var form = h("form", { novalidate: true },
      h("div", { class: "sa-campo" }, h("label", { for: "sa-codigo", texto: "Código de 6 dígitos" }), cod,
        h("p", { id: "sa-codigo-ayuda", class: "sa-ayuda", texto: "Abre la app de autenticación de tu celular y escribe el número que aparece para esta cuenta. Cambia cada 30 segundos." })),
      btn);
    cod.addEventListener("input", function () { cod.value = cod.value.replace(/\D/g, "").slice(0, 6); });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var c = cod.value;
      if (!/^\d{6}$/.test(c)) { area.replaceChildren(msjBloque({ tipo: "error", texto: "El código son 6 números." })); return; }
      SA.enviar(btn, null, function () {
        area.replaceChildren();
        return verificar(idFactor, c).then(function (r) {
          cod.value = "";
          if (r.ok) {
            return confirmarAal2().then(function (si) {
              if (si) return entrarALaApp();
              area.replaceChildren(msjBloque({ tipo: "error", texto: "El servidor no reconoció la verificación. Intenta de nuevo." }));
            });
          }
          if (r.limite) area.replaceChildren(msjBloque({ tipo: "error", texto: "Demasiados intentos. Espera un minuto y vuelve a intentar." }));
          else if (r.malCodigo) area.replaceChildren(msjBloque({ tipo: "error", texto: "Ese código no es correcto o ya venció. Espera al siguiente número de tu app y escríbelo de nuevo." }));
          else area.replaceChildren(msjBloque({ tipo: "error", texto: "No pudimos verificar el código. Intenta de nuevo en un momento." }));
        });
      });
    });
    var salir = h("button", { type: "button", class: "sa-btn-link", texto: "Cerrar sesión" });
    salir.addEventListener("click", function () { cerrarSesion("Cerraste sesión."); });
    var perdi = h("button", { type: "button", class: "sa-btn-link", texto: "Perdí mi celular" });
    perdi.addEventListener("click", function () { mostrarPerdida(function () { mostrarCodigo(idFactor, null); }); });
    mostrarPantalla(envolverPantalla("Verificación en dos pasos", [area, form, h("p", { class: "sa-chico" }, perdi, " · ", salir)]));
    cod.focus();
  }

  function limpiarFactoresSinVerificar(fs) {
    var pend = (fs || []).filter(function (f) { return f && f.status !== "verified" && typeof f.id === "string"; });
    return Promise.all(pend.map(function (f) { return authLlamar("DELETE", "/factors/" + encodeURIComponent(f.id), null, ses.access); }));
  }

  function mostrarEnrolar(fs) {
    mfaEnCurso = true;
    var area = h("div", { id: "sa-enrolar-msj" });
    mostrarPantalla(envolverPantalla("Activa la verificación en dos pasos", [h("p", { class: "sa-tenue", texto: "Preparando tu código QR…" })]));
    limpiarFactoresSinVerificar(fs).then(function () {
      var nombre = "rivo-" + Math.random().toString(36).slice(2, 8);
      return authLlamar("POST", "/factors", { factor_type: "totp", friendly_name: nombre, issuer: "Rivo" }, ses.access);
    }).then(function (r) {
      if (r.status === 401) { sesionVencida("Tu sesión venció. Inicia sesión de nuevo."); return; }
      if (r.status !== 200 || !r.json || !r.json.totp || typeof r.json.id !== "string") {
        mostrarPantalla(envolverPantalla("Activa la verificación en dos pasos", [
          h("div", { class: "sa-msj sa-msj-error", role: "alert", texto: r.status === 429 ? "Demasiados intentos. Espera un minuto y vuelve a entrar." : "No pudimos preparar la verificación. Revisa que el TOTP esté habilitado en Supabase (Authentication → Multi-Factor) e intenta de nuevo." }),
          h("button", { type: "button", class: "sa-btn", texto: "Cerrar sesión", onclick: function () { cerrarSesion(); } })]));
        return;
      }
      pintarEnrolar(r.json, area);
    });
  }

  function imagenQr(svg) {
    var s = String(svg || "");
    var uri;
    if (/^data:image\/svg\+xml/i.test(s)) uri = s;
    else if (s.indexOf("<svg") >= 0) uri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
    else return null;
    var img = document.createElement("img");
    img.className = "sa-qr"; img.alt = "Código QR para tu app de autenticación";
    img.setAttribute("src", uri);   // un <img> con un SVG no ejecuta scripts; nunca se inyecta como HTML
    return img;
  }

  function pintarEnrolar(f, area) {
    enrolando = { id: f.id };
    var qr = imagenQr(f.totp.qr_code);
    var clave = typeof f.totp.secret === "string" ? f.totp.secret : "";
    var cod = h("input", { id: "sa-codigo-alta", type: "text", class: "sa-codigo-entrada", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: 6, placeholder: "000000" });
    cod.addEventListener("input", function () { cod.value = cod.value.replace(/\D/g, "").slice(0, 6); });
    var btn = h("button", { type: "submit", class: "sa-btn sa-btn-primario", texto: "Activar" });
    var claveEl = h("div", { class: "sa-clave-valor", id: "sa-clave-texto", texto: clave });
    var form = h("form", { novalidate: true },
      h("div", { class: "sa-campo" }, h("label", { for: "sa-codigo-alta", texto: "Escribe el código de 6 dígitos que muestra tu app" }), cod), btn);
    function limpiarSecreto() { if (qr) qr.removeAttribute("src"); claveEl.textContent = ""; f = null; enrolando = null; }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var c = cod.value;
      if (!/^\d{6}$/.test(c)) { area.replaceChildren(msjBloque({ tipo: "error", texto: "El código son 6 números." })); return; }
      SA.enviar(btn, null, function () {
        area.replaceChildren();
        var id = enrolando && enrolando.id;
        return verificar(id, c).then(function (r) {
          cod.value = "";
          if (r.ok) {
            limpiarSecreto();
            return confirmarAal2().then(function (si) {
              if (si) return entrarALaApp();
              mostrarEntrada({ tipo: "error", texto: "No se pudo confirmar la verificación. Entra de nuevo." });
            });
          }
          if (r.limite) area.replaceChildren(msjBloque({ tipo: "error", texto: "Demasiados intentos. Espera un minuto y vuelve a intentar." }));
          else if (r.malCodigo) area.replaceChildren(msjBloque({ tipo: "error", texto: "Ese código no es correcto. Revisa que la hora de tu celular sea automática y escribe el número nuevo que aparece." }));
          else area.replaceChildren(msjBloque({ tipo: "error", texto: "No pudimos verificar el código. Intenta de nuevo en un momento." }));
        });
      });
    });
    var copiarBtn = h("button", { type: "button", class: "sa-btn", texto: "Copiar clave" });
    copiarBtn.addEventListener("click", function () { if (claveEl.textContent) SA.copiar(claveEl.textContent, "Clave copiada"); });
    var salir = h("button", { type: "button", class: "sa-btn-link", texto: "Cancelar y cerrar sesión" });
    salir.addEventListener("click", function () { limpiarSecreto(); cerrarSesion("Cerraste sesión."); });
    mostrarPantalla(envolverPantalla("Activa la verificación en dos pasos", [
      h("div", { class: "sa-msj sa-msj-info" },
        "Tu cuenta puede ver y cambiar todos los restaurantes. Con solo la contraseña, quien la robe podría hacerlo. Con este segundo paso hace falta además tu celular."),
      h("ol", null,
        h("li", { texto: "Instala una app de autenticación en tu celular: Google Authenticator, Microsoft Authenticator o Authy (cualquiera sirve, es gratis)." }),
        h("li", { texto: "En la app elige “agregar cuenta” y escanea este código QR." }),
        h("li", { texto: "Escribe abajo el número de 6 dígitos que aparece en la app." })),
      qr || h("p", { class: "sa-msj sa-msj-aviso", texto: "No se pudo mostrar el QR. Usa la clave de abajo." }),
      h("p", { class: "sa-ayuda", texto: "¿No puedes escanear? Escribe esta clave a mano en la app (tipo “basada en tiempo”):" }),
      claveEl, h("p", null, copiarBtn), SA.avisoPortapapeles(),
      area, form,
      h("p", { class: "sa-ayuda", texto: "Esta clave y este QR no se guardan en ningún lado: desaparecen al terminar. Guárdalos solo en tu app." }),
      h("p", { class: "sa-chico" }, salir)]));
    cod.focus();
  }

  /* ---------------------------------------------------------------
     PANTALLA: PERDI EL CELULAR (no se hace desde la pantalla, a proposito)
  --------------------------------------------------------------- */
  function mostrarPerdida(volver) {
    var pasos = [
      ["Abre PowerShell en la carpeta del proyecto y carga la llave secreta de Supabase (no se pega en ningún chat):", "$k = Read-Host \"Llave SECRETA\" -AsSecureString\n$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password"],
      ["Mira qué factores tiene tu usuario (solo los muestra, no borra nada):", "node supabase/quitar-mfa.mjs tu-correo@dominio.com"],
      ["Borra los factores:", "node supabase/quitar-mfa.mjs tu-correo@dominio.com --confirmar"],
      ["Quita la llave de la sesión:", "Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY"],
      ["Vuelve a esta pantalla, entra solo con tu contraseña y activa la verificación con tu celular nuevo.", null]
    ];
    var lista = h("ol", null, pasos.map(function (p) { return h("li", null, h("p", { texto: p[0] }), p[1] ? h("pre", { class: "sa-aud-resumen", texto: p[1] }) : null); }));
    var atras = h("button", { type: "button", class: "sa-btn", texto: "Volver" });
    atras.addEventListener("click", function () { if (volver) volver(); else mostrarEntrada(); });
    mostrarPantalla(envolverPantalla("Perdí mi celular", [
      h("p", { texto: "Esto no se puede hacer desde esta pantalla, a propósito: si se pudiera, quien robe tu contraseña también podría apagar el segundo paso. Se recupera con una herramienta de operador que usa la llave secreta de Supabase (la tiene solo quien administra el proyecto)." }),
      lista,
      h("div", { class: "sa-msj sa-msj-aviso" }, "Si sospechas que alguien robó tu sesión o tu contraseña: primero borra los factores como arriba, luego cambia la contraseña (así se terminan las sesiones abiertas), vuelve a activar la verificación y revisa la auditoría."),
      atras]));
  }

  /* ---------------------------------------------------------------
     LISTA DE RESTAURANTES
  --------------------------------------------------------------- */
  var ETIQUETA_ESTADO = { prueba: "En prueba", activo: "Activo", gracia: "En gracia", vencido: "Vencido", suspendido: "Suspendido" };
  var ETIQUETA_PLAN = { completo: "Completo", basico: "Básico", comandas: "Solo comandas" };
  var ETIQUETA_MODALIDAD = { mensual: "Mensual", unico: "Pago único" };
  SA.etiquetas = { estado: ETIQUETA_ESTADO, plan: ETIQUETA_PLAN, modalidad: ETIQUETA_MODALIDAD };

  function estadoDe(r) {
    var v = r && r.vigencia;
    var e = v && typeof v.estado === "string" ? v.estado : (r && r.estado);
    return ETIQUETA_ESTADO[e] ? e : "suspendido";
  }
  SA.estadoDe = estadoDe;
  SA.pill = function (estado) { return h("span", { class: "sa-pill sa-pill-" + (ETIQUETA_ESTADO[estado] ? estado : "neutro"), texto: ETIQUETA_ESTADO[estado] || t(estado, 20) }); };

  /* Texto del vencimiento, claro para quien no es tecnico. */
  SA.textoVigencia = function (r) {
    var v = r.vigencia || {}, est = estadoDe(r);
    var fecha = v.vigente_hasta || r.vigente_hasta;
    if (est === "suspendido") return "Suspendido a mano" + (fecha ? " · su fecha era " + fechaCorta(fecha) : "");
    if (v.sin_vencimiento || !fecha) return "Sin vencimiento";
    if (est === "gracia") {
      var q = Number(v.dias_para_suspension);
      return "Venció el " + fechaCorta(fecha) + " · " + (q <= 1 ? "hoy es el último día de gracia" : "se suspende en " + q + " días");
    }
    if (est === "vencido") { var n = diasEntre(fecha, hoy()); return "Venció el " + fechaCorta(fecha) + (n > 0 ? " (hace " + n + (n === 1 ? " día)" : " días)") : ""); }
    var d = Number(v.dias_restantes);
    return "Vence el " + fechaCorta(fecha) + " · " + (d === 0 ? "es hoy" : d === 1 ? "queda 1 día" : "quedan " + d + " días");
  };

  function ordenarVencimiento(a, b) {
    var fa = a.vigente_hasta || "9999-12-31", fb = b.vigente_hasta || "9999-12-31";
    if (fa !== fb) return fa < fb ? -1 : 1;
    return String(a.nombre).localeCompare(String(b.nombre), "es");
  }

  SA.vistas.lista = function (cont, params, n) {
    var errorArea = h("div");
    var buscador = h("input", { type: "search", id: "sa-buscar", placeholder: "Buscar por nombre, nombre corto o dominio", "aria-label": "Buscar restaurantes", maxlength: 80, autocomplete: "off" });
    var orden = h("select", { id: "sa-orden", "aria-label": "Ordenar" },
      h("option", { value: "venc", texto: "Ordenar: vencimiento más cercano" }),
      h("option", { value: "nombre", texto: "Ordenar: nombre (A a Z)" }),
      h("option", { value: "creado", texto: "Ordenar: más nuevos primero" }));
    var chips = h("div", { class: "sa-chips", role: "group", "aria-label": "Filtrar por estado" });
    var cuerpo = h("div", { id: "sa-lista-cuerpo" }, h("p", { class: "sa-vacio", texto: "Cargando restaurantes…" }));
    var filtro = "todos";
    var nuevo = h("button", { type: "button", class: "sa-btn sa-btn-primario", texto: "Nuevo restaurante" });
    nuevo.addEventListener("click", function () { SA.ir("alta"); });
    var refrescarBtn = h("button", { type: "button", class: "sa-btn", texto: "Actualizar" });
    cont.appendChild(h("div", { class: "sa-cabecera-vista" }, h("h1", { texto: "Restaurantes" }), h("div", { class: "sa-acciones" }, refrescarBtn, nuevo)));
    cont.appendChild(errorArea);
    cont.appendChild(h("div", { class: "sa-filtros" }, buscador, orden));
    cont.appendChild(chips);
    cont.appendChild(cuerpo);

    function pintar() {
      var datos = SA.lista || [];
      var cuentas = { todos: datos.length, prueba: 0, activo: 0, gracia: 0, vencido: 0, suspendido: 0 };
      datos.forEach(function (r) { cuentas[estadoDe(r)]++; });
      chips.replaceChildren();
      [["todos", "Todos"], ["prueba", "En prueba"], ["activo", "Activos"], ["gracia", "En gracia"], ["vencido", "Vencidos"], ["suspendido", "Suspendidos"]].forEach(function (p) {
        var b = h("button", { type: "button", "aria-pressed": filtro === p[0] ? "true" : "false", texto: p[1] + " (" + cuentas[p[0]] + ")" });
        b.addEventListener("click", function () { filtro = p[0]; pintar(); });
        chips.appendChild(b);
      });
      var q = buscador.value.trim().toLowerCase();
      var filas = datos.filter(function (r) {
        if (filtro !== "todos" && estadoDe(r) !== filtro) return false;
        if (!q) return true;
        return String(r.nombre).toLowerCase().indexOf(q) >= 0 || String(r.slug).toLowerCase().indexOf(q) >= 0 ||
          (Array.isArray(r.dominios) && r.dominios.some(function (d) { return String(d).toLowerCase().indexOf(q) >= 0; }));
      });
      var o = orden.value;
      filas = filas.slice().sort(o === "nombre" ? function (a, b) { return String(a.nombre).localeCompare(String(b.nombre), "es"); }
        : o === "creado" ? function (a, b) { return String(b.creado_en).localeCompare(String(a.creado_en)); } : ordenarVencimiento);
      if (!filas.length) {
        cuerpo.replaceChildren(h("p", { class: "sa-vacio", texto: datos.length ? "Ningún restaurante coincide con ese filtro." : "Todavía no hay restaurantes." }));
        return;
      }
      var tbody = h("tbody");
      filas.forEach(function (r) {
        var est = estadoDe(r);
        var abrir = h("button", { type: "button", class: "sa-nombre-btn", texto: t(r.nombre, 120), "aria-label": "Abrir " + t(r.nombre, 120) });
        abrir.addEventListener("click", function () { SA.ir("detalle", { id: r.id }); });
        var doms = Array.isArray(r.dominios) && r.dominios.length ? r.dominios.map(function (d) { return h("div", { class: "sa-mono sa-chico", texto: t(d, 120) }); }) : [h("span", { class: "sa-tenue", texto: "Sin dominio propio" })];
        tbody.appendChild(h("tr", null,
          h("td", { "data-etiqueta": "Nombre", class: "sa-sin-etiqueta" }, abrir,
            h("div", { class: "sa-chico sa-tenue sa-mono", texto: t(r.slug, 60) }), (r.demo === true || r.es_demo === true) ? h("span", { class: "sa-pill sa-pill-neutro", texto: "Demo" }) : null),
          h("td", { "data-etiqueta": "Plan" }, h("div", { texto: ETIQUETA_PLAN[r.plan] || t(r.plan, 20) }), h("div", { class: "sa-chico sa-tenue", texto: ETIQUETA_MODALIDAD[r.modalidad_pago] || t(r.modalidad_pago, 20) })),
          h("td", { "data-etiqueta": "Estado" }, SA.pill(est)),
          h("td", { "data-etiqueta": "Vencimiento" }, SA.textoVigencia(r)),
          h("td", { "data-etiqueta": "Dominios" }, doms)));
      });
      cuerpo.replaceChildren(h("table", { class: "sa-tabla" },
        h("thead", null, h("tr", null, ["Restaurante", "Plan", "Estado", "Vencimiento", "Dominios"].map(function (x) { return h("th", { scope: "col", texto: x }); }))),
        tbody));
    }
    buscador.addEventListener("input", pintar);
    orden.addEventListener("change", pintar);

    function cargar() {
      errorArea.replaceChildren();
      return SA.api("listar_restaurantes").then(function (r) {
        if (!SA.vigente(n)) return;
        SA.lista = Array.isArray(r.restaurantes) ? r.restaurantes : [];
        pintar();
      }).catch(function (e) {
        if (!SA.vigente(n)) return;
        cuerpo.replaceChildren();
        SA.mostrarError(errorArea, e);
      });
    }
    refrescarBtn.addEventListener("click", function () { SA.enviar(refrescarBtn, errorArea, cargar); });
    cargar();
  };

  /* ---------------------------------------------------------------
     AUDITORIA GLOBAL
  --------------------------------------------------------------- */
  var ACCIONES_AUD = {
    crear_restaurante: "Creó un restaurante", actualizar_restaurante: "Cambió datos del restaurante", registrar_pago: "Registró un pago",
    editar_config: "Editó la marca o los datos", guardar_tarifas: "Cambió las tarifas de domicilio", agregar_dominio: "Agregó un dominio",
    quitar_dominio: "Quitó un dominio", crear_usuario: "Creó un usuario", asignar_miembro: "Asignó un usuario", quitar_miembro: "Quitó un usuario",
    guardar_secretos: "Cargó secretos", ver_pedidos: "Miró los pedidos", ver_menu: "Miró el menú", ver_config: "Miró la configuración",
    ver_resumen: "Miró el resumen", rechazo_mfa: "Intento sin verificación en dos pasos"
  };
  SA.accionAuditoria = function (a) { return ACCIONES_AUD[a] || t(a, 60); };

  /* ---- Restaurante de una fila: el NOMBRE (de la lista ya cargada, sin pedir nada nuevo) y debajo el nombre corto.
     Si el restaurante ya no existe (por ejemplo uno de prueba borrado) o la lista aun no cargo, queda solo el nombre corto
     que la propia fila de auditoria guardo. ---- */
  function tiene(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function esObjeto(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
  function restauranteConocido(id, extra) {
    if (!id) return null;
    if (extra && extra.id === id) return extra;
    if (!Array.isArray(SA.lista)) return null;
    for (var i = 0; i < SA.lista.length; i++) if (SA.lista[i] && SA.lista[i].id === id) return SA.lista[i];
    return null;
  }
  SA.celdaRestaurante = function (fila, extra) {
    var r = restauranteConocido(fila.restaurante_id, extra);
    var slug = fila.restaurante_slug || (r && r.slug) || "";
    var nombre = r && r.nombre ? t(r.nombre, 80) : "";
    if (nombre && slug && nombre !== t(slug, 60)) return [h("div", { class: "sa-aud-rest", texto: nombre }), h("div", { class: "sa-chico sa-tenue sa-mono", texto: t(slug, 60) })];
    if (nombre) return [h("div", { class: "sa-aud-rest", texto: nombre })];
    return slug ? [h("div", { class: "sa-mono", texto: t(slug, 60) })] : [h("span", { class: "sa-tenue", texto: "—" })];
  };

  /* ---- "Ver resumen" en espanol claro. Solo se usan los campos que el servidor REALMENTE guarda en cada accion (SQL 16 y 19).
     Cualquier accion o campo que no se conozca queda como JSON en texto, tras el boton "Ver detalle tecnico". Todo se pinta con textContent. ---- */
  var ETQ_CAMPO = { nombre: "Nombre", estado: "Estado", plan: "Plan", modalidad_pago: "Modalidad de pago", vigente_hasta: "Vence", dias_gracia: "Días de gracia", modulos: "Módulos", zona_horaria: "Zona horaria" };
  var ETQ_SECCION = { marca: "Marca", wompi: "Wompi (llaves públicas)", pwa: "App del panel", contacto: "Contacto", textos: "Textos", ubicacion: "Ubicación", domicilio: "Domicilio" };
  var ETQ_SECCION_HECHO = { reemplazada: "reemplazada", borrada: "borrada" };
  var ETQ_ROL = { dueno: "Dueño", cajero: "Cajero", cocina: "Cocina" };
  var ETQ_MODO = { jornada: "jornada actual", recientes: "recientes (todas las jornadas)" };
  var ETQ_SECRETO = {
    wompi_llave_publica_test: "Wompi · llave pública (pruebas)", wompi_integridad_test: "Wompi · secreto de integridad (pruebas)", wompi_eventos_test: "Wompi · secreto de eventos (pruebas)", wompi_llave_privada_test: "Wompi · llave privada (pruebas)",
    wompi_llave_publica_prod: "Wompi · llave pública (producción)", wompi_integridad_prod: "Wompi · secreto de integridad (producción)", wompi_eventos_prod: "Wompi · secreto de eventos (producción)", wompi_llave_privada_prod: "Wompi · llave privada (producción)",
    callmebot_telefono: "CallMeBot · teléfono", callmebot_apikey: "CallMeBot · clave", wompi_modo: "Modo de cobro de Wompi" };
  var ETQ_RESULTADO_SECRETO = { guardado: "guardado", ya_coincide: "ya estaba puesto igual", ya_existe_otro_valor: "ya había otro valor (no se reemplazó)", repetido_en_otro_restaurante: "rechazado: otro restaurante ya usa ese valor", no_guardado: "no se guardó (por otro campo)" };
  function etq(mapa, k) { return typeof k === "string" && tiene(mapa, k) ? mapa[k] : t(k, 40); }
  function estadoLindo(v) { return typeof v === "string" && tiene(ETIQUETA_ESTADO, v) ? ETIQUETA_ESTADO[v].toLowerCase() : t(v, 40); }

  var FORMATOS = {
    crear_restaurante: function (c) {
      c.linea("Nombre", c.txt("nombre", 120)); c.linea("Nombre corto", c.txt("slug", 60));
      var plan = c.mapa("plan", ETIQUETA_PLAN), mod = c.mapa("modalidad_pago", ETIQUETA_MODALIDAD);
      c.linea("Plan", plan && mod ? plan + " · " + mod : plan || mod);
      if (c.hay("dominio")) c.linea("Dirección web", c.txt("dominio", 253) || "ninguna por ahora");
      if (c.hay("vigente_hasta")) c.linea("Vigente hasta", c.fecha("vigente_hasta"));
      c.linea("Días de gracia", c.num("dias_gracia")); c.linea("Zona horaria", c.txt("zona_horaria", 64));
      var m = c.obj("modulos");
      if (m) c.linea("Módulos incluidos", Object.keys(NOMBRES_MODULO()).filter(function (k) { return m[k] === true; }).map(function (k) { return NOMBRES_MODULO()[k]; }).join(", ") || "ninguno");
    },
    actualizar_restaurante: function (c) {
      var a = c.obj("antes"), d = c.obj("despues");
      if (!a || !d) { c.dudoso(); return; }
      Object.keys(ETQ_CAMPO).forEach(function (k) {
        if (!tiene(d, k) && !tiene(a, k)) return;
        if (k === "modulos") {
          var NM = NOMBRES_MODULO(), ma = esObjeto(a.modulos) ? a.modulos : {}, md = esObjeto(d.modulos) ? d.modulos : {};
          Object.keys(NM).forEach(function (m) { if (ma[m] !== md[m]) c.linea("Módulo «" + NM[m] + "»", (ma[m] === true ? "sí" : ma[m] === false ? "no" : "—") + " → " + (md[m] === true ? "sí" : md[m] === false ? "no" : "—")); });
          return;
        }
        var f = k === "estado" ? estadoLindo : k === "plan" ? function (v) { return etq(ETIQUETA_PLAN, v); } : k === "modalidad_pago" ? function (v) { return etq(ETIQUETA_MODALIDAD, v); }
          : k === "vigente_hasta" ? function (v) { return v === null ? "sin vencimiento" : fechaCorta(v); } : function (v) { return v === null || v === undefined ? "—" : t(v, 120); };
        c.linea(ETQ_CAMPO[k], f(a[k]) + " → " + f(d[k]));
      });
      Object.keys(a).concat(Object.keys(d)).forEach(function (k) { if (!tiene(ETQ_CAMPO, k)) c.dudoso(); });
    },
    registrar_pago: function (c) {
      var meses = c.num("meses");
      c.linea("Pago", meses !== null && meses !== undefined ? meses + (meses === 1 ? " mes" : " meses") : null);
      if (c.hay("monto")) { var mo = c.num("monto"); c.linea("Monto", mo === null || mo === undefined ? null : pesos(mo)); }
      if (c.hay("referencia")) c.linea("Referencia", c.txt("referencia", 80));
      if (c.hay("nota")) c.linea("Nota", c.txt("nota", 300));
      var antes = c.hay("vigente_hasta_anterior") ? c.fecha("vigente_hasta_anterior") : null, nueva = c.hay("vigente_hasta_nueva") ? c.fecha("vigente_hasta_nueva") : null;
      c.linea("Vencimiento", antes && nueva ? antes + " → " + nueva : nueva || antes);
      if (c.hay("contado_desde")) c.linea("Los meses se contaron desde", c.fecha("contado_desde"));
      var ea = c.hay("estado_anterior") ? c.txt("estado_anterior", 40) : null, en = c.hay("estado_nuevo") ? c.txt("estado_nuevo", 40) : null;
      if (ea && en && ea !== en) c.linea("Estado", estadoLindo(ea) + " → " + estadoLindo(en));
    },
    editar_config: function (c) {
      var s = c.obj("secciones");
      if (!s) { c.dudoso(); return; }
      Object.keys(s).forEach(function (k) { c.linea(etq(ETQ_SECCION, k), typeof s[k] === "string" ? etq(ETQ_SECCION_HECHO, s[k]) : null); });
    },
    guardar_tarifas: function (c) {
      var antes = c.num("tramos_antes"), despues = c.num("tramos_despues");
      if (typeof antes === "number" && typeof despues === "number") c.linea("Tramos de tarifa", antes + " → " + despues);
    },
    agregar_dominio: function (c) { c.linea("Dominio", c.txt("dominio", 253)); },
    quitar_dominio: function (c) { c.linea("Dominio", c.txt("dominio", 253)); },
    crear_usuario: function (c) { c.usar("usuario"); c.linea("Correo", c.txt("email", 254)); },
    asignar_miembro: function (c) { c.usar("usuario"); c.linea("Correo", c.txt("email", 254)); c.linea("Rol", c.mapa("rol", ETQ_ROL)); },
    quitar_miembro: function (c) { c.usar("usuario"); c.linea("Correo", c.txt("email", 254)); c.linea("Rol que tenía", c.mapa("rol_que_tenia", ETQ_ROL)); },
    guardar_secretos: function (c) {
      c.usar("campos_guardados");
      var r = c.obj("resultado");
      if (r) Object.keys(r).forEach(function (k) { c.linea(etq(ETQ_SECRETO, k), typeof r[k] === "string" ? etq(ETQ_RESULTADO_SECRETO, r[k]) : null); });
      if (c.hay("sobrescribir")) c.linea("Reemplazar valores ya cargados", c.si("sobrescribir"));
      if (c.hay("permitir_repetidos")) c.linea("Permitir valores que ya usa otro restaurante", c.si("permitir_repetidos"));
    },
    ver_pedidos: function (c) {
      c.linea("Pedidos mirados", c.mapa("modo", ETQ_MODO)); c.linea("Pedidos devueltos", c.num("devueltos"));
      if (c.hay("pagina_inicial")) c.linea("Página", c.si("pagina_inicial") === "sí" ? "la primera" : "una más antigua");
      c.linea("Tope por página", c.num("limite"));
    },
    ver_menu: function (c) { c.linea("Categorías", c.num("categorias")); c.linea("Productos", c.num("productos")); c.linea("Opciones", c.num("opciones")); },
    ver_config: function (c) { c.linea("Personas con acceso", c.num("miembros")); c.linea("Dominios", c.num("dominios")); },
    ver_resumen: function (c) { c.linea("Jornada mirada", c.fecha("jornada")); },
    rechazo_mfa: function (c) {
      var aal = c.txt("aal", 10);
      c.linea("Nivel de verificación", aal === "aal2" ? "completo (aal2)" : aal === "aal1" ? "solo contraseña, sin el código (aal1)" : aal);
      if (c.hay("accion_intentada")) { var ai = c.txt("accion_intentada", 60); c.linea("Quiso hacer", ai ? SA.accionAuditoria(ai) : "una acción que no se pudo identificar"); }
      if (c.hay("ventana_minutos")) { var vm = c.num("ventana_minutos"); if (typeof vm === "number") c.linea("Se avisa una sola vez cada", vm + " minutos"); }
    }
  };
  function NOMBRES_MODULO() { return SA.NOMBRE_MODULO || {}; }

  /* Devuelve { lineas, extra } o null si la accion no se conoce, el resumen no tiene la forma esperada o no se pudo explicar nada. */
  function resumenLegible(accion, r) {
    if (!esObjeto(r) || typeof accion !== "string" || !tiene(FORMATOS, accion)) return null;
    var usadas = Object.create(null), lineas = [], dudoso = false;   // sin prototipo: una clave "__proto__" del resumen es un dato mas
    var c = {
      hay: function (k) { usadas[k] = true; return tiene(r, k); },
      usar: function (k) { usadas[k] = true; },
      dudoso: function () { dudoso = true; },
      linea: function (etiqueta, valor) { if (valor === null || valor === undefined || valor === "") return; lineas.push(etiqueta + ": " + valor); },
      txt: function (k, max) { usadas[k] = true; if (!tiene(r, k)) return undefined; var v = r[k]; if (v === null) return null; if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return t(v, max || 120); dudoso = true; return undefined; },
      num: function (k) { usadas[k] = true; if (!tiene(r, k)) return undefined; var v = r[k]; if (v === null) return null; if (typeof v === "number" && isFinite(v)) return v; dudoso = true; return undefined; },
      si: function (k) { usadas[k] = true; if (!tiene(r, k)) return undefined; if (typeof r[k] === "boolean") return r[k] ? "sí" : "no"; dudoso = true; return undefined; },
      fecha: function (k) { usadas[k] = true; if (!tiene(r, k)) return undefined; var v = r[k]; if (v === null) return "sin vencimiento"; if (typeof v === "string") return fechaCorta(v.slice(0, 10)); dudoso = true; return undefined; },
      mapa: function (k, mapa) { usadas[k] = true; if (!tiene(r, k)) return undefined; var v = r[k]; if (v === null) return null; if (typeof v === "string") return etq(mapa, v); dudoso = true; return undefined; },
      obj: function (k) { usadas[k] = true; if (!tiene(r, k)) return undefined; if (esObjeto(r[k])) return r[k]; dudoso = true; return undefined; }
    };
    try { FORMATOS[accion](c); } catch (e) { return null; }
    Object.keys(r).forEach(function (k) { if (!usadas[k]) dudoso = true; });
    if (!lineas.length) return null;
    return { lineas: lineas.slice(0, 40).map(function (x) { return t(x, 400); }), extra: dudoso };
  }
  SA.resumenLegible = resumenLegible;

  function textoTecnico(r) {
    var s; try { s = JSON.stringify(r, null, 2); } catch (e) { s = "[dato no mostrable]"; }
    return t(s === undefined ? String(r) : s, 3000);
  }
  /* La celda "Detalle": resumen en espanol (si se conoce) y el boton "Ver detalle tecnico" con el JSON como texto. */
  function celdaDetalle(fila) {
    var r = fila.resumen;
    if (r === null || r === undefined || r === "" || (typeof r === "object" && Object.keys(r).length === 0)) return h("span", { class: "sa-tenue", texto: "—" });
    var legible = resumenLegible(fila.accion, r);
    var pre = h("pre", { class: "sa-aud-resumen", hidden: true, texto: textoTecnico(r) });
    var btn = h("button", { type: "button", class: "sa-btn sa-btn-chico", "data-tecnico": "1", "aria-expanded": "false", texto: "Ver detalle técnico" });
    btn.addEventListener("click", function () {
      pre.hidden = !pre.hidden;
      btn.setAttribute("aria-expanded", pre.hidden ? "false" : "true");
      btn.textContent = pre.hidden ? "Ver detalle técnico" : "Ocultar detalle técnico";
    });
    return h("details", { class: "sa-detalle" }, h("summary", { texto: "Ver resumen" }),
      legible ? h("ul", { class: "sa-aud-lineas" }, legible.lineas.map(function (x) { return h("li", { texto: x }); }))
        : h("p", { class: "sa-ayuda", texto: "Esta acción no tiene una explicación en español: este es el detalle técnico tal como quedó guardado." }),
      legible && legible.extra ? h("p", { class: "sa-ayuda", texto: "Hay datos que no se explican arriba: están en el detalle técnico." }) : null,
      btn, pre);
  }

  /* Una lista de auditoria con "cargar mas" (la usan la vista global y la pestana de cada restaurante). */
  SA.listaAuditoria = function (restauranteId, n, opciones) {
    opciones = opciones || {};
    var errorArea = h("div");
    var salida = h("div");
    var masBtn = h("button", { type: "button", class: "sa-btn", texto: "Cargar más antiguas", hidden: true });
    var filtroAccion = h("select", { id: "sa-aud-accion", "aria-label": "Filtrar por acción" }, h("option", { value: "", texto: "Todas las acciones" }));
    var ordenSel = h("select", { id: "sa-aud-orden", "aria-label": "Orden" },
      h("option", { value: "nuevas", texto: "Más recientes primero" }), h("option", { value: "viejas", texto: "Más antiguas primero" }));
    var filtroRest = null;
    var filas = [], ultimoId = null, id = restauranteId || null;
    var vistas = {};

    function pintar() {
      var af = filtroAccion.value;
      var ver = filas.filter(function (f) { return !af || f.accion === af; });
      if (ordenSel.value === "viejas") ver = ver.slice().reverse();
      if (!ver.length) { salida.replaceChildren(h("p", { class: "sa-vacio", texto: filas.length ? "Ninguna fila coincide con ese filtro." : "No hay registros todavía." })); return; }
      var tbody = h("tbody");
      ver.forEach(function (f) {
        tbody.appendChild(h("tr", null,
          h("td", { "data-etiqueta": "Cuándo" }, fechaHora(f.creado_en)),
          h("td", { "data-etiqueta": "Quién" }, t(f.actor_email || f.actor || "—", 120)),
          h("td", { "data-etiqueta": "Restaurante" }, SA.celdaRestaurante(f, opciones.restaurante)),
          h("td", { "data-etiqueta": "Acción" }, h("div", { texto: SA.accionAuditoria(f.accion) }), h("div", { class: "sa-chico sa-tenue sa-mono", texto: t(f.accion, 60) })),
          h("td", { "data-etiqueta": "Detalle" }, celdaDetalle(f))));
      });
      salida.replaceChildren(h("table", { class: "sa-tabla" },
        h("thead", null, h("tr", null, ["Cuándo", "Quién", "Restaurante", "Acción", "Detalle"].map(function (x) { return h("th", { scope: "col", texto: x }); }))), tbody));
    }
    function actualizarAcciones() {
      var actual = filtroAccion.value;
      var vistos = {};
      filas.forEach(function (f) { vistos[f.accion] = true; });
      filtroAccion.replaceChildren(h("option", { value: "", texto: "Todas las acciones" }));
      Object.keys(vistos).sort().forEach(function (a) { filtroAccion.appendChild(h("option", { value: a, texto: SA.accionAuditoria(a) })); });
      filtroAccion.value = vistos[actual] ? actual : "";
    }
    function cargar(reiniciar) {
      if (reiniciar) { filas = []; ultimoId = null; }
      var datos = { limite: 50 };
      if (id) datos.restaurante_id = id;
      if (ultimoId) datos.antes_de = ultimoId;
      errorArea.replaceChildren();
      return SA.api("listar_auditoria", datos).then(function (r) {
        if (!SA.vigente(n)) return;
        var nuevas = Array.isArray(r.auditoria) ? r.auditoria : [];
        filas = filas.concat(nuevas);
        if (nuevas.length) ultimoId = nuevas[nuevas.length - 1].id;
        masBtn.hidden = nuevas.length < 50;
        actualizarAcciones(); agregarRestaurantesBorrados(); pintar();
      }).catch(function (e) { if (SA.vigente(n)) SA.mostrarError(errorArea, e); });
    }
    masBtn.addEventListener("click", function () { SA.enviar(masBtn, errorArea, function () { return cargar(false); }); });
    filtroAccion.addEventListener("change", pintar);
    ordenSel.addEventListener("change", pintar);

    /* El filtro trae los restaurantes de la lista ("Nombre (nombre-corto)"). Los que salen en la auditoria pero ya no estan en la lista
       (uno de prueba que se borro) se agregan con su nombre corto, que es lo unico que se sabe de ellos. */
    var extrasFiltro = {};
    function agregarRestaurantesBorrados() {
      if (!filtroRest || !Array.isArray(SA.lista)) return;
      filas.forEach(function (f) {
        if (!f.restaurante_id || !f.restaurante_slug || extrasFiltro[f.restaurante_id] || restauranteConocido(f.restaurante_id)) return;
        extrasFiltro[f.restaurante_id] = true;
        filtroRest.appendChild(h("option", { value: f.restaurante_id, texto: t(f.restaurante_slug, 60) }));
      });
    }
    var barraFiltros = h("div", { class: "sa-filtros" });
    if (opciones.conSelectorRestaurante) {
      filtroRest = h("select", { id: "sa-aud-rest", "aria-label": "Filtrar por restaurante" }, h("option", { value: "", texto: "Todos los restaurantes" }));
      (SA.lista || []).forEach(function (r) { filtroRest.appendChild(h("option", { value: r.id, texto: t(r.nombre, 80) + " (" + t(r.slug, 40) + ")" })); });
      filtroRest.addEventListener("change", function () { id = filtroRest.value || null; cargar(true); });
      barraFiltros.appendChild(filtroRest);
    }
    barraFiltros.appendChild(filtroAccion); barraFiltros.appendChild(ordenSel);
    var raiz = h("div", null, barraFiltros, errorArea, salida, h("p", null, masBtn));
    salida.appendChild(h("p", { class: "sa-vacio", texto: "Cargando…" }));
    cargar(true);
    return raiz;
  };

  SA.vistas.auditoria = function (cont, params, n) {
    cont.appendChild(h("div", { class: "sa-cabecera-vista" }, h("h1", { texto: "Auditoría" })));
    cont.appendChild(h("p", { class: "sa-tenue", texto: "Todo lo que se hace desde esta pantalla queda aquí y no se puede borrar ni cambiar. Incluye cada vez que alguien mira un restaurante en modo de solo lectura." }));
    var montar = function () { cont.appendChild(SA.listaAuditoria(null, n, { conSelectorRestaurante: true })); };
    if (SA.lista) montar();
    else SA.api("listar_restaurantes").then(function (r) { SA.lista = Array.isArray(r.restaurantes) ? r.restaurantes : []; if (SA.vigente(n)) montar(); }).catch(function () { if (SA.vigente(n)) montar(); });
  };

  /* ---------------------------------------------------------------
     ARRANQUE (lo llama superadmin-inicio.js al final, cuando todos los archivos ya cargaron)
  --------------------------------------------------------------- */
  SA.arrancar = function () {
    construirBase();
    SA.iniciarReloj();
    var guardada = leerSesionGuardada();
    if (!guardada) { mostrarEntrada(); return; }
    ses = guardada;
    mostrarPantalla(envolverPantalla("Entrar", [h("p", { class: "sa-tenue", texto: "Recuperando tu sesión…" })]));
    var listo = ses.exp - Math.floor(Date.now() / 1000) > 30 ? Promise.resolve() : refrescar();
    Promise.resolve(listo).then(function () {
      if (!ses) return;
      if (ses.exp - Math.floor(Date.now() / 1000) <= 0) { sesionVencida("Tu sesión venció. Inicia sesión de nuevo."); return; }
      return continuarTrasClave();
    });
  };
})();
