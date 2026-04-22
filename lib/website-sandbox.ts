import os from "os";
import http from "http";
import path from "path";
import { createHash } from "crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { WebsiteJob, WebsiteJobStatus } from "@/lib/types";
import { getWebsitePreviewMimeType } from "@/lib/website-artifacts";
import { findMetaCopyPatternMatches } from "@/lib/website-meta-copy";
import { getSessionAsset } from "@/lib/session-store";
import { readCodexAuthJson } from "@/lib/codex-auth";
import {
  type WebsiteAssetPlan,
  buildCodexPlannerPrompt,
  getWebsiteAssetPlanSchema
} from "@/lib/website-asset-plan";
import type { WebsiteGeneratedAsset } from "@/lib/website-preview-chain";

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
const REPAIR_PROMPT_PATH = `${INPUT_DIR}/repair.txt`;
const META_COPY_REPAIR_PROMPT_PATH = `${INPUT_DIR}/meta-copy-repair.txt`;
const VISUAL_QA_PROMPT_PATH = `${INPUT_DIR}/visual-qa.txt`;
const VISUAL_QA_SCREENSHOT_PATH = `${INPUT_DIR}/visual-qa-screenshot.png`;
const DEFAULT_SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_CODEX_PACKAGE = process.env.CODEX_CLI_NPM_PACKAGE || "@openai/codex@0.111.0";
const SNAPSHOT_CACHE_PATH = path.join(process.cwd(), ".cache", "website-sandbox-snapshot.json");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

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
  const finished = await sandbox.runCommand({
    cmd: params.cmd,
    args: params.args,
    cwd: params.cwd,
    env: params.env
  });
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
  referenceImages: Array<{
    fileName: string;
    buffer: Buffer;
  }> = []
) {
  const templateFiles = await getTemplateFiles();
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

  const workspaceFiles = templateFiles.map((file) => ({
    path: `${PROJECT_DIR}/${file.relativePath}`,
    content: file.buffer
  }));

  const inputFiles = [
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

function buildCodexShellCommand(promptPath: string, imagePaths: string[] = []) {
  const imageArgs = imagePaths
    .map((imagePath) => `-i ${shellEscape(imagePath)}`)
    .join(" ");
  const commonArgs = [
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "-C",
    shellEscape(PROJECT_DIR),
    imageArgs,
    "-"
  ]
    .filter(Boolean)
    .join(" ");

  return [
    `if [ -x ${shellEscape(CODEX_BIN_PATH)} ]; then`,
    `cat ${shellEscape(promptPath)} | ${shellEscape(CODEX_BIN_PATH)} exec ${commonArgs};`,
    "else",
    `cat ${shellEscape(promptPath)} | npx -y ${shellEscape(DEFAULT_CODEX_PACKAGE)} exec ${commonArgs};`,
    "fi"
  ].join(" ");
}

function buildCodexPlannerShellCommand(previewImagePath: string) {
  const commonArgs = [
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

  return [
    `if [ -x ${shellEscape(CODEX_BIN_PATH)} ]; then`,
    `cat ${shellEscape(PLANNER_PROMPT_PATH)} | ${shellEscape(CODEX_BIN_PATH)} exec ${commonArgs};`,
    "else",
    `cat ${shellEscape(PLANNER_PROMPT_PATH)} | npx -y ${shellEscape(DEFAULT_CODEX_PACKAGE)} exec ${commonArgs};`,
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

function buildMetaCopyRepairPrompt(matches: string[]) {
  const findings = matches.map((match) => `- ${match}`).join("\n");
  return [
    "The built site contains visible meta or design-process copy that should never appear to end users.",
    "Rewrite only the affected visible text so it reads like real user-facing website content.",
    "Do not mention the request, prompt, preview, wireframe, composition, placeholders, fidelity, implementation choices, or why the design was built a certain way.",
    "Preserve the overall structure, routes, styling direction, and intended meaning of the page.",
    "Keep the repaired text concise, natural, and on-brand for the site instead of explanatory.",
    "Detected suspicious phrases:",
    findings,
    "Leave the project ready for `npm run build`."
  ].join("\n");
}

function isVisualQaEnabled() {
  return process.env.WEBSITE_ENABLE_VISUAL_QA === "1";
}

function buildVisualQaPrompt(includeSketchInputs: boolean) {
  const lines = [
    "You are polishing an already built website after looking at its rendered screenshot.",
    "The attached rendered screenshot shows the current page.",
    includeSketchInputs
      ? "The attached labeled sketch shows the intended wireframe structure."
      : "The attached preview and supporting references define the intended structure and mood.",
    "Improve the existing project in place. Do not restart from scratch.",
    "Your job is to judge whether the current page needs clearer surfaces, panels, or containers to support typography and hierarchy.",
    "If the page feels flimsy, under-structured, or typographically weak without visible containers, add back well-judged panels or framed sections.",
    "If the page already has enough structure, keep it restrained and avoid adding boxes everywhere.",
    "Pay special attention to typography: headline rhythm, paragraph measure, line-height, spacing between text blocks, and whether the text feels cramped or awkwardly stranded in empty space.",
    "Do not introduce meta copy about the request, preview, composition, placeholders, fidelity, or implementation choices while polishing.",
    includeSketchInputs
      ? "The goal is not 'fewer boxes'; the goal is a page that looks good and matches the user's intent. Surface treatment should be decided from the actual screenshot and sketch, not from a fixed anti-card rule."
      : "The goal is not 'fewer boxes'; the goal is a page that looks good and matches the preview and user's intent. Surface treatment should be decided from the actual screenshot and references, not from a fixed anti-card rule.",
    "Keep the page structure recognizable and maintain responsiveness.",
    "Leave the project ready for `npm run build`."
  ];

  return lines.join("\n");
}

async function writePreviewFilesToTempDir(
  previewFiles: Array<{ assetPath: string; buffer: Buffer }>
) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "synk-website-preview-"));

  for (const file of previewFiles) {
    const filePath = path.join(rootDir, file.assetPath);
    const parentDir = path.dirname(filePath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(filePath, file.buffer);
  }

  return rootDir;
}

async function startStaticPreviewServer(rootDir: string) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end("Missing URL");
        return;
      }

      const parsed = new URL(req.url, "http://127.0.0.1");
      const relativePath = parsed.pathname === "/" ? "index.html" : parsed.pathname.slice(1);
      const resolvedPath = path.join(rootDir, relativePath);

      if (!resolvedPath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const buffer = await readFile(resolvedPath);
      const contentType = CONTENT_TYPES[path.extname(resolvedPath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(buffer);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind visual QA preview server.");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function captureVisualQaScreenshot(
  previewFiles: Array<{ assetPath: string; buffer: Buffer }>
) {
  const tempDir = await writePreviewFilesToTempDir(previewFiles);
  const { server, baseUrl } = await startStaticPreviewServer(tempDir);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1180 },
      deviceScaleFactor: 1.5
    });
    await page.goto(baseUrl, {
      waitUntil: "networkidle",
      timeout: 120000
    });
    return Buffer.from(await page.screenshot({ fullPage: true, type: "png" }));
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function extractRenderedPageText(
  previewFiles: Array<{ assetPath: string; buffer: Buffer }>
) {
  const tempDir = await writePreviewFilesToTempDir(previewFiles);
  const { server, baseUrl } = await startStaticPreviewServer(tempDir);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1180 },
      deviceScaleFactor: 1.5
    });
    await page.goto(baseUrl, {
      waitUntil: "networkidle",
      timeout: 120000
    });
    const bodyText = await page.locator("body").innerText();
    return bodyText;
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findGeneratedMetaCopyMatches(
  previewFiles: Array<{ assetPath: string; buffer: Buffer }>
) {
  const renderedText = await extractRenderedPageText(previewFiles);
  return findMetaCopyPatternMatches(renderedText);
}

export async function runWebsiteSandboxJob({
  job,
  includeSketchInputs = true,
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

    const workspaceFiles = await createWorkspaceFiles(job, referenceImages);
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
        ])
      ],
      env: buildRunEnvironment(),
      label: "Codex website generation"
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
      statusDetail: "Installing dependencies and building the website.",
      sandboxId: sandbox.sandboxId
    });

    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["install"],
      cwd: PROJECT_DIR,
      env: buildRunEnvironment(),
      label: "Installing website dependencies"
    });

    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["run", "build"],
      cwd: PROJECT_DIR,
      env: buildRunEnvironment(),
      label: "Building generated website"
    });

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
        args: ["-lc", buildCodexShellCommand(REPAIR_PROMPT_PATH)],
        cwd: PROJECT_DIR,
        env: buildRunEnvironment(),
        label: "Codex website repair"
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

    if (isVisualQaEnabled()) {
      await onProgress?.({
        status: "building",
        statusDetail: "Capturing rendered page for visual QA and targeted polish.",
        sandboxId: sandbox.sandboxId
      });

      const initialPreviewFiles = await readPreviewFiles(sandbox);
      const qaScreenshotBuffer = await captureVisualQaScreenshot(
        initialPreviewFiles.map((file) => ({
          assetPath: file.assetPath,
          buffer: file.buffer
        }))
      );
      const authJson = await readCodexAuthJson();

      await sandbox.writeFiles([
        {
          path: CODEX_AUTH_PATH,
          content: Buffer.from(authJson, "utf8")
        },
        {
          path: VISUAL_QA_PROMPT_PATH,
          content: Buffer.from(buildVisualQaPrompt(includeSketchInputs), "utf8")
        },
        {
          path: VISUAL_QA_SCREENSHOT_PATH,
          content: qaScreenshotBuffer
        }
      ]);

      await runSandboxCommand(sandbox, {
        cmd: "bash",
        args: [
          "-lc",
          buildCodexShellCommand(VISUAL_QA_PROMPT_PATH, [
            VISUAL_QA_SCREENSHOT_PATH,
            ...sketchImagePaths
          ])
        ],
        cwd: PROJECT_DIR,
        env: buildRunEnvironment(),
        label: "Codex visual QA polish"
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
        label: "Building visual QA polish pass"
      });

      await ensureStyledBuild(sandbox);
    }

    let metaCopyMatches = await findGeneratedMetaCopyMatches(await readPreviewFiles(sandbox));
    if (metaCopyMatches.length) {
      await onProgress?.({
        status: "building",
        statusDetail: "Detected leaked design-process copy in the rendered site. Running a targeted content cleanup pass.",
        sandboxId: sandbox.sandboxId
      });

      const authJson = await readCodexAuthJson();
      await sandbox.writeFiles([
        {
          path: CODEX_AUTH_PATH,
          content: Buffer.from(authJson, "utf8")
        },
        {
          path: META_COPY_REPAIR_PROMPT_PATH,
          content: Buffer.from(buildMetaCopyRepairPrompt(metaCopyMatches), "utf8")
        }
      ]);

      await runSandboxCommand(sandbox, {
        cmd: "bash",
        args: ["-lc", buildCodexShellCommand(META_COPY_REPAIR_PROMPT_PATH)],
        cwd: PROJECT_DIR,
        env: buildRunEnvironment(),
        label: "Codex meta-copy cleanup"
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
        label: "Building meta-copy cleanup pass"
      });

      await ensureStyledBuild(sandbox);

      const residualMetaCopyMatches = await findGeneratedMetaCopyMatches(await readPreviewFiles(sandbox));
      if (residualMetaCopyMatches.length) {
        throw new Error(
          `Generated site still contains visible meta design-process copy after cleanup: ${residualMetaCopyMatches.join(", ")}`
        );
      }
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
      args: ["-lc", buildCodexPlannerShellCommand(`${PLANNER_DIR}/target-preview.png`)],
      env: buildRunEnvironment(),
      label: "Codex website asset planner"
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
