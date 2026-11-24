import { describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { ApiProvider } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { allText, findAll, hostTree } from "../../testing/element-tree";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";
import type { AuthClient } from "../auth/auth-port";

mock.module("expo-router", () => expoRouterStandIn());

const { AccountScreen, parseAccountTab } = await import("./account-screen");

const fakeAuth: AuthClient = {
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
};

const within = (node: ReactElement) => (
  <TestProviders>
    <SessionProvider origin="https://kvitbit.test">
      <ApiProvider token={null} origin="https://kvitbit.test">
        {node}
      </ApiProvider>
    </SessionProvider>
  </TestProviders>
);

describe("AccountScreen", () => {
  test("parseAccountTab falls back to profile", () => {
    expect(parseAccountTab("security")).toBe("security");
    expect(parseAccountTab("unknown")).toBe("profile");
  });

  test("renders profile, appearance, security, sessions, and danger tabs", () => {
    const profileText = allText(
      hostTree(<AccountScreen tab="profile" authClient={fakeAuth} />, within),
    );
    expect(profileText).toContain("Your name");
    expect(profileText).toContain("Change email");
    expect(profileText).toContain("Sign out");

    const appearanceText = allText(
      hostTree(<AccountScreen tab="appearance" authClient={fakeAuth} />, within),
    );
    expect(appearanceText).toContain("Mode");
    expect(appearanceText).toContain("Style");
    expect(appearanceText).toContain("Contrast");

    const securityText = allText(
      hostTree(<AccountScreen tab="security" authClient={fakeAuth} />, within),
    );
    expect(securityText).toContain("Passkeys");
    expect(securityText).toContain("Add passkey");
    expect(securityText).toContain("Change password");

    const sessionsText = allText(
      hostTree(<AccountScreen tab="sessions" authClient={fakeAuth} />, within),
    );
    expect(sessionsText).toContain("Active sessions");
    expect(sessionsText).toContain("Sign out other sessions");

    const dangerTree = hostTree(<AccountScreen tab="danger" authClient={fakeAuth} />, within);
    expect(allText(dangerTree)).toContain("Delete my account");
    const delBtn = findAll(dangerTree, "Pressable").find(
      (el) => el.props.testID === "delete-account-submit",
    );
    expect(delBtn?.props.disabled).toBe(true);
  });
});
