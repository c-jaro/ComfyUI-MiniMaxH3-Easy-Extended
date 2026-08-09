# MiniMax H3 Easy Extended for ComfyUI

A compact workflow frontend for ComfyUI's native MiniMax H3 implementation. It provisions the two H3 checkpoint families, prepares first/last-frame and Reference media, and adds a structured prompt editor based on MiniMax's published Base and Reference prompt guides.

> Extended fork of [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy).

## What it adds

- one Loader for FL2VA, REF2VA, the H3 text encoder, video VAE, and audio VAE
- an explicit Model selector that does not discard or filter connected inputs
- text, first-frame, last-frame, first-and-last-frame, Reference, and audio-only workflows
- Autogrow Reference inputs for up to 9 images, 3 videos, and 3 standalone audio clips
- per-video soundtrack controls, including selective muting
- output, endpoint, Reference-image, and Reference-video preprocessing controls
- H3-aware templates, autocomplete, editable presets, validation, and Guide navigation
- a standard sampler/decode output node, audio-only decode node, and resolved-timing Info node

<p align="center">
<img width="32%" alt="Reference prompt editor" src="https://github.com/user-attachments/assets/ebe9b992-0807-41fe-808b-4d98e2a233d7" />
<img width="32%" alt="Text-to-video prompt editor" src="https://github.com/user-attachments/assets/6a082dca-902a-4de4-9b5a-3d860a17ff62" />
<img width="32%" alt="Prompt editor after changing mode" src="https://github.com/user-attachments/assets/3fcff403-f646-442e-a8e3-370bbca8f26f" />
</p>

## Requirements and installation

This extension requires a current ComfyUI build containing native `comfy_extras.nodes_minimax_h3` support. It adds no Python package dependencies.

Clone or copy the repository into:

```text
ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-Easy-Extended
```

Put `.safetensors` model components in ComfyUI's normal model folders:

```text
ComfyUI/models/diffusion_models/   FL2VA and REF2VA diffusion weights
ComfyUI/models/text_encoders/      H3 text/vision encoder
ComfyUI/models/vae/                H3 video VAE and audio VAE
```

ComfyUI's current H3 template publishes the shared components and FL2VA baseline in [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3). Easy Loader prefers those basenames plus the matching REF2VA basename:

| Component | Baseline file | ComfyUI folder |
| --- | --- | --- |
| FL2VA | [`minimax_h3_fl2va_pruned_int8_convrot.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors) | `models/diffusion_models` |
| REF2VA | [`minimax_h3_ref2va_pruned_int8_convrot.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/main/diffusion_models) | `models/diffusion_models` |
| Text encoder | [`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) | `models/text_encoders` |
| Video VAE | [`minimax_h3_video_vae_fp16.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/vae/minimax_h3_video_vae_fp16.safetensors) | `models/vae` |
| Audio VAE | [`minimax_h3_audio_vae_fp32.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/vae/minimax_h3_audio_vae_fp32.safetensors) | `models/vae` |

The included workflow records another compatible quantized encoder/video-VAE pair. If any saved selection is unavailable, choose the installed equivalent in Easy Loader. Files may live in subfolders and compatible alternate conversions remain selectable; Easy does not infer task capability from filenames.

Diffusion weights and text encoders may also be `.gguf`; VAEs must be `.safetensors`. GGUF discovery follows the `unet_gguf` and `clip_gguf` categories registered by the installed ComfyUI-GGUF extension, so use that extension's folder setup. GGUF remains conversion/loader dependent. The Easy Loader lists compatible file extensions without guessing capability from filenames.

Restart ComfyUI after installing or updating the extension.

## Quick start

1. Add **MiniMax H3 Easy Loader** and select both diffusion provisions plus the shared encoder and VAEs.
2. Connect **H3 Bundle** to **MiniMax H3 Easy**.
3. Choose **Model**: `FL2VA` or `REF2VA`.
4. Choose **Mode**: normal `Video + audio` or `Audio only (32x32 proxy)`.
5. Leave media empty for text-only, connect one or two first/last-frame images, or connect Reference image/video/audio inputs.
6. Press **Tab** in an empty prompt and choose a starter, or write freely and use the contextual helpers.
7. Connect **Model** to the guider and scheduler. Connect **H3 Context** to **MiniMax H3 Easy Output**, then feed its conditioning and latent into the sampler/decode chain.

The included [example workflow](workflow/minimax_h3_easy-extended.json) uses current ComfyUI core nodes and shows the complete load, sample, decode, assemble, and save path.

## Model, Mode, builder, and grammar are independent

This distinction is the core workflow rule:

| Signal | What it decides | What it does not decide |
| --- | --- | --- |
| **Model** | Which Loader checkpoint provision runs: FL2VA or REF2VA | Conditioning builder, prompt grammar, or connected media |
| **Mode** | Video plus audio output, or audio-only through a 32x32 proxy | Model or conditioning builder |
| **Connected inputs** | Reference media select the native Reference builder; otherwise Easy uses text/first-last-frame conditioning | Checkpoint provision or prompt grammar |
| **Prompt structure** | Editor suggestions, validation, and recognized Base/Reference grammar | Model or conditioning builder |
| **Downstream LoRAs/patches** | Modify the Model output after Easy | Easy does not inspect or classify them |

Consequences:

- FL2VA with Reference conditioning and REF2VA-style prompting is allowed.
- REF2VA can be selected without Reference inputs.
- Choosing a starter never changes Model or connections. It changes only matching output intent and, where applicable, the first/last-frame role.
- First/last-frame inputs and Reference inputs cannot be connected together because current native H3 builders cannot consume both families in one call. Easy reports the conflict instead of silently ignoring one family.

Switching between two different checkpoint files reloads the diffusion model. Selecting the same file for both Loader provisions avoids that reload because the bundle caches by actual filename.

## Prompt editor

The editor is designed to close the mechanical gap between an ordinary draft and the structures described by MiniMax's guides:

- [Base prompt-writing guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)
- [Reference prompt-writing guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)

It assists with documented structure and vocabulary while keeping every inserted field editable. It does not send prompts to a remote rewriting service.

### Starters and editing

Press **Tab** in an empty prompt to choose Custom, T2V, I2V, L2V, FL2V, R2V, T2A, R2A, I2A, V2A, or A2A. On an unstructured draft, wrapper actions preserve the prose inside a suitable Base timeline or Reference section; blank-template actions are labeled separately.

T2A, R2A, I2A, V2A, and A2A are Easy names for audio-only proxy workflows, not extra official MiniMax task types.

| Input | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Next or previous editable field |
| Arrow keys + `Enter` | Select a contextual choice |
| `@` | Connected Reference media and defined subjects |
| `[` | Shot, task, and dialogue-language helpers |
| `#` | Dialogue, singing, and voiceover helpers |
| `(` | Speaker IDs where supported |
| `:` | Reference retention choices |

Known placeholders are visibly selected before replacement. Open-ended fields put **Custom** first; fixed H3 vocabularies expose their finite choices. Inserted presets such as `high angle`, `extreme close-up`, and dialogue language tags remain replaceable by clicking them again.

### Guide and validation

The persistent status separates:

- **Provision**: selected Loader checkpoint slot
- **Builder**: conditioning path selected by physical inputs
- **Grammar** or **Helper**: prompt structure recognized by the editor

The **Guide** count represents actual editable targets, including missing sections, placeholders, ordering defects, and semantic issues with a known text range. Clicking Guide selects the next target. It does not rewrite text until an explicit scaffold or replacement action is chosen.

Reference `summary`, `overall_soundscape`, and `non_diegetic_music` use continuous paragraphs; blank lines remain separators between top-level sections. `<scenetrans>` is for the same spoken or sung line continuing across a shot cut. `<cutoff>` is for a line truncated by the end of the generated video.

The detailed editor contract and edge cases are documented in [MiniMax H3 Easy V4](web/docs/MiniMaxH3EasyV4.md).

## Reference media

Type `@` to insert readable aliases:

| Alias | Meaning |
| --- | --- |
| `@ImageN` | Connected Reference image |
| `@VideoN` | Connected Reference video's visible frames or timeline role |
| `@VideoAudioN` | Enabled soundtrack exposed by Reference Video N |
| `@AudioN` | Connected standalone Reference audio |
| `@SubjectN` | Prompt-defined subject tracked across references and shots |

Selecting an alias opens role-specific follow-up templates rather than leaving an unexplained bare token. Easy compiles readable aliases to the native H3 media ordinals at execution.

`@VideoN` and `@VideoAudioN` are deliberately separate. Muting **Use Video N soundtrack** excludes embedded audio from conditioning but preserves that video's frames, source timing, and visual prompt role. A silent or muted video is valid, but its soundtrack alias cannot be used as an audio reference.

Reference videos accept ComfyUI `VIDEO` inputs and read their source frame rate. Legacy IMAGE frame batches are accepted as silent 24 fps videos.

## Resolution, timing, and media policies

### Output

- H3 conditioning uses a native 24 fps timeline.
- Requested duration is 1 to 30 seconds and snaps to a valid H3 frame count, so effective duration may differ slightly.
- Native 16:9 currently resolves to `1344 x 768`, or `1.032192 MP` (`1.03 MP` in the UI).
- Draft classes are available at 704, 640, 576, and 512 short-edge classes.
- `Custom exact` values are rounded to the nearest 32 pixels.
- Audio-only still samples a nested audio-video latent using an internal 32x32 proxy. Use **MiniMax H3 Easy Audio Decode** when only the audio stream is needed.

### First and last frames

One connected image can be the opening or ending frame; two images provide both endpoints. The output aspect can follow the endpoint image or stay on the selected aspect ratio. Mismatched frames can be padded, center-cropped, or deliberately stretched.

### Reference images

- **Match output area (predictable token cost)** resamples toward the output's pixel area. It may enlarge a small source, but enlargement creates no additional detail.
- **Preserve source detail (2048px short-edge cap; slower)** keeps available source pixels up to the native cap without intentional upscaling.

### Reference videos

The 768, 640, 576, and 512 choices are resolution-class caps, not forced target sizes. Smaller sources are not intentionally enlarged toward the selected class; nearest-32 alignment can still adjust an edge slightly.

- **Trim tail to valid H3 frame count** follows the core snap-down behavior.
- **Keep last frame (pad to valid H3 length)** preserves the source interval and repeats its final frame to a valid length.

Low-FPS draft references are downscaled before 24 fps repetition, avoiding repeated full-resolution resize work for identical frames.

## Included nodes

| Node | Purpose |
| --- | --- |
| **MiniMax H3 Easy Loader** | Load both diffusion provisions and shared H3 components |
| **MiniMax H3 Easy** | Select output intent/model, prepare conditioning, and edit the prompt |
| **MiniMax H3 Easy Output** | Unpack conditioning, latent, VAEs, and playback FPS for a normal sampler chain |
| **MiniMax H3 Easy Audio Decode** | Decode only audio from a sampled nested H3 latent |
| **MiniMax H3 Easy Info** | Report exact model, builder, dimensions, megapixels, snapped frames, duration, and input geometry |

## Seeds and reproducibility

Easy does not own the sampler seed. The bundled workflow's downstream **RandomNoise** node starts at seed `0` with automatic randomization after each generation. Set that node to fixed for repeatable sampling noise.

The current native H3 conditioning nodes expose no separate Reference-conditioning seed control.

## Scope and limitations

- Prompt assistance covers the deterministic published structure, task/retention vocabulary, media aliases, and native ComfyUI interleaving path.
- Exact hosted-API parity is not claimed because undocumented server-side prompt rewriting, if any, is unavailable to the local encoder path.
- Filename selection is intentionally permissive. A listed weight is not proof that its architecture or conversion is compatible with the installed loader.
- The project is still evolving; saved workflow compatibility is preserved where practical, but UI details may change.

## Credits and license

Based on [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy) by **nkxx188**.

The original MIT license and copyright notice are retained in [LICENSE](LICENSE).
