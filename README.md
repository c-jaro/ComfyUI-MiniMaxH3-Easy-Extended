# ComfyUI-MiniMaxH3-Easy-Extended

> extended fork of [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy).

Adds broader MiniMax H3 workflow support, improved reference handling, and expanded prompt tooling on top of the original Easy nodes.

## Main changes

- FL2VA / Ref2VA routing based on connected inputs
- T2VA, I2VA, first/last-frame, reference and audio workflows
- improved image, video and reference preprocessing
- H3-specific prompt templates and validation
- `@ImageN`, `@VideoN`, `@AudioN` and `@SubjectN` references
- follow-up templates after inserting an `@` reference
- dialogue helpers and expanded language options
- audio-only mode
- selected model / route info and compiled prompt preview
- loader fixes and compatibility with older Easy workflows
- regression tests for routing, references and prompt behavior

Still WIP. UI and behavior may change.

## Usage

Load the models with **MiniMax H3 Easy Loader**, then connect it to **MiniMax H3 Easy**.

Routing follows the connected inputs:

- no references -> FL2VA/base path
- first/last-frame images -> endpoint-frame conditioning
- reference image/video/audio -> Ref2VA

Prompt mode affects prompt assistance only. It does not select the runtime route.

For reference workflows, type `@` in the prompt editor and select a connected input:

```text
@Image1
@Video1
@Audio1
@Subject1
```

These are compiled to MiniMax's native reference tags before execution.

## Install

Clone into:

```text
ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-Easy-Extended
```

Models use the normal ComfyUI folders:

```text
ComfyUI/models/diffusion_models/
ComfyUI/models/text_encoders/
ComfyUI/models/vae/
```

Restart ComfyUI after installing or updating.

## Notes

- Reference inputs use the Ref2VA path.
- Endpoint frames connected together with references are not forwarded on the Ref2VA route; the node shows a warning.
- Standalone reference audio can be addressed with `@AudioN`.
- The main node outputs a normal ComfyUI `MODEL`, so LoRA, Sage and other model patches can be chained after it.

## Credits

Based on [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy) by **nkxx188**.

Original MIT license and copyright notice are retained in [LICENSE](LICENSE).