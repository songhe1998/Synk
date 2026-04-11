import { getSessionAsset, getSessionDetail } from "@/lib/session-store";
import {
  buildWorldAssetSnapshot,
  extractWorldIdFromOperation,
  formatWorldLabsErrorValue,
  generateWorldLabsWorld,
  getOperationStatusDetail,
  getWorldLabsOperation,
  getWorldLabsWorld,
  resolveWorldLabsModel,
  uploadWorldLabsAsset,
  prepareWorldLabsUpload
} from "@/lib/worldlabs";
import { createWorldJob, getWorldJob, updateWorldJob } from "@/lib/world-store";
import { SessionDetail, WorldAssetSnapshot, WorldJob, WorldModelPreset, WorldSourceAssetKind } from "@/lib/types";

function getDefaultWorldSourceAsset(session: SessionDetail): WorldSourceAssetKind | null {
  if (session.generatedImageLabeledUrl) {
    return "generatedImageLabeled";
  }

  if (session.generatedImagePlainUrl) {
    return "generatedImagePlain";
  }

  return null;
}

function buildWorldDisplayName(title: string, modelPreset: WorldModelPreset) {
  const suffix = modelPreset === "hd" ? "HD World" : "Preview World";
  return `${title} ${suffix}`.slice(0, 80);
}

function worldHasRenderableSplats(world: WorldAssetSnapshot | null) {
  return Boolean(world?.spz100kUrl || world?.spz500kUrl || world?.spzFullResUrl);
}

function pickBestWorldPayload(...candidates: unknown[]) {
  let bestPayload: unknown = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const snapshot = buildWorldAssetSnapshot(candidate);
    const score =
      (snapshot.spz100kUrl ? 4 : 0) +
      (snapshot.spz500kUrl ? 4 : 0) +
      (snapshot.spzFullResUrl ? 4 : 0) +
      (snapshot.colliderMeshUrl ? 2 : 0) +
      (snapshot.panoUrl ? 2 : 0) +
      (snapshot.thumbnailUrl ? 1 : 0) +
      (snapshot.worldMarbleUrl ? 1 : 0);

    if (score > bestScore) {
      bestPayload = candidate;
      bestScore = score;
    }
  }

  return bestPayload;
}

async function finalizeWorldJobFromOperation(sessionId: string, job: WorldJob, operation: any) {
  if (!operation.done) {
    const worldId = extractWorldIdFromOperation(operation);
    return updateWorldJob(sessionId, job.id, (current) => ({
      ...current,
      status: current.status === "queued" ? "running" : current.status,
      worldId: worldId ?? current.worldId,
      statusDetail: getOperationStatusDetail(operation)
    }));
  }

  if (operation.error) {
    return updateWorldJob(sessionId, job.id, (current) => ({
      ...current,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: formatWorldLabsErrorValue(operation.error),
      statusDetail: getOperationStatusDetail(operation)
    }));
  }

  const worldId = extractWorldIdFromOperation(operation);
  let worldPayloadFromWorldGet: unknown = null;

  if (worldId) {
    try {
      worldPayloadFromWorldGet = await getWorldLabsWorld(worldId);
    } catch {
      worldPayloadFromWorldGet = null;
    }
  }

  const worldPayload = pickBestWorldPayload(worldPayloadFromWorldGet, operation.response);
  if (!worldPayload || typeof worldPayload !== "object") {
    return updateWorldJob(sessionId, job.id, (current) => ({
      ...current,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: "World Labs completed the operation but returned no world payload.",
      statusDetail: getOperationStatusDetail(operation)
    }));
  }

  const world = buildWorldAssetSnapshot(worldPayload);
  const worldReady = worldHasRenderableSplats(world);
  return updateWorldJob(sessionId, job.id, (current) => ({
    ...current,
    status: worldReady ? "succeeded" : "running",
    completedAt: worldReady ? new Date().toISOString() : null,
    worldId: world.worldId,
    errorMessage: null,
    statusDetail: worldReady ? getOperationStatusDetail(operation) : "World generated. Waiting for splat assets.",
    world
  }));
}

export async function startWorldGenerationJob({
  sessionId,
  modelPreset,
  sourceAssetKind
}: {
  sessionId: string;
  modelPreset: WorldModelPreset;
  sourceAssetKind?: WorldSourceAssetKind;
}) {
  const session = await getSessionDetail(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  if (!session.analysis?.generationPrompt?.trim()) {
    throw new Error("Run analysis and image generation before creating a 3D world.");
  }

  const resolvedSourceAsset = sourceAssetKind ?? getDefaultWorldSourceAsset(session);
  if (!resolvedSourceAsset) {
    throw new Error("A generated source image is required before creating a 3D world.");
  }

  const sourceAsset = await getSessionAsset(sessionId, resolvedSourceAsset);
  if (!sourceAsset) {
    throw new Error("The selected source image is missing.");
  }

  const requestedModel = resolveWorldLabsModel(modelPreset);
  const job = await createWorldJob(sessionId, {
    status: "queued",
    completedAt: null,
    displayName: buildWorldDisplayName(session.title, modelPreset),
    modelPreset,
    requestedModel,
    sourceAssetKind: resolvedSourceAsset,
    prompt: session.analysis.generationPrompt,
    operationId: null,
    operationExpiresAt: null,
    worldId: null,
    errorMessage: null,
    statusDetail: "Preparing upload to World Labs.",
    world: null
  });

  try {
    const prepareUpload = await prepareWorldLabsUpload({
      fileName: `${job.id.slice(0, 8)}-${resolvedSourceAsset}.png`,
      extension: "png",
      kind: "image",
      metadata: {
        sessionId,
        jobId: job.id,
        sourceAssetKind: resolvedSourceAsset,
        modelPreset
      }
    });

    await uploadWorldLabsAsset({
      uploadUrl: prepareUpload.upload_info.upload_url,
      requiredHeaders: prepareUpload.upload_info.required_headers,
      mimeType: sourceAsset.mimeType,
      buffer: sourceAsset.buffer
    });

    const { operation } = await generateWorldLabsWorld({
      mediaAssetId: prepareUpload.media_asset.media_asset_id,
      prompt: session.analysis.generationPrompt,
      displayName: job.displayName,
      modelPreset,
      tags: ["synk", modelPreset, sessionId.slice(0, 8)]
    });

    const updatedJob = await updateWorldJob(sessionId, job.id, (current) => ({
      ...current,
      status: operation.done ? current.status : "queued",
      operationId: operation.operation_id,
      operationExpiresAt: operation.expires_at,
      statusDetail: operation.done ? "World generation completed immediately." : "World Labs accepted the job."
    }));

    return finalizeWorldJobFromOperation(sessionId, updatedJob, operation);
  } catch (error) {
    return updateWorldJob(sessionId, job.id, (current) => ({
      ...current,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : "Failed to start world generation.",
      statusDetail: current.statusDetail
    }));
  }
}

export async function syncWorldGenerationJob(sessionId: string, jobId: string) {
  const job = await getWorldJob(sessionId, jobId);
  if (!job) {
    throw new Error("World job not found");
  }

  if (job.status === "failed" || !job.operationId) {
    return job;
  }

  if (job.status === "succeeded" && worldHasRenderableSplats(job.world)) {
    return job;
  }

  const operation = await getWorldLabsOperation(job.operationId);
  return finalizeWorldJobFromOperation(sessionId, job, operation);
}
