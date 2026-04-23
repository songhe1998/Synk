import type { WebsiteJob } from "@/lib/types";
import type { WebsiteAssetPlan } from "@/lib/website-asset-plan";
import { inferWebsiteScaffoldFamily, inferWebsiteScaffoldVariant } from "@/lib/website-scaffold";

interface BuildWebsiteDesignSpecParams {
  job: WebsiteJob;
  mode: "direct" | "preview-first";
  assetPlan?: WebsiteAssetPlan;
}

function getTokenGuidance(variant: ReturnType<typeof inferWebsiteScaffoldVariant>) {
  if (variant === "product-dashboard") {
    return [
      "- Canvas: warm paper or pale neutral shell with dark ink and a small teal/green status accent.",
      "- Density: medium-high. Multiple operational zones should be visible without feeling cramped.",
      "- Borders: strong hairline or medium dark outlines are acceptable when they improve scanability.",
      "- Typography: large serif or authoritative display for section titles, utility sans for controls and data labels.",
      "- Radius: medium to large, but keep rectangles disciplined rather than bubbly."
    ].join("\n");
  }

  if (variant === "product-settings") {
    return [
      "- Canvas: bright or warm neutral background with one strong shell color and one muted accent.",
      "- Density: medium. Settings must feel calm, grouped, and easy to scan.",
      "- Borders: use clear section containers and list rows where they aid comprehension.",
      "- Typography: strong headline plus restrained utility sans hierarchy.",
      "- Radius: medium to large, softer than dashboard but still structured."
    ].join("\n");
  }

  if (variant === "editorial") {
    return [
      "- Canvas: dark immersive shell or paper-like stage depending on the preview.",
      "- Typography: one expressive serif/display voice plus one disciplined supporting sans.",
      "- Density: lower than product UI. Let major type and image rhythm breathe.",
      "- Borders: use sparingly. Prefer rules, bands, and framed image plates over repetitive cards."
    ].join("\n");
  }

  return [
    "- Canvas: one coherent atmospheric background treatment with disciplined contrast.",
    "- Typography: clear display + supporting utility hierarchy.",
    "- Density: moderate, with emphasis on a memorable first viewport.",
    "- Borders: use only where they clarify modules or actions."
  ].join("\n");
}

function getPrimitiveGuidance(variant: ReturnType<typeof inferWebsiteScaffoldVariant>) {
  const shared = [
    "- `SurfacePanel`: use for major containers that need clear structure.",
    "- `ActionButton`: use for decisive CTA or toolbar actions.",
    "- `StatusPill`: use for small operational or state badges.",
    "- `SectionTitle`: use for grouped heading + eyebrow treatment."
  ];

  if (variant === "product-dashboard") {
    return [
      ...shared,
      "- `SidebarNav`: use for the left rail instead of hand-rolling another nav shell.",
      "- `MetricTile`: use for the top metrics strip or KPI cards.",
      "- `SearchShell`: use for the top search / filter bar.",
      "- `InfoList`: use for alerts, shipment cards, or watchlists."
    ].join("\n");
  }

  if (variant === "product-settings") {
    return [
      ...shared,
      "- `SidebarNav`: use for account/settings navigation.",
      "- `MetricTile`: use only for compact trust/security/supporting stats.",
      "- `InfoList`: use for grouped settings rows, security notes, or supporting notices."
    ].join("\n");
  }

  return [
    ...shared,
    "- `InfoList`: use for support notes, story lists, or small grouped detail modules."
  ].join("\n");
}

function getLayoutGuidance(variant: ReturnType<typeof inferWebsiteScaffoldVariant>) {
  if (variant === "product-dashboard") {
    return [
      "- Preserve a real working-board feel: left rail, command/top bar, main operational surface, and an exception/alerts rail.",
      "- At least three distinct operational zones should be visible in the first viewport.",
      "- Use the largest surface for the route board / map / main live board rather than letting the page collapse into stacked cards.",
      "- Keep supporting stats and alerts dense, concise, and obviously actionable."
    ].join("\n");
  }

  if (variant === "product-settings") {
    return [
      "- Keep the first viewport focused on identity + controls, not marketing copy.",
      "- Group related controls into clear sections with one main content surface and one support/navigation rail.",
      "- Lists should scan like real settings rows, not like generic feature cards."
    ].join("\n");
  }

  if (variant === "editorial") {
    return [
      "- The preview and transcript define the hierarchy. Preserve that architecture.",
      "- Use one strong hero or title plate, then a restrained set of supporting modules.",
      "- Do not let every section become the same card."
    ].join("\n");
  }

  return [
    "- Keep the page architecture faithful to the preview.",
    "- Reuse the prepared shell and primitives before inventing new layout systems."
  ].join("\n");
}

export function buildWebsiteDesignSpec(params: BuildWebsiteDesignSpecParams) {
  const { job, assetPlan, mode } = params;
  const family = inferWebsiteScaffoldFamily(job.transcriptText);
  const variant = inferWebsiteScaffoldVariant(job.transcriptText);

  const imagerySection = assetPlan
    ? [
        "## Imagery Language",
        assetPlan.shared_style_language,
        assetPlan.imagery_components.length
          ? `Use these preview-matched imagery roles only where needed: ${assetPlan.imagery_components
              .map((component) => component.name)
              .join(", ")}.`
          : "No dedicated imagery slots are required; implement the visual language through code and layout.",
        ""
      ].join("\n")
    : "";

  const blueprintSection = assetPlan
    ? [
        "## Preview Blueprint",
        `- Route strategy: ${assetPlan.route_strategy}`,
        `- Shell style: ${assetPlan.shell_style}`,
        assetPlan.primary_sections.length ? "- Primary sections:" : null,
        ...assetPlan.primary_sections.map(
          (section) => `  - ${section.name} (${section.emphasis}): ${section.purpose}`
        ),
        assetPlan.priority_primitives.length
          ? `- Priority primitives: ${assetPlan.priority_primitives.join(", ")}`
          : null,
        assetPlan.implementation_notes.length ? "- Implementation notes:" : null,
        ...assetPlan.implementation_notes.map((note) => `  - ${note}`),
        ""
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return [
    "# DESIGN.md",
    "",
    "This file defines the design system for the current website generation task.",
    "Treat it as the persistent design spec. Read it before making layout or styling decisions.",
    "",
    "## Generation Mode",
    `- Mode: ${mode}`,
    `- Scaffold family: ${family}`,
    `- Scaffold variant: ${variant}`,
    "",
    "## Product Goal",
    "- Build a site that feels intentional, cohesive, and production-ready rather than generic or placeholder-like.",
    "- Reuse the provided scaffold and `src/ui/primitives.tsx` before inventing new structural patterns.",
    "- Keep the code compact. The goal is a strong final page, not a sprawling pseudo-app.",
    "",
    "## Token Guidance",
    getTokenGuidance(variant),
    "",
    "## Layout Guidance",
    getLayoutGuidance(variant),
    "",
    "## UI Primitive Guidance",
    getPrimitiveGuidance(variant),
    "",
    blueprintSection,
    "## Copy Guidance",
    "- All visible text must read like end-user UI or site copy.",
    "- Never mention the prompt, preview, sketch, composition, fidelity, placeholders, or implementation choices.",
    "- Prefer concise labels, short support copy, and one clear headline per major surface.",
    "",
    imagerySection,
    "## Do Not",
    "- Do not rebuild the entire component system from scratch if an existing primitive can be adapted.",
    "- Do not add new npm dependencies.",
    "- Do not turn every wireframe box into the same repeated card style.",
    "- Do not inflate the page with unnecessary routes, tabs, mock data systems, or fake app complexity."
  ]
    .filter(Boolean)
    .join("\n");
}
