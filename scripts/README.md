# Scripts

Utility scripts for the Copilot SDK Service.

## Integration Tests (formerly `test-models.mts`)

Integration tests have moved to `tests/integration/` and now use **Vitest**. The old `scripts/test-models.mts` script has been removed.

### Running Locally

From the integration test directory:
```bash
cd tests/integration && pnpm install && pnpm test
```

Or from the API directory:
```bash
cd src/api && pnpm test:models
```

### Running Against a Deployed App

Set the deployed app URL, then run:
```bash
export AZURE_CONTAINER_APP_WEB_URL=<your-deployed-url>
cd src/api && pnpm test:deployed
```

You can obtain the URL from azd:
```bash
export AZURE_CONTAINER_APP_WEB_URL=$(azd env get-value AZURE_CONTAINER_APP_WEB_URL)
```

### CI Usage

Set the required environment variables and run — there are no interactive prompts in CI:
```bash
export GITHUB_TOKEN=<token>
export AZURE_OPENAI_ENDPOINT=<endpoint-url>
export AZURE_MODEL_NAME=<deployment-name>
cd tests/integration && pnpm install && pnpm test
```

### Interactive Azure Setup (Local Only)

When running locally without Azure environment variables (`AZURE_OPENAI_ENDPOINT`, `AZURE_MODEL_NAME`), an interactive prompt will offer to load values from existing `azd` environments or run `azd up` to provision resources.

### Skipping Azure Tests

To skip Azure BYOM tests, simply don't set the Azure environment variables (`AZURE_OPENAI_ENDPOINT`, `AZURE_MODEL_NAME`). The tests use `describe.skipIf` and will be automatically skipped when those variables are absent.

## `get-github-token.mjs`

Helper script to obtain a GitHub token (implementation details vary by environment).

## `setup-local-auth.ps1`

Restores and validates all local authentication needed by Idea2Impact Agent:

- loads the selected `.azure/<environment>/.env` without printing secrets;
- obtains `GITHUB_TOKEN` from the authenticated GitHub CLI and verifies the
  `copilot` scope;
- verifies Azure CLI can issue a Cognitive Services token;
- configures Azure Speech to use the resource-specific
  `*.cognitiveservices.azure.com` endpoint required for Entra authentication;
- optionally configures `editppt` from `PADDLE_OCR_TOKEN`.

Dot-source the script before starting services manually so its process
environment remains in the current PowerShell session:

```powershell
. .\scripts\setup-local-auth.ps1 -EnvironmentName copilot-sdk-presentation-agent
cd src\api
pnpm dev
```

Use `-CheckOnly` to validate authentication without changing the azd
environment or `editppt` configuration:

```powershell
.\scripts\setup-local-auth.ps1 -EnvironmentName copilot-sdk-presentation-agent -CheckOnly
```
