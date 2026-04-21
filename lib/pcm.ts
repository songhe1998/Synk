function clampSample(sample: number) {
  if (sample > 1) {
    return 1;
  }

  if (sample < -1) {
    return -1;
  }

  return sample;
}

export function resampleMonoPcm(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
) {
  if (inputSampleRate <= 0 || outputSampleRate <= 0) {
    throw new Error("Sample rates must be positive.");
  }

  if (input.length === 0) {
    return new Float32Array();
  }

  if (inputSampleRate === outputSampleRate) {
    return new Float32Array(input);
  }

  const outputLength = Math.max(1, Math.round((input.length * outputSampleRate) / inputSampleRate));
  const output = new Float32Array(outputLength);
  const ratio = inputSampleRate / outputSampleRate;

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const mix = position - leftIndex;
    const left = input[Math.min(leftIndex, input.length - 1)] ?? 0;
    const right = input[rightIndex] ?? left;
    output[index] = left + (right - left) * mix;
  }

  return output;
}

export function encodeMonoPcm16(samples: Float32Array) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampSample(samples[index] ?? 0);
    const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(index * 2, int16, true);
  }

  return bytes;
}
