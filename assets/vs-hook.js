// Vid Search player helper.
// The app adds this to every page and every box (iframe) inside it, before the
// page's own code runs. Inside the video player's boxes it finds the main video
// and lets Vid Search control it with standard video commands — it never touches
// the player's own code, buttons or ads.
//
//   Vid Search -> helper:  { vsHookCmd: 'play' | 'pause' | 'seek' | 'state', t, token }
//   helper -> Vid Search:  { vsHook: 'state', pos, dur, paused, ended, token }
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
      var d = isFinite(v.duration) ? v.duration : 0;
      var r = v.getBoundingClientRect();
      var score = d * 100000 + r.width * r.height;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
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
        dur: isFinite(v.duration) ? v.duration : 0,
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

  function scan() {
    var vids = allVideos(document);
    for (var i = 0; i < vids.length; i++) watch(vids[i]);
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

    var v = mainVideo();
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
