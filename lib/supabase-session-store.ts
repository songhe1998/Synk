import { randomUUID } from "crypto";
import {
  AnalysisReasoningEffort,
  AssetKind,
  DrawingEvent,
  ImageGenerationProfile,
  ImageSizePreset,
  SceneAnalysis,
  SessionDetail,
  SessionSummary,
  TranscriptToken,
  VideoSourcePlan
} from "@/lib/types";
import { listVideoJobs } from "@/lib/video-store";
import { listWebsiteJobs } from "@/lib/website-store";
import { listWorldJobs } from "@/lib/world-store";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseStorageBucket } from "@/lib/supabase/config";
import { readSessionBinaryAsset, uploadSessionBinaryAsset } from "@/lib/supabase-asset-store";
import { normalizeSupabaseError } from "@/lib/supabase/errors";

const DEFAULT_ANALYSIS_REASONING_EFFORT: AnalysisReasoningEffort = "medium";
const DEFAULT_IMAGE_SIZE_PRESET: ImageSizePreset = "medium";
const DEFAULT_IMAGE_GENERATION_PROFILE: ImageGenerationProfile = "fast";

interface UploadPayload {
  audioBuffer: Buffer;
  audioMimeType: string;
  audioExtension: string;
  events: DrawingEvent[];
  canvasWidth: number;
  canvasHeight: number;
  durationMs: number;
  sketchBuffer?: Buffer | null;
}

interface SessionRecordRow {
  id: string;
  user_id: string;
  title: string;
  status: SessionSummary["status"];
  created_at: string;
  updated_at: string;
  duration_ms: number;
  audio_mime_type: string | null;
  canvas_width: number;
  canvas_height: number;
  transcript_approximate: boolean;
  analysis_reasoning_effort: AnalysisReasoningEffort | null;
  image_size_preset: ImageSizePreset | null;
  image_generation_profile: ImageGenerationProfile | "quality" | null;
  error_message: string | null;
}

interface SessionPayloadRow {
  session_id: string;
  events: DrawingEvent[] | null;
  transcript: TranscriptToken[] | null;
  analysis: SceneAnalysis | null;
  video_source_plan: VideoSourcePlan | null;
}

interface SessionAssetRow {
  session_id: string;
  kind: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
}

function normalizeSummary(row: SessionRecordRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    durationMs: row.duration_ms,
    audioMimeType: row.audio_mime_type,
    canvasWidth: row.canvas_width,
    canvasHeight: row.canvas_height,
    transcriptApproximate: row.transcript_approximate,
    analysisReasoningEffort:
      row.analysis_reasoning_effort === "low" ||
      row.analysis_reasoning_effort === "medium" ||
      row.analysis_reasoning_effort === "high"
        ? row.analysis_reasoning_effort
        : DEFAULT_ANALYSIS_REASONING_EFFORT,
    imageSizePreset:
      row.image_size_preset === "small" || row.image_size_preset === "medium" || row.image_size_preset === "large"
        ? row.image_size_preset
        : DEFAULT_IMAGE_SIZE_PRESET,
    imageGenerationProfile:
      row.image_generation_profile === "fast"
        ? "fast"
        : row.image_generation_profile === "pro" || row.image_generation_profile === "quality"
          ? "pro"
          : DEFAULT_IMAGE_GENERATION_PROFILE,
    errorMessage: row.error_message
  };
}

function assetUrl(sessionId: string, assetKind: AssetKind) {
  return `/api/sessions/${sessionId}/assets/${assetKind}`;
}

function inferAudioExtension(mimeType: string) {
  if (mimeType.includes("webm")) {
    return "webm";
  }
  if (mimeType.includes("mpeg")) {
    return "mp3";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  return "bin";
}

function getAssetFileName(assetKind: AssetKind) {
  switch (assetKind) {
    case "sketch":
      return "sketch.png";
    case "annotatedSketch":
      return "annotated-sketch.png";
    case "videoAnnotatedSketch":
      return "video-annotated-sketch.png";
    case "generatedImage":
      return "generated-image.png";
    case "generatedImageLabeled":
      return "generated-image-labeled.png";
    case "generatedImagePlain":
      return "generated-image-plain.png";
    case "generatedVideoSourceImage":
      return "generated-video-source-image.png";
  }
}

async function getSessionRow(sessionId: string, userId?: string) {
  const admin = getSupabaseAdminClient();
  let query = admin.from("sessions").select("*").eq("id", sessionId);
  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query.maybeSingle<SessionRecordRow>();
  if (error) {
    throw normalizeSupabaseError(error);
  }

  return data;
}

async function removeStoragePrefix(prefix: string) {
  const admin = getSupabaseAdminClient();
  const bucket = getSupabaseStorageBucket();
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");

  const removeRecursively = async (pathPrefix: string) => {
    const { data, error } = await admin.storage.from(bucket).list(pathPrefix, {
      limit: 1000,
      offset: 0
    });

    if (error) {
      throw normalizeSupabaseError(error);
    }

    const items = data ?? [];
    const filePaths = items.filter((item) => Boolean(item.id)).map((item) => `${pathPrefix}/${item.name}`);
    const folderPaths = items.filter((item) => !item.id).map((item) => `${pathPrefix}/${item.name}`);

    if (filePaths.length > 0) {
      const { error: removeError } = await admin.storage.from(bucket).remove(filePaths);
      if (removeError) {
        throw normalizeSupabaseError(removeError);
      }
    }

    for (const folderPath of folderPaths) {
      await removeRecursively(folderPath);
    }
  };

  await removeRecursively(normalizedPrefix);
}

async function updateSessionRow(sessionId: string, values: Partial<SessionRecordRow>) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("sessions")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .select("*")
    .single<SessionRecordRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeSummary(data);
}

async function getPayloadRow(sessionId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("session_payloads")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle<SessionPayloadRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return data;
}

async function upsertPayloadRow(sessionId: string, values: Partial<SessionPayloadRow>) {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("session_payloads").upsert(
    {
      session_id: sessionId,
      ...values
    },
    {
      onConflict: "session_id"
    }
  );

  if (error) {
    throw normalizeSupabaseError(error);
  }
}

async function listAssetRows(sessionId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("session_assets").select("*").eq("session_id", sessionId);

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return (data ?? []) as SessionAssetRow[];
}

async function getAssetRow(sessionId: string, kind: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("session_assets")
    .select("*")
    .eq("session_id", sessionId)
    .eq("kind", kind)
    .maybeSingle<SessionAssetRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return data;
}

async function getPreferredResultUrl(sessionId: string) {
  const worldJobs = await listWorldJobs(sessionId);
  const videoJobs = await listVideoJobs(sessionId);
  const websiteJobs = await listWebsiteJobs(sessionId);
  const latestJobTarget = [
    worldJobs[0] ? { createdAt: worldJobs[0].createdAt, href: `/sessions/${sessionId}/worlds/${worldJobs[0].id}` } : null,
    videoJobs[0] ? { createdAt: videoJobs[0].createdAt, href: `/sessions/${sessionId}/videos/${videoJobs[0].id}` } : null,
    websiteJobs[0]
      ? { createdAt: websiteJobs[0].createdAt, href: `/sessions/${sessionId}/websites/${websiteJobs[0].id}` }
      : null
  ]
    .filter((value): value is { createdAt: string; href: string } => Boolean(value))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];

  if (latestJobTarget) {
    return latestJobTarget.href;
  }

  const assets = await listAssetRows(sessionId);
  const hasGeneratedImage = assets.some((asset) =>
    ["generatedImage", "generatedImageLabeled", "generatedImagePlain"].includes(asset.kind)
  );
  return hasGeneratedImage ? `/sessions/${sessionId}/image` : `/sessions/${sessionId}`;
}

export async function createSupabaseSession(
  userId: string,
  title?: string,
  options?: {
    analysisReasoningEffort?: AnalysisReasoningEffort;
    imageSizePreset?: ImageSizePreset;
    imageGenerationProfile?: ImageGenerationProfile;
  }
) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("sessions")
    .insert({
      id,
      user_id: userId,
      title: title?.trim() || `Session ${createdAt.replace("T", " ").slice(0, 16)}`,
      status: "created",
      created_at: createdAt,
      updated_at: createdAt,
      duration_ms: 0,
      audio_mime_type: null,
      canvas_width: 0,
      canvas_height: 0,
      transcript_approximate: false,
      analysis_reasoning_effort: options?.analysisReasoningEffort ?? DEFAULT_ANALYSIS_REASONING_EFFORT,
      image_size_preset: options?.imageSizePreset ?? DEFAULT_IMAGE_SIZE_PRESET,
      image_generation_profile: options?.imageGenerationProfile ?? DEFAULT_IMAGE_GENERATION_PROFILE,
      error_message: null
    })
    .select("*")
    .single<SessionRecordRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeSummary(data);
}

export async function listSupabaseRecentSessions(userId: string, limit = 24) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return Promise.all(
    ((data ?? []) as SessionRecordRow[]).map(async (row) => ({
      ...normalizeSummary(row),
      preferredResultUrl: await getPreferredResultUrl(row.id)
    }))
  );
}

export async function deleteSupabaseSession(sessionId: string, userId: string) {
  const current = await getSessionRow(sessionId, userId);
  if (!current) {
    return;
  }

  const storagePrefix = `${current.user_id}/${sessionId}`;
  await removeStoragePrefix(storagePrefix).catch((error) => {
    console.warn(`Failed to remove Supabase storage for session ${sessionId}.`, error);
  });

  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("sessions").delete().eq("id", sessionId).eq("user_id", userId);

  if (error) {
    throw normalizeSupabaseError(error);
  }
}

export async function updateSupabaseSessionPreferences(
  sessionId: string,
  preferences: {
    analysisReasoningEffort?: AnalysisReasoningEffort;
    imageSizePreset?: ImageSizePreset;
    imageGenerationProfile?: ImageGenerationProfile;
  }
) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }

  return updateSessionRow(sessionId, {
    analysis_reasoning_effort: preferences.analysisReasoningEffort ?? current.analysis_reasoning_effort,
    image_size_preset: preferences.imageSizePreset ?? current.image_size_preset,
    image_generation_profile: preferences.imageGenerationProfile ?? current.image_generation_profile
  });
}

export async function saveSupabaseSessionUpload(sessionId: string, payload: UploadPayload) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }
  const userId = current.user_id;
  console.info(`[session-upload] ${sessionId} starting upload pipeline`);

  const audioExtension = payload.audioExtension || inferAudioExtension(payload.audioMimeType);
  try {
    await uploadSessionBinaryAsset({
      userId,
      sessionId,
      kind: "audio",
      fileName: `audio.${audioExtension}`,
      mimeType: payload.audioMimeType,
      buffer: payload.audioBuffer
    });
    console.info(`[session-upload] ${sessionId} audio asset uploaded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload audio asset.";
    throw new Error(`Audio asset upload failed: ${message}`);
  }

  try {
    await upsertPayloadRow(sessionId, {
      events: payload.events
    });
    console.info(`[session-upload] ${sessionId} drawing events saved`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save drawing events.";
    throw new Error(`Session payload write failed: ${message}`);
  }

  try {
    await updateSessionRow(sessionId, {
      status: "uploaded",
      duration_ms: payload.durationMs,
      audio_mime_type: payload.audioMimeType,
      canvas_width: payload.canvasWidth,
      canvas_height: payload.canvasHeight,
      error_message: null
    });
    console.info(`[session-upload] ${sessionId} session marked uploaded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update session metadata.";
    throw new Error(`Session status update failed: ${message}`);
  }

  const sketchBuffer = payload.sketchBuffer;
  if (sketchBuffer) {
    const uploadedSketchBuffer = sketchBuffer!;
    try {
      await uploadSessionBinaryAsset({
        userId,
        sessionId,
        kind: "sketch",
        fileName: getAssetFileName("sketch"),
        mimeType: "image/png",
        buffer: uploadedSketchBuffer
      });
      console.info(`[session-upload] ${sessionId} sketch asset uploaded`);
    } catch (error) {
      let message = "Failed to upload sketch asset.";
      if (error instanceof globalThis.Error) {
        message = (error as Error).message;
      }
      console.warn(
        `Sketch asset upload failed for session ${sessionId}; continuing because the sketch can be regenerated from events.`,
        error
      );
      return updateSessionRow(sessionId, {
        error_message: `Sketch asset upload failed and will be regenerated later: ${message}`
      });
    }
  }

  const refreshed = await getSessionRow(sessionId);
  if (!refreshed) {
    throw new Error("Session not found after upload.");
  }

  console.info(`[session-upload] ${sessionId} upload pipeline finished`);
  return normalizeSummary(refreshed);
}

export async function markSupabaseSessionProcessing(sessionId: string) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }

  return updateSessionRow(sessionId, {
    status: "processing",
    error_message: null
  });
}

export async function saveSupabaseSessionTranscript(sessionId: string, tokens: TranscriptToken[], approximate: boolean) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }

  await upsertPayloadRow(sessionId, {
    transcript: tokens
  });

  return updateSessionRow(sessionId, {
    status: "ready",
    transcript_approximate: approximate,
    error_message: null
  });
}

export async function saveSupabaseSessionAnalysis(sessionId: string, analysis: SceneAnalysis) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }

  await upsertPayloadRow(sessionId, {
    analysis
  });

  return updateSessionRow(sessionId, {
    error_message: null
  });
}

export async function saveSupabaseSessionVideoSourcePlan(sessionId: string, plan: VideoSourcePlan) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }

  await upsertPayloadRow(sessionId, {
    video_source_plan: plan
  });

  return updateSessionRow(sessionId, {
    error_message: null
  });
}

export async function saveSupabaseSessionAsset(sessionId: string, assetKind: AssetKind, buffer: Buffer) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }

  await uploadSessionBinaryAsset({
    userId: current.user_id,
    sessionId,
    kind: assetKind,
    fileName: getAssetFileName(assetKind),
    mimeType: "image/png",
    buffer
  });

  return updateSessionRow(sessionId, {
    error_message: null
  });
}

export async function markSupabaseSessionFailed(sessionId: string, error: string) {
  const current = await getSessionRow(sessionId);
  if (!current) {
    throw new Error("Session not found");
  }

  return updateSessionRow(sessionId, {
    status: "failed",
    error_message: error
  });
}

export async function getSupabaseSessionDetail(sessionId: string, userId?: string): Promise<SessionDetail | null> {
  const row = await getSessionRow(sessionId, userId);
  if (!row) {
    return null;
  }

  const payload = await getPayloadRow(sessionId);
  const assets = await listAssetRows(sessionId);
  const worldJobs = await listWorldJobs(sessionId);
  const videoJobs = await listVideoJobs(sessionId);
  const websiteJobs = await listWebsiteJobs(sessionId);

  const getAssetUrl = (kind: AssetKind) => (assets.some((asset) => asset.kind === kind) ? assetUrl(sessionId, kind) : null);
  const generatedImageUrl = getAssetUrl("generatedImageLabeled") ?? getAssetUrl("generatedImage");

  return {
    ...normalizeSummary(row),
    events: payload?.events ?? [],
    transcript: payload?.transcript ?? [],
    audioUrl: assets.some((asset) => asset.kind === "audio") ? `/api/sessions/${sessionId}/audio` : null,
    sketchUrl: getAssetUrl("sketch"),
    annotatedSketchUrl: getAssetUrl("annotatedSketch"),
    videoAnnotatedSketchUrl: getAssetUrl("videoAnnotatedSketch"),
    generatedImageUrl,
    generatedImageLabeledUrl: getAssetUrl("generatedImageLabeled") ?? generatedImageUrl,
    generatedImagePlainUrl: getAssetUrl("generatedImagePlain"),
    generatedVideoSourceImageUrl: getAssetUrl("generatedVideoSourceImage"),
    analysis: payload?.analysis ?? null,
    worldJobs,
    videoJobs,
    websiteJobs
  };
}

export async function getSupabaseSessionAudio(sessionId: string) {
  const asset = await getAssetRow(sessionId, "audio");
  if (!asset) {
    return null;
  }

  return readSessionBinaryAsset(asset.storage_path, asset.file_name, asset.mime_type);
}

export async function getSupabaseSessionAnalysis(sessionId: string) {
  const payload = await getPayloadRow(sessionId);
  return payload?.analysis ?? null;
}

export async function getSupabaseSessionVideoSourcePlan(sessionId: string) {
  const payload = await getPayloadRow(sessionId);
  return payload?.video_source_plan ?? null;
}

export async function getSupabaseSessionAsset(sessionId: string, assetKind: AssetKind) {
  const asset = await getAssetRow(sessionId, assetKind);
  if (!asset) {
    return null;
  }

  return readSessionBinaryAsset(asset.storage_path, asset.file_name, asset.mime_type ?? "image/png");
}
