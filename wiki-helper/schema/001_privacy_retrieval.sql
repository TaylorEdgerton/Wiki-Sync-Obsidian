CREATE SCHEMA IF NOT EXISTS wiki_private;
CREATE SCHEMA IF NOT EXISTS wiki_public;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS wiki_private.entity_map (
    placeholder TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    real_value_ciphertext BYTEA NOT NULL,
    real_value_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_map_real_value_hash_idx
    ON wiki_private.entity_map (real_value_hash)
    WHERE real_value_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS wiki_private.privacy_terms (
    term_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    term TEXT NOT NULL,
    normalized_term TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (entity_type, normalized_term)
);

CREATE TABLE IF NOT EXISTS wiki_private.privacy_allowlist (
    term_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    term TEXT NOT NULL,
    normalized_term TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT true,
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
    raw_available BOOLEAN NOT NULL DEFAULT true,
    source_kind TEXT NOT NULL DEFAULT 'synced_raw',
    indexed BOOLEAN NOT NULL DEFAULT false,
    embedding_status TEXT NOT NULL DEFAULT 'pending',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_name, path)
);

CREATE TABLE IF NOT EXISTS wiki_private.raw_documents (
    doc_id UUID PRIMARY KEY REFERENCES wiki_public.sanitized_documents(doc_id) ON DELETE CASCADE,
    raw_markdown_ciphertext BYTEA NOT NULL,
    raw_content_hash TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'imported_raw',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wiki_public.chunks (
    chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID NOT NULL REFERENCES wiki_public.sanitized_documents(doc_id) ON DELETE CASCADE,
    app_name TEXT NOT NULL,
    path TEXT NOT NULL,
    heading_path TEXT,
    chunk_type TEXT NOT NULL DEFAULT 'prose',
    block_index INT NOT NULL DEFAULT 0,
    chunk_index INT NOT NULL,
    sanitized_text TEXT NOT NULL,
    normalized_text TEXT,
    search_vector TSVECTOR,
    site TEXT,
    incident_num TEXT,
    doc_type TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    content_hash TEXT NOT NULL,
    embedding vector(1536),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (doc_id, chunk_index)
);
