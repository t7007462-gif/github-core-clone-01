// store.ts — the forge's in-memory state: repositories, git objects, issues,
// pull requests, labels and comments, plus the deterministic clock and the
// GitHub-shaped serializers the REST / GraphQL / MCP surfaces share.

import {
  ZERO_OID,
  type GitObject,
  type ObjectType,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTree,
  storeObject,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_NAME = 'Ada Iversen';
export const DEFAULT_BRANCH = 'main';

export const DEFAULT_LABELS = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
] as const;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string; // base tip at creation time
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface FlatFile {
  oid: string;
  mode: string;
}

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  readonly repoList: Repo[] = [];
  private nextRepoId = 1;
  private issueIdSeq = 1;
  private commentIdSeq = 1;
  private pullIdSeq = 1;
  private tick = 0;
  private readonly baseEpoch: number;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00Z';
    const parsed = Date.parse(raw);
    this.baseEpoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1780000000;
  }

  /** Deterministic clock: base time plus one second per event, so two runs agree. */
  nowEpoch(): number {
    return this.baseEpoch + this.tick;
  }

  nowIso(): string {
    const epoch = this.nowEpoch();
    this.tick += 1;
    return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** Advance the clock without stamping anything (keeps ordering stable). */
  touch(): void {
    this.tick += 1;
  }

  viewer(): { login: string; id: number; name: string; email: string } {
    return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo {
    const createdAt = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      nodeId: '',
      name,
      owner: VIEWER_LOGIN,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      createdAt,
      updatedAt: createdAt,
      pushedAt: createdAt,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    repo.nodeId = Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
    for (const label of DEFAULT_LABELS) {
      repo.labels.set(label.name, { ...label });
    }
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const repo = this.repos.get(key);
    if (!repo) return false;
    this.repos.delete(key);
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
    return true;
  }

  nextIssueId(): number {
    return this.issueIdSeq++;
  }

  nextCommentId(): number {
    return this.commentIdSeq++;
  }

  nextPullId(): number {
    return this.pullIdSeq++;
  }

  // -----------------------------------------------------------------------------------------
  // git helpers
  // -----------------------------------------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, FlatFile>()): Map<string, FlatFile> {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  /** Flatten the tree of a commit (empty map when the repo is unborn). */
  filesAtCommit(repo: Repo, commitOid: string | undefined): Map<string, FlatFile> {
    if (!commitOid) return new Map();
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(object.data).tree);
  }

  /** Build (and store) a tree object from a flat file map. */
  buildTreeFromFiles(repo: Repo, files: Map<string, FlatFile>): string {
    const build = (paths: Array<[string, FlatFile]>): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Array<[string, FlatFile]>>();
      for (const [path, file] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: path, oid: file.oid });
        } else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          if (!dirs.has(dir)) dirs.set(dir, []);
          dirs.get(dir)!.push([rest, file]);
        }
      }
      for (const [dir, children] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(children) });
      }
      return storeObject(repo.objects, 'tree', buildTree(entries));
    };
    return build([...files.entries()]);
  }

  /** Create a commit object (stored) and return its oid. */
  createCommit(
    repo: Repo,
    args: { tree: string; parents: readonly string[]; message: string; authorName?: string; authorEmail?: string },
  ): string {
    const epoch = this.nowEpoch();
    const author = {
      name: args.authorName ?? VIEWER_NAME,
      email: args.authorEmail ?? VIEWER_EMAIL,
      timestamp: epoch,
    };
    const data = buildCommit({
      tree: args.tree,
      parents: args.parents,
      author,
      committer: author,
      message: args.message,
    });
    return storeObject(repo.objects, 'commit', data);
  }

  /** Commit a set of file changes (path -> blob oid/mode, null to delete) onto a branch. */
  commitFileChanges(
    repo: Repo,
    branch: string,
    changes: Map<string, FlatFile | null>,
    message: string,
  ): { commit: string; tree: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const files = this.filesAtCommit(repo, tip);
    for (const [path, change] of changes) {
      if (change === null) files.delete(path);
      else files.set(path, change);
    }
    const tree = this.buildTreeFromFiles(repo, files);
    const commit = this.createCommit(repo, {
      tree,
      parents: tip ? [tip] : [],
      message,
    });
    repo.refs.set(ref, commit);
    repo.updatedAt = this.nowIso();
    repo.pushedAt = repo.updatedAt;
    return { commit, tree };
  }

  /** List commit oids reachable from a tip, newest first (first-parent walk order). */
  listCommits(repo: Repo, tip: string | undefined, limit = 100): string[] {
    if (!tip) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** Diff two trees; paths present in head only are added, in base only removed. */
  diffTrees(
    repo: Repo,
    baseCommit: string | undefined,
    headCommit: string | undefined,
  ): Array<{ path: string; status: 'added' | 'removed' | 'modified'; baseOid?: string; headOid?: string }> {
    const base = this.filesAtCommit(repo, baseCommit);
    const head = this.filesAtCommit(repo, headCommit);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const diff: Array<{ path: string; status: 'added' | 'removed' | 'modified'; baseOid?: string; headOid?: string }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (!b && h) diff.push({ path, status: 'added', headOid: h.oid });
      else if (b && !h) diff.push({ path, status: 'removed', baseOid: b.oid });
      else if (b && h && b.oid !== h.oid) diff.push({ path, status: 'modified', baseOid: b.oid, headOid: h.oid });
    }
    return diff;
  }

  /** Reachable object oids from a set of tips. */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable((oid) => repo.objects.get(oid), tips);
  }

  objectType(repo: Repo, oid: string): ObjectType | undefined {
    return repo.objects.get(oid)?.type;
  }
}

// -------------------------------------------------------------------------------------------
// line diff (for pull request file stats)
// -------------------------------------------------------------------------------------------

export interface LineStats {
  additions: number;
  deletions: number;
}

export function lineDiff(oldText: string, newText: string): LineStats {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // LCS on lines (files here are small)
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += m - i;
  additions += n - j;
  return { additions, deletions };
}

// -------------------------------------------------------------------------------------------
// serializers (GitHub-shaped JSON)
// -------------------------------------------------------------------------------------------

export function repoUrl(owner: string, name: string): string {
  return `https://api.github.com/repos/${owner}/${name}`;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', html_url: `https://github.com/${repo.owner}` },
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(repo.owner, repo.name),
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: 0,
    node_id: '',
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}`,
    repository_url: repoUrl(repo.owner, repo.name),
    labels_url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}/labels{/name}`,
    comments_url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}/comments`,
    events_url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    body: issue.body,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}`,
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`, 'utf8').toString('base64'),
    user: { login: comment.authorLogin, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    body: comment.body,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    url: `${repoUrl(repo.owner, repo.name)}/pulls/${pull.number}`,
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: null,
    mergeable_state: 'unknown',
    merge_method: 'squash',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: VIEWER_LOGIN }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: VIEWER_LOGIN }, repo: repoJson(repo) },
    author_association: 'OWNER',
  };
}

export function blobShaOf(data: Buffer): string {
  return hashObject('blob', data);
}
