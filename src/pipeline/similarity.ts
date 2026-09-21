/**
 * Deterministic lexical prefilter used before calling Jev.
 *
 * Jev is cheap, but a repo can have hundreds of open issues; comparing every pair
 * would be pointless work. We rank candidates with tf-idf cosine on title/body plus
 * a trigram overlap on titles, then let Jev verify only the top few.
 */

export interface SimilarityDocument {
  title: string;
  body: string;
}

export interface ScoredCandidate<T> {
  candidate: T;
  score: number;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "any",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "have",
  "this",
  "that",
  "with",
  "from",
  "when",
  "what",
  "which",
  "will",
  "would",
  "there",
  "their",
  "them",
  "then",
  "than",
  "some",
  "such",
  "only",
  "also",
  "into",
  "does",
  "doing",
  "done",
  "been",
  "were",
  "being",
  "should",
  "could",
  "about",
  "after",
  "before",
  "because",
  "while",
  "where",
  "please",
  "help",
  "issue",
  "error",
  "using",
  "use",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/** tf-idf vectors for a small corpus (the query plus every candidate). */
function vectorize(documents: string[]): Map<string, number>[] {
  const tokenized = documents.map(tokenize);

  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const total = documents.length || 1;
  return tokenized.map((tokens) => {
    const vector = new Map<string, number>();
    for (const [term, count] of termFrequency(tokens)) {
      const idf = Math.log((total + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
      vector.set(term, count * idf);
    }
    return vector;
  });
}

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];

  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += weight * other;
  }
  if (dot === 0) return 0;

  let normA = 0;
  for (const weight of a.values()) normA += weight * weight;
  let normB = 0;
  for (const weight of b.values()) normB += weight * weight;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function trigrams(text: string): Set<string> {
  const normalized = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i += 1) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export const TITLE_COSINE_WEIGHT = 0.5;
export const BODY_COSINE_WEIGHT = 0.3;
export const TITLE_TRIGRAM_WEIGHT = 0.2;

/**
 * Ranks candidates against the query. Corpus-level idf means the result is
 * relative to the candidate set, which is exactly how it is used downstream.
 */
export function rankCandidates<T extends SimilarityDocument>(
  query: SimilarityDocument,
  candidates: T[],
  topK: number,
): ScoredCandidate<T>[] {
  if (candidates.length === 0 || topK <= 0) return [];

  const titleVectors = vectorize([query.title, ...candidates.map((c) => c.title)]);
  const bodyVectors = vectorize([query.body, ...candidates.map((c) => c.body)]);

  const queryTitleVector = titleVectors[0];
  const queryBodyVector = bodyVectors[0];
  const queryTrigrams = trigrams(query.title);

  const scored = candidates.map((candidate, index) => {
    const titleCosine = cosineSimilarity(
      queryTitleVector ?? new Map(),
      titleVectors[index + 1] ?? new Map(),
    );
    const bodyCosine = cosineSimilarity(
      queryBodyVector ?? new Map(),
      bodyVectors[index + 1] ?? new Map(),
    );
    const titleTrigram = jaccard(queryTrigrams, trigrams(candidate.title));

    const score =
      TITLE_COSINE_WEIGHT * titleCosine +
      BODY_COSINE_WEIGHT * bodyCosine +
      TITLE_TRIGRAM_WEIGHT * titleTrigram;

    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title));
  return scored.slice(0, topK);
}
