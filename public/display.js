'use strict';

// TV / scoreboard display: follows a room without taking a seat. Shows the scoreboard, the current prompt and
// progress, and each round's answers (with who played them) only after the judge has picked a winner.
(() => {
  const { readJSON, writeJSON, esc, plural, initial, fillPrompt, icons } = window.HotTake;
  const SAVED_KEY = 'hottake.display';

  const socket = io();
  const app = document.getElementById('app');
  const overlay = document.getElementById('overlay');
  const connBanner = document.getElementById('conn');
  const toastEl = document.getElementById('toast');

  const fromLink = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
  let code = fromLink || readJSON(SAVED_KEY) || null; // the room being followed (or about to be)
  let view = null; // latest display view from the server
  let message = null; // shown on the connect screen
  let sheetOpen = false;
  let busy = false;
  let invite = null; // { code, url, reachable }

  const keepAwake = window.HotTake.keepAwake(() => Boolean(view));

  // ---- helpers -------------------------------------------------------------

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  function send(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload, (err, reply) => {
        resolve(err ? { error: 'The server did not respond. Check your connection.' } : reply);
      });
    });
  }

  function forget(note) {
    view = null;
    code = null;
    message = note;
    writeJSON(SAVED_KEY, null);
    history.replaceState(null, '', '/display');
    render();
  }

  async function watch(roomCode) {
    busy = true;
    render();
    const res = await send('watch', { code: roomCode });
    busy = false;
    if (res.error) {
      forget(res.error === 'No game with that code.' ? `No game with the code ${roomCode}. Check the code on a player's phone.` : res.error);
      return;
    }
    code = res.code;
    message = null;
    writeJSON(SAVED_KEY, code);
    history.replaceState(null, '', `/display?room=${code}`);
  }

  function loadInvite() {
    if (invite?.code === view.code) return;
    const room = view.code;
    invite = { code: room, url: `${location.origin}/?room=${room}`, reachable: true };
    fetch(`/api/invite?room=${room}`)
      .then((r) => r.json())
      .then((info) => {
        if (invite?.code !== room || !info.url) return;
        invite = { code: room, url: info.url, reachable: info.reachable };
        render();
      })
      .catch(() => { /* keep the fallback */ });
  }

  const nameOf = (id) => view.players.find((p) => p.id === id)?.name ?? '?';

  // ---- socket events -------------------------------------------------------

  socket.on('connect', () => {
    connBanner.hidden = true;
    if (code) watch(code);
  });
  socket.on('disconnect', () => {
    if (view) connBanner.hidden = false;
  });
  socket.on('display', (next) => {
    view = next;
    keepAwake();
    render();
  });
  socket.on('room-ended', () => forget('That game has ended. Enter a room code to follow another game.'));

  // ---- pieces ----------------------------------------------------------------

  function header() {
    const room = view ? `<span class="room-chip static" title="Room code">${esc(view.code)}</span>` : '';
    return `
      <header class="appbar">
        <div class="bar-left"><button class="icon-btn" data-act="menu" aria-label="Display menu">${icons.menu}</button></div>
        <span class="logo">Hot<span>Take</span></span>
        <div class="bar-right">${room}</div>
      </header>`;
  }

  function promptCard(prompt, cards = [], cls = '') {
    const pick = prompt.pick > 1 ? `<span class="pick">Pick ${prompt.pick}</span>` : '';
    return `<div class="prompt-card ${cls}"><p>${fillPrompt(prompt.text, cards)}</p>${pick}</div>`;
  }

  function scoreboard() {
    // Highest score first; ties keep turn order so rows don't jump around.
    const ranked = view.players.map((p, i) => ({ ...p, i })).sort((a, b) => b.score - a.score || a.i - b.i);
    const top = ranked[0]?.score ?? 0;
    const inRound = view.phase === 'submitting';
    const rows = ranked.map((p) => {
      const tags = [];
      if (view.phase !== 'lobby' && view.phase !== 'gameOver' && p.id === view.judgeId) tags.push('<span class="tag yellow">Judge</span>');
      else if (inRound) tags.push(p.submitted ? '<span class="tag green">Played</span>' : '<span class="tag">Thinking</span>');
      const pct = Math.min(100, Math.round((p.score / view.pointsToWin) * 100));
      return `
        <li class="${p.connected ? '' : 'off'}${p.score === top && top > 0 ? ' leader' : ''}">
          <span class="avatar${p.score === top && top > 0 ? ' gold' : ''}">${initial(p.name)}</span>
          <span class="who">
            <span class="top"><span class="name">${esc(p.name)}</span>${tags.join('')}</span>
            <span class="bar"><i style="width:${pct}%"></i></span>
          </span>
          <span class="score">${p.score}</span>
        </li>`;
    }).join('');
    return `
      <section class="d-panel d-score">
        <div class="d-head"><h2>Scores</h2><span class="muted">First to ${view.pointsToWin}</span></div>
        <ol class="d-players">${rows}</ol>
      </section>`;
  }

  /** A finished round: the winning sentence big, then everyone else's answer with their name. */
  function roundResult(result, { compact = false } = {}) {
    const others = result.submissions.filter((s) => s.playerId !== result.winnerId);
    return `
      <div class="d-result${compact ? ' compact' : ''}">
        <div class="answer-card winner"><span class="crown">★ ${esc(result.winnerName)}</span>
          ${fillPrompt(result.prompt.text, result.cards)}
          <span class="who">Picked by ${esc(result.judgeName)}</span></div>
        ${others.length ? `
          <div class="d-answers">
            ${others.map((s) => `
              <div class="d-answer"><span class="txt">${s.cards.map((c) => esc(c.text)).join(' <em>/</em> ')}</span>
                <span class="by">${esc(s.playerName)}</span></div>`).join('')}
          </div>` : ''}
      </div>`;
  }

  function progress() {
    const waitingOn = view.players.filter((p) => p.connected && p.id !== view.judgeId);
    const dots = waitingOn.map((p) => `<i class="${p.submitted ? 'on' : ''}" title="${esc(p.name)}"></i>`).join('');
    if (view.phase === 'judging') {
      return `<div class="d-status"><span class="dots"><i></i><i></i><i></i></span>
        <span><strong>${esc(nameOf(view.judgeId))}</strong> is choosing a winner…</span></div>`;
    }
    return `<div class="d-status"><span class="d-dots">${dots}</span>
      <span><strong>${view.submittedCount} of ${view.needed}</strong> answers in · ${esc(nameOf(view.judgeId))} is judging</span></div>`;
  }

  function historyList(skipLatest) {
    const rounds = view.history.slice(0, skipLatest ? -1 : undefined).reverse();
    const items = rounds.map((r) => `
      <li><span class="eyebrow">Round ${r.round} · <b>★ ${esc(r.winnerName)}</b></span>
        <p>${fillPrompt(r.prompt.text, r.cards)}</p></li>`).join('');
    return `
      <section class="d-panel d-history">
        <div class="d-head"><h2>Round winners</h2><span class="muted">${plural(view.history.length, 'round')}</span></div>
        ${items ? `<ol class="d-rounds">${items}</ol>` : '<p class="muted">Winners from earlier rounds show up here.</p>'}
      </section>`;
  }

  // ---- screens -----------------------------------------------------------------

  function renderConnect() {
    const waiting = code && !message;
    return `
      <main class="d-connect">
        <div class="panel form">
          <div class="d-connect-head">${icons.tv}<h1>TV display</h1></div>
          <p class="muted">Shows the scoreboard and each round's answers on a TV, laptop or tablet. It doesn't take a seat
            in the game.</p>
          ${message ? `<div class="notice">${esc(message)}</div>` : ''}
          <label for="code" class="eyebrow">Room code</label>
          <input id="code" class="code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false"
                 value="${esc(code || '')}" placeholder="ABCD">
          <button class="btn yellow" data-act="watch"${busy || waiting ? ' disabled' : ''}>${waiting ? `Connecting to ${esc(code)}…` : 'Show this game'}</button>
          <p class="muted small">Find the code at the top of any player's screen. <a class="text-link inline" href="/">Want to play instead?</a></p>
        </div>
      </main>`;
  }

  function renderLobby() {
    loadInvite();
    const connected = view.players.filter((p) => p.connected).length;
    const short = view.minPlayers - connected;
    const chips = view.players.map((p) => `
      <li class="${p.connected ? '' : 'off'}"><span class="avatar">${initial(p.name)}</span>${esc(p.name)}
        ${p.id === view.hostId ? '<span class="tag">Host</span>' : ''}</li>`).join('');
    const warning = invite.reachable ? '' : `
      <div class="warn">Phones can't reach <strong>localhost</strong>. Open this display using the computer's network
        address, or set <code>PUBLIC_URL</code> on the server.</div>`;
    return `
      <main class="d-lobby">
        <section class="d-panel d-join">
          <h1>Scan to join</h1>
          <img class="qr" src="/qr.svg?room=${esc(view.code)}&v=${encodeURIComponent(invite.url)}" alt="QR code to join room ${esc(view.code)}">
          <p class="eyebrow">or go to</p>
          <p class="d-url">${esc(invite.url.replace(/^https?:\/\//, '').replace(/\/\?room=.*$/, ''))}</p>
          <p class="eyebrow">and enter code</p>
          <div class="bigcode">${esc(view.code)}</div>
          ${warning}
        </section>
        <section class="d-panel d-waiting">
          <div class="d-head"><h2>Players</h2><span class="muted">${view.players.length}/${view.maxPlayers}</span></div>
          ${chips ? `<ul class="d-chips">${chips}</ul>` : ''}
          <div class="d-status"><span class="dots"><i></i><i></i><i></i></span>
            <span>${short > 0 ? `Waiting for ${plural(short, 'more player')}…` : 'Waiting for the host to start…'}</span></div>
          ${view.notice ? `<div class="notice">${esc(view.notice)}</div>` : ''}
          <div class="d-decks"><span class="eyebrow">Decks</span>
            <div class="deck-chips">${view.deckNames.map((n) => `<span class="pill">${esc(n)}</span>`).join('')}</div></div>
        </section>
      </main>`;
  }

  function renderRound() {
    const revealed = view.phase === 'reveal';
    const latest = view.history.at(-1);
    const current = revealed
      ? `<div class="d-head"><span class="eyebrow">Round ${view.round}</span><h2>${esc(latest.winnerName)} takes it!</h2></div>
         ${roundResult(latest)}`
      : `<div class="d-head"><span class="eyebrow">Round ${view.round}</span>
           <h2>${view.phase === 'judging' ? 'Judging' : 'Playing'}</h2></div>
         ${promptCard(view.prompt, [], 'd-prompt')}
         ${progress()}
         ${latest ? `<div class="d-last"><span class="eyebrow">Last round · Round ${latest.round}</span>${roundResult(latest, { compact: true })}</div>` : ''}`;
    return `
      <main class="d-game">
        ${scoreboard()}
        <section class="d-panel d-current">${view.notice ? `<div class="notice">${esc(view.notice)}</div>` : ''}${current}</section>
        ${historyList(Boolean(latest))}
      </main>`;
  }

  function renderGameOver() {
    const latest = view.history.at(-1);
    return `
      <main class="d-game over">
        ${scoreboard()}
        <section class="d-panel d-current">
          <div class="d-hero"><div class="trophy" aria-hidden="true">🏆</div>
            <span class="eyebrow">Game over</span><h1>${esc(nameOf(view.winnerId))} wins!</h1></div>
          ${latest ? `<div class="d-last"><span class="eyebrow">Winning round · Round ${latest.round}</span>${roundResult(latest, { compact: true })}</div>` : ''}
        </section>
        ${historyList(false)}
      </main>`;
  }

  function renderMenu() {
    if (!sheetOpen) return '';
    const canFullscreen = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    const isFull = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    return `
      <div class="sheet-backdrop" data-act="close"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Display menu"><div class="sheet-inner">
        <div class="panel-head"><h2>${view ? `Room ${esc(view.code)}` : 'Display'}</h2>
          <button class="icon-btn" data-act="close" aria-label="Close">${icons.close}</button></div>
        ${window.HotTake.layoutPicker()}
        ${canFullscreen ? `<button class="btn dark" data-act="fullscreen">${icons.expand} ${isFull ? 'Exit full screen' : 'Full screen'}</button>` : ''}
        ${view ? '<button class="btn dark" data-act="switch">Show a different game</button>' : ''}
        <a class="btn dark" href="/">Play on this device instead</a>
      </div></div>`;
  }

  function render() {
    overlay.innerHTML = renderMenu();
    document.body.classList.toggle('sheet-open', sheetOpen);
    // Re-rendering replaces the connect form, so carry over whatever's being typed.
    const typing = app.querySelector('#code');
    const kept = typing ? { value: typing.value, focused: document.activeElement === typing } : null;
    let body;
    if (!view) body = renderConnect();
    else if (view.phase === 'lobby') body = renderLobby();
    else if (view.phase === 'gameOver') body = renderGameOver();
    else body = renderRound();
    app.innerHTML = `<div class="shell">${header()}${body}</div>`;
    const input = !view && kept && app.querySelector('#code');
    if (input) {
      input.value = kept.value;
      if (kept.focused) input.focus();
    }
  }

  // ---- input -------------------------------------------------------------------

  function submitCode() {
    const value = app.querySelector('#code').value.trim().toUpperCase();
    if (value.length !== 4) return toast('Enter the 4-letter room code.');
    code = value;
    message = null;
    watch(value);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen).call(document.documentElement);
    } catch { toast('Full screen isn’t available here.'); }
    sheetOpen = false;
    render();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    switch (el.dataset.act) {
      case 'watch':
        submitCode();
        break;
      case 'menu':
        sheetOpen = true;
        render();
        break;
      case 'close':
        sheetOpen = false;
        render();
        break;
      case 'layout':
        window.HotTake.setLayoutPref(el.dataset.value);
        render();
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'switch':
        sheetOpen = false;
        send('unwatch');
        forget(null);
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen) {
      sheetOpen = false;
      render();
    } else if (e.key === 'Enter' && e.target.id === 'code') {
      submitCode();
    }
  });

  window.HotTake.onLayoutChange(() => render());
  document.addEventListener('fullscreenchange', () => render());
  render();
})();
