# Mazing Contest

A local browser roguelike inspired by the maze-building contest format: descend through five seeded floors, draft lasting augments, and try to force your runner along the longest legal route.

## Share with friends

Publish this folder on any static HTTPS host, then use **Invite friends**. The copied challenge URL locks the five-floor run, including floor seeds, base resources, augment drafts, and AI opponents. After the final floor, **Copy my score challenge** embeds your cumulative time as the target your friends must beat.

No game server or account is required. This is an asynchronous, casual challenge: friends play independently and score targets in URLs are not cheat-proof. A `localhost` URL only works on the computer running it, so the folder must be published before that link can be sent over the internet.

## Real-time online lobbies

The **Play online** option adds synchronized private rooms for two to four human players. GitHub Pages continues to host the game; a small Cloudflare Worker and one Durable Object per lobby provide the WebSocket connection and shared room state.

- A host creates a six-character lobby code and copies the generated invite link.
- Everyone readies up before the host starts the five-floor run.
- The server owns each build deadline. Maze snapshots are stored privately for reconnects and are never included in another player's build-phase messages.
- A player may lock in early, but sees only readiness—not any opposing maze—until everyone submits or the deadline expires.
- The server reveals every maze together. During the race and from **Review mazes** on the result screen, players can switch among all submitted mazes.
- Augment choices and the next floor wait for the whole lobby. Floor 4 still proceeds directly to floor 5 without a draft.

### Deploy the lobby server

Install [Node.js](https://nodejs.org/) if needed, then from this repository run:

```powershell
cd .\online
npm install
npx wrangler login
npm run deploy
```

The deployed game defaults to `https://mazing-contest-lobbies.mazingcontest.workers.dev`. Players can select **Play online** and create or join a room without configuring a server address. The editable server field is retained for local development and alternate deployments, and invite links automatically include the selected address.

Before a public deployment, set `ALLOWED_ORIGINS` in `online/wrangler.jsonc` to the origins allowed to open lobby sockets, separated by commas. Use only the origin—not the repository path—for GitHub Pages:

```json
"ALLOWED_ORIGINS": "https://YOUR-NAME.github.io,http://localhost:8000"
```

Leaving it blank permits connections from any website. For local backend development, run `npm run dev` inside `online` and enter `http://localhost:8787` as the lobby server URL.

The online backend uses Cloudflare's WebSocket Hibernation API so an idle lobby connection does not require the room object to remain active continuously. Durable Objects are available on Cloudflare's Free and Paid Workers plans. See the [Durable Objects overview](https://developers.cloudflare.com/durable-objects/) and [WebSocket Hibernation guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

This remains a casual prototype: the room server validates lobby sequencing, floor identity, augment tiers, payload bounds, and score shape, but it currently trusts the browser's submitted maze state. A competitive public version should send commands and replay them through the shared game engine on the server.

## Play

On Windows, right-click `serve.ps1` and choose **Run with PowerShell**, or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

The script opens <http://localhost:8000>. It uses only built-in PowerShell/.NET components and installs nothing. Stop it with `Ctrl+C`.

Use a different port or keep the browser closed with:

```powershell
.\serve.ps1 -Port 9000 -NoBrowser
```

If you already have another static web server, serve this directory through it instead. ES modules need HTTP, so opening `index.html` directly is not supported.

## How a run works

- A run has five floors. Floor 1 is 20×15 with a 60-second build phase; each later floor grows by 2×2 cells and grants 20 more seconds, ending at 28×23 and 140 seconds.
- After floors 1 and 2, choose one of two deterministic, previously unowned **gold** augments: **Deep Pockets** (+30 starting gold), **Echoing Lament** (slow towers affect all eight adjacent tiles), **Twisted Haste** (neutral speed towers become slow towers), or **Scavenger** (crates, fences, and guard towers cost 1/3/6 less). After floor 3, choose a **radiant** augment: **Gates of Hades** (+1 portal pair), **Trap Queen** (+3 Trap Doors), **Crushing Cold** (+2 slow towers), or **Juxtaposition** (+4 slow and +4 speed towers). Every choice persists on later floors. Floor 4 leads directly into floor 5 without another draft.
- Replaying a floor restores its original seed, generated resources, owned augments, and cumulative score from before that floor, so the retried result replaces the previous attempt.
- You, your friends, and three deterministic rivals receive terrain generated from the challenge. Neutral slow towers, neutral speed towers, and Trap Doors each use the same independent count distribution: 58% none, 36% one, and 6% two. Separately, a linked two-ended portal has a 25% chance to appear before augments are applied. Portal endpoints always spawn at least three eight-direction grid squares apart.
- Vesper Quill is the expert rival. Vesper considers a small, route-focused beam of two-move plans, including cheaper piece combinations, while a hard cap of 20,000 placement previews per floor keeps the extra work bounded. The other rivals retain their lighter greedy strategies.
- The seed also chooses a **rectangle**, **diamond**, **donut**, or four-petal **flower** silhouette. Dark cells outside the silhouette—and the donut's center—are unwalkable and unbuildable.
- The seed also gives every contestant the same random budget: 80–250 gold and 0–2 Tears of the Runner.
- During each timed build phase, choose an obstacle and click the grid. Pieces snap to cells; press `R` to rotate multi-cell pieces.
- The **Demolish** tool removes one generated rock or neutral slow tower for 8 gold. Neutral speed towers, linked portals, and Trap Doors cannot be removed. Removing your own pieces still returns their full cost during the build phase.
- One Tear builds a one-cell **Tower of Lament**. When the runner enters a cardinally adjacent cell, the tower halves its speed for five seconds, then needs five seconds before it can trigger again. Slows refresh but do not stack.
- A neutral **speed tower** increases the runner's movement speed by 50% for five seconds whenever the runner enters a cardinally adjacent cell. It has no cooldown, so a later adjacent-square entry refreshes the effect. Speed and slow effects multiply, so simultaneous 1.5x and 0.5x effects produce 0.75x movement.
- A linked **portal pair** has two protected ends in random open cells. Entering either active end instantly moves the runner to its partner; that pair then deactivates for the rest of the run. Multiple pairs operate independently. The runner never seeks a portal as a shortcut—it follows the ordinary shortest route, and reroutes normally from the exit only if that route happens to enter one.
- A **Trap Door** is a protected, traversable floor object. When an ordinary shortest route crosses one, it launches the runner up to three squares in the current direction in the time of one normal square, jumping over intervening blockers. At a map edge it lands on the last valid square before the boundary, then deactivates. The runner never detours to use one.
- **Endless Feast** appears in 20% of floors as a mandatory, traversable checkpoint. The runner must complete the entrance-to-Feast leg before routing from the Feast to the portal, and displays **Insatiable Hunger** until reaching it. Its own tile is protected; you can build on the surrounding squares as long as at least one cardinal side and both route legs remain open.
- Runners use the shortest eight-direction route toward Endless Feast or the goal without considering portals or Trap Doors as shortcuts. If an effect moves a runner, it calculates a fresh ordinary shortest route from its new square. A diagonal move costs about 1.414 tiles and can round one blocked side cell, but it is forbidden when both side cells are blocked, so runners cannot squeeze between diagonally touching objects.
- A move is atomic. It is free if it overlaps terrain, leaves the board, costs too much, or seals the only entrance-to-portal route.
- Press **Release runners** when ready, or wait for the build timer to expire.
- During the race, select any contestant in the standings—or press **1–4**—to spectate their maze and runner in real time.
- All scores are derived from the locked route, not animation frame rate. After five floors, the contestant with the highest cumulative runner time wins.

## Controls

| Input | Action |
| --- | --- |
| Click | Use the selected build or demolition tool |
| Right-click | Remove your obstacle for a full refund, or an eligible generated rock/slow tower for 8 gold |
| `1`–`5` | Select a build or demolition tool |
| `R` | Rotate the selected footprint |
| `U` or `Ctrl+Z` | Undo the previous build or removal action |
| `Enter` / `Space` | Place at the keyboard cursor |
| Arrow keys | Move the keyboard cursor |
| `Delete` / `Backspace` | Remove at the keyboard cursor |

On a touch screen, tap an empty cell to place, tap one of your obstacles to remove it, or select **Demolish** and tap a generated rock or neutral slow tower. Dragging vertically over the field scrolls the page without placing.

## Project shape

- `src/game-engine.js` contains deterministic generation, reactive portal/trap routing, Tear accounting, movement-effect simulation, scoring, and rival building.
- `src/roguelike.js` defines floor growth, build timers, augment drafts, and persistent augment effects.
- `src/contest-scoring.js` contains round-count validation, cumulative score accounting, and tie-aware contest ranking.
- `src/challenge.js` normalizes challenge URLs, derives the complete round sequence, and validates shared score targets.
- `src/app.js` owns the run state, canvas renderer, input, runner animation, augment flow, and interface.
- `src/online-lobby.js` validates invite data and manages reconnecting browser WebSockets.
- `online/src/lobby-state.js` implements the testable room state machine and hidden-build/reveal rules.
- `online/src/worker.js` hosts each lobby in a hibernating Cloudflare Durable Object.
- `online/wrangler.jsonc` and `online/package.json` configure local and deployed lobby servers.
- `src/canvas-geometry.js` keeps every floor inside the framed canvas across viewport sizes and pixel densities.
- `styles.css` contains the responsive visual system.
- `tests/game-engine.test.mjs` covers pure rules and determinism.
- `tests/browser-smoke.html` runs the critical rule checks directly in a browser when Node.js is unavailable.

## Tests

With Node.js installed, run the full rule suite:

```powershell
npm test
```

Without Node.js, start the local server and open <http://localhost:8000/tests/browser-smoke.html>. It reports a visible pass/fail result using the same ES module the game loads.

Append `?seed=YOUR-SEED` to reproduce a run locally. Shareable links use `?challenge=YOUR-SEED&rounds=5`; later floor seeds and augment drafts are derived deterministically from that challenge code. If present, `pyproject.toml` is an unused scaffold artifact; Python is not required.

Equal runner times share a rank. The game rules are intentionally client-side for this prototype. A competitive online version should keep the same serializable commands, but make a server authoritative over the seed, timer, obstacle catalog, placement validation, and final score.
