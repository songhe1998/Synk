export type SessionStatus = "created" | "uploaded" | "processing" | "ready" | "failed";

export type DrawingTool = "pen" | "eraser";
export type TokenGranularity = "word" | "char" | "punctuation";
export type AnalysisReasoningEffort = "low" | "medium" | "high";
export type ImageSizePreset = "small" | "medium" | "large";
export type ImageGenerationProfile = "pro" | "fast";
export type ImageFollowMode = "auto" | "loose" | "close";
export type AssetKind =
  | "sketch"
  | "annotatedSketch"
  | "videoAnnotatedSketch"
  | "generatedImage"
  | "generatedImageLabeled"
  | "generatedImagePlain"
  | "generatedVideoSourceImage";
export type EvidenceMatchKind = "exact" | "punctuation_insensitive" | "missing";
export type ImageGenerationSource = "labeled" | "plain";
export type WorldJobStatus = "queued" | "running" | "succeeded" | "failed";
export type WorldModelPreset = "draft" | "hd";
export type WorldSourceAssetKind = "generatedImageLabeled" | "generatedImagePlain";
export type VideoJobStatus = "queued" | "uploading" | "running" | "succeeded" | "failed";
export type VideoModelPreset = "lite" | "quality";
export type VideoPipelineMode = "normal" | "dynamic";
export type VideoSourceAssetKind =
  | "generatedImageLabeled"
  | "generatedImagePlain"
  | "generatedVideoSourceImage";
export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoAspectRatio = "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
export type WebsiteJobStatus = "queued" | "running" | "building" | "exporting" | "succeeded" | "failed";
export type WebsiteFramework = "vite-react" | "next-react";
export type WebsiteSandboxProvider = "vercel";
export type WebsiteArtifactKind = "previewImage" | "codeArchive" | "distArchive";
export type WebsiteSourceAssetKind = "annotatedSketch";
export type WebsiteJobKind = "initial" | "edit";
export type WebsiteGenerationProfile = "fast" | "econ";

export type DrawingEvent =
  | {
      type: "stroke_begin";
      strokeId: string;
      tool: DrawingTool;
      color: string;
      width: number;
      x: number;
      y: number;
      pressure: number;
      tMs: number;
    }
  | {
      type: "stroke_point";
      strokeId: string;
      x: number;
      y: number;
      pressure: number;
      tMs: number;
    }
  | {
      type: "stroke_end";
      strokeId: string;
      x: number;
      y: number;
      pressure: number;
      tMs: number;
    }
  | {
      type: "undo";
      tMs: number;
    }
  | {
      type: "redo";
      tMs: number;
    }
  | {
      type: "clear";
      tMs: number;
    };

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  tMs: number;
}

export interface Stroke {
  id: string;
  tool: DrawingTool;
  color: string;
  width: number;
  points: StrokePoint[];
}

export interface DrawingState {
  strokes: Stroke[];
  undoneStrokes: Stroke[];
}

export interface TranscriptToken {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  granularity: TokenGranularity;
  lang: string;
  approximate: boolean;
  confidence?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface TranscriptEvidenceMatch {
  quote: string;
  matchedText: string | null;
  startMs: number | null;
  endMs: number | null;
  startTokenIndex: number | null;
  endTokenIndex: number | null;
  matchKind: EvidenceMatchKind;
}

export interface StrokeCluster {
  id: string;
  strokeIds: string[];
  bbox: BoundingBox;
  centroid: Point2D;
  startMs: number;
  endMs: number;
}

export interface GroundedSceneObject {
  id: string;
  tag: string;
  label: string;
  description: string;
  evidenceQuotes: string[];
  evidenceMatches: TranscriptEvidenceMatch[];
  clusterIds: string[];
  bbox: BoundingBox | null;
  centroid: Point2D | null;
  labelAnchorStrokeId: string | null;
  labelAnchorBbox: BoundingBox | null;
  labelAnchorPoint: Point2D | null;
}

export interface GlobalSceneInfo {
  background: string;
  style: string;
  relationships: string;
  story: string;
  extra: string;
}

export interface SceneAnalysis {
  model: string;
  createdAt: string;
  transcriptText: string;
  objects: GroundedSceneObject[];
  globalInfo: GlobalSceneInfo;
  generationPrompt: string;
  notes: string[];
}

export interface VideoSourceSeedObject {
  tag: string;
  label: string;
  evidenceQuotes: string[];
}

export interface VideoSourcePlan {
  model: string;
  createdAt: string;
  transcriptText: string;
  objects: GroundedSceneObject[];
  sourceSeeds: VideoSourceSeedObject[];
  sourceImagePrompt: string;
  notes: string[];
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  audioMimeType: string | null;
  canvasWidth: number;
  canvasHeight: number;
  transcriptApproximate: boolean;
  analysisReasoningEffort: AnalysisReasoningEffort;
  imageSizePreset: ImageSizePreset;
  imageGenerationProfile: ImageGenerationProfile;
  imageFollowMode: ImageFollowMode;
  errorMessage: string | null;
  preferredResultUrl?: string | null;
}

export interface SessionDetail extends SessionSummary {
  events: DrawingEvent[];
  transcript: TranscriptToken[];
  audioUrl: string | null;
  sketchUrl: string | null;
  annotatedSketchUrl: string | null;
  videoAnnotatedSketchUrl: string | null;
  generatedImageUrl: string | null;
  generatedImageLabeledUrl: string | null;
  generatedImagePlainUrl: string | null;
  generatedVideoSourceImageUrl: string | null;
  analysis: SceneAnalysis | null;
  worldJobs: WorldJob[];
  videoJobs: VideoJob[];
  websiteJobs: WebsiteJob[];
}

export interface TranscriptNormalizationResult {
  tokens: TranscriptToken[];
  approximate: boolean;
}

export interface WorldAssetSnapshot {
  worldId: string;
  displayName: string;
  model: string | null;
  worldMarbleUrl: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  panoUrl: string | null;
  colliderMeshUrl: string | null;
  spz100kUrl: string | null;
  spz500kUrl: string | null;
  spzFullResUrl: string | null;
  groundPlaneOffset: number | null;
  metricScaleFactor: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorldJob {
  id: string;
  sessionId: string;
  status: WorldJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  displayName: string;
  modelPreset: WorldModelPreset;
  requestedModel: string;
  sourceAssetKind: WorldSourceAssetKind;
  sourceImageUrl: string | null;
  prompt: string;
  operationId: string | null;
  operationExpiresAt: string | null;
  worldId: string | null;
  errorMessage: string | null;
  statusDetail: string | null;
  world: WorldAssetSnapshot | null;
}

export interface VideoJob {
  id: string;
  sessionId: string;
  status: VideoJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  displayName: string;
  modelPreset: VideoModelPreset;
  pipelineMode: VideoPipelineMode;
  requestedModel: string;
  sourceAssetKind: VideoSourceAssetKind;
  sourceImageUrl: string | null;
  transcriptText: string | null;
  sourceImagePrompt: string | null;
  sourceImagePromptModel: string | null;
  prompt: string;
  promptModel: string | null;
  durationSeconds: number;
  resolution: VideoResolution | null;
  aspectRatio: VideoAspectRatio | null;
  cameraFixed: boolean | null;
  requestId: string | null;
  remoteSourceUrl: string | null;
  remoteVideoUrl: string | null;
  videoFileName: string | null;
  videoMimeType: string | null;
  videoStoragePath?: string | null;
  videoUrl: string | null;
  errorMessage: string | null;
  statusDetail: string | null;
}

export interface WebsitePageInput {
  id: string;
  title: string | null;
  path: string;
  sourceAssetKind: WebsiteSourceAssetKind;
  sketchUrl: string | null;
}

export interface WebsiteEditRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebsiteEditPoint {
  x: number;
  y: number;
  tMs?: number;
}

export interface WebsiteEditStroke {
  id: string;
  points: WebsiteEditPoint[];
  startMs?: number | null;
  endMs?: number | null;
}

export interface WebsiteEditAnnotation {
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  path: string;
  scrollX: number;
  scrollY: number;
  bbox: WebsiteEditRect;
  strokes: WebsiteEditStroke[];
}

export interface WebsiteEditDomCandidate {
  id: string;
  selector: string;
  tagName: string;
  role: string | null;
  text: string | null;
  ariaLabel: string | null;
  className: string | null;
  imageSrcs?: string[];
  imageAlts?: string[];
  rect: WebsiteEditRect;
}

export interface WebsiteEditTargetCandidate {
  id: string;
  selector: string;
  tagName: string;
  role: string | null;
  text: string | null;
  imageSrcs?: string[];
  imageAlts?: string[];
  rect: WebsiteEditRect;
  score: number;
  reason: string;
}

export type WebsiteEditIntentType =
  | "local_edit"
  | "bulk_style_change"
  | "swap_order"
  | "move_relative"
  | "copy_style"
  | "remove"
  | "emphasize"
  | "unknown";

export interface WebsiteEditMention {
  id: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  startChar: number;
  endChar: number;
  startTokenIndex?: number | null;
  endTokenIndex?: number | null;
  source?: "llm" | "rule";
  kind: "singular" | "plural";
  targetCount: number | null;
}

export interface WebsiteEditIntent {
  id: string;
  type: WebsiteEditIntentType;
  operation: string;
  targetMentionIds: string[];
  expectedTargetCount: number | null;
  confidence: number;
  reason: string;
}

export interface WebsiteEditResolvedTarget {
  id: string;
  strokeId: string;
  strokeIndex: number;
  mentionIds: string[];
  intentIds: string[];
  role: "target" | "moved_item" | "anchor" | "reference";
  targetElementId: string | null;
  targetSelector: string | null;
  targetDescription: string;
  confidence: number;
  candidates: WebsiteEditTargetCandidate[];
  bbox: WebsiteEditRect;
  reason: string;
}

export interface WebsiteEditMentionBinding {
  mentionId: string;
  strokeIds: string[];
  confidence: number;
  reason: string;
}

export interface WebsiteEditTargetResolution {
  targetElementId: string | null;
  targetSelector: string | null;
  targetDescription: string;
  confidence: number;
  reason: string;
  candidates: WebsiteEditTargetCandidate[];
  mode?: "single" | "multi";
  intentParser?: {
    source: "llm" | "rule" | "fallback";
    model: string | null;
    error: string | null;
  };
  annotation?: WebsiteEditAnnotation;
  mentions?: WebsiteEditMention[];
  mentionBindings?: WebsiteEditMentionBinding[];
  intents?: WebsiteEditIntent[];
  targets?: WebsiteEditResolvedTarget[];
}

export interface WebsiteJob {
  id: string;
  sessionId: string;
  parentJobId: string | null;
  revisionNumber: number;
  jobKind: WebsiteJobKind;
  generationProfile: WebsiteGenerationProfile;
  status: WebsiteJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  displayName: string;
  framework: WebsiteFramework;
  sandboxProvider: WebsiteSandboxProvider;
  sandboxId: string | null;
  transcriptText: string;
  pages: WebsitePageInput[];
  prompt: string;
  providerMetadata: Record<string, unknown> | null;
  editInstructionText: string | null;
  editTarget: WebsiteEditTargetResolution | null;
  statusDetail: string | null;
  errorMessage: string | null;
  previewImageUrl: string | null;
  codeArchiveUrl: string | null;
  distArchiveUrl: string | null;
  previewUrl: string | null;
  previewImageFileName: string | null;
  previewImageMimeType: string | null;
  codeArchiveFileName: string | null;
  codeArchiveMimeType: string | null;
  distArchiveFileName: string | null;
  distArchiveMimeType: string | null;
}
