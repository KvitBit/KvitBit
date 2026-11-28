import type { View } from "@effect/ui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

export type Markup<Message = never, Requirements = never> = View.Content<Message, Requirements>;

interface AttributeTarget<Node> {
  attr: (name: string, value: string | undefined) => Node;
}

export type Attribute = <Node extends AttributeTarget<Node>>(element: Node) => Node;

const attributeImpl =
  (name: string, value: string | boolean | number): Attribute =>
  (element) =>
    element.attr(name, String(value));

export const attribute: {
  (value: string | boolean | number): (name: string) => Attribute;
  (name: string, value: string | boolean | number): Attribute;
} = Fn.dual(2, attributeImpl);

const withAttributesImpl = <Node>(
  element: Node,
  decorate: ReadonlyArray<(element: NoInfer<Node>) => NoInfer<Node>>,
): Node => Arr.reduce(decorate, element, (node, apply) => apply(node));

export const withAttributes: {
  <Node>(
    decorate: ReadonlyArray<(element: NoInfer<Node>) => NoInfer<Node>>,
  ): (element: Node) => Node;
  <Node>(element: Node, decorate: ReadonlyArray<(element: NoInfer<Node>) => NoInfer<Node>>): Node;
} = Fn.dual(2, withAttributesImpl);

export const svgImage = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;
