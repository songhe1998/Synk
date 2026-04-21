import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { mkdir, readFile, rm, writeFile } from "fs/promises";

interface RoundCTask {
  sessionId: string;
  slug: string;
  title: string;
  transcriptText: string;
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

function loadRoundCTasks() {
  const benchmarkPath = path.join(
    process.cwd(),
    "data",
    "website-benchmarks",
    "website-like-round-c-2026-04-20.json"
  );
  const payload = JSON.parse(fs.readFileSync(benchmarkPath, "utf8")) as { tasks: RoundCTask[] };
  return payload.tasks;
}

function getPreviewPath(slug: string) {
  return path.join(
    process.cwd(),
    "data",
    "website-benchmarks",
    "website-like-round-c-merged-2026-04-20-captures",
    `website-like-${slug}-full.png`
  );
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

function formatMs(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildSummaryHtml(params: {
  title: string;
  results: Array<{
    slug: string;
    title: string;
    assetPlan: AssetPlanOutput;
    previewToCode: PreviewToCodeOutput;
    wallMs: number;
  }>;
}) {
  const rows = params.results
    .map(
      (result) => `
        <tr>
          <td>${result.title}</td>
          <td>${result.slug}</td>
          <td><a href="${result.assetPlan.reportUrl}" target="_blank" rel="noreferrer">asset-plan</a></td>
          <td><a href="${result.previewToCode.reportUrl}" target="_blank" rel="noreferrer">report</a></td>
          <td><a href="${result.previewToCode.siteUrl}" target="_blank" rel="noreferrer">site</a></td>
          <td>${result.assetPlan.generatedAssetCount}</td>
          <td>${result.previewToCode.madScore.toFixed(3)}</td>
          <td>${formatMs(result.assetPlan.plannerMs)}</td>
          <td>${formatMs(result.assetPlan.imageGenerationMs)}</td>
          <td>${formatMs(result.previewToCode.websiteBuildMs)}</td>
          <td>${formatMs(result.previewToCode.screenshotMs)}</td>
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
        width: min(1480px, 100%);
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
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Slug</th>
            <th>Asset Plan</th>
            <th>Report</th>
            <th>Site</th>
            <th>Assets</th>
            <th>MAD</th>
            <th>Planner</th>
            <th>Image Gen</th>
            <th>Web Build</th>
            <th>Screenshot</th>
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

async function main() {
  const tasks = loadRoundCTasks();
  const startedAt = Date.now();
  const results: Array<{
    slug: string;
    title: string;
    assetPlan: AssetPlanOutput;
    previewToCode: PreviewToCodeOutput;
    wallMs: number;
  }> = [];

  for (const task of tasks) {
    const caseStartedAt = Date.now();
    const previewPath = getPreviewPath(task.slug);
    process.stdout.write(`\n=== ROUND C CASE: ${task.slug} ===\n`);

    const assetPlanRun = await runJsonScript<AssetPlanOutput>(
      "scripts/run-preview-asset-plan-experiment.ts",
      [
        "--title",
        `${task.title} Asset Plan`,
        "--slug",
        task.slug,
        "--transcript",
        task.transcriptText,
        "--preview",
        previewPath
      ],
      "ASSET_PLAN_EXPERIMENT_START",
      "ASSET_PLAN_EXPERIMENT_END"
    );

    const previewToCodeRun = await runJsonScript<PreviewToCodeOutput>(
      "scripts/run-preview-to-code-experiment.ts",
      [
        "--title",
        `${task.title} Preview-to-Code`,
        "--slug",
        task.slug,
        "--transcript",
        task.transcriptText,
        "--preview",
        previewPath,
        "--asset-plan-dir",
        assetPlanRun.payload.experimentDir
      ],
      "PREVIEW_TO_CODE_EXPERIMENT_START",
      "PREVIEW_TO_CODE_EXPERIMENT_END"
    );

    results.push({
      slug: task.slug,
      title: task.title,
      assetPlan: assetPlanRun.payload,
      previewToCode: previewToCodeRun.payload,
      wallMs: Date.now() - caseStartedAt
    });
  }

  const benchmarkId = `preview-driven-round-c-${new Date().toISOString().slice(0, 10)}`;
  const jsonPath = path.join(process.cwd(), "data", "website-benchmarks", `${benchmarkId}-results.json`);
  const publicDir = path.join(process.cwd(), "public", "website-experiments", benchmarkId);
  await rm(publicDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(publicDir, { recursive: true });

  const summary = {
    benchmarkId,
    totalMs: Date.now() - startedAt,
    results
  };

  await writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  const html = buildSummaryHtml({
    title: "Preview-Driven Round C Benchmark",
    results
  });
  await writeFile(path.join(publicDir, "index.html"), html, "utf8");

  process.stdout.write("PREVIEW_DRIVEN_ROUND_C_BENCHMARK_START\n");
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmarkId,
        jsonPath,
        reportUrl: `http://localhost:3000/website-experiments/${benchmarkId}/index.html`,
        totalMs: summary.totalMs
      },
      null,
      2
    )}\n`
  );
  process.stdout.write("PREVIEW_DRIVEN_ROUND_C_BENCHMARK_END\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
