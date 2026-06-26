// task_13_map_component.js
// Gestione isolata della mappa Leaflet, dei marker e delle polilinee geografiche

import { $ } from './task_03_utils.js';

let _map = null;
let _markerGroup = null;
let _routePolyline = null;
let _originalPolyline = null;
let _clickCallback = null;

/**
 * Goccia standard Leaflet (PNG originale con gradienti naturali) +
 * dischetto di mascheratura + numero progressivo sovrapposto.
 *
 * Stack 4 layer (position:absolute):
 *   1. PNG marker-shadow.png   → ombra originale
 *   2. PNG marker-icon-2x.png  → goccia originale invariata (blu, gradienti)
 *   3. <div> dischetto blu     → maschera il pallino bianco raster del PNG
 *   4. <span> numero           → testo bianco centrato sul dischetto
 *
 * Il dischetto usa lo stesso blu profondo della goccia attorno al pallino
 * (~#2a6ab0): la maschera è invisibile, il numero sembra inciso nella goccia.
 *
 * Posizione pallino nel PNG 25×41: centro ≈ (12, 13), raggio ≈ 6-7px.
 * Dischetto: top:6px left:5px width:14px height:14px → copre il bianco esatto.
 * Font-size adattivo: 10px per 1 cifra, 8px per 2 cifre (≥10 tappe).
 */
const _ICON_BASE  = 'https://unpkg.com/leaflet@1.9.4/dist/images/';
const _DISC_COLOR = '#2a6ab0';   // blu campionato dalla goccia attorno al pallino

// Dischetto: 16×16px (era 14×14) — top:5px left:4px per centrare sul pallino bianco.
// Font: 12px (1 cifra) / 9px (2+ cifre). Rapporto disc/font invariato → leggibilità ok.
function _numberIcon(num) {
  const label = String(num);
  const fs    = label.length > 1 ? 9 : 12;

  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:25px;height:41px;">

        <!-- LAYER 1: ombra originale Leaflet -->
        <img src="${_ICON_BASE}marker-shadow.png"
             style="position:absolute;top:12px;left:-6px;
                    width:41px;height:41px;
                    pointer-events:none;opacity:.5;" />

        <!-- LAYER 2: goccia PNG originale — gradienti e luci invariati -->
        <img src="${_ICON_BASE}marker-icon-2x.png"
             style="position:absolute;top:0;left:0;
                    width:25px;height:41px;
                    pointer-events:none;" />

        <!-- LAYER 3: dischetto che maschera il pallino bianco raster -->
        <div style="
          position:absolute;
          top:5px;left:4px;
          width:16px;height:16px;
          border-radius:50%;
          background:${_DISC_COLOR};
          pointer-events:none;"></div>

        <!-- LAYER 4: numero centrato sul dischetto -->
        <span style="
          position:absolute;
          top:5px;left:4px;
          width:16px;height:16px;
          display:flex;align-items:center;justify-content:center;
          font:700 ${fs}px/1 system-ui,Arial,sans-serif;
          color:#fff;
          text-shadow:0 1px 2px rgba(0,0,0,.5);
          pointer-events:none;
          user-select:none;">${label}</span>

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
    const num      = idx + 1;                                  // 1, 2, 3 …
    const roleStr  = isFirst ? 'Partenza' : isLast ? 'Arrivo' : 'Tappa';
    const label    = `${num} — ${roleStr}`;

    // draggable: false — il trascinamento è disabilitato intenzionalmente.
    // Per spostare una tappa: rimuoverla con long-press e reinserirla
    // tramite il mirino/crocicchio o click sulla mappa.
    const marker = L.marker([wp.lat, wp.lon], {
      icon: _numberIcon(num),
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
