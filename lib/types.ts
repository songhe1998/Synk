export type SessionStatus = "created" | "uploaded" | "processing" | "ready" | "failed";

export type DrawingTool = "pen" | "eraser";
export type TokenGranularity = "word" | "char" | "punctuation";
export type AssetKind =
  | "sketch"
  | "annotatedSketch"
  | "generatedImage"
  | "generatedImageLabeled"
  | "generatedImagePlain";
export type EvidenceMatchKind = "exact" | "punctuation_insensitive" | "missing";
export type ImageGenerationSource = "labeled" | "plain";

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
  errorMessage: string | null;
}

export interface SessionDetail extends SessionSummary {
  events: DrawingEvent[];
  transcript: TranscriptToken[];
  audioUrl: string | null;
  sketchUrl: string | null;
  annotatedSketchUrl: string | null;
  generatedImageUrl: string | null;
  generatedImageLabeledUrl: string | null;
  generatedImagePlainUrl: string | null;
  analysis: SceneAnalysis | null;
}

export interface TranscriptNormalizationResult {
  tokens: TranscriptToken[];
  approximate: boolean;
}
