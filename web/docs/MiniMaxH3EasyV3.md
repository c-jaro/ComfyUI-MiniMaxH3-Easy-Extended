# MiniMax H3 Easy V3

> Historical V3 note: current V4 behavior is documented in `MiniMaxH3EasyV4.md`. V4 uses prompt structure for editor assistance only; connected Reference media choose Reference conditioning, otherwise the text/endpoint path is used. Model independently selects a checkpoint provisioned by Easy Loader.

Static-input MiniMax H3 conditioning frontend.

## Mode

**Video + audio** generates the normal H3 AV target. **Audio only (32x32 proxy)** keeps the same H3 AV model internally but fixes the visual target to 32x32 so the sampled audio can be decoded without spending on a normal output video.

Mode does **not** choose the conditioning family. The connected inputs do:

- no conditioning media → T2VA / T2A-style text guidance
- First/last frame images only → I2VA, L2VA or FL2VA
- Reference images/videos/audio → full-reference conditioning

First/last-frame inputs and Reference inputs must not be connected together in one request because current H3 presentation/tokenization does not reliably represent both families simultaneously.

## Static controls

All ordinary controls stay present. No mode or connection makes `Opening frame resize`, canvas, aspect, reference-resolution, FPS, or other widgets appear/disappear. Autogrow is used only for repeatable media sockets.

The visual layout is always:

1. Mode
2. Prompt editor
3. every remaining control in schema order

## Prompt editor

The editor is keyboard-first. Tab inserts or advances scaffold fields. `@`, `[`, `#`, and `:` expose contextual completions. Arrow keys move and Enter inserts. The completion menu is placed **below the textarea**, never over the selected placeholder.

Reference inputs automatically select MiniMax's six-section full-reference prompt grammar. Endpoint-frame inputs automatically select the relevant I2VA/L2VA/FL2VA assistance. Audio only changes the assistance toward soundtrack generation while keeping the underlying grammar appropriate to the connected conditioning family.

## Endpoint controls

**Video aspect ratio source** chooses whether normal video output follows the opening endpoint frame (or the last frame when that is the only endpoint) or the explicit Output aspect ratio setting.

**Opening frame resize** is always visible and only matters when Video + audio uses an opening endpoint whose aspect differs from the resolved video canvas:

- Preserve full frame (pad edges)
- Fill output (crop edges)
- Stretch to output (distorts)

Audio only ignores endpoint-frame controls. Use Reference images for I2A-style audio conditioning so the source image keeps useful reference resolution instead of being reduced to the 32x32 proxy target.
