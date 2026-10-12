# Impresión automática de comandas en la cocina

Guía de montaje del computador de la cocina. Cuando entra un pedido web
pagado, el panel (`panel.html`) imprime solo su comanda en la impresora
térmica **Digital POS DIG-POS892** (USB, papel de 80 mm, corte automático).

La impresión sale **desde el navegador**: Chrome en Windows, con el
parámetro `--kiosk-printing` (imprime directo a la impresora
predeterminada, sin ventana de diálogo) y el driver de Windows de la
impresora. No se usa WebUSB ni se instala ningún programa extra.

> Esta carpeta (`docs/`) no se publica en el sitio: está en `.vercelignore`.

---

## 0. Antes de empezar: ejecutar el SQL (una sola vez)

El panel necesita dos columnas y dos funciones nuevas en Supabase para
**no imprimir nunca dos veces** un pedido, aunque haya dos pantallas
abiertas o se recargue la página.

1. Entra a Supabase → tu proyecto → **SQL Editor** → **New query**.
2. Abre el archivo `supabase/02-impresion.sql` de este repositorio,
   copia todo su contenido y pégalo.
3. Pulsa **Run**.
4. Al final aparece una tabla de comprobación: **todas** las filas deben
   decir `OK`. Si alguna dice `REVISAR`, no sigas: copia la tabla y
   consúltalo.

Es seguro volver a ejecutarlo. Los pedidos que ya existen al correrlo por
primera vez se marcan como "ya impresos" (la cocina los sacó desde el
POS), para que el primer panel que se abra no intente imprimir todo lo
de la jornada.

Si el SQL todavía no se ha corrido, el panel **sigue funcionando**: en la
pantalla que imprime aparece el aviso *"Falta ejecutar el SQL 02 en
Supabase"* y evita duplicados solo dentro de ese mismo equipo.

Prueba opcional de seguridad (debe terminar en "TODO BLOQUEADO"):

```powershell
node supabase/probar-impresion-rls.js
```

---

## 1. Instalar el driver de la impresora

1. Conecta la DIG-POS892 por USB al computador de la cocina y enciéndela.
2. Instala el **driver de Windows del fabricante (Digital POS)** para la
   DIG-POS892. Usa el instalador que venga con la impresora o el que
   publique el fabricante para ese modelo.
   - Evita el driver genérico "Generic / Text Only": imprime texto plano
     sin tamaños, negrillas ni ñ/tildes confiables.
3. Cuando termine, la impresora debe aparecer en
   **Configuración → Dispositivos → Impresoras y escáneres** (Windows 10;
   en Windows 11: *Bluetooth y dispositivos → Impresoras y escáneres*).

### Preferencias de impresión del driver

Abre las preferencias de la impresora (en la lista de impresoras →
**Preferencias de impresión**) y revisa:

| Ajuste | Valor |
| --- | --- |
| Tamaño de papel | Rollo de **80 mm** (el nombre varía: "80mm", "Roll 80", "80 x 297"…) |
| Cortar papel | **Al final de cada documento** (cada ticket es un documento) |
| Márgenes | Los más pequeños que permita (el ticket ya trae margen 0) |
| Densidad / velocidad | La que dé una impresión negra y nítida |

El nombre exacto de cada opción depende del driver. Si algo no aparece,
usa el ticket de prueba (sección 5) para calibrar.

---

## 2. Dejarla como impresora predeterminada

`--kiosk-printing` imprime a la impresora **predeterminada**.

1. **Configuración → Dispositivos → Impresoras y escáneres**.
2. Baja y **desactiva** "Permitir que Windows administre mi impresora
   predeterminada" (si no, Windows la cambia según la última usada).
3. Pulsa la DIG-POS892 → **Establecer como predeterminada**.

---

## 3. Acceso directo de Chrome con `--kiosk-printing`

1. Clic derecho en el escritorio → **Nuevo → Acceso directo**.
2. En "Ubicación del elemento" pega (todo en una línea):

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --user-data-dir="C:\TaqueirosPanel" --app=https://taqueiros-2-0.vercel.app/panel.html
   ```

   - Si el sitio en producción usa otra dirección, cámbiala en `--app=`.
   - Si Chrome está en `Program Files (x86)`, ajusta la ruta.
3. Nómbralo **"Panel Taqueiros (cocina)"** y termina.

Por qué cada parte:

- `--kiosk-printing`: imprime sin diálogo. **Solo funciona si Chrome se
  inicia con él.** Si Chrome ya estaba abierto, la ventana nueva se une
  al Chrome que ya corría y el parámetro se ignora. Por eso el acceso
  directo usa su propia carpeta:
- `--user-data-dir="C:\TaqueirosPanel"`: un perfil de Chrome **exclusivo**
  del panel. Garantiza que arranque con el parámetro, y deja guardados
  ahí la sesión y el interruptor de impresión. Úsalo **siempre** desde
  este acceso directo; si abren el panel desde otro Chrome, el interruptor
  aparecerá apagado y se imprimirá con diálogo.
- `--app=...`: ventana sin barra de direcciones ni pestañas, difícil de
  cerrar por accidente.

### Primer arranque

1. Abre el acceso directo, inicia sesión con el usuario del panel (la
   sesión queda guardada en ese perfil).
2. Activa **"Imprimir comandas en esta pantalla"** (arriba). El
   indicador debe pasar a **ACTIVA**. Ese interruptor se guarda **solo
   en este equipo**: no lo actives en otros computadores ni en el celular.
3. Opcional: para que arranque con Windows, copia el acceso directo a
   `shell:startup` (Win + R → `shell:startup`).

> Si al imprimir sale el diálogo de impresión de Chrome, es porque el
> panel no se abrió con `--kiosk-printing`: cierra **todas** las ventanas
> de ese perfil y vuelve a abrir con el acceso directo.

---

## 4. Que el equipo no se duerma ni oculte la ventana

Para que se imprima, el equipo debe estar encendido, con internet, y la
ventana del panel **visible**.

**Reposo de Windows**
1. **Configuración → Sistema → Inicio/apagado y suspensión** (Windows 10;
   en Windows 11: *Sistema → Energía y batería*).
2. Pantalla y suspensión: **Nunca** apagar la pantalla y **Nunca**
   suspender (en corriente).
3. Panel de control → Opciones de energía → Cambiar la configuración del
   plan → Cambiar la configuración avanzada → **Configuración de USB →
   Suspensión selectiva de USB → Deshabilitada** (evita que Windows
   duerma el puerto de la impresora).
4. **Windows Update**: define "horas activas" que cubran el horario del
   local para que no se reinicie en pleno servicio.

**Ventana visible**
- No minimizar el panel ni dejarlo tapado por otras ventanas. Chrome
  puede considerar "oculta" una ventana minimizada o cubierta por completo,
  y en ese estado el panel **espera** a que vuelva a verse antes de imprimir
  (la comanda queda pendiente, no se pierde).
- El panel pide al navegador mantener la pantalla encendida mientras la
  impresión automática está activa (Wake Lock). Es un refuerzo, no
  reemplaza los ajustes de reposo de arriba.

---

## 5. Comprobar con el ticket de prueba

1. En el panel, pulsa el engranaje **⚙️** (junto al interruptor de
   impresión).
2. Revisa que "Base de datos" diga **Lista** y "Pantalla encendida" diga
   que se mantiene encendida.
3. Pulsa **Imprimir ticket de prueba**.

Debe salir un solo ticket, marcado **TICKET DE PRUEBA**, con un nombre y
una dirección muy largos, ñ y tildes. Comprueba:

- [ ] Ningún texto se corta a la izquierda ni a la derecha.
- [ ] Las **ñ** y las tildes salen bien (María, Muñoz, Peña, ñoños).
- [ ] La franja "DOMICILIO · WEB · PAGADO" y el número se leen a un metro.
- [ ] El nombre de cada producto se lee de lejos.
- [ ] El corte cae **debajo** de la línea final, sin comerse texto.
- [ ] No sale papel en blanco extra después del ticket.

| Si ocurre… | Prueba… |
| --- | --- |
| Sale el diálogo de Chrome | El panel no se abrió con `--kiosk-printing` (sección 3) |
| Texto cortado a los lados | Preferencias del driver: papel de 80 mm y márgenes mínimos |
| Mucho papel en blanco al final | Tamaño de papel del driver: debe ser rollo continuo / "auto" |
| Un ticket sale partido en dos hojas | Rollo/alto de papel del driver demasiado corto |
| No corta | "Cortar papel" del driver en "Al final de cada documento" |
| Imprime en otra impresora | Sección 2: predeterminada y administración automática desactivada |

---

## 6. Cómo funciona en el día a día

- **Pedido pagado entra** → suena como siempre y, en la pantalla de
  cocina, se imprime solo, una vez.
- **Varios pedidos a la vez** → se imprimen en orden de llegada, uno por
  ticket, con una pausa corta (2,5 s) para que la impresora corte entre
  uno y otro.
- **Al abrir el panel o reconectarse** → imprime los pedidos pagados,
  activos y de la jornada en curso que no se hayan impreso. Si hay **más
  de 5**, no los imprime todos: muestra un aviso con el número y el botón
  **Imprimir pendientes**.
- **Nunca se imprimen solos** los pedidos entregados, cancelados ni los
  que no se han pagado.
- **Reimprimir**: cada tarjeta tiene un botón **🖨️ Reimprimir**. El ticket
  sale marcado **REIMPRESIÓN** y no cambia la marca de impresión
  original. Funciona en cualquier pantalla, esté o no activo el
  interruptor.
- Con el interruptor **apagado** (por defecto), esa pantalla no imprime
  nada sola.

---

## 7. Límites que hay que conocer

- **El computador de la cocina debe estar encendido, con Chrome abierto
  y la ventana visible.** El panel es una página web: no imprime desde un
  servidor. Si el equipo está apagado o dormido, nada sale.
- **Sin internet no llegan pedidos nuevos ni se reclama la impresión.**
  Al volver la conexión, el panel recarga y imprime lo que quedó
  pendiente (más de 5 → aviso con botón). Los pedidos siguen guardándose
  en Supabase aunque el panel esté caído.
- **Si se cae la impresora o se acaba el papel**, el navegador igual
  entrega el trabajo y el panel no se entera: el pedido queda marcado
  como impreso. Hay que usar **Reimprimir**. El panel solo avisa si el
  navegador mismo lanza un error.
- **Cancelar el diálogo** (en un equipo sin `--kiosk-printing`) también
  deja el pedido como impreso. Mismo remedio: Reimprimir.
- **Dos pantallas de cocina** no duplican: la base entrega cada pedido a
  una sola. Pero solo con el SQL 02 ejecutado; sin él, cada equipo evita
  duplicados solo para sí mismo.
- Los pedidos de **antes** de ejecutar el SQL 02 se consideran impresos.
- El panel conserva la sesión; si Supabase la expira, hay que volver a
  entrar para que sigan saliendo comandas.

## 8. Qué se guarda en la base

| Columna (`pedidos`) | Significado |
| --- | --- |
| `impreso_en` | Cuándo salió la impresión automática. `null` = pendiente |
| `reimpresiones` | Cuántas veces se usó "Reimprimir" |
| `reimpreso_en` | La última reimpresión |

Solo el personal autorizado (tabla `personal`) puede llamar
`reclamar_impresion` y `registrar_reimpresion`; el público anónimo no.
Ninguna de las dos devuelve datos de clientes.

## 9. Para quien mantiene el código

- Ticket: `ticket-comanda.js` (se carga desde `panel.html`; si cambia,
  sube el `?v=` del `<script>`).
- Lógica de cola e impresión automática: sección "IMPRESION AUTOMATICA
  DE COMANDAS" de `panel.html`.
- Pruebas: `node --test pruebas/ticket-comanda.test.js` (rápida) y
  `node pruebas/impresion/e2e.js` (navegador sin interfaz con Supabase
  simulado, ~2 minutos). Ver el encabezado de `e2e.js` para guardar los
  tickets y las capturas.
