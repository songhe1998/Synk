import fs from "fs";
import path from "path";
import sharp from "sharp";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { generateImageFromSketch } from "@/lib/scene-analysis";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const IMAGE_ORCHESTRATOR_MODEL = process.env.OPENAI_IMAGE_ORCHESTRATOR_MODEL ?? "gpt-5.4";
const IMAGE_TOOL_MODEL = process.env.OPENAI_IMAGE_TOOL_MODEL ?? "gpt-image-2";

export interface WebsiteAssetPlanComponent {
  name: string;
  role: string;
  rationale: string;
}

export interface WebsiteImageryComponent {
  name: string;
  role: string;
  rationale: string;
  target_description: string;
  prompt: string;
  aspect_ratio: "portrait" | "landscape" | "square";
}

export interface WebsiteAssetPlan {
  shared_style_language: string;
  code_components: WebsiteAssetPlanComponent[];
  imagery_components: WebsiteImageryComponent[];
}

export interface WebsiteGeneratedAsset {
  component: WebsiteImageryComponent;
  fileName: string;
  buffer: Buffer;
}

export interface WebsitePlaceholderAsset {
  component: WebsiteImageryComponent;
  fileName: string;
  buffer: Buffer;
}

function getOpenAiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  return apiKey;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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

export function buildWebsitePreviewPrompt(transcriptText: string) {
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

export async function generateWebsitePreviewFromSketch(params: {
  transcriptText: string;
  sketchBuffer: Buffer;
  width: number;
  height: number;
}) {
  const previewPrompt = buildWebsitePreviewPrompt(params.transcriptText);
  const result = await generateImageFromSketch({
    prompt: previewPrompt,
    sketchImage: params.sketchBuffer,
    apiKey: getOpenAiKey(),
    width: params.width,
    height: params.height,
    source: "labeled",
    imageSizePreset: "large",
    profile: "pro"
  });

  return {
    prompt: previewPrompt,
    buffer: result.buffer,
    model: result.model
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

export async function runWebsiteAssetPlanner(params: { previewImagePath: string; transcriptText: string }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "synk-asset-plan-"));
  const promptPath = path.join(tempDir, "prompt.txt");
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "plan.json");

  try {
    await writeFile(promptPath, buildCodexPlannerPrompt(params.transcriptText), "utf8");
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
      params.previewImagePath,
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

    return JSON.parse(await readFile(outputPath, "utf8")) as WebsiteAssetPlan;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
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

function resolveGeneratedImageSize(aspectRatio: WebsiteImageryComponent["aspect_ratio"]) {
  switch (aspectRatio) {
    case "portrait":
      return "1024x1536";
    case "landscape":
      return "1536x1024";
    default:
      return "1024x1024";
  }
}

async function generateImageFromPrompt(prompt: string, aspectRatio: WebsiteImageryComponent["aspect_ratio"], apiKey: string) {
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
          size: resolveGeneratedImageSize(aspectRatio),
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

export async function generateWebsiteImageryAssets(assetPlan: WebsiteAssetPlan) {
  const apiKey = getOpenAiKey();
  return Promise.all(
    assetPlan.imagery_components.map(async (component) => {
      const buffer = await generateImageFromPrompt(component.prompt, component.aspect_ratio, apiKey);
      return {
        component,
        fileName: `${slugify(component.name)}.png`,
        buffer
      } satisfies WebsiteGeneratedAsset;
    })
  );
}

export async function createWebsitePlaceholderAssets(assetPlan: WebsiteAssetPlan) {
  return Promise.all(
    assetPlan.imagery_components.map(async (component) => ({
      component,
      fileName: `${slugify(component.name)}.png`,
      buffer: await createPlaceholderAsset(component)
    }))
  ) satisfies Promise<WebsitePlaceholderAsset[]>;
}

export function buildPreviewDrivenClonePrompt(params: {
  assetPlan: WebsiteAssetPlan;
  generatedAssets: Array<{ component: WebsiteImageryComponent; fileName: string }>;
  transcriptText: string;
  assetDeliveryMode?: "input" | "project-placeholder";
}) {
  const assetDeliveryMode = params.assetDeliveryMode ?? "input";
  const assetLines = params.generatedAssets.map(({ component, fileName }) =>
    assetDeliveryMode === "project-placeholder"
      ? `- src/generated-assets/${fileName} -> ${component.role}. This file already exists in the project as a placeholder. Import and use this exact file path in the implementation. Do not rename it, duplicate it elsewhere, or replace it with CSS/SVG. It will be swapped with the final matched image before the build step.`
      : `- /vercel/sandbox/input/${fileName} -> ${component.role}. Use this exact generated image as the page imagery for that slot.`
  );

  return [
    "Build a real responsive website in this Vite + React + TypeScript workspace.",
    "The primary visual source of truth is /vercel/sandbox/input/target-preview.png.",
    "The user transcript provides semantic intent. There is no sketch for this task.",
    "Recreate the target preview as closely as possible in code.",
    "This is a fidelity task, not an inspiration task.",
    "Build a complete usable website experience, not just a pretty dead-end mock.",
    "All visible copy must read like end-user-facing website content, not an explanation of the design process.",
    "Never write visible text about the request, prompt, preview, wireframe, composition, placeholders, fidelity, layout, implementation choices, or why the page was built a certain way.",
    "Do not let phrases like 'the composition', 'the original request', 'the preview', 'placeholder', 'hero remains', 'landing page instead of', or similar meta commentary appear in the final rendered site.",
    "Choose the most natural information architecture for the preview and transcript.",
    "If the design reads like a narrative landing page or single story surface, section navigation can be correct.",
    "If the design implies distinct destinations such as Essays, Lectures, About, Contact, Pricing, Settings, Dashboard subsections, archives, or detail pages, prefer real routed pages over stretching everything into one unnaturally long homepage.",
    "Every visible navigation item, CTA, teaser card, and footer link should do something meaningful in the built site.",
    "Dead links, href=\"#\", and buttons with no effect are not acceptable.",
    "Use CSS and layout code to match the page shell, typography, spacing, borders, paper tone, rounded panels, dividers, icons, and CTA treatment.",
    "Use the supplied generated imagery components directly in the final site for the hero image and image-like content slots instead of trying to redraw those image regions in CSS or SVG.",
    "Do not paste the target preview image as one giant screenshot or background.",
    "Do not fetch external images.",
    assetDeliveryMode === "project-placeholder"
      ? "Do not generate additional image assets yourself in this coding pass. The imagery asset slots already exist in the project and must be used directly."
      : "Do not create substitute imagery in CSS or SVG when a supplied generated image already covers that slot.",
    "Before major edits, create a short design-plan.md with: fidelity thesis, component list, and any unavoidable deviations. Keep that planning private inside the workspace; none of it may appear in user-visible copy.",
    "Shared imagery style language:",
    params.assetPlan.shared_style_language,
    params.generatedAssets.length ? "Generated imagery components to use:" : "No separate preview-matched imagery components were identified. Implement all visible regions directly in code.",
    ...assetLines,
    "Verbatim user transcript:",
    `"${params.transcriptText}"`,
    "Inputs:",
    "- /vercel/sandbox/input/target-preview.png",
    ...(assetDeliveryMode === "input"
      ? params.generatedAssets.map(({ fileName }) => `- /vercel/sandbox/input/${fileName}`)
      : []),
    "Implement the main experience at route / and add additional routes only when the preview and content naturally imply them.",
    "Leave the project ready for `npm run build`."
  ].join("\n");
}

export async function writeTempPreviewFile(previewBuffer: Buffer, extension = ".png") {
  const tempDir = await mkdtemp(path.join(tmpdir(), "synk-preview-"));
  const filePath = path.join(tempDir, `${randomUUID()}${extension}`);
  await writeFile(filePath, previewBuffer);
  return {
    filePath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export function hasOpenAiApiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}
