/* =============================================================
   PRUEBAS DE supabase/borrar-restaurante-prueba.mjs  (contra el Supabase falso: Postgres real en PGlite con los SQL 10 a 19)

     node pruebas/multirestaurante/borrar-prueba-test.mjs

   Se niega a: el demo (por id), un nombre sin el prefijo de prueba, un prefijo corto o vacio, un restaurante con pedidos pagados, un slug
   que no existe, y a todo si falta la llave. Simula por defecto; con --aplicar exige escribir el nombre corto; y borra SOLO las filas
   de ese restaurante (otro restaurante de prueba, el demo y la auditoria quedan igual).
============================================================= */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { levantar } from './fake-supabase.mjs';
import { REPO } from './sim.mjs';

const ID_DEMO = '00000000-0000-4000-8000-000000000001';
const LLAVE = 'sb_secret_FAKE_0000';
let total = 0, fallas = 0;
const T = (nombre, ok, detalle = '') => { total++; if (!ok) fallas++; console.log((ok ? 'PASA   ' : 'FALLA  ') + nombre + (ok ? '' : '   -> ' + String(detalle).slice(0, 400))); };

const falso = await levantar({ puerto: Number(process.env.BORRAR_PUERTO) || 54361, validarConfig: false });
const db = falso.db;

function correr(args, { stdin = '', llave = LLAVE } = {}) {
  return new Promise((ok) => {
    const env = { ...process.env, SUPABASE_URL: falso.url };
    if (llave === null) delete env.SUPABASE_SERVICE_ROLE_KEY; else env.SUPABASE_SERVICE_ROLE_KEY = llave;
    const h = spawn(process.execPath, [path.join(REPO, 'supabase', 'borrar-restaurante-prueba.mjs'), ...args], { cwd: REPO, env });
    let out = '', err = '';
    h.stdout.on('data', (d) => { out += d; }); h.stderr.on('data', (d) => { err += d; });
    h.on('close', (codigo) => ok({ codigo, salida: out + err }));
    h.stdin.end(stdin);
  });
}
const n = async (tabla, id) => (await db.query(`select count(*)::int as n from public.${tabla} where restaurante_id = $1::uuid`, [id])).rows[0].n;
const TABLAS = ['productos', 'categorias', 'tarifas_domicilio', 'restaurante_dominios', 'pedidos', 'configuracion', 'restaurante_secretos', 'contadores_pedido', 'producto_opciones'];
const huella = async (id) => JSON.stringify(await Promise.all(TABLAS.map((t) => n(t, id))));
async function crear(slug, { pagado = false, pendiente = true } = {}) {
  const id = (await db.query(`insert into public.restaurantes (slug, nombre) values ($1, $2) returning id`, [slug, 'Resto ' + slug])).rows[0].id;
  await db.query(`insert into public.categorias (restaurante_id, id, nombre, orden, activa) values ($1::uuid, 'c1', 'Cat', 1, true)`, [id]);
  await db.query(`insert into public.productos (restaurante_id, id, nombre, descripcion, precio, categoria, orden, disponible) values ($1::uuid, 'p1', 'Prod', '', 1000, 'c1', 1, true)`, [id]);
  await db.query(`insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values ($1::uuid, 'p1', 'o1', 'extra', 'Extra', 500)`, [id]);
  await db.query(`insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ($1::uuid, 2, 5000)`, [id]);
  await db.query(`insert into public.restaurante_dominios (host, restaurante_id) values ($1, $2::uuid)`, [slug + '.prueba.test', id]);
  if (pendiente) await db.query(`insert into public.pedidos (restaurante_id, referencia, estado, estado_pago, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total) values ($1::uuid, $2, 'pendiente_pago', 'pendiente', 'C', '3000000000', 'llevar', '[]'::jsonb, 1000, 0, 1000)`, [id, 'R-' + slug]);
  if (pagado) await db.query(`insert into public.pedidos (restaurante_id, referencia, estado, estado_pago, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, pagado_en) values ($1::uuid, $2, 'nuevo', 'aprobado', 'C', '3000000000', 'llevar', '[]'::jsonb, 1000, 0, 1000, now())`, [id, 'P-' + slug]);
  return id;
}
const existe = async (slug) => (await db.query(`select 1 from public.restaurantes where slug = $1`, [slug])).rows.length > 0;

console.log('--- negativas: no se borra nada');
const taqAntes = await huella(ID_DEMO);
const idOtro = await crear('otro-resto');
const idPagado = await crear('prueba-pagado', { pagado: true });
const idPagadoFecha = await crear('prueba-pendiente-con-fecha');
await db.query(`update public.pedidos set pagado_en = now() where restaurante_id = $1::uuid`, [idPagadoFecha]);

let r = await correr([]);
T('sin nombre corto: se niega (codigo 2)', r.codigo === 2 && /Falta el nombre corto/.test(r.salida), r.salida);
r = await correr(['taqueiros', '--aplicar'], { stdin: 'taqueiros\n' });
T('el demo por su nombre corto (sin prefijo de prueba): se niega aunque se confirme', r.codigo === 2 && /prefijo de prueba/.test(r.salida) && await existe('taqueiros'), r.salida);
r = await correr(['otro-resto', '--aplicar'], { stdin: 'otro-resto\n' });
T('un restaurante sin el prefijo de prueba: se niega y no se toca', r.codigo === 2 && /no empieza por el prefijo/.test(r.salida) && await existe('otro-resto') && await n('productos', idOtro) === 1, r.salida);
for (const p of ['--prefijo=', '--prefijo=p-', '--prefijo=prueba', '--prefijo=Prueba-', '--prefijo=a b-']) {
  r = await correr(['otro-resto', p, '--aplicar'], { stdin: 'otro-resto\n' });
  T(`prefijo "${p.slice(10)}": se niega (no se puede "apagar" la guarda con un prefijo vacio o raro)`, r.codigo === 2 && await existe('otro-resto'), r.salida);
}
r = await correr(['prueba-', '--aplicar'], { stdin: 'prueba-\n' });
T('el prefijo solo, sin nombre: se niega', r.codigo === 2, r.salida);
// el demo con un nombre corto que SI empieza por el prefijo: la guarda por id lo detiene
await db.query(`update public.restaurantes set slug = 'prueba-demo-disfrazado' where id = $1::uuid`, [ID_DEMO]);
r = await correr(['prueba-demo-disfrazado', '--aplicar'], { stdin: 'prueba-demo-disfrazado\n' });
await db.query(`update public.restaurantes set slug = 'taqueiros' where id = $1::uuid`, [ID_DEMO]);
T('el demo, aunque su nombre corto empiece por "prueba-": se niega por su id (restaurante demo)', r.codigo === 2 && /restaurante demo/.test(r.salida) && await huella(ID_DEMO) === taqAntes, r.salida);
r = await correr(['prueba-pagado', '--aplicar'], { stdin: 'prueba-pagado\n' });
T('con un pedido pagado (aprobado): se niega y no borra nada', r.codigo === 2 && /PAGADOS/.test(r.salida) && await existe('prueba-pagado') && await n('pedidos', idPagado) === 2, r.salida);
r = await correr(['prueba-pendiente-con-fecha', '--aplicar'], { stdin: 'prueba-pendiente-con-fecha\n' });
T('con un pedido que tiene fecha de pago (aunque diga pendiente): se niega', r.codigo === 2 && /PAGADOS/.test(r.salida) && await existe('prueba-pendiente-con-fecha'), r.salida);
r = await correr(['prueba-no-existe']);
T('un nombre corto que no existe: lo dice (codigo 2)', r.codigo === 2 && /No existe/.test(r.salida), r.salida);
r = await correr(['prueba-Mal_Formado']);
T('un nombre corto mal formado: se niega', r.codigo === 2 && /formato/.test(r.salida), r.salida);
const antesSinLlave = await huella(idOtro);
r = await correr(['prueba-pagado'], { llave: null });
T('sin la llave: se detiene explicando', r.codigo === 2 && /Falta SUPABASE_SERVICE_ROLE_KEY/.test(r.salida), r.salida);
r = await correr(['prueba-pagado'], { llave: 'sb_publishable_FAKE_0000' });
T('con una llave publicable: se niega', r.codigo === 2 && /publicable/.test(r.salida), r.salida);

console.log('--- simulacion y confirmacion');
const idUno = await crear('prueba-uno');
const idDos = await crear('prueba-dos');
const antesUno = await huella(idUno), antesDos = await huella(idDos);
r = await correr(['prueba-uno']);
T('por defecto SIMULA: muestra las filas y no borra nada', r.codigo === 0 && /Simulacion/.test(r.salida) && /productos\s+1 fila/.test(r.salida) && /pedidos\s+1 fila/.test(r.salida) && await huella(idUno) === antesUno, r.salida);
r = await correr(['prueba-uno', '--aplicar'], { stdin: 'prueba-dos\n' });
T('con --aplicar pero escribiendo OTRO nombre: no borra nada', r.codigo === 2 && /No coincide/.test(r.salida) && await huella(idUno) === antesUno && await huella(idDos) === antesDos, r.salida);
r = await correr(['prueba-uno', '--aplicar'], { stdin: '\n' });
T('con --aplicar y la confirmacion vacia: no borra nada', r.codigo === 2 && await huella(idUno) === antesUno, r.salida);
r = await correr(['prueba-uno', '--aplicar'], { stdin: '' });
T('con --aplicar y sin teclado (sin respuesta): no borra nada', r.codigo === 2 && await huella(idUno) === antesUno, r.salida);

console.log('--- borrado real: solo las filas de ese restaurante');
const auditoriaAntes = (await db.query(`select count(*)::int as n from public.auditoria_superadmin`)).rows[0].n;
const restaurantesAntes = (await db.query(`select count(*)::int as n from public.restaurantes`)).rows[0].n;
r = await correr(['prueba-uno', '--aplicar'], { stdin: 'prueba-uno\n' });
T('escribiendo el nombre corto completo: se borra (codigo 0)', r.codigo === 0 && /Listo: "prueba-uno" se borro/.test(r.salida), r.salida);
T('el restaurante y TODAS sus filas desaparecieron', !(await existe('prueba-uno')) && (await Promise.all(TABLAS.map((t) => n(t, idUno)))).every((x) => x === 0));
T('otro restaurante de prueba queda EXACTAMENTE igual', await huella(idDos) === antesDos && await existe('prueba-dos'));
T('el demo queda igual (fila, pedidos, secretos, contador)', await huella(ID_DEMO) === taqAntes && await existe('taqueiros'));
T('el restaurante con pedidos pagados y el que no tiene prefijo siguen ahi', await existe('prueba-pagado') && await existe('otro-resto') && await huella(idOtro) === antesSinLlave);
T('solo desaparecio UN restaurante', (await db.query(`select count(*)::int as n from public.restaurantes`)).rows[0].n === restaurantesAntes - 1);
T('la auditoria no se toca (es de solo agregar)', (await db.query(`select count(*)::int as n from public.auditoria_superadmin`)).rows[0].n === auditoriaAntes);
T('el script nunca imprime la llave', !r.salida.includes('sb_secret_'), r.salida);
r = await correr(['prueba-uno']);
T('volver a correrlo sobre el ya borrado: dice que no existe', r.codigo === 2 && /No existe/.test(r.salida));

// un prefijo propio (configurable)
const idLab = await crear('lab-uno');
r = await correr(['lab-uno', '--prefijo=lab-', '--aplicar'], { stdin: 'lab-uno\n' });
T('con un prefijo propio (--prefijo=lab-) tambien funciona', r.codigo === 0 && !(await existe('lab-uno')) && await existe('prueba-dos'), r.salida);

console.log(`\n${total - fallas}/${total} pruebas pasan, ${fallas} fallan`);
await falso.cerrar();
process.exitCode = fallas ? 1 : 0;
setTimeout(() => process.exit(), 1000).unref();
