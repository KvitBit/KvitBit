/** `payments` group handlers (http-mcp-contracts 3.5.4): one Payments method per endpoint. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { Payments } from "@kvitbit/domain/contract";
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { requestOptions, setLocation } from "../conventions";
import { jsonSafe } from "./records/json";

export const PaymentsGroupLive = HttpApiBuilder.group(Api, "payments", (handlers) =>
  Effect.gen(function* () {
    const payments = yield* Payments;
    return handlers
      .handle("record", ({ params, headers, payload }) =>
        payments.record(payload, requestOptions(headers)).pipe(
          Effect.map((result) => ({ ...result, payment: jsonSafe(result.payment) })),
          Effect.tap((result) =>
            Predicate.hasProperty(result.payment, "id") && typeof result.payment.id === "string"
              ? setLocation(
                  `${API_PREFIX}/workspaces/${params.workspaceId}/payments/${result.payment.id}`,
                )
              : Effect.void,
          ),
        ),
      )
      .handle("remove", ({ params, payload }) => payments.remove(params.paymentId, payload.reason))
      .handle("listForDocument", ({ params }) =>
        Effect.map(payments.listFor({ document: params.documentId }), jsonSafe),
      )
      .handle("listForExpense", ({ params }) =>
        Effect.map(payments.listFor({ expense: params.expenseId }), jsonSafe),
      );
  }),
);
