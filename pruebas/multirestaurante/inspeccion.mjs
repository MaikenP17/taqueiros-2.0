/* =============================================================
   Comprueba que supabase/00-inspeccion-esquema.sql (solo lectura) corre, antes y despues del SQL 13, y que sus dos
   secciones nuevas dicen lo correcto:

     node pruebas/multirestaurante/inspeccion.mjs

   * restaurante_id_con_valor_por_defecto: las 5 tablas antes del SQL 13; ninguna despues.
   * fotos_en_la_raiz_del_bucket: cuenta archivos en la raiz y productos que apuntan a ella.
============================================================= */
import { crearBase, sembrar, sql10, sql } from './sim.mjs';

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 300) });

async function inspeccionar(db) {
  const rs = await db.exec(sql('00-inspeccion-esquema.sql'));
  const filas = rs[rs.length - 1].rows;
  return Object.fromEntries(filas.map((f) => [f.seccion, typeof f.datos === 'string' ? JSON.parse(f.datos) : f.datos]));
}

const db = await crearBase({ con01y02: true });
await sembrar(db);
await db.exec(sql10());
await db.exec(sql('11-dominios.sql'));
await db.exec(sql('12-config-publica.sql'));
await db.exec(`insert into storage.objects (bucket_id, name) values ('productos', 'p-a.webp'), ('productos', 'p-b.webp'), ('productos', '00000000-0000-4000-8000-000000000001/c.webp')`);
await db.exec(`alter table public.productos disable trigger productos_validar;
  update public.productos set imagen = 'https://x.supabase.co/storage/v1/object/public/productos/p-a.webp' where id = 'bandeja-mixta';
  update public.productos set imagen = 'https://x.supabase.co/storage/v1/object/public/productos/00000000-0000-4000-8000-000000000001/c.webp' where id = 'bandeja-buchona';
  alter table public.productos enable trigger productos_validar;`);

let antes;
try { antes = await inspeccionar(db); } catch (e) { prueba('la inspeccion corre antes del SQL 13', false, e.message); }
if (antes) {
  prueba('antes del SQL 13: las 5 tablas tienen valor por defecto',
    JSON.stringify(antes.restaurante_id_con_valor_por_defecto) === JSON.stringify(['categorias', 'configuracion', 'pedidos', 'productos', 'salud_notificaciones']), JSON.stringify(antes.restaurante_id_con_valor_por_defecto));
  prueba('antes: 2 archivos en la raiz y 1 producto que apunta a ella (el de la carpeta propia no cuenta)',
    antes.fotos_en_la_raiz_del_bucket.archivos_en_la_raiz === 2 && antes.fotos_en_la_raiz_del_bucket.productos_que_apuntan_a_la_raiz === 1, JSON.stringify(antes.fotos_en_la_raiz_del_bucket));
}
await db.exec(sql('13-endurecer.sql'));
const despues = await inspeccionar(db);
prueba('despues del SQL 13: ninguna tabla conserva el valor por defecto', JSON.stringify(despues.restaurante_id_con_valor_por_defecto) === '[]', JSON.stringify(despues.restaurante_id_con_valor_por_defecto));
prueba('la inspeccion sigue sin modificar nada (solo un SELECT)', (await db.query(`select count(*)::int n from public.productos where imagen like '%p-a.webp'`)).rows[0].n === 1, '');

let fallas = 0;
for (const r of resultados) { if (!r.ok) fallas++; console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`); }
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
process.exitCode = fallas ? 1 : 0;
setTimeout(() => process.exit(), 500).unref();
