/**
 * Delivery seam: `DocumentSender` carries exactly the domain `Documents.send` / `previewSend`
 * signatures, and `DocumentsLive` delegates both to it unchanged (authorization included: the
 * sender authorizes `document.send` itself, rule R1a). Stage 2 (cd-delivery, under
 * documents/deliveries/**) provides the real layer; until then `DocumentSenderStub` dies.
 */
import type { Documents } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";

type DocumentsShape = Documents["Service"];

export class DocumentSender extends Context.Service<
  DocumentSender,
  {
    readonly send: DocumentsShape["send"];
    readonly previewSend: DocumentsShape["previewSend"];
  }
>()("kvitbit/core/documents/DocumentSender") {}

/** Dies with a clear defect on every call, so test layers compose without stage 2. */
export const DocumentSenderStub: Layer.Layer<DocumentSender> = Layer.succeed(
  DocumentSender,
  DocumentSender.of({
    send: () => Effect.die(new Error("Documents.send: not implemented (stage 2: deliveries)")),
    previewSend: () =>
      Effect.die(new Error("Documents.previewSend: not implemented (stage 2: deliveries)")),
  }),
);
