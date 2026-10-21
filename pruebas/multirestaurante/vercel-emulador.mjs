/* =============================================================
   EMULADOR DEL ENRUTADOR DE VERCEL (lo justo para vercel.json de este proyecto)

   Las pruebas no pueden desplegar en Vercel, asi que este modulo aplica a una
   peticion lo que DOCUMENTA Vercel (vercel.com/docs/project-configuration/vercel-json):

     1. redirects, en orden   (source + has/missing por cabecera)
     2. el sistema de archivos: un archivo estatico del sitio o una funcion de api/
        (un archivo que no empieza por guion bajo). ESTE PASO VA ANTES QUE LAS
        REESCRITURAS: "precedence is given to the filesystem prior to rewrites
        being applied". Por eso la vista previa es una redireccion y no una reescritura.
     3. rewrites, en orden    (source + has/missing por cabecera); el destino se
        resuelve otra vez contra el sistema de archivos.

   Solo entiende lo que vercel.json usa hoy (sources literales; has/missing de tipo
   header con un valor regex que debe coincidir completo). Si alguien agrega otra
   cosa, LANZA un error en vez de adivinar: asi esta prueba nunca da por buena una
   regla que no sabe interpretar.

   Lo que NO se puede comprobar aqui (y se comprueba en produccion, ver docs 17.8):
   que la plataforma real se comporte como esta documentacion. En particular:
     * que la URL que llega a la funcion sea la original o la reescrita: el emulador
       entrega las DOS (urlOriginal y urlReescrita) y las pruebas exigen que ambas funcionen;
     * que, si la consulta original y la del destino repiten un nombre, gane el destino
       (aqui gana el destino; el despachador no depende de eso porque el PATH manda).
============================================================= */
import fs from 'node:fs';
import path from 'node:path';

const IGNORADOS = ['supabase', 'pruebas', 'docs', '.env.example', 'node_modules', 'respaldos', '.git', 'vercel.json', '.vercelignore', '.gitignore'];

export function listarFunciones(repo) {
  const base = path.join(repo, 'api');
  const salida = [];
  (function recorrer(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;     // lo que empieza por guion bajo NO es una funcion
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) recorrer(path.join(dir, e.name), r);
      else if (/[.](js|mjs|cjs|ts)$/.test(e.name)) salida.push(`api/${r}`);
    }
  })(base, '');
  return salida.sort();
}

function dividirUrl(u) {
  const i = u.indexOf('?');
  return { pathname: i < 0 ? u : u.slice(0, i), search: i < 0 ? '' : u.slice(i + 1) };
}

function condiciones(lista, cabeceras) {
  for (const c of lista || []) {
    if (c.type !== 'header') throw new Error('vercel-emulador: solo se entiende has/missing de tipo header, no ' + c.type);
    const valor = cabeceras[String(c.key).toLowerCase()];
    c._cumple = valor !== undefined && (c.value === undefined || new RegExp('^(?:' + c.value + ')$').test(String(valor)));
  }
  return lista || [];
}

function literal(source) {
  if (/[:(*?+{}\\[\]|^$]/.test(source)) throw new Error('vercel-emulador: source no literal, el emulador no lo entiende: ' + source);
  return source;
}

export function crearEmulador(repoEntrada, config) {
  const repo = path.resolve(repoEntrada);
  const cfg = config || JSON.parse(fs.readFileSync(path.join(repo, 'vercel.json'), 'utf8'));
  const funciones = listarFunciones(repo);

  const aplica = (regla, pathname, cabeceras) => {
    if (literal(regla.source) !== pathname) return false;
    const tiene = condiciones(regla.has, cabeceras).every((c) => c._cumple);
    const falta = condiciones(regla.missing, cabeceras).every((c) => !c._cumple);
    return tiene && falta;
  };

  /* Sistema de archivos: '/api/menu' -> funcion api/menu.js; '/' -> index.html; '/x.js' -> archivo del repo */
  function archivo(pathname) {
    const limpio = pathname.replace(/\/+$/, '') || '/';
    const comoFuncion = funciones.find((f) => `/${f}` === limpio + '.js' || `/${f}` === limpio);
    if (comoFuncion && limpio.startsWith('/api/')) return { tipo: 'funcion', archivo: comoFuncion };
    const rel = limpio === '/' ? 'index.html' : limpio.slice(1);
    if (IGNORADOS.includes(rel.split('/')[0]) || rel.startsWith('api/')) return null;
    const ruta = path.join(repo, rel);
    return ruta.startsWith(repo) && fs.existsSync(ruta) && fs.statSync(ruta).isFile() ? { tipo: 'estatico', archivo: rel } : null;
  }

  function unir(consultaOriginal, consultaDestino) {
    const q = new URLSearchParams(consultaOriginal);
    for (const [k, v] of new URLSearchParams(consultaDestino)) q.set(k, v);     // en un choque gana el destino
    return q.toString();
  }

  function resolver({ metodo = 'GET', ruta, headers = {} }) {
    const cab = {};
    for (const k of Object.keys(headers)) cab[k.toLowerCase()] = Array.isArray(headers[k]) ? headers[k][0] : headers[k];
    const { pathname, search } = dividirUrl(ruta);

    for (const r of cfg.redirects || []) {
      if (aplica(r, pathname, cab)) {
        return { tipo: 'redireccion', estado: r.statusCode || (r.permanent === false ? 307 : 308), location: r.destination };
      }
    }
    const directo = archivo(pathname);
    if (directo) {
      return directo.tipo === 'funcion'
        ? { ...directo, urlOriginal: ruta, urlReescrita: ruta, metodo }
        : { ...directo, metodo };
    }
    for (const r of cfg.rewrites || []) {
      if (!aplica(r, pathname, cab)) continue;
      const d = dividirUrl(r.destination);
      const destino = archivo(d.pathname);
      if (!destino) return { tipo: '404', motivo: 'la reescritura apunta a algo que no existe: ' + r.destination };
      const q = unir(search, d.search);
      return destino.tipo === 'funcion'
        ? { ...destino, metodo, urlOriginal: ruta, urlReescrita: d.pathname + (q ? '?' + q : ''), regla: r }
        : { ...destino, metodo, regla: r };
    }
    return { tipo: '404', motivo: 'sin archivo ni regla' };
  }

  return { resolver, funciones, config: cfg, archivo };
}
