import type { Command } from "./command";
import { claimedLabel, feedbackLabel, type IssueTracker, PoolError } from "./pool";
import { workerBranch } from "./t3";

export const defaultRepository = "KvitBit/KvitBit";
const repoSlug = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/;

interface Repository {
  id: number;
  full_name: string;
  owner: { id: number };
}

interface RestIssue {
  number: number;
  state: string;
  labels: { name: string }[];
  assignees: unknown[];
  pull_request?: object;
}

const closingPullRequests = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 1) { nodes { state } }
    }
  }
}`;

function api(run: Command, ...args: string[]): Promise<string> {
  return run("gh", ["api", "--hostname", "github.com", ...args]);
}

export async function resolveRepository(run: Command, slug: string): Promise<Repository> {
  if (!repoSlug.test(slug)) throw new PoolError("--repo must be a GitHub owner/name");
  const repository: Repository = JSON.parse(await api(run, `repos/${slug}`));
  if (
    !Number.isSafeInteger(repository.id) ||
    repository.id < 1 ||
    !repoSlug.test(repository.full_name) ||
    !Number.isSafeInteger(repository.owner?.id)
  ) {
    throw new PoolError("Unexpected GitHub repository identity");
  }
  return repository;
}

async function matchesRepository(
  run: Command,
  repository: Repository,
  slug: string,
): Promise<boolean> {
  if (!repoSlug.test(slug)) return false;
  if (slug.toLowerCase() === repository.full_name.toLowerCase()) return true;
  try {
    return (await resolveRepository(run, slug)).id === repository.id;
  } catch {
    return false;
  }
}

export async function verifyProjectOrigin(
  run: Command,
  project: string,
  repository: Repository,
): Promise<void> {
  const origin = (await run("git", ["-C", project, "remote", "get-url", "origin"])).trim();
  const sshPath = /^(?:[^@/:]+@)?github\.com:([^?#]+)$/i.exec(origin)?.[1];
  const url = URL.parse(sshPath ? `ssh://github.com/${sshPath}` : origin);
  const slug = url?.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "");
  if (
    !url ||
    !["https:", "ssh:", "git:"].includes(url.protocol) ||
    !["github.com", "ssh.github.com"].includes(url.hostname) ||
    !slug ||
    !(await matchesRepository(run, repository, slug))
  ) {
    throw new PoolError("The project origin does not match the resolved GitHub repository");
  }
}

function isFeedbackIssue(issue: RestIssue): boolean {
  return (
    !issue.pull_request &&
    issue.state === "open" &&
    issue.labels.some(({ name }) => name === feedbackLabel)
  );
}

function isClaimed(issue: RestIssue): boolean {
  return issue.labels.some(({ name }) => name === claimedLabel);
}

export function githubIssueTracker(repository: Repository, run: Command): IssueTracker {
  const base = `repos/${repository.full_name}`;
  const [owner, name] = repository.full_name.split("/");
  let claimLabelReady: Promise<void> | undefined;

  async function pages<T>(path: string): Promise<T[]> {
    const response = await api(run, "--paginate", "--slurp", path);
    const result: T[][] = JSON.parse(response);
    if (!Array.isArray(result) || !result.every(Array.isArray)) {
      throw new PoolError("Unexpected GitHub pagination response");
    }
    return result.flat();
  }

  async function ensureClaimLabel(): Promise<void> {
    const exists = async () =>
      (await pages<{ name: string }>(`${base}/labels?per_page=100`)).some(
        ({ name }) => name === claimedLabel,
      );
    if (await exists()) return;
    try {
      await api(
        run,
        "--method",
        "POST",
        `${base}/labels`,
        "-f",
        `name=${claimedLabel}`,
        "-f",
        "color=5319e7",
        "-f",
        "description=Assigned to the Kvitbit issue pool",
      );
    } catch (error) {
      if (!(await exists())) throw error;
    }
  }

  async function isAvailable(number: number): Promise<boolean> {
    const issue: RestIssue = JSON.parse(await api(run, `${base}/issues/${number}`));
    if (!isFeedbackIssue(issue) || isClaimed(issue) || issue.assignees.length > 0) return false;

    const references: {
      data: {
        repository: { issue: { closedByPullRequestsReferences: { nodes: { state: string }[] } } };
      };
    } = JSON.parse(
      await api(
        run,
        "graphql",
        "-f",
        `query=${closingPullRequests}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${number}`,
      ),
    );
    if (references.data.repository.issue.closedByPullRequestsReferences.nodes.length > 0) {
      return false;
    }

    const head = encodeURIComponent(`${owner}:${workerBranch(number)}`);
    const branchPRs: unknown[] = JSON.parse(
      await api(run, `${base}/pulls?state=open&head=${head}&per_page=1`),
    );
    if (!Array.isArray(branchPRs)) throw new PoolError("Unexpected GitHub pull request response");
    return branchPRs.length === 0;
  }

  return {
    async list() {
      const issues = await pages<RestIssue>(
        `${base}/issues?state=open&labels=${feedbackLabel}&per_page=100`,
      );
      return issues.filter(isFeedbackIssue).map(({ number, labels }) => ({
        number,
        claimed: labels.some(({ name }) => name === claimedLabel),
      }));
    },
    isAvailable,
    async ensureClaimLabel() {
      claimLabelReady ??= ensureClaimLabel();
      await claimLabelReady;
    },
    async claim(number) {
      const response = await api(
        run,
        "--method",
        "POST",
        `${base}/issues/${number}/labels`,
        "-f",
        `labels[]=${claimedLabel}`,
      );
      const labels: { name: string }[] = JSON.parse(response);
      if (!labels.some(({ name }) => name === claimedLabel)) {
        throw new PoolError("GitHub did not confirm the issue claim label");
      }
    },
  };
}
