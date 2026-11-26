import { expect, test } from "bun:test";
import type { BankAccountInput, IssuingEntityPatch, NewWorkspace } from "@kvitbit/domain/contract";
import { type ApiResult, err, type KvitbitApiClient, ok, UiError } from "@kvitbit/ui-port/api";
import { Effect } from "effect";
import type { ApiCall, ApiRunner } from "../../runtime/api-runtime";
import { type OnboardingProgress, saveOnboarding } from "./save-onboarding";

test("an issuer or bank failure resumes the same workspace at the failed step", async () => {
  const workspace = { id: "workspace-1", revision: 2, slug: "acme" };
  const calls: string[] = [];
  const bankKeys: string[] = [];
  let failure: "issuer" | "bank" | null = "issuer";
  const client = {
    myWorkspaces: {
      create: () => {
        calls.push("create");
        return Effect.succeed(ok(workspace));
      },
    },
    workspace: {
      updateIssuingEntity: ({ params }: { params: { workspaceId: string } }) => {
        calls.push(`issuer:${params.workspaceId}`);
        return Effect.succeed(
          failure === "issuer" ? err(UiError.offline) : ok({ ...workspace, revision: 3 }),
        );
      },
      createBankAccount: ({
        params,
        headers,
      }: {
        params: { workspaceId: string };
        headers: { "idempotency-key": string };
      }) => {
        calls.push(`bank:${params.workspaceId}`);
        bankKeys.push(headers["idempotency-key"]);
        return Effect.succeed(failure === "bank" ? err(UiError.offline) : ok({}));
      },
    },
  } as unknown as KvitbitApiClient;
  const api = {
    run: async <A, E>(call: ApiCall<A, E>) =>
      Effect.runPromise(call(client)) as Promise<ApiResult<A>>,
  } as ApiRunner;
  let progress: OnboardingProgress | null = null;
  const input = {
    workspace: { name: "Acme" } as NewWorkspace,
    issuingEntity: { dic: "CZ123" } as unknown as IssuingEntityPatch,
    bank: { iban: "CZ0000" } as unknown as BankAccountInput,
  };
  const run = () =>
    saveOnboarding(api, "signed-in-test-user", input, progress, (next) => {
      progress = next;
    });
  expect((await run()).step).toBe("issuer");
  failure = "bank";
  expect((await run()).step).toBe("bank");
  failure = null;
  expect((await run()).result._tag).toBe("Ok");
  expect(calls).toEqual([
    "create",
    "issuer:workspace-1",
    "issuer:workspace-1",
    "bank:workspace-1",
    "bank:workspace-1",
  ]);
  expect(bankKeys[0]).toBeTruthy();
  expect(bankKeys[0]).toBe(bankKeys[1]);
});
