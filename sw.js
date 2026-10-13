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
   reinstalacion del worker para que el panel instalado tome el cambio. */
const VERSION = "v8";
const CACHE_ESTATICO = "taqueiros-panel-" + VERSION;

/* Solo recursos que no revelan datos ni cambian con el negocio */
const CASCARON = [
  "/Recursos/logo/logo.png",
  "/manifest.json"
];

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
          .filter((n) => n.startsWith("taqueiros-panel-") && n !== CACHE_ESTATICO)
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

  // 3) Datos y APIs: SIEMPRE red, jamas cache.
  if (url.hostname.endsWith("supabase.co")
      || url.pathname.startsWith("/api/")
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
