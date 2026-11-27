/**
 * Lightweight RFC 5322 + MIME email parser (zero external dependencies).
 *
 * Extracts decoded Subject, From, Reply-To, Message-ID, Date, text/plain,
 * text/html, and attachments from raw SMTP message bytes for clean Resend
 * forwarding while preserving raw `.eml` bytes separately in GCS.
 */

import { domainToASCII } from "node:url";

export interface ParsedAttachment {
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
export const trimAsciiWsp = (value: string): string => value.replace(/^[ \t]+|[ \t]+$/g, "");

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

export const parseHeaders = (headerBlock: string): Map<string, Array<string>> => {
  const result = new Map<string, Array<string>>();
  const lines = headerBlock.replace(/\r\n/g, "\n").split("\n");
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
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentName !== undefined) {
      currentValue += ` ${trimAsciiWsp(line)}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    currentName = trimAsciiWsp(line.slice(0, colon)).toLowerCase();
    currentValue = trimAsciiWsp(line.slice(colon + 1));
  }
  flush();
  return result;
};

const firstHeader = (headers: Map<string, Array<string>>, name: string): string | undefined =>
  headers.get(name.toLowerCase())?.[0];

const decodeCharset = (bytes: Uint8Array, charsetRaw?: string): string => {
  const normalized = (charsetRaw ?? "utf-8")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  const mapped =
    normalized === "us-ascii" || normalized === "ascii"
      ? "utf-8"
      : normalized === "latin1" || normalized === "iso8859-1"
        ? "iso-8859-1"
        : normalized;
  try {
    return new TextDecoder(mapped as ConstructorParameters<typeof TextDecoder>[0], {
      fatal: false,
    }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
};

export const decodeQuotedPrintable = (input: Uint8Array, headerMode = false): Uint8Array => {
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
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
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

export const decodeRfc2047 = (value: string): string => {
  // Collapse whitespace between adjacent encoded words per RFC 2047 section 6.2.
  const collapsed = value.replace(/\?=[ \t]+=\?/g, "?==?");
  return collapsed.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, text: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          const bytes = Buffer.from(text, "base64");
          return decodeCharset(bytes, charset);
        }
        const bytes = decodeQuotedPrintable(Buffer.from(text, "latin1"), true);
        return decodeCharset(bytes, charset);
      } catch {
        return text;
      }
    },
  );
};

const parseHeaderParams = (
  headerValue: string | undefined,
): { main: string; params: Record<string, string> } => {
  if (!headerValue) return { main: "", params: {} };
  const parts = headerValue.split(";");
  const main = (parts[0] ?? "").trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    params[key] = val;
  }
  return { main, params };
};

const decodeRfc5987Param = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const match = raw.match(/^([^']*)'[^']*'(.*)$/);
  if (!match) return decodeRfc2047(raw);
  const charset = match[1] || "utf-8";
  const encoded = match[2] ?? "";
  const bytes: Array<number> = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === "%" && i + 2 < encoded.length) {
      const hex = encoded.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(encoded.charCodeAt(i) & 0xff);
  }
  return decodeCharset(Uint8Array.from(bytes), charset);
};

const decodeTransferBody = (body: Uint8Array, encodingRaw?: string): Uint8Array => {
  const encoding = (encodingRaw ?? "7bit").trim().toLowerCase();
  if (encoding === "base64") {
    const cleaned = Buffer.from(body)
      .toString("ascii")
      .replace(/[^A-Za-z0-9+/=]/g, "");
    return Uint8Array.from(Buffer.from(cleaned, "base64"));
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body, false);
  }
  return body;
};

const splitMultipart = (body: Uint8Array, boundary: string): Array<Uint8Array> => {
  const delimiter = `--${boundary}`;
  const rawStr = Buffer.from(body).toString("latin1");
  const parts: Array<Uint8Array> = [];
  let searchFrom = 0;

  while (searchFrom < rawStr.length) {
    const idx = rawStr.indexOf(delimiter, searchFrom);
    if (idx === -1) break;
    // Boundary must start at beginning of body or after LF.
    if (idx > 0 && rawStr[idx - 1] !== "\n") {
      searchFrom = idx + delimiter.length;
      continue;
    }
    let partStart = idx + delimiter.length;
    if (rawStr.startsWith("--", partStart)) {
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
    const nextIdx = rawStr.indexOf(`\n${delimiter}`, partStart);
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
  if (label.length === 0 || label.startsWith("-") || label.endsWith("-")) return false;
  for (const ch of label) {
    const code = ch.charCodeAt(0);
    if (code <= 0x7f) {
      const isAsciiLdh =
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code === 0x2d;
      if (!isAsciiLdh) return false;
    } else if (/\s/.test(ch)) {
      return false;
    }
  }
  return true;
};

const isValidDomain = (domain: string): boolean => {
  if (domain.length === 0 || domain.length > 253) return false;
  const rawLabels = domain.split(".");
  if (rawLabels.length < 2 || !rawLabels.every(isValidRawDomainLabel)) {
    return false;
  }
  const asciiDomain = domainToASCII(domain);
  if (asciiDomain.length === 0 || asciiDomain.length > 253) return false;
  const asciiLabels = asciiDomain.split(".");
  if (asciiLabels.length < 2) return false;
  if (!asciiLabels.every((label) => ASCII_LDH_LABEL_RE.test(label))) return false;
  const tld = asciiLabels[asciiLabels.length - 1] ?? "";
  if (/^\d+$/.test(tld)) return false;
  return true;
};

const hasDisallowedLocalChar = (local: string): boolean => {
  for (const ch of local) {
    const code = ch.charCodeAt(0);
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
  const atIdx = address.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === address.length - 1) return false;
  const local = address.slice(0, atIdx);
  const domain = address.slice(atIdx + 1);
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
  trimAsciiWsp(rawAddr)
    .replace(/[ \t]*@[ \t]*/g, "@")
    .replace(/[ \t]*\.[ \t]*/g, ".");

export const extractAddress = (
  headerValue: string | undefined,
): { address: string | undefined; displayName: string | undefined } => {
  if (!headerValue) return { address: undefined, displayName: undefined };
  // Strip RFC 5322 comments (including trailing/inline comments) before RFC 2047 decoding
  // so neither comments nor encoded display-names can break or spoof angle-addr parsing.
  const uncommented = stripRfc5322Comments(headerValue);
  const angleMatch = uncommented.match(/^([\s\S]*?)<[ \t]*([^<>]+?)[ \t]*>[ \t]*$/);
  if (angleMatch) {
    const rawName = trimAsciiWsp(
      trimAsciiWsp(decodeRfc2047(angleMatch[1] ?? "")).replace(/^["']|["']$/g, ""),
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
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const plainTextToHtml = (text: string): string =>
  `<div style="white-space:pre-wrap;font-family:inherit;">${escapeHtmlText(text)}</div>`;

const stripHtmlToText = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const renderSegments = (
  segments: ReadonlyArray<BodySegment>,
): {
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly isFullyAuthoredText: boolean;
} => {
  const hasAnyHtml = segments.some((seg) => seg.html !== undefined);
  const isFullyAuthoredText =
    segments.length > 0 && segments.every((seg) => seg.text !== undefined);
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
    text: renderedTextParts.length > 0 ? renderedTextParts.join("\n\n") : undefined,
    html: renderedHtmlParts.length > 0 ? renderedHtmlParts.join("<hr>") : undefined,
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

  if (mimeType.startsWith("multipart/") && contentType.params.boundary) {
    if (mimeType === "multipart/alternative") {
      // Per RFC 2046 §5.1.4, render each direct child completely before selecting alternatives.
      // Only children whose entire representation is authored plain text populate `segment.text`;
      // HTML-derived or partially-HTML mixed children populate `segment.fallbackText` so they
      // preserve `\n\n` part boundaries without overwriting an authored plain-text sibling.
      let authoredPlainText: string | undefined;
      let fallbackPlainText: string | undefined;
      let richestHtml: string | undefined;
      const attachments: Array<ParsedAttachment> = [];

      for (const child of splitMultipart(body, contentType.params.boundary)) {
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
        out.segments.push({
          ...(authoredPlainText !== undefined ? { text: authoredPlainText } : {}),
          ...(authoredPlainText === undefined && fallbackPlainText !== undefined
            ? { fallbackText: fallbackPlainText }
            : {}),
          ...(richestHtml !== undefined ? { html: richestHtml } : {}),
        });
      }
      out.attachments.push(...attachments);
      return;
    }
    // multipart/mixed, multipart/related, etc.: preserve every independent child in order.
    for (const child of splitMultipart(body, contentType.params.boundary)) {
      walkEntity(child, out, depth + 1);
    }
    return;
  }

  const decodedBytes = decodeTransferBody(body, transferEncoding);
  const filename =
    decodeRfc5987Param(disposition.params["filename*"]) ??
    (disposition.params.filename ? decodeRfc2047(disposition.params.filename) : undefined) ??
    decodeRfc5987Param(contentType.params["name*"]) ??
    (contentType.params.name ? decodeRfc2047(contentType.params.name) : undefined);

  const isAttachment =
    disposition.main === "attachment" ||
    (filename !== undefined && mimeType !== "text/plain" && mimeType !== "text/html");

  if (isAttachment) {
    out.attachments.push({
      filename: filename || "attachment.bin",
      contentType: mimeType,
      contentBase64: Buffer.from(decodedBytes).toString("base64"),
      sizeBytes: decodedBytes.byteLength,
    });
    return;
  }

  if (mimeType === "text/plain") {
    out.segments.push({ text: decodeCharset(decodedBytes, contentType.params.charset) });
    return;
  }
  if (mimeType === "text/html") {
    out.segments.push({ html: decodeCharset(decodedBytes, contentType.params.charset) });
    return;
  }
  if (decodedBytes.byteLength > 0) {
    out.attachments.push({
      filename: filename || `part-${out.attachments.length + 1}.bin`,
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
