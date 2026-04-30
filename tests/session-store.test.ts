import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { after, before, test } from "node:test";

let dataRoot = "";
let sessionStore: typeof import("../lib/session-store");

before(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "synk-session-store-"));
  process.env.SESSION_DATA_ROOT = dataRoot;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  sessionStore = await import("../lib/session-store");
});

after(async () => {
  if (dataRoot) {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("deleteSession removes a finalized local session from disk and recent index", async () => {
  const session = await sessionStore.createSession("Always-on voice");

  await sessionStore.saveSessionUpload(session.id, {
    audioBuffer: Buffer.from("fake-webm-audio"),
    audioMimeType: "audio/webm",
    audioExtension: "webm",
    events: [
      {
        type: "stroke_begin",
        strokeId: "stroke-1",
        tool: "pen",
        color: "#20222b",
        width: 6,
        x: 16,
        y: 24,
        pressure: 0.5,
        tMs: 0
      },
      {
        type: "stroke_end",
        strokeId: "stroke-1",
        x: 48,
        y: 72,
        pressure: 0.5,
        tMs: 240
      }
    ],
    canvasWidth: 1280,
    canvasHeight: 720,
    durationMs: 240,
    sketchBuffer: Buffer.from("fake-png")
  });

  await sessionStore.saveSessionTranscript(
    session.id,
    [
      {
        id: "token-1",
        text: "hello",
        startMs: 0,
        endMs: 120,
        granularity: "word",
        lang: "latin",
        approximate: false
      }
    ],
    false
  );

  assert.ok(await sessionStore.getSessionDetail(session.id));
  await stat(path.join(dataRoot, session.id));

  await sessionStore.deleteSession(session.id);

  assert.equal(await sessionStore.getSessionDetail(session.id), null);
  const recent = await sessionStore.listRecentSessions();
  assert.equal(recent.some((item) => item.id === session.id), false);
  await assert.rejects(stat(path.join(dataRoot, session.id)));
});

test("deleteSession is a no-op for unknown local sessions", async () => {
  await assert.doesNotReject(sessionStore.deleteSession("missing-session-id"));
});

test("deleteSession only removes the targeted session", async () => {
  const first = await sessionStore.createSession("Session A");
  const second = await sessionStore.createSession("Session B");

  await sessionStore.deleteSession(first.id);

  assert.equal(await sessionStore.getSessionDetail(first.id), null);
  assert.ok(await sessionStore.getSessionDetail(second.id));

  await sessionStore.deleteSession(second.id);
});

test("saveSessionUpload succeeds even when no sketch snapshot is present", async () => {
  const session = await sessionStore.createSession("Audio only upload");

  const uploaded = await sessionStore.saveSessionUpload(session.id, {
    audioBuffer: Buffer.from("fake-webm-audio"),
    audioMimeType: "audio/webm",
    audioExtension: "webm",
    events: [
      {
        type: "stroke_begin",
        strokeId: "stroke-1",
        tool: "pen",
        color: "#20222b",
        width: 6,
        x: 12,
        y: 18,
        pressure: 0.5,
        tMs: 0
      },
      {
        type: "stroke_end",
        strokeId: "stroke-1",
        x: 90,
        y: 120,
        pressure: 0.5,
        tMs: 320
      }
    ],
    canvasWidth: 1280,
    canvasHeight: 720,
    durationMs: 320
  });

  assert.equal(uploaded.status, "uploaded");
  assert.equal(uploaded.audioMimeType, "audio/webm");

  const detail = await sessionStore.getSessionDetail(session.id);
  assert.ok(detail);
  assert.equal(detail?.status, "uploaded");
  assert.equal(detail?.sketchUrl, null);
  assert.equal(detail?.events.length, 2);
});

test("saveSessionUpload persists canvas image layers", async () => {
  const session = await sessionStore.createSession("Canvas image reference upload");

  await sessionStore.saveSessionUpload(session.id, {
    audioBuffer: Buffer.from("fake-webm-audio"),
    audioMimeType: "audio/webm",
    audioExtension: "webm",
    events: [],
    canvasImageLayers: [
      {
        id: "layer-1",
        sourceSessionId: "source-session",
        sourceAssetKind: "generatedImage",
        sourceUrl: "/api/sessions/source-session/assets/generatedImage",
        title: "Reference image",
        x: 40,
        y: 56,
        width: 320,
        height: 180,
        naturalWidth: 1024,
        naturalHeight: 576
      }
    ],
    canvasWidth: 1280,
    canvasHeight: 720,
    durationMs: 120
  });

  const detail = await sessionStore.getSessionDetail(session.id);
  assert.equal(detail?.canvasImageLayers.length, 1);
  assert.equal(detail?.canvasImageLayers[0]?.sourceSessionId, "source-session");
  assert.equal(detail?.canvasImageLayers[0]?.width, 320);
});
