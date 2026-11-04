/* =============================================================
   REVISION POR MUTACION DE LA PANTALLA DE SUPERADMINISTRACION y de supabase/borrar-restaurante-prueba.mjs

     node pruebas/multirestaurante/mutaciones-pantalla.mjs [--paralelo=3] [--solo=texto]

   Rompe a proposito, UNA por una, las decisiones que protegen algo (sesion y MFA, escapado, solo lectura, un solo envio, secretos y
   contrasena temporal, cabeceras, el borrado de pruebas) en una COPIA del codigo y corre las pruebas que deberian notarlo. Si
   ninguna falla, la mutacion SOBREVIVIO y hay un hueco en las pruebas (o la mutacion es equivalente y se declara con su razon).
   Antes corre un CONTROL: la copia sin tocar debe pasar todo.
============================================================= */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO } from './sim.mjs';

const PARALELO = Number((process.argv.find((a) => a.startsWith('--paralelo=')) || '--paralelo=3').split('=')[1]) || 3;
const SOLO = (process.argv.find((a) => a.startsWith('--solo=')) || '').split('=')[1];
const DIR = path.dirname(fileURLToPath(import.meta.url));
const sl = String.fromCharCode(92);

/* tipo: 'pantalla' (superadmin-pantalla.mjs con PANTALLA_RAIZ) | 'borrar' (borrar-prueba-test.mjs con BORRAR_SCRIPT)
   de: texto exacto (o RegExp); a: reemplazo; todos: reemplaza todas las apariciones; esc: escenarios que deben notarlo */
const M = [
  // ---- sesion y MFA (superadmin.js)
  { id: 'sesion-en-localStorage', f: 'superadmin.js', de: 'sessionStorage.setItem(CLAVE_SESION, JSON.stringify(ses))', a: 'localStorage.setItem(CLAVE_SESION, JSON.stringify(ses))', esc: '^(1|3)[.]' },
  { id: 'sin-MFA: aal1 entra directo a la app', f: 'superadmin.js', de: 'if (r.json.aal === "aal2") return entrarALaApp();', a: 'return entrarALaApp();', esc: '^(3|4)[.]' },
  { id: 'no-superadmin recibe otro mensaje', f: 'superadmin.js', de: 'mostrarEntrada({ tipo: "error", texto: MSJ_GENERICO });', a: 'mostrarEntrada({ tipo: "error", texto: "Tu usuario no es superadmin" });', esc: '^2[.]' },
  { id: 'no-superadmin conserva la sesion (sin logout ni limpiar)', f: 'superadmin.js', de: new RegExp('limpiarTodo\\(\\);\\s+if \\(token\\) authLlamar\\("POST", "' + '/logout", null, token\\);\\s+if \\(r\\.status === 429\\)'), a: 'if (r.status === 429)', esc: '^2[.]' },
  { id: 'mfa_requerida ya no vuelve al codigo', f: 'superadmin.js', de: 'if (r.status === 403 && j && j.codigo === "mfa_requerida") {', a: 'if (false) {', esc: '^5[.]' },
  { id: 'sin guarda contra llamar a la API mientras se pide el codigo', f: 'superadmin.js', de: 'if (mfaEnCurso) return Promise.reject(silencioso("mfa"));', a: '', esc: '^5[.]' },
  { id: '401 no cierra ni limpia la sesion', f: 'superadmin.js', de: 'if (r.status === 401) { sesionVencida(', a: 'if (r.status === 401) { (function () {})(', esc: '^6[.]' },
  { id: '429 no espera', f: 'superadmin.js', de: 'bloqueoHasta = Date.now() + seg * 1000;', a: 'bloqueoHasta = 0;', esc: '^7[.]' },
  { id: 'nunca renueva el token', f: 'superadmin.js', de: 'if (restante <= 90) refrescar();', a: 'if (restante <= -99999) refrescar();', esc: '^18[.]' },
  { id: 'la renovacion que baja a aal1 no pide el codigo', f: 'superadmin.js', de: 'if (aalDe(ses.access) !== "aal2" && !mfaEnCurso && capaPantalla.hidden) {', a: 'if (false) {', esc: '^18[.]' },
  { id: 'los caracteres invisibles no se marcan', f: 'superadmin.js', de: 's = cambiarInvisibles(s);', a: '', esc: '^(9|16)[.]' },
  { id: 'los textos largos no se cortan', f: 'superadmin.js', de: 'if (s.length > max) {', a: 'if (false) {', esc: '^9[.]' },
  { id: 'la clave del QR queda en el DOM', f: 'superadmin.js', de: 'function limpiarSecreto() { if (qr) qr.removeAttribute("src"); claveEl.textContent = ""; f = null; enrolando = null; }', a: 'function limpiarSecreto() { }', esc: '^3[.]' },
  { id: 'el codigo acepta letras', f: 'superadmin.js', de: 'cod.value = cod.value.replace(/' + sl + 'D/g, "").slice(0, 6);', a: '', todos: true, esc: '^3[.]' },
  { id: 'sin proteccion de doble clic (SA.enviar)', f: 'superadmin.js', de: 'if (btn.getAttribute("data-ocupado") === "1") return Promise.resolve();', a: '', esc: '^(10|12|13)[.]' },
  { id: 'cancelar la confirmacion confirma', f: 'superadmin.js', de: 'fin(false); mm.cerrar();', a: 'fin(true); mm.cerrar();', esc: '^(12|13)[.]' },
  // ---- alta
  { id: 'alta: la contrasena temporal no se borra', f: 'superadmin-alta.js', de: 'function limpiarClave() {', a: 'function limpiarClave() { return;', esc: '^10[.]' },
  { id: 'alta: nombre corto sin validar', f: 'superadmin-alta.js', de: 'if (!SLUG.test(s) || s.length < 2 || s.length > 40)', a: 'if (false)', esc: '^10[.]' },
  { id: 'alta: nombres reservados permitidos', f: 'superadmin-alta.js', de: 'if (RESERVADOS.indexOf(s) >= 0)', a: 'if (false)', esc: '^10[.]' },
  { id: 'alta: direccion web sin validar', f: 'superadmin-alta.js', de: 'if (!HOST.test(hh))', a: 'if (false)', esc: '^10[.]' },
  { id: 'alta: correo sin validar', f: 'superadmin-alta.js', de: new RegExp('if \\(!CORREO\\.test\\(c\\) \\|\\| c\\.length > 254\\) return '), a: 'if (false) return ', esc: '^10[.]' },
  { id: 'alta: el reintento crea otro restaurante', f: 'superadmin-alta.js', de: /if \(!est\.restaurante\) \{(\s+cadena)/, a: 'if (true) {$1', esc: '^11[.]' },
  { id: 'alta: un correo que ya existe intenta crear otra cuenta', f: 'superadmin-alta.js', de: /if \(est\.usuario\) \{(\s+return SA\.api\("asignar_miembro")/, a: 'if (false) {$1', esc: '^11[.]' },
  { id: 'alta: dias de prueba equivocados', f: 'superadmin-alta.js', de: 'var vence = SA.fecha.sumarDias(SA.fecha.hoy(), est.dias);', a: 'var vence = SA.fecha.sumarDias(SA.fecha.hoy(), 7);', esc: '^10[.]' },
  // ---- detalle
  { id: 'secretos: los campos no se vacian', f: 'superadmin-detalle.js', de: 'function vaciar() {', a: 'function vaciar() { return;', esc: '^15[.]' },
  { id: 'secretos: campos visibles (type=text)', f: 'superadmin-detalle.js', de: 'type: "password", id: "sa-sec-"', a: 'type: "text", id: "sa-sec-"', esc: '^15[.]' },
  { id: 'secretos: autocompletar activado', f: 'superadmin-detalle.js', de: 'autocomplete: "new-password", spellcheck: "false"', a: 'autocomplete: "on", spellcheck: "false"', esc: '^15[.]' },
  { id: 'secretos: siempre reemplaza', f: 'superadmin-detalle.js', de: 'sobrescribir: sobrescribir,', a: 'sobrescribir: true,', esc: '^15[.]' },
  { id: 'usuarios: la contrasena temporal no se puede borrar', f: 'superadmin-detalle.js', de: 'borrarBtn.addEventListener("click", limpiar);', a: 'borrarBtn.addEventListener("click", function () {});', esc: '^13[.]' },
  { id: 'pago: manda siempre 1 mes', f: 'superadmin-detalle.js', de: 'var datos = { restaurante_id: id, meses: mm_ };', a: 'var datos = { restaurante_id: id, meses: 1 };', esc: '^12[.]' },
  { id: 'suspender sin confirmar', f: 'superadmin-detalle.js', de: /(boton: "S.\ssuspender", peligro: true \}\)\.then\(function \(si\) \{\s*)if \(!si\) return;/, a: '$1', esc: '^12[.]' },
  { id: 'quitar dominio sin confirmar', f: 'superadmin-detalle.js', de: /(boton: "S.\squitar", peligro: true \}\)\.then\(function \(si\) \{\s*)if \(!si\) return;/, a: '$1', esc: '^13[.]' },
  { id: 'color mal escrito sin validar', f: 'superadmin-detalle.js', de: 'if (v !== "" && !HEX.test(v))', a: 'if (false)', esc: '^14[.]' },
  { id: 'tarifa de 0 km permitida', f: 'superadmin-detalle.js', de: 'hasta <= 0 || ', a: '', esc: '^14[.]' },
  { id: 'cambiar plan sin cambios manda igual', f: 'superadmin-detalle.js', de: 'if (!Object.keys(cambios).length) throw new Error("No cambiaste nada.");', a: '', esc: '^12[.]' },
  // ---- entrar como
  { id: 'entrar como: una llamada que escribe', f: 'superadmin-lectura.js', de: 'SA.apiLectura("ver_resumen", { restaurante_id: id }).then(', a: 'SA.api("registrar_pago", { restaurante_id: id, meses: 1 }); SA.apiLectura("ver_resumen", { restaurante_id: id }).then(', esc: '^16[.]' },
  { id: 'entrar como: un campo de texto', f: 'superadmin-lectura.js', de: 'errorArea, tablist, panel);', a: 'errorArea, tablist, panel, h("input", { type: "text" }));', esc: '^16[.]' },
  { id: 'entrar como: la paginacion no manda antes_de', f: 'superadmin-lectura.js', de: 'if (!reiniciar && siguiente) datos.antes_de = siguiente;', a: '', esc: '^16[.]' },
  { id: 'entrar como: nombre de producto sin sanear', f: 'superadmin-lectura.js', de: 'h("span", { texto: cant + t(it.nombre, 120)', a: 'h("span", { texto: cant + String(it.nombre)', esc: '^16[.]' },
  { id: 'entrar como: la barra normal sigue visible', f: 'superadmin-lectura.js', de: 'SA.ocultarBarra(true);', a: '', esc: '^16[.]' },
  { id: 'entrar como: la franja deja de ser fija', f: 'superadmin.css', de: new RegExp('[.]sa-franja-lectura \\{\\s*position: fixed;'), a: '.sa-franja-lectura {\n  position: absolute;', esc: '^16[.]' },
  { id: 'estilos: controles de 44px a 20px', f: 'superadmin.css', de: 'input:not([type=checkbox]):not([type=radio]) { min-height: 44px; }', a: 'input:not([type=checkbox]):not([type=radio]) { min-height: 20px; }', esc: '^19[.]' },
  { id: 'estilos: sin contorno de foco', f: 'superadmin.css', de: ':focus-visible { outline: 3px solid var(--acento); outline-offset: 2px; border-radius: 6px; }', a: ':focus-visible { outline: none; }', esc: '^19[.]' },
  // ---- cabeceras
  { id: 'cabeceras: CSP con unsafe-inline', f: 'vercel.json', de: "script-src 'self';", a: "script-src 'self' 'unsafe-inline';", esc: '^1[.]' },
  { id: 'cabeceras: sin X-Frame-Options', f: 'vercel.json', de: '"key": "X-Frame-Options"', a: '"key": "X-Frame-Optionz"', esc: '^1[.]' },
  { id: 'cabeceras: para TODAS las rutas', f: 'vercel.json', de: '"source": "/superadmin.html"', a: '"source": "/(.*)"', esc: '^1[.]' },
  { id: 'cabeceras: frame-ancestors abierto', f: 'vercel.json', de: "frame-ancestors 'none'", a: 'frame-ancestors *', esc: '^1[.]' },
  { id: 'cabeceras: la pagina se cachea', f: 'vercel.json', de: '"value": "no-store"', a: '"value": "max-age=3600"', esc: '^1[.]' },
  { id: 'cabeceras: conectar a cualquier sitio', f: 'vercel.json', de: "connect-src 'self' ", a: "connect-src * 'self' ", esc: '^1[.]' },
  // ---- borrar-restaurante-prueba.mjs
  { id: 'borrar: acepta el demo', t: 'borrar', de: 'if (r.id === ID_DEMO) return salir(2, "NO se borra: ese es el restaurante demo.");', a: '' },
  { id: 'borrar: sin exigir el prefijo de prueba', t: 'borrar', de: 'slug.indexOf(prefijo) !== 0 || slug === prefijo', a: 'false', todos: true },
  { id: 'borrar: ignora los pedidos pagados', t: 'borrar', de: 'listaPedidos.some((p) => p.estado_pago === "aprobado" || p.pagado_en)', a: 'false' },
  { id: 'borrar: ignora la fecha de pago', t: 'borrar', de: ' || p.pagado_en)', a: ')' },
  { id: 'borrar: no pide escribir el nombre', t: 'borrar', de: 'if (escrito !== slug)', a: 'if (false)' },
  { id: 'borrar: borra filas de OTROS restaurantes', t: 'borrar', de: '`${t}?restaurante_id=eq.${r.id}`, { Prefer: "return=minimal" }', a: '`${t}?restaurante_id=neq.${r.id}`, { Prefer: "return=minimal" }' },
  { id: 'borrar: borra de verdad sin --aplicar', t: 'borrar', de: 'const aplicar = args.includes("--aplicar");', a: 'const aplicar = true;' },
  { id: 'borrar: acepta un prefijo de 2 letras', t: 'borrar', de: 'prefijo.length < 4', a: 'prefijo.length < 0' },
  { id: 'borrar: se olvida de los pedidos', t: 'borrar', de: '"producto_opciones", "pedidos", ', a: '"producto_opciones", ' },
  // ---- equivalentes declaradas (se corren igual: si alguna se detecta, mejor)
  { id: 'EQUIVALENTE: SA.apiLectura sin su lista blanca (no hay ninguna llamada que escriba desde esa vista; es defensa en profundidad)', f: 'superadmin.js', de: 'if (ACCIONES_LECTURA.indexOf(accion) < 0) return Promise.reject(new Error("Acci', a: 'if (false) return Promise.reject(new Error("Acci', esc: '^16[.]', equivalente: true },
  { id: 'EQUIVALENTE: secretos sin vaciar antes de esperar la respuesta (se vacian igual al llegar la respuesta)', f: 'superadmin-detalle.js', de: 'Object.keys(entradas).forEach(function (k) { entradas[k].value = ""; });   // se vacian ANTES de esperar la respuesta', a: '', esc: '^15[.]', equivalente: true }
];

const lista = M.filter((m) => !SOLO || m.id.includes(SOLO));
const raizTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-pantalla-'));
const ARCH = ['superadmin.html', 'superadmin.css', 'superadmin.js', 'superadmin-alta.js', 'superadmin-detalle.js', 'superadmin-lectura.js', 'superadmin-inicio.js', 'vercel.json', 'supabase-publico.js'];

function copiaPantalla(nombre, mutacion) {
  const dir = path.join(raizTemp, nombre);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ARCH) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  if (mutacion) {
    const p = path.join(dir, mutacion.f);
    let txt = fs.readFileSync(p, 'utf8');
    const de = mutacion.de;
    const hay = typeof de === 'string' ? txt.includes(de) : de.test(txt);
    if (!hay) return { dir, noAplica: true };
    if (typeof de === 'string') txt = mutacion.todos ? txt.split(de).join(mutacion.a) : txt.replace(de, () => mutacion.a);
    else txt = txt.replace(mutacion.todos ? new RegExp(de.source, de.flags + 'g') : de, mutacion.a);
    fs.writeFileSync(p, txt);
  }
  return { dir };
}
function copiaBorrar(nombre, mutacion) {
  const dir = path.join(raizTemp, nombre);
  fs.mkdirSync(path.join(dir, 'supabase'), { recursive: true }); fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'api', '_llave.js'), path.join(dir, 'api', '_llave.js'));
  fs.copyFileSync(path.join(REPO, 'supabase-publico.js'), path.join(dir, 'supabase-publico.js'));
  const p = path.join(dir, 'supabase', 'borrar-restaurante-prueba.mjs');
  let txt = fs.readFileSync(path.join(REPO, 'supabase', 'borrar-restaurante-prueba.mjs'), 'utf8');
  if (mutacion) {
    if (!txt.includes(mutacion.de)) return { dir, noAplica: true };
    txt = mutacion.todos ? txt.split(mutacion.de).join(mutacion.a) : txt.replace(mutacion.de, () => mutacion.a);
  }
  fs.writeFileSync(p, txt);
  return { dir, script: p };
}
function correr(archivo, env) {
  return new Promise((ok) => {
    const h = spawn(process.execPath, [path.join(DIR, archivo)], { cwd: REPO, env: { ...process.env, ...env, CAPTURAS: '0' } });
    let out = '';
    h.stdout.on('data', (d) => { out += d; }); h.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { h.kill(); }, 900000);
    h.on('close', (c) => { clearTimeout(t); ok({ codigo: c, salida: out }); });
  });
}

let siguiente = 0;
const resultados = [];
async function trabajador(k) {
  const puertos = { PUERTO_WEB: String(8110 + k * 10), PUERTO_CDP: String(9350 + k * 10), PUERTO_FALSO: String(54370 + k * 10), BORRAR_PUERTO: String(54380 + k * 10) };
  for (;;) {
    const i = siguiente++;
    if (i >= lista.length) return;
    const m = lista[i];
    let r;
    if (m.t === 'borrar') {
      const c = copiaBorrar('m' + i, m);
      r = c.noAplica ? { noAplica: true } : await correr('borrar-prueba-test.mjs', { ...puertos, BORRAR_SCRIPT: c.script });
    } else {
      const c = copiaPantalla('m' + i, m);
      r = c.noAplica ? { noAplica: true } : await correr('superadmin-pantalla.mjs', { ...puertos, PANTALLA_RAIZ: c.dir, SOLO: m.esc });
    }
    const detectada = !r.noAplica && r.codigo !== 0;
    resultados.push({ m, detectada, noAplica: !!r.noAplica });
    const marca = r.noAplica ? 'NO APLICA' : detectada ? 'detectada ' : (m.equivalente ? 'equivalente (sobrevive, declarada)' : 'SOBREVIVIO');
    console.log(`  ${marca.padEnd(10)} ${m.id}`);
  }
}

console.log(`Control (la copia sin tocar debe pasar todo)...`);
const ctrlP = copiaPantalla('control-p', null), ctrlB = copiaBorrar('control-b', null);
const puertosC = { PUERTO_WEB: '8100', PUERTO_CDP: '9340', PUERTO_FALSO: '54350', BORRAR_PUERTO: '54360' };
const [cp, cb] = await Promise.all([correr('superadmin-pantalla.mjs', { ...puertosC, PANTALLA_RAIZ: ctrlP.dir }), correr('borrar-prueba-test.mjs', { ...puertosC, BORRAR_SCRIPT: ctrlB.script })]);
console.log(`  pantalla: ${cp.codigo === 0 ? 'pasa todo' : 'FALLA'}   borrar: ${cb.codigo === 0 ? 'pasa todo' : 'FALLA'}`);
if (cp.codigo !== 0 || cb.codigo !== 0) { console.log((cp.codigo ? cp.salida : cb.salida).split('\n').filter((l) => /FALLA/.test(l)).slice(0, 8).join('\n')); process.exit(1); }

console.log(`\n${lista.length} mutaciones, ${PARALELO} a la vez...`);
await Promise.all(Array.from({ length: PARALELO }, (_, k) => trabajador(k)));
const sobrevivientes = resultados.filter((r) => !r.detectada && !r.noAplica && !r.m.equivalente);
const noAplican = resultados.filter((r) => r.noAplica);
const equivalentes = resultados.filter((r) => !r.detectada && !r.noAplica && r.m.equivalente);
console.log(`\n${resultados.length} mutaciones: ${resultados.filter((r) => r.detectada).length} detectadas, ${equivalentes.length} equivalentes declaradas, ${noAplican.length} que no aplican, ${sobrevivientes.length} SIN DETECTAR`);
for (const r of sobrevivientes) console.log('  SIN DETECTAR: ' + r.m.id);
for (const r of noAplican) console.log('  NO APLICA (revisar el texto buscado): ' + r.m.id);
try { fs.rmSync(raizTemp, { recursive: true, force: true }); } catch (e) { /* en uso */ }
process.exitCode = sobrevivientes.length || noAplican.length ? 1 : 0;
