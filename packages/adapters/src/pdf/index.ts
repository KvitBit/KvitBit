/**
 * Document PDF rendering (core-ports 5.5, user-flows 5.3 D01-D11): pure HTML templates for
 * Classic Czech and Modern Minimal documents and the report export, statutory text, and the
 * `PdfEngine` seam that prints HTML to PDF bytes. Core owns caching in BlobStorage.
 */
import type { Locale, PdfTemplate } from "@kvitbit/domain";
import { Effect } from "effect";
import { renderClassic } from "./classic";
import { PdfEngine } from "./engine";
import type { DocumentRenderModel, ReportRenderModel } from "./model";
import { renderModern } from "./modern";
import { prepare } from "./prepare";
import { renderReportHtml } from "./report";

export type { ChromiumOptions } from "./engine";
export {
  ChromiumPdfEngine,
  FakePdfEngine,
  makeChromiumPdfEngine,
  makeFakePdfEngine,
  PdfEngine,
  PdfEngineError,
} from "./engine";
export type {
  DocumentRenderModel,
  RenderBranding,
  RenderImage,
  RenderIssuer,
  RenderLine,
  RenderParty,
  RenderReference,
  ReportCell,
  ReportRenderModel,
} from "./model";
export { renderReportHtml } from "./report";
export type { PrintedNote, StatutoryNoteCode } from "./statutory";
export { statutoryNotes, statutoryTitle } from "./statutory";

/** Self-contained A4 HTML for a document in the chosen template and language. */
export const renderDocumentHtml = (
  model: DocumentRenderModel,
  template: PdfTemplate,
  language: Locale,
): string => {
  const prepared = prepare(model, language);
  return template === "modern_minimal"
    ? renderModern(model, prepared)
    : renderClassic(model, prepared);
};

export const renderDocumentPdf = (
  model: DocumentRenderModel,
  template: PdfTemplate,
  language: Locale,
) =>
  Effect.gen(function* () {
    const engine = yield* PdfEngine;
    return yield* engine.htmlToPdf(renderDocumentHtml(model, template, language));
  });

export const renderReportPdf = (model: ReportRenderModel, language: Locale) =>
  Effect.gen(function* () {
    const engine = yield* PdfEngine;
    return yield* engine.htmlToPdf(renderReportHtml(model, language));
  });
