import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PreconditionFailed } from "@kvitbit/api-contract";
import type {
  BankAccountInput,
  CurrencyCode,
  IssuingEntityPatch,
  NewWorkspace,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import { type ApiResult, err, type KvitbitApiClient, ok, UiError } from "@kvitbit/ui-port/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Effect } from "effect";
import type { ApiCall, ApiRunner } from "../../runtime/api-runtime";
import { isRequestIntentExpired } from "../../runtime/request-intent";
import {
  makeOnboardingStore,
  type OnboardingFormFields,
  type OnboardingProgress,
  type OnboardingStorage,
  onboardingOwner,
} from "./onboarding-persistence";
import { saveOnboarding } from "./save-onboarding";

const sampleFields = (overrides: Partial<OnboardingFormFields> = {}): OnboardingFormFields => ({
  ico: "12345678",
  name: "Acme",
  slug: "acme",
  dic: "CZ123",
  street: "Main 1",
  city: "Prague",
  postalCode: "11000",
  country: "CZ",
  registerEntry: "",
  taxRegime: "non_vat_payer",
  currency: "CZK" as CurrencyCode,
  docLocale: "en",
  iban: "CZ0000",
  bic: "GIBACZPX",
  ...overrides,
});

const memoryStorage = (): {
  readonly data: Map<string, string>;
  readonly storage: OnboardingStorage;
} => {
  const data = new Map<string, string>();
  return {
    data,
    storage: {
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => {
        data.set(key, value);
      },
      removeItem: async (key) => {
        data.delete(key);
      },
    },
  };
};

const requestIntentSlot = (owner: string, operation: string): string =>
  `kvitbit.request-intent.v1.${createHash("sha256")
    .update(JSON.stringify([owner, operation]))
    .digest("hex")}`;

test("an issuer or bank failure resumes the same workspace across remounts at the failed step", async () => {
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
    origin: "https://kvitbit.test",
    run: async <A, E>(call: ApiCall<A, E>) =>
      Effect.runPromise(call(client)) as Promise<ApiResult<A>>,
  } as ApiRunner;

  const { storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  const scope = { origin: "https://kvitbit.test", userId: "user-remount-1" };
  const fields = sampleFields();
  let progress: OnboardingProgress | null = null;
  const input = {
    workspace: { name: "Acme" } as NewWorkspace,
    issuingEntity: { dic: "CZ123" } as unknown as IssuingEntityPatch,
    bank: { iban: "CZ0000" } as unknown as BankAccountInput,
  };
  const run = () =>
    saveOnboarding(api, input, {
      scope,
      fields,
      progress,
      onProgress: (next) => {
        progress = next;
      },
      store,
    });

  expect((await run()).step).toBe("issuer");
  const afterIssuerFailure = await store.read(scope.origin, scope.userId);
  expect(afterIssuerFailure).not.toBeNull();
  expect(afterIssuerFailure?.step).toBe(1);
  expect(afterIssuerFailure?.progress).toEqual({
    workspace: { id: "workspace-1" as WorkspaceId, slug: "acme" as WorkspaceSlug, revision: 2 },
    issuerSaved: false,
  });
  expect(afterIssuerFailure?.fields.iban).toBe("CZ0000");

  // Simulate remounting the wizard with fresh React state (progress = null).
  progress = null;
  failure = "bank";
  expect((await run()).step).toBe("bank");
  const afterBankFailure = await store.read(scope.origin, scope.userId);
  expect(afterBankFailure).not.toBeNull();
  expect(afterBankFailure?.step).toBe(3);
  expect(afterBankFailure?.progress).toEqual({
    workspace: { id: "workspace-1" as WorkspaceId, slug: "acme" as WorkspaceSlug, revision: 3 },
    issuerSaved: true,
  });
  expect(afterBankFailure?.fields.iban).toBe("CZ0000");

  // Simulate a second remount after bank failure (Finding 4 exact reproduction).
  progress = null;
  failure = null;
  expect((await run()).result._tag).toBe("Ok");
  expect(await store.read(scope.origin, scope.userId)).toBeNull();
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

test.each([true, false])(
  "reconciles a lost issuer response only when the stored patch matches (%s)",
  async (matches) => {
    const workspace = {
      id: "workspace-1" as WorkspaceId,
      revision: 2,
      slug: "acme" as WorkspaceSlug,
    };
    const client = {
      workspace: {
        updateIssuingEntity: () =>
          Effect.succeed(err(new PreconditionFailed({ currentRevision: 3 }))),
        current: () =>
          Effect.succeed(
            ok({
              ...workspace,
              revision: 3,
              issuingEntity: { dic: matches ? "CZ123" : "CZ456" },
            }),
          ),
      },
    } as unknown as KvitbitApiClient;
    const api = {
      origin: "https://kvitbit.test",
      run: async <A, E>(call: ApiCall<A, E>) =>
        Effect.runPromise(call(client)) as Promise<ApiResult<A>>,
    } as ApiRunner;
    const { storage } = memoryStorage();
    const store = makeOnboardingStore(storage);
    const scope = { origin: "https://kvitbit.test", userId: `user-reconcile-${String(matches)}` };
    const progress: OnboardingProgress = { workspace, issuerSaved: false };
    const { result } = await saveOnboarding(
      api,
      {
        workspace: { name: "Acme" } as NewWorkspace,
        issuingEntity: { dic: "CZ123" } as unknown as IssuingEntityPatch,
        bank: null,
      },
      {
        scope,
        fields: sampleFields({ iban: "", bic: "" }),
        progress,
        onProgress: () => undefined,
        store,
      },
    );
    expect(result._tag).toBe(matches ? "Ok" : "Err");
    if (matches) {
      expect(await store.read(scope.origin, scope.userId)).toBeNull();
    } else {
      const persisted = await store.read(scope.origin, scope.userId);
      expect(persisted?.step).toBe(1);
      expect(persisted?.progress?.issuerSaved).toBe(false);
    }
  },
);

test("ambiguous create response preserves incomplete state across remount and replays the create key", async () => {
  const workspace = { id: "workspace-ambig", revision: 1, slug: "acme-ambig" };
  const createKeys: string[] = [];
  const calls: string[] = [];
  let failCreate = true;
  const client = {
    myWorkspaces: {
      create: ({ headers }: { headers: { "idempotency-key": string } }) => {
        calls.push("create");
        createKeys.push(headers["idempotency-key"]);
        return Effect.succeed(failCreate ? err(UiError.offline) : ok(workspace));
      },
    },
    workspace: {
      updateIssuingEntity: () => {
        calls.push("issuer");
        return Effect.succeed(ok({ ...workspace, revision: 2 }));
      },
      createBankAccount: () => {
        calls.push("bank");
        return Effect.succeed(ok({}));
      },
    },
  } as unknown as KvitbitApiClient;
  const api = {
    origin: "https://kvitbit.test",
    run: async <A, E>(call: ApiCall<A, E>) =>
      Effect.runPromise(call(client)) as Promise<ApiResult<A>>,
  } as ApiRunner;

  const { storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  const scope = { origin: "https://kvitbit.test", userId: "user-ambig-create" };
  const fields = sampleFields();
  const input = {
    workspace: { name: "Acme" } as NewWorkspace,
    issuingEntity: { dic: "CZ123" } as unknown as IssuingEntityPatch,
    bank: { iban: "CZ0000" } as unknown as BankAccountInput,
  };

  const first = await saveOnboarding(api, input, {
    scope,
    fields,
    progress: null,
    onProgress: () => undefined,
    store,
  });
  expect(first.step).toBe("workspace");
  expect(first.result._tag).toBe("Err");

  // Incomplete state must remain persisted with progress: null and pending fields.
  const persisted = await store.read(scope.origin, scope.userId);
  expect(persisted).not.toBeNull();
  if (persisted === null) throw new Error("expected persisted onboarding state");
  expect(persisted.progress).toBeNull();
  expect(persisted.step).toBe(3);
  expect(persisted.fields.iban).toBe("CZ0000");

  // Retry after remount reuses the exact same create idempotency key and completes.
  failCreate = false;
  const second = await saveOnboarding(api, input, {
    scope,
    fields: persisted.fields,
    progress: persisted.progress,
    onProgress: () => undefined,
    store,
  });
  expect(second.result._tag).toBe("Ok");
  expect(createKeys[0]).toBeTruthy();
  expect(createKeys[0]).toBe(createKeys[1]);
  expect(calls).toEqual(["create", "create", "issuer", "bank"]);
  expect(await store.read(scope.origin, scope.userId)).toBeNull();
});

test("persistSuccess writes acknowledged state before clearing create/bank keys and retains keys if persistence fails", async () => {
  const workspace = { id: "workspace-persist", revision: 1, slug: "acme-persist" };
  const scope = { origin: "https://kvitbit.test", userId: "user-persist-order" };
  const owner = onboardingOwner(scope.origin, scope.userId);
  const createSlot = requestIntentSlot(owner, "onboard/workspace");
  const bankSlot = requestIntentSlot(owner, `onboard/bank/${workspace.id}`);

  const createKeys: string[] = [];
  const bankKeys: string[] = [];
  const client = {
    myWorkspaces: {
      create: ({ headers }: { headers: { "idempotency-key": string } }) => {
        createKeys.push(headers["idempotency-key"]);
        return Effect.succeed(ok(workspace));
      },
    },
    workspace: {
      createBankAccount: ({ headers }: { headers: { "idempotency-key": string } }) => {
        bankKeys.push(headers["idempotency-key"]);
        return Effect.succeed(ok({}));
      },
    },
  } as unknown as KvitbitApiClient;
  const api = {
    origin: scope.origin,
    run: async <A, E>(call: ApiCall<A, E>) =>
      Effect.runPromise(call(client)) as Promise<ApiResult<A>>,
  } as ApiRunner;

  const { storage } = memoryStorage();
  const baseStore = makeOnboardingStore(storage);
  let failCreatePersist = true;
  let failBankClear = true;
  const observed = {
    createKeyPresentDuringPersist: null as boolean | null,
    bankKeyPresentDuringClear: null as boolean | null,
  };

  const store = {
    read: baseStore.read,
    write: async (state: Parameters<typeof baseStore.write>[0]) => {
      if (state.progress !== null && state.progress.workspace.id === workspace.id) {
        if (failCreatePersist) {
          failCreatePersist = false;
          throw new Error("simulated storage write failure");
        }
        if (observed.createKeyPresentDuringPersist === null) {
          observed.createKeyPresentDuringPersist =
            (await AsyncStorage.getItem(createSlot)) !== null;
        }
      }
      await baseStore.write(state);
    },
    clear: async (origin: string, userId: string) => {
      if (failBankClear) {
        failBankClear = false;
        throw new Error("simulated storage clear failure");
      }
      if (observed.bankKeyPresentDuringClear === null) {
        observed.bankKeyPresentDuringClear = (await AsyncStorage.getItem(bankSlot)) !== null;
      }
      await baseStore.clear(origin, userId);
    },
  };

  const input = {
    workspace: { name: "Acme Persist" } as NewWorkspace,
    issuingEntity: null,
    bank: { iban: "CZ9999" } as unknown as BankAccountInput,
  };
  const fields = sampleFields({ name: "Acme Persist", iban: "CZ9999" });

  // Attempt 1: create succeeds on server, persistSuccess throws -> create key must stay intact.
  const first = await saveOnboarding(api, input, {
    scope,
    fields,
    progress: null,
    onProgress: () => undefined,
    store,
  });
  expect(first.step).toBe("workspace");
  expect(first.result._tag).toBe("Err");
  expect(await AsyncStorage.getItem(createSlot)).not.toBeNull();

  // Attempt 2: create replays the same key, persistSuccess succeeds while create key is still present,
  // then bank succeeds on server, bank persistSuccess throws -> bank key must stay intact.
  const second = await saveOnboarding(api, input, {
    scope,
    fields,
    progress: null,
    onProgress: () => undefined,
    store,
  });
  expect(second.step).toBe("bank");
  expect(second.result._tag).toBe("Err");
  expect(createKeys[0]).toBe(createKeys[1]);
  expect(observed.createKeyPresentDuringPersist).toBe(true);
  expect(await AsyncStorage.getItem(createSlot)).toBeNull();
  expect(await AsyncStorage.getItem(bankSlot)).not.toBeNull();

  // Attempt 3: bank replays the same key, persistSuccess clears onboarding while bank key is still present.
  const third = await saveOnboarding(api, input, {
    scope,
    fields,
    progress: null,
    onProgress: () => undefined,
    store,
  });
  expect(third.result._tag).toBe("Ok");
  expect(bankKeys[0]).toBe(bankKeys[1]);
  expect(observed.bankKeyPresentDuringClear).toBe(true);
  expect(await AsyncStorage.getItem(bankSlot)).toBeNull();
  expect(await baseStore.read(scope.origin, scope.userId)).toBeNull();
});

test("persisted onboarding state is isolated by origin and user", async () => {
  const { storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  await store.write({
    version: 1,
    origin: "https://origin-a.test",
    userId: "user-a",
    step: 3,
    progress: {
      workspace: { id: "ws-a" as WorkspaceId, slug: "a" as WorkspaceSlug, revision: 1 },
      issuerSaved: true,
    },
    fields: sampleFields(),
  });

  expect(await store.read("https://origin-a.test", "user-a")).not.toBeNull();
  expect(await store.read("https://origin-a.test", "user-b")).toBeNull();
  expect(await store.read("https://origin-b.test", "user-a")).toBeNull();
});

test("expired replay window on create or bank returns expired error without resending", async () => {
  const calls: string[] = [];
  const client = {
    myWorkspaces: {
      create: () => {
        calls.push("create");
        return Effect.succeed(ok({ id: "ws-exp", revision: 1, slug: "exp" }));
      },
    },
    workspace: {
      createBankAccount: () => {
        calls.push("bank");
        return Effect.succeed(ok({}));
      },
    },
  } as unknown as KvitbitApiClient;
  const api = {
    origin: "https://kvitbit.test",
    run: async <A, E>(call: ApiCall<A, E>) =>
      Effect.runPromise(call(client)) as Promise<ApiResult<A>>,
  } as ApiRunner;

  const { storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  const scope = { origin: "https://kvitbit.test", userId: "user-expired-bank" };
  const owner = onboardingOwner(scope.origin, scope.userId);
  const workspace = {
    id: "ws-exp" as WorkspaceId,
    revision: 2,
    slug: "exp" as WorkspaceSlug,
  };
  const bank = { iban: "CZ7777" } as unknown as BankAccountInput;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ iban: "CZ7777" }))
    .digest("hex");
  const bankSlot = requestIntentSlot(owner, `onboard/bank/${workspace.id}`);
  await AsyncStorage.setItem(
    bankSlot,
    JSON.stringify({
      [fingerprint]: {
        key: "01900000-0000-7000-8000-000000000001",
        firstAttemptAt: Date.now() - 25 * 60 * 60 * 1000,
      },
    }),
  );

  const outcome = await saveOnboarding(
    api,
    {
      workspace: { name: "Acme" } as NewWorkspace,
      issuingEntity: null,
      bank,
    },
    {
      scope,
      fields: sampleFields({ iban: "CZ7777" }),
      progress: { workspace, issuerSaved: true },
      onProgress: () => undefined,
      store,
    },
  );
  expect(outcome.step).toBe("bank");
  expect(outcome.result._tag).toBe("Err");
  if (outcome.result._tag === "Err") {
    expect(isRequestIntentExpired(outcome.result.error)).toBe(true);
  }
  expect(calls).toEqual([]);
  expect(await store.read(scope.origin, scope.userId)).not.toBeNull();
  await AsyncStorage.removeItem(bankSlot);
});
