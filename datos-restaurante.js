/* =============================================================
   "DATOS DE MI RESTAURANTE"  (formulario del dueno, en panel.html)

   El dueno edita el NOMBRE de su restaurante, los TEXTOS de su pagina publica y su CONTACTO.
   La marca (colores, logo, tipografias), la ubicacion, el domicilio, los modulos, el plan y la vigencia NO se
   editan aqui: son del administrador (la base tampoco se lo permite al dueno: SQL 13).

   COMO GUARDA (docs/multirestaurante.md, seccion 17)
     * Valida en el navegador con las MISMAS reglas que la base (public.config_restaurante_errores, SQL 13) y,
       antes de guardar, le pregunta a esa funcion de la base con la config candidata: asi el aviso es el de la base.
       Dice en espanol que campo falla y por que, y avisa de lo que se ajusta (por ejemplo, del WhatsApp se guardan
       solo los numeros).
     * Guarda con public.guardar_datos_restaurante (SQL 15), enviando SOLO los campos que cambiaron, cada uno con
       el valor que el usuario vio al abrir ("antes"). La base hace el merge dentro (no se pierde ninguna otra clave
       de la config) y compara cada campo: si otra persona lo cambio mientras tanto, NO guarda nada y devuelve los
       campos en conflicto (nunca se pisa una edicion ajena sin que el usuario lo vea).
     * Todo dato (de la base o escrito) entra a la pantalla con textContent / .value; nunca con innerHTML.

   Las funciones puras (reglas, normalizar, diferencias...) estan separadas de la pantalla y se pueden probar sin
   navegador: este archivo tambien se carga con require() en las pruebas.

   LA LISTA DE CAMPOS es la misma de guardar_datos_restaurante (supabase/15-datos-restaurante.sql): si se agrega un
   campo hay que agregarlo en los dos lugares (una prueba los compara).
============================================================= */
(function () {
  "use strict";

  var DR = {};

  /* ---------------------------------------------------------------
     LOS CAMPOS
       campo   nombre del campo en guardar_datos_restaurante ("textos.eslogan", "contacto.whatsapp", "nombre")
       max     largo maximo (el de la base, 16.4)
       tipo    texto | area | whatsapp | usuario
  --------------------------------------------------------------- */
  function t(campo, etiqueta, max, ayuda, extra) {
    var o = { campo: campo, etiqueta: etiqueta, max: max, ayuda: ayuda || "", tipo: "texto" };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  DR.GRUPOS = [
    { id: "restaurante", titulo: "Tu restaurante", campos: [
      t("nombre", "Nombre del restaurante", 120, "Sale en el título de la página, en el menú del panel, en el pie del ticket y en la vista previa del enlace.", { obligatorio: true })
    ] },
    { id: "contacto", titulo: "Contacto", campos: [
      t("contacto.whatsapp", "WhatsApp del restaurante", 25, "Con el indicativo del país y solo números (ej. 573001234567). Sin él no aparecen los botones de WhatsApp.", { tipo: "whatsapp", ejemplo: "573001234567" }),
      t("contacto.telefono", "Teléfono que se muestra", 40, "", { ejemplo: "+57 300 123 4567" }),
      t("contacto.direccion", "Dirección", 200, ""),
      t("contacto.direccion_corta", "Dirección corta (para recoger el pedido)", 200, "Sale en el seguimiento de los pedidos que se recogen en el local."),
      t("contacto.ciudad", "Ciudad", 80, "Se usa en el pago en línea."),
      t("contacto.region", "Departamento o región", 80, "Se usa en el pago en línea."),
      t("contacto.instagram", "Instagram", 60, "Solo el usuario, sin @.", { tipo: "usuario", ejemplo: "mirestaurante" }),
      t("contacto.tiktok", "TikTok", 60, "Solo el usuario, sin @.", { tipo: "usuario", ejemplo: "mirestaurante" })
    ] },
    { id: "textos", titulo: "Textos de tu página", campos: [
      t("textos.titulo_pagina", "Título de la página", 400, "Sale en la pestaña del navegador y en la vista previa cuando compartes el enlace."),
      t("textos.descripcion_pagina", "Descripción de la página", 400, "Sale en la vista previa cuando compartes el enlace (WhatsApp, Instagram...).", { tipo: "area" }),
      t("textos.eslogan", "Eslogan", 400, ""),
      t("textos.tagline", "Frase de la portada", 400, ""),
      t("textos.descripcion_pie", "Texto del pie de la página", 400, "", { tipo: "area" }),
      t("textos.servicios_linea", "Línea de servicios", 400, "Por ejemplo: Domicilio · Para llevar · Pago en línea."),
      t("textos.pie_final", "Cierre del pie de la página", 400, ""),
      t("textos.ejemplo_nota", "Ejemplo para las notas del pedido", 400, "Sale como ayuda en el cuadro de notas del pedido.")
    ] },
    { id: "banner", titulo: "Avisos de abierto y cerrado", campos: [
      t("textos.banner_abierto_icono", "Ícono del aviso de abierto", 400, "Un emoji."),
      t("textos.banner_abierto_titulo", "Título del aviso de abierto", 400, ""),
      t("textos.banner_abierto_texto", "Mensaje del aviso de abierto", 400, "Escribe {cierre} donde quieras que aparezca la hora de cierre de hoy.", { tipo: "area" }),
      t("textos.banner_cerrado_icono", "Ícono del aviso de cerrado", 400, "Un emoji."),
      t("textos.banner_cerrado_mensaje", "Mensaje del aviso de cerrado", 400, "Se muestra si no escribiste un mensaje propio en Horario.", { tipo: "area" })
    ] },
    { id: "seguimiento", titulo: "Seguimiento del pedido", campos: [
      t("textos.seguimiento.tiempo_nuevo", "Tiempo: pedido recibido", 200, "Lo que lee el cliente mientras espera."),
      t("textos.seguimiento.frase_nuevo", "Frase: pedido recibido", 200, ""),
      t("textos.seguimiento.tiempo_preparacion", "Tiempo: en preparación", 200, ""),
      t("textos.seguimiento.frase_preparacion", "Frase: en preparación", 200, ""),
      t("textos.seguimiento.tiempo_camino", "Tiempo: en camino", 200, ""),
      t("textos.seguimiento.frase_camino", "Frase: en camino", 200, ""),
      t("textos.seguimiento.tiempo_recoger", "Tiempo: listo para recoger", 200, ""),
      t("textos.seguimiento.frase_recoger", "Frase: listo para recoger", 200, ""),
      t("textos.seguimiento.tiempo_entregado", "Tiempo: entregado", 200, ""),
      t("textos.seguimiento.frase_entregado", "Frase: entregado", 200, "")
    ] }
  ];

  DR.CAMPOS = [];
  DR.GRUPOS.forEach(function (g) { g.campos.forEach(function (c) { DR.CAMPOS.push(c); }); });

  var POR_CAMPO = {};
  DR.CAMPOS.forEach(function (c) { POR_CAMPO[c.campo] = c; });
  DR.campo = function (nombre) { return Object.prototype.hasOwnProperty.call(POR_CAMPO, nombre) ? POR_CAMPO[nombre] : null; };

  /* ---------------------------------------------------------------
     CARACTERES (se arman desde codigos: ningun editor deja invisibles escritos en el archivo)
  --------------------------------------------------------------- */
  var BARRA = String.fromCharCode(92);
  function u(n) { return BARRA + "u" + ("0000" + n.toString(16)).slice(-4); }
  // controles, ancho cero y marcas de direccion (bidi): los mismos que rechaza la base
  var RANGOS_INVISIBLES = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
  var INVISIBLES = RANGOS_INVISIBLES.map(function (r) { return u(r[0]) + "-" + u(r[1]); }).join("");
  var RE_CONTROL = new RegExp("[" + BARRA + "x01-" + BARRA + "x1f" + BARRA + "x7f-" + BARRA + "x9f" + INVISIBLES + "]");
  var RE_CONTROL_G = new RegExp("[" + BARRA + "x00-" + BARRA + "x1f" + BARRA + "x7f-" + BARRA + "x9f" + INVISIBLES + "]", "g");
  var RE_SALTOS_G = new RegExp("[" + BARRA + "r" + BARRA + "n" + BARRA + "t]+", "g");
  var RE_ESPACIOS_G = new RegExp(BARRA + "s+", "g");
  var RE_SECRETO = /(prv_|(test|prod)_(integrity|events)_|sb_secret_|sb_publishable_|apikey|api_key|service_role|eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}|-----BEGIN)/i;
  var RE_CLAVE_LARGA = /^[A-Za-z0-9_-]{32,}$/;
  var RE_USUARIO = /^[A-Za-z0-9._]{1,60}$/;
  var RE_DIGITOS = /^[0-9]{8,15}$/;
  var RE_SEPARADORES_G = new RegExp("[" + BARRA + "s+()-]", "g");

  /* Largo en CARACTERES (puntos de codigo), como char_length de Postgres: un emoji cuenta uno, no dos. */
  function largo(texto) { return Array.from(texto).length; }
  DR.largo = largo;

  /* ---------------------------------------------------------------
     NORMALIZAR: lo que se guarda a partir de lo que se escribio, y los avisos de lo que se ajusto
       devuelve { valor: string, avisos: [texto] }   ("" = el campo queda vacio y se borra)
  --------------------------------------------------------------- */
  DR.normalizar = function (campo, crudo) {
    var def = DR.campo(campo);
    var avisos = [];
    var v = typeof crudo === "string" ? crudo : (crudo == null ? "" : String(crudo));
    if (!def) return { valor: v.trim(), avisos: avisos };

    var antes = v;
    if (RE_SALTOS_G.test(v)) {
      v = v.replace(RE_SALTOS_G, " ");
      avisos.push("los saltos de línea se cambiaron por espacios (este campo es de una sola línea)");
    }
    RE_SALTOS_G.lastIndex = 0;
    if (RE_CONTROL_G.test(v)) {
      v = v.replace(RE_CONTROL_G, "");
      avisos.push("se quitaron caracteres invisibles o de control");
    }
    RE_CONTROL_G.lastIndex = 0;
    v = v.replace(RE_ESPACIOS_G, " ").trim();

    if (def.tipo === "whatsapp") {
      var solo = v.replace(RE_SEPARADORES_G, "");
      if (solo !== v && /^[0-9]*$/.test(solo)) {
        if (solo) avisos.push("se guardarán solo los números: " + solo);
        v = solo;
      }
    } else if (def.tipo === "usuario") {
      if (v.charAt(0) === "@") {
        v = v.slice(1).trim();
        avisos.push("se quitó el @ del principio (solo va el usuario)");
      }
    }
    void antes;
    return { valor: v, avisos: avisos };
  };

  /* ---------------------------------------------------------------
     VALIDAR UN CAMPO (las reglas de la base, docs 16.4)  ->  lista de problemas en espanol
       'valor' ya normalizado
  --------------------------------------------------------------- */
  DR.validarCampo = function (campo, valor) {
    var def = DR.campo(campo);
    var e = [];
    if (!def) return ["Este campo no se puede editar aquí."];
    var v = typeof valor === "string" ? valor : "";

    if (campo === "nombre") {
      if (largo(v) < 1) e.push("El nombre no puede quedar vacío.");
      if (largo(v) > 120) e.push("Es demasiado largo (máximo 120 caracteres).");
      if (/[<>]/.test(v)) e.push("No se permiten los caracteres < y >.");
      if (RE_CONTROL.test(v)) e.push("No se permiten saltos de línea ni caracteres de control o invisibles.");
      return e;
    }
    if (v === "") return e;   // vacio = el campo se borra (es opcional)

    if (def.tipo === "whatsapp") {
      if (largo(v) > def.max || !RE_DIGITOS.test(v.replace(RE_SEPARADORES_G, ""))) {
        e.push("Número no válido: escribe de 8 a 15 dígitos (puedes usar espacios, +, paréntesis y guiones).");
      }
    } else if (def.tipo === "usuario") {
      if (!RE_USUARIO.test(v.charAt(0) === "@" ? v.slice(1) : v)) {
        e.push("Usuario no válido: solo letras, números, punto y guion bajo (hasta 60).");
      }
    }
    if (largo(v) > def.max) e.push("Es demasiado largo (máximo " + def.max + " caracteres).");
    if (/[<>]/.test(v)) e.push("No se permiten etiquetas HTML (los caracteres < y >).");
    if (RE_CONTROL.test(v)) e.push("No se permiten saltos de línea ni caracteres de control o invisibles.");
    if (RE_SECRETO.test(v)) e.push("Esto parece una llave o un secreto; aquí no se guardan secretos.");
    if (def.tipo === "texto" || def.tipo === "area") {
      if (RE_CLAVE_LARGA.test(v)) e.push("Parece una clave y no un texto.");
    }
    return e;
  };

  /* ---------------------------------------------------------------
     LEER Y ESCRIBIR UN CAMPO DENTRO DE LA CONFIG / EL NOMBRE
  --------------------------------------------------------------- */
  function rutaDe(campo) { return ["publico"].concat(campo.split(".")); }

  DR.leer = function (datos, campo) {
    if (campo === "nombre") return typeof datos.nombre === "string" ? datos.nombre : "";
    var cur = datos.config;
    var ruta = rutaDe(campo);
    for (var i = 0; i < ruta.length; i++) {
      if (cur == null || typeof cur !== "object") return "";
      cur = cur[ruta[i]];
    }
    return typeof cur === "string" ? cur : "";
  };

  /* La config que quedaria despues de aplicar 'valores' ({campo: texto}) SOBRE la config vigente: se cambian solo esos campos. */
  DR.candidato = function (config, valores) {
    var c = JSON.parse(JSON.stringify(config && typeof config === "object" ? config : {}));
    Object.keys(valores).forEach(function (campo) {
      if (campo === "nombre") return;
      var ruta = rutaDe(campo);
      var cur = c;
      for (var i = 0; i < ruta.length - 1; i++) {
        if (cur[ruta[i]] == null || typeof cur[ruta[i]] !== "object" || Array.isArray(cur[ruta[i]])) cur[ruta[i]] = {};
        cur = cur[ruta[i]];
      }
      var hoja = ruta[ruta.length - 1];
      if (valores[campo] === "") delete cur[hoja]; else cur[hoja] = valores[campo];
    });
    return c;
  };

  /* Lista de cambios para guardar_datos_restaurante: SOLO los campos cuyo valor normalizado difiere del original. */
  DR.diferencias = function (original, valores) {
    var cambios = [];
    DR.CAMPOS.forEach(function (def) {
      if (!Object.prototype.hasOwnProperty.call(valores, def.campo)) return;
      var antes = DR.leer(original, def.campo).trim();
      var despues = valores[def.campo];
      if (antes !== despues) {
        cambios.push({ campo: def.campo, antes: antes === "" ? null : antes, despues: despues === "" ? null : despues });
      }
    });
    return cambios;
  };

  /* ---------------------------------------------------------------
     LOS MENSAJES DE LA BASE  ->  campo + texto en espanol
       "publico.textos.eslogan: demasiado largo (maximo 400 caracteres)"
  --------------------------------------------------------------- */
  DR.interpretarErrorBase = function (texto) {
    var s = String(texto == null ? "" : texto);
    var m = /^([A-Za-z0-9_.]+): (.*)$/.exec(s);
    if (!m) return { campo: null, mensaje: s };
    var ruta = m[1].replace(/^publico[.]/, "");
    var def = DR.campo(ruta);
    return { campo: def ? def.campo : null, ruta: m[1], mensaje: m[2] };
  };

  /* ---------------------------------------------------------------
     LA PANTALLA
  --------------------------------------------------------------- */
  var estado = null;   // { db, rid, original, abierto, ... }

  function el(tag, atributos, hijos) {
    var e = document.createElement(tag);
    if (atributos) Object.keys(atributos).forEach(function (k) {
      if (k === "texto") e.textContent = atributos[k];
      else e.setAttribute(k, atributos[k]);
    });
    (hijos || []).forEach(function (h) { if (h) e.appendChild(h); });
    return e;
  }

  var TEXTOS_UI = {
    sinPermiso: "No tienes permiso para editar los datos de este restaurante.",
    sinFuncion: "Falta activar esta función en la base de datos (el SQL 15). Avísale a quien administra el sistema.",
    sinRed: "No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.",
    sinCambios: "No hay cambios para guardar.",
    guardado: "Datos guardados.",
    cargando: "Cargando los datos de tu restaurante…"
  };
  DR.TEXTOS_UI = TEXTOS_UI;

  function construirModal() {
    var fondo = document.getElementById("modalDatos");
    if (fondo) return fondo;

    fondo = el("div", { "class": "modal-fondo", id: "modalDatos" });
    var caja = el("div", { "class": "modal-horarios modal-datos", role: "dialog", "aria-modal": "true", "aria-labelledby": "datosTitulo", tabindex: "-1" });
    caja.appendChild(el("h2", { id: "datosTitulo", texto: "Datos de mi restaurante" }));
    caja.appendChild(el("p", { "class": "ayuda", texto: "Aquí editas el nombre, los textos de tu página y tu contacto. Los colores, el logo, la ubicación, el domicilio y el plan los cambia el administrador del sistema." }));
    caja.appendChild(el("div", { id: "datosAviso", "class": "datos-aviso", role: "status", "aria-live": "polite", hidden: "" }));
    caja.appendChild(el("div", { id: "datosCuerpo", "class": "datos-cuerpo" }));
    var acciones = el("div", { "class": "acciones-modal" }, [
      el("button", { "class": "btn-cancelar", id: "datosCancelar", type: "button", texto: "Cancelar" }),
      el("button", { "class": "btn-guardar", id: "datosGuardar", type: "button", texto: "Guardar" })
    ]);
    caja.appendChild(acciones);
    fondo.appendChild(caja);
    document.body.appendChild(fondo);

    fondo.addEventListener("click", function (ev) { if (ev.target === fondo) pedirCierre(); });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && fondo.classList.contains("open")) pedirCierre();
    });
    document.getElementById("datosCancelar").addEventListener("click", pedirCierre);
    document.getElementById("datosGuardar").addEventListener("click", guardar);
    return fondo;
  }

  function entradaDe(campo) { return document.querySelector('[data-datos-campo="' + campo + '"]'); }

  function pintarFormulario() {
    var cuerpo = document.getElementById("datosCuerpo");
    while (cuerpo.firstChild) cuerpo.removeChild(cuerpo.firstChild);

    DR.GRUPOS.forEach(function (g, gi) {
      var det = el("details", { "class": "datos-grupo", "data-datos-grupo": g.id });
      if (gi < 2) det.setAttribute("open", "");
      det.appendChild(el("summary", { texto: g.titulo }));
      g.campos.forEach(function (def) {
        var id = "datos_" + def.campo.replace(/[.]/g, "_");
        var fila = el("div", { "class": "datos-fila" });
        fila.appendChild(el("label", { "for": id, texto: def.etiqueta + (def.obligatorio ? " *" : "") }));
        var entrada = def.tipo === "area"
          ? el("textarea", { id: id, rows: "2", "data-datos-campo": def.campo, autocomplete: "off", spellcheck: "true" })
          : el("input", { id: id, type: def.tipo === "whatsapp" ? "tel" : "text", "data-datos-campo": def.campo, autocomplete: "off", spellcheck: def.tipo === "texto" ? "true" : "false" });
        if (def.ejemplo) entrada.setAttribute("placeholder", def.ejemplo);
        entrada.value = DR.leer(estado.original, def.campo);
        fila.appendChild(entrada);
        var pie = el("div", { "class": "datos-pie" });
        pie.appendChild(el("small", { "class": "datos-ayuda", texto: def.ayuda }));
        pie.appendChild(el("small", { "class": "datos-contador", "data-datos-contador": def.campo, texto: "" }));
        fila.appendChild(pie);
        fila.appendChild(el("div", { "class": "datos-error", id: id + "_error", "data-datos-error": def.campo, role: "alert", hidden: "" }));
        entrada.setAttribute("aria-describedby", id + "_error");
        det.appendChild(fila);
        entrada.addEventListener("input", function () { contar(def.campo); limpiarError(def.campo); estado.cierreConfirmado = false; restaurarBotonCancelar(); });
        contar(def.campo);
      });
      cuerpo.appendChild(det);
    });
    // los contadores se pintan cuando todos los campos ya estan en la pagina
    DR.CAMPOS.forEach(function (d) { contar(d.campo); });
  }

  function contar(campo) {
    var def = DR.campo(campo), e = entradaDe(campo), c = document.querySelector('[data-datos-contador="' + campo + '"]');
    if (!def || !e || !c) return;
    var n = largo(e.value);
    c.textContent = n + "/" + def.max;
    c.classList.toggle("excedido", n > def.max);
  }

  function ponerError(campo, mensajes) {
    var cont = document.querySelector('[data-datos-error="' + campo + '"]'), e = entradaDe(campo);
    if (!cont) return;
    cont.textContent = mensajes.join(" ");
    cont.hidden = false;
    if (e) e.setAttribute("aria-invalid", "true");
    var det = cont.closest("details");
    if (det) det.setAttribute("open", "");
  }

  function limpiarError(campo) {
    var cont = document.querySelector('[data-datos-error="' + campo + '"]'), e = entradaDe(campo);
    if (cont) { cont.textContent = ""; cont.hidden = true; }
    if (e) e.removeAttribute("aria-invalid");
  }

  function limpiarErrores() { DR.CAMPOS.forEach(function (d) { limpiarError(d.campo); }); }

  function aviso(titulo, lineas, clase) {
    var a = document.getElementById("datosAviso");
    while (a.firstChild) a.removeChild(a.firstChild);
    if (!titulo) { a.hidden = true; return; }
    a.className = "datos-aviso " + (clase || "");
    a.appendChild(el("strong", { texto: titulo }));
    if (lineas && lineas.length) {
      var ul = el("ul");
      lineas.forEach(function (l) { ul.appendChild(el("li", { texto: l })); });
      a.appendChild(ul);
    }
    a.hidden = false;
  }

  /* Lee y normaliza el formulario: { valores, tocados, avisos:[{campo, texto}] }.
     Solo cuenta lo que la persona TOCO: un campo que no cambio queda con su valor original (aunque esa copia tenga
     espacios de mas o algo que hoy no pasaria las reglas), asi no se reescribe ni se valida lo que nadie edito. */
  function leerFormulario() {
    var valores = {}, tocados = {}, avisos = [];
    DR.CAMPOS.forEach(function (def) {
      var e = entradaDe(def.campo);
      var crudo = e ? e.value : "";
      var original = DR.leer(estado.original, def.campo);
      if (crudo === original) {
        valores[def.campo] = original.trim();
        tocados[def.campo] = false;
        return;
      }
      tocados[def.campo] = true;
      var n = DR.normalizar(def.campo, crudo);
      valores[def.campo] = n.valor;
      n.avisos.forEach(function (a) { avisos.push({ campo: def.campo, texto: def.etiqueta + ": " + a }); });
    });
    return { valores: valores, tocados: tocados, avisos: avisos };
  }

  function hayCambios() {
    var f = leerFormulario();
    return DR.diferencias(estado.original, f.valores).length > 0;
  }

  function restaurarBotonCancelar() {
    var b = document.getElementById("datosCancelar");
    if (b) b.textContent = "Cancelar";
  }

  function pedirCierre() {
    if (!estado || estado.guardando) return;
    if (estado.original && hayCambios() && !estado.cierreConfirmado) {
      estado.cierreConfirmado = true;
      document.getElementById("datosCancelar").textContent = "Descartar los cambios";
      aviso("Tienes cambios sin guardar.", ["Pulsa «Descartar los cambios» para salir sin guardarlos, o «Guardar» para conservarlos."], "atencion");
      return;
    }
    cerrar();
  }

  function cerrar() {
    var m = document.getElementById("modalDatos");
    if (m) m.classList.remove("open");
    if (estado) { estado.abierto = false; estado.cierreConfirmado = false; }
    restaurarBotonCancelar();
  }
  DR.cerrar = cerrar;

  function aplicarDatosVigentes(datos) {
    // el estado vigente que devolvio la base (nombre, textos, contacto) pasa a ser la referencia ("antes") de la proxima edicion
    var cfg = JSON.parse(JSON.stringify(estado.original.config || {}));
    if (!cfg.publico || typeof cfg.publico !== "object") cfg.publico = {};
    cfg.publico.textos = datos.textos && typeof datos.textos === "object" ? datos.textos : {};
    cfg.publico.contacto = datos.contacto && typeof datos.contacto === "object" ? datos.contacto : {};
    estado.original = { nombre: typeof datos.nombre === "string" ? datos.nombre : estado.original.nombre, config: cfg };
  }

  function mensajeDeError(error) {
    var code = error && error.code, msg = String((error && error.message) || "");
    if (code === "PGRST202" || /Could not find the function|schema cache/i.test(msg)) return TEXTOS_UI.sinFuncion;
    if (code === "42501" || /permission denied|Solo el dueno|No tienes acceso/i.test(msg)) return TEXTOS_UI.sinPermiso;
    if (code === "23514") {
      var partes = msg.replace(/^[^:]*:\s*/, "").split(/;\s*/).map(DR.interpretarErrorBase);
      return partes.map(function (p) { var d = p.campo && DR.campo(p.campo); return (d ? d.etiqueta + ": " : "") + p.mensaje; }).join(" | ");
    }
    if (code === "22023") return "La base rechazó el pedido: " + msg;
    return TEXTOS_UI.sinRed;
  }

  async function guardar() {
    if (!estado || estado.guardando) return;
    if (window.PR && window.PR.rol !== "dueno") { aviso("Solo el dueño del restaurante puede editar estos datos.", [], "error"); return; }

    limpiarErrores();
    aviso(null);
    var f = leerFormulario();

    // 1) reglas locales (las mismas de la base)
    var hubo = false, primero = null;
    DR.CAMPOS.forEach(function (def) {
      if (!f.tocados[def.campo]) return;
      var errores = DR.validarCampo(def.campo, f.valores[def.campo]);
      if (errores.length) { ponerError(def.campo, errores); hubo = true; if (!primero) primero = def.campo; }
    });
    if (hubo) {
      aviso("Revisa los campos marcados.", ["Nada se guardó."], "error");
      var pe = entradaDe(primero); if (pe) pe.focus();
      return;
    }

    // 2) lo que se ajusto: se muestra y se pide confirmar (el usuario ve exactamente lo que se guardara)
    var cambios = DR.diferencias(estado.original, f.valores);
    var ajustes = f.avisos.filter(function (a) {
      var antes = (entradaDe(a.campo) || {}).value;
      return antes !== f.valores[a.campo];
    });
    if (ajustes.length && !estado.ajustesMostrados) {
      DR.CAMPOS.forEach(function (def) { var e = entradaDe(def.campo); if (e && f.tocados[def.campo] && e.value !== f.valores[def.campo]) { e.value = f.valores[def.campo]; contar(def.campo); } });
      estado.ajustesMostrados = true;
      aviso("Ajustamos estos datos para guardarlos bien.", ajustes.map(function (a) { return a.texto; }).concat(["Revisa y vuelve a pulsar Guardar."]), "atencion");
      return;
    }
    estado.ajustesMostrados = false;

    if (!cambios.length) { aviso(TEXTOS_UI.sinCambios, [], "atencion"); return; }

    estado.guardando = true;
    var boton = document.getElementById("datosGuardar");
    boton.disabled = true;
    try {
      // 3) la validacion de la base sobre la config candidata (la misma funcion que usa el trigger al guardar)
      var candidata = DR.candidato(estado.original.config, f.valores);
      var rv = await estado.db.rpc("config_restaurante_errores", { p_config: candidata });
      if (!rv.error && Array.isArray(rv.data) && rv.data.length) {
        var generales = [], marcados = false;
        rv.data.forEach(function (txt) {
          var i = DR.interpretarErrorBase(txt);
          if (i.campo && Object.prototype.hasOwnProperty.call(f.valores, i.campo) && cambios.some(function (c) { return c.campo === i.campo; })) {
            ponerError(i.campo, [i.mensaje.charAt(0).toUpperCase() + i.mensaje.slice(1) + "."]); marcados = true;
          } else {
            generales.push((i.ruta ? i.ruta + ": " : "") + i.mensaje);
          }
        });
        if (marcados) {
          aviso("La base no aceptó algunos datos.", ["Revisa los campos marcados. Nada se guardó."], "error");
          return;
        }
        if (generales.length) {
          aviso("La configuración de tu restaurante tiene un problema fuera de este formulario.", generales.slice(0, 4).concat(["Avísale a quien administra el sistema. Nada se guardó."]), "error");
          return;
        }
      }

      // 4) guardar SOLO lo que cambio
      var r = await estado.db.rpc("guardar_datos_restaurante", { p_restaurante: estado.rid, p_cambios: cambios });
      if (r.error) { aviso("No se pudo guardar.", [mensajeDeError(r.error)], "error"); return; }
      var res = r.data;
      if (!res || typeof res !== "object") { aviso("No se pudo guardar.", [TEXTOS_UI.sinRed], "error"); return; }

      if (res.ok === false) {
        // alguien cambio antes alguno de esos campos: se cargan sus valores y se pide revisar (nada se perdio ni se pisó)
        var lineas = [];
        (res.conflictos || []).forEach(function (c) {
          var def = DR.campo(c.campo);
          if (!def) return;
          lineas.push(def.etiqueta + ": ahora dice «" + (c.actual == null ? "(vacío)" : String(c.actual)) + "».");
          ponerError(c.campo, ["Otra persona cambió este dato mientras lo editabas. Ahora dice «" + (c.actual == null ? "(vacío)" : String(c.actual)) + "». Tu texto sigue aquí; si lo guardas, reemplaza ese."]);
        });
        if (res.datos) aplicarDatosVigentes(res.datos);
        // lo que yo no toque se actualiza con lo vigente (para no deshacer lo que otra persona cambio); lo mio queda como lo escribi
        DR.CAMPOS.forEach(function (def) {
          var e = entradaDe(def.campo);
          if (e && !f.tocados[def.campo]) { e.value = DR.leer(estado.original, def.campo); contar(def.campo); }
        });
        aviso("Otra persona editó estos datos mientras tú escribías.", lineas.concat(["No se guardó nada. Revisa los campos marcados y pulsa Guardar otra vez."]), "atencion");
        return;
      }

      aplicarDatosVigentes(res.datos || {});
      if (window.PR && window.PR.R && res.datos && typeof res.datos.nombre === "string") {
        window.PR.R.nombre = res.datos.nombre;
        window.PR.aplicarNombreYLogo(window.PR.R);
      }
      if (typeof estado.alGuardar === "function") estado.alGuardar(res.datos || {});
      if (typeof estado.avisar === "function") estado.avisar(TEXTOS_UI.guardado);
      cerrar();
    } catch (e) {
      aviso("No se pudo guardar.", [TEXTOS_UI.sinRed], "error");
    } finally {
      estado.guardando = false;
      boton.disabled = false;
    }
  }

  /* Abre el formulario. opciones: { db, rid, avisar(texto, esError), alGuardar(datos) }
     Carga SIEMPRE lo vigente de la base (nombre y config completa: hace falta para validar la config candidata). */
  DR.abrir = async function (opciones) {
    var o = opciones || {};
    if (window.PR && window.PR.rol !== "dueno") return false;
    construirModal();
    estado = { db: o.db, rid: o.rid, avisar: o.avisar, alGuardar: o.alGuardar, original: null, abierto: true, guardando: false, cierreConfirmado: false, ajustesMostrados: false };

    var modal = document.getElementById("modalDatos");
    var cuerpo = document.getElementById("datosCuerpo");
    while (cuerpo.firstChild) cuerpo.removeChild(cuerpo.firstChild);
    cuerpo.appendChild(el("p", { "class": "ayuda", texto: TEXTOS_UI.cargando }));
    document.getElementById("datosGuardar").disabled = true;
    aviso(null);
    modal.classList.add("open");

    try {
      var r = await estado.db.from("restaurantes").select("nombre, config").eq("id", estado.rid).maybeSingle();
      if (r.error || !r.data) throw (r.error || new Error("sin datos"));
      estado.original = { nombre: r.data.nombre, config: r.data.config && typeof r.data.config === "object" ? r.data.config : {} };
      pintarFormulario();
      document.getElementById("datosGuardar").disabled = false;
      var primero = document.querySelector("#datosCuerpo input, #datosCuerpo textarea");
      if (primero) primero.focus();
    } catch (e) {
      while (cuerpo.firstChild) cuerpo.removeChild(cuerpo.firstChild);
      aviso("No se pudieron cargar los datos del restaurante.", ["Revisa tu conexión y vuelve a abrir esta opción."], "error");
    }
    return true;
  };

  if (typeof module !== "undefined" && module.exports) module.exports = DR;
  if (typeof window !== "undefined") window.DatosRestaurante = DR;
})();
