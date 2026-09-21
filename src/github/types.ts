import type { ProbotOctokit } from "probot";

/** The authenticated Octokit instance Probot hands to every event handler. */
export type Octokit = ProbotOctokit;

export interface RepoRef {
  owner: string;
  repo: string;
}

export function repoFullName(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

export function issueUrl(ref: RepoRef, number: number): string {
  return `https://github.com/${ref.owner}/${ref.repo}/issues/${number}`;
}
