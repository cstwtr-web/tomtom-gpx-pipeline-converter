// task_07_geocoding_client.js
// Client di comunicazione asincrona con l'engine di Geocoding / Reverse-Geocoding Nominatim

import { sleep, addLog } from './task_03_utils.js';
import { buildGeocodingAttempts } from './task_06_transliteration.js';

const _COUNTRY_NAME_RE = [
  [/\bitalia|\bitaly\b/i,                          'it'],
  [/\bfrance|\bfrancia\b/i,                        'fr'],
  [/\bdeutschland|\bgermany|\bgermania\b/i,         'de'],
  [/\bsvizzera|\bschweiz|\bsuisse|\bswitzerland\b/i,'ch'],
  [/\baustria|\bösterreich\b/i,                    'at'],
  [/\bspagna|\bespaña|\bspain\b/i,                  'es'],
  [/\bslovenia|\bslovenija\b/i,                    'si'],
  [/\bcroazia|\bhrvatska|\bcroatia\b/i,             'hr'],
  [/\bregno unito|\bunited kingdom|\buk\b/i,         'gb'],
];

const _VIEWPORT_BBOX = [
  ['lu', 49.44, 50.19,  5.73,  6.53],
  ['li', 47.05, 47.27,  9.47,  9.64],
  ['mc', 43.72, 43.76,  7.40,  7.44],
  ['sm', 43.89, 43.99, 12.40, 12.52],
  ['si', 45.42, 46.88, 13.38, 16.61],
  ['hr', 42.39, 46.55, 13.49, 19.45],
  ['ch', 45.82, 47.81,  5.96, 10.49],
  ['at', 46.37, 49.02,  9.53, 17.16],
  ['be', 49.50, 51.51,  2.54,  6.41],
  ['nl', 50.75, 53.55,  3.36,  7.23],
  ['de', 47.27, 55.06,  5.87, 15.04],
  ['it', 35.49, 47.09,  6.63, 18.52],
  ['fr', 41.34, 51.09, -5.14,  9.56],
  ['es', 35.95, 43.79, -9.30,  4.33],
  ['pt', 36.96, 42.15, -9.50, -6.19],
  ['gb', 49.96, 60.85, -8.62,  1.77],
  ['pl', 49.00, 54.84, 14.12, 24.15],
  ['cz', 48.55, 51.06, 12.09, 18.86],
  ['sk', 47.73, 49.61, 16.84, 22.56],
  ['hu', 45.74, 48.58, 16.11, 22.90],
];

const _PLUS_CODE_RE = /\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;

function _detectCountryCode(q) {
  for (const [re, cc] of _COUNTRY_NAME_RE) if (re.test(q)) return cc;
  if (
    /\b\d{5}\b/.test(q) &&
    /\b(MI|TO|RM|NA|FI|BO|VE|PD|BS|VR|UD|TN|BZ)\b/i.test(q)
  ) return 'it';
  return null;
}

export function _extractViewport(url) {
  const m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+)z/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), zoom: parseInt(m[3]) };
}

function _ccFromViewport(lat, lon) {
  for (const [cc, latMin, latMax, lonMin, lonMax] of _VIEWPORT_BBOX) {
    if (lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax) return cc;
  }
  return null;
}

async function _geocodePlusCode(plusCode, contextHint) {
  const queries = [plusCode, contextHint ? `${plusCode} ${contextHint}` : null].filter(Boolean);
  for (const q of queries) {
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=it,en`,
        { headers: { 'User-Agent': 'TomTomRouteConverter/10.0' } }
      );
      if (r.ok) {
        const data = await r.json();
        if (data?.length > 0) {
          const name = data[0].display_name.split(',')[0].trim();
          addLog(` Plus Code "${plusCode}" → ${name}`, 'ok');
          return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), name };
        }
      }
    } catch (e) { /* Fallback loop */ }
  }
  return null;
}

/**
 * Esegue il Geocoding Forward di un indirizzo testuale applicando bias geografico basato sul viewport della mappa
 */
export async function geocode(q, { viewportBias = null } = {}) {
  q = q.normalize('NFC');

  const plusMatch = q.match(_PLUS_CODE_RE);
  if (plusMatch) {
    addLog(` Rilevato Plus Code: "${plusMatch[1]}"`, 'dim');
    const contextHint = q
      .replace(plusMatch[0], '')
      .replace(/,\s*,/g, ',')
      .replace(/^\s*,|,\s*$/g, '')
      .trim();
    const result = await _geocodePlusCode(plusMatch[1], contextHint || null);
    if (result) return result;
    addLog(` Plus Code non risolto via Nominatim, fallback su query testuale`, 'warn');
  }

  const countryCc = _detectCountryCode(q);
  if (countryCc) addLog(` Bias paese rilevato: ${countryCc.toUpperCase()}`, 'dim');

  let effectiveCc = countryCc;
  if (!effectiveCc && viewportBias) {
    effectiveCc = _ccFromViewport(viewportBias.lat, viewportBias.lon);
    if (effectiveCc)
      addLog(` Viewport (${viewportBias.lat.toFixed(2)},${viewportBias.lon.toFixed(2)}) → paese: ${effectiveCc.toUpperCase()}`, 'dim');
  }
  const finalCcParam = effectiveCc ? `&countrycodes=${effectiveCc}` : '';

  const attempts = buildGeocodingAttempts(q);
  for (let i = 0; i < attempts.length; i++) {
    const { attempt, langParam } = attempts[i];
    if (!attempt || attempt.length < 3) continue;
    try {
      addLog(` Tentativo ${i + 1}: "${attempt}"`, 'dim');
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(attempt)}&format=json&limit=1&${langParam}${finalCcParam}`,
        { headers: { 'User-Agent': 'TomTomRouteConverter/10.0' } }
      );
      if (r.ok) {
        const data = await r.json();
        if (data?.length > 0)
          return {
            lat:  parseFloat(data[0].lat),
            lon:  parseFloat(data[0].lon),
            name: data[0].display_name.split(',')[0].trim(),
          };
      }
    } catch (e) { /* Next attempt */ }
  }
  throw new Error(`Impossibile geocodificare: "${q}"`);
}

/**
 * Esegue il Reverse Geocoding di una coordinata geografica
 */
export async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&accept-language=it,en`,
      { headers: { 'User-Agent': 'TomTomRouteConverter/10.0' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const a    = data.address || {};
    return (
      a.village  || a.town   || a.city   || a.municipality ||
      a.road     || a.hamlet || a.suburb ||
      data.display_name?.split(',')[0]?.trim() ||
      null
    );
  } catch { return null; }
}

/**
 * Geocodifica in blocco una lista di waypoint iniettando i ritardi obbligatori di rispetto delle policy Nominatim (1s)
 */
export async function nameWaypoints(
  wps,
  {
    addLog:      log = addLog,
    setProgress: sp  = null,
    progressFrom = 50,
    progressTo   = 70,
  } = {}
) {
  const named         = wps.map(p => ({ ...p }));
  const intermediates = named.length - 2;
  for (let i = 0; i < named.length; i++) {
    if (i === 0)               { named[i].name = 'Partenza';     continue; }
    if (i === named.length - 1){ named[i].name = 'Destinazione'; continue; }
    const n = await reverseGeocode(named[i].lat, named[i].lon);
    named[i].name = n || `Via ${i}`;
    log?.(`  Via ${i}: ${named[i].name}`, 'dim');
    if (i < named.length - 2) await sleep(1100);
    if (sp && intermediates > 0) {
      sp(progressFrom + Math.round((progressTo - progressFrom) * i / intermediates));
    }
  }
  return named;
}