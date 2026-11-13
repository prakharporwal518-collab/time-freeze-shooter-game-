// ---------------------------------------------------------------------------
// ui.js — everything that is HTML rather than 3D: menus, HUD, banners.
//
// The game never touches the DOM directly; it calls small methods on this
// class (ui.showScreen('death'), ui.setHud(…)). That keeps game logic and
// presentation separate.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

export class UI {
  /**
   * @param {(action: string, arg?: any) => void} onAction called when a menu button is clicked
   */
  constructor(onAction) {
    this.onAction = onAction;
    this.screens = {};
    for (const name of ['menu', 'levels', 'controls', 'pause', 'death', 'win']) {
      this.screens[name] = $(`screen-${name}`);
    }
    this.hud = $('hud');
    this.banner = $('banner');
    this.replay = $('replay');
    this.bannerTimer = null;
    this.hintTimer = null;
    this.cache = {}; // last values written, so we only touch the DOM when something changed

    // One click listener for every button with a data-action attribute
    // ("event delegation" — no need to wire each button separately).
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      this.onAction(btn.dataset.action, btn.dataset.arg);
    });
  }

  /** Show one full-screen menu (or none with null). */
  showScreen(name) {
    for (const key in this.screens) this.screens[key].classList.toggle('hidden', key !== name);
  }

  setHudVisible(visible) {
    this.hud.classList.toggle('hidden', !visible);
  }

  /** Update the HUD text. Cheap to call every frame. */
  setHud({ level, name, enemies, ammo, ammoLabel, empty }) {
    this.setText('hud-level', `LEVEL ${level} · ${name}`);
    this.setText('hud-enemies', `ENEMIES ${enemies}`);
    this.setText('ammo-value', ammo);
    this.setText('ammo-label', ammoLabel);
    if (this.cache.empty !== empty) {
      this.cache.empty = empty;
      $('hud-ammo').classList.toggle('empty', empty);
    }
  }

  setText(id, text) {
    if (this.cache[id] === text) return;
    this.cache[id] = text;
    $(id).textContent = text;
  }

  /** Fade the "TIME FROZEN" indicator in and out. @param {number} freeze 0..1 */
  setFreeze(freeze) {
    const v = Math.round(Math.max(0, (freeze - 0.5) * 2) * 20) / 20; // quantised to avoid needless style writes
    if (this.cache.freeze === v) return;
    this.cache.freeze = v;
    $('hud-frozen').style.opacity = v;
  }

  /** Small text under the crosshair, e.g. "[E] PICK UP PISTOL". */
  setPrompt(text) {
    this.setText('hud-prompt', text || '');
  }

  /** A temporary yellow hint. */
  hint(text, seconds = 2) {
    const el = $('hud-hint');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => el.classList.remove('show'), seconds * 1000);
  }

  /** Big centre-screen message. seconds = 0 keeps it until hideBanner(). */
  showBanner(title, sub = '', seconds = 2, hindi = '') {
    $('banner-title').textContent = title;
    $('banner-sub').textContent = sub;
    $('banner-hindi').textContent = hindi; // separate line: letter-spacing would break Devanagari apart
    this.banner.classList.remove('hidden');
    // restart the CSS pop animation
    this.banner.style.animation = 'none';
    void this.banner.offsetWidth;
    this.banner.style.animation = '';
    clearTimeout(this.bannerTimer);
    if (seconds > 0) this.bannerTimer = setTimeout(() => this.hideBanner(), seconds * 1000);
  }

  hideBanner() {
    clearTimeout(this.bannerTimer);
    this.banner.classList.add('hidden');
  }

  setReplayVisible(visible) {
    this.replay.classList.toggle('hidden', !visible);
  }

  setReplayProgress(p) {
    $('replay-progress-fill').style.width = `${(p * 100).toFixed(1)}%`;
  }

  /** Build the level-select buttons. Locked levels are disabled. */
  buildLevelSelect(levels, unlockedCount) {
    const grid = $('level-grid');
    grid.innerHTML = '';
    levels.forEach((lvl, i) => {
      const btn = document.createElement('button');
      btn.dataset.action = 'play';
      btn.dataset.arg = String(i);
      btn.disabled = i >= unlockedCount;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = btn.disabled ? '🔒' : String(i + 1);
      const hindi = document.createElement('span');
      hindi.className = 'hindi';
      hindi.textContent = lvl.hindi || '';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = lvl.name;
      btn.append(num, hindi, name);
      grid.append(btn);
    });
  }
}
