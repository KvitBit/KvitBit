import {
  DEFAULT_THEME_PRESET,
  type Hex,
  type ThemeContrast,
  type ThemeMode,
  type ThemePresetId,
  type ThemeSource,
  type ThemeStyle,
} from "@kvitbit/api-contract";
import type { BrandingImage, Locale, PdfTemplate } from "@kvitbit/domain/contract";
import { ifMatchHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import {
  contrastNameText,
  modeNameText,
  PRESET_IDS,
  PresetDefinitions,
  presetNameText,
  styleNameText,
} from "@kvitbit/ui-port/theme";
import { Check, Trash2, Upload } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { useAppTheme, useTheme } from "../../theme/theme-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  RemoteView,
  Section,
  SegmentedChoice,
  SwitchRow,
  space,
  Text,
  TextField,
  touchTarget,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canEditWorkspaceSettings } from "./permissions";
import { pickBrandingImage, uploadBrandingImage } from "./platform-helpers";
import {
  type FormErrorState,
  fieldErrorText,
  formErrorFrom,
  noFormError,
} from "./settings-feedback";

const PDF_TEMPLATES: ReadonlyArray<PdfTemplate> = ["classic", "modern_minimal"];
const THEME_MODES: ReadonlyArray<ThemeMode> = ["system", "light", "dark"];
const THEME_STYLES: ReadonlyArray<ThemeStyle> = ["elegant", "cozy"];
const THEME_CONTRASTS: ReadonlyArray<ThemeContrast> = ["standard", "medium", "high"];
const LOCALES: ReadonlyArray<Locale> = ["cs", "en"];

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

const activePresetId = (source: ThemeSource | null): ThemePresetId | null => {
  if (source === null) return DEFAULT_THEME_PRESET;
  return source._tag === "Preset" ? source.id : null;
};

/**
 * Settings -> Branding & Appearance (flow 10.4 + DESIGN.md theme controls):
 * - Workspace branding: logo/stamp upload & removal, PDF template, accent color, footer text,
 *   6 Material 3 presets (graphite_atelier default) or custom hex seed.
 * - Personal app appearance: Elegant/Cozy style, light/dark/system mode, standard/medium/high
 *   contrast, Android Monet dynamic color toggle (useAppTheme), cs/en language toggle (useI18n).
 */
export function BrandingSection() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const i18n = useI18n();
  const { t, text, locale, setLocale, local } = i18n;
  const appTheme = useAppTheme();
  const theme = useTheme();
  const overlay = useOverlay();

  const editable = canEditWorkspaceSettings(workspace.role, workspace.closed);
  const remote = useRemote(
    (client) => client.branding.getBranding({ params: inWorkspace(workspace.id) }),
    [workspace.id],
  );
  const prefsRemote = useRemote((client) => client.me.getPreferences({}), []);

  const [pdfTemplate, setPdfTemplate] = useState<PdfTemplate>("classic");
  const [accentColor, setAccentColor] = useState("#1F5FAF");
  const [footerText, setFooterText] = useState("");
  const [themeSource, setThemeSource] = useState<ThemeSource | null>(null);
  const [customSeed, setCustomSeed] = useState("");
  const [revision, setRevision] = useState<number>(1);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState<BrandingImage | null>(null);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  useEffect(() => {
    if (remote.state._tag !== "Ready") return;
    const b = remote.state.value;
    setPdfTemplate(b.pdfTemplate);
    setAccentColor(b.accentColor);
    setFooterText(b.footerText ?? "");
    setThemeSource(b.theme);
    setCustomSeed(b.theme?._tag === "Seed" ? b.theme.seed : "");
    setRevision(b.revision);
    setErrorState(noFormError);
  }, [remote.state]);

  const syncAccountPreferences = async (patch: {
    readonly locale?: Locale;
    readonly mode?: ThemeMode;
    readonly style?: ThemeStyle;
    readonly contrast?: ThemeContrast;
    readonly dynamicColor?: boolean;
  }) => {
    const nextPref = {
      ...appTheme.preference,
      ...(patch.mode === undefined ? {} : { mode: patch.mode }),
      ...(patch.style === undefined ? {} : { style: patch.style }),
      ...(patch.contrast === undefined ? {} : { contrast: patch.contrast }),
      ...(patch.dynamicColor === undefined ? {} : { dynamicColor: patch.dynamicColor }),
    };
    if (
      patch.mode !== undefined ||
      patch.style !== undefined ||
      patch.contrast !== undefined ||
      patch.dynamicColor !== undefined
    ) {
      appTheme.setPreference(nextPref);
    }
    if (patch.locale !== undefined) {
      setLocale(patch.locale);
    }
    if (prefsRemote.state._tag !== "Ready") return;
    const current = prefsRemote.state.value;
    const result = await api.run((client) =>
      client.me.updatePreferences({
        headers: ifMatchHeaders(current.revision),
        payload: {
          ...(patch.locale === undefined ? {} : { locale: patch.locale }),
          theme: {
            ...current.theme,
            mode: nextPref.mode,
            style: nextPref.style,
            contrast: nextPref.contrast,
            dynamicColor: nextPref.dynamicColor,
          },
        },
      }),
    );
    if (result._tag === "Ok") {
      prefsRemote.set(result.value);
    }
  };

  const handleSaveBranding = async () => {
    if (!editable) return;
    setSaving(true);
    setErrorState(noFormError);
    const trimmedAccent = accentColor.trim();
    const result = await api.run((client) =>
      client.branding.updateBranding({
        params: inWorkspace(workspace.id),
        headers: ifMatchHeaders(revision),
        payload: {
          pdfTemplate,
          ...(HEX_RE.test(trimmedAccent) ? { accentColor: trimmedAccent as Hex } : {}),
          footerText: footerText.trim() || null,
          theme: themeSource,
        },
      }),
    );
    setSaving(false);
    if (result._tag === "Ok") {
      remote.set(result.value);
      setRevision(result.value.revision);
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleUploadImage = async (kind: BrandingImage) => {
    if (!editable) return;
    const picked = await pickBrandingImage();
    if (picked._tag === "Cancelled") return;
    if (picked._tag === "Invalid") {
      overlay.toast(
        picked.reason === "size"
          ? local({
              cs: "Obrázek je příliš velký (max. 2 MB).",
              en: "Image is too large (max 2 MB).",
            })
          : picked.reason === "type"
            ? t("settings.branding.uploadHint")
            : local({ cs: "Výběr obrázku není dostupný.", en: "Image picker is unavailable." }),
      );
      return;
    }
    setUploadingImage(kind);
    setErrorState(noFormError);
    const result = await uploadBrandingImage({
      origin: api.origin,
      credentials: api.credentials,
      workspaceId: workspace.id,
      image: kind,
      file: picked.file,
    });
    setUploadingImage(null);
    if (result._tag === "Ok") {
      remote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleRemoveImage = async (kind: BrandingImage) => {
    if (!editable) return;
    setUploadingImage(kind);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.branding.removeImage({ params: inWorkspace(workspace.id, { image: kind }) }),
    );
    setUploadingImage(null);
    if (result._tag === "Ok") {
      remote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const selectedPreset = activePresetId(themeSource);

  return (
    <View style={styles.stack}>
      <Section title={t("account.appearance.title")}>
        <Card>
          <SegmentedChoice<ThemeStyle>
            label={t("account.appearance.style")}
            value={appTheme.preference.style}
            choices={THEME_STYLES.map((s) => ({
              value: s,
              label: text(styleNameText(s)),
            }))}
            onChange={(style) => void syncAccountPreferences({ style })}
          />
          <Text variant="meta" color="onSurfaceVariant">
            {t(`enum.themeStyleHint.${appTheme.preference.style}`)}
          </Text>

          <SegmentedChoice<ThemeMode>
            label={t("account.appearance.mode")}
            value={appTheme.preference.mode}
            choices={THEME_MODES.map((m) => ({
              value: m,
              label: text(modeNameText(m)),
            }))}
            onChange={(mode) => void syncAccountPreferences({ mode })}
          />

          <SegmentedChoice<ThemeContrast>
            label={t("account.appearance.contrast")}
            value={appTheme.preference.contrast}
            choices={THEME_CONTRASTS.map((c) => ({
              value: c,
              label: text(contrastNameText(c)),
            }))}
            onChange={(contrast) => void syncAccountPreferences({ contrast })}
          />

          <SwitchRow
            label={t("account.appearance.dynamicColor")}
            description={
              appTheme.dynamicAvailable
                ? t("account.appearance.dynamicColorHint")
                : `${t("account.appearance.dynamicColorHint")} (${local({ cs: "na tomto zařízení nedostupné", en: "not available on this device" })})`
            }
            value={appTheme.preference.dynamicColor}
            disabled={!appTheme.dynamicAvailable}
            onChange={(dynamicColor) => void syncAccountPreferences({ dynamicColor })}
          />

          <SegmentedChoice<Locale>
            label={t("account.profile.language")}
            value={locale}
            choices={LOCALES.map((l) => ({
              value: l,
              label: t(`enum.locale.${l}`),
            }))}
            onChange={(nextLocale) => void syncAccountPreferences({ locale: nextLocale })}
          />
        </Card>

        <Card>
          <Text variant="labelMedium" color="onSurfaceVariant">
            {t("account.appearance.preview")}
          </Text>
          <View style={styles.previewRow}>
            <Text variant="titleSmall" style={styles.flex}>
              {t("account.appearance.sampleCard")}
            </Text>
            <Badge label={t("enum.badge.paid")} tone="success" />
            <Badge label={t("enum.badge.proforma")} tone="proforma" />
            <Badge label={t("enum.badge.overdue")} tone="warning" />
          </View>
        </Card>
      </Section>

      <RemoteView state={remote.state} onRetry={remote.reload}>
        {(branding) => (
          <View style={styles.stack}>
            {editable ? null : <Banner text={t("settings.readOnly")} tone="info" />}
            {errorState.banner === null ? null : (
              <Banner
                text={errorState.banner}
                tone="error"
                {...(errorState.staleRevision
                  ? { action: { label: t("common.action.reload"), onPress: remote.reload } }
                  : {})}
              />
            )}

            <Section title={t("settings.branding.workspaceTheme")}>
              <Card>
                <Text variant="meta" color="onSurfaceVariant">
                  {t("settings.branding.workspaceThemeHint")}
                </Text>
                <View accessibilityRole="radiogroup" style={styles.presetGrid}>
                  {PRESET_IDS.map((presetId) => {
                    const def = PresetDefinitions[presetId];
                    const selected = selectedPreset === presetId;
                    return (
                      <Pressable
                        key={presetId}
                        testID={`theme-preset-${presetId}`}
                        accessibilityRole="radio"
                        accessibilityState={{ selected, disabled: !editable }}
                        disabled={!editable}
                        onPress={() => {
                          setThemeSource(
                            presetId === DEFAULT_THEME_PRESET
                              ? null
                              : { _tag: "Preset", id: presetId },
                          );
                          setCustomSeed("");
                        }}
                        style={[
                          styles.presetChip,
                          {
                            borderRadius: theme.shape.control,
                            borderColor: selected
                              ? theme.colors.primary
                              : theme.colors.outlineVariant,
                            borderWidth: selected ? 2 : 1,
                            backgroundColor: selected
                              ? theme.colors.secondaryContainer
                              : theme.colors.surface,
                            opacity: editable ? 1 : 0.6,
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.swatch,
                            {
                              backgroundColor: def.swatch,
                              borderColor: theme.colors.outlineVariant,
                            },
                          ]}
                        >
                          {selected ? <Check size={14} color={theme.colors.onPrimary} /> : null}
                        </View>
                        <Text
                          variant="labelMedium"
                          color={selected ? "onSecondaryContainer" : "onSurface"}
                          numberOfLines={1}
                        >
                          {text(presetNameText(presetId))}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <TextField
                  label={t("account.appearance.seed")}
                  supporting={t("account.appearance.seedHint")}
                  value={customSeed}
                  placeholder="#1D4ED8"
                  disabled={!editable}
                  autoCapitalize="characters"
                  onChangeText={(value) => {
                    setCustomSeed(value);
                    const trimmed = value.trim();
                    if (HEX_RE.test(trimmed)) {
                      setThemeSource({ _tag: "Seed", seed: trimmed as Hex });
                    }
                  }}
                />
              </Card>
            </Section>

            <Section title={t("settings.branding.title")}>
              <Card>
                <View style={styles.imageRow}>
                  <View style={styles.flex}>
                    <Text variant="row">{t("settings.branding.logo")}</Text>
                    <Text variant="meta" color="onSurfaceVariant">
                      {branding.logo === null
                        ? t("settings.branding.uploadHint")
                        : branding.logo.contentType}
                    </Text>
                  </View>
                  {editable ? (
                    <View style={styles.row}>
                      <Button
                        testID="branding-logo-upload"
                        kind="tonal"
                        icon={Upload}
                        label={t("common.action.upload")}
                        busy={uploadingImage === "logo"}
                        onPress={() => void handleUploadImage("logo")}
                      />
                      {branding.logo === null ? null : (
                        <Button
                          kind="text"
                          icon={Trash2}
                          label={t("common.action.remove")}
                          busy={uploadingImage === "logo"}
                          onPress={() => void handleRemoveImage("logo")}
                        />
                      )}
                    </View>
                  ) : null}
                </View>

                <View style={styles.imageRow}>
                  <View style={styles.flex}>
                    <Text variant="row">{t("settings.branding.stamp")}</Text>
                    <Text variant="meta" color="onSurfaceVariant">
                      {branding.stamp === null
                        ? t("settings.branding.uploadHint")
                        : branding.stamp.contentType}
                    </Text>
                  </View>
                  {editable ? (
                    <View style={styles.row}>
                      <Button
                        testID="branding-stamp-upload"
                        kind="tonal"
                        icon={Upload}
                        label={t("common.action.upload")}
                        busy={uploadingImage === "stamp"}
                        onPress={() => void handleUploadImage("stamp")}
                      />
                      {branding.stamp === null ? null : (
                        <Button
                          kind="text"
                          icon={Trash2}
                          label={t("common.action.remove")}
                          busy={uploadingImage === "stamp"}
                          onPress={() => void handleRemoveImage("stamp")}
                        />
                      )}
                    </View>
                  ) : null}
                </View>

                <SegmentedChoice<PdfTemplate>
                  label={t("settings.branding.defaultTemplate")}
                  value={pdfTemplate}
                  choices={PDF_TEMPLATES.map((tpl) => ({
                    value: tpl,
                    label: t(`enum.pdfTemplate.${tpl}`),
                  }))}
                  onChange={(tpl) => {
                    if (editable) setPdfTemplate(tpl);
                  }}
                />

                <TextField
                  label={t("settings.branding.accent")}
                  value={accentColor}
                  disabled={!editable}
                  autoCapitalize="characters"
                  error={
                    accentColor.trim() !== "" && !HEX_RE.test(accentColor.trim())
                      ? local({
                          cs: "Zadejte hex barvu (#RRGGBB).",
                          en: "Enter a hex color (#RRGGBB).",
                        })
                      : fieldErrorText(errorState, ["accentColor"], i18n)
                  }
                  onChangeText={setAccentColor}
                />

                <TextField
                  label={t("settings.branding.footer")}
                  value={footerText}
                  disabled={!editable}
                  multiline
                  maxLength={500}
                  error={fieldErrorText(errorState, ["footerText"], i18n)}
                  onChangeText={setFooterText}
                />
              </Card>
            </Section>

            {editable ? (
              <Button
                testID="branding-save"
                kind="filled"
                label={t("common.action.saveChanges")}
                busy={saving}
                disabled={accentColor.trim() !== "" && !HEX_RE.test(accentColor.trim())}
                onPress={() => void handleSaveBranding()}
              />
            ) : null}
          </View>
        )}
      </RemoteView>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  flex: { flex: 1 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  previewRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, alignItems: "center" },
  presetGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  presetChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: touchTarget,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  swatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  imageRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.xs,
  },
});
