import { mock } from "bun:test";
import * as EffectArray from "effect/Array";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { createContext, useContext } from "react";
import { TestWindowDimensions } from "./window-dimensions";

// React Native defines `__DEV__` before any module runs, and Expo's modules
// read it on import. Tests run as a release build; one that switches it on
// puts `false` back when it ends, so no file depends on the order it runs in.
Object.assign(globalThis, { __DEV__: false });

/**
 * Bun can't load React Native or Expo's native modules, so tests get small
 * stand-ins for the parts the auth code touches: the platform, the app
 * scheme, and crypto backed by Node's.
 */
// React Native's `StyleSheet.flatten`: nested arrays merged left to right,
// falsy entries skipped.
const StyleFields = Schema.Record(Schema.String, Schema.Unknown);
const decodeStyle = Schema.decodeUnknownOption(StyleFields);

type StyleInput = typeof StyleFields.Type | Array<StyleInput> | false | number | null | undefined;

const flattenStyle = (style: StyleInput): typeof StyleFields.Type | undefined =>
  EffectArray.isArray(style)
    ? EffectArray.reduce(style, {}, (merged, entry) => Object.assign(merged, flattenStyle(entry)))
    : Option.getOrUndefined(decodeStyle(style));

const resolve = <A>(read: () => A) => Effect.runPromise(Effect.sync(read));

const interpolate = <Value>(config: { readonly outputRange: readonly Value[] }) =>
  config.outputRange[0];
const emptyListener = () => "";
const noop = (): void => undefined;
const InertStatusBar = () => null;

class AnimatedValue {
  private value: number;

  constructor(value: number) {
    this.value = value;
  }
  setValue(value: number) {
    this.value = value;
  }
  readonly interpolate = interpolate;
  readonly addListener = emptyListener;
  readonly removeAllListeners = noop;
  readonly stopAnimation = noop;
  valueOf() {
    return this.value;
  }
}

const stillAnimation = () => ({
  start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
  stop: () => undefined,
  reset: () => undefined,
});

mock.module("react-native", () => ({
  // Host components stand in as their names, so a test can read the element
  // tree a component returns without a native renderer.
  ActivityIndicator: "ActivityIndicator",
  FlatList: "FlatList",
  Image: "Image",
  SectionList: "SectionList",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Pressable: "Pressable",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: {
    absoluteFill: {},
    create: <Styles>(styles: Styles) => styles,
    flatten: flattenStyle,
    hairlineWidth: 1,
  },
  AccessibilityInfo: {
    announceForAccessibility: () => undefined,
    isReduceMotionEnabled: () => resolve(() => false),
    isHighTextContrastEnabled: () => resolve(() => false),
    addEventListener: () => ({ remove: () => undefined }),
  },
  Platform: {
    OS: "android",
    select: <A>(options: { android?: A; native?: A; default?: A }) =>
      options.android ?? options.native ?? options.default,
  },
  NativeModules: {},
  DeviceEventEmitter: { addListener: () => ({ remove: () => undefined }) },
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => undefined }),
  },
  Linking: {
    addEventListener: () => ({ remove: () => undefined }),
  },
  BackHandler: {
    addEventListener: () => ({ remove: () => undefined }),
  },
  // Animations stand still: values keep what they were set to and every
  // animation finishes at once when started.
  Animated: {
    View: "Animated.View",
    Text: "Animated.Text",
    Value: AnimatedValue,
    timing: stillAnimation,
    spring: stillAnimation,
    loop: stillAnimation,
    sequence: stillAnimation,
    parallel: stillAnimation,
    delay: stillAnimation,
  },
  LayoutAnimation: {
    configureNext: () => undefined,
    Presets: { easeInEaseOut: {} },
  },
  Easing: {
    bezier: () => (t: number) => t,
    ease: (t: number) => t,
    in: <A>(easing: A) => easing,
    out: <A>(easing: A) => easing,
    inOut: <A>(easing: A) => easing,
    linear: (t: number) => t,
    quad: (t: number) => t,
    cubic: (t: number) => t,
  },
  Keyboard: {
    addListener: () => ({ remove: () => undefined }),
    dismiss: () => undefined,
    isVisible: () => false,
    metrics: () => undefined,
  },
  Share: {
    share: () => resolve(() => ({ action: "sharedAction" })),
    sharedAction: "sharedAction",
    dismissedAction: "dismissedAction",
  },
  Alert: { alert: () => undefined },
  useColorScheme: () => "light",
  useWindowDimensions: () => useContext(TestWindowDimensions),
}));

// Insets come from the context, as in the library, so a test can provide some.
const SafeAreaInsetsContext = createContext({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

mock.module("react-native-safe-area-context", () => ({
  SafeAreaInsetsContext,
  SafeAreaView: "SafeAreaView",
  useSafeAreaInsets: () => useContext(SafeAreaInsetsContext),
}));

// SVG elements stand in as their names, so a test can find the icon a
// component draws (Lucide draws through react-native-svg).
const svgElement = (name: string) => name;
mock.module("react-native-svg", () => ({
  default: svgElement("Svg"),
  Svg: svgElement("Svg"),
  Circle: svgElement("Circle"),
  ClipPath: svgElement("ClipPath"),
  Defs: svgElement("Defs"),
  Ellipse: svgElement("Ellipse"),
  G: svgElement("G"),
  Line: svgElement("Line"),
  LinearGradient: svgElement("LinearGradient"),
  Path: svgElement("Path"),
  Polygon: svgElement("Polygon"),
  Polyline: svgElement("Polyline"),
  RadialGradient: svgElement("RadialGradient"),
  Rect: svgElement("Rect"),
  Stop: svgElement("Stop"),
}));

mock.module("expo-router/react-navigation", () => ({
  getHeaderTitle: (
    options: { readonly title?: string; readonly headerTitle?: unknown },
    fallback: string,
  ) =>
    Schema.is(Schema.String)(options.headerTitle)
      ? options.headerTitle
      : (options.title ?? fallback),
  useHeaderHeight: () => 0,
}));

mock.module("expo-status-bar", () => ({
  StatusBar: InertStatusBar,
  setStatusBarStyle: () => undefined,
}));

mock.module("expo-constants", () => ({
  default: { expoConfig: { scheme: "kvitbit" } },
}));

const leadingSlash = /^\//;
mock.module("expo-linking", () => ({
  createURL: (path: string, options?: { readonly scheme?: string }) =>
    `${options?.scheme ?? "kvitbit"}://${EffectString.replace(leadingSlash, "")(path)}`,
}));

mock.module("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  randomUUID: SecureRandom.uuidV4Unsafe,
  getRandomBytes: SecureRandom.randomBytesUnsafe,
  digestStringAsync: (_algorithm: string, value: string) =>
    resolve(() => Bun.CryptoHasher.hash("sha256", value, "hex")),
  digest: (_algorithm: string, data: Uint8Array) =>
    resolve(() => {
      const digest = Bun.CryptoHasher.hash("sha256", data);
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    }),
}));

// The native auth client keeps its session here; a screen that links the
// auth client must load in a test file of its own, not only after another
// file mocked the client.
const secureItems = new Map<string, string>();
mock.module("expo-secure-store", () => ({
  getItem: (key: string) => secureItems.get(key) ?? null,
  setItem: (key: string, value: string) => {
    secureItems.set(key, value);
  },
  getItemAsync: (key: string) => resolve(() => secureItems.get(key) ?? null),
  setItemAsync: (key: string, value: string) =>
    resolve(() => {
      secureItems.set(key, value);
    }),
  deleteItemAsync: (key: string) =>
    resolve(() => {
      secureItems.delete(key);
    }),
}));

// Better Auth's Expo online manager loads this when a session atom mounts.
mock.module("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
}));

// The app's consent answer loads from here and reads the device language.
// Tests provide their own consent; these keep its module graph loadable.
mock.module("expo-localization", () => ({
  getLocales: () => [{ languageTag: "en-US" }],
  // The device doesn't say its clock: times follow the locale.
  getCalendars: () => [{ uses24hourClock: null }],
}));

const asyncStorageItems = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => resolve(() => asyncStorageItems.get(key) ?? null),
    setItem: (key: string, value: string) =>
      resolve(() => {
        asyncStorageItems.set(key, value);
      }),
    removeItem: (key: string) =>
      resolve(() => {
        asyncStorageItems.delete(key);
      }),
    multiRemove: (keys: readonly string[]) =>
      resolve(() => {
        for (const key of keys) asyncStorageItems.delete(key);
      }),
  },
}));

// Analytics clients are built on this stand-in in every test file.
