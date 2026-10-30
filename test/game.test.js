'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, GameError, normalizeDeck } = require('../server/game');

function makeDeck({ prompts = 20, answers = 200, pick = 1, id = 'test' } = {}) {
  return normalizeDeck({
    name: `Deck ${id}`,
    prompts: Array.from({ length: prompts }, (_, i) => ({ text: `P${i} ____`, pick })),
    answers: Array.from({ length: answers }, (_, i) => `${id} A${i}`),
  }, id);
}

function setup(n = 3, deckOpts) {
  const room = new Room('TEST', [makeDeck(deckOpts)]);
  const players = Array.from({ length: n }, (_, i) => room.join(`P${i}`));
  return { room, players, host: players[0] };
}

function playAll(room) {
  for (const p of room.players) {
    if (p.id === room.judgeId) continue;
    room.submit(p.id, p.hand.slice(0, room.prompt.pick).map((c) => c.id));
  }
}

test('first player is host; duplicate names rejected', () => {
  const { room, host } = setup(1);
  assert.equal(room.hostId, host.id);
  assert.throws(() => room.join('p0'), GameError);
  assert.throws(() => room.join('   '), GameError);
});

test('cannot start with fewer than 3 players, or as non-host', () => {
  const { room, players } = setup(2);
  assert.throws(() => room.start(players[0].id), /at least 3/);
  room.join('P2');
  assert.throws(() => room.start(players[1].id), /host/);
  room.start(players[0].id);
  assert.equal(room.phase, 'submitting');
});

test('start deals full hands and assigns a judge', () => {
  const { room, host } = setup(4);
  room.start(host.id);
  for (const p of room.players) assert.equal(p.hand.length, room.settings.handSize);
  assert.ok(room.player(room.judgeId));
  assert.equal(room.round, 1);
});

test('a full round: submit, judge, score, refill, judge rotates', () => {
  const { room, host } = setup(3);
  room.start(host.id);
  const firstJudge = room.judgeId;

  assert.throws(() => room.submit(firstJudge, [room.player(firstJudge).hand[0].id]), /judge/);
  playAll(room);
  assert.equal(room.phase, 'judging');
  assert.equal(room.submissions.length, 2);

  const nonJudge = room.players.find((p) => p.id !== firstJudge);
  assert.throws(() => room.pickWinner(nonJudge.id, room.submissions[0].id), /judge/);

  const winningSub = room.submissions[0];
  room.pickWinner(firstJudge, winningSub.id);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.player(winningSub.playerId).score, 1);
  assert.equal(room.lastResult.winnerId, winningSub.playerId);

  room.nextRound(firstJudge);
  assert.equal(room.round, 2);
  assert.notEqual(room.judgeId, firstJudge);
  for (const p of room.players) assert.equal(p.hand.length, room.settings.handSize);
});

test('judge role cycles through every player in order', () => {
  const { room, host } = setup(4);
  room.start(host.id);
  const judges = [];
  for (let i = 0; i < 8; i++) {
    judges.push(room.judgeId);
    playAll(room);
    room.pickWinner(room.judgeId, room.submissions[0].id);
    if (room.phase === 'gameOver') break;
    room.nextRound(room.hostId);
  }
  const order = room.players.map((p) => p.id);
  for (let i = 1; i < judges.length; i++) {
    assert.equal(order.indexOf(judges[i]), (order.indexOf(judges[i - 1]) + 1) % order.length);
  }
});

test('views hide other hands, tokens, and authorship while judging', () => {
  const { room, host, players } = setup(3);
  room.start(host.id);
  const view = room.viewFor(players[1].id);
  const json = JSON.stringify(view);
  for (const p of players) assert.ok(!json.includes(p.token));
  assert.ok(!('hand' in view.players[0]));
  assert.equal(view.submissions, null);

  playAll(room);
  const judging = room.viewFor(players[1].id);
  for (const s of judging.submissions) assert.deepEqual(Object.keys(s).sort(), ['cards', 'id']);
});

test('pick-2 prompts require exactly two distinct cards', () => {
  const { room, host } = setup(3, { pick: 2 });
  room.start(host.id);
  const p = room.players.find((x) => x.id !== room.judgeId);
  assert.throws(() => room.submit(p.id, [p.hand[0].id]), /exactly 2/);
  assert.throws(() => room.submit(p.id, [p.hand[0].id, p.hand[0].id]), /exactly 2/);
  assert.throws(() => room.submit(p.id, [p.hand[0].id, 'bogus']), /not in your hand/);
  room.submit(p.id, [p.hand[0].id, p.hand[1].id]);
  assert.equal(p.hand.length, room.settings.handSize - 2);
});

test('reaching pointsToWin ends the game; play again resets scores', () => {
  const { room, host } = setup(3);
  room.updateSettings(host.id, { pointsToWin: 3 });
  room.start(host.id);
  while (room.phase !== 'gameOver') {
    playAll(room);
    room.pickWinner(room.judgeId, room.submissions[0].id);
    if (room.phase === 'reveal') room.nextRound(host.id);
  }
  assert.equal(room.player(room.winnerId).score, 3);
  room.start(host.id);
  assert.ok(room.players.every((p) => p.score === 0));
});

test('settings are clamped and locked during play', () => {
  const { room, host } = setup(3);
  room.updateSettings(host.id, { handSize: 99, pointsToWin: -4 });
  assert.equal(room.settings.handSize, 12);
  assert.equal(room.settings.pointsToWin, 3);
  room.start(host.id);
  assert.throws(() => room.updateSettings(host.id, { handSize: 6 }), /between games/);
});

test('a disconnected player does not block the round', () => {
  const { room, host } = setup(4);
  room.start(host.id);
  const others = room.players.filter((p) => p.id !== room.judgeId);
  room.submit(others[0].id, [others[0].hand[0].id]);
  room.submit(others[1].id, [others[1].hand[0].id]);
  assert.equal(room.phase, 'submitting');
  room.setConnected(others[2].id, false);
  assert.equal(room.phase, 'judging');
});

test('reconnecting with a token restores the same seat', () => {
  const { room, players } = setup(3);
  room.setConnected(players[1].id, false);
  const back = room.join('ignored', players[1].token);
  assert.equal(back.id, players[1].id);
  assert.equal(back.connected, true);
  assert.equal(room.players.length, 3);
});

test('judge leaving mid-round voids it and returns played cards', () => {
  const { room, host } = setup(4);
  room.start(host.id);
  const judge = room.judgeId;
  const judgeSeat = room.players.findIndex((p) => p.id === judge);
  const player = room.players.find((p) => p.id !== judge);
  const card = player.hand[0];
  room.submit(player.id, [card.id]);
  room.leave(judge);
  assert.equal(room.phase, 'submitting');
  assert.equal(room.round, 2);
  assert.ok(player.hand.some((c) => c.id === card.id));
  // The player who slid into the departed judge's seat is up next.
  assert.equal(room.judgeId, room.players[judgeSeat % room.players.length].id);
});

test('dropping below 3 players returns to lobby; host passes on', () => {
  const { room, host, players } = setup(3);
  room.start(host.id);
  room.leave(host.id);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.hostId, players[1].id);
  assert.match(room.notice, /Not enough players/);
});

test('trade hand costs a point and redraws', () => {
  const { room, host } = setup(3);
  room.start(host.id);
  const p = room.players.find((x) => x.id !== room.judgeId);
  assert.throws(() => room.tradeHand(p.id), /costs 1 point/);
  p.score = 2;
  const before = p.hand.map((c) => c.id);
  room.tradeHand(p.id);
  assert.equal(p.score, 1);
  assert.equal(p.hand.length, room.settings.handSize);
  assert.ok(p.hand.every((c) => !before.includes(c.id)));
});

test('host can skip a stuck round', () => {
  const { room, host } = setup(3);
  room.start(host.id);
  assert.throws(() => room.skipRound(room.players[1].id), /host/);
  room.skipRound(host.id);
  assert.equal(room.round, 2);
  assert.equal(room.phase, 'submitting');
});

test('deck reshuffles discards so long games never run dry', () => {
  // 3 players x 7 cards = 21 in hand; 30 cards forces reshuffles within a few rounds.
  const { room, host } = setup(3, { answers: 30, prompts: 3 });
  room.updateSettings(host.id, { pointsToWin: 20 });
  room.start(host.id);
  for (let i = 0; i < 25 && room.phase !== 'gameOver'; i++) {
    playAll(room);
    room.pickWinner(room.judgeId, room.submissions[0].id);
    if (room.phase === 'reveal') room.nextRound(host.id);
    for (const p of room.players) assert.equal(p.hand.length, room.settings.handSize);
    assert.ok(room.prompt);
  }
});

test('refuses to start when the deck is too small', () => {
  const { room, host } = setup(3, { answers: 20 });
  assert.throws(() => room.start(host.id), /has 20 answer cards.*need 27/);
});

test('normalizeDeck drops duplicate cards, ignoring case and spacing', () => {
  const deck = normalizeDeck({
    prompts: [{ text: 'Hi ____' }, { text: 'hi   ____' }],
    answers: ['Cats', ' cats ', 'CATS', 'Dogs', ''],
  }, 'd');
  assert.equal(deck.prompts.length, 1);
  assert.deepEqual(deck.answers.map((a) => a.text), ['Cats', 'Dogs']);
  assert.equal(deck.duplicatesRemoved, 4);
  assert.equal(new Set(deck.answers.map((a) => a.id)).size, 2);
  assert.throws(() => normalizeDeck({ prompts: [{ text: 'x', pick: 9 }], answers: ['a'] }, 'bad'));
});

test('no answer card is ever in two places at once', () => {
  const { room, host } = setup(6, { answers: 70, prompts: 5 });
  room.updateSettings(host.id, { pointsToWin: 20 });
  room.start(host.id);
  for (let i = 0; i < 30 && room.phase !== 'gameOver'; i++) {
    const held = room.players.flatMap((p) => p.hand.map((c) => c.text));
    assert.equal(new Set(held).size, held.length, 'duplicate card across hands');
    playAll(room);
    const played = room.submissions.flatMap((s) => s.cards.map((c) => c.text));
    assert.equal(new Set(played).size, played.length, 'duplicate answer in a round');
    room.pickWinner(room.judgeId, room.submissions[0].id);
    if (room.phase === 'reveal') room.nextRound(host.id);
  }
});

test('an answer identical to one already played this round is rejected', () => {
  const { room, host } = setup(3);
  room.start(host.id);
  const [p1, p2] = room.players.filter((p) => p.id !== room.judgeId);
  // Simulate a hand-edited deck that slipped a duplicate past loading.
  p2.hand[0] = { id: 'dupe', text: ` ${p1.hand[0].text.toUpperCase()} ` };
  room.submit(p1.id, [p1.hand[0].id]);
  assert.throws(() => room.submit(p2.id, ['dupe']), /already played that answer/);
  room.submit(p2.id, [p2.hand[1].id]);
  assert.equal(room.phase, 'judging');
});

test('mulligan: free, whole new hand, once per game, resets on new game', () => {
  const { room, host } = setup(3);
  room.updateSettings(host.id, { pointsToWin: 3 });
  room.start(host.id);
  const p = room.players.find((x) => x.id !== room.judgeId);
  const before = p.hand.map((c) => c.id);
  room.mulligan(p.id);
  assert.equal(p.score, 0);
  assert.equal(p.hand.length, room.settings.handSize);
  assert.ok(p.hand.every((c) => !before.includes(c.id)), 'got an old card back');
  assert.equal(room.viewFor(p.id).you.mulliganUsed, true);
  assert.throws(() => room.mulligan(p.id), /already used your mulligan/);
  assert.throws(() => room.mulligan(room.judgeId), /judge/);

  while (room.phase !== 'gameOver') {
    playAll(room);
    room.pickWinner(room.judgeId, room.submissions[0].id);
    if (room.phase === 'reveal') room.nextRound(host.id);
  }
  room.start(host.id);
  assert.equal(p.mulliganUsed, false);
});

test('mulligan is not allowed after playing or outside the playing phase', () => {
  const { room, host } = setup(3);
  assert.throws(() => room.mulligan(host.id), /while cards are being played/);
  room.start(host.id);
  const p = room.players.find((x) => x.id !== room.judgeId);
  room.submit(p.id, [p.hand[0].id]);
  assert.throws(() => room.mulligan(p.id), /already played/);
  assert.equal(p.mulliganUsed, false, 'a refused mulligan must not be spent');
});

test('host picks the deck in the lobby; game deals from it', () => {
  const room = new Room('TEST', [makeDeck({ id: 'one' }), makeDeck({ id: 'two' })]);
  const host = room.join('H');
  const guest = room.join('G');
  room.join('X');
  assert.deepEqual(room.settings.deckIds, ['one']);
  assert.throws(() => room.updateSettings(guest.id, { deckIds: ['two'] }), /host/);
  assert.throws(() => room.updateSettings(host.id, { deckIds: ['nope'] }), /does not exist/);
  room.updateSettings(host.id, { deckIds: ['two'] });
  room.start(host.id);
  assert.ok(room.players.every((p) => p.hand.every((c) => c.text.startsWith('two '))));
  assert.throws(() => room.updateSettings(host.id, { deckIds: ['one'] }), /between games/);
  assert.deepEqual(room.viewFor(guest.id).decks.map((d) => d.id), ['one', 'two']);
});

test('several decks can be combined into one pile', () => {
  const room = new Room('TEST', [makeDeck({ id: 'one' }), makeDeck({ id: 'two' }), makeDeck({ id: 'three' })]);
  const host = room.join('H');
  room.join('G');
  room.join('X');
  // Ticked out of order; stored in lobby order.
  room.updateSettings(host.id, { deckIds: ['three', 'one'] });
  assert.deepEqual(room.settings.deckIds, ['one', 'three']);
  // makeDeck() gives every deck the same prompt text, so prompts collapse; answers are distinct.
  assert.deepEqual(room.viewFor(host.id).deckTotals, { prompts: 20, answers: 400 });
  room.start(host.id);
  const prefixes = new Set(room.players.flatMap((p) => p.hand.map((c) => c.text.split(' ')[0])));
  assert.ok([...prefixes].every((x) => x === 'one' || x === 'three'));
});

test('combining overlapping decks never deals the same card twice', () => {
  const a = normalizeDeck({ prompts: [{ text: 'Shared ____' }, { text: 'Only A ____' }], answers: ['Same', 'A1', 'A2'] }, 'a');
  const b = normalizeDeck({ prompts: [{ text: 'shared  ____' }], answers: ['same', 'B1'] }, 'b');
  const room = new Room('TEST', [a, b]);
  const host = room.join('H');
  room.updateSettings(host.id, { deckIds: ['a', 'b'] });
  assert.deepEqual(room.deck.prompts.map((p) => p.text), ['Shared ____', 'Only A ____']);
  assert.deepEqual(room.deck.answers.map((x) => x.text), ['Same', 'A1', 'A2', 'B1']);
});

test('at least one deck must stay selected', () => {
  const { room, host } = setup(3);
  assert.throws(() => room.updateSettings(host.id, { deckIds: [] }), /at least one deck/);
  assert.throws(() => room.updateSettings(host.id, { deckIds: 'test' }), /at least one deck/);
  assert.deepEqual(room.settings.deckIds, ['test']);
});

test('the too-small-deck error counts the combined pile', () => {
  const room = new Room('TEST', [makeDeck({ id: 'x', answers: 12 }), makeDeck({ id: 'y', answers: 12 })]);
  const host = room.join('H');
  room.join('G');
  room.join('X');
  room.updateSettings(host.id, { deckIds: ['x', 'y'] });
  assert.throws(() => room.start(host.id), /The 2 selected decks have 24 answer cards.*need 27/);
  room.updateSettings(host.id, { handSize: 5 });
  room.start(host.id); // 3 x (5 + 2) = 21 <= 24
});
