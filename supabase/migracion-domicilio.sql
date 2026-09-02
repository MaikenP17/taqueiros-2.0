-- =============================================================
-- LOS TAQUEIROS 2.0 — Columnas para el domicilio con mapa
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- Seguro de re-ejecutar: usa "if not exists" en todo.
-- No borra ni modifica ningun pedido existente.
-- =============================================================

alter table public.pedidos
  -- Valor de los productos, SIN el domicilio.
  -- Los pedidos viejos no lo tienen, por eso se rellenan abajo.
  add column if not exists subtotal integer,

  -- Lo que se cobro por llevar el pedido. 0 si es para llevar,
  -- en el local, o si quedo fuera de cobertura (se acuerda aparte).
  add column if not exists costo_domicilio integer not null default 0,

  -- Distancia aproximada de recorrido en kilometros (1 decimal).
  add column if not exists distancia_km numeric(5,1),

  -- Ubicacion exacta que marco el cliente en el mapa. Sirve para
  -- que el domiciliario abra Google Maps desde el panel.
  add column if not exists lat numeric(10,7),
  add column if not exists lng numeric(10,7),

  -- true = el cliente esta a mas de 8 km. El domicilio no se cobro
  -- en linea y hay que coordinarlo por WhatsApp.
  add column if not exists fuera_de_cobertura boolean not null default false;

-- Los pedidos creados antes de esta migracion no tenian desglose:
-- su total eran solo productos, asi que subtotal = total.
update public.pedidos
set subtotal = total
where subtotal is null;

-- A partir de aqui, todo pedido nuevo llega con subtotal.
alter table public.pedidos
  alter column subtotal set not null;

-- Coherencia: el total siempre debe ser productos + domicilio.
-- Si algun dia una consulta manual se equivoca, la base lo rechaza.
alter table public.pedidos
  drop constraint if exists pedidos_total_cuadra;

alter table public.pedidos
  add constraint pedidos_total_cuadra
  check (total = subtotal + costo_domicilio);

-- Comprobacion: muestra la estructura resultante.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'pedidos'
  and column_name in ('subtotal','costo_domicilio','distancia_km','lat','lng','fuera_de_cobertura','total')
order by column_name;
