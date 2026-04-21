import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { generateImageFromSketch } from "../lib/scene-analysis";

interface RoundCTask {
  sessionId: string;
  slug: string;
  title: string;
  transcriptText: string;
}

interface SessionMeta {
  canvasWidth: number;
  canvasHeight: number;
}

interface AssetPlanOutput {
  experimentId: string;
  experimentDir: string;
  reportUrl: string;
  contactSheetUrl: string;
  generatedAssetCount: number;
  plannerMs: number;
  imageGenerationMs: number;
  totalMs: number;
}

interface PreviewToCodeOutput {
  experimentId: string;
  experimentDir: string;
  reportUrl: string;
  siteUrl: string;
  comparisonUrl: string;
  madScore: number;
  sandboxId: string;
  websiteBuildMs: number;
  screenshotMs: number;
  totalMs: number;
}

interface SampleResult {
  slug: string;
  title: string;
  transcriptText: string;
  generatedPreviewPath: string;
  previewGenerationMs: number;
  assetPlan: AssetPlanOutput;
  previewToCode: PreviewToCodeOutput;
  wallMs: number;
}

const SELECTED_SLUGS = [
  "historian-journal-homepage",
  "boutique-hotel-booking",
  "climate-relief-campaign-page",
  "logistics-ops-dashboard",
  "privacy-security-settings"
] as const;

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

function loadRoundCTasks() {
  const benchmarkPath = path.join(
    process.cwd(),
    "data",
    "website-benchmarks",
    "website-like-round-c-2026-04-20.json"
  );
  const payload = JSON.parse(fs.readFileSync(benchmarkPath, "utf8")) as { tasks: RoundCTask[] };
  return payload.tasks.filter((task) => SELECTED_SLUGS.includes(task.slug as (typeof SELECTED_SLUGS)[number]));
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

async function readSessionFixture(sessionId: string) {
  const sessionRoot = path.join(process.cwd(), "data", "sessions", sessionId);
  const sketchPath = path.join(sessionRoot, "annotated-sketch.png");
  const metaPath = path.join(sessionRoot, "meta.json");

  const [sketchBuffer, metaRaw] = await Promise.all([readFile(sketchPath), readFile(metaPath, "utf8")]);
  const meta = JSON.parse(metaRaw) as SessionMeta;

  return {
    sketchBuffer,
    meta
  };
}

async function runJsonScript<T>(scriptPath: string, args: string[], startMarker: string, endMarker: string) {
  const startedAt = Date.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", scriptPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutChunks.push(text);
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrChunks.push(text);
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${path.basename(scriptPath)} failed with code ${code}\n${stdoutChunks.join("")}\n${stderrChunks.join("")}`
          )
        );
        return;
      }
      resolve();
    });
  });

  const stdout = stdoutChunks.join("");
  const startIndex = stdout.indexOf(startMarker);
  const endIndex = stdout.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`Unable to parse JSON markers for ${path.basename(scriptPath)}.`);
  }

  const jsonText = stdout
    .slice(startIndex + startMarker.length, endIndex)
    .trim();
  const payload = JSON.parse(jsonText) as T;

  return {
    payload,
    wallMs: Date.now() - startedAt
  };
}

function isRetryableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UND_ERR_SOCKET") ||
    message.includes("TypeError: terminated") ||
    message.includes("ECONNRESET") ||
    message.includes("other side closed")
  );
}

async function runJsonScriptWithRetry<T>(
  scriptPath: string,
  args: string[],
  startMarker: string,
  endMarker: string,
  label: string,
  maxAttempts = 3
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runJsonScript<T>(scriptPath, args, startMarker, endMarker);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }
      process.stderr.write(
        `[retry] ${label} failed on attempt ${attempt}/${maxAttempts}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function formatMs(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildSummaryHtml(params: {
  title: string;
  results: SampleResult[];
}) {
  const rows = params.results
    .map(
      (result) => `
        <tr>
          <td>${result.title}</td>
          <td>${result.slug}</td>
          <td><a href="./${result.slug}/generated-preview.png" target="_blank" rel="noreferrer">preview</a></td>
          <td><a href="${result.assetPlan.reportUrl}" target="_blank" rel="noreferrer">asset-plan</a></td>
          <td><a href="${result.previewToCode.reportUrl}" target="_blank" rel="noreferrer">report</a></td>
          <td><a href="${result.previewToCode.siteUrl}" target="_blank" rel="noreferrer">site</a></td>
          <td>${result.assetPlan.generatedAssetCount}</td>
          <td>${result.previewToCode.madScore.toFixed(3)}</td>
          <td>${formatMs(result.previewGenerationMs)}</td>
          <td>${formatMs(result.assetPlan.totalMs)}</td>
          <td>${formatMs(result.previewToCode.totalMs)}</td>
          <td>${formatMs(result.wallMs)}</td>
        </tr>
      `
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${params.title}</title>
    <style>
      body {
        margin: 0;
        padding: 24px;
        font-family: "Avenir Next", "Segoe UI", Arial, sans-serif;
        background: #f6efe3;
        color: #201a15;
      }
      main {
        width: min(1600px, 100%);
        margin: 0 auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #fff9f1;
        border: 1px solid rgba(32, 26, 21, 0.12);
      }
      th, td {
        padding: 10px 12px;
        border-bottom: 1px solid rgba(32, 26, 21, 0.08);
        vertical-align: top;
        font-size: 14px;
      }
      th {
        text-align: left;
        background: #f2e7d7;
      }
      a {
        color: #201a15;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${params.title}</h1>
      <p>Full chain: labeled sketch + transcript -> generated preview -> Codex asset plan -> generated imagery components -> preview-driven code recreation.</p>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Slug</th>
            <th>Generated Preview</th>
            <th>Asset Plan</th>
            <th>Report</th>
            <th>Site</th>
            <th>Assets</th>
            <th>MAD</th>
            <th>Preview Gen</th>
            <th>Asset Plan</th>
            <th>Preview→Code</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </main>
  </body>
</html>`;
}

async function persistSummary(params: {
  benchmarkId: string;
  selectedSlugs: readonly string[];
  totalMs: number;
  results: SampleResult[];
  jsonPath: string;
  publicRoot: string;
}) {
  const summary = {
    benchmarkId: params.benchmarkId,
    selectedSlugs: params.selectedSlugs,
    totalMs: params.totalMs,
    results: params.results
  };

  await writeFile(params.jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(params.publicRoot, "index.html"),
    buildSummaryHtml({
      title: "Sketch->Preview->Code Round C Sample",
      results: params.results
    }),
    "utf8"
  );
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const tasks = loadRoundCTasks();
  const benchmarkId = `sketch-preview-driven-round-c-sample-${new Date().toISOString().slice(0, 10)}`;
  const publicRoot = path.join(process.cwd(), "public", "website-experiments", benchmarkId);
  const jsonPath = path.join(
    process.cwd(),
    "data",
    "website-benchmarks",
    `${benchmarkId}-results.json`
  );

  await rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(publicRoot, { recursive: true });

  const results: SampleResult[] = [];

  const benchmarkStartedAt = Date.now();
  for (const task of tasks) {
    const caseStartedAt = Date.now();
    process.stdout.write(`\n=== FULL CHAIN CASE: ${task.slug} ===\n`);

    const { sketchBuffer, meta } = await readSessionFixture(task.sessionId);
    const caseDir = path.join(publicRoot, task.slug);
    await mkdir(caseDir, { recursive: true });

    const previewPrompt = buildPreviewImagePrompt(task.transcriptText);
    const previewStartedAt = Date.now();
    const generatedPreview = await generateImageFromSketch({
      prompt: previewPrompt,
      sketchImage: sketchBuffer,
      apiKey: getOpenAiKey(),
      width: meta.canvasWidth,
      height: meta.canvasHeight,
      source: "labeled",
      imageSizePreset: "large",
      profile: "pro"
    });
    const previewGenerationMs = Date.now() - previewStartedAt;

    const generatedPreviewPath = path.join(caseDir, "generated-preview.png");
    const labeledSketchPath = path.join(caseDir, "labeled-sketch.png");
    await Promise.all([writeFile(generatedPreviewPath, generatedPreview.buffer), writeFile(labeledSketchPath, sketchBuffer)]);

    const assetPlanResult = await runJsonScriptWithRetry<AssetPlanOutput>(
      path.join("scripts", "run-preview-asset-plan-experiment.ts"),
      [
        "--title",
        task.title,
        "--slug",
        task.slug,
        "--transcript",
        task.transcriptText,
        "--preview",
        generatedPreviewPath
      ],
      "ASSET_PLAN_EXPERIMENT_START",
      "ASSET_PLAN_EXPERIMENT_END",
      `${task.slug} asset-plan`
    );

    const previewToCodeResult = await runJsonScriptWithRetry<PreviewToCodeOutput>(
      path.join("scripts", "run-preview-to-code-experiment.ts"),
      [
        "--title",
        task.title,
        "--slug",
        task.slug,
        "--transcript",
        task.transcriptText,
        "--preview",
        generatedPreviewPath,
        "--asset-plan-dir",
        assetPlanResult.payload.experimentDir
      ],
      "PREVIEW_TO_CODE_EXPERIMENT_START",
      "PREVIEW_TO_CODE_EXPERIMENT_END",
      `${task.slug} preview-to-code`
    );

    results.push({
      slug: task.slug,
      title: task.title,
      transcriptText: task.transcriptText,
      generatedPreviewPath,
      previewGenerationMs,
      assetPlan: assetPlanResult.payload,
      previewToCode: previewToCodeResult.payload,
      wallMs: Date.now() - caseStartedAt
    });

    await persistSummary({
      benchmarkId,
      selectedSlugs: SELECTED_SLUGS,
      totalMs: Date.now() - benchmarkStartedAt,
      results,
      jsonPath,
      publicRoot
    });
  }

  const totalMs = Date.now() - benchmarkStartedAt;
  await persistSummary({
    benchmarkId,
    selectedSlugs: SELECTED_SLUGS,
    totalMs,
    results,
    jsonPath,
    publicRoot
  });

  process.stdout.write("SKETCH_PREVIEW_DRIVEN_SAMPLE_START\n");
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmarkId,
        jsonPath,
        reportUrl: `http://localhost:3000/website-experiments/${benchmarkId}/index.html`,
        totalMs
      },
      null,
      2
    )}\n`
  );
  process.stdout.write("SKETCH_PREVIEW_DRIVEN_SAMPLE_END\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
