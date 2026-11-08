'use strict';

const fs = require('fs');
const path = require('path');

const SR = 44100;
const DUR = 60;
const N = SR * DUR;
const buf = new Float32Array(N);

const chord = [130.81, 164.81, 196.0, 261.63];
for (let i = 0; i < N; i++) {
  const t = i / SR;
  let v = 0;
  for (let c = 0; c < chord.length; c++) {
    v += Math.sin(2 * Math.PI * chord[c] * t) * 0.055;
    v += Math.sin(2 * Math.PI * chord[c] * 2 * t) * 0.012;
  }
  const swell = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.25 * t);
  buf[i] = v * swell;
}

const BPM = 120;
const beat = 60 / BPM;
const totalBeats = Math.floor(DUR / beat);
for (let b = 0; b < totalBeats; b++) {
  const start = Math.floor(b * beat * SR);
  const accent = b % 4 === 0;
  const gain = accent ? 0.42 : 0.26;
  const freq = accent ? 1600 : 1100;
  const decay = accent ? 180 : 120;
  for (let k = 0; k < 2600; k++) {
    const idx = start + k;
    if (idx >= N) break;
    const env = Math.exp(-k / decay);
    buf[idx] += Math.sin((2 * Math.PI * freq * k) / SR) * env * gain;
  }
}

const data = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  let v = buf[i];
  if (v > 1) v = 1;
  if (v < -1) v = -1;
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const outDir = path.join(__dirname, '..', 'music');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '同步测试 120BPM.wav');
fs.writeFileSync(outPath, Buffer.concat([header, data]));
console.log('已生成:', outPath, (fs.statSync(outPath).size / 1024 / 1024).toFixed(1) + ' MB');
