"""Configuration for the local Wiki Helper service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_EMBEDDING_PROVIDER = "fake"
DEFAULT_EMBEDDING_DIMENSION = 1536


@dataclass(frozen=True)
class HelperConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    database_url: str = ""
    embedding_provider: str = DEFAULT_EMBEDDING_PROVIDER
    embedding_dimension: int = DEFAULT_EMBEDDING_DIMENSION


def _parse_int(value: str | None, fallback: int) -> int:
    if not value:
        return fallback
    try:
        parsed = int(value)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def load_config(env: Mapping[str, str] | None = None) -> HelperConfig:
    source = env if env is not None else os.environ
    return HelperConfig(
        host=source.get("WIKI_HELPER_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST,
        port=_parse_int(source.get("WIKI_HELPER_PORT"), DEFAULT_PORT),
        database_url=source.get("WIKI_HELPER_DATABASE_URL", "").strip(),
        embedding_provider=source.get("WIKI_HELPER_EMBEDDING_PROVIDER", DEFAULT_EMBEDDING_PROVIDER).strip()
        or DEFAULT_EMBEDDING_PROVIDER,
        embedding_dimension=_parse_int(
            source.get("WIKI_HELPER_EMBEDDING_DIMENSION"),
            DEFAULT_EMBEDDING_DIMENSION,
        ),
    )

