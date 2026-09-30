"""Application configuration loaded from environment / .env."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]
PROJECT_DIRNAME = ".octopus"


def _default_roots() -> list[str]:
    roots = [str(Path.home())]
    for extra in ("/projects", "/workspaces"):
        if Path(extra).is_dir():
            roots.append(extra)
    return roots


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Octopus"
    environment: str = "development"
    log_level: str = "INFO"
    log_json: bool = False

    # Global registry (users, provider keys, MCP servers, list of workspaces). Project data lives in <project>/.octopus/
    octopus_home: Path = Path(os.environ.get("OCTOPUS_HOME", str(Path.home() / ".octopus")))
    registry_url: str | None = None  # override for Postgres etc.
    # Directories users may pick as projects (and browse in the directory picker)
    workspace_allowed_roots: list[str] = Field(default_factory=_default_roots)

    secret_key: str = "change-me-in-production-please-32chars!!"
    encryption_key: str | None = None  # Fernet key; derived from secret_key if absent
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 60 * 24 * 7

    single_user_mode: bool = True
    single_user_email: str = "demo@octopus.local"

    demo_mode: bool = True  # when true, the mock provider is used for any agent lacking a key
    default_provider: str = "azure"
    default_model: str = "gpt-4.1-mini"

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8080"])
    rate_limit_per_minute: int = 1200

    # sandbox
    sandbox_mode: str = "subprocess"  # subprocess | docker
    sandbox_timeout_s: int = 60
    sandbox_memory_mb: int = 1024
    sandbox_docker_image: str = "python:3.11-slim"

    # MCP: allow stdio servers (spawns user-configured commands on the backend host)
    mcp_allow_stdio: bool = True

    # run defaults
    default_max_turns: int = 60
    default_max_tokens_budget: int = 400_000
    default_max_cost_usd: float = 2.0
    default_timeout_s: int = 900

    ollama_base_url: str | None = None  # e.g. http://localhost:11434 (Ollama counts as configured once set)

    # Azure OpenAI (azure/<deployment>) and Azure AI Foundry (azure_ai/<model>)
    azure_api_key: str | None = None
    azure_api_base: str | None = None  # https://<resource>.openai.azure.com
    azure_api_version: str = "2024-10-21"
    azure_ai_api_key: str | None = None
    azure_ai_api_base: str | None = None  # https://<resource>.services.ai.azure.com/models
    azure_use_entra: bool = False  # use Microsoft Entra ID (az login / managed identity) instead of keys

    # env-provided keys (used when user hasn't stored keys)
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None

    @property
    def registry_database_url(self) -> str:
        return self.registry_url or f"sqlite+aiosqlite:///{self.octopus_home / 'registry.db'}"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.octopus_home.mkdir(parents=True, exist_ok=True)
    return s
