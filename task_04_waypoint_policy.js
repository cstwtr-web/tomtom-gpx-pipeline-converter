// task_04_waypoint_policy.js
// Regole di dominio pure per la semantica e la gestione dei Waypoint

// Set privato di nomi generici auto-assegnati dai dispositivi o dal sistema
const _GENERIC_NAMES = new Set([
  'Nuovo punto',    // Garmin italiano
  'New Point',      // Garmin inglese
  'Neuer Punkt',    // Garmin tedesco
  'Nuevo punto',    // Garmin spagnolo
  'Nouveau point',  // Garmin francese
  'Partenza', 
  'Destinazione',
]);

/**
 * Rileva se un waypoint ha un nome semantico (es. scelto dall'utente)
 * @param {string} name 
 * @returns {boolean}
 */
export function isSemanticName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (_GENERIC_NAMES.has(trimmed))          return false;
  if (/^Via \d+$/.test(trimmed))            return false;
  if (/^Waypoint\s*\d+$/i.test(trimmed))    return false;
  if (/^WPT\s*\d+$/i.test(trimmed))         return false;
  if (/^Point\s*\d*$/i.test(trimmed))       return false;
  if (trimmed.includes(','))                 return false; // Esclude i geocoding grezzi di Nominatim
  return true;
}

/**
 * Calcola gli indici dei waypoint "pinned" (da preservare tassativamente nella decimazione)
 * @param {Array} wps - Array di waypoint originali
 * @returns {Set<number>} Set di indici pinned
 */
export function computePinnedSet(wps) {
  const pinned = new Set();
  if (!wps?.length) return pinned;
  
  pinned.add(0); // La Partenza è sempre pinned
  
  for (let i = 1; i < wps.length; i++) {
    const wp = wps[i];
    // Se l'utente ha bloccato il punto o se ha un nome reale/semantico, diventa pinned
    if (wp.pinned || isSemanticName(wp.name)) {
      pinned.add(i);
    }
  }
  
  pinned.add(wps.length - 1); // La Destinazione finale è sempre pinned
  return pinned;
}