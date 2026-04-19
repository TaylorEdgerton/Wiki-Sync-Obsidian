# Wiki Sync for Obsidian

## Introduction

Wiki Sync for Obsidian connects your vault to a PostgreSQL 18 + TimescaleDB-backed wiki, syncing Markdown into a dedicated subfolder for local-first, multi-user editing. It supports clone, pull, push, and full sync operations, notifies you of remote changes, and enables powerful AI-assisted wiki querying and administration through profile-aware Claude and Codex workspace skills.

The database side currently targets **PostgreSQL 18** with the **TimescaleDB extension** installed in the target database. PostgreSQL 18 is used for the wiki history IDs, and TimescaleDB is required for the history tables that preserve previous file versions.

The plugin supports two authentication paths:

- `oidc`: browser-based PKCE login against an OIDC provider, then JWT-backed access through `pg-oidc-proxy.py`
- `local`: direct PostgreSQL connection details for local development or trusted environments, with the database password stored through Obsidian SecretStorage

## Requirements

- Obsidian Desktop `1.11.4` or newer
- PostgreSQL 18 (PG18)
- TimescaleDB installed and enabled in the target database
- Optional: Python `markitdown` for document import actions

## Repository Layout

- `wiki-sync/`: the Wiki Sync plugin source, including `manifest.json`, `main.js`, templates, and build scripts
- `bootstrap-wiki.sh`: bootstrap script for Git Bash and Unix-like shells
- `bootstrap-wiki.cmd`: Windows wrapper for running the bootstrap from PowerShell or Command Prompt
- `bootstrap-profiles/`: profile definitions used by `bootstrap-wiki.sh`
- `pg-oidc-proxy.py`: optional PostgreSQL proxy that validates OIDC JWTs before forwarding connections

## What It Does

- syncs a PostgreSQL-backed wiki into a vault subdirectory as Markdown files
- supports OIDC and direct local auth modes
- clones, pulls, pushes, and syncs directly against PostgreSQL 18 with TimescaleDB-backed history
- provides action-oriented status bar controls inside Obsidian, including `Pull Changes`, `Push Changes`, `Sync Changes`, and reconnect/check states when remote changes must be verified again
- tracks live remote changes while connected and re-checks remote state after reconnecting
- lets you inspect remote history snapshots for synced files
- imports supported documents into the sync folder through `markitdown`
- initializes AI scaffold files (instruction docs and skill entrypoints) into the vault root for use by Claude Code and Codex
- is packaged as a single-file plugin bundle for easy Windows deployment

## Installation

1. Build the plugin bundle or copy the generated `wiki-sync/release/wiki-sync/` directory into your vault's `.obsidian/plugins/wiki-sync/` directory.
2. Or download the release and extract it into the .obsidian/plugins directory of your vault.
3. Use Obsidian Desktop `1.11.4` or newer so the plugin can use `SecretStorage` for local database passwords.
4. Prepare a PostgreSQL 18 database with the TimescaleDB extension enabled.
5. Restart Obsidian or reload community plugins.
6. Enable `Wiki Sync` in Obsidian's Community Plugins settings.
7. Configure either OIDC or local PostgreSQL settings in the plugin settings tab.

## Sync Workflow

- `Clone wiki` creates the initial local mirror from the database and writes the sync manifest.
- `Pull wiki changes` fetches remote changes into the vault. If a remote file was deleted and the local tracked copy had not been changed, the completion notice reports it as `deleted locally`.
- `Push wiki changes` writes local changes back to PostgreSQL. If a tracked local file was deleted and that delete is pushed upstream, the completion notice reports it as `deleted remotely`.
- `Sync wiki` runs pull first, then push.
- The sync status text now describes the next click action instead of showing a generic pending state:
	- `Pull Changes`: remote changes are waiting; click pulls only.
	- `Push Changes`: local changes are waiting; click pushes only.
	- `Sync Changes`: both local and remote changes are pending; click runs pull then push.
	- `Reconnect to Check` or `Check Changes`: the plugin cannot currently verify remote state and needs to reconnect or re-check before it can determine whether a pull is needed.
- The sync hover tooltip includes a `Click` hint that explains what the current status-bar action will do.

## Bootstrap on Windows

Run the bootstrap against the configured wiki sync folder. In direct database mode this creates local starter files and folders; after it completes, use **Push Local Wiki** in Obsidian to initialize the database and push the scaffold.

From PowerShell or Command Prompt:

```powershell
.\bootstrap-wiki.cmd --mount "C:\path\to\vault\wiki" --profile on-call-operations
```

From Git Bash:

```sh
./bootstrap-wiki.sh --mount "C:/path/to/vault/wiki" --profile on-call-operations
```

## MarkItDown Requirement

Document import requires Python `markitdown` to be installed on the machine running Obsidian:

```sh
pip install markitdown
```

or for all conversion methods:

```sh
pip install markitdown[all]
```

For PDF import specifically, install the PDF extras:

```sh
pip install "markitdown[pdf]"
```

If it is missing, the Wiki Sync folder right-click import actions stay visible but immediately show an install error instead of running a conversion.

## Wiki Structure

`bootstrap-wiki.sh` and `bootstrap-wiki.cmd` support four workspace profiles:

| Profile | Workspace shape |
|---|---|
| `minimal` | Core wiki, architecture, sources, and activity areas for a fresh wiki workspace |
| `project-wiki` | `minimal` plus `projects/` and an `issues/` work queue |
| `multi-site-operations` | `project-wiki` plus `sites/` and `runbooks/` for multi-environment operations |
| `on-call-operations` | `multi-site-operations` plus `oncall/` and `incidents/`; this is the default profile |

Once the wiki database is bootstrapped, the exact directory set depends on the selected profile. The file tree below shows the `on-call-operations` profile after a full Wiki Sync clone:

```
mount/
├── wiki/                        # knowledge base
│   ├── home.md                  # landing page — rebuilt by the homepage skill
│   ├── index.md                 # compiled note index — rebuilt by wiki-lint
│   ├── concepts/                # reusable concepts and definitions
│   ├── entities/                # people, systems, services
│   ├── comparisons/             # side-by-side analyses
│   ├── questions/               # Q&A notes saved from sessions
│   ├── canvases/                # Obsidian canvas maps
│   └── meta/                    # active-topics, lint reports, base views
├── sites/                       # one subdirectory per customer or managed site
├── runbooks/                    # operational procedures
├── architecture/                # technical decisions and platform maps
│   └── decisions/               # ADR-style notes
├── projects/                    # active project spaces
├── sources/                     # immutable source material (do not edit after ingest)
│   ├── articles/
│   ├── images/
│   └── tickets/
├── oncall/
│   ├── register/current.md      # active roster
│   └── handover/                # shift handover notes
├── incidents/
│   ├── active/                  # open incidents
│   ├── resolved/                # closed incidents
│   └── postmortem/              # follow-up reviews
├── activity/                    # append-only structural change log
└── skills/                      # shared AI skill files (read by agents via mount/)
```

## Initialize AI Scaffold

The plugin settings tab includes a `Scaffold profile` selector and an **Initialize AI scaffold** action. The scaffold profiles mirror the `bootstrap-wiki.sh` profiles so the generated instruction files match the mounted workspace shape:

| Scaffold profile | AI scaffold focus |
|---|---|
| `minimal` | Core wiki guidance for a general workspace without issue or on-call queues |
| `project-wiki` | Project-focused guidance with issue-oriented workflow instructions |
| `multi-site-operations` | Operations guidance for sites, runbooks, projects, and issue queues |
| `on-call-operations` | Incident-response guidance for live support, handover, and on-call work; includes the `oncall` skill |

Click **Initialize AI scaffold** to generate instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) at the vault root and skill entrypoints under `.claude/skills/` and `.agents/skills/`. Re-running is safe — existing files are refreshed, nothing else in the vault is touched.

All scaffold profiles include the common wiki skills below. The `oncall` skill is only generated for the `on-call-operations` scaffold profile.

### Skills

| Skill | What it does |
|---|---|
| `wiki` | Orchestrates wiki sessions — routes requests to the right sub-skill and maintains overall wiki state |
| `wiki-ingest` | Turns a source document or URL into structured wiki knowledge: converts, sanitizes, and files it |
| `wiki-query` | Answers questions from wiki content and optionally saves the answer back as a new note |
| `wiki-lint` | Audits wiki quality: checks links, frontmatter, tag consistency, and rebuilds compiled indexes |
| `save` | Preserves durable insights from a conversation or session as a note in the wiki |
| `canvas` | Creates or updates Obsidian canvas files for visual maps of wiki content |
| `oncall` | Only in `on-call-operations`: manages on-call rosters, active incidents, shift handovers, and postmortems |
| `homepage` | Rebuilds `mount/wiki/home.md` as a fresh landing page reflecting current wiki state |
| `obsidian-bases` | Designs `.base` files for live filtered views over the wiki inside Obsidian |
| `obsidian-markdown` | Style and syntax reference for notes written into the wiki |

## Windows Notes

Wiki Sync is intended to run with a normal Windows Obsidian install and Windows-visible mount paths.

Once Obsidian is running, you can use the right click open vault in VS Code or Claude Code at the vault path to query and work with your wiki and Markdown data using the generated wiki skills.

# Development 

## Git Hooks

This repo includes a versioned `pre-push` hook under `.githooks/pre-push`.

- Every `git push` builds a fresh plugin bundle from `wiki-sync/`.
- If the current `wiki-sync/manifest.json` version does not already exist as a remote tag, the hook prompts whether to create and push a new `v<version>` tag and publish a GitHub release.
- Release publishing uses GitHub CLI (`gh`). If `gh` is not installed, the hook still pushes the tag and skips the GitHub release step with a warning.

Install the hook path with either:

```sh
./scripts/install-git-hooks.sh
```

or on Windows:

```powershell
.\scripts\install-git-hooks.cmd
```

## Bundled Release Build

If your Windows Obsidian environment cannot or should not run `npm install`, build a self-contained plugin bundle from any machine with Node.js. The build output bundles the PostgreSQL client into `main.js`, so Windows only needs the generated plugin files and does not need a separate `node_modules/pg` install.

From `wiki-sync/` run:

```sh
npm ci
npm run build
```

That writes a release bundle to `release/wiki-sync/`.

To write the bundle directly into a vault plugin folder, set `WIKI_SYNC_OUT_DIR`:

```sh
WIKI_SYNC_OUT_DIR=/absolute/path/to/<vault>/.obsidian/plugins/wiki-sync npm run build
```

From PowerShell, the equivalent is:

```powershell
$env:WIKI_SYNC_OUT_DIR = 'C:\Users\<you>\<vault>\.obsidian\plugins\wiki-sync'
npm run build
```

The build only replaces plugin-managed files (`main.js`, `manifest.json`, `LICENSE`, and `templates/`). It intentionally leaves files such as `data.json` in place.

# License

MIT. See `wiki-sync/LICENSE`.
