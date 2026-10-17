"""Loads config.yaml and resolves paths relative to the ml/ directory."""

from __future__ import annotations

import datetime as dt
from functools import lru_cache
from pathlib import Path

import yaml

ML_DIR = Path(__file__).resolve().parent
REPO_DIR = ML_DIR.parent
SHARED_AI_DIR = REPO_DIR / "shared" / "ai"
REPORTS_DIR = ML_DIR / "reports"


@lru_cache(maxsize=1)
def load_config(path: str | None = None) -> dict:
    with open(path or ML_DIR / "config.yaml") as f:
        return yaml.safe_load(f)


@lru_cache(maxsize=1)
def load_ai_config() -> dict:
    """config/ai.json: model names shared with the Edge Functions."""
    import json
    with open(REPO_DIR / "config" / "ai.json") as f:
        return json.load(f)


def as_of_date(cfg: dict | None = None) -> dt.date:
    """The run date: forecasts start here, history ends the day before."""
    cfg = cfg or load_config()
    value = cfg["seed"].get("as_of")
    return dt.date.fromisoformat(str(value)) if value else dt.date.today()


def ml_path(*parts: str) -> Path:
    return ML_DIR.joinpath(*parts)
