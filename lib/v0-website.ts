import { WebsiteEditTargetResolution, WebsiteJob } from "@/lib/types";
import { getV0ApiKey, getV0ApiKeySetupError, hasV0ApiKeyConfig } from "@/lib/v0-config";
import { compactWebsiteEditTargetResolutionForPrompt } from "@/lib/website-edit-targeting";

const V0_API_BASE = "https://api.v0.dev/v1";

export interface V0WebsiteSourceFile {
  relativePath: string;
  buffer: Buffer;
}

export interface V0WebsiteState {
  chatId: string;
  versionId: string | null;
  webUrl: string | null;
  apiUrl: string | null;
  modelConfiguration: Record<string, unknown> | null;
  timings: Record<string, number>;
  fileCount?: number;
  decodedAssetPaths?: string[];
}

interface V0RequestPayload {
  __timingMs?: number;
  id?: string;
  webUrl?: string;
  url?: string;
  apiUrl?: string;
  latestVersion?: {
    id?: string;
    status?: string;
  };
  modelConfiguration?: Record<string, unknown>;
  files?: Array<{
    name?: string;
    path?: string;
    content?: string;
  }>;
}

export function hasV0WebsiteConfig() {
  return hasV0ApiKeyConfig();
}

export function requireV0WebsiteConfig() {
  const setupError = getV0ApiKeySetupError();
  if (setupError) {
    throw new Error(setupError);
  }
}

export function getV0WebsiteModelConfiguration() {
  const modelId = process.env.V0_WEBSITE_MODEL_ID?.trim() || "v0-max";
  const imageGenerations = process.env.V0_WEBSITE_IMAGE_GENERATIONS !== "false";
  const thinking = process.env.V0_WEBSITE_THINKING === "1";
  return {
    modelId,
    imageGenerations,
    thinking
  };
}

async function requestV0(endpoint: string, init: RequestInit, label: string) {
  requireV0WebsiteConfig();
  const startedAt = Date.now();
  const response = await fetch(`${V0_API_BASE}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getV0ApiKey()}`,
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let payload: V0RequestPayload;
  try {
    payload = text ? (JSON.parse(text) as V0RequestPayload) : {};
  } catch {
    payload = { raw: text } as V0RequestPayload;
  }

  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 1200)}`);
  }

  payload.__timingMs = Date.now() - startedAt;
  return payload;
}

function dataUrlForBuffer(buffer: Buffer, mimeType: string) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function fileToV0Attachment(buffer: Buffer, name: string, contentType: string, type: "screenshot" | "zip" = "screenshot") {
  return {
    url: dataUrlForBuffer(buffer, contentType),
    name,
    contentType,
    type,
    size: buffer.length
  };
}

function safeRelativePath(value: string) {
  return value
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function v0FileContentToBuffer(content: string | undefined) {
  if (!content) {
    return Buffer.from("");
  }
  const dataUrlMatch = content.match(/^data:[^;]+;base64,(.*)$/s);
  if (dataUrlMatch) {
    return Buffer.from(dataUrlMatch[1], "base64");
  }
  return Buffer.from(content, "utf8");
}

function extractV0State(payload: V0RequestPayload, timingKey: string): V0WebsiteState {
  return {
    chatId: payload.id || "",
    versionId: payload.latestVersion?.id || null,
    webUrl: payload.webUrl || payload.url || null,
    apiUrl: payload.apiUrl || null,
    modelConfiguration: payload.modelConfiguration || null,
    timings: {
      [timingKey]: payload.__timingMs ?? 0
    }
  };
}

export function readV0WebsiteState(job: WebsiteJob) {
  const raw = job.providerMetadata?.v0;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const state = raw as Partial<V0WebsiteState>;
  if (typeof state.chatId !== "string" || !state.chatId) {
    return null;
  }

  return {
    chatId: state.chatId,
    versionId: typeof state.versionId === "string" ? state.versionId : null,
    webUrl: typeof state.webUrl === "string" ? state.webUrl : null,
    apiUrl: typeof state.apiUrl === "string" ? state.apiUrl : null,
    modelConfiguration:
      state.modelConfiguration && typeof state.modelConfiguration === "object"
        ? (state.modelConfiguration as Record<string, unknown>)
        : null,
    timings: state.timings && typeof state.timings === "object" ? (state.timings as Record<string, number>) : {},
    ...(typeof state.fileCount === "number" ? { fileCount: state.fileCount } : {}),
    ...(Array.isArray(state.decodedAssetPaths) ? { decodedAssetPaths: state.decodedAssetPaths } : {})
  } satisfies V0WebsiteState;
}

export function writeV0WebsiteStateMetadata(
  metadata: WebsiteJob["providerMetadata"],
  state: V0WebsiteState
): WebsiteJob["providerMetadata"] {
  return {
    ...(metadata ?? {}),
    v0: state
  };
}

export function buildV0WebsiteGenerationPrompt(transcriptText: string) {
  return [
    "Recreate the attached target-preview.png as a real responsive website, as close to 1:1 as practical.",
    "Use the transcript only as semantic context for labels, content, product/domain meaning, and missing details; the preview image is the source of truth for layout, visual hierarchy, and first-viewport composition.",
    "If the preview contains photography, illustrations, maps, product imagery, portraits, or other imagery regions, use image generation/assets so those regions render as real visual assets rather than empty placeholders.",
    "Build the actual website experience, not an explanation of the image. Keep it polished, responsive, and free of meta text about the prompt.",
    "",
    "Transcript:",
    '"""',
    transcriptText.trim(),
    '"""'
  ].join("\n");
}

export function buildV0WebsiteEditPrompt(params: {
  instructionText: string;
  targetResolution: WebsiteEditTargetResolution | null;
}) {
  const compactResolution = params.targetResolution
    ? compactWebsiteEditTargetResolutionForPrompt(params.targetResolution)
    : null;

  return [
    "Apply the user's website edit to the current project.",
    "The attached screenshot is the current rendered website with unlabeled red freehand annotations. The user's language may use deictic references such as this, that, this one, or that area.",
    "Use the screenshot and the internal target-resolution context together. The context is produced by our app from annotation geometry, transcript timing, and visible DOM candidates; treat it as guidance for which DOM elements the deictic phrases refer to.",
    "Do not require numeric circle labels. Do not broadly redesign unrelated regions unless the edit request explicitly asks for a global change.",
    "",
    "User edit request:",
    '"""',
    params.instructionText.trim(),
    '"""',
    "",
    "Internal target-resolution context:",
    "```json",
    JSON.stringify(compactResolution, null, 2),
    "```"
  ].join("\n");
}

export async function createV0WebsiteChat(params: {
  message: string;
  targetPreviewImage: Buffer;
  metadata: Record<string, string>;
}) {
  const payload = await requestV0(
    "/chats",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chatPrivacy: "private",
        responseMode: "sync",
        message: params.message,
        attachments: [fileToV0Attachment(params.targetPreviewImage, "target-preview.png", "image/png", "screenshot")],
        modelConfiguration: getV0WebsiteModelConfiguration(),
        metadata: params.metadata
      })
    },
    "v0 website generation"
  );

  return extractV0State(payload, "createChatMs");
}

export async function sendV0WebsiteEditMessage(params: {
  chatId: string;
  message: string;
  annotatedScreenshot: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  } | null;
  metadata: Record<string, string>;
}) {
  const payload = await requestV0(
    `/chats/${params.chatId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        responseMode: "sync",
        message: params.message,
        attachments: params.annotatedScreenshot
          ? [
              fileToV0Attachment(
                params.annotatedScreenshot.buffer,
                params.annotatedScreenshot.fileName,
                params.annotatedScreenshot.mimeType,
                "screenshot"
              )
            ]
          : [],
        modelConfiguration: getV0WebsiteModelConfiguration(),
        metadata: params.metadata
      })
    },
    "v0 website edit"
  );

  const state = extractV0State(payload, "sendMessageMs");
  return {
    ...state,
    chatId: state.chatId || params.chatId
  };
}

export async function getV0WebsiteVersionSourceFiles(chatId: string, versionId: string) {
  const payload = await requestV0(
    `/chats/${chatId}/versions/${versionId}?includeDefaultFiles=true`,
    {
      method: "GET"
    },
    "v0 get chat version"
  );
  const decodedAssetPaths: string[] = [];
  const sourceFiles: V0WebsiteSourceFile[] = [];

  for (const file of payload.files ?? []) {
    const relativePath = safeRelativePath(file.name || file.path || "");
    if (!relativePath) {
      continue;
    }
    if (typeof file.content === "string" && file.content.startsWith("data:")) {
      decodedAssetPaths.push(relativePath);
    }
    sourceFiles.push({
      relativePath,
      buffer: v0FileContentToBuffer(file.content)
    });
  }

  return {
    sourceFiles,
    fileCount: sourceFiles.length,
    decodedAssetPaths,
    timings: {
      getVersionMs: payload.__timingMs ?? 0
    }
  };
}
