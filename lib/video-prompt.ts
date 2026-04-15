import sharp from "sharp";
import { VideoModelPreset } from "@/lib/types";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const VIDEO_PROMPT_MODEL = process.env.OPENAI_VIDEO_PROMPT_MODEL ?? "gpt-5.4-mini";

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

const DYNAMIC_VIDEO_PROMPT_WRITER_INSTRUCTIONS = `
You write a final natural-language prompt for an image-to-video model.

Inputs:
- A transcript from the drawing session
- A labeled sketch image
- A generated source image

Your job is to convert these inputs into one concise prompt that tells the video model how the scene should move over time.

Core rules:
- Treat the generated source image as the visual truth for composition, appearance, subject identity, lighting, and style.
- Treat the transcript as the primary source of action, timing, motion intent, interaction, and narrative emphasis.
- Treat the labeled sketch as the primary source of spatial cues, layout confirmation, directionality, trajectory hints, and subject disambiguation.
- If the transcript uses ambiguous phrasing such as "from here to here", resolve actual direction from the labeled sketch and the source image instead of guessing.
- Preserve the existing composition of the generated source image unless the transcript strongly implies a more specific motion staging.
- Preserve the implied start pose, facing direction, and trajectory from the source image whenever they are visually legible. Do not reverse a subject's direction unless the transcript clearly requires it.
- Do not invent major subjects, actions, or camera moves that are not stated or strongly implied.
- Use explicit screen-space language when useful, such as upper-left, lower-right, upper third, lower third, foreground, and background.
- Describe motion concretely: who moves, from where, to where, along what path, how fast, and whether events happen simultaneously or sequentially.
- Describe camera behavior explicitly when it matters: fixed, pan, tracking, zoom, handheld, overhead, keep the full scene visible, do not follow the subject, and so on.
- Include secondary effects only when stated or strongly implied, such as dust, gusts, splashes, smoke, debris, glow, or motion trails.
- A single shot is allowed, but do not force it. If cuts or shot changes are genuinely implied by the transcript and sketch, you may describe them. Otherwise keep the sequence simple and coherent.
- Prefer precise spatial and temporal language over vague cinematic adjectives.
- Do not mention sketch labels, arrows, callout lines, annotations, editing instructions, aspect ratio, fps, duration, or any model-specific parameters.
- Return only one final prompt paragraph. No JSON. No bullets. No explanation.

The final prompt should be immediately usable by an image-to-video model.
`.trim();

const NORMAL_VIDEO_PROMPT_WRITER_INSTRUCTIONS = `
You write a final natural-language prompt for an image-to-video model.

Inputs:
- A transcript from the drawing session
- A source-image generation prompt
- A generated source image

Your job is to convert these inputs into one concise prompt that tells the video model how the scene should move over time in a natural, readable way.

Core rules:
- Treat the generated source image as the visual truth for composition, subject identity, appearance, lighting, and style.
- Treat the source-image generation prompt as the concise description of the intended static scene and preserve it.
- Treat the transcript as the primary source of motion, action, timing, interaction, and emphasis.
- Keep the scene coherent and readable. Slightly emphasize motion and temporal continuity, but do not force a highly dynamic reinterpretation when the transcript is simple.
- Preserve the existing composition of the source image unless the transcript clearly implies a specific movement emphasis.
- Prefer natural motion, stable temporal continuity, and visually readable action.
- Describe who moves, what moves, and any important interaction or atmosphere, but stay concise.
- Camera behavior should stay simple unless the transcript strongly implies otherwise. A fixed or gently stable shot is usually preferred.
- Do not invent major subjects, actions, or camera moves that are not stated or strongly implied.
- Do not mention sketch labels, annotations, editing instructions, aspect ratio, fps, duration, or model-specific parameters.
- Return only one final prompt paragraph. No JSON. No bullets. No explanation.

The final prompt should be immediately usable by an image-to-video model.
`.trim();

export async function writeDynamicVideoProviderPrompt({
  transcriptText,
  labeledSketch,
  sourceImage,
  modelPreset
}: {
  transcriptText: string;
  labeledSketch: Buffer;
  sourceImage: Buffer;
  modelPreset: VideoModelPreset;
}) {
  const normalizedTranscript = normalizeText(transcriptText);

  if (!normalizedTranscript) {
    throw new Error("Transcript text is required to write a video prompt.");
  }

  const payload = await callResponsesApi(
    {
      model: VIDEO_PROMPT_MODEL,
      reasoning: {
        effort: modelPreset === "quality" ? "medium" : "low"
      },
      store: false,
      instructions: DYNAMIC_VIDEO_PROMPT_WRITER_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Model preset: ${modelPreset}`,
                `Transcript:\n${normalizedTranscript}`,
                "Write a final image-to-video prompt using the attached labeled sketch image and generated source image.",
                "Preserve the generated source image as the visual starting point, and use the transcript plus labeled sketch to recover the intended motion, timing, and camera behavior."
              ].join("\n\n")
            },
            {
              type: "input_text",
              text: "Reference image 1: labeled sketch. Use it for layout confirmation, directionality, trajectory hints, and subject disambiguation."
            },
            {
              type: "input_image",
              image_url: await toInputImageDataUrl(labeledSketch)
            },
            {
              type: "input_text",
              text: "Reference image 2: generated source image. Treat this as the visual truth for subject appearance, composition, and style."
            },
            {
              type: "input_image",
              image_url: await toInputImageDataUrl(sourceImage)
            }
          ]
        }
      ]
    },
    getOpenAiKey()
  );

  const providerPrompt = normalizeText(extractOutputText(payload));
  if (!providerPrompt) {
    throw new Error("Video prompt writer returned an empty prompt.");
  }

  return {
      transcriptText: normalizedTranscript,
      providerPrompt,
      promptModel: typeof payload?.model === "string" ? payload.model : VIDEO_PROMPT_MODEL
    };
}

export async function writeNormalVideoProviderPrompt({
  transcriptText,
  sourceImagePrompt,
  sourceImage,
  modelPreset
}: {
  transcriptText: string;
  sourceImagePrompt: string;
  sourceImage: Buffer;
  modelPreset: VideoModelPreset;
}) {
  const normalizedTranscript = normalizeText(transcriptText);
  const normalizedSourceImagePrompt = normalizeText(sourceImagePrompt);

  if (!normalizedTranscript) {
    throw new Error("Transcript text is required to write a video prompt.");
  }

  if (!normalizedSourceImagePrompt) {
    throw new Error("Source-image prompt is required to write a normal video prompt.");
  }

  const payload = await callResponsesApi(
    {
      model: VIDEO_PROMPT_MODEL,
      reasoning: {
        effort: modelPreset === "quality" ? "medium" : "low"
      },
      store: false,
      instructions: NORMAL_VIDEO_PROMPT_WRITER_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Model preset: ${modelPreset}`,
                `Source-image generation prompt:\n${normalizedSourceImagePrompt}`,
                `Transcript:\n${normalizedTranscript}`,
                "Write a final image-to-video prompt using the generated source image.",
                "Preserve the source image as the visual starting point and use the transcript to add natural motion and timing."
              ].join("\n\n")
            },
            {
              type: "input_text",
              text: "Reference image: generated source image. Treat this as the visual truth for composition, subject appearance, and style."
            },
            {
              type: "input_image",
              image_url: await toInputImageDataUrl(sourceImage)
            }
          ]
        }
      ]
    },
    getOpenAiKey()
  );

  const providerPrompt = normalizeText(extractOutputText(payload));
  if (!providerPrompt) {
    throw new Error("Video prompt writer returned an empty prompt.");
  }

  return {
    transcriptText: normalizedTranscript,
    providerPrompt,
    promptModel: typeof payload?.model === "string" ? payload.model : VIDEO_PROMPT_MODEL
  };
}
