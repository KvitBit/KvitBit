import { describe, expect, test } from "bun:test";
import * as Contract from "@kvitbit/domain/contract";
import * as Ports from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import {
  BlobStorage,
  CompanyRegistry,
  Contacts,
  DocumentSummary,
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
      Arr.map(
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
        ],
        (service) => service.key,
      ),
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
      Arr.map(
        [CompanyRegistry, ExchangeRates, EmailSender, BlobStorage, RequestOutcome],
        (service) => service.key,
      ),
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
  test("the schema constructs a branded value from an opaque payload", () => {
    const payload = { name: "Document" };
    // @ts-expect-error An object literal has no DocumentSummary brand.
    const unbranded: DocumentSummary = payload;
    const branded: DocumentSummary = DocumentSummary.make(payload);
    expect(Object.is(branded, unbranded)).toBe(true);
  });
});

describe("subpath exports", () => {
  test("contract surface excludes driven ports", () => {
    expect("Documents" in Contract).toBe(true);
    expect("BlobStorage" in Contract).toBe(false);
    expect("BlobStorage" in Ports).toBe(true);
  });
});
