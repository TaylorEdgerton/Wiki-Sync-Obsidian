CREATE SCHEMA IF NOT EXISTS wiki_private;
CREATE SCHEMA IF NOT EXISTS wiki_public;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS wiki_private.entity_map (
    placeholder TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    real_value_ciphertext BYTEA NOT NULL,
    real_value_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wiki_public.sanitized_documents (
    doc_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_name TEXT NOT NULL,
    path TEXT NOT NULL,
    sanitized_markdown TEXT NOT NULL,
    raw_content_hash TEXT NOT NULL,
    sanitized_content_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_name, path)
);

CREATE TABLE IF NOT EXISTS wiki_public.chunks (
    chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID NOT NULL REFERENCES wiki_public.sanitized_documents(doc_id) ON DELETE CASCADE,
    app_name TEXT NOT NULL,
    path TEXT NOT NULL,
    heading_path TEXT,
    chunk_index INT NOT NULL,
    sanitized_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding vector(1536),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (doc_id, chunk_index)
);

