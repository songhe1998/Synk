export const META_COPY_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "original request", regex: /\boriginal request\b/i },
  { label: "the preview", regex: /\bthe preview\b/i },
  { label: "wireframe", regex: /\bwireframe\b/i },
  { label: "placeholder", regex: /\bplaceholder(?:s)?\b/i },
  { label: "dead-end mock", regex: /\bdead-?end mock\b/i },
  { label: "static poster", regex: /\bstatic poster\b/i },
  { label: "landing page instead of", regex: /\blanding page instead of\b/i },
  { label: "hero remains", regex: /\bhero remains\b/i },
  { label: "the composition", regex: /\bthe composition\b/i },
  { label: "buttons and navigation all lead", regex: /\bbuttons? and navigation all lead\b/i }
];

export function findMetaCopyPatternMatches(content: string) {
  const matches = new Set<string>();

  for (const pattern of META_COPY_PATTERNS) {
    if (pattern.regex.test(content)) {
      matches.add(pattern.label);
    }
  }

  return [...matches];
}
