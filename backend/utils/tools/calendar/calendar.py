"""
Local calendar / reminders persisted as JSON on disk.
Dispatched from toolCaller like the weather tool.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path

_CALENDAR_PATH = Path(__file__).resolve().parent.parent.parent.parent / "data" / "calendar.json"
_CATCHUP_MAX_AGE = timedelta(hours=24)
_file_lock = __import__("threading").Lock()
_on_events_changed = None


def register_on_events_changed(callback) -> None:
    """Optional hook (used by app.py) to schedule precise reminder timers after saves."""
    global _on_events_changed
    _on_events_changed = callback


def _notify_events_changed() -> None:
    if _on_events_changed:
        try:
            _on_events_changed()
        except Exception:
            pass


def _escape_attr(value: str) -> str:
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def _load_events() -> list[dict]:
    with _file_lock:
        if not _CALENDAR_PATH.is_file():
            return []
        try:
            data = json.loads(_CALENDAR_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            return []


def _save_events(events: list[dict]) -> None:
    with _file_lock:
        _CALENDAR_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CALENDAR_PATH.write_text(json.dumps(events, indent=2), encoding="utf-8")
    _notify_events_changed()


def parse_when_string(when_str: str, ref: datetime | None = None) -> datetime | None:
    """Parse natural-language times like '4:54 PM today' or 'tomorrow at 3pm'."""
    if not (when_str or "").strip():
        return None

    ref = ref or datetime.now()
    text = when_str.strip()

    if re.match(r"^\d{4}-\d{2}-\d{2}", text):
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo:
                parsed = parsed.replace(tzinfo=None)
            return parsed
        except ValueError:
            pass

    lower = text.lower()
    day_offset: int | None = None
    if "tomorrow" in lower:
        day_offset = 1
    elif "today" in lower:
        day_offset = 0

    time_match = re.search(r"(\d{1,2})[.:](\d{2})\s*(am|pm)?", text, re.IGNORECASE)
    if not time_match:
        return None

    hours = int(time_match.group(1))
    minutes = int(time_match.group(2))
    ampm = (time_match.group(3) or "").lower()

    if ampm == "pm" and hours < 12:
        hours += 12
    if ampm == "am" and hours == 12:
        hours = 0

    result = ref.replace(hour=hours, minute=minutes, second=0, microsecond=0)
    if day_offset is not None:
        base = ref.replace(hour=0, minute=0, second=0, microsecond=0)
        result = base.replace(hour=hours, minute=minutes, second=0, microsecond=0)
        result += timedelta(days=day_offset)
    else:
        # No day mentioned — default to today (local device time).
        base = ref.replace(hour=0, minute=0, second=0, microsecond=0)
        result = base.replace(hour=hours, minute=minutes, second=0, microsecond=0)

    return result


def _normalize_when_string(when_str: str) -> str:
    """If the when phrase has no day, assume today."""
    text = (when_str or "").strip()
    if not text:
        return text
    lower = text.lower()
    if "today" in lower or "tomorrow" in lower or re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return text
    return f"{text} today"


def format_spoken_time(when: datetime, ref: datetime | None = None) -> str:
    ref = ref or datetime.now()
    time_str = when.strftime("%I:%M %p").lstrip("0")
    if when.date() == ref.date():
        return f"{time_str} today"
    tomorrow = (ref + timedelta(days=1)).date()
    if when.date() == tomorrow:
        return f"{time_str} tomorrow"
    return when.strftime("%A, %B %d at %I:%M %p").lstrip("0")


def add_event(title: str, when_str: str) -> str:
    title = (title or "").strip()
    if not title:
        return 'Calendar tool: action="add", status="error", message="Missing event title".'

    when_str = _normalize_when_string(when_str)
    parsed = parse_when_string(when_str)
    if not parsed:
        return (
            f'Calendar tool: action="add", title="{_escape_attr(title)}", '
            f'status="error", message="Could not parse time".'
        )

    event = {
        "id": str(uuid.uuid4()),
        "title": title,
        "starts_at": parsed.isoformat(),
        "notified": False,
        "created_at": datetime.now().isoformat(),
    }
    events = _load_events()
    events.append(event)
    _save_events(events)

    spoken = format_spoken_time(parsed)
    return (
        f'Calendar tool: action="add", title="{_escape_attr(title)}", '
        f'starts_at="{event["starts_at"]}", starts_at_spoken="{_escape_attr(spoken)}", status="saved".'
    )


def get_active_events() -> list[dict]:
    """All reminders not yet delivered (local device time)."""
    active = [e for e in _load_events() if not e.get("notified")]
    active.sort(key=lambda e: e.get("starts_at", ""))
    return active


def list_events() -> str:
    active = get_active_events()

    if not active:
        return (
            'Calendar tool: action="list", status="empty", count=0, '
            'message="No reminders saved".'
        )

    now = datetime.now()
    summaries = []
    for e in active[:8]:
        starts_at = datetime.fromisoformat(e["starts_at"])
        spoken = format_spoken_time(starts_at, now)
        summaries.append(f'{e["title"]} at {spoken}')
    events_str = "; ".join(summaries)
    count = len(active)
    return (
        f'Calendar tool: action="list", status="ok", count={count}, '
        f'events="{_escape_attr(events_str)}".'
    )


def delete_event(title: str) -> str:
    title = (title or "").strip()
    match = _find_event_by_title(title)
    if not match:
        return f'Calendar tool: action="delete", title="{_escape_attr(title)}", status="not_found".'

    events = [e for e in _load_events() if e["id"] != match["id"]]
    _save_events(events)
    spoken = format_spoken_time(datetime.fromisoformat(match["starts_at"]))
    return (
        f'Calendar tool: action="delete", title="{_escape_attr(match["title"])}", '
        f'starts_at_spoken="{_escape_attr(spoken)}", status="deleted".'
    )


def update_event(title: str, when_str: str) -> str:
    title = (title or "").strip()
    match = _find_event_by_title(title)
    if not match:
        return f'Calendar tool: action="update", title="{_escape_attr(title)}", status="not_found".'

    when_str = _normalize_when_string(when_str)
    parsed = parse_when_string(when_str)
    if not parsed:
        return (
            f'Calendar tool: action="update", title="{_escape_attr(title)}", '
            f'status="error", message="Could not parse time".'
        )

    events = _load_events()
    updated = None
    for e in events:
        if e["id"] == match["id"]:
            e["starts_at"] = parsed.isoformat()
            e["notified"] = False
            updated = e
            break
    _save_events(events)

    spoken = format_spoken_time(parsed)
    return (
        f'Calendar tool: action="update", title="{_escape_attr(updated["title"])}", '
        f'starts_at_spoken="{_escape_attr(spoken)}", status="updated".'
    )


def _find_event_by_title(title: str) -> dict | None:
    needle = (title or "").strip().lower()
    if not needle:
        return None
    active = [e for e in _load_events() if not e.get("notified")]
    for e in active:
        if e.get("title", "").lower() == needle:
            return e
    for e in active:
        if needle in e.get("title", "").lower():
            return e
    return None


def get_due_events(now: datetime | None = None) -> list[dict]:
    now = now or datetime.now()
    cutoff = now - _CATCHUP_MAX_AGE
    due = []
    for e in _load_events():
        if e.get("notified"):
            continue
        try:
            starts_at = datetime.fromisoformat(e["starts_at"])
        except (KeyError, ValueError):
            continue
        if starts_at > now:
            continue
        if starts_at < cutoff:
            continue
        due.append(e)
    due.sort(key=lambda e: e["starts_at"])
    return due


def get_event_by_id(event_id: str) -> dict | None:
    for e in _load_events():
        if e.get("id") == event_id:
            return e
    return None


def seconds_until_next_reminder_check() -> float:
    """Adaptive poll interval using local device clock (no network time)."""
    now = datetime.now()
    if get_due_events(now):
        return 0.0

    next_at: datetime | None = None
    for e in get_active_events():
        try:
            starts_at = datetime.fromisoformat(e["starts_at"])
        except (KeyError, ValueError):
            continue
        if starts_at > now and (next_at is None or starts_at < next_at):
            next_at = starts_at

    if next_at is None:
        return 15.0

    delta = (next_at - now).total_seconds()
    if delta <= 2:
        return 0.25
    if delta <= 120:
        return 1.0
    return min(max(delta - 60.0, 1.0), 15.0)


def mark_notified(event_id: str) -> None:
    events = _load_events()
    for e in events:
        if e.get("id") == event_id:
            e["notified"] = True
            break
    _save_events(events)


def build_reminder_speech(event: dict, now: datetime | None = None) -> str:
    now = now or datetime.now()
    starts_at = datetime.fromisoformat(event["starts_at"])
    spoken = format_spoken_time(starts_at, now)
    diff = (now - starts_at).total_seconds()
    title = event.get("title", "your event")
    if diff > 5 * 60:
        return f"Reminder: your {title} was scheduled for {spoken}."
    return f"Reminder: your {title} is now."


def run_calendar(segment: tuple[str, ...]) -> str:
    """Run one calendar tool segment; return a single context line for the main LLM."""
    action = segment[1].strip().lower() if len(segment) > 1 else ""
    if action in ("add", "remind", "set"):
        title = segment[2] if len(segment) > 2 else ""
        when_str = segment[3] if len(segment) > 3 else ""
        return add_event(title, when_str)
    if action in ("list", "upcoming"):
        return list_events()
    if action in ("delete", "remove", "cancel"):
        title = segment[2] if len(segment) > 2 else ""
        return delete_event(title)
    if action in ("update", "change"):
        title = segment[2] if len(segment) > 2 else ""
        when_str = segment[3] if len(segment) > 3 else ""
        return update_event(title, when_str)
    return f'Calendar tool: action="{_escape_attr(action)}", status="error", message="Unknown calendar action".'
