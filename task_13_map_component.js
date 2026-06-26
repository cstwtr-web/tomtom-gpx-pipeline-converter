// task_13_map_component.js
// Gestione isolata della mappa Leaflet, dei marker e delle polilinee geografiche

import { $ } from './task_03_utils.js';

let _map = null;
let _markerGroup = null;
let _routePolyline = null;
let _originalPolyline = null;
let _clickCallback = null;

// Goccia Leaflet standard — identica per tutte le tappe.
const _defaultIcon = L.icon({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize:    [25, 41],
  iconAnchor:  [12, 41],
  popupAnchor: [1, -34],
  shadowSize:  [41, 41],
});

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
    const isFirst = idx === 0;
    const isLast  = idx === wps.length - 1;
    const label   = isFirst ? 'A — Partenza' : isLast ? 'B — Arrivo' : `Tappa ${idx}`;

    const marker = L.marker([wp.lat, wp.lon], {
      icon: _defaultIcon,
      draggable: true,
      title: wp.name || label,
    });

    if (onMarkerDragEnd) {
      marker.on('dragend', (e) => {
        const newLatLng = e.target.getLatLng();
        onMarkerDragEnd(idx, newLatLng.lat, newLatLng.lng);
      });
    }

    // ── Long-press → rimozione tappa ─────────────────────────────────────────
    // PC:     mousedown/mouseup via eventi Leaflet
    // Mobile: listener DOM nativi in capture phase sul marker element.
    //         Al touchstart si disabilita temporaneamente il draggable per
    //         impedire che Leaflet avvii il drag durante i 500ms di attesa.
    //         I listener vengono ri-agganciati dopo ogni dragend perché
    //         Leaflet può ri-creare l'elemento DOM del marker dopo un drag.
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
      marker.on('mouseup', () => {
        if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
      });
      marker.on('drag movestart', () => {
        if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
      });

      // ── Mobile ────────────────────────────────────────────────────────────
      function _attachTouchListeners() {
        const el = marker.getElement();
        if (!el || el._lpAttached) return; // evita doppio attach
        el._lpAttached = true;

        el.style.touchAction        = 'none';
        el.style.webkitTouchCallout = 'none';
        el.style.userSelect         = 'none';
        el.style.webkitUserSelect   = 'none';
        el.addEventListener('contextmenu', (e) => e.preventDefault());

        el.addEventListener('touchstart', (e) => {
          e.preventDefault();
          // Disabilita drag durante l'attesa: impedisce a Leaflet di avviare
          // il trascinamento nei 500ms prima che scatti il long-press.
          marker.dragging?.disable();
          _lpTimer = setTimeout(async () => {
            _lpTimer = null;
            marker.dragging?.enable();
            marker.closePopup();
            _map.closePopup();
            marker.once('click', (ev2) => { L.DomEvent.stopPropagation(ev2); });
            try { navigator.vibrate?.(60); } catch (_) {}
            await callbacks.onLongPress(idx, wp, label);
          }, LP_MS);
        }, { passive: false, capture: true });

        const _cancel = () => {
          if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
          marker.dragging?.enable();
        };
        el.addEventListener('touchend',    _cancel, { passive: true });
        el.addEventListener('touchcancel', _cancel, { passive: true });
        el.addEventListener('touchmove',   _cancel, { passive: true });
      }

      // Aggancia al primo render e dopo ogni drag (Leaflet può ricreare l'elemento)
      marker.on('add',     () => { setTimeout(_attachTouchListeners, 0); });
      marker.on('dragend', () => { setTimeout(_attachTouchListeners, 0); });
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
