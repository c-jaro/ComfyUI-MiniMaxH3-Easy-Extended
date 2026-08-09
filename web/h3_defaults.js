// Frontend source of truth for MiniMax H3 Easy fresh-node and repair defaults.
// Keep this small and literal; tests cross-check it against the Python schema/runtime.
export const H3E_DEFAULTS = Object.freeze({
  mode: "Video + audio",
  conditioningModel: "FL2VA",
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
  refImageSize: "Match output area (predictable token cost)",
  refVideoSize: "768-class cap (most detail)",
  refVideoTemporalFit: "Trim tail to valid H3 frame count",
});

export const H3E_VALUES = Object.freeze({
  audioProxyCanvas: "32x32 (audio proxy)",
  refVideoTemporalHold: "Keep last frame (pad to valid H3 length)",
});

export const H3E_VALID = Object.freeze({
  canvas: new Set(["768P (native)", "704P (draft)", "640P (draft)", "576P (draft)", "512P (draft)", "Custom exact"]),
  aspectRatio: new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]),
  conditioningModel: new Set(["FL2VA", "REF2VA"]),
  keyframeRole: new Set(["First frame", "Last frame"]),
  keyframeCanvas: new Set(["Opening frame; if absent, last frame", "Aspect ratio setting"]),
  firstFrameResize: new Set(["Preserve full frame (pad edges)", "Fill output (crop edges)", "Stretch to output (distorts)"]),
  lastFrameResize: new Set(["Preserve full frame (pad edges)", "Fill output (crop edges)", "Stretch to output (distorts)"]),
  refImageSize: new Set(["Match output area (predictable token cost)", "Preserve source detail (2048px short-edge cap; slower)"]),
  refVideoSize: new Set(["768-class cap (most detail)", "640-class cap", "576-class cap", "512-class cap"]),
  refVideoTemporalFit: new Set([H3E_DEFAULTS.refVideoTemporalFit, H3E_VALUES.refVideoTemporalHold]),
});
