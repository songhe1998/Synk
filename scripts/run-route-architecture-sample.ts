import fs from "fs";
import path from "path";
import http from "http";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { chromium } from "@playwright/test";

type CaseSpec = {
  slug: string;
  title: string;
  sessionId: string;
  expectation: "single-page-natural" | "routed-natural";
};

const CASES: CaseSpec[] = [
  {
    slug: "historian-journal-homepage",
    title: "Historian Journal Homepage",
    sessionId: "19f97b64-4e9d-44a5-96c5-7f5459b49532",
    expectation: "routed-natural"
  },
  {
    slug: "climate-relief-campaign-page",
    title: "Climate Relief Campaign Page",
    sessionId: "1c29ab81-7c35-45ed-ae94-f2007efe7db1",
    expectation: "single-page-natural"
  },
  {
    slug: "privacy-security-settings",
    title: "Privacy & Security Settings",
    sessionId: "47da58a3-21e2-45a3-9680-29a732d0822f",
    expectation: "routed-natural"
  }
];

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

function getPreviewRoot(sessionId: string, jobId: string) {
  return path.join(process.cwd(), "data", "sessions", sessionId, "website-artifacts", jobId, "preview");
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
      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : ext === ".js"
              ? "text/javascript; charset=utf-8"
              : ext === ".svg"
                ? "image/svg+xml"
                : ext === ".png"
                  ? "image/png"
                  : ext === ".jpg" || ext === ".jpeg"
                    ? "image/jpeg"
                    : "application/octet-stream";
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
    throw new Error("Unable to start preview server.");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function capturePreviewScreenshot(rootDir: string, outputPath: string) {
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

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const pipeline = await import("../lib/website-pipeline");
  const websiteStore = await import("../lib/website-store");

  const runId = `route-architecture-sample-${new Date().toISOString().slice(0, 10)}`;
  const publicRoot = path.join(process.cwd(), "public", "website-experiments", runId);
  await rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(publicRoot, { recursive: true });

  const results: Array<{
    slug: string;
    title: string;
    sessionId: string;
    expectation: string;
    jobId: string;
    status: string;
    createdAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    previewUrl: string | null;
    screenshotFile: string;
  }> = [];

  for (const testCase of CASES) {
    const job = await pipeline.startWebsiteGenerationJob({
      sessionId: testCase.sessionId
    });

    let current = await websiteStore.getWebsiteJob(testCase.sessionId, job.id);
    while (current && current.status !== "succeeded" && current.status !== "failed") {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      current = await websiteStore.getWebsiteJob(testCase.sessionId, job.id);
    }

    if (!current) {
      throw new Error(`Missing job after run for ${testCase.slug}.`);
    }

    let screenshotFile = "";
    if (current.status === "succeeded") {
      const previewRoot = getPreviewRoot(testCase.sessionId, current.id);
      screenshotFile = `${testCase.slug}.png`;
      await capturePreviewScreenshot(previewRoot, path.join(publicRoot, screenshotFile));
    }

    const createdAtMs = current.createdAt ? Date.parse(current.createdAt) : NaN;
    const completedAtMs = current.completedAt ? Date.parse(current.completedAt) : NaN;
    results.push({
      slug: testCase.slug,
      title: testCase.title,
      sessionId: testCase.sessionId,
      expectation: testCase.expectation,
      jobId: current.id,
      status: current.status,
      createdAt: current.createdAt,
      completedAt: current.completedAt,
      durationMs:
        Number.isFinite(createdAtMs) && Number.isFinite(completedAtMs) ? completedAtMs - createdAtMs : null,
      previewUrl: current.previewUrl,
      screenshotFile
    });
  }

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Route Architecture Sample</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", Arial, sans-serif;
        background: #f5efe4;
        color: #201a15;
      }
      main {
        width: min(1500px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 48px;
      }
      h1 { margin: 0 0 12px; font: 700 clamp(2rem, 4vw, 3.5rem)/0.95 Georgia, serif; }
      .grid { display: grid; gap: 18px; }
      .card {
        background: #fff9f1;
        border: 1px solid rgba(32, 26, 21, 0.1);
        border-radius: 18px;
        padding: 16px;
        box-shadow: 0 18px 40px rgba(52, 38, 24, 0.06);
      }
      img {
        width: 100%;
        height: auto;
        display: block;
        border-radius: 12px;
        border: 1px solid rgba(32, 26, 21, 0.08);
        background: white;
      }
      .meta { color: #6c6155; font-size: 14px; margin-bottom: 12px; }
      .pill {
        display: inline-flex;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(32, 26, 21, 0.12);
        background: #f6efe4;
        margin-right: 8px;
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 700;
      }
      a { color: #201a15; }
    </style>
  </head>
  <body>
    <main>
      <h1>Route Architecture Sample</h1>
      <div class="grid">
        ${results
          .map(
            (result) => `
            <article class="card">
              <h2>${result.title}</h2>
              <div class="meta">
                <span class="pill">expected: ${result.expectation}</span>
                <span class="pill">status: ${result.status}</span>
                <span class="pill">duration: ${
                  result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : "n/a"
                }</span>
                <span class="pill">job: ${result.jobId}</span>
              </div>
              ${
                result.previewUrl
                  ? `<p><a href="${result.previewUrl}" target="_blank" rel="noreferrer">Open localhost preview route</a></p>`
                  : ""
              }
              ${
                result.screenshotFile
                  ? `<img src="./${result.screenshotFile}" alt="${result.title} screenshot" />`
                  : `<p>No screenshot available.</p>`
              }
            </article>
          `
          )
          .join("")}
      </div>
    </main>
  </body>
</html>`;

  await writeFile(path.join(publicRoot, "index.html"), html, "utf8");
  await writeFile(path.join(publicRoot, "results.json"), JSON.stringify(results, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        reportUrl: `http://localhost:3000/website-experiments/${runId}/index.html`,
        results
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
