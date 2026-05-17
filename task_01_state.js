// task_01 - hash_input: a3f5c8e (Route_converter_v18.0, righe 553-571)
// Gestione stato centrale con event emitter.
// Nessuna variabile globale: tutto è incapsulato in createState().
// Signature stabile: i nomi dei metodi non cambieranno mai.

// Clona profondamente POJO serializzabili (waypoint sono sempre serializzabili)
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

export function createState() {
  // ── Stato interno ──────────────────────────────────────────
  let waypoints      = [];          // [{lat, lon, name, ...}, ...]  modello esteso v0.E
  let routePoints    = null;        // [{lat, lon}, ...] geometria route
  let routeDistance  = 0;           // metri
  let routeDuration  = 0;           // secondi
  let garminHybridRawPoints = null; // fast-path Garmin: trkpt grezzi
  let output         = '';          // stringa GPX/ITN/KMZ corrente
  let name           = 'La mia rotta';
  let format         = 'gpx';       // 'gpx' | 'itn' | 'kmz'
  let wpLimit        = 21;          // max waypoint per il modello TomTom
  let rawTrkPoints   = null;        // raw trkpt per debug/export
  let rawRoutePoints = null;        // route points pre-pruning (per rilevamento inversioni)
  let gpxSourceType  = 'url';       // 'url' | 'garmin' | 'track' | ...
  let map            = null;        // istanza Leaflet (opaque ref)
  let tileLayerRef   = null;        // ref tile layer Leaflet
  let pendingRouting = null;        // AbortController in volo
  let history        = [];          // [{name, url, wps, fmt, ts, waypoints}]
  let _rawImportCount = 0;          // conteggio waypoint all'import (Fase 1 dashboard)
  let _snapshots      = [];         // array di stati completi, max 10  (Fase 2)
  let _snapIdx        = -1;         // cursore corrente nello stack

  // ── Event emitter ─────────────────────────────────────────
  const listeners = [];

  function emit(event, value) {
    listeners.forEach(fn => {
      try { fn(event, value); } catch (e) { console.error('state listener error', e); }
    });
  }

  // ── API pubblica ───────────────────────────────────────────
  return {

    // Subscription
    subscribe(fn) { listeners.push(fn); },
    unsubscribe(fn) {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },

    // Waypoints
    getWaypoints()          { return [...waypoints]; },
    setWaypoints(wps)       { waypoints = [...wps]; emit('waypoints', waypoints); },
    getWpLimit()            { return wpLimit; },
    setWpLimit(n)           { wpLimit = n; emit('wpLimit', wpLimit); },

    // Route geometry
    getRoutePoints()        { return routePoints; },
    setRoutePoints(pts)     { routePoints = pts; emit('routePoints', routePoints); },
    getRouteDistance()      { return routeDistance; },
    setRouteDistance(m)     { routeDistance = m; emit('routeDistance', routeDistance); },
    getRouteDuration()      { return routeDuration; },
    setRouteDuration(s)     { routeDuration = s; emit('routeDuration', routeDuration); },

    // Garmin hybrid fast-path
    getGarminHybridRawPoints()    { return garminHybridRawPoints; },
    setGarminHybridRawPoints(pts) { garminHybridRawPoints = pts; },

    // Output
    getOutput()             { return output; },
    setOutput(str)          { output = str; emit('output', output); },

    // Nome rotta
    getName()               { return name; },
    setName(n)              { name = n; emit('name', name); },

    // Formato
    getFormat()             { return format; },
    setFormat(fmt)          { format = fmt; emit('format', format); },

    // Raw trkpt (debug/export)
    getRawTrkPoints()       { return rawTrkPoints; },
    setRawTrkPoints(pts)    { rawTrkPoints = pts; },

    // Route points pre-pruning (per rilevamento inversioni)
    getRawRoutePoints()     { return rawRoutePoints; },
    setRawRoutePoints(pts)  { rawRoutePoints = pts; },

    // GPX source type
    getGpxSourceType()      { return gpxSourceType; },
    setGpxSourceType(t)     { gpxSourceType = t; },

    // Leaflet map refs (opaque, non emettono eventi)
    getMap()                { return map; },
    setMap(m)               { map = m; },
    getTileLayerRef()       { return tileLayerRef; },
    setTileLayerRef(ref)    { tileLayerRef = ref; },

    // Routing in volo
    getPendingRouting()     { return pendingRouting; },
    setPendingRouting(ctrl) { pendingRouting = ctrl; },

    // Cronologia conversioni
    getHistory()            { return [...history]; },
    setHistory(h)           { history = [...h]; emit('history', history); },
    pushHistory(entry) {
      if (!entry || !Array.isArray(entry.waypoints)) {
        console.warn('[state] pushHistory: entry non valida (waypoints mancanti), ignorata', entry);
        return;
      }
      if (entry.waypoints.length > 200) {
        console.warn(`[state] pushHistory: entry con ${entry.waypoints.length} waypoint (>200), ignorata`);
        return;
      }
      history.unshift(entry);
      if (history.length > 5) history.pop();
      emit('history', history);
    },
    clearHistory()          { history = []; emit('history', history); },

    // Conteggio waypoint originali all'import (Fase 1 — dashboard)
    getRawImportCount()  { return _rawImportCount; },
    setRawImportCount(n) { _rawImportCount = n; },

    // Snapshot stack (undo/redo — Fase 2)
    pushSnapshot(label) {
      const snap = {
        label,
        timestamp: Date.now(),
        waypoints: deepClone(waypoints),
      };
      _snapshots.splice(_snapIdx + 1);      // elimina ramo redo
      _snapshots.push(snap);
      if (_snapshots.length > 10) _snapshots.shift();
      _snapIdx = _snapshots.length - 1;
    },

    undo() {
      if (_snapIdx > 0) {
        _snapIdx--;
        waypoints = deepClone(_snapshots[_snapIdx].waypoints);
        emit('waypoints', waypoints);
        emit('snapshot', _snapshots[_snapIdx]);
      }
    },

    redo() {
      if (_snapIdx < _snapshots.length - 1) {
        _snapIdx++;
        waypoints = deepClone(_snapshots[_snapIdx].waypoints);
        emit('waypoints', waypoints);
        emit('snapshot', _snapshots[_snapIdx]);
      }
    },

    canUndo()          { return _snapIdx > 0; },
    canRedo()          { return _snapIdx < _snapshots.length - 1; },
    getSnapshotLabel() { return _snapshots[_snapIdx]?.label ?? null; },

    // Snapshot completo (utile per serializzazione/debug)
    snapshot() {
      return {
        waypoints: [...waypoints],
        routeDistance,
        routeDuration,
        output,
        name,
        format,
        wpLimit,
        gpxSourceType,
      };
    },
  };
}

// [CHECKP_TASK_01] hash: v18.0_c7d3a91
// [FASE_0] 0.D: validazione entry in pushHistory (waypoints array + limite 200)
// [FASE_1] getRawImportCount / setRawImportCount per dashboard persistente
// [FASE_2] deepClone + _snapshots/_snapIdx + pushSnapshot/undo/redo/canUndo/canRedo/getSnapshotLabel
