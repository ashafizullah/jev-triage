import type { Octokit, RepoRef } from "../github/types";
import { issueUrl } from "../github/types";
import { type DiffSummary, type PreprocessedItem, makePreprocessedItem } from "./preprocess";

const MAX_DIFF_FILES = 100;

/**
 * A contributor is "first time" when this is the only issue/PR they have opened
 * in the repository. Search failures degrade to `false` rather than blocking triage.
 */
export async function isFirstTimeContributor(
  octokit: Octokit,
  ref: RepoRef,
  login: string,
): Promise<boolean> {
  try {
    const result = await octokit.rest.search.issuesAndPullRequests({
      q: `repo:${ref.owner}/${ref.repo} author:${login}`,
      per_page: 1,
    });
    return result.data.total_count <= 1;
  } catch {
    return false;
  }
}

export async function ingestIssue(
  octokit: Octokit,
  ref: RepoRef,
  number: number,
): Promise<PreprocessedItem> {
  const { data } = await octokit.rest.issues.get({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: number,
  });

  // The issues API also returns pull requests; delegate so PRs get diff metadata.
  if (data.pull_request) {
    return ingestPullRequest(octokit, ref, number);
  }

  const login = data.user?.login ?? "unknown";
  return makePreprocessedItem({
    type: "issue",
    number: data.number,
    title: data.title,
    body: data.body,
    url: data.html_url,
    createdAt: data.created_at,
    authorLogin: login,
    authorAssociation: data.author_association ?? "NONE",
    isFirstTimeContributor: await isFirstTimeContributor(octokit, ref, login),
    labels: data.labels
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter(Boolean),
  });
}

async function fetchDiff(octokit: Octokit, ref: RepoRef, number: number): Promise<DiffSummary> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: number,
    per_page: 100,
  });

  const picked = files.slice(0, MAX_DIFF_FILES);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return {
    files: picked.map((file) => ({
      filename: file.filename,
      additions: file.additions,
      deletions: file.deletions,
    })),
    additions,
    deletions,
    changedFileCount: files.length,
  };
}

export async function ingestPullRequest(
  octokit: Octokit,
  ref: RepoRef,
  number: number,
): Promise<PreprocessedItem> {
  const [{ data }, diff] = await Promise.all([
    octokit.rest.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: number }),
    fetchDiff(octokit, ref, number).catch(() => null),
  ]);

  const login = data.user?.login ?? "unknown";
  return makePreprocessedItem({
    type: "pull_request",
    number: data.number,
    title: data.title,
    body: data.body,
    url: data.html_url || issueUrl(ref, data.number),
    createdAt: data.created_at,
    authorLogin: login,
    authorAssociation: data.author_association ?? "NONE",
    isFirstTimeContributor: await isFirstTimeContributor(octokit, ref, login),
    labels: data.labels
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter(Boolean),
    isDraft: data.draft ?? false,
    diff,
  });
}

export async function ingestItem(
  octokit: Octokit,
  ref: RepoRef,
  type: "issue" | "pull_request",
  number: number,
): Promise<PreprocessedItem> {
  return type === "pull_request"
    ? ingestPullRequest(octokit, ref, number)
    : ingestIssue(octokit, ref, number);
}
