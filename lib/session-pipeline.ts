import {
  getSessionAsset,
  getSessionDetail,
  saveSessionAnalysis,
  saveSessionAsset,
  updateSessionPreferences
} from "@/lib/session-store";
import {
  extractSceneFromTranscript,
  generateImageFromSketch,
  groundSceneExtraction,
  renderAnnotatedSketchPng,
  renderSketchPng
} from "@/lib/scene-analysis";
import { buildDisplayTranscript } from "@/lib/transcript-format";
import {
  AnalysisReasoningEffort,
  ImageFollowMode,
  ImageGenerationProfile,
  ImageGenerationSource,
  ImageSizePreset,
  SessionDetail
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

export async function refreshSessionDetail(sessionId: string): Promise<SessionDetail> {
  return getRequiredSession(sessionId);
}
