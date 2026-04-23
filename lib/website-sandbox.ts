import path from "path";
import { createHash } from "crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { WebsiteJob, WebsiteJobStatus } from "@/lib/types";
import { getWebsitePreviewMimeType } from "@/lib/website-artifacts";
import { getSessionAsset } from "@/lib/session-store";
import { readCodexAuthJson } from "@/lib/codex-auth";
import {
  type WebsiteAssetPlan,
  buildCodexPlannerPrompt,
  getWebsiteAssetPlanSchema
} from "@/lib/website-asset-plan";
import type { WebsiteGeneratedAsset } from "@/lib/website-preview-chain";
import { buildWebsiteScaffoldOverrides, type WebsiteScaffoldFile } from "@/lib/website-scaffold";

const TEMPLATE_ROOT = path.join(process.cwd(), "templates", "website-vite-react");
const SANDBOX_ROOT = "/vercel/sandbox";
const PROJECT_DIR = `${SANDBOX_ROOT}/project`;
const INPUT_DIR = `${SANDBOX_ROOT}/input`;
const ARTIFACTS_DIR = `${SANDBOX_ROOT}/artifacts`;
const GENERATED_ASSETS_DIR = `${PROJECT_DIR}/src/generated-assets`;
const TOOLING_DIR = `${SANDBOX_ROOT}/tooling`;
const CODEX_BIN_PATH = `${TOOLING_DIR}/node_modules/.bin/codex`;
const CODEX_HOME_ROOT = `${SANDBOX_ROOT}/run-codex-home`;
const CODEX_HOME_DIR = `${CODEX_HOME_ROOT}/.codex`;
const CODEX_AUTH_PATH = `${CODEX_HOME_DIR}/auth.json`;
const PLANNER_DIR = `${SANDBOX_ROOT}/planner`;
const PLANNER_PROMPT_PATH = `${PLANNER_DIR}/prompt.txt`;
const PLANNER_SCHEMA_PATH = `${PLANNER_DIR}/schema.json`;
const PLANNER_OUTPUT_PATH = `${PLANNER_DIR}/plan.json`;
const PLANNER_LOG_PATH = `${PLANNER_DIR}/planner.log`;
const REPAIR_PROMPT_PATH = `${INPUT_DIR}/repair.txt`;
const CODEX_GENERATION_LOG_PATH = `${ARTIFACTS_DIR}/codex-generation.log`;
const CODEX_REPAIR_LOG_PATH = `${ARTIFACTS_DIR}/codex-repair.log`;
const DEFAULT_SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;
const SANDBOX_COMMAND_WAIT_SLICE_MS = 10 * 1000;
const DEFAULT_CODEX_PACKAGE = process.env.CODEX_CLI_NPM_PACKAGE || "@openai/codex@0.111.0";
const WEBSITE_CODEX_MODEL = process.env.WEBSITE_CODEX_MODEL?.trim() || null;
const WEBSITE_CODEX_REASONING_EFFORT = process.env.WEBSITE_CODEX_REASONING_EFFORT?.trim() || "medium";
const WEBSITE_CODEX_CODEGEN_REASONING_EFFORT =
  process.env.WEBSITE_CODEX_CODEGEN_REASONING_EFFORT?.trim() || WEBSITE_CODEX_REASONING_EFFORT;
const WEBSITE_CODEX_PLANNER_REASONING_EFFORT =
  process.env.WEBSITE_CODEX_PLANNER_REASONING_EFFORT?.trim() || WEBSITE_CODEX_REASONING_EFFORT;
const SANDBOX_BASELINE_VERSION = "2026-04-21-no-playwright-v1";
const SNAPSHOT_CACHE_PATH = path.join(process.cwd(), ".cache", "website-sandbox-snapshot.json");

interface LocalTemplateFile {
  relativePath: string;
  buffer: Buffer;
}

interface WebsiteSandboxSnapshotCache {
  snapshotId: string;
  key: string;
  createdAt: string;
}

export interface WebsiteSandboxRunInput {
  job: WebsiteJob;
  includeSketchInputs?: boolean;
  designSpecContent?: string;
  scaffoldOverrideFiles?: WebsiteScaffoldFile[];
  referenceImages?: Array<{
    fileName: string;
    buffer: Buffer;
  }>;
  projectAssetSlots?: Array<{
    fileName: string;
    buffer: Buffer;
  }>;
  finalProjectAssetsPromise?: Promise<WebsiteGeneratedAsset[]>;
  onProgress?: (update: {
    status: WebsiteJobStatus;
    statusDetail: string;
    sandboxId?: string;
  }) => Promise<void> | void;
}

export interface WebsiteSandboxRunResult {
  sandboxId: string;
  codeArchive: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  };
  distArchive: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  };
  previewFiles: Array<{
    assetPath: string;
    buffer: Buffer;
    mimeType: string;
  }>;
}

async function collectLocalFiles(rootDir: string, relativeDir = ""): Promise<LocalTemplateFile[]> {
  const currentDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: LocalTemplateFile[] = [];

  for (const entry of entries) {
    const nextRelativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectLocalFiles(rootDir, nextRelativePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push({
      relativePath: nextRelativePath.split(path.sep).join("/"),
      buffer: await readFile(path.join(rootDir, nextRelativePath))
    });
  }

  return files;
}

let templateFilesPromise: Promise<LocalTemplateFile[]> | null = null;
let sandboxSnapshotPromise: Promise<string | null> | null = null;

function getTemplateFiles() {
  if (!templateFilesPromise) {
    templateFilesPromise = collectLocalFiles(TEMPLATE_ROOT);
  }

  return templateFilesPromise;
}

async function computeTemplateSnapshotKey() {
  const files = await getTemplateFiles();
  const hash = createHash("sha256");
  hash.update(SANDBOX_BASELINE_VERSION);
  hash.update(DEFAULT_CODEX_PACKAGE);

  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update(file.buffer);
  }

  return hash.digest("hex");
}

async function readSnapshotCache() {
  try {
    return JSON.parse(await readFile(SNAPSHOT_CACHE_PATH, "utf8")) as WebsiteSandboxSnapshotCache;
  } catch {
    return null;
  }
}

async function writeSnapshotCache(cache: WebsiteSandboxSnapshotCache) {
  await mkdir(path.dirname(SNAPSHOT_CACHE_PATH), { recursive: true });
  await writeFile(SNAPSHOT_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function getVercelSandboxCredentials() {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token || !projectId || !teamId) {
    throw new Error("VERCEL_TOKEN, VERCEL_PROJECT_ID, and VERCEL_TEAM_ID are required for website sandbox jobs.");
  }

  return {
    token,
    projectId,
    teamId
  };
}

async function ensureWebsiteSandboxSnapshot(credentials: ReturnType<typeof getVercelSandboxCredentials>) {
  if (process.env.WEBSITE_DISABLE_SANDBOX_SNAPSHOT === "1") {
    return null;
  }

  if (process.env.WEBSITE_SANDBOX_SNAPSHOT_ID) {
    return process.env.WEBSITE_SANDBOX_SNAPSHOT_ID;
  }

  const key = await computeTemplateSnapshotKey();
  const cached = await readSnapshotCache();

  if (cached?.snapshotId && cached.key === key) {
    try {
      const snapshot = await Snapshot.get({
        snapshotId: cached.snapshotId,
        teamId: credentials.teamId,
        token: credentials.token
      });
      if (snapshot.status === "created") {
        return cached.snapshotId;
      }
    } catch {
      // Fall through and rebuild the baseline snapshot.
    }
  }

  const templateFiles = await getTemplateFiles();
  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: "node22",
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    resources: {
      vcpus: 2
    }
  });

  try {
    await sandbox.writeFiles(
      templateFiles.map((file) => ({
        path: `${PROJECT_DIR}/${file.relativePath}`,
        content: file.buffer
      }))
    );

    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["install", "--prefix", TOOLING_DIR, DEFAULT_CODEX_PACKAGE],
      env: buildRunEnvironment(),
      label: "Installing cached Codex CLI"
    });

    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["install"],
      cwd: PROJECT_DIR,
      env: buildRunEnvironment(),
      label: "Installing cached website template dependencies"
    });

    const snapshot = await sandbox.snapshot({ expiration: 0 });
    await writeSnapshotCache({
      snapshotId: snapshot.snapshotId,
      key,
      createdAt: new Date().toISOString()
    });
    return snapshot.snapshotId;
  } finally {
    if (sandbox.status !== "stopped" && sandbox.status !== "failed") {
      await sandbox.stop({ blocking: true }).catch(() => undefined);
    }
  }
}

async function getSandboxCreateSource(credentials: ReturnType<typeof getVercelSandboxCredentials>) {
  if (!sandboxSnapshotPromise) {
    sandboxSnapshotPromise = ensureWebsiteSandboxSnapshot(credentials).catch(() => null);
  }

  const snapshotId = await sandboxSnapshotPromise;
  return snapshotId
    ? {
        type: "snapshot" as const,
        snapshotId
      }
    : undefined;
}

async function runSandboxCommand(
  sandbox: Sandbox,
  params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    label: string;
  }
) {
  const detached = await sandbox.runCommand({
    cmd: params.cmd,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    detached: true
  });
  const credentials = getVercelSandboxCredentials();
  const deadline = Date.now() + DEFAULT_SANDBOX_TIMEOUT_MS;
  let finished;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`${params.label} timed out after ${Math.round(DEFAULT_SANDBOX_TIMEOUT_MS / 1000)} seconds.`);
    }

    try {
      finished = await detached.wait({
        signal: AbortSignal.timeout(Math.min(SANDBOX_COMMAND_WAIT_SLICE_MS, remainingMs))
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const isWaitSliceTimeout =
        message.includes("aborted") ||
        message.includes("timeout") ||
        message.includes("timed out") ||
        message.includes("signal");

      if (!isWaitSliceTimeout) {
        throw error;
      }

      const sandboxSnapshot = await Sandbox.get({
        sandboxId: sandbox.sandboxId,
        teamId: credentials.teamId,
        projectId: credentials.projectId,
        token: credentials.token
      }).catch(() => null);

      if (sandboxSnapshot && sandboxSnapshot.status !== "running" && sandboxSnapshot.status !== "pending") {
        throw new Error(
          `${params.label} terminated because sandbox ${sandboxSnapshot.status} before the command reported completion.`
        );
      }
    }
  }

  const stdout = await finished.stdout();
  const stderr = await finished.stderr();

  if (finished.exitCode !== 0) {
    const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
    throw new Error(
      `${params.label} failed with exit code ${finished.exitCode}.${combinedOutput ? `\n${combinedOutput}` : ""}`
    );
  }

  return {
    stdout,
    stderr
  };
}

async function readPreviewFiles(sandbox: Sandbox) {
  const { stdout } = await runSandboxCommand(sandbox, {
    cmd: "find",
    args: ["dist", "-type", "f", "-print"],
    cwd: PROJECT_DIR,
    label: "Listing website preview files"
  });

  const relativeDistFiles = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const previewFiles = await Promise.all(
    relativeDistFiles.map(async (relativeDistPath) => {
      const assetPath = relativeDistPath.replace(/^dist\//, "");
      const buffer = await sandbox.readFileToBuffer({
        path: relativeDistPath,
        cwd: PROJECT_DIR
      });

      if (!buffer) {
        throw new Error(`Missing website preview file ${relativeDistPath}.`);
      }

      return {
        assetPath,
        buffer,
        mimeType: getWebsitePreviewMimeType(assetPath)
      };
    })
  );

  return previewFiles;
}

async function createWorkspaceFiles(
  job: WebsiteJob,
  designSpecContent?: string,
  scaffoldOverrideFiles: WebsiteScaffoldFile[] = [],
  referenceImages: Array<{
    fileName: string;
    buffer: Buffer;
  }> = []
) {
  const templateFiles = await getTemplateFiles();
  const scaffoldOverrides = buildWebsiteScaffoldOverrides(job);
  const authJson = await readCodexAuthJson();
  const inputJson = JSON.stringify(
    {
      sessionId: job.sessionId,
      jobId: job.id,
      framework: job.framework,
      transcript: job.transcriptText,
      pages: job.pages.map((page, index) => ({
        id: page.id,
        title: page.title,
        path: page.path,
        sourceAssetKind: page.sourceAssetKind,
        sketchFile: `page-${index + 1}-labeled-sketch.png`
      }))
    },
    null,
    2
  );

  const overrideByPath = new Map<string, Buffer>();
  for (const file of scaffoldOverrides.files) {
    overrideByPath.set(file.relativePath, file.buffer);
  }
  for (const file of scaffoldOverrideFiles) {
    overrideByPath.set(file.relativePath, file.buffer);
  }

  const workspaceFiles = templateFiles.map((file) => ({
    path: `${PROJECT_DIR}/${file.relativePath}`,
    content: overrideByPath.get(file.relativePath) ?? file.buffer
  }));

  const inputFiles = [
    {
      path: `${PROJECT_DIR}/DESIGN.md`,
      content: Buffer.from(designSpecContent ?? "No additional design spec was provided for this run.", "utf8")
    },
    {
      path: `${INPUT_DIR}/transcript.txt`,
      content: Buffer.from(job.transcriptText, "utf8")
    },
    {
      path: `${INPUT_DIR}/input.json`,
      content: Buffer.from(inputJson, "utf8")
    },
    {
      path: `${INPUT_DIR}/prompt.txt`,
      content: Buffer.from(job.prompt, "utf8")
    },
    {
      path: CODEX_AUTH_PATH,
      content: Buffer.from(authJson, "utf8")
    },
    ...referenceImages.map((image) => ({
      path: `${INPUT_DIR}/${image.fileName}`,
      content: image.buffer
    }))
  ];

  return [
    ...workspaceFiles,
    ...inputFiles,
  ];
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildCodexShellCommand(
  promptPath: string,
  imagePaths: string[] = [],
  logPath?: string,
  reasoningEffort = WEBSITE_CODEX_CODEGEN_REASONING_EFFORT
) {
  const imageArgs = imagePaths
    .map((imagePath) => `-i ${shellEscape(imagePath)}`)
    .join(" ");
  const commonArgs = [
    WEBSITE_CODEX_MODEL ? `-m ${shellEscape(WEBSITE_CODEX_MODEL)}` : null,
    `-c ${shellEscape(`model_reasoning_effort="${reasoningEffort}"`)}`,
    "--color never",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    shellEscape(PROJECT_DIR),
    imageArgs,
    "-"
  ]
    .filter(Boolean)
    .join(" ");
  const pipedCommand = logPath
    ? `cat ${shellEscape(promptPath)} | COMMAND_PLACEHOLDER > ${shellEscape(logPath)} 2>&1`
    : `cat ${shellEscape(promptPath)} | COMMAND_PLACEHOLDER`;

  return [
    `if [ -x ${shellEscape(CODEX_BIN_PATH)} ]; then`,
    `${pipedCommand.replace("COMMAND_PLACEHOLDER", `${shellEscape(CODEX_BIN_PATH)} exec ${commonArgs}`)};`,
    "else",
    `${pipedCommand.replace("COMMAND_PLACEHOLDER", `npx -y ${shellEscape(DEFAULT_CODEX_PACKAGE)} exec ${commonArgs}`)};`,
    "fi"
  ].join(" ");
}

function buildCodexPlannerShellCommand(previewImagePath: string, logPath?: string) {
  const commonArgs = [
    WEBSITE_CODEX_MODEL ? `-m ${shellEscape(WEBSITE_CODEX_MODEL)}` : null,
    `-c ${shellEscape(`model_reasoning_effort="${WEBSITE_CODEX_PLANNER_REASONING_EFFORT}"`)}`,
    "--skip-git-repo-check",
    "--ephemeral",
    "-s",
    "read-only",
    "-C",
    shellEscape(PLANNER_DIR),
    "-i",
    shellEscape(previewImagePath),
    "--output-schema",
    shellEscape(PLANNER_SCHEMA_PATH),
    "--output-last-message",
    shellEscape(PLANNER_OUTPUT_PATH),
    "-"
  ].join(" ");
  const pipedCommand = logPath
    ? `set -o pipefail; cat ${shellEscape(PLANNER_PROMPT_PATH)} | COMMAND_PLACEHOLDER 2>&1 | tee ${shellEscape(logPath)}`
    : `cat ${shellEscape(PLANNER_PROMPT_PATH)} | COMMAND_PLACEHOLDER`;

  return [
    `if [ -x ${shellEscape(CODEX_BIN_PATH)} ]; then`,
    `${pipedCommand.replace("COMMAND_PLACEHOLDER", `${shellEscape(CODEX_BIN_PATH)} exec ${commonArgs}`)};`,
    "else",
    `${pipedCommand.replace("COMMAND_PLACEHOLDER", `npx -y ${shellEscape(DEFAULT_CODEX_PACKAGE)} exec ${commonArgs}`)};`,
    "fi"
  ].join(" ");
}

function buildRunEnvironment() {
  return {
    CI: "1",
    HOME: CODEX_HOME_ROOT,
    CODEX_HOME: CODEX_HOME_DIR,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_prefer_offline: "true"
  };
}

async function listDistCssFiles(sandbox: Sandbox) {
  const { stdout } = await runSandboxCommand(sandbox, {
    cmd: "find",
    args: ["dist", "-type", "f", "-name", "*.css", "-print"],
    cwd: PROJECT_DIR,
    label: "Listing built CSS assets"
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listDistTextFiles(sandbox: Sandbox) {
  const { stdout } = await runSandboxCommand(sandbox, {
    cmd: "find",
    args: [
      "dist",
      "-type",
      "f",
      "(",
      "-name",
      "*.html",
      "-o",
      "-name",
      "*.js",
      "-o",
      "-name",
      "*.css",
      "-o",
      "-name",
      "*.json",
      ")",
      "-print"
    ],
    cwd: PROJECT_DIR,
    label: "Listing built text assets"
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureStyledBuild(sandbox: Sandbox) {
  const cssFiles = await listDistCssFiles(sandbox);

  if (!cssFiles.length) {
    throw new Error("The generated site built without any CSS assets.");
  }
}

function buildRepairPrompt() {
  return [
    "The current site builds, but it is missing a real stylesheet-driven presentation or looks too close to browser-default HTML.",
    "Keep the current page structure, content, and wireframe fidelity.",
    "Repair the existing project in place so the final result is clearly designed and polished.",
    "Do not introduce meta copy about the request, preview, composition, placeholders, fidelity, or implementation choices.",
    "Ensure a global stylesheet or equivalent non-default styling is imported and applied.",
    "Keep responsiveness, visible hierarchy, and button/input styling intact.",
    "Do not restart from scratch unless necessary. Leave the workspace ready for `npm run build`."
  ].join("\n");
}

async function readSandboxTextTail(sandbox: Sandbox, filePath: string, maxChars = 4000) {
  const buffer = await sandbox.readFileToBuffer({ path: filePath }).catch(() => null);
  if (!buffer) {
    return null;
  }

  const text = buffer.toString("utf8").trim();
  if (!text) {
    return null;
  }

  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function appendFailureContext(error: unknown, label: string, details: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  if (!details) {
    return new Error(message);
  }

  return new Error(`${message}\n\n${label}:\n${details}`);
}

async function installAndBuildWebsiteProject(sandbox: Sandbox) {
  let initialBuildError: Error | null = null;

  try {
    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["run", "build"],
      cwd: PROJECT_DIR,
      env: buildRunEnvironment(),
      label: "Building generated website"
    });
    return;
  } catch (error) {
    initialBuildError = error instanceof Error ? error : new Error(String(error));
  }

  await runSandboxCommand(sandbox, {
    cmd: "npm",
    args: ["install"],
    cwd: PROJECT_DIR,
    env: buildRunEnvironment(),
    label: "Installing website dependencies"
  });

  try {
    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["run", "build"],
      cwd: PROJECT_DIR,
      env: buildRunEnvironment(),
      label: "Building generated website"
    });
  } catch (error) {
    const retriedMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`${initialBuildError.message}\n\nRetry after npm install also failed:\n${retriedMessage}`);
  }
}

export async function runWebsiteSandboxJob({
  job,
  includeSketchInputs = true,
  designSpecContent,
  scaffoldOverrideFiles = [],
  referenceImages = [],
  projectAssetSlots = [],
  finalProjectAssetsPromise,
  onProgress
}: WebsiteSandboxRunInput): Promise<WebsiteSandboxRunResult> {
  const credentials = getVercelSandboxCredentials();
  const source = await getSandboxCreateSource(credentials);
  const sandbox = source
    ? await Sandbox.create({
        ...credentials,
        source,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        resources: {
          vcpus: 2
        }
      })
    : await Sandbox.create({
        ...credentials,
        runtime: "node22",
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        resources: {
          vcpus: 2
        }
      });

  try {
    await onProgress?.({
      status: "running",
      statusDetail: "Sandbox ready. Preparing the website workspace.",
      sandboxId: sandbox.sandboxId
    });

    const workspaceFiles = await createWorkspaceFiles(job, designSpecContent, scaffoldOverrideFiles, referenceImages);
    const sketchFiles = includeSketchInputs
      ? await Promise.all(
          job.pages.map(async (page, index) => {
            const asset = await getSessionAsset(job.sessionId, page.sourceAssetKind);
            if (!asset) {
              throw new Error(`Missing sketch input for page ${index + 1}.`);
            }

            return {
              path: `${INPUT_DIR}/page-${index + 1}-labeled-sketch.png`,
              content: asset.buffer
            };
          })
        )
      : [];
    const sketchImagePaths = includeSketchInputs
      ? job.pages.map((_, index) => `${INPUT_DIR}/page-${index + 1}-labeled-sketch.png`)
      : [];

    await sandbox.fs.mkdir(GENERATED_ASSETS_DIR, { recursive: true });
    await sandbox.writeFiles([
      ...workspaceFiles,
      ...sketchFiles,
      ...projectAssetSlots.map((asset) => ({
        path: `${GENERATED_ASSETS_DIR}/${asset.fileName}`,
        content: asset.buffer
      }))
    ]);
    await sandbox.fs.mkdir(ARTIFACTS_DIR, { recursive: true });

    await onProgress?.({
      status: "running",
      statusDetail: finalProjectAssetsPromise
        ? "Generating website code with Codex while matched imagery renders in parallel."
        : "Generating website code with Codex.",
      sandboxId: sandbox.sandboxId
    });

    await runSandboxCommand(sandbox, {
      cmd: "bash",
      args: [
        "-lc",
        buildCodexShellCommand(`${INPUT_DIR}/prompt.txt`, [
          ...referenceImages.map((image) => `${INPUT_DIR}/${image.fileName}`),
          ...sketchImagePaths
        ], CODEX_GENERATION_LOG_PATH)
      ],
      env: buildRunEnvironment(),
      label: "Codex website generation"
    }).catch(async (error) => {
      const details = await readSandboxTextTail(sandbox, CODEX_GENERATION_LOG_PATH);
      throw appendFailureContext(error, "Codex generation log tail", details);
    });

    await sandbox.fs.rm(CODEX_HOME_ROOT, {
      recursive: true,
      force: true
    });

    if (finalProjectAssetsPromise) {
      await onProgress?.({
        status: "building",
        statusDetail: "Waiting for any remaining preview-matched imagery and swapping final assets into the project.",
        sandboxId: sandbox.sandboxId
      });

      const finalProjectAssets = await finalProjectAssetsPromise;
      if (finalProjectAssets.length) {
        await sandbox.writeFiles(
          finalProjectAssets.map((asset) => ({
            path: `${GENERATED_ASSETS_DIR}/${asset.fileName}`,
            content: asset.buffer
          }))
        );
      }
    }

    await onProgress?.({
      status: "building",
      statusDetail: "Building the website with cached dependencies and only installing packages if the generated project truly needs them.",
      sandboxId: sandbox.sandboxId
    });

    await installAndBuildWebsiteProject(sandbox);

    try {
      await ensureStyledBuild(sandbox);
    } catch {
      await onProgress?.({
        status: "building",
        statusDetail: "Generated site looks under-styled. Running a targeted Codex repair pass.",
        sandboxId: sandbox.sandboxId
      });

      const authJson = await readCodexAuthJson();
      await sandbox.writeFiles([
        {
          path: CODEX_AUTH_PATH,
          content: Buffer.from(authJson, "utf8")
        },
        {
          path: REPAIR_PROMPT_PATH,
          content: Buffer.from(buildRepairPrompt(), "utf8")
        }
      ]);

      await runSandboxCommand(sandbox, {
        cmd: "bash",
        args: ["-lc", buildCodexShellCommand(REPAIR_PROMPT_PATH, [], CODEX_REPAIR_LOG_PATH)],
        cwd: PROJECT_DIR,
        env: buildRunEnvironment(),
        label: "Codex website repair"
      }).catch(async (error) => {
        const details = await readSandboxTextTail(sandbox, CODEX_REPAIR_LOG_PATH);
        throw appendFailureContext(error, "Codex repair log tail", details);
      });

      await sandbox.fs.rm(CODEX_HOME_ROOT, {
        recursive: true,
        force: true
      });

      await runSandboxCommand(sandbox, {
        cmd: "npm",
        args: ["run", "build"],
        cwd: PROJECT_DIR,
        env: buildRunEnvironment(),
        label: "Building repaired website"
      });

      await ensureStyledBuild(sandbox);
    }

    await onProgress?.({
      status: "exporting",
      statusDetail: "Exporting website artifacts and static preview files.",
      sandboxId: sandbox.sandboxId
    });

    const codeArchiveFileName = `website-code-${job.id}.tar.gz`;
    const distArchiveFileName = `website-dist-${job.id}.tar.gz`;

    await runSandboxCommand(sandbox, {
      cmd: "tar",
      args: [
        "--exclude=./node_modules",
        "--exclude=./dist",
        "--exclude=./.codex",
        "--exclude=./.codex-inputs",
        "-czf",
        `${ARTIFACTS_DIR}/${codeArchiveFileName}`,
        "."
      ],
      cwd: PROJECT_DIR,
      label: "Archiving generated website source"
    });

    await runSandboxCommand(sandbox, {
      cmd: "tar",
      args: ["-czf", `${ARTIFACTS_DIR}/${distArchiveFileName}`, "dist"],
      cwd: PROJECT_DIR,
      label: "Archiving generated website dist"
    });

    const [codeArchiveBuffer, distArchiveBuffer, previewFiles] = await Promise.all([
      sandbox.readFileToBuffer({ path: `${ARTIFACTS_DIR}/${codeArchiveFileName}` }),
      sandbox.readFileToBuffer({ path: `${ARTIFACTS_DIR}/${distArchiveFileName}` }),
      readPreviewFiles(sandbox)
    ]);

    if (!codeArchiveBuffer || !distArchiveBuffer) {
      throw new Error("Sandbox finished without returning the generated website archives.");
    }

    return {
      sandboxId: sandbox.sandboxId,
      codeArchive: {
        buffer: codeArchiveBuffer,
        fileName: codeArchiveFileName,
        mimeType: "application/gzip"
      },
      distArchive: {
        buffer: distArchiveBuffer,
        fileName: distArchiveFileName,
        mimeType: "application/gzip"
      },
      previewFiles
    };
  } finally {
    await sandbox.stop({ blocking: true }).catch(() => undefined);
  }
}

export async function runWebsiteAssetPlanner(params: {
  previewImageBuffer: Buffer;
  transcriptText: string;
}) {
  const credentials = getVercelSandboxCredentials();
  const source = await getSandboxCreateSource(credentials);
  const sandbox = source
    ? await Sandbox.create({
        ...credentials,
        source,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        resources: {
          vcpus: 2
        }
      })
    : await Sandbox.create({
        ...credentials,
        runtime: "node22",
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        resources: {
          vcpus: 2
        }
      });

  try {
    const authJson = await readCodexAuthJson();
    await sandbox.fs.mkdir(PLANNER_DIR, { recursive: true });
    await sandbox.writeFiles([
      {
        path: PLANNER_PROMPT_PATH,
        content: Buffer.from(buildCodexPlannerPrompt(params.transcriptText), "utf8")
      },
      {
        path: PLANNER_SCHEMA_PATH,
        content: Buffer.from(JSON.stringify(getWebsiteAssetPlanSchema(), null, 2), "utf8")
      },
      {
        path: `${PLANNER_DIR}/target-preview.png`,
        content: params.previewImageBuffer
      },
      {
        path: CODEX_AUTH_PATH,
        content: Buffer.from(authJson, "utf8")
      }
    ]);

    await runSandboxCommand(sandbox, {
      cmd: "bash",
      args: ["-lc", buildCodexPlannerShellCommand(`${PLANNER_DIR}/target-preview.png`, PLANNER_LOG_PATH)],
      env: buildRunEnvironment(),
      label: "Codex website asset planner"
    }).catch(async (error) => {
      const details = await readSandboxTextTail(sandbox, PLANNER_LOG_PATH);
      throw appendFailureContext(error, "Codex planner log tail", details);
    });

    const outputBuffer = await sandbox.readFileToBuffer({
      path: PLANNER_OUTPUT_PATH
    });

    if (!outputBuffer) {
      throw new Error("Sandbox planner finished without returning an asset plan.");
    }

    return JSON.parse(outputBuffer.toString("utf8")) as WebsiteAssetPlan;
  } finally {
    if (sandbox.status !== "stopped" && sandbox.status !== "failed") {
      await sandbox.stop({ blocking: true }).catch(() => undefined);
    }
  }
}
