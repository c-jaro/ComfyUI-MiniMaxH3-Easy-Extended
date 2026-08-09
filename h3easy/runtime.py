from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

import torch
import torch.nn.functional as F
import comfy.utils
from comfy_extras import nodes_minimax_h3 as h3

from .model_loading import MiniMaxH3Bundle

MODE_VIDEO = "Video + audio"
MODE_AUDIO = "Audio only (32x32 proxy)"
CANVAS_NATIVE = "768P (native)"
CANVAS_704 = "704P (draft)"
CANVAS_640 = "640P (draft)"
CANVAS_576 = "576P (draft)"
CANVAS_512 = "512P (draft)"
CANVAS_AUDIO_PROXY = "32x32 (audio proxy)"
AUDIO_PROXY_WIDTH = 32
AUDIO_PROXY_HEIGHT = 32
CANVAS_CUSTOM = "Custom exact"
KEYFRAME_FIRST = "First frame"
KEYFRAME_LAST = "Last frame"
KEYFRAME_CANVAS_ADAPTIVE = "Opening frame; if absent, last frame"
KEYFRAME_CANVAS_FIXED = "Aspect ratio setting"
FIRST_FRAME_FIT_PAD = "Preserve full frame (pad edges)"
FIRST_FRAME_FIT_CROP = "Fill output (crop edges)"
FIRST_FRAME_FIT_STRETCH = "Stretch to output (distorts)"
# Compatibility symbol kept for older code/workflows. It is the same behavior as PAD.
FIRST_FRAME_FIT_AUTO = FIRST_FRAME_FIT_PAD
REF_IMAGE_MATCH = "Balanced to output area (may upscale)"
REF_IMAGE_MAX = "2048px short-edge cap (no upscale)"
REF_VIDEO_NATIVE = "768P native"
REF_VIDEO_640 = "640P downscaled"
REF_VIDEO_576 = "576P downscaled"
REF_VIDEO_512 = "512P downscaled"
REF_VIDEO_TEMPORAL_CORE = "Trim tail to valid H3 frame count"
REF_VIDEO_TEMPORAL_HOLD = "Keep last frame (pad to valid H3 length)"

# Single backend source of truth for fresh-node/runtime fallback defaults.
DEFAULT_MODE = MODE_VIDEO
DEFAULT_CANVAS = CANVAS_NATIVE
DEFAULT_KEYFRAME_ROLE = KEYFRAME_FIRST
DEFAULT_KEYFRAME_CANVAS = KEYFRAME_CANVAS_ADAPTIVE
DEFAULT_FIRST_FRAME_RESIZE = FIRST_FRAME_FIT_PAD
DEFAULT_LAST_FRAME_RESIZE = FIRST_FRAME_FIT_CROP
DEFAULT_REF_IMAGE_SIZE = REF_IMAGE_MATCH
DEFAULT_REF_VIDEO_SIZE = REF_VIDEO_NATIVE
DEFAULT_REF_VIDEO_TEMPORAL_FIT = REF_VIDEO_TEMPORAL_CORE
DEFAULT_SECONDS = 5.0
DEFAULT_PLAYBACK_FPS = 24.0
DEFAULT_ASPECT_RATIO = "16:9"
DEFAULT_CUSTOM_WIDTH = 1344
DEFAULT_CUSTOM_HEIGHT = 768
DEFAULT_REF_VIDEO_FPS = 24.0
DEFAULT_REF_VIDEO_FPS_OVERRIDE = 0.0

# Exact legacy widget values accepted for workflow compatibility.
LEGACY_MODE_BASE = "Base / Keyframes (T2VA/I2VA/FL2VA/L2VA)"
LEGACY_MODE_BASE_V2 = "Text / first-last frames (T2VA / I2VA / L2VA / FL2VA)"
LEGACY_MODE_REFERENCE = "Full Reference (REF2VA)"
LEGACY_MODE_REFERENCE_V2 = "References (REF2VA)"
LEGACY_MODE_REFERENCE_V3 = "Reference conditioning"
LEGACY_MODE_AUDIO = "Audio-first"
LEGACY_MODE_AUDIO_V228 = "Audio-first proxy (T2A / A2A / V2A)"
LEGACY_MODE_AUDIO_V229 = "Audio-first proxy (T2A / I2A / V2A / A2A)"
LEGACY_KEYFRAME_FIRST = "Image 1 = first frame"
LEGACY_KEYFRAME_LAST = "Image 1 = last frame"
LEGACY_KEYFRAME_CANVAS_ADAPTIVE = "Adaptive to keyframe (recommended)"
LEGACY_KEYFRAME_CANVAS_V2 = "First/last frame image"
LEGACY_KEYFRAME_CANVAS_FIXED = "Use selected canvas aspect"
LEGACY_FIRST_FRAME_FIT_AUTO = "Auto: preserve aspect (pad when needed)"
LEGACY_FIRST_FRAME_FIT_PAD = "Preserve all (replicate-edge pad)"
LEGACY_FIRST_FRAME_FIT_CROP = "Fill canvas (center crop)"
LEGACY_FIRST_FRAME_FIT_STRETCH = "Allow stretch (core behavior)"
LEGACY_REF_IMAGE_MATCH = "Auto match generation area"
LEGACY_REF_IMAGE_MATCH_V2 = "Match output pixel area"
LEGACY_REF_IMAGE_MAX = "Max fidelity (2048px short edge)"
LEGACY_REF_IMAGE_MAX_DETAIL = "2048px short edge (maximum detail)"
LEGACY_REF_VIDEO_NATIVE = "768P native (best fidelity)"
LEGACY_REF_VIDEO_640 = "640P balanced"
LEGACY_REF_VIDEO_576 = "576P faster"
LEGACY_REF_VIDEO_512 = "512P fastest"
LEGACY_REF_VIDEO_TEMPORAL_CORE = "Core exact: trim tail to 17k+5"
LEGACY_REF_VIDEO_TEMPORAL_HOLD = "Preserve endpoint: hold final frame"

# MiniMax's published Ref2VA envelope. These are diagnostics, not checkpoint
# capability gates: current ComfyUI can structurally pass several combinations
# outside this envelope, which is useful for experimental/cross-routed weights.
REF_MAX_IMAGES = 9
REF_MAX_VIDEOS = 3
REF_MAX_AUDIOS = 3
REF_MAX_FILES = 12
REF_CLIP_SECONDS_MIN = 2.0
REF_CLIP_SECONDS_MAX = 15.0
REF_TOTAL_VIDEO_SECONDS_MAX = 15.0
REF_TOTAL_AUDIO_SECONDS_MAX = 15.0

ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "1:1": (1, 1),
    "2:3": (2, 3),
    "3:2": (3, 2),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "9:16": (9, 16),
    "16:9": (16, 9),
    "21:9": (21, 9),
}

MEDIA_TOKEN_RE = re.compile(r"@(?P<kind>Image|Video|Audio|Subject)(?P<index>\d+)\b", re.IGNORECASE)
NATIVE_MEDIA_TOKEN_RE = re.compile(r"<(?P<kind>Picture|Video|Audio|Subject)\s+(?P<index>\d+)>", re.IGNORECASE)
ANGLE_IMAGE_ALIAS_RE = re.compile(r"<Image\s+(?P<index>\d+)>", re.IGNORECASE)

def _selected(combo: dict[str, Any] | None, input_id: str, fallback: str) -> str:
    if not isinstance(combo, dict):
        return fallback
    value = combo.get(input_id, fallback)
    return str(value)


def _values_sorted(group: dict[str, Any] | None, prefix: str) -> list[tuple[str, Any]]:
    if not isinstance(group, dict):
        return []

    def key(item: tuple[str, Any]) -> tuple[int, str]:
        name = str(item[0])
        match = re.search(r"(\d+)$", name)
        return (int(match.group(1)) if match else 10_000, name)

    return [(str(name), value) for name, value in sorted(group.items(), key=key) if value is not None and str(name).startswith(prefix)]


def _ordered_group(group: dict[str, Any] | None, prefix: str) -> dict[str, Any]:
    """Return connected Autogrow values in deterministic numeric slot order."""
    return dict(_values_sorted(group, prefix))


def _core_ref_image_size(value: str) -> str:
    # Keep the UI descriptive while accepting the native core values for direct/API
    # callers. Unknown values fail rather than silently changing resize policy.
    selected = str(value)
    if selected in {REF_IMAGE_MAX, LEGACY_REF_IMAGE_MAX, LEGACY_REF_IMAGE_MAX_DETAIL, "max", "2k"}:
        return "max"
    if selected in {REF_IMAGE_MATCH, LEGACY_REF_IMAGE_MATCH, LEGACY_REF_IMAGE_MATCH_V2, "match"}:
        return "match"
    raise ValueError(f"Unknown Reference image size {selected!r}. Choose {REF_IMAGE_MATCH!r} or {REF_IMAGE_MAX!r}.")


def _ratio(aspect_ratio: str) -> tuple[int, int]:
    selected = str(aspect_ratio)
    if selected not in ASPECT_RATIOS:
        raise ValueError(f"Unknown H3 aspect ratio {selected!r}. Choose one of: {', '.join(ASPECT_RATIOS)}.")
    return ASPECT_RATIOS[selected]


def native_canvas(aspect_ratio: str) -> tuple[int, int]:
    ratio_w, ratio_h = _ratio(aspect_ratio)
    return h3.adapt_canvas(ratio_w, ratio_h)


def _scaled_canvas_ratio(ratio_w: float, ratio_h: float, short_edge: int) -> tuple[int, int]:
    """Scale ComfyUI's official 768-class canvas policy to a lower draft class."""
    base = float(short_edge)
    ratio = ratio_w / ratio_h
    if ratio >= 1.0:
        nominal_w, nominal_h = base * ratio, base
    else:
        nominal_w, nominal_h = base, base / ratio

    native_short = float(getattr(h3, "BASE_SHORT_EDGE", 768))
    native_max_pixels = float(getattr(h3, "MAX_PIXELS", 768 * 1344))
    max_pixels = native_max_pixels * (base / native_short) ** 2
    if nominal_w * nominal_h > max_pixels:
        scale = math.sqrt(max_pixels / (nominal_w * nominal_h))
        nominal_w *= scale
        nominal_h *= scale

    multiple = int(getattr(h3, "CANVAS_MULTIPLE", 32))
    width = max(multiple, round(nominal_w / multiple) * multiple)
    height = max(multiple, round(nominal_h / multiple) * multiple)
    return width, height


def scaled_canvas(aspect_ratio: str, short_edge: int) -> tuple[int, int]:
    """Lower-resolution convenience canvas using the same H3 aspect/area policy."""
    ratio_w, ratio_h = _ratio(aspect_ratio)
    return _scaled_canvas_ratio(ratio_w, ratio_h, short_edge)


def canvas_for_source(canvas: dict[str, Any] | None, source_w: int, source_h: int) -> tuple[int, int]:
    """Resolve a non-custom canvas from a keyframe aspect ratio.

    MiniMax's published I2VA local request uses short_edge=768 with
    aspect_ratio=auto. ComfyUI core accepts explicit width/height, so this
    wrapper derives the equivalent 32-aligned canvas before delegating.
    """
    values = canvas if isinstance(canvas, dict) else {}
    selected = _selected(values, "canvas", DEFAULT_CANVAS)
    if selected == CANVAS_AUDIO_PROXY:
        return AUDIO_PROXY_WIDTH, AUDIO_PROXY_HEIGHT
    if selected == CANVAS_CUSTOM:
        return resolve_canvas(values)
    if source_w <= 0 or source_h <= 0:
        raise ValueError("First/last-frame aspect matching needs a connected, non-empty frame image.")
    if selected == CANVAS_NATIVE:
        return h3.adapt_canvas(source_w, source_h)
    scaled = {CANVAS_704: 704, CANVAS_640: 640, CANVAS_576: 576, CANVAS_512: 512}
    if selected in scaled:
        return _scaled_canvas_ratio(source_w, source_h, scaled[selected])
    allowed = [CANVAS_NATIVE, CANVAS_704, CANVAS_640, CANVAS_576, CANVAS_512, CANVAS_AUDIO_PROXY, CANVAS_CUSTOM]
    raise ValueError(f"Unknown output resolution {selected!r}. Choose one of: {', '.join(repr(value) for value in allowed)}.")


def align_canvas(value: int | float) -> int:
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Output width and height must be finite positive numbers.") from exc
    if not math.isfinite(numeric) or numeric <= 0:
        raise ValueError("Output width and height must be finite positive numbers.")
    return max(h3.CANVAS_MULTIPLE, round(numeric / h3.CANVAS_MULTIPLE) * h3.CANVAS_MULTIPLE)


def resolve_canvas(canvas: dict[str, Any] | None) -> tuple[int, int]:
    values = canvas if isinstance(canvas, dict) else {}
    selected = _selected(values, "canvas", DEFAULT_CANVAS)
    if selected == CANVAS_AUDIO_PROXY:
        return AUDIO_PROXY_WIDTH, AUDIO_PROXY_HEIGHT
    if selected == CANVAS_CUSTOM:
        return align_canvas(values.get("width", DEFAULT_CUSTOM_WIDTH)), align_canvas(values.get("height", DEFAULT_CUSTOM_HEIGHT))
    aspect_ratio = str(values.get("aspect_ratio", DEFAULT_ASPECT_RATIO))
    if selected == CANVAS_NATIVE:
        return native_canvas(aspect_ratio)
    scaled = {CANVAS_704: 704, CANVAS_640: 640, CANVAS_576: 576, CANVAS_512: 512}
    if selected in scaled:
        return scaled_canvas(aspect_ratio, scaled[selected])
    allowed = [CANVAS_NATIVE, CANVAS_704, CANVAS_640, CANVAS_576, CANVAS_512, CANVAS_AUDIO_PROXY, CANVAS_CUSTOM]
    raise ValueError(f"Unknown output resolution {selected!r}. Choose one of: {', '.join(repr(value) for value in allowed)}.")


def _generation_seconds(seconds: float) -> float:
    try:
        value = float(seconds)
    except (TypeError, ValueError) as exc:
        raise ValueError("Video duration must be a finite number between 1 and 30 seconds.") from exc
    if not math.isfinite(value) or value < 1.0 or value > 30.0:
        raise ValueError("Video duration must be a finite number between 1 and 30 seconds.")
    return value


def requested_length(seconds: float) -> int:
    # The model timeline is always 24 fps. The core H3 latent builder performs
    # the required 17k+5 upward snap from this requested frame count.
    return max(5, round(_generation_seconds(seconds) * h3.FPS))


def resolved_timing(seconds: float) -> tuple[int, float, int]:
    requested = requested_length(seconds)
    frame_count, _latent_t, _audio_t = h3.temporal_shape(requested)
    return frame_count, frame_count / h3.FPS, requested


def resolve_playback_fps(value: float = DEFAULT_PLAYBACK_FPS) -> float:
    try:
        fps = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Output playback FPS must be a finite number from 1 through 120.") from exc
    if not math.isfinite(fps) or fps < 1.0 or fps > 120.0:
        raise ValueError("Output playback FPS must be a finite number from 1 through 120.")
    return fps


def _validate_native_prompt_references(
    prompt: str,
    image_count: int,
    video_count: int = 0,
    audio_count: int = 0,
    *,
    reference_mode: bool,
) -> None:
    for match in NATIVE_MEDIA_TOKEN_RE.finditer(str(prompt or "")):
        raw_kind = match.group("kind").lower()
        kind = "image" if raw_kind == "picture" else raw_kind
        index = int(match.group("index"))
        token = match.group(0)
        if index <= 0:
            raise ValueError(f"{token} is invalid: H3 reference numbering is 1-based.")
        if not reference_mode and kind != "image":
            raise ValueError(f"{token} requires connected Reference inputs. With only first/last-frame inputs, H3 exposes <Picture N> endpoint frames only.")
        if kind == "subject":
            continue
        limit = image_count if kind == "image" else video_count if kind == "video" else audio_count
        if index > limit:
            noun = "frame image" if not reference_mode and kind == "image" else f"reference {kind}"
            raise ValueError(f"{token} does not resolve: only {limit} {noun}(s) are connected/presented.")


def _compile_base_prompt(prompt: str, keyframe_count: int, keyframe_role: str) -> str:
    prompt = ANGLE_IMAGE_ALIAS_RE.sub(lambda match: f"@Image{int(match.group('index'))}", str(prompt or ""))
    if re.search(r"@(Video|Audio|Subject)\d+\b", prompt, re.IGNORECASE):
        raise ValueError("@VideoN, @AudioN and @SubjectN require connected Reference inputs.")

    if keyframe_count > 2:
        raise ValueError("First/last-frame conditioning accepts at most two endpoint images.")

    picture_map: dict[int, int] = {}
    if keyframe_count == 1:
        picture_map = {1: 1}
    elif keyframe_count == 2:
        picture_map = {1: 2, 2: 1} if keyframe_role == KEYFRAME_LAST else {1: 1, 2: 2}

    def replace(match: re.Match[str]) -> str:
        kind = match.group("kind").lower()
        index = int(match.group("index"))
        if kind != "image":
            return match.group(0)
        if index not in picture_map:
            raise ValueError(f"@Image{index} does not resolve: only {keyframe_count} first/last frame image(s) are connected.")
        return f"<Picture {picture_map[index]}>"

    compiled = MEDIA_TOKEN_RE.sub(replace, str(prompt or ""))
    _validate_native_prompt_references(compiled, keyframe_count, reference_mode=False)
    return compiled


def _audio_duration_seconds(name: str, audio: Any) -> float:
    if not isinstance(audio, dict):
        raise ValueError(f"{name} is not a valid ComfyUI AUDIO value.")
    waveform = audio.get("waveform")
    sample_rate = audio.get("sample_rate")
    # Core MiniMax H3 expects ComfyUI AUDIO waveforms in [batch, channels, samples]
    # shape and moves the channel axis during conditioning. Catch malformed custom/API
    # inputs here instead of letting that fail later inside the core node.
    if (
        not isinstance(waveform, torch.Tensor)
        or waveform.ndim != 3
        or any(int(size) <= 0 for size in waveform.shape)
    ):
        raise ValueError(f"{name} must contain a non-empty ComfyUI AUDIO waveform shaped [batch, channels, samples].")
    if int(waveform.shape[0]) != 1:
        raise ValueError(
            f"{name} contains an audio batch of {int(waveform.shape[0])}. "
            "ComfyUI H3 encodes only the first batch item. Supply one audio clip per reference-audio input instead."
        )
    if int(waveform.shape[1]) not in (1, 2):
        raise ValueError(
            f"{name} has {int(waveform.shape[1])} audio channels. MiniMax H3 reference audio is mono or stereo; "
            "downmix multichannel audio upstream before connecting it."
        )
    try:
        sr = float(sample_rate)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} has no valid sample rate.") from exc
    if not math.isfinite(sr) or sr <= 0:
        raise ValueError(f"{name} has no valid sample rate.")
    return int(waveform.shape[-1]) / sr


def _prepare_reference_audio_group(group, prefix: str, max_duration: float):
    """Mirror the released H3 reference-audio normalization before core encoding.

    Source-duration validation happens before this helper. We only perform the
    parts current ComfyUI core does not: truncate at the source sample rate to
    the generated duration and expand mono to stereo. Core then performs its
    existing single resample into the AudioVAE's own sample rate.
    """
    prepared: dict[str, Any] = {}
    records: dict[str, dict[str, Any]] = {}
    for name, audio in _values_sorted(group, prefix):
        # _audio_duration_seconds also validates batch/channel/rate shape.
        source_duration = _audio_duration_seconds(name, audio)
        waveform = audio["waveform"]
        sample_rate = float(audio["sample_rate"])
        max_samples = max(1, int(float(max_duration) * sample_rate))
        used_samples = min(int(waveform.shape[-1]), max_samples)
        normalized = waveform[..., :used_samples]
        mono_upmixed = int(normalized.shape[1]) == 1
        if mono_upmixed:
            normalized = normalized.expand(-1, 2, -1).contiguous()
        copied = dict(audio)
        copied["waveform"] = normalized
        prepared[name] = copied
        records[name] = {
            "source_duration": source_duration,
            "used_duration": used_samples / sample_rate,
            "source_channels": int(waveform.shape[1]),
            "used_channels": int(normalized.shape[1]),
            "sample_rate": int(round(sample_rate)),
            "mono_upmixed": mono_upmixed,
            "trimmed": used_samples < int(waveform.shape[-1]),
        }
    return prepared, records


def _parse_reference_video_fps(raw: Any, label: str = "Reference video input FPS") -> float:
    try:
        fps = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a finite positive number.") from exc
    if not math.isfinite(fps) or fps <= 0 or fps > 240:
        raise ValueError(f"{label} must be a finite number above 0 and no greater than 240.")
    return fps


def _reference_video_fps(mode: dict[str, Any] | None) -> float:
    """Backward-compatible accessor for Video 1 and the legacy shared source rate."""
    values = mode if isinstance(mode, dict) else {}
    return _parse_reference_video_fps(values.get("ref_video_fps", DEFAULT_REF_VIDEO_FPS), "Video 1 source FPS")


def _reference_video_fps_override(raw: Any, label: str) -> float | None:
    """Parse a per-video source FPS; zero intentionally means use Video 1."""
    try:
        fps = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be 0 (inherit) or a finite positive number.") from exc
    if not math.isfinite(fps) or fps < 0 or fps > 240:
        raise ValueError(f"{label} must be 0 (inherit) or a finite number above 0 and no greater than 240.")
    if fps == 0:
        return None
    return _parse_reference_video_fps(fps, label)


def _reference_video_fps_by_name(mode: dict[str, Any] | None, ref_videos) -> dict[str, float]:
    """Resolve represented FPS in visible Video order while preserving legacy shared-FPS workflows."""
    values = mode if isinstance(mode, dict) else {}
    fallback = _reference_video_fps(values)
    override_ids = ("ref_video_fps_2", "ref_video_fps_3")
    result: dict[str, float] = {}
    for ordinal, (name, _frames) in enumerate(_values_sorted(ref_videos, "ref_video_"), start=1):
        if ordinal == 1:
            result[name] = fallback
            continue
        override_id = override_ids[min(ordinal - 2, len(override_ids) - 1)]
        override = _reference_video_fps_override(values.get(override_id, DEFAULT_REF_VIDEO_FPS_OVERRIDE), f"Video {ordinal} source FPS")
        result[name] = fallback if override is None else override
    return result


def _reference_video_size(mode: dict[str, Any] | None) -> str:
    values = mode if isinstance(mode, dict) else {}
    selected = str(values.get("ref_video_size", DEFAULT_REF_VIDEO_SIZE))
    aliases = {
        "native": REF_VIDEO_NATIVE, "768": REF_VIDEO_NATIVE, "640": REF_VIDEO_640, "576": REF_VIDEO_576, "512": REF_VIDEO_512,
        LEGACY_REF_VIDEO_NATIVE: REF_VIDEO_NATIVE, LEGACY_REF_VIDEO_640: REF_VIDEO_640,
        LEGACY_REF_VIDEO_576: REF_VIDEO_576, LEGACY_REF_VIDEO_512: REF_VIDEO_512,
    }
    selected = aliases.get(selected, selected)
    allowed = {REF_VIDEO_NATIVE, REF_VIDEO_640, REF_VIDEO_576, REF_VIDEO_512}
    if selected not in allowed:
        raise ValueError(f"Unknown Reference video size {selected!r}. Choose one of: {', '.join(repr(v) for v in allowed)}.")
    return selected


def _reference_video_temporal_fit(mode: dict[str, Any] | None) -> str:
    values = mode if isinstance(mode, dict) else {}
    selected = str(values.get("ref_video_temporal_fit", DEFAULT_REF_VIDEO_TEMPORAL_FIT))
    aliases = {
        "core": REF_VIDEO_TEMPORAL_CORE,
        "trim": REF_VIDEO_TEMPORAL_CORE,
        "hold": REF_VIDEO_TEMPORAL_HOLD,
        "preserve": REF_VIDEO_TEMPORAL_HOLD,
        LEGACY_REF_VIDEO_TEMPORAL_CORE: REF_VIDEO_TEMPORAL_CORE,
        LEGACY_REF_VIDEO_TEMPORAL_HOLD: REF_VIDEO_TEMPORAL_HOLD,
    }
    selected = aliases.get(selected, selected)
    allowed = {REF_VIDEO_TEMPORAL_CORE, REF_VIDEO_TEMPORAL_HOLD}
    if selected not in allowed:
        raise ValueError(
            f"Unknown reference video end handling {selected!r}. Choose "
            f"{REF_VIDEO_TEMPORAL_CORE!r} or {REF_VIDEO_TEMPORAL_HOLD!r}."
        )
    return selected


def _reference_vae_frame_count_up(frame_count: int) -> int:
    n = max(5, int(frame_count))
    while n % 17 != 5:
        n += 1
    return n


def _resampled_reference_frame_count(frame_count: int, source_fps: float, target_fps: float = 24.0) -> int:
    return max(0, int(math.floor(int(frame_count) * target_fps / source_fps + 0.5)))


def _reference_vae_frame_count(frame_count: int) -> int:
    """Exact snap-down used by current ComfyUI / official H3 reference encoding."""
    n = int(frame_count)
    if n < 5:
        return n
    while n % 17 != 5:
        n -= 1
    return n


def _resample_reference_video_fps(
    frames: torch.Tensor,
    source_fps: float,
    target_fps: float = 24.0,
    *,
    max_frames: int | None = None,
) -> torch.Tensor:
    """Nearest/hold CFR resample matching the current MiniMax/HF reference normalizer.

    max_frames is applied after the CFR conversion, exactly where the official
    normalizer truncates to the generated timeline. Limiting the index list before
    index_select avoids materializing high-resolution frames that H3 would discard.
    """
    if abs(source_fps - target_fps) < 1e-9:
        return frames if max_frames is None else frames[:max_frames]
    n = int(frames.shape[0])
    scale = target_fps / source_fps
    slots = torch.floor(torch.arange(n, dtype=torch.float64) * scale + 0.5).to(torch.long)
    end = int(math.floor(n * scale + 0.5))
    counts = torch.diff(torch.cat([slots, torch.tensor([end], dtype=torch.long)]))
    indices = torch.repeat_interleave(torch.arange(n, dtype=torch.long), counts.clamp_min(0))
    if max_frames is not None:
        indices = indices[:max_frames]
    if indices.numel() == 0:
        raise ValueError(f"Reference video at {source_fps:g} fps becomes empty when resampled to {target_fps:g} fps.")
    return frames.index_select(0, indices.to(frames.device))


def _reference_video_target(width: int, height: int, size_mode: str) -> tuple[int, int]:
    if size_mode == REF_VIDEO_NATIVE:
        target_w, target_h = h3.adapt_canvas(width, height)
    else:
        short = {REF_VIDEO_640: 640, REF_VIDEO_576: 576, REF_VIDEO_512: 512}[size_mode]
        target_w, target_h = _scaled_canvas_ratio(width, height, short)
    # Match core H3's no-upscale behavior for video references.
    if width * height < target_w * target_h:
        multiple = int(getattr(h3, "CANVAS_MULTIPLE", 32))
        target_w = max(multiple, round(width / multiple) * multiple)
        target_h = max(multiple, round(height / multiple) * multiple)
    return target_w, target_h


def _resize_reference_video(frames: torch.Tensor, width: int, height: int) -> torch.Tensor:
    source_h, source_w = int(frames.shape[1]), int(frames.shape[2])
    if (source_w, source_h) == (width, height):
        return frames
    samples = frames[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled")
    return samples.movedim(1, -1)


def _prepare_reference_videos(
    ref_videos,
    source_fps_by_name: dict[str, float],
    size_mode: str,
    generated_frame_count: int,
    temporal_fit: str = REF_VIDEO_TEMPORAL_CORE,
):
    prepared: dict[str, torch.Tensor] = {}
    records: dict[str, dict[str, Any]] = {}
    for name, frames in _values_sorted(ref_videos, "ref_video_"):
        source_fps = float(source_fps_by_name.get(name, h3.FPS))
        if not isinstance(frames, torch.Tensor) or frames.ndim != 4:
            prepared[name] = frames
            continue
        source_frames = int(frames.shape[0])
        source_h, source_w = int(frames.shape[1]), int(frames.shape[2])
        normalized_total_frames = _resampled_reference_frame_count(source_frames, source_fps, float(h3.FPS))
        timeline_frames = min(normalized_total_frames, int(generated_frame_count))
        core_aligned_frames = _reference_vae_frame_count(timeline_frames)
        if core_aligned_frames < 5:
            # Let the backend validator/core produce the authoritative short-reference error.
            core_aligned_frames = timeline_frames
        hold_frames = 0
        if temporal_fit == REF_VIDEO_TEMPORAL_HOLD and timeline_frames >= 5:
            aligned_frames = min(_reference_vae_frame_count_up(timeline_frames), int(generated_frame_count))
            # generated_frame_count is itself 17k+5. If timeline_frames is shorter,
            # the next valid reference length is therefore always reachable.
            source_needed = timeline_frames
            hold_frames = max(0, aligned_frames - timeline_frames)
        else:
            aligned_frames = core_aligned_frames
            source_needed = aligned_frames
        # Official order is FPS normalization -> target-timeline truncation -> VAE
        # snap-down. Core-exact mode reproduces that. Endpoint-preserve mode is an
        # explicit wrapper option: retain every source-timeline frame, then repeat
        # the last frame just enough to reach the next valid 17k+5 reference length.
        normalized = _resample_reference_video_fps(
            frames, source_fps, float(h3.FPS), max_frames=max(0, source_needed)
        )
        if hold_frames and normalized.shape[0] > 0:
            normalized = torch.cat([normalized, normalized[-1:].expand(hold_frames, -1, -1, -1)], dim=0)
        target_w, target_h = _reference_video_target(source_w, source_h, size_mode)
        # Native mode delegates spatial normalization to core H3. Draft modes pre-downscale so core's no-upscale branch preserves the cheaper reference geometry.
        if size_mode != REF_VIDEO_NATIVE and source_w * source_h > target_w * target_h:
            normalized = _resize_reference_video(normalized, target_w, target_h)
        prepared[name] = normalized
        native_w, native_h = _reference_video_target(source_w, source_h, REF_VIDEO_NATIVE)
        records[name] = {
            "source_frames": source_frames,
            "source_fps": source_fps,
            "source_w": source_w,
            "source_h": source_h,
            "normalized_total_frames": normalized_total_frames,
            "timeline_frames": timeline_frames,
            "aligned_frames": aligned_frames,
            "core_aligned_frames": core_aligned_frames,
            "hold_frames": hold_frames,
            "temporal_fit": temporal_fit,
            "prepared_w": int(normalized.shape[2]),
            "prepared_h": int(normalized.shape[1]),
            "target_w": target_w,
            "target_h": target_h,
            "native_w": native_w,
            "native_h": native_h,
            "size_mode": size_mode,
        }
    return prepared, records


def _validate_reference_inputs(
    ref_images,
    ref_videos,
    ref_video_audios,
    ref_audios,
    *,
    video_fps_by_name: dict[str, float] | None = None,
) -> tuple[int, int, int]:
    images = _values_sorted(ref_images, "ref_image_")
    videos = _values_sorted(ref_videos, "ref_video_")
    video_audio = dict(_values_sorted(ref_video_audios, "ref_video_audio_"))
    standalone_audio = _values_sorted(ref_audios, "ref_audio_")

    # Orphan paired-audio inputs are almost certainly wiring mistakes. Core H3
    # silently ignores them because it only looks them up while iterating videos;
    # Easy surfaces the mistake instead.
    connected_video_suffixes = {name.rsplit("_", 1)[-1] for name, _ in videos}
    for audio_name in video_audio:
        if audio_name.rsplit("_", 1)[-1] not in connected_video_suffixes:
            raise ValueError(f"{audio_name} is connected without its same-numbered reference video.")

    paired_audio: list[tuple[str, Any]] = []
    for video_name, _video in videos:
        suffix = video_name.rsplit("_", 1)[-1]
        audio_name = f"ref_video_audio_{suffix}"
        audio = video_audio.get(audio_name)
        if audio is not None:
            paired_audio.append((audio_name, audio))

    audio_items = paired_audio + standalone_audio
    image_count = len(images)
    video_count = len(videos)
    audio_count = len(audio_items)

    for ordinal, (_name, image) in enumerate(images, start=1):
        if (
            not isinstance(image, torch.Tensor)
            or image.ndim != 4
            or any(int(size) <= 0 for size in image.shape)
            or int(image.shape[-1]) < 3
        ):
            raise ValueError(f"Reference image {ordinal} must be a non-empty IMAGE batch shaped [batch, height, width, channels] with at least 3 channels.")
        if int(image.shape[0]) != 1:
            raise ValueError(
                f"Reference image {ordinal} contains a batch of {int(image.shape[0])} images. "
                "ComfyUI H3 uses only the first image from each reference-image socket. Split the batch and connect one image per Reference Image input instead."
            )

    video_fps_by_name = video_fps_by_name or {}
    for ordinal, (video_name, frames) in enumerate(videos, start=1):
        if (
            not isinstance(frames, torch.Tensor)
            or frames.ndim != 4
            or any(int(size) <= 0 for size in frames.shape)
            or int(frames.shape[-1]) < 3
        ):
            raise ValueError(f"Reference video {ordinal} must be a non-empty IMAGE frame batch shaped [frames, height, width, channels] with at least 3 channels.")
        source_fps = float(video_fps_by_name.get(video_name, h3.FPS))
        normalized_frames = _resampled_reference_frame_count(int(frames.shape[0]), source_fps, float(h3.FPS))
        # Current ComfyUI core itself rejects fewer than five reference-video
        # frames. Keep this technical requirement hard; published duration/count
        # envelopes are reported later as experimental warnings instead.
        if normalized_frames < 5:
            duration = int(frames.shape[0]) / source_fps
            raise ValueError(
                f"Reference video {ordinal} becomes only {normalized_frames} frame(s) on H3's 24 fps grid "
                f"({duration:.3f} s source). Current ComfyUI H3 requires at least 5 reference-video frames."
            )

    # Keep only shape/rate validation hard for audio. Current core can construct
    # standalone audio-only reference blocks, so MiniMax's published modality
    # and duration envelope is advisory for experimental cross-routing.
    for name, audio in audio_items:
        _audio_duration_seconds(name, audio)

    return image_count, video_count, audio_count


def _compile_reference_prompt(prompt: str, image_count: int, video_count: int, audio_count: int) -> str:
    prompt = ANGLE_IMAGE_ALIAS_RE.sub(lambda match: f"@Image{int(match.group('index'))}", str(prompt or ""))

    def replace(match: re.Match[str]) -> str:
        kind = match.group("kind").lower()
        index = int(match.group("index"))
        if index <= 0:
            raise ValueError("Reference numbering is 1-based.")
        if kind == "subject":
            return f"<Subject {index}>"
        if kind == "image":
            if index > image_count:
                raise ValueError(f"@Image{index} does not resolve: only {image_count} reference image(s) are connected.")
            return f"<Picture {index}>"
        if kind == "video":
            if index > video_count:
                raise ValueError(f"@Video{index} does not resolve: only {video_count} reference video(s) are connected.")
            return f"<Video {index}>"
        if kind == "audio":
            if index > audio_count:
                raise ValueError(f"@Audio{index} does not resolve: only {audio_count} presented audio reference(s) are connected.")
            return f"<Audio {index}>"
        return match.group(0)

    compiled = MEDIA_TOKEN_RE.sub(replace, str(prompt or ""))
    _validate_native_prompt_references(
        compiled, image_count, video_count, audio_count, reference_mode=True
    )
    return compiled


def _keyframes_from_group(keyframes: dict[str, Any] | None, role: str):
    values = [value for _name, value in _values_sorted(keyframes, "keyframe_")]
    if len(values) > 2:
        raise ValueError("First/last-frame conditioning accepts at most two endpoint images.")
    for ordinal, image in enumerate(values, start=1):
        if (
            not isinstance(image, torch.Tensor)
            or image.ndim != 4
            or any(int(size) <= 0 for size in image.shape)
            or int(image.shape[-1]) < 3
        ):
            raise ValueError(
                f"Frame image {ordinal} must be a non-empty IMAGE batch shaped "
                "[batch, height, width, channels] with at least 3 channels."
            )
        if int(image.shape[0]) != 1:
            raise ValueError(
                f"Frame image {ordinal} contains a batch of {int(image.shape[0])} images. "
                "ComfyUI H3 uses only the first image from each first/last-frame socket. Split the batch and connect exactly one image per input."
            )
    if not values:
        return None, None, 0
    if len(values) == 1:
        return (None, values[0], 1) if role == KEYFRAME_LAST else (values[0], None, 1)
    return (values[1], values[0], 2) if role == KEYFRAME_LAST else (values[0], values[1], 2)




def _keyframe_canvas_policy(mode: dict[str, Any] | None) -> str:
    values = mode if isinstance(mode, dict) else {}
    selected = str(values.get("keyframe_canvas", DEFAULT_KEYFRAME_CANVAS))
    selected = {
        LEGACY_KEYFRAME_CANVAS_ADAPTIVE: KEYFRAME_CANVAS_ADAPTIVE,
        LEGACY_KEYFRAME_CANVAS_V2: KEYFRAME_CANVAS_ADAPTIVE,
        LEGACY_KEYFRAME_CANVAS_FIXED: KEYFRAME_CANVAS_FIXED,
    }.get(selected, selected)
    if selected not in {KEYFRAME_CANVAS_ADAPTIVE, KEYFRAME_CANVAS_FIXED}:
        raise ValueError(
            f"Unknown output aspect source {selected!r}. Choose "
            f"{KEYFRAME_CANVAS_ADAPTIVE!r} or {KEYFRAME_CANVAS_FIXED!r}."
        )
    return selected


def _endpoint_resize_policy(mode: dict[str, Any] | None, key: str, default: str, label: str) -> str:
    values = mode if isinstance(mode, dict) else {}
    selected = str(values.get(key, default))
    allowed = {FIRST_FRAME_FIT_PAD, FIRST_FRAME_FIT_CROP, FIRST_FRAME_FIT_STRETCH}
    aliases = {
        "auto": FIRST_FRAME_FIT_PAD,
        "pad": FIRST_FRAME_FIT_PAD,
        "crop": FIRST_FRAME_FIT_CROP,
        "stretch": FIRST_FRAME_FIT_STRETCH,
        LEGACY_FIRST_FRAME_FIT_AUTO: FIRST_FRAME_FIT_PAD,
        LEGACY_FIRST_FRAME_FIT_PAD: FIRST_FRAME_FIT_PAD,
        LEGACY_FIRST_FRAME_FIT_CROP: FIRST_FRAME_FIT_CROP,
        LEGACY_FIRST_FRAME_FIT_STRETCH: FIRST_FRAME_FIT_STRETCH,
    }
    selected = aliases.get(selected, selected)
    if selected not in allowed:
        raise ValueError(
            f"Unknown {label} fit {selected!r}. Choose one of: "
            + ", ".join(repr(value) for value in allowed)
            + "."
        )
    return selected


def _first_frame_resize_policy(mode: dict[str, Any] | None) -> str:
    return _endpoint_resize_policy(mode, "first_frame_resize", DEFAULT_FIRST_FRAME_RESIZE, "first-frame")


def _last_frame_resize_policy(mode: dict[str, Any] | None) -> str:
    return _endpoint_resize_policy(mode, "last_frame_resize", DEFAULT_LAST_FRAME_RESIZE, "last-frame")


def _to_nchw(image: torch.Tensor) -> torch.Tensor:
    return image.permute(0, 3, 1, 2).contiguous()


def _to_nhwc(image: torch.Tensor) -> torch.Tensor:
    return image.permute(0, 2, 3, 1).contiguous()


def _resample_nchw(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    return F.interpolate(image, size=(height, width), mode="bilinear", align_corners=False)


def _fit_pad_endpoint(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    source_w, source_h = _keyframe_image_size(image) or (0, 0)
    scale = min(width / max(1, source_w), height / max(1, source_h))
    fitted_w = max(1, round(source_w * scale))
    fitted_h = max(1, round(source_h * scale))
    fitted = _resample_nchw(_to_nchw(image), fitted_w, fitted_h)
    pad_left = max(0, (width - fitted_w) // 2)
    pad_right = max(0, width - fitted_w - pad_left)
    pad_top = max(0, (height - fitted_h) // 2)
    pad_bottom = max(0, height - fitted_h - pad_top)
    padded = F.pad(fitted, (pad_left, pad_right, pad_top, pad_bottom), mode="replicate")
    return _to_nhwc(padded)


def _cover_crop_endpoint(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    source_w, source_h = _keyframe_image_size(image) or (0, 0)
    scale = max(width / max(1, source_w), height / max(1, source_h))
    fitted_w = max(width, round(source_w * scale))
    fitted_h = max(height, round(source_h * scale))
    fitted = _resample_nchw(_to_nchw(image), fitted_w, fitted_h)
    left = max(0, (fitted_w - width) // 2)
    top = max(0, (fitted_h - height) // 2)
    cropped = fitted[:, :, top:top + height, left:left + width]
    return _to_nhwc(cropped)


def _prepare_first_frame(image: torch.Tensor | None, width: int, height: int, policy: str) -> tuple[torch.Tensor | None, str | None]:
    if image is None:
        return None, None
    source_w, source_h = _keyframe_image_size(image) or (0, 0)
    if source_w == width and source_h == height:
        return image, None
    if policy == FIRST_FRAME_FIT_STRETCH:
        return image, None
    error = _aspect_error_percent(source_w, source_h, width, height)
    if error < 1.0:
        return image, None
    if policy == FIRST_FRAME_FIT_PAD:
        return _fit_pad_endpoint(image, width, height), "aspect-preserving fit with replicate-edge padding"
    return _cover_crop_endpoint(image, width, height), "aspect-preserving center crop"


def _prepare_last_frame(image: torch.Tensor | None, width: int, height: int, policy: str) -> tuple[torch.Tensor | None, str | None]:
    """Prefit the ending endpoint when Easy should override core H3's native center crop."""
    if image is None:
        return None, None
    source_w, source_h = _keyframe_image_size(image) or (0, 0)
    if source_w == width and source_h == height:
        return image, None
    error = _aspect_error_percent(source_w, source_h, width, height)
    if error < 1.0:
        return image, None
    if policy == FIRST_FRAME_FIT_CROP:
        # Core H3 already does the desired aspect-preserving cover crop.
        return image, None
    if policy == FIRST_FRAME_FIT_PAD:
        return _fit_pad_endpoint(image, width, height), "aspect-preserving fit with replicate-edge padding"
    stretched = _resample_nchw(_to_nchw(image), width, height)
    return _to_nhwc(stretched), "direct stretch to output dimensions"


def _keyframe_image_size(image: torch.Tensor | None) -> tuple[int, int] | None:
    if image is None:
        return None
    return int(image.shape[2]), int(image.shape[1])


def _aspect_error_percent(source_w: int, source_h: int, target_w: int, target_h: int) -> float:
    source_ratio = source_w / source_h
    target_ratio = target_w / target_h
    return abs(target_ratio / source_ratio - 1.0) * 100.0


def _output_aspect_warning(width: int, height: int) -> str | None:
    """Report an experimental output canvas outside current Diffusers' released-checkpoint ratio contract."""
    if width <= 0 or height <= 0:
        return None
    ratio = width / height
    if 0.25 <= ratio <= 4.0:
        return None
    return (
        f"Output aspect warning: {width}x{height} ({ratio:.3f}:1) is outside current Diffusers H3's "
        "1:4–4:1 released-checkpoint canvas contract; Easy leaves current-ComfyUI experiments available."
    )


def _reference_image_aspect_warning(width: int, height: int, label: str) -> str | None:
    """Warn only for the released reference-image geometry envelope.

    Current Diffusers applies the released 1:4–4:1 geometry contract to both
    output canvases and reference images. Easy warns rather than capability-gating
    current-ComfyUI experiments outside that envelope.
    """
    if width <= 0 or height <= 0:
        return None
    ratio = width / height
    if 0.25 <= ratio <= 4.0:
        return None
    return (
        f"{label} aspect warning: {width}x{height} ({ratio:.3f}:1) is outside the released H3 reference-image "
        "1:4–4:1 envelope; current ComfyUI may still execute it experimentally."
    )


def keyframe_report(
    first_frame: torch.Tensor | None,
    last_frame: torch.Tensor | None,
    width: int,
    height: int,
    policy: str,
    canvas: dict[str, Any] | None,
    first_frame_resize: str,
    first_frame_prefit: str | None = None,
    last_frame_resize: str = DEFAULT_LAST_FRAME_RESIZE,
    last_frame_prefit: str | None = None,
) -> str:
    lines: list[str] = []
    selected_canvas = _selected(canvas if isinstance(canvas, dict) else {}, "canvas", DEFAULT_CANVAS)
    adaptive_active = policy == KEYFRAME_CANVAS_ADAPTIVE and selected_canvas != CANVAS_CUSTOM and (first_frame is not None or last_frame is not None)
    if adaptive_active:
        anchor = first_frame if first_frame is not None else last_frame
        anchor_name = "first frame" if first_frame is not None else "last frame"
        aw, ah = _keyframe_image_size(anchor) or (0, 0)
        lines.append(
            f"Output aspect: matched from {anchor_name} {aw}x{ah} -> {width}x{height} "
            f"(MiniMax-style auto aspect; 32px-aligned)."
        )
    elif selected_canvas == CANVAS_CUSTOM and policy == KEYFRAME_CANVAS_ADAPTIVE:
        lines.append("Output aspect: Custom exact dimensions override frame-aspect matching.")
    else:
        lines.append(f"Output aspect: selected output dimensions {width}x{height}.")

    output_aspect_warning = _output_aspect_warning(width, height)
    if output_aspect_warning:
        lines.append(output_aspect_warning)

    if first_frame is not None:
        sw, sh = _keyframe_image_size(first_frame) or (0, 0)
        error = _aspect_error_percent(sw, sh, width, height)
        if first_frame_prefit:
            lines.append(
                f"First frame: {sw}x{sh} -> wrapper {first_frame_prefit} -> {width}x{height}; "
                "core H3 then receives a canvas-matched opening frame (no stretch)."
            )
        else:
            action = "resize to canvas" if error < 1.0 else "stretch to canvas"
            lines.append(
                f"First frame: {sw}x{sh} -> {width}x{height}; ComfyUI H3 uses {action} "
                f"({error:.2f}% aspect-ratio delta)."
            )
            if error >= 1.0 and first_frame_resize == FIRST_FRAME_FIT_STRETCH:
                lines.append(
                    "First-frame fit: Stretch to output is selected, so the wrapper forwards the original first frame unchanged. "
                    "Switch this policy to a preserve-aspect option if you want the wrapper to prefit the opening frame before core H3 sees it."
                )
    if last_frame is not None:
        sw, sh = _keyframe_image_size(last_frame) or (0, 0)
        error = _aspect_error_percent(sw, sh, width, height)
        if last_frame_prefit:
            lines.append(
                f"Last frame: {sw}x{sh} -> wrapper {last_frame_prefit} -> {width}x{height}; "
                "core H3 then receives a canvas-matched ending frame (no additional crop)."
            )
        else:
            action = "resize to canvas" if error < 1.0 else "aspect-preserving center crop to canvas"
            lines.append(
                f"Last frame: {sw}x{sh} -> {width}x{height}; ComfyUI H3 uses {action} "
                f"({error:.2f}% aspect-ratio delta)."
            )
            if error >= 1.0 and last_frame_resize == FIRST_FRAME_FIT_CROP:
                lines.append(
                    "Ending-frame fit: Fill output (crop edges) is selected, matching current core H3 behavior. "
                    "Switch to Preserve full frame if you need the entire ending image retained inside the output canvas."
                )
    if first_frame is not None and last_frame is not None:
        fw, fh = _keyframe_image_size(first_frame) or (0, 0)
        lw, lh = _keyframe_image_size(last_frame) or (0, 0)
        endpoint_delta = abs((fw / fh) / (lw / lh) - 1.0) * 100.0
        if endpoint_delta >= 1.0:
            lines.append(
                f"Endpoint aspect mismatch: first {fw}x{fh}, last {lw}x{lh} ({endpoint_delta:.2f}% ratio difference). "
                "ComfyUI's one output canvas cannot preserve both endpoint aspect ratios without cropping, padding, or distortion."
            )
    return "\n".join(lines)


def _reference_image_target(image: torch.Tensor, width: int, height: int, mode: str) -> tuple[int, int]:
    image_h, image_w = int(image.shape[1]), int(image.shape[2])
    if _core_ref_image_size(mode) == "match":
        return _balanced_reference_image_target(image_w, image_h, width, height)
    else:
        scale = min(1.0, h3.REF_IMAGE_SHORT_EDGE / max(1, min(image_w, image_h)))
    target_w = max(h3.CANVAS_MULTIPLE, round(image_w * scale / h3.CANVAS_MULTIPLE) * h3.CANVAS_MULTIPLE)
    target_h = max(h3.CANVAS_MULTIPLE, round(image_h * scale / h3.CANVAS_MULTIPLE) * h3.CANVAS_MULTIPLE)
    return target_w, target_h


def _core_match_reference_target(width: int, height: int, target_area: int) -> tuple[int, int]:
    """Mirror core ComfyUI's ref-image ``match`` sizing for an aligned image."""
    multiple = int(getattr(h3, "CANVAS_MULTIPLE", 32))
    scale = min(1.0, math.sqrt(target_area / max(1, width * height)))
    target_w = max(multiple, round(width * scale / multiple) * multiple)
    target_h = max(multiple, round(height * scale / multiple) * multiple)
    return target_w, target_h


def _balanced_reference_image_target(
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
) -> tuple[int, int]:
    """Choose a 32-aligned reference size close to the generation pixel area.

    Core H3's ``match`` mode is downscale-only, so a small source otherwise
    contributes substantially fewer visual/reference tokens than a larger source.
    Easy deliberately normalizes both small and large image references toward the
    generation area before delegating to core.

    The returned geometry is also a fixed point of core's own ``match`` resize,
    preventing a second resize. We keep the canvas aspect within 5% of the source
    whenever possible, then prioritize closeness to the target area. The actual
    source image is fitted proportionally into this canvas and replicate-edge
    padded, so 32-pixel alignment never stretches body/object proportions.
    """
    multiple = int(getattr(h3, "CANVAS_MULTIPLE", 32))
    area = max(1, int(target_w) * int(target_h))
    ratio = max(1, int(source_w)) / max(1, int(source_h))

    ideal_w_cells = math.sqrt(area * ratio) / multiple
    ideal_h_cells = math.sqrt(area / ratio) / multiple
    search_radius = 12
    min_w_cells = max(1, int(math.floor(ideal_w_cells)) - search_radius)
    max_w_cells = max(min_w_cells, int(math.ceil(ideal_w_cells)) + search_radius)
    min_h_cells = max(1, int(math.floor(ideal_h_cells)) - search_radius)
    max_h_cells = max(min_h_cells, int(math.ceil(ideal_h_cells)) + search_radius)

    candidates: list[tuple[int, int, float, float]] = []
    for w_cells in range(min_w_cells, max_w_cells + 1):
        candidate_w = w_cells * multiple
        for h_cells in range(min_h_cells, max_h_cells + 1):
            candidate_h = h_cells * multiple
            if _core_match_reference_target(candidate_w, candidate_h, area) != (candidate_w, candidate_h):
                continue
            area_error = abs((candidate_w * candidate_h) / area - 1.0)
            aspect_error = abs(math.log((candidate_w / candidate_h) / ratio))
            padding_fraction = 1.0 - math.exp(-aspect_error)
            candidates.append((candidate_w, candidate_h, area_error, padding_fraction))

    if not candidates:
        # Defensive fallback. This should be unreachable for practical H3 canvas
        # sizes, but keep API/direct callers deterministic rather than failing.
        scale = math.sqrt(area / max(1, source_w * source_h))
        candidate_w = max(multiple, round(source_w * scale / multiple) * multiple)
        candidate_h = max(multiple, round(source_h * scale / multiple) * multiple)
        return _core_match_reference_target(candidate_w, candidate_h, area)

    low_padding = [item for item in candidates if item[3] <= 0.05]
    if not low_padding:
        low_padding = [item for item in candidates if item[3] <= 0.10]
    pool = low_padding if low_padding else candidates
    best_w, best_h, _area_error, _padding_fraction = min(pool, key=lambda item: (item[2], item[3]))
    return best_w, best_h


def _resize_reference_image(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Aspect-preserving fit with minimal replicate-edge padding to H3 alignment."""
    source_h, source_w = int(image.shape[1]), int(image.shape[2])
    if (source_w, source_h) == (width, height):
        return image[..., :3]
    scale = min(width / max(1, source_w), height / max(1, source_h))
    fitted_w = min(width, max(1, round(source_w * scale)))
    fitted_h = min(height, max(1, round(source_h * scale)))
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, fitted_w, fitted_h, "lanczos", "disabled")
    pad_left = max(0, (width - fitted_w) // 2)
    pad_right = max(0, width - fitted_w - pad_left)
    pad_top = max(0, (height - fitted_h) // 2)
    pad_bottom = max(0, height - fitted_h - pad_top)
    if pad_left or pad_right or pad_top or pad_bottom:
        samples = F.pad(samples, (pad_left, pad_right, pad_top, pad_bottom), mode="replicate")
    return samples.movedim(1, -1)


def _prepare_reference_images(ref_images, width: int, height: int, mode: str):
    """Equalize ``match`` image refs to the target area; leave ``max`` to core."""
    if _core_ref_image_size(mode) != "match":
        return _ordered_group(ref_images, "ref_image_")

    prepared: dict[str, torch.Tensor] = {}
    for name, image in _values_sorted(ref_images, "ref_image_"):
        if not isinstance(image, torch.Tensor) or image.ndim != 4:
            prepared[name] = image
            continue
        target_image_w, target_image_h = _reference_image_target(image, width, height, mode)
        prepared[name] = _resize_reference_image(image, target_image_w, target_image_h)
    return prepared


def _packed_visual_spatial_rows(width: int, height: int) -> int:
    """Exact rows per H3 visual latent step for current 16x VAE + 2x2 DiT patching."""
    return max(0, int(width) // 32) * max(0, int(height) // 32)


def _reference_video_latent_t(frame_count: int) -> int:
    """Mirror current core's reference-video VAE temporal latent count."""
    fn = getattr(h3, "video_latent_t", None)
    if callable(fn):
        return int(fn(int(frame_count)))
    n = int(frame_count)
    return 2 if n <= 5 else ((n - 5) // 17) * 5 + 2


def _published_reference_spec_deviations(
    ref_images,
    ref_videos,
    ref_video_audios,
    ref_audios,
    video_records: dict[str, dict[str, Any]] | None = None,
    audio_records: dict[str, dict[str, Any]] | None = None,
) -> list[str]:
    """Concise deviations from MiniMax's documented Ref2VA input envelope."""
    images = _values_sorted(ref_images, "ref_image_")
    videos = _values_sorted(ref_videos, "ref_video_")
    standalone = _values_sorted(ref_audios, "ref_audio_")
    video_records = video_records or {}
    audio_records = audio_records or {}

    # Paired soundtracks can receive their own <Audio N> presentation label,
    # but they are carried inside their video reference rather than constituting
    # a standalone audio input/file for the published count/duration envelope.
    deviations: list[str] = []
    if len(images) > REF_MAX_IMAGES:
        deviations.append(f"{len(images)} images > documented {REF_MAX_IMAGES}")
    if len(videos) > REF_MAX_VIDEOS:
        deviations.append(f"{len(videos)} videos > documented {REF_MAX_VIDEOS}")
    if len(standalone) > REF_MAX_AUDIOS:
        deviations.append(f"{len(standalone)} standalone audio clips > documented {REF_MAX_AUDIOS}")
    mixed_files = len(images) + len(videos) + len(standalone)
    if mixed_files > REF_MAX_FILES:
        deviations.append(f"{mixed_files} mixed files > documented {REF_MAX_FILES}")
    if not images and not videos and not standalone:
        deviations.append("no reference assets connected")
    elif standalone and not images and not videos:
        deviations.append("audio-only reference input")

    video_durations: list[float] = []
    for ordinal, (name, frames) in enumerate(videos, start=1):
        rec = video_records.get(name, {})
        source_frames = int(rec.get("source_frames", frames.shape[0] if isinstance(frames, torch.Tensor) else 0))
        source_fps = float(rec.get("source_fps", h3.FPS))
        duration = source_frames / source_fps if source_fps > 0 else 0.0
        video_durations.append(duration)
        if duration < REF_CLIP_SECONDS_MIN or duration > REF_CLIP_SECONDS_MAX:
            deviations.append(f"Video {ordinal} {duration:.2f}s outside documented {REF_CLIP_SECONDS_MIN:g}-{REF_CLIP_SECONDS_MAX:g}s")
    video_total = sum(video_durations)
    if video_total > REF_TOTAL_VIDEO_SECONDS_MAX + 1e-9:
        deviations.append(f"video total {video_total:.2f}s > documented {REF_TOTAL_VIDEO_SECONDS_MAX:g}s")

    audio_durations: list[float] = []
    for ordinal, (name, audio) in enumerate(standalone, start=1):
        rec = audio_records.get(name, {})
        duration = float(rec["source_duration"]) if "source_duration" in rec else _audio_duration_seconds(name, audio)
        audio_durations.append(duration)
        if duration < REF_CLIP_SECONDS_MIN or duration > REF_CLIP_SECONDS_MAX:
            deviations.append(f"Audio {ordinal} {duration:.2f}s outside documented {REF_CLIP_SECONDS_MIN:g}-{REF_CLIP_SECONDS_MAX:g}s")
    audio_total = sum(audio_durations)
    if audio_total > REF_TOTAL_AUDIO_SECONDS_MAX + 1e-9:
        deviations.append(f"audio total {audio_total:.2f}s > documented {REF_TOTAL_AUDIO_SECONDS_MAX:g}s")
    return deviations


def reference_report(
    ref_images,
    ref_videos,
    ref_video_audios,
    ref_audios,
    width: int,
    height: int,
    ref_image_size: str,
    frame_count: int,
    video_records: dict[str, dict[str, Any]] | None = None,
    audio_records: dict[str, dict[str, Any]] | None = None,
) -> str:
    lines: list[str] = []
    visual_budgets: list[tuple[str, int]] = []

    output_aspect_warning = _output_aspect_warning(width, height)
    if output_aspect_warning:
        lines.append(output_aspect_warning)

    spec_deviations = _published_reference_spec_deviations(
        ref_images, ref_videos, ref_video_audios, ref_audios, video_records, audio_records
    )
    if spec_deviations:
        lines.append(
            "Published Ref2VA envelope warning: " + "; ".join(spec_deviations)
            + ". Easy leaves technically accepted combinations available; quality is experimental."
        )

    # Current ComfyUI presents references in a fixed semantic order. Surface it
    # because prompt ordinals are per modality while audio ordinals span paired
    # video soundtracks plus standalone audio. This is useful when debugging
    # @AudioN / @VideoN mapping and conditioning ambiguity.
    presentation: list[str] = []
    image_items = _values_sorted(ref_images, "ref_image_")
    video_items = _values_sorted(ref_videos, "ref_video_")
    paired_items = dict(_values_sorted(ref_video_audios, "ref_video_audio_"))
    standalone_items = _values_sorted(ref_audios, "ref_audio_")
    for ordinal, _item in enumerate(image_items, start=1):
        presentation.append(f"<Picture {ordinal}>")
    presented_audio_ordinal = 0
    for ordinal, (video_name, _frames) in enumerate(video_items, start=1):
        suffix = video_name.rsplit("_", 1)[-1]
        if paired_items.get(f"ref_video_audio_{suffix}") is not None:
            presented_audio_ordinal += 1
            presentation.append(f"<Audio {presented_audio_ordinal}> (Video {ordinal} soundtrack)")
        presentation.append(f"<Video {ordinal}>")
    for _name, _audio in standalone_items:
        presented_audio_ordinal += 1
        presentation.append(f"<Audio {presented_audio_ordinal}> (standalone)")
    if presentation:
        lines.append("Reference presentation order: " + " -> ".join(presentation) + ".")

    for ordinal, (_name, image) in enumerate(image_items, start=1):
        if not isinstance(image, torch.Tensor) or image.ndim != 4:
            continue
        image_h, image_w = int(image.shape[1]), int(image.shape[2])
        target_w, target_h = _reference_image_target(image, width, height, ref_image_size)
        picture_rows = _packed_visual_spatial_rows(target_w, target_h)
        visual_budgets.append((f"Picture {ordinal}", picture_rows))
        lines.append(
            f"Picture {ordinal}: {image_w}x{image_h} -> {target_w}x{target_h} ({ref_image_size}); "
            f"{picture_rows:,} packed visual rows."
        )
        source_aspect_warning = _reference_image_aspect_warning(image_w, image_h, f"Picture {ordinal}")
        if source_aspect_warning:
            lines.append(source_aspect_warning)
        if _core_ref_image_size(ref_image_size) == "match":
            source_ratio = image_w / max(1, image_h)
            target_ratio = target_w / max(1, target_h)
            edge_fill = 1.0 - min(target_ratio / source_ratio, source_ratio / target_ratio)
            area_ratio = (target_w * target_h) / max(1, width * height)
            detail = f"{area_ratio * 100:.1f}% of target pixel area"
            if edge_fill > 0.0005:
                detail += f", {edge_fill * 100:.1f}% replicate-edge fill to preserve source proportions"
            else:
                detail += ", no meaningful alignment fill"
            lines.append(f"Picture {ordinal} balance: {detail}; core match leaves this geometry unchanged.")

    paired = paired_items
    audio_ordinal = 0
    video_records = video_records or {}
    audio_records = audio_records or {}
    for ordinal, (name, frames) in enumerate(_values_sorted(ref_videos, "ref_video_"), start=1):
        video_source_seconds: float | None = None
        if isinstance(frames, torch.Tensor) and frames.ndim == 4:
            video_h, video_w = int(frames.shape[1]), int(frames.shape[2])
            canvas_w, canvas_h = h3.adapt_canvas(video_w, video_h)
            if video_w * video_h < canvas_w * canvas_h:
                canvas_w = max(h3.CANVAS_MULTIPLE, round(video_w / h3.CANVAS_MULTIPLE) * h3.CANVAS_MULTIPLE)
                canvas_h = max(h3.CANVAS_MULTIPLE, round(video_h / h3.CANVAS_MULTIPLE) * h3.CANVAS_MULTIPLE)
            rec = video_records.get(name, {})
            source_fps = float(rec.get("source_fps", h3.FPS))
            source_frames = int(rec.get("source_frames", frames.shape[0]))
            source_seconds = source_frames / source_fps
            video_source_seconds = source_seconds
            normalized_total = int(rec.get("normalized_total_frames", frames.shape[0]))
            timeline_frames = int(rec.get("timeline_frames", min(normalized_total, frame_count)))
            n = int(rec.get("aligned_frames", _reference_vae_frame_count(timeline_frames)))
            core_n = int(rec.get("core_aligned_frames", _reference_vae_frame_count(timeline_frames)))
            hold_frames = int(rec.get("hold_frames", 0))
            temporal_fit = str(rec.get("temporal_fit", REF_VIDEO_TEMPORAL_CORE))
            normalized_seconds = normalized_total / float(h3.FPS)
            used_seconds = max(0, n) / float(h3.FPS)
            source_w = int(rec.get("source_w", video_w))
            source_h = int(rec.get("source_h", video_h))
            size_mode = str(rec.get("size_mode", REF_VIDEO_NATIVE))
            fps_text = (
                f"{source_frames}f @ {source_fps:g} fps -> {normalized_total}f @ 24 fps"
                if abs(source_fps - float(h3.FPS)) > 1e-9
                else f"{source_frames}f @ 24 fps"
            )
            aspect_delta = _aspect_error_percent(source_w, source_h, canvas_w, canvas_h)
            video_latent_t = _reference_video_latent_t(max(0, n))
            video_rows = video_latent_t * _packed_visual_spatial_rows(canvas_w, canvas_h)
            visual_budgets.append((f"Video {ordinal}", video_rows))
            lines.append(
                f"Video {ordinal}: source {source_w}x{source_h}, {fps_text}; H3 reference geometry {canvas_w}x{canvas_h} ({size_mode}), "
                f"aspect-ratio delta {aspect_delta:.2f}%. {max(0, n)} frames enter the reference VAE ({used_seconds:.3f} s); "
                f"{video_latent_t} visual latent steps = {video_rows:,} packed visual rows."
            )
            if aspect_delta >= 3.0:
                lines.append(
                    f"Video {ordinal} proportion warning: the reference geometry differs from the source aspect by {aspect_delta:.2f}%. "
                    "This can happen for small inputs because current ComfyUI avoids upscaling and rounds both axes to 32-pixel multiples. "
                    "Use a larger source or pre-resize upstream to a suitable 32-aligned geometry if body/shape proportions are important."
                )
            native_w = int(rec.get("native_w", canvas_w))
            native_h = int(rec.get("native_h", canvas_h))
            native_area = max(1, native_w * native_h)
            area_ratio = (canvas_w * canvas_h) / native_area
            if area_ratio < 0.995:
                lines.append(
                    f"Video {ordinal} spatial load: {area_ratio * 100:.1f}% of native 768-class reference area "
                    f"({canvas_w}x{canvas_h} vs {native_w}x{native_h}). This reduces visual reference tokens; whole-run speedup is workload-dependent."
                )
            output_trim = max(0, normalized_total - timeline_frames)
            align_trim = max(0, timeline_frames - core_n) if temporal_fit == REF_VIDEO_TEMPORAL_CORE else 0
            if output_trim:
                lines.append(
                    f"Video {ordinal} tail: {output_trim} normalized frames ({output_trim / float(h3.FPS):.3f} s) lie beyond the generated timeline and are not conditioned. "
                    "Trim/select the important motion upstream so it occurs inside the target duration."
                )
            if hold_frames:
                lines.append(
                    f"Video {ordinal} endpoint preserve: all {timeline_frames} timeline frames are retained, then the final frame is held for "
                    f"{hold_frames} frames ({hold_frames / float(h3.FPS):.3f} s) to reach the valid {n}f 17k+5 reference length. "
                    "This avoids core H3's tail drop without changing the source motion speed, but it is a wrapper strategy rather than the official/core normalization rule."
                )
            elif align_trim:
                lower = core_n
                upper = _reference_vae_frame_count_up(timeline_frames)
                lines.append(
                    f"Video {ordinal} VAE alignment: {align_trim} frames ({align_trim / float(h3.FPS):.3f} s) are dropped from the tail to reach H3's 17k+5 reference length. "
                    f"Effective reference endpoint is {used_seconds:.3f} s, not {normalized_seconds:.3f} s. "
                    f"For endpoint-critical motion, use {REF_VIDEO_TEMPORAL_HOLD} to keep the full source interval and hold its final frame to {upper}f ({upper / float(h3.FPS):.3f} s), "
                    f"or trim/retime upstream to a valid length such as {lower}f ({lower / float(h3.FPS):.3f} s)."
                )
                lines.append(
                    f"Video {ordinal} current-Comfy detail: its 2 fps Qwen/text-encoder view is sampled after this tail trim, so the dropped endpoint is absent from both "
                    f"the reference VAE path and Qwen's sampled presentation. {REF_VIDEO_TEMPORAL_HOLD} keeps that endpoint visible to both current ComfyUI conditioning paths."
                )
            qwen_frames = len(range(0, max(0, n), max(1, int(h3.FPS) // 2)))
            lines.append(f"Video {ordinal} text-encoder view: about {qwen_frames} sampled frames at 2 fps; the full aligned video also conditions through the visual VAE latents.")
        suffix = name.rsplit("_", 1)[-1]
        paired_audio = paired.get(f"ref_video_audio_{suffix}")
        if paired_audio is not None:
            audio_ordinal += 1
            audio_name = f"ref_video_audio_{suffix}"
            duration = _audio_duration_seconds(audio_name, paired_audio)
            sr = int(paired_audio["sample_rate"])
            rec_audio = audio_records.get(audio_name, {})
            source_duration = float(rec_audio.get("source_duration", duration))
            source_channels = int(rec_audio.get("source_channels", paired_audio["waveform"].shape[1]))
            details = []
            if rec_audio.get("trimmed"):
                details.append(f"source {source_duration:.3f} s -> {duration:.3f} s used (target-duration trim)")
            else:
                details.append(f"{duration:.3f} s used")
            if rec_audio.get("mono_upmixed"):
                details.append("mono -> stereo")
            lines.append(
                f"Audio {audio_ordinal}: soundtrack paired with Video {ordinal}, "
                + "; ".join(details)
                + f" @ {sr} Hz ({source_channels}ch source)."
            )
            if video_source_seconds is not None and source_duration > 0:
                sync_delta = abs(source_duration - video_source_seconds)
                sync_threshold = max(0.25, min(source_duration, video_source_seconds) * 0.05)
                if sync_delta > sync_threshold:
                    lines.append(
                        f"Video {ordinal} soundtrack duration warning: source video is {video_source_seconds:.3f} s but its paired audio is {source_duration:.3f} s "
                        f"(difference {sync_delta:.3f} s). Current H3 packs both at the same reference-time origin and advances later reference time by the longer stream; "
                        "align/trim them upstream when they are intended to be synchronized."
                    )

    if len(video_items) >= 2:
        ratios: list[float] = []
        sizes: list[str] = []
        for name, frames in video_items:
            rec = video_records.get(name, {})
            if isinstance(frames, torch.Tensor) and frames.ndim == 4:
                sw = int(rec.get("source_w", frames.shape[2]))
                sh = int(rec.get("source_h", frames.shape[1]))
                if sw > 0 and sh > 0:
                    ratios.append(sw / sh)
                    sizes.append(f"{sw}x{sh}")
        if len(ratios) >= 2:
            spread = (max(ratios) / min(ratios) - 1.0) * 100.0
            if spread >= 10.0:
                lines.append(
                    f"Video-reference framing note: source aspect ratios span {spread:.1f}% across {', '.join(sizes)}. "
                    "H3 normalizes each reference to its own 768-class geometry rather than forcing all refs to the output canvas, so differing pixel resolutions alone are not a stretch problem. "
                    "However, genuinely different crops/framing scales remain different visual evidence and can make a shared subject/motion relationship harder to interpret."
                )

    for name, audio in _values_sorted(ref_audios, "ref_audio_"):
        audio_ordinal += 1
        duration = _audio_duration_seconds(name, audio)
        sr = int(audio["sample_rate"])
        rec_audio = audio_records.get(name, {})
        source_duration = float(rec_audio.get("source_duration", duration))
        source_channels = int(rec_audio.get("source_channels", audio["waveform"].shape[1]))
        details = []
        if rec_audio.get("trimmed"):
            details.append(f"source {source_duration:.3f} s -> {duration:.3f} s used (target-duration trim)")
        else:
            details.append(f"{duration:.3f} s used")
        if rec_audio.get("mono_upmixed"):
            details.append("mono -> stereo")
        lines.append(
            f"Audio {audio_ordinal}: standalone reference, "
            + "; ".join(details)
            + f" @ {sr} Hz ({source_channels}ch source)."
        )

    if visual_budgets:
        total_rows = sum(rows for _label, rows in visual_budgets)
        nonzero_rows = [rows for _label, rows in visual_budgets if rows > 0]
        spread = (max(nonzero_rows) / min(nonzero_rows)) if nonzero_rows else 1.0
        budget_text = ", ".join(f"{label} {rows:,}" for label, rows in visual_budgets)
        summary = (
            f"Packed visual conditioning budget: {budget_text}; total {total_rows:,} rows. "
            "These are exact current-H3 packed visual context rows, not measured attention weights."
        )
        if spread > 1.05:
            summary += f" Largest/smallest visual block ratio: {spread:.1f}x."
        insert_at = 1 if presentation else 0
        lines.insert(insert_at, summary)
    return "\n".join(lines)


@dataclass(frozen=True)
class MiniMaxH3Context:
    conditioning: Any
    latent: Any
    video_vae: Any
    audio_vae: Any
    playback_fps: float
    compiled_prompt: str
    width: int
    height: int
    frame_count: int
    effective_seconds: float
    mode: str
    task: str
    diffusion_model: str
    reference_info: str = ""


def generate(bundle: MiniMaxH3Bundle, mode: dict[str, Any], prompt: str, canvas: dict[str, Any], seconds: float, playback_fps: float = DEFAULT_PLAYBACK_FPS):
    if not isinstance(bundle, MiniMaxH3Bundle):
        raise ValueError("Connect the H3 Bundle output from MiniMax H3 Easy Loader.")

    selected_mode = _selected(mode, "mode", DEFAULT_MODE)
    selected_mode = {
        LEGACY_MODE_REFERENCE: MODE_VIDEO,
        LEGACY_MODE_REFERENCE_V2: MODE_VIDEO,
        LEGACY_MODE_REFERENCE_V3: MODE_VIDEO,
        LEGACY_MODE_BASE: MODE_VIDEO,
        LEGACY_MODE_BASE_V2: MODE_VIDEO,
        LEGACY_MODE_AUDIO: MODE_AUDIO,
        LEGACY_MODE_AUDIO_V228: MODE_AUDIO,
        LEGACY_MODE_AUDIO_V229: MODE_AUDIO,
    }.get(selected_mode, selected_mode)
    if selected_mode not in {MODE_VIDEO, MODE_AUDIO}:
        raise ValueError(f"Unknown H3 output mode {selected_mode!r}. Choose {MODE_VIDEO!r} or {MODE_AUDIO!r}.")
    prompt = str(prompt or "")
    length = requested_length(seconds)
    frame_count, effective_seconds, _requested = resolved_timing(seconds)
    out_fps = DEFAULT_PLAYBACK_FPS if selected_mode == MODE_AUDIO else resolve_playback_fps(playback_fps)

    ref_images_connected = _ordered_group(mode.get("ref_images") or {}, "ref_image_")
    ref_videos_connected = _ordered_group(mode.get("ref_videos") or {}, "ref_video_")
    ref_video_audios_connected = _ordered_group(mode.get("ref_video_audios") or {}, "ref_video_audio_")
    ref_audios_connected = _ordered_group(mode.get("ref_audios") or {}, "ref_audio_")
    has_reference_inputs = any((ref_images_connected, ref_videos_connected, ref_video_audios_connected, ref_audios_connected))

    keyframe_role_for_route = str(mode.get("keyframe_role", DEFAULT_KEYFRAME_ROLE))
    keyframe_role_for_route = {LEGACY_KEYFRAME_FIRST: KEYFRAME_FIRST, LEGACY_KEYFRAME_LAST: KEYFRAME_LAST}.get(keyframe_role_for_route, keyframe_role_for_route)
    _route_first, _route_last, keyframe_count_for_route = _keyframes_from_group(mode.get("keyframes") or {}, keyframe_role_for_route)

    # Prompt/template choice is never an execution switch. Connected media are
    # forwarded according to the native H3 conditioning interface they belong to:
    # Reference media use the Reference builder; otherwise endpoint/base inputs
    # use the ImageToVideo builder. Prompt structure does not enable/disable media.
    use_reference_route = has_reference_inputs

    ignored_reference_inputs = False
    ignored_keyframe_inputs = bool(has_reference_inputs and keyframe_count_for_route)

    def run_reference(route: str, task_label: str, *, audio_proxy: bool = False):
        width, height = (AUDIO_PROXY_WIDTH, AUDIO_PROXY_HEIGHT) if audio_proxy else resolve_canvas(canvas)
        ref_images_raw = _ordered_group(mode.get("ref_images") or {}, "ref_image_")
        ref_videos_raw = _ordered_group(mode.get("ref_videos") or {}, "ref_video_")
        ref_video_audios_raw = _ordered_group(mode.get("ref_video_audios") or {}, "ref_video_audio_")
        ref_audios_raw = _ordered_group(mode.get("ref_audios") or {}, "ref_audio_")
        ref_image_size = str(mode.get("ref_image_size", DEFAULT_REF_IMAGE_SIZE))
        if ref_image_size in {LEGACY_REF_IMAGE_MATCH, LEGACY_REF_IMAGE_MATCH_V2}:
            ref_image_size = REF_IMAGE_MATCH
        elif ref_image_size in {LEGACY_REF_IMAGE_MAX, LEGACY_REF_IMAGE_MAX_DETAIL}:
            ref_image_size = REF_IMAGE_MAX
        # Audio-first uses a tiny disposable target canvas. Never let ordinary
        # ``match`` shrink semantic reference images to 32x32. Balance them to
        # the normal native H3 target area, then tell core ``max`` so its
        # downscale-only second pass leaves that prepared geometry untouched.
        if audio_proxy:
            effective_ref_image_size = REF_IMAGE_MATCH
            ref_balance_w, ref_balance_h = DEFAULT_CUSTOM_WIDTH, DEFAULT_CUSTOM_HEIGHT
            core_ref_image_size = "max"
        else:
            effective_ref_image_size = ref_image_size
            ref_balance_w, ref_balance_h = width, height
            core_ref_image_size = _core_ref_image_size(ref_image_size)
        ref_video_fps_by_name = _reference_video_fps_by_name(mode, ref_videos_raw)
        ref_video_size = _reference_video_size(mode)
        ref_video_temporal_fit = _reference_video_temporal_fit(mode)
        image_count, video_count, audio_count = _validate_reference_inputs(
            ref_images_raw, ref_videos_raw, ref_video_audios_raw, ref_audios_raw, video_fps_by_name=ref_video_fps_by_name
        )
        ref_images = _prepare_reference_images(ref_images_raw, ref_balance_w, ref_balance_h, effective_ref_image_size)
        ref_videos, video_records = _prepare_reference_videos(
            ref_videos_raw, ref_video_fps_by_name, ref_video_size, frame_count, ref_video_temporal_fit
        )
        ref_video_audios, paired_audio_records = _prepare_reference_audio_group(
            ref_video_audios_raw, "ref_video_audio_", effective_seconds
        )
        ref_audios, standalone_audio_records = _prepare_reference_audio_group(
            ref_audios_raw, "ref_audio_", effective_seconds
        )
        audio_records = {**paired_audio_records, **standalone_audio_records}
        compiled = _compile_reference_prompt(prompt, image_count, video_count, audio_count)
        core_out = h3.MiniMaxH3ReferenceToVideo.execute(
            clip=bundle.clip,
            vae=bundle.video_vae,
            audio_vae=bundle.audio_vae,
            prompt=compiled,
            width=width,
            height=height,
            length=length,
            ref_image_size=core_ref_image_size,
            ref_images=ref_images,
            ref_videos=ref_videos,
            ref_video_audios=ref_video_audios,
            ref_audios=ref_audios,
        )
        conditioning, latent = core_out.result
        diffusion_model = bundle.model_name_for(route)
        model = bundle.model_for(route)
        ref_info = reference_report(
            ref_images_raw, ref_videos, ref_video_audios, ref_audios,
            ref_balance_w, ref_balance_h, effective_ref_image_size, frame_count, video_records, audio_records,
        )
        return model, conditioning, latent, compiled, width, height, diffusion_model, ref_info, task_label

    def run_base(route: str, task_label: str, *, audio_proxy: bool = False):
        role = str(mode.get("keyframe_role", DEFAULT_KEYFRAME_ROLE))
        role = {LEGACY_KEYFRAME_FIRST: KEYFRAME_FIRST, LEGACY_KEYFRAME_LAST: KEYFRAME_LAST}.get(role, role)
        if role not in {KEYFRAME_FIRST, KEYFRAME_LAST}:
            raise ValueError(f"Unknown Image 1 role {role!r}. Choose {KEYFRAME_FIRST!r} or {KEYFRAME_LAST!r}.")
        first_frame, last_frame, keyframe_count = _keyframes_from_group(mode.get("keyframes") or {}, role)
        if keyframe_count == 0:
            task = task_label
        elif keyframe_count == 1:
            task = "I2VA" if role == KEYFRAME_FIRST else "L2VA"
        else:
            task = "FL2VA"
        keyframe_canvas = _keyframe_canvas_policy(mode)
        first_frame_resize = _first_frame_resize_policy(mode)
        last_frame_resize = _last_frame_resize_policy(mode)
        selected_canvas = _selected(canvas if isinstance(canvas, dict) else {}, "canvas", DEFAULT_CANVAS)
        if audio_proxy:
            width, height = AUDIO_PROXY_WIDTH, AUDIO_PROXY_HEIGHT
        elif keyframe_count and keyframe_canvas == KEYFRAME_CANVAS_ADAPTIVE and selected_canvas != CANVAS_CUSTOM:
            anchor = first_frame if first_frame is not None else last_frame
            source_w, source_h = _keyframe_image_size(anchor) or (0, 0)
            width, height = canvas_for_source(canvas, source_w, source_h)
        else:
            width, height = resolve_canvas(canvas)
        # When the canvas aspect is derived from the endpoint itself, the
        # opening-frame resize policy is conceptually irrelevant. Delegate the
        # tiny 32px-alignment adjustment to core H3's normal first-frame stretch.
        # The explicit pad/crop/stretch policy only applies when the user forces
        # a fixed/custom output aspect.
        adaptive_endpoint_canvas = (
            keyframe_count > 0
            and keyframe_canvas == KEYFRAME_CANVAS_ADAPTIVE
            and selected_canvas != CANVAS_CUSTOM
        )
        if adaptive_endpoint_canvas:
            prepared_first_frame, first_frame_prefit = first_frame, None
        else:
            prepared_first_frame, first_frame_prefit = _prepare_first_frame(first_frame, width, height, first_frame_resize)
        prepared_last_frame, last_frame_prefit = _prepare_last_frame(last_frame, width, height, last_frame_resize)
        compiled = _compile_base_prompt(prompt, keyframe_count, role)
        core_out = h3.MiniMaxH3ImageToVideo.execute(
            clip=bundle.clip,
            vae=bundle.video_vae,
            prompt=compiled,
            width=width,
            height=height,
            length=length,
            first_frame=prepared_first_frame,
            last_frame=prepared_last_frame,
        )
        conditioning, latent = core_out.result
        diffusion_model = bundle.model_name_for(route)
        model = bundle.model_for(route)
        ref_info = keyframe_report(
            first_frame, last_frame, width, height, keyframe_canvas, canvas,
            first_frame_resize, first_frame_prefit,
            last_frame_resize=last_frame_resize,
            last_frame_prefit=last_frame_prefit,
        )
        return model, conditioning, latent, compiled, width, height, diffusion_model, ref_info, task

    if selected_mode == MODE_AUDIO:
        audio_task_parts = []
        if use_reference_route:
            if ref_videos_connected:
                audio_task_parts.append("V2A")
            if ref_images_connected:
                audio_task_parts.append("I2A")
            if ref_video_audios_connected or ref_audios_connected:
                audio_task_parts.append("A2A")
        audio_task_label = "+".join(audio_task_parts) + " proxy" if audio_task_parts else "T2A proxy"
        if use_reference_route:
            model, conditioning, latent, compiled, width, height, diffusion_model, ref_info, task = run_reference("audio_ref2va", audio_task_label, audio_proxy=True)
            ref_info = f"Audio-only intent: H3 still generates an internal {AUDIO_PROXY_WIDTH}x{AUDIO_PROXY_HEIGHT} proxy video; decode the audio stream and discard the proxy video.\n" + ref_info
        else:
            model, conditioning, latent, compiled, width, height, diffusion_model, ref_info, task = run_base("audio_fl2va", audio_task_label, audio_proxy=True)
            ref_info = f"Audio-only intent: H3 still generates an internal {AUDIO_PROXY_WIDTH}x{AUDIO_PROXY_HEIGHT} proxy video; decode the audio stream and discard the proxy video.\n" + ref_info if ref_info else f"Audio-only intent: H3 still generates an internal {AUDIO_PROXY_WIDTH}x{AUDIO_PROXY_HEIGHT} proxy video; decode the audio stream and discard the proxy video."
    elif use_reference_route:
        model, conditioning, latent, compiled, width, height, diffusion_model, ref_info, task = run_reference("ref2va", "REF2VA")
    else:
        model, conditioning, latent, compiled, width, height, diffusion_model, ref_info, task = run_base("fl2va", "T2VA")

    routing_notes = []
    if ignored_keyframe_inputs:
        routing_notes.append(
            "Reference inputs are connected, so execution uses the native Reference conditioning path; "
            "first/last-frame sockets remain connected but are not forwarded by that native path."
        )
    if routing_notes:
        prefix = "\n".join(routing_notes)
        ref_info = f"{prefix}\n{ref_info}" if ref_info else prefix

    context = MiniMaxH3Context(
        conditioning=conditioning,
        latent=latent,
        video_vae=bundle.video_vae,
        audio_vae=bundle.audio_vae,
        playback_fps=out_fps,
        compiled_prompt=compiled,
        width=width,
        height=height,
        frame_count=frame_count,
        effective_seconds=effective_seconds,
        mode=selected_mode,
        task=task,
        diffusion_model=diffusion_model,
        reference_info=ref_info,
    )
    return model, context, compiled
