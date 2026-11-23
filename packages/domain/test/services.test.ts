import { describe, expect, test } from "bun:test";
import {
  BlobStorage,
  CompanyRegistry,
  Contacts,
  Documents,
  EmailSender,
  ExchangeRates,
  Expenses,
  Payments,
  PriceList,
  PublicShareLinks,
  Reports,
  RequestOutcome,
  Templates,
  Workspaces,
} from "../src/index";

describe("service tags", () => {
  test("the nine caller-facing modules use the spec keys", () => {
    expect(
      [
        Workspaces,
        Contacts,
        PriceList,
        Documents,
        Payments,
        Expenses,
        Templates,
        Reports,
        PublicShareLinks,
      ].map((s) => s.key),
    ).toEqual([
      "kvitbit/Workspaces",
      "kvitbit/Contacts",
      "kvitbit/PriceList",
      "kvitbit/Documents",
      "kvitbit/Payments",
      "kvitbit/Expenses",
      "kvitbit/Templates",
      "kvitbit/Reports",
      "kvitbit/PublicShareLinks",
    ]);
  });
  test("driven ports use the spec keys", () => {
    expect(
      [CompanyRegistry, ExchangeRates, EmailSender, BlobStorage, RequestOutcome].map((s) => s.key),
    ).toEqual([
      "kvitbit/CompanyRegistry",
      "kvitbit/ExchangeRates",
      "kvitbit/EmailSender",
      "kvitbit/BlobStorage",
      "kvitbit/RequestOutcome",
    ]);
  });
});

describe("unspecified contracts", () => {
  test("placeholder types cannot be forged from object literals", () => {
    // @ts-expect-error WorkspaceView has no specified fields yet, so nothing can construct one
    const forged: import("../src/index").WorkspaceView = { slug: "abc" };
    expect(forged).toBeDefined();
  });
});
