'use strict';

global.window = {};
require('../public/calib.js');
const Calib = global.window.Calib;

const SR = 48000;
const REC_MS = 5200;
const N = Math.floor((SR * REC_MS) / 1000);

function makeChirp(sr, ms) {
  const len = Math.floor((sr * ms) / 1000);
  const out = new Float32Array(len);
  const f0 = 1800;
  const f1 = 5200;
  const T = ms / 1000;
  for (let i = 0; i < len; i++) {
    const u = i / len;
    const ph = 2 * Math.PI * T * (f0 * u + ((f1 - f0) * u * u) / 2);
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
    out[i] = Math.sin(ph) * w * 0.8;
  }
  return out;
}

function synth(planned, delays, opts) {
  opts = opts || {};
  const noise = opts.noise == null ? 0.012 : opts.noise;
  const reverb = opts.reverb !== false;
  const sig = new Float32Array(N);
  const chirp = makeChirp(SR, 80);
  const taps = [[0, 1.0], [11, 0.45], [27, 0.28], [49, 0.17], [83, 0.1]];

  planned.forEach((p, i) => {
    const base = Math.round(((p + delays[i]) * SR) / 1000);
    const use = reverb ? taps : [[0, 1.0]];
    use.forEach(([dms, g]) => {
      const off = Math.round((dms * SR) / 1000);
      for (let k = 0; k < chirp.length; k++) {
        const idx = base + off + k;
        if (idx >= 0 && idx < N) sig[idx] += chirp[k] * g * 0.45;
      }
    });
  });

  for (let i = 0; i < N; i++) {
    sig[i] += (Math.random() - 0.5) * noise;
    if (opts.hum) sig[i] += Math.sin((2 * Math.PI * 100 * i) / SR) * opts.hum;
  }
  return sig;
}

function runCase(label, planned, delays, opts) {
  const sig = synth(planned, delays, opts);
  const slots = planned.map((p, i) => ({
    id: 'd' + i,
    name: '设备' + i,
    role: i === 0 ? 'host' : 'listener',
    at: p
  }));
  const rec = { chunks: [sig], sr: SR, startPerf: 0 };
  const res = Calib._analyze(rec, slots, 0);

  let maxErr = 0;
  const got = [];
  res.forEach((r, i) => {
    const v = r.delayMs;
    got.push(v);
    if (v != null) maxErr = Math.max(maxErr, Math.abs(v - delays[i]));
  });

  const pass = maxErr <= 8;
  console.log(
    (pass ? '  PASS  ' : '  FAIL  ') + label.padEnd(26) +
    ' 期望 [' + delays.join(', ') + ']' +
    '  实测 [' + got.join(', ') + ']' +
    '  最大误差 ' + maxErr + 'ms'
  );
  return pass;
}

console.log('声学校准算法仿真测试（chirp 80ms / 2-5kHz）\n');

let pass = 0;
let total = 0;

const cases = [
  ['全部对齐', [800, 2100, 3400], [0, 0, 0], {}],
  ['典型偏差', [800, 2100, 3400], [0, 30, -15], {}],
  ['大偏差', [800, 2100, 3400], [5, 120, -80], {}],
  ['四台设备', [700, 2000, 3300, 4600], [12, -8, 55, 0], {}],
  ['强噪声', [800, 2100, 3400], [0, 30, -15], { noise: 0.06 }],
  ['无混响', [800, 2100, 3400], [0, 40, 20], { reverb: false }],
  ['带 100Hz 电源嗡声', [800, 2100, 3400], [0, 25, -30], { hum: 0.02 }]
];

for (const [label, planned, delays, opts] of cases) {
  total++;
  if (runCase(label, planned, delays, opts)) pass++;
}

console.log('\n' + pass + '/' + total + ' 通过');
process.exit(pass === total ? 0 : 1);
