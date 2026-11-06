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
  const m = text.match(/semana\s+del?\s+(\d{1,2})(?:\s+de\s+([a-záéíóú]+))?\s+al\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:del?\s+)?(\d{4})/i);
  if (!m) throw new Error('No encontré la frase "semana del … al …" en la página del MICM.');
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

async function main() {
  const res = await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; galon-precios/1.0)' } });
  if (!res.ok) throw new Error(`El MICM respondió ${res.status}`);
  const week = parse(await res.text());

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
