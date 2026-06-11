// Beeps (WebAudio) + Arabic speech. Audio must be unlocked by a user gesture
// (iOS rule) — call unlock() from the start button handler.

export class Sounder {
  constructor() {
    this.ctx = null;
    this.sound = true;
    this.voice = true;
    this.voiceObj = null;
    this._lastSpeak = {};
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    // warm up speechSynthesis inside the gesture so later utterances play
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
      this._pickVoice();
      speechSynthesis.onvoiceschanged = () => this._pickVoice();
    }
  }

  _pickVoice() {
    const vs = speechSynthesis.getVoices();
    this.voiceObj =
      vs.find((v) => /^ar(-|_)?(SA)?/i.test(v.lang) && /sa/i.test(v.lang)) ||
      vs.find((v) => /^ar/i.test(v.lang)) ||
      null;
  }

  _tone(freq, t0, dur, type = "sine", gain = 0.5) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.setValueAtTime(gain, t0 + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  beeps(freq, count, dur = 0.12, gap = 0.1, type = "sine") {
    if (!this.sound || !this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    for (let i = 0; i < count; i++) this._tone(freq, t + i * (dur + gap), dur, type);
  }

  announce() { this.beeps(880, 2); }
  urgent()   { this.beeps(1175, 3, 0.1, 0.07); }

  overspeed() {
    if (!this.sound || !this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(330, t);
    o.frequency.linearRampToValueAtTime(660, t + 0.35);
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.03);
    g.gain.linearRampToValueAtTime(0, t + 0.4);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + 0.45);
  }

  ok() { this.beeps(660, 1, 0.09); }

  // category-level cooldown so TTS never stacks or babbles
  speak(text, category = "x", cooldownMs = 6000) {
    if (!this.voice || !("speechSynthesis" in window)) return;
    const now = Date.now();
    if (now - (this._lastSpeak[category] || 0) < cooldownMs) return;
    this._lastSpeak[category] = now;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voiceObj) u.voice = this.voiceObj;
    u.lang = this.voiceObj ? this.voiceObj.lang : "ar-SA";
    u.rate = 1.05;
    u.volume = 1;
    speechSynthesis.speak(u);
  }
}
