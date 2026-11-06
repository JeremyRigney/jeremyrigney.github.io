from flask import Flask, jsonify, request, Response
import requests
import xmltodict
import pandas as pd
from flask_cors import CORS
import os
import time
from datetime import datetime

import f1_live
import magie

app = Flask(__name__)
CORS(app)  # applies Access-Control-Allow-Origin to every route below, including /arxiv

# /f1/live — live timing for jeremy.ie/f1. Kept in its own module; it shares nothing with
# the routes below beyond this process and the CORS headers applied above.
app.register_blueprint(f1_live.bp)

# /magie — Ireland's magnetometers for jeremy.ie/aurora, relayed because MagIE sends no
# CORS headers. Its own module, like f1_live.
app.register_blueprint(magie.bp)


@app.route("/")
def get_trains():
    try:
        # Fetch XML from Irish Rail
        url = "http://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML"
        response = requests.get(url)
        data = xmltodict.parse(response.content)

        # Convert to DataFrame and then to JSON
        df = pd.DataFrame.from_dict(data['ArrayOfObjTrainPositions']['objTrainPositions'])
        df['TrainLatitude'] = df['TrainLatitude'].astype(float)
        df['TrainLongitude'] = df['TrainLongitude'].astype(float)
        trains_json = df.to_dict(orient='records')

        return jsonify(trains_json)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/trainroute")
def get_train_route():
    code = request.args.get("code")
    date = request.args.get("date")  # expecting YYYY-MM-DD

    if not code or not date:
        return jsonify({"error": "Missing 'code' or 'date' query parameter"}), 400

    try:
        # Convert to expected Irish Rail format: DD-MM-YYYY
        formatted_date = datetime.strptime(date, "%Y-%m-%d").strftime("%d-%m-%Y")
    except ValueError:
        return jsonify({"error": "Date format must be YYYY-MM-DD"}), 400

    try:
        url = f"http://api.irishrail.ie/realtime/realtime.asmx/getTrainMovementsXML?TrainId={code}&TrainDate={formatted_date}"
        response = requests.get(url)
        data = xmltodict.parse(response.content)

        movements = data.get('ArrayOfObjTrainMovements', {}).get('objTrainMovements', [])

        # Always return a list (even if it's a dict with one element)
        if isinstance(movements, dict):
            movements = [movements]

        return jsonify(movements)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/stations")
def get_stations():
    try:
        url = "http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML"
        response = requests.get(url)
        data = xmltodict.parse(response.content)
        stations = data.get("ArrayOfObjStation", {}).get("objStation", [])
        return jsonify(stations)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# arXiv proxy
#
# The arXiv export API sends no CORS headers and is explicitly "not intended to
# be used inside a web browser by itself", so the dashboard cannot call it
# directly. We proxy it here (server-to-server, so CORS does not apply) and
# cache the result. arXiv asks callers to cache and to query at most once a day
# for the same query, and to leave >=3s between calls; the module-level cache
# below means visitor traffic never triggers a live upstream request.
#
# Paper metadata (titles, authors, abstracts) is released under CC0, so caching
# and re-serving it is permitted. We only pass through metadata and link users
# back to the arXiv abstract pages.
# ---------------------------------------------------------------------------

ARXIV_URL = "https://export.arxiv.org/api/query"
ARXIV_QUERY = (
    "all:star AND all:flare AND all:m dwarf "
    "NOT all:fast radio bursts NOT all:neutron stars NOT all:black hole"
)
ARXIV_TTL = 6 * 3600  # seconds; re-fetch at most every 6 hours (well within "once a day")
_arxiv_cache = {"xml": None, "ts": 0.0}


@app.route("/arxiv")
def get_arxiv():
    now = time.time()

    if _arxiv_cache["xml"] is None or (now - _arxiv_cache["ts"]) > ARXIV_TTL:
        try:
            response = requests.get(
                ARXIV_URL,
                params={
                    "search_query": ARXIV_QUERY,
                    "start": 0,
                    "max_results": 3,
                    "sortBy": "lastUpdatedDate",
                    "sortOrder": "descending",
                },
                headers={"User-Agent": "jeremy.ie-dashboard/1.0 (+https://jeremy.ie/#contact)"},
                timeout=15,
            )
            response.raise_for_status()
            _arxiv_cache["xml"] = response.content
            _arxiv_cache["ts"] = now
        except Exception as e:
            # Serve stale cache if we have it; otherwise report the error.
            if _arxiv_cache["xml"] is None:
                return jsonify({"error": str(e)}), 502

    return Response(
        _arxiv_cache["xml"],
        mimetype="application/atom+xml",
        headers={"Cache-Control": "public, max-age=21600"},  # 6h browser/CDN cache
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))  # Default to 8080 if PORT not set
    app.run(host="0.0.0.0", port=port)
