// task_14_panel_controls.js
// Gestione isolata dei pannelli di controllo della UI, degli input e dello stato dei pulsanti

import { $ } from './task_03_utils.js';

/**
 * Aggiorna lo stato di abilitazione dei pulsanti Undo e Redo
 */
export function updateUndoRedoButtons(canUndo, canRedo) {
  const undoBtn = $('btn-undo');
  const redoBtn = $('btn-redo');
  if (undoBtn) undoBtn.disabled = !canUndo;
  if (redoBtn) redoBtn.disabled = !canRedo;
}

/**
 * Gestisce l'apertura e la chiusura del pannello della cronologia (History)
 */
export function toggleHistoryPanel(open) {
  const panel = $('historyPanel');
  if (!panel) return;
  if (open) {
    panel.classList.add('open');
  } else {
    panel.classList.remove('open');
  }
}

/**
 * Mostra o nasconde la "X" di cancellazione rapida all'interno di un campo di testo
 */
export function syncClearButtonVisibility(inputId, clearBtnId) {
  const inputEl = $(inputId);
  const clearBtn = $(clearBtnId);
  if (inputEl && clearBtn) {
    clearBtn.classList.toggle('on', inputEl.value.length > 0);
  }
}

/**
 * Controlla lo stato di apertura/chiusura del pannello informativo laterale
 */
export function toggleInfoPanelState(forceOpen = null) {
  const panel = $('infoPanel');
  const btn = $('infoToggleBtn');
  if (!panel || !btn) return;

  const shouldOpen = forceOpen !== null ? forceOpen : !panel.classList.contains('open');

  if (shouldOpen) {
    panel.classList.add('open');
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    try { localStorage.setItem('infoPanel_open', 'true'); } catch (e) {}
  } else {
    panel.classList.remove('open');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    try { localStorage.setItem('infoPanel_open', 'false'); } catch (e) {}
  }
}

/**
 * Aggiorna le statistiche visive di distanza e durata nella dashboard principale
 */
export function updateDashboardStats(distanceStr, durationStr) {
  const distEl = $('total-distance');
  const durEl = $('total-duration');
  if (distEl) distEl.textContent = distanceStr;
  if (durEl) durEl.textContent = durationStr;
}

/**
 * Attiva o disattiva visivamente lo stato del pulsante di editing manuale sulla mappa
 */
export function setMapEditButtonState(active) {
  const btn = $('map-edit-btn');
  if (btn) {
    btn.classList.toggle('active', active);
    btn.innerHTML = active ? '🛑 Disattiva Inserimento' : '📍 Aggiungi Punti su Mappa';
  }
}