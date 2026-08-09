import { app } from "../../scripts/app.js";
import { H3E_DEFAULTS, H3E_VALID, H3E_VALUES } from "./h3_defaults.js";
import {
  AUDIO_RETENTION,
  BASE_SECTIONS,
  CAMERA,
  CONDITIONING_MODEL_FL2VA,
  CONDITIONING_MODEL_REF2VA,
  descriptionOptions,
  EDITOR_PLACEHOLDER_HELP,
  KEYFRAME_FIRST,
  KEYFRAME_LAST,
  KEYFRAME_CANVAS_ADAPTIVE,
  MODE_VIDEO,
  MODE_AUDIO,
  PROFILE,
  REF_SECTIONS,
  DIALOGUE_LANGUAGE_OPTIONS,
  STABLE_DIALOGUE_LANGUAGES,
  TASK_TYPES,
  VISUAL_RETENTION,
  infoOption,
  insertOption,
} from "./h3_guidelines.js";
import { presetChoicesForPlaceholder } from "./h3_prompt_choices.js";
import {
  connectedInputs,
  firstLineForState,
  nodeState,
  profileDescription,
  templateForState,
  validatePrompt,
} from "./h3_validator.js";

const EXTENSION = "MiniMax.H3.Easy.V4.Editor";
const NODE_CLASS = "MiniMaxH3EasyV4";
const PROMPT_WIDGET = "minimax-h3-easy-prompt-editor";
const MENU_LAYOUT_HEIGHT = 220;
const WIDGET_REFRESH_DELAY = 50;
const controllers = new WeakMap();
let legacyMigrationCount = 0;

const EDITOR_PLACEHOLDER_RE = /\{[^{}\n]+\}/g;

function filledPresetCandidates() {
  const seen = new Set();
  const candidates = [];
  for (const key of Object.keys(EDITOR_PLACEHOLDER_HELP)) {
    for (const choice of presetChoicesForPlaceholder(key)) {
      const text = String(choice?.insertText || "").trim();
      if (text.length < 3 || /[{}\n]/.test(text)) continue;
      const signature = `${key}\u0000${text}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      candidates.push({ key, text });
    }
  }
  return candidates.sort((a, b) => b.text.length - a.text.length || a.key.localeCompare(b.key));
}

const FILLED_PRESET_CANDIDATES = Object.freeze(filledPresetCandidates());
const MAX_FILLED_PRESET_LENGTH = FILLED_PRESET_CANDIDATES.reduce((longest, candidate) => Math.max(longest, candidate.text.length), 0);

function isKnownEditorPlaceholder(text) {
  const raw = String(text || "");
  if (!raw.startsWith("{") || !raw.endsWith("}")) return false;
  return Object.prototype.hasOwnProperty.call(EDITOR_PLACEHOLDER_HELP, raw.slice(1, -1).trim());
}

function editorPlaceholders(text) {
  return [...String(text || "").matchAll(EDITOR_PLACEHOLDER_RE)].filter((match) => isKnownEditorPlaceholder(match[0]));
}

function firstEditorPlaceholder(text) {
  return editorPlaceholders(text)[0]?.[0] || null;
}

function placeholderCaretPosition(start, placeholderText) {
  const text = String(placeholderText || "");
  const contentLength = Math.max(0, text.length - 2);
  // A newly inserted nested placeholder briefly needs a caret inside it so the
  // editor can resolve which field became active. openSelectedPlaceholderChoices
  // then expands that field to the exact visible replacement selection.
  return start + 1 + Math.min(1, contentLength);
}

function editorPlaceholderAtSelection(textarea) {
  const source = String(textarea?.value || "");
  const start = Math.max(0, Number(textarea?.selectionStart) || 0);
  const end = Math.max(start, Number(textarea?.selectionEnd) || start);
  for (const match of editorPlaceholders(source)) {
    const from = match.index || 0;
    const to = from + match[0].length;
    // A replaceable field is active either when the caret is inside it or when
    // Easy has highlighted the exact replacement range. Arbitrary partial text
    // selections remain ordinary textarea selections and do not summon a menu.
    const caretInside = start === end && start > from && start < to;
    const exactReplacementSelected = start === from && end === to;
    if (caretInside || exactReplacementSelected) {
      const key = match[0].slice(1, -1).trim();
      return { text: match[0], key, start: from, end: to, help: EDITOR_PLACEHOLDER_HELP[key], highlighted: exactReplacementSelected };
    }
  }
  return null;
}

function filledPresetAtCaret(textarea) {
  const source = String(textarea?.value || "");
  const caret = Math.max(0, Number(textarea?.selectionStart) || 0);
  const selectionEnd = Math.max(caret, Number(textarea?.selectionEnd) || 0);
  if (caret !== selectionEnd) return null;
  const windowStart = Math.max(0, caret - MAX_FILLED_PRESET_LENGTH + 1);
  const windowEnd = Math.min(source.length, caret + MAX_FILLED_PRESET_LENGTH);
  const nearby = source.slice(windowStart, windowEnd);
  const matches = [];
  for (const candidate of FILLED_PRESET_CANDIDATES) {
    let localStart = nearby.indexOf(candidate.text);
    while (localStart >= 0) {
      const start = windowStart + localStart;
      const end = start + candidate.text.length;
      if (caret > start && caret < end
        && !(/^[A-Za-z0-9]/.test(candidate.text) && /[A-Za-z0-9]/.test(source[start - 1] || ""))
        && !(/[A-Za-z0-9]$/.test(candidate.text) && /[A-Za-z0-9]/.test(source[end] || ""))) {
        matches.push({ ...candidate, start, end });
        break;
      }
      localStart = nearby.indexOf(candidate.text, localStart + 1);
    }
  }
  if (!matches.length) return null;

  const longest = matches[0].text.length;
  const longestMatches = matches.filter((match) => match.text.length === longest);
  if (new Set(longestMatches.map((match) => `${match.start}:${match.end}`)).size !== 1) return null;
  const exact = longestMatches.filter((match) => match.start === longestMatches[0].start && match.end === longestMatches[0].end);
  const keys = new Set(exact.map((match) => match.key));
  if (keys.size === 1) return exact[0];

  const before = source.slice(Math.max(0, exact[0].start - 80), exact[0].start);
  const after = source.slice(exact[0].end, Math.min(source.length, exact[0].end + 80));
  if (keys.has("shot size / framing") && /(?:the shot uses|new shot using)\s*$/i.test(before) && /^\s+framing\b/i.test(after)) {
    return exact.find((match) => match.key === "shot size / framing");
  }
  if (keys.has("viewpoint") && /\bframing from\s*$/i.test(before)) return exact.find((match) => match.key === "viewpoint");
  return null;
}

function highlightPlaceholderReplacement(textarea, placeholder) {
  if (!textarea || !placeholder) return false;
  const start = Math.max(0, Number(placeholder.start) || 0);
  const end = Math.max(start, Number(placeholder.end) || start);
  if (end <= start) return false;
  if (Number(textarea.selectionStart) === start && Number(textarea.selectionEnd) === end) return true;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, end);
  return true;
}

function selectAdjacentEditorPlaceholder(textarea, direction = 1) {
  const source = String(textarea?.value || "");
  const placeholders = editorPlaceholders(source);
  const backwards = direction < 0;
  const boundary = Math.max(0, Number(backwards ? textarea?.selectionStart : textarea?.selectionEnd) || 0);
  const match = backwards
    ? [...placeholders].reverse().find((candidate) => (candidate.index || 0) + candidate[0].length <= boundary)
    : placeholders.find((candidate) => (candidate.index || 0) >= boundary);
  if (!match) return false;
  textarea.focus({ preventScroll: true });
  const start = match.index || 0;
  textarea.setSelectionRange(start, start + match[0].length);
  return true;
}

// Keep stable schema IDs while presenting concise human-facing labels.
const FRIENDLY_WIDGET_LABELS = new Map([
  ["ref_image_size", "Reference image resolution"],
  ["ref_video_size", "Reference video resolution"],
  ["ref_video_temporal_fit", "Reference video end handling"],
  ["keyframe_role", "Image 1 is"],
  ["keyframe_canvas", "Video aspect ratio source"],
  ["first_frame_resize", "Opening frame resize"],
  ["last_frame_resize", "Ending frame resize"],
  ["canvas", "Output resolution"],
  ["aspect_ratio", "Output aspect ratio"],
  ["width", "Custom output width"],
  ["height", "Custom output height"],
  ["seconds", "Requested duration (s)"],
  ["conditioning_model", "Model"],
  ["ref_video_use_audio_0", "Use Video 1 soundtrack"],
  ["ref_video_use_audio_1", "Use Video 2 soundtrack"],
  ["ref_video_use_audio_2", "Use Video 3 soundtrack"],
]);

function widgetNameMatches(name, suffix) {
  const value = String(name ?? "");
  return value === suffix
    || value.endsWith(`.${suffix}`)
    || value.endsWith(`:${suffix}`)
    || value.endsWith(`/${suffix}`);
}

function widgetValue(node, suffix, fallback) {
  const widget = (node?.widgets || []).find((item) => widgetNameMatches(item?.name, suffix));
  return widget?.value ?? fallback;
}

function autogrowInputSlot(name, prefix) {
  const value = String(name ?? "");
  const leaf = value.split(/[.:/]/).at(-1) || value;
  if (!leaf.startsWith(prefix)) return null;
  const suffix = leaf.slice(prefix.length);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}

function applyFriendlyWidgetLabels(node) {
  for (const widget of node?.widgets || []) {
    for (const [suffix, label] of FRIENDLY_WIDGET_LABELS) {
      if (!widgetNameMatches(widget?.name, suffix)) continue;
      widget.label = label;
      break;
    }
  }
}

function applyFriendlyInputLabels(node) {
  const labelFor = (name) => {
    const leaf = String(name ?? "").split(/[.:/]/).pop() || "";
    let match = /^keyframe_(\d+)$/.exec(leaf);
    if (match) return Number(match[1]) === 0 ? "First / last frame" : "Last frame";
    match = /^ref_image_(\d+)$/.exec(leaf);
    if (match) return `Reference image ${Number(match[1]) + 1}`;
    match = /^ref_video_(\d+)$/.exec(leaf);
    if (match) return `Reference video ${Number(match[1]) + 1}`;
    match = /^ref_audio_(\d+)$/.exec(leaf);
    if (match) return `Reference audio ${Number(match[1]) + 1}`;
    return null;
  };
  for (const input of node?.inputs || []) {
    const label = labelFor(input?.name);
    if (label) input.label = label;
  }
}

const LEGACY_EXPLICIT_REF_MODES = new Set([
  "Full Reference (REF2VA)",
  "References (REF2VA)",
  "Reference conditioning",
]);

const LEGACY_EXPLICIT_FL_MODES = new Set([
  "Base / Keyframes (T2VA/I2VA/FL2VA/L2VA)",
  "Text / first-last frames (T2VA / I2VA / L2VA / FL2VA)",
]);
const LEGACY_AUDIO_MODES = new Set([
  "Audio-first",
  "Audio-first proxy (T2A / A2A / V2A)",
  "Audio-first proxy (T2A / I2A / V2A / A2A)",
]);
const REMOVED_AUDIO_MODEL = "Audio override";
const pendingLegacyModels = new Map();

function legacyModelSelection(value) {
  const raw = String(value ?? "");
  if (LEGACY_EXPLICIT_REF_MODES.has(raw)) return CONDITIONING_MODEL_REF2VA;
  if (LEGACY_EXPLICIT_FL_MODES.has(raw)) return CONDITIONING_MODEL_FL2VA;
  return null;
}

const VALUE_ALIASES = Object.freeze({
  mode: new Map([
    ["Full Reference (REF2VA)", MODE_VIDEO],
    ["References (REF2VA)", MODE_VIDEO],
    ["Reference conditioning", MODE_VIDEO],
    ["Base / Keyframes (T2VA/I2VA/FL2VA/L2VA)", MODE_VIDEO],
    ["Text / first-last frames (T2VA / I2VA / L2VA / FL2VA)", MODE_VIDEO],
    ["Audio-first proxy (T2A / A2A / V2A)", MODE_AUDIO],
    ["Audio-first proxy (T2A / I2A / V2A / A2A)", MODE_AUDIO],
    ["Audio-first", MODE_AUDIO],
  ]),
  conditioning_model: new Map([
    ["Text / frame", CONDITIONING_MODEL_FL2VA],
    ["Text / first-last frames", CONDITIONING_MODEL_FL2VA],
    ["Reference conditioning", CONDITIONING_MODEL_REF2VA],
    ["Audio model from Loader", REMOVED_AUDIO_MODEL],
  ]),
  keyframe_role: new Map([
    ["Image 1 = first frame", KEYFRAME_FIRST],
    ["Image 1 = last frame", KEYFRAME_LAST],
  ]),
  keyframe_canvas: new Map([
    ["Adaptive to keyframe (recommended)", KEYFRAME_CANVAS_ADAPTIVE],
    ["First/last frame image", KEYFRAME_CANVAS_ADAPTIVE],
    ["Connected first/last frame", KEYFRAME_CANVAS_ADAPTIVE],
    ["Use selected canvas aspect", "Aspect ratio setting"],
    ["Aspect ratio control", "Aspect ratio setting"],
  ]),
  first_frame_resize: new Map([
    ["Auto: preserve aspect (pad when needed)", "Preserve full frame (pad edges)"],
    ["Preserve all (replicate-edge pad)", "Preserve full frame (pad edges)"],
    ["Fill canvas (center crop)", "Fill output (crop edges)"],
    ["Allow stretch (core behavior)", "Stretch to output (distorts)"],
  ]),
  last_frame_resize: new Map([
    ["Auto: preserve aspect (pad when needed)", "Preserve full frame (pad edges)"],
    ["Preserve all (replicate-edge pad)", "Preserve full frame (pad edges)"],
    ["Fill canvas (center crop)", "Fill output (crop edges)"],
    ["Allow stretch (core behavior)", "Stretch to output (distorts)"],
  ]),
  ref_image_size: new Map([
    ["Auto match generation area", "Match output area (predictable token cost)"],
    ["Match output pixel area", "Match output area (predictable token cost)"],
    ["Balanced to output area (may upscale)", "Match output area (predictable token cost)"],
    ["Max fidelity (2048px short edge)", "Preserve source detail (2048px short-edge cap; slower)"],
    ["2048px short edge (maximum detail)", "Preserve source detail (2048px short-edge cap; slower)"],
    ["2048px short-edge cap (no upscale)", "Preserve source detail (2048px short-edge cap; slower)"],
    ["Preserve source detail (2048px cap; slower)", "Preserve source detail (2048px short-edge cap; slower)"],
  ]),
  ref_video_size: new Map([
    ["768P native (best fidelity)", "768-class cap (most detail)"],
    ["640P balanced", "640-class cap"],
    ["576P faster", "576-class cap"],
    ["512P fastest", "512-class cap"],
    ["768P native", "768-class cap (most detail)"],
    ["640P downscaled", "640-class cap"],
    ["576P downscaled", "576-class cap"],
    ["512P downscaled", "512-class cap"],
  ]),
  ref_video_temporal_fit: new Map([
    ["Core exact: trim tail to 17k+5", "Trim tail to valid H3 frame count"],
    ["Preserve endpoint: hold final frame", "Keep last frame (pad to valid H3 length)"],
  ]),
});

function canonicalWidgetValue(id, value) {
  return VALUE_ALIASES[id]?.get(String(value ?? "")) ?? value;
}

function repairCoreWidgetDefaults(node) {
  const byName = (suffix) => (node?.widgets || []).find((widget) => widgetNameMatches(widget?.name, suffix)) || null;

  const repairChoice = (id, valid, fallback) => {
    const widget = byName(id);
    if (!widget) return;
    widget.value = canonicalWidgetValue(id, widget.value);
    if (!valid.has(String(widget.value ?? ""))) widget.value = fallback;
  };
  const repairNumber = (id, fallback, min, max) => {
    const widget = byName(id);
    if (!widget) return;
    const value = Number(widget.value);
    if (!Number.isFinite(value) || value < min || value > max) widget.value = fallback;
  };

  const mode = byName("mode");
  const rawLegacyMode = String(mode?.value ?? "");
  // v1/v2 workflows sometimes encoded the checkpoint choice directly in Mode.
  // Preserve that historical choice when upgrading to the dedicated Model widget.
  const pendingLegacyModel = String(pendingLegacyModels.get(node?.id) ?? "");
  pendingLegacyModels.delete(node?.id);
  const legacyExplicitModel = [CONDITIONING_MODEL_FL2VA, CONDITIONING_MODEL_REF2VA, REMOVED_AUDIO_MODEL].includes(pendingLegacyModel)
    ? pendingLegacyModel
    : legacyModelSelection(rawLegacyMode);
  if (mode) {
    mode.value = canonicalWidgetValue("mode", mode.value);
    if (![MODE_VIDEO, MODE_AUDIO].includes(String(mode.value ?? ""))) mode.value = H3E_DEFAULTS.mode;
  }

  const conditioningModel = byName("conditioning_model");
  if (conditioningModel && legacyExplicitModel) conditioningModel.value = legacyExplicitModel;
  if (String(conditioningModel?.value ?? "") !== REMOVED_AUDIO_MODEL) {
    repairChoice("conditioning_model", H3E_VALID.conditioningModel, H3E_DEFAULTS.conditioningModel);
  }
  repairChoice("keyframe_role", H3E_VALID.keyframeRole, H3E_DEFAULTS.keyframeRole);
  repairChoice("keyframe_canvas", H3E_VALID.keyframeCanvas, H3E_DEFAULTS.keyframeCanvas);
  repairChoice("first_frame_resize", H3E_VALID.firstFrameResize, H3E_DEFAULTS.firstFrameResize);
  repairChoice("last_frame_resize", H3E_VALID.lastFrameResize, H3E_DEFAULTS.lastFrameResize);
  repairChoice("ref_image_size", H3E_VALID.refImageSize, H3E_DEFAULTS.refImageSize);
  repairChoice("ref_video_size", H3E_VALID.refVideoSize, H3E_DEFAULTS.refVideoSize);
  repairChoice("ref_video_temporal_fit", H3E_VALID.refVideoTemporalFit, H3E_DEFAULTS.refVideoTemporalFit);
  repairChoice("canvas", H3E_VALID.canvas, H3E_DEFAULTS.canvas);
  repairChoice("aspect_ratio", H3E_VALID.aspectRatio, H3E_DEFAULTS.aspectRatio);

  repairNumber("seconds", H3E_DEFAULTS.seconds, 1, 30);

  const width = byName("width");
  if (width && (!Number.isFinite(Number(width.value)) || Number(width.value) <= 0)) width.value = H3E_DEFAULTS.customWidth;
  const height = byName("height");
  if (height && (!Number.isFinite(Number(height.value)) || Number(height.value) <= 0)) height.value = H3E_DEFAULTS.customHeight;
}


// Native widgets must still be CREATED before the DOM prompt widget so workflow
// serialization stays compatible. Model selects a Loader checkpoint; connected
// media independently determines which native conditioning builder is visible.
function layoutVisibilityState(node, controller = null, derivedState = null) {
  const value = (id, fallback) => {
    const widget = (node?.widgets || []).find((item) => widgetNameMatches(item?.name, id));
    return widget?.value ?? fallback;
  };
  const mode = String(value("mode", H3E_DEFAULTS.mode));
  const canvas = String(value("canvas", H3E_DEFAULTS.canvas));
  const keyframeRole = String(value("keyframe_role", H3E_DEFAULTS.keyframeRole));
  const keyframeCanvas = String(value("keyframe_canvas", H3E_DEFAULTS.keyframeCanvas));
  const rawKeyframeCount = connectedInputs(node, "keyframe_").length;
  const rawImageCount = connectedInputs(node, "ref_image_").length;
  const videoInputs = connectedInputs(node, "ref_video_");
  const rawVideoCount = videoInputs.length;
  const connectedVideoSlots = new Set(videoInputs.map((input) => autogrowInputSlot(input?.name, "ref_video_")).filter(Number.isFinite));
  const hasReferenceInputs = rawImageCount + rawVideoCount
    + connectedInputs(node, "ref_audio_").length > 0;
  const activeState = derivedState || controller?.getState?.() || null;
  const referenceBuilderActive = activeState
    ? activeState.conditioningProfile === PROFILE.REF2VA
    : hasReferenceInputs;
  const endpointBuilderActive = !referenceBuilderActive;
  const keyframeCount = endpointBuilderActive ? rawKeyframeCount : 0;
  const imageCount = referenceBuilderActive ? rawImageCount : 0;
  const videoCount = referenceBuilderActive ? rawVideoCount : 0;
  const videoMode = mode !== MODE_AUDIO;
  const hasOpeningFrame = keyframeCount >= 2 || (keyframeCount === 1 && keyframeRole === KEYFRAME_FIRST);
  const hasEndingFrame = keyframeCount >= 2 || (keyframeCount === 1 && keyframeRole === KEYFRAME_LAST);
  const frameDrivesAspect = videoMode
    && keyframeCount > 0
    && keyframeCanvas === KEYFRAME_CANVAS_ADAPTIVE
    && canvas !== "Custom exact";
  const endingFrameDrivesAspect = videoMode
    && keyframeCount === 1
    && keyframeRole === KEYFRAME_LAST
    && keyframeCanvas === KEYFRAME_CANVAS_ADAPTIVE
    && canvas !== "Custom exact";
  return {
    mode, canvas, keyframeRole, keyframeCanvas,
    keyframeCount, imageCount, videoCount,
    rawKeyframeCount, rawImageCount, rawVideoCount, connectedVideoSlots,
    endpointBuilderActive, referenceBuilderActive,
    videoMode, hasOpeningFrame, hasEndingFrame, frameDrivesAspect, endingFrameDrivesAspect,
  };
}

function layoutWidgetVisibility(widget, controller, state) {
  if (widget === controller.widget) return true;
  const name = String(widget?.name ?? "");
  const is = (id) => widgetNameMatches(name, id);
  if (is("mode") || is("conditioning_model") || is("seconds")) return true;

  // Output controls matter only when the video is retained.
  if (is("canvas")) return state.videoMode;
  if (is("aspect_ratio")) return state.videoMode && state.canvas !== "Custom exact" && !state.frameDrivesAspect;
  if (is("width") || is("height")) return state.videoMode && state.canvas === "Custom exact";

  // Endpoint-policy widgets stay serialized but appear only when they can affect
  // a connected endpoint workflow. The endpoint sockets themselves never change.
  if (is("keyframe_role")) return state.keyframeCount > 0;
  if (is("keyframe_canvas")) return state.videoMode && state.keyframeCount > 0 && state.canvas !== "Custom exact";
  if (is("first_frame_resize")) {
    return state.hasOpeningFrame
      && (!state.videoMode || state.canvas === "Custom exact" || state.keyframeCanvas !== KEYFRAME_CANVAS_ADAPTIVE);
  }
  if (is("last_frame_resize")) {
    return state.hasEndingFrame && !state.endingFrameDrivesAspect;
  }

  // Reference preprocessing controls appear only for the corresponding connected
  // media. Audio-only still uses reference-video geometry/FPS, but deliberately
  // ignores the still-image size selector to protect I2A refs from the 32x32 proxy.
  if (is("ref_image_size")) return state.imageCount > 0 && state.videoMode;
  if (is("ref_video_size") || is("ref_video_temporal_fit")) return state.videoCount > 0;
  for (let index = 0; index < 3; index += 1) {
    if (is(`ref_video_use_audio_${index}`)) return state.connectedVideoSlots?.has(index) ?? state.rawVideoCount > index;
  }

  // Unknown/native widgets are not managed here. This matters because another
  // extension (or ComfyUI itself) may intentionally own their hidden state.
  return null;
}

// ComfyUI draws every widget whose `hidden` flag is false, even when a custom
// getLayoutWidgets() implementation omits that widget from layout. Merely
// filtering getLayoutWidgets therefore leaves an omitted widget drawable at a
// stale/default y coordinate. Keep `hidden` synchronized for the H3 controls we
// conditionally collapse, while preserving any pre-existing hidden state.
function syncLayoutWidgetVisibility(node, controller, derivedState = null) {
  const state = layoutVisibilityState(node, controller, derivedState);
  for (const widget of node?.widgets || []) {
    const visible = layoutWidgetVisibility(widget, controller, state);
    if (visible == null) continue;

    if (!visible) {
      if (!widget.__h3EasyVisibilityManaged) {
        widget.__h3EasyVisibilityManaged = true;
        widget.__h3EasyHiddenBeforeLayout = widget.hidden;
      }
      widget.hidden = true;
      continue;
    }

    if (widget.__h3EasyVisibilityManaged) {
      const previous = widget.__h3EasyHiddenBeforeLayout;
      if (previous === undefined) delete widget.hidden;
      else widget.hidden = previous;
      delete widget.__h3EasyHiddenBeforeLayout;
      delete widget.__h3EasyVisibilityManaged;
    }
  }
  if (controller) controller.layoutVisibilityState = state;
  return state;
}

function restoreLayoutWidgetVisibility(node) {
  for (const widget of node?.widgets || []) {
    if (!widget.__h3EasyVisibilityManaged) continue;
    const previous = widget.__h3EasyHiddenBeforeLayout;
    if (previous === undefined) delete widget.hidden;
    else widget.hidden = previous;
    delete widget.__h3EasyHiddenBeforeLayout;
    delete widget.__h3EasyVisibilityManaged;
  }
}

// All schema inputs are static. This only filters the *visual widget list* so
// irrelevant settings do not occupy the node. Values remain present, serialized,
// addressable by API, and immediately reappear when their connected context makes
// them meaningful. No click-to-expand state and no DynamicCombo behavior.
function installPromptFirstLayout(node, controller) {
  if (node.__h3EasyV4LayoutDispose || typeof node.getLayoutWidgets !== "function") return;

  const hadOwnGetLayoutWidgets = Object.prototype.hasOwnProperty.call(node, "getLayoutWidgets");
  const previousGetLayoutWidgets = node.getLayoutWidgets;
  const getLayoutWidgets = function (...args) {
    let state;
    let widgets;
    try {
      state = controller.layoutVisibilityState || syncLayoutWidgetVisibility(this, controller);
      widgets = previousGetLayoutWidgets.apply(this, args);
    } catch (error) {
      console.error("[MiniMax H3 Easy] Widget layout failed; falling back to ComfyUI's native widget order.", error);
      restoreLayoutWidgetVisibility(this);
      return previousGetLayoutWidgets.apply(this, args);
    }
    if (!Array.isArray(widgets) || !controller.widget) return widgets;

    const rest = [];
    let modeWidget = null;
    let conditioningWidget = null;
    let promptWidget = null;
    for (const widget of widgets) {
      if (widgetNameMatches(widget?.name, "mode")) { modeWidget = widget; continue; }
      if (widgetNameMatches(widget?.name, "conditioning_model")) { conditioningWidget = widget; continue; }
      if (widget === controller.widget) { promptWidget = widget; continue; }
      if (widget === controller.nativePromptWidget) continue;
      if (layoutWidgetVisibility(widget, controller, state) !== false) rest.push(widget);
    }
    const takeWidget = (predicate) => {
      const index = rest.findIndex(predicate);
      if (index < 0) return null;
      return rest.splice(index, 1)[0] || null;
    };
    const afterPrompt = [];
    const durationWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "seconds"));
    if (durationWidget) afterPrompt.push(durationWidget);
    const aspectWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "aspect_ratio"));
    if (aspectWidget) afterPrompt.push(aspectWidget);
    const resolutionWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "canvas"));
    if (resolutionWidget) afterPrompt.push(resolutionWidget);
    const widthWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "width"));
    const heightWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "height"));
    if (widthWidget) afterPrompt.push(widthWidget);
    if (heightWidget) afterPrompt.push(heightWidget);

    const endingResizeIndex = rest.findIndex((widget) => widgetNameMatches(widget?.name, "last_frame_resize"));
    if (endingResizeIndex >= 0) {
      const [endingResize] = rest.splice(endingResizeIndex, 1);
      const openingResizeIndex = rest.findIndex((widget) => widgetNameMatches(widget?.name, "first_frame_resize"));
      rest.splice(openingResizeIndex >= 0 ? openingResizeIndex + 1 : 0, 0, endingResize);
    }
    const soundtrackWidgets = [];
    for (let index = 0; index < 3; index += 1) {
      const widget = takeWidget((item) => widgetNameMatches(item?.name, `ref_video_use_audio_${index}`));
      if (widget) soundtrackWidgets.push(widget);
    }
    if (soundtrackWidgets.length) {
      const temporalIndex = rest.findIndex((widget) => widgetNameMatches(widget?.name, "ref_video_temporal_fit"));
      rest.splice(temporalIndex >= 0 ? temporalIndex + 1 : rest.length, 0, ...soundtrackWidgets);
    }
  return [conditioningWidget, modeWidget, promptWidget, ...afterPrompt, ...rest].filter(Boolean);
  };

  const dispose = () => {
    if (node.getLayoutWidgets === getLayoutWidgets) {
      if (hadOwnGetLayoutWidgets) node.getLayoutWidgets = previousGetLayoutWidgets;
      else delete node.getLayoutWidgets;
    }
    restoreLayoutWidgetVisibility(node);
    delete node.__h3EasyV4LayoutDispose;
  };

  node.getLayoutWidgets = getLayoutWidgets;
  node.__h3EasyV4LayoutDispose = dispose;
  controller.disposeLayout = dispose;
  syncLayoutWidgetVisibility(node, controller);
  node.graph?.setDirtyCanvas?.(true, false);
}


function injectStyles() {
  if (document.getElementById("minimax-h3-easy-v2-styles")) return;
  const style = document.createElement("style");
  style.id = "minimax-h3-easy-v2-styles";
  style.textContent = `
    .h3e-editor { position:relative; box-sizing:border-box; width:100%; height:100%; min-height:0; overflow:hidden; display:flex; flex-direction:column; gap:5px; padding:6px; font:12px/1.35 system-ui,sans-serif; color:var(--fg-color,#ddd); background:color-mix(in srgb,var(--comfy-menu-bg,#222) 90%,transparent); border:1px solid color-mix(in srgb,var(--border-color,#555) 75%,transparent); border-radius:7px; }
    .h3e-route-notice { flex:0 0 auto; padding:4px 7px; border-left:3px solid rgba(255,179,92,.72); border-radius:4px; color:#e0b77f; background:rgba(255,179,92,.07); font:800 10.5px/1.35 system-ui,sans-serif; }
    .h3e-route-notice[hidden] { display:none; }
    .h3e-head { display:flex; align-items:center; gap:6px; min-height:18px; }
    .h3e-profile { flex:0 0 auto; padding:2px 6px; border-radius:999px; font-size:10.5px; font-weight:800; letter-spacing:.02em; background:rgba(88,145,255,.16); color:#a9c7ff; border:1px solid rgba(88,145,255,.27); }
    .h3e-summary { flex:0 0 auto; min-width:0; display:flex; align-items:center; gap:6px; min-height:20px; color:#9facc0; font:800 9.5px/1.25 system-ui,sans-serif; }
    .h3e-summary-state { min-width:0; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .h3e-guide-progress { box-sizing:border-box; flex:0 1 48%; min-width:76px; max-width:48%; height:20px; overflow:hidden; padding:1px 6px; border:1px solid rgba(126,169,255,.28); border-radius:4px; color:#b8cff8; background:rgba(126,169,255,.07); font:800 9px/16px system-ui,sans-serif; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; }
    .h3e-guide-progress:hover:not(:disabled), .h3e-guide-progress:focus-visible:not(:disabled) { background:rgba(126,169,255,.16); }
    .h3e-guide-progress:disabled { color:#8490a2; border-color:rgba(120,145,185,.18); background:rgba(120,145,185,.035); cursor:default; }
    .h3e-status { min-width:0; flex:1; display:flex; align-items:center; gap:4px; color:inherit; text-align:left; cursor:help; border-radius:4px; outline:none; }
    .h3e-status.is-actionable { cursor:pointer; }
    .h3e-status.is-actionable:hover, .h3e-status.is-actionable:focus-visible { background:rgba(255,255,255,.045); }
    .h3e-status-toggle { flex:0 0 auto; width:10px; color:#9caabd; font:900 10px/1 system-ui,sans-serif; text-align:center; }
    .h3e-status-main { display:block; min-width:0; flex:1; font-size:11px; font-weight:800; color:#d8e6ff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .h3e-status-main.is-error { color:#ffb35c; }
    .h3e-status-main.is-ok { color:#7bdba5; }
    .h3e-diagnostic { display:none; flex:0 0 auto; min-height:0; max-height:120px; overflow:auto; border:1px solid rgba(255,179,92,.30); border-left:3px solid rgba(255,179,92,.72); border-radius:5px; padding:5px 7px; background:rgba(255,179,92,.07); color:#cbd3df; font-size:9.5px; line-height:1.3; }
    .h3e-diagnostic.open { display:block; }
    .h3e-diagnostic.is-note { border-color:rgba(126,169,255,.28); border-left-color:rgba(126,169,255,.72); background:rgba(126,169,255,.065); }
    .h3e-diagnostic.is-note .h3e-diagnostic-title { color:#abc8ff; }
    .h3e-diagnostic.is-note .h3e-diagnostic-button { border-color:rgba(126,169,255,.28); color:#c3d8ff; background:rgba(126,169,255,.08); }
    .h3e-diagnostic.is-note .h3e-diagnostic-button:hover:not(:disabled), .h3e-diagnostic.is-note .h3e-diagnostic-button:focus-visible:not(:disabled) { background:rgba(126,169,255,.16); }
    .h3e-diagnostic-main { display:block; }
    .h3e-diagnostic-copy { min-width:0; }
    .h3e-diagnostic-title { display:none; }
    .h3e-diagnostic-message { display:block; white-space:normal; overflow-wrap:anywhere; }
    .h3e-diagnostic-nav { display:none; flex:0 0 auto; align-items:center; gap:2px; }
    .h3e-diagnostic-nav.open { display:flex; }
    .h3e-diagnostic-count { min-width:24px; text-align:center; color:#9caabd; font:800 8.5px/18px system-ui,sans-serif; }
    .h3e-diagnostic-button { box-sizing:border-box; width:18px; height:18px; padding:0; border:1px solid rgba(255,179,92,.28); border-radius:4px; color:#ffd1a0; background:rgba(255,179,92,.08); font:900 11px/16px system-ui,sans-serif; cursor:pointer; }
    .h3e-diagnostic-button:hover:not(:disabled), .h3e-diagnostic-button:focus-visible:not(:disabled) { background:rgba(255,179,92,.18); }
    .h3e-diagnostic-button:disabled { opacity:.28; cursor:default; }
    .h3e-diagnostic-example { display:block; margin-top:4px; color:#9caabd; font:9px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .h3e-diagnostic-apply { margin-top:5px; padding:3px 7px; border:1px solid rgba(255,179,92,.34); border-radius:4px; color:#ffd1a0; background:rgba(255,179,92,.10); font:800 9px/1.25 system-ui,sans-serif; cursor:pointer; }
    .h3e-diagnostic-apply:hover, .h3e-diagnostic-apply:focus-visible { background:rgba(255,179,92,.20); }
    .h3e-diagnostic-apply[hidden] { display:none; }
    .h3e-textarea { box-sizing:border-box; width:100%; flex:1 1 96px; min-height:72px; overflow:auto; resize:none; border:1px solid rgba(130,145,170,.3); border-radius:6px; padding:9px 10px; outline:none; color:#e6e8ec; background:rgba(12,14,18,.84); font:12px/1.48 ui-monospace,SFMono-Regular,Consolas,monospace; tab-size:4; white-space:pre-wrap; }
    .h3e-textarea:focus { border-color:rgba(99,155,255,.72); box-shadow:0 0 0 1px rgba(99,155,255,.15); }
    .h3e-textarea::selection { background:rgba(76,132,224,.78); color:#fff; }
    .h3e-contextbar { display:none; }
    .h3e-hint { min-width:0; flex:1; color:#8d99aa; font-size:10.5px; line-height:1.35; white-space:normal; overflow-wrap:anywhere; }
    .h3e-menu { position:relative; z-index:4; flex:0 0 auto; width:100%; height:220px; min-height:220px; max-height:220px; box-sizing:border-box; overflow:hidden; display:none; grid-template-rows:minmax(0,1fr) 46px; border:1px solid rgba(120,145,185,.42); border-radius:7px; background:#171b22; box-shadow:0 6px 14px rgba(0,0,0,.24); }
    .h3e-menu.open { display:grid; }
    .h3e-menu-scroll { min-height:0; overflow-y:auto; overflow-x:hidden; padding:4px 4px 8px; scrollbar-gutter:stable; scroll-padding-block:4px 8px; }
    .h3e-menu-group { padding:6px 8px 3px; color:#75839a; font-size:9.5px; font-weight:900; letter-spacing:.09em; text-transform:uppercase; }
    .h3e-menu-row { width:100%; min-height:28px; box-sizing:border-box; display:flex; align-items:center; gap:8px; border:0; border-radius:5px; padding:5px 8px; margin:0; text-align:left; color:#dde5f2; background:transparent; cursor:pointer; }
    .h3e-menu-row.selected { background:rgba(81,132,220,.34); box-shadow:inset 3px 0 0 rgba(126,169,255,.9); }
    .h3e-menu-row.is-info { cursor:default; background:rgba(255,255,255,.018); border-left:2px solid rgba(120,145,185,.28); }
    .h3e-menu-row.is-info .h3e-menu-label { color:#aab6c8; }
    .h3e-menu-copy { min-width:0; flex:1; }
    .h3e-menu-label { display:block; font-weight:800; font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .h3e-menu-detail, .h3e-menu-insert { display:none; }
    .h3e-menu-inspector { box-sizing:border-box; height:46px; min-height:46px; overflow:hidden; padding:5px 8px; border-top:1px solid rgba(120,145,185,.24); color:#8e9aab; background:rgba(8,10,14,.28); }
    .h3e-menu-inspector-detail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:10px; line-height:1.35; }
    .h3e-menu-inspector-insert { margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#a6b6cf; font:9.5px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace; }
    .h3e-menu-inspector-insert::before { content:"Insert · "; color:#7f91ad; font:900 9px/1.35 system-ui,sans-serif; }
    .h3e-ref-thumb { flex:0 0 38px; width:38px; height:38px; box-sizing:border-box; object-fit:cover; border-radius:5px; border:1px solid rgba(126,145,176,.26); background:#0d1015; }
    .h3e-ref-badge { display:flex; align-items:center; justify-content:center; font:900 11px/1 system-ui,sans-serif; color:#9fb9e7; }
    .h3e-ref-badge.is-audio { color:#c5a7ff; }
    .h3e-ref-badge.is-video { color:#9ed6c0; }
  `;
  document.head.appendChild(style);
}

function canonicalLegacyMode(value) {
  const text = String(value ?? "").toLowerCase();
  if (/audio[- ]?first|audio only|t2a|r2a|i2a|v2a|a2a/i.test(text)) return MODE_AUDIO;
  return MODE_VIDEO;
}

function preserveLegacyModelSelection(workflow) {
  let preserved = 0;
  pendingLegacyModels.clear();
  const workflowNodes = workflow?.nodes || [];
  const inputsFor = (node) => Array.isArray(node?.inputs) ? node.inputs : [];
  const nodesById = new Map(workflowNodes.map((node) => [String(node?.id), node]));
  const workflowLinks = Array.isArray(workflow?.links) ? workflow.links : Object.values(workflow?.links || {});
  const linkById = (id) => workflowLinks.find((link) => String(Array.isArray(link) ? link[0] : link?.id) === String(id));
  const inputLeaf = (input) => String(input?.name ?? "").split(/[.:/]/).at(-1) || "";
  const workflowSourceNodeForInput = (input) => {
    const visitedNodes = new Set();
    let linkId = input?.link;
    while (linkId != null) {
      const link = linkById(linkId);
      const originId = Array.isArray(link) ? link[1] : link?.origin_id ?? link?.origin_node_id ?? link?.originNodeId;
      if (originId == null || visitedNodes.has(String(originId))) return null;
      visitedNodes.add(String(originId));
      const origin = nodesById.get(String(originId));
      if (!origin || !/reroute/i.test(String(origin.type ?? ""))) return origin || null;
      const upstreamInput = inputsFor(origin).find((candidate) => candidate?.link != null);
      linkId = upstreamInput?.link;
    }
    return null;
  };
  const serializedWidgetValue = (node, suffix) => {
    if (!Array.isArray(node?.widgets_values)) return undefined;
    let widgetIndex = 0;
    for (const input of inputsFor(node)) {
      if (!input?.widget) continue;
      const matches = widgetNameMatches(input?.name, suffix) || widgetNameMatches(input?.widget?.name, suffix);
      const value = node.widgets_values[widgetIndex];
      widgetIndex += 1;
      if (matches) return value;
    }
    return undefined;
  };
  const connectionModel = (node) => inputsFor(node).some((input) => (
    input?.link != null && /^(?:ref_image|ref_video|ref_video_audio|ref_audio)_\d+$/.test(inputLeaf(input))
  )) ? CONDITIONING_MODEL_REF2VA : CONDITIONING_MODEL_FL2VA;
  const hasConcreteAudioProvision = (node, modeValue) => {
    if (!LEGACY_AUDIO_MODES.has(String(modeValue ?? ""))) return false;
    const bundleInput = inputsFor(node).find((input) => widgetNameMatches(input?.name, "h3_bundle"));
    if (bundleInput?.link == null) return false;
    const loader = workflowSourceNodeForInput(bundleInput);
    if (loader?.type !== "MiniMaxH3EasyLoader") return false;
    const audioInput = inputsFor(loader).find((input) => widgetNameMatches(input?.name, "audio_model") || widgetNameMatches(input?.widget?.name, "audio_model"));
    if (!audioInput) return false;
    const value = String(serializedWidgetValue(loader, "audio_model") ?? "").trim();
    if (!value || /^(?:auto|none|disabled|follow|same\b|no\s+(?:separate\s+)?audio)/i.test(value)) return false;
    return true;
  };

  for (const node of workflowNodes) {
    if (![NODE_CLASS, "MiniMaxH3EasyV3", "MiniMaxH3EasyV2", "MiniMaxH3Easy"].includes(node?.type)) continue;
    const modeValue = Array.isArray(node.widgets_values) ? node.widgets_values[0] : null;
    const modelInput = inputsFor(node).find((input) => widgetNameMatches(input?.name, "conditioning_model"));
    const serializedModel = modelInput ? String(serializedWidgetValue(node, "conditioning_model") ?? "") : "";
    const hasSerializedModel = Boolean(modelInput && serializedModel);
    const previousConnectionModel = connectionModel(node);

    let selection = hasConcreteAudioProvision(node, modeValue) ? REMOVED_AUDIO_MODEL : legacyModelSelection(modeValue);
    if (node?.type === NODE_CLASS && hasSerializedModel) {
      const canonicalModel = canonicalWidgetValue("conditioning_model", serializedModel);
      if ([CONDITIONING_MODEL_FL2VA, CONDITIONING_MODEL_REF2VA].includes(canonicalModel)) continue;
      if (canonicalModel !== REMOVED_AUDIO_MODEL) continue;
      selection = REMOVED_AUDIO_MODEL;
    } else if (!selection) {
      selection = previousConnectionModel;
    }
    if (!selection) continue;
    pendingLegacyModels.set(node.id, selection);
    preserved += 1;
  }
  return preserved;
}

function migrateRemovedAudioModelInput(workflow) {
  let migrated = 0;
  for (const node of workflow?.nodes || []) {
    if (node?.type !== "MiniMaxH3EasyLoader" || !Array.isArray(node.inputs)) continue;
    let widgetIndex = 0;
    let removedWidgetIndex = -1;
    let removedInputIndex = -1;
    for (let inputIndex = 0; inputIndex < node.inputs.length; inputIndex += 1) {
      const input = node.inputs[inputIndex];
      if (widgetNameMatches(input?.name, "audio_model") || widgetNameMatches(input?.widget?.name, "audio_model")) {
        removedInputIndex = inputIndex;
        if (input?.widget) removedWidgetIndex = widgetIndex;
        break;
      }
      if (input?.widget) widgetIndex += 1;
    }
    if (removedInputIndex < 0) continue;
    const removedLinkIds = new Set();
    if (node.inputs[removedInputIndex]?.link != null) removedLinkIds.add(String(node.inputs[removedInputIndex].link));
    const linkEntries = Array.isArray(workflow?.links)
      ? workflow.links.map((link, index) => [String(index), link])
      : Object.entries(workflow?.links || {});
    for (const [key, link] of linkEntries) {
      const targetId = Array.isArray(link) ? link[3] : link?.target_id ?? link?.target_node_id ?? link?.targetNodeId;
      const targetSlot = Number(Array.isArray(link) ? link[4] : link?.target_slot ?? link?.targetSlot);
      if (String(targetId) !== String(node.id)) continue;
      if (targetSlot === removedInputIndex) {
        removedLinkIds.add(String(Array.isArray(link) ? link[0] : link?.id ?? key));
      } else if (targetSlot > removedInputIndex) {
        if (Array.isArray(link)) link[4] = targetSlot - 1;
        else if (Object.prototype.hasOwnProperty.call(link, "target_slot")) link.target_slot = targetSlot - 1;
        else if (Object.prototype.hasOwnProperty.call(link, "targetSlot")) link.targetSlot = targetSlot - 1;
      }
    }
    node.inputs.splice(removedInputIndex, 1);
    if (removedWidgetIndex >= 0 && Array.isArray(node.widgets_values)) node.widgets_values.splice(removedWidgetIndex, 1);
    if (removedLinkIds.size) {
      if (Array.isArray(workflow.links)) {
        workflow.links = workflow.links.filter((link) => !removedLinkIds.has(String(Array.isArray(link) ? link[0] : link?.id)));
      } else if (workflow.links && typeof workflow.links === "object") {
        for (const [key, link] of Object.entries(workflow.links)) {
          if (removedLinkIds.has(String(link?.id ?? key))) delete workflow.links[key];
        }
      }
      for (const source of workflow?.nodes || []) {
        for (const output of source?.outputs || []) {
          if (!Array.isArray(output?.links)) continue;
          const links = output.links.filter((linkId) => !removedLinkIds.has(String(linkId)));
          output.links = links.length ? links : null;
        }
      }
    }
    migrated += 1;
  }
  return migrated;
}

function canonicalLegacyRole(value) {
  const text = String(value ?? "").toLowerCase();
  return /last|尾|末|final/.test(text) ? KEYFRAME_LAST : KEYFRAME_FIRST;
}

function canonicalLegacyRefSize(value) {
  const aliased = canonicalWidgetValue("ref_image_size", value);
  if (H3E_VALID.refImageSize.has(aliased)) return aliased;
  const text = String(value ?? "").toLowerCase();
  return /(?:^|\b)(?:2k|max|2048)(?:\b|$)/.test(text)
    ? "Preserve source detail (2048px short-edge cap; slower)"
    : "Match output area (predictable token cost)";
}

function migrateRemovedAdvancedSelector(workflow) {
  let migrated = 0;
  for (const node of workflow?.nodes || []) {
    if (node?.type !== "MiniMaxH3EasyV2" || !Array.isArray(node.widgets_values)) continue;
    const values = node.widgets_values;
    const text = (value) => String(value ?? "").trim().toLowerCase();
    const finiteFps = (value) => {
      const fps = Number(value);
      return Number.isFinite(fps) && fps >= 1 && fps <= 120 ? fps : H3E_DEFAULTS.playbackFps;
    };

    // v2.0.22 serialized Advanced immediately before its optional child and
    // the prompt widget. Collapse that old DynamicCombo without disturbing the
    // prompt or any earlier mode/canvas child values.
    if (values.length >= 3 && text(values.at(-3)) === "on") {
      const fps = finiteFps(values.at(-2));
      values.splice(values.length - 3, 2, fps);
      migrated += 1;
      continue;
    }
    if (values.length >= 2 && ["on", "off"].includes(text(values.at(-2)))) {
      values[values.length - 2] = H3E_DEFAULTS.playbackFps;
      migrated += 1;
    }
  }
  return migrated;
}

function migrateRemovedAudioProxyCanvas(workflow) {
  let migrated = 0;
  for (const node of workflow?.nodes || []) {
    if (![NODE_CLASS, "MiniMaxH3EasyV2", "MiniMaxH3Easy"].includes(node?.type) || !Array.isArray(node.widgets_values)) continue;
    for (let index = 0; index < node.widgets_values.length; index += 1) {
      if (String(node.widgets_values[index] ?? "") !== H3E_VALUES.audioProxyCanvas) continue;
      node.widgets_values[index] = H3E_DEFAULTS.canvas;
      migrated += 1;
    }
  }
  return migrated;
}

function migrateRemovedCompiledPromptOutput(workflow) {
  const nodes = workflow?.nodes || [];
  const easyNodes = nodes.filter((node) => node?.type === NODE_CLASS);
  if (!easyNodes.length) return 0;

  const easyIds = new Set(easyNodes.map((node) => String(node.id)));
  const removedLinkIds = new Set();
  for (const node of easyNodes) {
    if (!Array.isArray(node.outputs) || node.outputs.length <= 2) continue;
    for (const output of node.outputs.slice(2)) {
      for (const linkId of output?.links || []) removedLinkIds.add(String(linkId));
    }
    node.outputs = node.outputs.slice(0, 2);
  }

  const entries = Array.isArray(workflow?.links)
    ? workflow.links.map((link, index) => [String(index), link])
    : Object.entries(workflow?.links || {});
  for (const [key, link] of entries) {
    const originId = Array.isArray(link) ? link[1] : link?.origin_id ?? link?.origin_node_id ?? link?.originNodeId;
    const originSlot = Number(Array.isArray(link) ? link[2] : link?.origin_slot ?? link?.originSlot);
    if (!easyIds.has(String(originId)) || originSlot < 2) continue;
    const linkId = Array.isArray(link) ? link[0] : link?.id ?? key;
    removedLinkIds.add(String(linkId));
  }
  if (!removedLinkIds.size) return 0;

  if (Array.isArray(workflow.links)) {
    workflow.links = workflow.links.filter((link) => !removedLinkIds.has(String(Array.isArray(link) ? link[0] : link?.id)));
  } else if (workflow.links && typeof workflow.links === "object") {
    for (const [key, link] of Object.entries(workflow.links)) {
      if (removedLinkIds.has(String(link?.id ?? key))) delete workflow.links[key];
    }
  }
  for (const node of nodes) {
    for (const input of node?.inputs || []) {
      if (input?.link != null && removedLinkIds.has(String(input.link))) input.link = null;
    }
    for (const output of node?.outputs || []) {
      if (!Array.isArray(output?.links)) continue;
      const remaining = output.links.filter((linkId) => !removedLinkIds.has(String(linkId)));
      output.links = remaining.length ? remaining : null;
    }
  }
  return removedLinkIds.size;
}

function migrateV2IntentMode(workflow) {
  let migrated = 0;
  for (const node of workflow?.nodes || []) {
    if (node?.type !== "MiniMaxH3EasyV2" || !Array.isArray(node.widgets_values) || !node.widgets_values.length) continue;
    const before = node.widgets_values[0];
    const after = canonicalLegacyMode(before);
    if (before !== after) {
      node.widgets_values[0] = after;
      migrated += 1;
    }
  }
  return migrated;
}

function migrateLegacyWorkflow(workflow) {
  let migrated = 0;
  for (const node of workflow?.nodes || []) {
    if (node?.type !== "MiniMaxH3Easy") continue;
    const values = node.widgets_values;
    if (Array.isArray(values)) {
      if (values.length > 0) values[0] = canonicalLegacyMode(values[0]);
      if (values.length > 8) values[8] = values[8] === false || String(values[8]).toLowerCase() === "off" ? "Off" : "On";
      if (values.length > 10) values[10] = canonicalLegacyRole(values[10]);
      if (values.length > 11) values[11] = canonicalLegacyRefSize(values[11]);
    }
    node.properties ||= {};
    const virtualCount = Array.isArray(node.properties.minimax_h3_virtual_media_links)
      ? node.properties.minimax_h3_virtual_media_links.length
      : 0;
    if (virtualCount) node.properties.minimax_h3_v2_reconnect_media_count = virtualCount;
    migrated += 1;
  }
  legacyMigrationCount += migrated;
}

function textBeforeCaret(textarea) {
  return textarea.value.slice(0, textarea.selectionStart ?? 0);
}

function currentLineBeforeCaret(textarea) {
  const before = textBeforeCaret(textarea);
  return before.slice(before.lastIndexOf("\n") + 1);
}

function nextSubjectOrdinal(prompt) {
  const ordinals = standaloneDefinitions(prompt)
    .filter((definition) => definition.kind === "subject")
    .map((definition) => definition.ordinal);
  return (ordinals.length ? Math.max(...ordinals) : 0) + 1;
}

function joinTokens(tokens) {
  if (tokens.length <= 1) return tokens[0] || "";
  if (tokens.length === 2) return `${tokens[0]} and ${tokens[1]}`;
  return `${tokens.slice(0, -1).join(", ")}, and ${tokens.at(-1)}`;
}

function speakerIdsIn(text) {
  const ids = new Set();
  for (const match of String(text || "").matchAll(/\bS(\d+)\b/g)) ids.add(Number(match[1]));
  return ids;
}

function timelineBodyForPrompt(prompt) {
  return sectionBody(prompt, "detailed_description", REF_SECTIONS)
    || sectionBody(prompt, "integrated_multimodal_description", BASE_SECTIONS);
}

function vocalClauseBeforeEditor(source, index) {
  const before = String(source || "").slice(0, Math.max(0, index));
  const lineBoundary = before.lastIndexOf("\n");
  const shotBoundary = before.lastIndexOf("[Shot");
  const clauseStart = Math.max(lineBoundary, shotBoundary, -1) + 1;
  const tail = before.slice(clauseStart);
  let localBoundary = 0;
  for (const boundary of tail.matchAll(/[.!?](?:["')\]]*)\s+/g)) {
    localBoundary = (boundary.index || 0) + boundary[0].length;
  }
  return before.slice(clauseStart + localBoundary);
}

function knownSpeakerIds(prompt) {
  // MiniMax assigns S1/S2/... from actual vocal events in target playback order.
  // Definitions or non-vocal mentions may reuse IDs but must never allocate them.
  const timeline = timelineBodyForPrompt(prompt);
  const ids = new Set();
  for (const match of timeline.matchAll(/<d>[\s\S]*?<\/d>/gi)) {
    const clause = vocalClauseBeforeEditor(timeline, match.index || 0);
    const speaker = [...clause.matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/gi)].at(-1);
    if (!speaker) continue;
    for (const idMatch of String(speaker[1]).matchAll(/S(\d+)/gi)) ids.add(Number(idMatch[1]));
  }
  return ids;
}

function nextSpeakerOrdinal(prompt) {
  const ids = knownSpeakerIds(prompt);
  return (ids.size ? Math.max(...ids) : 0) + 1;
}

function knownSubjectSpeakerBindings(prompt) {
  // Speaker IDs are assigned by actual target-timeline vocal events. Only infer
  // a Subject -> Sx binding when the timeline itself states the pair directly,
  // e.g. @Subject3 (S2) ... <d>...</d>. Never guess a mapping from Subject order.
  const timeline = timelineBodyForPrompt(prompt);
  const result = [];
  const seen = new Set();
  for (const dialogue of timeline.matchAll(/<d>[\s\S]*?<\/d>/gi)) {
    const clause = vocalClauseBeforeEditor(timeline, dialogue.index || 0);
    for (const match of clause.matchAll(/(?:@Subject(\d+)\b|<Subject\s+(\d+)>)\s*\(S(\d+)\)/gi)) {
      const subjectOrdinal = Number(match[1] || match[2]);
      const speakerId = Number(match[3]);
      if (!(subjectOrdinal > 0 && speakerId > 0)) continue;
      const key = `${subjectOrdinal}:${speakerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ subjectToken: `@Subject${subjectOrdinal}`, subjectOrdinal, speakerId });
    }
  }
  return result;
}


function nextShot(prompt, state) {
  const matches = [...String(prompt || "").matchAll(/^[ \t]*\[Shot\s+(\d+)\]/gim)];
  const number = matches.length ? Math.max(...matches.map((m) => Number(m[1]))) + 1 : 1;
  if (number === 1) return { text: "[Shot 1] ", selectText: null, detail: "Opening shot. Shot 1 starts at 0.000s implicitly and has no timestamp." };
  const text = `[Shot ${number}] At 00:00.000, `;
  return { text, selectText: "00:00.000", detail: `Official cut marker. Replace the timestamp with a strictly increasing cut time below ${state.effectiveSeconds.toFixed(2)}s.` };
}

function referenceInputLeaf(inputName) {
  const value = String(inputName || "").trim();
  return value.split(/[.:/]/).at(-1) || value;
}

function isAudioReferenceKind(kind) {
  return kind === "audio" || kind === "soundtrack";
}

function availableReferenceDescriptors(state) {
  return [...(state.refs || []), ...(state.videoAudioRefs || [])];
}

function physicalReferenceDescriptor(state, definition) {
  return availableReferenceDescriptors(state).find((ref) => ref.kind === definition.kind && ref.ordinal === definition.ordinal) || null;
}

function referencePreviewType(ref) {
  return ref?.kind === "soundtrack" ? "audio" : ref?.kind;
}

function referenceSocketLabel(ref) {
  const inputName = referenceInputLeaf(ref?.inputName);
  return inputName ? `${ref.token} · ${inputName}` : ref.token;
}

function referenceSocketDetail(ref) {
  const inputName = referenceInputLeaf(ref?.inputName);
  if (!inputName) return ref.token;
  return `${ref.token} maps to connected socket ${inputName}.`;
}

function referenceContextDetail(ref, section) {
  const base = ref.kind === "image" ? "Picture source" : ref.kind === "video" ? "Video source" : "Audio source";
  const socketDetail = referenceSocketDetail(ref);
  if (!section) return `${base} · ${socketDetail} ${ref.detail}`;
  if (ref.kind === "image") {
    if (section === "subject_definitions") return `${base} · cite inside @SubjectN for appearance/style; standalone only for concrete frame/storyboard roles.`;
    if (section === "summary") return `${base} · use here only if defined as its own tracked Picture.`;
    if (section === "retention_analysis") return `${base} · own retention row only when tracked standalone.`;
    if (section === "detailed_description") return `${base} · cite where its frame/anchor role applies.`;
  }
  if (ref.kind === "video") {
    if (section === "subject_definitions") return `${base} · standalone for edit/continuation/camera/cut/rhythm/temporal structure; visible content belongs to @SubjectN.`;
    if (section === "summary") return `${base} · role comes from subject_definitions; video presence alone does not mean edit/continuation.`;
    if (section === "retention_analysis") return `${base} · retain the defined video-level role.`;
    if (section === "detailed_description") return `${base} · cite where its edit/continuation/structure role applies.`;
  }
  if (isAudioReferenceKind(ref.kind)) {
    if (section === "subject_definitions") return `${base} · define copy vs reference role and what it supplies.`;
    if (section === "summary") return `${base} · audio reuse = copied signal; audio reference = guidance only.`;
    if (section === "retention_analysis") return `${base} · fully_copy / partially_copy / reference / weak_reference.`;
    if (section === "overall_soundscape") return `${base} · ambience/SFX role only.`;
    if (section === "non_diegetic_music") return `${base} · audience-only score role only.`;
    if (section === "detailed_description") return `${base} · cite where the audio role is active.`;
  }
  return base;
}

function referenceContextExample(ref, section) {
  if (!section) return null;
  if (ref.kind === "image") {
    if (section === "subject_definitions") return `Source-only: @Subject1 is the same character shown in ${ref.token}; ${ref.token} provides the frontal appearance. Standalone: ${ref.token} is the first frame of [Shot 1], showing ...`;
    if (section === "summary") return `[keyframe completion] The target video begins from ${ref.token} and then develops forward ...`;
    if (section === "retention_analysis") return `${ref.token} ([Shot 1] first frame): fully_preserved - preserve the framing, subject placement, and lighting.`;
    if (section === "detailed_description") return `The shot begins from ${ref.token}; @Subject1 then turns toward the doorway.`;
  }
  if (ref.kind === "video") {
    if (section === "subject_definitions") return `Whole-video role: ${ref.token} is referenced for its camera movement and cut rhythm. Visible person only: define that person as @SubjectN instead.`;
    if (section === "summary") return `[reference generation] The target follows ${ref.token}'s camera rhythm while generating new subject content.`;
    if (section === "retention_analysis") return `${ref.token} (cut and pacing structure): weak_reference - retain the broad cut cadence without copying the source footage.`;
    if (section === "detailed_description") return `The camera movement follows the arc-and-push pattern referenced from ${ref.token}.`;
  }
  if (isAudioReferenceKind(ref.kind)) {
    if (section === "subject_definitions") return `${ref.token} is a background-music style reference; its signal is not copied directly.`;
    if (section === "summary") return `[audio reference] The target speaker follows ${ref.token}'s voice timbre without copying the signal.`;
    if (section === "retention_analysis") return `${ref.token}: reference - match the voice timbre and measured delivery without copying the source signal.`;
    if (section === "overall_soundscape") return `${ref.token} is referenced for its rain ambience and distant traffic texture.`;
    if (section === "non_diegetic_music") return `${ref.token} is referenced for its sparse piano instrumentation and slow pulse.`;
    if (section === "detailed_description") return `@Subject1 (S1) speaks with the timbre referenced from ${ref.token}: <d>[English] Hello.</d>`;
  }
  if (ref.kind === "subject") {
    if (section === "summary") return `[reference generation] The target video keeps ${ref.token}'s identity while placing the character in a new scene.`;
    if (section === "retention_analysis") return `${ref.token} (appears in [Shot 1]): fully_preserved - preserve identity, outfit, proportions, and facial features.`;
    if (section === "detailed_description") return `[Shot 1] ${ref.token} stands left of center, keeping the referenced appearance and clothing.`;
  }
  return null;
}

function roleOption(ref, label, detail, insertText, group, example = null, selectText = null) {
  return {
    ...insertOption(label, detail, insertText, group, selectText, example),
    previewType: referencePreviewType(ref),
    inputName: ref.inputName || null,
    ordinal: ref.ordinal,
  };
}

function appendSectionText(prompt, section, nextSection, text, separator = "\n") {
  const source = String(prompt || "");
  const header = `${section}:`;
  const start = source.indexOf(header);
  if (start < 0) return source;
  const bodyStart = start + header.length;
  const next = source.indexOf(`\n\n${nextSection}:`, bodyStart);
  if (next < 0) return source;
  const body = source.slice(bodyStart, next);
  const join = body.trim() ? separator : "\n";
  return `${source.slice(0, next)}${join}${text}${source.slice(next)}`;
}

function appendFinalSectionText(prompt, section, text, separator = "\n") {
  const source = String(prompt || "");
  const header = `${section}:`;
  const start = source.indexOf(header);
  if (start < 0) return source;
  const body = source.slice(start + header.length);
  const join = body.trim() ? separator : "\n";
  return `${source}${join}${text}`;
}

function placeAudioLayerText(prompt, section, text) {
  const source = String(prompt || "");
  const scaffold = section === "overall_soundscape"
    ? "{ambience + physical / non-verbal sounds, or N/A only if completely silent}"
    : "{audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A}";
  if (source.includes(scaffold)) return source.replace(scaffold, text);
  if (section === "overall_soundscape") return appendSectionText(source, section, "non_diegetic_music", text);
  return appendFinalSectionText(source, section, text);
}

function appendFirstShotText(prompt, text) {
  const source = String(prompt || "");
  const header = "detailed_description:";
  const bodyStart = source.indexOf(header);
  if (bodyStart < 0) return source;
  const contentStart = bodyStart + header.length;
  const sectionEnd = source.indexOf("\n\noverall_soundscape:", contentStart);
  if (sectionEnd < 0) return source;
  const body = source.slice(contentStart, sectionEnd);
  const firstShot = /(?:^|\n)[ \t]*\[Shot\s+1\]/i.exec(body);
  const clause = String(text || "").replace(/^\s*\[Shot\s+1\]\s*/i, "").trim();
  if (!clause) return source;
  if (!firstShot) return appendSectionText(source, "detailed_description", "overall_soundscape", `[Shot 1] ${clause}`);
  const afterFirstShot = firstShot.index + firstShot[0].length;
  const laterShot = /\n[ \t]*\[Shot\s+(?:[2-9]\d*|1\d+)\]/i.exec(body.slice(afterFirstShot));
  const firstShotEnd = laterShot ? afterFirstShot + laterShot.index : body.length;
  let field = null;
  let fieldIndex = -1;
  for (const candidate of [
    "{action in playback order}",
    "{audio events in playback order}",
    "{synchronized sound / dialogue if present}",
  ]) {
    const candidateIndex = body.indexOf(candidate, afterFirstShot);
    if (candidateIndex >= 0 && candidateIndex < firstShotEnd) {
      field = candidate;
      fieldIndex = candidateIndex;
      break;
    }
  }
  if (field) {
    const insertion = contentStart + fieldIndex;
    return `${source.slice(0, insertion)}${clause} ${field}${source.slice(insertion + field.length)}`;
  }
  const insertion = laterShot
    ? contentStart + afterFirstShot + laterShot.index
    : sectionEnd;
  return `${source.slice(0, insertion)}\n${clause}${source.slice(insertion)}`;
}

function replaceFirstShotActionText(prompt, text) {
  const source = String(prompt || "");
  const clause = String(text || "").replace(/^\s*\[Shot\s+1\]\s*/i, "").trim();
  if (!clause) return source;
  const header = "detailed_description:";
  const bodyStart = source.indexOf(header);
  if (bodyStart < 0) return source;
  const contentStart = bodyStart + header.length;
  const sectionEnd = source.indexOf("\n\noverall_soundscape:", contentStart);
  if (sectionEnd < 0) return source;
  const body = source.slice(contentStart, sectionEnd);
  const firstShot = /(?:^|\n)[ \t]*\[Shot\s+1\]/i.exec(body);
  if (!firstShot) return appendFirstShotText(source, text);
  const afterFirstShot = firstShot.index + firstShot[0].length;
  const laterShot = /\n[ \t]*\[Shot\s+(?:[2-9]\d*|1\d+)\]/i.exec(body.slice(afterFirstShot));
  const firstShotEnd = laterShot ? afterFirstShot + laterShot.index : body.length;
  const field = "{action in playback order}";
  const fieldIndex = body.indexOf(field, afterFirstShot);
  if (fieldIndex < 0 || fieldIndex >= firstShotEnd) return appendFirstShotText(source, text);
  const start = contentStart + fieldIndex;
  const fieldEnd = start + field.length;
  const end = /[.!?]$/.test(clause) && source[fieldEnd] === "." ? fieldEnd + 1 : fieldEnd;
  return source.slice(0, start) + clause + source.slice(end);
}

function addSummaryTask(prompt, task) {
  const source = String(prompt || "");
  if (source.includes("{summary task type}")) return source.replace("{summary task type}", task);
  const match = source.match(/(summary:\s*\n\s*)\[([^\]\n]+)\]/i);
  if (!match) return source;
  const tasks = match[2].split("+").map((value) => value.trim()).filter(Boolean);
  if (tasks.includes(task)) return source;
  const replacement = `${match[1]}[${[...tasks, task].join(" + ")}]`;
  return source.slice(0, match.index) + replacement + source.slice((match.index || 0) + match[0].length);
}

function relationshipBundlePrompt(prompt, placeholder, spec) {
  const source = String(prompt || "");
  let result = source.slice(0, placeholder.start)
    + `${spec.definition}\n{define tracked reference content}`
    + source.slice(placeholder.end);
  result = addSummaryTask(result, spec.task);
  if (result.includes("{target video + main reference relationships}")) {
    result = result.replace("{target video + main reference relationships}", spec.summary);
  } else {
    result = appendSectionText(result, "summary", "retention_analysis", spec.summary, " ");
  }
  if (result.includes("{retention rows for tracked references}")) {
    result = result.replace("{retention rows for tracked references}", `${spec.retention}\n{retention rows for tracked references}`);
  } else {
    result = appendSectionText(result, "retention_analysis", "detailed_description", spec.retention);
  }
  if (spec.detailed) {
    result = spec.replaceAction
      ? replaceFirstShotActionText(result, spec.detailed)
      : appendFirstShotText(result, spec.detailed);
  }
  if (spec.soundscape) result = placeAudioLayerText(result, "overall_soundscape", spec.soundscape);
  if (spec.music) result = placeAudioLayerText(result, "non_diegetic_music", spec.music);
  return result;
}

function relationshipBundleOption(ref, prompt, placeholder, spec) {
  return {
    ...roleOption(ref, spec.label, spec.detail, spec.definition, `Relationship builder - ${ref.token}`, spec.example, spec.select),
    replacePrompt: relationshipBundlePrompt(prompt, placeholder, spec),
  };
}

function referenceRelationshipBundleOptions(state, prompt, placeholder) {
  if (state.editorProfile !== PROFILE.REF2VA) return [];
  const subject = `@Subject${nextSubjectOrdinal(prompt)}`;
  const tracked = new Set(standaloneDefinitions(prompt).map((definition) => `${definition.kind}:${definition.ordinal}`));
  const options = [];
  for (const ref of availableReferenceDescriptors(state)) {
    const alreadyTracked = tracked.has(`${ref.kind}:${ref.ordinal}`);
    if (ref.kind === "image") {
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / subject identity bundle`,
        detail: "Use the Picture as provenance for a reusable Subject and fill matching Reference sections.",
        definition: `${subject} is {tracked subject} shown in ${ref.token}; ${ref.token} provides {source contribution}.`,
        task: "reference generation",
        summary: `The target video keeps ${subject}'s defined identity while depicting {overall action / premise}.`,
        retention: `${subject} (appears in [Shot 1]): fully_preserved - preserve {identity / appearance / structure to keep}.`,
        detailed: `[Shot 1] ${subject}'s target motion follows {action / motion performance}, while the defined identity and appearance remain consistent.`,
        replaceAction: true,
        example: `${subject} is the woman shown in ${ref.token}; ${ref.token} provides her face, hair, clothing, and proportions.`,
        select: "{tracked subject}",
      }));
      if (alreadyTracked) continue;
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / first-frame bundle`,
        detail: "Track the Picture as a concrete opening frame and fill keyframe-completion relationships.",
        definition: `${ref.token} is the first frame of [Shot 1], showing {subject / scene / composition}.`,
        task: "keyframe completion",
        summary: `The target video begins from ${ref.token} and depicts {overall action / premise}.`,
        retention: `${ref.token} ([Shot 1] first frame): fully_preserved - preserve {identity / appearance / structure to keep}.`,
        detailed: `[Shot 1] The shot begins from ${ref.token}; {action onset}. {continuous development}.`,
        replaceAction: true,
        example: `${ref.token} is the first frame of [Shot 1], showing the subject beside a rain-covered window.`,
        select: "{subject / scene / composition}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / last-frame bundle`,
        detail: "Track the Picture as the concrete final frame and scaffold convergence toward it.",
        definition: `${ref.token} is the last frame of [Shot 1], showing {final pose / state / composition}.`,
        task: "keyframe completion",
        summary: `The target video progresses toward ${ref.token} as its final frame while depicting {overall action / premise}.`,
        retention: `${ref.token} ([Shot 1] last frame): fully_preserved - preserve {identity / appearance / structure to keep}.`,
        detailed: `[Shot 1] {state before the final frame}. {motion toward the final frame}. {final-frame convergence}, landing on ${ref.token}.`,
        replaceAction: true,
        example: `${ref.token} is the last frame of [Shot 1], showing the subject holding an open umbrella.`,
        select: "{final pose / state / composition}",
      }));
    } else if (ref.kind === "video" && !alreadyTracked) {
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / direct-edit bundle`,
        detail: "Use the source video itself as the footage being edited.",
        definition: `${ref.token} is the source video for the target video edit.`,
        task: "video editing",
        summary: `The target video is an edited version of ${ref.token} and depicts {overall action / premise}.`,
        retention: `${ref.token}: partially_preserved - keep {features retained}; change {features changed}.`,
        detailed: `[Shot 1] The edit follows ${ref.token}'s source timeline. {action in playback order}.`,
        replaceAction: true,
        example: `${ref.token} is the source video for the target edit; preserve its timing while replacing the background.`,
        select: "{features retained}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / continuation bundle`,
        detail: "Continue from the source video's ending state.",
        definition: `${ref.token} is the source video whose ending state is continued by the target video.`,
        task: "video continuation",
        summary: `The target video continues from ${ref.token}'s ending state while depicting {overall action / premise}.`,
        retention: `${ref.token}: fully_preserved - preserve {identity / appearance / structure to keep} at the continuation boundary.`,
        detailed: `[Shot 1] The target continues from ${ref.token}'s ending state; {action / motion performance} guides the new target motion.`,
        replaceAction: true,
        example: `${ref.token} ends with the subject facing a doorway; the target continues from that exact state.`,
        select: "{overall action / premise}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / camera-temporal bundle`,
        detail: "Reference camera movement, cuts, rhythm, pacing, or whole-video temporal structure without editing the footage.",
        definition: `${ref.token} is referenced for its camera movement, cuts, rhythm, pacing, and temporal structure.`,
        task: "reference generation",
        summary: `The target video follows ${ref.token}'s camera and temporal structure while depicting {overall action / premise}.`,
        retention: `${ref.token}: weak_reference - retain broad similarity in {camera movement / cut cadence / pacing / temporal structure}.`,
        detailed: `[Shot 1] The target follows the camera movement and temporal structure referenced from ${ref.token}; {action / motion performance} guides the target action.`,
        replaceAction: true,
        example: `${ref.token} provides a slow arc, short push-in, and slow-fast-slow cut rhythm without supplying target footage.`,
        select: "{overall action / premise}",
      }));
    } else if (isAudioReferenceKind(ref.kind) && !alreadyTracked) {
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / full-signal-reuse bundle`,
        detail: "Copy the complete source signal unchanged as the final audio track and cite where it takes effect.",
        definition: `${ref.token} is the reference audio whose complete signal is reused unchanged as the target video's final audio track.`,
        task: "audio reuse",
        summary: `The target video's audio fully reuses ${ref.token} as its complete final track while the video depicts {overall action / premise}.`,
        retention: `${ref.token}: fully_copy - reuse the complete signal unchanged as the final audio track.`,
        detailed: `[Shot 1] Throughout the target video, ${ref.token} supplies the complete final audio signal unchanged and remains synchronized to target playback.`,
        example: `${ref.token} is reused unchanged as the complete final audio track for the target video.`,
        select: "{overall action / premise}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / partial reuse - timeline or vocals`,
        detail: "Copy a synchronized event, vocal layer, or timeline segment and cite the target phase where it plays. Reused words still need exact <d>[Language] ...</d> content.",
        definition: `${ref.token} is the reference audio whose selected synchronized event, vocal layer, or timeline segment is reused in the target video.`,
        task: "audio reuse",
        summary: `The target video's synchronized audio partially reuses ${ref.token} while the video depicts {overall action / premise}.`,
        retention: `${ref.token}: partially_copy - reuse {copied segment / layers}; then {what is added / removed / replaced}.`,
        detailed: `[Shot 1] When {event within the current shot}, the target directly reuses {copied segment / layers} from ${ref.token}; {what is added / removed / replaced}.`,
        example: `${ref.token} is reused from 0:00-0:04, after which newly generated ambience is introduced.`,
        select: "{copied segment / layers}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / partial reuse - ambience or SFX`,
        detail: "Copy only ambience or physical-sound layers and state that relationship in overall_soundscape.",
        definition: `${ref.token} is the reference audio whose {copied segment / layers} are ambience or physical-sound layers partially reused in the target video.`,
        task: "audio reuse",
        summary: `The target video's ambience and physical sounds partially reuse ${ref.token} while the video depicts {overall action / premise}.`,
        retention: `${ref.token}: partially_copy - reuse {copied segment / layers}; then {what is added / removed / replaced}.`,
        soundscape: `The {copied segment / layers} from ${ref.token} remain active in the target soundscape; {what is added / removed / replaced}.`,
        example: `${ref.token}'s steady room tone is copied throughout, while new footsteps are added for the target action.`,
        select: "{copied segment / layers}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / partial reuse - audience score`,
        detail: "Copy only an audience-only score segment or layer and state that relationship in non_diegetic_music.",
        definition: `${ref.token} is the reference audio whose {copied segment / layers} are an audience-only score segment or layer partially reused in the target video.`,
        task: "audio reuse",
        summary: `The target video's audience-only score partially reuses ${ref.token} while the video depicts {overall action / premise}.`,
        retention: `${ref.token}: partially_copy - reuse {copied segment / layers}; then {what is added / removed / replaced}.`,
        music: `The audience-only score copies ${ref.token}'s {copied segment / layers}; {what is added / removed / replaced}.`,
        example: `${ref.token}'s opening piano phrase is copied for the first four seconds, then new low strings enter.`,
        select: "{copied segment / layers}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / reference - voice or timeline`,
        detail: "Reference timbre, delivery, rhythm, dialogue content, or synchronized sound texture without copying the signal, then cite the target phase where it applies.",
        definition: `${ref.token} is referenced for {timbre / rhythm / music style / dialogue content / sound texture} without copying its signal.`,
        task: "audio reference",
        summary: `The target video's audio follows the defined properties of ${ref.token} without copying its signal while the video depicts {overall action / premise}.`,
        retention: `${ref.token}: reference - match {timbre / rhythm / music style / dialogue content / sound texture} without copying the source signal.`,
        detailed: `[Shot 1] When {event within the current shot}, the target audio follows ${ref.token}'s {timbre / rhythm / music style / dialogue content / sound texture} without copying its signal.`,
        example: `${ref.token} is referenced for the narrator's dry vocal timbre and measured delivery without copying the signal.`,
        select: "{timbre / rhythm / music style / dialogue content / sound texture}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / reference - ambience or SFX`,
        detail: "Reference ambience or physical-sound properties without copying the signal and place the relationship in overall_soundscape.",
        definition: `${ref.token} is referenced for {timbre / rhythm / music style / dialogue content / sound texture} as ambience or physical-sound guidance without copying its signal.`,
        task: "audio reference",
        summary: `The target video's ambience and physical sounds follow the defined properties of ${ref.token} without copying its signal while the video depicts {overall action / premise}.`,
        retention: `${ref.token}: reference - match {timbre / rhythm / music style / dialogue content / sound texture} without copying the source signal.`,
        soundscape: `The target ambience and physical sounds follow ${ref.token}'s {timbre / rhythm / music style / dialogue content / sound texture} without copying the source signal.`,
        example: `${ref.token} guides the close, dry room tone and sparse metallic impacts without copying the original signal.`,
        select: "{timbre / rhythm / music style / dialogue content / sound texture}",
      }));
      options.push(relationshipBundleOption(ref, prompt, placeholder, {
        label: `${ref.token} / reference - audience score`,
        detail: "Reference audience-only music properties without copying the signal and place the relationship in non_diegetic_music.",
        definition: `${ref.token} is referenced for audience-only score properties: {instruments / sound sources}, {tempo / rhythm}, and {dynamic change}, without copying its signal.`,
        task: "audio reference",
        summary: `The target video's audience-only score follows the defined properties of ${ref.token} without copying its signal while the video depicts {overall action / premise}.`,
        retention: `${ref.token}: reference - match {instruments / sound sources}, {tempo / rhythm}, and {dynamic change} without copying the source signal.`,
        music: `The audience-only score follows ${ref.token}'s {instruments / sound sources}, {tempo / rhythm}, and {dynamic change} without copying the source signal.`,
        example: `${ref.token} guides sparse piano, slow tempo, and a gradual low-string swell without copying the original signal.`,
        select: "{instruments / sound sources}",
      }));
    }
  }
  return options;
}

function referenceRoleVariants(ref, prompt) {
  const group = `Define ${ref.token}`;
  if (ref.kind === "image") {
    const subject = `@Subject${nextSubjectOrdinal(prompt)}`;
    return [
      roleOption(ref, `${ref.token} · define ${subject}`, "Use this Picture as provenance for reusable visible content; track the content as a Subject rather than treating the source as a frame.", `${subject} is {tracked subject} shown in ${ref.token}; ${ref.token} provides {source contribution}.`, group, `${subject} is the woman shown in ${ref.token}; ${ref.token} provides her face, hair, clothing, and proportions.`, "{tracked subject}"),
      roleOption(ref, `${ref.token} · first frame`, "Concrete opening frame; not mere Subject provenance.", `${ref.token} is the first frame of [Shot 1], showing {subject / scene / composition}.`, group, `${ref.token} is the first frame of [Shot 1], showing @Subject1 seated beside a rain-covered window.`, "{subject / scene / composition}"),
      roleOption(ref, `${ref.token} · keyframe`, "Concrete intermediate frame anchor.", `${ref.token} is a keyframe of [Shot 1], showing {pose / composition / state}.`, group, `${ref.token} is a keyframe of [Shot 1], establishing @Subject1 mid-turn with the doorway centered behind her.`, "{pose / composition / state}"),
      roleOption(ref, `${ref.token} · last frame`, "Concrete ending frame; motion lands on it.", `${ref.token} is the last frame of [Shot 1], showing {final pose / state / composition}.`, group, `${ref.token} is the last frame of [Shot 1], showing the umbrella fully open above @Subject1.`, "{final pose / state / composition}"),
      roleOption(ref, `${ref.token} · edited keyframe`, "Concrete frame anchor with intentional changes.", `${ref.token} is an edited keyframe for [Shot 1], defining {what the picture anchors}; the target may change {what may change}.`, group, `${ref.token} is an edited keyframe for [Shot 1], defining the composition and pose while the target changes the outfit color.`, "{what the picture anchors}"),
      roleOption(ref, `${ref.token} · composition anchor`, "Preserve viewpoint/placement/layout, not the whole image 1:1.", `${ref.token} is a composition anchor for [Shot 1], defining {viewpoint / placement / spatial relationships}.`, group, `${ref.token} is a composition anchor for [Shot 1], defining the low viewpoint, centered doorway, and left-right subject spacing.`, "{viewpoint / placement / spatial relationships}"),
      roleOption(ref, `${ref.token} · storyboard`, "Shot-planning reference: viewpoint, placement or shot order.", `${ref.token} is a storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.`, group, `${ref.token} is a storyboard reference for [Shot 1] and [Shot 2], defining viewpoint, subject placement, and shot order.`),
    ];
  }
  if (ref.kind === "video") {
    const subject = `@Subject${nextSubjectOrdinal(prompt)}`;
    return [
      roleOption(ref, `${ref.token} · define ${subject}`, "Use visible content from this Video as provenance for a reusable Subject; use the Video itself only for edit, continuation, camera, cut, rhythm, or temporal roles.", `${subject} is {tracked subject} shown in ${ref.token}; ${ref.token} provides {source contribution}.`, group, `${subject} is the performer shown in ${ref.token}; ${ref.token} provides appearance, clothing, and movement details.`, "{tracked subject}"),
      roleOption(ref, `${ref.token} · direct edit`, "Source video itself is modified.", `${ref.token} is the source video for the target video edit.`, group, `${ref.token} is the source video for the target edit; preserve its timing while replacing the background.`),
      roleOption(ref, `${ref.token} · continuation`, "Target continues from the source ending state.", `${ref.token} is the source video whose ending state is continued by the target video.`, group, `${ref.token} ends with @Subject1 facing the doorway; the target continues from that exact state.`),
      roleOption(ref, `${ref.token} · camera movement`, "Use source camera motion as guidance.", `${ref.token} is referenced for its camera movement, which guides the target video's camera behavior.`, group, `${ref.token} is referenced for its slow arc followed by a short push-in; the target uses that camera pattern with new content.`),
      roleOption(ref, `${ref.token} · cuts / rhythm / temporal structure`, "Use source cuts, pacing or temporal structure as guidance.", `${ref.token} is referenced for its cuts, rhythm, pacing, and temporal structure, which guide the target video.`, group, `${ref.token} is referenced for a three-shot slow-fast-slow pacing structure without copying its footage.`),
    ];
  }
  if (isAudioReferenceKind(ref.kind)) {
    const speakerIds = [...knownSpeakerIds(prompt)].sort((a, b) => a - b);
    const subjectBindings = knownSubjectSpeakerBindings(prompt);
    const options = [
      roleOption(ref, `${ref.token} · signal reuse`, "Copy the source signal; retention says full vs partial.", `${ref.token} is the reference audio whose signal is reused in the target video.`, group, `${ref.token} is reused from 0:00-0:04, after which the target introduces newly generated ambience.`),
      roleOption(ref, `${ref.token} · BGM style`, "Reference music style/instrumentation; do not copy the signal.", `${ref.token} is referenced for its background-music style and instrumentation.`, group, `${ref.token} is referenced for sparse piano, low strings, slow tempo, and gradual volume growth.`),
      roleOption(ref, `${ref.token} · dialogue / lyric content`, "Reuse/reperform the words; not the source signal.", `${ref.token} is referenced for its dialogue or lyric content.`, group, `${ref.token} supplies dialogue or lyric content; the actual target vocal source keeps its timeline-assigned (Sx) ID.`),
      roleOption(ref, `${ref.token} · sound-effect texture`, "Reference ambience/SFX character.", `${ref.token} is referenced for its sound-effect and ambience texture.`, group, `${ref.token} is referenced for its dense rain texture and distant metallic station ambience.`),
      roleOption(ref, `${ref.token} · beat / rhythm / continuity`, "Reference beat, rhythm or audible continuity.", `${ref.token} is referenced for its beat, rhythm, and audio continuity.`, group, `${ref.token} is referenced for its steady 4/4 pulse and continuous low-frequency rhythm.`),
    ];

    // Prefer mappings that are already established by real target-timeline vocal
    // events. This scales to any number of Subjects/S-speakers and avoids the old
    // "first Subject" assumption.
    const boundSpeakerIds = new Set();
    for (const binding of subjectBindings) {
      boundSpeakerIds.add(binding.speakerId);
      options.splice(2, 0, roleOption(
        ref,
        `${ref.token} · voice for ${binding.subjectToken} (S${binding.speakerId})`,
        `Bind this audio reference to the already-established ${binding.subjectToken} / S${binding.speakerId} target vocal source.`,
        `${ref.token} is the voice-timbre and delivery reference for ${binding.subjectToken} (S${binding.speakerId}).`,
        group,
        `${ref.token} is the voice-timbre and delivery reference for ${binding.subjectToken} (S${binding.speakerId}); match the defined voice qualities without copying the original signal.`,
      ));
    }

    // An S-ID can be established without a tracked Subject (narrator, off-screen
    // speaker, generated character, etc.). Keep the identity editable rather than
    // assigning that ID to whichever Subject happened to be defined first.
    for (const id of speakerIds.filter((value) => !boundSpeakerIds.has(value))) {
      options.splice(2, 0, roleOption(
        ref,
        `${ref.token} · voice for S${id}`,
        `Reuse established S${id}; choose the corresponding target speaker identity.`,
        `${ref.token} is the voice-timbre and delivery reference for {target speaker description} (S${id}).`,
        group,
        `${ref.token} is the voice-timbre and delivery reference for the off-screen narrator (S${id}); match the defined voice qualities without copying the original signal.`,
        "{target speaker description}",
      ));
    }

    if (!speakerIds.length) {
      options.splice(2, 0, roleOption(
        ref,
        `${ref.token} · voice reference`,
        "Choose the target speaker and bind the S-number after its actual first vocal event establishes speaker order.",
        `${ref.token} is the voice-timbre and delivery reference for {target speaker description} (S{speaker number from timeline}).`,
        group,
        `${ref.token} is the voice-timbre and delivery reference for the calm narrator (S1); S1 must also be the first actual vocal source in detailed_description.`,
        "{target speaker description}",
      ));
    }
    return options;
  }
  return [];
}

function subjectReferenceRoleVariants(ref, state) {
  const visuals = state.refs.filter((item) => item.kind === "image" || item.kind === "video");
  const images = visuals.filter((item) => item.kind === "image");
  const videos = visuals.filter((item) => item.kind === "video");
  const options = [
    roleOption(ref, `${ref.token} · define visible subject`, "Define the reusable visible content represented by this Subject.", `${ref.token} is {tracked subject}, characterized by {overall appearance details}.`, `Define ${ref.token}`, `${ref.token} is the woman with short black hair, a blue jacket, and a silver necklace.`, "{tracked subject}"),
  ];
  if (visuals.length) {
    options.unshift(roleOption(ref, `${ref.token} · from ${visuals[0].token}`, "Define a reusable Subject from a connected visual source.", `${ref.token} is {tracked subject} shown in ${visuals[0].token}; ${visuals[0].token} provides {source contribution}.`, `Define ${ref.token}`, `${ref.token} is the woman shown in ${visuals[0].token}; ${visuals[0].token} provides her frontal appearance, clothing, and facial details.`, "{tracked subject}"));
  }
  if (visuals.length > 1) {
    options.push(roleOption(ref, `${ref.token} · combine visual sources`, "One Subject can combine multiple sources when each contribution is stated.", `${ref.token} is {tracked subject} shown in ${joinTokens(visuals.map((item) => item.token))}; state what each source contributes: {source contribution}.`, `Define ${ref.token}`, `${ref.token} is the same woman shown across ${joinTokens(visuals.map((item) => item.token))}; the first source provides overall appearance while the second provides close-up detail.`, "{tracked subject}"));
  }
  if (images.length) {
    options.push(roleOption(ref, `${ref.token} · visual style`, "Track a reusable visual style from an image source.", `${ref.token} is the visual style shown in ${images[0].token}, characterized by {lighting / color / material traits}.`, `Define ${ref.token}`, `${ref.token} is the visual style shown in ${images[0].token}, characterized by soft directional lighting, realistic materials, and neutral color grading.`, "{lighting / color / material traits}"));
  }
  if (videos.length) {
    options.push(roleOption(ref, `${ref.token} · motion / performance`, "Track reusable action or motion from a video source.", `${ref.token} is the {action / motion pattern} shown in ${videos[0].token}, including {pose sequence / timing / body mechanics}.`, `Define ${ref.token}`, `${ref.token} is the walking performance shown in ${videos[0].token}, including its pose sequence, timing, stride mechanics, and arm swing.`, "{action / motion pattern}"));
  }
  return options;
}

function timelineReferenceFollowupOptions(ref, state, prompt) {
  if (ref.kind === "subject") {
    return [roleOption(ref, `${ref.token} · action`, "Continue with a target-timeline action sentence.", `The target action for ${ref.token} follows {action / motion performance}.`, `Use ${ref.token}`, `The target action for ${ref.token} follows a controlled turn toward the doorway.`, "{action / motion performance}")];
  }
  if (ref.kind === "image") {
    const anchors = pictureAnchorOptions(state, prompt).filter((option) => String(option.insertText || "").includes(ref.token));
    return anchors.length ? anchors : [roleOption(ref, `${ref.token} · frame anchor`, "Describe what this picture anchors in the current shot.", `The shot uses ${ref.token} as a concrete frame anchor, preserving {subject / scene / composition}.`, `Use ${ref.token}`, `The shot uses ${ref.token} as a concrete frame anchor, preserving the subject pose and framing.`, "{subject / scene / composition}")];
  }
  if (ref.kind === "video") {
    return [
      roleOption(ref, `${ref.token} · camera / temporal guidance`, "Use the video for camera, cuts, rhythm, or temporal structure.", `The target follows the camera movement and temporal structure referenced from ${ref.token}; {action / motion performance} guides the target action.`, `Use ${ref.token}`, `The target follows the slow arc and cut rhythm referenced from ${ref.token}; a controlled crossing of the room guides the target action.`, "{action / motion performance}"),
      roleOption(ref, `${ref.token} · continuation state`, "Continue naturally from the reference video's ending state.", `The target continues from ${ref.token}'s ending state; {action / motion performance} guides the new target motion.`, `Use ${ref.token}`, `The target continues from ${ref.token}'s ending state; a controlled door-opening performance guides the new target motion.`, "{action / motion performance}"),
    ];
  }
  if (isAudioReferenceKind(ref.kind)) {
    const options = [
      roleOption(ref, `${ref.token} · reference properties here`, "Reference timbre, rhythm, music style, dialogue content, or sound texture without direct signal copy.", `${ref.token} is referenced here for {timbre / rhythm / music style / dialogue content / sound texture}.`, `Use ${ref.token}`, `${ref.token} is referenced here for the narrator's dry vocal timbre and measured delivery.`, "{timbre / rhythm / music style / dialogue content / sound texture}"),
      roleOption(ref, `${ref.token} · copied signal audible here`, "State that copied source audio is active in this part of the target timeline.", `The copied signal from ${ref.token} is audible during this part of the shot.`, `Use ${ref.token}`, `The copied signal from ${ref.token} remains audible while the camera crosses the room.`),
    ];
    for (const binding of knownSubjectSpeakerBindings(prompt)) {
      options.unshift(roleOption(ref, `${ref.token} · voice for ${binding.subjectToken} (S${binding.speakerId})`, "Use the referenced voice timbre/delivery for an already-established target speaker.", `${binding.subjectToken} (S${binding.speakerId}) speaks with the timbre and delivery referenced from ${ref.token}: <d>[{dialogue language}] {spoken words}</d>`, `Use ${ref.token}`, `${binding.subjectToken} (S${binding.speakerId}) speaks with the calm measured timbre referenced from ${ref.token}: <d>[English] Hello.</d>`, "{dialogue language}"));
    }
    return options;
  }
  return [];
}

function endpointImageFollowupOptions(ref, state) {
  if (ref.kind !== "image") return [];
  const aliases = keyframeAliases(state);
  if (state.conditioningProfile === PROFILE.I2VA || ref.token === aliases.opening && state.conditioningProfile === PROFILE.FL2VA) {
    return [roleOption(ref, `${ref.token} · opening-frame continuation`, "Continue from the connected opening frame without redefining it as a Reference asset.", `The shot begins from ${ref.token}; {action / motion performance} guides the subject's subsequent movement.`, `Use ${ref.token}`, `The shot begins from ${ref.token}; a controlled turn toward the doorway guides the subject's subsequent movement.`, "{action / motion performance}")];
  }
  if (state.conditioningProfile === PROFILE.L2VA || ref.token === aliases.ending && state.conditioningProfile === PROFILE.FL2VA) {
    return [roleOption(ref, `${ref.token} · final-frame convergence`, "Describe motion that lands on the connected final frame.", `The motion progresses toward ${ref.token} as the final frame, with {motion toward the final frame}.`, `Use ${ref.token}`, `The motion progresses toward ${ref.token} as the final frame, with the subject lowering into the supplied final pose.`, "{motion toward the final frame}")];
  }
  return [roleOption(ref, `${ref.token} · keyframe anchor`, "Use the connected first/last frame as a concrete frame anchor.", `The shot uses ${ref.token} as a concrete frame anchor, preserving {subject / scene / composition}.`, `Use ${ref.token}`, `The shot uses ${ref.token} as a concrete frame anchor, preserving the supplied pose and framing.`, "{subject / scene / composition}")];
}

function referencePromptDefinitionOptions(ref, state, prompt, insertedRange) {
  const source = String(prompt || "");
  const start = Math.max(0, Math.min(Number(insertedRange?.start) || 0, source.length));
  const end = Math.max(start, Math.min(Number(insertedRange?.end) || start, source.length));
  const draft = `${source.slice(0, start)}${source.slice(end)}`.trim();
  const templateState = starterTemplateState(state, PROFILE.REF2VA, state.audioMode, 0, KEYFRAME_FIRST, state.audioStarterTask);
  const initial = templateForState(templateState, draft);
  const template = draft ? wrappedStarterTemplate(initial, PROFILE.REF2VA, state.audioMode, draft, "detailed") : initial;
  const roles = ref.kind === "subject" ? subjectReferenceRoleVariants(ref, state) : referenceRoleVariants(ref, source);
  return roles.map((role) => {
    const definition = `${role.insertText}\n{define tracked reference content}`;
    return {
      ...role,
      label: `Start Reference prompt · ${role.label}`,
      detail: `${role.detail} ${draft ? "The surrounding draft becomes the first target-timeline shot." : "A complete editable Reference structure is created."}`,
      replacePrompt: replaceTemplateSectionBody(template, "subject_definitions", "summary", definition),
      selectText: role.selectText || firstEditorPlaceholder(role.insertText) || firstEditorPlaceholder(definition),
    };
  });
}

function referenceFollowupOptions(ref, state, prompt, section, insertedRange = null) {
  const keep = insertOption(`Keep ${ref.token} only`, "Leave only the reference label and continue typing manually.", ref.token, "Reference label");
  if (!section) {
    if (state.conditioningProfile === PROFILE.REF2VA) {
      return [
        infoOption("Define this reference in a complete prompt", "Choose a role below. Easy creates the six Reference sections, puts the definition in subject_definitions:, and keeps any surrounding draft in the target timeline.", "Reference placement"),
        ...referencePromptDefinitionOptions(ref, state, prompt, insertedRange),
        keep,
      ];
    }
    const detail = state.editorProfile === PROFILE.REF2VA
      ? "Reference definitions belong inside subject_definitions:. Start or wrap with a Reference template before defining this label."
      : "Base grammar has no definition preamble. Start or wrap with a Base template, then use this label inside integrated_multimodal_description:.";
    return [infoOption("Choose where the reference belongs", detail, "Reference placement"), keep];
  }
  if (state.editorProfile === PROFILE.REF2VA && section === "subject_definitions") {
    const roles = (ref.kind === "subject" ? subjectReferenceRoleVariants(ref, state) : referenceRoleVariants(ref, prompt)).map((option) => ({
      ...option,
      insertText: `${option.insertText}\n{define tracked reference content}`,
    }));
    return [...roles, keep];
  }
  if (state.conditioningProfile !== PROFILE.REF2VA) {
    const endpoint = endpointImageFollowupOptions(ref, state);
    return endpoint.length ? [...endpoint, keep] : [keep];
  }
  if (section === "retention_analysis") {
    const field = isAudioReferenceKind(ref.kind) ? "{audio retention}" : "{visual retention}";
    return [roleOption(ref, `${ref.token} · retention row`, "Continue directly into this reference's retention relationship.", `${ref.token}: ${field}`, `Use ${ref.token}`, isAudioReferenceKind(ref.kind) ? `${ref.token}: reference - match the defined timbre without copying the signal.` : `${ref.token}: fully_preserved - preserve the defined identity and appearance.`, field), keep];
  }
  if (section === "overall_soundscape" || section === "non_diegetic_music") {
    const audioOptions = isAudioReferenceKind(ref.kind) ? audioLayerReferenceOptions(state, prompt, section).filter((option) => String(option.insertText || "").includes(ref.token)) : [];
    return audioOptions.length ? [...audioOptions, keep] : [keep];
  }
  if (section === timelineSection(state)) {
    const timeline = timelineReferenceFollowupOptions(ref, state, prompt);
    return timeline.length ? [...timeline, keep] : [keep];
  }
  const example = referenceContextExample(ref, section);
  return example ? [roleOption(ref, `${ref.token} · section template`, "Continue with a section-appropriate reference sentence.", example, `Use ${ref.token}`, example), keep] : [keep];
}

function referenceOptions(state, prompt, query = "", section = null) {
  // Once the caret is outside subject_definitions, REF labels are no longer
  // "whatever is physically connected". They are the standalone semantic
  // items established in subject_definitions. This prevents provenance-only
  // pictures/videos from being suggested later as if they were tracked labels.
  if (state.editorProfile === PROFILE.REF2VA && section && section !== "subject_definitions") {
    let definitions = standaloneDefinitions(prompt);
    if (["overall_soundscape", "non_diegetic_music"].includes(section)) definitions = definitions.filter((definition) => isAudioReferenceKind(definition.kind));
    return definitions.map((definition) => {
      const physical = physicalReferenceDescriptor(state, definition);
      const ref = {
        token: definition.token,
        kind: definition.kind,
        ordinal: definition.ordinal,
        inputName: physical?.inputName || null,
        detail: definition.kind === "subject" ? "Standalone semantic subject defined in subject_definitions:." : "Standalone tracked reference defined in subject_definitions:.",
      };
      return {
        ...insertOption(referenceSocketLabel(ref), referenceContextDetail(ref, section), ref.token, "Defined references", null, referenceContextExample(ref, section)),
        previewType: referencePreviewType(ref),
        inputName: ref.inputName,
        ordinal: ref.ordinal,
        referenceRef: ref,
      };
    });
  }

  const options = availableReferenceDescriptors(state).map((ref) => ({
    ...insertOption(referenceSocketLabel(ref), referenceContextDetail(ref, section), ref.token, "Connected references", null, referenceContextExample(ref, section)),
    previewType: referencePreviewType(ref),
    inputName: ref.inputName || null,
    ordinal: ref.ordinal,
    referenceRef: ref,
  }));
  if (state.editorProfile === PROFILE.REF2VA && (!section || section === "subject_definitions")) {
    const next = nextSubjectOrdinal(prompt);
    const ordinals = new Set();
    for (let i = next; i < next + 5; i += 1) ordinals.add(i);
    const explicit = String(query || "").match(/^subject(\d+)$/i);
    if (explicit) ordinals.add(Number(explicit[1]));
    for (const i of [...ordinals].filter((value) => value > 0).sort((a, b) => a - b)) {
      const subjectRef = { token: `@Subject${i}`, kind: "subject", ordinal: i, inputName: null, detail: "Reusable semantic Subject." };
      options.push({
        ...insertOption(subjectRef.token, "Reusable visible content, not the source file itself.", subjectRef.token, "Subjects", null, `${subjectRef.token} is the woman shown in @Image1, with short dark hair, a blue jacket, and a silver necklace.`),
        previewType: "subject",
        ordinal: i,
        referenceRef: subjectRef,
      });
    }

    // Keep bare-@ discovery compact. Once the user has named one concrete
    // physical reference (for example @Image1), expand that exact entry into
    // the documented role-specific definition scaffolds instead of flooding a
    // 9-image prompt with dozens of role rows at once.
    const normalizedQuery = String(query || "").trim().replace(/^@/, "").toLowerCase();
    const exactRef = state.refs.find((ref) => ref.token.slice(1).toLowerCase() === normalizedQuery);
    if (exactRef) options.push(...referenceRoleVariants(exactRef, prompt));
  }
  return options;
}

function subjectHelpers(state, prompt) {
  if (state.editorProfile !== PROFILE.REF2VA) return [];
  const imageRefs = state.refs.filter((ref) => ref.kind === "image");
  const videoRefs = state.refs.filter((ref) => ref.kind === "video");
  const visualRefs = [...imageRefs, ...videoRefs];
  const images = imageRefs.map((ref) => ref.token);
  const visuals = visualRefs.map((ref) => ref.token);
  const subject = `@Subject${nextSubjectOrdinal(prompt)}`;
  const result = [];
  if (visuals.length) {
    result.push(insertOption(
      "subject",
      "Subject = reusable visible content from one or more references.",
      `${subject} is {tracked subject} shown in ${visuals[0]}; ${visuals[0]} provides {source contribution}.`,
      "Subject definitions",
      "{tracked subject}",
      `${subject} is the woman shown in ${visuals[0]}, with short black hair, a blue jacket, and a silver necklace.`,
    ));
    if (imageRefs.length) {
      result.push(insertOption(
        "style-subject",
        `Reusable visual style from a Picture; keep the Picture as source provenance.`,
        `${subject} is the visual style shown in ${imageRefs[0].token}, characterized by {lighting / color / material traits}.`,
        "Subject definitions",
        "{lighting / color / material traits}",
        `${subject} is the visual style shown in ${imageRefs[0].token}, characterized by clean studio lighting, realistic skin texture, neutral color grading, and crisp photographic detail.`,
      ));
    }
    result.push(insertOption(
      "subject-multi",
      `One Subject from multiple sources; state each source contribution.`,
      `${subject} is {tracked subject} shown in ${joinTokens(visuals)}; state what each source contributes: {source contribution}.`,
      "Subject definitions",
      "{tracked subject}",
      `${subject} is the same character shown across ${joinTokens(visuals)}; state what each source contributes, for example frontal appearance, side profile, or walking motion.`,
    ));
  }
  if (imageRefs.length && videoRefs.length) {
    result.push(insertOption(
      "subject-appearance+motion",
      `One Subject: appearance from Picture, motion from Video.`,
      `${subject} is the target character whose appearance and identity come from ${imageRefs[0].token}, while {action / motion performance} comes from ${videoRefs[0].token}; follow the video's {pose sequence / timing / body mechanics} without inheriting the source performer's appearance.`,
      "Subject definitions",
      "{action / motion performance}",
      `${subject} takes face, clothing, and proportions from ${imageRefs[0].token}; the standing backflip comes from ${videoRefs[0].token}, including its crouch, takeoff, tuck timing, rotation, opening, and landing mechanics, without copying the source performer's identity.`,
    ));
    result.push(insertOption(
      "separate-action-subject",
      `Track motion as its own Subject when it should transfer independently.`,
      `${subject} is the {action / motion pattern} shown in ${videoRefs[0].token}, characterized by {pose sequence / timing / body mechanics}.`,
      "Subject definitions",
      "{action / motion pattern}",
      `${subject} is the standing-backflip action shown in ${videoRefs[0].token}, characterized by a deep crouch, vertical takeoff, compact tuck, backward rotation, controlled opening, and two-foot landing.`,
    ));
  }
  if (images.length >= 3) {
    result.push(insertOption(
      "subject-front-side-back",
      `One Subject from front/side/back pictures.`,
      `${subject} is the same character shown in ${images[0]}, ${images[1]}, and ${images[2]}; ${images[0]} provides the frontal view, ${images[1]} the side view, and ${images[2]} the back view.`,
      "Subject definitions",
      null,
      `${subject} is the same character shown in ${images[0]}, ${images[1]}, and ${images[2]}; ${images[0]} provides the frontal view, ${images[1]} the side view, and ${images[2]} the back view.`,
    ));
  }
  if (images.length >= 2) {
    result.push(insertOption(
      "subject-overall+detail",
      `Same Subject: one source for overall appearance, another for close-up detail.`,
      `${subject} is the same character shown in ${images[0]} and ${images[1]}; ${images[0]} provides {overall appearance details}, while ${images[1]} provides {close-up detail}.`,
      "Subject definitions",
      "{overall appearance details}",
      `${subject} is the same woman shown in ${images[0]} and ${images[1]}; ${images[0]} provides her overall frontal appearance, white top, and green skirt, while ${images[1]} provides the nail shape, length, color, and design details.`,
    ));
    result.push(infoOption(
      "detail-reference vs attribute-transfer",
      `Same person/detail → one Subject. Different source trait applied to target → separate Subject + attribute_transfer.`,
      "Subject definitions",
      `@Subject1 is the woman shown in ${images[0]}. @Subject2 is the nail design shown in ${images[1]}. Then retention can say @Subject2: attribute_transfer - transfer its nail shape, color, and pattern to @Subject1's fingernails.`,
    ));
  }
  return result;
}

function cameraSentenceOption(label, sentence, detail) {
  const noModifierTypes = new Set(["Static Shot", "Shake Slightly", "Shake Strongly", "POV"]);
  if (noModifierTypes.has(label)) return insertOption(label, detail, sentence, "Camera motion");
  const stem = String(sentence).replace(/\.\s*$/, "");
  const insert = `${stem}{camera amplitude if needed}{camera speed if needed}.`;
  return insertOption(label, detail, insert, "Camera motion", "{camera amplitude if needed}");
}

function cameraOptions() {
  return [
    insertOption("No camera instruction", "Remove this optional slot.", "", "Camera"),
    ...CAMERA.map(([label, sentence, detail]) => cameraSentenceOption(label, sentence, detail)),
  ];
}

function cameraAmplitudeOptions() {
  return [
    insertOption("Omit", "Default amplitude; no modifier.", "", "Amplitude"),
    insertOption("Small", "Small compositional range.", " with small amplitude", "Amplitude"),
    insertOption("Large", "Large compositional range.", " with large amplitude", "Amplitude"),
  ];
}

function cameraSpeedOptions() {
  return [
    insertOption("Omit", "Default speed; no modifier.", "", "Speed"),
    insertOption("Slow", "Slow camera movement.", " at slow speed", "Speed"),
    insertOption("Fast", "Fast camera movement.", " at fast speed", "Speed"),
  ];
}

function cutTransitionOptions() {
  // Ordinary cut wording is copied from MiniMax's base prompt guide. Explicit
  // transition effects are offered only as deliberate alternatives.
  return [
    insertOption("Camera cuts", "Use for an ordinary hard cut into a new shot. Do not use for camera motion inside one continuous shot.", "the camera cuts to", "Ordinary shot changes"),
    insertOption("Shot cuts", "Use for an ordinary hard cut into a new shot. Do not use for reframing inside the current shot.", "the shot cuts to", "Ordinary shot changes"),
    insertOption("Shot transitions", "Use for a neutral new-shot change when no visible transition effect needs to be specified.", "the shot transitions to", "Ordinary shot changes"),
    insertOption("Shot changes", "Use for a neutral new-shot change when the exact edit wording is unimportant.", "the shot changes to", "Ordinary shot changes"),
    insertOption("Shot switches", "Use for a direct switch into a new shot, without implying a dissolve, fade, or wipe.", "the shot switches to", "Ordinary shot changes"),
    insertOption("Cross-dissolve", "Use only when the two shots should visibly overlap and blend during the transition.", "the shot cross-dissolves to", "Visible transition effects"),
    insertOption("Fade", "Use only when the image should visibly fade out, fade in, or pass through a blank field.", "the shot fades to", "Visible transition effects"),
    insertOption("Wipe", "Use only when a moving boundary should visibly replace one shot with the next.", "a wipe reveals", "Visible transition effects"),
  ];
}

function timingOptions(state, prompt) {
  const shot = nextShot(prompt, state);
  return [
    insertOption(shot.text.trim(), shot.detail, shot.text, "Shot marker", shot.selectText),
    insertOption("At 0.00 seconds,", "Within-shot timing; does not create a cut.", "At 0.00 seconds, {event within the current shot}.", "Within-shot timing", "0.00"),
    ...cutTransitionOptions().map((option) => ({
      ...option,
      insertText: `${option.insertText} {new shot content / viewpoint}.`,
      select: "{new shot content / viewpoint}",
    })),
  ];
}

function dialogueLine(id, voiceover = false, establish = false) {
  const speaker = establish ? `{speaker identity} with {voice traits} (S${id})` : `(S${id})`;
  if (voiceover) return `${speaker} says in an off-screen voiceover: <d>[{dialogue language}] {spoken words}</d> while the corresponding on-screen character's lips remain closed.`;
  return `${speaker} says, <d>[{dialogue language}] {spoken words}</d>`;
}

function singingLine(id, establish = false) {
  const singer = establish ? `{speaker identity} with {voice traits} (S${id})` : `(S${id})`;
  return `${singer} sings, <d>[{dialogue language}] {spoken words}</d>`;
}

function dialogueOptions(state, prompt) {
  const known = [...knownSpeakerIds(prompt)].sort((a, b) => a - b);
  const next = nextSpeakerOrdinal(prompt);
  const options = [];
  for (const id of known) {
    options.push(insertOption(`dialogue · S${id}`, "Reuse this speaker ID.", dialogueLine(id), "Existing speakers", "{dialogue language}"));
    options.push(insertOption(`singing · S${id}`, "Reuse this speaker ID for sung lyrics.", singingLine(id), "Existing speakers", "{dialogue language}"));
    options.push(insertOption(`voiceover · S${id}`, "Off-screen voice; visible counterpart keeps lips closed.", dialogueLine(id, true), "Existing speakers", "{dialogue language}"));
  }
  options.push(insertOption(`dialogue · new S${next}`, "Create the next speaker ID and establish who/what it is.", dialogueLine(next, false, true), "New speaker", "{speaker identity}"));
  options.push(insertOption(`singing · new S${next}`, "Create the next singer ID and establish identity/voice before the lyrics.", singingLine(next, true), "New speaker", "{speaker identity}"));
  options.push(insertOption(`voiceover · new S${next}`, "Create the next off-screen speaker ID and establish its identity/voice.", dialogueLine(next, true, true), "New speaker", "{speaker identity}"));
  options.push(
    insertOption("<scenetrans> · same line crosses a cut", "Use only when one line of dialogue or lyrics continues through a shot cut. Put <scenetrans> at the connection point in both dialogue fragments and state that the audio continues seamlessly across the cut.", "<scenetrans>", "Dialogue continuity"),
    insertOption("<cutoff> · speech cut off by video end", "Use only when the end of the generated video truncates the spoken or sung line. Do not use it for a normal interruption or an ordinary shot cut.", "<cutoff>", "Dialogue continuity"),
  );
  if (state.editorProfile === PROFILE.REF2VA && (state.audioReferenceCount ?? state.audioCount) > 0) {
    options.push(insertOption("[unclear] · unintelligible referenced words", "Use only for a span in referenced source audio whose words cannot be understood. It is not a substitute for choosing a dialogue language.", "[unclear]", "Reference-audio controls"));
  }
  return options;
}

function audioOptions(state, prompt, section = null) {
  // Audio guidance obeys the current section instead of acting as a global bag of audio
  // snippets. This prevents raw connected @AudioN/@VideoAudioN assets or summary task tags
  // from being inserted where the REF grammar does not permit them.
  if (section === "overall_soundscape" || section === "non_diegetic_music") {
    return contextualOptions(section, state, prompt);
  }
  if (section === timelineSection(state)) {
    const diegetic = descriptionOptions().find((option) => option.label === "Synchronized diegetic sound");
    const trackedAudio = state.editorProfile === PROFILE.REF2VA
      ? trackedReferenceDescriptors(state, prompt, "audio").map((ref) => ({
        ...insertOption(ref.token, "Use the tracked audio label where its defined role is active.", ref.token, "Tracked audio references"),
        previewType: "audio",
        inputName: ref.inputName || null,
      }))
      : [];
    return [...(diegetic ? [diegetic] : []), ...trackedAudio];
  }
  if (section === "subject_definitions" && state.editorProfile === PROFILE.REF2VA) {
    return availableReferenceDescriptors(state)
      .filter((ref) => isAudioReferenceKind(ref.kind))
      .flatMap((ref) => [
        {
          ...insertOption(ref.token, `${ref.detail} Define only if the audio has its own tracked role.`, ref.token, "Connected audio references", null, `${ref.token} is a background-music style reference; its signal is not copied directly.`),
          previewType: "audio",
          inputName: ref.inputName || null,
        },
        ...referenceRoleVariants(ref, prompt),
      ]);
  }
  const options = [
    insertOption("overall_soundscape:", "Whole-video ambience + physical/foley + non-verbal human sound.", "overall_soundscape:\n", "Audio fields", null, "overall_soundscape: Steady rain taps the windows while footsteps and fabric rustle move through the room."),
    insertOption("non_diegetic_music:", "Audience-only score: instrumentation + tempo/rhythm + dynamic change.", "non_diegetic_music:\n", "Audio fields", null, "non_diegetic_music: Sparse piano at a slow tempo, joined by low strings that gradually increase in volume."),
  ];
  if (!section) options.push(insertOption("N/A", "N/A follows the current audio field: silence for soundscape, no score for music.", "N/A", "Audio values", null, "Silent video: overall_soundscape: N/A. No score but normal scene sound: non_diegetic_music: N/A."));
  return options;
}

function retentionOptions() {
  return [
    ...VISUAL_RETENTION.map(([value, detail, example, scaffold]) => insertOption(value, detail, scaffold || `${value} - `, "Visual retention", firstEditorPlaceholder(scaffold), example)),
    ...AUDIO_RETENTION.map(([value, detail, example, scaffold]) => insertOption(value, detail, scaffold || `${value} - `, "Audio retention", firstEditorPlaceholder(scaffold), example)),
  ];
}

function timelineSection(state) {
  return state.editorProfile === PROFILE.REF2VA ? "detailed_description" : "integrated_multimodal_description";
}

function insideDialogue(before) {
  const source = String(before || "").toLowerCase();
  return source.lastIndexOf("<d>") > source.lastIndexOf("</d>");
}

function dialogueLanguageOption(language, bracketed = true, current = false) {
  const stable = STABLE_DIALOGUE_LANGUAGES.includes(language);
  const quick = ["English", "Russian", "Japanese", "Dutch", "French"].includes(language);
  const value = bracketed ? `[${language}]` : language;
  return insertOption(
    value,
    current
      ? `${language} is the current dialogue-language tag. Choose it to keep the value, or choose any other row to replace it.`
      : stable ? "MiniMax lists this among H3's stable dialogue languages." : "Additional dialogue language; H3 support may vary.",
    value,
    current ? "Current language" : (quick ? "Quick language tags" : (stable ? "Other H3 stable languages" : "Additional languages · variable support")),
  );
}

function editableLanguageOption() {
  return {
    ...insertOption(
      "Custom language…",
      "Type any other language tag. The brackets remain in place while the editable field is selected.",
      "[{dialogue language}]",
      "Custom",
      "{dialogue language}",
    ),
    custom: true,
  };
}

function languageOptions(query = "", current = "") {
  const q = String(query || "").trim();
  const currentValue = String(current || "").trim();
  const currentKey = currentValue.toLowerCase();
  const knownCurrent = DIALOGUE_LANGUAGE_OPTIONS.some((language) => language.toLowerCase() === currentKey);
  const languages = DIALOGUE_LANGUAGE_OPTIONS.map((language) => dialogueLanguageOption(language, true, Boolean(currentKey && language.toLowerCase() === currentKey)));
  if (knownCurrent) languages.sort((a, b) => Number(b.group === "Current language") - Number(a.group === "Current language"));
  else if (currentValue) languages.unshift(insertOption(`[${currentValue}]`, "This is the current custom dialogue-language tag. Choose another row to replace it.", `[${currentValue}]`, "Current language"));
  if (!q) return [...languages, editableLanguageOption()];
  const matched = filterOptions(languages, q);
  if (!DIALOGUE_LANGUAGE_OPTIONS.some((language) => language.toLowerCase() === q.toLowerCase())) {
    matched.push(insertOption(`[${q}]`, "Custom language tag; H3 support may vary.", `[${q}]`, "Custom language"));
  }
  return matched;
}

function existingShotOptions(prompt, query = "") {
  const numbers = new Set([...String(prompt || "").matchAll(/^[ \t]*\[Shot\s+(\d+)\]/gim)].map((match) => Number(match[1])));
  if (!numbers.size) numbers.add(1);
  return filterOptions([...numbers].sort((a, b) => a - b).map((number) => insertOption(`[Shot ${number}]`, "Reference an existing target shot; does not create a cut.", `[Shot ${number}]`, "Shot references", null, `@Subject1 (appears in [Shot ${number}]): fully_preserved - preserve identity and outfit.`)), query);
}

function bracketOptions(state, prompt, query, before, section) {
  if (insideDialogue(before) && section === timelineSection(state)) {
    const q = String(query || "").trim();
    const bracketStart = before.lastIndexOf("[");
    const dialogueStart = before.toLowerCase().lastIndexOf("<d>");
    const languagePosition = dialogueStart >= 0 && bracketStart >= dialogueStart && /^\s*$/.test(before.slice(dialogueStart + 3, bracketStart));
    if (languagePosition) {
      if (q.length >= 3 && "unclear".startsWith(q.toLowerCase())) {
        return [
          infoOption("[unclear] is not a language", "Choose the dialogue language here. Put [unclear] only among the spoken words copied from referenced source audio.", "Dialogue language"),
          ...languageOptions(),
        ];
      }
      return languageOptions(q);
    }
    if (state.editorProfile === PROFILE.REF2VA && (state.audioReferenceCount ?? state.audioCount) > 0 && (!q || "unclear".startsWith(q.toLowerCase()))) {
      return [insertOption("[unclear]", "Unintelligible span from referenced source audio.", "[unclear]", "Reference-audio controls")];
    }
    return [infoOption("No language tag here", "The dialogue language belongs immediately after <d>. [unclear] is available later only for unintelligible words copied from referenced source audio.", "Dialogue controls")];
  }
  if (state.editorProfile === PROFILE.REF2VA && section === "summary") {
    const parts = String(query || "").split("+").map((value) => value.trim());
    const active = parts.at(-1) || "";
    const prefix = parts.slice(0, -1).filter(Boolean);
    const used = new Set(prefix.map((value) => value.toLowerCase()));
    const options = TASK_TYPES
      .filter(([value]) => !used.has(value.toLowerCase()))
      .map(([value, detail, example]) => {
        const values = [...prefix, value];
        return insertOption(`[${values.join(" + ")}]`, `${detail} Add with + only if another relationship also applies.`, `[${values.join(" + ")}] `, "Summary task types", null, example);
      });
    return filterOptions(options, active);
  }
  if (section === timelineSection(state)) {
    const shot = nextShot(prompt, state);
    const scaffold = nextShotScaffold(state, prompt);
    const label = /^\[Shot 1\]/i.test(shot.text.trim()) ? "Shot 1 scaffold" : `Shot ${String(shot.text).match(/\[Shot\s+(\d+)\]/i)?.[1] || "next"} scaffold`;
    return filterOptions([insertOption(label, "Insert the next mode-aware shot; later shots select the cut timestamp before any prose field.", scaffold, "Shots", shot.selectText || firstEditorPlaceholder(scaffold))], query);
  }
  if (state.editorProfile === PROFILE.REF2VA && ["subject_definitions", "retention_analysis"].includes(section)) return existingShotOptions(prompt, query);
  return [];
}

function speakerOptions(prompt, query, allowNew = true) {
  const known = [...knownSpeakerIds(prompt)].sort((a, b) => a - b);
  const options = known.map((id) => insertOption(
    `(S${id})`,
    "Reuse this established vocal source ID.",
    `(S${id})`,
    "Speakers",
    null,
    `@Subject1 (S${id}) says, <d>[English] Hello.</d>`,
  ));
  if (allowNew) {
    const next = nextSpeakerOrdinal(prompt);
    options.push(insertOption(
      `(S${next}) · new`,
      "Create the next speaker ID on an actual timeline vocal event.",
      `(S${next})`,
      "New speaker",
    ));
  }
  if (known.length >= 2) {
    options.push(insertOption(
      "group speech…",
      "Choose any subset of established speakers; this is not limited to two characters.",
      `({speaker ID group})`,
      "Group speech",
      "{speaker ID group}",
    ));
  }
  return filterOptions(options, query);
}

function retentionTriggerOptions(line, query) {
  const audioOnly = /(?:@(?:VideoAudio|Audio)\d+\b|<Audio\s+\d+>)/i.test(line) && !/(?:@(Subject|Image|Video)\d+\b|<(?:Subject|Picture|Video)\s+\d+>)/i.test(line);
  const values = audioOnly ? AUDIO_RETENTION : VISUAL_RETENTION;
  const sourceToken = String(line || "").match(/(?:@(?:VideoAudio|Audio)\d+\b|<Audio\s+\d+>)/i)?.[0] || "the source audio";
  return filterOptions(values.map(([value, detail, example, scaffold]) => {
    let insert = scaffold || `${value} - `;
    if (audioOnly && value === "fully_copy") insert = `fully_copy - reuse ${sourceToken} 1:1 as the complete final audio track`;
    return insertOption(value, detail, ` ${insert}`, "Retention", firstEditorPlaceholder(insert), example);
  }), query);
}

function filterOptions(options, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return options;
  return options.filter((option) => `${option.label} ${option.detail || ""} ${option.example || ""} ${option.group || ""}`.toLowerCase().includes(q));
}

function optionChangeRank(option) {
  if (option?.custom) return 0;
  const label = String(option?.label || "").trim().toLowerCase();
  const insert = String(option?.insertText ?? "");
  // After Custom, keep the least-changing/opt-out choices at the top.
  // The remaining contextual options stay in their authored order.
  if (insert === "" || label === "none" || label === "n/a" || label === "done"
      || label.startsWith("no ") || /^keep\s+.+\s+only$/.test(label)) return 1;
  return 2;
}

function leastChangeOptionsFirst(options) {
  return (options || [])
    .map((option, index) => ({ option, index, rank: optionChangeRank(option) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ option }) => option);
}

function customPlaceholderOption(placeholder, label = "Custom…", detail = "Remove this placeholder and type your own value.") {
  return {
    ...insertOption(label, detail, "", "Custom"),
    custom: true,
  };
}

function presetPlaceholderOptions(placeholder) {
  return presetChoicesForPlaceholder(placeholder?.key).map((choice) =>
    insertOption(choice.label, choice.detail || "Editable writing preset.", choice.insertText, "Common presets")
  );
}

function trackedSubjectChoiceOptions(state, prompt, group = "Tracked subjects") {
  if (state.editorProfile !== PROFILE.REF2VA) return [];
  return standaloneDefinitions(prompt)
    .filter((definition) => definition.kind === "subject")
    .map((definition) => insertOption(definition.token, "Use this already-defined semantic Subject.", definition.token, group));
}

function openPlaceholderOptions(placeholder, state, prompt, { includeSubjects = false, extra = [] } = {}) {
  const options = [];
  if (includeSubjects) options.push(...trackedSubjectChoiceOptions(state, prompt));
  options.push(...extra, ...presetPlaceholderOptions(placeholder));
  options.push(customPlaceholderOption(placeholder));
  return options;
}

function languagePlaceholderOptions(placeholder) {
  return [
    ...DIALOGUE_LANGUAGE_OPTIONS.map((language) => dialogueLanguageOption(language, false)),
    customPlaceholderOption(placeholder, "Custom language…", "Type another language. MiniMax documents 11 stable languages and says additional languages are supported to varying degrees."),
  ];
}

function speakerNumberPlaceholderOptions(placeholder, prompt) {
  const known = [...knownSpeakerIds(prompt)].sort((a, b) => a - b);
  const options = known.map((id) => insertOption(`S${id}`, "Reuse a speaker ID already established by an actual target-timeline vocal event.", String(id), "Established speakers"));
  if (!known.length) {
    options.push(insertOption("S1 · first target vocal source", "Use only if S1 is or will be the first actual vocal source in the target timeline.", "1", "Speaker order"));
  }
  options.push(customPlaceholderOption(placeholder, "Custom existing S-number…", "Type the number of an S-ID established by the target timeline."));
  return options;
}

function speakerGroupPlaceholderOptions(placeholder, prompt) {
  const known = [...knownSpeakerIds(prompt)].sort((a, b) => a - b);
  const options = [];
  if (known.length >= 2) {
    options.push(insertOption(
      `All established · ${known.map((id) => `S${id}`).join(",")}`,
      "Use every speaker ID already established by actual vocal events.",
      known.map((id) => `S${id}`).join(","),
      "Established speaker groups",
    ));
    // Pair presets remain useful for larger casts, but they are generated from
    // the actual established IDs rather than assuming only S1/S2 exist. Cap the
    // menu expansion to a reasonable size; Custom remains available for any subset.
    const pairLimit = 12;
    let emitted = 0;
    for (let i = 0; i < known.length && emitted < pairLimit; i += 1) {
      for (let j = i + 1; j < known.length && emitted < pairLimit; j += 1) {
        const value = `S${known[i]},S${known[j]}`;
        options.push(insertOption(value, "Established speakers vocalize together.", value, "Established speaker pairs"));
        emitted += 1;
      }
    }
  }
  options.push(customPlaceholderOption(placeholder, "Custom speaker group…", "Type any comma-separated subset of established S-IDs, for example S1,S3,S4."));
  return options;
}


function currentSectionBeforeCaret(before, sections) {
  let found = null;
  let best = -1;
  for (const section of sections) {
    const re = new RegExp(`^[ \t]*${section}[ \t]*:`, "gim");
    for (const match of String(before || "").matchAll(re)) {
      if ((match.index ?? -1) > best) {
        best = match.index ?? -1;
        found = section;
      }
    }
  }
  return found;
}

function sectionBody(prompt, section, sections) {
  const source = String(prompt || "");
  const header = new RegExp(`^[ \\t]*${section}[ \\t]*:[ \\t]*`, "im").exec(source);
  if (!header) return "";
  const start = (header.index || 0) + header[0].length;
  let end = source.length;
  for (const candidate of sections) {
    if (candidate === section) continue;
    const re = new RegExp(`^[ \\t]*${candidate}[ \\t]*:`, "gim");
    for (const match of source.matchAll(re)) {
      if ((match.index ?? -1) > start && (match.index ?? source.length) < end) end = match.index;
    }
  }
  return source.slice(start, end).trim();
}

function standaloneDefinitions(prompt) {
  const body = sectionBody(prompt, "subject_definitions", REF_SECTIONS);
  const definitions = [];
  const seen = new Set();
  const re = /^\s*(?:@(VideoAudio|Subject|Image|Video|Audio)(\d+)\b|<(Subject|Picture|Image|Video|Audio)\s+(\d+)>)/i;
  for (const line of body.split("\n")) {
    const match = line.match(re);
    if (!match) continue;
    const rawKind = String(match[1] || match[3]).toLowerCase();
    const kind = rawKind === "picture" || rawKind === "image" ? "image" : rawKind === "videoaudio" ? "soundtrack" : rawKind;
    const ordinal = Number(match[2] || match[4]);
    const key = `${kind}:${ordinal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const alias = kind === "image" ? `@Image${ordinal}` : kind === "soundtrack" ? `@VideoAudio${ordinal}` : `@${kind[0].toUpperCase()}${kind.slice(1)}${ordinal}`;
    definitions.push({ kind, ordinal, token: alias, lineText: line.trim() });
  }
  return definitions;
}

function trackedReferenceDescriptors(state, prompt, kind = null) {
  return standaloneDefinitions(prompt)
    .filter((definition) => !kind || (kind === "audio" ? isAudioReferenceKind(definition.kind) : definition.kind === kind))
    .map((definition) => {
      const physical = physicalReferenceDescriptor(state, definition);
      return {
        ...definition,
        inputName: physical?.inputName || null,
        detail: definition.kind === "subject"
          ? "Standalone semantic subject defined in subject_definitions:."
          : "Standalone tracked reference defined in subject_definitions:.",
      };
    });
}

function referenceRegex(definition) {
  if (definition.kind === "soundtrack") return new RegExp(`@VideoAudio${definition.ordinal}\\b`, "i");
  const alias = definition.kind === "image" ? "Image" : definition.kind[0].toUpperCase() + definition.kind.slice(1);
  const native = definition.kind === "image" ? "Picture" : alias;
  return new RegExp(`(?:@${alias}${definition.ordinal}\\b|<${native}\\s+${definition.ordinal}>)`, "i");
}

function shotsContainingReference(prompt, definition) {
  const body = sectionBody(prompt, "detailed_description", REF_SECTIONS);
  const headers = [...body.matchAll(/^[ \t]*\[Shot\s+(\d+)\]/gim)];
  const shots = [];
  headers.forEach((header, index) => {
    const start = header.index || 0;
    const end = headers[index + 1]?.index ?? body.length;
    if (referenceRegex(definition).test(body.slice(start, end))) shots.push(Number(header[1]));
  });
  return shots;
}

function missingRetentionOptions(state, prompt) {
  const retention = sectionBody(prompt, "retention_analysis", REF_SECTIONS);
  const missing = [];
  for (const definition of standaloneDefinitions(prompt)) {
    const row = new RegExp(`^[ \t]*(?:${referenceRegex(definition).source})[^\n]*:\\s*`, "im");
    if (row.test(retention)) continue;
    missing.push(definition);
  }

  return missing.map((definition) => {
    const audioReference = isAudioReferenceKind(definition.kind);
    const shots = audioReference || definition.kind === "video" ? [] : shotsContainingReference(prompt, definition);
    const shotList = shots.map((n) => `[Shot ${n}]`).join(", ");
    const occurrence = !shots.length ? "" : definition.kind === "subject" ? ` (appears in ${shotList})` : ` (${shotList})`;
    const example = audioReference
      ? `${definition.token}: reference - match the defined timbre/rhythm/style property without copying the signal.`
      : `${definition.token}${occurrence || " (appears in [Shot 1])"}: fully_preserved - preserve the specific identity/content characteristics defined for this label.`;
    const keepNext = missing.length > 1 ? "\n{retention rows for tracked references}" : "";
    const retentionField = audioReference ? "{audio retention}" : "{visual retention}";
    return {
      ...insertOption(`${definition.token} retention row`, `Missing row for this tracked label. Choose a marker, then state what changes.`, `${definition.token}${occurrence}: ${retentionField}${keepNext}`, "Current section · retention_analysis", retentionField, example),
      previewType: referencePreviewType(definition),
      inputName: physicalReferenceDescriptor(state, definition)?.inputName || null,
    };
  });
}

function audioLayerReferenceOptions(state, prompt, section) {
  const audioRefs = trackedReferenceDescriptors(state, prompt, "audio");
  const options = [];
  for (const ref of audioRefs) {
    if (section === "overall_soundscape") {
      options.push({ ...insertOption(`${ref.token} · reference ambience/SFX`, "Reference ambience/SFX character; no signal copy.", `${ref.token} is referenced for its ambience and sound-effect texture.`, "Current section · overall_soundscape", null, `${ref.token} is referenced for dense rain texture and distant metallic station ambience.`), previewType: "audio", inputName: ref.inputName || null });
      options.push({ ...insertOption(`${ref.token} · copied ambience layer`, "Copy an ambience/SFX layer; retention should say full/partial copy.", `The copied ambience layer from ${ref.token} continues throughout the target video.`, "Current section · overall_soundscape", null, `The rain-and-traffic ambience copied from ${ref.token} continues through [Shot 1] and fades under the closing door.`), previewType: "audio", inputName: ref.inputName || null });
    } else if (section === "non_diegetic_music") {
      options.push({ ...insertOption(`${ref.token} · reference score style`, "Reference score style/instrumentation/rhythm; no signal copy.", `${ref.token} is referenced for its instrumentation, tempo, rhythm, and dynamic development.`, "Current section · non_diegetic_music", null, `${ref.token} guides sparse piano, slow tempo, and gradual string build without direct signal reuse.`), previewType: "audio", inputName: ref.inputName || null });
      options.push({ ...insertOption(`${ref.token} · reuse audience-only score`, "Reuse this signal as score; retention should say full/partial copy.", `${ref.token} is directly reused as the audience-only score.`, "Current section · non_diegetic_music", null, `${ref.token} is reused from 0:00-0:05 as the audience-only score, then fades into newly generated strings.`), previewType: "audio", inputName: ref.inputName || null });
    }
  }
  return options;
}


function styleSubjectOptions(prompt) {
  const body = sectionBody(prompt, "subject_definitions", REF_SECTIONS);
  const options = [];
  for (const rawLine of body.split("\n")) {
    const match = rawLine.match(/^\s*(?:@Subject(\d+)\b|<Subject\s+(\d+)>)/i);
    if (!match || !/\b(?:visual\s+style|style|aesthetic|rendering\s+look|visual\s+look)\b/i.test(rawLine)) continue;
    const ordinal = Number(match[1] || match[2]);
    const token = `@Subject${ordinal}`;
    options.push(insertOption(
      `${token} · use defined visual style`,
      "Use the tracked style Subject, not its source asset.",
      `${token} as its visual-style reference`,
      "Referenced style",
      null,
      `The target video uses ${token} as its visual style, preserving the referenced realistic materials, neutral color grading, and soft directional lighting.`,
    ));
  }
  return options;
}

function pictureAnchorOptions(state, prompt) {
  if (state.editorProfile !== PROFILE.REF2VA) return [];
  const pictures = standaloneDefinitions(prompt).filter((definition) => definition.kind === "image");
  const options = [];
  for (const definition of pictures) {
    const inputName = state.refs.find((ref) => ref.kind === "image" && ref.ordinal === definition.ordinal)?.inputName || null;
    const base = { previewType: "image", inputName };
    options.push({
      ...insertOption(`${definition.token} · shot begins from`, "Concrete opening-frame anchor.", `the shot begins from ${definition.token}`, "Current section · picture anchors", null, `The shot begins from ${definition.token}; @Subject1 then raises her gaze and turns toward the doorway.`),
      ...base,
    });
    options.push({
      ...insertOption(`${definition.token} · keyframe corresponds to`, "Concrete intermediate-frame anchor.", `the shot's keyframe corresponds to ${definition.token}`, "Current section · picture anchors", null, `Midway through [Shot 1], the shot's keyframe corresponds to ${definition.token}, matching the pose and composition before motion continues.`),
      ...base,
    });
    options.push({
      ...insertOption(`${definition.token} · shot ends on`, "Concrete ending-frame anchor.", `the shot ends on ${definition.token}`, "Current section · picture anchors", null, `The umbrella completes its opening motion and the shot ends on ${definition.token}, matching the final hand position and framing.`),
      ...base,
    });
  }
  return options;
}

function keyframeAliases(state) {
  if (state.editorProfile !== PROFILE.FL2VA) return { opening: "@Image1", ending: "@Image2" };
  return state.keyframeRole === KEYFRAME_LAST
    ? { opening: "@Image2", ending: "@Image1" }
    : { opening: "@Image1", ending: "@Image2" };
}

function nextShotScaffold(state, prompt) {
  const shot = nextShot(prompt, state);
  const isFirst = /^\[Shot 1\]/i.test(shot.text.trim());
  const trackedSubject = state.editorProfile === PROFILE.REF2VA
    ? standaloneDefinitions(prompt).find((definition) => definition.kind === "subject")?.token
    : null;
  const subject = trackedSubject || "{subject / scene}";

  if (isFirst && state.audioMode && state.editorProfile === PROFILE.T2VA) {
    return `${shot.text}The proxy video remains visually minimal and static. {audio events in playback order}. {synchronized sound / dialogue if present}.`;
  }
  if (isFirst && state.editorProfile === PROFILE.T2VA) {
    return `${shot.text}The target video uses {visual style}. The shot uses {shot size / framing} framing from {viewpoint} and frames ${subject}. {action in playback order}. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  }
  if (isFirst && state.editorProfile === PROFILE.I2VA) {
    return `${shot.text}The shot begins from @Image1, preserving its visual style, subject identity, composition, and scene anchors: {subject / scene / composition}. {action onset}. {continuous development}. {result / reaction}. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  }
  if (isFirst && state.editorProfile === PROFILE.FL2VA) {
    const { opening, ending } = keyframeAliases(state);
    return `${shot.text}The shot begins from ${opening} and follows a continuous path toward ${ending}. {first-frame visible state}. {changes between first and last frame}. {approach to final frame}, reaching ${ending} as the final frame. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  }
  if (isFirst && state.editorProfile === PROFILE.L2VA) {
    return `${shot.text}The shot begins from a plausible earlier state compatible with @Image1. {state before the final frame}. {motion toward the final frame}. {final-frame convergence}, landing on @Image1 as the final frame. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  }
  if (isFirst && state.audioMode && state.editorProfile === PROFILE.REF2VA) {
    return `${shot.text}{audio events in playback order}. {synchronized sound / dialogue if present}.`;
  }
  if (isFirst && state.editorProfile === PROFILE.REF2VA) {
    const body = sectionBody(prompt, "detailed_description", REF_SECTIONS);
    const beforeShot = body.split(/^\s*\[Shot\s+1\]/im)[0].trim();
    const style = beforeShot ? "" : "The target video uses {visual style}, with {lighting / color / material traits}.\n";
    return `${style}${shot.text}The shot uses {shot size / framing} framing from {viewpoint} and frames ${subject}. The framed subject is {subject appearance / pose / frame position}. The scene shows {environment / lighting}. {action in playback order}. {secondary motion / physical response}. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  }
  if (!isFirst && state.editorProfile === PROFILE.FL2VA) {
    const ending = keyframeAliases(state).ending;
    return `${shot.text}{cut / transition} a new shot using {shot size / framing} framing from {viewpoint}. {changes between first and last frame}. {approach to final frame}, with this final shot reaching ${ending} at the end of the video. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  }
  if (!isFirst && state.editorProfile === PROFILE.L2VA) {
    return `${shot.text}{cut / transition} a new shot using {shot size / framing} framing from {viewpoint}. {motion toward the final frame}. {final-frame convergence}, with this final shot landing on @Image1 at the end of the video. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  }
  if (state.audioMode) return `${shot.text}${isFirst ? "" : "{cut / transition} "}{audio events in playback order}. {synchronized sound / dialogue if present}.`;
  return `${shot.text}${isFirst ? "The shot uses " : "{cut / transition} a new shot using "}{shot size / framing} framing from {viewpoint} and frames ${subject}. The framed subject is {subject appearance / pose / frame position}. The scene shows {environment / lighting}. {action in playback order}. {secondary motion / physical response}. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
}

function shotFieldOptions(state, prompt) {
  const speaker = nextSpeakerOrdinal(prompt);
  return [
    infoOption("Shot structure", state.editorProfile === PROFILE.REF2VA ? "Style before [Shot 1]. Later shots use [Shot N] At MM:SS.mmm,." : "[Shot 1] has no timestamp. Later shots use [Shot N] At MM:SS.mmm,.", "Structure"),
    ...descriptionOptions().map((option) => ({ ...option, group: "Open shot fields" })),
    insertOption("Camera", "MiniMax-defined motion vocabulary + optional amplitude/speed.", "{camera movement if needed}", "Documented controls", "{camera movement if needed}"),
    insertOption("Dialogue", "New speaker identity + ID + language + exact words.", dialogueLine(speaker, false, true), "Documented controls", "{speaker identity}"),
  ];
}

function summaryTaskTypesInPrompt(prompt) {
  const summary = sectionBody(prompt, "summary", REF_SECTIONS);
  const match = summary.match(/^\s*\[([^\]]*)\]/);
  if (!match) return new Set();
  const normalized = match[1].replace(/\{[^{}]+\}/g, "");
  return new Set(normalized.split("+").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function audioTimelineOptions(state, prompt, placeholder = null) {
  const speaker = nextSpeakerOrdinal(prompt);
  const options = [
    insertOption("Dialogue / narration", "Spoken line with stable speaker ID, language and exact words.", dialogueLine(speaker, false, true), "Audio timeline", "{speaker identity}"),
    insertOption("Singing / lyrics", "Sung vocal event with stable singer ID, language and exact lyrics.", singingLine(speaker, true), "Audio timeline", "{speaker identity}"),
    insertOption("Sound effect / foley", "Concrete audible event at the point it occurs.", "{audio event / timing}", "Audio timeline", "{audio event / timing}"),
    insertOption("Diegetic music", "Music audible inside the scene/source, not audience-only score.", "{diegetic music source / performance}", "Audio timeline", "{diegetic music source / performance}"),
    insertOption("Pause / silence", "Deliberate silent interval between audible events.", "{pause / silence duration}", "Audio timeline", "{pause / silence duration}"),
  ];
  if (placeholder) options.push(customPlaceholderOption(placeholder, "Custom audio event / sequence…", "Type a free-form audible event or sequence when none of the structured starters fits."));
  return options;
}

function placeholderContext(placeholder, state, prompt) {
  if (!placeholder) return { label: "Field", options: [] };
  const key = placeholder.key;
  if (key === "audio events in playback order") return { label: "Audio timeline", options: audioTimelineOptions(state, prompt, placeholder), hint: "Choose a structured audible event or Custom; structured choices continue through their own Tab fields." };
  if (key === "camera movement if needed") {
    return {
      label: "Camera options",
      options: [...cameraOptions(), customPlaceholderOption(placeholder, "Custom camera movement…", "Type free-form natural-language camera motion. The documented MiniMax motions above are the standardized choices.")],
    };
  }
  if (key === "camera amplitude if needed") return { label: "Amplitude", options: cameraAmplitudeOptions() };
  if (key === "camera speed if needed") return { label: "Speed", options: cameraSpeedOptions() };
  if (key === "cut / transition") {
    return {
      label: "Cut / transition",
      options: [...cutTransitionOptions(), customPlaceholderOption(placeholder, "Custom transition…", "Type another transition only when you intentionally need it.")],
      hint: "Use this only to begin a new shot. Prefer an ordinary cut unless a visible dissolve, fade, or wipe is intentional; use camera motion for changes inside one shot.",
    };
  }
  if (key === "dialogue language") {
    return { label: "Dialogue language", options: languagePlaceholderOptions(placeholder), hint: "All 11 stable H3 languages are listed; Custom keeps the field editable for another language." };
  }
  if (key === "define tracked reference content") {
    const continueDefinition = (option) => ({
      ...option,
      insertText: `${option.insertText}\n{define tracked reference content}`,
    });
    const options = [
      ...referenceRelationshipBundleOptions(state, prompt, placeholder),
      ...subjectHelpers(state, prompt).map(continueDefinition),
      ...referenceOptions(state, prompt, "", "subject_definitions"),
      insertOption("Done defining references", "Remove this optional next-definition field and continue to summary.", "", "Finish"),
      customPlaceholderOption(placeholder, "Custom definition…", "Write the semantic Subject/Picture/Video/VideoAudio/Audio definition yourself."),
    ];
    return {
      label: "Define references",
      options,
      hint: "Choose a semantic Subject/helper, a connected asset role, or Custom. Concrete @Image/@Video/@VideoAudio/@Audio role choices also appear when you type that exact @ label.",
    };
  }
  if (key === "retention rows for tracked references") {
    const options = missingRetentionOptions(state, prompt);
    return {
      label: "Missing retention rows",
      options: [
        ...options,
        insertOption("Done with retention", "Remove this optional next-retention field.", "", "Finish"),
        customPlaceholderOption(placeholder, "Custom retention row…", "Write a retention row manually when you intentionally need one."),
      ],
      hint: options.length ? "Choose a tracked label. If more tracked labels remain, the helper keeps this field available for the next row." : "No automatically detectable missing row remains.",
    };
  }
  if (key === "summary task type") {
    const alreadyBracketed = prompt[placeholder.start - 1] === "[" && prompt[placeholder.end] === "]";
    return {
      label: "Task type",
      options: TASK_TYPES.map(([value, detail]) => {
        const taskTypes = `${value}{additional task type if needed}`;
        const insert = alreadyBracketed ? taskTypes : `[${taskTypes}]`;
        return insertOption(value, detail, insert, "MiniMax task types", "{additional task type if needed}");
      }),
    };
  }
  if (key === "additional task type if needed") {
    const used = summaryTaskTypesInPrompt(prompt);
    return {
      label: "Add task type",
      options: [
        insertOption("Done", "No additional relation.", "", "Task types"),
        ...TASK_TYPES
          .filter(([value]) => !used.has(value.toLowerCase()))
          .map(([value, detail]) => insertOption(value, detail, ` + ${value}{additional task type if needed}`, "Task types", "{additional task type if needed}")),
      ],
    };
  }
  if (key === "visual retention" || key === "audio retention") {
    const values = key === "audio retention" ? AUDIO_RETENTION : VISUAL_RETENTION;
    const group = key === "audio retention" ? "Audio retention" : "Visual retention";
    return {
      label: group,
      options: values.map(([value, detail, _example, scaffold]) => insertOption(value, detail, scaffold, group, firstEditorPlaceholder(scaffold))),
      hint: "These relationship markers are fixed H3 rewrite values; choose the marker that matches the role already defined for this reference.",
    };
  }
  if (key === "synchronized sound / dialogue if present") {
    const speaker = nextSpeakerOrdinal(prompt);
    return {
      label: "Sound / dialogue",
      options: [
        insertOption("Dialogue", "New speaker identity + voice + ID + language + exact words.", dialogueLine(speaker, false, true), "Timeline sound", "{speaker identity}"),
        insertOption("Singing / lyrics", "New singer identity + voice + ID + language + exact lyrics.", singingLine(speaker, true), "Timeline sound", "{speaker identity}"),
        insertOption("Diegetic sound", "Insert sound that exists in the scene at this moment.", "Synchronized diegetic sound includes {diegetic sounds}.", "Timeline sound", "{diegetic sounds}"),
        insertOption("None", "Remove this optional slot.", "", "Timeline sound"),
        customPlaceholderOption(placeholder, "Custom synchronized sound / dialogue…", "Type the exact synchronized audio wording when the structured choices do not fit."),
      ],
    };
  }
  if (key === "ambience + physical / non-verbal sounds, or N/A only if completely silent") {
    return {
      label: "Soundscape",
      options: [
        insertOption("Build from layers", "Ambience + physical/foley + non-verbal human sound.", "Ambient sound includes {ambient sources}. Physical sounds include {foley / impacts / object sounds}. Non-verbal human sounds include {breathing / exertion / laughter / other}.", "Soundscape", "{ambient sources}"),
        insertOption("Room ambience + footsteps", "Quick common soundscape starter.", "Steady indoor room tone continues underneath synchronized footsteps and light fabric movement.", "Quick soundscape presets"),
        insertOption("Rain + environment", "Quick weather ambience starter.", "Steady rain and distant environmental ambience continue underneath the physical sounds in the scene.", "Quick soundscape presets"),
        insertOption("N/A", "Use only for intentional complete silence.", "N/A", "Soundscape"),
        customPlaceholderOption(placeholder, "Custom soundscape…", "Write the 1–4 sentence soundscape directly."),
      ],
    };
  }
  if (key === "audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A") {
    return {
      label: "Non-diegetic music",
      options: [
        insertOption("Build from components", "Choose instrumentation, tempo/rhythm, then dynamics.", "The score uses {instruments / sound sources}. The score has {tempo / rhythm}. The music {dynamic change}.", "Score builder", "{instruments / sound sources}"),
        insertOption("Piano + cello · slow", "Quick sparse score preset.", "A sparse piano line at a slow tempo is supported by sustained cello, with a gradual fade toward the end.", "Quick score presets"),
        insertOption("Acoustic guitar + upright bass · moderate", "Quick acoustic score preset.", "Acoustic guitar carries a moderate steady pattern with sparse upright-bass notes, then gently decreases in volume.", "Quick score presets"),
        insertOption("Ambient synth · no pulse", "Quick texture-led score preset.", "Soft synthesizer textures sustain without a clear pulse and remain dynamically restrained throughout.", "Quick score presets"),
        insertOption("N/A", "No audience-only score.", "N/A", "Non-diegetic music"),
        customPlaceholderOption(placeholder, "Custom score…", "Write the audience-only score directly: instrumentation + tempo/rhythm + dynamic development."),
      ],
    };
  }
  if (key === "visual style") {
    const options = [];
    if ([PROFILE.I2VA, PROFILE.FL2VA, PROFILE.L2VA].includes(state.editorProfile)) {
      options.push(insertOption("Match connected keyframe style", "Recommended for keyframe modes: derive the visible style from the supplied frame(s).", "the visual style established by the connected keyframe image or images", "Keyframe style"));
    }
    if (state.editorProfile === PROFILE.REF2VA) options.push(...styleSubjectOptions(prompt));
    options.push(...presetPlaceholderOptions(placeholder));
    options.push(customPlaceholderOption(placeholder, "Custom visual style…", "Type any visual style. The presets are examples, not a closed H3 enum."));
    return { label: "Visual style", options, hint: state.editorProfile === PROFILE.REF2VA ? "Keep the Reference style opening to one or two sentences before [Shot 1]. The style field itself remains free-form." : "MiniMax documents several common style examples; the field itself remains free-form." };
  }
  if (["target subject", "subject", "subject / scene", "subject / scene / composition"].includes(key)) {
    return { label: "Subject / scene", options: openPlaceholderOptions(placeholder, state, prompt, { includeSubjects: true }), hint: "Tracked Subjects appear first in Reference mode; common generic starters follow; Custom stays editable." };
  }
  if (["speaker identity", "target speaker description", "speaker identity / voice traits"].includes(key)) {
    return { label: "Speaker identity", options: openPlaceholderOptions(placeholder, state, prompt, { includeSubjects: true }), hint: "Reference-mode tracked Subjects can be reused as speakers. Presets are writing starters, not identity constraints." };
  }
  if (key === "voice traits") {
    return { label: "Voice traits", options: openPlaceholderOptions(placeholder, state, prompt), hint: "MiniMax recommends enough stable voice context such as pitch, timbre, speaking rate, or accent. These are editable presets." };
  }
  if (key === "speaker number from timeline") {
    return { label: "Speaker ID", options: speakerNumberPlaceholderOptions(placeholder, prompt), hint: "Reuse the S-number established by actual vocal-event order in the target timeline." };
  }
  if (key === "speaker ID group") {
    return { label: "Speaker group", options: speakerGroupPlaceholderOptions(placeholder, prompt), hint: "Choose any established S-ID subset. Characters/speakers are not limited to two; Custom accepts any established group." };
  }
  if (key === "spoken words") {
    const options = [];
    if (state.editorProfile === PROFILE.REF2VA && (state.audioReferenceCount ?? state.audioCount) > 0) options.push(insertOption("[unclear]", "Use only for unintelligible words in referenced source audio.", "[unclear]", "Reference-audio control"));
    options.push(customPlaceholderOption(placeholder, "Type exact dialogue / lyrics…", "Keep the intended words in their original language; do not let the helper invent them."));
    return { label: "Spoken words", options, hint: "Exact-content field: the helper intentionally does not fabricate dialogue or lyrics." };
  }
  if (key === "visible text") {
    return { label: "Visible text", options: [customPlaceholderOption(placeholder, "Type exact on-screen text…", "Enter the exact visible text; MiniMax's guide says to preserve it verbatim in double quotes.")], hint: "Exact-content field: no fabricated text presets." };
  }

  const options = openPlaceholderOptions(placeholder, state, prompt);
  return {
    label: key.replace(/^./, (letter) => letter.toUpperCase()),
    options,
    hint: options.length > 1 ? "Choose a common editable preset or Custom." : "Choose Custom to type the exact value.",
  };
}

function filledPresetTrigger(textarea, state, prompt, section) {
  const filled = filledPresetAtCaret(textarea);
  if (!filled) return null;
  const placeholder = {
    text: filled.text,
    key: filled.key,
    start: filled.start,
    end: filled.end,
    help: EDITOR_PLACEHOLDER_HELP[filled.key],
    highlighted: false,
  };
  const context = placeholderContext(placeholder, state, prompt);
  const options = (context.options || []).map((option) => {
    if (option.custom) {
      return {
        ...option,
        label: "Edit current text…",
        detail: `Select “${filled.text}” so you can type a custom replacement without changing anything first.`,
        editExisting: true,
      };
    }
    const insert = String(option.insertText ?? option.label ?? "").trim();
    if (insert === filled.text) return { ...option, group: "Current choice", detail: `Current value. ${option.detail || "Choose another row to replace it."}` };
    return option;
  });
  if (!options.some((option) => !option.info)) return null;
  return {
    kind: "filled-choice",
    start: filled.start,
    end: filled.end,
    query: "",
    options,
    section,
    hint: `${context.label} · choose another value or edit the current text`,
  };
}

function contextualOptions(section, state, prompt) {
  if (!section) return [];
  if (state.editorProfile === PROFILE.REF2VA && section === "subject_definitions") {
    return [
      infoOption("Syntax", "@SubjectN is ... · natural sentence, no fixed colon/dash after the label.", "Subject definitions"),
      infoOption("Tracking", "One line-leading label = one tracked item. Multiple sources may stay on one Subject line.", "Subject definitions"),
      ...subjectHelpers(state, prompt),
    ];
  }
  if (state.editorProfile === PROFILE.REF2VA && section === "summary") {
    const primarySubject = standaloneDefinitions(prompt).find((definition) => definition.kind === "subject")?.token || "{subject}";
    const options = [
      infoOption("Syntax", "[task type] + one space + one short paragraph. Combine types with +.", "Summary"),
      infoOption("Scope", "High level only: target + shot flow + main reference roles.", "Summary"),
      insertOption("Single-shot premise", "Subject/reference role + action premise.", `The target video uses ${primarySubject} as the character reference for {overall action / premise}.`, "Summary", "{overall action / premise}"),
      insertOption("Multi-shot flow", "Major progression only; no cut timestamps.", "The target video follows {high-level shot progression}.", "Summary", "{high-level shot progression}"),
      ...TASK_TYPES.map(([value, detail]) => insertOption(`[${value}]`, detail, `[${value}] `, "Task types")),
    ];
    const trackedVideo = standaloneDefinitions(prompt).find((definition) => definition.kind === "video");
    if (trackedVideo) options.push(insertOption("video-editing lead-in", `Use only when ${trackedVideo.token} itself is edited.`, `The target video is an edited version of ${trackedVideo.token}. `, "Current section · patterns", null, `[video editing] The target video is an edited version of ${trackedVideo.token}; the edit changes the background while retaining the source timing.`));
    return options;
  }
  if (state.editorProfile === PROFILE.REF2VA && section === "retention_analysis") {
    const options = [
      infoOption("Retention", "Choose the fixed marker; add a concrete explanation when it clarifies what is kept, changed, transferred, copied, or referenced.", "Retention"),
      ...missingRetentionOptions(state, prompt),
    ];
    if (state.videoCount > 0) {
      const subjects = standaloneDefinitions(prompt).filter((definition) => definition.kind === "subject");
      const motionSubject = subjects.find((definition) => /(?:@Video\d+|<Video\s+\d+>)/i.test(definition.lineText || "") && /\b(action|motion|movement|walk|run|jump|flip|pose|performance|mechanics|trajectory)\b/i.test(definition.lineText || ""));
      const targetSubject = subjects.find((definition) => definition.token !== motionSubject?.token);
      if (motionSubject && targetSubject) {
        options.push(insertOption(
          "motion attribute transfer",
          `Transfer ${motionSubject.token}'s motion traits to ${targetSubject.token}.`,
          `${motionSubject.token}: attribute_transfer - transfer its {pose sequence / timing / body mechanics} to ${targetSubject.token}.`,
          "Current section · R2V motion",
          "{pose sequence / timing / body mechanics}",
          `${motionSubject.token}: attribute_transfer - transfer its crouch, takeoff timing, tuck sequence, rotation mechanics, opening, and landing trajectory to ${targetSubject.token}.`
        ));
      }
    }
    options.push(...retentionOptions().map((option) => ({ ...option, group: option.group || "Current section · relationships" })));
    return options;
  }
  if (section === timelineSection(state)) {
    return shotFieldOptions(state, prompt);
  }

  if (section === "overall_soundscape") {
    return [
      infoOption("Scope", "1–4 sentences · ambience + physical/foley + non-verbal human sounds. No dialogue/music repetition.", "Soundscape"),
      insertOption("Ambience", "Persistent environment/room sound.", "Ambient sound includes {ambient sources}.", "Open fields", "{ambient sources}"),
      insertOption("Physical / foley", "Movement, object and impact sounds.", "Physical sounds include {foley / impacts / object sounds}.", "Open fields", "{foley / impacts / object sounds}"),
      insertOption("Non-verbal human", "Breathing, exertion, laughter, gasps, etc.", "Non-verbal human sounds include {breathing / exertion / laughter / other}.", "Open fields", "{breathing / exertion / laughter / other}"),
      insertOption("N/A", "Only for intentional complete silence.", "N/A", "Special"),
      ...audioLayerReferenceOptions(state, prompt, section),
    ];
  }
  if (section === "non_diegetic_music") {
    return [
      infoOption("Scope", "1–3 sentences · audience-only score. Instrumentation + tempo/rhythm + dynamics; no mood/function prose.", "Music"),
      insertOption("Instrumentation", "Instruments or sound sources.", "The score uses {instruments / sound sources}.", "Open fields", "{instruments / sound sources}"),
      insertOption("Tempo / rhythm", "Speed and rhythmic behavior.", "The score has {tempo / rhythm}, with {musical pattern}.", "Open fields", "{tempo / rhythm}"),
      insertOption("Dynamic development", "How volume, density or instrumentation changes.", "The music {dynamic change}.", "Open fields", "{dynamic change}"),
      insertOption("N/A", "No audience-only score.", "N/A", "Special"),
      ...audioLayerReferenceOptions(state, prompt, section),
    ];
  }
  return [];
}

function starterTemplateState(state, editorProfile, audioMode = false, keyframeCount = 0, keyframeRole = KEYFRAME_FIRST, audioStarterTask = null) {
  return {
    editorProfile,
    audioMode,
    audioStarterTask,
    keyframeCount,
    keyframeRole,
    effectiveSeconds: state.effectiveSeconds,
  };
}

function replaceTemplateSectionBody(template, section, nextSection, body) {
  const source = String(template || "");
  const header = `${section}:\n`;
  const start = source.indexOf(header);
  if (start < 0) return source;
  const bodyStart = start + header.length;
  const end = source.indexOf(`\n\n${nextSection}:`, bodyStart);
  if (end < 0) return source;
  return source.slice(0, bodyStart) + body + source.slice(end);
}

function draftTimelineParts(draft) {
  const source = String(draft || "").trim();
  const first = /^\[Shot\s+1\]\s*/i.exec(source);
  if (!first) return { firstShot: source, laterShots: "" };
  const body = source.slice(first[0].length);
  const later = /\n[ \t]*\[Shot\s+(?:[2-9]\d*|1\d+)\]/i.exec(body);
  if (!later) return { firstShot: body.trim(), laterShots: "" };
  return {
    firstShot: body.slice(0, later.index).trim(),
    laterShots: body.slice(later.index).trim(),
  };
}

function wrappedStarterTemplate(template, profile, audioMode, draft, placement) {
  const source = String(draft || "").trim();
  if (profile === PROFILE.REF2VA && placement === "summary") {
    return replaceTemplateSectionBody(template, "summary", "retention_analysis", `[{summary task type}] ${source}`);
  }
  const { firstShot, laterShots } = draftTimelineParts(source);
  if (!firstShot) return template;
  const targetField = audioMode
    ? "{audio events in playback order}"
    : profile === PROFILE.I2VA
      ? "{action onset}"
      : profile === PROFILE.L2VA
        ? "{motion toward the final frame}"
        : profile === PROFILE.FL2VA
          ? "{changes between first and last frame}"
          : "{action in playback order}";
  if (!template.includes(targetField)) return template;
  const fieldWithPeriod = `${targetField}.`;
  let result = /[.!?]$/.test(firstShot) && template.includes(fieldWithPeriod)
    ? template.replace(fieldWithPeriod, firstShot)
    : template.replace(targetField, firstShot);
  if (laterShots) {
    const section = profile === PROFILE.REF2VA ? "detailed_description" : "integrated_multimodal_description";
    result = appendSectionText(result, section, "overall_soundscape", laterShots);
  }
  return result;
}

function starterTemplateOptions(state, currentPrompt = "") {
  const starters = [
    ["T2V / T2VA · base video", "Base text-to-audio-video prompt structure. Sets Mode to Video.", PROFILE.T2VA, false, 0, KEYFRAME_FIRST, "Video templates", null],
    ["I2V / I2VA · first frame", "First-frame prompt structure. Sets Mode to Video and Image 1 to First frame; connect an opening frame before execution.", PROFILE.I2VA, false, 1, KEYFRAME_FIRST, "Video templates", null],
    ["L2V / L2VA · last frame", "Last-frame convergence prompt structure. Sets Mode to Video and Image 1 to Last frame; connect an ending frame before execution.", PROFILE.L2VA, false, 1, KEYFRAME_LAST, "Video templates", null],
    ["FL2V / FL2VA · first + last frames", "First-and-last-frame prompt structure. Sets Mode to Video and Image 1 to First frame; connect both endpoint frames before execution.", PROFILE.FL2VA, false, 2, KEYFRAME_FIRST, "Video templates", null],
    ["R2V / REF2VA · full reference", "Full-reference six-section structure. Sets Mode to Video; connected Reference media still choose conditioning.", PROFILE.REF2VA, false, 0, KEYFRAME_FIRST, "Reference templates", null],
    ["T2A · base audio proxy", "Base audio-proxy prompt structure. Sets Mode to Audio.", PROFILE.T2VA, true, 0, KEYFRAME_FIRST, "Audio templates", "T2A"],
    ["R2A · general reference audio proxy", "General reference audio-proxy structure. Sets Mode to Audio; connect the intended Reference media.", PROFILE.REF2VA, true, 0, KEYFRAME_FIRST, "Audio templates", "R2A"],
    ["I2A · image-guided audio proxy", "Image-guided audio-proxy structure. Sets Mode to Audio; connect Reference image 1.", PROFILE.REF2VA, true, 0, KEYFRAME_FIRST, "Audio templates", "I2A"],
    ["V2A · video-guided audio proxy", "Video-guided audio-proxy structure. Sets Mode to Audio; connect Reference video 1 for timing/whole-video structure. Mute it for visual-only guidance; define @VideoAudio1 separately when its soundtrack is reused or referenced.", PROFILE.REF2VA, true, 0, KEYFRAME_FIRST, "Audio templates", "V2A"],
    ["A2A · audio-guided audio proxy", "Audio-guided audio-proxy structure. Sets Mode to Audio; connect standalone Reference audio 1.", PROFILE.REF2VA, true, 0, KEYFRAME_FIRST, "Audio templates", "A2A"],
  ];
  const draft = String(currentPrompt || "").trim();
  const draftStartsWithShot = /^\[Shot\s+1\]/i.test(draft);
  const templateOptions = starters.flatMap(([label, detail, profile, audioMode, keyframeCount, keyframeRole, group, audioStarterTask]) => {
    const templateState = starterTemplateState(state, profile, audioMode, keyframeCount, keyframeRole, audioStarterTask);
    const starterControls = {
      modeValue: audioMode ? MODE_AUDIO : MODE_VIDEO,
      ...(keyframeCount > 0 ? { keyframeRoleValue: keyframeRole } : {}),
    };
    const starterOption = (...args) => ({ ...insertOption(...args), ...starterControls });
    const blank = templateForState(templateState, "");
    const wrapperTemplate = templateForState(templateState, draft);
    if (!draft) return [starterOption(label, detail, blank, group)];
    const options = [];
    if (profile === PROFILE.REF2VA) {
      if (!draftStartsWithShot) {
        options.push(starterOption(
          `Wrap draft as summary / ${label}`,
          "Keep the current prose as the high-level premise and add the official Reference sections around it.",
          wrappedStarterTemplate(wrapperTemplate, profile, audioMode, draft, "summary"),
          "Use current draft",
        ));
      }
      options.push(starterOption(
        `Wrap draft as shots / ${label}`,
        "Place the current prose in the target timeline and retain editable Reference definitions, task, retention, shot-detail, and audio fields.",
        wrappedStarterTemplate(wrapperTemplate, profile, audioMode, draft, "detailed"),
        "Use current draft",
      ));
    } else {
      options.push(starterOption(
        `Wrap draft / ${label}`,
        "Place the current prose in the target timeline and retain the editable Base shot-detail and audio fields around it.",
        wrappedStarterTemplate(wrapperTemplate, profile, audioMode, draft, "detailed"),
        "Use current draft",
      ));
    }
    options.push(starterOption(`${label} / blank template`, `${detail} This replaces the current draft.`, blank, group));
    return options;
  });
  return [
    { ...insertOption("Custom…", "Keep the current text and write the prompt manually.", "", "Custom"), custom: true, noop: true },
    ...templateOptions,
  ];
}

function hasStructuredPromptStart(text) {
  return /^\s*(?:How the reference pictures align with the target video|For the target video, at 0\.00 seconds|subject_definitions\s*:|integrated_multimodal_description\s*:)/i.test(String(text || ""));
}

function starterTemplateAvailable(textarea) {
  const source = String(textarea?.value || "");
  const start = Math.max(0, Number(textarea?.selectionStart) || 0);
  const end = Math.max(start, Number(textarea?.selectionEnd) || start);
  if (start !== end) return false;
  if (!source.trim()) return true;
  // Existing scaffold fields take priority over the starter chooser. This keeps
  // Tab deterministic when a user is already editing a one-line draft that
  // happens to contain {fields}.
  if (editorPlaceholders(source).length) return false;
  const firstLineEnd = source.indexOf("\n");
  const boundary = firstLineEnd < 0 ? source.length : firstLineEnd;
  if (start > boundary) return false;
  return !hasStructuredPromptStart(source);
}

function contextHint(state, before) {
  const sections = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
  const section = currentSectionBeforeCaret(before, sections);
  if (!String(before || "").trim()) return "Tab = choose any H3 starter · @ = connected references";
  if (insideDialogue(before) && section === timelineSection(state)) return "Dialogue · # = controls · [ = language tag · Tab = next field";
  if (section === "subject_definitions") return "Subjects · @ = connected references · Tab = next field";
  if (section === "summary") return "Summary · [ = task type · @ = tracked references · Tab = next field";
  if (section === "retention_analysis") return "Retention · : = retention choice · [ = shot reference · Tab = next field";
  if (section === "detailed_description" || section === "integrated_multimodal_description") return state.audioMode ? "Shots · [ = next audio-first shot · @ = connected references · # = dialogue · Tab = next field" : "Shots · [ = next shot scaffold · @ = connected references · # = dialogue · Tab = next field";
  if (section === "overall_soundscape") return "Soundscape · Tab = next field";
  if (section === "non_diegetic_music") return "Music · Tab = next field";
  return "Tab = next field · @ = connected references";
}

function tokenEnd(text, caret, pattern) {
  let end = Math.max(0, Math.min(Number(caret) || 0, String(text || "").length));
  const source = String(text || "");
  while (end < source.length && pattern.test(source[end])) end += 1;
  return end;
}

function detectTrigger(textarea, state, prompt, allowFilledPreset = true) {
  const caret = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, caret);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const sections = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
  const section = currentSectionBeforeCaret(before, sections);
  const timeline = timelineSection(state);

  // Typing the opening dialogue tag is enough context to offer the required
  // language tag without exposing fake language choices elsewhere.
  if (section === timeline && /<d>\s*$/i.test(before)) {
    return { kind: "dialogue-language", start: caret, end: caret, query: "", options: languageOptions() };
  }

  let match = line.match(/@([A-Za-z]*\d*)$/);
  if (match) {
    const start = caret - match[0].length;
    const end = tokenEnd(textarea.value, caret, /[A-Za-z0-9]/);
    const query = match[1] || "";
    const available = referenceOptions(state, prompt, query, section);
    let options = filterOptions(available, query);
    if (!options.length) {
      if (state.editorProfile === PROFILE.REF2VA && section && section !== "subject_definitions") {
        options = [infoOption(
          "No defined reference labels here",
          "Define the tracked @Subject/@Image/@Video/@VideoAudio/@Audio relationship in subject_definitions: first, then reference that label here.",
          "References",
        )];
      } else if (!(state.refs || []).length) {
        options = [infoOption(
          "No connected references",
          "Connect a first/last-frame image or a Reference image/video/audio input. Then type @ again.",
          "References",
        )];
      } else {
        options = [infoOption(
          "No matching reference",
          `No connected/defined reference matches @${query}. Delete part of the query to see the available labels.`,
          "References",
        )];
      }
    }
    return { kind: "reference", start, end, query, options, section };
  }

  match = line.match(/#([A-Za-z-]*)$/);
  if (match && section === timeline) {
    const start = caret - match[0].length;
    const end = tokenEnd(textarea.value, caret, /[A-Za-z-]/);
    const controls = dialogueOptions(state, prompt);
    const options = insideDialogue(before) ? controls.filter((option) => ["Dialogue controls", "Dialogue continuity"].includes(option.group)) : controls;
    return { kind: "dialogue", start, end, query: match[1] || "", options: filterOptions(options, match[1] || ""), section };
  }

  match = line.match(/\[([^\[\]\n]*)$/);
  if (match) {
    const start = caret - match[0].length;
    const closing = textarea.value.indexOf("]", caret);
    const suffix = closing >= caret ? textarea.value.slice(caret, closing) : "";
    const end = closing >= caret && !suffix.includes("\n") && !suffix.includes("[") ? closing + 1 : caret;
    const bracketValue = end > caret ? textarea.value.slice(start + 1, end - 1).trim() : "";
    const dialogueStart = before.toLowerCase().lastIndexOf("<d>");
    const atDialogueLanguagePosition = section === timeline
      && insideDialogue(before)
      && dialogueStart >= 0
      && /^\s*$/.test(textarea.value.slice(dialogueStart + 3, start));
    const exactUnclear = end > caret && bracketValue.toLowerCase() === "unclear";
    if (exactUnclear && atDialogueLanguagePosition) {
      return {
        kind: "dialogue-language",
        start,
        end,
        query: "",
        options: [
          infoOption("[unclear] is not a language", "Choose the dialogue language here. Put [unclear] only among the spoken words copied from referenced source audio.", "Dialogue language"),
          ...languageOptions(),
        ],
        section,
      };
    }
    if (exactUnclear && section === timeline && insideDialogue(before)) {
      const referenceAudioAvailable = state.editorProfile === PROFILE.REF2VA && (state.audioReferenceCount ?? state.audioCount) > 0;
      const options = referenceAudioAvailable
        ? [
            insertOption("[unclear] · current", "Keep this unintelligible span from referenced source audio.", "[unclear]", "Reference-audio controls"),
            insertOption("Remove [unclear]", "Delete this transcription marker.", "", "Reference-audio controls"),
          ]
        : [
            infoOption("[unclear] needs referenced source audio", "This marker is only for unintelligible words copied from a Reference audio source.", "Dialogue controls"),
            insertOption("Remove [unclear]", "Delete this unavailable transcription marker.", "", "Dialogue controls"),
          ];
      return { kind: "bracket", start, end, query: "", options, section };
    }
    if (atDialogueLanguagePosition && end > caret) {
      return { kind: "dialogue-language", start, end, query: "", options: languageOptions("", bracketValue), section };
    }
    const optionPrompt = end > caret ? `${textarea.value.slice(0, start)}${textarea.value.slice(end)}` : prompt;
    return { kind: "bracket", start, end, query: match[1] || "", options: bracketOptions(state, optionPrompt, match[1] || "", before, section), section };
  }

  match = line.match(/\(([^()\n]*)$/);
  if (match && (section === timeline || (state.editorProfile === PROFILE.REF2VA && section === "subject_definitions"))) {
    const start = caret - match[0].length;
    const closing = textarea.value.indexOf(")", caret);
    const suffix = closing >= caret ? textarea.value.slice(caret, closing) : "";
    const end = closing >= caret && !suffix.includes("\n") && !suffix.includes("(") ? closing + 1 : caret;
    return { kind: "speaker", start, end, query: match[1] || "", options: speakerOptions(prompt, match[1] || "", section === timeline), section };
  }

  if (state.editorProfile === PROFILE.REF2VA) {
    match = line.match(/((?:@(VideoAudio|Subject|Image|Video|Audio)\d+\b|<(?:Subject|Picture|Image|Video|Audio)\s+\d+>)[^\n]*):\s*([A-Za-z_]*)$/i);
    if (match && section === "retention_analysis") {
      const query = match[3] || "";
      let start = caret - query.length;
      // Own the whitespace immediately after ':' so a completion normalizes it
      // to exactly one space instead of producing ':  fully_preserved'.
      let whitespaceStart = start;
      while (whitespaceStart > 0 && /[ \t]/.test(textarea.value[whitespaceStart - 1])) whitespaceStart -= 1;
      if (textarea.value[whitespaceStart - 1] === ":") start = whitespaceStart;
      const end = tokenEnd(textarea.value, caret, /[A-Za-z_]/);
      return { kind: "retention", start, end, query, options: retentionTriggerOptions(match[1], query), section };
    }
  }
  if (!allowFilledPreset) return null;
  const filled = filledPresetTrigger(textarea, state, prompt, section);
  if (filled) return filled;
  return null;
}

function normalizedReplacementEnd(source, start, end, insertText, preserveBoundaryPunctuation = false) {
  const safeStart = Math.max(0, Math.min(Number(start) || 0, source.length));
  let safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, source.length));
  const inserted = String(insertText ?? "");
  const trimmed = inserted.trimEnd();
  const last = trimmed.at(-1) || "";

  // Scaffold fields are commonly followed by punctuation. Some complete-sentence
  // presets already include their own terminator. Consume only punctuation that
  // begins exactly at the replacement boundary so choosing a preset cannot make
  // `..`, `?.`, `!.`, etc. Do not rewrite punctuation elsewhere in user prose.
  if (!trimmed && !preserveBoundaryPunctuation && /[.!?]/.test(source[safeEnd] || "")) {
    while (/[.!?]/.test(source[safeEnd] || "")) safeEnd += 1;
    // Optional scaffold fields are commonly written as `{field}. `; when the
    // field is removed, consume that separator space too so an explicit opt-out
    // does not leave a visible double-space before the next sentence/field.
    if (source[safeEnd] === " ") safeEnd += 1;
  } else if (/[.!?]/.test(last) && /[.!?]/.test(source[safeEnd] || "")) {
    while (/[.!?]/.test(source[safeEnd] || "")) safeEnd += 1;
  } else if (/[,;:]/.test(last) && source[safeEnd] === last) {
    while (source[safeEnd] === last) safeEnd += 1;
  }
  return safeEnd;
}

function replaceRange(textarea, start, end, insertText, selectText = null, selectPlaceholder = false, preserveBoundaryPunctuation = false) {
  const source = String(textarea.value || "");
  const safeStart = Math.max(0, Math.min(Number(start) || 0, source.length));
  const safeEnd = normalizedReplacementEnd(source, safeStart, end, insertText, preserveBoundaryPunctuation);
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(safeStart, safeEnd);

  // Chromium's execCommand('insertText') is deprecated, but it is still the
  // only broadly available textarea replacement path that participates in the
  // browser's native undo stack. setRangeText() is cleaner API-wise but is not
  // undoable in Chromium. Keep a standards-based fallback for other engines.
  let usedNativeUndo = false;
  try {
    usedNativeUndo = document.execCommand?.("insertText", false, String(insertText ?? "")) === true;
  } catch {
    usedNativeUndo = false;
  }
  if (!usedNativeUndo) {
    textarea.setRangeText(String(insertText ?? ""), safeStart, safeEnd, "end");
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: String(insertText ?? "") }));
  }

  const inserted = String(insertText ?? "");
  const caret = safeStart + inserted.length;
  if (selectText) {
    const local = inserted.indexOf(selectText);
    if (local >= 0) {
      const selectionStart = safeStart + local;
      if (isKnownEditorPlaceholder(selectText) && !selectPlaceholder) {
        const placeholderCaret = placeholderCaretPosition(selectionStart, selectText);
        textarea.setSelectionRange(placeholderCaret, placeholderCaret);
      } else {
        textarea.setSelectionRange(selectionStart, selectionStart + selectText.length);
      }
      return;
    }
  }
  textarea.setSelectionRange(caret, caret);
}

function deterministicDiagnosticRepair(prompt, diagnostic) {
  const source = String(prompt || "");
  const code = String(diagnostic?.code || "");
  if (code === "keyframe-first-line") {
    const expected = String(diagnostic?.example || "").trim();
    if (!expected) return null;
    const content = source.trimStart();
    if (!content) return expected;
    const lineEnd = content.indexOf("\n");
    const firstLine = (lineEnd < 0 ? content : content.slice(0, lineEnd)).trim();
    const rest = lineEnd < 0 ? "" : content.slice(lineEnd + 1).replace(/^(?:\r?\n)+/, "");
    const hasAlignmentLine = /^(?:For the target video, at 0\.00 seconds into the target video,|How the reference pictures align with the target video)/i.test(firstLine);
    if (hasAlignmentLine) return rest ? `${expected}\n\n${rest}` : expected;
    return `${expected}\n\n${content}`;
  }
  if (code === "keyframe-blank-line") {
    const content = source.trimStart();
    const lineEnd = content.indexOf("\n");
    if (lineEnd < 0) return null;
    const firstLine = content.slice(0, lineEnd).trimEnd();
    const rest = content.slice(lineEnd + 1).replace(/^(?:\r?\n)+/, "");
    return rest ? `${firstLine}\n\n${rest}` : firstLine;
  }
  return null;
}

function sourceNodeForInput(node, inputName) {
  if (!node || !inputName) return null;
  const input = (node.inputs || []).find((item) => String(item?.name || "") === String(inputName));
  if (!input || input.link == null) return null;
  const graph = node.graph || app.graph;
  const links = graph?.links;
  const link = links?.get?.(input.link) || links?.[input.link] || graph?._links?.get?.(input.link) || null;
  const originId = Array.isArray(link) ? link[1] : link?.origin_id;
  return originId == null ? null : graph?.getNodeById?.(originId) || null;
}

function viewUrlForResultItem(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (/^(?:blob:|data:|https?:\/\/|\/)/i.test(text)) return text;
    return "";
  }
  const direct = value?.currentSrc || value?.src;
  if (direct) return String(direct);
  const filename = value?.filename;
  if (!filename) return "";
  const params = new URLSearchParams({ filename: String(filename), type: String(value.type || "output") });
  if (value.subfolder) params.set("subfolder", String(value.subfolder));
  return `/view?${params.toString()}`;
}

function viewUrlFromWidgetValue(value, fallbackType = "input") {
  if (!value) return "";
  if (typeof value === "object") {
    if (value.filename) {
      const params = new URLSearchParams({ filename: String(value.filename), type: String(value.type || fallbackType) });
      if (value.subfolder) params.set("subfolder", String(value.subfolder));
      return `/view?${params.toString()}`;
    }
    return "";
  }
  const text = String(value).trim();
  if (/^(?:blob:|data:|https?:\/\/|\/view\?)/i.test(text)) return text;
  const match = text.match(/^(.*?)(?:\s+\[(input|output|temp)\])?$/i);
  const filename = match?.[1]?.trim();
  if (!filename) return "";
  const params = new URLSearchParams({ filename, type: match?.[2] || fallbackType });
  return `/view?${params.toString()}`;
}

function sourcePreviewMedia(node, mediaType) {
  const imageUrls = [];
  let videoUrl = "";
  const addImage = (url) => {
    const value = String(url || "").trim();
    if (value && !imageUrls.includes(value)) imageUrls.push(value);
  };
  const addVideo = (url) => {
    const value = String(url || "").trim();
    if (value && !videoUrl) videoUrl = value;
  };
  if (!node || mediaType === "audio") return { imageUrls, videoUrl };

  // Comfy's legacy and current frontend paths both expose rendered image
  // previews on the node. Prefer those because they already point at the exact
  // media the source node is displaying.
  for (const item of node.imgs || []) addImage(item?.currentSrc || item?.src);
  for (const item of node.images || []) addImage(viewUrlForResultItem(item));
  for (const item of app.nodeOutputs?.[String(node.id)]?.images || []) addImage(viewUrlForResultItem(item));
  for (const widget of node.widgets || []) {
    const element = widget?.element || widget?.inputEl;
    const image = element?.matches?.("img") ? element : element?.querySelector?.("img");
    if (image?.currentSrc || image?.src) addImage(image.currentSrc || image.src);
    const video = element?.matches?.("video") ? element : element?.querySelector?.("video");
    if (video?.poster) addImage(video.poster);
    if (mediaType === "video" && (video?.currentSrc || video?.src)) addVideo(video.currentSrc || video.src);
  }

  const preferred = mediaType === "video"
    ? new Set(["video", "file", "filename", "video_file", "videofile"])
    : new Set(["image", "file", "filename"]);
  const widgets = [...(node.widgets || [])].sort((a, b) => Number(!preferred.has(String(a?.name || "").toLowerCase())) - Number(!preferred.has(String(b?.name || "").toLowerCase())));
  for (const widget of widgets) {
    const name = String(widget?.name || "").toLowerCase();
    if (!preferred.has(name) && mediaType === "image") continue;
    const url = viewUrlFromWidgetValue(widget?.value, "input");
    if (!url) continue;
    if (mediaType === "video") addVideo(url);
    else addImage(url);
  }
  return { imageUrls, videoUrl };
}

function makeReferencePreview(controller, option) {
  const kind = option.previewType;
  if (!kind) return null;
  const fallback = (label, extra = "") => {
    const badge = document.createElement("span");
    badge.className = `h3e-ref-thumb h3e-ref-badge${extra}`;
    badge.textContent = label;
    badge.setAttribute("aria-hidden", "true");
    return badge;
  };
  if (kind === "subject") return fallback("S");
  if (kind === "audio") return fallback("A", " is-audio");

  const cacheKey = `${kind}|${option.inputName || ""}`;
  const now = performance.now();
  const cached = controller.previewCache?.get(cacheKey);
  let media;
  if (cached && now - cached.at < 1500) {
    media = cached.media;
  } else {
    const source = sourceNodeForInput(controller.node, option.inputName);
    media = sourcePreviewMedia(source, kind);
    controller.previewCache?.set(cacheKey, { at: now, media });
  }
  if (media.imageUrls.length) {
    const image = document.createElement("img");
    image.className = "h3e-ref-thumb";
    image.alt = "";
    image.draggable = false;
    let index = 0;
    image.addEventListener("error", () => {
      index += 1;
      if (index < media.imageUrls.length) image.src = media.imageUrls[index];
      else image.replaceWith(fallback(kind === "video" ? "V" : "I", kind === "video" ? " is-video" : ""));
    });
    image.src = media.imageUrls[0];
    return image;
  }
  return fallback(kind === "video" ? "V" : "I", kind === "video" ? " is-video" : "");
}

function selectableMenuIndices(trigger) {
  return (trigger?.options || []).map((option, index) => option.info ? -1 : index).filter((index) => index >= 0);
}

function firstSelectableMenuIndex(trigger) {
  return selectableMenuIndices(trigger)[0] ?? -1;
}

function updateMenuInspector(controller) {
  const options = controller?.trigger?.options || [];
  const option = options[controller?.menuIndex] || (selectableMenuIndices(controller?.trigger).length ? null : options.find((item) => item.info));
  const inspector = controller?.menuInspector;
  if (!inspector) return;
  const detail = inspector.querySelector(".h3e-menu-inspector-detail");
  const insert = inspector.querySelector(".h3e-menu-inspector-insert");
  const detailText = String(option?.detail || option?.label || "");
  const insertText = String(option?.insertText || "");
  const showInsert = !["context", "placeholder", "starter", "guide-target", "filled-choice"].includes(controller?.trigger?.kind)
    && Boolean(insertText && insertText !== String(option?.label || "") && (insertText.includes("{") || insertText.includes(" - ")));
  if (detail) { detail.textContent = detailText; detail.title = detailText; }
  if (insert) {
    insert.textContent = showInsert ? insertText : "";
    insert.title = showInsert ? insertText : "";
    insert.hidden = !showInsert;
  }
}

function scrollMenuRowIntoView(controller, row) {
  const scroll = controller?.menuScroll;
  if (!scroll || !row) return;
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  const viewTop = scroll.scrollTop;
  const viewBottom = viewTop + scroll.clientHeight;
  const edgePad = 6;
  if (top < viewTop + edgePad) scroll.scrollTop = Math.max(0, top - edgePad);
  else if (bottom > viewBottom - edgePad) scroll.scrollTop += bottom - (viewBottom - edgePad);
}

function updateMenuSelection(controller, nextIndex, scroll = true, explicit = false) {
  const previous = controller.menuRows?.get(controller.menuIndex);
  if (previous) previous.classList.remove("selected");
  controller.menuIndex = nextIndex;
  if (explicit) controller.menuSelectionExplicit = true;
  const current = controller.menuRows?.get(nextIndex);
  if (current) {
    current.classList.add("selected");
    if (scroll) scrollMenuRowIntoView(controller, current);
  }
  updateMenuInspector(controller);
}

function moveMenuSelection(controller, delta) {
  const indices = controller.selectableIndices || [];
  if (!indices.length) { updateMenuSelection(controller, -1, false); return; }
  const current = indices.indexOf(controller.menuIndex);
  const base = current >= 0 ? current : 0;
  const next = indices[(base + delta + indices.length) % indices.length];
  updateMenuSelection(controller, next, true, true);
}

function tabShouldAdvancePastUntouchedCustom(controller) {
  const option = controller?.trigger?.options?.[controller?.menuIndex];
  return controller?.trigger?.kind === "placeholder" && Boolean(option?.custom) && !controller?.menuSelectionExplicit;
}

function renderMenu(controller) {
  const { menu } = controller;
  const trigger = controller.trigger;
  menu.replaceChildren();
  controller.menuRows = new Map();
  controller.selectableIndices = selectableMenuIndices(trigger);
  controller.menuSelectionExplicit = false;
  if (!trigger || !trigger.options?.length) {
    menu.classList.remove("open");
    controller.menuIndex = -1;
    controller.setMenuOpen(false);
    return;
  }
  if (!controller.selectableIndices.includes(controller.menuIndex)) controller.menuIndex = controller.selectableIndices[0] ?? -1;
  const scroll = document.createElement("div");
  scroll.className = "h3e-menu-scroll";
  controller.menuScroll = scroll;
  const inspector = document.createElement("div");
  inspector.className = "h3e-menu-inspector";
  const inspectorDetail = document.createElement("div");
  inspectorDetail.className = "h3e-menu-inspector-detail";
  const inspectorInsert = document.createElement("div");
  inspectorInsert.className = "h3e-menu-inspector-insert";
  inspector.append(inspectorDetail, inspectorInsert);
  controller.menuInspector = inspector;
  menu.append(scroll, inspector);
  let lastGroup = null;
  trigger.options.forEach((option, index) => {
    if (option.group && option.group !== lastGroup) {
      const group = document.createElement("div");
      group.className = "h3e-menu-group";
      group.textContent = option.group;
      scroll.appendChild(group);
      lastGroup = option.group;
    }
    const row = document.createElement("div");
    row.className = `h3e-menu-row${option.info ? " is-info" : ""}${index === controller.menuIndex ? " selected" : ""}`;
    row.dataset.optionIndex = String(index);
    const showInsert = !["context", "placeholder", "starter"].includes(trigger.kind) && Boolean(option.insertText && (String(option.insertText).includes("{") || String(option.insertText).includes(" - ")));
    const tooltip = [option.detail, showInsert ? `Insert: ${option.insertText}` : ""].filter(Boolean).join("\n");
    if (tooltip) row.title = tooltip;
    const preview = makeReferencePreview(controller, option);
    if (preview) row.appendChild(preview);
    const copy = document.createElement("span");
    copy.className = "h3e-menu-copy";
    const label = document.createElement("span");
    label.className = "h3e-menu-label";
    label.textContent = option.label;
    const detail = document.createElement("span");
    detail.className = "h3e-menu-detail";
    detail.textContent = option.detail || "";
    copy.append(label, detail);
    if (showInsert) {
      const insertPreview = document.createElement("span");
      insertPreview.className = "h3e-menu-insert";
      insertPreview.textContent = option.insertText;
      copy.appendChild(insertPreview);
    }
    row.appendChild(copy);
    if (!option.info) {
      row.addEventListener("pointerenter", () => updateMenuSelection(controller, index, false, true));
      row.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        controller.choose(index);
      });
    }
    controller.menuRows.set(index, row);
    scroll.appendChild(row);
  });
  menu.classList.add("open");
  controller.setMenuOpen(true);
  updateMenuInspector(controller);
}

const OUTPUT_ASPECT_RATIOS = Object.freeze({
  "1:1": [1, 1],
  "2:3": [2, 3],
  "3:2": [3, 2],
  "3:4": [3, 4],
  "4:3": [4, 3],
  "9:16": [9, 16],
  "16:9": [16, 9],
  "21:9": [21, 9],
});

const OUTPUT_SHORT_EDGE = Object.freeze({
  "768P (native)": 768,
  "704P (draft)": 704,
  "640P (draft)": 640,
  "576P (draft)": 576,
  "512P (draft)": 512,
});

function roundHalfEven(value) {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + lower % 2 : Math.round(value);
}

function alignedPreviewDimension(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(32, roundHalfEven(numeric / 32) * 32);
}

function outputResolutionGeometry(node, state) {
  const selected = String(widgetValue(node, "canvas", H3E_DEFAULTS.canvas));
  if (selected === H3E_VALUES.audioProxyCanvas) {
    return { width: 32, height: 32, value: (32 * 32) / 1_000_000, approximate: false, adaptive: false };
  }
  if (selected === "Custom exact") {
    const width = alignedPreviewDimension(widgetValue(node, "width", H3E_DEFAULTS.customWidth));
    const height = alignedPreviewDimension(widgetValue(node, "height", H3E_DEFAULTS.customHeight));
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height, value: (width * height) / 1_000_000, approximate: false, adaptive: false };
    }
    return null;
  }

  const shortEdge = OUTPUT_SHORT_EDGE[selected];
  if (!shortEdge) return null;
  const layoutState = layoutVisibilityState(node, null, state);
  if (layoutState.frameDrivesAspect) {
    // The frontend knows the selected resolution class but not the tensor shape
    // produced by an arbitrary upstream IMAGE node. Do not fabricate dimensions.
    // Give the theoretical class-area range before per-axis 32px alignment and
    // state explicitly that final geometry resolves from the endpoint at execution.
    const nativeMaxPixels = 768 * 1344;
    return {
      width: null,
      height: null,
      minimumValue: shortEdge ** 2 / 1_000_000,
      value: nativeMaxPixels * (shortEdge / 768) ** 2 / 1_000_000,
      approximate: true,
      adaptive: true,
    };
  }

  const aspect = String(widgetValue(node, "aspect_ratio", H3E_DEFAULTS.aspectRatio));
  const ratio = OUTPUT_ASPECT_RATIOS[aspect];
  if (!ratio) return null;
  const [ratioW, ratioH] = ratio;
  const numericRatio = ratioW / ratioH;
  let nominalW = numericRatio >= 1 ? shortEdge * numericRatio : shortEdge;
  let nominalH = numericRatio >= 1 ? shortEdge : shortEdge / numericRatio;
  const nativeMaxPixels = 768 * 1344;
  const maxPixels = nativeMaxPixels * (shortEdge / 768) ** 2;
  if (nominalW * nominalH > maxPixels) {
    const scale = Math.sqrt(maxPixels / (nominalW * nominalH));
    nominalW *= scale;
    nominalH *= scale;
  }
  const width = alignedPreviewDimension(nominalW);
  const height = alignedPreviewDimension(nominalH);
  return { width, height, value: (width * height) / 1_000_000, approximate: false, adaptive: false };
}

function formatMegapixels(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0.01) return value.toFixed(3);
  return value.toFixed(2);
}

function conditioningBuilderSummary(state) {
  return {
    [PROFILE.T2VA]: "Text",
    [PROFILE.I2VA]: "First frame",
    [PROFILE.L2VA]: "Last frame",
    [PROFILE.FL2VA]: "First + last frames",
    [PROFILE.REF2VA]: "Reference",
  }[state?.conditioningProfile] || "Unknown";
}

function renderPromptSummary(controller, state, validation) {
  const provision = state?.modelSelection || CONDITIONING_MODEL_FL2VA;
  const builder = conditioningBuilderSummary(state);
  const grammarLabel = state?.editorProfileSource === "mixed"
    ? "Grammar mixed"
    : state?.editorProfileSource === "prompt"
      ? `Grammar ${state.editorProfile}`
      : `Helper ${state?.editorProfile || PROFILE.T2VA}`;
  const muted = state?.mutedVideoAudioOrdinals?.length
    ? `${state.mutedVideoAudioOrdinals.map((ordinal) => `V${ordinal}`).join("/")} audio muted`
    : "";
  const summaryText = [`Provision ${provision}`, `Builder ${builder}`, grammarLabel, muted].filter(Boolean).join(" · ");
  controller.summaryState.textContent = summaryText;
  controller.summaryState.title = [
    `Provision: ${provision} from Easy Loader.`,
    `Conditioning builder: ${builder}, selected by connected physical inputs.`,
    state?.editorProfileSource === "mixed"
      ? "Prompt grammar: mixed Base and Reference markers; resolve the structure diagnostic before using guide navigation."
      : state?.editorProfileSource === "prompt"
        ? `Prompt grammar: ${state.editorProfile}, recognized from the prompt structure.`
        : `Writing helper: ${state?.editorProfile || PROFILE.T2VA}, inferred from connections until the prompt establishes a recognizable grammar.`,
    "Provision, builder, and prompt grammar are independent and do not select one another.",
    "Downstream LoRAs and model patches are outside this node and are not inspected.",
    muted ? `Embedded soundtrack conditioning is disabled for ${state.mutedVideoAudioOrdinals.map((ordinal) => `Video ${ordinal}`).join(", ")}; video frames and timing remain active.` : "",
  ].filter(Boolean).join("\n");

  const progress = validation?.guideProgress || null;
  controller.guideProgress = progress;
  const mixed = state?.editorProfileSource === "mixed";
  const targets = Array.isArray(progress?.targets) ? progress.targets : [];
  const remaining = Number(progress?.remaining ?? targets.length) || 0;
  const actionable = !mixed && remaining > 0 && Boolean(progress?.nextSection && progress?.nextRange);
  if (mixed) {
    controller.guideButton.textContent = "Guide paused · mixed grammar";
    controller.guideButton.title = "Resolve the mixed Base/Reference prompt structure first. This does not change Easy Loader provision or physical conditioning.";
  } else if (remaining > 0 && progress?.nextSection) {
    const nextLabel = progress.nextLabel || `Fill ${progress.nextSection}`;
    const hasStructuralFix = targets.some((target) => ["duplicate", "out of order"].includes(target.reason));
    const countLabel = hasStructuralFix ? `${remaining} target${remaining === 1 ? "" : "s"}` : `${remaining} to fill`;
    const targetList = targets.map((target, index) => `${index + 1}. ${target.label}`).join("\n");
    controller.guideButton.textContent = `Guide · ${countLabel} · ${nextLabel} ›`;
    controller.guideButton.title = `${remaining} current Guide target${remaining === 1 ? "" : "s"}. Click to work on ${nextLabel}. Missing or empty structure opens an explicit choice; existing prompt text is not changed until you choose an action.${targetList ? `\n\n${targetList}` : ""}`;
  } else {
    controller.guideButton.textContent = "Guide · no prompt targets";
    controller.guideButton.title = "No current navigable prompt-writing targets. Connection and setting errors remain in the separate validation diagnostic.";
  }
  controller.guideButton.disabled = !actionable;
  controller.guideButton.setAttribute("aria-label", controller.guideButton.title);
}

function guideTargetInsertion(state, prompt, progress) {
  if (!progress?.nextSection || !["missing", "empty"].includes(progress.nextReason)) return null;
  const sections = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
  if (!sections.includes(progress.nextSection)) return null;
  const body = sectionBody(templateForState(state, ""), progress.nextSection, sections);
  if (!body) return null;
  if (progress.nextReason === "empty") {
    return {
      label: `Insert editable ${progress.nextSection} scaffold`,
      detail: `Fill the empty ${progress.nextSection}: body with the current writing-helper scaffold. Nothing changes until you choose this action.`,
      insertText: `\n${body}`,
    };
  }

  const source = String(prompt || "");
  const insertion = Math.max(0, Math.min(Number(progress.nextRange?.start) || 0, source.length));
  const before = source.slice(0, insertion);
  const after = source.slice(insertion);
  const leading = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const trailing = after && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
  return {
    label: `Insert missing ${progress.nextSection}: section`,
    detail: `Insert the missing ${progress.nextSection}: section in canonical order with editable fields. Nothing changes until you choose this action.`,
    insertText: `${leading}${progress.nextSection}:\n${body}${trailing}`,
  };
}

function updateDerivedWidgetLabels(node, state) {
  const secondsWidget = (node?.widgets || []).find((widget) => widgetNameMatches(widget?.name, "seconds"));
  if (secondsWidget) {
    const requested = Number(state?.requestedSeconds);
    const actual = Number(state?.effectiveSeconds);
    const frames = Number(state?.frameCount);
    if (Number.isFinite(requested) && requested >= 1 && requested <= 30 && Number.isFinite(actual) && Number.isFinite(frames) && frames > 0) {
      secondsWidget.label = `Requested duration (s) · ${frames}f · actual ${actual.toFixed(3)}s`;
    } else {
      secondsWidget.label = FRIENDLY_WIDGET_LABELS.get("seconds") || "Requested duration (s)";
    }
  }

  const canvasWidget = (node?.widgets || []).find((widget) => widgetNameMatches(widget?.name, "canvas"));
  if (canvasWidget) {
    const geometry = outputResolutionGeometry(node, state);
    const minimumFormatted = geometry ? formatMegapixels(geometry.minimumValue) : null;
    const formatted = geometry ? formatMegapixels(geometry.value) : null;
    if (geometry && formatted && Number.isFinite(geometry.width) && Number.isFinite(geometry.height)) {
      canvasWidget.label = `Output resolution · ${geometry.width}×${geometry.height} · ${formatted} MP`;
    } else if (geometry?.adaptive && minimumFormatted && formatted) {
      canvasWidget.label = `Output resolution · frame-adaptive · ~${minimumFormatted}-${formatted} MP pre-align`;
    } else {
      canvasWidget.label = FRIENDLY_WIDGET_LABELS.get("canvas") || "Output resolution";
    }
  }

  for (let slot = 0; slot < 3; slot += 1) {
    const widget = (node?.widgets || []).find((item) => widgetNameMatches(item?.name, `ref_video_use_audio_${slot}`));
    if (widget) widget.label = FRIENDLY_WIDGET_LABELS.get(`ref_video_use_audio_${slot}`) || `Use Video ${slot + 1} soundtrack`;
  }
  connectedInputs(node, "ref_video_").forEach((input, index) => {
    const slot = autogrowInputSlot(input?.name, "ref_video_");
    if (!Number.isFinite(slot)) return;
    const widget = (node?.widgets || []).find((item) => widgetNameMatches(item?.name, `ref_video_use_audio_${slot}`));
    if (widget) widget.label = `Use Reference Video ${index + 1} soundtrack · @VideoAudio${index + 1}`;
  });
}

function makeController(node, nativePromptWidget) {
  const inputName = String(nativePromptWidget?.name || "prompt");
  const inputData = nativePromptWidget?.options || {};
  injectStyles();
  const wrapper = document.createElement("div");
  wrapper.className = "h3e-editor";
  const routeNotice = document.createElement("div");
  routeNotice.className = "h3e-route-notice";
  routeNotice.hidden = true;
  routeNotice.textContent = "";
  routeNotice.title = "";
  const head = document.createElement("div");
  head.className = "h3e-head";
  const profile = document.createElement("div");
  profile.className = "h3e-profile";
  profile.textContent = "H3";
  const status = document.createElement("div");
  status.className = "h3e-status";
  status.tabIndex = -1;
  status.setAttribute("role", "button");
  status.setAttribute("aria-label", "Prompt validation status");
  const statusToggle = document.createElement("span");
  statusToggle.className = "h3e-status-toggle";
  statusToggle.textContent = "▸";
  statusToggle.setAttribute("aria-hidden", "true");
  const statusMain = document.createElement("span");
  statusMain.className = "h3e-status-main";
  status.append(statusToggle, statusMain);
  head.append(profile, status);
  const summary = document.createElement("div");
  summary.className = "h3e-summary";
  const summaryState = document.createElement("span");
  summaryState.className = "h3e-summary-state";
  summaryState.textContent = "Provision · Builder · Grammar";
  const guideButton = document.createElement("button");
  guideButton.type = "button";
  guideButton.className = "h3e-guide-progress";
  guideButton.textContent = "Guide · waiting";
  guideButton.disabled = true;
  summary.append(summaryState, guideButton);
  const diagnostic = document.createElement("div");
  diagnostic.className = "h3e-diagnostic";
  const diagnosticMain = document.createElement("div");
  diagnosticMain.className = "h3e-diagnostic-main";
  const diagnosticCopy = document.createElement("div");
  diagnosticCopy.className = "h3e-diagnostic-copy";
  const diagnosticTitle = document.createElement("span");
  diagnosticTitle.className = "h3e-diagnostic-title";
  const diagnosticMessage = document.createElement("span");
  diagnosticMessage.className = "h3e-diagnostic-message";
  diagnosticCopy.append(diagnosticTitle, diagnosticMessage);
  const diagnosticNav = document.createElement("div");
  diagnosticNav.className = "h3e-diagnostic-nav";
  const diagnosticPrev = document.createElement("button");
  diagnosticPrev.type = "button";
  diagnosticPrev.className = "h3e-diagnostic-button";
  diagnosticPrev.textContent = "‹";
  diagnosticPrev.setAttribute("aria-label", "Previous prompt diagnostic");
  const diagnosticCount = document.createElement("span");
  diagnosticCount.className = "h3e-diagnostic-count";
  const diagnosticNext = document.createElement("button");
  diagnosticNext.type = "button";
  diagnosticNext.className = "h3e-diagnostic-button";
  diagnosticNext.textContent = "›";
  diagnosticNext.setAttribute("aria-label", "Next prompt diagnostic");
  diagnosticNav.append(diagnosticPrev, diagnosticCount, diagnosticNext);
  diagnosticMain.append(diagnosticCopy);
  head.append(diagnosticNav);
  const diagnosticExample = document.createElement("span");
  diagnosticExample.className = "h3e-diagnostic-example";
  const diagnosticApply = document.createElement("button");
  diagnosticApply.type = "button";
  diagnosticApply.className = "h3e-diagnostic-apply";
  diagnosticApply.textContent = "Apply structural fix";
  diagnosticApply.hidden = true;
  diagnostic.append(diagnosticMain, diagnosticExample, diagnosticApply);
  const textarea = document.createElement("textarea");
  textarea.className = "h3e-textarea";
  textarea.spellcheck = false;
  textarea.placeholder = inputData?.[1]?.placeholder || inputData?.placeholder || "Tab opens all H3 starters · @ references · [ shots/tasks · # dialogue";
  const contextbar = document.createElement("div");
  contextbar.className = "h3e-contextbar";
  const hint = document.createElement("div");
  hint.className = "h3e-hint";
  hint.textContent = "Tab = starter / choose / next field · Shift+Tab = previous field · @ = connected references";
  contextbar.append(hint);
  const menu = document.createElement("div");
  menu.className = "h3e-menu";
  wrapper.append(head, summary, diagnostic, routeNotice, textarea, menu, contextbar);

  const defaultValue = String(nativePromptWidget?.value ?? inputData?.[1]?.default ?? inputData?.default ?? "");
  textarea.value = defaultValue;
  const controller = {
    node, inputName, nativePromptWidget, wrapper, routeNotice, textarea, menu, profile, status, statusToggle, statusMain, summaryState, guideButton, diagnostic, diagnosticTitle, diagnosticMessage, diagnosticExample, diagnosticApply, diagnosticNav, diagnosticPrev, diagnosticNext, diagnosticCount, hint,
    widget: null, trigger: null, menuIndex: -1, menuSelectionExplicit: false, menuNavigationActive: false, menuOpen: false, menuAutoBaseHeight: null, menuAutoTargetHeight: null, refreshTimer: null, widgetRefreshTimer: null, connectionRefreshTimer: null, diagnosticIndex: 0, diagnosticExpanded: false, guideProgress: null,
    layoutVisibilitySignature: null,
    suppressAutocomplete: false, applyingCompletion: false,
    selectableIndices: [], menuRows: new Map(), previewCache: new Map(),
    externalRevision: 0, stateCache: null, validation: null,
    getState() {
      const prompt = textarea.value;
      const cached = this.stateCache;
      if (cached && cached.prompt === prompt && cached.externalRevision === this.externalRevision) return cached.state;
      const state = nodeState(node, prompt);
      this.stateCache = { prompt, externalRevision: this.externalRevision, state };
      return state;
    },
    invalidateExternalState() {
      this.externalRevision += 1;
      this.stateCache = null;
      this.previewCache.clear();
    },
    setMenuOpen(open) {
      const next = Boolean(open);
      if (next === this.menuOpen) return;
      this.menuOpen = next;

      const width = Number(node?.size?.[0]);
      const height = Number(node?.size?.[1]);
      if (this.widget && Number.isFinite(width) && Number.isFinite(height) && typeof node?.setSize === "function") {
        if (next) {
          this.menuAutoBaseHeight = height;
          this.menuAutoTargetHeight = height + MENU_LAYOUT_HEIGHT;
          node.setSize([width, this.menuAutoTargetHeight]);
        } else {
          const base = this.menuAutoBaseHeight;
          const target = this.menuAutoTargetHeight;
          // Only undo our own automatic growth. If the user resized while the
          // menu was open, keep their new node size instead of fighting it.
          if (Number.isFinite(base) && Number.isFinite(target) && Math.abs(height - target) <= 4) {
            node.setSize([width, base]);
          }
          this.menuAutoBaseHeight = null;
          this.menuAutoTargetHeight = null;
        }
      }
      node.graph?.setDirtyCanvas?.(true, false);
    },
    closeMenu() {
      if (!this.trigger && !menu.classList.contains("open") && !menu.childNodes.length && !this.menuOpen) return;
      this.trigger = null;
      this.menuIndex = -1;
      this.menuSelectionExplicit = false;
      this.menuNavigationActive = false;
      this.selectableIndices = [];
      this.menuRows.clear();
      menu.replaceChildren();
      menu.classList.remove("open");
      this.setMenuOpen(false);
    },
    commit() {
      // Keep ComfyUI's native STRING widget as the only serialized prompt value.
      // The Easy DOM editor is presentation only, so failure of the editor can
      // never make the backend node type unconstructable.
      if (this.nativePromptWidget && String(this.nativePromptWidget.value ?? "") !== textarea.value) {
        this.nativePromptWidget.value = textarea.value;
      }
      // Content edits can reorder/remove diagnostics. Start from the first current
      // item and collapse advisory notes on the next validation pass.
      this.diagnosticIndex = 0;
      this.notesExpanded = false;
      this.scheduleRefresh(160);
    },
    syncFromNative(force = false) {
      if (!this.nativePromptWidget) return false;
      const value = String(this.nativePromptWidget.value ?? "");
      if (!force && value === textarea.value) return false;
      textarea.value = value;
      this.closeMenu();
      this.diagnosticIndex = 0;
      this.notesExpanded = false;
      this.stateCache = null;
      return true;
    },
    scheduleRefresh(delay = 160) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        try {
          this.refresh();
        } catch (error) {
          console.error("[MiniMax H3 Easy] Prompt editor refresh failed.", error);
          statusMain.className = "h3e-status-main is-error";
          statusMain.textContent = "Editor refresh failed";
          status.title = "Prompt editor refresh failed. Open the browser developer console for the underlying error.";
          status.classList.remove("is-actionable");
          status.tabIndex = -1;
          statusToggle.textContent = "";
        }
      }, delay);
    },
    updateHint(state = this.getState(), placeholder = editorPlaceholderAtSelection(textarea)) {
      const before = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
      const placeholderUi = placeholder ? placeholderContext(placeholder, state, textarea.value) : null;
      const customHint = placeholderUi?.options?.some((option) => option.custom) ? " · untouched Custom + Tab next" : "";
      const text = placeholder
        ? (placeholderUi?.options?.length ? `${placeholderUi.label} · ↑/↓ choose · Tab/Enter insert${customHint} · Shift+Tab previous` : (placeholderUi?.hint || placeholder.help))
        : contextHint(state, before);
      if (hint.textContent !== text) hint.textContent = text;
      hint.title = text;
    },
    diagnosticItems() {
      const issues = this.validation?.issues || [];
      if (issues.length) return { kind: "issue", items: issues };
      const notes = this.validation?.notes || [];
      return { kind: "note", items: notes };
    },
    currentDiagnostic() {
      const { items } = this.diagnosticItems();
      if (!items.length) return null;
      this.diagnosticIndex = Math.max(0, Math.min(this.diagnosticIndex, items.length - 1));
      return items[this.diagnosticIndex] || null;
    },
    renderDiagnostic() {
      const { kind, items } = this.diagnosticItems();
      if (!items.length) return false;
      this.diagnosticIndex = Math.max(0, Math.min(this.diagnosticIndex, items.length - 1));
      const current = items[this.diagnosticIndex];
      const ordinal = this.diagnosticIndex + 1;
      const isIssue = kind === "issue";
      diagnostic.classList.toggle("is-note", !isIssue);
      statusMain.className = isIssue ? "h3e-status-main is-error" : "h3e-status-main is-ok";
      const label = current.title;
      if (statusMain.textContent !== label) statusMain.textContent = label;
      statusToggle.textContent = this.diagnosticExpanded ? "▾" : "▸";
      status.title = [current.message, current.example ? `Try: ${current.example.replace(/\s+/g, " ")}` : ""].filter(Boolean).join("\n");
      status.classList.add("is-actionable");
      status.tabIndex = 0;
      diagnosticTitle.textContent = `${current.title}: `;
      diagnosticMessage.textContent = current.message;
      diagnosticExample.textContent = current.example ? `Try:\n${current.example}` : "";
      diagnosticApply.hidden = !isIssue || deterministicDiagnosticRepair(textarea.value, current) == null;
      diagnostic.title = [current.title, current.message, current.example ? `Try: ${current.example.replace(/\s+/g, " ")}` : ""].filter(Boolean).join("\n");
      diagnostic.classList.toggle("open", this.diagnosticExpanded);
      diagnosticNav.classList.toggle("open", items.length > 1);
      diagnosticCount.textContent = `${ordinal}/${items.length}`;
      diagnosticPrev.disabled = this.diagnosticIndex <= 0;
      diagnosticNext.disabled = this.diagnosticIndex >= items.length - 1;
      return true;
    },
    applyDiagnosticRepair(item = this.currentDiagnostic()) {
      const repaired = deterministicDiagnosticRepair(textarea.value, item);
      if (repaired == null || repaired === textarea.value) return false;
      this.applyingCompletion = true;
      try {
        replaceRange(textarea, 0, textarea.value.length, repaired);
      } finally {
        this.applyingCompletion = false;
      }
      this.commit();
      textarea.focus({ preventScroll: true });
      return true;
    },
    navigateDiagnostic(delta) {
      const { items } = this.diagnosticItems();
      if (items.length < 2) return false;
      const next = Math.max(0, Math.min(this.diagnosticIndex + delta, items.length - 1));
      if (next === this.diagnosticIndex) return false;
      this.diagnosticIndex = next;
      this.renderDiagnostic();
      return true;
    },
    focusDiagnostic(issue = this.currentDiagnostic()) {
      const range = issue?.range;
      if (!range) return false;
      const sourceLength = textarea.value.length;
      const start = Math.max(0, Math.min(Number(range.start) || 0, sourceLength));
      const end = Math.max(start, Math.min(Number(range.end) || start, sourceLength));
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, end);
      const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
      const precedingLines = textarea.value.slice(0, start).split("\n").length - 1;
      textarea.scrollTop = Math.max(0, precedingLines * lineHeight - textarea.clientHeight * 0.35);
      this.suppressAutocomplete = true;
      this.closeMenu();
      this.updateHint();
      return true;
    },
    focusGuideTarget() {
      const state = this.getState();
      const validation = validatePrompt(textarea.value, state);
      this.validation = validation;
      const progress = validation.guideProgress;
      this.guideProgress = progress;
      const range = progress?.nextRange;
      if (!progress?.nextSection || !range || state.editorProfileSource === "mixed") return false;
      const sourceLength = textarea.value.length;
      const start = Math.max(0, Math.min(Number(range.start) || 0, sourceLength));
      const end = Math.max(start, Math.min(Number(range.end) || start, sourceLength));
      this.suppressAutocomplete = true;
      this.closeMenu();
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, end);
      const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
      const precedingLines = textarea.value.slice(0, start).split("\n").length - 1;
      textarea.scrollTop = Math.max(0, precedingLines * lineHeight - textarea.clientHeight * 0.35);
      const placeholder = editorPlaceholderAtSelection(textarea);
      this.updateHint(state, placeholder);
      if (placeholder) return this.openSelectedPlaceholderChoices(state, placeholder);
      if (progress.nextReason === "missing" && state.editorProfileSource !== "prompt") return this.openStarterTemplates(state);
      if (start === end && ["missing", "empty"].includes(progress.nextReason)) return this.openGuideTargetChoices(state, progress);
      return true;
    },
    refresh() {
      const state = this.getState();
      const editorActive = document.activeElement === textarea;
      const layoutVisibilitySignature = `${state.mode}|${state.canvasMode}|${state.keyframeRole}|${state.keyframeCanvas}|${state.conditioningProfile}|${state.keyframeCount}|${state.imageCount}|${state.videoCount}`;
      if (layoutVisibilitySignature !== this.layoutVisibilitySignature) {
        this.layoutVisibilitySignature = layoutVisibilitySignature;
        syncLayoutWidgetVisibility(node, this, state);
        node.graph?.setDirtyCanvas?.(true, false);
      }
      updateDerivedWidgetLabels(node, state);
      if (!editorActive) this.updateHint(state);
      const result = validatePrompt(textarea.value, state);
      this.validation = result;
      renderPromptSummary(this, state, result);
      routeNotice.hidden = !state.hasMixedInputFamilies;
      if (state.hasMixedInputFamilies) {
        routeNotice.textContent = "Disconnect Reference media or first/last frames";
        routeNotice.title = "The two physical input families require different native H3 builders. Easy blocks this ambiguous workflow instead of silently ignoring endpoint frames.";
      }
      const description = profileDescription(state);
      const profileLabel = state.editorProfile;
      if (profile.textContent !== profileLabel) profile.textContent = profileLabel;
      profile.title = description;
      if (result.issues.length) {
        this.renderDiagnostic();
      } else {
        statusMain.className = "h3e-status-main is-ok";
        const label = result.notes.length ? `Structure ✓ · ${result.notes.length} note${result.notes.length === 1 ? "" : "s"}` : "Structure ✓";
        if (statusMain.textContent !== label) statusMain.textContent = label;
        status.title = result.notes.length
          ? `${result.notes[0].title}\n${result.notes[0].message}\nClick to inspect all notes.`
          : description;
        const inspectable = result.notes.length > 0;
        status.classList.toggle("is-actionable", inspectable);
        status.tabIndex = inspectable ? 0 : -1;
        statusToggle.textContent = inspectable ? (this.diagnosticExpanded ? "▾" : "▸") : "";
        if (inspectable) {
          this.renderDiagnostic();
        } else {
          this.diagnosticExpanded = false;
          diagnostic.classList.remove("open", "is-note");
          diagnosticNav.classList.remove("open");
          diagnosticCount.textContent = "";
          diagnosticTitle.textContent = "";
          diagnosticMessage.textContent = "";
          diagnosticExample.textContent = "";
          diagnosticApply.hidden = true;
          statusToggle.textContent = "";
        }
      }
      if (editorActive) this.syncMenu(false);
    },
    syncMenu(allowFilledPreset = true) {
      const state = this.getState();
      const placeholder = editorPlaceholderAtSelection(textarea);
      if (this.trigger?.kind === "starter" && textarea.value === this.trigger.sourceText) return;
      if (["reference-followup", "guide-target"].includes(this.trigger?.kind)
        && textarea.selectionStart === this.trigger.start
        && textarea.selectionEnd === this.trigger.end) {
        return;
      }
      this.updateHint(state, placeholder);
      if (this.suppressAutocomplete) { this.closeMenu(); return; }
      if (placeholder && this.openSelectedPlaceholderChoices(state, placeholder)) return;
      const trigger = detectTrigger(textarea, state, textarea.value, allowFilledPreset);
      if (!trigger) { this.closeMenu(); return; }
      const options = leastChangeOptionsFirst(trigger.options);
      const signature = `${trigger.kind}|${trigger.start}|${trigger.end}|${trigger.query}|${options.map((o) => o.label).join("\u001f")}`;
      if (signature === this.trigger?.signature) return;
      this.trigger = { ...trigger, options, signature };
      this.menuIndex = firstSelectableMenuIndex(this.trigger);
      renderMenu(this);
      if (trigger.hint) {
        hint.textContent = trigger.hint;
        hint.title = trigger.hint;
      }
    },
    openStarterTemplates(state = this.getState()) {
      const options = leastChangeOptionsFirst(starterTemplateOptions(state, textarea.value));
      const signature = `starter|${textarea.value.length}|${options.map((o) => o.label).join("\u001f")}`;
      if (signature === this.trigger?.signature) return true;
      this.suppressAutocomplete = false;
      this.trigger = {
        kind: "starter",
        start: 0,
        end: textarea.value.length,
        query: "",
        options,
        section: null,
        sourceText: textarea.value,
        signature,
      };
      this.menuIndex = firstSelectableMenuIndex(this.trigger);
      renderMenu(this);
      this.updateHint(state, null);
      return true;
    },
    openGuideTargetChoices(state, progress) {
      const insertion = guideTargetInsertion(state, textarea.value, progress);
      if (!insertion) return false;
      const insert = {
        ...insertOption(insertion.label, insertion.detail, insertion.insertText, "Guide"),
        selectText: firstEditorPlaceholder(insertion.insertText),
      };
      const manual = { ...insertOption("Write here manually…", `Keep the ${progress.nextSection}: target unchanged and type your own content.`, "", "Guide"), noop: true };
      const options = [insert, manual];
      const signature = `guide-target|${progress.nextSection}|${progress.nextReason}|${progress.nextRange.start}|${options.map((option) => option.label).join("\u001f")}`;
      this.suppressAutocomplete = false;
      this.trigger = {
        kind: "guide-target",
        start: progress.nextRange.start,
        end: progress.nextRange.end,
        query: "",
        options,
        section: progress.nextSection,
        signature,
      };
      this.menuIndex = firstSelectableMenuIndex(this.trigger);
      renderMenu(this);
      const text = `${progress.nextLabel || progress.nextSection} · choose scaffold or write manually`;
      hint.textContent = text;
      hint.title = text;
      return true;
    },
    openReferenceFollowup(ref, start, end, section, state = this.getState()) {
      const options = referenceFollowupOptions(ref, state, textarea.value, section, { start, end });
      if (options.length <= 1) return false;
      this.suppressAutocomplete = false;
      this.trigger = {
        kind: "reference-followup",
        start,
        end,
        query: ref.token.slice(1),
        options,
        section,
        signature: `reference-followup|${ref.kind}|${ref.ordinal}|${start}|${end}|${section || ""}|${options.map((option) => option.label).join("\u001f")}`,
      };
      this.menuIndex = firstSelectableMenuIndex(this.trigger);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, end);
      renderMenu(this);
      const text = `Continue ${ref.token} · choose a role/template, or Keep label only`;
      hint.textContent = text;
      hint.title = text;
      return true;
    },
    openSelectedPlaceholderChoices(state = this.getState(), placeholder = editorPlaceholderAtSelection(textarea)) {
      if (!placeholder) { this.closeMenu(); return false; }
      const context = placeholderContext(placeholder, state, textarea.value);
      const options = leastChangeOptionsFirst(context.options);
      if (!options.length) { this.closeMenu(); return false; }
      this.suppressAutocomplete = false;
      const before = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
      const sections = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
      const section = currentSectionBeforeCaret(before, sections);
      const signature = `placeholder|${placeholder.key}|${placeholder.start}|${options.map((o) => o.label).join("\u001f")}`;
      if (signature === this.trigger?.signature) {
        highlightPlaceholderReplacement(textarea, placeholder);
        return true;
      }
      this.trigger = {
        kind: "placeholder", start: placeholder.start, end: placeholder.end, query: "", options, section, signature,
      };
      this.menuIndex = firstSelectableMenuIndex(this.trigger);
      renderMenu(this);
      // Make the exact text that the menu will replace visually explicit. The
      // menu still works because editorPlaceholderAtSelection accepts this exact
      // full-range selection as the active placeholder.
      highlightPlaceholderReplacement(textarea, placeholder);
      return true;
    },
    choose(index) {
      const trigger = this.trigger;
      const option = trigger?.options?.[index];
      if (!trigger || !option || option.info) return;
      const customEditing = Boolean(option.custom);
      this.suppressAutocomplete = true;
      this.closeMenu();
      if (option.editExisting) {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(trigger.start, trigger.end);
        this.updateHint(this.getState(), null);
        return;
      }
      if (option.noop) {
        textarea.focus({ preventScroll: true });
        this.updateHint(this.getState(), editorPlaceholderAtSelection(textarea));
        return;
      }
      let controlsChanged = false;
      if (option.modeValue) {
        const modeWidget = (node?.widgets || []).find((widget) => widgetNameMatches(widget?.name, "mode"));
        if (modeWidget && modeWidget.value !== option.modeValue) {
          modeWidget.value = option.modeValue;
          controlsChanged = true;
        }
      }
      if (option.keyframeRoleValue) {
        const roleWidget = (node?.widgets || []).find((widget) => widgetNameMatches(widget?.name, "keyframe_role"));
        if (roleWidget && roleWidget.value !== option.keyframeRoleValue) {
          roleWidget.value = option.keyframeRoleValue;
          controlsChanged = true;
        }
      }
      if (controlsChanged) {
        this.invalidateExternalState();
        syncLayoutWidgetVisibility(node, this, this.getState());
        node.graph?.setDirtyCanvas?.(true, false);
      }
      this.applyingCompletion = true;
      try {
        const replaceWholePrompt = typeof option.replacePrompt === "string";
        const insert = replaceWholePrompt ? option.replacePrompt : option.insertText ?? option.label;
        replaceRange(
          textarea,
          replaceWholePrompt ? 0 : trigger.start,
          replaceWholePrompt ? textarea.value.length : trigger.end,
          insert,
          option.selectText || option.select || firstEditorPlaceholder(insert),
          customEditing,
          customEditing,
        );
      } finally {
        this.applyingCompletion = false;
      }
      this.closeMenu();
      this.commit();
      textarea.focus();
      const state = this.getState();
      if (!customEditing && option.referenceRef) {
        const inserted = String(option.insertText ?? option.label);
        const start = trigger.start;
        const end = start + inserted.length;
        if (this.openReferenceFollowup(option.referenceRef, start, end, trigger.section, state)) return;
      }
      const placeholder = editorPlaceholderAtSelection(textarea);
      this.updateHint(state, placeholder);
      if (!customEditing) this.openSelectedPlaceholderChoices(state, placeholder);
    },
  };

  guideButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  guideButton.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) event.stopPropagation();
  });
  guideButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    controller.focusGuideTarget();
  });

  const activateStatus = (event) => {
    if (event?.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    if (event?.type === "keydown") event.preventDefault();
    const { items } = controller.diagnosticItems();
    if (!items.length) return;
    controller.diagnosticExpanded = !controller.diagnosticExpanded;
    controller.diagnosticIndex = Math.max(0, Math.min(controller.diagnosticIndex, items.length - 1));
    controller.renderDiagnostic();
  };
  status.addEventListener("pointerdown", (event) => event.stopPropagation());
  status.addEventListener("click", activateStatus);
  status.addEventListener("keydown", activateStatus);

  diagnosticApply.addEventListener("pointerdown", (event) => event.stopPropagation());
  diagnosticApply.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    controller.applyDiagnosticRepair();
  });

  const bindDiagnosticNavigation = (button, delta) => {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.navigateDiagnostic(delta);
    });
  };
  bindDiagnosticNavigation(diagnosticPrev, -1);
  bindDiagnosticNavigation(diagnosticNext, 1);

  textarea.addEventListener("beforeinput", (event) => {
    const inputType = String(event.inputType || "");
    if (!["historyUndo", "historyRedo"].includes(inputType)) return;
    controller.suppressAutocomplete = true;
    controller.closeMenu();
  });
  textarea.addEventListener("input", (event) => {
    controller.commit();
    const inputType = String(event.inputType || "");
    if (controller.applyingCompletion) {
      controller.closeMenu();
      controller.updateHint();
      return;
    }
    if (["historyUndo", "historyRedo"].includes(inputType)) {
      controller.suppressAutocomplete = true;
      controller.closeMenu();
      controller.updateHint();
      return;
    }
    controller.suppressAutocomplete = false;
    controller.syncMenu(false);
  });
  textarea.addEventListener("click", () => {
    const start = Number(textarea.selectionStart) || 0;
    const end = Number(textarea.selectionEnd) || start;
    if (start !== end) {
      controller.suppressAutocomplete = true;
      controller.closeMenu();
      controller.updateHint();
      return;
    }
    controller.suppressAutocomplete = false;
    controller.syncMenu();
  });
  textarea.addEventListener("select", () => {
    if (controller.menuNavigationActive) return;
    if (controller.trigger?.kind === "starter" && textarea.value === controller.trigger.sourceText) return;
    if (["reference-followup", "guide-target"].includes(controller.trigger?.kind)
      && textarea.selectionStart === controller.trigger.start
      && textarea.selectionEnd === controller.trigger.end) return;
    const state = controller.getState();
    const placeholder = editorPlaceholderAtSelection(textarea);
    if (placeholder) {
      controller.suppressAutocomplete = false;
      controller.updateHint(state, placeholder);
      controller.openSelectedPlaceholderChoices(state, placeholder);
      return;
    }
    controller.suppressAutocomplete = true;
    controller.closeMenu();
    controller.updateHint(state, null);
  });

  const isolateEditingShortcut = (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = String(event.key || "").toLowerCase();
    if (!modifier || !["z", "y", "a", "c", "x", "v"].includes(key)) return;
    if (key === "z" || key === "y") {
      controller.suppressAutocomplete = true;
      controller.closeMenu();
    }
    event.stopImmediatePropagation();
  };
  textarea.addEventListener("keydown", isolateEditingShortcut, true);
  textarea.addEventListener("keyup", isolateEditingShortcut, true);

  textarea.addEventListener("keydown", (event) => {
    const hasMenu = Boolean(controller.trigger?.options?.length);
    const hasSelectableMenuItem = controller.selectableIndices.length > 0;
    if (hasMenu) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); controller.menuNavigationActive = false; controller.suppressAutocomplete = true; controller.closeMenu(); return; }
      if (event.key === "ArrowDown" && hasSelectableMenuItem) { event.preventDefault(); event.stopPropagation(); controller.menuNavigationActive = true; moveMenuSelection(controller, 1); return; }
      if (event.key === "ArrowUp" && hasSelectableMenuItem) { event.preventDefault(); event.stopPropagation(); controller.menuNavigationActive = true; moveMenuSelection(controller, -1); return; }
      if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.metaKey && hasSelectableMenuItem) {
        event.preventDefault();
        event.stopPropagation();
        controller.choose(controller.menuIndex);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && hasSelectableMenuItem) {
        event.preventDefault();
        event.stopPropagation();
        // Custom is deliberately first/default. Clicking/Enter on it removes the
        // current placeholder and leaves the caret there for free-form typing.
        // An untouched default Custom + Tab means "skip to next field" so normal
        // keyboard traversal does not erase fields accidentally.
        if (tabShouldAdvancePastUntouchedCustom(controller)) {
          const state = controller.getState();
          controller.closeMenu();
          if (selectAdjacentEditorPlaceholder(textarea, 1)) {
            controller.suppressAutocomplete = false;
            const placeholder = editorPlaceholderAtSelection(textarea);
            controller.updateHint(state, placeholder);
            controller.openSelectedPlaceholderChoices(state, placeholder);
          } else {
            controller.suppressAutocomplete = true;
            controller.updateHint(state, null);
          }
          return;
        }
        controller.choose(controller.menuIndex);
        return;
      }
    }

    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const state = controller.getState();
      if (!event.shiftKey && starterTemplateAvailable(textarea)) {
        controller.suppressAutocomplete = false;
        controller.closeMenu();
        controller.openStarterTemplates(state);
        return;
      }
      const direction = event.shiftKey ? -1 : 1;
      if (selectAdjacentEditorPlaceholder(textarea, direction)) {
        controller.suppressAutocomplete = false;
        controller.closeMenu();
        const placeholder = editorPlaceholderAtSelection(textarea);
        controller.updateHint(state, placeholder);
        controller.openSelectedPlaceholderChoices(state, placeholder);
        return;
      }
      // Keep focus inside the editor even after the final field. Tab is an
      // editor command here, never browser focus navigation.
      controller.suppressAutocomplete = true;
      controller.closeMenu();
      controller.updateHint(state, null);
      return;
    }

    if (!hasMenu && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      controller.suppressAutocomplete = true;
      controller.closeMenu();
    }
  });
  textarea.addEventListener("keyup", (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
    if (controller.menuNavigationActive && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.stopPropagation();
      controller.menuNavigationActive = false;
      return;
    }
    // Keydown closes stale results before the browser moves the caret. Re-open
    // after the move when the caret actually lands inside a known {field}.
    controller.suppressAutocomplete = false;
    controller.syncMenu();
  });
  textarea.addEventListener("blur", () => {
    queueMicrotask(() => { if (!wrapper.contains(document.activeElement)) controller.closeMenu(); });
  });

  // Middle-mouse drag remains a canvas-pan passthrough, not an editor control.
  textarea.addEventListener("pointerdown", (event) => {
    if (event.button !== 1 || !app.canvas?.processMouseDown) return;
    event.preventDefault();
    textarea.blur();
    controller.cancelCanvasPan?.();
    app.canvas.processMouseDown(event);

    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel, true);
      if (controller.cancelCanvasPan === cleanup) controller.cancelCanvasPan = null;
    };
    const move = (e) => app.canvas?.processMouseMove?.(e);
    const finish = (e) => { app.canvas?.processMouseUp?.(e); cleanup(); };
    const cancel = () => cleanup();
    controller.cancelCanvasPan = cleanup;

    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel, true);
  });

  return controller;
}


function findNativePromptWidget(node) {
  return (node?.widgets || []).find((widget) => widgetNameMatches(widget?.name, "prompt") && widget?.type !== PROMPT_WIDGET) || null;
}

function repairPathologicalNodeSize(node) {
  const currentWidth = Number(node?.size?.[0]);
  const currentHeight = Number(node?.size?.[1]);
  // v2.0.40/41 could persist viewport-scale dimensions when the prompt DOM
  // widget failed during layout. Only clamp clearly pathological dimensions;
  // normal user resizing stays untouched.
  const badWidth = Number.isFinite(currentWidth) && currentWidth > 1200;
  const badHeight = Number.isFinite(currentHeight) && currentHeight > 900;
  if (!badWidth && !badHeight) return false;

  let targetWidth = Number.isFinite(currentWidth) ? currentWidth : 760;
  let targetHeight = Number.isFinite(currentHeight) ? currentHeight : 520;
  if (badWidth) targetWidth = 760;
  if (badHeight) targetHeight = 520;

  const nextSize = [targetWidth, targetHeight];
  if (typeof node?.setSize === "function") node.setSize(nextSize);
  else if (node?.size) node.size = nextSize;
  return true;
}

function hideNativePromptWidget(controller) {
  const widget = controller?.nativePromptWidget;
  if (!widget || widget.__h3EasyNativePromptHidden) return;
  widget.__h3EasyNativePromptHidden = true;
  widget.__h3EasyNativePromptHiddenBefore = widget.hidden;
  widget.hidden = true;
}

function restoreNativePromptWidget(controller) {
  const widget = controller?.nativePromptWidget;
  if (!widget?.__h3EasyNativePromptHidden) return;
  const previous = widget.__h3EasyNativePromptHiddenBefore;
  if (previous === undefined) delete widget.hidden;
  else widget.hidden = previous;
  delete widget.__h3EasyNativePromptHiddenBefore;
  delete widget.__h3EasyNativePromptHidden;
}

function installPromptEditorForNode(node) {
  if (!node || node.comfyClass !== NODE_CLASS) return null;
  const existing = controllers.get(node);
  if (existing) return existing;
  const nativePromptWidget = findNativePromptWidget(node);
  if (!nativePromptWidget) {
    console.warn("[MiniMax H3 Easy] Native prompt STRING widget was not found; leaving the node on ComfyUI's fallback UI.", node);
    return null;
  }

  let controller = null;
  let widget = null;
  try {
    controller = makeController(node, nativePromptWidget);
    widget = node.addDOMWidget("__h3_easy_prompt_editor", PROMPT_WIDGET, controller.wrapper, {
      getValue: () => String(nativePromptWidget.value ?? ""),
      setValue: (value) => {
        nativePromptWidget.value = String(value ?? "");
        controller.syncFromNative(true);
        controller.scheduleRefresh(0);
      },
      getMinHeight: () => 300 + (controller?.menuOpen ? MENU_LAYOUT_HEIGHT : 0),
      getMaxHeight: () => 780,
      getHeight: () => 340 + (controller?.menuOpen ? MENU_LAYOUT_HEIGHT : 0),
      hideOnZoom: false,
      selectOn: ["focus", "click"],
      serialize: false,
    });
    widget.serialize = false;
    if (widget.options) widget.options.serialize = false;
    controller.widget = widget;
    controllers.set(node, controller);
    applyFriendlyWidgetLabels(node);
    applyFriendlyInputLabels(node);
    repairCoreWidgetDefaults(node);
    controller.invalidateExternalState();
    installPromptFirstLayout(node, controller);
    attachNodeObservers(node, controller);
    hideNativePromptWidget(controller);
    repairPathologicalNodeSize(node);
    controller.syncFromNative(true);
    controller.scheduleRefresh(0);
    return controller;
  } catch (error) {
    console.error("[MiniMax H3 Easy] Prompt editor enhancement failed; keeping the native ComfyUI prompt widget usable.", error);
    if (controller?.dispose) controller.dispose();
    else {
      controller?.disposeLayout?.();
      restoreNativePromptWidget(controller);
      controllers.delete(node);
    }
    if (widget && Array.isArray(node.widgets)) {
      const index = node.widgets.indexOf(widget);
      if (index >= 0) node.widgets.splice(index, 1);
    }
    controller?.wrapper?.remove?.();
    return null;
  }
}

function graphContainsLink(graph, linkId) {
  if (linkId == null || !graph) return false;
  const candidates = [graph.links, graph._links];
  for (const links of candidates) {
    if (!links) continue;
    if (links instanceof Map) {
      if (links.has(linkId) || links.has(String(linkId))) return true;
      continue;
    }
    if (Array.isArray(links)) {
      if (links.some((link) => link && (link.id === linkId || link[0] === linkId))) return true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(links, linkId) || Object.prototype.hasOwnProperty.call(links, String(linkId))) return true;
  }
  return false;
}

function clearDanglingInputLinks(node) {
  const graph = node?.graph;
  if (!graph || !Array.isArray(node?.inputs)) return false;
  let repaired = false;
  for (const input of node.inputs) {
    const linkId = input?.link;
    if (linkId == null || typeof linkId === "object") continue;
    if (graphContainsLink(graph, linkId)) continue;
    input.link = null;
    repaired = true;
  }
  return repaired;
}

function scheduleWidgetRefresh(node, controller) {
  clearTimeout(controller?.widgetRefreshTimer);
  if (!controller) return;
  controller.widgetRefreshTimer = window.setTimeout(() => {
    controller.widgetRefreshTimer = null;
    refreshControllerFromNode(node, true);
  }, WIDGET_REFRESH_DELAY);
}

function scheduleSettledConnectionRefresh(node, controller, repairDangling = false) {
  clearTimeout(controller?.widgetRefreshTimer);
  clearTimeout(controller?.connectionRefreshTimer);
  if (!controller) return;
  controller.widgetRefreshTimer = null;
  controller.connectionRefreshTimer = window.setTimeout(() => {
    controller.connectionRefreshTimer = null;
    const repaired = repairDangling ? clearDanglingInputLinks(node) : false;
    refreshControllerFromNode(node, true);
    if (repaired) node.graph?.setDirtyCanvas?.(true, false);
  }, 0);
}

function refreshControllerFromNode(node, redraw = true) {
  const controller = controllers.get(node);
  if (!controller || controller.externalRefreshActive) return;
  controller.externalRefreshActive = true;
  try {
    controller.syncFromNative?.();
    applyFriendlyInputLabels(node);
    controller.invalidateExternalState();
    syncLayoutWidgetVisibility(node, controller, controller.getState());
  } finally {
    controller.externalRefreshActive = false;
  }
  if (redraw) node.graph?.setDirtyCanvas?.(true, false);
  controller.scheduleRefresh(0);
}

function attachNodeObservers(node, controller) {
  if (node.__h3EasyV4ObserverDispose) return;

  const previousChanged = node.onWidgetChanged;
  const previousConnections = node.onConnectionsChange;
  const previousRemoved = node.onRemoved;

  const changed = function (...args) {
    const result = previousChanged?.apply(this, args);
    scheduleWidgetRefresh(this, controller);
    return result;
  };
  const connections = function (...args) {
    const result = previousConnections?.apply(this, args);
    const connected = args[2];
    // Refresh after native Autogrow settles. Only repair dangling link ids on
    // an actual disconnect; doing that during connection creation can race the
    // graph link store and erase a newly-created Reference connection.
    scheduleSettledConnectionRefresh(this, controller, connected === false);
    return result;
  };

  const dispose = (restoreRemoved = true) => {
    const ctl = controllers.get(node);
    ctl?.cancelCanvasPan?.();
    ctl?.setMenuOpen?.(false);
    clearTimeout(ctl?.refreshTimer);
    clearTimeout(ctl?.widgetRefreshTimer);
    clearTimeout(ctl?.connectionRefreshTimer);
    ctl?.disposeLayout?.();
    ctl?.menu?.remove?.();
    restoreNativePromptWidget(ctl);
    controllers.delete(node);
    if (node.onWidgetChanged === changed) node.onWidgetChanged = previousChanged;
    if (node.onConnectionsChange === connections) node.onConnectionsChange = previousConnections;
    if (restoreRemoved && node.onRemoved === removed) node.onRemoved = previousRemoved;
    delete node.__h3EasyV4ObserverDispose;
  };

  const removed = function (...args) {
    dispose(false);
    if (this.onRemoved === removed) this.onRemoved = previousRemoved;
    return previousRemoved?.apply(this, args);
  };

  node.onWidgetChanged = changed;
  node.onConnectionsChange = connections;
  node.onRemoved = removed;
  node.__h3EasyV4ObserverDispose = dispose;
  controller.dispose = dispose;
}


app.registerExtension({
  name: EXTENSION,
  beforeConfigureGraph(workflow) {
    migrateRemovedCompiledPromptOutput(workflow);
    preserveLegacyModelSelection(workflow);
    migrateRemovedAudioModelInput(workflow);
    migrateRemovedAdvancedSelector(workflow);
    migrateRemovedAudioProxyCanvas(workflow);
    migrateV2IntentMode(workflow);
    migrateLegacyWorkflow(workflow);
    for (const item of workflow?.nodes || []) {
      if (item?.type !== NODE_CLASS || !Array.isArray(item?.size)) continue;
      const width = Number(item.size[0]);
      const height = Number(item.size[1]);
      if (Number.isFinite(width) && width > 1200) item.size[0] = 760;
      if (Number.isFinite(height) && height > 900) item.size[1] = 520;
    }
  },
  afterConfigureGraph() {
    for (const node of app.graph?._nodes || []) {
      if (node?.comfyClass !== NODE_CLASS) continue;
      const controller = installPromptEditorForNode(node);
      repairCoreWidgetDefaults(node);
      applyFriendlyWidgetLabels(node);
      applyFriendlyInputLabels(node);
      if (controller) {
        controller.syncFromNative(true);
        controller.invalidateExternalState();
        controller.scheduleRefresh(0);
      }
    }
    if (!legacyMigrationCount) return;
    const message = `MiniMax H3 Easy v2 upgraded ${legacyMigrationCount} legacy node${legacyMigrationCount === 1 ? "" : "s"}. Reconnect legacy Media references once; v2 uses real typed Autogrow sockets.`;
    console.warn(`[MiniMax H3 Easy] ${message}`);
    app.extensionManager?.toast?.add?.({ severity: "warn", summary: "MiniMax H3 Easy v2", detail: message, life: 9000 });
    legacyMigrationCount = 0;
  },
  nodeCreated(node) {
    if (node.comfyClass !== NODE_CLASS) return;
    // Enhance only after ComfyUI has successfully constructed the native node.
    // If this editor setup fails, installPromptEditorForNode restores/leaves the
    // built-in STRING widget instead of aborting node creation.
    const controller = installPromptEditorForNode(node);
    repairCoreWidgetDefaults(node);
    applyFriendlyWidgetLabels(node);
    applyFriendlyInputLabels(node);
    if (controller) {
      controller.syncFromNative();
      controller.invalidateExternalState();
      controller.scheduleRefresh(0);
    }
  },
  loadedGraphNode(node) {
    if (node.comfyClass !== NODE_CLASS) return;
    const controller = installPromptEditorForNode(node);
    controller?.syncFromNative?.(true);
    controller?.invalidateExternalState?.();
    controller?.scheduleRefresh?.(0);
  },
});
