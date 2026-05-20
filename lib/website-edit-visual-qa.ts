import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { getWebsitePreviewMimeType, normalizeWebsitePreviewAssetPath } from "@/lib/website-artifacts";
import { compactWebsiteEditTargetResolutionForPrompt } from "@/lib/website-edit-targeting";
import type { WebsiteEditTargetResolution } from "@/lib/types";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const WEBSITE_EDIT_VISUAL_REVIEW_MODEL =
  process.env.OPENAI_WEBSITE_EDIT_VISUAL_REVIEW_MODEL ??
  process.env.OPENAI_WEBSITE_EDIT_INTENT_MODEL ??
  process.env.OPENAI_FAST_SCENE_MODEL ??
  "gpt-5.4-mini";
const RESPONSES_TIMEOUT_MS = Number(process.env.OPENAI_RESPONSES_TIMEOUT_MS ?? 120000);
const WEBSITE_EDIT_VISUAL_QA_THRESHOLD = Number(process.env.WEBSITE_EDIT_VISUAL_QA_THRESHOLD ?? 0.72);

export interface WebsitePreviewFileForScreenshot {
  assetPath: string;
  buffer: Buffer;
  mimeType?: string;
}

export interface WebsiteEditVisualReview {
  available: boolean;
  passes: boolean;
  score: number;
  issues: string[];
  repairInstruction: string;
  model: string | null;
  error: string | null;
}

interface WebsiteEditVisualReviewPayload {
  passes: boolean;
  score: number;
  issues: string[];
  repair_instruction: string;
}

function getOpenAiKey() {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() || "";
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

async function writePreviewFilesToDir(files: WebsitePreviewFileForScreenshot[], rootDir: string) {
  for (const file of files) {
    const normalized = normalizeWebsitePreviewAssetPath(file.assetPath);
    if (!normalized) {
      continue;
    }
    const destination = path.join(rootDir, normalized);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.buffer);
  }
}

function startStaticServer(rootDir: string) {
  const server = createServer(async (request, response) => {
    const requested = normalizeWebsitePreviewAssetPath(request.url?.split("?")[0]);
    const assetPath = requested || "index.html";
    const filePath = path.join(rootDir, assetPath);
    if (!filePath.startsWith(rootDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const { readFile } = await import("node:fs/promises");
      const buffer = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": getWebsitePreviewMimeType(assetPath),
        "Cache-Control": "no-store"
      });
      response.end(buffer);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  return new Promise<{ server: Server; url: string }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/index.html`
      });
    });
  });
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function captureWebsitePreviewScreenshot({
  previewFiles,
  viewportWidth,
  viewportHeight
}: {
  previewFiles: WebsitePreviewFileForScreenshot[];
  viewportWidth: number;
  viewportHeight: number;
}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skratch-website-edit-preview-"));
  let server: Server | null = null;
  try {
    await writePreviewFilesToDir(previewFiles, tempDir);
    const started = await startStaticServer(tempDir);
    server = started.server;
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: {
          width: Math.min(1920, Math.max(360, Math.round(viewportWidth || 1440))),
          height: Math.min(1600, Math.max(360, Math.round(viewportHeight || 1100)))
        },
        deviceScaleFactor: 1
      });
      await page.goto(started.url, { waitUntil: "networkidle" });
      return await page.screenshot({ type: "png", fullPage: false });
    } finally {
      await browser.close();
    }
  } finally {
    if (server) {
      await closeServer(server).catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function toInputImageDataUrl(buffer: Buffer) {
  const prepared = await sharp(buffer)
    .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return `data:image/png;base64,${prepared.toString("base64")}`;
}

async function callResponsesApi(payload: object, apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Responses API timed out after ${RESPONSES_TIMEOUT_MS}ms`)),
    RESPONSES_TIMEOUT_MS
  );
  try {
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Responses API failed: ${response.status} ${errorText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractOutputText(payload: any) {
  const message = payload?.output?.find((item: any) => item.type === "message");
  const textPart = message?.content?.find((part: any) => part.type === "output_text");
  if (typeof textPart?.text !== "string" || !textPart.text.trim()) {
    throw new Error("Responses API returned no text payload.");
  }
  return textPart.text;
}

export function shouldRunWebsiteEditVisualQa() {
  return process.env.WEBSITE_EDIT_VISUAL_QA !== "0" && Boolean(getOpenAiKey());
}

export async function reviewWebsiteEditVisualQuality({
  instructionText,
  targetResolution,
  annotatedBeforeImage,
  afterImage
}: {
  instructionText: string;
  targetResolution: WebsiteEditTargetResolution | null;
  annotatedBeforeImage: Buffer;
  afterImage: Buffer;
}): Promise<WebsiteEditVisualReview> {
  const apiKey = getOpenAiKey();
  if (!apiKey) {
    return {
      available: false,
      passes: true,
      score: 1,
      issues: [],
      repairInstruction: "",
      model: null,
      error: "OPENAI_API_KEY is not configured."
    };
  }

  try {
    const compactTargetPlan = targetResolution
      ? JSON.stringify(compactWebsiteEditTargetResolutionForPrompt(targetResolution), null, 2)
      : "(no structured target plan)";
    const payload = await callResponsesApi(
      {
        model: WEBSITE_EDIT_VISUAL_REVIEW_MODEL,
        reasoning: { effort: "low" },
        store: false,
        instructions: [
          "You are a strict visual QA judge for a targeted website edit.",
          "You receive an annotated before screenshot with red drawn circles, an after screenshot, the user's natural edit request, and the structured target plan.",
          "Judge only whether the circled regions were changed enough to satisfy the user's request. Ignore unrelated page differences unless they damage the result.",
          "Fail if the selected area looks almost unchanged, if the change is merely a tiny spacing tweak for a broad visual complaint, or if the edit misses one of multiple circled targets.",
          "Pass only when a normal user would clearly notice that each requested local edit was addressed.",
          "When failing, write a concrete repair instruction that can be given to a coding agent. It must say what still looks wrong and what visible change is needed."
        ].join("\n"),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  `User edit request:\n${normalizeText(instructionText)}`,
                  `Structured target plan:\n${compactTargetPlan}`,
                  "Reference image 1: annotated before screenshot. The red circles are the user's selected targets."
                ].join("\n\n")
              },
              {
                type: "input_image",
                image_url: await toInputImageDataUrl(annotatedBeforeImage)
              },
              {
                type: "input_text",
                text: "Reference image 2: after screenshot from the edited website."
              },
              {
                type: "input_image",
                image_url: await toInputImageDataUrl(afterImage)
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "website_edit_visual_review",
            strict: true,
            schema: {
              type: "object",
              properties: {
                passes: { type: "boolean" },
                score: { type: "number" },
                issues: {
                  type: "array",
                  items: { type: "string" }
                },
                repair_instruction: { type: "string" }
              },
              required: ["passes", "score", "issues", "repair_instruction"],
              additionalProperties: false
            }
          }
        }
      },
      apiKey
    );

    const parsed = JSON.parse(extractOutputText(payload)) as WebsiteEditVisualReviewPayload;
    const score = clamp01(Number(parsed.score) || 0);
    return {
      available: true,
      passes: Boolean(parsed.passes) && score >= WEBSITE_EDIT_VISUAL_QA_THRESHOLD,
      score,
      issues: parsed.issues.map((issue) => normalizeText(issue)).filter(Boolean),
      repairInstruction: normalizeText(parsed.repair_instruction),
      model: typeof payload?.model === "string" ? payload.model : WEBSITE_EDIT_VISUAL_REVIEW_MODEL,
      error: null
    };
  } catch (error) {
    return {
      available: false,
      passes: true,
      score: 1,
      issues: [],
      repairInstruction: "",
      model: WEBSITE_EDIT_VISUAL_REVIEW_MODEL,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
