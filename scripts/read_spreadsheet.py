"""Read a spreadsheet from the repository root: `python scripts/read_spreadsheet.py budget.xlsx [--sheet NAME]
[--search TEXT] [--json]`.

A thin wrapper around `backend/read_spreadsheet.py`; see there for the options and the library functions.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from read_spreadsheet import main  # noqa: E402

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
