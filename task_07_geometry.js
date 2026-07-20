// task_07_geometry.js
// Algoritmi geometrici puri: nessun DOM, nessuna variabile globale.
// Tutte le funzioni ricevono i parametri necessari esplicitamente.

import { haversineM } from './task_03_utils.js';

// ── Distanza haversine in metri ──────────────────────────────────────────────
// Implementazione unica in task_03_utils.js (haversineM) — era duplicata
// byte-per-byte qui. Nome storico mantenuto come alias per non toccare i
// 3 call-site interni né la firma esportata (usata anche da test_07_geometry.js).
export function getDistanceMeters(p1, p2) { return haversineM(p1, p2); }

// ── Angolo di svolta tra tre punti (gradi) ──────────────────────────────────
export function calculateTurningAngle(p1, p2, p3) {
  const dx1 = p2.lon - p1.lon, dy1 = p2.lat - p1.lat;
  const dx2 = p3.lon - p2.lon, dy2 = p3.lat - p2.lat;
  const dot  = dx1 * dx2 + dy1 * dy2;
  const mag1 = Math.sqrt(dx1 ** 2 + dy1 ** 2);
  const mag2 = Math.sqrt(dx2 ** 2 + dy2 ** 2);
  if (mag1 === 0 || mag2 === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (mag1 * mag2)))) * 180 / Math.PI;
}

// ── Distanza perpendicolare punto-segmento (metri, proiezione sferica) ───────
export function perpendicularDistance(point, lineStart, lineEnd) {
  const R      = 6371000;
  const latMid = ((lineStart.lat + lineEnd.lat) / 2) * Math.PI / 180;
  const toX    = lon => lon * Math.PI / 180 * R * Math.cos(latMid);
  const toY    = lat => lat * Math.PI / 180 * R;
  const px = toX(point.lon),    py = toY(point.lat);
  const ax = toX(lineStart.lon), ay = toY(lineStart.lat);
  const bx = toX(lineEnd.lon),   by = toY(lineEnd.lat);
  const dx = bx - ax, dy = by - ay;
  const mag = Math.sqrt(dx ** 2 + dy ** 2);
  if (mag === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  const u  = ((px - ax) * dx + (py - ay) * dy) / (mag ** 2);
  const cx = ax + u * dx, cy = ay + u * dy;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

// ── Bearing da punto a a punto b [0,360) ─────────────────────────────────────
export function bearingDeg(a, b) {
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const y    = Math.sin(dLon) * Math.cos(lat2);
  const x    = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ── Douglas-Peucker iterativo (stack, non ricorsivo) ─────────────────────────
export function dpExtract(points, tolerance) {
  if (points.length <= 2) return [...points];
  const stack = [[0, points.length - 1]];
  const keep  = new Set([0, points.length - 1]);
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s <= 1) continue;
    let maxDist = 0, maxI = s;
    for (let i = s + 1; i < e; i++) {
      const d = perpendicularDistance(points[i], points[s], points[e]);
      if (d > maxDist) { maxDist = d; maxI = i; }
    }
    if (maxDist > tolerance) {
      keep.add(maxI);
      stack.push([s, maxI]);
      stack.push([maxI, e]);
    }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i]);
}

// ── Douglas-Peucker ricorsivo (compatibilità legacy) ─────────────────────────
export function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIndex = 0;
  const start = points[0], end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], start, end);
    if (dist > maxDist) { maxDist = dist; maxIndex = i; }
  }
  if (maxDist > tolerance) {
    const left  = douglasPeucker(points.slice(0, maxIndex + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIndex), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [start, end];
}

// ── pruneBacktracks: rimuove inversioni rispetto al bearing globale ───────────
// Protegge i tornanti: run contigui > 30% della poly vengono ripristinati.
export function pruneBacktracks(points, { addLog } = {}) {
  if (!points || points.length < 4) return points;
  const THRESH = 120; // gradi: soglia inversione
  const WINDOW = 5;
  const globalBearing = bearingDeg(points[0], points[points.length - 1]);
  const keep = new Array(points.length).fill(true);

  for (let i = 1; i < points.length - 1; i++) {
    const from = Math.max(0, i - Math.floor(WINDOW / 2));
    const to   = Math.min(points.length - 1, i + Math.floor(WINDOW / 2));
    const localBearing = bearingDeg(points[from], points[to]);
    let diff = Math.abs(localBearing - globalBearing);
    if (diff > 180) diff = 360 - diff;
    if (diff > THRESH) keep[i] = false;
  }

  // Ripristina run troppo lunghi (tornanti legittimi)
  const maxContiguous = Math.floor(points.length * 0.30);
  let runLen = 0, runStart = -1;
  for (let i = 0; i < points.length; i++) {
    if (!keep[i]) {
      if (runStart === -1) runStart = i;
      runLen++;
    } else {
      if (runLen > maxContiguous) for (let j = runStart; j < i; j++) keep[j] = true;
      runLen = 0; runStart = -1;
    }
  }
  if (runLen > maxContiguous && runStart !== -1)
    for (let j = runStart; j < points.length - 1; j++) keep[j] = true;

  const pruned = points.filter((_, i) => keep[i]);
  addLog?.(`📐 pruneBacktracks: rimossi ${points.length - pruned.length} punti su ${points.length}`, 'dim');
  return pruned.length >= 2 ? pruned : points;
}

// ── selectWaypointsSpatial: distribuzione ponderata per curvatura ─────────────
export function selectWaypointsSpatial(routePoints, targetCount) {
  if (!routePoints || routePoints.length < 2) return null;
  const n = routePoints.length;
  if (targetCount <= 2 || n <= targetCount) {
    return routePoints.map((p, i) => ({ ...p, name: i === 0 ? 'Partenza' : i === n - 1 ? 'Destinazione' : `Via ${i}` }));
  }
  const interior = targetCount - 2;
  const UTURN = 150, W_MAX = 8, W_BASE = 1;
  const weights = new Array(n).fill(W_BASE);
  for (let i = 1; i < n - 1; i++) {
    const b1 = bearingDeg(routePoints[i - 1], routePoints[i]);
    const b2 = bearingDeg(routePoints[i], routePoints[i + 1]);
    let angle = Math.abs(b2 - b1); if (angle > 180) angle = 360 - angle;
    if (angle >= UTURN) { weights[i] = 0; continue; }
    weights[i] = W_BASE + Math.min(angle / 90, 1.0) * (W_MAX - W_BASE);
  }
  const cumW = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dist = getDistanceMeters(routePoints[i - 1], routePoints[i]);
    cumW[i] = cumW[i - 1] + dist * ((weights[i - 1] + weights[i]) / 2);
  }
  const totalW = cumW[n - 1];
  const step   = totalW / (interior + 1);
  const selected = [0];
  let ptr = 1;
  for (let s = 1; s <= interior; s++) {
    const target = step * s;
    while (ptr < n - 1 && cumW[ptr] < target) ptr++;
    const prev = ptr - 1;
    let best = Math.abs(cumW[prev] - target) <= Math.abs(cumW[ptr] - target) ? prev : ptr;
    if (weights[best] === 0) {
      for (let delta = 1; delta < 10; delta++) {
        if (best + delta < n - 1 && weights[best + delta] > 0) { best += delta; break; }
        if (best - delta > 0     && weights[best - delta] > 0) { best -= delta; break; }
      }
    }
    if (best !== selected[selected.length - 1]) selected.push(best);
  }
  selected.push(n - 1);
  const unique = [...new Set(selected)].sort((a, b) => a - b);
  return unique.map((idx, i) => ({ ...routePoints[idx], name: i === 0 ? 'Partenza' : i === unique.length - 1 ? 'Destinazione' : `Via ${i}` }));
}

// ── sampleCriticalWaypointsFromGeometry: DP adattivo post-OSRM ───────────────
export function sampleCriticalWaypointsFromGeometry(routePoints, targetCount) {
  if (!routePoints || routePoints.length < 2) return null;
  if (targetCount >= routePoints.length) return routePoints.map((p, i) => ({
    ...p, name: i === 0 ? 'Partenza' : i === routePoints.length - 1 ? 'Destinazione' : `Via ${i}`,
  }));
  let tol = 0.00005;
  let candidates = dpExtract(routePoints, tol);
  while (candidates.length > targetCount && tol < 1.0) {
    tol *= 1.8;
    candidates = dpExtract(routePoints, tol);
  }
  if (candidates.length > targetCount) {
    const step   = (candidates.length - 2) / (targetCount - 2);
    const capped = [candidates[0]];
    for (let i = 1; i < targetCount - 1; i++) capped.push(candidates[Math.round(i * step)]);
    capped.push(candidates[candidates.length - 1]);
    candidates = capped;
  }
  return candidates.map((p, i) => ({
    ...p, name: i === 0 ? 'Partenza' : i === candidates.length - 1 ? 'Destinazione' : `Via ${i}`,
  }));
}

// ── redistributeUniform: campionamento per indice (legacy, non usare per trkpt) ──
// ⚠️ DEPRECATA per tracce GPS: campiona per indice, non per distanza reale.
//    Usare redistributeByDistance() per tracce trkpt.
//    Mantenuta per compatibilità con chiamanti esistenti.
export function redistributeUniform(routePoints, count) {
  if (!routePoints || routePoints.length < 2) return null;
  if (count >= routePoints.length) return routePoints.map((p, i) => ({
    ...p, name: i === 0 ? 'Partenza' : i === routePoints.length - 1 ? 'Destinazione' : `Via ${i}`,
  }));
  const result = [routePoints[0]];
  const step   = (routePoints.length - 1) / (count - 1);
  for (let i = 1; i < count - 1; i++) result.push(routePoints[Math.round(i * step)]);
  result.push(routePoints[routePoints.length - 1]);
  return result.map((p, i) => ({
    ...p, name: i === 0 ? 'Partenza' : i === result.length - 1 ? 'Destinazione' : `Via ${i}`,
  }));
}

// ── redistributeByDistance: campionamento per distanza cumulativa reale ───────
// Garantisce N waypoint equidistanti in km reali sull'intero percorso,
// indipendentemente dalla densità di campionamento GPS.
// Uso corretto per tracce trkpt: sostituisce redistributeUniform.
//
// Esempio: traccia con 800 punti, 300 km totali, target 21 WP
//   → un waypoint ogni ~15 km reali
//   → tornanti (GPS denso) e rettilinei (GPS rado) ricevono la stessa copertura
export function redistributeByDistance(points, count) {
  if (!points || points.length < 2) return null;
  if (count >= points.length) return points.map((p, i) => ({
    ...p, name: i === 0 ? 'Partenza' : i === points.length - 1 ? 'Destinazione' : `Via ${i}`,
  }));

  // 1. Distanza cumulativa tra tutti i punti consecutivi (haversine)
  const cumDist = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    cumDist[i] = cumDist[i - 1] + getDistanceMeters(points[i - 1], points[i]);
  }
  const totalDist = cumDist[points.length - 1];

  // 2. Seleziona il punto più vicino a ogni target di distanza
  const result = [points[0]];
  const step   = totalDist / (count - 1);

  for (let s = 1; s < count - 1; s++) {
    const target = step * s;
    // Ricerca lineare: efficiente per array già ordinati per distanza crescente
    let best = 1;
    for (let i = 1; i < points.length - 1; i++) {
      if (Math.abs(cumDist[i] - target) < Math.abs(cumDist[best] - target)) best = i;
    }
    result.push(points[best]);
  }
  result.push(points[points.length - 1]);

  return result.map((p, i) => ({
    ...p,
    name: i === 0 ? 'Partenza' : i === result.length - 1 ? 'Destinazione' : `Via ${i}`,
  }));
}

// ── motoOptimize: pipeline completa pre-OSRM ─────────────────────────────────
// filtro 30m → (filtro angolare se non user-waypoints) → DP + cap al wpLimit
// pinnedSet: Set di indici (nel pool `points`) delle tappe semantiche da preservare sempre.
// L'ordine geografico originale è sempre garantito — nessuna tappa viene riposizionata.
export function motoOptimize(points, sourceType, wpLimit, { addLog, pinnedSet } = {}) {
  if (points.length <= 2) return points;
  addLog?.('Avvio semplificazione Moto-Optimized...', 'info');

  const isUserDefined = ['rtept', 'wpt', 'garmin_hybrid'].includes(sourceType);

  // Costruisce un Set di riferimenti agli oggetti pinned (per ritrovarli dopo i filtri)
  const pinnedObjects = new Set(
    pinnedSet ? [...pinnedSet].map(i => points[i]).filter(Boolean) : []
  );

  // Filtro 30m — le pinned bypassano sempre il filtro distanza
  let filtered = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const isPinned = pinnedObjects.has(points[i]);
    if (isPinned || getDistanceMeters(filtered[filtered.length - 1], points[i]) >= 30)
      filtered.push(points[i]);
  }
  addLog?.(`Filtro 30m: ${points.length} → ${filtered.length}`, 'dim');

  let result = filtered;

  // Filtro angolare (solo track-point ad alta densità) — le pinned bypassano
  if (!isUserDefined && filtered.length > 3) {
    const angularKept = [filtered[0]];
    for (let i = 1; i < filtered.length - 1; i++) {
      const isPinned = pinnedObjects.has(filtered[i]);
      if (isPinned || calculateTurningAngle(filtered[i - 1], filtered[i], filtered[i + 1]) < 160)
        angularKept.push(filtered[i]);
    }
    angularKept.push(filtered[filtered.length - 1]);
    result = angularKept;
    addLog?.(`Filtro angolare: ${filtered.length} → ${result.length}`, 'dim');
  }

  if (result.length > wpLimit) {
    addLog?.(`Riduzione DP (${result.length} → max ${wpLimit})...`, 'warn');

    // Separa pinned e non-pinned mantenendo l'ordine geografico (posizione in result)
    const pinnedInResult    = result.filter(p => pinnedObjects.has(p));
    const nonPinnedInResult = result.filter(p => !pinnedObjects.has(p));

    // Slot disponibili per le non-pinned dopo aver riservato i posti alle pinned
    const slotsForNonPinned = Math.max(0, wpLimit - pinnedInResult.length);

    let decimatedNonPinned = nonPinnedInResult;

    if (slotsForNonPinned === 0) {
      // Le pinned da sole superano il limite — teniamo solo le pinned
      decimatedNonPinned = [];
      addLog?.(`⚠️ Tappe semantiche (${pinnedInResult.length}) saturano il limite`, 'warn');
    } else if (nonPinnedInResult.length > slotsForNonPinned) {
      // DP sulle sole non-pinned per ridurle agli slot disponibili
      if (sourceType !== 'trkpt') {
        let tolerance = 0.00001;
        let dp = nonPinnedInResult;
        while (dp.length > slotsForNonPinned && tolerance < 0.01) {
          dp = douglasPeucker(nonPinnedInResult, tolerance);
          tolerance *= 1.8;
        }
        decimatedNonPinned = dp;
      }
      if (decimatedNonPinned.length > slotsForNonPinned) {
        // Cap finale per indice sulle non-pinned
        const step   = (nonPinnedInResult.length - 1) / Math.max(1, slotsForNonPinned - 1);
        const capped = [];
        for (let i = 0; i < slotsForNonPinned; i++) {
          const idx = Math.min(Math.round(i * step), nonPinnedInResult.length - 1);
          capped.push(nonPinnedInResult[idx]);
        }
        decimatedNonPinned = [...new Map(capped.map(p => [p, p])).values()];
      }
    }

    // Merge finale: riordina per posizione originale in `result` (ordine geografico garantito)
    const mergedSet = new Set([...pinnedInResult, ...decimatedNonPinned]);
    result = result.filter(p => mergedSet.has(p));

    addLog?.(`Percorso ridotto a ${result.length} tappe (limite: ${wpLimit})`, 'warn');
  }
  return result;
}


// [CHECKP_TASK_04] hash: v18.0_a7d2e83
// [TEST] Copertura in test_07_geometry.js — rilanciare dopo ogni modifica a questo file (node test_07_geometry.js)
