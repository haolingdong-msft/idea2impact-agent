import type { NextFunction, Request, Response } from "express";
import { getGitHubUserSession } from "./github-auth.js";
import {
  getProject,
  isProjectId,
  type ProjectOwner,
} from "./project-store.js";

const LOCAL_OWNER: ProjectOwner = {
  kind: "local",
  id: "local-development",
};

export function projectOwnerForRequest(request: Request): ProjectOwner | null {
  const session = getGitHubUserSession(request);
  if (session) {
    return {
      kind: "github",
      id: String(session.userId),
      login: session.login,
    };
  }
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.ALLOW_LOCAL_PROJECT_OWNER === "true"
  ) {
    return LOCAL_OWNER;
  }
  return null;
}

function requestedProjectId(request: Request): string | undefined {
  const pathMatch = request.path.match(
    /\/projects\/([0-9a-f-]{36})(?:\/|$)/i,
  );
  if (pathMatch?.[1]) return pathMatch[1];
  if (isProjectId(request.body?.projectId)) return request.body.projectId;
  if (isProjectId(request.query.projectId)) return request.query.projectId;
  return undefined;
}

export async function authorizeProjectRequest(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const projectId = requestedProjectId(request);
  if (!projectId) {
    next();
    return;
  }
  const project = await getProject(projectId);
  if (!project) {
    next();
    return;
  }
  const owner = projectOwnerForRequest(request);
  if (!owner) {
    response.status(401).json({ error: "Authentication is required." });
    return;
  }
  if (
    project.owner &&
    (project.owner.kind !== owner.kind || project.owner.id !== owner.id)
  ) {
    response.status(403).json({
      error: "This presentation project belongs to another user.",
    });
    return;
  }
  if (
    !project.owner &&
    (process.env.NODE_ENV === "production" &&
      process.env.ALLOW_LOCAL_PROJECT_OWNER !== "true")
  ) {
    response.status(403).json({
      error: "This legacy project has no authenticated owner.",
    });
    return;
  }
  next();
}
