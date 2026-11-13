// ---------------------------------------------------------------------------
// pickups.js — things lying in the world that the player can grab:
//   pistol  (shoots, can also be thrown)
//   bottle  (throwable, shatters, stuns)
//   plate   (throwable, shatters, stuns)
//
// An item is always in one of three states:
//   'rest'   - lying on the floor / a table, waiting to be picked up
//   'flying' - falling harmlessly (a gun dropped by an enemy). Can be caught mid-air!
//   'thrown' - thrown by the player: stuns the first enemy it hits
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { segmentHitsCylinder } from './bullet.js';

export const ITEM_TYPES = ['pistol', 'bottle', 'plate'];
export const ITEM_LABEL = { pistol: 'PISTOL', bottle: 'BOTTLE', plate: 'PLATE' };

// How high above a surface the item's origin sits when resting.
const REST_OFFSET = { pistol: 0.05, bottle: 0.14, plate: 0.03 };

// Shared materials. Items glow a little so they are easy to spot in the dark.
const M = {
  gun: new THREE.MeshLambertMaterial({ color: 0x20242c, emissive: 0x0b2a33, flatShading: true }),
  gunGlow: new THREE.MeshBasicMaterial({ color: 0x1fb6d9 }),
  bottle: new THREE.MeshLambertMaterial({ color: 0x1fae6a, emissive: 0x0f7a45, emissiveIntensity: 1.2, flatShading: true }),
  cap: new THREE.MeshBasicMaterial({ color: 0xffd166 }),
  plate: new THREE.MeshLambertMaterial({ color: 0xd8dde6, emissive: 0x7f8ea3, emissiveIntensity: 0.9, flatShading: true }),
};
const G = {
  slide: new THREE.BoxGeometry(0.06, 0.09, 0.34),
  grip: new THREE.BoxGeometry(0.055, 0.17, 0.09),
  strip: new THREE.BoxGeometry(0.065, 0.02, 0.12),
  body: new THREE.CylinderGeometry(0.05, 0.055, 0.2, 7),
  neck: new THREE.CylinderGeometry(0.02, 0.045, 0.1, 7),
  cap: new THREE.CylinderGeometry(0.024, 0.024, 0.025, 7),
  plate: new THREE.CylinderGeometry(0.19, 0.13, 0.035, 10),
};

/**
 * Build the mesh for an item. The same function is used for world pickups,
 * the first-person view-model and replay puppets.
 * The pistol's barrel points along -Z (the direction cameras look in Three.js).
 */
export function createItemMesh(type) {
  const g = new THREE.Group();
  if (type === 'pistol') {
    const slide = new THREE.Mesh(G.slide, M.gun);
    const grip = new THREE.Mesh(G.grip, M.gun);
    grip.position.set(0, -0.11, 0.1);
    grip.rotation.x = 0.25;
    const strip = new THREE.Mesh(G.strip, M.gunGlow);
    strip.position.set(0, 0.04, -0.02);
    g.add(slide, grip, strip);
  } else if (type === 'bottle') {
    const body = new THREE.Mesh(G.body, M.bottle);
    const neck = new THREE.Mesh(G.neck, M.bottle);
    neck.position.y = 0.15;
    const cap = new THREE.Mesh(G.cap, M.cap);
    cap.position.y = 0.21;
    g.add(body, neck, cap);
  } else {
    g.add(new THREE.Mesh(G.plate, M.plate));
  }
  return g;
}

const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0);

export class ItemManager {
  /** @param {import('./main.js').Game} game */
  constructor(game) {
    this.game = game;
    this.items = [];
    this.nextId = 1;
  }

  /**
   * @param {string} type 'pistol' | 'bottle' | 'plate'
   * @param {THREE.Vector3} pos
   * @param {object} o { ammo, state, vel }
   */
  spawn(type, pos, o = {}) {
    const mesh = createItemMesh(type);
    mesh.scale.setScalar(1.35); // slightly oversized so pickups read well from a distance
    const item = {
      id: this.nextId++,
      type,
      mesh,
      pos: pos.clone(),
      vel: (o.vel || new THREE.Vector3()).clone(),
      state: o.state || 'rest',
      ammo: o.ammo ?? (type === 'pistol' ? CONFIG.pistol.ammo : 0),
      spin: o.state && o.state !== 'rest' ? 9 + Math.random() * 5 : 0,
    };
    if (item.state === 'rest') this.settle(item, pos.y);
    mesh.position.copy(item.pos);
    this.game.scene.add(mesh);
    this.items.push(item);
    return item;
  }

  /** Put an item down flat on a surface at height `surfaceY`. */
  settle(item, surfaceY) {
    item.state = 'rest';
    item.vel.set(0, 0, 0);
    item.spin = 0;
    item.pos.y = surfaceY + REST_OFFSET[item.type];
    item.mesh.rotation.set(0, Math.random() * Math.PI * 2, item.type === 'pistol' ? Math.PI / 2 : 0);
  }

  remove(item) {
    this.game.scene.remove(item.mesh);
    const i = this.items.indexOf(item);
    if (i !== -1) this.items.splice(i, 1);
  }

  clear() {
    for (const it of this.items) this.game.scene.remove(it.mesh);
    this.items.length = 0;
  }

  /**
   * Which item is the player looking at? We pick the one closest to the centre
   * of the screen (largest dot product with the view direction) within range.
   */
  findTarget(camPos, forward) {
    let best = null;
    let bestScore = 0.93; // must be within ~21 degrees of the crosshair
    for (const it of this.items) {
      if (it.state === 'thrown') continue;
      _to.copy(it.pos).sub(camPos);
      const dist = _to.length();
      if (dist > CONFIG.player.pickupRange) continue;
      const score = _to.dot(forward) / Math.max(dist, 0.001);
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return best;
  }

  /** Bottles and plates break; a pistol just clatters to the ground. */
  breakOrDrop(item, bounceDir) {
    if (item.type === 'pistol') {
      item.state = 'flying';
      if (bounceDir) item.vel.set(-bounceDir.x * 1.5, 2.5, -bounceDir.z * 1.5);
      else item.vel.set(0, Math.min(item.vel.y, 0), 0);
    } else {
      this.game.fx('glass', { pos: [item.pos.x, item.pos.y, item.pos.z], kind: item.type });
      this.remove(item);
    }
  }

  /** @param {number} dt GAME time */
  update(dt) {
    const game = this.game;
    const world = game.world;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.state === 'rest') continue;

      // Thrown objects fly flatter (less gravity) so aiming feels fair.
      it.vel.y -= (it.state === 'thrown' ? 5 : 12) * dt;
      const len = it.vel.length() * dt;

      if (len > 1e-7) {
        _dir.copy(it.vel).normalize();
        let hitDist = world.raycast(it.pos.x, it.pos.y, it.pos.z, _dir.x, _dir.y, _dir.z, len);
        let hitEnemy = null;
        const hitWall = hitDist !== Infinity;
        if (!hitWall) hitDist = len;

        if (it.state === 'thrown') {
          for (const e of game.enemies) {
            if (!e.targetable) continue;
            const t = segmentHitsCylinder(it.pos, _dir, hitDist, e.pos.x, e.pos.z, 0.55, 0, 1.95);
            if (t >= 0 && t <= hitDist) { hitDist = t; hitEnemy = e; }
          }
        }

        it.pos.addScaledVector(_dir, Math.max(0, hitDist - 0.02));

        if (hitEnemy) {
          hitEnemy.stun(CONFIG.enemy.stunTime, _dir);
          this.breakOrDrop(it, _dir);
          if (it.type !== 'pistol') continue; // it shattered and was removed
        } else if (hitWall) {
          if (it.state === 'thrown') {
            this.breakOrDrop(it, null);
            if (it.type !== 'pistol') continue;
          } else {
            it.vel.x = 0;
            it.vel.z = 0;
            it.vel.y = Math.min(it.vel.y, 0);
          }
        }
      }

      // Thrown off the edge of a rooftop? It is gone for good.
      const outside = Math.abs(it.pos.x) > world.halfW + 0.5 || Math.abs(it.pos.z) > world.halfD + 0.5;
      if (outside) {
        if (it.pos.y < -25) { this.remove(it); continue; }
        it.mesh.rotateOnAxis(AXIS_X, it.spin * dt);
        it.mesh.position.copy(it.pos);
        continue;
      }

      // Landed on the floor or on top of furniture?
      const ground = world.groundHeight(it.pos.x, it.pos.z, it.pos.y);
      if (it.pos.y <= ground + REST_OFFSET[it.type] + 0.03) {
        if (it.state === 'thrown' && it.type !== 'pistol') {
          it.pos.y = ground + 0.05;
          this.breakOrDrop(it, null);
          continue;
        }
        this.settle(it, ground);
      } else {
        it.mesh.rotateOnAxis(AXIS_X, it.spin * dt); // tumble through the air
      }
      it.mesh.position.copy(it.pos);
    }
  }
}
