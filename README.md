# Mazing Contest

A local browser prototype inspired by the maze-building contest format: every contestant receives the same seeded field, spends the same budget on grid-snapped obstacles, and tries to force their runner along the longest legal route.

## Share with friends

Publish this folder on any static HTTPS host, then use **Invite friends**. The copied challenge URL locks the contest length and derives every round from one challenge code, so everyone receives the same maps, resources, and AI opponents. After the final round, **Copy my score challenge** embeds your cumulative time as the target your friends must beat.

No game server or account is required. This is an asynchronous, casual challenge: friends play independently and score targets in URLs are not cheat-proof. A `localhost` URL only works on the computer running it, so the folder must be published before that link can be sent over the internet.

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

## How a contest works

- Choose a contest length from 1–20 rounds before starting. Every contestant's verified runner time is banked after each round.
- You, your friends, and three deterministic rivals receive identical terrain generated from the challenge. A field has a 58% chance of no neutral slow tower, 36% of one, and 6% of two. Separately, it has a 25% chance of one neutral speed tower.
- Vesper Quill is the expert rival. Vesper considers a small, route-focused beam of two-move plans, including cheaper piece combinations, while a hard cap of 20,000 placement previews per round keeps the extra work bounded. The other rivals retain their lighter greedy strategies.
- The seed also chooses a **rectangle**, **diamond**, **donut**, or four-petal **flower** silhouette. Dark cells outside the silhouette—and the donut's center—are unwalkable and unbuildable.
- The seed also gives every contestant the same random budget: 80–250 gold and 0–2 Tears of the Runner.
- During the 60-second build phase, choose an obstacle and click the grid. Pieces snap to cells; press `R` to rotate multi-cell pieces.
- The **Demolish** tool removes one generated rock or neutral tower for 8 gold. Removing your own pieces still returns their full cost during the build phase.
- One Tear builds a one-cell **Tower of Lament**. When the runner enters a cardinally adjacent cell, the tower halves its speed for five seconds, then needs five seconds before it can trigger again. Slows refresh but do not stack.
- A neutral **speed tower** doubles the runner's movement speed for five seconds whenever the runner enters a cardinally adjacent cell. It has no cooldown, so a later adjacent-square entry refreshes the effect. Speed and slow effects multiply; when both are active, their 2x and 0.5x modifiers cancel out.
- **Endless Feast** appears in 20% of rounds as a mandatory, traversable checkpoint. The runner must complete the entrance-to-Feast leg before routing from the Feast to the portal, and displays **Insatiable Hunger** until reaching it. Its own tile is protected; you can build on the surrounding squares as long as at least one cardinal side and both route legs remain open.
- Runners use the shortest eight-direction route. A diagonal move costs about 1.414 tiles and can round one blocked side cell, but it is forbidden when both side cells are blocked, so runners cannot squeeze between diagonally touching objects.
- A move is atomic. It is free if it overlaps terrain, leaves the board, costs too much, or seals the only entrance-to-portal route.
- Press **Release runners** when ready, or wait for the build timer to expire.
- During the race, select any contestant in the standings—or press **1–4**—to spectate their maze and runner in real time.
- All scores are derived from the locked route, not animation frame rate. After the selected number of rounds, the contestant with the highest cumulative runner time wins.

## Controls

| Input | Action |
| --- | --- |
| Click | Use the selected build or demolition tool |
| Right-click | Remove your obstacle for a full refund, or a generated object for 8 gold |
| `1`–`5` | Select a build or demolition tool |
| `R` | Rotate the selected footprint |
| `U` or `Ctrl+Z` | Undo the previous build or removal action |
| `Enter` / `Space` | Place at the keyboard cursor |
| Arrow keys | Move the keyboard cursor |
| `Delete` / `Backspace` | Remove at the keyboard cursor |

On a touch screen, tap an empty cell to place, tap one of your obstacles to remove it, or select **Demolish** and tap a generated object. Dragging vertically over the field scrolls the page without placing.

## Project shape

- `src/game-engine.js` contains deterministic generation, weighted diagonal pathfinding, Tear accounting, speed/slow simulation, scoring, and rival building.
- `src/contest-scoring.js` contains round-count validation, cumulative score accounting, and tie-aware contest ranking.
- `src/challenge.js` normalizes challenge URLs, derives the complete round sequence, and validates shared score targets.
- `src/app.js` owns the round state, canvas renderer, input, runner animation, and interface.
- `styles.css` contains the responsive visual system.
- `tests/game-engine.test.mjs` covers pure rules and determinism.
- `tests/browser-smoke.html` runs the critical rule checks directly in a browser when Node.js is unavailable.

## Tests

With Node.js installed, run the full rule suite:

```powershell
npm test
```

Without Node.js, start the local server and open <http://localhost:8000/tests/browser-smoke.html>. It reports a visible pass/fail result using the same ES module the game loads.

Append `?seed=YOUR-SEED` to reproduce a contest locally. Shareable links use `?challenge=YOUR-SEED&rounds=3`; later round seeds are derived deterministically from that challenge code. If present, `pyproject.toml` is an unused scaffold artifact; Python is not required.

Equal runner times share a rank. The game rules are intentionally client-side for this prototype. A competitive online version should keep the same serializable commands, but make a server authoritative over the seed, timer, obstacle catalog, placement validation, and final score.
