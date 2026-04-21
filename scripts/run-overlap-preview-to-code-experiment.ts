import fs from "fs";
import path from "path";
import http from "http";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { chromium } from "@playwright/test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { Sandbox } from "@vercel/sandbox";
import {
  buildPreviewDrivenClonePrompt,
  generateWebsiteImageryAssets,
  runWebsiteAssetPlanner,
  type WebsiteAssetPlan,
  type WebsiteImageryComponent,
  type WebsiteGeneratedAsset
} from "../lib/website-preview-chain";
import { readCodexAuthJson } from "../lib/codex-auth";
import { getWebsitePreviewMimeType, normalizeWebsitePreviewAssetPath } from "../lib/website-artifacts";

const TEMPLATE_ROOT = path.join(process.cwd(), "templates", "website-vite-react");
const SANDBOX_ROOT = "/vercel/sandbox";
const PROJECT_DIR = `${SANDBOX_ROOT}/project`;
const INPUT_DIR = `${SANDBOX_ROOT}/input`;
const ARTIFACTS_DIR = `${SANDBOX_ROOT}/artifacts`;
const TOOLING_DIR = `${SANDBOX_ROOT}/tooling`;
const CODEX_BIN_PATH = `${TOOLING_DIR}/node_modules/.bin/codex`;
const CODEX_HOME_ROOT = `${SANDBOX_ROOT}/run-codex-home`;
const CODEX_HOME_DIR = `${CODEX_HOME_ROOT}/.codex`;
const CODEX_AUTH_PATH = `${CODEX_HOME_DIR}/auth.json`;
const GENERATED_ASSETS_DIR = `${PROJECT_DIR}/src/generated-assets`;
const DEFAULT_SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_CODEX_PACKAGE = process.env.CODEX_CLI_NPM_PACKAGE || "@openai/codex@0.111.0";
const SNAPSHOT_CACHE_PATH = path.join(process.cwd(), ".cache", "website-sandbox-snapshot.json");

interface ExperimentInput {
  title: string;
  slug: string;
  transcript: string;
  previewImagePath: string;
}

interface LocalTemplateFile {
  relativePath: string;
  buffer: Buffer;
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    process.env[key] = value;
  }
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const value = args[index + 1];
    if (typeof value === "undefined" || value.startsWith("--")) {
      parsed[key.slice(2)] = "true";
      continue;
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }

  return parsed;
}

function getExperimentInput(): ExperimentInput {
  const args = parseCliArgs();
  return {
    title: args.title || "Historical Web Preview · Overlap Asset Experiment",
    slug: args.slug || "historical-web-preview",
    transcript:
      args.transcript ||
      "Create a historian journal homepage with a portrait or archive hero, a historian name title, an abstract or journal intro panel, a recent essays strip, and a lectures or contact note.",
    previewImagePath: args.preview || path.join(process.env.HOME ?? "", "Downloads", "historical_web_preview.png")
  };
}

function getExperimentsRoot() {
  return path.join(process.cwd(), "public", "website-experiments");
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

function getVercelSandboxCredentials() {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token || !projectId || !teamId) {
    throw new Error("VERCEL_TOKEN, VERCEL_PROJECT_ID, and VERCEL_TEAM_ID are required.");
  }

  return {
    token,
    projectId,
    teamId
  };
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
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

function buildCodexShellCommand(promptPath: string, imagePaths: string[] = []) {
  const imageArgs = imagePaths.map((imagePath) => `-i ${shellEscape(imagePath)}`).join(" ");
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

  return { stdout, stderr };
}

async function listDistFiles(sandbox: Sandbox) {
  const { stdout } = await runSandboxCommand(sandbox, {
    cmd: "find",
    args: ["dist", "-type", "f", "-print"],
    cwd: PROJECT_DIR,
    label: "Listing dist files"
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readPreviewFiles(sandbox: Sandbox) {
  const relativeDistFiles = await listDistFiles(sandbox);

  return Promise.all(
    relativeDistFiles.map(async (relativeDistPath) => {
      const assetPath = relativeDistPath.replace(/^dist\//, "");
      const buffer = await sandbox.readFileToBuffer({
        path: relativeDistPath,
        cwd: PROJECT_DIR
      });

      if (!buffer) {
        throw new Error(`Missing preview file ${relativeDistPath}.`);
      }

      return {
        assetPath,
        buffer,
        mimeType: getWebsitePreviewMimeType(assetPath)
      };
    })
  );
}

function resolvePlaceholderSize(aspectRatio: WebsiteImageryComponent["aspect_ratio"]) {
  switch (aspectRatio) {
    case "portrait":
      return { width: 768, height: 1152 };
    case "landscape":
      return { width: 1152, height: 768 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function createPlaceholderAsset(component: WebsiteImageryComponent) {
  const { width, height } = resolvePlaceholderSize(component.aspect_ratio);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ede3d2" />
          <stop offset="100%" stop-color="#d8c4a5" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)" />
      <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="28" fill="none" stroke="rgba(53,40,25,0.22)" stroke-width="2" />
      <text x="50%" y="45%" text-anchor="middle" font-family="Georgia, serif" font-size="${Math.round(
        Math.min(width, height) * 0.06
      )}" fill="#40301e">${escapeHtml(component.name)}</text>
      <text x="50%" y="55%" text-anchor="middle" font-family="Avenir Next, Arial, sans-serif" font-size="${Math.round(
        Math.min(width, height) * 0.028
      )}" fill="#6a5845">placeholder while final image generates</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildOverlapClonePrompt(params: {
  assetPlan: WebsiteAssetPlan;
  transcriptText: string;
}) {
  const assetLines = params.assetPlan.imagery_components.map((component) => {
    const fileName = `${slugify(component.name)}.png`;
    return `- src/generated-assets/${fileName} -> ${component.role}. This file exists now as a placeholder. Import and use this exact file path in the implementation. Do not rename it, duplicate it elsewhere, or replace it with CSS/SVG. It will be swapped with the final matched image after your coding pass.`;
  });

  return [
    "Build a real responsive website in this Vite + React + TypeScript workspace.",
    "The primary visual source of truth is /vercel/sandbox/input/target-preview.png.",
    "The user transcript provides semantic intent. There is no sketch for this task.",
    "Recreate the target preview as closely as possible in code.",
    "This is a fidelity task, not an inspiration task.",
    "Keep visible navigation, CTAs, teaser cards, and footer links meaningful. Avoid dead links and inert buttons.",
    "Use CSS and layout code to match the page shell, typography, spacing, borders, paper tone, rounded panels, dividers, icons, and CTA treatment.",
    "Do not paste the target preview image as one giant screenshot or background.",
    "Do not fetch external images.",
    "Do not generate additional image assets yourself in this coding pass.",
    "The imagery asset slots already exist in the project and must be used directly.",
    "The current files are placeholders only. Continue coding against them and keep the import paths stable.",
    "Before major edits, create a short design-plan.md with: fidelity thesis, component list, and any unavoidable deviations.",
    "Shared imagery style language:",
    params.assetPlan.shared_style_language,
    "Stable imagery asset slots:",
    ...assetLines,
    "Verbatim user transcript:",
    `"${params.transcriptText}"`,
    "Inputs:",
    "- /vercel/sandbox/input/target-preview.png",
    "Implement the main page at route / and leave the project ready for `npm run build`."
  ].join("\n");
}

async function writePreviewFiles(rootDir: string, previewFiles: Array<{ assetPath: string; buffer: Buffer }>) {
  for (const file of previewFiles) {
    const assetPath = normalizeWebsitePreviewAssetPath(file.assetPath);
    if (!assetPath) {
      continue;
    }
    const filePath = path.join(rootDir, assetPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.buffer);
  }
}

async function startStaticServer(rootDir: string) {
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
      res.writeHead(200, {
        "Content-Type": getWebsitePreviewMimeType(relativePath)
      });
      res.end(buffer);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to start static preview server.");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function captureWebsiteScreenshot(rootDir: string, outputPath: string) {
  const { server, baseUrl } = await startStaticServer(rootDir);
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
    await page.screenshot({
      path: outputPath,
      fullPage: true,
      type: "png"
    });
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function computeMeanAbsoluteDifference(targetPreviewPath: string, codedScreenshotPath: string) {
  const targetMeta = await sharp(targetPreviewPath).metadata();
  if (!targetMeta.width || !targetMeta.height) {
    throw new Error("Unable to read target preview dimensions.");
  }

  const width = targetMeta.width;
  const height = targetMeta.height;

  const target = await sharp(targetPreviewPath).resize(width, height, { fit: "cover" }).removeAlpha().raw().toBuffer();
  const coded = await sharp(codedScreenshotPath)
    .resize(width, height, { fit: "cover", position: "top" })
    .removeAlpha()
    .raw()
    .toBuffer();

  let total = 0;
  for (let index = 0; index < target.length; index += 1) {
    total += Math.abs(target[index] - coded[index]);
  }

  return total / target.length / 255;
}

async function buildComparisonPanel(params: {
  targetPreviewPath: string;
  codedScreenshotPath: string;
  outputPath: string;
}) {
  const tileWidth = 1120;
  const tileHeight = 820;
  const margin = 36;
  const titleHeight = 96;
  const targets = [
    { label: "Target UI Preview", imagePath: params.targetPreviewPath },
    { label: "Overlap Website Screenshot", imagePath: params.codedScreenshotPath }
  ];

  const canvasWidth = margin * 3 + tileWidth * 2;
  const canvasHeight = margin * 2 + titleHeight + tileHeight;
  const base = sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: "#f3ede2"
    }
  });

  const overlays = await Promise.all(
    targets.map(async (target, index) => {
      const left = margin + index * (tileWidth + margin);
      const top = margin + titleHeight;
      const image = await sharp(target.imagePath)
        .resize(tileWidth, tileHeight, {
          fit: "contain",
          background: "#ffffff"
        })
        .png()
        .toBuffer();

      const labelSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${titleHeight}">
          <text x="0" y="38" font-family="Avenir Next, Arial, sans-serif" font-size="18" font-weight="700" fill="#241d17">${escapeHtml(
            target.label
          )}</text>
        </svg>`
      );

      return [
        { input: labelSvg, left, top: margin },
        { input: image, left, top }
      ];
    })
  );

  await base.composite(overlays.flat()).png().toFile(params.outputPath);
}

function buildReportHtml(params: {
  title: string;
  transcriptText: string;
  clonePrompt: string;
  assetPlan: WebsiteAssetPlan;
  placeholderAssets: Array<{ component: WebsiteImageryComponent; fileName: string }>;
  generatedAssets: Array<{ component: WebsiteImageryComponent; fileName: string }>;
  timings: Record<string, number>;
  madScore: number;
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6efe3;
        --panel: #fff9f1;
        --ink: #201a15;
        --muted: #655a4d;
        --line: rgba(32, 26, 21, 0.12);
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Avenir Next", "Segoe UI", Arial, sans-serif; background: linear-gradient(180deg, #fbf5ea 0%, var(--bg) 100%); color: var(--ink); }
      main { width: min(1480px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 48px; }
      h1 { margin: 0 0 10px; font: 700 clamp(2rem, 4.5vw, 3.6rem)/0.95 "Iowan Old Style", Georgia, serif; }
      p { color: var(--muted); }
      .links { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0 24px; }
      .pill { display: inline-flex; align-items: center; min-height: 42px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: #201a15; color: #fff8ef; text-decoration: none; font-weight: 700; font-size: 13px; }
      .pill.secondary { background: transparent; color: var(--ink); }
      .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 18px; }
      .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
      .metric strong { display: block; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #6c6155; margin-bottom: 6px; }
      .metric span { font: 700 24px/1.1 "Iowan Old Style", Georgia, serif; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
      .card { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 16px; box-shadow: 0 18px 40px rgba(52, 38, 24, 0.06); }
      .card.full { grid-column: 1 / -1; }
      img { display: block; width: 100%; height: auto; border-radius: 12px; border: 1px solid rgba(32, 26, 21, 0.08); background: white; }
      h2 { margin: 0 0 10px; font: 700 12px/1.2 "Avenir Next", "Segoe UI", Arial, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; color: #6c6155; }
      pre { margin: 0; padding: 16px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; border-radius: 12px; border: 1px solid rgba(32, 26, 21, 0.08); background: #f6efe4; font: 500 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .assets { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
      .asset-card { background: #fffdf8; border: 1px solid rgba(32, 26, 21, 0.08); border-radius: 16px; padding: 14px; }
      .asset-card h3 { margin: 0 0 6px; font: 700 20px/1.2 "Iowan Old Style", Georgia, serif; }
      .asset-card p { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
      @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(params.title)}</h1>
      <p>Experiment: start image generation, let Codex code against stable placeholder asset slots, then replace those slots with final generated imagery before build.</p>
      <div class="links">
        <a class="pill" href="./site/index.html" target="_blank" rel="noreferrer">Open Overlap Site</a>
        <a class="pill secondary" href="./comparison.png" target="_blank" rel="noreferrer">Open Comparison Panel</a>
      </div>
      <div class="metrics">
        <div class="metric"><strong>Planner</strong><span>${(params.timings.plannerMs / 1000).toFixed(1)}s</span></div>
        <div class="metric"><strong>Asset Generation</strong><span>${(params.timings.assetGenerationMs / 1000).toFixed(1)}s</span></div>
        <div class="metric"><strong>Codex Coding</strong><span>${(params.timings.codegenMs / 1000).toFixed(1)}s</span></div>
        <div class="metric"><strong>Wait For Final Images</strong><span>${(params.timings.waitForAssetsMs / 1000).toFixed(1)}s</span></div>
        <div class="metric"><strong>Install + Build + Export</strong><span>${(params.timings.buildExportMs / 1000).toFixed(1)}s</span></div>
        <div class="metric"><strong>Actual End To End</strong><span>${(params.timings.totalMs / 1000).toFixed(1)}s</span></div>
        <div class="metric"><strong>Naive Sequential Estimate</strong><span>${(params.timings.naiveSequentialMs / 1000).toFixed(1)}s</span></div>
        <div class="metric"><strong>MAD</strong><span>${params.madScore.toFixed(3)}</span></div>
      </div>
      <section class="grid">
        <article class="card">
          <h2>Target Preview</h2>
          <img src="./target-preview.png" alt="Target preview image" />
        </article>
        <article class="card">
          <h2>Overlap Website Screenshot</h2>
          <img src="./coded-screenshot.png" alt="Coded website screenshot" />
        </article>
        <article class="card full">
          <h2>Verbatim Transcript</h2>
          <pre>${escapeHtml(params.transcriptText)}</pre>
        </article>
        <article class="card">
          <h2>Shared Style Language</h2>
          <pre>${escapeHtml(params.assetPlan.shared_style_language)}</pre>
        </article>
        <article class="card">
          <h2>Codex Overlap Prompt</h2>
          <pre>${escapeHtml(params.clonePrompt)}</pre>
        </article>
        <article class="card full">
          <h2>Placeholder Asset Slots</h2>
          <div class="assets">
            ${params.placeholderAssets
              .map(
                ({ component, fileName }) => `
                  <div class="asset-card">
                    <h3>${escapeHtml(component.name)}</h3>
                    <p><strong>Role:</strong> ${escapeHtml(component.role)}</p>
                    <img src="./placeholders/${fileName}" alt="${escapeHtml(component.name)} placeholder" />
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
        <article class="card full">
          <h2>Final Generated Assets Swapped In</h2>
          <div class="assets">
            ${params.generatedAssets
              .map(
                ({ component, fileName }) => `
                  <div class="asset-card">
                    <h3>${escapeHtml(component.name)}</h3>
                    <p><strong>Role:</strong> ${escapeHtml(component.role)}</p>
                    <img src="./${fileName}" alt="${escapeHtml(component.name)} final asset" />
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
      </section>
    </main>
  </body>
</html>`;
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  const { title, slug, transcript, previewImagePath } = getExperimentInput();
  const previewBuffer = await readFile(previewImagePath);
  const publicRoot = path.join(
    getExperimentsRoot(),
    `overlap-preview-to-code-${slug}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
  );
  const siteRoot = path.join(publicRoot, "site");
  await rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(siteRoot, { recursive: true });
  await mkdir(path.join(publicRoot, "placeholders"), { recursive: true });

  const totalStart = Date.now();
  const plannerStart = Date.now();
  const tempPreviewPath = path.join(publicRoot, "input-preview.png");
  await writeFile(tempPreviewPath, previewBuffer);
  const assetPlan = await runWebsiteAssetPlanner({
    previewImagePath: tempPreviewPath,
    transcriptText: transcript
  });
  const plannerMs = Date.now() - plannerStart;

  const placeholderAssets = await Promise.all(
    assetPlan.imagery_components.map(async (component) => {
      const fileName = `${slugify(component.name)}.png`;
      const buffer = await createPlaceholderAsset(component);
      await writeFile(path.join(publicRoot, "placeholders", fileName), buffer);
      return {
        component,
        fileName,
        buffer
      };
    })
  );

  const assetGenerationStart = Date.now();
  const generatedAssetsPromise = generateWebsiteImageryAssets(assetPlan);

  const clonePrompt = buildOverlapClonePrompt({
    assetPlan,
    transcriptText: transcript
  });

  const credentials = getVercelSandboxCredentials();
  let source: { type: "snapshot"; snapshotId: string } | undefined;
  try {
    const snapshotCache = JSON.parse(await readFile(SNAPSHOT_CACHE_PATH, "utf8")) as { snapshotId?: string };
    if (snapshotCache.snapshotId) {
      source = {
        type: "snapshot",
        snapshotId: snapshotCache.snapshotId
      };
    }
  } catch {
    source = undefined;
  }

  const sandbox = source
    ? await Sandbox.create({
        ...credentials,
        source,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        resources: { vcpus: 2 }
      })
    : await Sandbox.create({
        ...credentials,
        runtime: "node22",
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        resources: { vcpus: 2 }
      });

  try {
    const templateFiles = await collectLocalFiles(TEMPLATE_ROOT);
    const authJson = await readCodexAuthJson();
    const workspaceFiles = [
      ...templateFiles.map((file) => ({
        path: `${PROJECT_DIR}/${file.relativePath}`,
        content: file.buffer
      })),
      {
        path: `${INPUT_DIR}/target-preview.png`,
        content: previewBuffer
      },
      {
        path: `${INPUT_DIR}/prompt.txt`,
        content: Buffer.from(clonePrompt, "utf8")
      },
      {
        path: CODEX_AUTH_PATH,
        content: Buffer.from(authJson, "utf8")
      },
      ...placeholderAssets.map((asset) => ({
        path: `${GENERATED_ASSETS_DIR}/${asset.fileName}`,
        content: asset.buffer
      }))
    ];

    await sandbox.writeFiles(workspaceFiles);
    await sandbox.fs.mkdir(ARTIFACTS_DIR, { recursive: true });

    const codegenStart = Date.now();
    await runSandboxCommand(sandbox, {
      cmd: "bash",
      args: ["-lc", buildCodexShellCommand(`${INPUT_DIR}/prompt.txt`, [`${INPUT_DIR}/target-preview.png`])],
      env: buildRunEnvironment(),
      label: "Overlap Codex website generation"
    });
    const codegenMs = Date.now() - codegenStart;

    const waitForAssetsStart = Date.now();
    const generatedAssets = await generatedAssetsPromise;
    const waitForAssetsMs = Date.now() - waitForAssetsStart;
    const assetGenerationMs = Date.now() - assetGenerationStart;

    await sandbox.writeFiles(
      generatedAssets.map((asset) => ({
        path: `${GENERATED_ASSETS_DIR}/${asset.fileName}`,
        content: asset.buffer
      }))
    );

    await sandbox.fs.rm(CODEX_HOME_ROOT, {
      recursive: true,
      force: true
    });

    const buildStart = Date.now();
    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["install"],
      cwd: PROJECT_DIR,
      env: buildRunEnvironment(),
      label: "Installing overlap website dependencies"
    });

    await runSandboxCommand(sandbox, {
      cmd: "npm",
      args: ["run", "build"],
      cwd: PROJECT_DIR,
      env: buildRunEnvironment(),
      label: "Building overlap website"
    });

    const codeArchiveFileName = `website-code-overlap.tar.gz`;
    const distArchiveFileName = `website-dist-overlap.tar.gz`;

    await runSandboxCommand(sandbox, {
      cmd: "tar",
      args: [
        "--exclude=./node_modules",
        "--exclude=./dist",
        "--exclude=./.codex",
        "-czf",
        `${ARTIFACTS_DIR}/${codeArchiveFileName}`,
        "."
      ],
      cwd: PROJECT_DIR,
      label: "Archiving overlap website source"
    });

    await runSandboxCommand(sandbox, {
      cmd: "tar",
      args: ["-czf", `${ARTIFACTS_DIR}/${distArchiveFileName}`, "dist"],
      cwd: PROJECT_DIR,
      label: "Archiving overlap website dist"
    });

    const previewFiles = await readPreviewFiles(sandbox);
    const buildExportMs = Date.now() - buildStart;
    const totalMs = Date.now() - totalStart;
    const naiveSequentialMs = plannerMs + assetGenerationMs + codegenMs + buildExportMs;

    await writePreviewFiles(
      siteRoot,
      previewFiles.map((file) => ({
        assetPath: file.assetPath,
        buffer: file.buffer
      }))
    );

    const targetPreviewPath = path.join(publicRoot, "target-preview.png");
    const codedScreenshotPath = path.join(publicRoot, "coded-screenshot.png");
    const comparisonPath = path.join(publicRoot, "comparison.png");
    await writeFile(targetPreviewPath, previewBuffer);

    for (const asset of generatedAssets) {
      await writeFile(path.join(publicRoot, asset.fileName), asset.buffer);
    }

    await captureWebsiteScreenshot(siteRoot, codedScreenshotPath);
    const madScore = await computeMeanAbsoluteDifference(targetPreviewPath, codedScreenshotPath);
    await buildComparisonPanel({
      targetPreviewPath,
      codedScreenshotPath,
      outputPath: comparisonPath
    });

    const reportHtml = buildReportHtml({
      title,
      transcriptText: transcript,
      clonePrompt,
      assetPlan,
      placeholderAssets: placeholderAssets.map(({ component, fileName }) => ({ component, fileName })),
      generatedAssets: generatedAssets.map(({ component, fileName }) => ({ component, fileName })),
      timings: {
        plannerMs,
        assetGenerationMs,
        codegenMs,
        waitForAssetsMs,
        buildExportMs,
        totalMs,
        naiveSequentialMs
      },
      madScore
    });
    await writeFile(path.join(publicRoot, "index.html"), reportHtml, "utf8");

    console.log(
      JSON.stringify(
        {
          experimentDir: publicRoot,
          reportUrl: `http://localhost:3000/website-experiments/${path.basename(publicRoot)}/index.html`,
          siteUrl: `http://localhost:3000/website-experiments/${path.basename(publicRoot)}/site/index.html`,
          timings: {
            plannerMs,
            assetGenerationMs,
            codegenMs,
            waitForAssetsMs,
            buildExportMs,
            totalMs,
            naiveSequentialMs
          },
          madScore
        },
        null,
        2
      )
    );
  } finally {
    await sandbox.stop({ blocking: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
