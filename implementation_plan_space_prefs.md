# Implementation Plan: Space Preferences

## Overview
Create a new "Space Preferences" section in the UI to allow users to configure their current space/workspace environment. For the MVP, it will only support renaming the current space. It will also contain a placeholder section for future configuration (task types, statuses, etc.).

## Branching
- Implement this feature on a new isolated feature branch: `feat/space-preferences`

## 1. Backend Changes
### `backend/spaces.py`
- Add a new function `update_space(db: Session, space_id: int, name: str) -> Space | None`.
- This function should retrieve the space using `get_space`, update its `name`, commit the changes, and return the updated space.
- Ensure to call `set_source(db, SPACES_SOURCE)` before updating to maintain versioning/history.

### `backend/main.py`
- Add a new HTTP PUT endpoint: `@app.put("/api/spaces/{space_id}")`.
- The endpoint should accept `space_id: int` and `request: schemas.SpaceIn`.
- Call `spaces.update_space(db, space_id, request.name)`.
- If the space is not found, raise a `404 HTTPException`.
- Return the updated space using `schemas.Space.model_validate(space, from_attributes=True)`.

## 2. Frontend State Management
### `desktop/src/lib/space.tsx`
- Add `updateSpace: (id: number, name: string) => Promise<Space>` to the `SpaceState` type.
- Implement `updateSpace` using `useCallback` inside `SpaceProvider`.
  - Perform a `PUT` request to `/api/spaces/${id}` with `{ name }`.
  - Ensure error handling using `errorDetail`.
  - Update the local `spaces` state array with the returned updated space.
- Add `updateSpace` to the `value` object returned by the `SpaceProvider`.

## 3. Frontend UI
### `desktop/src/pages/SpacePreferences.tsx`
- Create this new component.
- Use `useSpace()` to get the current `space` and `updateSpace` function.
- Create a form with a text input bound to the space's `name` state.
- Include a "Save" button to trigger `updateSpace` and handle loading/error states.
- Include a placeholder section titled "Environment Configuration" with text explaining that task types and statuses are "Coming soon" (as requested by the user, do not develop these yet).

### `desktop/src/App.tsx`
- Add a new route for the preferences page inside the main layout block:
  `<Route path="space-preferences" element={<SpacePreferences />} />`

### `desktop/src/components/Sidebar.tsx`
- Add a navigation link to the new preferences page.
- Place it strategically, either right below the space dropdown selector or in the bottom navigation links cluster (e.g., `<NavLink to="/space-preferences">Space Preferences</NavLink>`).

## Manual User-Driven Testing Gate
After the implementer agent completes the code:
1. Verify the frontend and backend compile and run correctly.
2. Ask the user to click on "Space Preferences" in the sidebar.
3. Ask the user to change the workspace name and click "Save".
4. Ask the user to verify the space name instantly updates in the dropdown and persists upon a hard refresh.
