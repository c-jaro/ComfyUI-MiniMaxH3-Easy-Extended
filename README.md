# ComfyUI-MiniMaxH3-Easy-Extended
> Extended fork of [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy).
Builds on the original Easy nodes with H3-specific prompt suggestions, autocomplete, and a handful of fixes & reference/audio improvements.

## Focus
The main focus of this is easing up on h3 prompting. The model is very sensitive to good prompt structure (especially R2VA) some of the burden of which this is supposed to alleviate.

**SUGGESTIONS BASED ON:**
- Base prompting: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md
- Reference prompting: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md

Press **Tab** on an empty prompt to choose **Custom** or any T2V, I2V, L2V, FL2V, R2V, T2A, R2A, I2A, V2A, or A2A starter. On an ordinary unstructured draft, the same menu offers non-destructive wrappers that keep the draft in the official timeline or Reference summary, plus clearly labeled blank-template replacements. Template choice sets only the matching Video/Audio **Mode** and endpoint first/last-frame role; it never changes **Model**, connections, or connected-input conditioning. Reference starters begin with an editable bracketed task relationship from MiniMax's documented six values. T2A/R2A/I2A/V2A/A2A are Easy audio-only proxy template names, not additional MiniMax task types. Templates contain editable fields:
- **Tab** -> next field
- **Shift+Tab** -> previous field
- **Up / Down + Enter** -> choose a contextual suggestion
- typing replaces the selected field

Reference audio proxies keep the guide's roles separate. `@ImageN` supplies provenance for visible content defined as `@SubjectN`, and `@VideoN` describes editing, continuation, or whole-video timing/structure. `@AudioN` names standalone Reference audio; `@VideoAudioN` names the enabled soundtrack attached to visible Reference Video N. Either audio source needs its own definition and copy/reference relationship. V2A does not treat a video's mere presence as an audio-reuse instruction.



<p>
<img width="32%" alt="1" src="https://github.com/user-attachments/assets/58564f04-b1e1-43a6-b94c-b0dc7792a01b" />
<img width="32%" alt="2" src="https://github.com/user-attachments/assets/08a7e0e5-ad2b-42d8-8da4-ac1b5a47098c" />
<img width="32%" alt="3" src="https://github.com/user-attachments/assets/fe38c985-f490-4740-8f66-ad4807d50f92" />
</p>
<img width="32%" alt="3_" src="https://github.com/user-attachments/assets/f7003c65-a12a-492d-bfc6-c5c2dc758e3e" />

Suggestions change with the current field, so camera, movement, scene, dialogue, voice, sound and other options show up where they are relevant.

Type **`@`** to reference connected media:

```text
@Image1
@Video1
@VideoAudio1
@Audio1
@Subject1
```

Selecting a reference opens a second menu with role/description templates instead of stopping at a bare tag. `@Audio1` or `@VideoAudio1`, for example, can continue as a voice reference, music style, dialogue/lyrics source, SFX/ambience reference, rhythm reference, or direct signal relationship. The browser keeps video-soundtrack aliases readable; execution resolves them to the actual native `<Audio K>` ordinal after inspecting the VIDEO payload and errors if the selected video is muted or silent.

Reference labels use natural role-specific sentences, not a fixed `=` or `represents` operator. To reuse visible content, define `@Subject1 is {tracked subject} shown in @Image1; @Image1 provides {source contribution}.` To track the Picture itself as a concrete frame, use `@Image1 is the first frame of [Shot 1], showing {...}.` Subject definitions belong at the start of the full Reference grammar under `subject_definitions:`. Base grammar has no definition preamble; use a reference within `integrated_multimodal_description:` instead.

At the first Reference definition field, **Relationship builder** choices fill an editable definition, recommended official task type, summary relationship, matching retention row, and point-of-effect text together. Visual and synchronized audio roles write into `detailed_description`; ambience/SFX roles write into `overall_soundscape`; audience-only score roles write into `non_diegetic_music`. The helper leaves optional next-definition and next-retention fields with explicit **Done** choices, so multi-reference prompts can be built one semantic role at a time without requiring every connected file to become a separately tracked label.

If an endpoint prompt has a recognizable first-line alignment defect, the validator offers a deterministic **Apply structural fix** action. It changes only that structure through the editor's normal undo-preserving replacement path; it does not rewrite user prose.

Other editor shortcuts are context-aware:

- **`#`** -> dialogue / singing / voiceover helpers
- **`[`** -> shot, task or language helpers
- **`(`** -> speaker IDs where applicable
- **`:`** -> Ref2VA retention choices

Inside `<d>`, clicking a completed tag such as `[Russian]` reopens the full language replacement list instead of filtering it to the current value. The language group names describe convenience/support, not a model preference. `[unclear]` is not a language tag: use it only among unintelligible words copied from Reference audio, after the actual language tag. `<scenetrans>` is only for the same dialogue or lyric line continuing across a shot cut, with the marker at the connection point in both fragments and explicit wording that audio continues across the cut. `<cutoff>` is only for speech or lyrics truncated by the end of the generated video, not an ordinary interruption or cut.

Completed plain-text presets remain editable after insertion. Click inside a recognized phrase such as `high angle` or `extreme close-up` to reopen that field's choices, or choose **Edit current text** to select the phrase for free-form replacement. Ambiguous phrases do not guess a field.

Reference `summary` is one short continuous paragraph. `overall_soundscape` is one continuous paragraph of 1–4 sentences, and `non_diegetic_music` is one continuous paragraph of 1–3 sentences. The editor flags internal blank-line paragraph breaks in those fields while preserving the normal blank lines between top-level sections.

In Video mode, **Output resolution** shows the resolved `width x height` and decimal megapixels. Native 16:9 is `1344 x 768 = 1,032,192` pixels, so the correct display is `1.03 MP`; `0.98 MP` would describe `1280 x 768`, not the current core canvas. When a connected endpoint frame supplies the aspect ratio, the row explicitly shows the theoretical pre-alignment megapixel-class range until execution resolves and 32-pixel-aligns that image's dimensions. `Custom exact` values are also rounded to the nearest 32 pixels.

**Reference image resolution** separates cost from source detail. **Match output area (predictable token cost)** resamples each still toward the output area; it may enlarge a small source, but that adds no detail and can soften pixels. **Preserve source detail (2048px short-edge cap; slower)** keeps available source pixels up to core's short-edge cap without intentional upscaling, which can retain real high-resolution identity detail at a substantially higher conditioning cost. Reference-video choices are resolution-class caps, not forced downscales: a smaller source is not scaled toward the selected class, although H3's nearest-32 alignment can slightly enlarge or reduce either edge. A lower cap saves conditioning cost only when the source exceeds it.

## Main changes

- explicit Loader-backed **Model** selector; connected media chooses conditioning without switching checkpoints
- T2VA, I2VA, first/last-frame, reference and audio workflows
- improved image, video and reference preprocessing
- H3-specific prompt validation
- audio-only mode
- broader language and dialogue helpers
- separate model-selection and conditioning-builder reporting through the Info node
- loader fixes and compatibility with older Easy workflows

Still WIP. UI and behavior may change.

## Example workflow

An example graph is included in [`workflow/minimax_h3_easy-extended.json`](workflow/minimax_h3_easy-extended.json).

The included graph uses this project and current ComfyUI core nodes only. Its downstream **RandomNoise** node starts at seed `0` with `control_after_generate = randomize`, so queued generations change the sampling seed automatically unless that control is set to fixed. Easy has no sampling-seed control. Current ComfyUI H3 separately uses a fixed internal seed `0` for its 0.1% visual-reference conditioning-noise augmentation; that is not the sampler seed, and audio-reference augmentation adds no noise. Add acceleration patches after **Model** only when they are separately installed and validated for the active H3 path.

## Usage

Load the models with **MiniMax H3 Easy Loader**, then connect it to **MiniMax H3 Easy**.

Choose the runtime checkpoint provision with **Model** on **MiniMax H3 Easy**:

- **FL2VA** -> the Loader's FL2VA checkpoint
- **REF2VA** -> the Loader's REF2VA checkpoint

Model choice, output mode, and conditioning are independent. Audio-only uses the selected FL2VA or REF2VA checkpoint. Any connected Reference image, video, or audio uses ComfyUI's native Reference builder; otherwise text and optional first/last frames use the native text/frame builder. Connecting Reference media never silently changes the selected checkpoint.

The native builders cannot combine Reference media with first/last-frame conditioning in one call. Easy rejects a workflow with both physical input families connected instead of silently ignoring one. Disconnect every Reference input or every first/last-frame input. This does not restrict FL2VA provision with Reference conditioning, REF2VA grammar on another builder, or downstream LoRAs.

A **Reference video** is a normal ComfyUI `VIDEO`: Easy reads its source frame rate and, by default, forwards a synchronized track when the VIDEO payload exposes one. Each connected video reveals its own soundtrack toggle, labeled with the compact prompt ordinal and `@VideoAudioN` alias. Muting it excludes that embedded soundtrack from conditioning while preserving the video's frames and timing. Prompt roles remain separate, so video presence alone does not declare audio reuse/reference. **Reference audio** supplies standalone clips addressed as `@AudioN`.

Prompt structure affects prompt assistance/validation only. It does not select the model or conditioning builder. The empty-prompt Tab menu offers separate T2V, I2V, L2V, FL2V, R2V, T2A, R2A, I2A, V2A, and A2A starters regardless of the current Model selection. Choosing one sets only its matching Video/Audio **Mode** and, for endpoint starters, the first/last-frame role; it never changes **Model** or connections.

The prompt editor keeps these independent signals visible as **Provision**, **Builder**, and recognized **Grammar** (or a connection-derived **Helper** before structure is recognizable). The adjacent **Guide** indicator reports every navigable prompt-writing target: structural defects, known Easy placeholders, and required semantic diagnostics with an exact editable range. Clicking it selects the next target. A missing or empty section opens explicit **insert scaffold** and **write manually** choices; the click itself never rewrites the prompt. Connection and setting errors remain in the separate validation diagnostic because they are not prompt text to fill. Provision is the Easy Loader checkpoint slot, not a compatibility verdict: combinations such as FL2VA provision with Reference conditioning and REF2VA grammar remain allowed without warnings or automatic switching. Downstream LoRAs and model patches are outside the Easy node and are not inspected by this status.

Easy closes the deterministic local gap to MiniMax's published prompt contract: it builds the documented sections and fixed relationship vocabularies, resolves editable aliases, and passes media through ComfyUI's native MiniMax H3 interleaving path. It does not claim exact remote-API parity because any additional server-side prompt rewriting is not documented or available in the local encoder path.

## Install

Requires a current ComfyUI build with native `comfy_extras.nodes_minimax_h3` support.

Clone into:

```text
ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-Easy-Extended
```

Model selection uses the normal ComfyUI folders:

```text
ComfyUI/models/diffusion_models/
ComfyUI/models/text_encoders/
ComfyUI/models/vae/
```

Restart ComfyUI after installing or updating.

## Credits

Based on [nkxx188/ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy) by **nkxx188**.

Original MIT license and copyright notice are retained in [LICENSE](LICENSE).
