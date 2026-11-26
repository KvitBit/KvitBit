import type { View } from "@effect/ui";

export type Markup<Message = never, Requirements = never> = View.Content<Message, Requirements>;

interface AttributeTarget<Node> {
  attr(name: string, value: string | boolean | number | null | undefined): Node;
}

export type Attribute = <Node extends AttributeTarget<Node>>(element: Node) => Node;

export const attribute =
  (name: string, value: string | boolean | number): Attribute =>
  (element) =>
    element.attr(name, value);

export const withAttributes = <Node>(
  element: Node,
  decorate: ReadonlyArray<(element: NoInfer<Node>) => NoInfer<Node>>,
): Node => decorate.reduce((node, apply) => apply(node), element);

export const svgImage = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;
