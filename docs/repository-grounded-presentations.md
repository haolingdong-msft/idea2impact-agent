# Repository-Grounded Presentations

## Decision

The idea is the only required onboarding field. Users may also provide a GitHub
repository URL, title, audience, and purpose.

Repository access belongs to the Presentation API. The API authenticates the
user, reads a bounded set of repository files through GitHub APIs, redacts
secret-like values, and produces a structured evidence asset. The Foundry Hosted
Agent receives that bounded evidence, never GitHub credentials or unrestricted
repository access.

## Flow

```text
Browser
  |
  | idea + optional GitHub URL
  v
Presentation API
  |\
  | \-- GitHub App OAuth / installation selection
  |       |
  |       v
  |     GitHub REST API
  |       - repository metadata and pinned commit
  |       - bounded tree and text reads
  |
  |---- Repository scanner
  |       - architecture-focused path ranking
  |       - content/type/size limits
  |       - secret redaction
  |       - evidence and citations
  |
  \---- Project asset store
          - repository evidence revision
          - selected paths and hashes
          - bounded snippets and warnings
          - no tokens or complete repository archive
                  |
                  v
          Foundry Hosted Agent
          - Problem Statement
          - User Story
          - Technical Architecture
          - Slide model
```

## GitHub authorization

- Public repositories may be scanned without GitHub login, subject to rate
  limits.
- Private repositories require a GitHub App installation selected by the current
  user.
- The App requests read-only repository metadata and contents.
- The API creates short-lived installation tokens server-side.
- OAuth state and application sessions use secure, HTTP-only, SameSite cookies.
- GitHub access tokens, installation tokens, App private keys, and client secrets
  never enter browser storage, project assets, prompts, logs, or telemetry.
- Every project and asset request is authorized against its owner.

### Configured GitHub App

- Owner: `haolingdong-msft`
- App ID: `4555260`
- Client ID: `Iv23liKK52dV3GOFvSsD`
- Local callback:
  `http://127.0.0.1:3000/auth/github/callback`
- Permissions: read-only repository Contents and Metadata
- Installation selection: controlled by the GitHub account owner
- Client secret: Key Vault secret
  `presentation-agent-github-client-secret`
- Private key: Key Vault secret
  `presentation-agent-github-private-key`
- Session signing key: Key Vault secret
  `presentation-agent-session-secret`

The API accepts either direct secret environment variables for local diagnostics
or the corresponding Key Vault secret URI variables. Secret values are never
committed. Rotate the client secret or private key in GitHub App settings, write
the new value as a new Key Vault secret version, restart the API, verify login
and one private scan, then revoke the old GitHub credential. Uninstalling the
App immediately revokes repository access; logging out clears the local
application session.

The local setup helper at `/auth/github/app/setup` is disabled in production.
Production must set `SESSION_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CALLBACK_URL`, `GITHUB_APP_CLIENT_SECRET_URI`, and
`GITHUB_APP_PRIVATE_KEY_SECRET_URI`, with only the Presentation API managed
identity granted secret read access.

## Scan contract

Each scan pins the requested branch or ref to a commit SHA and applies
deterministic limits. It prioritizes:

- README files, documentation, ADRs, and architecture specifications
- package/workspace manifests and service entry points
- API routes, schemas, data models, and integration clients
- Dockerfiles, deployment manifests, infrastructure-as-code, and CI topology

It excludes dependencies, build outputs, generated/minified files, lockfile
bodies, binaries, archives, media, and likely secrets. Repository code is never
executed.

The evidence asset contains repository identity, commit SHA, selected paths,
content hashes, bounded redacted snippets, detected technologies, components,
interfaces, persistence, deployment, integrations, relationships, gaps,
truncation details, and warnings.

The browser receives only repository identity, commit, selected-file count,
truncation state, technology signals, and warnings. File excerpts remain in the
server-side project evidence asset and bounded Hosted Agent payload.

## Agent grounding

Repository evidence can prefill the three story sections, but does not bypass
approval. The user must still approve:

1. Problem Statement
2. User Story
3. Architecture

Repository-derived claims retain file-path citations. User statements and
repository evidence are distinguished from assumptions. Missing product intent
or unclear system boundaries trigger focused questions.

## Security and failure behavior

- Only `https://github.com/<owner>/<repository>` and supported
  `/tree/<ref>/<path>` URLs are accepted.
- Credentials in URLs, alternate hosts, traversal, and ambiguous forms are
  rejected.
- The scanner does not follow arbitrary links found in repository content.
- Rate limits, inaccessible installations, oversized repositories, truncated
  scans, moved/deleted repositories, and stale evidence are surfaced explicitly.
- A rescan at a different commit creates a new evidence revision and invalidates
  current architecture and slides without deleting history.

## Initial acceptance criteria

- A user can start with only an idea.
- Optional title, audience, purpose, and repository URL do not block submission.
- A public repository produces cited evidence without login.
- A private repository requires the user's authorized GitHub App installation.
- The generated story, architecture, and slides identify their evidence commit.
- No GitHub token or complete private source file is persisted or sent to the
  Hosted Agent.
- Cross-user project and evidence access is denied.
