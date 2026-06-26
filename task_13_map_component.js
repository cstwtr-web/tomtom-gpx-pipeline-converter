// task_13_map_component.js
// Gestione isolata della mappa Leaflet, dei marker e delle polilinee geografiche

import { $ } from './task_03_utils.js';

let _map = null;
let _markerGroup = null;
let _routePolyline = null;
let _originalPolyline = null;
let _clickCallback = null;

// Goccia Leaflet standard — identica per tutte le tappe.
// Semplice, riconoscibile, nessun divIcon custom che richiede CSS aggiuntivo.
const _defaultIcon = L.icon({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize:    [25, 41],
  iconAnchor:  [12, 41],
  popupAnchor: [1, -34],
  shadowSize:  [41, 41],
});

/**
 * Inizializza la mappa Leaflet sul container specificato
 */
export function initMap(containerId, options = {}) {
  if (_map) return _map;

  const defaultCenter = [45.4642, 9.1900]; // Centro predefinito (area Magenta/Milano)
  _map = L.map(containerId, {
    zoomControl:     false,
    dragging:        !L.Browser.mobile, // su mobile: drag solo con due dita (task_15 gesture handler)
    tap:             false,             // disabilita tap Leaflet — gestito da task_15
    scrollWheelZoom: true,
    boxZoom:         false,             // Shift+Click riservato a "Tappa intermedia" (task_15)
    zoomSnap:        0.5,              // zoom intermedi (12.5, 13.5…) — fitBounds più preciso
    zoomDelta:       0.5,              // bottoni +/- spostano di mezzo livello
    ...options
  }).setView(defaultCenter, 10);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(_map);

  _markerGroup = L.layerGroup().addTo(_map);

  // Gestione dell'evento click sulla mappa
  _map.on('click', (e) => {
    if (_clickCallback) {
      _clickCallback(e.latlng.lat, e.latlng.lng);
    }
  });

  return _map;
}

/** Restituisce l'istanza nativa di Leaflet */
export function getMapInstance() {
  return _map;
}

/** Configura la funzione di callback da eseguire al click sulla mappa */
export function onMapClick(callback) {
  _clickCallback = callback;
}

/** Rimuove tutti i marker correnti dalla mappa */
export function clearMarkers() {
  if (_markerGroup) _markerGroup.clearLayers();
}

/** Disegna la linea del percorso ottimizzato sulla mappa */
export function drawRoute(points, color = '#1e5aa8') {
  if (_routePolyline) {
    _map.removeLayer(_routePolyline);
  }
  if (!points || points.length === 0) return;

  const latLngs = points.map(p => [p.lat, p.lon]);
  _routePolyline = L.polyline(latLngs, { color, weight: 5, opacity: 0.8 }).addTo(_map);
}

/**
 * Disegna la traccia originale di confronto (es. da file GPX).
 * @param {Array<{lat,lon}>|null} points  - punti della traccia (null = rimuovi)
 * @param {boolean} [visible=true]        - se false rimuove senza ridisegnare
 * @param {string}  [color='#ff0000']     - colore polyline
 * @returns {L.Polyline|null}             - layer creato (o null se rimosso)
 */
export function drawOriginalTrack(points, visible = true, color = '#999') {
  if (_originalPolyline) {
    _map.removeLayer(_originalPolyline);
    _originalPolyline = null;
  }
  if (!points || points.length === 0 || !visible) return null;

  const latLngs = points.map(p => [p.lat, p.lon]);
  _originalPolyline = L.polyline(latLngs, { color, weight: 3, opacity: 0.4, dashArray: '4, 6' }).addTo(_map);
  return _originalPolyline;
}

/** Mostra o nasconde lo strato della traccia originale */
export function toggleOriginalLayer(visible) {
  if (!_originalPolyline) return;
  if (visible) {
    _originalPolyline.addTo(_map);
  } else {
    _map.removeLayer(_originalPolyline);
  }
}

/** Adatta l'inquadratura della mappa a dei confini specifici (bounds) */
export function fitMapToBounds(bounds) {
  if (!_map || !bounds) return;
  _map.fitBounds(bounds, { padding: [30, 30] });
}

/** Centra e zooma automaticamente la mappa sul percorso corrente */
export function fitMapToRoute() {
  if (_routePolyline) {
    _map.fitBounds(_routePolyline.getBounds(), { padding: [30, 30] });
  }
}

/** Rende i waypoint sulla mappa generando i marker trascinabili (draggable) */
export function renderWaypoints(wps, onMarkerDragEnd, callbacks = {}) {
  // Difesa: se _markerGroup è stato rimosso dalla mappa (es. da eachLayer esterno),
  // lo re-aggancia prima di aggiungere nuovi marker — altrimenti sono invisibili.
  if (_map && _markerGroup && !_map.hasLayer(_markerGroup)) {
    _markerGroup.addTo(_map);
  }
  clearMarkers();
  if (!wps || wps.length === 0) return;

  const LP_MS = 500; // long-press delay, identico a task_06

  wps.forEach((wp, idx) => {
    const icon = _defaultIcon; // goccia standard per tutte le tappe

    const isFirst = idx === 0;
    const isLast  = idx === wps.length - 1;
    const label   = isFirst ? 'A — Partenza' : isLast ? 'B — Arrivo' : `Tappa ${idx}`;

    const marker = L.marker([wp.lat, wp.lon], {
      icon: icon,
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
    // PC:     mousedown/mouseup via eventi Leaflet (funziona perfettamente)
    // Mobile: touchstart/end direttamente sul DOM element in capture phase,
    //         così preventDefault() blocca Leaflet PRIMA che emetta movestart.
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

      // ── Mobile: listener DOM nativi sul marker element ────────────────────
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
            e.preventDefault(); // blocca movestart Leaflet e menu contestuale
            _lpTimer = setTimeout(async () => {
              _lpTimer = null;
              marker.closePopup();
              _map.closePopup();
              marker.once('click', (ev2) => { L.DomEvent.stopPropagation(ev2); });
              try { navigator.vibrate?.(60); } catch (_) {}
              await callbacks.onLongPress(idx, wp, label);
            }, LP_MS);
          }, { passive: false, capture: true });

          el.addEventListener('touchend',    () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } }, { passive: true });
          el.addEventListener('touchcancel', () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } }, { passive: true });
          el.addEventListener('touchmove',   () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } }, { passive: true });
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