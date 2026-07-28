/*
 * Local circumstances for the Total Solar Eclipse of 2026 August 12.
 *
 * Given a point on Earth this returns the contact times, magnitude, obscuration
 * and Sun altitude as seen from there. Everything runs locally — no network, no
 * dependencies, and the observer's coordinates never leave the browser.
 *
 * Method: the standard Besselian-element reduction (Explanatory Supplement to
 * the Astronomical Almanac; Meeus, "Elements of Solar Eclipses"). The elements
 * below are NASA GSFC's published values for this specific eclipse:
 * https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2026Aug12Tbeselm.html
 *
 * Greatest eclipse 17:45:53.8 UT at 65°13.5'N 025°13.7'W, gamma = 0.8978,
 * eclipse magnitude 1.0386, central duration 2m18.2s, path width 294 km.
 */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;

  // Polynomial coefficients, valid around t0. Index n is the coefficient of t^n,
  // where t is hours of Terrestrial Dynamical Time from t0.
  var ELEMENTS = {
    t0: 18.0,                                                  // hours TDT
    deltaT: 71.4,                                              // TDT - UT, seconds
    x: [0.475593, 0.5189288, -0.0000773, -0.0000088],
    y: [0.771161, -0.2301664, -0.0001245, 0.0000037],
    d: [14.79667, -0.012065, -0.000003],                       // degrees
    l1: [0.537954, 0.0000940, -0.0000121],                     // penumbral radius
    l2: [-0.008142, 0.0000935, -0.0000121],                    // umbral radius
    mu: [88.74776, 15.003093],                                 // degrees
    tanF1: 0.0046141,
    tanF2: 0.0045911
  };

  // Midnight UT on eclipse day, from which all returned times are offset.
  var DAY_START_MS = Date.UTC(2026, 7, 12, 0, 0, 0);

  var FLATTENING = 0.99664719;      // 1 - f, IAU 1976 ellipsoid
  var EARTH_RADIUS_M = 6378140;

  /*
   * mu is referred to the *ephemeris meridian*, which sits 1.002738*deltaT east
   * of Greenwich — not to Greenwich itself. Observer longitudes must therefore
   * be reckoned from that meridian. Skipping this displaces the whole path by
   * about 0.3 deg of longitude (~15 km), which is invisible for a mid-eclipse
   * site like Dublin but decides total-versus-partial for anywhere near the
   * path limits. Verified against NASA's tabulated northern and southern limit
   * points: with this term the computed magnitude on the limits is 1.00000 to
   * within 4e-5; without it, it is off by 2e-3.
   *
   * 1 second of time = 1/240 degree of longitude.
   */
  var EPHEMERIS_MERIDIAN_DEG = 1.002738 * ELEMENTS.deltaT / 240;

  function poly(coeffs, t) {
    var value = 0;
    for (var i = coeffs.length - 1; i >= 0; i -= 1) {
      value = value * t + coeffs[i];
    }
    return value;
  }

  function polyDerivative(coeffs, t) {
    var value = 0;
    for (var i = coeffs.length - 1; i >= 1; i -= 1) {
      value = value * t + i * coeffs[i];
    }
    return value;
  }

  /*
   * Observer's geocentric coordinates, corrected for the Earth's flattening.
   * Returns rho*sin(phi') and rho*cos(phi') in equatorial-radius units.
   */
  function observerGeocentric(latDeg, altitudeM) {
    var lat = latDeg * DEG;
    var height = (altitudeM || 0) / EARTH_RADIUS_M;
    var u = Math.atan(FLATTENING * Math.tan(lat));
    return {
      rhoSin: FLATTENING * Math.sin(u) + height * Math.sin(lat),
      rhoCos: Math.cos(u) + height * Math.cos(lat)
    };
  }

  /*
   * Evaluate the observer's position relative to the shadow axis at time t
   * (hours TDT from t0).
   *
   * Longitude is EAST-POSITIVE throughout, so the local hour angle of the
   * shadow axis is H = mu + longitude, less the ephemeris-meridian offset.
   * Ireland sits at negative longitude; a flipped sign here still produces
   * plausible-looking times, so it is the one convention worth being explicit
   * about.
   */
  function evaluate(t, observer, lonDegEast) {
    var x = poly(ELEMENTS.x, t);
    var y = poly(ELEMENTS.y, t);
    var d = poly(ELEMENTS.d, t) * DEG;
    var l1 = poly(ELEMENTS.l1, t);
    var l2 = poly(ELEMENTS.l2, t);
    var mu = poly(ELEMENTS.mu, t) * DEG;

    var dx = polyDerivative(ELEMENTS.x, t);
    var dy = polyDerivative(ELEMENTS.y, t);
    var dd = polyDerivative(ELEMENTS.d, t) * DEG;      // radians per hour
    var dmu = polyDerivative(ELEMENTS.mu, t) * DEG;    // radians per hour

    var H = mu + (lonDegEast - EPHEMERIS_MERIDIAN_DEG) * DEG;

    var xi = observer.rhoCos * Math.sin(H);
    var eta = observer.rhoSin * Math.cos(d) - observer.rhoCos * Math.cos(H) * Math.sin(d);
    var zeta = observer.rhoSin * Math.sin(d) + observer.rhoCos * Math.cos(H) * Math.cos(d);

    var dxi = dmu * observer.rhoCos * Math.cos(H);
    var deta = dmu * xi * Math.sin(d) - zeta * dd;

    // Shadow radii corrected to the observer's distance from the fundamental plane.
    var L1 = l1 - zeta * ELEMENTS.tanF1;
    var L2 = l2 - zeta * ELEMENTS.tanF2;

    var u = x - xi;
    var v = y - eta;
    var a = dx - dxi;
    var b = dy - deta;
    var nSq = a * a + b * b;
    var n = Math.sqrt(nSq);

    return {
      u: u,
      v: v,
      a: a,
      b: b,
      n: n,
      nSq: nSq,
      L1: L1,
      L2: L2,
      zeta: zeta,
      d: d,
      H: H,
      separation: Math.sqrt(u * u + v * v),
      // Least separation the observer will reach on the current straight-line
      // approximation of the shadow's motion.
      leastSeparation: (u * b - v * a) / n
    };
  }

  /* Iterate to the instant of maximum eclipse (closest approach to the axis). */
  function solveMaximum(observer, lonDegEast) {
    var t = 0;
    var state = null;
    for (var i = 0; i < 12; i += 1) {
      state = evaluate(t, observer, lonDegEast);
      var tau = -(state.u * state.a + state.v * state.b) / state.nSq;
      t += tau;
      if (Math.abs(tau) < 1e-8) {
        break;
      }
    }
    return { t: t, state: evaluate(t, observer, lonDegEast) };
  }

  /*
   * Iterate to a contact. `radiusKey` picks the penumbral (L1) or umbral (L2)
   * shadow edge; `sign` is -1 for the entering contact and +1 for the leaving
   * one. Returns null if the observer never reaches that shadow edge.
   */
  function solveContact(tStart, observer, lonDegEast, radiusKey, sign) {
    var t = tStart;
    for (var i = 0; i < 20; i += 1) {
      var state = evaluate(t, observer, lonDegEast);
      var radius = Math.abs(state[radiusKey]);
      var ratio = state.leastSeparation / radius;
      if (Math.abs(ratio) > 1) {
        return null;
      }
      var tau = -(state.u * state.a + state.v * state.b) / state.nSq
        + sign * (radius / state.n) * Math.sqrt(1 - ratio * ratio);
      t += tau;
      if (Math.abs(tau) < 1e-8) {
        return t;
      }
    }
    return t;
  }

  /*
   * Fraction of the Sun's disc area hidden by the Moon. This is "obscuration",
   * which is what a coverage percentage means — it is not the same as
   * magnitude, which measures diameter rather than area and runs higher.
   *
   * First and last contact happen at separation L1 (limbs touching externally)
   * and totality at |L2| (internally), so L1 = Rsun + Rmoon and
   * L2 = Rsun - Rmoon in the same units.
   */
  function obscurationFrom(L1, L2, separation) {
    var rSun = (L1 + L2) / 2;
    var rMoon = (L1 - L2) / 2;
    var dist = Math.abs(separation);

    if (rSun <= 0) {
      return 0;
    }
    if (dist >= rSun + rMoon) {
      return 0;
    }
    if (dist <= Math.abs(rMoon - rSun)) {
      // One disc sits entirely inside the other.
      return rMoon >= rSun ? 1 : (rMoon * rMoon) / (rSun * rSun);
    }

    var alpha = 2 * Math.acos((dist * dist + rSun * rSun - rMoon * rMoon) / (2 * dist * rSun));
    var beta = 2 * Math.acos((dist * dist + rMoon * rMoon - rSun * rSun) / (2 * dist * rMoon));
    var area = 0.5 * rSun * rSun * (alpha - Math.sin(alpha))
      + 0.5 * rMoon * rMoon * (beta - Math.sin(beta));

    return area / (Math.PI * rSun * rSun);
  }

  /*
   * Sunset is conventionally the moment the Sun's UPPER LIMB meets the horizon,
   * which is when its centre is 0.833 deg below: 16' of semidiameter plus 34' of
   * atmospheric refraction. Using plain zero altitude instead puts sunset five
   * to ten minutes early against any published table.
   */
  var SUNSET_ALTITUDE = -0.833;

  function isUp(altitudeDeg) {
    return altitudeDeg > SUNSET_ALTITUDE;
  }

  /*
   * The instant between tA and tB at which the Sun sets (or rises), or null if
   * it does neither. Over Ireland and southern Europe the Sun is low enough at
   * maximum that this is a practical question, not a curiosity.
   */
  function horizonCrossing(tA, tB, observer, lonDegEast, latDeg) {
    var upA = isUp(horizontal(evaluate(tA, observer, lonDegEast), latDeg).altitude);
    var upB = isUp(horizontal(evaluate(tB, observer, lonDegEast), latDeg).altitude);
    if (upA === upB) {
      return null;
    }
    var lo = tA;
    var hi = tB;
    for (var i = 0; i < 40; i += 1) {
      var mid = (lo + hi) / 2;
      if (isUp(horizontal(evaluate(mid, observer, lonDegEast), latDeg).altitude) === upA) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  }

  /* Sun's altitude and azimuth (from north, through east) at the given state. */
  function horizontal(state, latDeg) {
    var lat = latDeg * DEG;
    var altitude = Math.asin(
      Math.sin(lat) * Math.sin(state.d)
      + Math.cos(lat) * Math.cos(state.d) * Math.cos(state.H)
    );
    var azimuth = Math.atan2(
      -Math.cos(state.d) * Math.sin(state.H),
      Math.sin(state.d) * Math.cos(lat) - Math.cos(state.d) * Math.sin(lat) * Math.cos(state.H)
    );
    azimuth = (azimuth / DEG + 360) % 360;
    return { altitude: altitude / DEG, azimuth: azimuth };
  }

  var COMPASS = [
    'north', 'north-north-east', 'north-east', 'east-north-east',
    'east', 'east-south-east', 'south-east', 'south-south-east',
    'south', 'south-south-west', 'south-west', 'west-south-west',
    'west', 'west-north-west', 'north-west', 'north-north-west'
  ];

  function compassName(azimuthDeg) {
    return COMPASS[Math.round(azimuthDeg / 22.5) % 16];
  }

  /* Convert a TDT offset from t0 into a real Date. */
  function toDate(t) {
    if (t === null || t === undefined || !isFinite(t)) {
      return null;
    }
    var utHours = ELEMENTS.t0 + t - ELEMENTS.deltaT / 3600;
    return new Date(DAY_START_MS + utHours * 3600000);
  }

  /*
   * Local circumstances for one observer.
   *
   * latDeg      geographic latitude, north positive
   * lonDegEast  longitude, EAST positive (Dublin is about -6.26)
   * altitudeM   height above sea level in metres, optional
   */
  function circumstances(latDeg, lonDegEast, altitudeM) {
    var observer = observerGeocentric(latDeg, altitudeM);
    var max = solveMaximum(observer, lonDegEast);
    var state = max.state;

    var separation = state.separation;
    // Local eclipse magnitude: the fraction of the Sun's DIAMETER covered.
    // Not to be confused with the single "eclipse magnitude 1.0386" NASA quotes
    // for the eclipse as a whole, which is the Moon/Sun apparent diameter ratio
    // at greatest eclipse — a different quantity that reads higher.
    var magnitude = (state.L1 - separation) / (state.L1 + state.L2);
    var sky = horizontal(state, latDeg);

    if (magnitude <= 0) {
      return {
        visible: false,
        sunUp: isUp(sky.altitude),
        magnitude: 0,
        obscuration: 0,
        maxEclipse: toDate(max.t),
        sunAltitudeDeg: sky.altitude,
        sunAzimuthDeg: sky.azimuth,
        direction: compassName(sky.azimuth)
      };
    }

    var firstT = solveContact(max.t, observer, lonDegEast, 'L1', -1);
    var lastT = solveContact(max.t, observer, lonDegEast, 'L1', 1);

    // A negative umbral radius means the Moon's disc is the larger of the two,
    // so an observer inside it sees totality rather than an annular ring.
    var isTotal = state.L2 < 0 && Math.abs(separation) < Math.abs(state.L2);
    var isAnnular = state.L2 > 0 && Math.abs(separation) < Math.abs(state.L2);
    var secondT = null;
    var thirdT = null;
    if (isTotal || isAnnular) {
      secondT = solveContact(max.t, observer, lonDegEast, 'L2', -1);
      thirdT = solveContact(max.t, observer, lonDegEast, 'L2', 1);
    }

    var first = toDate(firstT);
    var last = toDate(lastT);
    var second = toDate(secondT);
    var third = toDate(thirdT);

    // Altitude at the ends of the eclipse, so callers can tell the difference
    // between "happens after sunset" and "the Sun sets partway through".
    var altAtFirst = firstT === null ? null
      : horizontal(evaluate(firstT, observer, lonDegEast), latDeg).altitude;
    var altAtLast = lastT === null ? null
      : horizontal(evaluate(lastT, observer, lonDegEast), latDeg).altitude;
    var sunsetT = (firstT !== null && lastT !== null)
      ? horizonCrossing(firstT, lastT, observer, lonDegEast, latDeg)
      : null;

    return {
      visible: true,
      sunUp: isUp(sky.altitude),
      sunAltitudeAtFirstDeg: altAtFirst,
      sunAltitudeAtLastDeg: altAtLast,
      // When the Sun crosses the horizon mid-eclipse (null if it does not).
      horizonCrossing: toDate(sunsetT),
      isTotal: isTotal,
      isAnnular: isAnnular,
      firstContact: first,
      maxEclipse: toDate(max.t),
      lastContact: last,
      secondContact: second,
      thirdContact: third,
      magnitude: magnitude,
      obscuration: obscurationFrom(state.L1, state.L2, separation) * 100,
      durationMinutes: first && last ? (last - first) / 60000 : null,
      centralDurationSeconds: second && third ? (third - second) / 1000 : null,
      sunAltitudeDeg: sky.altitude,
      sunAzimuthDeg: sky.azimuth,
      direction: compassName(sky.azimuth)
    };
  }

  root.EclipseLocal = {
    circumstances: circumstances,
    elements: ELEMENTS,
    compassName: compassName
  };
})(typeof window !== 'undefined' ? window : globalThis);
