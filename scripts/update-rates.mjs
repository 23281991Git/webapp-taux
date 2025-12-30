import fs from "node:fs";

const RATES_PATH = "rates.json";

// Sources Service-Public (fiches “vosdroits”)
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
      // User-Agent crédible (réduit les refus “bêtes”)
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return await r.text();
}

// ---------- parsing ----------
function stripTags(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePctFromText(text) {
  // "1,7 %" / "1.7 %" / "1,75%" => 0.017
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) throw new Error("Percent not found");
  return Number(m[1].replace(",", ".")) / 100;
}

function assertReasonableRate(id, rate) {
  if (rate < 0 || rate > 0.2) throw new Error(`Rate out of bounds for ${id}: ${rate}`);
}

function upsertStep(product, dateISO, rate) {
  product.current_rate = rate;
  product.current_since = dateISO;

  const h = product.history ?? [];
  const last = h[h.length - 1];

  // anti-doublon
  if (!last || last.date !== dateISO) {
    if (last && Math.abs(last.rate - rate) < 1e-12) return;
    h.push({ date: dateISO, rate });
  } else {
    last.rate = rate;
  }
  product.history = h;
}

function extractRateFromServicePublicPage(html, idForError) {
  const text = stripTags(html).toLowerCase();

  // Stratégie :
  // 1) chercher un bloc autour de “taux d'intérêt” (le libellé existe sur les fiches)
  // 2) prendre la 1ère occurrence de % dans une fenêtre courte (évite de choper un autre % plus loin)
  const keyIdx = text.indexOf("taux d'intérêt");
  if (keyIdx === -1) {
    // fallback : parfois “taux d'intérêt du ... est de”
    const keyIdx2 = text.indexOf("taux d'intérêt du");
    if (keyIdx2 === -1) throw new Error(`${idForError}: keyword "taux d'intérêt" not found`);
    const window2 = text.slice(keyIdx2, keyIdx2 + 800);
    return parsePctFromText(window2);
  }

  const window = text.slice(keyIdx, keyIdx + 800);
  return parsePctFromText(window);
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(RATES_PATH, "utf-8"));
  const p = doc.products;

  const todayISO = new Date().toISOString().slice(0, 10);

  // 1) Fetch + parse chaque produit sur sa fiche dédiée (stable, pas de 403 type economie.gouv)
  const pages = await Promise.all(
    Object.entries(URLS).map(async ([id, url]) => {
      const html = await fetchText(url);
      const rate = extractRateFromServicePublicPage(html, id);
      assertReasonableRate(id, rate);
      return [id, rate];
    })
  );

  const rates = Object.fromEntries(pages);

  // 2) Appliquer uniquement si changement
  if (p.livret_a.current_rate !== rates.livret_a) upsertStep(p.livret_a, todayISO, rates.livret_a)
