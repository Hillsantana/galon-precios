// Lee los precios semanales de combustibles en la portada del MICM (micm.gob.do)
// y agrega la semana nueva a prices.json. Si algo no cuadra, falla sin tocar el archivo.
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = process.env.MICM_URL || 'https://micm.gob.do/';
const FILE = new URL('../prices.json', import.meta.url);

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const FUELS = [
  ['premium', /gasolina\s+pr[eé]mium/i],
  ['regular', /gasolina\s+regular/i],
  ['optimo',  /gasoil\s+[óo]ptimo/i],
  ['gasoil',  /gasoil\s+regular/i],
  ['glp',     /\(?\s*GLP\s*\)?|gas\s+licuado/i],
  ['gn',      /gas\s+natural/i],
];

const pad = n => String(n).padStart(2, '0');

export function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&oacute;/g, 'ó').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&aacute;/g, 'á').replace(/&uacute;/g, 'ú')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ');
}

export function parse(html) {
  const text = toText(html);
  // "semana del 31 de octubre al 06 de noviembre del 2026"
  let m = text.match(/semana\s+(?:del?\s+)?(\d{1,2})(?:\s+(?:de\s+)?([a-záéíóú]+))?\s+(?:al|a|hasta\s+el)\s+(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\s*,?\s*(?:del?\s+)?(\d{4})/i);
  if (m && m[2] && !MESES[m[2].toLowerCase()]) m = null;
  if (!m) {
    // Formato numérico: "semana del 07/11 al 13/11/2026"
    const n = text.match(/semana\s+(?:del?\s+)?(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\s+(?:al|a)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (n) {
      const names = Object.keys(MESES);
      m = [n[0], n[1], names.find(k => MESES[k] === +n[2]), n[3], names.find(k => MESES[k] === +n[4]), n[5]];
      m.index = n.index;
    }
  }
  if (!m) {
    const err = new Error('No encontré la frase "semana del … al …" en la página del MICM.');
    err.pageText = text;
    throw err;
  }
  const endMonth = MESES[m[4].toLowerCase()];
  const startMonth = m[2] ? MESES[m[2].toLowerCase()] : endMonth;
  if (!startMonth || !endMonth) throw new Error('Mes desconocido: ' + m[0]);
  let year = +m[5];
  if (startMonth > endMonth) year -= 1; // semana que cruza de diciembre a enero
  const start = `${year}-${pad(startMonth)}-${pad(+m[1])}`;

  // Bloque de precios: lo que sigue a la frase de la semana
  const block = text.slice(m.index, m.index + 1500);
  const priceRe = /\$\s?([\d,]+\.\d{2})/g;
  const prices = [...block.matchAll(priceRe)].map(x => ({ v: parseFloat(x[1].replace(/,/g, '')), at: x.index, end: x.index + x[0].length }));
  if (prices.length < 6) throw new Error(`Solo encontré ${prices.length} precios en el bloque.`);

  // ¿El precio va antes del nombre ("$358.10 Gasolina Premium") o después ("Gasolina Premium $358.10")?
  const labels = FUELS.map(([id, re]) => {
    const lm = block.match(re);
    if (!lm) throw new Error('No encontré el combustible: ' + id);
    return { id, at: lm.index, end: lm.index + lm[0].length };
  });
  const priceFirst = prices[0].at < Math.min(...labels.map(l => l.at));

  const week = { start };
  for (const l of labels) {
    const pick = priceFirst
      ? prices.filter(p => p.end <= l.at).pop()
      : prices.find(p => p.at >= l.end);
    const id = l.id;
    if (!pick) throw new Error('Sin precio para: ' + id);
    week[id] = pick.v;
  }
  const vals = FUELS.map(([id]) => week[id]);
  if (new Set(vals).size < 5) throw new Error('Varios combustibles con el mismo precio; la lectura parece incorrecta.');
  return week;
}

function check(week, prev) {
  for (const [id] of FUELS) {
    const v = week[id];
    if (!(v > 10 && v < 1000)) throw new Error(`Precio raro para ${id}: ${v}`);
    if (prev && Math.abs(v - prev[id]) / prev[id] > 0.25) throw new Error(`Cambio de más de 25% en ${id}: ${prev[id]} → ${v}. Revisar a mano.`);
  }
  const d = new Date(week.start + 'T12:00:00Z');
  if (isNaN(d)) throw new Error('Fecha inválida: ' + week.start);
  if (d.getUTCDay() !== 6) console.warn(`Aviso: ${week.start} no es sábado.`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-DO,es;q=0.9',
};

// Hasta 3 intentos, por si el MICM responde una página de error o de bloqueo.
async function fetchWeek() {
  let last;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(SOURCE, { headers: HEADERS, redirect: 'follow' });
      const html = await res.text();
      if (!res.ok) { const e = new Error(`El MICM respondió ${res.status}`); e.pageText = toText(html); throw e; }
      return parse(html);
    } catch (e) {
      last = e;
      console.warn(`Intento ${i} falló: ${e.message}`);
      if (i < 3) await sleep(20000);
    }
  }
  if (last.pageText) {
    console.error('--- Lo que respondió el MICM (primeros 800 caracteres) ---');
    console.error(last.pageText.trim().slice(0, 800));
    const k = last.pageText.search(/semana/i);
    if (k >= 0) { console.error('--- Texto cerca de "semana" ---'); console.error(last.pageText.slice(Math.max(0, k - 100), k + 400)); }
  }
  throw last;
}

async function main() {
  const week = await fetchWeek();

  const data = JSON.parse(await readFile(FILE, 'utf8'));
  const weeks = data.weeks || [];
  const prev = weeks.filter(w => w.start < week.start).pop();
  check(week, prev);

  const i = weeks.findIndex(w => w.start === week.start);
  if (i >= 0 && FUELS.every(([id]) => weeks[i][id] === week[id])) {
    console.log(`Sin cambios: la semana ${week.start} ya está guardada.`);
    return;
  }
  if (i >= 0) weeks[i] = week; else weeks.push(week);
  weeks.sort((a, b) => a.start.localeCompare(b.start));
  const out = '{\n  "weeks": [\n' + weeks.map(w =>
    `    { "start": "${w.start}", ` + FUELS.map(([id]) => `"${id}": ${w[id].toFixed(2)}`).join(', ') + ' }'
  ).join(',\n') + '\n  ]\n}\n';
  await writeFile(FILE, out);
  console.log('Semana guardada:', JSON.stringify(week));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
