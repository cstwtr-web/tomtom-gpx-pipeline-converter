// task_11_waypoints.js
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

  // ── Drag & drop via Pointer Events (mouse + touch, unico codepath) ───────────
  // FIX: il drag&drop HTML5 nativo (draggable + dragstart/dragover/drop) NON
  // funziona su touch — è un'API pensata solo per mouse, nessun browser mobile
  // la implementa per elementi generici. Era l'unico angolo del progetto senza
  // supporto touch, mentre altrove (task_12/task_13) è stato curato con
  // attenzione dedicata. Pointer Events unifica mouse e touch nello stesso
  // codepath: setPointerCapture funziona identicamente su entrambi, senza if/else
  // per piattaforma. L'handle dedicato (invece di rendere trascinabile l'intera
  // riga) evita conflitti con lo scroll verticale della lista su mobile:
  // touch-action:none è applicato solo all'icona, non alla riga.
  let _dragState = null; // { fromIndex, row, pointerId, toIndex, container, minDy, maxDy, lastClientX, lastClientY, scrollRAF }

  // FIX (boundary + auto-scroll): il drag era sbloccato in verticale, quindi
  // trascinando verso l'alto la riga poteva "scappare" sopra la mappa o fuori
  // dal viewport, restando poi bloccata in posizioni non coerenti col layout.
  // Ora il traslamento della riga è clampato dentro i confini di #wpList (il
  // contenitore scrollabile reale, non #wpList-wrap che è solo il collassabile
  // mobile), e quando il puntatore si avvicina/supera il bordo superiore o
  // inferiore la lista scorre da sola (auto-scroll), a velocità proporzionale
  // alla vicinanza al bordo — nessuna libreria esterna, stesso codepath
  // mouse/touch già in uso.
  const DRAG_EDGE_ZONE       = 48; // px dal bordo entro cui parte l'auto-scroll
  const DRAG_SCROLL_MAX_SPEED = 14; // px per frame alla velocità massima

  function _clampDy(dy) {
    if (!_dragState) return dy;
    return Math.min(_dragState.maxDy, Math.max(_dragState.minDy, dy));
  }

  // FIX (auto-scroll verso il basso non funzionava): il translateY applicato
  // alla riga era calcolato SOLO dal movimento del puntatore (e.clientY -
  // startY), ignorando lo scroll del contenitore avvenuto nel frattempo.
  // Ma la riga è un figlio del contenitore che scrolla: quando scrollTop
  // aumenta (auto-scroll giù), il contenuto — riga compresa — si sposta verso
  // l'ALTO nel viewport, mentre il transform restava fermo. La riga andava
  // quindi a sbattere contro maxDy (calcolato sulla geometria iniziale, ormai
  // superata) e sembrava "bloccarsi". Scrollando su capitava l'opposto: il
  // contenuto scende, nella stessa direzione della clamp, e quindi per puro
  // caso il movimento sembrava corretto. Soluzione: sommare al delta del
  // puntatore anche il delta di scroll accumulato dall'inizio del drag, così
  // il transform compensa esattamente lo spostamento del contenuto.
  function _applyRowTransform() {
    if (!_dragState) return;
    const scrollDelta = _dragState.container.scrollTop - _dragState.startScrollTop;
    const rawDy = (_dragState.lastClientY - _dragState.startY) + scrollDelta;
    _dragState.row.style.transform = `translateY(${_clampDy(rawDy)}px)`;
  }

  function _updateDragOverTarget(clientX, clientY) {
    if (!_dragState) return;
    // elementFromPoint ignorando temporaneamente la riga trascinata stessa,
    // altrimenti risulterebbe sempre "sotto" il proprio puntatore.
    _dragState.row.style.pointerEvents = 'none';
    const elUnder = document.elementFromPoint(clientX, clientY);
    _dragState.row.style.pointerEvents = '';

    document.querySelectorAll('.wp-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    const targetRow = elUnder?.closest('.wp-row');
    if (targetRow && targetRow !== _dragState.row) {
      targetRow.classList.add('drag-over');
      _dragState.toIndex = parseInt(targetRow.dataset.index);
    } else {
      _dragState.toIndex = undefined;
    }
  }

  // Loop continuo (indipendente dai soli eventi pointermove): finché il drag
  // è attivo, controlla ad ogni frame quanto il puntatore è vicino al bordo
  // superiore/inferiore di #wpList e fa scorrere scrollTop di conseguenza.
  // Funziona anche se il puntatore resta fermo dentro la fascia di bordo, e
  // anche se esce completamente dal contenitore (es. finisce sopra la mappa).
  function _autoScrollTick() {
    if (!_dragState) return;
    const { container, lastClientY, lastClientX } = _dragState;
    const rect = container.getBoundingClientRect();

    const distFromTop    = lastClientY - rect.top;
    const distFromBottom = rect.bottom - lastClientY;

    let speed = 0;
    if (distFromTop < DRAG_EDGE_ZONE) {
      const t = Math.max(0, Math.min(DRAG_EDGE_ZONE, distFromTop)) / DRAG_EDGE_ZONE;
      speed = -DRAG_SCROLL_MAX_SPEED * (1 - t);
    } else if (distFromBottom < DRAG_EDGE_ZONE) {
      const t = Math.max(0, Math.min(DRAG_EDGE_ZONE, distFromBottom)) / DRAG_EDGE_ZONE;
      speed = DRAG_SCROLL_MAX_SPEED * (1 - t);
    }

    if (speed !== 0) {
      const prevScroll = container.scrollTop;
      container.scrollTop += speed;
      // Se lo scroll è cambiato davvero, la riga si è spostata nel viewport
      // anche senza un nuovo pointermove: ricompensa il transform (fix dello
      // scroll verso il basso) e ricalcola la riga "sotto" al puntatore.
      if (container.scrollTop !== prevScroll) {
        _applyRowTransform();
        _updateDragOverTarget(lastClientX, lastClientY);
      }
    }

    _dragState.scrollRAF = requestAnimationFrame(_autoScrollTick);
  }

  function _onDragMove(e) {
    if (!_dragState) return;
    e.preventDefault();
    _dragState.lastClientX = e.clientX;
    _dragState.lastClientY = e.clientY;

    _applyRowTransform();
    _updateDragOverTarget(e.clientX, e.clientY);
  }

  async function _onDragEnd(e) {
    document.removeEventListener('pointermove', _onDragMove);
    document.removeEventListener('pointerup', _onDragEnd);
    document.removeEventListener('pointercancel', _onDragEnd);
    if (!_dragState) return;

    if (_dragState.scrollRAF) cancelAnimationFrame(_dragState.scrollRAF);

    const { fromIndex, toIndex, row } = _dragState;
    row.classList.remove('dragging');
    row.style.transform = '';
    row.style.zIndex = '';
    document.querySelectorAll('.wp-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    _dragState = null;

    if (toIndex !== undefined && toIndex !== fromIndex) {
      const wps = state.getWaypoints();
      const [item] = wps.splice(fromIndex, 1);
      wps.splice(toIndex, 0, item);
      state.setWaypoints(wps);
      state.pushSnapshot(`Modifica waypoint #${wps.length} (riordino)`, { manual: true }); // Fase 2
      await fullStateRefresh();
    } else {
      // Nessuno spostamento valido: la riga era già ridisegnata da refresh()
      // solo in caso di riordino reale, altrimenti va ripristinata al volo.
    }
  }

  function _startDrag(e, index, row) {
    // Solo pulsante primario per mouse; su touch e penna e.pointerType gestisce già il resto.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();

    // Contenitore reale scrollabile: #wpList (.wp-list), non #wpList-wrap
    // (quello è solo il collassabile dell'accordion mobile, senza scroll
    // proprio). Fallback al parentElement se per qualche motivo manca.
    const container    = row.closest('.wp-list') || row.parentElement;
    const containerRect = container.getBoundingClientRect();
    const rowRect        = row.getBoundingClientRect();

    _dragState = {
      fromIndex: index,
      row,
      startY: e.clientY,
      pointerId: e.pointerId,
      toIndex: undefined,
      container,
      // Range di traslazione verticale che mantiene la riga interamente
      // dentro il riquadro del contenitore (indipendente dallo scroll interno,
      // perché containerRect non cambia scrollando il contenuto).
      minDy: containerRect.top - rowRect.top,
      maxDy: containerRect.bottom - rowRect.bottom,
      startScrollTop: container.scrollTop,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      scrollRAF: null,
    };
    row.classList.add('dragging');
    row.style.zIndex = '10';
    document.addEventListener('pointermove', _onDragMove);
    document.addEventListener('pointerup', _onDragEnd);
    document.addEventListener('pointercancel', _onDragEnd);

    _dragState.scrollRAF = requestAnimationFrame(_autoScrollTick);
  }

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
      row.dataset.index = i;

      const deleteBtn = canDelete
        ? `<button class="wp-delete-btn" data-del="${i}" title="Elimina tappa">✕</button>`
        : '';

      row.innerHTML = `
        <div class="wp-line"></div>
        <div class="wp-top">
          <div class="wp-dot ${isF ? 'dot-s' : isL ? 'dot-e' : 'dot-m'}">${isF ? 'A' : isL ? 'B' : i}</div>
          <div class="wp-name" data-idx="${i}">${esc(w.name)}</div>
        </div>
        <div class="wp-bottom">
          <div class="wp-coords">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</div>
          <div class="wp-controls">
            <div class="wp-drag-handle" title="Trascina per riordinare" aria-label="Trascina per riordinare">⠿</div>
            ${deleteBtn}
          </div>
        </div>`;

      // Delete button
      row.querySelector('[data-del]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteWaypoint(parseInt(e.currentTarget.dataset.del));
      });

      // Drag & Drop — handle dedicato, Pointer Events (mouse + touch)
      row.querySelector('.wp-drag-handle')?.addEventListener('pointerdown', (e) => _startDrag(e, i, row));

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
            state.pushSnapshot(`Modifica waypoint #${i + 1} (rinomina)`, { manual: true }); // Fase 2
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
    const badge = !Number.isFinite(wpLimit)
      ? `<span class="wp-count-badge ok">∞ Nessun limite</span>`
      : cnt > wpLimit
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
      state.pushSnapshot(`Modifica waypoint #${wps.length + 1} (elimina "${waypointName}")`, { manual: true }); // Fase 2

      // NON rimuovere i layer manualmente: renderWaypoints() chiama clearMarkers()
      // internamente, e rimuovere _markerGroup qui lo stacca dalla mappa
      // rendendo invisibili tutti i marker successivi (bug long-press / delete).
      await fullStateRefresh();

      const toast = Swal.mixin({ toast: true, position: 'top-end', timer: 5000, showConfirmButton: false,
        html: `<b>Tappa eliminata</b><br>${esc(waypointName)} rimossa.<br><a href="#" id="undoLink" style="color:var(--p);font-weight:600;">↩ Annulla</a>` });
      toast.fire();
      document.getElementById('undoLink')?.addEventListener('click', async (e) => {
        e.preventDefault();
        Swal.close();
        // Fix: passa per lo stack reale (state.undo) invece di un set diretto,
        // così la cancellazione resta coerente con Annulla/Ripeti generali e
        // con la rilevazione di editing manuale basata sullo stack.
        if (state.canUndo()) {
          state.undo();
        } else {
          state.setWaypoints(backupWps);
          state.setRoutePoints(backupRoute);
        }
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

  // FIX: da blocco/conferma a solo informativo. L'utente ha già dichiarato
  // la propria intenzione al consent gate d'import (_consentGate in
  // task_14_route_loader.js: riduci / mantieni tutte / modifico manualmente)
  // oppure sta aggiungendo tappe una a una consapevolmente — in entrambi i
  // casi non serve un secondo cancello con conferma, basta informare, esattamente
  // come già fa il badge 🔴/⚠️/✓ in wpLabel e l'auto-switch a formato ITN
  // a fine go() in task_14. Non ritorna più un boolean da controllare a monte:
  // logga se supera il limite e lascia sempre procedere l'inserimento.
  function _warnIfOverLimit() {
    const waypoints = state.getWaypoints();
    const wpLimit   = state.getWpLimit();
    if (Number.isFinite(wpLimit) && waypoints.length >= wpLimit) {
      const modeLabel = wpLimit <= 21 ? 'MyDrive Connect' : 'Navigatore (microSD/USB)';
      addLog(`⚠️ Oltre il limite ${modeLabel} (max ${wpLimit}): tappa aggiunta comunque, esporta via ITN/microSD`, 'warn');
    }
  }

  async function addByAddress() {
    _warnIfOverLimit();
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
      state.pushSnapshot(`Modifica waypoint #${wps.length} (aggiunta "${geo.name}")`, { manual: true }); // Fase 2
      await fullStateRefresh();
      addLog(`➕ Aggiunta tappa: ${geo.name}`, 'ok');
    } catch (e) {
      Swal.fire({ icon: 'error', title: 'Errore', text: 'Impossibile trovare questa località.', confirmButtonColor: '#1e5aa8' });
    }
  }

  async function addByCoords() {
    _warnIfOverLimit();
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
    state.pushSnapshot(`Modifica waypoint #${wps.length} (aggiunta coordinate)`, { manual: true }); // Fase 2
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
// [FASE_2b] tutti e 5 i pushSnapshot sopra ora taggati { manual: true }
//           toast "↩ Annulla" in deleteWaypoint ora passa da state.undo() (era set diretto)
// [FASE_4] FIX drag&drop touch: rimosso HTML5 native DnD (draggable/dragstart/dragover/drop,
//          mai supportato su touch), sostituito con handle dedicato (.wp-drag-handle) +
//          Pointer Events (_startDrag/_onDragMove/_onDragEnd), stesso codepath mouse/touch.
//          pushSnapshot invariato: stessa label "(riordino)", stesso { manual: true }.
