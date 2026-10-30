# Hot Take

A phone-based party card game in the "judge picks the best answer" genre. One person runs the server; everyone else joins from their phone's browser with a 4-letter room code. No app install and no TV needed.

## Run it

**Docker (recommended)**

```bash
docker compose up -d --build
```

**Without Docker** (Node 20+)

```bash
npm install
npm start
```

Open `http://<server-ip>:3000` on the host's phone or laptop and start a game. The lobby shows a **QR code**: other players scan it with their phone camera and land on the join screen with the room code filled in. They can also type the 4-letter code. The QR code is also under **Scores ☰ → Invite players** during a game, for late joiners.

The QR code encodes an address other phones can reach:

- Opened via a LAN IP or domain: that address is used as-is, including `X-Forwarded-Proto/Host` from a reverse proxy on a private network.
- Opened via `localhost` with `npm start`: the server swaps in the machine's LAN IP automatically.
- Opened via `localhost` with **Docker**: the container can't see your LAN IP, so the lobby shows a warning. Either open the page via the LAN IP, or set `PUBLIC_URL` (see `docker-compose.yml`).

To play over the internet instead of a shared Wi-Fi network, put the container behind any HTTPS reverse proxy (Caddy, Traefik, nginx, Cloudflare Tunnel) or deploy it to a container host such as Fly.io, Render or Railway. If you use a proxy, it must forward WebSocket upgrades. Running a **single instance** is required, because game state lives in memory.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `DECKS_DIR` | `data/decks` | Folder of deck files |
| `PUBLIC_URL` | (auto) | Base URL for invite links and QR codes, e.g. `http://192.168.1.20:3000` |
| `DISCONNECT_GRACE_MS` | `120000` | How long a dropped phone keeps its seat |
| `ROOM_IDLE_MS` | `7200000` | Empty rooms are deleted after this long idle |
| `MAX_ROOMS` | `200` | Cap on concurrent rooms |

If Docker Hub is rate-limiting you, build from a mirror: `docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine -t hot-take .`

## Rules

1. Players: 3 to 12. Everyone holds a hand of answer cards (7 by default, adjustable from 5 to 12).
2. Each round one player is the **judge**, rotating in join order. The judge reveals a prompt card and reads it aloud.
3. Everyone else secretly plays the answer card that fits best. "Pick 2" prompts take two cards, in order.
4. When all connected players have played, the answers are shuffled and shown **anonymously** on every phone. The judge reads them aloud and picks a favorite.
5. Whoever played the winning answer gets 1 point. Hands refill, and the judge role passes on.
6. First to the target score (7 by default, adjustable from 3 to 20) wins.
7. **Mulligan:** once per game, any player may throw back their whole hand for a new one, free. After that, a hand trade costs 1 point.
8. No two players can play the same answer in a round. Decks are de-duplicated on load, and the server rejects a duplicate play as a backstop.

The full rules are behind the **(i)** button on every screen. It opens a pop-over with a link to open them in a new tab. They're also at `/rules`, and the text lives in `public/rules.js`.

Edge cases:

- A phone that disconnects keeps its seat for 2 minutes, and the round doesn't wait for it. Reloading the page or reopening the link rejoins the same seat with the same score.
- If the judge leaves, the round is voided and played cards go back to their owners. If the judge's phone just died, the host can **Skip this round** from the Scores menu.
- If the host leaves, host passes to the next player. If players drop below 3, the game returns to the lobby.
- Late joiners are dealt in immediately. The host can remove players.

## Decks

Twelve decks ship ready to play, built from the card text of **Cards Against Humanity**
(CC BY-NC-SA 4.0, see `data/decks/ATTRIBUTION.md`). The host picks one from the lobby dropdown. **Family Edition** is listed first and is the default, so a new room starts kid-safe.

| Deck | Prompts | Answers | Notes |
|---|---:|---:|---|
| Family Edition (default) | 204 | 1,128 | Kid-friendly; includes the Family Edition packs |
| Main Deck | 100 | 500 | Current US base game (v3.0) |
| Classic Main Deck | 90 | 460 | Original US base game (v1.7) |
| More Cards Against Humanity | 135 | 465 | |
| Absurd Box | 48 | 260 | |
| Hot Box | 40 | 260 | |
| Super Box | 54 | 246 | |
| Everything Box | 50 | 250 | |
| Red, Green & Blue Boxes | 246 | 894 | Classic expansions (originally First–Sixth) |
| Theme Packs & Promos | 274 | 1,644 | All small themed/holiday/promo packs mixed |
| Clams Aclamst Huclamity | 100 | 500 | Clam parody edition |
| Everything | 859 | 4,279 | All adult decks above combined |

Everything except Family Edition is adults-only.

To refresh the decks from the community master list:

```bash
node scripts/import-cah-decks.js            # downloads the sheet (behind a proxy: NODE_USE_ENV_PROXY=1)
node scripts/import-cah-decks.js --from DIR # or build from CSVs you saved as DIR/<tab>.csv
```

The script picks one printing of the base game rather than mixing regions and editions. It removes duplicates, keeps line breaks (many prompts are poems or lists), and reads "PICK 2" / "DRAW 2, PICK 3" from the sheet. It skips picture-only cards and the few cards too long for a phone (prompts over 280 characters, answers over 160). It doesn't import Tales, Explains the Joke, Twists, the procedurally generated cards or the regional conversion kits, because they aren't standard prompt/answer decks. Edit `DECKS` at the top of the script to regroup.

### Your own decks

Every `*.json` file in `data/decks/` is a deck, sorted by filename (the filename is the deck id):

```json
{
  "name": "Office Party",
  "description": "Safe for work. Mostly.",
  "prompts": [
    { "text": "My secret talent is ____.", "pick": 1 },
    { "text": "____ + ____ = disaster.", "pick": 2 }
  ],
  "answers": ["A soggy waffle", "Tax season"]
}
```

- Use `____` (3+ underscores) for blanks; the winning answers are filled into them. A line break in `text` shows as a line break on the card.
- `pick` can be 1, 2 or 3.
- Duplicate cards (ignoring case and spacing) are dropped on load.
- You need at least `players × (hand size + 2)` answer cards. Discards are reshuffled, so a bigger deck just means fewer repeats.
- Decks load at startup, so restart the server after editing. With Docker, uncomment the volume in `docker-compose.yml` to use your own `data/decks` folder without rebuilding. The importer replaces every `.json` in the folder, so keep custom decks somewhere else if you re-run it.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # rules engine + socket integration tests
```

- `server/game.js`: the rules engine as a pure state machine (`lobby → submitting → judging → reveal → … → gameOver`). Each player is only ever sent their own view, so other hands, reconnect tokens and who-played-what (until the reveal) never leave the server.
- `server/index.js`: Express + Socket.IO: room codes, reconnects, grace timers, cleanup.
- `public/`: mobile-first client in plain HTML/CSS/JS with no build step. The theme is dark with chunky yellow buttons, a purple prompt card and a swipeable hand docked at the bottom; colors are CSS variables at the top of `style.css`. The font is Outfit (SIL Open Font License, `public/fonts/OFL-Outfit.txt`), bundled locally so the game works on a LAN with no internet. It keeps the screen awake during a game (Wake Lock API) and vibrates on Android when it's your turn.
