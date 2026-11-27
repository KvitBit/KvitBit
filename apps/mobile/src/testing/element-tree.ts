import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

export interface HostProps {
  readonly children?: React.ReactNode;
  readonly testID?: string;
  readonly disabled?: boolean;
  readonly editable?: boolean;
  readonly value?: string;
}

type WrapElement = (component: React.ReactElement) => React.ReactElement;

const keepElement: WrapElement = (node) => node;

/** Runs a single function component with its providers, without rendering its returned tree. */
const elementTree = <Props>(
  component: (props: Props) => React.ReactNode,
  props: Props,
  within: WrapElement,
): React.ReactNode => {
  let tree: React.ReactNode = null;
  // biome-ignore lint/correctness/noComponentHookFactories: a probe that captures one render
  const Probe = () => {
    tree = component(props);
    return null;
  };
  renderToStaticMarkup(within(React.createElement(Probe)));
  return tree;
};

const isForwardRef = Schema.is(Schema.Struct({ render: Schema.instanceOf(globalThis.Function) }));

/** Resolves function components and forward refs to their host elements. */
export const hostTree = (
  ...[node, within = keepElement]: [node: React.ReactNode, within?: WrapElement]
): React.ReactNode => {
  if (!React.isValidElement<HostProps>(node)) return node;
  const descend = (child: React.ReactNode) => hostTree(child, within);
  const type = node.type;
  if (type instanceof globalThis.Function && !(type.prototype instanceof React.Component)) {
    return descend(
      elementTree(
        (props: HostProps): React.ReactNode => Reflect.apply(type, undefined, [props]),
        node.props,
        within,
      ),
    );
  }
  if (isForwardRef(type)) {
    const { render } = type;
    return descend(
      elementTree(
        (props: HostProps): React.ReactNode => Reflect.apply(render, undefined, [props, null]),
        node.props,
        within,
      ),
    );
  }
  return node.props.children === undefined
    ? node
    : React.cloneElement(
        node,
        undefined,
        ...(React.Children.map(node.props.children, descend) ?? []),
      );
};

/** Finds every matching host or component element in document order. */
export const findAll = <Props = HostProps>(
  ...[node, type]: [node: React.ReactNode, type: string | React.JSXElementConstructor<Props>]
): ReadonlyArray<React.ReactElement<Props>> => {
  if (!React.isValidElement<HostProps>(node)) return [];
  const nested = Arr.flatMap(React.Children.toArray(node.props.children), (child) =>
    findAll(child, type),
  );
  return node.type === type && React.isValidElement<Props>(node) ? [node, ...nested] : nested;
};

export const find = <Props = HostProps>(
  ...args: [node: React.ReactNode, type: string | React.JSXElementConstructor<Props>]
): React.ReactElement<Props> | undefined => findAll(...args)[0];

const isText = Schema.is(Schema.Union([Schema.String, Schema.Finite]));

/** Joins string and number children from the host tree in document order. */
export const allText = (node: React.ReactNode): string => {
  if (isText(node)) return String(node);
  if (!React.isValidElement<HostProps>(node)) return "";
  return Arr.join(
    Arr.filter(
      Arr.map(React.Children.toArray(node.props.children), allText),
      (text) => text !== "",
    ),
    " ",
  );
};
