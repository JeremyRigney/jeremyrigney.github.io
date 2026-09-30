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

DESIGN SYSTEM ("coal")

  assets/css/coal.css           tokens, header, footer, type, row grids (start here)
  assets/css/home-coal.css      homepage opening frame and shimmer
  assets/css/{cv,speaking,dashboard-coal,blog,notfound}.css   per-page additions
  assets/css/noscript-coal.css  no-JavaScript fallback for every coal page
  assets/js/site-nav.js         shared mobile nav, scroll reveals, footer year
  assets/js/home-intro.js       homepage loading sequence: stars light up over the hero galaxy
                                while numbers worked out from the visitor's clock count up.
                                The numbers are the DECK list at the top of the file. The
                                switches (ONCE, SKIP_ON_INTERNAL_REFERRER) are in the script
                                in the head of index.html. ?intro=0 skips it and ?intro=1
                                forces it. Reduced motion never plays it.

  Dark only. Chivo Mono for UI, Fraunces for chapter titles, Inter for prose. One sage
  accent. No cards, no rounded corners, no shadows. The token values are listed at the
  top of coal.css.

  eclipse, f1 and galaxy keep their own stylesheets on purpose. galaxy is three
  scripts: galaxy-model.js (the physics, shared constants with home-galaxy.js),
  galaxy-bands.js (what each viewing wavelength shows) and galaxy-view.js (WebGL2).

LEGACY

  generic.html, elements.html, design.html and assets/css/{main,noscript,home,refresh}.css
  are unlinked leftovers from the original "Stellar" template by HTML5 UP
  (html5up.net, CCA 3.0) and earlier redesigns.
