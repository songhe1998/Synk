import {
  WebsiteEditAnnotation,
  WebsiteEditDomCandidate,
  WebsiteEditRect,
  WebsiteEditTargetCandidate,
  WebsiteEditTargetResolution,
  WebsiteJob
} from "@/lib/types";

export interface WebsiteEditRequestPayload {
  instructionText: string;
  annotation: WebsiteEditAnnotation;
  domCandidates: WebsiteEditDomCandidate[];
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
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function includesAny(value: string, words: string[]) {
  return words.some((word) => value.includes(word));
}

function uniquePoints(annotation: WebsiteEditAnnotation) {
  return annotation.strokes.flatMap((stroke) => stroke.points);
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

  if (includesAny(instruction, ["button", "cta", "signup", "sign up", "call to action", "link"])) {
    if (category.isButtonLike) {
      boost += 0.34;
      reasons.push("button-like element matches request");
    }
  }

  if (includesAny(instruction, ["headline", "heading", "title", "copy", "text", "wording"])) {
    if (category.isHeadingLike || candidate.text) {
      boost += category.isHeadingLike ? 0.3 : 0.14;
      reasons.push("text element matches request");
    }
  }

  if (includesAny(instruction, ["image", "photo", "picture", "visual", "illustration"])) {
    if (category.isImageLike) {
      const directImageBoost = category.tag === "img" || category.tag === "picture" || category.tag === "svg";
      boost += directImageBoost ? 0.4 : 0.18;
      reasons.push(directImageBoost ? "direct image element matches request" : "image-like container matches request");
    }
  }

  if (includesAny(instruction, ["card", "panel", "box", "section", "area", "block"])) {
    if (category.isCardLike || category.isHeaderLike) {
      boost += 0.28;
      reasons.push("container-like element matches request");
    }
  }

  if (includesAny(instruction, ["nav", "menu", "header"])) {
    if (category.isNavLike || category.isHeaderLike) {
      boost += 0.28;
      reasons.push("navigation/header element matches request");
    }
  }

  if (includesAny(instruction, ["footer", "bottom"])) {
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
  instruction: string
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
  const isHuge = candidateArea / viewportArea > 0.58;
  const isVeryLarge = candidateArea / viewportArea > 0.32;
  const compactnessBoost = candidateCoverage > 0.7 && candidateArea / viewportArea < 0.18 ? 0.12 : 0;
  const containerIntent = includesAny(instruction, ["card", "panel", "section", "area", "block"]);
  const containerBoost = containerIntent && annotationCoverage > 0.2 && category.isCardLike ? 0.14 : 0;
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
      containerBoost -
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

  return {
    id: candidate.id,
    selector: candidate.selector,
    tagName: candidate.tagName,
    role: candidate.role,
    text: candidate.text,
    rect: candidate.rect,
    score,
    reason: reasonParts.join("; ")
  };
}

export function resolveWebsiteEditTarget({
  instructionText,
  annotation,
  domCandidates
}: WebsiteEditRequestPayload): WebsiteEditTargetResolution {
  const instruction = normalizeText(instructionText);
  const scored = domCandidates
    .map((candidate) => scoreCandidate(candidate, annotation, instruction))
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

export function buildWebsiteEditPrompt({
  parentJob,
  instructionText,
  targetResolution
}: {
  parentJob: WebsiteJob;
  instructionText: string;
  targetResolution: WebsiteEditTargetResolution;
}) {
  return [
    "You are editing an existing Vite + React + TypeScript website in place.",
    "Make the smallest source changes needed to satisfy the user's local edit request.",
    "Do not rebuild the site from scratch. Do not redesign unrelated sections. Preserve existing content, layout, components, routes, and styling unless the selected target requires a local adjustment.",
    "Use the target selector, visible text, role, bounding box, and candidate list to find the matching JSX/CSS in the source tree.",
    "If the exact selector does not appear in source because class names changed during build, inspect nearby copy and component structure to locate the same rendered element.",
    "Keep the project buildable with `npm run build`.",
    "",
    `Parent website: ${parentJob.displayName}`,
    `Parent generation prompt: ${parentJob.prompt || "(not recorded)"}`,
    "",
    "User edit request:",
    instructionText.trim(),
    "",
    "Resolved target:",
    JSON.stringify(targetResolution, null, 2),
    "",
    "Files available:",
    "- /vercel/sandbox/input/edit-request.json",
    "- /vercel/sandbox/input/target-resolution.json",
    "- /vercel/sandbox/input/annotation.json",
    "",
    "Apply the edit now."
  ].join("\n");
}
