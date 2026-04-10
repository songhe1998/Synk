import { TranscriptEvidenceMatch, TranscriptToken } from "@/lib/types";

interface SearchIndex {
  normalizedText: string;
  punctuationInsensitiveText: string;
  normalizedCharToToken: number[];
  punctuationInsensitiveCharToToken: number[];
}

function isLatinWordToken(token: TranscriptToken) {
  return token.lang === "latin" && token.granularity === "word";
}

function isPunctuationToken(token: TranscriptToken) {
  return token.granularity === "punctuation";
}

export function buildDisplayTranscript(tokens: TranscriptToken[]) {
  let output = "";

  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    const needsSpace =
      output.length > 0 &&
      previous &&
      !isPunctuationToken(token) &&
      !isPunctuationToken(previous) &&
      (isLatinWordToken(token) || isLatinWordToken(previous));

    output += needsSpace ? ` ${token.text}` : token.text;
  });

  return output.trim();
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/gu, "").toLowerCase();
}

function normalizeWithoutPunctuation(text: string) {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

function buildSearchIndex(tokens: TranscriptToken[]): SearchIndex {
  let normalizedText = "";
  let punctuationInsensitiveText = "";
  const normalizedCharToToken: number[] = [];
  const punctuationInsensitiveCharToToken: number[] = [];

  tokens.forEach((token, tokenIndex) => {
    const normalizedPiece = normalizeWhitespace(token.text);
    for (const char of normalizedPiece) {
      normalizedText += char;
      normalizedCharToToken.push(tokenIndex);
    }

    const punctuationInsensitivePiece = normalizeWithoutPunctuation(token.text);
    for (const char of punctuationInsensitivePiece) {
      punctuationInsensitiveText += char;
      punctuationInsensitiveCharToToken.push(tokenIndex);
    }
  });

  return {
    normalizedText,
    punctuationInsensitiveText,
    normalizedCharToToken,
    punctuationInsensitiveCharToToken
  };
}

function buildMatchedText(tokens: TranscriptToken[], startTokenIndex: number, endTokenIndex: number) {
  return buildDisplayTranscript(tokens.slice(startTokenIndex, endTokenIndex + 1));
}

function exactMatchEvidence(
  quote: string,
  index: SearchIndex
): { startChar: number; endCharExclusive: number; matchKind: TranscriptEvidenceMatch["matchKind"] } | null {
  const normalizedQuote = normalizeWhitespace(quote);
  if (normalizedQuote) {
    const foundAt = index.normalizedText.indexOf(normalizedQuote);
    if (foundAt >= 0) {
      return {
        startChar: foundAt,
        endCharExclusive: foundAt + normalizedQuote.length,
        matchKind: "exact"
      };
    }
  }

  const punctuationInsensitiveQuote = normalizeWithoutPunctuation(quote);
  if (!punctuationInsensitiveQuote) {
    return null;
  }

  const fallbackAt = index.punctuationInsensitiveText.indexOf(punctuationInsensitiveQuote);
  if (fallbackAt < 0) {
    return null;
  }

  return {
    startChar: fallbackAt,
    endCharExclusive: fallbackAt + punctuationInsensitiveQuote.length,
    matchKind: "punctuation_insensitive"
  };
}

export function matchEvidenceQuote(tokens: TranscriptToken[], quote: string): TranscriptEvidenceMatch {
  const searchIndex = buildSearchIndex(tokens);
  const match = exactMatchEvidence(quote, searchIndex);

  if (!match) {
    return {
      quote,
      matchedText: null,
      startMs: null,
      endMs: null,
      startTokenIndex: null,
      endTokenIndex: null,
      matchKind: "missing"
    };
  }

  const charToToken =
    match.matchKind === "exact"
      ? searchIndex.normalizedCharToToken
      : searchIndex.punctuationInsensitiveCharToToken;
  const startTokenIndex = charToToken[match.startChar];
  const endTokenIndex = charToToken[Math.max(match.endCharExclusive - 1, match.startChar)];

  return {
    quote,
    matchedText: buildMatchedText(tokens, startTokenIndex, endTokenIndex),
    startMs: tokens[startTokenIndex]?.startMs ?? null,
    endMs: tokens[endTokenIndex]?.endMs ?? null,
    startTokenIndex,
    endTokenIndex,
    matchKind: match.matchKind
  };
}
