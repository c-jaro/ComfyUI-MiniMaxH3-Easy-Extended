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
    DEFAULT_SECONDS,
    DEFAULT_PLAYBACK_FPS,
    DEFAULT_ASPECT_RATIO,
    DEFAULT_CUSTOM_WIDTH,
    DEFAULT_CUSTOM_HEIGHT,
    DEFAULT_REF_VIDEO_FPS,
    DEFAULT_REF_VIDEO_FPS_OVERRIDE,
    MiniMaxH3Context,
    generate,
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
            tooltip="Endpoint conditioning. Leave empty for text-only; one image = first or last frame; two = both endpoints. Audio only keeps this base route active, but the visual target is only 32x32; Reference images preserve substantially more visual conditioning detail.",
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
            tooltip="Video + audio only. With 2 endpoint images, Image 2 is the opposite endpoint.",
        ),
        io.Combo.Input(
            "keyframe_canvas",
            display_name="Video aspect ratio source",
            options=[KEYFRAME_CANVAS_ADAPTIVE, KEYFRAME_CANVAS_FIXED],
            default=DEFAULT_KEYFRAME_CANVAS,
            tooltip="Video + audio only. Follow the endpoint-frame proportions, or use Output aspect ratio.",
        ),
        io.Combo.Input(
            "first_frame_resize",
            display_name="Opening frame resize",
            options=[FIRST_FRAME_FIT_PAD, FIRST_FRAME_FIT_CROP, FIRST_FRAME_FIT_STRETCH],
            default=DEFAULT_FIRST_FRAME_RESIZE,
            tooltip="Video + audio only. Keep, crop, or stretch the opening endpoint when its aspect differs from the output.",
        ),
    ]


def _reference_inputs() -> list[io.Input]:
    return [
        io.Combo.Input(
            "ref_image_size",
            display_name="Reference image resolution",
            options=[REF_IMAGE_MATCH, REF_IMAGE_MAX],
            default=DEFAULT_REF_IMAGE_SIZE,
            tooltip="Balanced to output area is an Easy policy that may upscale or downscale a still reference toward the output pixel area without stretching. The 2048px option follows current core's no-upscale cap and can be much heavier.",
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
            tooltip="Native 768P keeps the most reference detail. Lower values reduce reference cost.",
        ),
        io.Float.Input(
            "ref_video_fps",
            display_name="Video 1 source FPS",
            default=DEFAULT_REF_VIDEO_FPS,
            min=1.0,
            max=240.0,
            step=0.001,
            tooltip="FPS represented by Video 1. Video 2/3 use this too when their source FPS is 0.",
        ),
        io.Float.Input(
            "ref_video_fps_2",
            display_name="Video 2 source FPS",
            optional=True,
            default=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
            min=0.0,
            max=240.0,
            step=0.001,
            tooltip="0 = same as Video 1.",
        ),
        io.Float.Input(
            "ref_video_fps_3",
            display_name="Video 3 source FPS",
            optional=True,
            default=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
            min=0.0,
            max=240.0,
            step=0.001,
            tooltip="0 = same as Video 1.",
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
            tooltip="Reference video frame batches. Each clip is normalized independently to H3's 24 fps timeline.",
            template=io.Autogrow.TemplatePrefix(
                input=io.Image.Input("ref_video", tooltip="Reference-video IMAGE batch."),
                prefix="ref_video_",
                min=0,
                max=3,
            ),
        ),
        io.Autogrow.Input(
            "ref_video_audios",
            display_name="Audio paired with reference videos",
            optional=True,
            tooltip="Socket N pairs with Video N. Prompt <Audio N> numbering is independent and follows presentation order.",
            template=io.Autogrow.TemplatePrefix(
                input=io.Audio.Input("ref_video_audio", tooltip="Soundtrack paired by socket number with the corresponding reference video; prompt Audio numbering is independent"),
                prefix="ref_video_audio_",
                min=0,
                max=3,
            ),
        ),
        io.Autogrow.Input(
            "ref_audios",
            display_name="Standalone reference audio",
            optional=True,
            tooltip="Standalone reference audio. Autogrow adds another socket as you connect them, up to 3 clips; use separate clips for separate voice references.",
            template=io.Autogrow.TemplatePrefix(
                input=io.Audio.Input("ref_audio", tooltip="One standalone audio/voice reference. Connect it to reveal the next socket; up to 3 are supported."),
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
            tooltip="Video + audio output canvas. Easy shows the current megapixel count in the row label; endpoint-driven aspect ratios show the resolution-class approximation because the source-frame aspect is resolved at execution. Audio-only always uses its internal 32x32 proxy and ignores this setting.",
        ),
        io.Combo.Input(
            "aspect_ratio",
            display_name="Output aspect ratio",
            options=list(ASPECT_RATIOS),
            default=DEFAULT_ASPECT_RATIO,
            tooltip="Video + audio only. Used by non-Custom resolutions unless Video aspect ratio source follows an endpoint frame.",
        ),
        io.Int.Input(
            "width",
            display_name="Custom output width",
            default=DEFAULT_CUSTOM_WIDTH,
            min=32,
            max=nodes.MAX_RESOLUTION,
            step=32,
            tooltip="Video + audio only; used when Output resolution is Custom exact.",
        ),
        io.Int.Input(
            "height",
            display_name="Custom output height",
            default=DEFAULT_CUSTOM_HEIGHT,
            min=32,
            max=nodes.MAX_RESOLUTION,
            step=32,
            tooltip="Video + audio only; used when Output resolution is Custom exact.",
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
        audio_options, audio_default = selectors["audio_override"]
        text_options, text_default = selectors["text"]
        video_vae_options, video_vae_default = selectors["video_vae"]
        audio_vae_options, audio_vae_default = selectors["audio_vae"]
        return io.Schema(
            node_id="MiniMaxH3EasyLoader",
            display_name="MiniMax H3 Easy Loader",
            category=CATEGORY,
            description=(
                "Select the two conditioning models plus shared H3 components. Audio-only automatically reuses the matching conditioning model unless an override is selected. "
                "Every loadable safetensors/GGUF remains selectable; filenames are never capability gates."
            ),
            inputs=[
                io.Combo.Input(
                    "fl2va_model",
                    display_name="Text / frame model",
                    options=frame_options,
                    default=frame_default,
                    tooltip="Used for text-only and first/last-frame conditioning.",
                ),
                io.Combo.Input(
                    "ref2va_model",
                    display_name="Reference conditioning model",
                    options=reference_options,
                    default=reference_default,
                    tooltip="Used whenever Reference image/video/audio inputs are connected. Prompt structure only changes assistance/validation; it does not disable connected references.",
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
                io.Combo.Input(
                    "audio_model",
                    display_name="Audio-only model override",
                    options=audio_options,
                    default=audio_default,
                    tooltip="Auto uses the Text/frame or Reference model selected by the current connected conditioning inputs. Select a file only to force a separate audio-only model.",
                    advanced=True,
                ),
            ],
            outputs=[BundleIO.Output("h3_bundle", display_name="H3 Bundle")],
            search_aliases=["minimax h3 loader", "h3 easy loader"],
        )

    @classmethod
    def execute(cls, fl2va_model, ref2va_model, audio_model, text_encoder, video_vae, audio_vae) -> io.NodeOutput:
        return io.NodeOutput(load_bundle(fl2va_model, ref2va_model, audio_model, text_encoder, video_vae, audio_vae))


class MiniMaxH3Easy(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxH3EasyV4",
            display_name="MiniMax H3 Easy",
            category=CATEGORY,
            description=(
                "Static-input MiniMax H3 frontend. Mode only chooses normal video+audio versus audio-only output intent; "
                "prompt templates only change editor assistance. Connected media stay active independently of the chosen prompt template."
            ),
            inputs=[
                BundleIO.Input("h3_bundle", display_name="H3 Bundle"),
                io.Combo.Input(
                    "mode",
                    display_name="Mode",
                    options=[MODE_VIDEO, MODE_AUDIO],
                    default=DEFAULT_MODE,
                    tooltip="Only output intent: normal video+audio or audio-only 32x32 proxy. Prompt templates only affect editor assistance; they never enable, disable, or reroute connected media.",
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
                    tooltip="Video + audio only. Current core H3 center-crops a mismatched ending frame. Preserve full frame pads it before conditioning; Stretch is available only when distortion is intentional.",
                ),
            ],
            outputs=[
                io.Model.Output("model", display_name="Model"),
                ContextIO.Output("h3_context", display_name="H3 Context"),
                io.String.Output("compiled_prompt", display_name="Compiled Prompt"),
            ],
            search_aliases=["minimax h3", "h3", "hailuo h3", "ref2va", "fl2va", "t2a", "v2a"],
        )

    @classmethod
    def execute(
        cls,
        h3_bundle,
        mode=DEFAULT_MODE,
        keyframes=None,
        keyframe_role=DEFAULT_KEYFRAME_ROLE,
        keyframe_canvas=DEFAULT_KEYFRAME_CANVAS,
        first_frame_resize=DEFAULT_FIRST_FRAME_RESIZE,
        ref_image_size=DEFAULT_REF_IMAGE_SIZE,
        ref_images=None,
        ref_video_size=DEFAULT_REF_VIDEO_SIZE,
        ref_video_fps=DEFAULT_REF_VIDEO_FPS,
        ref_video_fps_2=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
        ref_video_fps_3=DEFAULT_REF_VIDEO_FPS_OVERRIDE,
        ref_video_temporal_fit=DEFAULT_REF_VIDEO_TEMPORAL_FIT,
        ref_videos=None,
        ref_video_audios=None,
        ref_audios=None,
        canvas=DEFAULT_CANVAS,
        aspect_ratio=DEFAULT_ASPECT_RATIO,
        width=DEFAULT_CUSTOM_WIDTH,
        height=DEFAULT_CUSTOM_HEIGHT,
        seconds=DEFAULT_SECONDS,
        prompt="",
        last_frame_resize=DEFAULT_LAST_FRAME_RESIZE,
    ) -> io.NodeOutput:
        mode_payload = {
            "mode": mode,
            "keyframes": keyframes or {},
            "keyframe_role": keyframe_role,
            "keyframe_canvas": keyframe_canvas,
            "first_frame_resize": first_frame_resize,
            "last_frame_resize": last_frame_resize,
            "ref_image_size": ref_image_size,
            "ref_images": ref_images or {},
            "ref_video_size": ref_video_size,
            "ref_video_fps": ref_video_fps,
            "ref_video_fps_2": ref_video_fps_2,
            "ref_video_fps_3": ref_video_fps_3,
            "ref_video_temporal_fit": ref_video_temporal_fit,
            "ref_videos": ref_videos or {},
            "ref_video_audios": ref_video_audios or {},
            "ref_audios": ref_audios or {},
        }
        canvas_payload = {
            "canvas": canvas,
            "aspect_ratio": aspect_ratio,
            "width": width,
            "height": height,
        }
        model, context, compiled = generate(h3_bundle, mode_payload, prompt, canvas_payload, seconds, DEFAULT_PLAYBACK_FPS)
        return io.NodeOutput(model, context, compiled)


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
            f"Conditioning: {conditioning_label}",
            f"Diffusion model: {h3_context.diffusion_model}",
            f"Output: {h3_context.width}x{h3_context.height}",
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
                {"new_id": "ref_video_fps", "old_id": "ref_video_fps"},
                {"new_id": "ref_video_fps_2", "old_id": "ref_video_fps_2"},
                {"new_id": "ref_video_fps_3", "old_id": "ref_video_fps_3"},
                {"new_id": "ref_video_temporal_fit", "old_id": "ref_video_temporal_fit"},
                {"new_id": "ref_videos", "old_id": "ref_videos"},
                {"new_id": "ref_video_audios", "old_id": "ref_video_audios"},
                {"new_id": "ref_audios", "old_id": "ref_audios"},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},
                {"new_idx": 1, "old_idx": 1},
                {"new_idx": 2, "old_idx": 2},
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
                {"new_id": "ref_video_fps", "old_id": "mode.ref_video_fps"},
                {"new_id": "ref_video_fps_2", "old_id": "mode.ref_video_fps_2"},
                {"new_id": "ref_video_fps_3", "old_id": "mode.ref_video_fps_3"},
                {"new_id": "ref_video_temporal_fit", "old_id": "mode.ref_video_temporal_fit"},
                {"new_id": "ref_videos", "old_id": "mode.ref_videos"},
                {"new_id": "ref_video_audios", "old_id": "mode.ref_video_audios"},
                {"new_id": "ref_audios", "old_id": "mode.ref_audios"},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},
                {"new_idx": 1, "old_idx": 1},
                {"new_idx": 2, "old_idx": 2},
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
                {"new_id": "last_frame_resize", "set_value": DEFAULT_LAST_FRAME_RESIZE},
                {"new_id": "ref_image_size", "old_id": "ref_image_size"},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},
                {"new_idx": 1, "old_idx": 1},
                {"new_idx": 2, "old_idx": 2},
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
