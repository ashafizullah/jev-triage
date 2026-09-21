import { TypeSafeClient } from "@typesafe-ai/sdk";
import { estimateTokens } from "./budget";
import type { JevCallResult, JevClient, JevRequest } from "./types";

export interface CreateJevClientOptions {
  apiKey?: string;
}

/**
 * Wraps the official TypeSafe SDK. The SDK already implements exponential backoff
 * for 429/529 responses, so we only add normalisation and timing here.
 *
 * Deliberately minimal: the base URL, log level and fallback model all come from the
 * SDK's own defaults and its TYPESAFE_* environment variables. The model for each request
 * is resolved separately and always passed explicitly.
 */
export function createJevClient(options: CreateJevClientOptions = {}): JevClient {
  const client = new TypeSafeClient({ apiKey: options.apiKey });

  return {
    async systemOne(request: JevRequest): Promise<JevCallResult> {
      const estimatedTokens = estimateTokens({
        state: request.state,
        questions: request.questions,
      });
      const startedAt = Date.now();

      const { data, requestId } = await client
        .systemOne(
          {
            state: request.state as never,
            questions: request.questions,
            model: request.model,
          },
          {},
        )
        .withResponse();

      return {
        model: data.model,
        answers: data.answers as Record<string, unknown>,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
        latencyMs: Date.now() - startedAt,
        requestId,
        estimatedTokens,
      };
    },
  };
}
