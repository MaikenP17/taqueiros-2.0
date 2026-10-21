/* =============================================================
   CONFIGURACION PUBLICA DE SUPABASE (una sola copia)

   Aqui vive la direccion del proyecto y la llave PUBLISHABLE
   (sb_publishable_...). Esa llave es publica por diseno: va en el
   navegador de cualquier visitante. Lo que protege los datos son
   las reglas RLS de la base, no esconder esta llave.

   LO QUE NUNCA VA EN ESTE ARCHIVO
   La llave secreta (sb_secret_...) ni la service_role legacy. Esas
   viven solo en las variables de entorno de Vercel.

   COMO SE USA
   Todas las paginas cargan este archivo antes de su propio script:
     <script src="supabase-publico.js?v=2"></script>
   y leen window.SUPABASE_PUBLICO.

   COMO SE ENVIA LA LLAVE
   Las llaves nuevas NO son JWT. Con 'fetch' directo se manda SOLO en
   la cabecera 'apikey', nunca como 'Authorization: Bearer'. Donde hay
   un usuario con sesion (panel, menu-admin, historial) el
   Authorization es el token de la sesion, como siempre. supabase-js
   se encarga de eso solo cuando se le pasa esta llave.

   VERSIONADO (PWA)
   El service worker no intercepta este archivo: va siempre a la red.
   Si algun dia cambia la llave, sube el numero de '?v=' en las
   paginas que lo cargan para que ninguna copia vieja sobreviva en
   la cache HTTP del navegador.
============================================================= */
window.SUPABASE_PUBLICO = Object.freeze({
  url: "https://pzryobpriyewlxltditw.supabase.co",
  publishableKey: "sb_publishable_z16BcFrV9JvRKlKOy118PA_71-sWQqa"
});
