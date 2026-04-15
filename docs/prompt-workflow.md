# Prompt Workflow

This document explains, in plain English, the main prompts we wrote for the product and where each one is used in the overall workflow.

It is intentionally non-technical. The goal is to help someone understand the system logic, not the implementation details.

## The Big Picture

The product currently works like this:

1. The user draws and speaks.
2. The audio is transcribed.
3. The transcript is turned into a scene description.
4. That scene description is combined with the sketch and used to generate an image.
5. If the user chooses 3D world, that same scene description is also used to generate the world.

So there is not just one prompt. There are several prompts, each doing a different job.

## 1. Transcription Prompt

### What it does

This is the small prompt used during transcription. Its job is to help the speech model preserve the user’s original wording, especially when the audio mixes Chinese, English, and technical terms.

### Prompt text

```text
This audio may include Chinese, English, and mixed technical terms. Preserve original wording.
```

### Why it matters

Everything downstream depends on the transcript. If the transcript is wrong, the scene analysis and image generation will drift.

## 2. Scene Analysis Prompt

### What it does

This is the main reasoning prompt in the whole system.

Its job is to read the full spoken narration and turn it into:

- the important objects in the scene
- the global scene context
- the visual style
- a clean scene prompt for image generation

This step is where the system tries to understand what the user actually meant, not just what rough shapes were drawn.

### Prompt text

```text
You analyze the full spoken narration from a drawing session and prepare it for image generation.

Rules:
- Use the transcript as the only source of truth.
- Extract the final intended visible scene, not placeholder sketch geometry. If the user says a circle becomes a sun, the object is a sun.
- Each object must include 1 to 3 short evidence quotes copied verbatim from the transcript.
- Evidence quotes must be exact substrings from the transcript, in the original language, not paraphrases.
- Prefer evidence quotes that name or describe the final semantic object. Avoid using placeholder geometry phrases like "a circle" as the main evidence unless they are part of an explicit transformation into the final object.
- Do not invent objects that are not stated or strongly implied.
- If the user corrects themselves, use the last clear correction as final.
- Keep object descriptions natural and concise.
- Keep object tags short enough to draw on the sketch. Use spatial disambiguation only when needed, for example "left apple".
- Put background, style, relationships, and story/mood into global_info.
- Infer the intended visual style from the transcript itself. Use explicit style requests when they exist, and otherwise infer a fitting finished-image style from the user's wording, mood, subject matter, and descriptive cues.
- If the transcript does not provide meaningful style cues, keep the style natural and neutral rather than forcing a named style.
- Write generation_prompt as a natural paragraph for a finished image that follows the sketch layout and labels closely. The prompt should describe the intended final image style, whether explicitly requested or reasonably inferred from the transcript.
```

### How it is used

The transcript is placed under a simple wrapper:

```text
Transcript:
[full transcript here]
```

Then the model uses the rules above to produce the scene understanding.

### Why it matters

This is the step that decides whether the final result feels realistic, whimsical, stylized, calm, dramatic, and so on.

It is also the step that determines whether the system correctly understands what the user meant by their sketch and speech.

## 3. Sketch-Following Suffix

### What it does

After the scene analysis step creates the scene prompt, we add a second short instruction.

Its only job is to make sure the final image still follows the sketch layout and uses the labels correctly.

### Prompt text

```text
Follow the provided labeled sketch closely. Treat each label tag as the identity of the nearby object and preserve the overall layout. The label tags, callout lines, and any sketch annotations are only guidance and must not appear in the final rendered image.
```

### Why it matters

Without this layer, the image model may understand the scene correctly but ignore the sketch composition.

This prompt helps hold the final result closer to the user’s drawing.

## 4. Image Guidance Prompt

### What it does

This is the last prompt layer before image generation.

It tells the image model how to treat the sketch itself.

There are a few versions of it depending on:

- whether the sketch includes labels
- whether the user selected Pro or Fast

## 4A. Pro + Labeled Sketch

```text
Use the sketch lines and nearby labels only as layout and identity hints. Do not include any labels, text, dots, guide lines, or callout lines in the final image.
```

### Meaning

The model should use the sketch as guidance, but should not literally copy the labels or helper marks into the final picture.

## 4B. Pro + Plain Sketch

```text
Use the plain sketch lines and their relative positions as layout hints. There are no labels available, so infer object identity from the spoken prompt and the sketch geometry alone.
```

### Meaning

If there are no labels, the model has to rely more heavily on the scene description and the geometry of the sketch.

## 4C. Fast + Labeled Sketch

```text
Render a finished scene, not a sketch, line drawing, diagram, blueprint, or storyboard frame. Do not preserve hand-drawn outlines. Use the sketch lines and nearby labels only as layout and identity hints. Do not include any labels, text, dots, guide lines, or callout lines in the final image.
```

### Meaning

Fast mode is cheaper and lighter, so it needs extra pressure to avoid producing something that still looks like a rough drawing.

## 4D. Fast + Plain Sketch

```text
Render a finished scene, not a sketch, line drawing, diagram, blueprint, or storyboard frame. Do not preserve hand-drawn outlines. Use the plain sketch lines and their relative positions as layout hints. There are no labels available, so infer object identity from the spoken prompt and the sketch geometry alone.
```

### Meaning

This is the plain-sketch version of the same idea: use the sketch as guidance, but do not leave the result looking like a sketch.

## 5. The Final Image Prompt

### What it is

By the time the system asks for an image, the text prompt is built from multiple layers:

1. the scene prompt generated from the user’s transcript
2. the sketch-following suffix
3. the image guidance prompt

So the image model is not just hearing “draw a bedroom” or “draw a dog.” It is hearing:

- what the scene is
- what style it should have
- how closely to follow the sketch
- what sketch artifacts must not appear in the final image

### Why it matters

This is the final text instruction that shapes the image result.

It is the point where semantic understanding and sketch control come together.

## 6. The 3D World Prompt

### What it does

For 3D world generation, the system does not write a totally new prompt from scratch.

Instead, it reuses the same scene prompt that was prepared for image generation.

That means the 3D world is based on the same interpreted scene as the image.

### Why it matters

This keeps the product coherent:

- the image and the world are not treated as two unrelated outputs
- they are two renderings of the same scene understanding

## 7. Fast vs Pro

### Shared logic

Both Fast and Pro now use the same high-level strategy:

- if the user explicitly asks for a style, keep that style
- if the user does not explicitly ask for a style, infer the style from the user’s words

So the system is no longer forcing everything to be realistic by default.

### Difference

The main prompt-level difference is that Fast adds a stronger “do not look like a sketch” instruction at the image stage.

That is there because Fast mode is more likely to drift toward rough or sketch-like results unless it is pushed back toward a finished image.

## 8. What Is Not Included Here

This document only covers the prompt text we wrote ourselves.

It does not include:

- the user’s actual transcript
- the scene prompt generated by the model at runtime
- any internal prompt rewriting done by image models behind the scenes
- captions or metadata returned later by 3D world generation

## 9. Short Summary

If you want the simplest possible explanation, the system uses prompts in four stages:

1. A transcription prompt to preserve what the user actually said
2. A scene-analysis prompt to understand the scene and infer the right style
3. A sketch-following prompt to keep the generated result aligned with the drawing
4. A final image-guidance prompt to tell the model how to use the sketch without copying sketch artifacts

That combined prompt logic is what makes the workflow feel like:

```text
sketch + speech -> understood scene -> finished image -> optional 3D world
```
