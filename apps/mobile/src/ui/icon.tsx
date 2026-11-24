import type { M3ColorRole } from "@kvitbit/api-contract";
import type { LucideIcon } from "lucide-react-native";
import { useTheme } from "../theme/theme-provider";

export type IconComponent = LucideIcon;

export function Icon(props: {
  readonly icon: IconComponent;
  readonly size?: number;
  readonly color?: M3ColorRole;
}) {
  const theme = useTheme();
  const Glyph = props.icon;
  return <Glyph size={props.size ?? 24} color={theme.colors[props.color ?? "onSurfaceVariant"]} />;
}
