"""
Parse Groq classifier output and dispatch registered tools.

Wire format (see CLASSIFERSYSTEMPROMPT.md): ---CATEGORY--- then zero or more
segments like ``_("weather","local")`` chained without spaces.
"""

from __future__ import annotations

import logging

from utils.tools.calendar.calendar import run_calendar
from utils.tools.weather.weather import getWeather

logger = logging.getLogger(__name__)


def parse_classifier_raw(raw: str) -> tuple[str, list[tuple[str, ...]]]:
    """
    Return (classification_label, list of tool argument tuples).
    Each tuple is (tool_name, *params). Classification is one of ---CHAT--- / ---AGENT--- / ---UNSAFE---.
    """
    s = (raw or "").strip()
    if not s:
        return "---CHAT---", []

    upper = s.upper()
    found_label: str | None = None
    found_idx = -1
    for label in ("---UNSAFE---", "---AGENT---", "---CHAT---"):
        idx = upper.find(label)
        if idx >= 0 and (found_idx < 0 or idx < found_idx):
            found_idx = idx
            found_label = label

    if not found_label:
        return "---CHAT---", []

    rest = s[found_idx + len(found_label) :]
    if found_label == "---UNSAFE---":
        return "---UNSAFE---", []

    return found_label, _parse_tool_suffix(rest)


def _parse_tool_suffix(rest: str) -> list[tuple[str, ...]]:
    rest = rest.strip()
    out: list[tuple[str, ...]] = []
    i = 0
    n = len(rest)
    while i < n:
        while i < n and rest[i].isspace():
            i += 1
        if i >= n:
            break
        if i + 1 < n and rest[i : i + 2] == "_(":
            i += 2
            close = _find_closing_paren(rest, i)
            if close < 0:
                logger.warning("Unclosed tool segment in classifier suffix: %s", rest[:80])
                break
            inner = rest[i:close]
            fields = _split_top_level_commas(inner)
            tokens = tuple(_unquote_field(f.strip()) for f in fields if f.strip())
            if tokens:
                out.append(tokens)
            i = close + 1
            continue
        i += 1
    return out


def _find_closing_paren(s: str, start: int) -> int:
    depth = 1
    i = start
    in_dq = False
    while i < len(s):
        c = s[i]
        if c == '"':
            in_dq = not in_dq
        elif not in_dq:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def _split_top_level_commas(s: str) -> list[str]:
    parts: list[str] = []
    cur: list[str] = []
    in_dq = False
    for c in s:
        if c == '"':
            in_dq = not in_dq
            cur.append(c)
        elif c == "," and not in_dq:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(c)
    if cur:
        parts.append("".join(cur))
    return parts


def _unquote_field(f: str) -> str:
    f = f.strip()
    if len(f) >= 2 and f[0] == '"' and f[-1] == '"':
        return f[1:-1].replace('\\"', '"')
    if len(f) >= 2 and f[0] == "'" and f[-1] == "'":
        return f[1:-1]
    return f


def call_tool_segment(segment: tuple[str, ...]) -> str:
    """Run one parsed tool segment; return a single line of context for the main LLM."""
    if not segment:
        return ""
    name = segment[0].strip().lower()
    if name == "weather":
        location = segment[1].strip() if len(segment) > 1 else "local"
        place, temp_f, qualitative = getWeather(location)
        return (
            f'Weather tool: place="{place}", temperature_f={temp_f:.1f}, condition="{qualitative}".'
        )
    if name == "calendar":
        return run_calendar(segment)
    logger.warning("Unknown tool in segment (allowed: weather, calendar): %s", segment)
    return ""


def run_tool_segments(segments: list[tuple[str, ...]]) -> str:
    """Execute each segment in order; concatenate non-empty results with newlines."""
    lines: list[str] = []
    for seg in segments:
        try:
            line = call_tool_segment(seg)
        except Exception as e:
            tool_id = seg[0] if seg else "?"
            logger.exception("Tool %s failed", tool_id)
            line = f'Tool error ({tool_id}): {type(e).__name__}: {e}'
        if line:
            lines.append(line)
    return "\n".join(lines)
