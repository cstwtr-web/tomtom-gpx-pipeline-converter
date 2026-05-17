// task_02 - hash_input: b9c4d1f (Route_converter_v18.0, righe 1210-1590)
// Render lista waypoint interattiva: drag, edit inline, add, delete.
// Nessuna variabile globale: riceve state + callbacks come parametri.
// DOM dependency: elementi con id wpList, wpLabel, statusMessage, addWaypointPanel, newWpAddress

/**
 * @param {object} deps
 * @param {object}   deps.state         - istanza createState()
 * @param {Function} deps.geocode       - async (query:string) => {lat,lon,name}
 * @param {Function} deps.fullStateRefresh - async () => void (ricalcola rotta + output)
 * @param {Function} deps.regenerateOutput - async () => void (solo output, no routing)
 * @param {Function} deps.addLog        - (msg:string, type:string) => void
 * @param {Function} deps.esc           - (s:string) => string (HTML escape)
 * @param {Function} deps.sleep         - (ms:number) => Promise<void>
 * @param {object}   deps.Swal          - SweetAlert2 reference
 * @param {Function} deps.$             - (id:string) => HTMLElement
 */
export function createWaypointUI({ state, geocode, fullStateRefresh, regenerateOutput, addLog, esc, sleep, Swal, $ }) {

  // ── Render lista ────────────────────────────────────────────────────────────
  function refresh() {
    const list = $('wpList');
    if (!list) return;
    const oldScroll = list.scrollTop;
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    const waypoints = state.getWaypoints();
    const wpLimit   = state.getWpLimit();
    const canDelete = waypoints.length > 2;

    waypoints.forEach((w, i) => {
      const isF = i === 0;
      const isL = i === waypoints.length - 1;
      const isIntermediate = !isF && !isL;

      const row = document.createElement('div');
      row.className = 'wp-row anim' + (isIntermediate ? ' intermediate' : '');
      row.draggable = true;
      row.dataset.index = i;

      const deleteBtn = canDelete
        ? `<button class="wp-delete-btn" data-del="${i}" title="Elimina tappa">✕</button>`
        : '';

      row.innerHTML = `
        <div class="wp-line"></div>
        <div class="wp-dot ${isF ? 'dot-s' : isL ? 'dot-e' : 'dot-m'}">${isF ? 'A' : isL ? 'B' : i}</div>
        <div class="wp-info">
          <div class="wp-name" data-idx="${i}">${esc(w.name)}</div>
          <div class="wp-coords">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</div>
        </div>
        ${deleteBtn}`;

      // Delete button
      row.querySelector('[data-del]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteWaypoint(parseInt(e.currentTarget.dataset.del));
      });

      // Drag & Drop
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        const toIdx   = parseInt(row.dataset.index);
        if (fromIdx !== toIdx) {
          const wps = state.getWaypoints();
          const [item] = wps.splice(fromIdx, 1);
          wps.splice(toIdx, 0, item);
          state.setWaypoints(wps);
          state.pushSnapshot(`Modifica waypoint #${wps.length} (riordino)`); // Fase 2
          await fullStateRefresh();
        }
      });

      // Inline edit del nome → geocode
      row.querySelector('.wp-name')?.addEventListener('click', (e) => {
        const nameSpan = e.currentTarget;
        if (nameSpan.classList.contains('editing')) return;

        const input      = Object.assign(document.createElement('input'), { type: 'text', value: w.name, className: 'wp-name-input' });
        const confirmBtn = Object.assign(document.createElement('button'), { textContent: '✓', className: 'wp-name-confirm', title: 'Conferma e ricalcola rotta' });
        const cancelBtn  = Object.assign(document.createElement('button'), { textContent: '✗', className: 'wp-name-cancel',  title: 'Annulla' });

        nameSpan.classList.add('editing');
        nameSpan.innerHTML = '';
        nameSpan.append(input, confirmBtn, cancelBtn);
        input.focus(); input.select();

        const doCancel = () => { nameSpan.classList.remove('editing'); nameSpan.textContent = w.name; };
        const doConfirm = async () => {
          const newName = input.value.trim();
          if (!newName || newName === w.name) { doCancel(); return; }
          confirmBtn.disabled = cancelBtn.disabled = true;
          confirmBtn.textContent = '…';
          try {
            const geo = await geocode(newName);
            const wps = state.getWaypoints();
            wps[i] = { lat: geo.lat, lon: geo.lon, name: geo.name };
            state.setWaypoints(wps);
            const label = isF ? 'Partenza' : isL ? 'Arrivo' : `Tappa ${i}`;
            addLog(`✅ ${label} aggiornata: "${geo.name}"`, 'ok');
            state.pushSnapshot(`Modifica waypoint #${i + 1} (rinomina)`); // Fase 2
            await fullStateRefresh();
          } catch (err) {
            addLog(`⚠️ Geocoding fallito: ${err.message}`, 'warn');
            Swal.fire({ icon: 'warning', title: 'Indirizzo non trovato', text: err.message, confirmButtonColor: '#1e5aa8' });
            doCancel();
          }
        };

        confirmBtn.addEventListener('click', (ev) => { ev.stopPropagation(); doConfirm(); });
        cancelBtn.addEventListener('click',  (ev) => { ev.stopPropagation(); doCancel(); });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter')  { ev.preventDefault(); doConfirm(); }
          if (ev.key === 'Escape') { ev.preventDefault(); doCancel(); }
        });
      });

      frag.appendChild(row);
    });

    list.appendChild(frag);
    list.scrollTop = oldScroll;

    // Badge conteggio
    const cnt   = waypoints.length;
    const badge = cnt > wpLimit
      ? `<span class="wp-count-badge critical">🔴 ${cnt}/${wpLimit}</span>`
      : cnt > 20
        ? `<span class="wp-count-badge warning">⚠️ ${cnt}/${wpLimit}</span>`
        : `<span class="wp-count-badge ok">✓ Ottimale</span>`;
    $('wpLabel').innerHTML = `Tappe (${cnt})${badge}`;
  }

  // ── Avviso stato waypoint ───────────────────────────────────────────────────
  // Disabilitato: l'informazione è già nel badge 🔴 XX/21 nella lista tappe.
  function updateCountWarning() {
    const sm = $('statusMessage');
    if (sm) sm.className = '';   // nasconde senza modificare il DOM
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  async function deleteWaypoint(index) {
    const waypoints = state.getWaypoints();
    if (waypoints.length <= 2) {
      Swal.fire({ icon: 'info', title: 'Minimo 2 tappe', text: 'Il percorso richiede almeno una partenza e un arrivo.', confirmButtonColor: '#1e5aa8' });
      return;
    }
    const waypointName = waypoints[index].name;
    const result = await Swal.fire({
      title: 'Elimina tappa?',
      html: `<strong>${esc(waypointName)}</strong>?`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Sì, elimina',
      confirmButtonColor: '#ef4444',
      cancelButtonColor: '#6b7280',
    });
    if (!result.isConfirmed) return;

    const backupWps    = state.getWaypoints();
    const backupRoute  = state.getRoutePoints();

    try {
      const row = document.querySelector(`.wp-row[data-index="${index}"]`);
      if (row) { row.classList.add('wp-deleting'); await sleep(200); }

      const wps = state.getWaypoints();
      wps.splice(index, 1);
      state.setWaypoints(wps);
      addLog(`Tappa eliminata: "${waypointName}" (ora ${wps.length} tappe)`, 'ok');
      state.pushSnapshot(`Modifica waypoint #${wps.length + 1} (elimina "${waypointName}")`); // Fase 2

      // Pulisci subito tutti i layer dalla mappa (marker + polyline)
      // prima del ricalcolo asincrono per evitare marker orfani
      const map = state.getMap();
      const tileLayerRef = state.getTileLayerRef();
      if (map && tileLayerRef) {
        map.eachLayer(l => { if (l !== tileLayerRef) map.removeLayer(l); });
      }

      await fullStateRefresh();

      const toast = Swal.mixin({ toast: true, position: 'top-end', timer: 5000, showConfirmButton: false,
        html: `<b>Tappa eliminata</b><br>${esc(waypointName)} rimossa.<br><a href="#" id="undoLink" style="color:var(--p);font-weight:600;">↩ Annulla</a>` });
      toast.fire();
      document.getElementById('undoLink')?.addEventListener('click', async (e) => {
        e.preventDefault();
        Swal.close();
        state.setWaypoints(backupWps);
        state.setRoutePoints(backupRoute);
        await regenerateOutput();
        await fullStateRefresh();
      });
    } catch (err) {
      state.setWaypoints(backupWps);
      state.setRoutePoints(backupRoute);
      addLog(`Errore eliminazione: ${err.message}`, 'warn');
      refresh();
      Swal.fire({ icon: 'error', title: 'Errore', text: 'Impossibile rigenerare il percorso. Ripristinato.', confirmButtonColor: '#1e5aa8' });
    }
  }

  // ── Add panel ───────────────────────────────────────────────────────────────
  function toggleAddPanel() { $('addWaypointPanel').classList.toggle('open'); }

  function _checkLimit() {
    const waypoints = state.getWaypoints();
    const wpLimit   = state.getWpLimit();
    if (waypoints.length >= wpLimit) {
      const modeLabel = wpLimit <= 21 ? 'MyDrive Connect' : 'Navigatore (microSD/USB)';
      Swal.fire({ icon: 'error', title: `Limite ${modeLabel} raggiunto`, text: `${modeLabel} accetta massimo ${wpLimit} tappe. Elimina qualche tappa prima di aggiungerne.`, confirmButtonColor: '#1e5aa8' });
      return true;
    }
    return false;
  }

  async function addByAddress() {
    if (_checkLimit()) return;
    const addr = $('newWpAddress').value.trim();
    if (!addr) { Swal.fire({ icon: 'warning', title: 'Inserisci un indirizzo', confirmButtonColor: '#1e5aa8' }); return; }
    addLog(`Geocodifica: "${addr}"`, 'info');
    try {
      const geo = await geocode(addr);
      const wps = state.getWaypoints();
      wps.splice(wps.length - 1, 0, { lat: geo.lat, lon: geo.lon, name: geo.name });
      state.setWaypoints(wps);
      $('newWpAddress').value = '';
      toggleAddPanel();
      state.pushSnapshot(`Modifica waypoint #${wps.length} (aggiunta "${geo.name}")`); // Fase 2
      await fullStateRefresh();
      addLog(`➕ Aggiunta tappa: ${geo.name}`, 'ok');
    } catch (e) {
      Swal.fire({ icon: 'error', title: 'Errore', text: 'Impossibile trovare questa località.', confirmButtonColor: '#1e5aa8' });
    }
  }

  async function addByCoords() {
    if (_checkLimit()) return;
    const input = $('newWpAddress').value.trim();
    const match = input.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
    if (!match) { Swal.fire({ icon: 'warning', title: 'Formato coordinate', text: 'Usa formato: lat,lon (es: 45.464,9.190)', confirmButtonColor: '#1e5aa8' }); return; }
    const lat = parseFloat(match[1]), lon = parseFloat(match[2]);
    if (isNaN(lat) || isNaN(lon)) return;
    const wps = state.getWaypoints();
    wps.splice(wps.length - 1, 0, { lat, lon, name: `${lat.toFixed(5)},${lon.toFixed(5)}` });
    state.setWaypoints(wps);
    $('newWpAddress').value = '';
    toggleAddPanel();
    state.pushSnapshot(`Modifica waypoint #${wps.length} (aggiunta coordinate)`); // Fase 2
    await fullStateRefresh();
    addLog('➕ Aggiunte coordinate', 'ok');
  }

  // ── API pubblica ─────────────────────────────────────────────────────────────
  return {
    refresh,             // ridisegna la lista
    updateCountWarning,  // aggiorna status-message
    deleteWaypoint,
    toggleAddPanel,
    addByAddress,
    addByCoords,
  };
}

// [CHECKP_TASK_02] hash: v18.0_e8f1b42
// [FASE_2] pushSnapshot() in: drop (riordino), doConfirm (rinomina), deleteWaypoint, addByAddress, addByCoords
