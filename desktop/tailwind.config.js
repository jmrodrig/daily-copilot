import { readFileSync } from "node:fs";

// Colours and fonts come from the shared design tokens so desktop and Android stay in sync.
const tokens = JSON.parse(readFileSync(new URL("../shared/design-tokens.json", import.meta.url), "utf8"));
const { colors, typography } = tokens;

const fontStack = (value) => value.split(",").map((f) => f.trim());

/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: colors.background,
        surface: colors.surface,
        border: colors.border,
        text: colors.text,
        accent: { ...colors.accent, DEFAULT: colors.accent.primary },
        project: colors.project,
      },
      fontFamily: {
        sans: fontStack(typography.fontFamily.ui),
        mono: fontStack(typography.fontFamily.mono),
      },
    },
  },
  plugins: [],
};
