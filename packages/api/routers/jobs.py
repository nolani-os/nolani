"""Job status for long-running agent work (chat status cards + notification).

  POST /api/claraos/jobs/ereignis   machine only (service token): job.started /
                                    job.done / job.failed from the agent
  GET  /api/claraos/jobs            own jobs (optional ?chat_id=)
  GET  /api/claraos/jobs/{job_id}   one own job — the chat card polls this

On job.done / job.failed the user gets a ClaraOS notification (ntfy: bell in
the shell, push on the phone) whose click opens the chat (`/?chat=<id>`).
Event format and storage: services/jobs.py.
"""
from __future__ import annotations

from betriebsprofil import ASSISTANT_NAME
import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request

from auth import is_service_call, require_caller
from services import jobs

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/jobs", tags=["jobs"])


async def benachrichtigen(username: str, job: dict) -> None:
    """Bell + push when a job has ended. Best effort, never raises."""
    if job.get("status") not in jobs.STATUS_ENDGUELTIG:
        return
    try:
        from services.ntfy_publish import CLARAOS_PUBLIC_URL, notify_users
        from sprache import sprache_fuer, t
        lang = await sprache_fuer(username)
        titel = job.get("titel") or t(lang, "jobs.task")
        if job["status"] == "fertig":
            kopf = t(lang, "jobs.doneTitle", assistant=ASSISTANT_NAME)
            text = t(lang, "jobs.doneText", title=titel)
        else:
            kopf = t(lang, "jobs.failedTitle", assistant=ASSISTANT_NAME)
            text = t(lang, "jobs.failedText", title=titel)
            if job.get("fehler"):
                text += f" {job['fehler'][:160]}"
        chat_id = job.get("chat_id") or ""
        click = f"{CLARAOS_PUBLIC_URL}/?chat={chat_id}" if chat_id else f"{CLARAOS_PUBLIC_URL}/?chat=1"
        await notify_users([username], kopf, text, click=click,
                           priority="default" if job["status"] == "fertig" else "high")
    except Exception:  # noqa: BLE001
        logger.exception("jobs: notification failed")


async def ereignis_verarbeiten(username: str, ev: dict, *, chat_id: str = "") -> dict | None:
    """Store one job event for `username`; notify when it newly ended.

    Shared by the machine endpoint and the chat stream (chat_v2), which passes
    the chat it is running in.
    """
    job = jobs.normalisieren(ev)
    if job is None or not username:
        return None
    if chat_id and not job["chat_id"]:
        job["chat_id"] = chat_id
    zeile, vorher = await jobs.speichern(username, job)
    if zeile["status"] in jobs.STATUS_ENDGUELTIG and vorher not in jobs.STATUS_ENDGUELTIG:
        asyncio.create_task(benachrichtigen(username, zeile))
    return zeile


@router.post("/ereignis")
async def ereignis(request: Request) -> dict:
    if not is_service_call(request):
        raise HTTPException(status_code=403, detail="Nur für Dienste.")
    try:
        ev = await request.json()
    except ValueError:
        raise HTTPException(status_code=422, detail="Kein JSON.")
    if not isinstance(ev, dict):
        raise HTTPException(status_code=422, detail="Ereignis muss ein Objekt sein.")
    # Accept {"event": "job.done", ...} as well as {"type": "job.done", ...}.
    if "type" not in ev and isinstance(ev.get("event"), str):
        ev = {**ev, "type": ev["event"]}
    job = jobs.normalisieren(ev)
    if job is None:
        raise HTTPException(status_code=422,
                            detail="Unbekanntes Ereignis oder ungültige job_id "
                                   "(erwartet: job.started|job.done|job.failed).")
    username = job["user"]
    if not username:
        raise HTTPException(status_code=422, detail="Feld user fehlt.")
    try:
        zeile = await ereignis_verarbeiten(username, ev)
    except jobs.FremderJob:
        raise HTTPException(status_code=409, detail="job_id gehört einem anderen Nutzer.")
    return {"ok": True, "job": zeile}


@router.get("")
async def meine_jobs(request: Request, chat_id: str | None = None) -> dict:
    username = require_caller(request).lower()
    return {"jobs": await jobs.liste(username, chat_id=chat_id)}


@router.get("/{job_id}")
async def ein_job(job_id: str, request: Request) -> dict:
    username = require_caller(request).lower()
    if not jobs.JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="Unbekannter Auftrag.")
    job = await jobs.lesen(username, job_id)
    if job is None:
        # Same answer for "does not exist" and "belongs to someone else".
        raise HTTPException(status_code=404, detail="Unbekannter Auftrag.")
    return job
