/** `payments` group handlers (http-mcp-contracts 3.5.4): one Payments method per endpoint. */
import { API_PREFIX, Api, RequestCaller } from "@kvitbit/api-contract";
import { Payments } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Predicate from "effect/Predicate";
import { requestOptions, setLocation } from "../conventions";
import { jsonizePayment } from "./records/json";

export const PaymentsGroupLive = HttpApiBuilder.group(
  Api,
  "payments",
  Effect.fnUntraced(function* (handlers) {
    const payments = yield* Payments;
    return handlers
      .handle("record", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          payments.record(caller, payload, requestOptions(headers)).pipe(
            Effect.map((result) => ({ ...result, payment: jsonizePayment(result.payment) })),
            Effect.tap(({ payment }) => {
              if (!(Predicate.hasProperty(payment, "id") && Predicate.isString(payment.id))) {
                return Effect.void;
              }
              return setLocation(
                `${API_PREFIX}/workspaces/${params.workspaceId}/payments/${payment.id}`,
              );
            }),
          ),
        ),
      )
      .handle("remove", ({ params, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          payments.remove(caller, params.paymentId, payload.reason),
        ),
      )
      .handle("listForDocument", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            payments.listFor(caller, { document: params.documentId }),
            Arr.map(jsonizePayment),
          ),
        ),
      )
      .handle("listForExpense", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            payments.listFor(caller, { expense: params.expenseId }),
            Arr.map(jsonizePayment),
          ),
        ),
      );
  }),
);
