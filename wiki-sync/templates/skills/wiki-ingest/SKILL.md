# wiki-ingest

Use this skill to turn a source into structured wiki knowledge.

## Steps

1. Read the explicit source target completely.
2. Work only from an explicitly chosen source under `{{SYNC_ROOT}}/sources/raw/`; do not scan all of `{{SYNC_ROOT}}/sources/` by default.
3. Create or update the relevant notes under `{{SYNC_ROOT}}/wiki/`, `{{SYNC_ROOT}}/projects/`, `{{SYNC_ROOT}}/sites/`, or `{{SYNC_ROOT}}/oncall/` as needed.
4. Update `{{SYNC_ROOT}}/wiki/index.md`.
5. Re-rank `{{SYNC_ROOT}}/wiki/meta/active-topics.md`.
6. Refresh `{{SYNC_ROOT}}/wiki/home.md` if the new source changes priorities.
7. Record the result in `{{SYNC_ROOT}}/sources/manifest.md`.
8. Move the source file into `{{SYNC_ROOT}}/sources/ingested/` on success or `{{SYNC_ROOT}}/sources/failed/` on failure.
9. Append a timestamped note to `{{SYNC_ROOT}}/activity/`.
10. Record contradictions with `> [!contradiction]` callouts.

## Conventions

- Track ingest state in `{{SYNC_ROOT}}/sources/manifest.md`.
- Store unprocessed source material only under `{{SYNC_ROOT}}/sources/raw/`.
- Preserve successful ingest input in `{{SYNC_ROOT}}/sources/ingested/`.
- Preserve failed ingest input in `{{SYNC_ROOT}}/sources/failed/`.
- Never overwrite raw source material with summarized content.
