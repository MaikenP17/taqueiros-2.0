/* =============================================================
   REVISION POR MUTACION DEL PASO 3B PARTE 1  (MFA, lecturas de "entrar como" y su auditoria)
   Archivos que se rompen a proposito: api/_sesion.js, api/superadmin.js, supabase/19-superadmin-lectura.sql, 19-revertir.sql y el
   conteo del 16.

     node pruebas/multirestaurante/mutaciones-mfa.mjs                  todas
     node pruebas/multirestaurante/mutaciones-mfa.mjs --solo="aal"     solo las que casen con el nombre
     node pruebas/multirestaurante/mutaciones-mfa.mjs --validar=1      solo comprueba que cada mutacion se pueda aplicar (no corre pruebas)
     node pruebas/multirestaurante/mutaciones-mfa.mjs --paralelo=3     varias a la vez (cada una en su propia copia y su propio puerto)

   Rompe A PROPOSITO, una por una, cada defensa nueva (la lectura del aal, la comparacion del sub, el TOTP en amr, el orden de las
   respuestas, el codigo estable, las lecturas solo-superadmin, los limites, la auditoria sin datos personales, la ventana, la
   constancia del rechazo) y exige que ALGUNA suite lo detecte. Una mutacion que no detecta nadie es una defensa sin prueba.
   Las "equivalentes" (romper la defensa no cambia lo que un atacante puede hacer, porque otra capa lo cubre) estan declaradas con su razon.

   Suites: mfa (node --test pruebas/mfa.test.js) | superadmin (superadmin.mjs, con el SQL 19) | sin19 (superadmin.mjs --sin-sql19)
           | sql19 (sql19.mjs) | sql16 (sql16.mjs)
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n) => (process.argv.find((a) => a.startsWith('--' + n + '=')) || '').slice(n.length + 3);
const solo = arg('solo');
const soloValidar = arg('validar') === '1';
const paralelo = Math.max(1, Number(arg('paralelo')) || 1);

const M = [];
const m = (nombre, archivo, viejo, nuevo, suites, extra = {}) => M.push({ nombre, archivo, viejo, nuevo, suites, ...extra });
const S19 = 'supabase/19-superadmin-lectura.sql';
const SES = 'api/_sesion.js';
const SA = 'api/superadmin.js';

// CONTROL: no cambia nada. Las suites tienen que PASAR en la copia; si alguna falla, las demas detecciones no valen.
m('CONTROL (sin cambios)', SES, 'const UUID =', 'const UUID =', ['mfa', 'superadmin', 'sin19', 'sql19', 'sql16'], { control: true });

// ---- 1. lectura del aal (api/_sesion.js) ----
m('AAL: cualquier token cuenta como aal2 (el claim ni se mira)', SES, 'if (carga.aal !== "aal2") return "aal1";', '', ['mfa', 'superadmin']);
m('AAL: aal2 aunque el sub sea de OTRA persona', SES, 'if (typeof carga.sub !== "string" || carga.sub.toLowerCase() !== idValidado) return "aal1";', '', ['mfa']);
m('AAL: el sub se compara sin pasarlo a minusculas (el id de Auth ya viene en minusculas)', SES, 'carga.sub.toLowerCase() !== idValidado', 'carga.sub !== idValidado', ['mfa'], { equivalente: 'Auth devuelve el sub en minusculas; solo cambiaria con un id en mayusculas, que Supabase no emite' });
m('AAL: aal2 sin exigir TOTP en amr', SES, 'return amr.some((m) => m && typeof m === "object" && typeof m.method === "string" && /totp/i.test(m.method)) ? "aal2" : "aal1";', 'return "aal2";', ['mfa', 'superadmin']);
m('AAL: cualquier metodo de amr vale (no solo TOTP)', SES, '/totp/i.test(m.method)', '/./.test(m.method)', ['mfa']);
m('AAL: un amr que no es lista se acepta', SES, 'const amr = Array.isArray(carga.amr) ? carga.amr : [];', 'const amr = carga.amr;', ['mfa'], { equivalente: 'sin la lista, .some() falla y el catch devuelve aal1: el resultado es el mismo' });
m('AAL: una carga ilegible cuenta como aal2 (falla hacia lo permisivo)', SES, '  } catch (e) {\n    return "aal1";\n  }\n}', '  } catch (e) {\n    return "aal2";\n  }\n}', ['mfa', 'superadmin']);
m('AAL: un token que no tiene tres partes cuenta como aal2', SES, 'if (partes.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(partes[1])) return "aal1";', 'if (partes.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(partes[1])) return "aal2";', ['mfa']);
m('AAL: una carga que no es un objeto cuenta como aal2', SES, 'if (!carga || typeof carga !== "object" || Array.isArray(carga)) return "aal1";', 'if (!carga || typeof carga !== "object" || Array.isArray(carga)) return "aal2";', ['mfa']);
m('AAL: sesionDeToken da siempre aal2', SES, 'return { id, aal: nivelDeGarantia(t, id) };', 'return { id, aal: "aal2" };', ['mfa', 'superadmin']);
m('AAL: si Auth rechaza el token, se acepta igual leyendo su carga (se confia en un JWT que Auth NO valido)', SES, 'if (resp.status === 400 || resp.status === 401 || resp.status === 403) return null;', 'if (resp.status === 400 || resp.status === 401 || resp.status === 403) { try { const c = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")); return { id: String(c.sub).toLowerCase(), aal: c.aal === "aal2" ? "aal2" : "aal1" }; } catch (e) { return null; } }', ['superadmin']);

// ---- 2. el orden y el contenido de las respuestas (api/superadmin.js) ----
m('MFA: la verificacion no existe', SA, '  if (usuario.aal !== "aal2" && pedida !== "mi_estado") {', '  if (false) {', ['superadmin']);
m('MFA: tambien se rechaza a quien SI tiene aal2', SA, '  if (usuario.aal !== "aal2" && pedida !== "mi_estado") {', '  if (pedida !== "mi_estado") {', ['superadmin']);
m('MFA: otra accion tambien se deja pasar sin MFA (yo)', SA, '  if (usuario.aal !== "aal2" && pedida !== "mi_estado") {', '  if (usuario.aal !== "aal2" && pedida !== "mi_estado" && pedida !== "yo") {', ['superadmin']);
m('MFA: se deja pasar sin MFA cualquier accion que EMPIECE por mi_estado', SA, '  if (usuario.aal !== "aal2" && pedida !== "mi_estado") {', '  if (usuario.aal !== "aal2" && !pedida.startsWith("mi_estado")) {', ['superadmin']);
m('MFA: el codigo estable cambia', SA, 'codigo: "mfa_requerida", aal: "aal1" });\n    return;', 'codigo: "mfa", aal: "aal1" });\n    return;', ['superadmin']);
m('MFA: el mensaje en español cambia', SA, 'const MENSAJE_MFA = "Activa o confirma la verificación en dos pasos";', 'const MENSAJE_MFA = "Falta la verificacion";', ['superadmin']);
m('MFA: responde 401 en vez de 403', SA, '    res.status(403).json({ error: MENSAJE_MFA,', '    res.status(401).json({ error: MENSAJE_MFA,', ['superadmin']);
m('MFA: el rechazo suma intentos fallidos (el superadmin se bloquearia a si mismo)', SA, '    await anotarRechazoMfa(usuario, pedida, ahora);\n', '    await anotarRechazoMfa(usuario, pedida, ahora);\n    anotarFallo(ip, ahora);\n', ['superadmin']);
m('MFA: un cuerpo roto sin MFA da 400 (se aprende algo sin MFA)', SA, '  if (usuario.aal !== "aal2" && pedida !== "mi_estado") {', '  if (usuario.aal !== "aal2" && pedida !== "mi_estado" && !(cuerpo && typeof cuerpo === "object" && !Array.isArray(cuerpo) && ACCIONES[pedida])) {', ['superadmin']);
m('MFA: un NO superadmin sin MFA recibe el mensaje de MFA (se distingue a los superadmins)', SA, '    anotarFallo(ip, ahora);\n    res.status(403).json({ error: "No autorizado" });', '    anotarFallo(ip, ahora);\n    res.status(403).json(usuario.aal === "aal2" ? { error: "No autorizado" } : { error: MENSAJE_MFA, codigo: "mfa_requerida", aal: "aal1" });', ['superadmin']);
m('MFA: un NO superadmin con MFA recibe un 403 distinto', SA, '    anotarFallo(ip, ahora);\n    res.status(403).json({ error: "No autorizado" });', '    anotarFallo(ip, ahora);\n    res.status(403).json(usuario.aal === "aal2" ? { error: "No autorizado", aal: "aal2" } : { error: "No autorizado" });', ['superadmin']);
m('MFA: la sesion se pide con el helper viejo (sin aal): todos pasan a aal indefinido', SA, 'usuario = await sesionDeSolicitud(req);', 'usuario = await sesionDeSolicitud(req); usuario = usuario && { id: usuario.id };', ['superadmin']);
m('MFA: mi_estado devuelve el aal que mande el cliente', SA, '    soloAdmitidos(b, "mi_estado", []);\n    return { es_superadmin: true, aal: u.aal, mfa_requerida: true };', '    return { es_superadmin: true, aal: b.aal || u.aal, mfa_requerida: true };', ['superadmin']);
m('MFA: mi_estado dice que la MFA no es requerida', SA, 'return { es_superadmin: true, aal: u.aal, mfa_requerida: true };', 'return { es_superadmin: true, aal: u.aal, mfa_requerida: false };', ['superadmin']);
m('MFA: mi_estado siempre dice aal2', SA, 'return { es_superadmin: true, aal: u.aal, mfa_requerida: true };', 'return { es_superadmin: true, aal: "aal2", mfa_requerida: true };', ['superadmin']);
m('MFA: una variable de entorno apaga la MFA (la escotilla que NO debe existir)', SA, '  if (usuario.aal !== "aal2" && pedida !== "mi_estado") {', '  if (usuario.aal !== "aal2" && pedida !== "mi_estado" && !process.env.SUPERADMIN_SIN_MFA) {', ['mfa']);
m('MFA: una cabecera apaga la MFA (otra escotilla)', SA, '  if (usuario.aal !== "aal2" && pedida !== "mi_estado") {', '  if (usuario.aal !== "aal2" && pedida !== "mi_estado" && !(req.headers["x-sin-mfa"])) {', ['mfa', 'superadmin']);

// ---- 3. constancia del rechazo (servidor) ----
m('RECHAZO: la constancia no se limita en memoria (una llamada a la base por intento)', SA, '  if (ultimo !== undefined && ahora - ultimo < VENTANA_RECHAZO_MFA_MS) return;\n', '', ['superadmin']);
m('RECHAZO: el nombre de la accion pedida se manda tal cual (no solo si es conocida)', SA, 'p_accion: accionPedida && ACCIONES[accionPedida] ? accionPedida : null', 'p_accion: accionPedida || null', ['superadmin']);
m('RECHAZO: si falla la constancia, el servidor responde 500 (el SQL 19 ausente rompe la MFA)', SA, '  } catch (err) {\n    console.error("[Superadmin] No se pudo dejar constancia del rechazo por falta de MFA (HTTP", err && err.status, ")");\n  }', '  } catch (err) {\n    throw err;\n  }', ['sin19']);
m('RECHAZO: el limite en memoria cuenta desde la primera instancia (no se reinicia con reiniciarLimite)', SA, 'module.exports.reiniciarLimite = () => { fallos.clear(); rechazosMfa.clear(); };', 'module.exports.reiniciarLimite = () => { fallos.clear(); };', ['superadmin'], { equivalente: 'solo cambia lo que la prueba puede reiniciar; la base sigue deduplicando por su cuenta (la prueba comprueba las dos capas por separado)' });

// ---- 4. lecturas (servidor) ----
m('LECTURA: ver_pedidos acepta 1000 por pagina', SA, 'const limite = entero(b.limite, "limite", 1, 100, { obligatorio: false });', 'const limite = entero(b.limite, "limite", 1, 1000, { obligatorio: false });', ['superadmin']);
m('LECTURA: ver_pedidos acepta cualquier modo', SA, 'if (typeof modo !== "string" || !MODOS_PEDIDOS.includes(modo)) throw mal("modo debe ser jornada o recientes");', '', ['superadmin']);
m('LECTURA: ver_pedidos acepta campos de mas', SA, '    soloAdmitidos(b, "ver_pedidos", ["restaurante_id", "modo", "limite", "antes_de"]);', '', ['superadmin']);
m('LECTURA: ver_menu acepta campos de mas', SA, '    soloAdmitidos(b, "ver_menu", ["restaurante_id"]);', '', ['superadmin']);
m('LECTURA: ver_config acepta campos de mas', SA, '    soloAdmitidos(b, "ver_config", ["restaurante_id"]);', '', ['superadmin']);
m('LECTURA: ver_resumen acepta campos de mas', SA, '    soloAdmitidos(b, "ver_resumen", ["restaurante_id"]);', '', ['superadmin']);
m('LECTURA: ver_menu manda el id sin validar', SA, 'p_restaurante: uuid(b.restaurante_id, "restaurante_id") }) };\n  },\n\n  ver_config', 'p_restaurante: b.restaurante_id }) };\n  },\n\n  ver_config', ['superadmin']);
m('LECTURA: ver_config manda el id sin validar', SA, 'return { restaurante: await lectura("sa_ver_config", { p_actor: u.id, p_restaurante: uuid(b.restaurante_id, "restaurante_id") }) };', 'return { restaurante: await lectura("sa_ver_config", { p_actor: u.id, p_restaurante: b.restaurante_id }) };', ['superadmin']);
m('LECTURA: ver_resumen manda el id sin validar', SA, 'return { resumen: await lectura("sa_ver_resumen", { p_actor: u.id, p_restaurante: uuid(b.restaurante_id, "restaurante_id") }) };', 'return { resumen: await lectura("sa_ver_resumen", { p_actor: u.id, p_restaurante: b.restaurante_id }) };', ['superadmin']);
m('LECTURA: ver_pedidos manda el id sin validar', SA, '    const rid = uuid(b.restaurante_id, "restaurante_id");\n    const modo = b.modo', '    const rid = b.restaurante_id;\n    const modo = b.modo', ['superadmin']);
m('LECTURA: ver_pedidos pasa el actor del cuerpo y no el de la sesion', SA, 'const args = { p_actor: u.id, p_restaurante: rid, p_modo: modo };', 'const args = { p_actor: b.actor || u.id, p_restaurante: rid, p_modo: modo };', ['superadmin'], { equivalente: 'soloAdmitidos rechaza el campo "actor" antes (400) y la funcion SQL vuelve a exigir superadmin sobre el actor recibido' });
m('LECTURA: sin el SQL 19 la lectura responde 500 en vez del aviso claro', SA, 'if (faltaLaFuncion(err)) throw new ErrorDeAccion(503,', 'if (false) throw new ErrorDeAccion(503,', ['sin19']);
m('LECTURA: el aviso de que falta el SQL 19 no se reconoce por el codigo del falso (42883)', SA, 'c.code === "PGRST202" || c.code === "42883"', 'c.code === "PGRST202"', ['sin19'], { equivalente: '42883 es solo lo que contesta el Supabase falso; PostgREST real contesta PGRST202. Se declara porque la unica prueba de este camino corre contra el falso' });

// ---- 5. SQL 19: quien puede ejecutar ----
for (const [fn, trozo] of [['sa_ver_pedidos', 'declare\n  v_limite integer'], ['sa_ver_menu', 'declare\n  c_max_categorias'], ['sa_ver_config', 'declare\n  v_det jsonb;'], ['sa_ver_resumen', 'declare\n  r public.restaurantes%rowtype;']]) {
  m(`SQL ${fn} no exige superadmin`, S19, trozo, trozo, ['sql19', 'superadmin'], { cortar: fn });
}
m('SQL sa_registrar_rechazo_mfa no exige superadmin', S19, "begin\n  perform public.exigir_superadmin(p_actor);\n  if exists (select 1 from public.auditoria_superadmin a\n             where a.actor = p_actor and a.accion = 'rechazo_mfa'", "begin\n  if exists (select 1 from public.auditoria_superadmin a\n             where a.actor = p_actor and a.accion = 'rechazo_mfa'", ['sql19', 'superadmin']);
m('SQL las funciones nuevas se le dan tambien a authenticated', S19, "execute format('grant execute on function public.%I(%s) to service_role', p.proname, p.args);", "execute format('grant execute on function public.%I(%s) to service_role, authenticated', p.proname, p.args);", ['sql19']);
m('SQL las funciones nuevas no se le quitan a anon', S19, "execute format('revoke all on function public.%I(%s) from public, anon, authenticated', p.proname, p.args);", "execute format('revoke all on function public.%I(%s) from authenticated', p.proname, p.args);", ['sql19']);
m('SQL la ayuda auditar_lectura_superadmin la puede ejecutar el servidor', S19, "revoke all on function public.auditar_lectura_superadmin(uuid, text, uuid, jsonb, interval) from public, anon, authenticated, service_role;", "revoke all on function public.auditar_lectura_superadmin(uuid, text, uuid, jsonb, interval) from public, anon, authenticated;", ['sql19', 'superadmin']);
m('SQL las lecturas no fijan el search_path', S19, "returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = ''\nas $fn$\ndeclare\n  c_max_categorias", "returns jsonb\nlanguage plpgsql\nsecurity definer\nas $fn$\ndeclare\n  c_max_categorias", ['sql19']);

// ---- 6. SQL 19: lo que devuelven ----
m('SQL ver_pedidos: no filtra por restaurante (mezcla los de otros)', S19, "    where p.restaurante_id = p_restaurante\n      and (p_modo = 'recientes'", "    where true\n      and (p_modo = 'recientes'", ['sql19', 'superadmin']);
m('SQL ver_pedidos: el inicio de la jornada es exclusivo', S19, "(p.creado_en >= v_inicio and p.creado_en < v_fin)", "(p.creado_en > v_inicio and p.creado_en < v_fin)", ['sql19']);
m('SQL ver_pedidos: el fin de la jornada es inclusivo', S19, "(p.creado_en >= v_inicio and p.creado_en < v_fin)", "(p.creado_en >= v_inicio and p.creado_en <= v_fin)", ['sql19']);
m('SQL ver_pedidos: el corte de la jornada ignora la configuracion', S19, "v_corte := coalesce((select c.hora_corte_jornada from public.configuracion c where c.restaurante_id = p_restaurante), '05:00'::time);\n  v_jornada := public.jornada_de(p_ahora, v_corte);\n  v_inicio := ((v_jornada + v_corte) at time zone 'America/Bogota');\n  v_fin := ((v_jornada + 1 + v_corte) at time zone 'America/Bogota');\n\n  with base", "v_corte := '00:00'::time;\n  v_jornada := public.jornada_de(p_ahora, v_corte);\n  v_inicio := ((v_jornada + v_corte) at time zone 'America/Bogota');\n  v_fin := ((v_jornada + 1 + v_corte) at time zone 'America/Bogota');\n\n  with base", ['sql19']);
m('SQL ver_pedidos: el tope por pagina es 1000', S19, "v_limite integer := greatest(1, least(coalesce(p_limite, 50), 100));", "v_limite integer := greatest(1, least(coalesce(p_limite, 50), 1000));", ['sql19']);
m('SQL ver_pedidos: sin tope inferior', S19, "v_limite integer := greatest(1, least(coalesce(p_limite, 50), 100));", "v_limite integer := least(coalesce(p_limite, 50), 100);", ['sql19']);
m('SQL ver_pedidos: el valor por defecto del limite es 100', S19, "v_limite integer := greatest(1, least(coalesce(p_limite, 50), 100));", "v_limite integer := greatest(1, least(coalesce(p_limite, 100), 100));", ['sql19']);
m('SQL ver_pedidos: la pagina siguiente repite el ultimo (antes_de inclusivo)', S19, "and (p_antes_de is null or p.id < p_antes_de)", "and (p_antes_de is null or p.id <= p_antes_de)", ['sql19', 'superadmin']);
m('SQL ver_pedidos: nunca avisa que hay mas', S19, "(select count(*) from base) > v_limite,", "false,", ['sql19', 'superadmin']);
m('SQL ver_pedidos: devuelve el token de seguimiento', S19, "'reembolsado_en', g.reembolsado_en, 'impreso_en', g.impreso_en, 'reimpresiones', g.reimpresiones", "'reembolsado_en', g.reembolsado_en, 'impreso_en', g.impreso_en, 'reimpresiones', g.reimpresiones, 'token_seguimiento', g.token_seguimiento", ['sql19', 'superadmin']);
m('SQL ver_pedidos: acepta cualquier modo', S19, "if p_modo is null or p_modo not in ('jornada', 'recientes') then", "if false then", ['sql19'], { equivalente: 'sin la validacion, un modo raro se trata como "jornada" (no hay otro camino): la prueba exige el 22023, asi que SI se detecta; se deja aqui solo si no' });
m('SQL ver_pedidos: acepta un restaurante inexistente (devuelve vacio)', S19, "if p_restaurante is null or not exists (select 1 from public.restaurantes r where r.id = p_restaurante) then\n    raise exception 'No existe ese restaurante' using errcode = 'P0002';\n  end if;\n  if p_modo is null", "if false then\n    raise exception 'No existe ese restaurante' using errcode = 'P0002';\n  end if;\n  if p_modo is null", ['sql19', 'superadmin']);
m('SQL ver_menu: oculta lo inactivo', S19, "from (select x.* from public.categorias x where x.restaurante_id = p_restaurante order by x.orden, x.id limit c_max_categorias) c", "from (select x.* from public.categorias x where x.restaurante_id = p_restaurante and x.activa order by x.orden, x.id limit c_max_categorias) c", ['sql19', 'superadmin']);
m('SQL ver_menu: oculta los productos agotados', S19, "from (select x.* from public.productos x where x.restaurante_id = p_restaurante order by x.categoria, x.orden, x.id limit c_max_productos) p", "from (select x.* from public.productos x where x.restaurante_id = p_restaurante and x.disponible order by x.categoria, x.orden, x.id limit c_max_productos) p", ['sql19', 'superadmin']);
m('SQL ver_menu: las opciones de TODOS los restaurantes', S19, "from (select x.* from public.producto_opciones x where x.restaurante_id = p_restaurante order by x.producto_id, x.orden, x.id limit c_max_opciones) o", "from (select x.* from public.producto_opciones x order by x.producto_id, x.orden, x.id limit c_max_opciones) o", ['sql19']);
m('SQL ver_menu: sin tope de categorias', S19, "c_max_categorias constant integer := 200;", "c_max_categorias constant integer := 100000;", ['sql19']);
m('SQL ver_menu: no avisa que corto una lista', S19, "'truncado', v_n_cat > c_max_categorias or v_n_prod > c_max_productos or v_n_ops > c_max_opciones", "'truncado', false", ['sql19']);
m('SQL ver_config: sin el horario', S19, "return v_det || jsonb_build_object('horario', coalesce(v_horario, '{}'::jsonb));", "return v_det;", ['sql19', 'superadmin']);
m('SQL ver_config: sin los miembros', S19, "v_det := public.sa_detalle_restaurante(p_actor, p_restaurante, p_ahora);", "v_det := public.sa_detalle_restaurante(p_actor, p_restaurante, p_ahora) - 'miembros';", ['sql19', 'superadmin']);
m('SQL ver_resumen: cuenta los cancelados como vendidos', S19, "'vendidos', count(*) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'),\n            'ventas', coalesce(sum(p.total) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'), 0),\n            'ticket_promedio'",
  "'vendidos', count(*) filter (where p.estado_pago = 'aprobado'),\n            'ventas', coalesce(sum(p.total) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'), 0),\n            'ticket_promedio'", ['sql19', 'superadmin']);
m('SQL ver_resumen: el mes se corta en UTC y no en la zona del restaurante', S19, "v_mes_ini := (date_trunc('month', p_ahora at time zone v_zona)) at time zone v_zona;\n  v_mes_fin := (date_trunc('month', p_ahora at time zone v_zona) + interval '1 month') at time zone v_zona;",
  "v_mes_ini := (date_trunc('month', p_ahora at time zone 'UTC')) at time zone 'UTC';\n  v_mes_fin := (date_trunc('month', p_ahora at time zone 'UTC') + interval '1 month') at time zone 'UTC';", ['sql19']);
m('SQL ver_resumen: la jornada incluye pedidos de otros restaurantes', S19, "          from public.pedidos p\n          where p.restaurante_id = p_restaurante and p.creado_en >= v_inicio and p.creado_en < v_fin);", "          from public.pedidos p\n          where p.creado_en >= v_inicio and p.creado_en < v_fin);", ['sql19', 'superadmin']);

// ---- 7. SQL 19: la auditoria ----
m('SQL auditoria: las lecturas no dejan constancia (ver_menu)', S19, "perform public.auditar_lectura_superadmin(p_actor, 'ver_menu', p_restaurante,\n    jsonb_build_object('categorias', v_n_cat, 'productos', v_n_prod, 'opciones', v_n_ops));", "", ['sql19', 'superadmin']);
m('SQL auditoria: las lecturas no dejan constancia (ver_pedidos)', S19, "perform public.auditar_lectura_superadmin(p_actor, 'ver_pedidos', p_restaurante,\n    jsonb_build_object('modo', p_modo, 'limite', v_limite, 'pagina_inicial', p_antes_de is null, 'devueltos', v_n));", "", ['sql19', 'superadmin']);
m('SQL auditoria: las lecturas no dejan constancia (ver_config)', S19, "perform public.auditar_lectura_superadmin(p_actor, 'ver_config', p_restaurante,", "perform 1 /*", ['sql19', 'superadmin'], { cierre: true });
m('SQL auditoria: las lecturas no dejan constancia (ver_resumen)', S19, "perform public.auditar_lectura_superadmin(p_actor, 'ver_resumen', p_restaurante, jsonb_build_object('jornada', v_jornada));", "", ['sql19', 'superadmin']);
m('SQL auditoria: el resumen de ver_pedidos trae el nombre de un cliente', S19, "jsonb_build_object('modo', p_modo, 'limite', v_limite, 'pagina_inicial', p_antes_de is null, 'devueltos', v_n));", "jsonb_build_object('modo', p_modo, 'limite', v_limite, 'pagina_inicial', p_antes_de is null, 'devueltos', v_n, 'primero', v_filas -> 0 ->> 'cliente_nombre'));", ['sql19', 'superadmin']);
m('SQL auditoria: el resumen de ver_pedidos trae el telefono', S19, "jsonb_build_object('modo', p_modo, 'limite', v_limite, 'pagina_inicial', p_antes_de is null, 'devueltos', v_n));", "jsonb_build_object('modo', p_modo, 'limite', v_limite, 'pagina_inicial', p_antes_de is null, 'devueltos', v_n, 'tel', v_filas -> 0 ->> 'cliente_telefono'));", ['sql19', 'superadmin']);
m('SQL auditoria: sin ventana (cada lectura repetida deja su fila)', S19, "      and a.creado_en > now() - p_ventana\n  ) then\n    return false;", "      and a.creado_en > now() - p_ventana\n      and false\n  ) then\n    return false;", ['sql19', 'superadmin']);
m('SQL auditoria: la ventana dura 1 segundo', S19, "p_ventana interval default interval '10 minutes')", "p_ventana interval default interval '1 second')", ['sql19']);
m('SQL auditoria: la ventana dura 30 minutos', S19, "p_ventana interval default interval '10 minutes')", "p_ventana interval default interval '30 minutes')", ['sql19']);
m('SQL auditoria: la ventana ignora el modo (jornada y recientes se confunden)', S19, "      and (a.resumen ->> 'modo') is not distinct from (p_resumen ->> 'modo')\n", "", ['sql19', 'superadmin']);
m('SQL auditoria: la ventana ignora el restaurante', S19, "      and a.restaurante_id is not distinct from p_restaurante\n      and (a.resumen ->> 'modo')", "      and (a.resumen ->> 'modo')", ['sql19', 'superadmin']);
m('SQL auditoria: la ventana ignora al superadmin', S19, "    where a.actor = p_actor\n      and a.accion = p_accion\n      and a.restaurante_id", "    where a.accion = p_accion\n      and a.restaurante_id", ['sql19']);
m('SQL rechazo MFA: una fila por intento (sin ventana)', S19, "where a.actor = p_actor and a.accion = 'rechazo_mfa' and a.creado_en > now() - interval '15 minutes') then", "where a.actor = p_actor and a.accion = 'rechazo_mfa' and a.creado_en > now() - interval '15 minutes' and false) then", ['sql19', 'superadmin']);
m('SQL rechazo MFA: la ventana dura 1 hora', S19, "where a.actor = p_actor and a.accion = 'rechazo_mfa' and a.creado_en > now() - interval '15 minutes') then", "where a.actor = p_actor and a.accion = 'rechazo_mfa' and a.creado_en > now() - interval '1 hour') then", ['sql19']);
m('SQL rechazo MFA: la ventana es global (un superadmin tapa al otro)', S19, "where a.actor = p_actor and a.accion = 'rechazo_mfa' and a.creado_en > now() - interval '15 minutes') then", "where a.accion = 'rechazo_mfa' and a.creado_en > now() - interval '15 minutes') then", ['sql19', 'superadmin']);
m('SQL rechazo MFA: guarda el nombre de accion que mande el cliente', S19, "'accion_intentada', case when p_accion ~ '^[a-z][a-z0-9_]{2,59}$' then p_accion else null end,", "'accion_intentada', p_accion,", ['sql19']);
m('SQL rechazo MFA: guarda el nivel que mande el cliente', S19, "'aal', case when p_aal = 'aal2' then 'aal2' else 'aal1' end,", "'aal', p_aal,", ['sql19']);

// ---- 8. SQL 19: revertir y el 16 ----
m('REVERSA 19: no borra la funcion del rechazo MFA', 'supabase/19-revertir.sql', "proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa', 'auditar_lectura_superadmin')\n  loop", "proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'auditar_lectura_superadmin')\n  loop", ['sql19']);
m('SQL 16: la cuenta de 15 funciones vuelve a contar las del 19 (el 16 no se puede re-correr)', 'supabase/16-superadmin.sql',
  "       and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno',\n                             'sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa')),\n    (select string_agg",
  "       and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno')),\n    (select string_agg", ['sql19']);

/* ---------------------------------------------------------------------------------------------------- */
function correr(archivoNodo, args, env, cwd) {
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [archivoNodo, ...args], { cwd, env: { ...process.env, ...env } });
    let salida = '';
    h.stdout.on('data', (d) => { salida += d; });
    h.stderr.on('data', (d) => { salida += d; });
    const t = setTimeout(() => { salida += '\n[TIEMPO AGOTADO]'; h.kill(); }, 8 * 60 * 1000);
    h.on('close', (codigo) => { clearTimeout(t); resolve({ codigo, salida }); });
  });
}
function copiarRepo(destino) {
  for (const rel of ['api', 'supabase', 'pruebas', 'horario-regla.js', 'opciones-texto.js', 'vercel.json']) {
    const o = path.join(RAIZ, rel), d = path.join(destino, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(o, d, { recursive: true });
  }
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(destino, 'node_modules'), 'junction');
}

/* Aplica la mutacion a 'texto' (LF). Devuelve el texto nuevo o lanza si el 'viejo' no aparece EXACTAMENTE una vez. */
function aplicar(texto, mu) {
  let s = texto;
  const viejos = [].concat(mu.viejo), nuevos = [].concat(mu.nuevo);
  viejos.forEach((v, k) => {
    const partes = s.split(v);
    if (partes.length !== 2) throw new Error(`el texto aparece ${partes.length - 1} veces: ${v.slice(0, 60).replace(/\n/g, '\\n')}`);
    s = partes.join(nuevos[k]);
  });
  // mutaciones "sin exigir_superadmin" de una funcion concreta: se quita SU llamada (la primera que aparece despues de su cabecera)
  if (mu.cortar) {
    const i = s.indexOf(`create or replace function public.${mu.cortar}(`);
    const j = s.indexOf('perform public.exigir_superadmin(p_actor);', i);
    if (i < 0 || j < 0) throw new Error('no encuentro exigir_superadmin en ' + mu.cortar);
    s = s.slice(0, j) + 'null;' + s.slice(j + 'perform public.exigir_superadmin(p_actor);'.length);
  }
  // mutacion "ver_config no audita": se comenta la llamada hasta su cierre
  if (mu.cierre) {
    const i = s.indexOf('perform 1 /*');
    const fin = s.indexOf("'dominios', jsonb_array_length(coalesce(v_det -> 'dominios', '[]'::jsonb))));", i);
    if (fin < 0) throw new Error('no encuentro el cierre de la auditoria de ver_config');
    s = s.slice(0, i) + 'null;' + s.slice(fin + "'dominios', jsonb_array_length(coalesce(v_det -> 'dominios', '[]'::jsonb))));".length);
  }
  if (s === texto) throw new Error('la mutacion no cambia nada');
  return s;
}

const SUITES = {
  mfa: (tmp) => new Promise((resolve) => {
    const h = spawn(process.execPath, ['--test', path.join(tmp, 'pruebas', 'mfa.test.js')], { cwd: tmp });
    let salida = ''; h.stdout.on('data', (x) => { salida += x; }); h.stderr.on('data', (x) => { salida += x; });
    h.on('close', (codigo) => resolve({ codigo, salida }));
  }),
  superadmin: (tmp, p) => correr(path.join(tmp, 'pruebas/multirestaurante/superadmin.mjs'), [], { SUPERADMIN_PUERTO: String(p) }, tmp),
  sin19: (tmp, p) => correr(path.join(tmp, 'pruebas/multirestaurante/superadmin.mjs'), ['--sin-sql19'], { SUPERADMIN_PUERTO: String(p) }, tmp),
  sql19: (tmp) => correr(path.join(tmp, 'pruebas/multirestaurante/sql19.mjs'), [], {}, tmp),
  sql16: (tmp) => correr(path.join(tmp, 'pruebas/multirestaurante/sql16.mjs'), [], {}, tmp)
};

const lista = M.filter((x) => !solo || x.control || new RegExp(solo, 'i').test(x.nombre));
const resultados = new Array(lista.length);
let siguiente = 0;
async function trabajador(n) {
  while (true) {
    const i = siguiente++;
    if (i >= lista.length) return;
    const mu = lista[i];
    const tmp = soloValidar ? RAIZ : fs.mkdtempSync(path.join(os.tmpdir(), 'mutmfa-'));
    let r;
    try {
      if (!soloValidar) copiarRepo(tmp);
      const f = path.join(tmp, mu.archivo);
      let s = fs.readFileSync(f, 'utf8');
      const crlf = s.includes('\r\n');
      if (crlf) s = s.replace(/\r\n/g, '\n');
      let nuevo;
      try { nuevo = mu.control ? s : aplicar(s, mu); } catch (e) { r = { ...mu, estado: 'ERROR', info: e.message }; }
      if (!r && soloValidar) r = { ...mu, estado: 'APLICABLE', info: '' };
      if (!r) {
        fs.writeFileSync(f, crlf ? nuevo.replace(/\n/g, '\r\n') : nuevo);
        const detectada = [];
        for (const suite of mu.suites) {
          const res = await SUITES[suite](tmp, 54400 + n);
          if (res.codigo !== 0) { detectada.push(suite); break; }
        }
        r = { ...mu, estado: mu.control ? (detectada.length ? 'ERROR' : 'CONTROL OK') : detectada.length ? 'DETECTADA' : (mu.equivalente ? 'EQUIVALENTE' : 'SIN DETECTAR'),
          info: mu.control && detectada.length ? 'la copia limpia falla en ' + detectada.join(',') : detectada.join(',') };
      }
    } catch (e) {
      r = { ...mu, estado: 'ERROR', info: e.message };
    } finally {
      if (!soloValidar) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* en uso */ } }
    }
    resultados[i] = r;
    console.log(`  [${i + 1}/${lista.length}] ${r.estado.padEnd(12)} ${r.nombre}${r.estado === 'DETECTADA' ? ' (' + r.info + ')' : r.estado === 'ERROR' ? ' -> ' + r.info : ''}`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: paralelo }, (_, n) => trabajador(n)));
const cuenta = (e) => resultados.filter((r) => r && r.estado === e).length;
const controles = cuenta('CONTROL OK');
console.log(`\n${controles ? 'Control: la copia limpia pasa todas las suites. ' : ''}${resultados.length - controles} mutaciones: ${cuenta('DETECTADA')} detectadas, ${cuenta('EQUIVALENTE')} equivalentes declaradas, ${cuenta('SIN DETECTAR')} sin detectar, ${cuenta('ERROR')} con error${soloValidar ? ', ' + cuenta('APLICABLE') + ' aplicables' : ''}. (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
for (const r of resultados.filter((x) => x && (x.estado === 'SIN DETECTAR' || x.estado === 'ERROR'))) console.log(`  !! ${r.estado}: ${r.nombre} ${r.info || ''}`);
for (const r of resultados.filter((x) => x && x.estado === 'EQUIVALENTE')) console.log(`  = equivalente: ${r.nombre} -> ${r.equivalente}`);
process.exitCode = cuenta('SIN DETECTAR') || cuenta('ERROR') ? 1 : 0;
