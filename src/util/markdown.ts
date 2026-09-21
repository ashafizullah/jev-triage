const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const BADGE_LINE_RE = /^\s*\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*$/gm;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const CHECKBOX_RE = /^\s*[-*+]\s*\[[ xX]\]\s*/gm;
const CODE_FENCE_RE = /^```[^\n]*$/gm;
const PLACEHOLDER_RE = /^\s*(_?no response_?|n\/a|none|tidak ada)\s*$/gim;
const EXCESS_NEWLINES_RE = /\n{3,}/g;

/**
 * Lines that come from issue templates but carry no diagnostic value.
 * Matched case-insensitively against the whole line (markdown headings included).
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /^#{1,6}\s*is there an existing issue for this\??\s*$/i,
  /^#{1,6}\s*terms\s*$/i,
  /^\s*i have searched the existing issues\s*$/i,
  /^\s*i have read the (?:contributing )?guidelines\s*$/i,
  /^\s*(?:thanks|thank you)[^.!]*[.!]?\s*$/i,
  /^\s*please (?:fill|provide|describe)\b[^.]*[.?]?\s*$/i,
];

function dropBoilerplateLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !BOILERPLATE_PATTERNS.some((re) => re.test(line)))
    .join("\n");
}

/** Removes markdown noise while keeping the diagnostic content intact. */
export function cleanText(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = raw;
  text = text.replace(HTML_COMMENT_RE, "");
  text = text.replace(BADGE_LINE_RE, "");
  text = text.replace(IMAGE_RE, "");
  text = text.replace(LINK_RE, "$1");
  text = text.replace(HTML_TAG_RE, "");
  text = text.replace(CODE_FENCE_RE, "");
  text = text.replace(CHECKBOX_RE, "");
  text = text.replace(PLACEHOLDER_RE, "");
  text = dropBoilerplateLines(text);
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n");
  text = text.replace(EXCESS_NEWLINES_RE, "\n\n");
  return text.trim();
}

/** Hard character cap, used to keep a single request inside the Jev token budget. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  const slice = text.slice(0, maxChars - 1);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const cut = lastBreak > maxChars * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${cut.trimEnd()}…`;
}

/** Short excerpt for candidate comparison blocks. */
export function excerpt(text: string | null | undefined, maxChars: number): string {
  return truncate(cleanText(text).replace(/\s+/g, " "), maxChars);
}
