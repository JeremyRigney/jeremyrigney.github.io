FROM python:3.11-slim

WORKDIR /app

# Cloud Run injects PORT; default it so the image also runs locally.
ENV PORT=8080 \
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py f1_live.py f1_strategy.py f1_stream.py magie.py ./

# Serve with gunicorn (production WSGI server) rather than Flask's dev server.
# Shell form so $PORT is expanded at runtime.
#
# One worker, not two. f1_live.py keeps its OpenF1 cache and its outbound rate limiter in
# module-level state, and a second worker is a second process with its own copy of both —
# which doubles the upstream call rate and walks into OpenF1's 60-requests-a-minute limit.
# Threads share that state, so --threads 8 keeps the concurrency the two workers gave.
# For the same reason the service is deployed with --max-instances=1.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 30 app:app
