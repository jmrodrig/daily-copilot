// Colours and fonts map to the brand CSS variables (public/styles/brand.css), which switch
// between light and dark with the OS colour scheme.
// color-mix keeps Tailwind's opacity modifiers (e.g. bg-accent/15) working on CSS variables.
const brand = (name) => `color-mix(in srgb, var(--dc-${name}) calc(<alpha-value> * 100%), transparent)`;

/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        background: brand("bg"),
        surface: {
          raised: brand("surface"),
          panel: brand("bg"),
          active: brand("line"),
          hover: "color-mix(in srgb, var(--dc-line) calc(<alpha-value> * 50%), transparent)",
        },
        border: {
          default: brand("line"),
          light: brand("line"),
          strong: brand("muted"),
        },
        text: {
          primary: brand("fg"),
          secondary: brand("muted"),
          muted: brand("stone-500"),
          onAccent: brand("ink"),
        },
        accent: {
          DEFAULT: brand("accent"),
          primary: brand("accent"),
          soft: brand("accent-text"),
        },
        project: {
          c7801: "#6CB6EA",
          r5301: "#B7A3F2",
          p5002: "#56C8A8",
          neutral: "#6B7A84",
        },
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "sans-serif"],
        mono: ["var(--dc-font-mono)"],
        display: ["var(--dc-font-display)"],
      },
      // Two pixels above Tailwind's defaults (12px / 14px) for readability.
      fontSize: {
        xs: ["0.875rem", { lineHeight: "1rem" }],
        sm: ["1rem", { lineHeight: "1.25rem" }],
      },
      keyframes: {
        // Animates a pane from nothing to its own width; omitting `to` lets it end at the inline style.
        "pane-in": { from: { width: "0px", minWidth: "0px", opacity: "0" } },
        // Toasts rise into place; `translate` keeps their -translate-x-1/2 centring intact.
        "toast-in": { from: { opacity: "0", translate: "0 8px" } },
        "dialog-in": { from: { opacity: "0", transform: "scale(0.98) translateY(-4px)" } },
        // A listen widget's activity bars, bobbing while it records.
        "voice-bar": { "0%, 100%": { transform: "scaleY(0.3)" }, "50%": { transform: "scaleY(1)" } },
      },
      animation: {
        "pane-in": "pane-in 200ms ease-out",
        "toast-in": "toast-in 180ms ease-out",
        "dialog-in": "dialog-in 160ms ease-out",
        "voice-bar": "voice-bar 900ms ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
