import type { ItemType } from "../config/schema";
import { cleanText, truncate } from "../util/markdown";

export interface ChangedFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  files: ChangedFile[];
  additions: number;
  deletions: number;
  changedFileCount: number;
}

export interface PreprocessedItem {
  type: ItemType;
  number: number;
  title: string;
  /** Markdown noise and template boilerplate already removed. */
  body: string;
  url: string;
  createdAt: string;
  author: {
    login: string;
    association: string;
    isFirstTimeContributor: boolean;
  };
  existingLabels: string[];
  isDraft: boolean;
  /** Only present for pull requests. */
  diff: DiffSummary | null;
}

export interface BuildStateOptions {
  bodyChars: number;
  /** Cap on files included in the PR diff block. */
  maxChangedFiles?: number;
}

/**
 * Structured state handed to Jev: only the context the questions actually need,
 * with the body truncated so a single request stays inside the token budget.
 */
export function buildState(
  item: PreprocessedItem,
  options: BuildStateOptions,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    item: {
      type: item.type,
      number: item.number,
      title: item.title,
      body: truncate(item.body, options.bodyChars),
      author: {
        login: item.author.login,
        association: item.author.association,
        first_time_contributor: item.author.isFirstTimeContributor,
      },
      existing_labels: item.existingLabels,
    },
  };

  if (item.type === "pull_request" && item.diff) {
    const maxFiles = options.maxChangedFiles ?? 30;
    (state.item as Record<string, unknown>).is_draft = item.isDraft;
    state.diff = {
      changed_file_count: item.diff.changedFileCount,
      total_additions: item.diff.additions,
      total_deletions: item.diff.deletions,
      changed_files: item.diff.files.slice(0, maxFiles).map((file) => file.filename),
    };
  }

  return state;
}

export function makePreprocessedItem(input: {
  type: ItemType;
  number: number;
  title: string;
  body: string | null | undefined;
  url: string;
  createdAt: string;
  authorLogin: string;
  authorAssociation: string;
  isFirstTimeContributor: boolean;
  labels: string[];
  isDraft?: boolean;
  diff?: DiffSummary | null;
}): PreprocessedItem {
  return {
    type: input.type,
    number: input.number,
    title: cleanText(input.title),
    body: cleanText(input.body),
    url: input.url,
    createdAt: input.createdAt,
    author: {
      login: input.authorLogin,
      association: input.authorAssociation,
      isFirstTimeContributor: input.isFirstTimeContributor,
    },
    existingLabels: input.labels,
    isDraft: input.isDraft ?? false,
    diff: input.diff ?? null,
  };
}
