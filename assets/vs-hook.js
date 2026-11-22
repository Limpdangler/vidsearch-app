// Vid Search player helper.
// The app adds this to every page and every box (iframe) inside it, before the
// page's own code runs. Inside the video player's boxes it finds the main video
// and lets Vid Search control it with standard video commands — it never touches
// the player's own buttons or ads. It also passes the player's fullscreen button on
// to Vid Search's fullscreen, so Skip intro and Up next stay on screen.
//
//   Vid Search -> helper:  { vsHookCmd: 'play' | 'pause' | 'seek' | 'state' | 'fsAck' | 'fsFallback'
//                                       | 'start' | 'lock' | 'unmute', t, token }
//   helper -> Vid Search:  { vsHook: 'state', pos, dur, paused, ended, muted, token }
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

  // ── Once the video is playing: lock the player down ─────────
  // Ad scripts sometimes drop an ad web page over the video, or send the player's box
  // off to an ad site. Once Vid Search says the video is playing, the player has
  // everything it needs, so from then on, in every box inside the player:
  //   - new boxes (iframes) are removed as soon as they appear
  //   - nothing can switch a box to a different website (by script or by a tap)
  // Before that, nothing is touched, so players can set themselves up normally.
  var lockedDown = false;

  // "example.co.uk" style: the last two parts of the name (three for .co.uk etc.)
  function siteOf(host) {
    host = (host || '').toLowerCase();
    var parts = host.split('.');
    if (parts.length <= 2) return host;
    var two = parts.slice(-2).join('.');
    if (/^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join('.');
    return two;
  }
  function otherSite(url) {
    try {
      var u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
      return siteOf(u.hostname) !== siteOf(location.hostname);
    } catch (e) { return false; }
  }

  function killFrame(f) {
    try { f.style.setProperty('display', 'none', 'important'); } catch (e) {}
    try { f.src = 'about:blank'; } catch (e) {}
    try { f.remove(); } catch (e) {}
  }
  function killFramesIn(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'IFRAME' || node.tagName === 'FRAME' || node.tagName === 'OBJECT' || node.tagName === 'EMBED') { killFrame(node); return; }
    try {
      var list = node.querySelectorAll('iframe, frame, object, embed');
      for (var i = 0; i < list.length; i++) killFrame(list[i]);
    } catch (e) {}
  }

  function lockDown() {
    if (lockedDown) return;
    lockedDown = true;
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes') { if (m.target.tagName === 'IFRAME') killFrame(m.target); continue; }
          for (var j = 0; j < m.addedNodes.length; j++) killFramesIn(m.addedNodes[j]);
        }
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    } catch (e) {}
    // Boxes that were already there but hidden or tiny when the video started, then
    // suddenly grow over the player later on: that's an ad springing up. (The player's
    // own box is already big at that point, so it's never touched.)
    try {
      var bigAtStart = typeof WeakSet === 'function' ? new WeakSet() : null;
      var isBig = function (f) {
        var r = f.getBoundingClientRect();
        var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
        if (r.width * r.height < vw * vh * 0.3) return false;
        var cs = getComputedStyle(f);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.1;
      };
      var boxes = document.querySelectorAll('iframe, frame');
      for (var k = 0; k < boxes.length; k++) if (bigAtStart && isBig(boxes[k])) bigAtStart.add(boxes[k]);
      if (bigAtStart) setInterval(function () {
        var list = document.querySelectorAll('iframe, frame');
        for (var q = 0; q < list.length; q++) {
          if (!bigAtStart.has(list[q]) && isBig(list[q])) killFrame(list[q]);
        }
      }, 700);
    } catch (e) {}
    // Script trying to move this box to another website
    try {
      if (window.navigation && navigation.addEventListener) {
        navigation.addEventListener('navigate', function (e) {
          if (!e.destination || e.hashChange) return;
          if (e.cancelable && otherSite(e.destination.url)) e.preventDefault();
        });
      }
    } catch (e) {}
  }
  // Taps on links to another website (once locked down)
  window.addEventListener('click', function (e) {
    if (!lockedDown) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && otherSite(a.href)) e.preventDefault();
  }, true);

  // ── Fake "prove you're not a robot" / QR-code screens ────────
  // A common TV ad scam: a screen over the video saying "scan the QR code to prove
  // you're not a robot", with a countdown before you can close it. They're recognised
  // by their wording and removed as soon as they appear, whether they're drawn over the
  // player or sent in a box of their own. Real checks (Cloudflare's "Just a moment…",
  // Google and hCaptcha) are left alone, as players sometimes need to pass those.
  var BAIT = /not a robot|are you (a )?(robot|human)|prove (that )?you|verify (that )?you('| a)re|you('| a)re (a )?human|(scan|scanning) (the |this )?qr|qr[ -]?code/i;
  var REAL_CHECK_HOST = /(^|\.)(cloudflare\.com|google\.com|gstatic\.com|recaptcha\.net|hcaptcha\.com)$/i;
  var sweepTimer = null;
  // Gambling / "you've won" ad pages (treasure chests, prize wheels). These words can
  // turn up in real titles, so they only count in a box that's a page of its own with
  // no video and no other boxes in it — never in the player itself.
  var PRIZE = /try your luck|free spins|spin (the|to) win|spin the wheel|claim (your )?(prize|reward|bonus|gift)|you('| ha)ve (just )?won|you are (the |a )?(lucky )?winner|open (the|your) (chest|box|gift)/i;
  function prizePage() {
    if (!document.body || allVideos(document).length) return false;
    try { if (document.querySelector('iframe, frame')) return false; } catch (e) {}
    return PRIZE.test(document.body.innerText || document.body.textContent || '');
  }

  function realCheckPage() {
    return REAL_CHECK_HOST.test(location.hostname) || /just a moment|attention required/i.test(document.title || '');
  }
  // The outermost "floating" (fixed / absolute) box around the scam text, stopping
  // before anything that also holds the video (so only the scam goes, never the player)
  function overlayRoot(el) {
    var root = null;
    for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.querySelector && n.querySelector('video, iframe')) break;
      try {
        var pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'absolute') root = n;
      } catch (e) {}
    }
    return root;
  }
  function sweepBait() {
    sweepTimer = null;
    if (!document.body || realCheckPage()) return;
    if (window.top !== window && prizePage()) {
      try { document.body.innerHTML = ''; } catch (e) {}
      try { window.parent.postMessage({ vsHookAd: 'remove', token: TOKEN }, '*'); } catch (e) {}
      return;
    }
    var text = document.body.textContent || '';
    if (!BAIT.test(text)) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node, removed = false, pageWide = false;
    while ((node = walker.nextNode())) {
      if (!BAIT.test(node.data)) continue;
      var el = node.parentElement;
      if (!el || el.closest('script, style')) continue;
      var root = overlayRoot(el);
      if (root) {
        try { root.remove(); removed = true; } catch (e) {}
      } else if (!el.closest('video') ) {
        pageWide = true;
      }
    }
    // The whole box is the scam screen (no video in it): ask the box around it to remove it
    if (pageWide && !removed && !allVideos(document).length) {
      try { document.body.innerHTML = ''; } catch (e) {}
      try { window.parent.postMessage({ vsHookAd: 'remove', token: TOKEN }, '*'); } catch (e) {}
    }
  }
  function sweepSoon() { if (!sweepTimer) sweepTimer = setTimeout(sweepBait, 150); }
  try {
    // (watch the document itself: at this early point the page's <html> may not exist yet)
    new MutationObserver(sweepSoon).observe(document, { childList: true, subtree: true, characterData: true });
  } catch (e) {}
  setInterval(sweepBait, 2000);

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
        ended: !!v.ended,
        muted: !!v.muted || v.volume === 0
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
    if (menuOn) return;                 // you're using the player's buttons
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
  function pressIt(b) {
    var r = b.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    fire(b, 'pointerdown', true, x, y);
    fire(b, 'mousedown', true, x, y);
    fire(b, 'pointerup', true, x, y);
    fire(b, 'mouseup', true, x, y);
    try { b.click(); } catch (e) {}
  }
  function pressStart() {
    if (startPressed || allVideos(document).length) return;
    var list;
    try { list = document.querySelectorAll(START_BUTTONS); } catch (e) { return; }
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;       // hidden or tiny: not it
      startPressed = true;
      pressIt(list[i]);
      return;
    }
    // Didn't recognise a button: press whatever's in the middle of the cover, which is
    // where the big play button goes. Only on a cover with a picture and no inner boxes.
    try {
      var w = innerWidth, h = innerHeight;
      if (w < 200 || h < 120 || document.querySelector('iframe')) return;
      var mid = document.elementFromPoint(w / 2, h / 2);
      if (!mid || mid === document.body || mid === document.documentElement) return;
      if (mid.closest && mid.closest('a[href]')) return;  // a link: could be an ad
      startPressed = true;
      pressIt(mid);
    } catch (e) {}
  }

  // ── TV remote: arrows go to Vid Search, not the player ─────
  // Web players use the up/down arrows for their own volume, so on a TV pressing up/down
  // after OK on the video changed the volume instead of moving around Vid Search. On a TV
  // (the app adds "VidSearchTV" to its name there), pass the arrows to Vid Search instead.
  var ON_TV = /VidSearchTV/.test(navigator.userAgent);
  var ARROWS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Up: 1, Down: 1, Left: 1, Right: 1 };
  if (ON_TV) {
    window.addEventListener('keydown', function (e) {
      if (menuOn && (e.key === 'Enter' || e.key === ' ' || e.key === 'Select')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        try { window.top.postMessage({ vsHook: 'key', key: 'Enter', token: TOKEN }, '*'); } catch (err) {}
        return;
      }
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
    if (menuOn) return;                                      // pressing the player's buttons
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
    if (Date.now() < tapGuardUntil && !menuOn) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ── Obey Vid Search, and pass commands on to boxes inside this one ──
  // ── TV remote: use the player's own buttons (subtitles, settings, speed, quality) ──
  // Vid Search asks for this (▼ on the remote in fullscreen). The box with the video shows
  // the player's controls, puts a white frame round one of its buttons, and from then on
  // the arrows move the frame, OK presses the button, and Back finishes. Works on any
  // player, because it just looks for things on screen that can be pressed.
  var menuOn = false, menuCur = null, menuFrame = null, menuWake = null, menuReal = false, menuOpener = null;
  var CLICKY = 'button, [role="button"], [role^="menuitem"], [role="option"], [role="radio"], ' +
      '[role="checkbox"], [role="switch"], [role="tab"], a[href], input, select, li, label, ' +
      '[onclick], [tabindex]:not([tabindex="-1"])';

  function findAll(root, sel, out) {
    try {
      var list = root.querySelectorAll(sel);
      for (var i = 0; i < list.length; i++) out.push(list[i]);
      var every = root.querySelectorAll('*');
      for (var j = 0; j < every.length; j++) if (every[j].shadowRoot) findAll(every[j].shadowRoot, sel, out);
    } catch (e) {}
    return out;
  }
  function onScreen(el) {
    if (!el || !el.isConnected || el === menuFrame) return null;
    var r = el.getBoundingClientRect();
    var W = window.innerWidth, H = window.innerHeight;
    if (r.width < 6 || r.height < 6 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return null;
    if (r.width * r.height > W * H * 0.25) return null;        // the whole picture, not a button
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') return null;
    // Actually on top (not hidden behind something else)
    var x = Math.min(W - 1, Math.max(0, r.left + r.width / 2));
    var y = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
    var root = el.getRootNode ? el.getRootNode() : document;
    var hit = null;
    try { hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y); } catch (e) {}
    if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) return null;
    return r;
  }
  function pressables() {
    var found = findAll(document, CLICKY, []);
    // Plus anything that shows it's pressable with a pointing-hand mouse pointer, whatever
    // it's made of (some players build their buttons out of made-up tags). Parts of a
    // button (its icon, its label) don't count separately: only the button itself does.
    var loose = findAll(document, 'body *', []);
    for (var i = 0; i < loose.length && i < 4000; i++) {
      var el = loose[i];
      try {
        if (el.ownerSVGElement) continue;                                  // a piece of an icon
        if (/^(script|style|video|audio|source|track|iframe|html|body)$/i.test(el.tagName)) continue;
        if (getComputedStyle(el).cursor !== 'pointer') continue;
        var up = el.parentElement || (el.parentNode && el.parentNode.host);
        if (up && up !== document.body && getComputedStyle(up).cursor === 'pointer') {
          // Inside something else pressable: an icon or the only thing in it is just part of
          // that button; but one of several (the options in a menu, the buttons on a bar)
          // counts on its own
          if (/^(svg|img|i)$/i.test(el.tagName) || up.children.length < 2) continue;
        }
        found.push(el);
      } catch (e) {}
    }
    var out = [];
    for (var k = 0; k < found.length; k++) {
      if (out.indexOf(found[k]) < 0 && onScreen(found[k])) out.push(found[k]);
    }
    // When one is inside another (a menu row with a button in it), keep the inner one
    return out.filter(function (a) {
      for (var n = 0; n < out.length; n++) if (out[n] !== a && a.contains(out[n])) return false;
      return true;
    });
  }
  function labelOf(el) {
    return ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' +
            (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' +
            ((el.textContent || '').length < 30 ? el.textContent : '')).toLowerCase();
  }
  function wakeControls() {
    var v = mainVideo();
    if (!v) return;
    var r = v.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height * 0.6;
    fire(v, 'pointermove', true, x, y);
    fire(v, 'mousemove', true, x, y);
    fire(v, 'pointerover', true, x, y);
    fire(v, 'mouseover', true, x, y);
    if (menuCur && menuCur.isConnected) {
      var c = menuCur.getBoundingClientRect();
      fire(menuCur, 'pointermove', true, c.left + c.width / 2, c.top + c.height / 2);
      fire(menuCur, 'mousemove', true, c.left + c.width / 2, c.top + c.height / 2);
    }
  }
  function drawFrame() {
    if (!menuOn || !menuCur) { if (menuFrame) menuFrame.style.display = 'none'; return; }
    if (!menuFrame) {
      menuFrame = document.createElement('div');
      menuFrame.setAttribute('style', 'position:fixed;pointer-events:none;z-index:2147483647;' +
        'border:3px solid #fff;border-radius:6px;box-shadow:0 0 0 2px rgba(0,0,0,.7),0 0 10px rgba(255,255,255,.6);' +
        'transition:all .12s;box-sizing:border-box');
    }
    if (!menuFrame.isConnected) (document.body || document.documentElement).appendChild(menuFrame);
    var r = menuCur.getBoundingClientRect();
    menuFrame.style.display = 'block';
    menuFrame.style.left = (r.left - 4) + 'px';
    menuFrame.style.top = (r.top - 4) + 'px';
    menuFrame.style.width = (r.width + 8) + 'px';
    menuFrame.style.height = (r.height + 8) + 'px';
  }
  function centre(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function nearestTo(list, r) {
    var c = centre(r), best = null, bd = Infinity;
    for (var i = 0; i < list.length; i++) {
      var o = centre(list[i].getBoundingClientRect());
      var d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best;
  }
  function firstPick(list) {
    var tests = [/caption|subtitle|\bcc\b|\bsubs?\b/, /setting|gear|quality|speed|cog/];
    for (var t = 0; t < tests.length; t++) {
      for (var i = 0; i < list.length; i++) if (tests[t].test(labelOf(list[i]))) return list[i];
    }
    // Otherwise the bottom-right one (where controls usually sit)
    var best = null, bs = -Infinity;
    for (var j = 0; j < list.length; j++) {
      var r = list[j].getBoundingClientRect(), sc = r.bottom * 2 + r.right;
      if (sc > bs) { bs = sc; best = list[j]; }
    }
    return best;
  }
  function menuStep(dir) {
    var list = pressables();
    if (!list.length) return;
    if (!menuCur || list.indexOf(menuCur) < 0) {
      menuCur = menuCur && menuCur.isConnected ? nearestTo(list, menuCur.getBoundingClientRect()) : firstPick(list);
      drawFrame();
      return;
    }
    var a = menuCur.getBoundingClientRect(), ac = centre(a);
    // The next one along the same line first (◀ ▶ = same row, ▲ ▼ = same column), nearest
    // first, so you go through them one at a time; only if there's none, the nearest anywhere
    var best = null, bestScore = Infinity, bestLine = false;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === menuCur || el.contains(menuCur) || menuCur.contains(el)) continue;
      var b = el.getBoundingClientRect(), bc = centre(b);
      var along, across, line;
      if (dir === 'left' || dir === 'right') {
        along = dir === 'right' ? bc.x - ac.x : ac.x - bc.x;
        across = Math.abs(bc.y - ac.y);
        line = bc.y > a.top - 2 && bc.y < a.bottom + 2 || ac.y > b.top - 2 && ac.y < b.bottom + 2;
      } else {
        along = dir === 'down' ? bc.y - ac.y : ac.y - bc.y;
        across = Math.abs(bc.x - ac.x);
        line = bc.x > a.left - 2 && bc.x < a.right + 2 || ac.x > b.left - 2 && ac.x < b.right + 2;
      }
      if (along <= 2) continue;
      var score = line ? along : along + across * 3;
      if ((line && !bestLine) || (line === bestLine && score < bestScore)) { bestScore = score; best = el; bestLine = line; }
    }
    if (best) { menuCur = best; drawFrame(); }
  }
  function menuPress() {
    if (!menuCur || !menuCur.isConnected) { menuStep('down'); return; }
    var before = pressables(), pressed = menuCur, pr = pressed.getBoundingClientRect();
    // The player's own fullscreen button: we're already fullscreen, so it means "leave"
    if (/full.?screen|exit.?full|expand|maximi/.test(labelOf(pressed))) {
      try { window.top.postMessage({ vsHook: 'menu', state: 'fullscreen', token: TOKEN }, '*'); } catch (e) {}
      return;
    }
    if (menuReal) {
      // A real tap, as if you'd touched the screen there (the app does it): Vid Search
      // works out where on the screen that is
      try { window.parent.postMessage({ vsHook: 'tapUp', x: pr.left + pr.width / 2, y: pr.top + pr.height / 2, token: TOKEN }, '*'); } catch (e) {}
    } else {
      pressIt(pressed);
    }
    setTimeout(function () {
      if (!menuOn) return;
      wakeControls();
      var now = pressables();
      // A menu just opened: jump into it (to the option that's ticked, if there is one)
      var fresh = now.filter(function (el) { return before.indexOf(el) < 0; });
      if (fresh.length) {
        menuOpener = pressed;                // to come back to when this menu closes
        var ticked = fresh.filter(function (el) {
          return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ||
                 /\b(active|selected|checked|current)\b/.test(typeof el.className === 'string' ? el.className : '');
        });
        // otherwise the first one in the menu (top, then left)
        menuCur = ticked[0] || fresh.slice().sort(function (x, y) {
          var a = x.getBoundingClientRect(), b = y.getBoundingClientRect();
          return Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left;
        })[0];
      } else if (now.indexOf(pressed) < 0) {
        // You picked something and the menu closed: back to the button that opened it
        menuCur = menuOpener && now.indexOf(menuOpener) >= 0 ? menuOpener : (now.length ? nearestTo(now, pr) : null);
        menuOpener = null;
      }
      drawFrame();
    }, menuReal ? 550 : 350);
  }
  function menuStart(real) {
    menuOn = true;
    menuReal = !!real;
    if (!allVideos(document).length) return;      // not the box with the video in it
    wakeControls();
    clearInterval(menuWake);
    menuWake = setInterval(function () { wakeControls(); drawFrame(); }, 1200);
    setTimeout(function () {
      if (!menuOn) return;
      wakeControls();
      var list = pressables();
      menuCur = list.length ? firstPick(list) : null;
      drawFrame();
      try { window.top.postMessage({ vsHook: 'menu', state: list.length ? 'on' : 'none', token: TOKEN }, '*'); } catch (e) {}
    }, 300);
  }
  function menuEnd() {
    var was = menuOn && allVideos(document).length;
    menuOn = false;
    menuCur = null;
    menuOpener = null;
    clearInterval(menuWake);
    drawFrame();
    if (was) hideControlsSoon();
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && typeof m === 'object' && m.vsHook === 'tapUp' && m.token === TOKEN) {
      var fr = document.querySelectorAll('iframe, frame');
      for (var q = 0; q < fr.length; q++) {
        if (fr[q].contentWindow !== e.source) continue;
        var rr = fr[q].getBoundingClientRect();
        try {
          window.parent.postMessage({ vsHook: 'tapUp', token: TOKEN,
            x: rr.left + fr[q].clientLeft + m.x, y: rr.top + fr[q].clientTop + m.y }, '*');
        } catch (err) {}
        break;
      }
      return;
    }
    if (m && typeof m === 'object' && m.vsHookAd === 'remove' && m.token === TOKEN) {
      var boxes = document.querySelectorAll('iframe, frame');
      for (var b = 0; b < boxes.length; b++) {
        if (boxes[b].contentWindow === e.source) { killFrame(boxes[b]); break; }
      }
      return;
    }
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
    if (m.vsHookCmd === 'lock') lockDown();
    if (/^menu/.test(m.vsHookCmd)) {
      if (m.vsHookCmd === 'menuStart') menuStart(m.realTap);
      else if (m.vsHookCmd === 'menuEnd') menuEnd();
      else if (menuOn && allVideos(document).length) {
        if (m.vsHookCmd === 'menuMove') { wakeControls(); menuStep(m.dir); }
        if (m.vsHookCmd === 'menuPress') { wakeControls(); menuPress(); }
      }
      for (var f = 0; f < window.frames.length; f++) {
        try { window.frames[f].postMessage(m, '*'); } catch (err) {}
      }
      return;
    }

    var v = (fsCmd || m.vsHookCmd === 'start' || m.vsHookCmd === 'lock') ? null : mainVideo();
    if (v) {
      try {
        if (m.vsHookCmd === 'play') {
          var p = v.play();
          if (p && p.catch) p.catch(function () {});
          hideControlsSoon();
        } else if (m.vsHookCmd === 'pause') {
          v.pause();
        } else if (m.vsHookCmd === 'unmute') {
          v.muted = false;                       // the player muted itself to start by itself
          if (v.volume === 0) v.volume = 1;
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
