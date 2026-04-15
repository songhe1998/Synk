import sharp from "sharp";
import { VideoSourceSeedObject } from "@/lib/types";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const VIDEO_SOURCE_PLAN_MODEL =
  process.env.OPENAI_VIDEO_SOURCE_PLAN_MODEL ?? process.env.OPENAI_SCENE_MODEL ?? "gpt-5.4";

interface VideoSourcePlanPayload {
  objects: Array<{
    tag: string;
    label: string;
    evidence_quotes: string[];
  }>;
  video_source_image_prompt: string;
}

function getOpenAiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  return apiKey;
}

async function callResponsesApi(payload: object, apiKey: string) {
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Responses API failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function extractOutputText(payload: any) {
  const message = payload?.output?.find((item: any) => item.type === "message");
  const textPart = message?.content?.find((part: any) => part.type === "output_text");
  if (typeof textPart?.text !== "string" || !textPart.text.trim()) {
    throw new Error("Responses API returned no text payload.");
  }
  return textPart.text;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function toInputImageDataUrl(buffer: Buffer) {
  const prepared = await sharp(buffer)
    .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return `data:image/png;base64,${prepared.toString("base64")}`;
}

const VIDEO_SOURCE_PLAN_INSTRUCTIONS = `
You analyze a drawing-session transcript together with a plain sketch image and prepare a video-oriented source-image plan.

Your job is to produce:
- a minimal object list for later grounding and labeled-sketch generation
- one video_source_image_prompt for source-image generation

Inputs:
- A transcript of what the user said while drawing
- A plain sketch image without labels

Core rules:
- Use the transcript as the primary source of object identity and intended scene meaning.
- Use the plain sketch as the primary source of rough layout, framing, relative placement, and visible motion-aware staging cues.
- If the transcript uses deictic phrasing such as "from here to here", use the sketch to resolve actual on-screen direction.
- Recover the intended final scene, not the literal rough sketch marks.
- If the user says a rough shape becomes a real object, use the real object.
- Do not invent major objects that are not stated or strongly implied.
- The object list exists only to support grounding and later labeled-sketch generation, so keep it minimal.
- Do not include object descriptions or extra scene fields outside the required schema.
- Each object must include:
  - tag: a short stable identifier for internal use
  - label: a short human-readable label suitable for drawing onto the labeled sketch
  - evidence_quotes: 1 to 3 short verbatim quotes copied exactly from the transcript
- evidence_quotes must be exact substrings from the transcript, in the original language, with no paraphrasing.
- Keep labels short, concrete, and easy to place on a sketch.
- video_source_image_prompt must describe a strong source image for later video generation.
- video_source_image_prompt should describe a single image, not a whole animation.
- video_source_image_prompt should include the intended scene, composition, style, starting positions, pose, facing direction, framing, and motion-aware staging when useful.
- video_source_image_prompt should preserve the overall layout implied by the sketch.
- video_source_image_prompt should make the intended starting motion direction legible from pose, facing direction, and placement when that direction is implied by the sketch.
- video_source_image_prompt may leave open space in the composition for likely motion when useful.
- Do not mention sketch labels, arrows, callout lines, annotations, or editing instructions in video_source_image_prompt.
- Do not mention aspect ratio, fps, duration, or model-specific technical settings.
- Return strict JSON only.
`.trim();

export async function extractVideoSourcePlan({
  transcriptText,
  plainSketch
}: {
  transcriptText: string;
  plainSketch: Buffer;
}) {
  const normalizedTranscript = normalizeText(transcriptText);
  if (!normalizedTranscript) {
    throw new Error("Transcript text is required to build a video source plan.");
  }

  const payload = await callResponsesApi(
    {
      model: VIDEO_SOURCE_PLAN_MODEL,
      reasoning: {
        effort: "medium"
      },
      store: false,
      instructions: VIDEO_SOURCE_PLAN_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Transcript:\n${normalizedTranscript}`,
                "Analyze the attached plain sketch image together with the transcript.",
                "Return a minimal object list for grounding and one video-oriented source-image prompt."
              ].join("\n\n")
            },
            {
              type: "input_image",
              image_url: await toInputImageDataUrl(plainSketch)
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "video_source_plan",
          strict: true,
          schema: {
            type: "object",
            properties: {
              objects: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tag: { type: "string" },
                    label: { type: "string" },
                    evidence_quotes: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["tag", "label", "evidence_quotes"],
                  additionalProperties: false
                }
              },
              video_source_image_prompt: { type: "string" }
            },
            required: ["objects", "video_source_image_prompt"],
            additionalProperties: false
          }
        }
      }
    },
    getOpenAiKey()
  );

  const parsed = JSON.parse(extractOutputText(payload)) as VideoSourcePlanPayload;

  const objects: VideoSourceSeedObject[] = parsed.objects.map((object) => ({
    tag: normalizeText(object.tag),
    label: normalizeText(object.label),
    evidenceQuotes: object.evidence_quotes.map((quote) => normalizeText(quote)).filter(Boolean)
  }));
  const sourceImagePrompt = normalizeText(parsed.video_source_image_prompt);

  if (!sourceImagePrompt) {
    throw new Error("Video source planner returned an empty source-image prompt.");
  }

  if (objects.length === 0) {
    throw new Error("Video source planner returned no objects for grounding.");
  }

  return {
    model: typeof payload?.model === "string" ? payload.model : VIDEO_SOURCE_PLAN_MODEL,
    transcriptText: normalizedTranscript,
    objects,
    sourceImagePrompt
  };
}
