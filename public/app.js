(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var role = 'listener';
  var unlocked = false;
  var clockOffset = 0;
  var samples = [];
  var rttLog = [];
  var remote = null;
  var tracks = [];
  var scheduleToken = 0;
  var lastReport = 0;
  var wakeLock = null;
  var joinUrl = '';
  var es = null;
  var diagOpen = false;

  var delayComp = Number(localStorage.getItem('ps_delay') || 0);

  var ac = null;
  var master = null;
  var buffers = {};
  var bufOrder = [];
  var loading = {};
  var srcNode = null;
  var seg = null;
  var perfRef = 0;
  var ctxRef = 0;
  var loadedDuration = 0;
  var loadState = '';

  var engine = {
    startErrorMs: null,
    lastDrift: 0,
    history: [],
    rateHold: 0
  };

  var myId = (function () {
    var v = localStorage.getItem('ps_id');
    if (!v) {
      v = 'd' + Math.random().toString(36).slice(2, 9);
      localStorage.setItem('ps_id', v);
    }
    return v;
  })();

  var myName = (function () {
    var ua = navigator.userAgent;
    var base = '设备';
    if (/iPhone/i.test(ua)) base = 'iPhone';
    else if (/iPad/i.test(ua)) base = 'iPad';
    else if (/Android/i.test(ua)) base = 'Android';
    else if (/Macintosh/i.test(ua)) base = 'Mac';
    else if (/Windows/i.test(ua)) base = 'Windows';
    return base + '-' + myId.slice(-3).toUpperCase();
  })();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function fmtSize(b) {
    if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function sign(v) {
    return (v > 0 ? '+' : '') + v;
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); }).catch(function () { return null; });
  }

  function report(data) {
    var now = Date.now();
    if (now - lastReport < 2000) return;
    lastReport = now;
    var payload = { id: myId };
    for (var k in data) payload[k] = data[k];
    fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function () {});
  }

  function serverNow() {
    return performance.now() + clockOffset;
  }

  function setConn(ok) {
    var c = $('#conn');
    c.classList.toggle('online', !!ok);
    $('#statusText').textContent = ok ? '已同步' : '重连中';
  }

  function ping() {
    var t0 = performance.now();
    return fetch('/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t0: t0 }),
      cache: 'no-store'
    }).then(function (r) { return r.json(); }).then(function (d) {
      var t1 = performance.now();
      var rtt = t1 - t0;
      var off = d.ts - (t0 + rtt / 2);
      samples.push({ rtt: rtt, off: off });
      if (samples.length > 15) samples.shift();

      rttLog.push(rtt);
      if (rttLog.length > 30) rttLog.shift();

      var best = samples.slice().sort(function (a, b) { return a.rtt - b.rtt; }).slice(0, 3);
      var sum = 0;
      for (var i = 0; i < best.length; i++) sum += best[i].off;
      clockOffset = sum / best.length;

      $('#mRtt').textContent = Math.round(rtt) + ' ms';
      var gs = $('#gateSync');
      if (gs) gs.textContent = '时钟已校准 · 往返 ' + Math.round(rtt) + ' ms';

      var dr = $('#dRtt');
      if (dr) dr.textContent = Math.round(rtt) + ' ms';
      var drm = $('#dRttMin');
      if (drm) drm.textContent = Math.round(Math.min.apply(null, rttLog)) + ' ms';
      var dof = $('#dOffset');
      if (dof) dof.textContent = Math.round(clockOffset) + ' ms';

      report({ rtt: Math.round(rtt) });
    }).catch(function () {});
  }

  function ensureAudio() {
    if (!ac) {
      if (window.Calib) ac = window.Calib.ensureCtx();
      if (!ac) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ac = new C();
      }
      master = ac.createGain();
      master.gain.value = 0.9;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') {
      try { ac.resume(); } catch (e) {}
    }
    return ac;
  }

  function refreshCtxMap() {
    if (!ac) return;
    perfRef = performance.now();
    ctxRef = ac.currentTime;
  }

  function serverToCtx(serverMs) {
    var perfMs = serverMs - clockOffset;
    return ctxRef + (perfMs - perfRef) / 1000;
  }

  function findTrack(id) {
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].id === id) return tracks[i];
    }
    return null;
  }

  function cacheBuffer(id, buf) {
    buffers[id] = buf;
    var idx = bufOrder.indexOf(id);
    if (idx >= 0) bufOrder.splice(idx, 1);
    bufOrder.push(id);
    while (bufOrder.length > 3) {
      var old = bufOrder[0];
      if (seg && seg.bufId === old) {
        bufOrder.push(bufOrder.shift());
        break;
      }
      delete buffers[old];
      bufOrder.shift();
    }
  }

  function loadBuffer(id) {
    if (buffers[id]) return Promise.resolve(buffers[id]);
    if (loading[id]) return loading[id];
    var track = findTrack(id);
    if (!track) return Promise.reject(new Error('曲库里没有这首'));

    ensureAudio();
    loadState = '下载中';
    var p = fetch(track.url, { cache: 'force-cache' })
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (ab) {
        loadState = '解码中';
        return ac.decodeAudioData(ab);
      })
      .then(function (buf) {
        cacheBuffer(id, buf);
        delete loading[id];
        loadState = '';
        return buf;
      })
      .catch(function (e) {
        delete loading[id];
        loadState = '';
        throw e;
      });

    loading[id] = p;
    return p;
  }

  function stopSource() {
    if (srcNode) {
      try { srcNode.onended = null; } catch (e) {}
      try { srcNode.stop(); } catch (e) {}
      try { srcNode.disconnect(); } catch (e) {}
      srcNode = null;
    }
  }

  function playPos() {
    if (!seg) return 0;
    if (!seg.playing || !srcNode) return seg.pausedAt || 0;
    var elapsed = ac.currentTime - seg.startCtx;
    if (elapsed < 0) return seg.startOffset;
    return seg.startOffset + elapsed * seg.rate;
  }

  function setRate(r) {
    if (!srcNode || !seg || !seg.playing) return;
    r = Math.max(0.95, Math.min(1.05, r));
    if (Math.abs(seg.rate - r) < 0.002) return;
    seg.startOffset = playPos();
    seg.startCtx = ac.currentTime;
    seg.rate = r;
    try {
      srcNode.playbackRate.setTargetAtTime(r, ac.currentTime, 0.05);
    } catch (e) {
      srcNode.playbackRate.value = r;
    }
  }

  function attachEnded(node) {
    node.onended = function () {
      if (srcNode === node && seg) {
        seg.playing = false;
        seg.pausedAt = loadedDuration;
      }
    };
  }

  function startSource(buf, whenCtx, offset, token) {
    stopSource();
    var s = ac.createBufferSource();
    s.buffer = buf;
    s.connect(master);
    s.playbackRate.value = 1;
    s.start(whenCtx, Math.max(0, offset));

    srcNode = s;
    seg = {
      buf: buf,
      bufId: remote ? remote.trackId : '',
      startCtx: whenCtx,
      startOffset: Math.max(0, offset),
      rate: 1,
      playing: true,
      pausedAt: 0
    };
    attachEnded(s);

    var delayMs = (whenCtx - ac.currentTime) * 1000;
    if (delayMs > 0) {
      setTimeout(function () {
        if (token !== scheduleToken) return;
        engine.startErrorMs = (ac.currentTime - whenCtx) * 1000;
      }, delayMs + 30);
    } else {
      engine.startErrorMs = (ac.currentTime - whenCtx) * 1000;
    }
  }

  function hardSeek(pos) {
    if (!seg || !seg.buf) return;
    ensureAudio();
    refreshCtxMap();
    pos = Math.max(0, Math.min(seg.buf.duration - 0.05, pos));
    var when = ac.currentTime + 0.08;

    var s = ac.createBufferSource();
    s.buffer = seg.buf;
    s.connect(master);
    s.playbackRate.value = 1;
    s.start(when, pos);

    var old = srcNode;
    if (old) {
      try { old.onended = null; } catch (e) {}
      try { old.stop(when); } catch (e) {}
    }

    srcNode = s;
    seg.startCtx = when;
    seg.startOffset = pos;
    seg.rate = 1;
    seg.playing = true;
    attachEnded(s);
  }

  function pausePlayback() {
    if (!seg) return;
    seg.pausedAt = playPos();
    seg.playing = false;
    stopSource();
  }

  function schedulePlayback(s) {
    if (!unlocked) return;
    var token = ++scheduleToken;
    var track = findTrack(s.trackId);
    if (!track) return;

    ensureAudio();
    engine.startErrorMs = null;
    engine.rateHold = 0;

    loadBuffer(s.trackId).then(function (buf) {
      if (token !== scheduleToken) return;
      loadedDuration = buf.duration;
      refreshCtxMap();

      var now = ac.currentTime;
      var whenCtx = serverToCtx(s.startAt);
      var offset = s.position || 0;

      if (whenCtx < now) {
        offset += now - whenCtx;
        whenCtx = now + 0.02;
      }
      if (offset >= buf.duration - 0.1) {
        offset = Math.max(0, buf.duration - 0.5);
      }
      startSource(buf, whenCtx, offset, token);
      refreshUI();
    }).catch(function (e) {
      if (token !== scheduleToken) return;
      toast('加载失败：' + ((e && e.message) || '未知'));
      loadState = '';
    });
  }

  function applyRemote(s) {
    var prev = remote;
    remote = s;

    if (master) master.gain.value = typeof s.volume === 'number' ? s.volume : 0.9;

    if (!s.trackId) {
      pausePlayback();
      refreshUI();
      return;
    }

    var newSegment = !prev ||
      prev.trackId !== s.trackId ||
      prev.startAt !== s.startAt ||
      prev.playing !== s.playing;

    if (!s.playing) {
      pausePlayback();
    } else if (newSegment) {
      schedulePlayback(s);
    }

    refreshUI();
  }

  function currentPos() {
    if (!remote || !remote.trackId) return 0;
    var base = remote.position || 0;
    if (!remote.playing) return base;
    var v = base + (serverNow() - remote.startAt) / 1000;
    return v < base ? base : v;
  }

  function expectedPos() {
    var v = currentPos() - delayComp / 1000;
    return v < 0 ? 0 : v;
  }

  function refreshUI() {
    var has = !!(remote && remote.trackId);
    var name = '等待主机放歌';
    if (has) {
      name = remote.trackId;
      var t = findTrack(remote.trackId);
      if (t) name = t.name;
      name = name.replace(/\.[^.]+$/, '');
    }

    var sn = $('#songName');
    if (sn) sn.textContent = has ? name : '等待主机放歌';

    var bt = $('#btnToggleRemote');
    if (bt) {
      bt.textContent = remote && remote.playing ? '暂停' : '继续';
      bt.disabled = !has;
    }

    var hs = $('#hSong');
    if (hs) hs.textContent = has ? name : '还没有播放内容';

    var ht = $('#hToggle');
    if (ht) {
      ht.textContent = remote && remote.playing ? '暂停' : '播放';
      ht.disabled = !has && tracks.length === 0;
    }

    var hl = $('#hLead');
    if (hl) {
      if (!has) hl.textContent = tracks.length ? '选一首歌开始' : '先上传音乐';
      else if (loadState) hl.textContent = loadState + '…';
      else if (remote.playing) hl.textContent = '同步中 · 起播延后约 3 秒';
      else hl.textContent = '已暂停';
    }

    var hv = $('#hVol');
    if (hv && document.activeElement !== hv && remote) {
      var vp = Math.round((remote.volume || 0) * 100);
      hv.value = vp;
      $('#hVolVal').textContent = vp;
    }
  }

  function updateProgress(cur, dur) {
    var pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    var pf = $('#progressFill');
    if (pf) pf.style.width = pct + '%';
    var hf = $('#hFill');
    if (hf) hf.style.width = pct + '%';

    var tc = $('#tCur');
    if (tc) tc.textContent = fmt(cur);
    var td = $('#tDur');
    if (td) td.textContent = fmt(dur);
    var hc = $('#hCur');
    if (hc) hc.textContent = fmt(cur);
    var hd = $('#hDur');
    if (hd) hd.textContent = fmt(dur);
  }

  function renderTracks() {
    var html;
    if (!tracks.length) {
      html = '<li class="empty">还没有音乐，先在下面选择文件上传</li>';
    } else {
      html = tracks.map(function (t, i) {
        var active = remote && remote.trackId === t.id ? ' active' : '';
        return '<li data-id="' + esc(t.id) + '" class="' + active.trim() + '">' +
          '<span class="t-idx">' + (i + 1) + '</span>' +
          '<span class="t-main"><span class="t-name">' + esc(t.name) + '</span></span>' +
          '<span class="t-size">' + fmtSize(t.size) + '</span>' +
          '</li>';
      }).join('');
    }
    var tl = $('#trackList');
    if (tl) tl.innerHTML = html;
    var st = $('#sheetTracks');
    if (st) st.innerHTML = tracks.length
      ? html
      : '<li class="empty">主机还没添加音乐</li>';

    var tc = $('#trackCount');
    if (tc) tc.textContent = tracks.length + ' 首';
  }

  function renderRoster(list) {
    var el = $('#peerList');
    var count = $('#mPeers');
    if (count) count.textContent = list.length;
    var pc = $('#peerCount');
    if (pc) pc.textContent = list.length + ' 台';
    if (!el) return;

    if (!list.length) {
      el.innerHTML = '<li class="empty">暂无设备</li>';
      return;
    }

    el.innerHTML = list.map(function (p) {
      var drift = p.drift == null ? '—' : sign(p.drift) + ' ms';
      var tag = p.role === 'host' ? '<span class="p-role">主机</span>' : '';
      return '<li>' +
        '<span class="p-dot"></span>' +
        '<span class="p-name">' + esc(p.name) + '</span>' +
        tag +
        '<span class="p-drift">' + drift + '</span>' +
        '</li>';
    }).join('');
  }

  function loadTracks() {
    return fetch('/api/tracks', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        tracks = d.tracks || [];
        renderTracks();
        refreshUI();
        prefetchTracks();
      })
      .catch(function () {});
  }

  var prefetching = false;
  var fetched = {};

  function prefetchTracks() {
    if (role === 'host' || prefetching) return;
    var list = tracks.filter(function (t) {
      return t.size < 40 * 1024 * 1024 && !fetched[t.id];
    });
    if (!list.length) return;

    prefetching = true;
    var i = 0;
    (function next() {
      if (i >= list.length) { prefetching = false; return; }
      var t = list[i++];
      fetched[t.id] = true;
      fetch(t.url, { cache: 'force-cache' })
        .then(function (r) { return r.arrayBuffer(); })
        .catch(function () {})
        .then(function () { setTimeout(next, 60); });
    })();
  }

  function connect() {
    if (es) es.close();
    var qs = '?id=' + encodeURIComponent(myId) +
      '&name=' + encodeURIComponent(myName) +
      '&role=' + role;
    es = new EventSource('/api/events' + qs);

    es.onopen = function () { setConn(true); };
    es.onerror = function () { setConn(false); };

    es.addEventListener('sync', function (e) {
      setConn(true);
      try { applyRemote(JSON.parse(e.data)); } catch (err) {}
    });

    es.addEventListener('roster', function (e) {
      try { renderRoster(JSON.parse(e.data)); } catch (err) {}
    });

    es.addEventListener('calib', function (e) {
      try { handleCalib(JSON.parse(e.data)); } catch (err) {}
    });

    es.addEventListener('calibresult', function (e) {
      try {
        var map = JSON.parse(e.data);
        if (map && typeof map[myId] === 'number') {
          delayComp = map[myId];
          localStorage.setItem('ps_delay', String(delayComp));
          setDelayLabels();
        }
      } catch (err) {}
    });

    es.addEventListener('tracks', function (e) {
      try {
        var d = JSON.parse(e.data);
        tracks = d.tracks || [];
        renderTracks();
        refreshUI();
        prefetchTracks();
      } catch (err) {}
    });
  }

  function playTrack(id) {
    ensureAudio();
    loadBuffer(id).catch(function () {});
    post('/api/play', { trackId: id, position: 0 }).then(function () {
      toast('切换到：' + id.replace(/\.[^.]+$/, ''));
    });
  }

  function togglePlay() {
    ensureAudio();
    if (!remote || !remote.trackId) {
      toast(tracks.length ? '先点一首歌' : '先上传音乐');
      return;
    }
    if (remote.playing) {
      post('/api/pause', {});
    } else {
      post('/api/play', { trackId: remote.trackId, position: remote.position });
    }
  }

  function seekTo(ratio) {
    if (!remote || !remote.trackId) return;
    var d = loadedDuration || (seg && seg.buf ? seg.buf.duration : 0);
    if (!d) return;
    var pos = Math.max(0, Math.min(d - 0.6, d * ratio));
    post('/api/seek', { position: pos, playing: remote.playing });
  }

  function openSheet() { $('#sheet').classList.add('open'); }
  function closeSheet() { $('#sheet').classList.remove('open'); }

  function uploadOne(file, onPct) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onPct) onPct(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = function () { resolve(xhr.status === 200); };
      xhr.onerror = function () { resolve(false); };
      xhr.send(file);
    });
  }

  function handleFiles(files) {
    if (!files || !files.length) return;
    var i = 0;
    var box = $('#upProgress');

    function next() {
      if (i >= files.length) {
        box.textContent = '';
        toast(files.length + ' 个文件已加入曲库');
        loadTracks();
        return;
      }
      var f = files[i];
      box.textContent = '上传中 ' + (i + 1) + '/' + files.length + ' · ' + f.name;
      uploadOne(f, function (pct) {
        box.textContent = '上传中 ' + (i + 1) + '/' + files.length + ' · ' + pct + '%';
      }).then(function (ok) {
        if (!ok) toast('上传失败：' + f.name);
        i++;
        next();
      });
    }
    next();
  }

  function renderQR(url, attempt) {
    var el = $('#qr');
    if (!el) return;
    attempt = attempt || 0;
    if (typeof window.qrcode !== 'function') {
      if (attempt < 4) {
        setTimeout(function () { renderQR(url, attempt + 1); }, 600);
        return;
      }
      el.innerHTML = '<span class="qr-err">二维码组件未加载，请手动输入地址</span>';
      return;
    }
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      el.innerHTML = qr.createSvgTag(4, 0);
    } catch (e) {
      el.innerHTML = '<span class="qr-err">二维码生成失败</span>';
    }
  }

  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  function bufferLabel() {
    if (loadState) return loadState;
    if (!ac) return '未初始化';
    var n = 0;
    for (var k in buffers) n++;
    var st = ac.state === 'running' ? '运行中' : ac.state;
    return st + ' · 缓存 ' + n + ' 首';
  }

  function drawDrift() {
    var c = $('#driftChart');
    if (!c || !c.getContext) return;
    var ctx = c.getContext('2d');
    var w = c.width;
    var h = c.height;
    ctx.clearRect(0, 0, w, h);

    var span = 200;
    var scale = (h / 2) / span;

    ctx.fillStyle = 'rgba(47,230,160,0.09)';
    ctx.fillRect(0, h / 2 - 40 * scale, w, 80 * scale);

    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    var data = engine.history;
    if (data.length < 2) return;

    ctx.strokeStyle = '#ff3d81';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = (i / 89) * w;
      var v = Math.max(-span, Math.min(span, data[i]));
      var y = h / 2 - v * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function renderDiag() {
    if (!diagOpen) return;
    var d = $('#dDrift');
    if (d) {
      d.textContent = sign(Math.round(engine.lastDrift)) + ' ms';
      d.className = Math.abs(engine.lastDrift) <= 40 ? 'ok' : 'bad';
    }
    var se = $('#dStartErr');
    if (se) {
      se.textContent = engine.startErrorMs == null
        ? '—'
        : sign(Math.round(engine.startErrorMs)) + ' ms';
      se.className = engine.startErrorMs != null && Math.abs(engine.startErrorMs) <= 60 ? 'ok' : 'bad';
    }
    var bf = $('#dBuffer');
    if (bf) bf.textContent = bufferLabel();
    drawDrift();
  }

  function setDelayLabels() {
    var pairs = [['#delayRange', '#delayVal'], ['#hostDelay', '#hostDelayVal']];
    for (var i = 0; i < pairs.length; i++) {
      var r = $(pairs[i][0]);
      var l = $(pairs[i][1]);
      var v = Math.max(-400, Math.min(400, delayComp));
      if (r) r.value = String(v);
      if (l) l.textContent = sign(delayComp) + ' ms';
    }
  }

  var calibResults = null;

  function renderCalibResults(list) {
    var el = $('#calibList');
    if (!el) return;
    if (!list || !list.length) {
      el.innerHTML = '<li class="empty">没有测到数据</li>';
      $('#calibPanel').hidden = false;
      return;
    }
    el.innerHTML = list.map(function (r) {
      var d = r.delayMs;
      var cls = 'none';
      var txt = '未测到';
      if (d != null) {
        var a = Math.abs(d);
        cls = a <= 20 ? 'good' : a <= 70 ? 'mid' : 'bad';
        txt = sign(d) + ' ms';
      }
      var tag = r.role === 'host' ? '<span class="cl-tag">主机</span>' : '';
      return '<li>' +
        '<span class="cl-name">' + esc(r.name) + '</span>' +
        tag +
        '<span class="cl-val ' + cls + '">' + txt + '</span>' +
        '</li>';
    }).join('');
    $('#calibPanel').hidden = false;
  }

  function applyCalib() {
    if (!calibResults) return;
    var offs = {};
    var n = 0;
    for (var i = 0; i < calibResults.length; i++) {
      var r = calibResults[i];
      if (r.delayMs != null) {
        offs[r.id] = r.delayMs;
        n++;
      }
    }
    if (!n) {
      toast('没有可应用的数值');
      return;
    }
    post('/api/calibrate/apply', { offsets: offs }).then(function () {
      toast('已应用，' + n + ' 台设备完成补偿');
      $('#calibPanel').hidden = true;
    });
  }

  function startCalib() {
    if (!window.Calib || !window.Calib.isSupported()) {
      toast('浏览器不支持 Web Audio');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('麦克风不可用，请用 http://localhost:8080 打开主机页面');
      return;
    }
    $('#calibPanel').hidden = true;
    $('#calibStatus').textContent = '正在准备…';
    $('#btnCalib').disabled = true;
    ensureAudio();

    post('/api/calibrate', {}).then(function (payload) {
      if (!payload || !payload.slots) {
        $('#calibStatus').textContent = '还没有设备连接';
        $('#btnCalib').disabled = false;
      }
    }).catch(function () {
      $('#calibStatus').textContent = '启动失败';
      $('#btnCalib').disabled = false;
    });
  }

  function handleCalib(payload) {
    if (!window.Calib) return;
    var isHost = role === 'host';
    if (remote && remote.playing) post('/api/pause', {});

    if (isHost) {
      $('#calibStatus').textContent = '录音中，请保持安静…';
      $('#btnCalib').disabled = true;
    }

    window.Calib.run(payload, clockOffset, myId, {
      record: isHost,
      onProgress: function (msg) {
        if (isHost) $('#calibStatus').textContent = msg;
      }
    }).then(function (results) {
      if (!isHost) return;
      $('#btnCalib').disabled = false;
      var ok = 0;
      for (var i = 0; i < (results || []).length; i++) {
        if (results[i].delayMs != null) ok++;
      }
      $('#calibStatus').textContent = '完成 · 测到 ' + ok + '/' + (results || []).length + ' 台';
      calibResults = results;
      renderCalibResults(results);
    }).catch(function (err) {
      if (!isHost) return;
      $('#btnCalib').disabled = false;
      var m = (err && err.message) || '校准失败';
      $('#calibStatus').textContent = m;
      toast(m);
    });
  }

  function bindSeekBar(el) {
    if (!el) return;
    el.style.cursor = 'pointer';
    el.addEventListener('click', function (e) {
      var rect = el.getBoundingClientRect();
      seekTo(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    });
  }

  function bindEvents() {
    $('#btnReady').addEventListener('click', function () {
      ensureAudio();
      if (ac && ac.state === 'suspended') ac.resume();
      unlocked = true;
      $('#gate').classList.add('hidden');
      keepAwake();
      ping().then(function () {
        if (remote && remote.playing) schedulePlayback(remote);
        toast('已就绪');
      });
    });

    $('#btnDiag').addEventListener('click', function () {
      diagOpen = !diagOpen;
      $('#diag').classList.toggle('open', diagOpen);
      $('#diagCaret').textContent = diagOpen ? '收起' : '展开';
      if (diagOpen) renderDiag();
    });

    setDelayLabels();
    ['#delayRange', '#hostDelay'].forEach(function (sel) {
      var r = $(sel);
      if (!r) return;
      r.addEventListener('input', function (e) {
        delayComp = Number(e.target.value);
        localStorage.setItem('ps_delay', String(delayComp));
        setDelayLabels();
      });
    });

    $('#btnLibrary').addEventListener('click', openSheet);
    $('#btnCalib').addEventListener('click', startCalib);
    $('#btnApplyCalib').addEventListener('click', applyCalib);
    $('#btnCloseCalib').addEventListener('click', function () {
      $('#calibPanel').hidden = true;
    });
    $('#btnCloseSheet').addEventListener('click', closeSheet);
    $('#sheet').addEventListener('click', function (e) {
      if (e.target === $('#sheet')) closeSheet();
    });

    $('#btnToggleRemote').addEventListener('click', togglePlay);
    $('#hToggle').addEventListener('click', togglePlay);

    document.addEventListener('click', function (e) {
      var li = e.target.closest('#trackList li[data-id], #sheetTracks li[data-id]');
      if (li) {
        playTrack(li.getAttribute('data-id'));
        closeSheet();
      }
    });

    $('#fileInput').addEventListener('change', function (e) {
      handleFiles(e.target.files);
      e.target.value = '';
    });

    var vol = $('#hVol');
    var volTimer = null;
    vol.addEventListener('input', function () {
      var v = Number(vol.value) / 100;
      $('#hVolVal').textContent = vol.value;
      if (master) master.gain.value = v;
      clearTimeout(volTimer);
      volTimer = setTimeout(function () {
        post('/api/volume', { value: v });
      }, 150);
    });

    $('#btnCopy').addEventListener('click', function () {
      var t = joinUrl || location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(t).then(function () { toast('地址已复制'); });
      } else {
        toast(t);
      }
    });

    bindSeekBar($('.transport .progress'));

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && unlocked && !wakeLock) {
        keepAwake();
        if (remote && remote.playing) schedulePlayback(remote);
      }
    });
  }

  setInterval(function () {
    if (!remote) return;
    var cur = currentPos();
    var dur = loadedDuration || (seg && seg.buf ? seg.buf.duration : 0);
    updateProgress(cur, dur);

    var leadSec = remote.playing ? (remote.startAt - serverNow()) / 1000 : 0;

    var ss = $('#songSub');
    if (ss && remote.trackId) {
      if (loadState) {
        ss.textContent = loadState + '…';
      } else if (remote.playing && leadSec > 0.05) {
        ss.textContent = '即将起播 · ' + leadSec.toFixed(1) + ' 秒';
      } else if (remote.playing) {
        ss.textContent = '全场同步播放中';
      } else {
        ss.textContent = '已暂停';
      }
    }

    var disc = $('#disc');
    if (disc) disc.classList.toggle('playing', !!(remote.playing && leadSec <= 0.05 && !loadState));

    if (remote.playing && seg && seg.playing && srcNode && ac) {
      var curPlay = playPos();
      var exp = expectedPos();
      var drift = curPlay - exp;
      var abs = Math.abs(drift);

      engine.lastDrift = drift * 1000;
      engine.history.push(drift * 1000);
      if (engine.history.length > 90) engine.history.shift();

      if (abs > 0.35) {
        hardSeek(exp);
        engine.rateHold = 0;
      } else if (abs > 0.04) {
        setRate(1 - Math.max(-0.03, Math.min(0.03, drift * 0.6)));
        engine.rateHold++;
        if (engine.rateHold > 60) {
          hardSeek(exp);
          engine.rateHold = 0;
        }
      } else {
        if (seg.rate !== 1) setRate(1);
        engine.rateHold = 0;
      }

      var el = $('#mDrift');
      if (el) {
        el.textContent = sign(Math.round(engine.lastDrift)) + ' ms';
        el.classList.toggle('good', Math.abs(engine.lastDrift) <= 45);
        el.classList.toggle('warn', Math.abs(engine.lastDrift) > 45);
      }
      report({ drift: Math.round(engine.lastDrift) });
    }

    renderDiag();
  }, 150);

  setInterval(ping, 2000);

  function boot() {
    var p = new URLSearchParams(location.search);

    fetch('/api/whoami', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { isLocal: false, ips: [], port: location.port || 80 }; })
      .then(function (who) {
        var r = p.get('role');
        if (!r) r = (p.get('host') === '1' || who.isLocal) ? 'host' : 'listener';
        role = r === 'host' ? 'host' : 'listener';

        document.body.dataset.role = role;
        $('#roleTag').textContent = role === 'host' ? '主机' : '协端';
        document.title = role === 'host' ? '一起放 · 主机控制台' : '一起放 · 同步播放';

        var ip = (who.ips && who.ips[0] && who.ips[0].address) || location.hostname;
        joinUrl = 'http://' + ip + ':' + (who.port || location.port || 80);

        if (role === 'host') {
          $('#joinUrl').textContent = joinUrl;
          $('#gate').classList.add('hidden');
          unlocked = true;
          ensureAudio();
          renderQR(joinUrl);
        } else {
          $('#gate').classList.remove('hidden');
        }

        bindEvents();
        loadTracks().then(function () {
          connect();
        });
        ping();
      });
  }

  boot();
})();
