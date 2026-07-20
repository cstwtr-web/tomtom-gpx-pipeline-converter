// task_10_engine.js
// Routing engine: fetch singola (Valhalla → OSRM fallback) + chunked per N>10 waypoint.
// Funzioni pure: nessun DOM, nessuna variabile globale.
// decodePolyline6 è fornita dall'esterno tramite deps.

// Polyfill AbortSignal.any per Safari ≤16 e Chrome ≤115
if (!AbortSignal.any) {
  AbortSignal.any = (signals) => {
    const ac = new AbortController();
    for (const s of signals)
      s.addEventListener('abort', () => ac.abort(), { once: true });
    return ac.signal;
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.decodePolyline6 - (encoded:string) => [{lat,lon},...]
 * @param {Function} deps.addLog         - (msg:string, type:string) => void
 * @param {Function} deps.sleep          - (ms:number) => Promise<void>
 */
export function createRoutingEngine({ decodePolyline6, addLog, sleep }) {

  // Helper: combina signal esterno con timeout locale
  function makeSignal(externalSignal, ms) {
    const tc  = new AbortController();
    const tid = setTimeout(() => tc.abort(), ms);
    const combined = AbortSignal.any
      ? AbortSignal.any([externalSignal, tc.signal].filter(Boolean))
      : tc.signal;
    return { combined, clear: () => clearTimeout(tid) };
  }

  // ── Singola richiesta: Valhalla → OSRM fallback ──────────────────────────
  /**
   * @param {Array<{lat,lon}>} waypoints
   * @param {AbortSignal}      [signal]
   * @returns {Promise<{points,distance,duration}|null>}
   */
  /**
   * fetchSingleRoute — strategia "optimistic":
   * 1. Lancia OSRM e Valhalla in parallelo.
   * 2. Ritorna appena il primo risponde con successo.
   * 3. Se OSRM vince, Valhalla gira ancora in background:
   *    quando risponde chiama onValhallaUpgrade(result) per aggiornare
   *    la mappa senza bloccare il rendering iniziale.
   *
   * @param {Array<{lat,lon}>} waypoints
   * @param {AbortSignal}      [signal]
   * @param {Function}         [onValhallaUpgrade] - callback se Valhalla arriva dopo OSRM
   */
  async function fetchSingleRoute(waypoints, signal, onValhallaUpgrade) {
    if (!waypoints || waypoints.length < 2) return null;

    const VALHALLA_TIMEOUT_MS = 8000;
    const OSRM_TIMEOUT_MS     = 15000;

    async function tryValhalla() {
      const { combined: valSignal, clear: valClear } = makeSignal(signal, VALHALLA_TIMEOUT_MS);
      try {
        const body = JSON.stringify({
          locations: waypoints.map(w => ({ lon: w.lon, lat: w.lat })),
          costing: 'motorcycle',
          directions_options: { units: 'km' },
        });
        const r = await fetch('https://valhalla.openstreetmap.de/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: valSignal,
        });
        if (!r.ok) throw new Error(`Valhalla HTTP ${r.status}`);
        const data = await r.json();
        const allCoords = [];
        for (const leg of (data?.trip?.legs ?? [])) {
          if (typeof leg.shape === 'string' && leg.shape.length > 0)
            allCoords.push(...decodePolyline6(leg.shape));
        }
        if (allCoords.length === 0) throw new Error('Valhalla: nessuna geometria');
        return {
          points:   allCoords,
          distance: (data.trip.summary?.length ?? 0) * 1000,
          duration:  data.trip.summary?.time ?? 0,
          _src: 'valhalla',
        };
      } finally { valClear(); }
    }

    async function tryOSRM() {
      const { combined: osrmSignal, clear: osrmClear } = makeSignal(signal, OSRM_TIMEOUT_MS);
      try {
        const coords = waypoints.map(w => `${w.lon},${w.lat}`).join(';');
        const url    = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
        const r      = await fetch(url, { signal: osrmSignal });
        if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`);
        const data = await r.json();
        if (!data.routes?.[0]?.geometry?.coordinates?.length) throw new Error('OSRM: nessuna geometria');
        return {
          points:   data.routes[0].geometry.coordinates.map(c => ({ lon: c[0], lat: c[1] })),
          distance: data.routes[0].distance,
          duration: data.routes[0].duration,
          _src: 'osrm',
        };
      } finally { osrmClear(); }
    }

    // Lancia entrambi in parallelo
    const valhallaPromise = tryValhalla().catch(() => null);
    const osrmPromise     = tryOSRM().catch(() => null);

    // Vince il primo che risolve con successo (non-null).
    // FIX bug di blocco permanente: la versione precedente usava Promise.race
    // con `r || new Promise(() => {})` — se un provider falliva, quel ramo
    // diventava una promise che non si risolve MAI. Se ENTRAMBI fallivano,
    // Promise.race aspettava due promise pendenti per sempre: nessun throw,
    // nessun timeout (i timeout dei singoli fetch erano già scaduti e
    // ininfluenti a quel punto), l'intera conversione restava bloccata su
    // "Ricalcolo percorso..." indefinitamente.
    // Promise.any risolve correttamente lo stesso obiettivo: vince il primo
    // fulfilled, e rigetta con AggregateError solo se TUTTI i rami rigettano
    // — qui rappresentato mappando un risultato null a un reject esplicito.
    let first;
    try {
      first = await Promise.any([
        valhallaPromise.then(r => { if (!r) throw new Error('Valhalla: nessun risultato'); return r; }),
        osrmPromise.then(r => { if (!r) throw new Error('OSRM: nessun risultato'); return r; }),
      ]);
    } catch (_aggregateErr) {
      // Entrambi i provider falliti: nessun percorso disponibile per questo segmento.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return null;
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (first._src === 'osrm' && typeof onValhallaUpgrade === 'function') {
      // OSRM ha vinto: Valhalla gira ancora in background
      addLog('🗺️ OSRM risposto → mappa visualizzata. Valhalla in background...', 'dim');
      valhallaPromise.then(valResult => {
        if (valResult && !signal?.aborted) {
          addLog('⬆️ Valhalla disponibile: aggiornamento percorso moto...', 'dim');
          onValhallaUpgrade(valResult);
        }
      }).catch(() => {});
    }

    return first;
  }

    // ── Chunked routing per N > 10 waypoint ─────────────────────────────────
  /**
   * @param {Array<{lat,lon}>} waypoints
   * @param {AbortSignal}      [signal]
   * @returns {Promise<{points,distance,duration}|null>}
   */
  async function fetchRouteChunked(waypoints, signal, onValhallaUpgrade) {
    if (!waypoints || waypoints.length < 2) return null;
    if (waypoints.length <= 10) return fetchSingleRoute(waypoints, signal, onValhallaUpgrade);

    const CHUNK_SIZE      = 10;
    const DELAY_BASE_MS   = 600;  // <350ms causa 429 su server pubblici
    const RETRY_DELAY_MS  = 1500; // pausa più lunga prima del retry, per assorbire un 429 transitorio

    addLog(`🚀 Chunked routing attivo: ${waypoints.length} waypoint in batch da max ${CHUNK_SIZE}`, 'info');

    // Costruisce batch sovrapposti: ogni batch condivide l'ultimo punto col successivo
    const batches = [];
    for (let i = 0; i < waypoints.length - 1; i += CHUNK_SIZE - 1) {
      const end = Math.min(i + CHUNK_SIZE, waypoints.length);
      batches.push(waypoints.slice(i, end));
      if (end === waypoints.length) break;
    }
    addLog(`📦 Generati ${batches.length} segmenti di routing`, 'info');

    // ── Risoluzione di un segmento con retry + split ricorsivo ────────────
    // 1. Prova fetchSingleRoute (Valhalla/OSRM in parallelo, come sempre).
    // 2. Se fallisce, attende RETRY_DELAY_MS e ritenta UNA sola volta
    //    (assorbe 429 o timeout transitori senza sacrificare subito il tratto).
    // 3. Se anche il retry fallisce e il segmento ha >2 punti, lo divide a
    //    metà (punto di giunzione condiviso, come il chunking esterno) e
    //    riprova ricorsivamente su ciascuna metà.
    // 4. Solo quando si arriva al segmento minimo (2 punti) e fallisce anche
    //    lì, si accetta la linea retta come fallback finale — a quel punto è
    //    plausibile un problema persistente (copertura stradale mancante),
    //    non un blip transitorio.
    async function _resolveSegment(points, isRetry = false) {
      try {
        const seg = await fetchSingleRoute(points, signal); // no upgrade callback per chunk
        if (seg?.points?.length > 0) return { ...seg, fallbackCount: 0 };
      } catch (err) {
        if (err.name === 'AbortError') throw err;
      }

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (!isRetry) {
        addLog(`🔁 Ritento segmento (${points.length} waypoint)...`, 'warn');
        await sleep(RETRY_DELAY_MS);
        return _resolveSegment(points, true);
      }

      if (points.length > 2) {
        const mid   = Math.ceil(points.length / 2);
        const left  = points.slice(0, mid);
        const right = points.slice(mid - 1); // condivide il punto di giunzione
        addLog(`✂️ Divido segmento in sotto-tratti (${left.length}+${right.length} pt)...`, 'warn');
        const [r1, r2] = [await _resolveSegment(left, false), await _resolveSegment(right, false)];
        return {
          points:       [...r1.points, ...r2.points.slice(1)],
          distance:     r1.distance + r2.distance,
          duration:     r1.duration + r2.duration,
          fallbackCount: r1.fallbackCount + r2.fallbackCount,
        };
      }

      // Segmento minimo (2 punti), retry esaurito: fallback lineare definitivo.
      addLog(`⚠️ Tratto irrisolvibile, linea retta tra i 2 punti estremi`, 'warn');
      return {
        points: [
          { lat: points[0].lat, lon: points[0].lon },
          { lat: points[points.length - 1].lat, lon: points[points.length - 1].lon },
        ],
        distance: 0,
        duration: 0,
        fallbackCount: 1,
      };
    }

    let allPoints          = [];
    let totalDistance      = 0;
    let totalDuration      = 0;
    let successCount       = 0;
    let failCount          = 0;
    let totalFallbackCount = 0;

    for (let idx = 0; idx < batches.length; idx++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = batches[idx];
      addLog(`🔄 Segmento ${idx + 1}/${batches.length} (${batch.length} waypoint)...`, 'info');

      try {
        const seg = await _resolveSegment(batch);
        const toAdd = (idx > 0 && allPoints.length > 0) ? seg.points.slice(1) : seg.points;
        allPoints.push(...toAdd);
        totalDistance      += seg.distance;
        totalDuration       += seg.duration;
        totalFallbackCount += seg.fallbackCount;
        if (seg.fallbackCount > 0) {
          failCount++;
          addLog(`⚠️ Segmento ${idx + 1}: ${seg.fallbackCount} tratto/i in linea retta`, 'warn');
        } else {
          successCount++;
          addLog(`✅ Segmento ${idx + 1} risolto (+${(seg.distance / 1000).toFixed(1)} km)`, 'ok');
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        _addFallbackPoints(allPoints, batch, idx);
        failCount++;
        totalFallbackCount++;
        addLog(`❌ Segmento ${idx + 1} errore: ${err.message}`, 'warn');
      }

      if (idx < batches.length - 1) {
        const delayMs = DELAY_BASE_MS + failCount * 200;
        await sleep(Math.min(delayMs, 2000));
      }
    }

    if (allPoints.length === 0) return null;

    addLog(
      `🏁 Routing completato: ${successCount} OK, ${failCount} con fallback | Distanza ${(totalDistance / 1000).toFixed(1)} km`,
      totalFallbackCount === 0 ? 'ok' : 'warn',
    );
    return { points: allPoints, distance: totalDistance, duration: totalDuration, fallbackCount: totalFallbackCount };
  }

  // Aggiunge punti di fallback lineari (nessuna geometria stradale)
  function _addFallbackPoints(allPoints, batch, idx) {
    if (batch.length < 2) return;
    if (allPoints.length === 0 || idx === 0) {
      allPoints.push({ lat: batch[0].lat, lon: batch[0].lon });
    }
    allPoints.push({ lat: batch[batch.length - 1].lat, lon: batch[batch.length - 1].lon });
  }

  // ── API pubblica ──────────────────────────────────────────────────────────
  return {
    fetchSingleRoute,
    fetchRouteChunked,
  };
}

// [CHECKP_TASK_03] hash: v18.0_f3a9c21
// [FASE_0] 0.A: polyfill AbortSignal.any aggiunto
// [FASE_3] fetchRouteChunked: _resolveSegment() con retry (1x, RETRY_DELAY_MS) + split
//          ricorsivo prima del fallback lineare finale. Risultato espone fallbackCount
//          (n. tratti rimasti in linea retta dopo retry+split esauriti) — usato solo
//          da task_08_export.js per la nota GPX/KMZ, mai da buildITNString.
// [FIX_HANG] fetchSingleRoute: Promise.race con rami "pendenti per sempre" sostituito
//          da Promise.any — se Valhalla e OSRM falliscono entrambi, ora restituisce
//          null invece di bloccare la conversione a tempo indeterminato.
