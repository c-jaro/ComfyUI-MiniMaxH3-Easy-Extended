import { H3E_DEFAULTS, H3E_VALUES } from "./h3_defaults.js";
import {
  AUDIO_RETENTION,
  BASE_SECTIONS,
  EDITOR_PLACEHOLDER_HELP,
  KEYFRAME_FIRST,
  KEYFRAME_LAST,
  KEYFRAME_CANVAS_ADAPTIVE,
  MODE_VIDEO,
  MODE_AUDIO,
  PROFILE,
  REF_SECTIONS,
  TASK_TYPES,
  VISUAL_RETENTION,
} from "./h3_guidelines.js";

const TASK_SET = new Set(TASK_TYPES.map(([value]) => value));
const VISUAL_RETENTION_SET = new Set(VISUAL_RETENTION.map(([value]) => value));
const AUDIO_RETENTION_SET = new Set(AUDIO_RETENTION.map(([value]) => value));
const MEDIA_ALIAS_RE = /@(Image|Video|Audio|Subject)(\d+)\b/gi;
const ANGLE_IMAGE_ALIAS_RE = /<Image\s+(\d+)>/gi;
const MEDIA_ANY_RE = /@(Image|Video|Audio|Subject)(\d+)\b|<(Picture|Image|Video|Audio|Subject)\s+(\d+)>/gi;

function referencePattern(kind, ordinal) {
  const alias = kind === "image" ? "Image" : kind[0].toUpperCase() + kind.slice(1);
  const native = kind === "image" ? "(?:Picture|Image)" : alias;
  return `(?:@${alias}${ordinal}\\b|<${native}\\s+${ordinal}>)`;
}

function suffixMatch(name, suffix) {
  const value = String(name || "");
  return value === suffix || value.endsWith(`.${suffix}`) || value.endsWith(`:${suffix}`) || value.endsWith(`/${suffix}`);
}

export function findWidget(node, suffix) {
  return node?.widgets?.find((widget) => suffixMatch(widget?.name, suffix)) || null;
}

export function widgetValue(node, suffix, fallback = undefined) {
  const widget = findWidget(node, suffix);
  return widget?.value ?? fallback;
}

function inputLeafName(name) {
  const value = String(name || "");
  const leaf = value.split(/[.:/]/).at(-1);
  return leaf || value;
}

function inputOrdinal(name, prefix) {
  // V3 Autogrow inputs are represented as dotted paths such as
  // "ref_images.ref_image_2" even though the visible socket is "ref_image_2".
  const value = inputLeafName(name);
  if (!value.startsWith(prefix)) return Number.POSITIVE_INFINITY;
  const suffix = value.slice(prefix.length);
  return /^\d+$/.test(suffix) ? Number(suffix) : Number.POSITIVE_INFINITY;
}

export function connectedInputs(node, prefix) {
  return (node?.inputs || [])
    .filter((input) => input?.link != null && Number.isFinite(inputOrdinal(input?.name, prefix)))
    .sort((a, b) => inputOrdinal(a.name, prefix) - inputOrdinal(b.name, prefix));
}

function trailingOrdinal(name) {
  const value = String(name || "");
  let start = value.length;
  while (start > 0) {
    const code = value.charCodeAt(start - 1);
    if (code < 48 || code > 57) break;
    start -= 1;
  }
  return start < value.length ? value.slice(start) : null;
}

function pairedAudioDescriptors(videos, paired, standalone) {
  const bySuffix = new Map(paired.map((input) => [trailingOrdinal(input.name), input]));
  const result = [];
  let audioOrdinal = 0;
  videos.forEach((video, videoIndex) => {
    const suffix = trailingOrdinal(video.name);
    if (suffix != null && bySuffix.has(suffix)) {
      audioOrdinal += 1;
      result.push({ token: `@Audio${audioOrdinal}`, kind: "audio", ordinal: audioOrdinal, inputName: bySuffix.get(suffix)?.name || null, detail: `Soundtrack paired with @Video${videoIndex + 1}.` });
    }
  });
  standalone.forEach((input) => {
    audioOrdinal += 1;
    result.push({ token: `@Audio${audioOrdinal}`, kind: "audio", ordinal: audioOrdinal, inputName: input.name, detail: "Standalone reference audio." });
  });
  return result;
}

function roundHalfEvenPositive(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function alignFrameCount(n) {
  const value = Math.max(5, roundHalfEvenPositive(n));
  const remainder = ((value - 5) % 17 + 17) % 17;
  return value + ((17 - remainder) % 17);
}

export function effectiveTiming(seconds) {
  const numeric = Number(seconds);
  // Keep the editor responsive even if a malformed/programmatic workflow value
  // bypasses the numeric widget. Backend validation still rejects values outside
  // the node's 1-30 second execution range.
  const safeSeconds = Number.isFinite(numeric) && numeric >= 1 && numeric <= 30 ? numeric : H3E_DEFAULTS.seconds;
  // Python's round() is ties-to-even; mirror it so the frontend preview cannot
  // disagree with runtime.requested_length() on a programmatic exact .5 frame.
  const requested = Math.max(5, roundHalfEvenPositive(safeSeconds * 24));
  const frames = alignFrameCount(requested);
  return { requested, frames, seconds: frames / 24 };
}

export function shotMarkers(prompt) {
  const source = String(prompt || "");
  const re = /^[ \t]*\[Shot\s+(\d+)\](?:[ \t]+At[ \t]+(\d{2}):(\d{2})\.(\d{3}),)?/gim;
  const out = [];
  for (const match of source.matchAll(re)) {
    const hasTime = match[2] != null;
    const time = hasTime ? Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : null;
    out.push({
      number: Number(match[1]),
      time,
      index: match.index || 0,
      end: (match.index || 0) + match[0].length,
      text: match[0],
    });
  }
  return out;
}

export function finalShotNumber(prompt) {
  const shots = shotMarkers(prompt);
  return shots.length ? shots.at(-1).number : 1;
}

function sectionRanges(prompt, sections) {
  const source = String(prompt || "");
  const found = sections.map((name) => {
    // Horizontal whitespace only. \s* can consume newlines and make the
    // recorded header range start on a preceding blank line.
    const re = new RegExp(`^[ \t]*${name}[ \t]*:[ \t]*`, "im");
    const match = re.exec(source);
    return { name, index: match?.index ?? -1, headerEnd: match ? match.index + match[0].length : -1 };
  });
  const present = found.filter((entry) => entry.index >= 0).sort((a, b) => a.index - b.index);
  return found.map((entry) => {
    if (entry.index < 0) return { ...entry, bodyStart: -1, bodyEnd: -1, body: "" };
    const next = present.find((candidate) => candidate.index > entry.index);
    const end = next?.index ?? source.length;
    return { ...entry, bodyStart: entry.headerEnd, bodyEnd: end, body: source.slice(entry.headerEnd, end).trim() };
  });
}


function sectionMap(prompt, sections) {
  return Object.fromEntries(sectionRanges(prompt, sections).map((entry) => [entry.name, entry]));
}

function issue(title, message, example, range = null, code = "") {
  return { severity: "required", title, message, example, range, code };
}

function note(title, message, range = null, code = "") {
  return { severity: "note", title, message, range, code };
}

function sectionIssues(prompt, sections) {
  const source = String(prompt || "");
  const ranges = sectionRanges(source, sections);
  const issues = [];
  let previousIndex = -1;
  for (const entry of ranges) {
    if (entry.index < 0) {
      issues.push(issue(
        `Missing ${entry.name}:`,
        `The active H3 prompt grammar requires the ${entry.name}: section.`,
        `${entry.name}:\n...`,
        { start: 0, end: 0 },
        `missing-section:${entry.name}`,
      ));
      continue;
    }
    if (entry.index < previousIndex) {
      issues.push(issue(
        "Sections are out of order",
        `Use the official section order: ${sections.map((x) => `${x}:`).join(" → ")}`,
        sections.map((x) => `${x}:`).join("\n\n"),
        { start: entry.index, end: entry.headerEnd },
        "section-order",
      ));
      break;
    }
    previousIndex = entry.index;
    const duplicateMatches = [...source.matchAll(new RegExp(`^[ \t]*${entry.name}[ \t]*:`, "gim"))];
    if (duplicateMatches.length > 1) {
      const duplicate = duplicateMatches[1];
      issues.push(issue(
        `Duplicate ${entry.name}: section`,
        `The H3 structure uses exactly one ${entry.name}: section.`,
        `Keep a single ${entry.name}: section and merge its content.`,
        { start: duplicate.index || 0, end: (duplicate.index || 0) + duplicate[0].length },
        `duplicate-section:${entry.name}`,
      ));
    }
    if (!entry.body) {
      issues.push(issue(
        `${entry.name}: is empty`,
        `Fill the mandatory ${entry.name}: section.`,
        `${entry.name}:\n...`,
        { start: entry.index, end: entry.headerEnd },
        `empty-section:${entry.name}`,
      ));
    }
  }
  return issues;
}

function taskPrefix(summary) {
  const match = String(summary || "").match(/^\s*\[([^\]]+)\]/);
  if (!match) return null;
  return match[1].split("+").map((value) => value.trim()).filter(Boolean);
}

function tokensIn(text) {
  const result = [];
  for (const match of String(text || "").matchAll(MEDIA_ANY_RE)) {
    const native = match[3] != null;
    const rawKind = String(native ? match[3] : match[1]).toLowerCase();
    const kind = rawKind === "picture" || rawKind === "image" ? "image" : rawKind;
    const ordinal = Number(native ? match[4] : match[2]);
    result.push({ kind, ordinal, token: match[0], index: match.index || 0, native });
  }
  return result;
}

function referenceTokenIssue(state, token, offset = 0) {
  if (token.ordinal <= 0) {
    return issue(`${token.token} is invalid`, "H3 reference numbering is 1-based.", `Use @${token.kind[0].toUpperCase()}${token.kind.slice(1)}1 or higher.`, { start: offset + token.index, end: offset + token.index + token.token.length }, "invalid-reference-ordinal");
  }
  if (token.kind === "subject") return null;
  const limit = token.kind === "image" ? state.imageCount : token.kind === "video" ? state.videoCount : state.audioCount;
  if (token.ordinal > limit) {
    const title = `${token.token} is not connected`;
    const routeLabel = state.conditioningProfile === PROFILE.REF2VA ? "Reference conditioning" : "endpoint/base conditioning";
    const message = `Only ${limit} ${token.kind} reference${limit === 1 ? " is" : "s are"} currently available on the active ${routeLabel} route.`;
    return issue(title, message, `Connect the matching reference or remove ${token.token}.`, { start: offset + token.index, end: offset + token.index + token.token.length }, "unresolved-reference");
  }
  return null;
}

export function firstLineForState(state, prompt = "") {
  const finalShot = Math.max(1, finalShotNumber(prompt));
  const seconds = state.effectiveSeconds.toFixed(2);
  if (state.editorProfile === PROFILE.I2VA) {
    return "For the target video, at 0.00 seconds into the target video, @Image1 (from [Shot 1]) is fully referenced.";
  }
  if (state.editorProfile === PROFILE.L2VA) {
    return `How the reference pictures align with the target video — @Image1 (from [Shot ${finalShot}]) aligns with the ${seconds}-second mark of the target video.`;
  }
  if (state.editorProfile === PROFILE.FL2VA) {
    return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${finalShot}) aligns with the ${seconds}-second mark of the target video.`;
  }
  return "";
}

export function compilePromptPreview(prompt, state) {
  const source = String(prompt || "").replace(ANGLE_IMAGE_ALIAS_RE, (_full, ordinalRaw) => `@Image${Number(ordinalRaw)}`);
  const pictureMap = state.conditioningProfile === PROFILE.FL2VA && state.keyframeRole === KEYFRAME_LAST ? new Map([[1, 2], [2, 1]]) : new Map([[1, 1], [2, 2]]);
  return source.replace(MEDIA_ALIAS_RE, (full, kindRaw, ordinalRaw) => {
    const kind = String(kindRaw).toLowerCase();
    const ordinal = Number(ordinalRaw);
    if (ordinal <= 0) return full;

    if (state.conditioningProfile !== PROFILE.REF2VA) {
      if (kind !== "image" || ordinal > state.imageCount) return full;
      const mapped = pictureMap.get(ordinal);
      return mapped ? `<Picture ${mapped}>` : full;
    }

    // Keep the preview failure-transparent: physical media compile only when the
    // corresponding socket exists, exactly like the backend. Subjects are semantic
    // labels and therefore need no physical socket.
    if (kind === "subject") return `<Subject ${ordinal}>`;
    const limit = kind === "image" ? state.imageCount : kind === "video" ? state.videoCount : kind === "audio" ? state.audioCount : 0;
    if (ordinal > limit) return full;
    if (kind === "image") return `<Picture ${ordinal}>`;
    if (kind === "video") return `<Video ${ordinal}>`;
    if (kind === "audio") return `<Audio ${ordinal}>`;
    return full;
  });
}

function referenceDescriptors(images, videos, pairedAudio, standaloneAudio) {
  const imageRefs = images.map((input, index) => ({ token: `@Image${index + 1}`, kind: "image", ordinal: index + 1, inputName: input.name, detail: "Reference picture." }));
  const videoRefs = videos.map((input, index) => ({ token: `@Video${index + 1}`, kind: "video", ordinal: index + 1, inputName: input.name, detail: "Reference video frame batch." }));
  return [...imageRefs, ...videoRefs, ...pairedAudioDescriptors(videos, pairedAudio, standaloneAudio)];
}

function canonicalModeValue(value) {
  const raw = String(value ?? "");
  if ([
    "Full Reference (REF2VA)",
    "References (REF2VA)",
    "Reference conditioning",
    "Base / Keyframes (T2VA/I2VA/FL2VA/L2VA)",
    "Text / first-last frames (T2VA / I2VA / L2VA / FL2VA)",
    MODE_VIDEO,
  ].includes(raw)) return MODE_VIDEO;
  if ([
    "Audio-first",
    "Audio-first proxy (T2A / A2A / V2A)",
    "Audio-first proxy (T2A / I2A / V2A / A2A)",
    MODE_AUDIO,
  ].includes(raw)) return MODE_AUDIO;
  return raw;
}

function canonicalKeyframeRoleValue(value) {
  const raw = String(value ?? "");
  if (raw === "Image 1 = first frame") return KEYFRAME_FIRST;
  if (raw === "Image 1 = last frame") return KEYFRAME_LAST;
  return raw;
}

function canonicalKeyframeCanvasValue(value) {
  const raw = String(value ?? "");
  if (raw === "Adaptive to keyframe (recommended)" || raw === "First/last frame image") return KEYFRAME_CANVAS_ADAPTIVE;
  if (raw === "Use selected canvas aspect") return "Aspect ratio setting";
  if (raw === "Aspect ratio control") return "Aspect ratio setting";
  return raw;
}

const PROMPT_FAMILY_BASE = "base";
const PROMPT_FAMILY_REFERENCE = "reference";
const PROMPT_OUTPUT_AUDIO = "audio";

// Prompt grammar and conditioning inputs are independent signals. The prompt
// itself is authoritative for which editor grammar/validator should be active
// once it contains a distinctive H3 top-level structure. Physical connections
// remain authoritative for which conditioning route execution will take.
export function inferPromptStructure(prompt = "") {
  const source = String(prompt || "").replace(/^\uFEFF/, "");
  const trimmed = source.trimStart();
  if (!trimmed) return { family: null, profileHint: null, conflict: false, marker: null, outputIntent: null, outputMarker: null };

  const markers = [];
  const addMatches = (regex, family, marker) => {
    for (const match of source.matchAll(regex)) markers.push({ index: match.index || 0, family, marker });
  };
  addMatches(/^[ \t]*integrated_multimodal_description[ \t]*:/gim, PROMPT_FAMILY_BASE, "integrated_multimodal_description:");
  addMatches(/^[ \t]*subject_definitions[ \t]*:/gim, PROMPT_FAMILY_REFERENCE, "subject_definitions:");
  addMatches(/^[ \t]*(?:summary|retention_analysis|detailed_description)[ \t]*:/gim, PROMPT_FAMILY_REFERENCE, "REF section");

  const firstLine = trimmed.split("\n", 1)[0].trim();
  if (/^For the target video, at 0\.00 seconds into the target video,/i.test(firstLine)) {
    markers.push({ index: source.indexOf(firstLine), family: PROMPT_FAMILY_BASE, marker: "I2VA opening alignment" });
  } else if (/^How the reference pictures align with the target video/i.test(firstLine)) {
    markers.push({ index: source.indexOf(firstLine), family: PROMPT_FAMILY_BASE, marker: "endpoint alignment" });
  }

  const audioSignature = /(?:the proxy video remains visually minimal and static(?:\s*[.;]\s*audio is the intended output\.)?|audio is the intended output)/i.exec(source);
  const outputIntent = audioSignature ? PROMPT_OUTPUT_AUDIO : null;
  const outputMarker = audioSignature ? "Easy audio-proxy template" : null;

  if (!markers.length) return { family: null, profileHint: null, conflict: false, marker: null, outputIntent, outputMarker };
  markers.sort((a, b) => a.index - b.index);
  const families = new Set(markers.map((entry) => entry.family));
  const first = markers[0];
  let profileHint = null;
  if (first.family === PROMPT_FAMILY_REFERENCE) {
    profileHint = PROFILE.REF2VA;
  } else if (/^For the target video, at 0\.00 seconds into the target video,/i.test(firstLine)) {
    profileHint = PROFILE.I2VA;
  } else if (/^How the reference pictures align with the target video/i.test(firstLine)) {
    const hasSecondEndpoint = /(?:@Image2\b|<(?:Picture|Image)\s+2>)/i.test(firstLine);
    profileHint = hasSecondEndpoint ? PROFILE.FL2VA : PROFILE.L2VA;
  } else {
    profileHint = PROFILE.T2VA;
  }
  return {
    family: first.family,
    profileHint,
    conflict: families.size > 1,
    marker: first.marker,
    outputIntent,
    outputMarker,
  };
}

export function nodeState(node, prompt = "") {
  const mode = canonicalModeValue(widgetValue(node, "mode", H3E_DEFAULTS.mode));
  const keyframeRole = canonicalKeyframeRoleValue(widgetValue(node, "keyframe_role", H3E_DEFAULTS.keyframeRole));
  const keyframeCanvas = canonicalKeyframeCanvasValue(widgetValue(node, "keyframe_canvas", H3E_DEFAULTS.keyframeCanvas));
  const canvasMode = String(widgetValue(node, "canvas", H3E_DEFAULTS.canvas));
  const keyframes = connectedInputs(node, "keyframe_");
  const imageInputs = connectedInputs(node, "ref_image_");
  const videoInputs = connectedInputs(node, "ref_video_");
  const pairedAudioInputs = connectedInputs(node, "ref_video_audio_");
  const standaloneAudioInputs = connectedInputs(node, "ref_audio_");
  const refs = referenceDescriptors(imageInputs, videoInputs, pairedAudioInputs, standaloneAudioInputs);
  const imageCount = imageInputs.length;
  const videoCount = videoInputs.length;
  const audioCount = refs.filter((ref) => ref.kind === "audio").length;
  const standaloneAudioCount = standaloneAudioInputs.length;
  const pairedAudioCount = Math.max(0, audioCount - standaloneAudioCount);
  const videoSuffixes = new Set(videoInputs.map((input) => trailingOrdinal(input.name)).filter(Boolean));
  const orphanPairedAudioNames = pairedAudioInputs
    .filter((input) => !videoSuffixes.has(trailingOrdinal(input.name)))
    .map((input) => String(input.name));
  const requestedSeconds = Number(widgetValue(node, "seconds", H3E_DEFAULTS.seconds));
  const timing = effectiveTiming(requestedSeconds);
  const playbackFps = 24;
  const refVideoFpsRawValues = [
    Number(widgetValue(node, "ref_video_fps", H3E_DEFAULTS.refVideoFps)),
    Number(widgetValue(node, "ref_video_fps_2", H3E_DEFAULTS.refVideoFpsOverride)),
    Number(widgetValue(node, "ref_video_fps_3", H3E_DEFAULTS.refVideoFpsOverride)),
  ].slice(0, videoCount);
  const refVideoFps = refVideoFpsRawValues[0] ?? H3E_DEFAULTS.refVideoFps;
  const refVideoFpsValues = refVideoFpsRawValues.map((fps, index) => index === 0 ? fps : (fps === 0 ? refVideoFps : fps));
  const refVideoSize = String(widgetValue(node, "ref_video_size", H3E_DEFAULTS.refVideoSize));
  const refVideoTemporalFit = String(widgetValue(node, "ref_video_temporal_fit", H3E_DEFAULTS.refVideoTemporalFit));

  const audioMode = mode === MODE_AUDIO;
  const hasReferenceInputs = imageCount + videoCount + standaloneAudioInputs.length + pairedAudioInputs.length > 0;
  const referenceInputKinds = [];
  if (imageCount > 0) referenceInputKinds.push("reference image");
  if (videoCount > 0) referenceInputKinds.push("reference video");
  if (pairedAudioInputs.length > 0) referenceInputKinds.push("paired reference-video audio");
  if (standaloneAudioInputs.length > 0) referenceInputKinds.push("standalone reference audio");
  let inputConditioningProfile;
  if (hasReferenceInputs) inputConditioningProfile = PROFILE.REF2VA;
  else if (keyframes.length === 0) inputConditioningProfile = PROFILE.T2VA;
  else if (keyframes.length === 1) inputConditioningProfile = keyframeRole === KEYFRAME_LAST ? PROFILE.L2VA : PROFILE.I2VA;
  else inputConditioningProfile = PROFILE.FL2VA;

  const promptStructure = inferPromptStructure(prompt);
  const promptAudioIntent = promptStructure.outputIntent === PROMPT_OUTPUT_AUDIO;
  const displayAudioMode = promptAudioIntent || audioMode;

  // Routing follows the connected conditioning inputs, not the chosen starter
  // template. If any Reference inputs are connected, execution uses REF2VA.
  // Otherwise execution uses the endpoint/base route derived from keyframes.
  // Prompt structure still drives editor assistance, validation, and the badge.
  const conditioningProfile = inputConditioningProfile;

  let editorProfile = conditioningProfile;
  if (!promptStructure.conflict && promptStructure.family === PROMPT_FAMILY_REFERENCE) {
    editorProfile = PROFILE.REF2VA;
  } else if (!promptStructure.conflict && promptStructure.family === PROMPT_FAMILY_BASE) {
    editorProfile = promptStructure.profileHint || (hasReferenceInputs ? PROFILE.T2VA : conditioningProfile);
  }

  const conditioningFamily = conditioningProfile === PROFILE.REF2VA ? PROMPT_FAMILY_REFERENCE : PROMPT_FAMILY_BASE;
  const hasMixedInputFamilies = hasReferenceInputs && keyframes.length > 0;
  const ignoredReferenceInputs = false;
  const ignoredKeyframeInputs = Boolean(hasReferenceInputs && keyframes.length > 0);
  const mixedConditioningFamilies = false;

  const referenceRouteActive = conditioningProfile === PROFILE.REF2VA;
  const physicalImageRefs = referenceRouteActive
    ? refs.filter((ref) => ref.kind === "image")
    : keyframes.map((input, index) => ({ token: `@Image${index + 1}`, kind: "image", ordinal: index + 1, inputName: input.name, detail: "Connected first/last frame image." }));

  let audioTask = null;
  if (audioMode) {
    const kinds = [];
    if (conditioningProfile === PROFILE.REF2VA) {
      if (videoCount > 0) kinds.push("V2A");
      if (imageCount > 0) kinds.push("I2A");
      if (audioCount > 0) kinds.push("A2A");
    }
    audioTask = kinds.length ? `${kinds.join("+")} proxy` : "T2A proxy";
  }

  const state = {
    mode,
    editorProfile,
    audioMode,
    audioTask,
    hasReferenceInputs,
    conditioningProfile,
    inputConditioningProfile,
    conditioningFamily,
    promptStructureFamily: promptStructure.family,
    promptStructureMarker: promptStructure.marker,
    promptStructureConflict: promptStructure.conflict,
    promptOutputIntent: promptStructure.outputIntent,
    promptOutputMarker: promptStructure.outputMarker,
    promptAudioIntent,
    displayAudioMode,
    editorProfileSource: promptStructure.family ? "prompt" : "inputs",
    routeSource: hasReferenceInputs ? "reference-inputs" : "endpoint/base-inputs",
    referenceInputKinds,
    hasMixedInputFamilies,
    mixedConditioningFamilies,
    ignoredReferenceInputs,
    ignoredKeyframeInputs,
    keyframeRole,
    keyframeCanvas,
    canvasMode,
    keyframeCount: keyframes.length,
    imageCount: referenceRouteActive ? imageCount : keyframes.length,
    videoCount: referenceRouteActive ? videoCount : 0,
    // audioCount is the presented <Audio N> namespace used by prompt validation.
    // Published input-file limits use standaloneAudioCount instead because a
    // video soundtrack belongs to the video reference object.
    audioCount: referenceRouteActive ? audioCount : 0,
    standaloneAudioCount: referenceRouteActive ? standaloneAudioCount : 0,
    pairedAudioCount: referenceRouteActive ? pairedAudioCount : 0,
    mixedRefCount: referenceRouteActive ? imageCount + videoCount + standaloneAudioInputs.length : keyframes.length,
    orphanPairedAudioNames: referenceRouteActive ? orphanPairedAudioNames : [],
    refs: referenceRouteActive ? refs : physicalImageRefs,
    requestedSeconds,
    frameCount: timing.frames,
    effectiveSeconds: timing.seconds,
    playbackFps,
    refVideoFps,
    refVideoFpsRawValues,
    refVideoFpsValues,
    refVideoSize,
    refVideoTemporalFit,
    finalShot: finalShotNumber(prompt),
  };
  return state;
}

function validateShots(prompt, state) {
  const source = String(prompt || "");
  const shots = shotMarkers(source);
  const issues = [];
  if (!shots.length) {
    issues.push(issue("Missing [Shot 1]", "The description needs an opening shot marker.", "[Shot 1] ...", { start: 0, end: 0 }, "missing-shot"));
    return issues;
  }

  // Autofill emits MiniMax's canonical punctuation. Validation focuses on
  // semantic shot structure (number/order/time/range) rather than turning
  // cosmetic separators from examples into parser-like hard requirements.

  // Shot 1 begins at 0.000 implicitly, so every later cut must be > 0.
  let previousTime = 0;
  shots.forEach((shot, index) => {
    if (shot.number !== index + 1) {
      issues.push(issue("Shot numbering is not sequential", `Expected [Shot ${index + 1}] here, found [Shot ${shot.number}].`, `[Shot ${index + 1}]`, { start: shot.index, end: shot.end }, "shot-number"));
    }
    if (index === 0 && shot.time != null) {
      issues.push(issue("[Shot 1] must not have a timestamp", "Shot 1 starts at 0.000 seconds implicitly.", "[Shot 1] ...", { start: shot.index, end: shot.end }, "shot1-time"));
    }
    if (index > 0 && shot.time == null) {
      const lineEnd = source.indexOf("\n", shot.end);
      const lineTail = source.slice(shot.end, lineEnd >= 0 ? lineEnd : source.length);
      const hasTimestampWithSeparatorProblem = /^[ \t]+At[ \t]+\d{2}:\d{2}\.\d{3}(?:[ \t]*[,;:.\-–—]?)/i.test(lineTail);
      const hasShotMarkerSeparatorProblem = /^[ \t]*[,:;.\-–—][ \t]*At[ \t]+\d{2}:\d{2}\.\d{3}/i.test(lineTail);
      const hasMissingSpaceBeforeAt = /^At[ \t]+\d{2}:\d{2}\.\d{3}/i.test(lineTail);
      if (!hasTimestampWithSeparatorProblem && !hasShotMarkerSeparatorProblem && !hasMissingSpaceBeforeAt) {
        issues.push(issue(`Missing cut time for [Shot ${shot.number}]`, "Later shots use the official '[Shot N] At MM:SS.mmm,' form.", `[Shot ${shot.number}] At 00:03.500, ...`, { start: shot.index, end: shot.end }, "shot-time"));
      }
    }
    if (shot.time != null) {
      if (shot.time <= previousTime) issues.push(issue("Shot cut times must increase", "Each later cut time must be strictly later than the previous one.", `[Shot ${shot.number}] At 00:03.500, ...`, { start: shot.index, end: shot.end }, "shot-time-order"));
      if (shot.time >= state.effectiveSeconds) issues.push(issue("Shot cut is outside the target duration", `This target snaps to ${state.effectiveSeconds.toFixed(2)} seconds.`, `Use a cut time below ${state.effectiveSeconds.toFixed(2)} seconds.`, { start: shot.index, end: shot.end }, "shot-time-range"));
      previousTime = shot.time;
    }
  });
  return issues;
}

function vocalClauseBefore(source, start) {
  const before = source.slice(0, start);
  let clauseStart = before.lastIndexOf("\n") + 1;

  // A previous dialogue block is always a hard vocal-event boundary, even when
  // multiple dialogue events are written on one physical line.
  const previousDialogue = before.toLowerCase().lastIndexOf("</d>");
  if (previousDialogue >= clauseStart) clauseStart = previousDialogue + 4;

  // Within the remaining line/event, use the latest completed sentence. This
  // avoids inheriting an (Sx) from an earlier speaker while allowing MiniMax's
  // documented long delivery descriptions between (Sx) and <d>.
  const tail = before.slice(clauseStart);
  let localBoundary = 0;
  for (const boundary of tail.matchAll(/[.!?](?:["')\]]*)\s+/g)) {
    localBoundary = (boundary.index || 0) + boundary[0].length;
  }
  return before.slice(clauseStart + localBoundary);
}

function validateDialogue(prompt, state) {
  const issues = [];
  const source = String(prompt || "");
  const timelineName = state.editorProfile === PROFILE.REF2VA ? "detailed_description" : "integrated_multimodal_description";
  const sectionNames = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
  const timeline = sectionMap(source, sectionNames)[timelineName];

  // Validate the tag structure before interpreting complete dialogue blocks. A
  // dangling <d> used to disappear from the validator because the complete-block
  // regex could never see it.
  let openTag = null;
  for (const tag of source.matchAll(/<\/?d>/gi)) {
    const index = tag.index || 0;
    const closing = /^<\/d>$/i.test(tag[0]);
    if (!closing) {
      if (openTag != null) {
        issues.push(issue("Nested <d> dialogue tag", "Finish the current <d>[Language] ...</d> block before starting another dialogue block.", "<d>[English] Spoken text.</d>", { start: index, end: index + tag[0].length }, "dialogue-nested-tag"));
      } else {
        openTag = index;
      }
    } else if (openTag == null) {
      issues.push(issue("Unmatched </d> dialogue tag", "This closing dialogue tag has no preceding <d> opening tag.", "<d>[English] Spoken text.</d>", { start: index, end: index + tag[0].length }, "dialogue-unmatched-close"));
    } else {
      openTag = null;
    }
  }
  if (openTag != null) {
    issues.push(issue("Unclosed <d> dialogue tag", "Every MiniMax dialogue/lyric block must end with </d>.", "<d>[English] Spoken text.</d>", { start: openTag, end: Math.min(source.length, openTag + 3) }, "dialogue-unclosed-tag"));
  }

  const knownSpeakers = new Set();
  let expectedSpeaker = 1;
  for (const match of source.matchAll(/<d>([\s\S]*?)<\/d>/gi)) {
    const body = String(match[1] || "").trim();
    const start = match.index || 0;
    const end = start + match[0].length;
    const inTimeline = Boolean(timeline && start >= timeline.bodyStart && start < timeline.bodyEnd);
    if (!inTimeline) {
      issues.push(issue(
        `Dialogue block is outside ${timelineName}:`,
        `Dialogue and lyrics belong on the target-video timeline inside ${timelineName}:, not in summary, retention, soundscape, or music fields.`,
        `${timelineName}:\n[Shot 1] ... (S1) says, <d>[English] Spoken text.</d>`,
        { start, end },
        "dialogue-outside-timeline",
      ));
    }

    const vocalClause = vocalClauseBefore(source, start);
    const speakerMatches = [...vocalClause.matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/gi)];
    const speakerMatch = speakerMatches.at(-1) || null;
    // A directly reused soundtrack/BGM cue may use @AudioN as the audible
    // source without inventing a speaker. This is also the one context where
    // the editor can safely infer the full-reference guide's source-audio
    // punctuation normalization without guessing dialogue provenance.
    const audioSourceMatch = state.conditioningProfile === PROFILE.REF2VA
      && /(?:@Audio\d+\b|<Audio\s+\d+>)/i.test(vocalClause)
      && /\b(?:reaches?|plays?|contains?|includes?|features?|phrase|lyrics?|words?|vocal)\b/i.test(vocalClause)
      && !/(?:@Subject\d+\b|<Subject\s+\d+>)|\(S\d+\)|\b(?:says?|speaks?|replies?|asks?|shouts?|sings?|whispers?|narrat(?:es?|or))\b/i.test(vocalClause);

    const languageMatch = body.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (!languageMatch || !String(languageMatch[1] || "").trim()) {
      issues.push(issue("Dialogue is missing [Language]", "MiniMax dialogue uses <d>[Language] spoken text</d>.", "(S1) says, <d>[English] Hello.</d>", { start, end }, "dialogue-language"));
    } else if (!String(languageMatch[2] || "").trim()) {
      issues.push(issue("Dialogue text is empty", "Inside <d>, write the language tag followed by the actual spoken or sung content.", "<d>[English] Hello.</d>", { start, end }, "dialogue-empty"));
    } else {
      const spoken = String(languageMatch[2] || "").trim();
      // Base/full-reference dialogue preserves user wording. The full-reference
      // guide adds punctuation normalization specifically for verbal content
      // directly reused/reperformed from reference audio. Only enforce that
      // when this line is unambiguously an @AudioN soundtrack cue; ordinary
      // speaker dialogue may be new text and its provenance is not inferable.
      if (audioSourceMatch && !/<(?:scenetrans|cutoff)>/i.test(spoken) && !/[.?!]$/.test(spoken)) {
        issues.push(issue(
          "Reused reference-audio dialogue needs terminal punctuation before </d>",
          "For verbal content directly reused from reference audio, MiniMax's full-reference guide standardizes complete statements/questions/exclamations to '.', '?' or '!' before </d>.",
          "@Audio1 reaches the phrase <d>[English] Hello.</d>",
          { start, end },
          "dialogue-terminal-punctuation",
        ));
      }
    }

    if (inTimeline && !speakerMatch && !audioSourceMatch) {
      issues.push(issue("Dialogue has no speaker or audio-source ID", "Identify a concrete vocal source with (S1)/(S2), or in Reference conditioning use @AudioN only when the verbal content is a cue inside directly reused reference audio.", "@Subject1 (S1) says, <d>[English] Hello.</d>", { start, end }, "dialogue-speaker"));
    } else if (inTimeline && speakerMatch) {
      const ids = [...String(speakerMatch[1]).matchAll(/S(\d+)/gi)].map((item) => Number(item[1]));
      for (const id of ids) {
        if (knownSpeakers.has(id)) continue;
        if (id !== expectedSpeaker) {
          issues.push(issue("Speaker IDs are out of first-vocal-event order", `The next new vocal source should be S${expectedSpeaker}, but this dialogue first introduces S${id}.`, `Use (S${expectedSpeaker}) for this new vocal source, then keep that ID stable in later shots.`, { start: Math.max(0, start - vocalClause.length), end: start }, "dialogue-speaker-order"));
          knownSpeakers.add(id);
          expectedSpeaker = Math.max(expectedSpeaker, id + 1);
          break;
        }
        knownSpeakers.add(id);
        expectedSpeaker += 1;
      }
    }
  }
  for (const match of source.matchAll(/says in an off-screen voiceover[^\n]*<d>[\s\S]*?<\/d>/gi)) {
    const start = match.index || 0;
    if (!timeline || start < timeline.bodyStart || start >= timeline.bodyEnd) continue;
    const end = start + match[0].length;
    const after = source.slice(end, end + 180);
    if (!/lips?[^.\n]{0,100}\bclosed\b/i.test(after)) {
      issues.push(issue("Voiceover needs closed lips", "After an off-screen voiceover line, state that the corresponding on-screen character's lips remain closed.", "@Subject1's lips remain closed.", { start: match.index || 0, end }, "voiceover-lips"));
    }
  }
  return issues;
}

function validatePhysicalReferences(prompt, state) {
  const issues = [];
  const referenceRoute = state.conditioningProfile === PROFILE.REF2VA;
  for (const token of tokensIn(prompt)) {
    if (!referenceRoute && token.kind !== "image") {
      issues.push(issue(
        `${token.token} needs connected Reference inputs`,
        "The active endpoint/base conditioning route exposes only first/last-frame Picture references. Prompt grammar does not change that physical route.",
        "Connect a Reference image/video/audio input, or remove this token.",
        { start: token.index, end: token.index + token.token.length },
        "base-reference-type",
      ));
      continue;
    }
    const unresolved = referenceTokenIssue(state, token);
    if (unresolved) issues.push(unresolved);
  }
  return issues;
}

function generationInputIssues(state) {
  const issues = [];
  if (state.promptStructureConflict) {
    issues.push(issue(
      "Prompt mixes base and Reference structures",
      "The prompt contains distinctive top-level markers from both the base/T2VA grammar and the six-section REF2VA grammar. Easy follows the first distinctive structure it finds, but the mixed document is ambiguous.",
      "Use integrated_multimodal_description: for a base prompt OR subject_definitions: ... detailed_description: for a Reference prompt, not both.",
      null,
      "mixed-prompt-structures",
    ));
  }
  if (!Number.isFinite(state.requestedSeconds) || state.requestedSeconds < 1 || state.requestedSeconds > 30) {
    issues.push(issue(
      "Invalid output duration",
      "Video duration must be a finite number from 1 through 30 seconds.",
      "Set Video duration to 5.00 s.",
      null,
      "invalid-output-duration",
    ));
  }
  if (state.conditioningProfile === PROFILE.REF2VA) {
    const rawFps = state.refVideoFpsRawValues || [];
    rawFps.forEach((fps, index) => {
      const isFallback = index === 0;
      const invalid = !Number.isFinite(fps) || fps > 240 || (isFallback ? fps <= 0 : fps < 0);
      if (invalid) {
        issues.push(issue(
          isFallback ? "Invalid Video 1 source FPS" : `Invalid Video ${index + 1} source FPS`,
          isFallback
            ? "Video 1 source FPS must be finite, above 0, and no greater than 240 fps."
            : `Video ${index + 1} source FPS must be 0 to use Video 1, or a finite positive value no greater than 240 fps.`,
          isFallback
            ? "Set Video 1 source FPS to the rate represented by that IMAGE batch, such as 24 or 60."
            : `Set Video ${index + 1} source FPS to 0 to use Video 1, or enter that batch's represented rate such as 30 or 60.`,
          null,
          `invalid-reference-video-fps-${index + 1}`,
        ));
      }
    });
  }
  return issues;
}

function generationNotes(state, compiledPreview = "") {
  const notes = [];
  if (state.audioMode && state.keyframeCount > 0 && state.conditioningProfile !== PROFILE.REF2VA) {
    notes.push(note(
      "Endpoint frames are being conditioned into the 32x32 audio proxy",
      "Audio-only mode keeps the connected base/keyframe path instead of blocking it. The visual target is intentionally only 32x32, so endpoint-image detail is heavily discarded; use Reference images instead when visual identity should guide audio generation.",
      null,
      "audio-keyframe-proxy",
    ));
  }
  if (state.ignoredKeyframeInputs) {
    notes.push(note(
      "Connected endpoint frames are ignored because Reference inputs are connected",
      "Current ComfyUI exposes endpoint-frame and Reference conditioning as separate H3 builders. With Reference media connected, Easy can forward those refs through the native Reference builder, but that builder has no first/last-frame inputs, so the endpoint sockets cannot be forwarded in the same native call.",
      null,
      "ignored-keyframe-inputs",
    ));
  }
  if (state.conditioningProfile === PROFILE.REF2VA && state.videoCount > 0) {
    const fpsValues = state.refVideoFpsValues || [];
    const rawFpsValues = state.refVideoFpsRawValues || [];
    const changed = fpsValues
      .map((fps, index) => ({ fps, ordinal: index + 1 }))
      .filter(({ fps }) => Number.isFinite(fps) && Math.abs(fps - 24) > 1e-6);
    const inherited = rawFpsValues
      .map((fps, index) => ({ fps, ordinal: index + 1 }))
      .filter(({ fps, ordinal }) => ordinal > 1 && fps === 0)
      .map(({ ordinal }) => `Video ${ordinal}`);
    if (changed.length) {
      notes.push(note(
        `Video timing normalization: ${changed.map(({ ordinal, fps }) => `Video ${ordinal} ${Number(fps).toLocaleString(undefined, { maximumFractionDigits: 3 })} fps`).join(", ")} -> 24 fps`,
        `Easy resamples each connected Reference Video independently onto H3's native 24 fps grid. IMAGE tensors do not carry FPS metadata.${inherited.length ? ` ${inherited.join(" and ")} use Video 1 source FPS because their value is 0.` : ""}`,
        null,
        "reference-video-fps",
      ));
    } else {
      notes.push(note(
        "Reference video timing resolves to 24 fps for every connected IMAGE batch",
        `IMAGE tensors carry no FPS metadata. If a loader handed a reference its original 30/60 fps frames without resampling, set the corresponding Video source FPS control to that represented rate.${inherited.length ? ` ${inherited.join(" and ")} currently use Video 1 source FPS.` : ""}`,
        null,
        "reference-video-fps",
      ));
    }
    if (String(state.refVideoSize) !== H3E_DEFAULTS.refVideoSize) {
      notes.push(note(
        `Reference video resolution is reduced: ${state.refVideoSize}`,
        "This intentionally keeps reference video latents below MiniMax H3's native 768-class reference geometry to reduce conditioning cost. Source aspect is preserved as closely as H3's 32-pixel alignment allows, but fine motion, small details, or identity cues may weaken. Info reports the exact geometry/aspect delta. Use 768P native when adherence matters more than speed.",
        null,
        "reference-video-size",
      ));
    }
    if (String(state.refVideoTemporalFit) === H3E_VALUES.refVideoTemporalHold) {
      notes.push(note(
        "Reference video endpoint preservation is enabled",
        "Easy keeps the complete usable reference interval and repeats only the final frame until the next 17k+5 VAE length. This avoids core tail trimming without changing motion speed, but adds a short static hold and is not MiniMax/ComfyUI's official normalization rule.",
        null,
        "reference-video-temporal-fit",
      ));
    }
  }
  if (state.conditioningProfile === PROFILE.REF2VA) {
    const publishedEnvelope = [];
    if (state.imageCount > 9) publishedEnvelope.push(`${state.imageCount} images (documented max 9)`);
    if (state.videoCount > 3) publishedEnvelope.push(`${state.videoCount} videos (documented max 3)`);
    if (state.standaloneAudioCount > 3) publishedEnvelope.push(`${state.standaloneAudioCount} standalone audio clips (documented max 3)`);
    if (state.mixedRefCount > 12) publishedEnvelope.push(`${state.mixedRefCount} mixed files (documented max 12)`);
    if (state.imageCount + state.videoCount + state.standaloneAudioCount === 0) publishedEnvelope.push("no reference assets");
    else if (state.standaloneAudioCount > 0 && state.imageCount + state.videoCount === 0) publishedEnvelope.push("audio-only reference input");
    if (publishedEnvelope.length) {
      notes.push(note(
        "Outside MiniMax's published Ref2VA input envelope",
        `${publishedEnvelope.join("; ")}. Easy does not use the published envelope as a checkpoint capability gate; combinations accepted by the current ComfyUI path remain available experimentally.`,
        null,
        "reference-published-envelope",
      ));
    }

    const source = String(compiledPreview || "");
    for (const ref of state.refs) {
      const native = ref.kind === "image" ? `<Picture ${ref.ordinal}>` : ref.kind === "video" ? `<Video ${ref.ordinal}>` : `<Audio ${ref.ordinal}>`;
      if (!source.includes(native)) {
        notes.push(note(
          `${ref.token} is connected but has no semantic role in the prompt`,
          "H3 still encodes every connected reference, so an unused reference costs conditioning tokens and can add ambiguity. Define what this asset contributes in subject_definitions, or disconnect it.",
          null,
          `unused-${ref.kind}-${ref.ordinal}`,
        ));
      }
    }
  }
  if (state.audioMode) {
    notes.push(note(
      `${state.audioTask || "Audio-first"} · 32x32 proxy video`,
      "Easy forces the generated visual stream to 32x32 in Audio-first mode. Reference images/videos keep their own conditioning geometry; after sampling, decode only the audio stream when the proxy video is disposable.",
      null,
      "audio-proxy-mode",
    ));
  }
  if (Number.isFinite(state.requestedSeconds)
      && state.requestedSeconds >= 1 && state.requestedSeconds <= 30) {
    if (state.requestedSeconds < 4 || state.requestedSeconds > 15) {
      notes.push(note(
        "Experimental output duration",
        "MiniMax's H3 system card publishes 4–15 s. Current Diffusers local H3 requires the snapped 17k+5 / 24 fps result to be 5–15 s. Easy keeps 1–30 s available for current-ComfyUI experiments.",
        null,
        "output-duration",
      ));
    } else if (state.requestedSeconds < 5) {
      notes.push(note(
        "Local duration implementation differs",
        "4–5 s is inside MiniMax's system-card range, while current Diffusers local H3 requires the snapped result to be at least 5 s. Easy/current ComfyUI may still construct this experimentally.",
        null,
        "output-duration",
      ));
    }
  }
  return notes;
}

function validateReferenceInputs(state) {
  const issues = [];
  if (state.orphanPairedAudioNames.length) {
    issues.push(issue("Video soundtrack has no matching reference video", `${state.orphanPairedAudioNames.join(", ")} is connected without its same-numbered Reference Video.`, "Connect the matching Reference Video or disconnect that soundtrack.", null, "orphan-video-audio"));
  }
  return issues;
}


function validateReference(prompt, state) {
  const issues = [...validateReferenceInputs(state), ...sectionIssues(prompt, REF_SECTIONS)];
  const notes = [];
  const sections = sectionMap(prompt, REF_SECTIONS);

  const firstNonWhitespace = String(prompt || "").search(/\S/);
  if (firstNonWhitespace >= 0 && !/^\s*subject_definitions\s*:/i.test(String(prompt || ""))) {
    issues.push(issue("Reference prompt must start with subject_definitions:", "Reference-conditioning prompts use the fixed six-section full-reference structure starting with subject_definitions:.", "subject_definitions:\n@Subject1 is ...", { start: firstNonWhitespace, end: Math.min(String(prompt).length, firstNonWhitespace + 40) }, "ref-start"));
  }

  const summary = sections.summary?.body || "";
  const summaryTasks = taskPrefix(summary);
  if (sections.summary?.index >= 0) {
    if (!summaryTasks) {
      issues.push(issue("Missing summary task prefix", "summary: begins with one or more official task types in square brackets.", "summary:\n[reference generation] The target video shows @Subject1 ...", { start: sections.summary.bodyStart, end: sections.summary.bodyEnd }, "summary-prefix"));
    } else {
      const invalid = summaryTasks.filter((value) => !TASK_SET.has(value));
      if (invalid.length) issues.push(issue("Unknown summary task type", `Unsupported task type${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}.`, `[${TASK_TYPES[0][0]}] The target video shows ...`, { start: sections.summary.bodyStart, end: sections.summary.bodyEnd }, "summary-task"));
      const duplicates = summaryTasks.filter((value, index) => summaryTasks.indexOf(value) !== index);
      if (duplicates.length) issues.push(issue("Repeated summary task type", "Each summary task type should appear only once in the combined [type + type] prefix.", `[${[...new Set(summaryTasks)].join(" + ")}] ...`, { start: sections.summary.bodyStart, end: sections.summary.bodyEnd }, "summary-task-duplicate"));
      const remainder = summary.replace(/^\s*\[[^\]]+\]\s*/, "").trim();
      if (!remainder || remainder === "..." || /\.\.\.\s*$/.test(remainder)) {
        issues.push(issue("Missing summary paragraph", "The task prefix is only the prefix. Add one short high-level paragraph summarizing the target premise/shot flow and main reference relationships. Do not turn summary into a duplicate shot description.", "[reference generation] The target video uses @Subject1 as the character reference for a single-shot standing-backflip sequence.", { start: sections.summary.bodyStart, end: sections.summary.bodyEnd }, "summary-paragraph"));
      }
    }
  }
  // The task prefix and fixed task values are structural. Autofill emits the
  // guide's canonical spacing/" + " form, but cosmetic punctuation/spacing
  // around an otherwise valid prefix is not treated as a parser contract.

  if (/\bAt\s+\d{2}:\d{2}\.\d{3}\b/i.test(summary) || /\[Shot\s+\d+\]\s+At\s+/i.test(summary)) {
    notes.push(note(
      "Exact timing belongs in detailed_description",
      "summary is the high-level target/reference overview. Keep exact [Shot N] cut timestamps and timestamped execution in detailed_description; summary may describe shot flow only at a high level.",
      sections.summary ? { start: sections.summary.bodyStart, end: sections.summary.bodyEnd } : null,
      "summary-exact-timing",
    ));
  }

  const source = String(prompt || "");
  const defs = sections.subject_definitions?.body || "";
  const defsStart = sections.subject_definitions?.bodyStart ?? -1;
  const defsEnd = sections.subject_definitions?.bodyEnd ?? -1;
  if (defsStart >= 0) {
    let lineOffset = 0;
    for (const rawLine of defs.split("\n")) {
      const match = rawLine.match(/^[ \t]*(?:@(Subject|Image|Video|Audio)\d+\b|<(?:Subject|Picture|Image|Video|Audio)\s+\d+>)[ \t]*([:\-–—])/i);
      if (match) {
        const punctAt = rawLine.indexOf(match[2], rawLine.search(/(?:@|<)/));
        notes.push(note(
          "Reference definitions are normally natural sentences",
          "MiniMax's subject_definitions examples use forms such as '@Subject1 is ...' rather than a required ':' or '-' separator after the label. A colon/dash here is not documented fixed syntax. Prefer a natural sentence unless the punctuation is genuinely part of your prose.",
          { start: defsStart + lineOffset + Math.max(0, punctAt), end: defsStart + lineOffset + Math.max(0, punctAt) + 1 },
          "definition-label-punctuation",
        ));
      }
      lineOffset += rawLine.length + 1;
    }
  }
  const defsRaw = defsStart >= 0 && defsEnd >= defsStart ? source.slice(defsStart, defsEnd) : "";
  const definedRefs = new Set();
  const standaloneDefinitions = new Map();
  const sourceOnlyOwners = new Map();
  let definitionLineOffset = 0;
  for (const line of defsRaw.split("\n")) {
    const lineTokens = tokensIn(line);
    const firstVisible = String(line).search(/\S/);
    const leading = lineTokens.find((token) => token.index === firstVisible);
    if (leading) {
      const key = `${leading.kind}:${leading.ordinal}`;
      const absoluteStart = defsStart + definitionLineOffset + leading.index;
      definedRefs.add(key);
      if (standaloneDefinitions.has(key)) {
        issues.push(issue(
          `Duplicate tracked definition for ${leading.token}`,
          "Each separately tracked REF item gets one subject_definitions: line and keeps that meaning everywhere else. Merge the duplicate information into the first definition instead of redefining the same label.",
          `Keep one ${leading.token} definition line and combine the relevant source/role details there.`,
          { start: absoluteStart, end: absoluteStart + leading.token.length },
          "duplicate-reference-definition",
        ));
      } else {
        standaloneDefinitions.set(key, { ...leading, absoluteStart, lineText: line.trim() });
      }

      // The line-leading label is the separately tracked item. Later Picture or
      // Video labels on that same line may only identify provenance for it.
      for (const cited of lineTokens) {
        if (cited === leading || !["image", "video"].includes(cited.kind)) continue;
        const citedKey = `${cited.kind}:${cited.ordinal}`;
        if (!sourceOnlyOwners.has(citedKey)) sourceOnlyOwners.set(citedKey, new Set());
        sourceOnlyOwners.get(citedKey).add(leading.token);
      }
    }
    definitionLineOffset += line.length + 1;
  }

  // A common multi-view mistake is to cite @ImageN inside a Subject definition,
  // then start a new line such as "@Image1 provides the frontal view". In the
  // official REF grammar, a line-leading Picture/Video becomes independently
  // tracked. Catch source-contribution wording that probably meant to stay on
  // the Subject line before it creates a surprising retention requirement.
  for (const [key, owners] of sourceOnlyOwners) {
    const standalone = standaloneDefinitions.get(key);
    if (!standalone || !["image", "video"].includes(standalone.kind)) continue;
    const lineText = String(standalone.lineText || "");
    const independentRole = standalone.kind === "image"
      ? /\b(first|last|key|keyframe|edited|composition|anchor|storyboard|planning|frame)\b/i.test(lineText)
      : /\b(edit|editing|continu|camera|cut|rhythm|pacing|temporal|structure|source video)\b/i.test(lineText);
    const contributionOnly = /\b(provides?|shows?|view|appearance|profile|front|side|back|motion|style|identity|clothing|outfit|pose|expression)\b/i.test(lineText);
    if (!independentRole && contributionOnly) {
      const ownerText = [...owners].join(", ");
      notes.push(note(
        `${standalone.token} may be split source provenance`,
        `${standalone.token} is already cited as source provenance for ${ownerText}. A line-leading ${standalone.token} also makes it a separately tracked ${standalone.kind === "image" ? "Picture" : "Video"}. If this line only explains what the source contributes, merge it into ${ownerText}; keep it separate only when you intend an independent frame/composition/storyboard or whole-video role.`,
        { start: standalone.absoluteStart, end: standalone.absoluteStart + standalone.token.length },
        "split-source-provenance",
      ));
    }
  }
  if (/\.\.\.\s*$/.test(defs) || /@Subject\d+\s+is\s+\.\.\./i.test(defs)) {
    const example = state.imageCount >= 3
      ? "@Subject1 is the same character shown in @Image1, @Image2, and @Image3; @Image1 provides the frontal view, @Image2 the side view, and @Image3 the back view."
      : "@Subject1 is the same character shown in @Image1; preserve the defining appearance described here.";
    issues.push(issue("Complete the subject definition", "subject_definitions: still contains an editor scaffold. Replace it with the actual identity/reference relationship.", example, { start: sections.subject_definitions?.bodyStart || 0, end: sections.subject_definitions?.bodyEnd || 0 }, "subject-scaffold"));
  }
  const outsideSectionNames = ["summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
  for (const sectionName of outsideSectionNames) {
    const entry = sections[sectionName];
    if (!entry || entry.bodyStart < 0 || entry.bodyEnd < entry.bodyStart) continue;
    // Use the untrimmed slice so issue ranges point at the actual offending
    // token rather than at the start of subject_definitions:.
    const rawBody = source.slice(entry.bodyStart, entry.bodyEnd);
    for (const token of tokensIn(rawBody)) {
      const key = `${token.kind}:${token.ordinal}`;
      if (definedRefs.has(key)) continue;

      const owners = sourceOnlyOwners.get(key);
      if (owners?.size && ["image", "video"].includes(token.kind)) {
        const ownerList = [...owners];
        const ownerText = ownerList.join(ownerList.length > 1 ? ", " : "");
        const mediaLabel = token.kind === "image" ? "Picture" : "Video";
        const roleHint = token.kind === "image"
          ? "Only give the picture its own definition line when the image itself is a concrete first/key/last/edited frame, composition anchor, or storyboard/planning reference."
          : "Only give the video its own definition line when the video itself has a whole-video editing, continuation, camera/cut/rhythm, or temporal-structure role.";
        issues.push(issue(
          `${token.token} is source-only, not a tracked ${mediaLabel}`,
          `${token.token} is cited inside ${ownerText}'s subject_definitions line as source provenance, but is also used in ${sectionName}. Same-line source citations do not become separately tracked labels. Use ${ownerText} when you mean that already-defined semantic item. If the same source asset supplies a DIFFERENT reusable semantic property, such as the video's visual style, define another @SubjectN from ${token.token} and use that Subject instead. ${roleHint}`,
          `Use ${ownerText} for the existing item, or define a separate @SubjectN from ${token.token} for a different role such as visual style.`,
          { start: entry.bodyStart + token.index, end: entry.bodyStart + token.index + token.token.length },
          "source-only-reference-used-outside",
        ));
        continue;
      }

      const example = token.kind === "subject"
        ? `${token.token} is the same character shown in @Image1 ...`
        : token.kind === "image"
          ? `${token.token} is a concrete keyframe or composition anchor for [Shot 1].`
          : token.kind === "video"
            ? `${token.token} is the source video whose structure is used by the target video.`
            : `${token.token} is the reference audio used for the stated target-video audio role.`;
      const extra = token.kind === "image"
        ? " If this picture only supplies identity/appearance/style for a subject, keep it inside that @SubjectN definition and use the subject label elsewhere instead of defining the picture separately."
        : token.kind === "video"
          ? " If this video only supplies visible subject content, define/use that content as @SubjectN instead of tracking the source video itself."
          : "";
      issues.push(issue(
        `${token.token} is not defined`,
        `A reference label used in ${sectionName} must first be a standalone tracked item in subject_definitions:.${extra}`,
        `subject_definitions:\n${example}`,
        { start: entry.bodyStart + token.index, end: entry.bodyStart + token.index + token.token.length },
        "undefined-reference",
      ));
    }
  }

  const retention = sections.retention_analysis?.body || "";
  if (/\.\.\.\s*$/.test(retention) || /-\s*preserve\s+\.\.\./i.test(retention)) {
    issues.push(issue("Complete the retention analysis", "retention_analysis: still contains an editor scaffold. State what is preserved/transferred/referenced for each tracked reference.", "@Subject1 (appears in [Shot 1]): fully_preserved - preserve her identity, clothing, body proportions, and viewpoint-consistent appearance.", { start: sections.retention_analysis?.bodyStart || 0, end: sections.retention_analysis?.bodyEnd || 0 }, "retention-scaffold"));
  }
  // The REF guide defines the tracking boundary in subject_definitions: each
  // separately tracked item gets its own leading definition line. Picture/Video
  // assets used only as provenance inside another item's definition explicitly do
  // NOT get their own line, and therefore do not get their own retention row.
  // Requiring retention based on later textual mentions creates false positives
  // for exactly that provenance-only case and cascades after undefined-reference.
  for (const token of standaloneDefinitions.values()) {
    const regex = new RegExp(`^[ \t]*${referencePattern(token.kind, token.ordinal)}(?:[ \t]|\\(|:|$)`, "im");
    if (!regex.test(retention)) {
      const marker = token.kind === "audio" ? "reference" : "fully_preserved";
      const occurrence = token.kind === "audio" ? "" : " (appears in [Shot 1])";
      const action = token.kind === "audio" ? "state the copied/referenced audio relationship" : "state what is preserved, transferred, or weakly referenced";
      issues.push(issue(`Missing retention row for ${token.token}`, "Every standalone reference label defined in subject_definitions: needs one retention_analysis: row. Picture/Video assets cited only inside another item's definition are provenance, not standalone tracked items.", `${token.token}${occurrence}: ${marker} - ${action}.`, { start: sections.retention_analysis?.bodyStart || 0, end: sections.retention_analysis?.bodyStart || 0 }, "missing-retention"));
    }
  }

  const retentionStart = sections.retention_analysis?.bodyStart ?? -1;
  const retentionEnd = sections.retention_analysis?.bodyEnd ?? -1;
  const retentionRaw = retentionStart >= 0 && retentionEnd >= retentionStart ? source.slice(retentionStart, retentionEnd) : "";
  const seenRetentionRows = new Set();
  const requiredAudioTaskTypes = new Set();
  let retentionLineOffset = 0;
  for (const rawLine of retentionRaw.split("\n")) {
    const lineTokens = tokensIn(rawLine);
    if (!lineTokens.length) {
      retentionLineOffset += rawLine.length + 1;
      continue;
    }
    const firstVisible = String(rawLine).search(/\S/);
    const leading = lineTokens.find((token) => token.index === firstVisible);
    const lineStart = retentionStart + retentionLineOffset;
    if (!leading) {
      if (/:\s*[A-Za-z_]+/.test(rawLine)) {
        const first = lineTokens[0];
        issues.push(issue(
          "Retention row must start with its tracked reference label",
          "retention_analysis: uses one line per separately tracked item, with that item's label at the start of the line.",
          `${first.token}: ${first.kind === "audio" ? "reference" : "fully_preserved"} - ...`,
          { start: lineStart + first.index, end: lineStart + first.index + first.token.length },
          "retention-row-leading-label",
        ));
      }
      retentionLineOffset += rawLine.length + 1;
      continue;
    }

    const key = `${leading.kind}:${leading.ordinal}`;
    // Undefined/source-only rows are already diagnosed by the reference pass.
    // Skip marker checks here so one semantic mistake does not cascade into an
    // unrelated-looking retention error.
    if (!standaloneDefinitions.has(key)) {
      retentionLineOffset += rawLine.length + 1;
      continue;
    }
    if (seenRetentionRows.has(key)) {
      issues.push(issue(
        `Duplicate retention row for ${leading.token}`,
        "Each separately tracked reference gets one retention_analysis: row. Merge all preserved/transferred/reused details for this label into one row.",
        `Keep one ${leading.token}: relationship - ... row.`,
        { start: lineStart + leading.index, end: lineStart + leading.index + leading.token.length },
        "duplicate-retention-row",
      ));
    } else {
      seenRetentionRows.add(key);
    }

    if (/\(S\d+(?:\s*,\s*S\d+)*\)/i.test(rawLine)) {
      issues.push(issue("Speaker ID inside retention_analysis", "Speaker IDs belong to vocal events in detailed_description, not to retention rows.", "@Subject1 (appears in [Shot 1]): fully_preserved - preserve ...", { start: lineStart, end: lineStart + rawLine.length }, "retention-speaker"));
    }
    const isAudio = leading.kind === "audio";
    const allowed = isAudio ? AUDIO_RETENTION_SET : VISUAL_RETENTION_SET;
    const afterLeading = rawLine.slice(leading.index + leading.token.length);
    const colonRelative = afterLeading.indexOf(":");
    if (colonRelative < 0) {
      issues.push(issue(
        `Missing ':' before ${leading.token} retention relationship`,
        "Canonical retention syntax is 'label/qualifier: relationship - explanation'. Put the colon after the tracked label's occurrence/role qualifier and before the fixed relationship marker.",
        isAudio ? `${leading.token}: reference - state which audio property is referenced.` : `${leading.token} (appears in [Shot 1]): fully_preserved - state what remains intact.`,
        { start: lineStart + rawLine.length, end: lineStart + rawLine.length },
        "retention-colon",
      ));
      retentionLineOffset += rawLine.length + 1;
      continue;
    }
    const afterColon = afterLeading.slice(colonRelative + 1);
    const markerMatch = afterColon.match(/^\s*([A-Za-z_]+)\b(.*)$/);
    const marker = markerMatch?.[1] || "";
    const markerTail = markerMatch?.[2] || "";
    if (!marker || !allowed.has(marker)) {
      issues.push(issue("Invalid retention relationship", `Use one of the fixed ${isAudio ? "audio" : "visual"} relationship values for ${leading.token}.`, isAudio ? `${leading.token}: reference - state which audio property is referenced.` : `${leading.token} (appears in [Shot 1]): fully_preserved - state what remains intact.`, { start: lineStart, end: lineStart + rawLine.length }, "retention-marker"));
    } else {
      if (isAudio && ["fully_copy", "partially_copy"].includes(marker)) requiredAudioTaskTypes.add("audio reuse");
      if (isAudio && ["reference", "weak_reference"].includes(marker)) requiredAudioTaskTypes.add("audio reference");
      if (!/^\s*-\s*\S/.test(markerTail)) {
        notes.push(note(
          `Explain what ${marker} means for ${leading.token}`,
          `The relationship marker is valid. MiniMax's retention_analysis examples add a concrete clause describing what is preserved, transferred, copied, or referenced; adding one usually makes the relationship less ambiguous.`,
          { start: lineStart, end: lineStart + rawLine.length },
          "retention-explanation",
        ));
      }
    }
    retentionLineOffset += rawLine.length + 1;
  }


  if (summaryTasks?.length && requiredAudioTaskTypes.size) {
    const missing = [...requiredAudioTaskTypes].filter((task) => !summaryTasks.includes(task));
    if (missing.length) {
      const combined = [...summaryTasks, ...missing].filter((task, index, all) => all.indexOf(task) === index);
      issues.push(issue(
        `Summary is missing ${missing.join(" + ")}`,
        `retention_analysis declares an audio relationship that maps to ${missing.join(" + ")} in MiniMax's task taxonomy: copied source signal uses audio reuse; non-copied guidance uses audio reference. Keep the summary task prefix consistent with the retention relationship.`,
        `[${combined.join(" + ")}] ...`,
        sections.summary ? { start: sections.summary.bodyStart, end: sections.summary.bodyEnd } : null,
        "summary-audio-task-consistency",
      ));
    }
  }

  const detailed = sections.detailed_description?.body || "";
  if (/The target video uses\s+\.\.\./i.test(detailed) || /\[Shot\s+1\]\s+\.\.\./i.test(detailed)) {
    issues.push(issue("Complete detailed_description", "The detailed description still contains editor placeholders. Replace them with the actual overall style and playback-order shot description.", "The target video uses a realistic cinematic style with soft studio lighting.\n\n[Shot 1] A full-body shot frames @Subject1 ...", { start: sections.detailed_description?.bodyStart || 0, end: sections.detailed_description?.bodyEnd || 0 }, "detailed-scaffold"));
  }
  const firstShotIndex = detailed.search(/^\s*\[Shot\s+1\]/im);
  if (firstShotIndex === 0) {
    issues.push(issue("Add visual style before [Shot 1]", "Reference detailed_description should establish the target video's overall visual style in one or two English sentences before the first shot.", "The target video uses a realistic cinematic style with soft studio lighting and natural materials.\n\n[Shot 1] ...", { start: sections.detailed_description?.bodyStart || 0, end: sections.detailed_description?.bodyStart || 0 }, "ref-style"));
  }
  const isVideoEditing = summaryTasks?.includes("video editing") ?? false;
  if (isVideoEditing) {
    const trackedVideos = [...standaloneDefinitions.values()].filter((definition) => definition.kind === "video");
    const explicitEditSources = trackedVideos.filter((definition) => /\b(?:source video for (?:the )?target video edit|source video for .*edit|video being edited|edit(?:ing)? source)\b/i.test(definition.lineText || ""));
    const editSource = explicitEditSources.length === 1 ? explicitEditSources[0] : (trackedVideos.length === 1 ? trackedVideos[0] : null);
    if (editSource) {
      const remainder = summary.replace(/^\s*\[[^\]]+\]\s*/, "").trimStart();
      const expectedLead = `The target video is an edited version of ${editSource.token}.`;
      if (!remainder.startsWith(expectedLead)) notes.push(note(
        "Video-editing summary lead-in",
        `MiniMax's full-reference guide begins a video-editing summary with '${expectedLead}' before describing the edit.`,
        sections.summary ? { start: sections.summary.bodyStart, end: sections.summary.bodyEnd } : null,
        "video-edit-summary-lead",
      ));
    }
  }
  if (/^\.\.\.$/.test((sections.overall_soundscape?.body || "").trim())) {
    issues.push(issue("Complete overall_soundscape", "The scaffold does not assume silence. Describe ambient/physical/non-verbal sound, or explicitly use N/A only when complete silence is intended.", "overall_soundscape: Ambient sound includes ...", { start: sections.overall_soundscape?.bodyStart || 0, end: sections.overall_soundscape?.bodyEnd || 0 }, "soundscape-scaffold"));
  }
  if (/^\.\.\.$/.test((sections.non_diegetic_music?.body || "").trim())) {
    issues.push(issue("Complete non_diegetic_music", "Describe audience-only background music, or explicitly use N/A when there is none.", "non_diegetic_music: N/A", { start: sections.non_diegetic_music?.bodyStart || 0, end: sections.non_diegetic_music?.bodyEnd || 0 }, "music-scaffold"));
  }
  if (/^N\/A\s*$/i.test(sections.overall_soundscape?.body || "")) notes.push(note("Soundscape is N/A", "Use N/A only when the intended video is explicitly silent; otherwise describe the overall ambience/physical soundscape.", sections.overall_soundscape ? { start: sections.overall_soundscape.bodyStart, end: sections.overall_soundscape.bodyEnd } : null, "soundscape-na"));

  return { issues, notes };
}

function validateBase(prompt, state) {
  const issues = [...sectionIssues(prompt, BASE_SECTIONS)];
  const notes = [];
  const source = String(prompt || "");
  const sections = sectionMap(prompt, BASE_SECTIONS);
  const expected = firstLineForState(state, prompt);
  const firstLine = source.trimStart().split("\n", 1)[0] || "";

  if (state.editorProfile === PROFILE.T2VA) {
    if (!/^\s*integrated_multimodal_description\s*:/i.test(source)) {
      issues.push(issue("T2VA should start with integrated_multimodal_description:", "T2VA has no first/last-frame alignment line. Start directly with the three prompt sections.", "integrated_multimodal_description:\n[Shot 1] ...", { start: 0, end: Math.min(source.length, 80) }, "t2-start"));
    }
  } else {
    const compiledExpected = compilePromptPreview(expected, state);
    const matchedOpening = [expected, compiledExpected].find((candidate) => firstLine.trim() === candidate) || null;
    if (!matchedOpening) {
      issues.push(issue(`Missing or stale ${state.editorProfile} opening line`, "This mode has a prescribed first-line frame-alignment instruction. It must match whether Image 1 is the first or last frame, the final shot, and the snapped duration. @ImageN and native <Picture N> forms are both accepted.", expected, { start: 0, end: Math.max(0, firstLine.length) }, "keyframe-first-line"));
    } else if (!source.trimStart().startsWith(`${matchedOpening}\n\n`)) {
      issues.push(issue("Missing blank line after the opening instruction", "MiniMax places a blank line between the frame-alignment line and integrated_multimodal_description:.", `${expected}\n\nintegrated_multimodal_description:`, { start: 0, end: matchedOpening.length }, "keyframe-blank-line"));
    }
  }

  if (/\[Shot\s+1\]\s+\.\.\./i.test(source)) {
    const idx = source.search(/\[Shot\s+1\]\s+\.\.\./i);
    issues.push(issue("Complete [Shot 1]", "The shot description still contains an editor placeholder.", "[Shot 1] A full-body shot frames the subject as the action begins ...", { start: Math.max(0, idx), end: Math.max(0, idx) + 12 }, "base-shot-scaffold"));
  }

  if (state.editorProfile === PROFILE.I2VA) notes.push(note("I2VA motion path", "Develop the target video forward from the concrete first frame. Describe observable motion/state changes after the first frame rather than repeatedly restating it.", null, "i2-guidance"));
  if (state.editorProfile === PROFILE.L2VA) {
    notes.push(note("L2VA motion path", "Describe an earlier plausible state and a continuous progression that converges on the supplied final frame.", null, "l2-guidance"));
    if (finalShotNumber(source) > 1) notes.push(note("L2VA final-shot anchor", `@Image1 belongs to the actual final [Shot ${finalShotNumber(source)}]. Make that final shot complete the convergence and land on the supplied image.`, null, "l2-final-shot"));
  }
  if (state.editorProfile === PROFILE.FL2VA) {
    notes.push(note("FL2VA motion path", "Describe observable intermediate changes connecting Picture 1 to Picture 2. A single continuous shot is usually the clearest formulation unless a cut is intentional.", null, "fl2-guidance"));
    if (finalShotNumber(source) > 1) notes.push(note("FL2VA final-shot anchor", `The ending Picture belongs to the actual final [Shot ${finalShotNumber(source)}]. Make that shot finish the remaining convergence to the supplied last frame.`, null, "fl2-final-shot"));
  }
  if (/^\.\.\.$/.test((sections.overall_soundscape?.body || "").trim())) {
    issues.push(issue("Complete overall_soundscape", "The scaffold does not assume silence. Describe ambient/physical/non-verbal sound, or explicitly use N/A only when complete silence is intended.", "overall_soundscape: Ambient sound includes ...", { start: sections.overall_soundscape?.bodyStart || 0, end: sections.overall_soundscape?.bodyEnd || 0 }, "soundscape-scaffold"));
  }
  if (/^\.\.\.$/.test((sections.non_diegetic_music?.body || "").trim())) {
    issues.push(issue("Complete non_diegetic_music", "Describe audience-only background music, or explicitly use N/A when there is none.", "non_diegetic_music: N/A", { start: sections.non_diegetic_music?.bodyStart || 0, end: sections.non_diegetic_music?.bodyEnd || 0 }, "music-scaffold"));
  }
  if (/^N\/A\s*$/i.test(sections.overall_soundscape?.body || "")) notes.push(note("Soundscape is N/A", "Use N/A only when the intended video is explicitly silent; otherwise describe the overall ambience/physical soundscape.", sections.overall_soundscape ? { start: sections.overall_soundscape.bodyStart, end: sections.overall_soundscape.bodyEnd } : null, "soundscape-na"));
  return { issues, notes };
}

function editorPlaceholderIssues(prompt) {
  const source = String(prompt || "");
  const issues = [];
  for (const match of source.matchAll(/\{([^{}\n]+)\}/g)) {
    const key = String(match[1] || "").trim();
    if (!Object.prototype.hasOwnProperty.call(EDITOR_PLACEHOLDER_HELP, key)) continue;
    const help = EDITOR_PLACEHOLDER_HELP[key];
    const start = match.index || 0;
    issues.push(issue(
      `Fill {${key}}`,
      `${help} Curly-brace placeholders are editor scaffolds only and must not remain in the final MiniMax prompt.`,
      null,
      { start, end: start + match[0].length },
      `editor-placeholder-${key}`,
    ));
  }
  return issues;
}

function validateAudioFirst(prompt, state) {
  if (!state.audioMode) return { issues: [], notes: [] };
  const issues = [];
  const notes = [];
  const source = String(prompt || "");

  if (state.conditioningProfile === PROFILE.REF2VA) {
    if (state.videoCount > 0 && state.pairedAudioCount === 0) {
      notes.push(note(
        "V2A proxy uses the reference video without its soundtrack",
        "This is the cleaner setup for dubbing, foley, or generating a new soundtrack from the video's visual/timing cues. The generated audio follows H3's target timeline; frame-exact source-video dubbing is still experimental.",
        null,
        "audio-v2a-visual-only",
      ));
    } else if (state.videoCount > 0 && state.pairedAudioCount > 0) {
      notes.push(note(
        "Reference-video soundtrack is also conditioning the generated audio",
        "Keep the paired soundtrack when you want its voice/music/SFX to influence or be reused. Disconnect it for a cleaner redub/re-foley workflow driven only by the video's visual/timing reference.",
        null,
        "audio-v2a-paired-soundtrack",
      ));
    }
    if (state.imageCount > 0 && state.videoCount === 0 && state.audioCount === 0) {
      notes.push(note(
        "I2A proxy uses images as semantic references, not first-frame anchors",
        "That is deliberate: reference images keep useful conditioning detail while the disposable target video stays 32x32.",
        null,
        "audio-i2a-reference-image",
      ));
    }
  }

  const sections = sectionMap(source, state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS);
  const timeline = state.editorProfile === PROFILE.REF2VA ? (sections.detailed_description?.body || "") : (sections.integrated_multimodal_description?.body || "");
  const soundscape = String(sections.overall_soundscape?.body || "").trim();
  const music = String(sections.non_diegetic_music?.body || "").trim();
  const hasVocal = /<d>\s*\[[^\]]+\]/i.test(timeline);
  const hasAudioRef = /(?:@Audio\d+\b|<Audio\s+\d+>)/i.test(source);
  if (/^N\/A$/i.test(soundscape) && /^N\/A$/i.test(music) && !hasVocal && !hasAudioRef) {
    notes.push(note(
      "Audio-first prompt currently asks for no audible content",
      "Both audio summary fields are N/A and there is no dialogue/lyrics or tracked audio reference. That is valid for silence, but it defeats the purpose of Audio-first mode if you expected generated sound.",
      null,
      "audio-no-target",
    ));
  }

  return { issues, notes };
}

export function validatePrompt(prompt, state) {
  const compiledPreview = compilePromptPreview(prompt, state);
  const base = state.editorProfile === PROFILE.REF2VA ? validateReference(prompt, state) : validateBase(prompt, state);
  const audio = validateAudioFirst(prompt, state);
  const issues = [...generationInputIssues(state), ...validatePhysicalReferences(prompt, state), ...base.issues, ...audio.issues, ...editorPlaceholderIssues(prompt), ...validateShots(prompt, state), ...validateDialogue(prompt, state)];
  const notes = [...base.notes, ...audio.notes, ...generationNotes(state, compiledPreview)];
  return {
    issues: dedupe(issues),
    notes: dedupe(notes),
    compiledPreview,
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.severity}|${item.code}|${item.title}|${item.range?.start ?? ""}|${item.range?.end ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function templateForState(state, prompt = "") {
  if (state.audioMode && state.editorProfile === PROFILE.REF2VA) {
    return [
      "subject_definitions:",
      "{define tracked reference content}",
      "",
      "summary:",
      "{summary task type} {target video + main reference relationships}",
      "",
      "retention_analysis:",
      "{retention rows for tracked references}",
      "",
      "detailed_description:",
      "The proxy video remains visually minimal and static; audio is the intended output.",
      "[Shot 1] {audio events in playback order}. {synchronized sound / dialogue if present}.",
      "",
      "overall_soundscape:",
      "{ambience + physical / non-verbal sounds, or N/A only if completely silent}",
      "",
      "non_diegetic_music:",
      "{audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A}",
    ].join("\n");
  }
  if (state.editorProfile === PROFILE.REF2VA) {
    // Reference media do not determine their semantic role. A connected Picture
    // may be Subject provenance or a concrete frame anchor; a Video may supply
    // visible Subject content, structure, editing, or continuation; Audio may be
    // copied or only referenced. Keep the empty-prompt scaffold neutral and let
    // subject_definitions autocomplete make that choice explicitly.
    return [
      "subject_definitions:",
      "{define tracked reference content}",
      "",
      "summary:",
      "{summary task type} {target video + main reference relationships}",
      "",
      "retention_analysis:",
      "{retention rows for tracked references}",
      "",
      "detailed_description:",
      "The target video uses {visual style}, with {lighting / color / material traits}.",
      "[Shot 1] The shot uses {shot size / framing} framing from {viewpoint} and frames {subject / scene}. The framed subject is {subject appearance / pose / frame position}. The scene shows {environment / lighting}. {action in playback order}. {secondary motion / physical response}. {camera movement if needed}. {synchronized sound / dialogue if present}.",
      "",
      "overall_soundscape:",
      "{ambience + physical / non-verbal sounds, or N/A only if completely silent}",
      "",
      "non_diegetic_music:",
      "{audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A}",
    ].join("\n");
  }

  const first = firstLineForState(state, prompt);
  let shot;
  if (state.editorProfile === PROFILE.I2VA) {
    shot = "[Shot 1] The target video uses {visual style}. The shot uses {shot size / framing} framing from {viewpoint} and preserves @Image1 as the opening frame with {subject / scene / composition}. {action onset}. {continuous development}. {result / reaction}. {camera movement if needed}. {synchronized sound / dialogue if present}.";
  } else if (state.editorProfile === PROFILE.FL2VA) {
    const opening = state.keyframeRole === KEYFRAME_LAST ? "@Image2" : "@Image1";
    const ending = state.keyframeRole === KEYFRAME_LAST ? "@Image1" : "@Image2";
    shot = `[Shot 1] The target video uses {visual style}. The shot uses {shot size / framing} framing from {viewpoint} and begins from ${opening}. {first-frame visible state}. {changes between first and last frame}. {approach to final frame}. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  } else if (state.editorProfile === PROFILE.L2VA) {
    shot = "[Shot 1] The target video uses {visual style}. The shot uses {shot size / framing} framing from {viewpoint} and starts before the supplied final frame. {state before the final frame}. {motion toward the final frame}. {final-frame convergence}. {camera movement if needed}. {synchronized sound / dialogue if present}.";
  } else if (state.audioMode) {
    shot = "[Shot 1] The proxy video remains visually minimal and static; audio is the intended output. {audio events in playback order}. {synchronized sound / dialogue if present}.";
  } else {
    shot = "[Shot 1] The target video uses {visual style}. The shot uses {shot size / framing} framing from {viewpoint} and frames {subject / scene}. {action in playback order}. {camera movement if needed}. {synchronized sound / dialogue if present}.";
  }
  return [
    ...(first ? [first, ""] : []),
    "integrated_multimodal_description:",
    shot,
    "",
    "overall_soundscape:",
    "{ambience + physical / non-verbal sounds, or N/A only if completely silent}",
    "",
    "non_diegetic_music:",
    "{audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A}",
  ].join("\n");
}

export function profileDescription(state) {
  const referenceKinds = state.referenceInputKinds?.length ? state.referenceInputKinds.join(", ") : "Reference input";
  const promptDriven = state.editorProfileSource === "prompt";
  const sourceNote = promptDriven
    ? `prompt structure (${state.promptStructureMarker || "recognized H3 sections"})`
    : "connected inputs";
  if (state.promptAudioIntent && !state.audioMode) {
    const label = state.editorProfile === PROFILE.REF2VA ? "R2A / REF2A" : "T2A";
    return `${label}-style prompt assistance from ${sourceNote}; Mode remains Video + audio. The prompt template does not change execution or connected media.`;
  }
  if (state.audioMode) {
    const proxyNote = state.keyframeCount > 0 && state.conditioningProfile !== PROFILE.REF2VA
      ? " Connected endpoint frames are still conditioned into that 32x32 proxy, so visual detail is heavily reduced."
      : "";
    if (state.editorProfile === PROFILE.REF2VA) return `${state.audioTask || "Audio proxy"} · REF-style prompt assistance from ${sourceNote}; Mode generates a disposable 32x32 proxy video plus audio.${proxyNote}`;
    return `${state.audioTask || "T2A proxy"} · base-style prompt assistance from ${sourceNote}; Mode generates a disposable 32x32 proxy video plus audio.${proxyNote}`;
  }
  if (state.editorProfile === PROFILE.REF2VA) return `REF2VA-style prompt assistance inferred from ${sourceNote}; ${state.hasReferenceInputs ? `connected ${referenceKinds} remain active independently of this prompt template` : "connected media remain independent of this prompt template"}.`;
  if (state.editorProfile === PROFILE.T2VA) return `T2VA-style prompt assistance inferred from ${sourceNote}; connected media remain independent of this prompt template.`;
  if (state.editorProfile === PROFILE.I2VA) return `I2VA · base prompt structure inferred from ${sourceNote}; Image 1 is the first endpoint frame.`;
  if (state.editorProfile === PROFILE.L2VA) return `L2VA · base prompt structure inferred from ${sourceNote}; Image 1 is the last endpoint frame at ${state.effectiveSeconds.toFixed(2)}s.`;
  const mapping = state.keyframeRole === KEYFRAME_LAST ? "Image 2 opens · Image 1 ends" : "Image 1 opens · Image 2 ends";
  return `FL2VA · base prompt structure inferred from ${sourceNote}; ${mapping}.`;
}
