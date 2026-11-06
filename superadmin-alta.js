/* =============================================================
   ASISTENTE DE ALTA DE UN RESTAURANTE  (superadmin.html, fase 3; docs seccion 24)

   Seis pasos: 1 datos, 2 plan, 3 dueno, 4 direccion web, 5 resumen y confirmacion, 6 entrega.
   Las validaciones son IGUALES O MAS ESTRICTAS que las del servidor (api/superadmin.js y SQL 16); el servidor vuelve a validar todo.
   Nada se crea hasta el paso 5. Al confirmar se llama, en orden: crear_restaurante -> crear_usuario (o asignar_miembro si el correo ya existe).
   Si algo falla a medias, el asistente recuerda lo ya hecho y el boton reintenta SOLO lo que falta (nunca crea dos restaurantes).

   PRECIOS: son una REFERENCIA INFORMATIVA de lo que cobra Carlos (texto en pantalla). El servidor no los usa ni los guarda.
============================================================= */
(function () {
  "use strict";
  var SA = window.SA, h = SA.h, t = SA.t;

  /* ---- REFERENCIA INFORMATIVA (no se guarda ni se envia; solo se muestra) ---- */
  var REFERENCIA = {
    basico: { nombre: "Básico", texto: "Menú con pedido a WhatsApp. Sin pasarela de pago, sin seguimiento y sin panel de comandas.", unico: 400000, mensual: 40000,
      modulos: { pasarela: false, seguimiento: false, comandas: false, impresion: false } },
    completo: { nombre: "Completo", texto: "Menú + pasarela de pago (Wompi) + seguimiento del pedido + panel de comandas.", unico: 2500000, mensual: 150000,
      modulos: { pasarela: true, seguimiento: true, comandas: true, impresion: true } },
    comandas: { nombre: "Solo comandas", texto: "Panel de comandas (con impresión). El menú es un extra: $200.000 pago único o $20.000 al mes.", unico: 800000, mensual: 100000,
      modulos: { pasarela: false, seguimiento: false, comandas: true, impresion: true } }
  };
  SA.REFERENCIA_PLANES = REFERENCIA;
  var NOMBRE_MODULO = { pasarela: "Pasarela de pago", seguimiento: "Seguimiento del pedido", comandas: "Panel de comandas", impresion: "Impresión de comandas" };
  SA.NOMBRE_MODULO = NOMBRE_MODULO;

  var RESERVADOS = ["api", "www", "admin", "superadmin", "app", "panel", "static", "assets", "mail", "soporte", "login", "dashboard", "cdn", "status"];
  var SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var CORREO = /^[^\s@<>"'`,;:()\[\]\\]+@[^\s@<>"'`,;:()\[\]\\]+\.[^\s@<>"'`,;:()\[\]\\]+$/;
  var ZONA = /^([A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}|UTC)$/;
  var HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
  function RARO_TEST(s) {
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c === 60 || c === 62 || SA.esInvisible(c)) return true; }
    return false;
  }
  var RARO = { test: RARO_TEST };
  SA.validar = { slug: SLUG, correo: CORREO, zona: ZONA, host: HOST, raro: RARO, reservados: RESERVADOS };

  function sugerirSlug(nombre) {
    var s = String(nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s.slice(0, 40).replace(/-+$/g, "");
  }
  SA.sugerirSlug = sugerirSlug;

  var PASOS = ["Datos", "Plan", "Dueño", "Dirección web", "Confirmar", "Entrega"];

  SA.vistas.alta = function (cont, params, n) {
    var est = {
      paso: 1, nombre: "", slug: "", slugTocado: false, prueba: false, prefijo: "prueba-",
      plan: "completo", modalidad: "mensual", dias: 14, gracia: 5, zona: "America/Bogota", modulos: Object.assign({}, REFERENCIA.completo.modulos),
      correo: "", usuario: undefined,           // undefined = sin comprobar; null = no existe; {id,email} = existe
      dominioModo: "ninguno", dominioBase: "", host: "", entiendo: false,
      /* restaurante: lo que el SERVIDOR devolvio al crearlo (nombre, slug, dominios...). usuarioConfirmado: el correo que el servidor confirmo.
         El mensaje de WhatsApp y el resumen final se arman SOLO con esos dos (R7), nunca con lo que quedo escrito en los pasos. */
      restaurante: null, usuarioCreado: false, usuarioConfirmado: null, dominioPuesto: false, clave: null, vigia: null, motivoBorrado: "", liberarVista: null, aviso: null
    };
    var cuerpo = h("div");
    var area = h("div");
    cont.appendChild(h("div", { class: "sa-cabecera-vista" }, h("h1", { texto: "Nuevo restaurante" })));
    cont.appendChild(cuerpo);

    function limpiarClave() {
      est.clave = null;
      if (est.vigia) { est.vigia.cancelar(); est.vigia = null; }
    }
    SA.alSalirDeVista(function () { limpiarClave(); if (est.liberarVista) { est.liberarVista(); est.liberarVista = null; } cuerpo.replaceChildren(); });

    function slugFinal() {
      var s = est.slug.trim();
      if (est.prueba && s.indexOf(est.prefijo) !== 0) s = est.prefijo + s;
      return s;
    }
    function hostFinal() {
      if (est.dominioModo === "propio") return est.host.trim().toLowerCase();
      if (est.dominioModo === "subdominio" && est.dominioBase.trim()) return slugFinal() + "." + est.dominioBase.trim().toLowerCase();
      return "";
    }

    /* Con el restaurante YA creado (y el usuario pendiente) los pasos se pueden VER, no cambiar: son botones que abren la vista de solo lectura. */
    function encabezadoPasos() {
      var puedeVer = !!est.restaurante && !est.usuarioCreado && est.paso !== 6;
      return h("ol", { class: "sa-pasos", "aria-label": "Pasos" }, PASOS.map(function (nom, i) {
        var n = i + 1, etiqueta = n + ". " + nom;
        var contenidoLi = etiqueta;
        if (puedeVer && n !== est.paso && n < 6) {
          contenidoLi = h("button", { type: "button", class: "sa-paso-ver", "data-paso": String(n), "aria-label": "Ver el paso " + etiqueta + (n === 3 || n === 5 ? "" : " (solo lectura: ya se creó)"), texto: etiqueta });
          contenidoLi.addEventListener("click", function () { est.paso = n; pintar(); });
        }
        return h("li", { "aria-current": est.paso === n ? "step" : null, class: est.paso > n ? "sa-hecho" : null }, contenidoLi);
      }));
    }
    function campo(id, etiqueta, input, ayuda) {
      return h("div", { class: "sa-campo" }, h("label", { for: id, texto: etiqueta }), input, ayuda ? h("p", { class: "sa-ayuda", id: id + "-ayuda", texto: ayuda }) : null);
    }
    function botonesNav(atras, siguiente, textoSig) {
      var a = h("button", { type: "button", class: "sa-btn", texto: "Atrás" });
      a.addEventListener("click", function () { est.paso--; pintar(); });
      var s = h("button", { type: "submit", class: "sa-btn sa-btn-primario", texto: textoSig || "Siguiente" });
      return h("div", { class: "sa-acciones" }, atras ? a : null, s);
    }
    function conFormulario(paso, hijos, validar, destino) {
      var msj = h("div", { role: "alert" });
      var form = h("form", { novalidate: true }, hijos, msj);
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var btn = form.querySelector("button[type=submit]");
        SA.enviar(btn, msj, function () {
          return Promise.resolve(validar()).then(function (error) {
            if (error) { msj.replaceChildren(h("div", { class: "sa-msj sa-msj-error", texto: error })); return; }
            est.paso = destino || paso + 1; pintar();
          });
        });
      });
      return form;
    }

    /* ---------------- pasos ya ejecutados: SOLO LECTURA, con lo que el servidor confirmo (R7) ---------------- */
    function lineasConfirmadas(paso) {
      var r = est.restaurante || {};
      var plan = SA.etiquetas.plan[r.plan] || t(r.plan, 20), modalidad = SA.etiquetas.modalidad[r.modalidad_pago] || t(r.modalidad_pago, 20);
      var mods = r.modulos && typeof r.modulos === "object" ? Object.keys(NOMBRE_MODULO).filter(function (k) { return r.modulos[k] === true; }).map(function (k) { return NOMBRE_MODULO[k]; }).join(", ") : "";
      var doms = Array.isArray(r.dominios) ? r.dominios.map(function (d) { return t(d, 120); }).join(", ") : "";
      if (paso === 1) return [["Nombre", r.nombre], ["Nombre corto", r.slug]];
      if (paso === 2) return [["Plan", plan], ["Modalidad", modalidad], ["Módulos", mods || "Ninguno"], ["Vigente hasta", r.vigente_hasta ? SA.fecha.corta(r.vigente_hasta) : "Sin vencimiento"], ["Días de gracia", String(r.dias_gracia)], ["Zona horaria", r.zona_horaria]];
      if (paso === 3) return [["Dueño", est.usuarioConfirmado ? est.usuarioConfirmado.email : est.correo]];
      return [["Dirección web registrada", doms || "Ninguna por ahora"]];
    }
    function pasoBloqueado(paso) {
      var volver = h("button", { type: "button", class: "sa-btn", id: "al-volver-resumen", texto: est.usuarioCreado ? "Volver a la entrega" : "Volver al resumen" });
      volver.addEventListener("click", function () { est.paso = est.usuarioCreado ? 6 : 5; pintar(); });
      return h("div", { "data-bloqueado": String(paso) },
        h("div", { class: "sa-msj sa-msj-aviso", role: "status", texto: "Este paso ya se ejecutó en el servidor: “" + t(est.restaurante.nombre, 80) + "” ya está creado, así que aquí no se puede cambiar nada. Lo que ves es lo que el servidor confirmó." }),
        h("dl", { class: "sa-datos sa-tarjeta" }, lineasConfirmadas(paso).map(function (x) { return h("div", null, h("dt", { texto: x[0] }), h("dd", { texto: t(x[1], 300) })); })),
        h("div", { class: "sa-acciones" }, volver));
    }

    /* ---------------- paso 1 ---------------- */
    function paso1() {
      var nombre = h("input", { id: "al-nombre", type: "text", maxlength: 120, value: est.nombre, autocomplete: "off" });
      var slug = h("input", { id: "al-slug", type: "text", maxlength: 40, value: est.slug, autocomplete: "off", autocapitalize: "off", spellcheck: "false", class: "sa-mono" });
      var prueba = h("input", { id: "al-prueba", type: "checkbox", checked: est.prueba ? true : null });
      var prefijo = h("input", { id: "al-prefijo", type: "text", maxlength: 12, value: est.prefijo, class: "sa-mono", autocomplete: "off" });
      var vista = h("p", { class: "sa-ayuda", id: "al-slug-final" });
      function actualizarVista() {
        est.nombre = nombre.value; est.slug = slug.value; est.prueba = prueba.checked; est.prefijo = prefijo.value;
        prefijo.disabled = !prueba.checked;
        vista.textContent = est.slug.trim() ? "Quedará así: " + slugFinal() : "";
      }
      nombre.addEventListener("input", function () {
        if (!est.slugTocado) slug.value = sugerirSlug(nombre.value);
        actualizarVista();
      });
      slug.addEventListener("input", function () { est.slugTocado = true; slug.value = slug.value.toLowerCase(); actualizarVista(); });
      prueba.addEventListener("change", actualizarVista);
      prefijo.addEventListener("input", actualizarVista);
      actualizarVista();
      var form = conFormulario(1, [
        campo("al-nombre", "Nombre del restaurante", nombre, "Como lo ven sus clientes. Máximo 120 caracteres, sin < ni >."),
        campo("al-slug", "Nombre corto (va en la dirección web)", slug, "Solo minúsculas, números y guiones (por ejemplo: los-taqueiros). De 2 a 40 caracteres."),
        h("div", { class: "sa-msj sa-msj-aviso", texto: "Ojo: el nombre corto NO se podrá cambiar después sin trabajo técnico. Revísalo bien." }),
        vista,
        h("div", { class: "sa-fila-check" }, prueba, h("label", { for: "al-prueba", texto: "Es un restaurante de prueba (le pongo un prefijo para encontrarlo y borrarlo luego)" })),
        campo("al-prefijo", "Prefijo de los restaurantes de prueba", prefijo, "Termina en guion. Por ejemplo: prueba-"),
        botonesNav(false)
      ], function () {
        actualizarVista();
        var nom = est.nombre.trim();
        if (!nom) return "Escribe el nombre del restaurante.";
        if (nom.length > 120) return "El nombre es demasiado largo (máximo 120 caracteres).";
        if (RARO.test(nom)) return "El nombre no puede llevar < ni >, ni caracteres de control o invisibles.";
        est.nombre = nom;
        if (est.prueba && !/^[a-z0-9]+(-[a-z0-9]+)*-$/.test(est.prefijo)) return "El prefijo de prueba debe ser minúsculas, números y guiones, y terminar en guion (por ejemplo: prueba-).";
        var s = slugFinal();
        if (!SLUG.test(s) || s.length < 2 || s.length > 40) return "El nombre corto debe tener de 2 a 40 caracteres: minúsculas, números y guiones, sin empezar ni terminar en guion" + (est.prueba ? " (contando el prefijo)." : ".");
        if (RESERVADOS.indexOf(s) >= 0) return "Ese nombre corto está reservado por el sistema. Elige otro.";
        return null;
      });
      return form;
    }

    /* ---------------- paso 2 ---------------- */
    function paso2() {
      var opcionesPlan = h("div", { class: "sa-opciones", role: "radiogroup", "aria-label": "Plan" });
      var detalleMod = h("div");
      function pintarModulos() {
        detalleMod.replaceChildren(h("h3", { texto: "Qué incluye" }), h("div", { class: "sa-rejilla-chica" }, Object.keys(NOMBRE_MODULO).map(function (k) {
          var chk = h("input", { type: "checkbox", id: "al-mod-" + k, checked: est.modulos[k] ? true : null });
          chk.addEventListener("change", function () { est.modulos[k] = chk.checked; });
          return h("div", { class: "sa-fila-check" }, chk, h("label", { for: "al-mod-" + k, texto: NOMBRE_MODULO[k] }));
        })), h("p", { class: "sa-ayuda", texto: "Hoy el sistema aplica de verdad la pasarela y el seguimiento; el panel de comandas y la impresión quedan anotados para el plan. Puedes ajustarlos." }));
      }
      Object.keys(REFERENCIA).forEach(function (k) {
        var r = REFERENCIA[k];
        var radio = h("input", { type: "radio", name: "al-plan", id: "al-plan-" + k, value: k, checked: est.plan === k ? true : null });
        radio.addEventListener("change", function () { est.plan = k; est.modulos = Object.assign({}, r.modulos); pintarModulos(); });
        opcionesPlan.appendChild(h("label", { class: "sa-opcion", for: "al-plan-" + k },
          h("div", { class: "sa-fila-check" }, radio, h("strong", { texto: r.nombre })),
          h("span", { texto: r.texto }),
          h("span", { class: "sa-ayuda", texto: "Referencia: " + SA.pesos(r.unico) + " pago único · " + SA.pesos(r.mensual) + " al mes" })));
      });
      var modal = h("div", { class: "sa-opciones", role: "radiogroup", "aria-label": "Modalidad de pago" });
      [["mensual", "Mensual", "Paga cada mes. Se registra cada pago y la vigencia se extiende."], ["unico", "Pago único", "Paga una vez. Después del pago se le quita el vencimiento (en el detalle del restaurante)."]].forEach(function (p) {
        var radio = h("input", { type: "radio", name: "al-modalidad", id: "al-mod-" + p[0], value: p[0], checked: est.modalidad === p[0] ? true : null });
        radio.addEventListener("change", function () { est.modalidad = p[0]; });
        modal.appendChild(h("label", { class: "sa-opcion", for: "al-mod-" + p[0] }, h("div", { class: "sa-fila-check" }, radio, h("strong", { texto: p[1] })), h("span", { texto: p[2] })));
      });
      var dias = h("input", { id: "al-dias", type: "number", min: 0, max: 90, step: 1, value: est.dias, inputmode: "numeric" });
      var gracia = h("input", { id: "al-gracia", type: "number", min: 0, max: 60, step: 1, value: est.gracia, inputmode: "numeric" });
      var zona = h("input", { id: "al-zona", type: "text", value: est.zona, maxlength: 64, class: "sa-mono", autocomplete: "off" });
      pintarModulos();
      return conFormulario(2, [
        h("h3", { texto: "Plan" }), opcionesPlan, detalleMod,
        h("div", { class: "sa-msj sa-msj-info", texto: "Los precios son una referencia para ti (no se guardan ni se cobran desde aquí)." }),
        h("h3", { texto: "Modalidad de pago" }), modal,
        h("div", { class: "sa-rejilla" },
          campo("al-dias", "Días de prueba", dias, "Empieza en estado “prueba”. Por defecto 14 días (de 0 a 90)."),
          campo("al-gracia", "Días de gracia", gracia, "Después de vencer, sigue funcionando este tiempo antes de suspenderse (0 a 60)."),
          campo("al-zona", "Zona horaria", zona, "Por defecto America/Bogota.")),
        botonesNav(true)
      ], function () {
        var d = Number(dias.value), g = Number(gracia.value);
        if (dias.value === "" || !Number.isInteger(d) || d < 0 || d > 90) return "Los días de prueba son un número entero de 0 a 90.";
        if (gracia.value === "" || !Number.isInteger(g) || g < 0 || g > 60) return "Los días de gracia son un número entero de 0 a 60.";
        if (!ZONA.test(zona.value.trim()) || zona.value.trim().length > 64) return "La zona horaria no parece válida (ejemplo: America/Bogota).";
        est.dias = d; est.gracia = g; est.zona = zona.value.trim();
        return null;
      });
    }

    /* ---------------- paso 3 ---------------- */
    function paso3() {
      var correo = h("input", { id: "al-correo", type: "email", value: est.correo, maxlength: 254, autocomplete: "off", inputmode: "email", autocapitalize: "off", spellcheck: "false" });
      var res = h("div", { id: "al-correo-res", "aria-live": "polite" });
      function pintarRes() {
        if (est.usuario === undefined) { res.replaceChildren(); return; }
        res.replaceChildren(est.usuario === null
          ? h("div", { class: "sa-msj sa-msj-info", texto: "Ese correo todavía no tiene usuario. Se creará con una contraseña temporal que verás UNA sola vez al terminar." })
          : h("div", { class: "sa-msj sa-msj-aviso", texto: "Ese correo ya tiene usuario. No se crea otro ni se toca su contraseña: solo se le da acceso a este restaurante como dueño." }));
      }
      correo.addEventListener("input", function () { est.usuario = undefined; pintarRes(); });
      pintarRes();
      var comprobar = h("button", { type: "button", class: "sa-btn", texto: "Comprobar si ya existe" });
      var areaC = h("div");
      function consultar() {
        var c = correo.value.trim().toLowerCase();
        if (!CORREO.test(c) || c.length > 254) return Promise.reject(new Error("El correo no es válido."));
        return SA.api("buscar_usuario", { email: c }).then(function (r) {
          if (!SA.vigente(n)) return;
          if (correo.value.trim().toLowerCase() !== c) return;   // respuesta vieja: el correo cambio mientras se comprobaba (24.13 R2)
          est.correo = c; est.usuario = r.usuario ? { id: r.usuario.id, email: r.usuario.email } : null; est.usuarioDe = c; pintarRes();
        });
      }
      comprobar.addEventListener("click", function () { SA.enviar(comprobar, areaC, consultar); });
      var recuperando = !!est.restaurante && !est.usuarioCreado;   // el restaurante ya existe y solo falta su dueño: este es el UNICO paso que aun se puede corregir
      return conFormulario(3, [
        recuperando ? h("div", { class: "sa-msj sa-msj-aviso", role: "status", texto: "“" + t(est.restaurante.nombre, 80) + "” ya está creado; solo falta el usuario del dueño. Aquí puedes corregir su correo." }) : null,
        h("p", { texto: "El dueño es quien entra al panel del restaurante a cargar su menú. Escribe su correo." }),
        campo("al-correo", "Correo del dueño", correo, "A este correo se le crea el usuario (no se le envía nada: tú le entregas los datos)."),
        h("p", null, comprobar), areaC, res,
        botonesNav(!recuperando, null, recuperando ? "Guardar y volver al resumen" : null)
      ], function () {
        var c = correo.value.trim().toLowerCase();
        if (!CORREO.test(c) || c.length > 254) return "El correo no es válido.";
        est.correo = c;
        if (est.usuario !== undefined && est.usuarioDe === c) return null;   // la comprobacion es de ESTE correo
        est.usuario = undefined;
        return consultar().then(function () {
          return est.usuario !== undefined && est.usuarioDe === c ? null : "El correo cambió mientras se comprobaba. Pulsa Siguiente otra vez.";
        }, function (e) { return e.message; });
      }, recuperando ? 5 : undefined);
    }

    /* ---------------- paso 4 ---------------- */
    function paso4() {
      var modos = h("div", { class: "sa-opciones", role: "radiogroup", "aria-label": "Dirección web" });
      var extra = h("div");
      var base = h("input", { id: "al-base", type: "text", value: est.dominioBase, maxlength: 200, class: "sa-mono", placeholder: "tudominio.com", autocomplete: "off", autocapitalize: "off" });
      var host = h("input", { id: "al-host", type: "text", value: est.host, maxlength: 253, class: "sa-mono", placeholder: "pedidos.mirestaurante.com", autocomplete: "off", autocapitalize: "off" });
      var vistaSub = h("p", { class: "sa-clave-valor", id: "al-sub-vista" });
      function pintarExtra() {
        extra.replaceChildren();
        if (est.dominioModo === "subdominio") {
          var actualizar = function () { est.dominioBase = base.value; vistaSub.textContent = base.value.trim() ? slugFinal() + "." + base.value.trim().toLowerCase() : "—"; };
          base.addEventListener("input", actualizar); actualizar();
          extra.appendChild(h("div", { class: "sa-tarjeta" },
            campo("al-base", "Tu dominio base (el que ya tienes en Vercel)", base, "Solo para mostrarte la dirección que le tocará; no se guarda."), vistaSub,
            h("div", { class: "sa-msj sa-msj-aviso" },
              h("strong", { texto: "Qué tiene que estar listo fuera de esta pantalla (en Vercel y en tu DNS): " }),
              "1) en tu proveedor de dominio, un registro comodín (*.tudominio.com) que apunte a Vercel; 2) en Vercel → Project → Settings → Domains, agregar *.tudominio.com; 3) en Vercel → Settings → Environment Variables, la variable DOMINIO_BASE = tudominio.com (solo Production) y volver a desplegar. Mientras eso no esté, la dirección NO responde. Hoy esa variable está vacía."),
            h("p", { class: "sa-ayuda", texto: "Cómo comprobarlo: abre https://" + "[nombre-corto].tudominio.com en el navegador; si ves el menú del restaurante, ya funciona. Si dice “Sitio no disponible”, falta algo de lo anterior." })));
        } else if (est.dominioModo === "propio") {
          extra.appendChild(h("div", { class: "sa-tarjeta" },
            campo("al-host", "Dirección del restaurante", host, "Sin https:// ni barras. Ejemplo: pedidos.mirestaurante.com"),
            h("div", { class: "sa-msj sa-msj-aviso" },
              h("strong", { texto: "Qué tienes que hacer fuera de esta pantalla: " }),
              "1) en Vercel → Project → Settings → Domains, agregar esa dirección; 2) en el DNS del dominio crear el registro que Vercel te muestre (te dice exactamente cuál); 3) esperar a que Vercel marque el dominio como válido (puede tardar unos minutos)."),
            h("p", { class: "sa-ayuda", texto: "Cómo comprobarlo: abre la dirección en el navegador. Si ves el menú del restaurante, ya funciona. El restaurante se reconoce por este dominio que se registra aquí al crearlo." })));
        } else {
          extra.appendChild(h("p", { class: "sa-ayuda", texto: "Podrás agregar un dominio después, en la pestaña Dominios del restaurante. Mientras tanto no tendrá dirección propia." }));
        }
      }
      [["propio", "Dominio propio", "Una dirección que ya compraste, por ejemplo pedidos.mirestaurante.com."], ["subdominio", "Subdominio automático", "nombre-corto.tudominio.com, bajo tu dominio base (necesita DOMINIO_BASE en Vercel)."], ["ninguno", "Decidirlo después", "Se crea sin dirección y la agregas cuando quieras."]].forEach(function (p) {
        var radio = h("input", { type: "radio", name: "al-dom", id: "al-dom-" + p[0], value: p[0], checked: est.dominioModo === p[0] ? true : null });
        radio.addEventListener("change", function () { est.dominioModo = p[0]; pintarExtra(); });
        modos.appendChild(h("label", { class: "sa-opcion", for: "al-dom-" + p[0] }, h("div", { class: "sa-fila-check" }, radio, h("strong", { texto: p[1] })), h("span", { texto: p[2] })));
      });
      pintarExtra();
      return conFormulario(4, [modos, extra, botonesNav(true)], function () {
        if (est.dominioModo === "propio") {
          var hh = host.value.trim().toLowerCase();
          if (!HOST.test(hh)) return "La dirección no es válida. Escríbela sin https:// ni barras (ejemplo: pedidos.mirestaurante.com).";
          est.host = hh;
        }
        if (est.dominioModo === "subdominio") {
          var b = base.value.trim().toLowerCase();
          if (!HOST.test(b)) return "Escribe tu dominio base (ejemplo: tudominio.com).";
          est.dominioBase = b;
        }
        return null;
      });
    }

    /* ---------------- paso 5 ---------------- */
    function paso5() {
      var recuperando = !!est.restaurante;   // el restaurante YA existe en el servidor: solo falta el usuario del dueno
      var ref = REFERENCIA[est.plan];
      var chk = h("input", { id: "al-entiendo", type: "checkbox", checked: est.entiendo ? true : null });
      chk.addEventListener("change", function () { est.entiendo = chk.checked; crear.disabled = !chk.checked; });
      var crear = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "al-crear", texto: recuperando ? "Reintentar crear el usuario" : "Crear restaurante", disabled: recuperando ? null : !est.entiendo });
      var msj = h("div", { role: "alert" });
      if (est.aviso) { msj.appendChild(h("div", { class: "sa-msj sa-msj-error", texto: est.aviso })); est.aviso = null; }
      var atras = recuperando
        ? h("button", { type: "button", class: "sa-btn", id: "al-cambiar-correo", texto: "Cambiar el correo del dueño" })
        : h("button", { type: "button", class: "sa-btn", id: "al-atras", texto: "Atrás" });
      atras.addEventListener("click", function () { est.paso = recuperando ? 3 : 4; pintar(); });
      var host = hostFinal();
      var vence = SA.fecha.sumarDias(SA.fecha.hoy(), est.dias);
      crear.addEventListener("click", function () { SA.enviar(crear, msj, ejecutar); });
      if (recuperando) {
        return h("div", null,
          h("div", { class: "sa-msj sa-msj-aviso", role: "status", texto: "El restaurante YA está creado en el servidor y no se puede cambiar desde este asistente. Falta crear el usuario del dueño." }),
          h("dl", { class: "sa-datos sa-tarjeta", "data-confirmado": "1" }, lineasConfirmadas(1).concat(lineasConfirmadas(2), lineasConfirmadas(4)).map(function (x) { return dato(x[0], x[1]); })),
          h("dl", { class: "sa-datos sa-tarjeta" }, dato("Dueño (falta crear)", est.correo + (est.usuario ? " (ya tiene usuario: solo se le dará acceso)" : " (usuario nuevo)"))),
          msj, h("div", { class: "sa-acciones" }, atras, crear));
      }
      return h("div", null,
        h("dl", { class: "sa-datos sa-tarjeta" },
          dato("Nombre", est.nombre), dato("Nombre corto", slugFinal()), dato("Plan", ref.nombre + " (referencia " + SA.pesos(est.modalidad === "unico" ? ref.unico : ref.mensual) + (est.modalidad === "unico" ? " pago único)" : " al mes)")),
          dato("Modalidad", SA.etiquetas.modalidad[est.modalidad]),
          dato("Módulos", Object.keys(NOMBRE_MODULO).filter(function (k) { return est.modulos[k]; }).map(function (k) { return NOMBRE_MODULO[k]; }).join(", ") || "Ninguno"),
          dato("Prueba hasta", SA.fecha.corta(vence) + " (" + est.dias + " días)"), dato("Días de gracia", String(est.gracia)), dato("Zona horaria", est.zona),
          dato("Dueño", est.correo + (est.usuario ? " (ya tiene usuario)" : " (usuario nuevo)")),
          dato("Dirección web", host || "Sin dirección por ahora")),
        h("div", { class: "sa-fila-check" }, chk, h("label", { for: "al-entiendo", texto: "Entiendo que el nombre corto “" + slugFinal() + "” no se podrá cambiar después." })),
        msj, h("div", { class: "sa-acciones" }, atras, crear));

      function ejecutar() {
        if (est.enviando) return Promise.resolve();
        est.enviando = true;
        return paso().then(function () { est.enviando = false; }, function (e) { est.enviando = false; throw e; });
      }
      function paso() {
        var cadena = Promise.resolve();
        if (!est.restaurante) {
          cadena = cadena.then(function () {
            var datos = { slug: slugFinal(), nombre: est.nombre, plan: est.plan, modalidad_pago: est.modalidad, dias_gracia: est.gracia, modulos: est.modulos, zona_horaria: est.zona, vigente_hasta: vence };
            if (est.dominioModo === "propio") datos.dominio = est.host;
            return SA.api("crear_restaurante", datos).then(function (r) {
              est.restaurante = r.restaurante; SA.lista = null;
              est.liberarVista = SA.retenerVista();   // R6: si hay que volver a pedir el codigo, esta vista (con lo ya creado) no se rearma
            });
          }).catch(function (e) { if (e && e.silencioso) throw e; throw new Error(traducirAlta(e)); });
        }
        cadena = cadena.then(function () {
          if (est.usuarioCreado) return;
          if (est.usuario && est.usuarioDe !== est.correo) throw errorDeCorreo("El correo del dueño cambió después de comprobarlo. Pulsa “Cambiar el correo del dueño” y compruébalo de nuevo.");
          if (est.usuario) {
            return SA.api("asignar_miembro", { restaurante_id: est.restaurante.id, usuario_id: est.usuario.id, rol: "dueno" }).then(function (r) {
              est.usuarioCreado = true;
              est.usuarioConfirmado = { email: (r && r.miembro && typeof r.miembro.email === "string" && r.miembro.email) || est.usuario.email };   // lo que el servidor confirmo
            });
          }
          return SA.api("crear_usuario", { email: est.correo, restaurante_id: est.restaurante.id, rol: "dueno" }).then(function (r) {
            est.usuarioCreado = true;
            est.usuarioConfirmado = { email: (r && r.usuario && typeof r.usuario.email === "string" && r.usuario.email) || est.correo };
            if (typeof r.password_temporal === "string") est.clave = r.password_temporal;
          });
        }).catch(function (e) {
          if (!est.restaurante) throw e;
          /* El restaurante YA existe y el usuario no (R7): se vuelve a pintar el paso 5 en su modo "falta el usuario" (pasos ya ejecutados en
             solo lectura, boton "Reintentar crear el usuario"), con el motivo a la vista. Nunca se crea otro restaurante. */
          est.paso = 5;
          if (e && e.silencioso) { pintar(); throw e; }
          var motivo;
          if (e && e.deCorreo) motivo = "El restaurante YA se creó, pero falta el usuario del dueño. " + e.message;
          else if (e && e.status === 409) motivo = "El restaurante YA se creó, pero ese correo ya tenía usuario. Pulsa “Cambiar el correo del dueño”, comprueba el correo y confirma de nuevo: solo se le dará acceso.";
          else motivo = "El restaurante YA se creó, pero el usuario del dueño no: " + (e && e.message ? e.message.replace(/[.!?\s]*$/, "") : "no se pudo completar") + ". Pulsa “Reintentar crear el usuario” (no se crea otro restaurante).";
          est.aviso = t(motivo, 600);
          pintar();
          var visto = new Error(motivo); visto.silencioso = true;   // el motivo ya quedo a la vista en el paso 5 nuevo
          throw visto;
        });
        return cadena.then(function () {
          est.paso = 6; pintar();
        });
      }
      function dato(k, v) { return h("div", null, h("dt", { texto: k }), h("dd", { texto: t(v, 300) })); }
    }

    function errorDeCorreo(texto) { var e = new Error(texto); e.deCorreo = true; return e; }
    function traducirAlta(e) {
      if (e && e.silencioso) return e.message;
      if (e && e.status === 409) return "Ya existe un restaurante con ese nombre corto" + (est.dominioModo === "propio" ? " o ese dominio ya está en uso" : "") + ". Vuelve al paso 1 y cambia el nombre corto" + (est.dominioModo === "propio" ? ", o al paso 4 y usa otra dirección." : ".");
      if (e && e.status === 400) return "El servidor rechazó los datos: " + e.message;
      return e && e.message ? e.message : "No se pudo crear el restaurante.";
    }

    /* ---------------- paso 6 ---------------- */
    function paso6() {
      /* TODO sale de lo que el servidor confirmo haber creado (R7), no de lo que quedo escrito en los pasos. */
      var creado = est.restaurante || {};
      var nombreCreado = String(creado.nombre === undefined || creado.nombre === null ? est.nombre : creado.nombre);
      var correoCreado = est.usuarioConfirmado && est.usuarioConfirmado.email ? est.usuarioConfirmado.email : est.correo;
      var host = (Array.isArray(creado.dominios) && typeof creado.dominios[0] === "string" && creado.dominios[0]) ||
        (est.dominioModo === "subdominio" && est.dominioBase && creado.slug ? creado.slug + "." + est.dominioBase.trim().toLowerCase() : "");
      var restante = h("p", { class: "sa-vence", id: "al-clave-reloj" });
      var caja = h("div");
      var copiarMsj = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "al-copiar-msj", texto: "Copiar mensaje para WhatsApp" });
      copiarMsj.addEventListener("click", function () { SA.copiar(mensaje(), "Mensaje copiado"); });
      function mensaje() {
        var l = ["¡Hola! Ya quedó listo tu restaurante “" + nombreCreado + "” 🎉", ""];
        if (host) { l.push("Tu dirección: https://" + host); l.push("Panel para tu equipo: https://" + host + "/panel.html"); l.push("Menú y productos: https://" + host + "/menu-admin.html"); }
        else l.push("La dirección de tu restaurante te la confirmo en cuanto esté lista.");
        l.push("Usuario: " + correoCreado);
        if (est.clave) l.push("Contraseña temporal: " + est.clave);
        else l.push(est.usuario ? "Contraseña: la misma que ya usas." : "Contraseña temporal: te la envío por aparte.");
        l.push("", "Entra, cámbiala y empieza a cargar tu menú. Cualquier duda me escribes.");
        return l.join("\n");
      }
      function pintarClave() {
        if (!est.clave) {
          caja.replaceChildren(est.usuario
            ? h("div", { class: "sa-msj sa-msj-info", texto: "El dueño ya tenía usuario: entra con su contraseña de siempre." })
            : h("div", { class: "sa-msj sa-msj-aviso", texto: "La contraseña temporal ya se borró de la pantalla" + (est.motivoBorrado === "oculta" ? " porque la pestaña estuvo oculta más de un minuto" : est.motivoBorrado === "tiempo" ? " porque pasaron los 3 minutos" : "") + " y no se guarda en ningún lado. Si no alcanzaste a copiarla, crea un usuario nuevo desde la pestaña Usuarios del restaurante (con otro correo) o restablece la contraseña en Supabase." }));
          restante.textContent = "";
          return;
        }
        var copiarClave = h("button", { type: "button", class: "sa-btn", id: "al-copiar-clave", texto: "Copiar" });
        copiarClave.addEventListener("click", function () { SA.copiar(est.clave, "Contraseña copiada"); });
        var borrar = h("button", { type: "button", class: "sa-btn", id: "al-borrar-clave", texto: "Ya la copié, borrarla de la pantalla" });
        borrar.addEventListener("click", function () { limpiarClave(); pintarClave(); });
        caja.replaceChildren(h("div", { class: "sa-clave-caja", role: "group", "aria-label": "Contraseña temporal" },
          h("strong", { texto: "CONTRASEÑA TEMPORAL — se muestra una sola vez" }),
          h("div", { class: "sa-clave-valor", id: "al-clave", texto: est.clave }),
          h("p", { class: "sa-chico", texto: "No se vuelve a ver ni queda guardada en ningún sitio. Cópiala ahora y entrégala por un canal privado. Se borrará sola en unos minutos." }),
          h("div", { class: "sa-acciones" }, copiarClave, borrar),
          SA.avisoPortapapeles()));
      }
      /* R4: hora limite absoluta, revisada cada segundo y al volver a ver la pestana (no cuenta tics). R6: mientras vive, la vista no se rearma. */
      if (est.clave && !est.vigia) {
        est.vigia = SA.vigilarClave({
          segundos: 180,
          alTic: function (seg) { restante.textContent = "Se borra sola en " + Math.floor(seg / 60) + ":" + String(seg % 60).padStart(2, "0"); },
          alVencer: function (motivo) { est.vigia = null; est.clave = null; est.motivoBorrado = motivo; pintarClave(); }
        });
      }
      pintarClave();
      var verBtn = h("button", { type: "button", class: "sa-btn", texto: "Abrir el restaurante" });
      verBtn.addEventListener("click", function () { limpiarClave(); SA.ir("detalle", { id: est.restaurante.id }); });
      var otro = h("button", { type: "button", class: "sa-btn", texto: "Crear otro" });
      otro.addEventListener("click", function () { limpiarClave(); SA.ir("alta"); });
      return h("div", null,
        h("div", { class: "sa-msj sa-msj-ok", role: "status", texto: "Listo: “" + t(nombreCreado, 120) + "” quedó creado en estado de prueba." }),
        h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Qué se le entrega al restaurante" }),
          h("dl", { class: "sa-datos" },
            h("div", null, h("dt", { texto: "Dirección" }), h("dd", { texto: host ? "https://" + t(host, 253) : "Pendiente" })),
            h("div", null, h("dt", { texto: "Correo" }), h("dd", { texto: t(correoCreado, 254) }))),
          caja, restante,
          h("p", null, copiarMsj), SA.avisoPortapapeles()),
        host ? h("div", { class: "sa-msj sa-msj-aviso", texto: "Recuerda: la dirección solo funciona cuando el dominio esté configurado en Vercel (ver el paso 4). Después configura sus colores, tarifas y llaves de Wompi en el detalle del restaurante." })
             : h("div", { class: "sa-msj sa-msj-aviso", texto: "Falta darle una dirección: agrégala en la pestaña Dominios del restaurante." }),
        h("div", { class: "sa-acciones" }, verBtn, otro));
    }

    function pintar() {
      area = h("div");
      /* Un paso que ya se ejecuto en el servidor (R7) nunca vuelve a ser un formulario: se ve, pero en solo lectura. */
      var bloqueado = !!est.restaurante && (est.paso === 1 || est.paso === 2 || est.paso === 4 || (est.paso === 3 && est.usuarioCreado));
      var contenido = bloqueado ? pasoBloqueado(est.paso) : est.paso === 1 ? paso1() : est.paso === 2 ? paso2() : est.paso === 3 ? paso3() : est.paso === 4 ? paso4() : est.paso === 5 ? paso5() : paso6();
      cuerpo.replaceChildren(encabezadoPasos(), h("div", { class: "sa-tarjeta" }, contenido));
      var primero = cuerpo.querySelector("input:not([type=radio]):not([type=checkbox]), input[type=radio]:checked");
      if (primero && est.paso < 5) primero.focus();
    }
    pintar();
  };
})();
