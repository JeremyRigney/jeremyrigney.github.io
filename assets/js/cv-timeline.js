/*
 * jeremy.ie/cv — the opening timeline.
 *
 * The atmospheric layer behind the title page, and the page's own record rather than a
 * decoration: SPANS below are the four institutions in chapters 01 and 02, and PAPERS
 * is one entry per row of chapter 05. That is the same argument dashboard-xray.js
 * makes for plotting the real GOES flux behind its opening — a squiggle behind the
 * headline of a CV would be the one mark on the page that is not evidence of anything.
 *
 * THESE ARRAYS ARE A SECOND COPY OF WHAT THE MARKUP SAYS. Add a role to chapter 01, a
 * degree to 02 or a paper to 05 and it has to be added here too, or the chart quietly
 * stops matching the page under it.
 *
 * No fetch and no dependency: the whole thing is a static draw, sized in CSS and
 * painted in device pixels, following the mechanics in speaking-map.js.
 */
(function () {
  'use strict';

  /* ---------- The record ---------- */

  /*
   * Institutions, in order. `to: null` means "to present" and is drawn to the right
   * edge of the axis. The labels are abbreviated because they are set at micro size
   * over a mask — the full names are three inches away in the chapters below.
   */
  var SPANS = [
    { label: 'UCD', from: 2016, to: 2020 },
    { label: 'QUB · PhD', from: 2020, to: 2024.9 },
    { label: 'LNRS', from: 2025.5, to: 2026.2 },
    { label: 'Optum', from: 2026.2, to: null }
  ];

  /*
   * One tick per publication. Fractional years spread the 2024 entries — the thesis
   * and two papers — so the cluster reads as three marks rather than one thick one.
   * That cluster is the point of the chart.
   */
  var PAPERS = [2014, 2021.4, 2022.6, 2024.1, 2024.45, 2024.8];

  /* The axis. Wider than the record at both ends so nothing sits on the edge. */
  var YEAR_MIN = 2013;
  var YEAR_MAX = 2027;

  /* Ticks every two years, which at this width is a label every ~90px. */
  var YEAR_STEP = 2;

  /*
   * Below this the institution labels collide with each other and with the headline,
   * and cv.css has already dropped the layer to 55% and hidden the key. The axis and
   * the ticks stay; the words come off.
   */
  var LABEL_MIN_WIDTH = 860;

  var ACCENT = '126, 156, 137'; /* --accent-soft */
  var INK_FAINT = '107, 113, 120'; /* --ink-faint */
  var LINE = '236, 238, 240'; /* --ink, used at low alpha for the rules */

  /*
   * The span bar sits this far above the axis and the publication ticks this far
   * below it. Kept tight: the whole chart has to fit between the last line of the
   * opening copy and the readout rail at the foot.
   *
   * TICK_DROP has to clear the year labels, which are drawn under the axis and are
   * about 20px deep — at 20 the discs landed on top of "2014" and "2024".
   */
  var SPAN_Y = 14;
  var TICK_DROP = 34;

  /* Reveal timings. One pass: the axis draws, then the spans, then the ticks land. */
  var AXIS_MS = 900;
  var SPAN_START = 500;
  var SPAN_GAP = 130;
  var SPAN_MS = 700;
  var TICK_START = 1100;
  var TICK_GAP = 90;
  var TICK_MS = 520;

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /* The same cubic-out --ease approximates, so the draw decelerates into its end. */
  function ease(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function main() {
    var canvas = document.getElementById('cv-timeline');
    if (!canvas || !canvas.getContext) {
      return;
    }

    var ctx = canvas.getContext('2d');
    var w = 0;
    var h = 0;
    var started = 0;
    var running = false;

    /*
     * A device-pixel-ratio-aware resize. The canvas is sized in device pixels and
     * scaled back down in CSS, then the context is scaled so every draw call below can
     * work in CSS pixels and stay readable.
     */
    function size() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      if (!w || !h) {
        return false;
      }
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    /*
     * Where the axis sits: centred in the empty band between the last line of the
     * opening copy and the readout rail at the foot.
     *
     * Measured rather than set as a fraction of the frame. A fraction cannot know how
     * tall the copy is, and the copy does not scale with the viewport — at 0.62 the
     * axis ran straight through the lead paragraph, and at 0.78 it cleared the
     * paragraph on a tall window and struck through the "Download full CV" line on a
     * short one. The band is the only thing that actually defines where the chart can
     * go, so it is what gets asked.
     *
     * offsetTop/offsetHeight rather than getBoundingClientRect: .opening-copy carries
     * .reveal, so before it has arrived it is translated 40px down and a rect would
     * measure the animation instead of the layout. Both elements offset from .opening,
     * which the canvas covers exactly, so these are already in canvas coordinates.
     */
    function band() {
      var frame = canvas.parentNode.parentNode;
      var copy = frame.querySelector('.opening-copy');
      var foot = frame.querySelector('.opening-foot');
      return {
        top: copy ? copy.offsetTop + copy.offsetHeight : h * 0.62,
        bottom: foot ? foot.offsetTop : h
      };
    }

    /*
     * The chart is roughly ABOVE px of labels and bar over the axis and BELOW px of
     * year labels and publication ticks under it. Centring the whole thing rather than
     * the axis keeps it off both edges of the band.
     */
    var ABOVE = 28;
    var BELOW = TICK_DROP + 4;

    function axisY() {
      var b = band();
      var mid = b.top + (b.bottom - b.top) / 2 + (ABOVE - BELOW) / 2;

      /*
       * On a short viewport the band can be narrower than the chart. Clearing the rail
       * matters more than clearing the copy — the rail is set in the same mono at the
       * same size as the chart's own labels and the two would read as one confused
       * row, whereas the copy above is prose the mask is already fading.
       */
      var y = Math.min(mid, b.bottom - BELOW);
      return Math.round(y) + 0.5;
    }

    function px(year) {
      var pad = w * 0.06;
      var span = YEAR_MAX - YEAR_MIN;
      return pad + ((year - YEAR_MIN) / span) * (w - pad * 2);
    }

    function labels() {
      return w >= LABEL_MIN_WIDTH;
    }

    /* ---------- Drawing ---------- */

    /*
     * The axis, drawn left to right. A hairline at the same weight as every rule on
     * the page — this is the same mark as the border under a chapter, laid on its side.
     */
    function drawAxis(progress) {
      if (progress <= 0) {
        return;
      }
      var y = axisY();
      var x0 = px(YEAR_MIN);
      var x1 = x0 + (px(YEAR_MAX) - x0) * progress;

      ctx.save();
      ctx.strokeStyle = 'rgba(' + LINE + ', 0.34)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();

      /* Year ticks under the axis, with the year in mono beneath the longer ones. */
      ctx.font = '500 9px "Chivo Mono", "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      for (var yr = YEAR_MIN + 1; yr < YEAR_MAX; yr += YEAR_STEP) {
        var x = px(yr);
        if (x > x1) {
          break;
        }
        ctx.strokeStyle = 'rgba(' + LINE + ', 0.26)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, y);
        ctx.lineTo(Math.round(x) + 0.5, y + 6);
        ctx.stroke();

        if (labels()) {
          ctx.fillStyle = 'rgba(' + INK_FAINT + ', ' + (0.9 * progress) + ')';
          ctx.fillText(String(yr), x, y + 11);
        }
      }
      ctx.restore();
    }

    /*
     * One institution: a segment of the bar, a hairline stem down to the axis marking
     * where it begins, and the label above it. The current role gets the accent,
     * exactly as .record-row.is-current does in the chapter below — the chart and the
     * board mark "now" the same way.
     *
     * Every span is on the same line rather than stepped down a stack. The four are
     * strictly sequential — no two overlap in time — so a staircase bought nothing and
     * cost a bracket of long stems in the corner where LNRS and Optum sit two months
     * apart. On one line they abut into a single continuous bar, which is what the
     * record actually is, and the stems read as the transitions between posts.
     */
    function drawSpan(span, progress) {
      if (progress <= 0) {
        return;
      }

      var y = axisY();
      var top = y - SPAN_Y;
      var x0 = px(span.from);
      var x1 = px(span.to === null ? YEAR_MAX - 0.4 : span.to);
      var xEnd = x0 + (x1 - x0) * progress;
      var current = span.to === null;

      ctx.save();
      ctx.lineWidth = 1;

      /* The stem down to the axis, marking where the span begins. */
      ctx.strokeStyle = 'rgba(' + LINE + ', ' + (0.22 * progress) + ')';
      ctx.beginPath();
      ctx.moveTo(Math.round(x0) + 0.5, top);
      ctx.lineTo(Math.round(x0) + 0.5, y);
      ctx.stroke();

      /* The span. */
      ctx.strokeStyle = current
        ? 'rgba(' + ACCENT + ', ' + (0.85 * progress) + ')'
        : 'rgba(' + LINE + ', ' + (0.36 * progress) + ')';
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(top) + 0.5);
      ctx.lineTo(xEnd, Math.round(top) + 0.5);
      ctx.stroke();

      if (labels()) {
        ctx.font = '500 9px "Chivo Mono", "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = current
          ? 'rgba(' + ACCENT + ', ' + (0.95 * progress) + ')'
          : 'rgba(' + INK_FAINT + ', ' + (0.95 * progress) + ')';
        ctx.fillText(span.label.toUpperCase(), x0 + 3, top - 4);
      }

      ctx.restore();
    }

    /*
     * A publication. A disc below the axis with a hairline up to it, scaled from
     * nothing so the six arrive as a sequence rather than appearing at once.
     */
    function drawPaper(year, progress) {
      if (progress <= 0) {
        return;
      }

      var y = axisY();
      var x = px(year);
      var drop = TICK_DROP;
      var r = 2.6 * progress;

      ctx.save();
      ctx.strokeStyle = 'rgba(' + ACCENT + ', ' + (0.4 * progress) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y);
      ctx.lineTo(Math.round(x) + 0.5, y + drop);
      ctx.stroke();

      ctx.fillStyle = 'rgba(' + ACCENT + ', ' + (0.85 * progress) + ')';
      ctx.beginPath();
      ctx.arc(x, y + drop, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function frame(elapsed) {
      ctx.clearRect(0, 0, w, h);

      drawAxis(ease(clamp01(elapsed / AXIS_MS)));

      var i;
      for (i = 0; i < SPANS.length; i += 1) {
        drawSpan(SPANS[i], ease(clamp01(
          (elapsed - SPAN_START - i * SPAN_GAP) / SPAN_MS
        )));
      }

      for (i = 0; i < PAPERS.length; i += 1) {
        drawPaper(PAPERS[i], ease(clamp01(
          (elapsed - TICK_START - i * TICK_GAP) / TICK_MS
        )));
      }
    }

    var TOTAL = Math.max(
      AXIS_MS,
      SPAN_START + SPANS.length * SPAN_GAP + SPAN_MS,
      TICK_START + PAPERS.length * TICK_GAP + TICK_MS
    );

    function tick(now) {
      var elapsed = now - started;
      frame(elapsed);
      if (elapsed < TOTAL) {
        requestAnimationFrame(tick);
      } else {
        running = false;
        /* One last frame at exactly the end state, so a dropped final frame can never
           leave a disc a pixel short of full size. */
        frame(TOTAL);
      }
    }

    function play() {
      if (!size()) {
        return;
      }
      canvas.parentNode.classList.add('is-ready');
      if (reducedMotion) {
        frame(TOTAL);
        return;
      }
      started = performance.now();
      running = true;
      requestAnimationFrame(tick);
    }

    /*
     * Resize repaints the finished state rather than replaying: an animation that
     * restarts every time a phone's address bar collapses is a distraction, and on
     * desktop the frame is often resized long after the sequence has ended.
     */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        if (!size()) {
          return;
        }
        if (!running) {
          frame(TOTAL);
        }
      }, 150);
    });

    play();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
