import { Pressable, Switch as RNSwitch, View } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { chipVariants } from "./styles";
import { Text } from "./text";

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
  return (
    <View className="gap-1">
      {props.label === undefined ? null : (
        <Text variant="labelMedium" color="onSurfaceVariant">
          {props.label}
        </Text>
      )}
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
        {props.choices.map((choice) => {
          const selected = choice.value === props.value;
          return (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => props.onChange(choice.value)}
              className={chipVariants({ selected })}
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
    <View className="min-h-14 flex-row items-center gap-3">
      <View className="flex-1">
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
