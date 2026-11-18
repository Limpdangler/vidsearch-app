// Vid Search player helper.
// The app adds this to every page and every box (iframe) inside it, before the
// page's own code runs. Inside the video player's boxes it finds the main video
// and lets Vid Search control it with standard video commands — it never touches
// the player's own buttons or ads. It also passes the player's fullscreen button on
// to Vid Search's fullscreen, so Skip intro and Up next stay on screen.
//
//   Vid Search -> helper:  { vsHookCmd: 'play' | 'pause' | 'seek' | 'state' | 'fsAck' | 'fsFallback', t, token }
//   helper -> Vid Search:  { vsHook: 'state', pos, dur, paused, ended, token }
//                          { vsHook: 'fullscreen', token }
//
// __TOKEN__ is replaced by the app with a random code each time it starts, so
// only Vid Search's own messages are obeyed.
(function () {
  'use strict';
  if (window.__vsHookInstalled) return;
  window.__vsHookInstalled = true;

  var TOKEN = '__TOKEN__';

  // In the Vid Search page itself: just announce that the helper is available.
  if (window === window.top) {
    try { window.VS_HOOK = { token: TOKEN, version: 1 }; } catch (e) {}
    return;
  }

  // ── Fullscreen: use Vid Search's instead of the player's ────
  // The player's own fullscreen only enlarges the video, which hides Vid Search's
  // Skip intro and Up next buttons. So when the player asks for fullscreen, ask Vid
  // Search instead. If Vid Search doesn't answer within a moment (an older version of
  // the site), or can't do it, the player gets its own fullscreen as normal.
  var fsWait = null;   // { el, original, args, resolve, timer }

  function fsOwn() {
    var w = fsWait;
    fsWait = null;
    if (!w) return;
    clearTimeout(w.timer);
    try {
      var r = w.original.apply(w.el, w.args);
      if (r && r.then) r.then(w.resolve, w.resolve); else w.resolve();
    } catch (e) { w.resolve(); }
  }

  function askVidSearch(el, original, args) {
    if (fsWait) { clearTimeout(fsWait.timer); fsWait.resolve(); }
    return new Promise(function (resolve) {
      fsWait = { el: el, original: original, args: args, resolve: resolve,
                 timer: setTimeout(fsOwn, 700) };
      try { window.top.postMessage({ vsHook: 'fullscreen', token: TOKEN }, '*'); } catch (e) { fsOwn(); }
    });
  }

  // Some players check whether built-in functions have been changed. Make the
  // replacements look exactly like the originals if they look.
  var disguise = typeof WeakMap === 'function' ? new WeakMap() : null;
  if (disguise) {
    try {
      var realToString = Function.prototype.toString;
      var fakeToString = function toString() {
        return realToString.call((disguise.get(this)) || this);
      };
      disguise.set(fakeToString, realToString);
      Function.prototype.toString = fakeToString;
    } catch (e) { disguise = null; }
  }

  function catchFullscreen(proto, name) {
    try {
      var original = proto && proto[name];
      if (typeof original !== 'function') return;
      var replacement = function () { return askVidSearch(this, original, arguments); };
      try { Object.defineProperty(replacement, 'name', { value: original.name }); } catch (e) {}
      if (disguise) disguise.set(replacement, original);
      proto[name] = replacement;
    } catch (e) {}
  }
  catchFullscreen(Element.prototype, 'requestFullscreen');
  catchFullscreen(Element.prototype, 'webkitRequestFullscreen');
  catchFullscreen(Element.prototype, 'webkitRequestFullScreen');
  if (window.HTMLVideoElement) {
    catchFullscreen(HTMLVideoElement.prototype, 'webkitEnterFullscreen');
    catchFullscreen(HTMLVideoElement.prototype, 'webkitEnterFullScreen');
  }

  // ── Find the main video ─────────────────────────────────────
  // Some players hide their video inside "shadow" sections, so look there too.
  function allVideos(root, out, deep) {
    out = out || [];
    try {
      var vids = root.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) out.push(vids[i]);
      if (deep) {
        var all = root.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) allVideos(all[j].shadowRoot, out, true);
        }
      }
    } catch (e) {}
    // Only dig into hidden sections if nothing was found the normal way
    if (!deep && out.length === 0 && root === document) return allVideos(document, [], true);
    return out;
  }

  // The main video = the longest one (ads are short), then the biggest on screen
  function mainVideo() {
    var vids = allVideos(document);
    var best = null, bestScore = -1;
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      var d = videoLength(v);
      var r = v.getBoundingClientRect();
      var score = d * 100000 + r.width * r.height;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  // Length of the video. Some streams say "unknown" (infinite): then use how far
  // you can jump to instead.
  function videoLength(v) {
    if (isFinite(v.duration) && v.duration > 0) return v.duration;
    try {
      var s = v.seekable;
      if (s && s.length) { var end = s.end(s.length - 1); if (isFinite(end)) return end; }
    } catch (e) {}
    return 0;
  }

  // ── Report to Vid Search ────────────────────────────────────
  var lastSent = 0;
  function report(force) {
    var v = mainVideo();
    if (!v) return;
    var now = Date.now();
    if (!force && now - lastSent < 1000) return;   // at most once a second while playing
    lastSent = now;
    try {
      window.top.postMessage({
        vsHook: 'state',
        token: TOKEN,
        pos: v.currentTime || 0,
        dur: videoLength(v),
        paused: !!v.paused,
        ended: !!v.ended
      }, '*');
    } catch (e) {}
  }

  var watched = typeof WeakSet === 'function' ? new WeakSet() : null;
  function watch(v) {
    if (!watched || watched.has(v)) return;
    watched.add(v);
    ['loadedmetadata', 'play', 'playing', 'pause', 'seeked', 'ended'].forEach(function (ev) {
      v.addEventListener(ev, function () { report(true); });
    });
    v.addEventListener('timeupdate', function () { report(false); });
  }

  // Say hello to Vid Search (so it can show "connected" / "no video found")
  var helloCount = -1;
  function hello(n) {
    if (n === helloCount) return;
    helloCount = n;
    try { window.top.postMessage({ vsHook: 'hello', token: TOKEN, videos: n }, '*'); } catch (e) {}
  }

  function scan() {
    var vids = allVideos(document);
    for (var i = 0; i < vids.length; i++) watch(vids[i]);
    hello(vids.length);
  }

  // Players often add their video later, so keep an eye out
  setInterval(scan, 1000);
  document.addEventListener('DOMContentLoaded', scan);

  // ── Obey Vid Search, and pass commands on to boxes inside this one ──
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (typeof m === 'string') {
      if (m.indexOf('vsHookCmd') < 0) return;
      try { m = JSON.parse(m); } catch (err) { return; }
    }
    if (!m || typeof m !== 'object' || !m.vsHookCmd || m.token !== TOKEN) return;

    var fsCmd = m.vsHookCmd === 'fsAck' || m.vsHookCmd === 'fsFallback';
    if (m.vsHookCmd === 'fsAck' && fsWait) {          // Vid Search is handling it
      var w = fsWait;
      clearTimeout(w.timer);
      w.resolve();
      // keep it for a few seconds, in case Vid Search's fullscreen is refused
      w.timer = setTimeout(function () { if (fsWait === w) fsWait = null; }, 3000);
    } else if (m.vsHookCmd === 'fsFallback') {
      fsOwn();                                       // Vid Search couldn't: use the player's own
    }

    var v = fsCmd ? null : mainVideo();
    if (v) {
      try {
        if (m.vsHookCmd === 'play') {
          var p = v.play();
          if (p && p.catch) p.catch(function () {});
        } else if (m.vsHookCmd === 'pause') {
          v.pause();
        } else if (m.vsHookCmd === 'seek' && isFinite(m.t)) {
          v.currentTime = Math.max(0, m.t);
        }
      } catch (err) {}
      report(true);
    }

    // The video may be in a box inside this one: pass the command down
    for (var i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(m, '*'); } catch (err) {}
    }
  });
})();
