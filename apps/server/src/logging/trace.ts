import { Context } from "effect";

interface CloudTrace {
  readonly traceId: string;
  readonly spanId?: string;
  readonly sampled?: boolean;
}

const CLOUD_TRACE = /^([0-9a-f]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/i;
const MAX_SPAN_ID = 0xffff_ffff_ffff_ffffn;

export const parseCloudTrace = (header: string | undefined): CloudTrace | undefined => {
  const match = CLOUD_TRACE.exec(header?.trim() ?? "");
  if (match === null) return undefined;
  const [, id, decimalSpan, sampled] = match;
  if (id === undefined || /^0+$/.test(id)) return undefined;
  const span = decimalSpan === undefined ? undefined : BigInt(decimalSpan);
  return {
    traceId: id.toLowerCase(),
    ...(span !== undefined && span > 0n && span <= MAX_SPAN_ID
      ? { spanId: span.toString(16).padStart(16, "0") }
      : {}),
    ...(sampled === undefined ? {} : { sampled: sampled === "1" }),
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
