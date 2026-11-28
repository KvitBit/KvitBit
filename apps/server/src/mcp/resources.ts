/**
 * MCP Resources (http-mcp-contracts section 6.7):
 * - 4 static resources (`resources/list`)
 * - 5 RFC 6570 URI templates (`resources/templates/list`)
 * - `resources/read` handler with 5 MB blob limit (`Invalid{attachment.too_large}`)
 */

import { MCP_RESOURCE_BLOB_MAX_BYTES, MCP_RESOURCES } from "@kvitbit/api-contract";
import { can } from "@kvitbit/core";
import {
  AttachmentId,
  ContactId,
  Contacts,
  ContactView,
  type CoreError,
  DocumentId,
  Documents,
  DocumentView,
  ExpenseId,
  Expenses,
  ExpenseView,
  Invalid,
  Locale,
  type MemberCaller,
  PdfTemplate,
  PriceList,
  PriceListItemView,
  Templates,
  TemplateView,
  Workspaces,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { guideMarkdown } from "./guide";
import { jsonizeOpenValue, makeResourceEncoder, prepareDocumentView } from "./wire";

class ResourceInvalidParams extends Schema.TaggedError<
  ResourceInvalidParams,
  { readonly brand: unique symbol }
>()("ResourceInvalidParams", { message: Schema.String }) {}

export interface McpStaticResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface McpResourceTemplateEntry {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

type McpResourceContent =
  | { readonly uri: string; readonly mimeType: string; readonly text: string }
  | { readonly uri: string; readonly mimeType: string; readonly blob: string };

const RESOURCE_METADATA: Readonly<
  Record<string, { readonly name: string; readonly description: string }>
> = {
  "kvitbit://workspace": {
    name: "Workspace",
    description:
      "Current Workspace profile, Issuing Entity, Tax Regime, bank accounts, and defaults.",
  },
  "kvitbit://templates": {
    name: "Invoice Templates",
    description: "All Invoice Templates and Recurring Schedules in the current Workspace.",
  },
  "kvitbit://price-list": {
    name: "Price List",
    description: "Catalog of Price List Items in the current Workspace.",
  },
  "kvitbit://guide": {
    name: "Kvitbit Guide",
    description:
      "Guide to Czech Tax Regimes, VatTreatment values, document lifecycle, Document Lock, and two-step confirmation.",
  },
  "kvitbit://documents/{documentId}": {
    name: "Document",
    description: "Full JSON view of a single document by DocumentId.",
  },
  "kvitbit://documents/{documentId}/pdf{?template,language}": {
    name: "Document PDF",
    description: "Rendered PDF binary (base64 blob, max 5 MB) for a document.",
  },
  "kvitbit://contacts/{contactId}": {
    name: "Contact",
    description: "Full JSON view of a single Contact by ContactId.",
  },
  "kvitbit://expenses/{expenseId}": {
    name: "Expense",
    description: "Full JSON view of a single Expense by ExpenseId.",
  },
  "kvitbit://expenses/{expenseId}/attachments/{attachmentId}": {
    name: "Expense Attachment",
    description: "Binary attachment (base64 blob, max 5 MB) attached to an Expense.",
  },
};

export const listStaticResources = (caller: MemberCaller): ReadonlyArray<McpStaticResourceEntry> =>
  Arr.map(
    Arr.filter(
      MCP_RESOURCES,
      (r) => r.kind === "static" && (r.action === null || can(caller, r.action)),
    ),
    (r) => {
      const meta = RESOURCE_METADATA[r.uri] ?? { name: r.uri, description: r.uri };
      return {
        uri: r.uri,
        name: meta.name,
        description: meta.description,
        mimeType: r.mimeType,
      };
    },
  );

export const listResourceTemplates = (
  caller: MemberCaller,
): ReadonlyArray<McpResourceTemplateEntry> =>
  Arr.map(
    Arr.filter(
      MCP_RESOURCES,
      (r) => r.kind === "template" && (r.action === null || can(caller, r.action)),
    ),
    (r) => {
      const meta = RESOURCE_METADATA[r.uri] ?? { name: r.uri, description: r.uri };
      return {
        uriTemplate: r.uri,
        name: meta.name,
        description: meta.description,
        mimeType: r.mimeType,
      };
    },
  );

const decodeId = <A>(schema: Schema.Codec<A, string>, raw: string, label: string) =>
  Schema.decodeEffect(schema)(raw).pipe(
    Effect.mapError(() => ResourceInvalidParams.make({ message: `Invalid ${label}: ${raw}` })),
  );

const collectBoundedBytes = Effect.fn("collectMcpResourceBytes")(function* (
  stream: Stream.Stream<Uint8Array>,
  maxBytes: number,
) {
  const chunks = yield* Stream.runCollect(stream);
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      return yield* Invalid.make({
        issues: [{ path: ["uri"], code: "attachment.too_large" }],
      });
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
});

const encodeWorkspace = makeResourceEncoder(WorkspaceView);
const encodeTemplates = makeResourceEncoder(Schema.Array(TemplateView));
const encodePriceList = makeResourceEncoder(Schema.Array(PriceListItemView));
const encodeDocument = makeResourceEncoder(DocumentView);
const encodeContact = makeResourceEncoder(ContactView);
const encodeExpense = makeResourceEncoder(ExpenseView);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const jsonContent = (uri: string, encoded: Schema.Json) =>
  encodeJson(encoded).pipe(
    Effect.map((text) => ({ uri, mimeType: "application/json", text })),
    Effect.orDie,
  );

export type McpResourceServices =
  | Workspaces
  | Templates
  | PriceList
  | Documents
  | Contacts
  | Expenses;

export const readResource = Effect.fn("readMcpResource")(function* (
  uri: string,
  caller: MemberCaller,
): Effect.fn.Return<
  ReadonlyArray<McpResourceContent>,
  ResourceInvalidParams | CoreError,
  McpResourceServices
> {
  if (uri === "kvitbit://guide") {
    return [
      {
        uri,
        mimeType: "text/markdown",
        text: guideMarkdown(caller.locale),
      },
    ];
  }

  if (uri === "kvitbit://workspace") {
    const ws = yield* Workspaces;
    const view = yield* ws.current(caller);
    const encoded = yield* encodeWorkspace(jsonizeOpenValue(view));
    return [yield* jsonContent(uri, encoded)];
  }

  if (uri === "kvitbit://templates") {
    const templates = yield* Templates;
    const items = yield* templates.list(caller);
    const encoded = yield* encodeTemplates(Arr.map(items, jsonizeOpenValue));
    return [yield* jsonContent(uri, encoded)];
  }

  if (uri === "kvitbit://price-list") {
    const priceList = yield* PriceList;
    const items = yield* priceList.list(caller);
    const encoded = yield* encodePriceList(Arr.map(items, jsonizeOpenValue));
    return [yield* jsonContent(uri, encoded)];
  }

  const parsed = URL.parse(uri);
  if (parsed === null) {
    return yield* ResourceInvalidParams.make({ message: `Unknown resource URI: ${uri}` });
  }

  if (parsed.protocol !== "kvitbit:") {
    return yield* ResourceInvalidParams.make({ message: `Unsupported resource scheme: ${uri}` });
  }

  const host = parsed.hostname;
  const segments = Arr.map(
    Arr.filter(Str.split(parsed.pathname, "/"), (s) => s.length > 0),
    decodeURIComponent,
  );

  // kvitbit://documents/{documentId}
  if (host === "documents" && segments.length === 1 && parsed.search === "") {
    const docId = yield* decodeId(DocumentId, segments[0] ?? "", "documentId");
    const documents = yield* Documents;
    const doc = yield* documents.get(caller, docId);
    const encoded = yield* encodeDocument(prepareDocumentView(doc));
    return [yield* jsonContent(uri, encoded)];
  }

  // kvitbit://documents/{documentId}/pdf{?template,language}
  if (host === "documents" && segments.length === 2 && segments[1] === "pdf") {
    const docId = yield* decodeId(DocumentId, segments[0] ?? "", "documentId");
    const templateParam = parsed.searchParams.get("template");
    const languageParam = parsed.searchParams.get("language");
    const template =
      templateParam !== null ? yield* decodeId(PdfTemplate, templateParam, "template") : undefined;
    const language =
      languageParam !== null ? yield* decodeId(Locale, languageParam, "language") : undefined;
    const documents = yield* Documents;
    const download = yield* documents.pdf(caller, docId, {
      ...(template !== undefined ? { template } : undefined),
      ...(language !== undefined ? { language } : undefined),
    });
    const bytes = yield* collectBoundedBytes(download.bytes, MCP_RESOURCE_BLOB_MAX_BYTES);
    return [
      {
        uri,
        mimeType: "application/pdf",
        blob: Buffer.from(bytes).toString("base64"),
      },
    ];
  }

  // kvitbit://contacts/{contactId}
  if (host === "contacts" && segments.length === 1 && parsed.search === "") {
    const contactId = yield* decodeId(ContactId, segments[0] ?? "", "contactId");
    const contacts = yield* Contacts;
    const contact = yield* contacts.get(caller, contactId);
    const encoded = yield* encodeContact(jsonizeOpenValue(contact));
    return [yield* jsonContent(uri, encoded)];
  }

  // kvitbit://expenses/{expenseId}
  if (host === "expenses" && segments.length === 1 && parsed.search === "") {
    const expenseId = yield* decodeId(ExpenseId, segments[0] ?? "", "expenseId");
    const expenses = yield* Expenses;
    const expense = yield* expenses.get(caller, expenseId);
    const encoded = yield* encodeExpense(jsonizeOpenValue(expense));
    return [yield* jsonContent(uri, encoded)];
  }

  // kvitbit://expenses/{expenseId}/attachments/{attachmentId}
  if (
    host === "expenses" &&
    segments.length === 3 &&
    segments[1] === "attachments" &&
    parsed.search === ""
  ) {
    const expenseId = yield* decodeId(ExpenseId, segments[0] ?? "", "expenseId");
    const attachmentId = yield* decodeId(AttachmentId, segments[2] ?? "", "attachmentId");
    const expenses = yield* Expenses;
    const download = yield* expenses.attachment(caller, expenseId, attachmentId);
    const bytes = yield* collectBoundedBytes(download.bytes, MCP_RESOURCE_BLOB_MAX_BYTES);
    return [
      {
        uri,
        mimeType: download.contentType,
        blob: Buffer.from(bytes).toString("base64"),
      },
    ];
  }

  return yield* ResourceInvalidParams.make({ message: `Unknown resource URI: ${uri}` });
});
