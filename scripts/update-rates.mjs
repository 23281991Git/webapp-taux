import fs from "node:fs";

const RATES_PATH = "rates.json";

// Fiches Service-Public (une par produit)
const URLS = {
  livret_a: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2365",
  ldds: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2368",
  lep: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2367",
  cel: "https://www.service-public.gouv.fr/particuliers/vosdroits/F16136",
  pel_new: "https://www.service-public.gouv.fr/particuliers/vosdroits/F16140",
};

// ---------- HTTP ----------
async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return await r.text();
}

// ---------- parsing helpers ----------
function stripTags(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&apos;|&#39;|&#039;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function rateFromMatch(m) {
  if (!m || !m[1]) throw new Error("Percent not found");
  return Number(String(m[1]).replace(",", ".")) / 100;
}

function assertReasonableRate(id, rate) {
  if (rate < 0 || rate > 0.2) throw new Error(`Rate out of bounds for ${id}: ${rate}`);
}

function upsertStep(product, dateISO, rate) {
  product.current_rate = rate;
  product.current_since = dateISO;

  const h = product.history ?? [];
  const last = h[h.length - 1];

  if (!last || last.date !== dateISO) {
    if (last && Math.abs(last.rate - rate) < 1e-12) return; // pas de doublon si même taux
    h.push({ date: dateISO, rate });
  } else {
    last.rate = rate;
  }
  product.history = h;
}

// Regex ciblées (beaucoup plus robustes que “fenêtre après mot-clé”)
const PATTERNS = {
  livret_a: [
    /taux d['’]int[eé]r[eê]t annuel[^.]{0,120}?livret a[^.]{0,120}?est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /le taux d['’]int[eé]r[eê]t annuel du livret a est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
  ],
  ldds: [
    /taux d['’]int[eé]r[eê]t annuel[^.]{0,160}?(ldds|livret d['’]epargne populaire|livret de d[eé]veloppement durable et solidaire)[^.]{0,160}?est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /le taux d['’]int[eé]r[eê]t annuel du ldds est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /ldds[^.]{0,120}?taux[^.]{0,120}?([0-9]+(?:[.,][0-9]+)?)\s*%/i,
  ],
  lep: [
    /taux d['’]int[eé]r[eê]t annuel[^.]{0,160}?(lep|livret d['’]epargne populaire)[^.]{0,160}?est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /le taux d['’]int[eé]r[eê]t annuel du lep est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /lep[^.]{0,120}?taux[^.]{0,120}?([0-9]+(?:[.,][0-9]+)?)\s*%/i,
  ],
  cel: [
    /taux d['’]int[eé]r[eê]t annuel[^.]{0,160}?(cel|compte [eé]pargne logement)[^.]{0,160}?est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /le taux d['’]int[eé]r[eê]t annuel du cel est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /cel[^.]{0,120}?taux[^.]{0,120}?([0-9]+(?:[.,][0-9]+)?)\s*%/i,
  ],
  pel_new: [
    /taux d['’]int[eé]r[eê]t annuel[^.]{0,220}?(pel|plan [d'’]?[eé]pargne logement)[^.]{0,220}?est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /le taux d['’]int[eé]r[eê]t annuel du pel est (?:fix[eé]|de)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/i,
    /pel[^.]{0,120}?taux[^.]{0,120}?([0-9]+(?:[.,][0-9]+)?)\s*%/i,
  ],
};

function extractRateForId(id, html) {
  const text = stripTags(html);

  const patterns = PATTERNS[id];
  if (!patterns) throw new Error(`No patterns for id=${id}`);

  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      // certains patterns ont 2 groupes (ex: (lep|...) + (taux))
      const val = m[2] ?? m[1];
      return rateFromMatch([null, val]);
    }
  }

  // Fallback (moins précis) : prendre le 1er % après “taux d’intérêt” sur une grande fenêtre
  const lower = text.toLowerCase();
  const idx = lower.indexOf("taux d'intérêt");
  if (idx !== -1) {
    const window = text.slice(idx, idx + 2500);
    const m = window.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (m) return rateFromMatch(m);
  }

  throw new Error(`Percent not found for ${id}`);
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(RATES_PATH, "utf-8"));
  const p = doc.products;

  const todayISO = new Date().toISOString().slice(0, 10);

  const entries = await Promise.all(
    Object.entries(URLS).map(async ([id, url]) => {
      const html = await fetchText(url);
      const rate = extractRateForId(id, html);
      assertReasonableRate(id, rate);
      return [id, rate];
    })
  );

  const rates = Object.fromEntries(entries);

  if (p.livret_a.current_rate !== rates.livret_a) upsertStep(p.livret_a, todayISO, rates.livret_a);
  if (p.ldds.current_rate !== rates.ldds) upsertStep(p.ldds, todayISO, rates.ldds);
  if (p.lep.current_rate !== rates.lep) upsertStep(p.lep, todayISO, rates.lep);
  if (p.cel.current_rate !== rates.cel) upsertStep(p.cel, todayISO, rates.cel);
  if (p.pel_new.current_rate !== rates.pel_new) upsertStep(p.pel_new, todayISO, rates.pel_new);

  doc.updated_at = todayISO;
  fs.writeFileSync(RATES_PATH, JSON.stringify(doc, null, 2) + "\n", "utf-8");

  console.log("OK: rates fetched from Service-Public");
  console.log(
    "A:", rates.livret_a,
    "LDDS:", rates.ldds,
    "LEP:", rates.lep,
    "CEL:", rates.cel,
    "PEL:", rates.pel_new
  );
}

main().catch((err) => {
  console.error("UPDATE FAILED:");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1); // échec => mail GitHub
});
