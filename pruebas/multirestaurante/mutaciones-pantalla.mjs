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
  { id: 'EQUIVALENTE: la clave del QR no se borra a mano (igual se borra al cambiar de pantalla, que vacia todo el DOM)', equivalente: true, f: 'superadmin.js', de: 'function limpiarSecreto() { if (qr) qr.removeAttribute("src"); claveEl.textContent = ""; f = null; enrolando = null; }', a: 'function limpiarSecreto() { }', esc: '^3[.]' },
  { id: 'el codigo acepta letras', f: 'superadmin.js', de: 'cod.value = cod.value.replace(/' + sl + 'D/g, "").slice(0, 6);', a: '', todos: true, esc: '^3[.]' },
  { id: 'EQUIVALENTE: SA.enviar sin su marca de ocupado (el boton ya queda disabled y un boton disabled no recibe mas clics)', equivalente: true, f: 'superadmin.js', de: 'if (btn.getAttribute("data-ocupado") === "1") return Promise.resolve();', a: '', esc: '^(10|12|13)[.]' },
  { id: 'cancelar la confirmacion confirma', f: 'superadmin.js', de: 'fin(false); mm.cerrar();', a: 'fin(true); mm.cerrar();', esc: '^(12|13)[.]' },
  // ---- alta
  { id: 'alta: la contrasena temporal no se borra', f: 'superadmin-alta.js', de: 'function limpiarClave() {', a: 'function limpiarClave() { return;', esc: '^10[.]' },
  { id: 'alta: nombre corto sin validar', f: 'superadmin-alta.js', de: 'if (!SLUG.test(s) || s.length < 2 || s.length > 40)', a: 'if (false)', esc: '^10[.]' },
  { id: 'alta: nombres reservados permitidos', f: 'superadmin-alta.js', de: 'if (RESERVADOS.indexOf(s) >= 0)', a: 'if (false)', esc: '^10[.]' },
  { id: 'alta: direccion web sin validar', f: 'superadmin-alta.js', de: 'if (!HOST.test(hh))', a: 'if (false)', esc: '^10[.]' },
  { id: 'EQUIVALENTE: alta: correo sin validar en el paso 3 (la misma regla vuelve a correr en consultar() y el servidor la repite)', equivalente: true, f: 'superadmin-alta.js', de: new RegExp('if \\(!CORREO\\.test\\(c\\) \\|\\| c\\.length > 254\\) return '), a: 'if (false) return ', esc: '^10[.]' },
  { id: 'alta: el reintento crea otro restaurante', f: 'superadmin-alta.js', de: /if \(!est\.restaurante\) \{(\s+cadena)/, a: 'if (true) {$1', esc: '^11[.]' },
  { id: 'alta: un correo que ya existe intenta crear otra cuenta', f: 'superadmin-alta.js', de: /if \(est\.usuario\) \{(\s+return SA\.api\("asignar_miembro")/, a: 'if (false) {$1', esc: '^11[.]' },
  { id: 'alta: dias de prueba equivocados', f: 'superadmin-alta.js', de: 'var vence = SA.fecha.sumarDias(SA.fecha.hoy(), est.dias);', a: 'var vence = SA.fecha.sumarDias(SA.fecha.hoy(), 7);', esc: '^10[.]' },
  // ---- detalle
  { id: 'EQUIVALENTE: secretos: vaciar() sin el vaciado previo (se vacian en el vaciado previo; solo juntos se notan: ver la siguiente)', equivalente: true, f: 'superadmin-detalle.js', de: 'function vaciar() {', a: 'function vaciar() { return;', esc: '^15[.]' },
  { id: 'secretos: los campos NUNCA se vacian (ni antes ni despues de la respuesta)', f: 'superadmin-detalle.js', de: 'function vaciar() {', a: 'function vaciar() { return;', tambien: [{ de: 'Object.keys(entradas).forEach(function (k) { entradas[k].value = ""; });   // se vacian ANTES de esperar la respuesta', a: '' }], esc: '^15[.]' },
  // (las dos mutaciones de antes sobre type=password y autocomplete="new-password" se reemplazaron por las de R9 de abajo: esos atributos cambiaron a proposito)
  { id: 'secretos: siempre reemplaza', f: 'superadmin-detalle.js', de: 'sobrescribir: sobrescribir,', a: 'sobrescribir: true,', esc: '^15[.]' },
  { id: 'usuarios: la contrasena temporal no se puede borrar', f: 'superadmin-detalle.js', de: 'borrarBtn.addEventListener("click", function () { limpiar(); });', a: 'borrarBtn.addEventListener("click", function () {});', esc: '^13[.]' },
  { id: 'pago: manda siempre 1 mes', f: 'superadmin-detalle.js', de: 'var datos = { restaurante_id: id, meses: mm_ };', a: 'var datos = { restaurante_id: id, meses: 1 };', esc: '^12[.]' },
  { id: 'suspender sin confirmar', f: 'superadmin-detalle.js', de: /(boton: "S.[,] suspender", peligro: true \}\)\.then\(function \(si\) \{\s*)if \(!si\) return;/, a: '$1', esc: '^12[.]' },
  { id: 'quitar dominio sin confirmar', f: 'superadmin-detalle.js', de: /(boton: "S.[,] quitar", peligro: true \}\)\.then\(function \(si\) \{\s*)if \(!si\) return;/, a: '$1', esc: '^13[.]' },
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
  { id: 'borrar: ignora los pedidos pagados', t: 'borrar', de: 'if (filas.length) return salir(2,', a: 'if (false) return salir(2,' },
  { id: 'borrar: ignora la fecha de pago', t: 'borrar', de: '["estado_pago=eq.aprobado", "pagado_en=not.is.null"]', a: '["estado_pago=eq.aprobado"]' },
  { id: 'borrar: revisa solo la lista devuelta (Supabase la corta en 1000 filas; 24.13 R3)', t: 'borrar', de: '&${filtro}&select=restaurante_id&limit=1', a: '&select=estado_pago,pagado_en&limit=5000', tambien: [{ de: 'if (filas.length) return salir(2,', a: 'if (filas.some((x) => x.estado_pago === "aprobado" || x.pagado_en)) return salir(2,' }] },
  { id: 'EQUIVALENTE: borrar: el DELETE de pedidos sin excluir los pagados (la guarda de antes ya se nego; solo cubre un pago que llegue en ese mismo instante)', equivalente: true, t: 'borrar', de: '"&estado_pago=neq.aprobado&pagado_en=is.null"', a: '""' },
  { id: 'borrar: no pide escribir el nombre', t: 'borrar', de: 'if (escrito !== slug)', a: 'if (false)' },
  { id: 'borrar: borra filas de OTROS restaurantes', t: 'borrar', de: '`${t}?restaurante_id=eq.${r.id}${extra}`', a: '`${t}?restaurante_id=neq.${r.id}${extra}`' },
  { id: 'borrar: borra de verdad sin --aplicar', t: 'borrar', de: 'const aplicar = args.includes("--aplicar");', a: 'const aplicar = true;' },
  { id: 'borrar: acepta un prefijo de 2 letras', t: 'borrar', de: 'prefijo.length < 4', a: 'prefijo.length < 0' },
  { id: 'borrar: se olvida de los pedidos', t: 'borrar', de: '"producto_opciones", "pedidos", ', a: '"producto_opciones", ' },
  // ---- revision adversaria (docs 24.13)
  { id: 'R1: la pantalla arranca en cualquier direccion (sin sus cabeceras)', f: 'superadmin-inicio.js', de: 'if (window.location.pathname !== "/superadmin.html") { window.location.replace("/superadmin.html"); return; }', a: '', esc: '^20[.]' },
  { id: 'R1: la pantalla arranca dentro de un marco', f: 'superadmin-inicio.js', de: 'if (enMarco) return;', a: '', esc: '^20[.]' },
  { id: 'EQUIVALENTE: R2: sin descartar la respuesta vieja de buscar_usuario (el paso 3 vuelve a comprobar el correo escrito)', equivalente: true, f: 'superadmin-alta.js', de: 'if (correo.value.trim().toLowerCase() !== c) return;', a: '', esc: '^20[.]' },
  { id: 'R2: la respuesta vieja de buscar_usuario decide el dueno (sin descartarla ni volver a comprobar)', f: 'superadmin-alta.js', de: 'if (correo.value.trim().toLowerCase() !== c) return;', a: '', tambien: [{ de: 'if (est.usuario !== undefined && est.usuarioDe === c) return null;', a: 'if (est.usuario !== undefined) return null;' }], esc: '^20[.]' },
  { id: 'R2: las tres defensas quitadas (asigna la cuenta equivocada)', f: 'superadmin-alta.js', de: 'if (correo.value.trim().toLowerCase() !== c) return;', a: '', tambien: [{ de: 'if (est.usuario !== undefined && est.usuarioDe === c) return null;', a: 'if (est.usuario !== undefined) return null;' }, { de: 'if (est.usuario && est.usuarioDe !== est.correo) throw', a: 'if (false) throw' }], esc: '^20[.]' },
  { id: 'I: textContent cambiado por innerHTML escrito con corchetes (esquiva la revision de codigo)', f: 'superadmin.js', de: 'else if (k === "texto") el.textContent = v;', a: 'else if (k === "texto") el["inner" + "HTML"] = v;', esc: '^(1|9|16|17)[.]' },
  { id: 'I: los nodos de texto sueltos como HTML (alias de insertAdjacentHTML)', f: 'superadmin.js', de: 'else el.appendChild(document.createTextNode(String(hijo)));', a: 'else { var _m = "insertAdjacent" + "HTML"; el[_m]("beforeend", String(hijo)); }', esc: '^(1|9|16|17)[.]' },
  // ---- pulido de la pantalla (docs 24.15)
  // 1. "Sin" una sola vez
  { id: 'Sin: se repite el prefijo (SIN Sin tocineta)', f: 'superadmin-lectura.js', de: 'if (ya) return ya[1] ? "Sin " + ya[1] : "Sin";', a: '', esc: '^16[.]' },
  { id: 'Sin: depende de mayusculas', f: 'superadmin-lectura.js', de: '))?$/i.exec(nombre);', a: '))?$/.exec(nombre);', esc: '^16[.]' },
  { id: 'Sin: nunca se antepone', f: 'superadmin-lectura.js', de: 'return nombre ? "Sin " + nombre : "Sin";', a: 'return nombre;', esc: '^16[.]' },
  { id: 'Sin: los extras pierden su "+"', f: 'superadmin-lectura.js', de: 'return "+ " + nombre + (typeof o.precio', a: 'return nombre + (typeof o.precio', esc: '^16[.]' },
  // 2. auditoria con nombre
  { id: 'auditoria: el nombre no se muestra (solo el nombre corto)', f: 'superadmin.js', de: 'var nombre = r && r.nombre ? t(r.nombre, 80) : "";', a: 'var nombre = "";', esc: '^(17|21)[.]' },
  { id: 'auditoria: un restaurante borrado recibe un nombre inventado', f: 'superadmin.js', de: /(SA\.lista\[i\]\.id === id\) return SA\.lista\[i\];\s+)return null;/, a: '$1return { nombre: "Inventado", slug: "x" };', esc: '^21[.]' },
  { id: 'auditoria: se ignora el nombre corto que guardo la fila (el borrado queda sin nada)', f: 'superadmin.js', de: 'var slug = fila.restaurante_slug || (r && r.slug) || "";', a: 'var slug = (r && r.slug) || "";', esc: '^21[.]' },
  { id: 'auditoria: el filtro no lista los restaurantes borrados', f: 'superadmin.js', de: 'filtroRest.appendChild(h("option", { value: f.restaurante_id,', a: '(h("option", { value: f.restaurante_id,', esc: '^21[.]' },
  { id: 'auditoria: la pestana del restaurante no conoce su propio nombre', f: 'superadmin-detalle.js', de: '{ restaurante: { id: D.id, nombre: D.nombre, slug: D.slug } }', a: '{}', esc: '^(17|21)[.]' },
  // 3. resumen legible
  { id: 'resumen: nunca se explica en espanol', f: 'superadmin.js', de: 'if (!esObjeto(r) || typeof accion !== "string" || !tiene(FORMATOS, accion)) return null;', a: 'return null;', esc: '^22[.]' },
  { id: 'resumen: el detalle tecnico queda vacio', f: 'superadmin.js', de: 'hidden: true, texto: textoTecnico(r) });', a: 'hidden: true, texto: "" });', esc: '^22[.]' },
  { id: 'resumen: el detalle tecnico como HTML (con corchetes)', f: 'superadmin.js', de: 'var pre = h("pre", { class: "sa-aud-resumen", hidden: true, texto: textoTecnico(r) });', a: 'var pre = h("pre", { class: "sa-aud-resumen", hidden: true }); pre["inner" + "HTML"] = textoTecnico(r);', esc: '^22[.]' },
  { id: 'resumen: el detalle tecnico visible desde el principio', f: 'superadmin.js', de: 'hidden: true, texto: textoTecnico(r) });', a: 'texto: textoTecnico(r) });', esc: '^22[.]' },
  { id: 'resumen: las etiquetas se buscan en el prototipo (__proto__ y constructor salen como codigo)', f: 'superadmin.js', de: 'return typeof k === "string" && tiene(mapa, k) ? mapa[k] : t(k, 40);', a: 'return typeof k === "string" && mapa[k] ? mapa[k] : t(k, 40);', esc: '^22[.]' },
  { id: 'resumen: el estado se muestra al reves (despues → antes)', f: 'superadmin.js', de: 'c.linea(ETQ_CAMPO[k], f(a[k]) + " → " + f(d[k]));', a: 'c.linea(ETQ_CAMPO[k], f(d[k]) + " → " + f(a[k]));', esc: '^22[.]' },
  { id: 'resumen: un campo de mas no se avisa', f: 'superadmin.js', de: 'Object.keys(r).forEach(function (k) { if (!usadas[k]) dudoso = true; });', a: '', esc: '^22[.]' },
  { id: 'resumen: una forma rara se inventa (texto en vez de numero)', f: 'superadmin.js', de: 'if (typeof v === "number" && isFinite(v)) return v; dudoso = true; return undefined;', a: 'return Number(v);', esc: '^22[.]' },
  { id: 'resumen: el rol sin traducir', f: 'superadmin.js', de: 'c.linea("Rol", c.mapa("rol", ETQ_ROL));', a: 'c.linea("Rol", c.txt("rol", 20));', esc: '^22[.]' },
  { id: 'resumen: el modo de pedidos sin traducir', f: 'superadmin.js', de: 'c.linea("Pedidos mirados", c.mapa("modo", ETQ_MODO));', a: 'c.linea("Pedidos mirados", c.txt("modo", 20));', esc: '^22[.]' },
  // 4. R4: hora limite
  { id: 'R4: el reloj del sistema no cuenta (solo performance.now)', f: 'superadmin.js', de: 'return Math.min(finReloj - Date.now(), finMono - performance.now());', a: 'return finMono - performance.now();', esc: '^23[.]' },
  { id: 'R4: performance.now de apoyo no cuenta (solo el reloj del sistema)', f: 'superadmin.js', de: 'return Math.min(finReloj - Date.now(), finMono - performance.now());', a: 'return finReloj - Date.now();', esc: '^23[.]' },
  { id: 'R4: no se revisa al volver (focus y pageshow)', f: 'superadmin.js', de: 'window.addEventListener("focus", revisar); window.addEventListener("pageshow", revisar);', a: '', esc: '^23[.]' },
  { id: 'R4: no se revisa con visibilitychange', f: 'superadmin.js', de: 'document.addEventListener("visibilitychange", alCambiarVisibilidad);', a: '', esc: '^23[.]' },
  { id: 'R4: no hay revision cada segundo', f: 'superadmin.js', de: 'intervalo = setInterval(revisar, 1000);', a: '', esc: '^23[.]' },
  { id: 'R4: la pestana oculta mucho rato no cuenta', f: 'superadmin.js', de: 'if (fuera > MAX_OCULTA_MS) { vencer("oculta"); return; }', a: '', esc: '^23[.]' },
  { id: 'R4: oculta se tolera 100 minutos', f: 'superadmin.js', de: 'var MAX_OCULTA_MS = 60000;', a: 'var MAX_OCULTA_MS = 6000000;', esc: '^23[.]' },
  { id: 'R4: al vencer no se borra (alta)', f: 'superadmin-alta.js', de: 'alVencer: function (motivo) { est.vigia = null; est.clave = null; est.motivoBorrado = motivo; pintarClave(); }', a: 'alVencer: function (motivo) { est.vigia = null; }', esc: '^23[.]' },
  { id: 'R4: al vencer no se borra (usuarios)', f: 'superadmin-detalle.js', de: 'alVencer: function (motivo) { vigia = null; limpiar(motivo); }', a: 'alVencer: function (motivo) { vigia = null; }', esc: '^23[.]' },
  { id: 'R4: vencer no borra la contrasena (la parada se hace pero no se avisa)', f: 'superadmin.js', de: 'function vencer(motivo) { if (parar() && o.alVencer) o.alVencer(motivo); }', a: 'function vencer(motivo) { parar(); }', esc: '^23[.]' },
  { id: 'R4: duran 5 horas en vez de 3 minutos', f: 'superadmin-detalle.js', de: 'segundos: 180,', a: 'segundos: 18000,', esc: '^23[.]' },
  { id: 'R4: la caja del detalle no cancela su vigilante al borrarse', f: 'superadmin-detalle.js', de: 'if (vigia) { vigia.cancelar(); vigia = null; }', a: '', esc: '^24[.]' },
  { id: 'R4: el alta no cancela su vigilante', f: 'superadmin-alta.js', de: 'if (est.vigia) { est.vigia.cancelar(); est.vigia = null; }', a: '', esc: '^(10|24)[.]' },
  // 5. R6
  { id: 'R6: volver del codigo rearma la vista (pierde la contrasena)', f: 'superadmin.js', de: 'if (vistaActual && vistasRetenidas > 0) { tic(); return; }', a: '', esc: '^24[.]' },
  { id: 'R6: un 401 con la contrasena a la vista no avisa', f: 'superadmin.js', de: 'var perdioClave = limpiarTodo();', a: 'limpiarTodo(); var perdioClave = false;', esc: '^24[.]' },
  { id: 'R6: la contrasena no retiene la vista', f: 'superadmin.js', de: 'var liberar = SA.retenerVista();', a: 'var liberar = function () {};', esc: '^24[.]' },
  { id: 'R6: la contrasena no se cuenta como viva (el 401 no avisa)', f: 'superadmin.js', de: 'clavesVivas++;', a: '', esc: '^24[.]' },
  { id: 'R6: un alta a medias no retiene la vista', f: 'superadmin-alta.js', de: 'est.liberarVista = SA.retenerVista();', a: '', esc: '^24[.]' },
  // 6. R7
  { id: 'R7: "Atras" sigue disponible con el restaurante ya creado', f: 'superadmin-alta.js', de: 'var recuperando = !!est.restaurante;   // el restaurante YA existe', a: 'var recuperando = false;   // el restaurante YA existe', esc: '^(11|25)[.]' },
  { id: 'R7: los pasos ya ejecutados vuelven a ser formularios', f: 'superadmin-alta.js', de: 'var bloqueado = !!est.restaurante && (', a: 'var bloqueado = false && (', esc: '^25[.]' },
  { id: 'R7: el correo del dueno se corrige pero se vuelve al paso 4', f: 'superadmin-alta.js', de: '}, recuperando ? 5 : undefined);', a: '}, undefined);', esc: '^25[.]' },
  { id: 'R7: el mensaje usa el nombre escrito y no el confirmado', f: 'superadmin-alta.js', de: 'var nombreCreado = String(creado.nombre === undefined || creado.nombre === null ? est.nombre : creado.nombre);', a: 'var nombreCreado = est.nombre;', esc: '^25[.]' },
  { id: 'R7: el mensaje usa el correo escrito y no el confirmado', f: 'superadmin-alta.js', de: 'var correoCreado = est.usuarioConfirmado && est.usuarioConfirmado.email ? est.usuarioConfirmado.email : est.correo;', a: 'var correoCreado = est.correo;', esc: '^25[.]' },
  { id: 'R7: el mensaje usa la direccion escrita y no la confirmada', f: 'superadmin-alta.js', de: '(Array.isArray(creado.dominios) && typeof creado.dominios[0] === "string" && creado.dominios[0]) ||', a: '(est.dominioModo === "propio" && est.host) ||', esc: '^25[.]' },
  { id: 'R7: el servidor no confirma el correo (se queda con lo escrito)', f: 'superadmin-alta.js', de: 'est.usuarioConfirmado = { email: (r && r.usuario && typeof r.usuario.email === "string" && r.usuario.email) || est.correo };', a: 'est.usuarioConfirmado = { email: est.correo };', esc: '^25[.]' },
  { id: 'R7: el reintento crea otro restaurante (con la pantalla de reintento)', f: 'superadmin-alta.js', de: /if \(!est\.restaurante\) \{(\s+cadena)/, a: 'if (true) {$1', esc: '^25[.]' },
  { id: 'R7: el fallo a medias no vuelve a pintar el paso (sigue el boton viejo)', f: 'superadmin-alta.js', de: 'est.aviso = t(motivo, 600);\n          pintar();', a: 'est.aviso = t(motivo, 600);', esc: '^(11|25)[.]' },
  // 7. R8
  { id: 'R8: el aviso del portapapeles sin texto util', f: 'superadmin.js', de: 'texto: "Ojo: lo que copias se queda en el portapapeles.', a: 'texto: "Listo. Lo que copias', esc: '^26[.]' },
  { id: 'R8: nunca se intenta vaciar', f: 'superadmin.js', de: 'if (ok) programarVaciado();', a: '', esc: '^26[.]' },
  { id: 'R8: se vacia al segundo (no a los 60 s)', f: 'superadmin.js', de: 'var VACIAR_PORTAPAPELES_MS = 60000;', a: 'var VACIAR_PORTAPAPELES_MS = 1000;', esc: '^26[.]' },
  { id: 'R8: se vacia aunque la pestana no tenga foco ni este visible', f: 'superadmin.js', de: 'if (document.visibilityState !== "visible" || !document.hasFocus()) return;', a: '', esc: '^26[.]' },
  { id: 'R8: se vacia con la pestana oculta si tiene foco', f: 'superadmin.js', de: 'if (document.visibilityState !== "visible" || !document.hasFocus()) return;', a: 'if (!document.hasFocus()) return;', esc: '^26[.]' },
  { id: 'R8: se vacia sin foco si esta visible', f: 'superadmin.js', de: 'if (document.visibilityState !== "visible" || !document.hasFocus()) return;', a: 'if (document.visibilityState !== "visible") return;', esc: '^26[.]' },
  { id: 'R8: si el navegador lo rechaza se ve el error', f: 'superadmin.js', de: 'function () { /* el navegador no lo permitio: sin ruido */ });', a: 'function (e) { throw e; });', esc: '^26[.]' },
  { id: 'R8: si el navegador lanza una excepcion se ve el error', f: 'superadmin.js', de: 'catch (e) { /* el navegador no lo permite: sin ruido */ }', a: 'catch (e) { throw e; }', esc: '^26[.]' },
  { id: 'R8: copiar de nuevo no reinicia la cuenta', f: 'superadmin.js', de: 'clearTimeout(tVaciar);', a: '', esc: '^26[.]' },
  { id: 'R8: la clave del TOTP copiada sin aviso', f: 'superadmin.js', de: 'claveEl, h("p", null, copiarBtn), SA.avisoPortapapeles(),', a: 'claveEl, h("p", null, copiarBtn),', esc: '^26[.]' },
  { id: 'R8: la contrasena de Usuarios sin aviso', f: 'superadmin-detalle.js', de: 'nodo.appendChild(SA.avisoPortapapeles());', a: '', esc: '^26[.]' },
  { id: 'R8: el mensaje de WhatsApp sin aviso', f: 'superadmin-alta.js', de: 'h("p", null, copiarMsj), SA.avisoPortapapeles()),', a: 'h("p", null, copiarMsj)),', esc: '^26[.]' },
  // 8. R9
  { id: 'R9: campos de secretos type=password', f: 'superadmin-detalle.js', de: 'var inp = h("input", { type: "text", "data-secreto": "1"', a: 'var inp = h("input", { type: "password", "data-secreto": "1"', esc: '^(15|27)[.]' },
  { id: 'R9: autocomplete new-password (sugiere contrasenas)', f: 'superadmin-detalle.js', de: 'autocomplete: "off", autocapitalize: "off", spellcheck: "false", inputmode: "text"', a: 'autocomplete: "new-password", autocapitalize: "off", spellcheck: "false", inputmode: "text"', esc: '^27[.]' },
  { id: 'R9: sin data-lpignore', f: 'superadmin-detalle.js', de: '"data-lpignore": "true", ', a: '', esc: '^27[.]' },
  { id: 'R9: sin data-1p-ignore', f: 'superadmin-detalle.js', de: '"data-1p-ignore": "true", ', a: '', esc: '^27[.]' },
  { id: 'R9: sin data-bwignore', f: 'superadmin-detalle.js', de: '"data-bwignore": "true", ', a: '', esc: '^27[.]' },
  { id: 'R9: el campo lleva un name de credencial', f: 'superadmin-detalle.js', de: '"data-form-type": "other", placeholder:', a: '"data-form-type": "other", name: "password", placeholder:', esc: '^27[.]' },
  { id: 'R9: los secretos se ven en claro (sin el CSS de ocultar)', f: 'superadmin.css', de: 'input[data-secreto] { -webkit-text-security: disc; text-security: disc; }', a: '', esc: '^(15|27)[.]' },
  // ---- equivalentes declaradas (se corren igual: si alguna se detecta, mejor)
  { id: 'EQUIVALENTE: resumen: la lista de claves usadas con prototipo normal (hay otros campos de mas en la fila hostil que igual dan el aviso)', equivalente: true, f: 'superadmin.js', de: 'var usadas = Object.create(null),', a: 'var usadas = {},', esc: '^22[.]' },
  { id: 'EQUIVALENTE: SA.apiLectura sin su lista blanca (no hay ninguna llamada que escriba desde esa vista; es defensa en profundidad)', f: 'superadmin.js', de: 'if (ACCIONES_LECTURA.indexOf(accion) < 0) return Promise.reject(new Error("Acci', a: 'if (false) return Promise.reject(new Error("Acci', esc: '^16[.]', equivalente: true },
  { id: 'EQUIVALENTE: secretos sin vaciar antes de esperar la respuesta (se vacian igual al llegar la respuesta)', f: 'superadmin-detalle.js', de: 'Object.keys(entradas).forEach(function (k) { entradas[k].value = ""; });   // se vacian ANTES de esperar la respuesta', a: '', esc: '^15[.]', equivalente: true }
];

const lista = M.filter((m) => !SOLO || SOLO.split('|').some((x) => m.id.includes(x)));
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
    for (const t2 of mutacion.tambien || []) { if (!txt.includes(t2.de)) return { dir, noAplica: true }; txt = txt.replace(t2.de, () => t2.a); }
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
    for (const t2 of mutacion.tambien || []) { if (!txt.includes(t2.de)) return { dir, noAplica: true }; txt = txt.replace(t2.de, () => t2.a); }
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
if (!process.env.CONSERVAR) { try { fs.rmSync(raizTemp, { recursive: true, force: true }); } catch (e) { /* en uso */ } } else console.log('copias en ' + raizTemp);
process.exitCode = sobrevivientes.length || noAplican.length ? 1 : 0;
