import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMonoPcm16, resampleMonoPcm } from "../lib/pcm";

test("resampleMonoPcm preserves approximate duration while changing sample rate", () => {
  const input = new Float32Array(480);
  for (let index = 0; index < input.length; index += 1) {
    input[index] = Math.sin((index / input.length) * Math.PI * 2);
  }

  const output = resampleMonoPcm(input, 48000, 24000);
  assert.equal(output.length, 240);
  assert.ok(Math.abs(output[0] - input[0]) < 1e-6);
});

test("encodeMonoPcm16 clamps and writes signed little-endian samples", () => {
  const pcm16 = encodeMonoPcm16(new Float32Array([0, 1.2, -1.4, 0.5]));
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);

  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 32767);
  assert.equal(view.getInt16(4, true), -32768);
  assert.equal(view.getInt16(6, true), 16384);
});
