"""Unit tests for the settings schema registry.

Runs WITHOUT the API venv (pure Python): `python3 -m pytest test_settings_schema.py`
or, if need be, `python3 test_settings_schema.py` (mini runner below).
"""

import settings_schema as ss


def test_registry_integrity():
    assert ss.integrity_errors() == []


def test_unknown_key_is_rejected_not_swallowed():
    # Anti-models.py rule: unknown keys -> error, never drop them silently.
    mod = ss.get_module("workspace-behavior")
    validated, unknown = ss.validate_payload(mod, {"clickBehavior": "single", "nope": 1})
    assert unknown == ["nope"]
    assert validated == {}


def test_validate_types_and_ranges():
    mod = ss.get_module("privacy-history")
    ok, unknown = ss.validate_payload(mod, {"clipboardHistorySize": 50})
    assert not unknown and ok["clipboardHistorySize"] == 50
    for bad in [-1, 101, "20", True, 1.5]:
        try:
            ss.validate_payload(mod, {"clipboardHistorySize": bad})
            assert False, f"{bad!r} hätte scheitern müssen"
        except ValueError:
            pass


def test_enum_and_bool():
    mod = ss.get_module("workspace-behavior")
    try:
        ss.validate_payload(mod, {"clickBehavior": "triple"})
        assert False
    except ValueError:
        pass
    try:
        ss.validate_payload(mod, {"showTooltips": "yes"})
        assert False
    except ValueError:
        pass


def test_resolve_defaults_and_deltas():
    mod = ss.get_module("workspace-behavior")
    eff = ss.resolve(mod, {})
    assert eff["clickBehavior"] == "double" and eff["showTooltips"] is True
    eff = ss.resolve(mod, {"clickBehavior": "single"})
    assert eff["clickBehavior"] == "single"
    assert ss.is_default(mod, "clickBehavior", "double")
    assert not ss.is_default(mod, "clickBehavior", "single")


def test_role_gating():
    ids_user = {m.id for m in ss.modules_for_role("user")}
    ids_admin = {m.id for m in ss.modules_for_role("admin")}
    assert "federation" not in ids_user
    assert "federation" in ids_admin
    # Many user accounts are ONLY in team-* groups (=> role "guest"). They must see
    # their own settings — otherwise the app is empty for them.
    ids_guest = {m.id for m in ss.modules_for_role("guest")}
    assert "workspace-behavior" in ids_guest
    assert "personalization" in ids_guest
    assert "federation" not in ids_guest
    # The schema payload does not include empty categories
    payload = ss.schema_payload("user")
    assert all(any(m["category"] == c["id"] for m in payload["modules"])
               for c in payload["categories"])


def test_color_validation():
    sdef = ss.SettingDef(key="c", type="color", default="#3daee9", label="x")
    assert sdef.validate("#FFAA00") == "#ffaa00"
    for bad in ["red", "#ffaa0", "#ggghhh", 0xFFAA00]:
        try:
            sdef.validate(bad)
            assert False
        except ValueError:
            pass


def test_files_module_shape():
    """Module 'files' replaces the legacy prefs block files_app."""
    mod = ss.get_module("files")
    assert mod is not None and mod.category == "workspace"
    # Migrated view keys + new tab keys must exist
    for key in ("viewMode", "sortKey", "sortDir", "dirsFirst", "showHidden",
                "groupBy", "openWithOverrides", "rememberOpenedTabs",
                "openNewTabAfterLastTab", "alwaysShowTabBar",
                "confirmClosingMultipleTabs", "closeSplitViewChoice",
                "places", "openTabs"):
        assert mod.setting(key) is not None, f"Key fehlt: {key}"
    # Defaults must match the frontend store defaults
    assert mod.setting("viewMode").default == "icons-large"
    assert mod.setting("dirsFirst").default is True
    assert mod.setting("closeSplitViewChoice").default == "active"
    assert mod.setting("closeSplitViewChoice").choices == ("active", "inactive", "right")
    # Tab behavior follows Dolphin (dolphin_generalsettings.kcfg)
    assert mod.setting("rememberOpenedTabs").default is True
    assert mod.setting("openNewTabAfterLastTab").default is False
    assert mod.setting("alwaysShowTabBar").default is False
    assert mod.setting("confirmClosingMultipleTabs").default is True


def test_terminal_extension_keys():
    """Profiles + quick commands as terminal keys."""
    mod = ss.get_module("terminal")
    for key in ("profiles", "defaultProfile", "quickCommands"):
        assert mod.setting(key) is not None, f"Key fehlt: {key}"
    assert mod.setting("profiles").default == []
    assert mod.setting("defaultProfile").default == "builtin:local"
    ok, unknown = ss.validate_payload(mod, {
        "profiles": [{"id": "p1", "name": "Test", "device": "local"}],
        "defaultProfile": "p1",
        "quickCommands": [{"group": "Docker", "name": "ps", "command": "docker ps"}],
    })
    assert not unknown and ok["defaultProfile"] == "p1"


def test_files_module_validation():
    mod = ss.get_module("files")
    ok, unknown = ss.validate_payload(mod, {"viewMode": "details", "showHidden": True})
    assert not unknown and ok["viewMode"] == "details"
    _, unknown = ss.validate_payload(mod, {"view_mode": "details"})
    assert unknown == ["view_mode"]  # snake_case = legacy, does NOT belong in the schema
    try:
        ss.validate_payload(mod, {"closeSplitViewChoice": "left"})
        assert False, "ungültige enum-Wahl hätte scheitern müssen"
    except ValueError:
        pass


if __name__ == "__main__":
    import sys, inspect
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and inspect.isfunction(fn):
            try:
                fn()
                print(f"  ✓ {name}")
            except AssertionError as e:
                failed += 1
                print(f"  ✗ {name} — {e}")
    sys.exit(1 if failed else 0)
