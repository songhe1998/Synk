import fs from "fs";
import path from "path";
import http from "http";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { chromium } from "@playwright/test";
import { ensureSessionAnalysis } from "../lib/session-pipeline";
import { generateImageFromSketch } from "../lib/scene-analysis";
import { getSessionAsset } from "../lib/session-store";
import { getWebsitePreviewMimeType, normalizeWebsitePreviewAssetPath } from "../lib/website-artifacts";
import { runWebsiteSandboxJob } from "../lib/website-sandbox";
import { WebsiteJob } from "../lib/types";

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

function getOpenAiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  return apiKey;
}

const DEFAULT_SESSION_ID = "e55e8e86-7d48-4673-9369-987f5b86dd22";
const DEFAULT_SLUG = "industrial-design-portfolio";

function getExperimentArgs() {
  return {
    sessionId: process.argv[2] || DEFAULT_SESSION_ID,
    slug: process.argv[3] || DEFAULT_SLUG
  };
}

function buildPreviewImagePrompt(transcriptText: string) {
  return [
    "Generate a single polished desktop website preview image.",
    "It must look like a real high-end website screenshot or design mockup, not a poster, painting, storyboard frame, or illustration.",
    "Use the attached labeled sketch as a low-fidelity wireframe for layout, hierarchy, and semantic roles.",
    "The label text and sketch annotations are guidance only and must not appear in the final rendered image.",
    "The result should be visually refined, UI-focused, and aligned with the user's intent and stated style.",
    "Preserve the major layout zones from the wireframe, but render them as a real website with typography, surfaces, spacing, navigation, and content modules.",
    "Keep the composition cohesive and believable as a real homepage on desktop.",
    "Verbatim user transcript:",
    `"${transcriptText.trim()}"`,
    "Do not show browser chrome, sketch lines, labels, callout arrows, or handwritten marks."
  ].join("\n");
}

function buildClonePrompt(transcriptText: string) {
  return [
    "Build a real responsive website in this Vite + React + TypeScript workspace.",
    "The primary visual source of truth is /vercel/sandbox/input/target-preview.png.",
    "Your job is to recreate that preview image as closely as possible in code.",
    "Use /vercel/sandbox/input/page-1-labeled-sketch.png and transcript.txt only as semantic support for what each region means and which areas should be functional.",
    "Match the target preview's composition, spacing, palette, typography scale, surface treatment, borders, visual density, and overall mood as faithfully as possible.",
    "Do not reinterpret the design into a different style system. This is a fidelity task, not an inspiration task.",
    "Where the target preview suggests navigation, buttons, forms, cards, tabs, or other UI elements, implement them as real components with minimal sensible interaction while keeping the visual result very close to the preview.",
    "Do not fake the page by placing the preview image as one giant background screenshot.",
    "If the preview image leaves some details ambiguous, use the labeled sketch and transcript to infer the smallest necessary functional components.",
    "Before major edits, create a short design-plan.md with: fidelity thesis, component list, and any unavoidable deviations.",
    "Prefer high visual fidelity over adding extra sections or extra copy.",
    "Keep the page responsive, but the desktop view should be the closest possible match.",
    "Verbatim user transcript:",
    `"${transcriptText.trim()}"`,
    "Inputs:",
    "- /vercel/sandbox/input/target-preview.png",
    "- /vercel/sandbox/input/page-1-labeled-sketch.png",
    "- /vercel/sandbox/input/transcript.txt",
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

async function captureWebsiteScreenshot(
  rootDir: string,
  outputPath: string,
  viewport = { width: 1440, height: 1180 }
) {
  const { server, baseUrl } = await startStaticServer(rootDir);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport,
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

async function buildComparisonPanel({
  sketchPath,
  targetPreviewPath,
  codedScreenshotPath,
  outputPath
}: {
  sketchPath: string;
  targetPreviewPath: string;
  codedScreenshotPath: string;
  outputPath: string;
}) {
  const tileWidth = 960;
  const tileHeight = 720;
  const margin = 36;
  const titleHeight = 96;

  const targets = [
    { label: "Labeled Sketch", imagePath: sketchPath },
    { label: "Target UI Preview", imagePath: targetPreviewPath },
    { label: "Coded Website Screenshot", imagePath: codedScreenshotPath }
  ];

  const canvasWidth = margin * 4 + tileWidth * 3;
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
          <text x="0" y="38" font-family="Avenir Next, Arial, sans-serif" font-size="18" font-weight="700" fill="#241d17">${target.label}</text>
        </svg>`
      );

      return [
        {
          input: labelSvg,
          left,
          top: margin
        },
        {
          input: image,
          left,
          top
        }
      ];
    })
  );

  await base
    .composite(overlays.flat())
    .png()
    .toFile(outputPath);
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

function buildExperimentReportHtml(params: {
  title: string;
  transcriptText: string;
  imagePrompt: string;
  clonePrompt: string;
  experimentSlug: string;
  previewUrl: string;
  madScore: number;
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${params.title} · Image-to-Code Experiment</title>
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
      @media (max-width: 960px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${params.title}</h1>
      <p>Image-generation preview → Codex recreation experiment.</p>
      <div class="links">
        <a class="pill" href="./site/index.html" target="_blank" rel="noreferrer">Open Recreated Site</a>
        <a class="pill secondary" href="./comparison.png" target="_blank" rel="noreferrer">Open Comparison Panel</a>
      </div>
      <div class="metrics">
        <strong>Mean absolute pixel difference:</strong> ${params.madScore.toFixed(3)}
      </div>
      <section class="grid">
        <article class="card">
          <h2>Labeled Sketch</h2>
          <img src="./labeled-sketch.png" alt="Labeled sketch" />
        </article>
        <article class="card">
          <h2>Target UI Preview</h2>
          <img src="./target-preview.png" alt="Target preview image" />
        </article>
        <article class="card full">
          <h2>Coded Website Screenshot</h2>
          <img src="./coded-screenshot.png" alt="Coded website screenshot" />
        </article>
        <article class="card full">
          <h2>Verbatim Transcript</h2>
          <pre>${escapeHtml(params.transcriptText)}</pre>
        </article>
        <article class="card">
          <h2>Image Generation Prompt</h2>
          <pre>${escapeHtml(params.imagePrompt)}</pre>
        </article>
        <article class="card">
          <h2>Codex Clone Prompt</h2>
          <pre>${escapeHtml(params.clonePrompt)}</pre>
        </article>
      </section>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const { sessionId, slug } = getExperimentArgs();
  const session = await ensureSessionAnalysis({ sessionId });
  const annotatedSketch = await getSessionAsset(sessionId, "annotatedSketch");
  if (!annotatedSketch) {
    throw new Error("Annotated sketch is missing for the selected session.");
  }

  const transcriptText = session.analysis?.transcriptText?.trim() || "";
  if (!transcriptText) {
    throw new Error("Transcript text is required for the experiment.");
  }

  const experimentId = `image-to-code-${slug}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const publicRoot = path.join(process.cwd(), "public", "website-experiments", experimentId);
  const siteRoot = path.join(publicRoot, "site");
  await rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(siteRoot, { recursive: true });

  const imagePrompt = buildPreviewImagePrompt(transcriptText);
  const targetPreview = await generateImageFromSketch({
    prompt: imagePrompt,
    sketchImage: annotatedSketch.buffer,
    apiKey: getOpenAiKey(),
    width: session.canvasWidth,
    height: session.canvasHeight,
    source: "labeled",
    imageSizePreset: "large",
    profile: "pro"
  });

  const labeledSketchPath = path.join(publicRoot, "labeled-sketch.png");
  const targetPreviewPath = path.join(publicRoot, "target-preview.png");
  await writeFile(labeledSketchPath, annotatedSketch.buffer);
  await writeFile(targetPreviewPath, targetPreview.buffer);

  const clonePrompt = buildClonePrompt(transcriptText);
  const job: WebsiteJob = {
    id: randomUUID(),
    sessionId,
    parentJobId: null,
    revisionNumber: 1,
    jobKind: "initial",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    displayName: `${session.title} Image-to-Code Experiment`,
    framework: "vite-react",
    sandboxProvider: "vercel",
    sandboxId: null,
    transcriptText,
    pages: [
      {
        id: `${sessionId}-page-1`,
        title: session.title,
        path: "/",
        sourceAssetKind: "annotatedSketch",
        sketchUrl: session.annotatedSketchUrl
      }
    ],
    prompt: clonePrompt,
    editInstructionText: null,
    editTarget: null,
    statusDetail: "Queued for experiment.",
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

  const sandboxRun = await runWebsiteSandboxJob({
    job,
    referenceImages: [
      {
        fileName: "target-preview.png",
        buffer: targetPreview.buffer
      }
    ],
    onProgress(update) {
      process.stdout.write(`[sandbox] ${update.status} ${update.statusDetail}\n`);
    }
  });

  await writePreviewFiles(
    siteRoot,
    sandboxRun.previewFiles.map((file) => ({
      assetPath: file.assetPath,
      buffer: file.buffer
    }))
  );

  const codedScreenshotPath = path.join(publicRoot, "coded-screenshot.png");
  await captureWebsiteScreenshot(siteRoot, codedScreenshotPath);

  const comparisonPath = path.join(publicRoot, "comparison.png");
  await buildComparisonPanel({
    sketchPath: labeledSketchPath,
    targetPreviewPath,
    codedScreenshotPath,
    outputPath: comparisonPath
  });

  const madScore = await computeMeanAbsoluteDifference(targetPreviewPath, codedScreenshotPath);

  await writeFile(path.join(publicRoot, "transcript.txt"), transcriptText, "utf8");
  await writeFile(path.join(publicRoot, "image-prompt.txt"), imagePrompt, "utf8");
  await writeFile(path.join(publicRoot, "clone-prompt.txt"), clonePrompt, "utf8");
  await writeFile(
    path.join(publicRoot, "metadata.json"),
    JSON.stringify(
      {
        experimentId,
        sessionId,
        slug,
        sandboxId: sandboxRun.sandboxId,
        madScore,
        reportUrl: `/website-experiments/${experimentId}/index.html`,
        recreatedSiteUrl: `/website-experiments/${experimentId}/site/index.html`
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(publicRoot, "index.html"),
    buildExperimentReportHtml({
      title: `${session.title} · Image-to-Code Experiment`,
      transcriptText,
      imagePrompt,
      clonePrompt,
      experimentSlug: slug,
      previewUrl: `/website-experiments/${experimentId}/site/index.html`,
      madScore
    }),
    "utf8"
  );

  process.stdout.write("EXPERIMENT_RESULT_START\n");
  process.stdout.write(
    JSON.stringify(
      {
        experimentId,
        sessionId,
        slug,
        sandboxId: sandboxRun.sandboxId,
        madScore,
        reportUrl: `http://localhost:3000/website-experiments/${experimentId}/index.html`,
        recreatedSiteUrl: `http://localhost:3000/website-experiments/${experimentId}/site/index.html`
      },
      null,
      2
    ) + "\n"
  );
  process.stdout.write("EXPERIMENT_RESULT_END\n");
}

void main();
