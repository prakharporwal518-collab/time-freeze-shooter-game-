// ---------------------------------------------------------------------------
// player.js — first-person movement, mouse look, shooting, throwing, pickups.
//
// IMPORTANT: the player is the one thing that moves in REAL time. How much the
// player moves each frame is reported back as an "activity" number (0..1),
// which the TimeManager turns into the time scale for everything else.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createItemMesh, ITEM_LABEL } from './pickups.js';

const _forward = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();

export class Player {
  /** @param {import('./main.js').Game} game */
  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.pos = new THREE.Vector3(); // feet position (y is always 0)
    this.vel = new THREE.Vector3();
    this.yaw = 0; // left/right angle (radians). 0 = looking down -Z
    this.pitch = 0; // up/down angle
    this.alive = true;
    this.held = null; // { type, ammo } or null for bare hands
    this.cooldown = 0; // GAME seconds until the pistol can fire again

    // animation state
    this.turnSmooth = 0;
    this.bob = 0;
    this.stepDistance = 0;
    this.recoil = 0;
    this.punchAnim = 0;
    this.raise = 0; // weapon rises into view after a pickup
    this.deathAnim = 0;

    // The "view-model" is the weapon you see in your hand. It is a child of
    // the camera, so it automatically follows wherever you look.
    this.viewmodel = new THREE.Group();
    this.camera.add(this.viewmodel);
    this.viewMeshes = {};
    for (const type of ['pistol', 'bottle', 'plate']) {
      const m = createItemMesh(type);
      m.scale.setScalar(0.5); // world items are chunky so they're easy to spot; in the hand they'd fill the screen
      m.visible = false;
      this.viewmodel.add(m);
      this.viewMeshes[type] = m;
    }
    this.viewMeshes.plate.rotation.x = 0.5;
    // A simple fist for bare-handed punches.
    const fist = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.11),
      new THREE.MeshLambertMaterial({ color: 0x2a3340, emissive: 0x0d2630, flatShading: true }),
    );
    this.viewMeshes.fist = fist;
    this.viewmodel.add(fist);

    // Muzzle flash: a small bright quad at the barrel, visible for an instant.
    this.flash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.05, 0),
      new THREE.MeshBasicMaterial({ color: 0xfff2b0 }),
    );
    this.flash.position.set(0, 0.01, -0.17);
    this.flash.visible = false;
    this.viewmodel.add(this.flash);
    this.flashTimer = 0;
  }

  /** Put the player at the level's start point. */
  reset(spec) {
    this.pos.set(spec.x, 0, spec.z);
    this.vel.set(0, 0, 0);
    this.yaw = THREE.MathUtils.degToRad(spec.yaw || 0);
    this.pitch = 0;
    this.alive = true;
    this.cooldown = 0;
    this.recoil = 0;
    this.punchAnim = 0;
    this.deathAnim = 0;
    this.turnSmooth = 0;
    this.held = spec.weapon ? { type: spec.weapon, ammo: spec.ammo ?? CONFIG.pistol.ammo } : null;
    this.showHeld(this.held ? this.held.type : null);
    this.updateCamera(0);
  }

  /** Unit vector the player is looking along. */
  getForward(out = _forward) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** Which mesh is visible in the hand. Also driven by the replay. */
  showHeld(type) {
    for (const key in this.viewMeshes) this.viewMeshes[key].visible = key === (type || 'fist');
  }

  // --- per-frame updates ---------------------------------------------------------

  /**
   * Movement + look, in REAL time.
   * @returns {number} activity 0..1 — fed to the TimeManager
   */
  update(realDt) {
    const input = this.game.input;
    const P = CONFIG.player;

    // --- mouse look ---
    const { dx, dy } = input.consumeMouse();
    this.yaw -= dx * P.mouseSensitivity;
    this.pitch -= dy * P.mouseSensitivity;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch)); // can't look past straight up/down
    const turnSpeed = (Math.hypot(dx, dy) * P.mouseSensitivity) / Math.max(realDt, 1e-4); // rad/s
    this.turnSmooth += (turnSpeed - this.turnSmooth) * Math.min(1, realDt * 10);

    // --- keyboard movement ---
    let ix = 0, iz = 0;
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) ix += 1;
    if (input.isDown('KeyA') || input.isDown('ArrowLeft')) ix -= 1;
    if (input.isDown('KeyS') || input.isDown('ArrowDown')) iz += 1;
    if (input.isDown('KeyW') || input.isDown('ArrowUp')) iz -= 1;
    const len = Math.hypot(ix, iz);
    if (len > 0) { ix /= len; iz /= len; } // so diagonals aren't faster

    // Rotate the input by the yaw angle to get a world-space direction.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wishX = (ix * cos + iz * sin) * P.speed;
    const wishZ = (-ix * sin + iz * cos) * P.speed;

    // Ease the velocity towards the wished velocity (feels less robotic).
    const ease = Math.min(1, realDt * 14);
    this.vel.x += (wishX - this.vel.x) * ease;
    this.vel.z += (wishZ - this.vel.z) * ease;

    const beforeX = this.pos.x, beforeZ = this.pos.z;
    this.pos.x += this.vel.x * realDt;
    this.pos.z += this.vel.z * realDt;
    this.game.world.resolveCircle(this.pos, P.radius);

    // How far did we ACTUALLY move (walking into a wall doesn't count)?
    const moved = Math.hypot(this.pos.x - beforeX, this.pos.z - beforeZ);
    const moveActivity = Math.min(1, moved / Math.max(realDt, 1e-4) / P.speed);

    // Footsteps + head bob are driven by distance walked.
    this.bob += moved * 1.8;
    this.stepDistance += moved;
    if (this.stepDistance > 2.1) {
      this.stepDistance = 0;
      this.game.audio.footstep();
    }

    // Slowly looking around costs almost nothing; a fast flick advances time.
    const turnActivity = Math.max(0, Math.min(0.5, (this.turnSmooth - 1.0) / 6));

    this.updateCamera(realDt);
    return Math.max(moveActivity, turnActivity);
  }

  /** Things that run on GAME time: weapon cooldown and view-model animation. */
  tick(gameDt, realDt) {
    this.cooldown = Math.max(0, this.cooldown - gameDt);
    this.recoil = Math.max(0, this.recoil - gameDt * 3.2);
    this.punchAnim = Math.max(0, this.punchAnim - gameDt * 4);
    this.raise = Math.max(0, this.raise - realDt * 5);
    this.flashTimer -= gameDt;
    this.flash.visible = this.flashTimer > 0 && this.viewMeshes.pistol.visible;
    this.animateViewmodel();
  }

  updateCamera(realDt) {
    const bobY = Math.sin(this.bob * 2) * 0.035;
    this.camera.position.set(this.pos.x, CONFIG.player.eyeHeight + bobY, this.pos.z);
    // Order 'YXZ' = yaw first, then pitch. This is the standard FPS camera set-up.
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    if (!this.alive) {
      // Death: slump to the floor and tip over (real time, the world is frozen).
      this.deathAnim = Math.min(1, this.deathAnim + realDt * 1.8);
      const t = this.deathAnim * this.deathAnim * (3 - 2 * this.deathAnim); // smoothstep
      this.camera.position.y = CONFIG.player.eyeHeight - 1.15 * t;
      this.camera.rotation.z = 0.9 * t;
    }
  }

  animateViewmodel() {
    const vm = this.viewmodel;
    const sway = Math.sin(this.bob) * 0.012;
    vm.position.set(0.2 + sway, -0.17 - this.raise * 0.25 + Math.abs(Math.cos(this.bob)) * 0.008, -0.48 + this.recoil * 0.09 - this.punchAnim * 0.3);
    vm.rotation.set(this.recoil * 0.55, this.punchAnim * 0.5, 0);
  }

  // --- actions --------------------------------------------------------------------

  /** Is the player pointing something dangerous at this enemy? (Enemies dodge.) */
  isAimingAt(enemy) {
    if (!this.held || (this.held.type === 'pistol' && this.held.ammo <= 0)) return false;
    _to.set(enemy.pos.x - this.pos.x, 1.2 - CONFIG.player.eyeHeight, enemy.pos.z - this.pos.z);
    const dist = _to.length();
    if (dist > 25) return false;
    return _to.dot(this.getForward()) / dist > 0.99;
  }

  /** Left mouse button. */
  primary() {
    if (!this.alive) return;
    const game = this.game;

    if (!this.held) {
      // Bare hands: grab what we're looking at, otherwise punch.
      if (!this.tryPickup()) this.punch();
      return;
    }
    if (this.held.type !== 'pistol') {
      this.throwHeld(); // bottles and plates can only be thrown
      return;
    }
    if (this.cooldown > 0) return;
    if (this.held.ammo <= 0) {
      game.audio.emptyClick();
      game.ui.hint('EMPTY — RIGHT-CLICK TO THROW IT');
      return;
    }

    // --- fire the pistol ---
    this.held.ammo--;
    this.cooldown = CONFIG.pistol.cooldown;
    this.recoil = 1;
    this.flashTimer = 0.05;

    // The bullet leaves from the gun (lower right of the screen) but must hit
    // where the crosshair points. So aim from the muzzle at a point far along
    // the camera's line of sight.
    const fwd = this.getForward();
    const camPos = this.camera.position;
    const wallDist = game.world.raycast(camPos.x, camPos.y, camPos.z, fwd.x, fwd.y, fwd.z, 60);
    _aimPoint.copy(camPos).addScaledVector(fwd, Math.max(4, Math.min(wallDist, 60)));
    _muzzle.set(0.2, -0.14, -0.6).applyQuaternion(this.camera.quaternion).add(camPos);
    // If we're hugging a wall the muzzle could be inside it; fall back to the eye.
    if (!game.world.lineOfSight(camPos.x, camPos.y, camPos.z, _muzzle.x, _muzzle.y, _muzzle.z)) _muzzle.copy(camPos);
    _dir.copy(_aimPoint).sub(_muzzle).normalize();

    game.bullets.spawn(_muzzle, _dir, CONFIG.pistol.bulletSpeed, 'player');
    game.fx('shot', { pos: [_muzzle.x, _muzzle.y, _muzzle.z], owner: 'player' });
    game.time.kick(); // shooting costs time
  }

  /** Right mouse button: throw whatever is in hand. */
  throwHeld() {
    if (!this.alive || !this.held) return;
    const game = this.game;
    const fwd = this.getForward();
    const camPos = this.camera.position;
    const start = new THREE.Vector3().copy(camPos).addScaledVector(fwd, 0.45);
    start.y -= 0.1;
    // Standing nose-to-wall? Start the throw at the eye so it can't tunnel through.
    if (!game.world.lineOfSight(camPos.x, camPos.y, camPos.z, start.x, start.y, start.z)) start.copy(camPos);
    const vel = new THREE.Vector3().copy(fwd).multiplyScalar(19);
    vel.y += 1.2;
    game.items.spawn(this.held.type, start, { state: 'thrown', vel, ammo: this.held.ammo });
    this.held = null;
    this.showHeld(null);
    this.punchAnim = 1;
    game.fx('throw', { pos: [start.x, start.y, start.z] });
    game.time.kick();
  }

  /** E key (or left-click with empty hands). Swaps if already holding something. */
  tryPickup() {
    if (!this.alive) return false;
    const game = this.game;
    const target = game.items.findTarget(this.camera.position, this.getForward());
    if (!target) return false;

    if (this.held) {
      // Drop the current item at our feet.
      const drop = new THREE.Vector3(this.pos.x, 1.0, this.pos.z);
      game.items.spawn(this.held.type, drop, { state: 'flying', ammo: this.held.ammo });
    }
    this.held = { type: target.type, ammo: target.ammo };
    game.items.remove(target);
    this.showHeld(this.held.type);
    this.raise = 1;
    this.cooldown = 0;
    game.fx('pickup', {});
    game.time.kick(0.12);
    return true;
  }

  /** Bare-handed attack: first punch stuns, punching a stunned enemy shatters it. */
  punch() {
    if (this.punchAnim > 0.3) return;
    const game = this.game;
    this.punchAnim = 1;
    game.time.kick();
    game.fx('punch', { pos: [this.pos.x, 1.3, this.pos.z] });

    const fwd = this.getForward();
    let best = null, bestDist = CONFIG.player.punchRange;
    for (const e of game.enemies) {
      if (!e.targetable) continue;
      _to.set(e.pos.x - this.pos.x, 0, e.pos.z - this.pos.z);
      const dist = _to.length();
      if (dist > bestDist) continue;
      // must be roughly in front of us
      if ((_to.x * fwd.x + _to.z * fwd.z) / Math.max(dist, 0.001) < 0.6) continue;
      best = e;
      bestDist = dist;
    }
    if (!best) return;
    if (best.stunTimer > 0) best.die(fwd);
    else best.stun(1.6, fwd);
  }

  /** Text for the ammo counter. */
  ammoText() {
    if (!this.held) return 'FISTS';
    if (this.held.type === 'pistol') return `${this.held.ammo}`;
    return ITEM_LABEL[this.held.type];
  }
}
