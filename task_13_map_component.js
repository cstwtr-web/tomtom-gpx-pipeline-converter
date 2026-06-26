// task_13_map_component.js
// Gestione isolata della mappa Leaflet, dei marker e delle polilinee geografiche

import { $ } from './task_03_utils.js';

let _map = null;
let _markerGroup = null;
let _routePolyline = null;
let _originalPolyline = null;
let _clickCallback = null;

/**
 * Usa il PNG originale di Leaflet come sfondo e sovrappone la lettera
 * esattamente sul pallino circolare della goccia (top ≈ 4 px, centrato).
 * La shadow PNG viene tenuta separata così non interferisce con il testo.
 * Il tint colore (verde/rosso/blu) è applicato via CSS filter senza
 * caricare asset aggiuntivi.
 */
const _ICON_BASE = 'https://unpkg.com/leaflet@1.9.4/dist/images/';

function _letterIcon(letter, isFirst, isLast) {
  const filter = isFirst
    ? 'hue-rotate(130deg) saturate(1.6) brightness(0.9)'    // → verde
    : isLast
      ? 'hue-rotate(310deg) saturate(2)   brightness(0.85)' // → rosso
      : '';                                                  // → blu default

  return L.divIcon({
    className: '',  // disabilita il bordo bianco che Leaflet aggiunge di default
    html: `
      <div style="position:relative;width:25px;height:41px;">
        <!-- Ombra -->
        <img src="${_ICON_BASE}marker-shadow.png"
             style="position:absolute;top:12px;left:-6px;width:41px;height:41px;
                    pointer-events:none;opacity:.5;" />
        <!-- Goccia PNG con eventuale tint colore -->
        <img src="${_ICON_BASE}marker-icon-2x.png"
             style="position:absolute;top:0;left:0;width:25px;height:41px;
                    ${filter ? `filter:${filter};` : ''}
                    pointer-events:none;" />
        <!-- Lettera sovrapposta al pallino (top ~4px, centrata nei 25px) -->
        <span style="
          position:absolute;
          top:4px;left:0;width:25px;
          text-align:center;
          font:700 10px/1 system-ui,sans-serif;
          color:#fff;
          text-shadow:0 0 3px rgba(0,0,0,.8),0 1px 2px rgba(0,0,0,.6);
          pointer-events:none;
          user-select:none;">
          ${letter}
        </span>
      </div>`,
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
    const letter   = String.fromCharCode(65 + idx);           // A, B, C, D …
    const roleStr  = isFirst ? 'Partenza' : isLast ? 'Arrivo' : 'Tappa';
    const label    = `${letter} — ${roleStr}`;

    // draggable: false — il trascinamento è disabilitato intenzionalmente.
    // Per spostare una tappa: rimuoverla con long-press e reinserirla
    // tramite il mirino/crocicchio o click sulla mappa.
    const marker = L.marker([wp.lat, wp.lon], {
      icon: _letterIcon(letter, isFirst, isLast),
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
