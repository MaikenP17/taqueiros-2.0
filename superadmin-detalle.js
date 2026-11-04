/* =============================================================
   DETALLE DE UN RESTAURANTE  (superadmin.html, fase 4; docs seccion 24)

   Pestanas: Resumen y vigencia, Dominios, Usuarios, Marca y datos, Secretos, Entrar como, Auditoria.
   Todo pasa por SA.api (POST /api/superadmin). Los textos que vienen del servidor se pintan SIEMPRE con textContent.

   SECRETOS: SOLO ESCRITURA. Esta pantalla jamas recibe un valor de secreto (el servidor no tiene ninguna accion que lo devuelva):
   solo sabe SI hay uno puesto. Al guardar, los campos y las variables se vacian pase lo que pase.
============================================================= */
(function () {
  "use strict";
  var SA = window.SA, h = SA.h, t = SA.t;
  var ROLES = { dueno: "Dueño", cajero: "Cajero", cocina: "Cocina" };
  var HEX = /^#[0-9A-Fa-f]{6}$/;
  var FUENTES = ["Anton", "Bebas Neue", "Oswald", "Montserrat", "Poppins", "Playfair Display", "Fredoka", "Lora", "Merriweather", "Libre Franklin", "Open Sans", "Nunito", "Lato", "DM Sans", "Work Sans", "Source Sans 3"];

  function campo(id, etiqueta, input, ayuda) {
    return h("div", { class: "sa-campo" }, h("label", { for: id, texto: etiqueta }), input, ayuda ? h("p", { class: "sa-ayuda", texto: ayuda }) : null);
  }
  function dato(k, v) { return h("div", null, h("dt", { texto: k }), h("dd", null, v === null || v === undefined ? "—" : (v instanceof Node ? v : t(v, 300)))); }

  /* Caja de la contrasena temporal: se ve UNA vez y se borra sola. Devuelve { nodo, limpiar }. */
  function cajaClave(clave, alBorrar) {
    var valor = clave, restante = 180, reloj = null;
    var visor = h("div", { class: "sa-clave-valor", texto: valor });
    var cuenta = h("p", { class: "sa-vence", texto: "Se borra sola en 3:00" });
    var nodo = h("div", { class: "sa-clave-caja", role: "group", "aria-label": "Contraseña temporal" });
    function limpiar() {
      valor = null; clearInterval(reloj); reloj = null;
      nodo.replaceChildren(h("div", { class: "sa-msj sa-msj-aviso", texto: "La contraseña temporal ya se borró de la pantalla. No se guarda en ningún lado." }));
      if (alBorrar) alBorrar();
    }
    var copiarBtn = h("button", { type: "button", class: "sa-btn", texto: "Copiar" });
    copiarBtn.addEventListener("click", function () { if (valor) SA.copiar(valor, "Contraseña copiada"); });
    var borrarBtn = h("button", { type: "button", class: "sa-btn", texto: "Ya la copié, borrarla" });
    borrarBtn.addEventListener("click", limpiar);
    nodo.appendChild(h("strong", { texto: "CONTRASEÑA TEMPORAL — se muestra una sola vez" }));
    nodo.appendChild(visor);
    nodo.appendChild(h("p", { class: "sa-chico", texto: "No se vuelve a ver. Entrégala por un canal privado y pide que la cambien al entrar." }));
    nodo.appendChild(h("div", { class: "sa-acciones" }, copiarBtn, borrarBtn));
    nodo.appendChild(cuenta);
    reloj = setInterval(function () {
      restante--;
      if (restante <= 0) { limpiar(); return; }
      cuenta.textContent = "Se borra sola en " + Math.floor(restante / 60) + ":" + String(restante % 60).padStart(2, "0");
    }, 1000);
    return { nodo: nodo, limpiar: limpiar };
  }
  SA.cajaClave = cajaClave;

  SA.vistas.detalle = function (cont, params, n) {
    var id = params.id;
    var tabActual = params.tab || "resumen";
    var D = null;
    var tabId = 0;
    var cabecera = h("div", { class: "sa-cabecera-vista" });
    var errorArea = h("div");
    var tablist = h("div", { class: "sa-pestanas", role: "tablist", "aria-label": "Secciones del restaurante" });
    var panel = h("div", { role: "tabpanel", id: "sa-panel-tab" });
    var limpiezasTab = [];
    SA.alSalirDeVista(function () { limpiarTab(); });
    function limpiarTab() { var l = limpiezasTab; limpiezasTab = []; l.forEach(function (f) { try { f(); } catch (e) { /* nada */ } }); }
    function alSalirDeTab(f) { limpiezasTab.push(f); }

    cont.appendChild(cabecera); cont.appendChild(errorArea); cont.appendChild(tablist); cont.appendChild(panel);

    var TABS = [["resumen", "Resumen y vigencia"], ["dominios", "Dominios"], ["usuarios", "Usuarios"], ["marca", "Marca y datos"], ["secretos", "Secretos"], ["entrar", "Entrar como"], ["auditoria", "Auditoría"]];

    function pintarTabs() {
      tablist.replaceChildren();
      TABS.forEach(function (p) {
        var b = h("button", { type: "button", role: "tab", id: "sa-tab-" + p[0], "aria-selected": tabActual === p[0] ? "true" : "false", "aria-controls": "sa-panel-tab", texto: p[1] });
        b.addEventListener("click", function () { tabActual = p[0]; pintarTabs(); pintarTab(); });
        tablist.appendChild(b);
      });
    }
    function pintarCabecera() {
      var volver = h("button", { type: "button", class: "sa-btn", texto: "← Restaurantes" });
      volver.addEventListener("click", function () { SA.ir("lista"); });
      cabecera.replaceChildren(h("div", null, h("h1", { texto: t(D.nombre, 120) }), h("div", { class: "sa-chico sa-tenue" }, h("span", { class: "sa-mono", texto: t(D.slug, 60) }), " · ", SA.pill(SA.estadoDe(D)))), volver);
    }

    function cargar() {
      return SA.api("detalle_restaurante", { restaurante_id: id }).then(function (r) {
        if (!SA.vigente(n)) return false;
        D = r.restaurante;
        pintarCabecera();
        return true;
      });
    }
    function recargar() {
      return cargar().then(function (ok) { if (ok) pintarTab(); });
    }

    function pintarTab() {
      limpiarTab();
      var mi = ++tabId;
      var f = { resumen: tabResumen, dominios: tabDominios, usuarios: tabUsuarios, marca: tabMarca, secretos: tabSecretos, entrar: tabEntrar, auditoria: tabAuditoria }[tabActual];
      panel.replaceChildren();
      f(panel, mi);
    }

    /* =========================== RESUMEN Y VIGENCIA =========================== */
    function tabResumen(p, mi) {
      var est = SA.estadoDe(D), v = D.vigencia || {};
      var msj = h("div", { role: "status" });
      var mods = Object.keys(SA.NOMBRE_MODULO).filter(function (k) { return D.modulos && D.modulos[k]; }).map(function (k) { return SA.NOMBRE_MODULO[k]; }).join(", ") || "Ninguno";
      p.appendChild(h("div", { class: "sa-tarjeta" },
        h("h2", { texto: "Vigencia" }),
        h("p", null, SA.pill(est), " ", h("span", { texto: SA.textoVigencia(D) })),
        h("dl", { class: "sa-datos" },
          dato("Plan", SA.etiquetas.plan[D.plan] || D.plan), dato("Modalidad", SA.etiquetas.modalidad[D.modalidad_pago] || D.modalidad_pago),
          dato("Vence", v.sin_vencimiento || !D.vigente_hasta ? "Sin vencimiento" : SA.fecha.corta(D.vigente_hasta)),
          dato("Días de gracia", String(D.dias_gracia)), dato("Zona horaria", D.zona_horaria), dato("Módulos", mods),
          dato("Creado", SA.fecha.hora(D.creado_en)), dato("Identificador", h("span", { class: "sa-mono sa-chico", texto: t(D.id, 60) }))),
        h("p", { class: "sa-ayuda", texto: est === "suspendido" ? "Suspendido a mano: sus clientes no pueden hacer pedidos (el menú se sigue viendo con un aviso neutro)." :
          est === "vencido" ? "Vencido: sus clientes no pueden hacer pedidos. Un pago lo vuelve a activar." : est === "gracia" ? "En gracia: todo sigue funcionando, pero el dueño ve un aviso de renovación." : "Todo funciona con normalidad." })));

      var pagar = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "sa-btn-pago", texto: "Registrar pago" });
      pagar.addEventListener("click", function () { modalPago(); });
      var suspendido = D.estado === "suspendido";
      var susp = h("button", { type: "button", class: suspendido ? "sa-btn" : "sa-btn sa-btn-peligro", id: "sa-btn-suspender", texto: suspendido ? "Reactivar" : "Suspender" });
      susp.addEventListener("click", function () { suspendido ? reactivar(susp) : suspender(susp); });
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Acciones" }), msj,
        h("div", { class: "sa-acciones" }, pagar, susp),
        D.vigente_hasta ? null : h("p", { class: "sa-ayuda", texto: "Este restaurante no tiene vencimiento: para registrar un pago primero ponle una fecha abajo (“Cambiar plan y vigencia”)." })));
      if (!D.vigente_hasta) { pagar.disabled = true; }

      function suspender(btn) {
        SA.confirmar({ titulo: "¿Suspender este restaurante?", parrafos: ["“" + t(D.nombre, 80) + "” dejará de recibir pedidos de inmediato.", "Sus pagos que ya van en camino se siguen procesando y su dueño puede seguir entrando al panel. Lo puedes reactivar cuando quieras."], boton: "Sí, suspender", peligro: true }).then(function (si) {
          if (!si) return;
          SA.enviar(btn, msj, function () {
            return SA.api("actualizar_restaurante", { restaurante_id: id, cambios: { estado: "suspendido" } }).then(function () { SA.aviso("Restaurante suspendido"); return recargar(); });
          });
        });
      }
      function reactivar(btn) {
        var sel = h("select", { id: "sa-reactivar-estado", "aria-label": "Estado al reactivar" }, h("option", { value: "activo", texto: "Activo" }), h("option", { value: "prueba", texto: "En prueba" }));
        var cuerpo = h("div", null, h("p", { texto: "“" + t(D.nombre, 80) + "” volverá a recibir pedidos (si su fecha de vencimiento sigue vigente). ¿En qué estado lo reactivas?" }), sel);
        var m = SA.modal("Reactivar restaurante", cuerpo, [
          { id: "cancelar", texto: "Cancelar", clase: "sa-btn-fantasma", accion: function (mm) { mm.cerrar(); } },
          { id: "ok", texto: "Sí, reactivar", clase: "sa-btn-primario", accion: function (mm, b) {
            if (b.disabled) return; b.disabled = true;
            var nuevo = sel.value; mm.cerrar();
            SA.enviar(btn, msj, function () {
              return SA.api("actualizar_restaurante", { restaurante_id: id, cambios: { estado: nuevo } }).then(function () { SA.aviso("Restaurante reactivado"); return recargar(); });
            });
          } }]);
        return m;
      }

      /* ---- registrar pago (dos pasos: datos y confirmacion) ---- */
      function modalPago() {
        var meses = h("input", { id: "sa-pago-meses", type: "number", min: 1, max: 36, step: 1, value: 1, inputmode: "numeric" });
        var monto = h("input", { id: "sa-pago-monto", type: "number", min: 0, max: 1000000000, step: 1, inputmode: "numeric", placeholder: "Opcional" });
        var ref = h("input", { id: "sa-pago-ref", type: "text", maxlength: 80, placeholder: "Opcional (ej. recibo 001)", autocomplete: "off" });
        var nota = h("input", { id: "sa-pago-nota", type: "text", maxlength: 300, placeholder: "Opcional", autocomplete: "off" });
        var err = h("div", { role: "alert" });
        var estimada = h("p", { class: "sa-ayuda", id: "sa-pago-estimada" });
        function actualizar() {
          var m = Number(meses.value);
          if (!Number.isInteger(m) || m < 1 || m > 36 || !D.vigente_hasta) { estimada.textContent = ""; return; }
          var desde = D.vigente_hasta < SA.fecha.hoy() ? SA.fecha.hoy() : D.vigente_hasta;
          estimada.textContent = "Se contará desde " + SA.fecha.corta(desde) + " y la nueva fecha será aproximadamente " + SA.fecha.corta(SA.fecha.sumarMeses(desde, m)) + " (el servidor hace la cuenta final).";
        }
        meses.addEventListener("input", actualizar);
        var cuerpo = h("div", null,
          h("p", { class: "sa-ayuda", texto: "Si el restaurante ya venció, los meses se cuentan desde HOY. Si sigue vigente, se suman a su fecha de vencimiento actual. Un restaurante en prueba pasa a activo. Uno suspendido a mano sigue suspendido." }),
          campo("sa-pago-meses", "Meses que pagó (1 a 36)", meses), estimada,
          campo("sa-pago-monto", "Monto en pesos", monto), campo("sa-pago-ref", "Referencia", ref), campo("sa-pago-nota", "Nota", nota), err);
        actualizar();
        SA.modal("Registrar un pago", cuerpo, [
          { id: "cancelar", texto: "Cancelar", clase: "sa-btn-fantasma", accion: function (mm) { mm.cerrar(); } },
          { id: "seguir", texto: "Revisar", clase: "sa-btn-primario", accion: function (mm) {
            var mm_ = Number(meses.value);
            if (meses.value === "" || !Number.isInteger(mm_) || mm_ < 1 || mm_ > 36) { SA.mostrarError(err, new Error("Los meses son un número entero de 1 a 36.")); return; }
            var datos = { restaurante_id: id, meses: mm_ };
            if (monto.value !== "") {
              var mo = Number(monto.value);
              if (!isFinite(mo) || mo < 0 || mo > 1000000000) { SA.mostrarError(err, new Error("El monto debe ser un número de pesos entre 0 y 1.000.000.000.")); return; }
              datos.monto = mo;
            }
            if (ref.value.trim()) datos.referencia = ref.value.trim();
            if (nota.value.trim()) datos.nota = nota.value.trim();
            mm.cerrar();
            SA.confirmar({ titulo: "Confirma el pago", parrafos: [
              "Vas a registrar un pago de " + mm_ + (mm_ === 1 ? " mes" : " meses") + " para “" + t(D.nombre, 80) + "”" + (datos.monto !== undefined ? " por " + SA.pesos(datos.monto) : "") + ".",
              "Esto extiende su vigencia y queda en la auditoría. No se puede deshacer desde aquí (se corrige cambiando la fecha de vencimiento)."], boton: "Sí, registrar el pago" }).then(function (si) {
              if (!si) return;
              if (pagando) return; pagando = true;
              SA.api("registrar_pago", datos).then(function (r) {
                var pago = r.pago || {};
                SA.aviso("Pago registrado. Nueva fecha: " + SA.fecha.corta(pago.vigente_hasta_nueva) + (pago.aviso ? ". " + t(pago.aviso, 200) : ""), 7000);
                return recargar();
              }).catch(function (e) { SA.mostrarError(msj, e); }).then(function () { pagando = false; });
            });
          } }]);
      }
      var pagando = false;

      /* ---- cambiar plan, modulos, modalidad, gracia, zona y vencimiento ---- */
      var nombre = h("input", { id: "sa-c-nombre", type: "text", maxlength: 120, value: D.nombre, autocomplete: "off" });
      var plan = h("select", { id: "sa-c-plan" }, ["completo", "basico", "comandas"].map(function (k) { return h("option", { value: k, selected: D.plan === k ? true : null, texto: SA.etiquetas.plan[k] }); }));
      var modalidad = h("select", { id: "sa-c-modalidad" }, ["mensual", "unico"].map(function (k) { return h("option", { value: k, selected: D.modalidad_pago === k ? true : null, texto: SA.etiquetas.modalidad[k] }); }));
      var gracia = h("input", { id: "sa-c-gracia", type: "number", min: 0, max: 60, step: 1, value: D.dias_gracia, inputmode: "numeric" });
      var zona = h("input", { id: "sa-c-zona", type: "text", maxlength: 64, value: D.zona_horaria, class: "sa-mono", autocomplete: "off" });
      var fecha = h("input", { id: "sa-c-fecha", type: "date", value: D.vigente_hasta || "" });
      var sinVenc = h("input", { id: "sa-c-sinvenc", type: "checkbox", checked: D.vigente_hasta ? null : true });
      fecha.disabled = sinVenc.checked;
      sinVenc.addEventListener("change", function () { fecha.disabled = sinVenc.checked; });
      var chkMods = {};
      var modsCaja = h("div", { class: "sa-rejilla-chica" }, Object.keys(SA.NOMBRE_MODULO).map(function (k) {
        var c = h("input", { type: "checkbox", id: "sa-c-mod-" + k, checked: D.modulos && D.modulos[k] ? true : null }); chkMods[k] = c;
        return h("div", { class: "sa-fila-check" }, c, h("label", { for: "sa-c-mod-" + k, texto: SA.NOMBRE_MODULO[k] }));
      }));
      var ayudaPlan = h("p", { class: "sa-ayuda" });
      function textoPlan() {
        var r = SA.REFERENCIA_PLANES[plan.value];
        ayudaPlan.textContent = r ? "Referencia: " + SA.pesos(r.unico) + " pago único · " + SA.pesos(r.mensual) + " al mes. " + r.texto : "";
      }
      plan.addEventListener("change", function () {
        var r = SA.REFERENCIA_PLANES[plan.value];
        if (r) Object.keys(chkMods).forEach(function (k) { chkMods[k].checked = !!r.modulos[k]; });
        textoPlan();
      });
      textoPlan();
      var errC = h("div", { role: "alert" });
      var guardarC = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "sa-c-guardar", texto: "Guardar cambios" });
      guardarC.addEventListener("click", function () {
        SA.enviar(guardarC, errC, function () {
          var cambios = {};
          var nom = nombre.value.trim();
          if (!nom || nom.length > 120 || SA.validar.raro.test(nom)) throw new Error("El nombre debe tener de 1 a 120 caracteres, sin < ni > ni caracteres de control.");
          if (nom !== D.nombre) cambios.nombre = nom;
          if (plan.value !== D.plan) cambios.plan = plan.value;
          if (modalidad.value !== D.modalidad_pago) cambios.modalidad_pago = modalidad.value;
          var g = Number(gracia.value);
          if (gracia.value === "" || !Number.isInteger(g) || g < 0 || g > 60) throw new Error("Los días de gracia son un número entero de 0 a 60.");
          if (g !== D.dias_gracia) cambios.dias_gracia = g;
          if (!SA.validar.zona.test(zona.value.trim())) throw new Error("La zona horaria no parece válida (ejemplo: America/Bogota).");
          if (zona.value.trim() !== D.zona_horaria) cambios.zona_horaria = zona.value.trim();
          if (sinVenc.checked) { if (D.vigente_hasta) cambios.vigente_hasta = null; }
          else {
            if (!SA.fecha.valida(fecha.value)) throw new Error("Escribe una fecha de vencimiento válida o marca “Sin vencimiento”.");
            if (fecha.value !== D.vigente_hasta) cambios.vigente_hasta = fecha.value;
          }
          var modsNuevos = {}, difiere = false;
          Object.keys(chkMods).forEach(function (k) { modsNuevos[k] = chkMods[k].checked; if (!!(D.modulos && D.modulos[k]) !== chkMods[k].checked) difiere = true; });
          if (difiere) cambios.modulos = modsNuevos;
          if (!Object.keys(cambios).length) throw new Error("No cambiaste nada.");
          return SA.api("actualizar_restaurante", { restaurante_id: id, cambios: cambios }).then(function () { SA.aviso("Cambios guardados"); return recargar(); });
        });
      });
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Cambiar plan y vigencia" }),
        h("div", { class: "sa-rejilla" }, campo("sa-c-nombre", "Nombre", nombre), campo("sa-c-plan", "Plan", plan), campo("sa-c-modalidad", "Modalidad de pago", modalidad)),
        ayudaPlan,
        h("h3", { texto: "Módulos" }), modsCaja,
        h("div", { class: "sa-rejilla" }, campo("sa-c-gracia", "Días de gracia", gracia), campo("sa-c-zona", "Zona horaria", zona),
          h("div", { class: "sa-campo" }, h("label", { for: "sa-c-fecha", texto: "Vence el" }), fecha,
            h("div", { class: "sa-fila-check" }, sinVenc, h("label", { for: "sa-c-sinvenc", texto: "Sin vencimiento (pago único)" })))),
        errC, h("div", { class: "sa-acciones" }, guardarC)));
    }

    /* =========================== DOMINIOS =========================== */
    function tabDominios(p, mi) {
      var msj = h("div", { role: "alert" });
      var lista = h("ul", { class: "sa-lista-simple" });
      (D.dominios || []).forEach(function (host) {
        var quitar = h("button", { type: "button", class: "sa-btn sa-btn-peligro", texto: "Quitar", "aria-label": "Quitar " + t(host, 80) });
        quitar.addEventListener("click", function () {
          SA.confirmar({ titulo: "¿Quitar este dominio?", parrafos: ["“" + t(host, 100) + "” dejará de mostrar este restaurante. Si es el único, el restaurante solo se podrá alcanzar por su subdominio automático (si está configurado)."], boton: "Sí, quitar", peligro: true }).then(function (si) {
            if (!si) return;
            SA.enviar(quitar, msj, function () { return SA.api("quitar_dominio", { restaurante_id: id, host: host }).then(function () { SA.aviso("Dominio quitado"); return recargar(); }); });
          });
        });
        lista.appendChild(h("li", null, h("span", { class: "sa-mono", texto: t(host, 253) }), quitar));
      });
      var nuevo = h("input", { id: "sa-dom-nuevo", type: "text", maxlength: 253, class: "sa-mono", placeholder: "pedidos.mirestaurante.com", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
      var agregar = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "sa-dom-agregar", texto: "Agregar dominio" });
      agregar.addEventListener("click", function () {
        SA.enviar(agregar, msj, function () {
          var hh = nuevo.value.trim().toLowerCase();
          if (!SA.validar.host.test(hh)) throw new Error("La dirección no es válida. Escríbela sin https:// ni barras (ejemplo: pedidos.mirestaurante.com).");
          return SA.api("agregar_dominio", { restaurante_id: id, host: hh }).then(function () { SA.aviso("Dominio agregado"); return recargar(); }).catch(function (e) {
            if (e.status === 409) throw new Error("Ese dominio ya está en uso por otro restaurante (o por este).");
            throw e;
          });
        });
      });
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Dominios de este restaurante" }),
        (D.dominios || []).length ? lista : h("p", { class: "sa-tenue", texto: "No tiene dominio propio. Solo se alcanza por su subdominio automático, si está configurado." }),
        msj));
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Agregar un dominio" }), campo("sa-dom-nuevo", "Dirección", nuevo),
        h("div", { class: "sa-msj sa-msj-aviso", texto: "Agregarlo aquí NO basta: también hay que agregarlo en Vercel (Project → Settings → Domains) y crear en el DNS el registro que Vercel indique. Para comprobarlo, abre la dirección en el navegador: si ves el menú del restaurante, ya funciona." }),
        h("div", { class: "sa-acciones" }, agregar)));
    }

    /* =========================== USUARIOS =========================== */
    function tabUsuarios(p, mi) {
      var msj = h("div", { role: "alert" });
      var claveCaja = h("div");
      var tbody = h("tbody");
      var ms = (D.miembros || []);
      ms.forEach(function (m) {
        var sel = h("select", { "aria-label": "Rol de " + t(m.email, 60), class: "sa-rol-sel" }, Object.keys(ROLES).map(function (k) { return h("option", { value: k, selected: m.rol === k ? true : null, texto: ROLES[k] }); }));
        var cambiar = h("button", { type: "button", class: "sa-btn", texto: "Cambiar rol" });
        cambiar.addEventListener("click", function () {
          if (sel.value === m.rol) { SA.aviso("Ya tiene ese rol"); return; }
          SA.enviar(cambiar, msj, function () { return SA.api("asignar_miembro", { restaurante_id: id, usuario_id: m.user_id, rol: sel.value }).then(function () { SA.aviso("Rol cambiado"); return recargar(); }); });
        });
        var quitar = h("button", { type: "button", class: "sa-btn sa-btn-peligro", texto: "Quitar" });
        quitar.addEventListener("click", function () {
          SA.confirmar({ titulo: "¿Quitar a este usuario?", parrafos: ["“" + t(m.email || "sin correo", 100) + "” dejará de tener acceso a este restaurante. Su cuenta no se borra."], boton: "Sí, quitar", peligro: true }).then(function (si) {
            if (!si) return;
            SA.enviar(quitar, msj, function () { return SA.api("quitar_miembro", { restaurante_id: id, usuario_id: m.user_id }).then(function () { SA.aviso("Usuario quitado"); return recargar(); }); });
          });
        });
        tbody.appendChild(h("tr", null,
          h("td", { "data-etiqueta": "Correo", class: "sa-sin-etiqueta" }, h("strong", { texto: t(m.email || "(sin correo)", 120) }), m.activo === false ? h("span", { class: "sa-pill sa-pill-neutro", texto: "Inactivo" }) : null),
          h("td", { "data-etiqueta": "Rol" }, sel), h("td", { "data-etiqueta": "Acciones" }, h("div", { class: "sa-acciones" }, cambiar, quitar))));
      });
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Personas con acceso" }),
        ms.length ? h("table", { class: "sa-tabla" }, h("thead", null, h("tr", null, ["Correo", "Rol", "Acciones"].map(function (x) { return h("th", { scope: "col", texto: x }); }))), tbody) : h("p", { class: "sa-tenue", texto: "Nadie tiene acceso todavía." }), msj));

      /* agregar: usuario nuevo o ya existente */
      var modo = "nuevo";
      var correo = h("input", { id: "sa-u-correo", type: "email", maxlength: 254, autocomplete: "off", inputmode: "email", autocapitalize: "off", spellcheck: "false" });
      var rol = h("select", { id: "sa-u-rol" }, Object.keys(ROLES).map(function (k) { return h("option", { value: k, texto: ROLES[k] }); }));
      var rNuevo = h("input", { type: "radio", name: "sa-u-modo", id: "sa-u-nuevo", value: "nuevo", checked: true });
      var rExiste = h("input", { type: "radio", name: "sa-u-modo", id: "sa-u-existe", value: "existe" });
      var boton = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "sa-u-ir", texto: "Crear usuario" });
      var err = h("div", { role: "alert" });
      function cambiarModo() { modo = rNuevo.checked ? "nuevo" : "existe"; boton.textContent = modo === "nuevo" ? "Crear usuario" : "Buscar y dar acceso"; }
      rNuevo.addEventListener("change", cambiarModo); rExiste.addEventListener("change", cambiarModo);
      boton.addEventListener("click", function () {
        SA.enviar(boton, err, function () {
          var c = correo.value.trim().toLowerCase();
          if (!SA.validar.correo.test(c) || c.length > 254) throw new Error("El correo no es válido.");
          claveCaja.replaceChildren();
          if (modo === "nuevo") {
            return SA.api("crear_usuario", { email: c, restaurante_id: id, rol: rol.value }).then(function (r) {
              correo.value = "";
              var caja = cajaClave(r.password_temporal, null);
              alSalirDeTab(caja.limpiar);
              claveCaja.replaceChildren(h("div", { class: "sa-msj sa-msj-ok", texto: "Usuario creado: " + t(r.usuario && r.usuario.email, 120) + " (" + ROLES[rol.value] + ")." }), caja.nodo);
              return cargar();
            }).catch(function (e) {
              if (e.status === 409) throw new Error("Ya existe un usuario con ese correo. Elige “Ya tiene cuenta” para darle acceso a este restaurante.");
              throw e;
            });
          }
          return SA.api("buscar_usuario", { email: c }).then(function (r) {
            if (!r.usuario) throw new Error("No existe ningún usuario con ese correo. Elige “Crear usuario nuevo”.");
            return SA.api("asignar_miembro", { restaurante_id: id, usuario_id: r.usuario.id, rol: rol.value });
          }).then(function () { correo.value = ""; SA.aviso("Acceso dado"); return recargar(); });
        });
      });
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Agregar a alguien" }),
        h("div", { class: "sa-fila-check" }, rNuevo, h("label", { for: "sa-u-nuevo", texto: "Crear usuario nuevo (se genera una contraseña temporal)" })),
        h("div", { class: "sa-fila-check" }, rExiste, h("label", { for: "sa-u-existe", texto: "Ya tiene cuenta (solo darle acceso)" })),
        h("div", { class: "sa-rejilla" }, campo("sa-u-correo", "Correo", correo), campo("sa-u-rol", "Rol", rol)),
        h("p", { class: "sa-ayuda", texto: "Dueño: todo. Cajero: tablero de pedidos. Cocina: ve las comandas." }),
        err, h("div", { class: "sa-acciones" }, boton), claveCaja));
    }

    /* =========================== MARCA Y DATOS =========================== */
    function getIn(o, ruta) { var x = o; for (var i = 0; i < ruta.length; i++) { if (x === null || typeof x !== "object") return undefined; x = x[ruta[i]]; } return x; }
    function setIn(o, ruta, valor) {   // valor undefined = borrar (y podar objetos vacios)
      var pila = [o];
      for (var i = 0; i < ruta.length - 1; i++) {
        var sig = pila[pila.length - 1][ruta[i]];
        if (sig === null || typeof sig !== "object" || Array.isArray(sig)) { if (valor === undefined) return; sig = pila[pila.length - 1][ruta[i]] = {}; }
        pila.push(sig);
      }
      var ult = ruta[ruta.length - 1];
      if (valor === undefined) delete pila[pila.length - 1][ult]; else pila[pila.length - 1][ult] = valor;
      for (var j = pila.length - 1; j > 0; j--) { if (Object.keys(pila[j]).length === 0) delete pila[j - 1][ruta[j - 1]]; else break; }
    }
    function clonar(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

    var COLORES = [["primario", "Principal"], ["primario_oscuro", "Principal oscuro"], ["primario_brillo", "Principal brillante"], ["claro", "Fondo claro"], ["claro_suave", "Claro suave"], ["oscuro", "Fondo oscuro"], ["oscuro_2", "Oscuro 2"], ["acento", "Acento"], ["positivo", "Positivo"], ["texto_secundario", "Texto secundario"], ["texto_tenue", "Texto tenue"], ["positivo_brillo", "Positivo brillante"]];
    var TEXTOS = [["titulo_pagina", "Título de la página", 400], ["descripcion_pagina", "Descripción de la página", 400], ["eslogan", "Eslogan", 400], ["tagline", "Frase de portada", 400], ["descripcion_pie", "Descripción del pie", 400], ["servicios_linea", "Línea de servicios", 400], ["pie_final", "Pie final", 400], ["ejemplo_nota", "Ejemplo de nota del pedido", 400],
      ["banner_abierto_icono", "Banner abierto: ícono", 400], ["banner_abierto_titulo", "Banner abierto: título", 400], ["banner_abierto_texto", "Banner abierto: texto", 400], ["banner_cerrado_icono", "Banner cerrado: ícono", 400], ["banner_cerrado_mensaje", "Banner cerrado: mensaje", 400]];
    var SEGUIMIENTO = ["tiempo_nuevo", "tiempo_preparacion", "tiempo_camino", "tiempo_recoger", "tiempo_entregado", "frase_nuevo", "frase_preparacion", "frase_camino", "frase_recoger", "frase_entregado"];

    function luminancia(hex) {
      var c = [1, 3, 5].map(function (i) { var v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function contraste(a, b) { var la = luminancia(a), lb = luminancia(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }

    function tabMarca(p, mi) {
      var cfg = D.config || {};
      var publico = (cfg.publico && typeof cfg.publico === "object") ? cfg.publico : {};
      p.appendChild(h("div", { class: "sa-msj sa-msj-info", texto: "Cada tarjeta guarda su sección completa. Lo que el servidor no acepta se muestra tal cual, en rojo, y no se cambia nada." }));

      /* guardar una seccion: { ruta: ["publico","marca"], clave: "marca" } */
      function guardarSeccion(btn, area, clave, valor) {
        return SA.enviar(btn, area, function () {
          var cambios = {}; cambios[clave] = valor;
          return SA.api("editar_config", { restaurante_id: id, cambios: cambios }).then(function () { SA.aviso("Guardado"); return recargar(); });
        });
      }
      function tarjeta(titulo, ayuda, hijos, guardar) {
        var area = h("div", { role: "alert" });
        var btn = h("button", { type: "button", class: "sa-btn sa-btn-primario", texto: "Guardar " + titulo.toLowerCase() });
        btn.addEventListener("click", function () { area.replaceChildren(); guardar(btn, area); });
        p.appendChild(h("div", { class: "sa-tarjeta", "data-seccion": titulo }, h("h2", { texto: titulo }), ayuda ? h("p", { class: "sa-ayuda", texto: ayuda }) : null, hijos, area, h("div", { class: "sa-acciones" }, btn)));
      }
      function camposTexto(ruta, defs, prefijoId) {   // defs: [clave, etiqueta, max, ayuda?]
        var inputs = {};
        var nodos = defs.map(function (d) {
          var v = getIn(publico, ruta.concat(d[0]));
          var inp = h("input", { id: prefijoId + d[0], type: "text", maxlength: d[2], value: typeof v === "string" ? v : "", autocomplete: "off" });
          inputs[d[0]] = inp;
          return campo(prefijoId + d[0], d[1], inp, d[3]);
        });
        return { inputs: inputs, nodo: h("div", { class: "sa-rejilla" }, nodos) };
      }
      function aplicarTextos(objeto, ruta, inputs) {
        Object.keys(inputs).forEach(function (k) { var v = inputs[k].value.trim(); setIn(objeto, ruta.concat(k), v === "" ? undefined : v); });
      }

      /* ---- Marca ---- */
      (function () {
        var base = clonar(publico.marca) || {};
        var txt = camposTexto([], [["logo", "Ruta del logo", 500, "Ruta del sitio (Recursos/logo.png) o dirección https del almacenamiento del proyecto."], ["icono_192", "Icono 192", 500], ["icono_512", "Icono 512", 500], ["emoji", "Emoji", 8]], "sa-m-");
        Object.keys(txt.inputs).forEach(function (k) { var v = base[k]; txt.inputs[k].value = typeof v === "string" ? v : ""; });
        var colores = {}, filasColor = [];
        var actuales = (base.colores && typeof base.colores === "object") ? base.colores : {};
        var muestra = h("div", { class: "sa-muestra", id: "sa-muestra" });
        var tabla = h("div", { id: "sa-contrastes" });
        COLORES.forEach(function (c) {
          var k = c[0];
          var inicial = HEX.test(actuales[k] || "") ? actuales[k] : "";
          var sel = h("input", { type: "color", id: "sa-col-" + k, value: inicial || "#000000", "aria-label": c[1] + " (selector)" });
          var tx = h("input", { type: "text", id: "sa-colt-" + k, value: inicial, maxlength: 7, class: "sa-mono", placeholder: "#RRGGBB", "aria-label": c[1] + " (código)", autocomplete: "off" });
          sel.addEventListener("input", function () { tx.value = sel.value.toUpperCase(); colores[k] = tx.value; vista(); });
          tx.addEventListener("input", function () { colores[k] = tx.value.trim(); if (HEX.test(tx.value.trim())) sel.value = tx.value.trim().toLowerCase(); vista(); });
          colores[k] = inicial;
          filasColor.push(h("div", null, h("label", { for: "sa-colt-" + k, texto: c[1] }), h("div", { class: "sa-color-fila" }, sel, tx)));
        });
        function col(k) { return HEX.test(colores[k] || "") ? colores[k] : null; }
        function vista() {
          var fondo = col("oscuro"), texto = col("claro"), princ = col("primario"), acento = col("acento"), sec = col("texto_secundario");
          muestra.replaceChildren();
          if (fondo) muestra.style.backgroundColor = fondo; else muestra.style.removeProperty("background-color");
          if (texto) muestra.style.color = texto; else muestra.style.removeProperty("color");
          var b1 = h("span", { class: "sa-muestra-boton", texto: "Pedir ahora" }); if (princ) b1.style.backgroundColor = princ; if (texto) b1.style.color = texto;
          var b2 = h("span", { class: "sa-muestra-boton", texto: "Oferta" }); if (acento) b2.style.backgroundColor = acento; if (fondo) b2.style.color = fondo;
          var s = h("p", { texto: "Texto secundario sobre el fondo oscuro" }); if (sec) s.style.color = sec;
          muestra.appendChild(h("h3", { texto: "Así se ve la mezcla" })); muestra.appendChild(s); muestra.appendChild(b1); muestra.appendChild(b2);
          var pares = [["Texto claro sobre fondo oscuro", texto, fondo], ["Texto secundario sobre fondo oscuro", sec, fondo], ["Texto claro sobre el color principal", texto, princ], ["Fondo oscuro sobre el acento", fondo, acento]];
          tabla.replaceChildren(h("h3", { texto: "Legibilidad (mínimo recomendado 4.5)" }), h("ul", { class: "sa-lista-simple" }, pares.map(function (q) {
            if (!q[1] || !q[2]) return h("li", null, h("span", { texto: q[0] }), h("span", { class: "sa-tenue", texto: "faltan colores" }));
            var r = contraste(q[1], q[2]);
            return h("li", null, h("span", { texto: q[0] }), h("span", { class: r >= 4.5 ? "sa-contraste-ok" : "sa-contraste-mal", texto: r.toFixed(1) + (r >= 4.5 ? " — bien" : " — difícil de leer") }));
          })));
        }
        vista();
        var zonas = h("input", { id: "sa-m-zonas", type: "text", class: "sa-mono", value: Array.isArray(base.colores_zonas) ? base.colores_zonas.join(", ") : "", placeholder: "#5C7A3B, #E3A008", autocomplete: "off" });
        var tip = (base.tipografia && typeof base.tipografia === "object") ? base.tipografia : {};
        var selTit = h("select", { id: "sa-m-tit" }, [h("option", { value: "", texto: "(sin definir)" })].concat(FUENTES.map(function (f) { return h("option", { value: f, selected: tip.titulos === f ? true : null, texto: f }); })));
        var selCue = h("select", { id: "sa-m-cue" }, [h("option", { value: "", texto: "(sin definir)" })].concat(FUENTES.map(function (f) { return h("option", { value: f, selected: tip.cuerpo === f ? true : null, texto: f }); })));
        tarjeta("Marca", "Logo, iconos, colores y tipografías del sitio y del panel del restaurante.", [
          txt.nodo, h("h3", { texto: "Colores" }), h("div", { class: "sa-rejilla" }, filasColor), muestra, tabla,
          campo("sa-m-zonas", "Colores de las zonas de domicilio (hasta 8, separados por coma)", zonas),
          h("div", { class: "sa-rejilla" }, campo("sa-m-tit", "Tipografía de títulos", selTit), campo("sa-m-cue", "Tipografía de texto", selCue))
        ], function (btn, area) {
          var salida = clonar(base);
          aplicarTextos(salida, [], txt.inputs);
          COLORES.forEach(function (c) {
            var v = (colores[c[0]] || "").trim();
            if (v !== "" && !HEX.test(v)) { v = null; }
            if (v === null) throw_(area, "El color “" + c[1] + "” debe ser #RRGGBB (por ejemplo #C1272D).");
            setIn(salida, ["colores", c[0]], v === "" ? undefined : v.toUpperCase());
          });
          if (area.firstChild) return;
          var zs = zonas.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
          if (zs.length > 8 || zs.some(function (x) { return !HEX.test(x); })) { throw_(area, "Los colores de zonas son hasta 8 códigos #RRGGBB separados por coma."); return; }
          setIn(salida, ["colores_zonas"], zs.length ? zs.map(function (x) { return x.toUpperCase(); }) : undefined);
          setIn(salida, ["tipografia", "titulos"], selTit.value || undefined);
          setIn(salida, ["tipografia", "cuerpo"], selCue.value || undefined);
          guardarSeccion(btn, area, "marca", Object.keys(salida).length ? salida : null);
        });
      })();

      /* ---- Contacto ---- */
      (function () {
        var base = clonar(publico.contacto) || {};
        var c = camposTexto(["contacto"], [["whatsapp", "WhatsApp (con indicativo)", 25, "Ejemplo: 573001112233"], ["telefono", "Teléfono", 40], ["direccion", "Dirección", 200], ["direccion_corta", "Dirección corta", 200], ["ciudad", "Ciudad", 80], ["region", "Departamento o región", 80], ["instagram", "Instagram (sin @)", 61], ["tiktok", "TikTok (sin @)", 61]], "sa-ct-");
        tarjeta("Contacto", null, c.nodo, function (btn, area) {
          var salida = clonar(base); aplicarTextos(salida, [], c.inputs);
          guardarSeccion(btn, area, "contacto", Object.keys(salida).length ? salida : null);
        });
      })();

      /* ---- Ubicacion ---- */
      (function () {
        var base = clonar(cfg.ubicacion) || {};
        var lat = h("input", { id: "sa-ub-lat", type: "number", step: "any", min: -90, max: 90, value: typeof base.lat === "number" ? base.lat : "", inputmode: "decimal" });
        var lng = h("input", { id: "sa-ub-lng", type: "number", step: "any", min: -180, max: 180, value: typeof base.lng === "number" ? base.lng : "", inputmode: "decimal" });
        tarjeta("Ubicación", "De aquí sale la distancia del domicilio. Hacen falta las dos coordenadas.", h("div", { class: "sa-rejilla" }, campo("sa-ub-lat", "Latitud", lat), campo("sa-ub-lng", "Longitud", lng)), function (btn, area) {
          if (lat.value === "" && lng.value === "") { guardarSeccion(btn, area, "ubicacion", null); return; }
          var a = Number(lat.value), b = Number(lng.value);
          if (lat.value === "" || lng.value === "" || !isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) { throw_(area, "Escribe la latitud (-90 a 90) y la longitud (-180 a 180)."); return; }
          var salida = clonar(base); salida.lat = a; salida.lng = b;
          guardarSeccion(btn, area, "ubicacion", salida);
        });
      })();

      /* ---- Domicilio ---- */
      (function () {
        var base = clonar(cfg.domicilio) || {};
        var defs = [["factor_recorrido", "Factor de recorrido (1 a 3)", ["factor_recorrido"]], ["pin_minimo_metros", "Distancia mínima del pin (m, 0 a 5000)", ["pin_minimo_metros"]],
          ["latMin", "Latitud mínima del área", ["area", "latMin"]], ["latMax", "Latitud máxima del área", ["area", "latMax"]], ["lngMin", "Longitud mínima del área", ["area", "lngMin"]], ["lngMax", "Longitud máxima del área", ["area", "lngMax"]]];
        var inputs = {};
        var nodos = defs.map(function (d) {
          var v = getIn(base, d[2]);
          var inp = h("input", { id: "sa-dm-" + d[0], type: "number", step: "any", value: typeof v === "number" ? v : "", inputmode: "decimal" }); inputs[d[0]] = inp;
          return campo("sa-dm-" + d[0], d[1], inp);
        });
        tarjeta("Domicilio", "Cómo se calcula la distancia y el área donde se acepta domicilio.", h("div", { class: "sa-rejilla" }, nodos), function (btn, area) {
          var salida = clonar(base);
          for (var i = 0; i < defs.length; i++) {
            var raw = inputs[defs[i][0]].value;
            if (raw === "") { setIn(salida, defs[i][2], undefined); continue; }
            var num = Number(raw);
            if (!isFinite(num)) { throw_(area, "“" + defs[i][1] + "” debe ser un número."); return; }
            setIn(salida, defs[i][2], num);
          }
          guardarSeccion(btn, area, "domicilio", Object.keys(salida).length ? salida : null);
        });
      })();

      /* ---- Tarifas de domicilio (accion propia) ---- */
      (function () {
        var filas = (D.tarifas || []).map(function (x) { return { hasta: x.hasta, precio: x.precio }; });
        var caja = h("div"), area = h("div", { role: "alert" });
        function pintar() {
          caja.replaceChildren();
          filas.forEach(function (f, i) {
            var hasta = h("input", { type: "number", step: "0.1", min: 0.1, max: 1000, value: f.hasta === null || f.hasta === undefined ? "" : f.hasta, "aria-label": "Hasta cuántos km, tramo " + (i + 1), inputmode: "decimal" });
            var precio = h("input", { type: "number", step: 1, min: 0, max: 500000, value: f.precio === null || f.precio === undefined ? "" : f.precio, placeholder: "Vacío = fuera de cobertura", "aria-label": "Precio del tramo " + (i + 1), inputmode: "numeric" });
            hasta.addEventListener("input", function () { f.hasta = hasta.value; }); precio.addEventListener("input", function () { f.precio = precio.value; });
            var quitar = h("button", { type: "button", class: "sa-btn", texto: "Quitar tramo", "aria-label": "Quitar el tramo " + (i + 1) });
            quitar.addEventListener("click", function () { filas.splice(i, 1); pintar(); });
            caja.appendChild(h("div", { class: "sa-rejilla" }, campo("", "Hasta (km)", hasta), campo("", "Precio ($)", precio), h("div", { class: "sa-campo" }, h("label", { texto: "Acción" }), quitar)));
          });
          if (!filas.length) caja.appendChild(h("p", { class: "sa-tenue", texto: "Sin tarifas: este restaurante no ofrece domicilio." }));
        }
        pintar();
        var agregar = h("button", { type: "button", class: "sa-btn", texto: "Agregar tramo" });
        agregar.addEventListener("click", function () { if (filas.length >= 20) { SA.aviso("Máximo 20 tramos"); return; } filas.push({ hasta: "", precio: "" }); pintar(); });
        var guardar = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "sa-tarifas-guardar", texto: "Guardar tarifas" });
        guardar.addEventListener("click", function () {
          SA.enviar(guardar, area, function () {
            var salida = [];
            for (var i = 0; i < filas.length; i++) {
              var hasta = Number(filas[i].hasta), pr = filas[i].precio;
              if (filas[i].hasta === "" || !isFinite(hasta) || hasta <= 0 || hasta > 1000) throw new Error("En el tramo " + (i + 1) + ", “hasta” debe ser un número de km mayor que 0 y hasta 1000.");
              var precio = null;
              if (pr !== "" && pr !== null && pr !== undefined) { precio = Number(pr); if (!isFinite(precio) || precio < 0 || precio > 500000) throw new Error("En el tramo " + (i + 1) + ", el precio debe estar entre 0 y 500.000 (o vacío)."); }
              salida.push({ hasta: hasta, precio: precio });
            }
            return SA.api("guardar_tarifas", { restaurante_id: id, tarifas: salida }).then(function () { SA.aviso("Tarifas guardadas"); return recargar(); });
          });
        });
        p.appendChild(h("div", { class: "sa-tarjeta", "data-seccion": "Tarifas" }, h("h2", { texto: "Tarifas de domicilio" }),
          h("p", { class: "sa-ayuda", texto: "Cada tramo dice hasta cuántos km llega y cuánto cuesta. Un tramo sin precio significa “fuera de cobertura”. Guardar reemplaza todas las tarifas." }),
          caja, area, h("div", { class: "sa-acciones" }, agregar, guardar)));
      })();

      /* ---- App instalable (PWA) ---- */
      (function () {
        var base = clonar(publico.pwa) || {};
        var c = camposTexto(["pwa"], [["nombre", "Nombre de la app", 45], ["nombre_corto", "Nombre corto (12 letras)", 12]], "sa-pw-");
        tarjeta("App del panel", "Cómo se llama el panel cuando se instala en el celular o el computador.", c.nodo, function (btn, area) {
          var salida = clonar(base); aplicarTextos(salida, [], c.inputs);
          guardarSeccion(btn, area, "pwa", Object.keys(salida).length ? salida : null);
        });
      })();

      /* ---- Wompi: llaves PUBLICAS (no secretas) ---- */
      (function () {
        var base = clonar(publico.wompi) || {};
        var c = camposTexto(["wompi"], [["llave_publica_test", "Llave pública de pruebas", 100, "Empieza con pub_test_"], ["llave_publica_prod", "Llave pública de producción", 100, "Empieza con pub_prod_"]], "sa-wp-");
        tarjeta("Wompi (llaves públicas)", "Estas dos llaves son públicas por diseño. Las llaves secretas se cargan en la pestaña Secretos.", c.nodo, function (btn, area) {
          var salida = clonar(base); aplicarTextos(salida, [], c.inputs);
          guardarSeccion(btn, area, "wompi", Object.keys(salida).length ? salida : null);
        });
      })();

      /* ---- Textos del sitio ---- */
      (function () {
        var base = clonar(publico.textos) || {};
        var c = camposTexto(["textos"], TEXTOS, "sa-tx-");
        var seg = camposTexto(["textos", "seguimiento"], SEGUIMIENTO.map(function (k) { return [k, k.replace(/_/g, " "), 200]; }), "sa-sg-");
        tarjeta("Textos", "Los textos del sitio público. Una sola línea cada uno (sin saltos de línea).", [c.nodo, h("details", { class: "sa-detalle" }, h("summary", { texto: "Textos del seguimiento del pedido" }), seg.nodo)], function (btn, area) {
          var salida = clonar(base);
          aplicarTextos(salida, [], c.inputs);
          Object.keys(seg.inputs).forEach(function (k) { var v = seg.inputs[k].value.trim(); setIn(salida, ["seguimiento", k], v === "" ? undefined : v); });
          guardarSeccion(btn, area, "textos", Object.keys(salida).length ? salida : null);
        });
      })();

      function throw_(area, texto) { area.replaceChildren(h("div", { class: "sa-msj sa-msj-error", role: "alert", texto: texto })); }
    }

    /* =========================== SECRETOS (SOLO ESCRITURA) =========================== */
    var resultadoSecretos = null;
    var CAMPOS_SECRETOS = [
      ["wompi_llave_publica_test", "Wompi · llave pública (pruebas)"], ["wompi_integridad_test", "Wompi · secreto de integridad (pruebas)"], ["wompi_eventos_test", "Wompi · secreto de eventos (pruebas)"], ["wompi_llave_privada_test", "Wompi · llave privada (pruebas)"],
      ["wompi_llave_publica_prod", "Wompi · llave pública (producción)"], ["wompi_integridad_prod", "Wompi · secreto de integridad (producción)"], ["wompi_eventos_prod", "Wompi · secreto de eventos (producción)"], ["wompi_llave_privada_prod", "Wompi · llave privada (producción)"],
      ["callmebot_telefono", "CallMeBot · teléfono (57XXXXXXXXXX)"], ["callmebot_apikey", "CallMeBot · clave (apikey)"]];
    var TEXTO_RESULTADO = { guardado: "Guardado", ya_coincide: "Ya estaba puesto igual", ya_existe_otro_valor: "Ya hay otro valor: marca “Reemplazar” si quieres cambiarlo", repetido_en_otro_restaurante: "Rechazado: otro restaurante ya usa ese valor", no_guardado: "No se guardó (por otro campo)" };

    function tabSecretos(p, mi) {
      var estado = D.secretos || {};
      var entradas = {};
      var filas = h("div");
      var resultado = h("div", { id: "sa-sec-resultado", role: "status" });
      var err = h("div", { role: "alert" });
      p.appendChild(h("div", { class: "sa-msj sa-msj-info" },
        "Los secretos son de SOLO ESCRITURA: esta pantalla nunca los muestra ni los puede leer; solo sabe si hay uno cargado (Sí/No). Si cargas uno distinto donde ya hay uno, se rechaza a menos que marques “Reemplazar”. Un valor que ya usa OTRO restaurante también se rechaza (cada restaurante debe tener los suyos)."));
      CAMPOS_SECRETOS.forEach(function (c) {
        var puesto = estado[c[0]] === true;
        var inp = h("input", { type: "password", id: "sa-sec-" + c[0], autocomplete: "new-password", spellcheck: "false", autocapitalize: "off", maxlength: 300, placeholder: puesto ? "Escribe para reemplazar" : "Escribe para cargar", "aria-label": c[1] });
        entradas[c[0]] = inp;
        filas.appendChild(h("div", { class: "sa-secreto-fila", "data-campo": c[0] },
          h("label", { for: "sa-sec-" + c[0], texto: c[1] }),
          h("span", { class: "sa-pill " + (puesto ? "sa-pill-activo" : "sa-pill-neutro"), "data-puesto": puesto ? "si" : "no", texto: puesto ? "Cargado: Sí" : "Cargado: No" }), inp));
      });
      var modoSel = h("select", { id: "sa-sec-modo" }, h("option", { value: "", texto: "(sin cambios)" }), h("option", { value: "test", texto: "Pruebas (test)" }), h("option", { value: "produccion", texto: "Producción (cobra de verdad)" }));
      var sobre = h("input", { type: "checkbox", id: "sa-sec-sobre" });
      var rep = h("input", { type: "checkbox", id: "sa-sec-rep" });
      var guardar = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "sa-sec-guardar", texto: "Guardar secretos" });
      var modoActual = estado.wompi_modo === "test" ? "Pruebas" : estado.wompi_modo === "produccion" ? "Producción" : "Sin definir";
      function vaciar() { Object.keys(entradas).forEach(function (k) { entradas[k].value = ""; }); modoSel.value = ""; sobre.checked = false; rep.checked = false; }
      alSalirDeTab(vaciar);
      function mostrarResultados(r) {
        var campos = r && r.campos && typeof r.campos === "object" ? r.campos : {};
        var items = Object.keys(campos).map(function (k) {
          var c = CAMPOS_SECRETOS.filter(function (x) { return x[0] === k; })[0];
          return h("li", null, h("span", { texto: c ? c[1] : (k === "wompi_modo" ? "Modo de cobro" : t(k, 50)) }), h("strong", { texto: TEXTO_RESULTADO[campos[k]] || t(campos[k], 60) }));
        });
        resultado.replaceChildren(h("ul", { class: "sa-lista-simple" }, items));
      }
      if (resultadoSecretos) { mostrarResultados(resultadoSecretos); resultadoSecretos = null; }
      guardar.addEventListener("click", function () {
        var valores = {};
        Object.keys(entradas).forEach(function (k) { var v = entradas[k].value.trim(); if (v) valores[k] = v; });
        if (modoSel.value) valores.wompi_modo = modoSel.value;
        var nombres = Object.keys(valores);
        if (!nombres.length) { SA.mostrarError(err, new Error("No escribiste ningún valor para guardar.")); return; }
        var sobrescribir = sobre.checked, repetidos = rep.checked;
        SA.confirmar({ titulo: "¿Guardar estos secretos?", parrafos: ["Se van a guardar " + nombres.length + (nombres.length === 1 ? " valor" : " valores") + " para “" + t(D.nombre, 80) + "”: " + nombres.map(function (k) { return (CAMPOS_SECRETOS.filter(function (x) { return x[0] === k; })[0] || [k, k === "wompi_modo" ? "Modo de cobro" : k])[1]; }).join("; ") + ".",
          modoSel.value === "produccion" ? "OJO: el modo “Producción” cobra de verdad con las llaves de producción." : "Después de guardar, los campos se vacían y los valores no se vuelven a ver."], boton: "Sí, guardar" }).then(function (si) {
          if (!si) { return; }
          SA.enviar(guardar, err, function () {
            resultado.replaceChildren();
            var envio = valores; valores = null;
            Object.keys(entradas).forEach(function (k) { entradas[k].value = ""; });   // se vacian ANTES de esperar la respuesta
            return SA.api("guardar_secretos", { restaurante_id: id, valores: envio, sobrescribir: sobrescribir, permitir_repetidos: repetidos }).then(function (r) {
              envio = null; vaciar();
              SA.aviso("Secretos guardados");
              resultadoSecretos = r;
              return recargar();
            }, function (e) {
              envio = null; vaciar();
              if (e && e.cuerpo && e.cuerpo.campos) mostrarResultados(e.cuerpo);
              throw e;
            });
          });
        });
      });
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Llaves de Wompi y CallMeBot" }), filas,
        h("div", { class: "sa-secreto-fila" }, h("label", { for: "sa-sec-modo", texto: "Modo de cobro de Wompi" }), h("span", { class: "sa-pill sa-pill-neutro", id: "sa-sec-modo-actual", texto: "Ahora: " + modoActual }), modoSel),
        h("div", { class: "sa-fila-check" }, sobre, h("label", { for: "sa-sec-sobre", texto: "Reemplazar valores que ya están cargados" })),
        h("div", { class: "sa-fila-check" }, rep, h("label", { for: "sa-sec-rep", texto: "Permitir teléfono/clave de CallMeBot que ya use otro restaurante" })),
        err, h("div", { class: "sa-acciones" }, guardar), resultado));
    }

    /* =========================== ENTRAR COMO / AUDITORIA =========================== */
    function tabEntrar(p) {
      var btn = h("button", { type: "button", class: "sa-btn sa-btn-primario", id: "sa-entrar-ir", texto: "Mirar este restaurante (solo lectura)" });
      btn.addEventListener("click", function () { SA.ir("lectura", { id: id, nombre: D.nombre }); });
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Entrar como (solo lectura)" }),
        h("p", { texto: "Te deja MIRAR lo que ve el restaurante: resumen, pedidos, menú y configuración. No puedes cambiar nada, no usas la sesión de nadie y no se abre su panel." }),
        h("div", { class: "sa-msj sa-msj-aviso", texto: "Cada vez que miras un restaurante queda una constancia en la auditoría (quién, cuándo y qué sección; nunca los datos de los clientes). Los pedidos incluyen nombres, teléfonos y direcciones de clientes: úsalos solo para dar soporte." }), btn));
    }
    function tabAuditoria(p, mi) {
      p.appendChild(h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Auditoría de este restaurante" }), SA.listaAuditoria(id, n)));
    }

    /* ---- arranque ---- */
    pintarTabs();
    cabecera.appendChild(h("h1", { texto: "Cargando…" }));
    cargar().then(function (ok) { if (ok) pintarTab(); }).catch(function (e) {
      if (!SA.vigente(n)) return;
      cabecera.replaceChildren(h("h1", { texto: "Restaurante" }), h("button", { type: "button", class: "sa-btn", texto: "← Restaurantes", onclick: function () { SA.ir("lista"); } }));
      SA.mostrarError(errorArea, e.status === 404 ? new Error("No existe ese restaurante.") : e);
    });
  };
})();
