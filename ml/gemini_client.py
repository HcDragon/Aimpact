"""Gemini calls for the Python side (eval scorers, nightly review / insight batches, embeddings).

Free-tier friendly: one queue per process with minimum spacing between calls,
exponential backoff with jitter on 429/5xx, and an on-disk cache keyed on
model + prompt + input bytes so re-running an eval or the demo costs nothing.
Model names come from config/ai.json. The API key is read from ml/.env or the repo-root .env.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import threading
import time
from pathlib import Path

from settings import REPO_DIR, SHARED_AI_DIR, load_ai_config, load_config, ml_path

_lock = threading.Lock()
_last_call = 0.0


class GeminiUnavailable(RuntimeError):
    """No key, quota exhausted, or retries used up; callers fall back to manual or skip."""


def load_prompt(name: str) -> str:
    """The prompt body is everything after the first '---' line in shared/ai/prompts/<name>.md."""
    text = (SHARED_AI_DIR / "prompts" / f"{name}.md").read_text()
    return text.split("\n---\n", 1)[1].strip() if "\n---\n" in text else text


def load_schema(name: str) -> dict:
    schema = json.loads((SHARED_AI_DIR / "schemas" / f"{name}.json").read_text())
    for k in ("$schema", "$id", "title"):
        schema.pop(k, None)
    return schema


class Gemini:
    def __init__(self, api_key: str | None = None):
        from dotenv import load_dotenv

        load_dotenv(ml_path(".env"))
        load_dotenv(REPO_DIR / ".env")
        ai = load_ai_config()["gemini"]
        self.cfg = {**load_config()["gemini"], "flash_model": ai["vision_model"],
                    "embedding_model": ai["embedding_model"], "embedding_dim": ai["embedding_dimensions"]}
        self.api_key = api_key or os.environ.get(ai["api_key_env"])
        self.cache_dir = ml_path(self.cfg["cache_dir"])
        self._client = None

    @property
    def client(self):
        if self._client is None:
            if not self.api_key:
                raise GeminiUnavailable("GEMINI_API_KEY not set in ml/.env")
            from google import genai
            self._client = genai.Client(api_key=self.api_key)
        return self._client

    # -- plumbing -----------------------------------------------------------
    def _cache_path(self, kind: str, *parts: bytes | str) -> Path:
        h = hashlib.sha256()
        for p in parts:
            h.update(p if isinstance(p, bytes) else p.encode())
            h.update(b"\0")
        return self.cache_dir / kind / f"{h.hexdigest()[:32]}.json"

    def _pace(self) -> None:
        global _last_call
        with _lock:
            wait = self.cfg["min_seconds_between_calls"] - (time.monotonic() - _last_call)
            if wait > 0:
                time.sleep(wait)
            _last_call = time.monotonic()

    def _with_retries(self, fn):
        last = None
        for attempt in range(self.cfg["max_retries"]):
            self._pace()
            try:
                return fn()
            except Exception as e:  # google.genai raises APIError subclasses with .code
                code = getattr(e, "code", None)
                if code not in (429, 500, 502, 503, 504, None):
                    raise
                last = e
                time.sleep(self.cfg["backoff_base_seconds"] * 2 ** attempt + random.uniform(0, 1))
        raise GeminiUnavailable(f"Gemini failed after {self.cfg['max_retries']} attempts: {last}")

    # -- calls --------------------------------------------------------------
    def generate_json(self, prompt_name: str, text: str | None = None,
                      media: bytes | None = None, mime_type: str | None = None) -> str:
        """Returns the raw response text; callers must run it through a validator."""
        model = self.cfg["flash_model"]
        system = load_prompt(prompt_name)
        cache = self._cache_path("generate", model, system, text or "", media or b"")
        if cache.exists():
            return json.loads(cache.read_text())["text"]

        from google.genai import types

        contents = []
        if media is not None:
            contents.append(types.Part.from_bytes(data=media, mime_type=mime_type))
        if text:
            contents.append(text)
        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_json_schema=load_schema(prompt_name if prompt_name != "review_sentiment" else "review"),
            temperature=0,
        )
        resp = self._with_retries(lambda: self.client.models.generate_content(
            model=model, contents=contents, config=config))
        out = resp.text or ""
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"model": model, "text": out}))
        return out

    def embed(self, items: list[str | tuple[bytes, str]]) -> list[list[float]]:
        """Embed text strings or (image_bytes, mime_type) pairs into one vector space."""
        from google.genai import types

        model, dim = self.cfg["embedding_model"], self.cfg["embedding_dim"]
        vectors = []
        for it in items:
            key = it if isinstance(it, str) else it[0]
            cache = self._cache_path("embed", model, str(dim), key)
            if cache.exists():
                vectors.append(json.loads(cache.read_text()))
                continue
            content = it if isinstance(it, str) else types.Part.from_bytes(data=it[0], mime_type=it[1])
            resp = self._with_retries(lambda: self.client.models.embed_content(
                model=model, contents=[content], config=types.EmbedContentConfig(output_dimensionality=dim)))
            vec = list(resp.embeddings[0].values)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(vec))
            vectors.append(vec)
        return vectors
