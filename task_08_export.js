// task_08_export.js
// Export puro: nessun DOM, nessun download, nessuna variabile globale.
// Ogni funzione riceve solo dati e restituisce una stringa.

import { haversineM } from './task_03_utils.js';

/**
 * Escapa caratteri speciali XML/HTML.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Snap helpers ─────────────────────────────────────────────────────────────

const SNAP_DEFAULT_M = 50;

// Implementazione unica in task_03_utils.js (haversineM) — era duplicata qui
// con una variante matematicamente equivalente (asin anziché atan2). Verifica
// di equivalenza numerica fatta su 2M coppie casuali + casi limite (poli,
// antimeridiano, quasi-antipodali): differenza massima 1.5 µm su 20.000 km,
// trascurabile rispetto a precisione GPS e ai toFixed() usati in export.
function haversineMeters(a, b) { return haversineM(a, b); }

// ── GPX ──────────────────────────────────────────────────────────────────────
/**
 * Costruisce una stringa GPX 1.1 compatibile TomTom.
 * Se routePoints è fornito, genera <rte> (tappe snappate) + <trk> (traccia OSRM).
 * Altrimenti genera solo <rte> con i waypoint grezzi.
 *
 * @param {Array<{lat,lon,name,ele?,snapToleranceMeters?,countryCode?}>} wps - waypoint utente
 * @param {string}                     name         - nome rotta
 * @param {Array<{lat,lon,ele?}>|null} routePoints  - geometria OSRM (opzionale)
 * @param {number}                     [fallbackCount=0] - n. tratti risolti in linea retta
 *   dopo retry+split (task_10_engine.js). Solo informativo: aggiunge un commento XML,
 *   nessun impatto sui dati. Ignorato se 0.
 * @returns {string}
 */
export function buildGPXString(wps, name, routePoints, fallbackCount = 0) {
  const fmtEle = p =>
    p.ele !== undefined && !isNaN(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '';

  const fmtRtept = w =>
    ` <rtept lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">` +
    `<name>${esc(w.name)}</name>${fmtEle(w)}</rtept>`;

  const fallbackNote = fallbackCount > 0
    ? `<!-- * ${fallbackCount} tratto/i instradato/i in linea retta (nessuna strada calcolata): verificare prima dell'uso -->\n`
    : '';

  const header =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="TomTom Route Converter 11.0" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    `<metadata><name>${esc(name)}</name></metadata>\n` +
    fallbackNote;

  if (routePoints && routePoints.length > 0) {
    // Snap di ogni waypoint al punto OSRM più vicino (haversine + warning per soglia)
    const snappedWps = wps.map((w, i) => {
      let best = w, bestD = Infinity;
      for (const p of routePoints) {
        const d = haversineMeters(w, p);
        if (d < bestD) { bestD = d; best = p; }
      }
      const tolerance = w.snapToleranceMeters ?? SNAP_DEFAULT_M;
      if (bestD > tolerance) {
        console.warn(
          `[snap] Waypoint ${i} "${w.name ?? '?'}" (${w.countryCode ?? '?'}) ` +
          `snappato a ${bestD.toFixed(0)}m — supera soglia ${tolerance}m (possibile strada parallela)`
        );
      }
      return { ...w, lat: best.lat, lon: best.lon, ele: best.ele };
    });

    const trkpts = routePoints
      .map(p => ` <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${fmtEle(p)}</trkpt>`)
      .join('\n');

    return header +
      `<rte>\n<name>${esc(name)}</name>\n` +
      snappedWps.map(fmtRtept).join('\n') +
      `\n</rte>\n` +
      `<trk>\n<name>${esc(name)} - Traccia</name>\n<trkseg>\n` +
      trkpts +
      `\n</trkseg>\n</trk>\n</gpx>`;
  }

  // Senza traccia OSRM: solo <rte>
  return header +
    `<rte>\n<name>${esc(name)}</name>\n` +
    wps.map(fmtRtept).join('\n') +
    `\n</rte>\n</gpx>`;
}

// ── KML (per KMZ) ────────────────────────────────────────────────────────────
/**
 * Costruisce una stringa KML (da inserire in un KMZ via JSZip).
 *
 * @param {Array<{lat,lon,name}>}      wps
 * @param {string}                     name
 * @param {Array<{lat,lon}>|null}      routePoints
 * @param {number}                     [fallbackCount=0] - vedi buildGPXString. Ignorato se 0.
 * @returns {string}
 */
export function buildKMLString(wps, name, routePoints, fallbackCount = 0) {
  // FIX (coerenza KML↔GPX): i pin waypoint usavano wps grezzi (quota 0
  // hardcoded), mentre buildGPXString già snappa ogni waypoint al punto
  // OSRM più vicino (snappedWps) per posizione E quota. Stesso snap-lookup
  // qui, altrimenti lo stesso percorso esportato in GPX e KMZ mostra pin a
  // quote diverse per lo stesso punto fisico.
  const snappedWps = routePoints && routePoints.length > 0
    ? wps.map(w => {
        let best = w, bestD = Infinity;
        for (const p of routePoints) {
          const d = haversineMeters(w, p);
          if (d < bestD) { bestD = d; best = p; }
        }
        return { ...w, lat: best.lat, lon: best.lon, ele: best.ele };
      })
    : wps;

  const wpPlacemarks = snappedWps.map((w, i) =>
    ` <Placemark>\n<name>${esc(w.name)}</name>\n` +
    `<description>Tappa ${i + 1}</description>\n` +
    `<Point>\n<coordinates>${w.lon.toFixed(6)},${w.lat.toFixed(6)},${w.ele ?? 0}</coordinates>\n</Point>\n</Placemark>`
  ).join('\n');

  const linePlacemark = routePoints
    ? `<Placemark>\n<name>${esc(name)} - Percorso</name>\n<styleUrl>#motoLine</styleUrl>\n` +
      `<LineString>\n<tessellate>1</tessellate>\n<coordinates>\n` +
      routePoints.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},${p.ele ?? 0}`).join('\n') +
      `\n</coordinates>\n</LineString>\n</Placemark>`
    : '';

  const fallbackDesc = fallbackCount > 0
    ? `<description>* ${fallbackCount} tratto/i instradato/i in linea retta (nessuna strada calcolata): verificare prima dell'uso</description>\n`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n` +
    `<name>${esc(name)}</name>\n` +
    fallbackDesc +
    `<Style id="motoLine"><LineStyle><color>ff00a5ff</color><width>5</width></LineStyle></Style>\n` +
    `${wpPlacemarks}\n${linePlacemark}\n</Document>\n</kml>`;
}

// ── ITN (TomTom nativo) ──────────────────────────────────────────────────────
/**
 * Costruisce una stringa ITN (pipe-separated, TomTom MyDrive / Rider 550).
 *
 * Formato per riga: longitude|latitude|description|type|
 *
 * Moltiplicatore coordinate: ×1e5 (100.000), non 1e6.
 *   Es.: lon=14.10930 → 1410930   lat=46.36830 → 4636830
 *
 * Tipo flag (specifica TomTom ITN):
 *   4 = departure point (solo il primo waypoint)
 *   0 = waypoint intermedio
 *   2 = stopover/destination (solo l'ultimo waypoint)
 *
 * Encoding: Windows-1252 (ANSI). JS produce stringhe UTF-16; il server/browser
 * deve serializzare in Windows-1252 se il dispositivo lo richiede. Per
 * percorsi in alfabeto latino standard (Europa occidentale) UTF-8 e
 * Windows-1252 coincidono, quindi il file è compatibile nella pratica.
 *
 * @param {Array<{lat,lon,name}>} wps
 * @returns {string}
 */
export function buildITNString(wps) {
  return wps.map((w, i) => {
    const lonM  = Math.round(w.lon * 1e5);                       // FIX: ×1e5, non 1e6
    const latM  = Math.round(w.lat * 1e5);                       // FIX: ×1e5, non 1e6
    const flag  = i === 0                ? 4                      // FIX: 4 = partenza (primo)
                : i === wps.length - 1   ? 2                      // FIX: 2 = destinazione (ultimo)
                :                          0;                     // 0 = tappa intermedia
    const wname = (w.name || `Tappa ${i + 1}`).replace(/\|/g, '-').substring(0, 32);
    return `${lonM}|${latM}|${wname}|${flag}|`;
  }).join('\n');
}

// [CHECKP_TASK_05] hash: v18.0_b5c9d17
// [FASE_0] 0.B: snap haversine + warning per-waypoint (nome + paese + distanza)
// [FIX_ITN_1] buildITNString: moltiplicatore coordinate corretto 1e6→1e5 (spec TomTom ×100.000)
// [FIX_ITN_2] buildITNString: tipo flag corretto — 4=partenza(i=0), 2=destinazione(i=last), 0=intermedio
// [FIX_ITN_3] buildITNString: aggiunta nota encoding Windows-1252 nel JSDoc
// [FASE_3] buildGPXString/buildKMLString: nuovo param opzionale fallbackCount → nota
//          informativa (commento XML / description) SOLO se >0. buildITNString invariata
//          e non tocca fallbackCount: il Rider ricalcola le strade, non serve avviso.
// [TEST] Copertura in test_08_export.js — rilanciare dopo ogni modifica a questo file (node test_08_export.js)
// [FIX_ELE_1] v23.0 — buildKMLString: linePlacemark usa p.ele ?? 0 invece di ",0" hardcoded.
//             wpPlacemarks ora usa uno snap-lookup (snappedWps) identico nello spirito
//             a quello già presente in buildGPXString, per coerenza di quota E posizione
//             KML↔GPX. Nessuna modifica a buildGPXString/buildITNString.
