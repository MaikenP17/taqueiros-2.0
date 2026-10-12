-- =============================================================
-- LOS TAQUEIROS 2.0 — Impresion automatica de comandas
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- PARA QUE SIRVE
--   El panel imprime solo la comanda de cada pedido web pagado en la
--   impresora termica de la cocina. Para que NUNCA salga dos veces
--   (dos pantallas abiertas, recargas, reconexiones) la base guarda
--   el momento de impresion y lo entrega UNA sola vez: la primera
--   pantalla que lo pide lo gana, las demas reciben 'false'.
--
-- QUE HACE
--   1. Agrega a 'pedidos': impreso_en, reimpresiones, reimpreso_en.
--   2. Crea reclamar_impresion(id): marca impreso solo si todavia
--      era nulo. Devuelve true UNA vez; despues, siempre false.
--   3. Crea registrar_reimpresion(id): cuenta las reimpresiones
--      sin tocar la marca de impresion original.
--   4. Solo el personal autorizado puede llamarlas. 'anon' no.
--
-- QUE NO HACE
--   * No cambia ninguna politica RLS de 'pedidos'.
--   * No toca dinero, pago, items, estados ni jornadas.
--   * No expone datos de clientes a nadie nuevo: las funciones solo
--     devuelven un booleano y un entero. 'seguimiento()' enumera sus
--     columnas, asi que las nuevas no salen en la pagina publica.
--
-- PEDIDOS ANTERIORES
--   Al crear las columnas por PRIMERA vez, los pedidos pagados que ya
--   existen se marcan como ya impresos (la cocina los imprimio desde
--   el POS). Sin esto, el primer panel que se abra intentaria
--   imprimir todo lo de la jornada. Si el script se vuelve a correr,
--   esto NO se repite: no marca pedidos nuevos como impresos.
--
-- Seguro de re-ejecutar (idempotente). Requiere haber corrido antes
-- schema.sql y seguridad.sql (es_personal, politicas, trigger de pago).
--
-- Al final devuelve una tabla de comprobacion: todas las filas
-- deben decir 'OK'. Si alguna dice REVISAR, copia el resultado.
-- =============================================================


-- 1) COLUMNAS ----------------------------------------------------------
-- Todo en un bloque: el relleno de pedidos viejos solo ocurre si la
-- columna 'impreso_en' no existia, o sea, la primera vez.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pedidos'
      and column_name = 'impreso_en'
  ) then
    alter table public.pedidos
      -- Cuando se imprimio la comanda automatica. null = pendiente.
      add column impreso_en timestamptz;

    -- Lo que ya estaba pagado antes de esta migracion se da por impreso.
    update public.pedidos
       set impreso_en = coalesce(pagado_en, creado_en)
     where impreso_en is null
       and estado <> 'pendiente_pago';
  end if;
end;
$$;

alter table public.pedidos
  -- Cuantas veces se reimprimio desde el boton "Reimprimir".
  add column if not exists reimpresiones integer not null default 0,
  -- La ultima reimpresion. No altera 'impreso_en'.
  add column if not exists reimpreso_en timestamptz;


-- 2) RECLAMAR LA IMPRESION (atomica) -----------------------------------
-- Un solo UPDATE condicional: 'impreso_en is null' se evalua DENTRO
-- de la misma sentencia que escribe. Si dos pantallas llegan a la vez,
-- Postgres las pone en fila sobre la fila del pedido; la segunda ve el
-- valor ya escrito, no cumple la condicion y devuelve 0 filas.
--
-- Corre como quien la llama (SECURITY INVOKER, el valor por defecto) a
-- proposito: asi siguen aplicando la politica RLS "personal actualiza
-- pedidos" y el trigger que protege los campos de pago. Ver la nota
-- de seguridad.sql: con SECURITY DEFINER ese trigger dejaria pasar todo.
-- La revision de es_personal() de abajo es explicita para que quien no
-- sea personal reciba un error claro y no un 'false' silencioso.
create or replace function public.reclamar_impresion(p_id bigint)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_filas integer;
begin
  if not public.es_personal() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  update public.pedidos
     set impreso_en = now()
   where id = p_id
     and impreso_en is null
     and estado_pago = 'aprobado'
     and estado in ('nuevo', 'en_preparacion', 'listo');

  get diagnostics v_filas = row_count;
  return v_filas = 1;
end;
$$;

revoke all on function public.reclamar_impresion(bigint) from public;
revoke all on function public.reclamar_impresion(bigint) from anon;
grant execute on function public.reclamar_impresion(bigint) to authenticated;


-- 3) REGISTRAR UNA REIMPRESION -----------------------------------------
-- Solo cuenta. No toca 'impreso_en': la marca original se conserva.
-- Se permite en cualquier estado menos 'pendiente_pago' (reimprimir un
-- pedido entregado o cancelado es legitimo).
create or replace function public.registrar_reimpresion(p_id bigint)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_total integer;
begin
  if not public.es_personal() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  update public.pedidos
     set reimpresiones = reimpresiones + 1,
         reimpreso_en  = now()
   where id = p_id
     and estado <> 'pendiente_pago'
  returning reimpresiones into v_total;

  return v_total;   -- null si el pedido no existe o no esta pagado
end;
$$;

revoke all on function public.registrar_reimpresion(bigint) from public;
revoke all on function public.registrar_reimpresion(bigint) from anon;
grant execute on function public.registrar_reimpresion(bigint) to authenticated;


-- 4) COMPROBACION ------------------------------------------------------
-- Todas las filas deben decir OK.
select * from (
  select 'columnas impreso_en, reimpresiones y reimpreso_en existen' as comprobacion,
         case when (select count(*) from information_schema.columns
                    where table_schema = 'public' and table_name = 'pedidos'
                      and column_name in ('impreso_en','reimpresiones','reimpreso_en')) = 3
              then 'OK' else 'REVISAR' end as estado
  union all
  select 'funcion reclamar_impresion existe',
         case when to_regprocedure('public.reclamar_impresion(bigint)') is not null
              then 'OK' else 'REVISAR' end
  union all
  select 'funcion registrar_reimpresion existe',
         case when to_regprocedure('public.registrar_reimpresion(bigint)') is not null
              then 'OK' else 'REVISAR' end
  union all
  select 'reclamar_impresion corre como quien llama (no SECURITY DEFINER)',
         case when exists (select 1 from pg_proc
                           where oid = to_regprocedure('public.reclamar_impresion(bigint)')
                             and prosecdef = false)
              then 'OK' else 'REVISAR' end
  union all
  select 'registrar_reimpresion corre como quien llama (no SECURITY DEFINER)',
         case when exists (select 1 from pg_proc
                           where oid = to_regprocedure('public.registrar_reimpresion(bigint)')
                             and prosecdef = false)
              then 'OK' else 'REVISAR' end
  union all
  select 'anon NO puede ejecutar reclamar_impresion',
         case when to_regprocedure('public.reclamar_impresion(bigint)') is not null
               and not has_function_privilege('anon', 'public.reclamar_impresion(bigint)', 'execute')
              then 'OK' else 'REVISAR' end
  union all
  select 'anon NO puede ejecutar registrar_reimpresion',
         case when to_regprocedure('public.registrar_reimpresion(bigint)') is not null
               and not has_function_privilege('anon', 'public.registrar_reimpresion(bigint)', 'execute')
              then 'OK' else 'REVISAR' end
  union all
  select 'el personal (authenticated) SI puede ejecutar ambas',
         case when to_regprocedure('public.reclamar_impresion(bigint)') is not null
               and to_regprocedure('public.registrar_reimpresion(bigint)') is not null
               and has_function_privilege('authenticated', 'public.reclamar_impresion(bigint)', 'execute')
               and has_function_privilege('authenticated', 'public.registrar_reimpresion(bigint)', 'execute')
              then 'OK' else 'REVISAR' end
  union all
  select 'RLS sigue activo en pedidos',
         case when (select rowsecurity from pg_tables
                    where schemaname = 'public' and tablename = 'pedidos')
              then 'OK' else 'REVISAR' end
  union all
  select 'pedidos no tiene ninguna politica que alcance a anon',
         case when not exists (
           select 1 from pg_policies
           where schemaname = 'public' and tablename = 'pedidos'
             and (roles && array['anon'::name, 'public'::name])
         ) then 'OK' else 'REVISAR' end
  union all
  select 'el trigger que protege el dinero sigue activo',
         case when exists (select 1 from pg_trigger
                           where tgname = 'pedidos_proteger_pago'
                             and tgrelid = 'public.pedidos'::regclass
                             and not tgisinternal)
              then 'OK' else 'REVISAR' end
) t;
