// task_01_main.js
// Orchestratore: collega tutti i moduli, gestisce il flusso principale.
// Questo file è l'unico che tocca il DOM direttamente (tranne task_02).
//
// Step ①② refactor:
//   • Utilità pure            → task_03_utils.js
//   • Geocoding/reverse       → task_07_geocoding_client.js
//   Rimosso ~420 righe di codice duplicato/spostato.
//
// Step ③ refactor (chirurgico, zero split):
//   • _getDpWpControls()      → helper centralizzato per i 4 elementi DOM del
//                               pannello decisionale (era ri-selezionato 3×
//                               con nomi variabile incongruenti)
//   • _snapshotWpCache(key)   → helper per salvare wps+routePoints in cache
//                               (pattern duplicato 2-3× in decisionWpApply)
//   • toggleInfoPanel() clone → rimossa la copia morta in index.html
//                               (i moduli ES sono deferred: la versione del
//                               modulo sovrascriveva sempre quella classica)
//   • #1e5aa8 → var(--p)      → bottone map-edit-btn e bottom sheet snap
//                               (SweetAlert2 e Leaflet polyline restano hex)
//
// Step ④ refactor (🔴2 monkey-patch fix):
//   • state._mapHasBeenFitted / state._pendingMapBounds / state._mapFocusLatLon
//     / state._lastElaboratedFileName / state._lastElaboratedUrl
//     / state._sourceFileName  →  oggetto locale _mapState (stesso pattern di _f4)
//     Eliminato il monkey-patching su oggetto esterno createState().

import { createState }          from './task_02_state.js';
import { createWaypointUI }     from './task_12_waypoints.js';
import { createRoutingEngine }  from './task_11_engine.js';
import { pruneBacktracks, sampleCriticalWaypointsFromGeometry, redistributeByDistance, motoOptimize } from './task_08_geometry.js';
import { buildGPXString, buildKMLString, buildITNString } from './task_09_export.js';
import { parseFile, extractStops, extractAllWaypointCoords, coordStr, isBlob, blobCoords, isShortUrl } from './task_10_parsers.js';
// ── Step ③ — Componenti Interfaccia Utente (UI) ─────────────────────────────
import {
  renderWaypoints,
  drawRoute,
} from './task_13_map_component.js';

import {
  toggleHistoryPanel,
  syncClearButtonVisibility,
  toggleInfoPanelState,
  updateDashboardStats,
  setMapEditButtonState,
} from './task_14_panel_controls.js';

import {
  initMapInteraction,
  isMapClickModeActive,
  initMap,
  _applyMapView,
  toggleMapClickMode,
} from './task_15_map_interaction.js';

import { initRouteLoader, go } from './task_16_route_loader.js';

import {
  initDecisionPanel,
  showDecisionPanel,
  showRemovalLog,
  decisionExport,
  decisionOptimize,
  decisionWpAdjust,
  decisionWpApply,
  decisionEdit,
  invalidateWpCache   as _invalidateWpCache,
  snapshotWpCache     as _snapshotWpCache,
  setOriginalSrcType,
  setOriginalWaypoints,
  setPinnedSet,
  getPinnedSet,
} from './task_17_decision_panel.js';
// ── Step ① — Utilità pure ────────────────────────────────────────────────────
import {
  $, esc, sleep, isIOS, formatBytes, setProgress, addLog,
  haversineM, decodePolyline6,
} from './task_03_utils.js';

// ── Dominio waypoint (fonte di verità unica per isSemanticName / computePinnedSet)
import { isSemanticName, computePinnedSet } from './task_05_waypoint_policy.js';

// ── Step ② — Geocoding (Aggiornato con il nuovo modulo isolato)
import {
  geocode, reverseGeocode, nameWaypoints, _extractViewport,
} from './task_07_geocoding_client.js';

// ── Dipendenze globali (CDN) ──────────────────────────────────────────────────
// Leaflet → window.L, JSZip → window.JSZip, SweetAlert2 → window.Swal

// ── Init moduli ───────────────────────────────────────────────────────────────
const state   = createState();
const engine  = createRoutingEngine({ decodePolyline6, addLog, sleep });
const wpUI    = createWaypointUI({ state, geocode, fullStateRefresh, regenerateOutput, addLog, esc, sleep, Swal: window.Swal, $ });

// ── Undo / Redo UI (Fase 2) ───────────────────────────────────────────────────
function updateUndoRedo() {
  const btnUndo = $('btn-undo');
  const btnRedo = $('btn-redo');
  if (!btnUndo || !btnRedo) return;
  btnUndo.disabled = !state.canUndo();
  btnRedo.disabled = !state.canRedo();
  btnUndo.title = state.canUndo() ? `Torna a: ${state.getSnapshotLabel()}` : '';
  btnRedo.title = state.canRedo() ? 'Ripeti modifica' : '';
}

state.subscribe((event) => {
  if (event === 'snapshot' || event === 'waypoints') updateUndoRedo();
});

// ── [FASE 4] State locale — non modifica task_02_state.js ────────────────────
const _f4 = {
  removalLog:     null,
};
state.getRemovalLog      = ()  => _f4.removalLog;
state.setRemovalLog      = (l) => { _f4.removalLog = l; };

// ── [REFACTOR 🔴2] State locale mappa — non monkey-patcha task_02_state ────────
// Stesso pattern di _f4: le proprietà di navigazione della mappa vivono qui,
// non sull'oggetto state di un modulo esterno che non le conosce.
const _mapState = {
  hasBeenFitted:  false,   // ex state._mapHasBeenFitted
  pendingBounds:  null,    // ex state._pendingMapBounds
  focusLatLon:    null,    // ex state._mapFocusLatLon
  lastFileName:   null,    // ex state._lastElaboratedFileName
  lastUrl:        null,    // ex state._lastElaboratedUrl
  sourceFileName: null,    // ex state._sourceFileName
};


// ── Aggiornamento Geometrie e Visualizzazione Mappa ───────────────────────────
function updateMapVisuals() {
  const wps = state.getWaypoints();
  if (!$('mapPreview').classList.contains('on') || wps.length < 2) return;

  const map = state.getMap();

  // 1. Rendering dei waypoint con long-press per eliminazione (ripristinato da task_06)
  renderWaypoints(wps, (idx, lat, lng) => {
    // dragend: aggiorna posizione tappa
    if (typeof decisionWpAdjust === 'function') {
      decisionWpAdjust(idx, lat, lng);
    }
  }, {
    // Callback long-press per rimozione tappa (era presente in task_06, rimosso nel refactor)
    onLongPress: async (idx, w, label) => {
      if (!map) return;
      const wpsNow = state.getWaypoints();
      if (wpsNow.length <= 2) {
        addLog(`⚠️ Impossibile rimuovere: servono almeno 2 tappe`, 'warn');
        return;
      }
      const { isConfirmed } = await Swal.fire({
        icon: 'warning',
        title: `Rimuovere "${esc(w.name)}"?`,
        html: `<span style="color:#6b7280;font-size:13px;">${label}</span>`,
        showCancelButton: true,
        confirmButtonText: '🗑️ Rimuovi',
        cancelButtonText: 'Annulla',
        confirmButtonColor: '#e53e3e',
        cancelButtonColor: '#6b7280',
      });
      if (!isConfirmed) return;
      if (!$('decision-panel')?.classList.contains('on')) decisionEdit();
      const updated = state.getWaypoints().filter((_, i) => i !== idx);
      state.setWaypoints(updated);
      state.pushSnapshot(`Tappa rimossa dalla mappa: "${w.name}"`, { manual: true });
      _invalidateWpCache('rimozione manuale tappa');
      addLog(`🗑️ Tappa rimossa: "${w.name}" (${label})`, 'ok');
      const _mZoom = map.getZoom();
      _mapState.focusLatLon = { lat: w.lat, lon: w.lon, zoom: _mZoom };
      await fullStateRefresh();
    },
  });

  // 2. Disegno della traccia principale (percorso ottimizzato o spezzata lineare)
  const routePoints = state.getRoutePoints();
  if (routePoints?.length > 0) {
    drawRoute(routePoints, '#1e5aa8');
  } else {
    drawRoute(wps, '#f59e0b');
  }

  // TODO: confronto visivo pre/post modifiche — reinserire qui quando necessario.
  // Punto di partenza: hasManualEditSinceImport() + snapshot della traccia OSRM al primo import.
  // Rimosso: funzionalità non funzionante (confrontava geometria pre/post pruning OSRM,
  // non la traccia originale importata vs quella modificata dall'utente).

  // 3. Calcolo dei limiti geografici (bounds) per la gestione della vista globale
  try {
    const pointsForBounds = routePoints?.length > 0 ? routePoints : wps;
    const latLngs = pointsForBounds.map(p => [p.lat, p.lon || p.lng]);
    const _bounds = L.latLngBounds(latLngs);
    if (_bounds.isValid()) {
      _mapState.pendingBounds = _bounds;
    }
  } catch (e) {
    console.error("Errore nel calcolo dei bounds della mappa:", e);
  }
}

// ── Rigenera output (GPX/KMZ/ITN/KML) ────────────────────────────────────────
async function regenerateOutput() {
  const wps    = state.getWaypoints();
  const name   = state.getName();
  const format = state.getFormat();
  const rpts   = state.getRoutePoints();
  if (wps.length < 2) return;

  let output;
  if (format === 'kmz') {
    const zip = new JSZip();
    zip.file('doc.kml', buildKMLString(wps, name, rpts || null));
    output = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  } else if (format === 'kml') {
    output = buildKMLString(wps, name, rpts || null);
  } else if (format === 'gpx') {
    output = buildGPXString(wps, name, rpts);
  } else {
    output = buildITNString(wps);
  }
  state.setOutput(output);
  const dlLabel = $('dlLabel');
  if (dlLabel) dlLabel.textContent = 'Scarica ' + name.replace(/\s+/g, '_') + '.' + format;
}

// ── _setFormat ────────────────────────────────────────────────────────────────
function _setFormat(fmt) {
  state.setFormat(fmt);
  document.querySelectorAll('.fmt-btn').forEach(b => b.classList.toggle('active', b.dataset.fmt === fmt));
}

// ── updateRoutingAndUI ────────────────────────────────────────────────────────
async function updateRoutingAndUI() {
  const wps     = state.getWaypoints();
  const wpLimit = state.getWpLimit();
  if (wps.length < 2) return;

  const pending = state.getPendingRouting();
  if (pending) { pending.abort?.(); state.setPendingRouting(null); }

  // Fast-path Garmin Hybrid
  const garminRaw = state.getGarminHybridRawPoints();
  if (garminRaw?.length > 0) {
    state.setRoutePoints(garminRaw);
    state.setGarminHybridRawPoints(null);
    // Calcola distanza totale con haversineM condivisa
    const dist = garminRaw.reduce((acc, p, i, arr) => {
      if (i === 0) return 0;
      return acc + haversineM(arr[i - 1], p);
    }, 0);
    state.setRouteDistance(dist);
    state.setRouteDuration(0);
    $('statDist').textContent = (dist / 1000).toFixed(1) + ' km';
    $('statTime').textContent = '—';
    addLog(`✅ Traccia Garmin originale: ${garminRaw.length} punti · ${(dist/1000).toFixed(1)} km (OSRM bypassato)`, 'ok');
    addLog(`📍 Waypoint Garmin originali preservati: ${wps.length} tappe (rtept nominali inviolabili)`, 'ok');
    
    // 🗑️ VECCHIO RICHIAMO ELIMINATO E SOSTITUITO CON:
    updateMapVisuals();
    
    await regenerateOutput();
    return;
  }

 // Fast-path trkpt
  const sourceType = state.getGpxSourceType();
  if (sourceType === 'trkpt') {
    const rpts = state.getRoutePoints();
    if (rpts?.length > 0) {
      addLog(`📍 trkpt: ${wps.length} waypoint, traccia originale ${rpts.length} pt (OSRM bypassato)`, 'dim');
      
      // CAMBIA QUESTA RIGA:
      updateMapVisuals(); 
      
      await regenerateOutput();
      return;
    }
  }

  // ── Routing OSRM/Valhalla ─────────────────────────────────────────────────────
  const controller = new AbortController();
  state.setPendingRouting(controller);
  try {
    addLog(wps.length > 10 ? '🔄 Ricalcolo percorso (modalità batch)...' : '🔄 Ricalcolo percorso...', 'info');
    const route = await engine.fetchRouteChunked(wps, controller.signal);
    if (state.getPendingRouting() !== controller) return;

    if (route?.points?.length > 0) {
      let pts = pruneBacktracks(route.points, { addLog });
      addLog(`📐 Geometria dopo pruning: ${pts.length} punti`, 'info');

      state.setRouteDistance(route.distance);
      state.setRouteDuration(route.duration);
      $('statDist').textContent = (route.distance / 1000).toFixed(1) + ' km';
      const h = Math.floor(route.duration / 3600);
      const m = Math.floor((route.duration % 3600) / 60);
      $('statTime').textContent = `${h}h ${String(m).padStart(2,'0')}m`;
      addLog(`✅ Rotta: ${(route.distance/1000).toFixed(1)} km · ${pts.length} punti`, 'ok');

      state.setWaypoints(wps);
      state.setRoutePoints(pts);

      addLog(`📍 Waypoint semantici preservati: ${wps.length} tappe`, 'ok');
      
      // Chiamata aggiornata alla nuova logica visuale
      updateMapVisuals();
      
      await regenerateOutput();
    }
  } catch (err) {
    if (err.name !== 'AbortError') addLog(`❌ Routing fallito: ${err.message}`, 'warn');
  } finally {
    if (state.getPendingRouting() === controller) state.setPendingRouting(null);
  }
}


// ── fullStateRefresh ──────────────────────────────────────────────────────────
async function fullStateRefresh() {
  wpUI.updateCountWarning();
  await updateRoutingAndUI();
  wpUI.refresh();
  if (state.getWaypoints().length < 2 && isMapClickModeActive()) toggleMapClickMode(true);
  updateDashboard();
  if ($('decision-panel')?.classList.contains('on')) showDecisionPanel();
  // Ultimo step, sempre: a questo punto lista/dashboard/pannello hanno già
  // finito qualsiasi reflow, quindi la view della mappa può essere applicata
  // su dimensioni del contenitore definitive.
  _applyMapView();
}


function download() {
  const output = state.getOutput();
  if (!output) return;
  const name   = state.getName();
  const format = state.getFormat();
  const wps    = state.getWaypoints();
  const itnNote = format === 'itn'
    ? `<br><span style="color:#b45309">⚠️ Il browser potrebbe salvare il file come <strong>.itn.txt</strong>: rinominalo togliendo ".txt" prima di copiarlo su TomTom.</span>`
    : '';
  Swal.fire({ icon:'success', title:'Download avviato ✓', html:`<strong>${esc(name)}.${format}</strong><br>${wps.length} tappe${itnNote}`, timer: format === 'itn' ? 5000 : 2000, showConfirmButton:false, toast:true, position:'top-end' });
  const fn   = name.replace(/\s+/g, '_') + '.' + format;
  const blob = format === 'kmz' ? output
             : format === 'itn' ? new Blob([output], { type:'application/octet-stream' })
             : format === 'kml' ? new Blob([output], { type:'application/vnd.google-earth.kml+xml' })
             : new Blob([output], { type:'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: fn });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ── openExpander ──────────────────────────────────────────────────────────────
function openExpander() {
  const url = $('urlIn').value.trim();
  if (url) window.open('https://www.expandurl.net/?url=' + encodeURIComponent(url), '_blank');
}

// ── toggleHistory ─────────────────────────────────────────────────────────────
function toggleHistory() {
  const list = $('historyList');
  if (list.classList.contains('open')) { list.classList.remove('open'); return; }
  list.innerHTML = '';
  const history = state.getHistory();
  if (history.length === 0) {
    list.innerHTML = '<div class="history-item" style="color:var(--text-muted);cursor:default;">Nessuna conversione recente</div>';
  } else {
    history.forEach((h) => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.textContent = `${h.name} • ${h.wps} tappe • ${h.fmt.toUpperCase()}`;
      div.onclick = async () => {
        if (!h.waypoints || h.waypoints.length < 2) {
          Swal.fire({ icon: 'warning', title: 'Rotta non disponibile', text: 'Questa voce è stata salvata con una versione precedente e non contiene i waypoint.', confirmButtonColor: '#1e5aa8' });
          return;
        }
        list.classList.remove('open');
        state.setName(h.name);
        $('nameIn').value = h.name;
        state.setWaypoints([...h.waypoints]);
        $('mapPreview').classList.add('on');
        $('results').classList.add('on');
        $('mapPlaceholder').classList.add('hidden');
        $('progressCard').classList.add('on');
        $('logEl').innerHTML = '';
        // Rotta ripristinata da cronologia: fit completo anche se la mappa
        // Leaflet esiste già da una sessione precedente.
        _mapState.hasBeenFitted = false;
        addLog(`📜 Ripristino rotta: "${h.name}" (${h.waypoints.length} tappe)`, 'info');
        state.setFormat(h.fmt);
        document.querySelectorAll('.fmt-btn').forEach(b => b.classList.toggle('active', b.dataset.fmt === h.fmt));
        await fullStateRefresh();
        // FIX: fullStateRefresh() richiama showDecisionPanel() solo se il
        // pannello è GIÀ visibile (vedi riga ~459). Su un ripristino da
        // cronologia in una sessione "fresca" il pannello parte chiuso,
        // quindi bigExportBtn non riceve mai la classe 'on'. Lo forziamo
        // qui esplicitamente, come fa già il flusso go() a fine elaborazione.
        showDecisionPanel();
        $('progressCard').classList.remove('on');
      };
      list.appendChild(div);
    });
    const clearBtn = document.createElement('div');
    clearBtn.className = 'history-item';
    clearBtn.style = 'color:var(--error,#ef4444);text-align:center;font-weight:600;border-top:1px solid var(--border-light);margin-top:4px;padding-top:8px;cursor:pointer;';
    clearBtn.textContent = '🗑 Cancella cronologia';
    clearBtn.onclick = () => {
      state.setHistory([]);
      try { localStorage.removeItem('routeConvHistory'); } catch (e) {}
      list.classList.remove('open');
      Swal.fire({ icon: 'success', title: 'Cronologia cancellata', timer: 1200, showConfirmButton: false, toast: true, position: 'top-end' });
    };
    list.appendChild(clearBtn);
  }
  list.classList.add('open');
}

// ── updateModelLimit ──────────────────────────────────────────────────────────
function updateModelLimit() {
  const raw = $('modelSelect').value;
  state.setWpLimit(raw === 'Infinity' ? Infinity : parseInt(raw));
  wpUI.updateCountWarning();
}

// ── toggleInfoPanel ───────────────────────────────────────────────────────────
function toggleInfoPanel() {
  const btn    = $('infoToggleBtn');
  const panel  = $('infoPanel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  btn.classList.toggle('open', !isOpen);
  btn.setAttribute('aria-expanded', String(!isOpen));
  try { localStorage.setItem('infoPanel_open', String(!isOpen)); } catch (e) {}
}

// ── Dashboard persistente (Fase 1) ────────────────────────────────────────────
function updateDashboard() {
  const el = $('dashboard');
  if (!el) return;
  const wps  = state.getWaypoints();
  const orig = state.getRawImportCount?.() || wps.length;
  $('db-wp-from-to').textContent = `Da ${orig} → ${wps.length} WP`;
  $('db-mydrive').textContent =
    wps.length <= state.getWpLimit() ? '✅ MyDrive compatibile' : '⚠️ Solo MicroSD';
  el.classList.remove('hidden');
}

// ── Undo / Redo actions (Fase 2) ─────────────────────────────────────────────
async function undoAction() {
  if (!state.canUndo()) return;
  const label = state.getSnapshotLabel();
  state.undo();
  addLog(`↩ Annullato: ripristino a "${state.getSnapshotLabel() ?? label}"`, 'info');
  await fullStateRefresh();
}

async function redoAction() {
  if (!state.canRedo()) return;
  state.redo();
  addLog(`↪ Ripetuto: "${state.getSnapshotLabel()}"`, 'info');
  await fullStateRefresh();
}


// ── fitMapToRoute ────────────────────────────────────────────────────────────
// Centra/zooma manualmente su tutto il percorso. Da agganciare a un pulsante
// UI (es. "🔍 Vedi tutto il percorso"), utile ora che initMap() NON fa più
// fitBounds automatico ad ogni modifica tappa.
// NOTA: collideva con un omonimo export di task_13. Tenuta questa versione
// locale su state.getMap()/getRoutePoints()/getWaypoints() con flyToBounds
// animato + fallback sui waypoint grezzi.
// Il padding è delegato a _smartPad (via fitMapToBounds di task_13):
// nessun valore hardcoded qui → unica fonte di verità.
function fitMapToRoute() {
  const map = state.getMap();
  if (!map) return;
  const routePoints = state.getRoutePoints();
  const wps         = state.getWaypoints();
  const pts = routePoints?.length > 0 ? routePoints : wps;
  if (!pts?.length) return;
  try {
    const bounds = L.latLngBounds(pts.map(p => [p.lat, p.lon]));
    if (bounds.isValid()) {
      map.invalidateSize();
      const pad = _computeSmartPad(map);
      map.flyToBounds(bounds, { padding: pad, maxZoom: 14, duration: 0.5 });
    }
  } catch (e) {}
}

// Helper locale — replica la logica di _smartPad da task_13 senza importarla.
// Padding asimmetrico: top=48px (goccia Leaflet 41px + 7px), bottom=12px.
function _computeSmartPad(map) {
  const size = map.getSize();
  const padH = Math.max(12, Math.min(20, Math.round(size.x * 0.04)));
  return {
    paddingTopLeft:     L.point(padH, 48),
    paddingBottomRight: L.point(padH, 12),
  };
}


// ── Boot ──────────────────────────────────────────────────────────────────────
// Tutte le registrazioni di eventi DOM e l'init UI sono raccolte qui.
// Punto d'ingresso esplicito: evita listener "sciolti" a livello di modulo,
// problemi di timing su DOM non ancora pronto e duplicazione con HMR.
async function boot() {
  // ── Inizializza modulo interazione mappa (deps prima, poi crea la mappa) ──
  initMapInteraction({
    state,
    addLog,
    reverseGeocode,
    mapState: _mapState,
    fullStateRefresh,
    invalidateWpCache: _invalidateWpCache,
  });
  initMap();

  // ── Inizializza modulo route loader ─────────────────────────────────────
  initRouteLoader({
    state,
    Swal: window.Swal,
    esc,
    mapState: _mapState,
    fullStateRefresh,
    regenerateOutput,
    setFormat: _setFormat,
    updateDashboard,
  });

  // ── Inizializza modulo pannello decisionale ──────────────────────────────
  initDecisionPanel({
    state,
    addLog,
    setProgress,
    esc,
    sleep,
    Swal: window.Swal,
    fullStateRefresh,
    regenerateOutput,
    setFormat: _setFormat,
    updateUndoRedo,
    engine,
    verifyRouteEquivalence: null, // task_18 — futuro step D4
  });

  try { state.setHistory(JSON.parse(localStorage.getItem('routeConvHistory') || '[]')); } catch (e) {}

  document.querySelectorAll('.fmt-btn').forEach(b => {
    b.addEventListener('click', async () => {
      _setFormat(b.dataset.fmt);
      if (state.getWaypoints().length >= 2) await regenerateOutput();
    });
  });

  wpUI.updateCountWarning();
  if (isIOS()) $('iosHint')?.classList.add('on');

  $('progTitle')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) $('progressCard')?.classList.toggle('log-open');
  });

  ['urlIn', 'expandedUrlIn', 'nameIn'].forEach(id => {
    const el    = $(id);
    const btnId = id === 'urlIn' ? 'xUrl' : id === 'expandedUrlIn' ? 'xExpanded' : 'xName';
    if (el?.value?.length > 0) $(btnId)?.classList.add('on');
  });

  updateUndoRedo();

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoAction(); }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redoAction(); }
  });

  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop',     e => e.preventDefault());

  const zone = $('fileBtn');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('has-file'); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('has-file'); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('has-file'); });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('has-file');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['gpx', 'kmz', 'kml', 'xml'].includes(ext)) {
      Swal.fire({ icon: 'warning', title: 'Formato non supportato', text: 'Trascina .gpx, .kmz o .kml', confirmButtonColor: '#1e5aa8' });
      return;
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    $('fileInput').files = dt.files;
    $('fileInput').dispatchEvent(new Event('change'));
  });

  $('fileInput').addEventListener('change', function () {
    const file = this.files[0];
    if (file) {
      const ext = file.name.split('.').pop().toLowerCase();
      zone.classList.add('has-file');
      $('fileBtnText').textContent = file.name;
      $('fileInfo').classList.add('on');
      $('fileInfo').textContent = `File ${ext.toUpperCase()} pronto · ${formatBytes(file.size)}`;
      $('urlIn').value = '';
      $('urlIn').placeholder = 'Disabilitato (file caricato)';
      $('xUrl').classList.remove('on');
      _mapState.sourceFileName = file.name;
    } else {
      zone.classList.remove('has-file');
      $('fileBtnText').textContent = 'Seleziona o trascina qui un file GPX, KMZ o KML';
      $('fileInfo').classList.remove('on');
      $('urlIn').placeholder = 'Incolla qui la URL (Google, Apple Maps, Waze)';
    }
    $('convertBtn').classList.remove('hidden');
  });

  $('urlIn').addEventListener('input', function () {
    if (this.value.trim() && $('fileInput').files[0]) {
      $('fileInput').value = '';
      zone.classList.remove('has-file');
      $('fileBtnText').textContent = 'Seleziona o trascina qui un file GPX, KMZ o KML';
      $('fileInfo').classList.remove('on');
      $('fileInfo').textContent = '';
      $('urlIn').placeholder = 'Incolla qui la URL (Google, Apple Maps, Waze)';
      _mapState.sourceFileName = null;
    }
    $('shortUrlArea')?.classList.remove('on');
  });

  function clearField(inputId, btnId) {
    const el = $(inputId);
    if (el) { el.value = ''; el.dispatchEvent(new Event('input')); el.focus(); }
    $(btnId)?.classList.remove('on');
  }

  ['urlIn', 'expandedUrlIn', 'nameIn'].forEach(id => {
    const el    = $(id);
    const btnId = id === 'urlIn' ? 'xUrl' : id === 'expandedUrlIn' ? 'xExpanded' : 'xName';
    if (el) el.addEventListener('input', () => {
      $(btnId)?.classList.toggle('on', el.value.length > 0);
    });
  });

  // Esposizione globale funzioni HTML
  Object.assign(window, {
    go,
    download,
    clearField,
    toggleAddWaypointPanel: wpUI.toggleAddPanel,
    addWaypointByAddress:   wpUI.addByAddress,
    addWaypointByCoords:    wpUI.addByCoords,
    openExpander,
    toggleHistory,
    updateModelLimit,
    toggleInfoPanel,
    undoAction,
    redoAction,
    decisionExport,
    decisionOptimize,
    decisionWpAdjust,
    decisionWpApply,
    decisionEdit,
    showRemovalLog,
    toggleMapClickMode,
    fitMapToRoute,
  });

  try {
    if (localStorage.getItem('infoPanel_open') === 'true') {
      $('infoPanel').classList.add('open');
      $('infoToggleBtn').classList.add('open');
      $('infoToggleBtn').setAttribute('aria-expanded', 'true');
    }
  } catch (e) {}
}

// ── Dispatcher — garantisce che boot() parta sempre dopo il DOM ───────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// [REFACTORED step①②③④] — task_03_utils.js + task_07_geocoding_client.js estratti; step③ chirurgico interno; step④ _mapState
// v20.1 fix A+B v2: custom DOM panel (no L.popup) — bypassa intercept touch Leaflet; bottoni funzionanti mobile
// [CHECKP_TASK_06] hash: v21.0_popup_fix_exact_mobile
