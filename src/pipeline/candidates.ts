import type { ItemType } from "../config/schema";
import type { Octokit, RepoRef } from "../github/types";
import type { SimilarityDocument } from "./similarity";

export interface CandidateItem extends SimilarityDocument {
  number: number;
  type: ItemType;
  state: string;
  createdAt: string;
}

export interface FetchCandidatesOptions {
  excludeNumber: number;
  /** Only items of the same kind are compared, to avoid issue/PR cross-matches. */
  type: ItemType;
  poolSize: number;
  state: "open" | "all";
  /**
   * ISO timestamp of the item being triaged. Candidates created at or after it are
   * dropped: a duplicate should point at an older report, never at a newer one.
   */
  excludeCreatedAtOrAfter?: string;
}

/**
 * Pulls a bounded pool of comparable items with a single API call. Pagination is
 * intentionally avoided: the lexical prefilter only needs a recent sample, and
 * keeping this to one request keeps triage latency low.
 */
export async function fetchCandidates(
  octokit: Octokit,
  ref: RepoRef,
  options: FetchCandidatesOptions,
): Promise<CandidateItem[]> {
  const perPage = Math.min(Math.max(options.poolSize, 1), 100);

  const { data } = await octokit.rest.issues.listForRepo({
    owner: ref.owner,
    repo: ref.repo,
    state: options.state === "all" ? "all" : "open",
    sort: "created",
    direction: "desc",
    per_page: perPage,
  });

  const candidates: CandidateItem[] = [];
  for (const item of data) {
    if (item.number === options.excludeNumber) continue;
    const type: ItemType = item.pull_request ? "pull_request" : "issue";
    if (type !== options.type) continue;

    const createdAt = item.created_at ?? "";
    // ISO 8601 UTC timestamps from GitHub compare correctly as strings.
    if (options.excludeCreatedAtOrAfter && createdAt >= options.excludeCreatedAtOrAfter) continue;

    candidates.push({
      number: item.number,
      type,
      state: item.state,
      createdAt,
      title: item.title ?? "",
      body: item.body ?? "",
    });
  }

  return candidates;
}
