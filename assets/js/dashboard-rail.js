/*
 * jeremy.ie/dashboard — Irish Rail live positions.
 *
 * Moved out of dashboard.html unchanged in behaviour: the same Flask API on Cloud Run,
 * the same 60-second poll, the same DART-by-train-code rule and the same out-of-bounds
 * filter. What changed is where it draws — the route line and the stop discs are now
 * the coal accent rather than the old gold, and the stop list is emitted as rows on the
 * margin spine instead of a bare <ul>.
 *
 * The map is left on Leaflet and the two PNG train icons are left as they are; both
 * are widget questions rather than design ones.
 */
(function () {
  'use strict';

  var API = 'https://irishrail-api-737590149980.europe-west1.run.app';
  var REFRESH_MS = 60000;

  /* --accent-soft and --accent from coal.css, which canvas and Leaflet cannot read. */
  var STOP_COLOUR = '#7e9c89';
  var ROUTE_COLOUR = '#6e8a78';

  /*
   * The island, generously. The feed occasionally reports a train at (0, 0) or in the
   * Atlantic, and one bad fix drags the whole map's bounds with it.
   */
  var BOUNDS = { latMin: 51.3, latMax: 55.5, lonMin: -10.7, lonMax: -5.3 };

  /* A service scheduled more than this far out has not left yet. */
  var LOOKAHEAD_MIN = 10;

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function main() {
    var host = document.getElementById('trainmap');
    if (!host || typeof L === 'undefined') {
      return;
    }

    var dartIcon = L.icon({
      iconUrl: 'images/dart.png',
      iconSize: [18, 18],
      iconAnchor: [16, 16],
      popupAnchor: [0, -32]
    });
    var icIcon = L.icon({
      iconUrl: 'images/ictrain.png',
      iconSize: [18, 18],
      iconAnchor: [16, 16],
      popupAnchor: [0, -32]
    });

    /*
     * A dark base layer to match the page. CARTO needs a key; without one the map
     * falls back to satellite rather than to watermarked tiles — see carto-basemap.js.
     */
    var cartoDarkUrl = window.cartoTiles
      && window.cartoTiles('dark_all', { subdomain: '{s}', retina: '{r}' });
    var dark = cartoDarkUrl ? L.tileLayer(cartoDarkUrl, {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '© OpenStreetMap contributors © CARTO'
    }) : null;
    var satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles © Esri & contributors' }
    );

    var map = L.map('trainmap', {
      center: [53.4495, -7.5030],
      zoom: 7,
      layers: [dark || satellite]
    });
    L.control.layers(
      dark ? { Dark: dark, Satellite: satellite } : { Satellite: satellite }
    ).addTo(map);

    var stationLookup = {};
    var routeLayers = [];
    var trainMarkers = [];

    /* ---------- Stations ---------- */

    function loadStations() {
      fetch(API + '/stations')
        .then(function (res) { return res.json(); })
        .then(function (stations) {
          stations.forEach(function (station) {
            stationLookup[station.StationDesc] = {
              lat: parseFloat(station.StationLatitude),
              lon: parseFloat(station.StationLongitude)
            };
          });
        })
        .catch(function (err) {
          console.error('Error loading stations:', err);
        });
    }

    /* ---------- The route panel ---------- */

    function clearRoute() {
      routeLayers.forEach(function (layer) { map.removeLayer(layer); });
      routeLayers = [];
    }

    function setPanel(html) {
      var panel = document.getElementById('station-list');
      if (panel) {
        panel.innerHTML = html;
      }
    }

    /*
     * One stop per row on the spine: scheduled time in the margin column, station
     * beside it. Stops whose arrival and departure are identical are the ones the
     * service runs through without calling, and are left out.
     */
    function renderRoute(route) {
      var rows = '';

      route.forEach(function (stop) {
        var arr = stop.ScheduledArrival || '';
        var dep = stop.ScheduledDeparture || '';
        if (arr === dep) {
          return;
        }
        arr = arr === '00:00:00' ? '' : arr;
        dep = dep === '00:00:00' ? '' : dep;

        var when = '';
        if (arr && dep) {
          when = arr + ' → ' + dep;
        } else if (arr) {
          when = 'Arr ' + arr;
        } else if (dep) {
          when = 'Dep ' + dep;
        }

        rows += '<li class="stop-row">'
          + '<span class="stop-when">' + escapeHtml(when) + '</span>'
          + '<span class="stop-name">' + escapeHtml(stop.LocationFullName) + '</span>'
          + '</li>';
      });

      setPanel(rows
        ? '<ul class="stop-list">' + rows + '</ul>'
        : '<span class="route-empty">No calling points listed for this service.</span>');
    }

    function drawRoute(route) {
      clearRoute();

      var latlngs = [];
      route.forEach(function (stop) {
        var coords = stationLookup[stop.LocationFullName];
        if (!coords) {
          return;
        }
        var disc = L.circleMarker([coords.lat, coords.lon], {
          radius: 5,
          color: STOP_COLOUR,
          weight: 2,
          fillColor: STOP_COLOUR,
          fillOpacity: 0.85
        }).addTo(map);
        disc.bindPopup(
          '<strong>' + escapeHtml(stop.LocationFullName) + '</strong>'
          + 'Scheduled ' + escapeHtml(stop.ScheduledArrival || '—')
          + ' → ' + escapeHtml(stop.ScheduledDeparture || '—')
        );
        routeLayers.push(disc);
        latlngs.push([coords.lat, coords.lon]);
      });

      routeLayers.push(
        L.polyline(latlngs, { color: ROUTE_COLOUR, weight: 2, opacity: 0.75 }).addTo(map)
      );
    }

    /* ---------- Trains ---------- */

    /*
     * The feed carries every service on the roster, including ones that have not left
     * yet — their PublicMessage leads with a scheduled time. Anything more than ten
     * minutes out is not on the network, whatever coordinates it claims.
     */
    function hasNotDeparted(message) {
      var match = message.match(/(\d{2}):(\d{2})/);
      if (!match) {
        return false;
      }
      var now = new Date();
      var scheduled = new Date(now);
      scheduled.setHours(parseInt(match[1], 10), parseInt(match[2], 10), 0, 0);
      return (scheduled - now) / 60000 > LOOKAHEAD_MIN;
    }

    function onTrainClick(marker, code, popup) {
      var today = new Date().toISOString().split('T')[0];
      fetch(API + '/trainroute?code=' + encodeURIComponent(code) + '&date=' + today)
        .then(function (res) { return res.json(); })
        .then(function (route) {
          if (!Array.isArray(route) || !route.length) {
            marker.bindPopup(popup + '<br><br><em>No route data available.</em>').openPopup();
            return;
          }
          drawRoute(route);
          renderRoute(route);
        })
        .catch(function (err) {
          marker.bindPopup(popup + '<br><br><em>Unable to load route.</em>').openPopup();
          console.error('Error fetching route:', err);
        });
    }

    function loadTrains() {
      fetch(API + '/')
        .then(function (res) { return res.json(); })
        .then(function (trains) {
          trainMarkers.forEach(function (marker) { marker.remove(); });
          trainMarkers = [];

          trains.forEach(function (train) {
            var lat = parseFloat(train.TrainLatitude);
            var lon = parseFloat(train.TrainLongitude);
            var code = train.TrainCode || '';
            var message = train.PublicMessage || '';

            if (isNaN(lat) || isNaN(lon)) {
              return;
            }
            if (lat < BOUNDS.latMin || lat > BOUNDS.latMax
              || lon < BOUNDS.lonMin || lon > BOUNDS.lonMax) {
              return;
            }
            if (hasNotDeparted(message)) {
              return;
            }

            var isDART = code.charAt(0) === 'E';
            var popup = '<strong>' + (isDART ? 'DART service ' : 'Train ')
              + escapeHtml(code) + '</strong>'
              + message.replace(/\\n/g, '<br>');

            var marker = L.marker([lat, lon], { icon: isDART ? dartIcon : icIcon })
              .addTo(map)
              .bindPopup(popup);

            marker.on('click', function () {
              onTrainClick(marker, code, popup);
            });

            trainMarkers.push(marker);
          });

          if (window.dashboardReadout) {
            window.dashboardReadout('trains', trainMarkers.length);
          }
        })
        .catch(function (err) {
          console.error('Error fetching train data:', err);
        });
    }

    /* ---------- Legend ---------- */

    var legend = L.control({ position: 'topleft' });
    legend.onAdd = function () {
      var div = L.DomUtil.create('div', 'info_legend');
      div.innerHTML = '<h4>Legend</h4>'
        + '<div class="info_legend-row"><img src="images/ictrain.png" width="18" alt=""> IC / Regional</div>'
        + '<div class="info_legend-row"><img src="images/dart.png" width="18" alt=""> DART</div>';
      return div;
    };
    legend.addTo(map);

    loadStations();
    loadTrains();
    window.setInterval(loadTrains, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
}());
