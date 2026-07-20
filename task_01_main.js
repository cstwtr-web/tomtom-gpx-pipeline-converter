// task_01_main.js
// Orchestratore: collega tutti i moduli, gestisce il flusso principale.
// Questo file è l'unico che tocca il DOM direttamente (tranne task_02).
//
// Step ①② refactor:
//   • Utilità pure            → task_03_utils.js
//   • Geocoding/reverse       → task_06_geocoding_client.js
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
import { createWaypointUI }     from './task_11_waypoints.js';
import { createRoutingEngine }  from './task_10_engine.js';
import { pruneBacktracks } from './task_07_geometry.js';
import { buildGPXString, buildKMLString, buildITNString } from './task_08_export.js';
import { parseFile, extractStops, extractAllWaypointCoords, coordStr, isBlob, blobCoords, isShortUrl } from './task_09_parsers.js';
// ── Step ③ — Componenti Interfaccia Utente (UI) ─────────────────────────────
import {
  renderWaypoints,
  drawRoute,
  getSmartPad,
  onPolylineHover,
  showHoverMarker,
  hideHoverMarker,
} from './task_12_map_component.js';

// ── task_17/18 — Elevazione + grafico altimetrico ────────────────────────────
import { initElevationEnrichment } from './task_17_elevation.js';
import { renderAltitudeChart, onMapHoverLatLng } from './task_18_altitude_chart.js';

import {
  initMapInteraction,
  isMapClickModeActive,
  initMap,
  _applyMapView,
  toggleMapClickMode,
  deleteWaypointFromMap,
} from './task_13_map_interaction.js';

import { initRouteLoader, go } from './task_14_route_loader.js';

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
} from './task_15_decision_panel.js';
// ── Step ① — Utilità pure ────────────────────────────────────────────────────
import {
  $, esc, sleep, formatBytes, setProgress, addLog,
  haversineM, decodePolyline6,
} from './task_03_utils.js';

// ── Dominio waypoint (fonte di verità unica per isSemanticName / computePinnedSet)
import { isSemanticName, computePinnedSet } from './task_04_waypoint_policy.js';

// ── Step ② — Geocoding (Aggiornato con il nuovo modulo isolato)
import {
  geocode, reverseGeocode, nameWaypoints, _extractViewport,
} from './task_06_geocoding_client.js';

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

  // 1. Rendering dei waypoint con eliminazione via hover desktop (bottone rosso)
  renderWaypoints(wps, (idx, lat, lng) => {
    // dragend: aggiorna posizione tappa
    if (typeof decisionWpAdjust === 'function') {
      decisionWpAdjust(idx, lat, lng);
    }
  }, {
    // Hover su marker (desktop) → bottone rosso nel popup → questa callback.
    // Unica funzione di eliminazione tappa-da-mappa (task_13), la stessa
    // richiamata anche dal bottone crosshair mobile: niente più copie
    // indipendenti di Swal + pushSnapshot come nel vecchio onLongPress.
    onDeleteRequest: async (idx, w, label) => {
      if (!$('decision-panel')?.classList.contains('on')) decisionEdit();
      await deleteWaypointFromMap(idx);
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
  const fbCount = state.getRouteFallbackCount(); // solo per nota GPX/KMZ, mai per ITN
  const renameBtn = $('renameFileBtn');

  if (wps.length < 2) {
    // Nessuna rotta valida: la matita resta visibile ma disabilitata, non
    // silenziosamente cliccabile con nessun effetto visibile.
    if (renameBtn) { renameBtn.disabled = true; renameBtn.style.opacity = '0.35'; renameBtn.style.cursor = 'default'; }
    return;
  }
  if (renameBtn) { renameBtn.disabled = false; renameBtn.style.opacity = ''; renameBtn.style.cursor = 'pointer'; }

  let output;
  if (format === 'kmz') {
    const zip = new JSZip();
    zip.file('doc.kml', buildKMLString(wps, name, rpts || null, fbCount));
    output = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  } else if (format === 'kml') {
    output = buildKMLString(wps, name, rpts || null, fbCount);
  } else if (format === 'gpx') {
    output = buildGPXString(wps, name, rpts, fbCount);
  } else {
    output = buildITNString(wps); // ITN: mai la nota, il Rider ricalcola le strade da sé
  }
  state.setOutput(output);
  const dlLabel = $('dlLabel');
  if (dlLabel) dlLabel.textContent = 'Scarica ' + name.replace(/\s+/g, '_') + '.' + format;
}

// ── Rinomina file in fase di export — tocca solo state.name, MAI waypoint/routing ──
function toggleRenamePanel() {
  if (state.getWaypoints().length < 2) return; // matita disabilitata: nessuna rotta da rinominare
  const row   = $('dlLabelRow');
  const panel = $('renamePanel');
  const input = $('renameFileInput');
  if (!row || !panel || !input) return;
  input.value = state.getName();
  row.style.display   = 'none';
  panel.style.display = 'flex';
  input.focus(); input.select();
}

function cancelRenameFile() {
  $('renamePanel').style.display = 'none';
  $('dlLabelRow').style.display  = 'flex';
}

async function confirmRenameFile() {
  const input   = $('renameFileInput');
  const newName = input.value.trim();
  if (!newName) { cancelRenameFile(); return; }
  state.setName(newName);
  await regenerateOutput();   // solo ricostruzione stringa output col nuovo nome — NIENTE routing/waypoint
  cancelRenameFile();
  addLog(`✏️ File rinominato: "${newName}"`, 'ok');
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
    state.setRouteFallbackCount(0); // fast-path Garmin: nessun chunked routing, nessun fallback possibile
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
      state.setRouteFallbackCount(0); // fast-path trkpt: nessun chunked routing, nessun fallback possibile
      addLog(`📍 trkpt: ${wps.length} waypoint, traccia originale ${rpts.length} pt (OSRM bypassato)`, 'dim');
      
      // CAMBIA QUESTA RIGA:
      updateMapVisuals(); 
      
      await regenerateOutput();
      return;
    }
  }

  // ── Routing OSRM/Valhalla (strategia optimistic) ────────────────────────────
  // OSRM risponde veloce (~100-200ms) e visualizza subito la mappa.
  // Se Valhalla risponde dopo (qualità moto migliore), aggiorna silenziosamente.
  const controller = new AbortController();
  state.setPendingRouting(controller);

  // Callback chiamata da fetchSingleRoute se Valhalla arriva DOPO OSRM
  function _applyRoute(route, label) {
    if (!route?.points?.length) return;
    if (state.getPendingRouting() !== controller) return; // abortato nel frattempo
    let pts = pruneBacktracks(route.points, { addLog });
    state.setRouteDistance(route.distance);
    state.setRouteDuration(route.duration);
    state.setRouteFallbackCount(route.fallbackCount ?? 0);
    $('statDist').textContent = (route.distance / 1000).toFixed(1) + ' km';
    const h = Math.floor(route.duration / 3600);
    const m = Math.floor((route.duration % 3600) / 60);
    $('statTime').textContent = `${h}h ${String(m).padStart(2,'0')}m`;
    addLog(`${label}: ${(route.distance/1000).toFixed(1)} km · ${pts.length} punti`, 'ok');
    state.setWaypoints(wps);
    state.setRoutePoints(pts);
    updateMapVisuals();
    regenerateOutput();
  }

  try {
    addLog(wps.length > 10 ? '🔄 Ricalcolo percorso (modalità batch)...' : '🔄 Ricalcolo percorso...', 'info');
    const route = await engine.fetchRouteChunked(wps, controller.signal, (valhallaRoute) => {
      // Upgrade silenzioso: Valhalla arrivato dopo OSRM
      _applyRoute(valhallaRoute, '⬆️ Upgrade Valhalla');
    });
    if (state.getPendingRouting() !== controller) return;
    _applyRoute(route, `✅ Rotta (${route?._src ?? '?'})`);
    addLog(`📍 Waypoint semantici preservati: ${wps.length} tappe`, 'ok');
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
  // FIX freeze mobile: cede il controllo al browser per un frame di rendering
  // prima di eseguire invalidateSize()+fitBounds in _applyMapView().
  // Senza questo yield, drawRoute()+renderWaypoints()+updateDashboard()+
  // showDecisionPanel() e _applyMapView() vengono eseguiti tutti nello stesso
  // tick sincrono: il browser non può fare alcun paint intermedio e l'utente
  // vede la mappa grigia (o parziale) per diversi secondi.
  // requestAnimationFrame garantisce che Leaflet disegni la polilinea e i
  // marker PRIMA che invalidateSize()+fitBounds blocchino nuovamente il thread.
  await new Promise(r => requestAnimationFrame(r));
  // Ultimo step, sempre: a questo punto lista/dashboard/pannello hanno già
  // finito qualsiasi reflow, quindi la view della mappa può essere applicata
  // su dimensioni del contenitore definitive.
  _applyMapView();
}


// FIX "dove è finito il file esportato": su mobile la domanda più comune
// dopo un export è "dove è andato a finire?". Tre livelli, in ordine di
// preferenza:
//  0. File System Access API (showSaveFilePicker): apre il picker di
//     salvataggio NATIVO Android (Storage Access Framework) — lo stesso
//     che il sistema usa per sfogliare Gestore File. Se una microSD è
//     montata (via adattatore OTG o slot integrato), compare come
//     destinazione selezionabile: l'utente può salvare DIRETTAMENTE nella
//     cartella itn della scheda, senza passaggi intermedi. Disponibile su
//     Chrome Android da M132 (stabile dal 2025); non richiede permessi
//     preventivi, il picker stesso è il consenso.
//  1. Se il livello 0 non è disponibile (desktop senza supporto, browser
//     diverso da Chrome, o utente annulla e si preferisce comunque un'altra
//     via) — Web Share API con file (iOS Safari 15+, Chrome Android): apre
//     il pannello di condivisione nativo, l'utente sceglie la destinazione
//     (Drive, Gestore File, invio diretto).
//  2. Se nemmeno lo share è disponibile — fallback al vecchio <a download>
//     (desktop, o mobile senza share-files); qui il toast "File salvato"
//     ha ancora senso, perché è l'unico livello dove la destinazione non è
//     stata scelta esplicitamente dall'utente (finisce sempre in Download).
// download() è async per poter attendere showSaveFilePicker()/share(): i
// due punti da cui viene invocata (window.download?.() da task_15,
// esposizione nell'API pubblica qui sotto) sono entrambi fire-and-forget,
// quindi il cambio è sicuro — nessuno attende il valore di ritorno.

async function download() {
  const output = state.getOutput();
  if (!output) return;
  const name   = state.getName();
  const format = state.getFormat();
  const wps    = state.getWaypoints();
  const fn     = name.replace(/\s+/g, '_') + '.' + format;
  const mime   = format === 'itn' ? 'application/octet-stream'
               : format === 'kml' ? 'application/vnd.google-earth.kml+xml'
               : format === 'kmz' ? 'application/vnd.google-earth.kmz'
               : 'application/gpx+xml';
  const blob   = format === 'kmz' ? output : new Blob([output], { type: mime });

  // ── Tentativo 0: File System Access API — salvataggio diretto (microSD inclusa) ──
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        // suggestedName porta anche l'estensione: su Android il filtro
        // `types` viene ignorato (bug noto Chromium) e senza questo il
        // file finirebbe salvato senza estensione.
        suggestedName: fn,
        types: [{
          description: format.toUpperCase() + ' file',
          accept: { [mime]: ['.' + format] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      addLog(`💾 Salvato direttamente: ${fn} (destinazione scelta dall'utente)`, 'ok');
      return; // l'utente ha scelto lui la destinazione: nessun altro feedback necessario (Caso A)
    } catch (err) {
      if (err?.name === 'AbortError') return; // utente ha annullato il picker volontariamente (Caso 1: resta silenzioso)
      // Qualsiasi altro errore (raro: provider che non supporta scrittura,
      // permesso negato) → prosegue con lo share sotto come livello 1.
      addLog(`⚠️ Salvataggio diretto non riuscito (${err.message}), provo condivisione...`, 'dim');
    }
  }

  // ── Tentativo 1: Web Share API con file (mobile) ─────────────────────────
  try {
    // MIME generico per lo share: 'application/gpx+xml' non è riconosciuto
    // da Android nel matching share-target → canShare torna false su alcuni
    // device (es. Samsung/Chrome). octet-stream è accettato da tutti i target.
    const file = new File([blob], fn, { type: 'application/octet-stream' });
    const _can = navigator.canShare?.({ files: [file] });
    addLog(`🔍 canShare(octet-stream): ${_can}`, 'dim');
    if (_can) {
      await navigator.share({ files: [file], title: name });
      return; // l'utente ha scelto lui la destinazione: nessun altro feedback necessario
    }
  } catch (err) {
    if (err?.name === 'AbortError') return; // utente ha annullato lo share volontariamente (Caso 1: resta silenzioso)
    // qualsiasi altro errore (raro: quota, permessi) → prosegue col fallback sotto
  }

  // ── Tentativo 2 (ultima spiaggia): download classico via <a> ─────────────
  // (desktop senza picker, o mobile senza share-files) — unico livello dove
  // la destinazione non è scelta dall'utente: qui il toast sotto ha senso.
  const itnNote = format === 'itn'
    ? `<br><span style="color:#b45309">⚠️ Il browser potrebbe salvare il file come <strong>.itn.txt</strong>: rinominalo togliendo ".txt" prima di copiarlo su TomTom.</span>`
    : '';

  try {
    // Avvia PRIMA il download: eventuali dialoghi nativi del browser (es. Chrome
    // "Scaricare di nuovo?") compaiono a questo punto, prima che il nostro toast
    // venga creato — così non c'è mai una corsa tra i due elementi.
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), { href: url, download: fn });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    // Caso 3 — ultima spiaggia fallita: nessuna destinazione è stata
    // raggiunta, l'utente deve saperlo esplicitamente (a differenza del
    // Caso 1/annullamento, qui non ha scelto lui di fermarsi).
    addLog(`❌ Download non riuscito: ${err.message}`, 'error');
    Swal.fire({
      icon: 'error',
      title: 'Salvataggio non riuscito',
      text: 'Riprova, o controlla lo spazio disponibile.',
      confirmButtonText: 'Ok',
      confirmButtonColor: '#1e5aa8',
    });
    return;
  }

  // Piccolo ritardo di sicurezza: lascia che un eventuale dialogo nativo del
  // browser finisca di comparire/animarsi prima di disegnare il nostro toast
  // sopra. Poi il toast NON scompare da solo (niente timer): resta visibile
  // finché l'utente non lo chiude lui, così non può mai "perdere" contro un
  // popup nativo che si chiude prima che l'utente abbia fatto in tempo a leggere.
  await sleep(600);
  Swal.fire({
    icon: 'warning',
    title: 'File scaricato',
    html: `<strong>${esc(fn)}</strong>` +
          `<br>nella cartella Download del telefono/browser.${itnNote}`,
    showConfirmButton: true,
    confirmButtonText: 'Ok',
    confirmButtonColor: '#1e5aa8',
    toast: true,
    // In alto (top-end) il toast si sovrapponeva alla notifica nativa
    // "File scaricato" di Chrome/Android (che compare anch'essa in zona
    // alta) e copriva "Elaborazione completata" + il riquadro km/durata/
    // MyDrive compatibile. In basso non c'è nulla di nativo con cui
    // scontrarsi ed è comunque ben visibile.
    position: 'bottom-end',
  });
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

  // Grafico altimetrico (task_18): stesso ciclo di vita della dashboard.
  // Si nasconde da sé (renderAltitudeChart) se le quote non sono disponibili
  // (Open-Elevation fallita, o routing non ancora completato) — mai un
  // errore visibile, coerente col fallimento silenzioso di task_17.
  renderAltitudeChart($('altitudeChartCard'), state.getRoutePoints(), {
    showHoverMarker,
    hideHoverMarker,
  });
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
// NOTA: collideva con un omonimo export di task_12. Tenuta questa versione
// locale su state.getMap()/getRoutePoints()/getWaypoints() con flyToBounds
// animato + fallback sui waypoint grezzi.
// Il padding è delegato a getSmartPad (export di task_12): unica fonte di verità.
// FIX (lentina/bottone insensibile): getSmartPad ora legge le dimensioni
// reali del contenitore via getBoundingClientRect() invece della cache
// interna di Leaflet (map.getSize()), quindi non serve più sperare che
// l'invalidateSize() qui sotto abbia già "fatto effetto" sul reflow del
// browser nello stesso tick sincrono: il padding calcolato è sempre corretto.
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
      map.flyToBounds(bounds, { ...getSmartPad(map), maxZoom: 14, duration: 0.5 });
    }
  } catch (e) {}
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

  // ── Arricchimento elevazione (task_17) — unico state.subscribe('routePoints') ──
  // Copre tutti i punti di uscita del routing (fast-path Garmin, fast-path
  // trkpt, _applyRoute OSRM/Valhalla, rollback deleteWaypoint in task_11) senza
  // hook duplicati nei singoli call-site. Va registrato una sola volta qui.
  initElevationEnrichment({ state, addLog });

  // ── Sync hover mappa→grafico altimetrico (task_18) ──────────────────────
  // Le firme combaciano già ({lat,lon}|null): nessuna conversione necessaria.
  onPolylineHover(onMapHoverLatLng);

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
    verifyRouteEquivalence: null, // task_16 — futuro step D4
  });

  try { state.setHistory(JSON.parse(localStorage.getItem('routeConvHistory') || '[]')); } catch (e) {}

  document.querySelectorAll('.fmt-btn').forEach(b => {
    b.addEventListener('click', async () => {
      _setFormat(b.dataset.fmt);
      if (state.getWaypoints().length >= 2) await regenerateOutput();
    });
  });

  wpUI.updateCountWarning();

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
    toggleRenamePanel,
    confirmRenameFile,
    cancelRenameFile,
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

// [REFACTORED step①②③④] — task_03_utils.js + task_06_geocoding_client.js estratti; step③ chirurgico interno; step④ _mapState
// v20.1 fix A+B v2: custom DOM panel (no L.popup) — bypassa intercept touch Leaflet; bottoni funzionanti mobile
// [CHECKP_TASK_06] hash: v21.0_popup_fix_exact_mobile
// [FASE_3] v22.2: download() → showSaveFilePicker ricorda l'ultima cartella (IndexedDB _HANDLE_DB,
//          startIn = handle salvato, queryPermission/requestPermission riverificati ad ogni export)
// [CHECKP_TASK_07] hash: v22.2_savepicker_startin_idb
// [FASE_4] v22.12: rimossa memoria IndexedDB (_HANDLE_DB/_getLastHandle/_saveLastHandle) — ogni
//          export riparte da zero col picker pulito, niente più banner "Clicca Consenti" né
//          dialog di permesso riproposto. Tentativo 2 ora protetto da try/catch (Caso 3: toast
//          d'errore esplicito se anche il download classico fallisce). Toast finale del
//          Tentativo 2 riscritto: icona warning + "File scaricato...Download" invece di
//          "File salvato" (era fuorviante: comunicava successo pieno anche quando il file non
//          finiva sulla destinazione scelta dall'utente). Caso A (Tentativo 0 riuscito) e Caso 1
//          (annullamento volontario) restano silenziosi by design.
// [CHECKP_TASK_08] hash: v22.12_export_feedback_rewrite
// [ELEVAZIONE+GRAFICO] boot(): initElevationEnrichment({state,addLog}) — unico state.subscribe
//          su 'routePoints' (task_17). onPolylineHover(onMapHoverLatLng) — sync hover
//          mappa→grafico (task_18). updateDashboard(): renderAltitudeChart() integrato nello
//          stesso ciclo di vita di fullStateRefresh()→updateDashboard(), degrado silenzioso
//          se le quote non sono disponibili. Nessuna modifica a routing/pruning/DP/export
//          oltre al fix mirato già descritto in task_08_export.js.
// [CHECKP_TASK_09] hash: v23.0_elevation_altitude_chart
