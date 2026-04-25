import fs from "fs";
import path from "path";
import http from "http";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { chromium } from "@playwright/test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { WebsiteJob } from "../lib/types";
import { getWebsitePreviewMimeType, normalizeWebsitePreviewAssetPath } from "../lib/website-artifacts";
import { runWebsiteSandboxJob } from "../lib/website-sandbox";

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

interface ExperimentInput {
  title: string;
  slug: string;
  transcript: string;
  previewImagePath: string;
  assetPlanDir?: string;
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
    title: args.title || "Historical Web Preview · Preview-to-Code Experiment",
    slug: args.slug || "historical-web-preview",
    transcript:
      args.transcript ||
      "Create a historian journal homepage with a portrait or archive hero, a historian name title, an abstract or journal intro panel, a recent essays strip, and a lectures or contact note.",
    previewImagePath: args.preview || path.join(process.env.HOME ?? "", "Downloads", "historical_web_preview.png"),
    assetPlanDir: args["asset-plan-dir"]
  };
}

function getExperimentsRoot() {
  return path.join(process.cwd(), "public", "website-experiments");
}

async function findLatestAssetPlanExperimentDir() {
  const experimentsRoot = getExperimentsRoot();
  const entries = await readdir(experimentsRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("preview-asset-plan-historical-web-preview-"))
      .map(async (entry) => {
        const fullPath = path.join(experimentsRoot, entry.name);
        const metadata = await stat(fullPath);
        return {
          fullPath,
          mtimeMs: metadata.mtimeMs
        };
      })
  );

  const latest = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) {
    throw new Error("No preview asset-plan experiment directory found. Run the asset-plan experiment first.");
  }

  return latest.fullPath;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface ImageryComponent {
  name: string;
  role: string;
  rationale: string;
  target_description: string;
  prompt: string;
  aspect_ratio: "portrait" | "landscape" | "square";
}

interface AssetPlan {
  shared_style_language: string;
  code_components: Array<{
    name: string;
    role: string;
    rationale: string;
  }>;
  imagery_components: ImageryComponent[];
}

async function loadAssetPlanExperiment(explicitDir?: string) {
  const experimentDir = explicitDir || (await findLatestAssetPlanExperimentDir());
  const assetPlanPath = path.join(experimentDir, "asset-plan.json");
  const assetPlan = JSON.parse(await readFile(assetPlanPath, "utf8")) as AssetPlan;

  const generatedAssets = await Promise.all(
    assetPlan.imagery_components.map(async (component) => {
      const fileName = `${slugify(component.name)}.png`;
      const filePath = path.join(experimentDir, fileName);
      return {
        component,
        fileName,
        buffer: await readFile(filePath)
      };
    })
  );

  return {
    experimentDir,
    assetPlan,
    generatedAssets
  };
}

function buildClonePrompt(
  assetPlan: AssetPlan,
  generatedAssets: Array<{ component: ImageryComponent; fileName: string }>,
  transcript: string
) {
  const assetLines = generatedAssets.map(
    ({ component, fileName }) =>
      `- /vercel/sandbox/input/${fileName} -> ${component.role}. Use this exact generated image as the page imagery for that slot.`
  );

  return [
    "Build a real responsive website in this Vite + React + TypeScript workspace.",
    "The primary visual source of truth is /vercel/sandbox/input/target-preview.png.",
    "The user transcript provides semantic intent. There is no sketch for this task.",
    "Recreate the target preview as closely as possible in code.",
    "This is a fidelity task, not an inspiration task.",
    "Use CSS and layout code to match the page shell, typography, spacing, borders, paper tone, rounded panels, dividers, icons, and CTA treatment.",
    "Use the supplied generated imagery components directly in the final site for the hero portrait and essay thumbnails instead of trying to redraw those image regions in CSS or SVG.",
    "Do not paste the target preview image as one giant screenshot or background.",
    "Do not fetch external images.",
    "Before major edits, create a short design-plan.md with: fidelity thesis, component list, and any unavoidable deviations.",
    "Shared imagery style language:",
    assetPlan.shared_style_language,
    "Generated imagery components to use:",
    ...assetLines,
    "Verbatim user transcript:",
    `"${transcript}"`,
    "Inputs:",
    "- /vercel/sandbox/input/target-preview.png",
    ...generatedAssets.map(({ fileName }) => `- /vercel/sandbox/input/${fileName}`),
    "Implement the page at route / and leave the project ready for `npm run build`."
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

  const target = await sharp(targetPreviewPath)
    .resize(width, height, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer();
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

async function buildComparisonPanel({
  targetPreviewPath,
  codedScreenshotPath,
  outputPath
}: {
  targetPreviewPath: string;
  codedScreenshotPath: string;
  outputPath: string;
}) {
  const tileWidth = 1120;
  const tileHeight = 820;
  const margin = 36;
  const titleHeight = 96;
  const targets = [
    { label: "Target UI Preview", imagePath: targetPreviewPath },
    { label: "Coded Website Screenshot", imagePath: codedScreenshotPath }
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

  await base.composite(overlays.flat()).png().toFile(outputPath);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildReportHtml(params: {
  title: string;
  transcriptText: string;
  clonePrompt: string;
  assetPlan: AssetPlan;
  generatedAssets: Array<{ component: ImageryComponent; fileName: string }>;
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
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", Arial, sans-serif;
        background: linear-gradient(180deg, #fbf5ea 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        width: min(1480px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 48px;
      }
      h1 {
        margin: 0 0 10px;
        font: 700 clamp(2rem, 4.5vw, 3.6rem)/0.95 "Iowan Old Style", Georgia, serif;
      }
      p { color: var(--muted); }
      .links {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin: 18px 0 24px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 42px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #201a15;
        color: #fff8ef;
        text-decoration: none;
        font-weight: 700;
        font-size: 13px;
      }
      .pill.secondary {
        background: transparent;
        color: var(--ink);
      }
      .metrics {
        margin-bottom: 18px;
        font-size: 14px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
        box-shadow: 0 18px 40px rgba(52, 38, 24, 0.06);
      }
      .card.full { grid-column: 1 / -1; }
      img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 12px;
        border: 1px solid rgba(32, 26, 21, 0.08);
        background: white;
      }
      h2 {
        margin: 0 0 10px;
        font: 700 12px/1.2 "Avenir Next", "Segoe UI", Arial, sans-serif;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #6c6155;
      }
      pre {
        margin: 0;
        padding: 16px;
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        border-radius: 12px;
        border: 1px solid rgba(32, 26, 21, 0.08);
        background: #f6efe4;
        font: 500 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .assets {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 16px;
      }
      .asset-card {
        background: #fffdf8;
        border: 1px solid rgba(32, 26, 21, 0.08);
        border-radius: 16px;
        padding: 14px;
      }
      .asset-card h3 {
        margin: 0 0 6px;
        font: 700 20px/1.2 "Iowan Old Style", Georgia, serif;
      }
      .asset-card p {
        margin: 0 0 10px;
        font-size: 14px;
        line-height: 1.5;
      }
      @media (max-width: 960px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(params.title)}</h1>
      <p>Preview-driven code generation using the full target preview plus pre-generated imagery components as reference inputs.</p>
      <div class="links">
        <a class="pill" href="./site/index.html" target="_blank" rel="noreferrer">Open Recreated Site</a>
        <a class="pill secondary" href="./comparison.png" target="_blank" rel="noreferrer">Open Comparison Panel</a>
      </div>
      <div class="metrics">
        <strong>Mean absolute pixel difference:</strong> ${params.madScore.toFixed(3)}
      </div>
      <section class="grid">
        <article class="card">
          <h2>Target Preview</h2>
          <img src="./target-preview.png" alt="Target preview image" />
        </article>
        <article class="card">
          <h2>Coded Website Screenshot</h2>
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
          <h2>Codex Clone Prompt</h2>
          <pre>${escapeHtml(params.clonePrompt)}</pre>
        </article>
        <article class="card full">
          <h2>Generated Imagery Assets Used</h2>
          <div class="assets">
            ${params.generatedAssets
              .map(
                ({ component, fileName }) => `
                  <div class="asset-card">
                    <h3>${escapeHtml(component.name)}</h3>
                    <p><strong>Role:</strong> ${escapeHtml(component.role)}</p>
                    <img src="./${fileName}" alt="${escapeHtml(component.name)}" />
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
  const { title, slug, transcript, previewImagePath, assetPlanDir } = getExperimentInput();
  const totalStart = Date.now();
  const previewBuffer = await readFile(previewImagePath);
  const { assetPlan, generatedAssets } = await loadAssetPlanExperiment(assetPlanDir);

  const experimentId = `preview-to-code-${slug}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const publicRoot = path.join(getExperimentsRoot(), experimentId);
  const siteRoot = path.join(publicRoot, "site");
  await rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(siteRoot, { recursive: true });

  const clonePrompt = buildClonePrompt(assetPlan, generatedAssets, transcript);
  const job: WebsiteJob = {
    id: randomUUID(),
    sessionId: `preview-experiment-${randomUUID()}`,
    parentJobId: null,
    revisionNumber: 1,
    jobKind: "initial",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    displayName: `${title} Recreation`,
    framework: "vite-react",
    sandboxProvider: "vercel",
    sandboxId: null,
    transcriptText: transcript,
    pages: [],
    prompt: clonePrompt,
    editInstructionText: null,
    editTarget: null,
    statusDetail: "Queued for preview-driven recreation.",
    errorMessage: null,
    previewImageUrl: null,
    codeArchiveUrl: null,
    distArchiveUrl: null,
    previewUrl: null,
    previewImageFileName: null,
    previewImageMimeType: null,
    codeArchiveFileName: null,
    codeArchiveMimeType: null,
    distArchiveFileName: null,
    distArchiveMimeType: null
  };

  const websiteBuildStart = Date.now();
  const sandboxRun = await runWebsiteSandboxJob({
    job,
    includeSketchInputs: false,
    referenceImages: [
      {
        fileName: "target-preview.png",
        buffer: previewBuffer
      },
      ...generatedAssets.map(({ fileName, buffer }) => ({
        fileName,
        buffer
      }))
    ],
    onProgress(update) {
      process.stdout.write(`[sandbox] ${update.status} ${update.statusDetail}\n`);
    }
  });
  const websiteBuildMs = Date.now() - websiteBuildStart;

  await writePreviewFiles(
    siteRoot,
    sandboxRun.previewFiles.map((file) => ({
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

  const screenshotStart = Date.now();
  await captureWebsiteScreenshot(siteRoot, codedScreenshotPath);
  await buildComparisonPanel({
    targetPreviewPath,
    codedScreenshotPath,
    outputPath: comparisonPath
  });
  const screenshotMs = Date.now() - screenshotStart;

  const madScore = await computeMeanAbsoluteDifference(targetPreviewPath, codedScreenshotPath);

  const reportHtml = buildReportHtml({
    title,
    transcriptText: transcript,
    clonePrompt,
    assetPlan,
    generatedAssets: generatedAssets.map(({ component, fileName }) => ({
      component,
      fileName
    })),
    madScore
  });

  await writeFile(path.join(publicRoot, "transcript.txt"), transcript, "utf8");
  await writeFile(path.join(publicRoot, "clone-prompt.txt"), clonePrompt, "utf8");
  await writeFile(path.join(publicRoot, "asset-plan.json"), JSON.stringify(assetPlan, null, 2), "utf8");
  await writeFile(path.join(publicRoot, "report.html"), reportHtml, "utf8");
  await writeFile(path.join(publicRoot, "index.html"), reportHtml, "utf8");

  process.stdout.write("PREVIEW_TO_CODE_EXPERIMENT_START\n");
  process.stdout.write(
    `${JSON.stringify(
      {
        experimentId,
        experimentDir: publicRoot,
        reportUrl: `http://localhost:3000/website-experiments/${experimentId}/index.html`,
        siteUrl: `http://localhost:3000/website-experiments/${experimentId}/site/index.html`,
        comparisonUrl: `http://localhost:3000/website-experiments/${experimentId}/comparison.png`,
        madScore,
        sandboxId: sandboxRun.sandboxId,
        websiteBuildMs,
        screenshotMs,
        totalMs: Date.now() - totalStart
      },
      null,
      2
    )}\n`
  );
  process.stdout.write("PREVIEW_TO_CODE_EXPERIMENT_END\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
