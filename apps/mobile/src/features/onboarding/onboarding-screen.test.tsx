import { describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { ApiProvider } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { allText, findAll, hostTree } from "../../testing/element-tree";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";

mock.module("expo-router", () => expoRouterStandIn());

const { OnboardingScreen } = await import("./onboarding-screen");

const within = (node: ReactElement) => (
  <TestProviders>
    <ApiProvider token={null} origin="https://kvitbit.test">
      <SessionProvider origin="https://kvitbit.test">{node}</SessionProvider>
    </ApiProvider>
  </TestProviders>
);

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
