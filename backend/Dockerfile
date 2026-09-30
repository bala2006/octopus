FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OCTOPUS_HOME=/data WORKSPACE_ALLOWED_ROOTS='["/workspaces"]'
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm git && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 octopus && mkdir -p /data /workspaces && chown octopus /data /workspaces
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
USER octopus
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health')" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
