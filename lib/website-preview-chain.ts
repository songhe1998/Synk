import fs from "fs";
import path from "path";
import sharp from "sharp";
import { generateImageFromSketch } from "@/lib/scene-analysis";
import {
  type WebsiteAssetPlan,
  type WebsiteImageryComponent
} from "@/lib/website-asset-plan";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const IMAGE_ORCHESTRATOR_MODEL = process.env.OPENAI_IMAGE_ORCHESTRATOR_MODEL ?? "gpt-5.4";
const IMAGE_TOOL_MODEL = process.env.OPENAI_IMAGE_TOOL_MODEL ?? "gpt-image-2";

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

async function callResponsesApi(payload: object, apiKey: string) {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
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
        const error = new Error(`OpenAI Responses API failed: ${response.status} ${errorText}`);
        const lower = error.message.toLowerCase();
        const retryable =
          response.status === 429 ||
          response.status >= 500 ||
          lower.includes("connection termination") ||
          lower.includes("upstream connect error") ||
          lower.includes("reset");
        if (!retryable || attempt === 3) {
          throw error;
        }
        lastError = error;
      } else {
        return response.json();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const retryable =
        message.includes("econnreset") ||
        message.includes("fetch failed") ||
        message.includes("connection termination") ||
        message.includes("upstream connect error") ||
        message.includes("network");
      if (!retryable || attempt === 3) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }

  throw lastError ?? new Error("OpenAI Responses API failed without a response.");
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
  scaffoldFamily?: "editorial" | "product" | "marketing";
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
    "Read DESIGN.md first. It contains the design system, shell style, section blueprint, and primitive guidance for this run.",
    "Recreate the target preview closely in code. This is a fidelity task, not an inspiration task.",
    "Start from the prepared scaffold and edit it toward fidelity rather than rebuilding the project from zero.",
    "Reuse and adapt components from src/ui/primitives.tsx before inventing new structural patterns.",
    "Keep the implementation compact and focused. Do not create planning docs, scratch files, or long notes in the workspace.",
    "Only change files that are necessary for the final site. Prefer src/App.tsx and src/styles.css unless real routes are clearly required.",
    "All visible copy must read like end-user-facing website content.",
    "Never show meta language about the request, prompt, preview, wireframe, placeholders, fidelity, or implementation choices.",
    "Follow the route strategy and section blueprint from DESIGN.md unless the preview clearly forces a different structure.",
    params.scaffoldFamily
      ? `A ${params.scaffoldFamily} scaffold has already been prepared in the workspace. Keep its shell and primitives unless the preview clearly requires a different structure.`
      : "A scaffold is already prepared in the workspace. Keep its shell and primitives unless the preview clearly requires a different structure.",
    "Every visible navigation item, CTA, teaser card, and footer link should do something meaningful in the built site.",
    "Dead links, href=\"#\", and buttons with no effect are not acceptable.",
    "If a primitive in src/ui/primitives.tsx already matches the needed shell, panel, badge, nav, metric, or toolbar behavior, use it and adjust it instead of rebuilding that pattern from raw divs.",
    "Do not add or change npm dependencies unless they are absolutely necessary. Prefer pure React and CSS with the packages already installed in the workspace.",
    params.scaffoldFamily === "product"
      ? "For product UI, prefer a compact static interface over a simulated app platform. Do not invent extra tabs, view modes, pseudo-pages, or large mock data systems unless the preview explicitly shows them."
      : "Keep the implementation focused. Only add complexity that is clearly visible in the preview.",
    "Keep file edits tightly scoped and avoid unnecessary new files.",
    params.scaffoldFamily === "product"
      ? "Avoid large navigation registries, icon registries, and many state hooks. Use at most one or two tiny local interactions when they are obvious in the preview."
      : "Use local interactions sparingly and only when they strengthen fidelity.",
    params.scaffoldFamily === "product"
      ? "Keep the implementation compact: one main page component, one stylesheet, small data arrays, and no sprawling pseudo-application architecture."
      : "Keep the implementation compact and let the visual composition do the work.",
    "Use CSS and layout code to match the page shell, typography, spacing, borders, paper tone, rounded panels, dividers, icons, and CTA treatment.",
    "Use the supplied generated imagery components directly in the final site for the hero image and image-like content slots instead of trying to redraw those image regions in CSS or SVG.",
    "Do not paste the target preview image as one giant screenshot or background.",
    "Do not fetch external images.",
    assetDeliveryMode === "project-placeholder"
      ? "Do not generate additional image assets yourself in this coding pass. The imagery asset slots already exist in the project and must be used directly."
      : "Do not create substitute imagery in CSS or SVG when a supplied generated image already covers that slot.",
    "Shared imagery style language:",
    params.assetPlan.shared_style_language,
    params.generatedAssets.length ? "Generated imagery components to use:" : "No separate preview-matched imagery components were identified. Implement all visible regions directly in code.",
    ...assetLines,
    "Inputs:",
    "- /vercel/sandbox/input/target-preview.png",
    "- /vercel/sandbox/input/transcript.txt",
    ...(assetDeliveryMode === "input"
      ? params.generatedAssets.map(({ fileName }) => `- /vercel/sandbox/input/${fileName}`)
      : []),
    "Implement the main experience at route / and add additional routes only when the preview and content naturally imply them.",
    "Leave the project ready for `npm run build`."
  ].join("\n");
}

export function hasOpenAiApiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export type { WebsiteAssetPlan, WebsiteImageryComponent } from "@/lib/website-asset-plan";
