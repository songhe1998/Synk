import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGalleryItemFromSession,
  buildPlaceholderGalleryItem,
  buildPendingGalleryItem,
  mergeVideoJobIntoSession,
  mergeWorldJobIntoSession
} from "../lib/recorder-gallery";
import { SessionDetail, VideoJob, WebsiteJob, WorldJob } from "../lib/types";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "session-1",
    title: "Session One",
    status: "ready",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:02:00.000Z",
    durationMs: 1800,
    audioMimeType: "audio/webm",
    canvasWidth: 1280,
    canvasHeight: 720,
    transcriptApproximate: false,
    analysisReasoningEffort: "medium",
    imageSizePreset: "medium",
    imageGenerationProfile: "pro",
    imageFollowMode: "auto",
    errorMessage: null,
    events: [],
    transcript: [],
    audioUrl: "/api/sessions/session-1/audio",
    sketchUrl: "/api/sessions/session-1/assets/sketch",
    annotatedSketchUrl: "/api/sessions/session-1/assets/annotatedSketch",
    videoAnnotatedSketchUrl: null,
    generatedImageUrl: "/api/sessions/session-1/assets/generatedImageLabeled",
    generatedImageLabeledUrl: "/api/sessions/session-1/assets/generatedImageLabeled",
    generatedImagePlainUrl: null,
    generatedVideoSourceImageUrl: null,
    analysis: null,
    worldJobs: [],
    videoJobs: [],
    websiteJobs: [],
    ...overrides
  };
}

function makeVideoJob(overrides: Partial<VideoJob> = {}): VideoJob {
  return {
    id: "video-1",
    sessionId: "session-1",
    status: "running",
    createdAt: "2026-04-18T10:03:00.000Z",
    updatedAt: "2026-04-18T10:03:30.000Z",
    completedAt: null,
    displayName: "Video One",
    modelPreset: "quality",
    pipelineMode: "dynamic",
    requestedModel: "seedance",
    sourceAssetKind: "generatedVideoSourceImage",
    sourceImageUrl: "/api/sessions/session-1/assets/generatedVideoSourceImage",
    transcriptText: "A fox jumps.",
    sourceImagePrompt: "A fox mid-jump.",
    sourceImagePromptModel: "gpt-5.4",
    prompt: "Animate the fox.",
    promptModel: "gpt-5.4",
    durationSeconds: 5,
    resolution: "720p",
    aspectRatio: "16:9",
    cameraFixed: false,
    requestId: "mu-1",
    remoteSourceUrl: null,
    remoteVideoUrl: null,
    videoFileName: null,
    videoMimeType: null,
    videoUrl: null,
    errorMessage: null,
    statusDetail: "MuAPI is generating the video.",
    ...overrides
  };
}

function makeWorldJob(overrides: Partial<WorldJob> = {}): WorldJob {
  return {
    id: "world-1",
    sessionId: "session-1",
    status: "running",
    createdAt: "2026-04-18T10:03:00.000Z",
    updatedAt: "2026-04-18T10:04:00.000Z",
    completedAt: null,
    displayName: "World One",
    modelPreset: "hd",
    requestedModel: "hd",
    sourceAssetKind: "generatedImageLabeled",
    sourceImageUrl: "/api/sessions/session-1/assets/generatedImageLabeled",
    prompt: "Build the scene.",
    operationId: "op-1",
    operationExpiresAt: null,
    worldId: null,
    errorMessage: null,
    statusDetail: "World Labs accepted the job.",
    world: null,
    ...overrides
  };
}

function makeWebsiteJob(overrides: Partial<WebsiteJob> = {}): WebsiteJob {
  return {
    id: "website-1",
    sessionId: "session-1",
    status: "succeeded",
    createdAt: "2026-04-18T10:03:00.000Z",
    updatedAt: "2026-04-18T10:05:00.000Z",
    completedAt: "2026-04-18T10:05:00.000Z",
    displayName: "Website One",
    framework: "vite-react",
    sandboxProvider: "vercel",
    sandboxId: "sbx-1",
    transcriptText: "Build a website.",
    pages: [],
    prompt: "Create a website.",
    statusDetail: "Website ready.",
    errorMessage: null,
    previewImageUrl: "/api/sessions/session-1/websites/website-1/asset?kind=previewImage",
    codeArchiveUrl: "/api/sessions/session-1/websites/website-1/asset?kind=codeArchive",
    distArchiveUrl: "/api/sessions/session-1/websites/website-1/asset?kind=distArchive",
    previewUrl: "/sessions/session-1/websites/website-1",
    previewImageFileName: "preview.png",
    previewImageMimeType: "image/png",
    codeArchiveFileName: "code.tar.gz",
    codeArchiveMimeType: "application/gzip",
    distArchiveFileName: "dist.tar.gz",
    distArchiveMimeType: "application/gzip",
    ...overrides
  };
}

test("image gallery items prefer the generated image and image detail page", () => {
  const session = makeSession();
  const item = buildGalleryItemFromSession(session);

  assert.equal(item.target, "image");
  assert.equal(item.previewKind, "source");
  assert.equal(item.thumbnailUrl, "/api/sessions/session-1/assets/generatedImageLabeled");
  assert.equal(item.href, "/sessions/session-1/image");
  assert.equal(item.status, "ready");
});

test("video gallery items switch to the source image while the final video is still running", () => {
  const session = makeSession({
    generatedVideoSourceImageUrl: "/api/sessions/session-1/assets/generatedVideoSourceImage",
    videoJobs: [makeVideoJob()]
  });
  const item = buildGalleryItemFromSession(session, "video");

  assert.equal(item.target, "video");
  assert.equal(item.previewKind, "source");
  assert.equal(item.thumbnailUrl, "/api/sessions/session-1/assets/generatedVideoSourceImage");
  assert.equal(item.href, null);
  assert.equal(item.status, "running");
  assert.equal(item.statusLabel, "Rendering");
});

test("world gallery items stay running until renderable splats are available", () => {
  const runningSession = makeSession({
    worldJobs: [makeWorldJob({ status: "succeeded", world: { worldId: "w-1", displayName: "World", model: null, worldMarbleUrl: null, caption: null, thumbnailUrl: null, panoUrl: null, colliderMeshUrl: null, spz100kUrl: null, spz500kUrl: null, spzFullResUrl: null, groundPlaneOffset: null, metricScaleFactor: null, createdAt: null, updatedAt: null } })]
  });
  const readySession = makeSession({
    worldJobs: [
      makeWorldJob({
        status: "succeeded",
        world: {
          worldId: "w-1",
          displayName: "World",
          model: null,
          worldMarbleUrl: null,
          caption: null,
          thumbnailUrl: null,
          panoUrl: null,
          colliderMeshUrl: null,
          spz100kUrl: "https://example.com/world.spz",
          spz500kUrl: null,
          spzFullResUrl: null,
          groundPlaneOffset: null,
          metricScaleFactor: null,
          createdAt: null,
          updatedAt: null
        }
      })
    ]
  });

  assert.equal(buildGalleryItemFromSession(runningSession, "world").status, "running");
  assert.equal(buildGalleryItemFromSession(readySession, "world").status, "ready");
});

test("website gallery items prefer the generated preview image over the labeled sketch", () => {
  const session = makeSession({
    websiteJobs: [makeWebsiteJob()]
  });
  const item = buildGalleryItemFromSession(session, "website");

  assert.equal(item.target, "website");
  assert.equal(item.previewKind, "source");
  assert.equal(item.thumbnailUrl, "/api/sessions/session-1/websites/website-1/asset?kind=previewImage");
  assert.equal(item.href, "/sessions/session-1/websites/website-1");
  assert.equal(item.status, "ready");
});

test("pending gallery items keep the sketch thumbnail until the source image exists", () => {
  const item = buildPendingGalleryItem({
    sessionId: "session-2",
    title: "Session Two",
    createdAt: "2026-04-18T10:05:00.000Z",
    target: "video",
    sketchThumbnailUrl: "data:image/png;base64,abc"
  });

  assert.equal(item.previewKind, "sketch");
  assert.equal(item.thumbnailUrl, "data:image/png;base64,abc");
  assert.equal(item.status, "pending");
  assert.equal(item.jobId, null);
  assert.equal(item.href, null);
});

test("placeholder gallery items do not fall back to the session detail page when no result is ready", () => {
  const item = buildPlaceholderGalleryItem({
    id: "session-3",
    title: "Session Three",
    status: "processing",
    createdAt: "2026-04-18T10:06:00.000Z",
    updatedAt: "2026-04-18T10:06:30.000Z",
    durationMs: 1200,
    audioMimeType: "audio/webm",
    canvasWidth: 1280,
    canvasHeight: 720,
    transcriptApproximate: false,
    analysisReasoningEffort: "medium",
    imageSizePreset: "medium",
    imageGenerationProfile: "pro",
    imageFollowMode: "auto",
    errorMessage: null,
    preferredResultUrl: null
  });

  assert.equal(item.href, null);
  assert.equal(item.status, "pending");
});

test("job merge helpers keep the latest synchronized job at the front of the session detail", () => {
  const initialVideoSession = makeSession({
    videoJobs: [makeVideoJob({ id: "video-1", status: "queued", createdAt: "2026-04-18T10:03:00.000Z" })]
  });
  const mergedVideo = mergeVideoJobIntoSession(
    initialVideoSession,
    makeVideoJob({ id: "video-1", status: "succeeded", videoUrl: "/api/sessions/session-1/videos/video-1/asset" })
  );

  assert.equal(mergedVideo.videoJobs[0]?.status, "succeeded");

  const initialWorldSession = makeSession({
    worldJobs: [makeWorldJob({ id: "world-1", status: "queued", createdAt: "2026-04-18T10:03:00.000Z" })]
  });
  const mergedWorld = mergeWorldJobIntoSession(
    initialWorldSession,
    makeWorldJob({ id: "world-1", status: "running", statusDetail: "World Labs is still building." })
  );

  assert.equal(mergedWorld.worldJobs[0]?.status, "running");
});
