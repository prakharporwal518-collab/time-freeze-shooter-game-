// ---------------------------------------------------------------------------
// bullet.js — visible, glowing, SLOW projectiles.
//
// Many shooters use "hitscan": the instant you click, a ray decides what was
// hit. Here every bullet is a real object that travels through the world, so
// you can watch it crawl towards you when time is frozen and step aside.
//
// Bullets are pooled: when one dies its mesh is hidden and reused by the next
// shot instead of being destroyed and re-created.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// Shared geometry + materials (one copy for every bullet).
const CORE_GEO = new THREE.CylinderGeometry(0.035, 0.035, 0.45, 6).rotateX(Math.PI / 2);
const TRAIL_GEO = new THREE.CylinderGeometry(0.03, 0.0, 2.2, 6).rotateX(Math.PI / 2).translate(0, 0, -1.3);
const MATS = {
  player: {
    core: new THREE.MeshBasicMaterial({ color: 0xbff8ff }),
    trail: new THREE.MeshBasicMaterial({ color: 0x22d3ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
  },
  enemy: {
    core: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    trail: new THREE.MeshBasicMaterial({ color: 0xff5a1a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
  },
};

/** Build the visual for one bullet. Also used by the replay system. */
export function createBulletMesh(owner) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(CORE_GEO, MATS[owner].core));
  g.add(new THREE.Mesh(TRAIL_GEO, MATS[owner].trail));
  return g;
}

const _target = new THREE.Vector3();

/**
 * Does the segment starting at p, going `len` along unit direction d, pass
 * through an upright cylinder (centre cx,cz, radius r, from y0 to y1)?
 * Returns the distance along the segment of the closest approach, or -1.
 */
export function segmentHitsCylinder(p, d, len, cx, cz, r, y0, y1) {
  // Project the cylinder's axis onto the segment (in the XZ plane).
  const dxz2 = d.x * d.x + d.z * d.z;
  let t = dxz2 > 1e-9 ? ((cx - p.x) * d.x + (cz - p.z) * d.z) / dxz2 : 0;
  t = Math.max(0, Math.min(len, t));
  const x = p.x + d.x * t, y = p.y + d.y * t, z = p.z + d.z * t;
  const ex = x - cx, ez = z - cz;
  if (ex * ex + ez * ez > r * r) return -1;
  if (y < y0 || y > y1) return -1;
  return t;
}

export class BulletManager {
  /** @param {import('./main.js').Game} game */
  constructor(game) {
    this.game = game;
    this.active = [];
    this.pool = { player: [], enemy: [] };
    this.nextId = 1;
  }

  /**
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir      normalised
   * @param {number} speed           metres per GAME second
   * @param {'player'|'enemy'} owner
   * @param {number} shooterId       enemy id (so a gunner cannot shoot itself)
   */
  spawn(origin, dir, speed, owner, shooterId = -1) {
    const mesh = this.pool[owner].pop() || createBulletMesh(owner);
    mesh.visible = true;
    mesh.position.copy(origin);
    mesh.lookAt(_target.copy(origin).add(dir)); // point the +Z axis along the flight direction
    this.game.scene.add(mesh);
    this.active.push({
      id: this.nextId++, owner, shooterId, mesh,
      pos: origin.clone(), dir: dir.clone(), speed, life: 7,
    });
  }

  remove(index) {
    const b = this.active[index];
    b.mesh.visible = false;
    this.game.scene.remove(b.mesh);
    this.pool[b.owner].push(b.mesh);
    this.active[index] = this.active[this.active.length - 1];
    this.active.pop();
  }

  clear() {
    while (this.active.length) this.remove(this.active.length - 1);
  }

  /** @param {number} dt GAME time */
  update(dt) {
    const game = this.game;
    const world = game.world;
    const player = game.player;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.life -= dt;
      const step = b.speed * dt;
      const { pos, dir } = b;

      // How far can the bullet fly this frame before hitting level geometry?
      let hitDist = world.raycast(pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, step);
      let hitKind = hitDist !== Infinity ? 'wall' : null;
      let hitEnemy = null;
      if (hitDist === Infinity) hitDist = step;

      // Floor
      if (dir.y < 0) {
        const tFloor = -pos.y / dir.y;
        if (tFloor >= 0 && tFloor < hitDist) { hitDist = tFloor; hitKind = 'wall'; }
      }

      // Enemies. Friendly fire is ON: an enemy bullet can hit another enemy
      // (but never the one who fired it). Lining enemies up is a valid tactic!
      for (const e of game.enemies) {
        if (!e.targetable || e.id === b.shooterId) continue;
        const t = segmentHitsCylinder(pos, dir, hitDist, e.pos.x, e.pos.z, 0.42, 0, 1.85);
        if (t >= 0 && t <= hitDist) { hitDist = t; hitKind = 'enemy'; hitEnemy = e; }
      }

      // The player (one hit kills).
      if (b.owner === 'enemy' && player.alive) {
        const t = segmentHitsCylinder(pos, dir, hitDist, player.pos.x, player.pos.z, 0.3, 0.25, 1.75);
        if (t >= 0 && t <= hitDist) { hitDist = t; hitKind = 'player'; hitEnemy = null; }
      }

      pos.addScaledVector(dir, hitDist);
      b.mesh.position.copy(pos);

      if (hitKind === 'enemy') {
        hitEnemy.die(dir);
        this.remove(i);
      } else if (hitKind === 'player') {
        this.remove(i);
        game.killPlayer();
      } else if (hitKind === 'wall') {
        game.fx('spark', { pos: [pos.x, pos.y, pos.z], owner: b.owner });
        this.remove(i);
      } else if (
        b.life <= 0 || pos.y > world.ceiling ||
        Math.abs(pos.x) > world.halfW + 25 || Math.abs(pos.z) > world.halfD + 25
      ) {
        this.remove(i);
      }
    }
  }
}
