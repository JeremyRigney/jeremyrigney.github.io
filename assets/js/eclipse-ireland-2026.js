(function () {
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  if (hasGsap) {
    gsap.registerPlugin(ScrollTrigger);
  }

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
    // First contact: 18:12:56 Irish Summer Time (UTC+1) = 17:12:56 UTC.
    var target = new Date('2026-08-12T18:12:56+01:00').getTime();

    function pad(n) {
      return (n < 10 ? '0' : '') + n;
    }

    function render() {
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
    // vertical miss of (MOON_DROP_Y - MOON_ARC_Y) ≈ 4px, so the discs very nearly
    // coincide and peak obscuration reads ~96% (a hair off perfect centre).
    var MOON_ARC_Y = 24;
    var MAX_ECLIPSE_PROGRESS = Math.acos(1 - 2 * (-MOON_START_X / MOON_TRAVEL_X)) / Math.PI;

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
        return 98;
      }
      // Lens (intersection) area of two equal circles, radius r, centres d apart.
      var overlap = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
      var fraction = overlap / (Math.PI * r * r);
      return Math.min(98, Math.round(98 * fraction));
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

    function render(value) {
      el.innerHTML = Math.round(value) + unitHtml;
    }

    if (!hasGsap || reducedMotion) {
      render(target);
      return;
    }

    render(0);
    var counter = { value: 0 };
    gsap.to(counter, {
      value: target,
      duration: 1.6,
      ease: 'power2.out',
      onUpdate: function () {
        render(counter.value);
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
})();
