(function () {
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  if (hasGsap) {
    gsap.registerPlugin(ScrollTrigger);
  }

  /* ---------- Shared viewing location ---------- */

  /*
   * The modules below are otherwise independent, but several of them show the
   * same location-dependent numbers — the countdown, the scroll scene's phase
   * clock, the coverage stat and the map marker. This is the one piece of state
   * they share, so a location change lands everywhere at once instead of each
   * module re-deriving it.
   *
   * eclipse-location.js publishes here; nothing in this file ever sets it.
   * Payload shape is documented in that file.
   */
  var eclipseLocation = (function () {
    var current = null;
    var listeners = [];
    return {
      get: function () {
        return current;
      },
      subscribe: function (fn) {
        listeners.push(fn);
        // Late subscribers still get the state that was set before they arrived.
        if (current) {
          fn(current);
        }
      },
      set: function (location) {
        current = location;
        for (var i = 0; i < listeners.length; i += 1) {
          listeners[i](location);
        }
      }
    };
  })();
  window.eclipseLocation = eclipseLocation;

  /* ---------- Header: hidden on the splash, reveals after the hero ---------- */

  (function headerReveal() {
    var header = document.getElementById('site-header');
    var cover = document.getElementById('cover');
    if (!header || !cover) {
      return;
    }

    header.classList.add('is-hidden');
    var shown = false;

    function update() {
      // Reveal once the reader has scrolled ~72% through the pinned hero, so the
      // menu arrives as the eclipse story gives way to the content sections.
      var scrollTop = window.scrollY || window.pageYOffset;
      var trigger = cover.offsetTop + cover.offsetHeight * 0.72 - window.innerHeight;
      var next = scrollTop > trigger;
      if (next !== shown) {
        shown = next;
        header.classList.toggle('is-hidden', !shown);
      }
    }

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  })();

  /* ---------- Mobile nav toggle ---------- */

  (function navMenu() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('site-nav');
    if (!toggle || !nav) {
      return;
    }

    function setOpen(open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }

    toggle.addEventListener('click', function () {
      setOpen(!nav.classList.contains('is-open'));
    });

    nav.addEventListener('click', function (event) {
      if (event.target.tagName === 'A') {
        setOpen(false);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    });
  })();

  /* ---------- Countdown to eclipse ---------- */

  (function countdown() {
    var el = document.getElementById('countdown-value');
    if (!el) {
      return;
    }
    // First contact over Dublin: 18:12:53 Irish Summer Time (UTC+1).
    var target = new Date('2026-08-12T18:12:53+01:00').getTime();
    var unavailable = false;

    eclipseLocation.subscribe(function (loc) {
      unavailable = !loc.circ.visible || !loc.circ.firstContact;
      if (!unavailable) {
        target = loc.circ.firstContact.getTime();
      }
      render();
    });

    function pad(n) {
      return (n < 10 ? '0' : '') + n;
    }

    function render() {
      if (unavailable) {
        el.textContent = '—';
        return;
      }
      var diff = target - Date.now();
      if (diff <= 0) {
        el.textContent = 'Underway';
        return;
      }
      var days = Math.floor(diff / 86400000);
      var hours = Math.floor((diff % 86400000) / 3600000);
      var mins = Math.floor((diff % 3600000) / 60000);
      var secs = Math.floor((diff % 60000) / 1000);
      el.textContent = days + 'd ' + pad(hours) + 'h ' + pad(mins) + 'm ' + pad(secs) + 's';
    }

    render();
    window.setInterval(render, 1000);
  })();

  /* ---------- Eclipse scroll scene ---------- */

  (function eclipseScene() {
    var sceneSection = document.getElementById('cover');
    var stage = document.querySelector('.eclipse-canvas');
    var moon = document.getElementById('moon');
    var phaseEl = document.getElementById('telemetry-phase');
    var coverageEl = document.getElementById('telemetry-coverage');
    var timeEl = document.getElementById('telemetry-time');

    if (!sceneSection || !stage || !moon || !phaseEl || !coverageEl || !timeEl) {
      return;
    }

    // The Moon and Sun discs are the same rendered size (see CSS), so the Sun's
    // radius in px is half the Moon element's width. Cached and re-measured on
    // resize so coverage geometry stays correct across viewports.
    var sunRadius = 0;
    function measureDiscs() {
      sunRadius = moon.offsetWidth / 2;
      applyPeakCoverage();
    }

    var timeByPhase = {
      pre: '~18:05 IST',
      first: '18:13 IST',
      deep: '~18:45 IST',
      max: '19:11 IST',
      exit: '~19:40 IST',
      end: '20:05 IST'
    };

    // Moon travel across the sun, in px. The Moon enters from the right and
    // exits left, matching how the eclipse actually tracks across the sky over
    // Ireland. Everything that should peak at maximum eclipse is derived from
    // these so it can never drift out of sync with the geometry again: the Moon
    // is horizontally centred on the Sun (max overlap) when eased travel ===
    // -MOON_START_X / MOON_TRAVEL_X; inverting the easing gives the scroll
    // progress at which that happens (sign-independent, so reversing direction
    // leaves the peak in place).
    var MOON_START_X = 330;
    var MOON_TRAVEL_X = -650;
    var MOON_DROP_Y = 28;
    // Arc amplitude. Entry/exit sit at MOON_DROP_Y; at maximum the Moon lifts to a
    // vertical miss of (MOON_DROP_Y - MOON_ARC_Y), which is what sets peak
    // obscuration. Derived from the location's real obscuration in
    // applyPeakCoverage() rather than hand-tuned, so the picture and the readout
    // can never disagree.
    var MOON_ARC_Y = 24;
    var MAX_ECLIPSE_PROGRESS = Math.acos(1 - 2 * (-MOON_START_X / MOON_TRAVEL_X)) / Math.PI;

    // Peak obscuration for the current viewing location, in percent. Dublin's
    // computed value is the default; eclipse-location.js replaces it.
    var peakCoverage = 94;

    /*
     * Overlap fraction of two equal circles whose centres are `ratio` radii
     * apart — the same lens area as coverageFromGeometry, but scale-free, so it
     * can be inverted once and reused at any rendered disc size.
     */
    function equalCircleFraction(ratio) {
      if (ratio >= 2) {
        return 0;
      }
      if (ratio <= 0) {
        return 1;
      }
      return (2 * Math.acos(ratio / 2) - (ratio / 2) * Math.sqrt(4 - ratio * ratio)) / Math.PI;
    }

    // Invert the above: how many radii apart the discs must sit to hide exactly
    // `percent` of the Sun. Bisection — the function is monotonic on [0, 2].
    function missRatioFor(percent) {
      var goal = clamp(percent, 0, 100) / 100;
      var lo = 0;
      var hi = 2;
      for (var i = 0; i < 48; i += 1) {
        var mid = (lo + hi) / 2;
        if (equalCircleFraction(mid) > goal) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return (lo + hi) / 2;
    }

    function applyPeakCoverage() {
      MOON_ARC_Y = MOON_DROP_Y - missRatioFor(peakCoverage) * sunRadius;
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function easeInOutSine(value) {
      return -(Math.cos(Math.PI * value) - 1) / 2;
    }

    function computeProgress() {
      var scrollTop = window.scrollY || window.pageYOffset;
      var start = sceneSection.offsetTop;
      var end = start + sceneSection.offsetHeight - window.innerHeight;
      if (end <= start) {
        return 0;
      }
      return clamp((scrollTop - start) / (end - start), 0, 1);
    }

    // Obscuration from the actual disc overlap. (x, y) is the Moon centre's
    // offset from the Sun centre in px; both discs share radius sunRadius. The
    // Moon only touches the Sun once the centre distance drops below 2R, so
    // coverage stays exactly 0 until first contact, peaks when the discs are
    // concentric, and returns to 0 at last contact.
    function coverageFromGeometry(x, y) {
      var r = sunRadius;
      if (r <= 0) {
        return 0;
      }
      var d = Math.sqrt(x * x + y * y);
      if (d >= 2 * r) {
        return 0;
      }
      if (d <= 0) {
        return peakCoverage;
      }
      // Lens (intersection) area of two equal circles, radius r, centres d apart.
      var overlap = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
      var fraction = overlap / (Math.PI * r * r);
      return Math.min(Math.round(peakCoverage), Math.round(100 * fraction));
    }

    function phaseFromProgress(progress) {
      var c = MAX_ECLIPSE_PROGRESS;
      if (progress < c - 0.42) {
        return { key: 'pre', name: 'Pre-contact' };
      }
      if (progress < c - 0.22) {
        return { key: 'first', name: 'First Contact' };
      }
      if (progress < c - 0.07) {
        return { key: 'deep', name: 'Deep Partial' };
      }
      if (progress < c + 0.08) {
        return { key: 'max', name: 'Maximum Eclipse' };
      }
      if (progress < c + 0.33) {
        return { key: 'exit', name: 'Receding Phase' };
      }
      return { key: 'end', name: 'Final Contact' };
    }

    function applyState(progress) {
      var eased = easeInOutSine(progress);
      var x = MOON_START_X + eased * MOON_TRAVEL_X;
      var y = MOON_DROP_Y - Math.sin(eased * Math.PI) * MOON_ARC_Y;

      if (!reducedMotion) {
        moon.style.transform = 'translate(-50%, -50%) translate(' + x.toFixed(1) + 'px, ' + y.toFixed(1) + 'px)';
      }

      var skyShift = clamp(Math.abs(progress - MAX_ECLIPSE_PROGRESS) / MAX_ECLIPSE_PROGRESS, 0, 1);
      stage.style.setProperty('--sky-shift', skyShift.toFixed(3));

      var width = 0.18;
      var eclipseDarkness = Math.exp(-Math.pow((progress - MAX_ECLIPSE_PROGRESS) / width, 2));
      stage.style.setProperty('--eclipse-darkness', (eclipseDarkness * 0.82).toFixed(3));

      var phase = phaseFromProgress(progress);
      var coverage = coverageFromGeometry(x, y);

      phaseEl.textContent = phase.name;
      coverageEl.textContent = coverage + '%';
      timeEl.textContent = timeByPhase[phase.key];
    }

    var targetProgress = computeProgress();
    var renderedProgress = targetProgress;
    var rafId = null;

    function queueAnimation() {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(tick);
    }

    function tick() {
      rafId = null;
      targetProgress = computeProgress();

      if (reducedMotion) {
        renderedProgress = targetProgress;
      } else {
        renderedProgress += (targetProgress - renderedProgress) * 0.14;
        if (Math.abs(targetProgress - renderedProgress) < 0.0008) {
          renderedProgress = targetProgress;
        }
      }

      applyState(renderedProgress);

      if (!reducedMotion && Math.abs(targetProgress - renderedProgress) > 0.0008) {
        queueAnimation();
      }
    }

    function onScroll() {
      queueAnimation();
    }

    function onResize() {
      measureDiscs();
      queueAnimation();
    }

    eclipseLocation.subscribe(function (loc) {
      peakCoverage = loc.circ.visible ? loc.circ.obscuration : 0;
      applyPeakCoverage();

      // Rebuild the phase clock from the real contact times. "Deep" and "exit"
      // have no formal definition, so they sit midway between the contacts they
      // fall between — the same intent as the original hand-written estimates.
      var c = loc.circ;
      if (c.visible && c.firstContact && c.lastContact) {
        var midIn = new Date((c.firstContact.getTime() + c.maxEclipse.getTime()) / 2);
        var midOut = new Date((c.maxEclipse.getTime() + c.lastContact.getTime()) / 2);
        var pre = new Date(c.firstContact.getTime() - 8 * 60000);
        var zone = loc.tzAbbrev ? ' ' + loc.tzAbbrev : '';
        timeByPhase = {
          pre: '~' + loc.formatTime(pre) + zone,
          first: loc.formatTime(c.firstContact) + zone,
          deep: '~' + loc.formatTime(midIn) + zone,
          max: loc.formatTime(c.maxEclipse) + zone,
          exit: '~' + loc.formatTime(midOut) + zone,
          end: loc.formatTime(c.lastContact) + zone
        };
      } else {
        timeByPhase = {
          pre: 'Not visible', first: 'Not visible', deep: 'Not visible',
          max: 'Not visible', exit: 'Not visible', end: 'Not visible'
        };
      }

      applyState(renderedProgress);
    });

    measureDiscs();
    applyState(renderedProgress);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
  })();

  /* ---------- Cover headline entrance ---------- */

  (function coverEntrance() {
    var items = document.querySelectorAll('.cover-headline .reveal, .coverlines');
    if (!items.length) {
      return;
    }
    if (!hasGsap || reducedMotion) {
      items.forEach(function (el) {
        el.style.opacity = 1;
        el.style.transform = 'none';
      });
      return;
    }
    gsap.to(items, {
      opacity: 1,
      y: 0,
      duration: 0.9,
      ease: 'power3.out',
      stagger: 0.09,
      delay: 0.15
    });
  })();

  /* ---------- Scroll reveals for content sections ---------- */

  (function contentReveals() {
    var reveals = document.querySelectorAll('.content-section .reveal');
    if (!reveals.length) {
      return;
    }
    if (!hasGsap || reducedMotion) {
      reveals.forEach(function (el) {
        el.style.opacity = 1;
        el.style.transform = 'none';
      });
      return;
    }

    document.querySelectorAll('.content-section').forEach(function (section) {
      var els = section.querySelectorAll('.reveal');
      if (!els.length) {
        return;
      }
      gsap.to(els, {
        opacity: 1,
        y: 0,
        duration: 0.8,
        ease: 'power2.out',
        stagger: 0.07,
        scrollTrigger: {
          trigger: section,
          start: 'top 78%'
        }
      });
    });
  })();

  /* ---------- Alignment diagram: Moon slides into the line ---------- */

  (function alignDiagram() {
    var moonDisc = document.querySelector('.d-moon');
    var cone = document.querySelector('.d-cone');
    if (!moonDisc) {
      return;
    }
    if (!hasGsap || reducedMotion) {
      return;
    }
    var tl = gsap.timeline({
      scrollTrigger: {
        trigger: '.align-diagram',
        start: 'top 80%'
      }
    });
    tl.from(moonDisc, { y: -34, opacity: 0, duration: 0.9, ease: 'power3.out' });
    if (cone) {
      tl.from(cone, { opacity: 0, duration: 0.7, ease: 'power1.out' }, '-=0.35');
    }
  })();

  /* ---------- Stat counter ---------- */

  (function statCounter() {
    var el = document.querySelector('[data-count-to]');
    if (!el) {
      return;
    }
    var target = parseInt(el.getAttribute('data-count-to'), 10);
    var unit = el.querySelector('.stat-unit');
    var unitHtml = unit ? unit.outerHTML : '';
    // The count-up runs once, on first scroll-in. After that the element has to
    // stay writable, because the location can change at any point — including
    // long after the animation has finished.
    var counted = false;
    var tween = null;

    function render(value) {
      el.innerHTML = Math.round(value) + unitHtml;
    }

    eclipseLocation.subscribe(function (loc) {
      target = loc.circ.visible ? Math.round(loc.circ.obscuration) : 0;
      el.setAttribute('data-count-to', target);
      if (counted) {
        render(target);
      } else if (tween) {
        // The tween recorded its end value when it was built, so a location
        // picked before the stat scrolls into view would otherwise count up to
        // the previous number. invalidate() makes GSAP re-read it.
        tween.vars.value = target;
        tween.invalidate();
      }
    });

    if (!hasGsap || reducedMotion) {
      counted = true;
      render(target);
      return;
    }

    render(0);
    var counter = { value: 0 };
    tween = gsap.to(counter, {
      value: target,
      duration: 1.6,
      ease: 'power2.out',
      onUpdate: function () {
        render(counter.value);
      },
      onComplete: function () {
        counted = true;
        render(target);
      },
      scrollTrigger: {
        trigger: el,
        start: 'top 82%',
        once: true
      }
    });
  })();

  /* ---------- Magnetic nav / cta hover ---------- */

  (function magneticHover() {
    if (!hasGsap || reducedMotion) {
      return;
    }
    var targets = document.querySelectorAll('.site-nav a, .scroll-cta');
    targets.forEach(function (el) {
      var moveX = gsap.quickTo(el, 'x', { duration: 0.35, ease: 'power3.out' });
      var moveY = gsap.quickTo(el, 'y', { duration: 0.35, ease: 'power3.out' });

      el.addEventListener('mousemove', function (event) {
        var rect = el.getBoundingClientRect();
        var relX = event.clientX - (rect.left + rect.width / 2);
        var relY = event.clientY - (rect.top + rect.height / 2);
        moveX(relX * 0.25);
        moveY(relY * 0.4);
      });

      el.addEventListener('mouseleave', function () {
        moveX(0);
        moveY(0);
      });
    });
  })();

  /* ---------- "Scroll to witness": slow, eased scroll through the hero ---------- */

  (function slowScrollCta() {
    var cta = document.querySelector('.scroll-cta');
    var target = document.getElementById('what');
    var rootStyle = document.documentElement.style;
    if (!cta || !target) {
      return;
    }

    function ease(t) {
      return -(Math.cos(Math.PI * t) - 1) / 2;
    }

    var rafId = null;

    function teardown() {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('keydown', cancel);
      // Restore the page's CSS smooth-scroll for nav links etc.
      rootStyle.scrollBehavior = '';
    }

    function cancel() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      teardown();
    }

    cta.addEventListener('click', function (event) {
      event.preventDefault();

      var startY = window.scrollY || window.pageYOffset;
      var endY = target.getBoundingClientRect().top + startY;
      var distance = endY - startY;

      if (Math.abs(distance) < 4) {
        return;
      }

      if (reducedMotion) {
        window.scrollTo(0, endY);
        return;
      }

      cancel();
      // Disable CSS smooth-scroll so each frame lands exactly where we put it;
      // otherwise the browser re-eases toward every intermediate target and the
      // page barely advances.
      rootStyle.scrollBehavior = 'auto';

      // Pace it so the eclipse has time to read — ~5ms per pixel, clamped.
      var duration = Math.min(11000, Math.max(5000, Math.abs(distance) * 5));
      var startTime = null;

      window.addEventListener('wheel', cancel, { passive: true });
      window.addEventListener('touchstart', cancel, { passive: true });
      window.addEventListener('keydown', cancel);

      function step(now) {
        if (startTime === null) {
          startTime = now;
        }
        var t = Math.min(1, (now - startTime) / duration);
        window.scrollTo(0, startY + distance * ease(t));
        if (t < 1) {
          rafId = window.requestAnimationFrame(step);
        } else {
          rafId = null;
          teardown();
        }
      }

      rafId = window.requestAnimationFrame(step);
    });
  })();

  /* ---------- Path of totality map (Leaflet) ---------- */

  (function totalityMap() {
    var el = document.getElementById('totality-map');
    if (!el || typeof window.L === 'undefined') {
      return;
    }

    // Real geometry for the 12 Aug 2026 total eclipse, from NASA GSFC path
    // tables (eclipse.gsfc.nasa.gov), sampled every ~4 minutes of UT across the
    // Iceland → North Atlantic → Spain segment. [lat, lon] in decimal degrees.
    // The three lines share a terminus in the western Mediterranean, where the
    // path ends at sunset — so the band tapers to a point offshore instead of
    // being cut off by a flat chord across northern Spain.
    var centreLine = [
      [68.24, -26.41], [66.19, -25.63], [64.17, -24.76], [62.18, -23.79],
      [60.22, -22.74], [58.27, -21.57], [56.32, -20.29], [54.36, -18.85],
      [52.37, -17.21], [50.33, -15.32], [48.21, -13.05], [45.94, -10.19],
      [43.37, -6.19], [41.82, -3.19], [39.41, 2.95], [38.40, 4.60]
    ];
    var northLimit = [
      [68.73, -22.95], [66.63, -22.44], [64.57, -21.77], [62.55, -20.96],
      [60.55, -20.02], [58.56, -18.94], [56.57, -17.71], [54.56, -16.30],
      [52.52, -14.65], [50.42, -12.69], [48.21, -10.27], [45.80, -7.08],
      [42.91, -2.09], [40.67, 3.30], [39.40, 4.20], [38.40, 4.60]
    ];
    var southLimit = [
      [67.72, -29.63], [65.70, -28.63], [63.73, -27.58], [61.78, -26.48],
      [59.86, -25.32], [57.95, -24.08], [56.04, -22.74], [54.12, -21.28],
      [52.18, -19.65], [50.20, -17.80], [48.15, -15.64], [45.98, -13.01],
      [43.61, -9.55], [42.26, -7.24], [40.68, -4.04], [39.60, 0.60],
      [38.70, 3.80], [38.40, 4.60]
    ];
    // Catmull-Rom spline: turn the sparse NASA anchor points into a dense, smooth
    // curve so the band and centre line read as flowing arcs, not straight chords.
    function smooth(pts) {
      if (pts.length < 3) {
        return pts.slice();
      }
      var out = [];
      var seg = 16;
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i > 0 ? i - 1 : 0];
        var p1 = pts[i];
        var p2 = pts[i + 1];
        var p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
        for (var t = 0; t < seg; t++) {
          var s = t / seg;
          var s2 = s * s;
          var s3 = s2 * s;
          out.push([
            0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * s + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * s2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * s3),
            0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * s + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * s3)
          ]);
        }
      }
      out.push(pts[pts.length - 1]);
      return out;
    }

    var centre = smooth(centreLine);
    // Close the band: smoothed northern limit, then smoothed southern limit back.
    var band = smooth(northLimit).concat(smooth(southLimit).reverse());

    // Obscuration figures below are computed from the NASA Besselian elements by
    // eclipse-besselian.js, so they agree with everything else on the page.
    // `total` cities sit inside the band.
    var cities = [
      { latlng: [64.13, -21.90], name: 'Reykjavík', sub: 'Iceland', total: true, meta: '≈57 s of totality · maximum 17:48 GMT', dir: 'right' },
      { latlng: [43.36, -8.41], name: 'A Coruña', sub: 'N. Spain', total: true, meta: '≈75 s of totality at sunset · maximum 20:28 CEST', dir: 'left' },
      { latlng: [40.42, -3.70], name: 'Madrid', sub: 'Spain', cover: 100, meta: '99.96% covered, but no totality — a whisker south of the path · maximum 20:32 CEST', dir: 'right' },
      { latlng: [53.35, -6.26], name: 'Dublin', sub: 'Ireland', cover: 94, meta: '~94% covered · maximum 19:10 IST', dir: 'left' },
      { latlng: [51.51, -0.13], name: 'London', sub: 'England', cover: 91, meta: '~91% covered · maximum 19:13 BST', dir: 'top' },
      { latlng: [48.85, 2.35], name: 'Paris', sub: 'France', cover: 92, meta: '~92% covered · maximum 20:17 CEST', dir: 'right' },
      { latlng: [38.72, -9.14], name: 'Lisbon', sub: 'Portugal', cover: 94, meta: '~94% covered · maximum 19:36 WEST', dir: 'left' }
    ];

    // On touch devices, one-finger drag would trap the reader on the map instead
    // of letting the page scroll, so lock the map to a static illustration there.
    var coarsePointer = window.matchMedia('(pointer: coarse)').matches;

    var map = L.map(el, {
      scrollWheelZoom: false,
      dragging: !coarsePointer,
      touchZoom: !coarsePointer,
      doubleClickZoom: !coarsePointer,
      boxZoom: false,
      keyboard: false,
      zoomControl: !coarsePointer,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 7
    });

    // Deep, near-black basemap — warmed toward the page's cosmic indigo in CSS —
    // so land and water both read as night and the ember eclipse band stands out.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Eclipse path: NASA GSFC',
      subdomains: 'abcd',
      maxZoom: 8
    }).addTo(map);

    map.fitBounds([[37.5, -29.0], [68.5, 6.0]], { padding: [10, 10] });
    map.setMaxBounds([[31, -42], [74, 18]]);

    // ----- Partial-coverage shading -----
    // Offset the centre line perpendicular by a distance in degrees of latitude
    // (~111 km each), correcting longitude by cos(lat) so the step is even on the
    // ground. A "buffer" wraps a capsule of that radius around the whole path.
    function offsetLine(pts, distDeg, side) {
      var res = [];
      var n = pts.length;
      for (var i = 0; i < n; i++) {
        var a = pts[Math.max(0, i - 1)];
        var b = pts[Math.min(n - 1, i + 1)];
        var lat = pts[i][0];
        var lon = pts[i][1];
        var cos = Math.cos(lat * Math.PI / 180) || 1e-6;
        var tx = (b[1] - a[1]) * cos;
        var ty = (b[0] - a[0]);
        var len = Math.sqrt(tx * tx + ty * ty) || 1e-6;
        tx /= len;
        ty /= len;
        // Left-hand normal (-ty, tx); `side` flips it. +1 falls east of the path.
        var nx = -ty * side;
        var ny = tx * side;
        // Taper the offset to zero over the first/last ~14% of the line so each
        // buffer closes to a point at the path ends — nested leaf shapes rather
        // than wide capsules that fan out to the map corners.
        var t = n > 1 ? i / (n - 1) : 0.5;
        var dd = distDeg * Math.min(1, Math.min(t, 1 - t) / 0.14);
        res.push([lat + ny * dd, lon + (nx * dd) / cos]);
      }
      return res;
    }

    function buffer(pts, distDeg) {
      return offsetLine(pts, distDeg, 1).concat(offsetLine(pts, distDeg, -1).reverse());
    }

    // Nested capsules, widest first, so translucent ember stacks toward the path.
    // Distances are tuned so the steps roughly track the labelled city figures;
    // they are indicative shading, not exact magnitude contours.
    var coverBands = [
      { d: 26, cover: 45 },
      { d: 21, cover: 55 },
      { d: 17, cover: 65 },
      { d: 13, cover: 75, label: true },
      { d: 10, cover: 82 },
      { d: 7, cover: 90, label: true }
    ];

    coverBands.forEach(function (b) {
      L.polygon(buffer(centre, b.d), {
        stroke: false,
        fillColor: '#e8863f',
        fillOpacity: 0.075,
        interactive: false
      }).addTo(map);
    });

    // Faint dashed contour + a label on a couple of levels, placed wherever the
    // eastern offset happens to fall inside the visible frame.
    var emptyIcon = L.divIcon({ className: '', html: '', iconSize: [0, 0] });
    coverBands.forEach(function (b) {
      if (!b.label) {
        return;
      }
      var east = offsetLine(centre, b.d, 1);
      L.polyline(east, {
        color: '#f8b06c',
        weight: 1,
        opacity: 0.32,
        dashArray: '3 6',
        interactive: false
      }).addTo(map);

      // Pick a vertex near mid-latitudes that sits within the frame for the label.
      var spot = null;
      for (var i = 0; i < east.length; i++) {
        var p = east[i];
        if (p[0] > 47 && p[0] < 56 && p[1] > -26 && p[1] < 3) {
          if (!spot || Math.abs(p[0] - 51.5) < Math.abs(spot[0] - 51.5)) {
            spot = p;
          }
        }
      }
      if (spot) {
        L.marker(spot, { icon: emptyIcon, interactive: false, keyboard: false })
          .addTo(map)
          .bindTooltip('~' + b.cover + '%', {
            permanent: true,
            direction: 'center',
            className: 'coverage-contour-tip'
          })
          .openTooltip();
      }
    });

    // Band of totality.
    L.polygon(band, {
      color: '#e8863f',
      weight: 1,
      opacity: 0.85,
      fillColor: '#e8863f',
      fillOpacity: 0.28,
      interactive: false
    }).addTo(map);

    // Soft glow beneath the centre line so it reads as light on the dark sky.
    L.polyline(centre, {
      color: '#f8b06c',
      weight: 9,
      opacity: 0.16,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    }).addTo(map);

    // Centre line — a hot near-white core, drawn on scroll below.
    var line = L.polyline(centre, {
      color: '#fff6ea',
      weight: 2.6,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    }).addTo(map);

    // Nudge each label clear of its 14px dot in the tooltip's direction.
    function tipOffset(dir) {
      if (dir === 'left') { return [-9, 0]; }
      if (dir === 'top') { return [0, -9]; }
      if (dir === 'bottom') { return [0, 9]; }
      return [9, 0];
    }

    cities.forEach(function (city) {
      var icon = L.divIcon({
        className: '',
        html: '<div class="totality-marker' + (city.total ? '' : ' is-partial') + '"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
      var label = city.total ? 'Total' : city.cover + '%';
      L.marker(city.latlng, { icon: icon, keyboard: false })
        .addTo(map)
        .bindTooltip(label, {
          permanent: true,
          direction: city.dir || 'right',
          className: 'totality-tip' + (city.total ? ' is-total' : ''),
          offset: tipOffset(city.dir)
        })
        .bindPopup(
          '<span class="totality-popup-name">' + city.name + '</span>' +
          '<span class="totality-popup-tag">' + (city.total ? 'Totality — ' : 'Partial — ') + city.sub + '</span>' +
          '<span class="totality-popup-meta">' + city.meta + '</span>'
        );
    });

    /* ----- Marker for the reader's own viewing location ----- */

    // This is what the "Viewing location" swatch in the legend refers to; until
    // a location is chosen there is nothing on the map for it to point at.
    var userMarker = null;

    eclipseLocation.subscribe(function (loc) {
      if (userMarker) {
        map.removeLayer(userMarker);
        userMarker = null;
      }
      if (!loc.circ.visible) {
        return;
      }

      var total = !!loc.circ.isTotal;
      var label = total ? 'You — total' : 'You — ' + Math.round(loc.circ.obscuration) + '%';
      userMarker = L.marker(loc.latlng, {
        icon: L.divIcon({
          className: '',
          html: '<div class="totality-marker is-user"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        }),
        keyboard: false,
        zIndexOffset: 1000
      })
        .addTo(map)
        .bindTooltip(label, {
          permanent: true,
          direction: 'bottom',
          className: 'totality-tip is-user',
          offset: [0, 10]
        })
        .bindPopup(
          '<span class="totality-popup-name">' + loc.label + '</span>' +
          '<span class="totality-popup-tag">' + (total ? 'Totality' : 'Partial') + ' — your viewing location</span>' +
          '<span class="totality-popup-meta">' + loc.mapMeta + '</span>'
        );

      // The map is normally penned into the North Atlantic / Europe frame. A
      // reader outside it (the eclipse is partial as far west as the Americas)
      // would otherwise have a marker they could never pan to, so widen the
      // limit enough to reach them.
      var limit = map.options.maxBounds;
      if (limit && !limit.contains(loc.latlng)) {
        map.setMaxBounds(L.latLngBounds(limit.getSouthWest(), limit.getNorthEast()).extend(loc.latlng).pad(0.1));
      }

      // Only move the map if the reader would otherwise not see their own marker.
      if (!map.getBounds().pad(-0.08).contains(loc.latlng)) {
        map.flyTo(loc.latlng, Math.max(map.getZoom(), 4), { duration: 1.1 });
      }
    });

    // Keep the rendered size correct once layout settles and on resize.
    window.setTimeout(function () { map.invalidateSize(); }, 200);
    window.addEventListener('resize', function () { map.invalidateSize(); });

    /* ----- Draw the centre line in as the section scrolls into view ----- */

    // Leaflet vector layers keep their rendered SVG element on `_path`.
    var path = line._path || (typeof line.getElement === 'function' ? line.getElement() : null);
    if (!path || typeof path.getTotalLength !== 'function' || !hasGsap || reducedMotion) {
      return; // No SVG path or no GSAP: leave the line fully drawn.
    }

    var length = path.getTotalLength();
    if (!length) {
      return;
    }

    // Prime the stroke as a single dash the length of the whole line, offset out
    // of view, then animate the offset to zero so it appears to draw itself.
    path.style.strokeDasharray = length;
    path.style.strokeDashoffset = length;

    gsap.to(path, {
      strokeDashoffset: 0,
      duration: 1.8,
      ease: 'power2.inOut',
      scrollTrigger: {
        trigger: el,
        start: 'top 72%',
        once: true
      },
      onComplete: function () {
        // Clear the dash so any later Leaflet reproject keeps the line solid.
        path.style.strokeDasharray = 'none';
        path.style.strokeDashoffset = '0';
      }
    });
  })();
})();
