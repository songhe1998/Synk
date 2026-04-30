import { randomUUID } from "crypto";
import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import path from "path";
import { WebsiteArtifactKind, WebsiteEditTargetResolution, WebsiteJob, WebsiteReferenceImage } from "@/lib/types";
import { hasSupabaseAdminConfig } from "@/lib/supabase/config";
import {
  getWebsitePreviewMimeType,
  normalizeWebsitePreviewAssetPath
} from "@/lib/website-artifacts";
import {
  createSupabaseWebsiteJob,
  getSupabaseWebsiteJob,
  getSupabaseWebsiteJobArtifact,
  getSupabaseWebsitePreviewFile,
  listSupabaseWebsiteJobs,
  saveSupabaseWebsiteJobArtifact,
  saveSupabaseWebsitePreviewFiles,
  updateSupabaseWebsiteJob
} from "@/lib/supabase-website-store";

const DATA_ROOT = path.resolve(process.env.SESSION_DATA_ROOT || path.join(process.cwd(), "data", "sessions"));

function getSessionDir(sessionId: string) {
  return path.join(DATA_ROOT, sessionId);
}

function getWebsiteJobsPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "website-jobs.json");
}

function getWebsiteArtifactsDir(sessionId: string, jobId: string) {
  return path.join(getSessionDir(sessionId), "website-artifacts", jobId);
}

function getWebsitePreviewDir(sessionId: string, jobId: string) {
  return path.join(getWebsiteArtifactsDir(sessionId, jobId), "preview");
}

function getWebsiteArtifactPath(sessionId: string, jobId: string, fileName: string) {
  return path.join(getWebsiteArtifactsDir(sessionId, jobId), fileName);
}

function getWebsitePreviewFilePath(sessionId: string, jobId: string, assetPath: string) {
  return path.join(getWebsitePreviewDir(sessionId, jobId), assetPath);
}

function getWebsiteJobAssetUrl(sessionId: string, jobId: string, artifactKind: WebsiteArtifactKind, fileName: string | null) {
  return fileName ? `/api/sessions/${sessionId}/websites/${jobId}/asset?kind=${artifactKind}` : null;
}

function getWebsiteJobPreviewUrl(sessionId: string, jobId: string, fileName: string | null) {
  return fileName ? `/sessions/${sessionId}/websites/${jobId}` : null;
}

function withWebsiteUrls(sessionId: string, job: WebsiteJob): WebsiteJob {
  const pages = job.pages.map((page, index) => ({
    ...page,
    path: page.path || (index === 0 ? "/" : `/page-${index + 1}`),
    sketchUrl: page.sketchUrl ?? `/api/sessions/${sessionId}/assets/${page.sourceAssetKind}`
  }));

  return {
    ...job,
    sessionId,
    parentJobId: job.parentJobId ?? null,
    revisionNumber: job.revisionNumber ?? 1,
    jobKind: job.jobKind ?? "initial",
    generationProfile: job.generationProfile ?? "econ",
    providerMetadata: job.providerMetadata ?? null,
    referenceImages: normalizeReferenceImages(job.referenceImages ?? job.providerMetadata?.websiteReferenceImages),
    editInstructionText: job.editInstructionText ?? null,
    editTarget: normalizeEditTarget(job.editTarget),
    pages,
    previewImageUrl: getWebsiteJobAssetUrl(sessionId, job.id, "previewImage", job.previewImageFileName),
    codeArchiveUrl: getWebsiteJobAssetUrl(sessionId, job.id, "codeArchive", job.codeArchiveFileName),
    distArchiveUrl: getWebsiteJobAssetUrl(sessionId, job.id, "distArchive", job.distArchiveFileName),
    previewUrl: getWebsiteJobPreviewUrl(sessionId, job.id, job.distArchiveFileName)
  };
}

function normalizeEditTarget(value: WebsiteEditTargetResolution | null | undefined) {
  return value ?? null;
}

function normalizeReferenceImages(value: unknown): WebsiteReferenceImage[] {
  return Array.isArray(value) ? (value as WebsiteReferenceImage[]) : [];
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

async function readWebsiteJobs(sessionId: string) {
  try {
    const content = await readFile(getWebsiteJobsPath(sessionId), "utf8");
    const parsed = JSON.parse(content) as WebsiteJob[];
    return parsed
      .map((job) => withWebsiteUrls(sessionId, job))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  } catch {
    return [] as WebsiteJob[];
  }
}

async function writeWebsiteJobs(sessionId: string, jobs: WebsiteJob[]) {
  await mkdir(getSessionDir(sessionId), { recursive: true });
  const ordered = jobs
    .map((job) => withWebsiteUrls(sessionId, job))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  await writeJsonAtomic(getWebsiteJobsPath(sessionId), ordered);
}

export async function listLocalWebsiteJobs(sessionId: string) {
  return readWebsiteJobs(sessionId);
}

export async function getLocalWebsiteJob(sessionId: string, jobId: string) {
  const jobs = await readWebsiteJobs(sessionId);
  return jobs.find((job) => job.id === jobId) ?? null;
}

export async function listWebsiteJobs(sessionId: string) {
  if (hasSupabaseAdminConfig()) {
    return listSupabaseWebsiteJobs(sessionId);
  }

  return readWebsiteJobs(sessionId);
}

export async function getWebsiteJob(sessionId: string, jobId: string) {
  if (hasSupabaseAdminConfig()) {
    return getSupabaseWebsiteJob(sessionId, jobId);
  }

  const jobs = await readWebsiteJobs(sessionId);
  return jobs.find((job) => job.id === jobId) ?? null;
}

export async function createWebsiteJob(
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
  if (hasSupabaseAdminConfig()) {
    return createSupabaseWebsiteJob(sessionId, job);
  }

  const now = new Date().toISOString();
  const nextJob = withWebsiteUrls(sessionId, {
    ...job,
    id: randomUUID(),
    sessionId,
    createdAt: now,
    updatedAt: now,
    previewImageUrl: null,
    codeArchiveUrl: null,
    distArchiveUrl: null,
    previewUrl: null
  });

  const jobs = await readWebsiteJobs(sessionId);
  jobs.unshift(nextJob);
  await writeWebsiteJobs(sessionId, jobs);
  return nextJob;
}

export async function updateWebsiteJob(
  sessionId: string,
  jobId: string,
  updater: (job: WebsiteJob) => WebsiteJob
) {
  if (hasSupabaseAdminConfig()) {
    return updateSupabaseWebsiteJob(sessionId, jobId, updater);
  }

  const jobs = await readWebsiteJobs(sessionId);
  const current = jobs.find((job) => job.id === jobId);

  if (!current) {
    throw new Error("Website job not found");
  }

  const nextJob = withWebsiteUrls(sessionId, {
    ...updater(current),
    updatedAt: new Date().toISOString()
  });

  const nextJobs = jobs.map((job) => (job.id === jobId ? nextJob : job));
  await writeWebsiteJobs(sessionId, nextJobs);
  return nextJob;
}

export async function saveWebsiteJobArtifact(
  sessionId: string,
  jobId: string,
  artifact: {
    kind: WebsiteArtifactKind;
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }
) {
  if (hasSupabaseAdminConfig()) {
    return saveSupabaseWebsiteJobArtifact(sessionId, jobId, artifact);
  }

  await mkdir(getWebsiteArtifactsDir(sessionId, jobId), { recursive: true });
  await writeFile(getWebsiteArtifactPath(sessionId, jobId, artifact.fileName), artifact.buffer);

  return updateWebsiteJob(sessionId, jobId, (current) => {
    switch (artifact.kind) {
      case "previewImage":
        return {
          ...current,
          previewImageFileName: artifact.fileName,
          previewImageMimeType: artifact.mimeType
        };
      case "codeArchive":
        return {
          ...current,
          codeArchiveFileName: artifact.fileName,
          codeArchiveMimeType: artifact.mimeType
        };
      case "distArchive":
        return {
          ...current,
          distArchiveFileName: artifact.fileName,
          distArchiveMimeType: artifact.mimeType
        };
    }
  });
}

export async function getWebsiteJobArtifact(
  sessionId: string,
  jobId: string,
  artifactKind: WebsiteArtifactKind
) {
  if (hasSupabaseAdminConfig()) {
    return getSupabaseWebsiteJobArtifact(sessionId, jobId, artifactKind);
  }

  const job = await getWebsiteJob(sessionId, jobId);
  if (!job) {
    return null;
  }

  const descriptor =
    artifactKind === "previewImage"
      ? { fileName: job.previewImageFileName, mimeType: job.previewImageMimeType }
      : artifactKind === "codeArchive"
        ? { fileName: job.codeArchiveFileName, mimeType: job.codeArchiveMimeType }
        : { fileName: job.distArchiveFileName, mimeType: job.distArchiveMimeType };

  if (!descriptor.fileName) {
    return null;
  }

  const filePath = getWebsiteArtifactPath(sessionId, jobId, descriptor.fileName);

  try {
    await stat(filePath);
  } catch {
    return null;
  }

  const buffer = await readFile(filePath);
  return {
    buffer,
    fileName: descriptor.fileName,
    mimeType:
      descriptor.mimeType ||
      (artifactKind === "previewImage" ? "image/png" : "application/gzip")
  };
}

export async function saveWebsitePreviewFiles(
  sessionId: string,
  jobId: string,
  files: Array<{
    assetPath: string;
    buffer: Buffer;
  }>
) {
  if (hasSupabaseAdminConfig()) {
    return saveSupabaseWebsitePreviewFiles(sessionId, jobId, files);
  }

  for (const file of files) {
    const normalizedPath = normalizeWebsitePreviewAssetPath(file.assetPath);
    if (!normalizedPath) {
      continue;
    }

    const destination = getWebsitePreviewFilePath(sessionId, jobId, normalizedPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.buffer);
  }
}

export async function getWebsitePreviewFile(sessionId: string, jobId: string, assetPath: string) {
  if (hasSupabaseAdminConfig()) {
    return getSupabaseWebsitePreviewFile(sessionId, jobId, assetPath);
  }

  const normalizedPath = normalizeWebsitePreviewAssetPath(assetPath);
  if (!normalizedPath) {
    return null;
  }

  const filePath = getWebsitePreviewFilePath(sessionId, jobId, normalizedPath);

  try {
    await stat(filePath);
  } catch {
    return null;
  }

  const buffer = await readFile(filePath);
  return {
    buffer,
    fileName: path.basename(normalizedPath),
    mimeType: getWebsitePreviewMimeType(normalizedPath)
  };
}
