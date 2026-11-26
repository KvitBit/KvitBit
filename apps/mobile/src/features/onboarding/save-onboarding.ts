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
  idempotencyHeaders,
  ifMatchHeaders,
  ok,
} from "@kvitbit/ui-port/api";
import type { ApiRunner } from "../../runtime/api-runtime";
import { runRequestIntent } from "../../runtime/request-intent";

export interface OnboardingProgress {
  readonly workspace: WorkspaceView;
  readonly issuerSaved: boolean;
}

const includesPatch = (stored: unknown, patch: unknown): boolean => {
  if (patch === null || typeof patch !== "object") return stored === patch;
  if (stored === null || typeof stored !== "object") return false;
  const fields = stored as Record<string, unknown>;
  return Object.entries(patch).every(([key, value]) => includesPatch(fields[key], value));
};

export const saveOnboarding = async (
  api: ApiRunner,
  owner: string,
  input: {
    readonly workspace: NewWorkspace;
    readonly issuingEntity: IssuingEntityPatch | null;
    readonly bank: BankAccountInput | null;
  },
  progress: OnboardingProgress | null,
  checkpoint: (next: OnboardingProgress) => void,
): Promise<{
  readonly step: "workspace" | "issuer" | "bank";
  readonly result: ApiResult<WorkspaceView>;
}> => {
  if (progress === null) {
    const result = await runRequestIntent(owner, "onboard/workspace", input.workspace, (key) =>
      api.run((client) =>
        client.myWorkspaces.create({
          headers: idempotencyHeaders(key),
          payload: input.workspace,
        }),
      ),
    );
    if (result._tag === "Err") return { step: "workspace", result };
    progress = { workspace: result.value, issuerSaved: false };
    checkpoint(progress);
  }
  const workspaceId = progress.workspace.id as WorkspaceId;
  const issuingEntity = input.issuingEntity;
  if (!progress.issuerSaved && issuingEntity !== null) {
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
    if (result._tag === "Err") return { step: "issuer", result };
    progress = { workspace: result.value, issuerSaved: true };
    checkpoint(progress);
  }
  const bank = input.bank;
  if (bank !== null) {
    const result = await runRequestIntent(owner, `onboard/bank/${workspaceId}`, bank, (key) =>
      api.run((client) =>
        client.workspace.createBankAccount({
          params: { workspaceId },
          headers: idempotencyHeaders(key),
          payload: bank,
        }),
      ),
    );
    if (result._tag === "Err") return { step: "bank", result };
  }
  return { step: "workspace", result: ok(progress.workspace) };
};
