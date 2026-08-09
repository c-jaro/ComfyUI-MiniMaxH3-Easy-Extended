from __future__ import annotations

import importlib.util
import math
import sys
import types
from pathlib import Path

import torch
import torch.nn.functional as torch_f


ROOT = Path(__file__).resolve().parents[1]


def load_runtime():
    # Load runtime.py without requiring a full ComfyUI checkout. The stubs mirror
    # only the small core surface these preprocessing helpers use.
    for name in [
        "h3easy.runtime",
        "h3easy.model_loading",
        "h3easy",
        "comfy_extras.nodes_minimax_h3",
        "comfy_extras",
        "comfy.utils",
        "comfy",
    ]:
        sys.modules.pop(name, None)

    comfy = types.ModuleType("comfy")
    comfy_utils = types.ModuleType("comfy.utils")

    def common_upscale(samples, width, height, method, crop):
        assert crop == "disabled"
        return torch_f.interpolate(samples, size=(height, width), mode="bilinear", align_corners=False)

    comfy_utils.common_upscale = common_upscale
    comfy.utils = comfy_utils
    sys.modules["comfy"] = comfy
    sys.modules["comfy.utils"] = comfy_utils

    h3 = types.ModuleType("comfy_extras.nodes_minimax_h3")
    h3.CANVAS_MULTIPLE = 32
    h3.BASE_SHORT_EDGE = 768
    h3.MAX_PIXELS = 768 * 1344
    h3.REF_IMAGE_SHORT_EDGE = 2048
    h3.FPS = 24

    def adapt_canvas(width, height):
        ratio = width / height
        if ratio >= 1.0:
            nom_w, nom_h = h3.BASE_SHORT_EDGE * ratio, h3.BASE_SHORT_EDGE
        else:
            nom_w, nom_h = h3.BASE_SHORT_EDGE, h3.BASE_SHORT_EDGE / ratio
        if nom_w * nom_h > h3.MAX_PIXELS:
            scale = math.sqrt(h3.MAX_PIXELS / (nom_w * nom_h))
            nom_w *= scale
            nom_h *= scale
        return (
            max(32, round(nom_w / 32) * 32),
            max(32, round(nom_h / 32) * 32),
        )

    def video_latent_t(frame_count):
        return 2 if frame_count <= 5 else ((frame_count - 5) // 17) * 5 + 2

    def temporal_shape(length):
        frame_count = max(5, int(length))
        while frame_count % 17 != 5:
            frame_count += 1
        duration = frame_count / h3.FPS
        return frame_count, video_latent_t(frame_count), round(duration * 40)

    h3.adapt_canvas = adapt_canvas
    h3.video_latent_t = video_latent_t
    h3.temporal_shape = temporal_shape
    extras = types.ModuleType("comfy_extras")
    extras.nodes_minimax_h3 = h3
    sys.modules["comfy_extras"] = extras
    sys.modules["comfy_extras.nodes_minimax_h3"] = h3

    package = types.ModuleType("h3easy")
    package.__path__ = [str(ROOT / "h3easy")]
    sys.modules["h3easy"] = package
    model_loading = types.ModuleType("h3easy.model_loading")
    model_loading.MiniMaxH3Bundle = type("MiniMaxH3Bundle", (), {})
    sys.modules["h3easy.model_loading"] = model_loading

    spec = importlib.util.spec_from_file_location("h3easy.runtime", ROOT / "h3easy" / "runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["h3easy.runtime"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_balanced_reference_targets_are_target_area_fixed_points():
    rt = load_runtime()
    target_w, target_h = 1344, 768
    cases = {
        (512, 512): (1024, 1024),
        (3840, 2160): (1344, 768),
    }
    for source, expected in cases.items():
        got = rt._balanced_reference_image_target(*source, target_w, target_h)
        assert got == expected
        assert rt._core_match_reference_target(*got, target_w * target_h) == got


def test_balanced_reference_resize_never_stretches_source_content():
    rt = load_runtime()
    source = torch.zeros((1, 1200, 1600, 3), dtype=torch.float32)
    target_w, target_h = rt._balanced_reference_image_target(1600, 1200, 1344, 768)
    resized = rt._resize_reference_image(source, target_w, target_h)
    assert resized.shape == (1, target_h, target_w, 3)
    source_ratio = 1600 / 1200
    # Reconstruct the proportional fit used by the implementation and ensure
    # only padding, never anisotropic scaling, accounts for ratio mismatch.
    scale = min(target_w / 1600, target_h / 1200)
    fitted_w = round(1600 * scale)
    fitted_h = round(1200 * scale)
    assert abs((fitted_w / fitted_h) / source_ratio - 1.0) < 0.002


def test_per_video_fps_maps_by_visible_ordinal_not_sparse_slot_suffix():
    rt = load_runtime()
    refs = {
        "ref_video_0": torch.zeros((120, 8, 8, 3)),
        "ref_video_2": torch.zeros((90, 8, 8, 3)),
        "ref_video_7": torch.zeros((48, 8, 8, 3)),
    }
    mode = {"ref_video_fps": 60, "ref_video_fps_2": 30, "ref_video_fps_3": 24}
    assert rt._reference_video_fps_by_name(mode, refs) == {
        "ref_video_0": 60.0,
        "ref_video_2": 30.0,
        "ref_video_7": 24.0,
    }


def test_per_video_fps_zero_override_inherits_legacy_shared_rate():
    rt = load_runtime()
    refs = {
        "ref_video_0": torch.zeros((120, 8, 8, 3)),
        "ref_video_2": torch.zeros((90, 8, 8, 3)),
        "ref_video_7": torch.zeros((48, 8, 8, 3)),
    }
    mode = {"ref_video_fps": 60, "ref_video_fps_2": 0, "ref_video_fps_3": 0}
    assert rt._reference_video_fps_by_name(mode, refs) == {
        "ref_video_0": 60.0,
        "ref_video_2": 60.0,
        "ref_video_7": 60.0,
    }


def test_each_video_is_normalized_with_its_own_fps():
    rt = load_runtime()
    refs = {
        "ref_video_0": torch.zeros((120, 64, 64, 3)),  # 2 s at 60 fps
        "ref_video_1": torch.zeros((120, 64, 64, 3)),  # 4 s at 30 fps
    }
    fps = {"ref_video_0": 60.0, "ref_video_1": 30.0}
    prepared, records = rt._prepare_reference_videos(
        refs, fps, rt.REF_VIDEO_NATIVE, generated_frame_count=124, temporal_fit=rt.REF_VIDEO_TEMPORAL_CORE
    )
    assert records["ref_video_0"]["normalized_total_frames"] == 48
    assert records["ref_video_1"]["normalized_total_frames"] == 96
    assert records["ref_video_0"]["aligned_frames"] == 39
    assert records["ref_video_1"]["aligned_frames"] == 90
    assert prepared["ref_video_0"].shape[0] == 39
    assert prepared["ref_video_1"].shape[0] == 90


def test_duration_validation_uses_each_video_fps():
    rt = load_runtime()
    refs = {
        "ref_video_0": torch.zeros((120, 8, 8, 3)),  # 2 s at 60
        "ref_video_1": torch.zeros((120, 8, 8, 3)),  # 4 s at 30
    }
    counts = rt._validate_reference_inputs(
        {}, refs, {}, {}, video_fps_by_name={"ref_video_0": 60.0, "ref_video_1": 30.0}
    )
    assert counts == (0, 2, 0)




def test_published_reference_duration_is_warning_not_backend_gate():
    rt = load_runtime()
    refs = {"ref_video_0": torch.zeros((24, 8, 8, 3))}  # 1s, outside published 2-15s but core-valid
    counts = rt._validate_reference_inputs({}, refs, {}, {}, video_fps_by_name={"ref_video_0": 24.0})
    assert counts == (0, 1, 0)
    prepared, records = rt._prepare_reference_videos(
        refs, {"ref_video_0": 24.0}, rt.REF_VIDEO_NATIVE, generated_frame_count=124
    )
    report = rt.reference_report({}, prepared, {}, {}, 1344, 768, rt.REF_IMAGE_MATCH, 124, records, {})
    assert "Published Ref2VA envelope warning" in report
    assert "Video 1 1.00s outside documented 2-15s" in report


def test_audio_only_reference_is_allowed_but_reported_as_experimental():
    rt = load_runtime()
    audio = {"waveform": torch.zeros((1, 2, 32000)), "sample_rate": 32000}
    counts = rt._validate_reference_inputs({}, {}, {}, {"ref_audio_0": audio})
    assert counts == (0, 0, 1)
    report = rt.reference_report({}, {}, {}, {"ref_audio_0": audio}, 1344, 768, rt.REF_IMAGE_MATCH, 124)
    assert "audio-only reference input" in report
    assert "Audio 1 1.00s outside documented 2-15s" in report


def test_current_core_five_frame_minimum_remains_a_hard_error():
    rt = load_runtime()
    refs = {"ref_video_0": torch.zeros((4, 8, 8, 3))}
    try:
        rt._validate_reference_inputs({}, refs, {}, {}, video_fps_by_name={"ref_video_0": 24.0})
    except ValueError as exc:
        assert "requires at least 5 reference-video frames" in str(exc)
    else:
        raise AssertionError("Expected current-core five-frame requirement to fail")


def test_reference_report_surfaces_visual_context_budget_without_calling_it_attention():
    rt = load_runtime()
    images = {"ref_image_0": torch.zeros((1, 512, 512, 3))}
    videos = {"ref_video_0": torch.zeros((124, 768, 1344, 3))}
    records = {
        "ref_video_0": {
            "source_fps": 24.0,
            "source_frames": 124,
            "normalized_total_frames": 124,
            "timeline_frames": 124,
            "aligned_frames": 124,
            "core_aligned_frames": 124,
            "source_w": 1344,
            "source_h": 768,
            "native_w": 1344,
            "native_h": 768,
            "size_mode": rt.REF_VIDEO_NATIVE,
            "temporal_fit": rt.REF_VIDEO_TEMPORAL_CORE,
        }
    }
    report = rt.reference_report(
        images, videos, {}, {}, 1344, 768, rt.REF_IMAGE_MATCH, 124, records, {}
    )
    assert "Picture 1 1,024" in report
    assert "Video 1 37,296" in report
    assert "Largest/smallest visual block ratio: 36.4x" in report
    assert "not measured attention weights" in report

def test_legacy_choice_strings_keep_their_runtime_behavior():
    rt = load_runtime()
    assert rt._core_ref_image_size(rt.LEGACY_REF_IMAGE_MATCH) == "match"
    assert rt._core_ref_image_size(rt.LEGACY_REF_IMAGE_MATCH_V2) == "match"
    assert rt._core_ref_image_size(rt.LEGACY_REF_IMAGE_MAX) == "max"
    assert rt._keyframe_canvas_policy({"keyframe_canvas": rt.LEGACY_KEYFRAME_CANVAS_ADAPTIVE}) == rt.KEYFRAME_CANVAS_ADAPTIVE
    assert rt._keyframe_canvas_policy({"keyframe_canvas": rt.LEGACY_KEYFRAME_CANVAS_FIXED}) == rt.KEYFRAME_CANVAS_FIXED
    assert rt._first_frame_resize_policy({"first_frame_resize": rt.LEGACY_FIRST_FRAME_FIT_AUTO}) == rt.FIRST_FRAME_FIT_PAD
    assert rt._first_frame_resize_policy({"first_frame_resize": rt.LEGACY_FIRST_FRAME_FIT_CROP}) == rt.FIRST_FRAME_FIT_CROP
    assert rt._last_frame_resize_policy({"last_frame_resize": rt.LEGACY_FIRST_FRAME_FIT_AUTO}) == rt.FIRST_FRAME_FIT_PAD
    assert rt._last_frame_resize_policy({"last_frame_resize": rt.LEGACY_FIRST_FRAME_FIT_CROP}) == rt.FIRST_FRAME_FIT_CROP
    assert rt._reference_video_temporal_fit({"ref_video_temporal_fit": rt.LEGACY_REF_VIDEO_TEMPORAL_CORE}) == rt.REF_VIDEO_TEMPORAL_CORE
    assert rt._reference_video_temporal_fit({"ref_video_temporal_fit": rt.LEGACY_REF_VIDEO_TEMPORAL_HOLD}) == rt.REF_VIDEO_TEMPORAL_HOLD
    assert rt._reference_video_size({"ref_video_size": rt.LEGACY_REF_VIDEO_NATIVE}) == rt.REF_VIDEO_NATIVE
    assert rt._reference_video_size({"ref_video_size": rt.LEGACY_REF_VIDEO_640}) == rt.REF_VIDEO_640
    assert rt._reference_video_size({"ref_video_size": rt.LEGACY_REF_VIDEO_576}) == rt.REF_VIDEO_576
    assert rt._reference_video_size({"ref_video_size": rt.LEGACY_REF_VIDEO_512}) == rt.REF_VIDEO_512


def test_packed_visual_row_math_matches_current_h3_layout():
    rt = load_runtime()
    spatial = rt._packed_visual_spatial_rows(1344, 768)
    assert spatial == 1008
    assert rt._reference_video_latent_t(124) == 37
    assert spatial * rt._reference_video_latent_t(124) == 37296



def test_fresh_default_runtime_contract_resolves_to_native_h3_baseline():
    rt = load_runtime()
    assert rt.DEFAULT_MODE == rt.MODE_VIDEO
    assert rt.resolve_canvas({}) == (1344, 768)
    assert rt.resolved_timing(rt.DEFAULT_SECONDS)[:2] == (124, 124 / 24)
    assert rt.resolve_playback_fps() == 24.0
    assert rt._reference_video_fps({}) == 24.0
    assert rt._reference_video_size({}) == rt.REF_VIDEO_NATIVE
    assert rt._reference_video_temporal_fit({}) == rt.REF_VIDEO_TEMPORAL_CORE
    assert rt._keyframe_canvas_policy({}) == rt.KEYFRAME_CANVAS_ADAPTIVE
    assert rt._first_frame_resize_policy({}) == rt.FIRST_FRAME_FIT_PAD
    assert rt._last_frame_resize_policy({}) == rt.FIRST_FRAME_FIT_CROP



def test_reference_workflow_routes_whatever_filename_is_assigned_without_checkpoint_name_gate():
    rt = load_runtime()

    class CoreReferenceNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            return types.SimpleNamespace(result=("conditioning", "latent"))

    rt.h3.MiniMaxH3ReferenceToVideo = CoreReferenceNode

    class Bundle(rt.MiniMaxH3Bundle):
        clip = object()
        video_vae = object()
        audio_vae = object()
        calls = []

        def model_name_for(self, route):
            self.calls.append(("name", route))
            return "renamed_fl2v_experiment.safetensors"

        def model_for(self, route):
            self.calls.append(("load", route))
            return "model"

    bundle = Bundle()
    mode = {
        "mode": rt.MODE_VIDEO,
        "ref_images": {"ref_image_0": torch.zeros((1, 64, 64, 3), dtype=torch.float32)},
    }
    canvas = {"canvas": rt.CANVAS_NATIVE, "aspect_ratio": rt.DEFAULT_ASPECT_RATIO}
    model, context, compiled = rt.generate(bundle, mode, "", canvas, 5.0, 24.0)
    assert model == "model"
    assert context.task == "REF2VA"
    assert context.diffusion_model == "renamed_fl2v_experiment.safetensors"
    assert bundle.calls == [("name", "ref2va"), ("load", "ref2va")]


def test_playback_fps_is_direct_top_level_value():
    rt = load_runtime()
    assert rt.resolve_playback_fps() == 24.0
    assert rt.resolve_playback_fps(30) == 30.0
    for bad in [0, 121, float("nan"), "garbage"]:
        try:
            rt.resolve_playback_fps(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Expected invalid playback FPS to fail: {bad!r}")

def test_paired_video_audio_source_duration_mismatch_is_reported():
    rt = load_runtime()
    # 48 frames @24 fps = 2s source video. Paired audio is 3s.
    raw_video = {"ref_video_0": torch.zeros((48, 64, 64, 3))}
    prepared, records = rt._prepare_reference_videos(
        raw_video, {"ref_video_0": 24.0}, rt.REF_VIDEO_NATIVE, generated_frame_count=124
    )
    audio = {"waveform": torch.zeros((1, 2, 3 * 32000)), "sample_rate": 32000}
    paired, audio_records = rt._prepare_reference_audio_group(
        {"ref_video_audio_0": audio}, "ref_video_audio_", 5.0
    )
    report = rt.reference_report(
        {}, prepared, paired, {}, 1344, 768, rt.REF_IMAGE_MATCH, 124, records, audio_records
    )
    assert "Video 1 soundtrack duration warning" in report
    assert "source video is 2.000 s" in report
    assert "paired audio is 3.000 s" in report
    assert "advances later reference time by the longer stream" in report


def test_max_reference_image_mode_is_a_no_upscale_cap():
    rt = load_runtime()
    small = torch.zeros((1, 512, 512, 3))
    huge = torch.zeros((1, 4096, 4096, 3))
    assert rt._reference_image_target(small, 1344, 768, rt.REF_IMAGE_MAX) == (512, 512)
    assert rt._reference_image_target(huge, 1344, 768, rt.REF_IMAGE_MAX) == (2048, 2048)
    assert rt._core_ref_image_size(rt.LEGACY_REF_IMAGE_MAX_DETAIL) == "max"


def test_extreme_reference_image_aspect_is_advisory_not_output_policy():
    rt = load_runtime()
    extreme = {"ref_image_0": torch.zeros((1, 128, 1024, 3))}
    report = rt.reference_report(extreme, {}, {}, {}, 1344, 768, rt.REF_IMAGE_MATCH, 124)
    assert "reference-image 1:4–4:1 envelope" in report
    assert "Output aspect warning" not in report


def test_paired_soundtracks_do_not_consume_standalone_audio_file_limit():
    rt = load_runtime()
    videos = {f"ref_video_{i}": torch.zeros((48, 64, 64, 3)) for i in range(3)}
    paired = {
        f"ref_video_audio_{i}": {"waveform": torch.zeros((1, 2, 2 * 32000)), "sample_rate": 32000}
        for i in range(3)
    }
    standalone = {"ref_audio_0": {"waveform": torch.zeros((1, 2, 2 * 32000)), "sample_rate": 32000}}
    deviations = rt._published_reference_spec_deviations({}, videos, paired, standalone)
    assert not any("audio clips > documented" in item for item in deviations), deviations
    assert not any("audio total" in item for item in deviations), deviations


def test_standalone_audio_file_limit_still_reports_actual_standalone_inputs():
    rt = load_runtime()
    image = {"ref_image_0": torch.zeros((1, 64, 64, 3))}
    standalone = {
        f"ref_audio_{i}": {"waveform": torch.zeros((1, 2, 2 * 32000)), "sample_rate": 32000}
        for i in range(4)
    }
    deviations = rt._published_reference_spec_deviations(image, {}, {}, standalone)
    assert "4 standalone audio clips > documented 3" in deviations



def _core_reference_video_target(rt, width, height):
    target_w, target_h = rt.h3.adapt_canvas(width, height)
    if width * height < target_w * target_h:
        multiple = rt.h3.CANVAS_MULTIPLE
        target_w = max(multiple, round(width / multiple) * multiple)
        target_h = max(multiple, round(height / multiple) * multiple)
    return target_w, target_h


def test_reference_video_draft_targets_survive_core_without_reexpansion():
    rt = load_runtime()
    sources = [(1920, 1080), (1200, 1200), (1080, 1920), (1920, 800)]
    for mode in [rt.REF_VIDEO_640, rt.REF_VIDEO_576, rt.REF_VIDEO_512]:
        for source_w, source_h in sources:
            target = rt._reference_video_target(source_w, source_h, mode)
            assert target[0] % 32 == 0 and target[1] % 32 == 0
            # The source is deliberately larger than every draft target here, so
            # Easy will actually pre-downscale to this geometry. Current core's
            # no-upscale branch must then keep it exactly unchanged.
            assert source_w * source_h > target[0] * target[1]
            assert _core_reference_video_target(rt, *target) == target, (mode, (source_w, source_h), target)


def test_reference_video_hold_length_is_a_core_temporal_fixed_point():
    rt = load_runtime()
    refs = {"ref_video_0": torch.zeros((48, 64, 64, 3))}
    prepared, records = rt._prepare_reference_videos(
        refs, {"ref_video_0": 24.0}, rt.REF_VIDEO_NATIVE, generated_frame_count=124, temporal_fit=rt.REF_VIDEO_TEMPORAL_HOLD
    )
    n = prepared["ref_video_0"].shape[0]
    assert n == records["ref_video_0"]["aligned_frames"]
    assert n > records["ref_video_0"]["timeline_frames"]
    assert rt._reference_vae_frame_count(n) == n
    assert n <= 124


def test_reference_audio_normalization_truncates_to_output_and_upmixes_mono():
    rt = load_runtime()
    audio = {"waveform": torch.arange(6 * 32000, dtype=torch.float32).reshape(1, 1, -1), "sample_rate": 32000}
    prepared, records = rt._prepare_reference_audio_group({"ref_audio_0": audio}, "ref_audio_", 5.0)
    out = prepared["ref_audio_0"]["waveform"]
    assert out.shape == (1, 2, 5 * 32000)
    assert torch.equal(out[:, 0], out[:, 1])
    assert records["ref_audio_0"]["trimmed"] is True
    assert records["ref_audio_0"]["mono_upmixed"] is True
    assert abs(records["ref_audio_0"]["used_duration"] - 5.0) < 1e-9


def test_output_aspect_envelope_is_warning_not_gate():
    rt = load_runtime()
    assert rt._output_aspect_warning(1344, 768) is None
    warning = rt._output_aspect_warning(320, 1600)
    assert warning and "1:4–4:1" in warning and "experiments available" in warning


def test_current_mode_aliases_collapse_to_output_intent():
    rt = load_runtime()
    for legacy in [rt.LEGACY_MODE_REFERENCE, rt.LEGACY_MODE_REFERENCE_V2, rt.LEGACY_MODE_REFERENCE_V3, rt.LEGACY_MODE_BASE, rt.LEGACY_MODE_BASE_V2]:
        selected = {
            rt.LEGACY_MODE_REFERENCE: rt.MODE_VIDEO,
            rt.LEGACY_MODE_REFERENCE_V2: rt.MODE_VIDEO,
            rt.LEGACY_MODE_REFERENCE_V3: rt.MODE_VIDEO,
            rt.LEGACY_MODE_BASE: rt.MODE_VIDEO,
            rt.LEGACY_MODE_BASE_V2: rt.MODE_VIDEO,
        }.get(legacy, legacy)
        assert selected == rt.MODE_VIDEO
    for legacy in [rt.LEGACY_MODE_AUDIO, rt.LEGACY_MODE_AUDIO_V228, rt.LEGACY_MODE_AUDIO_V229]:
        assert legacy != rt.MODE_VIDEO


def test_video_mode_infers_reference_route_from_connected_refs():
    rt = load_runtime()
    class CoreReferenceNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ReferenceToVideo = CoreReferenceNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "whatever.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    bundle = Bundle()
    mode = {"mode": rt.MODE_VIDEO, "ref_images": {"ref_image_0": torch.zeros((1,64,64,3))}}
    model, context, _ = rt.generate(bundle, mode, "", {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert model == "model" and context.task == "REF2VA"
    assert bundle.calls == [("name","ref2va"),("load","ref2va")]


def test_video_mode_infers_reference_route_from_standalone_audio():
    rt = load_runtime()
    class CoreReferenceNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ReferenceToVideo = CoreReferenceNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "whatever.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    bundle = Bundle()
    audio = {"waveform": torch.zeros((1, 2, 32000)), "sample_rate": 32000}
    mode = {"mode": rt.MODE_VIDEO, "ref_audios": {"ref_audio_0": audio}}
    model, context, _ = rt.generate(bundle, mode, "", {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert model == "model" and context.task == "REF2VA"
    assert bundle.calls == [("name","ref2va"),("load","ref2va")]


def test_orphan_paired_reference_video_audio_is_rejected_as_wiring_error():
    rt = load_runtime()
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object()
    bundle = Bundle()
    audio = {"waveform": torch.zeros((1, 2, 32000)), "sample_rate": 32000}
    mode = {"mode": rt.MODE_VIDEO, "ref_video_audios": {"ref_video_audio_0": audio}}
    try:
        rt.generate(bundle, mode, "", {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    except ValueError as exc:
        assert "same-numbered reference video" in str(exc)
    else:
        raise AssertionError("Expected an orphan paired soundtrack to fail")


def test_video_mode_infers_endpoint_route_when_no_refs_connected():
    rt = load_runtime()
    class CoreBaseNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ImageToVideo = CoreBaseNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "whatever.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    bundle=Bundle()
    mode={"mode":rt.MODE_VIDEO,"keyframes":{"keyframe_0":torch.zeros((1,64,64,3))},"keyframe_role":rt.KEYFRAME_FIRST}
    model, context, _ = rt.generate(bundle, mode, "", {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert context.task == "I2VA"
    assert bundle.calls == [("name","fl2va"),("load","fl2va")]



def test_base_prompt_structure_still_uses_ref2va_route_when_reference_inputs_are_wired():
    rt = load_runtime()
    captured = {}
    class CoreReferenceNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ReferenceToVideo = CoreReferenceNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "base.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    bundle = Bundle()
    mode = {
        "mode": rt.MODE_VIDEO,
        "ref_images": {"ref_image_0": torch.zeros((1,64,64,3))},
    }
    prompt = "integrated_multimodal_description:\n[Shot 1] A woman walks.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A"
    model, context, compiled = rt.generate(bundle, mode, prompt, {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert model == "model"
    assert context.task == "REF2VA"
    assert context.diffusion_model == "base.safetensors"
    assert bundle.calls == [("name","ref2va"),("load","ref2va")]
    assert compiled == prompt
    assert "Prompt structure selected" not in context.reference_info


def test_reference_prompt_structure_uses_ref2va_route_and_ignores_endpoint_frames():
    rt = load_runtime()
    class CoreReferenceNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ReferenceToVideo = CoreReferenceNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "ref.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    bundle = Bundle()
    mode = {
        "mode": rt.MODE_VIDEO,
        "keyframes": {"keyframe_0": torch.zeros((1,64,64,3))},
        "ref_images": {"ref_image_0": torch.zeros((1,64,64,3))},
    }
    prompt = "subject_definitions:\n@Subject1 is shown in @Image1.\n\nsummary:\n[reference generation] Use @Subject1.\n\nretention_analysis:\n@Subject1: fully_preserved\n\ndetailed_description:\n[Shot 1] @Subject1 walks.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A"
    model, context, _ = rt.generate(bundle, mode, prompt, {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert model == "model"
    assert context.task == "REF2VA"
    assert context.diffusion_model == "ref.safetensors"
    assert bundle.calls == [("name","ref2va"),("load","ref2va")]
    assert "first/last-frame sockets remain connected but are not forwarded" in context.reference_info


def test_reference_style_prompt_without_reference_inputs_does_not_change_base_route():
    rt = load_runtime()
    captured = {}
    class CoreImageNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ImageToVideo = CoreImageNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "base.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    prompt = "subject_definitions:\nA character is described.\n\nsummary:\nGenerate a short scene."
    bundle = Bundle()
    model, context, compiled = rt.generate(bundle, {"mode": rt.MODE_VIDEO}, prompt, {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert model == "model"
    assert context.task == "T2VA"
    assert bundle.calls == [("name","fl2va"),("load","fl2va")]
    assert compiled == prompt
    assert captured["prompt"] == prompt


def test_mixed_endpoint_and_reference_conditioning_is_nonblocking_and_reference_inputs_take_native_route():
    rt = load_runtime()
    class CoreReferenceNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ReferenceToVideo = CoreReferenceNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "ref.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    bundle=Bundle()
    mode={
        "mode":rt.MODE_VIDEO,
        "keyframes":{"keyframe_0":torch.zeros((1,64,64,3))},
        "ref_images":{"ref_image_0":torch.zeros((1,64,64,3))},
    }
    model, context, _ = rt.generate(bundle, mode, "", {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert model == "model"
    assert context.task == "REF2VA"
    assert bundle.calls == [("name","ref2va"),("load","ref2va")]
    assert "first/last-frame sockets remain connected but are not forwarded" in context.reference_info


def test_audio_only_keeps_endpoint_base_route_instead_of_blocking():
    rt = load_runtime()
    captured = {}
    class CoreImageNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(result=("conditioning", "latent"))
    rt.h3.MiniMaxH3ImageToVideo = CoreImageNode
    class Bundle(rt.MiniMaxH3Bundle):
        clip = object(); video_vae = object(); audio_vae = object(); calls = []
        def model_name_for(self, route): self.calls.append(("name", route)); return "audio.safetensors"
        def model_for(self, route): self.calls.append(("load", route)); return "model"
    bundle=Bundle()
    mode={"mode":rt.MODE_AUDIO,"keyframes":{"keyframe_0":torch.zeros((1,64,64,3))}}
    model, context, _ = rt.generate(bundle, mode, "", {"canvas":rt.CANVAS_NATIVE,"aspect_ratio":"16:9"}, 5, 24)
    assert model == "model"
    assert context.task == "I2VA"
    assert (context.width, context.height) == (32, 32)
    assert captured["first_frame"] is not None
    assert bundle.calls == [("name","audio_fl2va"),("load","audio_fl2va")]


def test_adaptive_endpoint_aspect_makes_opening_resize_policy_runtime_irrelevant():
    rt = load_runtime()
    source = torch.zeros((1, 511, 777, 3), dtype=torch.float32)
    captured = {}

    class CoreImageNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(result=("conditioning", "latent"))

    rt.h3.MiniMaxH3ImageToVideo = CoreImageNode

    class Bundle(rt.MiniMaxH3Bundle):
        clip = object()
        video_vae = object()
        audio_vae = object()
        def model_name_for(self, route): return "model.safetensors"
        def model_for(self, route): return "model"

    mode = {
        "mode": rt.MODE_VIDEO,
        "keyframes": {"keyframe_0": source},
        "keyframe_role": rt.KEYFRAME_FIRST,
        "keyframe_canvas": rt.KEYFRAME_CANVAS_ADAPTIVE,
        "first_frame_resize": rt.FIRST_FRAME_FIT_CROP,
    }
    canvas = {"canvas": rt.CANVAS_NATIVE, "aspect_ratio": "16:9"}
    rt.generate(Bundle(), mode, "", canvas, 5.0, 24.0)
    assert captured["first_frame"] is source


def test_ending_frame_resize_policy_can_preserve_full_frame_before_core_crop():
    rt = load_runtime()
    source = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
    captured = {}

    class CoreImageNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(result=("conditioning", "latent"))

    rt.h3.MiniMaxH3ImageToVideo = CoreImageNode

    class Bundle(rt.MiniMaxH3Bundle):
        clip = object()
        video_vae = object()
        audio_vae = object()
        def model_name_for(self, route): return "model.safetensors"
        def model_for(self, route): return "model"

    mode = {
        "mode": rt.MODE_VIDEO,
        "keyframes": {"keyframe_0": source},
        "keyframe_role": rt.KEYFRAME_LAST,
        "keyframe_canvas": rt.KEYFRAME_CANVAS_FIXED,
        "last_frame_resize": rt.FIRST_FRAME_FIT_PAD,
    }
    canvas = {"canvas": rt.CANVAS_NATIVE, "aspect_ratio": "16:9"}
    result = rt.generate(Bundle(), mode, "", canvas, 5.0, 24.0)
    assert captured["first_frame"] is None
    assert captured["last_frame"] is not source
    assert tuple(captured["last_frame"].shape[1:3]) == (768, 1344)
    assert "Last frame: 512x512 -> wrapper aspect-preserving fit with replicate-edge padding" in result[1].reference_info


def test_default_ending_frame_policy_preserves_current_core_center_crop_behavior():
    rt = load_runtime()
    source = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
    prepared, note = rt._prepare_last_frame(source, 1344, 768, rt.DEFAULT_LAST_FRAME_RESIZE)
    assert prepared is source
    assert note is None
    report = rt.keyframe_report(
        None, source, 1344, 768, rt.KEYFRAME_CANVAS_FIXED,
        {"canvas": rt.CANVAS_NATIVE}, rt.DEFAULT_FIRST_FRAME_RESIZE,
        last_frame_resize=rt.DEFAULT_LAST_FRAME_RESIZE,
    )
    assert "aspect-preserving center crop to canvas" in report


def test_explicit_ending_frame_stretch_is_applied_before_core():
    rt = load_runtime()
    source = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
    prepared, note = rt._prepare_last_frame(source, 1344, 768, rt.FIRST_FRAME_FIT_STRETCH)
    assert prepared is not source
    assert tuple(prepared.shape[1:3]) == (768, 1344)
    assert note == "direct stretch to output dimensions"


def test_fixed_endpoint_aspect_applies_opening_resize_policy():
    rt = load_runtime()
    source = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
    captured = {}

    class CoreImageNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(result=("conditioning", "latent"))

    rt.h3.MiniMaxH3ImageToVideo = CoreImageNode

    class Bundle(rt.MiniMaxH3Bundle):
        clip = object()
        video_vae = object()
        audio_vae = object()
        def model_name_for(self, route): return "model.safetensors"
        def model_for(self, route): return "model"

    mode = {
        "mode": rt.MODE_VIDEO,
        "keyframes": {"keyframe_0": source},
        "keyframe_role": rt.KEYFRAME_FIRST,
        "keyframe_canvas": rt.KEYFRAME_CANVAS_FIXED,
        "first_frame_resize": rt.FIRST_FRAME_FIT_CROP,
    }
    canvas = {"canvas": rt.CANVAS_NATIVE, "aspect_ratio": "16:9"}
    rt.generate(Bundle(), mode, "", canvas, 5.0, 24.0)
    assert captured["first_frame"] is not source
    assert tuple(captured["first_frame"].shape[1:3]) == (768, 1344)

def test_audio_proxy_dimensions_are_minimum_core_canvas():
    rt = load_runtime()
    assert rt.AUDIO_PROXY_WIDTH == 32
    assert rt.AUDIO_PROXY_HEIGHT == 32
    assert rt.AUDIO_PROXY_WIDTH % rt.h3.CANVAS_MULTIPLE == 0
    assert rt.AUDIO_PROXY_HEIGHT % rt.h3.CANVAS_MULTIPLE == 0


def test_audio_mode_reference_path_routes_audio_model_and_forces_proxy_canvas():
    rt = load_runtime()

    class CoreReferenceNode:
        @classmethod
        def execute(cls, *args, **kwargs):
            assert kwargs["width"] == 32 and kwargs["height"] == 32
            return types.SimpleNamespace(result=("conditioning", "latent"))

    rt.h3.MiniMaxH3ReferenceToVideo = CoreReferenceNode

    class Bundle(rt.MiniMaxH3Bundle):
        clip = object()
        video_vae = object()
        audio_vae = object()
        calls = []
        def model_name_for(self, route):
            self.calls.append(("name", route)); return "audio-model.safetensors"
        def model_for(self, route):
            self.calls.append(("load", route)); return "model"

    bundle = Bundle()
    mode = {
        "mode": rt.MODE_AUDIO,
        "ref_images": {"ref_image_0": torch.zeros((1, 64, 64, 3), dtype=torch.float32)},
    }
    canvas = {"canvas": rt.CANVAS_NATIVE, "aspect_ratio": rt.DEFAULT_ASPECT_RATIO}
    model, context, _ = rt.generate(bundle, mode, "", canvas, 5.0, 24.0)
    assert model == "model"
    assert (context.width, context.height) == (32, 32)
    assert context.task == "I2A proxy"
    assert context.playback_fps == 24.0
    assert bundle.calls == [("name", "audio_ref2va"), ("load", "audio_ref2va")]


def test_audio_proxy_reference_image_keeps_native_area_conditioning():
    rt = load_runtime()
    source = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
    tw, th = rt._balanced_reference_image_target(512, 512, rt.DEFAULT_CUSTOM_WIDTH, rt.DEFAULT_CUSTOM_HEIGHT)
    assert (tw, th) == (1024, 1024)
    assert tw * th > rt.AUDIO_PROXY_WIDTH * rt.AUDIO_PROXY_HEIGHT * 100


def test_audio_mode_ignores_hidden_playback_fps_state():
    rt = load_runtime()
    assert rt.DEFAULT_PLAYBACK_FPS == 24.0
    # generate() explicitly pins Audio-first playback metadata to native 24 fps.
    source = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    assert 'out_fps = DEFAULT_PLAYBACK_FPS if selected_mode == MODE_AUDIO else resolve_playback_fps(playback_fps)' in source


def test_explicit_audio_proxy_canvas_resolves_to_32x32():
    rt = load_runtime()
    assert rt.resolve_canvas({"canvas": rt.CANVAS_AUDIO_PROXY, "aspect_ratio": "16:9"}) == (32, 32)


def test_angle_image_alias_compiles_to_native_picture():
    rt = load_runtime()
    assert rt._compile_reference_prompt("pose from <Image 3>", 3, 0, 0) == "pose from <Picture 3>"
    try:
        rt._compile_reference_prompt("pose from <Image 9>", 3, 0, 0)
    except ValueError as exc:
        assert "only 3 reference image(s)" in str(exc)
    else:
        raise AssertionError("unresolved <Image 9> should fail")

if __name__ == "__main__":
    checks = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for check in checks:
        check()
        print(f"PASS {check.__name__}")
    print(f"{len(checks)} reference-runtime checks passed")
