from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Any

import folder_paths
import nodes

DIFFUSION_FILE_EXTENSIONS = {".safetensors", ".gguf"}
TEXT_ENCODER_FILE_EXTENSIONS = {".safetensors", ".gguf"}
VAE_FILE_EXTENSIONS = {".safetensors"}

NO_DIFFUSION_WEIGHTS = "<no diffusion weights found>"
NO_TEXT_ENCODERS = "<no text encoder weights found>"
NO_VAE_WEIGHTS = "<no VAE weights found>"
AUTO_AUDIO_MODEL = "Auto (match conditioning)"
SELECT_DIFFUSION_WEIGHT = "<select diffusion weight>"
SELECT_TEXT_ENCODER = "<select text encoder>"
SELECT_VIDEO_VAE = "<select video VAE>"
SELECT_AUDIO_VAE = "<select audio VAE>"
_EMPTY_SELECTIONS = {
    NO_DIFFUSION_WEIGHTS, NO_TEXT_ENCODERS, NO_VAE_WEIGHTS,
    SELECT_DIFFUSION_WEIGHT, SELECT_TEXT_ENCODER, SELECT_VIDEO_VAE, SELECT_AUDIO_VAE,
}


def _has_extension(name: str, extensions: set[str]) -> bool:
    return os.path.splitext(str(name or ""))[1].lower() in extensions


def _is_gguf_file(name: str) -> bool:
    return str(name or "").lower().endswith(".gguf")


def _category_names(category: str) -> list[str]:
    try:
        return [str(name) for name in folder_paths.get_filename_list(category)]
    except Exception:
        return []


def _collect_weight_names(categories: tuple[str, ...], extensions: set[str]) -> list[str]:
    """Return every supported weight exposed by the requested ComfyUI folders.

    Deliberately do not infer model capability from filenames. Custom, renamed,
    quantized and cross-task H3 weights must remain selectable. Compatibility is
    determined by the actual ComfyUI loader when the user runs the workflow.
    """
    seen: set[str] = set()
    names: list[str] = []
    for category in categories:
        for name in _category_names(category):
            if not _has_extension(name, extensions):
                continue
            key = name.replace("\\", "/")
            if key in seen:
                continue
            seen.add(key)
            names.append(key)
    # Prefer ordinary safetensors before optional GGUF, otherwise preserve a
    # predictable case-insensitive path order. No MiniMax/task keywords involved.
    return sorted(names, key=lambda name: (_is_gguf_file(name), name.casefold()))


def _choices(
    categories: tuple[str, ...],
    extensions: set[str],
    empty_label: str,
) -> list[str]:
    names = _collect_weight_names(categories, extensions)
    # Never fabricate a filename that is not present in ComfyUI's registry. A
    # sentinel keeps the Combo schema valid while making an empty model folder
    # explicit instead of offering a guaranteed-to-fail phantom checkpoint.
    return names if names else [empty_label]


def _preferred_exact(options: list[str], preferred: str) -> str | None:
    """Find an exact known basename without inferring capability from keywords."""
    target = preferred.casefold()
    for option in options:
        if os.path.basename(option.replace("\\", "/")).casefold() == target:
            return option
    return None


def _setup_choice(options: list[str], preferred: str, placeholder: str) -> tuple[list[str], str]:
    """Choose a safe fresh-node default without silently picking an unrelated file.

    Exact known basenames are preferred. A single available file is unambiguous
    enough to select automatically. Otherwise the user must choose explicitly.
    This affects only the initial selection, never which files are allowed.
    """
    if len(options) == 1 and options[0] in {NO_DIFFUSION_WEIGHTS, NO_TEXT_ENCODERS, NO_VAE_WEIGHTS}:
        return options, options[0]
    exact = _preferred_exact(options, preferred)
    if exact is not None:
        return options, exact
    if len(options) == 1:
        return options, options[0]
    return [placeholder, *options], placeholder


def diffusion_model_choices() -> list[str]:
    return _choices(
        ("diffusion_models", "unet_gguf"),
        DIFFUSION_FILE_EXTENSIONS,
        NO_DIFFUSION_WEIGHTS,
    )


def text_encoder_choices() -> list[str]:
    return _choices(
        ("text_encoders", "clip_gguf"),
        TEXT_ENCODER_FILE_EXTENSIONS,
        NO_TEXT_ENCODERS,
    )


def video_vae_choices() -> list[str]:
    return _choices(("vae",), VAE_FILE_EXTENSIONS, NO_VAE_WEIGHTS)


def audio_vae_choices() -> list[str]:
    return _choices(("vae",), VAE_FILE_EXTENSIONS, NO_VAE_WEIGHTS)


def preferred_loader_defaults(
    diffusion_models: list[str],
    text_encoders: list[str],
    video_vaes: list[str],
    audio_vaes: list[str],
) -> tuple[str, str, str, str, str, str]:
    """Legacy helper retained for tests/API callers.

    It returns safe defaults only. Node schema construction uses
    ``loader_selector_options`` below so placeholders are also present in the
    matching Combo option list.
    """
    _, frame_default = _setup_choice(
        diffusion_models, "minimax_h3_fl2va_pruned_int8_convrot.safetensors", SELECT_DIFFUSION_WEIGHT
    )
    _, reference_default = _setup_choice(
        diffusion_models, "minimax_h3_ref2va_pruned_int8_convrot.safetensors", SELECT_DIFFUSION_WEIGHT
    )
    _, text_default = _setup_choice(
        text_encoders, "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", SELECT_TEXT_ENCODER
    )
    _, video_vae_default = _setup_choice(
        video_vaes, "minimax_h3_video_vae_fp16.safetensors", SELECT_VIDEO_VAE
    )
    _, audio_vae_default = _setup_choice(
        audio_vaes, "minimax_h3_audio_vae_fp32.safetensors", SELECT_AUDIO_VAE
    )
    return frame_default, reference_default, text_default, video_vae_default, audio_vae_default, AUTO_AUDIO_MODEL


def loader_selector_options(
    diffusion_models: list[str],
    text_encoders: list[str],
    video_vaes: list[str],
    audio_vaes: list[str],
):
    frame_options, frame_default = _setup_choice(
        diffusion_models, "minimax_h3_fl2va_pruned_int8_convrot.safetensors", SELECT_DIFFUSION_WEIGHT
    )
    reference_options, reference_default = _setup_choice(
        diffusion_models, "minimax_h3_ref2va_pruned_int8_convrot.safetensors", SELECT_DIFFUSION_WEIGHT
    )
    text_options, text_default = _setup_choice(
        text_encoders, "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", SELECT_TEXT_ENCODER
    )
    video_vae_options, video_vae_default = _setup_choice(
        video_vaes, "minimax_h3_video_vae_fp16.safetensors", SELECT_VIDEO_VAE
    )
    audio_vae_options, audio_vae_default = _setup_choice(
        audio_vaes, "minimax_h3_audio_vae_fp32.safetensors", SELECT_AUDIO_VAE
    )
    audio_override_options = [AUTO_AUDIO_MODEL, *[x for x in diffusion_models if x != NO_DIFFUSION_WEIGHTS]]
    return {
        "frame": (frame_options, frame_default),
        "reference": (reference_options, reference_default),
        "audio_override": (audio_override_options, AUTO_AUDIO_MODEL),
        "text": (text_options, text_default),
        "video_vae": (video_vae_options, video_vae_default),
        "audio_vae": (audio_vae_options, audio_vae_default),
    }



def _require_real_selection(value: str, label: str) -> str:
    selected = str(value or "")
    if selected in _EMPTY_SELECTIONS or not selected:
        raise ValueError(
            f"No {label} is available. Add a compatible weight to the corresponding ComfyUI model folder, "
            "refresh/restart model discovery if needed, then select the actual file."
        )
    return selected

def _registered_node_class(*names: str):
    # Resolve live registry state each time. Loader registration can change with
    # custom-node load order; caching a miss makes a later-valid GGUF loader
    # invisible for the rest of the session.
    mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {})
    for name in names:
        node_class = mappings.get(name) if hasattr(mappings, "get") else None
        if node_class is not None:
            return node_class
        node_class = getattr(nodes, name, None)
        if node_class is not None:
            return node_class
    return None


def _load_gguf_unet(model_name: str):
    loader_class = _registered_node_class("UnetLoaderGGUF", "UNETLoaderGGUF", "UnetLoaderGGUFAdvanced")
    if loader_class is None:
        raise RuntimeError(
            "The selected diffusion weight is GGUF, but no compatible GGUF UNet loader is registered. "
            "Install ComfyUI-GGUF plus H3-compatible GGUF architecture support, then restart ComfyUI; "
            "otherwise select a compatible .safetensors H3 weight."
        )
    try:
        return loader_class().load_unet(model_name)[0]
    except Exception as exc:
        raise RuntimeError(
            f"Failed to load GGUF diffusion weight {model_name!r} through {loader_class.__name__}. "
            "H3 GGUF support is community/experimental and depends on the conversion plus the installed "
            "ComfyUI-GGUF/H3 architecture support. Use the original error below to diagnose the exact failure, "
            "or switch to a compatible .safetensors H3 weight."
        ) from exc


def _load_text_encoder(text_encoder: str):
    if not _is_gguf_file(text_encoder):
        return nodes.CLIPLoader().load_clip(text_encoder, "minimax", "default")[0]

    loader_class = _registered_node_class("CLIPLoaderGGUF", "CLIPLoaderGGUFAdvanced")
    if loader_class is None:
        raise RuntimeError(
            "The selected text encoder is GGUF, but no compatible GGUF CLIP loader is registered. "
            "Install a ComfyUI-GGUF build with MiniMax H3/Qwen3-VL support and restart ComfyUI; "
            "otherwise use an official H3 .safetensors text encoder."
        )
    loader = loader_class()
    try:
        try:
            return loader.load_clip(text_encoder, "minimax")[0]
        except TypeError:
            return loader.load_clip(text_encoder, type="minimax")[0]
    except Exception as exc:
        raise RuntimeError(
            f"Failed to load GGUF text encoder {text_encoder!r} through {loader_class.__name__}. "
            "H3 Qwen3-VL GGUF support is still format/loader dependent; some packages require additional "
            "vision/mmproj support that this Easy loader cannot infer from a lone filename. Use the original "
            "error below to diagnose the exact failure, or use an official H3 .safetensors text encoder."
        ) from exc


@dataclass
class MiniMaxH3Bundle:
    fl2va_model_name: str
    ref2va_model_name: str
    clip_name: str
    video_vae_name: str
    audio_vae_name: str
    clip: Any
    video_vae: Any
    audio_vae: Any
    audio_model_name: str = ""

    def __post_init__(self) -> None:
        if not getattr(self, "audio_model_name", ""):
            self.audio_model_name = AUTO_AUDIO_MODEL
        self._model = None
        self._loaded_model_name = ""
        self._lock = threading.RLock()

    def model_name_for(self, route: str) -> str:
        if route not in {"fl2va", "ref2va", "audio", "audio_fl2va", "audio_ref2va"}:
            raise ValueError(
                f"Unknown MiniMax H3 workflow route {route!r}; expected 'fl2va', 'ref2va', "
                "'audio', 'audio_fl2va' or 'audio_ref2va'."
            )
        if route == "ref2va":
            return self.ref2va_model_name
        if route in {"audio", "audio_fl2va", "audio_ref2va"}:
            if self.audio_model_name and self.audio_model_name != AUTO_AUDIO_MODEL:
                return self.audio_model_name
            return self.ref2va_model_name if route == "audio_ref2va" else self.fl2va_model_name
        return self.fl2va_model_name

    def model_for(self, route: str):
        model_name = self.model_name_for(route)
        with self._lock:
            # Cache by the actual file, not the workflow route. The same checkpoint
            # may intentionally be selected for both text/frame and reference
            # conditioning, so changing mode must not force a needless reload.
            if self._model is not None and self._loaded_model_name == model_name:
                return self._model

            if self._model is not None:
                # Drop only this bundle's reference. ComfyUI's model manager owns
                # device/offload/cache policy.
                self._model = None
                self._loaded_model_name = ""

            if _is_gguf_file(model_name):
                self._model = _load_gguf_unet(model_name)
            else:
                self._model, = nodes.UNETLoader().load_unet(model_name, "default")
            self._loaded_model_name = model_name
            return self._model


def load_bundle(fl2va_model: str, ref2va_model: str, audio_model: str, text_encoder: str | None = None, video_vae: str | None = None, audio_vae: str | None = None) -> MiniMaxH3Bundle:
    # Backward-compatible 5-argument call shape: (fl2va, ref2va, text_encoder, video_vae, audio_vae).
    if audio_vae is None:
        audio_vae = video_vae
        video_vae = text_encoder
        text_encoder = audio_model
        audio_model = AUTO_AUDIO_MODEL

    # Validate every selector before loading anything expensive, so an empty
    # model folder cannot partially allocate CLIP/VAE state before failing.
    fl2va_model = _require_real_selection(fl2va_model, "text/frame workflow diffusion weight")
    ref2va_model = _require_real_selection(ref2va_model, "reference workflow diffusion weight")
    audio_model = str(audio_model or AUTO_AUDIO_MODEL)
    if audio_model != AUTO_AUDIO_MODEL:
        audio_model = _require_real_selection(audio_model, "audio-only model override")
    text_encoder = _require_real_selection(text_encoder, "text encoder weight")
    video_vae = _require_real_selection(video_vae, "video VAE weight")
    audio_vae = _require_real_selection(audio_vae, "audio VAE weight")

    clip = _load_text_encoder(text_encoder)
    video_vae_obj, = nodes.VAELoader().load_vae(video_vae)
    audio_vae_obj, = nodes.VAELoader().load_vae(audio_vae)
    return MiniMaxH3Bundle(
        fl2va_model_name=fl2va_model,
        ref2va_model_name=ref2va_model,
        audio_model_name=audio_model,
        clip_name=text_encoder,
        video_vae_name=video_vae,
        audio_vae_name=audio_vae,
        clip=clip,
        video_vae=video_vae_obj,
        audio_vae=audio_vae_obj,
    )
