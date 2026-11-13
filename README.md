# ⏳ Time Freeze

A 3D first-person shooter that runs in the browser, where **time only moves when you move**.
Stand still and the world almost stops: bullets hang in the air, enemies freeze mid-stride.
Take a step and everything lurches back to life.

Five neon, low-poly Indian night locations: a **market street**, a **metro station**, a **rooftop**,
a **chai stall** and a **wedding hall**.

Built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/). No external assets:
every model is made from boxes, cylinders and spheres in code, and every sound is synthesised
with the Web Audio API.

---

## Run it locally

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open the URL that Vite prints (normally <http://localhost:5173>). Edits to the source hot-reload.

To make the optimised production build and preview it:

```bash
npm run build
```

```bash
npm run preview
```

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` (or arrow keys) | Move — moving makes time flow |
| Mouse | Look around |
| Left click | Shoot. Unarmed: grab the item you're looking at, otherwise punch |
| Right click | Throw whatever you're holding |
| `E` | Pick up / swap for the item under the crosshair |
| `R` | Restart the level |
| `Space` / click | Skip the replay |
| `M` | Mute |
| `F3` | FPS + draw-call counter |
| `Esc` | Release the mouse (pause) |

### Rules

- **One hit kills you.** One bullet shatters an enemy.
- Bullets are real, slow, glowing projectiles — yours and theirs. You can sidestep them.
- The pistol has limited ammo. When it's empty, throw it and find another.
- Dead gunners drop their pistol. It can be caught in mid-air.
- Thrown objects (pistols, bottles, plates) **stun** enemies and knock the gun out of their hands.
- Bare hands: the first punch stuns, a second punch shatters.
- Enemy bullets can hit other enemies. Use that.
- After **LEVEL CLEAR** your run is replayed at full speed.

---

## How the time-scale system works

This is the core idea of the game, and it lives in one small file: [`src/timeManager.js`](src/timeManager.js).

There are **two clocks**:

| Clock | Used by |
| --- | --- |
| **Real time** — what a stopwatch measures | the player's movement, mouse look, UI |
| **Game time** — real time × `scale` | bullets, enemies, particles, thrown objects, weapon cooldown, animations |

Every frame the main loop ([`src/main.js`](src/main.js)) does three things in order:

```js
const activity = player.update(realDt);        // 1. player moves in REAL time, reports 0..1
const gameDt   = time.update(realDt, activity); // 2. activity -> time scale -> game time
simulate(gameDt);                               // 3. everything else advances by game time
```

**Step 1 – measure activity.** `player.update()` returns how active the player was this frame:

- walking: distance actually moved ÷ max speed (walking into a wall counts as 0)
- turning: slow looking is nearly free, a fast flick counts for up to 0.5
- shooting / throwing / punching call `time.kick()`, which forces full speed for 0.28 s

**Step 2 – turn activity into a time scale.**

```js
target = max(0.05, activity);                                   // standing still -> 0.05
scale += (target - scale) * (1 - Math.exp(-rate * realDt));     // smooth, frame-rate independent
gameDt = realDt * scale;
```

The `1 - exp(-rate * dt)` form is an exponential lerp. Unlike `lerp(a, b, 0.1)` it behaves the same
at 30 FPS and 144 FPS. Time speeds up quickly (`rate = 14`) and slows down more gently (`rate = 5`).

**Step 3 – everyone uses `gameDt`.** Enemies, bullets, particles and items never read the clock
themselves; they are just handed `gameDt`. That is why slow motion needs no special cases anywhere
else in the code: a bullet moving `speed * gameDt` simply moves 20× less when the scale is 0.05.

Feedback when time is slow: a full-screen shader adds a blue tint and vignette, the HUD shows
`TIME FROZEN`, sounds drop in pitch, and a heartbeat plays.

All the numbers are in [`src/config.js`](src/config.js) — try changing `minScale` to `0` or `0.3`.

### The replay

The replay ([`src/replay.js`](src/replay.js)) uses the same idea in reverse. While you play, a snapshot of
every position is stored 30 times per second **of game time**. Ten real seconds spent standing still
and thinking are only half a second of game time, so in the replay that pause disappears and your
careful run plays back as one continuous burst of action.

---

## Project structure

```
index.html              page + HTML for menus and HUD
src/
  main.js               entry point: renderer, bloom, game loop, game states
  config.js             all tunable numbers
  timeManager.js        the time-scale system
  input.js              keyboard, mouse, pointer lock
  player.js             movement, shooting, throwing, pickups, view-model
  enemy.js              enemy model + AI state machines (gunner, runner)
  pathfinding.js        navigation grid + A* with a binary heap
  world.js              collision: boxes, raycasts, line of sight
  bullet.js             pooled, visible projectiles
  pickups.js            pistols, bottles, plates (world items + throw physics)
  particles.js          instanced shards for shattering
  levelLoader.js        builds a level from JSON; all the prop "prefabs"
  replay.js             recorder + replay playback
  audio.js              Web Audio sound synthesis
  ui.js                 menus, HUD, banners
  style.css
  levels/
    01-market-street.json … 05-wedding-hall.json
```

Some things worth reading if you're learning:

- **A\* pathfinding** (`pathfinding.js`) — graph search with a hand-written min-heap, octile
  heuristic, no corner cutting, and path smoothing.
- **Enemy AI** (`enemy.js`) — finite state machines: `advance → aim → shoot → (cover | strafe | aim)`.
- **Collision** (`world.js`) — circle-vs-box push-out and the "slab" ray/box test.
- **Performance** — object pooling (`bullet.js`), `InstancedMesh` (`particles.js`), and merging
  static geometry by material (`mergeStatic` in `levelLoader.js`) to cut draw calls.

## Adding a level

Levels are plain JSON in [`src/levels/`](src/levels/). Every file in that folder is loaded automatically,
in file-name order. To add level 6, copy an existing file to `06-my-level.json` and edit it.

```jsonc
{
  "id": "my-level",                 // also seeds the random decoration
  "name": "My Level",
  "hindi": "मेरा स्तर",              // optional subtitle
  "size": [24, 30],                 // width (X) and depth (Z) in metres, centred on 0,0
  "theme": {
    "background": "#06030d", "fog": "#1a0a2e", "fogDensity": 0.028,
    "floor": "#17131f", "accent": "#ff2bd6",
    "wall": "#1c1230", "wallHeight": 9,
    "wallStyle": "windows",         // "windows" or "plain"
    "ceiling": 6,                   // optional: indoor level
    "stars": true, "skyline": true, // optional sky decoration
    "ambient": "#6a55a0", "ambientIntensity": 1.1
  },
  "player":  { "x": 0, "z": 12, "yaw": 0, "weapon": "pistol", "ammo": 6 },  // omit weapon to start unarmed
  "lights":  [ { "pos": [0, 4, 0], "color": "#00e5ff", "intensity": 50 } ], // max 10
  "boxes":   [ { "pos": [3, 2], "size": [4, 1.1, 0.4], "color": "#2a2630", "trim": "#ff7a00" } ],
  "props":   [ { "type": "stall", "x": -7, "z": 5, "rot": 90, "text": "चाय" } ],
  "strings": [ { "from": [-12, 0], "to": [12, 0], "y": 6 } ],               // fairy lights
  "enemies": [ { "type": "gunner", "x": 0, "z": -10 },
               { "type": "runner", "x": 4, "z": -12, "delay": 5 } ],        // delay = spawn later (seconds)
  "pickups": [ { "type": "bottle", "x": 2, "z": 3 } ]                       // pistol | bottle | plate
}
```

- `-Z` is "forward" (`yaw: 0` looks towards `-Z`). `rot` is in degrees, in steps of 90.
- Pickups without a `y` rest on whatever is below them (table, counter or floor).
- A box `pos` is `[x, z]` (on the floor) or `[x, bottomY, z]`. Add `"solid": false` for decoration,
  `"glow": true` for neon.
- Obstacles lower than ~1.2 m are cover: they block walking but can be shot over.

Prop types: `stall` (`variant: "chai"`), `crate`, `pillar`, `bench`, `table`, `sign`, `rickshaw`, `cart`,
`barricade`, `lamp`, `train`, `gate`, `vending`, `tank`, `ac`, `solar`, `dish`, `scooter`, `tree`,
`mandap`, `stage`, `chandelier`, `buffet`, `dj`. To invent a new one, add a function to `PREFABS` in
[`src/levelLoader.js`](src/levelLoader.js).

## Deploying to GitHub Pages

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds the game and publishes it.

1. On GitHub open **Settings → Pages** and set **Source** to **GitHub Actions** (one time only).
2. Merge / push to the `main` branch.
3. The **Actions** tab shows the deployment; when it finishes the game is live at
   `https://<your-username>.github.io/<repository-name>/`.

`vite.config.js` sets `base: './'` so asset paths are relative and work under that sub-folder.

## Notes

- Progress (unlocked levels) is saved in `localStorage` under `timefreeze.unlocked`.
- The game object is exposed as `window.game` — open the browser console and try `game.time.scale`
  or `game.startLevel(2)`.
- Needs a desktop browser with WebGL 2, a keyboard and a mouse.

## License

See [LICENSE](LICENSE).
