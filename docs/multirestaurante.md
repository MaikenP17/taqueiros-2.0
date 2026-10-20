# Base de datos multi-restaurante (SQL 10)

Taqueiros 2.0 se va a vender como servicio: **una sola base de datos y un solo despliegue para muchos
restaurantes**, con aislamiento estricto de datos. Este documento describe la base ya preparada para eso
(`supabase/10-multirestaurante.sql`), qué había antes, qué decisiones se tomaron y cómo se verifica.

> **Alcance.** Este paso solo amplía la base de datos y la seguridad. El código actual (panel, pedidos,
> webhook de Wompi, alertas, menú, impresión, historial, crons) **no se tocó** y sigue funcionando igual.
> El siguiente paso adapta la API y el front, y retira los valores por defecto transitorios (sección 7).

Contenido: 1. Inventario anterior · 2. Diseño nuevo · 3. Matriz de permisos · 4. Decisiones ·
5. Qué se conserva para no romper nada · 6. Orden de pasos en Windows · 7. Lo que queda para el siguiente paso ·
8. Qué se probó y qué no · 9. Riesgos

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
* `crear-pedido`, webhook y alertas aún no son multi-restaurante: **no des de alta restaurantes reales con
  productos hasta hacer este paso**, porque `/api/menu` y los cobros leen `productos`/`categorias` sin filtrar y
  mezclarían los menús.

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
2. **El servidor aún no es multi-restaurante.** Hasta el siguiente paso, un segundo restaurante real mezclaría
   menús en `/api/menu` y en la validación de precios. Las pruebas crean datos de prueba por segundos; `/api/menu`
   tiene caché de 60 s en Vercel.
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
10. **Alertas por WhatsApp entre restaurantes (para el siguiente paso, en la API).** `/api/alertas` (llave secreta)
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
