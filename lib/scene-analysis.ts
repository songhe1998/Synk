import sharp from "sharp";
import { buildDrawingState } from "@/lib/drawing";
import { buildDisplayTranscript, matchEvidenceQuote } from "@/lib/transcript-format";
import {
  AnalysisReasoningEffort,
  BoundingBox,
  DrawingEvent,
  GlobalSceneInfo,
  GroundedSceneObject,
  ImageEditAnnotation,
  ImageFollowMode,
  ImageGenerationProfile,
  ImageSizePreset,
  ImageGenerationSource,
  Point2D,
  SceneAnalysis,
  Stroke,
  StrokeCluster,
  TranscriptEvidenceMatch,
  TranscriptToken
} from "@/lib/types";

const SCENE_MODEL = process.env.OPENAI_SCENE_MODEL ?? "gpt-5.4";
const FAST_SCENE_MODEL = process.env.OPENAI_FAST_SCENE_MODEL ?? "gpt-5.4-mini";
const IMAGE_ORCHESTRATOR_MODEL = process.env.OPENAI_IMAGE_ORCHESTRATOR_MODEL ?? "gpt-5.4";
const FAST_IMAGE_ORCHESTRATOR_MODEL =
  process.env.OPENAI_FAST_IMAGE_ORCHESTRATOR_MODEL ?? "gpt-5.4-mini";
const IMAGE_TOOL_MODEL = process.env.OPENAI_IMAGE_TOOL_MODEL ?? "gpt-image-2";
const FAST_IMAGE_TOOL_MODEL = process.env.OPENAI_FAST_IMAGE_TOOL_MODEL ?? "gpt-image-1-mini";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const RESPONSES_TIMEOUT_MS = Number(process.env.OPENAI_RESPONSES_TIMEOUT_MS ?? 120000);
const SKETCH_BACKGROUND = "#fff8e6";
const RESPONSES_MAX_ATTEMPTS = 3;
const SKETCH_LABEL_FONT_SIZE = 3.5;
const SKETCH_LABEL_HORIZONTAL_PADDING = 2.5;
const SKETCH_LABEL_HEIGHT = 7;
const SKETCH_LABEL_ASCII_CHAR_WIDTH = 1.9;
const SKETCH_LABEL_WIDE_CHAR_WIDTH = 3.25;
const SKETCH_LABEL_MARGIN = 2;
const SKETCH_LABEL_STROKE_WIDTH = 0.4;

interface ExtractedSceneObject {
  tag: string;
  label: string;
  description: string;
  evidence_quotes: string[];
}

interface SceneExtractionPayload {
  objects: ExtractedSceneObject[];
  global_info: GlobalSceneInfo;
  generation_prompt: string;
}

interface ImageEditPromptPayload {
  target_description: string;
  requested_change: string;
  edit_prompt: string;
}

interface ImageEditOperationPayload {
  operations: Array<{
    operation: string;
  }>;
}

interface InternalStrokeMetrics {
  stroke: Stroke;
  startMs: number;
  endMs: number;
  bbox: BoundingBox;
  centroid: Point2D;
  diagonal: number;
}

interface InternalCluster {
  id: string;
  strokes: InternalStrokeMetrics[];
  bbox: BoundingBox;
  centroid: Point2D;
  startMs: number;
  endMs: number;
}

interface LabelLayout {
  objectId: string;
  box: BoundingBox;
}

interface LabelAnchorSelection {
  strokeId: string | null;
  bbox: BoundingBox | null;
  point: Point2D | null;
}

interface GroundingSeedObject {
  tag: string;
  label: string;
  description?: string;
  evidence_quotes: string[];
}

interface GroundedLayoutObject {
  tag: string;
  label: string;
  bbox: BoundingBox;
  centroid: Point2D;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function bboxFromPoints(points: Point2D[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function bboxUnion(boxes: BoundingBox[]) {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function bboxCenter(bbox: BoundingBox): Point2D {
  return {
    x: bbox.x + bbox.width / 2,
    y: bbox.y + bbox.height / 2
  };
}

function distance(left: Point2D, right: Point2D) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function bboxIntersectionArea(left: BoundingBox, right: BoundingBox) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);

  if (x2 <= x1 || y2 <= y1) {
    return 0;
  }

  return (x2 - x1) * (y2 - y1);
}

function computeStrokeMetrics(stroke: Stroke): InternalStrokeMetrics {
  const points = stroke.points.map((point) => ({ x: point.x, y: point.y }));
  const bbox = bboxFromPoints(points);
  const centroid = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
  const startMs = stroke.points[0]?.tMs ?? 0;
  const endMs = stroke.points.at(-1)?.tMs ?? startMs;

  return {
    stroke,
    startMs,
    endMs,
    bbox,
    centroid,
    diagonal: Math.hypot(bbox.width, bbox.height)
  };
}

function buildClustersFromStrokes(strokes: Stroke[]): StrokeCluster[] {
  const metrics = strokes.map(computeStrokeMetrics).sort((left, right) => left.startMs - right.startMs);
  const clusters: InternalCluster[] = [];

  metrics.forEach((metric) => {
    let bestClusterIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    clusters.forEach((cluster, clusterIndex) => {
      const timeGap = Math.max(0, metric.startMs - cluster.endMs);
      if (timeGap > 2600) {
        return;
      }

      const overlapArea = bboxIntersectionArea(cluster.bbox, metric.bbox);
      const centroidDistance = distance(cluster.centroid, metric.centroid);
      const distanceLimit = Math.max(220, Math.max(metric.diagonal, Math.hypot(cluster.bbox.width, cluster.bbox.height)));
      const temporalScore = 2.5 - timeGap / 900;
      const overlapScore = overlapArea > 0 ? 3 + overlapArea / Math.max(1, metric.bbox.width * metric.bbox.height) : 0;
      const spatialScore = centroidDistance < distanceLimit ? 2.2 - centroidDistance / distanceLimit : -0.4;
      const totalScore = temporalScore + overlapScore + spatialScore;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestClusterIndex = clusterIndex;
      }
    });

    if (bestClusterIndex < 0 || bestScore < 1.25) {
      clusters.push({
        id: `cluster_${clusters.length + 1}`,
        strokes: [metric],
        bbox: metric.bbox,
        centroid: metric.centroid,
        startMs: metric.startMs,
        endMs: metric.endMs
      });
      return;
    }

    const bestCluster = clusters[bestClusterIndex];
    bestCluster.strokes.push(metric);
    bestCluster.bbox = bboxUnion([...bestCluster.strokes.map((item) => item.bbox)]);
    bestCluster.centroid = bboxCenter(bestCluster.bbox);
    bestCluster.startMs = Math.min(bestCluster.startMs, metric.startMs);
    bestCluster.endMs = Math.max(bestCluster.endMs, metric.endMs);
  });

  return clusters.map((cluster) => ({
    id: cluster.id,
    strokeIds: cluster.strokes.map((metric) => metric.stroke.id),
    bbox: cluster.bbox,
    centroid: cluster.centroid,
    startMs: cluster.startMs,
    endMs: cluster.endMs
  }));
}

export function buildStrokeClusters(events: DrawingEvent[]) {
  const drawingState = buildDrawingState(events);
  return buildClustersFromStrokes(drawingState.strokes);
}

function buildStrokeMetricsFromEvents(events: DrawingEvent[]) {
  const drawingState = buildDrawingState(events);
  return drawingState.strokes.map(computeStrokeMetrics).sort((left, right) => left.startMs - right.startMs);
}

function inferLandscapeSize(width: number, height: number) {
  if (width > height) {
    return "1536x1024";
  }
  if (height > width) {
    return "1024x1536";
  }
  return "1024x1024";
}

function resolveImageToolSize(width: number, height: number, preset: ImageSizePreset) {
  if (preset === "small") {
    return "1024x1024";
  }

  if (preset === "large") {
    return "auto";
  }

  return inferLandscapeSize(width, height);
}

function resolveFastImageSize() {
  return "1024x1024";
}

function supportsInputFidelity(model: string) {
  return !model.startsWith("gpt-image-2");
}

function imageBufferToDataUrl(buffer: Buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function buildImageSourceInstruction(
  source: ImageGenerationSource,
  profile: ImageGenerationProfile,
  followMode: ImageFollowMode
) {
  const renderGuardrail =
    profile === "fast"
      ? "Render a finished scene, not a sketch, line drawing, diagram, blueprint, or storyboard frame. Do not preserve hand-drawn outlines."
      : "";

  const identityIntro =
    source === "labeled"
      ? "Use the sketch lines and nearby labels as identity and composition guidance."
      : "Use the plain sketch lines and their relative positions as composition guidance. There are no labels available, so infer object identity from the spoken prompt and the sketch geometry alone.";

  const followInstruction =
    followMode === "loose"
      ? [
          "Preserve the subject's overall footprint in the frame, approximate placement, relative scale, overlap, depth ordering, and framing.",
          "Do not trace literal contours or silhouette edges unless the transcript explicitly demands exact geometry.",
          "Treat primitive circles, ovals, rectangles, arrows, and blobs as loose placeholders, and resolve the intended objects into natural final forms."
        ].join(" ")
      : followMode === "close"
        ? [
            "Preserve the subject's overall footprint in the frame, approximate placement, relative scale, overlap, depth ordering, and framing.",
            "Trace the literal contours, silhouette direction, and connector geometry more closely than usual.",
            "For primitive circles, ovals, rectangles, arrows, and blobs, keep the final object's shape boundary close to the drawn boundary unless that would directly conflict with the transcript.",
            "Keep geometric, symbolic, diagrammatic, interface-like, and map-like elements tightly aligned to the sketch."
          ].join(" ")
        : [
            "Treat the sketch as a spatial layout map. The relative position relationships are hard constraints and must be followed.",
            "Use judgment for shape adherence: copy a stroke's literal shape only when the shape itself appears intentional or semantically important; otherwise transform rough strokes into natural final forms.",
            "Preserve which objects are left, right, above, below, centered, near, far, separated, overlapping, in front, behind, across from each other, or on opposite sides of paths/rivers/roads.",
            "Preserve approximate object centers, bounding boxes, relative scale, spacing, depth ordering, framing, and the overall route or direction of major paths, rivers, roads, arrows, and dividers.",
            "Do not relocate objects into a more conventional composition if that contradicts the sketch layout, even when the transcript describes a familiar scene.",
            "For natural objects, do not trace literal contours unless they are clearly intentional final shapes.",
            "If a rough circle, oval, rectangle, arrow, or blob appears to be placeholder blocking for an intended object, render the intended object naturally rather than preserving primitive geometry.",
            "Only follow the sketch shape strictly when the scene is clearly geometric, symbolic, diagrammatic, logo-like, interface-like, map-like, or when the transcript explicitly asks for precise shapes."
          ].join(" ");

  return `${renderGuardrail} ${identityIntro} ${followInstruction} Do not include any labels, text, dots, guide lines, or callout lines in the final image.`.trim();
}

function isRetryableResponsesError(message: string) {
  return (
    message.includes("timed out") ||
    message.includes("abort") ||
    message.includes("econnreset") ||
    message.includes("fetch failed") ||
    message.includes("connection termination") ||
    message.includes("upstream connect error") ||
    message.includes("reset") ||
    message.includes("network")
  );
}

async function waitBeforeRetry(attempt: number) {
  await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
}

async function callResponsesApi(payload: object, apiKey: string) {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RESPONSES_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Responses API timed out after ${RESPONSES_TIMEOUT_MS}ms`)),
      RESPONSES_TIMEOUT_MS
    );

    try {
      const response = await fetch(RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`OpenAI Responses API failed: ${response.status} ${errorText}`);
        const retryable =
          response.status === 429 ||
          response.status >= 500 ||
          isRetryableResponsesError(error.message.toLowerCase());
        if (!retryable || attempt === RESPONSES_MAX_ATTEMPTS) {
          throw error;
        }
        lastError = error;
      } else {
        return response.json();
      }
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const retryable = isRetryableResponsesError(message);
      if (!retryable || attempt === RESPONSES_MAX_ATTEMPTS) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await waitBeforeRetry(attempt);
  }

  throw lastError ?? new Error("OpenAI Responses API failed without a response.");
}

function extractOutputText(payload: any) {
  const message = payload?.output?.find((item: any) => item.type === "message");
  const textPart = message?.content?.find((part: any) => part.type === "output_text");
  if (typeof textPart?.text !== "string" || !textPart.text.trim()) {
    throw new Error("Responses API returned no text payload.");
  }
  return textPart.text;
}

const SCENE_ANALYSIS_PROMPT = `
You analyze the full spoken narration from a drawing session and prepare it for image generation.

Rules:
- Use the transcript as the only source of truth.
- Extract the final intended visible scene, not placeholder sketch geometry. If the user says a circle becomes a sun, the object is a sun.
- Each object must include 1 to 3 short evidence quotes copied verbatim from the transcript.
- Evidence quotes must be exact substrings from the transcript, in the original language, not paraphrases.
- Prefer evidence quotes that name or describe the final semantic object. Avoid using placeholder geometry phrases like "a circle" as the main evidence unless they are part of an explicit transformation into the final object.
- Do not invent objects that are not stated or strongly implied.
- If the user corrects themselves, use the last clear correction as final.
- Keep object descriptions natural and concise.
- Keep object tags short enough to draw on the sketch. Use spatial disambiguation only when needed, for example "left apple".
- Put background, style, relationships, and story/mood into global_info. In relationships, explicitly name the relative layout between extracted objects whenever the transcript provides or strongly implies it, using concrete terms such as left of, right of, above, below, in front of, behind, near, far, across from, and on the opposite side of.
- Infer the intended visual style from the transcript itself. Use explicit style requests when they exist, and otherwise infer a fitting finished-image style from the user's wording, mood, subject matter, and descriptive cues.
- If the transcript does not provide meaningful style cues, keep the style natural and neutral rather than forcing a named style.
- Write generation_prompt as a natural paragraph for a finished image that describes the intended visible scene, composition, relationships, atmosphere, and framing.
- The generation_prompt must make the relative position of every extracted object clear. Avoid vague "include X" phrasing when there are multiple objects; say where each object sits relative to the others, for example "the moon above the skyline", "the mall across the river from the buildings", or "the river between the buildings and the mall".
- Do not mention sketch lines, labels, callouts, or placeholder geometry in generation_prompt unless they are truly meant to appear in the final image.
- If spoken geometry is only a placeholder for a semantic object, describe the semantic object instead of the placeholder shape.
- The prompt should describe the intended final image style, whether explicitly requested or reasonably inferred from the transcript.
`.trim();

export async function extractSceneFromTranscript(
  transcriptText: string,
  apiKey: string,
  reasoningEffort: AnalysisReasoningEffort,
  profile: ImageGenerationProfile = "pro"
) {
  const payload = await callResponsesApi(
    {
      model: profile === "fast" ? FAST_SCENE_MODEL : SCENE_MODEL,
      reasoning: {
        effort: profile === "fast" ? "low" : reasoningEffort
      },
      store: false,
      instructions: SCENE_ANALYSIS_PROMPT,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Transcript:\n${transcriptText}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "scene_understanding",
          strict: true,
          schema: {
            type: "object",
            properties: {
              objects: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tag: { type: "string" },
                    label: { type: "string" },
                    description: { type: "string" },
                    evidence_quotes: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["tag", "label", "description", "evidence_quotes"],
                  additionalProperties: false
                }
              },
              global_info: {
                type: "object",
                properties: {
                  background: { type: "string" },
                  style: { type: "string" },
                  relationships: { type: "string" },
                  story: { type: "string" },
                  extra: { type: "string" }
                },
                required: ["background", "style", "relationships", "story", "extra"],
                additionalProperties: false
              },
              generation_prompt: { type: "string" }
            },
            required: ["objects", "global_info", "generation_prompt"],
            additionalProperties: false
          }
        }
      }
    },
    apiKey
  );

  return {
    model: payload.model as string,
    parsed: JSON.parse(extractOutputText(payload)) as SceneExtractionPayload
  };
}

function choosePrimaryCluster(clusters: StrokeCluster[], evidenceStartMs: number | null, evidenceEndMs: number | null) {
  if (clusters.length === 0) {
    return null;
  }

  if (evidenceStartMs === null || evidenceEndMs === null) {
    return clusters.at(-1) ?? null;
  }

  let bestCluster: StrokeCluster | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  clusters.forEach((cluster) => {
    const anchorMs = (evidenceStartMs + evidenceEndMs) / 2;
    const clusterAnchor = cluster.endMs <= anchorMs ? cluster.endMs : cluster.startMs;
    const timeDistance = Math.abs(clusterAnchor - anchorMs);
    const overlapsEvidence =
      cluster.startMs <= evidenceEndMs + 1200 && cluster.endMs >= evidenceStartMs - 3200;
    const score = (overlapsEvidence ? 6 : 0) - timeDistance / 850;

    if (score > bestScore) {
      bestScore = score;
      bestCluster = cluster;
    }
  });

  return bestCluster;
}

function selectClusterIdsForObject(
  clusters: StrokeCluster[],
  primaryCluster: StrokeCluster | null,
  evidenceEndMs: number | null
) {
  if (!primaryCluster) {
    return [];
  }

  const primaryDiagonal = Math.hypot(primaryCluster.bbox.width, primaryCluster.bbox.height);
  const upperTimeBound = evidenceEndMs === null ? primaryCluster.endMs + 2600 : evidenceEndMs + 2600;

  const additionalClusters = clusters.filter((cluster) => {
    if (cluster.id === primaryCluster.id) {
      return false;
    }

    const overlapArea = bboxIntersectionArea(cluster.bbox, primaryCluster.bbox);
    const closeInSpace = distance(cluster.centroid, primaryCluster.centroid) <= Math.max(90, primaryDiagonal * 1.15);
    const closeInTime = cluster.startMs >= primaryCluster.startMs - 1000 && cluster.endMs <= upperTimeBound;
    return closeInTime && (overlapArea > 0 || closeInSpace);
  });

  return [primaryCluster.id, ...additionalClusters.map((cluster) => cluster.id)];
}

function chooseGroundingEvidenceMatch(evidenceMatches: TranscriptEvidenceMatch[]) {
  const validEvidence = evidenceMatches.filter(
    (
      match
    ): match is TranscriptEvidenceMatch & {
      startMs: number;
      endMs: number;
      startTokenIndex: number;
      endTokenIndex: number;
    } =>
      match.startMs !== null &&
      match.endMs !== null &&
      match.startTokenIndex !== null &&
      match.endTokenIndex !== null
  );

  if (validEvidence.length === 0) {
    return null;
  }

  return validEvidence.toSorted((left, right) => {
    const startDelta = left.startMs - right.startMs;
    if (startDelta !== 0) {
      return startDelta;
    }

    return left.endMs - left.startMs - (right.endMs - right.startMs);
  })[0];
}

function selectLabelAnchorFromEvidence(
  strokeMetrics: InternalStrokeMetrics[],
  evidenceStartMs: number | null,
  evidenceEndMs: number | null
): LabelAnchorSelection {
  if (strokeMetrics.length === 0) {
    return {
      strokeId: null,
      bbox: null,
      point: null
    };
  }

  if (evidenceStartMs === null || evidenceEndMs === null) {
    const fallback = strokeMetrics.at(-1) ?? null;
    return {
      strokeId: fallback?.stroke.id ?? null,
      bbox: fallback?.bbox ?? null,
      point: fallback?.centroid ?? null
    };
  }

  let bestMetric: InternalStrokeMetrics | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const metric of strokeMetrics) {
    const overlapsEvidenceWindow =
      metric.startMs <= evidenceEndMs + 180 && metric.endMs >= evidenceStartMs - 1200;
    const endsBeforeSentence = metric.endMs <= evidenceEndMs + 260;
    const endDistance = Math.abs(metric.endMs - evidenceEndMs);
    const startDistance = Math.abs(metric.startMs - evidenceEndMs);
    const score =
      (overlapsEvidenceWindow ? 8 : 0) +
      (endsBeforeSentence ? 2.5 : 0) -
      endDistance / 240 -
      startDistance / 1200;

    if (score > bestScore) {
      bestScore = score;
      bestMetric = metric;
    }
  }

  if (!bestMetric) {
    return {
      strokeId: null,
      bbox: null,
      point: null
    };
  }

  return {
    strokeId: bestMetric.stroke.id,
    bbox: bestMetric.bbox,
    point: bestMetric.centroid
  };
}

function formatObjectName(object: Pick<GroundedSceneObject, "label" | "tag">) {
  return (object.label || object.tag).trim();
}

function formatHorizontalPosition(x: number, width: number) {
  const ratio = width > 0 ? x / width : 0.5;
  if (ratio < 0.18) {
    return "far left";
  }
  if (ratio < 0.38) {
    return "left";
  }
  if (ratio > 0.82) {
    return "far right";
  }
  if (ratio > 0.62) {
    return "right";
  }
  return "center";
}

function formatVerticalPosition(y: number, height: number) {
  const ratio = height > 0 ? y / height : 0.5;
  if (ratio < 0.18) {
    return "top";
  }
  if (ratio < 0.38) {
    return "upper";
  }
  if (ratio > 0.82) {
    return "bottom";
  }
  if (ratio > 0.62) {
    return "lower";
  }
  return "middle";
}

function isPathLikeObjectName(name: string) {
  return /\b(river|road|path|route|street|line|divider|bridge|canal|stream|trail|riverbank)\b/iu.test(name);
}

function formatCompoundPosition(vertical: string, horizontal: string) {
  const normalizedHorizontal =
    horizontal === "far left" ? "left" : horizontal === "far right" ? "right" : horizontal;
  if (vertical === "top") {
    return `top-${normalizedHorizontal} corner`;
  }
  if (vertical === "bottom") {
    return `bottom-${normalizedHorizontal} corner`;
  }

  return `${vertical}-${normalizedHorizontal}`;
}

function describeFramePlacement(
  object: Pick<GroundedLayoutObject, "label" | "tag" | "bbox" | "centroid">,
  canvasWidth: number,
  canvasHeight: number
) {
  const name = formatObjectName(object);
  if (!name) {
    return null;
  }

  const horizontal = formatHorizontalPosition(object.centroid.x, canvasWidth);
  const vertical = formatVerticalPosition(object.centroid.y, canvasHeight);
  const widthRatio = canvasWidth > 0 ? object.bbox.width / canvasWidth : 0;
  const heightRatio = canvasHeight > 0 ? object.bbox.height / canvasHeight : 0;
  const pathLike = isPathLikeObjectName(name);

  if (pathLike && heightRatio >= 0.45 && widthRatio < 0.45) {
    return `${name} running from the upper ${horizontal} toward the lower ${horizontal}`;
  }

  if (pathLike && widthRatio >= 0.45 && heightRatio < 0.45) {
    return `${name} running across the ${vertical} ${horizontal}`;
  }

  if (vertical === "middle" && horizontal === "center") {
    return `${name} in the center`;
  }

  if (vertical === "middle") {
    return `${name} on the ${horizontal} side`;
  }

  if (horizontal === "center") {
    return `${name} in the ${vertical} center`;
  }

  return `${name} in the ${formatCompoundPosition(vertical, horizontal)}`;
}

function describePairRelationship(
  left: Pick<GroundedLayoutObject, "label" | "tag" | "centroid">,
  right: Pick<GroundedLayoutObject, "label" | "tag" | "centroid">,
  canvasWidth: number,
  canvasHeight: number
) {
  const leftName = formatObjectName(left);
  const rightName = formatObjectName(right);
  if (!leftName || !rightName) {
    return null;
  }

  const dx = (left.centroid.x - right.centroid.x) / Math.max(1, canvasWidth);
  const dy = (left.centroid.y - right.centroid.y) / Math.max(1, canvasHeight);
  const horizontal = Math.abs(dx) >= 0.16 ? (dx < 0 ? "left of" : "right of") : "";
  const vertical = Math.abs(dy) >= 0.16 ? (dy < 0 ? "above" : "below") : "";

  if (horizontal && vertical) {
    return `${leftName} ${vertical} and ${horizontal} ${rightName}`;
  }

  if (horizontal) {
    return `${leftName} ${horizontal} ${rightName}`;
  }

  if (vertical) {
    return `${leftName} ${vertical} ${rightName}`;
  }

  return null;
}

function joinNaturalList(items: string[]) {
  if (items.length <= 2) {
    return items.join(" and ");
  }

  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function getGroundedLayoutObject(object: GroundedSceneObject): GroundedLayoutObject | null {
  const bbox = object.labelAnchorBbox ?? object.bbox;
  const centroid = object.labelAnchorPoint ?? object.centroid;
  const label = formatObjectName(object);

  if (!bbox || !centroid || !label) {
    return null;
  }

  return {
    tag: object.tag,
    label: object.label,
    bbox,
    centroid
  };
}

function buildGroundedLayoutPrompt(
  objects: GroundedSceneObject[],
  canvasWidth?: number,
  canvasHeight?: number
) {
  const groundedObjects = objects
    .map(getGroundedLayoutObject)
    .filter((object): object is GroundedLayoutObject => Boolean(object));

  if (groundedObjects.length < 2) {
    return "";
  }

  const inferredWidth = Math.max(
    1,
    canvasWidth ?? Math.max(...groundedObjects.map((object) => object.bbox.x + object.bbox.width))
  );
  const inferredHeight = Math.max(
    1,
    canvasHeight ?? Math.max(...groundedObjects.map((object) => object.bbox.y + object.bbox.height))
  );
  const placements = groundedObjects
    .map((object) => describeFramePlacement(object, inferredWidth, inferredHeight))
    .filter((value): value is string => Boolean(value));
  const relationships: string[] = [];

  for (let leftIndex = 0; leftIndex < groundedObjects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < groundedObjects.length; rightIndex += 1) {
      const relationship = describePairRelationship(
        groundedObjects[leftIndex],
        groundedObjects[rightIndex],
        inferredWidth,
        inferredHeight
      );
      if (relationship) {
        relationships.push(relationship);
      }
    }
  }

  const parts = [`Follow this grounded sketch layout: place ${joinNaturalList(placements)}.`];
  const limitedRelationships = relationships.slice(0, 8);
  if (limitedRelationships.length > 0) {
    parts.push(`Keep ${joinNaturalList(limitedRelationships)}.`);
  }

  return parts.join(" ");
}

function appendGroundedLayoutToPrompt(
  prompt: string,
  objects: GroundedSceneObject[],
  canvasWidth?: number,
  canvasHeight?: number
) {
  const trimmedPrompt = prompt.trim();
  const layoutPrompt = buildGroundedLayoutPrompt(objects, canvasWidth, canvasHeight);
  if (!layoutPrompt) {
    return trimmedPrompt;
  }

  return `${trimmedPrompt.replace(/\s+$/u, "").replace(/[.。]*$/u, "")}. ${layoutPrompt}`;
}

export function groundSceneExtraction({
  transcript,
  events,
  extractionModel,
  extraction,
  canvasWidth,
  canvasHeight
}: {
  transcript: TranscriptToken[];
  events: DrawingEvent[];
  extractionModel: string;
  extraction: SceneExtractionPayload;
  canvasWidth?: number;
  canvasHeight?: number;
}): SceneAnalysis {
  const clusters = buildStrokeClusters(events);
  const objects = groundObjectsFromTranscriptAndEvents({
    transcript,
    events,
    objects: extraction.objects
  });

  return {
    model: extractionModel,
    createdAt: new Date().toISOString(),
    transcriptText: buildDisplayTranscript(transcript),
    objects,
    globalInfo: extraction.global_info,
    generationPrompt: appendGroundedLayoutToPrompt(
      extraction.generation_prompt,
      objects,
      canvasWidth,
      canvasHeight
    ),
    notes: [
      `Scene understanding generated with ${extractionModel}.`,
      `Objects grounded against ${clusters.length} stroke clusters.`
    ]
  };
}

export function groundObjectsFromTranscriptAndEvents({
  transcript,
  events,
  objects
}: {
  transcript: TranscriptToken[];
  events: DrawingEvent[];
  objects: GroundingSeedObject[];
}) {
  const clusters = buildStrokeClusters(events);
  const strokeMetrics = buildStrokeMetricsFromEvents(events);

  return objects.map((object, index) => {
    const evidenceMatches = object.evidence_quotes.map((quote) => matchEvidenceQuote(transcript, quote));
    const groundingEvidence = chooseGroundingEvidenceMatch(evidenceMatches);
    const anchorStart = groundingEvidence?.startMs ?? null;
    const anchorEnd = groundingEvidence?.endMs ?? null;
    const primaryCluster = choosePrimaryCluster(clusters, anchorStart, anchorEnd);
    const clusterIds = selectClusterIdsForObject(clusters, primaryCluster, anchorEnd);
    const matchedClusters = clusters.filter((cluster) => clusterIds.includes(cluster.id));
    const bbox = matchedClusters.length > 0 ? bboxUnion(matchedClusters.map((cluster) => cluster.bbox)) : null;
    const centroid = bbox ? bboxCenter(bbox) : null;
    const labelAnchor = selectLabelAnchorFromEvidence(strokeMetrics, anchorStart, anchorEnd);

    return {
      id: `object_${index + 1}`,
      tag: object.tag.trim(),
      label: object.label.trim(),
      description: object.description?.trim() || object.label.trim(),
      evidenceQuotes: object.evidence_quotes.map((quote) => quote.trim()).filter(Boolean),
      evidenceMatches,
      clusterIds,
      bbox,
      centroid,
      labelAnchorStrokeId: labelAnchor.strokeId,
      labelAnchorBbox: labelAnchor.bbox,
      labelAnchorPoint: labelAnchor.point
    };
  });
}

function getObjectLabelText(object: Pick<GroundedSceneObject, "label" | "tag">) {
  return object.label?.trim() || object.tag.trim();
}

function estimateTagDimensions(tag: string) {
  const width =
    Array.from(tag).reduce(
      (sum, char) => sum + (/[\u0000-\u00ff]/u.test(char) ? SKETCH_LABEL_ASCII_CHAR_WIDTH : SKETCH_LABEL_WIDE_CHAR_WIDTH),
      0
    ) +
    SKETCH_LABEL_HORIZONTAL_PADDING * 2;
  return {
    width: Math.max(6, width),
    height: SKETCH_LABEL_HEIGHT
  };
}

function layoutLabels(objects: GroundedSceneObject[], canvasWidth: number, canvasHeight: number) {
  const placed: LabelLayout[] = [];

  objects.forEach((object) => {
    const targetPoint = object.labelAnchorPoint ?? object.centroid;

    if (!targetPoint) {
      return;
    }

    const labelText = getObjectLabelText(object);
    const { width, height } = estimateTagDimensions(labelText);
    const center = targetPoint;
    const directBox = {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height
    };
    const clampedBox = {
      ...directBox,
      x: clamp(directBox.x, SKETCH_LABEL_MARGIN, Math.max(SKETCH_LABEL_MARGIN, canvasWidth - directBox.width - SKETCH_LABEL_MARGIN)),
      y: clamp(directBox.y, SKETCH_LABEL_MARGIN, Math.max(SKETCH_LABEL_MARGIN, canvasHeight - directBox.height - SKETCH_LABEL_MARGIN))
    };

    placed.push({
      objectId: object.id,
      box: clampedBox
    });
  });

  return placed;
}

function renderDrawingSvg(events: DrawingEvent[], width: number, height: number) {
  const drawingState = buildDrawingState(events);

  const paths = drawingState.strokes
    .filter((stroke) => stroke.points.length > 0)
    .map((stroke) => {
      const commands =
        stroke.points.length === 1
          ? `M ${stroke.points[0].x} ${stroke.points[0].y} L ${stroke.points[0].x + 0.01} ${stroke.points[0].y + 0.01}`
          : stroke.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
      const strokeColor = stroke.tool === "eraser" ? SKETCH_BACKGROUND : stroke.color;
      return `<path d="${commands}" fill="none" stroke="${strokeColor}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join("");

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="${SKETCH_BACKGROUND}" />
      ${paths}
    </svg>
  `.trim();
}

export async function renderSketchPng({
  events,
  width,
  height
}: {
  events: DrawingEvent[];
  width: number;
  height: number;
}) {
  return sharp(Buffer.from(renderDrawingSvg(events, width, height))).png().toBuffer();
}

export async function renderAnnotatedSketchPng({
  baseSketch,
  analysis,
  canvasWidth,
  canvasHeight
}: {
  baseSketch: Buffer;
  analysis: SceneAnalysis;
  canvasWidth: number;
  canvasHeight: number;
}) {
  return renderGroundedSketchPng({
    baseSketch,
    objects: analysis.objects,
    canvasWidth,
    canvasHeight
  });
}

export async function renderGroundedSketchPng({
  baseSketch,
  objects,
  canvasWidth,
  canvasHeight
}: {
  baseSketch: Buffer;
  objects: GroundedSceneObject[];
  canvasWidth: number;
  canvasHeight: number;
}) {
  const labelLayouts = layoutLabels(objects, canvasWidth, canvasHeight);
  const objectMap = new Map(objects.map((object) => [object.id, object]));

  const overlaySvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
      ${labelLayouts
        .map((layout) => {
          const object = objectMap.get(layout.objectId);
          if (!object) {
            return "";
          }
          const labelText = getObjectLabelText(object);
          return `
            <rect x="${layout.box.x}" y="${layout.box.y}" rx="2" ry="2" width="${layout.box.width}" height="${layout.box.height}" fill="rgba(255,255,255,0.88)" stroke="#2f6a52" stroke-width="${SKETCH_LABEL_STROKE_WIDTH}" />
            <text x="${layout.box.x + layout.box.width / 2}" y="${layout.box.y + 4.9}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${SKETCH_LABEL_FONT_SIZE}" font-weight="700" fill="#1f1f26">${escapeXml(labelText)}</text>
          `.trim();
        })
        .join("")}
    </svg>
  `.trim();

  return sharp(baseSketch)
    .composite([
      {
        input: Buffer.from(overlaySvg),
        top: 0,
        left: 0
      }
    ])
    .png()
    .toBuffer();
}

export async function generateImageFromSketch({
  prompt,
  sketchImage,
  referenceImages = [],
  apiKey,
  width,
  height,
  source,
  imageSizePreset,
  profile = "pro",
  imageFollowMode = "auto"
}: {
  prompt: string;
  sketchImage: Buffer;
  referenceImages?: Buffer[];
  apiKey: string;
  width: number;
  height: number;
  source: ImageGenerationSource;
  imageSizePreset: ImageSizePreset;
  profile?: ImageGenerationProfile;
  imageFollowMode?: ImageFollowMode;
}) {
  const imageToolModel = profile === "fast" ? FAST_IMAGE_TOOL_MODEL : IMAGE_TOOL_MODEL;
  const sourceInstruction = buildImageSourceInstruction(source, profile, imageFollowMode);
  const imageToolSize =
    profile === "fast" ? resolveFastImageSize() : resolveImageToolSize(width, height, imageSizePreset);
  const preparedSketch =
    profile === "fast"
      ? await sharp(sketchImage)
          .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer()
      : sketchImage;
  const imageDataUrl = `data:image/png;base64,${preparedSketch.toString("base64")}`;
  const referenceImageDataUrls = await Promise.all(
    referenceImages.slice(0, 8).map(async (referenceImage) => {
      const preparedReference =
        profile === "fast"
          ? await sharp(referenceImage)
              .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
              .png()
              .toBuffer()
          : await sharp(referenceImage)
              .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
              .png()
              .toBuffer();
      return `data:image/png;base64,${preparedReference.toString("base64")}`;
    })
  );
  const payload = await callResponsesApi(
    {
      model: profile === "fast" ? FAST_IMAGE_ORCHESTRATOR_MODEL : IMAGE_ORCHESTRATOR_MODEL,
      ...(profile === "fast"
        ? {
            reasoning: {
              effort: "low"
            }
          }
        : {}),
      store: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt.trim()} ${sourceInstruction}`
            },
            {
              type: "input_image",
              image_url: imageDataUrl
            },
            ...referenceImageDataUrls.map((imageUrl) => ({
              type: "input_image",
              image_url: imageUrl
            }))
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          model: imageToolModel,
          action: "edit",
          size: imageToolSize,
          quality: profile === "fast" ? "low" : "medium",
          ...(supportsInputFidelity(imageToolModel)
            ? {
                input_fidelity: profile === "fast" ? "low" : "high"
              }
            : {})
        }
      ],
      tool_choice: {
        type: "image_generation"
      }
    },
    apiKey
  );

  const imageCall = payload?.output?.find((item: any) => item.type === "image_generation_call");
  const result = imageCall?.result;
  if (typeof result !== "string" || !result) {
    throw new Error("Image generation returned no image payload.");
  }

  return {
    model: profile === "fast" ? FAST_IMAGE_ORCHESTRATOR_MODEL : IMAGE_ORCHESTRATOR_MODEL,
    buffer: Buffer.from(result, "base64")
  };
}

function markerColorName(color: string | null | undefined) {
  switch (color?.toLowerCase()) {
    case "#ff3b30":
    case "#d4423a":
    case "#ef4444":
      return "red";
    case "#007aff":
    case "#0a84ff":
    case "#2367d1":
    case "#3b82f6":
      return "blue";
    case "#34c759":
    case "#2f7d57":
    case "#22c55e":
      return "green";
    case "#ffcc00":
    case "#f59e0b":
      return "yellow";
    case "#af52de":
    case "#8b5cf6":
      return "purple";
    case "#ff9500":
    case "#f97316":
      return "orange";
    case "#ffffff":
      return "white";
    case "#000000":
      return "black";
    default:
      return color ?? "unknown";
  }
}

function sortedAnnotationStrokes(annotation: ImageEditAnnotation) {
  return annotation.strokes
    .map((stroke, index) => ({
      stroke,
      index,
      startMs: stroke.startMs ?? stroke.points[0]?.tMs ?? Number.POSITIVE_INFINITY
    }))
    .toSorted((left, right) => {
      const timeDelta = left.startMs - right.startMs;
      if (timeDelta !== 0) {
        return timeDelta;
      }
      return left.index - right.index;
    })
    .map((item) => item.stroke);
}

function formatImageEditAnnotation(annotation: ImageEditAnnotation) {
  const normalizedBbox = {
    x: annotation.viewportWidth ? annotation.bbox.x / annotation.viewportWidth : 0,
    y: annotation.viewportHeight ? annotation.bbox.y / annotation.viewportHeight : 0,
    width: annotation.viewportWidth ? annotation.bbox.width / annotation.viewportWidth : 0,
    height: annotation.viewportHeight ? annotation.bbox.height / annotation.viewportHeight : 0
  };

  const strokes = sortedAnnotationStrokes(annotation).map((stroke, index) => ({
    id: stroke.id || `stroke-${index + 1}`,
    color: stroke.color ?? null,
    colorName: markerColorName(stroke.color),
    startMs: stroke.startMs ?? stroke.points[0]?.tMs ?? null,
    endMs: stroke.endMs ?? stroke.points.at(-1)?.tMs ?? null,
    pointCount: stroke.points.length,
    bbox: bboxFromPoints(stroke.points),
    normalizedBbox: (() => {
      const bbox = bboxFromPoints(stroke.points);
      return {
        x: annotation.viewportWidth ? bbox.x / annotation.viewportWidth : 0,
        y: annotation.viewportHeight ? bbox.y / annotation.viewportHeight : 0,
        width: annotation.viewportWidth ? bbox.width / annotation.viewportWidth : 0,
        height: annotation.viewportHeight ? bbox.height / annotation.viewportHeight : 0
      };
    })()
  }));

  return JSON.stringify(
    {
      viewportWidth: annotation.viewportWidth,
      viewportHeight: annotation.viewportHeight,
      bbox: annotation.bbox,
      normalizedBbox,
      strokes
    },
    null,
    2
  );
}

function formatEditTranscriptTokens(tokens: TranscriptToken[] | null | undefined) {
  if (!tokens?.length) {
    return "[]";
  }

  return JSON.stringify(
    tokens.slice(0, 120).map((token) => ({
      text: token.text,
      startMs: token.startMs,
      endMs: token.endMs
    })),
    null,
    2
  );
}

function formatSceneObjectsForEdit(analysis: SceneAnalysis | null | undefined) {
  if (!analysis?.objects.length) {
    return "None recorded.";
  }

  return analysis.objects
    .slice(0, 16)
    .map((object) => {
      const bbox = object.bbox
        ? ` bbox=${JSON.stringify({
            x: Math.round(object.bbox.x),
            y: Math.round(object.bbox.y),
            width: Math.round(object.bbox.width),
            height: Math.round(object.bbox.height)
          })}`
        : "";
      return `- ${object.label || object.tag}: ${object.description}${bbox}`;
    })
    .join("\n");
}

const IMAGE_EDIT_PROMPT_INSTRUCTIONS = `
You extract edit operations from a spoken image edit request.

Inputs:
- The user's spoken edit request.
- Optional timing metadata for the spoken words and drawn strokes.

Rules:
- Output only the requested edit operation or operations.
- Do not resolve which stroke, marker color, or image object the operation applies to. The application will do that by matching operations to colored strokes.
- If there is one requested edit, return one operation.
- If there are multiple requested edits, return them in the same order the user said them.
- Each operation should be an imperative phrase that can be applied to a circled target, for example "make the circled object larger", "change the circled flower to blue", or "remove the circled leaf".
- Do not include marker colors unless the user explicitly says a color is the desired new object color.
- Return JSON only.
`.trim();

const IMAGE_EDIT_PROMPT_PREFIX = `
Edit the marked input image according to this marker-color-to-operation JSON.

The input image contains visible colored marker strokes. Each JSON key is a marker color. For each entry, find the object or region circled by the marker stroke of that color and apply exactly the operation in the value. Marker strokes are only targeting guides; they are not part of the original image and must not appear in the output.
`.trim();

const IMAGE_EDIT_PRESERVATION_SUFFIX = `
This is an image editing task, not a new image generation task. Preserve the original image exactly. The only allowed change is the user-specified edit to the explicitly referenced target object/region. All non-target areas must remain unchanged and visually identical to the input image. Do not alter any nearby objects, overlapping objects, background, lighting, shadows, perspective, framing, pose, or image style. Do not make creative improvements or global adjustments. Apply the minimum necessary edit and keep all untouched regions the same as the original.
`.trim();

function buildColorOperationMap(
  annotation: ImageEditAnnotation,
  operationPayload: ImageEditOperationPayload,
  transcriptText: string
) {
  const operations = operationPayload.operations
    .map((item) => item.operation.trim())
    .filter(Boolean);
  const fallbackOperation = operations[0] ?? transcriptText.trim();
  const mapping: Record<string, string> = {};

  sortedAnnotationStrokes(annotation).forEach((stroke, index) => {
    const colorName = markerColorName(stroke.color);
    const operation = operations[index] ?? fallbackOperation;
    if (!operation) {
      return;
    }
    mapping[colorName] = operation;
  });

  return mapping;
}

function buildColorOperationEditPrompt(colorOperationMap: Record<string, string>) {
  return [
    IMAGE_EDIT_PROMPT_PREFIX,
    "",
    "Marker-color-to-operation JSON:",
    JSON.stringify(colorOperationMap, null, 2),
    "",
    IMAGE_EDIT_PRESERVATION_SUFFIX
  ].join("\n");
}

export async function writeImageEditPrompt({
  transcriptText,
  transcriptTokens,
  annotation,
  apiKey,
  profile = "pro"
}: {
  currentImage: Buffer;
  annotatedImage: Buffer;
  transcriptText: string;
  transcriptTokens?: TranscriptToken[] | null;
  annotation: ImageEditAnnotation;
  analysis?: SceneAnalysis | null;
  apiKey: string;
  profile?: ImageGenerationProfile;
}) {
  const payload = await callResponsesApi(
    {
      model: profile === "fast" ? FAST_IMAGE_ORCHESTRATOR_MODEL : IMAGE_ORCHESTRATOR_MODEL,
      ...(profile === "fast"
        ? {
            reasoning: {
              effort: "low"
            }
          }
        : {}),
      store: false,
      instructions: IMAGE_EDIT_PROMPT_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Spoken edit request:",
                transcriptText.trim() || "(empty)",
                "",
                "Sketch mark geometry:",
                formatImageEditAnnotation(annotation),
                "",
                "Timed spoken tokens:",
                formatEditTranscriptTokens(transcriptTokens)
              ].join("\n")
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "image_edit_prompt",
          strict: true,
          schema: {
            type: "object",
            properties: {
              operations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    operation: { type: "string" }
                  },
                  required: ["operation"],
                  additionalProperties: false
                }
              }
            },
            required: ["operations"],
            additionalProperties: false
          }
        }
      }
    },
    apiKey
  );

  const operationPayload = JSON.parse(extractOutputText(payload)) as ImageEditOperationPayload;
  const colorOperationMap = buildColorOperationMap(annotation, operationPayload, transcriptText);
  const requestedChange = JSON.stringify(colorOperationMap, null, 2);

  return {
    target_description: `Colored marker targets: ${Object.keys(colorOperationMap).join(", ")}`,
    requested_change: requestedChange,
    edit_prompt: buildColorOperationEditPrompt(colorOperationMap)
  } satisfies ImageEditPromptPayload;
}

export async function generateEditedImageFromImage({
  prompt,
  image,
  apiKey,
  width,
  height,
  imageSizePreset,
  profile = "pro"
}: {
  prompt: string;
  image: Buffer;
  apiKey: string;
  width: number;
  height: number;
  imageSizePreset: ImageSizePreset;
  profile?: ImageGenerationProfile;
}) {
  const imageToolModel = profile === "fast" ? FAST_IMAGE_TOOL_MODEL : IMAGE_TOOL_MODEL;
  const imageToolSize =
    profile === "fast" ? resolveFastImageSize() : resolveImageToolSize(width, height, imageSizePreset);
  const preparedImage =
    profile === "fast"
      ? await sharp(image)
          .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer()
      : image;

  const payload = await callResponsesApi(
    {
      model: profile === "fast" ? FAST_IMAGE_ORCHESTRATOR_MODEL : IMAGE_ORCHESTRATOR_MODEL,
      ...(profile === "fast"
        ? {
            reasoning: {
              effort: "low"
            }
          }
        : {}),
      store: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                prompt.trim(),
                "Preserve all unmentioned people, objects, layout, composition, lighting, camera angle, and style unchanged.",
                "Use any visible colored marker strokes only as edit targeting guides; remove/ignore them in the final output.",
                "Do not include colored marker strokes, labels, arrows, circles, outlines, guide marks, or explanatory text."
              ].join(" ")
            },
            {
              type: "input_image",
              image_url: imageBufferToDataUrl(preparedImage)
            }
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          model: imageToolModel,
          action: "edit",
          size: imageToolSize,
          quality: profile === "fast" ? "low" : "medium",
          ...(supportsInputFidelity(imageToolModel)
            ? {
                input_fidelity: profile === "fast" ? "low" : "high"
              }
            : {})
        }
      ],
      tool_choice: {
        type: "image_generation"
      }
    },
    apiKey
  );

  const imageCall = payload?.output?.find((item: any) => item.type === "image_generation_call");
  const result = imageCall?.result;
  if (typeof result !== "string" || !result) {
    throw new Error("Image edit returned no image payload.");
  }

  return {
    model: profile === "fast" ? FAST_IMAGE_ORCHESTRATOR_MODEL : IMAGE_ORCHESTRATOR_MODEL,
    buffer: Buffer.from(result, "base64")
  };
}

export async function generateReferenceRestoredImage({
  prompt,
  currentImage,
  referenceImage,
  apiKey,
  width,
  height,
  imageSizePreset,
  profile = "pro"
}: {
  prompt: string;
  currentImage: Buffer;
  referenceImage: Buffer;
  apiKey: string;
  width: number;
  height: number;
  imageSizePreset: ImageSizePreset;
  profile?: ImageGenerationProfile;
}) {
  const imageToolModel = profile === "fast" ? FAST_IMAGE_TOOL_MODEL : IMAGE_TOOL_MODEL;
  const imageToolSize =
    profile === "fast" ? resolveFastImageSize() : resolveImageToolSize(width, height, imageSizePreset);
  const [preparedCurrentImage, preparedReferenceImage] = await Promise.all(
    [currentImage, referenceImage].map((image) =>
      profile === "fast"
        ? sharp(image).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer()
        : sharp(image).resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer()
    )
  );

  const payload = await callResponsesApi(
    {
      model: profile === "fast" ? FAST_IMAGE_ORCHESTRATOR_MODEL : IMAGE_ORCHESTRATOR_MODEL,
      ...(profile === "fast"
        ? {
            reasoning: {
              effort: "low"
            }
          }
        : {}),
      store: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt.trim()
            },
            {
              type: "input_image",
              image_url: imageBufferToDataUrl(preparedCurrentImage)
            },
            {
              type: "input_image",
              image_url: imageBufferToDataUrl(preparedReferenceImage)
            }
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          model: imageToolModel,
          action: "edit",
          size: imageToolSize,
          quality: profile === "fast" ? "low" : "medium",
          ...(supportsInputFidelity(imageToolModel)
            ? {
                input_fidelity: profile === "fast" ? "low" : "high"
              }
            : {})
        }
      ],
      tool_choice: {
        type: "image_generation"
      }
    },
    apiKey
  );

  const imageCall = payload?.output?.find((item: any) => item.type === "image_generation_call");
  const result = imageCall?.result;
  if (typeof result !== "string" || !result) {
    throw new Error("Reference restore returned no image payload.");
  }

  return {
    model: profile === "fast" ? FAST_IMAGE_ORCHESTRATOR_MODEL : IMAGE_ORCHESTRATOR_MODEL,
    buffer: Buffer.from(result, "base64")
  };
}
