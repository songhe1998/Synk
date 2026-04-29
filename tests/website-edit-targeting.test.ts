import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWebsiteEditPrompt,
  compactWebsiteEditTargetResolutionForPrompt,
  resolveWebsiteEditTarget,
  resolveWebsiteEditTargets,
  resolveWebsiteEditTargetsWithIntentParser
} from "../lib/website-edit-targeting";
import { TranscriptToken, WebsiteEditAnnotation, WebsiteEditDomCandidate, WebsiteEditRect, WebsiteJob } from "../lib/types";

function naturalCircle({
  cx,
  cy,
  rx,
  ry,
  startMs,
  durationMs = 360,
  viewportWidth = 1200,
  viewportHeight = 800
}: {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  startMs?: number;
  durationMs?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}): WebsiteEditAnnotation {
  const points = Array.from({ length: 42 }, (_, index) => {
    const theta = (index / 41) * Math.PI * 2;
    const wobble = Math.sin(index * 1.7) * 3;
    return {
      x: cx + Math.cos(theta) * (rx + wobble) + Math.sin(index * 0.9) * 2,
      y: cy + Math.sin(theta) * (ry - wobble) + Math.cos(index * 1.1) * 2,
      ...(typeof startMs === "number" ? { tMs: Math.round(startMs + (durationMs * index) / 41) } : {})
    };
  });
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    viewportWidth,
    viewportHeight,
    devicePixelRatio: 2,
    path: "/",
    scrollX: 0,
    scrollY: 0,
    bbox: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    },
    strokes: [
      {
        id: "natural-circle",
        points,
        startMs: startMs ?? null,
        endMs: typeof startMs === "number" ? startMs + durationMs : null
      }
    ]
  };
}

function timedCharTokens(
  text: string,
  timings: Array<{ phrase: string; occurrence: number; startMs: number; endMs: number }>
): TranscriptToken[] {
  const chars = Array.from(text);
  const overrides = new Map<number, { startMs: number; endMs: number }>();
  timings.forEach((timing) => {
    let seen = 0;
    const phraseChars = Array.from(timing.phrase);
    for (let index = 0; index <= chars.length - phraseChars.length; index += 1) {
      if (chars.slice(index, index + phraseChars.length).join("") !== timing.phrase) {
        continue;
      }
      seen += 1;
      if (seen !== timing.occurrence) {
        continue;
      }
      phraseChars.forEach((_, phraseIndex) => {
        overrides.set(index + phraseIndex, {
          startMs: Math.round(timing.startMs + ((timing.endMs - timing.startMs) * phraseIndex) / phraseChars.length),
          endMs: Math.round(timing.startMs + ((timing.endMs - timing.startMs) * (phraseIndex + 1)) / phraseChars.length)
        });
      });
      break;
    }
  });

  return chars.map((char, index) => {
    const fallbackStart = index * 90;
    const timing = overrides.get(index) ?? { startMs: fallbackStart, endMs: fallbackStart + 80 };
    return {
      id: `tok-${index + 1}`,
      text: char,
      startMs: timing.startMs,
      endMs: timing.endMs,
      granularity: /[,，。]/u.test(char) ? "punctuation" : "char",
      lang: /[\u4e00-\u9fff]/u.test(char) ? "cjk" : "unknown",
      approximate: false
    };
  });
}

function candidate(
  id: string,
  selector: string,
  tagName: string,
  rect: WebsiteEditRect,
  overrides: Partial<WebsiteEditDomCandidate> = {}
): WebsiteEditDomCandidate {
  return {
    id,
    selector,
    tagName,
    role: null,
    text: null,
    ariaLabel: null,
    className: null,
    rect,
    ...overrides
  };
}

function combineAnnotations(...annotations: WebsiteEditAnnotation[]): WebsiteEditAnnotation {
  const points = annotations.flatMap((annotation) => annotation.strokes.flatMap((stroke) => stroke.points));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    viewportWidth: annotations[0]?.viewportWidth ?? 1200,
    viewportHeight: annotations[0]?.viewportHeight ?? 800,
    devicePixelRatio: annotations[0]?.devicePixelRatio ?? 2,
    path: annotations[0]?.path ?? "/",
    scrollX: annotations[0]?.scrollX ?? 0,
    scrollY: annotations[0]?.scrollY ?? 0,
    bbox: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    },
    strokes: annotations.flatMap((annotation, annotationIndex) =>
      annotation.strokes.map((stroke) => ({
        ...stroke,
        id: `${stroke.id}-${annotationIndex}`
      }))
    )
  };
}

test("natural circle around a CTA selects the button over its larger card", () => {
  const result = resolveWebsiteEditTarget({
    instructionText: "uh make this button a little bigger",
    annotation: naturalCircle({ cx: 823, cy: 560, rx: 92, ry: 36 }),
    domCandidates: [
      candidate("page", "main", "main", { x: 0, y: 0, width: 1200, height: 800 }),
      candidate("pricing-card", ".pricing-card", "article", { x: 660, y: 310, width: 330, height: 330 }, {
        className: "pricing-card",
        text: "Pro plan Includes analytics Start now"
      }),
      candidate("cta", ".pricing-card .primary-cta", "button", { x: 720, y: 526, width: 204, height: 58 }, {
        role: "button",
        className: "primary-cta",
        text: "Start now"
      })
    ]
  });

  assert.equal(result.targetElementId, "cta");
  assert.ok(result.confidence > 0.55);
});

test("natural circle around a whole panel selects the card when the request says card", () => {
  const result = resolveWebsiteEditTarget({
    instructionText: "this whole card should stand out more",
    annotation: naturalCircle({ cx: 825, cy: 470, rx: 190, ry: 190 }),
    domCandidates: [
      candidate("page", "main", "main", { x: 0, y: 0, width: 1200, height: 800 }),
      candidate("pricing-card", ".pricing-card", "article", { x: 650, y: 285, width: 350, height: 365 }, {
        className: "pricing-card featured-panel",
        text: "Pro plan Includes analytics Start now"
      }),
      candidate("cta", ".pricing-card .primary-cta", "button", { x: 720, y: 536, width: 204, height: 58 }, {
        role: "button",
        className: "primary-cta",
        text: "Start now"
      })
    ]
  });

  assert.equal(result.targetElementId, "pricing-card");
  assert.ok(result.confidence > 0.45);
});

test("vague bigger request around a hero headline selects the heading", () => {
  const result = resolveWebsiteEditTarget({
    instructionText: "yeah here, make it a bit bigger",
    annotation: naturalCircle({ cx: 314, cy: 220, rx: 230, ry: 86 }),
    domCandidates: [
      candidate("hero", ".hero", "section", { x: 52, y: 120, width: 720, height: 360 }, {
        className: "hero",
        text: "Sync ideas into websites Launch faster"
      }),
      candidate("headline", ".hero h1", "h1", { x: 90, y: 158, width: 460, height: 116 }, {
        className: "headline",
        text: "Sync ideas into websites"
      }),
      candidate("subcopy", ".hero p", "p", { x: 92, y: 296, width: 520, height: 72 }, {
        text: "Launch polished web pages from a spoken sketch."
      })
    ]
  });

  assert.equal(result.targetElementId, "headline");
  assert.ok(result.confidence > 0.35);
});

test("two separate circles with swap intent select the shared card row over one card", () => {
  const result = resolveWebsiteEditTarget({
    instructionText: "these two cards should switch places and the risk one should feel like a warning",
    annotation: combineAnnotations(
      naturalCircle({ cx: 320, cy: 550, rx: 165, ry: 72 }),
      naturalCircle({ cx: 720, cy: 550, rx: 165, ry: 72 })
    ),
    domCandidates: [
      candidate("metrics-section", ".metrics", "section", { x: 80, y: 420, width: 880, height: 300 }, {
        className: "metrics-section",
        text: "SLA coverage At-risk lanes"
      }),
      candidate("metric-row", ".metric-row", "div", { x: 110, y: 480, width: 800, height: 150 }, {
        className: "metric-row",
        text: "SLA coverage 87% At-risk lanes 31"
      }),
      candidate("sla-card", ".sla-card", "article", { x: 110, y: 480, width: 380, height: 150 }, {
        className: "metric-card sla-card",
        text: "SLA coverage 87%"
      }),
      candidate("risk-card", ".risk-card", "article", { x: 530, y: 480, width: 380, height: 150 }, {
        className: "metric-card risk-card",
        text: "At-risk lanes 31"
      })
    ]
  });

  assert.equal(result.targetElementId, "metric-row");
  assert.ok(result.confidence > 0.45);
});

test("timed deictic mentions resolve three separate website edit targets", () => {
  const instructionText = "把这个这个和那个都改大一点";
  const annotation = combineAnnotations(
    naturalCircle({ cx: 160, cy: 200, rx: 66, ry: 35, startMs: 100 }),
    naturalCircle({ cx: 475, cy: 200, rx: 66, ry: 35, startMs: 880 }),
    naturalCircle({ cx: 790, cy: 200, rx: 66, ry: 35, startMs: 1660 })
  );
  const result = resolveWebsiteEditTargets({
    instructionText,
    annotation,
    transcriptTokens: timedCharTokens(instructionText, [
      { phrase: "这个", occurrence: 1, startMs: 160, endMs: 430 },
      { phrase: "这个", occurrence: 2, startMs: 940, endMs: 1210 },
      { phrase: "那个", occurrence: 1, startMs: 1720, endMs: 1990 }
    ]),
    domCandidates: [
      candidate("price-starter", ".starter .price", "strong", { x: 118, y: 176, width: 86, height: 48 }, {
        className: "price",
        text: "$19"
      }),
      candidate("price-growth", ".growth .price", "strong", { x: 433, y: 176, width: 86, height: 48 }, {
        className: "price",
        text: "$49"
      }),
      candidate("price-scale", ".scale .price", "strong", { x: 748, y: 176, width: 86, height: 48 }, {
        className: "price",
        text: "$99"
      })
    ]
  });

  assert.equal(result.mode, "multi");
  assert.deepEqual(result.mentions?.map((mention) => mention.text), ["这个", "这个", "那个"]);
  assert.deepEqual(result.targets?.map((target) => target.targetElementId), [
    "price-starter",
    "price-growth",
    "price-scale"
  ]);
});

test("timed asymmetric deictic move preserves moved item and anchor roles", () => {
  const instructionText = "把那个放到这个前面";
  const annotation = combineAnnotations(
    naturalCircle({ cx: 790, cy: 200, rx: 120, ry: 88, startMs: 100 }),
    naturalCircle({ cx: 160, cy: 200, rx: 120, ry: 88, startMs: 920 })
  );
  const result = resolveWebsiteEditTargets({
    instructionText,
    annotation,
    transcriptTokens: timedCharTokens(instructionText, [
      { phrase: "那个", occurrence: 1, startMs: 190, endMs: 460 },
      { phrase: "这个", occurrence: 1, startMs: 1000, endMs: 1270 }
    ]),
    domCandidates: [
      candidate("card-scale", ".card.scale", "article", { x: 700, y: 100, width: 230, height: 185 }, {
        className: "pricing-card scale",
        text: "Scale $99"
      }),
      candidate("card-starter", ".card.starter", "article", { x: 70, y: 100, width: 230, height: 185 }, {
        className: "pricing-card starter",
        text: "Starter $19"
      })
    ]
  });

  assert.deepEqual(result.targets?.map((target) => target.targetElementId), ["card-scale", "card-starter"]);
  assert.deepEqual(result.targets?.map((target) => target.role), ["moved_item", "anchor"]);
});

test("LLM website edit parser does not silently fall back to rule parser on parser failure", async () => {
  const instructionText = "把这一部分改大一点";
  const result = await resolveWebsiteEditTargetsWithIntentParser(
    {
      instructionText,
      annotation: naturalCircle({ cx: 160, cy: 200, rx: 66, ry: 35, startMs: 100 }),
      transcriptTokens: timedCharTokens(instructionText, [
        { phrase: "这一部分", occurrence: 1, startMs: 160, endMs: 430 }
      ]),
      domCandidates: [
        candidate("price-starter", ".starter .price", "strong", { x: 118, y: 176, width: 86, height: 48 }, {
          className: "price",
          text: "$19"
        })
      ]
    },
    {
      apiKey: ""
    }
  );

  assert.equal(result.targetElementId, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.intentParser?.source, "llm");
  assert.match(result.intentParser?.error ?? "", /OPENAI_API_KEY/);
});

test("LLM website edit parser ignores untargeted extra intents when targetable intents are valid", async () => {
  const instructionText =
    "This one feels detached and empty. And that one is too big and quiet, tighten the rhythm a little.";
  const firstStart = instructionText.indexOf("This one");
  const secondStart = instructionText.indexOf("that one");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        model: "test-model",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  references: [
                    {
                      id: "r1",
                      text: "This one",
                      startTokenIndex: firstStart,
                      endTokenIndex: firstStart + "This one".length - 1,
                      kind: "singular",
                      targetCount: 1,
                      confidence: 0.97,
                      reason: "first deictic reference"
                    },
                    {
                      id: "r2",
                      text: "that one",
                      startTokenIndex: secondStart,
                      endTokenIndex: secondStart + "that one".length - 1,
                      kind: "singular",
                      targetCount: 1,
                      confidence: 0.97,
                      reason: "second deictic reference"
                    }
                  ],
                  intents: [
                    {
                      type: "local_edit",
                      operation: "make integrated",
                      targetReferenceIds: ["r1"],
                      expectedTargetCount: 1,
                      confidence: 0.86,
                      reason: "first target needs more substance"
                    },
                    {
                      type: "local_edit",
                      operation: "decrease size",
                      targetReferenceIds: ["r2"],
                      expectedTargetCount: 1,
                      confidence: 0.84,
                      reason: "second target is too big"
                    },
                    {
                      type: "local_edit",
                      operation: "tighten rhythm",
                      targetReferenceIds: [],
                      expectedTargetCount: 1,
                      confidence: 0.58,
                      reason: "trailing instruction without explicit reference"
                    }
                  ]
                })
              }
            ]
          }
        ]
      }),
      text: async () => ""
    }) as Response) as typeof fetch;

  try {
    const result = await resolveWebsiteEditTargetsWithIntentParser(
      {
        instructionText,
        annotation: combineAnnotations(
          naturalCircle({ cx: 920, cy: 220, rx: 112, ry: 84, startMs: 100 }),
          naturalCircle({ cx: 220, cy: 220, rx: 124, ry: 88, startMs: 920 })
        ),
        transcriptTokens: timedCharTokens(instructionText, [
          { phrase: "This one", occurrence: 1, startMs: 160, endMs: 430 },
          { phrase: "that one", occurrence: 1, startMs: 1000, endMs: 1270 }
        ]),
        domCandidates: [
          candidate("projects", "#projects", "aside", { x: 800, y: 130, width: 240, height: 180 }, {
            text: "Projects Current projects"
          }),
          candidate("abstract-title", "#abstract-title", "h2", { x: 90, y: 130, width: 260, height: 180 }, {
            text: "Researching how cities distribute time"
          })
        ]
      },
      {
        apiKey: "test-key"
      }
    );

    assert.equal(result.intentParser?.source, "llm");
    assert.equal(result.intentParser?.error, null);
    assert.equal(result.mode, "multi");
    assert.deepEqual(result.intents?.map((intent) => intent.targetMentionIds), [["m1"], ["m2"]]);
    assert.deepEqual(result.targets?.map((target) => target.targetElementId), ["projects", "abstract-title"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("website edit prompt uses compact target plan instead of raw stroke point clouds", () => {
  const points = Array.from({ length: 1200 }, (_, index) => ({
    x: 400 + Math.cos(index / 20) * 80,
    y: 260 + Math.sin(index / 20) * 40,
    tMs: index * 12
  }));
  const annotation: WebsiteEditAnnotation = {
    viewportWidth: 1200,
    viewportHeight: 800,
    devicePixelRatio: 2,
    path: "/",
    scrollX: 0,
    scrollY: 0,
    bbox: { x: 320, y: 220, width: 160, height: 80 },
    strokes: [
      {
        id: "long-natural-circle",
        points,
        startMs: 0,
        endMs: 14400
      }
    ]
  };
  const targetResolution = {
    mode: "single",
    annotation,
    ...resolveWebsiteEditTarget({
    instructionText: "make this bigger",
    annotation,
    domCandidates: [
      candidate("hero-title", ".hero h1", "h1", { x: 330, y: 225, width: 150, height: 70 }, {
        text: "Dispatch control"
      })
    ]
    })
  } as const;
  const compact = compactWebsiteEditTargetResolutionForPrompt(targetResolution);
  const compactJson = JSON.stringify(compact);
  const prompt = buildWebsiteEditPrompt({
    parentJob: {
      displayName: "Dispatch dashboard",
      prompt: "parent prompt ".repeat(2000)
    } as WebsiteJob,
    instructionText: "make this bigger",
    targetResolution
  });

  assert.equal(compactJson.includes("\"points\""), false);
  assert.match(compactJson, /"pointCount":1200/);
  assert.equal(prompt.includes("\"points\""), false);
  assert.match(prompt, /visibly sufficient/);
  assert.match(prompt, /final screenshot should show an obvious improvement/);
  assert.ok(prompt.length < 18000);
});

test("website edit prompt can include automated visual QA repair feedback", () => {
  const annotation = naturalCircle({ cx: 240, cy: 180, rx: 90, ry: 48 });
  const targetResolution = resolveWebsiteEditTarget({
    instructionText: "this still looks cramped",
    annotation,
    domCandidates: [
      candidate("settings-card", ".settings-card", "section", { x: 160, y: 130, width: 180, height: 96 }, {
        text: "Active sessions"
      })
    ]
  });
  const prompt = buildWebsiteEditPrompt({
    parentJob: {
      displayName: "Settings",
      prompt: "Build settings page"
    } as WebsiteJob,
    instructionText: "this still looks cramped",
    targetResolution,
    qualityFeedback: "The selected sessions card still looks cramped. Increase hierarchy and spacing visibly."
  });

  assert.match(prompt, /Automated visual QA feedback/);
  assert.match(prompt, /sessions card still looks cramped/);
  assert.match(prompt, /Repair the current source/);
});

test("website edit target plan preserves image asset references for image edits", () => {
  const annotation = naturalCircle({ cx: 720, cy: 360, rx: 180, ry: 110 });
  const targetResolution = resolveWebsiteEditTarget({
    instructionText: "make this image more realistic and different",
    annotation,
    domCandidates: [
      candidate("map-image", ".map-frame img", "img", { x: 560, y: 250, width: 320, height: 220 }, {
        className: "generated-image-fill",
        imageSrcs: ["http://localhost:3000/assets/city-operations-map-DI04N288.png"],
        imageAlts: ["City delivery coverage map"]
      })
    ]
  });
  const compact = compactWebsiteEditTargetResolutionForPrompt(targetResolution);
  const compactJson = JSON.stringify(compact);

  assert.match(compactJson, /city-operations-map-DI04N288\.png/);
  assert.match(compactJson, /City delivery coverage map/);
});
