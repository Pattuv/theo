# Screenshot capture with coordinate grid overlay at native resolution.
# Returns a PIL Image and metadata for in-process LLM usage.

import sys
from ctypes import POINTER, Structure, WINFUNCTYPE, byref, c_long, c_uint, c_void_p, windll
from ctypes.wintypes import RECT

import mss
from PIL import Image, ImageDraw
from PIL import ImageFont

# these are configs for the graph that is overlayed on every screenshot.

MINOR_SPACING = 10
MAJOR_SPACING = 100
# Keep 1:1 coordinate mapping with the screen.
# Compression is handled at serialization time (e.g., PNG optimize=True),
# not by resizing, so PyAutoGUI coordinates stay exact.
SCALE_FACTOR = 1.0


MINOR_COLOR = (200, 200, 200) 
MAJOR_COLOR = (120, 120, 120) 
MINOR_WIDTH = 1
MAJOR_WIDTH = 2
LABEL_TEXT_COLOR = (255, 255, 255)
LABEL_BG_COLOR = (30, 30, 30)
LABEL_PADDING_X = 3
LABEL_PADDING_Y = 1

MONITORINFOF_PRIMARY = 0x1


class MONITORINFO(Structure):
    _fields_ = [
        ("cbSize", c_uint),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", c_uint),
    ]


def _get_primary_monitor_bounds_windows():
    """Use Win32 API to get the Windows primary monitor rect (left, top, width, height)."""
    from ctypes import sizeof

    user32 = windll.user32
    primary_rect = [None]

    def callback(h_monitor, _h_dc, _lprc_clip, _dw_data):
        mi = MONITORINFO()
        mi.cbSize = sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(h_monitor, byref(mi)) and (mi.dwFlags & MONITORINFOF_PRIMARY):
            r = mi.rcMonitor
            primary_rect[0] = (r.left, r.top, r.right - r.left, r.bottom - r.top)
        return 1 

    MONITORENUMPROC = WINFUNCTYPE(c_long, c_void_p, c_void_p, POINTER(RECT), c_long)
    user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(callback), 0)
    return primary_rect[0]


def _select_primary_monitor(sct):
    """Return the mss monitor dict for the Windows primary display, or monitors[1] on other platforms."""
    if sys.platform != "win32":
        return sct.monitors[1]
    bounds = _get_primary_monitor_bounds_windows()
    if not bounds:
        return sct.monitors[1]
    left, top, width, height = bounds
    for i, mon in enumerate(sct.monitors):
        if i == 0:
            continue
        if mon["left"] == left and mon["top"] == top and mon["width"] == width and mon["height"] == height:
            return mon
    return sct.monitors[1]


def _draw_grid(draw: ImageDraw.ImageDraw, width: int, height: int) -> None:
    """Draw label-free grid: minor every 10px, major every 100px."""
    # minor lines
    for x in range(0, width + 1, MINOR_SPACING):
        draw.line([(x, 0), (x, height)], fill=MINOR_COLOR, width=MINOR_WIDTH)
    for y in range(0, height + 1, MINOR_SPACING):
        draw.line([(0, y), (width, y)], fill=MINOR_COLOR, width=MINOR_WIDTH)

    # major lines
    for x in range(0, width + 1, MAJOR_SPACING):
        draw.line([(x, 0), (x, height)], fill=MAJOR_COLOR, width=MAJOR_WIDTH)
    for y in range(0, height + 1, MAJOR_SPACING):
        draw.line([(0, y), (width, y)], fill=MAJOR_COLOR, width=MAJOR_WIDTH)


def _draw_major_labels(draw: ImageDraw.ImageDraw, width: int, height: int) -> None:
    """Draw numeric labels for major grid lines at top (x) and left (y) edges."""
    font = ImageFont.load_default()

    # X labels along top edge.
    for x in range(0, width + 1, MAJOR_SPACING):
        text = str(x)
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        x0 = max(0, min(width - (text_w + LABEL_PADDING_X * 2), x + 2))
        y0 = 2
        x1 = x0 + text_w + LABEL_PADDING_X * 2
        y1 = y0 + text_h + LABEL_PADDING_Y * 2
        draw.rectangle([x0, y0, x1, y1], fill=LABEL_BG_COLOR)
        draw.text(
            (x0 + LABEL_PADDING_X, y0 + LABEL_PADDING_Y),
            text,
            fill=LABEL_TEXT_COLOR,
            font=font,
        )

    # Y labels along left edge.
    for y in range(0, height + 1, MAJOR_SPACING):
        text = str(y)
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        x0 = 2
        y0 = max(0, min(height - (text_h + LABEL_PADDING_Y * 2), y + 2))
        x1 = x0 + text_w + LABEL_PADDING_X * 2
        y1 = y0 + text_h + LABEL_PADDING_Y * 2
        draw.rectangle([x0, y0, x1, y1], fill=LABEL_BG_COLOR)
        draw.text(
            (x0 + LABEL_PADDING_X, y0 + LABEL_PADDING_Y),
            text,
            fill=LABEL_TEXT_COLOR,
            font=font,
        )


def image_processor():
    with mss.mss() as sct:
        primary = _select_primary_monitor(sct)
        screenshot = sct.grab(primary)

        if screenshot is None:
            raise RuntimeError("Failed to capture screenshot")

        width = screenshot.width
        height = screenshot.height
        img = Image.frombytes("RGBA", (width, height), screenshot.bgra)
        img = img.convert("RGB")

        # overlay grid
        draw = ImageDraw.Draw(img)
        _draw_grid(draw, width, height)
        _draw_major_labels(draw, width, height)

        # No resize here: preserve exact screen coordinate mapping.

    return {
        "image": img,
        "width": width,
        "height": height,
        "grid": {"minor": MINOR_SPACING, "major": MAJOR_SPACING},
        "scale": SCALE_FACTOR,
    }
