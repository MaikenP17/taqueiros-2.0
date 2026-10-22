/* =============================================================
   REVISION POR MUTACION DE LAS PAGINAS PRIVADAS (panel, menu-admin, historial, panel-restaurante.js, ticket, sw)

     node pruebas/multirestaurante/mutaciones-panel.mjs
     node pruebas/multirestaurante/mutaciones-panel.mjs --solo=innerHTML        (las que casen con esa expresion)
     node pruebas/multirestaurante/mutaciones-panel.mjs --paralelo=3            (mutantes a la vez; por defecto 3)

   Rompe A PROPOSITO, una por una, cada defensa de las paginas privadas (en una COPIA en una carpeta temporal: el
   repositorio no se toca) y exige que panel.mjs (el navegador) lo detecte. Cada mutante corre solo los escenarios que
   tienen que notarlo (SOLO=...), para no tardar horas; cada corrida usa sus propios puertos para poder correr varias a la vez.

   DETECTADA: panel.mjs termina con error. SOBREVIVE: todo pasa (falta una prueba, o la defensa sobra). EQUIVALENTE: la
   defensa tiene otra capa que cubre lo mismo (se declara con su razon; quitar las dos capas juntas SI se detecta, y eso
   se prueba con 'tambien').

   Sale con codigo 1 si una mutacion NO equivalente sobrevive.
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO } from './sim.mjs';

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const filtro = arg('solo');
const PARALELO = Number(arg('paralelo')) || 3;

const PR = 'panel-restaurante.js', RPJ = 'restaurante-publico.js', PAN = 'panel.html', MEN = 'menu-admin.html', HIS = 'historial.html', TIC = 'ticket-comanda.js', SW = 'sw.js', DAT = 'datos-restaurante.js';
const ARCHIVOS = [PR, RPJ, PAN, MEN, HIS, TIC, SW, DAT, 'index.html', 'pedido.html'];

/* { nombre, archivo, buscar, reemplazar, solo, equivalente?, tambien?: [archivo, buscar, reemplazar] } */
const M = [];
const m = (nombre, archivo, buscar, reemplazar, solo, extra) => M.push({ nombre, archivo, buscar, reemplazar, solo, ...(extra || {}) });

// ---- lo que llega de la base nunca se pega como HTML ni como CSS ------------------------------------------------------------
m('lib: el nombre del restaurante se pega con innerHTML', PR, 'nombres[i].textContent = R.nombre;', 'nombres[i].innerHTML = R.nombre;', '^2\\.');
m('lib: los colores se aplican sin validar (se quitan las dos capas: navegador y libreria compartida)', PR, 'if (!c[k] || !HEX.test(c[k])) return;', 'if (!c[k]) return;', '^2b\\.',
  { tambien: [RPJ, 'function color(v) { return typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : null; }', 'function color(v) { return typeof v === "string" ? v : null; }'] });
m('lib: el color no se valida en esta libreria (la compartida SI lo hace)', PR, 'if (!c[k] || !HEX.test(c[k])) return;', 'if (!c[k]) return;', '^2\\.',
  { equivalente: 'restaurante-publico.js ya descarta lo que no es #RRGGBB antes de que llegue aqui (defensa en capas); quitadas las dos SI se detecta (mutacion anterior)' });
m('lib: la direccion de las tipografias se arma con el nombre crudo, sin la lista permitida', PR, 'return "family=" + RP.FUENTES[n].familia; })', 'return "family=" + n; })', '^1\\.');
m('lib: una tipografia fuera de la lista se acepta (se quitan las dos capas)', RPJ, 'return typeof v === "string" && Object.prototype.hasOwnProperty.call(FUENTES, v.trim()) ? v.trim() : null;', 'return typeof v === "string" ? v.trim() : null;', '^2b\\.',
  { tambien: [PR, 'if (!RP.FUENTES[t.titulos] || !RP.FUENTES[t.cuerpo]) return null;   // (normalizar ya lo garantiza)', ''] });
m('lib: una tipografia fuera de la lista se acepta en la libreria compartida (esta libreria la vuelve a revisar)', RPJ, 'return typeof v === "string" && Object.prototype.hasOwnProperty.call(FUENTES, v.trim()) ? v.trim() : null;', 'return typeof v === "string" ? v.trim() : null;', '^2\\.',
  { equivalente: 'panel-restaurante.js comprueba otra vez que el nombre este en RP.FUENTES antes de usarlo; quitadas las dos SI se detecta (mutacion anterior)' });
m('lib: sin tipografia elegida no se usan las de siempre', RPJ, 'titulos: fuente(objeto(marca.tipografia).titulos) || FUENTE_TITULOS,', 'titulos: fuente(objeto(marca.tipografia).titulos) || "",', '^1\\.');
m('lib: el icono de pantalla de inicio no lleva "/" delante', PR, 'return /^https?:/i.test(u) || u.charAt(0) === "/" ? u : "/" + u;', 'return u;', '^1\\.');
m('lib: el logo siempre lleva alt vacio', PR, 'logos[j].setAttribute("alt", logos[j].hasAttribute("data-marca-decorativo") ? "" : R.nombre);', 'logos[j].setAttribute("alt", "");', '^1\\.');
m('lib: el color de la barra del navegador no es el de la marca', PR, 'tema.setAttribute("content", R.marca.colores.primario);', 'tema.setAttribute("content", "#000000");', '^1\\.');
m('lib: el texto secundario no es el "tenue" de la marca', PR, 'var sec = c.texto_tenue || c.texto_secundario;', 'var sec = c.texto_secundario || c.texto_tenue;', '^1\\.');
m('lib: el tercer nivel de superficie no se calcula', PR, 'raiz.setProperty("--carbon-3", nivelTres(c.oscuro, c.oscuro_2));', '', '^11\\.');
m('lib: el tercer nivel de superficie se calcula con otro coeficiente', PR, '1.25 * (canal(oscuro2, i) - canal(oscuro, i))', '1 * (canal(oscuro2, i) - canal(oscuro, i))', '^11\\.');
m('lib: el telon de carga no se levanta con el restaurante pintado (la pagina queda tapada)', PR, '          RP.listo();\n          if (typeof o.alListo', '          if (typeof o.alListo', '^1\\.');
m('lib: si el servidor cae al abrir, no se reintenta solo', PR, 'if (tipo === "error") programado = setTimeout(intentar, REINTENTO_MS);', '', '^3\\.');

// ---- membresia ----------------------------------------------------------------------------------------------------------------------
m('lib: la membresia no se pide por el restaurante de este dominio', PR, '.eq("user_id", uid).eq("restaurante_id", PR.rid).eq("activo", true).limit(1);', '.eq("user_id", uid).eq("activo", true).limit(1);', '^4\\.');
m('lib: la membresia inactiva se acepta (se quitan el filtro y la comprobacion)', PR, '.eq("user_id", uid).eq("restaurante_id", PR.rid).eq("activo", true).limit(1);', '.eq("user_id", uid).eq("restaurante_id", PR.rid).limit(1);', '^4\\.',
  { tambien: [PR, 'if (!fila || fila.activo !== true || !Object.prototype.hasOwnProperty.call(ROLES, fila.rol)) {', 'if (!fila || !Object.prototype.hasOwnProperty.call(ROLES, fila.rol)) {'] });
m('lib: la membresia inactiva no se filtra en la consulta (la comprobacion en el navegador SI)', PR, '.eq("user_id", uid).eq("restaurante_id", PR.rid).eq("activo", true).limit(1);', '.eq("user_id", uid).eq("restaurante_id", PR.rid).limit(1);', '^4\\.');   // (se detecta: la prueba exige que la consulta pida activo=eq.true)
m('lib: la comprobacion de activo en el navegador', PR, 'if (!fila || fila.activo !== true || !Object.prototype.hasOwnProperty.call(ROLES, fila.rol)) {', 'if (!fila || !Object.prototype.hasOwnProperty.call(ROLES, fila.rol)) {', '^4\\.',
  { equivalente: 'la consulta ya pide activo=eq.true (defensa en capas); quitadas las dos SI se detecta (mutacion anterior)' });
m('lib: un rol desconocido entra', PR, 'if (!fila || fila.activo !== true || !Object.prototype.hasOwnProperty.call(ROLES, fila.rol)) {', 'if (!fila || fila.activo !== true) {', '^4\\.',
  { equivalente: 'miembros.rol tiene un CHECK en la base con solo dueno/cajero/cocina (SQL 10): no se puede guardar otro rol' });
m('lib: un fallo de red se toma como "sin acceso"', PR, 'if (r.error) return { ok: false, motivo: "error", error: r.error };', 'if (r.error) return { ok: false, motivo: "sin_acceso", error: r.error };', '^4c\\.');
m('lib: un fallo de red no se reintenta', PR, 'if (r.motivo !== "error") return r;', 'return r;', '^4c\\.');
m('lib: el rechazo cierra la sesion en TODOS los equipos (signOut global)', PR, 'try { await db.auth.signOut({ scope: "local" }); } catch (e)', 'try { await db.auth.signOut(); } catch (e)', '^4\\.');
m('lib: el rol no se muestra', PR, 'els[i].textContent = etiqueta ? "Tu rol: " + etiqueta : "";', 'els[i].textContent = "";', '^4\\.');
m('lib: la membresia no se vuelve a comprobar al volver a la pestana', PR, 'if (document.visibilityState === "visible" && Date.now() - ultimo > 5 * 60 * 1000) revisar();', '', '^4c\\.');
m('lib: perder la membresia no hace nada', PR, 'if (r.motivo === "sin_acceso") alPerder(r);', '', '^4c\\.');
m('lib: el mensaje de rechazo cambia', PR, 'PR.MENSAJE_SIN_ACCESO = "Tu usuario no tiene acceso a este restaurante.";', 'PR.MENSAJE_SIN_ACCESO = "Error.";', '^4\\.');
m('lib: las preferencias del equipo no se migran', PR, '        PR.migrarClaves();\n', '', '^10\\.');
m('lib: con ?r= en la direccion tambien se migran las preferencias', PR, 'if (new URLSearchParams(location.search).get("r")) return;', '', '^10\\.');
m('lib: las claves del navegador no llevan el id del restaurante', PR, 'PR.clave = function (nombre) { return nombre + ":" + PR.rid; };', 'PR.clave = function (nombre) { return nombre; };', '^10\\.');

// ---- panel.html ---------------------------------------------------------------------------------------------------------------------------
m('panel: no se comprueba la membresia', PAN, 'const acceso = await PR.verificarAccesoPersistente(db, () => textoVerificando(PR.MENSAJE_ERROR));', 'const acceso = { ok: true, rol: "dueno" };', '^4\\.');
m('panel: el rechazo no cierra la sesion', PAN, '    if(acceso.motivo === "sin_acceso"){\n      await PR.cerrarSesionLocal(db);\n      mostrarLogin(PR.MENSAJE_SIN_ACCESO);', '    if(acceso.motivo === "sin_acceso"){\n      mostrarLogin(PR.MENSAJE_SIN_ACCESO);', '^4\\.');
m('panel: la jornada no se pide para este restaurante', PAN, 'db.rpc("limites_jornada", { p_restaurante: RID }).select()', 'db.rpc("limites_jornada").select()', '^4\\.');
m('panel: los pedidos no se filtran por restaurante', PAN, '    .select("*")\n    .eq("restaurante_id", RID)\n    .neq("estado", "pendiente_pago")', '    .select("*")\n    .neq("estado", "pendiente_pago")', '^4b\\.');
m('panel: la configuracion no se filtra por restaurante', PAN, 'db.from("configuracion").select("*").eq("restaurante_id", RID).maybeSingle()', 'db.from("configuracion").select("*").maybeSingle()', '^4b\\.');
m('panel: la salud del WhatsApp no se filtra por restaurante', PAN, '.from("salud_notificaciones").select("*").eq("restaurante_id", RID).maybeSingle();', '.from("salud_notificaciones").select("*").maybeSingle();', '^4b\\.');
m('panel: el interruptor Abierto/Cerrado escribe en todos los restaurantes del usuario', PAN, '.update({ cerrado_temporal: nuevoValor }).eq("restaurante_id", RID);', '.update({ cerrado_temporal: nuevoValor });', '^5\\.');
m('panel: el horario se guarda en todos los restaurantes del usuario', PAN, '.update({ horarios, mensaje_cerrado: mensaje || null }).eq("restaurante_id", RID);', '.update({ horarios, mensaje_cerrado: mensaje || null });', '^5\\.');
m('panel: el cambio de estado de un pedido no lleva el restaurante', PAN, '.update({ estado: nuevoEstado }).eq("id", id).eq("restaurante_id", RID);', '.update({ estado: nuevoEstado }).eq("id", id);', '^4\\.',
  { equivalente: 'pedidos.id es unico en TODA la tabla (identity): el id ya identifica un solo pedido; el filtro es una capa extra y la lista solo trae pedidos de este restaurante' });
m('panel: el canal de pedidos no pide solo su restaurante', PAN, '{ event:"*", schema:"public", table:"pedidos", filter: filtro }', '{ event:"*", schema:"public", table:"pedidos" }', '^7\\.');
m('panel: el canal de salud no pide solo su restaurante', PAN, '{ event:"*", schema:"public", table:"salud_notificaciones", filter: filtro }', '{ event:"*", schema:"public", table:"salud_notificaciones" }', '^7\\.');
m('panel: el canal de configuracion no pide solo su restaurante', PAN, '{ event:"*", schema:"public", table:"configuracion", filter: filtro }', '{ event:"*", schema:"public", table:"configuracion" }', '^7\\.');
m('panel: un pedido de otro restaurante que llega por Realtime entra al tablero', PAN, '      if(fila.restaurante_id !== RID) return;\n', '', '^7\\.');
m('panel: la salud de otro restaurante que llega por Realtime se pinta', PAN, 'if(payload.new && payload.new.restaurante_id === RID) pintarSaludNotificaciones(payload.new);', 'if(payload.new) pintarSaludNotificaciones(payload.new);', '^7\\.');
m('panel: la configuracion de otro restaurante que llega por Realtime se aplica', PAN, 'if(payload.new && payload.new.restaurante_id === RID){', 'if(payload.new){', '^7\\.');
m('panel: se imprime algo de otro restaurante', PAN, '  if(!p || p.restaurante_id !== RID) return false;     // nunca se imprime algo de otro restaurante\n  if(p.estado_pago !== "aprobado") return false;', '  if(!p || p.estado_pago !== "aprobado") return false;', '^9\\.',
  { equivalente: 'la lista de pedidos ya se pide y se recibe solo de este restaurante (filtro de la consulta y del canal); esta es una tercera capa' });
m('panel: el pie del ticket no lleva el nombre del restaurante', PAN, '    if(window.TicketComanda) TicketComanda.fijarRestaurante(R.nombre);   // pie del ticket\n', '', '^9\\.');
m('panel: las preferencias del equipo se leen sin el id del restaurante (clave de impresion)', PAN, 'impresionActiva = PR.leerLocal(IMPRESION_KEY) === "on";', 'impresionActiva = false;', '^10\\.');
m('panel: una hora hostil del horario entra tal cual a la pagina', PAN, 'return typeof v === "string" && /^([01]\\d|2[0-4]):[0-5]\\d$/.test(v) ? v : porDefecto;', 'return v;', '^2\\.');

// ---- menu-admin.html -----------------------------------------------------------------------------------------------------------------
m('menu: no se comprueba la membresia', MEN, 'const acceso = await PR.verificarAccesoPersistente(db, () => textoVerificando(PR.MENSAJE_ERROR));', 'const acceso = { ok: true, rol: "dueno" };', '^4\\.');
m('menu: las categorias no se filtran por restaurante', MEN, 'db.from("categorias").select("*").eq("restaurante_id", RID).order("orden"),', 'db.from("categorias").select("*").order("orden"),', '^4b\\.');
m('menu: los productos no se filtran por restaurante', MEN, 'db.from("productos").select("*").eq("restaurante_id", RID).order("orden")', 'db.from("productos").select("*").order("orden")', '^4b\\.');
m('menu: agotar un producto no lleva el restaurante', MEN, '.update({ disponible: nuevo }).eq("id", id).eq("restaurante_id", RID);', '.update({ disponible: nuevo }).eq("id", id);', '^6\\.');
m('menu: ocultar una categoria no lleva el restaurante', MEN, '.update({ activa: nuevo }).eq("id", id).eq("restaurante_id", RID);', '.update({ activa: nuevo }).eq("id", id);', '^6\\.');
m('menu: la edicion rapida no lleva el restaurante', MEN, '      .eq("id", id).eq("restaurante_id", RID);', '      .eq("id", id);', '^6\\.');
m('menu: la edicion por el formulario no lleva el restaurante', MEN, '.update(cambios).eq("id", f.id).eq("restaurante_id", RID).select();', '.update(cambios).eq("id", f.id).select();', '^6\\.');
m('menu: renombrar una categoria no lleva el restaurante', MEN, '.update({ nombre }).eq("id", c.id).eq("restaurante_id", RID).select();', '.update({ nombre }).eq("id", c.id).select();', '^6\\.');
m('menu: borrar un producto no lleva el restaurante', MEN, '.delete().eq("id", p.id).eq("restaurante_id", RID).select("id");', '.delete().eq("id", p.id).select("id");', '^6\\.');
m('menu: deshacer una categoria creada a medias no lleva el restaurante', MEN, '.delete().eq("id", categoriaCreada.id).eq("restaurante_id", RID);', '.delete().eq("id", categoriaCreada.id);', '^6c\\.');
m('menu: el alta de categoria no manda su restaurante', MEN, '.insert({ restaurante_id: RID, id: idCat,', '.insert({ id: idCat,', '^6\\.');
m('menu: el alta de producto no manda su restaurante', MEN, '.insert({ restaurante_id: RID, id: idProd,', '.insert({ id: idProd,', '^6\\.');
m('menu: la foto nueva va a la raiz del bucket', MEN, 'const nombre = RID + "/" + nombreDeArchivoSeguro(foto.ext);', 'const nombre = nombreDeArchivoSeguro(foto.ext);', '^6\\.');
m('menu: se intenta borrar una foto de la carpeta de otro restaurante', MEN, '  if(carpeta && carpeta !== RID) return;\n', '', '^6b\\.',
  { equivalente: 'las politicas de Storage ya impiden borrar en la carpeta de otro restaurante (puede_gestionar_fotos); este filtro evita la peticion inutil' });

// ---- historial.html ------------------------------------------------------------------------------------------------------------------------
m('historial: no se comprueba la membresia', HIS, 'const acceso = await PR.verificarAccesoPersistente(db, () => textoVerificando(PR.MENSAJE_ERROR));', 'const acceso = { ok: true, rol: "dueno" };', '^4\\.');
m('historial: la lista de dias no se pide para este restaurante', HIS, '{ limite: 60, p_restaurante: RID }', '{ limite: 60 }', '^4b\\.');
m('historial: el resumen no se pide para este restaurante', HIS, '{ fecha, p_restaurante: RID }', '{ fecha }', '^4b\\.');
m('historial: la busqueda no se pide para este restaurante', HIS, "referencia:  document.getElementById(\"bReferencia\").value.trim() || null,\n    p_restaurante: RID\n  });", "referencia:  document.getElementById(\"bReferencia\").value.trim() || null\n  });", '^4b\\.');

// ---- ticket y service worker ----------------------------------------------------------------------------------------------------------------
m('ticket: el pie no usa el nombre del restaurante', TIC, 'pie: textoPie(op.restaurante != null ? op.restaurante : nombreRestaurante),', 'pie: textoPie(""),', '^9\\.');
m('sw: la version no sube', SW, 'const VERSION = "v10";', 'const VERSION = "v9";', '^12\\.');
m('sw: se vuelve a precachear algo', SW, 'const CASCARON = [];', 'const CASCARON = ["/Recursos/logo/logo.png"];', '^12\\.');
m('sw: /api/ deja de ir siempre por la red', SW, '      || url.pathname.startsWith("/api/")\n', '', '^12\\.');

// ---- "Datos de mi restaurante" (solo el dueno): la opcion, el formulario y lo que manda a la base -------------------------------------------------
m('datos: la opcion del menu se muestra a todos los roles', PR, 'solo[j].hidden = !(rol && ROLES[rol] && roles.indexOf(rol) >= 0);', 'solo[j].hidden = false;', '^13\\.');
m('datos: la opcion se muestra a cualquier rol valido (no solo al dueno)', PR, 'solo[j].hidden = !(rol && ROLES[rol] && roles.indexOf(rol) >= 0);', 'solo[j].hidden = !(rol && ROLES[rol]);', '^13\\.');
m('datos: perder el rol no cierra el formulario', PR, 'if (rol !== "dueno" && window.DatosRestaurante && typeof window.DatosRestaurante.cerrar === "function") window.DatosRestaurante.cerrar();', '', '^13\\.');
m('datos: la opcion nace visible (sin esconderla hasta saber el rol)', PAN, 'if(op.soloRol){ el.setAttribute("data-solo-rol", op.soloRol); el.hidden = true; }', 'if(op.soloRol){ el.setAttribute("data-solo-rol", op.soloRol); }', '^13\\.',
  { equivalente: 'PR.mostrarRol() la esconde o la muestra apenas se conoce el rol (antes de levantar el panel); nace visible solo un instante, con el panel todavia cerrado' });
m('datos: el boton de la opcion no revisa el rol (el formulario si lo revisa)', PAN, 'if(!window.DatosRestaurante || PR.rol !== "dueno") return;', 'if(!window.DatosRestaurante) return;', '^13\\.',
  { equivalente: 'la opcion esta escondida para los demas roles y DatosRestaurante.abrir() revisa el rol otra vez; quitadas las dos SI se detecta (mutacion siguiente)' });
m('datos: ni el boton ni el formulario revisan el rol (un cajero que fuerce la llamada abre el formulario)', PAN, 'if(!window.DatosRestaurante || PR.rol !== "dueno") return;', 'if(!window.DatosRestaurante) return;', '^13\\.',
  { tambien: [DAT, 'if (window.PR && window.PR.rol !== "dueno") return false;', ''] });
m('datos: el boton no pasa el restaurante del dominio', PAN, '    rid: RID,\n    avisar: avisar,', '    rid: null,\n    avisar: avisar,', '^13\\.');
m('datos: guardar el nombre no actualiza el titulo de la pestana', PAN, '      document.title = "Panel de Comandas | " + datos.nombre;\n', '', '^13\\.');
m('datos: el formulario manda TODOS los campos, no solo los que cambiaron', DAT, 'if (antes !== despues) {', 'if (true) {', '^13\\.');
m('datos: el formulario no manda el valor que vio ("antes")', DAT, 'cambios.push({ campo: def.campo, antes: antes === "" ? null : antes, despues: despues === "" ? null : despues });', 'cambios.push({ campo: def.campo, antes: null, despues: despues === "" ? null : despues });', '^13\\.');
m('datos: lo que no se toco se manda igual (se compara el crudo, no lo que la persona edito)', DAT, '      if (crudo === original) {\n        valores[def.campo] = original.trim();\n        tocados[def.campo] = false;\n        return;\n      }\n', '', '^13\\.');
m('datos: no se valida nada en el navegador', DAT, 'var errores = DR.validarCampo(def.campo, f.valores[def.campo]);', 'var errores = [];', '^13\\.');
m('datos: no se pregunta a la base (config_restaurante_errores) antes de guardar', DAT, 'var rv = await estado.db.rpc("config_restaurante_errores", { p_config: candidata });', 'var rv = { error: true };', '^13\\.');
m('datos: se ignoran los problemas que la base encuentra fuera del formulario', DAT, '        if (generales.length) {', '        if (false) {', '^13\\.');
m('datos: un conflicto se toma por guardado', DAT, 'if (res.ok === false) {', 'if (false) {', '^13\\.');
m('datos: tras un conflicto, lo que no se toco no se actualiza con lo vigente', DAT, '          if (e && !f.tocados[def.campo]) { e.value = DR.leer(estado.original, def.campo); contar(def.campo); }', '', '^13\\.');
m('datos: tras un conflicto no se carga lo vigente como nueva referencia', DAT, '        if (res.datos) aplicarDatosVigentes(res.datos);\n        // lo que yo no toque', '        // lo que yo no toque', '^13\\.');
m('datos: un ajuste (WhatsApp, @, saltos de linea) se guarda sin avisar', DAT, 'if (ajustes.length && !estado.ajustesMostrados) {', 'if (false) {', '^13\\.');
m('datos: cancelar con cambios sin guardar cierra sin preguntar', DAT, 'if (estado.original && hayCambios() && !estado.cierreConfirmado) {', 'if (false) {', '^13\\.');
m('datos: el aviso y los textos ajenos entran como HTML (innerHTML)', DAT, 'if (k === "texto") e.textContent = atributos[k];', 'if (k === "texto") e.innerHTML = atributos[k];', '^13\\.');
m('datos: del WhatsApp no se quitan los separadores', DAT, 'if (solo !== v && /^[0-9]*$/.test(solo)) {', 'if (false) {', '^13\\.');
m('datos: del usuario de Instagram no se quita el @', DAT, 'if (v.charAt(0) === "@") {\n        v = v.slice(1).trim();', 'if (false) {\n        v = v.slice(1).trim();', '^13\\.');
m('datos: los saltos de linea no se cambian por espacios', DAT, 'v = v.replace(RE_SALTOS_G, " ");', '', '^13\\.');
m('datos: el HTML no se rechaza en el navegador', DAT, 'if (/[<>]/.test(v)) e.push("No se permiten etiquetas HTML (los caracteres < y >).");', '', '^13\\.');
m('datos: el largo maximo no se revisa en el navegador', DAT, 'if (largo(v) > def.max) e.push("Es demasiado largo (máximo " + def.max + " caracteres).");', '', '^13\\.');
m('datos: el WhatsApp corto se acepta en el navegador', DAT, 'if (largo(v) > def.max || !RE_DIGITOS.test(v.replace(RE_SEPARADORES_G, ""))) {', 'if (false) {', '^13\\.');
m('datos: un usuario con espacios se acepta en el navegador', DAT, 'if (!RE_USUARIO.test(v.charAt(0) === "@" ? v.slice(1) : v)) {', 'if (false) {', '^13\\.');
m('datos: el nombre vacio se acepta en el navegador', DAT, 'if (largo(v) < 1) e.push("El nombre no puede quedar vacío.");', '', '^13\\.');
m('datos: el campo con error no se marca para los lectores de pantalla', DAT, 'if (e) e.setAttribute("aria-invalid", "true");', '', '^13\\.');
m('datos: al corregir un campo su aviso no desaparece', DAT, 'entrada.addEventListener("input", function () { contar(def.campo); limpiarError(def.campo); estado.cierreConfirmado = false; restaurarBotonCancelar(); });', 'entrada.addEventListener("input", function () { contar(def.campo); estado.cierreConfirmado = false; restaurarBotonCancelar(); });', '^13\\.');
m('datos: Escape no cierra el formulario', DAT, 'if (ev.key === "Escape" && fondo.classList.contains("open")) pedirCierre();', '', '^13\\.');
m('datos: el formulario no carga lo vigente de la base al abrir (usa lo viejo)', DAT, 'estado.original = { nombre: r.data.nombre, config: r.data.config && typeof r.data.config === "object" ? r.data.config : {} };', 'estado.original = estado.original || { nombre: r.data.nombre, config: r.data.config && typeof r.data.config === "object" ? r.data.config : {} };', '^13\\.',
  { equivalente: 'cada apertura crea un estado nuevo (estado = {... original: null}), asi que no queda nada viejo que reutilizar' });
m('datos: el nombre nuevo no se ve de inmediato en el menu', DAT, '        window.PR.aplicarNombreYLogo(window.PR.R);', '', '^13\\.');
m('horario: el mensaje de cerrado se manda sin revisar las reglas de la base (300, < >)', PAN, 'if([...mensaje].length > 300 || /[<>]/.test(mensaje)){', 'if(false){', '^5\\.');
m('horario: el rechazo de la base (23514) se muestra como un error generico', PAN, 'avisar(error.code === "23514"', 'avisar(false', '^5\\.');
m('datos: el formulario muestra el nombre como HTML al abrir (valor con innerHTML)', DAT, 'entrada.value = DR.leer(estado.original, def.campo);', 'entrada.setAttribute("value", DR.leer(estado.original, def.campo)); entrada.insertAdjacentHTML("afterend", DR.leer(estado.original, def.campo));', '^13\\.');

/* ---- ejecucion ------------------------------------------------------------------------------------------------------------------------ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-mut-panel-'));
const leer = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const original = Object.fromEntries(ARCHIVOS.map((f) => [f, leer(f)]));

function carpetaConMutacion(mu) {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  const archivos = { ...original };
  const aplicar = (archivo, buscar, reemplazar) => {
    const n = archivos[archivo].split(buscar).length - 1;
    if (n !== 1) throw new Error(`mutacion mal definida: "${buscar.slice(0, 70)}" aparece ${n} veces en ${archivo}`);
    archivos[archivo] = archivos[archivo].split(buscar).join(reemplazar);
  };
  if (mu.archivo) aplicar(mu.archivo, mu.buscar, mu.reemplazar);
  if (mu.tambien) aplicar(...mu.tambien);
  for (const [f, c] of Object.entries(archivos)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
}

let ocupados = 0;
function correr(carpeta, solo, ranura) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(REPO, 'pruebas', 'multirestaurante', 'panel.mjs')], {
      cwd: REPO,
      env: { ...process.env, PANEL_RAIZ: carpeta, SOLO: solo, PUERTO_WEB: String(8120 + ranura * 20), PUERTO_CDP: String(9440 + ranura), PUERTO_FALSO: String(54450 + ranura) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let salida = '';
    p.stdout.on('data', (d) => { salida += d; });
    p.stderr.on('data', (d) => { salida += d; });
    const reloj = setTimeout(() => p.kill(), 900000);
    p.on('close', (codigo) => { clearTimeout(reloj); ok({ codigo, salida }); });
  });
}

const resumen = { detectadas: 0, equivalentes: [], sobreviven: [], errores: [] };

// --validar: solo comprueba que cada mutacion se pueda aplicar (el texto a cambiar existe UNA vez); no corre el navegador
if (process.argv.includes('--validar')) {
  let malas = 0;
  for (const mu of M) {
    try { carpetaConMutacion(mu); } catch (e) { malas++; console.log(`  MAL DEFINIDA  ${mu.nombre}\n    ${e.message}`); }
  }
  console.log(`${M.length} mutaciones, ${malas} mal definidas`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(malas ? 1 : 0);
}

console.log('Linea base: las paginas sin tocar deben pasar todos los escenarios...');
const base = process.argv.includes('--sin-base') ? { codigo: 0 } : await correr(carpetaConMutacion({}), '.*', 0);   // --sin-base: omite la linea base (solo para repetir unas pocas mutaciones)
if (base.codigo !== 0) {
  console.log(base.salida.split('\n').filter((l) => /FALLA|ERROR/.test(l)).slice(0, 10).join('\n'));
  console.log('La linea base falla: no se puede hacer la revision por mutacion.');
  process.exit(2);
}
console.log('  linea base OK\n');

const filtroRe = filtro ? new RegExp(filtro) : null;   // --solo=<expresion regular sobre el nombre>
const pendientes = M.filter((mu) => !filtroRe || filtroRe.test(mu.nombre));
let siguiente = 0;
async function trabajador(ranura) {
  for (;;) {
    const i = siguiente++;
    if (i >= pendientes.length) return;
    const mu = pendientes[i];
    let dir;
    try { dir = carpetaConMutacion(mu); } catch (e) { resumen.errores.push(`${mu.nombre}: ${e.message}`); console.log(`  ERROR       ${mu.nombre}\n              ${e.message}`); continue; }
    const r = await correr(dir, mu.solo, ranura);
    const detectada = r.codigo !== 0;
    if (mu.equivalente) {
      if (detectada) { resumen.detectadas++; console.log(`  DETECTADA   ${mu.nombre}  (declarada equivalente, pero SI se detecta: quitar de las equivalentes)`); }
      else { resumen.equivalentes.push(`${mu.nombre} -> ${mu.equivalente}`); console.log(`  EQUIVALENTE ${mu.nombre}`); }
    } else if (detectada) {
      resumen.detectadas++;
      console.log(`  DETECTADA   ${mu.nombre}`);
    } else {
      resumen.sobreviven.push(mu.nombre);
      console.log(`  SOBREVIVE   ${mu.nombre}`);
    }
  }
}
await Promise.all(Array.from({ length: PARALELO }, (_, i) => trabajador(i)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n=============================================================');
console.log(`DETECTADAS: ${resumen.detectadas}   EQUIVALENTES: ${resumen.equivalentes.length}   SOBREVIVEN: ${resumen.sobreviven.length}   ERRORES: ${resumen.errores.length}`);
if (resumen.sobreviven.length) { console.log('\nSOBREVIVEN (falta una prueba):'); resumen.sobreviven.forEach((s) => console.log('  - ' + s)); }
if (resumen.equivalentes.length) { console.log('\nEQUIVALENTES:'); resumen.equivalentes.forEach((s) => console.log('  - ' + s)); }
if (resumen.errores.length) { console.log('\nERRORES DE DEFINICION:'); resumen.errores.forEach((s) => console.log('  - ' + s)); }
process.exitCode = resumen.sobreviven.length || resumen.errores.length ? 1 : 0;
