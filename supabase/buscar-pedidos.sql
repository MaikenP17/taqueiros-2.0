-- =============================================================
-- LOS TAQUEIROS 2.0 — Recuperar el link de seguimiento
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- EL PROBLEMA
-- Si el cliente cierra la pestana sin guardar el link, pierde el
-- acceso a su pedido.
--
-- POR QUE NO BASTA CON EL TELEFONO
-- Una referencia (TAQ-<ms>-<6 al azar>) es imposible de adivinar,
-- pero un celular colombiano SI: empieza por 3 y tiene 10 digitos.
-- Alguien podria probar numeros y ver pedidos ajenos.
--
-- COMO SE BLINDA
--   * Exige el telefono Y el total exacto que se pago.
--   * Solo mira las ultimas 24 horas.
--   * Devuelve como maximo 5 filas.
--   * NUNCA devuelve direccion, correo, indicaciones ni productos:
--     solo lo justo para reconocer el pedido y abrir su seguimiento.
--   * Ignora los pedidos que nunca se pagaron.
--
-- El RLS de la tabla no se toca: 'anon' sigue sin poder leer
-- 'pedidos' directamente.
-- =============================================================

create or replace function public.buscar_mis_pedidos(
  telefono      text,
  total_pagado  integer
)
returns table (
  numero      bigint,
  referencia  text,
  estado      text,
  tipo_pedido text,
  total       integer,
  creado_en   timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    p.id,
    p.referencia,
    p.estado,
    p.tipo_pedido,
    p.total,
    p.creado_en
  from public.pedidos p
  where p.cliente_telefono = telefono          -- coincidencia exacta
    and p.total = total_pagado                 -- segundo factor
    and p.estado <> 'pendiente_pago'           -- los no pagados no existen
    and p.creado_en > now() - interval '24 hours'
  order by p.creado_en desc
  limit 5;
$$;

-- Nadie por defecto...
revoke all on function public.buscar_mis_pedidos(text, integer) from public;
-- ...solo los visitantes de la pagina.
grant execute on function public.buscar_mis_pedidos(text, integer) to anon, authenticated;


-- ---------------------------------------------------------------
-- COMPROBACION
--   Con datos correctos devuelve el pedido:
--     select * from public.buscar_mis_pedidos('3125249438', 49000);
--   Con el total equivocado NO devuelve nada:
--     select * from public.buscar_mis_pedidos('3125249438', 1000);
-- ---------------------------------------------------------------
