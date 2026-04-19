# obsidian-bases

Use this skill to design `.base` files for live Obsidian views over the wiki.

## Planned Base Files

- `{{SYNC_ROOT}}/wiki/meta/dashboard.base`
- `{{SYNC_ROOT}}/wiki/meta/recent-activity.base`
- `{{SYNC_ROOT}}/<work-queue>/dashboard.base` when the selected profile uses an `issues` or `incidents` queue
- `{{SYNC_ROOT}}/oncall/roster.base` when the selected profile includes on-call

## Workflow

1. Confirm the target notes and frontmatter fields exist.
2. Create or refresh the `.base` definition.
3. Link the base from the relevant index or homepage note.
4. Log the change in `{{SYNC_ROOT}}/activity/`.
