import { domainToASCII } from "node:url";
import { TextDecoder } from "node:util";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Result from "effect/Result";
import * as Str from "effect/String";

const encodedWordPattern = /[=]\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
const decodeQuotedPrintablePattern = /^[0-9a-fA-F]{2}$/;
const matchPattern = /^([^']*)'[^']*'(.*)$/;
const isValidRawDomainLabelPattern = /\s/;
const digitsOnlyPattern = /^\d+$/;
const angleMatchPattern = /^([\s\S]*?)<[ \t]*([^<>]+?)[ \t]*>[ \t]*$/;

interface ParsedAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
  readonly sizeBytes: number;
}

export interface ParsedEmail {
  readonly subject: string;
  readonly fromHeader: string;
  readonly fromAddress: string | undefined;
  readonly fromDisplayName: string | undefined;
  readonly replyToAddress: string | undefined;
  readonly messageId: string | undefined;
  readonly date: string | undefined;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: ReadonlyArray<ParsedAttachment>;
}

const MAX_MIME_DEPTH = 8;

/** Trims only RFC 5322 ASCII WSP (space/tab), preserving non-ASCII UTF-8 characters like U+00A0. */
export const trimAsciiWsp = (value: string): string => Str.replace(/^[ \t]+|[ \t]+$/g, "")(value);

const splitHeaderAndBody = (raw: Uint8Array): { headers: string; body: Uint8Array } => {
  for (let i = 0; i < raw.length; i += 1) {
    if (
      i + 3 < raw.length &&
      raw[i] === 13 &&
      raw[i + 1] === 10 &&
      raw[i + 2] === 13 &&
      raw[i + 3] === 10
    ) {
      return {
        // Decode headers as UTF-8 so RFC 6532 internationalized headers are preserved;
        // pure US-ASCII is a strict subset of UTF-8.
        headers: new TextDecoder("utf-8", { fatal: false }).decode(raw.subarray(0, i)),
        body: raw.subarray(i + 4),
      };
    }
    if (i + 1 < raw.length && raw[i] === 10 && raw[i + 1] === 10) {
      return {
        headers: new TextDecoder("utf-8", { fatal: false }).decode(raw.subarray(0, i)),
        body: raw.subarray(i + 2),
      };
    }
  }
  return {
    headers: new TextDecoder("utf-8", { fatal: false }).decode(raw),
    body: new Uint8Array(0),
  };
};

const parseHeaders = (headerBlock: string): Map<string, Array<string>> => {
  const result = new Map<string, Array<string>>();
  const lines = Str.split(Str.replace(/\r\n/g, "\n")(headerBlock), "\n");
  let currentName: string | undefined;
  let currentValue = "";

  const flush = () => {
    if (currentName === undefined) return;
    const list = result.get(currentName) ?? [];
    list.push(trimAsciiWsp(currentValue));
    result.set(currentName, list);
    currentName = undefined;
    currentValue = "";
  };

  for (const line of lines) {
    if ((Str.startsWith(" ")(line) || Str.startsWith("\t")(line)) && currentName !== undefined) {
      currentValue += ` ${trimAsciiWsp(line)}`;
      continue;
    }
    flush();
    const colon = Option.getOrElse(Str.indexOf(":")(line), () => -1);
    if (colon <= 0) continue;
    currentName = Str.toLowerCase(trimAsciiWsp(Str.slice(0, colon)(line)));
    currentValue = trimAsciiWsp(Str.slice(colon + 1)(line));
  }
  flush();
  return result;
};

const firstHeader = (headers: Map<string, Array<string>>, name: string): string | undefined =>
  headers.get(Str.toLowerCase(name))?.[0];

const decodeCharset = (bytes: Uint8Array, charsetRaw?: string): string => {
  const normalized = Str.toLowerCase(
    Str.replace(/^["']|["']$/g, "")(Str.trim(charsetRaw ?? "utf-8")),
  );
  const mapped =
    normalized === "us-ascii" || normalized === "ascii"
      ? "utf-8"
      : normalized === "latin1" || normalized === "iso8859-1"
        ? "iso-8859-1"
        : normalized;
  return Result.try(() => new TextDecoder(mapped, { fatal: false }).decode(bytes)).pipe(
    Result.getOrElse(() => new TextDecoder("utf-8", { fatal: false }).decode(bytes)),
  );
};

const decodeQuotedPrintableImpl = (input: Uint8Array, headerMode = false): Uint8Array => {
  const out: Array<number> = [];
  for (let i = 0; i < input.length; i += 1) {
    const byte = input[i];
    if (byte === undefined) break;
    if (headerMode && byte === 95 /* '_' */) {
      out.push(32);
      continue;
    }
    if (byte === 61 /* '=' */) {
      // Soft line break =\r\n or =\n
      if (!headerMode && i + 1 < input.length && input[i + 1] === 10) {
        i += 1;
        continue;
      }
      if (!headerMode && i + 2 < input.length && input[i + 1] === 13 && input[i + 2] === 10) {
        i += 2;
        continue;
      }
      if (i + 2 < input.length) {
        const hex = String.fromCharCode(input[i + 1] ?? 0, input[i + 2] ?? 0);
        if (decodeQuotedPrintablePattern.test(hex)) {
          out.push(Number.parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
    }
    out.push(byte);
  }
  return Uint8Array.from(out);
};

export const decodeQuotedPrintable: {
  (headerMode?: boolean): (input: Uint8Array) => Uint8Array;
  (input: Uint8Array, headerMode?: boolean): Uint8Array;
} = Fn.dual((args) => args[0] instanceof Uint8Array, decodeQuotedPrintableImpl);

export const decodeRfc2047 = (value: string): string => {
  // Collapse whitespace between adjacent encoded words per RFC 2047 section 6.2.
  const collapsed = Str.replace(/\?=[ \t]+=\?/g, "?==?")(value);
  let offset = 0;
  let decoded = "";
  for (const match of Str.matchAll(encodedWordPattern)(collapsed)) {
    const [word, charset, encoding, text] = match;
    const index = match.index ?? offset;
    if (charset === undefined || encoding === undefined || text === undefined) continue;
    decoded += Str.slice(offset, index)(collapsed);
    decoded += Result.try(() => {
      const bytes =
        Str.toUpperCase(encoding) === "B"
          ? Buffer.from(text, "base64")
          : decodeQuotedPrintable(Buffer.from(text, "latin1"), true);
      return decodeCharset(bytes, charset);
    }).pipe(Result.getOrElse(() => text));
    offset = index + word.length;
  }
  return decoded + Str.slice(offset)(collapsed);
};

const parseHeaderParams = (
  headerValue: string | undefined,
): { main: string; params: Record<string, string> } => {
  if (!(headerValue !== undefined && headerValue !== "")) return { main: "", params: {} };
  const parts = Str.split(headerValue, ";");
  const main = Str.toLowerCase(Str.trim(parts[0] ?? ""));
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = Option.getOrElse(Str.indexOf("=")(part), () => -1);
    if (eq <= 0) continue;
    const key = Str.toLowerCase(Str.trim(Str.slice(0, eq)(part)));
    let val = Str.trim(Str.slice(eq + 1)(part));
    if (Str.startsWith('"')(val) && Str.endsWith('"')(val) && val.length >= 2) {
      val = Str.replace(/\\(["\\])/g, "$1")(Str.slice(1, -1)(val));
    }
    params[key] = val;
  }
  return { main, params };
};

const decodeRfc5987Param = (raw: string | undefined): string | undefined => {
  if (!(raw !== undefined && raw !== "")) return undefined;
  const match = Option.getOrNull(Str.match(matchPattern)(raw));
  if (!(match !== null)) return decodeRfc2047(raw);
  const charset = match[1] || "utf-8";
  const encoded = match[2] ?? "";
  const bytes: Array<number> = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === "%" && i + 2 < encoded.length) {
      const hex = Str.slice(i + 1, i + 3)(encoded);
      if (decodeQuotedPrintablePattern.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(Option.getOrElse(Str.charCodeAt(encoded, i), () => Number.NaN) & 0xff);
  }
  return decodeCharset(Uint8Array.from(bytes), charset);
};

const decodeTransferBody = (body: Uint8Array, encodingRaw?: string): Uint8Array => {
  const encoding = Str.toLowerCase(Str.trim(encodingRaw ?? "7bit"));
  if (encoding === "base64") {
    const cleaned = Str.replace(/[^A-Za-z0-9+/=]/g, "")(Buffer.from(body).toString("ascii"));
    return Uint8Array.from(Buffer.from(cleaned, "base64"));
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body, false);
  }
  return body;
};

const indexOfFrom = (text: string, search: string, from: number): number =>
  Str.indexOf(search)(Str.slice(from)(text)).pipe(
    Option.map((index) => index + from),
    Option.getOrElse(() => -1),
  );

const splitMultipart = (body: Uint8Array, boundary: string): Array<Uint8Array> => {
  const delimiter = `--${boundary}`;
  const rawStr = Buffer.from(body).toString("latin1");
  const parts: Array<Uint8Array> = [];
  let searchFrom = 0;

  while (searchFrom < rawStr.length) {
    const idx = indexOfFrom(rawStr, delimiter, searchFrom);
    if (idx === -1) break;
    // Boundary must start at beginning of body or after LF.
    if (idx > 0 && rawStr[idx - 1] !== "\n") {
      searchFrom = idx + delimiter.length;
      continue;
    }
    let partStart = idx + delimiter.length;
    if (rawStr[partStart] === "-" && rawStr[partStart + 1] === "-") {
      break;
    }
    if (rawStr[partStart] === "\r" && rawStr[partStart + 1] === "\n") {
      partStart += 2;
    } else if (rawStr[partStart] === "\n") {
      partStart += 1;
    } else {
      searchFrom = partStart;
      continue;
    }

    // Find next boundary
    const nextIdx = indexOfFrom(rawStr, `\n${delimiter}`, partStart);
    if (nextIdx === -1) {
      parts.push(body.subarray(partStart));
      break;
    }
    let partEnd = nextIdx;
    if (partEnd > partStart && rawStr[partEnd - 1] === "\r") {
      partEnd -= 1;
    }
    parts.push(body.subarray(partStart, partEnd));
    searchFrom = nextIdx + 1;
  }

  return parts;
};

const ASCII_LDH_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

const isValidRawDomainLabel = (label: string): boolean => {
  if (label.length === 0 || Str.startsWith("-")(label) || Str.endsWith("-")(label)) return false;
  for (const ch of label) {
    const code = Option.getOrElse(Str.charCodeAt(ch, 0), () => Number.NaN);
    if (code <= 0x7f) {
      const isAsciiLdh =
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code === 0x2d;
      if (!isAsciiLdh) return false;
    } else if (isValidRawDomainLabelPattern.test(ch)) {
      return false;
    }
  }
  return true;
};

const isValidDomain = (domain: string): boolean => {
  if (domain.length === 0 || domain.length > 253) return false;
  const rawLabels = Str.split(domain, ".");
  if (rawLabels.length < 2 || !Arr.every(rawLabels, isValidRawDomainLabel)) {
    return false;
  }
  const asciiDomain = domainToASCII(domain);
  if (asciiDomain.length === 0 || asciiDomain.length > 253) return false;
  const asciiLabels = Str.split(asciiDomain, ".");
  if (asciiLabels.length < 2) return false;
  if (!Arr.every(asciiLabels, (label) => ASCII_LDH_LABEL_RE.test(label))) return false;
  const tld = asciiLabels[asciiLabels.length - 1] ?? "";
  if (digitsOnlyPattern.test(tld)) return false;
  return true;
};

const hasDisallowedLocalChar = (local: string): boolean => {
  for (const ch of local) {
    const code = Option.getOrElse(Str.charCodeAt(ch, 0), () => Number.NaN);
    // Reject ASCII controls/space and unquoted RFC 5322 specials; permit UTF8-non-ascii (>= 0x80) per RFC 6532 §3.2.
    if (
      code <= 0x20 ||
      code === 0x7f ||
      ch === "<" ||
      ch === ">" ||
      ch === "@" ||
      ch === "\\" ||
      ch === '"' ||
      ch === "," ||
      ch === ";"
    ) {
      return true;
    }
  }
  return false;
};

/** Validates a full RFC 5321 / RFC 6531 (`SMTPUTF8`) + RFC 5890 IDNA mailbox without substring matching. */
export const isValidMailbox = (address: string): boolean => {
  if (address.length === 0 || address.length > 254) return false;
  const atIdx = Option.getOrElse(Str.lastIndexOf("@")(address), () => -1);
  if (atIdx <= 0 || atIdx === address.length - 1) return false;
  const local = Str.slice(0, atIdx)(address);
  const domain = Str.slice(atIdx + 1)(address);
  if (local.length > 64 || hasDisallowedLocalChar(local)) return false;
  return isValidDomain(domain);
};

/** Strips RFC 5322 §3.2.2 comments (including nested parentheses) outside quoted strings. */
const stripRfc5322Comments = (input: string): string => {
  let out = "";
  let inQuotes = false;
  let commentDepth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    if (commentDepth > 0) {
      if (ch === "\\" && i + 1 < input.length) {
        i += 1;
      } else if (ch === "(") {
        commentDepth += 1;
      } else if (ch === ")") {
        commentDepth -= 1;
        if (commentDepth === 0) out += " ";
      }
      continue;
    }
    if (inQuotes) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        i += 1;
        out += input[i] ?? "";
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      out += ch;
    } else if (ch === "(") {
      commentDepth = 1;
    } else {
      out += ch;
    }
  }
  return trimAsciiWsp(out);
};

/** Collapses RFC 5322 §3.2.2 ASCII WSP adjacent to `@` and dots in header addr-specs only. */
const normalizeHeaderAddrSpec = (rawAddr: string): string =>
  Str.replace(/[ \t]*\.[ \t]*/g, ".")(Str.replace(/[ \t]*@[ \t]*/g, "@")(trimAsciiWsp(rawAddr)));

export const extractAddress = (
  headerValue: string | undefined,
): { address: string | undefined; displayName: string | undefined } => {
  if (!(headerValue !== undefined && headerValue !== ""))
    return { address: undefined, displayName: undefined };
  // Strip RFC 5322 comments (including trailing/inline comments) before RFC 2047 decoding
  // so neither comments nor encoded display-names can break or spoof angle-addr parsing.
  const uncommented = stripRfc5322Comments(headerValue);
  const angleMatch = Option.getOrNull(Str.match(angleMatchPattern)(uncommented));
  if (angleMatch !== null) {
    const rawName = trimAsciiWsp(
      Str.replace(/^["']|["']$/g, "")(trimAsciiWsp(decodeRfc2047(angleMatch[1] ?? ""))),
    );
    const addr = normalizeHeaderAddrSpec(angleMatch[2] ?? "");
    return {
      address: isValidMailbox(addr) ? addr : undefined,
      displayName: rawName.length > 0 ? rawName : undefined,
    };
  }
  // Bare header: collapse ASCII WSP around `@` / `.` without stripping non-ASCII chars like U+00A0,
  // then validate the full address token rather than matching an ASCII substring.
  const bareAddr = normalizeHeaderAddrSpec(uncommented);
  return {
    address: isValidMailbox(bareAddr) ? bareAddr : undefined,
    displayName: undefined,
  };
};

interface BodySegment {
  readonly text?: string;
  readonly fallbackText?: string;
  readonly html?: string;
}

interface CollectedParts {
  readonly segments: Array<BodySegment>;
  readonly attachments: Array<ParsedAttachment>;
}

const escapeHtmlText = (value: string): string =>
  Str.replaceAll(
    "'",
    "&#39;",
  )(
    Str.replaceAll(
      '"',
      "&quot;",
    )(
      Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(value))),
    ),
  );

const plainTextToHtml = (text: string): string =>
  `<div style="white-space:pre-wrap;font-family:inherit;">${escapeHtmlText(text)}</div>`;

const stripHtmlToText = (html: string): string =>
  Str.trim(
    Str.replace(
      /\n{3,}/g,
      "\n\n",
    )(
      Str.replace(
        /[ \t]+\n/g,
        "\n",
      )(
        Str.replaceAll(
          "&#39;",
          "'",
        )(
          Str.replaceAll(
            "&quot;",
            '"',
          )(
            Str.replaceAll(
              "&gt;",
              ">",
            )(
              Str.replaceAll(
                "&lt;",
                "<",
              )(
                Str.replaceAll(
                  "&amp;",
                  "&",
                )(
                  Str.replaceAll(
                    "&nbsp;",
                    " ",
                  )(
                    Str.replace(
                      /<[^>]+>/g,
                      "",
                    )(
                      Str.replace(
                        /<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi,
                        "\n",
                      )(
                        Str.replace(
                          /<script[\s\S]*?<\/script>/gi,
                          " ",
                        )(Str.replace(/<style[\s\S]*?<\/style>/gi, " ")(html)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

const renderSegments = (
  segments: ReadonlyArray<BodySegment>,
): {
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly isFullyAuthoredText: boolean;
} => {
  const hasAnyHtml = Arr.some(segments, (seg) => seg.html !== undefined);
  const isFullyAuthoredText =
    segments.length > 0 && Arr.every(segments, (seg) => seg.text !== undefined);
  const renderedTextParts: Array<string> = [];
  const renderedHtmlParts: Array<string> = [];

  for (const seg of segments) {
    if (seg.text !== undefined) {
      renderedTextParts.push(seg.text);
    } else if (seg.fallbackText !== undefined) {
      renderedTextParts.push(seg.fallbackText);
    } else if (seg.html !== undefined) {
      const stripped = stripHtmlToText(seg.html);
      if (stripped.length > 0) renderedTextParts.push(stripped);
    }

    if (hasAnyHtml) {
      if (seg.html !== undefined) {
        renderedHtmlParts.push(seg.html);
      } else {
        const plainSource = seg.text ?? seg.fallbackText;
        if (plainSource !== undefined) {
          renderedHtmlParts.push(plainTextToHtml(plainSource));
        }
      }
    }
  }

  return {
    text: renderedTextParts.length > 0 ? Arr.join(renderedTextParts, "\n\n") : undefined,
    html: renderedHtmlParts.length > 0 ? Arr.join(renderedHtmlParts, "<hr>") : undefined,
    isFullyAuthoredText,
  };
};

const walkEntity = (raw: Uint8Array, out: CollectedParts, depth: number): void => {
  if (depth > MAX_MIME_DEPTH) return;
  const { headers: headerBlock, body } = splitHeaderAndBody(raw);
  const headers = parseHeaders(headerBlock);
  const contentType = parseHeaderParams(firstHeader(headers, "content-type"));
  const mimeType = contentType.main || "text/plain";
  const disposition = parseHeaderParams(firstHeader(headers, "content-disposition"));
  const transferEncoding = firstHeader(headers, "content-transfer-encoding");

  const boundary = Option.getOrUndefined(EffectRecord.get(contentType.params, "boundary"));
  if (Str.startsWith("multipart/")(mimeType) && boundary !== undefined && boundary !== "") {
    if (mimeType === "multipart/alternative") {
      // Per RFC 2046 §5.1.4, render each direct child completely before selecting alternatives.
      // Only children whose entire representation is authored plain text populate `segment.text`;
      // HTML-derived or partially-HTML mixed children populate `segment.fallbackText` so they
      // preserve `\n\n` part boundaries without overwriting an authored plain-text sibling.
      let authoredPlainText: string | undefined;
      let fallbackPlainText: string | undefined;
      let richestHtml: string | undefined;
      const attachments: Array<ParsedAttachment> = [];

      for (const child of splitMultipart(body, boundary)) {
        const childBucket: CollectedParts = { segments: [], attachments: [] };
        walkEntity(child, childBucket, depth + 1);
        const rendered = renderSegments(childBucket.segments);
        if (rendered.isFullyAuthoredText && rendered.text !== undefined) {
          authoredPlainText = rendered.text;
        } else if (rendered.text !== undefined) {
          fallbackPlainText = rendered.text;
        }
        if (rendered.html !== undefined) {
          richestHtml = rendered.html;
        }
        attachments.push(...childBucket.attachments);
      }

      if (
        authoredPlainText !== undefined ||
        fallbackPlainText !== undefined ||
        richestHtml !== undefined
      ) {
        const textFields = authoredPlainText !== undefined ? { text: authoredPlainText } : {};
        const fallbackTextFields =
          authoredPlainText === undefined && fallbackPlainText !== undefined
            ? { fallbackText: fallbackPlainText }
            : {};
        const htmlFields = richestHtml !== undefined ? { html: richestHtml } : {};
        out.segments.push({
          ...textFields,
          ...fallbackTextFields,
          ...htmlFields,
        });
      }
      out.attachments.push(...attachments);
      return;
    }
    // multipart/mixed, multipart/related, etc.: preserve every independent child in order.
    for (const child of splitMultipart(body, boundary)) {
      walkEntity(child, out, depth + 1);
    }
    return;
  }

  const decodedBytes = decodeTransferBody(body, transferEncoding);
  const attachmentName = Option.getOrUndefined(EffectRecord.get(disposition.params, "filename"));
  const contentName = Option.getOrUndefined(EffectRecord.get(contentType.params, "name"));
  const filename =
    decodeRfc5987Param(disposition.params["filename*"]) ??
    (attachmentName === undefined || attachmentName === ""
      ? undefined
      : decodeRfc2047(attachmentName)) ??
    decodeRfc5987Param(contentType.params["name*"]) ??
    (contentName === undefined || contentName === "" ? undefined : decodeRfc2047(contentName));

  const isAttachment =
    disposition.main === "attachment" ||
    (filename !== undefined && mimeType !== "text/plain" && mimeType !== "text/html");

  if (isAttachment) {
    out.attachments.push({
      filename: filename === undefined || filename === "" ? "attachment.bin" : filename,
      contentType: mimeType,
      contentBase64: Buffer.from(decodedBytes).toString("base64"),
      sizeBytes: decodedBytes.byteLength,
    });
    return;
  }

  if (mimeType === "text/plain") {
    out.segments.push({ text: decodeCharset(decodedBytes, contentType.params["charset"]) });
    return;
  }
  if (mimeType === "text/html") {
    out.segments.push({ html: decodeCharset(decodedBytes, contentType.params["charset"]) });
    return;
  }
  if (decodedBytes.byteLength > 0) {
    out.attachments.push({
      filename:
        filename === undefined || filename === ""
          ? `part-${out.attachments.length + 1}.bin`
          : filename,
      contentType: mimeType,
      contentBase64: Buffer.from(decodedBytes).toString("base64"),
      sizeBytes: decodedBytes.byteLength,
    });
  }
};

export const parseEmail = (raw: Uint8Array): ParsedEmail => {
  const { headers: headerBlock } = splitHeaderAndBody(raw);
  const headers = parseHeaders(headerBlock);
  const subject = trimAsciiWsp(decodeRfc2047(firstHeader(headers, "subject") ?? ""));
  const rawFrom = firstHeader(headers, "from");
  const fromHeader = trimAsciiWsp(decodeRfc2047(rawFrom ?? ""));
  const fromParsed = extractAddress(rawFrom);
  const replyToParsed = extractAddress(firstHeader(headers, "reply-to"));
  const rawMessageId = firstHeader(headers, "message-id");
  const messageId = rawMessageId !== undefined ? trimAsciiWsp(rawMessageId) : undefined;
  const rawDate = firstHeader(headers, "date");
  const date = rawDate !== undefined ? trimAsciiWsp(rawDate) : undefined;

  const collected: CollectedParts = {
    segments: [],
    attachments: [],
  };
  walkEntity(raw, collected, 0);
  const rendered = renderSegments(collected.segments);

  return {
    subject,
    fromHeader,
    fromAddress: fromParsed.address,
    fromDisplayName: fromParsed.displayName,
    replyToAddress: replyToParsed.address,
    messageId,
    date,
    text: rendered.text,
    html: rendered.html,
    attachments: collected.attachments,
  };
};
