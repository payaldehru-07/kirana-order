// Maps a cleaned item phrase ("washing powder 1000g") to one of the catalogue SKUs, with a confidence level and
// two alternatives. No LLM here: aliases first, then fuzzy word matching, nudged by what this retailer ordered before.
import { createSkuRepo } from '../skus.js';
import { analysePhrase, phraseKey, sizeToken } from './text.js';

function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for equal words; typo-tolerant for words of 4+ letters ("detergnt" ~ "detergent"); else 0. */
const sim = (a, b) => {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 4) return 0;
  const r = 1 - lev(a, b) / Math.max(a.length, b.length);
  return r >= 0.75 ? r * 0.9 : 0;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round2 = (n) => Math.round(n * 100) / 100;

const SIZE_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/g;

/** What we know about a SKU for matching: its product words, brand words and pack size. */
function describe(sku) {
  const base = sku.name.toLowerCase().split(',')[0]; // "Glucose biscuit 75 g, case of 96" -> "glucose biscuit 75 g"
  const m = new RegExp(SIZE_RE.source).exec(base);
  const token = m ? sizeToken(Number(m[1]), m[2]) : null;
  return {
    sku,
    nameTokens: base.replace(SIZE_RE, ' ').split(/[^a-z]+/).filter(Boolean),
    brandTokens: sku.brand.toLowerCase().split(/[^a-z]+/).filter(Boolean),
    size: token ? { token, value: parseInt(token, 10) } : null,
  };
}

function baseScore(a, d) {
  if (a.words.length === 0) return 0;
  // coverage: how much of what the shopkeeper SAID is explained by this SKU's name
  const cover = avg(a.words.map((w) => Math.max(0, ...d.nameTokens.map((n) => sim(w, n)), d.brandTokens.includes(w) ? 0.8 : 0)));
  // specificity: how much of the SKU's name was mentioned (so "biscuit" alone cannot be a perfect match for "cream biscuit")
  const spec = avg(d.nameTokens.map((n) => Math.max(0, ...a.words.map((w) => sim(w, n)))));
  const base = 0.6 * cover + 0.4 * spec;
  if (base === 0) return 0;
  let score = base;
  if (a.size && d.size) score += d.size.token === a.size ? 0.25 : -0.35;        // "1 kilo" vs 500 g
  else if (a.bare !== null && d.size) score += d.size.value === a.bare ? 0.2 : -0.25; // "250 wala"
  return Math.max(0, Math.min(1, score));
}

export function createMatcher(db) {
  const skuRepo = createSkuRepo(db);
  const aliasRows = db.prepare('SELECT phrase, sku_code FROM aliases WHERE retailer_id = ?');
  const history = db.prepare(
    "SELECT DISTINCT l.sku_code FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.retailer_id = ? AND o.status != 'rejected'",
  );

  return {
    /** Loads this retailer's SKUs, aliases and order history once; use .match(phrase) for each message line. */
    forRetailer(retailerId) {
      const skus = skuRepo.listForRetailer(retailerId);
      const described = skus.map(describe);
      const bought = new Set(history.all(retailerId).map((r) => r.sku_code));
      const aliases = new Map(aliasRows.all(retailerId).map((r) => [phraseKey(r.phrase), r.sku_code]));
      const byCode = new Map(skus.map((s) => [s.code, s]));

      return {
        skus: byCode,
        match(phrase) {
          const a = analysePhrase(phrase);

          const scored = described.map((d) => ({ d, score: baseScore(a, d) }));
          // "chhota" / "bada": among the near-best candidates nudge the smallest / biggest pack. Only a nudge, never certainty.
          const top = Math.max(0, ...scored.map((x) => x.score));
          if (a.hint && top > 0) {
            const group = scored.filter((x) => x.score >= top - 0.15 && x.d.size);
            if (group.length) {
              const pick = group.reduce((p, c) => ((a.hint === 'small' ? c.d.size.value < p.d.size.value : c.d.size.value > p.d.size.value) ? c : p));
              pick.score += 0.08;
            }
          }
          for (const x of scored) if (x.score > 0 && bought.has(x.d.sku.code)) x.score += 0.06; // they have ordered this before
          for (const x of scored) x.score = Math.min(1, x.score);
          scored.sort((p, q) =>
            q.score - p.score || Number(bought.has(q.d.sku.code)) - Number(bought.has(p.d.sku.code)) || p.d.sku.name.localeCompare(q.d.sku.name));

          const alt = (list) => list.slice(0, 2).map((x) => ({ sku: x.d.sku.code, name: x.d.sku.name, nameHi: x.d.sku.nameHi, score: round2(x.score) }));

          // 1) an alias for this retailer is as good as certain
          const aliased = byCode.get(aliases.get(phraseKey(phrase)));
          if (aliased) {
            return { chosen: aliased, score: 1, confidence: 'high', source: 'alias', alternatives: alt(scored.filter((x) => x.d.sku.code !== aliased.code)) };
          }
          // 2) fuzzy
          const [best, second] = scored;
          const margin = best.score - (second?.score ?? 0);
          if (best.score < 0.4) {
            return { chosen: null, score: round2(best.score), confidence: 'none', source: null, alternatives: alt(scored) };
          }
          let confidence = 'low';
          if (best.score >= 0.85 && margin >= 0.12) confidence = 'high';
          else if (best.score >= 0.6) confidence = 'medium';
          return { chosen: best.d.sku, score: round2(best.score), confidence, source: 'fuzzy', alternatives: alt(scored.slice(1)) };
        },
      };
    },
  };
}
