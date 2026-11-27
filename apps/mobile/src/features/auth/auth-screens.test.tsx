import { describe, expect, mock, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { ReactElement } from "react";
import { SessionProvider } from "../../session/session-provider";
import { clientRoot } from "../../testing/client-root";
import { allText, findAll, hostTree } from "../../testing/element-tree";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { recordedOverlay, TestProviders } from "../../testing/providers";
import { parseErrorKind } from "./auth-links";
import type { AuthClient } from "./auth-port";

const replacements: string[] = [];
mock.module("expo-router", () => {
  const standIn = expoRouterStandIn();
  return {
    ...standIn,
    router: {
      ...standIn.router,
      replace: (href: string) => {
        replacements.push(href);
      },
    },
  };
});

const { AuthLinkScreen } = await import("./auth-link-screen");
const { BotProofWidget } = await import("./bot-proof-widget");
const { CheckEmailScreen } = await import("./check-email-screen");
const { ErrorScreen } = await import("./error-screen");
const { ResetPasswordScreen } = await import("./reset-password-screen");
const { SignInScreen, safeReturnTo } = await import("./sign-in-screen");
const { SignUpScreen } = await import("./sign-up-screen");

const fakeAuthClient = (overrides: Partial<AuthClient> = {}): AuthClient => ({
  signUpEmail: async () => ({ _tag: "Ok", value: null }),
  signInEmail: async () => ({ _tag: "Cancelled" }),
  sendMagicLink: async () => ({ _tag: "Ok", value: undefined }),
  verifyLink: async () => ({ _tag: "Cancelled" }),
  resendVerification: async () => ({ _tag: "Ok", value: undefined }),
  requestPasswordReset: async () => ({ _tag: "Ok", value: undefined }),
  resetPassword: async () => ({ _tag: "Ok", value: undefined }),
  changePassword: async () => ({ _tag: "Ok", value: undefined }),
  changeEmail: async () => ({ _tag: "Ok", value: undefined }),
  updateUser: async () => ({ _tag: "Ok", value: undefined }),
  passkeySignIn: async () => ({ _tag: "Cancelled" }),
  passkeyAdd: async () => ({ _tag: "Cancelled" }),
  passkeys: async () => ({ _tag: "Ok", value: [] }),
  renamePasskey: async () => ({ _tag: "Ok", value: undefined }),
  removePasskey: async () => ({ _tag: "Ok", value: undefined }),
  sessions: async () => ({ _tag: "Ok", value: [] }),
  revokeSession: async () => ({ _tag: "Ok", value: undefined }),
  signOut: async () => ({ _tag: "Ok", value: undefined }),
  deleteAccount: async () => ({ _tag: "Ok", value: undefined }),
  ...overrides,
});

const withProviders =
  (overlay = recordedOverlay()) =>
  (node: ReactElement) => (
    <TestProviders overlay={overlay}>
      <SessionProvider origin="https://kvitbit.test">{node}</SessionProvider>
    </TestProviders>
  );

describe("auth screens", () => {
  test("safeReturnTo allows relative in-app paths and rejects external/protocol-relative URLs", () => {
    expect(safeReturnTo("/w/acme/documents")).toBe("/w/acme/documents");
    // biome-ignore lint/security/noSecrets: This test URL contains fixture values.
    expect(safeReturnTo("/app/w/acme/documents/123?tab=payments#receipt")).toBe(
      // biome-ignore lint/security/noSecrets: This test URL contains fixture values.
      "/w/acme/documents/123?tab=payments#receipt",
    );
    expect(safeReturnTo("/app//evil.example")).toBeNull();
    expect(safeReturnTo("/%5c/evil.example")).toBeNull();
    expect(safeReturnTo("/w/../w/evil")).toBeNull();
    expect(safeReturnTo("//evil.example")).toBeNull();
    expect(safeReturnTo("https://evil.example")).toBeNull();
    expect(safeReturnTo("")).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
  });

  test("BotProofWidget renders nothing for NotRequired and progress/retry for active/failed", () => {
    const none = hostTree(
      <BotProofWidget state={{ _tag: "NotRequired" }} onRetry={() => undefined} />,
      withProviders(),
    );
    expect(allText(none)).toBe("");

    const solving = hostTree(
      <BotProofWidget state={{ _tag: "Solving", progress: 0.42 }} onRetry={() => undefined} />,
      withProviders(),
    );
    expect(allText(solving)).toContain("42 %");

    let retried = false;
    const failed = hostTree(
      <BotProofWidget
        state={{ _tag: "Failed", error: { _tag: "Offline" } }}
        onRetry={() => {
          retried = true;
        }}
      />,
      withProviders(),
    );
    expect(allText(failed)).toContain("Try again");
    const retryBtn = findAll<{ onPress?: () => void }>(failed, "Pressable")[0];
    retryBtn?.props.onPress?.();
    expect(retried).toBe(true);
  });

  test("SignInScreen renders password, magic link, and passkey controls", () => {
    const tree = hostTree(<SignInScreen authClient={fakeAuthClient()} />, withProviders());
    const text = allText(tree);
    expect(text).toContain("Sign in to Kvitbit");
    expect(text).toContain("Sign in with a passkey");
    expect(text).toContain("Email me a sign-in link");
    expect(text).toContain("Forgot password?");
  });

  test("SignUpScreen renders invitation note and locks email when invited", () => {
    const tree = hostTree(
      <SignUpScreen
        invitation="inv-123"
        lockedEmail="invited@kvitbit.cz"
        authClient={fakeAuthClient()}
      />,
      withProviders(),
    );
    const text = allText(tree);
    expect(text).toContain("Create your account");
    expect(text).toContain("You will join the workspace you were invited to.");
    const emailInput = Option.getOrUndefined(
      Arr.findFirst(findAll(tree, "TextInput"), (el) => el.props.testID === "sign-up-email"),
    );
    expect(emailInput?.props.value).toBe("invited@kvitbit.cz");
    expect(emailInput?.props.editable).toBe(false);
  });

  test("CheckEmailScreen displays address and triggers resend when cooldown is 0", async () => {
    const overlay = recordedOverlay();
    let resentTo = "";
    const tree = hostTree(
      <CheckEmailScreen
        email="jana@kvitbit.cz"
        initialCooldown={0}
        authClient={fakeAuthClient({
          resendVerification: (email) => {
            resentTo = email;
            return Promise.resolve({ _tag: "Ok", value: undefined });
          },
        })}
      />,
      withProviders(overlay),
    );
    expect(allText(tree)).toContain("jana@kvitbit.cz");
    const resendBtn = Option.getOrUndefined(
      Arr.findFirst(
        findAll<{ testID?: string; disabled?: boolean; onPress?: () => Promise<void> }>(
          tree,
          "Pressable",
        ),
        (el) => el.props.testID === "check-email-resend",
      ),
    );
    expect(resendBtn?.props.disabled).toBe(false);
    await resendBtn?.props.onPress?.();
    expect(resentTo).toBe("jana@kvitbit.cz");
  });

  test("ResetPasswordScreen renders request mode without token and confirm mode with token", () => {
    const reqTree = hostTree(
      <ResetPasswordScreen authClient={fakeAuthClient()} />,
      withProviders(),
    );
    expect(allText(reqTree)).toContain("Send reset link");

    const confirmTree = hostTree(
      <ResetPasswordScreen token="tok-abc" authClient={fakeAuthClient()} />,
      withProviders(),
    );
    expect(allText(confirmTree)).toContain("Set new password");
  });

  test("ErrorScreen renders all four kinds and requestId on server errors", () => {
    expect(parseErrorKind("offline")).toBe("offline");
    expect(parseErrorKind("weird")).toBe("not_found");

    const serverTree = hostTree(<ErrorScreen kind="server" requestId="req-42" />, withProviders());
    expect(allText(serverTree)).toContain("Something went wrong");
    expect(allText(serverTree)).toContain("req-42");

    const offlineTree = hostTree(<ErrorScreen kind="offline" />, withProviders());
    expect(allText(offlineTree)).toContain("You are offline");
  });
});

describe("verification link continuation", () => {
  const root = clientRoot({ keepFetch: true });

  test("a verified link without a session offers sign-in with the original destination", async () => {
    replacements.length = 0;
    const auth = fakeAuthClient({
      verifyLink: async () => ({ _tag: "Ok", value: null }),
    });
    await root.render(
      withProviders()(
        <AuthLinkScreen
          kind="verify"
          token="test-verification"
          returnTo="/invite/inv1"
          authClient={auth}
        />,
      ),
    );
    // biome-ignore lint/security/noSecrets: This test URL contains fixture values.
    expect(replacements).toEqual(["/sign-in?verified=1&returnTo=%2Finvite%2Finv1"]);
  });
});
