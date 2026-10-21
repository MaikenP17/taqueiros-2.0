/* =============================================================
   supabase-js FALSO para probar el panel en un navegador sin interfaz.

   Reemplaza al paquete real solo en las pruebas (ver
   servidor-falso.js). Cada consulta viaja al servidor de prueba,
   que guarda una base compartida: asi dos pestanas ven lo mismo.

   Solo implementa lo que usa panel.html.
============================================================= */
(function () {
  "use strict";

  function post(ruta, cuerpo) {
    return fetch("/__db" + ruta, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo || {})
    }).then(r => r.json());
  }

  function consulta(tabla) {
    const q = { tabla, op: "select", cols: "*", filtros: [], orden: null, limite: null, unica: false, valores: null };
    const api = {
      select(cols) { if (q.op === "select") q.cols = cols || "*"; return api; },
      update(valores) { q.op = "update"; q.valores = valores; return api; },
      eq(c, v) { q.filtros.push(["eq", c, v]); return api; },
      neq(c, v) { q.filtros.push(["neq", c, v]); return api; },
      gte(c, v) { q.filtros.push(["gte", c, v]); return api; },
      lt(c, v) { q.filtros.push(["lt", c, v]); return api; },
      order(c, o) { q.orden = [c, o && o.ascending === false ? "desc" : "asc"]; return api; },
      limit(n) { q.limite = n; return api; },
      maybeSingle() { q.unica = true; return api; },
      then(ok, mal) { return post("/consulta", q).then(ok, mal); }
    };
    return api;
  }

  const canales = [];
  let socketVivo = true;

  function crearCanal() {
    const c = {
      state: "joining",
      _manejadores: [],
      _es: null,
      on(tipo, filtro, cb) { c._manejadores.push({ filtro, cb }); return c; },
      subscribe(cb) {
        // El servidor de prueba anota con que filtros abrio el panel sus canales (las pruebas lo revisan)
        post("/canal", { nombre: c._nombre, filtros: c._manejadores.map(h => h.filtro) });
        c._es = new EventSource("/__db/eventos");
        c._es.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (c.state !== "joined") return;
          c._manejadores.forEach(h => {
            if (!h.filtro || h.filtro.table !== m.table) return;
            // Igual que Supabase Realtime: el filtro "columna=eq.valor" se aplica a la fila nueva
            if (h.filtro.filter) {
              const f = /^([a-z_]+)=eq.(.+)$/.exec(h.filtro.filter);
              if (f && !(m.new && String(m.new[f[1]]) === f[2])) return;
            }
            h.cb({ eventType: m.type, new: m.new, old: null });
          });
        };
        c._es.onopen = () => {
          c.state = "joined";
          if (cb) cb("SUBSCRIBED");
        };
        return c;
      }
    };
    canales.push(c);
    return c;
  }

  function crearCliente() {
    const sesion = { access_token: "falso", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "u1" } };
    return {
      auth: {
        getSession: async () => ({ data: { session: sesion }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithPassword: async () => ({ data: { session: sesion }, error: null }),
        signOut: async (opciones) => { window.__signOut = (window.__signOut || []).concat([opciones || null]); return { error: null }; }
      },
      from: consulta,
      rpc(nombre, args) {
        const llamada = post("/rpc", { nombre, args });
        // El panel hace db.rpc("limites_jornada").select(): se aguanta
        llamada.select = () => llamada;
        return llamada;
      },
      channel: (nombre) => { const c = crearCanal(); c._nombre = nombre; return c; },
      removeChannel: async (c) => { if (c._es) c._es.close(); c.state = "closed"; },
      realtime: { isConnected: () => socketVivo }
    };
  }

  window.supabase = { createClient: crearCliente };

  // Mandos para el script de pruebas
  window.__mock = {
    canal(estado) { canales.forEach(c => { c.state = estado; }); socketVivo = estado === "joined"; },
    canales: () => canales.map(c => c.state)
  };
})();
