import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type ProjectBrief = {
  title: string;
  idea: string;
  audience: string;
  purpose: string;
  repositoryUrl?: string;
};

export type ProjectOwner = {
  kind: "github" | "local";
  id: string;
  login?: string;
};

export type ProjectAssetType =
  | "brief"
  | "repository-evidence"
  | "story"
  | "outline"
  | "architecture"
  | "architecture-html"
  | "architecture-validated-json-html"
  | "architecture-image-derived-html"
  | "architecture-narrative-html"
  | "architecture-image"
  | "architecture-pptx"
  | "architecture-pptx-preview"
  | "architecture-narrative-image"
  | "architecture-layout"
  | "slide-model"
  | "slide-deck"
  | "slide-deck-pptx"
  | `slide-image-${string}`
  | "speech-script"
  | "source-video"
  | "refined-video"
  | "transcript"
  | "script"
  | "voice-reference"
  | "narration"
  | "export";

export type ProjectAsset = {
  id: string;
  type: ProjectAssetType;
  format: string;
  revision: number;
  relativePath: string;
  createdAt: string;
  sourceAssetIds: string[];
  metadata: Record<string, string | number | boolean | null>;
};

export type ProjectManifest = {
  schemaVersion: 1 | 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  brief: ProjectBrief;
  owner?: ProjectOwner;
  assets: ProjectAsset[];
  currentAssets: Partial<Record<ProjectAssetType, string>>;
};

const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_ROOT = resolve(
  process.env.PRESENTATION_ASSET_ROOT ||
    join(tmpdir(), "presentation-agent-projects"),
);

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

export function projectDirectory(projectId: string): string {
  if (!isProjectId(projectId)) {
    throw new Error("Invalid presentation project ID.");
  }
  return join(ASSET_ROOT, projectId);
}

function manifestPath(projectId: string): string {
  return join(projectDirectory(projectId), "project.json");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  await rename(temporaryPath, path);
}

export async function getProject(
  projectId: string,
): Promise<ProjectManifest | null> {
  if (!isProjectId(projectId)) return null;
  try {
    const content = await readFile(manifestPath(projectId), "utf8");
    return JSON.parse(content) as ProjectManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function createProject(
  brief: ProjectBrief,
  owner: ProjectOwner = { kind: "local", id: "local-development" },
): Promise<ProjectManifest> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const directory = projectDirectory(id);
  await mkdir(join(directory, "assets"), { recursive: true });
  const briefAsset: ProjectAsset = {
    id: randomUUID(),
    type: "brief",
    format: "json",
    revision: 1,
    relativePath: join("assets", "brief-r1.json"),
    createdAt: now,
    sourceAssetIds: [],
    metadata: { title: brief.title },
  };
  await writeJsonAtomic(join(directory, briefAsset.relativePath), brief);
  const manifest: ProjectManifest = {
    schemaVersion: 2,
    id,
    createdAt: now,
    updatedAt: now,
    brief,
    owner,
    assets: [briefAsset],
    currentAssets: { brief: briefAsset.id },
  };
  await writeJsonAtomic(manifestPath(id), manifest);
  return manifest;
}

async function storeProjectAsset(
  projectId: string,
  type: ProjectAssetType,
  format: string,
  content: string | Uint8Array,
  sourceAssetIds: string[],
  metadata: ProjectAsset["metadata"],
): Promise<{ project: ProjectManifest; asset: ProjectAsset }> {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error("Presentation project not found.");
  }
  const revision =
    project.assets.filter(asset => asset.type === type).length + 1;
  const safeFormat = format.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "bin";
  const asset: ProjectAsset = {
    id: randomUUID(),
    type,
    format: safeFormat,
    revision,
    relativePath: join("assets", `${type}-r${revision}.${safeFormat}`),
    createdAt: new Date().toISOString(),
    sourceAssetIds: [...new Set(sourceAssetIds.filter(Boolean))],
    metadata,
  };
  await writeFile(join(projectDirectory(projectId), asset.relativePath), content);
  project.assets.push(asset);
  project.currentAssets[type] = asset.id;
  project.updatedAt = asset.createdAt;
  await writeJsonAtomic(manifestPath(projectId), project);
  return { project, asset };
}

export async function storeProjectJsonAsset(
  projectId: string,
  type: ProjectAssetType,
  value: unknown,
  sourceAssetIds: string[] = [],
  metadata: ProjectAsset["metadata"] = {},
): Promise<{ project: ProjectManifest; asset: ProjectAsset }> {
  return storeProjectAsset(
    projectId,
    type,
    "json",
    JSON.stringify(value, null, 2),
    sourceAssetIds,
    metadata,
  );
}

export async function storeProjectTextAsset(
  projectId: string,
  type: ProjectAssetType,
  format: string,
  value: string,
  sourceAssetIds: string[] = [],
  metadata: ProjectAsset["metadata"] = {},
): Promise<{ project: ProjectManifest; asset: ProjectAsset }> {
  return storeProjectAsset(
    projectId,
    type,
    format,
    value,
    sourceAssetIds,
    metadata,
  );
}

export async function storeProjectBinaryAsset(
  projectId: string,
  type: ProjectAssetType,
  format: string,
  value: Uint8Array,
  sourceAssetIds: string[] = [],
  metadata: ProjectAsset["metadata"] = {},
): Promise<{ project: ProjectManifest; asset: ProjectAsset }> {
  return storeProjectAsset(
    projectId,
    type,
    format,
    value,
    sourceAssetIds,
    metadata,
  );
}

export async function readProjectAsset(
  projectId: string,
  assetId: string,
): Promise<{ asset: ProjectAsset; content: string } | null> {
  const project = await getProject(projectId);
  const asset = project?.assets.find(candidate => candidate.id === assetId);
  if (!asset) return null;
  const content = await readFile(
    join(projectDirectory(projectId), asset.relativePath),
    "utf8",
  );
  return { asset, content };
}

export async function readProjectBinaryAsset(
  projectId: string,
  assetId: string,
): Promise<{ asset: ProjectAsset; content: Uint8Array } | null> {
  const project = await getProject(projectId);
  const asset = project?.assets.find(candidate => candidate.id === assetId);
  if (!asset) return null;
  const content = await readFile(
    join(projectDirectory(projectId), asset.relativePath),
  );
  return { asset, content };
}

export async function clearCurrentProjectAssets(
  projectId: string,
  types: ProjectAssetType[],
): Promise<ProjectManifest> {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error("Presentation project not found.");
  }
  for (const type of types) {
    delete project.currentAssets[type];
  }
  project.updatedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath(projectId), project);
  return project;
}

export function currentSourceAssetIds(
  project: ProjectManifest,
  types: ProjectAssetType[],
): string[] {
  return types
    .map(type => project.currentAssets[type])
    .filter((id): id is string => Boolean(id));
}
