"""Markdown chunking primitives."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Chunk:
    heading_path: str
    chunk_index: int
    text: str


def chunk_markdown(markdown: str) -> list[Chunk]:
    text = markdown.strip()
    if not text:
        return []
    return [Chunk(heading_path="", chunk_index=0, text=text)]

