// task_12_map_component.js
// Gestione isolata della mappa Leaflet, dei marker e delle polilinee geografiche

import { $ } from './task_03_utils.js';

let _map = null;
let _markerGroup = null;
let _routePolyline = null;
let _clickCallback = null;

// ── Sync grafico altimetrico ↔ mappa (task_18) ───────────────────────────────
// Additivo puro: nessuna modifica alla logica esistente di marker/drag/
// eliminazione tappe. _hoverMarker è un semplice cerchietto mostrato/nascosto
// da task_18 quando l'utente muove il mouse sul grafico (hover grafico→mappa).
// _polylineHoverCallback è invece per l'hover inverso (mappa→grafico):
// drawRoute() aggancia mousemove/mouseout sulla NUOVA polyline ad ogni
// ridisegno e li inoltra a questa callback, se registrata.
let _hoverMarker = null;
let _polylineHoverCallback = null;

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
    zoomSnap:        0.1,   // fit sub-livello preciso (era 0.5 → arrotondava per difetto)
    zoomDelta:       0.5,   // step tasti +/− invariato
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

/**
 * Disegna la polilinea del percorso sulla mappa.
 *
 * FIX freeze mobile: aggiunto smoothFactor: 3 (Douglas-Peucker nativo Leaflet).
 * Con tracce OSRM da 3000-4000 punti, Leaflet senza smoothFactor tenta di
 * renderizzare tutti i segmenti in un singolo paint sincrono, bloccando il
 * thread principale per diversi secondi su mobile.
 * smoothFactor: 3 riduce i punti effettivamente disegnati in base allo zoom
 * corrente (a zoom basso: da 3543 → ~200-400 segmenti visibili), eliminando
 * il freeze. La qualità visiva a zoom alto resta intatta: Leaflet ricalcola
 * dinamicamente ad ogni cambio di zoom.
 */
export function drawRoute(points, color = '#1e5aa8') {
  if (_routePolyline) { _map.removeLayer(_routePolyline); }
  if (!points || points.length === 0) return;
  const latLngs = points.map(p => [p.lat, p.lon]);
  _routePolyline = L.polyline(latLngs, {
    color,
    weight:       5,
    opacity:      0.8,
    smoothFactor: 3,   // Douglas-Peucker adattivo per zoom — elimina freeze su mobile
  }).addTo(_map);

  // Hover mappa→grafico (task_18): additivo, non tocca marker/drag/eliminazione.
  // Va riagganciato ad ogni drawRoute() perché _routePolyline viene ricreata.
  _routePolyline.on('mousemove', (e) => {
    if (_polylineHoverCallback) _polylineHoverCallback({ lat: e.latlng.lat, lon: e.latlng.lng });
  });
  _routePolyline.on('mouseout', () => {
    if (_polylineHoverCallback) _polylineHoverCallback(null);
  });
}

/**
 * Registra la callback per l'hover mappa→grafico (task_18_altitude_chart.js).
 * @param {Function|null} cb - (latlng:{lat,lon}|null) => void
 */
export function onPolylineHover(cb) { _polylineHoverCallback = cb; }

/**
 * Mostra/aggiorna un piccolo marker circolare sulla mappa nel punto
 * corrispondente all'hover sul grafico altimetrico (task_18).
 * @param {{lat:number, lon:number}} latlon
 */
export function showHoverMarker(latlon) {
  if (!_map || !latlon) return;
  const ll = [latlon.lat, latlon.lon];
  if (!_hoverMarker) {
    _hoverMarker = L.circleMarker(ll, {
      radius: 7, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1,
    }).addTo(_map);
  } else {
    _hoverMarker.setLatLng(ll);
    if (!_map.hasLayer(_hoverMarker)) _hoverMarker.addTo(_map);
  }
}

/** Nasconde il marker di hover del grafico altimetrico (task_18). */
export function hideHoverMarker() {
  if (_hoverMarker && _map?.hasLayer(_hoverMarker)) _map.removeLayer(_hoverMarker);
}

/**
 * Calcola il padding asimmetrico per fitBounds.
 * La goccia Leaflet si estende 41px SOPRA l'anchor geografico, nulla sotto:
 *   paddingTopLeft     → top=48px (41px goccia + 7px respiro), left=dinamico
 *   paddingBottomRight → bottom=28px (20px attribution bar + 8px respiro), right=dinamico
 * Questo elimina il 36px di padding inferiore sprecato che riduceva lo zoom
 * sui percorsi nord-sud.
 *
 * FIX (timing/lentina): la larghezza non viene più letta da map.getSize().
 * map.getSize() è un valore CACHATO da Leaflet e viene aggiornato solo dopo
 * che invalidateSize() ha già girato e il browser ha completato il reflow —
 * se il contenitore mappa ha appena cambiato dimensione (apertura/chiusura
 * pannelli, dashboard, decision-panel: tutte cose che fullStateRefresh() fa
 * PRIMA di chiamare il fit) map.getSize() può restituire ancora il valore
 * vecchio nello stesso tick sincrono. Questo costringeva ad aggiungere
 * setTimeout arbitrari per "aspettare" che il reflow fosse completato
 * nel frattempo — fragile e fonte sia del rallentamento a scatti in
 * caricamento, sia della "lentina" (bottone Centra mappa) che sembrava non
 * rispondere quando il valore letto era stantio.
 * getBoundingClientRect() invece legge SEMPRE la dimensione reale e attuale
 * del DOM, in modo sincrono, senza dipendere da cache interne di Leaflet o
 * da invalidateSize() pregresso. Eliminato così il bisogno di delay/retry.
 *
 * @param {L.Map} map
 * @returns {{ paddingTopLeft: L.Point, paddingBottomRight: L.Point }}
 */
function _smartPad(map) {
  const rect  = map.getContainer().getBoundingClientRect();
  const width = rect.width || map.getSize().x; // fallback estremo: container non ancora nel DOM
  const padH  = Math.max(12, Math.min(20, Math.round(width * 0.04)));
  return {
    paddingTopLeft:     L.point(padH, 48),   // [left, top]
    paddingBottomRight: L.point(padH, 28),   // [right, bottom] — 20px attribution + 8px respiro
  };
}

export function fitMapToBounds(bounds) {
  if (!_map || !bounds) return;
  // invalidateSize() sincrono immediatamente prima del fit: garantisce che
  // Leaflet ricalcoli la propria vista interna sulle dimensioni reali attuali
  // (lette via _smartPad → getBoundingClientRect, non dalla cache). Nessun
  // setTimeout necessario: niente qui dipende più dal timing del reflow.
  _map.invalidateSize();
  _map.fitBounds(bounds, { ..._smartPad(_map), maxZoom: 14 });
}

export function fitMapToRoute() {
  if (_routePolyline) {
    _map.invalidateSize();
    _map.fitBounds(_routePolyline.getBounds(), { ..._smartPad(_map), maxZoom: 14 });
  }
}

/**
 * Espone il padding asimmetrico calcolato da _smartPad come export pubblico,
 * così task_01 può usarlo senza duplicare la logica.
 * Unica fonte di verità per paddingTopLeft / paddingBottomRight.
 *
 * @param {L.Map} map
 * @returns {{ paddingTopLeft: L.Point, paddingBottomRight: L.Point }}
 */
export function getSmartPad(map) { return _smartPad(map); }

export function renderWaypoints(wps, onMarkerDragEnd, callbacks = {}) {
  // Difesa: se _markerGroup è stato rimosso dalla mappa, lo re-aggancia
  if (_map && _markerGroup && !_map.hasLayer(_markerGroup)) {
    _markerGroup.addTo(_map);
  }
  clearMarkers();
  if (!wps || wps.length === 0) return;

  wps.forEach((wp, idx) => {
    const isFirst  = idx === 0;
    const isLast   = idx === wps.length - 1;
    const num      = idx + 1;                                  // 1, 2, 3 …
    const roleStr  = isFirst ? 'Partenza' : isLast ? 'Arrivo' : 'Tappa';
    const label    = `${num} — ${roleStr}`;

    // draggable: false — il trascinamento è disabilitato intenzionalmente.
    // Per spostare una tappa: rimuoverla (hover + bottone rosso su desktop,
    // mirino + bottone rosso su mobile) e reinserirla tramite il mirino/click.
    const marker = L.marker([wp.lat, wp.lon], {
      icon: _numberIcon(num),
      draggable: false,
      title: wp.name || label,
    });

    // ── Hover desktop → bottone rosso Elimina ────────────────────────────────
    // Sostituisce il vecchio long-press: su desktop il mouse ha già hover
    // reale sul marker (hit-test nativo Leaflet), niente calcolo di prossimità
    // in pixel come su mobile. Il popup nativo segue da solo pan/zoom.
    // callbacks.onDeleteRequest(idx, wp, label) contiene la business logic
    // (conferma Swal + rimozione), identica a quella usata dal bottone
    // crosshair mobile: un'unica funzione di eliminazione, due trigger.
    if (callbacks.onDeleteRequest && wps.length > 2) {
      let _closeTimer = null;
      const canDeleteHtml = `
        <div style="text-align:center;">
          <div style="font-weight:600;margin-bottom:6px;">${wp.name || label}</div>
          <button class="rc-marker-delete-btn"
            style="background:#e53e3e;color:#fff;border:none;border-radius:8px;
                   padding:6px 12px;cursor:pointer;font-size:12px;font-weight:700;">
            🔴 Elimina
          </button>
        </div>`;

      marker.bindPopup(canDeleteHtml, { closeButton: false, autoClose: false, maxWidth: 200 });

      const openPopup = () => {
        if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
        marker.openPopup();
        // Aggancia il click del bottone dopo che il popup è nel DOM
        setTimeout(() => {
          const popupEl = marker.getPopup()?.getElement();
          const btn = popupEl?.querySelector('.rc-marker-delete-btn');
          if (btn && !btn._rcBound) {
            btn._rcBound = true;
            btn.addEventListener('click', async (ev) => {
              L.DomEvent.stopPropagation(ev);
              marker.closePopup();
              await callbacks.onDeleteRequest(idx, wp, label);
            });
            // Mantiene il popup aperto se il mouse è sopra al bottone/popup stesso
            popupEl.addEventListener('mouseenter', () => { if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; } });
            popupEl.addEventListener('mouseleave', scheduleClose);
          }
        }, 0);
      };
      const scheduleClose = () => {
        _closeTimer = setTimeout(() => { marker.closePopup(); _closeTimer = null; }, 200);
      };

      marker.on('mouseover', openPopup);
      marker.on('mouseout',  scheduleClose);
    } else {
      // Meno di 3 tappe: eliminazione non consentita (minimo 2), mostra solo il nome.
      marker.bindTooltip(wp.name || label, { direction: 'top', offset: [0, -34] });
    }

    _markerGroup.addLayer(marker);
  });
}

// [CHECKP_TASK_10] hash: v23.0_altitude_hover_sync
// [ELEVAZIONE+GRAFICO] v23.0: aggiunte showHoverMarker/hideHoverMarker/onPolylineHover +
//          listener mousemove/mouseout sulla polyline in drawRoute() per il sync col
//          grafico altimetrico (task_18). Additivo puro: nessuna riga toccata della
//          logica esistente di marker/drag/eliminazione tappe.
