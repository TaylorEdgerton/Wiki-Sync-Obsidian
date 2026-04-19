# {{PROFILE_NAME}} Wiki Workspace

This vault is the shared workspace for a database-backed {{PROFILE_NAME}} knowledge environment.

## Session Bootstrap

1. Confirm the local sync root exists at `{{SYNC_ROOT}}/`.
2. Read `{{SYNC_ROOT}}/wiki/home.md`.
3. Read `{{SYNC_ROOT}}/wiki/meta/active-topics.md`.
4. Read the relevant shared skill in `.claude/skills/`.
5. Append a note to `{{SYNC_ROOT}}/activity/` after structural wiki changes.

## Profile Focus

{{PROFILE_DESCRIPTION}}

## Shared Skills

Vault-local Claude skills live in `.claude/skills/`.

{{CLAUDE_SKILL_PATHS}}

## Conventions

- Keep intake material in `{{SYNC_ROOT}}/sources/raw/`.
- Move successful ingest output to `{{SYNC_ROOT}}/sources/ingested/` and failed ingest output to `{{SYNC_ROOT}}/sources/failed/`.
- Treat `{{SYNC_ROOT}}/sources/manifest.md` as the source provenance and ingest-state record.
- Use flat YAML frontmatter on wiki pages.
- Use `related:` wikilinks and `tags:` to drive graph navigation.
- Treat `{{SYNC_ROOT}}/activity/` as append-only.
- Rebuild compiled artifacts such as `{{SYNC_ROOT}}/wiki/index.md` from actual note state.
- Use directories as states only for workflow-style content such as issues or incidents moving from `active/` to `resolved/`.

## Operational Queue Rules

- Some profiles use an active work queue such as `{{SYNC_ROOT}}/issues/active/` or `{{SYNC_ROOT}}/incidents/active/`.
- Move resolved work into the matching `resolved/` folder and follow-up reviews into the matching `postmortem/` folder.
- On-call profiles also use `{{SYNC_ROOT}}/oncall/register/current.md` and `{{SYNC_ROOT}}/oncall/handover/`.

## Do Not

- Do not assume remote sync is current just because local files exist.
- Do not rewrite raw source documents with summarized content.
- Do not delete activity log entries to keep history tidy.
- Do not use frontmatter status fields to model queue states when directories should represent the state instead.
