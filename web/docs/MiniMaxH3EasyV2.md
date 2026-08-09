# MiniMax H3 Easy V2

> Historical V2 notes. Current behavior is documented in `MiniMaxH3EasyV4.md`.

Mode-aware MiniMax H3 conditioning using ComfyUI's V3 DynamicCombo/Autogrow inputs and core H3 conditioning code.

## Requirements

Requires a current ComfyUI build that includes native `comfy_extras.nodes_minimax_h3` support. Treat that capability as the requirement instead of relying on a fixed ComfyUI version number, because H3 support/fixes may land on `main` before tagged releases and versioned docs converge.

## Outputs

- **Model**: standard Comfy MODEL; LoRAs and model patches can be chained downstream.
- **H3 Context**: connect to **MiniMax H3 Easy Output**, **MiniMax H3 Easy Audio Decode**, or **MiniMax H3 Easy Info**.
- **Compiled Prompt**: historical V2 output. Current V4 has neither this workflow socket nor a separate in-node preview.

## Loader routing

The three diffusion selectors are routing slots, not model-family filters. Text/frame, Reference, and Audio-first each expose the same selectable `.safetensors` diffusion weights from ComfyUI's native diffusion-model registry plus GGUF weights exposed by ComfyUI-GGUF. Filenames do not determine which route a weight may use, and the same file may be selected in multiple routes.

MiniMax documents the released FL2VA and Ref2VA checkpoints as task-specific. Cross-routing is intentionally not blocked by Easy, but it is experimental rather than an officially documented pairing. The **Info** node prints the exact diffusion-model filename routed for the current run.

## Prompt editor

Prompt writing is keyboard-first. On an empty prompt, **Tab** inserts the active-mode scaffold; Tab then advances through fill fields. Fields with defined choices open autocomplete automatically and use Arrow keys + Enter. Use `@` for references, `[` for context-sensitive bracket structures and the next shot scaffold, `#` for dialogue controls, `(` for speaker IDs, and `:` for REF retention values. Open-ended fields stay plain text.

Autocomplete is keyboard-driven. **Arrow keys** move through choices, **Enter** inserts the highlighted choice, **Tab** moves to the next fill field, and **Escape** closes the popup. Mouse interaction is passive: hovering an option/status line shows its concise tooltip, but hover/click does not insert or change the active autocomplete choice. Ctrl/Cmd+Z/Y closes the popup before textarea history processing and is isolated from graph hotkeys.

The status line below the editor shows the first required fix or a compact structure result. Hover it for the concise explanation/example. Current V4 keeps prompt compilation internal and has no Compiled Prompt panel or Copy action.

In Reference conditioning (MiniMax full-reference grammar), `summary` is the high-level semantic index: task type, target premise/shot flow, and main reference roles. `detailed_description` owns exact execution: framing, position, action stages/state changes, camera, synchronized sound/dialogue, and exact later-shot cut times. A brief action premise may appear in both levels, but detailed shot prose should not be copied into the summary.

For multi-view subjects, keep all source-picture provenance on the one line that defines the tracked Subject. If the same source image also provides a different reusable semantic role such as the whole video's visual style, define a second `@SubjectN` from that same image and use the style Subject later. Do not promote the source-only `@ImageN` to a standalone Picture unless the image itself is a concrete frame/composition/storyboard anchor.

Typing `@ImageN` / `@VideoN` shows a small source preview when the connected upstream node exposes image/poster/video preview media; Subject and Audio entries use compact fallback badges.
Autocomplete rows stay compact: label plus a short distinction, with the insertion scaffold revealed only on the selected row when useful. Retention choices are especially explicit: the fixed marker chooses the relationship category, while the clause after `-` states what is actually kept, changed, transferred, copied, or referenced. Choosing a marker inserts a meaningful named scaffold, for example `attribute_transfer - transfer {attributes} to {target subject}` or `partially_preserved - keep {features retained}; change {features changed}`. Named `{fill slots}` are editor-only writing aids: the first is selected automatically, **Tab advances to the next slot**, and validation flags any slot left unfinished. MiniMax defines the retention relationships and demonstrates explanatory clauses after them; the editor's unfinished-slot rule is a usability guardrail, not a claim that curly braces or the hyphen are hidden parser tokens.

The same ambiguity pass covers summary task types, reference roles, camera movement/modifier differences, shot-content dimensions, shot timing/cuts, dialogue/speaker controls, Picture anchors, soundscape, and non-diegetic music. Examples illustrate valid prose and are not closed vocabularies unless MiniMax explicitly defines the value as fixed.
The live compiler resolves the editor's `@ImageN` / `@VideoN` / `@AudioN` aliases only when the corresponding physical input exists; unresolved aliases remain visible rather than pretending compilation succeeded. Current V4 shows the compiled form in the in-node preview instead of exposing it as a workflow output.
Pasted native MiniMax tags such as `<Picture 1>` and `<Subject 1>` are accepted and are checked by the same connection/definition/retention validation where applicable; native tags are already model syntax, so they are not rewritten.

## Modes

- T2VA: Text / first-last frames mode with no frame images
- I2VA: one first-frame image
- L2VA: one last-frame image
- FL2VA: first + last frame images
- Reference conditioning: MiniMax full-reference prompt grammar over connected reference inputs
- Audio-first proxy: T2A / I2A / V2A / A2A-oriented soundtrack generation with a forced 32x32 disposable target video

Reference mode uses real typed Autogrow sockets instead of virtual frontend links.


### Audio-first proxy

Audio-first still runs H3's joint audio-video denoiser, but Easy forces the generated visual stream to **32x32**. Current V4 hides output-resolution/aspect controls in Audio-only and leaves their video-mode values untouched. After sampling, **MiniMax H3 Easy Audio Decode** extracts only the audio member, so the video VAE never needs to run.

Audio-first exposes **Reference Image / Video / Audio** inputs rather than first/last-frame sockets. This is intentional: native first/last-frame conditioning resizes the frame to the target canvas before Qwen sees it, so a 32x32 audio proxy would destroy useful image semantics. Reference Images instead keep a normal native-area conditioning budget independent of the tiny target. Reference Video and Audio conditioning retain their normal reference geometry/timing.

The editor badge shows the actual audio intent: **T2A proxy**, **I2A proxy**, **V2A proxy**, **A2A proxy**, or combinations. Tab on the audio-timeline field exposes dialogue/narration, singing/lyrics, SFX/foley, diegetic music, and silence as keyboard-only insertion scaffolds. The separate Audio-first validator warns when a paired source soundtrack would also condition a redub, when a visual-only video reference is being used for V2A, or when the prompt explicitly asks for no audible content.

Audio-only reference input is still outside MiniMax's published Ref2VA envelope, so A2A-only use remains experimental even though current ComfyUI can structurally build the request.

### R2V / video-reference handling

Video references are not forced to the output canvas. Current ComfyUI gives each video its own 768-class reference geometry, so a high-resolution 16:9 source ends up around **1344x768**, while portrait sources keep portrait geometry. Easy defaults to that native path and offers lower reference classes for speed: about **1120x640**, **1024x576**, and **896x512** for 16:9. Info reports the exact source-to-reference aspect delta and warns at 3% or more.

Reference-video FPS is resolved per connected IMAGE frame batch. `Video 1 source FPS` supplies Video 1 and remains the backward-compatible fallback for Video 2/3. Their overrides default to `0 = inherit`; set a positive override only when that specific batch represents a different rate. Easy normalizes each video independently to H3's 24 fps grid before core conditioning. It also truncates frames that cannot affect the requested output before expensive core resizing, avoiding wasted preprocessing on a long/high-resolution source.

Info also reports each Picture/Video's exact packed visual-row budget in the current H3 transformer layout, the total, and the largest/smallest visual-block ratio. This diagnoses conditioning-context imbalance; it is not a measured attention percentage.

Current ComfyUI then trims each reference tail downward to the previous valid `17k+5` frame count before both the reference VAE and its roughly 2 fps Qwen presentation. For endpoint-critical motion, the optional **Keep last frame** mode keeps the full usable interval and repeats only the final frame until the next valid `17k+5` length. This keeps the endpoint visible to both current Comfy conditioning paths but adds a short static hold and is not MiniMax's official normalization rule.

For motion transfer, define the visible action as a Subject sourced from the video, for example `@Subject2 is the standing-backflip action shown in @Video1 ...`, then use `attribute_transfer` if that action is applied to another character Subject. In the timeline, type `[` for the next shot scaffold; provenance belongs in `subject_definitions`, while the actual motion progression belongs in the shot text.

### Output aspect ratio source

Text / first-last frames mode defaults **Output aspect ratio source** to **Opening frame; if absent, last frame**. With at least one first/last frame image and a non-custom output resolution, the node derives the output aspect from the connected frame anchor while preserving the selected 768P/draft resolution class. MiniMax's published local I2VA request uses `short_edge: 768` with `aspect_ratio: auto`; the wrapper resolves that idea to ComfyUI's explicit 32-aligned width/height before delegating to core H3. This avoids the severe distortion that a portrait or square first frame can suffer when forced into the default 16:9 canvas.

Select **Aspect ratio setting** when you intentionally want the explicit Aspect ratio control below. `Custom exact` always wins over frame-based aspect matching. Current ComfyUI core stretches a mismatched first frame to the explicit canvas and center-crops the last frame. Easy therefore exposes **Opening frame fit**: Preserve full frame can prefit the opening frame with aspect-preserving replicate-edge padding, Fill output uses an aspect-preserving center crop, and Stretch to output leaves core behavior unchanged. Info reports the exact source/resolved geometry.

In Reference conditioning, the label at the start of a `subject_definitions` line is the separately tracked item. A Picture/Video cited later on that same line can be source provenance for that item rather than its own declaration. Such a source-only Picture/Video gets no separate retention row and should not be reused as a tracked label outside `subject_definitions`; use the owning Subject label instead. Only labels with their own standalone definition line are offered/required in `retention_analysis`. Duplicate tracked definitions and duplicate retention rows are rejected. Dialogue validation also catches nested/unclosed `<d>` tags, empty language-tagged dialogue, and dialogue blocks outside the target-video timeline.

## Published H3 input envelope

MiniMax documents the Ref2VA envelope as up to 9 images, 3 videos, 3 standalone audio files, and 12 mixed source files; each reference video/standalone-audio clip is 2-15 seconds, total video and total standalone audio are each <=15 seconds, and standalone audio is accompanied by image/video. An explicitly paired video soundtrack is carried with its video input even though current Comfy presentation can give it an independent `<Audio N>` label. Easy now treats those values as **published-quality guidance rather than checkpoint capability gates**. When current ComfyUI can still build the request, deviations are allowed experimentally and summarized as one warning. Hard validation remains for technical failures such as malformed tensors, orphan paired soundtracks, or a reference video that becomes fewer than current core's required 5 frames after 24 FPS normalization.

Pairing is by Comfy input slot, while `<Audio N>` and `<Video N>` labels are numbered independently. MiniMax's H3 system card publishes 4-15 seconds, while current Diffusers local H3 constrains the snapped `17k+5` result to 5-15 seconds. The node still permits 1-30 seconds locally for current-ComfyUI experiments and reports the distinction rather than collapsing the two contracts. H3's generation and synchronized audio timeline remains 24 FPS. The optional playback-FPS output is metadata; changing it downstream without retiming audio by the same ratio creates an A/V duration mismatch.

### Canonical punctuation

Section-aware help exposes the documented separators directly: full-reference summary uses `[task type] paragraph` with one space and no structural punctuation after the bracket; combined task types use exact ` + ` separators; Shot 1 uses `[Shot 1] prose` with one space and no structural punctuation/timestamp; later shots use `[Shot N] At MM:SS.mmm, prose`; retention uses `label/qualifier: marker - explanation`; Subject definitions are natural sentences such as `@Subject1 is ...`; and dialogue uses `<d>[Language] ...</d>`. Ordinary/new dialogue preserves the user's wording and punctuation; the special terminal-punctuation normalization is applied only when the line is unambiguously direct reference-audio verbal reuse/reperformance. Canonical formatting remains help, while documented structural mistakes are the blocking validator layer.
