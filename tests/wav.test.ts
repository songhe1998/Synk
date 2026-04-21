import assert from "node:assert/strict";
import { test } from "node:test";
import { concatPcmChunks, encodeMonoPcmWav } from "../lib/wav";

test("concatPcmChunks preserves chunk order", () => {
  const merged = concatPcmChunks([new Float32Array([0.1, 0.2]), new Float32Array([-0.3])]);
  assert.equal(merged.length, 3);
  assert.ok(Math.abs(merged[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(merged[1] - 0.2) < 1e-6);
  assert.ok(Math.abs(merged[2] + 0.3) < 1e-6);
});

test("encodeMonoPcmWav writes a valid mono 16-bit WAV header", () => {
  const wav = encodeMonoPcmWav(new Float32Array([0, 1, -1]), 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString("ascii"), "WAVE");
  assert.equal(Buffer.from(wav.subarray(12, 16)).toString("ascii"), "fmt ");
  assert.equal(Buffer.from(wav.subarray(36, 40)).toString("ascii"), "data");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
});
