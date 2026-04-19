# {{PROFILE_NAME}} Wiki Agents

Use this file as the operating guide for agents working in this vault.

## Startup

1. Confirm `{{SYNC_ROOT}}/` is present and readable.
2. Read `{{SYNC_ROOT}}/wiki/home.md`.
3. Read `{{SYNC_ROOT}}/wiki/meta/active-topics.md`.
4. Read the most relevant shared skill under `.claude/skills/` or `.agents/skills/`.
5. Only then start editing or adding notes.

## Shared Skill Discovery

Look in `.claude/skills/<skill-name>/SKILL.md` or `.agents/skills/<skill-name>/SKILL.md` for workflow instructions shared across users.

Available shared skills:

{{SKILL_NAME_LIST}}

## Working Rules

- The current working root is this vault root.
- The database-backed content root is `{{SYNC_ROOT}}/`.
- Use flat frontmatter.
- Link related pages aggressively with wikilinks.
- Update `{{SYNC_ROOT}}/wiki/index.md`, `{{SYNC_ROOT}}/wiki/meta/active-topics.md`, and `{{SYNC_ROOT}}/wiki/home.md` when structural knowledge changes.
- Log meaningful structural work in `{{SYNC_ROOT}}/activity/`.

## Source of Truth

- `{{SYNC_ROOT}}/activity/` is the append-only activity trail.
- `{{SYNC_ROOT}}/wiki/index.md` is a compiled artifact.
- `{{SYNC_ROOT}}/wiki/meta/active-topics.md` is the current focus index.
- `{{SYNC_ROOT}}/sources/raw/` is the explicit intake queue for unprocessed source material.
- `{{SYNC_ROOT}}/sources/ingested/` is the immutable archive of successfully processed source material.
- `{{SYNC_ROOT}}/sources/failed/` holds source material that needs retry or review.
- `{{SYNC_ROOT}}/sources/manifest.md` tracks provenance and ingest state.

## Safety

- Do not assume remote sync is current just because the folder exists.
- Do not edit plugin metadata or manifest files unless the task explicitly asks for it.
- Do not delete or rewrite source material after ingest.
