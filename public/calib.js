(function () {
  'use strict';

  var CHIRP_MS = 80;
  var ac = null;
  var chirpBuf = null;

  function ensureCtx() {
    if (!ac) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ac = new C();
    }
    if (ac.state === 'suspended') {
      try { ac.resume(); } catch (e) {}
    }
    return ac;
  }

  function buildChirp() {
    var sr = ac.sampleRate;
    var len = Math.floor((sr * CHIRP_MS) / 1000);
    var buf = ac.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var f0 = 1800;
    var f1 = 5200;
    var T = CHIRP_MS / 1000;
    for (var i = 0; i < len; i++) {
      var u = i / len;
      var ph = 2 * Math.PI * T * (f0 * u + ((f1 - f0) * u * u) / 2);
      var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
      d[i] = Math.sin(ph) * w * 0.8;
    }
    return buf;
  }

  function playAt(perfTime) {
    var c = ensureCtx();
    if (!c) return null;
    if (!chirpBuf) chirpBuf = buildChirp();
    var src = c.createBufferSource();
    src.buffer = chirpBuf;
    var g = c.createGain();
    g.gain.value = 1;
    src.connect(g);
    g.connect(c.destination);
    var when = c.currentTime + (perfTime - performance.now()) / 1000;
    if (when < c.currentTime + 0.03) when = c.currentTime + 0.03;
    src.start(when);
    return { when: when };
  }

  function scheduleMine(slots, myId, clockOffset) {
    var mine = null;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].id === myId) mine = slots[i];
    }
    if (!mine) return;
    var target = mine.at - clockOffset;
    var wait = target - performance.now() - 900;
    if (wait > 0) {
      setTimeout(function () { playAt(target); }, wait);
    } else {
      playAt(target);
    }
  }

  function record(durationMs) {
    var c = ensureCtx();
    return new Promise(function (resolve, reject) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        reject(new Error('浏览器不允许麦克风。请用 http://localhost:8080 打开主机页面（局域网 IP 不是安全上下文，麦克风会被拒绝）'));
        return;
      }
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      }).then(function (stream) {
        var src = c.createMediaStreamSource(stream);
        var proc = c.createScriptProcessor(4096, 1, 1);
        var chunks = [];
        var startPerf = performance.now();
        var live = true;

        proc.onaudioprocess = function (e) {
          if (!live) return;
          chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };

        var mute = c.createGain();
        mute.gain.value = 0;
        src.connect(proc);
        proc.connect(mute);
        mute.connect(c.destination);

        setTimeout(function () {
          live = false;
          var sr = c.sampleRate;
          setTimeout(function () {
            try { proc.disconnect(); } catch (e) {}
            try { mute.disconnect(); } catch (e) {}
            try { src.disconnect(); } catch (e) {}
            try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
          }, 300);
          resolve({ chunks: chunks, sr: sr, startPerf: startPerf });
        }, durationMs);
      }).catch(reject);
    });
  }

  function lowpass(sig, sr, fc) {
    var rc = 1 / (2 * Math.PI * fc);
    var dt = 1 / sr;
    var a = dt / (rc + dt);
    var out = new Float32Array(sig.length);
    var y = 0;
    for (var i = 0; i < sig.length; i++) {
      y += a * (sig[i] - y);
      out[i] = y;
    }
    return out;
  }

  function highpass(sig, sr, fc) {
    var rc = 1 / (2 * Math.PI * fc);
    var dt = 1 / sr;
    var a = rc / (rc + dt);
    var out = new Float32Array(sig.length);
    var prevIn = sig.length ? sig[0] : 0;
    var prevOut = 0;
    for (var i = 0; i < sig.length; i++) {
      prevOut = a * (prevOut + sig[i] - prevIn);
      prevIn = sig[i];
      out[i] = prevOut;
    }
    return out;
  }

  function rmsEnv(sig, sr, targetSr) {
    var step = Math.max(1, Math.round(sr / targetSr));
    var n = Math.floor(sig.length / step);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0;
      var base = i * step;
      for (var j = 0; j < step; j++) {
        var v = sig[base + j];
        s += v * v;
      }
      out[i] = Math.sqrt(s / step);
    }
    return out;
  }

  function chirpRef() {
    var n = CHIRP_MS;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var u = i / n;
      var w = Math.sin(Math.PI * u);
      out[i] = w * w;
    }
    return out;
  }

  function findOnset(env, ref, center, radius, floor) {
    var lo = Math.max(0, center - radius);
    var hi = Math.min(env.length - ref.length - 1, center + radius);
    if (hi <= lo) return null;

    var best = -Infinity;
    var bestIdx = -1;
    var scores = [];
    for (var i = lo; i <= hi; i++) {
      var s = 0;
      for (var j = 0; j < ref.length; j++) {
        var v = env[i + j] - floor;
        if (v > 0) s += v * ref[j];
      }
      scores.push(s);
      if (s > best) { best = s; bestIdx = i; }
    }
    if (bestIdx < 0) return null;

    scores.sort(function (a, b) { return a - b; });
    var med = scores[Math.floor(scores.length / 2)];
    var ok = best > 0 && (med <= 0 ? best > 1e-7 : best / med > 2.0);
    return { idx: bestIdx, score: best, ok: ok };
  }

  function analyze(rec, slots, clockOffset) {
    var sr = rec.sr;
    var total = 0;
    var i;
    for (i = 0; i < rec.chunks.length; i++) total += rec.chunks[i].length;
    if (!total) return [];

    var sig = new Float32Array(total);
    var off = 0;
    for (i = 0; i < rec.chunks.length; i++) {
      sig.set(rec.chunks[i], off);
      off += rec.chunks[i].length;
    }

    var lp = lowpass(sig, sr, 6200);
    var hp = highpass(lp, sr, 1400);
    var env = rmsEnv(hp, sr, 1000);

    var sorted = Array.prototype.slice.call(env).sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(sorted.length * 0.55)];

    var ref = chirpRef();
    var results = [];

    for (i = 0; i < slots.length; i++) {
      var s = slots[i];
      var plannedMs = s.at - clockOffset - rec.startPerf;
      var center = Math.round(plannedMs);
      var hit = findOnset(env, ref, center, 500, floor);

      if (!hit || !hit.ok) {
        results.push({
          id: s.id, name: s.name, role: s.role,
          delayMs: null, plannedMs: Math.round(plannedMs)
        });
      } else {
        results.push({
          id: s.id, name: s.name, role: s.role,
          delayMs: Math.round(hit.idx - plannedMs),
          plannedMs: Math.round(plannedMs)
        });
      }
    }
    return results;
  }

  function run(payload, clockOffset, myId, opts) {
    opts = opts || {};
    var c = ensureCtx();
    if (!c) return Promise.reject(new Error('浏览器不支持 Web Audio'));

    var slots = payload.slots || [];
    if (!slots.length) return Promise.reject(new Error('没有可校准的设备'));

    if (!opts.record) {
      scheduleMine(slots, myId, clockOffset);
      return Promise.resolve(null);
    }

    var firstPerf = slots[0].at - clockOffset;
    var lastPerf = slots[slots.length - 1].at - clockOffset;
    var recStartTarget = firstPerf - 600;
    var dur = lastPerf + 900 - recStartTarget;

    var wait = recStartTarget - performance.now();
    if (wait < -800) {
      return Promise.reject(new Error('校准窗口已过期，再点一次'));
    }

    var gate = wait > 0
      ? new Promise(function (r) { setTimeout(r, wait); })
      : Promise.resolve();

    return gate.then(function () {
      if (opts.onProgress) opts.onProgress('正在录音…');
      var recP = record(dur + 500);
      scheduleMine(slots, myId, clockOffset);
      return recP;
    }).then(function (rec) {
      if (opts.onProgress) opts.onProgress('分析录音…');
      return analyze(rec, slots, clockOffset);
    });
  }

  window.Calib = {
    run: run,
    ensureCtx: ensureCtx,
    isSupported: function () {
      return !!(window.AudioContext || window.webkitAudioContext);
    },
    _analyze: analyze,
    _chirpRef: chirpRef
  };
})();
