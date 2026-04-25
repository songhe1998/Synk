import { resolveWebsiteEditTarget } from "../lib/website-edit-targeting";
import { WebsiteEditAnnotation, WebsiteEditDomCandidate, WebsiteEditRect } from "../lib/types";

interface BenchmarkCase {
  name: string;
  instructionText: string;
  annotation: WebsiteEditAnnotation;
  domCandidates: WebsiteEditDomCandidate[];
  expectedTargetId: string;
}

function naturalLoop(cx: number, cy: number, rx: number, ry: number): WebsiteEditAnnotation {
  const points = Array.from({ length: 54 }, (_, index) => {
    const theta = (index / 53) * Math.PI * 2;
    const wobble = Math.sin(index * 1.31) * 4 + Math.cos(index * 0.73) * 2;
    return {
      x: cx + Math.cos(theta) * (rx + wobble) + Math.sin(index * 0.47) * 2.2,
      y: cy + Math.sin(theta) * (ry - wobble) + Math.cos(index * 0.63) * 2.5
    };
  });
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    viewportWidth: 1280,
    viewportHeight: 820,
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
    strokes: [{ id: "human-loop", points }]
  };
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

const cases: BenchmarkCase[] = [
  {
    name: "vague resize on hero headline",
    instructionText: "uh this part could be bigger",
    annotation: naturalLoop(330, 210, 245, 78),
    expectedTargetId: "hero-title",
    domCandidates: [
      candidate("hero", ".hero", "section", { x: 64, y: 92, width: 760, height: 398 }, {
        className: "hero",
        text: "Turn sketches into websites Build with voice"
      }),
      candidate("hero-title", ".hero h1", "h1", { x: 96, y: 146, width: 492, height: 128 }, {
        className: "hero-title",
        text: "Turn sketches into websites"
      }),
      candidate("hero-copy", ".hero .copy", "p", { x: 100, y: 304, width: 520, height: 68 }, {
        text: "Draw a concept and narrate the details."
      })
    ]
  },
  {
    name: "CTA button local resize",
    instructionText: "make this button pop more",
    annotation: naturalLoop(874, 574, 108, 44),
    expectedTargetId: "signup-button",
    domCandidates: [
      candidate("plan-card", ".plan-card", "article", { x: 706, y: 322, width: 350, height: 360 }, {
        className: "plan-card",
        text: "Team plan Unlimited projects Start free"
      }),
      candidate("signup-button", ".plan-card .signup", "button", { x: 780, y: 536, width: 190, height: 64 }, {
        className: "signup",
        role: "button",
        text: "Start free"
      })
    ]
  },
  {
    name: "whole pricing card emphasis",
    instructionText: "this whole card should feel more important",
    annotation: naturalLoop(888, 502, 196, 206),
    expectedTargetId: "plan-card",
    domCandidates: [
      candidate("page", "main", "main", { x: 0, y: 0, width: 1280, height: 820 }),
      candidate("plan-card", ".plan-card", "article", { x: 706, y: 300, width: 356, height: 398 }, {
        className: "plan-card featured",
        text: "Team plan Unlimited projects Start free"
      }),
      candidate("signup-button", ".plan-card .signup", "button", { x: 780, y: 548, width: 190, height: 64 }, {
        className: "signup",
        role: "button",
        text: "Start free"
      })
    ]
  },
  {
    name: "photo replacement target",
    instructionText: "swap this photo for something warmer",
    annotation: naturalLoop(1014, 252, 148, 126),
    expectedTargetId: "hero-image",
    domCandidates: [
      candidate("hero-image-wrap", ".hero-media", "div", { x: 850, y: 112, width: 336, height: 292 }, {
        className: "hero-media image-card"
      }),
      candidate("hero-image", ".hero-media img", "img", { x: 876, y: 138, width: 284, height: 236 }, {
        className: "hero-image",
        ariaLabel: "Restaurant dining room"
      })
    ]
  }
];

let failures = 0;

for (const testCase of cases) {
  const result = resolveWebsiteEditTarget(testCase);
  const passed = result.targetElementId === testCase.expectedTargetId;
  if (!passed) {
    failures += 1;
  }

  console.log(
    [
      passed ? "PASS" : "FAIL",
      testCase.name,
      `expected=${testCase.expectedTargetId}`,
      `actual=${result.targetElementId ?? "none"}`,
      `confidence=${result.confidence.toFixed(2)}`
    ].join(" | ")
  );
  console.log(`  ${result.reason}`);
}

if (failures) {
  console.error(`\n${failures} website edit benchmark case(s) failed.`);
  process.exit(1);
}

console.log(`\n${cases.length} website edit benchmark case(s) passed.`);
