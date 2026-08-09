// Frontend source of truth for MiniMax H3 Easy fresh-node and repair defaults.
// Keep this small and literal; tests cross-check it against the Python schema/runtime.
export const H3E_DEFAULTS = Object.freeze({
  mode: "Video + audio",
  canvas: "768P (native)",
  aspectRatio: "16:9",
  customWidth: 1344,
  customHeight: 768,
  seconds: 5,
  playbackFps: 24,
  keyframeRole: "First frame",
  keyframeCanvas: "Opening frame; if absent, last frame",
  firstFrameResize: "Preserve full frame (pad edges)",
  lastFrameResize: "Fill output (crop edges)",
  refImageSize: "Balanced to output area (may upscale)",
  refVideoSize: "768P native",
  refVideoFps: 24,
  refVideoFpsOverride: 0,
  refVideoTemporalFit: "Trim tail to valid H3 frame count",
});

export const H3E_VALUES = Object.freeze({
  audioProxyCanvas: "32x32 (audio proxy)",
  refVideoTemporalHold: "Keep last frame (pad to valid H3 length)",
});

export const H3E_VALID = Object.freeze({
  canvas: new Set(["768P (native)", "704P (draft)", "640P (draft)", "576P (draft)", "512P (draft)", "Custom exact"]),
  aspectRatio: new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]),
  keyframeRole: new Set(["First frame", "Last frame"]),
  keyframeCanvas: new Set(["Opening frame; if absent, last frame", "Aspect ratio setting"]),
  firstFrameResize: new Set(["Preserve full frame (pad edges)", "Fill output (crop edges)", "Stretch to output (distorts)"]),
  lastFrameResize: new Set(["Preserve full frame (pad edges)", "Fill output (crop edges)", "Stretch to output (distorts)"]),
  refImageSize: new Set(["Balanced to output area (may upscale)", "2048px short-edge cap (no upscale)"]),
  refVideoSize: new Set(["768P native", "640P downscaled", "576P downscaled", "512P downscaled"]),
  refVideoTemporalFit: new Set([H3E_DEFAULTS.refVideoTemporalFit, H3E_VALUES.refVideoTemporalHold]),
});
