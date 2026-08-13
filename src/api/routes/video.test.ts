import { rm, writeFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProject,
  getProject,
  projectDirectory,
} from "./project-store.js";
import videoRoutes from "./video.js";

vi.mock("./video-processor.js", () => ({
  checkVideoCapabilities: vi.fn().mockResolvedValue({ available: true }),
  refineVideo: vi.fn().mockImplementation(async (_inputPath: string, outputPath: string) => {
    await writeFile(outputPath, Buffer.from([0x09, 0x08, 0x07]));
    return {
      source: {
        container: "mp4",
        duration: 20,
        sizeBytes: 1024,
        video: {
          codec: "h264",
          width: 1280,
          height: 720,
          frameRate: 30,
          pixelFormat: "yuv420p",
        },
        audio: {
          codec: "aac",
          sampleRate: 48000,
          channels: 2,
        },
        keyframes: {
          count: 6,
          firstTimestamps: [0, 2, 4],
        },
      },
      output: {
        container: "mp4",
        duration: 10,
        sizeBytes: 768,
        video: {
          codec: "h264",
          width: 1280,
          height: 720,
          frameRate: 30,
          pixelFormat: "yuv420p",
        },
        audio: {
          codec: "aac",
          sampleRate: 48000,
          channels: 2,
        },
        keyframes: {
          count: 5,
          firstTimestamps: [0, 2],
        },
      },
      acceleratedRanges: [
        {
          start: 4,
          end: 8,
          speed: 4,
          originalDuration: 4,
          outputDuration: 1,
        },
      ],
      filters: ["text-safe sharpening"],
      originalDuration: 20,
      outputDuration: 10,
      durationChange: -10,
      warnings: [],
    };
  }),
}));

const createdProjects: string[] = [];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(videoRoutes);
  return app;
}

afterEach(async () => {
  await Promise.all(createdProjects.splice(0).map(projectId =>
    rm(projectDirectory(projectId), { recursive: true, force: true })));
});

describe("video routes", () => {
  it("rejects non-video request bodies before processing", async () => {
    const response = await request(createApp())
      .post("/video/refine")
      .set("Content-Type", "text/plain")
      .send("not a video");

    expect(response.status).toBe(415);
    expect(response.body.error).toContain("raw request body");
  });

  it("rejects malformed output job IDs", async () => {
    const response = await request(createApp())
      .get("/video/jobs/..%2Fprivate/output");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid video job ID");
  });

  it("stores source and refined assets when a project ID is provided", async () => {
    const project = await createProject({
      title: "Presentation Agent",
      idea: "Create a traceable workflow from idea to polished recording.",
      audience: "Engineering leaders",
      purpose: "Demonstrate MVP lineage",
    });
    createdProjects.push(project.id);

    const response = await request(createApp())
      .post(`/video/refine?projectId=${project.id}`)
      .set("Content-Type", "video/mp4")
      .set("X-File-Name", encodeURIComponent("demo.mp4"))
      .send(Buffer.from([0x00, 0x01, 0x02, 0x03]));

    expect(response.status).toBe(201);
    expect(response.body.assets.source.type).toBe("source-video");
    expect(response.body.assets.refined.type).toBe("refined-video");
    expect(response.body.assets.processing.type).toBe("export");
    expect(response.body.assets.refined.sourceAssetIds).toContain(
      response.body.assets.source.id,
    );
    expect(response.body.assets.processing.sourceAssetIds).toContain(
      response.body.assets.refined.id,
    );

    const reloaded = await getProject(project.id);
    expect(reloaded?.currentAssets["source-video"]).toBe(response.body.assets.source.id);
    expect(reloaded?.currentAssets["refined-video"]).toBe(response.body.assets.refined.id);
    expect(reloaded?.currentAssets.export).toBe(response.body.assets.processing.id);
  });

  it("separates source upload from stored-asset refinement", async () => {
    const project = await createProject({
      title: "Presentation Agent",
      idea: "Upload a recording before creating a separate refined output.",
      audience: "Engineering leaders",
      purpose: "Demonstrate staged video processing",
    });
    createdProjects.push(project.id);

    const upload = await request(createApp())
      .post(`/video/upload?projectId=${project.id}`)
      .set("Content-Type", "video/mp4")
      .set("X-File-Name", encodeURIComponent("demo.mp4"))
      .send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    expect(upload.status).toBe(201);
    expect(upload.body.asset.type).toBe("source-video");
    expect((await getProject(project.id))?.currentAssets["refined-video"]).toBeUndefined();

    const refined = await request(createApp())
      .post("/video/refine-stored")
      .send({
        projectId: project.id,
        sourceAssetId: upload.body.asset.id,
        options: {
          targetSpeed: 4,
          minimumInactiveDuration: 2.5,
          clarity: "standard",
          resolution: "source",
        },
      });
    expect(refined.status).toBe(201);
    expect(refined.body.assets.refined.sourceAssetIds).toContain(upload.body.asset.id);
    expect(refined.body.assets.source.id).toBe(upload.body.asset.id);
  });
});
