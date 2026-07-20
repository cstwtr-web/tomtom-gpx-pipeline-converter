// task_05_transliteration.js
// Gestione avanzata degli script linguistici e tabelle di traslitterazione geografica per Nominatim

/**
 * Range Unicode per ogni script geografico rilevato.
 * Fonte: Unicode Standard 15.0, script blocks.
 */
const _SCRIPT_RANGES = [
  { script: 'cyrillic', re: /[\u0400-\u04FF\u0500-\u052F]/ },
  { script: 'greek',    re: /[\u0370-\u03FF\u1F00-\u1FFF]/ },
  { script: 'arabic',   re: /[\u0600-\u06FF\u0750-\u077F]/ },
  { script: 'hebrew',   re: /[\u0590-\u05FF]/ },
  { script: 'cjk',      re: /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/ },
  { script: 'devanagari', re: /[\u0900-\u097F]/ },
  { script: 'georgian', re: /[\u10A0-\u10FF]/ },
  { script: 'armenian', re: /[\u0530-\u058F]/ },
  { script: 'latin',    re: /[\u0000-\u024F]/ },
];

/** Mappa lo script dominante ai parametri accept-language ottimali di Nominatim */
const _SCRIPT_LANG_MAP = {
  cyrillic:   'sr,ru,bg,mk,uk,it,en',
  greek:      'el,it,en',
  arabic:     'ar,it,en',
  hebrew:     'he,it,en',
  cjk:        'zh,ja,ko,it,en',
  devanagari: 'hi,mr,it,en',
  georgian:   'ka,it,en',
  armenian:   'hy,it,en',
  latin:      'it,en',
  unknown:    'it,en',
};

/** Tabella cirillico -> latino (ISO 9 semplificato per toponimi stradali) */
const _CYR_TO_LAT = {
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh',
  'З':'Z','И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O',
  'П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts',
  'Ч':'Ch','Ш':'Sh','Щ':'Shch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu',
  'Я':'Ya',
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
  'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
  'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
  'ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu',
  'я':'ya',
  'Ђ':'Dj','Ј':'J','Љ':'Lj','Њ':'Nj','Ћ':'C','Џ':'Dz',
  'ђ':'dj','ј':'j','љ':'lj','њ':'nj','ћ':'c','џ':'dz',
  'Ъ':'A','ъ':'a','Ѓ':'G','ѓ':'g','Ќ':'K','ќ':'k',
};

/** Tabella greco -> latino per la cartografia mediterranea */
const _GRK_TO_LAT = {
  'Α':'A','Β':'V','Γ':'G','Δ':'D','Ε':'E','Ζ':'Z','Η':'I','Θ':'Th',
  'Ι':'I','Κ':'K','Λ':'L','Μ':'M','Ν':'N','Ξ':'X','Ο':'O','Π':'P',
  'Ρ':'R','Σ':'S','Т':'T','Υ':'Y','Φ':'F','Χ':'Ch','Ψ':'Ps','Ω':'O',
  'α':'a','β':'v','γ':'g','δ':'d','ε':'e','ζ':'z','η':'i','θ':'th',
  'ι':'i','κ':'k','λ':'l','μ':'m','ν':'n','ξ':'x','ο':'o','π':'p',
  'ρ':'r','σ':'s','ς':'s','τ':'t','υ':'y','φ':'f','χ':'ch','ψ':'ps','ω':'o',
  'ά':'a','έ':'e','ή':'i','ί':'i','ό':'o','ύ':'y','ώ':'o',
  'Ά':'A','Έ':'E','Ή':'I','Ί':'I','Ό':'O','Ύ':'Y','Ώ':'O',
};

export function _detectScript(text) {
  const counts = {};
  for (const ch of text) {
    for (const { script, re } of _SCRIPT_RANGES) {
      if (re.test(ch)) {
        counts[script] = (counts[script] || 0) + 1;
        break;
      }
    }
  }
  if (!Object.keys(counts).length) return 'latin';
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function _buildLangParam(script) {
  const langs = _SCRIPT_LANG_MAP[script] ?? 'it,en';
  return `accept-language=${langs}`;
}

function _applyTable(text, table) {
  return [...text].map(ch => table[ch] ?? ch).join('');
}

export function _transliterate(text, script) {
  if (script === 'cyrillic') return _applyTable(text, _CYR_TO_LAT);
  if (script === 'greek')    return _applyTable(text, _GRK_TO_LAT);
  return null;
}

/**
 * Genera la sequenza di tentativi di geocoding strutturati per superare i limiti di stringa di Nominatim
 * @param {string} q - Query normalizzata NFC
 */
export function buildGeocodingAttempts(q) {
  const script    = _detectScript(q);
  const langParam = _buildLangParam(script);

  const base = [
    { attempt: q.trim(),                                                           langParam },
    { attempt: q.trim().replace(/,\s*\d{5}.*$/, '').trim(),                       langParam },
    { attempt: q.trim().split(',')[0].replace(/\d+/g, '').trim(),                 langParam },
    { attempt: q.trim().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim(), langParam },
  ];

  const translit = _transliterate(q, script);
  if (translit && translit !== q) {
    const latinLang = 'accept-language=it,en';
    base.push({ attempt: translit.trim(),                                                 langParam: latinLang });
    base.push({ attempt: translit.trim().replace(/,\s*\d{5}.*$/, '').trim(),              langParam: latinLang });
  }

  return base.filter(({ attempt }) => attempt && attempt.length >= 3);
}