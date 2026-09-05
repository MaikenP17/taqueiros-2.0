-- =============================================================
-- LOS TAQUEIROS 2.0 — La jornada de trabajo
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- QUE RESUELVE
-- El tablero de comandas acumulaba pedidos desde el primer dia. Debe
-- ser una superficie de TRABAJO, no un archivo: lo que ya paso sale
-- de la vista, pero NUNCA de la base.
--
-- NADA DE ESTO BORRA UN PEDIDO. Solo se deja de pintarlo.
-- (La limpieza de huerfanos, que si borra, es otra cosa: solo toca
--  pedidos que nunca se pagaron. Ver limpieza-huerfanos.sql)
--
-- Seguro de re-ejecutar.
-- =============================================================


-- 1) CUANDO CAMBIO DE ESTADO -----------------------------------------
-- Hacia falta: no existia ninguna columna con ese dato.
--
-- 'actualizado_en' NO sirve para esto: su trigger se dispara con
-- CUALQUIER cambio en la fila, asi que un pedido entregado hace dias
-- puede tener 'actualizado_en' de hoy si algo lo toco.
--
-- 'creado_en' tampoco: un pedido creado a las 6 y entregado a las 8
-- se ocultaria al instante.
alter table public.pedidos
  add column if not exists estado_cambiado_en timestamptz;

create or replace function public.marcar_cambio_de_estado()
returns trigger
language plpgsql
as $$
begin
  -- Solo cuando el estado cambia de verdad
  if TG_OP = 'INSERT' or new.estado is distinct from old.estado then
    new.estado_cambiado_en = now();
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_cambio_estado on public.pedidos;
create trigger pedidos_cambio_estado
  before insert or update on public.pedidos
  for each row execute function public.marcar_cambio_de_estado();

-- Para los pedidos que ya existen se usa 'actualizado_en' como la
-- mejor aproximacion disponible. Es una estimacion, no un dato real:
-- de aqui en adelante si sera exacto.
update public.pedidos
set estado_cambiado_en = coalesce(actualizado_en, pagado_en, creado_en)
where estado_cambiado_en is null;


-- 2) CONFIGURACION DE LA JORNADA -------------------------------------
alter table public.configuracion
  -- Hora a la que "empieza el dia" para el restaurante.
  -- Las 5 a.m. porque la jornada no va de medianoche a medianoche:
  -- un pedido de las 12:30 a.m. pertenece a la noche anterior. El
  -- local cierra a las 22:00, asi que a las 5 a.m. no hay nadie
  -- trabajando y el corte no interrumpe ningun servicio.
  add column if not exists hora_corte_jornada time not null default '05:00',

  -- Cuanto se queda en pantalla un pedido ya entregado o cancelado
  -- antes de salir solo del tablero.
  add column if not exists minutos_ocultar_terminados integer not null default 15;


-- 3) A QUE JORNADA PERTENECE UN MOMENTO ------------------------------
-- OJO CON LA ZONA HORARIA: Supabase guarda todo en UTC y Cucuta es
-- UTC-5. Filtrar "hoy" en UTC haria que la medianoche UTC cayera a
-- las 7 de la noche en Colombia, y el tablero se limpiaria solo en
-- plena cena. Por eso TODO el calculo pasa por 'America/Bogota'.
create or replace function public.jornada_de(momento timestamptz, corte time)
returns date
language sql
immutable
as $$
  select (
    (momento at time zone 'America/Bogota')
    - make_interval(hours => extract(hour from corte)::int,
                    mins  => extract(minute from corte)::int)
  )::date;
$$;

-- Limites de una jornada, ya en UTC para poder comparar con las
-- columnas de la tabla.
create or replace function public.limites_jornada(fecha date default null)
returns table (
  jornada           date,
  inicio            timestamptz,
  fin               timestamptz,
  corte             time,
  minutos_ocultar   integer
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select hora_corte_jornada as corte,
           minutos_ocultar_terminados as mins
    from public.configuracion where id = 1
  ),
  elegida as (
    select coalesce(fecha, public.jornada_de(now(), (select corte from cfg))) as d,
           (select corte from cfg) as corte,
           (select mins from cfg) as mins
  )
  select
    e.d,
    ((e.d + e.corte) at time zone 'America/Bogota'),
    ((e.d + 1 + e.corte) at time zone 'America/Bogota'),
    e.corte,
    e.mins
  from elegida e;
$$;

revoke all on function public.limites_jornada(date) from public;
grant execute on function public.limites_jornada(date) to authenticated;


-- 4) COMPROBACION ----------------------------------------------------
select * from public.limites_jornada();

-- A que jornada pertenece cada pedido (para verlo con los ojos)
select
  id,
  estado,
  (creado_en at time zone 'America/Bogota') as creado_hora_colombia,
  public.jornada_de(creado_en, '05:00') as jornada
from public.pedidos
order by id desc
limit 20;
