/**
 * Lightweight RFC 5322 + MIME email parser (zero external dependencies).
 *
 * Extracts decoded Subject, From, Reply-To, Message-ID, Date, text/plain,
 * text/html, and attachments from raw SMTP message bytes for clean Resend
 * forwarding while preserving raw `.eml` bytes separately in GCS.
 */

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
    list.push(currentValue.trim());
    result.set(currentName, list);
    currentName = undefined;
    currentValue = "";
  };

  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentName !== undefined) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    currentName = line.slice(0, colon).trim().toLowerCase();
    currentValue = line.slice(colon + 1).trim();
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

const SIMPLE_EMAIL_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

export const extractAddress = (
  headerValue: string | undefined,
): { address: string | undefined; displayName: string | undefined } => {
  if (!headerValue) return { address: undefined, displayName: undefined };
  const raw = headerValue.trim();
  // Parse RFC 5322 angle-addr before RFC 2047 decoding so an encoded display-name
  // containing CRLF or angle brackets cannot spoof the extracted address.
  const angleMatch = raw.match(/^([\s\S]*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (angleMatch) {
    const rawName = decodeRfc2047(angleMatch[1] ?? "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    const addr = (angleMatch[2] ?? "").trim();
    return {
      address: SIMPLE_EMAIL_RE.test(addr) ? addr : undefined,
      displayName: rawName.length > 0 ? rawName : undefined,
    };
  }
  const bareMatch = raw.match(SIMPLE_EMAIL_RE);
  return {
    address: bareMatch ? bareMatch[0] : undefined,
    displayName: undefined,
  };
};

interface CollectedParts {
  readonly textParts: Array<string>;
  readonly htmlParts: Array<string>;
  readonly attachments: Array<ParsedAttachment>;
}

const walkEntity = (
  raw: Uint8Array,
  out: CollectedParts,
  depth: number,
  inAlternative: boolean,
): void => {
  if (depth > MAX_MIME_DEPTH) return;
  const { headers: headerBlock, body } = splitHeaderAndBody(raw);
  const headers = parseHeaders(headerBlock);
  const contentType = parseHeaderParams(firstHeader(headers, "content-type"));
  const mimeType = contentType.main || "text/plain";
  const disposition = parseHeaderParams(firstHeader(headers, "content-disposition"));
  const transferEncoding = firstHeader(headers, "content-transfer-encoding");

  if (mimeType.startsWith("multipart/") && contentType.params.boundary) {
    const isAlt = mimeType === "multipart/alternative";
    if (isAlt) {
      const altBucket: CollectedParts = { textParts: [], htmlParts: [], attachments: [] };
      for (const child of splitMultipart(body, contentType.params.boundary)) {
        walkEntity(child, altBucket, depth + 1, true);
      }
      if (altBucket.textParts.length > 0) {
        out.textParts.push(altBucket.textParts.join("\n\n"));
      }
      if (altBucket.htmlParts.length > 0) {
        out.htmlParts.push(altBucket.htmlParts.join("<hr>"));
      }
      out.attachments.push(...altBucket.attachments);
      return;
    }
    for (const child of splitMultipart(body, contentType.params.boundary)) {
      walkEntity(child, out, depth + 1, false);
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
    if (!inAlternative || out.textParts.length === 0) {
      out.textParts.push(decodeCharset(decodedBytes, contentType.params.charset));
    }
    return;
  }
  if (mimeType === "text/html") {
    if (!inAlternative || out.htmlParts.length === 0) {
      out.htmlParts.push(decodeCharset(decodedBytes, contentType.params.charset));
    }
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
  const subject = decodeRfc2047(firstHeader(headers, "subject") ?? "").trim();
  const rawFrom = firstHeader(headers, "from");
  const fromHeader = decodeRfc2047(rawFrom ?? "").trim();
  const fromParsed = extractAddress(rawFrom);
  const replyToParsed = extractAddress(firstHeader(headers, "reply-to"));
  const messageId = firstHeader(headers, "message-id")?.trim();
  const date = firstHeader(headers, "date")?.trim();

  const collected: CollectedParts = {
    textParts: [],
    htmlParts: [],
    attachments: [],
  };
  walkEntity(raw, collected, 0, false);

  return {
    subject,
    fromHeader,
    fromAddress: fromParsed.address,
    fromDisplayName: fromParsed.displayName,
    replyToAddress: replyToParsed.address,
    messageId,
    date,
    text: collected.textParts.length > 0 ? collected.textParts.join("\n\n") : undefined,
    html: collected.htmlParts.length > 0 ? collected.htmlParts.join("<hr>") : undefined,
    attachments: collected.attachments,
  };
};
