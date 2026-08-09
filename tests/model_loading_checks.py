from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_module(registry=None):
    for name in ["h3easy.model_loading", "folder_paths", "nodes"]:
        sys.modules.pop(name, None)

    store = {
        "diffusion_models": [
            "renamed_custom_model.safetensors",
            "subdir/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            "ignore.ckpt",
        ],
        "unet_gguf": ["totally_arbitrary.gguf", "renamed_custom_model.safetensors"],
        "text_encoders": ["encoder_any_name.safetensors", "ignore.bin"],
        "clip_gguf": ["encoder_quant.gguf"],
        "vae": ["visual_any_name.safetensors", "audio_any_name.safetensors", "not_exposed.pt", "bad.gguf"],
    }

    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_filename_list = lambda category: list(store.get(category, []))
    sys.modules["folder_paths"] = folder_paths

    nodes = types.ModuleType("nodes")
    nodes.NODE_CLASS_MAPPINGS = dict(registry or {})

    class UNETLoader:
        calls = []
        def load_unet(self, name, dtype):
            self.__class__.calls.append((name, dtype))
            return (f"unet:{name}",)

    class CLIPLoader:
        def load_clip(self, *args, **kwargs):
            return ("clip",)

    class VAELoader:
        def load_vae(self, name):
            return (f"vae:{name}",)

    nodes.UNETLoader = UNETLoader
    nodes.CLIPLoader = CLIPLoader
    nodes.VAELoader = VAELoader
    sys.modules["nodes"] = nodes

    package = types.ModuleType("h3easy")
    package.__path__ = [str(ROOT / "h3easy")]
    sys.modules["h3easy"] = package

    spec = importlib.util.spec_from_file_location("h3easy.model_loading", ROOT / "h3easy" / "model_loading.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["h3easy.model_loading"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module, store, nodes


def test_diffusion_choices_are_extension_based_not_keyword_based():
    ml, _, _ = load_module()
    assert ml.diffusion_model_choices() == [
        "renamed_custom_model.safetensors",
        "subdir/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "totally_arbitrary.gguf",
    ]



def test_empty_diffusion_registry_is_explicit_instead_of_fabricating_phantom_files():
    ml, store, _ = load_module()
    store["diffusion_models"] = []
    store["unet_gguf"] = []
    assert ml.diffusion_model_choices() == [ml.NO_DIFFUSION_WEIGHTS]




def test_empty_registry_selection_fails_before_any_expensive_loader_runs():
    ml, store, nodes = load_module()
    for category in store:
        store[category] = []
    clip_calls = []
    vae_calls = []

    def bad_clip(*args, **kwargs):
        clip_calls.append((args, kwargs))
        raise AssertionError("CLIP loader should not run")

    def bad_vae(*args, **kwargs):
        vae_calls.append((args, kwargs))
        raise AssertionError("VAE loader should not run")

    nodes.CLIPLoader.load_clip = bad_clip
    nodes.VAELoader.load_vae = bad_vae
    try:
        ml.load_bundle(
            ml.NO_DIFFUSION_WEIGHTS, ml.NO_DIFFUSION_WEIGHTS, ml.NO_TEXT_ENCODERS,
            ml.NO_VAE_WEIGHTS, ml.NO_VAE_WEIGHTS,
        )
    except ValueError as exc:
        assert "No text/frame workflow diffusion weight is available" in str(exc)
    else:
        raise AssertionError("Expected empty loader selection to fail")
    assert clip_calls == []
    assert vae_calls == []

def test_text_encoder_choices_are_extension_based_not_keyword_based():
    ml, _, _ = load_module()
    assert ml.text_encoder_choices() == ["encoder_any_name.safetensors", "encoder_quant.gguf"]


def test_vae_choices_expose_any_safetensors_but_not_unloadable_gguf():
    ml, _, _ = load_module()
    expected = ["audio_any_name.safetensors", "visual_any_name.safetensors"]
    assert ml.video_vae_choices() == expected
    assert ml.audio_vae_choices() == expected


def test_choice_lists_are_live_not_extension_cached():
    ml, store, _ = load_module()
    first = ml.diffusion_model_choices()
    store["diffusion_models"].append("added_after_first_call.safetensors")
    second = ml.diffusion_model_choices()
    assert "added_after_first_call.safetensors" not in first
    assert "added_after_first_call.safetensors" in second


def test_preferred_defaults_match_exact_basename_only_not_keywords():
    ml, _, _ = load_module()
    diffusion = ["foo/referenceish.safetensors", "models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", "custom.safetensors"]
    text = ["encoder_any.safetensors"]
    video = ["x/minimax_h3_video_vae_fp16.safetensors", "anything.safetensors"]
    audio = ["y/minimax_h3_audio_vae_fp32.safetensors", "anything.safetensors"]
    defaults = ml.preferred_loader_defaults(diffusion, text, video, audio)
    assert defaults[0] == "models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    assert defaults[1] == ml.SELECT_DIFFUSION_WEIGHT  # multiple unknown files require an explicit choice
    assert defaults[2] == text[0]
    assert defaults[3] == "x/minimax_h3_video_vae_fp16.safetensors"
    assert defaults[4] == "y/minimax_h3_audio_vae_fp32.safetensors"


def test_same_safetensors_can_be_routed_to_both_conditioning_workflows_without_reload():
    ml, _, nodes = load_module()
    bundle = ml.MiniMaxH3Bundle(
        fl2va_model_name="whatever.safetensors",
        ref2va_model_name="whatever.safetensors",
        clip_name="encoder.safetensors",
        video_vae_name="video.safetensors",
        audio_vae_name="audio.safetensors",
        clip=object(), video_vae=object(), audio_vae=object(),
    )
    a = bundle.model_for("fl2va")
    b = bundle.model_for("ref2va")
    assert a == b == "unet:whatever.safetensors"
    assert nodes.UNETLoader.calls == [("whatever.safetensors", "default")]


def test_different_routed_files_reload_only_when_filename_changes():
    ml, _, nodes = load_module()
    bundle = ml.MiniMaxH3Bundle(
        fl2va_model_name="a.safetensors",
        ref2va_model_name="b.safetensors",
        clip_name="encoder.safetensors",
        video_vae_name="video.safetensors",
        audio_vae_name="audio.safetensors",
        clip=object(), video_vae=object(), audio_vae=object(),
    )
    assert bundle.model_for("fl2va") == "unet:a.safetensors"
    assert bundle.model_for("ref2va") == "unet:b.safetensors"
    assert nodes.UNETLoader.calls == [("a.safetensors", "default"), ("b.safetensors", "default")]


def test_gguf_loader_registry_lookup_is_live():
    ml, _, nodes = load_module()
    assert ml._registered_node_class("UnetLoaderGGUF") is None
    marker = type("LateGGUF", (), {})
    nodes.NODE_CLASS_MAPPINGS["UnetLoaderGGUF"] = marker
    assert ml._registered_node_class("UnetLoaderGGUF") is marker



def test_explicit_audio_override_supersedes_conditioning_matched_models():
    ml, _, _ = load_module()
    bundle = ml.MiniMaxH3Bundle(
        fl2va_model_name="frame.safetensors",
        ref2va_model_name="ref.safetensors",
        audio_model_name="audio-special.safetensors",
        clip_name="encoder.safetensors", video_vae_name="video.safetensors", audio_vae_name="audio.safetensors",
        clip=object(), video_vae=object(), audio_vae=object(),
    )
    assert bundle.model_name_for("audio_fl2va") == "audio-special.safetensors"
    assert bundle.model_name_for("audio_ref2va") == "audio-special.safetensors"

def test_same_safetensors_can_be_reused_across_all_three_workflow_routes():
    ml, _, nodes = load_module()
    bundle = ml.MiniMaxH3Bundle(
        fl2va_model_name="same.safetensors",
        ref2va_model_name="same.safetensors",
        audio_model_name="same.safetensors",
        clip_name="encoder.safetensors",
        video_vae_name="video.safetensors",
        audio_vae_name="audio.safetensors",
        clip=object(), video_vae=object(), audio_vae=object(),
    )
    assert bundle.model_for("fl2va") == "unet:same.safetensors"
    assert bundle.model_for("ref2va") == "unet:same.safetensors"
    assert bundle.model_for("audio") == "unet:same.safetensors"
    assert nodes.UNETLoader.calls == [("same.safetensors", "default")]


def test_loader_selector_options_make_audio_override_auto_by_default():
    ml, _, _ = load_module()
    selectors = ml.loader_selector_options(
        ["a.safetensors", "b.safetensors"],
        ["encoder.safetensors"],
        ["video.safetensors"],
        ["audio.safetensors"],
    )
    options, default = selectors["audio_override"]
    assert default == ml.AUTO_AUDIO_MODEL
    assert options[0] == ml.AUTO_AUDIO_MODEL
    assert "a.safetensors" in options and "b.safetensors" in options


def test_auto_audio_route_matches_actual_conditioning_family():
    ml, _, nodes = load_module()
    bundle = ml.MiniMaxH3Bundle(
        fl2va_model_name="frame.safetensors",
        ref2va_model_name="ref.safetensors",
        audio_model_name=ml.AUTO_AUDIO_MODEL,
        clip_name="encoder.safetensors", video_vae_name="video.safetensors", audio_vae_name="audio.safetensors",
        clip=object(), video_vae=object(), audio_vae=object(),
    )
    assert bundle.model_name_for("audio_fl2va") == "frame.safetensors"
    assert bundle.model_name_for("audio_ref2va") == "ref.safetensors"
    assert bundle.model_for("audio_fl2va") == "unet:frame.safetensors"
    assert bundle.model_for("audio_ref2va") == "unet:ref.safetensors"


def test_legacy_five_argument_load_bundle_keeps_audio_override_auto():
    ml, _, _ = load_module()
    bundle = ml.load_bundle(
        "renamed_custom_model.safetensors",
        "subdir/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "encoder_any_name.safetensors",
        "visual_any_name.safetensors",
        "audio_any_name.safetensors",
    )
    assert bundle.audio_model_name == ml.AUTO_AUDIO_MODEL
    assert bundle.model_name_for("audio_fl2va") == "renamed_custom_model.safetensors"
    assert bundle.model_name_for("audio_ref2va") == "subdir/minimax_h3_fl2va_pruned_int8_convrot.safetensors"


def test_multiple_unknown_components_do_not_silently_choose_first_file():
    ml, _, _ = load_module()
    options, default = ml._setup_choice(
        ["a.safetensors", "b.safetensors"], "known-not-present.safetensors", ml.SELECT_TEXT_ENCODER
    )
    assert default == ml.SELECT_TEXT_ENCODER
    assert options[0] == ml.SELECT_TEXT_ENCODER

if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} model-loading checks passed")
