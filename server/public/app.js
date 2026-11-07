'use strict';
// Retailer ordering app + order desk. Plain JavaScript, no build step.
// Safety rule used everywhere: text from the server or the shopkeeper goes in with h() (textContent), never innerHTML.

// ---------- small helpers ----------
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const S = { token: ls.get('kt'), user: JSON.parse(ls.get('ku') || 'null'), lang: ls.get('kl') === 'hi' ? 'hi' : 'en', cat: null, me: null, flash: null };
const t = (k, v) => {
  let s = I18N[S.lang][k] ?? I18N.en[k] ?? k;
  if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]);
  return s;
};
const bi = (o) => (o ? (o[S.lang] ?? o.en) : '');                      // {en, hi} object -> current language
const nm = (o) => (S.lang === 'hi' && o.nameHi ? o.nameHi : o.name);   // product name in current language
const rs = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const $ = (id) => document.getElementById(id);

// h('div', {class:'x', onclick: fn}, child, child) builds a DOM node. Strings become text, so nothing can inject HTML.
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'value') value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  if (value !== undefined) e.value = value; // after children, so <select> already has its options
  return e;
}

// ---------- API ----------
class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new ApiError(0, 'network', t('err.network')); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && S.token) { logout(true); throw new ApiError(401, 'unauthenticated', t('err.unauthenticated')); }
    const key = 'err.' + e.code;
    const msg = I18N[S.lang][key] ? t(key) : (S.lang === 'en' && e.message) || I18N.en[key] || e.message || t('err.generic');
    throw new ApiError(res.status, e.code || 'error', msg, e.details);
  }
  return data;
}

// ---------- session ----------
function logout(expired) {
  S.token = null; S.user = null; S.me = null; S.cat = null; CAP = null; cartFor = null; cart = {};
  ls.del('kt'); ls.del('ku');
  location.hash = '#/login';
  if (expired) toast(t('err.unauthenticated'));
}
const home = () => (S.user?.role === 'desk' ? '#/desk' : '#/shop');
function nav(hash) { if (location.hash === hash) route(); else location.hash = hash; }

// ---------- cart (kept in the phone, one per user) ----------
let cart = {};     // sku -> cases
let cartFor = null; // whose cart is loaded
let cartRefVal = null;
const cartKey = () => 'cart' + S.user.id;
function loadCart() {
  try { cart = JSON.parse(ls.get(cartKey()) || '{}'); } catch { cart = {}; }
  cartRefVal = ls.get('ref' + S.user.id);
}
function saveCart() { ls.set(cartKey(), JSON.stringify(cart)); }
const newRef = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
// One idempotency key per cart: a double tap or retry sends the same key, so the server makes only one order.
function cartRef() { if (!cartRefVal) { cartRefVal = newRef(); ls.set('ref' + S.user.id, cartRefVal); } return cartRefVal; }
function resetRef() { cartRefVal = null; ls.del('ref' + S.user.id); }
function setQty(sku, n) { if (n > 0) cart[sku] = n; else delete cart[sku]; saveCart(); drawNav(); }
const cartCount = () => Object.keys(cart).length;

// ---------- generated product pictures (no image files to download) ----------
const picCache = {};
function pic(it) {
  if (it.image) return it.image;
  if (picCache[it.code]) return picCache[it.code];
  let hue = 0;
  for (const c of it.brand) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const letter = it.brand[0].toUpperCase().replace(/[&<>]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="14" fill="hsl(${hue},25%,95%)"/>`
    + `<path d="M28 30h40l4 10v36H24V40z" fill="hsl(${hue},35%,78%)"/><path d="M28 30h40l4 10H24z" fill="hsl(${hue},35%,66%)"/>`
    + `<text x="48" y="67" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="hsl(${hue},40%,30%)">${letter}</text></svg>`;
  return (picCache[it.code] = 'data:image/svg+xml,' + encodeURIComponent(svg));
}

// ---------- shared UI pieces ----------
const main = () => $('main');
let rid = 0; // each route() call gets a number; an older call that finishes late must not draw over a newer screen
function show(...nodes) { main().replaceChildren(...nodes.flat().filter((n) => n != null && n !== false)); } // skips `cond && node` that came out false
const loadingBox = () => h('p', { class: 'state', role: 'status' }, t('loading'));
const emptyBox = (msg, ...actions) => h('div', { class: 'state' }, h('p', null, msg), ...actions);
const errorBox = (e) => h('div', { class: 'state', role: 'alert' }, h('p', null, e.message), h('button', { class: 'btn', onclick: () => route() }, t('retry')));
const link = (text, href, cls = 'btn') => h('a', { class: cls, href }, text);
const chip = (text, cls = '') => h('span', { class: 'chip ' + cls }, text);
let toastTimer;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.className = 'show';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 4500);
}
function qtyBox(value, onSet) {
  const inp = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 9999, value: String(value), 'aria-label': t('cases') });
  const set = (n) => { n = Math.max(0, Math.min(9999, Math.floor(n) || 0)); inp.value = n; onSet(n); };
  inp.addEventListener('change', () => set(Number(inp.value)));
  return h('div', { class: 'qty' },
    h('button', { type: 'button', 'aria-label': '−', onclick: () => set(Number(inp.value) - 1) }, '−'), inp,
    h('button', { type: 'button', 'aria-label': '+', onclick: () => set(Number(inp.value) + 1) }, '+'));
}
const row = (label, value, cls = '') => h('div', { class: 'row ' + cls }, h('span', null, label), h('span', null, value));
function totalsBox(tt) {
  return h('div', { class: 'totals' },
    row(t('cart.gross'), rs(tt.grossPaise)),
    tt.discountPaise > 0 && row(t('cart.discount'), '−' + rs(tt.discountPaise)),
    row(t('cart.gst'), rs(tt.gstPaise)),
    row(t('cart.total'), rs(tt.totalPaise), 'grand'));
}
function creditBox(c) {
  return c.exceedsLimit
    ? h('p', { class: 'warn', role: 'alert' }, t('cart.over', { a: rs(c.overByPaise) }))
    : h('p', { class: 'muted' }, t('cart.creditOk', { a: rs(c.availablePaise) }));
}
// The server sends the scheme nudge as data: { type, casesToAdd, reward: "1 free case" | "3% off" }. We word it here in both
// languages; the number inside "reward" is the free-case count or the discount percent.
function nudgeText(n) {
  const x = parseInt(n.reward, 10);
  return n.type === 'free_goods' ? t('cart.nudgeFree', { n: n.casesToAdd, f: x }) : t('cart.nudgeSlab', { n: n.casesToAdd, p: x });
}
const stockLine = (si) => (si.type === 'out_of_stock' ? t('cart.oos') : t('cart.onlyLeft', { n: si.availableCases }));
async function load(live, fn) {
  try { return await fn(); } catch (e) { if (live()) show(errorBox(e)); return null; }
}

// ---------- shell: header and bottom nav ----------
function drawShell() {
  const hdr = $('hdr');
  document.documentElement.lang = S.lang;
  document.title = t('app');
  hdr.replaceChildren(
    h('strong', null, S.user?.role === 'desk' ? t('desk.title') : t('app')),
    h('span', { class: 'grow' }),
    h('button', { class: 'ghost', 'aria-label': 'Language', onclick: () => { S.lang = S.lang === 'en' ? 'hi' : 'en'; ls.set('kl', S.lang); route(); } }, S.lang === 'en' ? 'हिं' : 'EN'),
    S.token && h('button', { class: 'ghost', onclick: () => logout(false) }, t('logout')));
  drawNav();
}
function drawNav() {
  const nav = $('nav');
  if (!S.token) { nav.replaceChildren(); nav.hidden = true; return; }
  nav.hidden = false;
  const items = S.user.role === 'desk'
    ? [['#/desk', t('nav.desk')], ['#/tally', t('nav.tally')]]
    : [['#/shop', t('nav.shop')], ['#/cart', t('nav.cart') + (cartCount() ? ' (' + cartCount() + ')' : '')], ['#/orders', t('nav.orders')], ['#/message', t('nav.msg')]];
  const cur = location.hash.split('/')[1];
  nav.replaceChildren(...items.map(([href, label]) =>
    h('a', { href, class: href.split('/')[1] === cur || (cur === 'order' && href === '#/orders') ? 'on' : '' }, label)));
}

// ---------- router ----------
const ROUTES = [
  [/^#\/login$/, viewLogin, null], [/^#\/shop$/, viewShop, 'retailer'], [/^#\/cart$/, viewCart, 'retailer'],
  [/^#\/orders$/, viewOrders, 'retailer'], [/^#\/order\/(\d+)$/, viewOrder, 'retailer'], [/^#\/message$/, viewCapture, 'retailer'],
  [/^#\/desk$/, viewDesk, 'desk'], [/^#\/desk\/order\/(\d+)$/, viewDeskOrder, 'desk'], [/^#\/tally$/, viewTally, 'desk'],
];
function route() {
  const my = ++rid;
  const live = () => my === rid;
  if (!S.token) { if (location.hash !== '#/login') { location.hash = '#/login'; return; } }
  else if (!S.user) { logout(false); return; }
  else if (cartFor !== S.user.id) { loadCart(); cartFor = S.user.id; } // load this user's saved cart once
  const hit = ROUTES.map(([re, fn, role]) => [re.exec(location.hash), fn, role]).find(([m]) => m);
  if (!hit || (S.token && hit[2] !== null && hit[2] !== S.user.role) || (S.token && location.hash === '#/login')) { location.hash = S.token ? home() : '#/login'; return; }
  drawShell();
  window.scrollTo(0, 0);
  hit[1](live, ...hit[0].slice(1));
}

// ---------- 1. login ----------
function viewLogin() {
  let phone = '';
  const draw = (step, err) => {
    const ph = h('input', { id: 'phone', type: 'tel', inputmode: 'numeric', maxlength: 10, autocomplete: 'tel', value: phone, disabled: step === 'otp' });
    const otp = h('input', { id: 'otp', type: 'tel', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, step === 'phone' ? t('login.send') : t('login.go'));
    const form = h('form', { class: 'login', onsubmit: async (ev) => {
      ev.preventDefault(); btn.disabled = true;
      try {
        if (step === 'phone') { phone = ph.value.trim(); await api('/auth/request-otp', { method: 'POST', body: { phone } }); draw('otp'); return; }
        const r = await api('/auth/verify', { method: 'POST', body: { phone, otp: otp.value.trim() } });
        S.token = r.token; S.user = r.user; cartFor = null;
        ls.set('kt', r.token); ls.set('ku', JSON.stringify(r.user));
        nav(home());
      } catch (e) { draw(step, e.message); }
    } },
    h('h1', null, t('login.title')),
    h('label', { htmlFor: 'phone' }, t('login.phone')), ph,
    step === 'otp' && [h('p', { class: 'muted' }, t('login.sent', { p: phone })), h('label', { htmlFor: 'otp' }, t('login.otp')), otp],
    err && h('p', { class: 'warn', role: 'alert' }, err),
    btn,
    step === 'otp' && h('button', { type: 'button', class: 'ghost', onclick: () => draw('phone') }, t('login.change')),
    h('p', { class: 'muted small' }, t('login.demo')));
    show(form);
    (step === 'phone' ? ph : otp).focus();
  };
  draw('phone');
}

// ---------- 2. catalogue ----------
async function viewShop(live) {
  show(loadingBox());
  const res = await load(live, () => Promise.all([api('/catalogue'), api('/me')]));
  if (!res || !live()) return;
  const [cat, me] = res;
  S.cat = new Map(cat.items.map((i) => [i.code, i]));
  S.me = me.retailer;
  const items = [...cat.items].sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name)); // brand, then name
  if (!items.length) return show(emptyBox(t('shop.empty')));
  const out = [h('h1', null, S.me.shopName), h('p', { class: 'muted' }, t('shop.credit', { a: rs(S.me.availableCreditPaise) }))];
  let brand = null;
  for (const it of items) {
    if (it.brand !== brand) { brand = it.brand; out.push(h('h2', { class: 'brand' }, brand)); }
    out.push(productCard(it));
  }
  show(...out);
}
function productCard(it) {
  const oos = it.stockStatus === 'out_of_stock';
  const ctl = h('div', { class: 'ctl' });
  const paint = () => ctl.replaceChildren(cart[it.code]
    ? qtyBox(cart[it.code], (n) => { setQty(it.code, n); paint(); })
    : h('button', { class: 'btn primary', onclick: () => { setQty(it.code, 1); paint(); } }, t('add')));
  if (!oos) paint();
  return h('article', { class: 'card' + (oos ? ' oos' : '') },
    h('img', { class: 'pic', src: pic(it), alt: '', width: 88, height: 88, loading: 'lazy' }),
    h('div', { class: 'info' },
      h('h3', null, nm(it)),
      h('p', { class: 'price' }, rs(it.casePricePaise), ' ', h('span', { class: 'unit' }, t('shop.perCase'))),
      h('p', { class: 'gst' }, bi(it.gstLabel) + (it.gstRate > 0 ? ' · ' + t('shop.incl', { a: rs(it.casePriceInclGstPaise) }) : '')),
      it.schemeText && h('p', { class: 'scheme' }, bi(it.schemeText)),
      h('p', { class: 'stock s-' + it.stockStatus }, t('stock.' + it.stockStatus))),
    ctl);
}

// ---------- 3. cart ----------
let cartReq = 0;
async function priceCart() {
  for (let tries = 0; tries < 2; tries++) {
    const items = Object.entries(cart).map(([sku, qty]) => ({ sku, qty }));
    if (!items.length) return null;
    try { return await api('/cart/price', { method: 'POST', body: { items } }); } catch (e) {
      if (e.code !== 'unknown_sku' || !e.details) throw e;
      for (const d of e.details) delete cart[items[d.index].sku]; // a product that no longer exists: drop it, try again
      saveCart(); drawNav();
    }
  }
  return null;
}
async function viewCart(live) {
  if (!cartCount()) return show(emptyBox(t('cart.empty'), link(t('cart.browse'), '#/shop', 'btn primary')));
  show(loadingBox());
  await refreshCart(live);
}
async function refreshCart(live) {
  const my = ++cartReq;
  let q;
  try { q = await priceCart(); } catch (e) { if (live()) show(errorBox(e)); return; }
  if (!live() || my !== cartReq) return;
  if (!q) return show(emptyBox(t('cart.empty'), link(t('cart.browse'), '#/shop', 'btn primary')));
  const btn = h('button', { class: 'btn primary wide', disabled: !q.stockOk }, t('cart.place') + ' · ' + rs(q.totals.totalPaise));
  btn.addEventListener('click', () => placeOrder(btn, live));
  show(h('h1', null, t('cart.title')),
    ...q.lines.map((l) => h('article', { class: 'line' },
      h('div', { class: 'lhead' }, h('h3', null, nm(l)), h('strong', null, rs(l.totalPaise))),
      h('div', { class: 'lbody' },
        qtyBox(l.qty, (n) => { setQty(l.skuCode, n); refreshCart(live); }),
        h('div', { class: 'lmeta' },
          l.freeCases > 0 && h('p', { class: 'scheme' }, t('cart.free', { n: l.freeCases })),
          l.discountPaise > 0 && h('p', { class: 'scheme' }, t('cart.saved', { a: rs(l.discountPaise) })),
          h('p', { class: 'gst' }, rs(l.casePricePaise) + ' × ' + l.qty))),
      l.stockIssue && h('p', { class: 'warn', role: 'alert' }, stockLine(l.stockIssue)),
      !l.stockIssue && l.nudge && h('p', { class: 'nudge' }, nudgeText(l.nudge)))),
    totalsBox(q.totals), creditBox(q.credit),
    !q.stockOk && h('p', { class: 'warn' }, t('cart.fixStock')),
    btn);
}
async function placeOrder(btn, live) {
  btn.disabled = true; btn.textContent = t('cart.placing');
  try {
    const items = Object.entries(cart).map(([sku, qty]) => ({ sku, qty }));
    const r = await api('/orders', { method: 'POST', body: { items, clientRef: cartRef() } });
    cart = {}; saveCart(); resetRef(); S.flash = 'order.placed';
    nav('#/order/' + r.order.id);
  } catch (e) {
    toast(e.message);
    if (live()) refreshCart(live); // shows the new stock position, re-enables the button when possible
  }
}

// ---------- 4. orders: history, one order, repeat ----------
async function viewOrders(live) {
  show(loadingBox());
  const r = await load(live, () => api('/orders?limit=30'));
  if (!r || !live()) return;
  if (!r.orders.length) return show(emptyBox(t('order.none'), link(t('cart.browse'), '#/shop', 'btn primary')));
  show(h('h1', null, t('order.history')), ...r.orders.map((o) => h('article', { class: 'order' },
    h('a', { href: '#/order/' + o.id, class: 'ohead' },
      h('div', null, h('strong', null, '#' + o.id), ' ', h('span', { class: 'muted' }, when(o.createdAt))),
      h('div', null, h('strong', null, rs(o.totalPaise)), ' ', chip(t('status.' + o.status), 's-' + o.status), o.source === 'ai_text' && chip(t('order.ai')))),
    h('button', { class: 'btn', onclick: () => repeatOrder(o.id) }, t('order.again')))));
}
async function viewOrder(live, id) {
  show(loadingBox());
  const r = await load(live, () => api('/orders/' + id));
  if (!r || !live()) return;
  const o = r.order;
  const flash = S.flash; S.flash = null;
  show(
    flash && h('p', { class: 'flash', role: 'status' }, t(flash)),
    h('h1', null, t('order.title', { id: o.id })),
    h('p', { class: 'muted' }, when(o.createdAt), ' ', chip(t('status.' + o.status), 's-' + o.status), o.source === 'ai_text' && chip(t('order.ai'))),
    h('p', null, t('order.msg.' + o.status)),
    o.status === 'rejected' && o.deskNote && h('p', { class: 'warn' }, t('order.note', { r: o.deskNote })),
    h('h2', null, t('order.items')),
    ...o.lines.map((l) => h('div', { class: 'row' },
      h('span', null, nm(l) + ' × ' + l.qty + (l.freeCases ? ' (' + t('cart.free', { n: l.freeCases }) + ')' : '')), h('span', null, rs(l.totalPaise)))),
    totalsBox({ grossPaise: o.totals.netPaise + (o.lines.reduce((a, l) => a + l.discountPaise, 0)), discountPaise: o.lines.reduce((a, l) => a + l.discountPaise, 0), gstPaise: o.totals.gstPaise, totalPaise: o.totals.totalPaise }),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => repeatOrder(o.id) }, t('order.again')), link(t('back'), '#/orders')));
}
// "Order again": the server prices the same items at TODAY's prices, schemes and stock. We load those items into the cart; the
// cart screen then shows the live price, any stock problem and the credit check, and the retailer places it as normal.
async function repeatOrder(id) {
  try {
    if (cartCount() && !confirm(t('order.replace'))) return;
    const r = await api(`/orders/${id}/repeat`);
    cart = {};
    for (const it of r.items) cart[it.sku] = it.qty;
    saveCart(); resetRef(); nav('#/cart');
  } catch (e) { toast(e.message); }
}

// ---------- 5. AI capture from a text message ----------
let CAP = null; // survives a language switch; cleared on confirm or logout
const EXAMPLE = 'bhaiya 5 peti biscuit chhota, 2 peti washing powder 1 kilo, chai patti 250 wala 1 peti';
const skuInfo = (code) => S.cat?.get(code);
const ppc = (code) => skuInfo(code)?.piecesPerCase ?? 0;
function resolveLine(l) { // works out the cases for a line from what was written. A missing unit is ASKED, never guessed.
  l.ask = false; l.pieceErr = false;
  if (!l.sku || l.typed) return;
  if (!Number.isInteger(l.qw) || l.qw < 1 || l.qw > 9999) { l.qty = null; return; }
  if (l.unit === 'case') l.qty = l.qw;
  else if (l.unit === 'piece') {
    const p = ppc(l.sku);
    if (p && l.qw % p === 0) l.qty = l.qw / p; else { l.qty = null; l.ask = true; l.pieceErr = true; }
  } else { l.qty = null; l.ask = true; }
}
async function viewCapture(live) {
  if (!S.cat) {
    show(loadingBox());
    const cat = await load(live, () => api('/catalogue'));
    if (!cat || !live()) return;
    S.cat = new Map(cat.items.map((i) => [i.code, i]));
  }
  if (CAP?.lines) return paintCapture();
  const ta = h('textarea', { id: 'msg', rows: 5, maxlength: 2000, placeholder: t('cap.ph'), value: CAP?.text ?? '' });
  const btn = h('button', { class: 'btn primary wide' }, t('cap.read'));
  btn.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    CAP = { text }; btn.disabled = true; btn.textContent = t('cap.reading');
    try {
      const d = await api('/capture', { method: 'POST', body: { text } });
      CAP = { text, d, ref: newRef(), quote: null, lines: d.lines.map((x) => ({
        orig: x.originalText, include: true, sku: x.sku, sku0: x.sku, qw: x.quantityWritten, unit: x.unitWritten, qty: null, typed: false, chosen: false,
        conf: x.confidence, opts: [x.sku, ...x.alternatives.map((a) => a.sku)].filter(Boolean),
      })) };
      CAP.lines.forEach(resolveLine);
      if (live()) { paintCapture(); capReprice(); }
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = t('cap.read'); }
  });
  show(h('h1', null, t('cap.title')), h('p', { class: 'muted' }, t('cap.hint')), ta,
    h('button', { class: 'ghost', onclick: () => { ta.value = EXAMPLE; } }, t('cap.example')), btn);
}
function readyItems() { // one entry per product (the same product written twice is added together)
  const m = new Map();
  for (const l of CAP.lines) if (l.include && l.sku && l.qty >= 1) m.set(l.sku, Math.min(9999, (m.get(l.sku) || 0) + l.qty));
  return [...m].map(([sku, qty]) => ({ sku, qty }));
}
let capReq = 0;
async function capReprice() {
  const my = ++capReq;
  const items = readyItems();
  try { CAP.quote = items.length ? await api('/cart/price', { method: 'POST', body: { items } }) : null; } catch (e) { if (my === capReq) toast(e.message); }
  if (my === capReq && $('review')) paintCapture();
}
function stockIssueOf(l) {
  if (!l.include || !l.sku) return null;
  return CAP.quote?.lines.find((x) => x.skuCode === l.sku)?.stockIssue
    ?? (skuInfo(l.sku)?.stockStatus === 'out_of_stock' ? { type: 'out_of_stock', availableCases: 0 } : null);
}
const blocks = (l) => l.include && (!l.sku || !(l.qty >= 1) || !!stockIssueOf(l));
function changed(l) { resolveLine(l); paintCapture(); capReprice(); }
function paintCapture() {
  const d = CAP.d;
  const items = readyItems();
  const blocked = CAP.lines.some(blocks) || !items.length;
  const btn = h('button', { class: 'btn primary wide', disabled: blocked }, t('cap.confirm') + (CAP.quote ? ' · ' + rs(CAP.quote.totals.totalPaise) : ''));
  btn.addEventListener('click', () => confirmCapture(btn));
  show(h('div', { id: 'review' },
    h('h1', null, t('cap.title')),
    h('p', { class: 'muted small' }, d.extractedBy === 'llm' ? t('cap.ai') : t('cap.basic')),
    !CAP.lines.length && h('p', null, t('cap.none')),
    ...CAP.lines.map(captureLine),
    CAP.quote && [totalsBox(CAP.quote.totals), creditBox(CAP.quote.credit)],
    blocked && CAP.lines.length > 0 && h('p', { class: 'warn' }, t('cap.block')),
    btn,
    h('button', { class: 'ghost', onclick: () => { CAP = null; route(); } }, t('cancel'))));
}
function captureLine(l) {
  const issue = stockIssueOf(l);
  const info = l.sku ? skuInfo(l.sku) : null;
  const bad = blocks(l);
  const head = h('div', { class: 'lhead' },
    h('p', { class: 'quote' }, t('cap.wrote'), ': “', l.orig, '”'),
    h('button', { class: 'ghost', onclick: () => { l.include = !l.include; paintCapture(); capReprice(); } }, l.include ? t('cap.skip') : t('cap.undo')));
  if (!l.include) return h('article', { class: 'line off' }, head);

  const body = [];
  if (info) {
    body.push(h('div', { class: 'lhead' }, h('h3', null, nm(info)), l.chosen ? chip(t('cap.you'), 'c-high') : chip(t('conf.' + l.conf), 'c-' + l.conf)));
  } else {
    body.push(h('p', { class: 'warn' }, t('cap.pick')));
  }
  // other products this could be: the two alternatives from the server, plus the first guess if the person moved away from it
  const others = l.opts.filter((c) => c !== l.sku && skuInfo(c));
  if (others.length) body.push(h('div', { class: 'alts' }, t('cap.or'), ...others.map((c) =>
    h('button', { class: 'btn small', onclick: () => { l.sku = c; l.chosen = true; changed(l); } }, nm(skuInfo(c))))));
  if (!info) {
    body.push(h('select', { 'aria-label': t('cap.choose'), value: '', onchange: (ev) => { if (ev.target.value) { l.sku = ev.target.value; l.chosen = true; changed(l); } } },
      h('option', { value: '' }, t('cap.choose')), ...[...S.cat.values()].map((s) => h('option', { value: s.code }, nm(s)))));
  }
  if (info && l.ask) { // the unit is unclear: ask, never guess
    body.push(h('div', { class: 'ask' },
      h('p', null, l.pieceErr ? t('cap.pieceErr', { n: l.qw, p: ppc(l.sku) }) : t('cap.unit', { n: l.qw, p: ppc(l.sku) })),
      h('div', { class: 'alts' },
        h('button', { class: 'btn', onclick: () => { l.unit = 'case'; changed(l); } }, t('cap.unitCase')),
        !l.pieceErr && h('button', { class: 'btn', onclick: () => { l.unit = 'piece'; changed(l); } }, t('cap.unitPiece')))));
  } else if (info && !Number.isInteger(l.qw)) { // no quantity written at all
    body.push(h('p', null, t('cap.qtyAsk')));
  }
  if (info && !l.ask) {
    body.push(h('div', { class: 'lbody' }, qtyBox(l.qty ?? 0, (n) => { l.qty = n; l.typed = true; changed(l); }),
      l.unit === 'piece' && l.qty ? h('span', { class: 'muted small' }, t('cap.conv', { n: l.qw, c: l.qty })) : null));
  }
  if (issue) body.push(h('p', { class: 'warn', role: 'alert' }, stockLine(issue)));
  return h('article', { class: 'line' + (bad ? ' bad' : '') }, head, ...body);
}
async function confirmCapture(btn) {
  btn.disabled = true; btn.textContent = t('cart.placing');
  try {
    const items = CAP.lines.filter((l) => l.include && l.sku && l.qty >= 1).map((l) => ({ sku: l.sku, qty: l.qty, originalText: l.orig.slice(0, 200) }));
    const r = await api('/capture/confirm', { method: 'POST', body: { items, clientRef: CAP.ref } });
    CAP = null; S.flash = 'order.placed';
    nav('#/order/' + r.order.id);
  } catch (e) { toast(e.message); capReprice(); }
}

// ---------- 6. order desk ----------
const DESK_TABS = [['credit_hold', 'desk.holds'], ['placed', 'desk.new'], ['approved', 'desk.approved'], ['', 'desk.all']];
let deskTab = 'credit_hold';
async function viewDesk(live) {
  show(loadingBox());
  const r = await load(live, () => api('/desk/orders?limit=100' + (deskTab ? '&status=' + deskTab : '')));
  if (!r || !live()) return;
  show(h('h1', null, t('desk.title')),
    h('div', { class: 'tabs', role: 'tablist' }, ...DESK_TABS.map(([k, label]) =>
      h('button', { class: k === deskTab ? 'on' : '', role: 'tab', 'aria-selected': String(k === deskTab), onclick: () => { deskTab = k; route(); } }, t(label)))),
    !r.orders.length && emptyBox(t('desk.none')),
    ...r.orders.map((o) => h('a', { class: 'order block', href: '#/desk/order/' + o.id },
      h('div', { class: 'lhead' }, h('strong', null, o.shopName), h('strong', null, rs(o.totalPaise))),
      h('div', { class: 'muted' }, '#' + o.id + ' · ' + when(o.createdAt) + ' · ', chip(t('status.' + o.status), 's-' + o.status), o.source === 'ai_text' && chip(t('order.ai'))),
      o.holdReason && o.status === 'credit_hold' && h('p', { class: 'warn small' }, o.holdReason))));
}
async function viewDeskOrder(live, id, notice) {
  show(loadingBox());
  const r = await load(live, () => api('/desk/orders/' + id));
  if (!r || !live()) return;
  const { order: o, retailer: rt, credit: cr, creditCheck: cc } = r;
  let mode = 'view'; // 'view' | 'edit' | 'reject'
  let rows = [];
  let catalogue = null;
  const reload = (msg) => viewDeskOrder(live, id, msg);
  const act = async (fn, msg) => { try { await fn(); reload(msg); } catch (e) { toast(e.message); } };
  const open = o.status === 'placed' || o.status === 'credit_hold';

  const paint = () => {
    const parts = [
      link('← ' + t('back'), '#/desk', 'ghost'),
      h('h1', null, rt.shopName + ' · #' + o.id),
      h('p', { class: 'muted' }, [rt.ownerName, rt.area, rt.salesman].join(' · ')),
      h('p', { class: 'muted' }, when(o.createdAt) + ' ', chip(t('status.' + o.status), 's-' + o.status), o.source === 'ai_text' && chip(t('order.ai'))),
      notice && h('p', { class: 'flash', role: 'status' }, notice),
      h('div', { class: 'totals' },
        row(t('desk.limit'), rs(cr.limitPaise)), row(t('desk.outstanding'), rs(cr.outstandingPaise)), row(t('desk.pending'), rs(cr.pendingPaise))),
      open && (cc.exceedsLimit ? h('p', { class: 'warn' }, t('desk.over', { a: rs(cc.overByPaise) })) : h('p', { class: 'muted' }, t('desk.fits'))),
      o.holdReason && o.status === 'credit_hold' && h('p', { class: 'muted small' }, o.holdReason),
      o.status === 'rejected' && o.deskNote && h('p', { class: 'warn' }, t('order.note', { r: o.deskNote })),
      mode === 'edit' ? editBox() : linesBox(),
      mode === 'reject' && h('div', { class: 'ask' }, h('label', { htmlFor: 'why' }, t('desk.reason')), h('input', { id: 'why', maxlength: 200 }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn danger', onclick: () => act(() => api(`/desk/orders/${id}/reject`, { method: 'POST', body: { reason: $('why').value.trim() || null } })) }, t('desk.confirmReject')),
          h('button', { class: 'ghost', onclick: () => { mode = 'view'; paint(); } }, t('cancel')))),
      mode === 'view' && (open || o.status === 'approved') && h('div', { class: 'actions' },
        open && h('button', { class: 'btn primary', onclick: () => { if (cc.exceedsLimit && !confirm(t('desk.approveAnyway'))) return; act(() => api(`/desk/orders/${id}/approve`, { method: 'POST' })); } }, t('desk.approve')),
        open && h('button', { class: 'btn', onclick: startEdit }, t('desk.edit')),
        h('button', { class: 'btn danger', onclick: () => { mode = 'reject'; paint(); } }, t('desk.reject'))),
    ];
    show(...parts);
  };
  const linesBox = () => h('div', null, h('h2', null, t('order.items')),
    ...o.lines.map((l) => h('div', { class: 'dline' },
      h('div', { class: 'row' }, h('span', null, nm(l) + ' × ' + l.qty + (l.freeCases ? ' +' + l.freeCases : '')), h('span', null, rs(l.totalPaise))),
      l.originalText && h('p', { class: 'muted small' }, t('desk.orig', { t: l.originalText })))),
    totalsBox({ grossPaise: o.totals.netPaise + o.lines.reduce((a, l) => a + l.discountPaise, 0), discountPaise: o.lines.reduce((a, l) => a + l.discountPaise, 0), gstPaise: o.totals.gstPaise, totalPaise: o.totals.totalPaise }),
    o.originalTotalPaise != null && h('p', { class: 'muted small' }, t('desk.was', { a: rs(o.originalTotalPaise) })));
  const startEdit = async () => {
    try {
      if (!catalogue) catalogue = (await api('/catalogue?retailerId=' + rt.id)).items;
      rows = o.lines.map((l) => ({ sku: l.skuCode, qty: l.qty, orig: l.originalText }));
      mode = 'edit'; paint();
    } catch (e) { toast(e.message); }
  };
  const editBox = () => h('div', null, h('h2', null, t('desk.edit')),
    ...rows.map((rw, i) => h('div', { class: 'erow' },
      h('select', { value: rw.sku, 'aria-label': t('order.items'), onchange: (ev) => { rw.sku = ev.target.value; } },
        ...catalogue.map((s) => h('option', { value: s.code }, nm(s) + (s.stockStatus === 'out_of_stock' ? ' ✕' : '')))),
      h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 9999, value: String(rw.qty), 'aria-label': t('cases'), onchange: (ev) => { rw.qty = Number(ev.target.value); } }),
      h('button', { class: 'ghost', 'aria-label': t('remove'), onclick: () => { rows.splice(i, 1); paint(); } }, '✕'))),
    h('button', { class: 'btn', onclick: () => { rows.push({ sku: catalogue[0].code, qty: 1, orig: null }); paint(); } }, '+ ' + t('desk.add')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: saveEdit }, t('save')),
      h('button', { class: 'ghost', onclick: () => { mode = 'view'; paint(); } }, t('cancel'))));
  const saveEdit = async () => {
    try {
      const items = rows.map((rw) => ({ sku: rw.sku, qty: rw.qty, ...(rw.orig ? { originalText: rw.orig } : {}) }));
      const res = await api(`/desk/orders/${id}/lines`, { method: 'PUT', body: { items } });
      const learned = res.aliasesLearned.map((a) => t('desk.learned', { p: a.phrase, s: skuInfoName(catalogue, a.sku) })).join(' ');
      reload(t('desk.saved', { a: rs(res.previousTotalPaise), b: rs(res.newTotalPaise) }) + (learned ? ' ' + learned : ''));
    } catch (e) {
      const why = e.details?.map((d) => d.problem + (d.skuCode ? ` (${d.skuCode})` : '')).join('; ');
      toast(e.message + (why ? ': ' + why : ''));
    }
  };
  paint();
}
const skuInfoName = (cat, code) => { const s = cat.find((x) => x.code === code); return s ? nm(s) : code; };

// ---------- 7. Tally export ----------
async function viewTally(live) {
  show(loadingBox());
  const r = await load(live, () => api('/desk/exports'));
  if (!r || !live()) return;
  const dl = async (id, fmt) => { // a plain link cannot send the login token, so fetch the file and save it
    try {
      const res = await fetch(`/api/desk/exports/${id}/file?format=${fmt}`, { headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) throw new ApiError(res.status, 'error', t('err.generic'));
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: `tally-export-${id}.${fmt}` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message || t('err.network')); }
  };
  const btn = h('button', { class: 'btn primary wide' }, t('tally.create'));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { const x = await api('/desk/exports', { method: 'POST' }); toast(t('tally.created', { id: x.export.id })); route(); } catch (e) { toast(e.message); btn.disabled = false; }
  });
  show(h('h1', null, t('tally.title')), btn, !r.exports.length && emptyBox(t('tally.none')),
    ...r.exports.map((x) => h('article', { class: 'order' },
      h('div', null, h('strong', null, '#' + x.id), ' ', h('span', { class: 'muted' }, when(x.createdAt) + ' · ' + t('tally.orders', { n: x.orderCount }) + ' · ' + rs(x.totalPaise))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => dl(x.id, 'xml') }, 'XML'), h('button', { class: 'btn', onclick: () => dl(x.id, 'csv') }, 'CSV')))));
}

// ---------- start ----------
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
