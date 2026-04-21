import { SessionDetail, SessionSummary, VideoJob, WebsiteJob, WorldAssetSnapshot, WorldJob } from "@/lib/types";

export type RecorderGalleryTarget = "image" | "video" | "world" | "website";
export type RecorderGalleryStatus = "pending" | "running" | "ready" | "failed";
export type RecorderGalleryPreviewKind = "placeholder" | "sketch" | "source";

export interface RecorderGalleryItem {
  sessionId: string;
  title: string;
  createdAt: string;
  target: RecorderGalleryTarget;
  href: string | null;
  thumbnailUrl: string | null;
  sketchThumbnailUrl: string | null;
  sourceImageUrl: string | null;
  previewKind: RecorderGalleryPreviewKind;
  status: RecorderGalleryStatus;
  statusLabel: string;
  detail: string;
  jobId: string | null;
}

function inferTargetFromResultUrl(preferredResultUrl?: string | null): RecorderGalleryTarget {
  if (preferredResultUrl?.includes("/worlds/")) {
    return "world";
  }

  if (preferredResultUrl?.includes("/videos/")) {
    return "video";
  }

  if (preferredResultUrl?.includes("/websites/")) {
    return "website";
  }

  return "image";
}

function worldHasRenderableSplats(world: WorldAssetSnapshot | null) {
  return Boolean(world?.spz100kUrl || world?.spz500kUrl || world?.spzFullResUrl);
}

function getImageThumbnail(session: SessionDetail) {
  return session.generatedImageLabeledUrl ?? session.generatedImagePlainUrl ?? session.generatedImageUrl ?? null;
}

function getVideoSourceThumbnail(session: SessionDetail) {
  return session.generatedVideoSourceImageUrl ?? getImageThumbnail(session);
}

function getWorldSourceThumbnail(session: SessionDetail) {
  return getImageThumbnail(session);
}

function getLatestVideoJob(session: SessionDetail) {
  return session.videoJobs?.[0] ?? null;
}

function getLatestWorldJob(session: SessionDetail) {
  return session.worldJobs?.[0] ?? null;
}

function getLatestWebsiteJob(session: SessionDetail) {
  return session.websiteJobs?.[0] ?? null;
}

function resolveTarget(session: SessionDetail, preferredTarget?: RecorderGalleryTarget): RecorderGalleryTarget {
  if (preferredTarget) {
    return preferredTarget;
  }

  const latestVideo = getLatestVideoJob(session);
  const latestWorld = getLatestWorldJob(session);
  const latestWebsite = getLatestWebsiteJob(session);

  const datedTargets: Array<{ createdAt: string; target: "video" | "world" | "website" }> = [
    latestVideo ? ({ createdAt: latestVideo.createdAt, target: "video" } as const) : null,
    latestWorld ? ({ createdAt: latestWorld.createdAt, target: "world" } as const) : null,
    latestWebsite ? ({ createdAt: latestWebsite.createdAt, target: "website" } as const) : null
  ]
    .filter((value): value is { createdAt: string; target: "video" | "world" | "website" } => Boolean(value))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  if (datedTargets[0]) {
    return datedTargets[0].target;
  }

  return "image";
}

function buildImageGalleryItem(session: SessionDetail): RecorderGalleryItem {
  const sourceImageUrl = getImageThumbnail(session);
  const sketchThumbnailUrl = session.sketchUrl;
  const thumbnailUrl = sourceImageUrl ?? sketchThumbnailUrl ?? null;
  const failed = session.status === "failed";

  return {
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    target: "image",
    href: sourceImageUrl ? `/sessions/${session.id}/image` : `/sessions/${session.id}`,
    thumbnailUrl,
    sketchThumbnailUrl,
    sourceImageUrl,
    previewKind: sourceImageUrl ? "source" : sketchThumbnailUrl ? "sketch" : "placeholder",
    status: failed ? "failed" : sourceImageUrl ? "ready" : session.status === "ready" ? "running" : "pending",
    statusLabel: failed ? "Failed" : sourceImageUrl ? "Ready" : session.status === "processing" ? "Transcribing" : "Rendering",
    detail: failed
      ? session.errorMessage || "Image generation failed."
      : sourceImageUrl
        ? "Image ready."
        : session.status === "processing"
          ? "Transcribing your narration."
          : "Rendering the source image.",
    jobId: null
  };
}

function buildVideoGalleryItem(session: SessionDetail): RecorderGalleryItem {
  const job = getLatestVideoJob(session);
  const sourceImageUrl = getVideoSourceThumbnail(session);
  const sketchThumbnailUrl = session.sketchUrl;
  const thumbnailUrl = sourceImageUrl ?? sketchThumbnailUrl ?? null;
  const ready = Boolean(job && job.status === "succeeded" && job.videoUrl);
  const failed = Boolean(job && job.status === "failed");

  return {
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    target: "video",
    href: job ? `/sessions/${session.id}/videos/${job.id}` : `/sessions/${session.id}`,
    thumbnailUrl,
    sketchThumbnailUrl,
    sourceImageUrl,
    previewKind: sourceImageUrl ? "source" : sketchThumbnailUrl ? "sketch" : "placeholder",
    status: failed ? "failed" : ready ? "ready" : sourceImageUrl || job ? "running" : "pending",
    statusLabel: failed
      ? "Failed"
      : ready
        ? "Ready"
        : job?.status === "queued"
          ? "Queued"
          : job?.status === "uploading"
            ? "Uploading"
            : job?.status === "running"
              ? "Rendering"
              : "Rendering",
    detail: failed
      ? job?.errorMessage || "Video generation failed."
      : ready
        ? "Video ready."
        : sourceImageUrl
          ? job?.statusDetail || "Building the video from the source image."
          : "Rendering the source image.",
    jobId: job?.id ?? null
  };
}

function buildWorldGalleryItem(session: SessionDetail): RecorderGalleryItem {
  const job = getLatestWorldJob(session);
  const sourceImageUrl = getWorldSourceThumbnail(session);
  const sketchThumbnailUrl = session.sketchUrl;
  const thumbnailUrl = sourceImageUrl ?? sketchThumbnailUrl ?? null;
  const ready = Boolean(job && job.status === "succeeded" && worldHasRenderableSplats(job.world));
  const failed = Boolean(job && job.status === "failed");

  return {
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    target: "world",
    href: job ? `/sessions/${session.id}/worlds/${job.id}` : `/sessions/${session.id}`,
    thumbnailUrl,
    sketchThumbnailUrl,
    sourceImageUrl,
    previewKind: sourceImageUrl ? "source" : sketchThumbnailUrl ? "sketch" : "placeholder",
    status: failed ? "failed" : ready ? "ready" : sourceImageUrl || job ? "running" : "pending",
    statusLabel: failed ? "Failed" : ready ? "Ready" : job?.status === "queued" ? "Queued" : "Building",
    detail: failed
      ? job?.errorMessage || "3D world generation failed."
      : ready
        ? "3D world ready."
        : sourceImageUrl
          ? job?.statusDetail || "Building the 3D world from the source image."
          : "Rendering the source image.",
    jobId: job?.id ?? null
  };
}

function buildWebsiteGalleryItem(session: SessionDetail): RecorderGalleryItem {
  const job = getLatestWebsiteJob(session);
  const sourceImageUrl = session.annotatedSketchUrl ?? session.sketchUrl ?? null;
  const sketchThumbnailUrl = session.sketchUrl;
  const thumbnailUrl = sourceImageUrl ?? sketchThumbnailUrl ?? null;
  const ready = Boolean(job && job.status === "succeeded" && job.distArchiveUrl);
  const failed = Boolean(job && job.status === "failed");

  return {
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    target: "website",
    href: job ? `/sessions/${session.id}/websites/${job.id}` : `/sessions/${session.id}`,
    thumbnailUrl,
    sketchThumbnailUrl,
    sourceImageUrl,
    previewKind: sourceImageUrl ? "source" : sketchThumbnailUrl ? "sketch" : "placeholder",
    status: failed ? "failed" : ready ? "ready" : job ? "running" : "pending",
    statusLabel: failed
      ? "Failed"
      : ready
        ? "Ready"
        : job?.status === "queued"
          ? "Queued"
          : job?.status === "building"
            ? "Building"
            : job?.status === "exporting"
              ? "Exporting"
              : "Generating",
    detail: failed
      ? job?.errorMessage || "Website generation failed."
      : ready
        ? "Website ready."
        : job?.statusDetail || "Generating a website directly from the labeled sketch.",
    jobId: job?.id ?? null
  };
}

export function buildPlaceholderGalleryItem(summary: SessionSummary): RecorderGalleryItem {
  const target = inferTargetFromResultUrl(summary.preferredResultUrl);
  const failed = summary.status === "failed";

  return {
    sessionId: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    target,
    href: summary.preferredResultUrl ?? `/sessions/${summary.id}`,
    thumbnailUrl: null,
    sketchThumbnailUrl: null,
    sourceImageUrl: null,
    previewKind: "placeholder",
    status: failed ? "failed" : summary.status === "ready" ? "running" : "pending",
    statusLabel: failed ? "Failed" : summary.status === "processing" ? "Transcribing" : "Loading",
    detail: failed
      ? summary.errorMessage || "This session failed."
      : summary.status === "processing"
        ? "Transcribing your narration."
        : "Loading the latest preview.",
    jobId: null
  };
}

export function buildPendingGalleryItem({
  sessionId,
  title,
  createdAt,
  target,
  sketchThumbnailUrl
}: {
  sessionId: string;
  title: string;
  createdAt: string;
  target: RecorderGalleryTarget;
  sketchThumbnailUrl: string | null;
}): RecorderGalleryItem {
  return {
    sessionId,
    title,
    createdAt,
    target,
    href: `/sessions/${sessionId}`,
    thumbnailUrl: sketchThumbnailUrl,
    sketchThumbnailUrl,
    sourceImageUrl: null,
    previewKind: sketchThumbnailUrl ? "sketch" : "placeholder",
    status: "pending",
    statusLabel: "Uploading",
    detail: "Sending the sketch, audio, and timeline into the pipeline.",
    jobId: null
  };
}

export function buildGalleryItemFromSession(
  session: SessionDetail,
  preferredTarget?: RecorderGalleryTarget
): RecorderGalleryItem {
  const target = resolveTarget(session, preferredTarget);

  switch (target) {
    case "website":
      return buildWebsiteGalleryItem(session);
    case "video":
      return buildVideoGalleryItem(session);
    case "world":
      return buildWorldGalleryItem(session);
    case "image":
    default:
      return buildImageGalleryItem(session);
  }
}

function replaceJobById<T extends { id: string; createdAt: string }>(jobs: T[], job: T) {
  const nextJobs = jobs.filter((candidate) => candidate.id !== job.id);
  nextJobs.unshift(job);
  return nextJobs.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function mergeVideoJobIntoSession(session: SessionDetail, job: VideoJob): SessionDetail {
  return {
    ...session,
    videoJobs: replaceJobById(session.videoJobs ?? [], job)
  };
}

export function mergeWorldJobIntoSession(session: SessionDetail, job: WorldJob): SessionDetail {
  return {
    ...session,
    worldJobs: replaceJobById(session.worldJobs ?? [], job)
  };
}

export function mergeWebsiteJobIntoSession(session: SessionDetail, job: WebsiteJob): SessionDetail {
  return {
    ...session,
    websiteJobs: replaceJobById(session.websiteJobs ?? [], job)
  };
}
