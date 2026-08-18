---
page_type: sample
languages:
  - azdeveloper
  - nodejs
  - typescript
  - bicep
  - html
  - css
products:
  - azure
  - azure-container-apps
  - azure-container-registry
  - azure-key-vault
  - azure-monitor
  - ai-services
  - github
urlFragment: copilot-sdk-service
name: idea2Impact Agent — Outline, Project Overview, Slides, Speech, and Video with GitHub Copilot SDK
description: A full-stack TypeScript application that turns one approved outline into a traceable project overview, slides, speaker notes, and refined demo video.
---
<!-- YAML front-matter schema: https://review.learn.microsoft.com/en-us/help/contribute/samples/process/onboarding?branch=main#supported-metadata-fields-for-readmemd -->

# idea2Impact Agent

[![Open in GitHub Codespaces](https://img.shields.io/static/v1?style=for-the-badge&label=GitHub+Codespaces&message=Open&color=brightgreen&logo=github)](https://codespaces.new/azure-samples/copilot-sdk-service)
[![Open in Dev Container](https://img.shields.io/static/v1?style=for-the-badge&label=Dev+Containers&message=Open&color=blue&logo=visualstudiocode)](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/azure-samples/copilot-sdk-service)

An idea-to-impact presentation workspace built with the
[GitHub Copilot SDK](https://github.com/github/copilot-sdk), Express, React, and
TypeScript. Users describe an idea and can optionally provide a GitHub repository.
Copilot summarizes repository evidence and conversationally refines the Problem
Statement, User Scenarios, and Solution in one central editable outline. Direct
edits autosave, and the user approves the complete outline once. Copilot then
creates a validated project overview, a content-sized presentation deck,
editable PowerPoint exports, and editable text-only speaker notes from the same
approved context. A filesystem project
manifest records the brief, outline revisions, project overview, slide model,
speaker notes, generated HTML, and source-asset lineage. Users then upload and
preserve an existing demo recording before conservatively accelerating frozen/silent
ranges, improve perceived picture clarity, preview the result, and download a new
MP4 without changing the source.

Add your own source code and leverage the Infrastructure as Code assets (written in Bicep) to get up and running quickly. The template supports three model paths: GitHub default, GitHub specific model, or Azure Bring Your Own Model (BYOM) with `DefaultAzureCredential`.

### Prerequisites

The following prerequisites are required to use this application. Please ensure that you have them all installed locally.

| Tool | Version | Purpose |
|------|---------|---------|
| [Azure Developer CLI (`azd`)](https://aka.ms/azd-install) | Latest | Provisions and deploys Azure resources |
| [Node.js](https://nodejs.org/) | 24+ | Runtime for the API and build tooling |
| [pnpm](https://pnpm.io/) | 10+ | Fast, disk-efficient package manager |
| [GitHub CLI (`gh`)](https://cli.github.com/) | Latest | Provides the `GITHUB_TOKEN` for the Copilot SDK |
| [Docker](https://docs.docker.com/get-docker/) | Latest | Required for Azure deployment (container builds) |
| [FFmpeg](https://ffmpeg.org/) | 6+ | Local video inspection, inactivity detection, enhancement, and rendering |

**GitHub CLI setup:**

```bash
gh auth login
gh auth refresh --scopes copilot
```

### Quickstart

To learn how to get started with any template, follow the steps in [this quickstart](https://learn.microsoft.com/azure/developer/azure-developer-cli/get-started?tabs=localinstall&pivots=programming-language-nodejs) with this template (`Azure-Samples/copilot-sdk-service`).

This quickstart will show you how to authenticate on Azure, initialize using a template, provision infrastructure and deploy code on Azure via the following commands:

```bash
# Log in to azd. Only required once per-install.
azd auth login

# First-time project setup. Initialize a project in the current directory, using this template.
azd init --template Azure-Samples/copilot-sdk-service

# Provision and deploy to Azure
azd up
```

### Project Overview

This application utilizes the following Azure resources:

- [**Azure Container Apps**](https://docs.microsoft.com/azure/container-apps/) to host the API backend and web frontend
- [**Azure Container Registry**](https://docs.microsoft.com/azure/container-registry/) for Docker image storage
- [**Azure Key Vault**](https://docs.microsoft.com/azure/key-vault/) for securing the `GITHUB_TOKEN`
- [**Azure Monitor**](https://docs.microsoft.com/azure/azure-monitor/) for monitoring and logging
- [**Azure OpenAI**](https://docs.microsoft.com/azure/ai-services/openai/) *(optional)* for Bring Your Own Model (BYOM)

Here's a high-level project overview that illustrates these components. They are all contained within a single [resource group](https://docs.microsoft.com/azure/azure-resource-manager/management/manage-resource-groups-portal), created when you provision the resources.

> This template provisions resources to an Azure subscription that you will select upon provisioning them. Please refer to the [Pricing calculator for Microsoft Azure](https://azure.microsoft.com/pricing/calculator/) and, if needed, update the included Azure resource definitions found in `infra/main.bicep` to suit your needs.

### Application Code

The template is structured to follow the [Azure Developer CLI](https://aka.ms/azure-dev/overview) conventions. You can learn more about `azd` architecture in [the official documentation](https://learn.microsoft.com/azure/developer/azure-developer-cli/make-azd-compatible?pivots=azd-create#understand-the-azd-architecture).

- **Backend** (`src/api/`) — Express API with project manifests, versioned outline
  drafts and approval, streaming collaboration chat, validated project overview,
  slide visuals, variable-length HTML and image-based PPTX export, speaker-note
  generation, separate recording upload, and FFmpeg/FFprobe refinement.
- **Frontend** (`src/web/`) — React workspace with guided idea intake, workflow
  Q&A, a central autosaved outline with one approval, project overview and slide
  previews, editable speaker notes, HTML/PPTX downloads, and non-destructive
  video refinement controls.

The implemented path is:

**Describe idea/codebase → Refine outline → Review/edit summary → Approve outline
→ Generate slides → Generate speaker notes → Upload recording → Refine recording**

The generated deck covers Problem Statement, User Scenarios, and Solution using
as many slides as the content needs, and is available as HTML and an image-based
`.pptx` with one full-slide PNG per page. Object-level editable slide conversion
is deferred. A separate editable project overview `.pptx` remains available.

Video uploads are streamed to isolated, random job folders instead of being held
in memory. The source and refined output remain separate, expired jobs are
removed automatically, and concurrent renders are bounded. Configure
`MAX_VIDEO_UPLOAD_MB`, `MAX_CONCURRENT_VIDEO_JOBS`, `VIDEO_JOB_TTL_HOURS`, or
`VIDEO_WORK_DIR` to adjust runtime limits.

## How It Works (Copilot SDK)

This template supports three model paths:

### GitHub Default (no config)
```typescript
const session = await client.createSession({});
const result = await session.sendAndWait({ prompt: "Hello" });
```

### GitHub Specific Model
```typescript
const session = await client.createSession({ model: "gpt-4o" });
```

### Azure BYOM (Bring Your Own Model)
```typescript
import { DefaultAzureCredential } from "@azure/identity";
const credential = new DefaultAzureCredential();
const { token } = await credential.getToken("https://cognitiveservices.azure.com/.default");

const session = await client.createSession({
  model: process.env.MODEL_NAME,
  provider: {
    type: "azure",
    baseUrl: process.env.AZURE_OPENAI_ENDPOINT,
    bearerToken: token,
  },
});
```

Configure via environment variables: `MODEL_PROVIDER`, `MODEL_NAME`, `AZURE_OPENAI_ENDPOINT`. See `src/api/model-config.ts`.

### Local and Hosted Agent Routing

In Azure, the Presentation API does not call the Copilot model directly. It
invokes the Microsoft Foundry Hosted Agent, whose Node.js container creates
GitHub Copilot SDK sessions:

```text
Browser
  -> Presentation API
  -> Microsoft Foundry Hosted Agent
  -> GitHub Copilot SDK component
  -> GitHub Copilot model service
```

`src/api/hosted-agent-client.ts` implements the API-to-Foundry call.
`src/hosted-agent/client.ts` creates the `CopilotClient`, and
`src/hosted-agent/index.ts` translates Foundry invocation requests into Copilot
SDK session calls. The Hosted Agent is therefore the hosted orchestration
runtime, not the model.

In generated project overviews, the required modeling is:

- **GitHub** is the platform.
- **GitHub Copilot SDK** is a component assigned to the GitHub platform.
- **Microsoft Foundry Hosted Agent** is a separate component that calls the
  GitHub Copilot SDK component.

The approved **Solution** outline also summarizes this information in prose: it
names the material platforms, their key toolings/components, and the high-level
directional calls between them rather than listing capabilities alone.

For structured operations, the Hosted Agent returns a JSON **candidate**. The
Presentation API extracts and parses that content, runs an operation-specific
validator, and stores it only after validation succeeds. Invalid output receives
one bounded repair attempt using validator feedback; a second failure is
returned as an error. See
[`docs/foundry-hosted-agent-architecture.md`](docs/foundry-hosted-agent-architecture.md#how-structured-json-becomes-validated-json)
for the complete flow and architecture-graph validation rules.

Local development uses the API's local Copilot SDK sessions by default, even if
`PRESENTATION_AGENT_INVOCATIONS_ENDPOINT` is present in the selected azd
environment. This path does not require a Foundry role assignment.

- A loopback endpoint (`http://localhost` or `http://127.0.0.1`) enables local
  hosted-agent integration.
- Azure deployment explicitly enables the configured remote Hosted Agent
  endpoint with `USE_HOSTED_AGENT=true`.
- Set `USE_HOSTED_AGENT=true` to explicitly use a remote Hosted Agent locally,
  or `USE_HOSTED_AGENT=false` to force local Copilot SDK sessions.

### Testing Each Model Path

All three paths can be tested locally. Set the environment variables before running the service.

You can run with either [`azd app run`](https://github.com/jongio/azd-app) (starts both API and web UI) or `pnpm dev` (API only):

**1. GitHub Default (no config needed)**

No environment variables required — the SDK picks its default model:

```bash
# Option A: azd app run (recommended — starts API + web UI, auto-installs deps)
azd app run

# Option B: manual
export GITHUB_TOKEN=$(gh auth token)
cd src/api && pnpm dev
```

**2. GitHub Specific Model**

The idea2Impact Agent defaults to `gpt-5.6-sol` for Copilot SDK code, JSON,
and HTML/CSS generation. Set `MODEL_NAME` to override it with another
GitHub-hosted model:

```bash
# Option A: azd app run
azd env set MODEL_NAME gpt-4o
azd app run

# Option B: manual
export GITHUB_TOKEN=$(gh auth token)
export MODEL_NAME=gpt-4o
cd src/api && pnpm dev
```

**3. Azure BYOM (Bring Your Own Model)**

Set `MODEL_PROVIDER=azure` along with your Azure OpenAI endpoint and deployment name. Authentication uses `DefaultAzureCredential`, so make sure you're logged in with `az login`:

```bash
# Option A: azd app run
az login
azd env set MODEL_PROVIDER azure
azd env set MODEL_NAME <your-deployment-name>
azd env set AZURE_OPENAI_ENDPOINT https://<your-resource>.openai.azure.com
azd app run

# Option B: manual
export GITHUB_TOKEN=$(gh auth token)
export MODEL_PROVIDER=azure
export MODEL_NAME=<your-deployment-name>
export AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
az login
cd src/api && pnpm dev
```

**Verify any path with:**

```bash
curl -X POST http://localhost:3100/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

### Local Development

The easiest way to run locally is with [`azd app`](https://github.com/jongio/azd-app), which starts all services, installs dependencies, and provides a real-time dashboard:

On Windows, run the authentication bootstrap first. Dot-sourcing keeps the
restored GitHub and Azure environment variables in the current PowerShell
session:

```powershell
. .\scripts\setup-local-auth.ps1 -EnvironmentName copilot-sdk-presentation-agent
```

```bash
# Install the azd app extension (one-time)
azd extension source add -n jongio -t url -l https://jongio.github.io/azd-extensions/registry.json
azd extension install jongio.azd.app

# Run locally
azd app run
```

The `prerun` hook automatically retrieves your `GITHUB_TOKEN` from the `gh` CLI via `scripts/get-github-token.mjs`. Open the URL shown in the dashboard output to start testing.

<details>
<summary><b>Run services manually (without azd app)</b></summary>

```bash
# Set your GitHub token
export GITHUB_TOKEN=$(gh auth token)

# Install dependencies
cd src/api && pnpm install && cd ../web && pnpm install && cd ../..

# Start the API server (in one terminal)
cd src/api && pnpm dev

# Start the web dev server (in another terminal)
cd src/web && pnpm dev
```

</details>

| Command | Directory | Description |
|---------|-----------|-------------|
| `azd app run` | repo root | Start all services with auto-dependency install and dashboard |
| `pnpm dev` | `src/api` | Start the Express server with hot reload (via `tsx --watch`) |
| `pnpm dev` | `src/web` | Start the Vite dev server with HMR for the React frontend |
| `pnpm build` | `src/api` | Compile the Express server |
| `pnpm build` | `src/web` | Bundle the React frontend |

## Adding Endpoints

Endpoints are Express routes that use the Copilot SDK for one-shot AI processing. To add a new endpoint:

**1. Create a route file in `src/api/routes/`:**

```typescript
// src/api/routes/classify.ts
import { Router } from "express";
import { CopilotClient } from "@github/copilot-sdk";

const router = Router();

router.post("/classify", async (req, res) => {
  const client = new CopilotClient({ githubToken: process.env.GITHUB_TOKEN });
  const { getSessionOptions } = await import("../model-config.js");
  const options = await getSessionOptions();
  const session = await client.createSession(options);
  const result = await session.sendAndWait({
    prompt: `Classify the following text into a category:\n\n${req.body.text}`,
  });
  res.json({ category: result?.data?.content });
});

export default router;
```

**2. Register the route in `src/api/index.ts`:**

```typescript
import classifyRoutes from "./routes/classify.js";

app.use(classifyRoutes);
```

**3. Add a proxy rule in `src/web/nginx.conf.template`** (for production):

```nginx
location /classify {
    proxy_pass ${API_URL}/classify;
    proxy_http_version 1.1;
    proxy_set_header Host $proxy_host;
}
```

## Testing

### Integration Tests

Integration tests live in `tests/integration/` and use **Vitest** to verify all 3 model configuration paths:

```bash
# Run from the integration test directory
cd tests/integration && pnpm install && pnpm test

# Or from src/api
cd src/api && pnpm test:models
```

Run the explicit live presentation E2E test against an already-running local
API. This test performs real model, GitHub, image, Speech, and FFmpeg calls, so
it is intentionally excluded from the default integration suite:

```powershell
$env:PRESENTATION_E2E_BASE_URL = "http://127.0.0.1:3000"
cd tests\integration
pnpm test:presentation-e2e
```

Evidence is written to `tests/integration/artifacts/presentation-e2e/`. Override
that location with `PRESENTATION_E2E_OUTPUT_DIR`.

**What it tests:**
- ✅ GitHub Default model (no config)
- ✅ GitHub Specific model (`MODEL_NAME=gpt-4o`)
- ✅ Azure BYOM (auto-skipped if not configured)

**Prerequisites:**
- `GITHUB_TOKEN` — required for all tests (auto-resolved from `gh auth token` if not set)
- `AZURE_MODEL_NAME` and `AZURE_OPENAI_ENDPOINT` — optional, for Azure BYOM tests

**Local usage:** When running locally without Azure env vars, an interactive prompt offers to load values from `azd` environments or run `azd up`. To skip Azure tests, just don't set the Azure env vars.

**CI usage:** Set env vars (`GITHUB_TOKEN`, `AZURE_OPENAI_ENDPOINT`, `AZURE_MODEL_NAME`, `CI=true`) and run — no interactive prompts.

See [`scripts/README.md`](scripts/README.md) for detailed setup instructions.

## Deploy to Azure

```bash
azd up
```

This single command handles the entire deployment pipeline:

1. **Preprovision hook** — Retrieves your `GITHUB_TOKEN` from the `gh` CLI and stores it in the `azd` environment
2. **Provisions infrastructure** — Creates Azure Container Registry, Container Apps Environment, Key Vault, Application Insights, managed identities, and the Microsoft Foundry project integration (using [Azure Verified Modules](https://azure.github.io/Azure-Verified-Modules/))
3. **Builds and pushes** — Builds the Docker images and pushes them to the provisioned ACR
4. **Deploys** — Deploys the API and web containers to Azure Container Apps and the optional idea2Impact hosted-agent container to Microsoft Foundry, with secrets referenced from Key Vault

### Verify Deployed App

After deploying, verify the live app:

```bash
export AZURE_CONTAINER_APP_WEB_URL=$(azd env get-value AZURE_CONTAINER_APP_WEB_URL)
cd src/api && pnpm test:deployed
```

### Next Steps

At this point, you have a complete application deployed on Azure. But there is much more that the Azure Developer CLI can do. These next steps will introduce you to additional commands that will make creating applications on Azure much easier. Using the Azure Developer CLI, you can setup your pipelines, monitor your application, test and debug locally.

> Note: Needs to manually install [setup-azd extension](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.azd) for Azure DevOps (azdo).

- [`azd pipeline config`](https://learn.microsoft.com/azure/developer/azure-developer-cli/configure-devops-pipeline?tabs=GitHub) - to configure a CI/CD pipeline (using GitHub Actions or Azure DevOps) to deploy your application whenever code is pushed to the main branch.

- [`azd monitor`](https://learn.microsoft.com/azure/developer/azure-developer-cli/monitor-your-app) - to monitor the application and quickly navigate to the various Application Insights dashboards (e.g. overview, live metrics, logs)

- [Run and Debug Locally](https://learn.microsoft.com/azure/developer/azure-developer-cli/debug?pivots=ide-vs-code) - using Visual Studio Code and the Azure Developer CLI extension

- [`azd down`](https://learn.microsoft.com/azure/developer/azure-developer-cli/reference#azd-down) - to delete all the Azure resources created with this template

## Security

### Roles

This template creates a [managed identity](https://docs.microsoft.com/azure/active-directory/managed-identities-azure-resources/overview) for your app inside your Azure Active Directory tenant, and it is used to authenticate your app with Azure and other services that support Azure AD authentication like Key Vault via access policies. You will see principalId referenced in the infrastructure as code files, that refers to the id of the currently logged in Azure Developer CLI user, which will be granted access policies and permissions to run the application locally. To view your managed identity in the Azure Portal, follow these [steps](https://docs.microsoft.com/azure/active-directory/managed-identities-azure-resources/how-to-view-managed-identity-service-principal-portal).

### Key Vault

This template uses [Azure Key Vault](https://docs.microsoft.com/azure/key-vault/general/overview) to securely store your `GITHUB_TOKEN` for the provisioned Copilot SDK service. Key Vault is a cloud service for securely storing and accessing secrets (API keys, passwords, certificates, cryptographic keys) and makes it simple to give other Azure services access to them. As you continue developing your solution, you may add as many secrets to your Key Vault as you require.

## Reporting Issues and Feedback

If you have any feature requests, issues, or areas for improvement, please [file an issue](https://aka.ms/azure-dev/issues). To keep up-to-date, ask questions, or share suggestions, join our [GitHub Discussions](https://aka.ms/azure-dev/discussions). You may also contact us via AzDevTeam@microsoft.com.
