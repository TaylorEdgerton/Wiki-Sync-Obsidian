"""Database helpers for the Wiki Helper bootstrap schema and raw note access."""

from __future__ import annotations

import base64
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol


SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schema"
CONTENT_VIEW_SCHEMA = "public"
DOC_FORMAT_MARKDOWN = "markdown"
DOC_FORMAT_PLAINTEXT = "txt"
DOC_FILENAME_COLUMNS = ("filename", "name", "title", "slug")
DOC_BODY_COLUMNS = ("body", "content", "description", "text")
DOC_MODIFIED_AT_COLUMNS = ("modified_at", "updated_at")
DOC_CREATED_AT_COLUMNS = ("created_at",)
DOC_EXTRA_HEADERS_COLUMNS = ("headers",)
DOC_ENCODING_COLUMNS = ("encoding",)
DOC_FILETYPE_COLUMNS = ("filetype",)
CONTENT_COMMENT_PREFIXES = ("wiki-sync", "wiki")


@dataclass(frozen=True)
class DocumentRoles:
    filename: str
    body: str
    primary_key: str = "id"
    modified_at: str = ""
    created_at: str = ""
    extra_headers: str = ""
    encoding: str = ""
    filetype: str = ""
    frontmatter: tuple[str, ...] = ()


@dataclass(frozen=True)
class RemoteAppMeta:
    app_name: str
    columns: tuple[str, ...]
    roles: DocumentRoles
    format: str
    view_schema: str = CONTENT_VIEW_SCHEMA


class RawSourceReader(Protocol):
    def read_note(self, app_name: str, note_path: str) -> str | None:
        """Return the raw synced note text for an app/path pair when available."""


def _normalize_content_features(features: Mapping[str, Any] | None = None) -> dict[str, Any]:
    source = features or {}
    return {
        "format": DOC_FORMAT_PLAINTEXT if source.get("format") == DOC_FORMAT_PLAINTEXT else DOC_FORMAT_MARKDOWN,
        "history": bool(source.get("history")),
    }


def _parse_document_format_name(name: str | None) -> str:
    value = str(name or "").strip().lower()
    if value in {"markdown", "md"}:
        return DOC_FORMAT_MARKDOWN
    if value in {"txt", "text", "plaintext", "plain"}:
        return DOC_FORMAT_PLAINTEXT
    return ""


def parse_content_feature_comment(comment: str = "") -> dict[str, Any]:
    trimmed = str(comment or "").strip()
    lowered = trimmed.lower()

    for prefix in CONTENT_COMMENT_PREFIXES:
        marker = f"{prefix.lower()}:"
        if not lowered.startswith(marker):
            continue
        features = {"format": "", "history": False}
        for part in trimmed[len(marker):].split(","):
            value = part.strip().lower()
            if not value:
                continue
            if value == "history":
                features["history"] = True
                continue
            fmt = _parse_document_format_name(value)
            if fmt:
                features["format"] = fmt
        return _normalize_content_features(features)

    return {"format": "", "history": False}


def _find_role_column(column_names: list[str], candidates: tuple[str, ...]) -> str:
    lowered = {column.lower(): column for column in column_names}
    for candidate in candidates:
        match = lowered.get(candidate)
        if match:
            return match
    return ""


def detect_document_column_roles(column_names: list[str], format_name: str = DOC_FORMAT_MARKDOWN) -> DocumentRoles:
    resolved_format = DOC_FORMAT_PLAINTEXT if format_name == DOC_FORMAT_PLAINTEXT else DOC_FORMAT_MARKDOWN
    filename = _find_role_column(column_names, DOC_FILENAME_COLUMNS)
    body = _find_role_column(column_names, DOC_BODY_COLUMNS)
    modified_at = _find_role_column(column_names, DOC_MODIFIED_AT_COLUMNS)
    created_at = _find_role_column(column_names, DOC_CREATED_AT_COLUMNS)
    extra_headers = _find_role_column(column_names, DOC_EXTRA_HEADERS_COLUMNS)
    encoding = _find_role_column(column_names, DOC_ENCODING_COLUMNS)
    filetype = _find_role_column(column_names, DOC_FILETYPE_COLUMNS)

    if not filename:
        raise ValueError(f"No filename column found. Expected one of: {', '.join(DOC_FILENAME_COLUMNS)}")
    if not body:
        raise ValueError(f"No body column found. Expected one of: {', '.join(DOC_BODY_COLUMNS)}")

    frontmatter: tuple[str, ...] = ()
    if resolved_format == DOC_FORMAT_MARKDOWN:
        excluded = {
            value.lower()
            for value in [filename, body, "id", modified_at, created_at, extra_headers, encoding, filetype]
            if value
        }
        frontmatter = tuple(column for column in column_names if column.lower() not in excluded)

    return DocumentRoles(
        filename=filename,
        body=body,
        modified_at=modified_at,
        created_at=created_at,
        extra_headers=extra_headers,
        encoding=encoding,
        filetype=filetype,
        frontmatter=frontmatter,
    )


def _row_from_columns(columns: tuple[str, ...], values: list[Any]) -> dict[str, Any]:
    return {column: values[index] for index, column in enumerate(columns)}


def _render_yaml_scalar(value: Any, indent: str = "") -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            return json.dumps(str(value), ensure_ascii=False)
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        lines = []
        for item in value:
            rendered = _render_yaml_scalar(item, f"{indent}  ")
            lines.append(f"{indent}- {rendered if rendered is not None else 'null'}")
        return "\n" + "\n".join(lines)
    if isinstance(value, Mapping):
        keys = sorted(str(key) for key in value.keys())
        if not keys:
            return "{}"
        lines = []
        for key in keys:
            rendered = _render_yaml_scalar(value[key], f"{indent}  ")
            if rendered and rendered.startswith("\n"):
                lines.append(f"{indent}{key}:{rendered}")
            else:
                lines.append(f"{indent}{key}: {rendered if rendered is not None else 'null'}")
        return "\n" + "\n".join(lines)
    return json.dumps(str(value), ensure_ascii=False)


def synthesize_document_markdown(columns: tuple[str, ...], values: list[Any], roles: DocumentRoles) -> str:
    if len(columns) != len(values):
        raise ValueError("Column/value count mismatch while synthesizing document markdown")

    row = _row_from_columns(columns, values)
    frontmatter_lines: list[str] = []

    for column in roles.frontmatter:
        rendered = _render_yaml_scalar(row.get(column))
        if rendered is None:
            continue
        if rendered.startswith("\n"):
            frontmatter_lines.append(f"{column}:{rendered}")
        else:
            frontmatter_lines.append(f"{column}: {rendered}")

    extra_headers = row.get(roles.extra_headers) if roles.extra_headers else None
    if isinstance(extra_headers, Mapping):
        for key in sorted(str(item) for item in extra_headers.keys()):
            rendered = _render_yaml_scalar(extra_headers[key])
            if rendered is None:
                continue
            if rendered.startswith("\n"):
                frontmatter_lines.append(f"{key}:{rendered}")
            else:
                frontmatter_lines.append(f"{key}: {rendered}")

    parts: list[str] = []
    if frontmatter_lines:
        parts.extend(["---", *frontmatter_lines, "---", ""])

    body = row.get(roles.body)
    if body:
        parts.append(str(body))

    return "\n".join(parts).rstrip("\n") + "\n"


def _quote_db_ident(value: str) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def validate_content_app_name(app_name: str) -> str:
    value = str(app_name or "").strip()
    if not value:
        raise ValueError("Content app name is empty")
    if value in {".", ".."} or "/" in value:
        raise ValueError(f"Invalid content app name: {value}")
    if value.startswith("."):
        raise ValueError(f"Content app names cannot be control paths: {value}")
    return value


@dataclass
class PostgresRawSourceReader:
    database_url: str
    view_schema: str = CONTENT_VIEW_SCHEMA
    _app_meta_cache: dict[str, RemoteAppMeta | None] = field(default_factory=dict, init=False)

    def read_note(self, app_name: str, note_path: str) -> str | None:
        validated_app = validate_content_app_name(app_name)
        normalized_path = str(note_path or "").replace("\\", "/").lstrip("/")
        if not normalized_path or normalized_path == "." or normalized_path.startswith("../"):
            return None

        app_meta = self._load_app_meta(validated_app)
        if not app_meta:
            return None

        filters = [f"{_quote_db_ident(app_meta.roles.filename)} = %s"]
        params: list[Any] = [normalized_path]
        if app_meta.roles.filetype:
            filters.append(f"{_quote_db_ident(app_meta.roles.filetype)} = %s")
            params.append("file")

        rows = self._fetchall(
            f"""
            SELECT *
            FROM {_quote_db_ident(app_meta.view_schema)}.{_quote_db_ident(app_meta.app_name)}
            WHERE {' AND '.join(filters)}
            LIMIT 1
            """,
            params,
        )
        if not rows:
            return None
        return self._build_remote_row_text(app_meta, rows[0])

    def _load_app_meta(self, app_name: str) -> RemoteAppMeta | None:
        if app_name in self._app_meta_cache:
            return self._app_meta_cache[app_name]

        view_rows = self._fetchall(
            """
            SELECT c.relname AS view_name,
                   COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
            FROM pg_class c
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = %s AND c.relkind = 'v' AND c.relname = %s
            LIMIT 1
            """,
            [self.view_schema, app_name],
        )
        if not view_rows:
            self._app_meta_cache[app_name] = None
            return None

        features = parse_content_feature_comment(str(view_rows[0].get("comment") or ""))
        if not features.get("format"):
            self._app_meta_cache[app_name] = None
            return None

        column_rows = self._fetchall(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
            """,
            [self.view_schema, app_name],
        )
        columns = tuple(str(row.get("column_name") or "") for row in column_rows if row.get("column_name"))
        if not columns:
            self._app_meta_cache[app_name] = None
            return None

        app_meta = RemoteAppMeta(
            app_name=app_name,
            columns=columns,
            roles=detect_document_column_roles(list(columns), str(features["format"])),
            format=str(features["format"]),
            view_schema=self.view_schema,
        )
        self._app_meta_cache[app_name] = app_meta
        return app_meta

    def _build_remote_row_text(self, app_meta: RemoteAppMeta, row: Mapping[str, Any]) -> str:
        encoding = str(row.get(app_meta.roles.encoding) or "utf8").lower() if app_meta.roles.encoding else "utf8"

        if app_meta.format == DOC_FORMAT_PLAINTEXT:
            body = row.get(app_meta.roles.body)
            if body is None:
                return ""
            if encoding == "base64":
                decoded = base64.b64decode(str(body))
                return decoded.decode("utf-8")
            text = str(body)
            return text if text.endswith("\n") else f"{text}\n"

        if encoding == "base64":
            filename = row.get(app_meta.roles.filename, "")
            raise ValueError(f"Remote markdown file uses unsupported base64 encoding: {app_meta.app_name}/{filename}")

        values = [row.get(column) for column in app_meta.columns]
        return synthesize_document_markdown(app_meta.columns, values, app_meta.roles)

    def _fetchall(self, sql: str, params: list[Any]) -> list[dict[str, Any]]:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError("psycopg is required for database-backed reveal") from exc

        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                rows = cursor.fetchall()
        return [dict(row) for row in rows]


def read_bootstrap_schema() -> str:
    return (SCHEMA_DIR / "001_privacy_retrieval.sql").read_text(encoding="utf-8")


def split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    in_single_quote = False

    for char in sql:
        if char == "'":
            in_single_quote = not in_single_quote
        if char == ";" and not in_single_quote:
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            continue
        current.append(char)

    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements

