import { afterEach, expect, test } from "bun:test";
import {
  BankAccountInput,
  CurrencyCode,
  IssuingEntityPatch,
  NewWorkspace,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import { sessionCookie } from "@kvitbit/ui-port/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { makeApiRunner } from "../../runtime/api-runtime";
import { isRequestIntentExpired } from "../../runtime/request-intent";
import { jsonText, requestIntentSlot, sha256 } from "./onboarding.testkit";
import {
  makeOnboardingStore,
  type OnboardingFormFields,
  type OnboardingProgress,
  type OnboardingStorage,
  onboardingOwner,
} from "./onboarding-persistence";
import { saveOnboarding } from "./save-onboarding";

const WORKSPACE_ID = WorkspaceId.make("01950000-0000-7000-8000-000000000001");
const OTHER_WORKSPACE_ID = WorkspaceId.make("01950000-0000-7000-8000-000000000002");
const WORKSPACE_SLUG = WorkspaceSlug.make("acme");
const branding = {
  pdfTemplate: "classic",
  accentColor: "#1F5FAF",
  footerText: null,
  theme: null,
  logo: null,
  stamp: null,
};
const unavailable = () =>
  Response.json({ _tag: "Unavailable", dependency: "database" }, { status: 503 });
const TRAILING_SLASH = /\/$/;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Effect.runPromise(
    Effect.forEach(cleanups.splice(0), (cleanup) => Effect.promise(cleanup), { concurrency: 1 }),
  );
});

const startApi = (handlers: {
  readonly create?: (request: Request) => Response;
  readonly issuer?: (request: Request) => Response;
  readonly current?: () => Response;
  readonly bank?: (request: Request) => Response;
}) => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = Str.replace(TRAILING_SLASH, "")(new URL(request.url).pathname);
      if (request.method === "POST" && path === "/api/v1/workspaces") {
        return handlers.create?.(request) ?? unavailable();
      }
      if (request.method === "PATCH" && Str.endsWith("/issuing-entity")(path)) {
        return handlers.issuer?.(request) ?? unavailable();
      }
      if (request.method === "POST" && Str.endsWith("/bank-accounts")(path)) {
        return handlers.bank?.(request) ?? unavailable();
      }
      if (request.method === "GET" && Str.startsWith("/api/v1/workspaces/")(path)) {
        return handlers.current?.() ?? unavailable();
      }
      return Response.json({}, { status: 404 });
    },
  });
  const api = makeApiRunner(`http://127.0.0.1:${server.port}`, sessionCookie, () => "en");
  cleanups.push(() => {
    server.stop(true);
    return api.dispose();
  });
  return api;
};

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
  currency: CurrencyCode.make("CZK"),
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
      getItem: (key) => Effect.runPromise(Effect.sync(() => data.get(key) ?? null)),
      setItem: (key, value) =>
        Effect.runPromise(
          Effect.sync(() => {
            data.set(key, value);
          }),
        ),
      removeItem: (key) =>
        Effect.runPromise(
          Effect.sync(() => {
            data.delete(key);
          }),
        ),
    },
  };
};

test("an issuer or bank failure resumes the same workspace across remounts at the failed step", async () => {
  const workspace = { id: WORKSPACE_ID, revision: 2, slug: "acme", branding };
  const calls: string[] = [];
  const bankKeys: string[] = [];
  let failure: "issuer" | "bank" | null = "issuer";
  const api = startApi({
    create: () => {
      calls.push("create");
      return Response.json(workspace, { status: 201 });
    },
    issuer: () => {
      calls.push(`issuer:${workspace.id}`);
      return failure === "issuer" ? unavailable() : Response.json({ ...workspace, revision: 3 });
    },
    bank: (request) => {
      calls.push(`bank:${workspace.id}`);
      bankKeys.push(request.headers.get("idempotency-key") ?? "");
      return failure === "bank" ? unavailable() : Response.json({}, { status: 201 });
    },
  });

  const { storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  const scope = { origin: api.origin, userId: "user-remount-1" };
  const fields = sampleFields();
  let progress: OnboardingProgress | null = null;
  const input = {
    workspace: NewWorkspace.make({ name: "Acme" }),
    issuingEntity: IssuingEntityPatch.make({ dic: "CZ123" }),
    bank: BankAccountInput.make({ iban: "CZ0000" }),
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
    workspace: { id: WORKSPACE_ID, slug: WORKSPACE_SLUG, revision: 2 },
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
    workspace: { id: WORKSPACE_ID, slug: WORKSPACE_SLUG, revision: 3 },
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
    `issuer:${WORKSPACE_ID}`,
    `issuer:${WORKSPACE_ID}`,
    `bank:${WORKSPACE_ID}`,
    `bank:${WORKSPACE_ID}`,
  ]);
  expect(bankKeys[0]).toBeTruthy();
  expect(bankKeys[0]).toBe(bankKeys[1]);
});

test.each([true, false])(
  "reconciles a lost issuer response only when the stored patch matches (%s)",
  async (matches) => {
    const workspace = {
      id: WORKSPACE_ID,
      revision: 2,
      slug: WORKSPACE_SLUG,
    };
    const api = startApi({
      issuer: () =>
        Response.json({ _tag: "PreconditionFailed", currentRevision: 3 }, { status: 412 }),
      current: () =>
        Response.json({
          ...workspace,
          revision: 3,
          branding,
          issuingEntity: {
            dic: "CZ123",
            address: { city: matches ? "Prague" : "Brno", country: "CZ" },
          },
        }),
    });
    const { storage } = memoryStorage();
    const store = makeOnboardingStore(storage);
    const scope = { origin: api.origin, userId: `user-reconcile-${String(matches)}` };
    const progress: OnboardingProgress = { workspace, issuerSaved: false };
    const { result } = await saveOnboarding(
      api,
      {
        workspace: NewWorkspace.make({ name: "Acme" }),
        issuingEntity: IssuingEntityPatch.make({ dic: "CZ123", address: { city: "Prague" } }),
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
    const persisted = await store.read(scope.origin, scope.userId);
    expect(persisted?.step ?? null).toBe(matches ? null : 1);
    expect(persisted?.progress?.issuerSaved ?? null).toBe(matches ? null : false);
  },
);

test("ambiguous create response preserves incomplete state across remount and replays the create key", async () => {
  const workspace = { id: WORKSPACE_ID, revision: 1, slug: "acme-ambig", branding };
  const createKeys: string[] = [];
  const calls: string[] = [];
  const api = startApi({
    create: (request) => {
      calls.push("create");
      createKeys.push(request.headers.get("idempotency-key") ?? "");
      return createKeys.length === 1 ? unavailable() : Response.json(workspace, { status: 201 });
    },
    issuer: () => {
      calls.push("issuer");
      return Response.json({ ...workspace, revision: 2 });
    },
    bank: () => {
      calls.push("bank");
      return Response.json({}, { status: 201 });
    },
  });

  const { storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  const scope = { origin: api.origin, userId: "user-ambig-create" };
  const fields = sampleFields();
  const input = {
    workspace: NewWorkspace.make({ name: "Acme" }),
    issuingEntity: IssuingEntityPatch.make({ dic: "CZ123" }),
    bank: BankAccountInput.make({ iban: "CZ0000" }),
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
  const workspace = { id: WORKSPACE_ID, revision: 1, slug: "acme-persist", branding };
  const createKeys: string[] = [];
  const bankKeys: string[] = [];
  const api = startApi({
    create: (request) => {
      createKeys.push(request.headers.get("idempotency-key") ?? "");
      return Response.json(workspace, { status: 201 });
    },
    bank: (request) => {
      bankKeys.push(request.headers.get("idempotency-key") ?? "");
      return Response.json({}, { status: 201 });
    },
  });
  const scope = { origin: api.origin, userId: "user-persist-order" };
  const owner = onboardingOwner(scope);
  const createSlot = await requestIntentSlot([owner, "onboard/workspace"]);
  const bankSlot = await requestIntentSlot([owner, `onboard/bank/${workspace.id}`]);

  const { storage } = memoryStorage();
  const baseStore = makeOnboardingStore(storage);
  let failCreatePersist = true;
  let failBankClear = true;
  let createKeyPresentDuringPersist: boolean | null = null;
  let bankKeyPresentDuringClear: boolean | null = null;

  const store = {
    read: baseStore.read,
    write: async (state: Parameters<typeof baseStore.write>[0]) => {
      if (state.progress !== null && state.progress.workspace.id === workspace.id) {
        if (failCreatePersist) {
          failCreatePersist = false;
          throw new Error("simulated storage write failure");
        }
        if (createKeyPresentDuringPersist === null) {
          createKeyPresentDuringPersist = (await AsyncStorage.getItem(createSlot)) !== null;
        }
      }
      await baseStore.write(state);
    },
    clear: async (origin: string, userId: string) => {
      if (failBankClear) {
        failBankClear = false;
        throw new Error("simulated storage clear failure");
      }
      if (bankKeyPresentDuringClear === null) {
        bankKeyPresentDuringClear = (await AsyncStorage.getItem(bankSlot)) !== null;
      }
      await baseStore.clear(origin, userId);
    },
  };

  const input = {
    workspace: NewWorkspace.make({ name: "Acme Persist" }),
    issuingEntity: null,
    bank: BankAccountInput.make({ iban: "CZ9999" }),
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
  expect<boolean | null>(createKeyPresentDuringPersist).toBe(true);
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
  expect<boolean | null>(bankKeyPresentDuringClear).toBe(true);
  expect(await AsyncStorage.getItem(bankSlot)).toBeNull();
  expect(await baseStore.read(scope.origin, scope.userId)).toBeNull();
});

test("persisted onboarding state is isolated by origin and user", async () => {
  const { data, storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  const persisted = {
    version: 1,
    origin: "https://origin-a.test",
    userId: "user-a",
    step: 3,
    progress: {
      workspace: { id: WORKSPACE_ID, slug: WorkspaceSlug.make("abc"), revision: 1 },
      issuerSaved: true,
    },
    fields: sampleFields(),
  } satisfies Parameters<typeof store.write>[0];
  data.set('kvitbit.onboarding-resume.v1.["https://origin-a.test","user-a"]', jsonText(persisted));

  expect(await store.read("https://origin-a.test", "user-a")).toEqual(persisted);
  expect(await store.read("https://origin-a.test", "user-b")).toBeNull();
  expect(await store.read("https://origin-b.test", "user-a")).toBeNull();
});

test("expired replay window on create or bank returns expired error without resending", async () => {
  const calls: string[] = [];
  const api = startApi({
    create: () => {
      calls.push("create");
      return Response.json({}, { status: 201 });
    },
    bank: () => {
      calls.push("bank");
      return Response.json({}, { status: 201 });
    },
  });

  const { storage } = memoryStorage();
  const store = makeOnboardingStore(storage);
  const scope = { origin: api.origin, userId: "user-expired-bank" };
  const owner = onboardingOwner(scope);
  const workspace = {
    id: OTHER_WORKSPACE_ID,
    revision: 2,
    slug: WorkspaceSlug.make("exp"),
  };
  const bank = BankAccountInput.make({ iban: "CZ7777" });
  const fingerprint = await sha256(jsonText({ iban: "CZ7777" }));
  const bankSlot = await requestIntentSlot([owner, `onboard/bank/${workspace.id}`]);
  await AsyncStorage.setItem(
    bankSlot,
    jsonText({
      [fingerprint]: {
        key: "01900000-0000-7000-8000-000000000001",
        firstAttemptAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) - 25 * 60 * 60 * 1000,
      },
    }),
  );

  const outcome = await saveOnboarding(
    api,
    {
      workspace: NewWorkspace.make({ name: "Acme" }),
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
  expect(outcome.result._tag === "Err" && isRequestIntentExpired(outcome.result.error)).toBe(true);
  expect(calls).toEqual([]);
  expect(await store.read(scope.origin, scope.userId)).not.toBeNull();
  await AsyncStorage.removeItem(bankSlot);
});
