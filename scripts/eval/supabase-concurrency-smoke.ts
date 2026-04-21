import fs from "fs/promises";
import path from "path";
import { createImageExperience } from "@/lib/session-pipeline";
import {
  createSupabaseSession,
  deleteSupabaseSession,
  saveSupabaseSessionTranscript,
  saveSupabaseSessionUpload
} from "@/lib/supabase-session-store";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { TranscriptToken } from "@/lib/types";

const SAMPLE_SESSION_DIR =
  process.env.CONCURRENCY_SAMPLE_SESSION_DIR ??
  path.join(process.cwd(), "data", "sessions", "bfe42c87-ea39-4e6c-a126-94864190d2bd");

async function getAnyUserId() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("sessions").select("user_id").limit(1);
  if (error) {
    throw error;
  }

  const userId = data?.[0]?.user_id;
  if (typeof userId !== "string" || !userId) {
    throw new Error("No existing Supabase session owner was found for the smoke test.");
  }

  return userId;
}

async function readSamplePayload() {
  const metaPath = path.join(SAMPLE_SESSION_DIR, "meta.json");
  const audioPath = path.join(SAMPLE_SESSION_DIR, "audio.webm");
  const eventsPath = path.join(SAMPLE_SESSION_DIR, "events.json");
  const transcriptPath = path.join(SAMPLE_SESSION_DIR, "transcript.json");
  const sketchPath = path.join(SAMPLE_SESSION_DIR, "sketch.png");

  const [metaRaw, audioBuffer, eventsRaw, transcriptRaw, sketchBuffer] = await Promise.all([
    fs.readFile(metaPath, "utf8"),
    fs.readFile(audioPath),
    fs.readFile(eventsPath, "utf8"),
    fs.readFile(transcriptPath, "utf8"),
    fs.readFile(sketchPath)
  ]);

  const meta = JSON.parse(metaRaw) as {
    durationMs: number;
    audioMimeType: string | null;
    canvasWidth: number;
    canvasHeight: number;
    transcriptApproximate: boolean;
  };

  return {
    audioBuffer,
    audioMimeType: meta.audioMimeType ?? "audio/webm;codecs=opus",
    audioExtension: "webm",
    events: JSON.parse(eventsRaw),
    transcript: JSON.parse(transcriptRaw) as TranscriptToken[],
    transcriptApproximate: Boolean(meta.transcriptApproximate),
    canvasWidth: meta.canvasWidth,
    canvasHeight: meta.canvasHeight,
    durationMs: meta.durationMs,
    sketchBuffer
  };
}

async function prepareSession(userId: string, title: string) {
  const sample = await readSamplePayload();
  const session = await createSupabaseSession(
    userId,
    title,
    {
      analysisReasoningEffort: "medium",
      imageSizePreset: "medium",
      imageGenerationProfile: "pro"
    }
  );

  await saveSupabaseSessionUpload(session.id, {
    audioBuffer: sample.audioBuffer,
    audioMimeType: sample.audioMimeType,
    audioExtension: sample.audioExtension,
    events: sample.events,
    canvasWidth: sample.canvasWidth,
    canvasHeight: sample.canvasHeight,
    durationMs: sample.durationMs,
    sketchBuffer: sample.sketchBuffer
  });

  await saveSupabaseSessionTranscript(session.id, sample.transcript, sample.transcriptApproximate);
  return session;
}

async function main() {
  const userId = await getAnyUserId();
  const created: string[] = [];

  try {
    const [left, right] = await Promise.all([
      prepareSession(userId, `Supabase concurrency left ${new Date().toISOString()}`),
      prepareSession(userId, `Supabase concurrency right ${new Date().toISOString()}`)
    ]);

    created.push(left.id, right.id);
    console.log("prepared", { left: left.id, right: right.id });

    const startedAt = Date.now();
    const [leftResult, rightResult] = await Promise.allSettled([
      createImageExperience({ sessionId: left.id, reasoningEffort: "medium", imageSizePreset: "medium", imageGenerationProfile: "pro" }),
      createImageExperience({ sessionId: right.id, reasoningEffort: "medium", imageSizePreset: "medium", imageGenerationProfile: "pro" })
    ]);

    console.log(
      JSON.stringify(
        {
          elapsedMs: Date.now() - startedAt,
          left: leftResult.status === "fulfilled"
            ? {
                status: leftResult.value.status,
                generatedImage: Boolean(leftResult.value.generatedImageLabeledUrl)
              }
            : {
                error: leftResult.reason instanceof Error ? leftResult.reason.message : String(leftResult.reason)
              },
          right: rightResult.status === "fulfilled"
            ? {
                status: rightResult.value.status,
                generatedImage: Boolean(rightResult.value.generatedImageLabeledUrl)
              }
            : {
                error: rightResult.reason instanceof Error ? rightResult.reason.message : String(rightResult.reason)
              }
        },
        null,
        2
      )
    );
  } finally {
    await Promise.allSettled(created.map((sessionId) => deleteSupabaseSession(sessionId, userId)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
