/**
 * `@kvitbit/core/testing` (package requirement 2): every module's test layer, memory
 * repositories, fakes and their test controls, through the public entry point, identical to the
 * module's own export (one tag per control, so a test's control reaches the layer it drives).
 */
import { describe, expect, test } from "bun:test";
import * as Testing from "@kvitbit/core/testing";
import * as Contacts from "../src/modules/contacts";
import * as Documents from "../src/modules/documents";
import * as Expenses from "../src/modules/expenses";
import * as Numbering from "../src/modules/numbering";
import * as Payments from "../src/modules/payments";
import * as PriceList from "../src/modules/pricelist";
import * as Recurring from "../src/modules/recurring";
import * as Reports from "../src/modules/reports";
import * as ShareLinks from "../src/modules/sharelinks";
import * as Workspaces from "../src/modules/workspaces";

const MODULES = {
  Contacts,
  Documents,
  Expenses,
  Numbering,
  Payments,
  PriceList,
  Recurring,
  Reports,
  ShareLinks,
  Workspaces,
};

/** Names of test layers, memory repositories, fakes, fixtures and test controls. */
const TEST_NAME =
  /TestLayer$|Memory$|^Fake|Fake$|FakesLive$|Fixtures$|^Capture|^StartedDeliveries$|KeysTest$|None$|^fakePdfBytes$/;

const testNames = (mod: object) => Object.keys(mod).filter((name) => TEST_NAME.test(name));

describe("the testing entry", () => {
  test.each(Object.entries(MODULES))(
    "re-exports every %s test layer, fake and control",
    (_, mod) => {
      const names = testNames(mod);
      const missing = names.filter(
        (name) =>
          (Testing as Record<string, unknown>)[name] !== (mod as Record<string, unknown>)[name],
      );
      expect(missing).toEqual([]);
    },
  );

  test("carries the controls and layers the e2e tests drive", () => {
    for (const name of [
      "DocumentsTestLayer",
      "PaymentsTestLayer",
      "WorkspacesTestLayer",
      "ShareLinksTestLayer",
      "StartedDeliveries",
      "FakeExportWorkflow",
      "DocumentFixtures",
      "PaymentFixtures",
      "ShareLinkKeysTest",
    ]) {
      expect({ name, exported: name in Testing }).toEqual({ name, exported: true });
    }
  });
});
