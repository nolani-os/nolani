"""Pydantic models for ClaraOS API."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


class UserResponse(BaseModel):
    username: str
    email: str
    name: str
    role: str
    groups: list[str]
    logout_url: str = ""


class AppManifest(BaseModel):
    id: str
    name: str
    icon: str
    type: str  # "internal" | "iframe" | "hybrid"
    url: str | None = None
    window: dict
    permissions: list[str] = []
    required_groups: list[str] | None = None
    filetype_associations: list[str] | None = None
    category: str


class UserPrefs(BaseModel):
    # Default must match the frontend default (ui.ts skinId) — otherwise a GET
    # without a DB row would switch the user's skin on boot.
    skin_id: str = "clara-glass"
    theme: str = "dark"
    wallpaper: str = ""
    pinned_apps: list[str] = []
    desktop_icons: list[dict] = []
    # Files app view (view_mode/sort/hidden/group/open-with overrides).
    # Warning: the field MUST exist here — the PUT merge validates through
    # UserPrefs and pydantic silently drops unknown keys.
    files_app: dict = {}
    # Planner app (saved filters/smart lists etc.) — same pitfall as
    # files_app: without a declared field the PUT merge swallows the key.
    planner_app: dict = {}
    # Mail app (default identity, undo-send window, read receipts).
    post_app: dict = {}


class DesktopState(BaseModel):
    windows: dict = {}
    window_order: list[str] = []
    # Workspaces incl. desktop widgets: previously IndexedDB only, so widgets
    # were lost on every new device/browser. Shape = partialize of
    # useWorkspaceStore (workspaces[] + activeId).
    workspaces: list[dict] = []
    active_workspace: str = ""


# ── Routines ─────────────────────────────────────────────────────────────

RoutineType = Literal["cve_watch", "rss_digest", "image_updates", "custom", "trivy_scan"]
Severity = Literal["critical", "high", "medium", "low", "info"]


class RoutineCreate(BaseModel):
    type: RoutineType
    name: str = Field(min_length=1, max_length=200)
    config: dict[str, Any] = {}
    schedule: str | None = None
    n8n_workflow_id: str | None = None


class RoutinePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    enabled: bool | None = None
    config: dict[str, Any] | None = None
    schedule: str | None = None
    n8n_workflow_id: str | None = None


class Routine(BaseModel):
    id: UUID
    username: str
    type: RoutineType
    name: str
    config: dict[str, Any]
    schedule: str | None
    n8n_workflow_id: str | None
    enabled: bool
    last_run_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # webhook_token only returned on POST / (one-time secret); list/get hide it
    webhook_token: str | None = None


class RoutineItem(BaseModel):
    id: UUID
    routine_id: UUID
    ts: datetime
    payload: dict[str, Any]
    read: bool
    severity: Severity | None
    external_id: str | None


class WebhookItem(BaseModel):
    payload: dict[str, Any]
    severity: Severity | None = None
    external_id: str | None = None


class WebhookPayload(BaseModel):
    items: list[WebhookItem] = Field(min_length=1, max_length=500)


class CveSubscription(BaseModel):
    vendor: str = Field(min_length=1, max_length=100)
    product: str = Field(min_length=1, max_length=100)
    min_severity: Severity = "high"


class RoutineTypeSpec(BaseModel):
    type: RoutineType
    label: str
    description: str
    config_schema: dict[str, Any]
