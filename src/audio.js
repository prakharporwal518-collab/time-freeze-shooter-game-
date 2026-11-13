// ---------------------------------------------------------------------------
// audio.js — every sound is SYNTHESISED with the Web Audio API. No files.
//
// All sounds are built from two ingredients:
//   * noise — random samples, shaped by a filter (gunshots, glass, footsteps)
//   * tones — an oscillator whose pitch slides over time (thumps, chimes)
// each wrapped in a gain "envelope" that fades the sound out.
//
// Sounds are pitched down when time is slow, so the world SOUNDS frozen too.
// ---------------------------------------------------------------------------

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.pitch = 1; // follows the time scale
    this.freeze = 0;
    this.heartTimer = 0;
  }

  /** Browsers only allow audio after a user gesture, so call this from a click. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();

    // master volume -> compressor (stops loud overlaps from clipping) -> speakers
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);

    // One second of white noise, reused by every noisy sound.
    const len = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, len, len);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // A quiet low drone for atmosphere. Its filter closes when time freezes.
    this.droneFilter = this.ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 300;
    const droneGain = this.ctx.createGain();
    droneGain.gain.value = 0.05;
    this.droneFilter.connect(droneGain).connect(this.master);
    for (const freq of [55, 82.5, 110.5]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.connect(this.droneFilter);
      osc.start();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.7;
    return this.muted;
  }

  // --- building blocks ---------------------------------------------------------

  /** A burst of filtered noise. */
  noise(duration, { type = 'bandpass', freq = 1000, q = 1, gain = 0.5, delay = 0, pitched = true } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq * (pitched ? this.pitch : 1);
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t, Math.random()); // random offset so two bursts never sound identical
    src.stop(t + duration + 0.02);
  }

  /** A tone that slides from `freq` to `endFreq`. */
  tone(freq, endFreq, duration, { type = 'sine', gain = 0.4, delay = 0, pitched = true } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const p = pitched ? this.pitch : 1;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * p, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq * p), t + duration);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  // --- the actual sound effects --------------------------------------------------

  gunshot(byPlayer = true) {
    // crack (bright noise) + body (mid noise) + thump (falling sine)
    this.noise(0.09, { type: 'highpass', freq: 2500, gain: byPlayer ? 0.5 : 0.3 });
    this.noise(0.22, { type: 'bandpass', freq: byPlayer ? 900 : 600, q: 0.7, gain: byPlayer ? 0.7 : 0.45 });
    this.tone(byPlayer ? 190 : 140, 40, 0.2, { gain: byPlayer ? 0.7 : 0.45 });
  }

  /** An enemy bursting into shards: several glassy pings over a crunch. */
  shatter() {
    this.noise(0.35, { type: 'highpass', freq: 3200, gain: 0.45 });
    this.noise(0.18, { type: 'bandpass', freq: 500, q: 0.8, gain: 0.5 });
    for (let i = 0; i < 7; i++) {
      const f = 1400 + Math.random() * 3800;
      this.tone(f, f * 0.8, 0.12 + Math.random() * 0.25, { type: 'triangle', gain: 0.1, delay: Math.random() * 0.14 });
    }
  }

  /** A bottle or plate breaking — a smaller, brighter shatter. */
  glass() {
    this.noise(0.2, { type: 'highpass', freq: 4500, gain: 0.35 });
    for (let i = 0; i < 4; i++) {
      const f = 2500 + Math.random() * 4000;
      this.tone(f, f * 0.9, 0.1 + Math.random() * 0.15, { type: 'triangle', gain: 0.08, delay: Math.random() * 0.08 });
    }
  }

  footstep() {
    this.noise(0.07, { type: 'lowpass', freq: 380 + Math.random() * 160, gain: 0.3, pitched: false });
    this.tone(85, 50, 0.06, { gain: 0.16, pitched: false });
  }

  /** "lub-dub". Played on a timer by update() while time is slow. */
  heartbeat(volume) {
    this.tone(62, 38, 0.14, { gain: 0.9 * volume, pitched: false });
    this.tone(54, 34, 0.16, { gain: 0.65 * volume, delay: 0.19, pitched: false });
  }

  pickup() {
    this.tone(520, 880, 0.08, { type: 'square', gain: 0.1, pitched: false });
    this.noise(0.04, { type: 'highpass', freq: 3000, gain: 0.15, pitched: false });
  }

  emptyClick() {
    this.noise(0.03, { type: 'bandpass', freq: 2200, q: 3, gain: 0.3, pitched: false });
  }

  whoosh() {
    this.noise(0.22, { type: 'bandpass', freq: 700, q: 1.5, gain: 0.3 });
  }

  punch() {
    this.noise(0.08, { type: 'lowpass', freq: 500, gain: 0.6 });
    this.tone(120, 50, 0.1, { gain: 0.5 });
  }

  spawn() {
    this.tone(180, 720, 0.25, { type: 'sawtooth', gain: 0.07 });
  }

  death() {
    this.tone(220, 28, 1.1, { type: 'sawtooth', gain: 0.4, pitched: false });
    this.noise(0.5, { type: 'lowpass', freq: 700, gain: 0.5, pitched: false });
  }

  levelClear() {
    // a rising arpeggio
    [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(f, f, 0.5, { type: 'triangle', gain: 0.18, delay: i * 0.09, pitched: false });
    });
  }

  uiClick() {
    this.tone(660, 440, 0.06, { type: 'square', gain: 0.07, pitched: false });
  }

  // --- per-frame update ------------------------------------------------------------

  /**
   * @param {number} realDt
   * @param {number} timeScale current time scale (for pitch)
   * @param {number} freeze    0..1 how frozen time is
   * @param {boolean} heartbeatOn play the slow-time heartbeat?
   */
  update(realDt, timeScale, freeze, heartbeatOn) {
    this.pitch = 0.5 + 0.5 * timeScale;
    this.freeze = freeze;
    if (!this.ctx) return;

    // Muffle the drone while frozen (setTargetAtTime = smooth, click-free change).
    this.droneFilter.frequency.setTargetAtTime(120 + 500 * timeScale, this.ctx.currentTime, 0.1);

    if (heartbeatOn && freeze > 0.5) {
      this.heartTimer -= realDt;
      if (this.heartTimer <= 0) {
        this.heartbeat(freeze);
        this.heartTimer = 1.05;
      }
    } else {
      this.heartTimer = Math.min(this.heartTimer, 0.25);
    }
  }
}
