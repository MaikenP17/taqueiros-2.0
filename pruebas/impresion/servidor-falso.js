/* =============================================================
   SERVIDOR DE PRUEBA PARA EL PANEL (sin Supabase real)

   Sirve el sitio del repositorio y, ademas, una base de datos falsa
   en memoria que COMPARTEN todas las pestanas y todos los contextos
   del navegador. Asi se prueba de verdad lo que importa de la
   impresion: dos pantallas peleando por el mismo pedido.

   Lo que simula (lo justo para el panel):
     /api/restaurante el restaurante del dominio (Taqueiros por defecto), armado
                      con el MISMO codigo del servidor (api/_publico.js)
     /__db/consulta   select / update sobre pedidos, configuracion, miembros...
     /__db/rpc        limites_jornada, reclamar_impresion,
                      registrar_reimpresion
     /__db/eventos    Realtime (Server-Sent Events)
     /__admin/*       lo usa el script de pruebas para meter pedidos,
                      cambiar el modo y leer el estado

   reclamar_impresion se comporta como la funcion real del SQL 02:
   solo devuelve true una vez por pedido.

   Modos (POST /__admin/modo):
     columnas:   false -> simula que el SQL 02 NO se ha ejecutado
     esPersonal: false -> simula un usuario que no es personal
============================================================= */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..", "..");
const { construirPublico } = require(path.join(RAIZ, "api", "_publico.js"));

const TAQUEIROS_ID = "00000000-0000-4000-8000-000000000001";
const TARIFAS = [{ hasta: 2, precio: 5000 }, { hasta: 4, precio: 7000 }, { hasta: 6, precio: 9000 },
                 { hasta: 8, precio: 12000 }, { hasta: 999, precio: null }];

function restauranteBase() {
  return {
    id: TAQUEIROS_ID, slug: "taqueiros", nombre: "Los Taqueiros", estado: "activo", plan: "completo",
    vigente_hasta: null, dias_gracia: 5, zona_horaria: "America/Bogota", config: {},
    modulos: { pasarela: true, seguimiento: true, comandas: true, impresion: true }
  };
}
const MOCK = path.join(__dirname, "supabase-falso.js");

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"
};

function crearServidor(opciones) {
  const o = opciones || {};
  const archivosExtra = o.archivos || {};   // ruta -> archivo en disco

  const estado = {
    pedidos: [],
    modo: { columnas: true, esPersonal: true, latenciaRpcMs: 0 },
    restaurante: restauranteBase(),   // lo que devuelve /api/restaurante (se cambia con /__admin/restaurante)
    restauranteFalla: 0,              // cuantas respuestas de /api/restaurante fallan antes de responder bien
    miembros: [{ user_id: "u1", restaurante_id: TAQUEIROS_ID, rol: "dueno", activo: true }],
    configuracion: { id: 1, restaurante_id: TAQUEIROS_ID, cerrado_temporal: false, horarios: [], mensaje_cerrado: null },
    salud: { id: 1, restaurante_id: TAQUEIROS_ID, ultimo_ok: true, fallos_seguidos: 0 },
    consultas: [],         // { tabla, op, filtros } de cada consulta que hace el panel
    rpcs: [],              // { nombre, args }
    canales: [],           // filtros con los que el panel abrio sus canales de Realtime
    reclamos: [],          // { id, gano, t }
    reimpresiones: [],
    clientes: new Set()    // conexiones SSE
  };

  function jornada() {
    const ahora = Date.now();
    return {
      jornada: new Date(ahora).toISOString().slice(0, 10),
      inicio: new Date(ahora - 12 * 3600e3).toISOString(),
      fin: new Date(ahora + 12 * 3600e3).toISOString(),
      corte: "05:00:00", minutos_ocultar: 15
    };
  }

  function visible(fila) {
    if (estado.modo.columnas) return { ...fila };
    const { impreso_en, reimpresiones, reimpreso_en, ...resto } = fila;
    return resto;
  }

  function difundir(tabla, tipo, fila) {
    const msg = "data: " + JSON.stringify({ table: tabla, type: tipo, new: fila }) + "\n\n";
    estado.clientes.forEach(res => res.write(msg));
  }

  function aplicarFiltros(filas, filtros) {
    return filas.filter(f => filtros.every(([op, col, val]) => {
      const v = f[col];
      if (op === "eq") return String(v) === String(val);
      if (op === "neq") return String(v) !== String(val);
      if (op === "gte") return v >= val;
      if (op === "lt") return v < val;
      return true;
    }));
  }

  function leerCuerpo(req) {
    return new Promise(resolver => {
      let t = "";
      req.on("data", c => { t += c; });
      req.on("end", () => { try { resolver(t ? JSON.parse(t) : {}); } catch (e) { resolver({}); } });
    });
  }
  function json(res, obj, codigo) {
    res.writeHead(codigo || 200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  }
  const pausa = ms => new Promise(r => setTimeout(r, ms));

  async function consulta(q) {
    estado.consultas.push({ tabla: q.tabla, op: q.op, filtros: q.filtros });

    if (q.tabla === "miembros") {
      return { data: aplicarFiltros(estado.miembros, q.filtros).slice(0, q.limite || undefined), error: null };
    }
    if (q.tabla === "configuracion" || q.tabla === "salud_notificaciones") {
      const fila = q.tabla === "configuracion" ? estado.configuracion : estado.salud;
      const coincide = aplicarFiltros([fila], q.filtros).length === 1;
      if (q.op === "update") {
        if (coincide) Object.assign(fila, q.valores);
        return { data: null, error: null };
      }
      return { data: coincide ? { ...fila } : null, error: null };
    }
    if (q.tabla !== "pedidos") return { data: [], error: null };

    // Sonda de columnas: select("impreso_en")
    if (q.op === "select" && /impreso_en/.test(q.cols || "") && q.cols !== "*" && !estado.modo.columnas) {
      return { data: null, error: { code: "42703", message: "column pedidos.impreso_en does not exist" } };
    }

    if (q.op === "update") {
      const filas = aplicarFiltros(estado.pedidos, q.filtros);
      filas.forEach(f => {
        Object.assign(f, q.valores);
        f.actualizado_en = new Date().toISOString();
        difundir("pedidos", "UPDATE", visible(f));
      });
      return { data: null, error: null };
    }

    let filas = aplicarFiltros(estado.pedidos, q.filtros);
    if (q.orden) {
      const [col, dir] = q.orden;
      filas.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === "desc" ? -1 : 1));
    }
    if (q.limite) filas = filas.slice(0, q.limite);
    filas = filas.map(visible);

    if (q.cols && q.cols !== "*") {
      const cols = q.cols.split(",").map(c => c.trim());
      filas = filas.map(f => Object.fromEntries(cols.filter(c => c in f).map(c => [c, f[c]])));
    }
    return { data: q.unica ? (filas[0] || null) : filas, error: null };
  }

  async function rpc(nombre, args) {
    if (estado.modo.latenciaRpcMs) await pausa(estado.modo.latenciaRpcMs);

    estado.rpcs.push({ nombre, args });

    if (nombre === "limites_jornada") {
      // Como la funcion real: quien pide un restaurante que no es el suyo recibe vacio
      return { data: args.p_restaurante === estado.restaurante.id ? [jornada()] : [], error: null };
    }

    if (nombre === "reclamar_impresion" || nombre === "registrar_reimpresion") {
      if (!estado.modo.columnas) {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public." + nombre + "(p_id) in the schema cache" } };
      }
      if (!estado.modo.esPersonal) {
        return { data: null, error: { code: "42501", message: "No autorizado" } };
      }
      const p = estado.pedidos.find(x => x.id === Number(args.p_id));

      if (nombre === "reclamar_impresion") {
        // Un solo paso, sin await en medio: igual de atomico que el UPDATE condicional
        let gano = false;
        if (p && p.impreso_en == null && p.estado_pago === "aprobado" &&
            ["nuevo", "en_preparacion", "listo"].includes(p.estado)) {
          p.impreso_en = new Date().toISOString();
          gano = true;
          difundir("pedidos", "UPDATE", visible(p));
        }
        estado.reclamos.push({ id: Number(args.p_id), gano, t: Date.now() });
        return { data: gano, error: null };
      }

      if (!p || p.estado === "pendiente_pago") return { data: null, error: null };
      p.reimpresiones = (p.reimpresiones || 0) + 1;
      p.reimpreso_en = new Date().toISOString();
      estado.reimpresiones.push({ id: p.id, n: p.reimpresiones });
      difundir("pedidos", "UPDATE", visible(p));
      return { data: p.reimpresiones, error: null };
    }
    return { data: null, error: { code: "PGRST202", message: "funcion desconocida" } };
  }

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const ruta = decodeURIComponent(url.pathname);

    // ---- SSE (Realtime) ----
    if (ruta === "/__db/eventos") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": ok\n\n");
      estado.clientes.add(res);
      req.on("close", () => estado.clientes.delete(res));
      return;
    }

    // ---- El restaurante del dominio (mismo codigo que el servidor real) ----
    if (ruta === "/api/restaurante") {
      if (estado.restauranteFalla > 0) {
        estado.restauranteFalla--;
        res.writeHead(503, { "content-type": "application/json" });
        return res.end("{\"error\":\"Servicio no disponible en este momento\"}");
      }
      const original = console.warn; console.warn = () => {};   // el aviso del respaldo de Taqueiros
      try {
        return json(res, construirPublico(estado.restaurante, { tarifas: TARIFAS, modo: null, integridadOk: false, env: {} }));
      } finally { console.warn = original; }
    }
    if (ruta === "/__db/canal") { estado.canales.push(await leerCuerpo(req)); return json(res, { ok: true }); }

    if (ruta === "/__db/consulta") return json(res, await consulta(await leerCuerpo(req)));
    if (ruta === "/__db/rpc") {
      const c = await leerCuerpo(req);
      return json(res, await rpc(c.nombre, c.args || {}));
    }

    // ---- Admin (solo para el script de pruebas) ----
    if (ruta === "/__admin/reset") {
      const c = await leerCuerpo(req);
      estado.pedidos = (c.pedidos || []).map(p => ({ ...p }));
      estado.consultas = []; estado.rpcs = []; estado.canales = [];
      estado.restaurante = restauranteBase(); estado.restauranteFalla = 0;
      estado.miembros = [{ user_id: "u1", restaurante_id: TAQUEIROS_ID, rol: "dueno", activo: true }];
      estado.configuracion = { id: 1, restaurante_id: TAQUEIROS_ID, cerrado_temporal: false, horarios: [], mensaje_cerrado: null };
      estado.salud = { id: 1, restaurante_id: TAQUEIROS_ID, ultimo_ok: true, fallos_seguidos: 0 };
      estado.reclamos = [];
      estado.reimpresiones = [];
      estado.modo = { columnas: true, esPersonal: true, latenciaRpcMs: 0, ...(c.modo || {}) };
      return json(res, { ok: true });
    }
    if (ruta === "/__admin/restaurante") {      // cambia lo que devuelve /api/restaurante o los miembros
      const c = await leerCuerpo(req);
      if (c.restaurante) estado.restaurante = { ...estado.restaurante, ...c.restaurante };
      if (c.miembros) estado.miembros = c.miembros;
      if (typeof c.falla === "number") estado.restauranteFalla = c.falla;
      return json(res, { ok: true });
    }
    if (ruta === "/__admin/modo") {
      Object.assign(estado.modo, await leerCuerpo(req));
      return json(res, estado.modo);
    }
    if (ruta === "/__admin/evento") {
      const c = await leerCuerpo(req);
      const i = estado.pedidos.findIndex(p => p.id === c.fila.id);
      if (i >= 0) estado.pedidos[i] = { ...estado.pedidos[i], ...c.fila };
      else estado.pedidos.push({ ...c.fila });
      difundir("pedidos", c.tipo || (i >= 0 ? "UPDATE" : "INSERT"), visible(estado.pedidos.find(p => p.id === c.fila.id)));
      return json(res, { ok: true });
    }
    if (ruta === "/__admin/estado") {
      return json(res, {
        pedidos: estado.pedidos, reclamos: estado.reclamos,
        reimpresiones: estado.reimpresiones, modo: estado.modo,
        consultas: estado.consultas, rpcs: estado.rpcs, canales: estado.canales,
        sse: estado.clientes.size
      });
    }

    // ---- Archivos estaticos ----
    if (ruta === "/__mock/supabase.js") {
      res.writeHead(200, { "content-type": TIPOS[".js"], "cache-control": "no-store" });
      return res.end(fs.readFileSync(MOCK));
    }

    let archivo;
    if (archivosExtra[ruta]) archivo = archivosExtra[ruta];
    else {
      archivo = path.join(RAIZ, ruta === "/" ? "index.html" : ruta);
      if (!archivo.startsWith(RAIZ)) { res.writeHead(403); return res.end(); }
    }
    if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
      res.writeHead(404); return res.end("no existe");
    }

    const ext = path.extname(archivo).toLowerCase();
    let cuerpo = fs.readFileSync(archivo);
    if (ext === ".html") {
      // El supabase-js real se cambia por el falso (y se quita el SRI,
      // que de otro modo bloquearia el reemplazo). El resto no se toca.
      cuerpo = Buffer.from(cuerpo.toString("utf8").replace(
        /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^>]*><\/script>/,
        '<script src="/__mock/supabase.js"></script>'));
    }
    res.writeHead(200, { "content-type": TIPOS[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(cuerpo);
  });

  return { servidor, estado };
}

module.exports = { crearServidor, TAQUEIROS_ID };

if (require.main === module) {
  const { servidor } = crearServidor();
  servidor.listen(Number(process.env.PUERTO) || 8099, "127.0.0.1", () => {
    console.log("Servidor de prueba en http://127.0.0.1:" + servidor.address().port);
  });
}
