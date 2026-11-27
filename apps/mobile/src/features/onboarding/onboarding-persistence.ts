import type { CurrencyCode, TaxRegime, WorkspaceId, WorkspaceSlug } from "@kvitbit/domain/contract";
import type { Locale } from "@kvitbit/ui-port/i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type OnboardingStep = 1 | 2 | 3;

export interface OnboardingScope {
  readonly origin: string;
  readonly userId: string;
}

export interface OnboardingWorkspaceRef {
  readonly id: WorkspaceId;
  readonly slug: WorkspaceSlug;
  readonly revision: number;
}

export interface OnboardingProgress {
  readonly workspace: OnboardingWorkspaceRef;
  readonly issuerSaved: boolean;
}

export interface OnboardingFormFields {
  readonly ico: string;
  readonly name: string;
  readonly slug: string;
  readonly dic: string;
  readonly street: string;
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
  readonly registerEntry: string;
  readonly taxRegime: TaxRegime;
  readonly currency: CurrencyCode;
  readonly docLocale: Locale;
  readonly iban: string;
  readonly bic: string;
}

export interface PersistedOnboarding {
  readonly version: 1;
  readonly origin: string;
  readonly userId: string;
  readonly step: OnboardingStep;
  readonly progress: OnboardingProgress | null;
  readonly fields: OnboardingFormFields;
}

export interface OnboardingStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface OnboardingStore {
  read(origin: string, userId: string): Promise<PersistedOnboarding | null>;
  write(state: PersistedOnboarding): Promise<void>;
  clear(origin: string, userId: string): Promise<void>;
}

export const onboardingOwner = (origin: string, userId: string): string =>
  JSON.stringify([origin, userId]);

export const onboardingStorageKey = (origin: string, userId: string): string =>
  `kvitbit.onboarding-resume.v1.${onboardingOwner(origin, userId)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isStep = (value: unknown): value is OnboardingStep =>
  value === 1 || value === 2 || value === 3;

const isTaxRegime = (value: unknown): value is TaxRegime =>
  value === "non_vat_payer" || value === "vat_payer" || value === "identified_person";

const isLocale = (value: unknown): value is Locale => value === "cs" || value === "en";

const parseWorkspaceRef = (value: unknown): OnboardingWorkspaceRef | null => {
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    value.id.length === 0 ||
    !isString(value.slug) ||
    value.slug.length === 0 ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 0
  ) {
    return null;
  }
  return {
    id: value.id as WorkspaceId,
    slug: value.slug as WorkspaceSlug,
    revision: value.revision,
  };
};

const parseProgress = (value: unknown): OnboardingProgress | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.issuerSaved !== "boolean") return undefined;
  const workspace = parseWorkspaceRef(value.workspace);
  if (workspace === null) return undefined;
  return { workspace, issuerSaved: value.issuerSaved };
};

const parseFields = (value: unknown): OnboardingFormFields | null => {
  if (!isRecord(value)) return null;
  if (
    !isString(value.ico) ||
    !isString(value.name) ||
    !isString(value.slug) ||
    !isString(value.dic) ||
    !isString(value.street) ||
    !isString(value.city) ||
    !isString(value.postalCode) ||
    !isString(value.country) ||
    !isString(value.registerEntry) ||
    !isTaxRegime(value.taxRegime) ||
    !isString(value.currency) ||
    value.currency.length === 0 ||
    !isLocale(value.docLocale) ||
    !isString(value.iban) ||
    !isString(value.bic)
  ) {
    return null;
  }
  return {
    ico: value.ico,
    name: value.name,
    slug: value.slug,
    dic: value.dic,
    street: value.street,
    city: value.city,
    postalCode: value.postalCode,
    country: value.country,
    registerEntry: value.registerEntry,
    taxRegime: value.taxRegime,
    currency: value.currency as CurrencyCode,
    docLocale: value.docLocale,
    iban: value.iban,
    bic: value.bic,
  };
};

const parsePersistedOnboarding = (
  raw: string,
  expectedOrigin: string,
  expectedUserId: string,
): PersistedOnboarding | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (parsed.origin !== expectedOrigin || parsed.userId !== expectedUserId) return null;
  if (!isStep(parsed.step)) return null;
  const progress = parseProgress(parsed.progress);
  if (progress === undefined) return null;
  const fields = parseFields(parsed.fields);
  if (fields === null) return null;
  return {
    version: 1,
    origin: parsed.origin,
    userId: parsed.userId,
    step: parsed.step,
    progress,
    fields,
  };
};

export const makeOnboardingStore = (storage: OnboardingStorage): OnboardingStore => ({
  read: async (origin, userId) => {
    try {
      const raw = await storage.getItem(onboardingStorageKey(origin, userId));
      return raw === null ? null : parsePersistedOnboarding(raw, origin, userId);
    } catch {
      return null;
    }
  },
  write: async (state) => {
    await storage.setItem(onboardingStorageKey(state.origin, state.userId), JSON.stringify(state));
  },
  clear: async (origin, userId) => {
    await storage.removeItem(onboardingStorageKey(origin, userId));
  },
});

export const onboardingStore = makeOnboardingStore(AsyncStorage);
