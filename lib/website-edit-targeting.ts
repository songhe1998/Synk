import {
  TranscriptToken,
  WebsiteEditAnnotation,
  WebsiteEditDomCandidate,
  WebsiteEditIntent,
  WebsiteEditIntentType,
  WebsiteEditMention,
  WebsiteEditMentionBinding,
  WebsiteEditRect,
  WebsiteEditResolvedTarget,
  WebsiteEditTargetCandidate,
  WebsiteEditTargetResolution,
  WebsiteJob
} from "@/lib/types";
import { buildDisplayTranscript } from "@/lib/transcript-format";

const WEBSITE_EDIT_INTENT_MODEL =
  process.env.OPENAI_WEBSITE_EDIT_INTENT_MODEL ?? process.env.OPENAI_FAST_SCENE_MODEL ?? "gpt-5.4-mini";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const RESPONSES_TIMEOUT_MS = Number(process.env.OPENAI_RESPONSES_TIMEOUT_MS ?? 120000);

export interface WebsiteEditRequestPayload {
  instructionText: string;
  annotation: WebsiteEditAnnotation;
  domCandidates: WebsiteEditDomCandidate[];
  transcriptTokens?: TranscriptToken[] | null;
}

interface WebsiteStrokeMetric {
  stroke: WebsiteEditAnnotation["strokes"][number];
  index: number;
  bbox: WebsiteEditRect;
  centroid: { x: number; y: number };
  startMs: number | null;
  endMs: number | null;
}

interface ScoreOptions {
  preferContainer?: boolean;
}

interface LlmIntentParserResult {
  intents: WebsiteEditIntent[];
  model: string;
}

interface LlmReferenceIntentParserResult extends LlmIntentParserResult {
  mentions: WebsiteEditMention[];
}

interface ParserTranscriptToken {
  index: number;
  text: string;
  startMs: number | null;
  endMs: number | null;
  granularity: TranscriptToken["granularity"];
  lang: string;
  approximate: boolean;
  startChar: number;
  endChar: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function area(rect: WebsiteEditRect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function center(rect: WebsiteEditRect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

function bboxFromPoints(points: Array<{ x: number; y: number }>): WebsiteEditRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function strokeMetrics(annotation: WebsiteEditAnnotation): WebsiteStrokeMetric[] {
  return annotation.strokes
    .map((stroke, index) => {
      const points = stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (!points.length) {
        return null;
      }
      const bbox = bboxFromPoints(points);
      const timedPoints = points.filter((point) => typeof point.tMs === "number" && Number.isFinite(point.tMs));
      const pointStartMs = timedPoints.length ? Math.min(...timedPoints.map((point) => point.tMs as number)) : null;
      const pointEndMs = timedPoints.length ? Math.max(...timedPoints.map((point) => point.tMs as number)) : null;
      const startMs = typeof stroke.startMs === "number" && Number.isFinite(stroke.startMs) ? stroke.startMs : pointStartMs;
      const endMs = typeof stroke.endMs === "number" && Number.isFinite(stroke.endMs) ? stroke.endMs : pointEndMs;

      return {
        stroke,
        index,
        bbox,
        centroid: center(bbox),
        startMs,
        endMs
      };
    })
    .filter((metric): metric is WebsiteStrokeMetric => Boolean(metric));
}

function annotationForStroke(parent: WebsiteEditAnnotation, metric: WebsiteStrokeMetric): WebsiteEditAnnotation {
  return {
    ...parent,
    bbox: metric.bbox,
    strokes: [metric.stroke]
  };
}

function clipForWebsiteEditPrompt(value: string | null | undefined, maxLength: number) {
  const text = (value ?? "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function summarizePromptStroke(stroke: WebsiteEditAnnotation["strokes"][number]) {
  const points = stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const bbox = points.length ? bboxFromPoints(points) : { x: 0, y: 0, width: 0, height: 0 };
  const pointTimes = points
    .map((point) => point.tMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startMs =
    typeof stroke.startMs === "number" && Number.isFinite(stroke.startMs)
      ? stroke.startMs
      : pointTimes.length
        ? Math.min(...pointTimes)
        : null;
  const endMs =
    typeof stroke.endMs === "number" && Number.isFinite(stroke.endMs)
      ? stroke.endMs
      : pointTimes.length
        ? Math.max(...pointTimes)
        : null;

  return {
    id: stroke.id,
    startMs,
    endMs,
    bbox,
    pointCount: points.length
  };
}

function compactAnnotationForPrompt(annotation: WebsiteEditAnnotation | null | undefined) {
  if (!annotation) {
    return null;
  }

  return {
    viewportWidth: annotation.viewportWidth,
    viewportHeight: annotation.viewportHeight,
    devicePixelRatio: annotation.devicePixelRatio,
    path: annotation.path,
    scrollX: annotation.scrollX,
    scrollY: annotation.scrollY,
    bbox: annotation.bbox,
    strokeCount: annotation.strokes.length,
    strokes: annotation.strokes.map(summarizePromptStroke)
  };
}

function compactPromptCandidate(candidate: WebsiteEditTargetCandidate) {
  return {
    id: candidate.id,
    selector: candidate.selector,
    tagName: candidate.tagName,
    role: candidate.role ?? null,
    text: clipForWebsiteEditPrompt(candidate.text, 100) || null,
    imageSrcs: candidate.imageSrcs?.slice(0, 4),
    imageAlts: candidate.imageAlts?.map((alt) => clipForWebsiteEditPrompt(alt, 90)).slice(0, 4),
    rect: candidate.rect,
    score: Number(candidate.score.toFixed(3)),
    reason: clipForWebsiteEditPrompt(candidate.reason, 140)
  };
}

function compactPromptTarget(target: WebsiteEditResolvedTarget) {
  return {
    id: target.id,
    role: target.role,
    targetSelector: target.targetSelector,
    targetElementId: target.targetElementId,
    targetDescription: clipForWebsiteEditPrompt(target.targetDescription, 220),
    bbox: target.bbox,
    strokeId: target.strokeId,
    strokeIndex: target.strokeIndex,
    mentionIds: target.mentionIds,
    intentIds: target.intentIds,
    confidence: Number(target.confidence.toFixed(3)),
    reason: clipForWebsiteEditPrompt(target.reason, 220),
    candidates: target.candidates.slice(0, 3).map(compactPromptCandidate)
  };
}

export function compactWebsiteEditTargetResolutionForPrompt(targetResolution: WebsiteEditTargetResolution) {
  return {
    mode: targetResolution.mode,
    confidence: Number(targetResolution.confidence.toFixed(3)),
    reason: clipForWebsiteEditPrompt(targetResolution.reason, 260),
    targetSelector: targetResolution.targetSelector,
    targetElementId: targetResolution.targetElementId,
    targetDescription: clipForWebsiteEditPrompt(targetResolution.targetDescription, 260),
    intentParser: targetResolution.intentParser,
    mentions: targetResolution.mentions?.map((mention) => ({
      id: mention.id,
      text: mention.text,
      startMs: mention.startMs,
      endMs: mention.endMs,
      kind: mention.kind,
      targetCount: mention.targetCount,
      source: mention.source ?? null,
      startTokenIndex: mention.startTokenIndex ?? null,
      endTokenIndex: mention.endTokenIndex ?? null
    })),
    mentionBindings: targetResolution.mentionBindings?.map((binding) => ({
      mentionId: binding.mentionId,
      strokeIds: binding.strokeIds,
      confidence: Number(binding.confidence.toFixed(3)),
      reason: clipForWebsiteEditPrompt(binding.reason, 180)
    })),
    intents: targetResolution.intents?.map((intent) => ({
      id: intent.id,
      type: intent.type,
      operation: intent.operation,
      targetMentionIds: intent.targetMentionIds,
      expectedTargetCount: intent.expectedTargetCount,
      confidence: Number(intent.confidence.toFixed(3)),
      reason: clipForWebsiteEditPrompt(intent.reason, 220)
    })),
    targets: targetResolution.targets?.map(compactPromptTarget),
    candidates: targetResolution.candidates.slice(0, 4).map(compactPromptCandidate),
    annotation: compactAnnotationForPrompt(targetResolution.annotation)
  };
}

function expandRect(rect: WebsiteEditRect, amount: number): WebsiteEditRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

function intersectArea(left: WebsiteEditRect, right: WebsiteEditRect) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function pointInsideRect(point: { x: number; y: number }, rect: WebsiteEditRect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function includesAny(value: string, words: string[]) {
  return words.some((word) => value.includes(word));
}

function uniquePoints(annotation: WebsiteEditAnnotation) {
  return annotation.strokes.flatMap((stroke) => stroke.points);
}

function strokeHitRatios(candidate: WebsiteEditDomCandidate, annotation: WebsiteEditAnnotation) {
  const expandedCandidate = expandRect(candidate.rect, 4);
  return annotation.strokes.map((stroke) => {
    if (!stroke.points.length) {
      return 0;
    }

    return stroke.points.filter((point) => pointInsideRect(point, expandedCandidate)).length / stroke.points.length;
  });
}

function hasMultiStrokeGroupIntent(annotation: WebsiteEditAnnotation, instruction: string) {
  if (annotation.strokes.length < 2) {
    return false;
  }

  return includesAny(instruction, [
    "two",
    "both",
    "these",
    "those",
    "swap",
    "switch",
    "reorder",
    "places",
    "cards",
    "items",
    "together"
  ]);
}

function tagCategory(candidate: WebsiteEditDomCandidate) {
  const tag = candidate.tagName.toLowerCase();
  const role = normalizeText(candidate.role);
  const className = normalizeText(candidate.className);
  const text = normalizeText(candidate.text);
  const aria = normalizeText(candidate.ariaLabel);
  const haystack = [tag, role, className, text, aria].join(" ");

  return {
    tag,
    role,
    haystack,
    isRootLike: tag === "body" || tag === "main" || tag === "html" || candidate.selector === "body",
    isButtonLike:
      tag === "button" ||
      role === "button" ||
      (tag === "a" && includesAny(haystack, ["button", "cta", "sign up", "book", "start"])),
    isHeadingLike: /^h[1-6]$/.test(tag) || role === "heading" || includesAny(className, ["headline", "title"]),
    isImageLike: tag === "img" || tag === "picture" || tag === "svg" || includesAny(className, ["image", "photo", "media"]),
    isCardLike:
      tag === "article" ||
      role === "article" ||
      includesAny(className, ["card", "panel", "tile", "module", "item"]),
    isNavLike: tag === "nav" || role === "navigation" || includesAny(className, ["nav", "navbar"]),
    isHeaderLike: tag === "header" || includesAny(className, ["hero", "header", "masthead"]),
    isFooterLike: tag === "footer" || includesAny(className, ["footer"])
  };
}

function semanticBoost(instruction: string, candidate: WebsiteEditDomCandidate) {
  const category = tagCategory(candidate);
  let boost = 0;
  const reasons: string[] = [];

  if (includesAny(instruction, ["button", "按钮", "cta", "signup", "sign up", "call to action", "link", "链接"])) {
    if (category.isButtonLike) {
      boost += 0.34;
      reasons.push("button-like element matches request");
    }
  }

  if (includesAny(instruction, ["headline", "heading", "title", "copy", "text", "wording", "标题", "文字", "文案", "字"])) {
    if (category.isHeadingLike || candidate.text) {
      boost += category.isHeadingLike ? 0.3 : 0.14;
      reasons.push("text element matches request");
    }
  }

  if (includesAny(instruction, ["image", "photo", "picture", "visual", "illustration", "图片", "照片", "图"])) {
    if (category.isImageLike) {
      const directImageBoost = category.tag === "img" || category.tag === "picture" || category.tag === "svg";
      boost += directImageBoost ? 0.4 : 0.18;
      reasons.push(directImageBoost ? "direct image element matches request" : "image-like container matches request");
    }
  }

  if (includesAny(instruction, ["card", "panel", "box", "section", "area", "block", "卡片", "模块", "区域", "这块", "那块"])) {
    if (category.isCardLike || category.isHeaderLike) {
      boost += 0.28;
      reasons.push("container-like element matches request");
    }
  }

  if (includesAny(instruction, ["nav", "menu", "header", "导航", "菜单", "顶部"])) {
    if (category.isNavLike || category.isHeaderLike) {
      boost += 0.28;
      reasons.push("navigation/header element matches request");
    }
  }

  if (includesAny(instruction, ["footer", "bottom", "底部", "页脚"])) {
    if (category.isFooterLike) {
      boost += 0.28;
      reasons.push("footer element matches request");
    }
  }

  return { boost, reasons };
}

function textBoost(instruction: string, candidate: WebsiteEditDomCandidate) {
  const candidateText = normalizeText(
    [candidate.text, candidate.ariaLabel, candidate.className, candidate.role, candidate.tagName].filter(Boolean).join(" ")
  );
  if (!instruction || !candidateText) {
    return { boost: 0, reasons: [] as string[] };
  }

  const instructionTokens = instruction
    .split(" ")
    .filter((token) => token.length >= 4 && !["this", "that", "here", "there", "make", "little", "bigger"].includes(token));
  const matches = instructionTokens.filter((token) => candidateText.includes(token));
  if (!matches.length) {
    return { boost: 0, reasons: [] as string[] };
  }

  return {
    boost: clamp(matches.length * 0.08, 0.08, 0.24),
    reasons: [`text/class matches ${matches.slice(0, 3).join(", ")}`]
  };
}

function scoreCandidate(
  candidate: WebsiteEditDomCandidate,
  annotation: WebsiteEditAnnotation,
  instruction: string,
  options: ScoreOptions = {}
): WebsiteEditTargetCandidate | null {
  const candidateArea = area(candidate.rect);
  const annotationArea = area(annotation.bbox);
  const viewportArea = Math.max(1, annotation.viewportWidth * annotation.viewportHeight);
  if (candidateArea < 24 || annotationArea < 24) {
    return null;
  }

  const expandedAnnotation = expandRect(annotation.bbox, 18);
  const overlap = intersectArea(candidate.rect, expandedAnnotation);
  const candidateCoverage = overlap / Math.max(1, candidateArea);
  const annotationCoverage = overlap / Math.max(1, area(expandedAnnotation));
  const normalizedOverlap = overlap / Math.max(1, Math.min(candidateArea, area(expandedAnnotation)));
  const points = uniquePoints(annotation);
  const pointHitRatio = points.length
    ? points.filter((point) => pointInsideRect(point, expandRect(candidate.rect, 4))).length / points.length
    : 0;
  const candidateCenter = center(candidate.rect);
  const annotationCenter = center(annotation.bbox);
  const distance = Math.hypot(candidateCenter.x - annotationCenter.x, candidateCenter.y - annotationCenter.y);
  const distanceScale = Math.max(annotation.bbox.width, annotation.bbox.height, 80);
  const proximity = clamp(1 - distance / distanceScale, 0, 1);
  const category = tagCategory(candidate);
  const semantic = semanticBoost(instruction, candidate);
  const text = textBoost(instruction, candidate);
  const multiStrokeIntent = hasMultiStrokeGroupIntent(annotation, instruction);
  const strokeHits = strokeHitRatios(candidate, annotation);
  const coveredStrokeCount = strokeHits.filter((ratio) => ratio >= 0.2).length;
  const coversMultipleStrokes = coveredStrokeCount >= Math.min(2, annotation.strokes.length);
  const isHuge = candidateArea / viewportArea > 0.58;
  const isVeryLarge = candidateArea / viewportArea > 0.32;
  const compactnessBoost = candidateCoverage > 0.7 && candidateArea / viewportArea < 0.18 ? 0.12 : 0;
  const containerIntent =
    options.preferContainer ||
    includesAny(instruction, [
      "card",
      "panel",
      "section",
      "area",
      "block",
      "swap",
      "switch",
      "reorder",
      "move",
      "position",
      "卡片",
      "模块",
      "区域",
      "调换",
      "互换",
      "交换",
      "顺序",
      "位置",
      "移动",
      "挪"
    ]);
  const containerBoost =
    containerIntent && annotationCoverage > 0.16 && (category.isCardLike || category.isHeaderLike || category.isNavLike)
      ? 0.2
      : 0;
  const directElementPenalty =
    options.preferContainer &&
    !category.isCardLike &&
    !category.isHeaderLike &&
    !category.isNavLike &&
    !category.isFooterLike &&
    !category.isRootLike
      ? 0.08
      : 0;
  const multiStrokeGroupBoost =
    multiStrokeIntent && coversMultipleStrokes
      ? 0.18 + (candidateCoverage > 0.84 ? 0.2 : 0) + (annotationCoverage > 0.45 ? 0.08 : 0)
      : 0;
  const singleStrokeGroupPenalty = multiStrokeIntent && !coversMultipleStrokes ? 0.42 : 0;
  const looseGroupContainerPenalty =
    multiStrokeIntent && coversMultipleStrokes && candidateCoverage < 0.84 ? 0.42 : 0;
  const rootPenalty = category.isRootLike ? 0.42 : 0;
  const largePenalty = isHuge ? 0.28 : isVeryLarge && !containerIntent ? 0.14 : 0;
  const emptyPenalty = !candidate.text && !candidate.ariaLabel && !candidate.className ? 0.08 : 0;

  const score = clamp(
    normalizedOverlap * 0.38 +
      candidateCoverage * 0.2 +
      pointHitRatio * 0.18 +
      proximity * 0.14 +
      semantic.boost +
      text.boost +
      compactnessBoost +
      containerBoost +
      multiStrokeGroupBoost -
      singleStrokeGroupPenalty -
      looseGroupContainerPenalty -
      directElementPenalty -
      rootPenalty -
      largePenalty -
      emptyPenalty,
    0,
    1.5
  );

  if (score <= 0.02) {
    return null;
  }

  const reasonParts = [
    `overlap ${normalizedOverlap.toFixed(2)}`,
    `candidate coverage ${candidateCoverage.toFixed(2)}`,
    `point hits ${pointHitRatio.toFixed(2)}`,
    `proximity ${proximity.toFixed(2)}`,
    ...semantic.reasons,
    ...text.reasons
  ];

  if (rootPenalty) {
    reasonParts.push("root-like element penalized");
  }
  if (largePenalty) {
    reasonParts.push("very large element penalized");
  }
  if (multiStrokeGroupBoost) {
    reasonParts.push(`covers ${coveredStrokeCount} drawn groups`);
  }
  if (singleStrokeGroupPenalty) {
    reasonParts.push("single drawn group penalized for multi-target request");
  }
  if (looseGroupContainerPenalty) {
    reasonParts.push("loose multi-target container penalized");
  }
  if (directElementPenalty) {
    reasonParts.push("direct child penalized for container-oriented edit");
  }

  return {
    id: candidate.id,
    selector: candidate.selector,
    tagName: candidate.tagName,
    role: candidate.role,
    text: candidate.text,
    imageSrcs: candidate.imageSrcs,
    imageAlts: candidate.imageAlts,
    rect: candidate.rect,
    score,
    reason: reasonParts.join("; ")
  };
}

function resolveWebsiteEditTargetWithOptions({
  instructionText,
  annotation,
  domCandidates
}: WebsiteEditRequestPayload, options: ScoreOptions = {}): WebsiteEditTargetResolution {
  const instruction = normalizeText(instructionText);
  const scored = domCandidates
    .map((candidate) => scoreCandidate(candidate, annotation, instruction, options))
    .filter((candidate): candidate is WebsiteEditTargetCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  const best = scored[0] ?? null;
  const second = scored[1] ?? null;
  const ambiguityPenalty = best && second ? clamp((second.score - best.score + 0.18) * 0.5, 0, 0.18) : 0;
  const confidence = best ? clamp(best.score - ambiguityPenalty, 0.08, 0.96) : 0;

  return {
    targetElementId: best?.id ?? null,
    targetSelector: best?.selector ?? null,
    targetDescription: best
      ? `${best.tagName.toLowerCase()}${best.role ? ` role=${best.role}` : ""}${best.text ? ` "${best.text.slice(0, 80)}"` : ""}`
      : "No matching element found near the annotation.",
    confidence,
    reason: best
      ? `Selected ${best.selector} with score ${best.score.toFixed(2)}. ${best.reason}`
      : "No candidate overlapped the user's annotation enough to identify a target.",
    candidates: scored
  };
}

export function resolveWebsiteEditTarget(payload: WebsiteEditRequestPayload): WebsiteEditTargetResolution {
  return resolveWebsiteEditTargetWithOptions(payload);
}

function timedTranscriptText(tokens: TranscriptToken[] | null | undefined, fallbackText: string) {
  if (!tokens?.length) {
    return {
      text: fallbackText,
      charToToken: [] as number[]
    };
  }

  let text = "";
  const charToToken: number[] = [];
  tokens.forEach((token, tokenIndex) => {
    const previous = tokens[tokenIndex - 1];
    const needsSpace =
      text.length > 0 &&
      previous &&
      token.lang === "latin" &&
      previous.lang === "latin" &&
      token.granularity === "word" &&
      previous.granularity === "word";
    if (needsSpace) {
      text += " ";
      charToToken.push(-1);
    }
    for (const char of token.text) {
      text += char;
      charToToken.push(tokenIndex);
    }
  });

  return {
    text: text.trim() || buildDisplayTranscript(tokens) || fallbackText,
    charToToken
  };
}

function mentionTimeFromChars(
  charToToken: number[],
  tokens: TranscriptToken[] | null | undefined,
  startChar: number,
  endChar: number
) {
  if (!tokens?.length || !charToToken.length) {
    return { startMs: null, endMs: null };
  }

  const tokenIndexes = charToToken.slice(startChar, endChar).filter((tokenIndex) => tokenIndex >= 0);
  if (!tokenIndexes.length) {
    return { startMs: null, endMs: null };
  }

  const first = tokens[Math.min(...tokenIndexes)];
  const last = tokens[Math.max(...tokenIndexes)];
  return {
    startMs: first?.startMs ?? null,
    endMs: last?.endMs ?? null
  };
}

function parserTranscriptContext(tokens: TranscriptToken[] | null | undefined, fallbackText: string) {
  const sourceTokens = tokens?.length
    ? tokens.map((token, index) => ({
        index,
        text: token.text,
        startMs: Number.isFinite(token.startMs) ? token.startMs : null,
        endMs: Number.isFinite(token.endMs) ? token.endMs : null,
        granularity: token.granularity,
        lang: token.lang,
        approximate: token.approximate
      }))
    : Array.from(fallbackText).map((char, index) => ({
        index,
        text: char,
        startMs: null,
        endMs: null,
        granularity: /[\s,，。.;；!?！？]/u.test(char) ? ("punctuation" as const) : ("char" as const),
        lang: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
          ? "cjk"
          : /[A-Za-z]/.test(char)
            ? "latin"
            : "unknown",
        approximate: true
      }));

  let displayText = "";
  const parserTokens: ParserTranscriptToken[] = sourceTokens.map((token, tokenIndex) => {
    const previous = sourceTokens[tokenIndex - 1];
    const needsSpace =
      displayText.length > 0 &&
      previous &&
      token.lang === "latin" &&
      previous.lang === "latin" &&
      token.granularity === "word" &&
      previous.granularity === "word";
    if (needsSpace) {
      displayText += " ";
    }
    const startChar = displayText.length;
    displayText += token.text;
    return {
      ...token,
      startChar,
      endChar: displayText.length
    };
  });

  return {
    text: displayText.trim() || fallbackText,
    tokens: parserTokens
  };
}

function transcriptSpanText(tokens: ParserTranscriptToken[], startTokenIndex: number, endTokenIndex: number) {
  const selected = tokens.slice(startTokenIndex, endTokenIndex + 1);
  let output = "";
  selected.forEach((token, index) => {
    const previous = selected[index - 1];
    const needsSpace =
      output.length > 0 &&
      previous &&
      token.lang === "latin" &&
      previous.lang === "latin" &&
      token.granularity === "word" &&
      previous.granularity === "word";
    output += needsSpace ? ` ${token.text}` : token.text;
  });
  return output.trim();
}

function formatParserTranscriptTokens(tokens: ParserTranscriptToken[]) {
  return tokens
    .map((token) => {
      const timing =
        token.startMs === null || token.endMs === null
          ? "no-time"
          : `${Math.round(token.startMs)}-${Math.round(token.endMs)}ms`;
      return `${token.index}: ${JSON.stringify(token.text)} (${timing}, ${token.granularity}, ${token.lang})`;
    })
    .join("\n");
}

function parseMentionTargetCount(text: string) {
  const lower = text.toLowerCase();
  if (/两|俩|二|two|both/.test(lower)) {
    return 2;
  }
  if (/三|three/.test(lower)) {
    return 3;
  }
  if (/四|four/.test(lower)) {
    return 4;
  }
  return null;
}

function isPluralMention(text: string) {
  return /两|俩|二|三|四|几|些|both|these|those|two|three|four/i.test(text);
}

export function extractWebsiteEditMentions(
  instructionText: string,
  transcriptTokens?: TranscriptToken[] | null
): WebsiteEditMention[] {
  const { text, charToToken } = timedTranscriptText(transcriptTokens, instructionText);
  const pattern =
    /这两个|那两个|这俩|那俩|这三个|那三个|这四个|那四个|这几个|那几个|这些|那些|这个|那个|这里|那里|这边|那边|这块|那块|both of these|both of those|these two|those two|these three|those three|these|those|both|this one|that one|this|that|here|there/giu;
  const mentions: WebsiteEditMention[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const mentionText = match[0];
    const startChar = match.index;
    const endChar = match.index + mentionText.length;
    const { startMs, endMs } = mentionTimeFromChars(charToToken, transcriptTokens, startChar, endChar);
    mentions.push({
      id: `m${mentions.length + 1}`,
      text: mentionText,
      startMs,
      endMs,
      startChar,
      endChar,
      source: "rule",
      kind: isPluralMention(mentionText) ? "plural" : "singular",
      targetCount: parseMentionTargetCount(mentionText)
    });
  }

  return mentions;
}

function clauseRanges(text: string) {
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  const pattern = /然后|接着|另外|同时|再|and then|then|[,，。.;；]/giu;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const end = match.index;
    const clauseText = text.slice(start, end).trim();
    if (clauseText) {
      ranges.push({ start, end, text: clauseText });
    }
    start = match.index + match[0].length;
  }

  const finalText = text.slice(start).trim();
  if (finalText) {
    ranges.push({ start, end: text.length, text: finalText });
  }

  return ranges.length ? ranges : [{ start: 0, end: text.length, text }];
}

function classifyIntent(clauseText: string, mentions: WebsiteEditMention[]): Omit<WebsiteEditIntent, "id" | "targetMentionIds"> {
  const raw = clauseText.toLowerCase();
  const mentionCount = mentions.reduce((sum, mention) => sum + (mention.targetCount ?? 1), 0);
  const hasPlural = mentions.some((mention) => mention.kind === "plural") || mentionCount > 1;

  if (/调换|互换|交换|对调|换.{0,6}(位置|顺序)|swap|switch|reorder/.test(raw)) {
    return {
      type: "swap_order",
      operation: "swap_order",
      expectedTargetCount: 2,
      confidence: 0.9,
      reason: "swap/order language"
    };
  }

  if (/放到|移到|挪到|移动到|前面|后面|左边|右边|上面|下面|before|after|left|right|above|below|next to/.test(raw)) {
    return {
      type: "move_relative",
      operation: "move_relative",
      expectedTargetCount: 2,
      confidence: 0.82,
      reason: "relative position language"
    };
  }

  if (/一样|匹配|照着|match|same as|copy/.test(raw)) {
    return {
      type: "copy_style",
      operation: "copy_style",
      expectedTargetCount: 2,
      confidence: 0.78,
      reason: "copy/match language"
    };
  }

  if (/删掉|删除|去掉|拿掉|remove|delete/.test(raw)) {
    return {
      type: "remove",
      operation: "remove",
      expectedTargetCount: hasPlural ? null : 1,
      confidence: 0.82,
      reason: "remove language"
    };
  }

  if (/大一点|变大|放大|更大|加大|larger|bigger|increase size|make bigger/.test(raw)) {
    return {
      type: hasPlural ? "bulk_style_change" : "local_edit",
      operation: "increase_size",
      expectedTargetCount: hasPlural ? null : 1,
      confidence: 0.84,
      reason: "increase-size language"
    };
  }

  if (/小一点|变小|缩小|更小|smaller|decrease size/.test(raw)) {
    return {
      type: hasPlural ? "bulk_style_change" : "local_edit",
      operation: "decrease_size",
      expectedTargetCount: hasPlural ? null : 1,
      confidence: 0.82,
      reason: "decrease-size language"
    };
  }

  if (/醒目|明显|突出|强调|highlight|emphasize|pop/.test(raw)) {
    return {
      type: hasPlural ? "bulk_style_change" : "emphasize",
      operation: "emphasize",
      expectedTargetCount: hasPlural ? null : 1,
      confidence: 0.78,
      reason: "emphasis language"
    };
  }

  if (/颜色|变淡|淡一点|浅一点|深一点|color|lighter|darker/.test(raw)) {
    return {
      type: hasPlural ? "bulk_style_change" : "local_edit",
      operation: "change_color",
      expectedTargetCount: hasPlural ? null : 1,
      confidence: 0.72,
      reason: "color-change language"
    };
  }

  return {
    type: hasPlural ? "bulk_style_change" : "local_edit",
    operation: "local_edit",
    expectedTargetCount: hasPlural ? null : 1,
    confidence: 0.52,
    reason: "fallback local edit language"
  };
}

export function parseWebsiteEditIntents(
  instructionText: string,
  mentions: WebsiteEditMention[]
): WebsiteEditIntent[] {
  if (!mentions.length) {
    return [
      {
        id: "intent_1",
        ...classifyIntent(instructionText, []),
        targetMentionIds: []
      }
    ];
  }

  const intents = clauseRanges(instructionText)
    .map((clause) => {
      const targetMentions = mentions.filter(
        (mention) => mention.startChar >= clause.start && mention.startChar < clause.end
      );
      if (!targetMentions.length) {
        return null;
      }
      return {
        clause,
        targetMentions
      };
    })
    .filter(
      (
        entry
      ): entry is {
        clause: { start: number; end: number; text: string };
        targetMentions: WebsiteEditMention[];
      } => Boolean(entry)
    )
    .map((entry, index) => ({
      id: `intent_${index + 1}`,
      ...classifyIntent(entry.clause.text, entry.targetMentions),
      targetMentionIds: entry.targetMentions.map((mention) => mention.id)
    }));

  if (intents.length) {
    return intents;
  }

  return [
    {
      id: "intent_1",
      ...classifyIntent(instructionText, mentions),
      targetMentionIds: mentions.map((mention) => mention.id)
    }
  ];
}

function buildMentionMarkedInstruction(instructionText: string, mentions: WebsiteEditMention[]) {
  if (!mentions.length) {
    return instructionText;
  }

  let cursor = 0;
  let output = "";
  mentions.forEach((mention) => {
    const foundAt = instructionText.indexOf(mention.text, cursor);
    const start = foundAt >= 0 ? foundAt : Math.max(cursor, Math.min(mention.startChar, instructionText.length));
    output += instructionText.slice(cursor, start);
    output += `[${mention.id}:${mention.text}]`;
    cursor = Math.min(instructionText.length, start + mention.text.length);
  });
  output += instructionText.slice(cursor);
  return output;
}

async function callIntentParserResponses(payload: object, apiKey: string) {
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

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Responses API failed: ${response.status} ${errorText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractOutputText(payload: any) {
  const message = payload?.output?.find((item: any) => item.type === "message");
  const textPart = message?.content?.find((part: any) => part.type === "output_text");
  if (typeof textPart?.text !== "string" || !textPart.text.trim()) {
    throw new Error("Responses API returned no text payload.");
  }
  return textPart.text;
}

const WEBSITE_EDIT_INTENT_TYPES: WebsiteEditIntentType[] = [
  "local_edit",
  "bulk_style_change",
  "swap_order",
  "move_relative",
  "copy_style",
  "remove",
  "emphasize",
  "unknown"
];

function normalizeLlmOperation(type: WebsiteEditIntentType, operation: unknown) {
  const raw = typeof operation === "string" ? normalizeText(operation) : "";
  switch (type) {
    case "bulk_style_change":
      if (/small|decrease|shrink|smaller|小一点|变小|缩小|更小|调小/.test(raw)) {
        return "decrease_size";
      }
      if (/color|colour|light|dark|颜色|淡|浅|深/.test(raw)) {
        return "change_color";
      }
      if (/emphas|highlight|eye|pop|醒目|明显|突出|强调/.test(raw)) {
        return "emphasize";
      }
      return "increase_size";
    case "swap_order":
      return "swap_order";
    case "move_relative":
      return "move_relative";
    case "copy_style":
      return "copy_style";
    case "remove":
      return "remove";
    case "emphasize":
      return "emphasize";
    case "local_edit":
      if (/big|large|increase|larger|bigger|size|大一点|变大|放大|更大|加大|调大/.test(raw)) {
        return "increase_size";
      }
      if (/small|decrease|shrink|smaller|小一点|变小|缩小|更小|调小/.test(raw)) {
        return "decrease_size";
      }
      if (/color|colour|light|dark|颜色|淡|浅|深/.test(raw)) {
        return "change_color";
      }
      if (/emphas|highlight|eye|pop|醒目|明显|突出|强调/.test(raw)) {
        return "emphasize";
      }
      return "local_edit";
    default:
      return raw ? raw.replace(/\s+/g, "_") : "unknown";
  }
}

function normalizeLlmIntentType(
  type: WebsiteEditIntentType,
  rawOperationText: string,
  hasPluralTarget: boolean
): WebsiteEditIntentType {
  if ((type === "local_edit" || type === "emphasize") && hasPluralTarget) {
    return "bulk_style_change";
  }
  if (type === "bulk_style_change" && !hasPluralTarget) {
    return /emphas|highlight|eye|pop|醒目|明显|突出|强调/i.test(rawOperationText) ? "emphasize" : "local_edit";
  }
  return type;
}

function normalizeLlmIntentPayload(value: unknown, mentions: WebsiteEditMention[]): WebsiteEditIntent[] {
  const payload = value as { intents?: unknown };
  if (!Array.isArray(payload?.intents) || !payload.intents.length) {
    throw new Error("LLM parser returned no intents.");
  }

  const knownMentionIds = new Set(mentions.map((mention) => mention.id));
  const allowedTypes = new Set<WebsiteEditIntentType>(WEBSITE_EDIT_INTENT_TYPES);

  const intents: WebsiteEditIntent[] = [];
  payload.intents.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`LLM parser returned invalid intent at index ${index}.`);
    }
    const raw = entry as {
      type?: unknown;
      operation?: unknown;
      targetMentionIds?: unknown;
      expectedTargetCount?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    if (typeof raw.type !== "string" || !allowedTypes.has(raw.type as WebsiteEditIntentType)) {
      throw new Error(`LLM parser returned unsupported intent type at index ${index}.`);
    }
    if (!Array.isArray(raw.targetMentionIds)) {
      throw new Error(`LLM parser returned missing targetMentionIds at index ${index}.`);
    }

    const targetMentionIds = uniqueInOrder(
      raw.targetMentionIds.filter((id): id is string => typeof id === "string" && knownMentionIds.has(id))
    );
    if (mentions.length && !targetMentionIds.length) {
      return;
    }

    const type = raw.type as WebsiteEditIntentType;
    const rawCount = typeof raw.expectedTargetCount === "number" && Number.isFinite(raw.expectedTargetCount)
      ? Math.round(raw.expectedTargetCount)
      : 0;
    const expectedTargetCount =
      rawCount > 0 ? rawCount : type === "swap_order" || type === "move_relative" || type === "copy_style" ? 2 : null;
    const referencedMentions = targetMentionIds.map((id) => mentions.find((mention) => mention.id === id)).filter(Boolean);
    const hasPluralTarget =
      targetMentionIds.length > 1 ||
      expectedTargetCount !== null && expectedTargetCount > 1 ||
      referencedMentions.some((mention) => mention?.kind === "plural");
    const rawOperationText = [raw.operation, raw.reason].filter((item) => typeof item === "string").join(" ");
    const normalizedType = normalizeLlmIntentType(type, rawOperationText, hasPluralTarget);
    const operation = normalizeLlmOperation(normalizedType, rawOperationText);

    intents.push({
      id: `intent_${intents.length + 1}`,
      type: normalizedType,
      operation,
      targetMentionIds,
      expectedTargetCount,
      confidence: clamp(typeof raw.confidence === "number" ? raw.confidence : 0.76, 0.05, 0.99),
      reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim().slice(0, 220) : "LLM intent parser"
    });
  });

  if (!intents.length) {
    throw new Error("LLM parser returned no targetable intents.");
  }
  return intents;
}

function normalizeLlmReferenceIntentPayload(
  value: unknown,
  parserTokens: ParserTranscriptToken[]
): { mentions: WebsiteEditMention[]; intents: WebsiteEditIntent[] } {
  const payload = value as { references?: unknown; intents?: unknown };
  if (!Array.isArray(payload?.intents) || !payload.intents.length) {
    throw new Error("LLM reference parser returned no intents.");
  }
  if (!parserTokens.length) {
    throw new Error("LLM reference parser had no transcript tokens to index.");
  }

  const references = Array.isArray(payload.references) ? payload.references : [];
  const idMap = new Map<string, string>();
  const seenRawIds = new Set<string>();
  const mentions = references.map((entry, index): WebsiteEditMention => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`LLM reference parser returned invalid reference at index ${index}.`);
    }
    const raw = entry as {
      id?: unknown;
      text?: unknown;
      startTokenIndex?: unknown;
      endTokenIndex?: unknown;
      kind?: unknown;
      targetCount?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    const rawId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `r${index + 1}`;
    if (seenRawIds.has(rawId)) {
      throw new Error(`LLM reference parser returned duplicate reference id ${rawId}.`);
    }
    seenRawIds.add(rawId);

    const startTokenIndex =
      typeof raw.startTokenIndex === "number" && Number.isInteger(raw.startTokenIndex) ? raw.startTokenIndex : -1;
    const endTokenIndex =
      typeof raw.endTokenIndex === "number" && Number.isInteger(raw.endTokenIndex) ? raw.endTokenIndex : -1;
    if (
      startTokenIndex < 0 ||
      endTokenIndex < startTokenIndex ||
      endTokenIndex >= parserTokens.length
    ) {
      throw new Error(`LLM reference parser returned invalid token span for ${rawId}.`);
    }

    const startToken = parserTokens[startTokenIndex];
    const endToken = parserTokens[endTokenIndex];
    const text = transcriptSpanText(parserTokens, startTokenIndex, endTokenIndex);
    const rawTargetCount =
      typeof raw.targetCount === "number" && Number.isFinite(raw.targetCount) ? Math.round(raw.targetCount) : 0;
    const parsedTargetCount = rawTargetCount > 1 ? rawTargetCount : parseMentionTargetCount(text);
    const kind =
      raw.kind === "plural" || (parsedTargetCount !== null && parsedTargetCount > 1) || isPluralMention(text)
        ? "plural"
        : "singular";
    const mentionId = `m${index + 1}`;
    idMap.set(rawId, mentionId);

    return {
      id: mentionId,
      text,
      startMs: startToken.startMs,
      endMs: endToken.endMs,
      startChar: startToken.startChar,
      endChar: endToken.endChar,
      startTokenIndex,
      endTokenIndex,
      source: "llm",
      kind,
      targetCount: kind === "plural" ? parsedTargetCount : null
    };
  });

  const knownMentionIds = new Set(mentions.map((mention) => mention.id));
  const allowedTypes = new Set<WebsiteEditIntentType>(WEBSITE_EDIT_INTENT_TYPES);

  const intents: WebsiteEditIntent[] = [];
  payload.intents.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`LLM reference parser returned invalid intent at index ${index}.`);
    }
    const raw = entry as {
      type?: unknown;
      operation?: unknown;
      targetReferenceIds?: unknown;
      expectedTargetCount?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    if (typeof raw.type !== "string" || !allowedTypes.has(raw.type as WebsiteEditIntentType)) {
      throw new Error(`LLM reference parser returned unsupported intent type at index ${index}.`);
    }
    if (!Array.isArray(raw.targetReferenceIds)) {
      throw new Error(`LLM reference parser returned missing targetReferenceIds at index ${index}.`);
    }

    const rawTargetReferenceIds = raw.targetReferenceIds.filter((id): id is string => typeof id === "string");
    const targetMentionIds = uniqueInOrder(
      rawTargetReferenceIds
        .map((id) => idMap.get(id))
        .filter((id): id is string => typeof id === "string" && knownMentionIds.has(id))
    );
    if (mentions.length && !targetMentionIds.length) {
      return;
    }

    const type = raw.type as WebsiteEditIntentType;
    const rawCount =
      typeof raw.expectedTargetCount === "number" && Number.isFinite(raw.expectedTargetCount)
        ? Math.round(raw.expectedTargetCount)
        : 0;
    const expectedTargetCount =
      rawCount > 0 ? rawCount : type === "swap_order" || type === "move_relative" || type === "copy_style" ? 2 : null;
    const referencedMentions = targetMentionIds
      .map((id) => mentions.find((mention) => mention.id === id))
      .filter(Boolean);
    const hasPluralTarget =
      targetMentionIds.length > 1 ||
      (expectedTargetCount !== null && expectedTargetCount > 1) ||
      referencedMentions.some((mention) => mention?.kind === "plural");
    const rawOperationText = [raw.operation, raw.reason].filter((item) => typeof item === "string").join(" ");
    const normalizedType = normalizeLlmIntentType(type, rawOperationText, hasPluralTarget);
    const operation = normalizeLlmOperation(normalizedType, rawOperationText);

    intents.push({
      id: `intent_${intents.length + 1}`,
      type: normalizedType,
      operation,
      targetMentionIds,
      expectedTargetCount,
      confidence: clamp(typeof raw.confidence === "number" ? raw.confidence : 0.76, 0.05, 0.99),
      reason:
        typeof raw.reason === "string" && raw.reason.trim()
          ? raw.reason.trim().slice(0, 220)
          : "LLM reference and intent parser"
    });
  });

  if (!intents.length) {
    throw new Error("LLM reference parser returned no targetable intents.");
  }

  return { mentions, intents };
}

export async function parseWebsiteEditReferencesAndIntentsWithLlm({
  instructionText,
  transcriptTokens,
  apiKey = process.env.OPENAI_API_KEY,
  model = WEBSITE_EDIT_INTENT_MODEL
}: {
  instructionText: string;
  transcriptTokens?: TranscriptToken[] | null;
  apiKey?: string;
  model?: string;
}): Promise<LlmReferenceIntentParserResult> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured for website edit reference parsing.");
  }

  const transcript = parserTranscriptContext(transcriptTokens, instructionText);
  if (!transcript.tokens.length) {
    throw new Error("No transcript tokens available for website edit reference parsing.");
  }

  const payload = await callIntentParserResponses(
    {
      model,
      reasoning: { effort: "low" },
      store: false,
      instructions: [
        "Parse a user's spoken website edit request into object references and edit intents.",
        "You receive a token-indexed transcript. Token indexes are 0-based and endTokenIndex is inclusive.",
        "Extract every phrase that points to drawn or on-screen objects, including vague phrases like 这个, 那个, 这一部分, 这一块, this, that, this part, the one here, these two, both of these.",
        "Use contiguous token spans exactly from the token list. Do not invent references that are not spoken.",
        "Repeated deictic phrases can be different references: in 这个这个和那个, output three separate singular references.",
        "Plural phrases that refer to a group, such as 这两个, 这几个, these two, both of these, should usually be one plural reference with targetCount when stated.",
        "Do not include relation prepositions or direction phrases in the object reference span. In 'move this to the right of the one up there', the second reference span is 'the one up there', not 'the right of the one up there'.",
        "Likewise, in Chinese, relation words such as 前面, 后面, 左边, 右边 are part of the move intent unless they are inside the object's name phrase.",
        "Then assign reference ids to edit intents in sentence order.",
        "For bulk size/color/emphasis changes, include all edited reference ids in one bulk_style_change intent.",
        "For swap/switch/reorder, use swap_order and expectedTargetCount 2.",
        "For move before/after/left/right/above/below, use move_relative and expectedTargetCount 2; the first reference is the moved item and the second reference is the anchor.",
        "For make/copy/match this like that, use copy_style and expectedTargetCount 2; the first reference is the target and the second is the reference.",
        "If there is an edit intent without an explicit spoken reference, return an empty targetReferenceIds array for that intent."
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Original request:\n${instructionText}`,
                `Display transcript:\n${transcript.text}`,
                `Token list:\n${formatParserTranscriptTokens(transcript.tokens)}`,
                "Return references first, then intents. Reference ids can be r1, r2, etc.; intents must cite only those ids."
              ].join("\n\n")
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "website_edit_references_and_intents",
          strict: true,
          schema: {
            type: "object",
            properties: {
              references: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    text: { type: "string" },
                    startTokenIndex: { type: "integer" },
                    endTokenIndex: { type: "integer" },
                    kind: { type: "string", enum: ["singular", "plural"] },
                    targetCount: { type: "integer" },
                    confidence: { type: "number" },
                    reason: { type: "string" }
                  },
                  required: [
                    "id",
                    "text",
                    "startTokenIndex",
                    "endTokenIndex",
                    "kind",
                    "targetCount",
                    "confidence",
                    "reason"
                  ],
                  additionalProperties: false
                }
              },
              intents: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: WEBSITE_EDIT_INTENT_TYPES
                    },
                    operation: { type: "string" },
                    targetReferenceIds: {
                      type: "array",
                      items: { type: "string" }
                    },
                    expectedTargetCount: { type: "integer" },
                    confidence: { type: "number" },
                    reason: { type: "string" }
                  },
                  required: [
                    "type",
                    "operation",
                    "targetReferenceIds",
                    "expectedTargetCount",
                    "confidence",
                    "reason"
                  ],
                  additionalProperties: false
                }
              }
            },
            required: ["references", "intents"],
            additionalProperties: false
          }
        }
      }
    },
    apiKey
  );

  const normalized = normalizeLlmReferenceIntentPayload(JSON.parse(extractOutputText(payload)), transcript.tokens);
  return {
    ...normalized,
    model: payload.model || model
  };
}

export async function parseWebsiteEditIntentsWithLlm({
  instructionText,
  mentions,
  apiKey = process.env.OPENAI_API_KEY,
  model = WEBSITE_EDIT_INTENT_MODEL
}: {
  instructionText: string;
  mentions: WebsiteEditMention[];
  apiKey?: string;
  model?: string;
}): Promise<LlmIntentParserResult> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured for website edit intent parsing.");
  }
  if (!mentions.length) {
    return {
      intents: parseWebsiteEditIntents(instructionText, mentions),
      model
    };
  }

  const mentionIds = mentions.map((mention) => mention.id);
  const markedInstruction = buildMentionMarkedInstruction(instructionText, mentions);
  const payload = await callIntentParserResponses(
    {
      model,
      reasoning: { effort: "low" },
      store: false,
      instructions: [
        "Parse a user's website edit request into structured edit intents.",
        "The request contains numbered deictic mentions such as [m1:这个] or [m2:this].",
        "Your job is only language parsing: assign mention ids to edit intents and roles implied by the sentence.",
        "Do not infer DOM elements, do not invent mention ids, and do not expand plural mentions into unlisted ids.",
        "Use targetMentionIds exactly from the provided mention ids.",
        "For 'this and that bigger' use bulk_style_change + operation increase_size.",
        "For swap/switch/reorder use swap_order and expectedTargetCount 2.",
        "For move before/after/left/right use move_relative and expectedTargetCount 2; the first target mention is the moved item and the second is the anchor.",
        "For 'make this like that' use copy_style and expectedTargetCount 2; first is target, second is reference.",
        "If a later plural mention like [m4:这两个] refers to selected objects, use targetMentionIds ['m4'] and expectedTargetCount 2."
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Marked request:\n${markedInstruction}`,
                `Allowed mention ids: ${mentionIds.join(", ")}`,
                "Return one or more intents that cover all explicit edit operations."
              ].join("\n\n")
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "website_edit_intents",
          strict: true,
          schema: {
            type: "object",
            properties: {
              intents: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: WEBSITE_EDIT_INTENT_TYPES
                    },
                    operation: { type: "string" },
                    targetMentionIds: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: mentionIds
                      }
                    },
                    expectedTargetCount: {
                      type: "integer"
                    },
                    confidence: {
                      type: "number"
                    },
                    reason: {
                      type: "string"
                    }
                  },
                  required: ["type", "operation", "targetMentionIds", "expectedTargetCount", "confidence", "reason"],
                  additionalProperties: false
                }
              }
            },
            required: ["intents"],
            additionalProperties: false
          }
        }
      }
    },
    apiKey
  );

  return {
    intents: normalizeLlmIntentPayload(JSON.parse(extractOutputText(payload)), mentions),
    model: payload.model || model
  };
}

function timedDistance(metric: WebsiteStrokeMetric, mention: WebsiteEditMention) {
  if (mention.startMs === null || mention.endMs === null || metric.startMs === null || metric.endMs === null) {
    return Number.POSITIVE_INFINITY;
  }

  if (metric.startMs <= mention.endMs && metric.endMs >= mention.startMs) {
    return 0;
  }
  if (metric.endMs < mention.startMs) {
    return mention.startMs - metric.endMs;
  }
  return metric.startMs - mention.endMs;
}

function chooseTimedStrokes(metrics: WebsiteStrokeMetric[], mention: WebsiteEditMention, count: number | null) {
  const ordered = [...metrics]
    .map((metric) => ({ metric, distance: timedDistance(metric, mention) }))
    .sort((left, right) => left.distance - right.distance || left.metric.index - right.metric.index);
  const safeCount = count ?? Math.max(1, ordered.filter((item) => item.distance <= 2600).length || metrics.length);
  return ordered.slice(0, safeCount).map((item) => item.metric);
}

export function bindWebsiteEditMentionsToStrokes(
  annotation: WebsiteEditAnnotation,
  mentions: WebsiteEditMention[]
): WebsiteEditMentionBinding[] {
  const metrics = strokeMetrics(annotation);
  if (!metrics.length) {
    return [];
  }

  let fallbackCursor = 0;
  const timed = metrics.some((metric) => metric.startMs !== null && metric.endMs !== null);

  return mentions.map((mention) => {
    if (timed && mention.startMs !== null && mention.endMs !== null) {
      const chosen = chooseTimedStrokes(metrics, mention, mention.kind === "plural" ? mention.targetCount : 1);
      const maxDistance = Math.max(...chosen.map((metric) => timedDistance(metric, mention)).filter(Number.isFinite), 0);
      return {
        mentionId: mention.id,
        strokeIds: chosen.map((metric) => metric.stroke.id),
        confidence: maxDistance <= 400 ? 0.92 : maxDistance <= 1500 ? 0.72 : 0.56,
        reason:
          maxDistance <= 400
            ? "mention overlaps a stroke in time"
            : `mention bound to nearest stroke timing (${Math.round(maxDistance)}ms)`
      };
    }

    const targetCount = mention.kind === "plural" ? mention.targetCount ?? metrics.length : 1;
    const chosen = metrics.slice(fallbackCursor, fallbackCursor + targetCount);
    const fallback = chosen.length ? chosen : metrics.slice(0, targetCount);
    fallbackCursor = Math.min(metrics.length, fallbackCursor + targetCount);
    return {
      mentionId: mention.id,
      strokeIds: fallback.map((metric) => metric.stroke.id),
      confidence: 0.48,
      reason: "no usable mention timing; fell back to stroke order"
    };
  });
}

function targetRoleForIntent(intent: WebsiteEditIntent, targetIndex: number): WebsiteEditResolvedTarget["role"] {
  if (intent.type === "move_relative") {
    return targetIndex === 0 ? "moved_item" : "anchor";
  }
  if (intent.type === "copy_style") {
    return targetIndex === 0 ? "target" : "reference";
  }
  return "target";
}

function preferContainerForIntent(intent: WebsiteEditIntent) {
  return intent.type === "swap_order" || intent.type === "move_relative";
}

function uniqueInOrder(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function flattenUniqueCandidates(targets: WebsiteEditResolvedTarget[]) {
  const seen = new Set<string>();
  const candidates: WebsiteEditTargetCandidate[] = [];
  targets.forEach((target) => {
    target.candidates.forEach((candidate) => {
      if (seen.has(candidate.id)) {
        return;
      }
      seen.add(candidate.id);
      candidates.push(candidate);
    });
  });
  return candidates.slice(0, 12);
}

function resolveWebsiteEditTargetsFromParsed(
  payload: WebsiteEditRequestPayload,
  mentions: WebsiteEditMention[],
  intents: WebsiteEditIntent[],
  intentParser: WebsiteEditTargetResolution["intentParser"]
): WebsiteEditTargetResolution {
  const { instructionText, annotation, domCandidates, transcriptTokens } = payload;
  const metrics = strokeMetrics(annotation);
  const mentionBindings = bindWebsiteEditMentionsToStrokes(annotation, mentions);
  const bindingByMention = new Map(mentionBindings.map((binding) => [binding.mentionId, binding]));
  const single = resolveWebsiteEditTargetWithOptions(payload);
  const shouldUseMulti =
    metrics.length > 1 ||
    mentions.length > 1 ||
    intents.length > 1 ||
    intents.some((intent) => intent.expectedTargetCount !== 1);

  if (!shouldUseMulti) {
    return {
      ...single,
      mode: "single",
      intentParser,
      annotation,
      mentions,
      mentionBindings,
      intents
    };
  }

  const targets: WebsiteEditResolvedTarget[] = [];
  intents.forEach((intent) => {
    const explicitStrokeIds = uniqueInOrder(
      intent.targetMentionIds.flatMap((mentionId) => bindingByMention.get(mentionId)?.strokeIds ?? [])
    );
    const strokeIds = explicitStrokeIds.length
      ? explicitStrokeIds
      : metrics.slice(0, intent.expectedTargetCount ?? metrics.length).map((metric) => metric.stroke.id);

    strokeIds.forEach((strokeId, targetIndex) => {
      const metric = metrics.find((item) => item.stroke.id === strokeId);
      if (!metric) {
        return;
      }
      const targetMentionIds = intent.targetMentionIds.filter((mentionId) =>
        bindingByMention.get(mentionId)?.strokeIds.includes(strokeId)
      );
      const resolved = resolveWebsiteEditTargetWithOptions(
        {
          instructionText,
          annotation: annotationForStroke(annotation, metric),
          domCandidates,
          transcriptTokens
        },
        {
          preferContainer: preferContainerForIntent(intent)
        }
      );

      targets.push({
        id: `target_${targets.length + 1}`,
        strokeId,
        strokeIndex: metric.index,
        mentionIds: targetMentionIds,
        intentIds: [intent.id],
        role: targetRoleForIntent(intent, targetIndex),
        targetElementId: resolved.targetElementId,
        targetSelector: resolved.targetSelector,
        targetDescription: resolved.targetDescription,
        confidence: resolved.confidence,
        candidates: resolved.candidates,
        bbox: metric.bbox,
        reason: resolved.reason
      });
    });
  });

  const resolvedTargets = targets.filter((target) => target.targetElementId && target.confidence >= 0.08);
  const primaryTarget = resolvedTargets[0] ?? targets[0] ?? null;
  const targetConfidence = resolvedTargets.length
    ? resolvedTargets.reduce((sum, target) => sum + target.confidence, 0) / resolvedTargets.length
    : 0;
  const bindingConfidence = mentionBindings.length
    ? mentionBindings.reduce((sum, binding) => sum + binding.confidence, 0) / mentionBindings.length
    : 0.62;
  const intentConfidence = intents.length
    ? intents.reduce((sum, intent) => sum + intent.confidence, 0) / intents.length
    : 0.52;
  const confidence = resolvedTargets.length
    ? clamp(targetConfidence * 0.72 + bindingConfidence * 0.18 + intentConfidence * 0.1, 0.08, 0.96)
    : 0;

  return {
    targetElementId: primaryTarget?.targetElementId ?? null,
    targetSelector: primaryTarget?.targetSelector ?? null,
    targetDescription:
      resolvedTargets.length > 1
        ? `${resolvedTargets.length} resolved targets across ${intents.length} edit intent${intents.length === 1 ? "" : "s"}`
        : primaryTarget?.targetDescription ?? "No matching element found near the annotation.",
    confidence,
    reason: resolvedTargets.length
      ? `Resolved ${resolvedTargets.length} target${resolvedTargets.length === 1 ? "" : "s"} from ${mentions.length} deictic mention${mentions.length === 1 ? "" : "s"} and ${metrics.length} stroke${metrics.length === 1 ? "" : "s"}.`
      : "No candidate overlapped the user's annotations enough to identify targets.",
    candidates: flattenUniqueCandidates(resolvedTargets),
    mode: resolvedTargets.length > 1 || intents.length > 1 ? "multi" : "single",
    intentParser,
    annotation,
    mentions,
    mentionBindings,
    intents,
    targets: resolvedTargets
  };
}

export function resolveWebsiteEditTargets(payload: WebsiteEditRequestPayload): WebsiteEditTargetResolution {
  const mentions = extractWebsiteEditMentions(payload.instructionText, payload.transcriptTokens);
  return resolveWebsiteEditTargetsFromParsed(payload, mentions, parseWebsiteEditIntents(payload.instructionText, mentions), {
    source: "rule",
    model: null,
    error: null
  });
}

function unresolvedLlmWebsiteEditResolution(
  payload: WebsiteEditRequestPayload,
  model: string,
  error: unknown
): WebsiteEditTargetResolution {
  const message = error instanceof Error ? error.message : String(error);
  return {
    targetElementId: null,
    targetSelector: null,
    targetDescription: "No website edit target was resolved because the LLM parser failed.",
    confidence: 0,
    reason: `LLM website edit parser failed: ${message}`,
    candidates: [],
    mode: "single",
    intentParser: {
      source: "llm",
      model,
      error: message
    },
    annotation: payload.annotation,
    mentions: [],
    mentionBindings: [],
    intents: [],
    targets: []
  };
}

export async function resolveWebsiteEditTargetsWithIntentParser(
  payload: WebsiteEditRequestPayload,
  options: {
    preferLlm?: boolean;
    apiKey?: string;
    model?: string;
  } = {}
): Promise<WebsiteEditTargetResolution> {
  const preferLlm = options.preferLlm ?? true;

  if (!preferLlm) {
    return resolveWebsiteEditTargets(payload);
  }

  try {
    const parsed = await parseWebsiteEditReferencesAndIntentsWithLlm({
      instructionText: payload.instructionText,
      transcriptTokens: payload.transcriptTokens,
      apiKey: options.apiKey,
      model: options.model
    });
    return resolveWebsiteEditTargetsFromParsed(payload, parsed.mentions, parsed.intents, {
      source: "llm",
      model: parsed.model,
      error: null
    });
  } catch (primaryError) {
    return unresolvedLlmWebsiteEditResolution(payload, options.model ?? WEBSITE_EDIT_INTENT_MODEL, primaryError);
  }
}

export function buildWebsiteEditPrompt({
  parentJob,
  instructionText,
  targetResolution,
  qualityFeedback
}: {
  parentJob: WebsiteJob;
  instructionText: string;
  targetResolution: WebsiteEditTargetResolution;
  qualityFeedback?: string | null;
}) {
  const targetHeading = targetResolution.mode === "multi" ? "Resolved edit plan:" : "Resolved target:";
  const multiTargetInstructions =
    targetResolution.mode === "multi"
      ? [
          "The resolved edit plan may contain multiple targets and multiple intents.",
          "Use `intents` to understand the user's operations, and use each target's selector, visible text, role, bbox, strokeIndex, and role to apply the operation.",
          "For `swap_order`, swap only the selected rendered items. Prefer changing the source array or JSX order that controls those items.",
          "For `move_relative`, move the `moved_item` target relative to the `anchor` target. Preserve unrelated layout.",
          "For `bulk_style_change`, apply the same requested local change to all selected targets."
        ]
      : [
          "Use the target selector, visible text, role, bounding box, and candidate list to find the matching JSX/CSS in the source tree."
        ];

  return [
    "You are editing an existing Vite + React + TypeScript website in place.",
    "Make localized source changes that are visibly sufficient to satisfy the user's selected edit request.",
    "Do not rebuild the site from scratch. Do not redesign unrelated sections. Preserve existing content, routes, and styling outside the selected regions.",
    "Inside the selected circled regions, structural JSX and CSS changes are allowed when the request is about visual quality, spacing, alignment, hierarchy, cramped layout, weak CTA hierarchy, or something looking wrong.",
    "Do not stop at tiny numeric spacing tweaks if a normal user would still say the selected area looks unchanged. The final screenshot should show an obvious improvement in each selected target.",
    "If an annotated screenshot is attached, use it as visual confirmation of the user's circles alongside the structured target plan. The JSON plan is the source of truth for selectors and intent roles; the image is a second reference for spatial context.",
    "When target candidates include `imageSrcs`, treat those as existing rendered image assets. Preserve the corresponding source asset import paths unless the request requires layout changes; the pipeline may replace those same asset files before build for image-specific edit requests.",
    ...multiTargetInstructions,
    "If the exact selector does not appear in source because class names changed during build, inspect nearby copy and component structure to locate the same rendered element.",
    "Before finishing, run `npm run build`. If you can inspect the rendered page, compare it against the annotated screenshot and keep iterating until the circled regions visibly satisfy the request.",
    "Keep the project buildable with `npm run build`.",
    "",
    `Parent website: ${parentJob.displayName}`,
    `Parent generation prompt: ${clipForWebsiteEditPrompt(parentJob.prompt, 2500) || "(not recorded)"}`,
    "",
    "User edit request:",
    clipForWebsiteEditPrompt(instructionText, 1000),
    "",
    targetHeading,
    JSON.stringify(compactWebsiteEditTargetResolutionForPrompt(targetResolution), null, 2),
    ...(qualityFeedback?.trim()
      ? [
          "",
          "Automated visual QA feedback from a previous edit attempt:",
          qualityFeedback.trim(),
          "Repair the current source so the selected regions pass that feedback."
        ]
      : []),
    "",
    "Files available:",
    "- /vercel/sandbox/input/edit-request.json",
    "- /vercel/sandbox/input/target-resolution.json",
    "- /vercel/sandbox/input/annotation.json",
    "- /vercel/sandbox/input/annotated-screenshot.png (attached when the user submitted a visual reference)",
    "- /vercel/sandbox/input/visual-reference.json (attached with visual reference metadata)",
    "",
    "Apply the edit now."
  ].join("\n");
}
