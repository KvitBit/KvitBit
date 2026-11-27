/**
 * `ReportPdfRenderer`: the narrow port behind `Reports.export(q, "pdf")`. The server provides
 * it with the PDF stack (core-ports 5.5: renderer failures are defects, so the port has no error
 * channel); core stays free of PDF dependencies. `FakeReportPdfRenderer` records each call and
 * returns deterministic bytes.
 */
import type { Locale, WorkspaceId } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { ReportViewData } from "./views";

export interface ReportPdfInput {
  readonly workspaceId: WorkspaceId;
  readonly locale: Locale;
  readonly view: ReportViewData;
}

export class ReportPdfRenderer extends Context.Service<
  ReportPdfRenderer,
  { readonly render: (input: ReportPdfInput) => Effect.Effect<Uint8Array> }
>()("@kvitbit/core/modules/reports/renderer/ReportPdfRenderer") {}

export class FakeReportPdfRenderer extends Context.Service<
  FakeReportPdfRenderer,
  { readonly calls: Ref.Ref<ReadonlyArray<ReportPdfInput>> }
>()("@kvitbit/core/modules/reports/renderer/FakeReportPdfRenderer") {
  /** Bytes: `%PDF-FAKE <report> <locale> <workspaceId>`. */
  static readonly layer: Layer.Layer<ReportPdfRenderer | FakeReportPdfRenderer> = Layer.effect(
    ReportPdfRenderer,
    Effect.map(FakeReportPdfRenderer, (fake) => ({
      render: (input: ReportPdfInput) =>
        Effect.as(
          Ref.update(fake.calls, (calls) => [...calls, input]),
          new TextEncoder().encode(
            `%PDF-FAKE ${input.view.report} ${input.locale} ${input.workspaceId}`,
          ),
        ),
    })),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        FakeReportPdfRenderer,
        Effect.map(Ref.make<ReadonlyArray<ReportPdfInput>>([]), (calls) => ({ calls })),
      ),
    ),
  );
}
