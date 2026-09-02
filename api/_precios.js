/* =============================================================
   CATALOGO AUTORITATIVO DE PRECIOS (lado servidor)
   -------------------------------------------------------------
   El navegador NUNCA decide cuanto se cobra: envia solo los ids y
   las cantidades, y el servidor calcula el total con estos precios.
   Asi nadie puede manipular el monto desde la consola del navegador.

   IMPORTANTE: si cambias un precio en el menu de index.html
   (arreglo CATEGORIES), cambialo TAMBIEN aqui. Deben coincidir.
============================================================= */
const PRECIOS = {
  "bandeja-mixta": {
    "nombre": "Bandeja Mixta",
    "precio": 28000
  },
  "bandeja-buchona": {
    "nombre": "Bandeja Buchona",
    "precio": 29000
  },
  "bandeja-chichona-x2": {
    "nombre": "Bandeja Chichona x2",
    "precio": 17000
  },
  "bandeja-chichona-x4": {
    "nombre": "Bandeja Chichona x4",
    "precio": 31000
  },
  "bandeja-chingona-x2": {
    "nombre": "Bandeja Chingona x2",
    "precio": 16000
  },
  "bandeja-chingona-x4": {
    "nombre": "Bandeja Chingona x4",
    "precio": 27000
  },
  "bandeja-perrona-x2": {
    "nombre": "Bandeja Perrona x2",
    "precio": 15000
  },
  "bandeja-perrona-x4": {
    "nombre": "Bandeja Perrona x4",
    "precio": 26000
  },
  "bandeja-vergona-x2": {
    "nombre": "Bandeja Vergona x2",
    "precio": 17000
  },
  "bandeja-vergona-x4": {
    "nombre": "Bandeja Vergona x4",
    "precio": 28000
  },
  "doriloco": {
    "nombre": "Doriloco",
    "precio": 26000
  },
  "doriloco-recargado": {
    "nombre": "Doriloco Recargado",
    "precio": 30000
  },
  "nachos-locos-p": {
    "nombre": "Nachos Locos Pequeño",
    "precio": 15000
  },
  "nachos-locos-g": {
    "nombre": "Nachos Locos Grande",
    "precio": 25000
  },
  "birriamen": {
    "nombre": "Birriamen",
    "precio": 26000
  },
  "birriaco": {
    "nombre": "Birriaco",
    "precio": 30000
  },
  "hamburguesa-chida": {
    "nombre": "Hamburguesa La Chida",
    "precio": 28000
  },
  "nachos-padrisimos": {
    "nombre": "Nachos Padrísimos",
    "precio": 32000
  },
  "chicana-birria": {
    "nombre": "Chicana de Birria",
    "precio": 30000
  },
  "agua-brisa": {
    "nombre": "Agua",
    "precio": 3000
  },
  "cocacola": {
    "nombre": "Coca Cola",
    "precio": 5000
  },
  "coronita": {
    "nombre": "Coronita",
    "precio": 7000
  },
  "cerveza-sol": {
    "nombre": "Cerveza Sol",
    "precio": 5000
  },
  "agua-horchata": {
    "nombre": "Horchata",
    "precio": 9000
  },
  "agua-jamaica": {
    "nombre": "Flor de Jamaica",
    "precio": 9000
  },
  "agua-tamarindo": {
    "nombre": "Tamarindo",
    "precio": 9000
  },
  "add-chicharron": {
    "nombre": "Chicharrón",
    "precio": 8000
  },
  "add-chorizo": {
    "nombre": "Chorizo",
    "precio": 4000
  },
  "add-pechuga": {
    "nombre": "Pechuga",
    "precio": 8000
  },
  "add-carne-birria": {
    "nombre": "Carne de Birria",
    "precio": 7000
  },
  "add-caldo-birria": {
    "nombre": "Caldo de Birria",
    "precio": 5000
  },
  "add-queso": {
    "nombre": "Queso",
    "precio": 3000
  },
  "add-nachos": {
    "nombre": "Nachos",
    "precio": 5000
  },
  "add-tortillas": {
    "nombre": "Tortillas x3",
    "precio": 6000
  },
  "add-papa-casco": {
    "nombre": "Papa Casco",
    "precio": 6000
  },
  "add-pico-gallo": {
    "nombre": "Pico de Gallo",
    "precio": 4000
  },
  "add-guacamole": {
    "nombre": "Guacamole",
    "precio": 5000
  },
  "add-salsas": {
    "nombre": "Salsas",
    "precio": 2000
  }
};

module.exports = { PRECIOS };
