import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  CurrencyCode,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { act, createElement, type ReactElement } from "react";
import { ApiProvider } from "../../runtime/api-runtime";
import { requestIntentReconciliationCopy } from "../../runtime/request-intent";
import { SessionProvider } from "../../session/session-provider";
import { tokenStore } from "../../session/token-store";
import { clientRoot } from "../../testing/client-root";
import { allText, findAll, hostTree } from "../../testing/element-tree";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";
import { uiShim } from "../documents/test-ui-shim";
import { jsonText, requestIntentSlot, sha256 } from "./onboarding.testkit";
import { onboardingOwner, onboardingStore } from "./onboarding-persistence";

const replacements: string[] = [];

function renderRedirect({ href }: { readonly href: string }) {
  return createElement("div", { "data-redirect": href }, `REDIRECT:${href}`);
}

mock.module("expo-router", () => {
  const standIn = expoRouterStandIn();
  return {
    ...standIn,
    Redirect: renderRedirect,
    router: {
      ...standIn.router,
      replace: (href: string) => {
        replacements.push(href);
      },
    },
  };
});

const realUi = { ...(await import("../../ui")) };
const { hrefOf } = await import("../../navigation/routes");
const { OnboardingScreen } = await import("./onboarding-screen");
const { default: Index } = await import("../../../app/index");

const within = (node: ReactElement) => (
  <TestProviders>
    <ApiProvider token={null} origin="https://kvitbit.test">
      <SessionProvider origin="https://kvitbit.test">{node}</SessionProvider>
    </ApiProvider>
  </TestProviders>
);

const root = clientRoot({ keepFetch: true });

const waitFor = (check: () => boolean, label: string) =>
  Effect.runPromise(
    Effect.promise(() => act(() => Effect.runPromise(Effect.sleep("10 millis")))).pipe(
      Effect.repeat({ until: check, times: 200 }),
      Effect.flatMap(() =>
        check() ? Effect.void : Effect.die(new Error(`Timed out waiting for ${label}`)),
      ),
    ),
  );

const inputValue = (element: Element | null) =>
  element instanceof HTMLInputElement ? element.value : null;
const submitButton = () => root.container().querySelector('[data-testid="onboarding-submit"]');
const ibanValue = () =>
  inputValue(root.container().querySelector('[data-testid="onboarding-iban"]'));

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  replacements.length = 0;
  await tokenStore.clear();
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
  await root.render(null);
});

const startFakeServer = (
  userId: string,
  handlers: {
    readonly onBank?: (req: Request) => Response;
    readonly onCreate?: () => Response;
    readonly onIssuer?: () => Response;
    readonly workspaces?: ReadonlyArray<WorkspaceSummary>;
  },
) => {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return Response.json({
          user: {
            id: userId,
            email: `${userId}@example.com`,
            name: "Test User",
            emailVerified: true,
          },
          session: { id: `sess-${userId}` },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/workspaces") {
        calls.push("listMine");
        return Response.json(handlers.workspaces ?? []);
      }
      if (req.method === "POST" && url.pathname === "/api/v1/workspaces") {
        calls.push("create");
        return handlers.onCreate?.() ?? Response.json({}, { status: 500 });
      }
      if (req.method === "PATCH" && Str.endsWith("/issuing-entity")(url.pathname)) {
        calls.push("issuer");
        return handlers.onIssuer?.() ?? Response.json({}, { status: 500 });
      }
      if (req.method === "POST" && Str.endsWith("/bank-accounts")(url.pathname)) {
        calls.push(`bank:${url.pathname}`);
        return handlers.onBank?.(req) ?? Response.json({}, { status: 500 });
      }
      calls.push(`unexpected:${req.method}:${url.pathname}`);
      return Response.json({}, { status: 404 });
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, calls };
};

const signedInTree = (origin: string, node: ReactElement) => (
  <TestProviders>
    <ApiProvider token="test-bearer" origin={origin}>
      <SessionProvider origin={origin}>{node}</SessionProvider>
    </ApiProvider>
  </TestProviders>
);

const RESUME_WS_ID = WorkspaceId.make("01950000-0000-7000-8000-000000000001");
const RESUME_WS_SLUG = WorkspaceSlug.make("acme");

const persistedBankResume = (origin: string, userId: string) => ({
  version: 1 as const,
  origin,
  userId,
  step: 3 as const,
  progress: {
    workspace: { id: RESUME_WS_ID, slug: RESUME_WS_SLUG, revision: 2 },
    issuerSaved: true,
  },
  fields: {
    ico: "12345678",
    name: "Acme s.r.o.",
    slug: "acme",
    dic: "CZ12345678",
    street: "Main 1",
    city: "Prague",
    postalCode: "11000",
    country: "CZ",
    registerEntry: "",
    taxRegime: "non_vat_payer" as const,
    currency: CurrencyCode.make("CZK"),
    docLocale: "en" as const,
    iban: "CZ6508000000192000145399",
    bic: "GIBACZPX",
  },
});

describe("OnboardingScreen", () => {
  test("step 1 shows ARES ICO lookup and business details fields", () => {
    const tree = hostTree(<OnboardingScreen initialStep={1} />, within);
    const text = allText(tree);
    expect(text).toContain("Set up your workspace");
    expect(text).toContain("Step 1 of 3");
    expect(text).toContain("Load from ARES");
    expect(Arr.some(findAll(tree, "TextInput"), (el) => el.props.testID === "onboarding-ico")).toBe(
      true,
    );
  });

  test("step 2 shows tax regime, currency, and language choices", () => {
    const tree = hostTree(<OnboardingScreen initialStep={2} />, within);
    const text = allText(tree);
    expect(text).toContain("Step 2 of 3");
    expect(text).toContain("Tax regime");
    expect(text).toContain("CZK");
    expect(text).toContain("EUR");
  });

  test("step 3 shows optional bank account, no-QR warning, and default numbering preview", () => {
    const tree = hostTree(<OnboardingScreen initialStep={3} />, within);
    const text = allText(tree);
    expect(text).toContain("Step 3 of 3");
    expect(text).toContain("IBAN");
    expect(text).toContain("Without a bank account, invoices print no QR payment code.");
    expect(text).toContain("YYYY-NNNN");
    expect(text).toContain("Create workspace");
  });
});

describe("OnboardingScreen resume and root launcher", () => {
  beforeAll(() => {
    mock.module("../../ui", () => uiShim);
  });
  afterAll(() => {
    mock.module("../../ui", () => realUi);
  });

  test("remounting after a failed bank step resumes at step 3 and skips create and issuer", async () => {
    const userId = "user-screen-resume";
    const { origin, calls } = startFakeServer(userId, {
      onBank: () =>
        Response.json(
          {
            id: "01950000-0000-7000-8000-000000000010",
            workspaceId: RESUME_WS_ID,
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            currency: "CZK",
            isDefault: true,
            archivedAt: null,
          },
          { status: 201 },
        ),
    });
    await tokenStore.write("test-bearer");
    await onboardingStore.write(persistedBankResume(origin, userId));

    await root.render(signedInTree(origin, <OnboardingScreen />));
    await waitFor(() => ibanValue() === "CZ6508000000192000145399", "hydrated step 3 IBAN");

    expect(root.container().textContent).toContain("Step 3 of 3");
    const submit = submitButton();
    expect(submit).not.toBeNull();
    const dashboardHref = hrefOf({ _tag: "Dashboard", ws: RESUME_WS_SLUG });
    await act(() => {
      if (submit instanceof HTMLButtonElement) submit.click();
    });
    await waitFor(() => replacements.includes(dashboardHref), "dashboard navigation");

    expect(calls).toEqual([`bank:/api/v1/workspaces/${RESUME_WS_ID}/bank-accounts`]);
    expect(await onboardingStore.read(origin, userId)).toBeNull();
  });

  test("retrying an expired onboarding request intent surfaces reconciliation copy", async () => {
    const userId = "user-screen-expired";
    const { origin, calls } = startFakeServer(userId, {
      onBank: () => Response.json({}, { status: 201 }),
    });
    await tokenStore.write("test-bearer");
    await onboardingStore.write(persistedBankResume(origin, userId));

    const owner = onboardingOwner({ origin, userId });
    const bankPayload = {
      bic: "GIBACZPX",
      currency: "CZK",
      iban: "CZ6508000000192000145399",
      isDefault: true,
    };
    const fingerprint = await sha256(jsonText(bankPayload));
    const slot = await requestIntentSlot([owner, `onboard/bank/${RESUME_WS_ID}`]);
    await AsyncStorage.setItem(
      slot,
      jsonText({
        [fingerprint]: {
          key: "01900000-0000-7000-8000-000000000002",
          firstAttemptAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) - 25 * 60 * 60 * 1000,
        },
      }),
    );

    try {
      await root.render(signedInTree(origin, <OnboardingScreen />));
      await waitFor(() => ibanValue() === "CZ6508000000192000145399", "hydrated expired screen");

      const submit = submitButton();
      await act(() => {
        if (submit instanceof HTMLButtonElement) submit.click();
      });
      await waitFor(
        () => Str.includes(requestIntentReconciliationCopy.en)(root.container().textContent ?? ""),
        "expiry reconciliation copy",
      );

      expect(calls).toEqual([]);
      expect(await onboardingStore.read(origin, userId)).not.toBeNull();
    } finally {
      await AsyncStorage.removeItem(slot);
      await onboardingStore.clear(origin, userId);
    }
  });

  test("root launcher resumes incomplete onboarding before opening the workspace dashboard", async () => {
    const userId = "user-launcher-resume";
    const { origin } = startFakeServer(userId, {
      workspaces: [
        {
          id: RESUME_WS_ID,
          slug: RESUME_WS_SLUG,
          name: "Acme s.r.o.",
          role: "owner",
          memberCount: 1,
          taxRegime: "non_vat_payer",
          closed: false,
        },
      ],
    });
    await tokenStore.write("test-bearer");
    await onboardingStore.write(persistedBankResume(origin, userId));

    try {
      await root.render(signedInTree(origin, <Index />));
      await waitFor(
        () =>
          root.container().querySelector("[data-redirect]")?.getAttribute("data-redirect") ===
          "/onboarding",
        "redirect to /onboarding",
      );

      // Once onboarding is cleared, relaunch opens the workspace dashboard.
      const dashboardHref = hrefOf({ _tag: "Dashboard", ws: RESUME_WS_SLUG });
      await onboardingStore.clear(origin, userId);
      await root.render(null);
      await root.render(signedInTree(origin, <Index />));
      await waitFor(
        () =>
          root.container().querySelector("[data-redirect]")?.getAttribute("data-redirect") ===
          dashboardHref,
        `redirect to ${dashboardHref}`,
      );
      expect(root.container().querySelector("[data-redirect]")?.getAttribute("data-redirect")).toBe(
        dashboardHref,
      );
    } finally {
      await onboardingStore.clear(origin, userId);
    }
  });
});
