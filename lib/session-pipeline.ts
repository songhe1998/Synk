import {
  getSessionAsset,
  getSessionDetail,
  saveSessionAnalysis,
  saveSessionAsset,
  updateSessionPreferences
} from "@/lib/session-store";
import sharp from "sharp";
import {
  extractSceneFromTranscript,
  generateEditedImageFromImage,
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
  imageFollowMode
}: {
  sessionId: string;
  reasoningEffort?: AnalysisReasoningEffort;
  imageGenerationProfile?: ImageGenerationProfile;
  imageFollowMode?: ImageFollowMode;
}) {
  if (reasoningEffort || imageGenerationProfile || imageFollowMode) {
    await updateSessionPreferences(sessionId, {
      analysisReasoningEffort: reasoningEffort,
      imageGenerationProfile,
      imageFollowMode
    });
  }

  const session = await getRequiredSession(sessionId);
  if (session.analysis) {
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
    extraction: extraction.parsed
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
  force = false
}: {
  sessionId: string;
  source?: ImageGenerationSource;
  reasoningEffort?: AnalysisReasoningEffort;
  imageSizePreset?: ImageSizePreset;
  imageGenerationProfile?: ImageGenerationProfile;
  imageFollowMode?: ImageFollowMode;
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
    imageFollowMode
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
    image: sourceImage.buffer,
    apiKey: getOpenAiKey(),
    width: metadata?.width ?? session.canvasWidth,
    height: metadata?.height ?? session.canvasHeight,
    imageSizePreset: session.imageSizePreset,
    profile: session.imageGenerationProfile
  });

  await saveSessionAsset(sessionId, "editedImage", editedImage.buffer);

  return {
    session: await getRequiredSession(sessionId),
    editPrompt: promptPackage.edit_prompt,
    targetDescription: promptPackage.target_description,
    requestedChange: promptPackage.requested_change
  };
}

export async function refreshSessionDetail(sessionId: string): Promise<SessionDetail> {
  return getRequiredSession(sessionId);
}
