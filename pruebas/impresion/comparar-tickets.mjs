/* =============================================================
   PRUEBA DE QUE LA IMPRESION NO CAMBIO

     node pruebas/impresion/comparar-tickets.mjs [commit-anterior]

   Imprime los mismos 7 tickets (normal, 12 productos con notas largas, nombres y direcciones
   largos, ñ y tildes, etiquetas HTML, reimpresion y ticket de prueba) con el panel de ANTES
   (el commit indicado, por defecto debc1c5, en un arbol temporal de git) y con el de AHORA,
   usando el mismo e2e (Chrome sin interfaz, Supabase simulado), y compara el HTML de cada
   ticket letra por letra.

   Lo unico que se normaliza son las horas (el e2e usa la hora del momento en que corre).
   El numero del pedido NO se normaliza: en esta prueba numero = id (un solo restaurante), asi que
   la salida debe quedar identica.

   Sale con codigo 1 si algun ticket cambia.
============================================================= */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const commit = process.argv[2] || '1c35320';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-tickets-'));
const arbol = path.join(tmp, 'antes');

function correr(cwd, salida) {
  const r = spawnSync(process.execPath, [path.join(cwd, 'pruebas', 'impresion', 'e2e.js')], {
    cwd, env: { ...process.env, SOLO: '^Guardando', TICKETS: salida }, encoding: 'utf8', timeout: 300000
  });
  if (r.status !== 0) throw new Error('el e2e fallo en ' + cwd + '\n' + (r.stdout || '').slice(-600) + (r.stderr || '').slice(-300));
}

let fallas = 0;
try {
  execFileSync('git', ['worktree', 'add', '-f', arbol, commit], { cwd: REPO, stdio: 'ignore' });
  const dirAntes = path.join(tmp, 'tickets-antes'), dirAhora = path.join(tmp, 'tickets-ahora');
  console.log('Imprimiendo con el panel de ' + commit + '...');
  correr(arbol, dirAntes);
  console.log('Imprimiendo con el panel de ahora...');
  correr(REPO, dirAhora);

  // las horas dependen del momento en que corre cada vez
  const normal = (s) => s.replace(/\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}(:\d{2})? [ap]\.\s?m\./g, '<FECHA>')
                         .replace(/\d{1,2}:\d{2}(:\d{2})? [ap]\.\s?m\./g, '<HORA>');
  for (const f of fs.readdirSync(dirAntes).sort()) {
    const a = normal(fs.readFileSync(path.join(dirAntes, f), 'utf8'));
    const b = fs.existsSync(path.join(dirAhora, f)) ? normal(fs.readFileSync(path.join(dirAhora, f), 'utf8')) : null;
    const igual = a === b;
    if (!igual) fallas++;
    console.log((igual ? 'IGUAL    ' : 'DISTINTO ') + f + '  (' + a.length + ' caracteres)');
  }
} finally {
  try { execFileSync('git', ['worktree', 'remove', '--force', arbol], { cwd: REPO, stdio: 'ignore' }); } catch (e) { /* ya no estaba */ }
  try { execFileSync('git', ['worktree', 'prune'], { cwd: REPO, stdio: 'ignore' }); } catch (e) { /* nada */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* en uso */ }
}
console.log(fallas ? `\n${fallas} ticket(s) CAMBIARON.` : '\nLos 7 tickets son identicos (salvo la hora).');
process.exitCode = fallas ? 1 : 0;
