import { expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { exportJob, ReportsModule } from "@kvitbit/core";
import {
  Caller,
  ContactId,
  Contacts,
  CurrencyCode,
  DocumentId,
  Documents,
  ExpenseId,
  Expenses,
  ExportId,
  IsoDate,
  PaymentId,
  Payments,
  UserId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { BlobStorage } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { DataExportWorkflow, makeWorkflowHandlersLayer } from "../../src/runtime/workflows";
import { runSqlCore } from "../persistence/conformance/sqlCore";

test("exports canonical reporting bytes from bounded SQL pages after emitting its first ZIP header", async () => {
  // This fixture fits in the classic central directory, even if entry headers reserve ZIP64 sizes.
  const unzip = (bytes: Uint8Array) => {
    const archive = Buffer.from(bytes);
    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    const count = archive.readUInt16LE(end + 10);
    let index = archive.readUInt32LE(end + 16);
    const entries = new Map<string, Uint8Array>();
    for (let entry = 0; entry < count; entry++) {
      expect(archive.readUInt32LE(index)).toBe(0x02014b50);
      const nameLength = archive.readUInt16LE(index + 28);
      const extraLength = archive.readUInt16LE(index + 30);
      const commentLength = archive.readUInt16LE(index + 32);
      const name = archive.toString("utf8", index + 46, index + 46 + nameLength);
      const local = archive.readUInt32LE(index + 42);
      const start =
        local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const compressedLength = archive.readUInt32LE(index + 20);
      const body = archive.subarray(start, start + compressedLength);
      entries.set(name, inflateRawSync(body));
      index += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  };

  const owner = {
    userId: UserId.make("01950000-0000-7000-8000-000000000001"),
    name: "Owner",
    email: "owner@example.test",
  };
  const exportId = ExportId.make("01950000-0000-7000-8000-000000000002");
  const date = IsoDate.make("2026-11-23");
  const czk = CurrencyCode.make("CZK");
  const eur = CurrencyCode.make("EUR");
  const workflows = makeWorkflowHandlersLayer().pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory),
  );

  const result = await runSqlCore({
    effect: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspaces = yield* Workspaces;
      const member = yield* workspaces.create(
        Caller.account({ ...owner, channel: "web", locale: "cs" }),
        {
          name: "Report export fixture",
          taxRegime: "vat_payer",
          ico: "25596641",
          dic: "CZ25596641",
          address: { city: "Praha", country: "CZ" },
        },
      );
      const { workspaceId } = member;

      const contacts = yield* Contacts;
      const documents = yield* Documents;
      const payments = yield* Payments;
      const expenses = yield* Expenses;
      const contact = yield* contacts.save(member, {
        name: '=Kupující, "s.r.o."',
        address: { city: "Brno", country: "CZ" },
        roles: ["customer", "supplier"],
      });
      const contactId = yield* Schema.decodeUnknownEffect(ContactId)(contact["id"]);
      const input = {
        kind: "proforma",
        contact: contactId,
        issuedOn: date,
        due: { inDays: 14 },
        currency: czk,
        lines: [
          {
            description: "Záloha",
            quantity: BigDecimal.fromStringUnsafe("1"),
            unitPrice: BigDecimal.fromStringUnsafe("10000.01"),
            vat: "standard",
          },
        ],
      } as const;
      const proforma = yield* documents.issue(member, { input });
      const proformaId = DocumentId.make(proforma.id);
      const { payment } = yield* payments.record(member, {
        target: { document: proformaId },
        amount: { amount: BigDecimal.fromStringUnsafe("12100.01"), currency: czk },
        paidOn: date,
        method: "bank_transfer",
      });
      const final = yield* documents.issueFinalInvoice(member, proformaId, {
        patch: { issuedOn: date, taxableSupplyOn: date },
      });
      yield* documents.correct(member, DocumentId.make(final.id), {
        reason: "Sleva",
        lines: "full",
        correctedOn: date,
      });
      yield* documents.createDraft(member, { ...input, kind: "invoice" });
      const expense = yield* expenses.record(member, {
        status: "complete",
        supplier: { contact: contactId },
        supplierDocumentNumber: '@Číslo; "doklad"',
        issuedOn: date,
        taxableSupplyOn: date,
        currency: eur,
        total: "121.01",
        vat: [
          {
            treatment: "standard",
            base: "100.01",
            vat: "21",
          },
        ],
        tags: ["z", "á", "a"],
        deductibility: { partial: 73 },
      });
      const expenseId = yield* Schema.decodeUnknownEffect(ExpenseId)(expense["id"]);
      yield* expenses.record(member, { status: "incomplete" });
      yield* expenses.attach(member, expenseId, {
        name: "receipt.pdf",
        contentType: "application/pdf",
        bytes: Stream.make(new TextEncoder().encode("%PDF-test receipt")),
      });
      const { id: paymentId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: PaymentId }))(
        payment,
      );

      // Sort these rows before the original records so the proforma's linked documents
      // fall on a different page. Give payments earlier IDs and later dates.
      yield* sql`
        insert into documents
        select (jsonb_populate_record(null::documents, to_jsonb(seed) || jsonb_build_object(
          'id', '00000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'),
          'number', 'EXPORT-' || n,
          'status', 'cancelled'
        ))).*
        from documents seed cross join generate_series(1, 127) n
        where seed.id = ${proformaId}
      `;
      yield* sql`
        insert into payments
        select (jsonb_populate_record(null::payments, to_jsonb(seed) || jsonb_build_object(
          'id', '00000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'),
          'paid_on', '2026-11-24',
          'removed_at', case when n = 129 then now() else null end
        ))).*
        from payments seed cross join generate_series(1, 129) n
        where seed.id = ${paymentId}
      `;
      yield* sql`
        insert into expenses
        select (jsonb_populate_record(null::expenses, to_jsonb(seed) || jsonb_build_object(
          'id', '00010000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'),
          'removed_at', case when n = 129 then now() else null end
        ))).*
        from expenses seed cross join generate_series(1, 129) n
        where seed.id = ${expenseId}
      `;
      yield* sql`
        insert into expenses (id, workspace_id, status)
        select ('00000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
               ${workspaceId}, 'incomplete'
        from generate_series(257, 384) n
      `;
      yield* sql`insert into exports (id, workspace_id) values (${exportId}, ${workspaceId})`;

      const expectedFiles = yield* exportJob.reportingTables(workspaceId, "cs");
      const source = yield* ReportsModule.ReportsSource;
      const jobs = yield* ReportsModule.ExportJobs;
      const blobs = yield* BlobStorage;
      const archiveKey = ReportsModule.exportBlobKey(workspaceId, exportId);
      const pageRows = {
        documents: Arr.empty<number>(),
        payments: Arr.empty<number>(),
        expenses: Arr.empty<number>(),
      };
      const observe = <A, E, R>(read: Effect.Effect<ReadonlyArray<A>, E, R>, sizes: number[]) =>
        Effect.tap(read, (rows) =>
          Effect.sync(() => {
            sizes.push(rows.length);
          }),
        );
      let firstHeader: Uint8Array | undefined;
      let pagesAtFirstHeader = -1;
      let attachmentReads = 0;

      const outcome = yield* DataExportWorkflow.execute({ workspaceId, exportId }).pipe(
        Effect.provide(workflows),
        Effect.provideService(ReportsModule.ReportsSource, {
          ...source,
          documents: (ws, range) => observe(source.documents(ws, range), pageRows.documents),
          payments: (ws, range) => observe(source.payments(ws, range), pageRows.payments),
          expenses: (ws, range) => observe(source.expenses(ws, range), pageRows.expenses),
        }),
        Effect.provideService(ReportsModule.ExportJobs, {
          ...jobs,
          reportingTables: () => Effect.die(new Error("Eager report read")),
        }),
        Effect.provideService(BlobStorage, {
          ...blobs,
          put: (key, upload, meta) =>
            blobs.put(
              key,
              upload.pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    if (key !== archiveKey || firstHeader !== undefined) return;
                    firstHeader = chunk.slice(0, 4);
                    pagesAtFirstHeader = Arr.reduce(
                      EffectRecord.values(pageRows),
                      0,
                      (sum, rows) => sum + rows.length,
                    );
                  }),
                ),
              ),
              meta,
            ),
          get: (key) =>
            sql`select 1`.pipe(
              Effect.orDie,
              Effect.tap(() =>
                Effect.sync(() => {
                  attachmentReads++;
                }),
              ),
              Effect.andThen(blobs.get(key)),
            ),
        }),
      );
      expect(outcome).toBe("ready");
      expect(firstHeader).toEqual(Uint8Array.of(0x50, 0x4b, 0x03, 0x04));
      expect(pagesAtFirstHeader).toBe(0);
      expect(pageRows.expenses[0]).toBe(0);
      for (const sizes of EffectRecord.values(pageRows)) {
        expect(sizes.length).toBeGreaterThan(1);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(128);
        expect(Arr.reduce(sizes, 0, (total, size) => total + size)).toBeGreaterThan(128);
      }

      const body = yield* blobs.get(archiveKey);
      const chunks = yield* Stream.runCollect(body);
      const entries = unzip(Buffer.concat(chunks));
      for (const expected of expectedFiles) {
        const expectedChunks = yield* Stream.runCollect(expected.bytes);
        const bytes = Buffer.concat(expectedChunks);
        expect(entries.get(expected.name)).toEqual(bytes);
      }
      const attachment = Option.getOrUndefined(
        Arr.findFirst([...entries], ([name]) => Str.endsWith("-receipt.pdf")(name)),
      );
      expect(attachment?.[1]).toEqual(Buffer.from("%PDF-test receipt"));
      expect(attachmentReads).toBe(1);
      const pdfIds = Arr.map(
        Arr.filter([...entries.keys()], (name) => Str.startsWith("pdfs/")(name)),
        (name) => Str.slice(-40, -4)(name),
      );
      const documentIds = yield* sql<{ readonly id: string }>`
        select id from documents where workspace_id = ${workspaceId} order by id
      `;
      expect(pdfIds).toEqual(Arr.map(documentIds, ({ id }) => id));
    }),
    options: {
      users: [owner],
      fixings: [
        {
          fixingDate: date,
          sequence: 226,
          rates: [
            {
              code: eur,
              quantity: 1,
              rate: BigDecimal.fromStringUnsafe("25.153246"),
            },
          ],
        },
      ],
    },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
}, 30_000);
