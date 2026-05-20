import fs from "fs";
import path from "path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { spawn } from "child_process";
import sharp from "sharp";

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

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const IMAGE_ORCHESTRATOR_MODEL = process.env.OPENAI_IMAGE_ORCHESTRATOR_MODEL ?? "gpt-5.4";
const IMAGE_TOOL_MODEL = process.env.OPENAI_IMAGE_TOOL_MODEL ?? "gpt-image-2";

interface AssetPlanComponent {
  name: string;
  role: string;
  rationale: string;
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
  code_components: AssetPlanComponent[];
  imagery_components: ImageryComponent[];
}

interface ExperimentInput {
  title: string;
  slug: string;
  transcript: string;
  previewImagePath: string;
}

function getOpenAiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  return apiKey;
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
    title: args.title || "Historical Web Preview Asset Plan",
    slug: args.slug || "historical-web-preview",
    transcript:
      args.transcript ||
      "Create a historian journal homepage with a portrait or archive hero, a historian name title, an abstract or journal intro panel, a recent essays strip, and a lectures or contact note.",
    previewImagePath: args.preview || path.join(process.env.HOME ?? "", "Downloads", "historical_web_preview.png")
  };
}

function getAssetPlanSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["shared_style_language", "code_components", "imagery_components"],
    properties: {
      shared_style_language: {
        type: "string"
      },
      code_components: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "role", "rationale"],
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            rationale: { type: "string" }
          }
        }
      },
      imagery_components: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "role", "rationale", "target_description", "prompt", "aspect_ratio"],
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            rationale: { type: "string" },
            target_description: { type: "string" },
            prompt: { type: "string" },
            aspect_ratio: {
              type: "string",
              enum: ["portrait", "landscape", "square"]
            }
          }
        }
      }
    }
  };
}

function buildCodexPlannerPrompt(transcript: string) {
  return [
    "You are analyzing a full website preview image and a user transcript.",
    "The image is the main visual source of truth. The transcript provides semantic intent.",
    "Your task is NOT to build code. Your task is to produce a structured asset plan for reconstructing the page.",
    "First infer one shared style language across all imagery on the page.",
    "Then separate the page into:",
    "- code_components: layout, typography, navigation, text panels, buttons, dividers, cards, forms, sidebars, footer, ornaments that should be implemented in code",
    "- imagery_components: photos, illustrations, archival thumbnails, maps, posters, or other image-like regions that should be recreated with an image generation tool",
    "Do NOT crop the preview. Look at the whole page and derive consistent prompts for each imagery component in the same shared visual language.",
    "Use the preview literally. If the preview shows a man reading in an archive, describe that. If it shows a sepia crowd scene, an antique map, or a writing-at-desk scene, describe those directly.",
    "Do not reinterpret obvious depicted subjects into abstract symbolism unless the preview itself is abstract.",
    "If a strip or grid contains multiple distinct image thumbnails, treat each distinct thumbnail as its own imagery component, even when those thumbnails live inside reusable code cards.",
    "If the page clearly contains a hero portrait plus several distinct editorial thumbnails, the imagery plan should normally include all of them.",
    "The prompts must make all generated imagery feel like they belong to the same website.",
    "The prompts should mention era, palette, medium, lighting, texture, and mood when relevant.",
    "Do not include text overlays, labels, borders, UI chrome, signatures, or handwritten marks in the imagery prompts unless absolutely necessary.",
    "Keep the number of imagery components reasonable and focused on real image-like regions only.",
    "Prefer 4 to 6 imagery components for editorial pages with one hero image and multiple thumbnail images, unless the preview truly contains fewer image regions.",
    "Use the transcript as semantic support:",
    `"${transcript.trim()}"`,
    "Return JSON only, following the provided schema."
  ].join("\n");
}

async function runCodexAssetPlanner(previewImagePath: string, transcript: string) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "skratch-asset-plan-"));
  const promptPath = path.join(tempDir, "prompt.txt");
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "plan.json");

  await writeFile(promptPath, buildCodexPlannerPrompt(transcript), "utf8");
  await writeFile(schemaPath, JSON.stringify(getAssetPlanSchema(), null, 2), "utf8");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "-s",
    "read-only",
    "-C",
    tempDir,
    "-i",
    previewImagePath,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-"
  ];

  const prompt = await readFile(promptPath, "utf8");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env
      }
    });

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`codex exec failed with code ${code}\n${stdout}\n${stderr}`));
        return;
      }
      resolve();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });

  const result = JSON.parse(await readFile(outputPath, "utf8")) as AssetPlan;
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return result;
}

async function callResponsesApi(payload: object, apiKey: string) {
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Responses API failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function resolveSize(aspectRatio: ImageryComponent["aspect_ratio"]) {
  switch (aspectRatio) {
    case "portrait":
      return "1024x1536";
    case "landscape":
      return "1536x1024";
    default:
      return "1024x1024";
  }
}

async function generateImageFromPrompt(prompt: string, aspectRatio: ImageryComponent["aspect_ratio"], apiKey: string) {
  const payload = await callResponsesApi(
    {
      model: IMAGE_ORCHESTRATOR_MODEL,
      store: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt
            }
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          model: IMAGE_TOOL_MODEL,
          action: "generate",
          size: resolveSize(aspectRatio),
          quality: "medium"
        }
      ],
      tool_choice: {
        type: "image_generation"
      }
    },
    apiKey
  );

  const imageCall = payload?.output?.find((item: any) => item.type === "image_generation_call");
  const result = imageCall?.result;
  if (typeof result !== "string" || !result) {
    throw new Error("Image generation returned no image payload.");
  }

  return Buffer.from(result, "base64");
}

async function buildContactSheet(
  items: Array<{ title: string; imagePath: string }>,
  outputPath: string
) {
  const columns = 2;
  const tileWidth = 700;
  const tileHeight = 460;
  const gap = 28;
  const padding = 32;
  const titleHeight = 54;
  const rows = Math.ceil(items.length / columns);
  const width = padding * 2 + columns * tileWidth + (columns - 1) * gap;
  const height = padding * 2 + rows * (tileHeight + titleHeight) + (rows - 1) * gap;

  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#f5ede0"
    }
  });

  const overlays: sharp.OverlayOptions[] = [];

  for (const [index, item] of items.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = padding + column * (tileWidth + gap);
    const top = padding + row * (tileHeight + titleHeight + gap);

    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${titleHeight}">
        <text x="0" y="34" font-family="Avenir Next, Arial, sans-serif" font-size="20" font-weight="700" fill="#231c16">${escapeHtml(
          item.title
        )}</text>
      </svg>`
    );

    const imageBuffer = await sharp(item.imagePath)
      .resize(tileWidth, tileHeight, {
        fit: "contain",
        background: "#ffffff"
      })
      .png()
      .toBuffer();

    overlays.push({ input: label, left, top });
    overlays.push({ input: imageBuffer, left, top: top + titleHeight });
  }

  await base.composite(overlays).png().toFile(outputPath);
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
  transcript: string;
  assetPlan: AssetPlan;
  generatedAssets: Array<{ component: ImageryComponent; relativeImagePath: string }>;
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
        --muted: #675d50;
        --line: rgba(32, 26, 21, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", Arial, sans-serif;
        color: var(--ink);
        background: linear-gradient(180deg, #fbf5ea 0%, var(--bg) 100%);
      }
      main {
        width: min(1500px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 48px;
      }
      h1 {
        margin: 0 0 10px;
        font: 700 clamp(2rem, 4.6vw, 3.8rem)/0.95 "Iowan Old Style", Georgia, serif;
      }
      p {
        color: var(--muted);
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 18px 40px rgba(52, 38, 24, 0.06);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      .full {
        grid-column: 1 / -1;
      }
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
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: #6b6258;
      }
      pre {
        margin: 0;
        padding: 16px;
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        border-radius: 12px;
        background: #f7efe5;
        border: 1px solid rgba(32, 26, 21, 0.08);
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
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(params.title)}</h1>
      <p>Codex analyzed the full preview image, proposed a shared style language and component plan, then the pipeline generated imagery assets from Codex-written prompts.</p>
      <section class="grid">
        <article class="card">
          <h2>Transcript</h2>
          <pre>${escapeHtml(params.transcript)}</pre>
        </article>
        <article class="card">
          <h2>Shared Style Language</h2>
          <pre>${escapeHtml(params.assetPlan.shared_style_language)}</pre>
        </article>
        <article class="card full">
          <h2>Preview Reference</h2>
          <img src="./preview-reference.png" alt="Preview reference image" />
        </article>
        <article class="card">
          <h2>Code Components</h2>
          <pre>${escapeHtml(JSON.stringify(params.assetPlan.code_components, null, 2))}</pre>
        </article>
        <article class="card">
          <h2>Imagery Components Plan</h2>
          <pre>${escapeHtml(JSON.stringify(params.assetPlan.imagery_components, null, 2))}</pre>
        </article>
        <article class="card full">
          <h2>Generated Imagery Components</h2>
          <div class="assets">
            ${params.generatedAssets
              .map(
                ({ component, relativeImagePath }) => `
                  <div class="asset-card">
                    <h3>${escapeHtml(component.name)}</h3>
                    <p><strong>Role:</strong> ${escapeHtml(component.role)}</p>
                    <p><strong>Target:</strong> ${escapeHtml(component.target_description)}</p>
                    <img src="${relativeImagePath}" alt="${escapeHtml(component.name)}" />
                    <h2 style="margin-top:12px">Prompt</h2>
                    <pre>${escapeHtml(component.prompt)}</pre>
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
  const apiKey = getOpenAiKey();
  const totalStart = Date.now();

  const experimentId = `preview-asset-plan-${slug}-${new Date().toISOString().slice(0, 10)}`;
  const publicRoot = path.join(process.cwd(), "public", "website-experiments", experimentId);
  await rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(publicRoot, { recursive: true });

  const plannerStart = Date.now();
  const assetPlan = await runCodexAssetPlanner(previewImagePath, transcript);
  const plannerMs = Date.now() - plannerStart;
  const generatedAssets: Array<{ component: ImageryComponent; relativeImagePath: string }> = [];
  const imageGenerationStart = Date.now();

  for (const component of assetPlan.imagery_components) {
    process.stdout.write(`Generating imagery for ${component.name}...\n`);
    const buffer = await generateImageFromPrompt(component.prompt, component.aspect_ratio, apiKey);
    const fileName = `${component.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}.png`;
    const imagePath = path.join(publicRoot, fileName);
    await writeFile(imagePath, buffer);
    generatedAssets.push({
      component,
      relativeImagePath: `./${fileName}`
    });
  }
  const imageGenerationMs = Date.now() - imageGenerationStart;

  await fs.promises.copyFile(previewImagePath, path.join(publicRoot, "preview-reference.png"));
  await writeFile(path.join(publicRoot, "asset-plan.json"), JSON.stringify(assetPlan, null, 2), "utf8");
  await writeFile(path.join(publicRoot, "transcript.txt"), transcript, "utf8");
  await writeFile(
    path.join(publicRoot, "report.html"),
    buildReportHtml({
      title,
      transcript,
      assetPlan,
      generatedAssets
    }),
    "utf8"
  );
  await writeFile(
    path.join(publicRoot, "index.html"),
    buildReportHtml({
      title,
      transcript,
      assetPlan,
      generatedAssets
    }),
    "utf8"
  );

  const sheetItems = [
    { title: "Preview Reference", imagePath: path.join(publicRoot, "preview-reference.png") },
    ...generatedAssets.map((item) => ({
      title: item.component.name,
      imagePath: path.join(publicRoot, item.relativeImagePath.replace(/^\.\//, ""))
    }))
  ];
  await buildContactSheet(sheetItems, path.join(publicRoot, "contact-sheet.png"));

  process.stdout.write("ASSET_PLAN_EXPERIMENT_START\n");
  process.stdout.write(
    JSON.stringify(
      {
        experimentId,
        experimentDir: publicRoot,
        reportUrl: `http://localhost:3000/website-experiments/${experimentId}/index.html`,
        contactSheetUrl: `http://localhost:3000/website-experiments/${experimentId}/contact-sheet.png`,
        generatedAssetCount: generatedAssets.length,
        plannerMs,
        imageGenerationMs,
        totalMs: Date.now() - totalStart
      },
      null,
      2
    ) + "\n"
  );
  process.stdout.write("ASSET_PLAN_EXPERIMENT_END\n");
}

void main();
