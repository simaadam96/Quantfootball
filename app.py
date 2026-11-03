"""
app.py
FastAPI Webszerver, REST API végpontok és APScheduler Háttér-Időzítő
az Automatizált Kvantitatív Labdarúgó Fogadási Analitikai Rendszerhez.
"""

from __future__ import annotations
import os
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from apscheduler.schedulers.background import BackgroundScheduler

from engine.scheduler import AutomatedPipelineOrchestrator

load_dotenv()

orchestrator = AutomatedPipelineOrchestrator()
bg_scheduler = BackgroundScheduler()


def scheduled_morning_job() -> None:
    try:
        orchestrator.run_daily_pipeline()
    except Exception as exc:
        print(f"[Időzítő Hiba] Napi elemzés futtatása sikertelen: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = orchestrator.db.get_settings()
    hour = int(settings.get("auto_schedule_hour", 8))
    minute = int(settings.get("auto_schedule_minute", 0))

    orchestrator.run_daily_pipeline()

    bg_scheduler.add_job(
        scheduled_morning_job,
        trigger="cron",
        hour=hour,
        minute=minute,
        id="daily_quant_pipeline",
        replace_existing=True,
    )
    bg_scheduler.start()
    yield
    bg_scheduler.shutdown(wait=False)


app = FastAPI(
    title="Kvantitatív Labdarúgó Fogadási Analitika & Szelvénygenerátor",
    description="Bivariate Poisson + xG Modell, Working Formula Szelvényépítő és Automatikus Kiértékelő Rendszer",
    version="2.0.0",
    lifespan=lifespan,
)

os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


class PipelineRunRequest(BaseModel):
    scenario: Optional[str] = None
    match_window: Optional[str] = None


class SettingsUpdateRequest(BaseModel):
    initial_bankroll_huf: Optional[float] = None
    daily_stake_percent: Optional[float] = None
    fixed_daily_budget_huf: Optional[float] = None
    use_fixed_budget: Optional[bool] = None
    max_shared_matches: Optional[int] = None
    bookmaker_margin: Optional[float] = None
    match_window: Optional[str] = None
    demo_scenario: Optional[str] = None
    data_mode: Optional[str] = None
    the_odds_api_key: Optional[str] = None
    football_data_api_key: Optional[str] = None
    api_football_key: Optional[str] = None
    auto_schedule_hour: Optional[int] = None
    auto_schedule_minute: Optional[int] = None


class OddsOverrideRequest(BaseModel):
    match_id: str
    market_code: str
    odds_value: Optional[float] = None


class ResetHistoryRequest(BaseModel):
    initial_bankroll_huf: float = 5000.0
    daily_stake_percent: float = 10.0


@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    index_path = os.path.join("static", "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="A static/index.html nem található.")
    with open(index_path, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())


@app.get("/api/dashboard")
async def get_dashboard_data() -> Dict[str, Any]:
    return orchestrator.run_daily_pipeline()


@app.post("/api/run-pipeline")
async def trigger_pipeline(req: PipelineRunRequest) -> Dict[str, Any]:
    if req.match_window:
        orchestrator.db.set_setting("match_window", req.match_window)
    return orchestrator.run_daily_pipeline(force_scenario=req.scenario)


@app.post("/api/settings")
async def update_system_settings(req: SettingsUpdateRequest) -> Dict[str, Any]:
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    orchestrator.db.update_settings(updates)
    return orchestrator.run_daily_pipeline()


@app.post("/api/reset-history")
async def reset_history_endpoint(req: ResetHistoryRequest) -> Dict[str, Any]:
    orchestrator.db.reset_all_history(
        initial_bankroll_huf=req.initial_bankroll_huf,
        daily_stake_percent=req.daily_stake_percent,
    )
    return orchestrator.run_daily_pipeline()


@app.post("/api/override-odds")
async def override_market_odds(req: OddsOverrideRequest) -> Dict[str, Any]:
    orchestrator.db.set_manual_odds(
        match_id=req.match_id,
        market_code=req.market_code,
        odds_value=req.odds_value,
    )
    return orchestrator.run_daily_pipeline()


@app.post("/api/reset-odds")
async def reset_all_manual_odds() -> Dict[str, Any]:
    today_str, _ = orchestrator._get_dates()
    orchestrator.db.clear_manual_odds_for_date(today_str)
    return orchestrator.run_daily_pipeline()


@app.get("/api/export-excel")
async def download_excel_tracker():
    state = orchestrator.run_daily_pipeline()
    file_path = state.get("excel_file_path", "data/kvantitativ_fogadasi_naplo.xlsx")
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Az Excel munkafüzet még nem jött létre.")
    return FileResponse(
        path=file_path,
        filename="kvantitativ_fogadasi_naplo.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("app:app", host="127.0.0.1", port=port, reload=False)
