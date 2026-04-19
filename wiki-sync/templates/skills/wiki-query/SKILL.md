# wiki-query

Use this skill to answer questions from the shared wiki and optionally file the answer back.

## Modes

- Quick: read `{{SYNC_ROOT}}/wiki/meta/active-topics.md` and `{{SYNC_ROOT}}/wiki/index.md`
- Standard: read the above plus 3-5 relevant pages
- Deep: read broadly across the wiki and pull in external context when required

## Queue-aware behavior

- If a question mentions a service, outage, or current problem, also read the active and resolved work queue for the current profile, such as `{{SYNC_ROOT}}/issues/active/` or `{{SYNC_ROOT}}/incidents/active/`.
- If the answer is useful beyond the current session, save it into `{{SYNC_ROOT}}/wiki/questions/`.

## After answering

- Add related links to the saved note.
- Update the index, active topics, and activity log when a new question note is created.
