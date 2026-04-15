import sharp from "sharp";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const VIDEO_SOURCE_REVIEW_MODEL = process.env.OPENAI_VIDEO_SOURCE_REVIEW_MODEL ?? "gpt-5.4-mini";

interface VideoSourceReviewPayload {
  passes: boolean;
  issues: string[];
  correction_prompt: string;
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

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() || "";
}

async function toInputImageDataUrl(buffer: Buffer) {
  const prepared = await sharp(buffer)
    .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return `data:image/png;base64,${prepared.toString("base64")}`;
}

const VIDEO_SOURCE_REVIEW_INSTRUCTIONS = `
You review whether a generated video source image matches a motion-aware source-image prompt.

Focus on:
- subject identity
- screen placement
- facing direction
- legibility of starting motion direction
- whether any subject's left-right orientation or trajectory has been reversed

Use the labeled sketch to confirm layout and directional cues.
Use the source-image prompt and transcript as the intended target.

Return strict JSON:
- passes: true only if the important subjects, placements, and motion directions are preserved well enough for video generation
- issues: short concrete mismatches
- correction_prompt: empty when passes is true; otherwise one concise regeneration instruction that fixes the mismatches without changing the rest of the composition
`.trim();

export async function reviewVideoSourceImage({
  transcriptText,
  sourceImagePrompt,
  labeledSketch,
  sourceImage
}: {
  transcriptText: string;
  sourceImagePrompt: string;
  labeledSketch: Buffer;
  sourceImage: Buffer;
}) {
  const payload = await callResponsesApi(
    {
      model: VIDEO_SOURCE_REVIEW_MODEL,
      reasoning: {
        effort: "low"
      },
      store: false,
      instructions: VIDEO_SOURCE_REVIEW_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Transcript:\n${normalizeText(transcriptText)}`,
                `Target source-image prompt:\n${normalizeText(sourceImagePrompt)}`,
                "Check whether the generated source image preserves the intended subject positions and motion directions."
              ].join("\n\n")
            },
            {
              type: "input_text",
              text: "Reference image 1: labeled sketch for layout and directional cues."
            },
            {
              type: "input_image",
              image_url: await toInputImageDataUrl(labeledSketch)
            },
            {
              type: "input_text",
              text: "Reference image 2: generated source image to review."
            },
            {
              type: "input_image",
              image_url: await toInputImageDataUrl(sourceImage)
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "video_source_review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              passes: { type: "boolean" },
              issues: {
                type: "array",
                items: { type: "string" }
              },
              correction_prompt: { type: "string" }
            },
            required: ["passes", "issues", "correction_prompt"],
            additionalProperties: false
          }
        }
      }
    },
    getOpenAiKey()
  );

  const parsed = JSON.parse(extractOutputText(payload)) as VideoSourceReviewPayload;
  return {
    passes: parsed.passes,
    issues: parsed.issues.map((issue) => normalizeText(issue)).filter(Boolean),
    correctionPrompt: normalizeText(parsed.correction_prompt),
    model: typeof payload?.model === "string" ? payload.model : VIDEO_SOURCE_REVIEW_MODEL
  };
}
