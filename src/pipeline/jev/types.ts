import type { Questions } from "@typesafe-ai/sdk";

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  noul: number;
}

export interface SpamSignals {
  promotional: number;
  offTopic: number;
  abusive: number;
}

/** Answers from fan-out #1, normalised and validated. */
export interface TriageAnswers {
  category: ChoiceAnswer;
  impact: ScoreAnswer;
  infoCompleteness: ChoiceAnswer;
  spam: SpamSignals;
  needsHumanReview: number;
  extraLabel: ChoiceAnswer | null;
  reviewer: ChoiceAnswer | null;
}

export interface DuplicateCandidateScore {
  number: number;
  title: string;
  score: number;
}

export interface DuplicateResult {
  bestScore: number;
  bestNumber: number | null;
  candidates: DuplicateCandidateScore[];
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JevCallResult {
  model: string;
  answers: Record<string, unknown>;
  usage: JevUsage;
  latencyMs: number;
  requestId?: string;
  estimatedTokens: number;
}

export interface JevRequest {
  state: unknown;
  questions: Questions;
  /** Overrides the client default model. */
  model?: string;
}

/** Minimally-typed seam so tests can run the pipeline without network access. */
export interface JevClient {
  systemOne(request: JevRequest): Promise<JevCallResult>;
}
