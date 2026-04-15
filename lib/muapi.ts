import sharp from "sharp";
import { VideoAspectRatio, VideoModelPreset, VideoResolution } from "@/lib/types";

const MUAPI_API_BASE_URL = process.env.MUAPI_API_BASE_URL ?? "https://api.muapi.ai/api/v1";
const DEFAULT_VIDEO_MODEL_LITE = process.env.MUAPI_VIDEO_MODEL_LITE ?? "seedance-lite-i2v";
const DEFAULT_VIDEO_MODEL_QUALITY =
  process.env.MUAPI_VIDEO_MODEL_QUALITY ?? "seedance-2-vip-omni-reference-fast";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface MuApiPredictionResponse {
  request_id?: string;
  id?: string;
}

interface MuApiPredictionResult {
  request_id?: string;
  id?: string;
  status?: string;
  error?: string;
  outputs?: string[];
  video_url?: string;
  video?: string;
  output?: {
    status?: string;
    error?: string;
    video_url?: string;
    outputs?: string[];
    video?: string;
  } | null;
}

function getMuApiKey() {
  const apiKey = process.env.MUAPI_API_KEY;
  if (!apiKey) {
    throw new Error("MUAPI_API_KEY is not configured.");
  }

  return apiKey;
}

export function assertMuApiConfigured() {
  return getMuApiKey();
}

function headers(apiKey: string, extra?: HeadersInit) {
  return {
    "x-api-key": apiKey,
    ...(extra ?? {})
  };
}

async function parseJsonOrText(response: Response) {
  const rawText = await response.text();
  if (!rawText) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function formatMuApiError(payload: unknown, status: number) {
  if (typeof payload === "string" && payload.trim()) {
    return `MuAPI failed (${status}): ${payload}`;
  }

  const message =
    typeof (payload as { error?: unknown })?.error === "string"
      ? (payload as { error: string }).error
      : typeof (payload as { message?: unknown })?.message === "string"
        ? (payload as { message: string }).message
        : null;

  if (message) {
    return `MuAPI failed (${status}): ${message}`;
  }

  return `MuAPI failed (${status}).`;
}

async function callMuApi(pathname: string, init: RequestInit) {
  const apiKey = getMuApiKey();
  const response = await fetch(`${MUAPI_API_BASE_URL}${pathname}`, {
    ...init,
    cache: "no-store",
    headers: headers(apiKey, init.headers)
  });
  const payload = await parseJsonOrText(response);

  if (!response.ok) {
    throw new Error(formatMuApiError(payload, response.status));
  }

  return payload;
}

function normalizePrompt(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim();
}

function nearestAspectRatio(width: number, height: number): VideoAspectRatio {
  const target = width > 0 && height > 0 ? width / height : 16 / 9;
  const ratios: Array<{ key: VideoAspectRatio; value: number }> = [
    { key: "21:9", value: 21 / 9 },
    { key: "16:9", value: 16 / 9 },
    { key: "4:3", value: 4 / 3 },
    { key: "1:1", value: 1 },
    { key: "3:4", value: 3 / 4 },
    { key: "9:16", value: 9 / 16 }
  ];

  return ratios
    .slice()
    .sort((left, right) => Math.abs(left.value - target) - Math.abs(right.value - target))[0].key;
}

async function fitImageUnderUploadLimit(buffer: Buffer) {
  if (buffer.byteLength <= MAX_UPLOAD_BYTES) {
    return {
      buffer,
      fileName: "video-source.png",
      mimeType: "image/png"
    };
  }

  const attempts = [
    { width: undefined, quality: 95 },
    { width: 2048, quality: 92 },
    { width: 1792, quality: 88 },
    { width: 1536, quality: 84 },
    { width: 1280, quality: 80 }
  ];

  for (const attempt of attempts) {
    const candidate = await sharp(buffer)
      .resize(
        attempt.width
          ? {
              width: attempt.width,
              withoutEnlargement: true
            }
          : undefined
      )
      .webp({ quality: attempt.quality })
      .toBuffer();

    if (candidate.byteLength <= MAX_UPLOAD_BYTES) {
      return {
        buffer: candidate,
        fileName: "video-source.webp",
        mimeType: "image/webp"
      };
    }
  }

  throw new Error("Source image is too large for MuAPI upload even after compression.");
}

export function resolveMuApiVideoModel(preset: VideoModelPreset) {
  return preset === "quality" ? DEFAULT_VIDEO_MODEL_QUALITY : DEFAULT_VIDEO_MODEL_LITE;
}

export function buildMuApiVideoPrompt({
  prompt,
  modelPreset
}: {
  prompt: string;
  modelPreset: VideoModelPreset;
}) {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    throw new Error("Video prompt cannot be empty.");
  }

  if (modelPreset === "quality") {
    return normalized.includes("@image1") ? normalized : `Use @image1 as the primary visual reference. ${normalized}`;
  }

  return normalized;
}

export function inferVideoAspectRatio(width: number, height: number) {
  return nearestAspectRatio(width, height);
}

export async function uploadMuApiImage(buffer: Buffer) {
  const prepared = await fitImageUnderUploadLimit(buffer);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([Uint8Array.from(prepared.buffer)], { type: prepared.mimeType }),
    prepared.fileName
  );

  const payload = (await callMuApi("/upload_file", {
    method: "POST",
    body: formData
  })) as { url?: string };

  if (typeof payload?.url !== "string" || !payload.url.trim()) {
    throw new Error("MuAPI upload returned no file URL.");
  }

  return {
    url: payload.url,
    mimeType: prepared.mimeType,
    fileName: prepared.fileName
  };
}

export async function createMuApiVideoPrediction({
  modelPreset,
  prompt,
  imageUrls,
  durationSeconds,
  resolution,
  aspectRatio,
  cameraFixed
}: {
  modelPreset: VideoModelPreset;
  prompt: string;
  imageUrls: string[];
  durationSeconds: number;
  resolution: VideoResolution;
  aspectRatio: VideoAspectRatio;
  cameraFixed: boolean;
}) {
  if (imageUrls.length === 0) {
    throw new Error("At least one source image is required.");
  }

  const endpoint = resolveMuApiVideoModel(modelPreset);
  const preparedPrompt = buildMuApiVideoPrompt({ prompt, modelPreset });
  const body =
    modelPreset === "quality"
      ? {
          prompt: preparedPrompt,
          images_list: imageUrls,
          duration: durationSeconds,
          aspect_ratio: aspectRatio
        }
      : {
          prompt: preparedPrompt,
          image_url: imageUrls[0],
          duration: durationSeconds,
          resolution,
          camera_fixed: cameraFixed
        };

  const payload = (await callMuApi(`/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  })) as MuApiPredictionResponse;

  const requestId = typeof payload.request_id === "string" ? payload.request_id : payload.id;
  if (!requestId) {
    throw new Error("MuAPI prediction creation returned no request_id.");
  }

  return {
    endpoint,
    requestId
  };
}

export async function getMuApiPredictionResult(requestId: string) {
  return (await callMuApi(`/predictions/${requestId}/result`, {
    method: "GET"
  })) as MuApiPredictionResult;
}

export function getMuApiPredictionStatus(result: MuApiPredictionResult) {
  return result.status ?? result.output?.status ?? "pending";
}

export function getMuApiPredictionError(result: MuApiPredictionResult) {
  return result.error ?? result.output?.error ?? null;
}

export function extractMuApiVideoUrl(result: MuApiPredictionResult) {
  if (typeof result.video_url === "string" && result.video_url.trim()) {
    return result.video_url;
  }

  if (typeof result.video === "string" && result.video.trim()) {
    return result.video;
  }

  if (Array.isArray(result.outputs)) {
    const firstUrl = result.outputs.find((value) => typeof value === "string" && value.trim());
    if (firstUrl) {
      return firstUrl;
    }
  }

  const output = result.output;
  if (!output) {
    return null;
  }

  if (typeof output.video_url === "string" && output.video_url.trim()) {
    return output.video_url;
  }

  if (typeof output.video === "string" && output.video.trim()) {
    return output.video;
  }

  if (Array.isArray(output.outputs)) {
    const firstUrl = output.outputs.find((value) => typeof value === "string" && value.trim());
    if (firstUrl) {
      return firstUrl;
    }
  }

  return null;
}

export async function downloadMuApiAsset(url: string) {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Failed to download MuAPI asset (${response.status}).`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get("content-type") || "video/mp4"
  };
}
