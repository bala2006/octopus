# Node 22 for the agents' built-in browser: Playwright MCP needs Node 20+ (Debian 12 ships Node 18).
FROM node:22-bookworm-slim AS node

# Pinned to Debian 12 so the Chromium library names below are stable.
FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OCTOPUS_HOME=/data WORKSPACE_ALLOWED_ROOTS='["/workspaces"]'
WORKDIR /app
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
# git, plus the shared libraries Chromium links against (Playwright's Debian 12 set for chromium). Without them the
# browser downloads fine but exits 127 at launch ("libglib-2.0.so.0: cannot open shared object file").
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 octopus && mkdir -p /data /workspaces && chown octopus /data /workspaces
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
USER octopus
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health')" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
