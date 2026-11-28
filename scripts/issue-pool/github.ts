import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { Command } from "./command";
import { claimedLabel, feedbackLabel, type IssueTracker, PoolError } from "./pool";
import { workerBranch } from "./t3";

export const defaultRepository = "KvitBit/KvitBit";

const repoSlug = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/;
const githubSshOrigin = /^(?:[^@/:]+@)?github\.com:([^?#]+)$/i;
const pathSlashes = /^\/|\/$/g;
const gitSuffix = /\.git$/i;

const Repository = Schema.Struct({
  id: Schema.Int,
  full_name: Schema.String,
  owner: Schema.Struct({ id: Schema.Int }),
});
type Repository = typeof Repository.Type;

const Label = Schema.Struct({ name: Schema.String });
const RestIssue = Schema.Struct({
  number: Schema.Int,
  state: Schema.String,
  labels: Schema.Array(Label),
  assignees: Schema.Array(Schema.Unknown),
  pull_request: Schema.optionalKey(Schema.JsonObject),
});
type RestIssue = typeof RestIssue.Type;

const ClosingReferences = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issue: Schema.Struct({
        closedByPullRequestsReferences: Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ state: Schema.String })),
        }),
      }),
    }),
  }),
});

const closingPullRequests = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 1) { nodes { state } }
    }
  }
}`;

const api = (run: Command, ...args: string[]) =>
  run({ executable: "gh", args: ["api", "--hostname", "github.com", ...args] });

const decode =
  <A>(schema: Schema.Codec<A, unknown, never, never>, message: string) =>
  (body: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.mapError(() => PoolError.make({ message })),
    );

const decodeRepository = decode(Repository, "Unexpected GitHub repository identity");
const decodeIssue = decode(RestIssue, "Unexpected GitHub issue response");
const decodeLabels = decode(Schema.Array(Label), "Unexpected GitHub label response");
const decodeClosingReferences = decode(
  ClosingReferences,
  "Unexpected GitHub closing reference response",
);
const decodePullRequests = decode(
  Schema.Array(Schema.Unknown),
  "Unexpected GitHub pull request response",
);

export const resolveRepository = Effect.fn("IssuePool.resolveRepository")(function* ({
  run,
  slug,
}: {
  readonly run: Command;
  readonly slug: string;
}) {
  if (!repoSlug.test(slug))
    return yield* PoolError.make({ message: "--repo must be a GitHub owner/name" });
  const repository = yield* api(run, `repos/${slug}`).pipe(Effect.flatMap(decodeRepository));
  if (repository.id < 1 || !repoSlug.test(repository.full_name)) {
    return yield* PoolError.make({ message: "Unexpected GitHub repository identity" });
  }
  return repository;
});

const matchesRepository = Effect.fn("IssuePool.matchesRepository")(function* (
  run: Command,
  repository: Repository,
  slug: string,
) {
  if (!repoSlug.test(slug)) return false;
  if (Str.toLowerCase(slug) === Str.toLowerCase(repository.full_name)) return true;
  return yield* resolveRepository({ run, slug }).pipe(
    Effect.map((candidate) => candidate.id === repository.id),
    Effect.orElseSucceed(() => false),
  );
});

export const verifyProjectOrigin = Effect.fn("IssuePool.verifyProjectOrigin")(function* ({
  run,
  project,
  repository,
}: {
  readonly run: Command;
  readonly project: string;
  readonly repository: Repository;
}) {
  const origin = yield* run({
    executable: "git",
    args: ["-C", project, "remote", "get-url", "origin"],
  }).pipe(Effect.map(Str.trim));
  const sshPath = githubSshOrigin.exec(origin)?.[1];
  const url = URL.parse(sshPath === undefined ? origin : `ssh://github.com/${sshPath}`);
  if (
    url === null ||
    !Arr.some(["https:", "ssh:", "git:"], (protocol) => protocol === url.protocol) ||
    !Arr.some(["github.com", "ssh.github.com"], (host) => host === url.hostname)
  )
    return yield* PoolError.make({
      message: "The project origin does not match the resolved GitHub repository",
    });
  const slug = Str.replace(gitSuffix, "")(Str.replace(pathSlashes, "")(url.pathname));
  if (!(yield* matchesRepository(run, repository, slug))) {
    return yield* PoolError.make({
      message: "The project origin does not match the resolved GitHub repository",
    });
  }
});

const isFeedbackIssue = (issue: RestIssue): boolean =>
  issue.pull_request === undefined &&
  issue.state === "open" &&
  Arr.some(issue.labels, ({ name }) => name === feedbackLabel);

const isClaimed = (issue: RestIssue): boolean =>
  Arr.some(issue.labels, ({ name }) => name === claimedLabel);

export const githubIssueTracker = Effect.fn("IssuePool.githubIssueTracker")(function* ({
  repository,
  run,
}: {
  readonly repository: Repository;
  readonly run: Command;
}) {
  const base = `repos/${repository.full_name}`;
  const [owner, name] = Str.split(repository.full_name, "/");
  const pages = <A>(path: string, schema: Schema.Codec<A, unknown, never, never>) =>
    api(run, "--paginate", "--slurp", path).pipe(
      Effect.flatMap(
        decode(schema.pipe(Schema.Array, Schema.Array), "Unexpected GitHub pagination response"),
      ),
      Effect.map(Arr.flatten),
    );

  const claimLabelExists = pages(`${base}/labels?per_page=100`, Label).pipe(
    Effect.map((labels) => Arr.some(labels, ({ name: labelName }) => labelName === claimedLabel)),
  );
  const ensureClaimLabel = yield* Effect.cached(
    Effect.gen(function* () {
      if (yield* claimLabelExists) return;
      yield* api(
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
      ).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          claimLabelExists.pipe(
            Effect.flatMap((found) => (found ? Effect.void : Effect.fail(error))),
          ),
        ),
      );
    }),
  );
  return {
    list: Effect.gen(function* () {
      const issues = yield* pages(
        `${base}/issues?state=open&labels=${feedbackLabel}&per_page=100`,
        RestIssue,
      );
      return Arr.map(Arr.filter(issues, isFeedbackIssue), ({ number, labels }) => ({
        number,
        claimed: Arr.some(labels, ({ name: labelName }) => labelName === claimedLabel),
      }));
    }),
    isAvailable: Effect.fn("IssuePool.isIssueAvailable")(function* (number: number) {
      const issue = yield* api(run, `${base}/issues/${number}`).pipe(Effect.flatMap(decodeIssue));
      if (!isFeedbackIssue(issue) || isClaimed(issue) || issue.assignees.length > 0) return false;

      const references = yield* api(
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
      ).pipe(Effect.flatMap(decodeClosingReferences));
      if (references.data.repository.issue.closedByPullRequestsReferences.nodes.length > 0)
        return false;

      const head = encodeURIComponent(`${owner}:${workerBranch(number)}`);
      const branchPRs = yield* api(run, `${base}/pulls?state=open&head=${head}&per_page=1`).pipe(
        Effect.flatMap(decodePullRequests),
      );
      return branchPRs.length === 0;
    }),
    ensureClaimLabel,
    claim: Effect.fn("IssuePool.claimIssue")(function* (number: number) {
      const labels = yield* api(
        run,
        "--method",
        "POST",
        `${base}/issues/${number}/labels`,
        "-f",
        `labels[]=${claimedLabel}`,
      ).pipe(Effect.flatMap(decodeLabels));
      if (!Arr.some(labels, ({ name: labelName }) => labelName === claimedLabel)) {
        return yield* PoolError.make({ message: "GitHub did not confirm the issue claim label" });
      }
    }),
  } satisfies IssueTracker;
});
