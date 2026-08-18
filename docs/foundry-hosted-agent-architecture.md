# Idea2Impact Agent on Microsoft Foundry Hosted Agents

## Decision

The Idea2Impact Agent can run on Microsoft Foundry Hosted Agents, but the
current web/API container cannot be registered unchanged.

The GitHub Copilot SDK orchestration runs as a **custom Node 24 Hosted Agent**
using Foundry's `invocations` protocol. The React UI, project API, HTML rendering,
durable assets, and FFmpeg video processing remain Azure Container Apps
responsibilities.

For project overview modeling, **GitHub is a platform**, **GitHub Copilot SDK is
a component assigned to that platform**, and the **Microsoft Foundry Hosted
Agent is a separate component that calls the SDK**. The production request chain
is:

```text
Microsoft Foundry platform                 GitHub platform
+-------------------------------+          +-----------------------------+
| Hosted Agent component        |  calls   | GitHub Copilot SDK component|
| - invocation adapter          |--------->| - CopilotClient             |
| - presentation instructions   |          | - createSession/send        |
+-------------------------------+          +--------------+--------------+
                                                             |
                                                             v
                                                Copilot model service
```

The API-to-Foundry gateway is implemented in
`src/api/hosted-agent-client.ts`. The Hosted Agent creates `CopilotClient` in
`src/hosted-agent/client.ts` and handles SDK sessions in
`src/hosted-agent/index.ts`.

## Deployment topology

```text
Browser
  |
  | HTTPS
  v
React Web Container App (public)
  |
  | internal REST + SSE
  v
Presentation API Container App (private)
  |\
  | \-- Azure Blob Storage
  |       - project manifests and approved content
  |       - architecture and slide assets
  |       - source and refined recordings
  |
  |---- FFmpeg
  |       - low-motion detection and acceleration
  |       - clarity filters and encoding
  |
  | Entra ID bearer token from managed identity
  v
Microsoft Foundry Hosted Agent endpoint
  |
  | invocations v2.0 (JSON or SSE)
  v
Node 24 custom container
  - Foundry invocations adapter
  - presentation instructions and structured generation
  |\
  | \-- managed identity --> Azure Key Vault
  |                         - scoped GitHub token
  |
  | calls
  v
GitHub platform
  - GitHub Copilot SDK component
      - CopilotClient / Copilot CLI subprocess
      - createSession(), send(), and sendAndWait()
  |
  | model request
  v
GitHub Copilot model service
```

## Component responsibilities

| Component | Technology | Responsibility |
|---|---|---|
| Web UI | React, Vite, Container Apps | Workflow, approvals, previews, uploads, and downloads |
| Presentation API | Express, TypeScript, Container Apps | Browser API, approval gates, asset lineage, rendering, media processing, and Hosted Agent gateway |
| Hosted Agent | Node 24 custom container, Microsoft Foundry | Invoke the GitHub Copilot SDK component for conversational orchestration and structured generation |
| Invocations adapter | HTTP, invocations 2.0 | Translate versioned JSON/SSE requests into Copilot SDK sessions |
| GitHub Copilot SDK | `@github/copilot-sdk`, Copilot CLI | Component on the GitHub platform that creates sessions and calls the Copilot model service |
| Blob Storage | Azure Storage | Durable manifests and immutable presentation assets |
| Key Vault | Azure Key Vault | Store the scoped GitHub Copilot token outside deployment configuration |
| Managed identities | Microsoft Entra ID | API-to-Foundry, API-to-Blob, and workload-to-Key Vault authentication |
| Observability | Application Insights and Foundry monitoring | Correlated traces, failures, latency, and deployment health |

The project overview generator must preserve these identities rather than
collapsing them into one node:

| Architecture object | Required representation |
|---|---|
| Platform | `GitHub` |
| Component | `GitHub Copilot SDK` |
| Calling component | `Microsoft Foundry Hosted Agent` |
| Directional relationship | `Hosted Agent -> GitHub Copilot SDK` |

## Invocation contract

The Hosted Agent exposes a versioned request envelope:

```json
{
  "version": "1.0",
  "operation": "chat",
  "requestId": "uuid",
  "input": {}
}
```

| Operation | Input | Output |
|---|---|---|
| `chat` | Message, validated history, workflow context | SSE text deltas and terminal event |
| `architecture` | Approved brief and story context | Architecture JSON candidate |
| `slides` | Approved story and validated architecture JSON | Slide model JSON candidate |

The Hosted Agent is stateless at this boundary. The Presentation API supplies
approved context, validates each returned JSON candidate, and stores only a
validated result.
Foundry session files are not durable project storage.

An OpenAPI document describes the request and response schemas. Unsupported
versions, invalid payloads, and unsupported operations return explicit 4xx
responses. Dependency, model, and timeout failures return correlated 5xx
responses without secrets or raw sensitive context.

## How structured JSON becomes validated JSON

The JSON is generated by the model but accepted through deterministic
application code. It is not considered valid merely because the Hosted Agent or
Copilot SDK returned it.

```text
Approved inputs
  -> schema-constrained Copilot prompt
  -> Hosted Agent returns a content string
  -> API extracts the outer JSON object
  -> JSON.parse()
  -> operation-specific validator
       - normalizes bounded strings
       - checks required fields and enum values
       - checks collection size limits
       - checks unique IDs and cross-references
       - checks graph and workflow consistency
  -> valid: persist and render
  -> invalid: send validator feedback for one repair attempt
       -> validate replacement JSON again
       -> still invalid: fail the request; do not persist
```

For project overview generation, the implementation is:

1. `ARCHITECTURE_GRAPH_PROMPT` in
   `src/api/presentation-instructions.ts` specifies the exact JSON shape and
   design constraints.
2. `extractJson()` in `src/api/routes/architecture.ts` removes an optional
   Markdown fence, selects the outer `{ ... }`, and calls `JSON.parse()`.
3. `validateArchitectureGraph()` builds the accepted `ArchitectureGraph` and
   enforces constraints including:
   - 2-4 layers, 1-3 nodes per layer, and at most 8 nodes;
   - unique component, platform, tooling, and workflow-step IDs;
   - allowed node kinds, tones, connection types, and provenance values;
   - 1-4 platforms with every non-actor component assigned exactly once;
   - toolings that reference components on the same platform;
   - 1-10 connections referencing real nodes, with at least one primary
     interaction and no disconnected technical components;
   - a 2-7 step workflow with contiguous ordering and valid
     platform/tooling/component references.
4. If validation fails, the API sends the bounded validation error and previous
   response back through either the Hosted Agent or the local Copilot SDK.
   `ARCHITECTURE_GRAPH_REPAIR_PROMPT` requests one complete replacement object.
5. The replacement passes through the same parser and validator. A second
   failure is surfaced as an error rather than stored as success-shaped data.

Equivalent validators handle outlines, slide decks, speech scripts, and
architecture HTML. The key trust boundary remains the same: model output is
untrusted until the Presentation API validator returns the typed value.

## Primary flows

### Story clarification

1. The browser posts a message to the Presentation API.
2. The API validates the message and history, then invokes Foundry with its
   managed identity.
3. The adapter creates a short-lived Copilot SDK session and streams deltas.
4. The API proxies SSE to the browser.
5. The browser reconstructs approval state; the API remains authoritative for
   generation gates.

### Architecture and slides

1. The API verifies all required approvals in the project manifest.
2. The API submits approved context to the Hosted Agent.
3. The Hosted Agent returns a structured JSON candidate.
4. The API parses and validates the candidate at the trust boundary, allowing
   one bounded repair attempt if validation fails.
5. The API stores a new Blob asset revision and renders escaped semantic HTML.
6. Architecture changes invalidate stale slide pointers without deleting source
   assets.

### Video refinement

1. The browser streams the source recording to the Presentation API.
2. The API stores an immutable source asset.
3. FFmpeg probes the file and detects low-motion intervals.
4. The API renders and stores a separate refined output with processing metadata
   and source lineage.
5. The Hosted Agent is not in the media data path.

## Trust boundaries

- The browser never receives a Foundry credential, GitHub token, storage key, or
  internal API endpoint.
- The public Web Container App reaches only the private Presentation API.
- The API uses a managed identity to invoke Foundry and access Blob Storage.
- The Hosted Agent has no Blob data role and cannot mutate approved assets.
- `GITHUB_TOKEN` is fetched from Key Vault with the Hosted Agent managed identity
  and is never committed, placed in an image, written as a literal in
  `azure.yaml`, or logged.
- Azure-hosted code uses deterministic managed identity credentials; local code
  may use `DefaultAzureCredential`.
- The API validates structured responses before rendering.
- Logs carry correlation IDs, not uploaded media, secrets, or asset bodies.

## Storage and consistency

The filesystem project store remains available for local development. Production
uses Blob Storage:

```text
projects/{projectId}/project.json
projects/{projectId}/assets/{assetType}-r{revision}.{format}
```

Manifest writes use ETags or equivalent serialization to prevent concurrent
revision loss. Source assets are immutable. Regeneration creates a new revision
and updates only current-asset pointers. Large media files are streamed.

## Deployment model

- Reuse `foundry-haoling-eus2/proj-default`.
- Pin Copilot SDK sessions to the available `gpt-5-mini` GitHub Copilot model;
  do not rely on an unspecified default model.
- Add one `host: azure.ai.agent` custom-container service with `invocations`
  protocol version `2.0.0`.
- Keep `api` and `web` as Container Apps.
- Keep FFmpeg only in the API image.
- Reuse the existing ACR, Key Vault, managed identity, and Application Insights
  where the project binding permits.
- Publish immutable Hosted Agent versions and retain the previous active version
  for rollback.

## Constraints

1. Foundry direct-code runtimes currently support Python and .NET, not Node.js.
   The Copilot SDK therefore requires a custom container.
2. Hosting the container in Foundry does not automatically route Copilot SDK
   calls to a Foundry model. The initial deployment keeps GitHub Copilot model
   behavior; Azure BYOM remains optional.
3. Container deployment requires Docker/Podman or an approved remote build path.
4. The local filesystem is not production-durable and must be replaced before a
   multi-replica deployment is complete.

## Rollout and rollback

1. Deploy the Blob-backed API while retaining local agent mode.
2. Run and invoke the Foundry adapter locally.
3. Publish and smoke-test an immutable Hosted Agent version.
4. Configure the API with that version's invocations endpoint.
5. Run the UI acceptance flow and verify cross-replica durability.
6. Roll back by restoring the previous agent endpoint/version and API revision;
   Blob source assets and revisions remain unchanged.

## Acceptance criteria

- Foundry reports an active Hosted Agent version with an `invocations` endpoint.
- Remote chat streams a valid response.
- Architecture and slide operations return schema-valid JSON.
- The browser reaches approved slides without browser-to-Foundry credentials.
- Video refinement remains deterministic and does not send media through the
  Hosted Agent.
- Project assets survive API restart and are readable from another replica.
- Traces correlate requests without exposing secrets or asset contents.

## Current deployment

| Property | Value |
|---|---|
| Foundry project | `foundry-haoling-eus2/proj-default` |
| Agent | `presentation-agent` |
| Active version | `6` |
| Protocol | `invocations` 2.0 |
| Copilot model | `gpt-5-mini` |
| Credential | `presentation-agent-copilot-token` in `kv-haoling-hackathon` |
| Endpoint | `https://foundry-haoling-eus2.services.ai.azure.com/api/projects/proj-default/agents/presentation-agent/endpoint/protocols/invocations?api-version=v1` |
| Playground | [Open version 6](https://ai.azure.com/nextgen/r/-qCAr8HYQK2czuGkUMpbVw,rg-haoling,,foundry-haoling-eus2,proj-default/build/agents/presentation-agent/build?version=6) |

Version 6 passed a remote SSE smoke test. Roll back by selecting the previous
active version in Foundry and restoring the corresponding API endpoint/version
configuration; presentation project assets are unaffected.
