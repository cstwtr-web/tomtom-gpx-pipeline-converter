// task_04_dom_helpers.js
// Re-export da task_03_utils.js — fonte canonica unica.
// Questo file esiste solo per compatibilità con eventuali import esterni:
// non duplica più nessuna implementazione.

export { $, esc, sleep, isIOS, formatBytes } from './task_03_utils.js';
