import { Router } from "express";
import {
  clearCurrentProjectAssets,
  createProject,
  currentSourceAssetIds,
  getProject,
  isProjectId,
  storeProjectJsonAsset,
  type ProjectBrief,
} from "./project-store.js";
import { projectOwnerForRequest } from "./project-authorization.js";

const router = Router();

function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function repositoryUrl(value: unknown): string | undefined {
  const candidate = text(value, 500);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return undefined;
    return `https://github.com/${segments[0]}/${segments[1].replace(/\.git$/i, "")}`;
  } catch {
    return undefined;
  }
}

function parseBrief(value: unknown): ProjectBrief | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const idea = text(source.idea, 12_000);
  if (idea.length < 10) return null;
  const rawRepositoryUrl = text(source.repositoryUrl, 500);
  const normalizedRepositoryUrl = repositoryUrl(rawRepositoryUrl);
  if (rawRepositoryUrl && !normalizedRepositoryUrl) return null;
  return {
    title: text(source.title, 160) || "Untitled presentation",
    idea,
    audience: text(source.audience, 300),
    purpose: text(source.purpose, 500),
    repositoryUrl: normalizedRepositoryUrl,
  };
}

router.post("/projects", async (req, res) => {
  const brief = parseBrief(req.body);
  if (!brief) {
    res.status(400).json({
      error: "A project requires an idea with at least 10 characters.",
    });
    return;
  }
  const owner = projectOwnerForRequest(req);
  if (!owner) {
    res.status(401).json({ error: "Authentication is required." });
    return;
  }
  const project = await createProject(brief, owner);
  res.status(201).json({ project });
});

router.get("/projects/:projectId", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(isProjectId(req.params.projectId) ? 404 : 400).json({
      error: isProjectId(req.params.projectId)
        ? "Presentation project not found."
        : "Invalid presentation project ID.",
    });
    return;
  }
  res.json({ project });
});

router.put("/projects/:projectId/story", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(isProjectId(req.params.projectId) ? 404 : 400).json({
      error: isProjectId(req.params.projectId)
        ? "Presentation project not found."
        : "Invalid presentation project ID.",
    });
    return;
  }
  const context = text(req.body?.context, 20_000);
  const allowedSections = new Set(["problem", "userStory", "architecture"]);
  const approvedSections = Array.isArray(req.body?.approvedSections)
    ? req.body.approvedSections
        .filter((section: unknown) =>
          typeof section === "string" && allowedSections.has(section))
        .slice(0, 3)
    : [];
  const stored = await storeProjectJsonAsset(
    project.id,
    "story",
    { context, approvedSections },
    currentSourceAssetIds(project, ["brief", "repository-evidence"]),
    { approvedSectionCount: approvedSections.length },
  );
  const updatedProject = await clearCurrentProjectAssets(project.id, [
    "architecture",
    "architecture-html",
    "architecture-validated-json-html",
    "architecture-narrative-html",
    "architecture-image",
    "architecture-narrative-image",
    "architecture-layout",
    "slide-model",
    "slide-deck",
  ]);
  res.json({ project: updatedProject, asset: stored.asset });
});

export default router;
