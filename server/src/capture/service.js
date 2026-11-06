import { createSkuRepo, stockStatus } from '../skus.js';
import { createCreditRepo, creditPreview } from '../credit.js';
import { quoteCart } from '../cart.js';
import { createMatcher } from './matcher.js';
import { parseMessage } from './text.js';

/**
 * Turns a message into a DRAFT order for a person to review. Nothing is saved: no order, no stock change.
 * A person confirms with POST /api/capture/confirm, which goes through the normal order placement.
 */
export function createCaptureService(db, extractor) {
  const matcher = createMatcher(db);
  const skuRepo = createSkuRepo(db);
  const creditRepo = createCreditRepo(db);

  /** LLM if configured and healthy; otherwise (no key, error, bad output) the local parser. Never fails the request. */
  async function extract(text) {
    if (!extractor) return { lines: parseMessage(text), extractedBy: 'local', fallbackReason: 'no_api_key' };
    try {
      const lines = await extractor(text);
      if (lines.length) return { lines, extractedBy: 'llm', fallbackReason: null };
      return { lines: parseMessage(text), extractedBy: 'local', fallbackReason: 'llm_returned_nothing' };
    } catch (err) {
      console.warn('[capture] LLM extraction failed, using local parser:', err.message);
      return { lines: parseMessage(text), extractedBy: 'local', fallbackReason: 'llm_failed' };
    }
  }

  const unitQuestion = (qty, sku, kind) => (kind === 'piece_not_whole'
    ? {
      en: `${qty} pieces is not a whole number of cases (1 case = ${sku.piecesPerCase} pieces). How many cases?`,
      hi: `${qty} पीस पूरे केस नहीं बनते (1 केस = ${sku.piecesPerCase} पीस)। कितने केस चाहिए?`,
      options: ['case'], piecesPerCase: sku.piecesPerCase,
    }
    : {
      en: `Is ${qty} cases (peti) or pieces? 1 case = ${sku.piecesPerCase} pieces.`,
      hi: `क्या ${qty} पेटी (केस) है या पीस? 1 केस = ${sku.piecesPerCase} पीस।`,
      options: ['case', 'piece'], piecesPerCase: sku.piecesPerCase,
    });

  return {
    async draft(retailerId, text) {
      const { lines: extracted, extractedBy, fallbackReason } = await extract(text);
      const m = matcher.forRetailer(retailerId);

      const lines = extracted.map((e, index) => {
        const r = m.match(e.item);
        const sku = r.chosen;
        let status;
        let qtyCases = null;
        let note = null;
        let question = null;
        if (!sku) status = 'unmatched';
        else if (e.qty === null || !Number.isInteger(e.qty) || e.qty < 1 || e.qty > 9999) status = 'needs_quantity';
        else if (e.unit === 'case') { status = 'ready'; qtyCases = e.qty; }
        else if (e.unit === 'piece') {
          if (e.qty % sku.piecesPerCase === 0 && e.qty / sku.piecesPerCase <= 9999) {
            status = 'ready'; qtyCases = e.qty / sku.piecesPerCase; note = 'converted_from_pieces';
          } else { status = 'needs_unit'; question = unitQuestion(e.qty, sku, 'piece_not_whole'); }
        } else { status = 'needs_unit'; question = unitQuestion(e.qty, sku, 'ask'); } // unit not written: ASK, never guess

        return {
          index,
          originalText: e.original,           // exactly what the shopkeeper wrote
          status,                              // ready | needs_unit | needs_quantity | unmatched
          sku: sku?.code ?? null,
          name: sku?.name ?? null,
          nameHi: sku?.nameHi ?? null,
          confidence: r.confidence,            // high | medium | low | none
          score: r.score,
          source: r.source,                    // alias | fuzzy | null
          quantityWritten: e.qty,
          unitWritten: e.unit,
          qtyCases,
          note,
          unitQuestion: question,
          alternatives: r.alternatives,        // two other SKUs the person can pick instead
          stock: sku ? { status: stockStatus(sku.stockCases), issue: null, availableCases: null } : null,
          duplicateOf: null,
        };
      });

      // Price the lines that are ready (one line per SKU: repeated SKUs are added together) and flag stock problems.
      const merged = [];
      for (const l of lines) {
        if (l.status !== 'ready') continue;
        const same = merged.find((x) => x.sku === l.sku);
        if (same) { same.qty = Math.min(9999, same.qty + l.qtyCases); l.duplicateOf = same.firstIndex; }
        else merged.push({ sku: l.sku, qty: l.qtyCases, firstIndex: l.index });
      }
      let quote = null;
      let credit = null;
      if (merged.length) {
        quote = quoteCart(skuRepo, retailerId, merged.map(({ sku, qty }) => ({ sku, qty })));
        for (const ql of quote.lines) {
          for (const l of lines) {
            if (l.sku === ql.skuCode && l.stock) {
              l.stock.issue = ql.stockIssue?.type ?? null;                 // out_of_stock | insufficient_stock
              l.stock.availableCases = ql.stockIssue?.availableCases ?? null;
            }
          }
        }
        credit = creditPreview(creditRepo.snapshot(retailerId), quote.totals.totalPaise);
      }

      return {
        retailerId,
        extractedBy,                           // 'llm' | 'local'
        fallbackReason,                        // why the local parser was used, or null
        warning: lines.length === 0 ? 'no_items_found' : null,
        lines,
        quote,
        credit,
        allReady: lines.length > 0 && lines.every((l) => l.status === 'ready'),
      };
    },
  };
}
