"use strict";

// Presentation helpers consume existing game events; they never change the rules.
(function (root) {
  const SOUND_STORAGE_KEY = "chug-chug-run.sound.v1";
  const SCORE_MILESTONES = Object.freeze([
    { score: 100, message: "100 POINTS! EVERY DROP COUNTS!" },
    { score: 250, message: "250 POINTS! GREAT COLLECTING!" },
    { score: 500, message: "500 POINTS! MAKING WAVES!" },
    { score: 1000, message: "1,000 POINTS! WHAT A RUN!" }
  ].map(Object.freeze));

  class ScoreMilestones {
    constructor() { this.reset(); }
    reset() { this.reached = new Set(); }
    check(score) {
      if (!Number.isFinite(score)) return [];
      const crossed = [];
      for (const milestone of SCORE_MILESTONES) {
        if (score >= milestone.score && !this.reached.has(milestone.score)) {
          this.reached.add(milestone.score);
          crossed.push(milestone);
        }
      }
      return crossed;
    }
  }

  // Each note is [delay, duration, starting Hz, ending Hz, waveform].
  const CUES = {
    screech: [[0, .22, 1500, 2600, "sawtooth"], [.18, .32, 2300, 650, "triangle"]],
    water: [[0, .09, 659, 988, "sine"], [.075, .12, 988, 1319, "sine"]],
    damage: [[0, .18, 180, 65, "triangle"]],
    full: [[0, .15, 523, 523, "sine"], [.12, .15, 659, 659, "sine"],
      [.24, .15, 784, 784, "sine"], [.36, .3, 1047, 1047, "sine"]]
  };

  class SoundEffects {
    constructor({ AudioContext = null, storage = null } = {}) {
      this.AudioContext = AudioContext;
      this.storage = storage;
      this.context = null;
      this.master = null;
      this.voices = new Set();
      this.unavailable = false;
      let preference = true;
      try { preference = storage?.getItem(SOUND_STORAGE_KEY) !== "off"; } catch { /* Optional preference. */ }
      this.enabled = this.supported && preference;
    }
    get supported() { return Boolean(this.AudioContext) && !this.unavailable; }
    setEnabled(enabled) {
      this.enabled = this.supported && Boolean(enabled);
      if (!this.enabled) this.stop();
      try { this.storage?.setItem(SOUND_STORAGE_KEY, this.enabled ? "on" : "off"); } catch { /* Keep the in-page choice. */ }
    }
    // Call only from Play, Resume, or Sound button activation, never on page load.
    async unlock() {
      if (!this.enabled || !this.supported) return false;
      if (!this.context) {
        try {
          this.context = new this.AudioContext();
          this.master = this.context.createGain();
          this.master.gain.setValueAtTime(.05, this.context.currentTime);
          this.master.connect(this.context.destination);
        } catch {
          this.unavailable = true;
          this.enabled = false;
          return false;
        }
      }
      try {
        if (this.context.state === "suspended") await this.context.resume();
      } catch { return false; } // A browser may still deny audio; gameplay continues.
      return this.enabled && this.context.state === "running";
    }
    release(voice) {
      voice.oscillator.disconnect();
      voice.gain.disconnect();
      this.voices.delete(voice);
    }
    stop() {
      for (const voice of this.voices) {
        try { voice.oscillator.stop(); } catch { /* It may already have ended. */ }
        this.release(voice);
      }
    }
    play(kind) {
      const notes = CUES[kind];
      if (!this.enabled || !notes || this.context?.state !== "running") return false;
      try {
        // Bound simultaneous nodes even if several drops are collected together.
        while (this.voices.size + notes.length > 16) {
          const oldest = this.voices.values().next().value;
          oldest.oscillator.stop();
          this.release(oldest);
        }
        const now = this.context.currentTime + .005;
        for (const [delay, duration, frequency, endFrequency, type] of notes) {
          const oscillator = this.context.createOscillator();
          const gain = this.context.createGain();
          const start = now + delay;
          oscillator.type = type;
          oscillator.frequency.setValueAtTime(frequency, start);
          oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(1, start + .008);
          gain.gain.exponentialRampToValueAtTime(.001, start + duration);
          oscillator.connect(gain);
          gain.connect(this.master);
          const voice = { oscillator, gain };
          this.voices.add(voice);
          oscillator.onended = () => this.release(voice);
          oscillator.start(start);
          oscillator.stop(start + duration + .015);
        }
      } catch {
        this.stop(); // Audio failure must never stop a run.
        return false;
      }
      return true;
    }
  }

  const api = { ScoreMilestones, SCORE_MILESTONES, SoundEffects, SOUND_STORAGE_KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChugGameFeedback = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
