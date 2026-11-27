import type {
  BankAccountInput,
  IssuingEntityPatch,
  NewWorkspace,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import { WorkspaceId } from "@kvitbit/domain/contract";
import {
  type ApiResult,
  describeError,
  err,
  idempotencyHeaders,
  ifMatchHeaders,
  ok,
  UiError,
} from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ApiRunner } from "../../runtime/api-runtime";
import {
  fromMobilePromise,
  isRequestIntentExpired,
  runMobileEffect,
  runRequestIntent,
  settlesRequestIntent,
} from "../../runtime/request-intent";
import {
  type OnboardingFormFields,
  type OnboardingProgress,
  type OnboardingScope,
  type OnboardingStep,
  type OnboardingStore,
  type OnboardingWorkspaceRef,
  onboardingOwner,
  onboardingStore,
} from "./onboarding-persistence";

const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);

const toWorkspaceRef = Effect.fn("Onboarding.workspaceRef")(function* (workspace: WorkspaceView) {
  const id = yield* decodeWorkspaceId(workspace["id"]);
  return { id, slug: workspace.slug, revision: workspace.revision };
});

const decodeJsonObject = Schema.decodeUnknownResult(Schema.JsonObject);
const includesPatch = (stored: Schema.Json, patch: Schema.Json): boolean => {
  const expected = decodeJsonObject(patch);
  if (Result.isFailure(expected)) return stored === patch;
  const actual = decodeJsonObject(stored);
  return (
    Result.isSuccess(actual) &&
    Arr.every(Rec.toEntries(expected.success), ([key, value]) => {
      const current = actual.success[key];
      return current !== undefined && includesPatch(current, value);
    })
  );
};
const isJson = Schema.is(Schema.Json);

export interface SaveOnboardingOptions {
  readonly scope: OnboardingScope;
  readonly fields: OnboardingFormFields;
  readonly step?: OnboardingStep;
  readonly progress: OnboardingProgress | null;
  readonly onProgress: (next: OnboardingProgress | null) => void;
  readonly store?: OnboardingStore;
}

const save = Effect.fn("Onboarding.save")(function* (
  api: ApiRunner,
  input: {
    readonly workspace: NewWorkspace;
    readonly issuingEntity: IssuingEntityPatch | null;
    readonly bank: BankAccountInput | null;
  },
  options: SaveOnboardingOptions,
) {
  const { scope, fields, onProgress } = options;
  const store = options.store ?? onboardingStore;
  const owner = onboardingOwner(scope);
  const persistState = Effect.fn("Onboarding.persistState")(function* (
    nextProgress: OnboardingProgress | null,
    nextStep: OnboardingStep,
  ) {
    yield* fromMobilePromise(() =>
      store.write({
        version: 1,
        origin: scope.origin,
        userId: scope.userId,
        step: nextStep,
        progress: nextProgress,
        fields,
      }),
    );
    onProgress(nextProgress);
  });

  const clearState = Effect.fn("Onboarding.clearState")(function* () {
    yield* fromMobilePromise(() => store.clear(scope.origin, scope.userId));
    onProgress(null);
  });

  let progress = options.progress;
  if (progress === null) {
    const persisted = yield* fromMobilePromise(() => store.read(scope.origin, scope.userId));
    progress = persisted?.progress ?? null;
  }
  if (progress !== null && options.progress === null) {
    onProgress(progress);
  }

  if (progress === null) {
    const persisted = yield* Effect.result(persistState(null, options.step ?? 3));
    if (Result.isFailure(persisted)) {
      return { step: "workspace" as const, result: err(UiError.offline) };
    }

    const needsIssuer = input.issuingEntity !== null;
    const needsBank = input.bank !== null;
    const result = yield* Effect.promise(() =>
      runRequestIntent(
        owner,
        "onboard/workspace",
        input.workspace,
        (key) =>
          api.run((client) =>
            client.myWorkspaces.create({
              headers: idempotencyHeaders(key),
              payload: input.workspace,
            }),
          ),
        (workspace) =>
          runMobileEffect(
            toWorkspaceRef(workspace).pipe(
              Effect.flatMap((ref) => {
                const next: OnboardingProgress = { workspace: ref, issuerSaved: !needsIssuer };
                return (needsIssuer || needsBank ? persistState(next, 3) : clearState()).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      progress = next;
                    }),
                  ),
                );
              }),
            ),
          ),
      ),
    );
    if (result._tag === "Err") {
      if (!isRequestIntentExpired(result.error) && settlesRequestIntent(result)) {
        yield* Effect.ignore(clearState());
      }
      return { step: "workspace" as const, result };
    }
    if (progress === null) {
      progress = {
        workspace: yield* toWorkspaceRef(result.value),
        issuerSaved: !needsIssuer,
      };
    }
  }

  const workspaceId = progress.workspace.id;
  const issuingEntity = input.issuingEntity;
  if (!progress.issuerSaved && issuingEntity !== null) {
    const persisted = yield* Effect.result(persistState(progress, 3));
    if (Result.isFailure(persisted)) {
      return { step: "issuer" as const, result: err(UiError.offline) };
    }

    const revision = progress.workspace.revision;
    let result = yield* Effect.promise(() =>
      api.run((client) =>
        client.workspace.updateIssuingEntity({
          params: { workspaceId },
          headers: ifMatchHeaders(revision),
          payload: issuingEntity,
        }),
      ),
    );
    if (result._tag === "Err" && describeError(result.error).staleRevision) {
      // The PATCH may have committed before its response was lost. Continue only
      // if the current entity already contains every edit from this attempt.
      const current = yield* Effect.promise(() =>
        api.run((client) => client.workspace.current({ params: { workspaceId } })),
      );
      if (
        current._tag === "Ok" &&
        isJson(current.value["issuingEntity"]) &&
        isJson(issuingEntity) &&
        includesPatch(current.value["issuingEntity"], issuingEntity)
      ) {
        result = current;
      }
    }
    if (result._tag === "Err") {
      yield* Effect.ignore(persistState(progress, 1));
      return { step: "issuer" as const, result };
    }
    const next: OnboardingProgress = {
      workspace: yield* toWorkspaceRef(result.value),
      issuerSaved: true,
    };
    const updated = yield* Effect.result(
      input.bank === null ? clearState() : persistState(next, 3),
    );
    if (Result.isFailure(updated)) {
      return { step: "issuer" as const, result: err(UiError.offline) };
    }
    progress = next;
  }

  const bank = input.bank;
  if (bank !== null) {
    const persisted = yield* Effect.result(persistState(progress, 3));
    if (Result.isFailure(persisted)) {
      return { step: "bank" as const, result: err(UiError.offline) };
    }

    const result = yield* Effect.promise(() =>
      runRequestIntent(
        owner,
        `onboard/bank/${workspaceId}`,
        bank,
        (key) =>
          api.run((client) =>
            client.workspace.createBankAccount({
              params: { workspaceId },
              headers: idempotencyHeaders(key),
              payload: bank,
            }),
          ),
        () => runMobileEffect(clearState()),
      ),
    );
    if (result._tag === "Err") return { step: "bank" as const, result };
    return { step: "workspace" as const, result: ok(progress.workspace) };
  }

  yield* Effect.ignore(clearState());
  return { step: "workspace" as const, result: ok(progress.workspace) };
});

export const saveOnboarding = (
  ...args: Parameters<typeof save>
): Promise<{
  readonly step: "workspace" | "issuer" | "bank";
  readonly result: ApiResult<OnboardingWorkspaceRef>;
}> =>
  runMobileEffect(
    save(...args).pipe(
      Effect.orElseSucceed(() => ({ step: "workspace" as const, result: err(UiError.offline) })),
    ),
  );
