// task_18_altitude_chart.js
// Grafico altimetrico (distanza/quota) — SVG disegnato a mano, nessuna nuova
// dipendenza CDN. Decisione architetturale validata: Chart.js non è mai stato
// caricato nel progetto (solo SweetAlert2/JSZip/Leaflet in index.html) e non
// c'è alcun precedente di libreria di charting — coerente con "se non c'è un
// precedente, soluzione più semplice da mantenere". Se in fase d'uso reale
// emergono motivi tecnici concreti per preferire Chart.js, vanno segnalati
// esplicitamente, non decisi silenziosamente qui.
//
// Nota numerazione: vedi task_17_elevation.js — "16"/"17" erano entrambi da
// verificare col gestore del progetto; questo file usa "18" per restare
// libero da conflitti nel frattempo.
//
// Sorgente dati: routePoints, lo stesso evento a cui si aggancia
// l'elevazione (task_17). Douglas-Peucker (task_07_geometry.js) agisce solo
// a monte sui waypoint utente, mai su routePoints — nessun problema di dati
// pre/post-semplificazione qui.

import { haversineM } from './task_03_utils.js';

const CHART_W = 600;
const CHART_H = 150;
const PAD_L   = 4;
const PAD_R   = 4;
const PAD_T   = 10;
const PAD_B   = 4;

// ── Statistiche derivate ─────────────────────────────────────────────────────
/**
 * Calcola statistiche altimetriche da una traccia con quote.
 * Ritorna null se manca anche un solo p.ele (nessuna quota disponibile,
 * es. Open-Elevation fallita) — il chiamante deve degradare in modo pulito,
 * mai mostrare un grafico con dati parziali/inventati.
 *
 * @param {Array<{lat,lon,ele}>} points
 * @returns {{minEle,maxEle,gainM,lossM,avgGradePct,maxGradePct,totalDist,distances:number[]}|null}
 */
export function computeElevationStats(points) {
  if (!points || points.length < 2) return null;
  if (points.some(p => p.ele === undefined || p.ele === null || isNaN(p.ele))) return null;

  const distances = [0];
  let cumDist = 0;
  let gainM = 0, lossM = 0;
  let minEle = points[0].ele, maxEle = points[0].ele;
  let maxGradePct = 0, gradeSum = 0, gradeCount = 0;

  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i - 1], points[i]);
    cumDist += d;
    distances.push(cumDist);

    const dEle = points[i].ele - points[i - 1].ele;
    if (dEle > 0) gainM += dEle; else lossM += -dEle;
    if (points[i].ele < minEle) minEle = points[i].ele;
    if (points[i].ele > maxEle) maxEle = points[i].ele;

    // Pendenza ignorata sotto 1m di distanza tra due punti consecutivi:
    // su tratti sub-metrici il rapporto dEle/d diverge senza significato reale.
    if (d > 1) {
      const gradePct = Math.abs(dEle / d) * 100;
      maxGradePct = Math.max(maxGradePct, gradePct);
      gradeSum += gradePct;
      gradeCount++;
    }
  }

  return {
    minEle, maxEle, gainM, lossM,
    avgGradePct: gradeCount > 0 ? gradeSum / gradeCount : 0,
    maxGradePct,
    totalDist: cumDist,
    distances,
  };
}

// ── Rendering SVG ─────────────────────────────────────────────────────────────
// Stato del grafico attualmente renderizzato, usato dall'hover mappa→grafico
// (onMapHoverLatLng) per sapere su quali punti/scale operare senza dover
// ripassare l'intero dataset ad ogni movimento del mouse sulla mappa.
let _current = null; // { points, stats, xScale, yScale, hoverLine, hoverDot }

function _buildScales(stats, w, h) {
  const eleRange = Math.max(1, stats.maxEle - stats.minEle); // evita /0 su tracce piatte
  const innerW = w - PAD_L - PAD_R;
  const innerH = h - PAD_T - PAD_B;
  const xScale = d => PAD_L + (stats.totalDist > 0 ? (d / stats.totalDist) * innerW : 0);
  const yScale = e => PAD_T + (1 - (e - stats.minEle) / eleRange) * innerH;
  return { xScale, yScale };
}

function _setHoverAt(idx) {
  if (!_current) return;
  const { points, stats, xScale, yScale, hoverLine, hoverDot } = _current;
  const p = points[idx];
  const x = xScale(stats.distances[idx]);
  const y = yScale(p.ele);
  hoverLine.setAttribute('x1', x); hoverLine.setAttribute('x2', x);
  hoverLine.classList.remove('rc-alt-hidden');
  hoverDot.setAttribute('cx', x); hoverDot.setAttribute('cy', y);
  hoverDot.classList.remove('rc-alt-hidden');
  return p;
}

function _clearHover() {
  if (!_current) return;
  _current.hoverLine.classList.add('rc-alt-hidden');
  _current.hoverDot.classList.add('rc-alt-hidden');
}

/**
 * Renderizza il grafico altimetrico dentro `container` (sostituisce
 * interamente innerHTML). Se le quote non sono disponibili, nasconde il
 * pannello (container.classList.add('hidden')) invece di mostrare un errore
 * — fallimento a monte (Open-Elevation) già silenzioso, qui si mantiene la
 * stessa filosofia di degrado pulito.
 *
 * @param {HTMLElement} container
 * @param {Array<{lat,lon,ele}>|null} points - routePoints correnti
 * @param {{showHoverMarker?:Function, hideHoverMarker?:Function}} [mapSync]
 *   showHoverMarker({lat,lon}) / hideHoverMarker() — da task_12_map_component.js,
 *   per il sync grafico→mappa (hover diretto). Opzionale: se assente il
 *   grafico funziona comunque, solo senza il puntino sulla mappa.
 */
export function renderAltitudeChart(container, points, mapSync = {}) {
  if (!container) return;

  const stats = computeElevationStats(points);
  if (!stats) {
    container.classList.add('hidden');
    container.innerHTML = '';
    _current = null;
    return;
  }
  container.classList.remove('hidden');

  const { xScale, yScale } = _buildScales(stats, CHART_W, CHART_H);
  const baseline = CHART_H - PAD_B;

  const linePts = points.map((p, i) => `${xScale(stats.distances[i]).toFixed(1)},${yScale(p.ele).toFixed(1)}`);
  const areaPath = `M${xScale(0).toFixed(1)},${baseline} L${linePts.join(' L')} L${xScale(stats.totalDist).toFixed(1)},${baseline} Z`;
  const linePath = `M${linePts.join(' L')}`;

  container.innerHTML = `
    <div class="sec-label">Profilo altimetrico</div>
    <div class="rc-alt-stats">
      <span title="Dislivello positivo">⬆️ ${Math.round(stats.gainM)} m</span>
      <span title="Dislivello negativo">⬇️ ${Math.round(stats.lossM)} m</span>
      <span title="Pendenza media">📈 ${stats.avgGradePct.toFixed(1)}% med.</span>
      <span title="Pendenza massima">⛰️ ${stats.maxGradePct.toFixed(1)}% max</span>
      <span title="Quota min/max">${Math.round(stats.minEle)}–${Math.round(stats.maxEle)} m</span>
    </div>
    <svg class="rc-alt-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none">
      <path class="rc-alt-area" d="${areaPath}"></path>
      <path class="rc-alt-line" d="${linePath}"></path>
      <line class="rc-alt-hover-line rc-alt-hidden" x1="0" y1="${PAD_T}" x2="0" y2="${baseline}"></line>
      <circle class="rc-alt-hover-dot rc-alt-hidden" r="4"></circle>
    </svg>`;

  const svg       = container.querySelector('.rc-alt-svg');
  const hoverLine = container.querySelector('.rc-alt-hover-line');
  const hoverDot  = container.querySelector('.rc-alt-hover-dot');

  _current = { points, stats, xScale, yScale, hoverLine, hoverDot };

  function _idxAtClientX(clientX) {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * CHART_W;
    let bestIdx = 0, bestDx = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = Math.abs(xScale(stats.distances[i]) - relX);
      if (dx < bestDx) { bestDx = dx; bestIdx = i; }
    }
    return bestIdx;
  }

  svg.addEventListener('mousemove', (e) => {
    const idx = _idxAtClientX(e.clientX);
    const p = _setHoverAt(idx);
    if (p) mapSync.showHoverMarker?.({ lat: p.lat, lon: p.lon });
  });
  svg.addEventListener('mouseleave', () => {
    _clearHover();
    mapSync.hideHoverMarker?.();
  });
}

// ── Sync mappa → grafico (hover inverso) ─────────────────────────────────────
// Delicato per costruzione (nessuna struttura spaziale precalcolata, ricerca
// lineare del punto più vicino ad ogni mousemove sulla polyline) ma
// implementato: si è rivelato pulito da agganciare perché riusa la stessa
// logica di ricerca già presente per l'hover grafico→mappa, senza toccare
// marker/drag/eliminazione tappe esistenti in task_12_map_component.js
// (solo un nuovo listener 'mousemove'/'mouseout' sulla polyline, additivo).
//
// @param {{lat,lon}|null} latlng - null quando il mouse esce dalla polyline
export function onMapHoverLatLng(latlng) {
  if (!_current) return;
  if (!latlng) { _clearHover(); return; }

  let bestIdx = 0, bestD = Infinity;
  for (let i = 0; i < _current.points.length; i++) {
    const d = haversineM(latlng, _current.points[i]);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  _setHoverAt(bestIdx);
}
