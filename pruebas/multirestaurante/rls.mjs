/* =============================================================
   200 COMPROBACIONES DE AISLAMIENTO A NIVEL SQL (roles reales + RLS)
   sobre el simulador local (sim.mjs). Aplica el SQL 10 y prueba, con
   "set role" y request.jwt.claims, lo que cada rol puede y no puede
   hacer. Imprime PASA/FALLA y sale con codigo 1 si algo falla.

   USO:  node pruebas/multirestaurante/rls.mjs [conPendientes]
============================================================= */
import { crearBase, sembrar, sql10, como, intentar, U } from './sim.mjs';

const conPend = process.argv[2] === 'conPendientes';
const db = await crearBase({ con01y02: conPend });
await sembrar(db);
await db.exec(sql10());
console.log('[SQL 10 aplicado]');

const TAQ = '00000000-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const u = {
  dA: 'a0000000-0000-4000-8000-00000000000a', cA: 'a0000000-0000-4000-8000-00000000000c', kA: 'a0000000-0000-4000-8000-00000000000d',
  dB: 'b0000000-0000-4000-8000-00000000000b', sin: 'c0000000-0000-4000-8000-0000000000ff', sa: 'd0000000-0000-4000-8000-0000000000aa',
};
for (const id of Object.values(u)) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, id + '@t.test']);
await db.exec(`
  insert into public.restaurantes (id, slug, nombre) values ('${A}', 'test-a', 'Test A'), ('${B}', 'test-b', 'Test B');
  insert into public.miembros (user_id, restaurante_id, rol) values
    ('${u.dA}', '${A}', 'dueno'), ('${u.cA}', '${A}', 'cajero'), ('${u.kA}', '${A}', 'cocina'), ('${u.dB}', '${B}', 'dueno');
  insert into public.superadmins (user_id) values ('${u.sa}');
  insert into public.categorias (restaurante_id, id, nombre, activa) values ('${A}', 'cat-a', 'Cat A', false), ('${B}', 'cat-b', 'Cat B', false);
  insert into public.productos (restaurante_id, id, nombre, precio, categoria, disponible) values
    ('${A}', 'prod-a', 'Prod A', 1000, 'cat-a', false), ('${B}', 'prod-b', 'Prod B', 1000, 'cat-b', false);
`);
const ped = (rid, ref, extra = '') => `insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, pagado_en, alerta_enviada)
  values ('${rid}', '${ref}', 'nuevo', 'N', '3000000000', 'llevar', '[]', 1000, 0, 1000, 'aprobado', now(), true) returning id, numero`;
const pA1 = (await db.query(ped(A, 'T-A-1'))).rows[0];
const pA2 = (await db.query(ped(A, 'T-A-2'))).rows[0];
const pB1 = (await db.query(ped(B, 'T-B-1'))).rows[0];
const pB2 = (await db.query(ped(B, 'T-B-2'))).rows[0];

let fallas = 0, total = 0;
const T = (nombre, cond, detalle = '') => {
  total++; if (!cond) fallas++;
  console.log((cond ? 'PASA   ' : 'FALLA  ') + nombre + (cond ? '' : '   -> ' + String(detalle).slice(0, 200)));
};
const denegado = (r) => !r.ok || r.n === 0;
const rechazado = (r) => !r.ok;

console.log('--- numeros por restaurante');
T('numero A = 1,2 ; B = 1,2', pA1.numero == 1 && pA2.numero == 2 && pB1.numero == 1 && pB2.numero == 2, JSON.stringify([pA1, pA2, pB1, pB2]));
const nTaq = (await db.query(`insert into public.pedidos (referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total, estado_pago) values ('T-TAQ-N','pendiente_pago','x','3','llevar','[]',1000,1000,'pendiente') returning id, numero, restaurante_id`)).rows[0];
T('Taqueiros continua despues del ultimo (id/numero siguiente > 5), restaurante por defecto Taqueiros', nTaq.restaurante_id === TAQ && nTaq.numero == 6 || nTaq.numero > 5, JSON.stringify(nTaq));
await db.query(`delete from public.pedidos where referencia = 'T-TAQ-N'`);

console.log('--- anon');
for (const t of ['pedidos', 'categorias', 'productos', 'configuracion', 'salud_notificaciones', 'restaurantes', 'miembros', 'superadmins', 'restaurante_secretos', 'contadores_pedido', 'tarifas_domicilio', 'personal']) {
  const r = await intentar(db, null, `select * from public.${t} limit 5`, [], { rol: 'anon' });
  T(`anon no lee ${t}`, denegado(r), JSON.stringify(r).slice(0, 100));
}
let r = await intentar(db, null, `insert into public.pedidos (referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total) values ('X','x','1','llevar','[]',1,1)`, [], { rol: 'anon' });
T('anon no inserta pedidos', rechazado(r));
r = await intentar(db, null, `select * from public.reclamar_impresion(${pA1.id})`, [], { rol: 'anon' });
T('anon no ejecuta reclamar_impresion', rechazado(r));
r = await intentar(db, null, `select * from public.buscar_historial()`, [], { rol: 'anon' });
T('anon no ejecuta buscar_historial', rechazado(r));
r = await intentar(db, null, `select public.resumen_jornada()`, [], { rol: 'anon' });
T('anon no ejecuta resumen_jornada', rechazado(r));
r = await intentar(db, null, `select public.limpiar_pedidos_huerfanos(24)`, [], { rol: 'anon' });
T('anon no ejecuta limpiar_pedidos_huerfanos', rechazado(r));
r = await intentar(db, null, `select * from public.seguimiento('T-A-1')`, [], { rol: 'anon' });
T('anon SI puede seguimiento(ref) y devuelve 1 fila sin telefono', r.ok && r.rows.length === 1 && !('cliente_telefono' in r.rows[0]), JSON.stringify(r));
r = await intentar(db, null, `select * from public.buscar_mis_pedidos(telefono => '3000000000', total_pagado => 1000)`, [], { rol: 'anon' });
T('buscar_mis_pedidos acotado a Taqueiros por defecto: no trae pedidos de A ni B', r.ok && r.rows.length === 0, JSON.stringify(r));
r = await intentar(db, null, `select * from public.buscar_mis_pedidos(telefono => '3000000000', total_pagado => 1000, p_restaurante => '${A}')`, [], { rol: 'anon' });
T('buscar_mis_pedidos con p_restaurante=A trae los de A', r.ok && r.rows.length === 2, JSON.stringify(r));

console.log('--- sin membresia');
for (const t of ['pedidos', 'categorias', 'productos', 'configuracion', 'salud_notificaciones', 'restaurantes', 'miembros', 'tarifas_domicilio']) {
  r = await intentar(db, u.sin, `select * from public.${t}`);
  T(`sin membresia no ve ${t}`, r.ok && r.rows.length === 0, JSON.stringify(r).slice(0, 100));
}
r = await intentar(db, u.sin, `select public.resumen_jornada()`);
T('sin membresia: resumen_jornada = null', r.ok && r.rows[0].resumen_jornada === null, JSON.stringify(r));
r = await intentar(db, u.sin, `select * from public.buscar_historial()`);
T('sin membresia: buscar_historial vacio', r.ok && r.rows.length === 0, JSON.stringify(r));
r = await intentar(db, u.sin, `select * from public.buscar_historial(p_restaurante => '${A}')`);
T('sin membresia: buscar_historial(p_restaurante=A) vacio', r.ok && r.rows.length === 0, JSON.stringify(r));
r = await intentar(db, u.sin, `select * from public.limites_jornada(p_restaurante => '${A}')`);
T('sin membresia: limites_jornada(A) vacio', r.ok && r.rows.length === 0, JSON.stringify(r));
r = await intentar(db, u.sin, `select * from public.jornadas_con_pedidos(10, '${A}')`);
T('sin membresia: jornadas_con_pedidos(A) vacio', r.ok && r.rows.length === 0, JSON.stringify(r));
r = await intentar(db, u.sin, `select public.reclamar_impresion(${pA1.id})`);
T('sin membresia: reclamar_impresion rechazada', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.sin, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total) values ('${A}','X1','x','1','llevar','[]',1,1)`);
T('sin membresia no inserta', rechazado(r));
r = await intentar(db, u.sin, `insert into public.restaurantes (slug, nombre) values ('test-hack', 'hack')`);
T('sin membresia no crea restaurantes', rechazado(r));
r = await intentar(db, u.sin, `insert into public.miembros (user_id, restaurante_id, rol) values ('${u.sin}', '${A}', 'dueno')`);
T('sin membresia no se agrega a miembros', rechazado(r));
r = await intentar(db, u.sin, `insert into public.superadmins (user_id) values ('${u.sin}')`);
T('sin membresia no se hace superadmin', rechazado(r));

console.log('--- dueno A: lee y escribe solo en A');
r = await intentar(db, u.dA, `select restaurante_id from public.pedidos`);
T('dA ve solo pedidos de A', r.ok && r.rows.length === 2 && r.rows.every((x) => x.restaurante_id === A), JSON.stringify(r).slice(0, 150));
r = await intentar(db, u.dA, `select id from public.pedidos where restaurante_id = '${B}'`);
T('dA no ve pedidos de B ni filtrando por B', r.ok && r.rows.length === 0);
r = await intentar(db, u.dA, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total, estado, estado_pago) values ('${A}','T-A-3','x','1','llevar','[]',1000,1000,'nuevo','aprobado') returning numero`);
T('dA inserta pedido en A y recibe numero 3', r.ok && r.rows[0].numero == 3, JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total, numero) values ('${A}','T-A-4','x','1','llevar','[]',1000,1000, 999) returning numero`);
T('dA no puede elegir su numero (se ignora y recibe el siguiente)', r.ok && r.rows[0].numero == 4, JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total) values ('${B}','T-A-HACK','x','1','llevar','[]',1000,1000)`);
T('dA no inserta con restaurante_id de B', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.pedidos (referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total) values ('T-A-DEF','x','1','llevar','[]',1000,1000)`);
T('dA no inserta sin restaurante_id (el defecto transitorio es Taqueiros)', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `update public.pedidos set estado = 'listo' where id = ${pB1.id}`);
T('dA no actualiza pedido de B (0 filas)', denegado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `delete from public.pedidos where id = ${pB1.id}`);
T('dA no borra pedido de B', denegado(r));
r = await intentar(db, u.dA, `update public.pedidos set estado = 'en_preparacion' where id = ${pA1.id}`);
T('dA actualiza estado de su pedido', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, u.dA, `update public.pedidos set total = 1, subtotal = 1 where id = ${pA1.id}`);
T('dA no cambia el dinero (trigger)', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `update public.pedidos set numero = 77 where id = ${pA1.id}`);
T('dA no cambia el numero', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `update public.pedidos set restaurante_id = '${B}' where id = ${pA1.id}`);
T('dA no mueve un pedido a B', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `delete from public.pedidos where id = ${pA2.id}`);
T('dA no borra pedido pagado (se conserva el historial)', denegado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `select public.reclamar_impresion(${pB1.id})`);
T('dA: reclamar_impresion sobre pedido de B rechazado (42501)', rechazado(r) && r.code === '42501', JSON.stringify(r));
r = await intentar(db, u.dA, `select public.registrar_reimpresion(${pB1.id})`);
T('dA: registrar_reimpresion sobre pedido de B rechazado', rechazado(r) && r.code === '42501', JSON.stringify(r));
r = await intentar(db, u.dA, `select public.reclamar_impresion(${pA2.id}) as v`);
T('dA reclama impresion propia (true)', r.ok && r.rows[0].v === true, JSON.stringify(r));
r = await intentar(db, u.dA, `select public.reclamar_impresion(${pA2.id}) as v`);
T('segundo reclamo = false', r.ok && r.rows[0].v === false, JSON.stringify(r));
r = await intentar(db, u.dA, `select public.registrar_reimpresion(${pA2.id}) as v`);
T('dA registra reimpresion propia (1)', r.ok && r.rows[0].v === 1, JSON.stringify(r));
r = await intentar(db, u.dA, `select public.reclamar_impresion(999999)`);
T('pedido inexistente rechazado', rechazado(r));

console.log('--- menu y configuracion');
r = await intentar(db, u.dA, `insert into public.categorias (restaurante_id, id, nombre) values ('${A}', 'nueva', 'Nueva')`);
T('dA crea categoria en A', r.ok, JSON.stringify(r));
r = await intentar(db, u.dB, `insert into public.categorias (restaurante_id, id, nombre) values ('${B}', 'nueva', 'Nueva')`);
T('dB crea categoria con el MISMO id y nombre en B (unicos por restaurante)', r.ok, JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.categorias (restaurante_id, id, nombre) values ('${A}', 'otra', 'nueva')`);
T('dentro de A el nombre sigue siendo unico', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.categorias (restaurante_id, id, nombre) values ('${B}', 'x', 'X')`);
T('dA no crea categoria en B', rechazado(r));
r = await intentar(db, u.dA, `update public.categorias set nombre = 'Hack' where restaurante_id = '${B}'`);
T('dA no edita categorias de B', denegado(r));
r = await intentar(db, u.dA, `insert into public.productos (restaurante_id, id, nombre, precio, categoria) values ('${A}', 'p2', 'P2', 5000, 'cat-b')`);
T('producto de A no puede apuntar a categoria de B', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.productos (restaurante_id, id, nombre, precio, categoria) values ('${A}', 'p2', 'P2', 5000, 'cat-a')`);
T('dA crea producto en A', r.ok, JSON.stringify(r));
r = await intentar(db, u.dB, `insert into public.productos (restaurante_id, id, nombre, precio, categoria) values ('${B}', 'p2', 'P2', 5000, 'cat-b')`);
T('dB crea producto con el mismo id (p2) en B', r.ok, JSON.stringify(r));
r = await intentar(db, u.dA, `update public.productos set precio = 1 where id = 'prod-b'`);
T('dA no edita productos de B', denegado(r));
r = await intentar(db, u.dA, `delete from public.productos where id = 'prod-b'`);
T('dA no borra productos de B', denegado(r));
r = await intentar(db, u.dA, `select id from public.productos`);
T('dA solo ve sus productos', r.ok && r.rows.every((x) => ['prod-a', 'p2'].includes(x.id)) && r.rows.length === 2, JSON.stringify(r));
r = await intentar(db, u.dA, `update public.productos set imagen = 'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/${B}/x.png' where id = 'prod-a'`);
T('dA no apunta su producto a la carpeta de B', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `update public.productos set imagen = 'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/${A}/x.png' where id = 'prod-a'`);
T('dA apunta su producto a su carpeta', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, u.dA, `update public.productos set imagen = 'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/p-abc.webp' where id = 'prod-a'`);
T('dA no usa la ruta plana (solo Taqueiros)', rechazado(r), JSON.stringify(r));

r = await intentar(db, u.cA, `select id from public.productos`);
T('cajero A lee el menu', r.ok && r.rows.length === 2);
for (const [q, nombre] of [
  [`insert into public.productos (restaurante_id, id, nombre, precio, categoria) values ('${A}', 'p3', 'P3', 5000, 'cat-a')`, 'inserta producto'],
  [`update public.productos set precio = 2 where id = 'prod-a'`, 'edita producto'],
  [`delete from public.productos where id = 'prod-a'`, 'borra producto'],
  [`insert into public.categorias (restaurante_id, id, nombre) values ('${A}', 'c3', 'C3')`, 'inserta categoria'],
  [`update public.categorias set nombre = 'Z' where id = 'cat-a'`, 'edita categoria'],
  [`delete from public.categorias where id = 'cat-a'`, 'borra categoria'],
  [`update public.configuracion set cerrado_temporal = true where restaurante_id = '${A}'`, 'edita configuracion'],
  [`insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${A}', 3, 1000)`, 'inserta tarifa'],
]) { r = await intentar(db, u.cA, q); T(`cajero A NO ${nombre}`, denegado(r), JSON.stringify(r)); }
r = await intentar(db, u.cA, `select * from public.configuracion`);
T('cajero A lee configuracion (solo A)', r.ok && r.rows.length === 1 && r.rows[0].restaurante_id === A, JSON.stringify(r).slice(0, 100));
r = await intentar(db, u.cA, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total, estado, estado_pago) values ('${A}','T-A-C','x','1','local','[]',1000,1000,'nuevo','aprobado') returning numero`);
T('cajero A crea pedidos', r.ok, JSON.stringify(r));
r = await intentar(db, u.cA, `update public.pedidos set estado = 'listo' where id = ${pA1.id}`);
T('cajero A actualiza pedidos', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, u.cA, `delete from public.pedidos where id = ${pA1.id}`);
T('cajero A no borra pedidos', denegado(r));
r = await intentar(db, u.cA, `select public.reclamar_impresion(${pA1.id})`);
T('cajero A puede usar reclamar_impresion en lo suyo', r.ok, JSON.stringify(r));

r = await intentar(db, u.dA, `update public.configuracion set cerrado_temporal = true where restaurante_id = '${A}'`);
T('dueno A edita su configuracion', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, u.dA, `update public.configuracion set cerrado_temporal = true where restaurante_id = '${B}'`);
T('dueno A no edita configuracion de B', denegado(r));
r = await intentar(db, u.dA, `update public.configuracion set restaurante_id = '${B}' where restaurante_id = '${A}'`);
T('dueno A no mueve su configuracion a B', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.configuracion (restaurante_id, horarios) values ('${A}', '[]')`);
T('dueno no crea otra fila de configuracion (lo frena RLS, no la llave primaria)', rechazado(r) && r.code === '42501', JSON.stringify(r));
r = await intentar(db, u.dA, `delete from public.configuracion where restaurante_id = '${A}'`);
T('dueno no borra su configuracion', denegado(r));
r = await intentar(db, u.dA, `insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${A}', 3, 1000)`);
T('dueno A crea tarifa', r.ok, JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${B}', 3, 1000)`);
T('dueno A no crea tarifa en B', rechazado(r));
r = await intentar(db, u.dA, `select * from public.salud_notificaciones`);
T('dueno A ve su salud_notificaciones (1 fila)', r.ok && r.rows.length === 1 && r.rows[0].restaurante_id === A);
r = await intentar(db, u.dA, `update public.salud_notificaciones set fallos_seguidos = 9`);
T('dueno A no escribe salud_notificaciones', denegado(r));

console.log('--- cocina A');
r = await intentar(db, u.kA, `select id from public.pedidos`);
T('cocina lee pedidos de A', r.ok && r.rows.length >= 2);
r = await intentar(db, u.kA, `select * from public.productos`);
T('cocina no lee el menu', r.ok && r.rows.length === 0);
r = await intentar(db, u.kA, `select * from public.configuracion`);
T('cocina no lee configuracion', r.ok && r.rows.length === 0);
r = await intentar(db, u.kA, `update public.pedidos set estado = 'listo' where id = ${pA1.id}`);
T('cocina cambia el estado', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, u.kA, `update public.pedidos set cliente_nombre = 'Hack' where id = ${pA1.id}`);
T('cocina NO edita otras columnas', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.kA, `update public.pedidos set direccion = 'x', estado = 'listo' where id = ${pA1.id}`);
T('cocina NO edita columnas aunque cambie estado a la vez', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.kA, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total) values ('${A}','T-K','x','1','llevar','[]',1,1)`);
T('cocina no crea pedidos', rechazado(r));
r = await intentar(db, u.kA, `delete from public.pedidos where id = ${pA1.id}`);
T('cocina no borra pedidos', denegado(r));
r = await intentar(db, u.kA, `select public.reclamar_impresion(${pA1.id})`);
T('cocina puede reclamar impresion (imprime los tickets)', r.ok, JSON.stringify(r));
r = await intentar(db, u.kA, `update public.pedidos set estado = 'listo' where id = ${pB1.id}`);
T('cocina A no toca pedidos de B', denegado(r));

console.log('--- dueno B (espejo)');
r = await intentar(db, u.dB, `select restaurante_id from public.pedidos`);
T('dB ve solo pedidos de B', r.ok && r.rows.length === 2 && r.rows.every((x) => x.restaurante_id === B));
r = await intentar(db, u.dB, `update public.pedidos set estado = 'listo' where id = ${pA1.id}`);
T('dB no actualiza pedidos de A', denegado(r));
r = await intentar(db, u.dB, `select public.reclamar_impresion(${pA1.id})`);
T('dB: reclamar_impresion de A rechazada', rechazado(r));

console.log('--- restaurantes, miembros, secretos, superadmins');
r = await intentar(db, u.dA, `select id from public.restaurantes`);
T('dA ve solo su restaurante', r.ok && r.rows.length === 1 && r.rows[0].id === A, JSON.stringify(r));
r = await intentar(db, u.dA, `update public.restaurantes set nombre = 'Nuevo nombre', config = '{"color":"#fff"}' where id = '${A}'`);
T('dA cambia nombre y config', r.ok && r.n === 1, JSON.stringify(r));
for (const [col, val] of [['plan', "'basico'"], ['estado', "'suspendido'"], ['slug', "'otro-slug'"], ['vigente_hasta', "'2030-01-01'"], ['modulos', `'{"pasarela":false}'::jsonb`], ['dias_gracia', '99'], ['modalidad_pago', "'unico'"]]) {
  r = await intentar(db, u.dA, `update public.restaurantes set ${col} = ${val} where id = '${A}'`);
  T(`dA no puede cambiar ${col}`, rechazado(r), JSON.stringify(r));
}
r = await intentar(db, u.dA, `update public.restaurantes set nombre = 'Hack' where id = '${B}'`);
T('dA no edita B', denegado(r));
r = await intentar(db, u.dA, `delete from public.restaurantes where id = '${A}'`);
T('dA no borra su restaurante (0 filas, sin llegar a las llaves foraneas)', r.ok && r.n === 0, JSON.stringify(r));
r = await intentar(db, u.dA, `select * from public.restaurante_secretos`);
T('dA no lee restaurante_secretos', denegado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `update public.restaurante_secretos set callmebot_apikey = 'x'`);
T('dA no escribe restaurante_secretos', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `select * from public.contadores_pedido`);
T('dA no lee contadores_pedido', denegado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `select public.siguiente_numero_pedido('${A}')`);
T('dA no llama siguiente_numero_pedido', rechazado(r), JSON.stringify(r));
r = await intentar(db, u.dA, `select user_id from public.miembros`);
T('dA solo ve su propia membresia', r.ok && r.rows.length === 1 && r.rows[0].user_id === u.dA, JSON.stringify(r));
r = await intentar(db, u.dA, `insert into public.miembros (user_id, restaurante_id, rol) values ('${u.sin}', '${A}', 'cajero')`);
T('dA no agrega miembros directo (lo hace el servidor)', rechazado(r));
r = await intentar(db, u.dA, `update public.miembros set rol = 'dueno' where user_id = '${u.cA}'`);
T('dA no cambia roles directo', denegado(r));
r = await intentar(db, u.cA, `update public.miembros set rol = 'dueno' where user_id = '${u.cA}'`);
T('cajero no se asciende a si mismo', denegado(r));
r = await intentar(db, u.dA, `insert into public.superadmins (user_id) values ('${u.dA}')`);
T('dA no se hace superadmin', rechazado(r));
r = await intentar(db, u.dA, `select * from public.superadmins`);
T('dA no ve superadmins', r.ok && r.rows.length === 0);
r = await intentar(db, u.dA, `select public.realinear_secuencia_pedidos()`);
T('dA no ejecuta realinear_secuencia_pedidos', rechazado(r));
r = await intentar(db, u.dA, `select public.es_servidor()`);
T('es_servidor() es false para un cliente', r.ok && r.rows[0].es_servidor === false, JSON.stringify(r));

console.log('--- superadmin');
r = await intentar(db, u.sa, `select distinct restaurante_id from public.pedidos`);
T('superadmin ve pedidos de todos', r.ok && r.rows.length >= 3, JSON.stringify(r).slice(0, 120));
r = await intentar(db, u.sa, `update public.restaurantes set plan = 'basico', estado = 'activo' where id = '${B}'`);
T('superadmin cambia plan y estado', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, u.sa, `insert into public.restaurantes (slug, nombre) values ('test-c', 'C') returning id`);
T('superadmin crea restaurante (se aprovisiona solo)', r.ok, JSON.stringify(r));
if (r.ok) {
  const C = r.rows[0].id;
  const k = (await db.query(`select (select count(*) from public.configuracion where restaurante_id = '${C}' and id = 0) cfg, (select count(*) from public.restaurante_secretos where restaurante_id = '${C}') sec, (select count(*) from public.contadores_pedido where restaurante_id = '${C}') cnt, (select count(*) from public.salud_notificaciones where restaurante_id = '${C}' and id = 0) sal`)).rows[0];
  T('restaurante nuevo: config(id=0), secretos, contador y salud creados', k.cfg == 1 && k.sec == 1 && k.cnt == 1 && k.sal == 1, JSON.stringify(k));
}
r = await intentar(db, u.sa, `select * from public.restaurante_secretos`);
T('superadmin tampoco lee secretos desde el navegador (solo el servidor)', denegado(r));
r = await intentar(db, u.sa, `insert into public.restaurantes (slug, nombre) values ('Mal_Slug', 'x')`);
T('slug invalido rechazado (mayusculas/guion bajo)', rechazado(r));
r = await intentar(db, u.sa, `insert into public.restaurantes (slug, nombre) values ('-mal', 'x')`);
T('slug que empieza con guion rechazado', rechazado(r));

console.log('--- storage');
const obj = (name, uid) => intentar(db, uid, `insert into storage.objects (bucket_id, name, owner) values ('productos', $1, $2)`, [name, uid]);
T('dA sube a su carpeta', (await obj(`${A}/f.png`, u.dA)).ok);
T('dA sube en subcarpeta propia', (await obj(`${A}/sub/f.png`, u.dA)).ok);
T('dA NO sube a la carpeta de B', rechazado(await obj(`${B}/f.png`, u.dA)));
T('dA NO sube a la raiz', rechazado(await obj(`f.png`, u.dA)));
T('dA NO usa ../ para escapar', rechazado(await obj(`${A}/../${B}/f.png`, u.dA)));
T('cajero A NO sube fotos', rechazado(await obj(`${A}/c.png`, u.cA)));
T('cocina A NO sube fotos', rechazado(await obj(`${A}/k.png`, u.kA)));
T('sin membresia NO sube', rechazado(await obj(`${A}/s.png`, u.sin)));
T('anon NO sube', rechazado(await intentar(db, null, `insert into storage.objects (bucket_id, name) values ('productos', '${A}/an.png')`, [], { rol: 'anon' })));
T('dueno de Taqueiros sube a la raiz (transitorio, menu-admin actual)', (await obj(`p-abc.webp`, U.dueno_taq)).ok);
T('dueno de Taqueiros sube a su carpeta', (await obj(`${TAQ}/n.webp`, U.dueno_taq)).ok);
T('dueno de Taqueiros NO sube a la carpeta de A', rechazado(await obj(`${A}/t.png`, U.dueno_taq)));
r = await intentar(db, u.dA, `select name from storage.objects`);
T('dA solo lista sus fotos', r.ok && r.rows.every((x) => x.name.startsWith(A + '/')), JSON.stringify(r).slice(0, 150));
r = await intentar(db, u.dA, `delete from storage.objects where name = 'p-abc.webp'`);
T('dA no borra fotos de la raiz (de Taqueiros)', denegado(r));
r = await intentar(db, u.dB, `delete from storage.objects where name like '${A}/%'`);
T('dB no borra fotos de A', denegado(r));
r = await intentar(db, u.dA, `delete from storage.objects where name = '${A}/sub/f.png'`);
T('dA borra fotos propias', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, U.dueno_taq, `delete from storage.objects where name = 'p-abc.webp'`);
T('dueno Taqueiros borra foto de la raiz', r.ok && r.n === 1, JSON.stringify(r));

console.log('--- historial / jornada por restaurante');
r = await intentar(db, u.dA, `select * from public.limites_jornada()`);
T('limites_jornada() sin parametros (como el panel) devuelve 1 fila', r.ok && r.rows.length === 1, JSON.stringify(r).slice(0, 150));
r = await intentar(db, u.dA, `select public.resumen_jornada() as r`);
T('resumen_jornada() de A cuenta solo A', r.ok && r.rows[0].r && r.rows[0].r.num_pedidos <= 4, JSON.stringify(r).slice(0, 200));
r = await intentar(db, u.dA, `select public.resumen_jornada(p_restaurante => '${B}') as r`);
T('dA pidiendo el resumen de B recibe null', r.ok && r.rows[0].r === null, JSON.stringify(r));
r = await intentar(db, u.dA, `select * from public.buscar_historial()`);
T('buscar_historial de A: solo pedidos de A', r.ok && r.rows.length > 0 && r.rows.every((x) => x.restaurante_id === A), JSON.stringify(r).slice(0, 150));
r = await intentar(db, u.dA, `select * from public.buscar_historial(referencia => 'T-A-1')`);
T('buscar_historial: el filtro por referencia ahora SI filtra', r.ok && r.rows.length === 1, JSON.stringify(r).slice(0, 150));
r = await intentar(db, u.dA, `select * from public.buscar_historial(p_restaurante => '${B}')`);
T('dA pidiendo historial de B recibe vacio', r.ok && r.rows.length === 0);
r = await intentar(db, u.dA, `select * from public.buscar_historial(telefono => '3000000000')`);
T('buscar_historial: filtro por telefono', r.ok && r.rows.length > 0);
r = await intentar(db, u.dA, `select * from public.jornadas_con_pedidos(10)`);
T('jornadas_con_pedidos(10) funciona', r.ok && r.rows.length >= 1, JSON.stringify(r).slice(0, 150));
r = await intentar(db, u.sa, `select * from public.buscar_historial(p_restaurante => '${B}')`);
T('superadmin ve historial de B', r.ok && r.rows.length > 0);

console.log('--- compatibilidad: lo que hace el codigo actual con el usuario del panel (dueno de Taqueiros)');
const P = U.dueno_taq;
r = await intentar(db, P, `select * from public.pedidos where estado <> 'pendiente_pago' order by creado_en desc limit 200`);
T('panel: select de pedidos', r.ok && r.rows.length >= 3 && r.rows.every((x) => x.restaurante_id === TAQ), JSON.stringify(r).slice(0, 120));
r = await intentar(db, P, `select * from public.limites_jornada()`);
T('panel: limites_jornada()', r.ok && r.rows.length === 1 && r.rows[0].minutos_ocultar == 15, JSON.stringify(r).slice(0, 200));
r = await intentar(db, P, `select * from public.configuracion where id = 1`);
T('panel: configuracion id=1 es la de Taqueiros', r.ok && r.rows.length === 1 && r.rows[0].restaurante_id === TAQ);
r = await intentar(db, P, `update public.configuracion set cerrado_temporal = true where id = 1`);
T('panel: update configuracion eq id=1', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, P, `update public.configuracion set cerrado_temporal = false where id = 1`);
r = await intentar(db, P, `select * from public.salud_notificaciones where id = 1`);
T('panel: salud_notificaciones eq id=1', r.ok && r.rows.length === 1);
r = await intentar(db, P, `update public.pedidos set estado = 'en_preparacion' where id = 4`);
T('panel: update estado de pedido de Taqueiros', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, P, `select public.reclamar_impresion(4) as v`);
T('panel: reclamar_impresion(4)', r.ok && typeof r.rows[0].v === 'boolean', JSON.stringify(r));
r = await intentar(db, P, `select public.registrar_reimpresion(4) as v`);
T('panel: registrar_reimpresion(4)', r.ok && r.rows[0].v >= 1, JSON.stringify(r));
r = await intentar(db, P, `select impreso_en from public.pedidos limit 1`);
T('panel: comprobarColumnasImpresion (select impreso_en)', r.ok);
r = await intentar(db, P, `select * from public.categorias order by orden`);
T('menu-admin: lee categorias (6)', r.ok && r.rows.length === 6, JSON.stringify(r).slice(0, 80));
r = await intentar(db, P, `select * from public.productos order by orden`);
T('menu-admin: lee productos (38)', r.ok && r.rows.length === 38, JSON.stringify(r).slice(0, 80));
r = await intentar(db, P, `insert into public.categorias (id, nombre, emoji, orden) values ('postres', 'Postres', '🍰', 9) returning restaurante_id`);
T('menu-admin: inserta categoria SIN restaurante_id -> queda en Taqueiros', r.ok && r.rows[0].restaurante_id === TAQ, JSON.stringify(r));
r = await intentar(db, P, `insert into public.productos (id, nombre, descripcion, precio, categoria, orden, disponible, imagen) values ('flan', 'Flan', null, 7000, 'postres', 0, true, null) returning restaurante_id`);
T('menu-admin: inserta producto SIN restaurante_id', r.ok && r.rows[0].restaurante_id === TAQ, JSON.stringify(r));
r = await intentar(db, P, `update public.productos set disponible = false where id = 'flan'`);
T('menu-admin: update producto eq id', r.ok && r.n === 1);
r = await intentar(db, P, `update public.productos set imagen = 'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/p-abc123.webp' where id = 'flan'`);
T('menu-admin: foto plana nueva en Taqueiros (ruta p-xxxx.webp)', r.ok && r.n === 1, JSON.stringify(r));
r = await intentar(db, P, `update public.categorias set activa = false where id = 'postres'`);
T('menu-admin: apaga categoria', r.ok && r.n === 1);
r = await intentar(db, P, `delete from public.productos where id = 'flan'`);
T('menu-admin: borra producto', r.ok && r.n === 1);
r = await intentar(db, P, `delete from public.categorias where id = 'postres'`);
T('menu-admin: borra categoria', r.ok && r.n === 1);
r = await intentar(db, P, `select * from public.resumen_jornada()`);
T('historial: resumen_jornada()', r.ok);
r = await intentar(db, P, `select * from public.jornadas_con_pedidos(limite => 60)`);
T('historial: jornadas_con_pedidos(limite)', r.ok);
r = await intentar(db, P, `select * from public.buscar_historial(fecha_desde => null, fecha_hasta => null, telefono => '', referencia => '')`);
T('historial: buscar_historial con los 4 parametros', r.ok);

console.log('--- servidor (service_role): lo que hace api/*.js');
const S = async (q, p = []) => como(db, null, async () => { try { const x = await db.query(q, p); return { ok: true, rows: x.rows, n: x.affectedRows ?? x.rows.length }; } catch (e) { return { ok: false, error: e.message }; } }, { rol: 'service_role' });
r = await S(`insert into public.pedidos (referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, wompi_ambiente) values ('TAQ-SRV-1','pendiente_pago','S','3','llevar','[]',1000,0,1000,'pendiente','test') returning restaurante_id, numero, id`);
T('crear-pedido (service_role): sin restaurante_id queda en Taqueiros con numero siguiente', r.ok && r.rows[0].restaurante_id === TAQ, JSON.stringify(r));
r = await S(`update public.pedidos set estado_pago = 'aprobado', estado = 'nuevo', pagado_en = now(), wompi_transaction_id = 'w1' where referencia = 'TAQ-SRV-1' returning id`);
T('webhook (service_role): marca pagado (cambia estado_pago)', r.ok && r.n === 1, JSON.stringify(r));
r = await S(`select * from public.pedidos where estado = 'nuevo' and alerta_enviada = false and pagado_en < now()`);
T('alertas (service_role) consulta', r.ok);
r = await S(`select * from public.configuracion where id = 1`);
T('estado (service_role): configuracion id=1 -> 1 fila', r.ok && r.rows.length === 1, JSON.stringify(r).slice(0, 100));
r = await S(`select id from public.productos where disponible is false`);
T('disponibilidad (service_role): productos', r.ok);
r = await S(`update public.salud_notificaciones set fallos_seguidos = 2 where id = 1 returning fallos_seguidos`);
T('notificar (service_role): salud id=1 -> solo 1 fila', r.ok && r.n === 1, JSON.stringify(r));
r = await S(`select public.limpiar_pedidos_huerfanos(24) as n`);
T('keep-alive (service_role): limpiar_pedidos_huerfanos', r.ok, JSON.stringify(r));
r = await S(`select public.realinear_secuencia_pedidos() as n`);
T('service_role realinea la secuencia', r.ok && r.rows[0].n > 0, JSON.stringify(r));
r = await S(`select public.siguiente_numero_pedido('${A}') as n`);
T('service_role llama siguiente_numero_pedido', r.ok, JSON.stringify(r));
r = await S(`select * from public.restaurante_secretos where restaurante_id = '${TAQ}'`);
T('service_role lee secretos', r.ok && r.rows.length === 1, JSON.stringify(r));

console.log('--- concurrencia del contador (dos sesiones no reciben el mismo numero)');
{
  const vals = [];
  for (let i = 0; i < 6; i++) vals.push((await db.query(`select public.siguiente_numero_pedido('${B}') n`)).rows[0].n);
  T('numeros consecutivos y distintos', new Set(vals.map(Number)).size === 6 && Number(vals[5]) - Number(vals[0]) === 5, vals.join(','));
}

console.log('--- la tabla legada personal');
await db.query(`insert into auth.users (id, email) values ('${U.extra}', 'e@x.test')`);
await db.query(`insert into public.personal (id, nombre) values ('${U.extra}', 'Nuevo')`);
r = (await db.query(`select rol, activo from public.miembros where user_id = '${U.extra}'`)).rows;
T('insert en personal -> miembro dueno de Taqueiros', r.length === 1 && r[0].rol === 'dueno' && r[0].activo === true, JSON.stringify(r));
await db.query(`delete from public.personal where id = '${U.extra}'`);
r = (await db.query(`select activo from public.miembros where user_id = '${U.extra}'`)).rows;
T('delete en personal -> miembro inactivo', r.length === 1 && r[0].activo === false, JSON.stringify(r));
r = await intentar(db, U.extra, `select count(*) from public.pedidos`);
T('un miembro inactivo ya no ve pedidos', r.ok && r.rows[0].count == 0, JSON.stringify(r));

console.log('--- ataques agregados en la revision por mutacion');
{
  // Un UPDATE/DELETE SIN WHERE no lee columnas, asi que Postgres no le aplica la politica
  // de SELECT: lo unico que lo limita es el USING de la propia politica de UPDATE/DELETE.
  const estadoB = async () => (await db.query(`select estado from public.pedidos where id = ${pB2.id}`)).rows[0].estado;
  const antesB = await estadoB();
  r = await intentar(db, u.kA, `update public.pedidos set estado = 'cancelado'`);
  T('cocina A: UPDATE sin WHERE no toca pedidos de B', (await estadoB()) === antesB, JSON.stringify(r).slice(0, 120));
  const precioB = async () => (await db.query(`select precio from public.productos where restaurante_id = '${B}' and id = 'prod-b'`)).rows[0].precio;
  r = await intentar(db, u.dA, `update public.productos set precio = 1`);
  T('dueno A: UPDATE sin WHERE no toca productos de B', (await precioB()) === 1000, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.dA, `update public.categorias set nombre = nombre || ' x'`);
  T('dueno A: UPDATE sin WHERE no toca categorias de B', (await db.query(`select nombre from public.categorias where restaurante_id = '${B}' and id = 'cat-b'`)).rows[0].nombre === 'Cat B');
  r = await intentar(db, u.dA, `update public.configuracion set mensaje_cerrado = 'HACK'`);
  T('dueno A: UPDATE sin WHERE no toca configuraciones ajenas', (await db.query(`select count(*)::int n from public.configuracion where mensaje_cerrado = 'HACK' and restaurante_id <> '${A}'`)).rows[0].n === 0);
  r = await intentar(db, u.dA, `update public.tarifas_domicilio set precio = 1`);
  T('dueno A: UPDATE sin WHERE no toca tarifas ajenas', (await db.query(`select count(*)::int n from public.tarifas_domicilio where precio = 1 and restaurante_id <> '${A}'`)).rows[0].n === 0);
  r = await intentar(db, u.dA, `update public.restaurantes set nombre = 'HACK'`);
  T('dueno A: UPDATE sin WHERE no renombra otros restaurantes', (await db.query(`select count(*)::int n from public.restaurantes where nombre = 'HACK' and id <> '${A}'`)).rows[0].n === 0);
  r = await intentar(db, u.dA, `update public.miembros set rol = 'dueno'`);
  T('dueno A: UPDATE sin WHERE no cambia membresias', (await db.query(`select rol from public.miembros where user_id = '${u.cA}'`)).rows[0].rol === 'cajero');
  r = await intentar(db, u.dA, `update public.salud_notificaciones set fallos_seguidos = 77`);
  T('dueno A: UPDATE sin WHERE no toca salud_notificaciones', (await db.query(`select count(*)::int n from public.salud_notificaciones where fallos_seguidos = 77`)).rows[0].n === 0);
  // Se cuenta TODO lo que no es de A (B y Taqueiros)
  const cuenta = async (t) => (await db.query(`select count(*)::int n from public.${t} where restaurante_id <> '${A}'`)).rows[0].n;
  await db.exec(`insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${B}', 3, 3000)`);
  for (const t of ['pedidos', 'productos', 'tarifas_domicilio', 'configuracion', 'salud_notificaciones']) {
    const n0 = await cuenta(t);
    r = await intentar(db, u.dA, `delete from public.${t}`);
    T(`dueno A: DELETE sin WHERE no borra ${t} de otros restaurantes`, (await cuenta(t)) === n0, JSON.stringify(r).slice(0, 100));
  }
  await db.exec(`insert into public.categorias (restaurante_id, id, nombre) values ('${B}', 'cat-sola', 'Sola B')`);
  r = await intentar(db, u.dA, `delete from public.categorias`);
  // Sus productos ya se borraron: si la politica solo alcanza las categorias de A, el DELETE funciona;
  // si alcanzara las ajenas, chocaria con los productos de B y de Taqueiros (llave foranea).
  T('dueno A: DELETE sin WHERE en categorias solo alcanza las de A', r.ok && (await db.query(`select count(*)::int n from public.categorias where restaurante_id = '${B}' and id = 'cat-sola'`)).rows[0].n === 1, JSON.stringify(r).slice(0, 140));
  const miembrosAjenos = async () => (await db.query(`select count(*)::int n from public.miembros where user_id <> '${u.dA}'`)).rows[0].n;
  const m0 = await miembrosAjenos();
  r = await intentar(db, u.dA, `delete from public.miembros`);
  T('dueno A: DELETE sin WHERE en miembros no borra ninguna membresia', (await miembrosAjenos()) === m0 && (await db.query(`select count(*)::int n from public.miembros where user_id = '${u.dA}'`)).rows[0].n === 1, JSON.stringify(r).slice(0, 100));
  r = await intentar(db, u.dA, `delete from public.restaurantes`);
  T('dueno A: DELETE sin WHERE en restaurantes no alcanza ninguno (0 filas, sin errores de llaves)', r.ok && r.n === 0, JSON.stringify(r).slice(0, 140));
  const n0 = await cuenta('categorias');
  r = await intentar(db, u.dB, `delete from public.productos where id = 'p2'`);
  r = await intentar(db, u.dA, `delete from public.categorias where id = 'nueva'`);
  T('dueno A: borrar SU categoria no toca la de B con el mismo id', (await cuenta('categorias')) === n0, JSON.stringify(r).slice(0, 100));

  // WITH CHECK de pedidos: un pedido no vuelve a 'pendiente_pago' desde el navegador
  r = await intentar(db, u.dA, `update public.pedidos set estado = 'pendiente_pago' where id = ${pA1.id}`);
  T('dueno A NO devuelve un pedido a pendiente_pago (WITH CHECK)', !r.ok || r.n === 0, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.kA, `update public.pedidos set estado = 'pendiente_pago' where id = ${pA1.id}`);
  T('cocina A NO devuelve un pedido a pendiente_pago', !r.ok || r.n === 0, JSON.stringify(r).slice(0, 120));

  // Un usuario que es miembro de A y de B: el WITH CHECK lo deja escribir en los dos,
  // solo el trigger impide MOVER filas de uno a otro.
  const dAB = 'f0000000-0000-4000-8000-0000000000ab';
  await db.query(`insert into auth.users (id, email) values ($1, 'dab@t.test')`, [dAB]);
  await db.exec(`insert into public.miembros (user_id, restaurante_id, rol) values ('${dAB}', '${A}', 'dueno'), ('${dAB}', '${B}', 'dueno');
    insert into public.categorias (restaurante_id, id, nombre) values ('${A}', 'cat-mover', 'Mover') on conflict do nothing;
    insert into public.productos (restaurante_id, id, nombre, precio, categoria) values ('${A}', 'prod-mover', 'Mover', 1000, 'cat-mover');
    insert into public.categorias (restaurante_id, id, nombre) values ('${B}', 'cat-mover', 'Mover') on conflict do nothing;
    insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${A}', 77, 7000);`);
  r = await intentar(db, dAB, `update public.pedidos set restaurante_id = '${B}' where id = ${pA2.id}`);
  T('dueno de A y de B NO mueve un pedido de A a B', !r.ok && (await db.query(`select restaurante_id from public.pedidos where id = ${pA2.id}`)).rows[0].restaurante_id === A, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, dAB, `update public.productos set restaurante_id = '${B}' where restaurante_id = '${A}' and id = 'prod-mover'`);
  T('dueno de A y de B NO mueve un producto de A a B', !r.ok, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, dAB, `update public.tarifas_domicilio set restaurante_id = '${B}' where restaurante_id = '${A}' and hasta = 77`);
  T('dueno de A y de B NO mueve tarifas de A a B', !r.ok, JSON.stringify(r).slice(0, 120));

  // UPSERT contra una fila ajena: el ON CONFLICT DO UPDATE no puede pisar la fila de B
  const refB = (await db.query(`select referencia, cliente_nombre from public.pedidos where id = ${pB1.id}`)).rows[0];
  r = await intentar(db, u.dA, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total)
     values ('${A}', '${refB.referencia}', 'HACK', '1', 'llevar', '[]', 1000, 1000)
     on conflict (referencia) do update set cliente_nombre = excluded.cliente_nombre`);
  T('dueno A NO pisa un pedido de B con un upsert por referencia', !r.ok && (await db.query(`select cliente_nombre from public.pedidos where id = ${pB1.id}`)).rows[0].cliente_nombre === refB.cliente_nombre, JSON.stringify(r).slice(0, 120));
  const contB = async () => (await db.query(`select ultimo from public.contadores_pedido where restaurante_id = '${B}'`)).rows[0].ultimo;
  const c0 = await contB();
  r = await intentar(db, u.dA, `insert into public.pedidos (restaurante_id, referencia, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total) values ('${B}', 'T-CONTADOR', 'x', '1', 'llevar', '[]', 1000, 1000)`);
  T('un INSERT rechazado en B no consume el contador de B', !r.ok && (await contB()) === c0, `antes ${c0}, despues ${await contB()}`);

  // Storage: la raiz (fotos actuales de Taqueiros) no la reemplaza ni borra otro dueno
  await db.query(`insert into storage.objects (bucket_id, name) values ('productos', 'p-taqueiros.webp')`);
  r = await intentar(db, u.dA, `update storage.objects set owner = '${u.dA}' where name = 'p-taqueiros.webp'`);
  T('dueno A NO reemplaza (UPDATE) una foto de Taqueiros en la raiz', !r.ok || r.n === 0, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.dA, `update storage.objects set name = '${A}/robada.webp' where name = 'p-taqueiros.webp'`);
  T('dueno A NO mueve a su carpeta una foto de Taqueiros', (await db.query(`select count(*)::int n from storage.objects where name = 'p-taqueiros.webp'`)).rows[0].n === 1, JSON.stringify(r).slice(0, 120));
  await db.query(`insert into storage.objects (bucket_id, name) values ('productos', '${A}/propia.webp')`);
  r = await intentar(db, u.dA, `update storage.objects set name = '${B}/plantada.webp' where name = '${A}/propia.webp'`);
  T('dueno A NO mueve su foto a la carpeta de B', !r.ok || r.n === 0, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.dA, `delete from storage.objects`);
  T('dueno A: DELETE sin WHERE en Storage solo borra lo suyo', (await db.query(`select count(*)::int n from storage.objects where name = 'p-taqueiros.webp' or name like '${B}/%'`)).rows[0].n >= 1, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.dA, `insert into storage.objects (bucket_id, name) values ('productos', 'p-${'x'}.webp')`);
  T('dueno A NO crea fotos nuevas en la raiz', !r.ok, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.dA, `insert into storage.objects (bucket_id, name) values ('productos', '/${B}/x.png')`);
  T('dueno A NO escribe en B con una barra inicial', !r.ok, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.dA, `insert into storage.objects (bucket_id, name) values ('productos', '${A.toUpperCase()}/x.png')`);
  T('una carpeta en MAYUSCULAS no se toma por la propia (comparacion exacta)', !r.ok, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.dA, `insert into storage.objects (bucket_id, name) values ('otro-bucket', '${A}/x.png')`);
  T('dueno A no escribe en otros buckets', !r.ok, JSON.stringify(r).slice(0, 120));

  // es_personal: la funcion "es_" que anon podia llamar en produccion
  r = await intentar(db, null, `select public.es_personal()`, [], { rol: 'anon' });
  T('anon ya no ejecuta es_personal()', !r.ok, JSON.stringify(r).slice(0, 120));
  r = await intentar(db, u.sin, `select public.es_personal() as v`);
  T('es_personal() es false para alguien sin membresia', r.ok && r.rows[0].v === false, JSON.stringify(r));
}

console.log(`\n${total - fallas}/${total} pruebas pasan, ${fallas} fallan`);
process.exit(fallas ? 1 : 0);
