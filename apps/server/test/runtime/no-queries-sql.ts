import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

/** Boot configuration tests never acquire a database connection. */
export const NoQueriesSqlLive = Layer.effect(
  SqlClient.SqlClient,
  SqlClient.make({
    driver: "config-test",
    acquirer: Effect.die("Boot configuration unexpectedly opened a SQL connection"),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [],
  }),
).pipe(Layer.provide(Reactivity.layer));
