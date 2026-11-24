import { describe, expect, test } from "bun:test";
import {
  Contacts,
  Documents,
  Expenses,
  Payments,
  PriceList,
  PublicShareLinks,
  Reports,
  Templates,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Effect, Exit, Layer } from "effect";
import { CoreLive } from "../../src/compose/CoreLive";
import {
  DeliveryJobsMemory,
  DocumentRendererFake,
  StartedDeliveries,
} from "../../src/modules/documents";
import { RecurringIssuance } from "../../src/modules/recurring";
import { ExportJobs, FakeExportWorkflow, FakeReportPdfRenderer } from "../../src/modules/reports";
import { ShareLinkKeysTest, ShareWorkspacesFake } from "../../src/modules/sharelinks";
import {
  BankAccountReferencesFake,
  BrandingPreviewFake,
  CaptureInvitationDelivery,
  InvitationTokensFake,
  UserDirectoryFake,
} from "../../src/modules/workspaces";
import { CaptureEmailSender, CoreReposMemory, InMemoryPortsLive } from "../../src/testing";
import { account, asCaller, runCore } from "../helpers";

/** Resolves every caller-facing service tag and the job services. */
const resolveAll = Effect.all([
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
]);

describe("CoreLive", () => {
  test("builds from persistence and external ports only and resolves every service", async () => {
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
      // PENDING seams, removed once bound in CoreLive.
      BankAccountReferencesFake.layer,
      ShareWorkspacesFake,
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
        const owner = yield* ws.create({ name: "Kvitbit s.r.o." } as never);
        const series = yield* asCaller(owner, ws.listSeries);
        return series.map((s) => s.kind).sort();
      }),
    );
    expect(exit).toEqual(Exit.succeed(["credit_note", "invoice", "proforma"]));
  });
});
