// task_13_map_interaction.js
// Interazione utente con la mappa: init Leaflet + handler custom (click mode RC,
// contextmenu marker, gesture a due dita, resize), crosshair, bottom sheet
// mobile e inserimento waypoint via click/centro mappa.
//
// Estratto da task_01_main.js (refactor D1). Pattern di iniezione dipendenze
// identico a task_14/task_15: initMapInteraction(deps) chiamato una sola volta
// in boot(), zero monkey-patching, zero globali.
//
// NOTA STORICA: l'header della funzione initMap() era stato perso in un
// refactor precedente (il corpo viveva come blocco "orfano" top-level in
// task_01_main.js, righe ~173-249 dell'epoca, con `map` mai dichiarata —
// ReferenceError certo al caricamento del modulo). Ricostruita qui recuperando
// l'istanza mappa da task_12_map_component.initMap() e collegandola allo
// state condiviso tramite state.setMap().

import { $, haversineM } from './task_03_utils.js';
import {
  initMap as _t13InitMap,
  fitMapToBounds as _t13FitMapToBounds,
} from './task_12_map_component.js';

// ── Stato locale del modulo ──────────────────────────────────────────────────
let _mapClickModeActive = false;

// Debounce del primo fitBounds: in un singolo go() fullStateRefresh() può
// essere chiamato 2-3 volte in sequenza (pre-consenso, post-riduzione,
// post-redistribuzione trkpt). Senza debounce ogni chiamata eseguiva il
// proprio fitBounds, causando fit multipli "a scatti" durante il
// caricamento (FIX rallentamento caricamento mappa). Implementato con
// requestAnimationFrame (id numerico, non un timer in ms): si fonde con il
// frame di rendering corrente invece di indovinare un delay arbitrario.
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
// Istanzia la mappa Leaflet tramite il modulo isolato task_12 e collega tutti
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

    // ── PC (pointer: fine): click posiziona un pin provvisorio + bottoni ────
    // Niente più esecuzione immediata: il click sceglie SOLO il punto, la
    // scelta dell'azione (🟢 esatta / 🔵 snap) avviene sui bottoni del popup,
    // identici (icona/etichetta/colore) a quelli del bottom sheet mobile.
    const isMouseDevice = window.matchMedia('(pointer: fine)').matches;
    if (isMouseDevice) {
      const { lat, lng } = e.latlng;
      _rcShowProvisionalPin(map, lat, lng);
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
// FIX rallentamento caricamento + lentina "Centra mappa" (causa radice):
// task_12_map_component._smartPad() calcolava il padding leggendo
// map.getSize(), un valore CACHATO da Leaflet che si aggiorna solo dopo che
// invalidateSize() ha girato E il browser ha completato il reflow — non
// nello stesso tick sincrono. go() può chiamare fullStateRefresh() 2-3 volte
// di fila nello stesso caricamento (pre-consenso → post-riduzione tappe →
// post-redistribuzione trkpt), e fullStateRefresh() cambia diverse classi
// CSS (dashboard, decision-panel) PRIMA di arrivare qui: _smartPad poteva
// quindi leggere dimensioni stantie. Il vecchio workaround era un
// setTimeout(60ms) "alla cieca" per sperare che il reflow fosse completato
// nel frattempo — fragile, e comunque moltiplicato ad ogni fullStateRefresh
// causava i fit "a scatti" durante il caricamento.
// _smartPad ora legge getBoundingClientRect() (sempre sincrono e attuale,
// indipendente dalla cache di Leaflet), quindi il delay arbitrario non è più
// necessario per la correttezza del padding. Resta però utile un debounce
// leggero (via requestAnimationFrame, non un numero di ms indovinato) per
// evitare di eseguire un fitBounds per ognuna delle 2-3 chiamate consecutive
// di fullStateRefresh: si esegue solo l'ultima richiesta, con i bounds più
// recenti (es. quelli post-routing OSRM, non quelli grezzi del primo render
// provvisorio).
export function _applyMapView() {
  const map = _state.getMap();
  if (!map) return;

  map.invalidateSize();

  if (!_mapState.hasBeenFitted) {
    const _bounds = _mapState.pendingBounds;
    if (!_bounds) return; // niente da inquadrare ancora: non segnare hasBeenFitted

    // Annulla un eventuale fit precedente non ancora eseguito: contano solo
    // i bounds più recenti.
    if (_fitDebounceTimer) cancelAnimationFrame(_fitDebounceTimer);

    _fitDebounceTimer = requestAnimationFrame(() => {
      _fitDebounceTimer = null;
      _mapState.hasBeenFitted = true;
      try {
        map.invalidateSize();
        _t13FitMapToBounds(_mapState.pendingBounds);
      } catch (e) {}
    });
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

// ── Pin provvisorio desktop (click → scegli azione) ──────────────────────────
// Sostituisce l'esecuzione immediata su click: il click posiziona un marker
// provvisorio con un popup nativo Leaflet (si aggancia da solo a lat/lon e
// segue pan/zoom, nessun ricalcolo manuale di posizione) contenente gli stessi
// due bottoni 🟢/🔵 del bottom sheet mobile. L'inserimento avviene solo alla
// pressione del bottone, mai al click.
function _rcRemoveProvisionalPin(map) {
  if (map._rcProvisionalMarker) {
    map.removeLayer(map._rcProvisionalMarker);
    map._rcProvisionalMarker = null;
  }
}

function _rcShowProvisionalPin(map, lat, lng) {
  _rcRemoveProvisionalPin(map);   // un solo pin provvisorio alla volta

  const marker = L.marker([lat, lng], { opacity: 0.85 }).addTo(map);
  map._rcProvisionalMarker = marker;

  const html = `
    <div style="display:flex;flex-direction:column;gap:6px;min-width:150px;">
      <button id="rc-pin-exact"
        style="background:#10b981;color:#fff;border:none;border-radius:8px;
               padding:7px 10px;cursor:pointer;font-size:13px;font-weight:700;">
        📍 Aggiungi tappa <span style="font-weight:400;opacity:.85;">(no snap)</span>
      </button>
      <button id="rc-pin-snap"
        style="background:var(--p);color:#fff;border:none;border-radius:8px;
               padding:7px 10px;cursor:pointer;font-size:13px;font-weight:700;">
        🔗 Tappa intermedia <span style="font-weight:400;opacity:.85;">(snap strada)</span>
      </button>
    </div>`;

  marker.bindPopup(html, { closeButton: true, autoClose: false, closeOnClick: false });

  // FIX bottoni "morti": il listener 'popupopen' deve essere registrato PRIMA
  // di chiamare openPopup(). Leaflet emette 'popupopen' in modo sincrono
  // dentro openPopup(): se il .on('popupopen', ...) viene aggiunto DOPO
  // (come accadeva prima), il primo (e unico, con autoClose:false) evento
  // passa a vuoto — il popup si apre e i bottoni sono visibili nel DOM, ma
  // addEventListener('click', ...) su di essi non viene mai eseguito.
  marker.on('popupopen', () => {
    const el = marker.getPopup()?.getElement();
    el?.querySelector('#rc-pin-exact')?.addEventListener('click', async () => {
      _addLog(`📍 Aggiungi tappa (esatto): (${lat.toFixed(5)}, ${lng.toFixed(5)})`, 'info');
      _rcRemoveProvisionalPin(map);
      await _insertWaypointAtLatLon(lat, lng, true);
    });
    el?.querySelector('#rc-pin-snap')?.addEventListener('click', async () => {
      _addLog(`🔗 Tappa intermedia (snap): (${lat.toFixed(5)}, ${lng.toFixed(5)})`, 'info');
      _rcRemoveProvisionalPin(map);
      await _insertWaypointAtLatLon(lat, lng, false);
    });
  });

  marker.on('popupclose', () => _rcRemoveProvisionalPin(map));

  marker.openPopup();
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

// ── Soglia prossimità crosshair→marker per mostrare il bottone Elimina ─────
// 40m: abbastanza ampia da essere usabile con dito su mobile,
// abbastanza stretta da non attivarsi per errore su tappe vicine.
// Soglia prossimità crosshair→marker in pixel schermo (indipendente dallo zoom).
// 44px = circa un dito su mobile, comodo da centrare senza precisione chirurgica.
const _PROXIMITY_PX = 44;

// Restituisce l'indice del waypoint più vicino al centro mappa (in pixel),
// se entro soglia. Altrimenti null.
function _nearestWpIdx(map) {
  const wps = _state.getWaypoints();
  if (!wps || wps.length <= 2) return null;  // almeno 3 tappe per poterne eliminare una
  const centerPx = map.getSize().divideBy(2);  // centro mappa in pixel contenitore
  let minDist = Infinity, minIdx = null;
  for (let i = 0; i < wps.length; i++) {
    const markerPx = map.latLngToContainerPoint([wps[i].lat, wps[i].lon]);
    const dx = markerPx.x - centerPx.x;
    const dy = markerPx.y - centerPx.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d < minDist) { minDist = d; minIdx = i; }
  }
  return minDist <= _PROXIMITY_PX ? minIdx : null;
}

// Aggiorna il bottom sheet ad ogni move:
// - bottone rosso SEMPRE visibile (disabilitato/grigio se crosshair lontano da marker)
// - bottone rosso ATTIVO (rosso pieno) quando crosshair è sul marker
function _rcUpdateBottomSheet(map, sheet) {
  const btnRow = sheet.querySelector('#rc-sheet-btn-row');
  if (!btnRow) return;

  const nearIdx = _nearestWpIdx(map);
  const wps     = _state.getWaypoints();

  // ── Aggiorna solo il bottone rosso (verde e blu restano invariati) ───────────
  const existingDelete = btnRow.querySelector('#rc-sheet-delete');

  // Costruisci label tappa puntata (o placeholder se lontano)
  let nameDisp = '— avvicina il mirino —';
  if (nearIdx !== null) {
    const wp      = wps[nearIdx];
    const roleStr = nearIdx === 0 ? 'Partenza' : nearIdx === wps.length - 1 ? 'Arrivo' : 'Tappa';
    const label   = `${nearIdx + 1} — ${roleStr}`;
    nameDisp = wp.name ? `"${wp.name}"` : label;
  }

  const isActive = nearIdx !== null;

  if (!existingDelete) {
    // Prima chiamata: costruisce tutto il layout una sola volta
    btnRow.innerHTML = `
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
      <button id="rc-sheet-delete"
        style="flex:1;border:none;border-radius:10px;
               padding:8px 8px;cursor:pointer;font-size:13px;font-weight:700;line-height:1.3;
               touch-action:manipulation;-webkit-tap-highlight-color:transparent;
               transition:background .2s,box-shadow .2s,opacity .2s;">
        🗑️ Elimina
        <div id="rc-sheet-delete-sub" style="font-weight:400;font-size:10px;margin-top:1px;"></div>
      </button>`;

    btnRow.querySelector('#rc-sheet-snap').addEventListener('click', async () => {
      const center = map.getCenter();
      _rcRemoveBottomSheet(map);
      _rcRemoveCrosshair();
      await _insertWaypointAtLatLon(center.lat, center.lng, false);
    });

    btnRow.querySelector('#rc-sheet-exact').addEventListener('click', async () => {
      const center = map.getCenter();
      _rcRemoveBottomSheet(map);
      _rcRemoveCrosshair();
      await _insertWaypointAtLatLon(center.lat, center.lng, true);
    });

    btnRow.querySelector('#rc-sheet-delete').addEventListener('click', async () => {
      const idx = _nearestWpIdx(map);  // rilegge al momento del tap
      if (idx === null) return;        // disabilitato: ignora tap
      await deleteWaypointFromMap(idx);
    });
  }

  // Aggiorna stato visivo bottone rosso ad ogni move (senza ricostruire il DOM)
  const delBtn = btnRow.querySelector('#rc-sheet-delete');
  const delSub = btnRow.querySelector('#rc-sheet-delete-sub');
  if (delBtn) {
    delBtn.style.background   = isActive ? '#e53e3e'              : '#e5e7eb';
    delBtn.style.color        = isActive ? '#fff'                 : '#9ca3af';
    delBtn.style.boxShadow    = isActive ? '0 2px 8px rgba(229,62,62,.35)' : 'none';
    delBtn.style.opacity      = isActive ? '1'                   : '0.7';
    delBtn.style.pointerEvents = isActive ? 'auto'               : 'none';
  }
  if (delSub) delSub.textContent = nameDisp;
}

// ── Unica funzione di eliminazione tappa-da-mappa ────────────────────────────
// Richiamata sia dal bottone 🔴 del bottom sheet mobile (crosshair) sia dal
// popup di hover sui marker desktop (task_12 → callbacks.onDeleteRequest,
// wired da task_01). Prima di questa consolidazione esistevano tre copie
// indipendenti della stessa logica (task_12 long-press, task_13 bottom
// sheet, task_01 onLongPress): ora ce n'è una sola.
export async function deleteWaypointFromMap(idx) {
  const wpsNow = _state.getWaypoints();
  const w      = wpsNow[idx];
  if (!w) return;
  if (wpsNow.length <= 2) {
    _addLog('⚠️ Impossibile rimuovere: servono almeno 2 tappe', 'warn');
    return;
  }
  const roleFin  = idx === 0 ? 'Partenza' : idx === wpsNow.length - 1 ? 'Arrivo' : 'Tappa';
  const labelFin = `${idx + 1} — ${roleFin}`;
  const { isConfirmed } = await window.Swal.fire({
    icon: 'warning',
    title: `Rimuovere "${w.name || labelFin}"?`,
    html: `<span style="color:#6b7280;font-size:13px;">${labelFin}</span>`,
    showCancelButton: true,
    confirmButtonText: '🗑️ Rimuovi',
    cancelButtonText: 'Annulla',
    confirmButtonColor: '#e53e3e',
    cancelButtonColor: '#6b7280',
  });
  if (!isConfirmed) return;

  const updated = _state.getWaypoints().filter((_, i) => i !== idx);
  _state.setWaypoints(updated);
  _state.pushSnapshot(`Tappa rimossa dalla mappa: "${w.name || labelFin}"`, { manual: true });
  _invalidateWpCache('rimozione tappa da mappa');
  _addLog(`🗑️ Tappa rimossa: "${w.name || labelFin}"`, 'ok');
  const zoom = _state.getMap()?.getZoom();
  _mapState.focusLatLon = { lat: w.lat, lon: w.lon, zoom };
  await _fullStateRefresh();
  // Resta in edit mode: ripristina crosshair + sheet mobile per l'operazione
  // successiva (no-op su desktop, dove crosshair/sheet non esistono).
  if (_mapClickModeActive) {
    const m = _state.getMap();
    if (m) { _rcShowCrosshair(); _rcShowBottomSheet(m); }
  }
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
    <div id="rc-sheet-btn-row" style="display:flex;gap:8px;"></div>`;

  document.body.appendChild(sheet);

  // Rendering iniziale bottoni
  _rcUpdateBottomSheet(map, sheet);

  // FIX STRUTTURALE: spazio riservato sotto la mappa per evitare sovrapposizione
  requestAnimationFrame(() => {
    const row = document.getElementById('map-bottom-right-row');
    if (row) row.style.marginBottom = sheet.offsetHeight + 'px';
  });

  // Aggiorna coordinate live + context bottoni mentre l'utente scrolla
  const _onMove = () => {
    const c  = map.getCenter();
    const el = document.getElementById('rc-sheet-coords');
    if (el) el.textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    _rcUpdateBottomSheet(map, sheet);
  };
  map.on('move', _onMove);
  sheet._rcMoveHandler = _onMove;
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
    _addLog('✏️ Clicca un punto sulla mappa (o centra il mirino), poi scegli l\'azione · ESC per uscire', 'info');
  } else {
    _rcCloseCustomPanel();
    _rcRemoveCrosshair();
    if (map) { _rcRemoveBottomSheet(map); _rcRemoveProvisionalPin(map); }
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
// FIX: da blocco/conferma a solo informativo (stesso pattern di
// _warnIfOverLimit in task_11_waypoints.js). L'utente ha già dichiarato la
// propria intenzione al consent gate d'import (_consentGate in
// task_14_route_loader.js) o sta aggiungendo tappe consapevolmente dalla
// mappa — in entrambi i casi non serve un secondo cancello con conferma,
// basta informare, come già fa il badge 🔴/⚠️/✓ in wpLabel e l'auto-switch
// a formato ITN a fine go() in task_14. L'inserimento procede sempre.
async function _insertWaypointAtLatLon(lat, lon, forceRaw = false) {
  const wpLimit = _state.getWpLimit();
  if (Number.isFinite(wpLimit) && _state.getWaypoints().length >= wpLimit) {
    const modeLabel = wpLimit <= 21 ? 'MyDrive Connect' : 'Navigatore (microSD/USB)';
    _addLog(`⚠️ Oltre il limite ${modeLabel} (max ${wpLimit}): tappa aggiunta comunque, esporta via ITN/microSD`, 'warn');
  }

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
  _state.pushSnapshot(snapshotLabel, { manual: true });
  _invalidateWpCache(invalidateCacheReason);
  await _fullStateRefresh();
  // Ripristina crosshair + bottom sheet per aggiunta tappa successiva
  if (_mapClickModeActive) { const m = _state.getMap(); if (m) { _rcShowCrosshair(); _rcShowBottomSheet(m); } }
}
