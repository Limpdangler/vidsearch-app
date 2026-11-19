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
//                          { vsHook: 'key', key, token }        (TV remote arrows pressed inside the player)
//                          { vsHook: 'dbltap', side, secs, token }  (double-tap: left -1 / middle 0 / right 1)
//                          { vsHook: 'tap', token }             (you touched the player)
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
    if (Date.now() < tapGuardUntil) return Promise.resolve();   // that was a double-tap to jump
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

  // ── Pop-ups: refuse them quietly, inside the player ─────────
  // Players like vidsrc lay an invisible ad layer over the video after a few minutes,
  // so your next tap tries to open an ad. The app already blocks the ad, but just
  // trying to open a new window makes Android drop out of fullscreen. Refusing it here,
  // before it gets that far, keeps you in fullscreen. Nothing in a player needs one.
  // It hands back a pretend window rather than nothing: some players (VidRift) treat
  // "nothing" as a sign they've been locked down ("sandboxed") and refuse to play.
  function pretendWindow() {
    var w = {
      closed: false, opener: null, name: '', length: 0,
      close: function () { w.closed = true; },
      focus: function () {}, blur: function () {}, postMessage: function () {},
      moveTo: function () {}, resizeTo: function () {}, stop: function () {},
      location: { href: 'about:blank', assign: function () {}, replace: function () {}, reload: function () {} },
      document: { write: function () {}, writeln: function () {}, open: function () {}, close: function () {},
                  body: null, documentElement: null }
    };
    w.window = w; w.self = w; w.top = w; w.parent = w; w.frames = w;
    return w;
  }
  try {
    var noPopup = function open() { return pretendWindow(); };
    if (disguise) disguise.set(noPopup, window.open);
    window.open = noPopup;
  } catch (e) {}
  // Links that would open in a new window (or take over the whole page) do nothing
  window.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var t = (a.getAttribute('target') || '').toLowerCase();
    if (t && t !== '_self') e.preventDefault();
  }, true);
  // Tell Vid Search when you tap inside the player (so it can put you back into
  // fullscreen if something knocks you out of it)
  var lastTapSent = 0;
  window.addEventListener('pointerdown', function () {
    var now = Date.now();
    if (now - lastTapSent < 400) return;
    lastTapSent = now;
    try { window.top.postMessage({ vsHook: 'tap', token: TOKEN }, '*'); } catch (e) {}
  }, true);

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

  // ── Hide the player's controls after Vid Search presses play ──
  // A paused player shows its controls. When Vid Search un-pauses it (e.g. from the
  // floating window, where you can't touch the video), the player never notices you've
  // "left", so its controls stay on top of the picture. Pretend the mouse moved and then
  // left the player, which is what normally makes them fade away.
  function fire(el, type, bubbles, x, y) {
    try {
      var Ctor = (type.indexOf('pointer') === 0 && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: bubbles, cancelable: true, view: window, clientX: x, clientY: y }));
    } catch (e) {}
  }
  function hideControls() {
    var v = mainVideo();
    if (!v || v.paused) return;
    var r = v.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    fire(v, 'pointermove', true, x, y);
    fire(v, 'mousemove', true, x, y);
    setTimeout(function () {
      fire(v, 'pointerout', true, x, y);
      fire(v, 'mouseout', true, x, y);
      for (var el = v; el && el !== document.documentElement; el = el.parentElement) {
        fire(el, 'pointerleave', false, x, y);
        fire(el, 'mouseleave', false, x, y);
      }
    }, 200);
  }
  function hideControlsSoon() {
    setTimeout(hideControls, 600);
    setTimeout(hideControls, 3000);
  }

  // ── Press the start button on a cover screen ────────────────
  // Some players (vidsrc) open on a cover picture with a big play button, and only load
  // the video once it's pressed. When Vid Search wants the video to start by itself, press
  // it — once per box, and only if this box has no video of its own yet.
  var START_BUTTONS = '#pl_but, .pl_but, #play-button, .play-button, #playbtn, .playbtn, .play-btn, ' +
      '.btn-play, .vjs-big-play-button, .jw-display-icon-display, .plyr__control--overlaid, ' +
      '[aria-label="Play"], [title="Play"]';
  var startPressed = false;
  function pressStart() {
    if (startPressed || allVideos(document).length) return;
    var list;
    try { list = document.querySelectorAll(START_BUTTONS); } catch (e) { return; }
    for (var i = 0; i < list.length; i++) {
      var b = list[i], r = b.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;       // hidden or tiny: not it
      startPressed = true;
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      fire(b, 'pointerdown', true, x, y);
      fire(b, 'mousedown', true, x, y);
      fire(b, 'pointerup', true, x, y);
      fire(b, 'mouseup', true, x, y);
      try { b.click(); } catch (e) {}
      return;
    }
  }

  // ── TV remote: arrows go to Vid Search, not the player ─────
  // Web players use the up/down arrows for their own volume, so on a TV pressing up/down
  // after OK on the video changed the volume instead of moving around Vid Search. On a TV
  // (the app adds "VidSearchTV" to its name there), pass the arrows to Vid Search instead.
  var ON_TV = /VidSearchTV/.test(navigator.userAgent);
  var ARROWS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Up: 1, Down: 1, Left: 1, Right: 1 };
  if (ON_TV) {
    window.addEventListener('keydown', function (e) {
      if (!ARROWS[e.key]) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var key = e.key.indexOf('Arrow') === 0 ? e.key : 'Arrow' + e.key;
      try { window.top.postMessage({ vsHook: 'key', key: key, token: TOKEN }, '*'); } catch (err) {}
    }, true);
    window.addEventListener('keyup', function (e) {
      if (ARROWS[e.key]) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  // ── Double-tap the video ──
  // Tells Vid Search which third was double-tapped (left / middle / right); Vid Search
  // decides what that does (fullscreen, jump 10 seconds, pause / play). Like YouTube,
  // each extra quick tap on the left or right counts again. The
  // second tap is kept from the player, so it doesn't also count it as a double-click
  // (which many players use for fullscreen).
  var lastTap = { t: 0, side: 0 };
  var tapGuardUntil = 0;
  window.addEventListener('touchend', function (e) {
    if (e.touches && e.touches.length) return;               // still touching with another finger
    var t = e.changedTouches && e.changedTouches[0];
    if (!t || !allVideos(document).length) return;           // only where the video is
    var w = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!w) return;
    var side = t.clientX < w / 3 ? -1 : (t.clientX > w * 2 / 3 ? 1 : 0);
    var now = Date.now();
    if (side === lastTap.side && now - lastTap.t < 350) {
      // Middle: a third tap starts afresh (so it doesn't pause and un-pause straight away)
      if (side === 0) lastTap = { t: 0, side: 9 }; else lastTap.t = now;
      tapGuardUntil = now + 600;
      e.preventDefault();
      e.stopImmediatePropagation();
      try { window.top.postMessage({ vsHook: 'dbltap', side: side, secs: side * 10, token: TOKEN }, '*'); } catch (err) {}
    } else {
      lastTap = { t: now, side: side };
    }
  }, { capture: true, passive: false });
  window.addEventListener('dblclick', function (e) {
    if (Date.now() < tapGuardUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

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

    if (m.vsHookCmd === 'start') pressStart();

    var v = (fsCmd || m.vsHookCmd === 'start') ? null : mainVideo();
    if (v) {
      try {
        if (m.vsHookCmd === 'play') {
          var p = v.play();
          if (p && p.catch) p.catch(function () {});
          hideControlsSoon();
        } else if (m.vsHookCmd === 'pause') {
          v.pause();
        } else if (m.vsHookCmd === 'seek' && isFinite(m.t)) {
          v.currentTime = Math.max(0, m.t);
          hideControlsSoon();
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
