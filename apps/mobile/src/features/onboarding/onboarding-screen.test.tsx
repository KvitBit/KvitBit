import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CurrencyCode, WorkspaceId, WorkspaceSlug } from "@kvitbit/domain/contract";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
import { onboardingOwner, onboardingStore } from "./onboarding-persistence";

const replacements: string[] = [];
const TestRedirect = ({ href }: { readonly href: string }) =>
  createElement("div", { "data-redirect": href }, `REDIRECT:${href}`);

mock.module("expo-router", () => {
  const standIn = expoRouterStandIn();
  return {
    ...standIn,
    Redirect: TestRedirect,
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

const waitFor = async (check: () => boolean, label = "condition"): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
};

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
    readonly workspaces?: ReadonlyArray<Record<string, unknown>>;
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
      if (req.method === "PATCH" && url.pathname.endsWith("/issuing-entity")) {
        calls.push("issuer");
        return handlers.onIssuer?.() ?? Response.json({}, { status: 500 });
      }
      if (req.method === "POST" && url.pathname.endsWith("/bank-accounts")) {
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

const RESUME_WS_ID = "01950000-0000-7000-8000-000000000001" as WorkspaceId;
const RESUME_WS_SLUG = "acme" as WorkspaceSlug;

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
    currency: "CZK" as CurrencyCode,
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
    expect(findAll(tree, "TextInput").some((el) => el.props.testID === "onboarding-ico")).toBe(
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

  test("step 1 splits a pasted full address across empty address inputs", async () => {
    const userId = "user-paste-address";
    const { origin } = startFakeServer(userId, {});
    await tokenStore.write("test-bearer");
    await root.render(signedInTree(origin, <OnboardingScreen initialStep={1} />));

    const input = (id: string) =>
      root.container().querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;
    await waitFor(() => input("onboarding-street") !== null, "onboarding street input");

    const setValue = async (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setter?.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    const streetEl = input("onboarding-street");
    const cityEl = input("onboarding-city");
    const postalEl = input("onboarding-postal");
    if (streetEl === null || cityEl === null || postalEl === null) {
      throw new Error("missing onboarding address inputs");
    }

    await setValue(streetEl, "Jankovcova 1522/53, 170 00 Praha 7");
    expect(streetEl.value).toBe("Jankovcova 1522/53");
    expect(cityEl.value).toBe("Praha 7");
    expect(postalEl.value).toBe("170 00");
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
    await waitFor(
      () =>
        (
          root
            .container()
            .querySelector('[data-testid="onboarding-iban"]') as HTMLInputElement | null
        )?.value === "CZ6508000000192000145399",
      "hydrated step 3 IBAN",
    );

    expect(root.container().textContent).toContain("Step 3 of 3");
    const submit = root
      .container()
      .querySelector('[data-testid="onboarding-submit"]') as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    const dashboardHref = hrefOf({ _tag: "Dashboard", ws: RESUME_WS_SLUG });
    await act(async () => {
      submit?.click();
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

    const owner = onboardingOwner(origin, userId);
    const bankPayload = {
      bic: "GIBACZPX",
      currency: "CZK",
      iban: "CZ6508000000192000145399",
      isDefault: true,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(bankPayload)).digest("hex");
    const slot = `kvitbit.request-intent.v1.${createHash("sha256")
      .update(JSON.stringify([owner, `onboard/bank/${RESUME_WS_ID}`]))
      .digest("hex")}`;
    await AsyncStorage.setItem(
      slot,
      JSON.stringify({
        [fingerprint]: {
          key: "01900000-0000-7000-8000-000000000002",
          firstAttemptAt: Date.now() - 25 * 60 * 60 * 1000,
        },
      }),
    );

    try {
      await root.render(signedInTree(origin, <OnboardingScreen />));
      await waitFor(
        () =>
          (
            root
              .container()
              .querySelector('[data-testid="onboarding-iban"]') as HTMLInputElement | null
          )?.value === "CZ6508000000192000145399",
        "hydrated expired screen",
      );

      const submit = root
        .container()
        .querySelector('[data-testid="onboarding-submit"]') as HTMLButtonElement | null;
      await act(async () => {
        submit?.click();
      });
      await waitFor(
        () => root.container().textContent?.includes(requestIntentReconciliationCopy.en) === true,
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
          slug: "acme",
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
    } finally {
      await onboardingStore.clear(origin, userId);
    }
  });
});
