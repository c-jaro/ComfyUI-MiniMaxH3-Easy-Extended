# ComfyUI-MiniMaxH3-Easy-Extended

> **WIP** extended fork of [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy).

Extends the original Easy nodes with broader MiniMax H3 workflow support, improved reference/audio handling, and a prompt editor built around H3's prompting format.

## Prompting

The main focus is the prompt editor: less manual H3 prompt structure, fewer tags to remember, and faster reference prompting.

Press **Tab** on an empty prompt to pick a starter such as T2V/T2VA, REF2VA, T2A or REF2A. Templates contain editable fields:

- **Tab** -> next field
- **Shift+Tab** -> previous field
- **Up / Down + Enter** -> choose a contextual suggestion
- typing replaces the selected field

<p align="center">
  <video src="https://github.com/user-attachments/assets/03407126-93a0-4553-b436-403968bd7df2" width="400px" controls></video>
  <video src="https://github.com/user-attachments/assets/ae497179-4513-463f-8a81-048d123a06cf" width="400px" controls></video>
  <video src="https://github.com/user-attachments/assets/4f1534b2-0228-4f1a-9bb2-685dfe9c295f" width="400px" controls></video>
</p>

Suggestions change with the current field, so camera, movement, scene, dialogue, voice, sound and other options show up where they are relevant.

Type **`@`** to reference connected media:

```text
@Image1
@Video1
@Audio1
@Subject1
```

Selecting a reference opens a second menu with role/description templates instead of stopping at a bare tag. `@Audio1`, for example, can continue as a voice reference, music style, dialogue/lyrics source, SFX/ambience reference, rhythm reference, or direct signal reference.

Other editor shortcuts are context-aware:

- **`#`** -> dialogue / singing / voiceover helpers
- **`[`** -> shot, task or language helpers
- **`(`** -> speaker IDs where applicable
- **`:`** -> Ref2VA retention choices

The **Compiled Prompt** preview shows the final prompt after Easy expands the helper syntax.

## Main changes

- FL2VA / Ref2VA routing based on connected inputs
- T2VA, I2VA, first/last-frame, reference and audio workflows
- improved image, video and reference preprocessing
- H3-specific prompt validation
- audio-only mode
- broader language and dialogue helpers
- selected model / route info
- loader fixes and compatibility with older Easy workflows

Still WIP. UI and behavior may change.

## Example workflow

An example graph is included in [`minimax_h3_easy-extended.json`](minimax_h3_easy-extended.json).

The Sage / SolAttn / cache nodes in the example are optional acceleration nodes and are not required by MiniMax H3 Easy itself.

## Usage

Load the models with **MiniMax H3 Easy Loader**, then connect it to **MiniMax H3 Easy**.

Routing follows the connected inputs:

- no references -> FL2VA/base path
- first/last-frame images -> endpoint-frame conditioning
- reference image/video/audio -> Ref2VA

Prompt mode affects prompt assistance only. It does not select the runtime route.

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

## Credits

Based on [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy) by **nkxx188**.

Original MIT license and copyright notice are retained in [LICENSE](LICENSE).
