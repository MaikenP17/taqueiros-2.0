/* =============================================================
   LAS REGLAS DEL NAVEGADOR = LAS DE LA BASE  (formulario "Datos de mi restaurante")

   datos-restaurante.js valida cada campo ANTES de guardar con las mismas reglas que la base. Aqui se
   demuestra, con Postgres real (PGlite con los SQL 10 a 13 y 15): para miles de combinaciones de
   campo y valor, el navegador y public.config_restaurante_errores (SQL 13) dan el MISMO veredicto, y lo
   que arma el formulario lo guarda public.guardar_datos_restaurante (SQL 15) tal cual.

   Se llama desde datos-restaurante.mjs.
============================================================= */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DR = require('../../datos-restaurante.js');

const ccodigo = (n) => String.fromCharCode(n);

export async function pruebaReglas({ baseConSql13, SQL15, prueba, TAQ, igual }) {
  const d = await baseConSql13();
  await d.exec(SQL15());
  const base = (await d.query('select config from public.restaurantes where id = $1', [TAQ])).rows[0].config;

  const muestras = [
    '', ' ', 'Hola', 'Tacos y más', 'Cúcuta 🌮', 'a', 'x y', 'palabra '.repeat(50), 'palabra '.repeat(50) + 'x', 'ab '.repeat(70), 'ab '.repeat(70) + 'ab', 'z '.repeat(100), 'z '.repeat(101),
    '<b>x</b>', 'a>b', 'a<b', '&lt;', '"comillas"', "comilla'simple", 'dos\nlineas', 'tab\taqui', 'a' + ccodigo(0x200b) + 'b', 'a' + ccodigo(0x202e) + 'b', ccodigo(7),
    'prv_test_abcdefghijk', 'sb_secret_abcdefghijk', 'sb_publishable_abcdefghij', 'test_integrity_abc', 'prod_events_abc', 'mi apikey', 'api_key', 'service_role',
    'eyJhbGciOiJIUzI1.NiIsInR5cCI6IkpX', '-----BEGIN PRIVATE', 'PRV_TEST_X', 'SB_SECRET_X',
    'A'.repeat(31), 'A'.repeat(32), 'A-b_C'.repeat(10), '12345678901234567890123456789012', '573001234567', '+57 300 123 4567', '(57) 300-123-4567', '1234567', '12345678',
    '123456789012345', '1234567890123456', 'abc', '5730012345 67x', '@mi.usuario', 'mi.usuario', 'mi usuario', 'a/b', 'u'.repeat(60), 'u'.repeat(61), 'mi_usuario.1',
    '🌮'.repeat(400), '🌮'.repeat(401), '🌮'.repeat(200), '🌮'.repeat(201), '🌮'.repeat(80), '🌮'.repeat(81), 't'.repeat(40), 'd'.repeat(200), 'c'.repeat(80)
  ];
  // y ruido pseudoaleatorio con una semilla fija
  let semilla = 12345;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) & 0x7fffffff; return semilla / 0x7fffffff; };
  const alfabeto = Array.from('abcXYZ019 .,-_@+()<>"\'&:;/\n\t' + ccodigo(0x200b) + '🌮ñé');
  for (let i = 0; i < 400; i++) {
    let x = '';
    const n = Math.floor(azar() * 30);
    for (let j = 0; j < n; j++) x += alfabeto[Math.floor(azar() * alfabeto.length)];
    muestras.push(x);
  }

  const campos = DR.CAMPOS.filter((c) => c.campo !== 'nombre');
  const dif = [];
  let total = 0;
  for (const def of campos) {
    for (const crudo of muestras) {
      const n = DR.normalizar(def.campo, crudo).valor;
      const local = DR.validarCampo(def.campo, n).length === 0;
      const cand = DR.candidato(base, { [def.campo]: n });
      const baseOk = (await d.query('select public.config_restaurante_errores($1::jsonb) e', [JSON.stringify(cand)])).rows[0].e.length === 0;
      total++;
      if (local !== baseOk) dif.push(def.campo + ' ' + JSON.stringify(crudo).slice(0, 40) + ' -> navegador ' + local + ', base ' + baseOk);
    }
  }
  prueba('E1 las reglas del navegador = las de la base: ' + total + ' combinaciones de campo y valor (hostiles, limites, emojis, secretos, WhatsApp, usuarios, ruido) dan el mismo veredicto', dif.length === 0, dif.slice(0, 4).join(' | '));

  // el nombre: la base lo valida en el trigger de restaurantes (SQL 13) y en guardar_datos_restaurante (SQL 15)
  const difN = [];
  const nombres = ['', 'Los Taqueiros', 'a', 'n'.repeat(120), 'n'.repeat(121), '<b>', 'a>b', 'dos\nlineas', ccodigo(7), 'a' + ccodigo(0x200b), '🌮'.repeat(120), '🌮'.repeat(121), 'Taquería "El Güero"', "O'Brien & Co"];
  for (const crudo of nombres) {
    const n = DR.normalizar('nombre', crudo).valor;
    const local = DR.validarCampo('nombre', n).length === 0;
    const actual = (await d.query('select nombre from public.restaurantes where id = $1', [TAQ])).rows[0].nombre;
    let baseOk;
    try {
      await d.query('select public.guardar_datos_restaurante($1::uuid, $2::jsonb)', [TAQ, JSON.stringify([{ campo: 'nombre', antes: actual, despues: n === '' ? null : n }])]);
      baseOk = true;
    } catch (e) { baseOk = false; }
    if (baseOk) await d.query('update public.restaurantes set nombre = $2 where id = $1', [TAQ, actual]);
    if (local !== baseOk) difN.push(JSON.stringify(crudo).slice(0, 30) + ' -> navegador ' + local + ', base ' + baseOk);
  }
  prueba('E2 el nombre: el navegador y la base aceptan y rechazan lo mismo (' + nombres.length + ' valores)', difN.length === 0, difN.join(' | '));

  // abrir y guardar sin tocar nada no manda cambios; lo que arma el formulario lo guarda la funcion tal cual
  const orig = (await d.query('select nombre, config from public.restaurantes where id = $1', [TAQ])).rows[0];
  const valores = {};
  DR.CAMPOS.forEach((c) => { valores[c.campo] = DR.leer(orig, c.campo).trim(); });
  prueba('E3 abrir y guardar sin tocar nada: el formulario no manda ningun cambio', DR.diferencias(orig, valores).length === 0, JSON.stringify(DR.diferencias(orig, valores)).slice(0, 200));
  valores['textos.eslogan'] = 'Eslogan del formulario';
  valores['contacto.ciudad'] = '';
  const cambios = DR.diferencias(orig, valores);
  const rr = (await d.query('select public.guardar_datos_restaurante($1::uuid, $2::jsonb) r', [TAQ, JSON.stringify(cambios)])).rows[0].r;
  const despues = (await d.query('select nombre, config from public.restaurantes where id = $1', [TAQ])).rows[0];
  prueba('E4 lo que arma el formulario (diferencias) lo guarda la funcion tal cual, y el resto de la config queda igual',
    rr.ok === true && cambios.length === 2 && despues.config.publico.textos.eslogan === 'Eslogan del formulario' && !('ciudad' in despues.config.publico.contacto)
    && igual(DR.candidato(orig.config, valores), despues.config), JSON.stringify(rr).slice(0, 200));
}
