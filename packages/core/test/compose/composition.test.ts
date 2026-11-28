import { describe, expect, test } from "bun:test";
import type { DocumentInput } from "@kvitbit/domain/contract";
import {
  ContactId,
  Contacts,
  Documents,
  Expenses,
  IsoDate,
  Payments,
  PriceList,
  PublicShareLinks,
  Reports,
  Templates,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CoreLive, type CoreLiveRequires, type CoreRequirements } from "../../src/compose/CoreLive";
import { RecurringIssuance } from "../../src/modules/recurring";
import { ExportJobs } from "../../src/modules/reports";
import {
  BrandingPreviewFake,
  CaptureEmailSender,
  CaptureInvitationDelivery,
  CoreReposMemory,
  DeliveryJobsMemory,
  DocumentRendererFake,
  FakeExportWorkflow,
  FakeReportPdfRenderer,
  InMemoryPortsLive,
  InvitationTokensFake,
  ShareLinkKeysTest,
  StartedDeliveries,
  UserDirectoryFake,
} from "../../src/testing";
import { account, asCaller, runCore } from "../helpers";
import { dec } from "../modules/documents/fixtures";

// Compile-time: CoreLive leaves open only persistence and the external ports.
const coreRequirementsCovered: [Exclude<CoreRequirements, CoreLiveRequires>] extends [never]
  ? true
  : false = true;

/** Resolves every caller-facing service tag and the job services. */
const resolveAll = Effect.all(
  [
    Effect.service(Workspaces),
    Effect.service(Contacts),
    Effect.service(PriceList),
    Effect.service(Documents),
    Effect.service(Payments),
    Effect.service(PublicShareLinks),
    Effect.service(Expenses),
    Effect.service(Templates),
    Effect.service(Reports),
    Effect.service(RecurringIssuance),
    Effect.service(ExportJobs),
  ],
  { concurrency: 1 },
);

describe("CoreLive", () => {
  test("builds from persistence and external ports only and resolves every service", async () => {
    expect(coreRequirementsCovered).toBe(true);
    const externals = Layer.mergeAll(
      CoreReposMemory,
      UserDirectoryFake.layer([]),
      CaptureInvitationDelivery.layer,
      InvitationTokensFake,
      BrandingPreviewFake,
      DocumentRendererFake,
      FakeReportPdfRenderer.layer,
      DeliveryJobsMemory,
      FakeExportWorkflow.layer,
      ShareLinkKeysTest,
    ).pipe(Layer.provideMerge(InMemoryPortsLive()));
    const exit = await Effect.runPromiseExit(
      Effect.map(resolveAll, (services) => services.length).pipe(
        Effect.provide(CoreLive.pipe(Layer.provide(externals))),
      ),
    );
    expect(exit).toEqual(Exit.succeed(11));
  });
});

describe("TestCore", () => {
  test("resolves every service and the fake controls", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const services = yield* resolveAll;
        yield* Effect.service(StartedDeliveries);
        yield* Effect.service(CaptureEmailSender);
        return services.length;
      }),
    );
    expect(exit).toEqual(Exit.succeed(11));
  });

  test("a new Workspace gets its default series through WorkspaceSeries -> NumberingSeries", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const ws = yield* Workspaces;
        const owner = yield* ws.create(account(), { name: "Kvitbit s.r.o." });
        const series = yield* asCaller(owner, ws.listSeries(owner));
        return EffectArray.map(series, (s) => s.kind).sort();
      }),
    );
    expect(exit).toEqual(Exit.succeed(["credit_note", "invoice", "proforma"]));
  });

  test("a sent, shared document's view carries deliveries and share (DocumentActivity bound)", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* Effect.flatMap(Workspaces, (ws) =>
          ws.create(account(), { name: "Kvitbit s.r.o." }),
        );
        return yield* asCaller(
          owner,
          Effect.gen(function* () {
            const contact = yield* Effect.flatMap(Contacts, (c) =>
              c.save(owner, { name: "Acme s.r.o.", billingEmails: ["fakturace@acme.cz"] }),
            );
            const docs = yield* Documents;
            const contactId = yield* Schema.decodeUnknownEffect(ContactId)(contact["id"]);
            const input: DocumentInput = {
              kind: "invoice",
              contact: contactId,
              lines: [{ description: "Konzultace", quantity: dec("2"), unitPrice: dec("1000") }],
              issuedOn: IsoDate.make("2026-11-23"),
            };
            const issued = yield* docs.issue(owner, { input });
            yield* docs.send(owner, issued.id);
            yield* Effect.flatMap(PublicShareLinks, (l) => l.create(owner, issued.id));
            const got = yield* docs.get(owner, issued.id);
            return { deliveries: got.deliveries.length > 0, share: got.share !== null };
          }),
        );
      }),
    );
    expect(exit).toEqual(Exit.succeed({ deliveries: true, share: true }));
  });
});
