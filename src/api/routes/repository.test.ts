import { describe, expect, it } from "vitest";
import {
  architecturePathScore,
  parseGitHubRepositoryUrl,
  redactRepositoryText,
  repositoryEvidenceSummary,
} from "./repository.js";

describe("GitHub repository evidence", () => {
  it("normalizes repository and tree URLs", () => {
    expect(parseGitHubRepositoryUrl(
      "https://github.com/owner/repository.git",
    )).toMatchObject({
      owner: "owner",
      repository: "repository",
      canonicalUrl: "https://github.com/owner/repository",
    });
    expect(parseGitHubRepositoryUrl(
      "https://github.com/owner/repository/tree/main/src/api",
    )).toMatchObject({
      ref: "main",
      subpath: "src/api",
    });
  });

  it("rejects alternate hosts, credentials, and unsupported paths", () => {
    expect(() => parseGitHubRepositoryUrl(
      "https://example.com/owner/repository",
    )).toThrow("github.com");
    expect(() => parseGitHubRepositoryUrl(
      "https://token@github.com/owner/repository",
    )).toThrow("credential-free");
    expect(() => parseGitHubRepositoryUrl(
      "https://github.com/owner/repository/issues",
    )).toThrow("/tree/");
  });

  it("prioritizes architecture evidence and excludes generated files", () => {
    expect(architecturePathScore("README.md")).toBeGreaterThan(
      architecturePathScore("src/utils/string.ts"),
    );
    expect(architecturePathScore("infra/main.bicep")).toBeGreaterThan(
      architecturePathScore("src/utils/string.ts"),
    );
    expect(architecturePathScore("node_modules/pkg/index.js")).toBe(-1);
    expect(architecturePathScore("dist/app.min.js")).toBe(-1);
  });

  it("redacts common secret forms before evidence is persisted", () => {
    const result = redactRepositoryText([
      "token=ghp_123456789012345678901234567890123456",
      "api_key=super-secret-value",
      "-----BEGIN PRIVATE KEY-----",
      "private material",
      "-----END PRIVATE KEY-----",
    ].join("\n"));
    expect(result).not.toContain("ghp_");
    expect(result).not.toContain("super-secret-value");
    expect(result).not.toContain("private material");
    expect(result).toContain("[REDACTED");
  });

  it("returns only compact evidence to the browser", () => {
    const summary = repositoryEvidenceSummary({
      schemaVersion: 1,
      repository: {
        owner: "owner",
        name: "repo",
        url: "https://github.com/owner/repo",
        defaultBranch: "main",
        requestedRef: "main",
        commitSha: "abc123",
        private: true,
        archived: false,
      },
      scan: {
        scannedAt: "2026-01-01T00:00:00.000Z",
        treePathCount: 2,
        selectedFileCount: 1,
        extractedBytes: 100,
        truncated: false,
        limits: {
          maximumTreePaths: 5_000,
          maximumSelectedFiles: 60,
          maximumFileBytes: 80_000,
          maximumTotalBytes: 1_500_000,
        },
      },
      technologies: ["TypeScript"],
      componentHints: [],
      files: [{
        path: "README.md",
        sha: "sha",
        size: 100,
        contentHash: "hash",
        excerpt: "private repository content",
      }],
      warnings: [],
    });
    expect(summary.scan).toEqual({ selectedFileCount: 1, truncated: false });
    expect(summary).not.toHaveProperty("files");
    expect(JSON.stringify(summary)).not.toContain("private repository content");
  });
});
