import * as EffectArray from "effect/Array";
import { Pressable, Switch as RNSwitch, StyleSheet, View } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { Text } from "./text";
import { space, touchTarget } from "./tokens";

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** M3 segmented button / filter chips: one selected value. */
export function SegmentedChoice<T extends string>(props: {
  readonly label?: string;
  readonly value: T | null;
  readonly choices: ReadonlyArray<Choice<T>>;
  readonly onChange: (value: T) => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <View style={styles.wrap}>
      {props.label === undefined ? null : (
        <Text variant="labelMedium" color="onSurfaceVariant">
          {props.label}
        </Text>
      )}
      <View accessibilityRole="radiogroup" style={styles.chips}>
        {EffectArray.map(props.choices, (choice) => {
          const selected = choice.value === props.value;
          return (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => props.onChange(choice.value)}
              style={[
                styles.chip,
                {
                  borderRadius: theme.shape.control,
                  borderColor: selected ? c.secondaryContainer : c.outline,
                  backgroundColor: selected ? c.secondaryContainer : undefined,
                },
              ]}
            >
              <Text
                variant="labelLarge"
                color={selected ? "onSecondaryContainer" : "onSurfaceVariant"}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SwitchRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.switchRow}>
      <View style={styles.flex}>
        <Text variant="row">{props.label}</Text>
        {props.description === undefined ? null : (
          <Text variant="meta" color="onSurfaceVariant">
            {props.description}
          </Text>
        )}
      </View>
      <RNSwitch
        accessibilityLabel={props.label}
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onChange}
        trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceContainerHighest }}
        thumbColor={props.value ? theme.colors.onPrimary : theme.colors.outline}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { gap: space.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { minHeight: 40, paddingHorizontal: space.lg, justifyContent: "center", borderWidth: 1 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: touchTarget + 8,
  },
});
