import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWebsiteEditTarget } from "../lib/website-edit-targeting";
import { WebsiteEditAnnotation, WebsiteEditDomCandidate, WebsiteEditRect } from "../lib/types";

function naturalCircle({
  cx,
  cy,
  rx,
  ry,
  viewportWidth = 1200,
  viewportHeight = 800
}: {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  viewportWidth?: number;
  viewportHeight?: number;
}): WebsiteEditAnnotation {
  const points = Array.from({ length: 42 }, (_, index) => {
    const theta = (index / 41) * Math.PI * 2;
    const wobble = Math.sin(index * 1.7) * 3;
    return {
      x: cx + Math.cos(theta) * (rx + wobble) + Math.sin(index * 0.9) * 2,
      y: cy + Math.sin(theta) * (ry - wobble) + Math.cos(index * 1.1) * 2
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
        points
      }
    ]
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
