// task_13_map_component.js
// Gestione isolata della mappa Leaflet, dei marker e delle polilinee geografiche

import { $ } from './task_03_utils.js';

let _map = null;
let _markerGroup = null;
let _routePolyline = null;
let _originalPolyline = null;
let _clickCallback = null;

// Icone ed elementi grafici per i marker sulla mappa
const _ICONS = {
  start: L.divIcon({ className: 'map-icon-start', html: '▶', iconSize: [24, 24], iconAnchor: [12, 12] }),
  end:   L.divIcon({ className: 'map-icon-end',   html: '🏁', iconSize: [24, 24], iconAnchor: [12, 12] }),
  via:   L.divIcon({ className: 'map-icon-via',   html: '●', iconSize: [16, 16], iconAnchor: [8, 8] })
};

/**
 * Inizializza la mappa Leaflet sul container specificato
 */
export function initMap(containerId, options = {}) {
  if (_map) return _map;

  const defaultCenter = [45.4642, 9.1900]; // Centro predefinito (area Magenta/Milano)
  _map = L.map(containerId, {
    zoomControl: false,
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
 */
export function drawOriginalTrack(points, visible = true, color = '#ff0000') {
  if (_originalPolyline) {
    _map.removeLayer(_originalPolyline);
    _originalPolyline = null;
  }
  if (!points || points.length === 0 || !visible) return;

  const latLngs = points.map(p => [p.lat, p.lon]);
  _originalPolyline = L.polyline(latLngs, { color, weight: 3, opacity: 0.5, dashArray: '5, 10' }).addTo(_map);
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
export function renderWaypoints(wps, onMarkerDragEnd) {
  clearMarkers();
  if (!wps || wps.length === 0) return;

  wps.forEach((wp, idx) => {
    let icon = _ICONS.via;
    if (idx === 0) icon = _ICONS.start;
    else if (idx === wps.length - 1) icon = _ICONS.end;

    const marker = L.marker([wp.lat, wp.lon], {
      icon: icon,
      draggable: true,
      title: wp.name || `Tappa ${idx}`
    });

    if (onMarkerDragEnd) {
      marker.on('dragend', (e) => {
        const newLatLng = e.target.getLatLng();
        onMarkerDragEnd(idx, newLatLng.lat, newLatLng.lng);
      });
    }

    marker.bindPopup(`<b>${wp.name || `Tappa ${idx}`}</b>`);
    _markerGroup.addLayer(marker);
  });
}