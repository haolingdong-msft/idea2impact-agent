[CmdletBinding()]
param(
    [string]$EnvironmentName,
    [switch]$CheckOnly,
    [switch]$SkipAzureLogin,
    [string]$PaddleOcrToken = $env:PADDLE_OCR_TOKEN
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Write-Status {
    param([string]$Message)
    Write-Host "[auth] $Message" -ForegroundColor Cyan
}

function Assert-Command {
    param(
        [string]$Name,
        [string]$InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. $InstallHint"
    }
}

function Import-DotEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Azure environment file was not found: $Path"
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }

        $separator = $trimmed.IndexOf("=")
        if ($separator -lt 1) {
            continue
        }

        $name = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2) {
            $quoted = ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            if ($quoted) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }

        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

function Resolve-EnvironmentName {
    if ($EnvironmentName) {
        return $EnvironmentName
    }
    if ($env:AZURE_ENV_NAME) {
        return $env:AZURE_ENV_NAME
    }

    $environmentRoot = Join-Path $projectRoot ".azure"
    if (-not (Test-Path -LiteralPath $environmentRoot -PathType Container)) {
        throw "No .azure environment directory exists. Run 'azd env new' first."
    }

    $environments = @(
        Get-ChildItem -LiteralPath $environmentRoot -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName ".env") }
    )
    if ($environments.Count -eq 1) {
        return $environments[0].Name
    }

    throw "Unable to select an azd environment. Pass -EnvironmentName <name>."
}

function Set-AzdValue {
    param(
        [string]$Name,
        [string]$Value,
        [switch]$Sensitive
    )

    if ($CheckOnly -or -not (Get-Command azd -ErrorAction SilentlyContinue)) {
        return
    }

    if ($Sensitive) {
        # The existing Node helper passes the token through an environment
        # variable and keeps it out of this script's logs.
        & node (Join-Path $PSScriptRoot "get-github-token.mjs")
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to persist $Name to the azd environment."
        }
        return
    }

    & azd env set $Name $Value | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to persist $Name to the azd environment."
    }
}

Push-Location $projectRoot
try {
    $resolvedEnvironment = Resolve-EnvironmentName
    $environmentFile = Join-Path $projectRoot ".azure\$resolvedEnvironment\.env"
    Import-DotEnv -Path $environmentFile
    $env:AZURE_ENV_NAME = $resolvedEnvironment
    Write-Status "Loaded azd environment '$resolvedEnvironment'."

    Assert-Command -Name "gh" -InstallHint "Install it from https://cli.github.com/."
    & gh auth status | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI is not authenticated. Run 'gh auth login'."
    }

    $githubAuthStatus = (& gh auth status 2>&1 | Out-String)
    if ($githubAuthStatus -notmatch "(?i)\bcopilot\b") {
        throw "GitHub authentication is missing the Copilot scope. Run 'gh auth refresh --scopes copilot'."
    }

    $githubToken = (& gh auth token 2>$null | Out-String).Trim()
    if (-not $githubToken) {
        throw "GitHub CLI did not return a token. Run 'gh auth login'."
    }
    $env:GITHUB_TOKEN = $githubToken
    Set-AzdValue -Name "GITHUB_TOKEN" -Value $githubToken -Sensitive
    Write-Status "GitHub Copilot authentication is ready."

    Assert-Command -Name "az" -InstallHint "Install Azure CLI from https://aka.ms/installazurecliwindows."
    & az account show --output none 2>$null
    if ($LASTEXITCODE -ne 0) {
        if ($CheckOnly -or $SkipAzureLogin) {
            throw "Azure CLI is not authenticated. Run 'az login'."
        }
        Write-Status "Azure CLI login is required; opening the login flow."
        & az login --output none
        if ($LASTEXITCODE -ne 0) {
            throw "Azure CLI login failed."
        }
    }

    & az account get-access-token `
        --resource "https://cognitiveservices.azure.com" `
        --query "expiresOn" `
        --output tsv | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Azure could not issue a Cognitive Services token. Check the selected tenant and account."
    }
    Write-Status "Azure Cognitive Services authentication is ready."

    $speechEndpoint = $env:AZURE_SPEECH_ENDPOINT
    if (-not $speechEndpoint -and $env:ARCHITECTURE_MODEL_ENDPOINT) {
        $architectureUri = [Uri]$env:ARCHITECTURE_MODEL_ENDPOINT
        if ($architectureUri.Host.EndsWith(".cognitiveservices.azure.com")) {
            $speechEndpoint = $env:ARCHITECTURE_MODEL_ENDPOINT.TrimEnd("/")
        }
    }
    if (-not $speechEndpoint -and $env:AZURE_AI_ACCOUNT_NAME) {
        $speechEndpoint = "https://$($env:AZURE_AI_ACCOUNT_NAME).cognitiveservices.azure.com"
    }
    if (-not $speechEndpoint) {
        throw "A custom Speech endpoint could not be resolved. Set AZURE_SPEECH_ENDPOINT or AZURE_AI_ACCOUNT_NAME; the regional Speech URL can return 401 with Entra tokens."
    }

    $speechUri = [Uri]$speechEndpoint
    if (-not $speechUri.Host.EndsWith(".cognitiveservices.azure.com")) {
        throw "AZURE_SPEECH_ENDPOINT must use the resource's *.cognitiveservices.azure.com custom domain for Entra authentication."
    }
    $env:AZURE_SPEECH_ENDPOINT = $speechEndpoint.TrimEnd("/")
    Set-AzdValue -Name "AZURE_SPEECH_ENDPOINT" -Value $env:AZURE_SPEECH_ENDPOINT
    Write-Status "Azure Speech is using the Cognitive Services custom endpoint."

    if ($PaddleOcrToken) {
        if (Get-Command editppt -ErrorAction SilentlyContinue) {
            if (-not $CheckOnly) {
                & editppt config --paddle-ocr-token $PaddleOcrToken | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to configure the PaddleOCR token."
                }
            }
            Write-Status "PaddleOCR authentication is configured."
        } else {
            Write-Warning "PADDLE_OCR_TOKEN is set, but editppt is not installed."
        }
    } else {
        Write-Warning "PaddleOCR is optional and not configured; editable-slide text detection will use offline hints."
    }

    $requiredImageSettings = @(
        "ARCHITECTURE_MODEL_ENDPOINT",
        "ARCHITECTURE_IMAGE_DEPLOYMENT",
        "ARCHITECTURE_VISION_DEPLOYMENT"
    )
    $missingImageSettings = @(
        $requiredImageSettings | Where-Object {
            -not [Environment]::GetEnvironmentVariable($_, "Process")
        }
    )
    if ($missingImageSettings.Count -gt 0) {
        throw "Image generation configuration is incomplete: $($missingImageSettings -join ', ')."
    }

    Write-Host ""
    Write-Host "Authentication setup completed successfully." -ForegroundColor Green
    Write-Host "For manual startup, dot-source this script so variables remain in the shell:"
    Write-Host "  . .\scripts\setup-local-auth.ps1 -EnvironmentName $resolvedEnvironment"
} finally {
    Pop-Location
}
