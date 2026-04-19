# Gemini Notes

This workspace uses a database-backed wiki sync folder inside the vault for a shared {{PROFILE_NAME}} knowledge environment.

## Read First

1. `CLAUDE.md`
2. `{{SYNC_ROOT}}/wiki/home.md`
3. `{{SYNC_ROOT}}/wiki/meta/active-topics.md`
4. The relevant shared skill under `.codex/skills/` or `.claude/skills/`

## Shared Skills

Read shared skills directly from the vault-local command directories:

{{CODEX_SKILL_PATHS}}

## Writing Expectations

- Keep notes concise, linked, and frontmatter-driven.
- Use `{{SYNC_ROOT}}/sources/raw/` as the explicit source intake queue.
- Preserve ingested source immutability in `{{SYNC_ROOT}}/sources/ingested/`.
- Treat `{{SYNC_ROOT}}/sources/failed/` as the retry and review queue.
- Record source provenance in `{{SYNC_ROOT}}/sources/manifest.md`.
- Append structural work to `{{SYNC_ROOT}}/activity/`.
- Refresh index and homepage-style notes after major content changes.
