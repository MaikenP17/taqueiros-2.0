/* =============================================================
   LOS VALORES DE TAQUEIROS QUE ANTES ESTABAN ESCRITOS A MANO EN LAS PAGINAS

   Esta es la UNICA copia que queda de esos valores en el codigo. Existe por
   una sola razon: que Taqueiros se siga viendo igual en el momento entre
   desplegar este codigo y correr supabase/12-config-publica.sql (que guarda
   los mismos valores en restaurantes.config, donde viven de ahora en adelante).

   REGLAS
     * Solo se usa para Taqueiros (id fijo del SQL 10), nunca para otro
       restaurante, y solo para lo que su config todavia no trae (campo por
       campo; lo que esta en la base manda). Cada uso deja un aviso en el log.
     * Debe ser IDENTICA a la que lleva el SQL 12: la prueba
       pruebas/multirestaurante/config-publica.mjs lo comprueba.
     * Son datos publicos por diseno (nada de secretos: la llave de Wompi
       pub_... es la llave PUBLICA del comercio).
     * Cuando el SQL 12 ya este corrido en produccion se puede borrar este
       archivo junto con su uso en api/_publico.js.

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
      logo: "Recursos/logo/logo.png",
      icono_192: "Recursos/logo/icono-192.png",
      icono_512: "Recursos/logo/icono-512.png",
      emoji: "🌮",
      colores: {
        primario: "#C1272D",
        primario_oscuro: "#8A1B1F",
        primario_brillo: "#E14A42",
        claro: "#F7ECD6",
        claro_suave: "#FFF8EA",
        oscuro: "#1C1210",
        oscuro_2: "#241714",
        acento: "#E3A008",
        positivo: "#5C7A3B",
        texto_secundario: "#D9C9A8",
        texto_tenue: "#B9A88C",
        positivo_brillo: "#7FA855"
      },
      colores_zonas: ["#5C7A3B", "#8FA83F", "#E3A008", "#E07B39"]
    },
    textos: {
      titulo_pagina: "Los Taqueiros | Tacos, Birria y Antojitos en Cúcuta",
      descripcion_pagina: "Los Taqueiros — tacos, birria, dorilocos y antojitos mexicanos en Cúcuta. Pide en línea y recibe tu pedido por WhatsApp.",
      eslogan: "Tacos · Birria · Antojitos",
      tagline: "Del comal directo a tu mesa: tacos jugosos, birria con consomé y dorilocos bien cargados. Pide en dos clics y recíbelo por WhatsApp.",
      descripcion_pie: "Tacos, birria y antojitos mexicanos hechos con receta propia, en el corazón de Cúcuta. Pide en línea y te lo llevamos hasta la puerta.",
      servicios_linea: "🛵 Domicilio gratis · 🥡 Para llevar · 🍽️ En el local",
      pie_final: "Cúcuta, Colombia. Hecho con antojo 🌶️",
      ejemplo_nota: "Ej: sin cebolla, extra picante, tocarle el timbre...",
      banner_abierto_icono: "🔥",
      banner_abierto_titulo: "¡Estamos que ardemos!",
      banner_abierto_texto: "Ahorita sí estamos atendiendo pedidos{cierre}. ¡Antójate y pide ya! 🌮",
      banner_cerrado_icono: "🌮",
      banner_cerrado_mensaje: "Por hoy ya cerramos la cocina.",
      seguimiento: {
        tiempo_nuevo: "Suele estar listo en 25 – 40 minutos",
        tiempo_preparacion: "Ya está en el comal, unos 15 – 25 minutos más",
        tiempo_camino: "El domiciliario va en camino, 10 – 20 minutos",
        tiempo_recoger: "¡Ya puedes pasar por él!",
        tiempo_entregado: "¡Buen provecho! 🌮",
        frase_nuevo: "¡Recibimos tu pedido! 🌮",
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
      instagram: "lostaqueiros.co",
      tiktok: "lostaqueiros_cuc"
    },
    wompi: {
      llave_publica_test: "pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz",
      llave_publica_prod: "pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW"
    },
    pwa: {
      nombre: "Panel Taqueiros",
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
