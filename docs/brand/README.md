# Daily Copilot brand package

Mark: **Ashlar** (a cut stone cube: solid top, outlined left face, hatched right face). Rough stone shaped by thought before it is laid.

## Contents

```
logo/
  mark-ink.svg / mark-stone.svg          one colour, for light / dark grounds
  mark-color-light.svg / -dark.svg       ink or stone + brass top face
  mark-adaptive.svg                      switches itself via prefers-color-scheme (use in <img>)
  mark-currentcolor.svg                  inline use; strokes follow CSS `color`
  lockup-*.svg                           mark + DAILY COPILOT, text outlined (no font needed)
  mark-color-*-1024.png                  raster exports for docs and slides
favicon/
  favicon.svg  favicon.ico  favicon-16.png  favicon-32.png
  apple-touch-icon.png  icon-192.png  icon-512.png  icon-maskable-512.png
  site.webmanifest
styles/
  brand.css                              CSS variables, light + dark
  tokens.json                            same values for tooling
```

## Add to your app

Copy `favicon/*` to your public root, then in `<head>`:

```html
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#101820">
<link rel="stylesheet" href="/styles/brand.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&family=IBM+Plex+Mono:wght@400;500&display=swap">
```

(`site.webmanifest` icon paths assume the files sit at the site root; edit them if not.)

In-app logo, theme-aware, no extra CSS:

```html
<img src="/logo/mark-adaptive.svg" width="32" height="32" alt="Daily Copilot">
```

Tailwind (v3) colours:

```js
colors: {
  ink: "#101820", stone: { 50: "#F3F5F6", 100: "#E8EBED", 200: "#DCE0E2", 300: "#C4CBD0", 400: "#9AA5AD", 500: "#6F7B84", 600: "#4B5762", 700: "#2E3840", 800: "#18232D", 900: "#101820" },
  brass: { DEFAULT: "#B07A1A", text: "#8A5A0C", dark: "#E0A94A" },
}
```

## Colour

| Token | Hex | Use |
|---|---|---|
| ink | `#101820` | primary text on light, dark ground |
| stone | `#DCE0E2` | primary mark on dark, light ground |
| brass-light | `#B07A1A` | accent fills and the mark's top face on light |
| brass-text | `#8A5A0C` | accent-coloured text on light |
| brass-dark | `#E0A94A` | accent on dark (text and fills) |

Contrast (foreground / background):

| Pair | Hex | Ratio |
|---|---|---|
| ink on stone-50 (light text) | `#101820` / `#F3F5F6` | 16.36:1 |
| muted on stone-50 | `#4B5762` / `#F3F5F6` | 6.76:1 |
| brass-text on stone-50 | `#8A5A0C` / `#F3F5F6` | 5.41:1 |
| brass-light on stone-50 (graphics only) | `#B07A1A` / `#F3F5F6` | 3.4:1 |
| stone-50 on ink (dark text) | `#F3F5F6` / `#101820` | 16.36:1 |
| muted-dark on ink | `#AAB4BC` / `#101820` | 8.49:1 |
| brass-dark on ink | `#E0A94A` / `#101820` | 8.47:1 |

`brass-light` is for large shapes and the logo only. Use `brass-text` for words.

## Logo rules

- Default to the colour mark on a plain ink or stone ground. Use the one-colour marks where a single ink is required (print, stamps, embossing).
- Clear space around the mark: at least 1/4 of the mark's width on every side.
- Smallest sizes: mark 16 px, lockup 120 px wide. Below that, use the favicon artwork, which is simplified on purpose.
- Do not recolour the top face outside brass, rotate the cube, or add a drop shadow.

## Fonts

Wordmark: Cinzel Bold, caps, letter-spacing 0.16em (SIL OFL; the lockup SVGs have the text outlined, so the font is only needed for live text). UI/labels: IBM Plex Mono.
