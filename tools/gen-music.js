'use strict';

const fs = require('fs');
const path = require('path');

const SR = 44100;
const BPM = 100;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const BARS = 32;
const TOTAL = BARS * BAR;
const N = Math.ceil(SR * TOTAL);

const L = new Float32Array(N);
const R = new Float32Array(N);

function write(i, v, pan) {
  if (i < 0 || i >= N) return;
  const a = ((pan + 1) * Math.PI) / 4;
  L[i] += v * Math.cos(a);
  R[i] += v * Math.sin(a);
}

function kick(t0, gain) {
  const dur = 0.32;
  const start = Math.floor(t0 * SR);
  const n = Math.floor(SR * dur);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 46 + 130 * Math.exp(-t / 0.026);
    ph += (2 * Math.PI * f) / SR;
    const amp = Math.exp(-t / 0.105) * gain;
    let v = Math.sin(ph) * amp;
    v += (Math.random() - 0.5) * amp * Math.exp(-t / 0.003) * 0.45;
    write(start + i, v, 0);
  }
}

function snare(t0, gain) {
  const dur = 0.24;
  const start = Math.floor(t0 * SR);
  const n = Math.floor(SR * dur);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const noise = Math.random() * 2 - 1;
    hp = 0.86 * (hp + noise - prev);
    prev = noise;
    const amp = Math.exp(-t / 0.058) * gain;
    const tone = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.04) * gain * 0.32;
    write(start + i, hp * amp * 0.72 + tone, 0.06);
  }
}

function hat(t0, gain, open) {
  const dur = open ? 0.2 : 0.07;
  const start = Math.floor(t0 * SR);
  const n = Math.floor(SR * dur);
  let hp = 0;
  let prev = 0;
  const decay = open ? 0.075 : 0.017;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const noise = Math.random() * 2 - 1;
    hp = 0.93 * (hp + noise - prev);
    prev = noise;
    write(start + i, hp * Math.exp(-t / decay) * gain * 0.42, 0.32);
  }
}

function bass(t0, dur, freq, gain) {
  const start = Math.floor(t0 * SR);
  const n = Math.floor(SR * dur);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * freq) / SR;
    const env = Math.min(1, t / 0.009) * Math.exp(-t / (dur * 0.85));
    const v =
      Math.sin(ph) * 0.72 +
      Math.sin(ph * 2) * 0.17 +
      Math.sin(ph * 3) * 0.06;
    write(start + i, v * env * gain, 0);
  }
}

function pad(t0, dur, freqs, gain) {
  const start = Math.floor(t0 * SR);
  const n = Math.floor(SR * dur);
  const ph = freqs.map(() => Math.random() * Math.PI * 2);
  const detune = freqs.map(() => 1 + (Math.random() - 0.5) * 0.004);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.18) * Math.min(1, (dur - t) / 0.35);
    const amp = Math.max(0, env) * gain;
    for (let k = 0; k < freqs.length; k++) {
      ph[k] += (2 * Math.PI * freqs[k] * detune[k]) / SR;
      const v =
        Math.sin(ph[k]) * 0.2 +
        Math.sin(ph[k] * 2) * 0.055 +
        Math.sin(ph[k] * 3) * 0.022;
      write(start + i, v * amp, k_pan(k));
    }
  }
}

function k_pan(k) {
  return k === 0 ? -0.32 : k === 1 ? 0.32 : 0;
}

function lead(t0, dur, freq, gain) {
  const start = Math.floor(t0 * SR);
  const n = Math.floor(SR * dur);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * freq) / SR;
    const env = Math.min(1, t / 0.012) * Math.exp(-t / (dur * 0.6));
    const v =
      Math.sin(ph) * 0.52 +
      Math.sin(ph * 2) * 0.19 +
      Math.sin(ph * 3) * 0.1 +
      Math.sin(ph * 4) * 0.04;
    write(start + i, v * env * gain, -0.14);
  }
}

const CHORDS = ['Am', 'F', 'C', 'G'];

const PAD_NOTES = {
  Am: [220.0, 261.63, 329.63],
  F: [174.61, 220.0, 261.63],
  C: [261.63, 329.63, 392.0],
  G: [196.0, 246.94, 293.66]
};

const BASS_ROOT = { Am: 110.0, F: 87.31, C: 130.81, G: 98.0 };

const MELODY = {
  Am: [659.25, 523.25, 440.0, 523.25, 587.33, 523.25, 440.0, 392.0],
  F: [698.46, 523.25, 440.0, 523.25, 659.25, 587.33, 523.25, 440.0],
  C: [783.99, 659.25, 523.25, 659.25, 698.46, 659.25, 523.25, 440.0],
  G: [783.99, 698.46, 587.33, 698.46, 783.99, 880.0, 783.99, 698.46]
};

for (let bar = 0; bar < BARS; bar++) {
  const chord = CHORDS[bar % 4];
  const t0 = bar * BAR;
  const section = bar < 8 ? 'intro' : bar < 16 ? 'verse' : bar < 24 ? 'chorus' : 'outro';

  pad(t0, BAR * 0.98, PAD_NOTES[chord], section === 'chorus' ? 0.62 : 0.48);

  kick(t0, 0.82);
  kick(t0 + BEAT * 2, 0.76);
  if (section === 'chorus') kick(t0 + BEAT * 3.5, 0.5);

  for (let b = 0; b < 8; b++) {
    hat(t0 + (b * BEAT) / 2, b % 2 === 0 ? 0.3 : 0.17, false);
  }
  if (section === 'chorus' || section === 'outro') {
    hat(t0 + BEAT * 3.5, 0.2, true);
  }

  if (section === 'chorus') {
    snare(t0 + BEAT, 0.48);
    snare(t0 + BEAT * 3, 0.48);
  }

  if (section === 'verse' || section === 'chorus') {
    for (let b = 0; b < 4; b++) {
      bass(t0 + b * BEAT, BEAT * 0.88, BASS_ROOT[chord], 0.58);
    }
  }

  if (section === 'verse' || section === 'chorus') {
    const mel = MELODY[chord];
    const g = section === 'chorus' ? 0.44 : 0.34;
    for (let b = 0; b < 8; b++) {
      lead(t0 + (b * BEAT) / 2, BEAT * 0.44, mel[b], g);
    }
  }
}

function reverb(buf, amount) {
  const taps = [
    [0.0293, 0.2],
    [0.0437, 0.16],
    [0.0689, 0.12],
    [0.0991, 0.09],
    [0.1331, 0.065],
    [0.1733, 0.045]
  ];
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    let s = buf[i];
    for (let k = 0; k < taps.length; k++) {
      const j = i - Math.floor(taps[k][0] * SR);
      if (j >= 0) s += buf[j] * taps[k][1];
    }
    out[i] = s * (1 - amount) + buf[i] * amount;
  }
  return out;
}

const RL = reverb(L, 0.62);
const RR = reverb(R, 0.62);

const fadeStart = Math.floor((TOTAL - 7) * SR);
for (let i = fadeStart; i < N; i++) {
  const k = (N - i) / (N - fadeStart);
  const e = k * k;
  RL[i] *= e;
  RR[i] *= e;
}

let peak = 0;
for (let i = 0; i < N; i++) {
  const a = Math.abs(RL[i]);
  const b = Math.abs(RR[i]);
  if (a > peak) peak = a;
  if (b > peak) peak = b;
}
const norm = peak > 0 ? 0.9 / peak : 1;

const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  let l = RL[i] * norm;
  let r = RR[i] * norm;
  if (l > 1) l = 1;
  if (l < -1) l = -1;
  if (r > 1) r = 1;
  if (r < -1) r = -1;
  data.writeInt16LE(Math.round(l * 32767), i * 4);
  data.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const outDir = path.join(__dirname, '..', 'music');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '夜航 A小调 100BPM.wav');
fs.writeFileSync(outPath, Buffer.concat([header, data]));

const mb = fs.statSync(outPath).size / 1024 / 1024;
console.log('已生成:', outPath);
console.log('时长 ' + TOTAL.toFixed(1) + 's · 44.1kHz 立体声 · ' + mb.toFixed(1) + ' MB');
