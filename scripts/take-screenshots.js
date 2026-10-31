#!/usr/bin/env node
'use strict';

/**
 * Regenerates the README images in docs/screenshots/: a scripted four-phone game on the default
 * deck, the lobby deck picker, and the three-phone banner.
 *
 *   npm run screenshots
 *
 * Needs Playwright's Chromium once: npx playwright install chromium
 *
 * The script starts its own server on a free port and writes to a temp folder first, so a failed
 * run never leaves a half-updated set. It replays the game until round 1 is "showcase" quality:
 * the filled-in prompt fits above the hand without scrolling, and the cards on screen are free of
 * bathroom, body and similar jokes (a screenshot-only filter; the game itself is unaffected).
 */

// The lobby and QR code show this address. Fixing it keeps your real LAN IP out of the README.
process.env.PUBLIC_URL ||= 'http://192.168.1.20:3000';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, devices } = require('playwright');
const { createServer } = require('../server/index');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const PHONE = { ...devices['iPhone 13'], deviceScaleFactor: 2 };
const MAX_GAMES = 120;
const PLAYERS = ['Ana', 'Ben', 'Cy', 'Dee'];

const CRUDE = /\b(butt\w*|pee\w*|pis+\w*|poo\w*|fart\w*|vomit\w*|barf\w*|puk\w+|turd\w*|booger\w*|diarrh\w*|toilet\w*|potty|naked|nud\w+|bod(y|ies)|sex\w*|boob\w*|wiener\w*|crotch\w*|armpit\w*|snot\w*|underwear|undies|pants|dead|die\w*|kill\w*|murder\w*|blood\w*|bras?|nipple\w*|gross\w*|sweat\w*|smell\w*|stink\w*|burp\w*|spit\w*|lick\w*|naughty|boot(y|ies)|bum\w*|jesus|god\w*|church\w*|satan\w*|hell|balls?|nuts|war|crimes?|weapon\w*|drunk\w*|beer|wine|bleed\w*|period\w*|tampon\w*|pms)\b/i;
const clean = (text) => !CRUDE.test(text);

class Retry extends Error {}

// ---- helpers ------------------------------------------------------------------

async function startServer() {
  const { server, io } = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, stop: () => { io.close(); server.close(); } };
}

async function openPhones(browser, errors) {
  const pages = [];
  for (const name of PLAYERS) {
    const page = await (await browser.newContext(PHONE)).newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    pages.push(page);
  }
  return pages;
}

/** Host creates a room; everyone else joins it. Returns the room code. */
async function fillRoom(url, pages) {
  const [host, ...guests] = pages;
  await host.goto(url);
  await host.fill('#name', PLAYERS[0]);
  await host.click('[data-act=create]');
  await host.waitForSelector('.bigcode');
  const code = (await host.textContent('.bigcode')).trim();
  for (const [i, page] of guests.entries()) {
    await page.goto(`${url}/?room=${code}`);
    await page.fill('#name', PLAYERS[i + 1]);
    await page.click('[data-act=join]');
    await page.waitForSelector('.bigcode');
  }
  await host.waitForSelector(`text=Start game · ${pages.length} players`);
  return code;
}

function shooter(dir) {
  return async (page, name) => {
    await page.waitForTimeout(350); // let transitions settle
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
  };
}

// ---- the scripted game ---------------------------------------------------------------

async function playGame(browser, url, dir) {
  const errors = [];
  const shot = shooter(dir);
  const pages = await openPhones(browser, errors);
  const [host] = pages;

  await host.goto(url);
  await shot(host, 'home');
  await host.click('[data-act=rules]');
  await host.waitForSelector('.sheet .rules');
  await shot(host, 'rules');
  await host.click('.sheet [data-act=close]');

  await fillRoom(url, pages);
  // A short game (first to 3) so the game-over screen comes quickly.
  for (let i = 0; i < 4; i++) {
    await host.click('[data-act=setting][data-key=pointsToWin][data-delta="-1"]');
    await host.waitForTimeout(150);
  }
  await host.waitForSelector('.setting output:text("3")');
  await host.$eval('.stage', (s) => { s.scrollTop = 0; });
  await shot(host, 'lobby');
  await host.click('[data-act=start]');

  for (let round = 1; round <= 15; round++) {
    await Promise.all(pages.map((p) => p.waitForSelector('.prompt-card')));
    let judge;
    for (const p of pages) if (await p.$('h1:has-text("You\'re the judge")')) judge = p;
    const players = pages.filter((p) => p !== judge);
    const showcase = round === 1;
    if (showcase) {
      if (!clean(await judge.textContent('.prompt-card'))) throw new Retry('crude prompt');
      await shot(players[0], 'pick');
      await shot(judge, 'judge-waiting');
    }

    for (const [i, p] of players.entries()) {
      const pick = Number(/Pick (\d)/.exec(await p.textContent('.prompt-card'))?.[1] || 1);
      const texts = await p.$$eval('.pcard .txt', (els) => els.map((e) => e.textContent));
      // Shortest clean cards first, so the filled-in prompt stays compact.
      const order = texts.map((t, k) => [clean(t) ? t.length : 1e6 + t.length, k])
        .sort((x, y) => x[0] - y[0]).map(([, k]) => k);
      if (showcase) {
        if (order.slice(0, pick).some((k) => !clean(texts[k]))) throw new Retry('no clean card to play');
        // The first player's whole hand is visible in two screenshots.
        if (i === 0 && !texts.every(clean)) throw new Retry('crude card in the showcase hand');
      }
      for (let k = 0; k < pick; k++) await p.locator('.pcard').nth(order[k]).click();
      if (showcase && i === 0) {
        // The banner uses this screen: the whole prompt must sit above the hand, unscrolled.
        const fits = await p.evaluate(() => {
          const stage = document.querySelector('.stage');
          const prompt = document.querySelector('.prompt-card').getBoundingClientRect();
          return stage.scrollTop === 0 && prompt.bottom <= stage.getBoundingClientRect().bottom - 8;
        });
        if (!fits) throw new Retry('prompt too long to fit above the hand');
        await shot(p, 'selected');
      }
      await p.click('[data-act=submit]');
    }

    await judge.waitForSelector('button.answer-card');
    await judge.locator('button.answer-card').first().click();
    if (showcase) {
      await shot(judge, 'judging');
      await shot(players[1], 'watching');
    }
    await judge.click('[data-act=pick]');
    await Promise.all(pages.map((p) => p.waitForSelector('.answer-card.winner')));
    if (showcase) {
      await shot(players[2], 'reveal');
      await players[2].click('[data-act=menu]');
      await players[2].waitForSelector('.sheet');
      await shot(players[2], 'menu');
      await players[2].click('.sheet [data-act=close]');
    }
    if (await host.$('h1:has-text("wins!")')) {
      await shot(host, 'game-over');
      if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
      return round;
    }
    await judge.click('[data-act=next]');
    await Promise.all(pages.map((p) => p.waitForSelector(`text=Round ${round + 1}`)));
  }
  throw new Error('The game did not end within 15 rounds');
}

/** The lobby's deck picker with a few decks ticked. */
async function deckSettings(browser, url, dir) {
  const errors = [];
  const pages = await openPhones(browser, errors);
  const [host] = pages;
  await fillRoom(url, pages);
  for (const id of ['02-main', '06-hot-box']) {
    await host.click(`.deck-opt[data-id="${id}"]`);
    await host.waitForSelector(`.deck-opt[data-id="${id}"].on`);
  }
  await host.$eval('.deck-row', (el) => el.closest('.panel').scrollIntoView({ block: 'start' }));
  await shooter(dir)(host, 'lobby-settings');
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
}

/** Three phones (lobby, picking a card, round result) on a dark background. */
async function banner(browser, dir) {
  const img = (name) => `data:image/png;base64,${fs.readFileSync(path.join(dir, `${name}.png`)).toString('base64')}`;
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  await page.setContent(`<!doctype html>
    <style>
      body { margin: 0; width: 1800px; height: 1000px; display: flex; align-items: center; justify-content: center; gap: 70px;
        background: radial-gradient(640px 600px at 27% 55%, #4a380c, transparent 72%),
                    radial-gradient(680px 640px at 73% 45%, #2e165c, transparent 72%), #0c0d11; }
      img { height: 860px; border: 8px solid #000; border-radius: 52px; box-shadow: 10px 24px 52px rgba(0,0,0,.65); }
      img.side { margin-top: 60px; }
    </style>
    <img class="side" src="${img('lobby')}"><img src="${img('selected')}"><img class="side" src="${img('reveal')}">`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.join(dir, 'banner.png') });
  await page.close();
}

// ---- main -------------------------------------------------------------------------

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-take-shots-'));
  const { url, stop } = await startServer();
  const browser = await chromium.launch();
  try {
    let rounds;
    for (let game = 1; !rounds; game++) {
      if (game > MAX_GAMES) throw new Error(`No showcase-quality first round in ${MAX_GAMES} games`);
      try {
        rounds = await playGame(browser, url, tmp);
        console.log(`Game ${game}: kept (${rounds} rounds)`);
      } catch (err) {
        if (!(err instanceof Retry)) throw err;
        console.log(`Game ${game}: retrying (${err.message})`);
      } finally {
        for (const ctx of browser.contexts()) await ctx.close(); // fresh phones for each game
      }
    }
    await deckSettings(browser, url, tmp);
    await banner(browser, tmp);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.png'));
    for (const f of files) fs.copyFileSync(path.join(tmp, f), path.join(OUT_DIR, f));
    console.log(`Wrote ${files.length} images to ${path.relative(process.cwd(), OUT_DIR) || OUT_DIR}`);
  } finally {
    await browser.close();
    stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
