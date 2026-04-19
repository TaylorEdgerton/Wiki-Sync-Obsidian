/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Taylor Edgerton
 * Licensed under the MIT License. See LICENSE.
 */

'use strict';

/**
 * Taylor Edgerton - 2026
 * Wiki Sync — Obsidian plugin (single-file, no build step)
 * Portions of the content-store schema, markdown, and history behavior are
 * adapted from TigerFS under the MIT License. See NOTICE for attribution.
 *
 * Syncs a PostgreSQL-backed wiki into a vault subfolder.
 * Two auth modes:
 *   oidc  — PKCE flow via any OIDC provider → JWT → pg-oidc-proxy
 *   local — direct Postgres connection settings + password (no browser, no proxy)
 */

const { Plugin, Notice, PluginSettingTab, SecretComponent, Setting, setIcon, Modal, Menu, requireApiVersion } = require('obsidian');
const { spawn, execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const url    = require('url');
const YAML   = require('yaml');

const CONTENT_SCHEMA = 'wiki';
const CONTENT_VIEW_SCHEMA = 'public';
const CONTENT_COMMENT_PREFIX = 'wiki';
const CONTENT_COMMENT_PREFIXES = Object.freeze([CONTENT_COMMENT_PREFIX]);
const CONTENT_HISTORY_SCHEMAS = Object.freeze([CONTENT_SCHEMA]);
const DOC_FORMAT_MARKDOWN = 'markdown';
const DOC_FORMAT_PLAINTEXT = 'txt';
const DOC_FILENAME_COLUMNS = ['filename', 'name', 'title', 'slug'];
const DOC_BODY_COLUMNS = ['body', 'content', 'description', 'text'];
const DOC_MODIFIED_AT_COLUMNS = ['modified_at', 'updated_at'];
const DOC_CREATED_AT_COLUMNS = ['created_at'];
const DOC_EXTRA_HEADERS_COLUMNS = ['headers'];
const DOC_ENCODING_COLUMNS = ['encoding'];
const DOC_FILETYPE_COLUMNS = ['filetype'];
const REMOTE_FILE_LIST_LIMIT = 10000;
const HISTORY_SNAPSHOT_LIMIT = 1000;
const REMOTE_NOTIFY_CHANNEL = 'wiki_sync_changed';
const REMOTE_NOTIFY_FUNCTION = 'wiki_sync_notify_change';
const REMOTE_NOTIFY_TRIGGER = 'trg_wiki_sync_notify';
const REMOTE_NOTIFY_RECONNECT_MS = 5000;
const REMOTE_CHANGED_FILE_LIMIT = 1000;
const REMOTE_DELETE_PREVIEW_LIMIT = 12;
const REMOTE_DELETE_BULK_CONFIRM_COUNT = 5;
const REMOTE_DELETE_BULK_CONFIRM_RATIO = 0.5;
const DB_CONNECTION_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENOTFOUND',
    '57P01',
    '57P02',
    '57P03',
    '53300',
    '53400',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Runtime Utilities and Defaults
// ═══════════════════════════════════════════════════════════════════════════════

const COMMON_AI_SCAFFOLD_SKILL_NAMES = [
    'wiki',
    'wiki-ingest',
    'wiki-query',
    'wiki-lint',
    'save',
    'canvas',
    'homepage',
    'obsidian-bases',
    'obsidian-markdown',
];
const ONCALL_AI_SCAFFOLD_SKILL_NAMES = [
    'wiki',
    'wiki-ingest',
    'wiki-query',
    'wiki-lint',
    'save',
    'canvas',
    'oncall',
    'homepage',
    'obsidian-bases',
    'obsidian-markdown',
];
const AI_SCAFFOLD_VAULT_SKILL_ROOTS = [
    { path: '.claude/skills',  frontmatter: false },
    { path: '.agents/skills',  frontmatter: true  },  // Codex requires name+description frontmatter
];
const DEFAULT_AI_SCAFFOLD_PROFILE = 'on-call-operations';
const AI_SCAFFOLD_PROFILES = {
    minimal: {
        id: 'minimal',
        label: 'Minimal',
        description: 'General wiki scaffold for a fresh wiki workspace without an issue or on-call queue.',
        skillNames: COMMON_AI_SCAFFOLD_SKILL_NAMES,
    },
    'project-wiki': {
        id: 'project-wiki',
        label: 'Project Wiki',
        description: 'Project-focused scaffold with documentation, source ingest, and issue-oriented guidance.',
        skillNames: COMMON_AI_SCAFFOLD_SKILL_NAMES,
    },
    'multi-site-operations': {
        id: 'multi-site-operations',
        label: 'Multi-Site Operations',
        description: 'Operations scaffold for multiple sites, shared runbooks, and issue-oriented work queues.',
        skillNames: COMMON_AI_SCAFFOLD_SKILL_NAMES,
    },
    'on-call-operations': {
        id: 'on-call-operations',
        label: 'On-Call Operations',
        description: 'Operational scaffold for incidents, on-call handover, and live response work.',
        skillNames: ONCALL_AI_SCAFFOLD_SKILL_NAMES,
    },
};

const DEFAULT_SETTINGS = {
    authMode:         'oidc',   // 'oidc' | 'local'
    // OIDC mode
    oidcWellKnown:    '',
    oidcClientId:     '',
    oidcClientSecret: '',
    oidcRedirectUri:  'http://localhost:8080/callback',
    proxyHost:        'localhost',
    listenPort:       '5432',
    oidcDbUser:       'wiki_user',
    oidcDbName:       'wiki',
    // Local mode
    localDbUser:      'postgres',
    localDbHost:      'localhost',
    localDbPort:      '5432',
    localDbName:      '',
    localDisableSsl:  false,
    localConnStr:     '',
    localPasswordSecret: '',
    // Behaviour
    syncSubdir:       'wiki',
    autoSync:         false,
    scaffoldProfile:  DEFAULT_AI_SCAFFOLD_PROFILE,
};

function quoteDbIdent(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteSqlLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteDbTable(schema, table) {
    return `${quoteDbIdent(schema)}.${quoteDbIdent(table)}`;
}

function normalizeContentFeatures(features = {}) {
    return {
        format: features.format === DOC_FORMAT_PLAINTEXT ? DOC_FORMAT_PLAINTEXT : DOC_FORMAT_MARKDOWN,
        history: !!features.history,
    };
}

function parseDocumentFormatName(name) {
    switch (String(name || '').trim().toLowerCase()) {
    case 'markdown':
    case 'md':
        return DOC_FORMAT_MARKDOWN;
    case 'txt':
    case 'text':
    case 'plaintext':
    case 'plain':
        return DOC_FORMAT_PLAINTEXT;
    default:
        return '';
    }
}

function parseContentFeatureString(input) {
    const features = { format: '', history: false };
    for (const part of String(input || '').split(',')) {
        const value = part.trim().toLowerCase();
        if (!value) continue;
        if (value === 'history') {
            features.history = true;
            continue;
        }
        const format = parseDocumentFormatName(value);
        if (format) features.format = format;
    }
    return features;
}

function contentFeatureComment(features = {}) {
    const normalized = normalizeContentFeatures(features);
    const formatName = normalized.format === DOC_FORMAT_PLAINTEXT ? 'txt' : 'md';
    return `${CONTENT_COMMENT_PREFIX}:${formatName}${normalized.history ? ',history' : ''}`;
}

function parseContentFeatureComment(comment = '') {
    const trimmed = String(comment || '').trim();
    const lower = trimmed.toLowerCase();

    for (const prefix of CONTENT_COMMENT_PREFIXES) {
        const marker = `${prefix.toLowerCase()}:`;
        if (!lower.startsWith(marker)) continue;
        return normalizeContentFeatures(parseContentFeatureString(trimmed.slice(marker.length)));
    }

    return { format: '', history: false };
}

function generateDocumentTableSQL(appName, schema = CONTENT_SCHEMA) {
    return `CREATE TABLE ${quoteDbTable(schema, appName)} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename TEXT NOT NULL,
    filetype TEXT NOT NULL DEFAULT 'file' CHECK (filetype IN ('file', 'directory')),
    title TEXT,
    author TEXT,
    headers JSONB DEFAULT '{}'::jsonb,
    body TEXT,
    encoding TEXT NOT NULL DEFAULT 'utf8' CHECK (encoding IN ('utf8', 'base64')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(filename, filetype)
)`;
}

function generateTextTableSQL(appName, schema = CONTENT_SCHEMA) {
    return `CREATE TABLE ${quoteDbTable(schema, appName)} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename TEXT NOT NULL,
    filetype TEXT NOT NULL DEFAULT 'file' CHECK (filetype IN ('file', 'directory')),
    body TEXT,
    encoding TEXT NOT NULL DEFAULT 'utf8' CHECK (encoding IN ('utf8', 'base64')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(filename, filetype)
)`;
}

function generateContentViewSQL(viewSchema, viewName, tableSchema, tableName) {
    return `CREATE VIEW ${quoteDbTable(viewSchema, viewName)} AS SELECT * FROM ${quoteDbTable(tableSchema, tableName)}`;
}

function generateContentViewCommentSQL(viewSchema, viewName, features = {}) {
    return `COMMENT ON VIEW ${quoteDbTable(viewSchema, viewName)} IS ${quoteSqlLiteral(contentFeatureComment(features))}`;
}

function generateModifiedAtTriggerSQL(appName, schema = CONTENT_SCHEMA) {
    const funcName = `${quoteDbIdent(schema)}.${quoteDbIdent(`set_${appName}_modified_at`)}`;
    return [
        `CREATE OR REPLACE FUNCTION ${funcName}()
RETURNS TRIGGER AS $$
BEGIN
    NEW.modified_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
        `CREATE TRIGGER ${quoteDbIdent(`trg_${appName}_modified_at`)}
    BEFORE UPDATE ON ${quoteDbTable(schema, appName)}
    FOR EACH ROW EXECUTE FUNCTION ${funcName}()`,
    ];
}

function generateContentHistorySQL(appName, features = {}, schema = CONTENT_SCHEMA) {
    const normalized = normalizeContentFeatures(features);
    const isMarkdown = normalized.format !== DOC_FORMAT_PLAINTEXT;
    const historyTable = `${appName}_history`;
    const qualifiedSource = quoteDbTable(schema, appName);
    const qualifiedHistory = quoteDbTable(schema, historyTable);
    const formatColumns = isMarkdown ? '\n    title TEXT,\n    author TEXT,\n    headers JSONB,' : '';
    const insertColumns = isMarkdown
        ? 'id, filename, filetype, title, author, headers, body, encoding, created_at, modified_at'
        : 'id, filename, filetype, body, encoding, created_at, modified_at';
    const insertValues = isMarkdown
        ? `OLD.id, OLD.filename, OLD.filetype, OLD.title, OLD.author, OLD.headers, OLD.body,
         OLD.encoding, OLD.created_at, OLD.modified_at`
        : `OLD.id, OLD.filename, OLD.filetype, OLD.body,
         OLD.encoding, OLD.created_at, OLD.modified_at`;
    const funcName = `${quoteDbIdent(schema)}.${quoteDbIdent(`archive_${historyTable}`)}`;

    return [
        `CREATE TABLE ${qualifiedHistory} (
    id UUID,
    filename TEXT NOT NULL,
    filetype TEXT,${formatColumns}
    body TEXT,
    encoding TEXT,
    created_at TIMESTAMPTZ,
    modified_at TIMESTAMPTZ,
    _history_id UUID NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    _operation TEXT NOT NULL
)`,
        `CREATE INDEX ${quoteDbIdent(`idx_${historyTable}_by_filename`)} ON ${qualifiedHistory} (filename, _history_id DESC)`,
        `CREATE INDEX ${quoteDbIdent(`idx_${historyTable}_by_id`)} ON ${qualifiedHistory} (id, _history_id DESC)`,
        `CREATE OR REPLACE FUNCTION ${funcName}() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO ${qualifiedHistory}
        (${insertColumns},
         _history_id, _operation)
    VALUES
        (${insertValues},
         uuidv7(), TG_OP::text);
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
        `CREATE TRIGGER ${quoteDbIdent(`trg_${historyTable}_archive`)}
    BEFORE UPDATE OR DELETE ON ${qualifiedSource}
    FOR EACH ROW EXECUTE FUNCTION ${funcName}()`,
        `SELECT create_hypertable(${quoteSqlLiteral(`${schema}.${historyTable}`)}, '_history_id', chunk_time_interval => INTERVAL '1 month')`,
        `ALTER TABLE ${qualifiedHistory} SET (timescaledb.compress, timescaledb.compress_segmentby = 'filename', timescaledb.compress_orderby = '_history_id DESC')`,
        `SELECT add_compression_policy(${quoteSqlLiteral(`${schema}.${historyTable}`)}, compress_after => INTERVAL '1 day')`,
    ];
}

function generateContentStoreSQL(viewSchema, appName, features = {}, schema = CONTENT_SCHEMA) {
    const normalized = normalizeContentFeatures(features);
    const tableSQL = normalized.format === DOC_FORMAT_PLAINTEXT
        ? generateTextTableSQL(appName, schema)
        : generateDocumentTableSQL(appName, schema);
    const statements = [
        `CREATE SCHEMA IF NOT EXISTS ${quoteDbIdent(schema)}`,
        tableSQL,
        generateContentViewSQL(viewSchema, appName, schema, appName),
        generateContentViewCommentSQL(viewSchema, appName, normalized),
        ...generateModifiedAtTriggerSQL(appName, schema),
    ];

    if (normalized.history) {
        statements.push(...generateContentHistorySQL(appName, normalized, schema));
    }

    return statements;
}

function generateContentHistoryOnlySQL(viewSchema, appName, existingFeatures = {}, schema = CONTENT_SCHEMA) {
    const normalized = normalizeContentFeatures(Object.assign({}, existingFeatures, { history: true }));
    return [
        generateContentViewCommentSQL(viewSchema, appName, normalized),
        ...generateContentHistorySQL(appName, normalized, schema),
    ];
}

async function execContentDb(db, sql, params = []) {
    if (!db) throw new Error('Database client is not available');
    if (typeof db.exec === 'function') return db.exec(sql, params);
    if (typeof db.query === 'function') return db.query(sql, params);
    if (typeof db === 'function') return db(sql, params);
    throw new Error('Database client must expose exec(sql, params), query(sql, params), or be a query function');
}

async function queryContentDb(db, sql, params = []) {
    const result = await execContentDb(db, sql, params);
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.rows)) return result.rows;
    return [];
}

async function contentTableExists(db, schema, table) {
    const rows = await queryContentDb(
        db,
        `SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = $2
        ) AS exists`,
        [schema, table],
    );
    return !!(rows[0] && rows[0].exists);
}

async function databaseExtensionExists(db, extensionName) {
    const rows = await queryContentDb(
        db,
        'SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists',
        [extensionName],
    );
    return !!(rows[0] && rows[0].exists);
}

function contentAppFromSyncPath(syncRel) {
    const normalized = path.posix.normalize(String(syncRel || '').replace(/\\/g, '/').replace(/^\/+/, ''));
    if (!normalized || normalized === '.' || normalized.startsWith('../')) return null;
    const parts = normalized.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[0] : null;
}

function contentFilenameFromSyncPath(syncRel) {
    const normalized = path.posix.normalize(String(syncRel || '').replace(/\\/g, '/').replace(/^\/+/, ''));
    if (!normalized || normalized === '.' || normalized.startsWith('../')) return null;
    const parts = normalized.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(1).join('/') : null;
}

function validateContentAppName(appName) {
    const value = String(appName || '').trim();
    if (!value) throw new Error('Content app name is empty');
    if (value === '.' || value === '..' || value.includes('/')) {
        throw new Error(`Invalid content app name: ${value}`);
    }
    if (value.startsWith('.')) {
        throw new Error(`Content app names cannot be control paths: ${value}`);
    }
    return value;
}

function collectContentAppsFromSyncFiles(syncRelPaths) {
    const apps = new Set();
    const rootFiles = [];
    for (const rel of syncRelPaths || []) {
        const appName = contentAppFromSyncPath(rel);
        if (!appName) {
            if (rel) rootFiles.push(rel);
            continue;
        }
        apps.add(validateContentAppName(appName));
    }
    return {
        apps: [...apps].sort(),
        rootFiles,
    };
}

async function ensureContentStoreInitialized(db, options = {}) {
    const schema = options.schema || CONTENT_SCHEMA;
    const viewSchema = options.viewSchema || 'public';
    const appName = options.appName || 'wiki';
    const features = normalizeContentFeatures(options.features || { format: DOC_FORMAT_MARKDOWN, history: true });

    if (await contentTableExists(db, schema, appName)) {
        if (features.history && !(await contentTableExists(db, schema, `${appName}_history`))) {
            if (!(await databaseExtensionExists(db, 'timescaledb'))) {
                throw new Error('History requires the TimescaleDB extension, matching the original .build history behavior.');
            }
            const statements = generateContentHistoryOnlySQL(viewSchema, appName, features, schema);
            for (const statement of statements) {
                await execContentDb(db, statement);
            }
            return { created: false, historyAdded: true, statements };
        }
        return { created: false, historyAdded: false, statements: [] };
    }

    if (features.history && !(await databaseExtensionExists(db, 'timescaledb'))) {
        throw new Error('History requires the TimescaleDB extension, matching the original .build history behavior.');
    }

    const statements = generateContentStoreSQL(viewSchema, appName, features, schema);
    for (const statement of statements) {
        await execContentDb(db, statement);
    }

    return { created: true, historyAdded: !!features.history, statements };
}

async function ensureContentAppsForPush(db, syncRelPaths, options = {}) {
    const schema = options.schema || CONTENT_SCHEMA;
    const viewSchema = options.viewSchema || 'public';
    const features = normalizeContentFeatures(options.features || { format: DOC_FORMAT_MARKDOWN, history: true });
    const { apps, rootFiles } = collectContentAppsFromSyncFiles(syncRelPaths);
    if (rootFiles.length) {
        throw new Error(`Cannot push files at the sync root without an app folder: ${rootFiles.join(', ')}`);
    }

    const results = [];
    for (const appName of apps) {
        const result = await ensureContentStoreInitialized(db, {
            schema,
            viewSchema,
            appName,
            features,
        });
        results.push({ appName, ...result });
    }
    return results;
}

function findRoleColumn(columnNames, candidates) {
    for (const candidate of candidates) {
        const match = columnNames.find(column => String(column).toLowerCase() === candidate);
        if (match) return match;
    }
    return '';
}

function detectDocumentColumnRoles(columnNames, options = {}) {
    const format = options.format === DOC_FORMAT_PLAINTEXT ? DOC_FORMAT_PLAINTEXT : DOC_FORMAT_MARKDOWN;
    const primaryKey = options.primaryKey || 'id';
    const roles = {
        filename: findRoleColumn(columnNames, DOC_FILENAME_COLUMNS),
        body: findRoleColumn(columnNames, DOC_BODY_COLUMNS),
        primaryKey,
        modifiedAt: findRoleColumn(columnNames, DOC_MODIFIED_AT_COLUMNS),
        createdAt: findRoleColumn(columnNames, DOC_CREATED_AT_COLUMNS),
        extraHeaders: findRoleColumn(columnNames, DOC_EXTRA_HEADERS_COLUMNS),
        encoding: findRoleColumn(columnNames, DOC_ENCODING_COLUMNS),
        filetype: findRoleColumn(columnNames, DOC_FILETYPE_COLUMNS),
        frontmatter: [],
    };

    if (!roles.filename) throw new Error(`No filename column found. Expected one of: ${DOC_FILENAME_COLUMNS.join(', ')}`);
    if (!roles.body) throw new Error(`No body column found. Expected one of: ${DOC_BODY_COLUMNS.join(', ')}`);

    if (format === DOC_FORMAT_MARKDOWN) {
        const excluded = new Set([
            roles.filename,
            roles.body,
            roles.primaryKey,
            roles.modifiedAt,
            roles.createdAt,
            roles.extraHeaders,
            roles.encoding,
            roles.filetype,
        ].filter(Boolean).map(value => String(value).toLowerCase()));
        roles.frontmatter = columnNames.filter(column => !excluded.has(String(column).toLowerCase()));
    }

    return roles;
}

function rowFromColumns(columns, values) {
    const row = Object.create(null);
    columns.forEach((column, index) => {
        row[column] = values[index];
    });
    return row;
}

function renderYamlScalar(value, indent = '') {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        return `\n${value.map(item => {
            const rendered = renderYamlScalar(item, `${indent}  `);
            return `${indent}- ${rendered ?? 'null'}`;
        }).join('\n')}`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        if (!keys.length) return '{}';
        return `\n${keys.map(key => {
            const rendered = renderYamlScalar(value[key], `${indent}  `);
            if (rendered && rendered.startsWith('\n')) return `${indent}${key}:${rendered}`;
            return `${indent}${key}: ${rendered ?? 'null'}`;
        }).join('\n')}`;
    }
    return JSON.stringify(String(value));
}

function synthesizeDocumentMarkdown(columns, values, roles) {
    if (!Array.isArray(columns) || !Array.isArray(values) || columns.length !== values.length) {
        throw new Error('Column/value count mismatch while synthesizing document markdown');
    }

    const row = rowFromColumns(columns, values);
    const frontmatterLines = [];

    for (const column of roles.frontmatter || []) {
        const rendered = renderYamlScalar(row[column]);
        if (rendered === null) continue;
        if (rendered.startsWith('\n')) frontmatterLines.push(`${column}:${rendered}`);
        else frontmatterLines.push(`${column}: ${rendered}`);
    }

    if (roles.extraHeaders && row[roles.extraHeaders] && typeof row[roles.extraHeaders] === 'object') {
        for (const key of Object.keys(row[roles.extraHeaders]).sort()) {
            const rendered = renderYamlScalar(row[roles.extraHeaders][key]);
            if (rendered === null) continue;
            if (rendered.startsWith('\n')) frontmatterLines.push(`${key}:${rendered}`);
            else frontmatterLines.push(`${key}: ${rendered}`);
        }
    }

    const parts = [];
    if (frontmatterLines.length) {
        parts.push('---', ...frontmatterLines, '---', '');
    }
    if (row[roles.body]) {
        parts.push(String(row[roles.body]));
    }
    return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

function splitDocumentFrontmatter(content) {
    const source = String(content || '');
    if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
        return { frontmatter: '', body: source };
    }

    const opening = source.startsWith('---\r\n') ? '\r\n' : '\n';
    const rest = source.slice(3 + opening.length);
    let closingMarker = '\n---\n';
    let closingIndex = rest.indexOf(closingMarker);

    if (closingIndex === -1) {
        closingMarker = '\r\n---\r\n';
        closingIndex = rest.indexOf(closingMarker);
    }

    if (closingIndex === -1) {
        if (rest.endsWith('\n---')) {
            closingMarker = '\n---';
            closingIndex = rest.length - closingMarker.length;
        } else if (rest.endsWith('\r\n---')) {
            closingMarker = '\r\n---';
            closingIndex = rest.length - closingMarker.length;
        } else {
            return { frontmatter: '', body: source };
        }
    }

    let body = rest.slice(closingIndex + closingMarker.length);
    body = body.replace(/^\r?\n/, '');
    body = body.replace(/^\r?\n/, '');

    return {
        frontmatter: rest.slice(0, closingIndex),
        body,
    };
}

function isUtf8Buffer(buf) {
    const source = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
    return Buffer.from(source.toString('utf8'), 'utf8').equals(source);
}

function parseMarkdownDocument(content) {
    const source = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
    const { frontmatter, body } = splitDocumentFrontmatter(source);
    if (!frontmatter) return { frontmatter: {}, body: source };

    let parsed = {};
    try {
        parsed = YAML.parse(frontmatter) ?? {};
    } catch (error) {
        throw new Error(`Failed to parse YAML frontmatter: ${error.message}`);
    }

    if (parsed === null) parsed = {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Markdown frontmatter must be a YAML object.');
    }

    return { frontmatter: parsed, body };
}

function mapParsedMarkdownToColumns(parsed, roles) {
    const rowData = {
        [roles.body]: parsed.body,
    };
    const knownFrontmatter = new Map((roles.frontmatter || []).map(column => [String(column).toLowerCase(), column]));
    const assigned = new Set();
    const extraHeaders = {};

    for (const [key, value] of Object.entries(parsed.frontmatter || {})) {
        const matchedColumn = knownFrontmatter.get(String(key).toLowerCase());
        if (matchedColumn) {
            rowData[matchedColumn] = value;
            assigned.add(matchedColumn);
            continue;
        }
        if (roles.extraHeaders) {
            extraHeaders[key] = value;
            continue;
        }
        throw new Error(`Unknown frontmatter key "${key}" (valid keys: ${(roles.frontmatter || []).join(', ')})`);
    }

    for (const column of roles.frontmatter || []) {
        if (!assigned.has(column)) rowData[column] = null;
    }

    if (roles.extraHeaders) rowData[roles.extraHeaders] = extraHeaders;
    return rowData;
}

function parseDocumentBufferToRow(buf, appMeta) {
    if (!appMeta) throw new Error('Remote app metadata is required');
    const source = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');

    if (appMeta.format === DOC_FORMAT_PLAINTEXT) {
        const utf8 = isUtf8Buffer(source);
        if (!utf8 && !appMeta.roles.encoding) {
            throw new Error(`Plain-text pushes require an encoding column for non-UTF-8 content: ${appMeta.appName}`);
        }

        const rowData = {
            [appMeta.roles.body]: utf8 ? source.toString('utf8') : source.toString('base64'),
        };
        if (appMeta.roles.encoding) rowData[appMeta.roles.encoding] = utf8 ? 'utf8' : 'base64';
        return rowData;
    }

    if (!isUtf8Buffer(source)) {
        throw new Error(`Markdown pushes require UTF-8 content: ${appMeta.appName}`);
    }

    const rowData = mapParsedMarkdownToColumns(parseMarkdownDocument(source.toString('utf8')), appMeta.roles);
    if (appMeta.roles.encoding) rowData[appMeta.roles.encoding] = 'utf8';
    return rowData;
}

function listParentDirectoryPaths(filename) {
    const parts = String(filename || '').split('/').filter(Boolean);
    const parents = [];
    for (let index = 1; index < parts.length; index += 1) {
        parents.push(parts.slice(0, index).join('/'));
    }
    return parents;
}

function historyIdToVersionId(historyId) {
    const compact = String(historyId || '').replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(compact)) return '';

    try {
        const millis = Number(BigInt(`0x${compact.slice(0, 12)}`));
        const date = new Date(millis);
        if (Number.isNaN(date.getTime())) return '';
        const pad = value => String(value).padStart(2, '0');
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
            + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
    } catch {
        return '';
    }
}

const CONTENT_STORE = Object.freeze({
    schema: CONTENT_SCHEMA,
    formats: Object.freeze({
        markdown: DOC_FORMAT_MARKDOWN,
        text: DOC_FORMAT_PLAINTEXT,
    }),
    quoteIdent: quoteDbIdent,
    quoteLiteral: quoteSqlLiteral,
    quoteTable: quoteDbTable,
    parseFormatName: parseDocumentFormatName,
    parseFeatureString: parseContentFeatureString,
    normalizeFeatures: normalizeContentFeatures,
    featureComment: contentFeatureComment,
    parseFeatureComment: parseContentFeatureComment,
    generateDocumentTableSQL,
    generateTextTableSQL,
    generateViewSQL: generateContentViewSQL,
    generateViewCommentSQL: generateContentViewCommentSQL,
    generateModifiedAtTriggerSQL,
    generateHistorySQL: generateContentHistorySQL,
    generateHistoryOnlySQL: generateContentHistoryOnlySQL,
    generateStoreSQL: generateContentStoreSQL,
    exec: execContentDb,
    query: queryContentDb,
    tableExists: contentTableExists,
    extensionExists: databaseExtensionExists,
    appFromSyncPath: contentAppFromSyncPath,
    filenameFromSyncPath: contentFilenameFromSyncPath,
    collectAppsFromSyncFiles: collectContentAppsFromSyncFiles,
    ensureInitialized: ensureContentStoreInitialized,
    ensureAppsForPush: ensureContentAppsForPush,
    detectColumnRoles: detectDocumentColumnRoles,
    synthesizeMarkdown: synthesizeDocumentMarkdown,
    splitFrontmatter: splitDocumentFrontmatter,
});

function requirePostgresModule() {
    try {
        return require('pg');
    } catch (error) {
        throw new Error([
            'The PostgreSQL client dependency "pg" is not installed for this plugin.',
            'Run npm install in the plugin folder, then reload Obsidian.',
            `Original error: ${error.message}`,
        ].join('\n'));
    }
}

function isDatabaseConnectivityError(error) {
    if (!error) return false;
    const code = String(error.code || '').trim();
    if (code.startsWith('08') || DB_CONNECTION_ERROR_CODES.has(code)) return true;

    const message = String(error.message || error || '').toLowerCase();
    return [
        'connection terminated',
        'connection timeout',
        'connection refused',
        'connection reset',
        'connection closed',
        'client has encountered a connection error',
        'terminating connection',
        'server closed the connection',
        'socket hang up',
        'read econnreset',
        'write epipe',
        'timeout exceeded when trying to connect',
    ].some(needle => message.includes(needle));
}

class DirectDatabaseConnection {
    constructor(plugin) {
        this.plugin = plugin;
        this.pool = null;
        this.unhealthyError = null;
    }

    async connect() {
        if (this.pool) return;

        const { Pool } = requirePostgresModule();
        const connectionOptions = await this.plugin.buildConnection();
        this.plugin.lastResolvedConnectionOptions = { ...connectionOptions };
        const options = {
            ...connectionOptions,
            application_name: this.plugin.connectionApplicationName('query'),
            max: 4,
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
        };

        const pool = new Pool(options);
        pool.on('error', error => this.markUnhealthy(error, 'Database connection lost.'));
        try {
            await pool.query('SELECT 1');
            this.pool = pool;
            this.unhealthyError = null;
        } catch (error) {
            await pool.end().catch(() => {});
            throw error;
        }
    }

    markUnhealthy(error, context = 'Database connection failed.') {
        this.unhealthyError = error || new Error(context);
        if (typeof this.plugin.handleDatabaseConnectionFailure === 'function') {
            this.plugin.handleDatabaseConnectionFailure(this.unhealthyError, context);
        }
    }

    async query(sql, params = []) {
        if (!this.pool) throw new Error('Database is not connected');
        try {
            return await this.pool.query(sql, params);
        } catch (error) {
            if (isDatabaseConnectivityError(error)) {
                this.markUnhealthy(error, 'Database query failed because the connection was lost.');
            }
            throw error;
        }
    }

    async exec(sql, params = []) {
        return this.query(sql, params);
    }

    async disconnect() {
        if (!this.pool) return false;
        const pool = this.pool;
        this.pool = null;
        this.unhealthyError = null;
        await pool.end();
        return true;
    }

    disconnectSync() {
        const pool = this.pool;
        this.pool = null;
        this.unhealthyError = null;
        if (pool) void pool.end().catch(() => {});
    }

    isConnected() {
        return !!this.pool && !this.unhealthyError;
    }
}

function parseLocalConnectionString(value) {
    const connStr = typeof value === 'string' ? value.trim() : '';
    if (!connStr) {
        return {
            value: '',
            strippedPassword: false,
            user: '',
            host: '',
            port: '',
            database: '',
            disableSsl: false,
        };
    }

    try {
        const parsed = new url.URL(connStr);
        if (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') {
            const strippedPassword = !!parsed.password;
            if (parsed.password) parsed.password = '';
            return {
                value: parsed.toString(),
                strippedPassword,
                user: decodeURIComponent(parsed.username || ''),
                host: parsed.hostname || '',
                port: parsed.port || '',
                database: decodeURIComponent((parsed.pathname || '').replace(/^\/+/, '')),
                disableSsl: parsed.searchParams.get('sslmode') === 'disable',
            };
        }
    } catch {}

    const strippedValue = connStr.replace(
        /^(postgres(?:ql)?:\/\/[^:/?#@\s]+):[^@/?#\s]*@/i,
        '$1@'
    );
    return {
        value: strippedValue,
        strippedPassword: strippedValue !== connStr,
        user: '',
        host: '',
        port: '',
        database: '',
        disableSsl: false,
    };
}

function buildLocalConnectionString(settings) {
    const user = typeof settings.localDbUser === 'string' ? settings.localDbUser.trim() : '';
    const host = typeof settings.localDbHost === 'string' ? settings.localDbHost.trim() : '';
    const port = typeof settings.localDbPort === 'string' ? settings.localDbPort.trim() : '';
    const database = typeof settings.localDbName === 'string' ? settings.localDbName.trim() : '';

    if (!user || !host || !database) return '';

    const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const portPart = port ? `:${port}` : '';
    return `postgres://${encodeURIComponent(user)}@${hostPart}${portPart}/${encodeURIComponent(database)}`;
}

function formatLocalDatabaseTarget(settings) {
    const user = typeof settings.localDbUser === 'string' ? settings.localDbUser.trim() : '';
    const host = typeof settings.localDbHost === 'string' ? settings.localDbHost.trim() : '';
    const port = typeof settings.localDbPort === 'string' ? settings.localDbPort.trim() : '';
    const database = typeof settings.localDbName === 'string' ? settings.localDbName.trim() : '';

    if (!database && !host && !user) return '(not configured)';

    const hostPart = host || 'unknown-host';
    const portPart = port ? `:${port}` : '';
    const dbPart = database || '(database not set)';
    const userPart = user || '(user not set)';
    return `${dbPart} on ${hostPart}${portPart} as ${userPart}`;
}

function normalizeSettings(rawSettings = {}) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const settings = Object.assign({}, DEFAULT_SETTINGS);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.prototype.hasOwnProperty.call(source, key)) settings[key] = source[key];
    }
    settings.oidcDbUser = typeof source.oidcDbUser === 'string' && source.oidcDbUser.trim()
        ? source.oidcDbUser.trim()
        : DEFAULT_SETTINGS.oidcDbUser;
    settings.oidcDbName = typeof source.oidcDbName === 'string' && source.oidcDbName.trim()
        ? source.oidcDbName.trim()
        : DEFAULT_SETTINGS.oidcDbName;
    settings.syncSubdir = typeof source.syncSubdir === 'string' && source.syncSubdir.trim()
        ? source.syncSubdir.trim()
        : DEFAULT_SETTINGS.syncSubdir;
    settings.autoSync = typeof source.autoSync === 'boolean'
        ? source.autoSync
        : DEFAULT_SETTINGS.autoSync;
    const localConnStr = parseLocalConnectionString(source.localConnStr);
    settings.localDbUser = typeof source.localDbUser === 'string' && source.localDbUser.trim()
        ? source.localDbUser.trim()
        : (localConnStr.user || DEFAULT_SETTINGS.localDbUser);
    settings.localDbHost = typeof source.localDbHost === 'string' && source.localDbHost.trim()
        ? source.localDbHost.trim()
        : (localConnStr.host || DEFAULT_SETTINGS.localDbHost);
    settings.localDbPort = typeof source.localDbPort === 'string' && source.localDbPort.trim()
        ? source.localDbPort.trim()
        : (localConnStr.port || DEFAULT_SETTINGS.localDbPort);
    settings.localDbName = typeof source.localDbName === 'string'
        ? source.localDbName.trim()
        : localConnStr.database;
    settings.localDisableSsl = typeof source.localDisableSsl === 'boolean'
        ? source.localDisableSsl
        : localConnStr.disableSsl;
    settings.localConnStr = buildLocalConnectionString(settings) || localConnStr.value;
    settings.localPasswordSecret = typeof settings.localPasswordSecret === 'string'
        ? settings.localPasswordSecret.trim()
        : '';
    settings.scaffoldProfile = Object.prototype.hasOwnProperty.call(AI_SCAFFOLD_PROFILES, settings.scaffoldProfile)
        ? settings.scaffoldProfile
        : DEFAULT_AI_SCAFFOLD_PROFILE;
    return { settings, strippedLocalConnPassword: localConnStr.strippedPassword };
}

function buildPersistedSettings(rawSettings = {}) {
    const { settings } = normalizeSettings(rawSettings);
    return {
        authMode: settings.authMode,
        oidcWellKnown: settings.oidcWellKnown,
        oidcClientId: settings.oidcClientId,
        oidcClientSecret: settings.oidcClientSecret,
        oidcRedirectUri: settings.oidcRedirectUri,
        proxyHost: settings.proxyHost,
        listenPort: settings.listenPort,
        oidcDbUser: settings.oidcDbUser,
        oidcDbName: settings.oidcDbName,
        localDbUser: settings.localDbUser,
        localDbHost: settings.localDbHost,
        localDbPort: settings.localDbPort,
        localDbName: settings.localDbName,
        localDisableSsl: settings.localDisableSsl,
        localConnStr: settings.localConnStr,
        localPasswordSecret: settings.localPasswordSecret,
        syncSubdir: settings.syncSubdir,
        autoSync: settings.autoSync,
        scaffoldProfile: settings.scaffoldProfile,
    };
}

function readAiScaffoldTemplate(templateDir, relativeTemplatePath) {
    const templatePath = path.join(templateDir, relativeTemplatePath);
    try {
        return fs.readFileSync(templatePath, 'utf8');
    } catch (error) {
        throw new Error(`Missing AI scaffold template: ${relativeTemplatePath} (${error.message})`);
    }
}

function getAiScaffoldProfile(id) {
    return AI_SCAFFOLD_PROFILES[id] || AI_SCAFFOLD_PROFILES[DEFAULT_AI_SCAFFOLD_PROFILE];
}

function buildAiScaffoldTargets(profile) {
    return [
        { templatePath: 'AGENTS.md', targetPath: 'AGENTS.md' },
        { templatePath: 'CLAUDE.md', targetPath: 'CLAUDE.md' },
        { templatePath: 'GEMINI.md', targetPath: 'GEMINI.md' },
        ...AI_SCAFFOLD_VAULT_SKILL_ROOTS.flatMap(root =>
            profile.skillNames.map(name => ({
                templatePath: path.join('skills', name, 'SKILL.md'),
                targetPath: path.join(root.path, name, 'SKILL.md'),
                frontmatter: root.frontmatter ? { name } : null,
            }))),
    ];
}

function renderBulletList(items, formatter) {
    return items.map(formatter).join('\n');
}

function renderAiScaffoldTemplate(templateContent, profile, syncRoot = DEFAULT_SETTINGS.syncSubdir) {
    const replacements = {
        PROFILE_NAME: profile.label,
        PROFILE_DESCRIPTION: profile.description,
        SYNC_ROOT: syncRoot,
        SKILL_NAME_LIST: renderBulletList(profile.skillNames, name => `- \`${name}\``),
        CLAUDE_SKILL_PATHS: renderBulletList(profile.skillNames, name => `- \`.claude/skills/${name}/SKILL.md\``),
        CODEX_SKILL_PATHS: renderBulletList(profile.skillNames, name => `- \`.agents/skills/${name}/SKILL.md\``),
        WIKI_ROUTING_EXTRA: profile.skillNames.includes('oncall')
            ? '- incident and roster work -> `oncall`'
            : '',
    };

    return Object.entries(replacements).reduce(
        (content, [key, value]) => content.split(`{{${key}}}`).join(value),
        templateContent,
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Authentication: OIDC + PKCE
// ═══════════════════════════════════════════════════════════════════════════════

const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // allow self-signed

function b64url(buf) {
    return buf.toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function pkce() {
    const verifier  = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function oidcDiscover(wellKnownUrl) {
    return new Promise((resolve, reject) => {
        const req = https.get(wellKnownUrl, { agent: httpsAgent }, res => {
            let data = '';
            res.on('data', d => { data += d; });
            res.on('end', () => {
                try {
                    const cfg = JSON.parse(data);
                    resolve({ authEndpoint: cfg.authorization_endpoint, tokenEndpoint: cfg.token_endpoint });
                } catch (e) { reject(new Error(`Bad well-known response: ${e.message}`)); }
            });
        });
        req.on('error', reject);
    });
}

function postForm(endpoint, params) {
    return new Promise((resolve, reject) => {
        const body   = new url.URLSearchParams(params).toString();
        const parsed = new url.URL(endpoint);
        const isHttps = parsed.protocol === 'https:';
        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname + parsed.search,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
            ...(isHttps ? { agent: httpsAgent } : {}),
        };
        const req = (isHttps ? https : http).request(options, res => {
            let data = '';
            res.on('data', d => { data += d; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Bad token response: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function openBrowser(loginUrl) {
    // Pass URL directly to Start-Process — uses the Windows default browser for URLs,
    // not the HTML file handler (which may be Firefox).
    // Single quotes in the URL are escaped for PowerShell.
    const safeUrl = loginUrl.replace(/'/g, "''");
    try {
        execSync(`powershell.exe -NoProfile -Command "Start-Process '${safeUrl}'"`, { stdio: 'ignore' });
        return;
    } catch {}
    // Fallback: native Linux desktop
    try { execSync(`xdg-open "${loginUrl}"`, { stdio: 'ignore' }); } catch {}
}

/**
 * Run OIDC PKCE flow — opens browser, waits for callback.
 * Returns Promise<string> (access_token).
 */
function getOidcToken({ wellKnownUrl, clientId, clientSecret, redirectUri,
                        scopes = 'openid profile email groups' }) {
    return new Promise((resolve, reject) => {
        (async () => {
            const { authEndpoint, tokenEndpoint } = await oidcDiscover(wellKnownUrl);
            const { verifier, challenge } = pkce();
            const state        = b64url(crypto.randomBytes(16));
            const callbackPort = parseInt(new url.URL(redirectUri).port) || 8080;

            const params = new url.URLSearchParams({
                response_type: 'code', client_id: clientId,
                redirect_uri: redirectUri, scope: scopes, state,
                code_challenge: challenge, code_challenge_method: 'S256',
            });
            const loginUrl = `${authEndpoint}?${params}`;

            let done = false;
            const server = http.createServer((req, res) => {
                const parsed = new url.URL(req.url, `http://localhost:${callbackPort}`);
                const code   = parsed.searchParams.get('code');
                const error  = parsed.searchParams.get('error');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(code
                    ? '<h2>Authenticated &#x2714; &mdash; close this tab.</h2>'
                    : '<h2>Authentication failed.</h2>');
                server.close(() => {
                    if (done) return;
                    done = true;
                    if (error) { reject(new Error(`Auth error: ${error}`)); return; }
                    if (!code)  { reject(new Error('No auth code received'));  return; }
                    postForm(tokenEndpoint, {
                        grant_type: 'authorization_code', code,
                        redirect_uri: redirectUri, client_id: clientId,
                        client_secret: clientSecret, code_verifier: verifier,
                    }).then(tok => {
                        if (tok.error) {
                            reject(new Error(`Token error: ${tok.error} — ${tok.error_description || ''}`));
                            return;
                        }
                        resolve(tok.access_token);
                    }).catch(reject);
                });
            });
            server.on('error', reject);
            server.listen(callbackPort, '127.0.0.1', () => openBrowser(loginUrl));
            setTimeout(() => {
                if (!done) { done = true; server.close(); reject(new Error('OIDC auth timed out (5 min)')); }
            }, 5 * 60 * 1000);
        })().catch(reject);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: Note Creation and History Modals
// ═══════════════════════════════════════════════════════════════════════════════

function humanizeTs(ts) {
    const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) return ts;
    return `${m[1]}  ${m[2]}:${m[3]}:${m[4]} UTC`;
}

class WikiConflictModal extends Modal {
    constructor(app, { title, message, leftLabel, rightLabel, leftText, rightText, actions }) {
        super(app);
        this.title = title;
        this.message = message;
        this.leftLabel = leftLabel;
        this.rightLabel = rightLabel;
        this.leftText = leftText;
        this.rightText = rightText;
        this.actions = actions;
        this.resolved = false;
        this.result = 'cancel';
        this.promise = new Promise(resolve => { this._resolve = resolve; });
    }

    openAndWait() {
        this.open();
        return this.promise;
    }

    choose(value) {
        if (this.resolved) return;
        this.resolved = true;
        this.result = value;
        this.close();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.title });
        if (this.message) {
            contentEl.createEl('p', {
                text: this.message,
                cls: 'setting-item-description',
            });
        }

        const columns = contentEl.createDiv();
        columns.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;';

        const renderPane = (parent, label, text) => {
            const wrap = parent.createDiv();
            const heading = wrap.createEl('div', { text: label });
            heading.style.cssText = 'font-weight:600;margin-bottom:6px;';
            const pre = wrap.createEl('pre');
            pre.style.cssText = [
                'max-height:280px',
                'overflow:auto',
                'background:var(--background-secondary)',
                'padding:10px',
                'border-radius:8px',
                'font-size:11px',
                'white-space:pre-wrap',
                'word-break:break-word',
                'border:1px solid var(--background-modifier-border)',
            ].join(';');
            pre.setText(text);
        };

        renderPane(columns, this.leftLabel, this.leftText);
        renderPane(columns, this.rightLabel, this.rightText);

        const buttonRow = contentEl.createDiv();
        buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;';
        for (const action of this.actions) {
            const button = buttonRow.createEl('button', { text: action.label });
            if (action.cta) button.addClass('mod-cta');
            button.addEventListener('click', () => this.choose(action.value));
        }
    }

    onClose() {
        this.contentEl.empty();
        if (!this.resolved) this._resolve('cancel');
        else this._resolve(this.result);
    }
}

class WikiRemoteDeleteConfirmModal extends Modal {
    constructor(app, { paths, highRisk, reason, syncRoot }) {
        super(app);
        this.paths = paths || [];
        this.highRisk = !!highRisk;
        this.reason = reason || '';
        this.syncRoot = syncRoot || 'wiki';
        this.resolved = false;
        this.result = false;
        this.promise = new Promise(resolve => { this._resolve = resolve; });
    }

    openAndWait() {
        this.open();
        return this.promise;
    }

    choose(value) {
        if (this.resolved) return;
        this.resolved = true;
        this.result = !!value;
        this.close();
    }

    onOpen() {
        const { contentEl } = this;
        const deleteCount = this.paths.length;
        contentEl.createEl('h3', { text: this.highRisk ? 'High-Risk Remote Delete' : 'Confirm Remote Delete' });
        contentEl.createEl('p', {
            text: `This push would delete ${deleteCount} file${deleteCount === 1 ? '' : 's'} from the wiki database because they are missing from ${this.syncRoot}/ locally.`,
            cls: 'setting-item-description',
        });

        if (this.reason) {
            const warning = contentEl.createEl('p', { text: this.reason });
            warning.style.cssText = 'color:var(--text-warning);font-weight:600;';
        }

        const preview = contentEl.createEl('pre');
        preview.style.cssText = [
            'max-height:220px',
            'overflow:auto',
            'background:var(--background-secondary)',
            'padding:10px',
            'border-radius:8px',
            'font-size:11px',
            'white-space:pre-wrap',
            'border:1px solid var(--background-modifier-border)',
        ].join(';');
        const shown = this.paths.slice(0, REMOTE_DELETE_PREVIEW_LIMIT);
        const hidden = this.paths.length - shown.length;
        preview.setText(`${shown.join('\n')}${hidden > 0 ? `\n...and ${hidden} more` : ''}`);

        let confirmInput = null;
        if (this.highRisk) {
            contentEl.createEl('p', {
                text: 'Type DELETE to enable the remote delete button.',
                cls: 'setting-item-description',
            });
            confirmInput = contentEl.createEl('input');
            confirmInput.type = 'text';
            confirmInput.placeholder = 'DELETE';
            confirmInput.style.cssText = 'width:100%;margin-top:4px;';
        }

        const buttonRow = contentEl.createDiv();
        buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;';
        const cancelButton = buttonRow.createEl('button', { text: 'Cancel Push' });
        const deleteButton = buttonRow.createEl('button', { text: `Delete ${deleteCount} Remote` });
        deleteButton.addClass('mod-warning');
        deleteButton.disabled = this.highRisk;

        if (confirmInput) {
            confirmInput.addEventListener('input', () => {
                deleteButton.disabled = confirmInput.value.trim() !== 'DELETE';
            });
        }

        cancelButton.addEventListener('click', () => this.choose(false));
        deleteButton.addEventListener('click', () => this.choose(true));
    }

    onClose() {
        this.contentEl.empty();
        this._resolve(this.resolved ? this.result : false);
    }
}

class WikiDiagnosticsModal extends Modal {
    constructor(app, { title, summary, details }) {
        super(app);
        this.title = title;
        this.summary = summary;
        this.details = details;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.title });
        if (this.summary) {
            contentEl.createEl('p', {
                text: this.summary,
                cls: 'setting-item-description',
            });
        }

        const area = contentEl.createEl('textarea');
        area.value = this.details || '';
        area.readOnly = true;
        area.style.cssText = 'width:100%;min-height:320px;margin-top:12px;font-family:var(--font-monospace);font-size:12px;';

        const buttonRow = contentEl.createDiv();
        buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';

        const selectButton = buttonRow.createEl('button', { text: 'Select All' });
        selectButton.addEventListener('click', () => {
            area.focus();
            area.select();
        });

        const copyButton = buttonRow.createEl('button', { text: 'Copy', cls: 'mod-cta' });
        copyButton.addEventListener('click', async () => {
            area.focus();
            area.select();
            try {
                await navigator.clipboard.writeText(area.value);
                new Notice('Wiki diagnostics copied.', 4000);
            } catch {
                try {
                    document.execCommand('copy');
                    new Notice('Wiki diagnostics copied.', 4000);
                } catch {
                    new Notice('Copy failed. Use Select All and copy manually.', 6000);
                }
            }
        });

        setTimeout(() => {
            area.focus();
            area.setSelectionRange(0, 0);
        }, 30);
    }

    onClose() {
        this.contentEl.empty();
    }
}

class WikiHistoryModal extends Modal {
    constructor(app, plugin, file) {
        super(app);
        this.plugin = plugin;
        this.file = file;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'History' });
        const loading = contentEl.createEl('p', {
            text: 'Loading wiki history...',
            cls: 'setting-item-description',
        });
        void this.populate(contentEl, loading);
    }

    onClose() {
        this.contentEl.empty();
    }

    async populate(contentEl, loadingEl) {
        const filePath = typeof this.file === 'string' ? this.file : this.file.path;
        const fileName = path.basename(filePath);

        let snapshots = [];
        try {
            snapshots = await this.plugin.listHistorySnapshotsForFile(filePath);
        } catch (error) {
            loadingEl.setText(`Failed to load history: ${error.message}`);
            return;
        }

        loadingEl.remove();

        if (!snapshots.length) {
            contentEl.createEl('p', {
                text: 'No history snapshots yet — pushes create history entries.',
                cls: 'setting-item-description',
            });
            return;
        }

        contentEl.createEl('p', {
            text: `${snapshots.length} snapshot(s) — click to preview`,
            cls: 'setting-item-description',
        });

        const list = contentEl.createDiv();
        list.style.cssText = [
            'max-height:180px',
            'overflow-y:auto',
            'margin-bottom:10px',
            'border:1px solid var(--background-modifier-border)',
            'border-radius:4px',
        ].join(';');

        const previewWrap = contentEl.createDiv();
        previewWrap.style.display = 'none';

        const previewLabel = previewWrap.createEl('div', { cls: 'setting-item-description' });
        previewLabel.style.marginBottom = '4px';

        const pre = previewWrap.createEl('pre');
        pre.style.cssText = [
            'max-height:260px',
            'overflow-y:auto',
            'background:var(--background-secondary)',
            'padding:8px',
            'border-radius:4px',
            'font-size:11px',
            'white-space:pre-wrap',
            'word-break:break-word',
        ].join(';');

        const btnRow = contentEl.createDiv();
        btnRow.style.cssText = 'margin-top:10px; display:none;';
        const restoreBtn = btnRow.createEl('button', { text: 'Restore this version', cls: 'mod-cta' });

        let selected = null;
        let selectedSnap = null;
        let selectedContent = null;

        for (const snap of snapshots) {
            const row = list.createDiv();
            row.style.cssText = [
                'padding:7px 12px',
                'cursor:pointer',
                'border-bottom:1px solid var(--background-modifier-border)',
                'font-size:13px',
            ].join(';');
            row.setText(humanizeTs(snap));

            row.addEventListener('mouseenter', () => {
                if (selectedSnap !== snap) row.style.background = 'var(--background-modifier-hover)';
            });
            row.addEventListener('mouseleave', () => {
                if (selectedSnap !== snap) row.style.background = '';
            });
            row.addEventListener('click', async () => {
                if (selected) selected.style.background = '';
                row.style.background = 'var(--background-modifier-active-hover)';
                selected = row;
                selectedSnap = snap;
                previewLabel.setText(`Snapshot: ${humanizeTs(snap)}`);
                pre.setText('Loading snapshot…');
                previewWrap.style.display = '';
                btnRow.style.display = '';
                try {
                    selectedContent = await this.plugin.readHistorySnapshotForFile(filePath, snap);
                    pre.setText(selectedContent);
                } catch (error) {
                    selectedContent = null;
                    pre.setText(`Error: ${error.message}`);
                    btnRow.style.display = 'none';
                }
            });
        }

        contentEl.appendChild(previewWrap);
        contentEl.appendChild(btnRow);

        restoreBtn.addEventListener('click', async () => {
            if (!selectedSnap || selectedContent === null || selectedContent === undefined) return;
            try {
                fs.writeFileSync(path.join(this.plugin.vaultPath(), filePath), selectedContent, 'utf8');
                await this.plugin.refreshLocalPath(filePath);
                this.plugin.recomputeState();
                new Notice(`Restored ${fileName} to ${humanizeTs(selectedSnap)}`);
                this.close();
            } catch (error) {
                new Notice(`Restore failed: ${error.message}`, 8000);
            }
        });
    }
}

class InitializeAIScaffoldModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.running = false;
    }

    onOpen() {
        const { contentEl } = this;
        const profile = this.plugin.aiScaffoldProfile();
        const targets = buildAiScaffoldTargets(profile);
        contentEl.createEl('h3', { text: 'Initialize AI scaffold' });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: 'This will create missing scaffold files and refresh existing content only for the plugin-managed AI scaffold paths listed below.',
        });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: 'Other local notes and folders are left unchanged.',
        });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: `Selected scaffold profile: ${profile.label}. ${profile.description}`,
        });

        const rootList = contentEl.createEl('ul');
        rootList.createEl('li', { text: 'Vault-root instruction files: AGENTS.md, CLAUDE.md, GEMINI.md' });
        rootList.createEl('li', { text: `Managed skill set: ${profile.skillNames.join(', ')}` });
        rootList.createEl('li', { text: `Vault command skill entrypoints live under ${AI_SCAFFOLD_VAULT_SKILL_ROOTS.map(r => r.path).join(' and ')}` });

        const targetList = contentEl.createEl('ul');
        for (const target of targets) {
            targetList.createEl('li', { text: target.targetPath });
        }

        const buttonRow = contentEl.createDiv();
        buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;';
        const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
        const initButton = buttonRow.createEl('button', { text: 'Initialize', cls: 'mod-cta' });

        cancelButton.addEventListener('click', () => {
            if (!this.running) this.close();
        });
        initButton.addEventListener('click', async () => {
            if (this.running) return;
            this.running = true;
            cancelButton.disabled = true;
            initButton.disabled = true;
            const ok = await this.plugin.initializeAiScaffold();
            this.running = false;
            cancelButton.disabled = false;
            initButton.disabled = false;
            if (ok) this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: Status Bar and Hover Tooltip
// ═══════════════════════════════════════════════════════════════════════════════

const CONNECT_META = {
    unconfigured: { icon: 'ban', label: 'Connect', dot: '#8a8f98' },
    disconnected: { icon: 'plug', label: 'Connect', dot: '#8a8f98' },
    connecting: { icon: 'loader-2', label: 'Connecting…', dot: '#d6a21d' },
    connected: { icon: 'plug-zap', label: 'Connected', dot: '#2e9f53' },
    error: { icon: 'database-off', label: 'Connect Error', dot: '#d04b4b' },
};

const STATE_META = {
    unconfigured: { icon: 'ban', label: 'Unconfigured', dot: '#8a8f98' },
    'not-cloned': { icon: 'folder-open', label: 'Not Cloned', dot: '#8a8f98' },
    synced: { icon: 'database-zap', label: 'Synced', dot: '#2e9f53' },
    pending: { icon: 'refresh-cw', label: 'Sync Changes', dot: '#d6a21d' },
    syncing: { icon: 'loader-2', label: 'Syncing…', dot: '#d6a21d' },
    review: { icon: 'git-compare', label: 'Review Required', dot: '#d67b1d' },
    error: { icon: 'database-off', label: 'Error', dot: '#d04b4b' },
};

class WikiConnectStatusBarController {
    constructor(plugin) {
        this.plugin = plugin;
        this.item = plugin.addStatusBarItem();
        this.item.classList.add('wiki-sync-status-item', 'wiki-sync-status-item--connect');
        this.item.style.cssText = 'cursor:default;position:relative;display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:6px;';

        this.dotEl = this.item.createEl('span');
        this.dotEl.classList.add('wiki-sync-status-dot');
        this.dotEl.style.cssText = 'width:8px;height:8px;border-radius:999px;display:inline-block;flex:0 0 auto;';

        this.iconEl = this.item.createEl('span');
        this.iconEl.classList.add('wiki-sync-status-icon');
        this.textEl = this.item.createEl('span');
        this.textEl.classList.add('wiki-sync-status-label');

        this.tooltipEl = this.item.createDiv({ cls: 'wiki-sync-status-tooltip' });
        this.tooltipEl.style.cssText = [
            'display:none',
            'position:absolute',
            'right:0',
            'bottom:calc(100% + 8px)',
            'z-index:50',
            'min-width:300px',
            'padding:10px 12px',
            'border-radius:8px',
            'border:1px solid var(--background-modifier-border)',
            'background:var(--background-primary)',
            'box-shadow:0 10px 30px rgba(0,0,0,0.2)',
            'pointer-events:none',
        ].join(';');

        this._handleEnter = () => this.showTooltip();
        this._handleLeave = () => this.hideTooltip();
        this._handleContextMenu = event => {
            event.preventDefault();
            event.stopPropagation();
            this.plugin.showConnectStatusContextMenu(event);
        };
        this.item.addEventListener('mouseenter', this._handleEnter);
        this.item.addEventListener('mouseleave', this._handleLeave);
        this.item.addEventListener('contextmenu', this._handleContextMenu);
    }

    setState(state, label) {
        const meta = CONNECT_META[state] || CONNECT_META.disconnected;
        setIcon(this.iconEl, meta.icon);
        this.iconEl.toggleClass('wiki-sync-spin', state === 'connecting');
        this.textEl.setText(` ${label || meta.label}`);
        this.dotEl.style.background = meta.dot;
        this.item.onclick = async () => this.plugin.handleConnectStatusBarClick(state);

        if (this.isTooltipVisible()) this.refreshTooltip();
    }

    isTooltipVisible() {
        return this.tooltipEl.style.display !== 'none';
    }

    showTooltip() {
        this.refreshTooltip();
        this.tooltipEl.style.display = 'block';
    }

    hideTooltip() {
        this.tooltipEl.style.display = 'none';
    }

    refreshTooltip() {
        renderStatusTooltip(this.tooltipEl, 'Wiki Connection', this.plugin.collectConnectionDetails());
    }

    dispose() {
        this.item.removeEventListener('mouseenter', this._handleEnter);
        this.item.removeEventListener('mouseleave', this._handleLeave);
        this.item.removeEventListener('contextmenu', this._handleContextMenu);
        this.tooltipEl.remove();
        this.item.remove();
    }
}

class WikiStatusBarController {
    constructor(plugin) {
        this.plugin = plugin;
        this.connectionState = 'unconfigured';
        this.item = plugin.addStatusBarItem();
        this.item.classList.add('wiki-sync-status-item', 'wiki-sync-status-item--sync');
        this.item.style.cssText = 'cursor:default;position:relative;display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:6px;';

        this.dotEl = this.item.createEl('span');
        this.dotEl.classList.add('wiki-sync-status-dot');
        this.dotEl.style.cssText = 'width:8px;height:8px;border-radius:999px;display:inline-block;flex:0 0 auto;';

        this.iconEl = this.item.createEl('span');
        this.iconEl.classList.add('wiki-sync-status-icon');
        this.textEl = this.item.createEl('span');
        this.textEl.classList.add('wiki-sync-status-label');

        this.tooltipEl = this.item.createDiv({ cls: 'wiki-sync-status-tooltip' });
        this.tooltipEl.style.cssText = [
            'display:none',
            'position:absolute',
            'right:0',
            'bottom:calc(100% + 8px)',
            'z-index:50',
            'min-width:280px',
            'padding:10px 12px',
            'border-radius:8px',
            'border:1px solid var(--background-modifier-border)',
            'background:var(--background-primary)',
            'box-shadow:0 10px 30px rgba(0,0,0,0.2)',
            'pointer-events:none',
        ].join(';');

        this._handleEnter = () => this.showTooltip();
        this._handleLeave = () => this.hideTooltip();
        this._handleContextMenu = event => {
            event.preventDefault();
            event.stopPropagation();
            this.plugin.showSyncStatusContextMenu(event);
        };
        this.item.addEventListener('mouseenter', this._handleEnter);
        this.item.addEventListener('mouseleave', this._handleLeave);
        this.item.addEventListener('contextmenu', this._handleContextMenu);
    }

    setState(state, label) {
        const meta = STATE_META[state] || STATE_META.unconfigured;
        setIcon(this.iconEl, meta.icon);
        this.iconEl.toggleClass('wiki-sync-spin', state === 'syncing');
        const resolvedLabel = label || meta.label;
        this.textEl.setText(` ${resolvedLabel}`);
        this.dotEl.style.background = meta.dot;
        this.item.onclick = async () => this.plugin.handleStatusBarClick(state);
        this.item.classList.toggle('wiki-sync-status-item--muted', this.connectionState === 'disconnected');

        if (this.isTooltipVisible()) this.refreshTooltip();
    }

    setConnectionState(connectionState) {
        this.connectionState = connectionState || 'unconfigured';
        this.item.classList.toggle('wiki-sync-status-item--muted', this.connectionState === 'disconnected');
    }

    isTooltipVisible() {
        return this.tooltipEl.style.display !== 'none';
    }

    showTooltip() {
        this.refreshTooltip();
        this.tooltipEl.style.display = 'block';
    }

    hideTooltip() {
        this.tooltipEl.style.display = 'none';
    }

    refreshTooltip() {
        this.renderTooltip(this.collectDetails());
    }

    collectDetails() {
        return this.plugin.collectSyncDetails();
    }

    renderTooltip(details) {
        renderStatusTooltip(this.tooltipEl, 'Wiki Sync', details);
    }

    dispose() {
        this.item.removeEventListener('mouseenter', this._handleEnter);
        this.item.removeEventListener('mouseleave', this._handleLeave);
        this.item.removeEventListener('contextmenu', this._handleContextMenu);
        this.tooltipEl.remove();
        this.item.remove();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Import: MarkItDown Detection and Conversion
// ═══════════════════════════════════════════════════════════════════════════════

const SUPPORTED_EXTENSIONS = new Set([
    '.bmp',
    '.docx',
    '.gif',
    '.htm',
    '.html',
    '.jpeg',
    '.jpg',
    '.pdf',
    '.png',
    '.pptx',
    '.tif',
    '.tiff',
    '.webp',
    '.xlsx',
]);

function shellEscape(value) {
    return value.replace(/'/g, `'\\''`);
}

function shellQuote(value) {
    return `'${shellEscape(String(value))}'`;
}

const SYNC_CONTROL_DIRS = new Set([
    '.history',
    '.build',
    '.tables',
    '.schemas',
    '.views',
    '.create',
]);

function isWindowsHost() {
    return process.platform === 'win32';
}

function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function emptyManifest() {
    return {
        version: 1,
        clonedAt: new Date().toISOString(),
        target: null,
        targetHash: '',
        lastPullAt: null,
        lastPushAt: null,
        remoteWatermarks: {},
        entries: {},
    };
}

function normalizeManifestData(rawManifest) {
    const manifest = rawManifest && typeof rawManifest === 'object'
        ? Object.assign({}, rawManifest)
        : emptyManifest();

    if (!manifest.version) manifest.version = 1;
    if (!manifest.clonedAt) manifest.clonedAt = new Date().toISOString();
    if (!Object.prototype.hasOwnProperty.call(manifest, 'target')) manifest.target = null;
    if (!Object.prototype.hasOwnProperty.call(manifest, 'targetHash')) manifest.targetHash = '';
    if (!manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)) {
        manifest.entries = {};
    }
    if (!manifest.remoteWatermarks || typeof manifest.remoteWatermarks !== 'object' || Array.isArray(manifest.remoteWatermarks)) {
        manifest.remoteWatermarks = {};
    }
    if (!Object.prototype.hasOwnProperty.call(manifest, 'lastPullAt')) manifest.lastPullAt = null;
    if (!Object.prototype.hasOwnProperty.call(manifest, 'lastPushAt')) manifest.lastPushAt = null;
    return manifest;
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function manifestTargetHash(target) {
    return sha256Buffer(Buffer.from(stableJson(target), 'utf8'));
}

function latestManifestSyncTimestamp(manifest) {
    const candidates = [manifest?.lastPullAt, manifest?.lastPushAt]
        .filter(value => typeof value === 'string' && value.trim());
    if (!candidates.length) return '';
    return candidates.sort().slice(-1)[0];
}

function normalizeRemoteWatermark(value) {
    const watermark = value && typeof value === 'object' ? value : {};
    return {
        mode: typeof watermark.mode === 'string' ? watermark.mode : 'none',
        value: typeof watermark.value === 'string' ? watermark.value : '',
    };
}

function remoteWatermarkEquals(left, right) {
    const a = normalizeRemoteWatermark(left);
    const b = normalizeRemoteWatermark(right);
    return a.mode === b.mode && a.value === b.value;
}

function safeText(buf) {
    if (!Buffer.isBuffer(buf)) return '';
    return buf.toString('utf8');
}

function* walkLocalSyncFiles(root, relBase = '') {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.name.startsWith('.') || SYNC_CONTROL_DIRS.has(entry.name)) continue;
        const abs = path.join(root, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            yield* walkLocalSyncFiles(abs, rel);
        } else if (entry.isFile()) {
            yield rel;
        }
    }
}

function commandExists(command) {
    if (isWindowsHost()) {
        try {
            execFileSync('where.exe', [command], {
                stdio: 'ignore',
                timeout: 2000,
            });
            return true;
        } catch {
            return false;
        }
    }
    try {
        execFileSync('bash', ['-lc', `command -v ${shellQuote(command)}`], {
            stdio: 'ignore',
            timeout: 2000,
        });
        return true;
    } catch {
        return false;
    }
}

function importEngineAvailable(engine) {
    if (!engine || !engine.command || !commandExists(engine.command)) return false;
    try {
        execFileSync(engine.command, [...(engine.args || []), '--help'], {
            timeout: 5000,
            encoding: 'utf8',
            stdio: 'pipe',
            windowsHide: true,
        });
        return true;
    } catch {
        return false;
    }
}

function detectImportEngine() {
    const windowsCandidates = [
        {
            id: 'python-markitdown',
            command: 'py.exe',
            args: ['-m', 'markitdown'],
            label: 'Windows Python markitdown',
            description: 'Uses Windows Python via py.exe so imports run on Windows instead of WSL.',
            host: 'windows',
        },
        {
            id: 'python-markitdown',
            command: 'python.exe',
            args: ['-m', 'markitdown'],
            label: 'Windows Python markitdown',
            description: 'Uses python.exe on the Windows host PATH.',
            host: 'windows',
        },
        {
            id: 'python-markitdown',
            command: 'markitdown.exe',
            args: [],
            label: 'Windows markitdown',
            description: 'Uses markitdown.exe on the Windows host PATH.',
            host: 'windows',
        },
        {
            id: 'python-markitdown',
            command: 'markitdown.cmd',
            args: [],
            label: 'Windows markitdown',
            description: 'Uses markitdown.cmd on the Windows host PATH.',
            host: 'windows',
        },
    ];
    const hostCandidates = [
        {
            id: 'python-markitdown',
            command: 'python3',
            args: ['-m', 'markitdown'],
            label: 'Python markitdown',
            description: 'Uses python3 on the current host PATH.',
            host: 'host',
        },
        {
            id: 'python-markitdown',
            command: 'python',
            args: ['-m', 'markitdown'],
            label: 'Python markitdown',
            description: 'Uses python on the current host PATH.',
            host: 'host',
        },
        {
            id: 'python-markitdown',
            command: 'markitdown',
            args: [],
            label: 'Python markitdown',
            description: 'Detected on the current host PATH and ready to convert supported documents into Markdown.',
            host: 'host',
        },
    ];

    for (const candidate of [...windowsCandidates, ...hostCandidates]) {
        if (!importEngineAvailable(candidate)) continue;
        return Object.assign({ available: true }, candidate);
    }

    const preferWindowsInstall = isWindowsHost() || windowsCandidates.some(candidate => commandExists(candidate.command));

    return {
        id: 'python-markitdown-missing',
        available: false,
        command: '',
        args: [],
        label: 'Python markitdown not installed',
        description: preferWindowsInstall
            ? 'Install it in Windows Python with: py -m pip install "markitdown[all]"'
            : 'Install it first with: pip install "markitdown[all]"',
        host: preferWindowsInstall ? 'windows' : 'host',
    };
}

function describeImportEngine(engine) {
    if (!engine) return 'No import engine detected.';
    return `${engine.label}. ${engine.description}`;
}

function ensurePythonMarkItDownInstalled(plugin) {
    plugin.importEngine = detectImportEngine();
    if (plugin.importEngine.available) return plugin.importEngine;

    new Notice(plugin.importEngine.description, 8000);
    return null;
}

function isSupportedImportPath(filePath) {
    return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isFileUri(filePath) {
    return /^file:\/\//i.test(filePath);
}

function tailLines(text, maxLines = 12) {
    return String(text || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(-maxLines)
        .join('\n');
}

function childProcessErrorText(error, maxLines = 12) {
    if (!error) return '';
    const parts = [];
    if (typeof error.stderr === 'string' && error.stderr.trim()) parts.push(error.stderr);
    else if (Buffer.isBuffer(error.stderr) && error.stderr.length) parts.push(error.stderr.toString('utf8'));
    if (typeof error.stdout === 'string' && error.stdout.trim()) parts.push(error.stdout);
    else if (Buffer.isBuffer(error.stdout) && error.stdout.length) parts.push(error.stdout.toString('utf8'));
    if (error.message) parts.push(error.message);
    return tailLines(redactSensitiveText(parts.join('\n')), maxLines);
}

function summarizeErrorMessage(message, maxLength = 180) {
    const firstLine = String(message || '')
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) || 'Unknown error';
    if (firstLine.length <= maxLength) return firstLine;
    return `${firstLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function redactSensitiveText(text) {
    return String(text || '')
        .replace(/PGPASSWORD='[^']*'/g, "PGPASSWORD='[REDACTED]'")
        .replace(/PGPASSWORD=[^\s]+/g, 'PGPASSWORD=[REDACTED]');
}

function formatSummaryList(items, maxItems = 5) {
    const values = [...new Set((items || []).filter(Boolean).map(value => String(value)))].sort();
    if (!values.length) return 'none';
    if (values.length <= maxItems) return values.join(', ');
    return `${values.slice(0, maxItems).join(', ')} +${values.length - maxItems} more`;
}

function renderStatusTooltip(tooltipEl, headerText, rows) {
    tooltipEl.empty();

    const header = tooltipEl.createDiv();
    header.style.cssText = 'font-weight:600;margin-bottom:8px;';
    header.setText(headerText);

    for (const row of rows) {
        const wrapper = tooltipEl.createDiv();
        wrapper.style.cssText = 'display:flex;gap:12px;align-items:flex-start;margin-top:6px;';

        const labelEl = wrapper.createEl('span');
        labelEl.style.cssText = 'flex:0 0 96px;color:var(--text-muted);';
        labelEl.setText(row.label);

        const valueEl = wrapper.createEl('span');
        valueEl.style.cssText = `flex:1 1 auto;word-break:break-word;${row.emphasize ? 'color:var(--text-error);' : ''}`;
        valueEl.setText(row.value);
    }
}

function convertWithPythonMarkItDown(sourceFile, engine) {
    const ext = path.extname(sourceFile).toLowerCase();
    const tmp = path.join(os.tmpdir(), `markitdown-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
        execFileSync(engine.command, [...(engine.args || []), sourceFile, '-o', tmp], {
            timeout: 120000,
            encoding: 'utf8',
            stdio: 'pipe',
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
        });
        return fs.readFileSync(tmp, 'utf8');
    } catch (e) {
        const details = childProcessErrorText(e, 18) || e.message;
        if (details.includes('MissingDependencyException')) {
            if (ext === '.pdf') {
                throw new Error('markitdown is installed, but PDF support is missing. Install it with: pip install "markitdown[all]"');
            }
            throw new Error(`markitdown is missing optional support for ${ext || 'this file type'}. Install a fuller build with: pip install "markitdown[all]"`);
        }
        throw new Error(details.trim() || 'markitdown conversion failed');
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

function resolveImportSourcePath(sourcePath) {
    const trimmedPath = sourcePath.trim();

    if (isFileUri(trimmedPath)) {
        const parsed = new url.URL(trimmedPath);
        const decodedPath = decodeURIComponent(parsed.pathname);

        if (/^\/[A-Za-z]:\//.test(decodedPath)) {
            return decodedPath.slice(1);
        }

        return decodedPath;
    }

    return trimmedPath;
}

function toWindowsPathIfPossible(filePath) {
    const value = String(filePath || '');
    const match = value.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (!match) return value;
    return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
}

function importExecutionPath(sourcePath, engine) {
    const resolved = resolveImportSourcePath(sourcePath);
    if (engine && engine.host === 'windows') return toWindowsPathIfPossible(resolved);
    return resolved;
}

function leafName(filePath) {
    return filePath.split(/[\\/]/).pop() || filePath;
}

function listDirectoryFilesForImport(rootDir) {
    const files = [];

    const walk = currentDir => {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const absolutePath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                walk(absolutePath);
                continue;
            }

            files.push({
                path: absolutePath,
                name: entry.name,
                relativePath: path.relative(rootDir, absolutePath).split(path.sep).join('/'),
            });
        }
    };

    walk(rootDir);
    return files;
}

function runPowerShellScript(script) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    if (isWindowsHost()) {
        return execFileSync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
            timeout: 120000,
            encoding: 'utf8',
            stdio: 'pipe',
        }).trim();
    }

    return execSync(`powershell.exe -NoProfile -STA -EncodedCommand ${encoded}`, {
        timeout: 120000,
        shell: '/bin/bash',
        encoding: 'utf8',
        stdio: 'pipe',
    }).trim();
}

function filePickerWithWindowsDialog({ directory }) {
    if (!commandExists('powershell.exe')) return null;

    const supportedPatterns = Array.from(SUPPORTED_EXTENSIONS)
        .sort()
        .map(ext => `*${ext}`)
        .join(';');

    const script = directory
        ? `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select folder to import into Wiki Sync'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
}
`
        : `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $false
$dialog.Filter = 'Supported files|${supportedPatterns}|All files|*.*'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.FileName
}
`;

    try {
        const selection = runPowerShellScript(script);
        if (!selection) return [];

        if (!directory) {
            return [{
                path: selection,
                name: leafName(selection),
                relativePath: leafName(selection),
            }];
        }

        const resolvedRoot = resolveImportSourcePath(selection);
        if (!fs.existsSync(resolvedRoot)) {
            throw new Error(`Selected directory is not accessible from Obsidian: ${resolvedRoot}`);
        }

        return listDirectoryFilesForImport(resolvedRoot);
    } catch (error) {
        reportImportError('Windows picker failed; falling back to the browser picker', error);
        return null;
    }
}

function filePicker({ directory }) {
    const nativeFiles = filePickerWithWindowsDialog({ directory });
    if (nativeFiles) return Promise.resolve(nativeFiles);

    return new Promise(resolve => {
        const input = document.createElement('input');
        let settled = false;

        const finish = files => {
            if (settled) return;
            settled = true;
            window.removeEventListener('focus', handleFocus, true);
            input.remove();
            resolve(files);
        };

        const handleFocus = () => {
            window.setTimeout(() => {
                if (!settled && !(input.files && input.files.length)) finish([]);
            }, 0);
        };

        input.type = 'file';
        input.multiple = !!directory;
        if (directory) input.setAttribute('webkitdirectory', '');
        input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';

        input.addEventListener('change', () => {
            const files = Array.from(input.files || []).map(file => ({
                path: typeof file.path === 'string' ? file.path : '',
                name: file.name,
                relativePath: file.webkitRelativePath || file.name,
            }));
            finish(files);
        });

        input.addEventListener('cancel', () => finish([]));
        window.addEventListener('focus', handleFocus, true);
        document.body.appendChild(input);
        window.setTimeout(() => input.click(), 0);
    });
}

function selectedPathOrThrow(selection, kind) {
    if (!selection) return null;

    const label = selection.relativePath || selection.name || kind;
    if (/fakepath/i.test(selection.path || '')) {
        throw new Error(`The picker returned a browser fake path for ${label}. Re-select the file from a local path that Obsidian can access.`);
    }
    if (selection.path) return selection.path;
    throw new Error(`Obsidian did not provide a usable local path for ${label}. Try selecting it again from a local filesystem path.`);
}

function buildMarkdownFrontmatter(sourceFile, extension, body) {
    const converted = new Date().toISOString();
    const normalizedBody = body.startsWith('---\n') ? `\n${body}` : body;
    return [
        '---',
        `source_file: ${JSON.stringify(sourceFile)}`,
        `converted: ${converted}`,
        `original_format: ${extension.slice(1)}`,
        '---',
        '',
        normalizedBody.replace(/^\n+/, ''),
    ].join('\n');
}

function ensureDirectory(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function reportImportError(message, error) {
    console.error('[Wiki Sync][Import]', message, error);
}

async function importOneFile(plugin, engine, sourceFile, relativeTargetDir) {
    const resolvedSourcePath = resolveImportSourcePath(sourceFile);
    const ext = path.extname(resolvedSourcePath).toLowerCase();
    if (!isSupportedImportPath(resolvedSourcePath)) throw new Error(`Unsupported file type: ${ext || '(none)'}`);
    if (!engine.available || engine.id !== 'python-markitdown') throw new Error('markitdown is not installed on the host PATH');
    if (!fs.existsSync(resolvedSourcePath)) {
        throw new Error(`Source file not found: ${resolvedSourcePath}`);
    }

    const baseName = path.basename(resolvedSourcePath, ext);
    const targetDir = path.join(plugin.syncDir(), relativeTargetDir);
    const targetPath = path.join(targetDir, `${baseName}.md`);
    ensureDirectory(targetDir);

    const body = convertWithPythonMarkItDown(importExecutionPath(resolvedSourcePath, engine), engine);
    const content = buildMarkdownFrontmatter(toWindowsPathIfPossible(resolvedSourcePath), ext, body);
    fs.writeFileSync(targetPath, content, 'utf8');
    return targetPath;
}

async function importSelectedFile(plugin, relativeTargetDir) {
    try {
        const engine = ensurePythonMarkItDownInstalled(plugin);
        if (!engine) return;

        const [selection] = await filePicker({ directory: false });
        if (!selection) return;

        const sourcePath = selectedPathOrThrow(selection, 'selected file');
        const targetPath = await importOneFile(plugin, engine, sourcePath, relativeTargetDir);
        plugin.lastError = null;
        await plugin.refreshLocalPath(plugin.toVaultRelative(targetPath));
        plugin.recomputeState();
        new Notice(`Imported ${path.basename(targetPath)} into the sync folder`, 5000);
    } catch (e) {
        plugin.lastError = e.message;
        reportImportError('Failed importing selected file', e);
        new Notice(`Import failed: ${e.message}`, 8000);
    }
}

async function importSelectedDirectory(plugin, relativeTargetDir) {
    try {
        const engine = ensurePythonMarkItDownInstalled(plugin);
        if (!engine) return;

        const files = await filePicker({ directory: true });
        if (!files.length) return;

        let imported = 0;
        let skipped = 0;
        let firstError = null;
        const touchedPaths = new Set();

        for (const file of files) {
            let sourcePath;

            try {
                sourcePath = selectedPathOrThrow(file, file.relativePath || 'selected file');
            } catch (e) {
                skipped += 1;
                if (!firstError) firstError = e.message;
                reportImportError('Directory import selection did not include a usable path', e);
                continue;
            }

            if (!isSupportedImportPath(sourcePath)) {
                skipped += 1;
                continue;
            }

            const nestedDir = path.dirname(file.relativePath);
            const destination = nestedDir === '.' ? relativeTargetDir : path.join(relativeTargetDir, nestedDir);

            try {
                const targetPath = await importOneFile(plugin, engine, sourcePath, destination);
                imported += 1;
                touchedPaths.add(plugin.toVaultRelative(targetPath));
            } catch (e) {
                skipped += 1;
                if (!firstError) firstError = `${path.basename(sourcePath)}: ${e.message}`;
                reportImportError(`Failed importing ${sourcePath}`, e);
            }
        }

        plugin.lastError = firstError;
        await plugin.refreshLocalPaths([...touchedPaths]);
        plugin.recomputeState();
        if (!imported && firstError) {
            new Notice(`Import failed: ${firstError}`, 8000);
            return;
        }

        new Notice(`Imported ${imported} file(s)${skipped ? `, skipped ${skipped}` : ''}${firstError ? `. First error: ${firstError}` : ''}.`, 8000);
    } catch (e) {
        plugin.lastError = e.message;
        reportImportError('Failed importing selected directory', e);
        new Notice(`Import failed: ${e.message}`, 8000);
    }
}

function addImportMenuItems(menu, file, plugin) {
    if (file.children === undefined) return;

    const syncRel = plugin.settings.syncSubdir;
    if (!file.path.startsWith(syncRel) && file.path !== syncRel) return;

    const relativeTargetDir = file.path === syncRel
        ? ''
        : file.path.slice(syncRel.length).replace(/^\//, '');

    menu.addItem(item => item
        .setTitle('Import file as Markdown')
        .setIcon('file-plus')
        .onClick(() => importSelectedFile(plugin, relativeTargetDir)));

    menu.addItem(item => item
        .setTitle('Import directory as Markdown')
        .setIcon('folder-open')
        .onClick(() => importSelectedDirectory(plugin, relativeTargetDir)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Settings UI
// ═══════════════════════════════════════════════════════════════════════════════

class WikiSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
        const { containerEl: el } = this;
        el.empty();
        const p = this.plugin;
        const s = p.settings;
        let hasUnsavedTextChanges = false;
        let saveButton = null;

        const updateSaveButton = () => {
            if (saveButton) saveButton.disabled = !hasUnsavedTextChanges;
        };

        const markTextSettingsDirty = () => {
            hasUnsavedTextChanges = true;
            updateSaveButton();
        };

        const saveTextSettings = async (showNotice = true) => {
            await p.saveSettings();
            hasUnsavedTextChanges = false;
            if (showNotice) new Notice('Wiki Sync settings saved.', 4000);
            this.display();
        };

        // Update text fields in memory as the user types, then persist explicitly.
        const bind = (key, t) => {
            t.setValue(String(s[key] ?? ''));
            t.onChange(v => {
                s[key] = v;
                markTextSettingsDirty();
            });
            t.inputEl.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveTextSettings();
                }
            });
        };

        el.createEl('h2', { text: 'Wiki Sync' });

        // ── Connection mode ───────────────────────────────────────────────────
        el.createEl('h3', { text: 'Connection Mode' });
        new Setting(el)
            .setName('Use OIDC authentication')
            .setDesc('On: authenticate via an OIDC provider (requires pg-oidc-proxy). Off: connect directly with a password.')
            .addToggle(t => t.setValue(s.authMode === 'oidc').onChange(async v => {
                await p.disconnectDatabase();
                s.authMode = v ? 'oidc' : 'local';
                await p.saveSettings();
                this.display();
            }));

        if (s.authMode === 'oidc') {
            // ── OIDC ──────────────────────────────────────────────────────────
            el.createEl('h3', { text: 'OIDC Provider' });
            new Setting(el).setName('Well-known URL')
                .setDesc('e.g. https://authentik.local:8443/application/o/ignition/.well-known/openid-configuration')
                .addText(t => { t.inputEl.style.width = '100%'; bind('oidcWellKnown', t); });
            new Setting(el).setName('Client ID')
                .addText(t => bind('oidcClientId', t));
            new Setting(el).setName('Client Secret')
                .addText(t => { t.inputEl.type = 'password'; bind('oidcClientSecret', t); });
            new Setting(el).setName('Redirect URI')
                .setDesc('Must match the provider — default works for local use')
                .addText(t => bind('oidcRedirectUri', t));

            el.createEl('h3', { text: 'Proxy' });
            new Setting(el).setName('Proxy host').setDesc('Host running pg-oidc-proxy')
                .addText(t => bind('proxyHost', t));
            new Setting(el).setName('Proxy port').setDesc('Port pg-oidc-proxy listens on')
                .addText(t => bind('listenPort', t));

            el.createEl('h3', { text: 'Database' });
            new Setting(el).setName('Database username')
                .setDesc('Postgres username used for the wiki database connection (JWT is used as the password).')
                .addText(t => bind('oidcDbUser', t));
            new Setting(el).setName('Wiki database name')
                .addText(t => bind('oidcDbName', t));
        } else {
            // ── Local ─────────────────────────────────────────────────────────
            el.createEl('h3', { text: 'Local Database' });
            new Setting(el).setName('Postgres user')
                .setDesc('Postgres role used for direct local database connections.')
                .addText(t => bind('localDbUser', t));
            new Setting(el).setName('Database address')
                .setDesc('Hostname, IP address, or domain name for the local Postgres server.')
                .addText(t => bind('localDbHost', t));
            new Setting(el).setName('Database port')
                .setDesc('Postgres port for the local connection.')
                .addText(t => bind('localDbPort', t));
            new Setting(el).setName('Database name')
                .setDesc('Database to sync from the local Postgres server.')
                .addText(t => bind('localDbName', t));
            new Setting(el).setName('Password secret')
                .setDesc('Select or create the SecretStorage entry that holds the local database password.')
                .addComponent(componentEl => new SecretComponent(this.app, componentEl)
                    .setValue(s.localPasswordSecret)
                    .onChange(async value => {
                        s.localPasswordSecret = typeof value === 'string' ? value.trim() : '';
                        await p.saveSettings();
                    }));
            new Setting(el).setName('Disable SSL')
                .setDesc('Connects without SSL for local/dev databases that do not use SSL.')
                .addToggle(t => t.setValue(!!s.localDisableSsl).onChange(async v => {
                    s.localDisableSsl = !!v;
                    await p.saveSettings();
                }));
        }

        // ── Vault ─────────────────────────────────────────────────────────────
        el.createEl('h3', { text: 'Vault' });
        new Setting(el).setName('Sync subfolder')
            .setDesc('Folder inside the vault that contains synced wiki content.')
            .addText(t => bind('syncSubdir', t));
        new Setting(el).setName('Auto-sync on startup')
            .addToggle(t => t.setValue(s.autoSync).onChange(async v => {
                s.autoSync = v;
                await p.saveSettings();
            }));

        el.createEl('h3', { text: 'Import' });
        new Setting(el)
            .setName('Detected import engine')
            .setDesc(describeImportEngine(p.importEngine));

        el.createEl('h3', { text: 'AI Scaffold' });
        new Setting(el)
            .setName('Scaffold profile')
            .setDesc('Select which vault-root instruction files and command skill entrypoints the plugin will refresh.')
            .addDropdown(dropdown => {
                Object.values(AI_SCAFFOLD_PROFILES).forEach(profile => dropdown.addOption(profile.id, profile.label));
                dropdown.setValue(s.scaffoldProfile);
                dropdown.onChange(async value => {
                    s.scaffoldProfile = value;
                    await p.saveSettings();
                    this.display();
                });
            });
        new Setting(el)
            .setName('Initialize AI scaffold')
            .setDesc('Creates vault-root instruction files plus vault-local `.claude/skills` and `.agents/skills` (Codex) command entrypoints for the selected wiki scaffold profile.')
            .addButton(btn => btn
                .setButtonText('Initialize')
                .setCta()
                .onClick(() => p.openAiScaffoldInitializer()));

        const buttonRow = el.createDiv();
        buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:20px;';

        const reloadButton = buttonRow.createEl('button', { text: 'Reload saved values' });
        reloadButton.addEventListener('click', async () => {
            await p.loadSettings();
            new Notice('Wiki Sync settings reloaded.', 4000);
            this.display();
        });

        saveButton = buttonRow.createEl('button', { text: 'Save settings', cls: 'mod-cta' });
        saveButton.addEventListener('click', () => { void saveTextSettings(); });
        updateSaveButton();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Plugin Lifecycle, Commands, and Sync Management
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = class WikiSyncPlugin extends Plugin {

    async onload() {
        await this.loadSettings();
        this.importEngine = detectImportEngine();
        this.contentStore = CONTENT_STORE;
        this.lastError = null;
        this.reviewRequired = false;
        this.syncState = 'unconfigured';
        this.currentStatusLabel = '';
        this.connectState = 'unconfigured';
        this.currentConnectLabel = '';
        this.syncCounts = { pending: 0, tracked: 0 };
        this.operationInFlight = false;
        this.lastConnectError = null;
        this.lastConnectDiagnostic = null;
        this.manifestTargetMismatch = null;
        this.sessionId = crypto.randomBytes(8).toString('hex');
        this.lastResolvedConnectionOptions = null;
        this.dbConnection = null;
        this.remoteListenerClient = null;
        this.remoteListenerState = 'inactive';
        this.remoteListenerError = null;
        this.remoteFreshnessState = 'unknown';
        this.remoteChangedFiles = new Map();
        this.remoteChangedApps = new Map();
        this.remoteChangeUnknownSeq = 0;
        this.remoteNotificationSeq = 0;
        this._remoteListenerReconnectTimer = null;
        this._recomputeTimer = null;
        this._connecting = false;
        this.remoteAppCache = null;

        this.addSettingTab(new WikiSettingTab(this.app, this));
        this.connectStatusBarController = new WikiConnectStatusBarController(this);
        this.statusBarController = new WikiStatusBarController(this);

        this._style = document.createElement('style');
        this._style.id = 'wiki-sync-styles';
        this._style.textContent = `
            @keyframes wiki-sync-spin {
                from { transform: rotate(0deg); }
                to   { transform: rotate(360deg); }
            }
            .wiki-sync-spin { display: inline-flex; animation: wiki-sync-spin 1s linear infinite; }
            .wiki-sync-status-item {
                transition: background-color 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
            }
            .wiki-sync-status-item:hover {
                background: var(--background-modifier-hover);
                box-shadow: inset 0 0 0 1px var(--background-modifier-border-hover, var(--background-modifier-border));
            }
            .wiki-sync-status-item--muted {
                opacity: 0.55;
            }
        `;
        document.head.appendChild(this._style);

        this._highlightStyle = document.createElement('style');
        this._highlightStyle.id = 'wiki-sync-highlight';
        document.head.appendChild(this._highlightStyle);
        this.updateHighlight();

        fs.mkdirSync(this.syncDir(), { recursive: true });
        await this.refreshLocalPath(this.settings.syncSubdir);

        this.registerSyncFolderListeners();
        this.registerCommands();
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.handleFileMenu(menu, file)));

        this.recomputeState();
        this.recomputeConnectionState();
        if (this.settings.autoSync && this.isCloned()) void this.doSync();
    }

    onunload() {
        if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
        if (this._remoteListenerReconnectTimer) clearTimeout(this._remoteListenerReconnectTimer);
        this.disconnectDatabaseSync();
        if (this._style) this._style.remove();
        if (this._highlightStyle) this._highlightStyle.remove();
        if (this.connectStatusBarController) this.connectStatusBarController.dispose();
        if (this.statusBarController) this.statusBarController.dispose();
    }

    registerCommands() {
        this.addCommand({ id: 'wiki-connect', name: 'Connect wiki database', callback: () => this.doConnect() });
        this.addCommand({ id: 'wiki-disconnect', name: 'Disconnect wiki database', callback: () => this.doDisconnect() });
        this.addCommand({ id: 'wiki-connection-diagnostics', name: 'Show wiki connection diagnostics', callback: () => this.showConnectionDiagnostics() });
        this.addCommand({ id: 'wiki-clone', name: 'Clone wiki', callback: () => this.doClone() });
        this.addCommand({ id: 'wiki-pull', name: 'Pull wiki changes', callback: () => this.doPull() });
        this.addCommand({ id: 'wiki-push', name: 'Push wiki changes', callback: () => this.doPush() });
        this.addCommand({ id: 'wiki-sync', name: 'Sync wiki', callback: () => this.doSync() });
        this.addCommand({ id: 'wiki-history', name: 'View wiki file history', callback: () => {
            const file = this.app.workspace.getActiveFile();
            if (!file) {
                new Notice('No file open');
                return;
            }
            if (!this.isSyncPath(file.path)) {
                new Notice('Active file is not inside the wiki sync folder');
                return;
            }
            new WikiHistoryModal(this.app, this, file).open();
        }});
    }

    registerSyncFolderListeners() {
        const schedule = relPath => {
            if (this.isSyncPath(relPath)) this.scheduleStateRecompute();
        };
        this.registerEvent(this.app.vault.on('modify', file => schedule(file?.path || '')));
        this.registerEvent(this.app.vault.on('create', file => schedule(file?.path || '')));
        this.registerEvent(this.app.vault.on('delete', file => schedule(file?.path || '')));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            schedule(file?.path || '');
            schedule(oldPath || '');
        }));
    }

    handleFileMenu(menu, file) {
        const syncRoot = this.settings.syncSubdir;
        if (!this.isSyncPath(file.path)) return;

        if (file.children === undefined) {
            menu.addItem(item => item
                .setTitle('View wiki history')
                .setIcon('history')
                .onClick(() => new WikiHistoryModal(this.app, this, file).open()));
        }

        addImportMenuItems(menu, file, this);

        if (file.path === syncRoot) {
            menu.addSeparator();
            menu.addItem(item => item.setTitle('Connect wiki database').setIcon('plug').onClick(() => this.doConnect()));
            menu.addItem(item => item.setTitle('Disconnect wiki database').setIcon('plug-zap').onClick(() => this.doDisconnect()));
            menu.addItem(item => item.setTitle('Clone wiki').setIcon('download').onClick(() => this.doClone()));
            menu.addItem(item => item.setTitle('Pull wiki changes').setIcon('arrow-down').onClick(() => this.doPull()));
            menu.addItem(item => item.setTitle('Push wiki changes').setIcon('arrow-up').onClick(() => this.doPush()));
            menu.addItem(item => item.setTitle('Sync wiki').setIcon('refresh-cw').onClick(() => this.doSync()));
            menu.addItem(item => item
                .setTitle('Open vault in VS Code')
                .setIcon('terminal')
                .onClick(() => {
                    const vaultDir = this.vaultPath();
                    const child = process.platform === 'win32'
                    ? spawn('cmd.exe', ['/c', 'start', '""', 'code', vaultDir], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true,
                    })
                    : spawn('code', [vaultDir], {
                        detached: true,
                        stdio: 'ignore',
                    });
                        child.on('error', error => {
                        new Notice(`Could not open VS Code: ${error.message}`, 8000);
                    });

                    child.unref();
                }));
        }
    }

    vaultPath() { return this.app.vault.adapter.basePath; }
    syncDir() { return path.join(this.vaultPath(), this.settings.syncSubdir); }
    manifestPath() { return path.join(this.vaultPath(), this.manifest.dir, 'sync', 'manifest.json'); }
    templateDir() { return path.join(this.vaultPath(), this.manifest.dir, 'templates'); }
    aiScaffoldProfile() { return getAiScaffoldProfile(this.settings.scaffoldProfile); }

    currentDatabaseName() {
        if (this.settings.authMode === 'local') return this.settings.localDbName || '(not configured)';
        return this.settings.oidcDbName || '(not configured)';
    }

    currentDatabaseHost() {
        if (this.settings.authMode === 'local') {
            const host = this.settings.localDbHost || 'unknown-host';
            const port = this.settings.localDbPort ? `:${this.settings.localDbPort}` : '';
            return `${host}${port}`;
        }
        const host = this.settings.proxyHost || 'unknown-host';
        const port = this.settings.listenPort || '5432';
        return `${host}:${port}`;
    }

    currentDatabaseUser() {
        if (this.settings.authMode === 'local') return this.settings.localDbUser || '(not configured)';
        return this.settings.oidcDbUser || '(not configured)';
    }

    currentDatabaseTarget() {
        if (this.settings.authMode === 'local') return formatLocalDatabaseTarget(this.settings);
        return `${this.currentDatabaseName()} via ${this.currentDatabaseHost()} as ${this.currentDatabaseUser()}`;
    }

    isConfigured() {
        if (this.settings.authMode === 'local') {
            return !!buildLocalConnectionString(this.settings);
        }
        return !!(
            this.settings.oidcWellKnown &&
            this.settings.oidcClientId &&
            this.settings.proxyHost &&
            this.settings.listenPort &&
            this.settings.oidcDbUser &&
            this.settings.oidcDbName
        );
    }

    normalizeRelativePath(relPath) {
        const raw = typeof relPath === 'string' ? relPath : String(relPath ?? '');
        const normalized = path.posix.normalize(raw.replace(/\\/g, '/').replace(/^\/+/, ''));
        return normalized === '.' ? '' : normalized;
    }

    normalizeSyncPath(relPath) {
        return this.normalizeRelativePath(relPath) || this.settings.syncSubdir;
    }

    toVaultRelative(absPath) {
        return this.normalizeRelativePath(path.relative(this.vaultPath(), absPath));
    }

    isSyncPath(relPath) {
        const normalized = this.normalizeRelativePath(relPath);
        const syncRoot = this.settings.syncSubdir;
        return normalized === syncRoot || normalized.startsWith(`${syncRoot}/`);
    }

    syncRelativePath(relPath) {
        const normalized = this.normalizeRelativePath(relPath);
        if (!this.isSyncPath(normalized)) return null;
        if (normalized === this.settings.syncSubdir) return '';
        return normalized.slice(this.settings.syncSubdir.length).replace(/^\/+/, '');
    }

    localPathForSyncRel(syncRel) {
        return syncRel ? path.join(this.syncDir(), ...syncRel.split('/')) : this.syncDir();
    }

    currentManifestTarget() {
        return {
            plugin: 'wiki-sync',
            authMode: this.settings.authMode,
            syncSubdir: this.normalizeRelativePath(this.settings.syncSubdir),
            user: this.currentDatabaseUser(),
            host: this.currentDatabaseHost(),
            database: this.currentDatabaseName(),
            ssl: this.settings.authMode === 'local' ? !this.settings.localDisableSsl : null,
        };
    }

    currentManifestTargetHash() {
        return manifestTargetHash(this.currentManifestTarget());
    }

    manifestMatchesCurrentTarget(manifest) {
        if (!manifest?.targetHash) {
            this.manifestTargetMismatch = 'The local clone was created before database target tracking. Clone the current wiki before syncing.';
            return false;
        }

        if (manifest.targetHash !== this.currentManifestTargetHash()) {
            this.manifestTargetMismatch = 'The local clone belongs to a different database or sync folder. Clone the current wiki before syncing.';
            return false;
        }

        this.manifestTargetMismatch = null;
        return true;
    }

    attachManifestTarget(manifest) {
        const next = normalizeManifestData(manifest);
        next.target = this.currentManifestTarget();
        next.targetHash = this.currentManifestTargetHash();
        return next;
    }

    readManifest({ allowStale = false } = {}) {
        try {
            const manifest = normalizeManifestData(JSON.parse(fs.readFileSync(this.manifestPath(), 'utf8')));
            if (!allowStale && !this.manifestMatchesCurrentTarget(manifest)) return null;
            if (!allowStale) this.manifestTargetMismatch = null;
            return manifest;
        } catch {
            this.manifestTargetMismatch = null;
            return null;
        }
    }

    writeManifest(manifest) {
        fs.mkdirSync(path.dirname(this.manifestPath()), { recursive: true });
        fs.writeFileSync(this.manifestPath(), JSON.stringify(this.attachManifestTarget(manifest), null, 2), 'utf8');
        this.manifestTargetMismatch = null;
    }

    isCloned() {
        return this.readManifest() !== null;
    }

    setStatus(state, label) {
        this.syncState = state;
        this.currentStatusLabel = label || '';
        this.statusBarController?.setState(state, label);
    }

    setConnectStatus(state, label) {
        this.connectState = state;
        this.currentConnectLabel = label || '';
        this.connectStatusBarController?.setState(state, label);
        this.statusBarController?.setConnectionState(state);
    }

    setConnectionErrorDetails(message) {
        this.lastConnectDiagnostic = redactSensitiveText(String(message || '').trim()) || null;
        this.lastConnectError = this.lastConnectDiagnostic
            ? summarizeErrorMessage(this.lastConnectDiagnostic)
            : null;
    }

    clearConnectionErrorDetails() {
        this.lastConnectError = null;
        this.lastConnectDiagnostic = null;
    }

    showConnectionDiagnostics(title = 'Wiki Connection Diagnostics') {
        if (!this.lastConnectDiagnostic) {
            new Notice('No wiki connection diagnostics are available yet.', 5000);
            return;
        }
        new WikiDiagnosticsModal(this.app, {
            title,
            summary: this.lastConnectError || summarizeErrorMessage(this.lastConnectDiagnostic),
            details: this.lastConnectDiagnostic,
        }).open();
    }

    setOperationError(message) {
        this.lastError = summarizeErrorMessage(message);
        return this.lastError;
    }

    maybeShowConnectionDiagnostics(message, title = 'Wiki Connection Diagnostics') {
        if (!this.lastConnectDiagnostic) return;
        if (String(message || '').trim() !== this.lastConnectDiagnostic) return;
        this.showConnectionDiagnostics(title);
    }

    connectionApplicationName(role) {
        return `wiki-sync-${role}-${this.sessionId}`.slice(0, 63);
    }

    remoteListenerLabel() {
        switch (this.remoteListenerState) {
        case 'connecting':
            return 'connecting';
        case 'listening':
            return 'listening';
        case 'error':
            return 'error';
        default:
            return 'inactive';
        }
    }

    remoteChangeSummary() {
        const files = [...this.remoteChangedFiles.keys()].sort();
        const fileApps = new Set();
        for (const rel of files) {
            const appName = this.contentStore.appFromSyncPath(rel);
            if (appName) fileApps.add(appName);
        }

        const explicitApps = [...this.remoteChangedApps.keys()].filter(appName => !fileApps.has(appName)).sort();
        const apps = [...new Set([...fileApps, ...explicitApps])].sort();
        return {
            files,
            apps,
            unknown: this.remoteChangeUnknownSeq > 0,
            count: files.length + explicitApps.length + (this.remoteChangeUnknownSeq > 0 ? 1 : 0),
        };
    }

    markRemoteFileChanged(syncRel) {
        const normalized = this.normalizeRelativePath(syncRel);
        if (!normalized) return 0;
        const seq = ++this.remoteNotificationSeq;
        this.remoteChangedFiles.set(normalized, seq);
        this.scheduleStateRecompute();
        return seq;
    }

    markRemoteAppChanged(appName) {
        const value = String(appName || '').trim();
        if (!value) return 0;
        const seq = ++this.remoteNotificationSeq;
        this.remoteChangedApps.set(value, seq);
        this.scheduleStateRecompute();
        return seq;
    }

    markRemoteUnknownChange() {
        this.remoteChangeUnknownSeq = ++this.remoteNotificationSeq;
        this.scheduleStateRecompute();
        return this.remoteChangeUnknownSeq;
    }

    clearTrackedRemoteFile(syncRel, expectedSeq = null) {
        const normalized = this.normalizeRelativePath(syncRel);
        if (!normalized) return;
        if (expectedSeq !== null && this.remoteChangedFiles.get(normalized) !== expectedSeq) return;
        this.remoteChangedFiles.delete(normalized);
    }

    snapshotRemoteChanges() {
        return {
            files: new Map(this.remoteChangedFiles),
            apps: new Map(this.remoteChangedApps),
            unknownSeq: this.remoteChangeUnknownSeq,
        };
    }

    clearRemoteChangeSnapshot(snapshot) {
        if (!snapshot) return;

        for (const [rel, seq] of snapshot.files.entries()) {
            if (this.remoteChangedFiles.get(rel) === seq) this.remoteChangedFiles.delete(rel);
        }
        for (const [appName, seq] of snapshot.apps.entries()) {
            if (this.remoteChangedApps.get(appName) === seq) this.remoteChangedApps.delete(appName);
        }
        if (snapshot.unknownSeq && this.remoteChangeUnknownSeq === snapshot.unknownSeq) {
            this.remoteChangeUnknownSeq = 0;
        }
        this.scheduleStateRecompute();
    }

    clearAllRemoteChanges() {
        this.remoteChangedFiles.clear();
        this.remoteChangedApps.clear();
        this.remoteChangeUnknownSeq = 0;
        this.scheduleStateRecompute();
    }

    async getRemoteAppWatermark(appMeta) {
        if (appMeta.historySchema) {
            const params = [];
            const filters = [];
            if (appMeta.roles.filetype) {
                params.push('file');
                filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $1`);
            }

            const rows = await this.contentStore.query(
                this.dbConnection,
                `SELECT "_history_id"::text AS value
                 FROM ${quoteDbTable(appMeta.historySchema, `${appMeta.appName}_history`)}
                 ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
                 ORDER BY "_history_id" DESC
                 LIMIT 1`,
                params,
            );
            return { mode: 'history', value: rows[0]?.value || '' };
        }

        if (appMeta.roles.modifiedAt) {
            const params = [];
            const filters = [];
            if (appMeta.roles.filetype) {
                params.push('file');
                filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $1`);
            }

            const rows = await this.contentStore.query(
                this.dbConnection,
                `SELECT MAX(${quoteDbIdent(appMeta.roles.modifiedAt)})::text AS value
                 FROM ${this.remoteTargetTable(appMeta)}
                 ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`,
                params,
            );
            return { mode: 'modified_at', value: rows[0]?.value || '' };
        }

        return { mode: 'none', value: '' };
    }

    async captureRemoteWatermarks(appNames = null) {
        const cache = await this.loadRemoteAppCache();
        const targetNames = appNames
            ? [...new Set(appNames.filter(Boolean).map(name => String(name).trim()))].sort()
            : [...cache.keys()].sort();
        const watermarks = {};

        for (const appName of targetNames) {
            const appMeta = cache.get(appName);
            if (!appMeta) continue;
            watermarks[appName] = await this.getRemoteAppWatermark(appMeta);
        }

        return watermarks;
    }

    async refreshManifestRemoteWatermarks(manifest, appNames = null) {
        const normalized = normalizeManifestData(manifest);
        Object.assign(manifest, normalized);
        if (!appNames) {
            manifest.remoteWatermarks = await this.captureRemoteWatermarks();
            return manifest;
        }

        const next = Object.assign({}, manifest.remoteWatermarks);
        const updates = await this.captureRemoteWatermarks(appNames);
        for (const [appName, watermark] of Object.entries(updates)) {
            next[appName] = watermark;
        }
        manifest.remoteWatermarks = next;
        return manifest;
    }

    async listRemoteFilesForApp(appMeta) {
        const params = [];
        const filters = [];
        if (appMeta.roles.filetype) {
            params.push('file');
            filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $1`);
        }

        const rows = await this.contentStore.query(
            this.dbConnection,
            `SELECT ${quoteDbIdent(appMeta.roles.filename)} AS filename
             FROM ${this.remoteTargetTable(appMeta)}
             ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
             ORDER BY ${quoteDbIdent(appMeta.roles.filename)}
             LIMIT ${REMOTE_CHANGED_FILE_LIMIT}`,
            params,
        );

        return rows
            .map(row => String(row.filename || '').trim())
            .filter(Boolean)
            .map(filename => path.posix.join(appMeta.appName, filename));
    }

    async remoteChangedFilesSinceWatermark(appMeta, watermark, currentWatermark, fallbackSince = '') {
        const baseline = normalizeRemoteWatermark(watermark);

        if (!baseline.value) {
            if (baseline.mode === 'history' && currentWatermark.mode === 'history' && currentWatermark.value) {
                const params = [];
                const filters = [];
                if (appMeta.roles.filetype) {
                    params.push('file');
                    filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $1`);
                }

                const rows = await this.contentStore.query(
                    this.dbConnection,
                    `SELECT DISTINCT ${quoteDbIdent(appMeta.roles.filename)} AS filename
                     FROM ${quoteDbTable(appMeta.historySchema, `${appMeta.appName}_history`)}
                     ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
                     ORDER BY ${quoteDbIdent(appMeta.roles.filename)}
                     LIMIT ${REMOTE_CHANGED_FILE_LIMIT}`,
                    params,
                );
                return rows
                    .map(row => String(row.filename || '').trim())
                    .filter(Boolean)
                    .map(filename => path.posix.join(appMeta.appName, filename));
            }

            if (baseline.mode === 'modified_at' || !baseline.mode || baseline.mode === 'none') {
                if (currentWatermark.value) return this.listRemoteFilesForApp(appMeta);
                return [];
            }
        }

        if (baseline.mode === 'history' && appMeta.historySchema) {
            const params = [baseline.value];
            const filters = ['"_history_id" > $1::uuid'];
            if (appMeta.roles.filetype) {
                params.push('file');
                filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $2`);
            }

            const rows = await this.contentStore.query(
                this.dbConnection,
                `SELECT DISTINCT ${quoteDbIdent(appMeta.roles.filename)} AS filename
                 FROM ${quoteDbTable(appMeta.historySchema, `${appMeta.appName}_history`)}
                 WHERE ${filters.join(' AND ')}
                 ORDER BY ${quoteDbIdent(appMeta.roles.filename)}
                 LIMIT ${REMOTE_CHANGED_FILE_LIMIT}`,
                params,
            );
            return rows
                .map(row => String(row.filename || '').trim())
                .filter(Boolean)
                .map(filename => path.posix.join(appMeta.appName, filename));
        }

        if ((baseline.mode === 'modified_at' || fallbackSince) && appMeta.roles.modifiedAt) {
            const since = baseline.value || fallbackSince;
            if (!since) return [];

            const params = [since];
            const filters = [`${quoteDbIdent(appMeta.roles.modifiedAt)} > $1::timestamptz`];
            if (appMeta.roles.filetype) {
                params.push('file');
                filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $2`);
            }

            const rows = await this.contentStore.query(
                this.dbConnection,
                `SELECT ${quoteDbIdent(appMeta.roles.filename)} AS filename
                 FROM ${this.remoteTargetTable(appMeta)}
                 WHERE ${filters.join(' AND ')}
                 ORDER BY ${quoteDbIdent(appMeta.roles.modifiedAt)} DESC, ${quoteDbIdent(appMeta.roles.filename)}
                 LIMIT ${REMOTE_CHANGED_FILE_LIMIT}`,
                params,
            );
            return rows
                .map(row => String(row.filename || '').trim())
                .filter(Boolean)
                .map(filename => path.posix.join(appMeta.appName, filename));
        }

        return [];
    }

    async refreshRemoteStateFromManifest() {
        const manifest = this.readManifest();
        if (!manifest) {
            this.clearAllRemoteChanges();
            this.setRemoteFreshnessState('unknown');
            return;
        }

        const cache = await this.loadRemoteAppCache();
        const fallbackSince = latestManifestSyncTimestamp(manifest);
        const previousWatermarks = manifest.remoteWatermarks || {};

        if (!Object.keys(previousWatermarks).length) {
            manifest.remoteWatermarks = await this.captureRemoteWatermarks();
            this.writeManifest(manifest);
            this.clearAllRemoteChanges();
            this.setRemoteFreshnessState('fresh');
            return;
        }

        this.remoteChangedFiles.clear();
        this.remoteChangedApps.clear();
        this.remoteChangeUnknownSeq = 0;

        for (const [appName, appMeta] of cache.entries()) {
            const currentWatermark = await this.getRemoteAppWatermark(appMeta);
            const previousWatermark = previousWatermarks[appName]
                ? normalizeRemoteWatermark(previousWatermarks[appName])
                : null;

            if (!previousWatermark) {
                const files = await this.listRemoteFilesForApp(appMeta);
                if (files.length) {
                    for (const rel of files) this.markRemoteFileChanged(rel);
                } else {
                    this.markRemoteAppChanged(appName);
                }
                continue;
            }

            if (remoteWatermarkEquals(previousWatermark, currentWatermark)) continue;

            const files = await this.remoteChangedFilesSinceWatermark(appMeta, previousWatermark, currentWatermark, fallbackSince);
            if (files.length) {
                for (const rel of files) this.markRemoteFileChanged(rel);
            } else {
                this.markRemoteAppChanged(appName);
            }
        }

        for (const appName of Object.keys(previousWatermarks)) {
            if (!cache.has(appName)) this.markRemoteAppChanged(appName);
        }

        this.setRemoteFreshnessState('fresh');
    }

    setRemoteListenerState(state, error = null) {
        this.remoteListenerState = state;
        this.remoteListenerError = error ? summarizeErrorMessage(error) : (state === 'error' ? this.remoteListenerError : null);
        this.recomputeConnectionState();
    }

    setRemoteFreshnessState(state) {
        this.remoteFreshnessState = state === 'fresh' ? 'fresh' : 'unknown';
        this.scheduleStateRecompute();
    }

    handleRemoteNotification(message) {
        let payload = null;
        try {
            payload = message?.payload ? JSON.parse(message.payload) : null;
        } catch {
            this.markRemoteUnknownChange();
            return;
        }

        const applicationName = String(payload?.application_name || '').trim();
        if (applicationName && applicationName === this.connectionApplicationName('query')) return;

        const appName = String(payload?.app || '').trim();
        const filename = this.normalizeRelativePath(String(payload?.filename || '').trim());
        const filetype = String(payload?.filetype || '').trim().toLowerCase();

        if (appName && filename && filetype !== 'directory') {
            this.markRemoteFileChanged(path.posix.join(appName, filename));
            return;
        }
        if (appName) {
            this.markRemoteAppChanged(appName);
            return;
        }
        this.markRemoteUnknownChange();
    }

    scheduleStateRecompute() {
        if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
        this._recomputeTimer = setTimeout(() => {
            this._recomputeTimer = null;
            this.recomputeState();
        }, 300);
    }

    syncActionDescriptor({ pending, remoteSummary, remoteUnknown, manifest }) {
        if (!this.isConfigured()) {
            return {
                state: 'unconfigured',
                label: STATE_META.unconfigured.label,
                action: 'configure',
                hint: 'Open settings and configure the wiki connection first.',
            };
        }

        if (!manifest) {
            if (pending > 0) {
                return {
                    state: 'pending',
                    label: 'Push Local Wiki',
                    action: 'push',
                    hint: 'Click to initialize the current database from local files. Files must live inside top-level app folders.',
                };
            }
            return {
                state: 'not-cloned',
                label: this.manifestTargetMismatch ? 'Clone Current Wiki' : STATE_META['not-cloned'].label,
                action: 'clone',
                hint: this.manifestTargetMismatch || 'Click to clone the wiki into the sync folder.',
            };
        }

        if (this.reviewRequired) {
            return {
                state: 'review',
                label: STATE_META.review.label,
                action: 'sync',
                hint: 'Resolve the review prompt before continuing.',
            };
        }

        if (remoteUnknown && pending > 0) {
            return {
                state: 'pending',
                label: this.connectState === 'disconnected' ? 'Reconnect to Check' : 'Check Changes',
                action: this.connectState === 'disconnected' ? 'connect' : 'sync',
                hint: this.connectState === 'disconnected'
                    ? 'Reconnect first, then sync local and remote changes.'
                    : 'Click to verify remote changes, then pull and push as needed.',
            };
        }

        if (remoteUnknown) {
            return {
                state: 'pending',
                label: this.connectState === 'disconnected' ? 'Reconnect to Check' : 'Check Changes',
                action: this.connectState === 'disconnected' ? 'connect' : 'sync',
                hint: this.connectState === 'disconnected'
                    ? 'Reconnect first to verify remote changes.'
                    : 'Click to verify whether there are remote changes to pull.',
            };
        }

        if (pending > 0 && remoteSummary.count > 0) {
            return {
                state: 'pending',
                label: 'Sync Changes',
                action: 'sync',
                hint: 'Click to pull remote changes, then push local changes.',
            };
        }

        if (remoteSummary.count > 0) {
            return {
                state: 'pending',
                label: 'Pull Changes',
                action: 'pull',
                hint: 'Click to pull remote changes into the vault.',
            };
        }

        if (pending > 0) {
            return {
                state: 'pending',
                label: 'Push Changes',
                action: 'push',
                hint: 'Click to push local changes to the database.',
            };
        }

        return {
            state: 'synced',
            label: 'Synced',
            action: 'sync',
            hint: 'No local or remote changes are pending.',
        };
    }

    recomputeState() {
        const manifest = this.readManifest();
        const remoteSummary = this.remoteChangeSummary();
        const remoteUnknown = this.remoteFreshnessState !== 'fresh';
        if (!this.isConfigured()) {
            this.syncCounts = { pending: 0, tracked: manifest ? Object.keys(manifest.entries).length : 0 };
            if (!this.operationInFlight) this.setStatus('unconfigured');
            if (!this._connecting) this.setConnectStatus('unconfigured');
            return;
        }
        if (!manifest) {
            const localFiles = [...walkLocalSyncFiles(this.syncDir())];
            const descriptor = this.syncActionDescriptor({
                pending: localFiles.length,
                remoteSummary,
                remoteUnknown,
                manifest,
            });
            this.syncCounts = { pending: localFiles.length, tracked: 0 };
            if (!this.operationInFlight) this.setStatus(descriptor.state, descriptor.label);
            if (!this._connecting && !this.currentConnectLabel) this.setConnectStatus('disconnected');
            return;
        }

        const seen = new Set();
        let pending = 0;
        for (const rel of walkLocalSyncFiles(this.syncDir())) {
            seen.add(rel);
            try {
                const buf = fs.readFileSync(this.localPathForSyncRel(rel));
                const entry = manifest.entries[rel];
                if (!entry || entry.hash !== sha256Buffer(buf)) pending += 1;
            } catch {}
        }
        for (const rel of Object.keys(manifest.entries)) {
            if (!seen.has(rel)) pending += 1;
        }

        this.syncCounts = { pending, tracked: Object.keys(manifest.entries).length };
        if (this.operationInFlight) return;
        const resolvedDescriptor = this.syncActionDescriptor({ pending, remoteSummary, remoteUnknown, manifest });
        this.setStatus(resolvedDescriptor.state, resolvedDescriptor.label);
    }

    recomputeConnectionState() {
        if (!this.isConfigured()) {
            this.setConnectStatus('unconfigured');
            return;
        }
        if (this._connecting) {
            this.setConnectStatus('connecting');
            return;
        }

        if (this.dbConnection?.isConnected()) {
            this.clearConnectionErrorDetails();
            this.setConnectStatus('connected');
            return;
        }

        if (this.lastConnectError) this.setConnectStatus('error', 'Connect Error');
        else this.setConnectStatus('disconnected');
    }

    collectConnectionDetails() {
        return [
            { label: 'State', value: this.currentConnectLabel || (CONNECT_META[this.connectState]?.label || 'Connect'), emphasize: this.connectState === 'error' },
            { label: 'Auth mode', value: this.settings.authMode },
            { label: 'Database', value: this.currentDatabaseTarget() },
            { label: 'Connection', value: this.dbConnection?.isConnected() ? 'open' : 'closed' },
            { label: 'Remote listener', value: this.remoteListenerLabel(), emphasize: this.remoteListenerState === 'error' },
            { label: 'Listener error', value: this.remoteListenerError || 'none', emphasize: !!this.remoteListenerError },
            { label: 'Last error', value: this.lastConnectError || 'none', emphasize: !!this.lastConnectError },
            { label: 'Details', value: this.lastConnectDiagnostic ? 'Use "Show wiki connection diagnostics" to copy the full database error.' : 'none' },
        ];
    }

    collectSyncDetails() {
        const manifest = this.readManifest();
        const remoteSummary = this.remoteChangeSummary();
        const descriptor = this.syncActionDescriptor({
            pending: this.syncCounts.pending,
            remoteSummary,
            remoteUnknown: this.remoteFreshnessState !== 'fresh',
            manifest,
        });
        return [
            { label: 'State', value: this.currentStatusLabel || (STATE_META[this.syncState]?.label || 'Wiki'), emphasize: this.syncState === 'error' },
            { label: 'Click', value: descriptor.hint },
            { label: 'Connection', value: this.currentConnectLabel || (CONNECT_META[this.connectState]?.label || 'Connect'), emphasize: this.connectState === 'error' },
            {
                label: 'Remote state',
                value: this.remoteFreshnessState === 'fresh'
                    ? 'verified'
                    : (this.connectState === 'disconnected' ? 'unknown while disconnected' : 'unknown'),
                emphasize: this.remoteFreshnessState !== 'fresh',
            },
            { label: 'Sync folder', value: this.settings.syncSubdir },
            { label: 'Auth mode', value: this.settings.authMode },
            { label: 'Database', value: this.currentDatabaseName() },
            { label: 'Host', value: this.currentDatabaseHost() },
            { label: 'User', value: this.currentDatabaseUser() },
            { label: 'Target', value: this.currentDatabaseTarget() },
            { label: 'Local pending', value: String(this.syncCounts.pending) },
            { label: 'Remote changed', value: String(remoteSummary.count) },
            { label: 'Remote apps', value: remoteSummary.unknown && !remoteSummary.apps.length ? `${this.settings.syncSubdir} (unknown file list)` : formatSummaryList(remoteSummary.apps) },
            { label: 'Remote files', value: formatSummaryList(remoteSummary.files) },
            { label: 'Last pull', value: manifest?.lastPullAt || 'never' },
            { label: 'Last push', value: manifest?.lastPushAt || 'never' },
            { label: 'Clone target', value: this.manifestTargetMismatch || 'current', emphasize: !!this.manifestTargetMismatch },
            { label: 'Last error', value: this.lastError || 'none', emphasize: !!this.lastError },
        ];
    }

    async handleConnectStatusBarClick(state) {
        if (this.operationInFlight || state === 'connecting') return;
        if (state === 'unconfigured') {
            new Notice('Configure wiki settings first.');
            return;
        }
        if (state === 'connected') {
            await this.doDisconnect();
            return;
        }
        await this.doConnect();
    }

    openSettingsTab() {
        if (this.app.setting && typeof this.app.setting.open === 'function') {
            this.app.setting.open();
            if (typeof this.app.setting.openTabById === 'function') {
                this.app.setting.openTabById(this.manifest.id);
                return;
            }
        }
        new Notice('Open Settings and select Wiki Sync.', 5000);
    }

    showConnectStatusContextMenu(event) {
        const menu = new Menu();
        menu.addItem(item => item
            .setTitle(this.dbConnection?.isConnected() ? 'Disconnect wiki database' : 'Connect wiki database')
            .setIcon(this.dbConnection?.isConnected() ? 'plug-zap' : 'plug')
            .onClick(() => {
                if (this.dbConnection?.isConnected()) void this.doDisconnect();
                else void this.doConnect();
            }));
        menu.addItem(item => item
            .setTitle('Open Wiki Sync settings')
            .setIcon('settings')
            .onClick(() => this.openSettingsTab()));
        menu.addItem(item => item
            .setTitle('Show wiki connection diagnostics')
            .setIcon('file-warning')
            .onClick(() => this.showConnectionDiagnostics()));
        menu.showAtMouseEvent(event);
    }

    async handleStatusBarClick(state) {
        if (state === 'syncing') return;
        if (state === 'not-cloned') {
            await this.doClone();
            return;
        }
        if (state === 'unconfigured') {
            new Notice('Configure wiki settings first.');
            return;
        }

        const descriptor = this.syncActionDescriptor({
            pending: this.syncCounts.pending,
            remoteSummary: this.remoteChangeSummary(),
            remoteUnknown: this.remoteFreshnessState !== 'fresh',
            manifest: this.readManifest(),
        });

        if (descriptor.action === 'connect') {
            await this.doConnect();
            return;
        }
        if (descriptor.action === 'pull') {
            await this.doPull();
            return;
        }
        if (descriptor.action === 'push') {
            await this.doPush();
            return;
        }
        await this.doSync();
    }

    showSyncStatusContextMenu(event) {
        const menu = new Menu();
        if (!this.isCloned()) {
            menu.addItem(item => item
                .setTitle('Clone wiki')
                .setIcon('download')
                .onClick(() => void this.doClone()));
        }
        menu.addItem(item => item
            .setTitle('Sync wiki')
            .setIcon('refresh-cw')
            .onClick(() => void this.doSync()));
        menu.addItem(item => item
            .setTitle('Pull wiki changes')
            .setIcon('arrow-down')
            .onClick(() => void this.doPull()));
        menu.addItem(item => item
            .setTitle('Push wiki changes')
            .setIcon('arrow-up')
            .onClick(() => void this.doPush()));
        menu.showAtMouseEvent(event);
    }

    async getLocalPassword() {
        const secretName = this.settings.localPasswordSecret;
        if (!secretName) return '';
        if (!requireApiVersion('1.11.4') || !this.app.secretStorage || typeof this.app.secretStorage.getSecret !== 'function') {
            throw new Error('This Obsidian version does not support SecretStorage. Upgrade to 1.11.4 or newer.');
        }
        const password = await this.app.secretStorage.getSecret(secretName);
        if (password === null || password === undefined) throw new Error(`Local password secret "${secretName}" was not found in Obsidian SecretStorage`);
        if (typeof password !== 'string') throw new Error(`Local password secret "${secretName}" did not return a string value`);
        if (password.length === 0) {
            throw new Error(`Local password secret "${secretName}" is empty. Open the Obsidian secret entry and set the actual database password.`);
        }
        return password;
    }

    async buildConnection() {
        const s = this.settings;
        if (s.authMode === 'local') {
            const connStr = buildLocalConnectionString(s);
            if (!connStr) {
                throw new Error('Local database settings are incomplete. Set user, host, and database name in plugin settings.');
            }
            return {
                user: s.localDbUser,
                host: s.localDbHost,
                port: s.localDbPort,
                database: s.localDbName,
                password: await this.getLocalPassword(),
                ...(s.localDisableSsl ? { ssl: false } : {}),
            };
        }

        if (!s.oidcWellKnown) throw new Error('OIDC Well-known URL is not set in plugin settings');
        if (!s.oidcClientId) throw new Error('OIDC Client ID is not set in plugin settings');
        const password = await getOidcToken({
            wellKnownUrl: s.oidcWellKnown,
            clientId: s.oidcClientId,
            clientSecret: s.oidcClientSecret,
            redirectUri: s.oidcRedirectUri,
        });
        return {
            password,
            user: s.oidcDbUser,
            host: s.proxyHost,
            port: s.listenPort,
            database: s.oidcDbName,
        };
    }

    generateRemoteNotifyFunctionSQL(schemaName) {
        return `CREATE OR REPLACE FUNCTION ${quoteDbTable(schemaName, REMOTE_NOTIFY_FUNCTION)}()
RETURNS TRIGGER AS $$
DECLARE
    row_data JSONB;
    payload TEXT;
BEGIN
    row_data := CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
        ELSE to_jsonb(NEW)
    END;

    payload := json_build_object(
        'app', COALESCE(TG_ARGV[0], ''),
        'schema', TG_TABLE_SCHEMA,
        'table', TG_TABLE_NAME,
        'op', TG_OP,
        'filename', COALESCE(row_data ->> 'filename', ''),
        'filetype', COALESCE(row_data ->> 'filetype', ''),
        'application_name', current_setting('application_name', true)
    )::text;

    PERFORM pg_notify(${quoteSqlLiteral(REMOTE_NOTIFY_CHANNEL)}, payload);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql`;
    }

    async ensureRemoteNotificationTrigger(appMeta) {
        const tableRef = this.remoteTargetTable(appMeta);
        const triggerRows = await this.contentStore.query(
            this.dbConnection,
            `SELECT EXISTS (
                SELECT 1
                FROM pg_trigger
                WHERE tgrelid = to_regclass($1)
                  AND tgname = $2
                  AND NOT tgisinternal
            ) AS exists`,
            [tableRef, REMOTE_NOTIFY_TRIGGER],
        );

        if (triggerRows[0] && triggerRows[0].exists) return;

        await this.contentStore.exec(
            this.dbConnection,
            `CREATE TRIGGER ${quoteDbIdent(REMOTE_NOTIFY_TRIGGER)}
             AFTER INSERT OR UPDATE OR DELETE ON ${tableRef}
             FOR EACH ROW EXECUTE FUNCTION ${quoteDbTable(appMeta.tableSchema || CONTENT_SCHEMA, REMOTE_NOTIFY_FUNCTION)}(${quoteSqlLiteral(appMeta.appName)})`,
        );
    }

    async ensureRemoteNotificationSetup(appMetas = null) {
        await this.ensureConnected();
        const metas = Array.isArray(appMetas)
            ? appMetas.filter(Boolean)
            : [...(await this.loadRemoteAppCache()).values()];
        if (!metas.length) return false;

        const schemas = [...new Set(metas.map(appMeta => appMeta.tableSchema || CONTENT_SCHEMA))].sort();
        for (const schemaName of schemas) {
            await this.contentStore.exec(this.dbConnection, this.generateRemoteNotifyFunctionSQL(schemaName));
        }
        for (const appMeta of metas) {
            await this.ensureRemoteNotificationTrigger(appMeta);
        }
        return true;
    }

    scheduleRemoteListenerReconnect() {
        if (this._remoteListenerReconnectTimer || !this.dbConnection?.isConnected()) return;
        this._remoteListenerReconnectTimer = setTimeout(() => {
            this._remoteListenerReconnectTimer = null;
            void this.startRemoteListener();
        }, REMOTE_NOTIFY_RECONNECT_MS);
    }

    handleRemoteListenerFailure(error, client = null) {
        if (client && this.remoteListenerClient !== client) return;
        if (client && this.remoteListenerClient === client) this.remoteListenerClient = null;
        if (!this.dbConnection?.isConnected()) {
            this.setRemoteListenerState('inactive');
            return;
        }
        if (isDatabaseConnectivityError(error)) {
            this.dbConnection.markUnhealthy(error, 'Remote listener lost the database connection.');
            this.setRemoteFreshnessState('unknown');
            return;
        }
        this.setRemoteListenerState('error', error?.message || String(error || 'Remote listener failed'));
        this.setRemoteFreshnessState('unknown');
        this.scheduleRemoteListenerReconnect();
    }

    async startRemoteListener() {
        if (!this.dbConnection?.isConnected()) return false;
        if (this.remoteListenerClient) return true;
        if (this._remoteListenerReconnectTimer) {
            clearTimeout(this._remoteListenerReconnectTimer);
            this._remoteListenerReconnectTimer = null;
        }

        this.setRemoteListenerState('connecting');

        let client = null;
        try {
            await this.ensureRemoteNotificationSetup();
            const { Client } = requirePostgresModule();
            client = new Client({
                ...(this.lastResolvedConnectionOptions || await this.buildConnection()),
                application_name: this.connectionApplicationName('listener'),
                keepAlive: true,
            });

            client.on('notification', message => {
                if (this.remoteListenerClient !== client) return;
                this.handleRemoteNotification(message);
            });
            client.on('error', error => this.handleRemoteListenerFailure(error, client));
            client.on('end', () => this.handleRemoteListenerFailure(new Error('Remote listener disconnected.'), client));

            await client.connect();
            await client.query(`LISTEN ${quoteDbIdent(REMOTE_NOTIFY_CHANNEL)}`);
            this.remoteListenerClient = client;
            this.setRemoteListenerState('listening');
            if (!this._connecting) {
                if (this.isCloned()) await this.refreshRemoteStateFromManifest();
                else this.setRemoteFreshnessState('fresh');
            }
            return true;
        } catch (error) {
            if (client) {
                client.removeAllListeners('notification');
                client.removeAllListeners('error');
                client.removeAllListeners('end');
                await client.end().catch(() => {});
            }
            this.setRemoteListenerState('error', error?.message || String(error));
            return false;
        }
    }

    async stopRemoteListener() {
        if (this._remoteListenerReconnectTimer) {
            clearTimeout(this._remoteListenerReconnectTimer);
            this._remoteListenerReconnectTimer = null;
        }

        const client = this.remoteListenerClient;
        this.remoteListenerClient = null;
        if (!client) {
            this.setRemoteListenerState('inactive');
            return false;
        }

        client.removeAllListeners('notification');
        client.removeAllListeners('error');
        client.removeAllListeners('end');
        try { await client.query(`UNLISTEN ${quoteDbIdent(REMOTE_NOTIFY_CHANNEL)}`); } catch {}
        await client.end().catch(() => {});
        this.setRemoteListenerState('inactive');
        return true;
    }

    stopRemoteListenerSync() {
        if (this._remoteListenerReconnectTimer) {
            clearTimeout(this._remoteListenerReconnectTimer);
            this._remoteListenerReconnectTimer = null;
        }

        const client = this.remoteListenerClient;
        this.remoteListenerClient = null;
        if (client) {
            client.removeAllListeners('notification');
            client.removeAllListeners('error');
            client.removeAllListeners('end');
            void client.end().catch(() => {});
        }
        this.remoteListenerState = 'inactive';
        this.remoteListenerError = null;
    }

    databaseFailureDetails(fallbackMessage, error = null) {
        const details = [];
        if (error?.message) details.push(error.message);
        if (error?.code) details.push(`code=${error.code}`);
        if (error?.detail) details.push(`detail=${error.detail}`);
        if (error?.hint) details.push(`hint=${error.hint}`);

        return redactSensitiveText(
            details.length ? `${fallbackMessage}\n${details.join('\n\n')}` : fallbackMessage
        );
    }

    handleDatabaseConnectionFailure(error, context = 'Database connection failed.') {
        const diagnostic = this.databaseFailureDetails(context, error);
        this.setConnectionErrorDetails(diagnostic);
        this.setRemoteListenerState('error', error?.message || String(error || context));
        this.setRemoteFreshnessState('unknown');
        this.setConnectStatus('error', 'Connect Error');
        this.scheduleStateRecompute();
    }

    async doConnect(showNotice = true) {
        if (this.operationInFlight || this._connecting) return false;
        if (!this.isConfigured()) {
            this.recomputeState();
            this.recomputeConnectionState();
            if (showNotice) new Notice('Configure wiki first.');
            return false;
        }

        try {
            await this.ensureConnected();
            if (showNotice) new Notice('Wiki database connected.', 6000);
            return true;
        } catch (error) {
            this.setConnectionErrorDetails(error.message);
            this.setConnectStatus('error', 'Connect failed');
            if (showNotice) {
                new Notice(`Connect failed: ${this.lastConnectError}. Use "Show wiki connection diagnostics" for the full database error.`, 10000);
                this.showConnectionDiagnostics();
            }
            return false;
        }
    }

    async doDisconnect(showNotice = true) {
        if (this.operationInFlight || this._connecting) return false;
        const disconnected = await this.disconnectDatabase();
        this.clearConnectionErrorDetails();
        this.setConnectStatus(this.isConfigured() ? 'disconnected' : 'unconfigured');
        if (showNotice) {
            new Notice(disconnected ? 'Wiki database disconnected.' : 'Wiki database was not connected.', 6000);
        }
        return disconnected;
    }

    async ensureConnected() {
        if (this.dbConnection?.isConnected()) {
            this.recomputeConnectionState();
            return;
        }
        if (this._connecting) {
            for (let i = 0; i < 30; i += 1) {
                if (this.dbConnection?.isConnected()) {
                    this.clearConnectionErrorDetails();
                    this.setConnectStatus('connected');
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            const error = new Error('Timed out waiting for the wiki database connection.');
            this.setConnectionErrorDetails(error.message);
            this.setConnectStatus('error', 'Connect failed');
            throw error;
        }

        if (this.dbConnection) {
            const staleConnection = this.dbConnection;
            this.dbConnection = null;
            await this.stopRemoteListener();
            await staleConnection.disconnect().catch(() => {});
            this.remoteAppCache = null;
        }

        this._connecting = true;
        this.setConnectStatus('connecting');
        try {
            const connection = new DirectDatabaseConnection(this);
            await connection.connect();
            this.dbConnection = connection;
            this.clearConnectionErrorDetails();
            await this.startRemoteListener().catch(() => false);
            if (this.isCloned()) await this.refreshRemoteStateFromManifest();
            else this.setRemoteFreshnessState('fresh');
            this.setConnectStatus('connected');
        } catch (error) {
            this.dbConnection = null;
            const diagnostic = this.databaseFailureDetails('Failed to connect to the wiki database.', error);
            this.setConnectionErrorDetails(diagnostic);
            this.setConnectStatus('error', 'Connect failed');
            throw new Error(diagnostic);
        } finally {
            this._connecting = false;
            if (this.connectState !== 'error') this.recomputeConnectionState();
        }
    }

    async disconnectDatabase() {
        if (!this.dbConnection) return false;
        const connection = this.dbConnection;
        this.dbConnection = null;
        this.lastResolvedConnectionOptions = null;
        await this.stopRemoteListener();
        this.setRemoteFreshnessState('unknown');
        this.remoteAppCache = null;
        await connection.disconnect();
        return true;
    }

    disconnectDatabaseSync() {
        this.stopRemoteListenerSync();
        if (this.dbConnection) this.dbConnection.disconnectSync();
        this.dbConnection = null;
        this.lastResolvedConnectionOptions = null;
        this.remoteFreshnessState = 'unknown';
        this.remoteAppCache = null;
    }

    invalidateRemoteAppCache() {
        this.remoteAppCache = null;
    }

    async findRemoteHistorySchema(appName) {
        for (const schemaName of CONTENT_HISTORY_SCHEMAS) {
            if (await this.contentStore.tableExists(this.dbConnection, schemaName, `${appName}_history`)) {
                return schemaName;
            }
        }
        return '';
    }

    async loadRemoteAppCache() {
        await this.ensureConnected();
        if (this.remoteAppCache) return this.remoteAppCache;

        const viewRows = await this.contentStore.query(
            this.dbConnection,
            `SELECT c.relname AS view_name,
                    COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
             FROM pg_class c
             JOIN pg_namespace n ON c.relnamespace = n.oid
             WHERE n.nspname = $1 AND c.relkind = 'v'
             ORDER BY c.relname`,
            [CONTENT_VIEW_SCHEMA],
        );

        const appCache = new Map();

        for (const row of viewRows) {
            const appName = validateContentAppName(row.view_name);
            const features = this.contentStore.parseFeatureComment(row.comment);
            if (!features.format) continue;

            const columnRows = await this.contentStore.query(
                this.dbConnection,
                `SELECT column_name
                 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = $2
                 ORDER BY ordinal_position`,
                [CONTENT_VIEW_SCHEMA, appName],
            );
            const columns = columnRows.map(column => column.column_name);
            if (!columns.length) continue;

            let roles;
            try {
                roles = this.contentStore.detectColumnRoles(columns, { format: features.format });
            } catch {
                continue;
            }

            const historySchema = await this.findRemoteHistorySchema(appName);
            const tableUsage = await this.contentStore.query(
                this.dbConnection,
                `SELECT table_schema, table_name
                 FROM information_schema.view_table_usage
                 WHERE view_schema = $1 AND view_name = $2
                 ORDER BY table_schema, table_name
                 LIMIT 1`,
                [CONTENT_VIEW_SCHEMA, appName],
            );
            const target = tableUsage[0] || {};
            appCache.set(appName, {
                appName,
                columns,
                roles,
                format: features.format,
                history: features.history || !!historySchema,
                historySchema,
                tableSchema: target.table_schema || CONTENT_SCHEMA,
                tableName: target.table_name || appName,
            });
        }

        this.remoteAppCache = appCache;
        return appCache;
    }

    async getRemoteAppMeta(appName) {
        const cache = await this.loadRemoteAppCache();
        return cache.get(validateContentAppName(appName)) || null;
    }

    buildRemoteRowBuffer(appMeta, row) {
        if (!appMeta) throw new Error('Remote app metadata is required');

        const encoding = appMeta.roles.encoding
            ? String(row[appMeta.roles.encoding] || 'utf8').toLowerCase()
            : 'utf8';

        if (appMeta.format === DOC_FORMAT_PLAINTEXT) {
            const body = row[appMeta.roles.body];
            if (body === null || body === undefined) return Buffer.alloc(0);
            if (encoding === 'base64') return Buffer.from(String(body), 'base64');
            let text = String(body);
            if (text && !text.endsWith('\n')) text += '\n';
            return Buffer.from(text, 'utf8');
        }

        if (encoding === 'base64') {
            throw new Error(`Remote markdown file uses unsupported base64 encoding: ${appMeta.appName}/${row[appMeta.roles.filename]}`);
        }

        const values = appMeta.columns.map(column => row[column]);
        return Buffer.from(this.contentStore.synthesizeMarkdown(appMeta.columns, values, appMeta.roles), 'utf8');
    }

    remoteTargetTable(appMeta) {
        return quoteDbTable(appMeta.tableSchema || CONTENT_SCHEMA, appMeta.tableName || appMeta.appName);
    }

    parseSyncTarget(syncRel) {
        const normalized = this.normalizeRelativePath(syncRel);
        const appName = this.contentStore.appFromSyncPath(normalized);
        const filename = this.contentStore.filenameFromSyncPath(normalized);
        if (!appName || !filename) throw new Error(`Invalid remote sync path: ${syncRel}`);
        return { normalized, appName, filename };
    }

    async ensureRemoteAppForWrite(syncRel) {
        const target = this.parseSyncTarget(syncRel);
        let appMeta = await this.getRemoteAppMeta(target.appName);
        if (!appMeta) {
            await this.contentStore.ensureAppsForPush(this.dbConnection, [target.normalized], {
                schema: CONTENT_SCHEMA,
                viewSchema: CONTENT_VIEW_SCHEMA,
                features: { format: DOC_FORMAT_MARKDOWN, history: true },
            });
            this.invalidateRemoteAppCache();
            appMeta = await this.getRemoteAppMeta(target.appName);
        }
        if (!appMeta) throw new Error(`Remote content app not found: ${target.appName}`);
        await this.ensureRemoteNotificationSetup([appMeta]).catch(error => {
            this.setRemoteListenerState('error', error?.message || String(error));
        });
        return { ...target, appMeta };
    }

    async ensureRemoteParentDirectories(appMeta, filename) {
        if (!appMeta.roles.filetype) return;

        const parents = listParentDirectoryPaths(filename);
        if (!parents.length) return;

        const params = [];
        const values = parents.map((parent, index) => {
            const base = index * 2;
            params.push(parent, 'directory');
            return `($${base + 1}, $${base + 2})`;
        }).join(', ');

        await this.contentStore.exec(
            this.dbConnection,
            `INSERT INTO ${this.remoteTargetTable(appMeta)}
                (${quoteDbIdent(appMeta.roles.filename)}, ${quoteDbIdent(appMeta.roles.filetype)})
             VALUES ${values}
             ON CONFLICT (${quoteDbIdent(appMeta.roles.filename)}, ${quoteDbIdent(appMeta.roles.filetype)}) DO NOTHING`,
            params,
        );
    }

    async upsertRemoteRow(appMeta, rowData) {
        const columns = Object.keys(rowData);
        if (!columns.length) throw new Error(`No writable columns detected for ${appMeta.appName}`);

        const conflictColumns = [appMeta.roles.filename];
        if (appMeta.roles.filetype) conflictColumns.push(appMeta.roles.filetype);

        const assignments = columns
            .filter(column => !conflictColumns.includes(column))
            .map(column => `${quoteDbIdent(column)} = EXCLUDED.${quoteDbIdent(column)}`);
        const conflictAction = assignments.length
            ? `DO UPDATE SET ${assignments.join(', ')}`
            : 'DO NOTHING';

        await this.contentStore.exec(
            this.dbConnection,
            `INSERT INTO ${this.remoteTargetTable(appMeta)}
                (${columns.map(quoteDbIdent).join(', ')})
             VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})
             ON CONFLICT (${conflictColumns.map(quoteDbIdent).join(', ')})
             ${conflictAction}`,
            columns.map(column => rowData[column]),
        );
    }

    async listRemoteFiles() {
        await this.ensureConnected();
        const cache = await this.loadRemoteAppCache();
        const files = [];

        for (const appMeta of cache.values()) {
            const selectColumns = [`${quoteDbIdent(appMeta.roles.filename)} AS filename`];
            if (appMeta.roles.filetype) selectColumns.push(`${quoteDbIdent(appMeta.roles.filetype)} AS filetype`);

            const rows = await this.contentStore.query(
                this.dbConnection,
                `SELECT ${selectColumns.join(', ')}
                 FROM ${quoteDbTable(CONTENT_VIEW_SCHEMA, appMeta.appName)}
                 ${appMeta.roles.filetype ? `WHERE ${quoteDbIdent(appMeta.roles.filetype)} = 'file'` : ''}
                 ORDER BY ${quoteDbIdent(appMeta.roles.filename)}
                 LIMIT ${REMOTE_FILE_LIST_LIMIT}`,
            );

            for (const row of rows) {
                const filename = String(row.filename || '');
                if (!filename) continue;
                files.push(path.posix.join(appMeta.appName, filename));
            }
        }

        return files.sort();
    }

    async readRemoteBuffer(syncRel) {
        await this.ensureConnected();
        const { normalized, appName, filename } = this.parseSyncTarget(syncRel);

        const appMeta = await this.getRemoteAppMeta(appName);
        if (!appMeta) throw new Error(`Remote content app not found: ${appName}`);

        const params = [filename];
        const filters = [`${quoteDbIdent(appMeta.roles.filename)} = $1`];
        if (appMeta.roles.filetype) {
            params.push('file');
            filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $2`);
        }

        const rows = await this.contentStore.query(
            this.dbConnection,
            `SELECT *
             FROM ${quoteDbTable(CONTENT_VIEW_SCHEMA, appMeta.appName)}
             WHERE ${filters.join(' AND ')}
             LIMIT 1`,
            params,
        );

        if (!rows.length) throw new Error(`Remote file not found: ${normalized}`);
        return this.buildRemoteRowBuffer(appMeta, rows[0]);
    }

    async writeRemoteBuffer(syncRel, buf) {
        await this.ensureConnected();
        const { filename, appMeta } = await this.ensureRemoteAppForWrite(syncRel);
        const rowData = parseDocumentBufferToRow(buf, appMeta);
        rowData[appMeta.roles.filename] = filename;
        if (appMeta.roles.filetype) rowData[appMeta.roles.filetype] = 'file';
        if (appMeta.roles.encoding && rowData[appMeta.roles.encoding] === undefined) {
            rowData[appMeta.roles.encoding] = 'utf8';
        }

        await this.ensureRemoteParentDirectories(appMeta, filename);
        await this.upsertRemoteRow(appMeta, rowData);
        return this.buildRemoteRowBuffer(appMeta, rowData);
    }

    async deleteRemoteFile(syncRel) {
        await this.ensureConnected();
        const { filename, appName } = this.parseSyncTarget(syncRel);
        const appMeta = await this.getRemoteAppMeta(appName);
        if (!appMeta) return false;

        const params = [filename];
        const filters = [`${quoteDbIdent(appMeta.roles.filename)} = $1`];
        if (appMeta.roles.filetype) {
            params.push('file');
            filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $2`);
        }

        const result = await this.contentStore.exec(
            this.dbConnection,
            `DELETE FROM ${this.remoteTargetTable(appMeta)}
             WHERE ${filters.join(' AND ')}`,
            params,
        );
        return (result && typeof result.rowCount === 'number') ? result.rowCount > 0 : true;
    }

    async listHistorySnapshotsForFile(filePath) {
        await this.ensureConnected();
        const syncRel = this.syncRelativePath(filePath);
        if (!syncRel) return [];

        const appName = this.contentStore.appFromSyncPath(syncRel);
        const filename = this.contentStore.filenameFromSyncPath(syncRel);
        if (!appName || !filename) return [];

        const appMeta = await this.getRemoteAppMeta(appName);
        if (!appMeta || !appMeta.historySchema) return [];

        const params = [filename];
        const filters = [`${quoteDbIdent(appMeta.roles.filename)} = $1`];
        if (appMeta.roles.filetype) {
            params.push('file');
            filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $2`);
        }

        const rows = await this.contentStore.query(
            this.dbConnection,
            `SELECT "_history_id"::text AS history_id
             FROM ${quoteDbTable(appMeta.historySchema, `${appName}_history`)}
             WHERE ${filters.join(' AND ')}
             ORDER BY "_history_id" DESC
             LIMIT ${HISTORY_SNAPSHOT_LIMIT}`,
            params,
        );

        const seen = new Set();
        const snapshots = [];
        for (const row of rows) {
            const versionId = historyIdToVersionId(row.history_id);
            if (!versionId || seen.has(versionId)) continue;
            seen.add(versionId);
            snapshots.push(versionId);
        }
        return snapshots;
    }

    async readHistorySnapshotForFile(filePath, snapshot) {
        await this.ensureConnected();
        const syncRel = this.syncRelativePath(filePath);
        if (!syncRel) throw new Error(`File is outside the sync folder: ${filePath}`);

        const appName = this.contentStore.appFromSyncPath(syncRel);
        const filename = this.contentStore.filenameFromSyncPath(syncRel);
        if (!appName || !filename) throw new Error(`Invalid sync path for history lookup: ${filePath}`);

        const appMeta = await this.getRemoteAppMeta(appName);
        if (!appMeta || !appMeta.historySchema) {
            throw new Error(`No database history is available for ${syncRel}`);
        }

        const params = [filename];
        const filters = [`${quoteDbIdent(appMeta.roles.filename)} = $1`];
        if (appMeta.roles.filetype) {
            params.push('file');
            filters.push(`${quoteDbIdent(appMeta.roles.filetype)} = $2`);
        }

        const selectColumns = appMeta.columns.map(column => quoteDbIdent(column));
        const rows = await this.contentStore.query(
            this.dbConnection,
            `SELECT ${selectColumns.join(', ')}, "_history_id"::text AS history_id
             FROM ${quoteDbTable(appMeta.historySchema, `${appName}_history`)}
             WHERE ${filters.join(' AND ')}
             ORDER BY "_history_id" DESC
             LIMIT ${HISTORY_SNAPSHOT_LIMIT}`,
            params,
        );

        const match = rows.find(row => historyIdToVersionId(row.history_id) === snapshot);
        if (!match) throw new Error(`History snapshot not found: ${snapshot}`);
        return this.buildRemoteRowBuffer(appMeta, match).toString('utf8');
    }

    async ensureDirectoryIndexed(relDir, { createIfMissingIndex = false } = {}) {
        const normalized = this.normalizeRelativePath(relDir);
        if (!normalized) return false;

        const absDir = path.join(this.vaultPath(), normalized);
        let stat;
        try {
            stat = fs.statSync(absDir);
        } catch {
            return false;
        }
        if (!stat.isDirectory()) return false;

        if (createIfMissingIndex && !this.app.vault.getAbstractFileByPath(normalized)) {
            try { await this.app.vault.createFolder(normalized); } catch {}
        }

        try { this.app.vault.adapter.trigger('raw', absDir); } catch {}
        await this.app.vault.adapter.reconcileFile(normalized, normalized, true).catch(() => {});
        return true;
    }

    async reconcileKnownPath(relPath, absPath, stat, options = {}) {
        if (stat.isDirectory()) return this.ensureDirectoryIndexed(relPath, options);
        try { this.app.vault.adapter.trigger('raw', absPath); } catch {}
        await this.app.vault.adapter.reconcileFile(relPath, relPath, true).catch(() => {});
        return true;
    }

    localDirectoryChain(relDir) {
        const normalized = this.normalizeRelativePath(relDir);
        if (!normalized) return [];
        const parts = normalized.split('/');
        const dirs = [];
        let current = '';
        for (const part of parts) {
            current = current ? path.posix.join(current, part) : part;
            dirs.push(current);
        }
        return dirs;
    }

    removeIndexedSubtree(relPath) {
        const normalized = this.normalizeRelativePath(relPath);
        if (!normalized) return;
        const stale = this.app.vault.getAllLoadedFiles()
            .filter(file => file.path === normalized || file.path.startsWith(`${normalized}/`))
            .sort((a, b) => b.path.length - a.path.length);
        for (const file of stale) {
            try { this.app.vault.trigger('delete', file); } catch {}
        }
    }

    async refreshLocalPath(relPath) {
        const normalized = this.normalizeRelativePath(relPath);
        if (!normalized) return false;

        const absPath = path.join(this.vaultPath(), normalized);
        let stat;
        try {
            stat = fs.statSync(absPath);
        } catch {
            this.removeIndexedSubtree(normalized);
            return false;
        }

        const parentDir = stat.isDirectory() ? normalized : path.posix.dirname(normalized);
        for (const dir of this.localDirectoryChain(parentDir === '.' ? '' : parentDir)) {
            await this.ensureDirectoryIndexed(dir, { createIfMissingIndex: true });
        }

        return this.reconcileKnownPath(normalized, absPath, stat, { createIfMissingIndex: stat.isDirectory() });
    }

    async refreshLocalPaths(relPaths) {
        const uniquePaths = [...new Set(
            relPaths.map(relPath => this.normalizeRelativePath(relPath)).filter(Boolean)
        )].sort((a, b) => a.length - b.length);

        for (const relPath of uniquePaths) {
            await this.refreshLocalPath(relPath);
        }
        return uniquePaths.length > 0;
    }

    openAiScaffoldInitializer() {
        new InitializeAIScaffoldModal(this.app, this).open();
    }

    async initializeAiScaffold() {
        try {
            const templateDir = this.templateDir();
            const profile = this.aiScaffoldProfile();
            const targets = buildAiScaffoldTargets(profile);
            const contents = targets.map(target => {
                let content = renderAiScaffoldTemplate(
                    readAiScaffoldTemplate(templateDir, target.templatePath),
                    profile,
                    this.settings.syncSubdir,
                );
                if (target.frontmatter) {
                    const desc = content.split('\n').find(line => line && !line.startsWith('#'))?.trim() || target.frontmatter.name;
                    content = `---\nname: ${target.frontmatter.name}\ndescription: ${desc}\n---\n\n${content}`;
                }
                return { target, content };
            });

            let created = 0;
            let refreshed = 0;
            for (const { target, content } of contents) {
                const targetPath = path.join(this.vaultPath(), target.targetPath);
                const existed = fs.existsSync(targetPath);
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.writeFileSync(targetPath, content, 'utf8');
                if (existed) refreshed += 1;
                else created += 1;
            }

            await this.refreshLocalPaths(targets.map(target => target.targetPath));
            new Notice(`Wiki AI scaffold initialized for ${profile.label} (${created} created, ${refreshed} refreshed).`, 8000);
            return true;
        } catch (error) {
            new Notice(`Initialize AI scaffold failed: ${error.message}`, 8000);
            return false;
        }
    }

    beginOperation(label) {
        this.operationInFlight = true;
        this.reviewRequired = false;
        this.lastError = null;
        this.setStatus('syncing', label);
    }

    endOperation() {
        this.operationInFlight = false;
        this.recomputeState();
    }

    setProgress(label) {
        this.setStatus('syncing', label);
    }

    formatProgress(prefix, current, total) {
        if (!total) return `${prefix} 100%`;
        const percent = Math.round((current / total) * 100);
        return `${prefix} ${percent}% (${current}/${total})`;
    }

    formatWeightedProgress(prefix, phase, current, total, start, span) {
        const phaseFraction = total ? current / total : 1;
        const percent = Math.round(start + (phaseFraction * span));
        return `${prefix} ${percent}% (${phase} ${current}/${total || 0})`;
    }

    async reviewConflict({ title, message, leftLabel, rightLabel, leftBuf, rightBuf, actions }) {
        return new WikiConflictModal(this.app, {
            title,
            message,
            leftLabel,
            rightLabel,
            leftText: Buffer.isBuffer(leftBuf) ? safeText(leftBuf) : String(leftBuf ?? ''),
            rightText: Buffer.isBuffer(rightBuf) ? safeText(rightBuf) : String(rightBuf ?? ''),
            actions,
        }).openAndWait();
    }

    remoteDeleteRisk(deletePaths, localFiles, manifest) {
        const trackedCount = Object.keys(manifest.entries || {}).length;
        const deleteCount = deletePaths.length;
        const syncRootExists = fs.existsSync(this.syncDir());

        if (!deleteCount) return { highRisk: false, reason: '' };
        if (!syncRootExists) {
            return {
                highRisk: true,
                reason: `The local sync folder ${this.settings.syncSubdir}/ is missing. This looks like a folder deletion, not an intentional file-by-file delete.`,
            };
        }
        if (trackedCount > 0 && localFiles.length === 0) {
            return {
                highRisk: true,
                reason: `The local sync folder ${this.settings.syncSubdir}/ has no files, but the manifest tracks ${trackedCount}. This could wipe the remote wiki.`,
            };
        }
        if (
            trackedCount > 0 &&
            deleteCount >= REMOTE_DELETE_BULK_CONFIRM_COUNT &&
            deleteCount / trackedCount >= REMOTE_DELETE_BULK_CONFIRM_RATIO
        ) {
            return {
                highRisk: true,
                reason: `This would delete ${deleteCount} of ${trackedCount} tracked files from the remote wiki.`,
            };
        }
        return { highRisk: false, reason: '' };
    }

    async confirmRemoteDeletesForPush(deletePaths, { localFiles, manifest }) {
        if (!deletePaths.length) return;

        const risk = this.remoteDeleteRisk(deletePaths, localFiles, manifest);
        const confirmed = await new WikiRemoteDeleteConfirmModal(this.app, {
            paths: deletePaths,
            highRisk: risk.highRisk,
            reason: risk.reason,
            syncRoot: this.settings.syncSubdir,
        }).openAndWait();

        if (!confirmed) {
            this.reviewRequired = true;
            throw Object.assign(new Error('Push cancelled before deleting remote files.'), { code: 'CANCELLED' });
        }
    }

    async doClone() {
        if (this.operationInFlight) return;
        if (!this.isConfigured()) {
            this.recomputeState();
            new Notice('Configure wiki first.');
            return;
        }
        if (this.isCloned()) {
            new Notice('Wiki is already cloned.');
            return;
        }

        this.beginOperation('Clone 0%');
        const remoteSnapshot = this.snapshotRemoteChanges();
        try {
            await this.ensureConnected();
            fs.mkdirSync(this.syncDir(), { recursive: true });
            const remoteFiles = await this.listRemoteFiles();
            const manifest = emptyManifest();
            const touched = [this.settings.syncSubdir];

            for (let i = 0; i < remoteFiles.length; i += 1) {
                const rel = remoteFiles[i];
                this.setProgress(this.formatProgress('Clone', i + 1, remoteFiles.length));
                const buf = await this.readRemoteBuffer(rel);
                const dst = this.localPathForSyncRel(rel);
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, buf);
                manifest.entries[rel] = {
                    hash: sha256Buffer(buf),
                    size: buf.length,
                    pulledAt: new Date().toISOString(),
                };
                touched.push(path.posix.join(this.settings.syncSubdir, rel));
            }

            manifest.lastPullAt = new Date().toISOString();
            await this.refreshManifestRemoteWatermarks(manifest);
            this.writeManifest(manifest);
            await this.refreshLocalPaths(touched);
            this.clearRemoteChangeSnapshot(remoteSnapshot);
            this.setRemoteFreshnessState('fresh');
            new Notice(`Wiki cloned: ${remoteFiles.length} files pulled.`, 8000);
        } catch (error) {
            const summary = this.setOperationError(error.message);
            this.setStatus('error', 'Clone failed');
            new Notice(`Clone failed: ${summary}`, 8000);
            this.maybeShowConnectionDiagnostics(error.message);
        } finally {
            this.endOperation();
        }
    }

    async performPull(progressFormatter) {
        const manifest = this.readManifest();
        if (!manifest) throw new Error('Not cloned yet. Run Clone first.');
        const remoteSnapshot = this.snapshotRemoteChanges();

        await this.ensureConnected();
        const remoteFiles = new Set(await this.listRemoteFiles());
        const localFiles = new Set(walkLocalSyncFiles(this.syncDir()));
        const allFiles = [...new Set([...remoteFiles, ...localFiles, ...Object.keys(manifest.entries)])].sort();
        const touched = [];
        const removed = [];
        let pulled = 0;
        let deleted = 0;

        for (let i = 0; i < allFiles.length; i += 1) {
            const rel = allFiles[i];
            this.setProgress(progressFormatter(i + 1, allFiles.length));

            const remoteExists = remoteFiles.has(rel);
            const localExists = localFiles.has(rel);
            const entry = manifest.entries[rel];

            if (remoteExists && !localExists) {
                const buf = await this.readRemoteBuffer(rel);
                const dst = this.localPathForSyncRel(rel);
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, buf);
                manifest.entries[rel] = { hash: sha256Buffer(buf), size: buf.length, pulledAt: new Date().toISOString() };
                touched.push(path.posix.join(this.settings.syncSubdir, rel));
                pulled += 1;
                continue;
            }

            if (!remoteExists && localExists && !entry) continue;

            if (!remoteExists && entry) {
                if (!localExists) {
                    delete manifest.entries[rel];
                    deleted += 1;
                    continue;
                }

                const localBuf = fs.readFileSync(this.localPathForSyncRel(rel));
                const localHash = sha256Buffer(localBuf);
                if (localHash === entry.hash) {
                    try { fs.unlinkSync(this.localPathForSyncRel(rel)); } catch {}
                    delete manifest.entries[rel];
                    removed.push(path.posix.join(this.settings.syncSubdir, rel));
                    deleted += 1;
                    continue;
                }

                const choice = await this.reviewConflict({
                    title: `Pull review — ${rel}`,
                    message: 'The remote file was deleted, but the local copy has changed.',
                    leftLabel: 'Local',
                    rightLabel: 'Remote',
                    leftBuf: localBuf,
                    rightBuf: '(deleted remotely)',
                    actions: [
                        { label: 'Keep Local', value: 'keep-local' },
                        { label: 'Take Remote', value: 'take-remote', cta: true },
                        { label: 'Cancel', value: 'cancel' },
                    ],
                });
                if (choice === 'cancel') {
                    this.reviewRequired = true;
                    throw Object.assign(new Error('Pull cancelled during review.'), { code: 'CANCELLED' });
                }
                if (choice === 'take-remote') {
                    try { fs.unlinkSync(this.localPathForSyncRel(rel)); } catch {}
                    delete manifest.entries[rel];
                    removed.push(path.posix.join(this.settings.syncSubdir, rel));
                    deleted += 1;
                }
                continue;
            }

            const remoteBuf = await this.readRemoteBuffer(rel);
            const remoteHash = sha256Buffer(remoteBuf);

            if (entry && entry.hash === remoteHash) continue;

            if (!localExists || !entry) {
                const dst = this.localPathForSyncRel(rel);
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, remoteBuf);
                manifest.entries[rel] = { hash: remoteHash, size: remoteBuf.length, pulledAt: new Date().toISOString() };
                touched.push(path.posix.join(this.settings.syncSubdir, rel));
                pulled += 1;
                continue;
            }

            const localBuf = fs.readFileSync(this.localPathForSyncRel(rel));
            const localHash = sha256Buffer(localBuf);
            if (localHash === entry.hash) {
                fs.writeFileSync(this.localPathForSyncRel(rel), remoteBuf);
                manifest.entries[rel] = { hash: remoteHash, size: remoteBuf.length, pulledAt: new Date().toISOString() };
                touched.push(path.posix.join(this.settings.syncSubdir, rel));
                pulled += 1;
                continue;
            }

            const choice = await this.reviewConflict({
                title: `Pull review — ${rel}`,
                message: 'Both local and remote changed since the last sync.',
                leftLabel: 'Local',
                rightLabel: 'Remote',
                leftBuf: localBuf,
                rightBuf: remoteBuf,
                actions: [
                    { label: 'Keep Local', value: 'keep-local' },
                    { label: 'Take Remote', value: 'take-remote', cta: true },
                    { label: 'Cancel', value: 'cancel' },
                ],
            });
            if (choice === 'cancel') {
                this.reviewRequired = true;
                throw Object.assign(new Error('Pull cancelled during review.'), { code: 'CANCELLED' });
            }
            if (choice === 'take-remote') {
                fs.writeFileSync(this.localPathForSyncRel(rel), remoteBuf);
                manifest.entries[rel] = { hash: remoteHash, size: remoteBuf.length, pulledAt: new Date().toISOString() };
                touched.push(path.posix.join(this.settings.syncSubdir, rel));
                pulled += 1;
            }
        }

        manifest.lastPullAt = new Date().toISOString();
        await this.refreshManifestRemoteWatermarks(manifest);
        this.writeManifest(manifest);
        await this.refreshLocalPaths(touched);
        for (const relPath of removed) this.removeIndexedSubtree(relPath);
        this.clearRemoteChangeSnapshot(remoteSnapshot);
        this.setRemoteFreshnessState('fresh');
        return { pulled, deleted };
    }

    async performPush(progressFormatter) {
        let manifest = this.readManifest();
        await this.ensureConnected();
        const localFiles = [...walkLocalSyncFiles(this.syncDir())].sort();
        if (!manifest) {
            if (!localFiles.length) {
                throw new Error('Not cloned yet. Run Clone first, or add files inside app folders and push to initialize a new database.');
            }
            manifest = emptyManifest();
            this.manifestTargetMismatch = null;
        }

        const rootFiles = localFiles.filter(rel => !this.contentStore.appFromSyncPath(rel));
        if (rootFiles.length) {
            throw new Error(`Cannot push files at the sync root without an app folder: ${rootFiles.join(', ')}. Move them under ${this.settings.syncSubdir}/wiki/ or another top-level app folder.`);
        }

        const localSet = new Set(localFiles);
        const remoteFiles = new Set(await this.listRemoteFiles());
        const deleteCandidates = Object.keys(manifest.entries || {})
            .filter(rel => !localSet.has(rel) && remoteFiles.has(rel))
            .sort();
        await this.confirmRemoteDeletesForPush(deleteCandidates, { localFiles, manifest });
        const allTargets = [...new Set([...localFiles, ...Object.keys(manifest.entries)])].sort();
        const rewrittenLocalPaths = [];
        const touchedApps = new Set();
        let pushed = 0;
        let deleted = 0;

        for (let i = 0; i < allTargets.length; i += 1) {
            const rel = allTargets[i];
            this.setProgress(progressFormatter(i + 1, allTargets.length));

            const localExists = localSet.has(rel);
            const remoteExists = remoteFiles.has(rel);
            const entry = manifest.entries[rel];
            const remoteSeq = this.remoteChangedFiles.get(rel) || 0;
            const appName = this.contentStore.appFromSyncPath(rel);

            if (localExists) {
                const localBuf = fs.readFileSync(this.localPathForSyncRel(rel));
                const localHash = sha256Buffer(localBuf);
                if (entry && entry.hash === localHash) continue;

                let remoteBuf = null;
                let remoteHash = null;
                if (remoteExists) {
                    remoteBuf = await this.readRemoteBuffer(rel);
                    remoteHash = sha256Buffer(remoteBuf);
                }

                if ((entry && remoteExists && remoteHash !== entry.hash) || (!entry && remoteExists)) {
                    const choice = await this.reviewConflict({
                        title: `Push review — ${rel}`,
                        message: 'The remote version changed since the last sync.',
                        leftLabel: 'Local',
                        rightLabel: 'Remote',
                        leftBuf: localBuf,
                        rightBuf: remoteBuf,
                        actions: [
                            { label: 'Push Local', value: 'push-local', cta: true },
                            { label: 'Keep Remote', value: 'keep-remote' },
                            { label: 'Cancel', value: 'cancel' },
                        ],
                    });
                    if (choice === 'cancel') {
                        this.reviewRequired = true;
                        throw Object.assign(new Error('Push cancelled during review.'), { code: 'CANCELLED' });
                    }
                    if (choice === 'keep-remote') continue;
                }

                const storedBuf = await this.writeRemoteBuffer(rel, localBuf);
                const canonicalBuf = Buffer.isBuffer(storedBuf) ? storedBuf : localBuf;
                if (!canonicalBuf.equals(localBuf)) {
                    fs.writeFileSync(this.localPathForSyncRel(rel), canonicalBuf);
                    rewrittenLocalPaths.push(path.posix.join(this.settings.syncSubdir, rel));
                }
                manifest.entries[rel] = {
                    hash: sha256Buffer(canonicalBuf),
                    size: canonicalBuf.length,
                    pulledAt: new Date().toISOString(),
                };
                if (appName) touchedApps.add(appName);
                if (remoteSeq) this.clearTrackedRemoteFile(rel, remoteSeq);
                pushed += 1;
                continue;
            }

            if (!entry) continue;
            if (!remoteExists) {
                delete manifest.entries[rel];
                continue;
            }

            const remoteBuf = await this.readRemoteBuffer(rel);
            const remoteHash = sha256Buffer(remoteBuf);
            if (remoteHash !== entry.hash) {
                const choice = await this.reviewConflict({
                    title: `Push review — ${rel}`,
                    message: 'The local file was deleted, but the remote version changed since the last sync.',
                    leftLabel: 'Local',
                    rightLabel: 'Remote',
                    leftBuf: '(deleted locally)',
                    rightBuf: remoteBuf,
                    actions: [
                        { label: 'Delete Remote', value: 'delete-remote', cta: true },
                        { label: 'Keep Remote', value: 'keep-remote' },
                        { label: 'Cancel', value: 'cancel' },
                    ],
                });
                if (choice === 'cancel') {
                    this.reviewRequired = true;
                    throw Object.assign(new Error('Push cancelled during review.'), { code: 'CANCELLED' });
                }
                if (choice === 'keep-remote') continue;
            }

            await this.deleteRemoteFile(rel);
            delete manifest.entries[rel];
            if (appName) touchedApps.add(appName);
            if (remoteSeq) this.clearTrackedRemoteFile(rel, remoteSeq);
            deleted += 1;
        }

        manifest.lastPushAt = new Date().toISOString();
        const appsStillMarkedRemote = new Set([
            ...this.remoteChangedApps.keys(),
            ...[...this.remoteChangedFiles.keys()].map(rel => this.contentStore.appFromSyncPath(rel)).filter(Boolean),
        ]);
        const appsToRefresh = [...touchedApps].filter(appName => !appsStillMarkedRemote.has(appName));
        if (appsToRefresh.length) await this.refreshManifestRemoteWatermarks(manifest, appsToRefresh);
        this.writeManifest(manifest);
        if (rewrittenLocalPaths.length) await this.refreshLocalPaths(rewrittenLocalPaths);
        return { pushed, deleted };
    }

    async doPull() {
        if (this.operationInFlight) return;
        this.beginOperation('Pull 0%');
        try {
            const summary = await this.performPull((current, total) => this.formatProgress('Pull', current, total));
            new Notice(`Pull complete: ${summary.pulled} pulled, ${summary.deleted} deleted locally.`, 8000);
        } catch (error) {
            if (error.code === 'CANCELLED') {
                const summary = this.setOperationError(error.message);
                new Notice(summary, 6000);
            } else {
                const summary = this.setOperationError(error.message);
                this.setStatus('error', 'Pull failed');
                new Notice(`Pull failed: ${summary}`, 8000);
                this.maybeShowConnectionDiagnostics(error.message);
            }
        } finally {
            this.endOperation();
        }
    }

    async doPush() {
        if (this.operationInFlight) return;
        this.beginOperation('Push 0%');
        try {
            const summary = await this.performPush((current, total) => this.formatProgress('Push', current, total));
            new Notice(`Push complete: ${summary.pushed} pushed, ${summary.deleted} deleted remotely.`, 8000);
        } catch (error) {
            if (error.code === 'CANCELLED') {
                const summary = this.setOperationError(error.message);
                new Notice(summary, 6000);
            } else {
                const summary = this.setOperationError(error.message);
                this.setStatus('error', 'Push failed');
                new Notice(`Push failed: ${summary}`, 8000);
                this.maybeShowConnectionDiagnostics(error.message);
            }
        } finally {
            this.endOperation();
        }
    }

    async doSync() {
        if (this.operationInFlight) return;
        this.beginOperation('Sync 0%');
        try {
            if (!this.readManifest() && [...walkLocalSyncFiles(this.syncDir())].length > 0) {
                const pushSummary = await this.performPush((current, total) => this.formatProgress('Sync', current, total));
                new Notice(
                    `Sync complete: initialized from local files, ${pushSummary.pushed} pushed, ${pushSummary.deleted} deleted remotely.`,
                    8000,
                );
                return;
            }

            const pullSummary = await this.performPull((current, total) => this.formatWeightedProgress('Sync', 'pull', current, total, 0, 50));
            const pushSummary = await this.performPush((current, total) => this.formatWeightedProgress('Sync', 'push', current, total, 50, 50));
            new Notice(
                `Sync complete: ${pullSummary.pulled} pulled, ${pullSummary.deleted} deleted locally, ${pushSummary.pushed} pushed, ${pushSummary.deleted} deleted remotely.`,
                8000,
            );
        } catch (error) {
            if (error.code === 'CANCELLED') {
                const summary = this.setOperationError(error.message);
                new Notice(summary, 6000);
            } else {
                const summary = this.setOperationError(error.message);
                this.setStatus('error', 'Sync failed');
                new Notice(`Sync failed: ${summary}`, 8000);
                this.maybeShowConnectionDiagnostics(error.message);
            }
        } finally {
            this.endOperation();
        }
    }

    updateHighlight() {
        if (!this._highlightStyle) return;
        const syncRoot = this.settings.syncSubdir;
        this._highlightStyle.textContent = `
            .nav-folder-title[data-path="${syncRoot}"],
            .nav-folder-title[data-path^="${syncRoot}/"],
            .nav-file-title[data-path^="${syncRoot}/"] {
                border-left: 2px solid var(--color-accent);
                padding-left: 6px;
                box-sizing: border-box;
            }
            .nav-folder-title[data-path="${syncRoot}"] {
                color: var(--color-accent);
                font-weight: 600;
            }
        `;
    }

    async loadSettings() {
        const rawSettings = await this.loadData();
        const { settings } = normalizeSettings(rawSettings);
        this.settings = settings;

        const persistedSettings = buildPersistedSettings(this.settings);
        if (JSON.stringify(rawSettings || {}) !== JSON.stringify(persistedSettings)) {
            await this.saveData(persistedSettings);
        }
    }

    async saveSettings() {
        const previousTargetHash = this.settings ? this.currentManifestTargetHash() : '';
        const { settings, strippedLocalConnPassword } = normalizeSettings(this.settings);
        this.settings = settings;
        const nextTargetHash = this.currentManifestTargetHash();
        const targetChanged = !!previousTargetHash && previousTargetHash !== nextTargetHash;
        if (targetChanged) {
            await this.disconnectDatabase();
            this.clearAllRemoteChanges();
            this.setRemoteFreshnessState('unknown');
            this.manifestTargetMismatch = 'Connection settings changed. Clone the current wiki before syncing.';
        }
        await this.saveData(buildPersistedSettings(this.settings));
        this.updateHighlight();
        if (strippedLocalConnPassword) {
            new Notice('Wiki Sync removed the password from the saved local database settings. Store it in SecretStorage instead.', 8000);
        }
        if (targetChanged) {
            new Notice('Wiki Sync connection target changed. Clone the current wiki before syncing.', 8000);
        }
        this.recomputeState();
    }
};
