// store.ts — the forge's one in-memory state, shared by the git, REST, GraphQL and MCP surfaces.
//
// A Forge owns every repository created during the process's life. Each repository holds its git
// objects and refs plus its issues, pull requests, comments and labels; issue and pull-request
// numbers share one per-repository sequence, as they do on GitHub. Server-side commits (contents
// writes, merges) take their timestamps from a deterministic tick counter rather than the wall
// clock, so replaying the same request sequence produces the same object ids.

import {
  ZERO_OID,
  buildCommitData,
  buildTreeData,
  isDirMode,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  type CommitInfo,
  type GitObject,
  type GitObjectType,
  type Identity,
  type TreeEntry,
} from './gitcore.ts';

/** The one user the trial token belongs to (the suite's seeded viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** Where server-side commit timestamps start; each new commit adds one second. */
const TICK_EPOCH = 1_700_000_000;

export interface IssueRecord {
  /** Forge-wide unique id (the REST object's `id`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Creation order within the forge (the sort key GraphQL calls CREATED_AT). */
  seq: number;
}

export interface CommentRecord {
  id: number;
  issueNumber: number;
  body: string;
  seq: number;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  /** ISO timestamp of the merge (from the deterministic tick), null while unmerged. */
  mergedAt: string | null;
  headRef: string;
  baseRef: string;
  /** The head/base tips when the pull request was opened (fallbacks if a branch later moves). */
  headShaAtOpen: string;
  baseShaAtOpen: string;
  seq: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;

  readonly objects = new Map<string, GitObject>();
  /** Full ref names ("refs/heads/main") to object ids. HEAD is the default branch, virtually. */
  readonly refs = new Map<string, string>();

  readonly issues = new Map<number, IssueRecord>();
  readonly pulls = new Map<number, PullRecord>();
  readonly comments: CommentRecord[] = [];
  readonly labels = new Map<string, { name: string; color: string }>();
  /** The shared issue/pull number sequence. */
  nextNumber = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = 'main';
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  // ---------------------------------------------------------------- git objects and refs

  storeObject(type: GitObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  commitOf(oid: string): CommitInfo | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Resolve any object id to the commit it points at (through annotated tags), or null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The commit a ref names, peeled; null when the ref is missing or not commit-like. */
  refCommit(ref: string): string | null {
    const oid = this.refs.get(ref);
    return oid === undefined ? null : this.peelToCommit(oid);
  }

  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  branchTip(branch: string): string | null {
    return this.refCommit(this.branchRef(branch));
  }

  headRef(): string {
    return this.branchRef(this.defaultBranch);
  }

  /** Branch names (short) in lexicographic order. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Flatten a tree (by tree oid) into a path -> {oid, mode} map of blobs, recursively. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** The flattened file map at a commit (empty when the commit is unknown). */
  filesAt(commitOid: string): Map<string, { oid: string; mode: string }> {
    const commit = this.commitOf(commitOid);
    if (commit === null) return new Map();
    return this.flattenTree(commit.tree);
  }

  /** Build (and store) nested trees from a flat path -> blob map; answers the root tree oid. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface DirNode {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let node = root;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index]!;
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1]!, file);
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
      return this.storeObject('tree', buildTreeData(entries));
    };
    return build(root);
  }

  /** The commit history reachable from `start`, newest first (breadth by generation). */
  historyFrom(start: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    let frontier: string[] = [start];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        const commit = this.commitOf(oid);
        if (commit === null) continue;
        seen.add(oid);
        order.push(oid);
        next.push(...commit.parents);
      }
      frontier = next;
    }
    return order;
  }

  /** Whether `ancestor` is reachable from `descendant` (inclusive). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    let frontier: string[] = [descendant];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (oid === ancestor) return true;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const commit = this.commitOf(oid);
        if (commit !== null) next.push(...commit.parents);
      }
      frontier = next;
    }
    return false;
  }

  /** The deepest common ancestor of two commits, or null when they share no history. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOf = (start: string): Map<string, number> => {
      const depth = new Map<string, number>();
      let frontier: string[] = [start];
      let generation = 0;
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const oid of frontier) {
          if (depth.has(oid)) continue;
          const commit = this.commitOf(oid);
          if (commit === null) continue;
          depth.set(oid, generation);
          next.push(...commit.parents);
        }
        frontier = next;
        generation += 1;
      }
      return depth;
    };
    const fromA = ancestorsOf(a);
    const fromB = ancestorsOf(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, depthA] of fromA) {
      const depthB = fromB.get(oid);
      if (depthB === undefined) continue;
      const score = depthA + depthB;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }
}

export interface MergeOutcome {
  ok: boolean;
  /** The merged tree's oid, when ok. */
  tree?: string;
  /** The paths that conflicted, when not ok. */
  conflicts?: string[];
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private seq = 0;
  private tick = 0;

  /** A monotonically increasing sequence number (creation order, replay-stable). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A deterministic timestamp for a server-side commit. */
  nextTime(): number {
    this.tick += 1;
    return TICK_EPOCH + this.tick;
  }

  /** An ISO timestamp derived from the tick, for API responses that carry dates. */
  isoTime(): string {
    return new Date(this.nextTime() * 1000).toISOString();
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  /** Create a server-side commit on a repo and store it (the ref is NOT moved). */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const identity: Identity = { name: VIEWER.name, email: VIEWER.email };
    const data = buildCommitData({ tree, parents, author: identity, committer: identity, time: this.nextTime(), message });
    return repo.storeObject('commit', data);
  }

  /**
   * Write `content` at `path` on `branch`, creating the branch (from the default branch's tip,
   * or as a root commit on an unborn repository) when it does not exist yet. Returns the new
   * commit and blob ids, and whether the file already existed on that branch.
   */
  writeFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; existed: boolean } {
    const ref = repo.branchRef(branch);
    let tip = repo.branchTip(branch);
    if (tip === null) {
      // An unborn branch: start from the default branch's tip when there is one.
      tip = branch === repo.defaultBranch ? null : repo.branchTip(repo.defaultBranch);
    }
    const files = tip === null ? new Map<string, { oid: string; mode: string }>() : repo.filesAt(tip);
    const existed = files.has(path);
    const blobSha = repo.storeObject('blob', content);
    files.set(path, { oid: blobSha, mode: files.get(path)?.mode ?? '100644' });
    const tree = repo.buildTreeFromFiles(files);
    const commitSha = this.makeCommit(repo, tree, tip === null ? [] : [tip], message);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, existed };
  }

  /** Remove `path` from `branch` with a commit. Null when the file is not there. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = repo.branchTip(branch);
    if (tip === null) return null;
    const files = repo.filesAt(tip);
    if (!files.has(path)) return null;
    files.delete(path);
    const tree = repo.buildTreeFromFiles(files);
    const commitSha = this.makeCommit(repo, tree, [tip], message);
    repo.refs.set(repo.branchRef(branch), commitSha);
    return { commitSha };
  }

  /**
   * Three-way merge of `head` into `base` at whole-file granularity: a path changed on only one
   * side takes that side's version; changed on both sides differently is a conflict.
   */
  mergeTrees(repo: Repo, baseTip: string, headTip: string): MergeOutcome {
    const mergeBase = repo.mergeBase(baseTip, headTip);
    if (mergeBase === null) return { ok: false, conflicts: ['(no common ancestor)'] };
    if (repo.isAncestor(headTip, baseTip)) {
      const commit = repo.commitOf(baseTip);
      return { ok: true, tree: commit?.tree };
    }
    const baseFiles = repo.filesAt(mergeBase);
    const ourFiles = repo.filesAt(baseTip);
    const theirFiles = repo.filesAt(headTip);
    const merged = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const paths = new Set<string>([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path)?.oid;
      const ours = ourFiles.get(path)?.oid;
      const theirs = theirFiles.get(path)?.oid;
      if (ours === theirs) {
        const winner = ourFiles.get(path) ?? theirFiles.get(path);
        if (winner !== undefined) merged.set(path, winner);
      } else if (base === ours) {
        const winner = theirFiles.get(path);
        if (winner !== undefined) merged.set(path, winner);
      } else if (base === theirs) {
        const winner = ourFiles.get(path);
        if (winner !== undefined) merged.set(path, winner);
      } else {
        conflicts.push(path);
      }
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    return { ok: true, tree: repo.buildTreeFromFiles(merged) };
  }

  /** Merge a pull request per `method` ('merge' | 'squash'); moves the base ref on success. */
  mergePull(repo: Repo, pull: PullRecord, method: string): { ok: boolean; sha?: string; conflicts?: string[] } {
    const baseTip = repo.branchTip(pull.baseRef);
    const headTip = repo.branchTip(pull.headRef);
    if (baseTip === null || headTip === null) return { ok: false, conflicts: ['(missing branch)'] };
    const outcome = this.mergeTrees(repo, baseTip, headTip);
    if (!outcome.ok || outcome.tree === undefined) return { ok: false, conflicts: outcome.conflicts };
    let sha: string;
    if (repo.isAncestor(headTip, baseTip)) {
      sha = baseTip; // Already up to date: the head is contained in the base.
    } else if (method === 'squash') {
      sha = this.makeCommit(repo, outcome.tree, [baseTip], `${pull.title}\n\n${pull.body}`.trimEnd() + '\n');
    } else {
      sha = this.makeCommit(repo, outcome.tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n`);
    }
    repo.refs.set(repo.branchRef(pull.baseRef), sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = this.isoTime();
    return { ok: true, sha };
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRecord {
    const issue: IssueRecord = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: this.nextSeq(),
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): CommentRecord {
    const comment: CommentRecord = { id: this.nextCommentId, issueNumber, body, seq: this.nextSeq() };
    this.nextCommentId += 1;
    repo.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRecord {
    const pull: PullRecord = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      headRef,
      baseRef,
      headShaAtOpen: repo.branchTip(headRef) ?? ZERO_OID,
      baseShaAtOpen: repo.branchTip(baseRef) ?? ZERO_OID,
      seq: this.nextSeq(),
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}
