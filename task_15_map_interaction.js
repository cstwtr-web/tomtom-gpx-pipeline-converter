// task_15_map_interaction.js
// Interazione utente con la mappa: init Leaflet + handler custom (click mode RC,
// contextmenu marker, gesture a due dita, resize), crosshair, bottom sheet
// mobile e inserimento waypoint via click/centro mappa.
//
// Estratto da task_01_main.js (refactor D1). Pattern di iniezione dipendenze
// identico a task_16/task_17: initMapInteraction(deps) chiamato una sola volta
// in boot(), zero monkey-patching, zero globali.
//
// NOTA STORICA: l'header della funzione initMap() era stato perso in un
// refactor precedente (il corpo viveva come blocco "orfano" top-level in
// task_01_main.js, righe ~173-249 dell'epoca, con `map` mai dichiarata —
// ReferenceError certo al caricamento del modulo). Ricostruita qui recuperando
// l'istanza mappa da task_13_map_component.initMap() e collegandola allo
// state condiviso tramite state.setMap().

import { $, haversineM } from './task_03_utils.js';
import {
  initMap as _t13InitMap,
  fitMapToBounds as _t13FitMapToBounds,
} from './task_13_map_component.js';

// ── Stato locale del modulo ──────────────────────────────────────────────────
let _mapClickModeActive = false;

// Debounce del primo fitBounds: in un singolo go() fullStateRefresh() può
// essere chiamato 2-3 volte in sequenza (pre-consenso, post-riduzione,
// post-redistribuzione trkpt). Senza debounce ogni chiamata armava il
// proprio setTimeout + invalidateSize, causando fit multipli "a scatti"
// durante il caricamento (FIX rallentamento caricamento mappa).
let _fitDebounceTimer = null;

// Dipendenze iniettate da initMapInteraction()
let _state, _addLog, _reverseGeocode, _mapState, _fullStateRefresh, _invalidateWpCache;

/**
 * Inizializza il modulo di interazione mappa. Da chiamare una sola volta in
 * boot(), DOPO che state/addLog/reverseGeocode/mapState/fullStateRefresh e
 * _invalidateWpCache sono disponibili.
 */
export function initMapInteraction(deps) {
  _state              = deps.state;
  _addLog             = deps.addLog;
  _reverseGeocode     = deps.reverseGeocode;
  _mapState           = deps.mapState;
  _fullStateRefresh   = deps.fullStateRefresh;
  _invalidateWpCache  = deps.invalidateWpCache;
}

/** True se la modalità "clicca sulla mappa per aggiungere una tappa" è attiva. */
export function isMapClickModeActive() {
  return _mapClickModeActive;
}

// ── initMap ───────────────────────────────────────────────────────────────────
// Istanzia la mappa Leaflet tramite il modulo isolato task_13 e collega tutti
// gli handler custom (click mode RC, contextmenu marker, gesture a due dita,
// resize). Va chiamata una sola volta, idealmente in boot().
export function initMap() {
  const map = _t13InitMap('mapPreview');
  _state.setMap(map);

  // ── Map Click Mode handler ────────────────────────────────────────────────
  if (map._rcClickHandler) map.off('click', map._rcClickHandler);
  map._rcClickHandler = async function(e) {
    if (!_mapClickModeActive) return;
    if (map._rcIgnoreUntil && Date.now() < map._rcIgnoreUntil) return;

    // ── PC (pointer: fine): click diretto sulla mappa, niente bottom sheet ──
    const isMouseDevice = window.matchMedia('(pointer: fine)').matches;
    if (isMouseDevice) {
      const { lat, lng } = e.latlng;
      if (e.originalEvent && e.originalEvent.shiftKey) {
        // Shift+click → Tappa intermedia (snap strada)
        _addLog(`🔗 Tappa intermedia (snap): (${lat.toFixed(5)}, ${lng.toFixed(5)})`, 'info');
        await _insertWaypointAtLatLon(lat, lng, false);
      } else {
        // Click semplice → Aggiungi tappa (esatto)
        _addLog(`📍 Aggiungi tappa (esatto): (${lat.toFixed(5)}, ${lng.toFixed(5)})`, 'info');
        await _insertWaypointAtLatLon(lat, lng, true);
      }
      return;
    }

    // ── Touch (pointer: coarse): crosshair + bottom sheet gestiscono tutto ──
    const { lat, lng } = e.latlng;
    _addLog(`📍 Crosshair centrato: (${lat.toFixed(5)}, ${lng.toFixed(5)})`, 'dim');
  };
  map.on('click', map._rcClickHandler);

  // ── Blocco contextmenu globale su marker (capture phase, una sola volta) ──
  if (!map._rcContextMenuAdded) {
    const mapEl = $('mapPreview');
    mapEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.leaflet-marker-icon, .leaflet-marker-shadow')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, { capture: true, passive: false });
    map._rcContextMenuAdded = true;
  }

  // ── Two-finger gesture handler (mobile, una sola volta) ──────────────────
  if (!map._rcGestureAdded && L.Browser.mobile) {
    const _mapElG = $('mapPreview');
    _mapElG.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) map.dragging.enable();
    }, { passive: true });
    _mapElG.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) map.dragging.disable();
    }, { passive: true });
    _mapElG.addEventListener('touchcancel', () => {
      map.dragging.disable();
    }, { passive: true });
    map._rcGestureAdded = true;
  }

  const editCtrl = $('map-edit-ctrl');
  if (editCtrl) editCtrl.style.display = 'flex';

  const editBtn = $('map-edit-btn');
  if (editBtn && !editBtn._rcClickAdded) {
    editBtn.addEventListener('click', () => {
      map._rcIgnoreUntil = Date.now() + 400;
    });
    editBtn._rcClickAdded = true;
  }

  requestAnimationFrame(() => {
    setTimeout(() => map.invalidateSize(), 80);
    if (!map._rcResizeListenerAdded) {
      window.addEventListener('resize', () => {
        clearTimeout(map._rcResizeTimer);
        map._rcResizeTimer = setTimeout(() => map.invalidateSize(), 120);
      });
      map._rcResizeListenerAdded = true;
    }
  });
}

// ── _applyMapView ─────────────────────────────────────────────────────────────
// Unica fonte di verità per decidere/applicare la view della mappa (zoom/pan).
// Va chiamata come ULTIMO step di fullStateRefresh(), quando tutto il resto
// del DOM (lista tappe, dashboard, pannello decisioni) si è già stabilizzato,
// così Leaflet riceve dimensioni del contenitore definitive e non "rimbalza"
// indietro allo zoom di default.
//
// Tre casi, in ordine di priorità:
//   1. Prima visualizzazione per questa rotta (!_mapState.hasBeenFitted)
//      → fitBounds completo su tutto il percorso (debounced, vedi sotto).
//   2. Modifica puntuale in sospeso (_mapState.focusLatLon, impostato da
//      _insertWaypointAtLatLon o dalla rimozione tappa via marker)
//      → flyTo dolce su quel punto, MANTENENDO lo zoom corrente dell'utente.
//   3. Nessuno dei due → non si tocca la view: l'utente resta esattamente
//      dove si trovava.
//
// FIX rallentamento caricamento (debounce primo fit):
// go() può chiamare fullStateRefresh() 2-3 volte in sequenza nello stesso
// caricamento (pre-consenso → post-riduzione tappe → post-redistribuzione
// trkpt). Prima di questo fix, ogni chiamata armava un proprio
// invalidateSize() doppio + setTimeout(60ms) → fitBounds, quindi la mappa
// "scattava" più volte con bounds intermedi (calcolati su dati grezzi non
// ancora definitivi) prima di stabilizzarsi sul fit finale, qualche secondo
// dopo. Ora _mapState.hasBeenFitted passa a true SOLO quando il fit viene
// davvero eseguito: se arriva una nuova richiesta di fit mentre la
// precedente è ancora in coda, quella vecchia viene annullata e si aspetta
// solo l'ultima (bounds più recenti = quelli giusti).
export function _applyMapView() {
  const map = _state.getMap();
  if (!map) return;

  map.invalidateSize();

  if (!_mapState.hasBeenFitted) {
    const _bounds = _mapState.pendingBounds;
    if (!_bounds) return; // niente da inquadrare ancora: non segnare hasBeenFitted

    // Annulla un eventuale fit precedente non ancora eseguito: contano solo
    // i bounds più recenti (es. quelli post-routing OSRM, non quelli grezzi
    // pre-routing usati per il primo render provvisorio).
    if (_fitDebounceTimer) clearTimeout(_fitDebounceTimer);

    _fitDebounceTimer = setTimeout(() => {
      _fitDebounceTimer = null;
      _mapState.hasBeenFitted = true;
      try {
        map.invalidateSize();
        _t13FitMapToBounds(_mapState.pendingBounds);
      } catch (e) {}
    }, 60);
  } else if (_mapState.focusLatLon) {
    const { lat, lon, zoom } = _mapState.focusLatLon;
    _mapState.focusLatLon = null;
    try { map.flyTo([lat, lon], zoom ?? map.getZoom(), { duration: 0.4 }); } catch (e) {}
  }
  // altrimenti: nessun fitBounds/flyTo — la view dell'utente resta intatta
}

// ── Helper: chiude il pannello custom (div DOM, non L.popup) ─────────────────
function _rcCloseCustomPanel() {
  const map = _state.getMap();
  if (!map) return;
  const existing = map._rcActivePopup;
  if (existing) {
    if (existing instanceof HTMLElement) {
      existing.remove();
    } else {
      try { map.closePopup(existing); } catch (_) {}
    }
    map._rcActivePopup = null;
  }
}

// ── Crosshair + Bottom Sheet helpers ─────────────────────────────────────────
function _rcShowCrosshair() {
  const map = _state.getMap();
  if (!map) return;
  const container = map.getContainer();

  // Crosshair SVG fisso al centro della mappa
  let ch = document.getElementById('rc-crosshair');
  if (!ch) {
    ch = document.createElement('div');
    ch.id = 'rc-crosshair';
    ch.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:50%',
      'transform:translate(-50%,-60%)',   // -60% per stare sopra il pallino (come un pin)
      'z-index:900',
      'pointer-events:none',
      'transition:opacity .15s',
    ].join(';');
    ch.innerHTML = `<svg width="44" height="54" viewBox="0 0 44 54" xmlns="http://www.w3.org/2000/svg">
      <!-- ombra -->
      <ellipse cx="22" cy="51" rx="8" ry="3" fill="rgba(0,0,0,0.18)"/>
      <!-- linea verticale superiore -->
      <line x1="22" y1="2"  x2="22" y2="14" stroke="#e53e3e" stroke-width="2.5" stroke-linecap="round"/>
      <!-- linea verticale inferiore (al pallino) -->
      <line x1="22" y1="30" x2="22" y2="47" stroke="#e53e3e" stroke-width="2.5" stroke-linecap="round"/>
      <!-- linea orizzontale sinistra -->
      <line x1="2"  y1="22" x2="14" y2="22" stroke="#e53e3e" stroke-width="2.5" stroke-linecap="round"/>
      <!-- linea orizzontale destra -->
      <line x1="30" y1="22" x2="42" y2="22" stroke="#e53e3e" stroke-width="2.5" stroke-linecap="round"/>
      <!-- cerchio esterno -->
      <circle cx="22" cy="22" r="8" fill="none" stroke="#e53e3e" stroke-width="2.5"/>
      <!-- pallino centrale -->
      <circle cx="22" cy="22" r="3"  fill="#e53e3e"/>
    </svg>`;
    container.style.position = 'relative';
    container.appendChild(ch);
  }
  ch.style.opacity = '1';
}

function _rcRemoveCrosshair() {
  document.getElementById('rc-crosshair')?.remove();
}

function _rcShowBottomSheet(map) {
  let sheet = document.getElementById('rc-bottom-sheet');
  if (sheet) return;   // già presente

  sheet = document.createElement('div');
  sheet.id = 'rc-bottom-sheet';
  sheet.style.cssText = [
    'position:fixed',
    'bottom:0',
    'left:0',
    'right:0',
    'z-index:2000',
    'background:#fff',
    'border-radius:18px 18px 0 0',
    'box-shadow:0 -4px 24px rgba(0,0,0,0.18)',
    'padding:8px 14px 10px',
    'font-family:inherit',
    'safe-area-inset-bottom:env(safe-area-inset-bottom)',
    'padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))',
  ].join(';');

  const { lat, lng } = map.getCenter();
  sheet.innerHTML = `
    <div style="margin-bottom:6px;">
      <div style="font-weight:700;color:#0f2b4d;font-size:13px;margin-bottom:1px;">📍 Posiziona la tappa</div>
      <div id="rc-sheet-coords"
           style="font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;letter-spacing:.3px;">
        ${lat.toFixed(5)}, ${lng.toFixed(5)}
      </div>
    </div>
    <div style="display:flex;gap:8px;">
      <button id="rc-sheet-exact"
        style="flex:1;background:#10b981;color:#fff;border:none;border-radius:10px;
               padding:8px 8px;cursor:pointer;font-size:13px;font-weight:700;line-height:1.3;
               touch-action:manipulation;-webkit-tap-highlight-color:transparent;
               box-shadow:0 2px 8px rgba(16,185,129,.3);">
        📍 Aggiungi tappa
        <div style="font-weight:400;font-size:10px;opacity:.85;margin-top:1px;">no snap</div>
      </button>
      <button id="rc-sheet-snap"
        style="flex:1;background:var(--p);color:#fff;border:none;border-radius:10px;
               padding:8px 8px;cursor:pointer;font-size:13px;font-weight:700;line-height:1.3;
               touch-action:manipulation;-webkit-tap-highlight-color:transparent;
               box-shadow:0 2px 8px rgba(30,90,168,.3);">
        🔗 Tappa intermedia
        <div style="font-weight:400;font-size:10px;opacity:.85;margin-top:1px;">snap strada</div>
      </button>
    </div>`;

  document.body.appendChild(sheet);

  // FIX STRUTTURALE: il sheet è position:fixed/bottom:0 (ancorato al
  // viewport), mentre "Centra mappa"/"Confronta traccia" sono nel flusso
  // normale del documento (#map-bottom-right-row, FUORI da #mapPreview).
  // Sono due sistemi di coordinate indipendenti: ridurre solo l'altezza del
  // sheet attenua la sovrapposizione ma non la elimina, perché con uno
  // scroll diverso il bottone può comunque ricadere nella fascia di schermo
  // coperta dal sheet. La soluzione robusta è riservare nel documento, sotto
  // la mappa, uno spazio pari all'altezza REALE del sheet (misurata a runtime
  // via offsetHeight, non stimata) — così il bottone viene sempre spinto
  // sopra la zona "fixed", indipendentemente da come si scrolla.
  requestAnimationFrame(() => {
    const row = document.getElementById('map-bottom-right-row');
    if (row) row.style.marginBottom = sheet.offsetHeight + 'px';
  });

  // Aggiorna coordinate live mentre l'utente scrolla la mappa
  const _onMove = () => {
    const c = map.getCenter();
    const el = document.getElementById('rc-sheet-coords');
    if (el) el.textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
  };
  map.on('move', _onMove);
  sheet._rcMoveHandler = _onMove;

  sheet.querySelector('#rc-sheet-snap').addEventListener('click', async () => {
    const center = map.getCenter();
    _rcRemoveBottomSheet(map);
    _rcRemoveCrosshair();
    await _insertWaypointAtLatLon(center.lat, center.lng, false);
  });

  sheet.querySelector('#rc-sheet-exact').addEventListener('click', async () => {
    const center = map.getCenter();
    _rcRemoveBottomSheet(map);
    _rcRemoveCrosshair();
    await _insertWaypointAtLatLon(center.lat, center.lng, true);
  });
}

function _rcRemoveBottomSheet(map) {
  const sheet = document.getElementById('rc-bottom-sheet');
  if (!sheet) return;
  if (map && sheet._rcMoveHandler) map.off('move', sheet._rcMoveHandler);
  sheet.remove();
  const row = document.getElementById('map-bottom-right-row');
  if (row) row.style.marginBottom = '';
}

// ── Map Click Mode ────────────────────────────────────────────────────────────
export function toggleMapClickMode(forceOff = false) {
  _mapClickModeActive = forceOff ? false : !_mapClickModeActive;

  const mapEl  = $('mapPreview');
  const btn    = $('map-edit-btn');
  const icon   = $('map-edit-icon');
  const label  = $('map-edit-label');
  const banner = $('map-edit-banner');
  const ctrl   = $('map-edit-ctrl');
  const hint   = $('map-edit-hint');

  if (mapEl) mapEl.classList.toggle('crosshair-mode', _mapClickModeActive);

  const map = _state.getMap();

  if (_mapClickModeActive) {
    if (btn)    { btn.style.background = 'var(--p)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--p)'; btn.setAttribute('aria-pressed', 'true'); btn.title = 'Esci dalla modifica percorso (o premi ESC)'; }
    if (icon)   icon.textContent = '✕';
    if (label)  label.textContent = 'Esci';
    if (banner) banner.style.display = 'block';
    if (hint)   hint.style.display   = 'none';
    if (ctrl)   ctrl.style.flexDirection = 'column';

    // ── Crosshair + Bottom sheet ─────────────────────────────────────────────
    if (map) {
      _rcShowCrosshair();
      _rcShowBottomSheet(map);
      // Il click sulla mappa non è più necessario per aggiungere la tappa:
      // si usa map.getCenter() dai bottoni del bottom sheet.
      // Il vecchio handler rimane attivo ma non fa nulla di visivo (no popup custom).
    }

    if (!toggleMapClickMode._escHandler) {
      toggleMapClickMode._escHandler = (e) => {
        if (e.key === 'Escape' && _mapClickModeActive) toggleMapClickMode(true);
      };
      document.addEventListener('keydown', toggleMapClickMode._escHandler);
    }
    _addLog('✏️ Centra la mappa sul punto desiderato · scegli modalità in basso · ESC per uscire', 'info');
  } else {
    _rcCloseCustomPanel();
    _rcRemoveCrosshair();
    if (map) _rcRemoveBottomSheet(map);
    if (btn)    { btn.style.background = '#fff'; btn.style.color = '#444'; btn.style.borderColor = 'rgba(0,0,0,0.25)'; btn.setAttribute('aria-pressed', 'false'); btn.title = 'Modifica percorso sulla mappa'; }
    if (icon)   icon.textContent = '✏️';
    if (label)  label.textContent = 'Modifica percorso';
    if (banner) banner.style.display = 'none';
    if (hint)   hint.style.display   = 'block';

    if (toggleMapClickMode._escHandler) {
      document.removeEventListener('keydown', toggleMapClickMode._escHandler);
      toggleMapClickMode._escHandler = null;
    }
    _addLog('✏️ Modifica mappa disattivata', 'dim');
  }
}


// ── Feedback visivo durante reverse geocoding ─────────────────────────────────
// Mostra "Geocoding…" nel bottom sheet (mobile) o cursore wait (PC).
// Chiamato prima e dopo _reverseGeocode() nei due rami di _insertWaypointAtLatLon.
function _rcShowGeocodingFeedback() {
  const coordsEl = document.getElementById('rc-sheet-coords');
  if (coordsEl) {
    coordsEl._rcOrigText = coordsEl.textContent;
    coordsEl.textContent = '⏳ Geocoding in corso…';
    coordsEl.style.color = '#f59e0b';
  } else {
    // Modalità PC: cursore wait sul container mappa
    const map = _state.getMap();
    if (map) map.getContainer().style.cursor = 'wait';
  }
}

function _rcHideGeocodingFeedback() {
  const coordsEl = document.getElementById('rc-sheet-coords');
  if (coordsEl) {
    if (coordsEl._rcOrigText) coordsEl.textContent = coordsEl._rcOrigText;
    coordsEl.style.color = '';
  } else {
    const map = _state.getMap();
    if (map) map.getContainer().style.cursor = '';
  }
}

// ── _insertWaypointAtLatLon ───────────────────────────────────────────────────
async function _insertWaypointAtLatLon(lat, lon, forceRaw = false) {
  const routePts = _state.getRoutePoints();
  const wps      = _state.getWaypoints();

  let snapLat = lat, snapLon = lon;
  let snapshotLabel, invalidateCacheReason;

  if (!forceRaw && routePts?.length > 0) {
    // Snap al routePoint più vicino — usa haversineM condivisa
    let minDist = Infinity, minIdx = 0;
    for (let i = 0; i < routePts.length; i++) {
      const d = haversineM({ lat, lon }, routePts[i]);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    snapLat = routePts[minIdx].lat;
    snapLon = routePts[minIdx].lon;
    _addLog(`📍 Snap al tracciato: ${minDist.toFixed(0)}m dal click`, 'dim');

    const N = wps.length - 1;
    const fraction = minIdx / Math.max(routePts.length - 1, 1);
    const insertAfterIdx = Math.min(Math.floor(fraction * N), N - 1);

    _addLog(`⏳ Reverse geocode in corso…`, 'dim');
    _rcShowGeocodingFeedback();
    const name = await _reverseGeocode(snapLat, snapLon) || `${snapLat.toFixed(5)}, ${snapLon.toFixed(5)}`;
    _rcHideGeocodingFeedback();

    const newWp = {
      lat: snapLat, lon: snapLon, name,
      countryCode: null, adminRegion: null, placeType: null,
      source: 'user_click', snapToleranceMeters: 50, userMarkedObligatory: false,
    };
    const updated = [...wps];
    updated.splice(insertAfterIdx + 1, 0, newWp);
    _state.setWaypoints(updated);
    _addLog(`➕ Tappa inserita: "${name}" dopo tappa ${insertAfterIdx + 1} → totale ${updated.length} tappe`, 'ok');
    // Ricorda dove centrare la mappa dopo il refresh, così l'utente vede
    // subito il risultato senza perdere lo zoom su cui stava lavorando.
    const _mZoom = _state.getMap()?.getZoom();
    _mapState.focusLatLon = { lat: snapLat, lon: snapLon, zoom: _mZoom };
    snapshotLabel        = `Tappa aggiunta dalla mappa: "${name}"`;
    invalidateCacheReason = 'aggiunta manuale tappa';

  } else {
    _addLog(`⏳ Reverse geocode in corso…`, 'dim');
    _rcShowGeocodingFeedback();
    const name = await _reverseGeocode(lat, lon) || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    _rcHideGeocodingFeedback();
    const newWp = {
      lat, lon, name,
      countryCode: null, adminRegion: null, placeType: null,
      source: 'user_click_exact', snapToleranceMeters: 0, userMarkedObligatory: true,
    };
    const updated = [...wps];

    if (wps.length >= 2) {
      // Trova il segmento più vicino — usa haversineM condivisa
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < wps.length - 1; i++) {
        const midLat = (wps[i].lat + wps[i+1].lat) / 2;
        const midLon = (wps[i].lon + wps[i+1].lon) / 2;
        const d = haversineM({ lat, lon }, { lat: midLat, lon: midLon });
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      updated.splice(bestIdx + 1, 0, newWp);
      _addLog(`🎯 Tappa esatta inserita: "${name}" dopo tappa ${bestIdx + 1} → totale ${updated.length} tappe`, 'ok');
    } else {
      updated.splice(Math.max(updated.length - 1, 1), 0, newWp);
      _addLog(`🎯 Tappa esatta inserita: "${name}" → totale ${updated.length} tappe`, 'ok');
    }

    _state.setWaypoints(updated);
    const _mZoom = _state.getMap()?.getZoom();
    _mapState.focusLatLon = { lat, lon, zoom: _mZoom };
    snapshotLabel        = `Tappa esatta aggiunta dalla mappa: "${name}"`;
    invalidateCacheReason = 'aggiunta manuale tappa esatta';
  }

  // ── Comune a entrambi i rami ──────────────────────────────────────────────
  await _fullStateRefresh();
  _state.pushSnapshot(snapshotLabel, { manual: true });
  _invalidateWpCache(invalidateCacheReason);
  // Ripristina crosshair + bottom sheet per aggiunta tappa successiva
  if (_mapClickModeActive) { const m = _state.getMap(); if (m) { _rcShowCrosshair(); _rcShowBottomSheet(m); } }
}
