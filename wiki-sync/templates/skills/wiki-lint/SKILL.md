# wiki-lint

Use this skill to audit wiki quality and rebuild compiled artifacts.

## Checks

1. orphan pages
2. dead wikilinks
3. stale claims
4. missing pages
5. unlinked entity mentions
6. incomplete frontmatter
7. empty section headings
8. outdated index entries
9. stale oncall entries
10. active incidents older than 7 days without updates
11. stale active-topics content

## Outputs

- Save lint reports to `{{SYNC_ROOT}}/wiki/meta/lint-report-YYYY-MM-DD.md`.
- Rebuild `{{SYNC_ROOT}}/wiki/index.md` from actual note state.
- Refresh `{{SYNC_ROOT}}/wiki/meta/active-topics.md`.
- Refresh `{{SYNC_ROOT}}/wiki/home.md`.
- Append a lint activity note to `{{SYNC_ROOT}}/activity/`.
