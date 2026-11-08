#!/usr/bin/env python3
"""
Writes assets/data/f1/backdrops.json: for each circuit, a photograph of the place to sit
behind the Pitwall standby poster before its race. A port of Pocket Pitwall's
tools/build-backdrops.py, with the same pictures, sized and framed for a landscape screen.

Each picture is found by OpenF1's circuit_key or, for a circuit OpenF1 hadn't numbered
when the pictures were chosen, by the names its sessions are likely to carry.

The pictures are chosen by hand, below, from Wikimedia Commons, freely licensed only (CC0
or CC BY / BY-SA). This script only looks up what the page needs to show and credit each
one: a thumbnail URL 1920 wide, the photographer, the licence and the file's page. The
page loads the next race's picture straight from Wikimedia, so nothing large is committed.

    python3 tools/build-f1-backdrops.py

Stdlib only. HTTP goes through curl, as in build-f1-data.py: the python.org build on
macOS has no CA bundle, so urllib can't verify Wikimedia's certificate.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia asks every client to say who it is and how to reach its maker.
UA = "PitwallWeb/0.1 (personal F1 timing page; https://jeremy.ie)"
# Wide enough for a laptop or a monitor; Wikimedia keeps thumbnails at standard widths.
WIDTH = 1920

# circuit_key: (where it is, the Commons file[, focus x[, focus y]]). A screen shows a slice
# of a picture of another shape; focus is where (0 left or top, 1 right or bottom) the slice
# centres, for a landmark that isn't in the middle. Without it, the middle. The x values are
# the app's, chosen for a phone's tall slice; the y values are for a wide screen's.
PICKS = {
    9: ("Austin, Texas", "File:Austin Texas skyline, December 2023 - Evening.jpg"),
    65: ("Mexico City", "File:Evening Palacio de Bellas Artes view from southwest.jpg"),
    14: ("São Paulo", "File:Ponte estaiada Octavio Frias - Sao Paulo.jpg"),
    152: ("Las Vegas", "File:Las Vegas (Nevada, USA), The Strip -- 2012 -- 6232.jpg"),
    150: ("Doha, Qatar", "File:Doha Dhow Harbour Skyline View at Night 07.jpg", 0.27),
    70: ("Abu Dhabi", "File:Abu Dhabi Skyline fron Corniche Rd.JPG", 0.12),
    63: ("Manama, Bahrain", "File:Bahrain World trade Center .jpg", 0.24),
    10: ("Melbourne", "File:Melbourne (AU), Melbourne City Centre -- 2019 -- 1504-8.jpg"),
    49: ("Shanghai", "File:A night at the Bund - Shanghai.jpg"),
    46: ("Mount Fuji, Japan", "File:Mount Fuji at sunset, March 2025.jpg"),
    151: ("Miami", "File:Night Panorama Miami Florida 5462.jpg"),
    23: ("Montreal", "File:Montreal night view.jpg"),
    22: ("Monaco", "File:Hafen und Felsen von Monaco-La Turbie.jpg"),
    15: ("Barcelona", "File:Antoni Gaudi's Sagrada Familia, Barcelona (Ank Kumar) 11.jpg", 0.5, 0.3),
    19: ("Styria, Austria", "File:Turnau Hochanger - Hochschwab 20171014 01.jpg"),
    2: ("Castle Combe, the Cotswolds", "File:Castle combe cotswolds.jpg"),
    7: ("The Ardennes, near Spa", "File:Ardenne (Lorcé, Stoumont).jpg"),
    4: ("Budapest", "File:Hungarian Parliament Building 2023-9.jpg"),
    55: ("Kinderdijk, the Netherlands", "File:Kinderdijk windmills 12.jpg"),
    39: ("Milan", "File:20110724 Milan Cathedral 5260.jpg"),
    153: ("Madrid", "File:Gran Via Madrid November 2024 01.jpg", 0.5, 0.3),
    144: ("Baku", "File:Baku 1.JPG"),
    12: ("Kuala Lumpur", "File:2016 Kuala Lumpur, Petronas Towers (18).jpg", 0.5, 0.35),
    61: ("Singapore", "File:Marina Bay Singapore-3499.jpg"),
    # New for 2027.
    149: ("Jeddah, Saudi Arabia", "File:King Fahd Fountain.jpg"),
}

# Circuits back on the calendar from before OpenF1's records begin (2023), so with no
# circuit_key when these were chosen: matched on the circuit, place or country name the
# sessions carry. OpenF1 now lists Portimão as 147 and Istanbul Park as 59; the names
# still find them, and find them under any key.
NAMED = {
    "portimao": ("Portimão, the Algarve", "File:Ponta da Piedade (48462178692).jpg",
                 ["Portimão", "Portimao", "Algarve", "Portugal"]),
    "istanbul": ("Istanbul", "File:Bosphorus Bridge at night.jpg",
                 ["Istanbul", "Istanbul Park", "Turkey", "Türkiye", "Turkiye"]),
}

FREE = re.compile(r"^(cc0|public domain|cc by(-sa)? [0-9.]+( [a-z]+)?)$", re.I)


def fetch(params, retries=3):
    """GET JSON from the Commons API via curl."""
    cmd = ["curl", "-s", "-S", "-m", "60", "-A", UA, "-G", API]
    for key, value in params.items():
        cmd += ["--data-urlencode", "%s=%s" % (key, value)]
    for attempt in range(retries):
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0 and proc.stdout.strip():
            try:
                return json.loads(proc.stdout)
            except json.JSONDecodeError:
                pass  # rate-limit pages arrive as HTML
        if attempt < retries - 1:
            time.sleep(3 * (attempt + 1))
    sys.exit("failed to fetch %s\n%s" % (params.get("titles"), proc.stdout[:400] or proc.stderr[:400]))


def text(html):
    """Commons gives the artist as HTML; the credit wants it plain and short."""
    plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html or "")).strip()
    return plain if len(plain) <= 60 else plain[:57].rstrip() + "…"


def info(title):
    data = fetch({
        "action": "query", "format": "json", "titles": title, "prop": "imageinfo",
        "iiprop": "url|size|extmetadata", "iiurlwidth": WIDTH,
    })
    page = next(iter(data["query"]["pages"].values()))
    if "imageinfo" not in page:
        sys.exit(f"{title}: not on Commons")
    return page["imageinfo"][0]


def main():
    out = {}
    entries = []
    for key, pick in PICKS.items():
        place, title, *focus = pick
        entries.append((str(key), place, title, None, focus))
    for key, (place, title, names) in NAMED.items():
        entries.append((key, place, title, names, []))
    for key, place, title, names, focus in entries:
        ii = info(title)
        meta = ii.get("extmetadata", {})
        licence = text(meta.get("LicenseShortName", {}).get("value"))
        if not FREE.match(licence):
            sys.exit(f"{title}: licence {licence!r} isn't one the page may use")
        entry = {
            "place": place,
            # Wikimedia's tracking parameters aren't needed to load the picture.
            "url": ii["thumburl"].split("?")[0],
            "width": ii["thumbwidth"],
            "height": ii["thumbheight"],
            "credit": text(meta.get("Artist", {}).get("value")) or "Unknown",
            "licence": licence,
            "page": ii["descriptionurl"],
        }
        if names:
            entry["match"] = names
        if len(focus) > 0:
            entry["focus"] = focus[0]
        if len(focus) > 1:
            entry["focusY"] = focus[1]
        out[key] = entry
        print(f"{key:>8} {place:30} {ii['thumbwidth']:>4}×{ii['thumbheight']:<4} {licence:12} {entry['credit']}")
    target = Path(__file__).resolve().parent.parent / "assets/data/f1/backdrops.json"
    target.write_text(json.dumps({"source": "Wikimedia Commons", "backdrops": out}, ensure_ascii=False, indent=1) + "\n")
    print("wrote", target)


if __name__ == "__main__":
    main()
