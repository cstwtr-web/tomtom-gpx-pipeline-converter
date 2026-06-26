// task_17_decision_panel.js
// Pannello decisionale: visualizzazione, controllo tappe +/−, export, ottimizzazione,
// editing manuale, cache percorsi, log rimozioni.
// Estratto da task_01_main.js (D3 refactor).

import { $ }                             from './task_03_utils.js';
import { computePinnedSet }              from './task_05_waypoint_policy.js';
import { isSemanticName }                from './task_05_waypoint_policy.js';
import { redistributeByDistance }        from './task_08_geometry.js';
import { motoOptimize }                  from './task_08_geometry.js';
import { nameWaypoints }                 from './task_07_geocoding_client.js';

// ── Dipendenze iniettate da task_01_main.js via init() ───────────────────────
let _state, _addLog, _setProgress, _esc, _sleep, _Swal;
let _fullStateRefresh, _regenerateOutput, _setFormat, _updateUndoRedo;
let _engine, _verifyRouteEquivalence;

export function initDecisionPanel(deps) {
  _state                = deps.state;
  _addLog               = deps.addLog;
  _setProgress          = deps.setProgress;
  _esc                  = deps.esc;
  _sleep                = deps.sleep;
  _Swal                 = deps.Swal;
  _fullStateRefresh     = deps.fullStateRefresh;
  _regenerateOutput     = deps.regenerateOutput;
  _setFormat            = deps.setFormat;
  _updateUndoRedo       = deps.updateUndoRedo;
  _engine               = deps.engine;
  _verifyRouteEquivalence = deps.verifyRouteEquivalence;
}

// ── Stato locale del pannello ─────────────────────────────────────────────────
export let _dpWpTarget        = null;
export let _originalSrcType   = null;
export let _originalWaypoints = null;
export let _pinnedSet         = null;

export function setOriginalSrcType(v)   { _originalSrcType   = v; }
export function setOriginalWaypoints(v) { _originalWaypoints = v; }
export function setPinnedSet(v)         { _pinnedSet         = v; }
export function getPinnedSet()          { return _pinnedSet; }

// ── Cache percorsi per numero di tappe ───────────────────────────────────────
let _wpCache = {};

export function invalidateWpCache(reason) {
  _wpCache = {};
  _addLog(`🗑️ Cache tappe invalidata (${reason})`, 'dim');
}

export function snapshotWpCache(key) {
  _wpCache[key] = {
    waypoints:   _state.getWaypoints().map(w => ({ ...w })),
    routePoints: _state.getRoutePoints() ? [..._state.getRoutePoints()] : null,
  };
}

// ── Helper DOM controlli WP ───────────────────────────────────────────────────
export function getDpWpControls() {
  return {
    applyBtn: $('dp-wp-apply'),
    minusBtn: $('dp-wp-minus'),
    plusBtn:  $('dp-wp-plus'),
    hintEl:   $('dp-wp-hint'),
    countEl:  $('dp-wp-count'),
  };
}

// ── setUndoRedoEnabled ────────────────────────────────────────────────────────
export function setUndoRedoEnabled(_enabled) {
  _updateUndoRedo();
}

// ── showDecisionPanel ─────────────────────────────────────────────────────────
export function showDecisionPanel() {
  const panel = $('decision-panel');
  if (!panel) return;
  const wps  = _state.getWaypoints();
  const dist = _state.getRouteDistance();
  const orig = _state.getRawImportCount?.() || wps.length;

  const kmStr = dist > 0 ? `${(dist / 1000).toFixed(1)} km` : '— km';
  const wpStr = orig !== wps.length ? `Da ${orig} → ${wps.length} WP` : `${wps.length} WP`;
  const summaryEl = $('dp-summary-text');
  if (summaryEl) summaryEl.textContent = `${wpStr} · ${kmStr}`;

  const ctrlEl = $('dp-btn-optimize-ctrl');
  const { applyBtn, minusBtn, plusBtn, hintEl, countEl } = getDpWpControls();

  if (ctrlEl) {
    const canAdjust = wps.length >= 2;
    const locked    = _state.hasManualEditSinceImport?.() ?? false;
    ctrlEl.style.opacity       = canAdjust ? '1' : '.38';
    ctrlEl.style.pointerEvents = canAdjust ? 'auto' : 'none';

    const rawCount = _state.getRawImportCount?.() || wps.length;

    if (_dpWpTarget === null) {
      if (countEl)  countEl.textContent = wps.length;
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = false; applyBtn.textContent = 'Applica'; }
      if (hintEl)   hintEl.textContent = locked ? '🔒 manuale attivo' : 'automatico';
      if (minusBtn) minusBtn.disabled = locked || wps.length <= 2;
      if (plusBtn)  plusBtn.disabled  = locked || wps.length >= rawCount;
    } else {
      if (minusBtn) minusBtn.disabled = locked || _dpWpTarget <= 2;
      if (plusBtn)  plusBtn.disabled  = locked || _dpWpTarget >= rawCount;
    }
  }

  // Toggle overlay traccia originale
  const mapOverlay = $('map-confronta-overlay');
  const rawPts     = _state.getRawRoutePoints();
  const hasOverlay = rawPts?.length > 0 && rawPts !== _state.getRoutePoints();
  if (mapOverlay) mapOverlay.style.display = hasOverlay ? '' : 'none';
  const chk = $('dp-overlay-chk');
  if (chk) chk.checked = _state.getOverlayVisible?.() ?? false;

  panel.classList.add('on');
  $('bigExportBtn')?.classList.add('on');

  const btnLog     = $('btn-log');
  const logWrapper = $('dp-log-row-wrapper');
  if (btnLog) {
    const hasLog = (_state.getRemovalLog()?.length ?? 0) > 0;
    btnLog.classList.toggle('visible', hasLog);
    if (logWrapper) logWrapper.style.display = hasLog ? '' : 'none';
  }
}

// ── showRemovalLog ────────────────────────────────────────────────────────────
export function showRemovalLog() {
  const rLog = _state.getRemovalLog();
  if (!rLog?.length) return;

  const reasonLabel = {
    obligatory:     'obbligato, capo/coda',
    characteristic: 'mantenuto (geometria)',
    redundant:      'geometricamente ridondante',
    equivalent:     'rimosso — routing equivalente ✅',
    critical:       'rimosso — DEVIAZIONE CRITICA ⚠️',
  };

  const rows = rLog.map(e => {
    const name       = e.name ?? '—';
    const country    = e.countryCode ? `, ${e.countryCode}` : '';
    const label      = reasonLabel[e.reason] ?? e.reason;
    const icon       = e.action === 'kept' ? '✓' : '✗';
    const isCritical = e.reason === 'critical';
    const color      = isCritical ? '#92400e' : e.action === 'kept' ? '#065f46' : '#991b1b';
    const verified   = e.routingVerified
      ? `<span style="font-size:10px;color:#6b7280;"> · routing verificato</span>`
      : `<span style="font-size:10px;color:#9ca3af;"> · proxy geometrico</span>`;
    return `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;font-size:12px;line-height:1.5;">
      <span style="color:${color};font-weight:700;flex-shrink:0;width:14px;">${icon}</span>
      <span>
        <b style="color:${color};">${e.action === 'kept' ? 'Mantenuto' : 'Rimosso'}</b>
        — ${_esc(name)}${_esc(country)}
        <span style="color:#6b7280;font-weight:400;"> (${label})</span>
        ${verified}
      </span>
    </div>`;
  }).join('');

  const note = `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:10.5px;color:#6b7280;line-height:1.6;">
    ℹ️ Le voci con <em>routing verificato</em> sono state confermate da OSRM/Valhalla (Fase 5).
    Le voci con <em>proxy geometrico</em> non hanno ricevuto risposta entro il timeout (3s/tratto).
  </div>`;

  _Swal.fire({
    title: 'Log semantico rimozioni',
    html: `<div style="text-align:left;max-height:340px;overflow-y:auto;">${rows}${note}</div>`,
    confirmButtonText: 'Chiudi',
    confirmButtonColor: '#1e5aa8',
    width: 520,
  });
}

// ── decisionExport ────────────────────────────────────────────────────────────
export async function decisionExport() {
  const wpLimit      = _state.getWpLimit();
  const suggestedFmt = !Number.isFinite(wpLimit) ? 'kmz' : wpLimit <= 20 ? 'gpx' : 'itn';
  const styleFor = fmt => fmt === suggestedFmt
    ? 'padding:12px;border:2px solid #16a34a;border-radius:10px;background:#f0fdf4;color:#0f2b4d;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;'
    : 'padding:12px;border:2px solid #2c7dc3;border-radius:10px;background:#f5f9ff;color:#0f2b4d;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;';

  const result = await _Swal.fire({
    icon: 'question',
    title: 'Scegli il formato di export',
    html: `<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
      <button id="sw-gpx" style="${styleFor('gpx')}">📦 GPX — TomTom MyDrive<br><span style="font-size:11px;font-weight:400;color:#4a6fa5;">Consigliato per percorsi ≤ 20 tappe via App</span></button>
      <button id="sw-itn" style="${styleFor('itn')}">🗺️ ITN — TomTom nativo<br><span style="font-size:11px;font-weight:400;color:#4a6fa5;">Per caricamento via microSD/USB, fino a 255 tappe</span></button>
      <button id="sw-kmz" style="${styleFor('kmz')}">🌍 KMZ — Google Earth<br><span style="font-size:11px;font-weight:400;color:#4a6fa5;">Per visualizzazione su Google Earth / Maps</span></button>
    </div>`,
    showConfirmButton: false,
    showCancelButton: true,
    cancelButtonText: 'Annulla',
    cancelButtonColor: '#9ca3af',
    didOpen: () => {
      ['gpx', 'itn', 'kmz'].forEach(fmt => {
        document.getElementById(`sw-${fmt}`)?.addEventListener('click', () => {
          _Swal.clickConfirm();
          _setFormat(fmt);
        });
      });
    },
  });
  if (result.isDismissed) return;
  _addLog('✅ Esportazione diretta (nessuna ottimizzazione)', 'ok');
  _state.pushSnapshot(`Tappe fissate a ${_state.getWaypoints().length} (export)`);
  setUndoRedoEnabled(true);
  _updateUndoRedo();
  await _regenerateOutput();
  window.download?.();
}

// ── decisionOptimize ──────────────────────────────────────────────────────────
export async function decisionOptimize() {
  const wps     = _state.getWaypoints();
  const wpLimit = _state.getWpLimit();
  const srcType = _state.getGpxSourceType();
  if (wps.length <= 2 || srcType === 'trkpt') return;

  const result = await _Swal.fire({
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

  const wpsBefore  = [...wps];
  const target     = Math.min(wps.length - 1, wpLimit);
  const reduced    = motoOptimize(wps, srcType, target, { addLog: _addLog, pinnedSet: _pinnedSet ?? undefined });

  const keptSet    = new Set(reduced.map(w => `${w.lat.toFixed(6)},${w.lon.toFixed(6)}`));
  const removalLog = wpsBefore.map((w, i) => {
    const key  = `${w.lat.toFixed(6)},${w.lon.toFixed(6)}`;
    const kept = keptSet.has(key);
    let reason;
    if (i === 0 || i === wpsBefore.length - 1) reason = 'obligatory';
    else if (kept)                              reason = 'characteristic';
    else                                        reason = 'redundant';
    return { action: kept ? 'kept' : 'removed', name: w.name ?? null, countryCode: w.countryCode ?? null, reason };
  });
  _state.setRemovalLog(removalLog);

  _state.setWaypoints(reduced);
  _state.pushSnapshot('Ottimizzazione automatica');
  await _fullStateRefresh();
  showDecisionPanel();
  _addLog(`⚡ Ottimizzazione: ${wps.length} → ${reduced.length} tappe`, 'ok');

  const originalPts = _state.getRawRoutePoints();
  if (originalPts?.length > 0 && reduced.length >= 2) {
    _addLog('🔬 Avvio verifica routing reale (Fase 5)...', 'info');
    const globalAC  = new AbortController();
    const globalTid = setTimeout(() => {
      globalAC.abort();
      _addLog('⏱ Verifica interrotta (timeout 8s)', 'warn');
    }, 8000);
    try {
      const { verified, unverified, critical } = await _verifyRouteEquivalence(
        reduced, originalPts, globalAC.signal
      );
      clearTimeout(globalTid);
      showDecisionPanel();
      if (critical > 0) {
        _addLog(`⚠️ ${critical} tratt${critical > 1 ? 'i' : 'o'} con deviazione > 150m — verifica il percorso nel log`, 'warn');
        await _Swal.fire({
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
        _addLog(`✅ Verifica routing: tutti i ${verified} tratti equivalenti (≤ 150m)`, 'ok');
      }
    } catch (err) {
      clearTimeout(globalTid);
      if (err.name !== 'AbortError') _addLog(`❌ Verifica routing fallita: ${err.message}`, 'warn');
    }
  } else {
    _addLog('ℹ️ Verifica routing saltata (nessuna traccia originale disponibile — sorgente URL)', 'dim');
  }
}

// ── decisionWpAdjust ──────────────────────────────────────────────────────────
export function decisionWpAdjust(delta) {
  if (_state.hasManualEditSinceImport?.()) {
    _addLog('⚠️ Regolazione automatica disabilitata: è stato fatto un editing manuale su questo tracciato', 'warn');
    return;
  }
  const wps      = _state.getWaypoints();
  const rawCount = _state.getRawImportCount?.() || wps.length;
  if (_dpWpTarget === null) _dpWpTarget = wps.length;
  _dpWpTarget = Math.max(2, Math.min(rawCount, _dpWpTarget + delta));

  const { applyBtn, minusBtn, plusBtn, hintEl, countEl } = getDpWpControls();

  if (countEl)  countEl.textContent  = _dpWpTarget;
  if (minusBtn) minusBtn.disabled    = _dpWpTarget <= 2;
  if (plusBtn)  plusBtn.disabled     = _dpWpTarget >= rawCount;

  const diff = _dpWpTarget - wps.length;
  if (hintEl) {
    hintEl.textContent = diff === 0 ? 'nessuna modifica' : diff > 0 ? `+${diff} tappe` : `${diff} tappe`;
  }
  if (applyBtn) applyBtn.style.display = 'none';

  clearTimeout(decisionWpAdjust._debounce);
  if (_dpWpTarget !== wps.length) {
    decisionWpAdjust._debounce = setTimeout(() => decisionWpApply(), 400);
  }
}

// ── decisionWpApply ───────────────────────────────────────────────────────────
export async function decisionWpApply() {
  if (_state.hasManualEditSinceImport?.()) {
    _addLog('⚠️ Applica ignorato: editing manuale attivo, modalità automatica disabilitata', 'warn');
    _dpWpTarget = null;
    return;
  }
  _addLog(`🎯 decisionWpApply(): _dpWpTarget=${_dpWpTarget}`, 'dim');
  if (_dpWpTarget === null) {
    _addLog('⚠️ Applica ignorato: nessuna modifica pendente (_dpWpTarget è null)', 'warn');
    return;
  }
  const wps    = _state.getWaypoints();
  const target = _dpWpTarget;
  _dpWpTarget  = null;

  if (target === wps.length) {
    _addLog('ℹ️ Nessuna modifica: il target coincide con il numero attuale di tappe', 'dim');
    showDecisionPanel();
    return;
  }

  // Cache hit
  if (_wpCache[target]) {
    const cached = _wpCache[target];
    snapshotWpCache(wps.length);
    _state.setWaypoints(cached.waypoints.map(w => ({ ...w })));
    if (cached.routePoints) _state.setRoutePoints([...cached.routePoints]);
    setUndoRedoEnabled(false);
    await _fullStateRefresh();
    showDecisionPanel();
    _addLog(`⚡ Cache hit: ${target} tappe ripristinate istantaneamente`, 'ok');
    return;
  }

  // Cache miss
  snapshotWpCache(wps.length);
  setUndoRedoEnabled(false);

  const origSrc = _originalSrcType ?? _state.getGpxSourceType();
  _addLog(`🔧 Ridistribuzione a ${target} tappe (sorgente originale: ${origSrc})…`, 'info');

  const { applyBtn, minusBtn, plusBtn, hintEl } = getDpWpControls();
  if (applyBtn)  { applyBtn.disabled = true; applyBtn.textContent = '⏳ …'; }
  if (minusBtn) minusBtn.disabled = true;
  if (plusBtn)  plusBtn.disabled  = true;
  if (hintEl) hintEl.textContent = 'elaborazione in corso…';

  let reduced;
  const rawTrk = _state.getRawTrkPoints();

  if (origSrc === 'trkpt') {
    if (!rawTrk?.length) { _addLog('❌ Traccia GPS originale non disponibile (rawTrkPoints vuoti)', 'warn'); return; }
    const reReduced = redistributeByDistance(rawTrk, target);
    _addLog(`🌍 Geocoding inverso per ${reReduced.length} waypoint…`, 'info');
    reduced = await nameWaypoints(reReduced, { addLog: _addLog });
  } else {
    const srcPool         = _originalWaypoints?.length >= 2 ? _originalWaypoints : wps;
    const activePinnedSet = _pinnedSet ?? computePinnedSet(srcPool);
    const pinnedCount     = [...activePinnedSet].filter(i => i !== 0 && i !== srcPool.length - 1 && isSemanticName(srcPool[i]?.name)).length + 2;

    if (target < pinnedCount && pinnedCount > 2) {
      if (applyBtn)  { applyBtn.disabled = false; applyBtn.textContent = 'Applica'; }
      if (minusBtn) minusBtn.disabled = false;
      if (plusBtn)  plusBtn.disabled  = false;
      if (hintEl) hintEl.textContent = 'modifica tappe';
      _dpWpTarget = null;

      const semanticNames = [...activePinnedSet]
        .filter(i => i !== 0 && i !== srcPool.length - 1)
        .map(i => srcPool[i]?.name)
        .filter(Boolean)
        .slice(0, 5)
        .join(', ');

      const { isConfirmed } = await _Swal.fire({
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

      if (!isConfirmed) { showDecisionPanel(); return; }
      reduced = motoOptimize(srcPool, origSrc, target, { addLog: _addLog });
    } else {
      reduced = motoOptimize(srcPool, origSrc, target, { addLog: _addLog, pinnedSet: activePinnedSet });
    }
  }

  if (rawTrk?.length > 0) _state.setRoutePoints(rawTrk);

  _state.setWaypoints(reduced);
  await _fullStateRefresh();

  snapshotWpCache(reduced.length);

  showDecisionPanel();
  _addLog(`✅ Ridistribuzione completata: ${wps.length} → ${reduced.length} tappe`, 'ok');
}

// ── decisionEdit ──────────────────────────────────────────────────────────────
export function decisionEdit() {
  _state.pushSnapshot(`Tappe fissate a ${_state.getWaypoints().length} (modifica manuale)`);
  setUndoRedoEnabled(true);
  _updateUndoRedo();
  if (window.innerWidth < 1024) {
    const wrap   = $('wpList-wrap');
    const header = $('wpList-accordion-header');
    if (wrap && !wrap.classList.contains('open')) {
      wrap.classList.add('open');
      if (header) { header.classList.add('open'); header.setAttribute('aria-expanded', 'true'); }
      sessionStorage.setItem('wplist-open', 'true');
    }
  }
  const wpWrap = $('wpList-wrap');
  if (wpWrap) wpWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  _addLog('📋 Lista tappe aperta — aggiungi, rimuovi o riordina le tappe', 'info');
}
