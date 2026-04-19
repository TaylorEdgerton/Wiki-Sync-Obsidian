# wiki

Shared orchestrator for this database-backed company wiki from the vault root.

## Triggers

- `/wiki`
- "set up wiki"
- "scaffold the wiki"
- "ingest ..."
- "query ..."
- "lint the wiki"

## Workflow

1. Read `{{SYNC_ROOT}}/wiki/home.md` and `{{SYNC_ROOT}}/wiki/meta/active-topics.md`.
2. If the synced wiki is still empty, run the bootstrap workflow before doing anything else.
3. Route the request to the most specific shared skill command in this vault.
4. After structural changes, update `{{SYNC_ROOT}}/wiki/index.md`, `{{SYNC_ROOT}}/wiki/meta/active-topics.md`, `{{SYNC_ROOT}}/wiki/home.md`, and `{{SYNC_ROOT}}/activity/`.

## Routing

- ingest requests -> `wiki-ingest`
- question answering -> `wiki-query`
- wiki health and rebuilds -> `wiki-lint`
- saving reusable context -> `save`
{{WIKI_ROUTING_EXTRA}}
- homepage refresh -> `homepage`
- canvas work -> `canvas`
- bases work -> `obsidian-bases`
- markdown syntax questions -> `obsidian-markdown`

## Guardrails

- Keep `{{SYNC_ROOT}}/sources/raw/` as the intake queue and preserve files after they move into `{{SYNC_ROOT}}/sources/ingested/`.
- Treat `{{SYNC_ROOT}}/activity/` as append-only.
- Use flat YAML frontmatter and Obsidian wikilinks.
- Prefer updating compiled artifacts from underlying note state, not from memory alone.
