// ---------------------------------------------------------------------------
// levelLoader.js — turns a level JSON file into a 3D scene + collision world.
//
// A level file is DATA, not code. It lists:
//   theme   - colours, fog, wall style
//   boxes   - raw boxes (walls, cover) for one-off shapes
//   props   - "prefabs": named, reusable objects (stall, pillar, table…)
//   strings - strings of fairy lights between two points
//   lights  - coloured point lights
//   enemies / pickups / player - read by main.js
//
// To add a new kind of prop, write one function in PREFABS below and use its
// name as "type" in a level file. Everything is built from boxes, cylinders,
// cones and spheres — there are no external 3D models or textures.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World } from './world.js';

// Every level JSON inside src/levels/ is loaded automatically, sorted by file
// name. `import.meta.glob` is a Vite feature that imports all matching files
// at build time. To add level 6, just drop "06-something.json" into that folder.
const modules = import.meta.glob('./levels/*.json', { eager: true });
export const LEVELS = Object.keys(modules).sort().map((key) => modules[key].default);

// One unit cube shared by every box in the game; each mesh just scales it.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
UNIT_BOX.userData.shared = true;

const DEVANAGARI_FONTS = '"Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", "Mangal", system-ui, sans-serif';

/** A tiny seeded random generator, so a level looks identical every time it loads. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

const NEON = ['#ff2bd6', '#00e5ff', '#ffd000', '#ff7a00', '#7dff5a', '#b388ff'];

class LevelBuilder {
  constructor(def) {
    this.def = def;
    this.theme = def.theme || {};
    this.root = new THREE.Group();
    this.world = new World(def.size[0], def.size[1]);
    this.rng = makeRng(hashString(def.id || def.name || 'level'));
    this.materials = new Map();
    this.geometries = new Map();
  }

  // --- material / geometry caches (so identical ones are shared) ---------------

  /** A lit, flat-shaded material. Optional emissive colour makes it glow a bit. */
  mat(color, emissive = null, intensity = 1) {
    const key = `L|${color}|${emissive}|${intensity}`;
    if (!this.materials.has(key)) {
      this.materials.set(key, new THREE.MeshLambertMaterial({
        color, flatShading: true, emissive: emissive || 0x000000, emissiveIntensity: intensity,
      }));
    }
    return this.materials.get(key);
  }

  /** A pure neon material: ignores lighting, always full brightness -> blooms. */
  glow(color) {
    const key = `G|${color}`;
    if (!this.materials.has(key)) this.materials.set(key, new THREE.MeshBasicMaterial({ color }));
    return this.materials.get(key);
  }

  geo(key, make) {
    if (!this.geometries.has(key)) this.geometries.set(key, make());
    return this.geometries.get(key);
  }

  // --- shape helpers. (x, y, z) is always the CENTRE of the shape --------------------

  box(parent, w, h, d, x, y, z, material) {
    const m = new THREE.Mesh(UNIT_BOX, material);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  cyl(parent, rTop, rBottom, h, x, y, z, material, segments = 8) {
    const g = this.geo(`c|${rTop}|${rBottom}|${h}|${segments}`, () => new THREE.CylinderGeometry(rTop, rBottom, h, segments));
    const m = new THREE.Mesh(g, material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  ball(parent, r, x, y, z, material, detail = 0) {
    const g = this.geo(`s|${r}|${detail}`, () => new THREE.IcosahedronGeometry(r, detail));
    const m = new THREE.Mesh(g, material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  /** Many small glowing dots in ONE draw call. points = [[x,y,z], …] */
  dots(parent, points, colors, radius = 0.07) {
    const g = this.geo(`dot|${radius}`, () => new THREE.IcosahedronGeometry(radius, 0));
    const mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }), points.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    points.forEach((p, i) => {
      m.makeTranslation(p[0], p[1], p[2]);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(colors[i % colors.length]));
    });
    parent.add(mesh);
    return mesh;
  }

  /** Neon text drawn on a canvas and used as a texture. Works for Hindi too. */
  textPlane(parent, text, color, width, x, y, z) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const g = canvas.getContext('2d');
    let size = 84;
    g.font = `bold ${size}px ${DEVANAGARI_FONTS}`;
    const measured = g.measureText(text).width;
    if (measured > 470) size = Math.floor((size * 470) / measured); // shrink long text to fit
    g.font = `bold ${size}px ${DEVANAGARI_FONTS}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = color;
    g.shadowBlur = 22;
    g.fillStyle = color;
    g.fillText(text, 256, 68);
    g.fillText(text, 256, 68); // twice = stronger halo
    g.shadowBlur = 0;
    g.globalAlpha = 0.55;
    g.fillStyle = '#ffffff'; // hot white core, like a real neon tube
    g.fillText(text, 256, 68);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    const plane = new THREE.Mesh(this.geo('plane', () => new THREE.PlaneGeometry(1, 1)), material);
    plane.scale.set(width, width / 4, 1);
    plane.position.set(x, y, z);
    parent.add(plane);
    return plane;
  }

  /** A texture of randomly lit windows for building walls. */
  windowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const g = canvas.getContext('2d');
    g.fillStyle = '#07060d';
    g.fillRect(0, 0, 128, 128);
    const palette = ['#ffcf7a', '#ffb347', '#7ae7ff', '#ff6ad5', '#fff1c9'];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const lit = this.rng() < 0.3;
        g.fillStyle = lit ? palette[Math.floor(this.rng() * palette.length)] : '#0e0d18';
        g.globalAlpha = lit ? 0.5 + this.rng() * 0.5 : 1;
        g.fillRect(c * 32 + 8, r * 32 + 7, 16, 19);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // --- build steps --------------------------------------------------------------------

  build() {
    this.buildGround();
    this.buildWalls();
    this.buildSky();
    for (const b of this.def.boxes || []) this.buildBox(b);
    for (const p of this.def.props || []) this.buildProp(p);
    for (const s of this.def.strings || []) this.buildString(s);
    this.buildLights();
    this.mergeStatic();
    return this;
  }

  /**
   * PERFORMANCE: a level is built from several hundred little boxes. Drawing
   * each one separately means several hundred "draw calls" per frame, and
   * draw calls (not triangles) are what usually limits frame rate.
   * Nothing in the level ever moves, so we can glue together every mesh that
   * shares a material into ONE big mesh. Result: roughly one draw call per
   * colour instead of one per box.
   */
  mergeStatic() {
    this.root.updateMatrixWorld(true);
    const byMaterial = new Map();
    this.root.traverse((obj) => {
      if (!obj.isMesh || obj.isInstancedMesh || obj.material.transparent) return;
      if (!byMaterial.has(obj.material)) byMaterial.set(obj.material, []);
      byMaterial.get(obj.material).push(obj);
    });
    for (const [material, meshes] of byMaterial) {
      if (meshes.length < 2) continue;
      const parts = meshes.map((mesh) => {
        // Copy the geometry and "bake in" the mesh's position/rotation/scale.
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        g.applyMatrix4(mesh.matrixWorld);
        return g;
      });
      const merged = mergeGeometries(parts);
      parts.forEach((g) => g.dispose());
      if (!merged) continue; // geometries were incompatible; keep the originals
      for (const mesh of meshes) mesh.removeFromParent();
      this.root.add(new THREE.Mesh(merged, material));
    }
  }

  buildGround() {
    const [w, d] = this.def.size;
    const t = this.theme;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), this.mat(t.floor || '#15121c'));
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    // A faint neon grid on the floor gives a sense of speed and scale.
    const size = Math.max(w, d);
    const grid = new THREE.GridHelper(size, Math.round(size / 2), t.accent || '#ff2bd6', t.accent || '#ff2bd6');
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    grid.position.y = 0.01;
    this.root.add(grid);

    if (t.ceiling) {
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), this.mat(t.ceilingColor || '#0c0c14'));
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = t.ceiling;
      this.root.add(ceil);
      this.world.ceiling = t.ceiling;
      // rows of tube lights
      for (let z = -d / 2 + 4; z < d / 2; z += 8) {
        this.box(this.root, w * 0.5, 0.06, 0.18, 0, t.ceiling - 0.05, z, this.glow(t.accent || '#ffffff'));
      }
    }
  }

  buildWalls() {
    const [w, d] = this.def.size;
    const t = this.theme;
    const h = t.wallHeight || 6;
    const style = t.wallStyle || 'plain';
    const T = 0.6; // wall thickness
    // [centreX, centreZ, sizeX, sizeZ] of the four walls, just outside the play area
    const walls = [
      [0, -d / 2 - T / 2, w + T * 2, T],
      [0, d / 2 + T / 2, w + T * 2, T],
      [-w / 2 - T / 2, 0, T, d],
      [w / 2 + T / 2, 0, T, d],
    ];
    for (const [cx, cz, sx, sz] of walls) {
      let material;
      if (style === 'windows') {
        const tex = this.windowTexture();
        tex.repeat.set(Math.max(sx, sz) / 6, h / 6);
        material = new THREE.MeshLambertMaterial({ color: t.wall || '#1a1030', map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9 });
      } else {
        material = this.mat(t.wall || '#1a1030');
      }
      this.box(this.root, sx, h, sz, cx, h / 2, cz, material);
      this.world.addCollider(cx - sx / 2, cx + sx / 2, 0, h, cz - sz / 2, cz + sz / 2);
      // neon trim along the top edge
      this.box(this.root, sx + 0.05, 0.08, sz + 0.05, cx, h + 0.04, cz, this.glow(t.accent || '#ff2bd6'));
    }
  }

  buildSky() {
    const t = this.theme;
    if (t.stars) {
      const pts = [];
      for (let i = 0; i < 500; i++) {
        // random points on the upper half of a big sphere
        const a = this.rng() * Math.PI * 2;
        const e = Math.asin(0.08 + this.rng() * 0.9);
        pts.push(Math.cos(a) * Math.cos(e) * 180, Math.sin(e) * 180, Math.sin(a) * Math.cos(e) * 180);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.root.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.1, sizeAttenuation: false, fog: false })));
      // the moon
      const moon = new THREE.Mesh(new THREE.CircleGeometry(9, 24), new THREE.MeshBasicMaterial({ color: 0xfff3d6, fog: false }));
      moon.position.set(-60, 85, -150);
      moon.lookAt(0, 0, 0);
      this.root.add(moon);
    }
    if (t.skyline) {
      // A ring of distant towers with lit windows.
      const [w, d] = this.def.size;
      const base = Math.max(w, d) / 2;
      for (let i = 0; i < 46; i++) {
        const a = (i / 46) * Math.PI * 2 + this.rng() * 0.1;
        const r = base + 22 + this.rng() * 45;
        const bw = 7 + this.rng() * 9;
        const top = -4 + this.rng() * 26; // roof height relative to our rooftop
        const tex = this.windowTexture();
        tex.repeat.set(bw / 5, (top + 40) / 5);
        const material = new THREE.MeshBasicMaterial({ map: tex, color: 0x8a86a8, fog: false });
        this.box(this.root, bw, top + 40, bw, Math.cos(a) * r, (top - 40) / 2, Math.sin(a) * r, material);
      }
    }
  }

  /** A raw box from the "boxes" list. pos = centre on the floor [x, z] or [x, y, z]. */
  buildBox(b) {
    const [w, h, d] = b.size;
    const x = b.pos[0];
    const z = b.pos.length === 3 ? b.pos[2] : b.pos[1];
    const y0 = b.pos.length === 3 ? b.pos[1] : 0; // height of the box's underside
    const material = b.glow ? this.glow(b.color || '#ffffff') : this.mat(b.color || '#222233', b.emissive, b.emissiveIntensity ?? 1);
    this.box(this.root, w, h, d, x, y0 + h / 2, z, material);
    if (b.trim) this.box(this.root, w + 0.04, 0.06, d + 0.04, x, y0 + h - 0.03, z, this.glow(b.trim));
    if (b.solid !== false) this.world.addCollider(x - w / 2, x + w / 2, y0, y0 + h, z - d / 2, z + d / 2);
  }

  /** Place a prefab. Rotation is in degrees and should be a multiple of 90. */
  buildProp(spec) {
    const make = PREFABS[spec.type];
    if (!make) {
      console.warn(`Unknown prop type "${spec.type}" in level "${this.def.name}"`);
      return;
    }
    const g = new THREE.Group();
    const angle = THREE.MathUtils.degToRad(spec.rot || 0);
    g.position.set(spec.x, 0, spec.z);
    g.rotation.y = angle;
    this.root.add(g);

    // `solid` lets a prefab declare collision boxes in its own LOCAL space;
    // we rotate them into world space here. (Because rotation is limited to
    // 90-degree steps the boxes stay axis-aligned: width and depth just swap.)
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const swap = Math.abs(sin) > 0.5;
    const solid = (lx, lz, w, d, y0, y1) => {
      const wx = spec.x + lx * cos + lz * sin;
      const wz = spec.z - lx * sin + lz * cos;
      const sx = swap ? d : w, sz = swap ? w : d;
      this.world.addCollider(wx - sx / 2, wx + sx / 2, y0, y1, wz - sz / 2, wz + sz / 2);
    };
    make(this, g, spec, solid);
  }

  /** A sagging string of fairy lights between two points. */
  buildString(s) {
    const [x1, z1] = s.from, [x2, z2] = s.to;
    const y = s.y ?? 5, sag = s.sag ?? 0.8;
    const count = s.count ?? Math.max(6, Math.round(Math.hypot(x2 - x1, z2 - z1) / 0.8));
    const pts = [], line = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const p = [x1 + (x2 - x1) * t, y - sag * 4 * t * (1 - t), z1 + (z2 - z1) * t]; // parabola
      line.push(new THREE.Vector3(p[0], p[1] + 0.06, p[2]));
      if (i > 0 && i < count) pts.push(p);
    }
    this.dots(this.root, pts, s.colors || NEON, 0.07);
    const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), new THREE.LineBasicMaterial({ color: 0x222222 }));
    this.root.add(wire);
  }

  buildLights() {
    const t = this.theme;
    this.root.add(new THREE.AmbientLight(t.ambient || '#5a4a8a', (t.ambientIntensity ?? 1.0) * 1.6));
    this.root.add(new THREE.HemisphereLight(t.skyLight || '#4a3a7a', t.floor || '#15121c', 1.4));
    // Point lights are the most expensive thing in the scene (every pixel is
    // shaded once per light), so levels are capped at 10.
    for (const l of (this.def.lights || []).slice(0, 10)) {
      const light = new THREE.PointLight(l.color, (l.intensity ?? 40) * 2, l.distance ?? 18, 1.6);
      light.position.set(l.pos[0], l.pos[1], l.pos[2]);
      this.root.add(light);
    }
  }
}

// ---------------------------------------------------------------------------
// PREFABS — each function builds one kind of prop into the group `g`.
//   b     = the LevelBuilder (use b.box / b.cyl / b.ball / b.mat / b.glow …)
//   s     = the prop's entry from the JSON (so it can read custom options)
//   solid = (localX, localZ, width, depth, bottomY, topY) adds a collision box
// By convention a prop's "front" faces +Z in local space.
// ---------------------------------------------------------------------------

const PREFABS = {
  /** Market stall: counter, shelf, striped awning. variant "chai" adds a kettle + sign. */
  stall(b, g, s, solid) {
    const w = s.w || 3;
    const color = s.color || NEON[Math.floor(b.rng() * NEON.length)];
    const wood = b.mat('#2a1c14');
    b.box(g, w, 1, 1, 0, 0.5, 0, wood);
    b.box(g, w, 0.06, 0.06, 0, 0.96, 0.5, b.glow(color)); // neon edge on the counter
    b.box(g, w, 1.9, 0.3, 0, 0.95, -0.8, b.mat('#1a1420'));
    solid(0, 0, w, 1, 0, 1);
    solid(0, -0.8, w, 0.3, 0, 1.9);
    for (const px of [-w / 2 + 0.05, w / 2 - 0.05]) {
      b.box(g, 0.08, 2.7, 0.08, px, 1.35, 0.75, wood);
      b.box(g, 0.08, 2.9, 0.08, px, 1.45, -0.9, wood);
    }
    // awning made of alternating coloured strips, tilted towards the street
    const awning = new THREE.Group();
    awning.position.set(0, 2.75, 0);
    awning.rotation.x = 0.16;
    g.add(awning);
    const strips = Math.round(w / 0.6);
    for (let i = 0; i < strips; i++) {
      const sw = (w + 0.4) / strips;
      b.box(awning, sw, 0.06, 2.2, -(w + 0.4) / 2 + sw * (i + 0.5), 0, 0, b.mat(i % 2 ? '#e9e4d8' : color, i % 2 ? '#3a372f' : color, 0.35));
    }
    // goods on the shelf and counter
    for (let i = 0; i < 7; i++) {
      const c = NEON[Math.floor(b.rng() * NEON.length)];
      b.box(g, 0.22, 0.25, 0.2, -w / 2 + 0.3 + b.rng() * (w - 0.6), 1.0 + 0.125 + (i % 2) * 0.55, -0.62, b.mat(c, c, 0.5));
    }
    b.ball(g, 0.09, 0, 2.3, 0.4, b.glow('#ffe6a8')); // bare bulb
    b.box(g, 0.01, 0.35, 0.01, 0, 2.5, 0.4, wood);

    if (s.variant === 'chai') {
      // stove + kettle + a row of little tea glasses
      b.box(g, 0.5, 0.12, 0.5, -w / 2 + 0.6, 1.06, -0.05, b.mat('#30343c'));
      b.cyl(g, 0.12, 0.2, 0.07, -w / 2 + 0.6, 1.14, -0.05, b.glow('#ff7a1a'), 6); // flame
      b.ball(g, 0.2, -w / 2 + 0.6, 1.36, -0.05, b.mat('#aab4c2', '#39424f', 0.6));
      const spout = b.cyl(g, 0.02, 0.05, 0.28, -w / 2 + 0.85, 1.42, -0.05, b.mat('#aab4c2', '#39424f', 0.6), 5);
      spout.rotation.z = -0.9;
      for (let i = 0; i < 5; i++) b.cyl(g, 0.035, 0.028, 0.09, 0.2 + i * 0.13, 1.045, 0.25, b.glow('#c9772e'), 6);
      b.box(g, w + 0.2, 0.9, 0.1, 0, 3.35, 0.9, b.mat('#120c10'));
      b.textPlane(g, s.text || 'चाय', '#ffb000', 3, 0, 3.35, 0.97);
    } else if (s.text) {
      b.box(g, w, 0.7, 0.08, 0, 3.2, 1.0, b.mat('#120c10'));
      b.textPlane(g, s.text, color, 2.4, 0, 3.2, 1.06);
    }
  },

  /** Wooden crate. Options: size, h */
  crate(b, g, s, solid) {
    const size = s.size || 1, h = s.h || size;
    b.box(g, size, h, size, 0, h / 2, 0, b.mat(s.color || '#3b2a1a'));
    b.box(g, size + 0.03, 0.05, size + 0.03, 0, h - 0.1, 0, b.glow(s.trim || '#ff7a00'));
    solid(0, 0, size, size, 0, h);
  },

  /** Square column with neon strips. Options: w, h, color, trim */
  pillar(b, g, s, solid) {
    const w = s.w || 0.9, h = s.h || b.theme.ceiling || b.theme.wallHeight || 6;
    b.box(g, w, h, w, 0, h / 2, 0, b.mat(s.color || '#232838'));
    const trim = b.glow(s.trim || b.theme.accent || '#00e5ff');
    b.box(g, w + 0.04, 0.08, w + 0.04, 0, 1.2, 0, trim);
    b.box(g, w + 0.04, 0.08, w + 0.04, 0, h - 0.6, 0, trim);
    solid(0, 0, w, w, 0, h);
  },

  /** Bench, 2 m long. Low enough to shoot over. */
  bench(b, g, s, solid) {
    const m = b.mat(s.color || '#2c3444', s.color || '#101a2a', 0.4);
    b.box(g, 2, 0.08, 0.5, 0, 0.47, 0, m);
    b.box(g, 2, 0.45, 0.07, 0, 0.78, -0.22, m);
    for (const x of [-0.85, 0.85]) b.box(g, 0.08, 0.45, 0.45, x, 0.225, 0, b.mat('#15181f'));
    solid(0, 0, 2, 0.5, 0, 0.51);
  },

  /** Round table with a cloth. Items placed on it rest at y = 0.78. */
  table(b, g, s, solid) {
    const cloth = s.color || '#7a1030';
    b.cyl(g, 0.78, 0.78, 0.06, 0, 0.75, 0, b.mat(cloth, cloth, 0.35), 10);
    b.cyl(g, 0.8, 0.86, 0.3, 0, 0.6, 0, b.mat(cloth, cloth, 0.2), 10);
    b.cyl(g, 0.08, 0.08, 0.7, 0, 0.35, 0, b.mat('#20202a'), 6);
    b.cyl(g, 0.35, 0.4, 0.05, 0, 0.025, 0, b.mat('#20202a'), 8);
    solid(0, 0, 1.3, 1.3, 0, 0.78);
  },

  /** Neon sign board. Options: text, color, w (width), y (height), board (false = text only) */
  sign(b, g, s) {
    const w = s.w || 3, y = s.y ?? 3.4;
    if (s.board !== false) {
      b.box(g, w + 0.3, w / 4 + 0.25, 0.1, 0, y, 0, b.mat('#0c0a12'));
      b.box(g, w + 0.36, 0.05, 0.12, 0, y + w / 8 + 0.125, 0, b.glow(s.color || '#ff2bd6'));
      b.box(g, w + 0.36, 0.05, 0.12, 0, y - w / 8 - 0.125, 0, b.glow(s.color || '#ff2bd6'));
    }
    b.textPlane(g, s.text || 'OPEN', s.color || '#ff2bd6', w, 0, y, 0.07);
  },

  /** Auto-rickshaw: the classic green-and-yellow three wheeler. Front faces +Z. */
  rickshaw(b, g, s, solid) {
    const green = b.mat('#0d7a3c', '#06401f', 0.6), yellow = b.mat('#f5c400', '#7a6200', 0.6), black = b.mat('#101014');
    b.box(g, 1.4, 0.75, 2.2, 0, 0.6, -0.2, green);
    b.box(g, 1.35, 0.85, 1.5, 0, 1.4, -0.45, yellow);
    b.box(g, 1.5, 0.1, 2.0, 0, 1.88, -0.3, black);
    b.box(g, 0.8, 0.6, 0.6, 0, 0.6, 1.15, yellow);
    b.box(g, 1.2, 0.7, 0.06, 0, 1.4, 0.33, b.mat('#18324a', '#0c2a44', 1)); // windshield
    b.ball(g, 0.11, 0, 0.85, 1.47, b.glow('#fff4c2'));
    b.box(g, 0.12, 0.1, 0.05, -0.55, 0.7, -1.31, b.glow('#ff1a1a'));
    b.box(g, 0.12, 0.1, 0.05, 0.55, 0.7, -1.31, b.glow('#ff1a1a'));
    for (const [x, z] of [[0, 1.2], [-0.68, -0.85], [0.68, -0.85]]) {
      const wheel = b.cyl(g, 0.28, 0.28, 0.14, x, 0.28, z, black, 10);
      wheel.rotation.z = Math.PI / 2;
    }
    solid(0, 0, 1.5, 2.9, 0, 1.9);
  },

  /** Fruit hand-cart ("thela"). */
  cart(b, g, s, solid) {
    const wood = b.mat('#3d2b1c');
    b.box(g, 2.1, 0.12, 1.2, 0, 0.85, 0, wood);
    b.box(g, 2.1, 0.2, 0.06, 0, 1.0, 0.57, b.mat('#1d6fa8', '#0e3a5a', 0.6));
    b.box(g, 2.1, 0.2, 0.06, 0, 1.0, -0.57, b.mat('#1d6fa8', '#0e3a5a', 0.6));
    for (const [x, z] of [[-0.7, 0.66], [0.7, 0.66], [-0.7, -0.66], [0.7, -0.66]]) {
      const wheel = b.cyl(g, 0.42, 0.42, 0.06, x, 0.42, z, b.mat('#15151a'), 10);
      wheel.rotation.x = Math.PI / 2;
    }
    const fruit = ['#ff8a00', '#ffd400', '#6fdc3c', '#ff3b3b'];
    for (let i = 0; i < 16; i++) {
      const c = fruit[Math.floor(i / 4)];
      b.ball(g, 0.11, -0.8 + Math.floor(i / 4) * 0.52 + b.rng() * 0.2, 1.0 + b.rng() * 0.12, -0.35 + (i % 4) * 0.22, b.mat(c, c, 0.55));
    }
    solid(0, 0, 2.1, 1.3, 0, 1.05);
  },

  /** Yellow police-style barricade. Chest-high cover. */
  barricade(b, g, s, solid) {
    const y = b.mat('#e0b000', '#6a5200', 0.6);
    b.box(g, 2.2, 0.5, 0.08, 0, 0.9, 0, y);
    b.box(g, 2.2, 0.07, 0.1, 0, 0.9, 0, b.glow('#111111'));
    b.box(g, 2.2, 0.12, 0.08, 0, 0.4, 0, y);
    for (const x of [-0.95, 0.95]) {
      b.box(g, 0.08, 1.15, 0.08, x, 0.575, 0, y);
      b.box(g, 0.08, 0.06, 0.7, x, 0.03, 0, y);
    }
    b.ball(g, 0.07, -0.95, 1.2, 0, b.glow('#ff3b1a'));
    b.ball(g, 0.07, 0.95, 1.2, 0, b.glow('#ff3b1a'));
    solid(0, 0, 2.2, 0.3, 0, 1.15);
  },

  /** Street lamp. */
  lamp(b, g, s, solid) {
    const metal = b.mat('#1c1f28');
    b.cyl(g, 0.06, 0.09, 4.2, 0, 2.1, 0, metal, 6);
    b.box(g, 0.08, 0.08, 1.0, 0, 4.2, 0.45, metal);
    b.box(g, 0.3, 0.08, 0.5, 0, 4.14, 0.85, b.glow(s.color || '#ffd9a0'));
    solid(0, 0, 0.3, 0.3, 0, 4.2);
  },

  /** Metro train coach. Options: len. The lit side faces +X (local). */
  train(b, g, s, solid) {
    const len = s.len || 20;
    const accent = s.color || '#00e5ff';
    b.box(g, 3, 3, len, 0, 1.9, 0, b.mat('#2a3242', '#0c1018', 1));
    b.box(g, 2.6, 0.4, len, 0, 0.2, 0, b.mat('#0c0d12'));
    b.box(g, 3.04, 0.14, len, 0, 1.05, 0, b.glow(accent));
    b.box(g, 3.04, 0.08, len, 0, 3.25, 0, b.glow('#ff2bd6'));
    for (let z = -len / 2 + 1.6; z < len / 2 - 1; z += 2.6) {
      const isDoor = Math.round((z + len / 2) / 2.6) % 3 === 1;
      if (isDoor) {
        b.box(g, 0.06, 2.1, 1.3, 1.5, 1.6, z, b.mat('#141922'));
        b.box(g, 0.07, 1.0, 0.45, 1.5, 2.0, z - 0.3, b.glow('#bdf6ff'));
        b.box(g, 0.07, 1.0, 0.45, 1.5, 2.0, z + 0.3, b.glow('#bdf6ff'));
      } else {
        b.box(g, 0.06, 0.95, 1.9, 1.5, 2.2, z, b.glow('#bdf6ff'));
      }
    }
    solid(0, 0, 3, len, 0, 3.4);
  },

  /** Fare gate. */
  gate(b, g, s, solid) {
    b.box(g, 0.35, 1.0, 1.4, 0, 0.5, 0, b.mat('#2b3140'));
    b.box(g, 0.37, 0.05, 1.42, 0, 1.0, 0, b.glow(s.color || '#39ff88'));
    b.box(g, 0.2, 0.2, 0.03, 0, 0.75, 0.71, b.glow(s.color || '#39ff88'));
    solid(0, 0, 0.35, 1.4, 0, 1.02);
  },

  /** Vending machine with a glowing front (+Z). */
  vending(b, g, s, solid) {
    b.box(g, 1.1, 2.1, 0.8, 0, 1.05, 0, b.mat('#1b2030'));
    b.box(g, 0.9, 1.3, 0.04, 0, 1.3, 0.41, b.glow(s.color || '#00e5ff'));
    for (let i = 0; i < 9; i++) {
      b.box(g, 0.16, 0.22, 0.05, -0.3 + (i % 3) * 0.3, 0.95 + Math.floor(i / 3) * 0.38, 0.43, b.mat(NEON[i % NEON.length], NEON[i % NEON.length], 0.4));
    }
    solid(0, 0, 1.1, 0.8, 0, 2.1);
  },

  /** Rooftop water tank. */
  tank(b, g, s, solid) {
    b.box(g, 2.1, 0.3, 2.1, 0, 0.15, 0, b.mat('#3a3a44'));
    const body = b.mat(s.color || '#12141a', '#060a12', 1);
    b.cyl(g, 0.9, 0.95, 1.5, 0, 1.05, 0, body, 10);
    b.cyl(g, 0.3, 0.9, 0.3, 0, 1.95, 0, body, 10);
    b.cyl(g, 0.97, 0.97, 0.06, 0, 0.8, 0, b.glow(s.trim || '#ffd000'), 10);
    b.cyl(g, 0.95, 0.95, 0.06, 0, 1.4, 0, b.glow(s.trim || '#ffd000'), 10);
    solid(0, 0, 1.9, 1.9, 0, 2.1);
  },

  /** Air-conditioner outdoor unit. Waist-high cover. */
  ac(b, g, s, solid) {
    b.box(g, 1.3, 0.95, 0.7, 0, 0.475, 0, b.mat('#8a909c', '#1c2028', 1));
    const fan = b.cyl(g, 0.34, 0.34, 0.04, -0.2, 0.5, 0.36, b.mat('#15171c'), 10);
    fan.rotation.x = Math.PI / 2;
    b.box(g, 0.08, 0.04, 0.02, 0.45, 0.8, 0.36, b.glow('#39ff88'));
    solid(0, 0, 1.3, 0.7, 0, 0.95);
  },

  /** Solar panel on a tilted frame. */
  solar(b, g, s, solid) {
    const panel = new THREE.Group();
    panel.position.set(0, 0.75, 0);
    panel.rotation.x = -0.45;
    g.add(panel);
    b.box(panel, 2.2, 0.06, 1.3, 0, 0, 0, b.mat('#0c1b3a', '#0a2a6a', 1.2));
    for (let i = -1; i <= 1; i++) b.box(panel, 0.03, 0.07, 1.3, i * 0.55, 0, 0, b.glow('#3a8bff'));
    for (const x of [-1, 1]) b.box(g, 0.06, 0.9, 0.06, x, 0.45, -0.4, b.mat('#30343c'));
    solid(0, 0, 2.2, 1.2, 0, 1.0);
  },

  /** TV dish on a pole. */
  dish(b, g, s, solid) {
    b.cyl(g, 0.05, 0.05, 1.5, 0, 0.75, 0, b.mat('#30343c'), 6);
    const dish = b.cyl(g, 0.6, 0.1, 0.25, 0, 1.6, 0.1, b.mat('#b9c0cc', '#2a2f3a', 1), 10);
    dish.rotation.x = 1.0;
    b.ball(g, 0.05, 0, 1.8, 0.45, b.glow('#ff3b1a'));
    solid(0, 0, 0.3, 0.3, 0, 1.6);
  },

  /** Parked scooter. Front faces +Z. */
  scooter(b, g, s, solid) {
    const paint = b.mat(s.color || '#1aa3a3', s.color || '#0a5050', 0.5), black = b.mat('#111114');
    b.box(g, 0.4, 0.5, 1.1, 0, 0.55, -0.15, paint);
    b.box(g, 0.36, 0.1, 0.7, 0, 0.87, -0.3, black);
    b.box(g, 0.34, 0.8, 0.12, 0, 0.75, 0.5, paint);
    b.box(g, 0.6, 0.06, 0.08, 0, 1.18, 0.5, black);
    b.ball(g, 0.07, 0, 1.0, 0.59, b.glow('#fff4c2'));
    for (const z of [-0.6, 0.62]) {
      const wheel = b.cyl(g, 0.22, 0.22, 0.12, 0, 0.22, z, black, 10);
      wheel.rotation.z = Math.PI / 2;
    }
    solid(0, 0, 0.6, 1.7, 0, 1.15);
  },

  /** Tree wrapped in fairy lights. */
  tree(b, g, s, solid) {
    b.cyl(g, 0.2, 0.3, 3, 0, 1.5, 0, b.mat('#2a1c12'), 6);
    const leaf = b.mat('#0b3d2a', '#062216', 1);
    const blobs = [[0, 3.8, 0, 1.7], [1.1, 3.3, 0.3, 1.1], [-1.0, 3.4, -0.4, 1.2], [0.2, 3.2, -1.1, 1.0]];
    const lights = [];
    for (const [x, y, z, r] of blobs) {
      b.ball(g, r, x, y, z, leaf);
      for (let i = 0; i < 14; i++) {
        // random point on the surface of the blob
        const u = b.rng() * 2 - 1, a = b.rng() * Math.PI * 2, q = Math.sqrt(1 - u * u);
        lights.push([x + q * Math.cos(a) * r * 0.95, y + u * r * 0.95, z + q * Math.sin(a) * r * 0.95]);
      }
    }
    b.dots(g, lights, s.colors || ['#ffd000', '#ff7a00', '#fff1c9'], 0.05);
    solid(0, 0, 0.6, 0.6, 0, 3);
  },

  /** Wedding mandap: four pillars, a canopy, marigold garlands and the sacred fire. */
  mandap(b, g, s, solid) {
    const half = (s.size || 5) / 2 - 0.3;
    const gold = b.mat('#d4a017', '#8a5a00', 0.8);
    const marigold = [];
    for (const [x, z] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
      b.cyl(g, 0.16, 0.2, 3.4, x, 1.7, z, gold, 8);
      b.box(g, 0.55, 0.4, 0.55, x, 0.2, z, b.mat('#7a1030', '#3a0818', 1));
      solid(x, z, 0.5, 0.5, 0, 3.4);
      for (let y = 0.5; y < 3.3; y += 0.22) marigold.push([x + Math.sin(y * 9) * 0.2, y, z + Math.cos(y * 9) * 0.2]); // spiral garland
    }
    for (const side of [-half, half]) {
      b.box(g, half * 2 + 0.4, 0.14, 0.14, 0, 3.4, side, gold);
      b.box(g, 0.14, 0.14, half * 2 + 0.4, side, 3.4, 0, gold);
      for (let t = -half; t <= half; t += 0.2) {
        const drop = Math.abs(Math.sin(t * 2.2)) * 0.5; // scalloped hanging garlands
        marigold.push([t, 3.25 - drop, side], [side, 3.25 - drop, t]);
      }
    }
    const canopy = b.cyl(g, 0.2, half * 1.55, 1.1, 0, 4.0, 0, b.mat('#b3122e', '#5a0816', 1), 4);
    canopy.rotation.y = Math.PI / 4;
    b.ball(g, 0.18, 0, 4.7, 0, b.glow('#ffd000'));
    b.dots(g, marigold, ['#ff9a00', '#ffc400', '#ff7a00'], 0.08);
    // havan kund — the fire pit in the middle
    b.box(g, 0.9, 0.35, 0.9, 0, 0.175, 0, b.mat('#5a2a14'));
    b.cyl(g, 0.0, 0.25, 0.6, 0, 0.65, 0, b.glow('#ff8a1a'), 5);
    b.cyl(g, 0.0, 0.14, 0.4, 0.05, 0.6, 0.05, b.glow('#ffe08a'), 5);
    solid(0, 0, 0.9, 0.9, 0, 0.4);
  },

  /** Wedding stage with a floral backdrop and two thrones. Options: w, d */
  stage(b, g, s, solid) {
    const w = s.w || 12, d = s.d || 4;
    b.box(g, w, 0.5, d, 0, 0.25, 0, b.mat('#4a0a1e', '#22040e', 1));
    b.box(g, w + 0.04, 0.06, d + 0.04, 0, 0.5, 0, b.glow('#ffd000'));
    b.box(g, w, 4.2, 0.3, 0, 2.6, -d / 2 + 0.15, b.mat('#2a0612', '#16030a', 1));
    solid(0, 0, w, d, 0, 0.5);
    solid(0, -d / 2 + 0.15, w, 0.3, 0, 4.7);
    // flower wall: a grid of glowing blossoms
    const flowers = [];
    for (let x = -w / 2 + 0.4; x < w / 2; x += 0.42) {
      for (let y = 0.9; y < 4.4; y += 0.42) {
        if (Math.abs(x) < 2.2 && y > 3.2) continue; // leave room for the sign
        flowers.push([x + (b.rng() - 0.5) * 0.15, y + (b.rng() - 0.5) * 0.15, -d / 2 + 0.34]);
      }
    }
    b.dots(g, flowers, ['#ff5fa2', '#ffd1e6', '#ff9a00', '#ffc400', '#ff2b6a'], 0.1);
    for (const x of [-1.1, 1.1]) {
      b.box(g, 1.3, 0.5, 1.0, x, 0.75, -0.6, b.mat('#8a0f2c', '#4a0816', 1));
      b.box(g, 1.3, 1.5, 0.2, x, 1.5, -1.05, b.mat('#8a0f2c', '#4a0816', 1));
      b.box(g, 1.4, 0.08, 0.24, x, 2.27, -1.05, b.glow('#ffd000'));
      solid(x, -0.6, 1.3, 1.0, 0, 1.0);
    }
  },

  /** Chandelier hanging from the ceiling. No collision. */
  chandelier(b, g, s) {
    const top = b.theme.ceiling || 7;
    const y = s.y ?? top - 1.6;
    b.box(g, 0.03, top - y, 0.03, 0, (top + y) / 2, 0, b.mat('#30281a'));
    b.cyl(g, 0.9, 0.5, 0.12, 0, y, 0, b.mat('#d4a017', '#8a5a00', 1), 10);
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      pts.push([Math.cos(a) * 0.9, y - 0.12, Math.sin(a) * 0.9], [Math.cos(a) * 0.5, y - 0.4, Math.sin(a) * 0.5]);
    }
    pts.push([0, y - 0.65, 0]);
    b.dots(g, pts, ['#fff1c9', '#ffd98a'], 0.07);
  },

  /** Buffet counter with glowing dishes. Options: len (along local X) */
  buffet(b, g, s, solid) {
    const len = s.len || 5;
    b.box(g, len, 0.95, 1, 0, 0.475, 0, b.mat('#e9e4d8', '#3a352c', 1));
    b.box(g, len + 0.04, 0.05, 1.04, 0, 0.95, 0, b.glow('#ffd000'));
    for (let x = -len / 2 + 0.6; x < len / 2; x += 0.9) {
      b.cyl(g, 0.28, 0.2, 0.18, x, 1.05, 0, b.mat('#b9c0cc', '#3a4250', 1), 8);
      b.cyl(g, 0.08, 0.1, 0.05, x, 0.99, 0.35, b.glow('#ff8a1a'), 6);
    }
    solid(0, 0, len, 1, 0, 0.97);
  },

  /** DJ booth with speakers. */
  dj(b, g, s, solid) {
    b.box(g, 3, 1.1, 1, 0, 0.55, 0, b.mat('#12121a'));
    b.box(g, 2.8, 0.5, 0.04, 0, 0.6, 0.51, b.glow('#ff2bd6'));
    b.box(g, 3.04, 0.05, 1.04, 0, 1.1, 0, b.glow('#00e5ff'));
    solid(0, 0, 3, 1, 0, 1.1);
    for (const x of [-2.3, 2.3]) {
      b.box(g, 1, 2.2, 0.9, x, 1.1, 0, b.mat('#0c0c12'));
      const cone1 = b.cyl(g, 0.32, 0.32, 0.04, x, 1.55, 0.46, b.mat('#2a2a36', '#ff2bd6', 0.5), 10);
      cone1.rotation.x = Math.PI / 2;
      const cone2 = b.cyl(g, 0.22, 0.22, 0.04, x, 0.7, 0.46, b.mat('#2a2a36', '#00e5ff', 0.5), 10);
      cone2.rotation.x = Math.PI / 2;
      solid(x, 0, 1, 0.9, 0, 2.2);
    }
  },
};

/** Build a level. Returns { root, world }. */
export function buildLevel(def) {
  const builder = new LevelBuilder(def).build();
  return { root: builder.root, world: builder.world };
}

/** Free the GPU memory used by a level when switching to another one. */
export function disposeLevel(root) {
  root.traverse((obj) => {
    if (obj.geometry && !obj.geometry.userData.shared) obj.geometry.dispose();
    if (obj.material) {
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}
