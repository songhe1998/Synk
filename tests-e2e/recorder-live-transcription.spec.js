const { test, expect } = require("@playwright/test");

const PIXEL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sZ1tc8AAAAASUVORK5CYII=";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

function buildSessionSummary(id, createdAt) {
  return {
    id,
    title: `Session ${id}`,
    status: "created",
    createdAt,
    updatedAt: createdAt,
    durationMs: 0,
    audioMimeType: "audio/wav",
    canvasWidth: 1280,
    canvasHeight: 720,
    transcriptApproximate: false,
    analysisReasoningEffort: "medium",
    imageSizePreset: "medium",
    imageGenerationProfile: "pro",
    errorMessage: null,
    preferredResultUrl: null
  };
}

function buildSessionDetail(id, createdAt, ready = true) {
  return {
    ...buildSessionSummary(id, createdAt),
    status: ready ? "ready" : "processing",
    updatedAt: ready ? "2026-04-19T06:35:05.000Z" : "2026-04-19T06:35:03.000Z",
    events: [],
    transcript: [],
    audioUrl: `/api/sessions/${id}/audio`,
    sketchUrl: PIXEL_DATA_URL,
    annotatedSketchUrl: null,
    videoAnnotatedSketchUrl: null,
    generatedImageUrl: ready ? PIXEL_DATA_URL : null,
    generatedImageLabeledUrl: ready ? PIXEL_DATA_URL : null,
    generatedImagePlainUrl: null,
    generatedVideoSourceImageUrl: null,
    analysis: null,
    worldJobs: [],
    videoJobs: []
  };
}

async function installFakeAudio(page) {
  await page.addInitScript(() => {
    let focused = true;
    const fakeTrack = {
      readyState: "live",
      stop() {
        this.readyState = "ended";
      }
    };
    const fakeStream = {
      getAudioTracks: () => [fakeTrack],
      getTracks: () => [fakeTrack]
    };

    class FakeMediaStreamSource {
      connect() {}

      disconnect() {}
    }

    class FakeGainNode {
      constructor() {
        this.gain = { value: 1 };
      }

      connect() {}

      disconnect() {}
    }

    class FakeScriptProcessorNode extends EventTarget {
      constructor() {
        super();
        this.intervalId = null;
      }

      connect() {
        if (this.intervalId !== null) {
          return;
        }

        this.intervalId = window.setInterval(() => {
          const samples = new Float32Array(1024);
          for (let index = 0; index < samples.length; index += 1) {
            samples[index] = index % 2 === 0 ? 0.08 : -0.08;
          }

          const event = new Event("audioprocess");
          Object.defineProperty(event, "inputBuffer", {
            configurable: true,
            value: {
              getChannelData() {
                return samples;
              }
            }
          });
          this.dispatchEvent(event);
        }, 20);
      }

      disconnect() {
        if (this.intervalId !== null) {
          window.clearInterval(this.intervalId);
          this.intervalId = null;
        }
      }
    }

    class FakeAudioContext {
      constructor() {
        this.state = "running";
        this.sampleRate = 48000;
        this.destination = {};
      }

      createMediaStreamSource() {
        return new FakeMediaStreamSource();
      }

      createScriptProcessor() {
        return new FakeScriptProcessorNode();
      }

      createGain() {
        return new FakeGainNode();
      }

      resume() {
        this.state = "running";
        return Promise.resolve();
      }

      close() {
        this.state = "closed";
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => focused
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => fakeStream
      }
    });
    window.addEventListener("blur", () => {
      focused = false;
    });
    window.addEventListener("focus", () => {
      focused = true;
    });
  });
}

async function drawStroke(page) {
  const canvas = page.locator("canvas.recording-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("Canvas was not visible.");
  }

  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.48, { steps: 6 });
  await page.mouse.up();
}

test("always-on recorder uploads wav and batch-transcribes on Go", async ({ page }) => {
  let sessionCreateCalls = 0;
  let uploadCalls = 0;
  let processCalls = 0;
  let createCalls = 0;
  let uploadBody = null;

  await installFakeAudio(page);

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    sessionCreateCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSessionSummary("session-one", "2026-04-19T06:35:00.000Z"))
    });
  });

  await page.route("**/api/sessions/session-one/upload", async (route) => {
    uploadCalls += 1;
    uploadBody = route.request().postDataBuffer();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.route("**/api/sessions/session-one/process", async (route) => {
    processCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSessionDetail("session-one", "2026-04-19T06:35:00.000Z", false))
    });
  });

  await page.route("**/api/sessions/session-one/create", async (route) => {
    createCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: buildSessionDetail("session-one", "2026-04-19T06:35:00.000Z", true)
      })
    });
  });

  await page.goto(BASE_URL);

  const goButton = page.getByRole("button", { name: "Go generate this take" });
  await expect(goButton).toHaveCount(0);

  await drawStroke(page);

  await expect(goButton).toBeVisible();
  await goButton.click();

  await expect.poll(() => sessionCreateCalls).toBe(1);
  await expect.poll(() => uploadCalls).toBe(1);
  await expect.poll(() => processCalls).toBe(1);
  await expect.poll(() => createCalls).toBe(1);
  expect(uploadBody).toBeTruthy();
  expect(uploadBody.includes(Buffer.from('filename="audio.wav"'))).toBeTruthy();
  expect(uploadBody.includes(Buffer.from("audio/wav"))).toBeTruthy();
  expect(uploadBody.includes(Buffer.from("RIFF"))).toBeTruthy();
  expect(uploadBody.includes(Buffer.from('name="transcript"'))).toBeFalsy();
  await expect(page.locator('a[href="/sessions/session-one/image"]')).toBeVisible();
});

test("window blur pauses listening and focus resumes the same unfinished take", async ({ page }) => {
  let sessionCreateCalls = 0;
  let uploadCalls = 0;
  let processCalls = 0;
  let createCalls = 0;

  await installFakeAudio(page);

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    sessionCreateCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSessionSummary("resumed-session", "2026-04-19T06:35:00.000Z"))
    });
  });

  await page.route("**/api/sessions/resumed-session/upload", async (route) => {
    uploadCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.route("**/api/sessions/resumed-session/process", async (route) => {
    processCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSessionDetail("resumed-session", "2026-04-19T06:35:00.000Z", false))
    });
  });

  await page.route("**/api/sessions/resumed-session/create", async (route) => {
    createCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: buildSessionDetail("resumed-session", "2026-04-19T06:35:00.000Z", true)
      })
    });
  });

  await page.goto(BASE_URL);
  await drawStroke(page);

  const goButton = page.getByRole("button", { name: "Go generate this take" });
  await expect(goButton).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
  });

  await expect(goButton).toHaveCount(0);
  expect(sessionCreateCalls).toBe(0);
  expect(uploadCalls).toBe(0);
  expect(processCalls).toBe(0);
  expect(createCalls).toBe(0);

  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });

  await expect(goButton).toBeVisible();
  await goButton.click();

  await expect.poll(() => sessionCreateCalls).toBe(1);
  await expect.poll(() => uploadCalls).toBe(1);
  await expect.poll(() => processCalls).toBe(1);
  await expect.poll(() => createCalls).toBe(1);

  const resumedSessionLink = page.locator('a[href="/sessions/resumed-session/image"]');
  await expect(resumedSessionLink).toBeVisible();
});

test("visibility hidden pauses listening and visible resumes the same unfinished take", async ({ page }) => {
  let sessionCreateCalls = 0;
  let uploadCalls = 0;
  let processCalls = 0;
  let createCalls = 0;

  await installFakeAudio(page);

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    sessionCreateCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSessionSummary("visibility-session", "2026-04-19T06:35:00.000Z"))
    });
  });

  await page.route("**/api/sessions/visibility-session/upload", async (route) => {
    uploadCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.route("**/api/sessions/visibility-session/process", async (route) => {
    processCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSessionDetail("visibility-session", "2026-04-19T06:35:00.000Z", false))
    });
  });

  await page.route("**/api/sessions/visibility-session/create", async (route) => {
    createCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: buildSessionDetail("visibility-session", "2026-04-19T06:35:00.000Z", true)
      })
    });
  });

  await page.goto(BASE_URL);
  await drawStroke(page);

  const goButton = page.getByRole("button", { name: "Go generate this take" });
  await expect(goButton).toBeVisible();

  await page.evaluate(() => {
    let hidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get() {
        return window.__testDocumentHidden ?? hidden;
      }
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get() {
        return (window.__testDocumentHidden ?? hidden) ? "hidden" : "visible";
      }
    });
    window.__testDocumentHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(goButton).toHaveCount(0);
  expect(sessionCreateCalls).toBe(0);
  expect(uploadCalls).toBe(0);
  expect(processCalls).toBe(0);
  expect(createCalls).toBe(0);

  await page.evaluate(() => {
    window.__testDocumentHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(goButton).toBeVisible();
  await goButton.click();

  await expect.poll(() => sessionCreateCalls).toBe(1);
  await expect.poll(() => uploadCalls).toBe(1);
  await expect.poll(() => processCalls).toBe(1);
  await expect.poll(() => createCalls).toBe(1);
});

test("second take waits behind the first queued generation without failing either gallery item", async ({ page }) => {
  let sessionCreateCalls = 0;
  let uploadCalls = 0;
  let processCalls = 0;
  let createCalls = 0;
  let releaseFirstCreate;
  const firstCreateGate = new Promise((resolve) => {
    releaseFirstCreate = resolve;
  });

  await installFakeAudio(page);

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    const sessionIndex = sessionCreateCalls;
    sessionCreateCalls += 1;
    const id = sessionIndex === 0 ? "session-one" : "session-two";
    const createdAt =
      sessionIndex === 0 ? "2026-04-19T06:35:00.000Z" : "2026-04-19T06:36:00.000Z";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSessionSummary(id, createdAt))
    });
  });

  for (const sessionId of ["session-one", "session-two"]) {
    await page.route(`**/api/sessions/${sessionId}/upload`, async (route) => {
      uploadCalls += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true })
      });
    });

    await page.route(`**/api/sessions/${sessionId}/process`, async (route) => {
      processCalls += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(buildSessionDetail(sessionId, "2026-04-19T06:35:00.000Z", false))
      });
    });
  }

  await page.route("**/api/sessions/session-one/create", async (route) => {
    createCalls += 1;
    await firstCreateGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: buildSessionDetail("session-one", "2026-04-19T06:35:00.000Z", true)
      })
    });
  });

  await page.route("**/api/sessions/session-two/create", async (route) => {
    createCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: buildSessionDetail("session-two", "2026-04-19T06:36:00.000Z", true)
      })
    });
  });

  await page.goto(BASE_URL);

  await drawStroke(page);
  let goButton = page.getByRole("button", { name: "Go generate this take" });
  await expect(goButton).toBeVisible();
  await goButton.click();

  await expect.poll(() => sessionCreateCalls).toBe(1);
  await expect.poll(() => uploadCalls).toBe(1);
  await expect.poll(() => processCalls).toBe(1);
  await expect.poll(() => createCalls).toBe(1);

  await drawStroke(page);
  goButton = page.getByRole("button", { name: "Go generate this take" });
  await expect(goButton).toBeVisible();
  await goButton.click();

  await page.waitForTimeout(1200);
  expect(sessionCreateCalls).toBe(1);
  expect(uploadCalls).toBe(1);
  expect(processCalls).toBe(1);
  expect(createCalls).toBe(1);

  releaseFirstCreate();

  await expect.poll(() => sessionCreateCalls).toBe(2);
  await expect.poll(() => uploadCalls).toBe(2);
  await expect.poll(() => processCalls).toBe(2);
  await expect.poll(() => createCalls).toBe(2);
  const firstSessionLink = page.locator('a[href="/sessions/session-one/image"]');
  const secondSessionLink = page.locator('a[href="/sessions/session-two/image"]');
  await expect(firstSessionLink).toBeVisible();
  await expect(secondSessionLink).toBeVisible();
  await expect(firstSessionLink.locator("..")).not.toHaveClass(/recorder-gallery-card-failed/);
  await expect(secondSessionLink.locator("..")).not.toHaveClass(/recorder-gallery-card-failed/);
});
