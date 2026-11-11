# Octopus: everything runs locally. `python -m app.cli` does the work; these targets are shortcuts for it.
PY ?= python3.11
VENV := backend/.venv
CLI := cd backend && .venv/bin/python -m app.cli
PORT_ARG := $(if $(PORT),--port $(PORT),)

.PHONY: setup dev start test test-backend test-frontend gen-api lint lint-arch clean

setup: ## Install backend (venv) + frontend deps
	cd backend && if command -v "$(PY)" >/dev/null 2>&1; then "$(PY)" -m app.cli setup; else python3 -m app.cli setup; fi

dev: ## Hot reload on one URL (OCTOPUS_PORT, default 8000)
	$(CLI) dev $(PORT_ARG)

start: ## Build the UI when stale, then serve everything on one URL (OCTOPUS_PORT, default 8000)
	$(CLI) start $(PORT_ARG)

test: test-backend test-frontend ## Unit + integration tests

test-backend:
	cd backend && .venv/bin/python -m pytest -q

test-frontend:
	cd frontend && npm run typecheck && npm test

lint-arch: ## Check the layer rules (import-linter; needs requirements-dev.txt installed)
	cd backend && .venv/bin/lint-imports

gen-api: ## Regenerate typed TS client from the FastAPI OpenAPI schema
	cd frontend && npm run gen:api

clean:
	rm -rf frontend/dist frontend/test-results backend/.pytest_cache
