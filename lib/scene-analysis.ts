import sharp from "sharp";
import { buildDrawingState } from "@/lib/drawing";
import { buildDisplayTranscript, matchEvidenceQuote } from "@/lib/transcript-format";
import {
  AnalysisReasoningEffort,
  BoundingBox,
  DrawingEvent,
  GlobalSceneInfo,
  GroundedSceneObject,
  ImageSizePreset,
  ImageGenerationSource,
  Point2D,
  SceneAnalysis,
  Stroke,
  StrokeCluster,
  TranscriptToken
} from "@/lib/types";

const SCENE_MODEL = process.env.OPENAI_SCENE_MODEL ?? "gpt-5.4";
const IMAGE_ORCHESTRATOR_MODEL = process.env.OPENAI_IMAGE_ORCHESTRATOR_MODEL ?? "gpt-5.4";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const SKETCH_BACKGROUND = "#fff8e6";

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
  leaderStart: Point2D;
  leaderEnd: Point2D;
}

interface LabelAnchorSelection {
  strokeId: string | null;
  bbox: BoundingBox | null;
  point: Point2D | null;
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

async function callResponsesApi(payload: object, apiKey: string) {
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Responses API failed: ${response.status} ${errorText}`);
  }

  return response.json();
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
- Put background, style, relationships, and story/mood into global_info.
- Write generation_prompt as a natural paragraph that will help an image model follow the sketch layout and labels closely.
`.trim();

export async function extractSceneFromTranscript(
  transcriptText: string,
  apiKey: string,
  reasoningEffort: AnalysisReasoningEffort
) {
  const payload = await callResponsesApi(
    {
      model: SCENE_MODEL,
      reasoning: {
        effort: reasoningEffort
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
    const closeInSpace = distance(cluster.centroid, primaryCluster.centroid) <= Math.max(260, primaryDiagonal * 1.15);
    const closeInTime = cluster.startMs >= primaryCluster.startMs - 1000 && cluster.endMs <= upperTimeBound;
    return closeInTime && (overlapArea > 0 || closeInSpace);
  });

  return [primaryCluster.id, ...additionalClusters.map((cluster) => cluster.id)];
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

export function groundSceneExtraction({
  transcript,
  events,
  extractionModel,
  extraction
}: {
  transcript: TranscriptToken[];
  events: DrawingEvent[];
  extractionModel: string;
  extraction: SceneExtractionPayload;
}): SceneAnalysis {
  const clusters = buildStrokeClusters(events);
  const strokeMetrics = buildStrokeMetricsFromEvents(events);

  const objects: GroundedSceneObject[] = extraction.objects.map((object, index) => {
    const evidenceMatches = object.evidence_quotes.map((quote) => matchEvidenceQuote(transcript, quote));
    const validEvidence = evidenceMatches.filter(
      (match) => match.startMs !== null && match.endMs !== null
    );
    const anchorStart = validEvidence.length > 0 ? Math.min(...validEvidence.map((match) => match.startMs ?? Infinity)) : null;
    const anchorEnd = validEvidence.length > 0 ? Math.max(...validEvidence.map((match) => match.endMs ?? 0)) : null;
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
      description: object.description.trim(),
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

  return {
    model: extractionModel,
    createdAt: new Date().toISOString(),
    transcriptText: buildDisplayTranscript(transcript),
    objects,
    globalInfo: extraction.global_info,
    generationPrompt: `${extraction.generation_prompt.trim()} Follow the provided labeled sketch closely. Treat each label tag as the identity of the nearby object and preserve the overall layout. The label tags, callout lines, and any sketch annotations are only guidance and must not appear in the final rendered image.`,
    notes: [
      `Scene understanding generated with ${extractionModel}.`,
      `Objects grounded against ${clusters.length} stroke clusters.`
    ]
  };
}

function estimateTagDimensions(tag: string) {
  const width =
    Array.from(tag).reduce((sum, char) => sum + (/[\u0000-\u00ff]/u.test(char) ? 8 : 14), 0) + 24;
  return {
    width,
    height: 32
  };
}

function layoutLabels(objects: GroundedSceneObject[], canvasWidth: number, canvasHeight: number) {
  const placed: LabelLayout[] = [];

  objects.forEach((object) => {
    const targetBbox = object.labelAnchorBbox ?? object.bbox;
    const targetPoint = object.labelAnchorPoint ?? object.centroid;

    if (!targetBbox || !targetPoint) {
      return;
    }

    const { width, height } = estimateTagDimensions(object.tag);
    const bbox = targetBbox;
    const center = targetPoint;
    const candidates: BoundingBox[] = [
      { x: center.x - width / 2, y: bbox.y - height - 18, width, height },
      { x: bbox.x + bbox.width + 18, y: center.y - height / 2, width, height },
      { x: bbox.x - width - 18, y: center.y - height / 2, width, height },
      { x: center.x - width / 2, y: bbox.y + bbox.height + 18, width, height }
    ];

    let bestCandidate = candidates[0];
    let bestPenalty = Number.POSITIVE_INFINITY;

    candidates.forEach((candidate) => {
      const clampedCandidate = {
        ...candidate,
        x: clamp(candidate.x, 8, Math.max(8, canvasWidth - candidate.width - 8)),
        y: clamp(candidate.y, 8, Math.max(8, canvasHeight - candidate.height - 8))
      };

      const outOfBoundsPenalty =
        Math.abs(clampedCandidate.x - candidate.x) + Math.abs(clampedCandidate.y - candidate.y);
      const overlapWithObject = bboxIntersectionArea(clampedCandidate, bbox);
      const overlapWithLabels = placed.reduce(
        (sum, item) => sum + bboxIntersectionArea(clampedCandidate, item.box),
        0
      );
      const distancePenalty = distance(
        bboxCenter(clampedCandidate),
        center
      );

      const penalty =
        outOfBoundsPenalty * 8 +
        overlapWithObject * 0.05 +
        overlapWithLabels * 0.25 +
        distancePenalty * 0.2;

      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestCandidate = clampedCandidate;
      }
    });

    placed.push({
      objectId: object.id,
      box: bestCandidate,
      leaderStart: bboxCenter(bestCandidate),
      leaderEnd: center
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
  const labelLayouts = layoutLabels(analysis.objects, canvasWidth, canvasHeight);
  const objectMap = new Map(analysis.objects.map((object) => [object.id, object]));

  const overlaySvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
      ${labelLayouts
        .map((layout) => {
          const object = objectMap.get(layout.objectId);
          if (!object) {
            return "";
          }
          return `
            <line x1="${layout.leaderStart.x}" y1="${layout.leaderStart.y}" x2="${layout.leaderEnd.x}" y2="${layout.leaderEnd.y}" stroke="#2f6a52" stroke-width="2" stroke-linecap="round" />
            <circle cx="${layout.leaderEnd.x}" cy="${layout.leaderEnd.y}" r="4" fill="#2f6a52" />
            <rect x="${layout.box.x}" y="${layout.box.y}" rx="14" ry="14" width="${layout.box.width}" height="${layout.box.height}" fill="rgba(255,255,255,0.92)" stroke="#2f6a52" stroke-width="2" />
            <text x="${layout.box.x + layout.box.width / 2}" y="${layout.box.y + 21}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#1f1f26">${escapeXml(object.tag)}</text>
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
  apiKey,
  width,
  height,
  source,
  imageSizePreset
}: {
  prompt: string;
  sketchImage: Buffer;
  apiKey: string;
  width: number;
  height: number;
  source: ImageGenerationSource;
  imageSizePreset: ImageSizePreset;
}) {
  const imageDataUrl = `data:image/png;base64,${sketchImage.toString("base64")}`;
  const sourceInstruction =
    source === "labeled"
      ? "Use the sketch lines and nearby labels only as layout and identity hints. Do not include any labels, text, dots, guide lines, or callout lines in the final image."
      : "Use the plain sketch lines and their relative positions as layout hints. There are no labels available, so infer object identity from the spoken prompt and the sketch geometry alone.";
  const payload = await callResponsesApi(
    {
      model: IMAGE_ORCHESTRATOR_MODEL,
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
            }
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          action: "edit",
          size: resolveImageToolSize(width, height, imageSizePreset),
          quality: "medium",
          input_fidelity: "high"
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
    model: IMAGE_ORCHESTRATOR_MODEL,
    buffer: Buffer.from(result, "base64")
  };
}
