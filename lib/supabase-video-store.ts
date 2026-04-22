import { randomUUID } from "crypto";
import { VideoJob } from "@/lib/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseStorageBucket } from "@/lib/supabase/config";
import { readSessionBinaryAsset } from "@/lib/supabase-asset-store";
import { normalizeSupabaseError } from "@/lib/supabase/errors";

interface SessionOwnerRow {
  user_id: string;
}

interface VideoJobRow {
  id: string;
  session_id: string;
  status: VideoJob["status"];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  display_name: string;
  model_preset: VideoJob["modelPreset"];
  pipeline_mode: VideoJob["pipelineMode"];
  requested_model: string;
  source_asset_kind: VideoJob["sourceAssetKind"];
  transcript_text: string | null;
  source_image_prompt: string | null;
  source_image_prompt_model: string | null;
  prompt: string;
  prompt_model: string | null;
  duration_seconds: number;
  resolution: VideoJob["resolution"];
  aspect_ratio: VideoJob["aspectRatio"];
  camera_fixed: boolean | null;
  request_id: string | null;
  remote_source_url: string | null;
  remote_video_url: string | null;
  video_file_name: string | null;
  video_mime_type: string | null;
  video_storage_path: string | null;
  error_message: string | null;
  status_detail: string | null;
}

function getSourceImageUrl(sessionId: string, sourceAssetKind: VideoJob["sourceAssetKind"]) {
  return `/api/sessions/${sessionId}/assets/${sourceAssetKind}`;
}

function getVideoAssetUrl(sessionId: string, jobId: string, fileName: string | null) {
  return fileName ? `/api/sessions/${sessionId}/videos/${jobId}/asset` : null;
}

function normalizeVideoJob(row: VideoJobRow): VideoJob {
  const localVideoUrl =
    row.video_storage_path && row.video_file_name ? getVideoAssetUrl(row.session_id, row.id, row.video_file_name) : null;
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    displayName: row.display_name,
    modelPreset: row.model_preset,
    pipelineMode: row.pipeline_mode,
    requestedModel: row.requested_model,
    sourceAssetKind: row.source_asset_kind,
    sourceImageUrl: getSourceImageUrl(row.session_id, row.source_asset_kind),
    transcriptText: row.transcript_text,
    sourceImagePrompt: row.source_image_prompt,
    sourceImagePromptModel: row.source_image_prompt_model,
    prompt: row.prompt,
    promptModel: row.prompt_model,
    durationSeconds: row.duration_seconds,
    resolution: row.resolution,
    aspectRatio: row.aspect_ratio,
    cameraFixed: row.camera_fixed,
    requestId: row.request_id,
    remoteSourceUrl: row.remote_source_url,
    remoteVideoUrl: row.remote_video_url,
    videoFileName: row.video_file_name,
    videoMimeType: row.video_mime_type,
    videoStoragePath: row.video_storage_path,
    videoUrl: localVideoUrl ?? row.remote_video_url,
    errorMessage: row.error_message,
    statusDetail: row.status_detail
  };
}

function toVideoJobRow(sessionId: string, job: VideoJob, existingStoragePath: string | null): VideoJobRow {
  return {
    id: job.id,
    session_id: sessionId,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt,
    display_name: job.displayName,
    model_preset: job.modelPreset,
    pipeline_mode: job.pipelineMode,
    requested_model: job.requestedModel,
    source_asset_kind: job.sourceAssetKind,
    transcript_text: job.transcriptText,
    source_image_prompt: job.sourceImagePrompt,
    source_image_prompt_model: job.sourceImagePromptModel,
    prompt: job.prompt,
    prompt_model: job.promptModel,
    duration_seconds: job.durationSeconds,
    resolution: job.resolution,
    aspect_ratio: job.aspectRatio,
    camera_fixed: job.cameraFixed,
    request_id: job.requestId,
    remote_source_url: job.remoteSourceUrl,
    remote_video_url: job.remoteVideoUrl,
    video_file_name: job.videoFileName,
    video_mime_type: job.videoMimeType,
    video_storage_path: job.videoStoragePath ?? existingStoragePath,
    error_message: job.errorMessage,
    status_detail: job.statusDetail
  };
}

async function getSessionOwner(sessionId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("sessions").select("user_id").eq("id", sessionId).single<SessionOwnerRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return data.user_id;
}

async function getJobRow(sessionId: string, jobId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("video_jobs")
    .select("*")
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .maybeSingle<VideoJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return data;
}

export async function listSupabaseVideoJobs(sessionId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("video_jobs")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false });

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return ((data ?? []) as VideoJobRow[]).map(normalizeVideoJob);
}

export async function getSupabaseVideoJob(sessionId: string, jobId: string) {
  const row = await getJobRow(sessionId, jobId);
  return row ? normalizeVideoJob(row) : null;
}

export async function createSupabaseVideoJob(
  sessionId: string,
  job: Omit<VideoJob, "id" | "sessionId" | "createdAt" | "updatedAt" | "sourceImageUrl" | "videoUrl">
) {
  const now = new Date().toISOString();
  const nextJob: VideoJob = {
    ...job,
    id: randomUUID(),
    sessionId,
    createdAt: now,
    updatedAt: now,
    sourceImageUrl: getSourceImageUrl(sessionId, job.sourceAssetKind),
    videoUrl: null
  };

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("video_jobs")
    .insert(toVideoJobRow(sessionId, nextJob, null))
    .select("*")
    .single<VideoJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeVideoJob(data);
}

export async function updateSupabaseVideoJob(
  sessionId: string,
  jobId: string,
  updater: (job: VideoJob) => VideoJob
) {
  const currentRow = await getJobRow(sessionId, jobId);
  if (!currentRow) {
    throw new Error("Video job not found");
  }

  const current = normalizeVideoJob(currentRow);
  const nextJob: VideoJob = {
    ...updater(current),
    updatedAt: new Date().toISOString()
  };

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("video_jobs")
    .update(toVideoJobRow(sessionId, nextJob, currentRow.video_storage_path))
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .select("*")
    .single<VideoJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeVideoJob(data);
}

export async function saveSupabaseVideoJobAsset(
  sessionId: string,
  jobId: string,
  {
    buffer,
    fileName,
    mimeType
  }: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }
) {
  const admin = getSupabaseAdminClient();
  const ownerId = await getSessionOwner(sessionId);
  const storagePath = `${ownerId}/${sessionId}/videos/${fileName}`;
  const bucket = getSupabaseStorageBucket();

  const { error: uploadError } = await admin.storage.from(bucket).upload(storagePath, buffer, {
    contentType: mimeType,
    upsert: true
  });

  if (uploadError) {
    throw normalizeSupabaseError(uploadError);
  }

  const { data, error } = await admin
    .from("video_jobs")
    .update({
      video_file_name: fileName,
      video_mime_type: mimeType,
      video_storage_path: storagePath,
      updated_at: new Date().toISOString()
    })
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .select("*")
    .single<VideoJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeVideoJob(data);
}

export async function getSupabaseVideoJobAsset(sessionId: string, jobId: string) {
  const row = await getJobRow(sessionId, jobId);
  if (!row?.video_storage_path || !row.video_file_name) {
    return null;
  }

  return readSessionBinaryAsset(row.video_storage_path, row.video_file_name, row.video_mime_type);
}
