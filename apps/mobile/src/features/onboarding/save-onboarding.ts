import type {
  BankAccountInput,
  IssuingEntityPatch,
  NewWorkspace,
  WorkspaceId,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import {
  type ApiResult,
  describeError,
  err,
  idempotencyHeaders,
  ifMatchHeaders,
  ok,
  UiError,
} from "@kvitbit/ui-port/api";
import type { ApiRunner } from "../../runtime/api-runtime";
import {
  isRequestIntentExpired,
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

export type {
  OnboardingFormFields,
  OnboardingProgress,
  OnboardingScope,
  OnboardingStep,
  OnboardingStore,
  OnboardingWorkspaceRef,
  PersistedOnboarding,
} from "./onboarding-persistence";

const toWorkspaceRef = (workspace: WorkspaceView): OnboardingWorkspaceRef => ({
  id: workspace.id as WorkspaceId,
  slug: workspace.slug,
  revision: workspace.revision,
});

const includesPatch = (stored: unknown, patch: unknown): boolean => {
  if (patch === null || typeof patch !== "object") return stored === patch;
  if (stored === null || typeof stored !== "object") return false;
  const fields = stored as Record<string, unknown>;
  return Object.entries(patch).every(([key, value]) => includesPatch(fields[key], value));
};

export interface SaveOnboardingOptions {
  readonly scope: OnboardingScope;
  readonly fields: OnboardingFormFields;
  readonly step?: OnboardingStep;
  readonly progress: OnboardingProgress | null;
  readonly onProgress: (next: OnboardingProgress | null) => void;
  readonly store?: OnboardingStore;
}

export const saveOnboarding = async (
  api: ApiRunner,
  input: {
    readonly workspace: NewWorkspace;
    readonly issuingEntity: IssuingEntityPatch | null;
    readonly bank: BankAccountInput | null;
  },
  options: SaveOnboardingOptions,
): Promise<{
  readonly step: "workspace" | "issuer" | "bank";
  readonly result: ApiResult<OnboardingWorkspaceRef>;
}> => {
  const { scope, fields, onProgress } = options;
  const store = options.store ?? onboardingStore;
  const owner = onboardingOwner(scope.origin, scope.userId);

  const persistState = async (
    nextProgress: OnboardingProgress | null,
    nextStep: OnboardingStep,
  ): Promise<void> => {
    await store.write({
      version: 1,
      origin: scope.origin,
      userId: scope.userId,
      step: nextStep,
      progress: nextProgress,
      fields,
    });
    onProgress(nextProgress);
  };

  const clearState = async (): Promise<void> => {
    await store.clear(scope.origin, scope.userId);
    onProgress(null);
  };

  let progress =
    options.progress ?? (await store.read(scope.origin, scope.userId))?.progress ?? null;
  if (progress !== null && options.progress === null) {
    onProgress(progress);
  }

  if (progress === null) {
    try {
      await persistState(null, options.step ?? 3);
    } catch {
      return { step: "workspace", result: err(UiError.offline) };
    }

    const needsIssuer = input.issuingEntity !== null;
    const needsBank = input.bank !== null;
    const result = await runRequestIntent(
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
      async (workspace) => {
        const next: OnboardingProgress = {
          workspace: toWorkspaceRef(workspace),
          issuerSaved: !needsIssuer,
        };
        if (!needsIssuer && !needsBank) {
          await clearState();
        } else {
          await persistState(next, 3);
        }
        progress = next;
      },
    );
    if (result._tag === "Err") {
      if (!isRequestIntentExpired(result.error) && settlesRequestIntent(result)) {
        await clearState().catch(() => undefined);
      }
      return { step: "workspace", result };
    }
    if (progress === null) {
      progress = {
        workspace: toWorkspaceRef(result.value),
        issuerSaved: !needsIssuer,
      };
    }
  }

  const workspaceId = progress.workspace.id;
  const issuingEntity = input.issuingEntity;
  if (!progress.issuerSaved && issuingEntity !== null) {
    try {
      await persistState(progress, 3);
    } catch {
      return { step: "issuer", result: err(UiError.offline) };
    }

    const revision = progress.workspace.revision;
    let result = await api.run((client) =>
      client.workspace.updateIssuingEntity({
        params: { workspaceId },
        headers: ifMatchHeaders(revision),
        payload: issuingEntity,
      }),
    );
    if (result._tag === "Err" && describeError(result.error).staleRevision) {
      // The PATCH may have committed before its response was lost. Continue only
      // if the current entity already contains every edit from this attempt.
      const current = await api.run((client) =>
        client.workspace.current({ params: { workspaceId } }),
      );
      if (current._tag === "Ok" && includesPatch(current.value.issuingEntity, issuingEntity)) {
        result = current;
      }
    }
    if (result._tag === "Err") {
      await persistState(progress, 1).catch(() => undefined);
      return { step: "issuer", result };
    }
    const next: OnboardingProgress = {
      workspace: toWorkspaceRef(result.value),
      issuerSaved: true,
    };
    try {
      if (input.bank === null) {
        await clearState();
      } else {
        await persistState(next, 3);
      }
    } catch {
      return { step: "issuer", result: err(UiError.offline) };
    }
    progress = next;
  }

  const bank = input.bank;
  if (bank !== null) {
    try {
      await persistState(progress, 3);
    } catch {
      return { step: "bank", result: err(UiError.offline) };
    }

    const result = await runRequestIntent(
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
      async () => {
        await clearState();
      },
    );
    if (result._tag === "Err") return { step: "bank", result };
    return { step: "workspace", result: ok(progress.workspace) };
  }

  await clearState().catch(() => undefined);
  return { step: "workspace", result: ok(progress.workspace) };
};
