import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

type Shape =
  | { type: "rect"; x: number; y: number; width: number; height: number }
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number }
  | { type: "polyline"; points: Array<[number, number]> };

interface BenchmarkSpec {
  slug: string;
  title: string;
  transcriptText: string;
  canvasWidth: number;
  canvasHeight: number;
  shapes: Shape[];
  labels: Array<{ text: string; x: number; y: number }>;
}

const SESSION_ROOT = path.join(process.cwd(), "data", "sessions");
const BENCHMARK_ROOT = path.join(process.cwd(), "data", "website-benchmarks");

const SPECS: BenchmarkSpec[] = [
  {
    slug: "alpine-retreat",
    title: "Synthetic Alpine Retreat",
    transcriptText: "Draw a large sun above a jagged mountain ridge.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "circle", cx: 980, cy: 120, r: 80 },
      { type: "polyline", points: [[220, 470], [420, 320], [560, 420], [760, 260], [980, 430], [1140, 340]] }
    ],
    labels: [
      { text: "sun", x: 980, y: 28 },
      { text: "mountains", x: 720, y: 234 }
    ]
  },
  {
    slug: "city-avenue",
    title: "Synthetic City Avenue",
    transcriptText:
      "Draw a sun over a city avenue with tall buildings, cars, a long road, and a row of clouds.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "circle", cx: 180, cy: 120, r: 70 },
      { type: "rect", x: 120, y: 260, width: 130, height: 320 },
      { type: "rect", x: 320, y: 210, width: 120, height: 380 },
      { type: "rect", x: 850, y: 220, width: 140, height: 360 },
      { type: "rect", x: 1040, y: 260, width: 90, height: 300 },
      { type: "line", x1: 620, y1: 160, x2: 620, y2: 650 },
      { type: "line", x1: 700, y1: 160, x2: 700, y2: 650 },
      { type: "rect", x: 650, y: 360, width: 40, height: 90 },
      { type: "rect", x: 650, y: 500, width: 40, height: 90 },
      { type: "polyline", points: [[820, 80], [900, 60], [980, 76], [1060, 58], [1140, 72]] }
    ],
    labels: [
      { text: "sun", x: 180, y: 24 },
      { text: "tall buildings", x: 1040, y: 168 },
      { text: "road", x: 670, y: 120 },
      { text: "cars", x: 690, y: 326 },
      { text: "clouds", x: 1128, y: 20 }
    ]
  },
  {
    slug: "bedroom-river",
    title: "Synthetic Bedroom River",
    transcriptText:
      "Draw a bedroom with a window, a bed, a desk, a chair, and a river visible outside.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "rect", x: 220, y: 110, width: 430, height: 18 },
      { type: "rect", x: 220, y: 126, width: 18, height: 260 },
      { type: "rect", x: 650, y: 126, width: 18, height: 260 },
      { type: "polyline", points: [[280, 250], [360, 220], [440, 250], [520, 210], [600, 250]] },
      { type: "rect", x: 840, y: 230, width: 250, height: 170 },
      { type: "rect", x: 920, y: 420, width: 180, height: 26 },
      { type: "rect", x: 260, y: 470, width: 260, height: 120 },
      { type: "rect", x: 300, y: 390, width: 190, height: 26 }
    ],
    labels: [
      { text: "river", x: 520, y: 178 },
      { text: "window", x: 460, y: 78 },
      { text: "desk", x: 990, y: 190 },
      { text: "chair", x: 1048, y: 456 },
      { text: "bed", x: 390, y: 432 }
    ]
  },
  {
    slug: "cow-sheep-chase",
    title: "Synthetic Cow Sheep Chase",
    transcriptText: "Draw a cow on one side, and a sheep chasing the cow from the other side.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "ellipse", cx: 360, cy: 390, rx: 130, ry: 95 },
      { type: "ellipse", cx: 890, cy: 380, rx: 120, ry: 92 },
      { type: "line", x1: 780, y1: 370, x2: 690, y2: 360 },
      { type: "line", x1: 760, y1: 330, x2: 690, y2: 300 }
    ],
    labels: [
      { text: "cow", x: 360, y: 258 },
      { text: "sheep", x: 888, y: 252 }
    ]
  },
  {
    slug: "lighthouse-cliff",
    title: "Synthetic Lighthouse Cliff",
    transcriptText: "Draw a lighthouse on a cliff with waves below and a moon in the sky.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "circle", cx: 990, cy: 120, r: 52 },
      { type: "polyline", points: [[210, 450], [420, 420], [600, 260], [780, 290]] },
      { type: "rect", x: 580, y: 120, width: 42, height: 180 },
      { type: "line", x1: 540, y1: 560, x2: 980, y2: 560 },
      { type: "line", x1: 520, y1: 610, x2: 1000, y2: 610 }
    ],
    labels: [
      { text: "moon", x: 990, y: 34 },
      { text: "lighthouse", x: 604, y: 84 },
      { text: "cliff", x: 436, y: 374 },
      { text: "waves", x: 944, y: 524 }
    ]
  },
  {
    slug: "balloons-canyon",
    title: "Synthetic Balloons Canyon",
    transcriptText: "Draw three hot air balloons floating over a canyon at sunrise.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "circle", cx: 260, cy: 160, r: 55 },
      { type: "circle", cx: 530, cy: 100, r: 70 },
      { type: "circle", cx: 900, cy: 170, r: 60 },
      { type: "line", x1: 260, y1: 214, x2: 260, y2: 250 },
      { type: "line", x1: 530, y1: 170, x2: 530, y2: 218 },
      { type: "line", x1: 900, y1: 230, x2: 900, y2: 270 },
      { type: "polyline", points: [[100, 520], [260, 410], [420, 540], [620, 390], [780, 520], [980, 420], [1160, 560]] }
    ],
    labels: [
      { text: "balloon", x: 260, y: 76 },
      { text: "balloon", x: 530, y: 10 },
      { text: "balloon", x: 900, y: 88 },
      { text: "canyon", x: 730, y: 352 }
    ]
  },
  {
    slug: "coffee-rain-window",
    title: "Synthetic Coffee Rain Window",
    transcriptText:
      "Draw a coffee cup, a notebook, a window with rain outside, and a lamp over the desk.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "rect", x: 160, y: 90, width: 520, height: 320 },
      { type: "line", x1: 420, y1: 90, x2: 420, y2: 410 },
      { type: "line", x1: 220, y1: 150, x2: 270, y2: 210 },
      { type: "line", x1: 300, y1: 160, x2: 350, y2: 220 },
      { type: "line", x1: 520, y1: 150, x2: 570, y2: 210 },
      { type: "ellipse", cx: 930, cy: 470, rx: 90, ry: 60 },
      { type: "rect", x: 650, y: 450, width: 140, height: 110 },
      { type: "line", x1: 1040, y1: 100, x2: 910, y2: 220 }
    ],
    labels: [
      { text: "window", x: 420, y: 48 },
      { text: "rain", x: 262, y: 112 },
      { text: "notebook", x: 720, y: 414 },
      { text: "coffee cup", x: 930, y: 394 },
      { text: "lamp", x: 1040, y: 60 }
    ]
  },
  {
    slug: "record-player",
    title: "Synthetic Record Player",
    transcriptText: "Draw a record player with two speakers and a few music notes floating above.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "rect", x: 380, y: 270, width: 520, height: 220 },
      { type: "circle", cx: 640, cy: 380, r: 78 },
      { type: "rect", x: 160, y: 240, width: 120, height: 280 },
      { type: "rect", x: 1000, y: 240, width: 120, height: 280 },
      { type: "line", x1: 760, y1: 280, x2: 860, y2: 210 },
      { type: "line", x1: 860, y1: 210, x2: 950, y2: 150 }
    ],
    labels: [
      { text: "record player", x: 640, y: 220 },
      { text: "speaker", x: 220, y: 200 },
      { text: "speaker", x: 1060, y: 200 },
      { text: "music notes", x: 948, y: 112 }
    ]
  },
  {
    slug: "market-stall",
    title: "Synthetic Market Stall",
    transcriptText:
      "Draw a market stall with a striped canopy, fruit crates, a hanging sign, and a shopper bag.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "rect", x: 300, y: 170, width: 520, height: 24 },
      { type: "polyline", points: [[300, 194], [360, 280], [430, 194], [500, 280], [570, 194], [640, 280], [710, 194], [820, 280]] },
      { type: "rect", x: 360, y: 280, width: 420, height: 220 },
      { type: "rect", x: 400, y: 520, width: 140, height: 90 },
      { type: "rect", x: 600, y: 520, width: 140, height: 90 },
      { type: "rect", x: 900, y: 260, width: 120, height: 90 },
      { type: "rect", x: 970, y: 430, width: 70, height: 110 }
    ],
    labels: [
      { text: "canopy", x: 566, y: 124 },
      { text: "stall", x: 566, y: 244 },
      { text: "fruit crates", x: 588, y: 480 },
      { text: "sign", x: 962, y: 220 },
      { text: "shopper bag", x: 1006, y: 390 }
    ]
  },
  {
    slug: "stadium-night",
    title: "Synthetic Stadium Night",
    transcriptText:
      "Draw a soccer stadium at night with floodlights, a ball on the field, and crowd stands around it.",
    canvasWidth: 1280,
    canvasHeight: 720,
    shapes: [
      { type: "ellipse", cx: 640, cy: 420, rx: 300, ry: 120 },
      { type: "circle", cx: 640, cy: 420, r: 34 },
      { type: "line", x1: 300, y1: 200, x2: 360, y2: 90 },
      { type: "line", x1: 980, y1: 200, x2: 920, y2: 90 },
      { type: "line", x1: 360, y1: 90, x2: 440, y2: 90 },
      { type: "line", x1: 840, y1: 90, x2: 920, y2: 90 },
      { type: "polyline", points: [[220, 290], [360, 230], [920, 230], [1060, 290]] }
    ],
    labels: [
      { text: "field", x: 640, y: 268 },
      { text: "ball", x: 640, y: 352 },
      { text: "floodlights", x: 440, y: 48 },
      { text: "crowd stands", x: 1000, y: 194 }
    ]
  }
];

function tokenizeTranscript(transcriptText: string) {
  return transcriptText
    .trim()
    .split(/\s+/)
    .map((text, index) => ({
      id: `token-${index + 1}`,
      text,
      startMs: index * 320,
      endMs: index * 320 + 260,
      granularity: "word",
      lang: "en",
      approximate: false
    }));
}

function renderSvg(spec: BenchmarkSpec, annotated: boolean) {
  const background = `<rect width="${spec.canvasWidth}" height="${spec.canvasHeight}" fill="#faf6ea" />`;
  const strokes = spec.shapes
    .map((shape) => {
      switch (shape.type) {
        case "rect":
          return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="none" stroke="#1c1c1c" stroke-width="8" rx="6" />`;
        case "circle":
          return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" fill="none" stroke="#1c1c1c" stroke-width="8" />`;
        case "ellipse":
          return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" fill="none" stroke="#1c1c1c" stroke-width="8" />`;
        case "line":
          return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" stroke="#1c1c1c" stroke-width="8" stroke-linecap="round" />`;
        case "polyline":
          return `<polyline points="${shape.points.map(([x, y]) => `${x},${y}`).join(" ")}" fill="none" stroke="#1c1c1c" stroke-width="8" stroke-linejoin="round" stroke-linecap="round" />`;
      }
    })
    .join("");

  const labels = annotated
    ? spec.labels
        .map((label) => {
          const width = Math.max(108, label.text.length * 10 + 28);
          const x = label.x - width / 2;
          const y = label.y;
          return [
            `<rect x="${x}" y="${y}" width="${width}" height="36" rx="18" fill="#f8fff8" stroke="#7aa59b" stroke-width="2" />`,
            `<text x="${label.x}" y="${y + 23}" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="16" fill="#355d54">${label.text}</text>`,
            `<line x1="${label.x}" y1="${y + 36}" x2="${label.x}" y2="${y + 68}" stroke="#7aa59b" stroke-width="2" stroke-linecap="round" />`
          ].join("");
        })
        .join("")
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${spec.canvasWidth}" height="${spec.canvasHeight}" viewBox="0 0 ${spec.canvasWidth} ${spec.canvasHeight}">
  ${background}
  ${strokes}
  ${labels}
</svg>`;
}

async function writePng(filePath: string, svg: string) {
  const sharp = (await import("sharp")).default;
  await writeFile(filePath, await sharp(Buffer.from(svg)).png().toBuffer());
}

async function main() {
  const roundId = `synthetic-round-${new Date().toISOString().slice(0, 10)}`;
  const manifest = [];

  await mkdir(BENCHMARK_ROOT, { recursive: true });

  for (const spec of SPECS) {
    const sessionId = randomUUID();
    const sessionDir = path.join(SESSION_ROOT, sessionId);
    await rm(sessionDir, { recursive: true, force: true });
    await mkdir(sessionDir, { recursive: true });

    const createdAt = new Date().toISOString();
    const meta = {
      id: sessionId,
      title: spec.title,
      status: "ready",
      createdAt,
      updatedAt: createdAt,
      durationMs: 2000,
      audioMimeType: null,
      canvasWidth: spec.canvasWidth,
      canvasHeight: spec.canvasHeight,
      transcriptApproximate: false,
      analysisReasoningEffort: "medium",
      imageSizePreset: "medium",
      imageGenerationProfile: "pro",
      errorMessage: null
    };
    const analysis = {
      model: "synthetic-benchmark",
      createdAt,
      transcriptText: spec.transcriptText,
      objects: [],
      globalInfo: {
        background: "",
        style: "",
        relationships: "",
        story: "",
        extra: ""
      },
      generationPrompt: "",
      notes: ["Synthetic benchmark fixture"]
    };

    await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(path.join(sessionDir, "events.json"), JSON.stringify([], null, 2));
    await writeFile(
      path.join(sessionDir, "transcript.json"),
      JSON.stringify(tokenizeTranscript(spec.transcriptText), null, 2)
    );
    await writeFile(path.join(sessionDir, "analysis.json"), JSON.stringify(analysis, null, 2));
    await writePng(path.join(sessionDir, "sketch.png"), renderSvg(spec, false));
    await writePng(path.join(sessionDir, "annotated-sketch.png"), renderSvg(spec, true));

    manifest.push({
      sessionId,
      slug: spec.slug,
      title: spec.title,
      transcriptText: spec.transcriptText
    });
  }

  const manifestPath = path.join(BENCHMARK_ROOT, `${roundId}.json`);
  await writeFile(manifestPath, JSON.stringify({ roundId, tasks: manifest }, null, 2));
  process.stdout.write(`${manifestPath}\n`);
}

void main();
