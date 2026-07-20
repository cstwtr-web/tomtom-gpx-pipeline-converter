// task_14_route_loader.js
// Flusso principale di caricamento rotta: parsing file/URL, geocoding,
// consenso ottimizzazione, cronologia. Estratto da task_01_main.js (D2 refactor).

import { $, esc, addLog, setProgress, sleep } from './task_03_utils.js';
import { parseFile, extractStops, extractAllWaypointCoords, coordStr, isBlob, blobCoords, isShortUrl } from './task_09_parsers.js';
import { geocode, nameWaypoints, _extractViewport } from './task_06_geocoding_client.js';
import { redistributeByDistance, motoOptimize } from './task_07_geometry.js';
import { computePinnedSet } from './task_04_waypoint_policy.js';
import {
  showDecisionPanel,
  setOriginalSrcType,
  setOriginalWaypoints,
  setPinnedSet,
  getPinnedSet,
  invalidateWpCache as _invalidateWpCache,
} from './task_15_decision_panel.js';

// ── Dipendenze iniettate da task_01_main.js via initRouteLoader() ─────────────
let _state, _Swal, _esc, _mapState;
let _fullStateRefresh, _regenerateOutput, _setFormat, _updateDashboard;

export function initRouteLoader(deps) {
  _state            = deps.state;
  _Swal             = deps.Swal;
  _esc              = deps.esc;
  _mapState         = deps.mapState;
  _fullStateRefresh = deps.fullStateRefresh;
  _regenerateOutput = deps.regenerateOutput;
  _setFormat        = deps.setFormat;
  _updateDashboard  = deps.updateDashboard;
}

// ── _consentGate ──────────────────────────────────────────────────────────────
async function _consentGate(wpCount, wpLimit) {
  const result = await _Swal.fire({
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

  if (result.isConfirmed) return 'reduced';
  if (result.isDenied)    return 'itn';
  return 'manual';
}

// ── go(): flusso principale ───────────────────────────────────────────────────
export async function go() {
  const file = $('fileInput').files[0];
  let urlVal = $('urlIn').value.trim();
  _state.setName($('nameIn').value.trim() || 'La mia rotta');

  if (file && urlVal) {
    _Swal.fire({ icon: 'warning', title: 'Input ambiguo', text: 'Scegli solo URL o file', confirmButtonColor: '#1e5aa8' });
    return;
  }
  if (!file && !urlVal) {
    if (_state.getWaypoints().length >= 2) {
      _Swal.fire({
        icon: 'info',
        title: 'Rotta già caricata',
        html: `Stai già lavorando su <b>"${_esc(_state.getName())}"</b> (${_state.getWaypoints().length} tappe).<br>Per elaborarne una nuova, carica un file o incolla un URL.`,
        confirmButtonColor: '#1e5aa8',
      });
    } else {
      _Swal.fire({ icon: 'info', title: 'Nessuna fonte', text: 'Incolla un URL o carica un file GPX/KMZ/KML', confirmButtonColor: '#1e5aa8' });
    }
    return;
  }

  const _isNewFile = file && file.name !== _mapState.lastFileName;
  const _isNewUrl  = urlVal && urlVal !== _mapState.lastUrl;
  if (_state.getWaypoints().length >= 2 && !_isNewFile && !_isNewUrl) {
    const { isConfirmed } = await _Swal.fire({
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
  $('progTitle').textContent = 'Elaborazione in corso…';
  const btn = $('convertBtn');
  btn.disabled = true;
  $('bIcon').innerHTML = '<div class="spin"></div>';
  $('bText').textContent = 'Elaborazione…';
  setProgress(5);

  try {
    let wps = [];

    // ── FASE 1: Parsing ───────────────────────────────────────────────────────
    if (file) {
      addLog('📂 Lettura file: ' + file.name, 'ok');
      const parsed = await parseFile(file, { addLog });
      wps = parsed.waypoints;
      _state.setGpxSourceType(parsed.sourceType);
      setOriginalSrcType(parsed.sourceType);
      setOriginalWaypoints([...wps]);
      const _ps = computePinnedSet([...wps]);
      setPinnedSet(_ps);
      _invalidateWpCache('nuovo file caricato');
      addLog(`📌 Tappe semantiche (pinned): ${_ps.size} su ${wps.length}`, 'dim');
      _state.setRawTrkPoints(parsed.rawPoints ?? null);
      if (parsed.sourceType === 'garmin_hybrid' && parsed.rawPoints) {
        _state.setGarminHybridRawPoints(parsed.rawPoints);
      }
      addLog(`📍 Trovate ${wps.length} tappe (sourceType: ${parsed.sourceType})`, 'ok');
      setProgress(30);

      if (parsed.sourceType === 'trkpt' && parsed.rawPoints?.length > 0) {
        const rawPoints = parsed.rawPoints;
        const wpLimit   = _state.getWpLimit();
        addLog(`📍 Traccia trkpt: ${rawPoints.length} punti GPS`, 'info');
        const reduced = redistributeByDistance(rawPoints, wpLimit);
        addLog(`✅ Riduzione per distanza reale: ${rawPoints.length} → ${reduced.length} waypoint`, 'ok');
        setProgress(40);
        addLog('🌍 Geocoding inverso waypoint intermedi (Nominatim)...', 'info');
        wps = await nameWaypoints(reduced, { addLog, setProgress, progressFrom: 40, progressTo: 65 });
        addLog(`✅ Geocoding inverso completato: ${wps.length} waypoint nominati`, 'ok');
        _state.setRoutePoints(rawPoints);
        setProgress(65);
      }

    } else {
      // ── URL ───────────────────────────────────────────────────────────────
      if (isShortUrl(urlVal)) {
        addLog('🔗 Espansione URL breve in corso...', 'info');
        try {
          const rExp = await fetch('https://maps-redirect-resolver.cst-wtr.workers.dev/?url=' + encodeURIComponent(urlVal));
          if (!rExp.ok) throw new Error('Resolver HTTP ' + rExp.status);
          const dataExp = await rExp.json();
          const expanded = (dataExp.extendedUrl || '').trim();
          if (!expanded || isShortUrl(expanded)) throw new Error('Espansione non valida');
          urlVal = expanded;
          addLog('✅ URL espansa automaticamente', 'ok');
        } catch (eExp) {
          addLog('⚠️ Espansione automatica non riuscita (' + eExp.message + ')', 'warn');
          $('shortUrlArea')?.classList.add('on');
          const manual = $('expandedUrlIn').value.trim();
          if (!manual) {
            window.open('https://www.expandurl.net/?url=' + encodeURIComponent(urlVal), '_blank');
            throw new Error('Incolla la URL espansa nel campo dedicato');
          }
          if (isShortUrl(manual)) throw new Error('Anche la URL incollata è breve: serve la versione estesa');
          urlVal = manual;
          addLog('✅ URL espansa presa dal campo manuale', 'ok');
        }
      }

      const parsed = extractStops(urlVal);
      if (!parsed) throw new Error('URL non riconosciuta');
      addLog(`🔗 Fonte: ${parsed.src} · ${parsed.stops.length} tappe`, 'ok');
      _state.setGpxSourceType('url');
      setProgress(15);

      const viewport     = _extractViewport(urlVal);
      if (viewport) addLog(`🌐 Viewport rilevato: ${viewport.lat.toFixed(4)},${viewport.lon.toFixed(4)} zoom${viewport.zoom}`, 'dim');

      const directCoords = extractAllWaypointCoords(urlVal);

      if (directCoords.length === parsed.stops.length) {
        wps = directCoords.map((c, i) => ({ lat: c.lat, lon: c.lon, name: parsed.stops[i] }));
        addLog('🗺 Coordinate blob (' + directCoords.length + ' tappe)', 'ok');
      } else {
        const nonCoordStops = parsed.stops.filter(s => !coordStr(s) && !isBlob(s));
        const canHybrid     = directCoords.length === nonCoordStops.length;

        if (canHybrid) {
          addLog('🗺 Matching ibrido: ' + directCoords.length + ' blob + ' + (parsed.stops.length - directCoords.length) + ' coord dirette', 'ok');
          let blobIdx = 0;
          for (let i = 0; i < parsed.stops.length; i++) {
            const s = parsed.stops[i], cd = coordStr(s);
            if (cd)             { wps.push(cd); }
            else if (isBlob(s)) { const ex = blobCoords(s); if (ex) wps.push(ex); }
            else                { wps.push({ lat: directCoords[blobIdx].lat, lon: directCoords[blobIdx].lon, name: s }); blobIdx++; }
            setProgress(15 + Math.round(50 * (i + 1) / parsed.stops.length));
          }
        } else {
          addLog('🔍 Geocoding individuale (blob=' + directCoords.length + ' vs stop=' + parsed.stops.length + ')', 'dim');
          for (let i = 0; i < parsed.stops.length; i++) {
            const s = parsed.stops[i], cd = coordStr(s);
            if (cd)             { wps.push(cd); }
            else if (isBlob(s)) { const ex = blobCoords(s); if (ex) wps.push(ex); }
            else                { const g = await geocode(s, { viewportBias: viewport }); wps.push(g); if (i < parsed.stops.length - 1) await sleep(1150); }
            setProgress(15 + Math.round(50 * (i + 1) / parsed.stops.length));
          }
        }
      }
      setProgress(65);
    }

    if (wps.length < 2) throw new Error('Meno di 2 tappe valide trovate');

    // ── FASE 2: Routing + mappa ───────────────────────────────────────────────
    addLog(`🗺️ ${wps.length} waypoint pronti → routing...`, 'info');
    _state.setRawImportCount(wps.length);
    _state.setWaypoints(wps);
    _state.resetSnapshots();
    _state.pushSnapshot('Import originale', { pristine: true });
    $('mapPreview').classList.add('on');
    $('results').classList.add('on');
    $('mapPlaceholder').classList.add('hidden');
    _mapState.hasBeenFitted = false;
    setProgress(70);
    await _fullStateRefresh();
    setProgress(85);

    // ── FASE 3: Consenso ─────────────────────────────────────────────────────
    const wpCount = _state.getWaypoints().length;
    const wpLimit = _state.getWpLimit();
    const srcType = _state.getGpxSourceType();

    if (wpCount > wpLimit && srcType !== 'trkpt') {
      const choice = await _consentGate(wpCount, wpLimit);

      if (choice === 'reduced') {
        const currentWps = _state.getWaypoints();
        const reduced    = motoOptimize(currentWps, srcType, wpLimit, { addLog, pinnedSet: getPinnedSet() ?? undefined });
        _state.setWaypoints(reduced);
        _setFormat('gpx');

        if (srcType === 'garmin_hybrid') {
          const originalTrack = _state.getRawTrkPoints();
          if (originalTrack?.length > 0) {
            _state.setRoutePoints(originalTrack);
            _state.setGpxSourceType('trkpt');
            addLog(`🗺️ Traccia Garmin originale ripristinata: ${originalTrack.length} punti (OSRM bypassato)`, 'ok');
          }
        }

        await _fullStateRefresh();
        addLog(`✂️ Riduzione: ${wpCount} → ${reduced.length} tappe (GPX)`, 'ok');
        _state.pushSnapshot('Ottimizzazione automatica');

      } else if (choice === 'itn') {
        _setFormat('itn');
        await _regenerateOutput();
        addLog(`💾 ${wpCount} tappe → formato ITN (microSD/USB)`, 'ok');

      } else {
        addLog('✏️ Modifica manuale: intervieni sulla lista tappe', 'info');
        $('progTitle').textContent = '✏️ Modifica le tappe e riesporta';
        return;
      }

    } else if (srcType === 'trkpt') {
      const result = await _Swal.fire({
        icon: 'info',
        title: 'Traccia GPS ridotta',
        html: `La traccia aveva <b>${_state.getRawTrkPoints()?.length ?? '?'} punti GPS</b>.<br>
               Ho estratto <b>${wpCount} waypoint navigabili</b> distribuiti sul percorso.<br><br>
               Vuoi procedere o preferisci un numero diverso?`,
        confirmButtonText: '✅ Procedi',
        confirmButtonColor: '#1e5aa8',
        showCancelButton: true,
        cancelButtonText: '✏️ Scelgo il numero',
        cancelButtonColor: '#9ca3af',
      });
      if (!result.isConfirmed) {
        const { value: userCount } = await _Swal.fire({
          title: 'Quanti waypoint vuoi?',
          input: 'number',
          inputAttributes: { min: 2, max: 255, step: 1 },
          inputValue: wpCount,
          confirmButtonText: 'Applica',
          confirmButtonColor: '#1e5aa8',
          showCancelButton: true,
        });
        if (userCount && parseInt(userCount) >= 2) {
          const rawPoints = _state.getRoutePoints();
          if (rawPoints?.length > 0) {
            const reReduced = redistributeByDistance(rawPoints, parseInt(userCount));
            addLog(`🌍 Ricalcolo geocoding per ${reReduced.length} waypoint...`, 'info');
            const reNamed = await nameWaypoints(reReduced, { addLog });
            _state.setWaypoints(reNamed);
            await _fullStateRefresh();
            addLog(`✅ Ridistribuiti a ${reNamed.length} waypoint`, 'ok');
            _state.pushSnapshot(`Ridistribuzione a ${reNamed.length} waypoint`);
          }
        }
      }
    }

    // ── FASE 4: Riepilogo e cronologia ────────────────────────────────────────
    showDecisionPanel();
    _updateDashboard();
    setProgress(100);
    $('progTitle').textContent = '✅ ELABORAZIONE COMPLETATA';

    const finalCount   = _state.getWaypoints().length;
    const myDriveLimit = _state.getWpLimit();
    if (finalCount > myDriveLimit && _state.getFormat() !== 'itn') {
      _setFormat('itn');
      await _regenerateOutput();
      addLog(`⚠️ Formato ITN preselezionato (${finalCount} tappe > ${myDriveLimit})`, 'warn');
    } else if (finalCount <= myDriveLimit && _state.getFormat() === 'itn') {
      _setFormat('gpx');
      await _regenerateOutput();
      addLog(`✅ Formato GPX riabilitato (${finalCount} tappe ≤ ${myDriveLimit})`, 'ok');
    }

    _mapState.lastFileName = file ? file.name : null;
    _mapState.lastUrl      = urlVal || null;

    _state.pushHistory({
      name:      _state.getName(),
      url:       $('urlIn').value,
      wps:       _state.getWaypoints().length,
      fmt:       _state.getFormat(),
      ts:        Date.now(),
      waypoints: _state.getWaypoints(),
    });
    try { localStorage.setItem('routeConvHistory', JSON.stringify(_state.getHistory())); } catch (e) {}

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
