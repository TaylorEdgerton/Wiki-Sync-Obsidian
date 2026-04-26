"""Embedding provider interfaces and fake local implementation."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


@dataclass(frozen=True)
class FakeEmbeddingProvider:
    dimension: int = 1536

    def embed(self, text: str) -> list[float]:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        values = []
        for index in range(self.dimension):
            values.append(digest[index % len(digest)] / 255.0)
        return values

