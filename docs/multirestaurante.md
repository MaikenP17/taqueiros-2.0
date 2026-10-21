# Multi-restaurante: base de datos (SQL 10) y servidor (SQL 11 + api/)

Taqueiros 2.0 se va a vender como servicio: **una sola base de datos y un solo despliegue para muchos
restaurantes**, con aislamiento estricto de datos. Este documento describe la base ya preparada para eso
(`supabase/10-multirestaurante.sql`), qué había antes, qué decisiones se tomaron y cómo se verifica.

> **Alcance.** Las secciones 1 a 11 describen la base de datos y la seguridad (SQL 10, ya ejecutado y verificado
> en Supabase real). La **sección 12** describe el paso siguiente, ya hecho: el **servidor** (`api/*.js`) sabe de
> qué restaurante es cada petición, filtra siempre por él, usa sus propios secretos y respeta su estado de
> servicio (más `supabase/11-dominios.sql`). La **sección 14** es el paso después: el **frontend público**
> (`index.html`, `pedido.html`, manifest, número de pedido) lee los datos de cada restaurante en vez de llevar los de
> Taqueiros escritos (más `supabase/12-config-publica.sql`). La **sección 15** es el paso después: las páginas **privadas** del
> personal (`panel.html`, `menu-admin.html`, `historial.html`, el pie del ticket, `sw.js`) trabajan solo con el restaurante de su
> dominio, con la membresía verificada y con la marca del restaurante (sin SQL nuevo). Siguen pendientes la interfaz de administración
> (formulario de configuración, superadmin) y retirar los valores por defecto transitorios de la base (sección 7).

Contenido: 1. Inventario anterior · 2. Diseño nuevo · 3. Matriz de permisos · 4. Decisiones ·
5. Qué se conserva para no romper nada · 6. Orden de pasos en Windows · 7. Lo que queda para el siguiente paso ·
8. Qué se probó y qué no · 9. Riesgos · 10. Revisión de seguridad del SQL 10 · 11. Fallo `pg_statistic` ·
12. Servidor multi-restaurante (SQL 11 + api/) · 13. Revisión adversaria del servidor ·
14. Frontend público multi-restaurante (SQL 12) · **15. Paneles del personal por restaurante**

---

## 1. Inventario de lo que había (reconstruido del repo)

Reconstruido de `supabase/*.sql` y de todo el código que consulta la base. **El repo solo cuenta lo que se
escribió en archivos**: puede haber cosas creadas a mano en el dashboard. Para saberlo con certeza, corre
`supabase/00-inspeccion-esquema.sql` (solo lectura) antes de migrar.

### Tablas (schema `public`)

| Tabla | Para qué | Notas |
|---|---|---|
| `pedidos` | Cada pedido. `id` identity (es el número que ve el cliente y el panel), `referencia` única (`TAQ-<ms>-<hex>`), `estado`, datos del cliente, entrega, `items` jsonb, `subtotal`, `costo_domicilio`, `total`, pago (`estado_pago`, `wompi_*`), tiempos, domicilio (`distancia_km`, `lat`, `lng`, `fuera_de_cobertura`, `barrio_detectado`, `ubicacion_sospechosa`), `alerta_enviada`, `notificacion_ok`, `estado_cambiado_en`, y (SQL 02) `impreso_en`, `reimpresiones`, `reimpreso_en`. | RLS. En Realtime. Constraint `total = subtotal + costo_domicilio`. |
| `categorias` | Categorías del menú. `id` texto (PK), `nombre`, `emoji`, `orden`, `activa`. | RLS. Índice único por nombre normalizado (SQL 01). |
| `productos` | Productos. `id` texto (PK, el mismo que usa el carrito), `precio` entero, `categoria` (FK), `disponible`, `imagen`. | RLS. En Realtime. |
| `configuracion` | Una sola fila (`id = 1`): `horarios` jsonb, `cerrado_temporal`, `mensaje_cerrado`, `hora_corte_jornada` (5 a. m.), `minutos_ocultar_terminados`. | RLS. En Realtime. |
| `salud_notificaciones` | Una sola fila (`id = 1`): cómo salió el último WhatsApp automático. | RLS. En Realtime. |
| `personal` | Usuarios autorizados del panel (`id` → `auth.users`). | RLS sin políticas. **Ningún código la consulta**; solo `es_personal()`. |

No hay tabla de ítems de pedido (van en `pedidos.items`), ni de jornadas, resúmenes o historial: son **funciones**
que calculan sobre `pedidos`. Las tarifas de domicilio y las coordenadas del local están **en el código**
(`api/_domicilio.js` y `index.html`), no en la base.

### Funciones

| Función | Tipo | Quién la usa |
|---|---|---|
| `es_personal()` | SECURITY DEFINER | las políticas antiguas |
| `tocar_actualizado_en()`, `marcar_cambio_de_estado()` | trigger | `pedidos`, `productos`, `configuracion` |
| `proteger_campos_de_pago()` | trigger, **invoker a propósito** | bloquea cambios de dinero desde el navegador |
| `norm_texto()`, `validar_categoria()`, `validar_producto()` | helper / triggers (SQL 01) | menú-admin |
| `jornada_de(momento, corte)` | inmutable | jornada, historial |
| `limites_jornada(fecha)` | SECURITY DEFINER | `panel.html` |
| `resumen_jornada(fecha)`, `buscar_historial(...)`, `jornadas_con_pedidos(limite)` | SECURITY DEFINER | `historial.html` |
| `seguimiento(ref)` | SECURITY DEFINER, **anon** | `pedido.html` |
| `buscar_mis_pedidos(telefono, total)` | SECURITY DEFINER, **anon** | `index.html` |
| `limpiar_pedidos_huerfanos(horas)` | SECURITY DEFINER | cron `/api/keep-alive` (servidor) |
| `reclamar_impresion(id)`, `registrar_reimpresion(id)` | invoker (SQL 02) | `panel.html` |

### Políticas RLS (antes)

* `pedidos`: `personal lee pedidos`, `personal actualiza pedidos` (con `es_personal()`).
* `categorias` / `productos`: lectura para **anon y authenticated** (`using (true)`) + `personal edita ...`.
* `configuracion`: `personal lee / actualiza configuracion`. `salud_notificaciones`: `personal lee salud`.
* `personal`: RLS activo y sin políticas.

### Storage y Realtime

* Bucket `productos` (SQL 01): público, 2 MB, webp/jpeg/png. Cuatro políticas `productos personal sube / ve /
  reemplaza / borra` con `es_personal()`. Las fotos nuevas se suben **planas** (`p-<hex>.<ext>`); las 38 de
  origen son rutas relativas `Recursos/...` del propio sitio (no están en el bucket).
* Publicación `supabase_realtime`: `pedidos`, `productos`, `configuracion`, `salud_notificaciones`. El panel
  escucha `pedidos`, `salud_notificaciones` y `configuracion`.

### Acceso `anon` que existía

1. Lectura directa de `categorias` y `productos` (políticas `using (true)`). **Ninguna página la usa**: el sitio
   lee el menú por `/api/menu` (servidor, llave secreta).
2. Las RPC `seguimiento` y `buscar_mis_pedidos` (esas dos sí las usa el sitio).
3. **Probable, a verificar:** en Supabase, `revoke ... from public` no le quita el permiso de ejecución a `anon`
   (las funciones nuevas se le otorgan por defecto). `limites_jornada`, `resumen_jornada`, `buscar_historial`,
   `jornadas_con_pedidos` y `limpiar_pedidos_huerfanos` solo revocaban a `public`. La sección
   `funciones_que_anon_ejecuta` de la inspección lo confirma o lo descarta.

### Hallazgos de seguridad en lo que había (se cierran con el SQL 10)

* `resumen_jornada`, `buscar_historial` y `jornadas_con_pedidos` eran **SECURITY DEFINER sin comprobar quién
  llamaba** y con `EXECUTE` para `authenticated`. Con el registro público de Auth abierto, **cualquier persona con
  una cuenta recién creada podía leer nombre, teléfono y dirección de todos los clientes** (`buscar_historial`).
  Esto es independiente de multi-restaurante y está abierto en producción hasta correr el SQL 10.
* En `buscar_historial` el filtro por `referencia` nunca filtraba (el parámetro se llamaba igual que la columna y
  la columna ganaba). Ahora funciona.

### Lo que no se puede deducir del repo

Ver la sección 8 y el debrief: tablas/funciones/políticas creadas a mano, si los SQL 01 y 02 ya se corrieron,
los permisos por defecto reales de Supabase, y si hay algo más en el bucket.

---

## 2. Diseño nuevo

### Tablas nuevas (todas con RLS)

| Tabla | Contenido |
|---|---|
| `restaurantes` | `id`, `slug` único (minúsculas, números y guiones; sirve para subdominio), `nombre`, `estado` (`prueba`/`activo`/`suspendido`), `plan` (`completo`/`basico`/`comandas`), `modalidad_pago` (`mensual`/`unico`), `vigente_hasta` (nulo = sin vencimiento), `dias_gracia` (5), `modulos` jsonb (`pasarela`, `seguimiento`, `comandas`, `impresion`, todos activos), `zona_horaria` (`America/Bogota`), `hora_corte_jornada` (5 a. m.), `config` jsonb (vacío; el siguiente paso lo llena), `creado_en`. **Ninguna lógica usa plan, módulos, estado ni vigencia todavía.** |
| `restaurante_secretos` | Una fila por restaurante con las llaves de Wompi (publica/integridad/eventos, test y prod), CallMeBot (teléfono y apikey) y `otros` jsonb. **Sin políticas y sin privilegios para `anon` ni `authenticated`**: solo el servidor. Hoy esos valores viven en variables de entorno de Vercel; el siguiente paso los pasa aquí. Quedó vacía. |
| `miembros` | `(user_id, restaurante_id)` PK, `rol` (`dueno`/`cajero`/`cocina`), `activo`. Lo de `personal` pasó aquí como `dueno` de Taqueiros. |
| `superadmins` | `user_id`. Solo para Carlos. **No se agregó a nadie**: hay un `INSERT` comentado en el SQL. |
| `contadores_pedido` | Contador atómico del número de pedido por restaurante. |
| `tarifas_domicilio` | `(restaurante_id, hasta km, precio)`; `precio` nulo = fuera de cobertura. Cargada con las 5 tarifas del código (2 km $5.000 · 4 km $7.000 · 6 km $9.000 · 8 km $12.000 · +8 km fuera de cobertura). El código **sigue leyendo las suyas**. |

Taqueiros es el restaurante #1: `id = 00000000-0000-4000-8000-000000000001`, slug `taqueiros`, estado `activo`.

### `restaurante_id` en las tablas de negocio

`pedidos`, `categorias`, `productos`, `configuracion` y `salud_notificaciones` (más `tarifas_domicilio` y
`restaurante_secretos`, nuevas). Para las existentes:

* `NOT NULL`, con **valor por defecto transitorio** `restaurante_taqueiros_id()` y FK a `restaurantes`. Las filas
  existentes quedan en Taqueiros **sin ejecutar ningún UPDATE** (ni triggers, ni cambio de `actualizado_en`, ni
  eventos de Realtime).
* Índices: `pedidos (restaurante_id, creado_en desc)`, `(restaurante_id, estado)`, el parcial de alertas por
  restaurante, `categorias (restaurante_id, orden)`, `productos (restaurante_id, categoria, orden)`.
* **Únicos por restaurante:** PK de `categorias` y `productos` pasa a `(restaurante_id, id)`; `productos.categoria`
  es una FK compuesta `(restaurante_id, categoria)`, así un producto **no puede apuntar a una categoría de otro
  restaurante**; el nombre de categoría único (sin mayúsculas ni tildes) es por restaurante.
* `configuracion` y `salud_notificaciones`: la PK pasa a `restaurante_id` (una fila por restaurante). La columna
  `id` **se conserva**: Taqueiros sigue siendo `id = 1` (el código actual consulta `id=eq.1`); los demás
  restaurantes usan `id = 0`, de modo que esas consultas jamás se cruzan con otro restaurante.
* El **alta de un restaurante es automática** (trigger): crea su fila de secretos, contador, configuración
  (horario 11:00–22:00 todos los días) y salud.
* Un registro **no puede cambiar de restaurante** desde el navegador (trigger `*_restaurante_inmutable`).

### Número de pedido por restaurante

`pedidos.numero` + `contadores_pedido`. `siguiente_numero_pedido(restaurante)` hace
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`: dos pedidos simultáneos del mismo restaurante se ponen en fila
sobre la fila del contador y nunca reciben el mismo número. Un trigger lo asigna al insertar; **un cliente no
puede elegir su número**. Para Taqueiros: `numero = id` en todos los pedidos existentes (no cambia ninguno), y el
contador arranca en `max(numero, id, última_secuencia)`, así el siguiente continúa después del último. Mientras
el código siga mostrando `id`, número e id coinciden salvo que se pierda algún id por una inserción fallida
(ver riesgos). Único por `(restaurante_id, numero)`.

`pedidos.reembolsado_en` (timestamptz, nula) quedó creada y protegida contra edición desde el navegador; ningún
código la usa aún.

### Funciones auxiliares de seguridad

`es_superadmin()`, `es_miembro(restaurante_id)`, `rol_en(restaurante_id)` (más `restaurante_actual()` y
`es_servidor()`): `STABLE`, **sin SECURITY DEFINER** (leen `miembros`/`superadmins` con la identidad de quien
pregunta, y esas tablas solo le muestran **sus** filas), `search_path` vacío, nombres calificados, sin `EXECUTE`
para `PUBLIC` ni `anon`, con `EXECUTE` para `authenticated`. En las políticas se usa `(select función(...))`.

`SECURITY DEFINER` solo donde es indispensable, todas con `search_path` vacío: `siguiente_numero_pedido`,
`asignar_numero_pedido` y `aprovisionar_restaurante` (tocan tablas sin política para clientes),
`config_jornada` (verifica la membresía antes de leer la configuración), `buscar_mis_pedidos`, `seguimiento` y
`limpiar_pedidos_huerfanos` (las dos primeras son las puertas públicas, la última solo el servidor) y
`realinear_secuencia_pedidos` (solo el servidor).

### Impresión

`reclamar_impresion` y `registrar_reimpresion` **siguen sin ser SECURITY DEFINER**. Ahora además buscan el pedido
(RLS: solo ve los de su restaurante) y exigen que el usuario sea miembro de ese restaurante con rol dueño, cajero
o cocina; si no, `42501 No autorizado`. La lógica de impresión no cambió.

### Historial, jornada y resumen

Pasaron de DEFINER sin control a **funciones de quien llama** (RLS filtra a su restaurante). Reciben un parámetro
opcional `p_restaurante`; sin él usan el restaurante de la membresía del usuario, así que **el panel actual no
cambia nada**. Si alguien pide un restaurante que no es suyo recibe vacío/`null`.

### Las dos puertas públicas

`seguimiento(ref)` no cambia: referencia exacta (`TAQ-<ms>-<6 hex>`, imposible de adivinar), una fila, sin teléfono ni
correo. `buscar_mis_pedidos(telefono, total)` se acota a un restaurante y tiene **límite de intentos**: 10 consultas por
(restaurante, celular) en 24 h, guardadas en `intentos_buscar_pedido` (sin acceso para clientes). Pasado el límite
responde vacío, que el sitio ya muestra como “No encontramos pedidos”. Sin el límite, quien conoce un celular
probaba totales (pocas centenas de valores) hasta dar con la referencia y `seguimiento` le entregaba la dirección.

### Lo que la migración se niega a dejar pasar

Además de las comprobaciones de tablas y políticas, el SQL 10 se detiene (y revierte) si encuentra en `public`:
una función `SECURITY DEFINER` que no conoce y que `anon` o `authenticated` pueden llamar (aunque sea de otro dueño
y no la pueda revocar), una vista sin `security_invoker` legible por clientes, o un trigger en `auth.users` que
escriba en `personal`, `miembros` o `superadmins` (daría membresía automática a cada cuenta nueva). Además borra
**todas** las firmas de las funciones que reemplaza, y al confirmar avisa a PostgREST que recargue su esquema.

### Storage (fotos)

Rutas nuevas: `{restaurante_id}/archivo`. Políticas: solo un miembro con rol **dueño** (o superadmin) escribe,
reemplaza, lista y borra **dentro de su carpeta**; se rechaza `..`; la lectura sigue pública (bucket público).
`validar_producto` exige que la foto de un producto apunte a la carpeta de **su** restaurante.

**Las fotos existentes no se movieron**: están en la raíz del bucket y sus URLs están guardadas en
`productos.imagen`; mover archivos con SQL no mueve el archivo físico y rompería las URLs. Regla transitoria: la
raíz solo la escribe el dueño de Taqueiros (para que `menu-admin.html` siga subiendo fotos planas). Se retira en
el siguiente paso.

### Realtime

Las cuatro tablas siguen publicadas. Los eventos `INSERT`/`UPDATE` respetan RLS: cada sesión solo recibe filas que
su política de lectura le deja ver (se verifica con sesiones reales en `probar-aislamiento.mjs`). Ver el riesgo
sobre eventos `DELETE` en la sección 9.

---

## 3. Matriz de permisos

`—` = sin acceso. “Servidor” = llave secreta (Vercel, scripts). El superadmin tiene acceso a todo menos a
`restaurante_secretos` y `contadores_pedido`, que solo ve el servidor.

| Recurso | dueño | cajero | cocina | superadmin | anon |
|---|---|---|---|---|---|
| `pedidos` | leer, crear, actualizar, borrar **solo los no cobrados** | leer, crear, actualizar | leer; cambiar **solo el estado** (y marcas de impresión) | todo | — |
| `categorias`, `productos` | todo | leer | — | todo | — |
| `configuracion` | leer, actualizar | leer | — | todo (crear/borrar solo él) | — |
| `salud_notificaciones` | leer | leer | — | todo | — |
| `tarifas_domicilio` | todo | leer | — | todo | — |
| `restaurantes` | leer el suyo; editar `nombre` y `config` | leer el suyo | leer el suyo | todo | — |
| `miembros` | ver su propia fila | ídem | ídem | todo | — |
| `superadmins` | — (cada quien ve solo su fila) | — | — | su propia fila | — |
| `restaurante_secretos`, `contadores_pedido`, `intentos_buscar_pedido` | — | — | — | — | — |
| Fotos (Storage) | escribir/listar/borrar en su carpeta | — | — | todo | solo lectura pública |
| `reclamar_impresion`, `registrar_reimpresion` | su restaurante | su restaurante | su restaurante | todo | — |
| `resumen_jornada`, `buscar_historial`, `jornadas_con_pedidos`, `limites_jornada` | su restaurante | su restaurante | su restaurante | todo | — |
| `seguimiento(ref)`, `buscar_mis_pedidos(...)` | sí | sí | sí | sí | **sí** (únicas puertas públicas; la búsqueda admite 10 consultas por celular y restaurante cada 24 h) |
| `limpiar_pedidos_huerfanos`, `siguiente_numero_pedido`, `realinear_secuencia_pedidos` | — | — | — | — | — (solo servidor) |

Capas extra que no son RLS: triggers que impiden cambiar dinero/`numero`/`reembolsado_en` desde el navegador,
que el dueño cambie plan/estado/vigencia/módulos/slug, que cocina edite algo que no sea el estado, y que
cualquier registro cambie de restaurante.

---

## 4. Decisiones tomadas

1. **Slug con guiones, no guion bajo.** El slug se usará como subdominio y los hostnames no admiten `_`. Los
   restaurantes de prueba usan el prefijo `test-` (no `test_`), más el nombre `PRUEBA-AISLAMIENTO ...` para no
   confundirse nunca con uno real al limpiar.
2. **`anon` ya no toca ninguna tabla.** Se quitó la lectura pública directa de `categorias`/`productos` porque
   ninguna página la usa (el menú sale de `/api/menu`). Quedan dos funciones públicas, acotadas: `seguimiento`
   (referencia exacta, una fila, sin teléfono ni correo) y `buscar_mis_pedidos` (ahora **acotada a un
   restaurante**; por defecto Taqueiros mientras el sitio no mande el restaurante; teléfono + total exacto,
   últimas 24 h, máx. 5 filas). Además se revocó `EXECUTE` a `anon` en **todas** las demás funciones de `public`.
3. **Dueño borra pedidos solo si nunca se cobraron.** La matriz dice “todo”, pero hoy nadie borra pedidos desde el
   navegador a propósito (el historial se conserva). Se mantiene esa garantía.
4. **`configuracion` y `salud`: crear/borrar solo superadmin/servidor.** La fila la crea el alta del restaurante;
   que un dueño pudiera borrarla dejaría el local sin horario. El dueño sí actualiza la configuración.
5. **El dueño edita `nombre` y `config` de su restaurante, no el resto.** Plan, estado, vigencia, módulos, slug,
   zona y hora de corte son comerciales: los cambia Carlos (servidor/superadmin). Se hace con un trigger.
6. **Cocina cambia el estado y nada más** (más las columnas de impresión, porque el PC de la cocina imprime). Un
   trigger lo impone a nivel de columna; RLS por sí sola no puede.
7. **UUID fijo para Taqueiros** y `restaurante_taqueiros_id()` como función constante: el valor por defecto
   transitorio no depende de ninguna tabla.
8. **`personal` se conserva** como tabla legada (no se borra nada). Como ningún código la consulta, no hace falta
   la vista de compatibilidad; en su lugar un trigger refleja en `miembros` lo que se agregue o quite allá. Si algún
   día se agrega “a mano” a alguien como se documentaba antes, sigue funcionando. `es_personal()` se conserva: ahora
   significa “miembro activo de algún restaurante”.
9. **Hora de corte de la jornada:** `restaurantes.hora_corte_jornada` quedó con el valor actual (copia, para el
   siguiente paso), pero las funciones siguen leyendo `configuracion.hora_corte_jornada`, que es la fuente de hoy.
   La zona horaria sigue fija en `America/Bogota` dentro de `jornada_de` (`restaurantes.zona_horaria` no se usa).
10. **`SQL 01` y `SQL 02` quedan absorbidos.** El SQL 10 crea el bucket y las validaciones del 01 y las columnas y
    funciones de impresión del 02 si faltan (con el mismo criterio: los pedidos pagados que ya existían se dan por
    impresos, y sin UPDATE). No hace falta correrlos antes, pero tampoco hay que correrlos **después**.
11. **Secretos por restaurante en columnas** (no en un jsonb único) para que cada llave tenga nombre y se pueda
    auditar. Quedan en texto en la tabla (protegida por RLS sin políticas): ver riesgos.
12. **`realinear_secuencia_pedidos()`**: borrar pedidos de prueba consume ids de la secuencia y el panel actual
    muestra el `id`. Esta función (solo servidor) deja la secuencia en el último id real; la prueba de aislamiento
    la llama al terminar, y solo si no entró ningún pedido real mientras tanto.
13. **Una sola migración atómica con verificación que revierte.** Si cualquiera de las 34 comprobaciones falla,
    toda la transacción se revierte y el error lista cuáles.

---

## 5. Qué se conserva para no romper nada

| Código actual | Cómo sigue funcionando |
|---|---|
| `crear-pedido` / `webhook` / `alertas` / crons (llave secreta) | Insertan sin `restaurante_id` ni `numero`: el defecto transitorio los deja en Taqueiros y el trigger asigna el número. La llave secreta se salta RLS. |
| `/api/estado`, `/api/menu`, `/api/disponibilidad`, validación de precios | Mismas columnas y mismas consultas; `configuracion?id=eq.1` y `salud_notificaciones?id=eq.1` siguen devolviendo una sola fila. |
| `panel.html` | Mismas consultas; el usuario existente es `dueno` de Taqueiros. `limites_jornada()` sin parámetros, `reclamar_impresion`, Realtime: sin cambios. |
| `menu-admin.html` | Inserta categorías y productos sin `restaurante_id` (queda Taqueiros), sube fotos planas a la raíz (regla transitoria), `update/delete ... eq("id")` funcionan. |
| `historial.html` | `resumen_jornada({fecha})`, `jornadas_con_pedidos({limite})`, `buscar_historial({...})` con los mismos nombres de parámetro. |
| `index.html` / `pedido.html` | `buscar_mis_pedidos(telefono, total_pagado)` y `seguimiento(ref)` con los mismos argumentos. |

**Scripts antiguos que ya no aplican:** `supabase/probar-menu-rls.js` y `supabase/probar-publishable.mjs` esperan que
`anon` pueda **leer** el menú directo y fallarán esa parte; es el comportamiento que se quitó a propósito. No se
modificaron para que los commits solo agreguen archivos.

---

## 6. Orden de pasos en Windows

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. La llave secreta (`sb_secret_...`, Supabase → Project
Settings → API Keys) se pide con `Read-Host` y **no se muestra al pegarla**: pégala **UNA sola vez** (clic derecho
**o** Ctrl+V, nunca ambos). Si se pega dos veces, los scripts lo detectan y no hacen nada.

> Los pasos del **servidor** (SQL 11, cargar secretos, pruebas de la API) están en la sección 12.9.

**0. Una sola vez:** `npm i --no-save @supabase/supabase-js@2.117.2` (para la prueba de Realtime).

**0b. Urgente, hoy mismo (antes de todo lo demás).** La inspección mostró que `anon` puede ejecutar
`limpiar_pedidos_huerfanos`: cualquiera sin sesión puede llamarla con `horas = 0` y borrar los pedidos que un
cliente está pagando en ese momento (el webhook de Wompi ya no los encuentra y el pedido pagado nunca llega a la
cocina). El SQL 10 lo cierra, pero mientras tanto ejecuta en el SQL Editor solo esta línea (el servidor usa la llave
secreta y sigue funcionando):

```sql
revoke execute on function public.limpiar_pedidos_huerfanos(integer) from public, anon, authenticated;
```

**1. Inspección (solo lectura).** Supabase → SQL Editor → New query → pega el contenido de
`supabase/00-inspeccion-esquema.sql` → Run. Revisa (o pégame) las filas `tablas_sin_restaurante_id`,
`funciones_que_anon_ejecuta`, `funciones_security_definer`, `firmas_repetidas`, `triggers_en_auth_users`,
`politicas_public`, `politicas_storage` y `sql_pendientes`, y las filas nuevas `objetos_fuera_de_public_con_permisos`,
`catalogo_pg_catalog_con_permisos`, `objetos_de_extensiones_en_public` y `permiso_storage_objects` (sección 11). Si aparece una tabla que
no sea `personal` en `tablas_sin_restaurante_id`, **avísame antes de seguir**.

**2. Respaldo (antes del SQL).**

```powershell
cd "D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0"
$k = Read-Host "Pega la llave SECRETA UNA sola vez (clic derecho O Ctrl+V, no ambos)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/exportar-respaldo.mjs
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Imprime las filas exportadas por tabla y deja todo en `respaldos\<fecha>\` (ignorada por git). Guarda esa carpeta
**fuera** del repositorio: tiene datos de clientes. Si dice “NO coincide” o sale con error, no sigas.

**3. SQL de migración.** En VS Code abre `supabase/10-multirestaurante.sql` → **Ctrl+A, Ctrl+C** (el contenido,
no el nombre del archivo) → SQL Editor → New query → pega → Run. Resultado esperado: una tabla de **34 filas, todas
`OK`**. Si algo falla verás el error con la lista de comprobaciones que fallaron y **no se cambió nada** (todo va en
una transacción). Se puede volver a correr sin dañar nada.

**4. Compatibilidad del código actual (solo lectura).**

```powershell
$k = Read-Host "Pega la llave SECRETA UNA sola vez (clic derecho O Ctrl+V, no ambos)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs
```

**5. Pruebas de aislamiento** (elige un momento tranquilo: durante 1–2 minutos existen categorías y productos de
prueba, apagados, que `/api/menu` devolvería si alguien lo consulta; se borran al terminar).

```powershell
# Reutiliza la variable del paso 4, o vuelve a pedirla:
$k = Read-Host "Pega la llave SECRETA UNA sola vez (clic derecho O Ctrl+V, no ambos)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
# La llave publishable ya esta en supabase-publico.js; solo si quieres usar otra:
# $env:SUPABASE_PUBLISHABLE_KEY = Read-Host "Llave publishable (sb_publishable_...)"
node supabase/probar-aislamiento.mjs
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Imprime PASA/FALLA por prueba, borra todo lo que creó (también si falla o lo interrumpes con Ctrl+C), realinea la
secuencia de ids y sale con código distinto de cero si algo falla. Si dice que no pudo limpiar, vuelve a correrlo:
al empezar barre los restos.

**6. Tests del repo (no tocan la base real).**

```powershell
node --test pruebas/*.test.js          # unitarios (64)
node pruebas/impresion/e2e.js          # panel con Supabase simulado (~3 min, 173 comprobaciones)
```

**7. Recorrido a mano (lo único que ninguna prueba automática reemplaza).** Con la cuenta real del panel:
abrir `panel.html` e iniciar sesión → se ven los pedidos de la jornada · cambiar un pedido de estado ·
interruptor Abierto/Cerrado y volver a abrir · `menu-admin.html`: apagar y volver a prender un producto, subir
una foto de prueba y borrarla · `historial.html`: elegir una fecha y buscar por teléfono · y **un pedido de prueba
completo por el sitio con Wompi en modo test** (aparece en el panel, suena, imprime, y el número es el siguiente
al último).

**8. Superadmin (cuando quieras).** Authentication → Users → copia tu UID. En el SQL Editor ejecuta solo:
`insert into public.superadmins (user_id) values ('TU-UID');`. Activa 2FA en esa cuenta: ve los datos de todos
los clientes.

---

## 7. Lo que queda para el siguiente paso (no se hizo a propósito)

* Quitar `default restaurante_taqueiros_id()` de las columnas `restaurante_id` y borrar la función.
* API y front multi-restaurante: resolver el restaurante por slug/subdominio; `api/*.js` filtran por
  `restaurante_id`; llaves de Wompi/CallMeBot desde `restaurante_secretos`; tarifas y coordenadas desde
  `tarifas_domicilio` y `restaurantes.config`; el sitio manda `p_restaurante` a `buscar_mis_pedidos`; mostrar
  `numero` en lugar de `id` en panel, ticket, seguimiento y alertas.
* Retirar la regla transitoria de Storage (raíz del bucket) y subir las fotos nuevas a `{restaurante_id}/`.
* Aplicar estado/vigencia/plan/módulos (hoy son solo estructura) y `restaurantes.zona_horaria`.
* Alta de miembros y de restaurantes desde un endpoint del servidor (hoy se hace con la llave secreta o SQL).
* ~~`crear-pedido`, webhook y alertas aún no son multi-restaurante~~ **Hecho** (sección 12): el servidor ya filtra
  por restaurante en todos sus endpoints. ~~Las páginas públicas~~ **Hecho** (sección 14: marca, textos, tarifas, llave de
  pago, manifest y número de pedido). ~~El panel~~ **Hecho** (sección 15: panel, menú, historial, ticket y `sw.js` por restaurante, con
  membresía verificada). Lo que sigue pendiente es la **administración** (formulario de configuración, superadmin, 15.11) y retirar los
  valores por defecto transitorios y la regla del bucket.

---

## 8. Qué se probó y qué no

**Probado por mí, en un Postgres 16 local (PGlite) que imita a Supabase** (roles `anon`/`authenticated`/
`service_role`, `auth.uid()`, Storage con `foldername`, publicación Realtime), aplicando primero **todos los SQL
antiguos del repo** (con y sin el 01 y el 02) y luego el 10:

* El SQL 10 corre dos veces seguidas sin error (idempotente) y las 34 comprobaciones dan OK, en los dos escenarios.
* 234 comprobaciones de aislamiento con roles reales y RLS: lectura/inserción/actualización/borrado entre
  restaurantes en cada tabla, cada rol de la matriz, `restaurante_id` ajeno y por defecto, `anon`, sin
  membresía, escalada de privilegios (membresías, superadmins), secretos, impresión, historial, Storage por
  carpeta, números de pedido por restaurante, y lo que hacen el panel, `menu-admin` y el servidor con las mismas
  sentencias que usa el código actual; también `UPDATE`/`DELETE` sin `WHERE`, `upsert` contra filas ajenas y un
  usuario dueño de dos restaurantes.
* 32 pruebas de los hallazgos de la revisión de seguridad y de la visibilidad de errores (`hallazgos.mjs`,
  secciones 10 y 11): 11 fallan con el SQL del commit 43b6567 y las 32 pasan con el corregido.
* `planes.mjs`: el SQL 10 bajo 8 planes distintos del optimizador sobre un simulador que ya se parece a Supabase
  (esquemas `extensions`, `graphql`, `vault`, `realtime`, objetos de `supabase_admin` y de una extensión, permisos
  sobre `pg_catalog`, catálogo grande): con el SQL del commit ac2bab2 fallan 6 de 8 (el error de la sección 11);
  con el corregido pasan los 8, y un lint estático prohíbe volver a armar nombres de relación a mano.
* Revisión por mutación (`mutaciones.mjs`): ver el resultado al final de la sección 10.
* `probar-aislamiento.mjs` completo, contra un servidor falso con la misma lógica de PostgREST/Auth/Storage sobre
  esa base: 227 de 234 pasan; las 7 que no pasan son todas de **Realtime**, que el falso no emula.
* `probar-compatibilidad.mjs` (ejecuta los manejadores reales `api/menu.js`, `estado.js`, `disponibilidad.js` y
  `_precios.js` sin modificarlos): 17/17.
* `exportar-respaldo.mjs`: paginación probada con 2.503 filas y tope de 1.000 por página; detección de pegado doble.
* Tests existentes: 64 unitarios y 173 comprobaciones del e2e del panel, sin cambios.

Todo lo anterior se puede **repetir** (por ejemplo cuando el siguiente paso cambie políticas o funciones) con el
arnés de `pruebas/multirestaurante/` (necesita `npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2`):

```powershell
node pruebas/multirestaurante/sim.mjs                 # SQL antiguos + SQL 10 dos veces (34 comprobaciones)
node pruebas/multirestaurante/sim.mjs conPendientes   # igual, con el 01 y el 02 ya corridos
node pruebas/multirestaurante/rls.mjs                 # 234 comprobaciones de aislamiento a nivel SQL
node pruebas/multirestaurante/hallazgos.mjs           # 32 pruebas de los hallazgos de la revision
node pruebas/multirestaurante/planes.mjs              # el SQL bajo 8 planes del optimizador + lint (11 pruebas)
# cualquier suite acepta SQL10_PLAN=sin-nestloop (u otro plan de sim.mjs) para correr bajo ese plan
node pruebas/multirestaurante/mutaciones.mjs          # rompe cada defensa y exige que algo lo detecte (~25 min)
node pruebas/multirestaurante/contra-falso.mjs probar-aislamiento.mjs      # (Realtime falla aqui: no se emula)
node pruebas/multirestaurante/contra-falso.mjs probar-compatibilidad.mjs
```

El falso (`fake-supabase.mjs`) no es PostgREST: cubre lo que usan los scripts (filtros `eq/in/like/is`, insertar,
actualizar, borrar, `rpc`, Auth y Storage) y aplica los roles y RLS igual por petición, pero **no** reproduce los
códigos de error exactos ni los límites reales de Supabase; por eso no sustituye la corrida real.

**Solo se pueden correr contra la base real (pendiente de Carlos):** el SQL 10 sobre el esquema verdadero (por si
hay objetos que el repo no conoce); `probar-aislamiento.mjs` con PostgREST, Auth y Storage reales (códigos HTTP
reales, límites de tamaño/MIME del bucket, política de `storage.objects` con el dueño real de la tabla);
**Realtime con sesiones reales** (que el evento de B no llegue a A); los permisos por defecto reales de Supabase
sobre funciones; si `postgres` puede crear políticas sobre `storage.objects` (si no, el SQL 10 se revierte con
“must be owner”: el SQL 10 lo prueba de verdad y lo dice con el mensaje `MR paso 10 (Storage)`; la inspección muestra la evidencia en `permiso_storage_objects`); el límite de intentos de
`buscar_mis_pedidos` a través del PostgREST real; el recorrido a mano del panel; y un pedido real con Wompi.

---

## 9. Riesgos

1. **El esquema real puede tener objetos que el repo no conoce.** El SQL 10 se detiene (y revierte) si encuentra
   una tabla de `public` sin `restaurante_id` o una función/política que no esperaba; la inspección previa lo
   anticipa.
2. ~~**El servidor aún no es multi-restaurante.**~~ **Resuelto en la sección 12**: `/api/menu`, la validación de
   precios, los cobros y las alertas filtran por restaurante (probado con la batería local y la revisión por mutación).
   Lo que no está resuelto es el front (sección 12.10).
3. **Huecos en los ids.** Cada inserción fallida (también las rechazadas por RLS en las pruebas) consume un id de la
   secuencia. Mientras el código muestre `id`, el panel puede saltar números; `numero` (contador) no salta. La
   prueba realinea la secuencia. En el siguiente paso, mostrar `numero`.
4. **Valor por defecto transitorio:** cualquier código nuevo que olvide `restaurante_id` caería en Taqueiros sin
   avisar. Por eso se retira en el siguiente paso.
5. **Realtime y `DELETE` (aceptado por ahora).** Supabase no aplica RLS a los eventos de borrado: cualquier sesión
   suscrita a una tabla publicada recibe la **llave primaria** de las filas borradas de cualquier restaurante (nunca
   nombre, teléfono ni dirección). Hoy eso es: el `id` de los pedidos sin pagar que borra la limpieza diaria y del
   que borre un dueño, y `(restaurante_id, id)` de los productos borrados (el id es el slug del producto). Se acepta
   porque no expone datos personales y ningún cliente real convive aún. Mitigación mínima para el siguiente paso:
   pasar el panel a canales **privados de Broadcast por restaurante** (`realtime.broadcast_changes` + políticas en
   `realtime.messages`) y sacar `pedidos` y `productos` de la publicación `supabase_realtime`. No está cubierto por
   la prueba.
6. **Secretos en texto en la base.** Protegidos por RLS sin políticas y revocados a clientes, pero visibles para
   quien tenga la llave secreta o acceso al panel de Supabase. Más adelante conviene Supabase Vault o cifrado.
7. **Registro público de Auth:** ya se desactivó. Aunque se reactivara, una cuenta sin membresía no ve ni escribe
   nada (probado), salvo que exista un trigger en `auth.users` que la meta en `personal`/`miembros`: el SQL 10 se
   niega a correr si lo encuentra.
8. **Superadmin = acceso a todos los clientes.** Agrégalo solo cuando lo necesites y con 2FA.
9. **No vuelvas a correr los SQL antiguos** después del 10: recrearían políticas y funciones de un solo restaurante.
10. **Alertas por WhatsApp entre restaurantes (resuelto en la sección 12).** *Descripción del riesgo original:* `/api/alertas` (llave secreta)
    busca pedidos `nuevo` sin avisar de **todos** los restaurantes y avisa al WhatsApp de Taqueiros. Cuando exista un
    segundo restaurante, un dueño o cajero suyo puede crear pedidos (con `alerta_enviada = false`) que terminen como
    mensajes en el WhatsApp de Taqueiros. Hoy no hay otros restaurantes; la API debe filtrar por restaurante y usar
    el CallMeBot de cada uno.
11. **Límite de la búsqueda pública:** es por celular; alguien puede gastar los 10 intentos de un celular ajeno y
    el cliente real quedaría sin buscar ese día (puede abrir su enlace de seguimiento). No frena a quien prueba
    muchos celulares distintos, pero sin el celular correcto no hay nada que encontrar.
12. **Pendientes anteriores que esto no resuelve:** la llave `service_role` legacy que estuvo en el historial del
    repo público (hay que rotarla si no se hizo) y la impresora física nunca probada de punta a punta.

---

## 10. Revisión de seguridad del SQL 10 (antes de correrlo)

Revisión independiente con mentalidad de atacante (dueño o cajero de otro restaurante, cuenta sin membresía,
`anon` con la llave publishable). Cada hallazgo tiene una prueba en `pruebas/multirestaurante/hallazgos.mjs`
que **falla con el SQL del commit 43b6567 y pasa con el corregido**.

| # | Gravedad | Hallazgo | Cómo se explotaba | Corrección |
|---|---|---|---|---|
| P | Crítico, **hoy en producción** | `anon` puede ejecutar `limpiar_pedidos_huerfanos(horas)` | Sin sesión: `rpc/limpiar_pedidos_huerfanos {horas: 0}` borra los pedidos que se están pagando; el webhook no los encuentra y el pedido pagado no llega a la cocina | El SQL 10 la deja solo para el servidor. Mientras no se corra: el `revoke` del paso 0b |
| H1 | Alto | Solo se borraba la firma conocida de las funciones de historial/jornada | Una firma vieja `SECURITY DEFINER` (en producción hubo varias) seguía leyendo los pedidos de todos los restaurantes para cualquier usuario con sesión | Se borran **todas** las firmas de las 5 funciones reemplazadas |
| H1b | Alto | El barrido de `EXECUTE` exceptuaba a `seguimiento` y `buscar_mis_pedidos` **por nombre** | Una firma extra (p. ej. `seguimiento(bigint)` por id) quedaba abierta a `anon`: enumerar direcciones por id secuencial | La excepción es por firma exacta, y la migración se detiene ante cualquier `SECURITY DEFINER` desconocida |
| H2 | Alto | `buscar_mis_pedidos` sin límite de intentos | Conociendo un celular, se prueban totales (en la prueba: 47 intentos) → referencia → `seguimiento` entrega dirección, barrio e indicaciones | 10 consultas por (restaurante, celular) cada 24 h; después responde vacío |
| H3 | Medio | El trigger `personal → miembros` vuelve **dueño de Taqueiros** a quien entre en `personal` | Con un trigger `handle_new_user` en `auth.users` que escriba en `personal` (plantilla común), cada cuenta nueva —incluido el dueño de un cliente nuevo— vería los pedidos de Taqueiros | La migración se detiene si encuentra un trigger así (nuevo en la inspección: `triggers_en_auth_users`) |
| H1c | Medio | La comprobación final ignoraba funciones de otro dueño | En Supabase `postgres` no puede revocar funciones de `supabase_admin`; una de esas abierta a `anon` pasaba sin aviso | La comprobación las cuenta y la migración se detiene |
| H4 | Bajo (hoy no hay vistas) | Ninguna comprobación miraba vistas | Una vista sin `security_invoker` corre como su dueño y salta RLS | La migración se detiene ante una vista así legible por clientes |
| H5 | Bajo | No se avisaba a PostgREST | Se borran y recrean funciones con otra firma; sin recargar, el panel llamaría a la firma vieja (404) | `notify pgrst, 'reload schema'` antes del `commit` |

**Hipótesis revisadas que resultaron no ser huecos** (con prueba que lo confirma en `rls.mjs`):

* La regla transitoria de la raíz del bucket **no** deja a otros dueños sobrescribir, mover ni borrar las fotos de
  Taqueiros: solo un `dueno` **de Taqueiros** puede escribir en la raíz. Tampoco sirven `..`, una barra inicial, la
  carpeta en mayúsculas ni otro bucket.
* Todas las políticas `UPDATE` tienen `WITH CHECK`; además el trigger `*_restaurante_inmutable` impide mover filas
  incluso a quien es dueño de los dos restaurantes.
* Insertar con `restaurante_id` ajeno, o sin él (el defecto transitorio es Taqueiros), se rechaza; un `upsert`
  contra la referencia de un pedido ajeno se rechaza; un `INSERT` rechazado no consume el contador del otro
  restaurante.
* `UPDATE`/`DELETE` **sin `WHERE`** (donde Postgres no aplica la política de lectura) solo tocan filas propias.
* Las funciones de historial y jornada aceptan `p_restaurante`, pero no confían en él: corren como quien llama
  (RLS filtra) y `config_jornada` verifica la membresía; pedir otro restaurante devuelve vacío o `null`.
* `restaurante_secretos`, `contadores_pedido` e `intentos_buscar_pedido`: sin políticas, sin privilegios para
  clientes, ninguna función ni vista los devuelve y no están en Realtime. A futuro conviene Supabase Vault para las
  llaves (Wompi, CallMeBot), leyéndolas solo desde el servidor.
* La función `es_…` que `anon` podía ejecutar en producción es `es_personal()`: solo responde si quien llama está en
  `personal` (para `anon`, siempre `false`). No filtraba datos; el SQL 10 la deja como invoker y sin `anon`.

**Revisión por mutación** (`pruebas/multirestaurante/mutaciones.mjs`): rompe a propósito cada política, trigger,
función y comprobación del SQL 10 y exige que alguna prueba falle o que la migración se detenga. Ver la sección 8
para el resultado.

**Resultado de la revisión por mutación:** 91 mutaciones; **84 detectadas**, **7 equivalentes** y **0 sin detectar** (incluye dos que reintroducen la causa del error de la sección 11). Las
equivalentes son defensas en capas: quitar una sola no cambia lo que un atacante puede hacer porque otra capa cubre lo
mismo (por ejemplo, el `WITH CHECK` de productos y el trigger de restaurante inmutable). En esos casos, la mutación
que quita **las dos capas** sí se detecta. Antes de esta revisión **no se detectaban** (y se agregaron pruebas para):
`UPDATE` de pedidos sin `WITH CHECK` (un pedido podía volver a `pendiente_pago`) y `UPDATE`/`DELETE` sin control en
pedidos, categorías, tarifas y miembros (Postgres no aplica la política de lectura a un `UPDATE`/`DELETE` sin `WHERE`);
la inserción de configuración y el borrado del propio restaurante (se distinguen por el código de error, porque la
llave primaria y las foráneas también los frenan); mover filas siendo dueño de dos restaurantes; y quitar el trigger
de restaurante inmutable.

---

## 11. Fallo en Supabase real: `relation "public.pg_statistic" does not exist`

**Síntoma.** Al correr el SQL 10 en el SQL Editor (con y sin “enable RLS”) falló con
`ERROR: 42P01: relation "public.pg_statistic" does not exist`; se revirtió todo y la base quedó como antes.

**Causa exacta.** La comprobación final “anon: sin privilegios sobre ninguna tabla de negocio” hacía:

```sql
from pg_tables t
where t.schemaname = 'public'
  and has_table_privilege('anon', format('public.%I', t.tablename), 'select,insert,update,delete')
```

Postgres **no garantiza en qué orden evalúa los filtros de un `WHERE`**. `pg_tables` es una vista sobre `pg_class`; el
filtro `schemaname = 'public'` vive en la unión con `pg_namespace`, y la función solo depende de `relname`, así que el
planificador puede evaluarla sobre **todas** las tablas de **todos** los esquemas antes de aplicar el filtro. Para
`pg_statistic` arma `'public.pg_statistic'`, que no existe, y `has_table_privilege` lanza error (a diferencia de
`to_regclass`, que devuelve nulo). En el simulador chico el plan empezaba por `pg_namespace` y nunca llegaba a
`pg_statistic`; en Supabase (muchos esquemas, extensiones, otra estadística) el plan es otro. **No tenía que ver con
permisos sobre `pg_catalog`** (la hipótesis de los permisos no era necesaria: el error ocurre aunque nadie tenga
permiso sobre esas tablas).

**Cómo se reprodujo.** Con `set enable_nestloop = off` el SQL anterior falla en el simulador con el mismo error
(`relation "public.<tabla de otro esquema>" does not exist`; en el simulador sale `public.buckets`). Con el
simulador realista falla en 6 de los 8 planes de `planes.mjs` (y pasa en los otros dos, que es justo lo engañoso).

**Corrección.**

* Todos los barridos de catálogo usan **OID**, no nombres armados: `pg_class c where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r','p')` + `has_table_privilege('anon', c.oid, …)` (con OID la función no puede fallar), con
  `pg_attribute` en vez de `information_schema` para `restaurante_id`, y `pg_depend` con `classid` para excluir objetos de
  extensiones.
* La comprobación “RLS activo en todas” y “tablas desconocidas” también pasaron a `pg_class` y excluyen objetos de
  extensiones (antes una tabla de extensión sin RLS habría detenido la migración).
* Se agregó `planes.mjs` (planes adversos + lint), que habría atrapado el error antes de entregarlo.
* `00-inspeccion-esquema.sql`: la CTE de tablas filtra primero (`materialized`) y solo después arma nombres y cuenta filas.

**Qué sigue deteniendo la migración (sin debilitar nada).** Funciones `SECURITY DEFINER` desconocidas, vistas sin
`security_invoker`, triggers de `auth.users` con membresía automática y todas las comprobaciones de políticas y
permisos siguen igual; solo cambió *cómo* se recorren los catálogos. Siguen limitadas a objetos de `public` que no son
de una extensión; los barridos de permisos solo tocan funciones que `postgres` puede modificar y la comprobación
final avisa de las que no puede (`H1c`).

**Visibilidad de errores.** El SQL Editor solo muestra el mensaje. Cada bloque `DO` (menos las precondiciones y la
verificación final, que ya tienen su propio mensaje) repite el error como
`MR paso <paso>: <mensaje original> [elemento: <objeto>]` y la transacción se sigue revirtiendo entera. El SQL plano trae
marcadores `-- >>> PASO …` numerados (en VS Code: Ctrl+G con el número de línea y buscar hacia arriba el marcador más
cercano; la lista completa sale con `>>> PASO`). Antes de crear las políticas de Storage, un bloque prueba **de verdad**
si el usuario puede crearlas (crea y borra una política de prueba) y, si no, se detiene con
`MR paso 10 (Storage): este usuario no puede crear políticas en storage.objects (…)`.

**El indicador `puede_crear_politicas_en_storage` era un falso negativo.** Se calculaba con
`pg_has_role(current_user, dueño_de_storage.objects, 'member')`; el SQL 01 ya creó políticas de ese bucket desde el mismo editor,
así que el indicador daba un falso negativo (sin acceso a la base real no pude determinar por qué mecanismo de roles
`postgres` puede hacerlo; por eso ahora se prueba creando una política de prueba en lugar de adivinar). Se eliminó de `sql_pendientes`; el SQL 10 nunca
dependió de él. Ahora la inspección muestra la evidencia (`permiso_storage_objects`): usuario, si es superusuario, dueño
de la tabla, membresías, privilegios y las políticas que ya existen en `storage.objects`.

**Mejoras al simulador (`sim.mjs`).** Roles de Supabase (`supabase_admin`, `supabase_auth_admin`,
`supabase_storage_admin`, `authenticator`); esquemas `extensions`, `graphql`, `graphql_public`, `vault`, `realtime` con tablas
y funciones (algunas de `supabase_admin`) y permisos para `anon`/`authenticated`; permisos de lectura sobre
`pg_catalog.pg_statistic` y `pg_largeobject`; una extensión real (`citext`) instalada en `public`; 25 esquemas de relleno
y `ANALYZE` del catálogo; y los **planes adversos** (`PLANES`, activables con `SQL10_PLAN`).

**Otras diferencias simulador ↔ Supabase revisadas** (y qué se hizo):
* `postgres` es superusuario en el simulador y **no** en Supabase: no se puede reproducir un “must be owner”; se cubre
  con un event trigger que lo simula (`hallazgos.mjs`, [V]) y con la prueba real de permiso del paso 10.
* Dueño de `storage.objects`: en Supabase lo normal es `supabase_storage_admin`; el simulador lo deja de `postgres`.
* Privilegios por defecto (`ALTER DEFAULT PRIVILEGES`): el simulador los imita para `public`; en Supabase también
  aplican a `supabase_admin`. Las funciones de otro dueño en `public` no se pueden revocar: la verificación final las
  detecta.
* Funciones y tablas de extensiones en `public`: excluidas con `pg_depend` (`classid` + `deptype 'e'`); probado con `citext`.
* Event triggers de Supabase (`pgrst_ddl_watch`, `issue_graphql_placeholder`…) corren en cada DDL como `supabase_admin`:
  no se pueden simular aquí; el `notify pgrst, 'reload schema'` final es redundante pero inofensivo.
* Pooler y editor: el script depende de una sola sesión (tablas temporales `_mr_*` y el `select` final tras el
  `commit`). El SQL Editor lo ejecuta como una sola consulta; si en algún entorno el editor partiera el script, la
  tabla final no aparecería (la migración sí quedaría confirmada).
* Opción “Run and enable RLS” del editor: reescribe el script; se recomienda **“Run without RLS”**, porque el propio
  SQL 10 activa RLS en todo y sin que nadie toque el texto.
* `auth.uid()`, claims y roles de PostgREST: se imitan con `request.jwt.claims`; el comportamiento real de las llaves
  nuevas (`sb_publishable_`, `sb_secret_`) solo se confirma con `probar-aislamiento.mjs` contra la base real.

---

## 12. Servidor multi-restaurante (SQL 11 + `api/`)

Hasta la sección 11 la base ya era multi-restaurante pero el servidor no: funcionaba porque todo caía en Taqueiros
(valor por defecto transitorio de `restaurante_id`). Como las API usan la llave secreta (que **se salta RLS**), la base
no las protege de sí mismas: cada consulta del servidor tiene que filtrar por restaurante de forma explícita. Esta
sección es ese trabajo. **Las páginas HTML y `ticket-comanda.js` no se tocaron** y Taqueiros se ve igual en
`taqueiros-2-0.vercel.app`.

### 12.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `supabase/11-dominios.sql` (nuevo) | Tabla `restaurante_dominios (host único en minúsculas, restaurante_id, creado_en)`, RLS activo, **sin políticas y sin privilegios para `anon` ni `authenticated`** (solo el servidor la lee). Siembra `taqueiros-2-0.vercel.app` → Taqueiros. Atómico, idempotente, con marcadores `-- >>> PASO n`, bloques `DO` que relanzan el error como `MR paso n: ...`, barridos por OID y 12 comprobaciones OK/FALLA. No toca el valor por defecto transitorio. |
| `api/_restaurante.js` (nuevo) | Resolución del restaurante por petición, caché, estado del servicio, lectura de secretos y modo de cobro. |
| `api/_supabase.js` | **Toda** función de negocio recibe el `restaurante_id` como primer argumento y lo pone en el filtro o en el cuerpo del insert; sin un UUID válido lanza error y no consulta. |
| `api/menu`, `disponibilidad`, `estado`, `crear-pedido`, `generar-firma`, `webhook-wompi`, `alertas`, `keep-alive` | Adaptados (tabla de 12.3). |
| `api/restaurante.js` (nuevo) | Datos públicos del restaurante del host (para el front). |
| `api/reembolso.js` (nuevo) | Registro de `reembolsado_en` (solo dueño o servidor). |
| `supabase/cargar-secretos.mjs` (nuevo) | Pasa las llaves de las variables de entorno a `restaurante_secretos`. |
| `supabase/probar-servidor-multirestaurante.mjs` (nuevo) | Los mismos escenarios que la batería local, contra la base real. |
| `supabase/probar-compatibilidad.mjs` | Actualizado: simula una visita al host de Taqueiros y revisa lo que el servidor nuevo necesita. |
| `pruebas/llave-y-categorias.test.js`, `pruebas/cron.test.js` | Solo se actualizaron las firmas (ahora reciben el restaurante). |

Fuera de `api/` y `supabase/` solo cambiaron `pruebas/` (arnés y pruebas), `docs/` y `.env.example`.

### 12.2 Cómo se resuelve el restaurante (y por qué es seguro)

Orden, y **nada más**:

1. El encabezado **`Host` exacto**, buscado en `restaurante_dominios`.
2. Un **subdominio** bajo `DOMINIO_BASE` (variable de entorno de Vercel) cuyo **único** segmento anterior sea el slug de un
   restaurante. Con `DOMINIO_BASE=midominio.com`: `lostaqueiros.midominio.com` → slug `lostaqueiros`. Dos niveles
   (`x.lostaqueiros.midominio.com`), el dominio pegado sin punto o un sufijo (`...midominio.com.evil.com`) **no** resuelven.
3. **Solo si `VERCEL_ENV` no es `production` Y además `RESTAURANTE_POR_PARAMETRO=1`** (previews y desarrollo local): el
   parámetro `?r=<slug>`, para probar sin dominios. En producción está apagado siempre, y en un preview también salvo que
   se active a propósito (sección 13, H4: los previews de Vercel son públicos y usan la misma base y la misma llave secreta).
   Ni `?r=`, ni cabeceras, ni el cuerpo eligen restaurante.

Por qué es seguro:

* `Host` lo fija la infraestructura (Vercel enruta por el dominio al que entró el cliente). No se lee `x-forwarded-host` ni
  ningún otro encabezado, y **nunca** el cuerpo ni el query en producción. La batería lo prueba con `x-forwarded-host`,
  `x-restaurante`, `origin`, `referer`, `restaurante_id`/`slug`/`host` dentro del body y `?r=` en producción.
* Un host desconocido (o ausente, o con formato raro) responde **404 con el mismo cuerpo** para cualquier endpoint, sin
  decir qué restaurantes existen; los hosts raros ni siquiera llegan a la base (se validan antes de consultar).
* El slug del subdominio se valida contra el formato antes de buscarlo; todo valor que entra a una URL de PostgREST se
  valida (UUID / formato de host / formato de slug), así que no se pueden colar filtros.
* La tabla `restaurante_dominios` no la ve ningún cliente: con la llave publishable nadie averigua qué hosts existen.

**Caché** (memoria de la instancia): 30 s por host/slug, con caché negativa de 10 s (un host inventado no castiga a la
base) y máximo 500 entradas. Guarda solo el restaurante (nunca secretos). `invalidarCache()` / `invalidarCache(id)` la
vacía (hay que llamarla en cualquier código futuro que cambie estado, plan o vigencia). Si Supabase falla, se usa la
**última resolución conocida** (hasta 6 h): el mapa host → restaurante no es secreto y así se conserva la red de seguridad
del menú. Para decidir si se aceptan pedidos, `crear-pedido` relee el restaurante **sin caché**: una suspensión rige en
el acto.

**Transición:** si la tabla `restaurante_dominios` aún no existe (SQL 11 sin correr) y el host es exactamente
`taqueiros-2-0.vercel.app`, se resuelve a Taqueiros con un aviso en el log. Es lo que permite desplegar el código antes del
SQL 11 sin tumbar a Taqueiros. Cualquier otro host sigue dando error.

### 12.3 Inventario de endpoints y cómo filtra cada uno

| Endpoint | Quién llama | Restaurante sale de | Cómo filtra / qué usa |
|---|---|---|---|
| `GET /api/menu` | público | Host | `categorias` y `productos` con `restaurante_id`; copia de respaldo en memoria **por restaurante**; `Cache-Control` del borde + `Vary: Host`. Suspendido sigue mostrando menú. |
| `GET /api/disponibilidad` | público | Host | `productos`/`categorias` agotados/apagados de ese restaurante. |
| `GET /api/estado` | público | Host | `configuracion` por `restaurante_id`, con su zona horaria y su hora de corte; agrega `servicio.sirve`. |
| `POST /api/crear-pedido` | público | Host | Servicio al día (relee sin caché) → horario → `validarItems(rid)` (un producto de otro restaurante cae en `desconocidos`) → domicilio con **sus** `tarifas_domicilio` y **su** ubicación → secretos del restaurante → `insert` con `restaurante_id` explícito; el número lo asigna el trigger con el contador atómico de ese restaurante. |
| `POST /api/generar-firma` | (ninguna página lo usa) | Host | Solo firma un pedido que **existe en ese restaurante**, está pendiente y por el monto guardado (antes firmaba cualquier referencia/monto). |
| `POST /api/webhook-wompi` | Wompi | **El pedido** (por la referencia) | Ver abajo. |
| `GET /api/alertas` | cron | recorre restaurantes | Cada restaurante en servicio: sus pedidos, su contacto, su salud, su `alerta_enviada`. |
| `GET /api/keep-alive` | cron | ninguno | Ping a `restaurantes` (no es tabla de negocio); `limpiar_pedidos_huerfanos` es global a propósito. |
| `GET /api/restaurante` | público (front) | Host | Solo datos públicos (12.7). |
| `POST /api/reembolso` | panel (dueño) | Host | 12.6. |

**Webhook de Wompi.** Es un único endpoint para todos, así que el host no sirve. (1) La referencia del evento identifica el
pedido (única en toda la base) y el pedido trae su `restaurante_id`; (2) la firma se verifica con los secretos **de ese
restaurante**, según el `environment` del evento; (3) todo lo demás (actualizar, avisar) usa ese `restaurante_id`. Un
evento firmado con los secretos del restaurante A sobre un pedido de B responde **401** y no cambia nada. Una referencia
desconocida y una firma mala responden **igual** (401, mismo cuerpo): el endpoint no sirve para averiguar qué referencias
existen. Además (sección 13): el ambiente del evento (`test`/`prod`) debe coincidir con el del pedido y con el modo fijado del
restaurante (si no, 200 e ignorado); el monto se compara en centavos exactos y la moneda debe ser COP; y toda escritura es
condicional (`estado_pago <> aprobado`), así que dos eventos simultáneos avisan una sola vez y un rechazo tardío no deshace
un pago. Un restaurante **suspendido sigue
procesando los pagos ya en curso** (el cliente ya pagó): lo que se corta es crear pedidos nuevos.

**Alertas.** Itera sobre los restaurantes que están sirviendo (activo, prueba o gracia; no suspendidos). Un restaurante sin
contacto se salta y sus pedidos **no** se marcan como avisados; el fallo de uno no detiene a los demás; `notificarWhatsApp`
lanza error si el contacto no es del restaurante del pedido (defensa en profundidad: nunca sale un pedido por el WhatsApp de
otro). El estado de salud (`salud_notificaciones`) se lee y se escribe por `restaurante_id` (ya no `id = 1`). Con muchos
restaurantes (sección 13, H5): solo se avisan pedidos pagados en las **últimas 2 h** (cargarle el contacto a un restaurante
que no lo tenía no le manda un aluvión de pedidos viejos), se revisan **4 restaurantes a la vez** empezando por uno al azar, y
la corrida **no empieza envíos pasados 8 s** (cada envío se acorta a lo que queda); lo que no alcanza sale en la siguiente
pasada. La respuesta informa `sinRevisar`.

**`limpiar_pedidos_huerfanos`**, `seguimiento` y `buscar_mis_pedidos`: el servidor solo llama a la primera, y es un barrido
global que solo toca pedidos que ya nunca se van a cobrar (sin pagar, de más de 24 h) y solo el servidor puede ejecutarla;
`seguimiento` y `buscar_mis_pedidos` las llama el navegador (con su parámetro `p_restaurante`, tarea del front).
**Impresión:** `reclamar_impresion` y `registrar_reimpresion` las llama el panel (ya verifican membresía, SQL 10); el
servidor no las usa y no se tocó nada.

### 12.4 Secretos: de dónde se leen y su forma exacta

Los lee **solo el servidor**, de `restaurante_secretos` (sin políticas: nadie más), **en cada uso** (no se guardan en
caché), y **jamás** se devuelven ni se escriben en logs (la batería busca cada secreto en todas las respuestas y en todo el
log de la corrida).

| Dato | Dónde |
|---|---|
| Secreto de **integridad** de Wompi (firma del checkout) | columnas `wompi_integridad_test` / `wompi_integridad_prod` |
| Secreto de **eventos** de Wompi (firma del webhook) | columnas `wompi_eventos_test` / `wompi_eventos_prod` |
| Llave **pública** de Wompi | columnas `wompi_llave_publica_test` / `wompi_llave_publica_prod` (no la usa el servidor hoy) |
| Llave **privada** de Wompi | `otros.wompi_llave_privada_test` / `otros.wompi_llave_privada_prod` (no la usa el servidor hoy) |
| CallMeBot: teléfono (`57XXXXXXXXXX`) y apikey | columnas `callmebot_telefono`, `callmebot_apikey` |
| **Modo de cobro** | `otros.wompi_modo`: `"test"` o `"produccion"` |

**Modo de cobro.** Antes lo decidía el navegador (`modo` en el body). Un cliente podía pedir `"test"` y pagar con tarjetas de
prueba de Wompi: el webhook de prueba aprobaba el pago y el pedido entraba a cocina gratis. Ahora lo decide el servidor con
`otros.wompi_modo` (el dueño no lo puede editar: `restaurante_secretos` es solo del servidor). Si no está definido, **solo
Taqueiros** conserva lo de siempre (el modo que manda su página); **cualquier otro restaurante no cobra** hasta que se
configure. **Antes de cambiar `WOMPI_MODE` a `"produccion"` en `index.html` es OBLIGATORIO fijarlo** (`cargar-secretos.mjs`
con `WOMPI_MODO=produccion`): sin eso, un cliente puede crear su pedido en modo prueba y pagarlo con una tarjeta de prueba
(sección 13, H1 y pendiente P1).

**Respaldo con variables de entorno, solo Taqueiros.** Si un secreto de Taqueiros no está en `restaurante_secretos`, se usa
la variable de entorno actual (`WOMPI_INTEGRITY_SECRET_*`, `WOMPI_EVENTS_SECRET_*`, `CALLMEBOT_PHONE`, `CALLMEBOT_APIKEY`),
campo por campo y con un aviso en el log (nombre de la variable, nunca el valor). **Nunca** para otro restaurante (probado).
Lo que está en la base manda sobre el entorno. Las variables siguen en Vercel hasta que decidas retirarlas.

### 12.5 Estado del servicio (mensualidad)

`restauranteActivo(restaurante, ahora)` devuelve `activo`, `gracia` o `suspendido`:

* `estado = 'suspendido'` → suspendido (`motivo: suspendido`).
* `vigente_hasta` nulo → activo (sin vencimiento). `prueba` y `activo` sirven.
* Hasta el día de `vigente_hasta` (inclusive) → activo; hasta `vigente_hasta + dias_gracia` → `gracia` (sigue sirviendo);
  después → suspendido (`motivo: vencido`). "Hoy" es la fecha en la **zona horaria del restaurante**.

Suspendido o vencido: `crear-pedido` y `generar-firma` responden **403** con `{"motivo": "servicio_suspendido"}` sin borrar ni
modificar nada; el menú sigue mostrándose; el webhook, las alertas (no se alertan) y los endpoints internos del panel (como
`reembolso`) no se bloquean salvo lo indicado. `/api/estado` y `/api/restaurante` informan `servicio`.

### 12.6 Reembolsos (`pedidos.reembolsado_en`)

`POST /api/reembolso` con `{"referencia": "TAQ-..."}` y la sesión del panel (`Authorization: Bearer <JWT>`). Solo el **dueño
activo** del restaurante del host (o un superadmin) puede; el cajero, la cocina y quien no tenga membresía reciben 403; el
dueño de **otro** restaurante, también. El pedido debe ser de ese restaurante, estar **cancelado** con el pago **aprobado**
y sin fecha de reembolso; repetirlo no cambia la fecha (`yaRegistrado`). El `PATCH` es condicional y atómico: dos llamadas
simultáneas registran una sola fecha. El servidor también puede llamar a `registrarReembolso(rid, referencia)` directamente.
Un cliente con su propia sesión no puede escribir esa columna (lo bloquea el trigger del SQL 10). No hizo falta una función SQL
nueva: así el SQL 10 no cambia (su comprobación rechaza funciones `SECURITY DEFINER` nuevas que clientes puedan llamar).
El panel todavía no lo usa (no se cambió el front).

### 12.7 `/api/restaurante` (datos públicos) y configuración de cada restaurante

Devuelve **solo**: `id`, `slug`, `nombre`, `zona_horaria`, `modulos`, `config` (**únicamente `config.publico`**) y
`servicio {estado: activo|suspendido, sirve, motivo}`. No devuelve plan, modalidad de pago, vigencia, días de gracia, el resto
de `config`, ni nada de `restaurante_secretos` ni de `miembros`. Tampoco dice si el restaurante está **en gracia** (atrasado con
la mensualidad): en gracia responde `activo` (sección 13, H10). Sin caché del borde (es por host).

Claves de `restaurantes.config` (jsonb; el dueño edita `nombre` y `config`):

| Clave | Uso |
|---|---|
| `publico` | Lo que el front puede leer: colores, logo, WhatsApp de contacto, etc. (lo único que sale por `/api/restaurante`) |
| `ubicacion` = `{lat, lng}` | Dónde está el local (origen del domicilio). |
| `domicilio` = `{factor_recorrido, pin_minimo_metros, area:{latMin,latMax,lngMin,lngMax}}` | Opcionales. Sin `area` no se hace la comprobación de "pin fuera del área". |

Un restaurante sin tarifas en `tarifas_domicilio` **o** sin `ubicacion` no ofrece domicilio (400 claro); nunca se inventan
precios. **Transitorio solo para Taqueiros:** mientras su `config` no traiga `ubicacion`, se usan las coordenadas y la caja de
Cúcuta que estaban en el código (hay que cargarlas en `config` en el siguiente paso).

**Tarifas.** Ya no están en el código: salen de `tarifas_domicilio`. Se retiraron `TARIFAS_DOMICILIO` y `RESTAURANTE` de
`api/_domicilio.js` **después** de que una prueba demostrara que la tabla da los mismos precios, distancias y cobertura que
el código antiguo (copia literal de la lógica antigua, 441 puntos de la cuadrícula de Cúcuta + 4 lejanos, los 5 tramos). La
copia de `index.html` (`TARIFAS_DOMICILIO`) **se retiró en la sección 14**: la página lee las tarifas, el origen y el factor
de recorrido de `/api/restaurante`.

**Horario, zona horaria y hora de corte.** `estadoRestaurante(restaurante)` usa la zona de `restaurantes.zona_horaria` y la
hora de corte de `configuracion.hora_corte_jornada` (la que usa el panel; la de `restaurantes` es el respaldo). Un horario que
cruza la medianoche (cierra ≤ abre, p. ej. 18:00–02:00) queda abierto de madrugada hasta el cierre, **sin pasar de la hora de
corte**; con un horario normal (11:00–22:00) el resultado es idéntico al de siempre (probado cada 30 min durante dos días y en
los bordes). La respuesta incluye `jornada` y `horaCorteJornada`.

### 12.8 Dar de alta un restaurante nuevo (receta, con la llave secreta o el SQL Editor)

1. `insert into public.restaurantes (slug, nombre, estado) values ('lostaqueiros', 'Los Taqueiros ...', 'prueba');`
   (el trigger crea su fila de secretos, contador, configuración y salud).
2. Dominio: `insert into public.restaurante_dominios (host, restaurante_id) values ('pedidos.lostaqueiros.com', '<id>');`
   y agregar ese dominio en Vercel (Project → Settings → Domains). O usar el subdominio `lostaqueiros.<DOMINIO_BASE>`.
3. Secretos: `supabase/cargar-secretos.mjs --slug=lostaqueiros` (incluye `WOMPI_MODO`).
4. Menú (`categorias`, `productos` con su `restaurante_id`), `tarifas_domicilio`, `config.ubicacion`, `configuracion.horarios`.
5. En el panel de Wompi de **ese** restaurante, el webhook apunta a `https://<cualquier dominio del despliegue>/api/webhook-wompi`
   (el endpoint es el mismo para todos; el restaurante sale del pedido).

### 12.9 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. Las llaves se piden con `Read-Host` (no se ven al pegarlas): pega
**UNA sola vez** (clic derecho **o** Ctrl+V, nunca ambos). Todos los scripts detectan el pegado doble y no hacen nada.

**1. Despliegue.** Al subir el código a `main`, Vercel despliega solo. Taqueiros sigue funcionando aunque el SQL 11 aún no
esté: el host de producción se resuelve por el respaldo transitorio y los secretos salen de las variables de entorno.
Comprueba `taqueiros-2-0.vercel.app` (menú, un pedido de prueba con Wompi sandbox).

**2. SQL 11.** VS Code → abre `supabase/11-dominios.sql` → **Ctrl+A, Ctrl+C** → Supabase → SQL Editor → New query → pega →
**"Run without RLS"**. Resultado esperado: **12 filas, todas `OK`**. Si algo falla, el error dice `MR paso n: ...` o
`LA MIGRACION 11 SE REVIRTIO` y no se cambió nada. Se puede repetir.

**3. Compatibilidad del servidor con la base real (solo lectura).**

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs
```

Esperado: **25 PASAN** (ya sin el aviso de "SQL 11 sin correr").

**4. Cargar los secretos de Taqueiros en la base.** Los valores actuales están en Vercel → Project → Settings → Environment
Variables (botón del ojo). Pega cada uno **una sola vez**; los que no tengas, déjalos vacíos (Enter).

```powershell
function Pedir($nombre, $texto) { $s = Read-Host $texto -AsSecureString; $v = [System.Net.NetworkCredential]::new('', $s).Password; if ($v) { Set-Item "Env:$nombre" $v } }
Pedir WOMPI_INTEGRITY_SECRET_TEST "Secreto de INTEGRIDAD (test)"
Pedir WOMPI_INTEGRITY_SECRET_PROD "Secreto de INTEGRIDAD (prod)"
Pedir WOMPI_EVENTS_SECRET_TEST    "Secreto de EVENTOS (test)"
Pedir WOMPI_EVENTS_SECRET_PROD    "Secreto de EVENTOS (prod)"
Pedir CALLMEBOT_PHONE             "Telefono CallMeBot (57XXXXXXXXXX)"
Pedir CALLMEBOT_APIKEY            "Apikey CallMeBot"
node supabase/cargar-secretos.mjs --slug=taqueiros --solo-verificar     # que diga "falta en la base"
node supabase/cargar-secretos.mjs --slug=taqueiros
node supabase/cargar-secretos.mjs --slug=taqueiros --solo-verificar     # ahora todo "ya coincide"
```

(Opcional, cuando decidas el modo de cobro de Taqueiros: `Pedir WOMPI_MODO "test o produccion"` y vuelve a correrlo.)
Después de esto el servidor usa la base y ya no el entorno para Taqueiros. **No borres las variables de Vercel todavía.**
Limpia la sesión: `Remove-Item Env:WOMPI_* , Env:CALLMEBOT_*`.

**5. Prueba del servidor contra la base real.** Crea y borra restaurantes de prueba (`test-srv-...`); no toca Taqueiros (solo lee).
Antes, si las sesiones de usuario vuelven a dar 401, corre `node supabase/diagnosticar-auth.mjs` (12.12): dice qué
combinación de cabeceras acepta Supabase.

```powershell
node supabase/probar-servidor-multirestaurante.mjs
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Esperado: todos `PASA` (≈134), `Limpieza: todo lo creado se borro.` y código de salida 0. Si dice que no pudo limpiar,
vuelve a correrlo: al empezar barre los restos. Con Ctrl+C también limpia.

**6. (Recomendado) Aislamiento de la base, igual que antes.** `node supabase/probar-aislamiento.mjs` (con la llave secreta
en la sesión). El SQL 11 no cambia nada de lo que prueba.

**7. Tests del repo (no tocan la base real).**

```powershell
node --test pruebas/*.test.js                          # unitarios (64)
node pruebas/impresion/e2e.js                          # panel con Supabase simulado (~3 min)
node pruebas/multirestaurante/servidor.mjs             # servidor, Supabase falso (~5 s)
node pruebas/multirestaurante/dominios.mjs             # SQL 11 + revision por mutacion del SQL 11
node pruebas/multirestaurante/cargar-secretos-test.mjs # cargar-secretos.mjs
node pruebas/multirestaurante/mutaciones-servidor.mjs  # revision por mutacion del servidor (~12 min)
```

Necesitan una vez: `npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2`.

**8. Recorrido a mano en producción** (lo único que ninguna prueba automática reemplaza): menú, pedido de prueba con Wompi
sandbox (aparece en el panel, suena, imprime, llega el WhatsApp), Reimprimir, historial, menú-admin.

### 12.10 Qué se probó y qué no

**Probado por mí (batería local con el Supabase falso, Postgres 16 real en PGlite con el SQL 10 y el SQL 11):**

* `servidor.mjs`: **145 escenarios** sobre los manejadores reales con dos restaurantes (más otros dos) de menús, tarifas,
  secretos, horarios y zonas distintos: cada host ve solo lo suyo; un producto de A no se pide en B (mismo id, otro precio);
  números de pedido independientes y sin repetirse bajo concurrencia; domicilio distinto por restaurante; un webhook
  firmado con los secretos de A no toca pedidos de B (y al revés); alertas sin cruzar contactos ni salud; host
  desconocido 404; `?r=` solo fuera de producción; cabeceras y body falsos no eligen restaurante; suspendido/vencido/gracia;
  reembolsos por rol; Taqueiros con respaldo de entorno; ningún secreto aparece en respuestas ni en el log; y un **espía de
  URLs** que exige que toda consulta a tablas de negocio lleve el filtro de su restaurante.
* `dominios.mjs`: **35** (SQL 11 dos veces, el SQL 10 después del 11, roles, restricciones, 8 mutaciones del SQL 11).
* `cargar-secretos-test.mjs`: **20** (no imprime valores ni huellas, pegado doble, no pisa sin `--sobrescribir`, `--solo-verificar`).
* `probar-servidor-multirestaurante.mjs` contra el falso: 134 (en modo real se omiten 4 de escribir en Taqueiros y 7 que solo tienen sentido con el falso).
* `probar-compatibilidad.mjs` contra el falso: 25/25.
* Baterías anteriores, con el SQL 11 aplicado y el servidor nuevo (todas siguen verdes): `rls.mjs` 234/234, `hallazgos.mjs` 32/32,
  `planes.mjs` 11/11, `sim.mjs` (34 comprobaciones OK, con y sin `conPendientes`), `probar-aislamiento` contra el falso 227/234 (las 7 que
  fallan son las de Realtime, que el falso no emula: igual que antes), tests unitarios 64/64 y e2e del panel 173/173.

**Revisión por mutación del servidor** (`mutaciones-servidor.mjs`): rompe a propósito cada defensa y exige que alguna prueba
lo detecte. **10** filtros de `restaurante_id` (todas las llamadas a `filtroRestaurante`, que cubren cada endpoint; cada una
se prueba **sin** el espía de URLs, y las 10 se detectan ya por comportamiento), el `restaurante_id` de los inserts, y **96**
defensas más (resolución del host, caché, `?r=`, servicio, secretos, firma del webhook, contactos de alertas, autorización
de reembolsos, tarifas, horarios, respaldo del menú, datos públicos…): **101 detectadas, 6 equivalentes, 0 sobrevivientes**.
Las equivalentes están declaradas con su razón (defensas en capas: p. ej. el `PATCH` del reembolso repite las condiciones de
`reembolso.js`, y quitar las dos juntas **sí** se detecta). Antes de agregar las pruebas del cliente de Supabase, la revisión
mostró que quitar el filtro de `actualizarPedidoPorReferencia`, `marcarReembolsado`, `consultarPedidos` y del contador de
salud solo lo detectaba la prueba de "restaurante inválido" y no un cruce real; y que la prueba de suspensión inmediata no
dejaba al restaurante en caché como activo. Se agregaron esas pruebas.

**Solo se puede probar contra la base real (pendiente de Carlos):** el SQL 11 sobre el esquema verdadero; los códigos de error
reales de PostgREST (la transición sin tabla reconoce `PGRST205` y `42P01`); que `/auth/v1/user` acepte la llave secreta en
`apikey` con el JWT del usuario como Bearer (lo mide `supabase/diagnosticar-auth.mjs`, variante B; ver 12.12; si no
funciona, definir `SUPABASE_PUBLISHABLE_KEY` en Vercel: `api/_sesion.js` la usa si existe); que la caché del borde de Vercel
separe los dominios (se marcó `Vary: Host`; verifícalo con dos dominios antes de vender); un pago real con Wompi y el
WhatsApp real.

### 12.11 Riesgos para los siguientes prompts (páginas públicas y panel)

1. ~~**El front sigue siendo de Taqueiros.**~~ **Resuelto en la sección 14** para `index.html` y `pedido.html`: leen
   `/api/restaurante` (que ahora devuelve tarifas, ubicación y la llave **pública** del modo vigente, guardada en
   `config.publico.wompi`). `panel.html`, `menu-admin.html`, `historial.html` y `marca.js` siguen con la marca escrita (14.11).
2. ~~**`numero` vs `id`.**~~ **Resuelto en la sección 14.7**: WhatsApp, alertas, ticket, tablero, historial y seguimiento
   muestran `numero`.
3. **Valores por defecto transitorios siguen puestos** (`restaurante_id` y la regla del bucket). ~~`menu-admin.html` inserta
   sin `restaurante_id`~~ **Resuelto en la sección 15**: ahora lo manda siempre. Falta retirar el defecto (y entonces cualquier
   inserción que lo olvide falla en vez de caer en Taqueiros): 2B-4, ver 15.11.
4. ~~**El panel usa `restaurante_actual()`** (la primera membresía): un usuario con dos restaurantes necesita un selector.~~ **Resuelto en
   la sección 15**: el panel manda `p_restaurante` y filtra por `restaurante_id`; cada dominio abre su restaurante, sin selector.
5. **Realtime y `DELETE`** (riesgo 5 de la sección 9) sigue igual.
6. **Dominios:** cada dominio nuevo hay que agregarlo en Vercel **y** en `restaurante_dominios`; un preview de Vercel
   (`...vercel.app` distinto) no está registrado y solo sirve con `?r=`, que además exige `RESTAURANTE_POR_PARAMETRO=1`
   en las variables de **Preview** (sección 13, H4).
7. **`modo` de cobro de Taqueiros** sigue lo que mande su página hasta que se fije `otros.wompi_modo`.
8. **`?clave=` del cron** y el defecto transitorio no se retiraron (se pidió dejarlos).
9. **Anomalía de `restaurante_dominios` si se borra a mano:** el servidor usa la última resolución conocida hasta 6 h si
   Supabase falla; borrar un dominio no lo "desconecta" al instante en instancias con la caché (30 s) o en caída de la base.

### 12.12 Sesiones de usuario rechazadas contra la base real (causa, arreglo y por qué el falso no lo vio)

**Síntoma.** `probar-servidor-multirestaurante.mjs` contra la base real: 117 PASA y 10 FALLA, todas en REEMBOLSO, todas con
`401 {"error":"Inicia sesión para continuar"}` aunque el token fuera el de un dueño válido. Contra el Supabase falso pasaban.

**Causa (encontrada por lectura de `api/_supabase.js`, línea de `usuarioDeToken`).** Una guarda previa a la red escrita
`/s/.test(t)` en lugar de `/\s/.test(t)`: la barra del escape se perdió (la trampa de escapes de las herramientas ya
documentada) y el código descartaba **todo token que contuviera la letra "s"**. Un JWT real (~800 caracteres en base64url)
casi siempre la contiene (su propio encabezado `eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9` ya la lleva), así que ningún dueño
real pasaba la validación y ni siquiera se llamaba a Supabase. Las otras hipótesis quedaron descartadas por lectura:
la secreta ya iba solo en `apikey` (nunca como Bearer; lo decide `_llave.js`), no se verifica nada con un secreto local,
no se usa supabase-js en el servidor, el script de prueba crea el usuario por la API de administración confirmado y
entra con la publishable, y el 401 sale únicamente de `reembolso.js` cuando el helper devuelve `null`.
(`supabase/diagnosticar-auth.mjs` lo confirma con la base real: imprime si el token real contiene la "s".)

**Por qué el falso no lo detectaba.** Sus tokens eran `tok_<16 hex>`: 20 caracteres de `0-9a-f` y nunca una "s". Además no
imitaba las puertas del gateway real (aceptaba un Bearer desconocido, una `sb_secret_` como Bearer, o un token sin `apikey`).

**Arreglo.**
* `api/_sesion.js` (nuevo, UN solo lugar; lo usará también el panel de superadmin): `usuarioDeSolicitud(req)` /
  `usuarioDeToken(token)` llaman a `GET /auth/v1/user` con `apikey` = la publishable (`SUPABASE_PUBLISHABLE_KEY`, y si falta
  la secreta, **solo en `apikey`**) y `Authorization: Bearer <token del usuario>`. Solo se descartan antes de la red tokens
  vacíos, con espacios en blanco o de más de 4096 caracteres. 400/401/403 de Auth = "sin sesión"; **cualquier otro fallo
  (5xx, red caída, la llave del proyecto rechazada) lanza un error** y `reembolso.js` responde 500 con la causa en el log
  en vez de un 401 que mande al usuario a iniciar sesión otra vez.
* `api/_supabase.js` ya no define `usuarioDeToken`; `api/reembolso.js` usa el helper. Las reglas de autorización (dueño activo
  o superadmin, en el restaurante del host) y los filtros por restaurante no cambiaron.

**El falso miente menos** (`pruebas/multirestaurante/fake-supabase.mjs`): sus tokens tienen forma de JWT real (3 partes
base64url, ~790 caracteres, alg ES256); rechaza con 401 lo que rechaza el gateway real: petición sin `apikey` válida (el
token del usuario solo no basta, un JWT tampoco sirve de `apikey`), una `sb_secret_` como Bearer, un Bearer que no es una sesión
conocida, y un `Authorization` sin la palabra Bearer. **14 pruebas nuevas** (131 -> 145) en `escenarios-servidor.mjs` (grupo reembolso):
token real con "s" aceptado; cabeceras exactas que llegan a Auth (token del usuario en Authorization, llave del proyecto
en apikey, nunca la secreta como Bearer); sin la publishable usa la secreta solo en `apikey`; entradas que no llegan a la red;
token mal firmado = sin sesión; Auth caído / 5xx / llave rechazada = 500; y 4 de "falso realista" (solo con el falso). 11 mutaciones
nuevas en `mutaciones-servidor.mjs` (incluida la causa: `/s/` en lugar de `/\s/`): 11/11 detectadas.

**Diagnóstico con la base real:** `supabase/diagnosticar-auth.mjs` (usuario temporal `test-auth-<hex>@example.invalid`,
confirmado por la API de administración, borrado al terminar). Prueba 11 combinaciones de cabeceras contra `/auth/v1/user`
(A documentada … K), `supabase-js` `auth.getUser` con publishable y con secreta, y el helper real con y sin
`SUPABASE_PUBLISHABLE_KEY`. Imprime solo variante, HTTP y código de error. Se puede probar contra el falso:
`node pruebas/multirestaurante/contra-falso.mjs diagnosticar-auth.mjs`.

**Recomendación independiente del resultado:** define `SUPABASE_PUBLISHABLE_KEY` en Vercel (es la llave pública que ya está
en `supabase-publico.js`): es la forma documentada para validar sesiones y no depende de que la secreta sea aceptada en
`apikey` de Auth.

## 13. Revisión adversaria del servidor (segunda revisión, independiente)

Revisión hecha como atacante (dueño de un restaurante cliente o cliente final malicioso) de todo `api/`, los helpers, las
funciones SQL que llama el servidor, el simulador y las pruebas. Cada hallazgo corregido tiene una prueba en
`pruebas/multirestaurante/escenarios-servidor.mjs` (grupo `adversaria`, prefijo `H<n>`) que **falló antes** de la corrección
y pasa después, y una o más mutaciones en `mutaciones-servidor.mjs`. Nada cambió en las páginas HTML, `ticket-comanda.js` ni la
impresión, y Taqueiros se comporta igual (las únicas diferencias visibles están señaladas abajo).

### 13.1 Hallazgos corregidos (de mayor a menor severidad)

| # | Severidad | Dónde | Qué era y cómo se explotaba | Corrección |
|---|---|---|---|---|
| H1 | **Crítico** (con dinero real) | `api/webhook-wompi.js:149`, `api/generar-firma.js:58` | El webhook elegía el secreto según el `environment` **que trae el evento** y aprobaba cualquier pedido con un evento de prueba bien firmado. (a) Un pedido viejo creado cuando el restaurante estaba en prueba, todavía pendiente tras pasar a producción, se pagaba con una **tarjeta de prueba** y entraba a cocina. (b) `generar-firma` firmaba en prueba un pedido creado en producción (Taqueiros acepta todavía el modo del navegador): se abría el widget con la llave pública de prueba (está en `index.html`), se pagaba con la tarjeta 4242… y Wompi sandbox mandaba un evento de prueba legítimo. | El ambiente del evento debe coincidir con el `wompi_ambiente` del pedido **y** con el modo fijado del restaurante (`otros.wompi_modo`); si no, 200 e ignorado (sin reintentos de Wompi). `generar-firma` responde 409 si el modo pedido no es el del pedido. **Queda abierto** el caso de Taqueiros sin `wompi_modo` (pendiente P1). |
| H4 | **Alto** | `api/_restaurante.js:205` | `?r=<slug>` funcionaba en **cualquier** despliegue que no fuera producción. Los previews de Vercel son públicos por defecto (sus URL salen en los despliegues del repo público) y usan las mismas variables: la misma base y la llave secreta. Cualquiera con la URL de un preview operaba cualquier restaurante con `?r=`: pedidos basura en restaurantes aún no lanzados, enumeración de slugs, y el código de una rama sin revisar corriendo contra la base real. | `?r=` exige además `RESTAURANTE_POR_PARAMETRO=1` (y sigue apagado en producción aunque esté puesta). Ver P2 para cerrar el resto en la configuración de Vercel. |
| H2 | Medio | `api/webhook-wompi.js:168-209`, `api/_supabase.js` (`actualizarPedidoPorReferencia`) | Idempotencia solo por lectura previa. Dos entregas simultáneas del mismo evento aprobado mandaban **la comanda dos veces** (la cocina puede prepararla dos veces); un rechazo que leyó el pedido antes de una aprobación y escribía después dejaba un pedido **en cocina con el pago "rechazado"**. | Todas las escrituras del webhook son condicionales (`estado_pago=neq.aprobado`); si la aprobación no cambió ninguna fila, es un duplicado y no se avisa. |
| H5 | Medio | `api/alertas.js:48-131` | (a) Los pedidos de un restaurante sin contacto nunca se marcan; al cargarle el contacto, el cron le mandaba **todos los pedidos viejos** (10 cada 2 min). (b) Restaurantes en serie con envíos de hasta 8 s: un CallMeBot lento en uno pasaba del límite de Vercel (10 s en Hobby) y los restaurantes siguientes **nunca** recibían alertas (siempre los mismos). | Ventana de 2 h; 4 restaurantes en paralelo empezando por uno al azar; no se empiezan envíos pasados 8 s y cada envío se acorta a lo que queda; lo que falta sale en la siguiente pasada (`sinRevisar` en la respuesta). |
| H6 | Medio (si CallMeBot repite la apikey; no verificado con el servicio real) | `api/_notificar.js:262-270` | El detalle del error de CallMeBot (los últimos 160 caracteres de su respuesta, o el mensaje de un error de red) se guardaba en `salud_notificaciones.ultimo_error` (lo lee **todo** el personal del restaurante, no solo el dueño) y en el log de Vercel. Si traía la apikey, quedaba expuesta (con ella se pueden mandar comandas falsas a ese WhatsApp). | Se tacha la apikey (tal cual y codificada) del detalle antes de guardarlo o imprimirlo. |
| H7 | Medio | `api/crear-pedido.js:43-52`, `api/_notificar.js:130-157` | Un salto de línea en el **nombre** (o en las indicaciones) fabricaba en la comanda de WhatsApp una línea con la forma exacta de un producto (`9x Taco de A — 90.000`): la cocina lo preparaba sin estar pagado. También se aceptaban caracteres invisibles y de dirección (bidi) para disfrazar texto. | Al crear el pedido se quitan controles, ancho cero y bidi de todos los textos; nombre, teléfono, dirección y barrio quedan en una línea; las indicaciones conservan sus saltos (el ticket las imprime como notas) pero en WhatsApp **cada línea** lleva 📝. **Diferencia visible:** una indicación de varias líneas llega a WhatsApp con 📝 en cada línea. |
| H8 | Bajo | `api/crear-pedido.js:130` | Sin tope de líneas por pedido (miles de líneas por petición: base y comandas infladas). Las cantidades sí estaban bien validadas (1 a 50, enteras; ahora con prueba). | Máximo 100 líneas (400). |
| H3 | Bajo (defensa en profundidad) | `api/webhook-wompi.js:183` | El monto se comparaba redondeado a pesos (50 centavos menos pasaban) y no se miraba la moneda. No explotable hoy porque la firma de integridad de Wompi ata monto y moneda. | Centavos exactos y moneda `COP`. |
| H9 | Bajo | `api/_sesion.js:59` | Un token con caracteres fuera de Latin-1 hacía lanzar a `fetch` y el reembolso respondía 500 (con ruido en el log) en vez de 401. | Fuera de ASCII imprimible = sin sesión, sin llegar a la red. |
| H10 | Bajo | `api/restaurante.js:51` | `/api/restaurante` (público) decía `gracia`/`en_gracia`: cualquiera (clientes, competencia) sabía que el restaurante está **atrasado con la mensualidad**. | En gracia responde `activo` (sigue recibiendo pedidos). Si el panel necesita avisar de la gracia, debe salir de un endpoint con sesión. |

**Otras mejoras de las pruebas (no son hallazgos del servidor):** el espía de URLs ahora también rechaza RPC distintas de
`limpiar_pedidos_huerfanos`, filtros `or=`/`and=` y `select` embebidos (joins) — formas de esquivar el filtro que antes no
veía — y cualquier `PATCH` que cambie `restaurante_id` (la llave secreta pasa el trigger que lo impide). El arnés puede retener
una petición a la base (para provocar carreras) y simular errores de red de CallMeBot. Pruebas nuevas de cobertura (pasaban
antes): cantidades inválidas, recorte de textos largos, copia vieja de la resolución vencida a las 6 h, alerta que no se repite,
cron sin `CRON_SECRET`, checksum en mayúsculas (así lo manda Wompi) y de otro largo.

### 13.2 Revisado sin hallazgo

* **Filtro por restaurante:** cada consulta, escritura y RPC de `api/` (incluidos los helpers) lleva `restaurante_id` o es una de
  las excepciones comentadas (búsqueda global por referencia del webhook, `limpiar_pedidos_huerfanos`, tablas que no son de
  negocio). No hay consultas armadas con datos de la petición sin validar ni joins. El servidor no llama `reclamar_impresion`,
  `registrar_reimpresion`, `seguimiento` ni `buscar_mis_pedidos`; las dos primeras dependen de `auth.uid()` y con la llave
  secreta **fallan cerradas** ("No autorizado"): el servidor nunca debe usarlas. `siguiente_numero_pedido` es atómica por
  restaurante y `asignar_numero_pedido` ignora un número que mande un cliente.
* **Resolución del host:** mayúsculas, punto final, puerto, punycode (válido), Unicode/vacío/repetido (404 sin consultar),
  `x-forwarded-host` ignorado, subdominios anidados (404), `DOMINIO_BASE` sin definir (no resuelve por subdominio). La copia
  vieja cuando Supabase falla no salta una suspensión: `crear-pedido` y `generar-firma` releen el restaurante sin caché y, con la
  base caída, fallan (500).
* **Webhook:** secretos del restaurante del pedido, comparación en tiempo constante, referencia desconocida = firma mala (401;
  Wompi reintenta 3 veces y luego desiste, sin efectos), un dueño con sus propios secretos no puede aprobar pedidos de otro.
* **Reembolso y sesión:** autorización contra el restaurante del host (dueño activo o superadmin); cambiar el Host o el cuerpo no
  sirve; doble reembolso imposible; cabeceras `Authorization` repetidas las descarta Node; otros esquemas (Basic) = sin sesión;
  token vencido, de usuario borrado o de sesión cerrada = 401/403 de Auth = sin sesión; 5xx/429/red = 500.
* **Cachés:** el respaldo del menú es por restaurante; las respuestas con datos llevan `Vary: Host` y las de error `no-store`;
  `/api/restaurante` es `no-store`. `sw.js` solo cachea `/Recursos/` y fuentes, por origen (nada de datos ni de `/api/`).
* **Escapes perdidos (como `/s/` por `/\s/`):** se revisaron todas las expresiones regulares de `api/`, `supabase/` y las pruebas
  con un script; la única `/s/` está en `diagnosticar-auth.mjs` y es a propósito. **Trampa nueva encontrada al corregir:** la
  herramienta de edición convirtió escapes `\u200B`–`\uFEFF` en caracteres invisibles **crudos** dentro del fuente (funcionaba
  igual, pero dejaba caracteres bidi ocultos); se reescribieron como escapes y se verificó que ningún archivo los tenga.

### 13.3 Las 6 mutaciones "equivalentes": veredicto

| Mutación | Veredicto |
|---|---|
| `buscarPedidoPorReferenciaGlobal` acepta referencias repetidas | **Confirmada**: `referencia` es `unique` en `schema.sql`. Depende de que la base real tenga esa restricción (ver 13.5, paso 3). |
| `listarRestaurantes` sin orden estable | **Confirmada**: el orden no importa (y ahora el cron empieza por uno al azar a propósito). |
| Subdominio sin validar el formato del slug (una capa) | **Confirmada**: `buscarRestaurantePorSlug` lo vuelve a validar antes de consultar. |
| Subdominio sin validar en ninguna capa | **Confirmada, con matiz**: el valor entra sin codificar a `slug=eq.`, pero solo puede traer `[a-z0-9.-]` (lo garantiza `normalizarHost`) y el `CHECK` del slug prohíbe el punto: ni inyección ni coincidencia. |
| Reembolso sin la comprobación de estado de `reembolso.js` | **Confirmada**: el `PATCH` condicional repite las condiciones; la respuesta sigue siendo 409 (otro texto). |
| Tarifas sin `sort` | **Confirmada**: `order=hasta.asc` sobre `numeric(6,1)` (orden numérico, no de texto). |

Dos candidatas que **parecían** equivalentes no lo eran y ahora tienen prueba: quitar el `toUpperCase()` de la comparación de la
firma rompería **todos** los pagos reales (Wompi manda el checksum en mayúsculas; las pruebas usaban minúsculas) y quitar la
comparación de largos cambia un 401 por un 500. Se declararon 3 equivalentes nuevas, con su razón en el archivo: `Bearer` sin
`^`, un id de Auth que no es UUID y quitar la comprobación de duplicado por lectura del webhook (desde H2 la escritura
condicional es la segunda capa; quitar las dos **sí** se detecta). La corrida también encontró dos pruebas mías que no
distinguían lo que decían probar (alertas en serie y la apikey codificada en la URL); se corrigieron antes de entregar.
Corrida final de `mutaciones-servidor.mjs`: **149 detectadas, 9 equivalentes, 0 sobrevivientes, 0 errores**. Batería local:
`servidor.mjs` 167/167; `probar-servidor-multirestaurante.mjs` contra el falso 154/154.

### 13.4 Pendientes de seguridad

| # | Severidad | Pendiente | Qué hacer |
|---|---|---|---|
| P1 | ~~**Crítico** el día que Taqueiros cobre de verdad~~ **Resuelto en la práctica (sección 14)**; queda un residuo bajo | Taqueiros sin `otros.wompi_modo` sigue aceptando el modo del navegador: un cliente crea el pedido en "pruebas" y lo paga con tarjeta de prueba (el pedido nace en prueba, así que H1 no lo frena). **Ya no hay `WOMPI_MODE` en `index.html`**: la página usa la llave de producción solo si el servidor dice `produccion`, y eso solo ocurre si `otros.wompi_modo` está fijado (y entonces el servidor ignora el modo del navegador). | Para cobrar de verdad: `cargar-secretos.mjs --slug=taqueiros` con `WOMPI_MODO=produccion` (13.5, paso 2, ya **sin** editar `index.html`). Luego retirar del código el respaldo "modo del navegador" de Taqueiros. |
| P2 | **Alto** (configuración) | Los despliegues de Preview reciben la llave secreta y la base real: corren código de cualquier rama contra datos reales, aunque `?r=` ya no esté. | En Vercel → Settings → Environment Variables, dejar `SUPABASE_SERVICE_ROLE_KEY`, `WOMPI_*`, `CALLMEBOT_*` y `CRON_SECRET` **solo en Production**; activar Deployment Protection (Vercel Authentication) para Preview. Si hace falta probar en preview, usar otro proyecto de Supabase. |
| P3 | ~~**Alto** (antes del 2.º restaurante)~~ **Resuelto (sección 14.7)** | `numero` vs `id`: WhatsApp, panel, ticket y seguimiento mostraban `id`. | Hecho: todo lo visible usa `numero` (se prueba con `numero ≠ id`). |
| P4 | Medio | Sin límite de peticiones por IP ni por restaurante en `crear-pedido`/`generar-firma` (ni en `buscar_mis_pedidos`, que inserta un intento por llamada). Un atacante crea miles de pedidos pendientes: consume números de pedido, llena la base compartida (plan gratuito: 500 MB, cae para todos) y multiplica las consultas a Nominatim (riesgo de bloqueo de la IP de Vercel). | Regla de rate limit en el Firewall de Vercel para `/api/crear-pedido` y `/api/generar-firma` (p. ej. 10 por minuto por IP). Decidir el tope por restaurante es de negocio (horas pico). |
| P5 | Medio | Que la caché del borde de Vercel separe dominios (se marcó `Vary: Host`; ya estaba pendiente). | Probar con dos dominios reales antes de vender (`x-vercel-cache` y el menú de cada uno). |
| P6 | Bajo | `wompi_transaction_id` no es único y la firma de Wompi no incluye la referencia: un evento aprobado **real** reenviado con otra referencia del mismo restaurante y el mismo monto la aprobaría. Solo puede hacerlo quien ve los cuerpos de los eventos (Wompi o el propio restaurante, que ya tiene su secreto). | Índice único parcial sobre `wompi_transaction_id`, o consultar la transacción a la API de Wompi antes de aprobar (función nueva). |
| P7 | Bajo | Un evento `VOIDED` (anulación) después de aprobado se ignora como duplicado: el pedido sigue "aprobado". | Decisión de negocio (cómo reflejar anulaciones/reembolsos de Wompi). |
| P8 | Bajo | El webhook espera hasta 8 s a CallMeBot; con Hobby (10 s) puede cortarse: el pedido ya quedó aprobado (el reintento de Wompi se corta como duplicado) pero `notificacion_ok` puede quedar vacío. | Aceptado; el panel es el canal principal. |
| P9 | Bajo | Sesiones para el futuro panel de superadmin: un usuario **baneado** en Auth conserva su token hasta que vence (~1 h); `_sesion.js` no mira MFA (`aal`); si se activan los inicios de sesión anónimos, dan sesiones válidas. | Autorizar siempre por tabla (`superadmins`/`miembros`, se mira en cada petición) y quitar de ahí para revocar al instante; exigir `aal2` en el panel de superadmin. |
| P10 | Bajo | El log de Vercel guarda datos personales (errores de PostgREST con "Failing row contains (...)", nombres y referencias). | Tratar el acceso al log de Vercel como acceso a datos de clientes. |
| P11 | Bajo | Si dos restaurantes cargan el mismo secreto de eventos (misma cuenta de Wompi), cada dueño puede aprobar pedidos del otro. | No compartir cuentas de Wompi entre restaurantes; (futuro) que `cargar-secretos.mjs` avise de secretos repetidos. |
| P12 | Bajo | Con `DOMINIO_BASE` (comodín), subdominios inventados: cada uno es una consulta (caché negativa de 10 s) y desplaza entradas buenas de la caché de 500; y 200/404 revela qué slugs existen (inherente: son sitios públicos). | Aceptado. |
| P13 | Bajo | Ventana de milisegundos entre la relectura del restaurante y el insert: un pedido puede entrar justo al suspender. `seguimiento(ref)` sigue siendo global por referencia (impredecible); `?clave=` del cron sigue aceptándose. | Aceptado / tarea del front (ya listados en 12.11). |

### 13.5 Qué correr (Windows) y qué cambia en Vercel

Nada de esto toca la base real salvo el paso 3 (solo lectura) y el 2 (solo cuando decidas cobrar de verdad).

1. **Vercel (P2 y H4):** si alguna vez quieres probar un preview con `?r=`, agrega `RESTAURANTE_POR_PARAMETRO` = `1` **solo**
   en el entorno *Preview*. Revisa que las llaves estén marcadas solo para *Production* (P2).
2. **Antes de cobrar de verdad en Taqueiros (P1):** en PowerShell, en la carpeta del proyecto:

   ```powershell
   $k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
   $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
   $env:WOMPI_MODO = "produccion"
   node supabase/cargar-secretos.mjs --slug=taqueiros --solo-verificar
   node supabase/cargar-secretos.mjs --slug=taqueiros
   Remove-Item Env:WOMPI_MODO, Env:SUPABASE_SERVICE_ROLE_KEY
   ```

   (si dice `DIFERENTE a la base`, repite el último `node` con `--sobrescribir`). Los secretos **prod** de integridad y de
   eventos deben existir (en la base o, para Taqueiros, en las variables de Vercel): sin ellos no se podrá cobrar. Solo
   después cambia `WOMPI_MODE` en `index.html`.
3. **Comprobar la restricción única de `referencia` en la base real** (SQL Editor, "Run without RLS", solo lectura):

   ```sql
   select conname, pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.pedidos'::regclass and contype = 'u';
   ```

   Debe aparecer `UNIQUE (referencia)`.
4. **Prueba del servidor contra la base real** (como en 12.9 paso 5): `node supabase/probar-servidor-multirestaurante.mjs`.
   Ahora son más escenarios (≈154 contra el falso en modo real); todos deben decir `PASA`.

---

## 14. Frontend público multi-restaurante (SQL 12)

Hasta la sección 13 el **servidor** ya era multi-restaurante, pero las páginas públicas seguían siendo de Taqueiros:
tenían escritos a mano su nombre, colores, logo, textos, WhatsApp, coordenadas, tarifas, llave pública de Wompi y
`WOMPI_MODE`, y mostraban `pedidos.id` en vez de `pedidos.numero`. Esta sección es ese trabajo: `index.html`,
`pedido.html`, el manifest de la PWA y todo lo que muestra el número de pedido leen sus datos del restaurante que resuelve
el servidor por el dominio. **Taqueiros se ve igual** (se comprueba, ver 14.10). El panel de administración
(`panel.html`, `menu-admin.html`, `historial.html`, `marca.js`) se adapta en el paso siguiente; aquí solo cambió lo que
muestra el número de pedido.

### 14.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `supabase/12-config-publica.sql` (nuevo) | Mezcla en `restaurantes.config` de Taqueiros los valores que estaban escritos a mano (no pisa nada); agrega `pedidos.token_seguimiento` y `pedidos.enlace_por_referencia` (sin `UPDATE`); `seguimiento(ref)` y `buscar_mis_pedidos(...)` devuelven `numero` y el token; trigger que impide cambiar el token desde el navegador. Atómico, idempotente, 24 comprobaciones OK/FALLA, apto para "Run without RLS". |
| `api/_publico.js` (nuevo) | Arma la respuesta pública **campo por campo y validando** (colores `#RRGGBB`, URLs, teléfonos, textos). Es la única puerta de datos hacia el navegador. |
| `api/restaurante.js` | Devuelve marca, textos, contacto, ubicación, tarifas de domicilio, módulos, servicio y el modo/llave **pública** de pago (14.4). |
| `api/_respaldo-taqueiros.js` (nuevo) | La **única** copia que queda en el código de los valores de Taqueiros: solo para Taqueiros y solo para lo que su `config` aún no trae (campo por campo), con aviso en el log. Se puede borrar cuando el SQL 12 esté corrido. |
| `api/manifest.js` (nuevo) + `vercel.json` | El manifest de la PWA es por restaurante: `/manifest.json` se reescribe a `/api/manifest`. El archivo estático `manifest.json` se eliminó (en Vercel un archivo estático gana a una reescritura). |
| `restaurante-publico.js` (nuevo) | Librería compartida por `index.html` y `pedido.html`: carga `/api/restaurante`, **re-valida**, aplica colores y logos, textos neutros, pantalla de "sin restaurante", almacenamiento por restaurante. |
| `index.html`, `pedido.html` | Sin ningún valor de un restaurante escrito. Se pintan con los datos que llegan (14.5). |
| `sw.js` v9 | No precachea nada; el manifest va siempre por la red; sube la versión (14.6). |
| `api/crear-pedido.js` | Además devuelve `tokenSeguimiento` (14.8). Nada más cambió. |
| `api/_notificar.js`, `api/alertas.js` | La comanda y la alerta de WhatsApp llevan `pedidos.numero` (14.7). |
| `ticket-comanda.js`, `panel.html`, `historial.html` | Muestran `numero` (14.7). El diseño del ticket y de la impresión **no** cambió. |

### 14.2 Inventario de los valores de Taqueiros que estaban escritos a mano

| Valor | Antes | Ahora |
|---|---|---|
| Nombre (título, cabecera, pie, alt, mensajes, tooltip del mapa, texto del WhatsApp) | `index.html`, `pedido.html`, `manifest.json` | `restaurantes.nombre` |
| Título y descripción de la página | `index.html` | `config.publico.textos.titulo_pagina` / `descripcion_pagina` (el seguimiento los arma con el nombre) |
| Logo y favicon | `Recursos/logo/logo.png` en 5 sitios | `config.publico.marca.logo` (favicon = logo) |
| Íconos de la PWA | `manifest.json` | `marca.icono_192` / `icono_512` (si faltan, el logo) |
| 10 colores de marca + `texto_tenue` y `positivo_brillo` (pedido) | `:root` de `index.html` y `pedido.html` | `marca.colores.*` → variables CSS. Las transparencias (`rgba(…)`) pasaron a `rgba(var(--x-rgb), …)` con el mismo resultado |
| Colores de las zonas del mapa | `COLORES_ZONA` | `marca.colores_zonas` |
| Emoji (🌮 en confirmación, mapa, carrito vacío, WhatsApp, menú caído, botón "Ver el menú") | repartido en el código | `marca.emoji` (neutro: 🍽️) |
| Eslogan, texto de portada, texto del pie, línea de servicios, cierre del pie, ejemplo de nota | `index.html` | `textos.eslogan`, `tagline`, `descripcion_pie`, `servicios_linea`, `pie_final`, `ejemplo_nota` |
| Banner de abierto/cerrado ("¡Estamos que ardemos!…") | `index.html` | `textos.banner_abierto_*`, `banner_cerrado_*` |
| Tiempos y frases del seguimiento ("Ya está en el comal…") | `pedido.html` | `textos.seguimiento.*` |
| WhatsApp (botones, pie, mensajes, seguimiento) | `WHATSAPP_NUMBER` en 2 páginas | `contacto.whatsapp` |
| Teléfono visible, dirección, dirección corta (retiro), ciudad y región (Wompi), Instagram y TikTok | `index.html`, `pedido.html` | `contacto.*` |
| Coordenadas del local | `RESTAURANTE` | `config.ubicacion` (el mismo dato que ya usaba el servidor) |
| Tarifas de domicilio | `TARIFAS_DOMICILIO` | `tarifas_domicilio` (tabla) → `domicilio.tarifas` |
| Factor de recorrido, área y pin mínimo | `FACTOR_RECORRIDO`, `api/_ubicacion.js` | `config.domicilio` |
| Llave pública de Wompi (test y prod) | `WOMPI_PUBLIC_KEY` | `config.publico.wompi` → solo sale la del modo vigente |
| `WOMPI_MODE` | `index.html` | `restaurante_secretos.otros.wompi_modo` (lo decide el servidor) |
| URL de retorno de Wompi | `https://taqueiros-2-0.vercel.app/?pago=exitoso` | `location.origin + "/?pago=exitoso"` |
| Horarios de respaldo (`SCHEDULE`) | `index.html` | **eliminado**: el horario sale de `/api/estado` (sin respuesta no se inventa) |
| Nombre y descripción de la PWA | `manifest.json` | `/api/manifest` (`config.publico.pwa`, `marca.colores`) |
| Claves de `localStorage` | `taqueiros-*-v1` | `menu-v2`, `carrito-v2`, `seguimiento-v2`, `pedido-pendiente-v2` (genéricas y con el id del restaurante dentro) |

Residuos que **no** son datos de un restaurante y se dejaron (documentados): las tipografías (Anton / Fredoka / Libre
Franklin), unos cuantos grises cálidos de interfaz (`#5a4a3a`, `#8a7a63`, `#6b5c4c`, `#150d0b`, `#e9dcbb`…) que no son
colores de marca, el nombre del objeto global `TAQUEIROS_SUPABASE` (de `supabase-publico.js`, compartido con el panel) y el
pie `LOS TAQUEIROS · PEDIDO WEB` del ticket impreso (`ticket-comanda.js`), que es del panel (paso siguiente).

### 14.3 Forma del JSON de configuración (`restaurantes.config`)

El dueño edita `nombre` y `config`; el resto de la fila es de Carlos. `config` es un objeto; **solo** lo de abajo llega al
navegador, y solo validado. Todo es opcional: lo que falta se ve neutro.

```jsonc
{
  "publico": {                                  // lo que puede ver el navegador
    "marca": {
      "logo": "Recursos/logo/logo.png",         // ruta del sitio o https del Supabase del proyecto (Storage)
      "icono_192": "...", "icono_512": "...",   // PWA; si faltan se usa el logo
      "emoji": "🌮",                            // hasta 8 caracteres
      "colores": {                              // #RRGGBB exacto; lo inválido se descarta
        "primario": "#C1272D", "primario_oscuro": "#8A1B1F", "primario_brillo": "#E14A42",
        "claro": "#F7ECD6", "claro_suave": "#FFF8EA", "oscuro": "#1C1210", "oscuro_2": "#241714",
        "acento": "#E3A008", "positivo": "#5C7A3B", "texto_secundario": "#D9C9A8",
        "texto_tenue": "#B9A88C", "positivo_brillo": "#7FA855"
      },
      "colores_zonas": ["#5C7A3B", "#8FA83F", "#E3A008", "#E07B39"]   // hasta 8
    },
    "textos": {                                 // texto plano de una línea, hasta 400 caracteres
      "titulo_pagina": "...", "descripcion_pagina": "...", "eslogan": "...", "tagline": "...",
      "descripcion_pie": "...", "servicios_linea": "...", "pie_final": "...", "ejemplo_nota": "...",
      "banner_abierto_icono": "🔥", "banner_abierto_titulo": "...",
      "banner_abierto_texto": "Ahorita sí estamos atendiendo pedidos{cierre}. ...",   // {cierre} = " — hoy hasta las 10:30 p. m." o vacío
      "banner_cerrado_icono": "🌮", "banner_cerrado_mensaje": "...",                   // si el dueño no escribió su mensaje de cerrado
      "seguimiento": {                          // pedido.html; hasta 200 caracteres
        "tiempo_nuevo": "...", "tiempo_preparacion": "...", "tiempo_camino": "...",
        "tiempo_recoger": "...", "tiempo_entregado": "...",
        "frase_nuevo": "...", "frase_preparacion": "...", "frase_camino": "...",
        "frase_recoger": "...", "frase_entregado": "..."
      }
    },
    "contacto": {
      "whatsapp": "573125249438",               // solo dígitos (8 a 15); sin él no hay botones de WhatsApp
      "telefono": "+57 312 524 9438", "direccion": "...", "direccion_corta": "...",   // la corta sale en el seguimiento (retiro)
      "ciudad": "...", "region": "...",         // los usa el widget de Wompi
      "instagram": "usuario", "tiktok": "usuario"       // sin @; letras, números, punto y guion bajo
    },
    "wompi": {                                  // llaves PUBLICAS (pub_...): públicas por diseño
      "llave_publica_test": "pub_test_...", "llave_publica_prod": "pub_prod_..."
    },
    "pwa": { "nombre": "Panel Taqueiros", "nombre_corto": "Comandas" }   // manifest; por defecto "Panel <nombre>" / "Comandas"
  },
  "ubicacion": { "lat": 7.8997382, "lng": -72.4968525 },                 // origen del domicilio (no sale tal cual: ver 14.4)
  "domicilio": { "factor_recorrido": 1.3, "pin_minimo_metros": 100,
                 "area": { "latMin": 7.75, "latMax": 8.1, "lngMin": -72.68, "lngMax": -72.35 } }   // ya los usa el servidor
}
```

Reglas: la llave pública del modo vigente solo se entrega si es del tipo del modo (`pub_test_` para prueba, `pub_prod_`
para producción) y el servidor tiene el secreto de integridad para firmar; **nunca** se guarda aquí una llave privada, un
secreto de integridad/eventos ni una apikey (el SQL 12 se detiene si encuentra algo así en la config de Taqueiros). Las
imágenes: ruta relativa del sitio (sin `..`, sin `//`, sin `:`) o `http(s)` del origen del Supabase del proyecto; ninguna
otra. El nombre del restaurante es `restaurantes.nombre` (columna), no va aquí.

### 14.4 `/api/restaurante`: la respuesta

```jsonc
{ "id": "...", "slug": "...", "nombre": "...", "zona_horaria": "America/Bogota", "moneda": "COP",
  "modulos": { "pasarela": true, "seguimiento": true, "comandas": true, "impresion": true },
  "servicio": { "estado": "activo" | "suspendido", "sirve": true, "motivo": null | "servicio_suspendido" },
  "marca": { "logo", "icono_192", "icono_512", "emoji", "colores": {...}, "colores_zonas": [...] },
  "textos": { ..., "seguimiento": {...} },
  "contacto": { "whatsapp", "telefono", "direccion", "direccion_corta", "ciudad", "region", "instagram", "tiktok" },
  "ubicacion": { "lat", "lng" } | null,
  "domicilio": { "ofrece": true, "factor_recorrido": 1.3, "tarifas": [{ "hasta": 2, "precio": 5000 }, ..., { "hasta": 999, "precio": null }] },
  "pago": { "disponible": true, "pasarela": "wompi", "modo": "test" | "produccion" | null, "llave_publica": "pub_..." | null } }
```

* **Nunca** devuelve plan, modalidad de pago, vigencia, días de gracia (en gracia dice `activo`), el resto de `config`,
  ni nada de `restaurante_secretos` (se consulta solo **si hay** modo y secreto de integridad; no se devuelve ni se guarda),
  ni de `miembros`. `Cache-Control: no-store`.
* Un restaurante **sin tarifas o sin ubicación** no ofrece domicilio (`ofrece: false`): la página esconde esa opción.
* **El modo de cobro y la llave los decide el servidor** (`otros.wompi_modo`; `modoDePago` sin el modo del navegador). Para
  Taqueiros sin `wompi_modo` el resultado es `test` (lo mismo que decía `WOMPI_MODE = "pruebas"`). Otro restaurante sin
  `wompi_modo` queda con `pago.disponible = false`: solo se ve el menú y WhatsApp.
* La página manda a `crear-pedido` el mismo modo que el servidor le dijo (nunca uno elegido por ella).

### 14.5 Cómo se pinta el front

1. La página se abre con una **pantalla de carga** (tapa todo) y pide `/api/restaurante`. Si llega: se aplican colores
   (variables CSS), logos, textos, enlaces y módulos, y se quita la pantalla. Un `?r=<slug>` en la URL (previews, ver 12.2)
   se reenvía a todas las llamadas a la API; en producción el servidor lo ignora.
2. Si **falla** (dominio desconocido, servidor caído, respuesta inválida) la pantalla se convierte en un **mensaje neutro**
   ("Este sitio no está disponible" con 404; "No pudimos cargar la página" + *Reintentar* con otro fallo), con paleta neutra
   y sin un solo dato de ningún restaurante, tampoco de Taqueiros. Nunca hay valores por defecto de otro restaurante.
3. **Servicio suspendido:** el menú se ve; se esconden "Pagar en línea" y "Pedir por WhatsApp" y aparece el mensaje neutro
   "Este restaurante no está recibiendo pedidos en este momento." (sin hablar de la mensualidad). `crear-pedido` además
   responde 403 `servicio_suspendido`, y la página lo trata igual.
4. **Módulos** (`modulos`): sin `seguimiento` se esconden "Mi pedido", "¿Buscas tu pedido?", el banner y el enlace de la
   confirmación, y `pedido.html` avisa que no está disponible; sin `pasarela` (o sin llave/secreto) no hay "Pagar en línea";
   sin WhatsApp no hay botones de WhatsApp; sin domicilio configurado no se ofrece domicilio. No se inventan flujos nuevos.
5. **Seguridad.** Todo dato que viene de la base se inserta con `textContent` o con atributos ya validados; nunca con
   `innerHTML` (incluidos el mensaje de "cerrado", los días del horario y el tooltip del mapa, que antes eran HTML crudo).
   Los colores se validan con `^#[0-9A-Fa-f]{6}$` en el servidor **y** en el navegador y se aplican con `setProperty`; las
   imágenes solo son rutas del sitio o del origen del Supabase del proyecto (nada de `javascript:` ni `data:`); WhatsApp,
   redes y llaves por formato. Verificado en el navegador con datos hostiles (14.10).
6. **Almacenamiento del navegador.** `localStorage` es **por origen** (esquema + dominio + puerto): dos restaurantes en dos
   dominios no comparten nada (confirmado en las pruebas con `alfa.localhost` y `beta.localhost`). Aun así el menú de
   respaldo, el carrito, el seguimiento y el resumen del pago pendiente se guardan con el id del restaurante y se descartan si
   no coincide (un mismo origen que sirviera a dos restaurantes, como un preview con `?r=`, tampoco los mezcla). Las claves
   viejas `taqueiros-*-v1` ya no se leen: un cliente con un carrito a medio armar en el momento del despliegue lo verá vacío
   una sola vez.
7. **Lo que cambió a propósito para Taqueiros** (todo lo demás es idéntico): los pedidos *nuevos* se siguen por un enlace con
   token (14.8); sin respuesta de `/api/estado` el banner de horario no se inventa (antes mostraba un horario escrito en el
   código) y se deja pedir (el servidor valida el horario al crear el pedido); el mensaje de "cerrado", los días del horario
   y el nombre ya no se pegan como HTML.

Limitación conocida: el título y la descripción los pone JavaScript, así que una vista previa de enlace (WhatsApp, redes)
que no ejecuta JS verá el título neutro "Pedidos en línea". Si importa, el siguiente paso es servir `index.html` desde una
función que inyecte `<title>` y las etiquetas `og:` según el dominio.

### 14.6 PWA y service worker

* `/manifest.json` lo sirve `api/manifest.js` según el dominio (nombre, nombre corto, descripción, colores e íconos del
  restaurante, validados igual que en 14.4). Host desconocido: 404 con el mismo cuerpo que el resto. Taqueiros recibe
  **exactamente** el manifest de antes (se compara en las pruebas).
* `sw.js` v9: **no precachea nada** (ni el manifest, que ahora cambia por restaurante, ni un logo fijo); `/manifest.json`,
  `/api/*` (incluidos `/api/restaurante` y `/api/menu`), Supabase y las páginas van **siempre por la red**. Solo se guarda lo
  que se pide bajo `/Recursos/` y las fuentes, y el caché es por origen (un dominio nunca ve el de otro). Al subir la versión
  se borran las cachés `taqueiros-panel-v8` que traían precacheados el manifest y el logo de Taqueiros.
* `panel.html` sigue enlazando `/manifest.json`: no hubo que tocarlo.

### 14.7 Número de pedido: `numero`, no `id`

`id` es la secuencia de **toda** la tabla (compartida por todos los restaurantes); `numero` es el contador de **cada**
restaurante. Con un solo restaurante coinciden (salvo huecos); con el segundo divergen. Ahora todo lo que ven el cliente o el
personal usa `numero` (si una fila no lo trae, por seguridad se usa el `id` para no imprimir `#undefined`); las operaciones
internas siguen usando `id`.

| Dónde | Antes | Ahora |
|---|---|---|
| "¿Buscas tu pedido?" (`buscar_mis_pedidos`) | devolvía `p.id` como `numero` | devuelve `p.numero` (SQL 12) |
| Seguimiento (`seguimiento(ref)` → `pedido.html`) | `p.id` como `numero` | `p.numero` (SQL 12) |
| Comanda de WhatsApp y alerta "sin atender" | `pedido.id` | `pedido.numero` |
| Ticket de comanda, reimpresión, prueba (`ticket-comanda.js`) | `p.id` | `p.numero` |
| Tablero, avisos y cronómetros del panel (`panel.html`) | `p.id` | `p.numero` |
| Historial (`historial.html`; `buscar_historial` ya devolvía la fila completa) | `p.id` | `p.numero` |
| Confirmación del pedido (`index.html`) | muestra la **referencia** (nunca mostró un número) | sin cambio (a propósito: es lo que ve hoy Taqueiros) |

Prueba de que **la impresión no cambió**: `node pruebas/impresion/comparar-tickets.mjs` imprime los mismos 7 tickets
(normal, 12 productos con notas largas, nombres y direcciones largos, ñ y tildes, HTML hostil, reimpresión, prueba) con el
panel de `debc1c5` y con el de ahora y compara el HTML letra por letra: **7 de 7 idénticos** (solo se normalizan las horas).
Además hay pruebas unitarias (con `numero = id` el ticket es idéntico) y el escenario 21 del e2e (con `numero ≠ id` el
tablero, el ticket y la reimpresión muestran el número).

### 14.8 Enlace de seguimiento: decisión

**Hallazgo.** El enlace no usa un id secuencial: usa la referencia `TAQ-<milisegundos>-<6 hex>`. No es adivinable en la
práctica (sin saber el milisegundo exacto hay ≈10¹² combinaciones por minuto), pero solo tiene 24 bits de azar y su
parte temporal es predecible; `seguimiento` no tiene límite de intentos. Severidad: **baja**, pero es la puerta a la
dirección, las indicaciones y los productos de un cliente.

**Corrección aplicada (SQL 12).** `pedidos.token_seguimiento`: 32 caracteres hexadecimales al azar (un UUID v4 sin guiones,
122 bits), único e inmutable desde el navegador. `crear-pedido` lo devuelve (`tokenSeguimiento`), la confirmación, el banner
y "¿Buscas tu pedido?" arman el enlace con él, y `seguimiento(ref)` abre un pedido por su token. **Compatibilidad:**
`pedidos.enlace_por_referencia` vale `true` en los pedidos que ya existían (su enlace de siempre, la referencia, **sigue
funcionando**; además reciben su token) y `false` en los nuevos (la referencia sola ya no abre nada). Las columnas se
agregan sin `UPDATE` (sin triggers ni eventos de Realtime). Ni `seguimiento` ni `buscar_mis_pedidos` cambiaron de firma (el
SQL 10 las conoce por su firma y la comprobación "ninguna función SECURITY DEFINER desconocida" sigue valiendo).

Costos y límites, a la vista: (1) una pestaña de un cliente abierta **antes** del despliegue que cree un pedido después del
SQL 12 verá "No encontramos ese pedido" en el seguimiento hasta recargar (el pedido llega igual al restaurante, y
"¿Buscas tu pedido?" le da el enlace bueno); por eso conviene correr el SQL 12 justo después de desplegar. (2) El personal
del restaurante (que ya ve teléfono y dirección de sus clientes) también lee el token en su panel. (3) No se agregó límite de
intentos a `seguimiento` (con 122 bits no hace falta; el límite por IP sigue siendo el pendiente P4).

### 14.9 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. Las llaves se piden con `Read-Host` (no se ven al pegarlas): pega
**UNA sola vez** (clic derecho **o** Ctrl+V, nunca ambos). Nada de esto toca la base real salvo el paso 2.

**1. Despliegue.** Al subir a `main`, Vercel despliega solo. Con el SQL 12 sin correr, Taqueiros se ve igual (el servidor usa
sus valores de respaldo y el log avisa `[Publico] Taqueiros usa N valores de respaldo`). Abre
`https://taqueiros-2-0.vercel.app/api/restaurante` (debe mostrar la marca, textos, tarifas y la llave **pública**; ningún
secreto) y `https://taqueiros-2-0.vercel.app/manifest.json`.

**2. SQL 12.** VS Code → abre `supabase/12-config-publica.sql` → **Ctrl+A, Ctrl+C** → Supabase → SQL Editor → New query →
pega → **"Run without RLS"**. Resultado esperado: **24 filas, todas `OK`**. Si algo falla verás `MR paso n: ...` o `LA
MIGRACION 12 SE REVIRTIO` con la lista, y no se cambió nada. Se puede repetir. No vuelvas a correr el SQL 10 después (recrearía
`buscar_mis_pedidos` con su versión anterior; correr el 12 otra vez la repone).

**3. Verificación contra la base real (solo lectura salvo las pruebas que crean y borran sus propios restaurantes).**

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs                    # esperado: 26 PASAN
node supabase/probar-servidor-multirestaurante.mjs         # esperado: todos PASA (≈173), "Limpieza: todo lo creado se borro."
node supabase/probar-aislamiento.mjs                       # esperado: todas PASA (con Realtime real)
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

**4. Recorrido a mano en producción** (lo único que ninguna prueba automática reemplaza): el menú se ve igual que antes
(nombre, logo, colores, pie); armar un pedido y pagarlo con Wompi **sandbox** (la pantalla de confirmación, el enlace de
seguimiento ahora trae un código largo, "Seguir mi pedido" funciona); "¿Buscas tu pedido?" con ese celular y total
(muestra "Pedido #N" con el número de Taqueiros y su enlace abre el seguimiento); en el panel: el pedido aparece con su
número, suena, imprime y **Reimprimir** (mismo ticket); historial y menú-admin. En un equipo con el panel instalado,
recarga una vez: toma `sw.js` v9. En Chrome → F12 → Application → Manifest: nombre `Panel Taqueiros`.

**5. Cuando quieras cobrar de verdad.** Ya **no** se edita `index.html`: el modo lo decide el servidor. Fija
`WOMPI_MODO=produccion` (y los secretos prod) con `cargar-secretos.mjs --slug=taqueiros` como en 13.5 paso 2; la página
pasa sola a la llave `pub_prod_` de `config.publico.wompi`. Mientras no lo fijes, la página (y el servidor) siguen en pruebas.

**6. Dar de alta un restaurante nuevo** (se suma a 12.8): después de crearlo, llenar su `config.publico` con el JSON de 14.3
(en Supabase → Table editor → `restaurantes` → `config`, o con `update public.restaurantes set config = '...'::jsonb where slug = '...'`),
cargar su `tarifas_domicilio`, `wompi_modo` y llaves, y su dominio en `restaurante_dominios` y en Vercel. Con
`config` vacío el sitio funciona y se ve neutro.

### 14.10 Qué se probó y qué no

**Probado por mí (local, sin tocar la base real):**

* `config-publica.mjs` (nuevo): **49** — el SQL 12 sobre una base con el SQL 10 y el 11, dos veces y tras re-correr el 10;
  pedidos existentes intactos (id, numero, `actualizado_en`, sin `UPDATE`); enlaces viejos siguen sirviendo y los nuevos solo con
  token; `numero` y token en `seguimiento`/`buscar_mis_pedidos`; el token no se cambia desde el navegador; la mezcla no pisa
  nada y no toca a otros restaurantes; el JSON del SQL = el de `_respaldo-taqueiros.js`; y **17 mutaciones** del propio SQL 12
  (todas detectadas).
* `servidor.mjs`: **186** (167 de antes, 2 adaptadas al nuevo formato y 19 nuevas: marca/tarifas/llaves de cada restaurante sin
  cruces, datos hostiles, modos de pago y llave del otro modo, sin datos = neutro, respaldo solo de Taqueiros, manifest, número
  en WhatsApp y alertas, token). También pasa con `SQL12_NO=1` (el código nuevo antes del SQL 12).
* `front.mjs` (nuevo, Chrome sin interfaz sobre los manejadores reales y el Supabase falso): **104** — dos restaurantes en dos
  dominios (cada uno su nombre, colores, logo, textos, menú, tarifas, llave y número; ninguno ve datos del otro); dominio
  desconocido y servidor caído = mensaje neutro; **datos hostiles** (HTML, `onerror`, `<script>`, CSS, `javascript:`, bidi en
  nombre, textos, contacto, mensaje de cerrado, horario, menú, frases del seguimiento) no se ejecutan ni se inyectan, **y aunque el
  servidor (o un intermediario) mandara esos datos SIN validar el navegador los descarta** (escenario 3b); suspendido, módulos apagados y
  sin datos; flujo de pago con un Wompi simulado (llave, monto, firma con el secreto del restaurante, redirección al origen,
  enlace con token); almacenamiento por restaurante; y **Taqueiros idéntico** a como estaba en `debc1c5`: 603–627 elementos
  comparados con su texto, atributos y **estilos calculados** en 6 estados de la página (portada, carrito, formulario de pago,
  buscar mi pedido con resultados, seguimiento y cerrado), más las tarifas, coordenadas, llave y modo.
* **Revisión por mutación del frontend** (`mutaciones-front.mjs`, nuevo): rompe a propósito 38 defensas de `index.html`, `pedido.html` y
  `restaurante-publico.js` (cada `textContent` vuelto `innerHTML`, cada validador, el token, `p_restaurante`, el modo de cobro, módulos,
  servicio suspendido, almacenamiento por restaurante…): **36 detectadas, 2 equivalentes declaradas con su razón, 0 sobrevivientes**
  (la primera corrida dejó pasar 2: una prueba cuyo dato hostil no distinguía la defensa —se corrigió— y una defensa en capas).
  **Revisión por mutación del servidor** (`mutaciones-servidor.mjs`, 26 mutaciones nuevas sobre `_publico.js`, `manifest.js`,
  número y token, y las 5 de `restaurante.js` reapuntadas): **25 detectadas, 1 equivalente, 0 sobrevivientes**; la primera pasada dejó
  pasar 3 (URL con usuario y clave, llave de pago con formato roto, y una mutación mal formulada) y se agregaron los datos hostiles
  que faltaban. **La corrida completa de las ~175 mutaciones anteriores del servidor (cuyo código no cambió) no se terminó en esta sesión**: llegó a 111 detectadas y 0 sobrevivientes antes de quedarse sin tiempo. Volver a correrla completa y a solas (`node pruebas/multirestaurante/mutaciones-servidor.mjs`, ~25 minutos) antes de dar por cerrada esta fase.
* `comparar-tickets.mjs`: 7/7 tickets idénticos (14.7). `ticket-comanda.test.js`: 67 unitarias en total (3 nuevas).
  `e2e.js` del panel: **180** comprobaciones (173 de antes + 7 del escenario 21 nuevo, número ≠ id).
* Baterías anteriores, todas verdes: `rls.mjs` 234, `hallazgos.mjs` 32, `planes.mjs` 11, `sim.mjs` (34 OK, con y sin
  `conPendientes`), `dominios.mjs` 35, `cargar-secretos-test.mjs` 20, `probar-compatibilidad` contra el falso 26,
  `probar-servidor-multirestaurante` contra el falso 173 y `probar-aislamiento` contra el falso 231 de 238 (las 7 que fallan son
  las de Realtime, que el falso no emula, igual que antes). Cambiaron solo las que dependían de lo que ahora cambia: las dos
  pruebas del formato de `/api/restaurante`, `probar-compatibilidad` (mismo motivo) y `probar-aislamiento` (un pedido nuevo se
  abre con su token).

**Solo se pueden probar contra la base real o en producción (pendiente de Carlos):** el SQL 12 sobre el esquema verdadero
(paso 2); las tres verificaciones del paso 3; que Vercel respete la reescritura `/manifest.json` → `/api/manifest` (con el
archivo estático ya borrado) y el caché del borde por dominio (P5); el widget **real** de Wompi (las pruebas usan uno
simulado) y un pago sandbox de punta a punta; la impresora física; que `taqueiros-2-0.vercel.app` en el navegador real
(Chrome lo fuerza a HTTPS por la lista HSTS del dominio `.app`, por eso las pruebas usan `taqueiros.localhost` para Taqueiros).

### 14.11 Riesgos y pendientes para el paso siguiente (panel y administración)

1. ~~`panel.html`, `menu-admin.html`, `historial.html`, `marca.js` y el pie del ticket siguen con la marca de Taqueiros escrita.~~
   **Resuelto en la sección 15.** Queda pendiente, para 2B-4, el aviso de **gracia** en el panel (no es público, ver H10): ver 15.11.
2. ~~`menu-admin.html` inserta sin `restaurante_id` y sube las fotos a la raíz del bucket.~~ **Resuelto en la sección 15**: manda
   `restaurante_id` y sube a `{restaurante_id}/`. Falta retirar el defecto transitorio y la regla de la raíz del bucket (2B-4).
3. El dueño ya puede escribir `config.publico` desde su panel (la política de `restaurantes` se lo permite): el panel de
   administración necesita un formulario con las mismas validaciones (colores, URLs, textos). Las del servidor y el navegador
   descartan lo inválido, pero el formulario debería avisar.
4. Con muchos restaurantes, `/api/restaurante` hace dos consultas extra por visita (tarifas y modo de cobro; se pueden pedir en
   paralelo y ya lo están). Si pesa, ponerle un caché de borde corto **después** de verificar `Vary: Host` con dos dominios (P5).
5. Las vistas previas de enlace no ejecutan JavaScript (14.5): título y descripción dinámicos pedirían servir el HTML desde una
   función.
6. P1 (13.4): el interruptor de producción pasó del navegador al servidor; mientras `otros.wompi_modo` no esté fijado para
   Taqueiros, `crear-pedido` todavía acepta el modo que mande el navegador (la página ya no lo elige). Fijarlo y retirar ese
   respaldo cuando se cobre de verdad.
7. ~~`TAQUEIROS_SUPABASE` (nombre del objeto global) y las tipografías siguen siendo de Taqueiros~~ **Resuelto en la sección 15**
   (`SUPABASE_PUBLICO`; tipografías por restaurante con lista permitida).
8. **Límite de funciones de Vercel:** `api/manifest.js` es la función número **11** (las que no empiezan con `_`: alertas,
   crear-pedido, disponibilidad, estado, generar-firma, keep-alive, manifest, menu, reembolso, restaurante, webhook-wompi). El plan
   Hobby permite 12 por despliegue: la siguiente que se agregue obliga a juntar endpoints o a cambiar de plan.

---

## 15. Paneles del personal por restaurante (panel, menú, historial, ticket)

Hasta la sección 14 el **servidor** y las **páginas públicas** ya eran por restaurante, pero las páginas **privadas** del
personal (`panel.html`, `menu-admin.html`, `historial.html`, `marca.js`, el pie del ticket y `sw.js`) seguían con la marca de
Taqueiros escrita y asumían un solo restaurante: el panel tomaba "la primera membresía" del usuario, `menu-admin` insertaba sin
`restaurante_id` (caía en Taqueiros por el defecto transitorio) y subía las fotos a la raíz del bucket. Esta sección es ese
trabajo. **No cambia el servidor revisado (webhook, crear-pedido, reembolso, sesión, alertas), ni las URL de servicios externos
(webhook de Wompi, cron), ni la base de datos**: no hay SQL nuevo. **Taqueiros se ve y funciona igual** (se comprueba, ver 15.10).

### 15.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `panel-restaurante.js` (nuevo; **reemplaza a `marca.js`**, que se borra) | Una sola copia para las tres páginas: pide `/api/restaurante` (el servidor decide el restaurante por el **Host**), pinta la marca (nombre, logo, favicon, colores, tipografías de una lista, color de la barra del navegador), comprueba la **membresía** del usuario en ese restaurante antes de pedir un solo dato, muestra el rol, vuelve a comprobarla de vez en cuando y migra las preferencias del equipo. |
| `panel.html`, `menu-admin.html`, `historial.html` | Sin ninguna marca escrita (paleta neutra por defecto + telón de carga, igual que `index.html`/`pedido.html`). Toda consulta, escritura, canal de Realtime y llamada a función SQL lleva el restaurante **explícito** (15.4). Las fotos nuevas van a `{restaurante_id}/`. |
| `ticket-comanda.js` | El pie ya no está escrito: es el nombre del restaurante en mayúsculas + `" · PEDIDO WEB"` (15.6). El diseño y la impresión no cambian (7 de 7 tickets idénticos). |
| `supabase-publico.js` y todas las páginas | `window.TAQUEIROS_SUPABASE` → `window.SUPABASE_PUBLICO` (neutro). Todas piden `supabase-publico.js?v=2`. Los scripts de `supabase/` leen ese archivo con una expresión sobre `url:`/`publishableKey:`, que no cambia. |
| `api/_publico.js`, `restaurante-publico.js` | Campo opcional `marca.tipografia` `{titulos, cuerpo}` con **lista permitida de nombres** (15.5). |
| `sw.js` v10 | Cache con nombre neutro (`panel-estatico-v10`); borra las caches `taqueiros-panel-*` y `panel-estatico-*` anteriores. Sigue sin guardar nada de ningún restaurante (15.7). |
| `pruebas/multirestaurante/panel.mjs` (nuevo) y `realtime-falso.mjs`, `mutaciones-panel.mjs` | Pruebas de navegador con dos restaurantes (15.10). |

### 15.2 Inventario: lo que estaba escrito a mano en las páginas privadas y de dónde sale ahora

| Valor | Antes | Ahora |
|---|---|---|
| Nombre (título de la pestaña, barra, menú lateral, `alt` del logo) | `marca.js` (`"Los Taqueiros"`), `<title>` y `alt` de `menu-admin.html` e `historial.html` | `restaurantes.nombre` → `[data-marca-nombre]` (con `textContent`) y `document.title = "<página> \| <nombre>"` |
| Logo | `Recursos/logo/logo.png` en 6 sitios + `marca.js` | `config.publico.marca.logo` → `[data-marca-logo]` (el `alt` es el nombre, salvo `data-marca-decorativo`) |
| Favicon e ícono de pantalla de inicio | `marca.js` y `<link rel="icon">` | el logo (ruta validada); mientras llega, un ícono provisional vacío evita que Chrome pida `/favicon.ico` |
| `theme-color` (`#C1272D`) | cabecera de las 3 páginas | `marca.colores.primario` |
| Colores (12 en `:root` ×3) y ~60 `rgba(...)` con los colores de la marca | CSS de las 3 páginas | `marca.colores.*` → variables CSS (`--rojo`… y sus `-rgb` para las transparencias). Paleta neutra por defecto |
| Texto secundario (`#B9A88C`) | CSS | `marca.colores.texto_tenue` (en estas páginas el "secundario" es el tenue; si falta, `texto_secundario`) |
| Tercer nivel de superficie `--carbon-3` (`#2E1D19`) | CSS | derivado de `oscuro` y `oscuro_2` (un paso más allá de `oscuro_2` en la misma dirección: con la paleta de Taqueiros da exactamente `#2E1D19`) |
| Tipografías (Anton, Libre Franklin; el `<link>` de Google Fonts ×3) | HTML y CSS | `marca.tipografia` (lista permitida); por defecto las mismas de siempre. `Fredoka` se cargaba pero **ninguna** página privada la usaba: ya no se carga |
| Pie del ticket `LOS TAQUEIROS · PEDIDO WEB` | `ticket-comanda.js` | `nombre.toUpperCase() + " · PEDIDO WEB"` (`TicketComanda.fijarRestaurante(nombre)`) |
| Emoji 🌮 del aviso "Nuevo pedido" | `panel.html` | `marca.emoji` (neutro 🍽️) |
| Ejemplos de búsqueda del historial (`3125249438` = el WhatsApp de Taqueiros, `TAQ-...`) | `historial.html` | textos neutros ("Ej: 3001234567", "Código de referencia"). Es el único cambio visible para el personal de Taqueiros |
| `window.TAQUEIROS_SUPABASE` | `supabase-publico.js` y todas las páginas | `window.SUPABASE_PUBLICO` |
| Claves de `localStorage` `taqueiros-*` (imprimir, sonido, vistos, impresos, depurar, tamaño y hoja del ticket) | panel y ticket | `panel-*-v2:<id del restaurante>` (y `panel-ticket-*-v1` por equipo); las anteriores se **migran** una vez (15.7) |
| Nombre de la cache del service worker | `sw.js` | `panel-estatico-v10` |
| `configuracion`/`salud_notificaciones` por `id = 1` | panel | por `restaurante_id` |
| "La primera membresía" (`limites_jornada()`, `resumen_jornada`, `buscar_historial`, `jornadas_con_pedidos` sin parámetro) | panel e historial | siempre `p_restaurante` = el del dominio |

Lo que **queda a propósito** (no es marca; ver 15.11): la zona horaria `America/Bogota` y el prefijo `+57` de los enlaces `tel:`, algunos
grises/azules de estado (`#6b8fa8`, `#7a6a5c`, `#ffb4ab`, `#150d0b`…) que no son colores de marca, los datos inventados del ticket de
prueba (nombres de productos de ejemplo) y los nombres históricos de las claves del navegador, que la librería nombra **solo** para migrarlas.

### 15.3 Cómo se resuelve el restaurante y cómo se verifica la membresía (y por qué es seguro)

1. Al cargar, la página muestra un **telón** y pide `/api/restaurante` (el servidor lo decide por el `Host`, 12.2; el navegador nunca elige).
   Dominio desconocido → mensaje neutro "Este sitio no está disponible", **sin una sola petición a Supabase** (probado). Servidor caído → mensaje
   neutro con "Reintentar" y **reintento automático cada 8 s** (la cocina no puede quedarse en una pantalla de error).
2. Con el restaurante conocido se pinta la marca y se levanta el telón. Solo entonces se mira la sesión (`getSession`, local).
3. Al iniciar sesión (o al restaurar una guardada) se consulta `miembros` con **la sesión del usuario**:
   `user_id = <él>`, `restaurante_id = <el del dominio>`, `activo = true`. Hay tres resultados:
   * **miembro activo** (`dueno`, `cajero` o `cocina`): entra; el rol aparece en el menú lateral ("Tu rol: Dueño"). **No cambia lo que cada
     rol puede hacer**: eso sigue siendo RLS (cocina, por ejemplo, ve pedidos pero RLS no le entrega menú ni configuración);
   * **no es miembro** (sin fila, membresía inactiva, o es de otro restaurante): "Tu usuario no tiene acceso a este restaurante.", se cierra
     la sesión **solo en ese navegador** (`signOut({scope:"local"})`: el cierre global habría cerrado también la sesión de la cocina de su propio
     restaurante en otros equipos) y no se pide ningún dato (probado: la sesión rechazada solo hizo la consulta de `miembros`);
   * **no se pudo saber** (red, 5xx): **no** es un rechazo ni cierra la sesión: se muestra "No pudimos verificar tu acceso…" y se reintenta solo.
     (Un 503/520 de GET lo reintenta el propio `supabase-js` antes de llegar a la página.)
4. Con el panel abierto, la membresía se vuelve a comprobar cada 10 minutos y al volver a la pestaña si pasaron más de 5: si se la quitaron,
   se borra todo de la pantalla y vuelve al inicio de sesión con el mensaje.
5. Un usuario miembro de **dos restaurantes** entra a cada uno por su dominio (cada dominio es un origen con su propia sesión); no hay selector.

**Por qué es seguro.** La comprobación del navegador **no es lo que protege los datos**: eso lo hace RLS en cada consulta (políticas del SQL 10).
Sirve para (a) no mostrar el panel de un restaurante a quien no es de ahí y (b) que quien es de dos restaurantes vea solo el del dominio. Esto
último es lo delicado: RLS le **deja ver los dos**, así que la separación la hace el `restaurante_id` explícito de cada consulta (15.4). La prueba
`4b` lo demuestra: con la sesión de ese usuario y **sin filtro** la base le entrega los pedidos de los dos restaurantes, y aun así el tablero, el
historial, el resumen, el menú, la configuración, la salud del WhatsApp y los canales de Realtime de cada dominio muestran solo lo suyo. Quien edite
el navegador para saltarse la comprobación no gana nada: RLS sigue mandando. Superadmin que **no** es miembro: hoy tampoco entra (la interfaz de
superadmin es otro paso, 15.11).

### 15.4 Filtro por restaurante en todo el frontend privado

| Página | Qué | Cómo recibe el restaurante |
|---|---|---|
| panel | `limites_jornada` | `p_restaurante` (antes: la primera membresía) |
| panel | lectura de `pedidos` (tablero), sonda `impreso_en` | `.eq("restaurante_id", RID)` |
| panel | cambio de estado de un pedido | `.eq("id", id).eq("restaurante_id", RID)` |
| panel | `configuracion` (leer, interruptor Abierto/Cerrado, horario) y `salud_notificaciones` | `.eq("restaurante_id", RID)` (antes `id = 1`) |
| panel | Realtime: `pedidos`, `salud_notificaciones`, `configuracion` | `filter: "restaurante_id=eq.<RID>"` en cada suscripción **y** el manejador descarta lo que no sea de su restaurante (un pedido sin `restaurante_id` también) |
| panel | `reclamar_impresion(p_id)`, `registrar_reimpresion(p_id)` | deducen el restaurante **del pedido** y exigen membresía con rol dueño/cajero/cocina; el panel solo les pasa ids de su propia lista y `esImprimible` rechaza lo que no sea de su restaurante |
| historial | `jornadas_con_pedidos`, `resumen_jornada`, `buscar_historial` | `p_restaurante` |
| menu-admin | leer categorías y productos | `.eq("restaurante_id", RID)` |
| menu-admin | alta de categoría y de producto | `restaurante_id: RID` en el cuerpo |
| menu-admin | agotar, editar (rápido y formulario), renombrar, ocultar, borrar, **deshacer un alta a medias** | `.eq("id", …).eq("restaurante_id", RID)` (los ids de producto/categoría se repiten entre restaurantes) |
| menu-admin | foto nueva | se sube a `{restaurante_id}/p-<hex>.<ext>`; la lectura de las existentes sigue donde están; solo se intenta borrar una foto de la raíz o de la carpeta propia |

**Funciones SQL revisadas (una por una)** y si necesitan un cambio en la base para 2B-4: **ninguna lo necesita**.

| Función | Cómo recibe/deduce el restaurante | Veredicto |
|---|---|---|
| `limites_jornada(fecha, p_restaurante)` | parámetro; sin él, `restaurante_actual()` (primera membresía) | el panel ya manda el parámetro. `config_jornada` (DEFINER) devuelve vacío si no eres miembro |
| `resumen_jornada(fecha, p_restaurante)`, `buscar_historial(…, p_restaurante)`, `jornadas_con_pedidos(limite, p_restaurante)` | parámetro; mismo respaldo | el historial ya manda el parámetro |
| `reclamar_impresion(p_id)`, `registrar_reimpresion(p_id)` | el restaurante **del pedido** (invoker + RLS + membresía con rol) | seguras tal cual. Un usuario de dos restaurantes **podría** reclamar con ellas un pedido del otro si le pasara el id; el panel no lo hace (lista filtrada + `esImprimible`), y no es un hueco de seguridad (es su propio restaurante). Si algún día se quiere que la base lo impida por dominio, bastaría un parámetro opcional `p_restaurante` |
| `validar_producto` / `validar_categoria` (triggers) | el `restaurante_id` de la fila | ya exigen categoría del mismo restaurante y ruta de foto `{restaurante_id}/…` (la raíz solo para Taqueiros: regla transitoria que **sigue puesta**) |
| `puede_gestionar_fotos(ruta)` (Storage) | primera carpeta de la ruta = restaurante del que eres **dueño** | probado: el dueño de A escribe en `A/…`, no en la raíz ni en `B/…` |

El valor por defecto transitorio de `restaurante_id`, la regla de la raíz del bucket y `?clave=` del cron **no se retiraron** (2B-4).

### 15.5 Tipografías

`restaurantes.config.publico.marca.tipografia = { "titulos": "Bebas Neue", "cuerpo": "Open Sans" }`. Ambos son **nombres** de esta lista
(`api/_publico.js` `FUENTES_PERMITIDAS` y `restaurante-publico.js` `RP.FUENTES`; una prueba compara las dos listas):
Anton, Bebas Neue, Oswald, Montserrat, Poppins, Playfair Display, Fredoka, Lora, Merriweather, Libre Franklin, Open Sans, Nunito, Lato, DM Sans,
Work Sans, Source Sans 3. **Por defecto** (sin elegir) son las de siempre: `titulos = Anton`, `cuerpo = Libre Franklin`. Nunca se usa una URL ni un
nombre libre de la configuración: la dirección de Google Fonts se arma en el navegador solo con la entrada de la lista (con los pesos que esa fuente
sí tiene) y se aplica con `--fuente-titulos` / `--fuente-cuerpo`. Un valor fuera de la lista (un nombre libre, `https://…`, `Anton;} body{display:none}`) se
ignora y quedan las de siempre; el servidor solo emite el campo si hay una elegida válida (para Taqueiros la respuesta es la de antes, sin el campo).
El ticket de la termica **no** usa estas fuentes (Arial, a propósito).

### 15.6 Ticket de comanda: qué cambió y la prueba de que la impresión no cambió

* `TicketComanda.fijarRestaurante(nombre)` (el panel lo llama una vez) y `preparar()` calcula `pie = textoPie(nombre)`: el nombre pasa por `limpiarTexto`
  (como todo lo que viene de la base: sin emojis, controles ni marcas de dirección), se pasa a mayúsculas y se le agrega `" · PEDIDO WEB"`. Sin nombre,
  el pie es solo `PEDIDO WEB` (nunca el de otro restaurante). `opciones.restaurante` manda para una sola impresión.
* Para "Los Taqueiros" el pie es **exactamente** `LOS TAQUEIROS · PEDIDO WEB` (mismos caracteres, `U+00B7`).
* Las claves del tamaño y del modo de hoja pasan a `panel-ticket-tamano-v1` / `panel-ticket-hoja-v1` (se migran los valores guardados).
* **Prueba:** `node pruebas/impresion/comparar-tickets.mjs` (ahora compara contra `1c35320`, el commit anterior a este paso) imprime los mismos 7 tickets
  (normal, 12 productos con notas largas, nombres y direcciones largos, ñ y tildes, HTML hostil, reimpresión, prueba) con el panel de antes y el de ahora
  y compara el HTML **letra por letra**: **7 de 7 idénticos** (solo se normalizan las horas). Además: 5 pruebas unitarias nuevas del pie (nombre normal, sin
  nombre, texto hostil, `opciones.restaurante`, claves neutras) y el escenario `9` del navegador (el ticket de A lleva el pie de A y el de B el de B;
  reimpresión y ticket de prueba, igual).

### 15.7 Preferencias del navegador y service worker

* Las preferencias del panel llevan el id del restaurante: `panel-imprimir-v2:<id>`, `panel-sonido-v2:<id>`, `panel-vistos-v2:<id>`,
  `panel-impresos-local-v2:<id>`, `panel-depurar-conexion-v2:<id>`; el tamaño del ticket y el modo de hoja son del **equipo**
  (`panel-ticket-tamano-v1`, `panel-ticket-hoja-v1`). El bloqueo entre pestañas también (`impresion-local:<id>`).
* **Migración:** la primera vez que se abre el panel nuevo en un equipo, cada valor de las claves `taqueiros-*` se copia a la clave nueva si esta
  no existe (la anterior queda como estaba) y se borra la clave de la sesión propia que ya no se usa. Así el equipo de la cocina **conserva la
  impresión activada**, el sonido, el tamaño y el modo de hoja al actualizar. No se migra si la dirección trae `?r=` (un preview no hereda las
  preferencias de otro restaurante). Los nombres antiguos solo aparecen en `panel-restaurante.js` (8 claves), y una prueba lo exige.
* `sw.js` v10: no precachea nada; panel, `/api/`, `/manifest.json`, Supabase y las páginas van **siempre por la red**; solo guarda archivos
  estáticos de `/Recursos/` y fuentes, en una cache **por origen** (cada restaurante tiene el suyo): no puede servir datos de un restaurante a otro.
  Al activarse borra las caches viejas (`taqueiros-panel-*` y `panel-estatico-*`).
* En la primera visita tras el despliegue el panel se **recarga una vez** (el worker nuevo toma el control; comportamiento de siempre).

### 15.8 Seguridad de lo que llega de la base

Nombre, rol y marca entran con `textContent` o con atributos validados; los colores deben ser `#RRGGBB` exactos (el servidor y el navegador lo
revisan) y se aplican con `setProperty`; las imágenes son rutas del sitio o `http(s)` del origen de Supabase del proyecto (nada de `javascript:` ni
`data:`); las tipografías, nombres de una lista. `panel-restaurante.js` no usa `innerHTML`, `insertAdjacentHTML`, `document.write` ni `eval` (la prueba
`12` lo exige) y ningún dato del restaurante se pega con `innerHTML` en las tres páginas. Se arregló además que el **horario** (que sale de la base y
se escribía dentro de atributos) aceptaba cualquier cadena: ahora solo entra `HH:MM`. Lo que ya existía y se conserva: los datos de los **pedidos** y del
**menú** (clientes, productos, notas) se insertan con `innerHTML` pero **pasando antes por `escapar()`** (escapa `& < > " '`), y el ticket usa
`textContent`; las pruebas con datos hostiles (e2e de la impresión, escenario 14 de `e2e.js`) siguen pasando.

### 15.9 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. **Este paso no trae SQL nuevo** y no toca la base. No pegues ninguna llave en el chat.

**1. Antes de desplegar (una vez, solo lectura):** comprueba que todo el personal de Taqueiros esté en `miembros` (el panel nuevo exige ser miembro
**activo**; el SQL 10 pasó a todos los de `personal` como `dueno`, pero conviene verlo). Supabase → SQL Editor → New query → pega →
**"Run without RLS"**:

```sql
select u.email, m.rol, m.activo
from public.miembros m join auth.users u on u.id = m.user_id
where m.restaurante_id = '00000000-0000-4000-8000-000000000001'
order by m.rol, u.email;
```

Cada persona que usa el panel debe aparecer con `activo = true`. Si falta alguien, agrégalo antes de desplegar (con el UID de Authentication → Users):
`insert into public.miembros (user_id, restaurante_id, rol) values ('<UID>', '00000000-0000-4000-8000-000000000001', 'cajero');` (roles: `dueno`,
`cajero`, `cocina`).

**2. Despliegue.** `git push` a `main` (ya hecho si lees esto en el repositorio); Vercel despliega solo. Abre `https://taqueiros-2-0.vercel.app/panel.html`.

**3. Recorrido a mano en producción** (lo único que ninguna prueba reemplaza):
* `panel.html`: entra con la cuenta de siempre → se ve **igual** que antes; en ☰ aparece "Tu rol: Dueño" bajo "Panel de comandas".
  Cambia un pedido de estado, interruptor Abierto/Cerrado y vuelve a abrir, Sonido, **Reimprimir** (mismo ticket; el pie dice `LOS TAQUEIROS · PEDIDO WEB`).
* **En el computador de la cocina:** recarga una vez (toma `sw.js` v10) y confirma que "Imprimir comandas en esta pantalla" sigue **ACTIVA** y el
  tamaño/modo de hoja son los de siempre (se migran solos). Haz un pedido de prueba con Wompi sandbox: aparece, suena, imprime y llega el WhatsApp.
* `menu-admin.html`: apaga y prende un producto; sube una foto de prueba (queda en `…/storage/v1/object/public/productos/00000000-0000-4000-8000-000000000001/p-….webp`)
  y bórrala; las fotos de siempre se siguen viendo.
* `historial.html`: elige una fecha, mira el resumen y busca por teléfono.
* Un usuario **sin** membresía en Taqueiros (créalo en Authentication si quieres probarlo): debe ver "Tu usuario no tiene acceso a este restaurante." y no ver nada.

**4. Pruebas locales (no tocan la base real):**

```powershell
npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2      # una vez
node --test pruebas/*.test.js                                # unitarias (72)
node pruebas/impresion/e2e.js                                # panel con Supabase simulado (~3 min, 180)
node pruebas/impresion/comparar-tickets.mjs                  # los 7 tickets idénticos (~1 min)
node pruebas/multirestaurante/panel.mjs                      # paginas privadas con 2 restaurantes, supabase-js real, RLS real y Realtime emulado (~1-5 min, 272)
node pruebas/multirestaurante/front.mjs                      # paginas publicas (104)
node pruebas/multirestaurante/servidor.mjs                   # servidor (187)
node pruebas/multirestaurante/mutaciones-panel.mjs           # revision por mutacion de las paginas privadas (~35 min con 3 a la vez)
```

**5. Contra la base real (las mismas de 14.9 paso 3; el servidor casi no cambió: solo el campo opcional `tipografia` de `/api/restaurante`):**

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs                    # esperado: 26 PASAN
node supabase/probar-servidor-multirestaurante.mjs         # esperado: todos PASA (174), "Limpieza: todo lo creado se borro."
node supabase/probar-aislamiento.mjs                       # esperado: todas PASA (con Realtime real)
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

**Si algo falla en producción** (por ejemplo, alguien no está en `miembros` y no puede entrar): vuelve a la versión anterior con
`git revert --no-edit d65d507 bc78966` y `git push`, o agrega la membresía que falta (paso 1). El revert no deshace nada en la base (este paso no la tocó).

### 15.10 Qué se probó y qué no

**Probado por mí (local, sin tocar la base real):**

* `panel.mjs` (nuevo): **272** comprobaciones en Chrome sin interfaz con el `supabase-js` **real**, los manejadores **reales** de `api/`, Postgres 16 (PGlite) con el
  SQL 10, 11 y 12 y sus políticas RLS **reales**, Supabase en **otro origen** (`supabase.localhost`) y un Realtime falso que habla el protocolo del cliente real
  (`realtime-falso.mjs`): la marca de dos restaurantes en las tres páginas (colores, logo, favicon, título, tipografías con la dirección armada desde la
  lista); datos hostiles en la configuración (HTML, CSS, `javascript:`, tipografías fuera de la lista, horario) sin efecto; dominio desconocido y servidor caído
  (sin peticiones, reintento solo); membresía (dueño de A, dueño de B, miembro de ambos con rol distinto en cada uno, cocina, sin membresía, inactiva, y un
  usuario de A por el dominio de B: mensaje, sesión cerrada solo localmente, ni una consulta de datos); fallo de red al verificar (no es rechazo) y membresía
  quitada con el panel abierto; aislamiento con un usuario que RLS deja ver los dos (tablero, configuración, salud del WhatsApp, historial, resumen, búsqueda,
  menú); interruptor y horario que escriben solo en su restaurante; `menu-admin` con **el mismo id de producto y de categoría en los dos restaurantes**
  (agotar, editar rápido y por formulario, renombrar, ocultar, borrar, deshacer un alta a medias: nada toca al otro; cada alta lleva su `restaurante_id`, la foto
  va a `{restaurante_id}/` y nunca a la raíz; RLS de Storage cerrada para la raíz y para la carpeta de otro); Realtime (lo que el navegador pide en el cable,
  que se descarta lo ajeno **aunque llegue** sin filtro, eventos sin `restaurante_id`); impresión por restaurante; preferencias y su migración;
  **Taqueiros idéntico al commit anterior**: 14 pantallas/estados (login, tablero con un pedido de domicilio, menú lateral, horario, impresión, aviso de WhatsApp,
  menú, formulario de producto, historial…) comparando cada elemento con su **estilo calculado** (color, fondo, degradados, fuente, sombra, borde…): **idénticos**
  (diferencias a propósito, normalizadas en la prueba: el rol bajo el menú; los dos ejemplos de búsqueda del historial; el ícono de pantalla de inicio que menú e
  historial no tenían; la tipografía de una cifra del historial que no llevaba tipo genérico de respaldo); y la revisión de archivos (nada de Taqueiros escrito).
* **Revisión por mutación** (`mutaciones-panel.mjs`): 71 mutaciones de las defensas de `panel-restaurante.js`, `restaurante-publico.js`, `panel.html`, `menu-admin.html`, `historial.html`, `ticket-comanda.js` y `sw.js` (cada filtro por restaurante, cada `p_restaurante`, la comprobación de membresía y sus reintentos, el cierre de sesión local, cada filtro y guarda de Realtime, la foto a la carpeta, la migración de claves, la lista de tipografías, la validación de colores…): **65 detectadas, 6 equivalentes declaradas con su razón, 0 sobrevivientes**. La primera corrida dejó pasar 5 (las dos pruebas de "quitar las dos capas de validación" no llegaban al navegador porque el servidor ya descarta lo hostil antes —se agregó el escenario `2b`, que le sirve al navegador datos crudos sin validar—, y la revisión de `sw.js`, que leía el archivo del repositorio en vez de la copia mutada) y una mutación declarada "equivalente" que sí se detectaba. Las equivalentes: los dos filtros de una sola capa de validación (colores y tipografías: la otra capa los cubre; quitadas las dos sí se detectan), `fila.activo` en el navegador (la consulta ya lo pide), un rol desconocido (la base tiene un CHECK con tres roles), el filtro `restaurante_id` en el cambio de estado de un pedido (`pedidos.id` es único en toda la tabla), `esImprimible` (tercera capa) y no intentar borrar una foto de otra carpeta (Storage ya lo prohíbe). Para repetir unas pocas: `node pruebas/multirestaurante/mutaciones-panel.mjs --sin-base --solo="<regex>"`.
* Baterías anteriores, todas verdes: `rls.mjs` 234, `hallazgos.mjs` 32, `planes.mjs` 11, `sim.mjs` (34 OK, con y sin `conPendientes`), `dominios.mjs` 35,
  `config-publica.mjs` 49, `cargar-secretos-test.mjs` 20, `servidor.mjs` 187 (186 + 1 de tipografías), `front.mjs` 104, `probar-compatibilidad` contra el falso 26,
  `probar-servidor-multirestaurante` contra el falso 174, `probar-aislamiento` contra el falso 231 de 238 (las 7 que fallan son las de Realtime, que ese falso no emula,
  igual que antes), unitarias 72, `e2e.js` del panel de la impresión 180 y `comparar-tickets.mjs` 7 de 7. Cambiaron solo las que dependían de lo que cambia:
  `e2e.js` y su servidor falso (ahora entrega `/api/restaurante` armado con el mismo código del servidor, la tabla `miembros`, filtros por restaurante y canales
  con filtro), `front.mjs` (nombre del objeto global, versión del service worker) y `fake-supabase.mjs` (ahora respeta `.single()`).

**Solo se puede probar contra la base real o en producción (pendiente de Carlos):** el inicio de sesión real con tu cuenta y la fila real de `miembros`
(paso 1 de 15.9); que Realtime real acepte el filtro `restaurante_id=eq.<uuid>` en las tres tablas (el protocolo es el estándar de Supabase y el cliente real lo
acepta en la prueba, pero el servidor real lo valida él mismo); la subida real de fotos a `{restaurante_id}/` con las políticas reales (las políticas son las del
SQL 10, que `probar-aislamiento.mjs` ya verifica contra la base real); la **impresora física** y `--kiosk-printing`; Google Fonts reales; el service worker real
instalado en el equipo de la cocina; y que la caché del borde de Vercel separe dominios (P5, sin cambios).

### 15.11 Pendientes y riesgos para el paso siguiente (2B-4)

De 13.4 y 14.11, lo del frontend privado que era de bajo riesgo **se resolvió aquí**: marca de las páginas privadas y del ticket, `menu-admin` con
`restaurante_id` explícito y fotos en carpeta, el panel sin "primera membresía" (ya no hace falta selector: el dominio decide), `TAQUEIROS_SUPABASE` y las
tipografías. **No se hizo, y queda para 2B-4:**

1. **Retirar los valores por defecto transitorios** de `restaurante_id` (y `restaurante_taqueiros_id()`). Antes, revisar quién inserta **sin** `restaurante_id`: el
   servidor y las tres páginas privadas ya lo mandan; fallarían los scripts antiguos `supabase/probar-menu-rls.js`, `probar-publishable.mjs` y `probar-impresion-rls.js`
   (ya estaban marcados como obsoletos en la sección 5) y cualquier carga manual.
2. **Regla transitoria del bucket** (la raíz solo la escribe el dueño de Taqueiros). `menu-admin` ya no escribe en la raíz, pero las ~38 fotos antiguas siguen allí y
   al borrar/cambiar una foto vieja la página intenta borrarla de la raíz: con la regla retirada, ese borrado fallaría en silencio (queda un aviso en consola). Decidir:
   mover las fotos a `{restaurante_id}/` (hay que copiar el archivo con la API de Storage y actualizar `productos.imagen`; con SQL solo no se mueve el archivo) o conservar
   solo el borrado en la raíz.
3. **Formulario de configuración** (el dueño ya puede escribir `config.publico`): con las mismas validaciones que el servidor y el navegador (colores `#RRGGBB`,
   URLs de logo, textos, WhatsApp) y **selector de las dos tipografías** con la lista de 15.5; que avise lo que se descarta.
4. **Agrupación de endpoints:** siguen siendo **11 de 12** funciones de Vercel Hobby; este paso **no agregó ninguna** (el aviso de gracia, que habría pedido un endpoint
   con sesión, no se hizo: el dueño ya puede leer su fila de `restaurantes` con RLS —incluye `vigente_hasta` y `dias_gracia`— así que se puede mostrar sin función nueva; falta
   decidir quién lo ve y con qué texto). Candidatos a unir: `estado` + `disponibilidad`, `restaurante` + `manifest`, `keep-alive` + `alertas`.
5. **Vista previa de enlaces:** sin cambios; las páginas privadas llevan `noindex`. Las públicas siguen con el título neutro hasta que se sirva el HTML desde una función.
6. **Superadmin:** un superadmin que no es miembro de un restaurante hoy **no** entra a su panel (la comprobación es estricta); la interfaz de superadmin deberá traer su
   camino ("entrar como"). Un usuario baneado en Auth conserva su token ~1 h (P9), pero RLS deja de darle datos en cuanto se desactiva su membresía y el panel lo saca
   en ≤ 10 min.
7. **Residuos regionales:** `America/Bogota` (jornada y fechas del panel e historial; `restaurantes.zona_horaria` existe pero `jornada_de` la tiene fija), prefijo `+57` de los
   `tel:`, `es-CO`; y los datos inventados del **ticket de prueba** (nombres de productos de ejemplo, que dejé igual porque la prueba exige que el ticket de Taqueiros no cambie;
   cambiarlos exige actualizar `comparar-tickets.mjs`).
8. **Realtime y `DELETE`:** los eventos de borrado se ignoran (no traen `new`); un pedido borrado sigue en el tablero hasta recargar (como siempre). Los filtros de Realtime no
   se aplican a `DELETE` salvo por clave primaria, por eso el manejador además descarta todo lo que no sea de su restaurante.
9. **Costo por página:** cada carga hace una petición más a `/api/restaurante` y una a `miembros`. Si pesa, cache corto de borde **después** de verificar `Vary: Host` con dos dominios (P5).
10. P1, P2, P4–P8 y P10–P13 de 13.4 no tocan estas páginas y siguen como estaban.
