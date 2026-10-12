/* =============================================================
   TICKET DE COMANDA — 80 mm, blanco y negro

   Lo usa panel.html para imprimir la comanda de cada pedido web
   pagado en la termica de la cocina (Chrome en Windows con
   --kiosk-printing, por el driver de Windows).

   COMO FUNCIONA
   El ticket se arma en un iframe oculto y se imprime SOLO ese
   iframe, asi que el resto del panel nunca sale en el papel.

   REGLAS QUE ESTE ARCHIVO NO DEBE ROMPER
     * Todo texto que viene de la base o del cliente entra por
       textContent. Jamas se arma HTML con esos datos.
     * Sin emojis ni simbolos raros: una termica no los imprime bien.
     * Sin imagenes ni fondos: solo texto negro sobre blanco.
     * Un ticket = un trabajo de impresion = una pagina, sin blanco
       sobrante: el alto de la hoja se ajusta al contenido.
============================================================= */
(function (global) {
  "use strict";

  /* Rollo de 80 mm. La zona imprimible de estas termicas ronda los
     72 mm; el contenido se centra en ese ancho y deja ~4 mm a cada
     lado para que el driver no recorte nada. */
  const ANCHO_PAGINA_MM = 80;
  const ANCHO_UTIL_MM = 72;

  /* MARGENES. La pagina va con @page{margin:0}: es lo que impide que
     Chrome dibuje su encabezado (fecha y titulo) y su pie (URL y
     numero de pagina), que viven en el margen de pagina. Como ese
     margen es 0, el aire del ticket es del CONTENIDO:
       * lateral: la columna de 72 mm va centrada en los 80 mm (4 mm
         por lado). Se centra en vez de rellenar con padding para que,
         si el driver recorta la zona imprimible a 72 mm, la columna
         siga entera en lugar de encogerse a 64 mm.
       * superior e inferior: padding del body, en estas constantes. */
  const MARGEN_SUPERIOR_MM = 3;

  /* Papel en blanco debajo de la ultima linea. El driver ya alimenta
     el papel hasta la cuchilla antes de cortar, asi que esto solo es
     aire: mas margen = mas papel desperdiciado en cada ticket. Si algun
     dia el corte se come "LOS TAQUEIROS · PEDIDO WEB", subir ESTE valor
     (probar 8) y nada mas. */
  const MARGEN_INFERIOR_MM = 4;

  /* Tope razonable: un ticket mas largo se parte en paginas en vez de
     pedirle al driver una hoja imposible. */
  const ALTO_MAXIMO_MM = 1500;

  const PX_POR_MM = 96 / 25.4;

  /* TAMANO DEL TEXTO. Todas las fuentes del ticket se escriben con el
     tamano de "Grande" (el diseno original) multiplicado por la
     variable CSS --escala. Los bordes y separadores no se escalan. */
  const ESCALAS = { pequeno: 0.75, normal: 0.85, grande: 1 };
  const TAMANO_POR_DEFECTO = "normal";

  /* Se guarda por equipo: la impresora de la cocina decide el tamano,
     no el cliente ni el resto de pantallas. */
  const TAMANO_KEY = "taqueiros-panel-ticket-tamano-v1";

  const TIPOS = {
    domicilio: "DOMICILIO",
    llevar: "PARA LLEVAR",
    local: "EN EL LOCAL"
  };

  const METODOS_PAGO = {
    CARD: "Tarjeta",
    NEQUI: "Nequi",
    PSE: "PSE",
    BANCOLOMBIA_TRANSFER: "Transferencia Bancolombia",
    BANCOLOMBIA_COLLECT: "Bancolombia",
    BANCOLOMBIA_QR: "QR Bancolombia",
    DAVIPLATA: "Daviplata",
    PCOL: "Puntos Colombia",
    SU_PLUS: "Su+ Pay"
  };

  /* ---------- Texto plano seguro para una termica ---------- */

  /* Emojis, flechas, simbolos y dingbats; selectores de variacion y
     uniones de emoji; marcas invisibles y de direccion. */
  const SIMBOLOS = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{20E3}\u{FEFF}\u{E0020}-\u{E007F}]/gu;
  const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

  /* Espacios que no son el normal: duro, de cifra, fino y fino estrecho. */
  const NBSP = String.fromCharCode(0xA0);
  const ESPACIOS_RAROS = new RegExp("[" + String.fromCharCode(0xA0, 0x2007, 0x2009, 0x202F) + "]", "g");

  /* limpiarTexto(valor)               -> una sola linea
     limpiarTexto(valor, {saltos:true}) -> conserva los saltos de linea */
  function limpiarTexto(valor, opciones) {
    if (valor === null || valor === undefined) return "";
    let s = String(valor);
    try { s = s.normalize("NFC"); } catch (e) { /* motor sin normalize */ }
    s = s.replace(SIMBOLOS, "")
         .replace(ESPACIOS_RAROS, " ")
         .replace(CONTROL, " ");
    if (opciones && opciones.saltos) {
      s = s.replace(/\r\n?/g, "\n")
           .split("\n")
           .map(l => l.replace(/[ \t]+/g, " ").trim())
           .join("\n")
           .replace(/\n{3,}/g, "\n\n")
           .trim();
    } else {
      s = s.replace(/\s+/g, " ").trim();
    }
    return s;
  }

  function pesos(n) {
    return "$" + Number(n || 0).toLocaleString("es-CO");
  }

  function numeroPedido(p) {
    return "#" + String(p.id).padStart(3, "0");
  }

  function telefonoBonito(t) {
    const s = limpiarTexto(t);
    return /^\d{10}$/.test(s) ? s.slice(0, 3) + " " + s.slice(3, 6) + " " + s.slice(6) : s;
  }

  function fechaHora(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return limpiarTexto(d.toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true
    }));
  }

  function nombreMetodoPago(m) {
    const clave = limpiarTexto(m).toUpperCase();
    if (!clave) return "Pago en línea";
    return METODOS_PAGO[clave] || limpiarTexto(m);
  }

  /* "DOMICILIO · WEB · PAGADO". Si no cabe en una linea, el salto cae
     SIEMPRE despues del tipo ("DOMICILIO ·" / "WEB · PAGADO") y no deja
     un punto colgando al final ni parte "PARA LLEVAR" en dos: los
     espacios internos son duros (U+00A0). Con espacios normales
     entre ellos quedaria "DOMICILIO · WEB ·" / "PAGADO". */
  function franja(tipo) {
    const duro = (t) => t.split(" ").join(NBSP);
    return duro(TIPOS[tipo]) + NBSP + "· " + duro("WEB · PAGADO");
  }

  /* ---------- De pedido a datos del ticket ---------- */

  /* Funcion pura: no toca el DOM. opciones:
       reimpresion   true  -> marca "REIMPRESIÓN"
       numeroReimpresion  n de esta reimpresion (opcional)
       impresoEn     momento de la impresion original (opcional)
       prueba        true  -> marca "TICKET DE PRUEBA" */
  function preparar(pedido, opciones) {
    const op = opciones || {};
    const p = pedido || {};
    const tipo = TIPOS[p.tipo_pedido] ? p.tipo_pedido : "domicilio";

    const items = (Array.isArray(p.items) ? p.items : []).map(it => {
      const cant = Math.max(0, Math.floor(Number(it && it.cantidad) || 0));
      const nota = limpiarTexto(
        it && (it.nota || it.notas || it.observacion || it.observaciones || it.indicaciones),
        { saltos: true });
      return {
        cantidad: cant,
        nombre: limpiarTexto(it && it.nombre) || "(sin nombre)",
        nota: nota
      };
    });

    const costoDomicilio = Number(p.costo_domicilio) || 0;
    const subtotal = p.subtotal != null ? Number(p.subtotal) : Number(p.total || 0) - costoDomicilio;

    let marca = "";
    if (op.prueba) marca = "TICKET DE PRUEBA";
    else if (op.reimpresion) marca = "REIMPRESIÓN";

    return {
      marca: marca,
      numeroReimpresion: op.reimpresion && op.numeroReimpresion ? Number(op.numeroReimpresion) : 0,
      impresoEn: op.reimpresion ? fechaHora(op.impresoEn) : "",
      franja: franja(tipo),
      esDomicilio: tipo === "domicilio",
      numero: numeroPedido(p),
      fecha: fechaHora(p.pagado_en || p.creado_en),
      cliente: limpiarTexto(p.cliente_nombre),
      telefono: telefonoBonito(p.cliente_telefono),
      direccion: limpiarTexto(p.direccion),
      barrio: limpiarTexto(p.barrio),
      distanciaKm: p.distancia_km != null ? String(p.distancia_km) : "",
      fueraDeCobertura: !!p.fuera_de_cobertura,
      verificarUbicacion: limpiarTexto(p.ubicacion_sospechosa),
      items: items,
      notas: limpiarTexto(p.indicaciones, { saltos: true }),
      costoDomicilio: costoDomicilio,
      subtotal: subtotal,
      total: Number(p.total || 0),
      metodoPago: nombreMetodoPago(p.wompi_metodo_pago)
    };
  }

  /* ---------- Hoja del ticket ---------- */

  /* esc(px, unidad): tamano de "Grande" * --escala. */
  const esc = (px, unidad) => "calc(" + px + (unidad || "px") + " * var(--escala))";

  const ESTILOS = [
    ":root{--escala:" + ESCALAS[TAMANO_POR_DEFECTO] + ";}",
    "*{box-sizing:border-box;margin:0;padding:0;}",
    "html,body{background:#fff;color:#000;}",
    "body{width:" + ANCHO_UTIL_MM + "mm;margin:0 auto;",
    "  padding:" + MARGEN_SUPERIOR_MM + "mm 0 " + MARGEN_INFERIOR_MM + "mm;",
    "  font-family:Arial,'Helvetica Neue',Helvetica,'Liberation Sans','DejaVu Sans',sans-serif;",
    "  font-size:" + esc(14) + ";line-height:1.25;",
    "  -webkit-print-color-adjust:exact;print-color-adjust:exact;}",
    ".marca{text-align:center;font-weight:900;font-size:" + esc(20) + ";letter-spacing:.06em;",
    "  border:3px solid #000;padding:3px 2px;margin-bottom:5px;}",
    ".franja{text-align:center;font-weight:900;font-size:" + esc(21) + ";line-height:1.15;overflow-wrap:break-word;",
    "  border-top:3px solid #000;border-bottom:3px solid #000;padding:5px 2px;margin-bottom:6px;}",
    ".numero{text-align:center;font-weight:900;font-size:" + esc(46) + ";line-height:1.05;}",
    ".fecha{text-align:center;font-size:" + esc(14) + ";font-weight:700;margin:1px 0 7px;}",
    ".bloque{margin:3px 0;overflow-wrap:break-word;}",
    ".etq{display:block;font-size:" + esc(11) + ";font-weight:700;letter-spacing:.08em;text-transform:uppercase;}",
    ".val{display:block;font-size:" + esc(15) + ";font-weight:700;overflow-wrap:break-word;}",
    ".val.grande{font-size:" + esc(18) + ";font-weight:700;}",
    ".aviso{border:2px solid #000;padding:3px 4px;margin:5px 0;font-size:" + esc(13) + ";font-weight:900;",
    "  text-transform:uppercase;overflow-wrap:break-word;}",
    ".sep{border-top:2px dashed #000;margin:8px 0;}",
    ".item{display:flex;gap:7px;align-items:flex-start;margin:6px 0;}",
    ".item .cant{flex:0 0 auto;min-width:" + esc(10, "mm") + ";font-size:" + esc(28) + ";font-weight:900;line-height:1;}",
    ".item .cuerpo{flex:1 1 auto;min-width:0;}",
    ".item .nom{font-size:" + esc(18) + ";font-weight:700;line-height:1.15;overflow-wrap:break-word;}",
    ".item .nota{font-size:" + esc(13) + ";font-weight:400;margin-top:2px;white-space:pre-line;overflow-wrap:break-word;}",
    ".notas{font-size:" + esc(15) + ";font-weight:700;white-space:pre-line;overflow-wrap:break-word;}",
    ".linea-monto{display:flex;justify-content:space-between;gap:6px;font-size:" + esc(14) + ";font-weight:700;margin:2px 0;}",
    ".total{display:flex;justify-content:space-between;align-items:baseline;gap:6px;",
    "  font-size:" + esc(24) + ";font-weight:900;margin-top:4px;}",
    ".pago{font-size:" + esc(14) + ";font-weight:700;margin-top:4px;}",
    ".pie{text-align:center;font-size:" + esc(12) + ";font-weight:700;margin-top:8px;",
    "  border-top:2px solid #000;padding-top:4px;}",
    ".pie .chico{display:block;font-weight:400;margin-top:2px;}"
  ].join("\n");

  const PLANTILLA =
    "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"utf-8\">" +
    "<title>Comanda</title>" +
    "<style id=\"estilos-ticket\">" + ESTILOS + "</style>" +
    "<style id=\"pagina-ticket\">@page{size:" + ANCHO_PAGINA_MM + "mm 200mm;margin:0;}</style>" +
    "</head><body></body></html>";

  /* Crea un elemento con texto plano. NUNCA usa innerHTML. */
  function el(doc, etiqueta, clase, texto) {
    const e = doc.createElement(etiqueta);
    if (clase) e.className = clase;
    if (texto !== undefined && texto !== null && texto !== "") e.textContent = texto;
    return e;
  }

  function campo(doc, etiqueta, valor, claseValor) {
    const b = el(doc, "div", "bloque");
    b.appendChild(el(doc, "span", "etq", etiqueta));
    b.appendChild(el(doc, "span", "val" + (claseValor ? " " + claseValor : ""), valor));
    return b;
  }

  function lineaMonto(doc, texto, monto) {
    const l = el(doc, "div", "linea-monto");
    l.appendChild(el(doc, "span", "", texto));
    l.appendChild(el(doc, "span", "", monto));
    return l;
  }

  /* Dibuja el ticket dentro de doc.body (la deja vacia antes). */
  function pintar(doc, d) {
    const body = doc.body;
    while (body.firstChild) body.removeChild(body.firstChild);

    if (d.marca) {
      const m = el(doc, "div", "marca", d.marca);
      body.appendChild(m);
    }

    body.appendChild(el(doc, "div", "franja", d.franja));
    body.appendChild(el(doc, "div", "numero", d.numero));
    if (d.fecha) body.appendChild(el(doc, "div", "fecha", d.fecha));

    if (d.cliente) body.appendChild(campo(doc, "Cliente", d.cliente, "grande"));
    if (d.telefono) body.appendChild(campo(doc, "Teléfono", d.telefono));

    if (d.esDomicilio) {
      const dir = d.direccion || "(sin dirección)";
      body.appendChild(campo(doc, "Dirección", dir));
      if (d.barrio) body.appendChild(campo(doc, "Barrio", d.barrio));
      if (d.fueraDeCobertura) {
        body.appendChild(el(doc, "div", "aviso",
          "Fuera de zona: cobrar domicilio aparte" + (d.distanciaKm ? " (" + d.distanciaKm + " km)" : "")));
      }
      if (d.verificarUbicacion) {
        body.appendChild(el(doc, "div", "aviso", "Verificar ubicación: " + d.verificarUbicacion));
      }
    }

    body.appendChild(el(doc, "div", "sep"));

    d.items.forEach(it => {
      const fila = el(doc, "div", "item");
      fila.appendChild(el(doc, "div", "cant", it.cantidad + "x"));
      const cuerpo = el(doc, "div", "cuerpo");
      cuerpo.appendChild(el(doc, "div", "nom", it.nombre));
      if (it.nota) cuerpo.appendChild(el(doc, "div", "nota", it.nota));
      fila.appendChild(cuerpo);
      body.appendChild(fila);
    });

    body.appendChild(el(doc, "div", "sep"));

    if (d.notas) {
      body.appendChild(el(doc, "span", "etq", "Notas del pedido"));
      body.appendChild(el(doc, "div", "notas", d.notas));
      body.appendChild(el(doc, "div", "sep"));
    }

    if (d.costoDomicilio > 0) {
      body.appendChild(lineaMonto(doc, "Productos", pesos(d.subtotal)));
      body.appendChild(lineaMonto(doc,
        "Domicilio" + (d.distanciaKm ? " (" + d.distanciaKm + " km)" : ""), pesos(d.costoDomicilio)));
    }

    const total = el(doc, "div", "total");
    total.appendChild(el(doc, "span", "", "TOTAL"));
    total.appendChild(el(doc, "span", "", pesos(d.total)));
    body.appendChild(total);

    body.appendChild(el(doc, "div", "pago", "Pago: " + d.metodoPago + " · PAGADO"));

    const pie = el(doc, "div", "pie", "LOS TAQUEIROS · PEDIDO WEB");
    if (d.marca === "REIMPRESIÓN") {
      pie.appendChild(el(doc, "span", "chico",
        "Reimpresión" + (d.numeroReimpresion ? " " + d.numeroReimpresion : "")));
      if (d.impresoEn) {
        pie.appendChild(el(doc, "span", "chico", "Original impreso: " + d.impresoEn));
      }
    }
    body.appendChild(pie);
  }

  /* ---------- Tamano del texto ---------- */

  function leerTamano() {
    try {
      const v = localStorage.getItem(TAMANO_KEY);
      if (v && Object.prototype.hasOwnProperty.call(ESCALAS, v)) return v;
    } catch (err) { /* almacenamiento bloqueado o inexistente */ }
    return TAMANO_POR_DEFECTO;
  }

  /* true si se guardo; false si el valor no es valido o no se pudo. */
  function guardarTamano(tamano) {
    if (!Object.prototype.hasOwnProperty.call(ESCALAS, tamano)) return false;
    try { localStorage.setItem(TAMANO_KEY, tamano); return true; }
    catch (err) { return false; }
  }

  /* Fija --escala en el documento del ticket. Va ANTES de pintar y de
     ajustarPagina: el alto de la hoja se mide con el texto ya escalado. */
  function aplicarEscala(doc, tamano) {
    const clave = Object.prototype.hasOwnProperty.call(ESCALAS, tamano) ? tamano : TAMANO_POR_DEFECTO;
    doc.documentElement.style.setProperty("--escala", String(ESCALAS[clave]));
    return clave;
  }

  /* Ajusta la hoja al contenido: ancho 80 mm y alto = lo que mide el
     ticket, que ya incluye su margen superior e inferior (padding del
     body). Sin esto el driver usaria su alto por defecto y saldria
     papel en blanco (o un segundo ticket vacio). */
  function ajustarPagina(doc) {
    /* Solo el body: documentElement.scrollHeight nunca baja del alto
       del visor y, si este fuera mayor que el ticket, sobraria papel. */
    const px = Math.max(
      doc.body.scrollHeight,
      Math.ceil(doc.body.getBoundingClientRect().height));
    const mm = Math.min(ALTO_MAXIMO_MM, Math.ceil(px / PX_POR_MM));

    let estilo = doc.getElementById("pagina-ticket");
    if (!estilo) {
      estilo = doc.createElement("style");
      estilo.id = "pagina-ticket";
      doc.head.appendChild(estilo);
    }
    /* html/body con alto fijo y overflow oculto: aunque el motor de
       impresion midiera medio milimetro de mas, no nace una 2a pagina. */
    estilo.textContent =
      "@page{size:" + ANCHO_PAGINA_MM + "mm " + mm + "mm;margin:0;}" +
      "html,body{height:" + mm + "mm;overflow:hidden;}";
    return mm;
  }

  /* ---------- Impresion ---------- */

  /* Imprime UN ticket. Devuelve una promesa que se cumple cuando el
     trabajo ya salio hacia la impresora (o el dialogo se cerro).

     En un equipo SIN --kiosk-printing, window.print() abre el dialogo
     normal de impresion: no se rompe nada, solo hay que confirmarlo. */
  function imprimir(pedido, opciones) {
    return new Promise((resolve, reject) => {
      let marco = null;
      let reglaPadre = null;
      const quitar = () => {
        try { if (marco && marco.parentNode) marco.parentNode.removeChild(marco); } catch (e) { /* ya no esta */ }
        try { if (reglaPadre && reglaPadre.parentNode) reglaPadre.parentNode.removeChild(reglaPadre); } catch (e) { /* ya no esta */ }
      };

      try {
        const datos = preparar(pedido, opciones);
        const tamano = opciones && Object.prototype.hasOwnProperty.call(ESCALAS, opciones.tamano)
          ? opciones.tamano : leerTamano();

        marco = document.createElement("iframe");
        marco.setAttribute("aria-hidden", "true");
        marco.setAttribute("tabindex", "-1");
        marco.title = "Comanda para imprimir";
        /* Fuera de pantalla pero con ancho real: si fuera display:none
           Chrome imprimiria una hoja vacia. */
        marco.style.cssText =
          "position:fixed;left:-9999px;top:0;width:" + ANCHO_PAGINA_MM + "mm;" +
          "height:20mm;border:0;opacity:0;pointer-events:none;";
        document.body.appendChild(marco);

        const doc = marco.contentDocument;
        const ventana = marco.contentWindow;
        doc.open();
        doc.write(PLANTILLA);
        doc.close();

        aplicarEscala(doc, tamano);
        pintar(doc, datos);
        const mm = ajustarPagina(doc);

        /* Cinturon y tirantes contra el encabezado/pie de Chrome: la
           misma regla @page (80 mm, margen 0) tambien en el documento
           que contiene al marco, solo mientras dura la impresion. Si el
           motor de impresion lee la regla del marco, esto no cambia
           nada; si leyera la del documento padre, es la que cuenta. */
        reglaPadre = document.createElement("style");
        reglaPadre.textContent = "@page{size:" + ANCHO_PAGINA_MM + "mm " + mm + "mm;margin:0;}";
        document.head.appendChild(reglaPadre);

        // Un instante para que el motor asiente el diseno antes de imprimir
        setTimeout(() => {
          try {
            ventana.focus();
            ventana.print();   // bloquea hasta que Chrome entrega el trabajo
          } catch (err) {
            quitar();
            reject(err);
            return;
          }
          // El iframe se retira un poco despues: quitarlo de golpe puede
          // cancelar un trabajo que el navegador aun esta enviando.
          setTimeout(() => { quitar(); resolve(); }, 1500);
        }, 60);
      } catch (err) {
        quitar();
        reject(err);
      }
    });
  }

  /* Datos ficticios largos para calibrar la impresora: nombre largo,
     direccion larga, notas, ñ, tildes y una palabra kilometrica. */
  function pedidoDePrueba() {
    return {
      id: 999,
      estado: "nuevo",
      estado_pago: "aprobado",
      tipo_pedido: "domicilio",
      cliente_nombre: "María del Pilar Muñoz Hernández de la Peña",
      cliente_telefono: "3001234567",
      direccion: "Avenida Libertadores Diagonal Santander 12 Norte # 3E-45 Torre 2 Apartamento 1204",
      barrio: "Urbanización Ciudad Jardín Etapa Cinco",
      indicaciones: "Portón negro junto a la droguería. Tocar el timbre, no llamar. " +
        "Sin cebolla ni cilantro, salsa picante aparte. Pidió pa' ñoños: más limón.",
      items: [
        { id: "x1", nombre: "Tacos de Birria con Consomé (orden x3)", cantidad: 2, precio: 24000,
          nota: "Sin cebolla, con mucho limón y tortilla bien doradita" },
        { id: "x2", nombre: "Doriloco Especial Súper Cargado", cantidad: 1, precio: 18000 },
        { id: "x3", nombre: "Agua de Jamaica 500 ml", cantidad: 3, precio: 5000, nota: "Sin hielo" },
        { id: "x4", nombre: "Supercalifragilisticoespialidosoextraordinario", cantidad: 1, precio: 9000 }
      ],
      subtotal: 90000,
      costo_domicilio: 5000,
      total: 95000,
      wompi_metodo_pago: "NEQUI",
      pagado_en: new Date().toISOString(),
      creado_en: new Date().toISOString()
    };
  }

  const api = {
    ANCHO_PAGINA_MM, ANCHO_UTIL_MM, MARGEN_SUPERIOR_MM, MARGEN_INFERIOR_MM,
    ESCALAS, TAMANO_POR_DEFECTO, TAMANO_KEY,
    PLANTILLA, ESTILOS,
    limpiarTexto, preparar, pintar, aplicarEscala, ajustarPagina,
    leerTamano, guardarTamano, imprimir, pedidoDePrueba
  };

  global.TicketComanda = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
