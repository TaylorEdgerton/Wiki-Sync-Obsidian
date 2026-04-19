# oncall

Use this skill for roster management, incidents, handover, and postmortems.

## Actions

- "who's oncall" -> read `{{SYNC_ROOT}}/oncall/register/current.md`
- "log incident" -> create a new file in `{{SYNC_ROOT}}/incidents/active/`
- "resolve incident" -> move the file from `{{SYNC_ROOT}}/incidents/active/` to `{{SYNC_ROOT}}/incidents/resolved/`
- "handover" -> create a note in `{{SYNC_ROOT}}/oncall/handover/`
- "postmortem" -> create a review in `{{SYNC_ROOT}}/incidents/postmortem/`

## Conventions

- Incidents use the incident-specific frontmatter schema from the plan.
- Handover notes should summarize active incidents and unresolved risks.
- Always update `{{SYNC_ROOT}}/wiki/home.md` and `{{SYNC_ROOT}}/activity/` after active incident changes.
