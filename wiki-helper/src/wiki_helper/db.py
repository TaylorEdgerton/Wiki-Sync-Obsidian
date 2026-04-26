"""Database helpers for the Wiki Helper bootstrap schema."""

from __future__ import annotations

from pathlib import Path


SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schema"


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

