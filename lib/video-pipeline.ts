import sharp from "sharp";
import { ensureSessionGeneratedImage } from "@/lib/session-pipeline";
import {
  getSessionAsset,
  getSessionDetail,
  getSessionVideoSourcePlan,
  saveSessionAsset,
  saveSessionVideoSourcePlan
} from "@/lib/session-store";
import {
  assertMuApiConfigured,
  createMuApiVideoPrediction,
  downloadMuApiAsset,
  extractMuApiVideoUrl,
  getMuApiPredictionError,
  getMuApiPredictionResult,
  getMuApiPredictionStatus,
  inferVideoAspectRatio,
  uploadMuApiImage
} from "@/lib/muapi";
import {
  generateImageFromSketch,
  groundObjectsFromTranscriptAndEvents,
  renderGroundedSketchPng,
  renderSketchPng
} from "@/lib/scene-analysis";
import { buildDisplayTranscript } from "@/lib/transcript-format";
import { extractVideoSourcePlan } from "@/lib/video-source-plan";
import { reviewVideoSourceImage } from "@/lib/video-source-review";
import { writeDynamicVideoProviderPrompt, writeNormalVideoProviderPrompt } from "@/lib/video-prompt";
import { createVideoJob, getVideoJob, saveVideoJobAsset, updateVideoJob } from "@/lib/video-store";
import {
  VideoAspectRatio,
  VideoJob,
  VideoModelPreset,
  VideoPipelineMode,
  VideoResolution,
  VideoSourcePlan
} from "@/lib/types";

const DEFAULT_VIDEO_DURATION_SECONDS = 5;
const DEFAULT_VIDEO_RESOLUTION: VideoResolution = "720p";
const DEFAULT_VIDEO_CAMERA_FIXED = false;

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

function buildVideoDisplayName(
  title: string,
  modelPreset: VideoModelPreset,
  pipelineMode: VideoPipelineMode
) {
  return `${title} ${pipelineMode === "dynamic" ? "Dynamic " : ""}${modelPreset === "quality" ? "Quality" : "Lite"} Video`.slice(0, 80);
}

function buildVideoSourceImageRenderPrompt(sourceImagePrompt: string) {
  return [
    sourceImagePrompt.trim(),
    "Preserve each subject's left-right orientation, facing direction, and starting trajectory exactly as described.",
    "Do not mirror the composition.",
    "Do not reverse any subject's motion direction."
  ]
    .filter(Boolean)
    .join(" ");
}

async function generateReviewedVideoSourceImage({
  transcriptText,
  sourceImagePrompt,
  labeledSketch,
  apiKey,
  width,
  height,
  imageSizePreset,
  profile
}: {
  transcriptText: string;
  sourceImagePrompt: string;
  labeledSketch: Buffer;
  apiKey: string;
  width: number;
  height: number;
  imageSizePreset: Awaited<ReturnType<typeof getRequiredSession>>["imageSizePreset"];
  profile: Awaited<ReturnType<typeof getRequiredSession>>["imageGenerationProfile"];
}) {
  const baseRenderPrompt = buildVideoSourceImageRenderPrompt(sourceImagePrompt);
  let image = await generateImageFromSketch({
    prompt: baseRenderPrompt,
    sketchImage: labeledSketch,
    apiKey,
    width,
    height,
    source: "labeled",
    imageSizePreset,
    profile
  });

  try {
    const review = await reviewVideoSourceImage({
      transcriptText,
      sourceImagePrompt,
      labeledSketch,
      sourceImage: image.buffer
    });

    if (!review.passes && review.correctionPrompt) {
      image = await generateImageFromSketch({
        prompt: `${baseRenderPrompt} ${review.correctionPrompt}`.trim(),
        sketchImage: labeledSketch,
        apiKey,
        width,
        height,
        source: "labeled",
        imageSizePreset,
        profile
      });
    }
  } catch (error) {
    console.warn("Video source image review failed; keeping the first generated source image.", error);
  }

  return image;
}

function getVideoStatusDetail(status: string) {
  switch (status) {
    case "pending":
      return "Queued on MuAPI.";
    case "processing":
      return "MuAPI is generating the video.";
    case "completed":
      return "MuAPI finished the generation.";
    case "failed":
      return "MuAPI reported a failed generation.";
    default:
      return `MuAPI status: ${status}.`;
  }
}

function videoHasLocalAsset(job: VideoJob) {
  return Boolean(job.videoUrl && job.videoFileName);
}

async function finalizeVideoJobFromResult(sessionId: string, job: VideoJob) {
  if (!job.requestId) {
    return job;
  }

  const result = await getMuApiPredictionResult(job.requestId);
  const status = getMuApiPredictionStatus(result);

  if (status === "pending" || status === "processing") {
    return updateVideoJob(sessionId, job.id, (current) => ({
      ...current,
      status: "running",
      statusDetail: getVideoStatusDetail(status)
    }));
  }

  if (status === "failed") {
    return updateVideoJob(sessionId, job.id, (current) => ({
      ...current,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: getMuApiPredictionError(result) || "MuAPI failed to generate the video.",
      statusDetail: getVideoStatusDetail(status)
    }));
  }

  const remoteVideoUrl = extractMuApiVideoUrl(result);
  if (!remoteVideoUrl) {
    return updateVideoJob(sessionId, job.id, (current) => ({
      ...current,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: "MuAPI completed the prediction but returned no video URL.",
      statusDetail: getVideoStatusDetail(status)
    }));
  }

  const downloaded = await downloadMuApiAsset(remoteVideoUrl);
  const fileExtension = downloaded.mimeType.includes("quicktime")
    ? "mov"
    : downloaded.mimeType.includes("webm")
      ? "webm"
      : "mp4";

  await updateVideoJob(sessionId, job.id, (current) => ({
    ...current,
    status: "running",
    remoteVideoUrl,
    statusDetail: "Downloading the generated video into session storage."
  }));

  const persisted = await saveVideoJobAsset(sessionId, job.id, {
    buffer: downloaded.buffer,
    fileName: `video-${job.id}.${fileExtension}`,
    mimeType: downloaded.mimeType
  });

  return updateVideoJob(sessionId, job.id, (current) => ({
    ...current,
    ...persisted,
    status: "succeeded",
    completedAt: new Date().toISOString(),
    remoteVideoUrl,
    errorMessage: null,
    statusDetail: "Video is ready."
  }));
}

async function ensureSketchAsset(sessionId: string, session: Awaited<ReturnType<typeof getRequiredSession>>) {
  const existingSketch = await getSessionAsset(sessionId, "sketch");
  if (existingSketch) {
    return existingSketch;
  }

  const sketchBuffer = await renderSketchPng({
    events: session.events,
    width: session.canvasWidth,
    height: session.canvasHeight
  });
  await saveSessionAsset(sessionId, "sketch", sketchBuffer);
  return {
    buffer: sketchBuffer,
    fileName: "sketch.png",
    mimeType: "image/png"
  };
}

async function ensureVideoSourcePlan(sessionId: string) {
  const session = await getRequiredSession(sessionId);
  if (session.transcript.length === 0) {
    throw new Error("Transcript is required before creating a video.");
  }

  const existingPlan = await getSessionVideoSourcePlan(sessionId);
  const sketchAsset = await ensureSketchAsset(sessionId, session);

  if (existingPlan) {
    return {
      session,
      sketchAsset,
      plan: existingPlan
    };
  }

  const transcriptText = (session.analysis?.transcriptText || buildDisplayTranscript(session.transcript)).trim();
  const extracted = await extractVideoSourcePlan({
    transcriptText,
    plainSketch: sketchAsset.buffer
  });
  const groundedObjects = groundObjectsFromTranscriptAndEvents({
    transcript: session.transcript,
    events: session.events,
    objects: extracted.objects.map((object) => ({
      tag: object.tag,
      label: object.label,
      evidence_quotes: object.evidenceQuotes
    }))
  });

  const plan: VideoSourcePlan = {
    model: extracted.model,
    createdAt: new Date().toISOString(),
    transcriptText: extracted.transcriptText,
    objects: groundedObjects,
    sourceSeeds: extracted.objects,
    sourceImagePrompt: extracted.sourceImagePrompt,
    notes: [
      `Video source plan generated with ${extracted.model}.`,
      `Grounded ${groundedObjects.length} objects for the video labeled sketch.`
    ]
  };

  await saveSessionVideoSourcePlan(sessionId, plan);
  return {
    session,
    sketchAsset,
    plan
  };
}

async function ensureVideoSourceAssets(sessionId: string) {
  const { session, sketchAsset, plan } = await ensureVideoSourcePlan(sessionId);

  let labeledSketchAsset = await getSessionAsset(sessionId, "videoAnnotatedSketch");
  if (!labeledSketchAsset) {
    const labeledSketchBuffer = await renderGroundedSketchPng({
      baseSketch: sketchAsset.buffer,
      objects: plan.objects,
      canvasWidth: session.canvasWidth,
      canvasHeight: session.canvasHeight
    });
    await saveSessionAsset(sessionId, "videoAnnotatedSketch", labeledSketchBuffer);
    labeledSketchAsset = {
      buffer: Buffer.from(labeledSketchBuffer),
      fileName: "video-annotated-sketch.png",
      mimeType: "image/png"
    };
  }

  let sourceImageAsset = await getSessionAsset(sessionId, "generatedVideoSourceImage");
  if (!sourceImageAsset) {
    const image = await generateReviewedVideoSourceImage({
      transcriptText: plan.transcriptText,
      sourceImagePrompt: plan.sourceImagePrompt,
      labeledSketch: labeledSketchAsset.buffer,
      apiKey: getOpenAiKey(),
      width: session.canvasWidth,
      height: session.canvasHeight,
      imageSizePreset: session.imageSizePreset,
      profile: session.imageGenerationProfile
    });
    await saveSessionAsset(sessionId, "generatedVideoSourceImage", image.buffer);
    sourceImageAsset = {
      buffer: Buffer.from(image.buffer),
      fileName: "generated-video-source-image.png",
      mimeType: "image/png"
    };
  }

  return {
    session: await getRequiredSession(sessionId),
    plan,
    labeledSketchAsset,
    sourceImageAsset
  };
}

async function ensureNormalVideoSourceAssets(sessionId: string) {
  const session = await ensureSessionGeneratedImage({
    sessionId,
    source: "labeled"
  });

  const sourceImageAsset = await getSessionAsset(sessionId, "generatedImageLabeled");
  if (!sourceImageAsset) {
    throw new Error("The labeled generated image is missing.");
  }

  const transcriptText = (session.analysis?.transcriptText || buildDisplayTranscript(session.transcript)).trim();
  const sourceImagePrompt = session.analysis?.generationPrompt?.trim();
  if (!sourceImagePrompt) {
    throw new Error("Session analysis is required before creating a normal video.");
  }

  return {
    session,
    transcriptText,
    sourceImagePrompt,
    sourceImagePromptModel: session.analysis?.model ?? null,
    sourceImageAsset
  };
}

export async function startVideoGenerationJob({
  sessionId,
  modelPreset,
  pipelineMode = "normal",
  durationSeconds = DEFAULT_VIDEO_DURATION_SECONDS,
  resolution = DEFAULT_VIDEO_RESOLUTION,
  cameraFixed = DEFAULT_VIDEO_CAMERA_FIXED
}: {
  sessionId: string;
  modelPreset: VideoModelPreset;
  pipelineMode?: VideoPipelineMode;
  durationSeconds?: number;
  resolution?: VideoResolution;
  cameraFixed?: boolean;
}) {
  assertMuApiConfigured();

  let session: Awaited<ReturnType<typeof getRequiredSession>>;
  let sourceImageAsset: NonNullable<Awaited<ReturnType<typeof getSessionAsset>>>;
  let sourceImagePrompt: string;
  let sourceImagePromptModel: string | null;
  let promptPackage: Awaited<ReturnType<typeof writeDynamicVideoProviderPrompt>>;

  if (pipelineMode === "dynamic") {
    const prepared = await ensureVideoSourceAssets(sessionId);
    session = prepared.session;
    sourceImageAsset = prepared.sourceImageAsset;
    sourceImagePrompt = prepared.plan.sourceImagePrompt;
    sourceImagePromptModel = prepared.plan.model;
    promptPackage = await writeDynamicVideoProviderPrompt({
      transcriptText: prepared.plan.transcriptText,
      labeledSketch: prepared.labeledSketchAsset.buffer,
      sourceImage: prepared.sourceImageAsset.buffer,
      modelPreset
    });
  } else {
    const prepared = await ensureNormalVideoSourceAssets(sessionId);
    session = prepared.session;
    sourceImageAsset = prepared.sourceImageAsset;
    sourceImagePrompt = prepared.sourceImagePrompt;
    sourceImagePromptModel = prepared.sourceImagePromptModel;
    promptPackage = await writeNormalVideoProviderPrompt({
      transcriptText: prepared.transcriptText,
      sourceImagePrompt: prepared.sourceImagePrompt,
      sourceImage: prepared.sourceImageAsset.buffer,
      modelPreset
    });
  }

  const sourceMetadata = await sharp(sourceImageAsset.buffer).metadata().catch(() => null);
  const aspectRatio: VideoAspectRatio = inferVideoAspectRatio(
    sourceMetadata?.width ?? session.canvasWidth,
    sourceMetadata?.height ?? session.canvasHeight
  );

  const job = await createVideoJob(sessionId, {
    status: "queued",
    completedAt: null,
    displayName: buildVideoDisplayName(session.title, modelPreset, pipelineMode),
    modelPreset,
    pipelineMode,
    requestedModel: "",
    sourceAssetKind: pipelineMode === "dynamic" ? "generatedVideoSourceImage" : "generatedImageLabeled",
    transcriptText: promptPackage.transcriptText,
    sourceImagePrompt,
    sourceImagePromptModel,
    prompt: promptPackage.providerPrompt,
    promptModel: promptPackage.promptModel,
    durationSeconds,
    resolution: modelPreset === "lite" ? resolution : null,
    aspectRatio: modelPreset === "quality" ? aspectRatio : null,
    cameraFixed: modelPreset === "lite" ? cameraFixed : null,
    requestId: null,
    remoteSourceUrl: null,
    remoteVideoUrl: null,
    videoFileName: null,
    videoMimeType: null,
    errorMessage: null,
    statusDetail: "Preparing source image upload."
  });

  try {
    await updateVideoJob(sessionId, job.id, (current) => ({
      ...current,
      status: "uploading",
      statusDetail:
        pipelineMode === "dynamic"
          ? "Uploading the dynamic video source image to MuAPI."
          : "Uploading the normal video source image to MuAPI."
    }));

    const uploadedSource = await uploadMuApiImage(sourceImageAsset.buffer);
    const createdPrediction = await createMuApiVideoPrediction({
      modelPreset,
      prompt: promptPackage.providerPrompt,
      imageUrls: [uploadedSource.url],
      durationSeconds,
      resolution,
      aspectRatio,
      cameraFixed
    });

    const updatedJob = await updateVideoJob(sessionId, job.id, (current) => ({
      ...current,
      status: "running",
      requestedModel: createdPrediction.endpoint,
      requestId: createdPrediction.requestId,
      remoteSourceUrl: uploadedSource.url,
      statusDetail: "Video generation accepted by MuAPI."
    }));

    return finalizeVideoJobFromResult(sessionId, updatedJob).catch(() => updatedJob);
  } catch (error) {
    return updateVideoJob(sessionId, job.id, (current) => ({
      ...current,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : "Failed to start video generation.",
      statusDetail: current.statusDetail
    }));
  }
}

export async function syncVideoGenerationJob(sessionId: string, jobId: string) {
  const job = await getVideoJob(sessionId, jobId);
  if (!job) {
    throw new Error("Video job not found");
  }

  if (job.status === "failed" || !job.requestId) {
    return job;
  }

  if (job.status === "succeeded" && videoHasLocalAsset(job)) {
    return job;
  }

  return finalizeVideoJobFromResult(sessionId, job);
}
