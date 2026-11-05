// Seed data. Every SKU after the first three, all retailers, prices overrides and
// credit limits are INVENTED for the demo (see TDD assumptions A5-A6).
import { existsSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.js';

/** Fill an EMPTY database with demo data. Exported so tests can seed ':memory:'. */
export function seedDb(db) {

  const FG = (buy, free) => JSON.stringify({ type: 'free_goods', buy, free });
  const SLAB = (minCases, percent) => JSON.stringify({ type: 'slab_discount', minCases, percent });

  // code, name, name_hi, brand, pieces/case, price/piece, gst, stock, scheme
  const skus = [
    // from the client's sample sheet
    ['SKU-BS-075', 'Glucose biscuit 75 g, case of 96', 'ग्लूकोज़ बिस्किट 75 ग्राम', 'Sunrise', 96, 8.1, 18, 340, FG(10, 1)],
    ['SKU-DT-1KG', 'Detergent powder 1 kg, case of 20', 'डिटर्जेंट पाउडर 1 किलो', 'CleanWave', 20, 101.5, 18, 85, SLAB(5, 3)],
    ['SKU-TE-250', 'Tea leaf 250 g, case of 40', 'चाय पत्ती 250 ग्राम', 'Gold Leaf', 40, 118, 5, 0, null],
    // invented
    ['SKU-BS-150', 'Glucose biscuit 150 g, case of 48', 'ग्लूकोज़ बिस्किट 150 ग्राम', 'Sunrise', 48, 15.5, 18, 210, FG(10, 1)],
    ['SKU-BS-CR', 'Cream biscuit 100 g, case of 60', 'क्रीम बिस्किट 100 ग्राम', 'Sunrise', 60, 9.6, 18, 120, null],
    ['SKU-DT-500', 'Detergent powder 500 g, case of 40', 'डिटर्जेंट पाउडर 500 ग्राम', 'CleanWave', 40, 52.0, 18, 140, SLAB(5, 3)],
    ['SKU-DT-BAR', 'Detergent bar 250 g, case of 48', 'डिटर्जेंट बार 250 ग्राम', 'CleanWave', 48, 21.0, 18, 95, null],
    ['SKU-TE-100', 'Tea leaf 100 g, case of 100', 'चाय पत्ती 100 ग्राम', 'Gold Leaf', 100, 49.0, 5, 60, null],
    ['SKU-TE-500', 'Tea leaf 500 g, case of 20', 'चाय पत्ती 500 ग्राम', 'Gold Leaf', 20, 232.0, 5, 8, FG(5, 1)],
    ['SKU-SP-100', 'Bath soap 100 g, case of 72', 'नहाने का साबुन 100 ग्राम', 'FreshDay', 72, 26.0, 18, 180, SLAB(10, 2)],
    ['SKU-SP-DS', 'Dishwash bar 200 g, case of 48', 'बर्तन धोने का बार 200 ग्राम', 'FreshDay', 48, 14.5, 18, 0, null],
    ['SKU-DW-LQ', 'Dishwash liquid 500 ml, case of 24', 'बर्तन धोने का लिक्विड 500 मिली', 'FreshDay', 24, 88.0, 18, 40, SLAB(5, 3)],
    ['SKU-FL-CL', 'Floor cleaner 1 L, case of 12', 'फ़र्श क्लीनर 1 लीटर', 'FreshDay', 12, 112.0, 18, 55, null],
    ['SKU-NM-70', 'Instant noodles 70 g, case of 48', 'इंस्टेंट नूडल्स 70 ग्राम', 'Sunrise', 48, 11.2, 18, 300, FG(10, 1)],
    ['SKU-NM-MS', 'Masala noodles multipack, case of 24', 'मसाला नूडल्स मल्टीपैक', 'Sunrise', 24, 54.0, 18, 70, null],
    ['SKU-NK-200', 'Namkeen mix 200 g, case of 40', 'नमकीन मिक्स 200 ग्राम', 'Gold Leaf', 40, 36.0, 12, 90, null],
    ['SKU-SL-1KG', 'Iodised salt 1 kg, case of 25', 'आयोडीन नमक 1 किलो', 'Gold Leaf', 25, 21.0, 0, 400, null],
    ['SKU-SG-1KG', 'Sugar 1 kg, case of 20', 'चीनी 1 किलो', 'Gold Leaf', 20, 43.0, 0, 150, null],
    ['SKU-OL-1L', 'Refined oil 1 L pouch, case of 12', 'रिफाइंड तेल 1 लीटर', 'Gold Leaf', 12, 128.0, 5, 75, null],
    ['SKU-TP-150', 'Toothpaste 150 g, case of 48', 'टूथपेस्ट 150 ग्राम', 'FreshDay', 48, 74.0, 18, 110, SLAB(5, 2)],
  ];
  const insSku = db.prepare('INSERT INTO skus (code,name,name_hi,brand,pieces_per_case,price_per_piece,gst_rate,stock_cases,scheme_json) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const s of skus) insSku.run(...s);

  // retailers: shop, owner, area, salesman, credit limit (paise), outstanding (paise)
  const rupees = (n) => n * 100;
  const retailers = [
    ['Sharma Kirana Store', 'Mohan Sharma', 'Napier Town', 'Anil Yadav', rupees(60000), rupees(12000)],
    ['Gupta General Store', 'Sunita Gupta', 'Madan Mahal', 'Anil Yadav', rupees(40000), rupees(36500)], // near limit, triggers hold
    ['Jain Provision', 'Rakesh Jain', 'Gorakhpur', 'Deepak Soni', rupees(100000), rupees(20000)],
    ['New Bharat Mart', 'Imran Khan', 'Ranjhi', 'Deepak Soni', rupees(25000), 0],
  ];
  const insRet = db.prepare('INSERT INTO retailers (shop_name,owner_name,area,salesman,credit_limit_paise,outstanding_paise) VALUES (?,?,?,?,?,?)');
  retailers.forEach((r) => insRet.run(...r));

  // users: mock-OTP login. Phones are fake (555 range style) - no real personal data.
  const insUser = db.prepare('INSERT INTO users (phone,name,role,retailer_id) VALUES (?,?,?,?)');
  insUser.run('9000000001', 'Mohan Sharma', 'retailer', 1);
  insUser.run('9000000002', 'Sunita Gupta', 'retailer', 2);
  insUser.run('9000000003', 'Rakesh Jain', 'retailer', 3);
  insUser.run('9000000004', 'Imran Khan', 'retailer', 4);
  insUser.run('9000000099', 'Order Desk', 'desk', null);

  // retailer-specific prices (per piece), a few negotiated rates
  const insRP = db.prepare('INSERT INTO retailer_prices VALUES (?,?,?)');
  insRP.run(3, 'SKU-BS-075', 7.95);
  insRP.run(3, 'SKU-DT-1KG', 100.0);
  insRP.run(1, 'SKU-TE-250', 116.5);

  // learned alias example: Sharma's "chhota biscuit" means the 75 g pack
  db.prepare('INSERT INTO aliases VALUES (?,?,?)').run(1, 'biscuit chhota', 'SKU-BS-075');

  // past orders so "repeat order" and the AI matcher have history
  const insOrd = db.prepare("INSERT INTO orders (retailer_id,source,status,net_paise,gst_paise,total_paise,created_at) VALUES (?,?,?,?,?,?,datetime('now', ?))");
  const insLine = db.prepare('INSERT INTO order_lines (order_id,sku_code,qty_cases,free_cases,case_price_paise,discount_paise,net_paise,gst_paise) VALUES (?,?,?,?,?,?,?,?)');
  const skuByCode = Object.fromEntries(skus.map((s) => [s[0], s]));
  function pastOrder(retailerId, daysAgo, lines) {
    let net = 0, gst = 0;
    const rows = lines.map(([code, qty]) => {
      const s = skuByCode[code];
      const casePrice = Math.floor(s[5] * s[4] * 100 + 0.5);
      const n = casePrice * qty;
      const g = Math.floor((n * s[6]) / 100 + 0.5);
      net += n; gst += g;
      return [code, qty, 0, casePrice, 0, n, g];
    });
    const { lastInsertRowid } = insOrd.run(retailerId, 'app', 'exported', net, gst, net + gst, `-${daysAgo} days`);
    rows.forEach((r) => insLine.run(lastInsertRowid, ...r));
  }
  pastOrder(1, 3, [['SKU-BS-075', 4], ['SKU-DT-1KG', 2], ['SKU-TE-250', 1]]);
  pastOrder(1, 17, [['SKU-BS-075', 6], ['SKU-NM-70', 2]]);
  pastOrder(2, 9, [['SKU-SP-100', 3], ['SKU-DT-500', 2]]);
  pastOrder(3, 5, [['SKU-BS-075', 10], ['SKU-OL-1L', 2], ['SKU-SG-1KG', 3]]);
  pastOrder(4, 20, [['SKU-TE-100', 1], ['SKU-NK-200', 1]]); // no order in 14+ days

  const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  return { skus: n('skus'), retailers: n('retailers'), users: n('users'), orders: n('orders'), aliases: n('aliases') };
}

// CLI: `npm run seed` wipes the DB file and re-seeds it. Does nothing when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.DB_FILE || 'kirana.db';
  for (const f of [file, file + '-wal', file + '-shm']) if (existsSync(f)) unlinkSync(f);
  const c = seedDb(openDb(file));
  console.log(`Seeded: ${c.skus} SKUs, ${c.retailers} retailers, ${c.users} users, ${c.orders} orders, ${c.aliases} aliases -> ${file}`);
}
