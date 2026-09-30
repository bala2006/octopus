# Octopus: everything runs locally.
PY ?= python3.11
VENV := backend/.venv
BIN := $(VENV)/bin

.PHONY: setup dev backend frontend start test test-backend test-frontend e2e gen-api lint clean docker

setup: ## Install backend (venv) + frontend deps
	cd backend && ($(PY) -m venv .venv || python3 -m venv .venv) && .venv/bin/pip install -U pip && .venv/bin/pip install -r requirements.txt
	cd frontend && npm install

dev: ## Hot-reload dev: API on :8000, UI on :5173 (proxying /api and /ws)
	@echo "UI → http://localhost:5173   API docs → http://localhost:8000/docs"
	@trap 'kill 0' INT TERM; \
	(cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000) & \
	(cd frontend && npm run dev) & wait

start: ## Production-style single process: build UI, serve UI + API on :8000
	cd frontend && npm run build
	cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000

test: test-backend test-frontend ## Unit + integration tests

test-backend:
	cd backend && .venv/bin/python -m pytest -q

test-frontend:
	cd frontend && npm run typecheck && npm test

e2e: ## Playwright happy path (starts its own backend; needs `npm run build` first)
	cd frontend && npm run build && npx playwright test

gen-api: ## Regenerate typed TS client from the FastAPI OpenAPI schema
	cd frontend && npm run gen:api

docker: ## Optional: containers (still local). Set OCTOPUS_PROJECTS to the folder you want to expose.
	docker compose up --build

clean:
	rm -rf frontend/dist frontend/test-results backend/.pytest_cache
