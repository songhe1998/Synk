import { ensureSessionAnalysis } from "@/lib/session-pipeline";
import { buildDisplayTranscript } from "@/lib/transcript-format";
import { buildWebsiteDesignSpec } from "@/lib/website-design-spec";
import {
  createWebsiteJob,
  getWebsiteJob,
  getWebsiteJobArtifact,
  listWebsiteJobs,
  saveWebsiteJobArtifact,
  saveWebsitePreviewFiles,
  updateWebsiteJob
} from "@/lib/website-store";
import { getSessionAsset, getSessionDetail } from "@/lib/session-store";
import {
  WebsiteEditAnnotation,
  WebsiteEditDomCandidate,
  WebsiteEditTargetCandidate,
  WebsiteEditTargetResolution,
  WebsiteJob,
  WebsiteReferenceImage,
  CanvasImageLayer,
  CanvasImageSourceAssetKind,
  TranscriptToken
} from "@/lib/types";
import { requireWebsiteSandboxConfig } from "@/lib/website-config";
import {
  runWebsiteAssetPlanner,
  runWebsiteProvidedSourceBuildJob,
  runWebsiteRevisionSandboxJob,
  runWebsiteSandboxJob
} from "@/lib/website-sandbox";
import { readCodexAuthJson } from "@/lib/codex-auth";
import { buildWebsiteEditPrompt, resolveWebsiteEditTargetsWithIntentParser } from "@/lib/website-edit-targeting";
import {
  buildPreviewDrivenClonePrompt,
  createWebsitePlaceholderAssets,
  generateWebsiteImageryAssets,
  generateWebsitePreviewFromSketch,
  hasOpenAiApiKey
} from "@/lib/website-preview-chain";
import {
  captureWebsitePreviewScreenshot,
  reviewWebsiteEditVisualQuality,
  shouldRunWebsiteEditVisualQa,
  type WebsiteEditVisualReview
} from "@/lib/website-edit-visual-qa";
import {
  buildWebsiteBlueprintOverrides,
  inferWebsiteScaffoldFamily,
  inferWebsiteScaffoldVariant
} from "@/lib/website-scaffold";
import type { WebsiteAssetPlan } from "@/lib/website-asset-plan";
import {
  buildV0WebsiteEditPrompt,
  buildV0WebsiteGenerationPrompt,
  createV0WebsiteChat,
  getV0WebsiteVersionSourceFiles,
  localizeV0RemoteImageAssets,
  readV0WebsiteState,
  requireV0WebsiteConfig,
  sendV0WebsiteEditMessage,
  writeV0WebsiteStateMetadata
} from "@/lib/v0-website";
import { createV0WebsiteArtifactAttachmentUrl } from "@/lib/v0-attachment-url";

const websiteJobRuns = new Map<string, Promise<WebsiteJob>>();

function getRunKey(sessionId: string, jobId: string) {
  return `${sessionId}:${jobId}`;
}

async function getRequiredSession(sessionId: string) {
  const session = await getSessionDetail(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  return session;
}

function buildWebsiteDisplayName(title: string) {
  return `${title} Website`.slice(0, 80);
}

const CANVAS_REFERENCE_ASSET_KINDS = new Set<CanvasImageSourceAssetKind>([
  "generatedImage",
  "generatedImageLabeled",
  "generatedImagePlain",
  "generatedVideoSourceImage",
  "editedImage"
]);

interface LoadedWebsiteReferenceImage extends WebsiteReferenceImage {
  buffer: Buffer;
}

function slugifyReferenceFilePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function finiteReferenceNumber(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeWebsiteReferenceImages(value: unknown, fallbackLayers: CanvasImageLayer[] = []) {
  const rawItems = Array.isArray(value) ? value : fallbackLayers;

  return rawItems
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const candidate = item as Partial<CanvasImageLayer & WebsiteReferenceImage>;
      const sourceAssetKind = candidate.sourceAssetKind;
      const sourceSessionId = typeof candidate.sourceSessionId === "string" ? candidate.sourceSessionId : "";
      const sourceUrl = typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : "";
      if (!sourceSessionId || !sourceUrl || !CANVAS_REFERENCE_ASSET_KINDS.has(sourceAssetKind as CanvasImageSourceAssetKind)) {
        return null;
      }

      const width = Math.max(1, finiteReferenceNumber(candidate.width ?? candidate.placement?.width, 1));
      const height = Math.max(1, finiteReferenceNumber(candidate.height ?? candidate.placement?.height, 1));
      const filePart = slugifyReferenceFilePart(candidate.title ?? sourceAssetKind ?? "image") || "image";
      return {
        id: typeof candidate.id === "string" && candidate.id ? candidate.id : `canvas-reference-${index + 1}`,
        sourceSessionId,
        sourceAssetKind: sourceAssetKind as CanvasImageSourceAssetKind,
        sourceUrl,
        title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim() : null,
        fileName: `canvas-reference-${index + 1}-${filePart}.png`,
        mimeType: "image/png",
        placement: {
          x: finiteReferenceNumber(candidate.x ?? candidate.placement?.x),
          y: finiteReferenceNumber(candidate.y ?? candidate.placement?.y),
          width,
          height,
          naturalWidth: Math.max(1, finiteReferenceNumber(candidate.naturalWidth ?? candidate.placement?.naturalWidth, width)),
          naturalHeight: Math.max(1, finiteReferenceNumber(candidate.naturalHeight ?? candidate.placement?.naturalHeight, height))
        }
      } satisfies WebsiteReferenceImage;
    })
    .filter((reference): reference is WebsiteReferenceImage => Boolean(reference))
    .slice(0, 8);
}

async function loadWebsiteReferenceImages(job: WebsiteJob): Promise<LoadedWebsiteReferenceImage[]> {
  return Promise.all(
    (job.referenceImages ?? []).map(async (reference) => {
      const asset = await getSessionAsset(reference.sourceSessionId, reference.sourceAssetKind);
      if (!asset) {
        throw new Error(`Missing canvas reference image ${reference.fileName}.`);
      }

      return {
        ...reference,
        buffer: asset.buffer
      };
    })
  );
}

function buildReferenceImagePromptLines(referenceImages: Array<{ fileName: string; title: string | null }>) {
  if (!referenceImages.length) {
    return [] as string[];
  }

  return [
    "Exact canvas reference images:",
    ...referenceImages.map(
      (image, index) =>
        `- src/generated-assets/${image.fileName} and /vercel/sandbox/input/${image.fileName}: user-dragged reference image ${index + 1}${image.title ? ` (${image.title})` : ""}. Use this exact asset for the matching image region. Do not redraw, regenerate, replace, or fetch a substitute.`
    )
  ];
}

interface WebsiteStyleDirection {
  label: string;
  siteModel: string;
  visualMode: string;
  compositionMode: string;
  paletteMode: string;
  typographyMode: string;
  motionMode: string;
  artTreatment: string;
  sectionRhythm: string;
  antiPattern: string;
}

type WebsitePromptVariant = "round-c" | "current" | "legacy";

function formatUserTranscriptForPrompt(transcriptText: string) {
  return transcriptText
    .trim()
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function getWebsitePromptVariant(): WebsitePromptVariant {
  if (process.env.WEBSITE_PROMPT_VARIANT === "legacy") {
    return "legacy";
  }

  if (process.env.WEBSITE_PROMPT_VARIANT === "current") {
    return "current";
  }

  return "round-c";
}

type WebsiteTrack = "marketing" | "product";
type WebsiteBriefFamily =
  | "personal"
  | "research"
  | "portfolio"
  | "event"
  | "launch"
  | "subscription"
  | "booking"
  | "travel"
  | "dining"
  | "editorial"
  | "campaign"
  | "dashboard"
  | "finance"
  | "settings"
  | "marketplace"
  | "media"
  | "team"
  | "general-marketing"
  | "general-product";

function inferWebsiteTrack(transcriptText: string) {
  const marketingSignals = [
    "landing page",
    "launch page",
    "festival",
    "event",
    "tickets",
    "portfolio page",
    "portfolio homepage",
    "personal page",
    "founder",
    "biography",
    "selected work",
    "case studies",
    "editorial homepage",
    "newsletter",
    "booking page",
    "reservation page",
    "subscription landing",
    "campaign page",
    "course launch"
  ];
  const productSignals = [
    "dashboard",
    "admin",
    "settings",
    "analytics",
    "sidebar",
    "table",
    "chart",
    "metrics",
    "activity",
    "alerts",
    "workflow",
    "app",
    "player",
    "queue",
    "filters",
    "permissions",
    "roles",
    "portfolio overview",
    "log in",
    "login"
  ];

  const marketingHits = countKeywordHits(transcriptText, marketingSignals);
  const productHits = countKeywordHits(transcriptText, productSignals);

  if (productHits >= 2 && productHits >= marketingHits) {
    return "product";
  }

  if (marketingHits > productHits) {
    return "marketing";
  }

  return productHits > 0 ? "product" : "marketing";
}

function isSparseWebsiteBrief(transcriptText: string) {
  return transcriptText.trim().split(/\s+/).length <= 12;
}

function countKeywordHits(transcriptText: string, keywords: string[]) {
  const transcript = transcriptText.toLowerCase();
  return keywords.reduce((count, keyword) => count + (transcript.includes(keyword) ? 1 : 0), 0);
}

const websiteWireframeSignals = [
  "page",
  "homepage",
  "main headline",
  "headline",
  "hero",
  "title",
  "intro",
  "introduction",
  "biography",
  "about",
  "personal page",
  "portfolio",
  "selected work",
  "contact",
  "featured",
  "image area",
  "photo area",
  "portrait",
  "nav",
  "navigation",
  "sidebar",
  "side note",
  "dashboard",
  "chart",
  "metrics",
  "panel",
  "strip",
  "band",
  "rail",
  "note",
  "section",
  "story section",
  "impact story",
  "progress area",
  "donation note",
  "settings",
  "settings page",
  "settings rail",
  "billing",
  "security",
  "security controls",
  "marketplace",
  "grid",
  "cart",
  "queue",
  "player",
  "now playing",
  "episodes",
  "controls",
  "schedule",
  "details block",
  "speaker",
  "speakers",
  "lineup",
  "rsvp",
  "newsletter",
  "booking",
  "reservation",
  "availability",
  "reserve note",
  "pricing",
  "comparison",
  "plans",
  "cta",
  "form",
  "signup",
  "subscribe note",
  "search",
  "title bar",
  "masthead",
  "lead story",
  "main article",
  "save changes"
];

function isWebsiteLikeWireframeBrief(transcriptText: string) {
  return countKeywordHits(transcriptText, websiteWireframeSignals) >= 3;
}

function inferWebsiteBriefFamily(transcriptText: string, track: WebsiteTrack): WebsiteBriefFamily {
  const transcript = transcriptText.toLowerCase();

  if (track === "marketing") {
    if (
      transcript.includes("culture journal") ||
      transcript.includes("journal homepage") ||
      transcript.includes("magazine homepage") ||
      transcript.includes("front page")
    ) {
      return "editorial";
    }
    if (
      (transcript.includes("filmmaker") ||
        transcript.includes("director") ||
        transcript.includes("artist") ||
        transcript.includes("photographer")) &&
      (transcript.includes("selected films") ||
        transcript.includes("selected work") ||
        transcript.includes("selected works") ||
        transcript.includes("projects"))
    ) {
      return "portfolio";
    }
    if (
      (transcript.includes("filmmaker") ||
        transcript.includes("director") ||
        transcript.includes("artist") ||
        transcript.includes("photographer")) &&
      (transcript.includes("personal site") ||
        transcript.includes("personal page") ||
        transcript.includes("homepage") ||
        transcript.includes("biography") ||
        transcript.includes("practice note"))
    ) {
      return "personal";
    }
    if (
      transcript.includes("researcher") ||
      transcript.includes("research profile") ||
      transcript.includes("publication") ||
      transcript.includes("publications") ||
      transcript.includes("lectures")
    ) {
      return "research";
    }
    if (
      transcript.includes("personal") ||
      transcript.includes("biography") ||
      transcript.includes("bio") ||
      transcript.includes("self introduction") ||
      transcript.includes("founder") ||
      transcript.includes("researcher")
    ) {
      return "personal";
    }
    if (
      transcript.includes("portfolio") ||
      transcript.includes("studio") ||
      transcript.includes("selected work") ||
      transcript.includes("case stud")
    ) {
      return "portfolio";
    }
    if (
      transcript.includes("festival") ||
      transcript.includes("event") ||
      transcript.includes("tickets") ||
      transcript.includes("lineup") ||
      transcript.includes("program")
    ) {
      return "event";
    }
    if (
      transcript.includes("launch") ||
      transcript.includes("product launch") ||
      transcript.includes("course") ||
      transcript.includes("features")
    ) {
      return "launch";
    }
    if (
      transcript.includes("subscription") ||
      transcript.includes("pricing") ||
      transcript.includes("plan") ||
      transcript.includes("compare")
    ) {
      return "subscription";
    }
    if (
      transcript.includes("booking") ||
      transcript.includes("reservation") ||
      transcript.includes("availability") ||
      transcript.includes("planner")
    ) {
      if (transcript.includes("travel") || transcript.includes("trip") || transcript.includes("itinerary")) {
        return "travel";
      }
      if (
        transcript.includes("restaurant") ||
        transcript.includes("dining") ||
        transcript.includes("menu") ||
        transcript.includes("table")
      ) {
        return "dining";
      }
      return "booking";
    }
    if (
      transcript.includes("editorial") ||
      transcript.includes("newsletter") ||
      transcript.includes("archive") ||
      transcript.includes("issue") ||
      transcript.includes("lead story")
    ) {
      return "editorial";
    }
    if (
      transcript.includes("campaign") ||
      transcript.includes("donation") ||
      transcript.includes("impact") ||
      transcript.includes("nonprofit")
    ) {
      return "campaign";
    }

    return "general-marketing";
  }

  if (
    transcript.includes("finance") ||
    transcript.includes("portfolio overview") ||
    transcript.includes("balance") ||
    transcript.includes("alerts")
  ) {
    return "finance";
  }
  if (transcript.includes("dashboard") || transcript.includes("analytics") || transcript.includes("metrics")) {
    return "dashboard";
  }
  if (
    transcript.includes("settings") ||
    transcript.includes("billing") ||
    transcript.includes("security") ||
    transcript.includes("permissions")
  ) {
    return "settings";
  }
  if (transcript.includes("marketplace") || transcript.includes("cart") || transcript.includes("filters")) {
    return "marketplace";
  }
  if (
    transcript.includes("music") ||
    transcript.includes("player") ||
    transcript.includes("queue") ||
    transcript.includes("playlist")
  ) {
    return "media";
  }
  if (transcript.includes("team") || transcript.includes("members") || transcript.includes("roles")) {
    return "team";
  }

  return "general-product";
}

function createDeterministicSampler(seed: string) {
  let state = 0;

  for (let index = 0; index < seed.length; index += 1) {
    state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return function pick<T>(values: T[]) {
    state = (state * 1664525 + 1013904223) >>> 0;
    return values[state % values.length];
  };
}

function getStyleTitle(value: string) {
  return value
    .split(/[- ]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type WebsiteStyleProfile = Omit<WebsiteStyleDirection, "label">;
type FamilyAwareWebsiteStyleProfile = WebsiteStyleProfile & {
  families: WebsiteBriefFamily[];
};

function deriveRepresentationMode(styleDirection: Pick<WebsiteStyleDirection, "siteModel" | "visualMode">) {
  if (styleDirection.siteModel.includes("field guide")) {
    return "diagrammatic editorial: use annotated fragments, keyed callouts, or guide-like inserts instead of one large scenic hero illustration";
  }
  if (styleDirection.siteModel.includes("travel notice") || styleDirection.siteModel.includes("program brochure")) {
    return "printed matter: use board, brochure, schedule, or notice layout language with modular information blocks";
  }
  if (styleDirection.siteModel.includes("photo-essay")) {
    return "essay-led: use one or two framed scenic plates, then let typography and captions carry the rest";
  }
  if (styleDirection.siteModel.includes("seasonal event") || styleDirection.siteModel.includes("club-style")) {
    return "campaign graphic: make the page feel like an event identity system with posters, dates, and modular announcement elements";
  }
  if (styleDirection.siteModel.includes("pilgrimage planner") || styleDirection.siteModel.includes("retreat")) {
    return "symbolic luxury: use the scene sparingly as a planning or atmosphere cue, not as a repeated scenic drawing";
  }
  if (styleDirection.visualMode.includes("brutalist")) {
    return "abstracted signal graphics: use rings, blocks, horizon cuts, and harsh layout anchors rather than literal scenery";
  }
  if (styleDirection.visualMode.includes("cinematic")) {
    return "atmospheric framing: emphasize light, shadow, haze, and pacing over literal scenic iconography";
  }

  return "content-led editorial: use one strong scene interpretation, then let hierarchy and modules do most of the work";
}

function deriveMotifDiscipline(styleDirection: Pick<WebsiteStyleDirection, "siteModel" | "visualMode">) {
  if (styleDirection.visualMode.includes("brutalist")) {
    return "Do not draw a literal sun disc plus mountain silhouette combination. Use abstract rings, bars, route cuts, or horizon geometry instead.";
  }
  if (styleDirection.siteModel.includes("photo-essay")) {
    return "Confine the scenic motif to one or two framed plates. Do not repeat the same sunrise card across sections.";
  }
  if (styleDirection.siteModel.includes("travel notice") || styleDirection.siteModel.includes("program brochure")) {
    return "Use the scene once as a poster or notice insert, then switch to schedules, labels, and printed information design.";
  }
  if (styleDirection.siteModel.includes("field guide")) {
    return "Break the motif into guide fragments, route markers, or specimen-style inserts rather than one monolithic hero landscape.";
  }
  if (styleDirection.siteModel.includes("seasonal event") || styleDirection.siteModel.includes("club-style")) {
    return "The scenic motif should support the event identity, not dominate every section. Avoid repeating the same badge or hero panel.";
  }
  if (styleDirection.siteModel.includes("pilgrimage planner") || styleDirection.siteModel.includes("retreat")) {
    return "Treat the scene as a symbolic cue used sparingly. Subsequent sections should be driven by copy, rhythm, and UI rather than scenic repetition.";
  }
  if (styleDirection.visualMode.includes("cinematic")) {
    return "Favor glow, silhouette, haze, and pacing. If a sun appears, make it feel atmospheric instead of a clean graphic badge.";
  }

  return "Use the core scenic motif at most once strongly and once subtly. Do not repeat the same sun-and-mountain composition in multiple sections.";
}

function deriveContainerRenderingMode(
  track: WebsiteTrack,
  briefFamily: WebsiteBriefFamily,
  styleDirection: Pick<WebsiteStyleDirection, "siteModel" | "visualMode">
) {
  if (track === "product") {
    return "Treat wireframe boxes as layout guides first. Keep one strong shell if useful, but resolve many zones through spacing, grid, dividers, background bands, or sticky rails instead of turning every block into a bordered card.";
  }
  if (briefFamily === "campaign") {
    return "Use a mix of one or two strong action surfaces and several frameless content regions. The donation stack can be boxed, but the story and proof areas should not all become equal rounded panels.";
  }
  if (briefFamily === "editorial" || briefFamily === "research") {
    return "Favor open editorial composition: type fields, rules, rails, and captioned regions. Wireframe rectangles do not require visible borders in the final page.";
  }
  if (briefFamily === "portfolio") {
    return "Let one image or title surface anchor the page, then keep at least half of the remaining regions frameless or only lightly ruled. Avoid panelizing every content block.";
  }
  if (briefFamily === "travel" || briefFamily === "dining" || briefFamily === "booking") {
    return "Use a mix of image bleed, quiet bands, and one or two operational panels. The wireframe should not collapse into a full grid of equal rounded boxes.";
  }
  if (styleDirection.visualMode.includes("brutalist")) {
    return "Prefer bands, bars, hard sections, and edge-to-edge fields over discrete cards.";
  }

  return "Interpret wireframe boxes as semantic layout zones, not mandatory visible containers. Some areas may be expressed through whitespace, background shifts, image planes, or rules instead of outlines.";
}

function deriveTypographyDensityGuidance(
  track: WebsiteTrack,
  briefFamily: WebsiteBriefFamily,
  styleDirection: Pick<WebsiteStyleDirection, "siteModel" | "visualMode">
) {
  if (track === "product") {
    return "Keep interface copy tight but not cramped. Use fewer text blocks, clearer scannability, and stronger spacing between control groups. Avoid dense lorem-style paragraphs inside every module.";
  }
  if (briefFamily === "editorial" || briefFamily === "research" || briefFamily === "portfolio") {
    return "Let typography breathe. Use fewer but better paragraphs, generous line-height, and clear changes of scale. Do not stack many similarly dense text blocks one after another.";
  }
  if (briefFamily === "campaign") {
    return "Keep the message urgent but selective. Prioritize a few decisive statements, proof points, and one donation ask rather than dense copy in every region.";
  }
  if (briefFamily === "subscription" || briefFamily === "launch") {
    return "Use compact supporting copy and let the hierarchy do the work. Headline, proof, and CTA should carry more weight than long explanatory paragraphs.";
  }
  if (styleDirection.visualMode.includes("cinematic")) {
    return "Use large type and real breathing room. Resist filling every available panel with prose.";
  }

  return "Default to lower text density: shorter paragraphs, clearer headline rhythm, and more negative space between modules.";
}

function deriveColorSpreadGuidance(
  track: WebsiteTrack,
  briefFamily: WebsiteBriefFamily,
  styleDirection: Pick<WebsiteStyleDirection, "paletteMode" | "visualMode">
) {
  if (track === "product") {
    return "Do not default to warm paper neutrals unless the palette explicitly requires it. Product pages should feel comfortable using cooler surfaces, darker UI fields, or sharper contrast.";
  }
  if (briefFamily === "campaign") {
    return "Use the accent color decisively for action and public signal. Avoid washing the whole page into low-contrast beige.";
  }
  if (briefFamily === "dining" || briefFamily === "travel") {
    return "Color can come from hospitality cues, transport cues, or destination atmosphere, not only parchment backgrounds.";
  }
  if (styleDirection.visualMode.includes("gallery") || styleDirection.visualMode.includes("publication")) {
    return "You may stay restrained, but do not let every surface collapse into the same warm cream. Separate base, surface, and accent clearly.";
  }

  return "Vary base color, surface color, and accent intentionally. Do not let every major area land in the same cream-on-ink register.";
}

function deriveLegacyContainerRenderingMode(track: WebsiteTrack, briefFamily: WebsiteBriefFamily) {
  if (track === "product") {
    return "Keep the sketched zones explicit and surfaced. Use clear panels, framed modules, and obvious separation between navigation, work areas, and side utilities.";
  }
  if (briefFamily === "campaign" || briefFamily === "subscription" || briefFamily === "booking") {
    return "Translate the wireframe into clearly bounded sections and action panels. Let the key blocks read as visible containers rather than disappearing into an open editorial field.";
  }

  return "Keep the major sketched zones visibly articulated. It is okay for the final page to use more framed sections, ruled panels, and obvious content containers so the structure reads immediately.";
}

function deriveLegacyTypographyDensityGuidance(track: WebsiteTrack) {
  if (track === "product") {
    return "Keep hierarchy clear, but allow denser supporting copy, labels, and controls inside surfaced modules. Slightly tighter spacing is acceptable if the UI feels deliberate.";
  }

  return "Allow a denser, more structured page than the current variant. Supporting copy can sit closer to headlines, and sections may carry more visible information so long as the hierarchy remains crisp.";
}

function deriveLegacyColorSpreadGuidance(track: WebsiteTrack) {
  if (track === "product") {
    return "Favor a cohesive tonal system with restrained accents. Clear panels and controls matter more than broad color spread.";
  }

  return "Favor a tighter, more unified palette. It is acceptable for the page to live in a more related tonal family with one or two controlled accents.";
}

const marketingStyleProfiles = [
  {
    siteModel: "editorial archive microsite",
    visualMode: "museum-brochure",
    compositionMode: "quiet asymmetry with one strong visual rail",
    paletteMode: "bone paper, smoke, brass, and one soft glow",
    typographyMode: "high-contrast serif display with archival micro-labels",
    motionMode: "almost-still",
    artTreatment: "treat the sun-and-mountain scene like an exhibition artifact or archive plate, not a default hero illustration",
    sectionRhythm: "hero, curatorial thesis, three-caption detail band, closing reservation prompt",
    antiPattern: "avoid generic travel landing page chrome"
  },
  {
    siteModel: "boutique retreat booking page",
    visualMode: "quiet-luxury",
    compositionMode: "split-plane hero with booking cues embedded into the layout",
    paletteMode: "cream, espresso, warm gold, and dusk stone",
    typographyMode: "soft old-style serif with compact hospitality sans",
    motionMode: "soft-depth",
    artTreatment: "reinterpret the sketch as a premium retreat identity with selective scenic framing rather than a literal poster",
    sectionRhythm: "hero, stay-format section, ritual itinerary, reservation CTA",
    antiPattern: "avoid SaaS pricing-card composition"
  },
  {
    siteModel: "seasonal event microsite",
    visualMode: "playful-graphic",
    compositionMode: "poster-grid with oversized type and date/location modules",
    paletteMode: "earth pigments, parchment, and one festival accent",
    typographyMode: "bold condensed headlines with lighter supporting serif notes",
    motionMode: "snappy-utility",
    artTreatment: "push the scene toward graphic poster language with event energy and modular information blocks",
    sectionRhythm: "hero, date-and-program strip, three experience modules, signup close",
    antiPattern: "avoid luxury-hotel minimalism"
  },
  {
    siteModel: "travel notice board",
    visualMode: "retro-travel",
    compositionMode: "stacked columns with wayfinding rails and printed-notice modules",
    paletteMode: "paper-and-ink neutrals with transit-board contrast",
    typographyMode: "bold condensed display with serif subheads and utilitarian small caps",
    motionMode: "crisp-editorial",
    artTreatment: "make the sketch feel like a printed travel notice or route bulletin rather than a generic scenic hero",
    sectionRhythm: "hero, route details, traveler notes, reservation strip",
    antiPattern: "avoid a giant centered CTA floating in whitespace"
  },
  {
    siteModel: "field guide landing page",
    visualMode: "modern-folk",
    compositionMode: "type-led asymmetry with diagram fragments and captioned modules",
    paletteMode: "sand, moss, ember, and faded clay",
    typographyMode: "bookish serif with bold woodcut-like condensed accents",
    motionMode: "ceremonial-reveal",
    artTreatment: "reinterpret mountains as field-guide diagrams, not just silhouetted scenery",
    sectionRhythm: "hero, guide thesis, observation modules, final join CTA",
    antiPattern: "avoid polished corporate brand patterns"
  },
  {
    siteModel: "cinematic story landing page",
    visualMode: "cinematic-natural",
    compositionMode: "full-bleed hero with anchored copy and low-slung supporting bands",
    paletteMode: "charcoal, flare gold, mist, and deep earth",
    typographyMode: "condensed cinematic sans with restrained serif pull-quotes",
    motionMode: "soft-depth",
    artTreatment: "use atmosphere, shadow, and light bloom more than explicit iconography",
    sectionRhythm: "hero, mood statement, three story beats, immersive CTA",
    antiPattern: "avoid pale editorial beige unless the palette calls for it"
  },
  {
    siteModel: "brutalist expedition announcement",
    visualMode: "brutalist-poster",
    compositionMode: "oversized masthead with hard grid anchors and info blocks",
    paletteMode: "chalky stone, slate, coral signal, and smoke",
    typographyMode: "heavy grotesk with abrupt serif interruptions",
    motionMode: "snappy-utility",
    artTreatment: "abstract the sunrise into rings, blocks, cuts, and horizon bands; do not default to a top-right sun",
    sectionRhythm: "hero, metrics strip, route schedule, closing command CTA",
    antiPattern: "avoid polished luxury restraint"
  },
  {
    siteModel: "printed program brochure",
    visualMode: "editorial",
    compositionMode: "stacked editorial columns with poster insert moments",
    paletteMode: "paper, graphite, washed sunrise, and muted copper",
    typographyMode: "editorial serif stack with uppercase micro-labels",
    motionMode: "almost-still",
    artTreatment: "make the scenic material feel printed, captioned, and sequenced like a program booklet",
    sectionRhythm: "hero, brochure note, three-program overview, final application CTA",
    antiPattern: "avoid app-like chrome and segmented cards"
  },
  {
    siteModel: "club-style launch page",
    visualMode: "playful-graphic",
    compositionMode: "collaged hero planes with compact rails and oversized statements",
    paletteMode: "cream, ash, marigold, and moss",
    typographyMode: "expressive serif mixed with tight geometric sans",
    motionMode: "ceremonial-reveal",
    artTreatment: "let the sketch become a social atmosphere and graphic identity, not just a landscape rendering",
    sectionRhythm: "hero, membership promise, schedule blocks, join CTA",
    antiPattern: "avoid brochure-like over-explanation"
  },
  {
    siteModel: "minimal pilgrimage planner",
    visualMode: "quiet-luxury",
    compositionMode: "offset composition with large type blocks and one narrow image column",
    paletteMode: "ivory, soot, pale gold, and weathered taupe",
    typographyMode: "sculptural serif display with understated utility labels",
    motionMode: "almost-still",
    artTreatment: "use the sunrise scene as a symbolic planning motif, not a literal hero badge",
    sectionRhythm: "hero, planning principle, three-step itinerary, deliberate CTA",
    antiPattern: "avoid symmetric brochure balance"
  },
  {
    siteModel: "conditions bulletin",
    visualMode: "technical-premium",
    compositionMode: "data-led split layout with a dramatic atmospheric masthead",
    paletteMode: "obsidian, fog, sand, and alert amber",
    typographyMode: "functional grotesk with a high-contrast editorial headline",
    motionMode: "snappy-utility",
    artTreatment: "turn the scene into a live conditions or bulletin context with measured graphic overlays",
    sectionRhythm: "hero, conditions band, advisory modules, action CTA",
    antiPattern: "avoid generic dashboard cards dominating the page"
  },
  {
    siteModel: "photo-essay travel site",
    visualMode: "editorial",
    compositionMode: "alternating text-image essays with one strong opening masthead",
    paletteMode: "linen, smoke, brass, and muted black",
    typographyMode: "high-contrast serif display with understated humanist sans",
    motionMode: "soft-depth",
    artTreatment: "treat the sketch as one essay image among several compositional moments rather than the only graphic asset",
    sectionRhythm: "hero, essay intro, three alternating story modules, booking CTA",
    antiPattern: "avoid every section repeating the same mountain badge"
  }
] satisfies WebsiteStyleProfile[];

const productStyleProfiles = [
  {
    siteModel: "ops dashboard landing page",
    visualMode: "technical-premium",
    compositionMode: "navigation-led shell with one dramatic hero analytics pane",
    paletteMode: "graphite, bone, and one signal amber accent",
    typographyMode: "functional grotesk with a restrained serif display accent",
    motionMode: "snappy-utility",
    artTreatment: "translate the sketch into interface framing and visual identity instead of a literal scenic card",
    sectionRhythm: "hero, workflow detail, feature strip, signup CTA",
    antiPattern: "avoid standard SaaS three-card hero"
  },
  {
    siteModel: "creative tool launch page",
    visualMode: "editorial-product",
    compositionMode: "single-pane workflow canvas with oversized narrative copy",
    paletteMode: "warm-neutral UI with dark chrome and one ember accent",
    typographyMode: "wide grotesk titles with compact UI text",
    motionMode: "crisp-editorial",
    artTreatment: "make the scene part of the product language rather than decorative wallpaper",
    sectionRhythm: "hero, interface showcase, capability sequence, start CTA",
    antiPattern: "avoid boxed feature-grid monotony"
  },
  {
    siteModel: "premium control surface",
    visualMode: "quiet-industrial",
    compositionMode: "dense header with asymmetric body layout",
    paletteMode: "stone, moss, obsidian, and precise amber",
    typographyMode: "technical sans with serif punctuation moments",
    motionMode: "almost-still",
    artTreatment: "abstract the landscape into material and control metaphors",
    sectionRhythm: "hero, command surface, principles strip, CTA",
    antiPattern: "avoid light, airy marketing composition"
  },
  {
    siteModel: "playful product teaser",
    visualMode: "playful-data",
    compositionMode: "modular but non-card-heavy control surface",
    paletteMode: "soft paper, clay, olive, and one bright signal color",
    typographyMode: "condensed headline utility with humanist body text",
    motionMode: "ceremonial-reveal",
    artTreatment: "push the scene into interaction cues and playful product framing",
    sectionRhythm: "hero, playful workflow, feature sequence, signup",
    antiPattern: "avoid stern enterprise UI"
  },
  {
    siteModel: "tool-first launch page",
    visualMode: "minimal-ops",
    compositionMode: "split dashboard with strong hierarchy",
    paletteMode: "muted steel, paper, and one saturated action color",
    typographyMode: "functional grotesk with condensed utility accents",
    motionMode: "snappy-utility",
    artTreatment: "keep the landscape energy in the brand system, not as a repeated hero motif",
    sectionRhythm: "hero, tool capabilities, workflow sequence, CTA",
    antiPattern: "avoid poster-only drama with no product clarity"
  },
  {
    siteModel: "retro terminal polish app site",
    visualMode: "retro-terminal-polish",
    compositionMode: "single-pane masthead with structured utility rails",
    paletteMode: "deep canvas, sand text, amber glow, and restrained green",
    typographyMode: "monospaced utility mixed with dramatic display copy",
    motionMode: "crisp-editorial",
    artTreatment: "reinterpret the sketch through terminal-era signals and route metaphors",
    sectionRhythm: "hero, command examples, three feature modules, CTA",
    antiPattern: "avoid modern glassmorphism"
  }
] satisfies WebsiteStyleProfile[];

const marketingWebsiteLikeStyleProfiles = [
  {
    families: ["research"],
    siteModel: "research dossier homepage",
    visualMode: "scholarly-dossier",
    compositionMode: "title note, research abstract, publications matrix, contact margin",
    paletteMode: "chalk paper, slate ink, archive gray, and one muted study accent",
    typographyMode: "bookish serif headline with compact academic sans",
    motionMode: "almost-still",
    artTreatment: "make the sketch feel like a polished research dossier rather than a creative-agency profile",
    sectionRhythm: "title, abstract, publications, contact",
    antiPattern: "avoid turning a scholar profile into a startup founder page"
  },
  {
    families: ["personal"],
    siteModel: "founder profile homepage",
    visualMode: "editorial-profile",
    compositionMode: "portrait-led masthead with one generous biography plane",
    paletteMode: "warm paper, graphite, and one grounded accent",
    typographyMode: "expressive serif headline with clean biographical sans",
    motionMode: "almost-still",
    artTreatment: "treat the sketch like a real personal-site wireframe; polish the blocks without replacing the information architecture",
    sectionRhythm: "hero, biography, selected links, contact close",
    antiPattern: "avoid turning the page into a generic startup landing"
  },
  {
    families: ["personal", "portfolio"],
    siteModel: "creative profile archive",
    visualMode: "quiet-editorial",
    compositionMode: "title-led asymmetry with one featured work band",
    paletteMode: "stone, ivory, smoke, and muted ink",
    typographyMode: "high-contrast serif with understated utility text",
    motionMode: "soft-depth",
    artTreatment: "let the rough sketch remain visible in the composition logic, then tighten typography and spacing",
    sectionRhythm: "hero, intro, selected work, contact note",
    antiPattern: "avoid generic social-link bio page patterns"
  },
  {
    families: ["portfolio"],
    siteModel: "studio portfolio home",
    visualMode: "case-study editorial",
    compositionMode: "featured project masthead with disciplined supporting rail",
    paletteMode: "ash, cream, deep charcoal, and one oxidized accent",
    typographyMode: "confident serif display with precise grotesk captions",
    motionMode: "crisp-editorial",
    artTreatment: "translate the wireframe into a real studio site with clear work hierarchy and no decorative filler",
    sectionRhythm: "hero, intro, selected projects, inquiry close",
    antiPattern: "avoid masonry-card sameness"
  },
  {
    families: ["portfolio"],
    siteModel: "image-led monograph portfolio",
    visualMode: "gallery-monograph",
    compositionMode: "hero image pane, title block, project index, inquiry close",
    paletteMode: "soft plaster, deep graphite, one museum accent, and cool shadow",
    typographyMode: "sculptural serif with lean gallery sans",
    motionMode: "soft-depth",
    artTreatment: "keep the portfolio structure explicit, but let the featured image carry more gravity and atmosphere",
    sectionRhythm: "hero, intro, project index, inquiry",
    antiPattern: "avoid collapsing everything into beige editorial sameness"
  },
  {
    families: ["event"],
    siteModel: "program microsite",
    visualMode: "poster-program",
    compositionMode: "hero block plus date/program bands and a ticket close",
    paletteMode: "cream, soot, signal red, and faded brass",
    typographyMode: "condensed display with practical schedule text",
    motionMode: "snappy-utility",
    artTreatment: "keep the event structure from the sketch obvious and let typography do the excitement",
    sectionRhythm: "hero, date/program, schedule, ticket CTA",
    antiPattern: "avoid scenic lifestyle branding"
  },
  {
    families: ["launch"],
    siteModel: "product launch landing",
    visualMode: "bold-launch",
    compositionMode: "hero product pane with structured support bands",
    paletteMode: "ink, chalk, and one bright electric accent",
    typographyMode: "sharp grotesk headline with compact support copy",
    motionMode: "ceremonial-reveal",
    artTreatment: "treat the sketch as a launch-page blueprint and concentrate visual energy in the hero and CTA hierarchy",
    sectionRhythm: "hero, proof, demo, CTA",
    antiPattern: "avoid brochure-like over-explaining"
  },
  {
    families: ["subscription"],
    siteModel: "subscription comparison landing",
    visualMode: "warm-commerce",
    compositionMode: "hero, offer panel, comparison strip, signup close",
    paletteMode: "espresso, cream, oat, and one saturated product accent",
    typographyMode: "bookish serif with confident product sans",
    motionMode: "soft-depth",
    artTreatment: "turn the sketched zones into a polished but clearly commercial plan-selection page",
    sectionRhythm: "hero, offer, comparison, signup",
    antiPattern: "avoid hyper-luxury emptiness"
  },
  {
    families: ["booking"],
    siteModel: "reservation landing page",
    visualMode: "hospitality-modern",
    compositionMode: "hero image plane, booking panel, information strip, closing action",
    paletteMode: "parchment, slate, olive, and low gold",
    typographyMode: "soft serif display with pragmatic booking UI text",
    motionMode: "almost-still",
    artTreatment: "preserve the booking and availability roles from the wireframe instead of flattening into a generic travel mood board",
    sectionRhythm: "hero, availability, details, booking note",
    antiPattern: "avoid fake resort-magazine tropes"
  },
  {
    families: ["travel"],
    siteModel: "travel planning membership page",
    visualMode: "paper-itinerary",
    compositionMode: "trip title note, itinerary block, planning panel, booking close",
    paletteMode: "ticket ivory, transit charcoal, warm sand, and one map accent",
    typographyMode: "travel editorial serif with compact utility sans",
    motionMode: "crisp-editorial",
    artTreatment: "treat the sketch like a real planning surface with itinerary logic, not a retreat brochure",
    sectionRhythm: "title, itinerary, planning, booking",
    antiPattern: "avoid wellness retreat softness"
  },
  {
    families: ["dining"],
    siteModel: "restaurant reservation landing",
    visualMode: "cinematic-hospitality",
    compositionMode: "photo hero, reservation bar, menu/story split, booking close",
    paletteMode: "candle black, cream, brass, and one warm menu accent",
    typographyMode: "restaurant serif display with precise reservation sans",
    motionMode: "soft-depth",
    artTreatment: "keep the reservation flow visible, but let the dining image and typographic contrast set the mood",
    sectionRhythm: "hero, reservation bar, story/menu, booking close",
    antiPattern: "avoid generic luxury hotel brochure pacing"
  },
  {
    families: ["editorial"],
    siteModel: "editorial front page",
    visualMode: "publication-classic",
    compositionMode: "masthead, lead story plane, secondary rail, newsletter close",
    paletteMode: "newsprint cream, graphite, and a narrow accent color",
    typographyMode: "newspaper serif with compact navigation grotesk",
    motionMode: "crisp-editorial",
    artTreatment: "treat the sketch as layout instruction for an editorial homepage, not as a poster concept",
    sectionRhythm: "masthead, lead, secondary stories, signup",
    antiPattern: "avoid magazine-cover-only treatment"
  },
  {
    families: ["campaign"],
    siteModel: "campaign donation page",
    visualMode: "cause-forward",
    compositionMode: "hero cause block, impact section, progress strip, donate close",
    paletteMode: "paper, midnight, forest, and a restrained signal color",
    typographyMode: "human serif headline with sturdy civic sans",
    motionMode: "soft-depth",
    artTreatment: "keep the page concrete and action-oriented; use the wireframe to organize story and donation prompts",
    sectionRhythm: "hero, impact, progress, donate",
    antiPattern: "avoid NGO template clichés"
  },
  {
    families: ["campaign"],
    siteModel: "civic action fundraising page",
    visualMode: "civic-signal",
    compositionMode: "hero proof block, impact narrative, progress band, donation close",
    paletteMode: "paper, night ink, municipal green, and one urgent action color",
    typographyMode: "human serif with sturdy civic grotesk",
    motionMode: "crisp-editorial",
    artTreatment: "make the page feel activated and operational; keep the donation structure obvious and polished",
    sectionRhythm: "hero, impact, progress, donate",
    antiPattern: "avoid browser-default forms or generic NGO hero-photo clichés"
  },
  {
    families: ["general-marketing"],
    siteModel: "structured marketing homepage",
    visualMode: "modern-editorial",
    compositionMode: "hero plane with one supporting band and one closing prompt",
    paletteMode: "soft paper, charcoal, muted clay, and one accent",
    typographyMode: "serif-led hierarchy with restrained sans utility",
    motionMode: "soft-depth",
    artTreatment: "treat the wireframe as real page structure and use style only for polish, not reinvention",
    sectionRhythm: "hero, support, CTA",
    antiPattern: "avoid scenic reinterpretation"
  }
] satisfies FamilyAwareWebsiteStyleProfile[];

const productWebsiteLikeStyleProfiles = [
  {
    families: ["dashboard", "finance"],
    siteModel: "analytics control surface",
    visualMode: "data-editorial",
    compositionMode: "header bar, major chart plane, metrics strip, utility rail",
    paletteMode: "midnight, stone, soft grid gray, and one alert accent",
    typographyMode: "functional sans with a compact editorial title",
    motionMode: "snappy-utility",
    artTreatment: "keep the chart and metrics zones from the sketch dominant; style should clarify, not dissolve structure",
    sectionRhythm: "title, chart, metrics, activity rail",
    antiPattern: "avoid six identical dashboard cards"
  },
  {
    families: ["settings", "team"],
    siteModel: "settings console",
    visualMode: "quiet-product",
    compositionMode: "title bar, settings rail, primary form plane, supporting admin plane",
    paletteMode: "stone, cloud, graphite, and one subdued action color",
    typographyMode: "practical grotesk with one refined display note",
    motionMode: "almost-still",
    artTreatment: "preserve the clear role of profile, security, billing, members, or permissions blocks from the wireframe",
    sectionRhythm: "title, settings panels, save bar",
    antiPattern: "avoid playful marketing drama"
  },
  {
    families: ["marketplace"],
    siteModel: "marketplace browse surface",
    visualMode: "retail-interface",
    compositionMode: "header/search strip, filter rail, primary product plane, cart note",
    paletteMode: "warm white, soot, muted retail color, and one call-to-action accent",
    typographyMode: "clean sans with compact merchandising labels",
    motionMode: "crisp-editorial",
    artTreatment: "treat the sketch as a browsable shopping surface with explicit zones and visible hierarchy",
    sectionRhythm: "header, browse plane, filters, summary",
    antiPattern: "avoid app-store template cards"
  },
  {
    families: ["media"],
    siteModel: "media player shell",
    visualMode: "moody-player",
    compositionMode: "rail navigation, hero media pane, queue band, controls bar",
    paletteMode: "ink, ash, muted gold, and one saturated album accent",
    typographyMode: "wide display sans with compact mono utility",
    motionMode: "soft-depth",
    artTreatment: "let the album-art and queue regions drive the layout; do not turn it into a generic dashboard",
    sectionRhythm: "hero, queue, controls",
    antiPattern: "avoid enterprise UI language"
  },
  {
    families: ["general-product"],
    siteModel: "product interface landing",
    visualMode: "minimal-ops",
    compositionMode: "title bar, core pane, supporting strip, utility rail",
    paletteMode: "steel, paper, graphite, and one saturated action color",
    typographyMode: "functional grotesk with crisp utility labels",
    motionMode: "snappy-utility",
    artTreatment: "polish the wireframe into a usable interface with specific hierarchy and restrained motion",
    sectionRhythm: "title, core pane, support strip",
    antiPattern: "avoid scenic hero behavior"
  }
] satisfies FamilyAwareWebsiteStyleProfile[];

function sampleWebsiteStyleDirection(job: WebsiteJob, recentLabels: string[]) {
  const inferredTrack = inferWebsiteTrack(job.transcriptText);
  const briefFamily = inferWebsiteBriefFamily(job.transcriptText, inferredTrack);
  const sparseBrief = isSparseWebsiteBrief(job.transcriptText);
  const websiteLikeWireframe = isWebsiteLikeWireframeBrief(job.transcriptText);
  const pick = createDeterministicSampler(`${job.id}:${job.transcriptText}`);
  const familyProfiles: FamilyAwareWebsiteStyleProfile[] =
    inferredTrack === "marketing" ? marketingWebsiteLikeStyleProfiles : productWebsiteLikeStyleProfiles;
  const profiles = websiteLikeWireframe
    ? familyProfiles.filter((profile) => profile.families.includes(briefFamily))
    : inferredTrack === "marketing"
      ? marketingStyleProfiles
      : productStyleProfiles;
  const profilePool = profiles.length > 0 ? profiles : inferredTrack === "marketing" ? marketingStyleProfiles : productStyleProfiles;
  const reservedLabels = new Set(recentLabels);
  const initialProfile = pick([...profilePool]);
  const initialIndex = profilePool.findIndex((profile) => profile === initialProfile);
  let chosenProfile = profilePool[initialIndex >= 0 ? initialIndex : 0];

  for (let offset = 0; offset < profilePool.length; offset += 1) {
    const candidate = profilePool[(initialIndex + offset + profilePool.length) % profilePool.length];
    const candidateLabel = [candidate.visualMode, candidate.siteModel].map(getStyleTitle).join(" / ");
    if (!reservedLabels.has(candidateLabel)) {
      chosenProfile = candidate;
      break;
    }
  }

  const label = [chosenProfile.visualMode, chosenProfile.siteModel].map(getStyleTitle).join(" / ");

  return {
    inferredTrack,
    briefFamily,
    websiteLikeWireframe,
    sparseBrief,
    styleDirection: {
      label,
      ...chosenProfile
    } satisfies WebsiteStyleDirection
  };
}

function buildWebsitePrompt(
  job: WebsiteJob,
  styleDirection: WebsiteStyleDirection,
  variant: WebsitePromptVariant = "round-c"
) {
  const inferredTrack = inferWebsiteTrack(job.transcriptText);
  const briefFamily = inferWebsiteBriefFamily(job.transcriptText, inferredTrack);
  const sparseBrief = isSparseWebsiteBrief(job.transcriptText);
  const websiteLikeWireframe = isWebsiteLikeWireframeBrief(job.transcriptText);
  const representationMode = deriveRepresentationMode(styleDirection);
  const motifDiscipline = deriveMotifDiscipline(styleDirection);
  const containerRenderingMode =
    variant === "legacy"
      ? deriveLegacyContainerRenderingMode(inferredTrack, briefFamily)
      : deriveContainerRenderingMode(inferredTrack, briefFamily, styleDirection);
  const typographyDensityGuidance =
    variant === "legacy"
      ? deriveLegacyTypographyDensityGuidance(inferredTrack)
      : deriveTypographyDensityGuidance(inferredTrack, briefFamily, styleDirection);
  const colorSpreadGuidance =
    variant === "legacy"
      ? deriveLegacyColorSpreadGuidance(inferredTrack)
      : deriveColorSpreadGuidance(inferredTrack, briefFamily, styleDirection);
  const userTranscript = formatUserTranscriptForPrompt(job.transcriptText);
  const pageInstructions = job.pages
    .map(
      (page, index) =>
        `Page ${index + 1}: implement the page described by /vercel/sandbox/input/page-${index + 1}-labeled-sketch.png at route ${page.path}.`
    )
    .join("\n");

  if (variant === "round-c") {
    return [
      "Build a real responsive website in this Vite + React + TypeScript workspace.",
      "Do not return a poster, a decorative SVG scene, or a static illustration-only page.",
      "Use the transcript and labeled sketch as the source of truth for layout, mood, hierarchy, and interactions.",
      "Treat sketch labels as semantic hints unless the transcript clearly wants literal UI text.",
      `Primary track: ${inferredTrack}.`,
      `Brief family: ${briefFamily}.`,
      `Style direction label: ${styleDirection.label}.`,
      `Site model: ${styleDirection.siteModel}.`,
      `Visual mode: ${styleDirection.visualMode}.`,
      `Composition mode: ${styleDirection.compositionMode}.`,
      `Palette mode: ${styleDirection.paletteMode}.`,
      `Typography mode: ${styleDirection.typographyMode}.`,
      `Motion mode: ${styleDirection.motionMode}.`,
      `Art treatment: ${styleDirection.artTreatment}.`,
      `Section rhythm: ${styleDirection.sectionRhythm}.`,
      `Anti-pattern: ${styleDirection.antiPattern}.`,
      websiteLikeWireframe
        ? "This brief is a low-fidelity website wireframe, not a scenic concept sketch."
        : `Representation mode: ${representationMode}.`,
      websiteLikeWireframe
        ? "Honor the sketched information architecture. Keep the major zones, order, and emphasis from the wireframe recognizable in the final page."
        : `Motif discipline: ${motifDiscipline}`,
      websiteLikeWireframe
        ? "Translate rough containers into polished layout. Do not invent a completely different page structure just because the style direction is strong."
        : "Keep the meaning of the user's sketch, but reinterpret repeated motifs through the selected site model and art treatment instead of repeating the same scenic poster composition.",
      websiteLikeWireframe
        ? "If the sketch labels a title, intro, nav, sidebar, form, profile area, schedule, pricing block, queue, settings area, or contact note, keep that role explicit in the final composition."
        : "The scenic motif should not dominate every section. After the first strong interpretation, shift into content-led layout, modules, typography, or interface structure.",
      websiteLikeWireframe
        ? "Use the chosen style direction to shape color, type, motion, and material feel, but not to erase the wireframe's block relationships or density."
        : "Use this style direction decisively. Do not fall back to the same house style you used in previous generations.",
      websiteLikeWireframe
        ? "Do not reinterpret the sketch as an illustration-first mood board. It is already a page blueprint."
        : "Do not default to a beige page with a solitary top-right sun disc and a mountain silhouette footer unless the chosen style direction truly demands it.",
      "Do not let decorative outlines, badges, or ornamental shapes overlap essential headlines, body copy, forms, or controls.",
      "Use this style direction decisively. Do not fall back to the same house style you used in previous generations.",
      inferredTrack === "marketing"
        ? websiteLikeWireframe
          ? "For marketing wireframes: preserve the intended hero/support/CTA logic from the sketch, then enrich copy and detail without replacing the layout."
          : "For marketing: make the first viewport feel like a strong poster-like hero, then add support/detail/final CTA sections. Cardless by default."
        : websiteLikeWireframe
          ? "For product wireframes: preserve panel structure, utility hierarchy, and obvious navigation or settings roles. Avoid stacked-card SaaS sameness."
          : "For product UI: build a usable interface with real layout and hierarchy, not stacked-card SaaS sameness.",
      sparseBrief
        ? websiteLikeWireframe
          ? "The brief is sparse, so infer tasteful copy and detail inside the sketched blocks, but do not add a lot of extra sections that were never implied by the wireframe."
          : "The brief is sparse. Infer a tasteful branded landing page concept from the scene, but still ship real copy, structure, and at least one CTA."
        : "If the brief implies product behavior, use mock or client-side data only unless backend work is explicit.",
      "Before major edits, create a short `design-plan.md` with: visual thesis, content plan, interaction thesis, and typography/color notes.",
      "Use CSS variables for the visual system, distinctive typography, clear hierarchy, and deliberate spacing rhythm.",
      "Ship a real stylesheet-driven interface. Do not leave the project in browser-default HTML because a stylesheet import was dropped.",
      "Avoid bland defaults: no generic purple gradients, no cookie-cutter hero cards, no centered-everything layout, no repetitive card grids.",
      "Ship 2-3 intentional motions using transform/opacity and respect prefers-reduced-motion.",
      "Keep controls obviously interactive, focus states visible, and mobile layout deliberate.",
      "Inputs:",
      "- /vercel/sandbox/input/transcript.txt",
      "- /vercel/sandbox/input/input.json",
      pageInstructions,
      "Do not write outside this project workspace. Final code must pass `npm run build`."
    ].join("\n");
  }

  return [
    "Verbatim user transcript:",
    '"""',
    userTranscript,
    '"""',
    "The verbatim transcript above is part of the prompt. Treat it like a direct spoken request from the user, with real-world omissions and conversational phrasing.",
    "Build a real responsive website in this Vite + React + TypeScript workspace.",
    "Do not return a poster, a decorative SVG scene, or a static illustration-only page.",
    "Use the transcript and labeled sketch as the source of truth for layout, mood, hierarchy, and interactions.",
    "Treat sketch labels as semantic hints unless the transcript clearly wants literal UI text.",
    variant === "legacy"
      ? "Prompt variant: legacy panelized. Favor explicit sections, clearer surfaces, and a more structured, framed page."
      : "Prompt variant: current. Favor lighter density, fewer forced containers, and more diversity in composition.",
    `Primary track: ${inferredTrack}.`,
    `Brief family: ${briefFamily}.`,
    `Style direction label: ${styleDirection.label}.`,
    `Site model: ${styleDirection.siteModel}.`,
    `Visual mode: ${styleDirection.visualMode}.`,
    `Composition mode: ${styleDirection.compositionMode}.`,
    `Palette mode: ${styleDirection.paletteMode}.`,
    `Typography mode: ${styleDirection.typographyMode}.`,
    `Motion mode: ${styleDirection.motionMode}.`,
    `Art treatment: ${styleDirection.artTreatment}.`,
    `Section rhythm: ${styleDirection.sectionRhythm}.`,
    `Anti-pattern: ${styleDirection.antiPattern}.`,
    websiteLikeWireframe
      ? "This brief is a low-fidelity website wireframe, not a scenic concept sketch."
      : `Representation mode: ${representationMode}.`,
    websiteLikeWireframe
      ? "Honor the sketched information architecture. Keep the major zones, order, and emphasis from the wireframe recognizable in the final page."
      : `Motif discipline: ${motifDiscipline}`,
    websiteLikeWireframe
      ? "Translate rough containers into polished layout. Do not invent a completely different page structure just because the style direction is strong."
      : "Keep the meaning of the user's sketch, but reinterpret repeated motifs through the selected site model and art treatment instead of repeating the same scenic poster composition.",
    websiteLikeWireframe
      ? "If the sketch labels a title, intro, nav, sidebar, form, profile area, schedule, pricing block, queue, settings area, or contact note, keep that role explicit in the final composition."
      : "The scenic motif should not dominate every section. After the first strong interpretation, shift into content-led layout, modules, typography, or interface structure.",
    websiteLikeWireframe
      ? "Use the chosen style direction to shape color, type, motion, and material feel, but not to erase the wireframe's block relationships or density."
      : "Use this style direction decisively. Do not fall back to the same house style you used in previous generations.",
    websiteLikeWireframe
      ? "Do not reinterpret the sketch as an illustration-first mood board. It is already a page blueprint."
      : "Do not default to a beige page with a solitary top-right sun disc and a mountain silhouette footer unless the chosen style direction truly demands it.",
    `Container rendering mode: ${containerRenderingMode}`,
    `Typography and density guidance: ${typographyDensityGuidance}`,
    `Color spread guidance: ${colorSpreadGuidance}`,
    variant === "legacy"
      ? "Use clearly outlined surfaces for the major zones so the structure reads fast. It is acceptable to keep several panels, cards, or framed sections if they improve clarity."
      : "Use at most one or two clearly outlined surfaces unless the chosen product or booking pattern truly needs more. Other zones should often be expressed through spacing, type, bands, imagery, or rules.",
    "Do not let decorative outlines, badges, or ornamental shapes overlap essential headlines, body copy, forms, or controls.",
    "Use this style direction decisively. Do not fall back to the same house style you used in previous generations.",
    inferredTrack === "marketing"
      ? websiteLikeWireframe
        ? "For marketing wireframes: preserve the intended hero/support/CTA logic from the sketch, then enrich copy and detail without replacing the layout."
        : "For marketing: make the first viewport feel like a strong poster-like hero, then add support/detail/final CTA sections. Cardless by default."
      : websiteLikeWireframe
        ? "For product wireframes: preserve panel structure, utility hierarchy, and obvious navigation or settings roles. Avoid stacked-card SaaS sameness."
        : "For product UI: build a usable interface with real layout and hierarchy, not stacked-card SaaS sameness.",
    sparseBrief
      ? websiteLikeWireframe
        ? "The brief is sparse, so infer tasteful copy and detail inside the sketched blocks, but do not add a lot of extra sections that were never implied by the wireframe."
        : "The brief is sparse. Infer a tasteful branded landing page concept from the scene, but still ship real copy, structure, and at least one CTA."
      : "If the brief implies product behavior, use mock or client-side data only unless backend work is explicit.",
    "Before major edits, create a short `design-plan.md` with: visual thesis, content plan, interaction thesis, and typography/color notes.",
    "Use CSS variables for the visual system, distinctive typography, clear hierarchy, and deliberate spacing rhythm.",
    "Ship a real stylesheet-driven interface. Do not leave the project in browser-default HTML because a stylesheet import was dropped.",
    "Avoid bland defaults: no generic purple gradients, no cookie-cutter hero cards, no centered-everything layout, no repetitive card grids.",
    "Ship 2-3 intentional motions using transform/opacity and respect prefers-reduced-motion.",
    "Keep controls obviously interactive, focus states visible, and mobile layout deliberate.",
    "Inputs:",
    "- /vercel/sandbox/input/transcript.txt",
    "- /vercel/sandbox/input/input.json",
    pageInstructions,
    "Do not write outside this project workspace. Final code must pass `npm run build`."
  ].join("\n");
}

function isRetryableWebsiteGenerationError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("429") ||
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("internal_server_error") ||
    lower.includes("internal_error") ||
    lower.includes("unexpected error") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("currently experiencing high demand") ||
    lower.includes("stream disconnected before completion") ||
    lower.includes("stream ended before command finished") ||
    lower.includes("websocket closed by server") ||
    lower.includes("falling back from websockets to https transport") ||
    lower.includes("terminated") ||
    lower.includes("killed") ||
    lower.includes("signal")
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasWebsiteEditImageIntent(instructionText: string) {
  const instruction = instructionText.toLowerCase();
  return [
    "image",
    "photo",
    "picture",
    "visual",
    "realistic",
    "different",
    "same",
    "ugly",
    "replace",
    "change the image",
    "change this image",
    "图片",
    "照片",
    "图",
    "真实",
    "换图",
    "不一样",
    "一样",
    "难看"
  ].some((keyword) => instruction.includes(keyword));
}

function imageSrcToGeneratedAssetFileName(src: string) {
  if (!src) {
    return null;
  }

  let pathname = src;
  try {
    pathname = new URL(src, "http://localhost").pathname;
  } catch {
    pathname = src.split(/[?#]/)[0] ?? src;
  }

  const decoded = decodeURIComponent(pathname);
  const baseName = decoded.split("/").filter(Boolean).pop();
  if (!baseName || !/\.(png|jpe?g|webp)$/i.test(baseName)) {
    return null;
  }

  const extension = baseName.match(/\.(png|jpe?g|webp)$/i)?.[0].toLowerCase() ?? ".png";
  const name = baseName.slice(0, -extension.length);
  if (!name || name.startsWith("index")) {
    return null;
  }

  const sourceName = name.replace(/-[A-Za-z0-9_-]{6,}$/, "");
  return `${sourceName || name}.png`;
}

function assetNameToComponentName(fileName: string) {
  return fileName.replace(/\.(png|jpe?g|webp)$/i, "");
}

function inferWebsiteEditAssetAspectRatio(fileName: string, candidate: WebsiteEditTargetCandidate | null) {
  const lower = fileName.toLowerCase();
  if (lower.includes("avatar") || lower.includes("profile") || lower.includes("headshot") || lower.includes("logo")) {
    return "square" as const;
  }

  const rect = candidate?.rect;
  if (rect && rect.width > 0 && rect.height > 0) {
    const ratio = rect.width / rect.height;
    if (ratio >= 1.18) {
      return "landscape" as const;
    }
    if (ratio <= 0.82) {
      return "portrait" as const;
    }
  }

  return "square" as const;
}

function buildWebsiteEditAssetPrompt(params: {
  fileName: string;
  instructionText: string;
  candidate: WebsiteEditTargetCandidate | null;
  targetDescription: string;
}) {
  const lower = params.fileName.toLowerCase();
  const context = [
    params.targetDescription,
    params.candidate?.text,
    params.candidate?.imageAlts?.join("; ")
  ]
    .filter(Boolean)
    .join(" | ");
  const specializedGuidance = lower.includes("avatar")
    ? "Create a cohesive 3 by 2 contact sheet of six distinct realistic professional driver headshots, varied faces, neutral backgrounds, consistent lighting, no text, no UI chrome. The site may crop different positions from this single sprite, so make each region visually distinct."
    : lower.includes("map")
      ? "Create a polished realistic logistics operations map image for a web dashboard: recognizable city-map texture, route lines, pins, soft green operational overlays, believable depth, no readable text, no browser chrome."
      : "Create a replacement website image asset that is visibly different from the existing one while matching the surrounding product UI style. Make it realistic, polished, and usable as an embedded site image. No readable text, no signatures, no browser chrome.";

  return [
    specializedGuidance,
    `User edit request: ${params.instructionText.trim()}`,
    `Target context: ${context || "image-like website region"}`,
    `Replacement asset filename: ${params.fileName}`,
    "Keep the image clean enough to sit inside an existing React/CSS layout. Avoid adding captions, labels, or UI controls unless the target is specifically a map-like dashboard graphic."
  ].join("\n");
}

function collectWebsiteEditImageAssetComponents(params: {
  instructionText: string;
  targetResolution: WebsiteEditTargetResolution | null;
}) {
  const { instructionText, targetResolution } = params;
  if (!targetResolution || !hasOpenAiApiKey() || !hasWebsiteEditImageIntent(instructionText)) {
    return [];
  }

  const candidatesByAsset = new Map<
    string,
    {
      candidate: WebsiteEditTargetCandidate | null;
      targetDescription: string;
    }
  >();

  const addCandidate = (candidate: WebsiteEditTargetCandidate | null, targetDescription: string) => {
    candidate?.imageSrcs?.forEach((src) => {
      const fileName = imageSrcToGeneratedAssetFileName(src);
      if (!fileName || candidatesByAsset.has(fileName)) {
        return;
      }
      candidatesByAsset.set(fileName, {
        candidate,
        targetDescription
      });
    });
  };

  targetResolution.targets?.forEach((target) => {
    target.candidates.slice(0, 3).forEach((candidate) => addCandidate(candidate, target.targetDescription));
  });
  targetResolution.candidates.slice(0, 6).forEach((candidate) =>
    addCandidate(candidate, targetResolution.targetDescription)
  );

  return Array.from(candidatesByAsset.entries())
    .slice(0, 3)
    .map(([fileName, entry]) => ({
      name: assetNameToComponentName(fileName),
      role: `Replacement asset for ${fileName}`,
      rationale: "The user circled an image-like website region and requested a visual/image change.",
      target_description: entry.targetDescription,
      prompt: buildWebsiteEditAssetPrompt({
        fileName,
        instructionText,
        candidate: entry.candidate,
        targetDescription: entry.targetDescription
      }),
      aspect_ratio: inferWebsiteEditAssetAspectRatio(fileName, entry.candidate)
    }));
}

function createWebsiteEditImageAssetsPromise(params: {
  instructionText: string;
  targetResolution: WebsiteEditTargetResolution | null;
}) {
  const imageryComponents = collectWebsiteEditImageAssetComponents(params);
  if (!imageryComponents.length) {
    return null;
  }

  const assetPlan: WebsiteAssetPlan = {
    shared_style_language:
      "Replacement website edit imagery should look realistic, polished, product-ready, and consistent with the existing generated website.",
    route_strategy: "single-page",
    shell_style: "Existing website shell; only selected image-like assets are being replaced.",
    primary_sections: [
      {
        name: "Edited image assets",
        purpose: "Provide direct replacement imagery for the selected website regions.",
        emphasis: "primary"
      }
    ],
    priority_primitives: [],
    implementation_notes: [
      "Generated assets replace existing files in src/generated-assets before the edited website build runs."
    ],
    code_components: [],
    imagery_components: imageryComponents
  };

  return generateWebsiteImageryAssets(assetPlan);
}

const STALE_WEBSITE_JOB_RESUME_MS = Number(process.env.STALE_WEBSITE_JOB_RESUME_MS ?? 10 * 60 * 1000);

function isStaleWebsiteJob(job: WebsiteJob) {
  const updatedAtMs = new Date(job.updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return Date.now() - updatedAtMs >= STALE_WEBSITE_JOB_RESUME_MS;
}

function shouldUseCodeOnlyProductFastPath(transcriptText: string) {
  if (process.env.WEBSITE_FAST_PRODUCT_CODE_ONLY !== "1") {
    return false;
  }

  return inferWebsiteScaffoldFamily(transcriptText) === "product";
}

function shouldUsePreviewProductCodeOnlyPath(transcriptText: string) {
  if (process.env.WEBSITE_PREVIEW_PRODUCT_CODE_ONLY !== "1") {
    return false;
  }

  return inferWebsiteScaffoldFamily(transcriptText) === "product";
}

function shouldUsePreviewBlueprintScaffold(transcriptText: string) {
  if (process.env.WEBSITE_PREVIEW_BLUEPRINT_SCAFFOLD !== "1") {
    return false;
  }

  return inferWebsiteScaffoldFamily(transcriptText) === "product";
}

function shouldUseDirectProductFastPath(transcriptText: string) {
  if (process.env.WEBSITE_FAST_PRODUCT_DIRECT !== "1") {
    return false;
  }

  return inferWebsiteScaffoldFamily(transcriptText) === "product";
}

function buildCodeOnlyProductAssetPlan(transcriptText: string): WebsiteAssetPlan {
  return {
    shared_style_language: [
      "Refined product UI aesthetic with crisp information hierarchy, restrained neutral surfaces, subtle panel depth, clean utility typography, and graphics expressed through code rather than separate generated images.",
      "If the page needs an identity marker, use a minimal avatar, monogram, or geometric placeholder built in code instead of an external image unless a real portrait is absolutely necessary.",
      `Transcript intent: ${transcriptText.trim()}`
    ].join(" "),
    route_strategy: "single-page",
    shell_style: "Dense product shell with a persistent navigation rail, a compact command surface, and operational panels that feel deliberate rather than generic.",
    primary_sections: [
      {
        name: "Shell",
        purpose: "Persistent app frame, nav, and command context.",
        emphasis: "primary"
      },
      {
        name: "Primary surface",
        purpose: "Main dashboard or settings workspace.",
        emphasis: "primary"
      },
      {
        name: "Support rail",
        purpose: "Secondary controls, alerts, or supporting notes.",
        emphasis: "supporting"
      }
    ],
    priority_primitives: ["SidebarNav", "SectionTitle", "SurfacePanel", "MetricTile", "StatusPill"],
    implementation_notes: [
      "Reuse the prepared product scaffold instead of rebuilding the project shell.",
      "Favor compact static UI and avoid pseudo-app sprawl.",
      "Keep visible hierarchy strong in the first viewport."
    ],
    code_components: [
      {
        name: "Full product surface",
        role: "Implement the entire dashboard/settings/product interface in code using the existing scaffold.",
        rationale: "This page type is primarily structured UI, so separate preview-matched imagery is optional rather than required."
      }
    ],
    imagery_components: []
  };
}

function buildDirectProductClonePrompt(
  transcriptText: string,
  referenceImages: Array<{ fileName: string; title: string | null }> = []
) {
  const scaffoldVariant = inferWebsiteScaffoldVariant(transcriptText);
  const variantInstruction =
    scaffoldVariant === "product-dashboard"
      ? "This is an operations/dashboard product surface. Keep high information density, multiple operational zones visible at once, and a real control-board feel."
      : "This is a settings/account product surface. Keep the page focused, clear, and grouped around real controls rather than generic feature marketing.";

  return [
    "Build a real responsive website in this Vite + React + TypeScript workspace.",
    "This is a direct product wireframe task. There is no generated preview image for this run.",
    "The labeled sketch and user transcript are the visual and semantic source of truth.",
    "Read DESIGN.md before editing code. Treat it as the design system for this run.",
    "Reuse and adapt components from src/ui/primitives.tsx before inventing a new component system.",
    "A product scaffold has already been prepared in the workspace. Start from that scaffold and edit it toward fidelity instead of rebuilding the project from zero.",
    variantInstruction,
    "Prefer editing src/App.tsx and src/styles.css in place. Only add files or routes when the sketch clearly requires them.",
    "Do not add or change npm dependencies. Use only React, TypeScript, and CSS already present in the workspace.",
    "Do not invent extra pseudo-pages, oversized nav systems, heavy mock data models, or many state hooks.",
    "Prefer a compact static interface over a simulated app platform. Use at most one or two tiny local interactions if the sketch clearly implies them.",
    "Translate sketch boxes into a polished product interface with clear hierarchy, spacing, panels, rails, charts, and controls.",
    "If a primitive in src/ui/primitives.tsx already fits the need, use it and refine it rather than rebuilding from raw divs.",
    "Use code and CSS for maps, charts, avatars, and utility graphics instead of expecting external generated imagery.",
    ...buildReferenceImagePromptLines(referenceImages),
    "All visible copy must read like real end-user UI text, not implementation notes.",
    "Dead links, href=\"#\", and inert controls are not acceptable.",
    "Keep the page buildable with `npm run build`.",
    "Verbatim user transcript:",
    `"${transcriptText.trim()}"`,
    "Inputs:",
    "- /vercel/sandbox/input/transcript.txt",
    "- /vercel/sandbox/input/input.json",
    "- /vercel/sandbox/input/page-1-labeled-sketch.png",
    ...referenceImages.map((image) => `- /vercel/sandbox/input/${image.fileName}`),
    "Implement the main experience at route /."
  ].join("\n");
}

async function runWebsiteFastGenerationJob(sessionId: string, jobId: string) {
  const existingJob = await getWebsiteJob(sessionId, jobId);
  if (!existingJob) {
    throw new Error("Website job not found");
  }

  const primaryPage = existingJob.pages[0];
  const sketchAsset = await getSessionAsset(sessionId, primaryPage.sourceAssetKind);
  if (!sketchAsset) {
    throw new Error("Annotated sketch is required for website generation.");
  }

  const session = await getRequiredSession(sessionId);
  const referenceImages = await loadWebsiteReferenceImages(existingJob);
  const referenceDescriptors = referenceImages.map((image) => ({
    fileName: image.fileName,
    title: image.title
  }));
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `Generating website target preview for v0. (attempt ${attempt}/${maxAttempts})`
            : "Generating website target preview for v0.",
        errorMessage: null
      }));

      const generatedPreview = await generateWebsitePreviewFromSketch({
        transcriptText: existingJob.transcriptText,
        sketchBuffer: sketchAsset.buffer,
        referenceImages: referenceImages.map((image) => image.buffer),
        width: session.canvasWidth,
        height: session.canvasHeight
      });

      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "previewImage",
        buffer: generatedPreview.buffer,
        fileName: `website-preview-${jobId}.png`,
        mimeType: "image/png"
      });
      const targetPreviewImageUrl = createV0WebsiteArtifactAttachmentUrl({
        sessionId,
        jobId,
        artifactKind: "previewImage"
      });

      const prompt = buildV0WebsiteGenerationPrompt(existingJob.transcriptText, referenceDescriptors);
      await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        prompt,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `Sending target preview to v0 fast website generation. (attempt ${attempt}/${maxAttempts})`
            : "Sending target preview to v0 fast website generation.",
        errorMessage: null
      }));

      const v0State = await createV0WebsiteChat({
        message: prompt,
        targetPreviewImage: generatedPreview.buffer,
        targetPreviewImageUrl,
        referenceImages,
        metadata: {
          source: "skratch-product-website-fast",
          sessionId,
          jobId,
          phase: "generation"
        }
      });

      if (!v0State.versionId) {
        throw new Error("v0 finished without returning a website version id.");
      }

      const versionSource = await getV0WebsiteVersionSourceFiles(v0State.chatId, v0State.versionId);
      const localizedVersionSource = await localizeV0RemoteImageAssets(versionSource.sourceFiles);
      const sourceState = {
        ...v0State,
        timings: {
          ...v0State.timings,
          ...versionSource.timings
        },
        fileCount: localizedVersionSource.sourceFiles.length,
        decodedAssetPaths: versionSource.decodedAssetPaths,
        localizedAssetPaths: localizedVersionSource.localizedAssetPaths
      };
      const sourceJob = await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        providerMetadata: writeV0WebsiteStateMetadata(current.providerMetadata, sourceState),
        status: "building",
        statusDetail:
          maxAttempts > 1
            ? `Building v0 source into a same-origin static preview. (attempt ${attempt}/${maxAttempts})`
            : "Building v0 source into a same-origin static preview.",
        errorMessage: null
      }));

      const result = await runWebsiteProvidedSourceBuildJob({
        job: sourceJob,
        sourceFiles: localizedVersionSource.sourceFiles,
        onProgress: async ({ status, statusDetail, sandboxId }) => {
          await updateWebsiteJob(sessionId, jobId, (current) => ({
            ...current,
            status,
            sandboxId: sandboxId ?? current.sandboxId,
            statusDetail:
              maxAttempts > 1 ? `${statusDetail} (attempt ${attempt}/${maxAttempts})` : statusDetail,
            errorMessage: null
          }));
        }
      });

      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "codeArchive",
        ...result.codeArchive
      });
      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "distArchive",
        ...result.distArchive
      });
      await saveWebsitePreviewFiles(
        sessionId,
        jobId,
        result.previewFiles.map((file) => ({
          assetPath: file.assetPath,
          buffer: file.buffer
        }))
      );

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "succeeded",
        sandboxId: result.sandboxId,
        providerMetadata: writeV0WebsiteStateMetadata(current.providerMetadata, sourceState),
        completedAt: new Date().toISOString(),
        errorMessage: null,
        statusDetail:
          maxAttempts > 1
            ? `Fast website preview is ready. Completed on attempt ${attempt}.`
            : "Fast website preview is ready."
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fast website generation failed.";
      const canRetry = attempt < maxAttempts && isRetryableWebsiteGenerationError(message);

      if (canRetry) {
        await updateWebsiteJob(sessionId, jobId, (current) => ({
          ...current,
          status: "queued",
          errorMessage: null,
          statusDetail: `Transient fast website generation error. Retrying attempt ${attempt + 1}/${maxAttempts}...`
        }));
        await wait(attempt * 4000);
        continue;
      }

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        statusDetail: "Fast website generation failed."
      }));
    }
  }

  return updateWebsiteJob(sessionId, jobId, (current) => ({
    ...current,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Fast website generation exhausted all retry attempts.",
    statusDetail: "Fast website generation failed."
  }));
}

async function runWebsiteEconGenerationJob(sessionId: string, jobId: string) {
  const existingJob = await getWebsiteJob(sessionId, jobId);
  if (!existingJob) {
    throw new Error("Website job not found");
  }

  const referenceImages = await loadWebsiteReferenceImages(existingJob);
  const referenceDescriptors = referenceImages.map((image) => ({
    fileName: image.fileName,
    title: image.title
  }));
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const directProductFastPath = shouldUseDirectProductFastPath(existingJob.transcriptText);
      if (directProductFastPath) {
        const directPrompt = buildDirectProductClonePrompt(existingJob.transcriptText, referenceDescriptors);
        const directDesignSpec = buildWebsiteDesignSpec({
          job: existingJob,
          mode: "direct"
        });
        const directJob = await updateWebsiteJob(sessionId, jobId, (current) => ({
          ...current,
          prompt: directPrompt,
          status: "running",
          statusDetail:
            maxAttempts > 1
              ? `Recreating labeled sketch directly as product UI. (attempt ${attempt}/${maxAttempts})`
              : "Recreating labeled sketch directly as product UI.",
          errorMessage: null
        }));

        const directResult = await runWebsiteSandboxJob({
          job: directJob,
          includeSketchInputs: true,
          designSpecContent: directDesignSpec,
          referenceImages,
          projectAssetSlots: referenceImages.map((image) => ({
            fileName: image.fileName,
            buffer: image.buffer
          })),
          onProgress: async ({ status, statusDetail, sandboxId }) => {
            await updateWebsiteJob(sessionId, jobId, (current) => ({
              ...current,
              status,
              sandboxId: sandboxId ?? current.sandboxId,
              statusDetail:
                maxAttempts > 1 ? `${statusDetail} (attempt ${attempt}/${maxAttempts})` : statusDetail,
              errorMessage: null
            }));
          }
        });

        await saveWebsiteJobArtifact(sessionId, jobId, {
          kind: "codeArchive",
          ...directResult.codeArchive
        });
        await saveWebsiteJobArtifact(sessionId, jobId, {
          kind: "distArchive",
          ...directResult.distArchive
        });
        await saveWebsitePreviewFiles(
          sessionId,
          jobId,
          directResult.previewFiles.map((file) => ({
            assetPath: file.assetPath,
            buffer: file.buffer
          }))
        );

        return updateWebsiteJob(sessionId, jobId, (current) => ({
          ...current,
          status: "succeeded",
          sandboxId: directResult.sandboxId,
          completedAt: new Date().toISOString(),
          errorMessage: null,
          statusDetail:
            maxAttempts > 1
              ? `Website preview is ready. Completed on attempt ${attempt}.`
              : "Website preview is ready."
        }));
      }

      await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `Generating website preview image from sketch and transcript. (attempt ${attempt}/${maxAttempts})`
            : "Generating website preview image from sketch and transcript.",
        errorMessage: null
      }));

      const primaryPage = existingJob.pages[0];
      const sketchAsset = await getSessionAsset(sessionId, primaryPage.sourceAssetKind);
      if (!sketchAsset) {
        throw new Error("Annotated sketch is required for website generation.");
      }

      const session = await getRequiredSession(sessionId);
      const generatedPreview = await generateWebsitePreviewFromSketch({
        transcriptText: existingJob.transcriptText,
        sketchBuffer: sketchAsset.buffer,
        referenceImages: referenceImages.map((image) => image.buffer),
        width: session.canvasWidth,
        height: session.canvasHeight
      });

      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "previewImage",
        buffer: generatedPreview.buffer,
        fileName: `website-preview-${jobId}.png`,
        mimeType: "image/png"
      });

      await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `Planning image assets from generated preview. (attempt ${attempt}/${maxAttempts})`
            : "Planning image assets from generated preview.",
        errorMessage: null
      }));

      let result;
      const codeOnlyProductFastPath = shouldUseCodeOnlyProductFastPath(existingJob.transcriptText);
      const previewProductCodeOnlyPath = shouldUsePreviewProductCodeOnlyPath(existingJob.transcriptText);
      const assetPlan = codeOnlyProductFastPath || previewProductCodeOnlyPath
        ? buildCodeOnlyProductAssetPlan(existingJob.transcriptText)
        : await runWebsiteAssetPlanner({
            previewImageBuffer: generatedPreview.buffer,
            transcriptText: existingJob.transcriptText
          });

      await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `${
                codeOnlyProductFastPath || previewProductCodeOnlyPath
                  ? "Using code-only product fast path and skipping preview-matched imagery generation."
                  : `Planning ${assetPlan.imagery_components.length} preview-matched imagery slot(s) and starting overlap generation.`
              } (attempt ${attempt}/${maxAttempts})`
            : codeOnlyProductFastPath || previewProductCodeOnlyPath
              ? "Using code-only product fast path and skipping preview-matched imagery generation."
              : `Planning ${assetPlan.imagery_components.length} preview-matched imagery slot(s) and starting overlap generation.`,
        errorMessage: null
      }));

      const placeholderAssets = codeOnlyProductFastPath || previewProductCodeOnlyPath ? [] : await createWebsitePlaceholderAssets(assetPlan);
      const generatedAssetsPromise = codeOnlyProductFastPath || previewProductCodeOnlyPath
        ? Promise.resolve([])
        : generateWebsiteImageryAssets(assetPlan);
      const clonePrompt = buildPreviewDrivenClonePrompt({
        assetPlan,
        generatedAssets: placeholderAssets.map((asset) => ({
          component: asset.component,
          fileName: asset.fileName
        })),
        referenceImages: referenceDescriptors,
        assetDeliveryMode: "project-placeholder",
        transcriptText: existingJob.transcriptText,
        scaffoldFamily: inferWebsiteScaffoldFamily(existingJob.transcriptText)
      });
      const designSpec = buildWebsiteDesignSpec({
        job: existingJob,
        mode: "preview-first",
        assetPlan
      });
      const blueprintOverrides = shouldUsePreviewBlueprintScaffold(existingJob.transcriptText)
        ? buildWebsiteBlueprintOverrides({
            job: existingJob,
            assetPlan,
            generatedAssets: placeholderAssets.map((asset) => ({
              component: asset.component,
              fileName: asset.fileName
            }))
          })
        : null;

      const previewDrivenJob = await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        prompt: clonePrompt,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `Recreating generated preview as a real website. (attempt ${attempt}/${maxAttempts})`
            : "Recreating generated preview as a real website.",
        errorMessage: null
      }));

      result = await runWebsiteSandboxJob({
        job: previewDrivenJob,
        includeSketchInputs: false,
        designSpecContent: designSpec,
        scaffoldOverrideFiles: blueprintOverrides?.files,
        referenceImages: [
          {
            fileName: "target-preview.png",
            buffer: generatedPreview.buffer
          },
          ...referenceImages
        ],
        projectAssetSlots: [
          ...referenceImages.map((image) => ({
            fileName: image.fileName,
            buffer: image.buffer
          })),
          ...placeholderAssets.map((asset) => ({
            fileName: asset.fileName,
            buffer: asset.buffer
          }))
        ],
        finalProjectAssetsPromise: generatedAssetsPromise,
        onProgress: async ({ status, statusDetail, sandboxId }) => {
          await updateWebsiteJob(sessionId, jobId, (current) => ({
            ...current,
            status,
            sandboxId: sandboxId ?? current.sandboxId,
            statusDetail:
              maxAttempts > 1 ? `${statusDetail} (attempt ${attempt}/${maxAttempts})` : statusDetail,
            errorMessage: null
          }));
        }
      });

      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "codeArchive",
        ...result.codeArchive
      });
      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "distArchive",
        ...result.distArchive
      });
      await saveWebsitePreviewFiles(
        sessionId,
        jobId,
        result.previewFiles.map((file) => ({
          assetPath: file.assetPath,
          buffer: file.buffer
        }))
      );

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "succeeded",
        sandboxId: result.sandboxId,
        completedAt: new Date().toISOString(),
        errorMessage: null,
        statusDetail: maxAttempts > 1 ? `Website preview is ready. Completed on attempt ${attempt}.` : "Website preview is ready."
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Website generation failed.";
      const canRetry = attempt < maxAttempts && isRetryableWebsiteGenerationError(message);

      if (canRetry) {
        await updateWebsiteJob(sessionId, jobId, (current) => ({
          ...current,
          status: "queued",
          errorMessage: null,
          statusDetail: `Transient Codex transport error. Retrying attempt ${attempt + 1}/${maxAttempts}...`
        }));
        await wait(attempt * 4000);
        continue;
      }

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        statusDetail: "Website generation failed."
      }));
    }
  }

  return updateWebsiteJob(sessionId, jobId, (current) => ({
    ...current,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Website generation exhausted all retry attempts.",
    statusDetail: "Website generation failed."
  }));
}

function buildWebsiteEditDisplayName(parentJob: WebsiteJob, revisionNumber: number) {
  return `${parentJob.displayName} v${revisionNumber}`.slice(0, 80);
}

function getNextWebsiteRevisionNumber(jobs: WebsiteJob[], parentJob: WebsiteJob) {
  return Math.max(parentJob.revisionNumber ?? 1, ...jobs.map((job) => job.revisionNumber ?? 1)) + 1;
}

function prefixWebsiteDebugFiles(
  files: NonNullable<Awaited<ReturnType<typeof runWebsiteRevisionSandboxJob>>["debugFiles"]>,
  prefix: string
) {
  return files.map((file) => ({
    ...file,
    assetPath: `_debug/${prefix}/${file.assetPath}`
  }));
}

function buildWebsiteEditRepairFeedback(review: WebsiteEditVisualReview) {
  return [
    `Visual QA score: ${review.score.toFixed(2)}`,
    review.issues.length ? `Issues:\n${review.issues.map((issue) => `- ${issue}`).join("\n")}` : "Issues: none listed.",
    review.repairInstruction ? `Repair instruction:\n${review.repairInstruction}` : null
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function maybeReviewWebsiteEditResult({
  instructionText,
  targetResolution,
  visualReferenceImage,
  previewFiles
}: {
  instructionText: string;
  targetResolution: WebsiteEditTargetResolution | null;
  visualReferenceImage: { buffer: Buffer; fileName: string; mimeType: string } | null;
  previewFiles: Awaited<ReturnType<typeof runWebsiteRevisionSandboxJob>>["previewFiles"];
}) {
  if (!visualReferenceImage || !targetResolution?.annotation || !shouldRunWebsiteEditVisualQa()) {
    return {
      afterScreenshot: null as Buffer | null,
      review: null as WebsiteEditVisualReview | null
    };
  }

  const afterScreenshot = await captureWebsitePreviewScreenshot({
    previewFiles,
    viewportWidth: targetResolution.annotation.viewportWidth,
    viewportHeight: targetResolution.annotation.viewportHeight
  });
  const review = await reviewWebsiteEditVisualQuality({
    instructionText,
    targetResolution,
    annotatedBeforeImage: visualReferenceImage.buffer,
    afterImage: afterScreenshot
  });

  return {
    afterScreenshot,
    review
  };
}

async function runWebsiteFastEditJob(sessionId: string, jobId: string) {
  const editJob = await getWebsiteJob(sessionId, jobId);
  if (!editJob) {
    throw new Error("Website edit job not found");
  }

  if (!editJob.parentJobId) {
    throw new Error("Website edit job is missing its parent job.");
  }

  const parentJob = await getWebsiteJob(sessionId, editJob.parentJobId);
  if (!parentJob) {
    throw new Error("Parent website job not found.");
  }

  if (parentJob.status !== "succeeded" || !parentJob.distArchiveFileName || !parentJob.codeArchiveFileName) {
    throw new Error("Parent website must be ready before it can be edited.");
  }

  const parentV0State = readV0WebsiteState(parentJob);
  if (!parentV0State?.chatId) {
    throw new Error("Parent fast website is missing its v0 chat context.");
  }

  const visualReferenceImage = await getWebsiteJobArtifact(sessionId, editJob.id, "previewImage");
  const visualReferenceImageUrl = visualReferenceImage
    ? createV0WebsiteArtifactAttachmentUrl({
        sessionId,
        jobId: editJob.id,
        artifactKind: "previewImage"
      })
    : null;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const runningJob = await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `Sending targeted edit to the existing v0 chat. (attempt ${attempt}/${maxAttempts})`
            : "Sending targeted edit to the existing v0 chat.",
        errorMessage: null
      }));

      const prompt =
        runningJob.prompt ||
        buildV0WebsiteEditPrompt({
          instructionText: runningJob.editInstructionText ?? "",
          targetResolution: runningJob.editTarget
        });

      const nextV0State = await sendV0WebsiteEditMessage({
        chatId: parentV0State.chatId,
        message: prompt,
        annotatedScreenshot: visualReferenceImage
          ? {
              ...visualReferenceImage,
              url: visualReferenceImageUrl
            }
          : null,
        metadata: {
          source: "skratch-product-website-fast",
          sessionId,
          jobId,
          parentJobId: parentJob.id,
          phase: "edit"
        }
      });

      if (!nextV0State.versionId) {
        throw new Error("v0 edit finished without returning a website version id.");
      }

      const versionSource = await getV0WebsiteVersionSourceFiles(nextV0State.chatId, nextV0State.versionId);
      const sourceState = {
        ...nextV0State,
        timings: {
          ...nextV0State.timings,
          ...versionSource.timings
        },
        fileCount: versionSource.fileCount,
        decodedAssetPaths: versionSource.decodedAssetPaths
      };
      const sourceJob = await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        providerMetadata: writeV0WebsiteStateMetadata(current.providerMetadata, sourceState),
        status: "building",
        statusDetail:
          maxAttempts > 1
            ? `Building edited v0 source into a same-origin static preview. (attempt ${attempt}/${maxAttempts})`
            : "Building edited v0 source into a same-origin static preview.",
        errorMessage: null
      }));

      const result = await runWebsiteProvidedSourceBuildJob({
        job: sourceJob,
        sourceFiles: versionSource.sourceFiles,
        onProgress: async ({ status, statusDetail, sandboxId }) => {
          await updateWebsiteJob(sessionId, jobId, (current) => ({
            ...current,
            status,
            sandboxId: sandboxId ?? current.sandboxId,
            statusDetail:
              maxAttempts > 1 ? `${statusDetail} (attempt ${attempt}/${maxAttempts})` : statusDetail,
            errorMessage: null
          }));
        }
      });

      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "codeArchive",
        ...result.codeArchive
      });
      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "distArchive",
        ...result.distArchive
      });
      await saveWebsitePreviewFiles(
        sessionId,
        jobId,
        result.previewFiles.map((file) => ({
          assetPath: file.assetPath,
          buffer: file.buffer
        }))
      );

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "succeeded",
        sandboxId: result.sandboxId,
        providerMetadata: writeV0WebsiteStateMetadata(current.providerMetadata, sourceState),
        completedAt: new Date().toISOString(),
        errorMessage: null,
        statusDetail:
          maxAttempts > 1
            ? `Fast website edit is ready. Completed on attempt ${attempt}.`
            : "Fast website edit is ready."
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fast website edit failed.";
      const canRetry = attempt < maxAttempts && isRetryableWebsiteGenerationError(message);

      if (canRetry) {
        await updateWebsiteJob(sessionId, jobId, (current) => ({
          ...current,
          status: "queued",
          errorMessage: null,
          statusDetail: `Transient fast website edit error. Retrying attempt ${attempt + 1}/${maxAttempts}...`
        }));
        await wait(attempt * 4000);
        continue;
      }

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        statusDetail: "Fast website edit failed."
      }));
    }
  }

  return updateWebsiteJob(sessionId, jobId, (current) => ({
    ...current,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Fast website edit exhausted all retry attempts.",
    statusDetail: "Fast website edit failed."
  }));
}

async function runWebsiteEconEditJob(sessionId: string, jobId: string) {
  const editJob = await getWebsiteJob(sessionId, jobId);
  if (!editJob) {
    throw new Error("Website edit job not found");
  }

  if (!editJob.parentJobId) {
    throw new Error("Website edit job is missing its parent job.");
  }

  const parentJob = await getWebsiteJob(sessionId, editJob.parentJobId);
  if (!parentJob) {
    throw new Error("Parent website job not found.");
  }

  if (parentJob.status !== "succeeded" || !parentJob.distArchiveFileName || !parentJob.codeArchiveFileName) {
    throw new Error("Parent website must be ready before it can be edited.");
  }

  const parentCodeArchive = await getWebsiteJobArtifact(sessionId, parentJob.id, "codeArchive");
  if (!parentCodeArchive) {
    throw new Error("Parent website source archive is required for editing.");
  }
  const visualReferenceImage = await getWebsiteJobArtifact(sessionId, editJob.id, "previewImage");

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const runningJob = await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "running",
        statusDetail:
          maxAttempts > 1
            ? `Preparing the existing website source for a targeted edit. (attempt ${attempt}/${maxAttempts})`
            : "Preparing the existing website source for a targeted edit.",
        errorMessage: null
      }));

      const finalProjectAssetsPromise = createWebsiteEditImageAssetsPromise({
        instructionText: runningJob.editInstructionText ?? "",
        targetResolution: runningJob.editTarget
      });

      const formatAttemptStatus = (statusDetail: string) =>
        maxAttempts > 1 ? `${statusDetail} (attempt ${attempt}/${maxAttempts})` : statusDetail;

      let result = await runWebsiteRevisionSandboxJob({
        job: runningJob,
        parentCodeArchive: parentCodeArchive.buffer,
        editRequest: {
          instructionText: runningJob.editInstructionText ?? "",
          targetResolution: runningJob.editTarget,
          annotation: runningJob.editTarget?.annotation ?? null,
          visualReferenceImage,
          finalProjectAssetsPromise,
          parentJobId: parentJob.id,
          parentDisplayName: parentJob.displayName
        },
        onProgress: async ({ status, statusDetail, sandboxId }) => {
          await updateWebsiteJob(sessionId, jobId, (current) => ({
            ...current,
            status,
            sandboxId: sandboxId ?? current.sandboxId,
            statusDetail: formatAttemptStatus(statusDetail),
            errorMessage: null
          }));
        }
      });
      const debugFiles = [...prefixWebsiteDebugFiles(result.debugFiles ?? [], "pass-1")];

      try {
        const firstReview = await maybeReviewWebsiteEditResult({
          instructionText: runningJob.editInstructionText ?? "",
          targetResolution: runningJob.editTarget,
          visualReferenceImage,
          previewFiles: result.previewFiles
        });

        if (firstReview.afterScreenshot) {
          debugFiles.push({
            assetPath: "_debug/pass-1/after-screenshot.png",
            buffer: firstReview.afterScreenshot,
            mimeType: "image/png"
          });
        }
        if (firstReview.review) {
          debugFiles.push({
            assetPath: "_debug/pass-1/visual-review.json",
            buffer: Buffer.from(JSON.stringify(firstReview.review, null, 2), "utf8"),
            mimeType: "application/json; charset=utf-8"
          });
        }

        const failedReview = firstReview.review?.available && !firstReview.review.passes ? firstReview.review : null;
        if (failedReview && firstReview.afterScreenshot) {
          await updateWebsiteJob(sessionId, jobId, (current) => ({
            ...current,
            status: "running",
            sandboxId: result.sandboxId,
            statusDetail: formatAttemptStatus(
              `Visual QA scored the edit ${failedReview.score.toFixed(2)} and requested a targeted repair.`
            ),
            errorMessage: null
          }));

          const repairFeedback = buildWebsiteEditRepairFeedback(failedReview);
          const repairJob = {
            ...runningJob,
            prompt: buildWebsiteEditPrompt({
              parentJob,
              instructionText: runningJob.editInstructionText ?? "",
              targetResolution: runningJob.editTarget as WebsiteEditTargetResolution,
              qualityFeedback: repairFeedback
            })
          };
          const repairResult = await runWebsiteRevisionSandboxJob({
            job: repairJob,
            parentCodeArchive: result.codeArchive.buffer,
            editRequest: {
              instructionText: runningJob.editInstructionText ?? "",
              targetResolution: runningJob.editTarget,
              annotation: runningJob.editTarget?.annotation ?? null,
              visualReferenceImage,
              currentScreenshotImage: {
                buffer: firstReview.afterScreenshot,
                fileName: "current-edit-screenshot.png",
                mimeType: "image/png"
              },
              qualityFeedback: repairFeedback,
              finalProjectAssetsPromise: null,
              parentJobId: parentJob.id,
              parentDisplayName: parentJob.displayName
            },
            onProgress: async ({ status, statusDetail, sandboxId }) => {
              await updateWebsiteJob(sessionId, jobId, (current) => ({
                ...current,
                status,
                sandboxId: sandboxId ?? current.sandboxId,
                statusDetail: formatAttemptStatus(`Repair pass: ${statusDetail}`),
                errorMessage: null
              }));
            }
          });

          debugFiles.push(...prefixWebsiteDebugFiles(repairResult.debugFiles ?? [], "pass-2"));
          result = repairResult;

          const secondReview = await maybeReviewWebsiteEditResult({
            instructionText: runningJob.editInstructionText ?? "",
            targetResolution: runningJob.editTarget,
            visualReferenceImage,
            previewFiles: result.previewFiles
          });
          if (secondReview.afterScreenshot) {
            debugFiles.push({
              assetPath: "_debug/pass-2/after-screenshot.png",
              buffer: secondReview.afterScreenshot,
              mimeType: "image/png"
            });
          }
          if (secondReview.review) {
            debugFiles.push({
              assetPath: "_debug/pass-2/visual-review.json",
              buffer: Buffer.from(JSON.stringify(secondReview.review, null, 2), "utf8"),
              mimeType: "application/json; charset=utf-8"
            });
          }
        }
      } catch (visualQaError) {
        debugFiles.push({
          assetPath: "_debug/visual-qa-error.txt",
          buffer: Buffer.from(visualQaError instanceof Error ? visualQaError.message : String(visualQaError), "utf8"),
          mimeType: "text/plain; charset=utf-8"
        });
      }

      const updateExportStatus = async (statusDetail: string) => {
        await updateWebsiteJob(sessionId, jobId, (current) => ({
          ...current,
          status: "exporting",
          sandboxId: result.sandboxId,
          statusDetail: formatAttemptStatus(statusDetail),
          errorMessage: null
        }));
      };

      await updateExportStatus("Saving edited source archive.");
      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "codeArchive",
        ...result.codeArchive
      });
      await updateExportStatus("Saving edited build archive.");
      await saveWebsiteJobArtifact(sessionId, jobId, {
        kind: "distArchive",
        ...result.distArchive
      });
      await updateExportStatus(`Saving ${result.previewFiles.length} edited preview files.`);
      await saveWebsitePreviewFiles(
        sessionId,
        jobId,
        [
          ...result.previewFiles.map((file) => ({
            assetPath: file.assetPath,
            buffer: file.buffer
          })),
          ...debugFiles.map((file) => ({
            assetPath: file.assetPath,
            buffer: file.buffer
          }))
        ]
      );

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "succeeded",
        sandboxId: result.sandboxId,
        completedAt: new Date().toISOString(),
        errorMessage: null,
        statusDetail: maxAttempts > 1 ? `Website edit is ready. Completed on attempt ${attempt}.` : "Website edit is ready."
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Website edit failed.";
      const canRetry = attempt < maxAttempts && isRetryableWebsiteGenerationError(message);

      if (canRetry) {
        await updateWebsiteJob(sessionId, jobId, (current) => ({
          ...current,
          status: "queued",
          errorMessage: null,
          statusDetail: `Transient website edit transport error. Retrying attempt ${attempt + 1}/${maxAttempts}...`
        }));
        await wait(attempt * 4000);
        continue;
      }

      return updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        statusDetail: "Website edit failed."
      }));
    }
  }

  return updateWebsiteJob(sessionId, jobId, (current) => ({
    ...current,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Website edit exhausted all retry attempts.",
    statusDetail: "Website edit failed."
  }));
}

async function runWebsiteEditJob(sessionId: string, jobId: string) {
  const job = await getWebsiteJob(sessionId, jobId);
  if (!job) {
    throw new Error("Website edit job not found");
  }

  return job.generationProfile === "fast"
    ? runWebsiteFastEditJob(sessionId, jobId)
    : runWebsiteEconEditJob(sessionId, jobId);
}

async function runWebsiteJob(sessionId: string, jobId: string) {
  const job = await getWebsiteJob(sessionId, jobId);
  if (!job) {
    throw new Error("Website job not found");
  }

  return job.jobKind === "edit"
    ? runWebsiteEditJob(sessionId, jobId)
    : job.generationProfile === "fast"
      ? runWebsiteFastGenerationJob(sessionId, jobId)
      : runWebsiteEconGenerationJob(sessionId, jobId);
}

function queueWebsiteJobRun(sessionId: string, jobId: string) {
  const runKey = getRunKey(sessionId, jobId);
  const existingRun = websiteJobRuns.get(runKey);
  if (existingRun) {
    return existingRun;
  }

  const run = runWebsiteJob(sessionId, jobId).finally(() => {
    websiteJobRuns.delete(runKey);
  });
  websiteJobRuns.set(runKey, run);
  return run;
}

export async function startWebsiteEditJob({
  sessionId,
  parentJobId,
  instructionText,
  annotation,
  domCandidates,
  transcriptTokens,
  visualReferenceImage
}: {
  sessionId: string;
  parentJobId: string;
  instructionText: string;
  annotation: WebsiteEditAnnotation;
  domCandidates: WebsiteEditDomCandidate[];
  transcriptTokens?: TranscriptToken[] | null;
  visualReferenceImage?: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  } | null;
}) {
  requireWebsiteSandboxConfig();

  const parentJob = await getWebsiteJob(sessionId, parentJobId);
  if (!parentJob) {
    throw new Error("Parent website job not found.");
  }

  if (parentJob.generationProfile === "fast") {
    requireV0WebsiteConfig();
    if (!readV0WebsiteState(parentJob)?.chatId) {
      throw new Error("Parent fast website is missing its v0 chat context.");
    }
  } else {
    await readCodexAuthJson();
  }

  if (parentJob.status !== "succeeded" || !parentJob.distArchiveUrl || !parentJob.codeArchiveUrl) {
    throw new Error("Parent website must be ready before it can be edited.");
  }

  const trimmedInstruction = instructionText.trim();
  if (!trimmedInstruction) {
    throw new Error("Edit instruction is required.");
  }

  if (!annotation.strokes.length) {
    throw new Error("A drawn annotation is required before editing the website.");
  }

  const targetResolution: WebsiteEditTargetResolution = await resolveWebsiteEditTargetsWithIntentParser({
    instructionText: trimmedInstruction,
    annotation,
    domCandidates,
    transcriptTokens
  });

  const hasResolvedTarget =
    Boolean(targetResolution.targetElementId) ||
    Boolean(targetResolution.targets?.some((target) => target.targetElementId));
  if (!hasResolvedTarget || targetResolution.confidence < 0.12) {
    throw new Error("Could not identify a website element from the annotation.");
  }

  const jobs = await listWebsiteJobs(sessionId);
  const revisionNumber = getNextWebsiteRevisionNumber(jobs, parentJob);
  const prompt =
    parentJob.generationProfile === "fast"
      ? buildV0WebsiteEditPrompt({
          instructionText: trimmedInstruction,
          targetResolution
        })
      : buildWebsiteEditPrompt({
          parentJob,
          instructionText: trimmedInstruction,
          targetResolution
        });

  const job = await createWebsiteJob(sessionId, {
    parentJobId: parentJob.id,
    revisionNumber,
    jobKind: "edit",
    status: "queued",
    completedAt: null,
    displayName: buildWebsiteEditDisplayName(parentJob, revisionNumber),
    framework: parentJob.framework,
    sandboxProvider: parentJob.sandboxProvider,
    sandboxId: null,
    generationProfile: parentJob.generationProfile,
    transcriptText: parentJob.transcriptText,
    pages: parentJob.pages,
    referenceImages: parentJob.referenceImages ?? [],
    prompt,
    providerMetadata: parentJob.generationProfile === "fast" ? parentJob.providerMetadata : null,
    editInstructionText: trimmedInstruction,
    editTarget: targetResolution,
    statusDetail: "Queued for targeted website edit.",
    errorMessage: null,
    previewImageFileName: null,
    previewImageMimeType: null,
    codeArchiveFileName: null,
    codeArchiveMimeType: null,
    distArchiveFileName: null,
    distArchiveMimeType: null
  });

  const queuedJob = visualReferenceImage
    ? await saveWebsiteJobArtifact(sessionId, job.id, {
        kind: "previewImage",
        buffer: visualReferenceImage.buffer,
        fileName: visualReferenceImage.fileName,
        mimeType: visualReferenceImage.mimeType
      })
    : job;

  void queueWebsiteJobRun(sessionId, queuedJob.id);
  return queuedJob;
}

export async function startWebsiteGenerationJob({
  sessionId,
  generationProfile = "fast",
  referenceImages
}: {
  sessionId: string;
  generationProfile?: WebsiteJob["generationProfile"];
  referenceImages?: unknown;
}) {
  requireWebsiteSandboxConfig();
  if (!hasOpenAiApiKey()) {
    throw new Error("OPENAI_API_KEY is required for website preview generation.");
  }
  if (generationProfile === "fast") {
    requireV0WebsiteConfig();
  } else {
    await readCodexAuthJson();
  }

  const session = await ensureSessionAnalysis({
    sessionId
  });

  if (!session.transcript.length) {
    throw new Error("Transcript is required before creating a website.");
  }

  if (!session.annotatedSketchUrl) {
    throw new Error("Annotated sketch is required before creating a website.");
  }

  const transcriptText = (session.analysis?.transcriptText || buildDisplayTranscript(session.transcript)).trim();
  const normalizedReferenceImages = normalizeWebsiteReferenceImages(referenceImages, session.canvasImageLayers);
  const pages = [
    {
      id: `${sessionId}-page-1`,
      title: session.title,
      path: "/",
      sourceAssetKind: "annotatedSketch" as const,
      sketchUrl: session.annotatedSketchUrl
    }
  ];

  const baseJob = await createWebsiteJob(sessionId, {
    parentJobId: null,
    revisionNumber: 1,
    jobKind: "initial",
    status: "queued",
    completedAt: null,
    displayName: buildWebsiteDisplayName(session.title),
    framework: generationProfile === "fast" ? "next-react" : "vite-react",
    sandboxProvider: "vercel",
    sandboxId: null,
    generationProfile,
    transcriptText,
    pages,
    referenceImages: normalizedReferenceImages,
    prompt: "",
    providerMetadata: null,
    editInstructionText: null,
    editTarget: null,
    statusDetail:
      generationProfile === "fast"
        ? "Queued for fast v0 website generation."
        : "Queued for econ Codex website generation.",
    errorMessage: null,
    previewImageFileName: null,
    previewImageMimeType: null,
    codeArchiveFileName: null,
    codeArchiveMimeType: null,
    distArchiveFileName: null,
    distArchiveMimeType: null
  });

  const job = await updateWebsiteJob(sessionId, baseJob.id, (current) => ({
    ...current,
    displayName: buildWebsiteDisplayName(session.title).slice(0, 80),
    prompt: "",
    statusDetail:
      generationProfile === "fast"
        ? "Queued for fast v0 website generation."
        : "Queued for econ Codex website generation."
  }));

  void queueWebsiteJobRun(sessionId, job.id);
  return job;
}

export async function syncWebsiteGenerationJob(sessionId: string, jobId: string) {
  const job = await getWebsiteJob(sessionId, jobId);
  if (!job) {
    throw new Error("Website job not found");
  }

  if (job.status === "failed" || job.status === "succeeded") {
    return job;
  }

  const runKey = getRunKey(sessionId, jobId);
  const hasLocalRun = websiteJobRuns.has(runKey);
  if (job.status === "queued" || (!hasLocalRun && isStaleWebsiteJob(job))) {
    if (job.status !== "queued") {
      await updateWebsiteJob(sessionId, jobId, (current) => ({
        ...current,
        status: "queued",
        errorMessage: null,
        statusDetail: `Resuming stale ${current.jobKind === "edit" ? "website edit" : "website generation"} job after local server restart.`
      }));
    }
    void queueWebsiteJobRun(sessionId, jobId);
  }

  return (await getWebsiteJob(sessionId, jobId)) ?? job;
}
