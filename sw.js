/* =============================================================
   SERVICE WORKER DEL PANEL DE COMANDAS

   Existe por UNA razon: que el panel se pueda instalar como
   aplicacion en el equipo del restaurante, para que no viva en una
   pestana de Chrome que alguien puede cerrar sin querer.

   -------------------------------------------------------------
   REGLA CRITICA: ESTE WORKER NO CACHEA DATOS. NUNCA.
   -------------------------------------------------------------
   Un panel de comandas mostrando pedidos viejos es PEOR que un
   panel caido: el restaurante creeria que esta al dia cuando no lo
   esta, y despacharia mal.

   Van SIEMPRE a la red, sin excepcion:
     * panel.html y cualquier navegacion
     * todo lo de Supabase (pedidos, configuracion, sesion, websocket)
     * todo lo que cuelgue de /api/

   Solo se cachea el "cascaron" estatico que no cambia y que no dice
   nada sobre el estado del negocio: el logo y las fuentes.
============================================================= */

/* Al subir una version nueva del worker, cambia este numero. Las
   caches viejas se borran solas al activarse.

   v2: migracion a la llave publishable de Supabase. Este worker nunca
   guardo HTML ni supabase-publico.js (van a la red), asi que no hay
   copias viejas con la llave anterior; el cambio de version solo
   garantiza que el worker se reinstale y las PWA ya abiertas se
   recarguen con el HTML nuevo.

   v3: acceso "Mi pedido" arriba en index.html. Mismo criterio que v2:
   el HTML no se cachea, el cambio de version fuerza la reinstalacion
   del worker en las PWA ya instaladas.

   v4: el enlace "Buscas tu pedido" del pie pasa a ser un boton (se
   alcanza con Tab) y el panel gana la impresion de comandas
   (ticket-comanda.js). Mismo criterio: nada de eso se cachea aqui, el
   cambio de version solo fuerza la reinstalacion del worker.

   v5: el ticket de comanda gana selector de tamano de texto, sin
   encabezado ni pie de Chrome y con menos papel en blanco al final
   (ticket-comanda.js y panel.html). Mismo criterio: nada de eso se
   cachea aqui; el cambio de version fuerza la reinstalacion del worker
   para que el panel instalado tome los cambios.

   v6: el ticket pasa a tamano Pequeno por defecto y el panel gana el
   selector "Modo de hoja" y la hoja de calibracion (ticket-comanda.js y
   panel.html). Mismo criterio: nada de eso se cachea aqui; el cambio de
   version fuerza la reinstalacion del worker.

   v7: el modo de hoja D (hoja fija de 297 mm) pasa a ser el de por
   defecto y los pedidos largos se parten en hojas limpias con la linea
   "#<numero> - continuacion" (ticket-comanda.js y panel.html). Mismo
   criterio: nada de eso se cachea aqui; el cambio de version fuerza la
   reinstalacion del worker.

   v8: la barra superior del panel se ordena y el resto de opciones pasa
   a un menu lateral (panel.html); el nombre y el logo del restaurante
   salen de marca.js. Mismo criterio: nada de eso se cachea aqui (el
   HTML y marca.js van a la red); el cambio de version fuerza la
   reinstalacion del worker para que el panel instalado tome el cambio.

   v9: multi-restaurante. El manifest ya no es un archivo estatico sino un
   endpoint por restaurante (/manifest.json -> /api/manifest, segun el
   dominio), y el logo tampoco es siempre el mismo. Por eso el worker ya NO
   precachea nada: ni el manifest (cambia por restaurante) ni un logo
   concreto. Seguia pasando por la red todo lo que es dato: /api/ (incluido
   /api/restaurante y /api/menu), supabase.co, las paginas y el manifest.
   El cache de este worker es, ademas, por origen: un dominio nunca ve el de
   otro. Lo unico que se guarda es lo que se pide bajo /Recursos/ y las fuentes
   (archivos estaticos que no dicen nada del estado del negocio). Subir la
   version borra las caches viejas, que traian el manifest y el logo de
   Taqueiros precacheados.

   v10: paneles por restaurante (panel.html, menu-admin.html, historial.html leen su
   marca y su membresia de /api/restaurante y de la base; marca.js desaparece y entra
   panel-restaurante.js; supabase-publico.js pasa a llamarse window.SUPABASE_PUBLICO).
   Mismo criterio: el HTML y los scripts van a la red; el cambio de version fuerza la
   reinstalacion del worker y borra las caches viejas. El nombre de la cache ya no lleva el
   de ningun restaurante, y NUNCA se guarda aqui un dato de un restaurante: este worker solo
   guarda archivos de /Recursos/ y fuentes, y la cache es por origen (cada restaurante tiene
   el suyo), asi que ni siquiera un archivo estatico puede pasar de un restaurante a otro.

   v11: paso 3A (superadmin y vigencia). panel.html gana la casilla "24:00" y la regla del horario
   (horario-regla.js, archivo nuevo) y la barra de aviso de la suscripcion del dueno; index.html muestra 24:00
   como medianoche. Mismo criterio: nada de eso se cachea aqui (HTML y scripts van a la red); el cambio de
   version fuerza la reinstalacion del worker para que el panel instalado tome los cambios.

   v12: rebrand del restaurante demo a "The Northe Burgers" (docs/multirestaurante.md, seccion 20). Cambian
   la paleta y los iconos que sirve /manifest.json, y entran archivos NUEVOS bajo /Recursos/logo/northe-*
   (nombres nuevos a proposito: asi ninguna copia vieja de logo.png o icono-*.png puede verse con la marca
   nueva). Mismo criterio: el HTML y los scripts van a la red; subir la version borra las caches viejas y
   obliga a reinstalar el worker en el panel ya instalado. */
const VERSION = "v12";
const CACHE_ESTATICO = "panel-estatico-" + VERSION;
/* Prefijos de las caches de versiones anteriores (se borran al activarse la nueva). */
const PREFIJOS_VIEJOS = ["taqueiros-panel-", "panel-estatico-"];

/* Nada se precachea (ver v9): solo se guarda lo que se va pidiendo de los recursos estaticos. */
const CASCARON = [];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE_ESTATICO)
      .then((cache) => cache.addAll(CASCARON))
      // Si algun recurso falla, la instalacion NO se aborta: el
      // worker igual sirve para la instalabilidad.
      .catch((err) => console.warn("[SW] No se pudo precachear:", err))
      .then(() => self.skipWaiting())   // no esperar a que cierren la app
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres
          .filter((n) => PREFIJOS_VIEJOS.some((p) => n.startsWith(p)) && n !== CACHE_ESTATICO)
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())  // tomar el control de inmediato
  );
});

/* Permite que la pagina fuerce la activacion de un worker nuevo */
self.addEventListener("message", (evento) => {
  if (evento.data === "ACTIVAR_YA") self.skipWaiting();
});

self.addEventListener("fetch", (evento) => {
  const req = evento.request;
  const url = new URL(req.url);

  // 1) Todo lo que no sea GET: directo a la red
  if (req.method !== "GET") return;

  // 2) Navegaciones (incluido panel.html): SIEMPRE red.
  //    Asi un despliegue nuevo se ve al recargar, sin quedar
  //    atrapado detras de una version cacheada.
  if (req.mode === "navigate") return;

  // 3) Datos y APIs: SIEMPRE red, jamas cache. El manifest es por restaurante (lo arma el
  //    servidor segun el dominio): tambien siempre red.
  if (url.hostname.endsWith("supabase.co")
      || url.pathname.startsWith("/api/")
      || url.pathname === "/manifest.json"
      || url.pathname.endsWith(".html")) {
    return;
  }

  // 4) Cascaron estatico: primero cache, y si no esta, red.
  const esEstatico =
    (url.origin === self.location.origin && url.pathname.startsWith("/Recursos/"))
    || url.hostname === "fonts.googleapis.com"
    || url.hostname === "fonts.gstatic.com";

  if (!esEstatico) return;   // cualquier otra cosa, red normal

  evento.respondWith(
    caches.match(req).then((enCache) => {
      if (enCache) return enCache;

      return fetch(req).then((respuesta) => {
        // Solo se guarda lo que llego bien
        if (respuesta && (respuesta.ok || respuesta.type === "opaque")) {
          const copia = respuesta.clone();
          caches.open(CACHE_ESTATICO).then((cache) => cache.put(req, copia));
        }
        return respuesta;
      });
    })
  );
});
