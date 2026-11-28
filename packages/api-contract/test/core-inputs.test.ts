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
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
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
const ok = <T extends true>(value: T): T => value;

test("decoded payloads are assignable to their core inputs", () => {
  const checks = [
    ok<Assignable<RecordPaymentInput, CoreRecordPaymentInput>>(true),
    ok<Assignable<CorrectionInput, CoreCorrectionInput>>(true),
    ok<Assignable<SendInput, SendOptions>>(true),
    ok<Assignable<typeof CancelInput.Type, Arg<Shape<typeof Documents>["cancel"], 2>>>(true),
    ok<
      Assignable<
        typeof FinalInvoiceInput.Type,
        Arg<Shape<typeof Documents>["issueFinalInvoice"], 2>
      >
    >(true),
    ok<Assignable<(typeof UnlockInput.Type)["reason"], Arg<Shape<typeof Documents>["unlock"], 2>>>(
      true,
    ),
    ok<
      Assignable<
        (typeof IssueFromInputPayload.Type)["send"],
        Arg<Shape<typeof Documents>["issue"], 2>["send"] | undefined
      >
    >(true),
    ok<
      Assignable<
        (typeof IssueDraftPayload.Type)["send"],
        Arg<Shape<typeof Documents>["issue"], 2>["send"] | undefined
      >
    >(true),
    ok<Assignable<RemovePaymentInput["reason"], Arg<Shape<typeof Payments>["remove"], 2>>>(true),
    ok<Assignable<UseTemplateInput, Arg<Shape<typeof Templates>["use"], 2>>>(true),
    ok<Assignable<ScheduleInput, Arg<Shape<typeof Templates>["schedule"], 2>>>(true),
    ok<Assignable<SeriesInput, Arg<Shape<typeof Workspaces>["configureSeries"], 1>>>(true),
    ok<Assignable<Omit<FromIcoInput, "ico">, Arg<Shape<typeof Contacts>["fromIco"], 2>>>(true),
  ];
  expect(Arr.every(checks, Boolean)).toBe(true);
});
