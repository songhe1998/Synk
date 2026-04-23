import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWebsiteScaffoldOverrides,
  inferWebsiteScaffoldFamily,
  inferWebsiteScaffoldVariant
} from "../lib/website-scaffold";
import type { WebsiteJob } from "../lib/types";

function makeJob(transcriptText: string): WebsiteJob {
  return {
    id: "job-1",
    sessionId: "session-1",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    displayName: "Test Website",
    framework: "vite-react",
    sandboxProvider: "vercel",
    sandboxId: null,
    transcriptText,
    pages: [
      {
        id: "page-1",
        title: "Main",
        path: "/",
        sourceAssetKind: "generatedImageLabeled",
        sketchUrl: null
      }
    ],
    prompt: "",
    statusDetail: null,
    errorMessage: null,
    previewImageUrl: null,
    codeArchiveUrl: null,
    distArchiveUrl: null,
    previewUrl: null,
    previewImageFileName: null,
    previewImageMimeType: null,
    codeArchiveFileName: null,
    codeArchiveMimeType: null,
    distArchiveFileName: null,
    distArchiveMimeType: null
  };
}

test("inferWebsiteScaffoldFamily routes editorial briefs to editorial", () => {
  assert.equal(
    inferWebsiteScaffoldFamily(
      "Create a historian journal homepage with essays, archive hero, lectures note, and publication links."
    ),
    "editorial"
  );
});

test("inferWebsiteScaffoldFamily routes product briefs to product", () => {
  assert.equal(
    inferWebsiteScaffoldFamily(
      "Create a privacy settings dashboard with sidebar navigation, analytics panel, metrics, and security controls."
    ),
    "product"
  );
});

test("buildWebsiteScaffoldOverrides returns scaffold overrides for App and styles", () => {
  const overrides = buildWebsiteScaffoldOverrides(
    makeJob("Create a launch landing page with hero, features, proof, and a booking CTA.")
  );

  assert.equal(overrides.family, "marketing");
  assert.deepEqual(
    overrides.files.map((file) => file.relativePath).sort(),
    ["src/App.tsx", "src/styles.css"]
  );
});

test("inferWebsiteScaffoldVariant distinguishes dashboard and settings product briefs", () => {
  assert.equal(
    inferWebsiteScaffoldVariant(
      "Create a logistics operations dashboard with route board, shipments, alerts, metrics, and an exception desk."
    ),
    "product-dashboard"
  );

  assert.equal(
    inferWebsiteScaffoldVariant(
      "Create a privacy and security settings page with profile ownership, recovery, billing, and permissions."
    ),
    "product-settings"
  );
});
