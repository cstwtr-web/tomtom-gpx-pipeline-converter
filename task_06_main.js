// task_06 - hash_input: f8a3d5c (Route_converter_v18.0)
// Orchestratore: collega tutti i moduli, gestisce il flusso principale.
// Questo file è l'unico che tocca il DOM direttamente (tranne task_02).

import { createState }          from './task_01_state.js';
import { createWaypointUI }     from './task_02_waypoints.js';
import { createRoutingEngine }  from './task_03_engine.js';
import { pruneBacktracks, sampleCriticalWaypointsFromGeometry, redistributeByDistance, motoOptimize } from './task_04_geometry.js';
import { buildGPXString, buildKMLString, buildITNString } from './task_05_export.js';
import { parseFile, extractStops, extractAllWaypointCoords, coordStr, isBlob, blobCoords, isShortUrl } from './task_07_parsers.js';

// ── Dipendenze globali (CDN) ──────────────────────────────────────────────────
// Leaflet → window.L, JSZip → window.JSZip, SweetAlert2 → window.Swal
const $ = id => document.getElementById(id);

// ── Utilità ───────────────────────────────────────────────────────────────────
const esc   = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function setProgress(p) { $('progBar').style.width = p + '%'; }

function addLog(msg, t = 'dim') {
  const icons = { ok:'●', info:'◆', dim:'○', warn:'◆' };
  const d = document.createElement('div');
  d.className = 'log-row l-' + t;
  d.innerHTML = `<span class="d">${icons[t] || '○'}</span><span>${msg}</span>`;
  $('logEl').appendChild(d);
  $('logEl').scrollTop = 9999;
}

function decodePolyline6(encoded) {
  const factor = 1e6;
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push({ lat: lat / factor, lon: lng / factor });
  }
  return coords;
}

// ── Geocode (Nominatim) ───────────────────────────────────────────────────────
// Regex Plus Code (Open Location Code): es. H4JJ+2J  oppure 8FVC9G8F+6W
const _PLUS_CODE_RE = /\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;

async function _geocodePlusCode(plusCode, contextHint) {
  // Nominatim supporta Plus Code come query diretta (v4.2+).
  // Prima proviamo il codice isolato, poi con il contesto geografico.
  const queries = [plusCode, contextHint ? `${plusCode} ${contextHint}` : null].filter(Boolean);
  for (const q of queries) {
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=it,en`,
        { headers: { 'User-Agent': 'TomTomRouteConverter/10.0' } }
      );
      if (r.ok) {
        const data = await r.json();
        if (data?.length > 0) {
          const name = data[0].display_name.split(',')[0].trim();
          addLog(` Plus Code "${plusCode}" → ${name}`, 'ok');
          return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), name };
        }
      }
    } catch (e) { /* prossimo tentativo */ }
  }
  return null; // segnala fallimento → geocode() cade nel loop standard
}

async function geocode(q) {
  // ── Intercetta Plus Code prima del loop Nominatim ──────────────────────────
  // Esempio: "Cascata del Rio Malinfier, H4JJ+2J, 33027 Paularo UD"
  // Il loop standard lo deforma nei tentativi successivi perdendo il codice.
  const plusMatch = q.match(_PLUS_CODE_RE);
  if (plusMatch) {
    addLog(` Rilevato Plus Code: "${plusMatch[1]}"`, 'dim');
    const contextHint = q.replace(plusMatch[0], '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
    const result = await _geocodePlusCode(plusMatch[1], contextHint || null);
    if (result) return result;
    addLog(` Plus Code non risolto via Nominatim, fallback su query testuale`, 'warn');
  }

  // ── Loop tentativi Nominatim standard ─────────────────────────────────────
  const attempts = [
    q.trim(),
    q.trim().replace(/,\s*\d{5}.*$/, '').trim(),
    q.trim().split(',')[0].replace(/\d+/g, '').trim(),
    q.trim().replace(/[^a-zA-Z\s]/g, ' ').replace(/\s+/g, ' ').trim(),
  ];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (!attempt || attempt.length < 3) continue;
    try {
      addLog(` Tentativo ${i + 1}: "${attempt}"`, 'dim');
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(attempt)}&format=json&limit=1&accept-language=it,en`,
        { headers: { 'User-Agent': 'TomTomRouteConverter/10.0' } }
      );
      if (r.ok) {
        const data = await r.json();
        if (data?.length > 0) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), name: data[0].display_name.split(',')[0].trim() };
      }
    } catch (e) { /* next attempt */ }
  }
  throw new Error(`Impossibile geocodificare: "${q}"`);
}

// ── Reverse geocode (Nominatim) ───────────────────────────────────────────────
// Restituisce il nome leggibile più corto disponibile per lat/lon.
// Best-effort: in caso di errore restituisce null (il chiamante usa "Via N").
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&accept-language=it,en`,
      { headers: { 'User-Agent': 'TomTomRouteConverter/10.0' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const a = data.address || {};
    return (
      a.village || a.town || a.city || a.municipality ||
      a.road    || a.hamlet || a.suburb ||
      data.display_name?.split(',')[0]?.trim() ||
      null
    );
  } catch { return null; }
}

// ── Geocoding inverso di una lista di waypoint (rate limit 1s Nominatim) ─────
// Partenza e Destinazione ricevono nomi fissi.
// Waypoint intermedi: Nominatim best-effort, fallback "Via N".
async function nameWaypoints(wps, { addLog: log, setProgress: sp, progressFrom = 50, progressTo = 70 } = {}) {
  const named = wps.map(p => ({ ...p }));
  const intermediates = named.length - 2; // escludi primo e ultimo
  for (let i = 0; i < named.length; i++) {
    if (i === 0)               { named[i].name = 'Partenza';     continue; }
    if (i === named.length -1) { named[i].name = 'Destinazione'; continue; }
    const n = await reverseGeocode(named[i].lat, named[i].lon);
    named[i].name = n || `Via ${i}`;
    log?.(`  Via ${i}: ${named[i].name}`, 'dim');
    if (i < named.length - 2) await sleep(1100); // rispetta rate limit Nominatim
    if (sp && intermediates > 0) {
      sp(progressFrom + Math.round((progressTo - progressFrom) * i / intermediates));
    }
  }
  return named;
}

// ── Init moduli ───────────────────────────────────────────────────────────────
const state   = createState();
const engine  = createRoutingEngine({ decodePolyline6, addLog, sleep });
const wpUI    = createWaypointUI({ state, geocode, fullStateRefresh, regenerateOutput, addLog, esc, sleep, Swal: window.Swal, $ });

// ── Undo / Redo UI (Fase 2) ───────────────────────────────────────────────────
// Aggiorna lo stato disabilitato/abilitato dei pulsanti e il loro tooltip.
// Chiamato ogni volta che lo state emette 'snapshot' o 'waypoints'.
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

// ── [FASE 4] State locale — non modifica task_01_state.js ────────────────────
// Tre slot aggiuntivi gestiti con una chiusura locale e patch duck-typing su state.
const _f4 = {
  overlayVisible: false,
  originalLayer:  null,
  removalLog:     null,
};
state.getOverlayVisible  = ()  => _f4.overlayVisible;
state.setOverlayVisible  = (v) => { _f4.overlayVisible = v; };
state.getOriginalLayer   = ()  => _f4.originalLayer;
state.setOriginalLayer   = (l) => { _f4.originalLayer = l; };
state.getRemovalLog      = ()  => _f4.removalLog;
state.setRemovalLog      = (l) => { _f4.removalLog = l; };


// ── Mappa Leaflet ─────────────────────────────────────────────────────────────
function initMap() {
  const wps = state.getWaypoints();
  if (!$('mapPreview').classList.contains('on') || wps.length < 2) return;

  let map         = state.getMap();
  let tileLayer   = state.getTileLayerRef();

  if (!map) {
    // FIX scroll mobile: su touch device 1 dito deve scorrere la pagina, non spostare la mappa.
    // dragging viene disabilitato di default; il gesture handler qui sotto lo riabilita
    // solo quando vengono rilevate 2 dita contemporanee (pan) o un pinch (zoom).
    // tap:false disabilita il tap-handler nativo di Leaflet (che confligge con il nostro
    // long-press e con il mode click-insert): usiamo esclusivamente i nostri listener.
    map = L.map('mapPreview', {
      dragging:        !L.Browser.mobile,
      tap:             false,
      scrollWheelZoom: true,
    }).setView([wps[0].lat, wps[0].lon], 10);
    tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    state.setMap(map);
    state.setTileLayerRef(tileLayer);
  }

  map.eachLayer(l => { if (l !== tileLayer) map.removeLayer(l); });

  const routePoints = state.getRoutePoints();
  if (routePoints?.length > 0) {
    L.polyline(routePoints.map(p => [p.lat, p.lon]), { color: '#1e5aa8', weight: 5, opacity: 0.9, lineJoin: 'round' }).addTo(map);
  } else {
    L.polyline(wps.map(w => [w.lat, w.lon]), { color: '#f59e0b', weight: 4, dashArray: '8, 12', opacity: 0.85 }).addTo(map);
  }

  // [FASE 4] Overlay traccia originale (linea grigia semitrasparente).
  // Costruito ogni volta che initMap() viene richiamato; il layer viene aggiunto
  // alla mappa solo se il toggle è attivo, altrimenti resta "in standby".
  const rawPts = state.getRawRoutePoints();
  if (rawPts?.length > 0 && rawPts !== state.getRoutePoints()) {
    const overlayLayer = L.polyline(rawPts.map(p => [p.lat, p.lon]), {
      color: '#999', opacity: 0.4, weight: 3, dashArray: '4, 6',
    });
    if (state.getOverlayVisible()) overlayLayer.addTo(map);
    state.setOriginalLayer(overlayLayer);
  } else {
    state.setOriginalLayer(null);
  }

  // Insieme dei DOM element dei marker — usato dal long-press su sfondo mappa
  // per distinguere "ho premuto su un marker" (→ non attivare insert mode).
  const _markerEls = new Set();

  wps.forEach((w, i) => {
    const isFirst = i === 0;
    const isLast  = i === wps.length - 1;
    const label   = isFirst ? 'A — Partenza' : isLast ? 'B — Arrivo' : `Tappa ${i}`;

    const marker = L.marker([w.lat, w.lon]).addTo(map);

    // Popup con hint discoverability: l'utente vede subito come rimuovere la tappa.
    // Il click normale apre il popup; il long-press (500ms) avvia la rimozione.
    const hintHtml = wps.length > 2
      ? `<div style="margin-top:6px;font-size:10px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:5px;">
           🖐️ Tieni premuto per rimuovere
         </div>`
      : '';  // non mostrare hint se sono rimaste solo 2 tappe (non si può rimuovere)
    marker.bindPopup(
      `<b>${esc(w.name)}</b><br><span style="color:#6b7280;font-size:11px;">${label}</span>${hintHtml}`,
      { maxWidth: 220 }
    );

    // Traccia l'elemento DOM del marker per escluderlo dal long-press su sfondo
    marker.on('add', () => {
      // FIX timing: su alcune versioni di Leaflet marker.getElement() restituisce null
      // durante il callback 'add' perché il DOM non è ancora completamente attaccato.
      // setTimeout(0) cede il controllo al browser per un tick, garantendo che l'elemento
      // sia disponibile prima di applicare stili e listener.
      setTimeout(() => {
        const el = marker.getElement();
        if (!el) return;
        _markerEls.add(el);
        // FIX mobile long-press: blocca il menu contestuale nativo del browser.
        // Su Chrome/Safari mobile, un long-press su <img> (il marker Leaflet è un <img>)
        // apre "Salva immagine / Condividi" prima che scatti il nostro timer a 500ms.
        // Tre layer di difesa sovrapposti:
        //   1. touch-action: none        → impedisce al browser di gestire pan/pinch
        //                                  sull'elemento; prerequisito per preventDefault
        //   2. -webkit-touch-callout     → disabilita il callout iOS (anteprima link/img)
        //   3. user-select: none         → blocca la selezione testo/immagine al tocco
        el.style.touchAction        = 'none';
        el.style.webkitTouchCallout = 'none';
        el.style.userSelect         = 'none';
        el.style.webkitUserSelect   = 'none';
        // Listener nativo { passive: false } necessario per poter chiamare
        // preventDefault() e bloccare il contextmenu *prima* che il browser
        // lo mostri. Leaflet lega touchstart con passive:true su molte versioni,
        // per cui il nostro ev.preventDefault() via Leaflet arriva troppo tardi.
        el.addEventListener('touchstart',  (e) => e.preventDefault(), { passive: false });
        el.addEventListener('contextmenu', (e) => e.preventDefault());
      }, 0);
    });
    marker.on('remove', () => {
      const el = marker.getElement();
      if (el) _markerEls.delete(el);
    });

    // ── Long-press su marker → rimozione tappa ────────────────────────────
    // mousedown gestisce desktop; touchstart gestisce mobile.
    // Non interferisce con il click normale (che apre il popup).
    let _mLpTimer = null;
    const LP_MARKER_MS = 500;

    marker.on('mousedown touchstart', (ev) => {
      // touchstart non ha ev.originalEvent.button
      const oe = ev.originalEvent;
      if (oe.button !== undefined && oe.button !== 0) return;
      // Secondo layer: chiama preventDefault anche tramite Leaflet per i browser
      // che non hanno ancora ricevuto il listener nativo sull'elemento (es. primo render).
      if (oe.type === 'touchstart') oe.preventDefault();
      _mLpTimer = setTimeout(async () => {
        _mLpTimer = null;
        // Chiudi eventuale popup aperto
        marker.closePopup();
        map.closePopup();

        // Impedisci che il click successivo apra il popup
        marker.once('click', (e) => { L.DomEvent.stopPropagation(e); });

        // Vibrazione best-effort
        try { navigator.vibrate?.(60); } catch (_) {}

        // Non permettere rimozione se rimangono solo 2 tappe
        const wpsNow = state.getWaypoints();
        if (wpsNow.length <= 2) {
          addLog(`⚠️ Impossibile rimuovere: servono almeno 2 tappe`, 'warn');
          return;
        }

        // Popup di conferma rimozione
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

        const updated = state.getWaypoints().filter((_, idx) => idx !== i);
        state.setWaypoints(updated);
        state.pushSnapshot(`Tappa rimossa dalla mappa: "${w.name}"`);
        addLog(`🗑️ Tappa rimossa: "${w.name}" (${label})`, 'ok');
        await fullStateRefresh();
      }, LP_MARKER_MS);
    });

    // Cancella il timer se il pointer si sposta o si alza.
    // FIX v18.5 — su touch device, Leaflet emette un mouseup sintetico subito dopo
    // il touchend; ignorarlo altrimenti cancella il long-press timer prima dei 500ms
    // rendendo impossibile rimuovere una tappa con il long-press su mobile.
    marker.on('mouseup touchend touchcancel', (ev) => {
      const oe = ev.originalEvent;
      if (oe && oe.type === 'mouseup' && 'ontouchstart' in window) return;
      if (_mLpTimer) { clearTimeout(_mLpTimer); _mLpTimer = null; }
    });
    marker.on('drag movestart', () => {
      if (_mLpTimer) { clearTimeout(_mLpTimer); _mLpTimer = null; }
    });
  });

  // ── Map Click Mode handler ────────────────────────────────────────────────
  // Rimuoviamo listener precedente (se initMap() viene richiamato più volte)
  // usando un flag sul riferimento mappa.
  if (map._rcClickHandler) map.off('click', map._rcClickHandler);
  map._rcClickHandler = async function(e) {
    if (!_mapClickModeActive) return;
    // FIX propagation leak — timestamp invece di flag booleano.
    // Il flag booleano (_rcIgnoreNextClick) falliva perché Leaflet accoda l'evento
    // PRIMA che toggleMapClickMode() potesse impostare il flag.
    // Con il timestamp: all'attivazione si segna Date.now()+350; ogni click
    // che arriva entro quella finestra viene scartato, indipendentemente dall'ordine.
    if (map._rcIgnoreUntil && Date.now() < map._rcIgnoreUntil) return;
    const { lat, lng } = e.latlng;
    addLog(`📍 Click mappa: (${lat.toFixed(5)}, ${lng.toFixed(5)})`, 'dim');

    // FIX popup multipli: chiudi l'eventuale popup precedente prima di aprirne uno nuovo.
    // Senza questo, ogni click in modalità editing accumulava popup sovrapposti.
    if (map._rcActivePopup) {
      map.closePopup(map._rcActivePopup);
      map._rcActivePopup = null;
    }

    // Mostra popup con scelta: snap al tracciato oppure coordinata esatta.
    // closeOnClick:false → il popup non si chiude se l'utente clicca fuori
    //   (eviterebbe il "rimbalzo" che riapre subito un nuovo popup tramite il
    //   click handler); la chiusura è affidata esclusivamente ai tre bottoni.
    // autoClose:false → necessario insieme a closeOnClick:false per impedire che
    //   Leaflet chiuda il popup quando ne viene aperto un altro.
    const popup = L.popup({ closeOnClick: false, autoClose: false })
      .setLatLng(e.latlng)
      .setContent(`
        <div style="font-family:inherit;font-size:12px;line-height:1.7;min-width:200px;">
          <div style="font-weight:700;margin-bottom:6px;color:#0f2b4d;">📍 Aggiungi tappa</div>
          <div style="color:#4a6fa5;margin-bottom:10px;font-size:11px;">
            ${lat.toFixed(5)}, ${lng.toFixed(5)}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <button id="rc-popup-snap"
              style="background:#1e5aa8;color:#fff;border:none;border-radius:8px;
                     padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600;text-align:left;">
              📌 Inserisci sul tracciato
              <div style="font-weight:400;font-size:10px;opacity:.85;">snap alla strada più vicina</div>
            </button>
            <button id="rc-popup-exact"
              style="background:#10b981;color:#fff;border:none;border-radius:8px;
                     padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600;text-align:left;">
              🎯 Inserisci qui esatto
              <div style="font-weight:400;font-size:10px;opacity:.85;">coordinata precisa, no snap</div>
            </button>
            <button id="rc-popup-cancel"
              style="background:transparent;color:#7a96b5;border:1px solid #b8d4f0;border-radius:8px;
                     padding:5px 12px;cursor:pointer;font-size:11px;">
              Annulla
            </button>
          </div>
        </div>
      `)
      .openOn(map);
    map._rcActivePopup = popup;

    // Handler bottoni popup — registrati con setTimeout per garantire che il DOM
    // del popup sia stato inserito da Leaflet prima di cercare gli elementi.
    setTimeout(() => {
      const btnSnap   = document.getElementById('rc-popup-snap');
      const btnExact  = document.getElementById('rc-popup-exact');
      const btnCancel = document.getElementById('rc-popup-cancel');

      if (btnSnap) btnSnap.addEventListener('click', async () => {
        map.closePopup(popup);
        map._rcActivePopup = null;
        // La modalità editing rimane attiva: l'utente può continuare ad aggiungere tappe.
        // toggleMapClickMode() NON viene chiamato — uscita solo con il tasto ✕ o ESC.
        await _insertWaypointAtLatLon(lat, lng, false); // snap normale
      });
      if (btnExact) btnExact.addEventListener('click', async () => {
        map.closePopup(popup);
        map._rcActivePopup = null;
        await _insertWaypointAtLatLon(lat, lng, true); // forceRaw = no snap
      });
      if (btnCancel) btnCancel.addEventListener('click', () => {
        // FIX rimbalzo Annulla: chiudiamo il popup ma NON propaghiamo il click alla mappa.
        // Senza stopPropagation il click "Annulla" attraversava il DOM, veniva catturato
        // dal click-handler della mappa e riaprива immediatamente un nuovo popup.
        map.closePopup(popup);
        map._rcActivePopup = null;
        // Modalità editing resta attiva — l'utente può fare un altro click.
      });
    }, 50);
  };
  map.on('click', map._rcClickHandler);

  // ── Blocco contextmenu globale su marker (capture phase) ────────────────
  // Registrato una sola volta. Blocca il menu contestuale nativo di Android Chrome
  // ("Salva immagine") su tutti i marker figli. Il flag _rcContextMenuAdded
  // impedisce listener duplicati se initMap() viene richiamato più volte.
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

  // ── Two-finger gesture handler (mobile) ──────────────────────────────────
  // Abilita il pan Leaflet solo quando ci sono 2+ dita sullo schermo.
  // Con 1 dito il touch propaga al browser → la pagina scrolla normalmente.
  // Registrato una sola volta (flag _rcGestureAdded), funziona anche dopo
  // refresh della mappa (add/remove tappa, undo/redo).
  if (!map._rcGestureAdded && L.Browser.mobile) {
    const _mapElG = $('mapPreview');

    _mapElG.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) {
        // Due dita: abilita pan+zoom Leaflet
        map.dragging.enable();
      }
    }, { passive: true });

    _mapElG.addEventListener('touchend', (e) => {
      // Appena si torna a meno di 2 dita, ridisabilita il drag
      // così il prossimo 1-dito scrolla di nuovo la pagina.
      if (e.touches.length < 2) {
        map.dragging.disable();
      }
    }, { passive: true });

    _mapElG.addEventListener('touchcancel', () => {
      map.dragging.disable();
    }, { passive: true });

    map._rcGestureAdded = true;
  }

  // Mostra il pulsante "Modifica mappa" (stile controllo Leaflet).
  const editCtrl = $('map-edit-ctrl');
  if (editCtrl) editCtrl.style.display = 'flex';

  // FIX propagation leak: registra il click sul pulsante ✏️ direttamente qui,
  // così possiamo impostare _rcIgnoreUntil PRIMA che toggleMapClickMode() venga
  // chiamato dall'onclick HTML. Il timestamp blocca il click handler della mappa
  // che altrimenti riceverebbe lo stesso evento per propagazione.
  const editBtn = $('map-edit-btn');
  if (editBtn && !editBtn._rcClickAdded) {
    editBtn.addEventListener('click', () => {
      map._rcIgnoreUntil = Date.now() + 400;
    });
    editBtn._rcClickAdded = true;
  }

  // fitBounds solo al primo caricamento — i refresh successivi (add/remove tappa)
  // conservano zoom e centro corrente per non disorientare l'utente.
  if (!map._rcInitialFitDone) {
    try { map.fitBounds(L.latLngBounds(wps.map(w => [w.lat, w.lon])).pad(0.12)); } catch (e) {}
    map._rcInitialFitDone = true;
  }
  requestAnimationFrame(() => {
    setTimeout(() => map.invalidateSize(), 80);
    if (!map._rcResizeListenerAdded) {
      window.addEventListener('resize', () => { clearTimeout(map._rcResizeTimer); map._rcResizeTimer = setTimeout(() => map.invalidateSize(), 120); });
      map._rcResizeListenerAdded = true;
    }
  });
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

// ── _setFormat: aggiorna stato + UI bottoni formato ───────────────────────────
function _setFormat(fmt) {
  state.setFormat(fmt);
  document.querySelectorAll('.fmt-btn').forEach(b => b.classList.toggle('active', b.dataset.fmt === fmt));
  // Il testo del bottone "Elabora percorso" non cambia mai.
}

// ── updateRoutingAndUI ────────────────────────────────────────────────────────
// Chiamata dopo ogni modifica ai waypoint (drag, edit, delete, add).
// Per trkpt: bypassa OSRM, usa routePoints già impostato in go().
// Per tutti gli altri: chiama OSRM → aggiorna routePoints.
async function updateRoutingAndUI() {
  const wps     = state.getWaypoints();
  const wpLimit = state.getWpLimit();
  if (wps.length < 2) return;

  const pending = state.getPendingRouting();
  if (pending) { pending.abort?.(); state.setPendingRouting(null); }

  // Fast-path Garmin Hybrid: usa traccia GPS grezza, bypassa OSRM
  const garminRaw = state.getGarminHybridRawPoints();
  if (garminRaw?.length > 0) {
    state.setRoutePoints(garminRaw);
    state.setRawRoutePoints(garminRaw); // salva pre-pruning per rilevamento inversioni
    state.setGarminHybridRawPoints(null);
    const dist = garminRaw.reduce((acc, p, i, arr) => {
      if (i === 0) return 0;
      const prev = arr[i - 1];
      const dLat = (p.lat - prev.lat) * Math.PI / 180;
      const dLon = (p.lon - prev.lon) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(prev.lat*Math.PI/180)*Math.cos(p.lat*Math.PI/180)*Math.sin(dLon/2)**2;
      return acc + 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }, 0);
    state.setRouteDistance(dist);
    state.setRouteDuration(0);
    $('statDist').textContent = (dist / 1000).toFixed(1) + ' km';
    $('statTime').textContent = '—';
    addLog(`✅ Traccia Garmin originale: ${garminRaw.length} punti · ${(dist/1000).toFixed(1)} km (OSRM bypassato)`, 'ok');
    addLog(`📍 Waypoint Garmin originali preservati: ${wps.length} tappe (rtept nominali inviolabili)`, 'ok');
    initMap();
    await regenerateOutput();
    return;
  }

  // Fast-path trkpt: routePoints già impostato in go(), bypassa OSRM
  const sourceType = state.getGpxSourceType();
  if (sourceType === 'trkpt') {
    // routePoints è già la traccia originale — non toccare
    const rpts = state.getRoutePoints();
    if (rpts?.length > 0) {
      addLog(`📍 trkpt: ${wps.length} waypoint, traccia originale ${rpts.length} pt (OSRM bypassato)`, 'dim');
      initMap();
      await regenerateOutput();
      return;
    }
  }

  // Routing OSRM/Valhalla per waypoint semantici (rtept, wpt, url)
  const sourceTypeForRouting = state.getGpxSourceType();

  const controller = new AbortController();
  state.setPendingRouting(controller);
  try {
    addLog('🔄 Ricalcolo percorso (chunked mode)...', 'info');
    const route = await engine.fetchRouteChunked(wps, controller.signal);
    if (state.getPendingRouting() !== controller) return;

    if (route?.points?.length > 0) {
      // Salva geometria grezza pre-pruning per rilevamento inversioni
      // Non sovrascrivere se già popolato da fast-path Garmin
      if (!state.getRawRoutePoints()) {
        state.setRawRoutePoints(route.points);
        addLog(`📦 rawRoutePoints salvati: ${route.points.length} punti (pre-pruning)`, 'dim');
      }

      let pts = pruneBacktracks(route.points, { addLog });
      addLog(`📐 Geometria dopo pruning: ${pts.length} punti`, 'info');

      state.setRouteDistance(route.distance);
      state.setRouteDuration(route.duration);
      $('statDist').textContent = (route.distance / 1000).toFixed(1) + ' km';
      const h = Math.floor(route.duration / 3600);
      const m = Math.floor((route.duration % 3600) / 60);
      $('statTime').textContent = `${h}h ${String(m).padStart(2,'0')}m`;
      addLog(`✅ Rotta: ${(route.distance/1000).toFixed(1)} km · ${pts.length} punti`, 'ok');

      // Waypoint semantici INVIOLABILI — non applicare DP sui WP originali.
      // DP è applicato solo sulla geometria (pts) per la mappa e il <trk> GPX.
      // Caso estremo (>255 WP nominali): DP adattivo con consenso esplicito in go().
      state.setWaypoints(wps);
      state.setRoutePoints(pts);

      addLog(`📍 Waypoint semantici preservati: ${wps.length} tappe`, 'ok');
      initMap();
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
  // Se non ci sono più abbastanza tappe, disattiva modalità inserimento
  if (state.getWaypoints().length < 2 && _mapClickModeActive) toggleMapClickMode(true);
  // Aggiorna dashboard (Fase 1)
  updateDashboard();
  // Aggiorna pannello decisionale se già visibile (Fase 3)
  if ($('decision-panel')?.classList.contains('on')) showDecisionPanel();
}

// ── _consentGate: cancello di consenso post-elaborazione ─────────────────────
// Scatta solo se wps > wpLimit e sourceType !== 'trkpt'.
// Tre vie: riduci / mantieni→ITN / modifica manualmente.
// Restituisce 'reduced' | 'itn' | 'manual'.
async function _consentGate(wpCount, wpLimit) {
  document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('fmt-recommended'));
  const itnBtn = document.querySelector('.fmt-btn[data-fmt="itn"]');
  if (itnBtn) itnBtn.classList.add('fmt-recommended');

  const result = await Swal.fire({
    icon: 'warning',
    title: `Hai ${wpCount} tappe`,
    html: `L'App TomTom MyDrive EU (wireless) ne accetta max <b>20</b>.<br><br>
           <b>✂️ Riduci automaticamente:</b> mantiene le tappe alle curve e ai bivi, rimuove quelle sui rettilinei dove il navigatore non ha bisogno di indicazioni. Non puoi scegliere quali — decide la geometria del percorso.<br><br>
           <b>💾 Mantieni tutte:</b> nessuna tappa viene toccata. Esporti via cavo o microSD (fino a 255 tappe).<br><br>
           <b>✏️ Modifico manualmente:</b> torno alla lista e decido io quali tappe eliminare.`,
    confirmButtonText: `✂️ Riduci a ${wpLimit} tappe`,
    confirmButtonColor: '#1e5aa8',
    showDenyButton: true,
    denyButtonText: '💾 Mantieni tutte',
    denyButtonColor: '#6b7280',
    showCancelButton: true,
    cancelButtonText: '✏️ Modifico manualmente',
    cancelButtonColor: '#9ca3af',
  });

  if (result.isConfirmed)  return 'reduced';
  if (result.isDenied)     return 'itn';
  return 'manual';
}



// ── Flag formato scelto dall'utente ──────────────────────────────────────────
// Impostato a true quando l'utente clicca esplicitamente un bottone formato.
// Usato da decisionExport() per decidere se aprire il popup di selezione.
let _userHasChosenFormat = false;

// ── Map Click Mode: aggiungi tappa cliccando sulla mappa ─────────────────────
let _mapClickModeActive = false;

function toggleMapClickMode(forceOff = false) {
  if (forceOff) _mapClickModeActive = true; // verrà invertito sotto
  _mapClickModeActive = !_mapClickModeActive;

  const mapEl   = $('mapPreview');
  const btn     = $('map-edit-btn');
  const icon    = $('map-edit-icon');
  const label   = $('map-edit-label');
  const banner  = $('map-edit-banner');
  const ctrl    = $('map-edit-ctrl');
  const hint    = $('map-edit-hint');

  if (mapEl) mapEl.classList.toggle('crosshair-mode', _mapClickModeActive);

  if (_mapClickModeActive) {
    // ── Stato ON ──────────────────────────────────────────────────────────
    if (btn)    { btn.style.background = '#1e5aa8'; btn.style.color = '#fff'; btn.style.borderColor = '#1e5aa8'; btn.setAttribute('aria-pressed', 'true'); btn.title = 'Esci dalla modalità modifica (o premi ESC)'; }
    if (icon)   icon.textContent = '✕';
    if (label)  label.textContent = 'Esci';
    if (banner) banner.style.display = 'block';
    if (hint)   hint.style.display   = 'none';
    if (ctrl)   ctrl.style.flexDirection = 'column';

    // ESC per uscire — registrato una sola volta e rimosso all'uscita
    if (!toggleMapClickMode._escHandler) {
      toggleMapClickMode._escHandler = (e) => {
        if (e.key === 'Escape' && _mapClickModeActive) toggleMapClickMode(true);
      };
      document.addEventListener('keydown', toggleMapClickMode._escHandler);
    }

    addLog('✏️ Modifica mappa attiva — tocca per aggiungere · tieni premuto su tappa per rimuovere · ESC per uscire', 'info');

  } else {
    // ── Stato OFF ─────────────────────────────────────────────────────────
    // FIX popup residuo: chiudi il popup "Aggiungi tappa" se è ancora aperto
    // quando l'utente preme ✕ Esci o ESC.
    const mapOff = state.getMap();
    if (mapOff && mapOff._rcActivePopup) {
      mapOff.closePopup(mapOff._rcActivePopup);
      mapOff._rcActivePopup = null;
    }
    if (btn)    { btn.style.background = '#fff'; btn.style.color = '#444'; btn.style.borderColor = 'rgba(0,0,0,0.25)'; btn.setAttribute('aria-pressed', 'false'); btn.title = 'Abilita modifica mappa'; }
    if (icon)   icon.textContent = '✏️';
    if (label)  label.textContent = 'Modifica';
    if (banner) banner.style.display = 'none';
    if (hint)   hint.style.display   = 'block';

    // Rimuovi handler ESC
    if (toggleMapClickMode._escHandler) {
      document.removeEventListener('keydown', toggleMapClickMode._escHandler);
      toggleMapClickMode._escHandler = null;
    }

    addLog('✏️ Modifica mappa disattivata', 'dim');
  }
}

// Inserisce un waypoint nel punto della rotta più vicino al click.
// Strategia posizionamento:
//   1. Trova il routePoint più vicino al click (haversine)
//   2. Determina il segmento WP[k]→WP[k+1] a cui appartiene tramite
//      distribuzione proporzionale progressiva dei routePoints
//   3. Inserisce nella lista WP dopo WP[k]
//   4. Reverse geocode best-effort per dare un nome leggibile
async function _insertWaypointAtLatLon(lat, lon, forceRaw = false) {
  const routePts = state.getRoutePoints();
  const wps      = state.getWaypoints();

  let snapLat = lat, snapLon = lon;

  // ── Step 1: snap al routePoint più vicino (se disponibile e non forzato) ──
  if (!forceRaw && routePts?.length > 0) {
    const haversineM = (a, b) => {
      const R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180;
      const dLon = (b.lon - a.lon) * Math.PI / 180;
      const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
    };
    let minDist = Infinity, minIdx = 0;
    for (let i = 0; i < routePts.length; i++) {
      const d = haversineM({ lat, lon }, routePts[i]);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    snapLat = routePts[minIdx].lat;
    snapLon = routePts[minIdx].lon;
    addLog(`📍 Snap al tracciato: ${minDist.toFixed(0)}m dal click`, 'dim');

    // ── Step 2: trova il segmento WP a cui appartiene minIdx ──
    // Distribuiamo i routePoints uniformemente tra i segmenti WP[k]→WP[k+1].
    // Il segmento k occupa la fascia [k/N … (k+1)/N] dell'array routePts.
    const N = wps.length - 1;
    const fraction = minIdx / Math.max(routePts.length - 1, 1);
    const insertAfterIdx = Math.min(Math.floor(fraction * N), N - 1);

    // ── Step 3: reverse geocode ──
    addLog(`⏳ Reverse geocode in corso…`, 'dim');
    const name = await reverseGeocode(snapLat, snapLon) || `${snapLat.toFixed(5)}, ${snapLon.toFixed(5)}`;

    // ── Step 4: inserisce il waypoint ──
    const newWp = {
      lat: snapLat, lon: snapLon, name,
      countryCode: null, adminRegion: null, placeType: null,
      source: 'user_click', snapToleranceMeters: 50, userMarkedObligatory: false,
    };
    const updated = [...wps];
    updated.splice(insertAfterIdx + 1, 0, newWp);
    state.setWaypoints(updated);
    addLog(`➕ Tappa inserita: "${name}" dopo tappa ${insertAfterIdx + 1} → totale ${updated.length} tappe`, 'ok');
    await fullStateRefresh();
    state.pushSnapshot(`Tappa aggiunta dalla mappa: "${name}"`);

  } else {
    // forceRaw OPPURE nessuna geometria disponibile:
    // posizionamento per distanza geografica dai waypoint esistenti
    addLog(`⏳ Reverse geocode in corso…`, 'dim');
    const name = await reverseGeocode(lat, lon) || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const newWp = {
      lat, lon, name,
      countryCode: null, adminRegion: null, placeType: null,
      source: 'user_click_exact', snapToleranceMeters: 0, userMarkedObligatory: true,
    };
    const updated = [...wps];

    // Trova la posizione corretta per distanza geografica
    // Inserisce dopo il waypoint più vicino (escludendo l'ultimo)
    if (wps.length >= 2) {
      const haversineM = (a, b) => {
        const R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLon = (b.lon - a.lon) * Math.PI / 180;
        const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
      };
      // Trova il segmento WP[i]→WP[i+1] più vicino al punto cliccato
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < wps.length - 1; i++) {
        const midLat = (wps[i].lat + wps[i+1].lat) / 2;
        const midLon = (wps[i].lon + wps[i+1].lon) / 2;
        const d = haversineM({ lat, lon }, { lat: midLat, lon: midLon });
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      updated.splice(bestIdx + 1, 0, newWp);
      addLog(`🎯 Tappa esatta inserita: "${name}" dopo tappa ${bestIdx + 1} → totale ${updated.length} tappe`, 'ok');
    } else {
      updated.splice(Math.max(updated.length - 1, 1), 0, newWp);
      addLog(`🎯 Tappa esatta inserita: "${name}" → totale ${updated.length} tappe`, 'ok');
    }

    state.setWaypoints(updated);
    await fullStateRefresh();
    state.pushSnapshot(`Tappa esatta aggiunta dalla mappa: "${name}"`);
  }
}

// ── go(): flusso principale ───────────────────────────────────────────────────
async function go() {
  const file   = $('fileInput').files[0];
  let urlVal   = $('urlIn').value.trim();
  state.setName($('nameIn').value.trim() || 'La mia rotta');

  if (file && urlVal) { Swal.fire({ icon:'warning', title:'Input ambiguo', text:'Scegli solo URL o file', confirmButtonColor:'#1e5aa8' }); return; }
  if (!file && !urlVal) { Swal.fire({ icon:'info', title:'Nessuna fonte', text:'Incolla un URL o carica un file GPX/KMZ/KML', confirmButtonColor:'#1e5aa8' }); return; }

  // Conferma se ci sono già waypoint elaborati (rielaborazione azzera tutto)
  // Eccezione: file diverso o URL diversa → nuova sessione, elabora direttamente
  const _isNewFile = file && file.name !== state._lastElaboratedFileName;
  const _isNewUrl  = urlVal && urlVal !== state._lastElaboratedUrl;
  if (state.getWaypoints().length >= 2 && !_isNewFile && !_isNewUrl) {
    const { isConfirmed } = await Swal.fire({
      icon: 'warning',
      title: 'Rielabora da capo?',
      html: 'Perderai tutte le modifiche manuali<br>(tappe aggiunte, correzioni).',
      showCancelButton: true,
      confirmButtonText: 'Sì, rielabora',
      cancelButtonText: 'Annulla',
      confirmButtonColor: '#e53e3e',
      cancelButtonColor: '#1e5aa8',
    });
    if (!isConfirmed) return;
  }

  $('progressCard').classList.add('on');
  $('errorCard').classList.remove('on');
  $('statusMessage').classList.remove('on');
  $('results').classList.remove('on');
  $('mapPlaceholder').classList.remove('hidden');
  $('logEl').innerHTML = '';
  state.setRawRoutePoints(null); // azzera da elaborazione precedente
  $('progTitle').textContent = 'Elaborazione in corso…';
  const btn = $('convertBtn');
  btn.disabled = true; $('bIcon').innerHTML = '<div class="spin"></div>'; $('bText').textContent = 'Elaborazione…';
  setProgress(5);

  try {
    let wps = [];

    // ── FASE 1: Parsing ingresso ──────────────────────────────────────────────
    if (file) {
      addLog('📂 Lettura file: ' + file.name, 'ok');
      const parsed = await parseFile(file, { addLog });
      wps = parsed.waypoints;
      state.setGpxSourceType(parsed.sourceType);
      _originalSrcType = parsed.sourceType; // salva prima che go() sovrascriva con 'trkpt' (garmin_hybrid)
      _originalWaypoints = [...wps];         // snapshot pre-riduzione per riespansione tappe
      _pinnedSet = computePinnedSet(_originalWaypoints);
      addLog(`📌 Tappe semantiche (pinned): ${_pinnedSet.size} su ${wps.length}`, 'dim');
      state.setRawTrkPoints(parsed.rawPoints ?? null);
      if (parsed.sourceType === 'garmin_hybrid' && parsed.rawPoints) {
        state.setGarminHybridRawPoints(parsed.rawPoints);
      }
      addLog(`📍 Trovate ${wps.length} tappe (sourceType: ${parsed.sourceType})`, 'ok');
      setProgress(30);

      // ── trkpt: riduzione per distanza reale + geocoding inverso ──────────────
      // L'utente ha caricato una traccia GPS densa. Vogliamo il numero minimo
      // di waypoint geograficamente distribuiti. Non chiamiamo OSRM.
      if (parsed.sourceType === 'trkpt' && parsed.rawPoints?.length > 0) {
        const rawPoints = parsed.rawPoints;
        const wpLimit   = state.getWpLimit();
        addLog(`📍 Traccia trkpt: ${rawPoints.length} punti GPS`, 'info');

        // Riduzione per distanza cumulativa reale (non per indice)
        const reduced = redistributeByDistance(rawPoints, wpLimit);
        addLog(`✅ Riduzione per distanza reale: ${rawPoints.length} → ${reduced.length} waypoint`, 'ok');
        setProgress(40);

        // Geocoding inverso: nomi leggibili per ogni waypoint intermedio
        addLog('🌍 Geocoding inverso waypoint intermedi (Nominatim)...', 'info');
        wps = await nameWaypoints(reduced, { addLog, setProgress, progressFrom: 40, progressTo: 65 });
        addLog(`✅ Geocoding inverso completato: ${wps.length} waypoint nominati`, 'ok');

        // La traccia originale va in routePoints per la mappa e il <trk> GPX
        state.setRoutePoints(rawPoints);
        setProgress(65);
      }

    } else {
      // ── URL: geocoding diretto ────────────────────────────────────────────────
      if (isShortUrl(urlVal)) { urlVal = $('expandedUrlIn').value.trim(); if (!urlVal) throw new Error('Incolla la URL espansa'); }
      const parsed = extractStops(urlVal); if (!parsed) throw new Error('URL non riconosciuta');
      addLog(`🔗 Fonte: ${parsed.src} · ${parsed.stops.length} tappe`, 'ok');
      state.setGpxSourceType('url');
      setProgress(15);

      const directCoords = extractAllWaypointCoords(urlVal);

      if (directCoords.length === parsed.stops.length) {
        // Caso A: blob 1:1 -> mapping diretto
        wps = directCoords.map((c, i) => ({ lat: c.lat, lon: c.lon, name: parsed.stops[i] }));
        addLog('🗺 Coordinate blob (' + directCoords.length + ' tappe)', 'ok');

      } else {
        // Caso B: mismatch blob/stop.
        // Alcune stop sono gia' coordinate dirette e non generano blob !1d!2d.
        // Strategia ibrida: usa blob per le stop testuali, coordStr() per le altre.
        const nonCoordStops = parsed.stops.filter(s => !coordStr(s) && !isBlob(s));
        const canHybrid = directCoords.length === nonCoordStops.length;

        if (canHybrid) {
          addLog('🗺 Matching ibrido: ' + directCoords.length + ' blob + ' + (parsed.stops.length - directCoords.length) + ' coord dirette', 'ok');
          let blobIdx = 0;
          for (let i = 0; i < parsed.stops.length; i++) {
            const s = parsed.stops[i], cd = coordStr(s);
            if (cd) {
              wps.push(cd);
            } else if (isBlob(s)) {
              const ex = blobCoords(s); if (ex) wps.push(ex);
            } else {
              wps.push({ lat: directCoords[blobIdx].lat, lon: directCoords[blobIdx].lon, name: s });
              blobIdx++;
            }
            setProgress(15 + Math.round(50 * (i + 1) / parsed.stops.length));
          }
        } else {
          // Caso C: fallback geocoding individuale
          addLog('🔍 Geocoding individuale (blob=' + directCoords.length + ' vs stop=' + parsed.stops.length + ')', 'dim');
          for (let i = 0; i < parsed.stops.length; i++) {
            const s = parsed.stops[i], cd = coordStr(s);
            if (cd) { wps.push(cd); }
            else if (isBlob(s)) { const ex = blobCoords(s); if (ex) wps.push(ex); }
            else { const g = await geocode(s); wps.push(g); if (i < parsed.stops.length - 1) await sleep(1150); }
            setProgress(15 + Math.round(50 * (i + 1) / parsed.stops.length));
          }
        }
      }
      setProgress(65);
    }

    if (wps.length < 2) throw new Error('Meno di 2 tappe valide trovate');

    // ── FASE 2: Routing + mappa ───────────────────────────────────────────────
    addLog(`🗺️ ${wps.length} waypoint pronti → routing...`, 'info');
    state.setRawImportCount(wps.length); // salva conteggio originale per dashboard
    state.setWaypoints(wps);
    state.pushSnapshot('Import originale'); // Fase 2: punto di ripristino iniziale
    $('mapPreview').classList.add('on');
    $('results').classList.add('on');
    $('mapPlaceholder').classList.add('hidden');
    setProgress(70);
    await fullStateRefresh();
    setProgress(85);

    // ── FASE 3: Valutazione risultato + domanda all'utente ────────────────────
    // Filosofia: elaboro prima al massimo, poi chiedo solo se necessario.
    const wpCount  = state.getWaypoints().length;
    const wpLimit  = state.getWpLimit();
    const srcType  = state.getGpxSourceType();

    if (wpCount > wpLimit && srcType !== 'trkpt') {
      // Waypoint semantici eccedono il limite → cancello a tre vie
      const choice = await _consentGate(wpCount, wpLimit);

      if (choice === 'reduced') {
        // Riduzione automatica con motoOptimize
        const currentWps = state.getWaypoints();
        const reduced = motoOptimize(currentWps, srcType, wpLimit, { addLog, pinnedSet: _pinnedSet ?? undefined });
        state.setWaypoints(reduced);
        _setFormat('gpx');

        // FIX garmin_hybrid: i garminHybridRawPoints sono già stati consumati
        // dal primo fullStateRefresh (riga ~538). Il secondo fullStateRefresh
        // chiamerebbe OSRM sui waypoint ridotti, perdendo la traccia GPS originale
        // e generando false inversioni (es. tappa 15 con buco 6km tra WP30-WP31).
        // Soluzione: ripristiniamo rawTrkPoints come routePoints e forziamo
        // sourceType='trkpt' così il fast-path bypassa OSRM completamente.
        if (srcType === 'garmin_hybrid') {
          const originalTrack = state.getRawTrkPoints();
          if (originalTrack?.length > 0) {
            state.setRoutePoints(originalTrack);
            state.setRawRoutePoints(originalTrack);
            state.setGpxSourceType('trkpt');
            addLog(`🗺️ Traccia Garmin originale ripristinata: ${originalTrack.length} punti (OSRM bypassato)`, 'ok');
          }
        }

        await fullStateRefresh();
        addLog(`✂️ Riduzione: ${wpCount} → ${reduced.length} tappe (GPX)`, 'ok');
        state.pushSnapshot('Ottimizzazione automatica'); // Fase 2

      } else if (choice === 'itn') {
        // Mantieni tutte → ITN
        _setFormat('itn');
        await regenerateOutput();
        addLog(`💾 ${wpCount} tappe → formato ITN (microSD/USB)`, 'ok');
        document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('fmt-recommended'));

      } else {
        // 'manual': l'utente vuole modificare la lista — interrompi qui
        addLog('✏️ Modifica manuale: intervieni sulla lista tappe', 'info');
        document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('fmt-recommended'));
        $('progTitle').textContent = '✏️ Modifica le tappe e riesporta';
        return; // non salva in cronologia, non mostra summary
      }

    } else if (wpCount <= wpLimit && wpCount > 2 && srcType !== 'trkpt') {
      // Waypoint semantici nel limite → domanda opzionale "vuoi ridurre?"
      // Solo se ha senso (più di 2 tappe → c'è qualcosa da ridurre)
      const result = await Swal.fire({
        icon: 'success',
        title: `${wpCount} tappe`,
        html: `Il percorso è compatibile con la APP TomTom MyDrive EU (max ${wpLimit}).<br><br>
               Vuoi ridurre ulteriormente le tappe intermedie?<br>
               <small style="color:#6b7280">Attenzione: potresti perdere alcune fermate nominate.</small>`,
        confirmButtonText: 'No, va bene così',
        confirmButtonColor: '#1e5aa8',
        showCancelButton: true,
        cancelButtonText: 'Sì, riduci',
        cancelButtonColor: '#9ca3af',
      });
      if (!result.isConfirmed) {
        // Utente vuole ridurre
        const currentWps = state.getWaypoints();
        // Riduce al 50% dei WP attuali o al minimo 2, rispettando semantica
        const targetCount = Math.max(2, Math.ceil(currentWps.length / 2));
        const reduced = motoOptimize(currentWps, srcType, targetCount, { addLog, pinnedSet: _pinnedSet ?? undefined });
        state.setWaypoints(reduced);
        await regenerateOutput();
        addLog(`✂️ Riduzione opzionale: ${wpCount} → ${reduced.length} tappe`, 'ok');
        state.pushSnapshot('Riduzione opzionale'); // Fase 2
      }

    } else if (srcType === 'trkpt') {
      // trkpt: mostra riepilogo e chiede conferma o numero diverso
      const result = await Swal.fire({
        icon: 'info',
        title: 'Traccia GPS ridotta',
        html: `La traccia aveva <b>${state.getRawTrkPoints()?.length ?? '?'} punti GPS</b>.<br>
               Ho estratto <b>${wpCount} waypoint navigabili</b> distribuiti sul percorso.<br><br>
               Vuoi procedere o preferisci un numero diverso?`,
        confirmButtonText: '✅ Procedi',
        confirmButtonColor: '#1e5aa8',
        showCancelButton: true,
        cancelButtonText: '✏️ Scelgo il numero',
        cancelButtonColor: '#9ca3af',
      });
      if (!result.isConfirmed) {
        // L'utente vuole scegliere il numero target
        const { value: userCount } = await Swal.fire({
          title: 'Quanti waypoint vuoi?',
          input: 'number',
          inputAttributes: { min: 2, max: 255, step: 1 },
          inputValue: wpCount,
          confirmButtonText: 'Applica',
          confirmButtonColor: '#1e5aa8',
          showCancelButton: true,
        });
        if (userCount && parseInt(userCount) >= 2) {
          const rawPoints = state.getRoutePoints();
          if (rawPoints?.length > 0) {
            const reReduced = redistributeByDistance(rawPoints, parseInt(userCount));
            addLog(`🌍 Ricalcolo geocoding per ${reReduced.length} waypoint...`, 'info');
            const reNamed = await nameWaypoints(reReduced, { addLog });
            state.setWaypoints(reNamed);
            await fullStateRefresh();
            addLog(`✅ Ridistribuiti a ${reNamed.length} waypoint`, 'ok');
            state.pushSnapshot(`Ridistribuzione a ${reNamed.length} waypoint`); // Fase 2
          }
        }
      }
    }

    // ── FASE 4: Riepilogo e cronologia ────────────────────────────────────────
    showDecisionPanel(); // Fase 3: pannello con tre opzioni post-elaborazione
    updateDashboard();   // aggiorna dashboard con dati finali (post-riduzione eventuale)
    setProgress(100);
    $('progTitle').textContent = '✅ ELABORAZIONE COMPLETATA';

    // Formato finale: suggerisci ITN se ancora sopra limite
    const finalCount  = state.getWaypoints().length;
    const myDriveLimit = state.getWpLimit();  // 20 (App) o 255 (USB/SD)
    if (finalCount > myDriveLimit && state.getFormat() !== 'itn') {
      _setFormat('itn');
      await regenerateOutput();
      addLog(`⚠️ Formato ITN preselezionato (${finalCount} tappe > ${myDriveLimit})`, 'warn');
    } else if (finalCount <= myDriveLimit && state.getFormat() === 'itn') {
      _setFormat('gpx');
      await regenerateOutput();
      addLog(`✅ Formato GPX riabilitato (${finalCount} tappe ≤ ${myDriveLimit})`, 'ok');
    }

    // Salva in cronologia
    // Salva il nome del file/URL appena elaborati (per il controllo nuova sessione)
    state._lastElaboratedFileName = file ? file.name : null;
    state._lastElaboratedUrl      = urlVal || null;

    state.pushHistory({
      name:      state.getName(),
      url:       $('urlIn').value,
      wps:       state.getWaypoints().length,
      fmt:       state.getFormat(),
      ts:        Date.now(),
      waypoints: state.getWaypoints(),
    });
    try { localStorage.setItem('routeConvHistory', JSON.stringify(state.getHistory())); } catch (e) {}

  } catch (err) {
    $('progressCard').classList.remove('on');
    $('errorTxt').innerHTML = err.message;
    $('errorCard').classList.add('on');
    console.error('Errore go():', err);
  } finally {
    btn.disabled = false;
    $('bIcon').textContent = '▶';
    $('bText').textContent = 'Elabora percorso';
  }
}

// ── Download ──────────────────────────────────────────────────────────────────
function download() {
  const output = state.getOutput();
  if (!output) return;
  const name   = state.getName();
  const format = state.getFormat();
  const wps    = state.getWaypoints();
  Swal.fire({ icon:'success', title:'Download avviato ✓', html:`<strong>${esc(name)}.${format}</strong><br>${wps.length} tappe`, timer:2000, showConfirmButton:false, toast:true, position:'top-end' });
  const fn   = name.replace(/\s+/g, '_') + '.' + format;
  const blob = format === 'kmz' ? output
             : format === 'itn' ? new Blob([output], { type:'text/plain' })
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
        addLog(`📜 Ripristino rotta: "${h.name}" (${h.waypoints.length} tappe)`, 'info');
        state.setFormat(h.fmt);
        document.querySelectorAll('.fmt-btn').forEach(b => b.classList.toggle('active', b.dataset.fmt === h.fmt));
        await fullStateRefresh();
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
  state.setWpLimit(parseInt($('modelSelect').value));
  wpUI.updateCountWarning();
}

// ── toggleInfoPanel ───────────────────────────────────────────────────────────
function toggleInfoPanel() {
  const btn   = $('infoToggleBtn');
  const panel = $('infoPanel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  btn.classList.toggle('open', !isOpen);
  btn.setAttribute('aria-expanded', String(!isOpen));
  try { localStorage.setItem('infoPanel_open', String(!isOpen)); } catch (e) {}
}

// ── Mini-dashboard post-elaborazione ─────────────────────────────────────────
function showElaborationSummary() {
  const el = $('sdReductionInfo');
  if (!el) return;
  const rawPts = state.getRawTrkPoints();
  const wps    = state.getWaypoints();
  const wpIn   = rawPts ? rawPts.length : (wps ? wps.length : '—');
  const wpOut  = wps ? wps.length : '—';
  const km     = state.getRouteDistance() ? (state.getRouteDistance() / 1000).toFixed(1) : '—';
  const fmt    = state.getFormat().toUpperCase();
  const pct    = (wpIn && wpOut && wpIn > wpOut)
               ? Math.round((1 - wpOut / wpIn) * 100) + '% riduzione'
               : 'nessuna riduzione';
  el.innerHTML = `
    <strong>📊 Riepilogo elaborazione</strong><br>
    <span style="display:inline-flex;gap:16px;flex-wrap:wrap;margin-top:4px">
      <span>🛣️ <b>${km} km</b></span>
      <span>📍 In: <b>${wpIn}</b></span>
      <span>✅ Out: <b>${wpOut}</b></span>
      <span>📄 <b>${fmt}</b></span>
      <span>🎯 <b>${pct}</b></span>
    </span>`;
  el.classList.add('on');
}

// ── Dashboard persistente (Fase 1) ────────────────────────────────────────────
// Mostra: Da→A waypoint, km totali, compatibilità MyDrive.
// Appare dopo ogni elaborazione e persiste tra cambi di formato.
// Non mostra mai fedeltà semantica o percentuali di ottimizzazione (scelta deliberata).
function updateDashboard() {
  const el = $('dashboard');
  if (!el) return;
  const wps  = state.getWaypoints();
  const dist = state.getRouteDistance();
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

// ── Pannello decisionale (Fase 3) ────────────────────────────────────────────

// Aggiorna il testo del pannello con i dati correnti e lo rende visibile.
// Chiamato al termine di go() e dopo ogni fullStateRefresh() se il pannello è già aperto.
function showDecisionPanel() {
  const panel = $('decision-panel');
  if (!panel) return;
  const wps     = state.getWaypoints();
  const dist    = state.getRouteDistance();
  const orig    = state.getRawImportCount?.() || wps.length;
  const wpLimit = state.getWpLimit();

  const kmStr = dist > 0 ? `${(dist / 1000).toFixed(1)} km` : '— km';
  const wpStr = orig !== wps.length ? `Da ${orig} → ${wps.length} WP` : `${wps.length} WP`;
  const summaryEl = $('dp-summary-text');
  if (summaryEl) summaryEl.textContent = `${wpStr} · ${kmStr}`;

  // Controllo +/− tappe
  const srcType  = state.getGpxSourceType();
  const ctrlEl   = $('dp-btn-optimize-ctrl');
  const countEl  = $('dp-wp-count');
  const minusBtn = $('dp-wp-minus');
  const plusBtn  = $('dp-wp-plus');
  const applyBtn = $('dp-wp-apply');
  const hintEl   = $('dp-wp-hint');

  if (ctrlEl) {
    const canAdjust = wps.length >= 2;
    ctrlEl.style.opacity       = canAdjust ? '1' : '.38';
    ctrlEl.style.pointerEvents = canAdjust ? 'auto' : 'none';

    // Limiti: min 2, max = conteggio importato originale
    const rawCount = state.getRawImportCount?.() || wps.length;

    // Resetta il target SOLO se non c'è una modifica pendente dell'utente.
    // fullStateRefresh() chiama showDecisionPanel() automaticamente mentre
    // l'utente sta ancora regolando i tasti +/−: NON azzerare _dpWpTarget
    // in quel caso, altrimenti decisionWpApply() trova null ed esce subito.
    if (_dpWpTarget === null) {
      // Nessuna modifica pendente: mostra conteggio corrente e nascondi Applica
      if (countEl) countEl.textContent = wps.length;
      if (applyBtn) {
        applyBtn.style.display = 'none';
        applyBtn.disabled = false;
        applyBtn.textContent = 'Applica';
      }
      if (hintEl) hintEl.textContent = 'modifica tappe';
      if (minusBtn) { minusBtn.disabled = wps.length <= 2; }
      if (plusBtn)  { plusBtn.disabled  = wps.length >= rawCount; }
    } else {
      // Modifica pendente: mantieni il display corrente senza toccare _dpWpTarget.
      // Aggiorna solo i limiti dei pulsanti in base al conteggio reale attuale.
      if (minusBtn) minusBtn.disabled = _dpWpTarget <= 2;
      if (plusBtn)  plusBtn.disabled  = _dpWpTarget >= rawCount;
    }
  }

  // [FASE 4] Toggle overlay: riga visibile solo se rawRoutePoints è disponibile
  // e diverso dai routePoints correnti (cioè c'è davvero una "originale" da confrontare)
  const toggleRow  = $('dp-overlay-toggle-row');
  const mapOverlay = $('map-confronta-overlay');
  const rawPts     = state.getRawRoutePoints();
  const hasOverlay = rawPts?.length > 0 && rawPts !== state.getRoutePoints();
  if (toggleRow)  toggleRow.classList.toggle('visible', hasOverlay);
  if (mapOverlay) mapOverlay.style.display = hasOverlay ? '' : 'none';
  const chk = $('dp-overlay-chk');
  if (chk) chk.checked = state.getOverlayVisible?.() ?? false;

  // [FASE 4] Log semantico: il pulsante log è dentro dp-overlay-toggle-row, visibile insieme a essa
  // (nessuna logica separata necessaria — il bottone è sempre presente quando la riga è visibile)

  panel.classList.add('on');
  // Mostra anche la barra undo/redo
  const undoBar = $('undo-redo-bar');
  if (undoBar) undoBar.classList.add('on');
}

// [FASE 4] Toggle overlay traccia originale.
// Aggiunge/rimuove il layer grigio dalla mappa Leaflet senza ricostruirlo.
function toggleOriginalLayer(checked) {
  state.setOverlayVisible(checked);
  const map       = state.getMap();
  const origLayer = state.getOriginalLayer();
  if (!map || !origLayer) return;
  if (checked) {
    origLayer.addTo(map);
  } else {
    map.removeLayer(origLayer);
  }
  addLog(checked ? '👁 Overlay traccia originale: attivo' : '👁 Overlay traccia originale: nascosto', 'dim');
}

// [FASE 4] Mostra il log semantico delle rimozioni in un SweetAlert.
// La classificazione è geometrica (proxy DP); lo diciamo esplicitamente in fondo.
function showRemovalLog() {
  const rLog = state.getRemovalLog();
  if (!rLog?.length) return;

  const reasonLabel = {
    obligatory:    'obbligato, capo/coda',
    characteristic:'mantenuto (geometria)',
    redundant:     'geometricamente ridondante',
    equivalent:    'rimosso — routing equivalente ✅',   // Fase 5
    critical:      'rimosso — DEVIAZIONE CRITICA ⚠️',    // Fase 5
  };

  const rows = rLog.map(e => {
    const name       = e.name ?? '—';
    const country    = e.countryCode ? `, ${e.countryCode}` : '';
    const label      = reasonLabel[e.reason] ?? e.reason;
    const icon       = e.action === 'kept' ? '✓' : '✗';
    const isCritical = e.reason === 'critical';
    const color      = isCritical ? '#92400e'
                     : e.action === 'kept' ? '#065f46' : '#991b1b';
    const verified   = e.routingVerified
      ? `<span style="font-size:10px;color:#6b7280;"> · routing verificato</span>`
      : `<span style="font-size:10px;color:#9ca3af;"> · proxy geometrico</span>`;
    return `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;font-size:12px;line-height:1.5;">
      <span style="color:${color};font-weight:700;flex-shrink:0;width:14px;">${icon}</span>
      <span>
        <b style="color:${color};">${e.action === 'kept' ? 'Mantenuto' : 'Rimosso'}</b>
        — ${esc(name)}${esc(country)}
        <span style="color:#6b7280;font-weight:400;"> (${label})</span>
        ${verified}
      </span>
    </div>`;
  }).join('');

  const note = `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:10.5px;color:#6b7280;line-height:1.6;">
    ℹ️ Le voci con <em>routing verificato</em> sono state confermate da OSRM/Valhalla (Fase 5).
    Le voci con <em>proxy geometrico</em> non hanno ricevuto risposta entro il timeout (3s/tratto).
  </div>`;

  Swal.fire({
    title: 'Log semantico rimozioni',
    html: `<div style="text-align:left;max-height:340px;overflow-y:auto;">${rows}${note}</div>`,
    confirmButtonText: 'Chiudi',
    confirmButtonColor: '#1e5aa8',
    width: 520,
  });
}

// ESPORTA — bypass di qualsiasi ottimizzazione, scarica direttamente.
async function decisionExport() {
  // Se l'utente non ha ancora scelto il formato, mostra popup guida
  const currentFmt = state.getFormat();
  if (!_userHasChosenFormat) {
    const result = await Swal.fire({
      icon: 'question',
      title: 'Scegli il formato di export',
      html: `<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
        <button id="sw-gpx" style="padding:12px;border:2px solid #1e5aa8;border-radius:10px;background:#e6f0ff;color:#0f2b4d;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;">📦 GPX — TomTom MyDrive<br><span style="font-size:11px;font-weight:400;color:#4a6fa5;">Consigliato per percorsi ≤ 20 tappe via App</span></button>
        <button id="sw-itn" style="padding:12px;border:2px solid #2c7dc3;border-radius:10px;background:#f5f9ff;color:#0f2b4d;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;">🗺️ ITN — TomTom nativo<br><span style="font-size:11px;font-weight:400;color:#4a6fa5;">Per caricamento via microSD/USB, fino a 255 tappe</span></button>
        <button id="sw-kmz" style="padding:12px;border:2px solid #2c7dc3;border-radius:10px;background:#f5f9ff;color:#0f2b4d;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;">🌍 KMZ — Google Earth<br><span style="font-size:11px;font-weight:400;color:#4a6fa5;">Per visualizzazione su Google Earth / Maps</span></button>
      </div>`,
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: 'Annulla',
      cancelButtonColor: '#9ca3af',
      didOpen: () => {
        ['gpx', 'itn', 'kmz'].forEach(fmt => {
          document.getElementById(`sw-${fmt}`)?.addEventListener('click', () => {
            _userHasChosenFormat = true;   // fix 2b: scelta dal popup
            Swal.clickConfirm();
            _setFormat(fmt);
          });
        });
      },
    });
    if (result.isDismissed) return; // utente ha annullato
  }
  addLog('✅ Esportazione diretta (nessuna ottimizzazione)', 'ok');
  await regenerateOutput();
  download();
}

// ── [FASE 5] Hausdorff per-segmento ──────────────────────────────────────────
// Ritorna la distanza di Hausdorff (m) tra due array di punti {lat,lon}.
// Usa distanza haversine punto-a-punto: O(n*m), accettabile per segmenti
// di max qualche centinaio di punti ciascuno.
function _hausdorffSegment(ptsA, ptsB) {
  if (!ptsA?.length || !ptsB?.length) return Infinity;
  const hav = (a, b) => {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 +
              Math.cos(a.lat * Math.PI / 180) *
              Math.cos(b.lat * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(s));
  };
  const minDist = (p, arr) => arr.reduce((min, q) => Math.min(min, hav(p, q)), Infinity);
  const h1 = Math.max(...ptsA.map(p => minDist(p, ptsB)));
  const h2 = Math.max(...ptsB.map(p => minDist(p, ptsA)));
  return Math.max(h1, h2);
}

// ── [FASE 5] Routing Equivalence Engine ──────────────────────────────────────
// Per ogni coppia di waypoint consecutivi nei waypoint RIDOTTI, chiede a
// Valhalla/OSRM la rotta e confronta con la traccia originale (rawRoutePoints).
// Se la deviazione supera THRESHOLD_M, il waypoint viene marcato come 'critical'
// nel removalLog: la sua rimozione ha cambiato il percorso reale.
//
// Parametri:
//   reducedWps  — waypoint dopo motoOptimize()
//   originalPts — state.getRawRoutePoints() (traccia pre-ottimizzazione)
//   signal      — AbortSignal esterno (timeout globale 8s gestito dal chiamante)
//
// Aggiorna in-place ogni entry del removalLog con:
//   routingVerified: true | false
//   reason: (aggiornato solo se verified) 'equivalent' | 'critical' | 'obligatory'
//
// Ritorna: { verified: number, unverified: number, critical: number }
async function verifyRouteEquivalence(reducedWps, originalPts, signal) {
  const THRESHOLD_M    = 150;
  const TIMEOUT_LEG_MS = 3000;

  const removalLog = state.getRemovalLog();
  if (!removalLog?.length || !originalPts?.length || reducedWps.length < 2) {
    return { verified: 0, unverified: 0, critical: 0 };
  }

  // Per ogni tratto [reducedWps[i] → reducedWps[i+1]] estrae i punti originali
  // che cadono nell'area (bbox con padding) di quel tratto.
  function _extractSegmentPts(ptA, ptB, sourcePts) {
    const latMin = Math.min(ptA.lat, ptB.lat) - 0.05;
    const latMax = Math.max(ptA.lat, ptB.lat) + 0.05;
    const lonMin = Math.min(ptA.lon, ptB.lon) - 0.05;
    const lonMax = Math.max(ptA.lon, ptB.lon) + 0.05;
    return sourcePts.filter(p =>
      p.lat >= latMin && p.lat <= latMax &&
      p.lon >= lonMin && p.lon <= lonMax
    );
  }

  let verified   = 0;
  let unverified = 0;
  let critical   = 0;

  addLog(`🔬 Fase 5: verifica routing reale su ${reducedWps.length - 1} tratti...`, 'info');
  setProgress(72);

  for (let i = 0; i < reducedWps.length - 1; i++) {
    if (signal?.aborted) break;

    const wpA = reducedWps[i];
    const wpB = reducedWps[i + 1];

    // Timeout per-tratto: AbortSignal combinato (globale + 3s locale)
    const legAC  = new AbortController();
    const legTid = setTimeout(() => legAC.abort(), TIMEOUT_LEG_MS);
    const legSignal = AbortSignal.any
      ? AbortSignal.any([signal, legAC.signal].filter(Boolean))
      : legAC.signal;

    try {
      const seg = await engine.fetchSingleRoute([wpA, wpB], legSignal);
      clearTimeout(legTid);

      if (!seg?.points?.length) {
        unverified++;
        addLog(`  ⚠️ Tratto ${i + 1}: nessuna geometria (unverified)`, 'dim');
        continue;
      }

      // Estrai i punti originali nell'area del tratto
      const origSeg = _extractSegmentPts(wpA, wpB, originalPts);
      if (origSeg.length < 2) {
        unverified++;
        addLog(`  ⚠️ Tratto ${i + 1}: zona originale vuota (unverified)`, 'dim');
        continue;
      }

      const deviation  = _hausdorffSegment(seg.points, origSeg);
      const isCritical = deviation > THRESHOLD_M;

      if (isCritical) {
        critical++;
        addLog(`  🔴 Tratto ${i + 1} (${wpA.name ?? '?'} → ${wpB.name ?? '?'}): deviazione ${deviation.toFixed(0)}m > ${THRESHOLD_M}m`, 'warn');
      } else {
        addLog(`  ✅ Tratto ${i + 1}: ${deviation.toFixed(0)}m ≤ ${THRESHOLD_M}m`, 'dim');
      }

      // Aggiorna removalLog: cerca le entry 'removed' che cadono tra wpA e wpB
      // (matching per name). I waypoint rimossi tra il i-esimo e (i+1)-esimo
      // waypoint mantenuto ricevono il verdetto del tratto in cui sarebbero stati.
      let inSegment = false;
      for (const entry of removalLog) {
        if (entry.action === 'kept') {
          if (!inSegment && entry.name === (wpA.name ?? null)) { inSegment = true; continue; }
          if (inSegment  && entry.name === (wpB.name ?? null)) { inSegment = false; break; }
        }
        if (inSegment && entry.action === 'removed') {
          entry.routingVerified = true;
          entry.reason = isCritical ? 'critical' : 'equivalent';
        }
      }

      // Marca anche wpB come verificato (primo match non ancora marcato)
      const keptB = removalLog.find(e =>
        e.action === 'kept' &&
        e.name === (wpB.name ?? null) &&
        !e.routingVerified
      );
      if (keptB) keptB.routingVerified = true;

      verified++;

    } catch (err) {
      clearTimeout(legTid);
      if (err.name !== 'AbortError') {
        addLog(`  ❌ Tratto ${i + 1}: errore routing (${err.message})`, 'dim');
      }
      unverified++;
    }

    // Rate-limit: pausa minima tra tratti (evita 429 su server pubblici)
    if (i < reducedWps.length - 2 && !signal?.aborted) {
      await sleep(700);
    }

    setProgress(72 + Math.round(13 * (i + 1) / (reducedWps.length - 1)));
  }

  // Segna come unverified tutte le entry non ancora toccate
  for (const entry of removalLog) {
    if (entry.routingVerified === undefined) entry.routingVerified = false;
  }

  state.setRemovalLog([...removalLog]); // forza aggiornamento riferimento
  addLog(`🏁 Verifica completata: ${verified} tratti OK, ${unverified} unverified, ${critical} critici`, critical > 0 ? 'warn' : 'ok');
  return { verified, unverified, critical };
}

// OTTIMIZZA AUTO — SweetAlert di conferma, poi riduzione con motoOptimize.
async function decisionOptimize() {
  const wps     = state.getWaypoints();
  const wpLimit = state.getWpLimit();
  const srcType = state.getGpxSourceType();
  if (wps.length <= 2 || srcType === 'trkpt') return;

  const result = await Swal.fire({
    icon: 'warning',
    title: 'Ottimizzazione automatica',
    html: `Il percorso verrà analizzato geometricamente: le tappe alle <b>curve e ai bivi</b> vengono mantenute, quelle sui <b>rettilinei</b> rimosse — il navigatore le raggiungerebbe comunque.<br><br>
           <b>${wps.length} tappe → max ${wpLimit}</b><br><br>
           Partenza e destinazione sono inviolabili. Dopo puoi controllare cosa è stato rimosso nel <b>log rimozioni</b>.`,
    confirmButtonText: '⚡ Sì, ottimizza',
    confirmButtonColor: '#f59e0b',
    showCancelButton: true,
    cancelButtonText: 'Annulla',
    cancelButtonColor: '#9ca3af',
  });
  if (!result.isConfirmed) return;

  // [FASE 4] Snapshot dei waypoint prima della riduzione per costruire il log
  const wpsBefore = [...wps];
  const target    = Math.min(wps.length - 1, wpLimit);
  const reduced   = motoOptimize(wps, srcType, target, { addLog, pinnedSet: _pinnedSet ?? undefined });

  // Costruisce set delle coordinate mantenute (chiave lat/lon a 6 decimali)
  const keptSet = new Set(reduced.map(w => `${w.lat.toFixed(6)},${w.lon.toFixed(6)}`));
  const removalLog = wpsBefore.map((w, i) => {
    const key  = `${w.lat.toFixed(6)},${w.lon.toFixed(6)}`;
    const kept = keptSet.has(key);
    // Proxy geometrico per la ragione:
    // primo/ultimo = obbligatorio; mantenuto = caratteristico; rimosso = ridondante
    let reason;
    if (i === 0 || i === wpsBefore.length - 1) reason = 'obligatory';
    else if (kept)                              reason = 'characteristic';
    else                                        reason = 'redundant';
    return {
      action:      kept ? 'kept' : 'removed',
      name:        w.name        ?? null,
      countryCode: w.countryCode ?? null,
      reason,
    };
  });
  state.setRemovalLog(removalLog);

  state.setWaypoints(reduced);
  state.pushSnapshot('Ottimizzazione automatica');
  await fullStateRefresh();
  showDecisionPanel();
  addLog(`⚡ Ottimizzazione: ${wps.length} → ${reduced.length} tappe`, 'ok');

  // [FASE 5] Verifica routing reale — opzionale, timeout globale 8s
  const originalPts = state.getRawRoutePoints();
  if (originalPts?.length > 0 && reduced.length >= 2) {
    addLog('🔬 Avvio verifica routing reale (Fase 5)...', 'info');
    const globalAC  = new AbortController();
    const globalTid = setTimeout(() => {
      globalAC.abort();
      addLog('⏱ Verifica interrotta (timeout 8s)', 'warn');
    }, 8000);
    try {
      const { verified, unverified, critical } = await verifyRouteEquivalence(
        reduced, originalPts, globalAC.signal
      );
      clearTimeout(globalTid);
      showDecisionPanel(); // aggiorna pannello con dati verificati
      if (critical > 0) {
        addLog(`⚠️ ${critical} tratt${critical > 1 ? 'i' : 'o'} con deviazione > 150m — verifica il percorso nel log`, 'warn');
        await Swal.fire({
          icon: 'warning',
          title: `${critical} tratto${critical > 1 ? 'i' : ''} critico${critical > 1 ? 'i' : ''}`,
          html: `La verifica routing reale ha rilevato <b>${critical} tratto${critical > 1 ? 'i' : ''}</b>
                 con deviazione &gt; 150 m rispetto alla traccia originale.<br><br>
                 Apri il <b>📋 Log rimozioni</b> per il dettaglio.<br>
                 <small style="color:#6b7280">Valuta di aggiungere manualmente i waypoint critici.</small>`,
          confirmButtonText: 'Capito',
          confirmButtonColor: '#f59e0b',
        });
      } else if (verified > 0) {
        addLog(`✅ Verifica routing: tutti i ${verified} tratti equivalenti (≤ 150m)`, 'ok');
      }
    } catch (err) {
      clearTimeout(globalTid);
      if (err.name !== 'AbortError') addLog(`❌ Verifica routing fallita: ${err.message}`, 'warn');
    }
  } else {
    addLog('ℹ️ Verifica routing saltata (nessuna traccia originale disponibile — sorgente URL)', 'dim');
  }
}

// ── Controllo +/− tappe (sostituisce decisionOptimize) ────────────────────────
// _dpWpTarget: contatore locale della sessione corrente (reset a ogni showDecisionPanel)
let _dpWpTarget = null;

// _originalSrcType: tipo sorgente al momento del parsing, prima di eventuali
// conversioni operate da go() (es. garmin_hybrid → trkpt a riga ~788).
// Necessario perché decisionWpApply deve usare l'algoritmo corretto:
//   - trkpt puro       → redistributeByDistance sui rawTrkPoints
//   - garmin_hybrid    → motoOptimize sui rtept nominati correnti
//   - wpt / url / rtept → motoOptimize
let _originalSrcType = null;
let _originalWaypoints = null; // waypoint al momento dell'import, prima di qualsiasi riduzione
let _pinnedSet = null;         // Set di indici in _originalWaypoints delle tappe semantiche

// Restituisce true se il nome è semantico (assegnato dall'utente o dal dispositivo),
// false se è generato automaticamente (Partenza, Destinazione, Via N, geocoding Nominatim).
// Nomi generici assegnati automaticamente da dispositivi o dal sistema — NON semantici.
const _GENERIC_NAMES = new Set([
  'Nuovo punto',   // Garmin italiano
  'New Point',     // Garmin inglese
  'Neuer Punkt',   // Garmin tedesco
  'Nuevo punto',   // Garmin spagnolo
  'Nouveau point', // Garmin francese
  'Partenza', 'Destinazione',
]);

function isSemanticName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (_GENERIC_NAMES.has(trimmed)) return false;
  if (/^Via \d+$/.test(trimmed)) return false;
  if (/^Waypoint\s*\d+$/i.test(trimmed)) return false; // "Waypoint 001", "WPT001"
  if (/^WPT\s*\d+$/i.test(trimmed)) return false;
  if (/^Point\s*\d*$/i.test(trimmed)) return false;
  if (trimmed.includes(',')) return false; // probabile geocoding Nominatim: "Via Roma, Milano"
  return true;
}

// Calcola _pinnedSet a partire dall'array di waypoint originali.
// Prima e ultima tappa sono sempre incluse (Partenza/Destinazione).
function computePinnedSet(wps) {
  const pinned = new Set();
  if (!wps?.length) return pinned;
  pinned.add(0);                  // Partenza sempre pinned
  pinned.add(wps.length - 1);     // Destinazione sempre pinned
  for (let i = 1; i < wps.length - 1; i++) {
    if (isSemanticName(wps[i].name)) pinned.add(i);
  }
  return pinned;
}

function decisionWpAdjust(delta) {
  const wps      = state.getWaypoints();
  const rawCount = state.getRawImportCount?.() || wps.length;
  if (_dpWpTarget === null) _dpWpTarget = wps.length;

  _dpWpTarget = Math.max(2, Math.min(rawCount, _dpWpTarget + delta));

  const countEl  = $('dp-wp-count');
  const applyBtn = $('dp-wp-apply');
  const hintEl   = $('dp-wp-hint');
  const minusBtn = $('dp-wp-minus');
  const plusBtn  = $('dp-wp-plus');

  if (countEl)  countEl.textContent  = _dpWpTarget;
  if (minusBtn) minusBtn.disabled    = _dpWpTarget <= 2;
  if (plusBtn)  plusBtn.disabled     = _dpWpTarget >= rawCount;

  const diff = _dpWpTarget - wps.length;
  if (hintEl) {
    hintEl.textContent = diff === 0
      ? 'nessuna modifica'
      : diff > 0
        ? `+${diff} tappe`
        : `${diff} tappe`;
  }

  // Bottone Applica sempre nascosto: il ricalcolo avviene in automatico con debounce
  if (applyBtn) applyBtn.style.display = 'none';
  clearTimeout(decisionWpAdjust._debounce);
  if (_dpWpTarget !== wps.length) {
    decisionWpAdjust._debounce = setTimeout(() => decisionWpApply(), 400);
  }
}

async function decisionWpApply() {
  addLog(`🎯 decisionWpApply(): _dpWpTarget=${_dpWpTarget}`, 'dim'); // diagnostica
  if (_dpWpTarget === null) {
    addLog('⚠️ Applica ignorato: nessuna modifica pendente (_dpWpTarget è null)', 'warn');
    return;
  }
  const wps     = state.getWaypoints();
  const target  = _dpWpTarget;
  _dpWpTarget   = null;

  if (target === wps.length) {
    addLog('ℹ️ Nessuna modifica: il target coincide con il numero attuale di tappe', 'dim');
    showDecisionPanel();
    return;
  }

  // USA _originalSrcType (salvato al parsing), NON state.getGpxSourceType().
  // Per garmin_hybrid, go() sovrascrive srcType con 'trkpt' (riga ~788) per
  // bypassare OSRM. Da quel momento getGpxSourceType() restituisce 'trkpt'
  // anche per file Garmin. Usando _originalSrcType scegliamo l'algoritmo giusto:
  //   - 'trkpt' puro      → redistributeByDistance sui rawTrkPoints
  //   - 'garmin_hybrid'   → motoOptimize sui rtept nominati (preserva i nomi)
  //   - altri             → motoOptimize
  const origSrc = _originalSrcType ?? state.getGpxSourceType();
  addLog(`🔧 Ridistribuzione a ${target} tappe (sorgente originale: ${origSrc})…`, 'info');

  // Feedback visivo: blocca i controlli durante l'elaborazione
  const applyBtnEl  = $('dp-wp-apply');
  const minusBtnEl2 = $('dp-wp-minus');
  const plusBtnEl2  = $('dp-wp-plus');
  const hintElApply = $('dp-wp-hint');
  if (applyBtnEl)  { applyBtnEl.disabled = true; applyBtnEl.textContent = '⏳ …'; }
  if (minusBtnEl2) minusBtnEl2.disabled = true;
  if (plusBtnEl2)  plusBtnEl2.disabled  = true;
  if (hintElApply) hintElApply.textContent = 'elaborazione in corso…';

  let reduced;
  const rawTrk = state.getRawTrkPoints();

  if (origSrc === 'trkpt') {
    // Traccia GPS pura (nessun rtept nominato): redistribuisce per distanza sulla
    // traccia grezza originale e fa geocoding inverso per dare nomi leggibili.
    if (!rawTrk?.length) {
      addLog('❌ Traccia GPS originale non disponibile (rawTrkPoints vuoti)', 'warn'); return;
    }
    const reReduced = redistributeByDistance(rawTrk, target);
    addLog(`🌍 Geocoding inverso per ${reReduced.length} waypoint…`, 'info');
    reduced = await nameWaypoints(reReduced, { addLog });

  } else {
    // Waypoint semantici: rtept nominati (garmin_hybrid, wpt, url…).
    // Usa sempre _originalWaypoints come pool sorgente (contiene tutte le tappe originali).
    // Se target <= wps correnti, motoOptimize riduce dal pool originale preservando le pinned.
    // Se target > wps correnti, attinge alle tappe originali non ancora presenti.
    const srcPool = _originalWaypoints?.length >= 2 ? _originalWaypoints : wps;

    // Calcola il pinnedSet relativo al srcPool
    // _pinnedSet contiene indici in _originalWaypoints — valido direttamente su srcPool
    const activePinnedSet = _pinnedSet ?? computePinnedSet(srcPool);

    // Caso B: le tappe semantiche da sole superano il target → avvisa l'utente
    const pinnedCount = [...activePinnedSet].filter(i => i !== 0 && i !== srcPool.length - 1 && isSemanticName(srcPool[i]?.name)).length + 2; // +2 per Partenza/Destinazione
    if (target < pinnedCount && pinnedCount > 2) {
      // Riabilita i controlli prima di mostrare il dialog
      if (applyBtnEl)  { applyBtnEl.disabled = false; applyBtnEl.textContent = 'Applica'; }
      if (minusBtnEl2) minusBtnEl2.disabled = false;
      if (plusBtnEl2)  plusBtnEl2.disabled  = false;
      if (hintElApply) hintElApply.textContent = 'modifica tappe';
      _dpWpTarget = null;

      const semanticNames = [...activePinnedSet]
        .filter(i => i !== 0 && i !== srcPool.length - 1)
        .map(i => srcPool[i]?.name)
        .filter(Boolean)
        .slice(0, 5)
        .join(', ');

      const { isConfirmed } = await Swal.fire({
        icon: 'warning',
        title: 'Le tue tappe a rischio',
        html: `Hai <strong>${pinnedCount - 2}</strong> tappe con nomi significativi
               (es. ${semanticNames}${pinnedCount - 2 > 5 ? '…' : ''}).<br><br>
               Riducendo a <strong>${target}</strong> tappe alcune verranno eliminate.<br>
               Vuoi procedere comunque?`,
        showCancelButton: true,
        confirmButtonText: 'Sì, procedi',
        cancelButtonText: 'Annulla',
        confirmButtonColor: '#e07b00',
      });

      if (!isConfirmed) {
        showDecisionPanel();
        return;
      }
      // L'utente ha confermato: procedi senza protezione pinned
      reduced = motoOptimize(srcPool, origSrc, target, { addLog });
    } else {
      // Caso normale: riduci/espandi preservando le pinned
      reduced = motoOptimize(srcPool, origSrc, target, { addLog, pinnedSet: activePinnedSet });
    }
  }

  // Forza setRoutePoints alla traccia GPS grezza (se disponibile) PRIMA di fullStateRefresh.
  // Questo fa sì che il fast-path trkpt in updateRoutingAndUI chiami initMap() con i dati
  // aggiornati invece di usare il buffer cached (che punta allo stesso oggetto array).
  if (rawTrk?.length > 0) {
    state.setRoutePoints(rawTrk);
  }

  state.setWaypoints(reduced);
  state.pushSnapshot(`Ridistribuzione a ${reduced.length} tappe`);
  await fullStateRefresh();
  showDecisionPanel();
  addLog(`✅ Ridistribuzione completata: ${wps.length} → ${reduced.length} tappe`, 'ok');
}

// MODIFICA MANUALE — scrolla alla lista tappe e la evidenzia.
function decisionEdit() {
  // Su mobile: apre l'accordion lista tappe se chiuso
  if (window.innerWidth < 1024) {
    const wrap   = $('wpList-wrap');
    const header = $('wpList-accordion-header');
    if (wrap && !wrap.classList.contains('open')) {
      wrap.classList.add('open');
      if (header) {
        header.classList.add('open');
        header.setAttribute('aria-expanded', 'true');
      }
      sessionStorage.setItem('wplist-open', 'true');
    }
  }
  // Scrolla alla lista tappe (funziona su mobile e desktop)
  const wpWrap = $('wpList-wrap');
  if (wpWrap) {
    wpWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  addLog('📋 Lista tappe aperta — aggiungi, rimuovi o riordina le tappe', 'info');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  // Ripristina cronologia da localStorage
  try { state.setHistory(JSON.parse(localStorage.getItem('routeConvHistory') || '[]')); } catch (e) {}

  // Formato iniziale: nessuna pre-selezione — l'utente sceglie al momento dell'export
  // I bottoni formato partono tutti senza classe .active
  document.querySelectorAll('.fmt-btn').forEach(b => {
    b.addEventListener('click', async () => {
      _userHasChosenFormat = true;   // fix 2b: l'utente ha scelto esplicitamente
      _setFormat(b.dataset.fmt);
      if (state.getWaypoints().length >= 2) await regenerateOutput();
    });
  });

  wpUI.updateCountWarning();
  if (isIOS()) $('iosHint')?.classList.add('on');

  // ── Log collassabile su mobile: click sul titolo per aprire/chiudere ──
  $('progTitle')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      $('progressCard')?.classList.toggle('log-open');
    }
  });

  // Mostra la X sui campi che hanno già un valore al caricamento (es. nameIn = "La mia rotta")
  ['urlIn', 'expandedUrlIn', 'nameIn'].forEach(id => {
    const el = $(id);
    const btnId = id === 'urlIn' ? 'xUrl' : id === 'expandedUrlIn' ? 'xExpanded' : 'xName';
    if (el?.value?.length > 0) $(btnId)?.classList.add('on');
  });

  // Inizializza stato pulsanti undo/redo (disabilitati finché non c'è uno snapshot)
  updateUndoRedo();

  // Shortcut tastiera: Ctrl/Cmd+Z → undo, Ctrl/Cmd+Shift+Z → redo
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoAction(); }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redoAction(); }
  });

  // ── File input + Drag & Drop ──────────────────────────────────────────────
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
      state._sourceFileName = file.name; // traccia il nome file corrente
    } else {
      zone.classList.remove('has-file');
      $('fileBtnText').textContent = 'Seleziona o trascina qui un file GPX, KMZ o KML';
      $('fileInfo').classList.remove('on');
      $('urlIn').placeholder = 'Incolla qui la URL (Google, Apple Maps, Waze)';
    }
    $('convertBtn').classList.remove('hidden'); // nuova sorgente → riappare
  });

  // ── Quando l'utente incolla/digita una URL → azzera il file input ─────────
  // Evita che file e URL siano attivi contemporaneamente (bug "Input ambiguo").
  $('urlIn').addEventListener('input', function () {
    if (this.value.trim() && $('fileInput').files[0]) {
      $('fileInput').value = '';                                          // svuota file input
      zone.classList.remove('has-file');
      $('fileBtnText').textContent = 'Seleziona o trascina qui un file GPX, KMZ o KML';
      $('fileInfo').classList.remove('on');
      $('fileInfo').textContent = '';
      $('urlIn').placeholder = 'Incolla qui la URL (Google, Apple Maps, Waze)';
      state._sourceFileName = null;
    }
  });

  // ── clearField: svuota un campo e nasconde la X ──────────────────────────
  function clearField(inputId, btnId) {
    const el = $(inputId);
    if (el) { el.value = ''; el.dispatchEvent(new Event('input')); el.focus(); }
    $(btnId)?.classList.remove('on');
  }

  // Mostra/nasconde la X sui campi mentre si digita
  ['urlIn', 'expandedUrlIn', 'nameIn'].forEach(id => {
    const el = $(id);
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
    undoAction,       // Fase 2
    redoAction,       // Fase 2
    decisionExport,   // Fase 3
    decisionOptimize, // Fase 3 — mantenuta per compatibilità (non più esposta nel pannello)
    decisionWpAdjust,  // sostituisce decisionOptimize nel pannello
    decisionWpApply,   // applica la ridistribuzione
    decisionEdit,     // Fase 3
    toggleOriginalLayer, // Fase 4
    showRemovalLog,      // Fase 4
    toggleMapClickMode,  // Map click mode
  });

  // Ripristina stato infoPanel
  try {
    if (localStorage.getItem('infoPanel_open') === 'true') {
      $('infoPanel').classList.add('open');
      $('infoToggleBtn').classList.add('open');
      $('infoToggleBtn').setAttribute('aria-expanded', 'true');
    }
  } catch (e) {}
})();

// v18.0 fix 2b — flag _userHasChosenFormat sostituisce check DOM .fmt-btn.active:
//   - _userHasChosenFormat: false al boot, true al primo click su un .fmt-btn
//     oppure alla prima scelta dal popup SweetAlert in decisionExport().
//   - decisionExport() ora controlla il flag invece di querySelector('.fmt-btn.active')
//     eliminando il falso negativo quando lo stato è aggiornato ma la classe .active
//     non è ancora sincronizzata (o la sessione è stata ricaricata).
// [CHECKP_TASK_06] hash: v18.4_popup_snap_nsnap_restored
// [FIX map edit button] — v18.3
//   Problema: il long-press su sfondo mappa per attivare l'inserimento tappa
//   causava conflitti con lo scroll/pan nativo su mobile (falsi trigger, menu
//   contestuale, interferenza con 2-dita pan).
//   Fix: rimossa tutta la logica long-press su sfondo mappa (_rcLongPressAdded,
//   pointerdown timer, pointermove cancel). Aggiunto pulsante ✏️ dentro la mappa
//   (posizione bottom-left, stile identico ai controlli zoom Leaflet).
//   Funzionamento: tap sul pulsante attiva/disattiva la modalità editing.
//   - Modalità OFF (default): mappa solo visualizzazione, zero conflitti con browser.
//   - Modalità ON: tap su mappa = aggiunge tappa, long-press su marker = rimuove tappa.
//   Il pulsante cambia aspetto (bianco → blu) quando la modalità è attiva.
//   Il long-press sui marker rimane invariato (gestione rimozione tappa).
//   Rimasto: blocco contextmenu globale capture-phase per marker (necessario su Android Chrome).
// [CHECKP_TASK_06] hash: v18.2_scroll_mobile_fix
// [FIX scroll mobile] — v18.2
//   Problema: su smartphone, toccare la mappa con 1 dito spostava la mappa invece
//   di scorrere la pagina, rendendo difficile la navigazione verticale del contenuto.
//   Causa: Leaflet cattura tutti i touch event sulla mappa per gestire pan/zoom,
//   consumandoli prima che raggiungano il browser (e quindi la pagina).
//   Fix applicato in initMap():
//     1. L.map(…, { dragging: !L.Browser.mobile, tap: false })
//        → su mobile, dragging parte DISABILITATO; 1 dito propaga al browser → scroll pagina.
//          tap:false disabilita il tap-handler Leaflet (confliggeva con long-press e click-mode).
//     2. Two-finger gesture handler (_rcGestureAdded):
//        touchstart  (e.touches.length >= 2) → map.dragging.enable()   (pan con 2 dita)
//        touchend    (e.touches.length <  2) → map.dragging.disable()   (ripristino 1-dito)
//        touchcancel                         → map.dragging.disable()
//        Listener passive:true per non impattare le performance di scroll.
//     3. pointerdown long-press bg: aggiunto controllo !e.isPrimary → _lpCancel():
//        il secondo dito annulla il timer long-press evitando false attivazioni
//        durante l'inizio di un pan a 2 dita.
//     4. Hint banner: su mobile aggiornato con "2 dita per spostare / zoomare la mappa".
// [FIX mobile long-press marker] — v18.1 + v18.1.1
//   Problema: long-press su marker Leaflet su Chrome/Safari mobile mostrava il menu
//   contestuale nativo del browser ("Salva immagine") invece di avviare la rimozione tappa.
//   Causa: il marker Leaflet è un <img>; il browser intercettava il touchstart con il suo
//   gestore nativo prima che scattasse il timer a 500ms. Leaflet lega touchstart con
//   passive:true su molte versioni, impedendo a ev.preventDefault() (via Leaflet) di agire.
//   Fix applicato in marker.on('add', ...):
//     - el.style.touchAction = 'none'           → disabilita pan/pinch browser sull'elemento
//     - el.style.webkitTouchCallout = 'none'    → disabilita callout iOS (anteprima img)
//     - el.style.userSelect / webkitUserSelect  → blocca selezione al tocco
//     - el.addEventListener('touchstart', preventDefault, { passive: false })
//         → listener nativo registrato direttamente sull'elemento DOM; passive:false
//           permette preventDefault() prima che il browser mostri il contextmenu
//     - el.addEventListener('contextmenu', preventDefault)
//         → fallback per long-press su desktop o Android WebView
//   Fix secondario in marker.on('mousedown touchstart', ...):
//     - oe.preventDefault() chiamato via Leaflet per touchstart (secondo layer di difesa)
//   Fix v18.1.1 — timing marker.getElement():
//     Problema: marker.getElement() restituiva null durante il callback 'add' su alcune
//     versioni di Leaflet, perché l'elemento non era ancora completamente nel DOM.
//     Conseguenza: il blocco CSS + addEventListener veniva saltato silenziosamente,
//     lasciando il marker senza protezione contro il contextmenu nativo.
//     Fix: wrappato tutto il corpo di marker.on('add') in setTimeout(..., 0) per
//     cedere un tick al browser e garantire che getElement() restituisca l'elemento reale.
//     Spostato anche _markerEls.add(el) dentro il setTimeout per coerenza.
// [FIX contextmenu globale] — v18.1.3
//   Problema: nonostante CSS touch-action:none e -webkit-touch-callout:none (index.html),
//   su Android Chrome il menu contestuale nativo compariva ancora al long-press sui marker.
//   Causa: su Android Chrome, touch-action:none blocca scroll/pan/zoom ma NON il contextmenu
//   su <img>. Il contextmenu è bloccabile SOLO con e.preventDefault() sull'evento 'contextmenu'.
//   Il listener per-marker dentro marker.on('add') era soggetto a problemi di timing
//   (getElement() → null) e all'ordine dei listener passive di Leaflet.
//   Fix: aggiunto listener 'contextmenu' con { capture: true, passive: false } direttamente
//   su #mapPreview nel blocco _rcLongPressAdded (registrato UNA SOLA VOLTA).
//   La capture phase intercetta il contextmenu di tutti i marker figli prima che il browser
//   lo gestisca, immune da timing e dall'ordine di registrazione dei listener Leaflet.
// [FASE_1] updateDashboard(): Da→A WP, km, MyDrive flag
//   - state.setRawImportCount() in go() FASE 2 (pre setWaypoints)
//   - updateDashboard() al termine di fullStateRefresh()
//   - updateDashboard() al termine di go() FASE 4 (post riduzione)
// [FASE_2] Snapshot stack undo/redo:
//   - updateUndoRedo() + subscriber state 'snapshot'/'waypoints'
//   - pushSnapshot() in go() (import, riduzioni)
//   - undoAction() / redoAction() esposte globalmente
//   - Shortcut tastiera Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z
// [FASE_3] Pannello decisionale post-elaborazione:
//   - showDecisionPanel(): sostituisce showElaborationSummary() in go() FASE 4
//   - decisionExport() / decisionOptimize() / decisionEdit() esposte globalmente
//   - fullStateRefresh() aggiorna il pannello se già visibile
//   - undo/redo bar (#undo-redo-bar) mostrata insieme al pannello
// [FASE_4] Visual diff mappa + log semantico:
//   - _f4: mini-state locale per overlayVisible, originalLayer, removalLog
//   - initMap(): costruisce overlayLayer (L.polyline grigio) da rawRoutePoints
//   - toggleOriginalLayer(): addTo/removeLayer senza ricostruire la geometria
//   - decisionOptimize(): snapshot wpsBefore → keptSet → removalLog salvato in _f4
//   - showRemovalLog(): SweetAlert con log ✓/✗ + nota proxy geometrico
//   - showDecisionPanel(): mostra/nasconde #dp-overlay-toggle-row e #dp-log-row
//   - toggleOriginalLayer / showRemovalLog esposte globalmente
// [FASE_5] Routing Equivalence Engine:
//   - _hausdorffSegment(): distanza di Hausdorff haversine tra due array di punti
//   - verifyRouteEquivalence(): verifica per-tratto Valhalla/OSRM vs traccia originale
//     · THRESHOLD_M = 150m, TIMEOUT_LEG_MS = 3000ms, timeout globale 8s
//     · aggiorna removalLog in-place: routingVerified + reason 'equivalent'|'critical'
//     · rate-limit 700ms tra tratti per evitare 429
//   - decisionOptimize(): chiama verifyRouteEquivalence() dopo motoOptimize()
//     · se critical > 0: SweetAlert di avviso con count
//     · se sorgente URL (nessun rawRoutePoints): log "saltata" senza errori
//   - showRemovalLog(): aggiornato con reasonLabel Fase 5 e badge verificato/proxy
// v18.0 fix — mutual exclusion URL ↔ file input:
//   - Aggiunto listener 'input' su #urlIn: se l'utente incolla una URL con un
//     file già caricato, il file input viene resettato e la UI del file azzerata.
//   - Il listener su 'change' di #fileInput già svuotava urlIn: comportamento simmetrico.
//   - Elimina il caso in cui go() riceveva file && urlVal → Swal "Input ambiguo".
// v18.0 changes:
//   - redistributeByDistance sostituisce redistributeUniform per trkpt
//   - nameWaypoints() estratta come funzione riutilizzabile
//   - _consentGate() cancello a tre vie (riduci / ITN / manuale)
//   - _setFormat() centralizza aggiornamento formato + UI bottoni
//   - fast-path trkpt in updateRoutingAndUI (bypassa OSRM anche dopo editing)
//   - go() strutturato in 4 fasi esplicite: parsing / routing / consenso / cronologia
//   - domanda opzionale "vuoi ridurre?" per wps ≤ wpLimit
//   - domanda "quanti waypoint?" per trkpt (slider numero)
//   - KML aggiunto come formato output separato da KMZ
