/* =============================================================
   Corre un script de supabase/ contra el Supabase FALSO (PGlite):

     node pruebas/multirestaurante/contra-falso.mjs probar-aislamiento.mjs
     node pruebas/multirestaurante/contra-falso.mjs probar-compatibilidad.mjs

   Necesita (una vez):  npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2
   Realtime NO se emula: en probar-aislamiento.mjs esas 7 pruebas fallan aqui, y es lo esperado.
============================================================= */
import { levantar } from './fake-supabase.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = process.argv[2];
if (!script) { console.error('Uso: node pruebas/multirestaurante/contra-falso.mjs <probar-aislamiento.mjs|probar-compatibilidad.mjs>'); process.exit(2); }

const s = await levantar();
const hijo = spawn(process.execPath, [path.join(raiz, 'supabase', script)], {
  cwd: raiz,
  env: { ...process.env, SUPABASE_URL: s.url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_FAKE_0000', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_FAKE_0000' },
  stdio: 'inherit'
});
hijo.on('exit', (code) => {
  console.log('\n[contra-falso] el script salio con codigo', code);
  process.exitCode = code ?? 1;
  process.exit();
});
