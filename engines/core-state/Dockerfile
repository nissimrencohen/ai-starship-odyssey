# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM rust:latest AS builder

WORKDIR /usr/src/core-state
COPY Cargo.toml ./
COPY src/ ./src/

RUN cargo build --release

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/core-state/target/release/core-state /usr/local/bin/core-state

EXPOSE 8080 8081

ENV PYTHON_DIRECTOR_URL=http://python-director:8000

CMD ["core-state"]
