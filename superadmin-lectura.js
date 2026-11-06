/* =============================================================
   "ENTRAR COMO": SOLO LECTURA  (superadmin.html, fase 5; docs seccion 24)

   Esta vista MIRA un restaurante; no suplanta a nadie, no usa su sesion y no abre su panel.
   REGLAS (las pruebas las vigilan):
     * Solo llama a SA.apiLectura, que SOLO deja pasar ver_resumen, ver_pedidos, ver_menu y ver_config.
     * No tiene formularios, campos de texto ni selectores: solo botones de navegacion y de "cargar mas".
     * Una franja FIJA arriba dice siempre que es solo lectura y de quien.
     * Todo dato (nombre de producto, opciones, clientes, direcciones) se pinta con textContent; los items de los pedidos
       llegan SIN sanear (docs 22.17 H10) y se leen de forma defensiva.
     * Sin enlaces: ningun elemento de esta vista abre el panel del restaurante ni otra pagina.
============================================================= */
(function () {
  "use strict";
  var SA = window.SA, h = SA.h, t = SA.t;

  var ETIQUETA_PEDIDO = { pendiente_pago: "Pendiente de pago", nuevo: "Nuevo", en_preparacion: "En preparación", listo: "Listo", entregado: "Entregado", cancelado: "Cancelado" };
  var ETIQUETA_TIPO = { domicilio: "Domicilio", llevar: "Para llevar", local: "En el local" };

  /* Aplana un objeto cualquiera a lineas "ruta: valor" (texto), con topes, para mostrar la configuracion sin conocer su forma. */
  function aplanar(valor, ruta, salida, nivel) {
    if (salida.length >= 250) return;
    if (valor !== null && typeof valor === "object") {
      if (nivel >= 5) { salida.push([ruta, t(valor, 200)]); return; }
      Object.keys(valor).slice(0, 80).forEach(function (k) { aplanar(valor[k], ruta ? ruta + " › " + k : k, salida, nivel + 1); });
      return;
    }
    salida.push([ruta, valor === null ? "—" : t(valor, 300)]);
  }

  SA.vistas.lectura = function (cont, params, n) {
    var id = params.id;
    var nombre = params.nombre || "este restaurante";
    var tab = "resumen";
    var errorArea = h("div");
    var panel = h("div", { role: "tabpanel", id: "sa-lec-panel" });
    var tablist = h("div", { class: "sa-pestanas", role: "tablist", "aria-label": "Qué mirar" });

    document.body.classList.add("sa-en-lectura");
    SA.ocultarBarra(true);

    var salir = h("button", { type: "button", id: "sa-lec-salir", "data-salida": "1", texto: "Salir de esta vista" });
    salir.addEventListener("click", function () { SA.ir("detalle", { id: id, tab: "entrar" }); });
    var franjaNombre = h("span", { id: "sa-lec-nombre", texto: t(nombre, 100) });
    var franja = h("div", { class: "sa-franja-lectura", id: "sa-franja-lectura", role: "region", "aria-label": "Modo de solo lectura" },
      h("span", null, "Modo solo lectura: estás viendo ", h("strong", null, franjaNombre), ". No puedes cambiar nada aquí."), salir);

    var cuerpo = h("div", { class: "sa-contenedor sa-contenedor-lectura" },
      h("p", { class: "sa-tenue sa-chico", texto: "Cada consulta queda registrada en la auditoría (quién, cuándo y qué sección; nunca los datos de los clientes)." }),
      errorArea, tablist, panel);
    cont.appendChild(franja); cont.appendChild(cuerpo);
    SA.alSalirDeVista(function () { franja.remove(); });

    var TABS = [["resumen", "Resumen"], ["pedidos", "Pedidos"], ["menu", "Menú"], ["config", "Configuración"]];
    var cargando = 0;
    function pintarTabs() {
      tablist.replaceChildren();
      TABS.forEach(function (p) {
        var b = h("button", { type: "button", role: "tab", "data-lectura": p[0], "aria-selected": tab === p[0] ? "true" : "false", "aria-controls": "sa-lec-panel", texto: p[1] });
        b.addEventListener("click", function () { tab = p[0]; pintarTabs(); mostrar(); });
        tablist.appendChild(b);
      });
    }
    function mostrar() {
      var mi = ++cargando;
      errorArea.replaceChildren();
      panel.replaceChildren(h("p", { class: "sa-vacio", texto: "Cargando…" }));
      var f = { resumen: verResumen, pedidos: verPedidos, menu: verMenu, config: verConfig }[tab];
      f(function () { return SA.vigente(n) && mi === cargando; });
    }
    function fallo(e) { panel.replaceChildren(); SA.mostrarError(errorArea, e); }
    function kpi(etiqueta, valor) { return h("div", { class: "sa-kpi" }, h("span", { class: "sa-tenue sa-chico", texto: etiqueta }), h("b", { texto: String(valor) })); }

    /* ---------------- resumen ---------------- */
    function verResumen(vivo) {
      SA.apiLectura("ver_resumen", { restaurante_id: id }).then(function (r) {
        if (!vivo()) return;
        var s = r.resumen || {}, j = s.jornada || {}, m = s.mes || {}, c = s.catalogo || {}, rest = s.restaurante || {};
        if (rest.nombre) franjaNombre.textContent = t(rest.nombre, 100);
        var porEstado = j.por_estado && typeof j.por_estado === "object" ? j.por_estado : {};
        panel.replaceChildren(
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Jornada de hoy" }),
            h("div", { class: "sa-kpis" }, kpi("Pedidos", j.pedidos), kpi("Vendidos", j.vendidos), kpi("Ventas", SA.pesos(j.ventas)), kpi("Ticket promedio", SA.pesos(j.ticket_promedio)), kpi("Cancelados", j.cancelados)),
            h("ul", { class: "sa-lista-simple" }, Object.keys(porEstado).map(function (k) { return h("li", null, h("span", { texto: ETIQUETA_PEDIDO[k] || t(k, 40) }), h("strong", { texto: String(porEstado[k]) })); }))),
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Este mes" }),
            h("div", { class: "sa-kpis" }, kpi("Pedidos", m.pedidos), kpi("Vendidos", m.vendidos), kpi("Ventas", SA.pesos(m.ventas)), kpi("Cancelados", m.cancelados)),
            h("p", { class: "sa-ayuda", texto: "Del " + SA.fecha.corta(m.desde) + " al " + SA.fecha.corta(m.hasta) + " (zona " + t(m.zona_horaria, 40) + ")." })),
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Catálogo" }),
            h("div", { class: "sa-kpis" }, kpi("Categorías", c.categorias), kpi("Productos", c.productos), kpi("Disponibles", c.productos_disponibles), kpi("Personas con acceso", c.miembros_activos))));
      }, function (e) { if (vivo()) fallo(e); });
    }

    /* ---------------- pedidos ---------------- */
    /* Una opcion "quitar" ya trae el "Sin" en su nombre ("Sin tocineta", como lo escribio el dueno): no se le agrega otro.
       Si el nombre no empieza por "sin" (cualquier mayuscula), se le antepone una sola vez. Los extras: "+ Tocineta extra (+$ 3.000)". */
    function lineaOpcion(o) {
      if (o === null || typeof o !== "object") return t(o, 80);
      var nombre = t(o.nombre, 80).trim();
      if (o.tipo === "quitar") {
        var ya = /^sin(?:\s+([\s\S]*))?$/i.exec(nombre);
        if (ya) return ya[1] ? "Sin " + ya[1] : "Sin";
        return nombre ? "Sin " + nombre : "Sin";
      }
      return "+ " + nombre + (typeof o.precio === "number" && o.precio > 0 ? " (+" + SA.pesos(o.precio) + ")" : "");
    }
    function pintarItems(items) {
      if (!Array.isArray(items)) return h("p", { class: "sa-tenue", texto: items === null || items === undefined ? "Sin productos" : t(items, 200) });
      var ul = h("ul");
      items.slice(0, 100).forEach(function (it) {
        if (it === null || typeof it !== "object" || Array.isArray(it)) { ul.appendChild(h("li", { texto: t(it, 200) })); return; }
        var cant = typeof it.cantidad === "number" ? it.cantidad + " × " : "";
        var li = h("li", null, h("span", { texto: cant + t(it.nombre, 120) + (typeof it.precio === "number" ? " — " + SA.pesos(it.precio) : "") }));
        if (Array.isArray(it.opciones) && it.opciones.length) li.appendChild(h("div", { class: "sa-chico sa-tenue", texto: it.opciones.slice(0, 30).map(lineaOpcion).join(" · ") }));
        ul.appendChild(li);
      });
      if (items.length > 100) ul.appendChild(h("li", { class: "sa-tenue", texto: "…y " + (items.length - 100) + " más" }));
      return ul;
    }
    function tarjetaPedido(p) {
      var datosCliente = [["Nombre", p.cliente_nombre], ["Teléfono", p.cliente_telefono], ["Correo", p.cliente_email], ["Dirección", p.direccion], ["Barrio", p.barrio], ["Indicaciones", p.indicaciones]]
        .filter(function (x) { return x[1]; }).map(function (x) { return h("div", null, h("span", { class: "sa-tenue", texto: x[0] + ": " }), h("span", { texto: t(x[1], 300) })); });
      return h("article", { class: "sa-pedido", "data-pedido": String(p.id) },
        h("div", { class: "sa-cabecera-vista" },
          h("strong", { texto: "Pedido " + (p.numero !== null && p.numero !== undefined ? "#" + t(p.numero, 12) : t(p.id, 12)) }),
          h("span", null, h("span", { class: "sa-pill sa-pill-neutro", texto: ETIQUETA_PEDIDO[p.estado] || t(p.estado, 30) }), " ", h("span", { class: "sa-pill sa-pill-neutro", texto: "Pago: " + t(p.estado_pago, 30) }))),
        h("div", { class: "sa-chico sa-tenue", texto: SA.fecha.hora(p.creado_en) + " · " + (ETIQUETA_TIPO[p.tipo_pedido] || t(p.tipo_pedido, 30)) + (p.referencia ? " · ref. " + t(p.referencia, 60) : "") }),
        pintarItems(p.items),
        h("p", null, h("strong", { texto: "Total " + SA.pesos(p.total) }), p.costo_domicilio ? h("span", { class: "sa-tenue", texto: " (domicilio " + SA.pesos(p.costo_domicilio) + ")" }) : null),
        datosCliente.length ? h("div", { class: "sa-chico" }, datosCliente) : null);
    }
    function verPedidos(vivo) {
      var modo = "jornada", lista = h("div"), mas = h("button", { type: "button", class: "sa-btn", "data-lectura": "mas", texto: "Cargar más antiguos", hidden: true });
      var info = h("p", { class: "sa-ayuda" }), err = h("div");
      var siguiente = null, total = 0;
      var bJ = h("button", { type: "button", "data-lectura": "modo-jornada", "aria-pressed": "true", texto: "Jornada actual" });
      var bR = h("button", { type: "button", "data-lectura": "modo-recientes", "aria-pressed": "false", texto: "Recientes (todas las jornadas)" });
      var ocupado = false;
      function traer(reiniciar) {
        if (ocupado) return;
        ocupado = true;
        if (reiniciar) { lista.replaceChildren(h("p", { class: "sa-vacio", texto: "Cargando…" })); siguiente = null; total = 0; mas.hidden = true; }
        var datos = { restaurante_id: id, modo: modo, limite: 25 };
        if (!reiniciar && siguiente) datos.antes_de = siguiente;
        err.replaceChildren();
        SA.apiLectura("ver_pedidos", datos).then(function (r) {
          ocupado = false;
          if (!vivo()) return;
          if (reiniciar) lista.replaceChildren();
          var ps = Array.isArray(r.pedidos) ? r.pedidos : [];
          ps.forEach(function (p) { lista.appendChild(tarjetaPedido(p)); });
          total += ps.length;
          siguiente = r.hay_mas ? r.siguiente : null;
          mas.hidden = !r.hay_mas;
          info.textContent = (r.jornada && r.jornada.fecha ? "Jornada del " + SA.fecha.corta(r.jornada.fecha) + " (corte " + t(r.jornada.hora_corte, 10) + "). " : "") + "Mostrando " + total + (total === 1 ? " pedido." : " pedidos.");
          if (!total) lista.replaceChildren(h("p", { class: "sa-vacio", texto: "No hay pedidos para mostrar." }));
        }, function (e) { ocupado = false; if (vivo()) { lista.replaceChildren(); SA.mostrarError(err, e); } });
      }
      function elegir(m) { modo = m; bJ.setAttribute("aria-pressed", m === "jornada" ? "true" : "false"); bR.setAttribute("aria-pressed", m === "recientes" ? "true" : "false"); traer(true); }
      bJ.addEventListener("click", function () { elegir("jornada"); });
      bR.addEventListener("click", function () { elegir("recientes"); });
      mas.addEventListener("click", function () { traer(false); });
      panel.replaceChildren(h("div", { class: "sa-chips", role: "group", "aria-label": "Qué pedidos" }, bJ, bR), info, err, lista, h("p", null, mas));
      traer(true);
    }

    /* ---------------- menu ---------------- */
    function verMenu(vivo) {
      SA.apiLectura("ver_menu", { restaurante_id: id }).then(function (r) {
        if (!vivo()) return;
        var m = r.menu || {}, cats = Array.isArray(m.categorias) ? m.categorias : [], prods = Array.isArray(m.productos) ? m.productos : [], ops = Array.isArray(m.opciones) ? m.opciones : [];
        var opsPorProd = {};
        ops.forEach(function (o) { (opsPorProd[o.producto_id] = opsPorProd[o.producto_id] || []).push(o); });
        var usados = {};
        var bloques = cats.map(function (c) {
          var mios = prods.filter(function (p) { return String(p.categoria) === String(c.id); });
          mios.forEach(function (p) { usados[p.id] = true; });
          return bloqueCategoria(c.emoji ? t(c.emoji, 8) + " " + t(c.nombre, 80) : t(c.nombre, 80), mios, opsPorProd, c.activa === false);
        });
        var sueltos = prods.filter(function (p) { return !usados[p.id]; });
        if (sueltos.length) bloques.push(bloqueCategoria("Sin categoría", sueltos, opsPorProd, false));
        var hijos = [];
        if (m.truncado) hijos.push(h("div", { class: "sa-msj sa-msj-aviso", texto: "El menú es muy grande: se muestra solo una parte (hay " + t(m.totales && m.totales.productos, 10) + " productos)." }));
        hijos.push(h("p", { class: "sa-ayuda", texto: "Incluye lo inactivo y lo agotado. " + prods.length + " productos en " + cats.length + " categorías." }));
        if (bloques.length) bloques.forEach(function (b) { hijos.push(b); });
        else hijos.push(h("p", { class: "sa-vacio", texto: "Este restaurante todavía no tiene menú." }));
        panel.replaceChildren.apply(panel, hijos);
      }, function (e) { if (vivo()) fallo(e); });
    }
    function bloqueCategoria(titulo, prods, opsPorProd, inactiva) {
      return h("div", { class: "sa-tarjeta" }, h("h2", null, titulo, inactiva ? h("span", { class: "sa-pill sa-pill-neutro", texto: "Categoría apagada" }) : null),
        prods.length ? h("ul", { class: "sa-lista-simple" }, prods.map(function (p) {
          var os = opsPorProd[p.id] || [];
          return h("li", null,
            h("span", null, h("strong", { texto: t(p.nombre, 120) }), p.descripcion ? h("div", { class: "sa-chico sa-tenue", texto: t(p.descripcion, 300) }) : null,
              os.length ? h("div", { class: "sa-chico sa-tenue", texto: "Opciones: " + os.slice(0, 40).map(function (o) { return (o.activa === false ? "(apagada) " : "") + lineaOpcion(o); }).join(" · ") }) : null),
            h("span", null, h("strong", { texto: SA.pesos(p.precio) }), " ", p.disponible === false ? h("span", { class: "sa-pill sa-pill-vencido", texto: "Agotado" }) : null));
        })) : h("p", { class: "sa-tenue", texto: "Sin productos." }));
    }

    /* ---------------- configuracion ---------------- */
    function verConfig(vivo) {
      SA.apiLectura("ver_config", { restaurante_id: id }).then(function (r) {
        if (!vivo()) return;
        var c = r.restaurante || {};
        if (c.nombre) franjaNombre.textContent = t(c.nombre, 100);
        var secretos = c.secretos && typeof c.secretos === "object" ? c.secretos : {};
        var lineas = []; aplanar(c.config || {}, "", lineas, 0);
        var horario = []; aplanar(c.horario || {}, "", horario, 0);
        panel.replaceChildren(
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Datos generales" }), h("dl", { class: "sa-datos" },
            h("div", null, h("dt", { texto: "Nombre" }), h("dd", { texto: t(c.nombre, 120) })), h("div", null, h("dt", { texto: "Nombre corto" }), h("dd", { texto: t(c.slug, 60) })),
            h("div", null, h("dt", { texto: "Estado" }), h("dd", null, SA.pill(SA.estadoDe(c)), " ", SA.textoVigencia(c))),
            h("div", null, h("dt", { texto: "Plan" }), h("dd", { texto: (SA.etiquetas.plan[c.plan] || t(c.plan, 20)) + " · " + (SA.etiquetas.modalidad[c.modalidad_pago] || t(c.modalidad_pago, 20)) })),
            h("div", null, h("dt", { texto: "Dominios" }), h("dd", { texto: (c.dominios || []).map(function (d) { return t(d, 120); }).join(", ") || "Ninguno" })))),
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Personas con acceso" }),
            h("ul", { class: "sa-lista-simple" }, (c.miembros || []).map(function (m) { return h("li", null, h("span", { texto: t(m.email || "(sin correo)", 120) }), h("span", { texto: t(m.rol, 20) + (m.activo === false ? " (inactivo)" : "") })); }))),
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Tarifas de domicilio" }),
            (c.tarifas || []).length ? h("ul", { class: "sa-lista-simple" }, c.tarifas.map(function (x) { return h("li", null, h("span", { texto: "Hasta " + t(x.hasta, 10) + " km" }), h("span", { texto: x.precio === null ? "Fuera de cobertura" : SA.pesos(x.precio) })); })) : h("p", { class: "sa-tenue", texto: "Sin tarifas." })),
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Horario" }), lista(horario)),
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Secretos cargados (sí/no)" }),
            h("ul", { class: "sa-lista-simple" }, Object.keys(secretos).map(function (k) { return h("li", null, h("span", { class: "sa-mono", texto: t(k, 60) }), h("span", { texto: typeof secretos[k] === "boolean" ? (secretos[k] ? "Sí" : "No") : t(secretos[k], 20) })); }))),
          h("div", { class: "sa-tarjeta" }, h("h2", { texto: "Configuración pública" }), lista(lineas)));
      }, function (e) { if (vivo()) fallo(e); });
    }
    function lista(pares) {
      if (!pares.length) return h("p", { class: "sa-tenue", texto: "Sin datos." });
      return h("ul", { class: "sa-lista-simple" }, pares.map(function (p) { return h("li", null, h("span", { class: "sa-mono sa-chico", texto: t(p[0], 120) }), h("span", { texto: p[1] })); }));
    }

    pintarTabs();
    mostrar();
  };
})();
