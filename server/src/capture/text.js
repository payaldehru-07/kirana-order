// Understanding a shopkeeper's message WITHOUT an LLM: split it into lines, find quantity + unit, and clean the
// item words. This is the local fallback, and the same phrase cleaning is used for aliases and by the matcher.
// Handles English, Hinglish (Hindi in Latin letters) and Devanagari.

const DEVA_DIGITS = '०१२३४५६७८९';

/** Lowercase, digits to 0-9, strip punctuation, split "250g" into "250 g". Devanagari letters and vowel signs are kept. */
export function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFC')
    .replace(/\u093C/g, '')                                   // drop nukta so ज़ and ज match
    .replace(/[०-९]/g, (d) => String(DEVA_DIGITS.indexOf(d)))
    .replace(/[^\p{L}\p{N}\p{M}\s.]/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')                      // keep the dot only inside numbers like 1.5
    .replace(/(\d)(\p{L})/gu, '$1 $2')
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

const set = (...words) => new Set(words.flatMap((w) => w.split(' ')));

const CASE_UNITS = set('peti petti pettee case cases carton cartons cartoon box boxes पेटी केस कार्टन');
const PIECE_UNITS = set('piece pieces pc pcs packet packets pkt pkts nag पीस पैकेट नग');
const KG = set('kg kgs kilo kilos kilogram किलो किग्रा');
const GRAM = set('g gm gms gram grams gr ग्राम');
const LITRE = set('l ltr ltrs litre litres liter liters लीटर');
const ML = set('ml मिली');
const SIZE_UNITS = new Set([...KG, ...GRAM, ...LITRE, ...ML]);
const WALA = set('wala wali waala wale वाला वाली');
const KNOWN_SIZES = new Set([70, 75, 100, 150, 200, 250, 500]); // a bare "250" is a pack size, not a quantity

const NUMBER_WORDS = {
  ek: 1, एक: 1, one: 1, do: 2, दो: 2, two: 2, teen: 3, तीन: 3, three: 3, char: 4, chaar: 4, चार: 4, four: 4,
  paanch: 5, panch: 5, पाँच: 5, पांच: 5, five: 5, chhe: 6, chhah: 6, che: 6, छह: 6, छः: 6, six: 6,
  saat: 7, सात: 7, seven: 7, aath: 8, आठ: 8, eight: 8, nau: 9, नौ: 9, nine: 9, das: 10, dus: 10, दस: 10, ten: 10,
};

// Polite or filler words that are not part of an item name.
const FILLER = set(
  'bhaiya bhaiyaa bhai sir ji bhej bheje bhejo bhejna bhejiye chahiye chahie chaiye dena de dedo dijiye dijiyega ' +
  'mujhe hamein humein hume mera order kripya please pls plz hello hi namaste namaskar ok okay thanks thank you aaj kal jaldi urgent ' +
  'भैया भाई जी चाहिए चाहिये भेजना भेज दीजिए दीजिये दे कृपया नमस्ते',
);
const GIVE_VERBS = set('de bhej bheje bhejo kar dijiye दे भेज कर'); // "de do" = "please give", not the number 2
const STOP = set('wala wali waala wale ka ki ke ko se me mein the of a for वाला वाली का की के');

// Hinglish/Hindi word -> the English word used in our SKU names.
const SYN = {
  biskut: ['biscuit'], biscut: ['biscuit'], biskit: ['biscuit'], biscuits: ['biscuit'], gluco: ['glucose'],
  chai: ['tea'], chay: ['tea'], chaay: ['tea'], patti: ['leaf'], pati: ['leaf'], pattii: ['leaf'], chaipatti: ['tea', 'leaf'],
  washing: ['detergent'], wash: ['detergent'], surf: ['detergent'], sabun: ['soap'], namak: ['salt'],
  cheeni: ['sugar'], chini: ['sugar'], shakkar: ['sugar'], tel: ['oil'], paste: ['toothpaste'],
  maggi: ['noodles'], noodle: ['noodles'], bartan: ['dishwash'], farsh: ['floor'],
  chota: ['chhota'], chhote: ['chhota'], chhoti: ['chhota'], small: ['chhota'], छोटा: ['chhota'], छोटी: ['chhota'],
  bara: ['bada'], badi: ['bada'], big: ['bada'], large: ['bada'], बड़ा: ['bada'], बड़ी: ['bada'], बडा: ['bada'],
};

// Devanagari item words -> English SKU words.
const DEVA = {
  बिस्किट: 'biscuit', बिस्कुट: 'biscuit', ग्लूकोज: 'glucose', क्रीम: 'cream', डिटर्जेंट: 'detergent', पाउडर: 'powder',
  वाशिंग: 'detergent', सर्फ: 'detergent', बार: 'bar', चाय: 'tea', पत्ती: 'leaf', साबुन: 'soap', नहाने: 'bath',
  बर्तन: 'dishwash', लिक्विड: 'liquid', नमकीन: 'namkeen', मिक्स: 'mix', नमक: 'salt', चीनी: 'sugar', तेल: 'oil',
  रिफाइंड: 'refined', टूथपेस्ट: 'toothpaste', नूडल्स: 'noodles', मैगी: 'noodles', इंस्टेंट: 'instant', मसाला: 'masala',
  फर्श: 'floor', क्लीनर: 'cleaner',
};

const tokenize = (s) => normalize(s).split(' ').filter(Boolean).map((t) => DEVA[t] ?? t);
const isNum = (t) => /^\d+(\.\d+)?$/.test(t);
const numberValue = (t) => (isNum(t) ? Number(t) : NUMBER_WORDS[t] ?? null);

/** "1 kilo" -> "1000g", "250 g" -> "250g", "1 litre" -> "1000ml". One canonical form so sizes can be compared. */
export function sizeToken(n, unit) {
  if (KG.has(unit)) return `${Math.round(n * 1000)}g`;
  if (GRAM.has(unit)) return `${n}g`;
  if (LITRE.has(unit)) return `${Math.round(n * 1000)}ml`;
  return `${n}ml`;
}

/**
 * Breaks an item phrase into what the matcher needs:
 *   words  canonical product words  (washing powder -> detergent powder)
 *   size   explicit size like "1000g", or null
 *   bare   a bare pack number like 250 ("chai patti 250 wala"), or null
 *   hint   'small' for chhota, 'big' for bada, or null
 */
export function analysePhrase(phrase) {
  const toks = tokenize(phrase);
  const words = [];
  let size = null, bare = null, hint = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (STOP.has(t) || FILLER.has(t)) continue;
    if (/^\d+(\.\d+)?(g|ml)$/.test(t)) { size = t; continue; }
    if (isNum(t)) {
      if (SIZE_UNITS.has(toks[i + 1])) { size = sizeToken(Number(t), toks[i + 1]); i++; } else bare = Number(t);
      continue;
    }
    for (const w of SYN[t] ?? [t]) {
      if (w === 'chhota') hint = 'small';
      else if (w === 'bada') hint = 'big';
      else words.push(w);
    }
  }
  return { words: [...new Set(words)], size, bare, hint };
}

/** Order-independent identity of a phrase: "biscuit chhota" and "chhota biscuit" give the same key. Used for aliases. */
export function phraseKey(phrase) {
  const a = analysePhrase(phrase);
  return `${[...a.words].sort().join(' ')}|${a.size ?? a.bare ?? ''}|${a.hint ?? ''}`;
}

/** One message line -> { item, qty, unit }. item = cleaned words; qty = number written; unit = 'case' | 'piece' | null. */
function parseSegment(original) {
  const toks = tokenize(original);
  const item = [];
  let qty = null, unit = null, loneUnit = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (FILLER.has(t)) continue;
    if ((t === 'do' || t === 'दो') && GIVE_VERBS.has(toks[i - 1])) continue;
    const n = numberValue(t);
    if (n !== null) {
      const next = toks[i + 1];
      if ((CASE_UNITS.has(next) || PIECE_UNITS.has(next)) && qty === null) {
        qty = n; unit = CASE_UNITS.has(next) ? 'case' : 'piece'; i++; continue;
      }
      if (SIZE_UNITS.has(next)) { item.push(sizeToken(n, next)); i++; continue; }
      if (WALA.has(next)) { item.push(String(n)); i++; continue; }
      if (isNum(t) && KNOWN_SIZES.has(n)) { item.push(t); continue; }
      if (qty === null) { qty = n; continue; } // a bare number: quantity, unit NOT written
      item.push(t);
      continue;
    }
    if (CASE_UNITS.has(t)) { loneUnit ??= 'case'; continue; }
    if (PIECE_UNITS.has(t)) { loneUnit ??= 'piece'; continue; }
    item.push(t);
  }
  if (qty !== null && unit === null && loneUnit) unit = loneUnit;
  return { original, item: item.join(' '), qty, unit };
}

/** A whole message -> lines [{ original, item, qty, unit }]. `original` is exactly what the shopkeeper typed for that line. */
export function parseMessage(text) {
  return String(text)
    .split(/[,;\n।]+|\s+(?:aur|और|and|&)\s+|\s\+\s/i)
    .map((seg) => seg.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(parseSegment)
    .filter((l) => l.item !== '');
}

/** The item words of a piece of text, with quantity and unit removed. This is what an alias is stored as. */
export function itemPhrase(text) {
  return parseMessage(text).map((l) => l.item).join(' ').trim();
}
