/* =============================================================
   REVISION POR MUTACION DEL SQL 15 (supabase/15-datos-restaurante.sql)

   Rompe A PROPOSITO, una por una, cada defensa del SQL 15 y exige que algo lo detecte:
     * la propia migracion (sus comprobaciones finales -> "SE REVIRTIO", o un error), o
     * la sonda de comportamiento de datos-restaurante.mjs (roles reales, RLS real), o
     * los escenarios de abortar (horario de Taqueiros invalido; falta el SQL 13).

   Una mutacion es DETECTADA si alguna de esas falla; SOBREVIVE si todas pasan (falta una prueba).
   Las EQUIVALENTES se declaran con su razon.

     node pruebas/multirestaurante/datos-restaurante.mjs --mutaciones
     node pruebas/multirestaurante/mutaciones-15.mjs            (solo la revision por mutacion)
     node pruebas/multirestaurante/mutaciones-15.mjs --solo=rol (las que contengan ese texto)
============================================================= */
import { crearBase, sembrar, sql10, sql } from './sim.mjs';

const BS = String.fromCharCode(92);
const M = [];
/* m(nombre, buscar, reemplazar, { equivalente, todas }) */
const m = (nombre, buscar, reemplazar, extra) => M.push({ nombre, buscar, reemplazar, ...(extra || {}) });

// ---- PASO 0 y 1.2: precondiciones ----
m('0: ya no exige el SQL 13 (config_restaurante_errores)', "'public.config_restaurante_errores(jsonb)','public.proteger_campos_restaurante()',", "'public.proteger_campos_restaurante()',",
  { equivalente: 'sin el SQL 13 tambien falta que proteger_campos_restaurante sea la version del SQL 13: la otra precondicion lo detiene (solo quitando las dos se ve: mutacion siguiente)' });
m('0: no comprueba que proteger_campos_restaurante sea el del SQL 13', "if not exists (select 1 from pg_proc p where p.oid = 'public.proteger_campos_restaurante()'::regprocedure\n                 and p.prosrc like '%publico,textos%' and p.prosrc like '%permitidas%') then", 'if false then',
  { equivalente: 'sin el SQL 13 tambien falta config_restaurante_errores: la otra precondicion lo detiene (solo quitando las dos se ve: mutacion siguiente)' });
m('0: ninguna de las dos precondiciones del SQL 13', "'public.config_restaurante_errores(jsonb)','public.proteger_campos_restaurante()',", "'public.proteger_campos_restaurante()',",
  { tambien: ["if not exists (select 1 from pg_proc p where p.oid = 'public.proteger_campos_restaurante()'::regprocedure\n                 and p.prosrc like '%publico,textos%' and p.prosrc like '%permitidas%') then", 'if false then'] });
m('1.2: ya no revisa el horario actual de Taqueiros antes de activar el trigger (el mensaje claro desaparece)', "  if cardinality(v_err) > 0 then\n    raise exception E'El horario o el mensaje de cerrado ACTUALES", "  if false then\n    raise exception E'El horario o el mensaje de cerrado ACTUALES");
m('1.2: no se detiene si Taqueiros no tiene fila de configuracion', "  if v_err is null then\n    raise exception 'Taqueiros no tiene fila", "  if false then\n    raise exception 'Taqueiros no tiene fila",
  { equivalente: 'sin fila, la comprobacion final "el horario actual de Taqueiros cumple las reglas" da NULL=falso y la migracion se revierte igual' });

// ---- PASO 1.1: reglas del horario ----
m('horario: acepta mas de 7 dias', 'if v_n <> 7 then', 'if v_n < 7 then');
m('horario: acepta menos de 7 dias', 'if v_n <> 7 then', 'if v_n > 7 then');
m('horario: acepta claves de mas en un dia', "if v_k not in ('dia', 'abre', 'cierra', 'activo') then", "if v_k not in ('dia', 'abre', 'cierra', 'activo', 'extra') then");
m('horario: el nombre del dia puede ser larguisimo', 'char_length(v_t) not between 1 and 20', 'char_length(v_t) not between 1 and 2000');
m('horario: el nombre del dia admite HTML', "or v_t ~ '[<>]' or v_t ~ c_control then", 'or v_t ~ c_control then');
m('horario: el nombre del dia admite caracteres de control', "or v_t ~ '[<>]' or v_t ~ c_control then", "or v_t ~ '[<>]' then");
m('horario: la hora de apertura admite 24:xx', "c_hora constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';", "c_hora constant text := '^([01][0-9]|2[0-4]):[0-5][0-9]$';");
m('horario: la hora admite minutos 60+', "c_hora constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';", "c_hora constant text := '^([01][0-9]|2[0-3]):[0-9][0-9]$';");
m('horario: la hora admite una cifra (9:30)', "c_hora constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';", "c_hora constant text := '^([01]?[0-9]|2[0-3]):[0-5][0-9]$';");
m('horario: ya no se puede cerrar a las 24:00', "if v_t is null or not (v_t ~ c_hora or v_t = '24:00') then", 'if v_t is null or not (v_t ~ c_hora) then');
m('horario: se puede cerrar a las 24:30', "if v_t is null or not (v_t ~ c_hora or v_t = '24:00') then", "if v_t is null or not (v_t ~ c_hora or v_t ~ '^24:[0-5][0-9]$') then");
m('horario: activo puede ser cualquier cosa', "if coalesce(jsonb_typeof(v_dia -> 'activo'), '') <> 'boolean' then", 'if false then');
m('horario: no exige el objeto de cada dia', "if coalesce(jsonb_typeof(v_dia), '') <> 'object' then", 'if false then',
  { equivalente: 'si un dia no es objeto, jsonb_object_keys lanza un error (22023) que tambien rechaza el UPDATE; solo cambia el mensaje' });
m('horario: acepta 8 dias porque solo mira los primeros 7', 'least(v_n, 14) - 1', 'least(v_n, 7) - 1', { equivalente: 'el recuento de dias (<> 7) ya rechaza una lista de mas o menos de 7 antes de que el bucle importe' });
m('mensaje: sin tope de largo', 'if char_length(p_mensaje) > 300 then', 'if char_length(p_mensaje) > 30000 then');
m('mensaje: el tope es 3000', 'if char_length(p_mensaje) > 300 then', 'if char_length(p_mensaje) > 3000 then');
m('mensaje: admite HTML', "if p_mensaje ~ '[<>]' then", 'if false then');
m('mensaje: rechaza el salto de linea (usa la regla del nombre del dia)', 'if p_mensaje ~ c_control_linea then', 'if p_mensaje ~ c_control then');
m('mensaje: admite caracteres de control', 'if p_mensaje ~ c_control_linea then', 'if false then');
m('mensaje: admite el campana (BEL) y otros controles bajos', "c_control_linea constant text := '[" + BS + "x01-" + BS + "x09" + BS + "x0b-" + BS + "x1f", "c_control_linea constant text := '[" + BS + "x0b-" + BS + "x1f");
m('mensaje: admite ancho cero y marcas bidi', "c_invisibles constant text := chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8297) || chr(65279);",
  "c_invisibles constant text := chr(1);");
m('validar_mensaje: la bandera se ignora (se valida siempre)', 'if p_validar_mensaje and p_mensaje is not null then', 'if p_mensaje is not null then',
  { equivalente: 'el trigger solo pasa la bandera en false cuando el mensaje no cambio; validar un mensaje valido da lo mismo. Solo importa con un mensaje viejo invalido, que ningun escenario real guarda' });

// ---- PASO 1.3: el trigger ----
m('trigger: solo valida los UPDATE (no los INSERT)', 'before insert or update on public.configuracion', 'before update on public.configuracion');
m('trigger: solo valida los INSERT (no los UPDATE)', 'before insert or update on public.configuracion', 'before insert on public.configuracion');
m('trigger: en UPDATE valida el horario aunque no haya cambiado', 'v_horarios := new.horarios is distinct from old.horarios;', 'v_horarios := true;');
m('trigger: en UPDATE valida el mensaje aunque no haya cambiado', 'v_mensaje := new.mensaje_cerrado is distinct from old.mensaje_cerrado;', 'v_mensaje := true;');
m('trigger: un UPDATE que cambia el horario no se valida', 'v_horarios := new.horarios is distinct from old.horarios;', 'v_horarios := false;');
m('trigger: un UPDATE que cambia el mensaje no se valida', 'v_mensaje := new.mensaje_cerrado is distinct from old.mensaje_cerrado;', 'v_mensaje := false;');
m('trigger: ya no sale antes cuando nada cambio', '    if not v_horarios and not v_mensaje then\n      return new;\n    end if;\n', '',
  { equivalente: 'sin cambios, las dos banderas son falsas y configuracion_errores no valida nada: mismo resultado' });
m('trigger: el error ya no es 23514', "using errcode = '23514', hint = 'Las reglas estan en docs/multirestaurante.md, seccion 17';", "using errcode = 'P0001', hint = 'Las reglas estan en docs/multirestaurante.md, seccion 17';");
m('trigger: solo muestra el error, no lo lanza', "    raise exception 'Horario o mensaje de cerrado no validos: %',", "    raise notice 'Horario o mensaje de cerrado no validos: %',");
m('trigger: se rechaza tambien al servidor... pero se quita para el servidor', "  v_err := public.configuracion_errores(new.horarios, new.mensaje_cerrado, v_horarios, v_mensaje);", "  if public.es_servidor() then return new; end if;\n  v_err := public.configuracion_errores(new.horarios, new.mensaje_cerrado, v_horarios, v_mensaje);");
m('permisos: anon puede ejecutar configuracion_errores', 'revoke all on function public.configuracion_errores(jsonb, text, boolean, boolean) from public, anon;', 'revoke all on function public.configuracion_errores(jsonb, text, boolean, boolean) from public;');
m('permisos: anon puede ejecutar validar_configuracion', 'revoke all on function public.validar_configuracion() from public, anon;', 'revoke all on function public.validar_configuracion() from public;');

// ---- PASO 2: guardar_datos_restaurante ----
const F = 'guardar_datos_restaurante';
m(`${F}: ya no se puede editar el nombre`, "    'nombre',\n    'textos.titulo_pagina'", "    'textos.titulo_pagina'");
m(`${F}: se puede editar la marca`, "    'contacto.whatsapp', 'contacto.telefono',", "    'marca.logo', 'contacto.whatsapp', 'contacto.telefono',");
m(`${F}: se puede editar el plan`, "    'contacto.whatsapp', 'contacto.telefono',", "    'plan', 'contacto.whatsapp', 'contacto.telefono',");
m(`${F}: se puede editar el estado`, "    'contacto.whatsapp', 'contacto.telefono',", "    'estado', 'contacto.whatsapp', 'contacto.telefono',");
m(`${F}: se puede editar un contenedor entero (textos)`, "    'contacto.whatsapp', 'contacto.telefono',", "    'textos', 'contacto.whatsapp', 'contacto.telefono',");
m(`${F}: ya no se puede editar el texto de un campo (frase_entregado)`, "    'textos.seguimiento.frase_recoger', 'textos.seguimiento.frase_entregado',", "    'textos.seguimiento.frase_recoger',");
m(`${F}: acepta un campo repetido`, 'if v_campo = any (v_vistos) then', 'if false then');
m(`${F}: acepta mas de 40 cambios`, 'if jsonb_array_length(p_cambios) > 40 then', 'if jsonb_array_length(p_cambios) > 4000 then',
  { equivalente: 'solo hay 32 campos permitidos y un campo repetido se rechaza: una lista de mas de 32 cambios nunca pasa por otra regla; el tope de 40 solo acota el trabajo' });
m(`${F}: acepta un restaurante nulo`, '  if p_restaurante is null then\n    raise exception', '  if false then\n    raise exception');
m(`${F}: acepta claves de mas en un cambio`, "if v_k not in ('campo', 'antes', 'despues') then", "if v_k not in ('campo', 'antes', 'despues', 'extra') then");
m(`${F}: acepta antes/despues que no son texto`, "if (v_cambio ? v_k) and jsonb_typeof(v_cambio -> v_k) not in ('string', 'null') then", 'if false then');
m(`${F}: acepta un campo que no es texto`, "if jsonb_typeof(v_cambio -> 'campo') is distinct from 'string' then", 'if false then',
  { equivalente: 'un campo que no es texto no esta en la lista cerrada: se rechaza igual con 22023 (campo no permitido)' });
m(`${F}: acepta un cambio que no es objeto`, "    if jsonb_typeof(v_cambio) <> 'object' then", '    if false then',
  { equivalente: 'jsonb_object_keys lanza 22023 sobre un valor que no es objeto: mismo codigo, otro mensaje' });
m(`${F}: acepta p_cambios que no es una lista`, "if p_cambios is null or jsonb_typeof(p_cambios) <> 'array' then", 'if false then',
  { equivalente: 'jsonb_array_length lanza 22023 sobre un valor que no es lista: mismo codigo, otro mensaje' });
m(`${F}: ya no exige ser dueno, superadmin o servidor`, "  if not (public.es_servidor() or (select public.es_superadmin()) or public.rol_en(p_restaurante) = 'dueno') then", '  if false then');
m(`${F}: cualquier miembro puede (no solo el dueno)`, "public.rol_en(p_restaurante) = 'dueno')", 'public.rol_en(p_restaurante) is not null)',
  { equivalente: 'RLS y el trigger del SQL 13 (defensa de fondo) siguen rechazando al cajero y a la cocina: el SELECT ... FOR UPDATE no ve la fila' });
m(`${F}: sin el candado de la fila`, 'where r.id = p_restaurante for update;', 'where r.id = p_restaurante;');
m(`${F}: no falla si el restaurante no existe`, '  if not found then\n    raise exception', '  if false then\n    raise exception');
m(`${F}: no compara con lo que el usuario vio (nunca hay conflicto)`, 'if v_antes is distinct from v_actual then', 'if false then');
m(`${F}: siempre hay conflicto`, 'if v_antes is distinct from v_actual then', 'if true then');
m(`${F}: el valor "antes" no se recorta`, "v_antes := nullif(btrim(v_cambio ->> 'antes'), '');", "v_antes := nullif(v_cambio ->> 'antes', '');");
m(`${F}: el valor actual no se recorta`, "v_actual := nullif(btrim(v_config #>> (array['publico'] || string_to_array(v_campo, '.'))), '');", "v_actual := nullif(v_config #>> (array['publico'] || string_to_array(v_campo, '.')), '');");
m(`${F}: el valor "despues" no se recorta (un campo con espacios no se borra)`, "v_despues := nullif(btrim(v_cambio ->> 'despues'), '');", "v_despues := nullif(v_cambio ->> 'despues', '');");
m(`${F}: el conflicto no devuelve el valor actual`, "jsonb_build_object('campo', v_campo, 'actual', v_actual)", "jsonb_build_object('campo', v_campo)");
m(`${F}: el conflicto responde ok`, "'ok', false,\n      'conflictos', v_conflictos,", "'ok', true,\n      'conflictos', v_conflictos,");
m(`${F}: el conflicto no devuelve los datos vigentes`, "      'conflictos', v_conflictos,\n      'datos', jsonb_build_object('nombre', v_nombre,\n                                  'textos', coalesce(v_config #> '{publico,textos}', '{}'::jsonb),\n                                  'contacto', coalesce(v_config #> '{publico,contacto}', '{}'::jsonb)));",
  "      'conflictos', v_conflictos);");
m(`${F}: borrar un campo lo deja en null en vez de quitarlo`, '        v_config := v_config #- v_ruta;', "        v_config := jsonb_set(v_config, v_ruta, 'null'::jsonb, true);");
m(`${F}: no crea los contenedores que faltan`, "        if (v_config #> v_prefijo) is null then\n          v_config := jsonb_set(v_config, v_prefijo, '{}'::jsonb, true);", "        if false then\n          v_config := jsonb_set(v_config, v_prefijo, '{}'::jsonb, true);");
m(`${F}: pisa un contenedor que no es objeto en vez de rechazar`, "        elsif jsonb_typeof(v_config #> v_prefijo) <> 'object' then\n          raise exception", "        elsif false then\n          raise exception",
  { equivalente: 'la config validada (SQL 13) nunca guarda textos/contacto/seguimiento que no sean objeto: no hay forma de llegar ahi' });
m(`${F}: no revisa que config.publico sea un objeto`, "  if v_config ? 'publico' and jsonb_typeof(v_config -> 'publico') <> 'object' then\n    raise exception", "  if false then\n    raise exception",
  { equivalente: 'la config validada (SQL 13) nunca guarda un publico que no sea objeto' });
m(`${F}: reemplaza la config entera con la nueva (pierde las demas claves)`, "      v_config := jsonb_set(v_config, v_ruta, to_jsonb(v_despues), true);", "      v_config := jsonb_build_object('publico', jsonb_build_object(v_ruta[2], jsonb_build_object(v_ruta[cardinality(v_ruta)], v_despues)));");
m(`${F}: el nombre no se guarda`, '        v_nombre := v_despues;\n        v_n := v_n + 1;', '        v_n := v_n + 1;');
m(`${F}: el nombre admite HTML`, "if char_length(v_despues) > 120 or v_despues ~ '[<>]' or v_despues ~ c_control then", 'if char_length(v_despues) > 120 or v_despues ~ c_control then');
m(`${F}: el nombre admite mas de 120 caracteres`, "if char_length(v_despues) > 120 or v_despues ~ '[<>]'", "if char_length(v_despues) > 1200 or v_despues ~ '[<>]'");
m(`${F}: el nombre admite caracteres de control`, "if char_length(v_despues) > 120 or v_despues ~ '[<>]' or v_despues ~ c_control then", "if char_length(v_despues) > 120 or v_despues ~ '[<>]' then");
m(`${F}: el nombre puede quedar vacio`, "      if v_despues is null then\n        raise exception 'El nombre del restaurante no puede quedar vacio' using errcode = '23514';\n      end if;\n", '',
  { equivalente: 'el nombre es NOT NULL en la tabla: un nombre vacio se rechaza igual (23502)' });
m(`${F}: guarda aunque no haya cambios`, '  if v_n > 0 then\n    update public.restaurantes', '  if true then\n    update public.restaurantes',
  { equivalente: 'un UPDATE con los mismos valores no cambia la fila (el resultado "cambios: 0" es el mismo)' });
m(`${F}: es SECURITY DEFINER`, "create or replace function public.guardar_datos_restaurante(p_restaurante uuid, p_cambios jsonb)\nreturns jsonb\nlanguage plpgsql\nset search_path = ''", "create or replace function public.guardar_datos_restaurante(p_restaurante uuid, p_cambios jsonb)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = ''");
m(`${F}: sin search_path fijo`, "create or replace function public.guardar_datos_restaurante(p_restaurante uuid, p_cambios jsonb)\nreturns jsonb\nlanguage plpgsql\nset search_path = ''", "create or replace function public.guardar_datos_restaurante(p_restaurante uuid, p_cambios jsonb)\nreturns jsonb\nlanguage plpgsql");
m(`${F}: anon puede ejecutarla`, 'revoke all on function public.guardar_datos_restaurante(uuid, jsonb) from public, anon;', 'revoke all on function public.guardar_datos_restaurante(uuid, jsonb) from public;');
m(`${F}: authenticated no puede ejecutarla`, 'grant execute on function public.guardar_datos_restaurante(uuid, jsonb) to authenticated, service_role;', 'grant execute on function public.guardar_datos_restaurante(uuid, jsonb) to service_role;',
  { equivalente: 'Supabase le da EXECUTE a authenticated por los privilegios por defecto de public (igual que en esta simulacion); el grant explicito solo lo deja escrito' });

// ---- las comprobaciones del propio archivo ----
m('comprobacion: el chequeo de "no cambio ningun dato" ya no mira', 'where d.filas <> a.filas or d.huella <> a.huella),\n    null),\n\n  (\'no quedo ningun restaurante de prueba', 'where false),\n    null),\n\n  (\'no quedo ningun restaurante de prueba',
  { equivalente: 'las pruebas internas se deshacen con una excepcion: no hay forma de que cambien datos; el chequeo es un cinturon extra y la sonda (huellas de 8 tablas) lo cubre' });

/* ----------------------------------------------------------------------------------------------- */
export async function correrMutaciones({ sonda, baseConSql13, SQL15, solo = process.argv.find((a) => a.startsWith('--solo=')), log = console.log } = {}) {
  const filtro = solo ? String(solo).replace(/^--solo=/, '') : '';
  const original = SQL15().replace(/\r\n/g, '\n');
  const resumen = { detectadas: 0, equivalentes: 0, sobreviven: [], errores: [], detalle: [] };
  const lista = M.filter((x) => !filtro || x.nombre.includes(filtro));
  log(`REVISION POR MUTACION del SQL 15: ${lista.length} mutaciones`);

  for (const mu of lista) {
    const n = original.split(mu.buscar).length - 1;
    if (mu.todas ? n < 1 : n !== 1) {
      resumen.errores.push(`${mu.nombre}: "${mu.buscar.slice(0, 60)}" aparece ${n} veces`);
      log(`  ERROR   ${mu.nombre}\n      aparece ${n} veces`);
      continue;
    }
    let mutado = original.split(mu.buscar).join(mu.reemplazar);
    if (mu.tambien) {
      if (mutado.split(mu.tambien[0]).length !== 2) { resumen.errores.push(mu.nombre + ': la segunda parte no aparece una vez'); continue; }
      mutado = mutado.split(mu.tambien[0]).join(mu.tambien[1]);
    }
    let donde = null;
    try {
      // 1) la propia migracion + la sonda
      const db = await baseConSql13();
      let filas = null;
      try {
        filas = (await db.exec(mutado)).pop().rows;
        const mal = filas.filter((x) => x.estado !== 'OK');
        if (mal.length) donde = 'la propia migracion (' + mal[0].verificacion.slice(0, 70) + ')';
      } catch (e) {
        await db.exec('rollback').catch(() => {});
        donde = 'la migracion se detuvo (' + String(e.message).replace(/\s+/g, ' ').slice(0, 90) + ')';
      }
      if (!donde) {
        const h = await sonda(db);
        if (h.length) donde = 'la sonda (' + h[0].slice(0, 90) + ')';
      }
      // 2) los escenarios de abortar: lo mutado debe seguir deteniendose cuando corresponde
      if (!donde) {
        const d1 = await baseConSql13();
        await d1.query(`update public.configuracion set horarios = jsonb_set(horarios, '{2,abre}', '"25:00"') where restaurante_id = '00000000-0000-4000-8000-000000000001'`);
        let aborto = false, mensaje = '';
        try { await d1.exec(mutado); } catch (e) { aborto = true; mensaje = e.message; await d1.exec('rollback').catch(() => {}); }
        if (!aborto) donde = 'escenario: el horario invalido de Taqueiros ya no detiene la migracion';
        else if (!/MR paso 1\.2/.test(mensaje) || !/horarios\.2\.abre/.test(mensaje)) donde = 'escenario: el horario invalido de Taqueiros detiene la migracion pero sin decir que dia y campo corregir';
      }
      if (!donde) {
        const d2 = await crearBase({ con01y02: true });
        await sembrar(d2);
        await d2.exec(sql10()); await d2.exec(sql('11-dominios.sql')); await d2.exec(sql('12-config-publica.sql'));
        let aborto = false, mensaje = '';
        try { await d2.exec(mutado); } catch (e) { aborto = true; mensaje = e.message; await d2.exec('rollback').catch(() => {}); }
        if (!aborto) donde = 'escenario: sin el SQL 13 la migracion ya no se detiene';
        else if (!/MR paso 0/.test(mensaje) || !/13/.test(mensaje)) donde = 'escenario: sin el SQL 13 se detiene pero sin el mensaje claro del paso 0';
      }
    } catch (e) {
      donde = 'error de la prueba: ' + String(e.message).slice(0, 100);
    }
    if (donde) {
      resumen.detectadas++;
      log(`  DETECTADA  ${mu.nombre}\n      ${donde}`);
    } else if (mu.equivalente) {
      resumen.equivalentes++;
      resumen.detalle.push(`${mu.nombre}  [${mu.equivalente}]`);
      log(`  EQUIVALENTE  ${mu.nombre}\n      ${mu.equivalente}`);
    } else {
      resumen.sobreviven.push(mu.nombre);
      log(`  SOBREVIVE  ${mu.nombre}`);
    }
  }
  log(`\nDETECTADAS: ${resumen.detectadas}   EQUIVALENTES: ${resumen.equivalentes}   SOBREVIVEN: ${resumen.sobreviven.length}   ERRORES: ${resumen.errores.length}`);
  if (resumen.sobreviven.length) { log('\nSOBREVIVEN (falta una prueba):'); resumen.sobreviven.forEach((s) => log('  - ' + s)); }
  if (resumen.errores.length) { log('\nERRORES DE DEFINICION:'); resumen.errores.forEach((s) => log('  - ' + s)); }
  return resumen;
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { sonda, baseConSql13 } = await import('./datos-restaurante.mjs');
  const SQL15 = () => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', '15-datos-restaurante.sql'), 'utf8');
  const r = await correrMutaciones({ sonda, baseConSql13, SQL15 });
  process.exitCode = r.sobreviven.length || r.errores.length ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}
