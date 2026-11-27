/** `priceList` group handlers (http-mcp-contracts 3.5.4): one PriceList method per endpoint. */

import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { PriceList, PriceListItemInput } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Predicate from "effect/Predicate";
import { compact, requestOptions, setLocation, withRevision } from "../conventions";
import { jsonizePriceListItem } from "./records/json";

export const PriceListGroupLive = HttpApiBuilder.group(
  Api,
  "priceList",
  Effect.fnUntraced(function* (handlers) {
    const priceList = yield* PriceList;
    return handlers
      .handle("list", ({ query }) =>
        Effect.map(priceList.list(compact(query)), Arr.map(jsonizePriceListItem)),
      )
      .handle("create", ({ params, headers, payload }) =>
        priceList.save(payload, requestOptions(headers)).pipe(
          Effect.map(jsonizePriceListItem),
          Effect.tap((view) => {
            if (!Predicate.isString(view.id)) return Effect.void;
            return setLocation(
              `${API_PREFIX}/workspaces/${params.workspaceId}/price-list-items/${view.id}`,
            );
          }),
        ),
      )
      .handle("update", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) => {
          const fields = Predicate.isObject(payload) ? payload : {};
          return Effect.map(
            priceList.save({
              ...PriceListItemInput.make(fields),
              id: params.itemId,
              expectedRevision,
            }),
            jsonizePriceListItem,
          );
        }),
      )
      .handle("archive", ({ params }) => priceList.archive(params.itemId));
  }),
);
