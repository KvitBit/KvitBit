import type { OutboundEmail } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Exit from "effect/Exit";

export const message = (overrides: Partial<OutboundEmail> = {}): OutboundEmail => ({
  to: ["jana@klient.cz"],
  cc: ["ucetni@klient.cz"],
  replyTo: "Studio Nováková <studio@novakova.cz>",
  subject: "Faktura 2026-0042",
  html: "<p>Dobrý den</p>",
  text: "Dobrý den",
  attachments: [
    { filename: "faktura.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
  ],
  tags: { template: "E01", "workspace id": "ws_1" },
  ...overrides,
});

export const failureTags = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? Arr.map(exit.cause.reasons, (reason) => ("error" in reason ? reason.error._tag : reason._tag))
    : [];
