import {
  CurrencyCode,
  Locale,
  TaxRegime,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";

const OnboardingStep = Schema.Literals([1, 2, 3]);
export type OnboardingStep = typeof OnboardingStep.Type;

export interface OnboardingScope {
  readonly origin: string;
  readonly userId: string;
}

const OnboardingWorkspaceRef = Schema.Struct({
  id: WorkspaceId,
  slug: WorkspaceSlug,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OnboardingWorkspaceRef = typeof OnboardingWorkspaceRef.Type;

const OnboardingProgress = Schema.Struct({
  workspace: OnboardingWorkspaceRef,
  issuerSaved: Schema.Boolean,
});
export type OnboardingProgress = typeof OnboardingProgress.Type;

const OnboardingFormFields = Schema.Struct({
  ico: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  dic: Schema.String,
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
  registerEntry: Schema.String,
  taxRegime: TaxRegime,
  currency: CurrencyCode,
  docLocale: Locale,
  iban: Schema.String,
  bic: Schema.String,
});
export type OnboardingFormFields = typeof OnboardingFormFields.Type;

const PersistedOnboarding = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    origin: Schema.String,
    userId: Schema.String,
    step: OnboardingStep,
    progress: Schema.NullOr(OnboardingProgress),
    fields: OnboardingFormFields,
  }),
);
type PersistedOnboarding = typeof PersistedOnboarding.Type;

export interface OnboardingStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
}

export interface OnboardingStore {
  readonly read: (origin: string, userId: string) => Promise<PersistedOnboarding | null>;
  readonly write: (state: PersistedOnboarding) => Promise<void>;
  readonly clear: (origin: string, userId: string) => Promise<void>;
}

const OwnerTuple = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
const encodeOwner = Schema.encodeOption(OwnerTuple);
// Keep the v1 storage and request-intent key byte-for-byte compatible.
export const onboardingOwner = ({ origin, userId }: OnboardingScope): string =>
  Option.getOrThrow(encodeOwner([origin, userId]));

const onboardingStorageKey = (scope: OnboardingScope): string =>
  `kvitbit.onboarding-resume.v1.${onboardingOwner(scope)}`;

const decodeOnboarding = Schema.decodeEffect(PersistedOnboarding);
const encodeOnboarding = Schema.encodeEffect(PersistedOnboarding);

export const makeOnboardingStore = (storage: OnboardingStorage): OnboardingStore => ({
  read: (origin, userId) =>
    runMobileEffect(
      fromMobilePromise(() => storage.getItem(onboardingStorageKey({ origin, userId }))).pipe(
        Effect.flatMap((raw) => (raw === null ? Effect.succeed(null) : decodeOnboarding(raw))),
        Effect.map((state) => (state?.origin === origin && state.userId === userId ? state : null)),
        Effect.orElseSucceed(() => null),
      ),
    ),
  write: (state) =>
    runMobileEffect(
      encodeOnboarding(state).pipe(
        Effect.flatMap((raw) =>
          fromMobilePromise(() => storage.setItem(onboardingStorageKey(state), raw)),
        ),
      ),
    ),
  clear: (origin, userId) =>
    runMobileEffect(
      fromMobilePromise(() => storage.removeItem(onboardingStorageKey({ origin, userId }))),
    ),
});

export const onboardingStore = makeOnboardingStore(AsyncStorage);
