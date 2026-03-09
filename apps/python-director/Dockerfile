# ── Python Director Dockerfile ────────────────────────────────────────────────
FROM nvidia/cuda:12.2.0-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install Python 3.11, pip, ffmpeg (for audio processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3.11-dev python3-pip \
    ffmpeg curl \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && python3 -m pip install --upgrade pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (Docker layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

EXPOSE 8000

ENV RUST_ENGINE_URL=http://rust-engine:8080
ENV REDIS_URL=redis://redis-memory:6379
ENV SELF_URL=http://python-director:8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
