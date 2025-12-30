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

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
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

function stripTags(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePctFromText(text) {
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

  const idx1 = text.indexOf("taux d'intérêt");
  if (idx1 !== -1) {
    const window = text.slice(idx1, idx1 + 900);
    return parsePctFromText(window);
  }

  const idx2 = text.indexOf("taux d interet");
  if (idx2 !== -1) {
    const window = text.slice(idx2, idx2 + 900);
    return parsePctFromText(window);
  }

  throw new Error(`${idForError}: keyword "taux d'intérêt" not found`);
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(RATES_PATH, "utf-8"));
  const p = doc.products;

  const todayISO = new Date().toISOString().slice(0, 10);

  const entries = await Promise.all(
    Object.entries(URLS).map(async ([id, url]) => {
      const html = await fetchText(url);
      const rate = extractRateFromServicePublicPage(html, id);
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
  process.exit(1);
});
