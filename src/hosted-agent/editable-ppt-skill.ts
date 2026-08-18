import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolResultObject } from "@github/copilot-sdk";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import { getClient } from "./client.js";
import { getSessionOptions } from "./model-config.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(
  process.env.IMAGE_TO_EDITABLE_PPT_SKILL_ROOT ||
    join(MODULE_DIR, "skills", "image-to-editable-ppt"),
);
const EDITPPT = process.env.EDITPPT_COMMAND || "editppt";
const PYTHON = process.env.PYTHON_COMMAND ||
  (process.platform === "win32" ? "python" : "python3");
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const AGENT_TIMEOUT_MS = 14 * 60_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MODEL_SCOPE = "https://cognitiveservices.azure.com/.default";

type ConversionInput = {
  projectId: string;
  sourceAssetId: string;
  sourceImageBase64: string;
  sourceImageSha256: string;
};

type ConversionResult = {
  invocationId: string;
  runId: string;
  workflow: "image-to-editable-ppt";
  validationPassed: true;
  sourceImageSha256s: string[];
  pptxBase64: string;
  cacheHit?: boolean;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type ToolArguments = Record<string, unknown>;

type WorkerSession = {
  destroy(): Promise<void>;
  on?(
    event: string,
    callback: (event: { data?: Record<string, unknown> }) => void,
  ): () => void;
  sendAndWait(
    message: {
      prompt: string;
      attachments: Array<{
        type: "file";
        path: string;
        displayName: string;
      }>;
    },
    timeout: number,
  ): Promise<unknown>;
};

function text(value: unknown, maximum = 40_000): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function within(root: string, candidate: string): string {
  const resolved = resolve(root, candidate);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path is outside the skill worker boundary.");
  }
  return resolved;
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out.`));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(
          `${command} exited with ${code}: ${(stderr || stdout).slice(-2_000)}`,
        ));
      }
    });
  });
}

async function imageBackendEnvironment(): Promise<NodeJS.ProcessEnv> {
  const endpoint = text(process.env.ARCHITECTURE_MODEL_ENDPOINT, 2_000)
    .replace(/\/$/, "");
  const deployment = text(process.env.ARCHITECTURE_IMAGE_DEPLOYMENT, 200);
  if (!endpoint || !deployment) {
    throw new Error(
      "ARCHITECTURE_MODEL_ENDPOINT and ARCHITECTURE_IMAGE_DEPLOYMENT are required.",
    );
  }
  let apiKey = process.env.NODE_ENV !== "production"
    ? text(process.env.ARCHITECTURE_MODEL_API_KEY, 2_000)
    : "";
  const credential = process.env.NODE_ENV === "production"
    ? process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential()
    : new DefaultAzureCredential();
  const secretUri = text(
    process.env.ARCHITECTURE_MODEL_API_KEY_SECRET_URI,
    2_000,
  );
  if (!apiKey && secretUri) {
    const accessToken = await credential.getToken(
      "https://vault.azure.net/.default",
    );
    const separator = secretUri.includes("?") ? "&" : "?";
    const secretResponse = await fetch(
      `${secretUri}${separator}api-version=7.4`,
      { headers: { ["Authorization"]: "Bearer " + accessToken.token } },
    );
    if (!secretResponse.ok) {
      throw new Error(
        `Hosted Agent could not read the image model key (${secretResponse.status}).`,
      );
    }
    const secret = await secretResponse.json() as { value?: unknown };
    apiKey = text(secret.value, 2_000);
  }
  let bearerToken = "";
  if (!apiKey) {
    const token = await credential.getToken(MODEL_SCOPE);
    bearerToken = token.token;
  }
  return {
    CODEX_AUTH_FILE: join(tmpdir(), `editppt-no-codex-${randomUUID()}.json`),
    OPENAI_BASE_URL: `${endpoint}/openai/v1`,
    OPENAI_API_KEY: apiKey || undefined,
    EDITPPT_BEARER_TOKEN: bearerToken || undefined,
    AZURE_OPENAI_API_VERSION: undefined,
    IMAGE_TO_EDITABLE_PPT_IMAGE_MODEL: deployment,
  };
}

function toolSuccess(
  message: string,
  binary?: { data: string; mimeType: string; description: string },
): ToolResultObject {
  return {
    textResultForLlm: message,
    ...(binary
      ? {
          binaryResultsForLlm: [{
            ...binary,
            type: "image",
          }],
        }
      : {}),
    resultType: "success",
  };
}

function pageTools(
  pageDir: string,
  backendEnv: NodeJS.ProcessEnv,
) {
  const readText = defineTool<ToolArguments>("read_skill_or_page_text", {
    description:
      "Read a UTF-8 text file from the image-to-editable-ppt skill or current page directory.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["skill", "page"] },
        path: { type: "string" },
      },
      required: ["scope", "path"],
      additionalProperties: false,
    },
    handler: async args => {
      const root = args.scope === "skill" ? SKILL_ROOT : pageDir;
      const path = within(root, text(args.path, 500));
      return (await readFile(path, "utf8")).slice(0, 120_000);
    },
  });

  const writePageText = defineTool<ToolArguments>("write_page_text", {
    description:
      "Write a UTF-8 JSON, Markdown, or text artifact inside the current page directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async args => {
      const path = within(pageDir, text(args.path, 500));
      if (!/\.(?:json|md|txt)$/i.test(path)) {
        throw new Error("Only JSON, Markdown, and text page artifacts are writable.");
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, String(args.content), "utf8");
      return `Wrote ${relative(pageDir, path)}.`;
    },
  });

  const listPageFiles = defineTool<ToolArguments>("list_page_files", {
    description: "List files under a page-relative directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    handler: async args => {
      const root = within(pageDir, text(args.path, 500) || ".");
      const entries = await readdir(root, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
    },
  });

  const viewPageImage = defineTool<ToolArguments>("view_page_image", {
    description:
      "Inspect a PNG/JPEG page artifact visually. Use this for source, generated asset sheets, previews, and contact sheets.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async args => {
      const path = within(pageDir, text(args.path, 500));
      if (!/\.(?:png|jpe?g)$/i.test(path)) {
        throw new Error("Only PNG and JPEG images can be viewed.");
      }
      const bytes = await readFile(path);
      return toolSuccess(
        `Attached ${relative(pageDir, path)} for visual inspection.`,
        {
          data: bytes.toString("base64"),
          mimeType: /\.png$/i.test(path) ? "image/png" : "image/jpeg",
          description: relative(pageDir, path),
        },
      );
    },
  });

  const runEditppt = defineTool<ToolArguments>("run_editppt", {
    description:
      "Run one allowlisted image-to-editable-ppt page command. Fix failures before proceeding.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "image_edit",
            "image_import",
            "image_process_sheet",
            "page_build",
            "page_contact_sheet",
            "page_validate",
          ],
        },
        promptFile: { type: "string" },
        outputFile: { type: "string" },
        sourceImage: { type: "string" },
        destination: { type: "string" },
        jobId: { type: "string" },
        role: { type: "string" },
        assetNames: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async args => {
      const action = text(args.action, 100);
      let commandArgs: string[];
      if (action === "page_build") {
        commandArgs = ["page", "build", pageDir];
      } else if (action === "page_contact_sheet") {
        commandArgs = ["page", "contact-sheet", pageDir];
      } else if (action === "page_validate") {
        commandArgs = ["page", "validate", pageDir];
      } else if (action === "image_edit") {
        const promptFile = within(pageDir, text(args.promptFile, 500));
        const outputFile = within(pageDir, text(args.outputFile, 500));
        const sourceImage = within(
          pageDir,
          text(args.sourceImage, 500) || "source.png",
        );
        await mkdir(dirname(outputFile), { recursive: true });
        commandArgs = [
          "image",
          "edit",
          "--image",
          sourceImage,
          "--prompt-file",
          promptFile,
          "--out",
          outputFile,
          "--force",
          "--timeout",
          "240",
        ];
      } else if (action === "image_import") {
        const sourceImage = within(pageDir, text(args.sourceImage, 500));
        const destination = text(args.destination, 500);
        within(pageDir, destination);
        commandArgs = [
          "image",
          "import",
          pageDir,
          "--job-id",
          text(args.jobId, 100),
          "--source-image",
          sourceImage,
          "--dest",
          destination,
          "--role",
          text(args.role, 100) || "asset_sheet",
          "--backend",
          "openai-compatible-api",
        ];
        if (text(args.promptFile, 500)) {
          commandArgs.push(
            "--prompt-file",
            within(pageDir, text(args.promptFile, 500)),
          );
        }
      } else if (action === "image_process_sheet") {
        commandArgs = [
          "image",
          "process-sheet",
          pageDir,
          "--job-id",
          text(args.jobId, 100),
          "--asset-names",
          text(args.assetNames, 2_000),
          "--despill",
        ];
      } else {
        throw new Error(`Unsupported editppt action: ${action}`);
      }
      try {
        const result = await run(EDITPPT, commandArgs, {
          cwd: pageDir,
          env: backendEnv,
        });
        return `${result.stdout}\n${result.stderr}`.trim().slice(-8_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          textResultForLlm:
            `editppt ${action} failed. Fix the concrete error and retry: ${message}`,
          resultType: "failure",
          error: message,
        } satisfies ToolResultObject;
      }
    },
  });

  return [
    readText,
    writePageText,
    listPageFiles,
    viewPageImage,
    runEditppt,
  ];
}

async function convertImagesToEditablePptInternal(
  inputs: ConversionInput[],
): Promise<ConversionResult> {
  if (inputs.length < 1 || inputs.length > 12) {
    throw new Error("image-to-editable-ppt requires between 1 and 12 PNG slides.");
  }
  const images = inputs.map((input, index) => {
    const image = Buffer.from(input.sourceImageBase64, "base64");
    if (
      image.length < 8 ||
      image.length > MAX_IMAGE_BYTES ||
      !image.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      throw new Error(`Slide ${index + 1} must be a PNG under 8 MB.`);
    }
    const sha256 = createHash("sha256").update(image).digest("hex");
    if (sha256 !== input.sourceImageSha256.toLowerCase()) {
      throw new Error(`Slide ${index + 1} SHA-256 does not match the invocation.`);
    }
    return { image, sha256 };
  });
  const sourceImageSha256s = images.map(item => item.sha256);
  const invocationId = randomUUID();
  const cacheKey = createHash("sha256")
    .update(sourceImageSha256s.join(":"))
    .digest("hex");
  const cacheDir = join(
    process.env.EDITPPT_CACHE_ROOT ||
      join(tmpdir(), "presentation-editable-ppt-cache"),
    cacheKey,
  );
  try {
    const [metadataBytes, cachedPptx] = await Promise.all([
      readFile(join(cacheDir, "metadata.json"), "utf8"),
      readFile(join(cacheDir, "slides-editable.pptx")),
    ]);
    const metadata = JSON.parse(metadataBytes) as {
      runId?: unknown;
      sourceImageSha256s?: unknown;
      validationPassed?: unknown;
    };
    if (
      typeof metadata.runId === "string" &&
      JSON.stringify(metadata.sourceImageSha256s) ===
        JSON.stringify(sourceImageSha256s) &&
      metadata.validationPassed === true &&
      cachedPptx.subarray(0, 2).equals(Buffer.from("PK"))
    ) {
      return {
        invocationId,
        runId: metadata.runId,
        workflow: "image-to-editable-ppt",
        validationPassed: true,
        sourceImageSha256s,
        pptxBase64: cachedPptx.toString("base64"),
        cacheHit: true,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const runId = `editppt-${invocationId}`;
  const workDir = join(tmpdir(), "presentation-editable-ppt", invocationId);
  const runDir = join(workDir, "skill-run");
  await mkdir(workDir, { recursive: true });
  const inputPaths = await Promise.all(images.map(async ({ image }, index) => {
    const inputPath = join(
      workDir,
      `slide-${String(index + 1).padStart(3, "0")}.png`,
    );
    await writeFile(inputPath, image);
    return inputPath;
  }));
  const backendEnv = await imageBackendEnvironment();
  try {
    await run(
      EDITPPT,
      [
        "prepare",
        ...inputPaths,
        "--job-dir",
        runDir,
        "--image-backend",
        "editppt-image-cli",
      ],
      { cwd: workDir, env: backendEnv },
    );
    for (let index = 0; index < images.length; index += 1) {
      const pageId = `page_${String(index + 1).padStart(3, "0")}`;
      const agentId = `hosted-agent-${pageId}`;
      const pageDir = join(runDir, "pages", pageId);
      const workerPromptPath = join(pageDir, "worker-prompt.md");
      await run(
        PYTHON,
        [
          join(SKILL_ROOT, "scripts", "build-page-worker-prompt.py"),
          runDir,
          "--page",
          pageId,
          "--out",
          workerPromptPath,
        ],
        { cwd: workDir, env: backendEnv },
      );
      const client = await getClient();
      const sessionOptions = await getSessionOptions();
      const tools = pageTools(pageDir, backendEnv);
      sessionOptions.availableTools = tools.map(tool => tool.name);
      const session = await client.createSession({
        ...sessionOptions,
        tools,
        onPermissionRequest: () => ({ kind: "approved" }),
        systemMessage: {
          mode: "append",
          content: [
            "You are the page reconstructor for the image-to-editable-ppt skill.",
            "Use only the provided custom tools and comply with the worker prompt exactly.",
            "Continue until deterministic validation passes and every required page artifact exists.",
            "Do not return an approximate slide, a full-slide source raster, or a DOM-derived slide.",
          ].join(" "),
        },
      }) as WorkerSession;
      const workerEvents: string[] = [];
      const unsubscribeEvents = [
        session.on?.("tool.execution_start", event => {
          workerEvents.push(
            `tool.start:${String(event.data?.toolName || event.data?.name || "unknown")}`,
          );
        }),
        session.on?.("tool.execution_complete", event => {
          workerEvents.push(
            `tool.complete:${JSON.stringify(event.data || {}).slice(-1_500)}`,
          );
        }),
        session.on?.("assistant.message", event => {
          workerEvents.push(
            `assistant:${String(event.data?.content || "").slice(-500)}`,
          );
        }),
      ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
      try {
        await run(
          EDITPPT,
          [
            "run",
            "dispatch",
            runDir,
            "--page",
            pageId,
            "--agent-id",
            agentId,
            "--prompt-file",
            workerPromptPath,
            ...(images.length === 1 ? ["--local"] : []),
          ],
          { cwd: workDir, env: backendEnv },
        );
        const workerResult = await session.sendAndWait(
          {
            prompt: await readFile(workerPromptPath, "utf8"),
            attachments: [{
              type: "file",
              path: join(pageDir, "source.png"),
              displayName: `Approved generated slide ${index + 1}.png`,
            }],
          },
          AGENT_TIMEOUT_MS,
        );
        try {
          await Promise.all([
            "manifest.json",
            "page.pptx",
            "preview.png",
            "split_assets_contact.png",
            "validation.json",
            "page_result.json",
          ].map(file => stat(join(pageDir, file))));
        } catch {
          const content = (
            workerResult as { data?: { content?: unknown } } | undefined
          )?.data?.content;
          throw new Error(
            `The skill page worker for slide ${index + 1} returned without all required artifacts. ` +
            (typeof content === "string" ? content.slice(-1_000) : "") +
            ` Worker events: ${workerEvents.slice(-20).join(" | ")}`,
          );
        }
        await run(
          EDITPPT,
          [
            "run",
            "record",
            runDir,
            "--page",
            pageId,
            "--agent-id",
            agentId,
          ],
          { cwd: workDir, env: backendEnv },
        );
      } finally {
        unsubscribeEvents.forEach(unsubscribe => unsubscribe());
        await session.destroy();
      }
    }
    await run(
      EDITPPT,
      ["run", "finalize", runDir],
      { cwd: workDir, env: backendEnv },
    );
    const compatiblePath = join(workDir, "slides-editable.pptx");
    await run(
      PYTHON,
      [
        join(SKILL_ROOT, "scripts", "build-powerpoint-compatible.py"),
        runDir,
        compatiblePath,
      ],
      { cwd: workDir, env: backendEnv },
    );
    const finalValidation = JSON.parse(
      await readFile(join(runDir, "final", "validation.json"), "utf8"),
    ) as { passed?: unknown };
    if (finalValidation.passed !== true) {
      throw new Error("editppt final validation did not pass.");
    }
    const pptx = await readFile(compatiblePath);
    if (!pptx.subarray(0, 2).equals(Buffer.from("PK"))) {
      throw new Error("editppt returned an invalid PPTX package.");
    }
    await mkdir(cacheDir, { recursive: true });
    await Promise.all([
      writeFile(join(cacheDir, "slides-editable.pptx"), pptx),
      writeFile(
        join(cacheDir, "metadata.json"),
        JSON.stringify({
          runId,
          sourceImageSha256s,
          validationPassed: true,
        }),
        "utf8",
      ),
    ]);
    return {
      invocationId,
      runId,
      workflow: "image-to-editable-ppt",
      validationPassed: true,
      sourceImageSha256s,
      pptxBase64: pptx.toString("base64"),
    };
  } finally {
    if (process.env.PRESERVE_EDITPPT_RUNS !== "true") {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

export async function convertImagesToEditablePpt(
  inputs: ConversionInput[],
): Promise<ConversionResult> {
  return convertImagesToEditablePptInternal(inputs);
}

export async function convertImageToEditablePpt(
  input: ConversionInput,
): Promise<ConversionResult & { sourceImageSha256: string }> {
  const result = await convertImagesToEditablePptInternal([input]);
  return {
    ...result,
    sourceImageSha256: result.sourceImageSha256s[0],
  };
}
