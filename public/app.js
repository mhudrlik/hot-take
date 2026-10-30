'use strict';

(() => {
  const SESSION_KEY = 'hottake.session';
  const NAME_KEY = 'hottake.name';

  const socket = io();
  const app = document.getElementById('app');
  const connBanner = document.getElementById('conn');
  const toastEl = document.getElementById('toast');
  const overlay = document.getElementById('overlay');

  let state = null; // latest server view, or null when not in a game
  let session = readJSON(SESSION_KEY); // { code, token }
  let replaced = false;
  // sheet: null | 'menu' | 'rules' | 'invite'
  const ui = { roundKey: null, cards: [], entry: null, sheet: null, busy: false, invite: null };

  // ---- storage (can throw in private mode, so always guarded) -----------

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function writeJSON(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable: reconnect just won't survive a reload */ }
  }
  function setSession(value) {
    session = value;
    writeJSON(SESSION_KEY, value);
  }

  // ---- helpers -----------------------------------------------------------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  function buzz(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  function send(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload, (err, reply) => {
        resolve(err ? { error: 'The server did not respond. Check your connection.' } : reply);
      });
    });
  }

  async function act(type, extra = {}) {
    if (ui.busy) return;
    ui.busy = true;
    render();
    const res = await send('action', { type, ...extra });
    ui.busy = false;
    if (res.error) toast(res.error);
    render();
    return res;
  }

  /** Puts answers into the prompt's blanks (or appends them if it has none); empty blanks stay as lines. */
  function fillPrompt(text, cards) {
    const parts = String(text).split(/_{3,}/);
    const fills = cards.map((c) => `<span class="fill">${esc(c.text.replace(/[.!?]+$/, ''))}</span>`);
    if (parts.length - 1 < cards.length) {
      return `${esc(text)} ${fills.join(' / ')}`;
    }
    return parts.map((p, i) => esc(p) + (i < parts.length - 1 ? (fills[i] ?? '<span class="blank"></span>') : '')).join('');
  }

  const me = () => state.you;
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '?';
  const isHost = () => state.hostId === state.you.id;
  const isJudge = () => state.judgeId === state.you.id;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const busyAttr = () => (ui.busy ? ' disabled' : '');
  const initial = (name) => esc([...String(name).trim()][0]?.toUpperCase() || '?');

  // ---- icons (simple inline SVG, stroke = currentColor) ------------------

  const svg = (body, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const icons = {
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
    users: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.2.2 3.6 1.6 4 4"/>'),
    link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    // Hot Take's card mark: a small flame.
    flame: `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.6 2.4c.5 3-1.2 4.6-2.6 6.1-1.5 1.6-3 3.3-3 6 0 3.6 2.6 6.5 5.6 6.5 3.4 0 6.4-2.6 6.4-6.6 0-2.6-1.3-4.4-2.4-5.6.1 1.6-.5 2.9-1.6 3.4.3-3.7-.7-7.6-2.4-9.8zm-.4 11.2c.7 1.3 2.6 2 2.6 4 0 1.5-1.2 2.7-2.7 2.7s-2.6-1.1-2.6-2.6c0-1.8 1.7-2.3 2.7-4.1z"/></svg>`,
  };

  // ---- invite (QR + link) -----------------------------------------------

  /** Fetches the join URL other phones should use (the server knows the LAN / public address). */
  function loadInvite() {
    const code = state.code;
    if (ui.invite?.code === code) return;
    ui.invite = { code, url: `${location.origin}/?room=${code}`, reachable: true };
    fetch(`/api/invite?room=${code}`)
      .then((r) => r.json())
      .then((info) => {
        if (ui.invite?.code !== code || !info.url) return;
        ui.invite = { code, url: info.url, reachable: info.reachable };
        render();
      })
      .catch(() => { /* keep the location.origin fallback */ });
  }

  function inviteBlock(big = false) {
    loadInvite();
    const { url, reachable } = ui.invite;
    const warning = reachable ? '' : `
      <div class="warn">Other phones can't reach <strong>localhost</strong>. Open this page using this computer's
        network address (e.g. <strong>http://192.168.x.x:${esc(location.port || '80')}</strong>), or set
        <code>PUBLIC_URL</code> on the server.</div>`;
    return `
      <div class="invite">
        <img class="qr${big ? ' big' : ''}" src="/qr.svg?room=${esc(state.code)}&v=${encodeURIComponent(url)}"
             alt="QR code to join room ${esc(state.code)}" width="240" height="240">
        <p class="eyebrow">Scan to join · or enter code</p>
        <div class="bigcode">${esc(state.code)}</div>
        <p class="url">${esc(url)}</p>
        ${warning}
        <button class="btn dark" data-act="share">${icons.link} Share invite link</button>
      </div>`;
  }

  // ---- wake lock: keep phones from sleeping mid-game ---------------------

  let wakeLock = null;
  async function keepAwake() {
    if (!state || wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed (e.g. low battery); harmless */ }
  }
  document.addEventListener('visibilitychange', keepAwake);

  // ---- socket events -----------------------------------------------------

  socket.on('connect', async () => {
    connBanner.hidden = true;
    if (!session || replaced) return;
    const res = await send('join', { code: session.code, token: session.token });
    if (res.error) {
      setSession(null);
      state = null;
      toast(res.error === 'No game with that code.' ? 'That game has ended.' : res.error);
      render();
    }
  });

  socket.on('disconnect', () => {
    if (state && !replaced) connBanner.hidden = false;
  });

  socket.on('state', (next) => {
    const prev = state;
    state = next;
    const roundKey = `${next.round}:${next.phase}`;
    if (roundKey !== ui.roundKey) {
      ui.roundKey = roundKey;
      ui.cards = [];
      ui.entry = null;
      // Nudge the judge when it's their move.
      if (next.phase === 'judging' && next.judgeId === next.you?.id) buzz([80, 60, 80]);
      else if (next.phase === 'submitting' && prev?.phase !== 'submitting') buzz(60);
    }
    keepAwake();
    renderSoon();
  });

  socket.on('kicked', () => {
    setSession(null);
    state = null;
    toast('The host removed you from the game.');
    render();
  });

  socket.on('replaced', () => {
    replaced = true;
    state = null;
    render();
  });

  // ---- shell pieces ------------------------------------------------------

  // Menu on the left, logo centered, room code and rules on the right.
  function appbar() {
    const menu = state ? `<button class="icon-btn" data-act="menu" aria-label="Menu: players and scores">${icons.menu}</button>` : '';
    const room = state
      ? `<button class="room-chip" data-act="invite" aria-label="Room ${esc(state.code)}: invite players" title="Invite players">
           <span>${esc(state.code)}</span></button>`
      : '';
    return `
      <header class="appbar">
        <div class="bar-left">${menu}</div>
        <span class="logo">Hot<span>Take</span></span>
        <div class="bar-right">
          ${room}
          <button class="icon-btn yellow" data-act="rules" aria-label="How to play" title="How to play">${icons.info}</button>
        </div>
      </header>`;
  }

  function stageHead(eyebrow, title) {
    return `<div class="stage-head"><span class="eyebrow">${eyebrow}</span><h1>${title}</h1></div>`;
  }

  function roundEyebrow() {
    return `Round ${state.round}`;
  }

  function judgeBar() {
    const needed = state.players.filter((p) => p.id !== state.judgeId && p.connected).length;
    const judge = nameOf(state.judgeId);
    return `
      <div class="pills">
        <div class="judge-chip"><span class="avatar">${initial(judge)}</span><span class="eyebrow">Judge</span>
          <b>${isJudge() ? 'You' : esc(judge)}</b></div>
        <div class="pill">${state.submittedCount} of ${needed} submitted</div>
      </div>`;
  }

  function promptCard(prompt, cards = [], small = false) {
    const pick = prompt.pick > 1 ? `<span class="pick">Pick ${prompt.pick}</span>` : '';
    return `<div class="prompt-card${small ? ' small' : ''}"><p>${fillPrompt(prompt.text, cards)}</p>${pick}</div>`;
  }

  function notice() {
    return state.notice ? `<div class="notice">${esc(state.notice)}</div>` : '';
  }

  function playerList({ showScore = true, showSubmitted = false, allowKick = false } = {}) {
    const rows = state.players.map((p) => {
      const tags = [];
      if (p.id === state.hostId) tags.push('<span class="tag">Host</span>');
      if (state.phase !== 'lobby' && p.id === state.judgeId) tags.push('<span class="tag yellow">Judge</span>');
      if (showSubmitted && p.id !== state.judgeId) {
        tags.push(p.submitted ? '<span class="tag green">Played</span>' : '<span class="tag">Thinking</span>');
      }
      const kick = allowKick && p.id !== state.you.id
        ? `<button class="mini-btn" data-act="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">${icons.close}</button>` : '';
      return `
        <li class="${p.connected ? '' : 'off'}">
          <span class="avatar">${initial(p.name)}</span>
          <span class="name">${esc(p.name)}${p.id === state.you.id ? ' <span class="muted">(you)</span>' : ''}</span>
          ${tags.join('')}
          ${showScore ? `<span class="score">${p.score}</span>` : ''}
          ${kick}
        </li>`;
    });
    return `<ul class="players">${rows.join('')}</ul>`;
  }

  /** A dock with one big button or a status line. */
  function dockBar(inner) {
    return `<div class="dock"><div class="dock-bar">${inner}</div></div>`;
  }

  function dockWait(text) {
    return dockBar(`<div class="dock-wait"><span class="dots"><i></i><i></i><i></i></span>${text}</div>`);
  }

  // ---- screens -----------------------------------------------------------

  function renderHome() {
    const params = new URLSearchParams(location.search);
    const code = (params.get('room') || '').toUpperCase().slice(0, 4);
    const name = readJSON(NAME_KEY) || '';
    return {
      body: `
        <div class="hero">
          <div class="hero-cards" aria-hidden="true">
            <span class="hc purple">____?</span><span class="hc white">${icons.flame}</span>
          </div>
          <h1 class="hero-title">Hot<span>Take</span></h1>
          <p class="muted">One judge. One prompt. Everyone plays their worst best answer.</p>
        </div>
        <div class="panel form">
          <label for="name" class="eyebrow">Your name</label>
          <input id="name" type="text" maxlength="16" autocomplete="nickname" autocapitalize="words" value="${esc(name)}" placeholder="e.g. Sam">
          <label for="code" class="eyebrow">Room code</label>
          <input id="code" class="code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(code)}" placeholder="ABCD">
          <button class="btn yellow" data-act="join"${busyAttr()}>Join game</button>
          <div class="divider">or</div>
          <button class="btn dark" data-act="create"${busyAttr()}>Start a new game</button>
        </div>`,
    };
  }

  function renderReplaced() {
    return {
      body: `
        <div class="panel center stack">
          <h2>This game was opened somewhere else</h2>
          <p class="muted">You can only play from one tab or phone at a time.</p>
          <button class="btn yellow" data-act="reclaim">Play here instead</button>
        </div>`,
    };
  }

  function stepper(key, label) {
    const value = state.settings[key];
    const { min, max } = state.limits[key];
    if (!isHost()) {
      return `<div class="setting"><span>${label}</span><output>${value}</output></div>`;
    }
    return `
      <div class="setting">
        <span>${label}</span>
        <span class="ctl">
          <button class="mini-btn" data-act="setting" data-key="${key}" data-delta="-1" aria-label="Decrease"${value <= min || ui.busy ? ' disabled' : ''}>−</button>
          <output>${value}</output>
          <button class="mini-btn" data-act="setting" data-key="${key}" data-delta="1" aria-label="Increase"${value >= max || ui.busy ? ' disabled' : ''}>+</button>
        </span>
      </div>`;
  }

  const num = (n) => n.toLocaleString('en-US');

  function deckPicker() {
    const selected = new Set(state.settings.deckIds);
    const chosen = state.decks.filter((d) => selected.has(d.id));
    const { prompts, answers } = state.deckTotals;
    const summary = `
      <p class="muted small">${plural(chosen.length, 'deck')} · ${num(prompts)} prompts · ${num(answers)} answers
        ${chosen.length > 1 ? '<br>Cards that appear in more than one deck are only counted once.' : ''}</p>`;

    if (!isHost()) {
      return `
        <div class="deck-row">
          <span class="eyebrow">Decks</span>
          <div class="deck-chips">${chosen.map((d) => `<span class="pill">${esc(d.name)}</span>`).join('')}</div>
          ${summary}
        </div>`;
    }

    const options = state.decks.map((d) => {
      const on = selected.has(d.id);
      return `
        <button class="deck-opt${on ? ' on' : ''}" role="checkbox" aria-checked="${on}" data-act="deck" data-id="${esc(d.id)}"${busyAttr()}>
          <span class="box" aria-hidden="true">${on ? '✓' : ''}</span>
          <span class="deck-info">
            <span class="deck-name">${esc(d.name)}</span>
            <span class="deck-desc">${d.description ? `${esc(d.description)} · ` : ''}${num(d.answers)} answers</span>
          </span>
        </button>`;
    }).join('');
    return `
      <div class="deck-row">
        <span class="eyebrow">Decks · pick one or more</span>
        ${summary}
        <div class="deck-list" role="group" aria-label="Decks">${options}</div>
      </div>`;
  }

  function renderLobby() {
    const connected = state.players.filter((p) => p.connected).length;
    const short = state.minPlayers - connected;
    const dock = isHost()
      ? dockBar(`<button class="btn yellow wide" data-act="start"${short > 0 || ui.busy ? ' disabled' : ''}>
           ${short > 0 ? `Need ${plural(short, 'more player')}` : `Start game · ${connected} players`}</button>`)
      : dockWait('Waiting for the host to start');
    return {
      body: `
        ${stageHead('Lobby', 'Get everyone in')}
        ${notice()}
        <section class="panel center">${inviteBlock()}</section>
        <section class="panel">
          <div class="panel-head"><h2>Players</h2><span class="pill">${state.players.length}/${state.maxPlayers}</span></div>
          ${playerList({ showScore: false, allowKick: isHost() })}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Settings</h2>${isHost() ? '' : '<span class="muted small">Host decides</span>'}</div>
          ${deckPicker()}
          ${stepper('pointsToWin', 'Points to win')}
          ${stepper('handSize', 'Cards in hand')}
        </section>`,
      dock,
    };
  }

  function handCards({ locked = false } = {}) {
    const pick = state.prompt.pick;
    return me().hand.map((c) => {
      const order = ui.cards.indexOf(c.id);
      const badge = order >= 0 && pick > 1 ? `<span class="order">${order + 1}</span>` : '';
      return `
        <button class="pcard${order >= 0 ? ' selected' : ''}" data-act="card" data-id="${esc(c.id)}"${locked ? ' disabled tabindex="-1"' : ''}>
          <span class="txt${c.text.length > 70 ? ' long' : ''}">${esc(c.text)}</span>${icons.flame}${badge}
        </button>`;
    }).join('');
  }

  function handTools() {
    if (!me().mulliganUsed) {
      return `<button class="chip-btn yellow" data-act="mulligan"${busyAttr()}><span class="badge">Free</span>Redraw</button>`;
    }
    if (me().score > 0) {
      return `<button class="chip-btn" data-act="trade"${busyAttr()}><span class="badge dark">1 pt</span>Trade</button>`;
    }
    return '<button class="chip-btn" disabled><span class="badge dark">Used</span>Redraw</button>';
  }

  function renderSubmitting() {
    const pick = state.prompt.pick;
    const chosen = ui.cards.map((id) => me().hand.find((c) => c.id === id)).filter(Boolean);

    if (isJudge()) {
      return {
        body: `
          ${stageHead(roundEyebrow(), "You're the judge")}
          ${notice()}
          ${judgeBar()}
          ${promptCard(state.prompt)}
          <p class="hint">Read the prompt out loud. Answers show up here once everyone has played.</p>
          <section class="panel">${playerList({ showScore: false, showSubmitted: true })}</section>`,
        dock: `<div class="dock"><div class="dock-tools"><span class="dock-note">Your hand sits out this round</span></div>
                 <div class="hand locked" data-keep-scroll="hand">${handCards({ locked: true })}</div></div>`,
      };
    }

    if (state.yourSubmission) {
      return {
        body: `
          ${stageHead(roundEyebrow(), 'Answer locked in')}
          ${judgeBar()}
          ${promptCard(state.prompt, state.yourSubmission)}
          <section class="panel">${playerList({ showScore: false, showSubmitted: true })}</section>`,
        dock: `<div class="dock"><div class="dock-tools"><span class="dock-note">Waiting for the others…</span></div>
                 <div class="hand locked" data-keep-scroll="hand">${handCards({ locked: true })}</div></div>`,
      };
    }

    const ready = chosen.length === pick;
    return {
      body: `
        ${stageHead(roundEyebrow(), pick === 1 ? 'Pick your answer' : `Pick ${pick} answers`)}
        ${notice()}
        ${judgeBar()}
        ${promptCard(state.prompt, chosen)}
        ${pick > 1 ? `<p class="hint">Tap cards in the order they should fill the blanks.</p>` : ''}`,
      dock: `
        <div class="dock">
          <div class="dock-tools">
            ${handTools()}
            <span class="spacer"></span>
            <button class="btn yellow play" data-act="submit"${ready && !ui.busy ? '' : ' disabled'}>
              ${ready ? 'Play it' : `Pick ${pick - chosen.length}`}</button>
          </div>
          <div class="hand" data-keep-scroll="hand">${handCards()}</div>
        </div>`,
    };
  }

  function renderJudging() {
    const judging = isJudge();
    const entries = state.submissions.map((s) => {
      const html = fillPrompt(state.prompt.text, s.cards);
      return judging
        ? `<button class="answer-card${ui.entry === s.id ? ' selected' : ''}" data-act="entry" data-id="${esc(s.id)}">${html}</button>`
        : `<div class="answer-card">${html}</div>`;
    }).join('');

    return {
      body: `
        ${stageHead(roundEyebrow(), judging ? 'Pick the winner' : `${esc(nameOf(state.judgeId))} is judging`)}
        ${promptCard(state.prompt, [], true)}
        <p class="hint">${judging ? 'Read each answer out loud, then tap your favorite.' : 'Answers are anonymous until the judge picks.'}</p>
        <div class="entries">${entries}</div>`,
      dock: judging
        ? dockBar(`<button class="btn yellow wide" data-act="pick"${ui.entry && !ui.busy ? '' : ' disabled'}>${ui.entry ? 'Crown this answer' : 'Tap an answer'}</button>`)
        : dockWait(`${esc(nameOf(state.judgeId))} is choosing`),
    };
  }

  function scoreboard() {
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    const lead = sorted[0]?.score ?? 0;
    return `
      <section class="panel">
        <div class="panel-head"><h2>Scores</h2><span class="muted small">First to ${state.settings.pointsToWin}</span></div>
        <ul class="players">${sorted.map((p) => `
          <li><span class="avatar${p.score === lead && lead > 0 ? ' gold' : ''}">${initial(p.name)}</span>
            <span class="name">${esc(p.name)}${p.id === state.you.id ? ' <span class="muted">(you)</span>' : ''}</span>
            <span class="score">${p.score}</span></li>`).join('')}</ul>
      </section>`;
  }

  function renderResult() {
    const r = state.lastResult;
    const over = state.phase === 'gameOver';
    const youWon = r.winnerId === state.you.id;
    const others = r.submissions.filter((s) => s.playerId !== r.winnerId).map((s) => `
      <div class="answer-card">${fillPrompt(r.prompt.text, s.cards)}<span class="who">${esc(s.playerName)}</span></div>`).join('');

    const head = over
      ? `${stageHead('Game over', `${esc(nameOf(state.winnerId))} wins!`)}
         <div class="trophy" aria-hidden="true">🏆</div>
         <p class="hint center">${youWon ? 'That’s you. Gloat responsibly.' : 'Final scores below.'}</p>`
      : stageHead(roundEyebrow(), youWon ? 'You won the round!' : `${esc(r.winnerName)} takes it`);

    let dock;
    if (over) {
      dock = isHost()
        ? dockBar(`<button class="btn yellow wide" data-act="start"${busyAttr()}>Play again</button>`)
        : dockWait('Waiting for the host to start a new game');
    } else if (isJudge() || isHost()) {
      dock = dockBar(`<button class="btn yellow wide" data-act="next"${busyAttr()}>Next round</button>`);
    } else {
      dock = dockWait(`Waiting for ${esc(nameOf(state.judgeId))} to continue`);
    }

    return {
      body: `
        ${head}
        <div class="answer-card winner"><span class="crown">★ ${esc(r.winnerName)}</span>${fillPrompt(r.prompt.text, r.cards)}
          <span class="who">Picked by ${esc(nameOf(state.judgeId))}</span></div>
        ${others ? `<p class="eyebrow section">Also played</p><div class="entries">${others}</div>` : ''}
        ${scoreboard()}`,
      dock,
    };
  }

  function sheet(title, body) {
    return `
      <div class="sheet-backdrop" data-act="close"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-inner">
        <div class="panel-head"><h2>${esc(title)}</h2><button class="icon-btn" data-act="close" aria-label="Close">${icons.close}</button></div>
        ${body}
      </div></div>`;
  }

  function renderOverlay() {
    if (ui.sheet === 'rules') {
      const settings = state?.settings || {};
      const href = state ? `/rules?points=${settings.pointsToWin}&hand=${settings.handSize}` : '/rules';
      return sheet('How to play', `
        <div class="rules">${window.HotTakeRules.html(settings)}</div>
        <a class="btn dark" href="${href}" target="_blank" rel="noopener">Open rules in a new tab ↗</a>`);
    }
    if (!state) return '';
    if (ui.sheet === 'invite') return sheet('Invite players', inviteBlock(true));
    if (ui.sheet !== 'menu') return '';

    const inRound = state.phase === 'submitting' || state.phase === 'judging';
    const hostTools = isHost() && inRound
      ? `<button class="btn dark" data-act="skip">Skip this round</button>
         <p class="muted small">Use this if the judge's phone died. Played cards go back to their owners.</p>`
      : '';
    return sheet(`Room ${state.code}`, `
      <div>
        <div class="panel-head"><span class="eyebrow">Players · ${state.players.length}</span>
          <span class="muted small">First to ${state.settings.pointsToWin} wins</span></div>
        ${playerList({ allowKick: isHost() })}
      </div>
      <button class="btn dark" data-act="invite">${icons.link} Invite players (QR code)</button>
      <button class="btn dark" data-act="rules">${icons.info} How to play</button>
      ${hostTools}
      <button class="btn danger" data-act="leave">Leave game</button>`);
  }

  // ---- render ------------------------------------------------------------

  // Other players' moves re-render the screen. Doing that mid-tap replaces the button under the
  // finger and the tap is lost, so hold updates while a pointer is down and apply them after the click.
  let pointerDown = false;
  let pendingRender = false;
  function renderSoon() {
    if (pointerDown) pendingRender = true;
    else render();
  }
  document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  const release = () => setTimeout(() => {
    pointerDown = false;
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  }, 60);
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);

  function render() {
    overlay.innerHTML = replaced ? '' : renderOverlay();
    document.body.classList.toggle('sheet-open', Boolean(overlay.innerHTML));

    if (!state && !replaced && app.querySelector('#name')) {
      // Don't clobber what the player is typing on the home screen.
      app.querySelectorAll('.stage [data-act]').forEach((b) => { b.disabled = ui.busy; });
      return;
    }

    let view;
    if (replaced) view = renderReplaced();
    else if (!state) view = renderHome();
    else {
      view = {
        lobby: renderLobby,
        submitting: renderSubmitting,
        judging: renderJudging,
        reveal: renderResult,
        gameOver: renderResult,
      }[state.phase]();
    }

    // Re-rendering replaces the DOM, so carry scroll positions (stage, swipeable hand) across.
    const scroll = {};
    app.querySelectorAll('[data-keep-scroll]').forEach((el) => {
      scroll[el.dataset.keepScroll] = [el.scrollLeft, el.scrollTop];
    });
    const screenKey = state ? `${state.round}:${state.phase}` : 'home';
    const sameScreen = app.dataset.screen === screenKey;

    app.innerHTML = `
      <div class="shell">
        ${appbar()}
        <main class="stage" data-keep-scroll="stage"><div class="stage-inner">${view.body}</div></main>
        ${view.dock || ''}
      </div>`;
    app.dataset.screen = screenKey;

    if (sameScreen) {
      app.querySelectorAll('[data-keep-scroll]').forEach((el) => {
        const saved = scroll[el.dataset.keepScroll];
        if (saved) [el.scrollLeft, el.scrollTop] = saved;
      });
    }
  }

  // ---- input -------------------------------------------------------------

  async function enter(event) {
    const name = app.querySelector('#name').value.trim();
    const code = app.querySelector('#code').value.trim().toUpperCase();
    if (!name) return toast('Enter your name first.');
    if (event === 'join' && code.length !== 4) return toast('Enter the 4-letter room code.');
    writeJSON(NAME_KEY, name);
    ui.busy = true;
    render();
    const res = await send(event, { name, code });
    ui.busy = false;
    if (res.error) {
      toast(res.error);
      render();
      return;
    }
    setSession({ code: res.code, token: res.token });
    history.replaceState(null, '', `/?room=${res.code}`);
  }

  async function share() {
    const url = ui.invite?.code === state.code ? ui.invite.url : `${location.origin}/?room=${state.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Hot Take', text: `Join my game: ${state.code}`, url }); } catch { /* cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.');
    } catch {
      toast(url);
    }
  }

  async function leave() {
    if (!confirm('Leave this game? You will lose your seat and score.')) return;
    await send('leave');
    setSession(null);
    state = null;
    ui.sheet = null;
    history.replaceState(null, '', '/');
    app.innerHTML = '';
    render();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const { act: action, id } = el.dataset;

    switch (action) {
      case 'join':
      case 'create':
        enter(action);
        break;
      case 'reclaim':
        replaced = false;
        if (socket.connected) socket.disconnect();
        socket.connect();
        break;
      case 'menu':
      case 'rules':
      case 'invite':
        ui.sheet = action;
        render();
        break;
      case 'close':
        ui.sheet = null;
        render();
        break;
      case 'share':
        share();
        break;
      case 'leave':
        leave();
        break;
      case 'setting': {
        const key = el.dataset.key;
        act('settings', { settings: { [key]: state.settings[key] + Number(el.dataset.delta) } });
        break;
      }
      case 'kick':
        if (confirm(`Remove ${nameOf(id)} from the game?`)) act('kick', { playerId: id });
        break;
      case 'start':
        act('start');
        break;
      case 'deck': {
        const ids = new Set(state.settings.deckIds);
        if (ids.has(id) && ids.size === 1) {
          toast('Keep at least one deck selected.');
          break;
        }
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        act('settings', { settings: { deckIds: [...ids] } });
        break;
      }
      case 'card': {
        const pick = state.prompt.pick;
        const at = ui.cards.indexOf(id);
        if (at >= 0) ui.cards.splice(at, 1);
        else if (pick === 1) ui.cards = [id];
        else if (ui.cards.length < pick) ui.cards.push(id);
        else toast(`You've already picked ${pick}. Tap one to unselect it.`);
        render();
        break;
      }
      case 'submit':
        act('submit', { cardIds: ui.cards });
        break;
      case 'mulligan':
        if (confirm('Use your one free redraw? Your whole hand is swapped for new cards.')) {
          ui.cards = [];
          act('mulligan');
        }
        break;
      case 'trade':
        if (confirm('Spend 1 point to replace your whole hand?')) {
          ui.cards = [];
          act('trade');
        }
        break;
      case 'entry':
        ui.entry = id;
        render();
        break;
      case 'pick':
        act('pick', { submissionId: ui.entry });
        break;
      case 'next':
        act('next');
        break;
      case 'skip':
        if (confirm('Skip this round? Nobody scores.')) {
          ui.sheet = null;
          act('skip');
        }
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.sheet) {
      ui.sheet = null;
      render();
    }
  });

  app.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || state) return;
    if (e.target.id === 'code' || e.target.id === 'name') {
      enter(app.querySelector('#code').value.trim() ? 'join' : 'create');
    }
  });

  render();
})();
