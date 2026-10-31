#!/usr/bin/env node
'use strict';

/**
 * Builds data/decks/*.json from the community-maintained Cards Against Humanity master list:
 *   https://docs.google.com/spreadsheets/d/1-PqZiIjliCu0B1J0V6nq-V72b_-NFieeIJ0hC6WgrPk
 *
 * Usage:
 *   node scripts/import-cah-decks.js              # download the sheet tabs, then build
 *   node scripts/import-cah-decks.js --from DIR   # build from CSVs already saved as DIR/<tab>.csv
 *
 * Card text is from Cards Against Humanity (cardsagainsthumanity.com), licensed CC BY-NC-SA 4.0.
 */

const fs = require('fs');
const path = require('path');

const SHEET_ID = '1-PqZiIjliCu0B1J0V6nq-V72b_-NFieeIJ0hC6WgrPk';
const OUT_DIR = path.join(__dirname, '..', 'data', 'decks');

// Sheet tab -> gid. Tabs not listed here (Tales, Explains the Joke, Twists, procedurally generated
// cards, regional conversion kits) aren't standard prompt/answer decks, so they're left out.
const TABS = {
  main: 655640124,
  family: 1584347714,
  expansions: 752021477,
  discexp: 588267664,
  packs: 1505863135,
  fewextra: 954377557,
  limited: 1609998145,
  discpacks: 1705225343,
  pax: 1625938436,
  outofline: 2060261767,
  clams: 1648681708,
};

const ADULT = 'Adults only.';
// Longer cards don't fit on a phone-sized card; the handful that exceed these are skipped.
const MAX_PROMPT = 280;
const MAX_ANSWER = 160;

// Decks are listed (and numbered) in lobby order; the first one is the default.
// Each deck pulls cards from one or more sources:
//   { tab }                       every set on that tab
//   { tab, set }                  one set (matched by name prefix)
//   { tab, set, region, version } only cards printed in that edition column
const DECKS = [
  {
    id: '01-family', name: 'Family Edition',
    description: 'Kid-friendly. Family Edition plus its Glow in the Dark, Holidays and kids-written packs.',
    from: [{ tab: 'family' }],
  },
  {
    id: '02-main', name: 'Main Deck',
    description: `The current US base game (v3.0). ${ADULT}`,
    from: [{ tab: 'main', set: 'Cards Against Humanity: Main Deck', region: 'US', version: 'v3.0' }],
  },
  {
    id: '03-main-classic', name: 'Classic Main Deck',
    description: `The original US base game (v1.7), as printed before the 2.0 refresh. ${ADULT}`,
    from: [{ tab: 'main', set: 'Cards Against Humanity: Main Deck', region: 'US', version: 'v1.7' }],
  },
  {
    id: '04-more-cah', name: 'More Cards Against Humanity',
    description: `The big standalone expansion. ${ADULT}`,
    from: [{ tab: 'expansions', set: 'More Cards Against Humanity' }],
  },
  {
    id: '05-absurd-box', name: 'Absurd Box',
    description: `Weirder, sillier cards. ${ADULT}`,
    from: [{ tab: 'expansions', set: 'Absurd Box Expansion' }],
  },
  {
    id: '06-hot-box', name: 'Hot Box',
    description: `The 2023 expansion. ${ADULT}`,
    from: [{ tab: 'expansions', set: 'Hot Box Expansion' }],
  },
  {
    id: '07-super-box', name: 'Super Box',
    description: `Expansion. ${ADULT}`,
    from: [{ tab: 'expansions', set: 'Super Box' }],
  },
  {
    id: '08-everything-box', name: 'Everything Box',
    description: `Expansion. ${ADULT}`,
    from: [{ tab: 'expansions', set: 'Everything Box Expansion' }],
  },
  {
    id: '09-red-green-blue', name: 'Red, Green & Blue Boxes',
    description: `The classic expansions (originally the First through Sixth Expansions). ${ADULT}`,
    from: [{ tab: 'discexp' }],
  },
  {
    id: '10-packs-promos', name: 'Theme Packs & Promos',
    description: `Every small themed pack, holiday pack, bundle bonus and promo card, shuffled together. ${ADULT}`,
    from: [{ tab: 'packs' }, { tab: 'fewextra' }, { tab: 'limited' }, { tab: 'discpacks' }, { tab: 'pax' }, { tab: 'outofline' }],
  },
  {
    id: '11-clams', name: 'Clams Aclamst Huclamity',
    description: `The clam-themed parody edition. Very silly. ${ADULT}`,
    from: [{ tab: 'clams' }],
  },
];

// One giant deck made of every adult deck above (family and clams excluded).
DECKS.push({
  id: '12-everything', name: 'Everything',
  description: `Main deck, classic deck, every expansion and every pack in one pile. ${ADULT}`,
  union: ['02-main', '03-main-classic', '04-more-cah', '05-absurd-box', '06-hot-box', '07-super-box',
    '08-everything-box', '09-red-green-blue', '10-packs-promos'],
});

// ---- CSV ------------------------------------------------------------------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const width = Math.max(...rows.map((r) => r.length)) + 6;
  return rows.map((r) => r.concat(Array(width - r.length).fill('')));
}

async function loadTab(tab, fromDir) {
  if (fromDir) return parseCSV(fs.readFileSync(path.join(fromDir, `${tab}.csv`), 'utf8'));
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${TABS[tab]}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading tab "${tab}" failed: HTTP ${res.status}`);
  return parseCSV(await res.text());
}

// ---- sheet layout -----------------------------------------------------------
// Each tab holds one or more sets side by side. A set is a block of columns whose header row reads
// "Set | <name> | Special | Duplicates | <edition columns...>", followed by rows of
// "Prompt|Response | text | special | duplicates | <edition markers...>".

function findSets(rows) {
  const headers = [];
  rows.forEach((row, r) => row.forEach((cell, c) => {
    if (cell.trim() === 'Set' && row[c + 1]?.trim()) headers.push({ r, c, name: row[c + 1].trim() });
  }));
  return headers.map((h) => {
    const nextCol = Math.min(...headers.filter((o) => o.r === h.r && o.c > h.c).map((o) => o.c), rows[0].length);
    const endRow = Math.min(...headers.filter((o) => o.c === h.c && o.r > h.r).map((o) => o.r), rows.length);
    return { ...h, nextCol, endRow };
  });
}

function editionColumn(rows, set, region, version) {
  for (let c = set.c + 4; c < set.nextCol; c++) {
    if (rows[set.r][c].trim() === version && rows[set.r - 1][c].trim() === region) return c;
  }
  throw new Error(`No ${region} ${version} column in "${set.name}"`);
}

function cleanText(raw) {
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/_{2,}/g, '____')
    .replace(/____ +([.?!,:;"”’)])/g, '____$1');
}

function pickCount(text, special) {
  const marked = /pick\s*(\d)/i.exec(special);
  if (marked) return Math.min(3, Number(marked[1]));
  const blanks = (text.match(/_{3,}/g) || []).length;
  return Math.min(3, Math.max(1, blanks));
}

function cardsFrom(rows, set, column) {
  const prompts = [];
  const answers = [];
  for (let r = set.r + 1; r < set.endRow; r++) {
    const row = rows[r];
    const kind = row[set.c].trim().toLowerCase();
    if (kind !== 'prompt' && kind !== 'response') continue;
    if (column !== undefined && !row[column].trim()) continue;
    const text = cleanText(row[set.c + 1]);
    if (!text) continue;
    if (kind === 'prompt') {
      if (text.length <= MAX_PROMPT) prompts.push({ text, pick: pickCount(text, row[set.c + 2]) });
    } else if (text.length <= MAX_ANSWER && !/^\[.*\]$/.test(text)) {
      answers.push(text); // "[picture of ...]" cards can't be shown as text
    }
  }
  return { prompts, answers };
}

// ---- build ------------------------------------------------------------------

function dedupe(deck) {
  const key = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const seenP = new Set();
  const seenA = new Set();
  return {
    ...deck,
    prompts: deck.prompts.filter((p) => !seenP.has(key(p.text)) && seenP.add(key(p.text))),
    answers: deck.answers.filter((a) => !seenA.has(key(a)) && seenA.add(key(a))),
  };
}

async function main() {
  const fromIdx = process.argv.indexOf('--from');
  const fromDir = fromIdx > -1 ? process.argv[fromIdx + 1] : null;

  const tabs = {};
  for (const tab of Object.keys(TABS)) {
    const rows = await loadTab(tab, fromDir);
    tabs[tab] = { rows, sets: findSets(rows) };
  }

  const built = {};
  for (const def of DECKS) {
    let deck = { name: def.name, description: def.description, prompts: [], answers: [] };
    if (def.union) {
      for (const id of def.union) {
        deck.prompts.push(...built[id].prompts);
        deck.answers.push(...built[id].answers);
      }
    } else {
      for (const src of def.from) {
        const { rows, sets } = tabs[src.tab];
        const matches = src.set ? sets.filter((s) => s.name.startsWith(src.set)) : sets;
        if (src.set && matches.length !== 1) throw new Error(`Expected one set "${src.set}" on tab ${src.tab}, found ${matches.length}`);
        for (const set of matches) {
          const column = src.version ? editionColumn(rows, set, src.region, src.version) : undefined;
          const cards = cardsFrom(rows, set, column);
          deck.prompts.push(...cards.prompts);
          deck.answers.push(...cards.answers);
        }
      }
    }
    deck = dedupe(deck);
    built[def.id] = deck;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Only replace this script's own decks; hand-made decks in the folder (e.g. the themed ones) are left alone.
  const ours = new Set(DECKS.map((d) => `${d.id}.json`));
  for (const f of fs.readdirSync(OUT_DIR)) if (ours.has(f)) fs.unlinkSync(path.join(OUT_DIR, f));
  for (const def of DECKS) {
    const deck = built[def.id];
    fs.writeFileSync(path.join(OUT_DIR, `${def.id}.json`), `${JSON.stringify(deck, null, 2)}\n`);
    const picks = deck.prompts.reduce((m, p) => ({ ...m, [p.pick]: (m[p.pick] || 0) + 1 }), {});
    console.log(`${def.id.padEnd(20)} ${String(deck.prompts.length).padStart(5)} prompts ${String(deck.answers.length).padStart(5)} answers  picks ${JSON.stringify(picks)}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
