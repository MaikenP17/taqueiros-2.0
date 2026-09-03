-- =============================================================
-- LOS TAQUEIROS 2.0 — Limpieza de pedidos que nunca se pagaron
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- DE DONDE SALEN ESTOS REGISTROS
-- El pedido se guarda ANTES de pagar (estado 'pendiente_pago') para
-- que el webhook sepa que productos pidio el cliente. Si el cliente
-- se arrepiente, le rechazan la tarjeta o cierra la pestana, esa
-- fila queda ahi para siempre. Con reintentos se acumulan varias
-- por un mismo pedido real.
--
-- No estorban al panel (que filtra 'pendiente_pago'), pero con el
-- tiempo llenan la base del plan gratuito.
--
-- IMPORTANTE: solo se borran los que llevan mas de 24 horas sin
-- pagarse. Nunca se toca un pedido pagado.
-- =============================================================

-- 1) FUNCION DE LIMPIEZA --------------------------------------------
create or replace function public.limpiar_pedidos_huerfanos(horas integer default 24)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  borrados integer;
begin
  delete from public.pedidos
  where estado = 'pendiente_pago'
    and estado_pago = 'pendiente'      -- doble seguro: nunca se aprobo
    and pagado_en is null              -- triple seguro: nunca se pago
    and creado_en < now() - (horas || ' hours')::interval;

  get diagnostics borrados = row_count;
  return borrados;
end;
$$;

-- Solo el servidor puede ejecutarla. Ni anon ni el panel.
revoke all on function public.limpiar_pedidos_huerfanos(integer) from public;


-- 2) VER CUANTOS HAY AHORA MISMO ------------------------------------
select
  count(*) filter (where estado = 'pendiente_pago')                        as sin_pagar_total,
  count(*) filter (where estado = 'pendiente_pago'
                     and creado_en < now() - interval '24 hours')          as sin_pagar_viejos,
  count(*) filter (where estado <> 'pendiente_pago')                       as pedidos_reales
from public.pedidos;


-- 3) EJECUTAR LA LIMPIEZA A MANO (opcional) -------------------------
-- Descomenta esta linea para borrarlos ahora mismo:
-- select public.limpiar_pedidos_huerfanos(24) as borrados;
