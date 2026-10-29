FROM python:3.14-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /uvx /bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY static ./static

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    STARIO_HOST=0.0.0.0 \
    STARIO_PORT=4321 \
    PROJECT_DATA_DIR=/data \
    CEZ_DRY_RUN=1

EXPOSE 4321

HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4321/health')"

CMD ["python", "-m", "app.main"]
