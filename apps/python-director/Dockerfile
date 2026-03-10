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

ENV COQUI_TOS_AGREED=1

WORKDIR /app

# Install PyTorch with CUDA 12.1 wheel FIRST (prevents PyPI overriding with CPU-only build)
RUN pip install --no-cache-dir torch>=2.1.0 --extra-index-url https://download.pytorch.org/whl/cu121

# Install remaining dependencies (Docker layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create audio/generated dirs (fallback if volumes are not mounted)
RUN mkdir -p /app/audio /app/generated

EXPOSE 8000

ENV RUST_ENGINE_URL=http://rust-engine:8080
ENV REDIS_URL=redis://redis-memory:6379
ENV SELF_URL=http://localhost:8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
