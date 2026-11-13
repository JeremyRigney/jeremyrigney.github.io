Welcome to the repository for my personal website, jeremy.ie.

Hosted on GitHub Pages. Static HTML, CSS and vanilla JS, with no build step.

PAGES

  index.html      Home
  cv.html         Curriculum vitae
  speaking.html   Public speaking
  dashboard.html  Solar and sky dashboard
  blog.html       Blog index
  the-absurdity-and-possible-reality-of-a-radio-telescope-on-the-moon.html
                  Blog article
  404.html        Not-found page (reuses the homepage shimmer)
  eclipse.html    Ireland 12 August 2026 eclipse (standalone, own theme)
  f1.html         Next F1 circuit (standalone, own theme)
  galaxy.html     Interactive spiral galaxy, WebGL2 (standalone, the hero's palette)
  f1-lab.html     F1 development page, noindex
  aurora.html     Live aurora on a globe, and the solar wind behind it, WebGL2
                  (standalone, own theme; noindex until it is signed off)

DESIGN SYSTEM ("coal")

  assets/css/coal.css           tokens, header, footer, type, row grids (start here)
  assets/css/home-coal.css      homepage opening frame and shimmer
  assets/css/{cv,speaking,dashboard-coal,blog,notfound}.css   per-page additions
  assets/css/noscript-coal.css  no-JavaScript fallback for every coal page
  assets/js/site-nav.js         shared mobile nav, scroll reveals, footer year
  assets/js/home-intro.js       homepage loading sequence: stars light up over the hero galaxy
                                while a line of status text fades in and out. The words are the
                                PHRASES list at the top of the file. The switches (ONCE,
                                SKIP_ON_INTERNAL_REFERRER) are in the script in the head of
                                index.html. ?intro=0 skips it and ?intro=1 forces it. Reduced
                                motion never plays it.

  Dark only. Chivo Mono for UI, Fraunces for chapter titles, Inter for prose. One sage
  accent. No cards, no rounded corners, no shadows. The token values are listed at the
  top of coal.css.

  eclipse, f1 and galaxy keep their own stylesheets on purpose. galaxy is three
  scripts: galaxy-model.js (the physics, shared constants with home-galaxy.js),
  galaxy-bands.js (what each viewing wavelength shows, and overlays such as H-alpha)
  and galaxy-view.js (WebGL2).

AURORA

  aurora.html is twelve scripts under assets/js/, each headed by what it does:
  aurora-geo.js (geometry), aurora-globe.js (the WebGL2 stage and its camera),
  aurora-data.js (NOAA's live feeds), aurora-model.js (the time slider's aurora),
  aurora-wind.js and aurora-wind-view.js (the solar wind, from the Sun to the
  Earth), aurora-sun.js and aurora-sun-view.js (the Sun as GOES-19 sees it, over
  the last day), aurora-hud.js, aurora-charts.js and aurora-timeline.js (the
  page's panels).

  Most of its data is fetched live by the browser, the Sun's pictures included:
  NOAA's own SUVI frames, a selection of the day's, only once the camera heads for
  the Sun. The one exception is NOAA's
  WSA-Enlil solar wind model, 130 MB a run: .github/workflows/aurora-wind.yml runs
  tools/build-aurora-wind.py every two hours, and when there is a new run publishes
  two small files to the aurora-data branch (one commit, replaced each time), which
  the page reads from raw.githubusercontent.com. Nothing is committed to main.
  .github is in .gitignore, so that workflow file was added with git add -f.

  The other tools/build-aurora-*.py scripts are run by hand and write committed
  files under assets/data/aurora/.

  Tests for the wind's and the Sun's numbers: node tests/aurora/run.js (or jsc, as
  for pitwall).

LEGACY

  generic.html, elements.html, design.html and assets/css/{main,noscript,home,refresh}.css
  are unlinked leftovers from the original "Stellar" template by HTML5 UP
  (html5up.net, CCA 3.0) and earlier redesigns.
