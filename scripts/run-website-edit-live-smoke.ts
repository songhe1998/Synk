import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readFileSync, rm } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildWebsiteEditPrompt } from "../lib/website-edit-targeting";
import { runWebsiteRevisionSandboxJob } from "../lib/website-sandbox";
import type { WebsiteEditTargetResolution, WebsiteJob } from "../lib/types";

const execFileAsync = promisify(execFile);
const mkdtempAsync = promisify(mkdtemp);
const readFileAsync = promisify(readFile);
const rmAsync = promisify(rm);

function loadEnvFile(filePath: string) {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const idx = line.indexOf("=");
      if (idx < 0) {
        continue;
      }

      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = process.env[key] ?? value;
    }
  } catch {
    // The live smoke can run in environments that already inject env vars.
  }
}

function makeParentJob(): WebsiteJob {
  const now = new Date().toISOString();
  return {
    id: "live-parent-template",
    sessionId: "live-edit-benchmark",
    parentJobId: null,
    revisionNumber: 1,
    jobKind: "initial",
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    displayName: "Website Edit Live Benchmark Parent",
    framework: "vite-react",
    sandboxProvider: "vercel",
    sandboxId: null,
    transcriptText: "A starter landing page with a large hero headline.",
    pages: [],
    prompt: "Starter website fixture.",
    editInstructionText: null,
    editTarget: null,
    statusDetail: null,
    errorMessage: null,
    previewImageUrl: null,
    codeArchiveUrl: null,
    distArchiveUrl: null,
    previewUrl: null,
    previewImageFileName: null,
    previewImageMimeType: null,
    codeArchiveFileName: "parent.tar.gz",
    codeArchiveMimeType: "application/gzip",
    distArchiveFileName: "parent-dist.tar.gz",
    distArchiveMimeType: "application/gzip"
  };
}

function makeTargetResolution(): WebsiteEditTargetResolution {
  return {
    targetElementId: "hero-title",
    targetSelector: ".starter-hero h1",
    targetDescription: "h1 \"Replace this with a sketch-faithful website, not a generic starter card.\"",
    confidence: 0.94,
    reason: "Live smoke feeds a pre-resolved hero headline target.",
    candidates: [
      {
        id: "hero-title",
        selector: ".starter-hero h1",
        tagName: "h1",
        role: null,
        text: "Replace this with a sketch-faithful website, not a generic starter card.",
        rect: { x: 100, y: 160, width: 520, height: 180 },
        score: 1.2,
        reason: "preselected live smoke target"
      }
    ]
  };
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  const tempDir = await mkdtempAsync(path.join(tmpdir(), "synk-website-edit-"));
  const archivePath = path.join(tempDir, "parent-code.tar.gz");
  const expectedText = "Edited Headline Benchmark";

  try {
    await execFileAsync("tar", [
      "-czf",
      archivePath,
      "-C",
      path.join(process.cwd(), "templates", "website-vite-react"),
      "."
    ]);

    const parentJob = makeParentJob();
    const targetResolution = makeTargetResolution();
    const instructionText = `uh this headline should say ${expectedText}`;
    const editJob: WebsiteJob = {
      ...parentJob,
      id: `live-edit-${randomUUID()}`,
      parentJobId: parentJob.id,
      revisionNumber: 2,
      jobKind: "edit",
      status: "queued",
      completedAt: null,
      displayName: "Website Edit Live Benchmark v2",
      prompt: buildWebsiteEditPrompt({ parentJob, instructionText, targetResolution }),
      editInstructionText: instructionText,
      editTarget: targetResolution,
      codeArchiveFileName: null,
      distArchiveFileName: null
    };

    const result = await runWebsiteRevisionSandboxJob({
      job: editJob,
      parentCodeArchive: await readFileAsync(archivePath),
      editRequest: {
        instructionText,
        targetResolution,
        parentJobId: parentJob.id,
        parentDisplayName: parentJob.displayName
      },
      onProgress(update) {
        process.stdout.write(`[live-edit] ${update.status}: ${update.statusDetail}\n`);
      }
    });

    const previewText = result.previewFiles
      .filter((file) => /\.(html|js|css)$/.test(file.assetPath))
      .map((file) => file.buffer.toString("utf8"))
      .join("\n");
    const containsBenchmarkText = previewText.includes(expectedText);
    console.log(
      JSON.stringify(
        {
          sandboxId: result.sandboxId,
          previewFiles: result.previewFiles.map((file) => file.assetPath),
          containsBenchmarkText
        },
        null,
        2
      )
    );

    if (!containsBenchmarkText) {
      throw new Error("Live edit smoke did not find the edited headline in preview output.");
    }
  } finally {
    await rmAsync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
