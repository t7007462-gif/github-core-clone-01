// app.ts — the forge's HTTP server: REST v3, GraphQL, MCP and git smart HTTP.
// One process, no dependencies: node:http + the store (store.ts) + git plumbing (git.ts).
// The token owner is the scenario viewer (adaiversen); any other owner answers 404, never 403.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ForgeStore, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, repoJson, labelJson, issueJson, commentJson, pullJson, lineDiff, type Repo, type Issue, type Pull } from './store.ts';
import {
  ZERO_OID,
  buildTree,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktBinary,
  pktFlush,
  pktLine,
  parsePktLines,
  readPack,
  storeObject,
  writePack,
  type GitObject,
  type ObjectType,
} from './git.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseQuery(search: string): Map<string, string> {
  const params = new Map<string, string>();
  const query = search.startsWith('?') ? search.slice(1) : search;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) params.set(decodeURIComponent(part), '');
    else params.set(decodeURIComponent(part.slice(0, eq)), decodeURIComponent(part.slice(eq + 1)));
  }
  return params;
}

interface PageParams {
  perPage: number;
  page: number;
}

function pageParams(query: Map<string, string>): PageParams {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(Math.max(perPageRaw, 1), 100) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : 1,
  };
}

function paginate<T>(items: readonly T[], params: PageParams): T[] {
  const start = (params.page - 1) * params.perPage;
  return items.slice(start, start + params.perPage);
}

export function createApp(): { store: ForgeStore; handler: (req: IncomingMessage, res: ServerResponse) => void } {
  const store = new ForgeStore();
  let requestCounter = 0;

  function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': `req-${++requestCounter}`,
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
    sendJson(res, status, { message, ...extra });
  }

  function sendText(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': `req-${++requestCounter}`,
    });
    res.end(body);
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const raw = await readBody(req);
    if (raw.length === 0) return undefined;
    try {
      return JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      const error = new Error('malformed JSON body') as Error & { status?: number };
      error.status = 400;
      throw error;
    }
  }

  function bearerToken(req: IncomingMessage): string | null {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length);
  }

  function authenticated(req: IncomingMessage): boolean {
    const token = bearerToken(req);
    if (token === null || token === '') return false;
    if (SHOP_TOKEN === '') return true;
    return token === SHOP_TOKEN;
  }

  /** The viewer the token belongs to; null when the request is unauthenticated. */
  function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!authenticated(req)) {
      sendError(res, 401, 'Bad credentials');
      return false;
    }
    return true;
  }

  function linkHeader(req: IncomingMessage, pathname: string, query: Map<string, string>, params: PageParams, totalPages: number): string | null {
    const host = req.headers.host ?? 'localhost';
    const protocol = 'http';
    const parts: string[] = [];
    const build = (page: number): string => {
      const q = new Map(query);
      q.set('page', String(page));
      q.set('per_page', String(params.perPage));
      const qs = [...q.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      return `${protocol}://${host}${pathname}?${qs}`;
    };
    if (params.page < totalPages) parts.push(`<${build(params.page + 1)}>; rel="next"`);
    if (params.page > 1) parts.push(`<${build(params.page - 1)}>; rel="prev"`);
    if (totalPages > 1) {
      parts.push(`<${build(1)}>; rel="first"`);
      parts.push(`<${build(totalPages)}>; rel="last"`);
    }
    return parts.length > 0 ? parts.join(', ') : null;
  }

  function pagedResponse<T>(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: Map<string, string>,
    items: readonly T[],
    toJson: (item: T) => unknown,
  ): void {
    const params = pageParams(query);
    const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
    const page = paginate(items, params);
    const headers: Record<string, string> = {};
    const link = linkHeader(req, pathname, query, params, totalPages);
    if (link) headers.link = link;
    sendJson(res, 200, page.map(toJson), headers);
  }

  /** Resolve a repo by owner/name; unknown owner or repo answers 404, never 403. */
  function resolveRepo(res: ServerResponse, owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    const repo = store.getRepo(owner, name);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    return repo;
  }

  // -------------------------------------------------------------------------------------------
  // REST: root / meta / user
  // -------------------------------------------------------------------------------------------

  async function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string, query: Map<string, string>): Promise<void> {
    const method = req.method ?? 'GET';
    const segments = pathname.split('/').filter((part) => part !== '');

    if (pathname === '/api/v3' || pathname === '/api/v3/') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, {
        current_user_url: 'https://api.github.com/user',
        repository_url: 'https://api.github.com/repos/{owner}/{repo}',
        rate_limit_url: 'https://api.github.com/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    if (pathname === '/api/v3/meta') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, {
        verifiable_password_authentication: true,
        ssh_key_fingerprints: {},
        hooks: [],
        web: [],
        api: [],
        git: [],
        packages: [],
        pages: [],
        importer: [],
        actions: [],
        dependabot: [],
        installed_version: SERVER_VERSION,
      });
      return;
    }

    if (pathname === '/api/v3/user' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
        avatar_url: '',
        type: 'User',
        site_admin: false,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        html_url: `https://github.com/${VIEWER_LOGIN}`,
        url: 'https://api.github.com/user',
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:00Z',
      });
      return;
    }

    if (pathname === '/api/v3/user/repos') {
      if (!requireAuth(req, res)) return;
      if (method === 'POST') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendError(res, 400, (error as Error).message);
          return;
        }
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        if (store.getRepo(VIEWER_LOGIN, body.name)) {
          sendError(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
          return;
        }
        const repo = store.createRepo(body.name, {
          description: typeof body.description === 'string' ? body.description : undefined,
          private: body.private === true,
        });
        sendJson(res, 201, repoJson(repo));
        return;
      }
      if (method === 'GET') {
        pagedResponse(req, res, pathname, query, store.repoList, (repo) => repoJson(repo));
        return;
      }
    }

    if (segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos' && segments.length >= 4) {
      const owner = decodeSegment(segments[3]);
      const name = decodeSegment(segments[4]);
      await handleRepoRest(req, res, pathname, query, segments, owner, name);
      return;
    }

    sendError(res, 404, 'Not Found');
  }

  // -----------------------------------------------------------------------------------------
  // REST: /api/v3/repos/{owner}/{repo}/...
  // -----------------------------------------------------------------------------------------

  async function handleRepoRest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: Map<string, string>,
    segments: string[],
    owner: string,
    name: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const rest = segments.slice(5); // after api/v3/repos/{owner}/{repo}

    if (!requireAuth(req, res)) return;

    // GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
    if (rest.length === 0) {
      const repo = resolveRepo(res, owner, name);
      if (!repo) return;
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendError(res, 400, (error as Error).message);
          return;
        }
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
          repo.updatedAt = store.nowIso();
        }
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
        res.end();
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    const repo = resolveRepo(res, owner, name);
    if (!repo) return;

    const readBodyOr400 = async (): Promise<unknown | null> => {
      try {
        return await readJsonBody(req);
      } catch (error) {
        sendError(res, 400, (error as Error).message);
        return null;
      }
    };

    // GET /branches
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      sendJson(res, 200, branches.map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID, url: `https://api.github.com/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID}` },
        protected: false,
      })));
      return;
    }

    // GET /commits[?sha=] and GET /commits/{sha}
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 1) {
        const ref = query.get('sha');
        let tip: string | undefined;
        if (ref) {
          tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? (isOid(ref) ? ref : undefined);
          if (!tip) {
            sendError(res, 404, 'Not Found');
            return;
          }
        } else {
          tip = repo.refs.get(store.headRef(repo));
        }
        const commits = store.listCommits(repo, tip, 100).map((oid) => {
          const object = repo.objects.get(oid)!;
          const commit = parseCommit(object.data);
          return {
            sha: oid,
            node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64'),
            commit: {
              author: { name: commit.author, email: '', date: '' },
              committer: { name: commit.committer, email: '', date: '' },
              message: commit.message,
              tree: { sha: commit.tree },
            },
            parents: commit.parents.map((sha) => ({ sha })),
            url: `https://api.github.com/repos/${owner}/${name}/commits/${oid}`,
            html_url: `https://github.com/${owner}/${name}/commit/${oid}`,
          };
        });
        sendJson(res, 200, commits);
        return;
      }
      if (rest.length === 2) {
        const sha = decodeSegment(rest[1]);
        const object = repo.objects.get(sha);
        if (!object || object.type !== 'commit') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const commit = parseCommit(object.data);
        sendJson(res, 200, {
          sha,
          commit: {
            author: { name: commit.author, email: '', date: '' },
            committer: { name: commit.committer, email: '', date: '' },
            message: commit.message,
            tree: { sha: commit.tree },
          },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        });
        return;
      }
    }

    // POST /git/refs, GET /git/refs[/...]
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = await readBodyOr400();
        if (body === null) return;
        if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string' || !isOid(body.sha)) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        if (repo.refs.has(body.ref)) {
          sendError(res, 422, 'Reference already exists');
          return;
        }
        if (!repo.objects.has(body.sha)) {
          sendError(res, 422, 'Object does not exist');
          return;
        }
        repo.refs.set(body.ref, body.sha);
        sendJson(res, 201, {
          ref: body.ref,
          node_id: Buffer.from(`Ref:${body.ref}`, 'utf8').toString('base64'),
          url: `https://api.github.com/repos/${owner}/${name}/git/refs/${encodeURIComponent(body.ref)}`,
          object: { sha: body.sha, type: repo.objects.get(body.sha)?.type ?? 'commit', url: `https://api.github.com/repos/${owner}/${name}/git/${body.sha}` },
        });
        return;
      }
      if (method === 'GET') {
        const refPath = rest.slice(2).map(decodeSegment).join('/');
        if (refPath === '') {
          sendJson(res, 200, [...repo.refs.entries()].map(([ref, sha]) => ({
            ref,
            node_id: Buffer.from(`Ref:${ref}`, 'utf8').toString('base64'),
            url: `https://api.github.com/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
            object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `https://api.github.com/repos/${owner}/${name}/git/${sha}` },
          })));
          return;
        }
        const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
        const sha = repo.refs.get(ref);
        if (!sha) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, {
          ref,
          node_id: Buffer.from(`Ref:${ref}`, 'utf8').toString('base64'),
          url: `https://api.github.com/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `https://api.github.com/repos/${owner}/${name}/git/${sha}` },
        });
        return;
      }
    }

    // POST /labels, GET /labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
        return;
      }
      if (method === 'POST') {
        const body = await readBodyOr400();
        if (body === null) return;
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        const existing = repo.labels.get(body.name);
        if (existing) {
          sendJson(res, 201, labelJson(existing));
          return;
        }
        const label = {
          name: body.name,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(label.name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
    }

    // Issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readBodyOr400();
          if (body === null) return;
          if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
            sendError(res, 422, 'Validation Failed');
            return;
          }
          const labelNames: string[] = Array.isArray(body.labels)
            ? body.labels.map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '')).filter(Boolean)
            : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label ${labelName} does not exist` }] });
              return;
            }
          }
          const createdAt = store.nowIso();
          const issue: Issue = {
            id: store.nextIssueId(),
            number: repo.nextIssueNumber++,
            title: body.title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels: labelNames,
            comments: [],
            createdAt,
            updatedAt: createdAt,
            closedAt: null,
          };
          repo.issues.set(issue.number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const key = sort === 'created' ? 'createdAt' : 'updatedAt';
          issues.sort((a, b) => {
            const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
          pagedResponse(req, res, pathname, query, issues, (issue) => issueJson(repo, issue));
          return;
        }
      }
      const issueNumber = Number.parseInt(rest[1] ?? '', 10);
      const issue = Number.isFinite(issueNumber) ? repo.issues.get(issueNumber) : undefined;
      if (rest.length === 2) {
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const body = await readBodyOr400();
          if (body === null) return;
          if (isRecord(body)) {
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (body.state === 'open' || body.state === 'closed') {
              issue.state = body.state;
              issue.closedAt = body.state === 'closed' ? store.nowIso() : null;
            }
            issue.updatedAt = store.nowIso();
          }
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return;
        }
        if (method === 'POST') {
          const body = await readBodyOr400();
          if (body === null) return;
          if (!isRecord(body) || typeof body.body !== 'string') {
            sendError(res, 422, 'Validation Failed');
            return;
          }
          const createdAt = store.nowIso();
          const comment = {
            id: store.nextCommentId(),
            body: body.body,
            createdAt,
            updatedAt: createdAt,
            authorLogin: VIEWER_LOGIN,
          };
          issue.comments.push(comment);
          issue.updatedAt = store.nowIso();
          sendJson(res, 201, commentJson(repo, issue, comment));
          return;
        }
      }
    }

    // Pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readBodyOr400();
          if (body === null) return;
          if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
            sendError(res, 422, 'Validation Failed');
            return;
          }
          const headRef = `refs/heads/${body.head}`;
          const baseRef = `refs/heads/${body.base}`;
          const headSha = repo.refs.get(headRef);
          const baseSha = repo.refs.get(baseRef);
          if (!headSha || !baseSha) {
            sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'head or base branch does not exist' }] });
            return;
          }
          const createdAt = store.nowIso();
          const pull: Pull = {
            id: store.nextPullId(),
            number: repo.nextPullNumber++,
            title: body.title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            headRef: body.head,
            headSha,
            baseRef: body.base,
            baseSha,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdAt,
            updatedAt: createdAt,
            closedAt: null,
          };
          repo.pulls.set(pull.number, pull);
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          pagedResponse(req, res, pathname, query, pulls, (pull) => pullJson(repo, pull));
          return;
        }
      }
      const pullNumber = Number.parseInt(rest[1] ?? '', 10);
      const pull = Number.isFinite(pullNumber) ? repo.pulls.get(pullNumber) : undefined;
      if (rest.length === 2) {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (method === 'PATCH') {
          const body = await readBodyOr400();
          if (body === null) return;
          if (isRecord(body)) {
            if (typeof body.title === 'string') pull.title = body.title;
            if (typeof body.body === 'string') pull.body = body.body;
            if (body.state === 'closed') {
              pull.state = 'closed';
              pull.closedAt = store.nowIso();
            }
            pull.updatedAt = store.nowIso();
          }
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullFiles(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (pull.state !== 'open') {
          sendError(res, 405, 'Pull Request is not mergeable');
          return;
        }
        const conflict = pullConflict(repo, pull);
        if (conflict) {
          sendError(res, 405, 'Merge conflict');
          return;
        }
        const merged = mergePull(repo, pull);
        sendJson(res, 200, { sha: merged, merged: true, message: `${pull.title} (#${pull.number})` });
        return;
      }
    }

    // Contents
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map(decodeSegment).join('/');
      if (method === 'GET') {
        handleContentsGet(req, res, repo, owner, name, contentPath, query);
        return;
      }
      if (method === 'PUT') {
        const body = await readBodyOr400();
        if (body === null) return;
        handleContentsPut(req, res, repo, contentPath, body);
        return;
      }
      if (method === 'DELETE') {
        const body = await readBodyOr400();
        if (body === null) return;
        handleContentsDelete(req, res, repo, contentPath, body);
        return;
      }
    }

    sendError(res, 404, 'Not Found');
  }

  // -----------------------------------------------------------------------------------------
  // Contents API helpers and pull-request merge helpers
  // -----------------------------------------------------------------------------------------

  /** Resolve a ?ref= value (branch name, full ref or commit oid) to a commit oid. */
  function resolveRefToCommit(repo: Repo, ref: string | undefined): string | undefined {
    if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
    if (isOid(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  function handleContentsGet(
    _req: IncomingMessage,
    res: ServerResponse,
    repo: Repo,
    owner: string,
    name: string,
    contentPath: string,
    query: Map<string, string>,
  ): void {
    const commitOid = resolveRefToCommit(repo, query.get('ref'));
    if (!commitOid) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const files = store.filesAtCommit(repo, commitOid);
    if (contentPath === '') {
      // root directory listing
      const entries = rootListing(repo, files, '', owner, name);
      sendJson(res, 200, entries);
      return;
    }
    const file = files.get(contentPath);
    if (file) {
      const object = repo.objects.get(file.oid);
      const content = object ? object.data : Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        content: content.toString('base64'),
        sha: file.oid,
        url: `https://api.github.com/repos/${owner}/${name}/contents/${contentPath}`,
        git_url: `https://api.github.com/repos/${owner}/${name}/git/blobs/${file.oid}`,
        html_url: `https://github.com/${owner}/${name}/blob/${repo.defaultBranch}/${contentPath}`,
        download_url: `https://raw.githubusercontent.com/${owner}/${name}/${repo.defaultBranch}/${contentPath}`,
      });
      return;
    }
    // directory listing at a prefix
    const prefix = `${contentPath}/`;
    const hasChildren = [...files.keys()].some((path) => path.startsWith(prefix));
    if (!hasChildren) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, rootListing(repo, files, contentPath, owner, name));
  }

  function rootListing(repo: Repo, files: Map<string, { oid: string; mode: string }>, dirPath: string, owner: string, name: string): Array<Record<string, unknown>> {
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    const children = new Map<string, { type: 'file' | 'dir'; oid: string; mode: string; size: number }>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { type: 'file', oid: file.oid, mode: file.mode, size: repo.objects.get(file.oid)?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) children.set(dir, { type: 'dir', oid: '', mode: '40000', size: 0 });
      }
    }
    return [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([childName, child]) => {
        const childPath = prefix + childName;
        return {
          type: child.type,
          size: child.size,
          name: childName,
          path: childPath,
          sha: child.oid,
          url: `https://api.github.com/repos/${owner}/${name}/contents/${childPath}`,
          git_url: `https://api.github.com/repos/${owner}/${name}/git/${child.type === 'dir' ? 'trees' : 'blobs'}/${child.oid}`,
          html_url: `https://github.com/${owner}/${name}/${child.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}`,
          download_url: child.type === 'file' ? `https://raw.githubusercontent.com/${owner}/${name}/${repo.defaultBranch}/${childPath}` : null,
        };
      });
  }

  function handleContentsPut(
    _req: IncomingMessage,
    res: ServerResponse,
    repo: Repo,
    contentPath: string,
    body: unknown,
  ): void {
    if (!isRecord(body) || typeof body.message !== 'string' || typeof body.content !== 'string') {
      sendError(res, 422, 'Validation Failed');
      return;
    }
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    if (!repo.refs.has(branchRef) && repo.refs.size > 0) {
      sendError(res, 422, 'Invalid branch');
      return;
    }
    let content: Buffer;
    try {
      content = Buffer.from(body.content, 'base64');
      // strict-ish check: re-encoding must round-trip (ignoring whitespace)
      const compact = body.content.replace(/\s+/g, '');
      if (compact !== '' && content.toString('base64') !== compact) {
        sendError(res, 400, 'Invalid base64 content');
        return;
      }
    } catch {
      sendError(res, 400, 'Invalid base64 content');
      return;
    }
    const tip = repo.refs.get(branchRef);
    const files = store.filesAtCommit(repo, tip);
    const existing = files.get(contentPath);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      if (typeof body.sha !== 'string') {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      if (body.sha !== existing!.oid) {
        sendError(res, 409, 'Conflict');
        return;
      }
    }
    const blobOid = storeObject(repo.objects, 'blob', content);
    const changes = new Map<string, { oid: string; mode: string } | null>();
    changes.set(contentPath, { oid: blobOid, mode: '100644' });
    const { commit } = store.commitFileChanges(repo, branch, changes, body.message);
    sendJson(res, isUpdate ? 200 : 201, {
      content: {
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        sha: blobOid,
        size: content.length,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${contentPath}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${contentPath}`,
        git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${contentPath}`,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: commit, message: body.message },
    });
  }

  function handleContentsDelete(
    _req: IncomingMessage,
    res: ServerResponse,
    repo: Repo,
    contentPath: string,
    body: unknown,
  ): void {
    if (!isRecord(body) || typeof body.message !== 'string') {
      sendError(res, 422, 'Validation Failed');
      return;
    }
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (!tip) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const files = store.filesAtCommit(repo, tip);
    const existing = files.get(contentPath);
    if (!existing) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendError(res, 409, 'Conflict');
      return;
    }
    const changes = new Map<string, { oid: string; mode: string } | null>();
    changes.set(contentPath, null);
    const { commit } = store.commitFileChanges(repo, branch, changes, body.message);
    sendJson(res, 200, { commit: { sha: commit, message: body.message } });
  }

  /** Files of a pull request: diff of its base tip against its head tip, with line stats. */
  function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const diff = store.diffTrees(repo, pull.baseSha, headTip);
    return diff.map((entry) => {
      let additions = 0;
      let deletions = 0;
      if (entry.status === 'added' && entry.headOid) {
        const data = repo.objects.get(entry.headOid)?.data ?? Buffer.alloc(0);
        additions = data.toString('utf8').split('\n').length;
        if (data.length > 0 && data[data.length - 1] === 0x0a) additions -= 1;
      } else if (entry.status === 'removed' && entry.baseOid) {
        const data = repo.objects.get(entry.baseOid)?.data ?? Buffer.alloc(0);
        deletions = data.toString('utf8').split('\n').length;
        if (data.length > 0 && data[data.length - 1] === 0x0a) deletions -= 1;
      } else if (entry.status === 'modified' && entry.baseOid && entry.headOid) {
        const stats = lineDiff(
          repo.objects.get(entry.baseOid)?.data.toString('utf8') ?? '',
          repo.objects.get(entry.headOid)?.data.toString('utf8') ?? '',
        );
        additions = stats.additions;
        deletions = stats.deletions;
      }
      return {
        sha: entry.headOid ?? entry.baseOid ?? '',
        filename: entry.path,
        status: entry.status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      };
    });
  }

  /** True when the PR's changed files were also changed on the base since it was opened. */
  function pullConflict(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip || baseTip === pull.baseSha) return false;
    const prDiff = store.diffTrees(repo, pull.baseSha, repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha);
    const baseDiff = store.diffTrees(repo, pull.baseSha, baseTip);
    const baseChanged = new Map(baseDiff.map((entry) => [entry.path, entry]));
    for (const entry of prDiff) {
      const baseEntry = baseChanged.get(entry.path);
      if (!baseEntry) continue;
      // changed on both sides with different results -> conflict
      if (baseEntry.headOid !== entry.headOid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch; returns the merge commit oid. */
  function mergePull(repo: Repo, pull: Pull): string {
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.refs.get(baseRef) ?? pull.baseSha;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const files = store.filesAtCommit(repo, baseTip);
    const headFiles = store.filesAtCommit(repo, headTip);
    const diff = store.diffTrees(repo, pull.baseSha, headTip);
    for (const entry of diff) {
      if (entry.status === 'removed') files.delete(entry.path);
      else if (entry.headOid) {
        const headEntry = headFiles.get(entry.path);
        files.set(entry.path, { oid: entry.headOid, mode: headEntry?.mode ?? '100644' });
      }
    }
    const tree = store.buildTreeFromFiles(repo, files);
    const commit = store.createCommit(repo, {
      tree,
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})`,
    });
    repo.refs.set(baseRef, commit);
    const mergedAt = store.nowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = mergedAt;
    pull.mergeCommitSha = commit;
    pull.closedAt = mergedAt;
    pull.updatedAt = mergedAt;
    repo.updatedAt = mergedAt;
    repo.pushedAt = mergedAt;
    return commit;
  }

  // -----------------------------------------------------------------------------------------
  // git smart HTTP: /{owner}/{repo}.git/info/refs and /git-upload-pack / git-receive-pack
  // -----------------------------------------------------------------------------------------

  const GIT_AGENT = 'forge/1.0.0';
  const UPLOAD_CAPS = `agent=${GIT_AGENT} ls-refs=unborn fetch=shallow wait-for-done object-format=sha1`;
  const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${GIT_AGENT} symref=HEAD:refs/heads/main`;

  function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Peeled commit oid for an annotated tag object, else null. */
  function peelTag(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tag') return null;
    const tag = parseTag(object.data);
    let target = tag.object;
    // peel nested tags
    for (let depth = 0; depth < 10; depth += 1) {
      const next = repo.objects.get(target);
      if (!next || next.type !== 'tag') break;
      target = parseTag(next.data).object;
    }
    return target;
  }

  function uploadPackAdvertisement(repo: Repo): Buffer {
    const parts: Buffer[] = [];
    parts.push(pktLine('# service=git-upload-pack\n'));
    parts.push(pktFlush());
    parts.push(pktLine('version 2\n'));
    for (const cap of ['agent=forge/1.0.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1']) {
      parts.push(pktLine(`${cap}\n`));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  function receivePackAdvertisement(repo: Repo): Buffer {
    const parts: Buffer[] = [];
    parts.push(pktLine('# service=git-receive-pack\n'));
    parts.push(pktFlush());
    const refs = sortedRefs(repo);
    const headTip = repo.refs.get(store.headRef(repo)) ?? ZERO_OID;
    const firstLine = headTip === ZERO_OID
      ? `${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`
      : `${headTip} HEAD\0${RECEIVE_CAPS}\n`;
    parts.push(pktLine(firstLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peelTag(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
    const parts: Buffer[] = [];
    const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
    const headTip = repo.refs.get(store.headRef(repo));
    const headAttrs: string[] = [];
    if (args.symrefs) headAttrs.push('symref-target:refs/heads/main');
    if (!headTip) {
      if (keep('HEAD')) parts.push(pktLine(`unborn HEAD${headAttrs.length ? ` ${headAttrs.join(' ')}` : ''}\n`));
    } else if (keep('HEAD')) {
      parts.push(pktLine(`${headTip} HEAD${headAttrs.length ? ` ${headAttrs.join(' ')}` : ''}\n`));
    }
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      const attrs: string[] = [];
      if (args.peel) {
        const peeled = peelTag(repo, ref.oid);
        if (peeled) attrs.push(`peeled:${peeled}`);
      }
      parts.push(pktLine(`${ref.oid} ${ref.name}${attrs.length ? ` ${attrs.join(' ')}` : ''}\n`));
    }
    if (args.unborn && !headTip) {
      // unborn default branch is already listed as HEAD above; nothing extra
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  /** Commit timestamps (committer) for deepen-since; parsed lazily. */
  function commitTimestamp(repo: Repo, oid: string): number {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return 0;
    const commit = parseCommit(object.data);
    const match = / (\d+) [+-]\d{4}$/.exec(commit.committer);
    return match ? Number.parseInt(match[1], 10) : 0;
  }

  function fetchResponse(repo: Repo, args: {
    wants: string[];
    haves: string[];
    shallow: string[];
    depth: number | null;
    deepenSince: number | null;
    deepenNot: string[];
  }): Buffer {
    // Peel wanted tags to their commits; keep the tag objects themselves in the pack.
    const extraObjects = new Set<string>();
    const wantCommits: string[] = [];
    for (const want of args.wants) {
      const object = repo.objects.get(want);
      if (!object) continue;
      if (object.type === 'tag') {
        extraObjects.add(want);
        const peeled = peelTag(repo, want);
        if (peeled) wantCommits.push(peeled);
      } else if (object.type === 'commit') {
        wantCommits.push(want);
      } else {
        extraObjects.add(want);
      }
    }

    // Included commits, with depth / deepen-since cutoffs.
    const included = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; distance: number }> = wantCommits.map((oid) => ({ oid, distance: 0 }));
    const seenDistance = new Map<string, number>();
    while (queue.length > 0) {
      const { oid, distance } = queue.shift()!;
      if (seenDistance.has(oid)) continue;
      seenDistance.set(oid, distance);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const excludedByDepth = args.depth !== null && distance >= args.depth;
      const excludedBySince = args.deepenSince !== null && commitTimestamp(repo, oid) < args.deepenSince;
      if (excludedByDepth || excludedBySince) continue;
      included.add(oid);
      const isBoundary = args.depth !== null && distance === args.depth - 1;
      const parentsExcluded = commit.parents.length > 0 && (args.depth !== null
        ? distance + 1 >= args.depth
        : args.deepenSince !== null
          ? commit.parents.some((parent) => commitTimestamp(repo, parent) < args.deepenSince!)
          : false);
      if (isBoundary || parentsExcluded) boundary.add(oid);
      for (const parent of commit.parents) {
        if (!seenDistance.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
      }
    }

    // Objects the client already holds (haves + deepen-not tips). A have is only
    // as deep as the client's shallow boundaries: never walk past a commit the
    // client named as shallow, or a deepen would exclude the parent it needs.
    const heldTips = [...args.haves, ...args.deepenNot.flatMap((ref) => {
      const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
      return tip ? [tip] : [];
    })];
    const held = new Set<string>();
    const heldQueue = [...heldTips];
    const heldSeen = new Set<string>();
    const heldTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tree' || held.has(current)) continue;
        held.add(current);
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else held.add(entry.oid);
        }
      }
    };
    while (heldQueue.length > 0) {
      const oid = heldQueue.shift()!;
      if (heldSeen.has(oid)) continue;
      heldSeen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        heldTree(parseCommit(object.data).tree);
        if (!args.shallow.includes(oid)) {
          for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
        }
      } else if (object.type === 'tag') {
        const target = peelTag(repo, oid);
        if (target) heldQueue.push(target);
      } else if (object.type === 'tree') {
        heldTree(oid);
      }
    }

    // The pack: included commits + their tree closure + extra objects, minus held.
    // (A tree closure walks trees only: a full reachable() here would leak the
    // parents a shallow fetch must not send.)
    const send = new Set<string>();
    const addTreeClosure = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tree' || send.has(current)) continue;
        send.add(current);
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else send.add(entry.oid);
        }
      }
    };
    const addCommitClosure = (commitOid: string): void => {
      const object = repo.objects.get(commitOid);
      if (!object || object.type !== 'commit') return;
      send.add(commitOid);
      addTreeClosure(parseCommit(object.data).tree);
    };
    for (const oid of included) addCommitClosure(oid);
    for (const oid of extraObjects) {
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') addCommitClosure(oid);
      else if (object.type === 'tag') {
        send.add(oid);
        const peeled = peelTag(repo, oid);
        if (peeled) addCommitClosure(peeled);
      } else if (object.type === 'tree') addTreeClosure(oid);
      else send.add(oid);
    }
    for (const oid of held) send.delete(oid);
    const objects: GitObject[] = [...send]
      .sort()
      .map((oid) => repo.objects.get(oid))
      .filter((object): object is GitObject => object !== undefined);
    const pack = writePack(objects);

    // Acknowledgments: ACK every have that is an ancestor of a want, then ready; else NAK.
    const wantReachable = store.reachable(repo, wantCommits);
    const common = args.haves.filter((have) => wantReachable.has(have));
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (common.length > 0) {
      for (const oid of [...new Set(common)].sort()) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(Buffer.from('0001', 'utf8')); // delim

    // Shallow info: new boundaries + old boundaries that are now interior.
    const unshallow: string[] = [];
    for (const old of args.shallow) {
      if (!included.has(old)) continue;
      const object = repo.objects.get(old);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0 || parents.every((parent) => included.has(parent))) unshallow.push(old);
    }
    const shallowLines = [...boundary].sort();
    if (shallowLines.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow.sort()) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'utf8')); // delim
    }

    // Packfile section, sideband band 1.
    parts.push(pktLine('packfile\n'));
    const CHUNK = 65500;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
      parts.push(pktBinary(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
    const body = await readBody(req);
    const packets = parsePktLines(body);
    let command = '';
    const args: string[] = [];
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      if (!afterDelim && text.startsWith('command=')) command = text.slice('command='.length).trim();
      else if (afterDelim) args.push(text.trim());
    }
    if (command === 'ls-refs') {
      const parsed = {
        peel: args.includes('peel'),
        symrefs: args.includes('symrefs'),
        unborn: args.includes('unborn'),
        prefixes: args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length)),
      };
      sendText(res, 200, lsRefsResponse(repo, parsed), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const parsed = {
        wants: [] as string[],
        haves: [] as string[],
        shallow: [] as string[],
        depth: null as number | null,
        deepenSince: null as number | null,
        deepenNot: [] as string[],
      };
      for (const arg of args) {
        if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) parsed.depth = Number.parseInt(arg.slice(7).trim(), 10);
        else if (arg.startsWith('deepen-since ')) parsed.deepenSince = Number.parseInt(arg.slice(13).trim(), 10);
        else if (arg.startsWith('deepen-not ')) parsed.deepenNot.push(arg.slice(11).trim());
      }
      for (const want of parsed.wants) {
        if (!repo.objects.has(want)) {
          sendText(res, 400, Buffer.from(`want ${want} not found`, 'utf8'), 'text/plain');
          return;
        }
      }
      sendText(res, 200, fetchResponse(repo, parsed), 'application/x-git-upload-pack-result');
      return;
    }
    sendText(res, 400, Buffer.from(`unknown command ${command}`, 'utf8'), 'text/plain');
  }

  async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
    const body = await readBody(req);
    const packets = parsePktLines(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let packStart = 0;
    // Find the flush packet that ends the command list; the pack follows it raw.
    let offset = 0;
    while (offset + 4 <= body.length) {
      const len = Number.parseInt(body.subarray(offset, offset + 4).toString('utf8'), 16);
      if (Number.isNaN(len)) break;
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      if (len < 4 || offset + len > body.length) break;
      const payload = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
      const nul = payload.indexOf('\0');
      const line = nul >= 0 ? payload.slice(0, nul) : payload;
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
      offset += len;
    }
    void packets;

    const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
    let unpackError: string | null = null;
    let packObjects: GitObject[] = [];
    if (packStart < body.length) {
      try {
        packObjects = readPack(body.subarray(packStart)).objects;
      } catch (error) {
        unpackError = (error as Error).message;
      }
    }
    if (!unpackError) {
      for (const object of packObjects) {
        if (!repo.objects.has(hashObject(object.type, object.data))) {
          repo.objects.set(hashObject(object.type, object.data), object);
        }
      }
    }
    for (const command of commands) {
      if (unpackError) {
        results.push({ ref: command.ref, ok: false, reason: unpackError });
        continue;
      }
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true });
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (!target) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== command.newOid) {
        const reachable = collectReachable((oid) => repo.objects.get(oid), [command.newOid]);
        if (!reachable.has(command.oldOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      repo.updatedAt = store.nowIso();
      repo.pushedAt = repo.updatedAt;
      results.push({ ref: command.ref, ok: true });
    }

    // report-status inside sideband band 1
    const inner: Buffer[] = [];
    if (unpackError) inner.push(pktLine(`unpack ${unpackError}\n`));
    else inner.push(pktLine('unpack ok\n'));
    for (const result of results) {
      inner.push(result.ok ? pktLine(`ok ${result.ref}\n`) : pktLine(`ng ${result.ref} ${result.reason ?? 'failed'}\n`));
    }
    inner.push(pktFlush());
    const innerBytes = Buffer.concat(inner);
    const outer: Buffer[] = [];
    const CHUNK = 65500;
    for (let offset = 0; offset < innerBytes.length; offset += CHUNK) {
      const slice = innerBytes.subarray(offset, Math.min(offset + CHUNK, innerBytes.length));
      outer.push(pktBinary(Buffer.concat([Buffer.from([1]), slice])));
    }
    outer.push(pktFlush());
    sendText(res, 200, Buffer.concat(outer), 'application/x-git-receive-pack-result');
  }

  async function handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, query: Map<string, string>): Promise<void> {
    const method = req.method ?? 'GET';
    const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
    if (!match) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const owner = decodeSegment(match[1]);
    const name = decodeSegment(match[2]);
    const tail = match[3];
    if (!requireAuth(req, res)) return;
    const repo = resolveRepo(res, owner, name);
    if (!repo) return;
    if (method === 'GET' && tail === 'info/refs') {
      const service = query.get('service');
      if (service === 'git-upload-pack') {
        sendText(res, 200, uploadPackAdvertisement(repo), 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendText(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendError(res, 400, 'Missing service');
      return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') {
      await handleUploadPack(req, res, repo);
      return;
    }
    if (method === 'POST' && tail === 'git-receive-pack') {
      await handleReceivePack(req, res, repo);
      return;
    }
    sendError(res, 404, 'Not Found');
  }

  // -----------------------------------------------------------------------------------------
  // GraphQL: a small parser and executor for the documents the suite sends.
  // -----------------------------------------------------------------------------------------

  type GqlValue =
    | { kind: 'variable'; name: string }
    | { kind: 'string'; value: string }
    | { kind: 'int'; value: number }
    | { kind: 'float'; value: number }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'null' }
    | { kind: 'enum'; value: string }
    | { kind: 'list'; values: GqlValue[] }
    | { kind: 'object'; fields: Record<string, GqlValue> };

  interface GqlField {
    alias?: string;
    name: string;
    args: Record<string, GqlValue>;
    selection?: GqlSelection[];
  }

  type GqlSelection =
    | { kind: 'field'; field: GqlField }
    | { kind: 'inline'; typeCondition?: string; selection: GqlSelection[] };

  interface GqlOperation {
    operation: 'query' | 'mutation';
    name?: string;
    variables: Record<string, GqlValue>;
    selection: GqlSelection[];
  }

  class GqlLexer {
    private pos = 0;
    private readonly text: string;
    constructor(text: string) {
      this.text = text;
    }

    private skipIgnored(): void {
      while (this.pos < this.text.length) {
        const ch = this.text[this.pos];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
          this.pos += 1;
        } else if (ch === '#') {
          while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        } else break;
      }
    }

    peek(): string {
      this.skipIgnored();
      return this.text[this.pos] ?? '';
    }

    /** The next token without consuming it (peek() only returns one character). */
    peekToken(): string {
      const saved = this.pos;
      const token = this.next();
      this.pos = saved;
      return token;
    }

    next(): string {
      this.skipIgnored();
      if (this.pos >= this.text.length) return '';
      const ch = this.text[this.pos];
      if ('{}()[]:!...@$&|= '.includes(ch) || ch === '.') {
        if (ch === '.' && this.text.slice(this.pos, this.pos + 3) === '...') {
          this.pos += 3;
          return '...';
        }
        this.pos += 1;
        return ch;
      }
      if (ch === '"') {
        let out = '';
        this.pos += 1;
        while (this.pos < this.text.length && this.text[this.pos] !== '"') {
          if (this.text[this.pos] === '\\') {
            this.pos += 1;
            const esc = this.text[this.pos];
            out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            this.pos += 1;
          } else {
            out += this.text[this.pos];
            this.pos += 1;
          }
        }
        this.pos += 1;
        return JSON.stringify(out);
      }
      const start = this.pos;
      while (this.pos < this.text.length && /[A-Za-z0-9_.-]/.test(this.text[this.pos])) this.pos += 1;
      return this.text.slice(start, this.pos);
    }

    expect(value: string): void {
      const got = this.next();
      if (got !== value) throw new Error(`GraphQL parse: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`);
    }
  }

  function parseGqlValue(lexer: GqlLexer): GqlValue {
    const token = lexer.next();
    if (token === '$') return { kind: 'variable', name: lexer.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (lexer.peek() !== ']') values.push(parseGqlValue(lexer));
      lexer.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Record<string, GqlValue> = {};
      while (lexer.peek() !== '}') {
        const name = lexer.next();
        lexer.expect(':');
        fields[name] = parseGqlValue(lexer);
      }
      lexer.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }

  function parseGqlSelectionSet(lexer: GqlLexer): GqlSelection[] {
    lexer.expect('{');
    const selections: GqlSelection[] = [];
    while (lexer.peek() !== '}') {
      if (lexer.peekToken() === '...') {
        lexer.next();
        let typeCondition: string | undefined;
        if (lexer.peekToken() === 'on') {
          lexer.next();
          typeCondition = lexer.next();
        }
        selections.push({ kind: 'inline', typeCondition, selection: parseGqlSelectionSet(lexer) });
        continue;
      }
      const first = lexer.next();
      let alias: string | undefined;
      let name = first;
      if (lexer.peek() === ':') {
        lexer.next();
        alias = first;
        name = lexer.next();
      }
      const args: Record<string, GqlValue> = {};
      if (lexer.peek() === '(') {
        lexer.next();
        while (lexer.peek() !== ')') {
          const argName = lexer.next();
          lexer.expect(':');
          args[argName] = parseGqlValue(lexer);
        }
        lexer.expect(')');
      }
      let selection: GqlSelection[] | undefined;
      if (lexer.peek() === '{') selection = parseGqlSelectionSet(lexer);
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    lexer.expect('}');
    return selections;
  }

  function parseGqlDocument(text: string): GqlOperation {
    const lexer = new GqlLexer(text);
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const first = lexer.peekToken();
    if (first === 'query' || first === 'mutation') {
      operation = lexer.next() as 'query' | 'mutation';
      const maybeName = lexer.peekToken();
      if (maybeName !== '{' && maybeName !== '(') name = lexer.next();
    }
    const variables: Record<string, GqlValue> = {};
    if (lexer.peek() === '(') {
      lexer.next();
      while (lexer.peek() !== ')') {
        if (lexer.peek() === '$') {
          lexer.next();
          const varName = lexer.next();
          lexer.expect(':');
          // skip the type (possibly [Type!]! etc.)
          let depth = 0;
          while (true) {
            const tok = lexer.next();
            if (tok === '[') depth += 1;
            else if (tok === ']') depth -= 1;
            else if (tok === '=' ) {
              variables[varName] = parseGqlValue(lexer);
              break;
            } else if (depth === 0 && (tok === ')' || tok === ',')) {
              // not reached: the loop condition handles ')'
              break;
            }
            if (lexer.peek() === ')' || lexer.peek() === '$' || lexer.peek() === ',') break;
          }
        } else {
          lexer.next();
        }
      }
      lexer.expect(')');
    }
    const selection = parseGqlSelectionSet(lexer);
    return { operation, name, variables, selection };
  }

  function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
    switch (value.kind) {
      case 'variable':
        return variables[value.name];
      case 'string':
      case 'int':
      case 'float':
      case 'boolean':
        return value.value;
      case 'null':
        return null;
      case 'enum':
        return value.value;
      case 'list':
        return value.values.map((entry) => resolveGqlValue(entry, variables));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value.fields)) out[key] = resolveGqlValue(entry, variables);
        return out;
      }
    }
  }

  function resolveGqlArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(field.args)) out[key] = resolveGqlValue(value, variables);
    return out;
  }

  // Known fields per type, for the unknown-field error.
  const TYPE_FIELDS: Record<string, string[]> = {
    Query: ['viewer', 'repository', 'node', '__type', '__schema'],
    User: ['login', 'id', 'name', 'email'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
    Issue: ['id', 'number', 'title', 'state', 'body'],
    PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files'],
    IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
    IssueEdge: ['node', 'cursor'],
    PullRequestEdge: ['node', 'cursor'],
    PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
    __Type: ['name', 'kind', 'fields', 'enumValues'],
    __Field: ['name', 'type'],
    __EnumValue: ['name'],
    __Schema: ['queryType'],
    Branch: ['name'],
    CreateIssuePayload: ['issue'],
    CloseIssuePayload: ['issue'],
    CreatePullRequestPayload: ['pullRequest'],
    MergePullRequestPayload: ['pullRequest'],
    AddCommentPayload: ['commentEdge'],
    IssueCommentEdge: ['node'],
    IssueComment: ['id', 'body'],
    PullRequestFile: ['path'],
  };

  const TYPE_FIELD_SETS: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
    PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'createdAt', 'updatedAt'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'url'],
  };

  const SEARCH_TYPE_VALUES = ['ISSUE', 'DISCUSSION', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'PROJECT', 'WIKI'];

  function encodeCursor(number: number): string {
    return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
  }

  function decodeCursor(cursor: string): number | null {
    try {
      const text = Buffer.from(cursor, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(text);
      return match ? Number.parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  interface GqlContext {
    variables: Record<string, unknown>;
    errors: Array<{ message: string }>;
  }

  function gqlIssueNode(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      __type: 'Issue',
      id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
      databaseId: issue.id,
      number: issue.number,
      title: issue.title,
      state: issue.state.toUpperCase(),
      body: issue.body,
      repo,
      issue,
    };
  }

  function gqlPullNode(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      __type: 'PullRequest',
      id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
      databaseId: pull.id,
      number: pull.number,
      title: pull.title,
      state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
      merged: pull.merged,
      mergeable: pull.state === 'open' ? (pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : null,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      repo,
      pull,
    };
  }

  function gqlRepoNode(repo: Repo): Record<string, unknown> {
    return {
      __type: 'Repository',
      id: repo.nodeId,
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { __type: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
      defaultBranchRef: { __type: 'Branch', name: repo.defaultBranch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      repo,
    };
  }

  function executeSelection(
    ctx: GqlContext,
    selections: GqlSelection[],
    source: Record<string, unknown> | null,
    typeName: string,
  ): Record<string, unknown> | null {
    if (source === null) return null;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition && selection.typeCondition !== typeName) continue;
        const sub = executeSelection(ctx, selection.selection, source, typeName);
        if (sub) Object.assign(out, sub);
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      const known = TYPE_FIELDS[typeName] ?? [];
      if (field.name.startsWith('__')) {
        // handled by the caller for root; unknown introspection fields error too
        if (!known.includes(field.name)) {
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
          continue;
        }
      } else if (!known.includes(field.name)) {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
        continue;
      }
      const value = resolveGqlField(ctx, field, source, typeName);
      out[key] = value;
    }
    return out;
  }

  function resolveGqlField(ctx: GqlContext, field: GqlField, source: Record<string, unknown>, typeName: string): unknown {
    const args = resolveGqlArgs(field, ctx.variables);
    const selection = field.selection ?? [];
    if (typeName === 'Query') {
      if (field.name === 'viewer') {
        const viewer = { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
        return executeSelection(ctx, selection, viewer, 'User');
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner, name);
        if (!repo) return null;
        return executeSelection(ctx, selection, gqlRepoNode(repo), 'Repository');
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        let decoded = '';
        try {
          decoded = Buffer.from(id, 'base64').toString('utf8');
        } catch {
          return null;
        }
        const match = /^(Repository|Issue|PullRequest):(\d+)(?::(\d+))?$/.exec(decoded);
        if (!match) return null;
        const repo = store.repoList.find((candidate) => candidate.id === Number.parseInt(match[2], 10));
        if (!repo) return null;
        if (match[1] === 'Repository') return executeSelection(ctx, selection, gqlRepoNode(repo), 'Repository');
        const number = Number.parseInt(match[3] ?? '0', 10);
        if (match[1] === 'Issue') {
          const issue = repo.issues.get(number);
          if (!issue) return null;
          return executeSelection(ctx, selection, gqlIssueNode(repo, issue), 'Issue');
        }
        const pull = repo.pulls.get(number);
        if (!pull) return null;
        return executeSelection(ctx, selection, gqlPullNode(repo, pull), 'PullRequest');
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        const typeNode = buildTypeNode(name);
        if (!typeNode) return null;
        return executeSelection(ctx, selection, typeNode, '__Type');
      }
      if (field.name === '__schema') {
        return executeSelection(ctx, selection, { __type: '__Schema', queryType: { name: 'Query' } }, '__Schema');
      }
      return null;
    }
    if (typeName === 'Repository') {
      const repo = source.repo as Repo;
      if (field.name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        if (!issue) return null;
        return executeSelection(ctx, selection, gqlIssueNode(repo, issue), 'Issue');
      }
      if (field.name === 'issues') {
        const nodes = orderedIssues(repo, args);
        return connectionResult(ctx, selection, nodes, args, 'Issue');
      }
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        if (!pull) return null;
        return executeSelection(ctx, selection, gqlPullNode(repo, pull), 'PullRequest');
      }
      if (field.name === 'pullRequests') {
        const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const nodes = pulls.map((pull) => gqlPullNode(repo, pull));
        return connectionResult(ctx, selection, nodes, args, 'PullRequest');
      }
      if (field.name === 'owner') return executeSelection(ctx, selection, source.owner as Record<string, unknown>, 'User');
      if (field.name === 'defaultBranchRef') return executeSelection(ctx, selection, source.defaultBranchRef as Record<string, unknown>, 'Branch');
      return source[field.name] ?? null;
    }
    if (typeName === 'PullRequest') {
      if (field.name === 'files') {
        const repo = source.repo as Repo;
        const pull = source.pull as Pull;
        const files = pullFiles(repo, pull).map((entry) => ({ __type: 'PullRequestFile', path: entry.filename }));
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first);
        return connectionResult(ctx, selection, nodes, args, 'PullRequestFile');
      }
      return source[field.name] ?? null;
    }
    if (typeName === '__Type') {
      if (field.name === 'fields') {
        const fields = (source.fields as Array<{ name: string }> | null) ?? null;
        if (!fields) return null;
        return fields.map((entry) => executeSelection(ctx, selection, { __type: '__Field', name: entry.name }, '__Field'));
      }
      if (field.name === 'enumValues') {
        const values = (source.enumValues as Array<{ name: string }> | null) ?? null;
        if (!values) return null;
        return values.map((entry) => executeSelection(ctx, selection, { __type: '__EnumValue', name: entry.name }, '__EnumValue'));
      }
      return source[field.name] ?? null;
    }
    if (typeName === '__Schema') {
      if (field.name === 'queryType') return { name: 'Query' };
      return source[field.name] ?? null;
    }
    const raw = source[field.name];
    if (raw === undefined || raw === null) return raw ?? null;
    if (isRecord(raw) && typeof raw.__type === 'string' && selection.length > 0) {
      return executeSelection(ctx, selection, raw, raw.__type);
    }
    return raw;
  }

  function buildTypeNode(name: string): Record<string, unknown> | null {
    const fields = TYPE_FIELD_SETS[name];
    if (fields) {
      return { __type: '__Type', name, kind: 'OBJECT', fields: fields.map((entry) => ({ name: entry })), enumValues: null };
    }
    if (name === 'SearchType') {
      return { __type: '__Type', name, kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((entry) => ({ name: entry })) };
    }
    return { __type: '__Type', name, kind: 'OBJECT', fields: [], enumValues: null };
  }

  function orderedIssues(repo: Repo, args: Record<string, unknown>): Array<Record<string, unknown>> {
    let issues = [...repo.issues.values()];
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    if (states) {
      const wanted = new Set(states.map((state) => String(state).toUpperCase()));
      issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
    }
    const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
    const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
    const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
    const key = field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
    issues.sort((a, b) => {
      const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.number - b.number;
      return direction === 'ASC' ? cmp : -cmp;
    });
    return issues.map((issue) => gqlIssueNode(repo, issue));
  }

  function connectionResult(
    ctx: GqlContext,
    selection: GqlSelection[],
    nodes: Array<Record<string, unknown>>,
    args: Record<string, unknown>,
    nodeType: string,
  ): Record<string, unknown> {
    let filtered = nodes;
    if (typeof args.after === 'string') {
      const afterNumber = decodeCursor(args.after);
      if (afterNumber !== null) {
        const index = nodes.findIndex((node) => node.number === afterNumber);
        if (index >= 0) filtered = nodes.slice(index + 1);
      }
    }
    const first = typeof args.first === 'number' ? args.first : filtered.length;
    const page = filtered.slice(0, first);
    const hasNextPage = filtered.length > first;
    const endCursor = page.length > 0 ? encodeCursor(Number(page[page.length - 1].number)) : null;
    const out: Record<string, unknown> = {};
    for (const item of selection) {
      if (item.kind === 'inline') continue;
      const field = item.field;
      if (field.name === 'nodes') {
        out[field.alias ?? 'nodes'] = page.map((node) => executeSelection(ctx, field.selection ?? [], node, nodeType));
      } else if (field.name === 'edges') {
        out[field.alias ?? 'edges'] = page.map((node) => executeSelection(ctx, field.selection ?? [], { __type: `${nodeType}Edge`, node, cursor: encodeCursor(Number(node.number)) }, `${nodeType}Edge`));
      } else if (field.name === 'pageInfo') {
        const info: Record<string, unknown> = { hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(Number(page[0].number)) : null, endCursor };
        out[field.alias ?? 'pageInfo'] = executeSelection(ctx, field.selection ?? [], info, 'PageInfo');
      } else if (field.name === 'totalCount') {
        out[field.alias ?? 'totalCount'] = filtered.length;
      }
    }
    return out;
  }

  function executeGqlOperation(operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
    const ctx: GqlContext = { variables, errors: [] };
    if (operation.operation === 'mutation') {
      const data = executeMutation(ctx, operation.selection);
      return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
    }
    const data = executeSelection(ctx, operation.selection, { __type: 'Query' }, 'Query');
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  }

  function executeMutation(ctx: GqlContext, selections: GqlSelection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind !== 'field') continue;
      const field = selection.field;
      const args = resolveGqlArgs(field, ctx.variables);
      const input = isRecord(args.input) ? args.input : {};
      const key = field.alias ?? field.name;
      if (field.name === 'createIssue') {
        const repoId = resolveRepositoryId(input.repositoryId);
        const repo = repoId === null ? undefined : store.repoList.find((candidate) => candidate.id === repoId);
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          out[key] = null;
          continue;
        }
        const createdAt = store.nowIso();
        const issue: Issue = {
          id: store.nextIssueId(),
          number: repo.nextIssueNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          createdAt,
          updatedAt: createdAt,
          closedAt: null,
        };
        repo.issues.set(issue.number, issue);
        out[key] = executeSelection(ctx, field.selection ?? [], { __type: 'CreateIssuePayload', issue: gqlIssueNode(repo, issue) }, 'CreateIssuePayload');
        continue;
      }
      if (field.name === 'closeIssue') {
        const decoded = safeDecodeId(String(input.issueId ?? ''));
        const repo = decoded.repoId ? store.repoList.find((candidate) => candidate.id === decoded.repoId) : undefined;
        const issue = repo?.issues.get(decoded.number ?? 0);
        if (!issue || !repo) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          out[key] = null;
          continue;
        }
        issue.state = 'closed';
        issue.closedAt = store.nowIso();
        issue.updatedAt = issue.closedAt;
        out[key] = executeSelection(ctx, field.selection ?? [], { __type: 'CloseIssuePayload', issue: gqlIssueNode(repo, issue) }, 'CloseIssuePayload');
        continue;
      }
      if (field.name === 'createPullRequest') {
        const repoId = resolveRepositoryId(input.repositoryId);
        const repo = repoId === null ? undefined : store.repoList.find((candidate) => candidate.id === repoId);
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        if (!repo || !repo.refs.get(`refs/heads/${headRef}`) || !repo.refs.get(`refs/heads/${baseRef}`)) {
          ctx.errors.push({ message: 'Could not resolve to a Repository or branch with the input provided.' });
          out[key] = null;
          continue;
        }
        const createdAt = store.nowIso();
        const pull: Pull = {
          id: store.nextPullId(),
          number: repo.nextPullNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef,
          headSha: repo.refs.get(`refs/heads/${headRef}`)!,
          baseRef,
          baseSha: repo.refs.get(`refs/heads/${baseRef}`)!,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdAt,
          updatedAt: createdAt,
          closedAt: null,
        };
        repo.pulls.set(pull.number, pull);
        out[key] = executeSelection(ctx, field.selection ?? [], { __type: 'CreatePullRequestPayload', pullRequest: gqlPullNode(repo, pull) }, 'CreatePullRequestPayload');
        continue;
      }
      if (field.name === 'mergePullRequest') {
        const decoded = safeDecodeId(String(input.pullRequestId ?? ''));
        const repo = decoded.repoId ? store.repoList.find((candidate) => candidate.id === decoded.repoId) : undefined;
        const pull = repo?.pulls.get(decoded.number ?? 0);
        if (!pull || !repo) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
          out[key] = null;
          continue;
        }
        if (pull.state === 'open' && !pullConflict(repo, pull)) mergePull(repo, pull);
        out[key] = executeSelection(ctx, field.selection ?? [], { __type: 'MergePullRequestPayload', pullRequest: gqlPullNode(repo, pull) }, 'MergePullRequestPayload');
        continue;
      }
      if (field.name === 'addComment') {
        const decoded = safeDecodeId(String(input.subjectId ?? ''));
        const repo = decoded.repoId ? store.repoList.find((candidate) => candidate.id === decoded.repoId) : undefined;
        const issue = repo?.issues.get(decoded.number ?? 0);
        if (!issue || !repo) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          out[key] = null;
          continue;
        }
        const createdAt = store.nowIso();
        const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), createdAt, updatedAt: createdAt, authorLogin: VIEWER_LOGIN };
        issue.comments.push(comment);
        const node = { __type: 'IssueComment', id: Buffer.from(`IssueComment:${comment.id}`, 'utf8').toString('base64'), body: comment.body };
        out[key] = executeSelection(ctx, field.selection ?? [], { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node } }, 'AddCommentPayload');
        continue;
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      out[key] = null;
    }
    return out;
  }

  function resolveRepositoryId(raw: unknown): number | null {
    if (typeof raw === 'number') return raw;
    if (typeof raw !== 'string') return null;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && raw.trim() !== '') return asNumber;
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      const match = /^Repository:(\d+)$/.exec(decoded);
      return match ? Number.parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  function safeDecodeId(id: string): { repoId?: number; number?: number } {
    try {
      const decoded = Buffer.from(id, 'base64').toString('utf8');
      const match = /^(Issue|PullRequest):(\d+):(\d+)$/.exec(decoded);
      if (!match) return {};
      return { repoId: Number.parseInt(match[2], 10), number: Number.parseInt(match[3], 10) };
    } catch {
      return {};
    }
  }

  async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requireAuth(req, res)) return;
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendError(res, 400, (error as Error).message);
      return;
    }
    const runOne = (doc: unknown): Record<string, unknown> => {
      if (!isRecord(doc) || typeof doc.query !== 'string') return { errors: [{ message: 'A query is required.' }] };
      try {
        const operation = parseGqlDocument(doc.query);
        const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
        return executeGqlOperation(operation, variables);
      } catch (error) {
        return { errors: [{ message: (error as Error).message }] };
      }
    };
    if (Array.isArray(body)) {
      sendJson(res, 200, body.map(runOne));
      return;
    }
    sendJson(res, 200, runOne(body));
  }

  // -----------------------------------------------------------------------------------------
  // MCP: JSON-RPC 2.0 over streamable HTTP (modern server/discover, 2026-07-28).
  // -----------------------------------------------------------------------------------------

  const MCP_TOOLS: Array<{
    name: string;
    description: string;
    inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
  }> = [
    {
      name: 'create_repo',
      description: 'Create a repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Repository name' },
          description: { type: 'string', description: 'Repository description' },
          private: { type: 'boolean', description: 'Whether the repository is private' },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          state: { type: 'string', description: 'Issue state: open, closed or all' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Open a pull request from a head branch into a base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Pull request title' },
          body: { type: 'string', description: 'Pull request body' },
          head: { type: 'string', description: 'Head branch name' },
          base: { type: 'string', description: 'Base branch name' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request with a squash merge.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          pull_number: { type: 'integer', description: 'Pull request number' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  ];

  function mcpToolResult(value: unknown): Record<string, unknown> {
    const text = JSON.stringify(value);
    return { content: [{ type: 'text', text }], structuredContent: value };
  }

  function mcpToolError(message: string): Record<string, unknown> {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const owner = typeof args.owner === 'string' ? args.owner : typeof args.full_name === 'string' ? args.full_name.split('/')[0] : '';
    const repoName = typeof args.repo === 'string' ? args.repo : typeof args.full_name === 'string' ? args.full_name.split('/')[1] : '';
    if (name === 'create_repo') {
      if (typeof args.name !== 'string' || args.name === '') return mcpToolError('create_repo requires a name');
      if (store.getRepo(VIEWER_LOGIN, args.name)) return mcpToolError(`repository ${args.name} already exists`);
      const repo = store.createRepo(args.name, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: args.private === true,
      });
      return mcpToolResult(repoJson(repo));
    }
    if (owner === '' || repoName === '') return mcpToolError('owner and repo are required');
    if (owner !== VIEWER_LOGIN) return mcpToolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return mcpToolError('Not Found');
    if (name === 'get_repo') return mcpToolResult(repoJson(repo));
    if (name === 'create_issue') {
      if (typeof args.title !== 'string' || args.title === '') return mcpToolError('create_issue requires a title');
      const createdAt = store.nowIso();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextIssueNumber++,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt,
        updatedAt: createdAt,
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return mcpToolResult(issueJson(repo, issue));
    }
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      return mcpToolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    if (name === 'create_pull_request') {
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const title = typeof args.title === 'string' ? args.title : '';
      if (!head || !base || !title) return mcpToolError('create_pull_request requires title, head and base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return mcpToolError('head or base branch does not exist');
      const createdAt = store.nowIso();
      const pull: Pull = {
        id: store.nextPullId(),
        number: repo.nextPullNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt,
        updatedAt: createdAt,
        closedAt: null,
      };
      repo.pulls.set(pull.number, pull);
      return mcpToolResult(pullJson(repo, pull));
    }
    if (name === 'merge_pull_request') {
      const number = typeof args.pull_number === 'number'
        ? args.pull_number
        : typeof args.number === 'number'
          ? args.number
          : typeof args.pull_request_number === 'number'
            ? args.pull_request_number
            : null;
      if (number === null) return mcpToolError('merge_pull_request requires pull_number');
      const pull = repo.pulls.get(number);
      if (!pull) return mcpToolError(`pull request #${number} not found`);
      if (pull.state !== 'open') return mcpToolError('pull request is not open');
      if (pullConflict(repo, pull)) return mcpToolError('merge conflict');
      const sha = mergePull(repo, pull);
      return mcpToolResult({ sha, merged: true, number: pull.number });
    }
    return mcpToolError(`unknown tool ${name}`);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requireAuth(req, res)) return;
    if (req.method === 'DELETE') {
      res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!isRecord(body) || typeof body.method !== 'string') {
      sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(body) ? body.id ?? null : null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const id = body.id ?? null;
    const isNotification = id === null || id === undefined;
    const params = isRecord(body.params) ? body.params : {};
    const method = body.method;
    const ok = (result: unknown): void => {
      if (isNotification) {
        res.writeHead(202, { 'content-type': 'application/json', 'x-github-request-id': `req-${++requestCounter}` });
        res.end('{}');
        return;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id, result });
    };
    const fail = (code: number, message: string): void => {
      if (isNotification) {
        res.writeHead(202, { 'content-type': 'application/json', 'x-github-request-id': `req-${++requestCounter}` });
        res.end('{}');
        return;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
    };
    if (method === 'server/discover') {
      ok({
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return;
    }
    if (method === 'initialize') {
      ok({
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      ok({});
      return;
    }
    if (method === 'ping') {
      ok({});
      return;
    }
    if (method === 'tools/list') {
      ok({ tools: MCP_TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) {
        fail(-32602, `Unknown tool: ${toolName}`);
        return;
      }
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        ok({ content: [{ type: 'text', text: `missing required arguments: ${missing.join(', ')}` }], isError: true });
        return;
      }
      ok(mcpCallTool(toolName, args));
      return;
    }
    fail(-32601, `Method not found: ${method}`);
  }

  // -----------------------------------------------------------------------------------------
  // top-level routing
  // -----------------------------------------------------------------------------------------

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const rawUrl = req.url ?? '/';
      const url = new URL(rawUrl, 'http://localhost');
      const pathname = url.pathname;
      const query = parseQuery(url.search);
      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/mcp') {
        await handleMcp(req, res);
        return;
      }
      if (pathname === '/api/graphql') {
        await handleGraphql(req, res);
        return;
      }
      if (/^\/[^/]+\/[^/]+\.git\//.test(pathname)) {
        await handleGit(req, res, pathname, query);
        return;
      }
      if (pathname.startsWith('/api/v3')) {
        await handleRest(req, res, pathname, query);
        return;
      }
      sendError(res, 404, 'Not Found');
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 500;
      if (!res.headersSent) {
        sendError(res, status, (error as Error).message || 'Internal Server Error');
      } else {
        res.end();
      }
    }
  }

  return { store, handler };
}

export function serve(): void {
  const { handler } = createApp();
  const server = createServer(handler);
  const port = Number.parseInt(process.env.PORT ?? '0', 10) || 0;
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      // eslint-disable-next-line no-console
      console.log(`forge listening on 127.0.0.1:${address.port}`);
    }
  });
}
