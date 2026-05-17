// task_07 - hash_input: e9b1c4f (Route_converter_v18.0, righe 604-656, 656-851, 1597-1683)
// Parser file (GPX, KMZ, KML) e URL (Google Maps, Apple Maps, Waze).
// Funzioni pure eccetto parseFile (usa Swal per alert) e addLog (iniettato).

// ── Helpers XML ───────────────────────────────────────────────────────────────

function _getElementsByTagNameNS(doc, localName) {
  const elements = doc.getElementsByTagName(localName);
  if (elements.length > 0) return Array.from(elements);
  const all = doc.getElementsByTagName('*');
  const result = [];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag === localName || tag.endsWith(':' + localName)) result.push(el);
  }
  return result;
}

function _getElementTextContent(el, tagName) {
  const found = _getElementsByTagNameNS(el.ownerDocument || el, tagName);
  for (const child of found) {
    if (el === child || el.contains(child)) return child.textContent;
  }
  for (const child of el.children) {
    const t = child.tagName.toLowerCase();
    if (t === tagName || t.endsWith(':' + tagName)) return child.textContent;
  }
  return null;
}

// ── Modello dati waypoint esteso ──────────────────────────────────────────────
/**
 * Arricchisce un waypoint grezzo con tutti i campi del modello esteso.
 * I campi mancanti ricevono valori di default sicuri (null / false / 50).
 *
 * @param {{ lat, lon, name?, countryCode?, adminRegion?, placeType?,
 *           source?, snapToleranceMeters?, userMarkedObligatory? }} base
 * @returns {object} waypoint con modello completo
 */
function _enrichWaypoint(base) {
  return {
    lat:                  base.lat,
    lon:                  base.lon,
    name:                 base.name                ?? null,
    countryCode:          base.countryCode          ?? null,
    adminRegion:          base.adminRegion           ?? null,
    placeType:            base.placeType             ?? null,
    source:               base.source                ?? 'gpx_native',
    snapToleranceMeters:  base.snapToleranceMeters   ?? 50,
    userMarkedObligatory: base.userMarkedObligatory  ?? false,
  };
}

// ── GPX parser robusto ────────────────────────────────────────────────────────
/**
 * @param {string} xmlStr
 * @param {{ addLog: Function }} deps
 * @returns {{ waypoints, sourceType, rawPoints? }}
 */
export function parseGPXRobust(xmlStr, { addLog: _addLog } = {}) {
  const addLog = _addLog ?? ((msg, type) => console.warn(`[parser][${type ?? 'log'}] ${msg}`));

  xmlStr = xmlStr.replace(/^\uFEFF/, '');
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('Errore sintassi XML: ' + err.textContent);
  } catch (e) {
    throw new Error('Impossibile parsare il file XML: ' + e.message);
  }

  const waypoints = [];

  const extractLatLon = (el) => {
    let lat = null, lon = null;
    if (el.hasAttribute('lat') && el.hasAttribute('lon')) {
      lat = parseFloat(el.getAttribute('lat'));
      lon = parseFloat(el.getAttribute('lon'));
    } else {
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        const val  = parseFloat(attr.value);
        if (!isNaN(val)) {
          const name = attr.name.toLowerCase();
          if (name.includes('lat')) lat = val;
          if (name.includes('lon')) lon = val;
        }
      }
    }
    if (lat === null || lon === null) {
      const m = el.textContent.match(/(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/);
      if (m) { lat = parseFloat(m[1]); lon = parseFloat(m[2]); }
    }
    return { lat, lon };
  };

  const extractName = (el) => {
    for (const child of el.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'name' || tag.endsWith(':name')) {
        const t = child.textContent?.trim();
        if (t) return t;
      }
    }
    const byTag = el.getElementsByTagName('name');
    if (byTag.length > 0 && byTag[0].textContent?.trim()) return byTag[0].textContent.trim();
    for (const node of el.getElementsByTagName('*')) {
      if (node.tagName.toLowerCase().endsWith(':name') && node.textContent?.trim()) return node.textContent.trim();
    }
    return null;
  };

  const extractRawTrkpts = (trkptList) => {
    const raw = [];
    for (const pt of trkptList) {
      const { lat, lon } = extractLatLon(pt);
      const eleEl = pt.getElementsByTagNameNS
        ? (pt.getElementsByTagNameNS('*', 'ele')[0] || pt.getElementsByTagName('ele')[0])
        : pt.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent) : undefined;
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        raw.push({ lat, lon, ele: isNaN(ele) ? undefined : ele });
      }
    }
    return raw;
  };

  const rtepts      = _getElementsByTagNameNS(doc, 'rtept');
  const allTrkptsEl = _getElementsByTagNameNS(doc, 'trkpt');
  const hasTrkpt    = allTrkptsEl.length > 0;
  const isGarminHybrid = rtepts.length > 0 && hasTrkpt &&
    doc.querySelector('trp\\:ViaPoint, ViaPoint') !== null;

  // ── Case 1a: Garmin ibrido (rtept + trkpt + ViaPoint) ─────────────────────
  if (isGarminHybrid) {
    addLog(`🗺️ Formato Garmin ibrido (${rtepts.length} rtept + trkpt)`, 'info');
    const hybridWps = [];
    for (const pt of rtepts) {
      const { lat, lon } = extractLatLon(pt);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const name = extractName(pt) || _getElementTextContent(pt, 'desc')?.trim() || `Tappa ${hybridWps.length + 1}`;
        hybridWps.push(_enrichWaypoint({ lat, lon, name: name.substring(0, 50), source: 'gpx_native' }));
      }
    }
    const hybridRaw = extractRawTrkpts(allTrkptsEl);
    if (hybridWps.length >= 2 && hybridRaw.length > 0) {
      addLog(`✅ Garmin ibrido: ${hybridWps.length} tappe + ${hybridRaw.length} punti GPS`, 'ok');
      return { waypoints: hybridWps, sourceType: 'garmin_hybrid', rawPoints: hybridRaw };
    }
    addLog('⚠️ Garmin ibrido: rtept insufficienti, fallback su trkpt', 'warn');
  }

  // ── Case 1b: rtept standard ────────────────────────────────────────────────
  if (rtepts.length > 0 && !isGarminHybrid) {
    addLog(`📍 Trovati ${rtepts.length} waypoint da <rtept>`, 'ok');
    for (const pt of rtepts) {
      const { lat, lon } = extractLatLon(pt);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const name = extractName(pt) || _getElementTextContent(pt, 'desc')?.trim() || `Tappa ${waypoints.length + 1}`;
        waypoints.push(_enrichWaypoint({ lat, lon, name: name.substring(0, 50), source: 'gpx_native' }));
      }
    }
    if (waypoints.length > 0) {
      return { waypoints, sourceType: 'rtept', rawPoints: hasTrkpt ? extractRawTrkpts(allTrkptsEl) : undefined };
    }
  }

  // ── Case 2: wpt ───────────────────────────────────────────────────────────
  const wpts = _getElementsByTagNameNS(doc, 'wpt');
  if (wpts.length > 0) {
    addLog(`📍 Trovati ${wpts.length} waypoint da <wpt>`, 'ok');
    for (const pt of wpts) {
      const { lat, lon } = extractLatLon(pt);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const name = extractName(pt) || _getElementTextContent(pt, 'desc')?.trim() || `Punto ${waypoints.length + 1}`;
        waypoints.push(_enrichWaypoint({ lat, lon, name: name.substring(0, 50), source: 'gpx_native' }));
      }
    }
    if (waypoints.length >= 2) return { waypoints, sourceType: 'wpt', rawPoints: undefined };
  }

  // ── Case 3: trkpt only ────────────────────────────────────────────────────
  const trkpts = _getElementsByTagNameNS(doc, 'trkpt');
  if (trkpts.length > 0) {
    addLog(`📍 Trovati ${trkpts.length} track point — estrazione start/end`, 'info');
    const rawPoints = extractRawTrkpts(trkpts);
    if (rawPoints.length > 0) {
      const trkWps = [
        _enrichWaypoint({ lat: rawPoints[0].lat,                    lon: rawPoints[0].lon,                    name: 'Partenza',     source: 'gpx_native' }),
        _enrichWaypoint({ lat: rawPoints[rawPoints.length - 1].lat, lon: rawPoints[rawPoints.length - 1].lon, name: 'Destinazione', source: 'gpx_native' }),
      ];
      addLog(`✅ Traccia: start + end, ${rawPoints.length} rawPoints al chiamante`, 'ok');
      return { waypoints: trkWps, sourceType: 'trkpt', rawPoints };
    }
  }

  if (waypoints.length === 0) throw new Error('Nessun waypoint valido trovato nel file GPX.');
  return { waypoints, sourceType: 'unknown' };
}

// ── KML parser ────────────────────────────────────────────────────────────────
/**
 * @param {string} xmlStr
 * @returns {Array<{lat,lon,name}>}
 */
export function parseKML(xmlStr) {
  xmlStr = xmlStr.replace(/^\uFEFF/, '');
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('KML malformato');

  const pts = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const pt = pm.getElementsByTagName('Point')[0];
    if (pt) {
      const coords = pt.getElementsByTagName('coordinates')[0]?.textContent?.trim();
      if (coords) {
        const [lon, lat] = coords.split(',').map(Number);
        pts.push(_enrichWaypoint({
          lat, lon,
          name: pm.getElementsByTagName('name')[0]?.textContent || 'Luogo',
          source: 'gpx_native',
        }));
      }
    }
  }

  if (pts.length === 0) {
    const lines = doc.getElementsByTagName('LineString');
    if (lines.length > 0) {
      const coords = lines[0].getElementsByTagName('coordinates')[0]?.textContent?.trim().split(/\s+/);
      if (coords?.length > 0) {
        pts.push(_enrichWaypoint({ lat: parseFloat(coords[0].split(',')[1]), lon: parseFloat(coords[0].split(',')[0]), name: 'Inizio', source: 'gpx_native' }));
        if (coords.length > 1) pts.push(_enrichWaypoint({ lat: parseFloat(coords[coords.length-1].split(',')[1]), lon: parseFloat(coords[coords.length-1].split(',')[0]), name: 'Fine', source: 'gpx_native' }));
      }
    }
  }

  if (pts.length === 0) throw new Error('Nessun punto trovato nel KML');
  return pts;
}

// ── parseFile: entry point per file GPX/KMZ/KML ──────────────────────────────
/**
 * @param {File}   file
 * @param {{ addLog }} deps
 * @returns {Promise<{ waypoints, sourceType, rawPoints? }>}
 */
export async function parseFile(file, { addLog: _addLog } = {}) {
  const addLog = _addLog ?? ((msg, type) => console.warn(`[parser][${type ?? 'log'}] ${msg}`));

  const ext = file.name.split('.').pop().toLowerCase();
  try {
    let result;
    if (ext === 'gpx' || ext === 'xml') {
      result = parseGPXRobust(await file.text(), { addLog });
    } else if (ext === 'kmz' || ext === 'kml') {
      const kmlText = ext === 'kmz'
        ? await (await JSZip.loadAsync(file)).file('doc.kml').async('string')
        : await file.text();
      result = { waypoints: parseKML(kmlText), sourceType: 'kml' };
    } else {
      throw new Error(`Formato non supportato: .${ext}`);
    }

    // Nessun controllo sul numero di tappe qui.
    // L'ingresso è libero — il cancello di consenso è in go() fase 3.
    return result;
  } catch (e) {
    addLog(`❌ Errore parsing file: ${e.message}`, 'warn');
    throw e;
  }
}

// ── URL parsers ───────────────────────────────────────────────────────────────

function _cleanStopName(stop) {
  if (!stop) return stop;
  return stop.replace(/,\s*\d{4,5}(?=\s*[,)]|$)/g, '').replace(/\s{2,}/g, ' ').trim();
}

function _parseDir(url) {
  const match = url.match(/maps\/dir\/([^@?]+)/);
  if (!match) return null;
  return match[1].split('/')
    .map(s => decodeURIComponent(s.replace(/\+/g, ' ')).trim())
    .filter(s => s && s.length > 0 && !s.startsWith('@') && !s.includes('data='))
    .map(_cleanStopName)
    .filter(s => s && s.length > 0);
}

function _parseAppleMaps(url) {
  try {
    const u = new URL(url);
    if (!u.host.includes('apple.com')) return null;
    const stops = [];
    if (u.searchParams.get('q'))     stops.push(u.searchParams.get('q'));
    if (u.searchParams.get('daddr')) stops.push(u.searchParams.get('daddr'));
    const sll = u.searchParams.get('sll') || u.searchParams.get('ll');
    if (sll) { const [lat, lon] = sll.split(','); stops.unshift(`${lat},${lon}`); }
    return stops.length >= 2 ? { stops, src: 'Apple Maps' } : null;
  } catch (e) { return null; }
}

function _parseWaze(url) {
  try {
    const u = new URL(url);
    if (!u.host.includes('waze.com')) return null;
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    if (from && to) return { stops: [from, to], src: 'Waze' };
    if (u.searchParams.get('ll')) return { stops: [u.searchParams.get('ll')], src: 'Waze (partial)' };
    return null;
  } catch (e) { return null; }
}

function _parseGoogleQuery(url) {
  try {
    const u = new URL(url);
    const stops = [];
    if (u.searchParams.get('origin'))      stops.push(u.searchParams.get('origin'));
    const w = u.searchParams.get('waypoints');
    if (w) stops.push(...w.split('|').filter(Boolean));
    if (u.searchParams.get('destination')) stops.push(u.searchParams.get('destination'));
    return stops.length >= 2 ? { stops, src: 'Google Maps (query)' } : null;
  } catch (e) { return null; }
}

/**
 * Estrae le tappe da una URL Google/Apple/Waze.
 * @param {string} raw
 * @returns {{ stops: string[], src: string }|null}
 */
export function extractStops(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const apple = _parseAppleMaps(url); if (apple) return apple;
  const waze  = _parseWaze(url); if (waze?.stops.length >= 2) return waze;
  const google = _parseGoogleQuery(url); if (google?.stops.length >= 2) return google;
  if (url.includes('maps/dir/')) {
    const stops = _parseDir(url);
    if (stops?.length >= 2) return { stops, src: 'Google Maps (path)' };
  }
  return null;
}

/** Estrae tutte le coppie coordinate !1d!2d da una URL Google Maps blob */
export function extractAllWaypointCoords(url) {
  const re = /!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g;
  const coords = [];
  let m;
  while ((m = re.exec(url)) !== null) coords.push({ lon: parseFloat(m[1]), lat: parseFloat(m[2]) });
  return coords;
}

/** Testa se la stringa è una coppia lat,lon */
export function coordStr(s) {
  const m = s.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  return m ? { lat: parseFloat(m[1]), lon: parseFloat(m[2]), name: s } : null;
}

/** Testa se la URL contiene dati blob Google Maps */
export function isBlob(s) { return s.includes('data=') || s.includes('!3m') || s.includes('authuser='); }

/** Estrae coordinate dall'ultimo blob !1d!2d nella stringa */
export function blobCoords(s) {
  const re = /!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g;
  const pairs = [];
  let m;
  while ((m = re.exec(s)) !== null) pairs.push({ lon: parseFloat(m[1]), lat: parseFloat(m[2]) });
  if (!pairs.length) return null;
  const p = pairs[pairs.length - 1];
  return { lat: p.lat, lon: p.lon, name: p.lat.toFixed(5) + ',' + p.lon.toFixed(5) };
}

/** Testa se la URL è corta (maps.app.goo.gl, goo.gl/maps) */
export function isShortUrl(url) { return /maps\.app\.goo\.gl|goo\.gl\/maps/i.test(url); }

// [CHECKP_TASK_07] hash: v18.0_c2f8e19
// [FASE_0] 0.C: fallback addLog in parseGPXRobust e parseFile
// [FASE_0] 0.E: _enrichWaypoint aggiunto, tutti i waypoints.push aggiornati
