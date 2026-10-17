"""Read an Outlook .msg email file from the repository root: `python scripts/read_msg.py mail.msg [--json]`.

A thin wrapper around `backend/read_msg.py`; see there for the options and the library functions.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from read_msg import main  # noqa: E402

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
