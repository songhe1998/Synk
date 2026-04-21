# Synk Demo

An internal demo for keeping microphone capture tied to the active canvas, replaying drawing events and microphone audio on the same timeline, and turning the finished sketch plus narration into a generated image, video, or 3D world.

## What it does

- Records a desktop Chrome canvas with `MediaRecorder` audio that stays on for the active canvas until the user presses `Go`.
- Stores recent sessions on local disk under `data/sessions/`.
- Replays drawing events against the audio timeline.
- Calls the OpenAI transcription API when `OPENAI_API_KEY` is set.
- Uses `gpt-5.4` to extract scene objects, object descriptions, evidence quotes, and global scene info from the full transcript.
- Grounds extracted objects back to stroke clusters and renders an annotated sketch with object tags.
- Uses the Responses API image generation tool with `gpt-5.4` orchestration to edit the labeled sketch into a final image.
- Uses a dedicated video source planner to turn the plain sketch plus transcript into a motion-aware source-image prompt, then generates a video-specific labeled sketch and source image.
- Uses a second OpenAI prompt-writer step to turn the transcript, video labeled sketch, and generated source image into a provider-ready video prompt before sending it to MuAPI.
- Can turn the generated video source image into a short video through MuAPI using a low-cost lite pass for validation and a higher-cost Seedance 2 omni-reference pass for final checks.
- Can send the generated image to the World Labs Marble API and open the result as an explorable 3D world.
- Falls back to a placeholder transcript when no API key is configured.

## Quick start

1. Install Node.js 22 or newer.
2. Install dependencies:

```bash
npm install
```

3. Optional but recommended: configure OpenAI.

```bash
cp .env.example .env.local
```

4. Start the app.

For reliable local testing, use production mode:

```bash
npm run build
npm run start
```

5. Open `http://localhost:3000`.
6. Start a new canvas, sketch and speak, then press `Go`.
7. Open the playback page and use:
   - `Analyze with GPT-5.4`
   - `Generate image`
   - `Generate lite video` or `Generate quality video`
   - `Generate HD world`

## Environment

- `OPENAI_API_KEY`
- `OPENAI_TRANSCRIBE_MODEL`
  Default: `whisper-1`
- `OPENAI_SCENE_MODEL`
  Default: `gpt-5.4`
- `OPENAI_VIDEO_SOURCE_PLAN_MODEL`
  Default: `gpt-5.4`
- `OPENAI_IMAGE_ORCHESTRATOR_MODEL`
  Default: `gpt-5.4`
- `OPENAI_VIDEO_PROMPT_MODEL`
  Default: `gpt-5.4-mini`
- `WORLDLABS_API_KEY`
- `WORLDLABS_MODEL_DRAFT`
  Default: `marble-1.0-draft`
- `WORLDLABS_MODEL_HD`
  Default: `marble-1.1-plus`
- `MUAPI_API_KEY`
- `MUAPI_VIDEO_MODEL_LITE`
  Default: `seedance-lite-i2v`
- `MUAPI_VIDEO_MODEL_QUALITY`
  Default: `seedance-2-vip-omni-reference-fast`
- `SESSION_DATA_ROOT`
  Default: `./data/sessions`

## Deploy on Render

This repo now includes a [render.yaml](/Users/songhewang/Desktop/synk/render.yaml) Blueprint for Render.

What it configures:
- A Node web service running `npm install && npm run build`
- Startup with `next start` bound to `0.0.0.0` and Render's `PORT`
- A health check at `/api/health`
- A persistent disk mounted at `/var/data`
- `SESSION_DATA_ROOT=/var/data/sessions` so recordings, transcripts, analyses, and generated images survive restarts

Recommended deployment flow:
1. Push this repo to GitHub/GitLab/Bitbucket.
2. In Render, create a new Blueprint from the repo.
3. Review the generated `synk-demo` web service.
4. Set `OPENAI_API_KEY` in the Render dashboard when prompted.
5. Deploy.

Important:
- This app stores all session assets on the local filesystem. On Render, that means you should keep the persistent disk. Without it, session data will disappear on redeploys and restarts.
- The Blueprint uses the `starter` plan because persistent disks require a paid web service.
- Region is set to `virginia` by default in [render.yaml](/Users/songhewang/Desktop/synk/render.yaml); change it if you want a different region before deploying.

## Notes

- This is a demo, not a production system.
- Voice capture is scoped to the active canvas. If the page becomes hidden before you press `Go`, the microphone stops immediately and the unfinished draft session is discarded.
- Chinese token timing is approximated when the transcription API does not return true character-level timestamps.
- If you override the model to `gpt-4o-mini-transcribe` or `gpt-4o-transcribe`, the app will retry with `whisper-1` for timestamped replay data because those models may reject `verbose_json`.
- Scene analysis is whole-transcript based. It does not do sentence-by-sentence grounding; instead it asks `gpt-5.4` for final objects plus verbatim evidence quotes, then maps those quotes back to timeline moments and nearby stroke clusters.
- The annotated sketch is only guidance for image generation. Labels and callout lines are intentionally excluded from the final rendered image prompt.
- Recent sessions are capped at 8 and older ones are pruned automatically.
