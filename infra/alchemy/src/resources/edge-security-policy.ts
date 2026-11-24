import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  computeRoot,
  EdgeComputeResourceNotConverged,
  EdgeComputeResourceUnowned,
  isAdmitted,
  isAmbiguousFailure,
  isOwnedDescription,
  makeEdgeComputeApi,
  ownedDescription,
  parseOwnedDescription,
  requireAdmittedTarget,
  requirePresent,
} from "./edge-compute-api";
import { resolvedStringProp } from "./provider-inputs";

/** One Cloud Armor rule, with only the fields the Kvitbit edge sets. */
export interface EdgeSecurityPolicyRule {
  readonly priority: number;
  readonly action: string;
  readonly description: string;
  /** Sent on every write, so a rule leaves preview when this turns false. */
  readonly preview: boolean;
  readonly match:
    | { readonly expr: { readonly expression: string } }
    | {
        readonly versionedExpr: "SRC_IPS_V1";
        readonly config: { readonly srcIpRanges: ReadonlyArray<string> };
      };
  readonly rateLimitOptions?: {
    readonly conformAction: string;
    readonly exceedAction: string;
    readonly enforceOnKey: string;
    readonly rateLimitThreshold: {
      readonly count: number;
      readonly intervalSec: number;
    };
  };
}

export interface EdgeSecurityPolicyProps {
  /** Project of the policy; identity, so a change replaces it. */
  readonly project: string;
  /** Policy name; identity, so a change replaces it. */
  readonly name: string;
  readonly description?: string;
  /** Immutable in Compute, so a change replaces the policy. */
  readonly type: "CLOUD_ARMOR";
  /** Every rule of the policy, the default rule at 2147483647 included. */
  readonly rules: ReadonlyArray<EdgeSecurityPolicyRule>;
}

export interface EdgeSecurityPolicyAttributes {
  readonly project: string;
  readonly name: string;
  readonly id: string;
  readonly selfLink: string;
  readonly creationTimestamp: string;
  readonly type: string;
  /** The description with the Alchemy ownership marker stripped. */
  readonly description: string | undefined;
  /** Live rules by priority, in the compared form. */
  readonly rules: ReadonlyArray<string>;
}

/**
 * The Kvitbit edge's Cloud Armor policy. The native beta.87
 * `GCP.Compute.SecurityPolicy` drops `preview: false` from rule writes, so
 * a WAF rule could never leave preview; this resource alone owns the
 * policy and all its rules.
 */
export type EdgeSecurityPolicy = Resource<
  "Kvitbit.EdgeSecurityPolicy",
  EdgeSecurityPolicyProps,
  EdgeSecurityPolicyAttributes
>;
export const EdgeSecurityPolicy = Resource<EdgeSecurityPolicy>("Kvitbit.EdgeSecurityPolicy");

/** Rule sync passes; a pass ends early only on a lost answer. */
const ruleSyncPasses = 3;

/** The rule Compute keeps at the lowest priority; it can only be patched. */
const defaultRulePriority = 2147483647;

const LiveRule = Schema.Struct({
  priority: Schema.optional(Schema.Finite),
  action: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.Boolean),
  match: Schema.optional(
    Schema.Struct({
      expr: Schema.optional(Schema.Struct({ expression: Schema.optional(Schema.String) })),
      versionedExpr: Schema.optional(Schema.String),
      config: Schema.optional(
        Schema.Struct({
          srcIpRanges: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
  /** Never declared by the edge; any live exclusion is drift. */
  preconfiguredWafConfig: Schema.optional(
    Schema.Struct({
      exclusions: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
  rateLimitOptions: Schema.optional(
    Schema.Struct({
      conformAction: Schema.optional(Schema.String),
      exceedAction: Schema.optional(Schema.String),
      enforceOnKey: Schema.optional(Schema.String),
      rateLimitThreshold: Schema.optional(
        Schema.Struct({
          count: Schema.optional(Schema.Finite),
          intervalSec: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
});
type LiveRule = typeof LiveRule.Type;

const LiveSecurityPolicy = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  selfLink: Schema.optional(Schema.String),
  creationTimestamp: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  rules: Schema.optional(Schema.Array(LiveRule)),
});
type LiveSecurityPolicy = typeof LiveSecurityPolicy.Type;
/**
 * A rule in a form both sides share: absent booleans are false, absent
 * strings empty, so a live rule equals its declaration exactly when every
 * field the edge sets matches.
 */
export const comparedRule = (rule: LiveRule | EdgeSecurityPolicyRule) => {
  const match = rule.match;
  const limit = rule.rateLimitOptions;
  const wafExclusions =
    "preconfiguredWafConfig" in rule ? (rule.preconfiguredWafConfig?.exclusions ?? []) : [];
  return JSON.stringify({
    priority: rule.priority,
    action: rule.action ?? "",
    description: rule.description ?? "",
    preview: rule.preview === true,
    expression: match !== undefined && "expr" in match ? (match.expr?.expression ?? "") : "",
    versionedExpr:
      match !== undefined && "versionedExpr" in match ? (match.versionedExpr ?? "") : "",
    srcIpRanges:
      match !== undefined && "config" in match ? [...(match.config?.srcIpRanges ?? [])].sort() : [],
    wafExclusions,
    rateLimit:
      limit === undefined
        ? null
        : {
            conformAction: limit.conformAction ?? "",
            exceedAction: limit.exceedAction ?? "",
            enforceOnKey: limit.enforceOnKey ?? "",
            count: limit.rateLimitThreshold?.count ?? 0,
            intervalSec: limit.rateLimitThreshold?.intervalSec ?? 0,
          },
  });
};

const toAttributes = (project: string, live: LiveSecurityPolicy): EdgeSecurityPolicyAttributes => ({
  project,
  name: live.name ?? "",
  id: live.id ?? "",
  selfLink: live.selfLink ?? "",
  creationTimestamp: live.creationTimestamp ?? "",
  type: live.type ?? "",
  description: parseOwnedDescription(live.description).description,
  rules: [...(live.rules ?? [])]
    .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
    .map(comparedRule),
});

/** The rule changes that bring the live rules to the declared ones. */
export const ruleChanges = (
  desired: ReadonlyArray<EdgeSecurityPolicyRule>,
  live: ReadonlyArray<LiveRule>,
) => {
  const liveByPriority = new Map(live.map((rule) => [rule.priority, rule]));
  const desiredPriorities = new Set(desired.map((rule) => rule.priority));
  return {
    add: desired.filter((rule) => !liveByPriority.has(rule.priority)),
    patch: desired.filter((rule) => {
      const current = liveByPriority.get(rule.priority);
      return current !== undefined && comparedRule(current) !== comparedRule(rule);
    }),
    remove: live.flatMap((rule) =>
      rule.priority === undefined ||
      rule.priority === defaultRulePriority ||
      desiredPriorities.has(rule.priority)
        ? []
        : [rule.priority],
    ),
  };
};

const policyDrift = (
  props: EdgeSecurityPolicyProps,
  description: string,
  live: LiveSecurityPolicy,
) => {
  const changes = ruleChanges(props.rules, live.rules ?? []);
  return [
    ...((live.description ?? "") === description ? [] : ["description"]),
    ...changes.add.map((rule) => `rule ${rule.priority} missing`),
    ...changes.patch.map((rule) => `rule ${rule.priority} differs`),
    ...changes.remove.map((priority) => `rule ${priority} undeclared`),
  ];
};

/**
 * The rule as written: `preview` is always sent, false included. A live
 * rule with WAF exclusions the edge never declares gets them cleared.
 */
const ruleBody = (rule: EdgeSecurityPolicyRule, live?: LiveRule) => {
  const written = {
    priority: rule.priority,
    action: rule.action,
    description: rule.description,
    preview: rule.preview,
    match: rule.match,
  };
  const limited =
    rule.rateLimitOptions === undefined
      ? written
      : { ...written, rateLimitOptions: rule.rateLimitOptions };
  return (live?.preconfiguredWafConfig?.exclusions?.length ?? 0) > 0
    ? { ...limited, preconfiguredWafConfig: { exclusions: [] } }
    : limited;
};

const policiesUrl = (project: string) =>
  `${computeRoot}/projects/${project}/global/securityPolicies`;

/**
 * The provider of `EdgeSecurityPolicy`: insert with every rule, then keep
 * the description and rules in step with `addRule`, `patchRule` and
 * `removeRule`, waiting on each global operation.
 */
export const EdgeSecurityPolicyProvider = Provider.succeed(EdgeSecurityPolicy, {
  stables: ["project", "name", "id", "selfLink", "creationTimestamp"],

  diff: Effect.fn(function* ({ news, olds, output }) {
    const previous = olds ?? output;
    if (previous === undefined) {
      return undefined;
    }
    // Identity fields are plain strings; an unresolved one cannot differ yet.
    const changed = (key: "project" | "name" | "type") => {
      return Option.exists(resolvedStringProp(key)(news), (next) => next !== previous[key]);
    };
    if (changed("project") || changed("name")) {
      return { action: "replace" as const, deleteFirst: false };
    }
    if (changed("type")) {
      return { action: "replace" as const, deleteFirst: true };
    }
    return undefined;
  }),

  read: Effect.fn(function* ({ id, olds, output, previous }) {
    const api = yield* makeEdgeComputeApi();
    const project = output?.project ?? olds.project;
    const name = output?.name ?? olds.name;
    const live = yield* api.get(
      `Security policy ${name}`,
      `${policiesUrl(project)}/${name}`,
      LiveSecurityPolicy,
    );
    if (live === undefined) {
      return undefined;
    }
    const attributes = toAttributes(project, live);
    const owned =
      (yield* isOwnedDescription(id, live.description)) ||
      (previous !== undefined && previous.selfLink === live.selfLink);
    return owned ? attributes : Unowned(attributes);
  }),

  reconcile: Effect.fn(function* ({ id, news, output }) {
    const api = yield* makeEdgeComputeApi();
    const { project, name } = news;
    const resource = `Security policy ${name}`;
    const url = `${policiesUrl(project)}/${name}`;
    const description = yield* ownedDescription(id, news.description);
    // Every readback must still be the object admitted below.
    let admittedId: string | undefined;
    const read = (operation: string) =>
      api.get(resource, url, LiveSecurityPolicy).pipe(
        Effect.flatMap((live) => requirePresent(resource, operation, live)),
        Effect.filterOrFail(
          (live) => admittedId === undefined || live.id === admittedId,
          () => new EdgeComputeResourceUnowned({ resource }),
        ),
      );
    // Each write first checks the policy is still the admitted one, and
    // afterwards that its operation changed that one.
    const write = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      read(operation).pipe(
        Effect.andThen(api.mutate(resource, operation, request)),
        Effect.flatMap((pending) => api.settle(resource, project, pending)),
        Effect.flatMap((settled) => requireAdmittedTarget(resource, admittedId, settled)),
      );

    let live = yield* api.get(resource, url, LiveSecurityPolicy);
    if (live === undefined) {
      const inserted = yield* api.insert(resource, policiesUrl(project), {
        name,
        description,
        type: news.type,
        rules: news.rules.map((rule) => ruleBody(rule)),
      });
      // Admitted by the insert's own target ID, or else by the marker: a
      // conflict is ours only after a retried insert that went through.
      const insertedId =
        inserted === "conflict"
          ? undefined
          : (yield* api.settle(resource, project, inserted)).targetId;
      live = yield* read("insert");
      if (!(yield* isAdmitted(id, insertedId, live))) {
        return yield* new EdgeComputeResourceUnowned({ resource });
      }
    } else if (!(yield* isAdmitted(id, output?.id, live))) {
      return yield* new EdgeComputeResourceUnowned({ resource });
    }

    admittedId = live.id;

    if (live.type !== news.type) {
      return yield* new EdgeComputeResourceNotConverged({
        resource,
        fields: ["type"],
      });
    }

    if ((live.description ?? "") !== description) {
      yield* write(
        "patch",
        HttpClientRequest.patch(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            description,
            fingerprint: live.fingerprint,
          }),
        ),
      );
    }
    // Rule methods take no request ID, so each is sent once, after the
    // policy is confirmed still admitted. A lost answer restarts the pass
    // from a fresh read of the policy and its rules, so nothing is replayed
    // blindly against a change that may already apply.
    const ruleWrite = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      read(operation).pipe(
        Effect.andThen(api.mutateOnce(resource, operation, request)),
        Effect.flatMap((pending) => api.settle(resource, project, pending)),
        Effect.flatMap((settled) => requireAdmittedTarget(resource, admittedId, settled)),
      );
    const syncRules = Effect.gen(function* () {
      const current = yield* read("rules");
      const changes = ruleChanges(news.rules, current.rules ?? []);
      for (const rule of changes.add) {
        yield* ruleWrite(
          "addRule",
          HttpClientRequest.post(`${url}/addRule`).pipe(
            HttpClientRequest.bodyJsonUnsafe(ruleBody(rule)),
          ),
        );
      }
      for (const rule of changes.patch) {
        yield* ruleWrite(
          "patchRule",
          HttpClientRequest.post(`${url}/patchRule`).pipe(
            HttpClientRequest.setUrlParam("priority", String(rule.priority)),
            HttpClientRequest.bodyJsonUnsafe(
              ruleBody(
                rule,
                current.rules?.find((candidate) => candidate.priority === rule.priority),
              ),
            ),
          ),
        );
      }
      for (const priority of changes.remove) {
        yield* ruleWrite(
          "removeRule",
          HttpClientRequest.post(`${url}/removeRule`).pipe(
            HttpClientRequest.setUrlParam("priority", String(priority)),
          ),
        );
      }
    });
    for (let pass = 1; ; pass++) {
      const synced = yield* syncRules.pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => pass < ruleSyncPasses && isAmbiguousFailure(error),
          () => Effect.succeed(false),
        ),
      );
      if (synced) {
        break;
      }
    }
    live = yield* read("readback");

    const remaining = policyDrift(news, description, live);
    if (remaining.length > 0) {
      return yield* new EdgeComputeResourceNotConverged({
        resource,
        fields: remaining,
      });
    }
    return toAttributes(project, live);
  }),

  delete: Effect.fn(function* ({ id, output }) {
    const api = yield* makeEdgeComputeApi();
    const resource = `Security policy ${output.name}`;
    const url = `${policiesUrl(output.project)}/${output.name}`;
    // A same-name object someone else recreated is not ours to delete.
    const live = yield* api.get(resource, url, LiveSecurityPolicy);
    if (live === undefined || !(yield* isAdmitted(id, output.id, live))) {
      return;
    }
    const deleted = yield* api.delete(resource, url);
    if (deleted !== "gone") {
      yield* api.settle(resource, output.project, deleted, {
        ignore: ["RESOURCE_NOT_FOUND"],
      });
    }
  }),
});
