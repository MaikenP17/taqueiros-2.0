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
  /* REBRAND (a proposito): el ticket de PRUEBA usa productos de The Northe Burgers en vez de los de Taqueiros (ticket-comanda.js, pedidoDePrueba).
     Solo se excusan estos textos y precios, cada uno EXACTAMENTE una vez; cualquier otra diferencia en ese ticket (o en los otros 6) sigue fallando. */
  const MUESTRA = [
    ['Tacos de Birria con Consomé (orden x3)', 'Big Norte con Queso Extra (combo x3)'],
    ['Sin cebolla, con mucho limón y tortilla bien doradita', 'Sin cebolla, con mucha salsa y pan bien tostadito'],
    ['Doriloco Especial Súper Cargado', 'Full Norte Súper Cargado'],
    ['Agua de Jamaica 500 ml', 'Coca-Cola Lata 350 ml'],
    ['Sin cebolla ni cilantro, salsa picante aparte.', 'Sin cebolla ni pepinillos, salsa picante aparte.'],
    ['más limón.', 'más servilletas.'],
    ['$90.000</span>', '$92.500</span>'],
    ['$95.000</span>', '$97.500</span>']
  ];
  const deMuestra = (s) => MUESTRA.reduce((t, [viejo, nuevo]) => {
    const partes = t.split(viejo);
    if (partes.length !== 2) throw new Error(`el ticket de prueba de antes trae ${partes.length - 1} veces (se esperaba 1): ${viejo}`);
    return partes.join(nuevo);
  }, s);
  for (const f of fs.readdirSync(dirAntes).sort()) {
    const a = normal(fs.readFileSync(path.join(dirAntes, f), 'utf8'));
    const a2 = f === '07-ticket-de-prueba.html' ? deMuestra(a) : a;
    const b = fs.existsSync(path.join(dirAhora, f)) ? normal(fs.readFileSync(path.join(dirAhora, f), 'utf8')) : null;
    const igual = a2 === b;
    if (!igual) fallas++;
    console.log((igual ? 'IGUAL    ' : 'DISTINTO ') + f + '  (' + a.length + ' caracteres)' + (f === '07-ticket-de-prueba.html' && igual ? '  (salvo los productos de muestra, a proposito)' : ''));
    if (!igual && b !== null) {   // muestra las primeras lineas distintas para saber QUE cambio
      const la = a2.split(/(?<=>)/), lb = b.split(/(?<=>)/);
      let mostradas = 0;
      for (let i = 0; i < Math.max(la.length, lb.length) && mostradas < 12; i++) if (la[i] !== lb[i]) { console.log('   antes: ' + (la[i] || '').trim().slice(0, 160) + '\n   ahora: ' + (lb[i] || '').trim().slice(0, 160)); mostradas++; }
    }
  }
} finally {
  try { execFileSync('git', ['worktree', 'remove', '--force', arbol], { cwd: REPO, stdio: 'ignore' }); } catch (e) { /* ya no estaba */ }
  try { execFileSync('git', ['worktree', 'prune'], { cwd: REPO, stdio: 'ignore' }); } catch (e) { /* nada */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* en uso */ }
}
console.log(fallas ? `\n${fallas} ticket(s) CAMBIARON.` : '\nLos 7 tickets son identicos (salvo la hora).');
process.exitCode = fallas ? 1 : 0;
