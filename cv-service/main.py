import logging
import os

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from pipeline import analyze_board, track_board

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

API_SECRET = os.getenv("API_SECRET", "")

app = FastAPI(title="Codenames CV Service")


def verify_secret(x_api_secret: str = Header(default="")):
    if API_SECRET and x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


class AnalyzeRequest(BaseModel):
    image_base64: str
    media_type: str = "image/jpeg"
    mode: str = "full"
    known_words: list[str | None] | None = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze", dependencies=[Depends(verify_secret)])
def analyze(req: AnalyzeRequest):
    try:
        if req.mode == "track" and req.known_words:
            return track_board(req.image_base64, req.known_words)
        return analyze_board(req.image_base64)
    except Exception as e:
        logger.exception("CV pipeline error")
        raise HTTPException(status_code=500, detail=str(e))
