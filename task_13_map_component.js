// task_13_map_component.js
// Gestione isolata della mappa Leaflet, dei marker e delle polilinee geografiche

import { $ } from './task_03_utils.js';

let _map = null;
let _markerGroup = null;
let _routePolyline = null;
let _originalPolyline = null;
let _clickCallback = null;

/**
 * Goccia SVG vettoriale identica allo shape Leaflet standard.
 * - Pallino centrale RIMOSSO
 * - Numero progressivo (1, 2, 3…) posizionato esattamente dove era il pallino
 * - Colore pieno: verde (#22c55e) per Partenza, rosso (#ef4444) per Arrivo,
 *   blu (#1e5aa8) per le tappe intermedie
 * - Ombra via SVG drop-shadow filter (nessun asset PNG esterno)
 * - Font size adattivo: ≤9 per numeri a 2 cifre, 11 per cifra singola
 */
function _numberIcon(num, isFirst, isLast) {
  const color  = isFirst ? '#22c55e' : isLast ? '#ef4444' : '#1e5aa8';
  const stroke = isFirst ? '#16a34a' : isLast ? '#b91c1c' : '#1447a0';
  const label  = String(num);
  const fs     = label.length > 1 ? 9 : 11;   // font-size adattivo per 2 cifre

  // ViewBox 25×41 — identico alle dimensioni del marker PNG Leaflet.
  // Path: goccia standard ricostruita in SVG (stessa silhouette).
  // Il cerchio interno (pallino bianco originale) è OMESSO intenzionalmente.
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 25 41" width="25" height="41"
     style="overflow:visible;filter:drop-shadow(1px 2px 3px rgba(0,0,0,.45));">
  <!-- Goccia: shape identico al marker Leaflet, colore pieno, bordo scuro -->
  <path d="M12.5 0
           C5.596 0 0 5.596 0 12.5
           C0 21.875 12.5 41 12.5 41
           C12.5 41 25 21.875 25 12.5
           C25 5.596 19.404 0 12.5 0Z"
        fill="${color}" stroke="${stroke}" stroke-width="1"/>
  <!-- Numero al posto del pallino (centro ottico ≈ 12.5, 13) -->
  <text x="12.5" y="17"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="system-ui,Arial,sans-serif"
        font-size="${fs}"
        font-weight="700"
        fill="#ffffff"
        style="pointer-events:none;user-select:none;">${label}</text>
</svg>`.trim();

  return L.divIcon({
    className: '',   // rimuove il bordo bianco default di Leaflet
    html: svg,
    iconSize:    [25, 41],
    iconAnchor:  [12, 41],
    popupAnchor: [1, -34],
  });
}

export function initMap(containerId, options = {}) {
  if (_map) return _map;

  const defaultCenter = [45.4642, 9.1900];
  _map = L.map(containerId, {
    zoomControl:     false,
    dragging:        !L.Browser.mobile,
    tap:             false,
    scrollWheelZoom: true,
    boxZoom:         false,
    zoomSnap:        0.5,
    zoomDelta:       0.5,
    ...options
  }).setView(defaultCenter, 10);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(_map);

  _markerGroup = L.layerGroup().addTo(_map);

  _map.on('click', (e) => {
    if (_clickCallback) _clickCallback(e.latlng.lat, e.latlng.lng);
  });

  return _map;
}

export function getMapInstance() { return _map; }
export function onMapClick(callback) { _clickCallback = callback; }

export function clearMarkers() {
  if (_markerGroup) _markerGroup.clearLayers();
}

export function drawRoute(points, color = '#1e5aa8') {
  if (_routePolyline) { _map.removeLayer(_routePolyline); }
  if (!points || points.length === 0) return;
  const latLngs = points.map(p => [p.lat, p.lon]);
  _routePolyline = L.polyline(latLngs, { color, weight: 5, opacity: 0.8 }).addTo(_map);
}

export function drawOriginalTrack(points, visible = true, color = '#999') {
  if (_originalPolyline) { _map.removeLayer(_originalPolyline); _originalPolyline = null; }
  if (!points || points.length === 0 || !visible) return null;
  const latLngs = points.map(p => [p.lat, p.lon]);
  _originalPolyline = L.polyline(latLngs, { color, weight: 3, opacity: 0.4, dashArray: '4, 6' }).addTo(_map);
  return _originalPolyline;
}

export function toggleOriginalLayer(visible) {
  if (!_originalPolyline) return;
  if (visible) { _originalPolyline.addTo(_map); } else { _map.removeLayer(_originalPolyline); }
}

export function fitMapToBounds(bounds) {
  if (!_map || !bounds) return;
  _map.fitBounds(bounds, { padding: [30, 30] });
}

export function fitMapToRoute() {
  if (_routePolyline) _map.fitBounds(_routePolyline.getBounds(), { padding: [30, 30] });
}

export function renderWaypoints(wps, onMarkerDragEnd, callbacks = {}) {
  // Difesa: se _markerGroup è stato rimosso dalla mappa, lo re-aggancia
  if (_map && _markerGroup && !_map.hasLayer(_markerGroup)) {
    _markerGroup.addTo(_map);
  }
  clearMarkers();
  if (!wps || wps.length === 0) return;

  const LP_MS = 500;

  wps.forEach((wp, idx) => {
    const isFirst  = idx === 0;
    const isLast   = idx === wps.length - 1;
    const num      = idx + 1;                                  // 1, 2, 3 …
    const roleStr  = isFirst ? 'Partenza' : isLast ? 'Arrivo' : 'Tappa';
    const label    = `${num} — ${roleStr}`;

    // draggable: false — il trascinamento è disabilitato intenzionalmente.
    // Per spostare una tappa: rimuoverla con long-press e reinserirla
    // tramite il mirino/crocicchio o click sulla mappa.
    const marker = L.marker([wp.lat, wp.lon], {
      icon: _numberIcon(num, isFirst, isLast),
      draggable: false,
      title: wp.name || label,
    });

    // ── Long-press → rimozione tappa ─────────────────────────────────────────
    // PC:     mousedown/mouseup via eventi Leaflet
    // Mobile: listener DOM nativi in capture phase, preventDefault() blocca
    //         Leaflet prima che processi il touch.
    if (callbacks.onLongPress) {
      let _lpTimer = null;

      // ── PC ────────────────────────────────────────────────────────────────
      marker.on('mousedown', (ev) => {
        const oe = ev.originalEvent;
        if (oe.button !== 0) return;
        _lpTimer = setTimeout(async () => {
          _lpTimer = null;
          marker.closePopup();
          _map.closePopup();
          marker.once('click', (e) => { L.DomEvent.stopPropagation(e); });
          await callbacks.onLongPress(idx, wp, label);
        }, LP_MS);
      });
      marker.on('mouseup mousemove', () => {
        if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
      });

      // ── Mobile ────────────────────────────────────────────────────────────
      marker.on('add', () => {
        setTimeout(() => {
          const el = marker.getElement();
          if (!el) return;
          el.style.touchAction        = 'none';
          el.style.webkitTouchCallout = 'none';
          el.style.userSelect         = 'none';
          el.style.webkitUserSelect   = 'none';
          el.addEventListener('contextmenu', (e) => e.preventDefault());

          el.addEventListener('touchstart', (e) => {
            e.preventDefault();
            _lpTimer = setTimeout(async () => {
              _lpTimer = null;
              marker.closePopup();
              _map.closePopup();
              marker.once('click', (ev2) => { L.DomEvent.stopPropagation(ev2); });
              try { navigator.vibrate?.(60); } catch (_) {}
              await callbacks.onLongPress(idx, wp, label);
            }, LP_MS);
          }, { passive: false, capture: true });

          const _cancel = () => {
            if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
          };
          el.addEventListener('touchend',    _cancel, { passive: true });
          el.addEventListener('touchcancel', _cancel, { passive: true });
          el.addEventListener('touchmove',   _cancel, { passive: true });
        }, 0);
      });
    }

    const hintHtml = wps.length > 2 && callbacks.onLongPress
      ? `<div style="margin-top:6px;font-size:10px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:5px;">🖐️ Tieni premuto per rimuovere</div>`
      : '';

    marker.bindPopup(
      `<b>${wp.name || label}</b><br><span style="color:#6b7280;font-size:11px;">${label}</span>${hintHtml}`,
      { maxWidth: 220 }
    );
    _markerGroup.addLayer(marker);
  });
}
