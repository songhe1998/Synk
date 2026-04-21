import assert from "node:assert/strict";
import { test } from "node:test";
import { findMetaCopyPatternMatches } from "../lib/website-meta-copy";

test("findMetaCopyPatternMatches catches design-process leakage phrases", () => {
  const content = `
    The composition follows the original request closely.
    The story cards are not decorative placeholders.
    The hero remains a real landing page instead of a static poster.
  `;

  const matches = findMetaCopyPatternMatches(content);

  assert.deepEqual(matches.sort(), [
    "hero remains",
    "landing page instead of",
    "original request",
    "placeholder",
    "static poster",
    "the composition"
  ]);
});

test("findMetaCopyPatternMatches ignores normal user-facing copy", () => {
  const content = `
    Derek and Joyce keep a small archive of letters, milestones, and notes from the years that shaped them.
    Explore the portrait, read the timeline, and contact the couple for the celebration schedule.
  `;

  const matches = findMetaCopyPatternMatches(content);

  assert.deepEqual(matches, []);
});
