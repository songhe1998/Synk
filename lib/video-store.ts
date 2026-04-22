import { randomUUID } from "crypto";
import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import path from "path";
import { VideoJob } from "@/lib/types";
import { hasSupabaseAdminConfig } from "@/lib/supabase/config";
import {
  createSupabaseVideoJob,
  getSupabaseVideoJob,
  getSupabaseVideoJobAsset,
  listSupabaseVideoJobs,
  saveSupabaseVideoJobAsset,
  updateSupabaseVideoJob
} from "@/lib/supabase-video-store";

const DATA_ROOT = path.resolve(process.env.SESSION_DATA_ROOT || path.join(process.cwd(), "data", "sessions"));

function getSessionDir(sessionId: string) {
  return path.join(DATA_ROOT, sessionId);
}

function getVideoJobsPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "video-jobs.json");
}

function getSourceImageUrl(sessionId: string, sourceAssetKind: VideoJob["sourceAssetKind"]) {
  return `/api/sessions/${sessionId}/assets/${sourceAssetKind}`;
}

function getVideoAssetPath(sessionId: string, jobId: string, fileName: string) {
  return path.join(getSessionDir(sessionId), fileName || `video-${jobId}.mp4`);
}

function getVideoAssetUrl(sessionId: string, jobId: string, fileName: string | null) {
  return fileName ? `/api/sessions/${sessionId}/videos/${jobId}/asset` : null;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

function normalizeVideoJob(sessionId: string, job: VideoJob): VideoJob {
  return {
    ...job,
    pipelineMode:
      job.pipelineMode ?? (job.sourceAssetKind === "generatedVideoSourceImage" ? "dynamic" : "normal"),
    transcriptText: job.transcriptText ?? null,
    sourceImagePrompt: job.sourceImagePrompt ?? null,
    sourceImagePromptModel: job.sourceImagePromptModel ?? null,
    promptModel: job.promptModel ?? null,
    videoStoragePath: job.videoStoragePath ?? null,
    sourceImageUrl: job.sourceImageUrl ?? getSourceImageUrl(sessionId, job.sourceAssetKind),
    videoUrl: getVideoAssetUrl(sessionId, job.id, job.videoFileName) ?? job.remoteVideoUrl
  };
}

async function readVideoJobs(sessionId: string) {
  try {
    const content = await readFile(getVideoJobsPath(sessionId), "utf8");
    const parsed = JSON.parse(content) as VideoJob[];
    return parsed
      .map((job) => normalizeVideoJob(sessionId, job))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  } catch {
    return [] as VideoJob[];
  }
}

export async function listLocalVideoJobs(sessionId: string) {
  return readVideoJobs(sessionId);
}

export async function getLocalVideoJob(sessionId: string, jobId: string) {
  const jobs = await readVideoJobs(sessionId);
  return jobs.find((job) => job.id === jobId) ?? null;
}

async function writeVideoJobs(sessionId: string, jobs: VideoJob[]) {
  await mkdir(getSessionDir(sessionId), { recursive: true });
  const ordered = jobs
    .map((job) => normalizeVideoJob(sessionId, job))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  await writeJsonAtomic(getVideoJobsPath(sessionId), ordered);
}

export async function listVideoJobs(sessionId: string) {
  if (hasSupabaseAdminConfig()) {
    return listSupabaseVideoJobs(sessionId);
  }

  return readVideoJobs(sessionId);
}

export async function getVideoJob(sessionId: string, jobId: string) {
  if (hasSupabaseAdminConfig()) {
    return getSupabaseVideoJob(sessionId, jobId);
  }

  const jobs = await readVideoJobs(sessionId);
  return jobs.find((job) => job.id === jobId) ?? null;
}

export async function createVideoJob(
  sessionId: string,
  job: Omit<VideoJob, "id" | "sessionId" | "createdAt" | "updatedAt" | "sourceImageUrl" | "videoUrl">
) {
  if (hasSupabaseAdminConfig()) {
    return createSupabaseVideoJob(sessionId, job);
  }

  const now = new Date().toISOString();
  const nextJob = normalizeVideoJob(sessionId, {
    ...job,
    id: randomUUID(),
    sessionId,
    createdAt: now,
    updatedAt: now,
    sourceImageUrl: getSourceImageUrl(sessionId, job.sourceAssetKind),
    videoUrl: null
  });

  const jobs = await readVideoJobs(sessionId);
  jobs.unshift(nextJob);
  await writeVideoJobs(sessionId, jobs);
  return nextJob;
}

export async function updateVideoJob(
  sessionId: string,
  jobId: string,
  updater: (job: VideoJob) => VideoJob
) {
  if (hasSupabaseAdminConfig()) {
    return updateSupabaseVideoJob(sessionId, jobId, updater);
  }

  const jobs = await readVideoJobs(sessionId);
  const current = jobs.find((job) => job.id === jobId);

  if (!current) {
    throw new Error("Video job not found");
  }

  const nextJob = normalizeVideoJob(sessionId, {
    ...updater(current),
    updatedAt: new Date().toISOString()
  });

  const nextJobs = jobs.map((job) => (job.id === jobId ? nextJob : job));
  await writeVideoJobs(sessionId, nextJobs);
  return nextJob;
}

export async function saveVideoJobAsset(
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
  if (hasSupabaseAdminConfig()) {
    return saveSupabaseVideoJobAsset(sessionId, jobId, {
      buffer,
      fileName,
      mimeType
    });
  }

  await mkdir(getSessionDir(sessionId), { recursive: true });
  await writeFile(getVideoAssetPath(sessionId, jobId, fileName), buffer);

  return updateVideoJob(sessionId, jobId, (current) => ({
    ...current,
    videoFileName: fileName,
    videoMimeType: mimeType,
    remoteVideoUrl: current.remoteVideoUrl,
    videoUrl: getVideoAssetUrl(sessionId, jobId, fileName)
  }));
}

export async function getVideoJobAsset(sessionId: string, jobId: string) {
  if (hasSupabaseAdminConfig()) {
    return getSupabaseVideoJobAsset(sessionId, jobId);
  }

  const job = await getVideoJob(sessionId, jobId);
  if (!job?.videoFileName) {
    return null;
  }

  const filePath = getVideoAssetPath(sessionId, jobId, job.videoFileName);

  try {
    await stat(filePath);
  } catch {
    return null;
  }

  const buffer = await readFile(filePath);
  return {
    buffer,
    fileName: job.videoFileName,
    mimeType: job.videoMimeType || "video/mp4"
  };
}
