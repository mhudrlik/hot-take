'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer, loadDecks } = require('../server/index');
const path = require('path');

function client(url) {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.latest = null;
  socket.on('state', (s) => { socket.latest = s; });
  socket.call = (event, payload) => socket.timeout(2000).emitWithAck(event, payload);
  return socket;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test('three phones play a full round over sockets', async (t) => {
  const decks = loadDecks(path.join(__dirname, '..', 'data', 'decks'));
  const { server } = createServer({ decks, graceMs: 200 });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const phones = [client(url), client(url), client(url)];
  t.after(() => {
    phones.forEach((s) => s.close());
    server.close();
  });

  const created = await phones[0].call('create', { name: 'Ana' });
  assert.ok(created.ok);
  assert.match(created.code, /^[A-Z]{4}$/);

  assert.equal((await phones[1].call('join', { code: created.code.toLowerCase(), name: 'Ben' })).ok, true);
  assert.equal((await phones[2].call('join', { code: 'ZZZZ', name: 'Cy' })).error, 'No game with that code.');
  const cy = await phones[2].call('join', { code: created.code, name: 'Cy' });
  assert.ok(cy.ok);

  assert.match((await phones[1].call('action', { type: 'start' })).error, /host/);
  assert.ok((await phones[0].call('action', { type: 'settings', settings: { deckIds: ['02-main'] } })).ok);
  assert.ok((await phones[0].call('action', { type: 'start' })).ok);
  await settle();

  const main = new Set(decks.find((d) => d.id === '02-main').answers.map((a) => a.text));
  assert.ok(phones[1].latest.you.hand.every((c) => main.has(c.text)));
  const judgeId = phones[0].latest.judgeId;
  const judge = phones.find((s) => s.latest.you.id === judgeId);
  const players = phones.filter((s) => s !== judge);
  for (const s of players) {
    const res = await s.call('action', { type: 'submit', cardIds: s.latest.you.hand.slice(0, s.latest.prompt.pick).map((c) => c.id) });
    assert.ok(res.ok, res.error);
  }
  await settle();
  assert.equal(judge.latest.phase, 'judging');
  assert.equal(judge.latest.submissions.length, 2);

  const pick = judge.latest.submissions[0].id;
  assert.ok((await judge.call('action', { type: 'pick', submissionId: pick })).ok);
  await settle();
  assert.equal(players[0].latest.phase, 'reveal');
  assert.equal(players[0].latest.players.reduce((n, p) => n + p.score, 0), 1);

  // A phone drops and comes back with its token: same seat, same score.
  const before = phones[2].latest.you;
  phones[2].close();
  await settle();
  assert.equal(phones[0].latest.players.find((p) => p.id === before.id).connected, false);
  phones[2] = client(url);
  const rejoin = await phones[2].call('join', { code: created.code, token: cy.token });
  assert.ok(rejoin.ok);
  await settle();
  assert.equal(phones[2].latest.you.id, before.id);
  assert.equal(phones[2].latest.you.score, before.score);

  // A phone that never comes back is removed after the grace period.
  phones[2].close();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(phones[0].latest.players.length, 2);
  assert.equal(phones[0].latest.phase, 'lobby');
});

test('shipped decks are playable out of the box', () => {
  const decks = loadDecks(path.join(__dirname, '..', 'data', 'decks'));
  assert.ok(decks.length >= 3);
  assert.equal(new Set(decks.map((d) => d.id)).size, decks.length);
  assert.equal(decks[0].name, 'Family Edition', 'the default deck should be the kid-safe one');
  for (const d of decks) {
    // Biggest possible game: 12 players with 12-card hands, plus a pick-2 in flight.
    assert.ok(d.answers.length >= 12 * 14, `${d.name} has only ${d.answers.length} answers`);
    assert.ok(d.prompts.length >= 30, `${d.name} has only ${d.prompts.length} prompts`);
    assert.ok(d.description, `${d.name} needs a description`);
    for (const p of d.prompts) assert.ok([1, 2, 3].includes(p.pick));
  }
});

test('invite endpoints: QR svg and join URL', async (t) => {
  const { server } = createServer({ decks: loadDecks(path.join(__dirname, '..', 'data', 'decks')) });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  const qr = await fetch(`${base}/qr.svg?room=bcdf`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /^<svg/);
  assert.equal((await fetch(`${base}/qr.svg?room=<script>`)).status, 400);

  const invite = await (await fetch(`${base}/api/invite?room=BCDF`)).json();
  assert.match(invite.url, /\/\?room=BCDF$/);
  // localhost is swapped for a LAN address when one exists (outside Docker).
  if (invite.reachable) assert.doesNotMatch(invite.url, /localhost/);

  const proxied = await (await fetch(`${base}/api/invite?room=BCDF`, {
    headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'cards.example.com' },
  })).json();
  assert.equal(proxied.url, 'https://cards.example.com/?room=BCDF');

  assert.equal((await fetch(`${base}/rules`)).status, 200);
});
