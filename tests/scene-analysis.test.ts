import assert from "node:assert/strict";
import { test } from "node:test";
import { groundSceneExtraction } from "../lib/scene-analysis";
import { DrawingEvent, TranscriptToken } from "../lib/types";

function word(id: string, text: string, startMs: number, endMs: number): TranscriptToken {
  return {
    id,
    text,
    startMs,
    endMs,
    granularity: "word",
    lang: "latin",
    approximate: false
  };
}

function stroke(
  strokeId: string,
  startMs: number,
  endMs: number,
  from: { x: number; y: number },
  to: { x: number; y: number }
): DrawingEvent[] {
  return [
    {
      type: "stroke_begin",
      strokeId,
      tool: "pen",
      color: "#222222",
      width: 4,
      x: from.x,
      y: from.y,
      pressure: 1,
      tMs: startMs
    },
    {
      type: "stroke_end",
      strokeId,
      x: to.x,
      y: to.y,
      pressure: 1,
      tMs: endMs
    }
  ];
}

test("grounded scene generation prompt includes explicit sketch layout relationships", () => {
  const transcript = [
    word("t1", "buildings", 1000, 1300),
    word("t2", "river", 5200, 5500),
    word("t3", "mall", 9200, 9500),
    word("t4", "moon", 13200, 13500),
    word("t5", "city", 16000, 16300),
    word("t6", "vibe", 16300, 16600)
  ];
  const events = [
    ...stroke("building", 900, 1400, { x: 24, y: 42 }, { x: 24, y: 106 }),
    ...stroke("river", 5000, 5600, { x: 100, y: 8 }, { x: 100, y: 112 }),
    ...stroke("mall", 9000, 9600, { x: 166, y: 50 }, { x: 188, y: 92 }),
    ...stroke("moon", 13000, 13600, { x: 18, y: 12 }, { x: 42, y: 20 })
  ];

  const analysis = groundSceneExtraction({
    transcript,
    events,
    extractionModel: "test-model",
    canvasWidth: 200,
    canvasHeight: 120,
    extraction: {
      objects: [
        {
          tag: "buildings",
          label: "buildings",
          description: "city buildings",
          evidence_quotes: ["buildings", "city vibe"]
        },
        {
          tag: "river",
          label: "river",
          description: "river",
          evidence_quotes: ["river"]
        },
        {
          tag: "mall",
          label: "mall",
          description: "mall",
          evidence_quotes: ["mall"]
        },
        {
          tag: "moon",
          label: "moon",
          description: "moon",
          evidence_quotes: ["moon"]
        }
      ],
      global_info: {
        background: "",
        style: "",
        relationships: "",
        story: "",
        extra: ""
      },
      generation_prompt: "Create a night city scene with buildings, a river, a mall, and a moon."
    }
  });

  assert.deepEqual(analysis.objects[0].clusterIds, ["cluster_1"]);
  assert.ok(analysis.objects[0].centroid);
  assert.ok(analysis.objects[0].centroid.x < 60);
  assert.match(analysis.generationPrompt, /Follow this grounded sketch layout/);
  assert.match(analysis.generationPrompt, /buildings on the far left side/);
  assert.match(analysis.generationPrompt, /river running from the upper center toward the lower center/);
  assert.match(analysis.generationPrompt, /mall on the far right side/);
  assert.match(analysis.generationPrompt, /moon in the top-left/);
  assert.match(analysis.generationPrompt, /buildings left of river/);
  assert.match(analysis.generationPrompt, /mall below and right of moon/);
});
