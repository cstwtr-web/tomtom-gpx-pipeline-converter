// task_17_elevation.js
// Arricchimento quota (elevazione) per routePoints via Open-Elevation.
// Funzioni pure + un solo punto di aggancio a state (initElevationEnrichment).
// Nessun DOM, nessuna variabile globale al di fuori del modulo stesso.
//
// Nota numerazione: il prompt originale proponeva "task_16_elevation.js", ma
// task_01_main.js (boot → initDecisionPanel) ha già un commento
// `verifyRouteEquivalence: null, // task_16 — futuro step D4` che riserva
// mentalmente quel numero. Usato "17" come numero libero equivalente in
// attesa di conferma di chi gestisce il progetto — se "16" risulta comunque
// libero, è sufficiente rinominare il file e l'import in boot().

const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';
const FETCH_TIMEOUT_MS   = 12000;
const RETRY_DELAY_MS     = 1200;

// Combina l'AbortSignal esterno con un timeout locale (stesso pattern di
// makeSignal in task_10_engine.js, non duplicato 1:1 solo perché quel
// helper vive dentro la closure di createRoutingEngine e non è esportato).
function _combineSignal(externalSignal, ms) {
  const tc  = new AbortController();
  const tid = setTimeout(() => tc.abort(), ms);
  const combined = AbortSignal.any
    ? AbortSignal.any([externalSignal, tc.signal].filter(Boolean))
    : tc.signal;
  return { combined, clear: () => clearTimeout(tid) };
}

/**
 * Singola chiamata a Open-Elevation. Nessun split ricorsivo: per il volume
 * di punti in gioco qui il motore di routing ha già retry+split sofisticati
 * altrove (fetchRouteChunked) — replicarli per l'elevazione sarebbe
 * sovra-ingegnerizzato, come da decisione architetturale validata.
 *
 * @param {Array<{lat,lon}>} points
 * @param {AbortSignal}      signal - onorato QUI, dentro la vera fetch di rete
 * @returns {Promise<number[]>} quote nello stesso ordine di `points`
 */
async function _fetchElevations(points, signal) {
  const { combined, clear } = _combineSignal(signal, FETCH_TIMEOUT_MS);
  try {
    const body = JSON.stringify({
      locations: points.map(p => ({ latitude: p.lat, longitude: p.lon })),
    });
    const r = await fetch(OPEN_ELEVATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: combined,
    });
    if (!r.ok) throw new Error(`Open-Elevation HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data?.results) || data.results.length !== points.length) {
      throw new Error('Open-Elevation: risposta incompleta o malformata');
    }
    return data.results.map(res => res.elevation);
  } finally {
    clear();
  }
}

/**
 * Arricchisce un array di punti con la quota (metri) da Open-Elevation.
 * Fallimento silenzioso e non bloccante: in caso di errore o abort esterno
 * restituisce i punti originali invariati (mai un throw verso il chiamante,
 * tranne AbortError che va lasciato propagare per rispettare l'abort).
 *
 * @param {Array<{lat,lon}>} points
 * @param {AbortSignal}      [signal]
 * @param {{addLog?:Function}} [deps]
 * @returns {Promise<Array<{lat,lon,ele}>>}
 */
export async function enrichElevation(points, signal, { addLog } = {}) {
  if (!points || points.length === 0) return points;

  try {
    let elevations;
    try {
      elevations = await _fetchElevations(points, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      addLog?.(`⚠️ Elevazione: primo tentativo fallito (${err.message}), riprovo...`, 'warn');
      await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      elevations = await _fetchElevations(points, signal);
    }
    return points.map((p, i) => ({ ...p, ele: elevations[i] }));
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Fallimento non bloccante: nessuna quota, ma l'app continua a funzionare.
    // Il pannello grafico/statistiche (task_18) degrada in modo pulito perché
    // computeElevationStats() ritorna null quando manca p.ele su un punto.
    addLog?.(`⚠️ Elevazione non disponibile (${err.message}) — grafico altimetrico disattivato`, 'warn');
    return points;
  }
}

/**
 * Unico punto di aggancio richiesto dalla decisione architetturale:
 * un solo state.subscribe('routePoints', ...) copre tutti i punti di uscita
 * del routing (fast-path Garmin, fast-path trkpt, _applyRoute OSRM/Valhalla,
 * e il rollback di deleteWaypoint in task_11_waypoints.js che richiama
 * setRoutePoints(backupRoute) direttamente) — nessun hook duplicato nei
 * singoli call-site.
 *
 * Guard anti-loop: pts[0]?.ele !== undefined evita di:
 *  - sovrascrivere quote GPX native già presenti (extractRawTrkpts in
 *    task_09_parsers.js le preserva quando presenti nel file sorgente);
 *  - ri-arricchire un evento 'routePoints' già arricchito da questa stessa
 *    funzione (state.setRoutePoints(enriched) qui sotto ri-emette l'evento).
 * Rischio noto e accettato (edge case raro, non bloccante): un guard basato
 * solo su presenza, non su hash geometria, non ri-arricchisce se in futuro
 * arriva una route diversa che per coincidenza ha lo stesso primo punto già
 * quotato. Non implementato l'hash, come da decisione architetturale.
 *
 * @param {{state:object, addLog?:Function}} deps
 */
export function initElevationEnrichment({ state, addLog }) {
  let _controller = null;

  state.subscribe(async (event, pts) => {
    if (event !== 'routePoints') return;
    if (!pts || pts.length === 0) return;
    if (pts[0]?.ele !== undefined) return; // guard anti-loop / quote GPX native

    if (_controller) _controller.abort(); // una richiesta di elevazione più vecchia in volo va abbandonata
    const controller = new AbortController();
    _controller = controller;

    try {
      const enriched = await enrichElevation(pts, controller.signal, { addLog });
      if (_controller !== controller) return;               // superato da un evento 'routePoints' più recente
      if (state.getRoutePoints() !== pts) return;            // routePoints è già cambiato altrove nel frattempo
      state.setRoutePoints(enriched); // ri-emette 'routePoints' con ele[0] definito → il guard blocca il loop
    } catch (err) {
      if (err.name !== 'AbortError') addLog?.(`⚠️ Arricchimento quota interrotto: ${err.message}`, 'warn');
    } finally {
      if (_controller === controller) _controller = null;
    }
  });
}

// [NOTA] Open-Elevation con routePoints molto lunghe (3000-4000+ punti su
// tracce OSRM complesse, vedi commento smoothFactor in task_12_map_component.js)
// viene inviato in un'unica richiesta, come da decisione architetturale
// esplicita (niente split ricorsivo). Rischio noto: payload/tempo di risposta
// più alti su tracce molto lunghe — mitigato dal fallimento silenzioso sopra,
// non da chunking. Se in pratica emergono timeout frequenti su tracce lunghe,
// segnalarlo esplicitamente prima di aggiungere chunking (sarebbe una
// modifica architetturale, non va decisa silenziosamente qui).
