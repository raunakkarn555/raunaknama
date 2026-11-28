// Roman <-> Devanagari <-> Urdu lyric script converter (runs fully in the browser, no server call).
// It is rule based, so it is a good reading aid rather than a perfect transliteration:
//  - Devanagari -> Roman / Urdu is the most accurate direction.
//  - Roman -> Devanagari / Urdu follows common Hinglish spelling (a common-word list + phonetic rules).
//  - Urdu -> Roman / Devanagari has to guess the short vowels (Urdu script does not write them).
// Lyrics that already are in the chosen script are never touched.

export const SCRIPT_MODES = [
  { id: "orig", label: "Original", short: "Orig" },
  { id: "roman", label: "Roman", short: "Abc" },
  { id: "dev", label: "\u0926\u0947\u0935\u0928\u093e\u0917\u0930\u0940", short: "\u0905" },
  { id: "urdu", label: "\u0627\u0631\u062f\u0648", short: "\u0627" },
];
export const SCRIPT_STORAGE_KEY = "raunaknama.lyricsScript.v1";

const RE_DEV = /[\u0900-\u097F]/;
const RE_URDU = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const RE_LATIN = /[A-Za-z]/;

export const detectWordScript = (w) => (RE_DEV.test(w) ? "dev" : RE_URDU.test(w) ? "urdu" : RE_LATIN.test(w) ? "roman" : "none");

// ---------------------------------------------------------------- Devanagari -> Roman
const D_CONS = {
  "\u0915": "k", "\u0916": "kh", "\u0917": "g", "\u0918": "gh", "\u0919": "n", "\u091a": "ch", "\u091b": "chh", "\u091c": "j", "\u091d": "jh", "\u091e": "n",
  "\u091f": "t", "\u0920": "th", "\u0921": "d", "\u0922": "dh", "\u0923": "n", "\u0924": "t", "\u0925": "th", "\u0926": "d", "\u0927": "dh", "\u0928": "n",
  "\u092a": "p", "\u092b": "ph", "\u092c": "b", "\u092d": "bh", "\u092e": "m", "\u092f": "y", "\u0930": "r", "\u0932": "l", "\u0933": "l", "\u0935": "v",
  "\u0936": "sh", "\u0937": "sh", "\u0938": "s", "\u0939": "h",
  "\u0958": "q", "\u0959": "kh", "\u095a": "gh", "\u095b": "z", "\u095c": "r", "\u095d": "rh", "\u095e": "f", "\u095f": "y",
};
const D_VOW = {
  "\u0905": "a", "\u0906": "aa", "\u0907": "i", "\u0908": "ee", "\u0909": "u", "\u090a": "oo", "\u090b": "ri", "\u090f": "e", "\u0910": "ai", "\u0913": "o", "\u0914": "au", "\u0911": "o", "\u090d": "e",
};
const D_MATRA = {
  "\u093e": "aa", "\u093f": "i", "\u0940": "ee", "\u0941": "u", "\u0942": "oo", "\u0943": "ri", "\u0947": "e", "\u0948": "ai", "\u094b": "o", "\u094c": "au", "\u0949": "o", "\u0945": "e",
};
const NUKTA = "\u093c", VIRAMA = "\u094d", ANUSVARA = "\u0902", CHANDRABINDU = "\u0901", VISARGA = "\u0903";
const NUKTA_MAP = { "\u0915": "\u0958", "\u0916": "\u0959", "\u0917": "\u095a", "\u091c": "\u095b", "\u0921": "\u095c", "\u0922": "\u095d", "\u092b": "\u095e" };

function devToRoman(word) {
  // 1) split into syllable-ish units
  const w = word.replace(/([\u0915\u0916\u0917\u091c\u0921\u0922\u092b])\u093c/g, (_, c) => NUKTA_MAP[c]).replace(/\u093c/g, "");
  const units = []; // { c: consonant roman | null, v: vowel roman | "" (inherent a) | null (no vowel: halant), raw }
  const chars = [...w];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (D_CONS[ch] !== undefined) {
      const u = { c: D_CONS[ch], v: "a", inherent: true };
      const nx = chars[i + 1];
      if (nx === VIRAMA) { u.v = ""; u.inherent = false; i++; }
      else if (D_MATRA[nx]) { u.v = D_MATRA[nx]; u.inherent = false; i++; }
      units.push(u);
    } else if (D_VOW[ch] !== undefined) {
      units.push({ c: "", v: D_VOW[ch], inherent: false });
    } else if (ch === ANUSVARA || ch === CHANDRABINDU) {
      units.push({ c: "", v: "", nasal: true, inherent: false });
    } else if (ch === VISARGA) {
      units.push({ c: "h", v: "", inherent: false });
    } else if (ch === "\u0964" || ch === "\u0965") {
      units.push({ lit: "." });
    } else if (/[\u0966-\u096F]/.test(ch)) {
      units.push({ lit: String(ch.charCodeAt(0) - 0x0966) });
    } else {
      units.push({ lit: ch });
    }
  }
  // 2) schwa deletion: end of word, and inside a word (right to left)
  const idx = units.map((u, i) => (u.c && u.inherent ? i : -1)).filter((i) => i >= 0);
  const lastReal = units.length - 1;
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    if (i === lastReal || (units[i + 1] && units[i + 1].nasal && i + 1 === lastReal && false)) { if (i === lastReal) units[i].v = ""; continue; }
    // middle: keep the first syllable's schwa, drop a schwa that sits between a vowel-bearing syllable and a following vowel-bearing syllable
    if (i === 0) continue;
    const next = units[i + 1];
    const prev = units[i - 1];
    const nextHasVowel = next && (next.v || next.nasal) && next.lit === undefined;
    const prevHasVowel = prev && prev.lit === undefined && (prev.v || prev.nasal);
    const isLastSyl = !units.slice(i + 1).some((u) => u.lit === undefined && u.v);
    if (prevHasVowel && nextHasVowel && !isLastSyl && units[i].v === "a" && units[i].inherent) units[i].v = "";
  }
  // 3) roman
  let out = "";
  units.forEach((u, i) => {
    if (u.lit !== undefined) { out += u.lit; return; }
    if (u.nasal) { out += "n"; return; }
    out += u.c + u.v;
  });
  return out
    .replace(/aaa+/g, "aa")
    .replace(/([^aeiou\s])aa$/, "$1a") // dekhaa -> dekha (a one-letter word like "aa" stays)
    .replace(/([^aeiou\s])ee$/, "$1i"); // khushee -> khushi
}

// ---------------------------------------------------------------- Roman -> Devanagari
const COMMON = {
  hai: "\u0939\u0948", hain: "\u0939\u0948\u0902", hoon: "\u0939\u0942\u0901", ho: "\u0939\u094b", tha: "\u0925\u093e", thi: "\u0925\u0940", the: "\u0925\u0947",
  main: "\u092e\u0948\u0902", mein: "\u092e\u0947\u0902", me: "\u092e\u0947\u0902", mai: "\u092e\u0948\u0902", tum: "\u0924\u0941\u092e", tu: "\u0924\u0942", tujhe: "\u0924\u0941\u091d\u0947", mujhe: "\u092e\u0941\u091d\u0947",
  mera: "\u092e\u0947\u0930\u093e", meri: "\u092e\u0947\u0930\u0940", mere: "\u092e\u0947\u0930\u0947", tera: "\u0924\u0947\u0930\u093e", teri: "\u0924\u0947\u0930\u0940", tere: "\u0924\u0947\u0930\u0947",
  tumhara: "\u0924\u0941\u092e\u094d\u0939\u093e\u0930\u093e", tumhare: "\u0924\u0941\u092e\u094d\u0939\u093e\u0930\u0947", hum: "\u0939\u092e", humko: "\u0939\u092e\u0915\u094b", tumko: "\u0924\u0941\u092e\u0915\u094b",
  ko: "\u0915\u094b", ka: "\u0915\u093e", ki: "\u0915\u0940", ke: "\u0915\u0947", se: "\u0938\u0947", par: "\u092a\u0930", pe: "\u092a\u0947", aur: "\u0914\u0930", ya: "\u092f\u093e", na: "\u0928\u093e", nahi: "\u0928\u0939\u0940\u0902", nahin: "\u0928\u0939\u0940\u0902",
  kya: "\u0915\u094d\u092f\u093e", kyun: "\u0915\u094d\u092f\u0942\u0901", kyu: "\u0915\u094d\u092f\u0942\u0901", kaise: "\u0915\u0948\u0938\u0947", kab: "\u0915\u092c", kahan: "\u0915\u0939\u093e\u0901", jo: "\u091c\u094b", ye: "\u092f\u0947", yeh: "\u092f\u0939", wo: "\u0935\u094b", woh: "\u0935\u094b", vo: "\u0935\u094b",
  dil: "\u0926\u093f\u0932", pyaar: "\u092a\u094d\u092f\u093e\u0930", pyar: "\u092a\u094d\u092f\u093e\u0930", ishq: "\u0907\u0936\u094d\u0915\u093c", mohabbat: "\u092e\u094b\u0939\u092c\u094d\u092c\u0924", zindagi: "\u091c\u093c\u093f\u0902\u0926\u0917\u0940", jaan: "\u091c\u093e\u0928",
  sanam: "\u0938\u0928\u092e", khuda: "\u0916\u0941\u0926\u093e", rab: "\u0930\u092c", duniya: "\u0926\u0941\u0928\u093f\u092f\u093e", raat: "\u0930\u093e\u0924", din: "\u0926\u093f\u0928", aankhein: "\u0906\u0901\u0916\u0947\u0902", aankhen: "\u0906\u0901\u0916\u0947\u0902",
  hoga: "\u0939\u094b\u0917\u093e", hogi: "\u0939\u094b\u0917\u0940", gaya: "\u0917\u092f\u093e", gayi: "\u0917\u092f\u0940", gaye: "\u0917\u092f\u0947", raha: "\u0930\u0939\u093e", rahi: "\u0930\u0939\u0940", rahe: "\u0930\u0939\u0947", kar: "\u0915\u0930", karo: "\u0915\u0930\u094b", kiya: "\u0915\u093f\u092f\u093e",
  bas: "\u092c\u0938", ab: "\u0905\u092c", tab: "\u0924\u092c", jab: "\u091c\u092c", phir: "\u092b\u093f\u0930", bhi: "\u092d\u0940", hi: "\u0939\u0940", to: "\u0924\u094b", toh: "\u0924\u094b", mat: "\u092e\u0924", sab: "\u0938\u092c", kuch: "\u0915\u0941\u091b",
  saath: "\u0938\u093e\u0925", sath: "\u0938\u093e\u0925", yaad: "\u092f\u093e\u0926", yaar: "\u092f\u093e\u0930", baat: "\u092c\u093e\u0924", dard: "\u0926\u0930\u094d\u0926", khushi: "\u0916\u093c\u0941\u0936\u0940", aaj: "\u0906\u091c", kal: "\u0915\u0932", o: "\u0913", oh: "\u0913", re: "\u0930\u0947", ae: "\u090f", hey: "\u0939\u0947",
};
const R_CONS = [
  ["chh", "\u091b"], ["ksh", "\u0915\u094d\u0937"], ["gya", "\u091c\u094d\u091e"], ["shr", "\u0936\u094d\u0930"], ["kh", "\u0916"], ["gh", "\u0918"], ["ch", "\u091a"], ["jh", "\u091d"], ["th", "\u0925"], ["dh", "\u0927"], ["ph", "\u092b"], ["bh", "\u092d"], ["sh", "\u0936"], ["zh", "\u091d"],
  ["k", "\u0915"], ["q", "\u0915\u093c"], ["g", "\u0917"], ["c", "\u0915"], ["j", "\u091c"], ["z", "\u091c\u093c"], ["t", "\u0924"], ["d", "\u0926"], ["n", "\u0928"], ["p", "\u092a"], ["f", "\u092b\u093c"], ["b", "\u092c"], ["m", "\u092e"],
  ["y", "\u092f"], ["r", "\u0930"], ["l", "\u0932"], ["v", "\u0935"], ["w", "\u0935"], ["s", "\u0938"], ["h", "\u0939"], ["x", "\u0915\u094d\u0938"],
];
const R_VOW = [
  ["aa", "\u0906", "\u093e"], ["ai", "\u0910", "\u0948"], ["au", "\u0914", "\u094c"], ["ee", "\u0908", "\u0940"], ["ii", "\u0908", "\u0940"], ["oo", "\u090a", "\u0942"], ["uu", "\u090a", "\u0942"], ["ei", "\u090f", "\u0947"], ["ou", "\u0914", "\u094c"],
  ["a", "\u0905", ""], ["i", "\u0907", "\u093f"], ["u", "\u0909", "\u0941"], ["e", "\u090f", "\u0947"], ["o", "\u0913", "\u094b"],
];
const matchAt = (list, s, i) => { for (const row of list) if (s.startsWith(row[0], i)) return row; return null; };

function romanWordToDev(word) {
  const lower = word.toLowerCase();
  if (COMMON[lower]) return COMMON[lower];
  let out = "";
  let i = 0;
  let prevCons = false; // previous emitted unit was a consonant carrying the inherent a
  while (i < lower.length) {
    const rest = lower;
    const v = matchAt(R_VOW, rest, i);
    const c = matchAt(R_CONS, rest, i);
    if (c && !(c[0] === "y" && false)) {
      // consonant. Doubled consonant => half + full (bb -> \u092c\u094d\u092c)
      const base = c[1];
      i += c[0].length;
      if (rest.startsWith(c[0], i) && c[0].length === 1 && c[0] !== "h") { out += base + VIRAMA; prevCons = true; continue; }
      const nv = matchAt(R_VOW, rest, i);
      const nc = matchAt(R_CONS, rest, i);
      if (nv) {
        i += nv[0].length;
        const atEnd = i >= rest.length;
        out += base + (nv[0] === "a" ? (atEnd && rest.length > 2 ? "\u093e" : "") : nv[2]); // word-final "a" (dekha, jaana, kya) is long
        prevCons = false;
        // "an"/"in" etc. at the end: nasal handled below
      } else if (nc && i < rest.length) {
        // consonant cluster: "pyaar" (p+y), "kya"; schwa stays in the middle of a longer word ("kamal"): only join when next is y/r/l/v or when the word has no vowel left
        const joiners = ["y", "r", "l", "v", "w"];
        const afterNc = rest.slice(i + nc[0].length);
        const vowelAhead = /[aeiou]/.test(afterNc) || matchAt(R_VOW, rest, i + nc[0].length);
        if (joiners.includes(nc[0]) && out.length >= 0 && /^[aeiou]/.test(afterNc)) out += base + VIRAMA;
        else if (!vowelAhead) out += base + VIRAMA;
        else out += base;
        prevCons = true;
      } else {
        out += base; // word-final consonant: no inherent a pronounced; plain letter is fine
        prevCons = true;
      }
    } else if (v) {
      i += v[0].length;
      out += v[1];
      prevCons = false;
    } else {
      out += lower[i]; i += 1; prevCons = false;
    }
  }
  // word-final nasal: ...ain / ein at end handled by plain n; fine for lyrics
  return out;
}

// ---------------------------------------------------------------- Devanagari -> Urdu
const DU_CONS = {
  "\u0915": "\u06a9", "\u0916": "\u06a9\u06be", "\u0917": "\u06af", "\u0918": "\u06af\u06be", "\u0919": "\u0646", "\u091a": "\u0686", "\u091b": "\u0686\u06be", "\u091c": "\u062c", "\u091d": "\u062c\u06be", "\u091e": "\u0646",
  "\u091f": "\u0679", "\u0920": "\u0679\u06be", "\u0921": "\u0688", "\u0922": "\u0688\u06be", "\u0923": "\u0646", "\u0924": "\u062a", "\u0925": "\u062a\u06be", "\u0926": "\u062f", "\u0927": "\u062f\u06be", "\u0928": "\u0646",
  "\u092a": "\u067e", "\u092b": "\u067e\u06be", "\u092c": "\u0628", "\u092d": "\u0628\u06be", "\u092e": "\u0645", "\u092f": "\u06cc", "\u0930": "\u0631", "\u0932": "\u0644", "\u0933": "\u0644", "\u0935": "\u0648",
  "\u0936": "\u0634", "\u0937": "\u0634", "\u0938": "\u0633", "\u0939": "\u06c1",
  "\u0958": "\u0642", "\u0959": "\u062e", "\u095a": "\u063a", "\u095b": "\u0632", "\u095c": "\u0691", "\u095d": "\u0691\u06be", "\u095e": "\u0641", "\u095f": "\u06cc",
};
const DU_VOW_INIT = {
  "\u0905": "\u0627", "\u0906": "\u0622", "\u0907": "\u0627\u0650", "\u0908": "\u0627\u06cc", "\u0909": "\u0627\u064f", "\u090a": "\u0627\u0648", "\u090f": "\u0627\u06cc", "\u0910": "\u0627\u06d2", "\u0913": "\u0627\u0648", "\u0914": "\u0627\u0648", "\u090b": "\u0631\u0650",
};
const DU_MATRA = { "\u093e": "\u0627", "\u093f": "", "\u0940": "\u06cc", "\u0941": "", "\u0942": "\u0648", "\u0947": "\u06cc", "\u0948": "\u06cc", "\u094b": "\u0648", "\u094c": "\u0648", "\u0943": "\u0631" };

const DU_COMMON = { "\u092f\u0947": "\u06cc\u06c1", "\u092f\u0939": "\u06cc\u06c1", "\u0935\u094b": "\u0648\u06c1", "\u0935\u0939": "\u0648\u06c1" };
function devToUrdu(word) {
  if (DU_COMMON[word]) return DU_COMMON[word];
  const w = word.replace(/([\u0915\u0916\u0917\u091c\u0921\u0922\u092b])\u093c/g, (_, c) => NUKTA_MAP[c]).replace(/\u093c/g, "");
  const chars = [...w];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (DU_CONS[ch] !== undefined) {
      out += DU_CONS[ch];
      const nx = chars[i + 1];
      if (nx === VIRAMA) { i++; }
      else if (DU_MATRA[nx] !== undefined) {
        let m = DU_MATRA[nx];
        const atEnd = i + 2 >= chars.length || /[\u0902\u0901]/.test(chars[i + 2]) && i + 3 >= chars.length;
        if (nx === "\u0947" && atEnd) m = "\u06d2";
        if (nx === "\u0948") m = atEnd ? "\u06d2" : "\u06cc";
        out += m; i++;
      }
    } else if (DU_VOW_INIT[ch] !== undefined) out += DU_VOW_INIT[ch];
    else if (ch === ANUSVARA || ch === CHANDRABINDU) out += "\u06ba";
    else if (ch === VISARGA) out += "\u06c1";
    else if (ch === "\u0964" || ch === "\u0965") out += "\u06d4";
    else if (/[\u0966-\u096F]/.test(ch)) out += String(ch.charCodeAt(0) - 0x0966);
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------- Urdu -> Roman
const U_ROMAN = {
  "\u0627": "a", "\u0622": "aa", "\u0628": "b", "\u067e": "p", "\u062a": "t", "\u0679": "t", "\u062b": "s", "\u062c": "j", "\u0686": "ch", "\u062d": "h", "\u062e": "kh", "\u062f": "d", "\u0688": "d",
  "\u0630": "z", "\u0631": "r", "\u0691": "r", "\u0632": "z", "\u0698": "zh", "\u0633": "s", "\u0634": "sh", "\u0635": "s", "\u0636": "z", "\u0637": "t", "\u0638": "z", "\u0639": "", "\u063a": "gh",
  "\u0641": "f", "\u0642": "q", "\u06a9": "k", "\u0643": "k", "\u06af": "g", "\u0644": "l", "\u0645": "m", "\u0646": "n", "\u06ba": "n", "\u06c1": "h", "\u06be": "h", "\u0647": "h", "\u06c3": "t", "\u0621": "", "\u0624": "o", "\u0626": "",
};
const U_DIAC = { "\u064e": "a", "\u0650": "i", "\u064f": "u", "\u0651": "", "\u0652": "", "\u064b": "an", "\u064c": "un", "\u064d": "in", "\u0670": "a" };
const isUCons = (ch) => ch && U_ROMAN[ch] !== undefined && !"\u0627\u0622".includes(ch);

const UR_COMMON = {
  "\u06cc\u06c1": "ye", "\u0648\u06c1": "woh", "\u06c1\u06d2": "hai", "\u06c1\u06cc\u06ba": "hain", "\u0645\u06cc\u06ba": "main", "\u06a9\u0648": "ko", "\u06a9\u06cc": "ki", "\u06a9\u06d2": "ke", "\u06a9\u0627": "ka",
  "\u0633\u06d2": "se", "\u062a\u0648": "to", "\u0646\u06c1\u06cc\u06ba": "nahin", "\u0627\u0648\u0631": "aur", "\u062f\u0644": "dil", "\u067e\u06cc\u0627\u0631": "pyaar", "\u06c1\u0645": "hum", "\u062a\u0645": "tum",
  "\u0645\u06cc\u0631\u0627": "mera", "\u0645\u06cc\u0631\u06cc": "meri", "\u062a\u06cc\u0631\u0627": "tera", "\u062a\u06cc\u0631\u06cc": "teri", "\u06a9\u06cc\u0627": "kya", "\u0645\u062c\u06be\u06d2": "mujhe", "\u062a\u062c\u06be\u06d2": "tujhe", "\u062a\u0645\u06c1\u06cc\u06ba": "tumhein",
};
function urduToRoman(word) {
  if (UR_COMMON[word]) return UR_COMMON[word];
  const chars = [...word].filter((c) => c !== "\u200c" && c !== "\u200d");
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prev = chars[i - 1];
    const next = chars[i + 1];
    if (U_DIAC[ch] !== undefined) { out += U_DIAC[ch]; continue; }
    if (ch === "\u0627" || ch === "\u0622") {
      if (ch === "\u0622") out += "aa";
      else if (i === 0) out += U_DIAC[next] !== undefined || next === "\u0644" ? "a" : "a";
      else out += "aa";
      continue;
    }
    if (ch === "\u0648") { // waw
      if (i === 0) out += "w"; // wo / woh -> mostly "wo"
      else out += next && isUCons(next) ? "o" : "o";
      if (i === 0 && next !== "\u06c1" && next !== "\u06be") out += "";
      continue;
    }
    if (ch === "\u06cc" || ch === "\u064a" || ch === "\u0649") {
      if (i === 0) out += "y"; else if (!next) out += "i"; else out += "i";
      continue;
    }
    if (ch === "\u06d2" || ch === "\u06d3") { out += "e"; continue; }
    if (ch === "\u06c1" && next === undefined && prev && isUCons(prev)) { out += "a"; continue; } // final ہ after a consonant sounds like "a"
    if (U_ROMAN[ch] !== undefined) {
      out += U_ROMAN[ch];
      // missing short vowel between two consonants (not for aspirated "h" digraphs)
      const n2 = chars[i + 1];
      if (isUCons(ch) && n2 && isUCons(n2) && n2 !== "\u06be" && ch !== "\u06be" && i > 0) {
        const n3 = chars[i + 2];
        if (n3 && (n3 === "\u0627" || isUCons(n3) || n3 === "\u06cc" || n3 === "\u0648" || n3 === "\u06d2")) out += "a";
      } else if (isUCons(ch) && n2 && isUCons(n2) && i === 0 && n2 !== "\u06be") out += "a";
      continue;
    }
    out += ch;
  }
  return out.replace(/aaa+/g, "aa");
}

// ---------------------------------------------------------------- public API
const splitWords = (line) => line.split(/(\s+|[,.;:!?()"\u201c\u201d\u2018\u2019\-\u2014\u06d4\u060c\u0964\u0965]+)/);

function convertWord(word, target) {
  const s = detectWordScript(word);
  if (s === "none" || s === target) return word;
  let roman = null;
  if (s === "roman") roman = word;
  if (target === "roman") {
    if (s === "dev") return devToRoman(word);
    if (s === "urdu") return urduToRoman(word);
  }
  if (target === "dev") {
    if (s === "urdu") roman = urduToRoman(word);
    return romanWordToDev(roman || word);
  }
  if (target === "urdu") {
    if (s === "roman") return devToUrdu(romanWordToDev(word));
    if (s === "dev") return devToUrdu(word);
  }
  return word;
}

export function convertLine(line, target) {
  if (!line || !target || target === "orig") return line;
  return splitWords(String(line)).map((p) => (p && /\S/.test(p) && detectWordScript(p) !== "none" ? convertWord(p, target) : p)).join("");
}

/** Convert a whole lyrics payload ({ synced:[{time,text}], plain }) without mutating it. */
export function convertLyrics(data, target) {
  if (!data || !target || target === "orig") return data;
  const out = { ...data };
  if (Array.isArray(data.synced)) out.synced = data.synced.map((l) => ({ ...l, text: convertLine(l.text, target) }));
  if (typeof data.plain === "string") out.plain = data.plain.split(/\r?\n/).map((l) => convertLine(l, target)).join("\n");
  return out;
}

/**
 * Can the lyrics be shown in `target`?  "ok" | "same" | "unavailable"
 *  - "same": the lyrics are already (almost entirely) in that script, so choosing it changes nothing.
 *  - "unavailable": the lyrics are mostly in some other script (Punjabi, Tamil, Korean ...) that the
 *    Roman / Devanagari / Urdu converter cannot read, so the switch would do nothing.
 */
export function scriptAvailability(data, target) {
  if (!data || !target || target === "orig") return "ok";
  const text = Array.isArray(data.synced) && data.synced.length
    ? data.synced.map((l) => l?.text || "").join("\n")
    : typeof data.plain === "string" ? data.plain : "";
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (!words.length) return "unavailable";
  let same = 0; let conv = 0;
  for (const w of words) {
    const s = detectWordScript(w);
    if (s === target) same += 1; else if (s !== "none") conv += 1;
  }
  const n = words.length;
  if (conv / n < 0.2 && same / n < 0.5) return "unavailable"; // mostly some other script
  if (conv / n < 0.1) return "same";
  return "ok";
}
