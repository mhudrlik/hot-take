'use strict';

const { randomUUID } = require('crypto');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const MAX_NAME_LENGTH = 16;
const SETTING_LIMITS = {
  handSize: { min: 5, max: 12, default: 7 },
  pointsToWin: { min: 3, max: 20, default: 7 },
};

class GameError extends Error {}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// A draw pile that reshuffles its discards when it runs dry.
class Pile {
  constructor(cards) {
    this.drawPile = shuffle([...cards]);
    this.discards = [];
  }

  draw() {
    if (this.drawPile.length === 0) {
      this.drawPile = shuffle(this.discards);
      this.discards = [];
    }
    return this.drawPile.pop(); // undefined if every card is in someone's hand
  }

  discard(...cards) {
    this.discards.push(...cards);
  }
}

const normalizeText = (text) => String(text).trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Validates a raw deck ({ name, description, prompts, answers }) and gives every card a stable id.
 * Duplicate prompts and answers (ignoring case and spacing) are dropped so no two players can
 * ever hold or play the same answer.
 */
function normalizeDeck(raw, id) {
  if (!raw || !Array.isArray(raw.prompts) || !Array.isArray(raw.answers)) {
    throw new Error(`Deck "${id}" must contain "prompts" and "answers" arrays`);
  }
  const seenPrompts = new Set();
  const prompts = [];
  for (const p of raw.prompts) {
    if (typeof p?.text !== 'string' || ![undefined, 1, 2, 3].includes(p.pick)) {
      throw new Error(`Bad prompt card in deck "${id}": ${JSON.stringify(p)}`);
    }
    const key = normalizeText(p.text);
    if (!key || seenPrompts.has(key)) continue;
    seenPrompts.add(key);
    prompts.push({ text: p.text.trim(), pick: p.pick || 1 });
  }
  const seenAnswers = new Set();
  const answers = [];
  for (const text of raw.answers) {
    if (typeof text !== 'string') throw new Error(`Bad answer card in deck "${id}": ${JSON.stringify(text)}`);
    const key = normalizeText(text);
    if (!key || seenAnswers.has(key)) continue;
    seenAnswers.add(key);
    answers.push({ id: `${id}:${answers.length}`, text: text.trim() });
  }
  if (prompts.length === 0 || answers.length === 0) throw new Error(`Deck "${id}" has an empty pile`);
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    prompts,
    answers,
    duplicatesRemoved: raw.prompts.length - prompts.length + raw.answers.length - answers.length,
  };
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new GameError('Enter a name.');
  return name;
}

/**
 * One game room. Phases:
 *   lobby -> submitting -> judging -> reveal -> submitting ... -> gameOver
 * Every mutating method throws GameError on an illegal move; callers broadcast state afterwards.
 */
class Room {
  /** `decks` is an array of normalizeDeck() results; the first one is selected by default. */
  constructor(code, decks) {
    if (!decks.length) throw new Error('A room needs at least one deck');
    this.code = code;
    this.decks = decks;
    this.players = []; // turn order
    this.hostId = null;
    this.phase = 'lobby';
    this.settings = {
      ...Object.fromEntries(Object.entries(SETTING_LIMITS).map(([k, v]) => [k, v.default])),
      deckIds: [decks[0].id],
    };
    this.round = 0;
    this.judgeId = null;
    this.prompt = null;
    this.submissions = [];
    this.lastResult = null;
    this.winnerId = null;
    this.notice = null;
    this.touch();
  }

  touch() {
    this.updatedAt = Date.now();
  }

  // ---- lookups -----------------------------------------------------------

  /**
   * The selected decks merged into one pile. A card that appears in more than one deck (the
   * "Everything" deck overlaps the others, for example) is only included once.
   */
  get deck() {
    const key = this.settings.deckIds.join('|');
    if (this.combined?.key !== key) {
      const chosen = this.decks.filter((d) => this.settings.deckIds.includes(d.id));
      const seenPrompts = new Set();
      const seenAnswers = new Set();
      const once = (seen, text) => !seen.has(normalizeText(text)) && seen.add(normalizeText(text));
      this.combined = {
        key,
        name: chosen.length === 1 ? `The ${chosen[0].name} deck has` : `The ${chosen.length} selected decks have`,
        prompts: chosen.flatMap((d) => d.prompts).filter((p) => once(seenPrompts, p.text)),
        answers: chosen.flatMap((d) => d.answers).filter((a) => once(seenAnswers, a.text)),
      };
    }
    return this.combined;
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  playerByToken(token) {
    return token ? this.players.find((p) => p.token === token) : undefined;
  }

  requirePlayer(id) {
    const p = this.player(id);
    if (!p) throw new GameError('You are not in this game.');
    return p;
  }

  requireHost(id) {
    if (id !== this.hostId) throw new GameError('Only the host can do that.');
  }

  get connectedCount() {
    return this.players.filter((p) => p.connected).length;
  }

  // ---- membership --------------------------------------------------------

  /** Adds a new player, or reconnects an existing one if `token` matches. Returns the player. */
  join(rawName, token) {
    const existing = this.playerByToken(token);
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = null;
      this.touch();
      return existing;
    }

    const name = cleanName(rawName);
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`This game is full (${MAX_PLAYERS} players).`);
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('That name is taken in this game.');
    }

    const player = {
      id: randomUUID(),
      token: randomUUID(),
      name,
      score: 0,
      hand: [],
      connected: true,
      disconnectedAt: null,
      mulliganUsed: false,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;

    // Late joiners are dealt in and can play from the current round.
    if (this.phase !== 'lobby' && this.phase !== 'gameOver') this.fillHand(player);
    this.touch();
    return player;
  }

  setConnected(id, connected) {
    const p = this.player(id);
    if (!p) return;
    p.connected = connected;
    p.disconnectedAt = connected ? null : Date.now();
    // A dropped phone shouldn't hold up the round.
    if (!connected) this.maybeStartJudging();
    this.touch();
  }

  leave(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const [player] = this.players.splice(idx, 1);
    if (this.answers) this.answers.discard(...player.hand);

    if (this.hostId === id) {
      const next = this.players.find((p) => p.connected) || this.players[0];
      this.hostId = next ? next.id : null;
    }

    if (this.phase === 'submitting' || this.phase === 'judging') {
      const sub = this.submissions.find((s) => s.playerId === id);
      if (sub) {
        this.submissions = this.submissions.filter((s) => s !== sub);
        this.answers.discard(...sub.cards);
      }
    }

    if (this.phase !== 'lobby' && this.phase !== 'gameOver' && this.players.length < MIN_PLAYERS) {
      this.abortToLobby(`Not enough players to continue (need ${MIN_PLAYERS}).`);
    } else if (this.judgeId === id && (this.phase === 'submitting' || this.phase === 'judging')) {
      this.voidRound(`${player.name} (the judge) left. Starting a new round.`);
    } else if (this.phase === 'submitting') {
      this.maybeStartJudging();
    } else if (this.phase === 'judging' && this.submissions.length === 0) {
      this.voidRound('No answers left to judge. Starting a new round.');
    }
    this.touch();
  }

  kick(byId, targetId) {
    this.requireHost(byId);
    if (byId === targetId) throw new GameError('You cannot kick yourself.');
    this.requirePlayer(targetId);
    this.leave(targetId);
  }

  // ---- settings & lifecycle ---------------------------------------------

  updateSettings(byId, changes) {
    this.requireHost(byId);
    if (this.phase !== 'lobby' && this.phase !== 'gameOver') {
      throw new GameError('Settings can only be changed between games.');
    }
    for (const [key, limits] of Object.entries(SETTING_LIMITS)) {
      if (changes[key] === undefined) continue;
      const value = Number.parseInt(changes[key], 10);
      if (!Number.isFinite(value)) continue;
      this.settings[key] = Math.min(limits.max, Math.max(limits.min, value));
    }
    if (changes.deckIds !== undefined) {
      const ids = Array.isArray(changes.deckIds) ? changes.deckIds : [];
      if (ids.length === 0) throw new GameError('Pick at least one deck.');
      if (ids.some((id) => !this.decks.some((d) => d.id === id))) throw new GameError('That deck does not exist.');
      // Keep the lobby's deck order regardless of the order they were ticked in.
      this.settings.deckIds = this.decks.map((d) => d.id).filter((id) => ids.includes(id));
    }
    this.touch();
  }

  start(byId) {
    this.requireHost(byId);
    if (this.phase !== 'lobby' && this.phase !== 'gameOver') throw new GameError('The game is already running.');
    if (this.connectedCount < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players to start.`);

    // Worst case every hand is full and a pick-2 round is in flight.
    const needed = this.players.length * (this.settings.handSize + 2);
    if (this.deck.answers.length < needed) {
      throw new GameError(
        `${this.deck.name} ${this.deck.answers.length} answer cards; `
        + `${this.players.length} players with ${this.settings.handSize}-card hands need ${needed}.`,
      );
    }

    this.prompts = new Pile(this.deck.prompts);
    this.answers = new Pile(this.deck.answers);
    for (const p of this.players) {
      p.score = 0;
      p.hand = [];
      p.mulliganUsed = false;
    }
    this.round = 0;
    this.judgeId = null;
    this.prompt = null;
    this.lastResult = null;
    this.winnerId = null;
    this.notice = null;
    this.startRound();
  }

  abortToLobby(notice) {
    this.phase = 'lobby';
    this.round = 0;
    this.judgeId = null;
    this.prompt = null;
    this.submissions = [];
    this.lastResult = null;
    for (const p of this.players) p.hand = [];
    this.notice = notice;
  }

  fillHand(player) {
    while (player.hand.length < this.settings.handSize) {
      const card = this.answers.draw();
      if (!card) break;
      player.hand.push(card);
    }
  }

  nextJudge() {
    const eligible = this.players.filter((p) => p.connected);
    const pool = eligible.length ? eligible : this.players;
    let prevIdx = this.players.findIndex((p) => p.id === this.judgeId);
    // If the last judge left, whoever slid into their seat is next.
    if (prevIdx === -1) prevIdx = (this.judgeSeat ?? 0) - 1;
    // Walk forward through turn order from the previous judge.
    for (let step = 1; step <= this.players.length; step++) {
      const candidate = this.players[(prevIdx + step + this.players.length) % this.players.length];
      if (pool.includes(candidate)) return candidate.id;
    }
    return pool[0].id;
  }

  startRound() {
    if (this.prompt) this.prompts.discard(this.prompt);
    this.round += 1;
    this.judgeId = this.nextJudge();
    this.judgeSeat = this.players.findIndex((p) => p.id === this.judgeId);
    this.prompt = this.prompts.draw();
    this.submissions = [];
    this.phase = 'submitting';
    for (const p of this.players) this.fillHand(p);
    this.touch();
  }

  /** Ends the current round without a winner, returning played cards to their owners. */
  voidRound(notice) {
    for (const sub of this.submissions) {
      const owner = this.player(sub.playerId);
      if (owner) owner.hand.push(...sub.cards);
      else this.answers.discard(...sub.cards);
    }
    this.submissions = [];
    this.notice = notice;
    this.startRound();
  }

  skipRound(byId) {
    this.requireHost(byId);
    if (this.phase !== 'submitting' && this.phase !== 'judging') throw new GameError('There is no round to skip.');
    this.voidRound('The host skipped that round.');
  }

  // ---- play --------------------------------------------------------------

  submit(playerId, cardIds) {
    const player = this.requirePlayer(playerId);
    if (this.phase !== 'submitting') throw new GameError('You cannot play cards right now.');
    if (playerId === this.judgeId) throw new GameError('The judge does not play a card this round.');
    if (this.submissions.some((s) => s.playerId === playerId)) throw new GameError('You already played.');
    if (!Array.isArray(cardIds) || cardIds.length !== this.prompt.pick || new Set(cardIds).size !== cardIds.length) {
      throw new GameError(`Pick exactly ${this.prompt.pick} card${this.prompt.pick > 1 ? 's' : ''}.`);
    }
    const cards = cardIds.map((id) => player.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) throw new GameError('That card is not in your hand.');
    // Decks are de-duplicated on load; this guards against two identical answers in one round anyway.
    const played = new Set(this.submissions.flatMap((s) => s.cards.map((c) => normalizeText(c.text))));
    if (cards.some((c) => played.has(normalizeText(c.text)))) {
      throw new GameError('Someone already played that answer this round. Pick a different card.');
    }

    player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
    this.submissions.push({ id: randomUUID(), playerId, cards });
    this.notice = null;
    this.maybeStartJudging();
    this.touch();
  }

  maybeStartJudging() {
    if (this.phase !== 'submitting') return;
    const waitingOn = this.players.filter(
      (p) => p.connected && p.id !== this.judgeId && !this.submissions.some((s) => s.playerId === p.id),
    );
    if (waitingOn.length === 0 && this.submissions.length > 0) {
      shuffle(this.submissions); // hide play order from the judge
      this.phase = 'judging';
    }
  }

  pickWinner(judgeId, submissionId) {
    if (this.phase !== 'judging') throw new GameError('It is not time to judge.');
    if (judgeId !== this.judgeId) throw new GameError('Only the judge can pick the winner.');
    const sub = this.submissions.find((s) => s.id === submissionId);
    if (!sub) throw new GameError('That answer no longer exists.');

    const winner = this.player(sub.playerId);
    winner.score += 1;
    this.lastResult = {
      prompt: this.prompt,
      winnerId: winner.id,
      winnerName: winner.name,
      cards: sub.cards,
      submissions: this.submissions.map((s) => ({
        id: s.id,
        cards: s.cards,
        playerId: s.playerId,
        playerName: this.player(s.playerId)?.name ?? '(left)',
      })),
    };
    for (const s of this.submissions) this.answers.discard(...s.cards);

    if (winner.score >= this.settings.pointsToWin) {
      this.phase = 'gameOver';
      this.winnerId = winner.id;
    } else {
      this.phase = 'reveal';
    }
    this.touch();
  }

  nextRound(byId) {
    if (this.phase !== 'reveal') throw new GameError('The round is not over yet.');
    if (byId !== this.judgeId && byId !== this.hostId) throw new GameError('Waiting for the judge to continue.');
    this.notice = null;
    this.startRound();
  }

  /** Once per game, a player may throw back their whole hand and draw a fresh one for free. */
  mulligan(playerId) {
    const player = this.requirePlayer(playerId);
    if (player.mulliganUsed) throw new GameError('You already used your mulligan this game.');
    this.redrawHand(player);
    player.mulliganUsed = true;
    this.touch();
  }

  /** House rule: spend one point to discard your whole hand and draw a new one. */
  tradeHand(playerId) {
    const player = this.requirePlayer(playerId);
    if (player.score < 1) throw new GameError('Trading in your hand costs 1 point.');
    this.redrawHand(player);
    player.score -= 1;
    this.touch();
  }

  redrawHand(player) {
    if (this.phase !== 'submitting') throw new GameError('You can only swap your hand while cards are being played.');
    if (player.id === this.judgeId) throw new GameError('The judge cannot swap their hand this round.');
    if (this.submissions.some((s) => s.playerId === player.id)) throw new GameError('You already played this round.');
    // Draw the new hand before discarding the old one so you never get your own cards back.
    const old = player.hand;
    player.hand = [];
    this.fillHand(player);
    this.answers.discard(...old);
  }

  // ---- views -------------------------------------------------------------

  /** The state one player is allowed to see. Never includes other hands or anyone's token. */
  viewFor(playerId) {
    const me = this.player(playerId);
    const submitted = new Set(this.submissions.map((s) => s.playerId));
    const mySub = this.submissions.find((s) => s.playerId === playerId);
    const showAnswers = this.phase === 'judging';

    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      settings: this.settings,
      limits: SETTING_LIMITS,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      you: me ? { id: me.id, name: me.name, score: me.score, hand: me.hand, mulliganUsed: me.mulliganUsed } : null,
      decks: this.decks.map((d) => ({
        id: d.id, name: d.name, description: d.description, prompts: d.prompts.length, answers: d.answers.length,
      })),
      // Totals for the selected decks combined, after removing cards they share.
      deckTotals: { prompts: this.deck.prompts.length, answers: this.deck.answers.length },
      hostId: this.hostId,
      judgeId: this.judgeId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        submitted: submitted.has(p.id),
      })),
      prompt: this.prompt,
      submittedCount: this.submissions.length,
      yourSubmission: mySub ? mySub.cards : null,
      // Anonymous during judging; owners are only revealed in lastResult.
      submissions: showAnswers ? this.submissions.map((s) => ({ id: s.id, cards: s.cards })) : null,
      lastResult: this.phase === 'reveal' || this.phase === 'gameOver' ? this.lastResult : null,
      winnerId: this.winnerId,
      notice: this.notice,
    };
  }
}

module.exports = { Room, GameError, normalizeDeck, MIN_PLAYERS, MAX_PLAYERS, SETTING_LIMITS };
