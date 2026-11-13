// ---------------------------------------------------------------------------
// replay.js — record a run, then play it back at full real-time speed.
//
// While you play, time keeps slowing down and speeding up. The trick that
// makes the replay look so different is simple: we record snapshots against
// GAME time, not real time. Ten real seconds of you standing still thinking is
// only half a second of game time, so in the replay that pause vanishes and
// you look like an action hero who never hesitated.
//
// RECORDING  - every 1/30 s of game time, store where everything is.
//              Also log one-off events (shots, shatters…) with a timestamp.
// PLAYBACK   - advance a clock in REAL time, find the two snapshots around
//              it, and interpolate (blend) between them. Puppet meshes are
//              moved to the blended positions; events are re-fired for
//              particles and sound.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createEnemyModel } from './enemy.js';
import { createBulletMesh } from './bullet.js';
import { createItemMesh, ITEM_TYPES } from './pickups.js';

export class Recorder {
  /** @param {import('./main.js').Game} game */
  constructor(game) {
    this.game = game;
    this.active = false;
    this.frames = [];
    this.events = [];
    this.enemyTypes = new Map(); // enemy id -> 'gunner' | 'runner'
    this.lastSample = -Infinity;
  }

  begin() {
    this.frames = [];
    this.events = [];
    this.enemyTypes = new Map();
    this.lastSample = -Infinity;
    this.active = true;
    for (const e of this.game.enemies) this.enemyTypes.set(e.id, e.type);
  }

  stop() {
    this.active = false;
  }

  /** Log a one-off effect so the replay can re-create it. */
  event(type, data) {
    if (this.active) this.events.push({ t: this.game.time.gameTime, type, data });
  }

  /** Call every frame; takes a snapshot when enough GAME time has passed. */
  update() {
    if (!this.active) return;
    const game = this.game;
    const t = game.time.gameTime;
    if (t - this.lastSample < 1 / CONFIG.replay.sampleRate) return;
    this.lastSample = t;

    const p = game.player;
    // Snapshots are plain arrays of numbers: compact and quick to copy.
    const frame = {
      t,
      player: [p.camera.position.x, p.camera.position.y, p.camera.position.z, p.yaw, p.pitch, p.recoil, p.punchAnim],
      held: p.held ? p.held.type : null,
      enemies: [],
      bullets: [],
      items: [],
    };
    for (const e of game.enemies) {
      if (!e.targetable) continue;
      const s = e.pose;
      frame.enemies.push([e.id, e.pos.x, e.pos.z, e.yaw, s.walk, s.aim, s.stun, s.strike, s.gun, s.scale]);
    }
    for (const b of game.bullets.active) {
      frame.bullets.push([b.id, b.owner === 'player' ? 0 : 1, b.pos.x, b.pos.y, b.pos.z, b.dir.x, b.dir.y, b.dir.z]);
    }
    for (const it of game.items.items) {
      const q = it.mesh.quaternion;
      frame.items.push([it.id, ITEM_TYPES.indexOf(it.type), it.pos.x, it.pos.y, it.pos.z, q.x, q.y, q.z, q.w]);
    }
    this.frames.push(frame);
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
/** Interpolate an angle the short way round (so 350° -> 10° doesn't spin backwards). */
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
/** Find the entry with a given id (entries are arrays whose first element is the id). */
function findById(list, id) {
  for (const entry of list) if (entry[0] === id) return entry;
  return null;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _target = new THREE.Vector3();
const _pose = { walk: 0, aim: 0, stun: 0, strike: 0, gun: 0, scale: 1 };

export class ReplayPlayer {
  /**
   * @param {import('./main.js').Game} game
   * @param {Recorder} rec a finished recording
   */
  constructor(game, rec) {
    this.game = game;
    this.frames = rec.frames;
    this.events = rec.events;
    this.enemyTypes = rec.enemyTypes;

    this.endTime = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    // Very long runs: only show the final stretch.
    this.startTime = Math.max(this.frames.length ? this.frames[0].t : 0, this.endTime - CONFIG.replay.maxSeconds);
    this.t = this.startTime;
    this.frameIndex = 0;
    this.eventIndex = 0;
    while (this.eventIndex < this.events.length && this.events[this.eventIndex].t < this.startTime) this.eventIndex++;

    // Puppets: stand-in meshes moved around by the recorded data. Created on
    // demand and kept in maps keyed by the original entity id.
    this.root = new THREE.Group();
    game.scene.add(this.root);
    this.enemyPuppets = new Map();
    this.bulletPuppets = new Map();
    this.itemPuppets = new Map();
  }

  get progress() {
    const span = this.endTime - this.startTime;
    return span > 0 ? Math.min(1, (this.t - this.startTime) / span) : 1;
  }

  /**
   * @param {number} realDt real seconds — the replay always runs at full speed
   * @returns {boolean} true when the replay has finished
   */
  update(realDt) {
    const frames = this.frames;
    if (frames.length < 2) return true;
    this.t += realDt;
    const t = Math.min(this.t, this.endTime);

    // Advance to the pair of snapshots that surround time t.
    while (this.frameIndex < frames.length - 2 && frames[this.frameIndex + 1].t <= t) this.frameIndex++;
    const a = frames[this.frameIndex];
    const b = frames[this.frameIndex + 1];
    const k = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t)));

    // --- camera: the player's eyes ---
    const cam = this.game.camera;
    const pa = a.player, pb = b.player;
    cam.position.set(lerp(pa[0], pb[0], k), lerp(pa[1], pb[1], k), lerp(pa[2], pb[2], k));
    cam.rotation.set(lerp(pa[4], pb[4], k), lerpAngle(pa[3], pb[3], k), 0, 'YXZ');
    const player = this.game.player;
    player.showHeld(a.held);
    player.recoil = lerp(pa[5], pb[5], k);
    player.punchAnim = lerp(pa[6], pb[6], k);
    player.raise = 0;
    player.animateViewmodel();

    // --- enemies ---
    this.syncPuppets(this.enemyPuppets, a.enemies, (entry) => createEnemyModel(this.enemyTypes.get(entry[0]) || 'gunner'),
      (puppet, ea) => {
        const eb = findById(b.enemies, ea[0]) || ea; // gone in the next frame? hold the last pose
        puppet.group.position.set(lerp(ea[1], eb[1], k), 0, lerp(ea[2], eb[2], k));
        puppet.group.rotation.y = lerpAngle(ea[3], eb[3], k);
        _pose.walk = lerp(ea[4], eb[4], k);
        _pose.aim = lerp(ea[5], eb[5], k);
        _pose.stun = lerp(ea[6], eb[6], k);
        _pose.strike = lerp(ea[7], eb[7], k);
        _pose.gun = ea[8];
        _pose.scale = lerp(ea[9], eb[9], k);
        puppet.setPose(_pose);
      });

    // --- bullets ---
    this.syncPuppets(this.bulletPuppets, a.bullets, (entry) => ({ group: createBulletMesh(entry[1] === 0 ? 'player' : 'enemy') }),
      (puppet, ba) => {
        const bb = findById(b.bullets, ba[0]) || ba;
        puppet.group.position.set(lerp(ba[2], bb[2], k), lerp(ba[3], bb[3], k), lerp(ba[4], bb[4], k));
        puppet.group.lookAt(_target.set(ba[5], ba[6], ba[7]).add(puppet.group.position));
      });

    // --- items ---
    this.syncPuppets(this.itemPuppets, a.items, (entry) => {
      const mesh = createItemMesh(ITEM_TYPES[entry[1]]);
      mesh.scale.setScalar(1.35);
      return { group: mesh };
    }, (puppet, ia) => {
      const ib = findById(b.items, ia[0]) || ia;
      puppet.group.position.set(lerp(ia[2], ib[2], k), lerp(ia[3], ib[3], k), lerp(ia[4], ib[4], k));
      _qa.set(ia[5], ia[6], ia[7], ia[8]);
      _qb.set(ib[5], ib[6], ib[7], ib[8]);
      puppet.group.quaternion.copy(_qa).slerp(_qb, k);
    });

    // --- one-off events (sound + particles) that are now due ---
    while (this.eventIndex < this.events.length && this.events[this.eventIndex].t <= t) {
      const ev = this.events[this.eventIndex++];
      this.game.playFx(ev.type, ev.data);
    }

    // Linger for a moment on the last frame before finishing.
    return this.t > this.endTime + 1.2;
  }

  /**
   * Make the set of visible puppets match the entries in a snapshot:
   * create missing ones, pose the present ones, hide the rest.
   */
  syncPuppets(map, entries, create, apply) {
    for (const puppet of map.values()) puppet.seen = false;
    for (const entry of entries) {
      let puppet = map.get(entry[0]);
      if (!puppet) {
        puppet = create(entry);
        this.root.add(puppet.group);
        map.set(entry[0], puppet);
      }
      puppet.seen = true;
      puppet.group.visible = true;
      apply(puppet, entry);
    }
    for (const puppet of map.values()) if (!puppet.seen) puppet.group.visible = false;
  }

  dispose() {
    this.game.scene.remove(this.root);
  }
}
