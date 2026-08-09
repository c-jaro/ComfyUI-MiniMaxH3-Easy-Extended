from __future__ import annotations

import nodes
from comfy_extras import nodes_audio
from comfy_api.v0_0_2 import ComfyAPI, ComfyExtension, io

from .model_loading import (
    MiniMaxH3Bundle,
    audio_vae_choices,
    diffusion_model_choices,
    load_bundle,
    loader_selector_options,
    text_encoder_choices,
    video_vae_choices,
)
from .runtime import (
    ASPECT_RATIOS,
    CANVAS_512,
    CANVAS_576,
    CANVAS_640,
    CANVAS_704,
    CANVAS_CUSTOM,
    CANVAS_NATIVE,
    KEYFRAME_FIRST,
    KEYFRAME_LAST,
    KEYFRAME_CANVAS_ADAPTIVE,
    KEYFRAME_CANVAS_FIXED,
    FIRST_FRAME_FIT_PAD,
    FIRST_FRAME_FIT_CROP,
    FIRST_FRAME_FIT_STRETCH,
    MODE_VIDEO,
    MODE_AUDIO,
    CONDITIONING_MODEL_FL2VA,
    CONDITIONING_MODEL_REF2VA,
    DEFAULT_CONDITIONING_MODEL,
    REF_IMAGE_MATCH,
    REF_IMAGE_MAX,
    REF_VIDEO_NATIVE,
    REF_VIDEO_640,
    REF_VIDEO_576,
    REF_VIDEO_512,
    REF_VIDEO_TEMPORAL_CORE,
    REF_VIDEO_TEMPORAL_HOLD,
    DEFAULT_MODE,
    DEFAULT_CANVAS,
    DEFAULT_KEYFRAME_ROLE,
    DEFAULT_KEYFRAME_CANVAS,
    DEFAULT_FIRST_FRAME_RESIZE,
    DEFAULT_LAST_FRAME_RESIZE,
    DEFAULT_REF_IMAGE_SIZE,
    DEFAULT_REF_VIDEO_SIZE,
    DEFAULT_REF_VIDEO_TEMPORAL_FIT,
    DEFAULT_REF_VIDEO_FPS,
    DEFAULT_REF_VIDEO_FPS_OVERRIDE,
    DEFAULT_SECONDS,
    DEFAULT_PLAYBACK_FPS,
    DEFAULT_ASPECT_RATIO,
    DEFAULT_CUSTOM_WIDTH,
    DEFAULT_CUSTOM_HEIGHT,
    MIXED_INPUT_FAMILIES_ERROR,
    MiniMaxH3Context,
    generate,
    validate_combo_inputs,
)

CATEGORY = "MiniMax H3 Easy"
api = ComfyAPI()
BundleIO = io.Custom("MINIMAX_H3_BUNDLE")
ContextIO = io.Custom("MINIMAX_H3_CONTEXT")


def _prompt_input() -> io.String.Input:
    # Use ComfyUI's built-in STRING widget contract as the serialization/source-of-truth
    # input. The richer Easy editor is attached after node construction by the frontend.
    # This keeps node creation functional even if the editor extension itself fails.
    return io.String.Input(
        "prompt",
        display_name="Prompt",
        default="",
        multiline=False,
        dynamic_prompts=False,
        tooltip="H3 prompt. MiniMax H3 Easy replaces this compact fallback widget with its structured editor after the node has been constructed.",
    )

def _keyframe_inputs() -> list[io.Input]:
    return [
        io.Autogrow.Input(
            "keyframes",
            display_name="First/last frame images",
            optional=True,
            tooltip="First/last-frame conditioning when no Reference media is connected. Leave empty for text-only; one image can be the first or last frame; two images provide both. Audio-only feeds endpoint frames through its 32x32 proxy, so Reference images preserve substantially more visual guidance detail.",
            template=io.Autogrow.TemplatePrefix(
                input=io.Image.Input("keyframe", tooltip="Connect a first-frame or last-frame image."),
                prefix="keyframe_",
                min=0,
                max=2,
            ),
        ),
        io.Combo.Input(
            "keyframe_role",
            display_name="Image 1 is",
            options=[KEYFRAME_FIRST, KEYFRAME_LAST],
            default=DEFAULT_KEYFRAME_ROLE,
            tooltip="Sets Image 1's endpoint role. With 2 frame images, Image 2 is the opposite endpoint.",
        ),
        io.Combo.Input(
            "keyframe_canvas",
            display_name="Video aspect ratio source",
            options=[KEYFRAME_CANVAS_ADAPTIVE, KEYFRAME_CANVAS_FIXED],
            default=DEFAULT_KEYFRAME_CANVAS,
            tooltip="Video + audio only. Follow the first/last-frame proportions, or use Output aspect ratio.",
        ),
        io.Combo.Input(
            "first_frame_resize",
            display_name="Opening frame resize",
            options=[FIRST_FRAME_FIT_PAD, FIRST_FRAME_FIT_CROP, FIRST_FRAME_FIT_STRETCH],
            default=DEFAULT_FIRST_FRAME_RESIZE,
            tooltip="When the output aspect is fixed, keep, crop, or stretch the opening frame. Audio-only applies this policy against its 32x32 proxy.",
        ),
    ]


def _reference_inputs() -> list[io.Input]:
    return [
        io.Combo.Input(
            "ref_image_size",
            display_name="Reference image resolution",
            options=[REF_IMAGE_MATCH, REF_IMAGE_MAX],
            default=DEFAULT_REF_IMAGE_SIZE,
            tooltip="Match output area gives each still roughly the output's pixel area for predictable conditioning-token cost. It may enlarge a small source, but enlargement creates no detail and can soften pixels. Preserve source detail does not intentionally upscale; it retains available source pixels up to the 2048px short-edge cap and can be much slower.",
        ),
        io.Autogrow.Input(
            "ref_images",
            display_name="Reference images",
            optional=True,
            template=io.Autogrow.TemplatePrefix(
                input=io.Image.Input("ref_image", tooltip="Reference image"),
                prefix="ref_image_",
                min=0,
                max=9,
            ),
        ),
        io.Combo.Input(
            "ref_video_size",
            display_name="Reference video resolution",
            options=[REF_VIDEO_NATIVE, REF_VIDEO_640, REF_VIDEO_576, REF_VIDEO_512],
            default=DEFAULT_REF_VIDEO_SIZE,
            tooltip="Caps reference-video geometry at the selected H3 resolution class without scaling a smaller source toward that class. H3 still rounds each edge to the nearest 32 pixels, which can slightly enlarge or reduce an edge. Lower classes reduce conditioning cost only when the source exceeds that cap; they can weaken fine motion, small details, or identity cues.",
        ),
        io.Combo.Input(
            "ref_video_temporal_fit",
            display_name="Reference video end handling",
            options=[REF_VIDEO_TEMPORAL_CORE, REF_VIDEO_TEMPORAL_HOLD],
            default=DEFAULT_REF_VIDEO_TEMPORAL_FIT,
            tooltip="Trim the tail, or pad with the last frame, to reach a valid H3 frame count.",
        ),
        io.Autogrow.Input(
            "ref_videos",
            display_name="Reference videos",
            optional=True,
            tooltip="Reference VIDEO inputs. Easy reads source frame rate and uses an exposed synchronized soundtrack only while that video's Use soundtrack control is enabled. Silent videos are valid. IMAGE frame batches are also accepted as legacy 24 fps silent references.",
            template=io.Autogrow.TemplatePrefix(
                input=io.MultiType.Input(
                    "ref_video",
                    types=[io.Video, io.Image],
                    tooltip="Reference video. VIDEO may carry a synchronized soundtrack and source frame rate; the per-video Use soundtrack control decides whether audio is conditioned. Legacy IMAGE frame batches are treated as silent 24 fps video.",
                ),
                prefix="ref_video_",
                min=0,
                max=3,
            ),
        ),
        io.Autogrow.Input(
            "ref_audios",
            display_name="Standalone reference audio",
            optional=True,
            tooltip="Standalone reference audio. Autogrow adds another socket as you connect them, up to 3 clips; use separate clips for separate audio roles or references.",
            template=io.Autogrow.TemplatePrefix(
                input=io.Audio.Input("ref_audio", tooltip="One standalone audio reference. Connect it to reveal the next socket; up to 3 are supported."),
                prefix="ref_audio_",
                min=0,
                max=3,
            ),
        ),
    ]


def _canvas_inputs() -> list[io.Input]:
    return [
        io.Combo.Input(
            "canvas",
            display_name="Output resolution",
            options=[CANVAS_NATIVE, CANVAS_704, CANVAS_640, CANVAS_576, CANVAS_512, CANVAS_CUSTOM],
            default=DEFAULT_CANVAS,
            tooltip="Video + audio output canvas. 768P and the draft values name H3 resolution classes; the resolved edge lengths depend on aspect ratio. Easy shows the current dimensions and megapixel count in the row label; first/last-frame-driven aspect ratios show a theoretical pre-alignment resolution-class range until execution resolves the source aspect. Custom exact values are rounded to the nearest 32 pixels. Audio-only always uses its internal 32x32 proxy and ignores this setting.",
        ),
        io.Combo.Input(
            "aspect_ratio",
            display_name="Output aspect ratio",
            options=list(ASPECT_RATIOS),
            default=DEFAULT_ASPECT_RATIO,
            tooltip="Video + audio only. Used by non-Custom resolutions unless Video aspect ratio source follows a first/last frame.",
        ),
        io.Int.Input(
            "width",
            display_name="Custom output width",
            default=DEFAULT_CUSTOM_WIDTH,
            min=32,
            max=nodes.MAX_RESOLUTION,
            step=32,
            tooltip="Video + audio only; used when Output resolution is Custom exact and rounded to the nearest 32 pixels.",
        ),
        io.Int.Input(
            "height",
            display_name="Custom output height",
            default=DEFAULT_CUSTOM_HEIGHT,
            min=32,
            max=nodes.MAX_RESOLUTION,
            step=32,
            tooltip="Video + audio only; used when Output resolution is Custom exact and rounded to the nearest 32 pixels.",
        ),
    ]

class MiniMaxH3EasyLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        diffusion_models = diffusion_model_choices()
        text_encoders = text_encoder_choices()
        video_vaes = video_vae_choices()
        audio_vaes = audio_vae_choices()
        selectors = loader_selector_options(diffusion_models, text_encoders, video_vaes, audio_vaes)
        frame_options, frame_default = selectors["frame"]
        reference_options, reference_default = selectors["reference"]
        text_options, text_default = selectors["text"]
        video_vae_options, video_vae_default = selectors["video_vae"]
        audio_vae_options, audio_vae_default = selectors["audio_vae"]
        return io.Schema(
            node_id="MiniMaxH3EasyLoader",
            display_name="MiniMax H3 Easy Loader",
            category=CATEGORY,
            description=(
                "Provision FL2VA and REF2VA checkpoints plus shared H3 components. The Easy node's Model control explicitly chooses which provision runs. "
                "Every loadable safetensors/GGUF remains selectable; filenames are never capability gates."
            ),
            inputs=[
                io.Combo.Input(
                    "fl2va_model",
                    display_name="FL2VA checkpoint",
                    options=frame_options,
                    default=frame_default,
                    tooltip="Checkpoint provision selected by FL2VA on the Easy node. Connected inputs independently choose the native conditioning builder.",
                ),
                io.Combo.Input(
                    "ref2va_model",
                    display_name="REF2VA checkpoint",
                    options=reference_options,
                    default=reference_default,
                    tooltip="Checkpoint provision selected by REF2VA on the Easy node. Connected inputs independently choose the native conditioning builder.",
                ),
                io.Combo.Input(
                    "text_encoder",
                    display_name="Text encoder",
                    options=text_options,
                    default=text_default,
                    tooltip="Shared H3 text/vision encoder.",
                ),
                io.Combo.Input(
                    "video_vae",
                    display_name="Video VAE",
                    options=video_vae_options,
                    default=video_vae_default,
                    tooltip="Shared H3 visual VAE.",
                ),
                io.Combo.Input(
                    "audio_vae",
                    display_name="Audio VAE",
                    options=audio_vae_options,
                    default=audio_vae_default,
                    tooltip="Shared H3 audio VAE.",
                ),
            ],
            outputs=[BundleIO.Output("h3_bundle", display_name="H3 Bundle")],
            search_aliases=["minimax h3 loader", "h3 easy loader"],
        )

    @classmethod
    def execute(cls, fl2va_model, ref2va_model, text_encoder, video_vae, audio_vae) -> io.NodeOutput:
        return io.NodeOutput(load_bundle(fl2va_model, ref2va_model, text_encoder, video_vae, audio_vae))


class MiniMaxH3Easy(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxH3EasyV4",
            display_name="MiniMax H3 Easy",
            category=CATEGORY,
            description=(
                "MiniMax H3 frontend with native Autogrow media inputs. Model selects a checkpoint provisioned by Easy Loader; "
                "connected Reference media choose Reference conditioning, otherwise text/first-last-frame conditioning is used."
            ),
            inputs=[
                BundleIO.Input("h3_bundle", display_name="H3 Bundle"),
                io.Combo.Input(
                    "mode",
                    display_name="Mode",
                    options=[MODE_VIDEO, MODE_AUDIO],
                    default=DEFAULT_MODE,
                    tooltip="Only output intent: normal video+audio or audio-only 32x32 proxy. A starter can set this and the endpoint role, but never changes Model, connections, or which connected media activate conditioning.",
                ),
                *_canvas_inputs(),
                io.Float.Input(
                    "seconds",
                    display_name="Requested duration (s)",
                    default=DEFAULT_SECONDS,
                    min=1.0,
                    max=30.0,
                    step=0.25,
                    tooltip="H3 runs on its native 24 fps timeline and snaps to a valid frame count.",
                ),
                *_keyframe_inputs(),
                *_reference_inputs(),
                _prompt_input(),
                # Append-only compatibility input: keep every pre-2.0.34 widget index stable.
                # The frontend visually moves this next to Opening frame resize.
                io.Combo.Input(
                    "last_frame_resize",
                    display_name="Ending frame resize",
                    options=[FIRST_FRAME_FIT_PAD, FIRST_FRAME_FIT_CROP, FIRST_FRAME_FIT_STRETCH],
                    default=DEFAULT_LAST_FRAME_RESIZE,
                    tooltip="Current core H3 center-crops a mismatched ending frame. Preserve full frame pads it before conditioning; Stretch is available only when distortion is intentional. Audio-only applies this policy against its 32x32 proxy.",
                ),
                # Append-only model selector. The frontend moves this above Mode so
                # legacy widget indices remain stable.
                io.Combo.Input(
                    "conditioning_model",
                    display_name="Model",
                    options=[CONDITIONING_MODEL_FL2VA, CONDITIONING_MODEL_REF2VA],
                    default=DEFAULT_CONDITIONING_MODEL,
                    optional=True,
                    tooltip="FL2VA or REF2VA checkpoint provision from MiniMax H3 Easy Loader. This does not filter inputs: connected Reference media choose the native Reference builder; otherwise text/first-last-frame conditioning is used. Audio-only uses the selected provision.",
                ),
                # Append-only per-slot policies. They stay optional so workflows
                # saved before these controls preserve the former use-audio path.
                *[
                    io.Boolean.Input(
                        f"ref_video_use_audio_{index}",
                        display_name=f"Use Video {index + 1} soundtrack",
                        default=True,
                        optional=True,
                        label_on="Use audio",
                        label_off="Muted",
                        tooltip=f"When muted, Reference video {index + 1} keeps its frames and timing but its embedded soundtrack is excluded from H3 conditioning.",
                    )
                    for index in range(3)
                ],
                # Append-only V2 migration state. Modern VIDEO values carry their
                # own frame rate, so the frontend keeps these IMAGE-batch fallbacks hidden.
                io.Float.Input(
                    "ref_video_fps",
                    display_name="Legacy Video 1 source FPS",
                    default=DEFAULT_REF_VIDEO_FPS,
                    min=0.01,
                    max=240.0,
                    step=0.01,
                    optional=True,
                    tooltip="Legacy IMAGE-batch fallback only. Modern VIDEO inputs carry their own source frame rate.",
                ),
                io.Float.Input(
                    "ref_video_fps_2",
                    display_name="Legacy Video 2 source FPS",
                    default=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
                    min=0.0,
                    max=240.0,
                    step=0.01,
                    optional=True,
                    tooltip="Legacy IMAGE-batch override. Zero inherits Video 1; modern VIDEO inputs carry their own frame rate.",
                ),
                io.Float.Input(
                    "ref_video_fps_3",
                    display_name="Legacy Video 3 source FPS",
                    default=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
                    min=0.0,
                    max=240.0,
                    step=0.01,
                    optional=True,
                    tooltip="Legacy IMAGE-batch override. Zero inherits Video 1; modern VIDEO inputs carry their own frame rate.",
                ),
            ],
            outputs=[
                io.Model.Output("model", display_name="Model"),
                ContextIO.Output("h3_context", display_name="H3 Context"),
            ],
            search_aliases=["minimax h3", "h3", "hailuo h3", "ref2va", "fl2va", "t2a", "v2a"],
        )

    @classmethod
    def validate_inputs(
        cls,
        mode=None,
        canvas=None,
        keyframe_role=None,
        keyframe_canvas=None,
        first_frame_resize=None,
        ref_image_size=None,
        ref_video_size=None,
        ref_video_temporal_fit=None,
        last_frame_resize=None,
        conditioning_model=None,
        keyframes=None,
        ref_images=None,
        ref_videos=None,
        ref_audios=None,
    ) -> bool | str:
        validation = validate_combo_inputs(
            mode=mode,
            canvas=canvas,
            keyframe_role=keyframe_role,
            keyframe_canvas=keyframe_canvas,
            first_frame_resize=first_frame_resize,
            ref_image_size=ref_image_size,
            ref_video_size=ref_video_size,
            ref_video_temporal_fit=ref_video_temporal_fit,
            last_frame_resize=last_frame_resize,
            conditioning_model=conditioning_model,
        )
        if validation is not True:
            return validation

        def connected(group) -> bool:
            return isinstance(group, dict) and any(value is not None for value in group.values())

        if connected(keyframes) and any(connected(group) for group in (ref_images, ref_videos, ref_audios)):
            return MIXED_INPUT_FAMILIES_ERROR
        return True

    @classmethod
    def execute(
        cls,
        h3_bundle,
        mode=DEFAULT_MODE,
        conditioning_model=None,
        keyframes=None,
        keyframe_role=DEFAULT_KEYFRAME_ROLE,
        keyframe_canvas=DEFAULT_KEYFRAME_CANVAS,
        first_frame_resize=DEFAULT_FIRST_FRAME_RESIZE,
        ref_image_size=DEFAULT_REF_IMAGE_SIZE,
        ref_images=None,
        ref_video_size=DEFAULT_REF_VIDEO_SIZE,
        ref_video_temporal_fit=DEFAULT_REF_VIDEO_TEMPORAL_FIT,
        ref_videos=None,
        ref_audios=None,
        canvas=DEFAULT_CANVAS,
        aspect_ratio=DEFAULT_ASPECT_RATIO,
        width=DEFAULT_CUSTOM_WIDTH,
        height=DEFAULT_CUSTOM_HEIGHT,
        seconds=DEFAULT_SECONDS,
        prompt="",
        last_frame_resize=DEFAULT_LAST_FRAME_RESIZE,
        ref_video_use_audio_0=True,
        ref_video_use_audio_1=True,
        ref_video_use_audio_2=True,
        ref_video_fps=DEFAULT_REF_VIDEO_FPS,
        ref_video_fps_2=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
        ref_video_fps_3=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
    ) -> io.NodeOutput:
        mode_payload = {
            "mode": mode,
            "conditioning_model": conditioning_model,
            "keyframes": keyframes or {},
            "keyframe_role": keyframe_role,
            "keyframe_canvas": keyframe_canvas,
            "first_frame_resize": first_frame_resize,
            "last_frame_resize": last_frame_resize,
            "ref_image_size": ref_image_size,
            "ref_images": ref_images or {},
            "ref_video_size": ref_video_size,
            "ref_video_temporal_fit": ref_video_temporal_fit,
            "ref_videos": ref_videos or {},
            "ref_video_use_audio_0": ref_video_use_audio_0,
            "ref_video_use_audio_1": ref_video_use_audio_1,
            "ref_video_use_audio_2": ref_video_use_audio_2,
            "ref_video_fps": ref_video_fps,
            "ref_video_fps_2": ref_video_fps_2,
            "ref_video_fps_3": ref_video_fps_3,
            "ref_audios": ref_audios or {},
        }
        canvas_payload = {
            "canvas": canvas,
            "aspect_ratio": aspect_ratio,
            "width": width,
            "height": height,
        }
        model, context = generate(h3_bundle, mode_payload, prompt, canvas_payload, seconds, DEFAULT_PLAYBACK_FPS)
        return io.NodeOutput(model, context)


class MiniMaxH3EasyOutput(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxH3EasyOutput",
            display_name="MiniMax H3 Easy Output",
            category=CATEGORY,
            description="Unpack the H3 Context for a standard sampler/video decode chain.",
            inputs=[ContextIO.Input("h3_context", display_name="H3 Context")],
            outputs=[
                io.Conditioning.Output("positive", display_name="Positive"),
                io.Latent.Output("latent", display_name="Latent"),
                io.Vae.Output("video_vae", display_name="Video VAE"),
                io.Vae.Output("audio_vae", display_name="Audio VAE"),
                io.Float.Output("fps", display_name="Output playback FPS"),
            ],
        )

    @classmethod
    def execute(cls, h3_context) -> io.NodeOutput:
        if not isinstance(h3_context, MiniMaxH3Context):
            raise ValueError("Connect the H3 Context output from MiniMax H3 Easy.")
        return io.NodeOutput(
            h3_context.conditioning,
            h3_context.latent,
            h3_context.video_vae,
            h3_context.audio_vae,
            h3_context.playback_fps,
        )


class MiniMaxH3EasyAudioDecode(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxH3EasyAudioDecode",
            display_name="MiniMax H3 Easy Audio Decode",
            category=CATEGORY,
            description="Decode only the audio stream from a sampled MiniMax H3 nested AV latent. The video stream is not VAE-decoded.",
            inputs=[
                io.Latent.Input("samples", display_name="Sampled H3 latent"),
                ContextIO.Input("h3_context", display_name="H3 Context"),
            ],
            outputs=[io.Audio.Output("audio", display_name="Audio")],
            search_aliases=["h3 audio", "h3 t2a", "h3 audio decode"],
        )

    @classmethod
    def execute(cls, samples, h3_context) -> io.NodeOutput:
        if not isinstance(h3_context, MiniMaxH3Context):
            raise ValueError("Connect the H3 Context output from MiniMax H3 Easy.")
        latent = samples.get("samples") if isinstance(samples, dict) else None
        if latent is None or not bool(getattr(latent, "is_nested", False)):
            raise ValueError("MiniMax H3 Easy Audio Decode expects a sampled H3 nested audio-video latent.")
        return io.NodeOutput(nodes_audio.vae_decode_audio(h3_context.audio_vae, samples))


class MiniMaxH3EasyInfo(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxH3EasyInfo",
            display_name="MiniMax H3 Easy Info",
            category=CATEGORY,
            description="Inspect the exact snapped H3 output/timeline plus first/last-frame and reference input geometry.",
            inputs=[ContextIO.Input("h3_context", display_name="H3 Context")],
            outputs=[
                io.String.Output("info", display_name="Info"),
                io.Int.Output("frames", display_name="Frames"),
                io.Float.Output("effective_seconds", display_name="Effective seconds"),
                io.Int.Output("width", display_name="Width"),
                io.Int.Output("height", display_name="Height"),
                io.Float.Output("playback_fps", display_name="Output playback FPS"),
            ],
            search_aliases=["h3 timing", "h3 reference sizes", "h3 info"],
        )

    @classmethod
    def execute(cls, h3_context) -> io.NodeOutput:
        if not isinstance(h3_context, MiniMaxH3Context):
            raise ValueError("Connect the H3 Context output from MiniMax H3 Easy.")
        conditioning_label = h3_context.task
        lines = [
            f"Conditioning builder: {h3_context.conditioning_builder}",
            f"Task: {conditioning_label}",
            f"Diffusion model: {h3_context.diffusion_model}",
            f"Output: {h3_context.width}x{h3_context.height} ({h3_context.width * h3_context.height / 1_000_000:.3f} MP)",
            f"H3 timeline: {h3_context.frame_count} frames @ 24 fps = {h3_context.effective_seconds:.3f} s",
            f"Playback FPS: {h3_context.playback_fps:g}",
        ]
        if h3_context.reference_info:
            lines.extend(("Input geometry:", h3_context.reference_info))
        return io.NodeOutput(
            "\n".join(lines),
            h3_context.frame_count,
            h3_context.effective_seconds,
            h3_context.width,
            h3_context.height,
            h3_context.playback_fps,
        )


class MiniMaxH3EasyExtension(ComfyExtension):
    async def on_load(self) -> None:
        await api.node_replacement.register(io.NodeReplace(
            new_node_id="MiniMaxH3EasyV4",
            old_node_id="MiniMaxH3EasyV3",
            input_mapping=[
                {"new_id": "h3_bundle", "old_id": "h3_bundle"},
                {"new_id": "mode", "old_id": "mode"},
                {"new_id": "prompt", "old_id": "prompt"},
                {"new_id": "canvas", "old_id": "canvas"},
                {"new_id": "aspect_ratio", "old_id": "aspect_ratio"},
                {"new_id": "width", "old_id": "width"},
                {"new_id": "height", "old_id": "height"},
                {"new_id": "seconds", "old_id": "seconds"},
                {"new_id": "keyframes", "old_id": "keyframes"},
                {"new_id": "keyframe_role", "old_id": "keyframe_role"},
                {"new_id": "keyframe_canvas", "old_id": "keyframe_canvas"},
                {"new_id": "first_frame_resize", "old_id": "first_frame_resize"},
                {"new_id": "last_frame_resize", "set_value": DEFAULT_LAST_FRAME_RESIZE},
                {"new_id": "ref_image_size", "old_id": "ref_image_size"},
                {"new_id": "ref_images", "old_id": "ref_images"},
                {"new_id": "ref_video_size", "old_id": "ref_video_size"},
                {"new_id": "ref_video_temporal_fit", "old_id": "ref_video_temporal_fit"},
                {"new_id": "ref_videos", "old_id": "ref_videos"},
                {"new_id": "ref_audios", "old_id": "ref_audios"},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},
                {"new_idx": 1, "old_idx": 1},
            ],
        ))

        await api.node_replacement.register(io.NodeReplace(
            new_node_id="MiniMaxH3EasyV4",
            old_node_id="MiniMaxH3EasyV2",
            input_mapping=[
                {"new_id": "h3_bundle", "old_id": "h3_bundle"},
                {"new_id": "mode", "old_id": "mode"},
                {"new_id": "prompt", "old_id": "prompt"},
                {"new_id": "canvas", "old_id": "canvas"},
                {"new_id": "aspect_ratio", "old_id": "canvas.aspect_ratio"},
                {"new_id": "width", "old_id": "canvas.width"},
                {"new_id": "height", "old_id": "canvas.height"},
                {"new_id": "seconds", "old_id": "seconds"},
                {"new_id": "keyframes", "old_id": "mode.keyframes"},
                {"new_id": "keyframe_role", "old_id": "mode.keyframe_role"},
                {"new_id": "keyframe_canvas", "old_id": "mode.keyframe_canvas"},
                {"new_id": "first_frame_resize", "old_id": "mode.first_frame_resize"},
                {"new_id": "last_frame_resize", "set_value": DEFAULT_LAST_FRAME_RESIZE},
                {"new_id": "ref_image_size", "old_id": "mode.ref_image_size"},
                {"new_id": "ref_images", "old_id": "mode.ref_images"},
                {"new_id": "ref_video_size", "old_id": "mode.ref_video_size"},
                {"new_id": "ref_video_temporal_fit", "old_id": "mode.ref_video_temporal_fit"},
                {"new_id": "ref_videos", "old_id": "mode.ref_videos"},
                {"new_id": "ref_video_fps", "old_id": "mode.ref_video_fps"},
                {"new_id": "ref_video_fps_2", "old_id": "mode.ref_video_fps_2"},
                {"new_id": "ref_video_fps_3", "old_id": "mode.ref_video_fps_3"},
                {"new_id": "ref_audios", "old_id": "mode.ref_audios"},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},
                {"new_idx": 1, "old_idx": 1},
            ],
        ))

        await api.node_replacement.register(io.NodeReplace(
            new_node_id="MiniMaxH3EasyV4",
            old_node_id="MiniMaxH3Easy",
            old_widget_ids=[
                "mode", "prompt", "h3_prompt_mentions", "resolution",
                "aspect_ratio", "width", "height", "seconds", "advanced",
                "fps", "keyframe_role", "ref_image_size", "reference_mention_mode",
            ],
            input_mapping=[
                {"new_id": "h3_bundle", "old_id": "h3_bundle"},
                {"new_id": "mode", "old_id": "mode"},
                {"new_id": "prompt", "old_id": "prompt"},
                {"new_id": "canvas", "set_value": CANVAS_NATIVE},
                {"new_id": "aspect_ratio", "old_id": "aspect_ratio"},
                {"new_id": "width", "old_id": "width"},
                {"new_id": "height", "old_id": "height"},
                {"new_id": "seconds", "old_id": "seconds"},
                {"new_id": "keyframe_role", "old_id": "keyframe_role"},
                {"new_id": "keyframe_canvas", "set_value": DEFAULT_KEYFRAME_CANVAS},
                {"new_id": "first_frame_resize", "set_value": DEFAULT_FIRST_FRAME_RESIZE},
                {"new_id": "last_frame_resize", "set_value": DEFAULT_LAST_FRAME_RESIZE},
                {"new_id": "ref_image_size", "old_id": "ref_image_size"},
                {"new_id": "ref_video_size", "set_value": DEFAULT_REF_VIDEO_SIZE},
                {"new_id": "ref_video_temporal_fit", "set_value": DEFAULT_REF_VIDEO_TEMPORAL_FIT},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},
                {"new_idx": 1, "old_idx": 1},
            ],
        ))

    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            MiniMaxH3EasyLoader,
            MiniMaxH3Easy,
            MiniMaxH3EasyOutput,
            MiniMaxH3EasyAudioDecode,
            MiniMaxH3EasyInfo,
        ]
