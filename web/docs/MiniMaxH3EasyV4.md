# MiniMax H3 Easy V4

Static-input MiniMax H3 conditioning frontend with context-driven visual simplification.

## Mental model

**Mode only chooses output intent:** `Video + audio` or `Audio only (32x32 proxy)`.

**Prompt structure chooses assistance, not execution routing:**

- `integrated_multimodal_description:` / endpoint-alignment opening → base/T2V writing assistance
- `subject_definitions:` / REF-only top-level sections → Reference/R2V writing assistance
- connected Reference image/video/audio → native Reference conditioning path
- no Reference input → text/endpoint conditioning path

Starter/template choice never disables connected media and prompt-family mismatch is not a routing error. When endpoint and Reference sockets are both wired, Easy does not infer intent from the prompt. Current ComfyUI exposes them as separate native conditioning builders; the Reference builder can receive the connected refs but has no endpoint-frame parameters. Easy therefore keeps the run non-blocking and shows a persistent amber **Reference route · endpoint frames connected but not forwarded** notice.

## Static inputs, relevant widgets

Every schema input is permanent and serialized. Easy does not use DynamicCombo or click-to-expand settings. Inactive controls are synchronized to ComfyUI's real widget `hidden` state so they are not painted at stale canvas positions, while their stored values remain intact.

The visual widget list is reduced automatically:

- `Mode`, the read-only `Selected model:` line, Prompt and duration are always visible.
- Video output resolution/aspect controls appear only in `Video + audio`; Audio-only uses an internal 32x32 proxy without changing the stored video-resolution selection. Playback stays fixed at H3 native 24 fps.
- Custom width/height appear only for `Custom exact`.
- Endpoint policy appears only when endpoint frames are connected.
- `Opening frame resize` appears only when a connected opening frame can actually mismatch a fixed/custom output aspect.
- `Ending frame resize` appears only when a connected final endpoint can mismatch the resolved output canvas. Its default keeps core H3's center-crop behavior; preserve-full padding and deliberate stretch are explicit alternatives.
- Reference image resolution appears only with a Reference image in normal video mode.
- Reference-video resolution/FPS/end handling appear only with Reference videos; Video 2/3 FPS appears only when those clips exist.

Sockets stay available the whole time. Hiding a widget never removes or rewrites its stored value.

## Prompt editor

Prompt structure selects the editor grammar, starter behavior, and validation profile. Conditioning execution follows live sockets independently: any Reference media activates Reference conditioning; otherwise the base/endpoint path is used. A paired soundtrack without its matching video socket remains a genuine wiring error because that audio has no corresponding Reference Video.

Mode + recognized prompt structure determine prompt assistance. Tab inserts/advances fields and Shift+Tab moves to the previous field. Navigation highlights the exact known placeholder range that will be replaced and keeps its menu open. Clicking or moving the caret inside a known placeholder also expands that field to the visible replacement selection; unrelated partial text selections remain ordinary editing selections. Fixed H3 vocabularies expose their documented finite choices; open natural-language fields expose **Custom… first and selected by default**, followed by editable writing presets. Choosing Custom leaves the whole placeholder selected so normal typing replaces it. This covers visual style, framing/viewpoint, subjects/scenes, actions, speaker identity/voice traits, audio events, ambience/foley, and non-diegetic score components. Dialogue language prioritizes English, Russian, Japanese, Dutch, and French, then offers the remaining stable/common languages. The 11 MiniMax-documented stable languages are distinguished from additional variable-support helpers, and Custom remains available. Exact dialogue/lyrics and visible-text fields use Custom rather than fabricated content.

`@`, `[`, `#`, and `:` still open contextual choices. Hover or Arrow keys move the visible selection; click or Enter inserts it. Selecting a raw `@ImageN`, `@VideoN`, `@AudioN`, or `@SubjectN` immediately opens a second-stage role/template menu so the reference can be defined or used without manually rebuilding the sentence. A bare `@` produces an explicit empty-state message when nothing usable is connected/defined. Blocking validation is shown above the textarea. Multiple issues expose previous/next navigation with an `n/N` counter, and the active issue can focus its offending range. The autocomplete panel sits below the textarea so the active field remains visible. The `Compiled Prompt:` line shows how aliases resolve for the current physical conditioning route. Click it to expand the exact multiline preview; **Copy** copies that frontend preview. The node's `Compiled Prompt` output remains authoritative after execution.

## Loader relationship

Easy Loader normally needs two diffusion routing choices: Text/frame and Reference conditioning. Audio-only defaults to **Auto (match conditioning)** and reuses the corresponding route. A separate audio model is an optional override, not a third required decision.
