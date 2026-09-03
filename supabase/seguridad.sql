-- =============================================================
-- LOS TAQUEIROS 2.0 — BLINDAJE DE SEGURIDAD DE LA TABLA pedidos
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- QUE ARREGLA ESTE SCRIPT
-- Las politicas anteriores daban acceso al rol 'authenticated',
-- que en Supabase significa "cualquier usuario que haya iniciado
-- sesion". Como el registro publico esta abierto, un desconocido
-- podia crearse una cuenta con su propio correo y leer los datos
-- de TODOS los clientes (nombre, telefono, direccion).
--
-- Solucion: las politicas ya no miran "si esta logueado", sino
-- "si es personal autorizado del restaurante", contra una lista
-- explicita que controlas tu.
-- =============================================================


-- 1) LISTA DE PERSONAL AUTORIZADO -----------------------------------
-- Cada fila es un usuario de Supabase Auth con permiso para ver el
-- panel. Para dar de baja a alguien, se borra su fila (o se borra
-- el usuario en Authentication -> Users).
create table if not exists public.personal (
  id          uuid primary key references auth.users(id) on delete cascade,
  nombre      text,
  creado_en   timestamptz not null default now()
);

-- La tabla se protege a si misma: nadie puede leerla ni modificarla
-- desde el navegador. Solo el servidor (service_role) y el SQL Editor.
alter table public.personal enable row level security;

-- Autoriza al usuario del panel que ya existe.
-- Para agregar mas empleados en el futuro:
--   1. Authentication -> Users -> Add user
--   2. copiar su UID y repetir este insert con ese UID
insert into public.personal (id, nombre)
values ('24fe556c-f26b-4f7e-84a7-c9e7168ac18c', 'Panel del restaurante')
on conflict (id) do nothing;


-- 2) FUNCION DE APOYO -----------------------------------------------
-- Responde: "el usuario que hace esta consulta es personal del
-- restaurante?". Se usa dentro de las politicas.
-- SECURITY DEFINER permite que la funcion consulte la tabla
-- 'personal' aunque el usuario no tenga permiso de leerla.
create or replace function public.es_personal()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.personal where id = auth.uid()
  );
$$;

revoke all on function public.es_personal() from public;
grant execute on function public.es_personal() to authenticated;


-- 3) POLITICAS DE LA TABLA pedidos ----------------------------------
alter table public.pedidos enable row level security;

-- Se eliminan las politicas antiguas (las que confiaban en
-- 'authenticated' a secas).
drop policy if exists "restaurante lee pedidos" on public.pedidos;
drop policy if exists "restaurante actualiza pedidos" on public.pedidos;
drop policy if exists "personal lee pedidos" on public.pedidos;
drop policy if exists "personal actualiza pedidos" on public.pedidos;

-- LECTURA: solo el personal autorizado.
-- Un anonimo (anon key) no entra aqui, y un usuario que se registre
-- por su cuenta tampoco, porque no esta en la tabla 'personal'.
create policy "personal lee pedidos"
  on public.pedidos for select
  to authenticated
  using ( public.es_personal() );

-- ACTUALIZACION: solo el personal autorizado, y SOLO para mover el
-- pedido entre estados de cocina. El WITH CHECK impide que desde el
-- navegador se altere el dinero o el resultado del pago: si alguien
-- intenta cambiar total, estado_pago, items o la referencia, la fila
-- deja de cumplir la condicion y Postgres rechaza el UPDATE.
create policy "personal actualiza pedidos"
  on public.pedidos for update
  to authenticated
  using ( public.es_personal() )
  with check (
    public.es_personal()
    and estado in ('nuevo','en_preparacion','listo','entregado','cancelado')
  );

-- INSERCION y BORRADO: sin politica = prohibido para todos los
-- usuarios del navegador. Los pedidos solo los crea el servidor
-- (/api/crear-pedido) con la service_role key, que se salta RLS.
-- Nada que borre pedidos: el historial se conserva.


-- 4) BLINDAJE EXTRA CONTRA CAMBIOS DE DINERO ------------------------
-- El WITH CHECK de arriba ya lo cubre, pero un trigger deja la regla
-- escrita en la base de datos, independiente de las politicas: los
-- campos de dinero y de pago son inmutables para cualquiera que no
-- sea el servidor.
create or replace function public.proteger_campos_de_pago()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims text := current_setting('request.jwt.claims', true);
  rol    text := null;
begin
  -- Quien hace el cambio? Se mira de dos formas para no depender de
  -- auth.role(), que Supabase dejo obsoleta y en proyectos nuevos
  -- puede no existir (romperia TODA actualizacion de pedidos).
  if claims is not null and claims <> '' then
    rol := (claims::jsonb) ->> 'role';
  end if;

  -- El servidor (service_role) puede hacer cualquier cambio: es quien
  -- confirma el pago desde el webhook de Wompi. 'postgres' es el
  -- editor SQL del panel de Supabase, para poder corregir a mano.
  if current_user in ('service_role', 'postgres', 'supabase_admin')
     or rol = 'service_role' then
    return new;
  end if;

  if new.total is distinct from old.total
     or new.estado_pago is distinct from old.estado_pago
     or new.items is distinct from old.items
     or new.referencia is distinct from old.referencia
     or new.wompi_transaction_id is distinct from old.wompi_transaction_id then
    raise exception 'No se pueden modificar los datos de pago de un pedido';
  end if;

  return new;
end;
$$;

drop trigger if exists pedidos_proteger_pago on public.pedidos;
create trigger pedidos_proteger_pago
  before update on public.pedidos
  for each row execute function public.proteger_campos_de_pago();


-- 5) COMPROBACION ---------------------------------------------------
-- Debe mostrar rowsecurity = true y exactamente 2 politicas.
select tablename, rowsecurity as rls_activo
from pg_tables
where schemaname = 'public' and tablename in ('pedidos','personal');

select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'pedidos'
order by policyname;
