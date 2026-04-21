import { randomUUID } from "crypto";
import { WorldJob } from "@/lib/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeSupabaseError } from "@/lib/supabase/errors";

interface WorldJobRow {
  id: string;
  session_id: string;
  status: WorldJob["status"];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  display_name: string;
  model_preset: WorldJob["modelPreset"];
  requested_model: string;
  source_asset_kind: WorldJob["sourceAssetKind"];
  prompt: string;
  operation_id: string | null;
  operation_expires_at: string | null;
  world_id: string | null;
  error_message: string | null;
  status_detail: string | null;
  world: WorldJob["world"];
}

function getSourceImageUrl(sessionId: string, sourceAssetKind: WorldJob["sourceAssetKind"]) {
  return `/api/sessions/${sessionId}/assets/${sourceAssetKind}`;
}

function normalizeWorldJob(row: WorldJobRow): WorldJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    displayName: row.display_name,
    modelPreset: row.model_preset,
    requestedModel: row.requested_model,
    sourceAssetKind: row.source_asset_kind,
    sourceImageUrl: getSourceImageUrl(row.session_id, row.source_asset_kind),
    prompt: row.prompt,
    operationId: row.operation_id,
    operationExpiresAt: row.operation_expires_at,
    worldId: row.world_id,
    errorMessage: row.error_message,
    statusDetail: row.status_detail,
    world: row.world
  };
}

function toWorldJobRow(sessionId: string, job: WorldJob): WorldJobRow {
  return {
    id: job.id,
    session_id: sessionId,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt,
    display_name: job.displayName,
    model_preset: job.modelPreset,
    requested_model: job.requestedModel,
    source_asset_kind: job.sourceAssetKind,
    prompt: job.prompt,
    operation_id: job.operationId,
    operation_expires_at: job.operationExpiresAt,
    world_id: job.worldId,
    error_message: job.errorMessage,
    status_detail: job.statusDetail,
    world: job.world
  };
}

export async function listSupabaseWorldJobs(sessionId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("world_jobs")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false });

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return ((data ?? []) as WorldJobRow[]).map(normalizeWorldJob);
}

export async function getSupabaseWorldJob(sessionId: string, jobId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("world_jobs")
    .select("*")
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .maybeSingle<WorldJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return data ? normalizeWorldJob(data) : null;
}

export async function createSupabaseWorldJob(
  sessionId: string,
  job: Omit<WorldJob, "id" | "sessionId" | "createdAt" | "updatedAt" | "sourceImageUrl">
) {
  const now = new Date().toISOString();
  const nextJob: WorldJob = {
    ...job,
    id: randomUUID(),
    sessionId,
    createdAt: now,
    updatedAt: now,
    sourceImageUrl: getSourceImageUrl(sessionId, job.sourceAssetKind)
  };

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("world_jobs")
    .insert(toWorldJobRow(sessionId, nextJob))
    .select("*")
    .single<WorldJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeWorldJob(data);
}

export async function updateSupabaseWorldJob(
  sessionId: string,
  jobId: string,
  updater: (job: WorldJob) => WorldJob
) {
  const current = await getSupabaseWorldJob(sessionId, jobId);
  if (!current) {
    throw new Error("World job not found");
  }

  const nextJob: WorldJob = {
    ...updater(current),
    updatedAt: new Date().toISOString()
  };

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("world_jobs")
    .update(toWorldJobRow(sessionId, nextJob))
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .select("*")
    .single<WorldJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeWorldJob(data);
}
