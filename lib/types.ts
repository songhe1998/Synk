export type SessionStatus = "created" | "uploaded" | "processing" | "ready" | "failed";

export type DrawingTool = "pen" | "eraser";
export type TokenGranularity = "word" | "char" | "punctuation";
export type AnalysisReasoningEffort = "low" | "medium" | "high";
export type ImageSizePreset = "small" | "medium" | "large";
export type ImageGenerationProfile = "pro" | "fast";
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
  videoUrl: string | null;
  errorMessage: string | null;
  statusDetail: string | null;
}
