import assert from "node:assert/strict";
import { test } from "node:test";
import { isPromptEchoTranscriptText, TRANSCRIPTION_PROMPT } from "../lib/transcript";

test("isPromptEchoTranscriptText catches an exact prompt echo", () => {
  assert.equal(isPromptEchoTranscriptText(TRANSCRIPTION_PROMPT), true);
});

test("isPromptEchoTranscriptText catches repeated prompt echo output", () => {
  const repeated = `${TRANSCRIPTION_PROMPT} ${TRANSCRIPTION_PROMPT} ${TRANSCRIPTION_PROMPT}`;
  assert.equal(isPromptEchoTranscriptText(repeated), true);
});

test("isPromptEchoTranscriptText ignores normal user speech", () => {
  const transcript =
    "Build a lawnmower company website for Connor's Lawnmowers in St Louis with three mower packages and a pricing section.";
  assert.equal(isPromptEchoTranscriptText(transcript), false);
});
