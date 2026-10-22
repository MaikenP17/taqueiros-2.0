/* =============================================================
   BATERIA LOCAL DEL PANEL DE SUPERADMIN  (Supabase falso, sin red)

   Levanta el Supabase falso (PGlite con los SQL 10 a 13, 15, 16 y 16b) y ejecuta los escenarios de
   escenarios-superadmin.mjs contra el manejador REAL de api/superadmin.js y los publicos.

     node pruebas/multirestaurante/superadmin.mjs

   Necesita (una vez):  npm i --no-save @electric-sql/pglite@0.2.17
   Sale con codigo 1 si alguna prueba falla. Los mismos escenarios, contra la base real:
   supabase/probar-superadmin.mjs.
============================================================= */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { levantar } from './fake-supabase.mjs';
import { correrSuperadmin } from './escenarios-superadmin.mjs';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LLAVE = 'sb_secret_FAKE_0000';
const PUBLICABLE = 'sb_publishable_FAKE_0000';

export async function correrContraFalso(falso, apiDir, opciones = {}) {
  return correrSuperadmin({ apiDir, urlBase: falso.url, llaveServicio: LLAVE, llavePublicable: PUBLICABLE, real: false, ...opciones });
}

export function imprimir(resultados, { soloFallas = false } = {}) {
  let grupo = '';
  for (const r of resultados) {
    if (soloFallas && r.ok) continue;
    if (r.grupo !== grupo) { grupo = r.grupo; console.log(`\n== ${grupo.toUpperCase()} ==`); }
    console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const falso = await levantar({ puerto: 54341, validarConfig: false });
  console.log(`Supabase falso listo (${((Date.now() - t0) / 1000).toFixed(1)} s). Corriendo los escenarios del superadmin...`);
  const { resultados, limpieza } = await correrContraFalso(falso, path.join(RAIZ, 'api'));
  imprimir(resultados);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  if (limpieza && limpieza.length) console.log('LIMPIEZA INCOMPLETA:\n  ' + limpieza.join('\n  '));
  await falso.cerrar();
  process.exitCode = fallas || (limpieza && limpieza.length) ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}
