import { TranscriptNormalizationResult, TranscriptToken } from "@/lib/types";

interface RawToken {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const TIMESTAMP_FALLBACK_MODEL = "whisper-1";
const TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
export const TRANSCRIPTION_PROMPT =
  "This audio may include Chinese, English, and mixed technical terms. Preserve original wording.";
const PROMPT_ECHO_ERROR_CODE = "PROMPT_ECHO_TRANSCRIPT";

function canonicalizeTranscriptText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CANONICAL_TRANSCRIPTION_PROMPT = canonicalizeTranscriptText(TRANSCRIPTION_PROMPT);
const CANONICAL_TRANSCRIPTION_PROMPT_WORDS = new Set(CANONICAL_TRANSCRIPTION_PROMPT.split(" "));

function parseStructuredErrorMessage(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);

  try {
    return JSON.parse(rawMessage) as {
      code?: string;
      model?: string;
      responseFormat?: string;
      includeWordTimestamps?: boolean;
      message?: string;
      rawText?: string;
    };
  } catch {
    return null;
  }
}

function buildTranscriptText(tokens: TranscriptToken[]) {
  return tokens
    .map((token) => token.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

export function isPromptEchoTranscriptText(text: string) {
  const canonical = canonicalizeTranscriptText(text);
  if (!canonical) {
    return false;
  }

  if (canonical === CANONICAL_TRANSCRIPTION_PROMPT) {
    return true;
  }

  const doubledPrompt = `${CANONICAL_TRANSCRIPTION_PROMPT} ${CANONICAL_TRANSCRIPTION_PROMPT}`;
  if (canonical.includes(doubledPrompt)) {
    return true;
  }

  const words = canonical.split(" ").filter(Boolean);
  if (words.length < 5) {
    return false;
  }

  const matchingWords = words.filter((word) => CANONICAL_TRANSCRIPTION_PROMPT_WORDS.has(word)).length;
  const uniqueWords = Array.from(new Set(words));
  const uniqueMatchingWords = uniqueWords.filter((word) => CANONICAL_TRANSCRIPTION_PROMPT_WORDS.has(word)).length;

  return matchingWords / words.length >= 0.85 && uniqueMatchingWords / uniqueWords.length >= 0.85;
}

function ensureTranscriptDoesNotEchoPrompt(result: TranscriptNormalizationResult) {
  const transcriptText = buildTranscriptText(result.tokens);
  if (!isPromptEchoTranscriptText(transcriptText)) {
    return;
  }

  throw new Error(
    JSON.stringify({
      code: PROMPT_ECHO_ERROR_CODE,
      message: "Transcription output echoed the transcription prompt instead of the spoken audio."
    })
  );
}

function secondsToMs(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 1000);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed * 1000);
    }
  }

  return fallback;
}

function isCjkCharacter(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function isLatinWordCharacter(value: string) {
  return /[\p{Alphabetic}\p{Number}'’_-]/u.test(value) && !isCjkCharacter(value);
}

function normalizeLang(text: string) {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) {
    return "cjk";
  }

  if (/[A-Za-z]/.test(text)) {
    return "latin";
  }

  return "unknown";
}

function splitMixedToken(text: string) {
  const pieces: Array<{
    text: string;
    granularity: TranscriptToken["granularity"];
    lang: string;
  }> = [];

  let buffer = "";
  let bufferMode: "latin" | "punctuation" | null = null;

  const flush = () => {
    if (!buffer) {
      return;
    }

    pieces.push({
      text: buffer,
      granularity: bufferMode === "latin" ? "word" : "punctuation",
      lang: bufferMode === "latin" ? "latin" : "unknown"
    });
    buffer = "";
    bufferMode = null;
  };

  for (const char of text.trim()) {
    if (/\s/u.test(char)) {
      flush();
      continue;
    }

    if (isCjkCharacter(char)) {
      flush();
      pieces.push({
        text: char,
        granularity: "char",
        lang: "cjk"
      });
      continue;
    }

    if (isLatinWordCharacter(char)) {
      if (bufferMode === "latin") {
        buffer += char;
      } else {
        flush();
        buffer = char;
        bufferMode = "latin";
      }
      continue;
    }

    if (bufferMode === "punctuation") {
      buffer += char;
    } else {
      flush();
      buffer = char;
      bufferMode = "punctuation";
    }
  }

  flush();
  return pieces;
}

export function normalizeTranscriptSpan(
  text: string,
  startMs: number,
  endMs: number,
  idPrefix: string
): TranscriptNormalizationResult {
  const pieces = splitMixedToken(text);
  if (pieces.length === 0) {
    return {
      tokens: [],
      approximate: false
    };
  }

  const safeStart = Math.max(0, Math.round(startMs));
  const safeEnd = Math.max(safeStart + pieces.length, Math.round(endMs));
  const sliceSize = Math.max(1, safeEnd - safeStart) / pieces.length;
  const tokens: TranscriptToken[] = [];

  pieces.forEach((piece, pieceIndex) => {
    const pieceStartMs =
      pieces.length === 1 ? safeStart : Math.round(safeStart + pieceIndex * sliceSize);
    const pieceEndMs =
      pieces.length === 1
        ? safeEnd
        : Math.round(pieceIndex === pieces.length - 1 ? safeEnd : safeStart + (pieceIndex + 1) * sliceSize);

    tokens.push({
      id: `${idPrefix}-${pieceIndex}`,
      text: piece.text,
      startMs: pieceStartMs,
      endMs: Math.max(pieceStartMs + 1, pieceEndMs),
      granularity: piece.granularity,
      lang: piece.lang || normalizeLang(piece.text),
      approximate: pieces.length > 1
    });
  });

  return {
    tokens,
    approximate: pieces.length > 1
  };
}

function coerceRawTokens(payload: any, durationMs: number): RawToken[] {
  if (Array.isArray(payload?.words) && payload.words.length > 0) {
    return payload.words
      .map((word: any) => ({
        text: typeof word.word === "string" ? word.word : typeof word.text === "string" ? word.text : "",
        startMs: secondsToMs(word.start, 0),
        endMs: secondsToMs(word.end, durationMs),
        confidence: typeof word.confidence === "number" ? word.confidence : undefined
      }))
      .filter((word: RawToken) => word.text.trim().length > 0);
  }

  if (Array.isArray(payload?.segments) && payload.segments.length > 0) {
    return payload.segments
      .map((segment: any) => ({
        text: typeof segment.text === "string" ? segment.text : "",
        startMs: secondsToMs(segment.start, 0),
        endMs: secondsToMs(segment.end, durationMs),
        confidence: typeof segment.avg_logprob === "number" ? Math.exp(segment.avg_logprob) : undefined
      }))
      .filter((segment: RawToken) => segment.text.trim().length > 0);
  }

  if (typeof payload?.text === "string" && payload.text.trim()) {
    return [
      {
        text: payload.text.trim(),
        startMs: 0,
        endMs: durationMs
      }
    ];
  }

  return [];
}

export function normalizeTranscript(payload: any, durationMs: number): TranscriptNormalizationResult {
  const rawTokens = coerceRawTokens(payload, durationMs);
  const tokens: TranscriptToken[] = [];
  let approximate = false;

  rawTokens.forEach((rawToken, rawIndex) => {
    const pieces = splitMixedToken(rawToken.text);
    if (pieces.length === 0) {
      return;
    }

    const normalized = normalizeTranscriptSpan(rawToken.text, rawToken.startMs, rawToken.endMs, String(rawIndex));
    normalized.tokens.forEach((token) => {
      tokens.push({
        ...token,
        confidence: rawToken.confidence
      });
    });
    approximate ||= normalized.approximate;
  });

  return {
    tokens,
    approximate
  };
}

function buildTranscriptionBody({
  audioBuffer,
  mimeType,
  fileName,
  model,
  responseFormat,
  includeWordTimestamps,
  prompt
}: {
  audioBuffer: Buffer;
  mimeType: string;
  fileName: string;
  model: string;
  responseFormat: "json" | "text" | "verbose_json";
  includeWordTimestamps: boolean;
  prompt?: string | null;
}) {
  const body = new FormData();
  body.append("model", model);
  body.append("response_format", responseFormat);
  if (includeWordTimestamps) {
    body.append("timestamp_granularities[]", "word");
  }
  if (prompt?.trim()) {
    body.append("prompt", prompt);
  }
  body.append("file", new File([Uint8Array.from(audioBuffer)], fileName, { type: mimeType }));
  return body;
}

async function parseErrorMessage(response: Response) {
  const rawText = await response.text();

  try {
    const payload = JSON.parse(rawText);
    const message =
      typeof payload?.error?.message === "string" ? payload.error.message : rawText;
    return {
      rawText,
      message
    };
  } catch {
    return {
      rawText,
      message: rawText
    };
  }
}

function isTimestampCapabilityError(errorText: string) {
  return (
    /unsupported_value|not compatible|not supported/i.test(errorText) &&
    /(response_format|timestamp_granularities)/i.test(errorText)
  );
}

async function requestTranscription({
  apiKey,
  audioBuffer,
  mimeType,
  fileName,
  model,
  responseFormat,
  includeWordTimestamps,
  prompt
}: {
  apiKey: string;
  audioBuffer: Buffer;
  mimeType: string;
  fileName: string;
  model: string;
  responseFormat: "json" | "text" | "verbose_json";
  includeWordTimestamps: boolean;
  prompt?: string | null;
}) {
  const response = await fetch(TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: buildTranscriptionBody({
      audioBuffer,
      mimeType,
      fileName,
      model,
      responseFormat,
      includeWordTimestamps,
      prompt
    })
  });

  if (!response.ok) {
    const error = await parseErrorMessage(response);
    throw new Error(
      JSON.stringify({
        model,
        responseFormat,
        includeWordTimestamps,
        message: error.message,
        rawText: error.rawText
      })
    );
  }

  if (responseFormat === "text") {
    return {
      text: await response.text()
    };
  }

  return response.json();
}

export async function transcribeAudio({
  audioBuffer,
  mimeType,
  fileName,
  durationMs
}: {
  audioBuffer: Buffer;
  mimeType: string;
  fileName: string;
  durationMs: number;
}): Promise<TranscriptNormalizationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      tokens: [
        {
          id: "demo-placeholder",
          text: "Set OPENAI_API_KEY to enable real transcription.",
          startMs: 0,
          endMs: Math.max(durationMs, 1500),
          granularity: "word",
          lang: "latin",
          approximate: true
        }
      ],
      approximate: true
    };
  }

  const configuredModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIBE_MODEL;

  try {
    const timedPayload = await requestTranscription({
      apiKey,
      audioBuffer,
      mimeType,
      fileName,
      model: configuredModel,
      responseFormat: "verbose_json",
      includeWordTimestamps: true,
      prompt: null
    });

    const normalized = normalizeTranscript(timedPayload, durationMs);
    ensureTranscriptDoesNotEchoPrompt(normalized);
    return normalized;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const parsedError = parseStructuredErrorMessage(error);

    const capabilityError = isTimestampCapabilityError(parsedError?.message ?? errorMessage);
    const promptEchoError = parsedError?.code === PROMPT_ECHO_ERROR_CODE;
    if (!capabilityError && !promptEchoError) {
      throw new Error(
        `Transcription request failed for model '${configuredModel}': ${parsedError?.message ?? errorMessage}`
      );
    }
  }

  const fallbackModel =
    configuredModel === TIMESTAMP_FALLBACK_MODEL ? configuredModel : TIMESTAMP_FALLBACK_MODEL;

  try {
    const fallbackTimedPayload = await requestTranscription({
      apiKey,
      audioBuffer,
      mimeType,
      fileName,
      model: fallbackModel,
      responseFormat: "verbose_json",
      includeWordTimestamps: true,
      prompt: null
    });

    const normalized = normalizeTranscript(fallbackTimedPayload, durationMs);
    ensureTranscriptDoesNotEchoPrompt(normalized);
    return normalized;
  } catch (fallbackError) {
    if (fallbackModel !== configuredModel) {
      try {
        const approximatePayload = await requestTranscription({
          apiKey,
          audioBuffer,
          mimeType,
          fileName,
          model: configuredModel,
          responseFormat: "json",
          includeWordTimestamps: false,
          prompt: null
        });

        const normalized = normalizeTranscript(approximatePayload, durationMs);
        ensureTranscriptDoesNotEchoPrompt(normalized);
        return normalized;
      } catch (approximateError) {
        const approximateMessage =
          parseStructuredErrorMessage(approximateError)?.message ??
          (approximateError instanceof Error ? approximateError.message : String(approximateError));
        throw new Error(
          `Transcription failed after timestamp fallback. Primary model: '${configuredModel}', timestamp fallback model: '${fallbackModel}'. Final error: ${approximateMessage}`
        );
      }
    }

    const fallbackMessage =
      parseStructuredErrorMessage(fallbackError)?.message ??
      (fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
    throw new Error(`Transcription request failed for model '${fallbackModel}': ${fallbackMessage}`);
  }
}
