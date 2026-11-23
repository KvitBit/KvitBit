/**
 * Decoded request payloads are passed straight to core methods, so under
 * exactOptionalPropertyTypes each must be assignable to the core input type (optional fields
 * are `optionalKey`: absent, never present-but-undefined). Checked by `tsc`; the runtime test
 * only keeps the file in the suite.
 */
import { expect, test } from "bun:test";
import type {
  Contacts,
  CorrectionInput as CoreCorrectionInput,
  RecordPaymentInput as CoreRecordPaymentInput,
  Documents,
  Payments,
  SendOptions,
  Templates,
  Workspaces,
} from "@kvitbit/domain/contract";
import type { Context } from "effect";
import type {
  CancelInput,
  CorrectionInput,
  FinalInvoiceInput,
  FromIcoInput,
  IssueDraftPayload,
  IssueFromInputPayload,
  RecordPaymentInput,
  RemovePaymentInput,
  ScheduleInput,
  SendInput,
  SeriesInput,
  UnlockInput,
  UseTemplateInput,
} from "../src/index";

type Shape<T> = Context.Service.Shape<T>;
type Arg<F, N extends number> = F extends (...args: infer A) => unknown ? NonNullable<A[N]> : never;
type Assignable<From, To> = [From] extends [To] ? true : false;
const ok = <T extends true>(): T => true as T;

test("decoded payloads are assignable to their core inputs", () => {
  const checks = [
    ok<Assignable<RecordPaymentInput, CoreRecordPaymentInput>>(),
    ok<Assignable<CorrectionInput, CoreCorrectionInput>>(),
    ok<Assignable<SendInput, SendOptions>>(),
    ok<Assignable<typeof CancelInput.Type, Arg<Shape<typeof Documents>["cancel"], 1>>>(),
    ok<
      Assignable<
        typeof FinalInvoiceInput.Type,
        Arg<Shape<typeof Documents>["issueFinalInvoice"], 1>
      >
    >(),
    ok<
      Assignable<(typeof UnlockInput.Type)["reason"], Arg<Shape<typeof Documents>["unlock"], 1>>
    >(),
    ok<
      Assignable<
        (typeof IssueFromInputPayload.Type)["send"],
        Arg<Shape<typeof Documents>["issue"], 1>["send"] | undefined
      >
    >(),
    ok<
      Assignable<
        (typeof IssueDraftPayload.Type)["send"],
        Arg<Shape<typeof Documents>["issue"], 1>["send"] | undefined
      >
    >(),
    ok<Assignable<RemovePaymentInput["reason"], Arg<Shape<typeof Payments>["remove"], 1>>>(),
    ok<Assignable<UseTemplateInput, Arg<Shape<typeof Templates>["use"], 1>>>(),
    ok<Assignable<ScheduleInput, Arg<Shape<typeof Templates>["schedule"], 1>>>(),
    ok<Assignable<SeriesInput, Arg<Shape<typeof Workspaces>["configureSeries"], 0>>>(),
    ok<Assignable<Omit<FromIcoInput, "ico">, Arg<Shape<typeof Contacts>["fromIco"], 1>>>(),
  ];
  expect(checks.every(Boolean)).toBe(true);
});
