/* =============================================================
   MARCA DEL RESTAURANTE (una sola copia)

   Aqui vive el nombre y el logo que muestra el panel. Para montar
   este sistema en otro restaurante se cambian estas dos lineas y se
   reemplaza el archivo del logo: panel.html no repite el nombre en
   ningun otro sitio.

   COMO SE USA
   panel.html carga este archivo en el <head>, antes de pintarse
   nada:
     <script src="marca.js?v=1"></script>
   y despues marca los elementos que muestran la marca:
     data-marca-nombre      -> recibe el nombre como texto
     data-marca-logo        -> <img>: recibe el logo (y el nombre
                               como 'alt', salvo que ademas lleve
                               data-marca-decorativo)
   El titulo de la pestana y los iconos (favicon / apple-touch) los
   pone este mismo archivo. El resto del JS lee window.TAQUEIROS_MARCA.

   LO QUE NO CUBRE
   OJO: el panel sigue con su marca escrita aqui (se pasa a los datos de
   /api/restaurante en el paso del panel). Lo que YA no es estatico: el manifest
   (/manifest.json -> /api/manifest, por restaurante), index.html y pedido.html
   (restaurante-publico.js). sw.js no lleva marca ni cachea nada del negocio.

   VERSIONADO
   El service worker no intercepta este archivo (va a la red). Si
   cambia, sube el numero de '?v=' en las paginas que lo cargan.
============================================================= */
(function () {
  "use strict";

  var MARCA = {
    nombre: "Los Taqueiros",
    logo: "Recursos/logo/logo.png"
  };
  window.TAQUEIROS_MARCA = MARCA;

  // Titulo de la pestana: "<lo que ya diga la pagina> | <restaurante>"
  document.title = document.title.replace(/\s*\|.*$/, "") + " | " + MARCA.nombre;

  // Iconos de la pestana y de la pantalla de inicio
  [["icon", "image/png"], ["apple-touch-icon", ""]].forEach(function (par) {
    var enlace = document.createElement("link");
    enlace.rel = par[0];
    if (par[1]) enlace.type = par[1];
    enlace.href = (par[0] === "apple-touch-icon" ? "/" : "") + MARCA.logo;
    document.head.appendChild(enlace);
  });

  function aplicar() {
    var nombres = document.querySelectorAll("[data-marca-nombre]");
    for (var i = 0; i < nombres.length; i++) nombres[i].textContent = MARCA.nombre;

    var logos = document.querySelectorAll("[data-marca-logo]");
    for (var j = 0; j < logos.length; j++) {
      logos[j].src = MARCA.logo;
      logos[j].alt = logos[j].hasAttribute("data-marca-decorativo") ? "" : MARCA.nombre;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", aplicar);
  } else {
    aplicar();
  }
})();
