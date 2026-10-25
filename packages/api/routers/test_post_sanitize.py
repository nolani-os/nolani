"""Mail HTML sanitiser: stranger-written markup that ends up on the shell origin.

Each case below slipped through the earlier regex sanitiser. The check is on the
output only: no event handler, no script-capable URL, no element that executes.
"""
from __future__ import annotations

import html
import re

import pytest

from routers.post import _sanitize_html

BYPASSES = [
    '<img src=x onerror="window.__x=1">',
    "<svg/onload=window.__x=1>",
    '<img src="x"onerror="window.__x=1">',
    '<a href="java&#115;cript:window.__x=1">l</a>',
    '<a href="java\tscript:window.__x=1">l</a>',
    '<svg><animate attributeName="href" values="javascript:window.__x=1"/></svg>',
    "<script>window.__x=1</script>",
    '<iframe src="https://example.org"></iframe>',
    '<form action="https://example.org"><input name=a></form>',
    '<math><mtext><table><mglyph><style><img src=x onerror=window.__x=1>',
]


def _dangerous(out: str) -> list[str]:
    decoded = html.unescape(out).lower().replace("\t", "").replace("\n", "")
    found = []
    if re.search(r"<[^>]*\son\w+\s*=", decoded) or re.search(r"[\"'/]on\w+\s*=", decoded):
        found.append("event handler")
    if "javascript:" in decoded:
        found.append("javascript url")
    for tag in ("script", "iframe", "form", "svg", "animate", "math", "object", "embed"):
        if f"<{tag}" in decoded:
            found.append(tag)
    return found


@pytest.mark.parametrize("markup", BYPASSES)
@pytest.mark.parametrize("style_blocks", [False, True])
def test_known_bypasses_are_neutralised(markup, style_blocks):
    out = _sanitize_html(markup, style_blocks=style_blocks)
    assert _dangerous(out) == [], out


def test_style_blocks_only_for_the_sandboxed_reading_pane():
    src = "<style>p{color:red}</style><p>x</p>"
    assert "<style>" in _sanitize_html(src, style_blocks=True)
    assert "<style" not in _sanitize_html(src)
    assert "color:red" not in _sanitize_html(src)


def test_overlay_css_is_dropped_but_formatting_kept():
    out = _sanitize_html('<p style="color:red;position:fixed;top:0;z-index:9;font-weight:bold">x</p>')
    assert "position" not in out and "z-index" not in out
    assert "color:red" in out.replace(" ", "") and "font-weight:bold" in out.replace(" ", "")


def test_mail_layout_and_inline_images_survive():
    src = ('<table cellpadding="4" bgcolor="#eee"><tr><td colspan="2">'
           '<img src="cid:logo@x" alt="Logo"><a href="https://example.org/a">a</a>'
           '<a href="mailto:bob@example.org">m</a></td></tr></table>')
    out = _sanitize_html(src)
    assert 'src="cid:logo@x"' in out
    assert 'href="https://example.org/a"' in out and 'href="mailto:bob@example.org"' in out
    assert 'colspan="2"' in out and "<table" in out
    assert 'rel="noopener noreferrer"' in out


def test_data_urls_are_not_allowed_anywhere():
    out = _sanitize_html('<a href="data:text/html,<b>x</b>">x</a><img src="data:image/svg+xml,<svg/onload=1>">')
    assert "data:" not in out
