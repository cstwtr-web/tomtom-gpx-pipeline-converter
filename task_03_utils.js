// task_03_utils.js
// Funzioni pure, zero dipendenze da DOM/state/Leaflet.


// ── Shorthand DOM ─────────────────────────────────────────────────────────────
export const $ = id => document.getElementById(id);

// ── Escape HTML ───────────────────────────────────────────────────────────────
export const esc = s =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// ── Pausa asincrona ───────────────────────────────────────────────────────────
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Rilevamento iOS ───────────────────────────────────────────────────────────
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

// ── Formatta dimensione file ──────────────────────────────────────────────────
export function formatBytes(bytes) {
  if (!bytes)            return '';
  if (bytes < 1024)      return bytes + ' B';
  if (bytes < 1024*1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Barra di avanzamento ──────────────────────────────────────────────────────
export function setProgress(p) {
  $('progBar').style.width = p + '%';
}

// ── Log UI ────────────────────────────────────────────────────────────────────
export function addLog(msg, t = 'dim') {
  const icons = { ok: '●', info: '◆', dim: '○', warn: '◆' };
  const d = document.createElement('div');
  d.className = 'log-row l-' + t;
  d.innerHTML = `<span class="d">${icons[t] || '○'}</span><span>${msg}</span>`;
  $('logEl').appendChild(d);
  $('logEl').scrollTop = 9999;
}

// ── Haversine (distanza in metri tra due punti {lat, lon}) ────────────────────
// Unica definizione condivisa — sostituisce le tre copie precedenti in:
//   updateRoutingAndUI() → fast-path Garmin
//   _insertWaypointAtLatLon() → snap al tracciato + forceRaw
//   _hausdorffSegment() → Fase 5
export function haversineM(a, b) {
  const R    = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) *
    Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ── Decodifica polyline6 (formato Valhalla/OSRM) ──────────────────────────────
export function decodePolyline6(encoded) {
  const factor = 1e6;
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push({ lat: lat / factor, lon: lng / factor });
  }
  return coords;
}

// ── isSemanticName / computePinnedSet ────────────────────────────────────────
// Rimosse da questo modulo: fonte di verità unica in task_04_waypoint_policy.js
// (gestisce anche il flag wp.pinned, assente nella versione precedente).
