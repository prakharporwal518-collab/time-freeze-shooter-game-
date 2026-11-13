// ---------------------------------------------------------------------------
// main.js — the entry point. Creates the renderer and owns the GAME LOOP.
//
// The Game class is a "state machine". It is always in exactly one state:
//
//   menu    -> main menu, camera drifts through level 1
//   playing -> normal gameplay
//   paused  -> pointer lock was released (Esc)
//   dead    -> the player was hit; world almost frozen; R restarts
//   clear   -> all enemies dead; short slow-motion victory moment
//   replay  -> the recorded run plays back at full speed
//   win     -> every level finished
//
// Each frame, `frame()` looks at the state and updates the right things.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CONFIG } from './config.js';
import { TimeManager } from './timeManager.js';
import { Input } from './input.js';
import { AudioManager } from './audio.js';
import { UI } from './ui.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { BulletManager } from './bullet.js';
import { ItemManager, ITEM_LABEL } from './pickups.js';
import { Particles } from './particles.js';
import { NavGrid } from './pathfinding.js';
import { LEVELS, buildLevel, disposeLevel } from './levelLoader.js';
import { Recorder, ReplayPlayer } from './replay.js';

const SAVE_KEY = 'timefreeze.unlocked';

/**
 * A full-screen post-processing shader. It runs once per pixel AFTER the scene
 * is rendered and tints the image depending on how frozen time is:
 *   uFreeze 0..1 -> cool blue tint + darker corners (vignette)
 *   uDeath  0..1 -> everything drains to red
 */
const FreezeShader = {
  uniforms: {
    tDiffuse: { value: null }, // the rendered frame (filled in by the composer)
    uFreeze: { value: 0 },
    uDeath: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFreeze;
    uniform float uDeath;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114)); // perceived brightness

      // Blue tint: blend towards a cold, slightly desaturated version of the image.
      vec3 cold = mix(color.rgb, vec3(luma), 0.35) * vec3(0.72, 0.9, 1.3);
      vec3 result = mix(color.rgb, cold, 0.55 * uFreeze);

      // Vignette: darken pixels far from the centre of the screen.
      float dist = distance(vUv, vec2(0.5));
      float vignette = smoothstep(0.3, 0.8, dist);
      result *= 1.0 - vignette * (0.25 + 0.4 * uFreeze);

      // Death: fade to a red monochrome.
      result = mix(result, vec3(luma * 1.6 + 0.04, luma * 0.12, luma * 0.14), uDeath * 0.85);

      gl_FragColor = vec4(result, color.a);
    }`,
};

export class Game {
  constructor() {
    // --- renderer ---------------------------------------------------------------
    const canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    // Rendering at more than 1.5x pixel density costs a lot of GPU time for
    // little visible gain, so high-DPI screens are capped.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
    this.scene.add(this.camera); // the camera must be in the scene for the view-model (its child) to render

    // --- post-processing chain: scene -> bloom -> freeze tint -> screen ---------
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Bloom makes anything brighter than `threshold` bleed light: the neon glow.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.5);
    this.composer.addPass(this.bloom);
    this.freezePass = new ShaderPass(FreezeShader);
    this.composer.addPass(this.freezePass);
    this.composer.addPass(new OutputPass()); // tone mapping + colour space conversion

    // A single reusable light for muzzle flashes (adding/removing lights at
    // runtime forces shader recompiles, which causes stutter).
    this.flashLight = new THREE.PointLight(0xffd9a0, 0, 12, 1.8);
    this.scene.add(this.flashLight);

    // --- systems ----------------------------------------------------------------
    this.time = new TimeManager();
    this.input = new Input(canvas);
    this.audio = new AudioManager();
    this.ui = new UI((action, arg) => this.onUiAction(action, arg));
    this.particles = new Particles(this.scene);
    this.bullets = new BulletManager(this);
    this.items = new ItemManager(this);
    this.player = new Player(this);
    this.recorder = new Recorder(this);
    this.replayPlayer = null;

    this.levels = LEVELS;
    this.levelIndex = 0;
    this.levelRoot = null;
    this.world = null;
    this.nav = null;
    this.enemies = [];
    this.state = 'menu';
    this.clearTimer = 0;
    this.deathFade = 0;
    this.menuTime = 0;
    this.unlocked = this.loadProgress();

    this.bindEvents();
    this.resize();
    this.showMenu();

    // --- start the loop -----------------------------------------------------------
    this.lastFrame = performance.now();
    this.fps = { frames: 0, time: 0, value: 0, el: null };
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  // === saving ======================================================================

  loadProgress() {
    try {
      const n = parseInt(localStorage.getItem(SAVE_KEY), 10);
      return Number.isFinite(n) ? Math.max(1, Math.min(this.levels.length, n)) : 1;
    } catch {
      return 1; // localStorage can be blocked (private mode); the game still works
    }
  }

  saveProgress() {
    try {
      localStorage.setItem(SAVE_KEY, String(this.unlocked));
    } catch { /* ignore */ }
  }

  // === events =======================================================================

  bindEvents() {
    window.addEventListener('resize', () => this.resize());

    this.input.on('fire', () => { if (this.state === 'playing' || this.state === 'clear') this.player.primary(); });
    this.input.on('throw', () => { if (this.state === 'playing' || this.state === 'clear') this.player.throwHeld(); });
    this.input.on('interact', () => { if (this.state === 'playing' || this.state === 'clear') this.player.tryPickup(); });
    this.input.on('restart', () => {
      if (this.state === 'playing' || this.state === 'dead') this.startLevel(this.levelIndex);
    });
    this.input.on('mute', () => this.ui.hint(this.audio.toggleMute() ? 'SOUND OFF' : 'SOUND ON', 1));

    // Skip the replay with Space / Enter / a click.
    this.input.on('key', (code) => {
      if (this.state === 'replay' && (code === 'Space' || code === 'Enter')) this.endReplay();
      if (code === 'F3') this.toggleFps();
    });
    this.input.on('anyclick', () => { if (this.state === 'replay') this.endReplay(); });

    // Esc releases the pointer -> pause. Getting it back -> resume.
    this.input.on('lockchange', (locked) => {
      if (!locked && this.state === 'playing') {
        this.state = 'paused';
        this.ui.showScreen('pause');
      } else if (locked && this.state === 'paused') {
        this.state = 'playing';
        this.ui.showScreen(null);
      }
    });
  }

  onUiAction(action, arg) {
    this.audio.init(); // audio may only start after a user gesture; any button click counts
    this.audio.uiClick();
    switch (action) {
      case 'start': this.input.lock(); this.startLevel(0); break;
      case 'play': this.input.lock(); this.startLevel(parseInt(arg, 10)); break;
      case 'levels':
        this.ui.buildLevelSelect(this.levels, this.unlocked);
        this.ui.showScreen('levels');
        break;
      case 'controls': this.ui.showScreen('controls'); break;
      case 'back': this.ui.showScreen('menu'); break;
      case 'resume': this.input.lock(); break; // the lockchange handler un-pauses
      case 'restart': this.input.lock(); this.startLevel(this.levelIndex); break;
      case 'menu': this.showMenu(); break;
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // === level management ===============================================================

  /** Remove every dynamic object (enemies, bullets, items, particles, replay puppets). */
  clearDynamic() {
    for (const e of this.enemies) e.dispose();
    this.enemies = [];
    this.bullets.clear();
    this.items.clear();
    this.particles.clear();
    if (this.replayPlayer) { this.replayPlayer.dispose(); this.replayPlayer = null; }
    this.recorder.stop();
    this.flashLight.intensity = 0;
  }

  /** Build the static geometry + collision + nav grid for a level. */
  loadLevel(index) {
    if (this.levelRoot) {
      this.scene.remove(this.levelRoot);
      disposeLevel(this.levelRoot);
    }
    const def = this.levels[index];
    const { root, world } = buildLevel(def);
    this.levelRoot = root;
    this.world = world;
    this.scene.add(root);
    this.nav = new NavGrid(world);
    this.levelIndex = index;

    const theme = def.theme || {};
    this.scene.background = new THREE.Color(theme.background || '#05030a');
    this.scene.fog = new THREE.FogExp2(theme.fog || '#120a26', theme.fogDensity ?? 0.02);
  }

  showMenu() {
    this.input.unlock();
    this.clearDynamic();
    this.loadLevel(0);
    this.state = 'menu';
    this.time.reset();
    this.deathFade = 0;
    this.player.viewmodel.visible = false;
    this.ui.setHudVisible(false);
    this.ui.setReplayVisible(false);
    this.ui.hideBanner();
    this.ui.showScreen('menu');
  }

  startLevel(index) {
    this.clearDynamic();
    this.loadLevel(index);
    const def = this.levels[index];

    this.time.reset();
    this.deathFade = 0;
    this.player.reset(def.player);
    this.player.viewmodel.visible = true;

    let nextId = 1;
    this.enemies = (def.enemies || []).map((spec) => new Enemy(this, spec, nextId++));

    for (const p of def.pickups || []) {
      // No "y" in the JSON? Rest on whatever is underneath (table, counter, floor).
      const y = p.y ?? this.world.groundHeight(p.x, p.z, 2.0);
      this.items.spawn(p.type, new THREE.Vector3(p.x, y, p.z), { ammo: p.ammo });
    }

    this.recorder.begin();
    this.state = 'playing';
    this.ui.showScreen(null);
    this.ui.setReplayVisible(false);
    this.ui.setHudVisible(true);
    this.ui.showBanner(`LEVEL ${index + 1}`, def.name.toUpperCase(), 2.2, def.hindi || '');
  }

  // === gameplay callbacks ===============================================================

  /**
   * Play a one-off effect AND remember it for the replay.
   * Gameplay code always calls fx(); the replay calls playFx() directly.
   * `data` must be plain values (arrays/numbers/strings) so it can be stored.
   */
  fx(type, data) {
    this.recorder.event(type, data);
    this.playFx(type, data);
  }

  playFx(type, d) {
    const p = d.pos;
    switch (type) {
      case 'shot':
        this.audio.gunshot(d.owner === 'player');
        this.flashLight.position.set(p[0], p[1], p[2]);
        this.flashLight.color.set(d.owner === 'player' ? 0xbfe9ff : 0xffb070);
        this.flashLight.intensity = 60;
        this.particles.burst(p[0], p[1], p[2], { count: 5, color: 0xfff0b0, speed: 3, size: 0.03, life: 0.25, gravity: 0.2 });
        break;
      case 'shatter':
        // Shards fill the volume of the body and fly along the bullet's direction.
        this.particles.burst(p[0], p[1], p[2], { count: 60, color: 0xff2030, speed: 4.5, dir: d.dir, push: 5, size: 0.11, life: 3.5, spreadXZ: 0.5, spreadY: 1.7 });
        this.audio.shatter();
        break;
      case 'glass':
        this.particles.burst(p[0], p[1], p[2], { count: 18, color: d.kind === 'plate' ? 0xdfe6f2 : 0x35e09a, speed: 3.5, size: 0.045, life: 1.8 });
        this.audio.glass();
        break;
      case 'spark':
        this.particles.burst(p[0], p[1], p[2], { count: 6, color: d.owner === 'player' ? 0x9feaff : 0xffb060, speed: 2.5, size: 0.03, life: 0.5 });
        break;
      case 'spawn':
        this.particles.burst(p[0], p[1], p[2], { count: 24, color: 0xff2030, speed: 2.5, size: 0.05, life: 0.8, spreadY: 1.6, gravity: -0.3 });
        this.audio.spawn();
        break;
      case 'stun':
        this.particles.burst(p[0], p[1], p[2], { count: 10, color: 0xffe08a, speed: 2.5, size: 0.04, life: 0.6 });
        this.audio.punch();
        break;
      case 'throw': this.audio.whoosh(); break;
      case 'punch': this.audio.whoosh(); break;
      case 'pickup': this.audio.pickup(); break;
      case 'death': this.audio.death(); break;
    }
  }

  onEnemyKilled() {
    if (this.state === 'playing' && this.enemies.every((e) => e.dead)) this.beginClear();
  }

  /** One hit kills. */
  killPlayer() {
    if (this.state !== 'playing' || !this.player.alive) return;
    this.player.alive = false;
    this.state = 'dead';
    this.time.forced = 0.02; // the world keeps creeping forward in ultra slow motion
    this.fx('death', {});
    this.recorder.stop();
    this.updateHud();
    this.ui.setPrompt('');
    this.ui.hideBanner();
    this.ui.showScreen('death');
  }

  beginClear() {
    this.state = 'clear';
    this.clearTimer = 2.6;
    this.time.forced = 0.25; // dramatic slow motion while the last enemy shatters
    this.audio.levelClear();
    this.updateHud(); // show "ENEMIES 0"
    this.ui.setPrompt('');
    this.ui.showBanner('LEVEL CLEAR', '', 0, 'स्तर पूरा');
    // Unlock the next level and remember it.
    const next = Math.min(this.levels.length, this.levelIndex + 2);
    if (next > this.unlocked) {
      this.unlocked = next;
      this.saveProgress();
    }
  }

  startReplay() {
    this.recorder.stop();
    // Remove the real entities; the replay uses its own puppets.
    for (const e of this.enemies) e.dispose();
    this.enemies = [];
    this.bullets.clear();
    this.items.clear();
    this.particles.clear();
    this.time.reset();

    this.replayPlayer = new ReplayPlayer(this, this.recorder);
    this.state = 'replay';
    this.ui.hideBanner();
    this.ui.setHudVisible(false);
    this.ui.setReplayVisible(true);
  }

  endReplay() {
    if (this.state !== 'replay') return;
    this.ui.setReplayVisible(false);
    if (this.levelIndex + 1 < this.levels.length) {
      this.startLevel(this.levelIndex + 1);
      // If the mouse was released during the replay, wait on the pause screen.
      if (!this.input.active) {
        this.state = 'paused';
        this.ui.showScreen('pause');
      }
    } else {
      this.clearDynamic();
      this.state = 'win';
      this.player.viewmodel.visible = false;
      this.input.unlock();
      this.ui.showScreen('win');
    }
  }

  // === the game loop ======================================================================

  /** Advance the simulated world by `dt` seconds of GAME time. */
  simulate(dt) {
    for (const e of this.enemies) e.update(dt);
    this.bullets.update(dt);
    this.items.update(dt);
    this.particles.update(dt);
    this.flashLight.intensity *= Math.exp(-dt * 30); // muzzle flash fades quickly
  }

  frame(now) {
    // Real seconds since the last frame. Clamped so that switching tabs (which
    // pauses requestAnimationFrame) doesn't produce one gigantic time step.
    const elapsed = (now - this.lastFrame) / 1000;
    const realDt = Math.max(0, Math.min(elapsed, 0.05));
    this.lastFrame = now;

    let freezeVisual = 0;
    let heartbeat = false;

    switch (this.state) {
      case 'playing':
      case 'clear': {
        // 1. The player moves in real time and tells us how active they were…
        const activity = this.player.update(realDt);
        // 2. …which sets the time scale and gives us this frame's game time…
        const dt = this.time.update(realDt, activity);
        // 3. …which drives everything else.
        this.player.tick(dt, realDt);
        this.simulate(dt);
        this.recorder.update();

        if (this.state === 'playing') {
          freezeVisual = this.time.freeze;
          heartbeat = true;
          this.updateHud();
        } else if (this.state === 'clear') {
          // (Check the state explicitly: simulate() may have just killed the
          //  player, in which case we are now 'dead', not 'clear'.)
          this.clearTimer -= realDt;
          if (this.clearTimer <= 0) this.startReplay();
        }
        break;
      }

      case 'dead': {
        this.player.updateCamera(realDt); // falling-over animation
        const dt = this.time.update(realDt, 0);
        this.player.tick(dt, realDt);
        this.simulate(dt);
        this.deathFade = Math.min(1, this.deathFade + realDt * 2);
        break;
      }

      case 'replay': {
        const done = this.replayPlayer.update(realDt);
        this.particles.update(realDt);
        this.flashLight.intensity *= Math.exp(-realDt * 30);
        this.ui.setReplayProgress(this.replayPlayer.progress);
        if (done) this.endReplay();
        break;
      }

      case 'menu': {
        // A slow drifting camera through the first level as a backdrop.
        this.menuTime += realDt;
        const [w, d] = this.levels[this.levelIndex].size;
        const t = this.menuTime;
        this.camera.position.set(Math.sin(t * 0.13) * w * 0.06, 3.4 + Math.sin(t * 0.2) * 0.3, d * 0.28 + Math.sin(t * 0.09) * d * 0.12);
        this.camera.lookAt(Math.sin(t * 0.07) * w * 0.2, 3.0, -d * 0.3);
        break;
      }
      // 'paused' and 'win': nothing moves, we just keep drawing the last frame.
    }

    // Visual + audio feedback for the time scale.
    const u = this.freezePass.uniforms;
    u.uFreeze.value += (freezeVisual - u.uFreeze.value) * Math.min(1, realDt * 8);
    u.uDeath.value = this.deathFade;
    this.ui.setFreeze(this.state === 'playing' ? this.time.freeze : 0);
    this.audio.update(realDt, this.state === 'replay' ? 1 : this.time.scale, freezeVisual, heartbeat);

    this.composer.render();
    this.updateFps(elapsed);
  }

  updateHud() {
    const p = this.player;
    const def = this.levels[this.levelIndex];
    this.ui.setHud({
      level: this.levelIndex + 1,
      name: def.name,
      enemies: this.enemies.reduce((n, e) => n + (e.dead ? 0 : 1), 0),
      ammo: p.ammoText(),
      ammoLabel: p.held && p.held.type === 'pistol' ? 'AMMO' : p.held ? 'CLICK TO THROW' : 'PUNCH / GRAB',
      empty: !!p.held && p.held.type === 'pistol' && p.held.ammo === 0,
    });

    // "Pick up" prompt for the item under the crosshair.
    const target = this.items.findTarget(this.camera.position, p.getForward());
    if (target) {
      const extra = target.type === 'pistol' ? ` · ${target.ammo}` : '';
      this.ui.setPrompt(`[${p.held ? 'E' : 'E / CLICK'}] ${p.held ? 'SWAP FOR' : 'GRAB'} ${ITEM_LABEL[target.type]}${extra}`);
    } else {
      this.ui.setPrompt('');
    }
  }

  // === FPS counter (press F3) =================================================================

  toggleFps() {
    if (this.fps.el) {
      this.fps.el.remove();
      this.fps.el = null;
      return;
    }
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px monospace;color:#7dff5a;background:#000a;padding:3px 6px;z-index:9';
    document.body.append(el);
    this.fps.el = el;
  }

  updateFps(elapsed) {
    const f = this.fps;
    f.frames++;
    f.time += elapsed; // un-clamped, so the number is honest
    if (f.time >= 0.5) {
      f.value = Math.round(f.frames / f.time);
      f.frames = 0;
      f.time = 0;
      if (f.el) {
        const info = this.renderer.info.render;
        f.el.textContent = `${f.value} FPS · ${info.calls} draw calls · time x${this.time.scale.toFixed(2)}`;
      }
    }
  }
}

// Start the game. It is also exposed on `window` so you can poke at it from
// the browser console (try: game.time.scale, game.enemies, game.startLevel(2)).
window.game = new Game();
