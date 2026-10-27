# Implementation Plan: Phase 16 — People Custom Field Type

## 1. Overview
Allow custom fields defined in spaces (`Space.custom_fields_schema`) to have a `person` type, drawing selections from the space's People directory. When assigned to a task (`Task.custom_fields`), a person custom field stores the person's name (string) and uses the accessible `AssigneeSelect` component with search, avatars, and "Me" pinning across the Task Panel, Task Table, Bulk Edit, and inline creation cards.

---

## 2. Technical Specifications & Architecture

### A. Backend Changes
1. **`backend/schemas.py`**:
   - Extend `CustomFieldType`:
     ```python
     class CustomFieldType(str, Enum):
         TEXT = "text"
         NUMBER = "number"
         DATE = "date"
         CHECKBOX = "checkbox"
         DROPDOWN = "dropdown"
         PERSON = "person"
     ```
   - In `CustomFieldDef`: Ensure `_options_for_dropdowns` retains empty options and colors for `PERSON` (since only `DROPDOWN` uses explicit option lists and colors).

2. **`backend/main.py`**:
   - In `_custom_value(field: schemas.CustomFieldDef, value: Any) -> Any`:
     Add validation for `kind.PERSON`:
     ```python
     if field.type is kind.PERSON and isinstance(value, str):
         val = value.strip()
         if not val:
             return None
         return val[:128]
     ```
   - In `_custom_field_matches(field: schemas.CustomFieldDef, value: Any, wanted: str) -> bool`:
     Support `kind.PERSON` filtering: case-insensitive match against `value` (e.g. `wanted.lower() in str(value).lower()`).
   - In `_migrate_custom_values(...)`:
     Type transitions to/from `person` are handled cleanly via `_custom_value`.

3. **Backend Tests**:
   - Add comprehensive tests in `backend/tests/test_custom_field_person.py` (or `test_task_mgmt.py`):
     - Creating a space with a `person` custom field.
     - Creating and updating tasks with valid person values.
     - Clearing a person custom field (null or empty string).
     - Filtering tasks by person custom field (`GET /api/tasks?cf=<field_id>:<name>`).
     - Rejecting non-string types for person fields.

### B. Desktop Frontend Changes
1. **`desktop/src/lib/space.tsx`**:
   - Update `CustomFieldType`:
     ```typescript
     export type CustomFieldType = "text" | "number" | "date" | "checkbox" | "dropdown" | "person";
     ```

2. **`desktop/src/pages/SpacePreferences.tsx`**:
   - Update `FIELD_TYPES`:
     ```typescript
     const FIELD_TYPES: Record<CustomFieldType, string> = {
       text: "Text",
       number: "Number",
       date: "Date",
       checkbox: "Checkbox",
       dropdown: "Dropdown",
       person: "Person",
     };
     ```
   - Ensure the new field form and field editor list "Person" in the type dropdown.

3. **`desktop/src/components/TaskPanel.tsx`**:
   - In `CustomField` component, pass `people: Person[]`.
   - When `field.type === "person"`, render `AssigneeSelect`:
     ```tsx
     case "person":
       return (
         <label className={`${label} col-span-2`}>
           {field.name}
           <AssigneeSelect
             ariaLabel={field.name}
             value={typeof value === "string" ? value : null}
             people={people}
             emptyLabel="—"
             onChange={(name) => onSave(name)}
             className={input}
           />
         </label>
       );
     ```

4. **`desktop/src/components/TaskTable.tsx` & `desktop/src/pages/TaskListView.tsx`**:
   - In `formatCustomValue`: return string value for `person` fields (e.g. person name).
   - In `CustomFieldInput`: accept `people?: Person[]`. When `field.type === "person"`, render `AssigneeSelect` with `people`.

5. **`desktop/src/pages/Tasks.tsx`**:
   - Pass `people` to inline `CustomFieldInput` for tasks with `show_inline: true`.

6. **`desktop/src/components/BulkEditDialog.tsx`**:
   - In `CustomFieldRow`: When `field.type === "person"`, render `AssigneeSelect` with `people` to support bulk assigning people to custom fields across multiple tasks.

7. **`desktop/src/components/AdvancedFilters.tsx`**:
   - Ensure filter input accepts person name matching.

---

## 3. Files to Create / Modify
- `backend/schemas.py`
- `backend/main.py`
- `backend/tests/test_custom_field_person.py`
- `desktop/src/lib/space.tsx`
- `desktop/src/pages/SpacePreferences.tsx`
- `desktop/src/components/TaskPanel.tsx`
- `desktop/src/components/TaskTable.tsx`
- `desktop/src/pages/Tasks.tsx`
- `desktop/src/pages/TaskListView.tsx`
- `desktop/src/components/BulkEditDialog.tsx`
- `desktop/src/components/AdvancedFilters.tsx`

---

## 4. Manual, User-Driven Testing Plan (Enforced)
After QA passes and dev servers are restarted:

1. **Configure Person Field**:
   - Open Daily Co-Pilot in your browser (`http://localhost:5173`).
   - Navigate to **Space Preferences** (`/preferences/space` via sidebar or settings icon).
   - In the **Custom Fields** section, enter a new field:
     - Name: `Reviewer`
     - Type: select **Person**
   - Click **Add**, then click **Save**.
   - Verify the `Reviewer` field appears in the list marked with tag `PERSON`.

2. **Assign Person in Task Panel**:
   - Navigate to **Tasks** (`/tasks`).
   - Click any existing task to open the Task Panel.
   - Scroll to the Custom Fields section: verify the **Reviewer** field appears with an assignee/person selector.
   - Click the selector: verify the People list appears (showing "Me" first and contacts from your space).
   - Select a contact (or type a name to filter).
   - Verify the person is saved and displays in the Task Panel.

3. **Verify Table & List Views**:
   - In the Task List view (`/tasks` or `/tasks/list`), toggle columns to show `Reviewer`.
   - Verify the selected person's name displays in the column.
   - Open the **Bulk Edit** dialog (select 2+ tasks): verify `Reviewer` is editable with the People selector.
