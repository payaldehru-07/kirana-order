import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { createRetailerScope } from '../scope.js';
import { idQuery } from '../validate.js';
import { createSkuRepo, stockStatus, describeScheme, gstLabel, casePriceInclGstPaise } from '../skus.js';

export function createCatalogueRouter({ db, config }) {
  const router = Router();
  const repo = createSkuRepo(db);
  const scope = createRetailerScope(db);

  // GET /api/catalogue            (retailer: own prices)
  // GET /api/catalogue?retailerId=2 (desk: prices as that retailer sees them)
  router.get('/catalogue', authenticate({ db, config }), requireRole('retailer', 'desk'), (req, res) => {
    const retailerId = scope(req, idQuery(req.query.retailerId, 'retailerId'));
    const isDesk = req.user.role === 'desk';

    const items = repo.listForRetailer(retailerId).map((s) => {
      const item = {
        code: s.code,
        name: s.name,
        nameHi: s.nameHi,
        brand: s.brand,
        image: s.image,
        piecesPerCase: s.piecesPerCase,
        casePricePaise: s.casePricePaise,
        pricePerPiecePaise: s.pricePerPiecePaise,
        priceIncludesGst: false, // A2: always false, said explicitly so the UI never has to guess
        gstRate: s.gstRate,
        gstLabel: gstLabel(s.gstRate),
        casePriceInclGstPaise: casePriceInclGstPaise(s.casePricePaise, s.gstRate),
        stockStatus: stockStatus(s.stockCases),
        scheme: s.scheme,
        schemeText: describeScheme(s.scheme),
      };
      if (isDesk) item.stockCases = s.stockCases; // retailers see a status, only the desk sees exact stock
      return item;
    });

    // Stock changes, so the browser must re-check each time; the ETag makes that re-check a tiny 304 on slow 3G.
    // "private" keeps one retailer's prices out of any shared cache.
    res.set('Cache-Control', 'private, no-cache');
    res.json({ retailerId, items });
  });

  return router;
}
