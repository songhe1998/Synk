import { randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import path from "path";
import {
  AnalysisReasoningEffort,
  AssetKind,
  CanvasImageLayer,
  DrawingEvent,
  ImageFollowMode,
  ImageGenerationProfile,
  ImageEditHistoryItem,
  ImageEditAnnotation,
  ImageSizePreset,
  SceneAnalysis,
  SessionDetail,
  SessionSummary,
  VideoSourcePlan,
  TranscriptToken
} from "@/lib/types";
import { shouldUseSupabaseSessionStore } from "@/lib/supabase/config";
import {
  createSupabaseSession,
  deleteSupabaseSession,
  getSupabaseSessionAnalysis,
  getSupabaseSessionAsset,
  getSupabaseSessionAudio,
  getSupabaseSessionDetail,
  getSupabaseSessionVideoSourcePlan,
  listSupabaseRecentSessions,
  markSupabaseSessionFailed,
  markSupabaseSessionProcessing,
  saveSupabaseSessionAnalysis,
  saveSupabaseSessionAsset,
  saveSupabaseSessionImageEditHistoryItem,
  saveSupabaseSessionTranscript,
  saveSupabaseSessionUpload,
  saveSupabaseSessionVideoSourcePlan,
  getSupabaseSessionImageEditAsset,
  updateSupabaseSessionPreferences
} from "@/lib/supabase-session-store";
import { listLocalVideoJobs, listVideoJobs } from "@/lib/video-store";
import { listLocalWebsiteJobs, listWebsiteJobs } from "@/lib/website-store";
import { listLocalWorldJobs, listWorldJobs } from "@/lib/world-store";

const DATA_ROOT = path.resolve(process.env.SESSION_DATA_ROOT || path.join(process.cwd(), "data", "sessions"));
const INDEX_PATH = path.join(DATA_ROOT, "index.json");
const MAX_SESSIONS = 8;
const GALLERY_SESSION_LIMIT = 8;
const DEFAULT_ANALYSIS_REASONING_EFFORT: AnalysisReasoningEffort = "medium";
const DEFAULT_IMAGE_SIZE_PRESET: ImageSizePreset = "medium";
const DEFAULT_IMAGE_GENERATION_PROFILE: ImageGenerationProfile = "pro";
const DEFAULT_IMAGE_FOLLOW_MODE: ImageFollowMode = "auto";

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
  canvasImageLayers?: CanvasImageLayer[];
}

type StoredImageEditHistoryItem = Omit<ImageEditHistoryItem, "imageUrl" | "annotatedImageUrl"> & {
  imageFileName: string;
  annotatedImageFileName: string;
};

export interface SaveImageEditHistoryItemInput {
  sessionId: string;
  sourceAssetKind: AssetKind;
  transcriptText: string;
  targetDescription: string;
  requestedChange: string;
  editPrompt: string;
  editedImage: Buffer;
  annotatedImage: Buffer;
  annotation?: ImageEditAnnotation | null;
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
          : DEFAULT_IMAGE_GENERATION_PROFILE,
    imageFollowMode:
      summary.imageFollowMode === "loose" || summary.imageFollowMode === "close" || summary.imageFollowMode === "auto"
        ? summary.imageFollowMode
        : DEFAULT_IMAGE_FOLLOW_MODE
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

function getCanvasImageLayersPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "canvas-image-layers.json");
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

function getImageEditHistoryPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "image-edit-history.json");
}

function getImageEditsDir(sessionId: string) {
  return path.join(getSessionDir(sessionId), "image-edits");
}

function getImageEditAssetPath(sessionId: string, editId: string, assetName: "image" | "annotation") {
  const fileName = assetName === "image" ? `${editId}.png` : `${editId}-annotation.png`;
  return path.join(getImageEditsDir(sessionId), fileName);
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
    case "editedImage":
      return path.join(getSessionDir(sessionId), "edited-image.png");
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

function sortRecentSummaries<T extends { createdAt: string }>(summaries: T[]) {
  return [...summaries].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );
}

function mergeRecentSummaries(summaries: SessionSummary[]) {
  const byId = new Map<string, SessionSummary>();
  for (const summary of sortRecentSummaries(summaries)) {
    if (!byId.has(summary.id)) {
      byId.set(summary.id, summary);
    }
  }

  return Array.from(byId.values());
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

function imageEditAssetUrl(sessionId: string, editId: string, assetName: "image" | "annotation", version?: string) {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
  return `/api/sessions/${sessionId}/image-edits/${editId}/${assetName}${suffix}`;
}

function hydrateImageEditHistory(
  sessionId: string,
  items: StoredImageEditHistoryItem[],
  version?: string
): ImageEditHistoryItem[] {
  return items.map((item) => ({
    id: item.id,
    revisionNumber: item.revisionNumber,
    createdAt: item.createdAt,
    sourceAssetKind: item.sourceAssetKind,
    transcriptText: item.transcriptText,
    targetDescription: item.targetDescription,
    requestedChange: item.requestedChange,
    editPrompt: item.editPrompt,
    annotation: item.annotation ?? null,
    imageUrl: imageEditAssetUrl(sessionId, item.id, "image", version),
    annotatedImageUrl: imageEditAssetUrl(sessionId, item.id, "annotation", version)
  }));
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
  const worldJobs = await listLocalWorldJobs(sessionId);
  const videoJobs = await listLocalVideoJobs(sessionId);
  const websiteJobs = await listLocalWebsiteJobs(sessionId);
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

async function getLocalPreferredResultUrl(sessionId: string) {
  const worldJobs = await listLocalWorldJobs(sessionId);
  const videoJobs = await listLocalVideoJobs(sessionId);
  const websiteJobs = await listLocalWebsiteJobs(sessionId);
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
    imageFollowMode?: ImageFollowMode;
  },
  userId?: string
) {
  if (shouldUseSupabaseSessionStore()) {
    if (!userId) {
      throw new Error("Authenticated user is required before creating a session.");
    }

    return createSupabaseSession(userId, title, options);
  }

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
    imageFollowMode: options?.imageFollowMode ?? DEFAULT_IMAGE_FOLLOW_MODE,
    errorMessage: null
  };

  await upsertSummary(summary);
  await pruneSessions();
  return summary;
}

export async function listRecentSessions(userId?: string, limit = 24) {
  if (shouldUseSupabaseSessionStore()) {
    if (!userId) {
      return [];
    }

    return listSupabaseRecentSessions(userId, limit);
  }

  const summaries = await readIndex();
  return Promise.all(
    summaries.slice(0, limit).map(async (summary) => ({
      ...summary,
      preferredResultUrl: await getPreferredResultUrl(summary.id)
    }))
  );
}

export async function listLocalRecentSessions(limit = 24) {
  const summaries = await readIndex();
  return Promise.all(
    summaries.slice(0, limit).map(async (summary) => ({
      ...summary,
      preferredResultUrl: await getLocalPreferredResultUrl(summary.id)
    }))
  );
}

export async function listGallerySessions(userId?: string) {
  if (!shouldUseSupabaseSessionStore()) {
    return listRecentSessions(userId, GALLERY_SESSION_LIMIT);
  }

  const localSessions = await listLocalRecentSessions(GALLERY_SESSION_LIMIT);
  if (!userId) {
    return localSessions;
  }

  const cloudSessions = await listSupabaseRecentSessions(userId, GALLERY_SESSION_LIMIT);
  return mergeRecentSummaries([...cloudSessions, ...localSessions]).slice(0, GALLERY_SESSION_LIMIT);
}

export async function deleteSession(sessionId: string, userId?: string) {
  if (shouldUseSupabaseSessionStore()) {
    if (!userId) {
      throw new Error("Authenticated user is required before deleting a session.");
    }

    await deleteSupabaseSession(sessionId, userId);
    return;
  }

  const current = await readIndex();
  const existing = current.find((summary) => summary.id === sessionId);
  if (!existing) {
    return;
  }

  await rm(getSessionDir(sessionId), { recursive: true, force: true });
  await writeIndex(current.filter((summary) => summary.id !== sessionId));
}

export async function updateSessionPreferences(
  sessionId: string,
  preferences: {
    analysisReasoningEffort?: AnalysisReasoningEffort;
    imageSizePreset?: ImageSizePreset;
    imageGenerationProfile?: ImageGenerationProfile;
    imageFollowMode?: ImageFollowMode;
  }
) {
  if (shouldUseSupabaseSessionStore()) {
    return updateSupabaseSessionPreferences(sessionId, preferences);
  }

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
      preferences.imageGenerationProfile ?? summary.imageGenerationProfile,
    imageFollowMode: preferences.imageFollowMode ?? summary.imageFollowMode
  });

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function saveSessionUpload(sessionId: string, payload: UploadPayload) {
  if (shouldUseSupabaseSessionStore()) {
    return saveSupabaseSessionUpload(sessionId, payload);
  }

  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  const sessionDir = getSessionDir(sessionId);
  await mkdir(sessionDir, { recursive: true });

  const audioFilePath = path.join(sessionDir, `audio.${payload.audioExtension || inferAudioExtension(payload.audioMimeType)}`);
  await writeFile(audioFilePath, payload.audioBuffer);
  await writeJsonAtomic(getEventsPath(sessionId), payload.events);
  await writeJsonAtomic(getCanvasImageLayersPath(sessionId), payload.canvasImageLayers ?? []);
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
  if (shouldUseSupabaseSessionStore()) {
    return markSupabaseSessionProcessing(sessionId);
  }

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
  if (shouldUseSupabaseSessionStore()) {
    return saveSupabaseSessionTranscript(sessionId, tokens, approximate);
  }

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
  if (shouldUseSupabaseSessionStore()) {
    return saveSupabaseSessionAnalysis(sessionId, analysis);
  }

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
  if (shouldUseSupabaseSessionStore()) {
    return saveSupabaseSessionVideoSourcePlan(sessionId, plan);
  }

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
  if (shouldUseSupabaseSessionStore()) {
    return saveSupabaseSessionAsset(sessionId, assetKind, buffer);
  }

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

export async function saveSessionImageEditHistoryItem({
  sessionId,
  sourceAssetKind,
  transcriptText,
  targetDescription,
  requestedChange,
  editPrompt,
  editedImage,
  annotatedImage,
  annotation
}: SaveImageEditHistoryItemInput) {
  if (shouldUseSupabaseSessionStore()) {
    return saveSupabaseSessionImageEditHistoryItem({
      sessionId,
      sourceAssetKind,
      transcriptText,
      targetDescription,
      requestedChange,
      editPrompt,
      editedImage,
      annotatedImage,
      annotation
    });
  }

  const summary = await readMeta(sessionId);
  if (!summary) {
    throw new Error("Session not found");
  }

  const history = await readJsonFile<StoredImageEditHistoryItem[]>(getImageEditHistoryPath(sessionId), []);
  const revisionNumber = history.reduce((max, item) => Math.max(max, item.revisionNumber), 0) + 1;
  const editId = `edit-${String(revisionNumber).padStart(3, "0")}`;
  const imageFileName = `${editId}.png`;
  const annotatedImageFileName = `${editId}-annotation.png`;
  const createdAt = new Date().toISOString();

  await mkdir(getImageEditsDir(sessionId), { recursive: true });
  await Promise.all([
    writeFile(getImageEditAssetPath(sessionId, editId, "image"), editedImage),
    writeFile(getImageEditAssetPath(sessionId, editId, "annotation"), annotatedImage)
  ]);

  const nextHistory: StoredImageEditHistoryItem[] = [
    ...history,
    {
      id: editId,
      revisionNumber,
      createdAt,
      sourceAssetKind,
      transcriptText,
      targetDescription,
      requestedChange,
      editPrompt,
      annotation: annotation ?? null,
      imageFileName,
      annotatedImageFileName
    }
  ];
  await writeJsonAtomic(getImageEditHistoryPath(sessionId), nextHistory);

  const nextSummary: SessionSummary = {
    ...summary,
    updatedAt: createdAt,
    errorMessage: null
  };

  await upsertSummary(nextSummary);
  return nextSummary;
}

export async function markSessionFailed(sessionId: string, error: string) {
  if (shouldUseSupabaseSessionStore()) {
    return markSupabaseSessionFailed(sessionId, error);
  }

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

export async function getSessionDetail(sessionId: string, userId?: string): Promise<SessionDetail | null> {
  if (shouldUseSupabaseSessionStore()) {
    return getSupabaseSessionDetail(sessionId, userId);
  }

  const summary = await readMeta(sessionId);
  if (!summary) {
    return null;
  }

  const events = await readJsonFile<DrawingEvent[]>(getEventsPath(sessionId), []);
  const canvasImageLayers = await readJsonFile<CanvasImageLayer[]>(getCanvasImageLayersPath(sessionId), []);
  const transcript = await readJsonFile<TranscriptToken[]>(getTranscriptPath(sessionId), []);
  const analysis = await readJsonFile<SceneAnalysis | null>(getAnalysisPath(sessionId), null);
  const imageEditHistory = hydrateImageEditHistory(
    sessionId,
    await readJsonFile<StoredImageEditHistoryItem[]>(getImageEditHistoryPath(sessionId), []),
    summary.updatedAt
  );
  const worldJobs = await listLocalWorldJobs(sessionId);
  const videoJobs = await listLocalVideoJobs(sessionId);
  const websiteJobs = await listLocalWebsiteJobs(sessionId);

  const sessionDir = getSessionDir(sessionId);
  const files = await readdir(sessionDir);
  const audioFile = files.find((fileName) => fileName.startsWith("audio."));
  const sketchExists = files.includes("sketch.png");
  const annotatedSketchExists = files.includes("annotated-sketch.png");
  const videoAnnotatedSketchExists = files.includes("video-annotated-sketch.png");
  const generatedImageLabeledExists = files.includes("generated-image-labeled.png");
  const generatedImagePlainExists = files.includes("generated-image-plain.png");
  const generatedVideoSourceImageExists = files.includes("generated-video-source-image.png");
  const editedImageExists = files.includes("edited-image.png");
  const generatedImageExists = files.includes("generated-image.png");
  const generatedImageUrl = generatedImageLabeledExists
    ? `/api/sessions/${sessionId}/assets/generatedImageLabeled`
    : generatedImageExists
      ? `/api/sessions/${sessionId}/assets/generatedImage`
      : null;

  return {
    ...summary,
    events,
    canvasImageLayers,
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
    editedImageUrl: editedImageExists
      ? `/api/sessions/${sessionId}/assets/editedImage?v=${encodeURIComponent(summary.updatedAt)}`
      : null,
    imageEditHistory,
    analysis,
    worldJobs,
    videoJobs,
    websiteJobs
  };
}

export async function getReadableSessionDetail(sessionId: string, userId?: string): Promise<SessionDetail | null> {
  if (!shouldUseSupabaseSessionStore()) {
    return getSessionDetail(sessionId, userId);
  }

  if (userId) {
    const cloudSession = await getSupabaseSessionDetail(sessionId, userId);
    if (cloudSession) {
      return cloudSession;
    }
  }

  const summary = await readMeta(sessionId);
  if (!summary) {
    return null;
  }

  const events = await readJsonFile<DrawingEvent[]>(getEventsPath(sessionId), []);
  const canvasImageLayers = await readJsonFile<CanvasImageLayer[]>(getCanvasImageLayersPath(sessionId), []);
  const transcript = await readJsonFile<TranscriptToken[]>(getTranscriptPath(sessionId), []);
  const analysis = await readJsonFile<SceneAnalysis | null>(getAnalysisPath(sessionId), null);
  const imageEditHistory = hydrateImageEditHistory(
    sessionId,
    await readJsonFile<StoredImageEditHistoryItem[]>(getImageEditHistoryPath(sessionId), []),
    summary.updatedAt
  );
  const worldJobs = await listLocalWorldJobs(sessionId);
  const videoJobs = await listLocalVideoJobs(sessionId);
  const websiteJobs = await listLocalWebsiteJobs(sessionId);

  const sessionDir = getSessionDir(sessionId);
  const files = await readdir(sessionDir);
  const audioFile = files.find((fileName) => fileName.startsWith("audio."));
  const sketchExists = files.includes("sketch.png");
  const annotatedSketchExists = files.includes("annotated-sketch.png");
  const videoAnnotatedSketchExists = files.includes("video-annotated-sketch.png");
  const generatedImageLabeledExists = files.includes("generated-image-labeled.png");
  const generatedImagePlainExists = files.includes("generated-image-plain.png");
  const generatedVideoSourceImageExists = files.includes("generated-video-source-image.png");
  const editedImageExists = files.includes("edited-image.png");
  const generatedImageExists = files.includes("generated-image.png");
  const generatedImageUrl = generatedImageLabeledExists
    ? `/api/sessions/${sessionId}/assets/generatedImageLabeled`
    : generatedImageExists
      ? `/api/sessions/${sessionId}/assets/generatedImage`
      : null;

  return {
    ...summary,
    events,
    canvasImageLayers,
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
    editedImageUrl: editedImageExists
      ? `/api/sessions/${sessionId}/assets/editedImage?v=${encodeURIComponent(summary.updatedAt)}`
      : null,
    imageEditHistory,
    analysis,
    worldJobs,
    videoJobs,
    websiteJobs
  };
}

export async function getSessionAudio(sessionId: string) {
  if (shouldUseSupabaseSessionStore()) {
    return getSupabaseSessionAudio(sessionId);
  }

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

export async function getReadableSessionAudio(sessionId: string, userId?: string) {
  if (!shouldUseSupabaseSessionStore()) {
    return getSessionAudio(sessionId);
  }

  if (userId) {
    const cloudAudio = await getSupabaseSessionAudio(sessionId);
    if (cloudAudio) {
      return cloudAudio;
    }
  }

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
  if (shouldUseSupabaseSessionStore()) {
    return getSupabaseSessionAnalysis(sessionId);
  }

  return readJsonFile<SceneAnalysis | null>(getAnalysisPath(sessionId), null);
}

export async function getSessionVideoSourcePlan(sessionId: string) {
  if (shouldUseSupabaseSessionStore()) {
    return getSupabaseSessionVideoSourcePlan(sessionId);
  }

  return readJsonFile<VideoSourcePlan | null>(getVideoSourcePlanPath(sessionId), null);
}

export async function getSessionAsset(sessionId: string, assetKind: AssetKind) {
  if (shouldUseSupabaseSessionStore()) {
    return getSupabaseSessionAsset(sessionId, assetKind);
  }

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

export async function getSessionImageEditAsset(
  sessionId: string,
  editId: string,
  assetName: "image" | "annotation"
) {
  if (shouldUseSupabaseSessionStore()) {
    return getSupabaseSessionImageEditAsset(sessionId, editId, assetName);
  }

  const filePath = getImageEditAssetPath(sessionId, editId, assetName);

  try {
    return {
      buffer: await readFile(filePath),
      fileName: path.basename(filePath),
      mimeType: "image/png"
    };
  } catch {
    return null;
  }
}

export async function getReadableSessionAsset(sessionId: string, assetKind: AssetKind, userId?: string) {
  if (!shouldUseSupabaseSessionStore()) {
    return getSessionAsset(sessionId, assetKind);
  }

  if (userId) {
    const cloudAsset = await getSupabaseSessionAsset(sessionId, assetKind);
    if (cloudAsset) {
      return cloudAsset;
    }
  }

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

export async function getReadableSessionImageEditAsset(
  sessionId: string,
  editId: string,
  assetName: "image" | "annotation",
  userId?: string
) {
  if (shouldUseSupabaseSessionStore() && userId) {
    const cloudAsset = await getSupabaseSessionImageEditAsset(sessionId, editId, assetName);
    if (cloudAsset) {
      return cloudAsset;
    }
  }

  const filePath = getImageEditAssetPath(sessionId, editId, assetName);
  try {
    return {
      buffer: await readFile(filePath),
      fileName: path.basename(filePath),
      mimeType: "image/png"
    };
  } catch {
    return null;
  }
}
