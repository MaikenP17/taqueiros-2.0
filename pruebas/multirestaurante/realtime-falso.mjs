/* =============================================================
   REALTIME FALSO (servidor WebSocket minimo del protocolo Phoenix que habla supabase-js)

   El Supabase falso de PGlite (fake-supabase.mjs) no emula Realtime. Para probar de verdad que el panel
   se suscribe SOLO a su restaurante, este modulo atiende el WebSocket que abre el supabase-js real
   (version 2.0.0 del protocolo: mensajes de texto con arreglos [join_ref, ref, topic, evento, carga]):

     * phx_join   -> guarda a que tablas y con QUE FILTRO se suscribio cada canal y responde 'ok' con un
                    id por suscripcion (como el servidor real, que ademas valida los filtros);
     * heartbeat  -> responde 'ok';
     * phx_leave  -> responde 'ok' y borra el canal.

   Desde la prueba:
     rt.uniones          cada phx_join recibido: { topic, suscripciones:[{ id, table, filter, event }] }
     rt.emitir(tabla, tipo, fila, { respetarFiltro })
                         entrega un cambio a las suscripciones de esa tabla. Con respetarFiltro:true (por
                         defecto) hace lo que haria Realtime: solo llega a quien su filtro "columna=eq.valor"
                         deja pasar. Con respetarFiltro:false lo entrega a TODAS las suscripciones de la
                         tabla: simula un servidor (o un intermediario) que se salta el filtro, para probar
                         que el panel descarta por su cuenta lo que no es de su restaurante.
============================================================= */
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function codificar(texto) {
  const carga = Buffer.from(texto, 'utf8');
  let cab;
  if (carga.length < 126) cab = Buffer.from([0x81, carga.length]);
  else if (carga.length < 65536) { cab = Buffer.alloc(4); cab[0] = 0x81; cab[1] = 126; cab.writeUInt16BE(carga.length, 2); }
  else { cab = Buffer.alloc(10); cab[0] = 0x81; cab[1] = 127; cab.writeBigUInt64BE(BigInt(carga.length), 2); }
  return Buffer.concat([cab, carga]);
}

/* Saca los mensajes completos de un buffer de tramas del cliente (siempre enmascaradas). */
function decodificar(buf) {
  const mensajes = [];
  let pos = 0;
  while (buf.length - pos >= 2) {
    const op = buf[pos] & 0x0f;
    let len = buf[pos + 1] & 0x7f;
    let desp = pos + 2;
    if (len === 126) { if (buf.length - desp < 2) break; len = buf.readUInt16BE(desp); desp += 2; }
    else if (len === 127) { if (buf.length - desp < 8) break; len = Number(buf.readBigUInt64BE(desp)); desp += 8; }
    const masc = (buf[pos + 1] & 0x80) !== 0;
    const llave = masc ? buf.subarray(desp, desp + 4) : null;
    if (masc) desp += 4;
    if (buf.length - desp < len) break;
    const carga = Buffer.from(buf.subarray(desp, desp + len));
    if (masc) for (let i = 0; i < carga.length; i++) carga[i] ^= llave[i % 4];
    mensajes.push({ op, texto: op === 1 ? carga.toString('utf8') : null });
    pos = desp + len;
  }
  return { mensajes, resto: buf.subarray(pos) };
}

export function crearRealtime() {
  const sockets = new Set();
  const uniones = [];
  let siguienteId = 1;

  function alUpgrade(req, socket) {
    if (!/^\/realtime\/v1\/websocket/.test(req.url || '')) { socket.destroy(); return; }
    const llave = req.headers['sec-websocket-key'];
    const acepta = crypto.createHash('sha1').update(llave + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acepta + '\r\n\r\n');

    const estado = { socket, canales: new Map(), host: req.headers.host || '' };   // topic -> { joinRef, suscripciones }
    sockets.add(estado);
    let pendiente = Buffer.alloc(0);

    const enviar = (arreglo) => { try { socket.write(codificar(JSON.stringify(arreglo))); } catch (e) { /* cerrado */ } };

    socket.on('data', (trozo) => {
      pendiente = Buffer.concat([pendiente, trozo]);
      const { mensajes, resto } = decodificar(pendiente);
      pendiente = Buffer.from(resto);
      for (const m of mensajes) {
        if (m.op === 8) { socket.end(); return; }
        if (m.op === 9) { socket.write(Buffer.from([0x8a, 0])); continue; }
        if (m.op !== 1) continue;
        let msg;
        try { msg = JSON.parse(m.texto); } catch (e) { continue; }
        const [joinRef, ref, topic, evento, carga] = msg;
        if (evento === 'heartbeat') { enviar([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }]); continue; }
        if (evento === 'phx_join') {
          const pedidas = (carga && carga.config && carga.config.postgres_changes) || [];
          const suscripciones = pedidas.map((p) => ({ id: siguienteId++, event: p.event, schema: p.schema, table: p.table, filter: p.filter || null }));
          estado.canales.set(topic, { joinRef, suscripciones });
          uniones.push({ topic, host: estado.host, suscripciones: suscripciones.map((s) => ({ ...s })) });
          enviar([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: suscripciones.map((s) => ({ ...s })) } }]);
          continue;
        }
        if (evento === 'phx_leave') {
          estado.canales.delete(topic);
          enviar([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]);
          continue;
        }
        if (evento === 'access_token') { enviar([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]); continue; }
        if (ref) enviar([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]);
      }
    });
    const cerrar = () => sockets.delete(estado);
    socket.on('close', cerrar);
    socket.on('error', cerrar);
  }

  function pasaFiltro(filtro, fila) {
    if (!filtro) return true;
    const m = /^([a-z_]+)=eq\.(.+)$/.exec(filtro);
    return !!m && fila != null && String(fila[m[1]]) === m[2];
  }

  /* Entrega un cambio. Devuelve cuantas suscripciones lo recibieron. */
  function emitir(tabla, tipo, fila, opciones) {
    const respetar = !opciones || opciones.respetarFiltro !== false;
    let entregas = 0;
    for (const s of sockets) {
      for (const [topic, canal] of s.canales) {
        for (const sub of canal.suscripciones) {
          if (sub.table !== tabla) continue;
          if (sub.event !== '*' && sub.event !== tipo) continue;
          if (respetar && !pasaFiltro(sub.filter, fila)) continue;
          entregas++;
          try {
            s.socket.write(codificar(JSON.stringify([canal.joinRef, null, topic, 'postgres_changes', {
              ids: [sub.id],
              data: { schema: 'public', table: tabla, commit_timestamp: new Date().toISOString(), type: tipo, columns: [], record: fila, old_record: {}, errors: null }
            }])));
          } catch (e) { /* cerrado */ }
        }
      }
    }
    return entregas;
  }

  function cerrarTodo() { for (const s of sockets) { try { s.socket.destroy(); } catch (e) { /* ya cerrado */ } } sockets.clear(); }

  return { alUpgrade, emitir, uniones, cerrarTodo, conectados: () => sockets.size };
}
