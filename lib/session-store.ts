import { randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import path from "path";
import {
  AnalysisReasoningEffort,
  AssetKind,
  DrawingEvent,
  ImageGenerationProfile,
  ImageSizePreset,
  SceneAnalysis,
  SessionDetail,
  SessionSummary,
  VideoSourcePlan,
  TranscriptToken
} from "@/lib/types";
import { listVideoJobs } from "@/lib/video-store";
import { listWorldJobs } from "@/lib/world-store";

const DATA_ROOT = path.resolve(process.env.SESSION_DATA_ROOT || path.join(process.cwd(), "data", "sessions"));
const INDEX_PATH = path.join(DATA_ROOT, "index.json");
const MAX_SESSIONS = 8;
const DEFAULT_ANALYSIS_REASONING_EFFORT: AnalysisReasoningEffort = "medium";
const DEFAULT_IMAGE_SIZE_PRESET: ImageSizePreset = "medium";
const DEFAULT_IMAGE_GENERATION_PROFILE: ImageGenerationProfile = "pro";

interface SessionMeta extends SessionSummary {}

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

function normalizeSummary(summary: SessionSummary | (Partial<SessionSummary> & { id: string; title: string; status: SessionSummary["status"]; createdAt: string; updatedAt: string; durationMs: number; audioMimeType: string | null; canvasWidth: number; canvasHeight: number; transcriptApproximate: boolean; errorMessage: string | null; })) {
  return {
    ...summary,
    analysisReasoningEffort:
      summary.analysisReasoningEffort === "low" ||
      summary.analysisReasoningEffort === "medium" ||
      summary.analysisReasoningEffort === "high"
        ? summary.analysisReasoningEffort
        : DEFAULT_ANALYSIS_REASONING_EFFORT,
    imageSizePreset:
      summary.imageSizePreset === "small" ||
      summary.imageSizePreset === "medium" ||
      summary.imageSizePreset === "large"
        ? summary.imageSizePreset
        : DEFAULT_IMAGE_SIZE_PRESET,
    imageGenerationProfile:
      summary.imageGenerationProfile === "fast"
        ? "fast"
        : summary.imageGenerationProfile === "pro" || summary.imageGenerationProfile === "quality"
          ? "pro"
          : DEFAULT_IMAGE_GENERATION_PROFILE
  } satisfies SessionSummary;
}

function getSessionDir(sessionId: string) {
  return path.join(DATA_ROOT, sessionId);
}

function getMetaPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "meta.json");
}

function getEventsPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "events.json");
}

function getTranscriptPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "transcript.json");
}

function getAnalysisPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "analysis.json");
}

function getVideoSourcePlanPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "video-source-plan.json");
}

function getAssetPath(sessionId: string, assetKind: AssetKind) {
  switch (assetKind) {
    case "sketch":
      return path.join(getSessionDir(sessionId), "sketch.png");
    case "annotatedSketch":
      return path.join(getSessionDir(sessionId), "annotated-sketch.png");
    case "videoAnnotatedSketch":
      return path.join(getSessionDir(sessionId), "video-annotated-sketch.png");
    case "generatedImage":
      return path.join(getSessionDir(sessionId), "generated-image.png");
    case "generatedImageLabeled":
      return path.join(getSessionDir(sessionId), "generated-image-labeled.png");
    case "generatedImagePlain":
      return path.join(getSessionDir(sessionId), "generated-image-plain.png");
    case "generatedVideoSourceImage":
      return path.join(getSessionDir(sessionId), "generated-video-source-image.png");
  }
}

async function ensureStorage() {
  await mkdir(DATA_ROOT, { recursive: true });

  try {
    await stat(INDEX_PATH);
  } catch {
    await writeJsonAtomic(INDEX_PATH, []);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

async function readIndex() {
  await ensureStorage();
  const content = await readFile(INDEX_PATH, "utf8");
  const parsed = JSON.parse(content) as SessionSummary[];
  return parsed
    .map((summary) => normalizeSummary(summary))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

async function writeIndex(summaries: SessionSummary[]) {
  await ensureStorage();
  const ordered = [...summaries].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );
  await writeJsonAtomic(INDEX_PATH, ordered);
}

async function writeMeta(summary: SessionSummary) {
  await mkdir(getSessionDir(summary.id), { recursive: true });
  await writeJsonAtomic(getMetaPath(summary.id), normalizeSummary(summary));
}

async function upsertSummary(summary: SessionSummary) {
  const current = await readIndex();
  const filtered = current.filter((item) => item.id !== summary.id);
  filtered.unshift(normalizeSummary(summary));
  await writeIndex(filtered);
  await writeMeta(summary);
}

async function pruneSessions() {
  const current = await readIndex();
  if (current.length <= MAX_SESSIONS) {
    return;
  }

  const keep = current.slice(0, MAX_SESSIONS);
  const remove = current.slice(MAX_SESSIONS);

  await Promise.all(
    remove.map(async (summary) => {
      await rm(getSessionDir(summary.id), { recursive: true, force: true });
    })
  );
  await writeIndex(keep);
}

async function readMeta(sessionId: string): Promise<SessionMeta | null> {
  try {
    const content = await readFile(getMetaPath(sessionId), "utf8");
    return normalizeSummary(JSON.parse(content) as SessionMeta);
  } catch {
    return null;
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
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

async function getPreferredResultUrl(sessionId: string) {
  const worldJobs = await listWorldJobs(sessionId);
  const videoJobs = await listVideoJobs(sessionId);
  const latestWorldJob = worldJobs[0] ?? null;
  const latestVideoJob = videoJobs[0] ?? null;

  if (latestWorldJob && latestVideoJob) {
    return new Date(latestWorldJob.createdAt).getTime() >= new Date(latestVideoJob.createdAt).getTime()
      ? `/sessions/${sessionId}/worlds/${latestWorldJob.id}`
      : `/sessions/${sessionId}/videos/${latestVideoJob.id}`;
  }

  if (latestWorldJob) {
    return `/sessions/${sessionId}/worlds/${latestWorldJob.id}`;
  }

  if (latestVideoJob) {
    return `/sessions/${sessionId}/videos/${latestVideoJob.id}`;
  }

  try {
    const files = await readdir(getSessionDir(sessionId));
    const hasGeneratedImage =
      files.includes("generated-image-labeled.png") ||
      files.includes("generated-image-plain.png") ||
      files.includes("generated-image.png");

    if (hasGeneratedImage) {
      return `/sessions/${sessionId}/image`;
    }
  } catch {
    return `/sessions/${sessionId}`;
  }

  return `/sessions/${sessionId}`;
}

export async function createSession(
  title?: string,
  options?: {
    analysisReasoningEffort?: AnalysisReasoningEffort;
    imageSizePreset?: ImageSizePreset;
    imageGenerationProfile?: ImageGenerationProfile;
  }
) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const summary: SessionSummary = {
    id,
    title: title?.trim() || `Session ${createdAt.replace("T", " ").slice(0, 16)}`,
    status: "created",
    createdAt,
    updatedAt: createdAt,
    durationMs: 0,
    audioMimeType: null,
    canvasWidth: 0,
    canvasHeight: 0,
    transcriptApproximate: false,
    analysisReasoningEffort: options?.analysisReasoningEffort ?? DEFAULT_ANALYSIS_REASONING_EFFORT,
    imageSizePreset: options?.imageSizePreset ?? DEFAULT_IMAGE_SIZE_PRESET,
    imageGenerationProfile: options?.imageGenerationProfile ?? DEFAULT_IMAGE_GENERATION_PROFILE,
    errorMessage: null
  };

  await upsertSummary(summary);
  await pruneSessions();
  return summary;
}

export async function listRecentSessions() {
  const summaries = await readIndex();
  return Promise.all(
    summaries.map(async (summary) => ({
      ...summary,
      preferredResultUrl: await getPreferredResultUrl(summary.id)
    }))
  );
}

export async function updateSessionPreferences(
  sessionId: string,
  preferences: {
    analysisReasoningEffort?: AnalysisReasoningEffort;
    imageSizePreset?: ImageSizePreset;
    imageGenerationProfile?: ImageGenerationProfile;
  }
) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  const nextSummary = normalizeSummary({
    ...summary,
    updatedAt: new Date().toISOString(),
    analysisReasoningEffort:
      preferences.analysisReasoningEffort ?? summary.analysisReasoningEffort,
    imageSizePreset: preferences.imageSizePreset ?? summary.imageSizePreset,
    imageGenerationProfile:
      preferences.imageGenerationProfile ?? summary.imageGenerationProfile
  });

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function saveSessionUpload(sessionId: string, payload: UploadPayload) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  const sessionDir = getSessionDir(sessionId);
  await mkdir(sessionDir, { recursive: true });

  const audioFilePath = path.join(sessionDir, `audio.${payload.audioExtension || inferAudioExtension(payload.audioMimeType)}`);
  await writeFile(audioFilePath, payload.audioBuffer);
  await writeJsonAtomic(getEventsPath(sessionId), payload.events);
  if (payload.sketchBuffer) {
    await writeFile(getAssetPath(sessionId, "sketch"), payload.sketchBuffer);
  }

  const nextSummary: SessionSummary = {
    ...summary,
    status: "uploaded",
    updatedAt: new Date().toISOString(),
    durationMs: payload.durationMs,
    audioMimeType: payload.audioMimeType,
    canvasWidth: payload.canvasWidth,
    canvasHeight: payload.canvasHeight,
    errorMessage: null
  };

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function markSessionProcessing(sessionId: string) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  const nextSummary: SessionSummary = {
    ...summary,
    status: "processing",
    updatedAt: new Date().toISOString(),
    errorMessage: null
  };
  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function saveSessionTranscript(sessionId: string, tokens: TranscriptToken[], approximate: boolean) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  await writeJsonAtomic(getTranscriptPath(sessionId), tokens);

  const nextSummary: SessionSummary = {
    ...summary,
    status: "ready",
    updatedAt: new Date().toISOString(),
    transcriptApproximate: approximate,
    errorMessage: null
  };
  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function saveSessionAnalysis(sessionId: string, analysis: SceneAnalysis) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  await writeJsonAtomic(getAnalysisPath(sessionId), analysis);

  const nextSummary: SessionSummary = {
    ...summary,
    updatedAt: new Date().toISOString(),
    errorMessage: null
  };

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function saveSessionVideoSourcePlan(sessionId: string, plan: VideoSourcePlan) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  await writeJsonAtomic(getVideoSourcePlanPath(sessionId), plan);

  const nextSummary: SessionSummary = {
    ...summary,
    updatedAt: new Date().toISOString(),
    errorMessage: null
  };

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function saveSessionAsset(sessionId: string, assetKind: AssetKind, buffer: Buffer) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  await mkdir(getSessionDir(sessionId), { recursive: true });
  await writeFile(getAssetPath(sessionId, assetKind), buffer);

  const nextSummary: SessionSummary = {
    ...summary,
    updatedAt: new Date().toISOString(),
    errorMessage: null
  };

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function markSessionFailed(sessionId: string, error: string) {
  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  const nextSummary: SessionSummary = {
    ...summary,
    status: "failed",
    updatedAt: new Date().toISOString(),
    errorMessage: error
  };

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const summary = await readMeta(sessionId);
  if (!summary) {
    return null;
  }

  const events = await readJsonFile<DrawingEvent[]>(getEventsPath(sessionId), []);
  const transcript = await readJsonFile<TranscriptToken[]>(getTranscriptPath(sessionId), []);
  const analysis = await readJsonFile<SceneAnalysis | null>(getAnalysisPath(sessionId), null);
  const worldJobs = await listWorldJobs(sessionId);
  const videoJobs = await listVideoJobs(sessionId);

  const sessionDir = getSessionDir(sessionId);
  const files = await readdir(sessionDir);
  const audioFile = files.find((fileName) => fileName.startsWith("audio."));
  const sketchExists = files.includes("sketch.png");
  const annotatedSketchExists = files.includes("annotated-sketch.png");
  const videoAnnotatedSketchExists = files.includes("video-annotated-sketch.png");
  const generatedImageLabeledExists = files.includes("generated-image-labeled.png");
  const generatedImagePlainExists = files.includes("generated-image-plain.png");
  const generatedVideoSourceImageExists = files.includes("generated-video-source-image.png");
  const generatedImageExists = files.includes("generated-image.png");
  const generatedImageUrl = generatedImageLabeledExists
    ? `/api/sessions/${sessionId}/assets/generatedImageLabeled`
    : generatedImageExists
      ? `/api/sessions/${sessionId}/assets/generatedImage`
      : null;

  return {
    ...summary,
    events,
    transcript,
    audioUrl: audioFile ? `/api/sessions/${sessionId}/audio` : null,
    sketchUrl: sketchExists ? `/api/sessions/${sessionId}/assets/sketch` : null,
    annotatedSketchUrl: annotatedSketchExists
      ? `/api/sessions/${sessionId}/assets/annotatedSketch`
      : null,
    videoAnnotatedSketchUrl: videoAnnotatedSketchExists
      ? `/api/sessions/${sessionId}/assets/videoAnnotatedSketch`
      : null,
    generatedImageUrl,
    generatedImageLabeledUrl: generatedImageLabeledExists
      ? `/api/sessions/${sessionId}/assets/generatedImageLabeled`
      : generatedImageUrl,
    generatedImagePlainUrl: generatedImagePlainExists
      ? `/api/sessions/${sessionId}/assets/generatedImagePlain`
      : null,
    generatedVideoSourceImageUrl: generatedVideoSourceImageExists
      ? `/api/sessions/${sessionId}/assets/generatedVideoSourceImage`
      : null,
    analysis,
    worldJobs,
    videoJobs
  };
}

export async function getSessionAudio(sessionId: string) {
  const sessionDir = getSessionDir(sessionId);
  const files = await readdir(sessionDir);
  const audioFile = files.find((fileName) => fileName.startsWith("audio."));
  if (!audioFile) {
    return null;
  }

  const audioPath = path.join(sessionDir, audioFile);
  const buffer = await readFile(audioPath);
  const summary = await readMeta(sessionId);

  return {
    buffer,
    fileName: audioFile,
    mimeType: summary?.audioMimeType || "application/octet-stream"
  };
}

export async function getSessionAnalysis(sessionId: string) {
  return readJsonFile<SceneAnalysis | null>(getAnalysisPath(sessionId), null);
}

export async function getSessionVideoSourcePlan(sessionId: string) {
  return readJsonFile<VideoSourcePlan | null>(getVideoSourcePlanPath(sessionId), null);
}

export async function getSessionAsset(sessionId: string, assetKind: AssetKind) {
  const assetPath = getAssetPath(sessionId, assetKind);

  try {
    const buffer = await readFile(assetPath);
    return {
      buffer,
      fileName: path.basename(assetPath),
      mimeType: "image/png"
    };
  } catch {
    return null;
  }
}
