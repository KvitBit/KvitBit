export type AccountTab = "profile" | "appearance" | "security" | "sessions" | "danger";

export const parseAccountTab = (raw: string | undefined): AccountTab =>
  raw === "profile" ||
  raw === "appearance" ||
  raw === "security" ||
  raw === "sessions" ||
  raw === "danger"
    ? raw
    : "profile";
