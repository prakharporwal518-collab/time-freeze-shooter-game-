// ---------------------------------------------------------------------------
// pathfinding.js — a navigation grid + the A* search algorithm.
//
// (Nice DSA practice: this file is a real-world use of a graph search with a
//  priority queue / binary min-heap.)
//
// 1. The level is cut into square cells (0.5 m). A cell is "blocked" if an
//    enemy standing in its centre would touch an obstacle.
// 2. A* finds the cheapest chain of free cells from start to goal:
//        f(n) = g(n) + h(n)
//    g = real cost walked so far, h = optimistic guess of the cost remaining
//    (the "heuristic"). Always expanding the cell with the smallest f means
//    we explore towards the goal first instead of flooding the whole map.
// 3. The zig-zag grid path is then "smoothed" by skipping waypoints whenever
//    there is a straight free line between two of them.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

const SQRT2 = Math.SQRT2;

/** A tiny binary min-heap of cell indices, ordered by their f score. */
class MinHeap {
  constructor(scores) {
    this.items = [];
    this.scores = scores; // shared Float32Array: scores[cell] = f
  }
  get size() { return this.items.length; }
  clear() { this.items.length = 0; }

  push(cell) {
    const a = this.items;
    a.push(cell);
    // Sift up: swap with the parent while we are smaller than it.
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.scores[a[i]] >= this.scores[a[parent]]) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      // Sift down: swap with the smaller child while we are bigger than it.
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.scores[a[l]] < this.scores[a[m]]) m = l;
        if (r < a.length && this.scores[a[r]] < this.scores[a[m]]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class NavGrid {
  /** @param {import('./world.js').World} world */
  constructor(world) {
    const cell = CONFIG.nav.cellSize;
    this.cell = cell;
    this.originX = -world.halfW;
    this.originZ = -world.halfD;
    this.cols = Math.ceil((world.halfW * 2) / cell);
    this.rows = Math.ceil((world.halfD * 2) / cell);
    const n = this.cols * this.rows;

    // 1 = blocked, 0 = walkable
    this.blocked = new Uint8Array(n);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = this.originX + (c + 0.5) * cell;
        const z = this.originZ + (r + 0.5) * cell;
        if (world.circleBlocked(x, z, CONFIG.nav.agentRadius)) this.blocked[r * this.cols + c] = 1;
      }
    }

    // Scratch arrays reused by every search (allocating per search would be slow).
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    // Instead of clearing the arrays before each search we stamp cells with the
    // id of the search that last touched them. Old stamps simply don't count.
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.searchId = 0;
    this.heap = new MinHeap(this.f);
  }

  // --- coordinate helpers ---------------------------------------------------
  colOf(x) { return Math.floor((x - this.originX) / this.cell); }
  rowOf(z) { return Math.floor((z - this.originZ) / this.cell); }
  cellX(col) { return this.originX + (col + 0.5) * this.cell; }
  cellZ(row) { return this.originZ + (row + 0.5) * this.cell; }
  inside(col, row) { return col >= 0 && row >= 0 && col < this.cols && row < this.rows; }

  /** Is the world position (x, z) on a walkable cell? */
  isFree(x, z) {
    const c = this.colOf(x), r = this.rowOf(z);
    return this.inside(c, r) && !this.blocked[r * this.cols + c];
  }

  /** Walkable straight line? Sampled every quarter metre. */
  lineFree(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.25);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      if (!this.isFree(ax + dx * t, az + dz * t)) return false;
    }
    return true;
  }

  /** Closest walkable cell index to (x, z), searching outwards in rings. -1 if none. */
  nearestFree(x, z) {
    const c0 = Math.max(0, Math.min(this.cols - 1, this.colOf(x)));
    const r0 = Math.max(0, Math.min(this.rows - 1, this.rowOf(z)));
    if (!this.blocked[r0 * this.cols + c0]) return r0 * this.cols + c0;
    for (let ring = 1; ring < 12; ring++) {
      let best = -1, bestD = Infinity;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          // Only the border of the square ring (the inside was checked already).
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
          if (!this.inside(c, r) || this.blocked[r * this.cols + c]) continue;
          const d = (this.cellX(c) - x) ** 2 + (this.cellZ(r) - z) ** 2;
          if (d < bestD) { bestD = d; best = r * this.cols + c; }
        }
      }
      if (best !== -1) return best;
    }
    return -1;
  }

  /**
   * A* search. Returns an array of {x, z} waypoints (start excluded), or null
   * if the goal cannot be reached.
   */
  findPath(sx, sz, tx, tz) {
    const start = this.nearestFree(sx, sz);
    const goal = this.nearestFree(tx, tz);
    if (start === -1 || goal === -1) return null;
    if (start === goal) return [{ x: tx, z: tz }];

    const { cols, rows, blocked, g, f, cameFrom, seen, closed, heap } = this;
    const id = ++this.searchId;
    const goalC = goal % cols, goalR = (goal / cols) | 0;

    // Octile distance: the exact cost on an empty 8-connected grid, so it never
    // over-estimates (that property is what makes A* return the shortest path).
    const h = (c, r) => {
      const dc = Math.abs(c - goalC), dr = Math.abs(r - goalR);
      return Math.max(dc, dr) + (SQRT2 - 1) * Math.min(dc, dr);
    };

    heap.clear();
    g[start] = 0;
    f[start] = h(start % cols, (start / cols) | 0);
    cameFrom[start] = -1;
    seen[start] = id;
    heap.push(start);

    let found = false;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur] === id) continue; // stale duplicate entry in the heap
      closed[cur] = id;
      if (cur === goal) { found = true; break; }

      const cc = cur % cols, cr = (cur / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dc === 0 && dr === 0) continue;
          const nc = cc + dc, nr = cr + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const next = nr * cols + nc;
          if (blocked[next] || closed[next] === id) continue;
          // No cutting corners: a diagonal step needs both side cells free.
          if (dc !== 0 && dr !== 0 && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue;

          const cost = g[cur] + (dc !== 0 && dr !== 0 ? SQRT2 : 1);
          if (seen[next] !== id || cost < g[next]) {
            seen[next] = id;
            g[next] = cost;
            f[next] = cost + h(nc, nr);
            cameFrom[next] = cur;
            heap.push(next); // may create duplicates; they are skipped when popped
          }
        }
      }
    }
    if (!found) return null;

    // Walk the cameFrom links backwards from the goal to rebuild the path.
    const cells = [];
    for (let c = goal; c !== -1; c = cameFrom[c]) cells.push(c);
    cells.reverse();
    const pts = cells.map((c) => ({ x: this.cellX(c % cols), z: this.cellZ((c / cols) | 0) }));
    pts[0] = { x: sx, z: sz };
    return this.smooth(pts).slice(1);
  }

  /** "String pulling": drop waypoints that a straight walk can skip. */
  smooth(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 40);
      while (j > i + 1 && !this.lineFree(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}
