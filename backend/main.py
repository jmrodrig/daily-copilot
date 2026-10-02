"""FastAPI entry point. Run with `uvicorn main:app --reload` from backend/."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from database import init_db


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(title="Daily Co-Pilot Backend", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    from config import get_settings

    settings = get_settings()
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
