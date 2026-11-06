/* Arranque de la pantalla de superadministracion: va al final porque necesita que todos los demas archivos ya hayan cargado.

   SOLO ARRANCA EN SU DIRECCION EXACTA (docs 24.13, R1). Vercel busca el archivo con la ruta decodificada pero elige las cabeceras
   comparando la ruta cruda: /%73uperadmin.html o /superadmin.html%2f cargan esta misma pagina SIN la CSP, sin X-Frame-Options y
   sin no-store. Por eso, si la direccion no es exactamente /superadmin.html, la pagina se va a esa direccion antes de mostrar nada;
   y dentro de un marco (de cualquier sitio) no arma nada. */
(function () {
  "use strict";
  var enMarco = true;
  try { enMarco = window.top !== window.self; } catch (e) { enMarco = true; }
  if (enMarco) return;
  if (window.location.pathname !== "/superadmin.html") { window.location.replace("/superadmin.html"); return; }
  window.SA.arrancar();
})();
