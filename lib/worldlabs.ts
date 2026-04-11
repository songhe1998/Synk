import { WorldAssetSnapshot, WorldModelPreset } from "@/lib/types";

const WORLDLABS_API_BASE_URL = process.env.WORLDLABS_API_BASE_URL ?? "https://api.worldlabs.ai/marble/v1";
const DEFAULT_WORLDLABS_DRAFT_MODEL = process.env.WORLDLABS_MODEL_DRAFT ?? "marble-1.0-draft";
const DEFAULT_WORLDLABS_HD_MODEL = process.env.WORLDLABS_MODEL_HD ?? "marble-1.1-plus";

interface WorldLabsPrepareUploadResponse {
  media_asset: {
    media_asset_id: string;
  };
  upload_info: {
    upload_url: string;
    required_headers?: Record<string, string>;
  };
}

export interface WorldLabsOperation {
  operation_id: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  done: boolean;
  error: unknown;
  metadata: unknown;
  response: unknown;
}

function toNullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function toNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function formatWorldLabsError(payload: unknown, status: number) {
  if (typeof payload === "string" && payload.trim()) {
    return `World Labs API failed (${status}): ${payload}`;
  }

  if (Array.isArray((payload as { detail?: unknown })?.detail)) {
    const detail = (payload as { detail: Array<{ msg?: string }> }).detail
      .map((item) => item.msg)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ");

    if (detail) {
      return `World Labs API failed (${status}): ${detail}`;
    }
  }

  const message =
    typeof (payload as { message?: unknown })?.message === "string"
      ? (payload as { message: string }).message
      : typeof (payload as { error?: unknown })?.error === "string"
        ? (payload as { error: string }).error
        : null;

  if (message) {
    return `World Labs API failed (${status}): ${message}`;
  }

  return `World Labs API failed (${status}).`;
}

async function callWorldLabs(pathname: string, init: RequestInit) {
  const apiKey = process.env.WORLDLABS_API_KEY;
  if (!apiKey) {
    throw new Error("WORLDLABS_API_KEY is not configured.");
  }

  const response = await fetch(`${WORLDLABS_API_BASE_URL}${pathname}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.headers ?? {}),
      "WLT-Api-Key": apiKey
    }
  });

  const payload = await parseJsonOrText(response);
  if (!response.ok) {
    throw new Error(formatWorldLabsError(payload, response.status));
  }

  return payload;
}

function sanitizeTag(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function resolveWorldLabsModel(preset: WorldModelPreset) {
  return preset === "hd" ? DEFAULT_WORLDLABS_HD_MODEL : DEFAULT_WORLDLABS_DRAFT_MODEL;
}

export function buildWorldAssetSnapshot(payload: any): WorldAssetSnapshot {
  const splatUrls = payload?.assets?.splats?.spz_urls ?? {};
  const semanticsMetadata = payload?.assets?.splats?.semantics_metadata ?? {};

  return {
    worldId: String(payload?.world_id ?? ""),
    displayName: String(payload?.display_name ?? payload?.world_id ?? "Generated world"),
    model: toNullableString(payload?.model),
    worldMarbleUrl: toNullableString(payload?.world_marble_url),
    caption: toNullableString(payload?.assets?.caption),
    thumbnailUrl: toNullableString(payload?.assets?.thumbnail_url),
    panoUrl: toNullableString(payload?.assets?.imagery?.pano_url),
    colliderMeshUrl: toNullableString(payload?.assets?.mesh?.collider_mesh_url),
    spz100kUrl: toNullableString(splatUrls["100k"]),
    spz500kUrl: toNullableString(splatUrls["500k"]),
    spzFullResUrl: toNullableString(splatUrls.full_res),
    groundPlaneOffset: toNullableNumber(semanticsMetadata.ground_plane_offset),
    metricScaleFactor: toNullableNumber(semanticsMetadata.metric_scale_factor),
    createdAt: toNullableString(payload?.created_at),
    updatedAt: toNullableString(payload?.updated_at)
  };
}

export function extractWorldIdFromOperation(operation: WorldLabsOperation) {
  const responseWorldId = toNullableString((operation.response as { world_id?: unknown } | null)?.world_id);
  if (responseWorldId) {
    return responseWorldId;
  }

  const metadataWorldId = toNullableString((operation.metadata as { world_id?: unknown } | null)?.world_id);
  if (metadataWorldId) {
    return metadataWorldId;
  }

  return null;
}

export function getOperationStatusDetail(operation: WorldLabsOperation) {
  const metadata = operation.metadata as
    | {
        stage?: unknown;
        progress_message?: unknown;
        progress?: unknown;
      }
    | null;

  const stage = toNullableString(metadata?.stage);
  const progressMessage = toNullableString(metadata?.progress_message);
  const progress =
    typeof metadata?.progress === "number" && Number.isFinite(metadata.progress)
      ? `${Math.round(metadata.progress * 100)}%`
      : null;

  return [stage, progressMessage, progress].filter(Boolean).join(" · ") || null;
}

export function formatWorldLabsErrorValue(value: unknown) {
  if (!value) {
    return "World generation failed.";
  }

  if (typeof value === "string") {
    return value;
  }

  const message =
    typeof (value as { message?: unknown })?.message === "string"
      ? (value as { message: string }).message
      : typeof (value as { detail?: unknown })?.detail === "string"
        ? (value as { detail: string }).detail
        : null;

  if (message) {
    return message;
  }

  return "World generation failed.";
}

export async function prepareWorldLabsUpload({
  fileName,
  extension,
  kind,
  metadata
}: {
  fileName: string;
  extension: string;
  kind: "image" | "video";
  metadata?: Record<string, string>;
}) {
  return (await callWorldLabs("/media-assets:prepare_upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      file_name: fileName.slice(0, 64),
      extension,
      kind,
      metadata
    })
  })) as WorldLabsPrepareUploadResponse;
}

export async function uploadWorldLabsAsset({
  uploadUrl,
  requiredHeaders,
  mimeType,
  buffer
}: {
  uploadUrl: string;
  requiredHeaders?: Record<string, string>;
  mimeType: string;
  buffer: Buffer;
}) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      ...(requiredHeaders ?? {})
    },
    body: Uint8Array.from(buffer)
  });

  if (!response.ok) {
    throw new Error(`World Labs upload failed (${response.status}).`);
  }
}

export async function generateWorldLabsWorld({
  mediaAssetId,
  prompt,
  displayName,
  modelPreset,
  tags
}: {
  mediaAssetId: string;
  prompt: string;
  displayName: string;
  modelPreset: WorldModelPreset;
  tags: string[];
}) {
  const model = resolveWorldLabsModel(modelPreset);
  const payload = (await callWorldLabs("/worlds:generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      world_prompt: {
        type: "image",
        image_prompt: {
          source: "media_asset",
          media_asset_id: mediaAssetId
        },
        text_prompt: prompt,
        disable_recaption: true,
        is_pano: false
      },
      display_name: displayName.slice(0, 80),
      model,
      tags: tags.map(sanitizeTag).filter(Boolean).slice(0, 8),
      permission: {
        public: false,
        allow_id_access: false,
        allowed_readers: [],
        allowed_writers: []
      }
    })
  })) as WorldLabsOperation;

  return {
    model,
    operation: payload
  };
}

export async function getWorldLabsOperation(operationId: string) {
  return (await callWorldLabs(`/operations/${operationId}`, {
    method: "GET"
  })) as WorldLabsOperation;
}

export async function getWorldLabsWorld(worldId: string) {
  return await callWorldLabs(`/worlds/${worldId}`, {
    method: "GET"
  });
}
