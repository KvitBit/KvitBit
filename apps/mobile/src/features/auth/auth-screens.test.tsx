import { describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { SessionProvider } from "../../session/session-provider";
import { allText, findAll, hostTree } from "../../testing/element-tree";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { recordedOverlay, TestProviders } from "../../testing/providers";
import type { AuthClient } from "./auth-port";

mock.module("expo-router", () => expoRouterStandIn());

const { BotProofWidget } = await import("./bot-proof-widget");
const { CheckEmailScreen } = await import("./check-email-screen");
const { ErrorScreen, parseErrorKind } = await import("./error-screen");
const { ResetPasswordScreen } = await import("./reset-password-screen");
const { SignInScreen, safeReturnTo } = await import("./sign-in-screen");
const { SignUpScreen } = await import("./sign-up-screen");

const fakeAuthClient = (overrides: Partial<AuthClient> = {}): AuthClient => ({
  signUpEmail: async () => ({ _tag: "Ok", value: undefined }),
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
    const retryBtn = findAll(failed, "Pressable")[0];
    (retryBtn?.props.onPress as (() => void) | undefined)?.();
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
    const emailInput = findAll(tree, "TextInput").find((el) => el.props.testID === "sign-up-email");
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
          resendVerification: async (email) => {
            resentTo = email;
            return { _tag: "Ok", value: undefined };
          },
        })}
      />,
      withProviders(overlay),
    );
    expect(allText(tree)).toContain("jana@kvitbit.cz");
    const resendBtn = findAll(tree, "Pressable").find(
      (el) => el.props.testID === "check-email-resend",
    );
    expect(resendBtn?.props.disabled).toBe(false);
    await (resendBtn?.props.onPress as (() => Promise<void>) | undefined)?.();
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
