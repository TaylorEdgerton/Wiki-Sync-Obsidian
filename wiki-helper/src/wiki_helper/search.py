"""In-memory sanitized document and chunk index primitives."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field

from .chunking import Chunk, chunk_markdown
from .embeddings import FakeEmbeddingProvider


@dataclass(frozen=True)
class SearchResult:
    app_name: str
    path: str
    heading_path: str
    snippet: str
    score: float


@dataclass(frozen=True)
class SanitizedDocument:
    doc_id: str
    app_name: str
    path: str
    sanitized_markdown: str
    raw_content_hash: str
    sanitized_content_hash: str


@dataclass(frozen=True)
class IndexedChunk:
    chunk_id: str
    doc_id: str
    app_name: str
    path: str
    heading_path: str
    chunk_index: int
    sanitized_text: str
    content_hash: str
    embedding: tuple[float, ...]


@dataclass
class IndexResult:
    document: SanitizedDocument
    chunks: tuple[IndexedChunk, ...]
    changed: bool


@dataclass
class InMemorySearchIndex:
    embedding_provider: FakeEmbeddingProvider = field(default_factory=FakeEmbeddingProvider)
    documents: dict[tuple[str, str], SanitizedDocument] = field(default_factory=dict)
    chunks_by_doc: dict[str, tuple[IndexedChunk, ...]] = field(default_factory=dict)

    def upsert_document(
        self,
        app_name: str,
        path: str,
        sanitized_markdown: str,
        raw_content_hash: str,
    ) -> IndexResult:
        key = (app_name, path)
        sanitized_hash = content_hash(sanitized_markdown)
        existing = self.documents.get(key)
        changed = (
            existing is None
            or existing.raw_content_hash != raw_content_hash
            or existing.sanitized_content_hash != sanitized_hash
        )

        doc_id = existing.doc_id if existing else str(uuid.uuid4())
        document = SanitizedDocument(
            doc_id=doc_id,
            app_name=app_name,
            path=path,
            sanitized_markdown=sanitized_markdown,
            raw_content_hash=raw_content_hash,
            sanitized_content_hash=sanitized_hash,
        )
        self.documents[key] = document

        if changed:
            self.chunks_by_doc[doc_id] = tuple(self._build_chunks(document, chunk_markdown(sanitized_markdown)))
        return IndexResult(document=document, chunks=self.chunks_by_doc.get(doc_id, ()), changed=changed)

    def _build_chunks(self, document: SanitizedDocument, chunks: list[Chunk]) -> list[IndexedChunk]:
        indexed: list[IndexedChunk] = []
        for chunk in chunks:
            indexed.append(IndexedChunk(
                chunk_id=str(uuid.uuid4()),
                doc_id=document.doc_id,
                app_name=document.app_name,
                path=document.path,
                heading_path=chunk.heading_path,
                chunk_index=chunk.chunk_index,
                sanitized_text=chunk.text,
                content_hash=content_hash(chunk.text),
                embedding=tuple(self.embedding_provider.embed(chunk.text)),
            ))
        return indexed


def empty_search_results() -> list[SearchResult]:
    return []


def content_hash(value: str | bytes) -> str:
    raw = value if isinstance(value, bytes) else value.encode("utf-8")
    return hashlib.sha256(raw).hexdigest()
