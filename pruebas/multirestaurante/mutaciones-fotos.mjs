/* =============================================================
   REVISION POR MUTACION DE supabase/migrar-fotos-raiz.mjs

     node pruebas/multirestaurante/mutaciones-fotos.mjs [--solo=<regex>] [--paralelo=3]

   Rompe a proposito UNA defensa del script (copia mutada en supabase/_mutante-fotos-N.mjs, que se borra al terminar) y corre
   pruebas/multirestaurante/migrar-fotos.mjs con ella (MIGRAR_FOTOS_SCRIPT). La mutacion se da por detectada si alguna prueba
   FALLA. Una mutacion "equivalente" lleva la razon por la que quitar esa defensa no cambia lo observable.
============================================================= */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL = fs.readFileSync(path.join(RAIZ, 'supabase', 'migrar-fotos-raiz.mjs'), 'utf8');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];

const M = [
  // copia de seguridad
  ['--aplicar no exige copia de seguridad', 'if (problema) {', 'if (false) {'],
  ['la copia de seguridad puede ser vieja', 'if (horas > MAX_HORAS || horas < -1)', 'if (false)'],
  ['la copia de seguridad puede ser de otro proyecto', 'if (res.proyecto !== URL_BASE)', 'if (false)'],
  ['la copia de seguridad puede no coincidir con la base', 'if (malas.length)', 'if (false)'],
  ['la copia de seguridad puede no traer productos', 'if (!prod)', 'if (false)'],
  ['la copia de seguridad puede no traer productos.json', 'if (!fs.existsSync(path.join(RESPALDOS, nombre, "productos.json")))', 'if (false)'],
  ['la copia de seguridad puede tener fecha del futuro', 'horas < -1', 'false'],
  // llave
  ['una llave pegada dos veces se usa', 'LLAVE.split("sb_secret_").length !== 2', 'false'],
  // simulacion
  ['la simulacion aplica de verdad', 'const APLICAR = bandera("aplicar");', 'const APLICAR = true;'],
  // clasificacion
  ['una foto que usa otro restaurante se mueve igual', 'if (grupo.ajenos.length) {', 'if (false) {'],
  ['los productos de otro restaurante cuentan como propios', '(p.restaurante_id === rest.id ? grupos.get(c.nombre).propios : grupos.get(c.nombre).ajenos).push(p);', 'grupos.get(c.nombre).propios.push(p);'],
  ['una foto en carpeta se toma por foto de la raiz', 'if (!nombre.includes("/")) return { tipo: "raiz", nombre };', 'return { tipo: "raiz", nombre };'],
  ['un nombre de archivo raro se intenta mover', 'if (!NOMBRE_VALIDO.test(viejo)) {', 'if (false) {'],
  ['una foto que ya no existe se trata como movible', 'if (!S.existe && !D.existe) {', 'if (false) {'],
  ['se pisa un archivo distinto en el destino', 'if (S.existe && D.existe && S.hash !== D.hash) {', 'if (false) {'],
  // pasos
  ['no se copia', 'if (hayQueCopiar) {', 'if (false) {'],
  ['no se comprueba la copia', 'if (!otra.existe || otra.hash !== hash) throw', 'if (false) throw'],
  ['no se actualizan los productos', 'const ok = await cambiarImagen(ctx.rid, p.id, p.imagen, urlPublica(nuevo));', 'const ok = true;'],
  ['la actualizacion no es condicional (pisa un cambio del dueno)', '&imagen=eq.${encodeURIComponent(de)}`,', '`,'],
  ['la actualizacion no filtra por restaurante', '/rest/v1/productos?restaurante_id=eq.${rid}&id=eq.${encodeURIComponent(id)}&imagen=eq.', '/rest/v1/productos?id=eq.${encodeURIComponent(id)}&imagen=eq.', 'equivalente: la condicion sobre la direccion antigua (que solo tiene este restaurante: las compartidas se saltan) ya acota la fila'],
  ['no se verifica la direccion nueva', 'if (!V.existe || V.hash !== hash) {', 'if (false) {'],
  ['si la verificacion falla no se devuelve el producto', 'for (const c of cambiados) { try { await cambiarImagen(ctx.rid, c.id, urlPublica(nuevo), c.imagen_antigua); } catch { /* se reporta abajo */ } }', ''],
  ['se borra aunque otro producto todavia la use', 'if (usos.length) throw new Error(`todavia la usan ${usos.length} producto(s); no se borra`);', ''],
  ['nunca se borra la antigua', 'if (hayQueBorrar) {', 'if (false) {'],
  ['--no-borrar no se respeta', 'const hayQueBorrar = S.existe && !NO_BORRAR;', 'const hayQueBorrar = S.existe;'],
  ['no se confirma que la antigua se borro', 'if (x.existe) throw new Error("la antigua sigue en Storage despues de borrarla");', ''],
  // registro y reanudacion
  ['el registro no se guarda', 'fs.renameSync(tmp, REGISTRO);', ''],
  ['no se retoman las fotos pendientes de una corrida cortada', 'const pendientes = ctx.registro.fotos.filter((e) => !["borrada"].includes(e.estado) && !grupos.has(e.viejo));', 'const pendientes = [];'],
  ['un pendiente se borra sin comprobar la copia', 'if (!D.existe || D.hash !== S.hash) {', 'if (false) {'],
  ['un pendiente se borra aunque algun producto lo use', '  if (usos.length) return;   // lo retoma el flujo normal', '', 'equivalente: grupos.has() ya deja fuera a toda foto que algun producto usa; esa comprobacion solo cubre una carrera entre dos lecturas'],
  ['el registro no guarda los productos afectados', 'if (ok) { if (!cambiados.some((x) => x.id === p.id)) cambiados.push({ id: p.id, imagen_antigua: p.imagen }); }', 'if (ok) { /* nada */ }'],
  // deshacer
  ['deshacer no copia de vuelta', 'if (!S.existe) {\n        const r = await pedir("POST", "/storage/v1/object/copy", { cuerpo: { bucketId: "productos", sourceKey: e.nuevo', 'if (false) {\n        const r = await pedir("POST", "/storage/v1/object/copy", { cuerpo: { bucketId: "productos", sourceKey: e.nuevo'],
  ['deshacer no devuelve los productos', 'const ok = await cambiarImagen(ctx.rid, p.id, urlPublica(e.nuevo), p.imagen_antigua);', 'const ok = true;'],
  ['deshacer deja una copia de mas si falla', 'if (copiadaAhora && !cambioAlgo) {', 'if (false) {'],
  ['deshacer acepta el registro de otro proyecto', 'if (reg.proyecto !== URL_BASE || !Array.isArray(reg.fotos)) {', 'if (!Array.isArray(reg.fotos)) {'],
  // salida
  ['siempre sale con codigo 0', 'terminar(resumen.errores ? 1 : 0);', 'terminar(0);'],
  ['un error no marca la foto en el registro', 'paso(e, "error", { error: String(err.message).slice(0, 300) });\n    linea(`ERROR  ${viejo}: ${err.message}`);', 'linea(`ERROR  ${viejo}: ${err.message}`);']
];

const solo = arg('solo');
const paralelo = Number(arg('paralelo') || 3);
const lista = M.map((m, i) => ({ i, nombre: m[0], buscar: m[1], poner: m[2], equivalente: m[3] })).filter((m) => !solo || new RegExp(solo, 'i').test(m.nombre));

function correr(idx, puerto) {
  return new Promise((resolve) => {
    const m = lista[idx];
    const archivo = path.join(RAIZ, 'supabase', `_mutante-fotos-${puerto}.mjs`);
    const n = ORIGINAL.split(m.buscar).length - 1;
    if (n < 1) return resolve({ m, malDefinida: `"${m.buscar.slice(0, 60)}" aparece ${n} veces` });
    fs.writeFileSync(archivo, ORIGINAL.replace(m.buscar, () => m.poner));
    const hijo = spawn(process.execPath, [path.join(RAIZ, 'pruebas', 'multirestaurante', 'migrar-fotos.mjs')], {
      cwd: RAIZ, env: { ...process.env, MIGRAR_FOTOS_SCRIPT: archivo, PUERTO_FOTOS: String(puerto) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    hijo.stdout.on('data', (d) => { out += d; }); hijo.stderr.on('data', (d) => { out += d; });
    const tope = setTimeout(() => hijo.kill('SIGKILL'), 240000);
    hijo.on('exit', (code) => {
      clearTimeout(tope); fs.rmSync(archivo, { force: true });
      const falladas = [...out.matchAll(/^\s+FALLA\s+(.+)$/gm)].map((x) => x[1]);
      // la suite que revienta con una excepcion tambien delata la mutacion (salvo un fallo de infraestructura, como un puerto ocupado)
      if (!falladas.length && code !== 0 && !/EADDRINUSE|TIEMPO AGOTADO/.test(out) && !/PASAN, 0 FALLAN/.test(out)) falladas.push('la suite termino con una excepcion: ' + (out.match(/\w*Error[^\n]*/) || ['(sin detalle)'])[0].slice(0, 80));
      resolve({ m, code, falladas, out });
    });
  });
}

let siguiente = 0;
const resultados = [];
async function trabajador(k) {
  while (siguiente < lista.length) {
    const idx = siguiente++;
    resultados[idx] = await correr(idx, 54400 + k * 2);
    const r = resultados[idx];
    const estado = r.malDefinida ? 'MAL DEFINIDA' : r.m.equivalente ? (r.falladas.length ? 'equivalente (igual se detecta)' : 'EQUIVALENTE') : r.falladas.length ? 'detectada' : 'SIN DETECTAR';
    console.log(`  ${estado.padEnd(16)} ${r.m.nombre}${r.falladas && r.falladas.length ? `   (${r.falladas.length} pruebas fallan; p. ej.: ${r.falladas[0].slice(0, 80)})` : ''}${r.malDefinida ? '   ' + r.malDefinida : ''}`);
  }
}
await Promise.all(Array.from({ length: paralelo }, (_, k) => trabajador(k)));

const sin = resultados.filter((r) => !r.malDefinida && !r.m.equivalente && !r.falladas.length);
const mal = resultados.filter((r) => r.malDefinida);
const eq = resultados.filter((r) => r.m.equivalente);
console.log(`\n${resultados.length} mutaciones: ${resultados.length - sin.length - mal.length - eq.length} detectadas, ${eq.length} equivalentes declaradas, ${sin.length} SIN DETECTAR, ${mal.length} mal definidas.`);
for (const r of sin) console.log('  SIN DETECTAR: ' + r.m.nombre);
process.exitCode = sin.length || mal.length ? 1 : 0;
