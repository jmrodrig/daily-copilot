import sys
from pathlib import Path

# Make backend modules (main, config, database) importable as top-level modules,
# matching how uvicorn runs them from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
