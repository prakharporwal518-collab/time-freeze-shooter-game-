// ---------------------------------------------------------------------------
// world.js — the invisible physics version of a level.
//
// What you SEE is made of Three.js meshes. What you COLLIDE with is this much
// simpler list of axis-aligned boxes (AABBs). Keeping the two separate is a
// very common game-dev trick: collision stays cheap and predictable even if
// the visuals are fancy.
//
// No Three.js import here on purpose — it is plain maths, easy to read and test.
// ---------------------------------------------------------------------------

export class World {
  /** @param {number} width size along X  @param {number} depth size along Z */
  constructor(width, depth) {
    this.halfW = width / 2;
    this.halfD = depth / 2;
    this.ceiling = Infinity;
    this.colliders = [];
  }

  /** Register a solid box given its min/max corner on each axis. */
  addCollider(minX, maxX, minY, maxY, minZ, maxZ) {
    this.colliders.push({
      minX, maxX, minY, maxY, minZ, maxZ,
      // Things floating overhead (awnings, signs) or flat on the floor do not
      // stop people walking, but they still stop bullets.
      blocksMove: minY < 1.7 && maxY > 0.2,
    });
  }

  /**
   * Push a circle (player or enemy, seen from above) out of every obstacle.
   * `pos` is any object with x and z; it is modified in place.
   */
  resolveCircle(pos, radius) {
    // Two passes so that being pushed out of one box into another still resolves.
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.colliders) {
        if (!c.blocksMove) continue;
        // Closest point on the box to the circle centre.
        const nx = Math.max(c.minX, Math.min(pos.x, c.maxX));
        const nz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
        const dx = pos.x - nx;
        const dz = pos.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue; // not touching

        if (d2 > 1e-10) {
          // Centre is outside the box: push straight away from the closest point.
          const d = Math.sqrt(d2);
          const push = radius - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          // Centre is INSIDE the box: leave through the nearest face.
          const left = pos.x - c.minX, right = c.maxX - pos.x;
          const back = pos.z - c.minZ, front = c.maxZ - pos.z;
          const m = Math.min(left, right, back, front);
          if (m === left) pos.x = c.minX - radius;
          else if (m === right) pos.x = c.maxX + radius;
          else if (m === back) pos.z = c.minZ - radius;
          else pos.z = c.maxZ + radius;
        }
      }
    }
    // Finally keep everything inside the level rectangle.
    pos.x = Math.max(-this.halfW + radius, Math.min(this.halfW - radius, pos.x));
    pos.z = Math.max(-this.halfD + radius, Math.min(this.halfD - radius, pos.z));
  }

  /** Would a circle at (x, z) overlap an obstacle or leave the level? Used to build the nav grid. */
  circleBlocked(x, z, radius) {
    if (x < -this.halfW + radius || x > this.halfW - radius) return true;
    if (z < -this.halfD + radius || z > this.halfD - radius) return true;
    for (const c of this.colliders) {
      if (!c.blocksMove) continue;
      const nx = Math.max(c.minX, Math.min(x, c.maxX));
      const nz = Math.max(c.minZ, Math.min(z, c.maxZ));
      const dx = x - nx, dz = z - nz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /**
   * Ray vs. every box, using the classic "slab" method.
   * (ox,oy,oz) = ray origin, (dx,dy,dz) = normalised direction.
   * Returns the distance to the first hit, or Infinity if nothing within maxDist.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = Infinity;
    for (const c of this.colliders) {
      let tMin = 0;
      let tMax = maxDist;

      // X slab
      if (Math.abs(dx) < 1e-9) {
        if (ox < c.minX || ox > c.maxX) continue;
      } else {
        let t1 = (c.minX - ox) / dx, t2 = (c.maxX - ox) / dx;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }
      // Y slab
      if (Math.abs(dy) < 1e-9) {
        if (oy < c.minY || oy > c.maxY) continue;
      } else {
        let t1 = (c.minY - oy) / dy, t2 = (c.maxY - oy) / dy;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }
      // Z slab
      if (Math.abs(dz) < 1e-9) {
        if (oz < c.minZ || oz > c.maxZ) continue;
      } else {
        let t1 = (c.minZ - oz) / dz, t2 = (c.maxZ - oz) / dz;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }
      if (tMin < best) best = tMin;
    }
    return best;
  }

  /** True if nothing solid lies on the straight line between two points. */
  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return true;
    return this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len) === Infinity;
  }

  /**
   * Height of the surface under a point: the floor (0) or the top of a
   * table/counter/crate. Used so dropped items come to rest on furniture.
   */
  groundHeight(x, z, y) {
    let h = 0;
    for (const c of this.colliders) {
      if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
      if (c.maxY <= y + 0.25 && c.maxY > h) h = c.maxY;
    }
    return h;
  }
}
