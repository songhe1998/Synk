import fs from "fs";
import path from "path";
import http from "http";
import { mkdir, readFile } from "fs/promises";
import { chromium } from "@playwright/test";

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

function getPreviewRoot(sessionId: string, jobId: string) {
  return path.join(
    process.cwd(),
    "data",
    "sessions",
    sessionId,
    "website-artifacts",
    jobId,
    "preview"
  );
}

function getContactSheetCaptionSvg(title: string, width: number, height: number) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#fffaf0"/>
      <text x="16" y="27" font-family="ui-sans-serif, system-ui" font-size="17" font-weight="700" fill="#202124">${title}</text>
    </svg>
  `);
}

async function startPreviewServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end("Missing URL");
        return;
      }

      const parsed = new URL(req.url, "http://127.0.0.1");
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length < 3 || parts[0] !== "preview") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const [, sessionId, jobId, ...assetPathParts] = parts;
      const previewRoot = getPreviewRoot(sessionId, jobId);
      const relativePath = assetPathParts.length ? assetPathParts.join("/") : "index.html";
      const resolvedPath = path.join(previewRoot, relativePath);

      if (!resolvedPath.startsWith(previewRoot)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      if (!fs.existsSync(resolvedPath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const buffer = await readFile(resolvedPath);
      const contentType = CONTENT_TYPES[path.extname(resolvedPath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(buffer);
    } catch (error) {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : "Server error");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind preview server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

function sanitizeTitle(title: string) {
  return title.replace(/[^\w -]+/g, "").trim();
}

async function buildContactSheet(
  sharp: any,
  items: Array<{ title: string; screenshotPath: string }>,
  outputPath: string,
  tileWidth: number,
  tileHeight: number,
  columns: number
) {
  const gutter = 18;
  const captionHeight = 42;
  const rows = Math.ceil(items.length / columns);
  const width = columns * tileWidth + (columns + 1) * gutter;
  const height = rows * (tileHeight + captionHeight) + (rows + 1) * gutter;
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];

  for (const [index, item] of items.entries()) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const left = gutter + column * (tileWidth + gutter);
    const top = gutter + row * (tileHeight + captionHeight + gutter);
    const image = await sharp(item.screenshotPath)
      .resize(tileWidth, tileHeight, { fit: "cover", position: "top" })
      .png()
      .toBuffer();
    composites.push({ input: image, left, top });
    composites.push({
      input: getContactSheetCaptionSvg(item.title, tileWidth, captionHeight),
      left,
      top: top + tileHeight
    });
  }

  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#efe4c7"
    }
  })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

async function main() {
  const resultsPath = process.argv[2];
  if (!resultsPath) {
    throw new Error("Usage: npx tsx scripts/capture-website-benchmark-screenshots.ts <results-path>");
  }

  const resultsFile = JSON.parse(await readFile(resultsPath, "utf8")) as {
    roundId: string;
    results: Array<{
      title: string;
      sessionId: string;
      jobId: string;
      status: string;
      displayName: string;
    }>;
  };
  const sharp = (await import("sharp")).default;
  const capturesDir = path.join(process.cwd(), "data", "website-benchmarks", `${resultsFile.roundId}-captures`);
  await mkdir(capturesDir, { recursive: true });

  const successfulResults = resultsFile.results.filter((result) => result.status === "succeeded");
  const { server, baseUrl } = await startPreviewServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1180 }, deviceScaleFactor: 1.5 });
  const topSheetItems: Array<{ title: string; screenshotPath: string }> = [];
  const fullSheetItems: Array<{ title: string; screenshotPath: string }> = [];

  try {
    for (const result of successfulResults) {
      const slug = sanitizeTitle(result.title).replace(/\s+/g, "-").toLowerCase();
      const topPath = path.join(capturesDir, `${slug}-top.png`);
      const fullPath = path.join(capturesDir, `${slug}-full.png`);
      await page.goto(`${baseUrl}/preview/${result.sessionId}/${result.jobId}/`, {
        waitUntil: "networkidle",
        timeout: 120000
      });
      await page.screenshot({ path: topPath, fullPage: false });
      await page.screenshot({ path: fullPath, fullPage: true });
      topSheetItems.push({ title: result.title, screenshotPath: topPath });
      fullSheetItems.push({ title: result.title, screenshotPath: fullPath });
      process.stdout.write(`captured ${result.title}\n`);
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  const topSheetPath = path.join(capturesDir, "top-contact-sheet.png");
  const fullSheetPath = path.join(capturesDir, "full-contact-sheet.png");
  await buildContactSheet(sharp, topSheetItems, topSheetPath, 320, 220, 2);
  await buildContactSheet(sharp, fullSheetItems, fullSheetPath, 320, 360, 2);

  process.stdout.write(`${topSheetPath}\n`);
  process.stdout.write(`${fullSheetPath}\n`);
}

void main();
