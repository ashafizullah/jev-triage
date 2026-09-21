import type { JevCallResult, JevClient, JevRequest } from "../../src/pipeline/jev/types";

export interface FakeJevOptions {
  /** Raw answer map for the classification fan-out. */
  triage?: Record<string, unknown>;
  /** Raw answer map for the duplicate fan-out, keyed as dup_1, dup_2, … */
  duplicates?: Record<string, unknown>;
  model?: string;
}

export const DEFAULT_TRIAGE_ANSWERS: Record<string, unknown> = {
  category: { type: "choice", choice: "bug", confidence: 0.95, probabilities: { bug: 0.95 } },
  impact: { type: "score", score: 2, confidence: 0.9, probabilities: { "2": 0.9 } },
  info_completeness: {
    type: "choice",
    choice: "complete",
    confidence: 0.9,
    probabilities: { complete: 0.9 },
  },
  spam_promotional: { type: "noul", noul: 0.02 },
  spam_off_topic: { type: "noul", noul: 0.02 },
  spam_abusive: { type: "noul", noul: 0.01 },
  needs_human_review: { type: "noul", noul: 0.05 },
};

/** Builds a Jev client double that never touches the network. */
export function createFakeJev(
  options: FakeJevOptions = {},
): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];

  return {
    requests,
    async systemOne(request: JevRequest): Promise<JevCallResult> {
      requests.push(request);
      const isDuplicatePass = Object.keys(request.questions).some((key) => key.startsWith("dup_"));
      const answers = isDuplicatePass
        ? (options.duplicates ?? { dup_1: { type: "noul", noul: 0.1 } })
        : { ...DEFAULT_TRIAGE_ANSWERS, ...(options.triage ?? {}) };

      return {
        model: options.model ?? "jev-test-1.0.0",
        answers,
        usage: { inputTokens: 120, outputTokens: 12 },
        latencyMs: 42,
        estimatedTokens: 300,
      };
    },
  };
}
