"""Drop-in clara-tools.yaml registry.

Modules installed via `claraos-module` write their clara-tools.yaml into
`CLARA_TOOLS_DIR` (default `/opt/claraos/clara-tools.d/`). This registry
reads them at startup and on `POST /api/claraos/tools/reload`, then
exposes the merged tool list for clara-agent / chat-frontend / the OpenAPI
tool bridge to consume.

Scope: in-memory registry + read-only HTTP endpoint; the tool bridge binds the
tools into clara-agent's LangGraph tool-set.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import logging
import os
from pathlib import Path
from threading import RLock
from typing import Any

import yaml

logger = logging.getLogger(__name__)

DEFAULT_DIR = "/opt/claraos/clara-tools.d"


def _tools_dir() -> Path:
    return Path(os.environ.get("CLARA_TOOLS_DIR", DEFAULT_DIR))


class ToolsRegistry:
    """Thread-safe in-memory registry of clara-tools.yaml entries.

    Schema per file is intentionally minimal-validated here — strict
    validation is the module-loader's job (Pydantic ClaraToolsManifest);
    we just have to be robust against partially-malformed files so a
    single bad module doesn't break the whole API.
    """

    def __init__(self):
        self._lock = RLock()
        self._modules: dict[str, dict[str, Any]] = {}  # module-name → parsed yaml
        self._loaded_at: dict[str, float] = {}

    def reload(self) -> dict[str, Any]:
        """Re-scan the drop-in dir, replace in-memory state."""
        d = _tools_dir()
        if not d.is_dir():
            logger.info("clara-tools dir %s does not exist; registry empty", d)
            with self._lock:
                self._modules = {}
                self._loaded_at = {}
            return self.summary()

        loaded: dict[str, dict[str, Any]] = {}
        mtimes: dict[str, float] = {}
        errors: list[str] = []
        for f in sorted(d.glob("*.yaml")):
            module_name = f.stem
            try:
                with f.open() as fh:
                    data = yaml.safe_load(fh) or {}
                if not isinstance(data, dict):
                    errors.append(f"{f.name}: top-level is not a dict")
                    continue
                # Defensive shape check; strict validation happens in module-loader
                tools = data.get("tools", []) or []
                ui_hooks = data.get("ui_hooks", []) or []
                if not isinstance(tools, list) or not isinstance(ui_hooks, list):
                    errors.append(f"{f.name}: tools/ui_hooks must be lists")
                    continue
                loaded[module_name] = {
                    "tools": tools,
                    "ui_hooks": ui_hooks,
                }
                mtimes[module_name] = f.stat().st_mtime
            except (yaml.YAMLError, OSError) as e:
                errors.append(f"{f.name}: {e}")

        with self._lock:
            self._modules = loaded
            self._loaded_at = mtimes

        if errors:
            logger.warning(
                "clara-tools reload: %d module(s) ok, %d error(s): %s",
                len(loaded), len(errors), "; ".join(errors)[:300],
            )
        else:
            logger.info("clara-tools reload: %d module(s) loaded", len(loaded))
        return self.summary()

    def summary(self) -> dict[str, Any]:
        with self._lock:
            return {
                "modules": list(self._modules.keys()),
                "tools_total": sum(len(m["tools"]) for m in self._modules.values()),
                "ui_hooks_total": sum(len(m["ui_hooks"]) for m in self._modules.values()),
            }

    def list_tools(self) -> list[dict[str, Any]]:
        """Flat list of all tools across modules, tagged with module name."""
        out: list[dict[str, Any]] = []
        with self._lock:
            for module_name, data in self._modules.items():
                for t in data["tools"]:
                    out.append({**t, "module": module_name})
        return out

    def list_ui_hooks(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        with self._lock:
            for module_name, data in self._modules.items():
                for h in data["ui_hooks"]:
                    out.append({**h, "module": module_name})
        return out

    def get_module(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            return self._modules.get(name)

    def to_openapi_spec(self, *, base_url: str = "/api/claraos/tools") -> dict[str, Any]:
        """Generate an OpenAPI 3.1 tool spec (for the tool bridge) from the registry.

        Tools become POST endpoints at `{base_url}/call/{module}/{tool_name}`.
        Per-tool schema goes into requestBody; response is a generic
        application/json object — claraos-api itself proxies to the
        module's endpoint (defined in clara-tools.yaml), so the response
        shape is module-defined and not introspectable here.
        """
        paths: dict[str, Any] = {}
        components: dict[str, Any] = {"schemas": {}}

        with self._lock:
            modules = dict(self._modules)

        for module_name, data in modules.items():
            for tool in data["tools"]:
                tool_name = tool.get("name")
                if not tool_name:
                    continue
                schema_id = f"{module_name}_{tool_name}_request"
                # Tool's own schema (from clara-tools.yaml) — pass through 1:1
                tool_schema = tool.get("schema") or {"type": "object"}
                # Inline definitions instead of $ref-spaghetti — simpler for consumers
                components["schemas"][schema_id] = {
                    "title": f"{tool_name}_request",
                    **tool_schema,
                }
                op_id = f"call_{module_name}_{tool_name}"
                paths[f"/call/{module_name}/{tool_name}"] = {
                    "post": {
                        "summary": (tool.get("description") or "").splitlines()[0][:120]
                                   if tool.get("description") else tool_name,
                        "description": tool.get("description") or "",
                        "operationId": op_id,
                        "tags": [module_name],
                        "x-clara-tool-auth": tool.get("auth", "none"),
                        "x-clara-tool-upstream": tool.get("endpoint", ""),
                        "requestBody": {
                            "required": True,
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": f"#/components/schemas/{schema_id}"}
                                }
                            },
                        },
                        "responses": {
                            "200": {
                                "description": "Module returned successfully",
                                "content": {
                                    "application/json": {
                                        "schema": {"type": "object"}
                                    }
                                },
                            },
                            "422": {
                                "description": "Request did not validate against the tool schema"
                            },
                            "502": {
                                "description": "Module upstream unreachable or returned an error"
                            },
                        },
                    }
                }

        return {
            "openapi": "3.1.0",
            "info": {
                "title": f"{PRODUCT_NAME} Module Tools",
                "description": (
                    "Dynamic OpenAPI spec generated from /opt/claraos/clara-tools.d/. "
                    f"Each installed {PRODUCT_NAME} module that ships clara-tools.yaml appears here."
                ),
                "version": "1.0.0",
            },
            "servers": [{"url": base_url, "description": "claraos-api tool proxy"}],
            "paths": paths,
            "components": components,
        }


# Module-level singleton; reload() called from main.py lifespan + /reload endpoint
registry = ToolsRegistry()
