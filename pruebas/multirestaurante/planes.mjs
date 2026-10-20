/* =============================================================
   EL SQL 10 NO DEBE DEPENDER DEL PLAN DEL OPTIMIZADOR

   Postgres no garantiza en que orden evalua los filtros de un WHERE.
   Una funcion puesta junto a "schemaname = 'public'" puede ejecutarse
   sobre filas de otros esquemas ANTES de que el filtro las descarte.
   Fue la causa de:  ERROR 42P01: relation "public.pg_statistic" does not exist
   (has_table_privilege('anon', format('public.%I', relname), ...) sobre
   pg_tables): en el simulador chico el plan filtraba primero y no fallaba;
   en Supabase real si.

   Esta prueba:
     1. LINT: prohibe en el SQL llamadas de permisos / regclass con nombres
        armados a mano; los barridos de catalogo deben usar OID.
     2. PLANES: corre el SQL 10 (dos veces) sobre el simulador realista
        (sim.mjs: esquemas de Supabase, objetos de supabase_admin y de una
        extension, permisos sobre pg_catalog, catalogo grande) forzando cada
        plan de sim.mjs -> PLANES. Debe dar las 34 comprobaciones en todos.

   USO:  node pruebas/multirestaurante/planes.mjs
   Sale con codigo 1 si algo falla. SQL10_ARCHIVO prueba otra version.
============================================================= */
import { crearBase, sembrar, sql10, PLANES, aplicarPlan } from './sim.mjs';

let fallas = 0, total = 0;
const T = (nombre, ok, detalle = '') => {
  total++; if (!ok) fallas++;
  console.log((ok ? 'PASA   ' : 'FALLA  ') + nombre + (ok ? '' : '   -> ' + String(detalle).slice(0, 240)));
};

console.log('--- lint: nada de nombres de relacion armados a mano en llamadas que fallan si no existen');
{
  const texto = sql10().replace(/\r\n/g, '\n');
  const sinComentarios = texto.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  /** Texto completo (con parentesis balanceados) de cada llamada que empieza con 're'. */
  const llamadas = (re) => {
    const salida = [];
    for (const m of sinComentarios.matchAll(re)) {
      let nivel = 1, k = m.index + m[0].length, enCadena = false;
      for (; k < sinComentarios.length && nivel > 0; k++) {
        const c = sinComentarios[k];
        if (c === "'") enCadena = !enCadena;
        else if (!enCadena && c === '(') nivel++;
        else if (!enCadena && c === ')') nivel--;
      }
      salida.push(sinComentarios.slice(m.index, k));
    }
    return salida;
  };
  const armado = (arg) => /format\s*\(|\|\|/i.test(arg);
  const corto = (x) => x.replace(/\s+/g, ' ').slice(0, 100);

  const privilegios = llamadas(/has_(table|column|function|schema|sequence)_privilege\s*\(/gi).filter(armado);
  T('has_*_privilege nunca recibe un nombre armado (format / ||): usa OID', privilegios.length === 0, privilegios.map(corto).join(' | '));

  const casts = [...sinComentarios.matchAll(/\(([^()]*(?:format\s*\(|\|\|)[^()]*)\)\s*::\s*(regclass|regproc|regprocedure|regtype|regnamespace)/gi)].map((m) => corto(m[0]));
  T('ningun ::regclass / ::regproc sobre texto armado', casts.length === 0, casts.join(' | '));

  const prefijos = [...sinComentarios.matchAll(/'public\.'\s*\|\|/g)]
    .filter((m) => !/to_regclass\s*\(\s*$/i.test(sinComentarios.slice(Math.max(0, m.index - 40), m.index)))
    .map((m) => corto(sinComentarios.slice(Math.max(0, m.index - 40), m.index + 30)));
  T("ningun prefijo 'public.' || escrito a mano (salvo dentro de to_regclass, que no lanza error)", prefijos.length === 0, prefijos.join(' | '));
}

console.log('--- el SQL 10 bajo cada plan del optimizador (dos corridas seguidas)');
for (const plan of Object.keys(PLANES)) {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await aplicarPlan(db, plan);
  let detalle = '';
  let ok = false;
  try {
    const archivo = sql10();
    for (let corrida = 1; corrida <= 2; corrida++) {
      const r = await db.exec(archivo);
      const filas = r[r.length - 1].rows;
      const malas = filas.filter((x) => x.estado !== 'OK');
      if (filas.length < 34 || malas.length) throw new Error(`corrida ${corrida}: ${filas.length} filas, fallan: ${malas.map((x) => x.verificacion).join('; ')}`);
    }
    ok = true;
  } catch (e) { detalle = e.message.split('\n')[0]; }
  T(`plan "${plan}"`, ok, detalle);
}

console.log(`\n${total - fallas}/${total} pruebas pasan, ${fallas} fallan`);
process.exitCode = fallas ? 1 : 0;
