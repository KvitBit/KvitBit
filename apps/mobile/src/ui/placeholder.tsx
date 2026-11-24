import { Screen } from "./screen";
import { EmptyState } from "./surface";

/** Stand-in for a route whose screen lands in a later commit. */
export function Placeholder(props: { readonly title: string }) {
  return (
    <Screen title={props.title} back>
      <EmptyState title={props.title} />
    </Screen>
  );
}
