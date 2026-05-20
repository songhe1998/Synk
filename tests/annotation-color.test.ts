import assert from "node:assert/strict";
import test from "node:test";
import { assignAnnotationColors, chooseBestAnnotationColor } from "@/lib/annotation-color";

function solidImage(width: number, height: number, rgb: [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = rgb[0];
    data[index * 4 + 1] = rgb[1];
    data[index * 4 + 2] = rgb[2];
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

function ellipseStroke(width: number, height: number) {
  return ellipseStrokeAt(width, height, width / 2, height / 2);
}

function ellipseStrokeAt(width: number, height: number, cx: number, cy: number, id = "stroke-1") {
  const points = [];
  const rx = width * 0.28;
  const ry = height * 0.22;
  for (let index = 0; index <= 96; index += 1) {
    const angle = (Math.PI * 2 * index) / 96;
    points.push({
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry
    });
  }
  return [{ id, points }];
}

function splitImage(width: number, height: number, splitX: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const value = x >= splitX ? 0 : 255;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

test("avoids white on a light background", () => {
  const image = solidImage(180, 120, [246, 246, 246]);
  const choice = chooseBestAnnotationColor(image, ellipseStroke(image.width, image.height));
  assert.notEqual(choice.bestColor, "#ffffff");
  assert.ok(choice.ranking[0].score > choice.ranking.find((item) => item.color === "#ffffff")!.score);
});

test("avoids black on a dark background", () => {
  const image = solidImage(180, 120, [18, 20, 24]);
  const choice = chooseBestAnnotationColor(image, ellipseStroke(image.width, image.height));
  assert.notEqual(choice.bestColor, "#000000");
  assert.ok(choice.ranking[0].score > choice.ranking.find((item) => item.color === "#000000")!.score);
});

test("rejects a high-average color that disappears on a long segment", () => {
  const image = splitImage(220, 140, 142);
  const choice = chooseBestAnnotationColor(image, ellipseStroke(image.width, image.height));
  const best = choice.ranking[0];
  const black = choice.ranking.find((item) => item.color === "#000000")!;

  assert.notEqual(choice.bestColor, "#000000");
  assert.ok(best.score > black.score);
  assert.ok(best.longestBadSegmentRatio < black.longestBadSegmentRatio);
});

test("penalizes a color that matches the local stroke background", () => {
  const image = solidImage(180, 120, [255, 58, 48]);
  const choice = chooseBestAnnotationColor(image, ellipseStroke(image.width, image.height));
  assert.notEqual(choice.bestColor, "#ff3b30");
  assert.ok(choice.ranking[0].score > choice.ranking.find((item) => item.color === "#ff3b30")!.score);
});

test("globally assigns distinct colors when multiple strokes share the same local favorite", () => {
  const image = solidImage(260, 180, [246, 246, 246]);
  const strokes = [
    ellipseStrokeAt(image.width, image.height, 80, 84, "a")[0],
    ellipseStrokeAt(image.width, image.height, 176, 92, "b")[0],
    ellipseStrokeAt(image.width, image.height, 132, 126, "c")[0]
  ];
  const assignment = assignAnnotationColors(image, strokes);
  const colors = assignment.assignments.map((item) => item.color);

  assert.equal(new Set(colors).size, colors.length);
  assert.equal(assignment.duplicateCount, 0);
  assert.ok(assignment.minPairDistance > 0.2);
});

test("unique colors are a hard constraint while stroke count fits the palette", () => {
  const image = solidImage(320, 220, [246, 246, 246]);
  const strokes = Array.from({ length: 6 }, (_, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    return ellipseStrokeAt(image.width, image.height, 62 + column * 86, 72 + row * 78, `s${index}`)[0];
  });
  const assignment = assignAnnotationColors(image, strokes);
  const colors = assignment.assignments.map((item) => item.color);

  assert.equal(colors.length, 6);
  assert.equal(new Set(colors).size, 6);
  assert.equal(assignment.duplicateCount, 0);
});

test("global assignment can recolor an old stroke to make room for a new one", () => {
  const image = solidImage(260, 180, [246, 246, 246]);
  const strokes = [
    { ...ellipseStrokeAt(image.width, image.height, 80, 84, "a")[0], color: "#000000" },
    ellipseStrokeAt(image.width, image.height, 176, 92, "b")[0]
  ];
  const assignment = assignAnnotationColors(image, strokes);

  assert.equal(assignment.duplicateCount, 0);
  assert.equal(assignment.assignments.length, 2);
  assert.ok(assignment.assignments.some((item) => item.color !== "#000000"));
});
