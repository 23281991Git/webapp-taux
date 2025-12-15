import fs from "node:fs";

const RATES_PATH = "rates.json";

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": "tauxlivrets-bot/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return await r.text();
}

function parsePct(text) {
  // récupère "1,7 %" ou "1.7 %" => 0.017
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) throw new Error("Percent not found");
  return Number(m[1].replace(",", ".")) / 100;
}

function upsertStep(product, dateISO, rate) {
  product.current_rate = rate;
  product.current_since = dateISO;

  const h = product.history ?? [];
  const last = h[h.length - 1];
  if (!last || last.date !== dateISO) {
    // garde-fou anti “doublon”
    if (last && Math.abs(last.rate - rate) < 1e-12) return;
    h.push({ date: dateISO, rate });
  } else {
    last.rate = rate;
  }
  product.history = h;
}

function assertReasonableRate(id, rate) {
  // garde-fous : évite un 170% à cause d’un parsing foireux
  if (rate < 0 || rate > 0.2) throw new Error(`Rate out of bounds for ${id}: ${rate}`);
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(RATES_PATH, "utf-8"));

  // 1) Source “annonce officielle” (Service-Public actualités)
  // Exemple réel : la page “baisse des taux …” liste LDDS, CEL, etc. :contentReference[oaicite:3]{index=3}
  const sp = await fetchText("https://www.service-public.gouv.fr/particuliers/actualites/A18000");

  // ⚠️ parsing simple : tu peux raffiner au besoin (regex par produit)
  // LDDS
  const lddsBlock = sp.match(/LDDS\)\s*:\s*([0-9.,]+)\s*%/i);
  if (!lddsBlock) throw new Error("LDDS rate not found on Service-Public page");
  const lddsRate = Number(lddsBlock[1].replace(",", ".")) / 100;
  assertReasonableRate("ldds", lddsRate);

  // CEL
  const celBlock = sp.match(/CEL\)\s*:\s*([0-9.,]+)\s*%/i);
  if (!celBlock) throw new Error("CEL rate not found on Service-Public page");
  const celRate = Number(celBlock[1].replace(",", ".")) / 100;
  assertReasonableRate("cel", celRate);

  // Date d’effet : “1er août 2025” => on fixe ISO à la main ici (à améliorer si tu veux parser automatiquement)
  // Pour une V1 robuste : on ne change la date QUE si le taux change.
  const todayISO = new Date().toISOString().slice(0,10);

  // 2) Livret A / LEP / PEL : récup via economie.gouv (page “tout savoir…”)
  // Contient Livret A et rappels de taux. :contentReference[oaicite:4]{index=4}
  const eco = await fetchText("https://www.economie.gouv.fr/particuliers/gerer-mon-argent/gerer-mon-budget-et-mon-epargne/tout-savoir-sur-les-produits-depargne");

  // Livret A (on prend la 1ère occurrence “1,7 %” après “livret A”)
  const livretASection = eco.split(/livret\s*a/i)[1] ?? "";
  const livretARate = parsePct(livretASection);
  assertReasonableRate("livret_a", livretARate);

  // LEP (pareil)
  const lepSection = eco.split(/lep/i)[1] ?? "";
  const lepRate = parsePct(lepSection);
  assertReasonableRate("lep", lepRate);

  // PEL (ouverture aujourd’hui) : souvent indiqué en % “depuis le 1er janvier …”
  const pelSection = eco.split(/plan\s+epargne\s+logement|pel/i)[1] ?? "";
  const pelRate = parsePct(pelSection);
  assertReasonableRate("pel_new", pelRate);

  // 3) Appliquer les updates uniquement si changement
  const p = doc.products;

  if (p.ldds.current_rate !== lddsRate) upsertStep(p.ldds, todayISO, lddsRate);
  if (p.cel.current_rate !== celRate) upsertStep(p.cel, todayISO, celRate);
  if (p.livret_a.current_rate !== livretARate) upsertStep(p.livret_a, todayISO, livretARate);
  if (p.lep.current_rate !== lepRate) upsertStep(p.lep, todayISO, lepRate);
  if (p.pel_new.current_rate !== pelRate) upsertStep(p.pel_new, todayISO, pelRate);

  // (Option) LDDS = Livret A historiquement : tu peux garder ton historique miroir,
  // mais pour l’auto-update, je préfère les mettre indépendants.

  doc.updated_at = todayISO;
  fs.writeFileSync(RATES_PATH, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

main().catch(err => {
  console.error(err);
  process.exit(1); // important : fait échouer l’action => mail
});
