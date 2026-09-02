-- =============================================================
-- LOS TAQUEIROS 2.0 — Esquema de la base de datos de pedidos
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
-- =============================================================

-- 1) TABLA DE PEDIDOS ------------------------------------------------
create table if not exists public.pedidos (
  id                bigint generated always as identity primary key,

  -- Referencia unica que viaja a Wompi (ej: TAQ-1788325338685).
  -- Es la llave que enlaza el pedido con el webhook de pago.
  referencia        text not null unique,

  -- Ciclo de vida del pedido dentro de la cocina
  estado            text not null default 'pendiente_pago'
                    check (estado in ('pendiente_pago','nuevo','en_preparacion','listo','entregado','cancelado')),

  -- Datos del cliente
  cliente_nombre    text not null,
  cliente_telefono  text not null,
  cliente_email     text,

  -- Entrega
  tipo_pedido       text not null
                    check (tipo_pedido in ('domicilio','llevar','local')),
  direccion         text,
  barrio            text,
  indicaciones      text,

  -- Productos: [{ id, nombre, cantidad, precio }]
  items             jsonb not null,

  -- Total en pesos colombianos (entero, sin decimales)
  total             integer not null check (total > 0),

  -- Pago
  estado_pago       text not null default 'pendiente'
                    check (estado_pago in ('pendiente','aprobado','rechazado','error','anulado')),
  wompi_transaction_id text,
  wompi_metodo_pago    text,
  wompi_ambiente       text,

  -- Tiempos
  creado_en         timestamptz not null default now(),
  pagado_en         timestamptz,
  actualizado_en    timestamptz not null default now()
);

-- Indices para las consultas del panel
create index if not exists pedidos_estado_idx     on public.pedidos (estado);
create index if not exists pedidos_creado_en_idx  on public.pedidos (creado_en desc);
create index if not exists pedidos_referencia_idx on public.pedidos (referencia);

-- 2) actualizado_en se refresca solo en cada UPDATE -------------------
create or replace function public.tocar_actualizado_en()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$;

drop trigger if exists pedidos_actualizado_en on public.pedidos;
create trigger pedidos_actualizado_en
  before update on public.pedidos
  for each row execute function public.tocar_actualizado_en();

-- 3) SEGURIDAD (RLS) --------------------------------------------------
-- Se activa RLS, pero las POLITICAS estan en seguridad.sql.
--
-- IMPORTANTE: ejecuta tambien supabase/seguridad.sql. Sin el, la
-- tabla queda con RLS activo y sin politicas, o sea: el panel no
-- podra leer nada (el servidor si, porque service_role se salta RLS).
--
-- Las politicas viven aparte porque restringen el acceso a una lista
-- explicita de personal autorizado, en vez de confiar en el rol
-- 'authenticated' (que en Supabase incluye a cualquiera que se
-- registre por su cuenta si el registro publico esta abierto).
alter table public.pedidos enable row level security;

-- 4) REALTIME ---------------------------------------------------------
-- Permite que el panel reciba los pedidos nuevos sin recargar.
-- (envuelto para que el script se pueda re-ejecutar sin dar error)
do $$
begin
  alter publication supabase_realtime add table public.pedidos;
exception
  when duplicate_object then null;
end;
$$;
