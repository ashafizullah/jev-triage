/**
 * Minimal Octokit double covering only the endpoints the pipeline touches.
 * Deliberately untyped (`any`) so tests stay readable; cast at the call site.
 */

export interface MockComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

export interface MockOctokitState {
  labels: string[];
  comments: MockComment[];
  closed: boolean;
  assigned: string[];
  issue: Record<string, unknown>;
  pullRequest: Record<string, unknown> | null;
  files: Array<{ filename: string; additions: number; deletions: number }>;
  candidateItems: Array<Record<string, unknown>>;
  repoLabels: Array<{ name: string }>;
  contributors: Array<{ login: string }>;
  permission: string;
  configFile: string | null;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
}

function initialState(overrides: Partial<MockOctokitState>): MockOctokitState {
  return {
    labels: [],
    comments: [],
    closed: false,
    assigned: [],
    issue: {
      number: 42,
      title: "Crash when saving",
      body: "Steps to reproduce: open the app and save.",
      html_url: "https://github.com/acme/demo/issues/42",
      created_at: "2026-09-01T00:00:00Z",
      user: { login: "reporter" },
      author_association: "NONE",
      labels: [],
    },
    pullRequest: null,
    files: [],
    candidateItems: [],
    repoLabels: [],
    contributors: [],
    permission: "write",
    configFile: null,
    calls: [],
    ...overrides,
  };
}

export function createMockOctokit(stateOverrides: Partial<MockOctokitState> = {}) {
  const state = initialState(stateOverrides);
  let nextCommentId = 1000;

  const record = (method: string, params: Record<string, unknown> = {}) => {
    state.calls.push({ method, params });
  };

  const octokit = {
    state,
    async paginate(fn: (params: any) => Promise<{ data: unknown }>, params: any = {}) {
      const result = await fn({ ...params, per_page: 100 });
      return result.data;
    },
    rest: {
      issues: {
        async get(params: any) {
          record("issues.get", params);
          const labels = state.labels.map((name) => ({ name }));
          if (state.pullRequest) {
            return { data: { ...state.pullRequest, labels } };
          }
          return { data: { ...state.issue, labels } };
        },
        async addLabels(params: any) {
          record("issues.addLabels", params);
          for (const label of params.labels as string[]) {
            if (!state.labels.includes(label)) state.labels.push(label);
          }
          return { data: [] };
        },
        async removeLabel(params: any) {
          record("issues.removeLabel", params);
          state.labels = state.labels.filter((label) => label !== params.name);
          return { data: [] };
        },
        async listComments(params: any) {
          record("issues.listComments", params);
          return { data: state.comments };
        },
        async createComment(params: any) {
          record("issues.createComment", params);
          nextCommentId += 1;
          const comment: MockComment = {
            id: nextCommentId,
            body: params.body,
            user: { login: "jev-triage[bot]", type: "Bot" },
          };
          state.comments.push(comment);
          return { data: comment };
        },
        async updateComment(params: any) {
          record("issues.updateComment", params);
          const target = state.comments.find((comment) => comment.id === params.comment_id);
          if (target) target.body = params.body;
          return { data: target ?? { id: params.comment_id, body: params.body } };
        },
        async listForRepo(params: any) {
          record("issues.listForRepo", params);
          return { data: state.candidateItems };
        },
        async listLabelsForRepo(params: any) {
          record("issues.listLabelsForRepo", params);
          return { data: state.repoLabels };
        },
        async createLabel(params: any) {
          record("issues.createLabel", params);
          state.repoLabels.push({ name: params.name });
          return { data: { name: params.name, color: params.color } };
        },
        async update(params: any) {
          record("issues.update", params);
          if (params.state === "closed") state.closed = true;
          return { data: { ...state.issue, state: params.state } };
        },
        async addAssignees(params: any) {
          record("issues.addAssignees", params);
          state.assigned.push(...(params.assignees as string[]));
          return { data: {} };
        },
      },
      pulls: {
        async get(params: any) {
          record("pulls.get", params);
          return { data: { ...state.pullRequest, labels: state.labels.map((name) => ({ name })) } };
        },
        async listFiles(params: any) {
          record("pulls.listFiles", params);
          return { data: state.files };
        },
      },
      repos: {
        async getContent(params: any) {
          record("repos.getContent", params);
          if (state.configFile === null) {
            throw Object.assign(new Error("Not Found"), { status: 404 });
          }
          return {
            data: {
              type: "file",
              content: Buffer.from(state.configFile, "utf8").toString("base64"),
            },
          };
        },
        async listContributors() {
          record("repos.listContributors");
          return { data: state.contributors };
        },
        async getCollaboratorPermissionLevel(params: any) {
          record("repos.getCollaboratorPermissionLevel", params);
          return { data: { permission: state.permission } };
        },
      },
      search: {
        async issuesAndPullRequests(params: any) {
          record("search.issuesAndPullRequests", params);
          return { data: { total_count: 5 } };
        },
      },
      apps: {
        async getAuthenticated() {
          record("apps.getAuthenticated");
          return { data: { slug: "jev-triage" } };
        },
      },
    },
  };

  return octokit;
}
