import * as Context from "effect/Context";
import * as Str from "effect/String";

const parseCloudTracePattern = /^0+$/;

interface CloudTrace {
  readonly traceId: string;
  readonly spanId?: string;
  readonly sampled?: boolean;
}

const CLOUD_TRACE = /^([0-9a-f]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/i;
const MAX_SPAN_ID = 0xffff_ffff_ffff_ffffn;

export const parseCloudTrace = (header: string | undefined): CloudTrace | undefined => {
  const match = CLOUD_TRACE.exec(Str.trim(header ?? ""));
  if (match === null) return undefined;
  const [, id, decimalSpan, sampled] = match;
  if (id === undefined || parseCloudTracePattern.test(id)) return undefined;
  const span = decimalSpan === undefined ? undefined : BigInt(decimalSpan);
  const spanIdFields =
    span !== undefined && span > 0n && span <= MAX_SPAN_ID
      ? { spanId: Str.padStart(16, "0")(span.toString(16)) }
      : {};
  const sampledFields = sampled === undefined ? {} : { sampled: sampled === "1" };
  return {
    traceId: Str.toLowerCase(id),
    ...spanIdFields,
    ...sampledFields,
  };
};

export const RequestLogContext = Context.Reference<
  | {
      readonly requestId: string;
      readonly trace: CloudTrace | undefined;
      route?: string;
    }
  | undefined
>("kvitbit/server/RequestLogContext", { defaultValue: () => undefined });
