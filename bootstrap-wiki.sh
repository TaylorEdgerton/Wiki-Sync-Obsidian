#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROFILE_DIR="${SCRIPT_DIR}/bootstrap-profiles"
DEFAULT_MOUNT_DIR="${SCRIPT_DIR}/mount"
MOUNT_DIR="${WIKI_SYNC_MOUNT_DIR:-$DEFAULT_MOUNT_DIR}"
PROFILE_ID="${WIKI_SYNC_BOOTSTRAP_PROFILE:-on-call-operations}"
TODAY="$(date -u +%F)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

declare -a CREATED_APPS=()
declare -a CREATED_DIRS=()
declare -a CREATED_FILES=()
declare -a SKIPPED_FILES=()

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage:
  bootstrap-wiki.sh [MOUNT_DIR] [PROFILE]
  bootstrap-wiki.sh --mount MOUNT_DIR --profile PROFILE
  bootstrap-wiki.sh --list-profiles

Windows:
  bootstrap-wiki.cmd --mount C:\path\to\vault\wiki --profile on-call-operations
  bash bootstrap-wiki.sh --mount C:/path/to/vault/wiki --profile on-call-operations

Profiles:
  minimal
  project-wiki
  multi-site-operations
  on-call-operations

Accepted aliases:
  general-wiki           -> minimal
  project-documentation  -> project-wiki
  multi-site             -> multi-site-operations
  oncall-sites           -> on-call-operations

This bootstrap is intentionally simple and intended for first-run setup on a
fresh wiki workspace. It creates app folders, directories, and starter markdown
only. Vault-root AI scaffold files are handled separately by the Obsidian plugin.
EOF
}

normalize_mount_dir() {
  local value="$1"
  local normalized="$value"

  if [[ -z "$normalized" ]]; then
    printf '%s' "$normalized"
    return
  fi

  if command -v cygpath >/dev/null 2>&1; then
    case "$normalized" in
      [A-Za-z]:[\\/]*|\\\\*)
        cygpath -u "$normalized"
        return
        ;;
    esac
  fi

  if command -v wslpath >/dev/null 2>&1; then
    case "$normalized" in
      [A-Za-z]:[\\/]*|\\\\*)
        wslpath -a "$normalized"
        return
        ;;
    esac
  fi

  normalized="${normalized//\\/\/}"
  printf '%s' "${normalized%/}"
}

list_profiles() {
    local profile_file
    for profile_file in "${PROFILE_DIR}"/*/profile.sh; do
        [[ -f "$profile_file" ]] || continue
        printf '%s\n' "$(basename "$(dirname "$profile_file")")"
    done
}

canonicalize_profile() {
    case "$1" in
        minimal|general-wiki)
            printf 'minimal'
            ;;
        project-wiki|project-documentation)
            printf 'project-wiki'
            ;;
        multi-site|multi-site-operations)
            printf 'multi-site-operations'
            ;;
        on-call|oncall|on-call-operations|oncall-sites)
            printf 'on-call-operations'
            ;;
        *)
            printf '%s' "$1"
            ;;
    esac
}

parse_args() {
    local -a positional=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mount)
                [[ $# -ge 2 ]] || die 'Missing value for --mount'
                MOUNT_DIR="$2"
                shift 2
                ;;
            --profile)
                [[ $# -ge 2 ]] || die 'Missing value for --profile'
                PROFILE_ID="$2"
                shift 2
                ;;
            --list-profiles)
                list_profiles
                exit 0
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            --)
                shift
                while [[ $# -gt 0 ]]; do
                    positional+=("$1")
                    shift
                done
                ;;
            -*)
                die "Unknown option: $1"
                ;;
            *)
                positional+=("$1")
                shift
                ;;
        esac
    done

    if [[ ${#positional[@]} -ge 1 ]]; then
        MOUNT_DIR="${positional[0]}"
    fi
    if [[ ${#positional[@]} -ge 2 ]]; then
        PROFILE_ID="${positional[1]}"
    fi
    if [[ ${#positional[@]} -gt 2 ]]; then
        die 'Too many positional arguments. See --help for usage.'
    fi
}

require_content_root() {
  if [[ ! -d "$MOUNT_DIR" ]]; then
    die "Wiki content root does not exist at ${MOUNT_DIR}"
  fi
}

load_profile() {
    local profile_file
    PROFILE_ID="$(canonicalize_profile "$PROFILE_ID")"
    profile_file="${PROFILE_DIR}/${PROFILE_ID}/profile.sh"
    [[ -f "$profile_file" ]] || die "Unknown bootstrap profile: ${PROFILE_ID}"

    # shellcheck source=/dev/null
    source "$profile_file"

    : "${PROFILE_NAME:?profile missing PROFILE_NAME}"
    : "${PROFILE_DESCRIPTION:?profile missing PROFILE_DESCRIPTION}"
    : "${PROFILE_APPS:?profile missing PROFILE_APPS}"
    : "${PROFILE_DIRS:?profile missing PROFILE_DIRS}"
    : "${PROFILE_ENABLE_ARCHITECTURE:?profile missing PROFILE_ENABLE_ARCHITECTURE}"
    : "${PROFILE_ENABLE_SITES:?profile missing PROFILE_ENABLE_SITES}"
    : "${PROFILE_ENABLE_RUNBOOKS:?profile missing PROFILE_ENABLE_RUNBOOKS}"
    : "${PROFILE_ENABLE_PROJECTS:?profile missing PROFILE_ENABLE_PROJECTS}"
    : "${PROFILE_ENABLE_ONCALL:?profile missing PROFILE_ENABLE_ONCALL}"
    : "${PROFILE_DOMAIN_ROOT+x}"
    : "${PROFILE_DOMAIN_LABEL+x}"
}

join_by() {
    local separator="$1"
    shift || true

    if [[ $# -eq 0 ]]; then
        return 0
    fi

    local first="$1"
    shift
    printf '%s' "$first"
    local item
    for item in "$@"; do
        printf '%s%s' "$separator" "$item"
    done
}

has_app() {
    local name="$1"
    local item
    for item in "${PROFILE_APPS[@]}"; do
        if [[ "$item" == "$name" ]]; then
            return 0
        fi
    done
    return 1
}

domain_kind() {
    if [[ -z "${PROFILE_DOMAIN_LABEL}" ]]; then
        printf 'record'
        return
    fi
    printf '%s' "${PROFILE_DOMAIN_LABEL%?}" | tr '[:upper:]' '[:lower:]'
}

write_if_missing_rel() {
    local relative_path="$1"
    local target_path="${MOUNT_DIR}/${relative_path}"
    local content

    mkdir -p "$(dirname "$target_path")"
    content="$(cat)"

    if [[ -e "$target_path" ]]; then
        SKIPPED_FILES+=("$relative_path")
        return 1
    fi

    printf '%s' "$content" > "$target_path"
    CREATED_FILES+=("$relative_path")
    return 0
}

create_app() {
    local name="$1"
    local app_type="$2"

    if [[ -d "${MOUNT_DIR}/${name}" ]]; then
        return
    fi

    if [[ -d "${MOUNT_DIR}/.build" ]]; then
        printf '%s' "$app_type" > "${MOUNT_DIR}/.build/${name}"
    else
        mkdir -p "${MOUNT_DIR}/${name}"
    fi
    CREATED_APPS+=("$name")
}

ensure_dir() {
    local relative_path="$1"
    local absolute_path="${MOUNT_DIR}/${relative_path}"

    if [[ -d "$absolute_path" ]]; then
        return
    fi

    mkdir -p "$absolute_path"
    CREATED_DIRS+=("$relative_path")
}

emit_quick_links() {
    printf '%s\n' '- [[wiki/index|Wiki Index]]'
    if has_app sites; then
        printf '%s\n' '- [[sites/index|Sites]]'
    fi
    if has_app runbooks; then
        printf '%s\n' '- [[runbooks/index|Runbooks]]'
    fi
    if has_app architecture; then
        printf '%s\n' '- [[architecture/index|Architecture]]'
    fi
    if has_app projects; then
        printf '%s\n' '- [[projects/index|Projects]]'
    fi
    if has_app sources; then
        printf '%s\n' '- [[sources/index|Sources]]'
    fi
    if [[ -n "${PROFILE_DOMAIN_ROOT}" ]]; then
        printf -- '- [[%s/active/index|Active %s]]\n' "${PROFILE_DOMAIN_ROOT}" "${PROFILE_DOMAIN_LABEL}"
    fi
    if (( PROFILE_ENABLE_ONCALL )); then
        printf '%s\n' '- [[oncall/register/current|Current On-Call]]'
    fi
    printf '%s\n' '- [[activity/index|Activity]]'
}

seed_home() {
    {
        cat <<EOF
---
type: meta
title: ${PROFILE_NAME} Home
updated: ${TODAY}
tags:
  - meta/home
  - bootstrap/${PROFILE_ID}
cssclasses:
  - wiki-home
---

# ${PROFILE_NAME}

${PROFILE_DESCRIPTION}

> [!info] Source Intake
> Place unprocessed source material in [[sources/raw]].
> Successful ingest archives source files under [[sources/ingested]] and records them in [[sources/manifest]].
> Failed ingest moves source files into [[sources/failed]] for review or retry.

EOF
        if [[ -n "${PROFILE_DOMAIN_ROOT}" ]]; then
            cat <<EOF
> [!warning] Active ${PROFILE_DOMAIN_LABEL}
> Current ${PROFILE_DOMAIN_LABEL,,} live in [[${PROFILE_DOMAIN_ROOT}/active/index]].
> Move resolved items into [[${PROFILE_DOMAIN_ROOT}/resolved/index]] and follow-up reviews into [[${PROFILE_DOMAIN_ROOT}/postmortem/template]].

EOF
        fi
        if (( PROFILE_ENABLE_ONCALL )); then
            cat <<EOF
> [!tip] Current On-Call
> The current roster lives in [[oncall/register/current]].
> Shift notes live in [[oncall/handover]].

EOF
        fi
        cat <<'EOF'
## Quick Links

EOF
        emit_quick_links
        cat <<'EOF'

## Live Views

![[wiki/meta/dashboard.base#Overview]]

![[wiki/meta/recent-activity.base#Recent Changes]]

EOF
        if [[ -n "${PROFILE_DOMAIN_ROOT}" ]]; then
            printf '![[%s/dashboard.base#Active %s]]\n\n' "${PROFILE_DOMAIN_ROOT}" "${PROFILE_DOMAIN_LABEL}"
        fi
        if (( PROFILE_ENABLE_ONCALL )); then
            printf '%s\n\n' '![[oncall/roster.base#Current Roster]]'
        fi
        cat <<EOF
## Recently Added

- Initial ${PROFILE_NAME} scaffold created on ${TODAY}.

## Workspace Health

- Bootstrap status: ready for first ingest
- Activity trail: [[activity/index]]
- Profile record: [[wiki/meta/bootstrap-profile]]
EOF
    } | write_if_missing_rel "wiki/home.md"
}

seed_wiki_index() {
    write_if_missing_rel "wiki/index.md" <<EOF
---
type: meta
title: Wiki Index
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - meta/index
  - wiki/index
status: seed
related:
  - "[[wiki/home]]"
  - "[[wiki/meta/active-topics]]"
---

# Wiki Index

## Core Areas

- [[wiki/concepts]]
- [[wiki/entities]]
- [[wiki/sources]]
- [[wiki/comparisons]]
- [[wiki/questions]]
- [[wiki/canvases]]
- [[wiki/meta/active-topics]]

## Operating Rules

- Keep source material immutable after it leaves [[sources/raw]].
- Use flat YAML frontmatter on every note.
- Use [[related]] links and hierarchical tags to strengthen graph navigation.
- Treat [[activity/index]] as the append-only source of truth for structural work.
EOF
}

seed_active_topics() {
    write_if_missing_rel "wiki/meta/active-topics.md" <<EOF
---
type: meta
title: Active Topics
updated: ${TODAY}
tags:
  - meta/active-topics
status: seed
---

# Active Topics

This page should always contain the 10 most active topics across current work.

1. To be calculated by ingest and lint
2. To be calculated by ingest and lint
3. To be calculated by ingest and lint
4. To be calculated by ingest and lint
5. To be calculated by ingest and lint
6. To be calculated by ingest and lint
7. To be calculated by ingest and lint
8. To be calculated by ingest and lint
9. To be calculated by ingest and lint
10. To be calculated by ingest and lint
EOF
}

seed_bootstrap_profile() {
    {
        cat <<EOF
---
type: meta
title: Bootstrap Profile
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - meta/bootstrap
  - bootstrap/${PROFILE_ID}
profile_id: ${PROFILE_ID}
profile_name: ${PROFILE_NAME}
domain_root: ${PROFILE_DOMAIN_ROOT:-none}
---

# Bootstrap Profile

This workspace was bootstrapped on ${TODAY} using the \`${PROFILE_ID}\` profile.

## Description

${PROFILE_DESCRIPTION}

## Included App Roots

EOF
        local app
        for app in "${PROFILE_APPS[@]}"; do
            printf -- '- `%s`\n' "$app"
        done
        cat <<EOF

## Included Directories

- \`sources/raw\`
- \`sources/ingested\`
- \`sources/failed\`
- \`wiki/meta\`
EOF
        if (( PROFILE_ENABLE_SITES )); then
            printf '%s\n' '- `sites/_templates`'
        fi
        if (( PROFILE_ENABLE_PROJECTS )); then
            printf '%s\n' '- `projects/_templates`'
        fi
        if (( PROFILE_ENABLE_RUNBOOKS )); then
            printf '%s\n' '- `runbooks/templates`'
        fi
        if (( PROFILE_ENABLE_ONCALL )); then
            printf '%s\n' '- `oncall/register`'
            printf '%s\n' '- `oncall/handover`'
        fi
        if [[ -n "${PROFILE_DOMAIN_ROOT}" ]]; then
            printf -- '- `%s/active`\n' "${PROFILE_DOMAIN_ROOT}"
            printf -- '- `%s/resolved`\n' "${PROFILE_DOMAIN_ROOT}"
            printf -- '- `%s/postmortem`\n' "${PROFILE_DOMAIN_ROOT}"
        fi
    } | write_if_missing_rel "wiki/meta/bootstrap-profile.md"
}

seed_activity_index() {
    write_if_missing_rel "activity/index.md" <<EOF
---
type: activity
title: Activity Log
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - activity/index
status: seed
---

# Activity Log

Use this area as the append-only record of meaningful structural work in the workspace.

- Bootstrap completed on ${TODAY}
- Profile: ${PROFILE_NAME}
EOF
}

seed_sources_index() {
    write_if_missing_rel "sources/index.md" <<EOF
---
type: source
title: Source Index
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - sources/index
status: seed
related:
  - "[[wiki/index]]"
---

# Source Index

This area stores source material for explicit ingest work.

- Place unprocessed files under [[sources/raw]].
- Move successfully ingested source files into [[sources/ingested]].
- Move failed source files into [[sources/failed]].
- Record every source state transition in [[sources/manifest]].
- Derived notes should link back to the original source identifier.
EOF
}

seed_sources_manifest() {
    write_if_missing_rel "sources/manifest.md" <<EOF
---
type: source
title: Source Manifest
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - sources/manifest
status: seed
---

# Source Manifest

Track one record per source using this schema:

\`\`\`yaml
id: SRC-2026-001
filename: vendor-api-guide.pdf
original_path: sources/raw/vendor-api-guide.pdf
status: ingested
ingested_at: ${NOW_ISO}
derived_notes:
  - wiki/concepts/vendor-api-auth.md
  - wiki/questions/how-auth-works.md
contradictions: none
\`\`\`

## Field Notes

- \`id\`: stable source identifier used across notes and activity logs
- \`filename\`: original filename of the source material
- \`original_path\`: first location inside the mounted workspace, usually under \`sources/raw/\`
- \`status\`: current state such as \`pending\`, \`ingested\`, or \`failed\`
- \`ingested_at\`: UTC timestamp for the most recent successful ingest
- \`derived_notes\`: notes created or updated from the source
- \`contradictions\`: unresolved contradictions, follow-up checks, or \`none\`
EOF
}

seed_architecture_index() {
    write_if_missing_rel "architecture/index.md" <<EOF
---
type: architecture
title: Architecture Index
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - architecture/index
status: seed
related:
  - "[[wiki/home]]"
---

# Architecture Index

Use this area for platform maps, design notes, and ADR-style decisions.
EOF

    write_if_missing_rel "architecture/decisions/template.md" <<EOF
---
type: architecture
title: Decision Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - architecture/decision
status: seed
---

# Decision Record

## Context

## Decision

## Consequences
EOF
}

seed_sites_content() {
    write_if_missing_rel "sites/index.md" <<EOF
---
type: site
title: Site Directory
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - sites/index
status: seed
related:
  - "[[wiki/home]]"
---

# Site Directory

Create one subdirectory per customer or managed site.

- Use [[sites/_templates/_index]] as the starting point for each site space.
- Keep site-specific runbooks, contacts, and architecture linked from the site overview.
EOF

    write_if_missing_rel "sites/_templates/_index.md" <<EOF
---
type: site
title: Site Overview Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - sites/template
status: seed
---

# Site Overview

## Summary

Describe the customer, service, or environment this site directory covers.

## Key Links

- [[architecture]]
- [[contacts]]
- [[known-issues]]
EOF

    write_if_missing_rel "sites/_templates/architecture.md" <<EOF
---
type: architecture
title: Site Architecture Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - sites/template
  - architecture/site
status: seed
---

# Site Architecture

## Services

## Integrations

## Dependencies
EOF

    write_if_missing_rel "sites/_templates/contacts.md" <<EOF
---
type: site
title: Site Contacts Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - sites/template
  - contacts
status: seed
---

# Site Contacts

## Internal Owners

## Customer Contacts

## Escalation Path
EOF

    write_if_missing_rel "sites/_templates/known-issues.md" <<EOF
---
type: site
title: Known Issues Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - sites/template
  - issues
status: seed
---

# Known Issues

## Open Issues

## Mitigations

## Related Reviews
EOF
}

seed_runbooks_content() {
    write_if_missing_rel "runbooks/index.md" <<EOF
---
type: runbook
title: Runbook Index
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - runbooks/index
status: seed
related:
  - "[[wiki/home]]"
---

# Runbook Index

Store operational procedures here. Link each runbook to the systems, issues, or incidents it supports.
EOF

    write_if_missing_rel "runbooks/templates/runbook-template.md" <<EOF
---
type: runbook
title: Runbook Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - runbooks/template
status: seed
---

# Runbook

## Purpose

## Preconditions

## Procedure

## Recovery
EOF
}

seed_projects_content() {
    write_if_missing_rel "projects/index.md" <<EOF
---
type: project
title: Project Index
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - projects/index
status: seed
related:
  - "[[wiki/home]]"
---

# Project Index

Create one subdirectory per active project and link architecture notes, decisions, and source material from the project overview.
EOF

    write_if_missing_rel "projects/_templates/_index.md" <<EOF
---
type: project
title: Project Overview Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - projects/template
status: seed
---

# Project Overview

## Summary

## Documentation

## Architecture

## Decisions

## Linked Sources
EOF
}

seed_domain_content() {
    local domain_root="${PROFILE_DOMAIN_ROOT}"
    local domain_label="${PROFILE_DOMAIN_LABEL}"
    local domain_type
    domain_type="$(domain_kind)"

    write_if_missing_rel "${domain_root}/active/index.md" <<EOF
---
type: ${domain_type}
title: Active ${domain_label}
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - ${domain_root}/active
status: seed
related:
  - "[[wiki/home]]"
---

# Active ${domain_label}

Create one file per active ${domain_type}. Move files into resolved/ when the work is complete.
EOF

    write_if_missing_rel "${domain_root}/resolved/index.md" <<EOF
---
type: ${domain_type}
title: Resolved ${domain_label}
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - ${domain_root}/resolved
status: seed
---

# Resolved ${domain_label}

Closed ${domain_label,,} live here. Link each one to a postmortem or follow-up review when more work is required.
EOF

    write_if_missing_rel "${domain_root}/postmortem/template.md" <<EOF
---
type: ${domain_type}
title: ${domain_label%?} Review Template
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - ${domain_root}/postmortem
status: seed
---

# ${domain_label%?} Review

## Summary

## Timeline

## Root Cause

## Follow-up Actions
EOF

    write_if_missing_rel "${domain_root}/dashboard.base" <<EOF
filters:
  and:
    - file.ext == "md"
    - or:
        - file.inFolder("${domain_root}/active")
        - file.inFolder("${domain_root}/resolved")
    - file.name != "index"
    - file.name != "template"
properties:
  file.name:
    displayName: ${domain_label%?}
  file.folder:
    displayName: State
  severity:
    displayName: Severity
  affected_services:
    displayName: Services
  start_time:
    displayName: Started
  end_time:
    displayName: Ended
  owner:
    displayName: Owner
views:
  - type: table
    name: Active ${domain_label}
    filters:
      and:
        - file.inFolder("${domain_root}/active")
    order:
      - severity
      - start_time
    properties:
      - file.name
      - severity
      - affected_services
      - start_time
      - owner
  - type: table
    name: Resolved ${domain_label}
    filters:
      and:
        - file.inFolder("${domain_root}/resolved")
    order:
      - end_time.desc
    properties:
      - file.name
      - severity
      - affected_services
      - end_time
      - owner
EOF
}

seed_oncall_content() {
    write_if_missing_rel "oncall/register/current.md" <<EOF
---
type: oncall
title: Current On-Call Roster
created: ${TODAY}
updated: ${TODAY}
author: system
tags:
  - oncall/register
status: seed
related:
  - "[[wiki/home]]"
team: platform
rotation_start: ${TODAY}
rotation_end: ${TODAY}
primary: unassigned
secondary: unassigned
---

# Current On-Call Roster

Update this file at the start of each rotation. Link active incidents and handover notes as needed.
EOF

    write_if_missing_rel "oncall/roster.base" <<EOF
filters:
  and:
    - file.ext == "md"
    - file.inFolder("oncall/register")
properties:
  file.name:
    displayName: Roster
  team:
    displayName: Team
  rotation_start:
    displayName: Start
  rotation_end:
    displayName: End
  primary:
    displayName: Primary
  secondary:
    displayName: Secondary
  status:
    displayName: Status
views:
  - type: table
    name: Current Roster
    order:
      - rotation_start.desc
    properties:
      - file.name
      - team
      - rotation_start
      - rotation_end
      - primary
      - secondary
      - status
EOF
}

seed_common_bases() {
    write_if_missing_rel "wiki/meta/dashboard.base" <<EOF
filters:
  and:
    - file.inFolder("wiki")
    - file.ext == "md"
    - file.name != "home"
formulas:
  related_count: "related ? related.length : 0"
properties:
  file.name:
    displayName: Note
  type:
    displayName: Type
  status:
    displayName: Status
  updated:
    displayName: Updated
  tags:
    displayName: Tags
  formula.related_count:
    displayName: Links
  file.path:
    displayName: Path
views:
  - type: table
    name: Overview
    order:
      - updated
      - file.name
    properties:
      - file.name
      - type
      - status
      - updated
      - formula.related_count
      - tags
EOF

    {
        cat <<EOF
filters:
  and:
    - file.ext == "md"
    - or:
        - file.inFolder("activity")
        - file.inFolder("wiki")
        - file.inFolder("sources")
EOF
        if has_app architecture; then
            printf '%s\n' '        - file.inFolder("architecture")'
        fi
        if has_app projects; then
            printf '%s\n' '        - file.inFolder("projects")'
        fi
        if has_app sites; then
            printf '%s\n' '        - file.inFolder("sites")'
        fi
        if has_app runbooks; then
            printf '%s\n' '        - file.inFolder("runbooks")'
        fi
        if (( PROFILE_ENABLE_ONCALL )); then
            printf '%s\n' '        - file.inFolder("oncall")'
        fi
        if [[ -n "${PROFILE_DOMAIN_ROOT}" ]]; then
            printf '        - file.inFolder("%s")\n' "${PROFILE_DOMAIN_ROOT}"
        fi
        cat <<'EOF'
formulas:
  touched: 'file.mtime.format("YYYY-MM-DD HH:mm")'
properties:
  file.name:
    displayName: Note
  file.folder:
    displayName: Folder
  file.mtime:
    displayName: Modified
  type:
    displayName: Type
  status:
    displayName: Status
  author:
    displayName: Author
views:
  - type: table
    name: Recent Changes
    limit: 25
    order:
      - file.mtime.desc
    properties:
      - file.name
      - file.folder
      - file.mtime
      - type
      - status
      - author
EOF
    } | write_if_missing_rel "wiki/meta/recent-activity.base"
}

seed_profile_content() {
    seed_home
    seed_wiki_index
    seed_active_topics
    seed_bootstrap_profile
    seed_activity_index
    seed_sources_index
    seed_sources_manifest
    seed_common_bases

    if (( PROFILE_ENABLE_ARCHITECTURE )); then
        seed_architecture_index
    fi
    if (( PROFILE_ENABLE_SITES )); then
        seed_sites_content
    fi
    if (( PROFILE_ENABLE_RUNBOOKS )); then
        seed_runbooks_content
    fi
    if (( PROFILE_ENABLE_PROJECTS )); then
        seed_projects_content
    fi
    if [[ -n "${PROFILE_DOMAIN_ROOT}" ]]; then
        seed_domain_content
    fi
    if (( PROFILE_ENABLE_ONCALL )); then
        seed_oncall_content
    fi
}

print_summary() {
    printf 'Bootstrapped profile: %s (%s)\n' "${PROFILE_NAME}" "${PROFILE_ID}"
    printf 'Content root: %s\n' "${MOUNT_DIR}"
    if [[ -d "${MOUNT_DIR}/.build" ]]; then
        printf 'Bootstrap mode: mounted wiki root (.build detected)\n'
    else
        printf 'Bootstrap mode: local sync folder; push from the Obsidian plugin to initialize the database\n'
    fi

    if [[ ${#CREATED_APPS[@]} -gt 0 ]]; then
        printf 'App roots created: %s\n' "$(join_by ', ' "${CREATED_APPS[@]}")"
    else
        printf 'App roots created: none\n'
    fi

    if [[ ${#CREATED_DIRS[@]} -gt 0 ]]; then
        printf 'Directories created: %s\n' "${#CREATED_DIRS[@]}"
    else
        printf 'Directories created: none\n'
    fi

    if [[ ${#CREATED_FILES[@]} -gt 0 ]]; then
        printf 'Seed files created: %s\n' "${#CREATED_FILES[@]}"
    else
        printf 'Seed files created: none\n'
    fi

    if [[ ${#SKIPPED_FILES[@]} -gt 0 ]]; then
        printf 'Existing files left untouched: %s\n' "${#SKIPPED_FILES[@]}"
    else
        printf 'Existing files left untouched: none\n'
    fi
}

main() {
    parse_args "$@"
  MOUNT_DIR="$(normalize_mount_dir "$MOUNT_DIR")"
    load_profile
    require_content_root

    local app
    local relative_dir

    for app in "${PROFILE_APPS[@]}"; do
        create_app "$app" "markdown,history"
    done

    for relative_dir in "${PROFILE_DIRS[@]}"; do
        ensure_dir "$relative_dir"
    done

    seed_profile_content
    print_summary
}

main "$@"
