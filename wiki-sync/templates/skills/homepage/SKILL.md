# homepage

Use this skill to refresh `{{SYNC_ROOT}}/wiki/home.md` as the landing page for the synced wiki.

## Refresh Inputs

- `{{SYNC_ROOT}}/wiki/meta/active-topics.md`
- active work queue notes when the selected profile uses them, such as `{{SYNC_ROOT}}/issues/active/` or `{{SYNC_ROOT}}/incidents/active/`
- `{{SYNC_ROOT}}/oncall/register/current.md` when the selected profile includes on-call
- recent source notes plus `{{SYNC_ROOT}}/sources/manifest.md`
- latest lint status from `{{SYNC_ROOT}}/wiki/meta/`

## Refresh Outputs

- welcome summary
- active topics callout
- active work queue callout when the profile uses one
- current on-call callout when the profile includes it
- recently added notes
- quick links and wiki health

## Follow-up

- Update the `updated:` field.
- Append a homepage refresh note to `{{SYNC_ROOT}}/activity/` when the change is substantial.
