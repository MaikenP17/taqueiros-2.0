/* =============================================================
   LOS VALORES DEL RESTAURANTE DEMO (id fijo del SQL 10) QUE ANTES ESTABAN ESCRITOS A MANO EN LAS PAGINAS

   El restaurante demo se llamaba "Los Taqueiros" y desde el SQL 17 (supabase/17-rebrand-northe.sql) es
   "The Northe Burgers". El archivo, sus nombres internos (CONFIG_TAQUEIROS...) y el id NO cambian: son
   identificadores tecnicos, no marca (docs/multirestaurante.md, seccion 20).

   Esta es la UNICA copia que queda de esos valores en el codigo. Existe por una sola razon: que el demo
   se siga viendo completo en el momento entre desplegar este codigo y correr el SQL de su marca (que
   guarda los mismos valores en restaurantes.config, donde viven de ahora en adelante).

   REGLAS
     * Solo se usa para el restaurante demo (id fijo del SQL 10), nunca para otro restaurante, y solo
       para lo que su config todavia no trae (campo por campo; lo que esta en la base manda). Cada uso
       deja un aviso en el log. Por eso, hasta que se corra el SQL 17, el sitio sigue mostrando la marca
       anterior: lo que esta en la base manda.
     * Debe ser IDENTICA al estado final de la base: SQL 12 + SQL 17 (la prueba
       pruebas/multirestaurante/config-publica.mjs lo comprueba aplicando los dos).
     * Son datos publicos por diseno (nada de secretos: la llave de Wompi pub_... es la llave PUBLICA
       del comercio).
     * Cuando el SQL 12 y el 17 ya esten corridos en produccion se puede borrar este archivo junto con
       su uso en api/_publico.js.

   FORMA (ver docs/multirestaurante.md, seccion 14):
     publico.marca     logo, iconos, emoji, colores, colores_zonas
     publico.textos    textos del sitio y del seguimiento
     publico.contacto  WhatsApp, telefono, direccion, redes
     publico.wompi     llaves PUBLICAS de Wompi (test y prod)
     publico.pwa       nombre del panel instalable
     ubicacion         donde esta el local (origen del domicilio)
     domicilio         factor de recorrido y area de cobertura
============================================================= */

const CONFIG_TAQUEIROS = {
  publico: {
    marca: {
      logo: "Recursos/logo/northe-logo.png",
      icono_192: "Recursos/logo/northe-icono-192.png",
      icono_512: "Recursos/logo/northe-icono-512.png",
      emoji: "🍔",
      colores: {
        primario: "#C92423",
        primario_oscuro: "#8E1B1A",
        primario_brillo: "#E8514A",
        claro: "#FFEBC6",
        claro_suave: "#FFF6E3",
        oscuro: "#220F08",
        oscuro_2: "#2E160D",
        acento: "#EEA927",
        positivo: "#5C7A3B",
        texto_secundario: "#E6D3AE",
        texto_tenue: "#BFA987",
        positivo_brillo: "#7FA855"
      },
      colores_zonas: ["#5C7A3B", "#8FA83F", "#E3A008", "#E07B39"]
    },
    textos: {
      titulo_pagina: "The Northe Burgers | Burgers con actitud de calle en Cúcuta",
      descripcion_pagina: "The Northe Burgers — hamburguesas smash, hot dogs cargados y papas crinkle en Cúcuta. Pide en línea y recibe tu pedido por WhatsApp.",
      eslogan: "Burgers · Hot Dogs · Papas",
      tagline: "Street food con actitud: hamburguesas smash, hot dogs cargados y papas que no se olvidan. Pide en dos clics y recíbelo por WhatsApp.",
      descripcion_pie: "Hamburguesas smash, hot dogs cargados y papas crinkle hechos con receta propia, en el corazón de Cúcuta. Pide en línea y te lo llevamos hasta la puerta.",
      servicios_linea: "🛵 Domicilio gratis · 🥡 Para llevar · 🍽️ En el local",
      pie_final: "Cúcuta, Colombia. Burgers con actitud de calle 🍔",
      ejemplo_nota: "Ej: sin cebolla, extra salsa, tocarle el timbre...",
      banner_abierto_icono: "🔥",
      banner_abierto_titulo: "¡La plancha está prendida!",
      banner_abierto_texto: "Ahorita sí estamos atendiendo pedidos{cierre}. ¡Antójate y pide ya! 🍔",
      banner_cerrado_icono: "🍔",
      banner_cerrado_mensaje: "Por hoy ya apagamos la plancha.",
      seguimiento: {
        tiempo_nuevo: "Suele estar listo en 25 – 40 minutos",
        tiempo_preparacion: "Ya está en la plancha, unos 15 – 25 minutos más",
        tiempo_camino: "El domiciliario va en camino, 10 – 20 minutos",
        tiempo_recoger: "¡Ya puedes pasar por él!",
        tiempo_entregado: "¡Buen provecho! 🍔",
        frase_nuevo: "¡Recibimos tu pedido! 🍔",
        frase_preparacion: "Lo estamos preparando 🔥",
        frase_camino: "¡Va en camino! 🛵",
        frase_recoger: "¡Tu pedido está listo! 🥡",
        frase_entregado: "¡Entregado! 🎉"
      }
    },
    contacto: {
      whatsapp: "573125249438",
      telefono: "+57 312 524 9438",
      direccion: "Cl 1AN #3E-7, Barrio La Ceiba, Cúcuta, Norte de Santander",
      direccion_corta: "Cl 1AN #3E-7, Barrio La Ceiba, Cúcuta",
      ciudad: "Cúcuta",
      region: "Norte de Santander",
      instagram: "thenorthe.burgers",
      tiktok: "thenorthe.burgers"
    },
    wompi: {
      llave_publica_test: "pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz",
      llave_publica_prod: "pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW"
    },
    pwa: {
      nombre: "Panel The Northe Burgers",
      nombre_corto: "Comandas"
    }
  },
  ubicacion: { lat: 7.8997382, lng: -72.4968525 },
  domicilio: {
    factor_recorrido: 1.3,
    pin_minimo_metros: 100,
    area: { latMin: 7.75, latMax: 8.1, lngMin: -72.68, lngMax: -72.35 }
  }
};

module.exports = { CONFIG_TAQUEIROS };
