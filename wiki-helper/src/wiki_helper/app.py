"""HTTP entrypoint for the local Wiki Helper service."""

from __future__ import annotations

import json
import warnings
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from .config import HelperConfig, load_config
from .db import PostgresRawSourceReader, RawSourceReader
from .embeddings import FakeEmbeddingProvider
from .privacy import Detector, FakeDetector, InMemoryEntityMap, LocalXorCipher, PLACEHOLDER_RE, PresidioDetector, reveal_text, sanitize_text
from .search import InMemorySearchIndex, content_hash


ROUTE_STUBS = {
    "/reveal-text": "reveal-text is not implemented yet.",
    "/search-wiki": "search-wiki is not implemented yet.",
}


def _build_detector(config: HelperConfig) -> Detector:
    if config.anonymizer_provider == "presidio":
        try:
            return PresidioDetector.create(config.presidio_language, model=config.presidio_model)
        except ImportError as exc:
            import warnings
            warnings.warn(
                f"presidio detector unavailable, falling back to FakeDetector: {exc}",
                stacklevel=2,
            )
    return FakeDetector({})


@dataclass
class HelperState:
    detector: Detector = field(default_factory=lambda: FakeDetector({}))
    entity_map: InMemoryEntityMap = field(default_factory=InMemoryEntityMap)
    cipher: LocalXorCipher = field(default_factory=LocalXorCipher)
    index: InMemorySearchIndex = field(default_factory=InMemorySearchIndex)
    raw_source_reader: RawSourceReader | None = None

    @property
    def anonymizer_active(self) -> str:
        return "presidio" if isinstance(self.detector, PresidioDetector) else "fake"


def health_payload(config: HelperConfig, state: "HelperState | None" = None) -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "wiki-helper",
        "databaseConfigured": bool(config.database_url),
        "embeddingProvider": config.embedding_provider,
        "embeddingDimension": config.embedding_dimension,
        "anonymizerConfigured": config.anonymizer_provider,
        "anonymizerActive": state.anonymizer_active if state else "unknown",
    }


def _send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def _required_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing_required_string: {key}")
    return value


def _sanitize_note(payload: dict[str, Any], state: HelperState) -> dict[str, Any]:
    app_name = _required_string(payload, "appName")
    note_path = _required_string(payload, "path")
    raw_markdown = _required_string(payload, "rawMarkdown")
    terms = payload.get("terms")
    detector = FakeDetector(terms) if isinstance(terms, dict) else state.detector
    sanitized = sanitize_text(raw_markdown, detector, state.entity_map, state.cipher)
    return {
        "appName": app_name,
        "path": note_path,
        "sanitizedMarkdown": sanitized.text,
        "rawContentHash": content_hash(raw_markdown),
        "sanitizedContentHash": content_hash(sanitized.text),
        "entities": [
            {
                "placeholder": entity.placeholder,
                "entityType": entity.entity_type,
                "realValueHash": entity.real_value_hash,
            }
            for entity in sanitized.entities
        ],
    }


def _index_note(payload: dict[str, Any], state: HelperState) -> dict[str, Any]:
    app_name = _required_string(payload, "appName")
    note_path = _required_string(payload, "path")
    sanitized_markdown = _required_string(payload, "sanitizedMarkdown")
    raw_content_hash = _required_string(payload, "rawContentHash")
    result = state.index.upsert_document(app_name, note_path, sanitized_markdown, raw_content_hash)
    return {
        "docId": result.document.doc_id,
        "appName": result.document.app_name,
        "path": result.document.path,
        "sanitizedContentHash": result.document.sanitized_content_hash,
        "changed": result.changed,
        "chunkCount": len(result.chunks),
        "chunks": [
            {
                "chunkId": chunk.chunk_id,
                "chunkIndex": chunk.chunk_index,
                "headingPath": chunk.heading_path,
                "contentHash": chunk.content_hash,
                "embeddingDimensions": len(chunk.embedding),
            }
            for chunk in result.chunks
        ],
    }


def _sensitive_values_for_records(records: list[Any], state: HelperState) -> list[dict[str, str]]:
    values: list[dict[str, str]] = []
    seen: set[str] = set()
    for record in records:
        key = str(getattr(record, "real_value_hash", "") or getattr(record, "placeholder", ""))
        if not key or key in seen:
            continue
        try:
            real_value = state.cipher.decrypt(record.real_value_ciphertext)
        except Exception:
            continue
        seen.add(key)
        values.append({
            "text": real_value,
            "placeholder": record.placeholder,
            "entityType": record.entity_type,
            "realValueHash": record.real_value_hash,
        })
    return values


def _sensitive_values_for_reveal(sanitized_text: str, revealed_text: str, state: HelperState) -> list[dict[str, str]]:
    records = []
    for match in PLACEHOLDER_RE.finditer(sanitized_text):
        record = state.entity_map.resolve(match.group(0))
        if record:
            records.append(record)

    detected = sanitize_text(revealed_text, state.detector, state.entity_map, state.cipher)
    records.extend(detected.entities)
    return _sensitive_values_for_records(records, state)


def _reveal_text(payload: dict[str, Any], state: HelperState) -> dict[str, Any]:
    sanitized = _required_string(payload, "sanitizedText")
    app_name = payload.get("appName")
    note_path = payload.get("path")
    prefer_raw_source = payload.get("preferRawSource", True) is not False

    if (
        prefer_raw_source
        and isinstance(app_name, str) and app_name
        and isinstance(note_path, str) and note_path
        and state.raw_source_reader
    ):
        try:
            raw_text = state.raw_source_reader.read_note(app_name, note_path)
        except Exception as error:
            warnings.warn(
                f"database-backed reveal unavailable for {app_name}/{note_path}: {error}",
                stacklevel=2,
            )
        else:
            if raw_text is not None:
                return {
                    "text": raw_text,
                    "unresolvedPlaceholders": [],
                    "sensitiveValues": _sensitive_values_for_reveal(sanitized, raw_text, state),
                    "source": "rawSource",
                }

    result = reveal_text(sanitized, state.entity_map, state.cipher)
    return {
        "text": result.text,
        "unresolvedPlaceholders": list(result.unresolved_placeholders),
        "sensitiveValues": _sensitive_values_for_reveal(sanitized, result.text, state),
        "source": "placeholderMap",
    }


def make_handler(config: HelperConfig, state: HelperState | None = None) -> type[BaseHTTPRequestHandler]:
    resolved_state = state or HelperState(
        detector=_build_detector(config),
        index=InMemorySearchIndex(FakeEmbeddingProvider(config.embedding_dimension)),
        raw_source_reader=PostgresRawSourceReader(config.database_url) if config.database_url else None,
    )

    class WikiHelperHandler(BaseHTTPRequestHandler):
        server_version = "WikiHelper/0.1"

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/health":
                _send_json(self, 200, health_payload(config, resolved_state))
                return
            _send_json(self, 404, {"error": "not_found"})

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            if path not in ROUTE_STUBS and path not in {"/sanitize-note", "/index-note"}:
                _send_json(self, 404, {"error": "not_found"})
                return
            try:
                payload = _read_json_body(self)
            except json.JSONDecodeError as error:
                _send_json(self, 400, {"error": f"invalid_json: {error.msg}"})
                return
            try:
                if path == "/sanitize-note":
                    _send_json(self, 200, _sanitize_note(payload, resolved_state))
                    return
                if path == "/index-note":
                    _send_json(self, 200, _index_note(payload, resolved_state))
                    return
                if path == "/reveal-text":
                    _send_json(self, 200, _reveal_text(payload, resolved_state))
                    return
            except ValueError as error:
                _send_json(self, 400, {"error": str(error)})
                return
            _send_json(self, 501, {"error": ROUTE_STUBS[path]})

    return WikiHelperHandler


def create_server(config: HelperConfig | None = None, state: HelperState | None = None) -> ThreadingHTTPServer:
    resolved = config or load_config()
    return ThreadingHTTPServer((resolved.host, resolved.port), make_handler(resolved, state))


def main() -> None:
    config = load_config()
    server = create_server(config)
    print(f"Wiki Helper listening on http://{config.host}:{config.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
