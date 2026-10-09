# Implementation Plan: Update Status Color Picker

## Goal
Replace the native `<input type="color">` in the `StatusColorsEditor` component (inside `SpacePreferences.tsx`) with the custom `<ColorPicker>` component used by projects and custom fields.

## Branch
Use branch `feat/update-status-color-picker`

## 1. Frontend: Update `StatusColorsEditor`
**File:** `desktop/src/pages/SpacePreferences.tsx`
- Locate `StatusColorsEditor` component.
- Change the `<ul>` layout from `grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3` to `flex flex-col gap-3`.
- Update the `<li>` layout to `flex flex-wrap items-center gap-x-4 gap-y-2 text-[15px]`.
- Inside the `<li>`:
  - Show the status label `STATUS_LABELS[state]` in a `span` with a fixed width (e.g. `w-28 font-medium`).
  - Replace the `<input type="color" ... />` with `<ColorPicker />`.
  - Pass props to `ColorPicker`:
    - `label={STATUS_LABELS[state]}`
    - `value={colors[state]}`
    - `onChange={(next) => pick(state, next ?? DEFAULT_STATUS_COLORS[state])}`
    - `allowNone={false}` (since tasks must always have a colored dot, "none" implies reverting to default or isn't applicable).
  - Keep the existing `Reset` button rendering right next to the `ColorPicker`.
- Ensure everything compiles (`npm run typecheck`).
