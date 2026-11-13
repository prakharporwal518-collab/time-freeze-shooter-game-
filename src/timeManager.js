// ---------------------------------------------------------------------------
// timeManager.js — the heart of the game: "time only moves when you move".
//
// There are two clocks in this game:
//
//   REAL time  - what your wall clock measures. The player's own movement,
//                mouse look and the UI run on this.
//   GAME time  - real time multiplied by `scale`. Bullets, enemies, particles,
//                thrown objects and weapon cooldowns ALL run on this.
//
// Every frame the main loop does:
//
//     const gameDt = time.update(realDt, playerActivity);
//
// and then passes `gameDt` to everything in the world. Because every system
// multiplies its speeds by the same `gameDt`, slowing time down is "free":
// nobody else needs to know it is happening.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

export class TimeManager {
  constructor() {
    this.reset();
  }

  reset() {
    this.scale = 1; // current time scale (0.05 … 1)
    this.gameTime = 0; // total seconds of game time elapsed this level
    this.kickTimer = 0; // real seconds of forced full-speed time remaining
    this.forced = null; // if not null, overrides the target (used for death / level-clear slow-mo)
  }

  /**
   * Force time to run at full speed for a short moment.
   * Called when the player shoots, throws or punches — actions "cost" time.
   */
  kick(seconds = CONFIG.time.actionKick) {
    this.kickTimer = Math.max(this.kickTimer, seconds);
  }

  /**
   * @param {number} realDt   real seconds since the previous frame
   * @param {number} activity 0 = player perfectly still, 1 = moving at full speed
   * @returns {number} gameDt — how much GAME time passed this frame
   */
  update(realDt, activity) {
    const { minScale, riseRate, fallRate } = CONFIG.time;
    this.kickTimer = Math.max(0, this.kickTimer - realDt);

    // 1. Decide what the time scale SHOULD be right now.
    let target;
    if (this.forced !== null) target = this.forced;
    else if (this.kickTimer > 0) target = 1;
    else target = Math.max(minScale, Math.min(1, activity));

    // 2. Move smoothly towards it. This is a frame-rate independent lerp:
    //    `1 - exp(-rate * dt)` gives the same curve at 30 FPS and at 144 FPS,
    //    which a plain `lerp(a, b, 0.1)` would not.
    const rate = target > this.scale ? riseRate : fallRate;
    this.scale += (target - this.scale) * (1 - Math.exp(-rate * realDt));

    // 3. Convert real time into game time.
    const gameDt = realDt * this.scale;
    this.gameTime += gameDt;
    return gameDt;
  }

  /** 0 when time runs normally, 1 when it is fully frozen. Drives visuals + audio. */
  get freeze() {
    const { minScale } = CONFIG.time;
    return Math.min(1, Math.max(0, 1 - (this.scale - minScale) / (1 - minScale)));
  }
}
