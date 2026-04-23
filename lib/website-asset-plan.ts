export interface WebsiteAssetPlanComponent {
  name: string;
  role: string;
  rationale: string;
}

export interface WebsiteImageryComponent {
  name: string;
  role: string;
  rationale: string;
  target_description: string;
  prompt: string;
  aspect_ratio: "portrait" | "landscape" | "square";
}

export interface WebsiteAssetPlanSection {
  name: string;
  purpose: string;
  emphasis: "primary" | "supporting";
}

export interface WebsiteAssetPlan {
  shared_style_language: string;
  route_strategy: "single-page" | "multi-page";
  shell_style: string;
  primary_sections: WebsiteAssetPlanSection[];
  priority_primitives: string[];
  implementation_notes: string[];
  code_components: WebsiteAssetPlanComponent[];
  imagery_components: WebsiteImageryComponent[];
}

export function getWebsiteAssetPlanSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "shared_style_language",
      "route_strategy",
      "shell_style",
      "primary_sections",
      "priority_primitives",
      "implementation_notes",
      "code_components",
      "imagery_components"
    ],
    properties: {
      shared_style_language: {
        type: "string"
      },
      route_strategy: {
        type: "string",
        enum: ["single-page", "multi-page"]
      },
      shell_style: {
        type: "string"
      },
      primary_sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "purpose", "emphasis"],
          properties: {
            name: { type: "string" },
            purpose: { type: "string" },
            emphasis: {
              type: "string",
              enum: ["primary", "supporting"]
            }
          }
        }
      },
      priority_primitives: {
        type: "array",
        items: {
          type: "string"
        }
      },
      implementation_notes: {
        type: "array",
        items: {
          type: "string"
        }
      },
      code_components: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "role", "rationale"],
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            rationale: { type: "string" }
          }
        }
      },
      imagery_components: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "role", "rationale", "target_description", "prompt", "aspect_ratio"],
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            rationale: { type: "string" },
            target_description: { type: "string" },
            prompt: { type: "string" },
            aspect_ratio: {
              type: "string",
              enum: ["portrait", "landscape", "square"]
            }
          }
        }
      }
    }
  };
}

export function buildCodexPlannerPrompt(transcript: string) {
  return [
    "You are analyzing a full website preview image and a user transcript.",
    "The image is the main visual source of truth. The transcript provides semantic intent.",
    "Your task is NOT to build code. Your task is to produce a structured asset plan for reconstructing the page.",
    "First infer one shared style language across all imagery on the page.",
    "Then infer the page shell and implementation blueprint:",
    "- route_strategy: single-page if section navigation is natural, multi-page if the preview/transcript clearly imply distinct destinations",
    "- shell_style: one concise sentence that captures the page shell and surface grammar",
    "- primary_sections: 3 to 6 sections with purpose and emphasis",
    "- priority_primitives: which existing scaffold primitives should be favored",
    "- implementation_notes: compact rules that will help a coding agent stay faithful without overbuilding",
    "Then separate the page into:",
    "- code_components: layout, typography, navigation, text panels, buttons, dividers, cards, forms, sidebars, footer, ornaments that should be implemented in code",
    "- imagery_components: photos, illustrations, archival thumbnails, maps, posters, or other image-like regions that should be recreated with an image generation tool",
    "Do NOT crop the preview. Look at the whole page and derive consistent prompts for each imagery component in the same shared visual language.",
    "Use the preview literally. If the preview shows a man reading in an archive, describe that. If it shows a sepia crowd scene, an antique map, or a writing-at-desk scene, describe those directly.",
    "Do not reinterpret obvious depicted subjects into abstract symbolism unless the preview itself is abstract.",
    "If a strip or grid contains multiple distinct image thumbnails, treat each distinct thumbnail as its own imagery component, even when those thumbnails live inside reusable code cards.",
    "If the page clearly contains a hero portrait plus several distinct editorial thumbnails, the imagery plan should normally include all of them.",
    "The prompts must make all generated imagery feel like they belong to the same website.",
    "The prompts should mention era, palette, medium, lighting, texture, and mood when relevant.",
    "Do not include text overlays, labels, borders, UI chrome, signatures, or handwritten marks in the imagery prompts unless absolutely necessary.",
    "Keep the number of imagery components reasonable and focused on real image-like regions only.",
    "The implementation blueprint should bias toward reuse of existing primitives instead of rebuilding everything from raw divs.",
    "Keep implementation_notes short and concrete. They should help a coding agent move faster without lowering fidelity.",
    "Prefer 4 to 6 imagery components for editorial pages with one hero image and multiple thumbnail images, unless the preview truly contains fewer image regions.",
    "Use the transcript as semantic support:",
    `"${transcript.trim()}"`,
    "Return JSON only, following the provided schema."
  ].join("\n");
}
