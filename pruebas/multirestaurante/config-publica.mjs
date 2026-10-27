/* =============================================================
   PRUEBAS DEL SQL 12 (supabase/12-config-publica.sql)

     node pruebas/multirestaurante/config-publica.mjs

   1. Corre dos veces sobre una base con el SQL 10 y el 11: todas las comprobaciones OK, y el SQL 12
      se puede volver a correr despues de re-correr el 10.
   2. Los pedidos que ya existian no cambian (numero, id, 'actualizado_en') y conservan su enlace por
      referencia; los nuevos solo se abren con su token.
   3. seguimiento() y buscar_mis_pedidos() devuelven el NUMERO del restaurante (no el id global).
   4. Un usuario no puede cambiar el token (el servidor si).
   5. La mezcla de la config no pisa lo que ya habia, no toca a otros restaurantes y la forma coincide
      EXACTAMENTE con api/_respaldo-taqueiros.js.
   6. REVISION POR MUTACION del propio SQL 12: se rompe cada defensa y la migracion (o alguna prueba)
      tiene que detectarlo.
============================================================= */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { crearBase, sembrar, sql10, sql, intentar, U, REPO } from './sim.mjs';

const require = createRequire(import.meta.url);
const { CONFIG_TAQUEIROS } = require(`${REPO}/api/_respaldo-taqueiros.js`);
/* REBRAND (SQL 17): el respaldo del codigo ya NO es lo que escribe el SQL 12; es el estado final SQL 12 + SQL 17 (marca The Northe
   Burgers). Lo que el SQL 12 escribe (Taqueiros) queda fijado en config-taqueiros-original.json, copia del respaldo del commit 947b164.
   Cada comparacion que antes era "SQL 12 == respaldo" sigue existiendo, ahora contra ese original; y se agrega "SQL 12 + SQL 17 == respaldo". */
const ORIGINAL = JSON.parse(fs.readFileSync(`${REPO}/pruebas/multirestaurante/config-taqueiros-original.json`, 'utf8'));

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info) });
const ultimo = (res) => res[res.length - 1];
const TAQ = '00000000-0000-4000-8000-000000000001';
const OTRO = '33333333-3333-4333-8333-333333333333';

async function baseConSql10y11() {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await db.exec(sql10());
  await db.exec(sql('11-dominios.sql'));
  return db;
}

const archivo = sql('12-config-publica.sql');
const svc = (db, q, p = []) => intentar(db, null, q, p, { rol: 'service_role' });

/* ---- 1. idempotencia y convivencia ------------------------------------------------------------------ */
const db = await baseConSql10y11();
const antes = (await db.query(`select id, numero, referencia, actualizado_en, estado_cambiado_en from public.pedidos order by id`)).rows;
const r1 = ultimo(await db.exec(archivo)).rows;
const r2 = ultimo(await db.exec(archivo)).rows;
prueba('primera corrida: todas las comprobaciones OK', r1.length >= 20 && r1.every((x) => x.estado === 'OK'), JSON.stringify(r1.filter((x) => x.estado !== 'OK')));
prueba('segunda corrida (idempotente): todas OK', r2.length === r1.length && r2.every((x) => x.estado === 'OK'), JSON.stringify(r2.filter((x) => x.estado !== 'OK')));

const despues = (await db.query(`select id, numero, referencia, actualizado_en, estado_cambiado_en, enlace_por_referencia, token_seguimiento from public.pedidos order by id`)).rows;
prueba('los pedidos existentes no cambian (id, numero, referencia, actualizado_en, estado_cambiado_en): se agregaron columnas sin UPDATE',
  despues.length === antes.length && antes.every((a, i) => a.id === despues[i].id && a.numero === despues[i].numero && a.referencia === despues[i].referencia
    && String(a.actualizado_en) === String(despues[i].actualizado_en) && String(a.estado_cambiado_en) === String(despues[i].estado_cambiado_en)), JSON.stringify([antes, despues]).slice(0, 300));
prueba('cada pedido existente tiene SU token (todos distintos, 32 caracteres hexadecimales)',
  new Set(despues.map((p) => p.token_seguimiento)).size === despues.length && despues.every((p) => /^[0-9a-f]{32}$/.test(p.token_seguimiento)), '');
prueba('los pedidos existentes conservan el enlace por referencia', despues.every((p) => p.enlace_por_referencia === true), '');

const r10 = ultimo(await db.exec(sql10())).rows;
prueba('el SQL 10 se puede re-correr despues del 12 (34 OK) y despues el 12 lo repone (todo OK)',
  r10.length === 34 && r10.every((x) => x.estado === 'OK')
  && ultimo(await db.exec(archivo)).rows.every((x) => x.estado === 'OK'), JSON.stringify(r10.filter((x) => x.estado !== 'OK')));

/* ---- 2. seguimiento: enlace por token; el viejo solo para pedidos viejos ------------------------------------ */
await db.exec(`insert into public.restaurantes (id, slug, nombre) values ('${OTRO}', 'otro-rest', 'Otro restaurante')`);
const nuevo = (rid, ref, tel, total) => svc(db, `
  insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, pagado_en)
  values ($1, $2, 'nuevo', 'Cliente', $3, 'local', '[{"id":"x","nombre":"Taco","cantidad":1,"precio":9000}]', $4, 0, $4, 'aprobado', now())
  returning id, numero, token_seguimiento, enlace_por_referencia`, [rid, ref, tel, total]);
const pT = (await nuevo(TAQ, 'TAQ-NUEVO-T', '3001110001', 9000)).rows[0];
const pO1 = (await nuevo(OTRO, 'TAQ-NUEVO-O1', '3002220002', 9000)).rows[0];
const pO2 = (await nuevo(OTRO, 'TAQ-NUEVO-O2', '3002220002', 9000)).rows[0];
const seg = (ref) => intentar(db, null, `select * from public.seguimiento($1)`, [ref], { rol: 'anon' });

prueba('un pedido nuevo nace con token y sin enlace por referencia', pT && /^[0-9a-f]{32}$/.test(pT.token_seguimiento) && pT.enlace_por_referencia === false, JSON.stringify(pT));
prueba('seguimiento(token) de un pedido nuevo devuelve 1 fila', (await seg(pT.token_seguimiento)).rows.length === 1, '');
prueba('seguimiento(referencia) de un pedido NUEVO ya no devuelve nada (la referencia sola no basta)', (await seg('TAQ-NUEVO-T')).rows.length === 0, '');
prueba('seguimiento(referencia) de un pedido que YA existia sigue funcionando (ningun enlace entregado se rompe)', (await seg('TAQ-4-ddd')).rows.length === 1, '');
prueba('seguimiento(token) tambien abre un pedido que ya existia', (await seg(despues.find((p) => p.referencia === 'TAQ-4-ddd').token_seguimiento)).rows.length === 1, '');
prueba('seguimiento: un token inventado, vacio o con comodines no devuelve nada',
  (await Promise.all(['x'.repeat(32), '', '%', '%%%', "' or true --", pT.token_seguimiento.slice(0, 31) + 'X'].map((t) => seg(t)))).every((r) => r.ok && r.rows.length === 0), '');
const f = (await seg(pO2.token_seguimiento)).rows[0];
prueba('seguimiento devuelve el NUMERO del restaurante (no el id global) y nunca telefono ni correo',
  f && Number(f.numero) === Number(pO2.numero) && Number(pO2.numero) === 2 && Number(pO2.id) !== 2
  && !('cliente_telefono' in f) && !('cliente_email' in f) && !('token_seguimiento' in f) && !('restaurante_id' in f), JSON.stringify([f, pO2]));
prueba('un pedido sin pagar (pendiente_pago) no se muestra ni con su token', await (async () => {
  const p = (await svc(db, `insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago)
    values ('${TAQ}', 'TAQ-SIN-PAGAR', 'pendiente_pago', 'C', '3009990001', 'local', '[]', 5000, 0, 5000, 'pendiente') returning token_seguimiento`)).rows[0];
  return (await seg(p.token_seguimiento)).rows.length === 0;
})(), '');

/* ---- 3. buscar_mis_pedidos ---------------------------------------------------------------------------------- */
const buscar = (tel, total, rid) => intentar(db, null,
  `select * from public.buscar_mis_pedidos(telefono => $1, total_pagado => $2${rid ? ', p_restaurante => $3' : ''})`, rid ? [tel, total, rid] : [tel, total], { rol: 'anon' });
const b = await buscar('3002220002', 9000, OTRO);
prueba('buscar_mis_pedidos devuelve el numero del restaurante y el token para el enlace',
  b.ok && b.rows.length === 2 && b.rows.map((x) => Number(x.numero)).sort().join() === '1,2' && b.rows.every((x) => /^[0-9a-f]{32}$/.test(x.token_seguimiento) && x.referencia.startsWith('TAQ-NUEVO-O')), JSON.stringify(b));
prueba('buscar_mis_pedidos sigue acotada a un restaurante (otro celular de otro restaurante no aparece)', (await buscar('3002220002', 9000, TAQ)).rows.length === 0, '');
prueba('buscar_mis_pedidos sin restaurante sigue acotada a Taqueiros', (await buscar('3001110001', 9000)).rows.length === 1, '');
prueba('buscar_mis_pedidos conserva el limite: pasados los 10 intentos del MISMO celular responde vacio, y otro celular no se afecta', await (async () => {
  for (let i = 0; i < 11; i++) await buscar('3005550005', 1000 + i, TAQ);
  return (await buscar('3001110001', 9000, TAQ)).ok && (await buscar('3005550005', 9000, TAQ)).rows.length === 0;
})(), '');

/* ---- 4. el token no se cambia desde el navegador ------------------------------------------------------------------ */
const dueno = (q, p = []) => intentar(db, U.dueno_taq, q, p, { rol: 'authenticated' });
const cambioToken2 = await dueno(`update public.pedidos set token_seguimiento = repeat('a', 32) where id = ${pT.id}`);
prueba('el dueno NO puede cambiar el token de un pedido (42501)', cambioToken2.ok === false && cambioToken2.code === '42501', JSON.stringify(cambioToken2));
const cambioEnlace = await dueno(`update public.pedidos set enlace_por_referencia = true where id = ${pT.id}`);
prueba('el dueno NO puede reabrir el enlace por referencia', cambioEnlace.ok === false && cambioEnlace.code === '42501', JSON.stringify(cambioEnlace));
const estado = await dueno(`update public.pedidos set estado = 'en_preparacion' where id = ${pT.id} returning estado`);
prueba('el dueno SI puede seguir cambiando el estado (el trigger no estorba al panel)', estado.ok && estado.rows.length === 1, JSON.stringify(estado));
const dato = await dueno(`select token_seguimiento from public.pedidos where id = ${pT.id}`);
prueba('el personal puede LEER el token de los pedidos de su restaurante (como ya lee su telefono y direccion)', dato.ok && dato.rows.length === 1, JSON.stringify(dato));
prueba('el servidor (service_role) SI puede cambiar el token', (await svc(db, `update public.pedidos set token_seguimiento = repeat('c', 32) where id = ${pT.id} returning 1`)).rows.length === 1, '');
const anonLee = await intentar(db, null, `select token_seguimiento from public.pedidos`, [], { rol: 'anon' });
prueba('anon NO puede leer pedidos ni el token (42501)', anonLee.ok === false && anonLee.code === '42501', JSON.stringify(anonLee));
const ins = await dueno(`insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago)
  values ('${OTRO}', 'TAQ-AJENO', 'nuevo', 'X', '3000000000', 'local', '[]', 1, 0, 1, 'pendiente')`);
prueba('el dueno de Taqueiros sigue sin poder crear pedidos en otro restaurante', ins.ok === false, JSON.stringify(ins));

/* ---- 5. la mezcla de la config -------------------------------------------------------------------------------------- */
const cfgT = (await db.query(`select config from public.restaurantes where id = '${TAQ}'`)).rows[0].config;
prueba('con la config vacia, el SQL 12 deja a Taqueiros con EXACTAMENTE los valores originales (config-taqueiros-original.json, commit 947b164)', JSON.stringify(canon(cfgT)) === JSON.stringify(canon(ORIGINAL)), JSON.stringify(cfgT).slice(0, 200));
prueba('el JSON del SQL 12 y el original fijado coinciden', JSON.stringify(canon(JSON.parse(archivo.split('$cfg$')[1]))) === JSON.stringify(canon(ORIGINAL)), '');
{
  /* REBRAND: el respaldo del codigo = estado final de la base despues del SQL 12 y del SQL 17 (config completa, sin dejar nada fuera) */
  const b17 = await baseConSql10y11();
  await b17.exec(archivo);
  const r17 = ultimo(await b17.exec(sql('17-rebrand-northe.sql'))).rows;
  const cfg17 = (await b17.query(`select config from public.restaurantes where id = '${TAQ}'`)).rows[0].config;
  prueba('SQL 12 + SQL 17: el SQL 17 corre sobre la base del SQL 12 y todas sus comprobaciones dan OK', r17.length >= 20 && r17.every((x) => x.estado === 'OK'), JSON.stringify(r17.filter((x) => x.estado !== 'OK')));
  prueba('SQL 12 + SQL 17: la config final de la base es EXACTAMENTE api/_respaldo-taqueiros.js (marca, textos, contacto, wompi, pwa, ubicacion y domicilio)',
    JSON.stringify(canon(cfg17)) === JSON.stringify(canon(CONFIG_TAQUEIROS)), JSON.stringify(cfg17).slice(0, 200));
  prueba('SQL 12 + SQL 17: lo que NO es marca (ubicacion, domicilio, wompi, whatsapp, telefono, direccion, ciudad) es identico al original',
    JSON.stringify(canon({ u: cfg17.ubicacion, d: cfg17.domicilio, w: cfg17.publico.wompi, c: { ...cfg17.publico.contacto, instagram: 0, tiktok: 0 } }))
    === JSON.stringify(canon({ u: ORIGINAL.ubicacion, d: ORIGINAL.domicilio, w: ORIGINAL.publico.wompi, c: { ...ORIGINAL.publico.contacto, instagram: 0, tiktok: 0 } })), '');
}
prueba('la config de otro restaurante sigue vacia', JSON.stringify((await db.query(`select config from public.restaurantes where id = '${OTRO}'`)).rows[0].config) === '{}', '');

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

{
  const base = await baseConSql10y11();
  const previo = { publico: { marca: { colores: { primario: '#000000', oscuro: null }, emoji: '🍕' }, contacto: { whatsapp: '573000000000' }, nuevoCampo: [1, 2] }, ubicacion: { lat: 1.5 }, extra: 'x' };
  await base.query(`update public.restaurantes set config = $1::jsonb where id = '${TAQ}'`, [JSON.stringify(previo)]);
  await base.exec(`insert into public.restaurantes (id, slug, nombre, config) values ('${OTRO}', 'otro-rest', 'Otro', '{"marca":"propia"}'::jsonb)`);
  const res = ultimo(await base.exec(archivo)).rows;
  const c = (await base.query(`select config from public.restaurantes where id = '${TAQ}'`)).rows[0].config;
  prueba('con config previa: todas las comprobaciones OK', res.every((x) => x.estado === 'OK'), JSON.stringify(res.filter((x) => x.estado !== 'OK')));
  prueba('con config previa: lo que ya habia se queda (color, emoji, WhatsApp, lat, claves ajenas, arreglos)',
    c.publico.marca.colores.primario === '#000000' && c.publico.marca.emoji === '🍕' && c.publico.contacto.whatsapp === '573000000000'
    && c.ubicacion.lat === 1.5 && c.extra === 'x' && JSON.stringify(c.publico.nuevoCampo) === '[1,2]', JSON.stringify(c).slice(0, 300));
  prueba('con config previa: se agrega lo que faltaba (lng, resto de colores, textos, llaves publicas) y un null se llena',
    c.ubicacion.lng === ORIGINAL.ubicacion.lng && c.publico.marca.colores.oscuro === '#1C1210' && c.publico.marca.colores.acento === '#E3A008'
    && c.publico.textos.tagline === ORIGINAL.publico.textos.tagline && c.publico.wompi.llave_publica_test === ORIGINAL.publico.wompi.llave_publica_test, JSON.stringify(c).slice(0, 300));
  const otro = (await base.query(`select config from public.restaurantes where id <> '${TAQ}'`)).rows;
  prueba('con config previa: los demas restaurantes no se tocan', otro.length > 0 && otro.every((r) => JSON.stringify(r.config) === '{"marca":"propia"}'), JSON.stringify(otro));
}

/* ---- 6. revision por mutacion del SQL 12 ------------------------------------------------------------------------------ */
// cada mutacion rompe UNA defensa; la migracion tiene que detenerse o alguna prueba tiene que fallar
async function sonda(base) {
  const hallazgos = [];
  const pedido = (await svc(base, `
    insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, pagado_en)
    values ('${TAQ}', 'TAQ-MUT-1', 'nuevo', 'C', '3001119999', 'local', '[]', 7000, 0, 7000, 'aprobado', now()) returning id, token_seguimiento, enlace_por_referencia`)).rows[0];
  const s = (ref) => intentar(base, null, `select * from public.seguimiento($1)`, [ref], { rol: 'anon' });
  if (!pedido || pedido.enlace_por_referencia !== false) hallazgos.push('un pedido nuevo nace con enlace por referencia');
  if (pedido && (await s('TAQ-MUT-1')).rows.length) hallazgos.push('seguimiento abre un pedido nuevo por su referencia');
  if (pedido && (await s(pedido.token_seguimiento)).rows.length !== 1) hallazgos.push('el token no abre el pedido');
  if ((await s('TAQ-4-ddd')).rows.length !== 1) hallazgos.push('un enlace viejo dejo de funcionar');
  const cambio = pedido && await intentar(base, U.dueno_taq, `update public.pedidos set token_seguimiento = repeat('a', 32) where id = ${pedido.id}`, [], { rol: 'authenticated' });
  if (cambio && cambio.ok) hallazgos.push('el dueno cambio el token');
  const anon = await intentar(base, null, `select token_seguimiento from public.pedidos`, [], { rol: 'anon' });
  if (anon.ok) hallazgos.push('anon lee pedidos');
  const b = await intentar(base, null, `select * from public.buscar_mis_pedidos(telefono => '3001119999', total_pagado => 7000)`, [], { rol: 'anon' });
  if (!b.ok || b.rows.length !== 1 || !b.rows[0].token_seguimiento || Number(b.rows[0].numero) !== Number(pedido.numero)) hallazgos.push('buscar_mis_pedidos no devuelve numero y token');
  const cfg = (await base.query(`select config from public.restaurantes where id = '${TAQ}'`)).rows[0].config;
  if (JSON.stringify(canon(cfg)) !== JSON.stringify(canon(ORIGINAL))) hallazgos.push('la config de Taqueiros no es la esperada');
  return hallazgos;
}

const mutaciones = [
  ['el token no se agrega con valor por defecto aleatorio', "default replace(gen_random_uuid()::text, '-', '')", "default 'fijo'"],
  ['los pedidos nuevos nacen con enlace por referencia', 'alter table public.pedidos alter column enlace_por_referencia set default false;', '-- (mutacion)'],
  ['seguimiento acepta la referencia de cualquier pedido', 'or (p.enlace_por_referencia and p.referencia = seguimiento.ref))', 'or (p.referencia = seguimiento.ref))'],
  ['seguimiento no acepta el token', '  where (p.token_seguimiento = seguimiento.ref\n         or (p.enlace_por_referencia and p.referencia = seguimiento.ref))', '  where (p.enlace_por_referencia and p.referencia = seguimiento.ref)'],
  ['seguimiento devuelve el id global como numero', '    p.numero,\n    p.referencia,\n    p.estado,\n    p.tipo_pedido,\n    p.direccion,', '    p.id,\n    p.referencia,\n    p.estado,\n    p.tipo_pedido,\n    p.direccion,'],
  ['buscar_mis_pedidos devuelve el id global como numero', '  select\n    p.numero,\n    p.referencia,\n    p.estado,\n    p.tipo_pedido,\n    p.total,', '  select\n    p.id,\n    p.referencia,\n    p.estado,\n    p.tipo_pedido,\n    p.total,'],
  ['buscar_mis_pedidos no devuelve el token', '    p.creado_en,\n    p.token_seguimiento\n  from public.pedidos p', '    p.creado_en,\n    null::text\n  from public.pedidos p'],
  ['buscar_mis_pedidos pierde el limite de intentos', '  if v_intentos > 10 then', '  if v_intentos > 100000 then'],
  ['buscar_mis_pedidos no se acota al restaurante', '  where p.restaurante_id = v_rid\n    and p.cliente_telefono', '  where true\n    and p.cliente_telefono'],
  ['no se instala el trigger que protege el token', 'create trigger pedidos_proteger_token\n  before update on public.pedidos\n  for each row execute function public.proteger_token_seguimiento();', '-- (mutacion)'],
  ['el trigger deja pasar a cualquiera', "     and not public.es_servidor()\n     and not (select public.es_superadmin()) then\n    raise exception 'No se puede cambiar el enlace", "     and false then\n    raise exception 'No se puede cambiar el enlace"],
  ['se le da a anon la lectura de seguimiento sobre pedidos', 'grant execute on function public.seguimiento(text) to anon, authenticated, service_role;', 'grant execute on function public.seguimiento(text) to anon, authenticated, service_role;\n  grant select on public.pedidos to anon;'],
  ['la mezcla sobrescribe lo que ya habia', "      if resultado ? k and jsonb_typeof(resultado -> k) <> 'null' then\n        resultado := jsonb_set(resultado, array[k], pg_temp.mr12_mezclar(resultado -> k, nuevo -> k));", "      if false then\n        resultado := jsonb_set(resultado, array[k], pg_temp.mr12_mezclar(resultado -> k, nuevo -> k));"],
  ['no se mezcla nada en la config de Taqueiros', '  if v_despues is distinct from v_antes then', '  if false then'],
  ['la config se mezcla en TODOS los restaurantes', "update public.restaurantes r set config = v_despues where r.id = public.restaurante_taqueiros_id();", "update public.restaurantes r set config = v_despues;"],
  ['la config trae una llave privada', '"llave_publica_prod": "pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW"', '"llave_publica_prod": "pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW", "privada": "prv_prod_secreto"'],
  ['la llave publica de produccion es una de prueba', '"llave_publica_prod": "pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW"', '"llave_publica_prod": "pub_test_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW"']
];
for (const [nombre, buscarTexto, reemplazar] of mutaciones) {
  const n = archivo.split(buscarTexto).length - 1;
  // la config aparece dos veces en el archivo (la mezcla y la comprobacion): las mutaciones de config tocan ambas
  if (n < 1) { prueba(`mutacion mal definida: ${nombre}`, false, `"${buscarTexto.slice(0, 60)}" aparece ${n} veces`); continue; }
  const base = await baseConSql10y11();
  let detectada = false, info = '';
  try {
    const res = ultimo(await base.exec(archivo.split(buscarTexto).join(reemplazar))).rows;
    const mal = res.filter((r) => r.estado !== 'OK');
    const sondas = await sonda(base);
    detectada = mal.length > 0 || sondas.length > 0;
    info = 'termino con todo OK y ninguna sonda lo atrapa';
    if (detectada && !mal.length) info = 'detectada por la sonda: ' + sondas.join('; ');
  } catch (e) {
    detectada = /LA MIGRACION 12 SE REVIRTIO|MR paso|could not create unique index/.test(e.message);
    info = 'fallo por otra razon: ' + e.message.slice(0, 160);
  }
  prueba(`mutacion detectada: ${nombre}`, detectada, info);
}

for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
const fallas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
process.exitCode = fallas ? 1 : 0;
