// ---------------------------------------------------------------------------
// enemy.js — red low-poly humanoids and their AI.
//
// Two enemy types:
//   'gunner' - keeps its distance, aims, fires slow bullets, sometimes runs to
//              cover or side-steps.
//   'runner' - sprints at you and kills with a punch. Zig-zags when aimed at.
//
// The AI is a small "finite state machine": at any moment an enemy is in one
// mode (advance / aim / move / hide / windup / recover) and each mode has
// simple rules for what to do and when to switch to another mode.
//
// The MODEL (what you see) is separate from the BRAIN (the Enemy class) so
// that the replay system can re-use the model as a puppet.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from './config.js';

// --- model -------------------------------------------------------------------

const RED = new THREE.MeshLambertMaterial({ color: 0xff2030, emissive: 0xff0a1e, emissiveIntensity: 0.75, flatShading: true });
const CRIMSON = new THREE.MeshLambertMaterial({ color: 0xff3a10, emissive: 0xff2a00, emissiveIntensity: 0.75, flatShading: true });
const GUN_MAT = new THREE.MeshLambertMaterial({ color: 0x1a1d24, emissive: 0x05161c, flatShading: true });

const GEO = {
  torso: new THREE.CylinderGeometry(0.3, 0.19, 0.62, 5),
  hips: new THREE.BoxGeometry(0.34, 0.16, 0.2),
  head: new THREE.IcosahedronGeometry(0.17, 0),
  spikeHead: new THREE.OctahedronGeometry(0.2, 0),
  // Limbs are shifted down so that their ORIGIN is at the joint (hip/shoulder).
  // Rotating the mesh then swings the limb like a real arm or leg.
  leg: new THREE.BoxGeometry(0.17, 0.85, 0.17).translate(0, -0.425, 0),
  arm: new THREE.BoxGeometry(0.12, 0.62, 0.12).translate(0, -0.31, 0),
  gun: new THREE.BoxGeometry(0.06, 0.1, 0.3),
};

/**
 * Build an enemy model. Returns { group, setPose }.
 * The model faces -Z, the same "forward" a Three.js camera uses.
 */
export function createEnemyModel(type) {
  const mat = type === 'runner' ? CRIMSON : RED;
  const group = new THREE.Group();
  const body = new THREE.Group(); // everything above the feet; leans when stunned
  group.add(body);

  const torso = new THREE.Mesh(GEO.torso, mat);
  torso.position.y = 1.2;
  const hips = new THREE.Mesh(GEO.hips, mat);
  hips.position.y = 0.87;
  const head = new THREE.Mesh(type === 'runner' ? GEO.spikeHead : GEO.head, mat);
  head.position.y = 1.7;

  const legL = new THREE.Mesh(GEO.leg, mat);
  legL.position.set(-0.11, 0.85, 0);
  const legR = new THREE.Mesh(GEO.leg, mat);
  legR.position.set(0.11, 0.85, 0);
  const armL = new THREE.Mesh(GEO.arm, mat);
  armL.position.set(-0.37, 1.46, 0);
  const armR = new THREE.Mesh(GEO.arm, mat);
  armR.position.set(0.37, 1.46, 0);

  const gun = new THREE.Mesh(GEO.gun, GUN_MAT);
  gun.position.set(0, -0.66, -0.08); // in the right hand
  gun.rotation.x = Math.PI / 2;
  armR.add(gun);

  body.add(torso, hips, head, legL, legR, armL, armR);

  /**
   * Pose the model from a handful of numbers. Because the pose is a PURE
   * function of these values, recording just these numbers is enough for the
   * replay to reproduce the animation exactly.
   */
  function setPose(p) {
    const swing = Math.sin(p.walk) * 0.75;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    // Rotating an arm by +90 degrees around X points it straight forward.
    armL.rotation.x = -swing * 0.7 + p.strike * 2.2;
    armR.rotation.x = swing * 0.7 * (1 - p.aim) + p.aim * (Math.PI / 2) + p.strike * 2.2;
    armL.rotation.z = -p.stun * 2.4;
    armR.rotation.z = p.stun * 2.4;
    body.rotation.x = p.stun * 0.35 - p.strike * 0.25; // lean back when stunned, forward when striking
    head.rotation.y = p.walk * 0.1;
    gun.visible = p.gun > 0.5;
    group.scale.setScalar(Math.max(0.001, p.scale));
  }

  return { group, setPose };
}

// --- brain -------------------------------------------------------------------

const _v = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();

/** Shortest signed difference between two angles (handles the wrap at ±PI). */
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Enemy {
  /**
   * @param {import('./main.js').Game} game
   * @param {{type:string,x:number,z:number,delay?:number}} spec from the level JSON
   * @param {number} id
   */
  constructor(game, spec, id) {
    this.game = game;
    this.id = id;
    this.type = spec.type === 'runner' ? 'runner' : 'gunner';
    this.pos = new THREE.Vector3(spec.x, 0, spec.z);
    this.yaw = 0;
    this.dead = false;
    this.hasGun = this.type === 'gunner';

    // Enemies with a delay "arrive" later, which creates waves.
    this.spawnDelay = spec.delay || 0;
    this.spawned = false;

    this.mode = this.hasGun ? 'advance' : 'chase';
    this.timer = 0; // general purpose countdown for the current mode
    this.waitAfterMove = 0; // >0 means "hide for this long after arriving"
    this.stunTimer = 0;
    this.dodgeCooldown = 1 + Math.random();
    this.repathTimer = Math.random() * 0.3; // staggered so not everyone searches on the same frame
    this.path = null;
    this.pathIndex = 0;

    // Everything the model needs to draw itself (also what the replay records).
    this.pose = { walk: Math.random() * 6, aim: 0, stun: 0, strike: 0, gun: this.hasGun ? 1 : 0, scale: 0 };

    this.model = createEnemyModel(this.type);
    this.model.group.visible = false;
    game.scene.add(this.model.group);

    // Start out facing the player.
    this.yaw = Math.atan2(-(game.player.pos.x - this.pos.x), -(game.player.pos.z - this.pos.z));
    if (this.spawnDelay <= 0) this.spawn(false);
    this.sync();
  }

  /** Can bullets / thrown objects / punches hit this enemy right now? */
  get targetable() {
    return this.spawned && !this.dead;
  }

  spawn(withEffect = true) {
    this.spawned = true;
    this.model.group.visible = true;
    if (withEffect) this.game.fx('spawn', { pos: [this.pos.x, 1, this.pos.z] });
    else this.pose.scale = 1;
  }

  // --- main update -------------------------------------------------------------

  /** @param {number} dt GAME time */
  update(dt) {
    if (this.dead) return;
    const game = this.game;
    const player = game.player;

    if (!this.spawned) {
      this.spawnDelay -= dt;
      if (this.spawnDelay <= 0) this.spawn();
      return;
    }
    // Grow-in animation after spawning.
    if (this.pose.scale < 1) this.pose.scale = Math.min(1, this.pose.scale + dt * 3);

    this.dodgeCooldown -= dt;
    this.repathTimer -= dt;

    const dx = player.pos.x - this.pos.x;
    const dz = player.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const yawToPlayer = Math.atan2(-dx, -dz);
    const canSee = game.world.lineOfSight(this.pos.x, 1.5, this.pos.z, player.pos.x, 1.5, player.pos.z);

    if (this.stunTimer > 0) {
      // Stunned: stagger on the spot with arms up.
      this.stunTimer -= dt;
      this.pose.stun = Math.min(1, this.pose.stun + dt * 10);
      this.pose.aim = 0;
      this.pose.strike = 0;
      if (this.stunTimer <= 0) {
        this.mode = this.hasGun ? 'advance' : 'chase';
        this.path = null;
      }
    } else {
      this.pose.stun = Math.max(0, this.pose.stun - dt * 5);
      if (!player.alive) {
        // Nothing left to do: lower the weapon and stand there.
        this.pose.aim = Math.max(0, this.pose.aim - dt * 3);
      } else if (this.hasGun) {
        this.updateGunner(dt, dist, canSee, yawToPlayer);
      } else {
        this.updateRunner(dt, dist, canSee, yawToPlayer);
      }
    }

    // Don't stand inside each other.
    for (const other of game.enemies) {
      if (other === this || !other.targetable) continue;
      const ox = this.pos.x - other.pos.x, oz = this.pos.z - other.pos.z;
      const d = Math.hypot(ox, oz);
      if (d < 0.9 && d > 0.001) {
        const push = (0.9 - d) * 0.5;
        this.pos.x += (ox / d) * push;
        this.pos.z += (oz / d) * push;
      }
    }
    game.world.resolveCircle(this.pos, CONFIG.enemy.radius);
    this.sync();
  }

  /** Copy the logical state onto the visible model. */
  sync() {
    this.model.group.position.set(this.pos.x, 0, this.pos.z);
    this.model.group.rotation.y = this.yaw;
    this.model.setPose(this.pose);
  }

  // --- gunner state machine -------------------------------------------------------

  updateGunner(dt, dist, canSee, yawToPlayer) {
    const E = CONFIG.enemy;
    switch (this.mode) {
      case 'advance': // walk towards the player until there is a clear shot
        this.pose.aim = Math.max(0, this.pose.aim - dt * 4);
        if (canSee && dist < E.sightRange) {
          this.mode = 'aim';
          this.timer = E.aimTime + Math.random() * 0.3;
        } else {
          this.chase(dt, E.gunnerSpeed);
        }
        break;

      case 'aim': // raise the gun, wait for the wind-up, fire
        this.turnTo(yawToPlayer, dt * 9);
        this.pose.aim = Math.min(1, this.pose.aim + dt * 5);
        if (!canSee) { this.mode = 'advance'; break; }
        if (this.tryDodge()) break;
        this.timer -= dt;
        if (this.timer <= 0) {
          this.shoot();
          // After each shot, pick what to do next. A little randomness goes a
          // long way towards making enemies feel alive.
          const roll = Math.random();
          if (roll < 0.3 && this.tryTakeCover()) break;
          if (roll < 0.6 && this.tryReposition()) break;
          this.timer = 0.9 + Math.random() * 0.6;
        }
        break;

      case 'move': // heading to a cover / strafe / dodge spot
        this.pose.aim = Math.max(0, this.pose.aim - dt * 4);
        if (this.followPath(dt, E.gunnerSpeed * 1.35)) {
          if (this.waitAfterMove > 0) { this.mode = 'hide'; this.timer = this.waitAfterMove; }
          else this.mode = 'advance';
        }
        break;

      case 'hide': // wait behind cover, then come back out
        this.turnTo(yawToPlayer, dt * 5);
        this.timer -= dt;
        if (this.timer <= 0) { this.mode = 'advance'; this.path = null; this.repathTimer = 0; }
        break;
    }
  }

  // --- runner state machine --------------------------------------------------------

  updateRunner(dt, dist, canSee, yawToPlayer) {
    const E = CONFIG.enemy;
    switch (this.mode) {
      case 'advance':
      case 'aim':
      case 'hide':
        this.mode = 'chase'; // (a disarmed gunner ends up here)
        break;

      case 'chase':
        this.pose.strike = Math.max(0, this.pose.strike - dt * 4);
        if (dist < E.meleeRange && canSee) {
          this.mode = 'windup';
          this.timer = 0.32;
        } else if (!this.tryDodge()) {
          this.chase(dt, E.runnerSpeed);
        }
        break;

      case 'move': // dodging sideways
        if (this.followPath(dt, E.runnerSpeed * 1.2)) this.mode = 'chase';
        break;

      case 'windup': // arms go up… the player has a split second to react
        this.turnTo(yawToPlayer, dt * 12);
        this.pose.strike = Math.min(1, this.pose.strike + dt * 4);
        this.timer -= dt;
        if (this.timer <= 0) {
          if (dist < E.meleeRange + 0.4 && canSee) this.game.killPlayer();
          this.game.fx('punch', { pos: [this.pos.x, 1.3, this.pos.z] });
          this.mode = 'recover';
          this.timer = 0.5;
        }
        break;

      case 'recover':
        this.pose.strike = Math.max(0, this.pose.strike - dt * 3);
        this.timer -= dt;
        if (this.timer <= 0) this.mode = 'chase';
        break;
    }
  }

  // --- movement helpers ---------------------------------------------------------------

  /** Follow an A* path to the player, re-planning a couple of times per second. */
  chase(dt, speed) {
    if (this.repathTimer <= 0 || !this.path) {
      const p = this.game.player.pos;
      this.path = this.game.nav.findPath(this.pos.x, this.pos.z, p.x, p.z);
      this.pathIndex = 0;
      this.repathTimer = 0.4 + Math.random() * 0.2;
    }
    this.followPath(dt, speed);
  }

  /** Walk along this.path. Returns true once the end is reached (or there is no path). */
  followPath(dt, speed) {
    if (!this.path || this.pathIndex >= this.path.length) return true;
    const wp = this.path[this.pathIndex];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) {
      this.pathIndex++;
      return this.pathIndex >= this.path.length;
    }
    const step = Math.min(d, speed * dt);
    this.pos.x += (dx / d) * step;
    this.pos.z += (dz / d) * step;
    this.turnTo(Math.atan2(-dx, -dz), dt * 10);
    this.pose.walk += step * 2.8; // legs swing in proportion to distance covered
    return false;
  }

  turnTo(targetYaw, amount) {
    this.yaw += angleDiff(this.yaw, targetYaw) * Math.min(1, amount);
  }

  /** Side-step when the player points a weapon at us. */
  tryDodge() {
    if (this.dodgeCooldown > 0) return false;
    const game = this.game;
    if (!game.player.isAimingAt(this)) return false;
    this.dodgeCooldown = 1.2 + Math.random(); // whether we dodge or not, don't re-check every frame
    if (Math.random() > CONFIG.enemy.dodgeChance) return false;

    // Perpendicular to the line between us and the player, random side first.
    const dx = game.player.pos.x - this.pos.x, dz = game.player.pos.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const side = Math.random() < 0.5 ? 1 : -1;
    for (const s of [side, -side]) {
      const amount = 1.6 + Math.random();
      const tx = this.pos.x + (-dz / d) * s * amount;
      const tz = this.pos.z + (dx / d) * s * amount;
      if (game.nav.isFree(tx, tz) && game.nav.lineFree(this.pos.x, this.pos.z, tx, tz)) {
        this.path = [{ x: tx, z: tz }];
        this.pathIndex = 0;
        this.waitAfterMove = 0;
        this.mode = 'move';
        return true;
      }
    }
    return false;
  }

  /** Look for a nearby spot the player cannot see, and run there. */
  tryTakeCover() {
    const game = this.game;
    const p = game.player.pos;
    let best = null, bestD = Infinity;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 6;
      const x = this.pos.x + Math.cos(a) * r, z = this.pos.z + Math.sin(a) * r;
      if (!game.nav.isFree(x, z)) continue;
      // "Cover" = the player's eyes cannot see our chest from there.
      if (game.world.lineOfSight(x, 1.0, z, p.x, CONFIG.player.eyeHeight, p.z)) continue;
      if (r < bestD) { bestD = r; best = { x, z }; }
    }
    if (!best) return false;
    const path = game.nav.findPath(this.pos.x, this.pos.z, best.x, best.z);
    if (!path) return false;
    this.path = path;
    this.pathIndex = 0;
    this.waitAfterMove = 1 + Math.random() * 1.5;
    this.mode = 'move';
    return true;
  }

  /** Strafe to another spot that still has a clear shot. */
  tryReposition() {
    const game = this.game;
    const p = game.player.pos;
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 3;
      const x = this.pos.x + Math.cos(a) * r, z = this.pos.z + Math.sin(a) * r;
      if (!game.nav.isFree(x, z)) continue;
      if (!game.world.lineOfSight(x, 1.5, z, p.x, 1.5, p.z)) continue;
      const path = game.nav.findPath(this.pos.x, this.pos.z, x, z);
      if (!path) continue;
      this.path = path;
      this.pathIndex = 0;
      this.waitAfterMove = 0;
      this.mode = 'move';
      return true;
    }
    return false;
  }

  // --- combat ---------------------------------------------------------------------------

  shoot() {
    const game = this.game;
    const player = game.player;
    // Muzzle: chest height, a little in front of the body.
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    _muzzle.set(this.pos.x + fx * 0.6, 1.4, this.pos.z + fz * 0.6);
    // Don't fire if the gun barrel is poking into a wall.
    if (!game.world.lineOfSight(this.pos.x, 1.4, this.pos.z, _muzzle.x, _muzzle.y, _muzzle.z)) return;

    // Aim at the player's chest, with a small random error so shots aren't perfect.
    _aim.set(player.pos.x, CONFIG.player.eyeHeight - 0.35, player.pos.z).sub(_muzzle).normalize();
    _aim.x += (Math.random() - 0.5) * 0.035;
    _aim.y += (Math.random() - 0.5) * 0.025;
    _aim.z += (Math.random() - 0.5) * 0.035;
    _aim.normalize();

    game.bullets.spawn(_muzzle, _aim, CONFIG.enemy.bulletSpeed, 'enemy', this.id);
    game.fx('shot', { pos: [_muzzle.x, _muzzle.y, _muzzle.z], owner: 'enemy' });
  }

  /** Hit by a thrown object or a punch: stagger and drop the gun. */
  stun(duration, dir) {
    if (this.dead) return;
    this.stunTimer = Math.max(this.stunTimer, duration);
    this.path = null;
    this.game.fx('stun', { pos: [this.pos.x, 1.4, this.pos.z] });
    if (this.hasGun) this.dropGun(true);
  }

  /** The gun leaves our hand and flies up into the air. */
  dropGun(towardsPlayer) {
    this.hasGun = false;
    this.pose.gun = 0;
    const game = this.game;
    _v.set(game.player.pos.x - this.pos.x, 0, game.player.pos.z - this.pos.z);
    const d = _v.length() || 1;
    // Toss it part of the way to the player so it can be caught mid-air.
    const speed = towardsPlayer ? Math.min(4.5, d * 0.55) : 1.2;
    _v.multiplyScalar(speed / d);
    _v.y = 5.5;
    game.items.spawn('pistol', new THREE.Vector3(this.pos.x, 1.4, this.pos.z), {
      state: 'flying', vel: _v, ammo: CONFIG.pistol.droppedAmmo,
    });
  }

  /** Shatter! @param {THREE.Vector3} dir direction of the hit, shards fly that way */
  die(dir) {
    if (this.dead) return;
    this.dead = true;
    if (this.hasGun) this.dropGun(true);
    this.model.group.visible = false;
    this.game.scene.remove(this.model.group);
    this.game.fx('shatter', { pos: [this.pos.x, 1.0, this.pos.z], dir: [dir.x, dir.y, dir.z] });
    this.game.onEnemyKilled(this);
  }

  dispose() {
    this.game.scene.remove(this.model.group);
  }
}
