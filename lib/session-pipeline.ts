import {
  getSessionAsset,
  getSessionDetail,
  getSessionImageEditAsset,
  saveSessionAnalysis,
  saveSessionAsset,
  saveSessionImageEditHistoryItem,
  updateSessionPreferences
} from "@/lib/session-store";
import sharp from "sharp";
import {
  extractSceneFromTranscript,
  generateEditedImageFromImage,
  generateReferenceRestoredImage,
  generateImageFromSketch,
  groundSceneExtraction,
  renderAnnotatedSketchPng,
  renderSketchPng,
  writeImageEditPrompt
} from "@/lib/scene-analysis";
import { buildDisplayTranscript } from "@/lib/transcript-format";
import {
  AnalysisReasoningEffort,
  AssetKind,
  ImageEditAnnotation,
  ImageFollowMode,
  ImageGenerationProfile,
  ImageGenerationSource,
  ImageSizePreset,
  SessionDetail,
  TranscriptToken
} from "@/lib/types";

function getOpenAiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  return apiKey;
}

async function getRequiredSession(sessionId: string) {
  const session = await getSessionDetail(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  return session;
}

export async function ensureSessionAnalysis({
  sessionId,
  reasoningEffort,
  imageGenerationProfile,
  imageFollowMode,
  force = false
}: {
  sessionId: string;
  reasoningEffort?: AnalysisReasoningEffort;
  imageGenerationProfile?: ImageGenerationProfile;
  imageFollowMode?: ImageFollowMode;
  force?: boolean;
}) {
  if (reasoningEffort || imageGenerationProfile || imageFollowMode) {
    await updateSessionPreferences(sessionId, {
      analysisReasoningEffort: reasoningEffort,
      imageGenerationProfile,
      imageFollowMode
    });
  }

  const session = await getRequiredSession(sessionId);
  if (session.analysis && !force) {
    return session;
  }

  if (session.transcript.length === 0) {
    throw new Error("Transcript is required before analysis.");
  }

  const transcriptText = buildDisplayTranscript(session.transcript);
  const extraction = await extractSceneFromTranscript(
    transcriptText,
    getOpenAiKey(),
    session.analysisReasoningEffort,
    session.imageGenerationProfile
  );

  const groundedAnalysis = groundSceneExtraction({
    transcript: session.transcript,
    events: session.events,
    extractionModel: extraction.model,
    extraction: extraction.parsed,
    canvasWidth: session.canvasWidth,
    canvasHeight: session.canvasHeight
  });

  const existingSketch = await getSessionAsset(sessionId, "sketch");
  const sketchBuffer =
    existingSketch?.buffer ??
    (await renderSketchPng({
      events: session.events,
      width: session.canvasWidth,
      height: session.canvasHeight
    }));

  if (!existingSketch) {
    await saveSessionAsset(sessionId, "sketch", sketchBuffer);
  }

  const annotatedSketch = await renderAnnotatedSketchPng({
    baseSketch: sketchBuffer,
    analysis: groundedAnalysis,
    canvasWidth: session.canvasWidth,
    canvasHeight: session.canvasHeight
  });

  await saveSessionAnalysis(sessionId, groundedAnalysis);
  await saveSessionAsset(sessionId, "annotatedSketch", annotatedSketch);

  return getRequiredSession(sessionId);
}

export async function ensureSessionGeneratedImage({
  sessionId,
  source = "labeled",
  reasoningEffort,
  imageSizePreset,
  imageGenerationProfile,
  imageFollowMode,
  forceAnalysis = false,
  force = false
}: {
  sessionId: string;
  source?: ImageGenerationSource;
  reasoningEffort?: AnalysisReasoningEffort;
  imageSizePreset?: ImageSizePreset;
  imageGenerationProfile?: ImageGenerationProfile;
  imageFollowMode?: ImageFollowMode;
  forceAnalysis?: boolean;
  force?: boolean;
}) {
  if (imageSizePreset || imageGenerationProfile || imageFollowMode) {
    await updateSessionPreferences(sessionId, {
      imageSizePreset,
      imageGenerationProfile,
      imageFollowMode
    });
  }

  let session = await ensureSessionAnalysis({
    sessionId,
    reasoningEffort,
    imageGenerationProfile,
    imageFollowMode,
    force: forceAnalysis
  });

  const existingTarget =
    source === "labeled" ? session.generatedImageLabeledUrl : session.generatedImagePlainUrl;
  if (existingTarget && !force) {
    return session;
  }

  const sourceAssetKind = source === "labeled" ? "annotatedSketch" : "sketch";
  const sourceSketch = await getSessionAsset(sessionId, sourceAssetKind);
  if (!sourceSketch) {
    throw new Error(source === "labeled" ? "Annotated sketch is missing." : "Plain sketch is missing.");
  }

  const image = await generateImageFromSketch({
    prompt: session.analysis!.generationPrompt,
    sketchImage: sourceSketch.buffer,
    apiKey: getOpenAiKey(),
    width: session.canvasWidth,
    height: session.canvasHeight,
    source,
    imageSizePreset: session.imageSizePreset,
    profile: session.imageGenerationProfile,
    imageFollowMode: session.imageFollowMode
  });

  await saveSessionAsset(
    sessionId,
    source === "labeled" ? "generatedImageLabeled" : "generatedImagePlain",
    image.buffer
  );

  session = await getRequiredSession(sessionId);
  return session;
}

export async function createImageExperience({
  sessionId,
  reasoningEffort,
  imageSizePreset,
  imageGenerationProfile,
  imageFollowMode
}: {
  sessionId: string;
  reasoningEffort?: AnalysisReasoningEffort;
  imageSizePreset?: ImageSizePreset;
  imageGenerationProfile?: ImageGenerationProfile;
  imageFollowMode?: ImageFollowMode;
}) {
  return ensureSessionGeneratedImage({
    sessionId,
    source: "labeled",
    reasoningEffort,
    imageSizePreset,
    imageGenerationProfile,
    imageFollowMode
  });
}

export async function editSessionGeneratedImage({
  sessionId,
  transcriptText,
  transcriptTokens,
  annotation,
  annotatedImage,
  sourceAssetKind
}: {
  sessionId: string;
  transcriptText: string;
  transcriptTokens?: TranscriptToken[] | null;
  annotation: ImageEditAnnotation;
  annotatedImage: Buffer;
  sourceAssetKind?: Extract<
    AssetKind,
    "editedImage" | "generatedImageLabeled" | "generatedImagePlain" | "generatedImage"
  >;
}) {
  const session = await ensureSessionAnalysis({
    sessionId
  });

  const resolvedSourceAssetKind =
    sourceAssetKind ??
    (session.editedImageUrl
      ? "editedImage"
      : session.generatedImageLabeledUrl
        ? "generatedImageLabeled"
        : session.generatedImagePlainUrl
          ? "generatedImagePlain"
          : session.generatedImageUrl
            ? "generatedImage"
            : null);

  if (!resolvedSourceAssetKind) {
    throw new Error("A generated image is required before editing.");
  }

  const sourceImage = await getSessionAsset(sessionId, resolvedSourceAssetKind);
  if (!sourceImage) {
    throw new Error("The selected image for editing is missing.");
  }

  const promptPackage = await writeImageEditPrompt({
    currentImage: sourceImage.buffer,
    annotatedImage,
    transcriptText,
    transcriptTokens,
    annotation,
    analysis: session.analysis,
    apiKey: getOpenAiKey(),
    profile: session.imageGenerationProfile
  });

  const metadata = await sharp(sourceImage.buffer).metadata().catch(() => null);
  const editedImage = await generateEditedImageFromImage({
    prompt: promptPackage.edit_prompt,
    image: annotatedImage,
    apiKey: getOpenAiKey(),
    width: metadata?.width ?? session.canvasWidth,
    height: metadata?.height ?? session.canvasHeight,
    imageSizePreset: session.imageSizePreset,
    profile: session.imageGenerationProfile
  });

  await saveSessionImageEditHistoryItem({
    sessionId,
    sourceAssetKind: resolvedSourceAssetKind,
    transcriptText,
    targetDescription: promptPackage.target_description,
    requestedChange: promptPackage.requested_change,
    editPrompt: promptPackage.edit_prompt,
    editedImage: editedImage.buffer,
    annotatedImage,
    annotation
  });
  await saveSessionAsset(sessionId, "editedImage", editedImage.buffer);

  return {
    session: await getRequiredSession(sessionId),
    editPrompt: promptPackage.edit_prompt,
    targetDescription: promptPackage.target_description,
    requestedChange: promptPackage.requested_change
  };
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getStrokePath(points: Array<{ x: number; y: number }>, scaleX: number, scaleY: number) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${(point.x * scaleX).toFixed(1)} ${(point.y * scaleY).toFixed(1)}`)
    .join(" ");
}

async function renderProtectionMarkersOnImage({
  baseImage,
  annotations
}: {
  baseImage: Buffer;
  annotations: ImageEditAnnotation[];
}) {
  if (!annotations.length) {
    return baseImage;
  }

  const metadata = await sharp(baseImage).metadata();
  const width = metadata.width ?? 1536;
  const height = metadata.height ?? 1024;
  const paths = annotations
    .flatMap((annotation, annotationIndex) => {
      const scaleX = width / Math.max(1, annotation.viewportWidth);
      const scaleY = height / Math.max(1, annotation.viewportHeight);
      return annotation.strokes.map((stroke, strokeIndex) => {
        const pathData = getStrokePath(stroke.points, scaleX, scaleY);
        if (!pathData) {
          return "";
        }
        const hue = (annotationIndex * 72 + strokeIndex * 31) % 360;
        const strokeWidth = Math.max(4, ((scaleX + scaleY) / 2) * 4);
        return `<path d="${escapeXml(pathData)}" fill="none" stroke="hsl(${hue} 95% 58%)" stroke-width="${strokeWidth.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.95" />`;
      });
    })
    .join("");

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths}</svg>`
  );

  return sharp(baseImage).composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer();
}

function ellipseAnnotationFromBbox({
  bbox,
  imageWidth,
  imageHeight,
  id
}: {
  bbox: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
  id: string;
}): ImageEditAnnotation {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const rx = Math.max(8, bbox.width / 2);
  const ry = Math.max(8, bbox.height / 2);
  const points = Array.from({ length: 81 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 80;
    return {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
      tMs: index * 10
    };
  });
  return {
    viewportWidth: imageWidth,
    viewportHeight: imageHeight,
    devicePixelRatio: 1,
    bbox,
    strokes: [
      {
        id,
        color: "#00d4ff",
        points,
        startMs: 0,
        endMs: 800
      }
    ]
  };
}

async function extractLikelyMarkerAnnotation(markedImage: Buffer, id: string): Promise<ImageEditAnnotation | null> {
  const image = sharp(markedImage).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    return null;
  }
  const data = await image.raw().toBuffer();
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const brightWhite = red > 232 && green > 232 && blue > 232;
      const saturatedGuide = max > 150 && max - min > 70;
      if (brightWhite || saturatedGuide) {
        mask[y * width + x] = 1;
      }
    }
  }

  const seen = new Uint8Array(width * height);
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);
  const candidates: Array<{ count: number; x: number; y: number; width: number; height: number; score: number }> = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (!mask[start] || seen[start]) {
        continue;
      }
      let head = 0;
      let tail = 0;
      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;
      seen[start] = 1;

      while (head < tail) {
        const currentX = queueX[head];
        const currentY = queueY[head];
        head += 1;
        count += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);

        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ]) {
          const nextX = currentX + dx;
          const nextY = currentY + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            continue;
          }
          const nextIndex = nextY * width + nextX;
          if (mask[nextIndex] && !seen[nextIndex]) {
            seen[nextIndex] = 1;
            queueX[tail] = nextX;
            queueY[tail] = nextY;
            tail += 1;
          }
        }
      }

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const area = boxWidth * boxHeight;
      const fill = count / Math.max(1, area);
      const fitsMarkerScale =
        count >= 20 &&
        boxWidth >= 8 &&
        boxHeight >= 8 &&
        boxWidth <= width * 0.35 &&
        boxHeight <= height * 0.35 &&
        fill >= 0.02 &&
        fill <= 0.82;
      if (fitsMarkerScale) {
        const squareness = Math.min(boxWidth, boxHeight) / Math.max(boxWidth, boxHeight);
        const score = count * 0.6 + squareness * 120 - fill * 25;
        candidates.push({ count, x: minX, y: minY, width: boxWidth, height: boxHeight, score });
      }
    }
  }

  const best = candidates.sort((left, right) => right.score - left.score)[0];
  return best ? ellipseAnnotationFromBbox({ bbox: best, imageWidth: width, imageHeight: height, id }) : null;
}

async function resolveReferenceImage({
  sessionId,
  session,
  referenceRevisionNumber
}: {
  sessionId: string;
  session: SessionDetail;
  referenceRevisionNumber: number;
}) {
  if (referenceRevisionNumber <= 0) {
    const initialAssetKind = session.generatedImageLabeledUrl
      ? "generatedImageLabeled"
      : session.generatedImagePlainUrl
        ? "generatedImagePlain"
        : "generatedImage";
    const asset = await getSessionAsset(sessionId, initialAssetKind);
    if (!asset) {
      throw new Error("The initial reference image is missing.");
    }
    return { buffer: asset.buffer, label: "initial image" };
  }

  const item = session.imageEditHistory?.find((historyItem) => historyItem.revisionNumber === referenceRevisionNumber);
  if (!item) {
    throw new Error("The selected reference edit is missing.");
  }
  const asset = await getSessionImageEditAsset(sessionId, item.id, "image");
  if (!asset) {
    throw new Error("The selected reference image asset is missing.");
  }
  return { buffer: asset.buffer, label: `edit ${referenceRevisionNumber}` };
}

async function buildProtectionAnnotations({
  sessionId,
  historyAfterReference
}: {
  sessionId: string;
  historyAfterReference: NonNullable<SessionDetail["imageEditHistory"]>;
}) {
  const annotations: ImageEditAnnotation[] = [];
  for (const item of historyAfterReference) {
    if (item.annotation?.strokes?.length) {
      annotations.push(item.annotation);
      continue;
    }

    const markedAsset = await getSessionImageEditAsset(sessionId, item.id, "annotation");
    if (!markedAsset) {
      continue;
    }
    const extracted = await extractLikelyMarkerAnnotation(markedAsset.buffer, `restore-fallback-${item.id}`);
    if (extracted) {
      annotations.push(extracted);
    }
  }
  return annotations;
}

export async function restoreSessionImageFromReference({
  sessionId,
  referenceRevisionNumber
}: {
  sessionId: string;
  referenceRevisionNumber: number;
}) {
  const session = await getRequiredSession(sessionId);
  const history = [...(session.imageEditHistory ?? [])].sort((left, right) => left.revisionNumber - right.revisionNumber);
  const latestRevisionNumber = history.reduce((max, item) => Math.max(max, item.revisionNumber), 0);
  if (referenceRevisionNumber >= latestRevisionNumber) {
    throw new Error("Choose an earlier image as the restore reference.");
  }

  const currentImage = await getSessionAsset(sessionId, "editedImage");
  if (!currentImage) {
    throw new Error("A current edited image is required before reference restore.");
  }

  const reference = await resolveReferenceImage({ sessionId, session, referenceRevisionNumber });
  const historyAfterReference = history.filter((item) => item.revisionNumber > referenceRevisionNumber);
  const protectionAnnotations = await buildProtectionAnnotations({ sessionId, historyAfterReference });
  const protectedCurrentImage = await renderProtectionMarkersOnImage({
    baseImage: currentImage.buffer,
    annotations: protectionAnnotations
  });

  const metadata = await sharp(currentImage.buffer).metadata().catch(() => null);
  const protectedRevisionNumbers = historyAfterReference.map((item) => item.revisionNumber);
  const prompt = [
    "This is a reference restore image editing task.",
    "Input image 1 is the current image. It may include colored protection circles.",
    `Input image 2 is the quality/style reference: ${reference.label}.`,
    "Improve input image 1 so its overall fidelity, detail, texture quality, lighting coherence, sharpness, and polished photographic quality match input image 2.",
    "Keep the composition and all user-visible content of input image 1.",
    protectionAnnotations.length
      ? "The colored circles in input image 1 mark edits that happened after the selected reference. Preserve the circled regions and their edited content exactly; do not undo, shrink, recolor, replace, or reinterpret anything inside those circles."
      : "No protected edit circles are available; preserve the current image content while restoring quality.",
    "Outside protected circles, remove accumulated generation drift, softness, artifacts, and quality downgrade by matching the reference image's level of detail and finish.",
    "Remove all colored marker circles from the final output. Do not add labels, outlines, arrows, or explanatory text."
  ].join(" ");

  const restoredImage = await generateReferenceRestoredImage({
    prompt,
    currentImage: protectedCurrentImage,
    referenceImage: reference.buffer,
    apiKey: getOpenAiKey(),
    width: metadata?.width ?? session.canvasWidth,
    height: metadata?.height ?? session.canvasHeight,
    imageSizePreset: session.imageSizePreset,
    profile: session.imageGenerationProfile
  });
  const requestedChange = JSON.stringify(
    {
      mode: "reference_restore",
      referenceRevisionNumber,
      protectedRevisionNumbers
    },
    null,
    2
  );

  await saveSessionImageEditHistoryItem({
    sessionId,
    sourceAssetKind: "editedImage",
    transcriptText: `Restore quality from ${reference.label}`,
    targetDescription: protectionAnnotations.length
      ? `Protected later edits: ${protectedRevisionNumbers.join(", ")}`
      : "No protected later edit markers available",
    requestedChange,
    editPrompt: prompt,
    editedImage: restoredImage.buffer,
    annotatedImage: protectedCurrentImage,
    annotation: {
      viewportWidth: metadata?.width ?? session.canvasWidth,
      viewportHeight: metadata?.height ?? session.canvasHeight,
      devicePixelRatio: 1,
      bbox: { x: 0, y: 0, width: metadata?.width ?? session.canvasWidth, height: metadata?.height ?? session.canvasHeight },
      strokes: protectionAnnotations.flatMap((annotation) => annotation.strokes)
    }
  });
  await saveSessionAsset(sessionId, "editedImage", restoredImage.buffer);

  return {
    session: await getRequiredSession(sessionId),
    editPrompt: prompt,
    requestedChange,
    targetDescription: `Restored from ${reference.label}`
  };
}

export async function refreshSessionDetail(sessionId: string): Promise<SessionDetail> {
  return getRequiredSession(sessionId);
}
