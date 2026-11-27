/**
 * DOM-safe UI kit stand-in for `clientRoot` screen integration tests under Happy DOM.
 * Keeps `src/ui/button.tsx` and `src/ui/surface.tsx` untouched for `kit.test.tsx`, while allowing
 * full screen components with `useEffect`/`useRemote`/`ApiProvider` to render in react-dom without
 * React Native array/function `style` prop errors.
 */
import * as Arr from "effect/Array";
import type { ReactNode } from "react";
import { useOverlay } from "../../ui/overlay";
import { RemoteView } from "../../ui/remote-view";
import { contentMaxWidth, space, touchTarget } from "../../ui/tokens";

function Button(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly testID?: string;
}) {
  return (
    <button
      type="button"
      data-testid={props.testID}
      disabled={props.disabled === true || props.busy === true}
      onClick={() => {
        if (props.disabled !== true && props.busy !== true) props.onPress();
      }}
    >
      {props.label}
    </button>
  );
}

function IconButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled === true}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  );
}

function SegmentedChoice<T extends string>(props: {
  readonly label?: string;
  readonly value: T | null;
  readonly choices: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div>
      {props.label !== undefined ? <span>{props.label}</span> : null}
      {Arr.map(props.choices, (c) => (
        <button
          key={c.value}
          type="button"
          aria-pressed={c.value === props.value}
          onClick={() => props.onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label>
      <span>{props.label}</span>
      {props.description !== undefined ? <span>{props.description}</span> : null}
      <input
        type="checkbox"
        checked={props.value}
        disabled={props.disabled === true}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </label>
  );
}

function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly error?: string | null;
  readonly supporting?: string;
  readonly disabled?: boolean;
  readonly trailing?: ReactNode;
  readonly testID?: string;
  readonly placeholder?: string;
}) {
  return (
    <div>
      <span>{props.label}</span>
      <input
        data-testid={props.testID}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled === true}
        onChange={(e) => props.onChangeText(e.target.value)}
      />
      {props.trailing}
      {(props.error ?? "") !== "" ? <span>{props.error}</span> : null}
      {(props.supporting ?? "") !== "" ? <span>{props.supporting}</span> : null}
    </div>
  );
}

function Icon() {
  return null;
}

function OverlayProvider(props: { readonly children: ReactNode }) {
  return <>{props.children}</>;
}

function AppBar(props: { readonly title?: string; readonly actions?: ReactNode }) {
  return (
    <div>
      <span>{props.title ?? ""}</span>
      {props.actions}
    </div>
  );
}

function Screen(props: {
  readonly title?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <div>
      {props.title !== undefined ? <h1>{props.title}</h1> : null}
      {props.actions}
      {props.children}
      {props.footer}
    </div>
  );
}

function Badge(props: { readonly label: string }) {
  return <span>{props.label}</span>;
}

function Banner(props: {
  readonly text: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <div role="alert">
      <span>{props.text}</span>
      {props.action !== undefined ? (
        <button type="button" onClick={props.action.onPress}>
          {props.action.label}
        </button>
      ) : null}
    </div>
  );
}

function Card(props: { readonly children: ReactNode; readonly onPress?: () => void }) {
  return props.onPress !== undefined ? (
    <button type="button" onClick={props.onPress}>
      {props.children}
    </button>
  ) : (
    <div>{props.children}</div>
  );
}

function EmptyState(props: {
  readonly title: string;
  readonly body?: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <div>
      <span>{props.title}</span>
      {props.body !== undefined ? <span>{props.body}</span> : null}
      {props.action !== undefined ? (
        <button type="button" onClick={props.action.onPress}>
          {props.action.label}
        </button>
      ) : null}
    </div>
  );
}

function ListRow(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly trailing?: string;
  readonly trailingSub?: string;
  readonly badge?: ReactNode;
  readonly onPress?: () => void;
  readonly testID?: string;
}) {
  return (
    <div data-testid={props.testID}>
      {props.onPress !== undefined ? (
        <button type="button" onClick={props.onPress}>
          <span>{props.title}</span>
          {props.subtitle !== undefined ? <span>{props.subtitle}</span> : null}
          {props.trailing !== undefined ? <span>{props.trailing}</span> : null}
          {props.trailingSub !== undefined ? <span>{props.trailingSub}</span> : null}
          {props.badge}
        </button>
      ) : (
        <>
          <span>{props.title}</span>
          {props.subtitle !== undefined ? <span>{props.subtitle}</span> : null}
          {props.trailing !== undefined ? <span>{props.trailing}</span> : null}
          {props.trailingSub !== undefined ? <span>{props.trailingSub}</span> : null}
          {props.badge}
        </>
      )}
    </div>
  );
}

function Loading(props: { readonly label?: string }) {
  return <div>{props.label ?? "Loading"}</div>;
}

function Section(props: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section>
      {props.title !== undefined ? <h2>{props.title}</h2> : null}
      {props.action}
      {props.children}
    </section>
  );
}

function Text(props: { readonly children?: ReactNode; readonly testID?: string }) {
  return <span data-testid={props.testID}>{props.children}</span>;
}

export const uiShim = {
  Button,
  IconButton,
  SegmentedChoice,
  SwitchRow,
  TextField,
  Icon,
  useOverlay,
  OverlayProvider,
  RemoteView,
  AppBar,
  Screen,
  Badge,
  Banner,
  Card,
  EmptyState,
  ListRow,
  Loading,
  Section,
  Text,
  textStyle: () => ({}),
  contentMaxWidth,
  space,
  touchTarget,
};
