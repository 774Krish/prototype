/* =========================================================
   Theme switch — the DARK/LIGHT slider in the header
   A single source of truth: body.light-mode drives every colour on the page
   (including the knob position), so all this needs to do is flip that class
   and keep the ARIA state in step.
   ========================================================= */
(function initThemeSwitch() {
  const themeSwitch = document.getElementById('theme-switch');

  /* Wrapped in a guard rather than left at the top level. This file is one
     long sequence, so anything that threw here would take the loading
     overlay, the matrix rain and the custom cursor down with it — an
     inconvenience in the header must not be able to break the whole page. */
  if (!themeSwitch) return;

  function applyTheme(light) {
    document.body.classList.toggle('light-mode', light);
    /* role="switch" needs aria-checked kept in sync by hand; the browser has
       no way to infer it. The knob and the highlighted label are pure CSS. */
    themeSwitch.setAttribute('aria-checked', String(light));
  }

  /* The inline script in <head> already restored the saved theme before the
     first paint, so the state is read back off <body> rather than out of
     localStorage a second time. One source of truth, and it stays correct
     even when storage access throws and nothing was restored.

     There is deliberately no textContent assignment anywhere in here: the
     button now holds real markup (two labels + the knob), and writing
     textContent would delete all of it. That was how the emoji version
     worked, and it is the one habit that breaks this control. */
  applyTheme(document.body.classList.contains('light-mode'));

  themeSwitch.addEventListener('click', () => {
    const light = !document.body.classList.contains('light-mode');
    applyTheme(light);

    // Save preference
    try {
      localStorage.setItem('theme', light ? 'light' : 'dark');
    } catch (e) { /* private mode can throw on localStorage access */ }
  });
})();

/* =========================================================
   Loading overlay — holds until the page has really loaded
   ========================================================= */
(function initLoader() {
  const loader = document.getElementById('loader');
  if (!loader) return;

  /* The overlay is deliberately shown to every visitor, so it needs a
     floor on how briefly it can appear. On a fast connection 'load' can
     fire in well under 100ms, and an overlay that flashes for one frame
     reads as a rendering glitch rather than an introduction. This holds
     it on screen long enough to actually be read.

     Total time to a clear screen is roughly:
       MIN_DISPLAY_MS (1100) + fill (350) + fade (450) ~= 1.9s    */
  const MIN_DISPLAY_MS = 1100;

  let dismissed = false;

  function dismiss() {
    if (dismissed) return;
    dismissed = true;

    // performance.now() counts from navigation start, so this already
    // includes the HTML download and parse — the honest elapsed time.
    const wait = Math.max(0, MIN_DISPLAY_MS - performance.now());

    setTimeout(() => {
      // Fill the bar first, so the visitor sees it complete rather than
      // vanishing mid-progress
      loader.classList.add('bar-full');

      // Then fade the overlay out once that fill has had time to read
      setTimeout(() => {
        loader.classList.add('loaded');

        loader.addEventListener('transitionend', () => loader.remove(), { once: true });
        // Backstop for transitionend, which does not fire while the tab is
        // in the background — the node would otherwise linger in the DOM
        setTimeout(() => loader.remove(), 900);
      }, 350);
    }, wait);
  }

  // 'load' waits for stylesheets, web fonts and the hero image, which is
  // exactly the set of things holding up the first meaningful paint
  if (document.readyState === 'complete') {
    dismiss();
  } else {
    window.addEventListener('load', dismiss);
  }

  // Failsafe: one stalled third-party request (that hotlinked guitar PNG)
  // must never lock the visitor out of the page behind the overlay
  setTimeout(dismiss, 8000);
})();

/* =========================================================
   Matrix rain backdrop (Hero) — ice-blue digital rain
   with random Japanese katakana glyphs
   ========================================================= */
(function initMatrixRain() {
  const canvas = document.getElementById('matrix3DCanvas');
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext('2d');
  const wrapper = canvas.parentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- Glyph alphabet: katakana + digits, Matrix style --- */
  const GLYPHS =
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ' +
    'マミムメモヤユヨラリルレロワン0123456789';
  const randomGlyph = () => GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));

  /* --- Tuning --- */
  const TAIL = 16;              // glyphs trailing behind each bright head
  const MAX_DPR = 1.5;          // 2 costs 2.25x the fill rate of 1.5 for no visible gain
  const GLYPH_CACHE = 64;       // per-column glyph buffer
  const HEAD_GLOW = 16;         // canvas blur radius on the bright head glyph
  const ALPHA_STEPS = 24;       // quantisation levels in the pre-built trail ramp
  const MIN_FRAME_MS = 1000 / 90;  // only throttle displays faster than ~90Hz

  let columns = [];
  let width = 0;
  let height = 0;
  let fontSize = 18;
  let step = fontSize * 1.15;
  let visible = true;
  let rafId = null;
  let lastTime = 0;
  let lastDraw = 0;

  /* --- Ice-blue palette (theme aware) --- */
  let headColor = '#eafcff';
  let glowColor = '170, 245, 255';
  let trailColor = '110, 214, 250';
  let fadeColor = 'rgba(0, 0, 0, 0.12)';  // alpha-only trail eraser
  let blendMode = 'lighter';              // additive glow on the dark theme

  /* Pre-built fill styles for the trail.
     Composing "rgba(...)" inside the draw loop meant ~1,300 string
     allocations and CSS colour parses every frame — constant garbage
     collection pressure, which is what produced the intermittent
     hitching rather than a steady low frame rate. Quantising the alphas
     also keeps the number of distinct fillStyle values small, so the
     renderer can hold its geometry batches instead of restarting them
     for each new colour. */
  let trailRamp = new Array(TAIL);

  function buildTrailRamp() {
    const table = new Array(ALPHA_STEPS + 1);
    for (let i = 0; i <= ALPHA_STEPS; i++) {
      table[i] = 'rgba(' + trailColor + ', ' + (i / ALPHA_STEPS).toFixed(3) + ')';
    }
    for (let k = 0; k < TAIL; k++) {
      const alpha = Math.pow(1 - k / TAIL, 1.35) * 0.7;
      // Never quantise to fully transparent — the tail must stay visible
      trailRamp[k] = table[Math.max(1, Math.round(alpha * ALPHA_STEPS))];
    }
  }

  function refreshPalette() {
    const light = document.body.classList.contains('light-mode');
    headColor = light ? '#06323f' : '#eafcff';
    glowColor = light ? '10, 108, 138' : '170, 245, 255';
    trailColor = light ? '10, 92, 120' : '110, 214, 250';
    fadeColor = light ? 'rgba(0, 0, 0, 0.16)' : 'rgba(0, 0, 0, 0.12)';
    // Additive blending would blow out on a white background
    blendMode = light ? 'source-over' : 'lighter';
    buildTrailRamp();
  }
  refreshPalette();
  new MutationObserver(refreshPalette).observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });

  function makeChars() {
    const arr = new Array(GLYPH_CACHE);
    for (let i = 0; i < GLYPH_CACHE; i++) arr[i] = randomGlyph();
    return arr;
  }

  /* --- One falling stream of glyphs per grid column --- */
  function buildColumns() {
    const count = Math.ceil(width / fontSize) + 1;
    columns = [];
    for (let i = 0; i < count; i++) {
      columns.push({
        x: i * fontSize,
        y: Math.random() * -height,       // staggered start above the viewport
        speed: 45 + Math.random() * 105,  // px per second
        chars: makeChars(),
        swapIn: Math.random() * 1.5       // seconds until a glyph mutates
      });
    }
  }

  /* --- Keep canvas pixel-perfect with its container --- */
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const rect = wrapper.getBoundingClientRect();
    width = Math.max(rect.width, 1);
    height = Math.max(rect.height, 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Re-assigning canvas.width/height wipes the ENTIRE 2D context state,
    // including font/textAlign, so the cached font must be invalidated or
    // applyFont() would skip the re-apply and leave the default 10px font.
    appliedFontSize = 0;

    fontSize = window.innerWidth < 768 ? 14 : 18;
    step = fontSize * 1.15;
    applyFont();

    buildColumns();
    ctx.clearRect(0, 0, width, height);
  }

  let appliedFontSize = 0;

  function applyFont() {
    // Assigning ctx.font re-resolves the whole font stack, so only pay for
    // it when the size actually changed (i.e. from resize()). This used to
    // run on every frame for no reason.
    if (fontSize === appliedFontSize) return;
    appliedFontSize = fontSize;
    ctx.font = '600 ' + fontSize + 'px "Plus Jakarta Sans", "Segoe UI", monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
  }

  /* --- Paint one frame of falling glyphs --- */
  function render(dt) {
    // Erase the previous frame's glow; destination-out keeps the
    // backdrop transparent so the hero background still shows through
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = fadeColor;
    ctx.fillRect(0, 0, width, height);

    /* --- Advance every stream first, so the two draw passes below are
       pure painting: no simulation logic, and crucially no state changes. --- */
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      col.y += col.speed * dt;

      // Occasional glyph mutation for the flickering "decoding" look
      col.swapIn -= dt;
      if (col.swapIn <= 0) {
        col.swapIn = 0.4 + Math.random() * 2.2;
        col.chars[Math.floor(Math.random() * col.chars.length)] = randomGlyph();
      }

      // Recycle once the whole tail has left the viewport
      if (col.y - TAIL * step > height) {
        col.y = -Math.random() * height * 0.6;
        col.speed = 45 + Math.random() * 105;
        col.chars = makeChars();
        col.swapIn = Math.random() * 1.5;
      }

      col.head = Math.floor(col.y / step);  // shared by both passes
    }

    /* --- Pass 1: every faded tail glyph, sharing ONE composite state and
       one fillStyle per row index.

       This is the fix for the dark theme specifically. The dark theme
       blends with 'lighter', and the old loop reassigned the composite
       operation on every glyph — 'source-over' for the head, then back to
       'lighter' for each of the 15 tail glyphs. Across ~81 columns that is
       well over a thousand flips per frame, and each flip forces the
       renderer to flush its pending batch before it can continue. On the
       light theme both values were 'source-over', so the assignment was a
       no-op and the cost simply did not exist. Hence "laggy only in dark
       mode".

       Reordering the loops so a whole row index is painted at once is safe:
       additive blending is commutative, and in either theme the glyphs sit
       a full row apart, so they barely overlap. Same image, a fraction of
       the state changes. --- */
    ctx.globalCompositeOperation = blendMode;
    for (let k = 1; k < TAIL; k++) {
      ctx.fillStyle = trailRamp[k];
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const y = col.y - k * step;
        if (y > height + step || y < -step * 1.5) continue;

        const idx = col.head - k;
        ctx.fillText(col.chars[((idx % GLYPH_CACHE) + GLYPH_CACHE) % GLYPH_CACHE], col.x, y);
      }
    }

    /* --- Pass 2: the bright heads, drawn opaque so they stay ice-blue
       instead of blowing out to white under 'lighter'. The glow is set
       once for the whole pass rather than per glyph. --- */
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = 'rgba(' + glowColor + ', 0.95)';
    ctx.shadowBlur = HEAD_GLOW;
    ctx.fillStyle = headColor;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const y = col.y;
      if (y > height + step || y < -step * 1.5) continue;

      const idx = col.head;
      ctx.fillText(col.chars[((idx % GLYPH_CACHE) + GLYPH_CACHE) % GLYPH_CACHE], col.x, y);
    }

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(time) {
    // Re-arm first so the stream survives the early return below
    rafId = visible && !reduceMotion ? requestAnimationFrame(loop) : null;

    // The rain is a slow ambient effect and gains nothing from running at
    // 120Hz/144Hz, where it was doing 2.4x the work of a 60Hz display.
    // The threshold sits at 90Hz so normal 60Hz and 75Hz screens, where
    // frame deltas jitter around 16ms, are never accidentally skipped.
    if (time - lastDraw < MIN_FRAME_MS) return;

    const dt = Math.min((time - lastTime) / 1000 || 0, 0.05);
    lastTime = time;
    lastDraw = time;
    render(dt);
  }

  function start() {
    if (rafId === null && !reduceMotion) rafId = requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  /* --- Wiring --- */
  resize();
  if (reduceMotion) {
    render(0); // single static frame
  } else {
    start();
  }

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) {
    new ResizeObserver(resize).observe(wrapper);
  }

  // Save battery: freeze the rain while the hero is off-screen
  if (window.IntersectionObserver) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) start();
      else stop();
    }, { threshold: 0 }).observe(wrapper);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (visible) start();
  });
})();

/* =========================================================
   Custom cursor — a dot that moves freely with the pointer,
   with a circle that eases along behind it.
   ========================================================= */
(function initCustomCursor() {
  const dot = document.querySelector('.cursor-dot');
  const ring = document.querySelector('.cursor-ring');
  if (!dot || !ring) return;

  // Skip entirely on touch / coarse-pointer devices
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const INTERACTIVE = 'a, button, input, textarea, select, [role="button"], .btn';

  /* --- Tuning --- */
  const EASE = 0.14;   // 0.05 = long lazy trail, 0.3 = tight follow
  const MAX_DT = 0.06; // clamp so a stalled tab can't make the ring jump

  let targetX = window.innerWidth / 2;   // where the pointer actually is
  let targetY = window.innerHeight / 2;
  let ringX = targetX;                   // where the circle currently is
  let ringY = targetY;
  let lastTime = 0;
  let rafId = null;
  let inside = false;                    // pointer is over the page

  const place = (el, px, py) => {
    el.style.transform = 'translate3d(' + px + 'px, ' + py + 'px, 0)';
  };

  /* --- Animation loop: pull the circle toward the dot --- */
  function follow(time) {
    const dt = Math.min((time - lastTime) / 1000 || 0, MAX_DT);
    lastTime = time;

    // Frame-rate independent easing (so 60Hz and 144Hz feel the same)
    const k = 1 - Math.pow(1 - EASE, dt * 60);
    ringX += (targetX - ringX) * k;
    ringY += (targetY - ringY) * k;

    const dx = targetX - ringX;
    const dy = targetY - ringY;

    if (dx * dx + dy * dy > 0.05 || inside) {
      place(ring, ringX, ringY);
      rafId = requestAnimationFrame(follow);
    } else {
      // Settled: snap the last fraction and idle until the next move
      ringX = targetX;
      ringY = targetY;
      place(ring, ringX, ringY);
      rafId = null;
    }
  }

  function wake() {
    if (rafId === null) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(follow);
    }
  }

  function snap() {
    ringX = targetX;
    ringY = targetY;
    place(ring, ringX, ringY);
  }

  /* --- Pointer movement: dot is instant, circle eases --- */
  document.addEventListener('mousemove', (e) => {
    targetX = e.clientX;
    targetY = e.clientY;

    // The dot moves freely, exactly under the pointer
    place(dot, targetX, targetY);

    if (!inside) {
      inside = true;
      snap(); // start the circle on the dot instead of flying in from a corner
      // Re-assert every move so the layers self-heal if they were hidden
      document.body.classList.add('custom-cursor', 'cursor-active');
    }
    wake();
  });

  /* --- Grow + turn red over anything clickable --- */
  function setHover(on) {
    document.body.classList.toggle('cursor-hover', on);
  }

  document.addEventListener('mouseover', (e) => {
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) setHover(true);
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) {
      // Ignore bubbling between children of the same element
      const next = e.relatedTarget;
      if (!(next instanceof Element) || !next.closest(INTERACTIVE)) setHover(false);
    }
  });

  /* --- Press feedback --- */
  document.addEventListener('mousedown', () => document.body.classList.add('cursor-down'));
  document.addEventListener('mouseup', () => document.body.classList.remove('cursor-down'));

  /* --- Fade out when the pointer leaves the window --- */
  function hide() {
    inside = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    document.body.classList.remove('cursor-active', 'cursor-hover', 'cursor-down');
  }

  document.addEventListener('mouseleave', hide);
  window.addEventListener('blur', hide);

  // Keyboard users keep the native focus ring, so nothing is lost here.
})();

/* =========================================================
   Labelling engine (webpage-anatomy.html)
   Numbering, the chip mode, the floating label and the inspector are
   all driven from one list: the .part elements in DOM order. Adding a
   part to the markup is therefore the only step needed — no second
   list to keep in sync.

   Guarded like every other block here: the elements it needs exist only
   on the anatomy page, so on the other pages it returns immediately.
   ========================================================= */
(function initAnatomy() {
  var stage  = document.getElementById('anatomyStage');
  var probe  = document.getElementById('probeLabel');
  var legend = document.getElementById('legendGrid');
  var toggle = document.getElementById('labelToggle');
  var toggleText = document.getElementById('labelToggleText');

  var numEl  = document.getElementById('readoutNum');
  var tagEl  = document.getElementById('readoutTag');
  var nameEl = document.getElementById('readoutName');
  var descEl = document.getElementById('readoutDesc');
  var pathEl = document.getElementById('readoutPath');

  if (!stage || !probe || !legend) return;

  var parts = Array.prototype.slice.call(stage.querySelectorAll('.part'));
  if (!parts.length) return;

  var buttons = [];

  // ---- number every part, and build the index from it -------------
  parts.forEach(function (el, i) {
    var num = String(i + 1);
    el.dataset.num = num;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'legend-item';
    btn.dataset.num = num;

    var numSpan = document.createElement('span');
    numSpan.className = 'legend-num';
    numSpan.textContent = num;

    var nameSpan = document.createElement('span');
    nameSpan.className = 'legend-name';
    nameSpan.textContent = el.dataset.label || 'Element';

    btn.appendChild(numSpan);
    btn.appendChild(nameSpan);
    legend.appendChild(btn);
    buttons.push(btn);

    // Hovering or focusing the index lights the part up in place;
    // clicking scrolls to it, but only if it is off-screen.
    btn.addEventListener('mouseenter', function () { activate(el, false); });
    btn.addEventListener('focus', function () { activate(el, false); });
    btn.addEventListener('click', function () { activate(el, true); });
  });

  // ---- state -----------------------------------------------------
  var current = null;

  function labelOf(el) { return el.dataset.label || 'Element'; }

  function ancestorsOf(el) {
    var chain = [];
    var node = el.parentElement;
    while (node && node !== stage) {
      if (node.classList && node.classList.contains('part')) {
        chain.unshift(labelOf(node));
      }
      node = node.parentElement;
    }
    return chain;
  }

  function paint(el) {
    parts.forEach(function (p) { p.classList.remove('is-active', 'is-ancestor'); });
    buttons.forEach(function (b) { b.classList.remove('is-active'); });
    if (!el) return;

    el.classList.add('is-active');

    // Every part between it and the stage gets the faint ring, so the
    // nesting is visible rather than merely described.
    var node = el.parentElement;
    while (node && node !== stage) {
      if (node.classList && node.classList.contains('part')) {
        node.classList.add('is-ancestor');
      }
      node = node.parentElement;
    }

    // Keeps the two views from ever pointing at different things.
    var btn = legend.querySelector('.legend-item[data-num="' + el.dataset.num + '"]');
    if (btn) btn.classList.add('is-active');
  }

  function showProbe(el) {
    var s = stage.getBoundingClientRect();
    var r = el.getBoundingClientRect();

    probe.textContent = '';

    var numSpan = document.createElement('span');
    numSpan.className = 'probe-num';
    numSpan.textContent = el.dataset.num;

    var nameSpan = document.createElement('span');
    nameSpan.className = 'probe-name';
    nameSpan.textContent = labelOf(el);

    var sizeSpan = document.createElement('span');
    sizeSpan.className = 'probe-size';
    sizeSpan.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);

    probe.appendChild(numSpan);
    probe.appendChild(nameSpan);
    probe.appendChild(sizeSpan);
    probe.classList.add('is-on');

    var x = r.left - s.left;
    var y = r.top - s.top;

    // Never let the label hang off the side of the diagram.
    x = Math.max(0, Math.min(x, Math.max(0, s.width - probe.offsetWidth)));

    // There is no room above the first band of the page, so the label
    // flips underneath the element — clearing it, not covering it.
    var below = y <= 34;

    probe.style.left = Math.round(x) + 'px';
    probe.style.top = Math.round(below ? (r.bottom - s.top) : y) + 'px';
    probe.style.transform = below
      ? 'translateY(4px)'
      : 'translateY(calc(-100% - 6px))';
  }

  function describe(el) {
    numEl.textContent = el.dataset.num;
    nameEl.textContent = labelOf(el);
    descEl.textContent = el.dataset.desc || '';

    if (el.dataset.tag) {
      tagEl.textContent = el.dataset.tag;
      tagEl.hidden = false;
    } else {
      tagEl.hidden = true;
    }

    var chain = ancestorsOf(el);
    if (chain.length) {
      pathEl.textContent = '';
      pathEl.appendChild(document.createTextNode('Inside: '));
      chain.forEach(function (name, i) {
        if (i) pathEl.appendChild(document.createTextNode(' › '));
        var strong = document.createElement('span');
        strong.textContent = name;
        pathEl.appendChild(strong);
      });
      pathEl.hidden = false;
    } else {
      pathEl.hidden = true;
    }
  }

  function idle() {
    numEl.textContent = '–';
    tagEl.hidden = true;
    nameEl.textContent = 'Hover a region';
    descEl.textContent = 'Point at any part of the page and its name, element and purpose will appear here.';
    pathEl.hidden = true;
  }

  function activate(el, scrollTo) {
    if (!el || el === current) return;
    current = el;
    paint(el);
    showProbe(el);
    describe(el);

    if (scrollTo) {
      var r = el.getBoundingClientRect();
      // Only move the page when the part is genuinely out of view —
      // otherwise clicking the index yanks the diagram around.
      if (r.top < 90 || r.bottom > window.innerHeight) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  function clear() {
    if (!current) return;
    current = null;
    paint(null);
    probe.classList.remove('is-on');
    idle();
  }

  // ---- pointer ---------------------------------------------------
  stage.addEventListener('mouseover', function (e) {
    var target = e.target;
    var el = target && target.closest ? target.closest('.part') : null;
    if (!el || !stage.contains(el)) { clear(); return; }
    activate(el, false);
  });

  // Fires for real pointers only, so a touch tap does not clear what
  // it just set.
  stage.addEventListener('mouseleave', clear);

  // Taps: on touch there is no hover, so the tap does the work.
  stage.addEventListener('click', function (e) {
    var target = e.target;
    var el = target && target.closest ? target.closest('.part') : null;
    if (el && stage.contains(el)) activate(el, false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') clear();
  });

  // The label is positioned relative to the stage, so scrolling the
  // window cannot move it — only a resize (or a zoom) can.
  window.addEventListener('resize', function () {
    if (current) showProbe(current);
  });

  // ---- "show all labels" -----------------------------------------
  if (toggle) {
    toggle.addEventListener('click', function () {
      var on = toggle.getAttribute('aria-pressed') === 'true';
      toggle.setAttribute('aria-pressed', on ? 'false' : 'true');
      stage.classList.toggle('labels-on', !on);
      if (toggleText) {
        toggleText.textContent = on ? 'Show all labels' : 'Hide all labels';
      }
    });
  }

  idle();
})();