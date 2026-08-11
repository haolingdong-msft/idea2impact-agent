import { createHash } from "node:crypto";
import { Router } from "express";
import {
  clearCurrentProjectAssets,
  currentSourceAssetIds,
  getProject,
  storeProjectJsonAsset,
} from "./project-store.js";
import {
  getGitHubUserSession,
  installationTokenForRepository,
} from "./github-auth.js";

const router = Router();

const MAX_TREE_PATHS = 5_000;
const MAX_SELECTED_FILES = 60;
const MAX_FILE_BYTES = 80_000;
const MAX_TOTAL_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 20_000;

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);
const EXCLUDED_EXTENSIONS = new Set([
  ".7z", ".avi", ".bmp", ".class", ".dll", ".dylib", ".exe", ".gif",
  ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lock", ".map", ".min.js",
  ".mov", ".mp3", ".mp4", ".o", ".obj", ".pdf", ".png", ".pyc", ".so",
  ".svg", ".tar", ".tiff", ".webm", ".woff", ".woff2", ".zip",
]);

export type GitHubRepositoryLocation = {
  owner: string;
  repository: string;
  ref?: string;
  subpath?: string;
  canonicalUrl: string;
};

export type RepositoryFileEvidence = {
  path: string;
  sha: string;
  size: number;
  contentHash: string;
  excerpt: string;
};

export type RepositoryEvidence = {
  schemaVersion: 1;
  repository: {
    owner: string;
    name: string;
    url: string;
    defaultBranch: string;
    requestedRef: string;
    commitSha: string;
    private: boolean;
    archived: boolean;
  };
  scan: {
    scannedAt: string;
    treePathCount: number;
    selectedFileCount: number;
    extractedBytes: number;
    truncated: boolean;
    limits: {
      maximumTreePaths: number;
      maximumSelectedFiles: number;
      maximumFileBytes: number;
      maximumTotalBytes: number;
    };
  };
  technologies: string[];
  componentHints: Array<{ label: string; evidencePaths: string[] }>;
  files: RepositoryFileEvidence[];
  warnings: string[];
};

export type RepositoryEvidenceSummary = Pick<
  RepositoryEvidence,
  "repository" | "technologies" | "warnings"
> & {
  scan: Pick<
    RepositoryEvidence["scan"],
    "selectedFileCount" | "truncated"
  >;
};

export function repositoryEvidenceSummary(
  evidence: RepositoryEvidence,
): RepositoryEvidenceSummary {
  return {
    repository: evidence.repository,
    scan: {
      selectedFileCount: evidence.scan.selectedFileCount,
      truncated: evidence.scan.truncated,
    },
    technologies: evidence.technologies,
    warnings: evidence.warnings,
  };
}

type GitHubTreeItem = {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
};

function githubHeaders(token?: string, accept = "application/vnd.github+json") {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "presentation-agent",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 403 && remaining === "0") {
      throw new Error("GitHub API rate limit reached. Retry after the reset time.");
    }
    if ([401, 403, 404].includes(response.status)) {
      throw new Error(
        "Repository is private, unavailable, or not authorized. Connect GitHub and select this repository.",
      );
    }
    throw new Error(`GitHub request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryLocation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Repository URL must be a valid GitHub HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Only credential-free https://github.com repository URLs are supported.");
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2 || segments.some(segment =>
    !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error("Repository URL must include an owner and repository.");
  }
  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  let ref: string | undefined;
  let subpath: string | undefined;
  if (segments.length > 2) {
    if (segments[2] !== "tree" || !segments[3]) {
      throw new Error("Only repository root and /tree/<ref>/<path> URLs are supported.");
    }
    ref = segments[3];
    subpath = segments.slice(4).join("/") || undefined;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository owner or name contains unsupported characters.");
  }
  return {
    owner,
    repository,
    ref,
    subpath,
    canonicalUrl: `https://github.com/${owner}/${repository}`,
  };
}

function excluded(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) return true;
  return [...EXCLUDED_EXTENSIONS].some(extension => lower.endsWith(extension));
}

export function architecturePathScore(path: string): number {
  const lower = path.toLowerCase();
  if (excluded(path)) return -1;
  if (/(^|\/)readme(\.[^/]*)?$/.test(lower)) return 120;
  if (/(^|\/)(docs?|architecture|adr)(\/|$)/.test(lower)) return 110;
  if (/(^|\/)(agents|claude)\.md$/.test(lower)) return 105;
  if (/(architecture|design|decision|overview)/.test(lower)) return 100;
  if (/(^|\/)(package\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|.*\.csproj)$/.test(lower)) return 95;
  if (/(azure\.yaml|dockerfile|compose\.ya?ml|\.bicep$|\.tf$|kustomization|helm)/.test(lower)) return 90;
  if (/(openapi|swagger|asyncapi|schema|proto)/.test(lower)) return 85;
  if (/(^|\/)(src|app|services?|packages?)\/.*(index|main|server|app|route|controller|model)/.test(lower)) return 75;
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|md|ya?ml|json|toml)$/.test(lower)) return 40;
  return -1;
}

export function redactRepositoryText(content: string): string {
  return content
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(AKI[AS][A-Z0-9]{16})\b/g, "[REDACTED_ACCESS_KEY]")
    .replace(
      /((?:secret|token|password|api[_-]?key)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
      "$1[REDACTED]",
    )
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]");
}

function technologySignals(files: RepositoryFileEvidence[]): string[] {
  const joinedPaths = files.map(file => file.path.toLowerCase()).join("\n");
  const joinedContent = files.map(file => file.excerpt.toLowerCase()).join("\n");
  const signals = new Set<string>();
  const detect = (name: string, pattern: RegExp) => {
    if (pattern.test(`${joinedPaths}\n${joinedContent}`)) signals.add(name);
  };
  detect("TypeScript", /typescript|\.tsx?\b/);
  detect("React", /\breact\b|vite/);
  detect("Node.js", /\bnode(js)?\b|package\.json/);
  detect("Express", /\bexpress\b/);
  detect("GitHub Copilot SDK", /@github\/copilot-sdk|copilotclient/);
  detect("Azure", /\bazure\b|azure\.yaml|\.bicep\b/);
  detect("Microsoft Foundry", /\bfoundry\b|azure\.ai\.agent/);
  detect("Docker", /dockerfile|\bdocker\b/);
  detect("FFmpeg", /\bffmpeg\b/);
  detect("Python", /pyproject\.toml|requirements\.txt|\.py\b/);
  detect("Go", /go\.mod|\.go\b/);
  return [...signals].sort();
}

function componentHints(files: RepositoryFileEvidence[]) {
  const groups: Array<[string, RegExp]> = [
    ["Web application", /(^|\/)(web|frontend|client|ui)(\/|$)/i],
    ["API service", /(^|\/)(api|server|backend|routes?)(\/|$)/i],
    ["Hosted agent", /(^|\/)(agent|hosted-agent)(\/|$)/i],
    ["Infrastructure", /(^|\/)(infra|deploy|terraform|bicep|helm)(\/|$)|azure\.yaml|dockerfile/i],
    ["Data models", /(^|\/)(models?|schema|database|storage)(\/|$)/i],
    ["Documentation", /(^|\/)(docs?|adr)(\/|$)|readme/i],
  ];
  return groups
    .map(([label, pattern]) => ({
      label,
      evidencePaths: files.filter(file => pattern.test(file.path)).map(file => file.path).slice(0, 8),
    }))
    .filter(group => group.evidencePaths.length > 0);
}

export async function scanGitHubRepository(
  repositoryUrl: string,
  token?: string,
): Promise<RepositoryEvidence> {
  const location = parseGitHubRepositoryUrl(repositoryUrl);
  const apiBase = `https://api.github.com/repos/${location.owner}/${location.repository}`;
  const metadata = await githubJson<{
    default_branch: string;
    private: boolean;
    archived: boolean;
    html_url: string;
  }>(apiBase, token);
  const requestedRef = location.ref || metadata.default_branch;
  const commit = await githubJson<{ sha: string }>(
    `${apiBase}/commits/${encodeURIComponent(requestedRef)}`,
    token,
  );
  const tree = await githubJson<{
    tree: GitHubTreeItem[];
    truncated?: boolean;
  }>(`${apiBase}/git/trees/${commit.sha}?recursive=1`, token);

  const allItems = (tree.tree || []).slice(0, MAX_TREE_PATHS);
  const candidates = allItems
    .filter(item =>
      item.type === "blob" &&
      typeof item.path === "string" &&
      typeof item.sha === "string" &&
      (!location.subpath || item.path.startsWith(`${location.subpath}/`) || item.path === location.subpath) &&
      (item.size ?? 0) <= MAX_FILE_BYTES)
    .map(item => ({ ...item, score: architecturePathScore(item.path!) }))
    .filter(item => item.score >= 0)
    .sort((left, right) =>
      right.score - left.score || left.path!.localeCompare(right.path!))
    .slice(0, MAX_SELECTED_FILES);

  const files: RepositoryFileEvidence[] = [];
  let extractedBytes = 0;
  for (const candidate of candidates) {
    if (extractedBytes >= MAX_TOTAL_BYTES) break;
    const path = candidate.path!;
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `${apiBase}/contents/${encodedPath}?ref=${encodeURIComponent(commit.sha)}`,
      {
        headers: githubHeaders(token, "application/vnd.github.raw+json"),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) continue;
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > MAX_FILE_BYTES) continue;
    const raw = (await response.text()).slice(0, Math.min(
      MAX_FILE_BYTES,
      MAX_TOTAL_BYTES - extractedBytes,
    ));
    if (raw.includes("\0")) continue;
    const redacted = redactRepositoryText(raw);
    extractedBytes += Buffer.byteLength(redacted);
    files.push({
      path,
      sha: candidate.sha!,
      size: candidate.size ?? Buffer.byteLength(raw),
      contentHash: createHash("sha256").update(redacted).digest("hex"),
      excerpt: redacted,
    });
  }

  const truncated = Boolean(
    tree.truncated ||
    tree.tree.length > MAX_TREE_PATHS ||
    candidates.length > files.length ||
    extractedBytes >= MAX_TOTAL_BYTES,
  );
  const warnings = [
    ...(metadata.archived ? ["Repository is archived."] : []),
    ...(truncated ? ["Repository scan was truncated by deterministic safety limits."] : []),
    ...(files.length === 0 ? ["No architecture-relevant text files were extracted."] : []),
  ];
  return {
    schemaVersion: 1,
    repository: {
      owner: location.owner,
      name: location.repository,
      url: metadata.html_url || location.canonicalUrl,
      defaultBranch: metadata.default_branch,
      requestedRef,
      commitSha: commit.sha,
      private: metadata.private,
      archived: metadata.archived,
    },
    scan: {
      scannedAt: new Date().toISOString(),
      treePathCount: tree.tree.length,
      selectedFileCount: files.length,
      extractedBytes,
      truncated,
      limits: {
        maximumTreePaths: MAX_TREE_PATHS,
        maximumSelectedFiles: MAX_SELECTED_FILES,
        maximumFileBytes: MAX_FILE_BYTES,
        maximumTotalBytes: MAX_TOTAL_BYTES,
      },
    },
    technologies: technologySignals(files),
    componentHints: componentHints(files),
    files,
    warnings,
  };
}

router.post("/projects/:projectId/repository/scan", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Presentation project not found." });
    return;
  }
  const requestedUrl =
    typeof req.body?.repositoryUrl === "string"
      ? req.body.repositoryUrl.trim()
      : project.brief.repositoryUrl;
  if (!requestedUrl) {
    res.status(400).json({ error: "A GitHub repository URL is required." });
    return;
  }
  try {
    let evidence: RepositoryEvidence;
    try {
      evidence = await scanGitHubRepository(requestedUrl);
    } catch (publicError) {
      const message =
        publicError instanceof Error ? publicError.message : String(publicError);
      if (!message.includes("authorized")) throw publicError;
      const session = getGitHubUserSession(req);
      if (!session) throw publicError;
      const location = parseGitHubRepositoryUrl(requestedUrl);
      const token = await installationTokenForRepository(session, location);
      evidence = await scanGitHubRepository(requestedUrl, token);
    }
    const stored = await storeProjectJsonAsset(
      project.id,
      "repository-evidence",
      evidence,
      currentSourceAssetIds(project, ["brief"]),
      {
        repository: `${evidence.repository.owner}/${evidence.repository.name}`,
        commitSha: evidence.repository.commitSha,
        selectedFileCount: evidence.scan.selectedFileCount,
        truncated: evidence.scan.truncated,
      },
    );
    await clearCurrentProjectAssets(project.id, [
      "story",
      "architecture",
      "slide-model",
      "slide-deck",
    ]);
    res.status(201).json({
      evidence: repositoryEvidenceSummary(evidence),
      asset: stored.asset,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("authorized") ? 401 : 400;
    res.status(status).json({ error: message });
  }
});

export default router;
