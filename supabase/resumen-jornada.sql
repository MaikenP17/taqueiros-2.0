-- =============================================================
-- LOS TAQUEIROS 2.0 — Resumen de la jornada
-- Ejecutar DESPUES de jornada.sql
--
-- Todos los calculos se hacen agregados EN LA BASE. No se traen los
-- pedidos al navegador para sumarlos alli: es lento, gasta datos y
-- empeora a medida que crece el historial.
--
-- QUE CUENTA Y QUE NO
-- Las ventas SOLO incluyen pedidos con el pago aprobado. Un pedido
-- cancelado o que nunca se pago no suma un peso. Los cancelados se
-- reportan aparte, como cuenta, nunca dentro del dinero.
--
-- Seguro de re-ejecutar.
-- =============================================================

create or replace function public.resumen_jornada(fecha date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim record;
  r   jsonb;
begin
  select * into lim from public.limites_jornada(fecha);

  with
  /* Base: solo lo que de verdad se vendio.
     'aprobado' es el pago confirmado por Wompi. Un pedido cancelado
     por la cocina DESPUES de cobrado sigue siendo dinero recibido,
     por eso se excluye por estado, no por estado_pago. */
  vendidos as (
    select *
    from public.pedidos
    where creado_en >= lim.inicio
      and creado_en <  lim.fin
      and estado_pago = 'aprobado'
      and estado <> 'cancelado'
  ),
  cancelados as (
    select count(*) as n
    from public.pedidos
    where creado_en >= lim.inicio
      and creado_en <  lim.fin
      and estado = 'cancelado'
  ),
  totales as (
    select
      coalesce(sum(total), 0)           as ventas_total,
      coalesce(sum(subtotal), 0)        as ventas_productos,
      coalesce(sum(costo_domicilio), 0) as ventas_domicilios,
      count(*)                          as num_pedidos,
      coalesce(round(avg(total)), 0)    as ticket_promedio
    from vendidos
  ),
  /* Producto mas vendido: se despliega el jsonb de items y se suman
     las cantidades. Se hace aqui y no en el navegador para no traer
     todos los pedidos completos. */
  productos as (
    select
      it->>'nombre' as nombre,
      sum((it->>'cantidad')::int) as unidades
    from vendidos, jsonb_array_elements(items) as it
    group by 1
    order by 2 desc
    limit 5
  ),
  /* Pedidos por hora, en hora de Colombia. Sirve para ver la hora
     pico de un vistazo. */
  por_hora as (
    select
      extract(hour from (creado_en at time zone 'America/Bogota'))::int as hora,
      count(*) as pedidos,
      sum(total) as ventas
    from vendidos
    group by 1
    order by 1
  )
  select jsonb_build_object(
    'jornada',           lim.jornada,
    'inicio',            lim.inicio,
    'fin',               lim.fin,
    'ventas_total',      t.ventas_total,
    'ventas_productos',  t.ventas_productos,
    'ventas_domicilios', t.ventas_domicilios,
    'num_pedidos',       t.num_pedidos,
    'ticket_promedio',   t.ticket_promedio,
    'cancelados',        (select n from cancelados),
    'top_productos',     coalesce((select jsonb_agg(jsonb_build_object('nombre', nombre, 'unidades', unidades)) from productos), '[]'::jsonb),
    'por_hora',          coalesce((select jsonb_agg(jsonb_build_object('hora', hora, 'pedidos', pedidos, 'ventas', ventas)) from por_hora), '[]'::jsonb)
  )
  into r
  from totales t;

  return r;
end;
$$;

revoke all on function public.resumen_jornada(date) from public;
grant execute on function public.resumen_jornada(date) to authenticated;


-- ---------------------------------------------------------------
-- BUSQUEDA EN EL HISTORIAL
-- Filtra en la base y devuelve como maximo 100 filas. Solo lectura:
-- desde el historial no se edita ni se borra nada.
-- ---------------------------------------------------------------
create or replace function public.buscar_historial(
  fecha_desde date default null,
  fecha_hasta date default null,
  telefono    text default null,
  referencia  text default null
)
returns setof public.pedidos
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.pedidos p
  where p.estado <> 'pendiente_pago'          -- los no pagados no son historia
    and (fecha_desde is null
         or public.jornada_de(p.creado_en, (select hora_corte_jornada from public.configuracion where id = 1)) >= fecha_desde)
    and (fecha_hasta is null
         or public.jornada_de(p.creado_en, (select hora_corte_jornada from public.configuracion where id = 1)) <= fecha_hasta)
    and (telefono is null or telefono = '' or p.cliente_telefono like '%' || telefono || '%')
    and (referencia is null or referencia = '' or p.referencia ilike '%' || referencia || '%')
  order by p.creado_en desc
  limit 100;
$$;

revoke all on function public.buscar_historial(date, date, text, text) from public;
grant execute on function public.buscar_historial(date, date, text, text) to authenticated;


-- ---------------------------------------------------------------
-- JORNADAS QUE TIENEN PEDIDOS
-- Para el selector de fecha del historial: solo se ofrecen dias en
-- los que de verdad hubo movimiento.
-- ---------------------------------------------------------------
create or replace function public.jornadas_con_pedidos(limite integer default 60)
returns table (jornada date, pedidos bigint, ventas bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    public.jornada_de(creado_en, (select hora_corte_jornada from public.configuracion where id = 1)) as jornada,
    count(*) filter (where estado <> 'pendiente_pago') as pedidos,
    coalesce(sum(total) filter (where estado_pago = 'aprobado' and estado <> 'cancelado'), 0) as ventas
  from public.pedidos
  where estado <> 'pendiente_pago'
  group by 1
  order by 1 desc
  limit limite;
$$;

revoke all on function public.jornadas_con_pedidos(integer) from public;
grant execute on function public.jornadas_con_pedidos(integer) to authenticated;


-- ---------------------------------------------------------------
-- COMPROBACION
-- ---------------------------------------------------------------
select public.resumen_jornada();
select * from public.jornadas_con_pedidos(10);
