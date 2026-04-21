import { randomUUID } from "crypto";
import path from "path";
import { WebsiteArtifactKind, WebsiteJob } from "@/lib/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseStorageBucket } from "@/lib/supabase/config";
import { readSessionBinaryAsset } from "@/lib/supabase-asset-store";
import { normalizeSupabaseError } from "@/lib/supabase/errors";
import {
  getWebsitePreviewMimeType,
  normalizeWebsitePreviewAssetPath
} from "@/lib/website-artifacts";

interface SessionOwnerRow {
  user_id: string;
}

interface WebsiteJobRow {
  id: string;
  session_id: string;
  status: WebsiteJob["status"];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  display_name: string;
  framework: WebsiteJob["framework"];
  sandbox_provider: WebsiteJob["sandboxProvider"];
  sandbox_id: string | null;
  transcript_text: string;
  pages: WebsiteJob["pages"];
  prompt: string;
  status_detail: string | null;
  error_message: string | null;
  preview_image_file_name: string | null;
  preview_image_mime_type: string | null;
  preview_image_storage_path: string | null;
  code_archive_file_name: string | null;
  code_archive_mime_type: string | null;
  code_archive_storage_path: string | null;
  dist_archive_file_name: string | null;
  dist_archive_mime_type: string | null;
  dist_archive_storage_path: string | null;
}

function getWebsiteJobAssetUrl(sessionId: string, jobId: string, artifactKind: WebsiteArtifactKind, fileName: string | null) {
  return fileName ? `/api/sessions/${sessionId}/websites/${jobId}/asset?kind=${artifactKind}` : null;
}

function getWebsiteJobPreviewUrl(sessionId: string, jobId: string, fileName: string | null) {
  return fileName ? `/sessions/${sessionId}/websites/${jobId}` : null;
}

function normalizeWebsiteJob(row: WebsiteJobRow): WebsiteJob {
  const pages = (row.pages ?? []).map((page, index) => ({
    ...page,
    path: page.path || (index === 0 ? "/" : `/page-${index + 1}`),
    sketchUrl: page.sketchUrl ?? `/api/sessions/${row.session_id}/assets/${page.sourceAssetKind}`
  }));

  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    displayName: row.display_name,
    framework: row.framework,
    sandboxProvider: row.sandbox_provider,
    sandboxId: row.sandbox_id,
    transcriptText: row.transcript_text,
    pages,
    prompt: row.prompt,
    statusDetail: row.status_detail,
    errorMessage: row.error_message,
    previewImageFileName: row.preview_image_file_name,
    previewImageMimeType: row.preview_image_mime_type,
    codeArchiveFileName: row.code_archive_file_name,
    codeArchiveMimeType: row.code_archive_mime_type,
    distArchiveFileName: row.dist_archive_file_name,
    distArchiveMimeType: row.dist_archive_mime_type,
    previewImageUrl: getWebsiteJobAssetUrl(row.session_id, row.id, "previewImage", row.preview_image_file_name),
    codeArchiveUrl: getWebsiteJobAssetUrl(row.session_id, row.id, "codeArchive", row.code_archive_file_name),
    distArchiveUrl: getWebsiteJobAssetUrl(row.session_id, row.id, "distArchive", row.dist_archive_file_name),
    previewUrl: getWebsiteJobPreviewUrl(row.session_id, row.id, row.dist_archive_file_name)
  };
}

function toWebsiteJobRow(
  sessionId: string,
  job: WebsiteJob,
  existingPaths: {
    previewImageStoragePath: string | null;
    codeArchiveStoragePath: string | null;
    distArchiveStoragePath: string | null;
  }
): WebsiteJobRow {
  return {
    id: job.id,
    session_id: sessionId,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt,
    display_name: job.displayName,
    framework: job.framework,
    sandbox_provider: job.sandboxProvider,
    sandbox_id: job.sandboxId,
    transcript_text: job.transcriptText,
    pages: job.pages,
    prompt: job.prompt,
    status_detail: job.statusDetail,
    error_message: job.errorMessage,
    preview_image_file_name: job.previewImageFileName,
    preview_image_mime_type: job.previewImageMimeType,
    preview_image_storage_path: existingPaths.previewImageStoragePath,
    code_archive_file_name: job.codeArchiveFileName,
    code_archive_mime_type: job.codeArchiveMimeType,
    code_archive_storage_path: existingPaths.codeArchiveStoragePath,
    dist_archive_file_name: job.distArchiveFileName,
    dist_archive_mime_type: job.distArchiveMimeType,
    dist_archive_storage_path: existingPaths.distArchiveStoragePath
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

function getPreviewStoragePath(ownerId: string, sessionId: string, jobId: string, assetPath: string) {
  return path.posix.join(ownerId, sessionId, "websites", jobId, "preview", assetPath);
}

async function getJobRow(sessionId: string, jobId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("website_jobs")
    .select("*")
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .maybeSingle<WebsiteJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return data;
}

export async function listSupabaseWebsiteJobs(sessionId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("website_jobs")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false });

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return ((data ?? []) as WebsiteJobRow[]).map(normalizeWebsiteJob);
}

export async function getSupabaseWebsiteJob(sessionId: string, jobId: string) {
  const row = await getJobRow(sessionId, jobId);
  return row ? normalizeWebsiteJob(row) : null;
}

export async function createSupabaseWebsiteJob(
  sessionId: string,
  job: Omit<
    WebsiteJob,
    | "id"
    | "sessionId"
    | "createdAt"
    | "updatedAt"
    | "previewImageUrl"
    | "codeArchiveUrl"
    | "distArchiveUrl"
    | "previewUrl"
  >
) {
  const now = new Date().toISOString();
  const nextJob: WebsiteJob = {
    ...job,
    id: randomUUID(),
    sessionId,
    createdAt: now,
    updatedAt: now,
    previewImageUrl: null,
    codeArchiveUrl: null,
    distArchiveUrl: null,
    previewUrl: null
  };

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("website_jobs")
    .insert(
      toWebsiteJobRow(sessionId, nextJob, {
        previewImageStoragePath: null,
        codeArchiveStoragePath: null,
        distArchiveStoragePath: null
      })
    )
    .select("*")
    .single<WebsiteJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeWebsiteJob(data);
}

export async function updateSupabaseWebsiteJob(
  sessionId: string,
  jobId: string,
  updater: (job: WebsiteJob) => WebsiteJob
) {
  const currentRow = await getJobRow(sessionId, jobId);
  if (!currentRow) {
    throw new Error("Website job not found");
  }

  const current = normalizeWebsiteJob(currentRow);
  const nextJob: WebsiteJob = {
    ...updater(current),
    updatedAt: new Date().toISOString()
  };

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("website_jobs")
    .update(
      toWebsiteJobRow(sessionId, nextJob, {
        previewImageStoragePath: currentRow.preview_image_storage_path,
        codeArchiveStoragePath: currentRow.code_archive_storage_path,
        distArchiveStoragePath: currentRow.dist_archive_storage_path
      })
    )
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .select("*")
    .single<WebsiteJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeWebsiteJob(data);
}

export async function saveSupabaseWebsiteJobArtifact(
  sessionId: string,
  jobId: string,
  artifact: {
    kind: WebsiteArtifactKind;
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }
) {
  const admin = getSupabaseAdminClient();
  const ownerId = await getSessionOwner(sessionId);
  const storagePath = `${ownerId}/${sessionId}/websites/${jobId}/${artifact.fileName}`;
  const bucket = getSupabaseStorageBucket();

  const { error: uploadError } = await admin.storage.from(bucket).upload(storagePath, artifact.buffer, {
    contentType: artifact.mimeType,
    upsert: true
  });

  if (uploadError) {
    throw normalizeSupabaseError(uploadError);
  }

  const patch =
    artifact.kind === "previewImage"
      ? {
          preview_image_file_name: artifact.fileName,
          preview_image_mime_type: artifact.mimeType,
          preview_image_storage_path: storagePath
        }
      : artifact.kind === "codeArchive"
        ? {
            code_archive_file_name: artifact.fileName,
            code_archive_mime_type: artifact.mimeType,
            code_archive_storage_path: storagePath
          }
        : {
            dist_archive_file_name: artifact.fileName,
            dist_archive_mime_type: artifact.mimeType,
            dist_archive_storage_path: storagePath
          };

  const { data, error } = await admin
    .from("website_jobs")
    .update({
      ...patch,
      updated_at: new Date().toISOString()
    })
    .eq("session_id", sessionId)
    .eq("id", jobId)
    .select("*")
    .single<WebsiteJobRow>();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return normalizeWebsiteJob(data);
}

export async function getSupabaseWebsiteJobArtifact(
  sessionId: string,
  jobId: string,
  artifactKind: WebsiteArtifactKind
) {
  const row = await getJobRow(sessionId, jobId);
  if (!row) {
    return null;
  }

  const descriptor =
    artifactKind === "previewImage"
      ? {
          storagePath: row.preview_image_storage_path,
          fileName: row.preview_image_file_name,
          mimeType: row.preview_image_mime_type
        }
      : artifactKind === "codeArchive"
        ? {
            storagePath: row.code_archive_storage_path,
            fileName: row.code_archive_file_name,
            mimeType: row.code_archive_mime_type
          }
        : {
            storagePath: row.dist_archive_storage_path,
            fileName: row.dist_archive_file_name,
            mimeType: row.dist_archive_mime_type
          };

  if (!descriptor.storagePath || !descriptor.fileName) {
    return null;
  }

  return readSessionBinaryAsset(descriptor.storagePath, descriptor.fileName, descriptor.mimeType);
}

export async function saveSupabaseWebsitePreviewFiles(
  sessionId: string,
  jobId: string,
  files: Array<{
    assetPath: string;
    buffer: Buffer;
  }>
) {
  const admin = getSupabaseAdminClient();
  const ownerId = await getSessionOwner(sessionId);
  const bucket = getSupabaseStorageBucket();

  for (const file of files) {
    const normalizedPath = normalizeWebsitePreviewAssetPath(file.assetPath);
    if (!normalizedPath) {
      continue;
    }

    const storagePath = getPreviewStoragePath(ownerId, sessionId, jobId, normalizedPath);
    const { error } = await admin.storage.from(bucket).upload(storagePath, file.buffer, {
      contentType: getWebsitePreviewMimeType(normalizedPath),
      upsert: true
    });

    if (error) {
      throw normalizeSupabaseError(error);
    }
  }
}

export async function getSupabaseWebsitePreviewFile(sessionId: string, jobId: string, assetPath: string) {
  const normalizedPath = normalizeWebsitePreviewAssetPath(assetPath);
  if (!normalizedPath) {
    return null;
  }

  const ownerId = await getSessionOwner(sessionId);
  const storagePath = getPreviewStoragePath(ownerId, sessionId, jobId, normalizedPath);
  return readSessionBinaryAsset(storagePath, path.posix.basename(normalizedPath), getWebsitePreviewMimeType(normalizedPath));
}
