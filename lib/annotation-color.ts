export interface AnnotationColorPoint {
  x: number;
  y: number;
}

export interface AnnotationColorStroke {
  id?: string;
  color?: string | null;
  points: AnnotationColorPoint[];
}

export interface AnnotationColorImageData {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface AnnotationColorCandidate {
  name: string;
  color: string;
}

export interface AnnotationColorScore {
  name: string;
  color: string;
  score: number;
  p10Visibility: number;
  medianVisibility: number;
  meanVisibility: number;
  visibleRatio: number;
  badSegmentRatio: number;
  rarityScore: number;
  longestBadSegmentRatio: number;
}

export interface AnnotationColorChoice {
  bestColor: string;
  ranking: AnnotationColorScore[];
  sampleCount: number;
  nearbySampleCount: number;
}

export interface AnnotationColorAssignment {
  strokeIndex: number;
  strokeId: string;
  color: string;
  name: string;
  previousColor: string | null;
  changed: boolean;
  localScore: AnnotationColorScore | null;
}

export interface AnnotationColorGlobalAssignment {
  assignments: AnnotationColorAssignment[];
  colorsByStrokeId: Record<string, string>;
  choices: AnnotationColorChoice[];
  score: number;
  localAverage: number;
  worstLocalScore: number;
  minPairDistance: number;
  averagePairDistance: number;
  duplicateCount: number;
  changedCount: number;
  evaluatedAssignments: number;
  searchMode: "exact" | "beam";
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Oklab {
  l: number;
  a: number;
  b: number;
}

interface PreparedColor extends AnnotationColorCandidate {
  rgb: Rgb;
  lab: Oklab;
  luminance: number;
}

interface PreparedSample {
  rgb: Rgb;
  lab: Oklab;
  luminance: number;
  bin: number;
}

export const DEFAULT_ANNOTATION_CANDIDATE_COLORS: AnnotationColorCandidate[] = [
  { name: "red", color: "#ff3b30" },
  { name: "yellow", color: "#ffcc00" },
  { name: "green", color: "#34c759" },
  { name: "blue", color: "#007aff" },
  { name: "white", color: "#ffffff" },
  { name: "black", color: "#000000" }
];

export const DEFAULT_ANNOTATION_COLOR = DEFAULT_ANNOTATION_CANDIDATE_COLORS[0].color;

const DEFAULT_VISIBILITY_THRESHOLD = 0.43;

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(color: string): Rgb | null {
  const normalized = color.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    return null;
  }

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function normalizeColor(color: string | null | undefined) {
  if (!color) {
    return null;
  }

  const rgb = parseHexColor(color);
  if (!rgb) {
    return null;
  }

  return `#${[rgb.r, rgb.g, rgb.b]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function srgbByteToLinear(value: number) {
  const normalized = clamp(value / 255);
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb) {
  const r = srgbByteToLinear(rgb.r);
  const g = srgbByteToLinear(rgb.g);
  const b = srgbByteToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToOklab(rgb: Rgb): Oklab {
  const r = srgbByteToLinear(rgb.r);
  const g = srgbByteToLinear(rgb.g);
  const b = srgbByteToLinear(rgb.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(Math.max(0, l));
  const mRoot = Math.cbrt(Math.max(0, m));
  const sRoot = Math.cbrt(Math.max(0, s));

  return {
    l: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
  };
}

function oklabDistance(left: Oklab, right: Oklab) {
  return Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b);
}

function percentile(values: number[], p: number) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }

  const fraction = index - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function mean(values: number[]) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function readRgb(imageData: AnnotationColorImageData, x: number, y: number): Rgb {
  const px = Math.max(0, Math.min(imageData.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(imageData.height - 1, Math.round(y)));
  const index = (py * imageData.width + px) * 4;
  const alpha = imageData.data[index + 3] ?? 255;
  const alphaRatio = clamp(alpha / 255);
  const r = imageData.data[index] ?? 255;
  const g = imageData.data[index + 1] ?? 255;
  const b = imageData.data[index + 2] ?? 255;

  if (alphaRatio >= 0.999) {
    return { r, g, b };
  }

  return {
    r: Math.round(r * alphaRatio + 255 * (1 - alphaRatio)),
    g: Math.round(g * alphaRatio + 255 * (1 - alphaRatio)),
    b: Math.round(b * alphaRatio + 255 * (1 - alphaRatio))
  };
}

function prepareSample(imageData: AnnotationColorImageData, x: number, y: number, bin: number): PreparedSample {
  const rgb = readRgb(imageData, x, y);
  return {
    rgb,
    lab: rgbToOklab(rgb),
    luminance: relativeLuminance(rgb),
    bin
  };
}

function buildPreparedColors(candidates: AnnotationColorCandidate[]) {
  return candidates
    .map((candidate): PreparedColor | null => {
      const rgb = parseHexColor(candidate.color);
      if (!rgb) {
        return null;
      }

      return {
        ...candidate,
        rgb,
        lab: rgbToOklab(rgb),
        luminance: relativeLuminance(rgb)
      };
    })
    .filter((candidate): candidate is PreparedColor => Boolean(candidate));
}

function getStrokeBounds(strokes: AnnotationColorStroke[]) {
  const points = strokes.flatMap((stroke) => stroke.points);
  if (!points.length) {
    return null;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  };
}

function isClosedPath(strokes: AnnotationColorStroke[], strokeWidth: number) {
  const firstStroke = strokes.find((stroke) => stroke.points.length > 0);
  const lastStroke = [...strokes].reverse().find((stroke) => stroke.points.length > 0);
  const first = firstStroke?.points[0];
  const last = lastStroke?.points.at(-1);
  if (!first || !last) {
    return false;
  }

  return Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(10, strokeWidth * 3);
}

function collectStrokeSamples(
  imageData: AnnotationColorImageData,
  strokes: AnnotationColorStroke[],
  strokeWidth: number,
  binCount: number,
  maxSamples: number
) {
  const segments: Array<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    length: number;
    normalX: number;
    normalY: number;
    offset: number;
  }> = [];
  let totalLength = 0;

  for (const stroke of strokes) {
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      segments.push({
        startX: point.x,
        startY: point.y,
        endX: point.x,
        endY: point.y,
        length: 1,
        normalX: 1,
        normalY: 0,
        offset: totalLength
      });
      totalLength += 1;
      continue;
    }

    for (let index = 1; index < stroke.points.length; index += 1) {
      const start = stroke.points[index - 1];
      const end = stroke.points[index];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.5) {
        continue;
      }

      segments.push({
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
        length,
        normalX: -dy / length,
        normalY: dx / length,
        offset: totalLength
      });
      totalLength += length;
    }
  }

  if (!segments.length) {
    return [];
  }

  const crossOffsets = [-strokeWidth * 0.42, 0, strokeWidth * 0.42];
  const maxCenterSamples = Math.max(24, Math.floor(maxSamples / crossOffsets.length));
  const sampleSpacing = Math.max(2, totalLength / maxCenterSamples);
  const samples: PreparedSample[] = [];

  for (const segment of segments) {
    const steps = Math.max(1, Math.ceil(segment.length / sampleSpacing));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const centerX = segment.startX + (segment.endX - segment.startX) * t;
      const centerY = segment.startY + (segment.endY - segment.startY) * t;
      const along = segment.offset + segment.length * t;
      const bin = Math.max(0, Math.min(binCount - 1, Math.floor((along / Math.max(1, totalLength)) * binCount)));

      for (const offset of crossOffsets) {
        const x = centerX + segment.normalX * offset;
        const y = centerY + segment.normalY * offset;
        if (x >= 0 && y >= 0 && x < imageData.width && y < imageData.height) {
          samples.push(prepareSample(imageData, x, y, bin));
        }
      }
    }
  }

  if (samples.length <= maxSamples) {
    return samples;
  }

  const sampled: PreparedSample[] = [];
  const step = samples.length / maxSamples;
  for (let index = 0; index < maxSamples; index += 1) {
    sampled.push(samples[Math.floor(index * step)]);
  }
  return sampled;
}

function collectNearbySamples(
  imageData: AnnotationColorImageData,
  strokes: AnnotationColorStroke[],
  strokeWidth: number,
  maxSamples: number
) {
  const bounds = getStrokeBounds(strokes);
  if (!bounds) {
    return [];
  }

  const padding = Math.max(12, strokeWidth * 4);
  const minX = Math.max(0, Math.floor(bounds.minX - padding));
  const minY = Math.max(0, Math.floor(bounds.minY - padding));
  const maxX = Math.min(imageData.width - 1, Math.ceil(bounds.maxX + padding));
  const maxY = Math.min(imageData.height - 1, Math.ceil(bounds.maxY + padding));
  const width = Math.max(1, maxX - minX + 1);
  const height = Math.max(1, maxY - minY + 1);
  const spacing = Math.max(3, Math.sqrt((width * height) / Math.max(1, maxSamples)));
  const samples: PreparedSample[] = [];

  for (let y = minY; y <= maxY; y += spacing) {
    for (let x = minX; x <= maxX; x += spacing) {
      samples.push(prepareSample(imageData, x, y, 0));
    }
  }

  if (samples.length <= maxSamples) {
    return samples;
  }

  const sampled: PreparedSample[] = [];
  const step = samples.length / maxSamples;
  for (let index = 0; index < maxSamples; index += 1) {
    sampled.push(samples[Math.floor(index * step)]);
  }
  return sampled;
}

function mixOverBackground(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  if (alpha >= 0.999) {
    return foreground;
  }

  return {
    r: Math.round(foreground.r * alpha + background.r * (1 - alpha)),
    g: Math.round(foreground.g * alpha + background.g * (1 - alpha)),
    b: Math.round(foreground.b * alpha + background.b * (1 - alpha))
  };
}

function visibilityForSample(color: PreparedColor, sample: PreparedSample, alpha: number) {
  const displayedRgb = mixOverBackground(color.rgb, sample.rgb, alpha);
  const displayedLuminance = alpha >= 0.999 ? color.luminance : relativeLuminance(displayedRgb);
  const displayedLab = alpha >= 0.999 ? color.lab : rgbToOklab(displayedRgb);
  const contrast =
    (Math.max(displayedLuminance, sample.luminance) + 0.05) /
    (Math.min(displayedLuminance, sample.luminance) + 0.05);
  const luminanceScore = clamp((contrast - 1) / 4);
  const colorDistanceScore = clamp(oklabDistance(displayedLab, sample.lab) / 0.34);
  return 0.62 * luminanceScore + 0.38 * colorDistanceScore;
}

function computeRarityScore(color: PreparedColor, nearbySamples: PreparedSample[]) {
  if (!nearbySamples.length) {
    return 0.5;
  }

  let closeCount = 0;
  for (const sample of nearbySamples) {
    if (oklabDistance(color.lab, sample.lab) < 0.11) {
      closeCount += 1;
    }
  }

  const closeRatio = closeCount / nearbySamples.length;
  return clamp(1 - closeRatio * 3);
}

function computeLongestBadSegmentRatio(binScores: number[], threshold: number, circular: boolean) {
  if (!binScores.length) {
    return 0;
  }

  const badBins = binScores.map((score) => score < threshold);
  if (circular) {
    let longest = 0;
    let current = 0;
    for (let index = 0; index < badBins.length * 2; index += 1) {
      if (badBins[index % badBins.length]) {
        current = Math.min(current + 1, badBins.length);
        longest = Math.max(longest, current);
      } else {
        current = 0;
      }
    }
    return longest / badBins.length;
  }

  let longest = 0;
  let current = 0;
  for (const isBad of badBins) {
    if (isBad) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest / badBins.length;
}

function computeStabilityPenalty({
  p10Visibility,
  badSegmentRatio,
  longestBadSegmentRatio
}: {
  p10Visibility: number;
  badSegmentRatio: number;
  longestBadSegmentRatio: number;
}) {
  let penalty = 0;

  if (p10Visibility < 0.24) {
    penalty += 0.18;
  } else if (p10Visibility < 0.34) {
    penalty += 0.08;
  }

  if (badSegmentRatio > 0.2) {
    penalty += 0.2;
  } else if (badSegmentRatio > 0.12) {
    penalty += 0.08;
  }

  if (longestBadSegmentRatio > 0.25) {
    penalty += 0.25;
  } else if (longestBadSegmentRatio > 0.16) {
    penalty += 0.12;
  }

  return penalty;
}

function computeColorDistance(left: PreparedColor, right: PreparedColor) {
  if (left.color.toLowerCase() === right.color.toLowerCase()) {
    return 0;
  }

  return clamp(oklabDistance(left.lab, right.lab) / 0.42);
}

function getStrokeGeometry(stroke: AnnotationColorStroke, fallbackIndex: number) {
  const bounds = getStrokeBounds([stroke]);
  if (!bounds) {
    return {
      id: stroke.id || `stroke-${fallbackIndex + 1}`,
      centerX: 0,
      centerY: 0,
      width: 1,
      height: 1,
      area: 1
    };
  }

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  return {
    id: stroke.id || `stroke-${fallbackIndex + 1}`,
    centerX: bounds.minX + width / 2,
    centerY: bounds.minY + height / 2,
    width,
    height,
    area: width * height
  };
}

function computeBoxOverlap(
  left: ReturnType<typeof getStrokeGeometry>,
  right: ReturnType<typeof getStrokeGeometry>
) {
  const leftMinX = left.centerX - left.width / 2;
  const leftMaxX = left.centerX + left.width / 2;
  const leftMinY = left.centerY - left.height / 2;
  const leftMaxY = left.centerY + left.height / 2;
  const rightMinX = right.centerX - right.width / 2;
  const rightMaxX = right.centerX + right.width / 2;
  const rightMinY = right.centerY - right.height / 2;
  const rightMaxY = right.centerY + right.height / 2;
  const overlapWidth = Math.max(0, Math.min(leftMaxX, rightMaxX) - Math.max(leftMinX, rightMinX));
  const overlapHeight = Math.max(0, Math.min(leftMaxY, rightMaxY) - Math.max(leftMinY, rightMinY));
  const intersection = overlapWidth * overlapHeight;
  const union = left.area + right.area - intersection;
  return union > 0 ? intersection / union : 0;
}

function computeStrokeConfusionWeights(
  imageData: AnnotationColorImageData,
  strokes: AnnotationColorStroke[]
) {
  const geometries = strokes.map(getStrokeGeometry);
  const imageDiagonal = Math.max(1, Math.hypot(imageData.width, imageData.height));
  const weights: number[][] = Array.from({ length: strokes.length }, () => Array(strokes.length).fill(0));

  for (let leftIndex = 0; leftIndex < strokes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < strokes.length; rightIndex += 1) {
      const left = geometries[leftIndex];
      const right = geometries[rightIndex];
      const distance = Math.hypot(left.centerX - right.centerX, left.centerY - right.centerY);
      const proximity = clamp(1 - distance / (imageDiagonal * 0.55));
      const overlap = computeBoxOverlap(left, right);
      const areaSimilarity = Math.min(left.area, right.area) / Math.max(left.area, right.area, 1);
      const weight = clamp(0.2 + 0.5 * proximity + 0.25 * overlap + 0.05 * areaSimilarity);
      weights[leftIndex][rightIndex] = weight;
      weights[rightIndex][leftIndex] = weight;
    }
  }

  return weights;
}

export function chooseBestAnnotationColor(
  imageData: AnnotationColorImageData,
  strokes: AnnotationColorStroke[],
  options: {
    alpha?: number;
    binCount?: number;
    candidateColors?: AnnotationColorCandidate[];
    maxNearbySamples?: number;
    maxStrokeSamples?: number;
    strokeWidth?: number;
    visibilityThreshold?: number;
  } = {}
): AnnotationColorChoice {
  const strokeWidth = Math.max(1, options.strokeWidth ?? 5);
  const binCount = Math.max(12, Math.round(options.binCount ?? 96));
  const alpha = clamp(options.alpha ?? 1);
  const visibilityThreshold = options.visibilityThreshold ?? DEFAULT_VISIBILITY_THRESHOLD;
  const preparedColors = buildPreparedColors(options.candidateColors ?? DEFAULT_ANNOTATION_CANDIDATE_COLORS);
  const strokeSamples = collectStrokeSamples(
    imageData,
    strokes,
    strokeWidth,
    binCount,
    Math.max(60, Math.round(options.maxStrokeSamples ?? 900))
  );
  const nearbySamples = collectNearbySamples(
    imageData,
    strokes,
    strokeWidth,
    Math.max(60, Math.round(options.maxNearbySamples ?? 700))
  );

  if (!preparedColors.length || !strokeSamples.length) {
    return {
      bestColor: DEFAULT_ANNOTATION_COLOR,
      ranking: [],
      sampleCount: strokeSamples.length,
      nearbySampleCount: nearbySamples.length
    };
  }

  const circularPath = isClosedPath(strokes, strokeWidth);
  const ranking = preparedColors.map((color) => {
    const binVisibility: number[][] = Array.from({ length: binCount }, () => []);

    for (const sample of strokeSamples) {
      const visibility = visibilityForSample(color, sample, alpha);
      binVisibility[sample.bin]?.push(visibility);
    }

    const binScores = binVisibility.flatMap((scores) => (scores.length ? [percentile(scores, 20)] : []));
    const p10Visibility = percentile(binScores, 10);
    const medianVisibility = percentile(binScores, 50);
    const meanVisibility = mean(binScores);
    const visibleRatio = binScores.filter((score) => score >= visibilityThreshold).length / binScores.length;
    const badSegmentRatio = 1 - visibleRatio;
    const rarityScore = computeRarityScore(color, nearbySamples);
    const longestBadSegmentRatio = computeLongestBadSegmentRatio(binScores, visibilityThreshold, circularPath);
    const stabilityPenalty = computeStabilityPenalty({
      p10Visibility,
      badSegmentRatio,
      longestBadSegmentRatio
    });
    const score =
      0.42 * p10Visibility +
      0.24 * medianVisibility +
      0.14 * meanVisibility +
      0.2 * visibleRatio +
      0.04 * rarityScore -
      0.5 * longestBadSegmentRatio -
      0.25 * badSegmentRatio -
      stabilityPenalty;

    return {
      name: color.name,
      color: color.color,
      score,
      p10Visibility,
      medianVisibility,
      meanVisibility,
      visibleRatio,
      badSegmentRatio,
      rarityScore,
      longestBadSegmentRatio
    };
  });

  ranking.sort((left, right) => right.score - left.score);
  const best = ranking[0];

  return {
    bestColor: best?.color ?? DEFAULT_ANNOTATION_COLOR,
    ranking,
    sampleCount: strokeSamples.length,
    nearbySampleCount: nearbySamples.length
  };
}

export function assignAnnotationColors(
  imageData: AnnotationColorImageData,
  strokes: AnnotationColorStroke[],
  options: {
    alpha?: number;
    beamWidth?: number;
    binCount?: number;
    candidateColors?: AnnotationColorCandidate[];
    maxNearbySamples?: number;
    maxStrokeSamples?: number;
    previousAssignments?: Record<string, string | null | undefined>;
    recolorPenalty?: number;
    separationWeight?: number;
    strokeWidth?: number;
    visibilityThreshold?: number;
  } = {}
): AnnotationColorGlobalAssignment {
  const candidateColors = options.candidateColors ?? DEFAULT_ANNOTATION_CANDIDATE_COLORS;
  const preparedColors = buildPreparedColors(candidateColors);
  const strokeCount = strokes.length;

  if (!strokeCount || !preparedColors.length) {
    return {
      assignments: [],
      colorsByStrokeId: {},
      choices: [],
      score: 0,
      localAverage: 0,
      worstLocalScore: 0,
      minPairDistance: 0,
      averagePairDistance: 0,
      duplicateCount: 0,
      changedCount: 0,
      evaluatedAssignments: 0,
      searchMode: "exact"
    };
  }

  const choices = strokes.map((stroke) =>
    chooseBestAnnotationColor(imageData, [stroke], {
      alpha: options.alpha,
      binCount: options.binCount,
      candidateColors,
      maxNearbySamples: options.maxNearbySamples,
      maxStrokeSamples: options.maxStrokeSamples,
      strokeWidth: options.strokeWidth,
      visibilityThreshold: options.visibilityThreshold
    })
  );
  const colorCount = preparedColors.length;
  const strokeIds = strokes.map((stroke, index) => stroke.id || `stroke-${index + 1}`);
  const previousColors = strokes.map((stroke, index) => {
    const id = strokeIds[index];
    return normalizeColor(options.previousAssignments?.[id] ?? stroke.color);
  });
  const localScores = choices.map((choice) => {
    const scoreByColor = new Map(choice.ranking.map((score) => [score.color.toLowerCase(), score]));
    return preparedColors.map((color) => scoreByColor.get(color.color.toLowerCase())?.score ?? -1);
  });
  const localScoreDetails = choices.map((choice) => {
    const scoreByColor = new Map(choice.ranking.map((score) => [score.color.toLowerCase(), score]));
    return preparedColors.map((color) => scoreByColor.get(color.color.toLowerCase()) ?? null);
  });
  const colorDistances = preparedColors.map((left) => preparedColors.map((right) => computeColorDistance(left, right)));
  const confusionWeights = computeStrokeConfusionWeights(imageData, strokes);
  const pairScale = strokeCount > 1 ? 2 / (strokeCount - 1) : 0;
  const separationWeight = options.separationWeight ?? 0.48;
  const recolorPenalty = options.recolorPenalty ?? 0.14;
  const requireUniqueColors = strokeCount <= colorCount;
  const beamWidth = Math.max(
    1,
    Math.round(options.beamWidth ?? (strokeCount <= 4 ? colorCount ** strokeCount : 1200))
  );
  const possibleAssignmentCount = colorCount ** strokeCount;
  const searchMode: "exact" | "beam" = beamWidth >= possibleAssignmentCount ? "exact" : "beam";
  const order = Array.from({ length: strokeCount }, (_, index) => index).sort((left, right) => {
    const leftSorted = [...localScores[left]].sort((a, b) => b - a);
    const rightSorted = [...localScores[right]].sort((a, b) => b - a);
    const leftGap = (leftSorted[0] ?? 0) - (leftSorted[1] ?? 0);
    const rightGap = (rightSorted[0] ?? 0) - (rightSorted[1] ?? 0);
    return leftGap - rightGap;
  });

  type SearchState = {
    colorsByOrder: number[];
    localSum: number;
    pairDistanceSum: number;
    rawScore: number;
    recolorCount: number;
    usedMask: number;
  };

  let evaluatedAssignments = 0;
  let states: SearchState[] = [
    {
      colorsByOrder: [],
      localSum: 0,
      pairDistanceSum: 0,
      rawScore: 0,
      recolorCount: 0,
      usedMask: 0
    }
  ];

  for (let orderPosition = 0; orderPosition < order.length; orderPosition += 1) {
    const strokeIndex = order[orderPosition];
    const nextStates: SearchState[] = [];

    for (const state of states) {
      for (let colorIndex = 0; colorIndex < colorCount; colorIndex += 1) {
        if (requireUniqueColors && (state.usedMask & (1 << colorIndex))) {
          continue;
        }

        const color = preparedColors[colorIndex];
        const localScore = localScores[strokeIndex][colorIndex] ?? -1;
        let pairDistanceIncrement = 0;

        for (let previousOrderPosition = 0; previousOrderPosition < state.colorsByOrder.length; previousOrderPosition += 1) {
          const previousStrokeIndex = order[previousOrderPosition];
          const previousColorIndex = state.colorsByOrder[previousOrderPosition];
          const pairWeight = confusionWeights[strokeIndex][previousStrokeIndex] ?? 0;
          pairDistanceIncrement += pairWeight * (colorDistances[colorIndex][previousColorIndex] ?? 0);
        }

        const previousColor = previousColors[strokeIndex];
        const recolorIncrement =
          previousColor && previousColor !== color.color.toLowerCase() ? 1 : 0;
        const rawScore =
          state.rawScore +
          localScore +
          separationWeight * pairScale * pairDistanceIncrement -
          recolorPenalty * recolorIncrement;

        nextStates.push({
          colorsByOrder: [...state.colorsByOrder, colorIndex],
          localSum: state.localSum + localScore,
          pairDistanceSum: state.pairDistanceSum + pairDistanceIncrement,
          rawScore,
          recolorCount: state.recolorCount + recolorIncrement,
          usedMask: state.usedMask | (1 << colorIndex)
        });
        evaluatedAssignments += 1;
      }
    }

    nextStates.sort((left, right) => right.rawScore - left.rawScore);
    states = nextStates.slice(0, beamWidth);
  }

  const bestState = states[0];
  if (!bestState) {
    return {
      assignments: [],
      colorsByStrokeId: {},
      choices,
      score: 0,
      localAverage: 0,
      worstLocalScore: 0,
      minPairDistance: 0,
      averagePairDistance: 0,
      duplicateCount: 0,
      changedCount: 0,
      evaluatedAssignments,
      searchMode
    };
  }

  const colorByStrokeIndex = Array(strokeCount).fill(0);
  bestState.colorsByOrder.forEach((colorIndex, orderPosition) => {
    colorByStrokeIndex[order[orderPosition]] = colorIndex;
  });

  const pairDistances: number[] = [];
  let duplicateCount = 0;
  for (let leftIndex = 0; leftIndex < strokeCount; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < strokeCount; rightIndex += 1) {
      const distance = colorDistances[colorByStrokeIndex[leftIndex]][colorByStrokeIndex[rightIndex]] ?? 0;
      pairDistances.push(distance);
      if (colorByStrokeIndex[leftIndex] === colorByStrokeIndex[rightIndex]) {
        duplicateCount += 1;
      }
    }
  }

  const assignments = colorByStrokeIndex.map((colorIndex, strokeIndex) => {
    const color = preparedColors[colorIndex];
    const previousColor = previousColors[strokeIndex];
    return {
      strokeIndex,
      strokeId: strokeIds[strokeIndex],
      color: color.color,
      name: color.name,
      previousColor,
      changed: Boolean(previousColor && previousColor !== color.color.toLowerCase()),
      localScore: localScoreDetails[strokeIndex][colorIndex]
    };
  });

  const colorsByStrokeId = Object.fromEntries(assignments.map((assignment) => [assignment.strokeId, assignment.color]));
  const assignedLocalScores = assignments.map((assignment) => assignment.localScore?.score ?? 0);

  return {
    assignments,
    colorsByStrokeId,
    choices,
    score: bestState.rawScore,
    localAverage: mean(assignedLocalScores),
    worstLocalScore: Math.min(...assignedLocalScores),
    minPairDistance: pairDistances.length ? Math.min(...pairDistances) : 0,
    averagePairDistance: mean(pairDistances),
    duplicateCount,
    changedCount: assignments.filter((assignment) => assignment.changed).length,
    evaluatedAssignments,
    searchMode
  };
}
