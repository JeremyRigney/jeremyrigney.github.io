/*
 * jeremy.ie/dashboard — the feeds.
 *
 * Everything on the board except the Leaflet map, which is large enough to have its
 * own file: the GOES chart, the Dublin ephemeris, the lunar phase, the arXiv rows and
 * the loader for the weather embed.
 *
 * These were five inline <script> blocks in dashboard.html. They are out here for the
 * same reason the other two pages have no inline script at all — so the markup can be
 * read, and so each widget can be worked on without editing the page around it.
 *
 * The GOES payload is not fetched here. dashboard-xray.js puts it on window.goesData
 * as a promise for the trace behind the opening frame; the chart below plots the same
 * three days from the same response rather than asking SWPC for them twice.
 *
 * jQuery is still on the page for the two ephemeris calls. Everything written since
 * uses fetch.
 */
(function () {
  'use strict';

  /* ---------- Weather ---------- */

  /*
   * weatherwidget.io's own loader, verbatim — it looks for its anchor by class and
   * replaces it. Its colours are passed as data- attributes in the markup, since the
   * iframe interior cannot be reached from a stylesheet.
   */
  function loadWeather() {
    var id = 'weatherwidget-io-js';
    if (document.getElementById(id)) {
      return;
    }
    var first = document.getElementsByTagName('script')[0];
    var js = document.createElement('script');
    js.id = id;
    js.src = 'https://weatherwidget.io/js/widget.min.js';
    first.parentNode.insertBefore(js, first);
  }

  /* ---------- Lunar phase ---------- */

  /*
   * icalendar37's API returns a month of phases and an SVG per day. Its snippet
   * addresses the container's children by index, which is why the markup has four
   * divs in a fixed order — that shape is their contract, not a choice.
   *
   * The two colours are passed as query parameters: chalk for the lit limb and the
   * coal ground for the shadow, so the disc sits on the page rather than on the dark
   * green plate the previous version gave it.
   */
  function loadMoon() {
    var host = document.getElementById('contain_moon');
    if (!host) {
      return;
    }

    var slots = host.querySelectorAll('div');
    if (slots.length < 4) {
      return;
    }

    var now = new Date();
    var day = now.getDate();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1) / 1000;

    var url = 'https://www.icalendar37.net/lunar/api/?lang=en'
      + '&month=' + (now.getMonth() + 1)
      + '&year=' + now.getFullYear()
      + '&size=100'
      + '&lightColor=rgb(246,247,248)'
      + '&shadeColor=rgb(17,18,20)'
      + '&t&LDZ=' + monthStart;

    var request = new XMLHttpRequest();
    request.onreadystatechange = function () {
      if (request.readyState !== 4 || request.status !== 200) {
        return;
      }
      try {
        var body = JSON.parse(request.responseText);
        var phase = body.phase[day];
        slots[1].innerHTML = phase.svg;
        slots[2].innerHTML = phase.npWidget;
        // nextFullMoon arrives as markup — it carries a small inline SVG of a full
        // disc before the date — so this is one of the few places innerHTML is right.
        slots[3].innerHTML = 'Next full moon · ' + body.nextFullMoon;
      } catch (err) {
        console.error('Lunar phase parse error:', err);
      }
    };
    request.open('GET', url, true);
    request.send();
  }

  /* ---------- GOES 3-day X-ray flux ---------- */

  /*
   * CanvasJS, themed to the coal tokens through its own config — its chrome cannot be
   * reached from a stylesheet. The chart has no title of its own: the panel head above
   * it already names it, and a library title would say the same thing twice in a
   * different typeface.
   */
  var CHART_INK = '#eceef0';
  var CHART_FAINT = '#6b7178';
  var CHART_LINE = 'rgba(236, 238, 240, 0.14)';
  var CHART_GRID = 'rgba(236, 238, 240, 0.06)';
  var CHART_SHORT = '#9aa0a6';
  var CHART_LONG = '#7e9c89';

  function seriesFor(rows, energy) {
    var points = [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].energy !== energy) {
        continue;
      }
      var flux = parseFloat(rows[i].observed_flux);
      var t = Date.parse(rows[i].time_tag);
      if (isFinite(flux) && isFinite(t)) {
        points.push({ x: new Date(t), y: flux });
      }
    }
    return points;
  }

  function chartFailed(message) {
    var host = document.getElementById('chartContainer');
    if (host) {
      host.innerHTML = '<p class="route-empty">' + message + '</p>';
    }
  }

  function loadChart() {
    if (!document.getElementById('chartContainer') || !window.goesData) {
      return;
    }

    if (typeof CanvasJS === 'undefined') {
      chartFailed('Chart library unavailable.');
      return;
    }

    window.goesData
      .then(function (rows) {
        var chart = new CanvasJS.Chart('chartContainer', {
          zoomEnabled: true,
          zoomType: 'xy',
          exportEnabled: true,
          backgroundColor: 'transparent',
          axisX: {
            valueFormatString: 'HH:MM DD/MM',
            title: 'Time and date · UTC',
            titleFontColor: CHART_FAINT,
            titleFontFamily: 'Chivo Mono, monospace',
            titleFontSize: 10,
            labelFontColor: CHART_FAINT,
            labelFontFamily: 'Chivo Mono, monospace',
            labelFontSize: 10,
            lineColor: CHART_LINE,
            tickColor: CHART_LINE,
            gridColor: CHART_GRID
          },
          axisY: {
            logarithmic: true,
            title: 'Flare class',
            titleFontColor: CHART_FAINT,
            titleFontFamily: 'Chivo Mono, monospace',
            titleFontSize: 10,
            labelFontColor: CHART_LONG,
            labelFontFamily: 'Chivo Mono, monospace',
            labelFontSize: 11,
            lineColor: CHART_LINE,
            tickColor: CHART_LINE,
            gridColor: CHART_GRID,
            maximum: 0.0005,
            minimum: 0.00000001,
            labelFormatter: function (e) {
              switch (e.value) {
              case 0.00000001: return 'A';
              case 0.0000001: return 'B';
              case 0.000001: return 'C';
              case 0.00001: return 'M';
              case 0.0001: return 'X';
              default: return '';
              }
            }
          },
          toolTip: { shared: true },
          legend: {
            cursor: 'pointer',
            fontColor: CHART_INK,
            fontFamily: 'Chivo Mono, monospace',
            fontSize: 11,
            verticalAlign: 'top',
            horizontalAlign: 'center',
            dockInsidePlotArea: true,
            itemclick: toggleSeries
          },
          data: [{
            type: 'line',
            name: 'GOES 0.05–0.4 nm',
            color: CHART_SHORT,
            showInLegend: true,
            markerSize: 1,
            lineThickness: 1.4,
            yValueFormatString: '#.##########',
            dataPoints: seriesFor(rows, '0.05-0.4nm')
          }, {
            type: 'line',
            name: 'GOES 0.1–0.8 nm',
            color: CHART_LONG,
            showInLegend: true,
            markerSize: 1,
            lineThickness: 1.4,
            yValueFormatString: '#.##########',
            dataPoints: seriesFor(rows, '0.1-0.8nm')
          }]
        });

        function toggleSeries(e) {
          e.dataSeries.visible = !(typeof e.dataSeries.visible === 'undefined'
            || e.dataSeries.visible);
          chart.render();
        }

        chart.render();
      })
      .catch(function (err) {
        console.error('GOES feed error:', err);
        chartFailed('The GOES feed could not be reached.');
      });
  }

  /* ---------- Dublin ephemeris ---------- */

  var DUBLIN_LAT = 53.3871;
  var DUBLIN_LNG = -6.3375;

  function setEphem(key, value) {
    var node = document.querySelector('[data-ephem="' + key + '"]');
    if (node && value) {
      node.textContent = value;
    }
  }

  /* "14:22:19" is three figures where two will do, and the seconds change nothing. */
  function readableLength(text) {
    var parts = String(text).split(':');
    if (parts.length < 2) {
      return text;
    }
    return parseInt(parts[0], 10) + 'h ' + parts[1] + 'm';
  }

  /*
   * sunrise-sunset.org returns solar noon as "12:25:39 PM" while Visual Crossing
   * returns sunrise as "06:32:37". Two clocks in one column is the sort of thing a
   * table makes impossible to miss, so the twelve-hour one is converted.
   */
  function to24Hour(text) {
    var match = String(text).match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) {
      return text;
    }
    var hour = parseInt(match[1], 10) % 12;
    if (match[4].toUpperCase() === 'PM') {
      hour += 12;
    }
    return String(hour).padStart(2, '0') + ':' + match[2] + ':' + match[3];
  }

  /*
   * Visual Crossing gives the lunar phase as a fraction of the cycle. On its own that
   * is a number nobody can read; the eighth it falls in is the thing a person actually
   * wants, with the figure kept beside it for anyone who does want it.
   */
  var PHASES = [
    'New', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
    'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'
  ];

  function readablePhase(fraction) {
    var value = parseFloat(fraction);
    if (!isFinite(value)) {
      return null;
    }
    // Each named phase is centred on its eighth, so the offset is half of one.
    var index = Math.floor(((value % 1) + 1 / 16) * 8) % 8;
    return PHASES[index] + ' · ' + value.toFixed(2);
  }

  function loadEphemeris() {
    if (!document.querySelector('[data-ephem]') || typeof window.jQuery === 'undefined') {
      return;
    }
    var $ = window.jQuery;

    $.getJSON(
      'https://api.sunrise-sunset.org/json?lat=' + DUBLIN_LAT
        + '&lng=' + DUBLIN_LNG + '&date=today',
      function (data) {
        setEphem('noon', to24Hour(data.results.solar_noon));
        setEphem('daylength', readableLength(data.results.day_length));

        if (window.dashboardReadout) {
          window.dashboardReadout(
            'daylength',
            readableLength(data.results.day_length)
          );
        }

        var today = new Date();
        setEphem('date', [
          String(today.getDate()).padStart(2, '0'),
          String(today.getMonth() + 1).padStart(2, '0'),
          today.getFullYear()
        ].join('/'));
      }
    );

    /*
     * TODO: this key is readable by anyone who opens the page. It should be proxied
     * through the Flask app the way /arxiv already is, and then rotated.
     */
    $.getJSON(
      'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/'
        + 'timeline/Dublin?unitGroup=metric&include=current'
        + '&key=WUTWMSAENKK9ZK69JSY48FJSQ&contentType=json',
      function (data) {
        setEphem('sunrise', data.currentConditions.sunrise);
        setEphem('sunset', data.currentConditions.sunset);
        setEphem('moonphase', readablePhase(data.currentConditions.moonphase));
      }
    );
  }

  /* ---------- arXiv ---------- */

  /*
   * Proxied through my Flask API for CORS and caching — see app.py /arxiv. Direct
   * browser calls to export.arxiv.org are blocked (no CORS header) and discouraged by
   * arXiv's own API terms.
   */
  var ARXIV_FEED = 'https://irishrail-api-737590149980.europe-west1.run.app/arxiv';
  var ABSTRACT_CHARS = 270;

  function firstAuthor(entry) {
    var author = entry.getElementsByTagName('author')[0];
    if (!author) {
      return '';
    }
    var name = author.getElementsByTagName('name')[0];
    return name ? name.textContent.trim() : '';
  }

  /* Cut on a word boundary, so an abstract never breaks mid-word before its ellipsis. */
  function trimAbstract(text) {
    var cut = text.trim().substr(0, ABSTRACT_CHARS);
    return cut.substr(0, Math.min(cut.length, cut.lastIndexOf(' '))) + '…';
  }

  function paperSlots() {
    return Array.prototype.slice.call(document.querySelectorAll('.paper'));
  }

  function fillPaper(slot, fields) {
    var title = slot.querySelector('.paper-title');
    var authors = slot.querySelector('.paper-authors');
    var abstract = slot.querySelector('.paper-abstract');
    var link = slot.querySelector('.paper-link');

    if (title) {
      title.textContent = fields.title;
    }
    if (authors) {
      authors.textContent = fields.authors;
    }
    if (abstract) {
      abstract.textContent = fields.abstract;
    }
    if (link) {
      link.textContent = fields.linkText;
      link.setAttribute('href', fields.href);
    }
    slot.classList.add('is-loaded');
  }

  function papersFailed(slots) {
    slots.forEach(function (slot) {
      fillPaper(slot, {
        title: 'Feed unavailable',
        authors: '',
        abstract: 'The arXiv feed could not be loaded right now — please check back later.',
        linkText: 'Visit arXiv →',
        href: 'https://arxiv.org'
      });
    });
  }

  function loadPapers() {
    var slots = paperSlots();
    if (!slots.length) {
      return;
    }

    fetch(ARXIV_FEED)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('arXiv ' + response.status);
        }
        return response.text();
      })
      .then(function (xml) {
        var doc = new DOMParser().parseFromString(xml, 'application/xml');
        var entries = doc.getElementsByTagName('entry');
        if (!entries.length) {
          throw new Error('arXiv returned no entries');
        }

        var shown = 0;
        slots.forEach(function (slot, i) {
          var entry = entries[i];
          if (!entry) {
            slot.hidden = true;
            return;
          }

          var title = entry.getElementsByTagName('title')[0];
          var summary = entry.getElementsByTagName('summary')[0];
          var id = entry.getElementsByTagName('id')[0];
          var author = firstAuthor(entry);

          fillPaper(slot, {
            title: title ? title.textContent.trim().replace(/\s+/g, ' ') : '',
            authors: author ? author + ' et al.' : '',
            abstract: summary ? trimAbstract(summary.textContent) : '',
            linkText: 'Read on arXiv →',
            href: id ? id.textContent.trim() : 'https://arxiv.org'
          });
          shown += 1;
        });

        if (window.dashboardReadout) {
          window.dashboardReadout('papers', shown);
        }
      })
      .catch(function (err) {
        console.error('arXiv feed error:', err);
        papersFailed(slots);
      });
  }

  /* ---------- Boot ---------- */

  function boot() {
    loadWeather();
    loadMoon();
    loadChart();
    loadEphemeris();
    loadPapers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
