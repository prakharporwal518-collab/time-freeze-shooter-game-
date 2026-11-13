// ---------------------------------------------------------------------------
// particles.js — flying shards (shattered enemies, broken glass, sparks).
//
// Drawing 800 separate meshes would mean 800 draw calls per frame. Instead we
// use ONE InstancedMesh: the GPU draws the same little tetrahedron many times,
// each with its own position / rotation / scale / colour. One draw call.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const MAX = 900;
const GRAVITY = 9.8;

// Scratch objects reused every frame (creating objects in a loop makes the
// garbage collector stutter — a classic cause of dropped frames).
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class Particles {
  constructor(scene) {
    const geo = new THREE.TetrahedronGeometry(1, 0);
    // MeshBasicMaterial ignores lighting, so shards stay bright and bloom nicely.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances are spread all over the level
    // Allocate the per-instance colour buffer up front.
    this.mesh.setColorAt(0, _c.set(0xffffff));
    scene.add(this.mesh);
    this.list = [];
  }

  /**
   * Spawn a burst of shards.
   * @param {number} x,y,z  centre
   * @param {object} o      options (see defaults below)
   */
  burst(x, y, z, o = {}) {
    const {
      count = 20,
      color = 0xff2233,
      speed = 4, // random outward speed
      dir = null, // optional [x,y,z] push direction (e.g. the bullet's direction)
      push = 0, // strength of that push
      size = 0.08,
      life = 3,
      spreadXZ = 0, // random start offset, sideways
      spreadY = 0, // random start offset, vertical
      gravity = 1,
    } = o;

    for (let i = 0; i < count; i++) {
      if (this.list.length >= MAX) this.list.shift(); // recycle the oldest shard
      // Random direction on a sphere.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const sp = speed * (0.3 + Math.random() * 0.7);
      _c.set(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.2);
      this.list.push({
        x: x + (Math.random() - 0.5) * spreadXZ,
        y: y + (Math.random() - 0.5) * spreadY,
        z: z + (Math.random() - 0.5) * spreadXZ,
        vx: r * Math.cos(a) * sp + (dir ? dir[0] * push : 0),
        vy: u * sp + 1.5 + (dir ? dir[1] * push : 0),
        vz: r * Math.sin(a) * sp + (dir ? dir[2] * push : 0),
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        spin: (Math.random() - 0.5) * 14,
        size: size * (0.5 + Math.random()),
        life: life * (0.6 + Math.random() * 0.4),
        maxLife: life,
        gravity,
        r: _c.r, g: _c.g, b: _c.b,
      });
    }
  }

  clear() {
    this.list.length = 0;
    this.mesh.count = 0;
  }

  /** @param {number} dt GAME time — so shards hang in the air when time freezes. */
  update(dt) {
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) {
        // Swap-remove: O(1) deletion when order does not matter.
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      p.vy -= GRAVITY * p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rx += p.spin * dt;
      p.ry += p.spin * 0.7 * dt;
      // Bounce on the floor, losing energy each time.
      if (p.y < p.size * 0.5) {
        p.y = p.size * 0.5;
        p.vy *= -0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
        p.spin *= 0.5;
      }
    }

    // Write every live shard into the instance buffers.
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const fade = Math.min(1, p.life / (p.maxLife * 0.3)); // shrink away at the end
      _e.set(p.rx, p.ry, p.rz);
      _q.setFromEuler(_e);
      _p.set(p.x, p.y, p.z);
      _s.setScalar(p.size * fade);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.setRGB(p.r, p.g, p.b));
    }
    this.mesh.count = list.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
