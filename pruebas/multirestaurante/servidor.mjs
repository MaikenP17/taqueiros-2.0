/* =============================================================
   BATERIA LOCAL DE LA API MULTI-RESTAURANTE  (Supabase falso, sin red)

   Levanta el Supabase falso (PGlite con el SQL 10 y el SQL 11) y ejecuta los
   escenarios de escenarios-servidor.mjs contra los manejadores REALES de api/.

     node pruebas/multirestaurante/servidor.mjs
     node pruebas/multirestaurante/servidor.mjs --grupo=webhook,alertas   (solo esos grupos)
     node pruebas/multirestaurante/servidor.mjs --sin-invariante          (sin el espia de filtros)

   Necesita (una vez):  npm i --no-save @electric-sql/pglite@0.2.17
   Sale con codigo 1 si alguna prueba falla.
   El mismo modulo lo usa mutaciones-servidor.mjs para romper los filtros uno a uno.
============================================================= */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { levantar } from './fake-supabase.mjs';
import { correrEscenarios } from './escenarios-servidor.mjs';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LLAVE = 'sb_secret_FAKE_0000';
const PUBLICABLE = 'sb_publishable_FAKE_0000';

/* Corre todos los escenarios contra el falso que ya esta levantado. */
export async function correrContraFalso(falso, apiDir, opciones = {}) {
  return correrEscenarios({
    apiDir, urlBase: falso.url, llaveServicio: LLAVE, llavePublicable: PUBLICABLE, real: false, ...opciones
  });
}

export function imprimir(resultados, { soloFallas = false } = {}) {
  let grupo = '';
  for (const r of resultados) {
    if (soloFallas && r.ok) continue;
    if (r.grupo !== grupo) { grupo = r.grupo; console.log(`\n== ${grupo.toUpperCase()} ==`); }
    console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  }
}

// Solo cuando se ejecuta directamente (no cuando lo importa mutaciones-servidor.mjs)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
  const grupos = arg('grupo') ? arg('grupo').split(',') : null;
  const t0 = Date.now();
  const falso = await levantar({ puerto: 54331, validarConfig: false });
  console.log(`Supabase falso listo (${((Date.now() - t0) / 1000).toFixed(1)} s). Corriendo los escenarios...`);
  const { resultados, limpieza } = await correrContraFalso(falso, path.join(RAIZ, 'api'), {
    soloGrupos: grupos, sinInvariante: process.argv.includes('--sin-invariante')
  });
  imprimir(resultados);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  if (limpieza && limpieza.length) console.log('LIMPIEZA INCOMPLETA:\n  ' + limpieza.join('\n  '));
  await falso.cerrar();
  process.exitCode = fallas || (limpieza && limpieza.length) ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}
