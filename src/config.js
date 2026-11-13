// ---------------------------------------------------------------------------
// config.js — every "magic number" that controls how the game feels.
// Keeping them in one place makes the game easy to tune: change a value here,
// save, and Vite hot-reloads the page.
// ---------------------------------------------------------------------------

export const CONFIG = {
  time: {
    minScale: 0.05, // time scale while the player stands perfectly still
    riseRate: 14, // how quickly time speeds UP when you start moving (higher = snappier)
    fallRate: 5, // how quickly time slows DOWN when you stop
    actionKick: 0.28, // seconds of forced full-speed time after shooting / throwing
  },

  player: {
    speed: 5.2, // metres per second
    radius: 0.35, // collision circle radius
    eyeHeight: 1.6,
    mouseSensitivity: 0.0022, // radians per pixel of mouse movement
    pickupRange: 3.6,
    punchRange: 2.1,
  },

  pistol: {
    ammo: 6,
    cooldown: 0.4, // seconds of GAME time between shots
    bulletSpeed: 30,
    droppedAmmo: 4, // ammo left in a gun dropped by a dead gunner
  },

  enemy: {
    radius: 0.38,
    gunnerSpeed: 2.6,
    runnerSpeed: 4.3,
    bulletSpeed: 13, // slow enough that you can watch it come and step aside
    sightRange: 18,
    aimTime: 0.6, // wind-up before a gunner fires
    meleeRange: 1.5,
    stunTime: 2.5,
    dodgeChance: 0.5,
  },

  nav: {
    cellSize: 0.5, // size of one pathfinding grid cell in metres
    agentRadius: 0.45, // obstacles are "fattened" by this much so paths keep clear of walls
  },

  replay: {
    sampleRate: 30, // snapshots per second of GAME time
    maxSeconds: 75, // only the last N seconds of a run are replayed
  },
};
