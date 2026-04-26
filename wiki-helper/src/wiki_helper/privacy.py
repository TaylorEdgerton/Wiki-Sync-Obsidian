"""Privacy placeholders and deterministic entity map primitives."""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass, field
from typing import Iterable, Protocol


@dataclass(frozen=True)
class SanitizedNote:
    app_name: str
    path: str
    sanitized_markdown: str


@dataclass(frozen=True)
class EntityMatch:
    entity_type: str
    start: int
    end: int
    text: str


@dataclass(frozen=True)
class EntityRecord:
    placeholder: str
    entity_type: str
    real_value_ciphertext: bytes
    real_value_hash: str


@dataclass(frozen=True)
class SanitizedText:
    text: str
    entities: tuple[EntityRecord, ...] = ()


@dataclass(frozen=True)
class RevealResult:
    text: str
    unresolved_placeholders: tuple[str, ...] = ()


class Detector(Protocol):
    def detect(self, text: str) -> list[EntityMatch]:
        ...


class ValueCipher(Protocol):
    def encrypt(self, value: str) -> bytes:
        ...

    def decrypt(self, ciphertext: bytes) -> str:
        ...


class LocalXorCipher:
    """Small local cipher adapter until a production key strategy is chosen."""

    def __init__(self, key: bytes | str = b"wiki-helper-dev-key") -> None:
        raw = key.encode("utf-8") if isinstance(key, str) else key
        self._key = raw or b"wiki-helper-dev-key"

    def encrypt(self, value: str) -> bytes:
        raw = value.encode("utf-8")
        return base64.b64encode(_xor_with_key_stream(raw, self._key))

    def decrypt(self, ciphertext: bytes) -> str:
        raw = base64.b64decode(ciphertext)
        return _xor_with_key_stream(raw, self._key).decode("utf-8")


@dataclass
class InMemoryEntityMap:
    by_placeholder: dict[str, EntityRecord] = field(default_factory=dict)
    by_hash: dict[str, EntityRecord] = field(default_factory=dict)

    def upsert(self, entity_type: str, real_value: str, cipher: ValueCipher) -> EntityRecord:
        normalized_type = normalize_entity_type(entity_type)
        real_hash = real_value_hash(normalized_type, real_value)
        existing = self.by_hash.get(real_hash)
        if existing:
            return existing

        placeholder = placeholder_for_hash(normalized_type, real_hash)
        for length in range(16, len(real_hash) + 1, 4):
            current = placeholder_for_hash(normalized_type, real_hash, length)
            if current not in self.by_placeholder:
                placeholder = current
                break

        record = EntityRecord(
            placeholder=placeholder,
            entity_type=normalized_type,
            real_value_ciphertext=cipher.encrypt(real_value),
            real_value_hash=real_hash,
        )
        self.by_hash[real_hash] = record
        self.by_placeholder[placeholder] = record
        return record

    def resolve(self, placeholder: str) -> EntityRecord | None:
        return self.by_placeholder.get(placeholder)


class FakeDetector:
    def __init__(self, terms: dict[str, Iterable[str]]) -> None:
        self.terms = {
            normalize_entity_type(entity_type): tuple(term for term in values if term)
            for entity_type, values in terms.items()
        }

    def detect(self, text: str) -> list[EntityMatch]:
        matches: list[EntityMatch] = []
        for entity_type, terms in self.terms.items():
            for term in terms:
                pattern = re.compile(re.escape(term), re.IGNORECASE)
                for match in pattern.finditer(text):
                    matches.append(EntityMatch(entity_type, match.start(), match.end(), match.group(0)))
        return _without_overlaps(matches, existing_placeholder_spans(text))


class PresidioDetector:
    """NLP-based PII detector backed by Microsoft Presidio + spaCy.

    Requires the ``presidio`` optional extras and a downloaded spaCy model::

        pip install 'wiki-helper[presidio]'
        python -m spacy download en_core_web_sm
    """

    def __init__(self, analyzer: object, language: str = "en", score_threshold: float = 0.5) -> None:
        self._analyzer = analyzer
        self._language = language
        self._score_threshold = score_threshold

    @classmethod
    def create(
        cls,
        language: str = "en",
        score_threshold: float = 0.5,
        model: str = "en_core_web_sm",
    ) -> "PresidioDetector":
        try:
            from presidio_analyzer import AnalyzerEngine  # type: ignore[import-untyped]
            from presidio_analyzer.nlp_engine import NlpEngineProvider  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "presidio-analyzer is not installed. "
                "Install with: pip install 'wiki-helper[presidio]'"
            ) from exc
        try:
            provider = NlpEngineProvider(
                nlp_configuration={
                    "nlp_engine_name": "spacy",
                    "models": [{"lang_code": language, "model_name": model}],
                }
            )
            engine = provider.create_engine()
        except OSError as exc:
            raise ImportError(
                f"spaCy model '{model}' is not installed. "
                f"Run: python -m spacy download {model}"
            ) from exc
        return cls(AnalyzerEngine(nlp_engine=engine), language, score_threshold)

    def detect(self, text: str) -> list[EntityMatch]:
        results = self._analyzer.analyze(text=text, language=self._language)
        blocked = existing_placeholder_spans(text)
        matches = [
            EntityMatch(
                entity_type=r.entity_type,
                start=r.start,
                end=r.end,
                text=text[r.start : r.end],
            )
            for r in results
            if r.score >= self._score_threshold
        ]
        return _without_overlaps(matches, blocked)


PLACEHOLDER_RE = re.compile(r"\[\[PRIVATE:([A-Z0-9_]+):([A-F0-9]{12,64})\]\]")


def normalize_entity_type(entity_type: str) -> str:
    normalized = re.sub(r"[^A-Z0-9_]+", "_", str(entity_type or "PRIVATE").upper()).strip("_")
    return normalized or "PRIVATE"


def real_value_hash(entity_type: str, real_value: str) -> str:
    digest = hashlib.sha256()
    digest.update(normalize_entity_type(entity_type).encode("utf-8"))
    digest.update(b"\0")
    digest.update(real_value.encode("utf-8"))
    return digest.hexdigest()


def placeholder_for_hash(entity_type: str, value_hash: str, length: int = 12) -> str:
    return f"[[PRIVATE:{normalize_entity_type(entity_type)}:{value_hash[:length].upper()}]]"


def sanitize_text(
    text: str,
    detector: FakeDetector,
    entity_map: InMemoryEntityMap,
    cipher: ValueCipher | None = None,
) -> SanitizedText:
    active_cipher = cipher or LocalXorCipher()
    matches = _without_overlaps(detector.detect(text), existing_placeholder_spans(text))
    if not matches:
        return SanitizedText(text=text)

    entities: list[EntityRecord] = []
    output = []
    cursor = 0
    for match in sorted(matches, key=lambda item: item.start):
        output.append(text[cursor:match.start])
        record = entity_map.upsert(match.entity_type, match.text, active_cipher)
        entities.append(record)
        output.append(record.placeholder)
        cursor = match.end
    output.append(text[cursor:])
    return SanitizedText(text="".join(output), entities=tuple(entities))


def reveal_text(
    sanitized_text: str,
    entity_map: InMemoryEntityMap,
    cipher: ValueCipher | None = None,
) -> RevealResult:
    active_cipher = cipher or LocalXorCipher()
    unresolved: list[str] = []

    def replace(match: re.Match[str]) -> str:
        placeholder = match.group(0)
        record = entity_map.resolve(placeholder)
        if not record:
            unresolved.append(placeholder)
            return placeholder
        return active_cipher.decrypt(record.real_value_ciphertext)

    return RevealResult(
        text=PLACEHOLDER_RE.sub(replace, sanitized_text),
        unresolved_placeholders=tuple(unresolved),
    )


def sanitize_noop(app_name: str, path: str, raw_markdown: str) -> SanitizedNote:
    return SanitizedNote(
        app_name=app_name,
        path=path,
        sanitized_markdown=raw_markdown,
    )


def existing_placeholder_spans(text: str) -> list[tuple[int, int]]:
    return [(match.start(), match.end()) for match in PLACEHOLDER_RE.finditer(text)]


def _without_overlaps(matches: Iterable[EntityMatch], blocked: Iterable[tuple[int, int]]) -> list[EntityMatch]:
    blocked_ranges = list(blocked)
    accepted: list[EntityMatch] = []
    for match in sorted(matches, key=lambda item: (item.start, -(item.end - item.start))):
        if any(_overlaps(match.start, match.end, start, end) for start, end in blocked_ranges):
            continue
        if any(_overlaps(match.start, match.end, item.start, item.end) for item in accepted):
            continue
        accepted.append(match)
    return accepted


def _overlaps(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return left_start < right_end and right_start < left_end


def _xor_with_key_stream(value: bytes, key: bytes) -> bytes:
    output = bytearray()
    counter = 0
    while len(output) < len(value):
        digest = hashlib.sha256(key + counter.to_bytes(8, "big")).digest()
        output.extend(digest)
        counter += 1
    return bytes(item ^ output[index] for index, item in enumerate(value))
