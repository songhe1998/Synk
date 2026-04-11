import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";
import { WorldJob } from "@/lib/types";

const DATA_ROOT = path.resolve(process.env.SESSION_DATA_ROOT || path.join(process.cwd(), "data", "sessions"));

function getSessionDir(sessionId: string) {
  return path.join(DATA_ROOT, sessionId);
}

function getWorldJobsPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "world-jobs.json");
}

function getSourceImageUrl(sessionId: string, sourceAssetKind: WorldJob["sourceAssetKind"]) {
  return `/api/sessions/${sessionId}/assets/${sourceAssetKind}`;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

function normalizeWorldJob(sessionId: string, job: WorldJob): WorldJob {
  return {
    ...job,
    sourceImageUrl: job.sourceImageUrl ?? getSourceImageUrl(sessionId, job.sourceAssetKind)
  };
}

async function readWorldJobs(sessionId: string) {
  try {
    const content = await readFile(getWorldJobsPath(sessionId), "utf8");
    const parsed = JSON.parse(content) as WorldJob[];
    return parsed
      .map((job) => normalizeWorldJob(sessionId, job))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  } catch {
    return [] as WorldJob[];
  }
}

async function writeWorldJobs(sessionId: string, jobs: WorldJob[]) {
  await mkdir(getSessionDir(sessionId), { recursive: true });
  const ordered = jobs
    .map((job) => normalizeWorldJob(sessionId, job))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  await writeJsonAtomic(getWorldJobsPath(sessionId), ordered);
}

export async function listWorldJobs(sessionId: string) {
  return readWorldJobs(sessionId);
}

export async function getWorldJob(sessionId: string, jobId: string) {
  const jobs = await readWorldJobs(sessionId);
  return jobs.find((job) => job.id === jobId) ?? null;
}

export async function createWorldJob(
  sessionId: string,
  job: Omit<WorldJob, "id" | "sessionId" | "createdAt" | "updatedAt" | "sourceImageUrl">
) {
  const now = new Date().toISOString();
  const nextJob = normalizeWorldJob(sessionId, {
    ...job,
    id: randomUUID(),
    sessionId,
    createdAt: now,
    updatedAt: now,
    sourceImageUrl: getSourceImageUrl(sessionId, job.sourceAssetKind)
  });
  const jobs = await readWorldJobs(sessionId);
  jobs.unshift(nextJob);
  await writeWorldJobs(sessionId, jobs);
  return nextJob;
}

export async function updateWorldJob(
  sessionId: string,
  jobId: string,
  updater: (job: WorldJob) => WorldJob
) {
  const jobs = await readWorldJobs(sessionId);
  const current = jobs.find((job) => job.id === jobId);

  if (!current) {
    throw new Error("World job not found");
  }

  const nextJob = normalizeWorldJob(sessionId, {
    ...updater(current),
    updatedAt: new Date().toISOString()
  });

  const nextJobs = jobs.map((job) => (job.id === jobId ? nextJob : job));
  await writeWorldJobs(sessionId, nextJobs);
  return nextJob;
}
