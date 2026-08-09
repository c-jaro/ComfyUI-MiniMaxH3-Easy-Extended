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
  CONDITIONING_MODEL_FL2VA,
  CONDITIONING_MODEL_REF2VA,
  PROFILE,
  REF_SECTIONS,
  TASK_TYPES,
  VISUAL_RETENTION,
} from "./h3_guidelines.js";

const TASK_SET = new Set(TASK_TYPES.map(([value]) => value));
const VISUAL_RETENTION_SET = new Set(VISUAL_RETENTION.map(([value]) => value));
const AUDIO_RETENTION_SET = new Set(AUDIO_RETENTION.map(([value]) => value));
const REMOVED_CONDITIONING_MODELS = new Set(["Audio override", "Audio model from Loader"]);
const MEDIA_ALIAS_RE = /@(VideoAudio|Image|Video|Audio|Subject)(\d+)\b/gi;
const ANGLE_IMAGE_ALIAS_RE = /<Image\s+(\d+)>/gi;
const MEDIA_ANY_RE = /@(VideoAudio|Image|Video|Audio|Subject)(\d+)\b|<(Picture|Image|Video|Audio|Subject)\s+(\d+)>/gi;

function isAudioReferenceKind(kind) {
  return kind === "audio" || kind === "soundtrack";
}

function referencePattern(kind, ordinal) {
  if (kind === "soundtrack") return `@VideoAudio${ordinal}\\b`;
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

function standaloneAudioDescriptors(standalone) {
  return standalone.map((input, index) => ({
    token: `@Audio${index + 1}`,
    kind: "audio",
    ordinal: index + 1,
    inputName: input.name,
    detail: "Standalone reference audio.",
  }));
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

function hasParagraphBreak(body) {
  return /\S[^\n]*\n[ \t]*\n[ \t]*\S/.test(String(body || "").trim());
}

function audioParagraphIssues(sections) {
  const issues = [];
  const soundscape = sections.overall_soundscape;
  if (soundscape?.body && hasParagraphBreak(soundscape.body)) {
    issues.push(issue(
      "Keep overall_soundscape in one paragraph",
      "MiniMax specifies one continuous paragraph of 1–4 English sentences for the overall ambience, physical/foley, and non-verbal sounds. Remove blank-line paragraph breaks inside this section.",
      "overall_soundscape:\nQuiet room tone and soft fabric rustle continue beneath distant traffic.",
      { start: soundscape.bodyStart, end: soundscape.bodyEnd },
      "soundscape-paragraphs",
    ));
  }
  const music = sections.non_diegetic_music;
  if (music?.body && hasParagraphBreak(music.body)) {
    issues.push(issue(
      "Keep non_diegetic_music in one paragraph",
      "MiniMax specifies one continuous paragraph of 1–3 English sentences for audience-only instrumentation, tempo/rhythm, and dynamic development. Remove blank-line paragraph breaks inside this section.",
      "non_diegetic_music:\nSparse piano at a slow tempo gains low strings and gradually increases in volume.",
      { start: music.bodyStart, end: music.bodyEnd },
      "music-paragraphs",
    ));
  }
  return issues;
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
        `Missing ${entry.name} section`,
        `Add the required ${entry.name}: section in the active H3 prompt structure.`,
        null,
        { start: 0, end: 0 },
        `missing-section:${entry.name}`,
      ));
      continue;
    }
    if (entry.index < previousIndex) {
      issues.push(issue(
        "Sections are out of order",
        `Use the required section order: ${sections.map((x) => `${x}:`).join(" → ")}`,
        null,
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
        `Duplicate ${entry.name} section`,
        `Keep one ${entry.name}: section and merge the duplicate content into it.`,
        null,
        { start: duplicate.index || 0, end: (duplicate.index || 0) + duplicate[0].length },
        `duplicate-section:${entry.name}`,
      ));
    }
    if (!entry.body) {
      issues.push(issue(
        `${entry.name} is empty`,
        `Add content below ${entry.name}:; the section header by itself is not enough.`,
        null,
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
  const content = match[1].replace(/\{additional task type if needed\}/gi, "");
  return content.split("+").map((value) => value.trim()).filter(Boolean);
}

function tokensIn(text) {
  const result = [];
  for (const match of String(text || "").matchAll(MEDIA_ANY_RE)) {
    const native = match[3] != null;
    const rawKind = String(native ? match[3] : match[1]).toLowerCase();
    const kind = rawKind === "picture" || rawKind === "image" ? "image" : rawKind === "videoaudio" ? "soundtrack" : rawKind;
    const ordinal = Number(native ? match[4] : match[2]);
    result.push({ kind, ordinal, token: match[0], index: match.index || 0, native });
  }
  return result;
}

function referenceTokenIssue(state, token, offset = 0) {
  if (token.ordinal <= 0) {
    const example = token.kind === "soundtrack" ? "@VideoAudio1" : `@${token.kind[0].toUpperCase()}${token.kind.slice(1)}1`;
    return issue(`${token.token} is invalid`, "H3 reference numbering is 1-based.", `Use ${example} or higher.`, { start: offset + token.index, end: offset + token.index + token.token.length }, "invalid-reference-ordinal");
  }
  if (token.kind === "subject") return null;
  if (token.kind === "soundtrack") {
    const enabled = token.ordinal <= state.videoCount && state.videoAudioEnabled?.[token.ordinal - 1] === true;
    if (!enabled) {
      return issue(
        `${token.token} is not available`,
        `Connect Reference Video ${token.ordinal} and enable its soundtrack, or remove ${token.token}. Runtime will still reject the alias if that VIDEO payload is silent.`,
        null,
        { start: offset + token.index, end: offset + token.index + token.token.length },
        "unresolved-video-audio",
      );
    }
    return null;
  }
  if (token.native && token.kind === "audio" && (state.enabledVideoAudioCount ?? state.videoCount) > 0) {
    // Native audio ordinals interleave enabled VIDEO soundtracks before
    // standalone audio. The browser cannot inspect VIDEO payloads, so runtime
    // is the first layer that can validate a literal <Audio K> exactly.
    return null;
  }
  const limit = token.kind === "image" ? state.imageCount : token.kind === "video" ? state.videoCount : state.audioCount;
  if (token.ordinal > limit) {
    const title = `${token.token} is not connected`;
    const builderLabel = state.conditioningProfile === PROFILE.REF2VA ? "Reference conditioning" : "first/last-frame conditioning";
    const message = `Only ${limit} ${token.kind} reference${limit === 1 ? " is" : "s are"} currently available to the active ${builderLabel} builder.`;
    return issue(title, `${message} Connect the matching reference or remove ${token.token}.`, null, { start: offset + token.index, end: offset + token.index + token.token.length }, "unresolved-reference");
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
    const rawKind = String(kindRaw).toLowerCase();
    const kind = rawKind === "videoaudio" ? "soundtrack" : rawKind;
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
    if (kind === "soundtrack") return full;
    const limit = kind === "image" ? state.imageCount : kind === "video" ? state.videoCount : kind === "audio" ? state.audioCount : 0;
    if (ordinal > limit) return full;
    if (kind === "image") return `<Picture ${ordinal}>`;
    if (kind === "video") return `<Video ${ordinal}>`;
    if (kind === "audio") {
      // A connected VIDEO may carry an embedded soundtrack, which occupies an
      // internal native <Audio N> ordinal before standalone audio. The browser
      // cannot inspect the runtime VIDEO payload, so do not invent the final
      // native ordinal here; execution resolves it exactly.
      return (state.enabledVideoAudioCount ?? state.videoCount) > 0 ? full : `<Audio ${ordinal}>`;
    }
    return full;
  });
}

function referenceDescriptors(images, videos, standaloneAudio, videoAudioEnabled = []) {
  const imageRefs = images.map((input, index) => ({ token: `@Image${index + 1}`, kind: "image", ordinal: index + 1, inputName: input.name, detail: "Reference picture." }));
  const videoRefs = videos.map((input, index) => ({
    token: `@Video${index + 1}`,
    kind: "video",
    ordinal: index + 1,
    inputName: input.name,
    detail: videoAudioEnabled[index] === false
      ? "Visual-only reference video; its soundtrack is muted. Use it for editing, continuation, or whole-video temporal structure."
      : `Reference video for editing, continuation, or whole-video temporal structure. If its VIDEO payload exposes a track, define the separate @VideoAudio${index + 1} relationship for soundtrack reuse/reference.`,
  }));
  return [...imageRefs, ...videoRefs, ...standaloneAudioDescriptors(standaloneAudio)];
}

function videoSoundtrackDescriptors(videos, videoAudioEnabled = []) {
  return videos.flatMap((input, index) => videoAudioEnabled[index] === false ? [] : [{
    token: `@VideoAudio${index + 1}`,
    kind: "soundtrack",
    ordinal: index + 1,
    inputName: input.name,
    detail: `Enabled soundtrack from @Video${index + 1}. Runtime resolves it only when the VIDEO payload exposes an audio track.`,
  }]);
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
  if (["Adaptive to keyframe (recommended)", "First/last frame image", "Connected first/last frame"].includes(raw)) return KEYFRAME_CANVAS_ADAPTIVE;
  if (raw === "Use selected canvas aspect") return "Aspect ratio setting";
  if (raw === "Aspect ratio control") return "Aspect ratio setting";
  return raw;
}

const PROMPT_FAMILY_BASE = "base";
const PROMPT_FAMILY_REFERENCE = "reference";
const PROMPT_OUTPUT_AUDIO = "audio";

// Prompt grammar, Loader provision, and physical conditioning are independent. A
// distinctive H3 structure chooses editor assistance only; connected media
// chooses the native builder that can consume it.
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
    markers.push({ index: source.indexOf(firstLine), family: PROMPT_FAMILY_BASE, marker: "first/last-frame alignment" });
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
    const hasSecondEndpoint = /(?:@Image2\b|<(?:Picture|Image)\s+2>|\b(?:Picture|Image)\s+2\b)/i.test(firstLine);
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
  const standaloneAudioInputs = connectedInputs(node, "ref_audio_");
  const videoAudioEnabled = videoInputs.map((input) => {
    const slot = inputOrdinal(input?.name, "ref_video_");
    return Boolean(widgetValue(node, `ref_video_use_audio_${slot}`, true));
  });
  const refs = referenceDescriptors(imageInputs, videoInputs, standaloneAudioInputs, videoAudioEnabled);
  const videoAudioRefs = videoSoundtrackDescriptors(videoInputs, videoAudioEnabled);
  const rawImageCount = imageInputs.length;
  const rawVideoCount = videoInputs.length;
  const rawAudioCount = standaloneAudioInputs.length;
  const requestedSeconds = Number(widgetValue(node, "seconds", H3E_DEFAULTS.seconds));
  const timing = effectiveTiming(requestedSeconds);
  const refVideoSize = String(widgetValue(node, "ref_video_size", H3E_DEFAULTS.refVideoSize));
  const refVideoTemporalFit = String(widgetValue(node, "ref_video_temporal_fit", H3E_DEFAULTS.refVideoTemporalFit));

  const audioMode = mode === MODE_AUDIO;
  const hasReferenceInputs = rawImageCount + rawVideoCount + rawAudioCount > 0;

  // Physical inputs choose the only native conditioning builder that can
  // consume them. Checkpoint selection remains independent.
  let conditioningProfile;
  if (hasReferenceInputs) conditioningProfile = PROFILE.REF2VA;
  else if (keyframes.length === 0) conditioningProfile = PROFILE.T2VA;
  else if (keyframes.length === 1) conditioningProfile = keyframeRole === KEYFRAME_LAST ? PROFILE.L2VA : PROFILE.I2VA;
  else conditioningProfile = PROFILE.FL2VA;

  const rawConditioningModel = String(widgetValue(node, "conditioning_model", H3E_DEFAULTS.conditioningModel) || H3E_DEFAULTS.conditioningModel);
  const removedConditioningModel = REMOVED_CONDITIONING_MODELS.has(rawConditioningModel);
  const modelSelection = removedConditioningModel
    ? rawConditioningModel
    : rawConditioningModel === CONDITIONING_MODEL_REF2VA
      ? CONDITIONING_MODEL_REF2VA
      : CONDITIONING_MODEL_FL2VA;
  const baseConditioningProfile = keyframes.length === 0
    ? PROFILE.T2VA
    : keyframes.length === 1
      ? (keyframeRole === KEYFRAME_LAST ? PROFILE.L2VA : PROFILE.I2VA)
      : PROFILE.FL2VA;
  const promptStructure = inferPromptStructure(prompt);

  // Prompt structure selects editor grammar only. It never changes Loader
  // provision or overrides the conditioning builder implied by physical inputs.
  let editorProfile = conditioningProfile;
  if (!promptStructure.conflict && promptStructure.family === PROMPT_FAMILY_REFERENCE) {
    editorProfile = PROFILE.REF2VA;
  } else if (!promptStructure.conflict && promptStructure.family === PROMPT_FAMILY_BASE) {
    editorProfile = promptStructure.profileHint || baseConditioningProfile;
  }

  const hasMixedInputFamilies = hasReferenceInputs && keyframes.length > 0;

  const referenceBuilderActive = hasReferenceInputs;
  const enabledVideoAudioCount = referenceBuilderActive ? videoAudioEnabled.filter(Boolean).length : 0;
  const mutedVideoAudioOrdinals = referenceBuilderActive
    ? videoAudioEnabled.flatMap((enabled, index) => (enabled ? [] : [index + 1]))
    : [];
  const physicalImageRefs = referenceBuilderActive
    ? refs.filter((ref) => ref.kind === "image")
    : keyframes.map((input, index) => ({ token: `@Image${index + 1}`, kind: "image", ordinal: index + 1, inputName: input.name, detail: "Connected first/last frame image." }));

  let audioTask = null;
  if (audioMode) {
    const kinds = [];
    if (referenceBuilderActive) {
      if (rawVideoCount > 0) kinds.push("video reference");
      if (rawImageCount > 0) kinds.push("image reference");
      if (rawAudioCount > 0) kinds.push("audio reference");
    }
    audioTask = kinds.length ? `${kinds.join(" + ")} · Easy audio proxy` : `${modelSelection} provision · Easy audio proxy`;
  }

  return {
    mode,
    editorProfile,
    audioMode,
    audioTask,
    conditioningProfile,
    modelSelection,
    removedConditioningModel,
    promptStructureConflict: promptStructure.conflict,
    editorProfileSource: promptStructure.conflict ? "mixed" : promptStructure.family ? "prompt" : "connections",
    hasMixedInputFamilies,
    keyframeRole,
    keyframeCanvas,
    canvasMode,
    keyframeCount: keyframes.length,
    imageCount: referenceBuilderActive ? rawImageCount : keyframes.length,
    videoCount: referenceBuilderActive ? rawVideoCount : 0,
    videoAudioEnabled: referenceBuilderActive ? videoAudioEnabled : [],
    enabledVideoAudioCount,
    mutedVideoAudioOrdinals,
    // @AudioN is the visible standalone-audio namespace. A synchronized track
    // exposed by a VIDEO payload receives its separate native Audio ordinal only
    // when the payload is inspected at execution.
    audioCount: referenceBuilderActive ? rawAudioCount : 0,
    standaloneAudioCount: referenceBuilderActive ? rawAudioCount : 0,
    mixedRefCount: referenceBuilderActive ? rawImageCount + rawVideoCount + rawAudioCount : keyframes.length,
    refs: referenceBuilderActive ? refs : physicalImageRefs,
    videoAudioRefs: referenceBuilderActive ? videoAudioRefs : [],
    audioReferenceCount: referenceBuilderActive ? rawAudioCount + videoAudioRefs.length : 0,
    requestedSeconds,
    frameCount: timing.frames,
    effectiveSeconds: timing.seconds,
    refVideoSize,
    refVideoTemporalFit,
  };
}

function validateShots(prompt, state) {
  const source = String(prompt || "");
  const shots = shotMarkers(source);
  const issues = [];
  if (!shots.length) {
    issues.push(issue("Missing opening [Shot 1]", "Add [Shot 1] at the start of the target playback timeline.", null, { start: 0, end: 0 }, "missing-shot"));
    return issues;
  }

  // Autofill emits MiniMax's canonical punctuation. Validation focuses on
  // semantic shot structure (number/order/time/range) rather than turning
  // cosmetic separators from examples into parser-like hard requirements.

  // Shot 1 begins at 0.000 implicitly, so every later cut must be > 0.
  let previousTime = 0;
  shots.forEach((shot, index) => {
    if (shot.number !== index + 1) {
      issues.push(issue("Shot numbering is not sequential", `Expected [Shot ${index + 1}] here, found [Shot ${shot.number}]. Renumber this marker to keep shots sequential.`, null, { start: shot.index, end: shot.end }, "shot-number"));
    }
    if (index === 0 && shot.time != null) {
      issues.push(issue("[Shot 1] must not have a timestamp", "Remove the timestamp from [Shot 1]; the first shot starts at 0.000 seconds implicitly.", null, { start: shot.index, end: shot.end }, "shot1-time"));
    }
    if (index > 0 && shot.time == null) {
      const lineEnd = source.indexOf("\n", shot.end);
      const lineTail = source.slice(shot.end, lineEnd >= 0 ? lineEnd : source.length);
      const hasTimestampWithSeparatorProblem = /^[ \t]+At[ \t]+\d{2}:\d{2}\.\d{3}(?:[ \t]*[,;:.\-–—]?)/i.test(lineTail);
      const hasShotMarkerSeparatorProblem = /^[ \t]*[,:;.\-–—][ \t]*At[ \t]+\d{2}:\d{2}\.\d{3}/i.test(lineTail);
      const hasMissingSpaceBeforeAt = /^At[ \t]+\d{2}:\d{2}\.\d{3}/i.test(lineTail);
      if (!hasTimestampWithSeparatorProblem && !hasShotMarkerSeparatorProblem && !hasMissingSpaceBeforeAt) {
        issues.push(issue(`Missing cut time for [Shot ${shot.number}]`, "Later shots use the official '[Shot N] At MM:SS.mmm,' form.", `[Shot ${shot.number}] At 00:03.500, a close shot frames the subject as the next action begins.`, { start: shot.index, end: shot.end }, "shot-time"));
      }
    }
    if (shot.time != null) {
      if (shot.time <= previousTime) issues.push(issue("Shot cut times must increase", "Move this cut later than the previous shot cut; later shot timestamps must increase strictly.", null, { start: shot.index, end: shot.end }, "shot-time-order"));
      if (shot.time >= state.effectiveSeconds) issues.push(issue("Shot cut is outside the target duration", `Move this cut below ${state.effectiveSeconds.toFixed(2)} seconds; that is the snapped target duration.`, null, { start: shot.index, end: shot.end }, "shot-time-range"));
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
        `${timelineName}:\n[Shot 1] A medium shot frames the speaker. (S1) says, <d>[English] Spoken text.</d>`,
        { start, end },
        "dialogue-outside-timeline",
      ));
    }

    const vocalClause = vocalClauseBefore(source, start);
    const speakerMatches = [...vocalClause.matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/gi)];
    const speakerMatch = speakerMatches.at(-1) || null;
    // A directly reused soundtrack/BGM cue may use an audio-reference label as the audible
    // source without inventing a speaker. This is also the one context where
    // the editor can safely infer the full-reference guide's source-audio
    // punctuation normalization without guessing dialogue provenance.
    const audioSourceMatch = state.conditioningProfile === PROFILE.REF2VA
      && /(?:@(?:VideoAudio|Audio)\d+\b|<Audio\s+\d+>)/i.test(vocalClause)
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
      // when this line is unambiguously a tracked audio-source cue; ordinary
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
      issues.push(issue("Dialogue has no speaker or audio-source ID", "Identify a concrete vocal source with (S1)/(S2), or in Reference conditioning use @AudioN or @VideoAudioN only when the verbal content is a cue inside directly reused reference audio.", "@Subject1 (S1) says, <d>[English] Hello.</d>", { start, end }, "dialogue-speaker"));
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
  const referenceBuilder = state.conditioningProfile === PROFILE.REF2VA;
  for (const token of tokensIn(prompt)) {
    if (!referenceBuilder && token.kind !== "image") {
      issues.push(issue(
        `${token.token} needs a connected Reference input`,
        "No Reference media are connected, so the native text/first-last-frame builder is active. Connect a Reference image, video, or audio input before using Subject, Video, or Audio reference labels.",
        null,
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
  if (state.removedConditioningModel) {
    issues.push(issue(
      "Audio override was removed",
      "H3 has two checkpoint provisions. Choose FL2VA or REF2VA in Model; Audio-only mode uses whichever provision you select.",
      null,
      null,
      "removed-audio-model",
    ));
  }
  if (state.promptStructureConflict) {
    issues.push(issue(
      "Prompt mixes base and Reference structures",
      "The prompt contains both base/T2VA and REF2VA top-level markers. Keep one structure: integrated_multimodal_description: for base prompts, or the six-section subject_definitions: … detailed_description: structure for Reference prompts.",
      null,
      null,
      "mixed-prompt-structures",
    ));
  }
  if (state.hasMixedInputFamilies) {
    issues.push(issue(
      "Disconnect one physical input family",
      "Reference media and first/last-frame inputs use different native H3 builders and cannot be combined. Disconnect either every Reference input or every first/last-frame input before queueing. Model and prompt grammar remain independent.",
      null,
      null,
      "mixed-input-families",
    ));
  }
  if (!Number.isFinite(state.requestedSeconds) || state.requestedSeconds < 1 || state.requestedSeconds > 30) {
    issues.push(issue(
      "Invalid output duration",
      "Video duration must be a finite number from 1 through 30 seconds.",
      null,
      null,
      "invalid-output-duration",
    ));
  }
  return issues;
}

function generationNotes(state, prompt = "") {
  const notes = [];
  if (state.audioMode && state.keyframeCount > 0 && state.conditioningProfile !== PROFILE.REF2VA) {
    notes.push(note(
      "Endpoint frames are being conditioned into the 32x32 audio proxy",
      "Audio-only mode keeps the connected base/keyframe path instead of blocking it. The visual target is intentionally only 32x32, so first/last-frame image detail is heavily discarded; use Reference images instead when visual identity should guide audio generation.",
      null,
      "audio-keyframe-proxy",
    ));
  }
  if (state.conditioningProfile === PROFILE.REF2VA && state.videoCount > 0) {
    notes.push(note(
      "Reference VIDEO payload metadata is read at execution",
      "Easy reads the VIDEO source frame rate and normalizes frames to H3's 24 fps reference timeline. For each enabled video slot, runtime forwards a synchronized track as a separate native Audio reference only when the payload exposes one. A video's presence alone does not declare prompt-level audio reuse/reference.",
      null,
      "reference-video-av",
    ));
    if (state.mutedVideoAudioOrdinals?.length) {
      const labels = state.mutedVideoAudioOrdinals.map((ordinal) => `Video ${ordinal}`).join(", ");
      notes.push(note(
        `Reference soundtrack muted for ${labels}`,
        "Easy excludes the corresponding embedded soundtrack from H3 conditioning while keeping the video's frames, source timing, and visual/temporal prompt role.",
        null,
        "reference-video-audio-muted",
      ));
    }
    if (String(state.refVideoSize) !== H3E_DEFAULTS.refVideoSize) {
      notes.push(note(
        `Reference video resolution is reduced: ${state.refVideoSize}`,
        `This caps reference video latents below MiniMax H3's 768-class reference geometry when the source exceeds the selected class. Source aspect is preserved as closely as H3's 32-pixel alignment allows, but fine motion, small details, or identity cues may weaken. Info reports the exact geometry/aspect delta. Use ${H3E_DEFAULTS.refVideoSize} when adherence matters more than speed.`,
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
  if (state.conditioningProfile === PROFILE.REF2VA && (state.enabledVideoAudioCount ?? state.videoCount) > 0 && state.standaloneAudioCount > 0) {
    notes.push(note(
      "Standalone audio native numbering resolves at execution",
      "A VIDEO payload may expose an enabled synchronized audio track, which MiniMax presents internally before standalone audio references. Easy keeps @AudioN user-facing numbering limited to standalone Reference audio inputs and resolves the final native <Audio N> ordinal when the payload is inspected at execution.",
      null,
      "reference-video-audio-ordinal",
    ));
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

    const source = String(prompt || "");
    if (/@VideoAudio\d+\b/i.test(source)) {
      notes.push(note(
        "Video soundtrack aliases resolve at execution",
        "@VideoAudioN names the enabled soundtrack attached to visible Reference Video N. The browser cannot inspect the VIDEO payload; runtime converts the alias to the actual native <Audio K> ordinal or errors if that video is muted or silent.",
        null,
        "video-audio-alias-runtime",
      ));
    }
    if (/<Audio\s+\d+>/i.test(source) && (state.enabledVideoAudioCount ?? state.videoCount) > 0) {
      notes.push(note(
        "Native audio ordinals resolve only at execution",
        "Enabled VIDEO soundtracks and standalone audio share the native <Audio K> namespace. The browser cannot know which VIDEO payloads contain tracks, so prefer @VideoAudioN for a video's enabled soundtrack and @AudioN for standalone Reference audio; runtime validates literal native ordinals.",
        null,
        "native-audio-ordinal-runtime",
      ));
    }
    for (const ref of state.refs) {
      const native = ref.kind === "image" ? `<Picture ${ref.ordinal}>` : ref.kind === "video" ? `<Video ${ref.ordinal}>` : `<Audio ${ref.ordinal}>`;
      const easyAlias = new RegExp(`${ref.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "i");
      const soundtrackAlias = ref.kind === "video" ? new RegExp(`@VideoAudio${ref.ordinal}(?!\\d)`, "i") : null;
      if (!source.includes(native) && !easyAlias.test(source)) {
        const soundtrackOnly = soundtrackAlias?.test(source) ?? false;
        notes.push(note(
          soundtrackOnly ? `${ref.token} frames have no visual role in the prompt` : `${ref.token} is connected but has no semantic role in the prompt`,
          soundtrackOnly
            ? `@VideoAudio${ref.ordinal} defines only the soundtrack role. H3 still encodes ${ref.token}'s frames, so define what the video contributes visually/temporally, or extract/connect the audio as standalone Reference audio when the frames should not condition generation.`
            : "H3 still encodes every connected reference, so an unused reference costs conditioning tokens and can add ambiguity. Define what this asset contributes in subject_definitions, or disconnect it.",
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

function validateReferenceInputs(_state) {
  return [];
}


function validateReference(prompt, state) {
  const issues = [...validateReferenceInputs(state), ...sectionIssues(prompt, REF_SECTIONS)];
  const notes = [];
  const sections = sectionMap(prompt, REF_SECTIONS);

  const firstNonWhitespace = String(prompt || "").search(/\S/);
  const allRefSectionsPresent = REF_SECTIONS.every((name) => (sections[name]?.index ?? -1) >= 0);
  const hasRefSectionOrderIssue = issues.some((item) => item.code === "section-order");
  if (firstNonWhitespace >= 0 && allRefSectionsPresent && !hasRefSectionOrderIssue && !/^\s*subject_definitions\s*:/i.test(String(prompt || ""))) {
    issues.push(issue("Reference prompt has text before subject_definitions", "Move or remove the leading text so subject_definitions: is the first top-level section.", null, { start: firstNonWhitespace, end: Math.min(String(prompt).length, firstNonWhitespace + 40) }, "ref-start"));
  }

  const summary = sections.summary?.body || "";
  const hasPendingTaskPlaceholder = /^\s*(?:\[\{summary task type\}\]|\{summary task type\})/i.test(summary);
  const summaryTasks = hasPendingTaskPlaceholder ? null : taskPrefix(summary);
  if (hasParagraphBreak(summary)) {
    issues.push(issue(
      "Keep summary in one paragraph",
      "MiniMax specifies one short continuous English paragraph after the task-type prefix. Remove blank-line paragraph breaks and keep shot-by-shot execution in detailed_description.",
      "[reference generation] The target video uses @Subject1 as the character reference while following a single continuous action.",
      sections.summary ? { start: sections.summary.bodyStart, end: sections.summary.bodyEnd } : null,
      "summary-paragraphs",
    ));
  }
  if (sections.summary?.index >= 0) {
    if (!summaryTasks && !hasPendingTaskPlaceholder) {
      issues.push(issue("Missing summary task prefix", "summary: begins with one or more official task types in square brackets.", "summary:\n[reference generation] The target video uses @Subject1 as the character reference for a single-shot standing-backflip sequence.", { start: sections.summary.bodyStart, end: sections.summary.bodyEnd }, "summary-prefix"));
    } else if (summaryTasks) {
      const invalid = summaryTasks.filter((value) => !TASK_SET.has(value));
      if (invalid.length) issues.push(issue("Unknown summary task type", `Unsupported task type${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}.`, "[reference generation] The target video preserves @Subject1 as the main character reference.", { start: sections.summary.bodyStart, end: sections.summary.bodyEnd }, "summary-task"));
      const duplicates = summaryTasks.filter((value, index) => summaryTasks.indexOf(value) !== index);
      if (duplicates.length) issues.push(issue("Repeated summary task type", "Each summary task type should appear only once in the combined [type + type] prefix.", `[${[...new Set(summaryTasks)].join(" + ")}] The target video follows the stated reference relationship in a single coherent sequence.`, { start: sections.summary.bodyStart, end: sections.summary.bodyEnd }, "summary-task-duplicate"));
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
      const match = rawLine.match(/^[ \t]*(?:@(VideoAudio|Subject|Image|Video|Audio)\d+\b|<(?:Subject|Picture|Image|Video|Audio)\s+\d+>)[ \t]*([:\-–—])/i);
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
        ? `${token.token} is the same character shown in @Image1, preserving the face, clothing, and body proportions from that image.`
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
      const marker = isAudioReferenceKind(token.kind) ? "reference" : "fully_preserved";
      const occurrence = isAudioReferenceKind(token.kind) ? "" : " (appears in [Shot 1])";
      const action = isAudioReferenceKind(token.kind) ? "state the copied/referenced audio relationship" : "state what is preserved, transferred, or weakly referenced";
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
          `${first.token}: ${isAudioReferenceKind(first.kind) ? "reference - use the source voice timbre as guidance." : "fully_preserved - preserve the defined appearance and role."}`,
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
        "Each separately tracked reference gets one retention_analysis: row. Merge all preserved/transferred/reused details for this label into the first row and delete the duplicate.",
        null,
        { start: lineStart + leading.index, end: lineStart + leading.index + leading.token.length },
        "duplicate-retention-row",
      ));
    } else {
      seenRetentionRows.add(key);
    }

    if (/\(S\d+(?:\s*,\s*S\d+)*\)/i.test(rawLine)) {
      issues.push(issue("Speaker ID inside retention_analysis", "Remove the (S#) speaker ID from this retention row; speaker IDs belong to vocal events in detailed_description.", "@Subject1 (appears in [Shot 1]): fully_preserved - preserve identity, clothing, and body proportions.", { start: lineStart, end: lineStart + rawLine.length }, "retention-speaker"));
    }
    const isAudio = isAudioReferenceKind(leading.kind);
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
        `[${combined.join(" + ")}] The target video uses the declared audio relationship while preserving the stated visual references.`,
        sections.summary ? { start: sections.summary.bodyStart, end: sections.summary.bodyEnd } : null,
        "summary-audio-task-consistency",
      ));
    }
  }

  const detailed = sections.detailed_description?.body || "";
  if (/The target video uses\s+\.\.\./i.test(detailed) || /\[Shot\s+1\]\s+\.\.\./i.test(detailed)) {
    issues.push(issue("Complete detailed_description", "Replace the remaining editor scaffold with the actual overall style and playback-order shot description.", "The target video uses a realistic cinematic style with soft studio lighting.\n\n[Shot 1] A full-body shot frames @Subject1 at eye level as she steps forward and raises her right hand.", { start: sections.detailed_description?.bodyStart || 0, end: sections.detailed_description?.bodyEnd || 0 }, "detailed-scaffold"));
  }
  const firstShotIndex = detailed.search(/^\s*\[Shot\s+1\]/im);
  if (firstShotIndex === 0) {
    issues.push(issue("Add visual style before [Shot 1]", "Reference detailed_description should establish the target video's overall visual style in one or two English sentences before the first shot.", "The target video uses a realistic cinematic style with soft studio lighting and natural materials.\n\n[Shot 1] A medium shot frames @Subject1 at eye level.", { start: sections.detailed_description?.bodyStart || 0, end: sections.detailed_description?.bodyStart || 0 }, "ref-style"));
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
    issues.push(issue("Complete overall_soundscape", "Replace the scaffold with the ambience, physical and other non-verbal sounds that persist across the clip; use N/A only for intentional silence.", "overall_soundscape: Quiet room tone, soft clothing rustle, and footsteps on wood remain audible beneath the dialogue.", { start: sections.overall_soundscape?.bodyStart || 0, end: sections.overall_soundscape?.bodyEnd || 0 }, "soundscape-scaffold"));
  }
  if (/^\.\.\.$/.test((sections.non_diegetic_music?.body || "").trim())) {
    issues.push(issue("Complete non_diegetic_music", "Replace the scaffold with audience-only score details, or use N/A when there is no non-diegetic music.", "non_diegetic_music: Sparse low strings with a slow pulse build gently through the final shot.", { start: sections.non_diegetic_music?.bodyStart || 0, end: sections.non_diegetic_music?.bodyEnd || 0 }, "music-scaffold"));
  }
  if (/^N\/A\s*$/i.test(sections.overall_soundscape?.body || "")) notes.push(note("Soundscape is N/A", "Use N/A only when the intended video is explicitly silent; otherwise describe the overall ambience/physical soundscape.", sections.overall_soundscape ? { start: sections.overall_soundscape.bodyStart, end: sections.overall_soundscape.bodyEnd } : null, "soundscape-na"));
  issues.push(...audioParagraphIssues(sections));

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
    const allBaseSectionsPresent = BASE_SECTIONS.every((name) => (sections[name]?.index ?? -1) >= 0);
    const hasSectionOrderIssue = issues.some((item) => item.code === "section-order");
    if (allBaseSectionsPresent && !hasSectionOrderIssue && !/^\s*integrated_multimodal_description\s*:/i.test(source)) {
      issues.push(issue("T2VA prompt has text before integrated_multimodal_description", "Move or remove the leading text so integrated_multimodal_description: is the first top-level section.", null, { start: 0, end: Math.min(source.length, 80) }, "t2-start"));
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
    issues.push(issue("Complete [Shot 1]", "Replace the remaining shot scaffold with the actual framing, subject state and playback-order action.", "[Shot 1] A medium shot frames the woman at eye level as she turns toward the window and lifts the curtain.", { start: Math.max(0, idx), end: Math.max(0, idx) + 12 }, "base-shot-scaffold"));
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
    issues.push(issue("Complete overall_soundscape", "Replace the scaffold with the ambience, physical and other non-verbal sounds that persist across the clip; use N/A only for intentional silence.", "overall_soundscape: Quiet room tone, soft clothing rustle, and footsteps on wood remain audible beneath the dialogue.", { start: sections.overall_soundscape?.bodyStart || 0, end: sections.overall_soundscape?.bodyEnd || 0 }, "soundscape-scaffold"));
  }
  if (/^\.\.\.$/.test((sections.non_diegetic_music?.body || "").trim())) {
    issues.push(issue("Complete non_diegetic_music", "Replace the scaffold with audience-only score details, or use N/A when there is no non-diegetic music.", "non_diegetic_music: Sparse low strings with a slow pulse build gently through the final shot.", { start: sections.non_diegetic_music?.bodyStart || 0, end: sections.non_diegetic_music?.bodyEnd || 0 }, "music-scaffold"));
  }
  if (/^N\/A\s*$/i.test(sections.overall_soundscape?.body || "")) notes.push(note("Soundscape is N/A", "Use N/A only when the intended video is explicitly silent; otherwise describe the overall ambience/physical soundscape.", sections.overall_soundscape ? { start: sections.overall_soundscape.bodyStart, end: sections.overall_soundscape.bodyEnd } : null, "soundscape-na"));
  issues.push(...audioParagraphIssues(sections));
  return { issues, notes };
}

function editorPlaceholderRanges(prompt) {
  const source = String(prompt || "");
  const ranges = [];
  for (const match of source.matchAll(/\{([^{}\n]+)\}/g)) {
    const key = String(match[1] || "").trim();
    if (!Object.prototype.hasOwnProperty.call(EDITOR_PLACEHOLDER_HELP, key)) continue;
    const start = match.index ?? 0;
    ranges.push({ key, help: EDITOR_PLACEHOLDER_HELP[key], range: { start, end: start + match[0].length } });
  }
  return ranges;
}

function editorPlaceholderIssues(prompt) {
  return editorPlaceholderRanges(prompt).map(({ key, help, range }) => issue(
    `Fill {${key}}`,
    `${help} Curly-brace placeholders are editor scaffolds only and must not remain in the final MiniMax prompt.`,
    null,
    range,
    `editor-placeholder-${key}`,
  ));
}

function legacySectionScaffold(body) {
  const value = String(body || "").trim();
  return value === "..."
    || /^\[Shot\s+1\]\s+\.\.\.$/i.test(value)
    || /^The target video uses\s+\.\.\.(?:\s*\n+\s*\[Shot\s+1\]\s+\.\.\.)?$/i.test(value);
}

export function guideSectionProgress(prompt, state) {
  const source = String(prompt || "");
  const sectionNames = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
  const ranges = sectionRanges(source, sectionNames);
  const placeholders = editorPlaceholderRanges(source);
  let previousIndex = -1;

  const entries = ranges.map((entry, index) => {
    const headerMatches = [...source.matchAll(new RegExp(`^[ \\t]*${entry.name}[ \\t]*:`, "gim"))];
    const inOrder = entry.index < 0 || entry.index > previousIndex;
    if (entry.index >= 0) previousIndex = Math.max(previousIndex, entry.index);
    const sectionPlaceholders = entry.index >= 0
      ? placeholders.filter((item) => item.range.start >= entry.bodyStart && item.range.start < entry.bodyEnd)
      : [];
    const scaffold = legacySectionScaffold(entry.body);
    const targets = [];

    if (entry.index < 0) {
      const nextPresent = ranges.slice(index + 1).find((candidate) => candidate.index >= 0);
      const insertion = nextPresent?.index ?? source.length;
      targets.push({
        section: entry.name,
        reason: "missing",
        range: { start: insertion, end: insertion },
        placeholderKey: null,
        label: `Add ${entry.name}:`,
      });
    } else {
      for (const duplicate of headerMatches.slice(1)) {
        const duplicateStart = duplicate.index ?? entry.index;
        targets.push({
          section: entry.name,
          reason: "duplicate",
          range: { start: duplicateStart, end: duplicateStart + duplicate[0].length },
          placeholderKey: null,
          label: `Remove duplicate ${entry.name}:`,
        });
      }
      if (!inOrder) {
        targets.push({
          section: entry.name,
          reason: "out of order",
          range: { start: entry.index, end: entry.headerEnd },
          placeholderKey: null,
          label: `Reorder ${entry.name}:`,
        });
      }
      if (!entry.body) {
        targets.push({
          section: entry.name,
          reason: "empty",
          range: { start: entry.bodyStart, end: entry.bodyStart },
          placeholderKey: null,
          label: `Fill ${entry.name}:`,
        });
      } else {
        for (const placeholder of sectionPlaceholders) {
          targets.push({
            section: entry.name,
            reason: "placeholder",
            range: placeholder.range,
            placeholderKey: placeholder.key,
            label: `Fill {${placeholder.key}}`,
          });
        }
        if (!sectionPlaceholders.length && scaffold) {
          targets.push({
            section: entry.name,
            reason: "scaffold",
            range: { start: entry.bodyStart, end: entry.bodyEnd },
            placeholderKey: null,
            label: `Replace ${entry.name} scaffold`,
          });
        }
      }
    }
    return { section: entry.name, ready: targets.length === 0, targets };
  });
  const targets = entries.flatMap((entry) => entry.targets);
  const next = targets[0] || null;
  return {
    profile: state.editorProfile,
    ready: entries.filter((entry) => entry.ready).length,
    total: entries.length,
    remaining: targets.length,
    targets,
    nextSection: next?.section || null,
    nextReason: next?.reason || null,
    nextRange: next?.range || null,
    nextPlaceholderKey: next?.placeholderKey || null,
    nextLabel: next?.label || null,
  };
}

function guideProgressWithIssues(prompt, state, issues) {
  const progress = guideSectionProgress(prompt, state);
  const targets = [...progress.targets];
  const sectionNames = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
  const sections = sectionRanges(String(prompt || ""), sectionNames);
  const validationTargets = new Set();

  for (const item of issues) {
    if (!item?.range) continue;
    const code = String(item.code || "");
    if (/^(?:missing|duplicate|empty)-section:/.test(code) || code === "section-order" || code.startsWith("editor-placeholder-") || code.endsWith("-scaffold")) continue;
    const start = Number(item.range.start);
    const end = Number(item.range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const targetKey = `${code}:${start}:${end}`;
    if (validationTargets.has(targetKey)) continue;
    validationTargets.add(targetKey);
    const owner = sections.find((section) => section.index >= 0 && start >= section.index && start <= section.bodyEnd);
    targets.push({
      section: owner?.name || "prompt",
      reason: "validation",
      range: { start, end },
      placeholderKey: null,
      label: item.title,
      code,
    });
  }

  const next = targets[0] || null;
  return {
    ...progress,
    remaining: targets.length,
    targets,
    nextSection: next?.section || null,
    nextReason: next?.reason || null,
    nextRange: next?.range || null,
    nextPlaceholderKey: next?.placeholderKey || null,
    nextLabel: next?.label || null,
  };
}

function validateAudioFirst(prompt, state) {
  if (!state.audioMode) return { issues: [], notes: [] };
  const issues = [];
  const notes = [];
  const source = String(prompt || "");

  if (state.conditioningProfile === PROFILE.REF2VA) {
    if ((state.enabledVideoAudioCount ?? state.videoCount) > 0) {
      notes.push(note(
        "Enabled Reference VIDEO soundtracks need explicit audio roles",
        "Easy forwards an enabled soundtrack when the VIDEO payload contains one, but video presence alone does not declare audio reuse or reference. Define @VideoAudioN when the soundtrack should affect the target prompt, or turn off that video's Use audio control for visual/timing-only guidance.",
        null,
        "audio-v2a-video-av",
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
  const hasAudioRef = /(?:@(?:VideoAudio|Audio)\d+\b|<Audio\s+\d+>)/i.test(source);
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
  const base = state.editorProfile === PROFILE.REF2VA ? validateReference(prompt, state) : validateBase(prompt, state);
  const audio = validateAudioFirst(prompt, state);
  const timelineSection = state.editorProfile === PROFILE.REF2VA ? "detailed_description" : "integrated_multimodal_description";
  const timelineSections = state.editorProfile === PROFILE.REF2VA ? REF_SECTIONS : BASE_SECTIONS;
  const hasTimelineSection = (sectionMap(prompt, timelineSections)[timelineSection]?.index ?? -1) >= 0;
  const issues = dedupe([...generationInputIssues(state), ...validatePhysicalReferences(prompt, state), ...base.issues, ...audio.issues, ...editorPlaceholderIssues(prompt), ...(hasTimelineSection ? validateShots(prompt, state) : []), ...validateDialogue(prompt, state)]);
  const notes = [...base.notes, ...audio.notes, ...generationNotes(state, prompt)];
  return {
    issues,
    notes: dedupe(notes),
    guideProgress: guideProgressWithIssues(prompt, state, issues),
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
    // Easy-specific audio-only proxy. Model selection stays independent while
    // the prompt keeps MiniMax's official six-section Reference grammar.
    const audioStarterTask = String(state.audioStarterTask || "R2A").toUpperCase();
    const subjectDefinitionLead = {
      I2A: "@Subject1 is {subject / scene} shown in @Image1; use @Image1 only as the source of that visible content.",
      V2A: "@Video1 is the whole-video temporal-structure reference for the target video.",
    }[audioStarterTask] || "{define tracked reference content}";
    const additionalDefinitionField = ["I2A", "V2A"].includes(audioStarterTask);
    const summaryLead = {
      R2A: "The defined Reference relationships guide the intended audio while the target video's visual stream remains a minimal proxy.",
      I2A: "@Subject1 guides the scene context for the intended audio while the target video's visual stream remains a minimal proxy.",
      V2A: "@Video1 guides timing and whole-video temporal structure while the target video's visual stream remains a minimal proxy.",
      A2A: "@Audio1 guides the intended audio while the target video's visual stream remains a minimal proxy.",
    }[audioStarterTask] || "The defined Reference relationships guide the intended audio while the target video's visual stream remains a minimal proxy.";
    const detailedLead = {
      I2A: "The target audio follows @Subject1's defined scene context.",
      V2A: "The target audio follows @Video1's whole-video temporal structure.",
      A2A: "The target audio follows the stated @Audio1 reuse or reference relationship.",
    }[audioStarterTask] || "The target audio follows the defined Reference relationships.";
    return [
      "subject_definitions:",
      subjectDefinitionLead,
      ...(additionalDefinitionField ? ["{define tracked reference content}"] : []),
      "",
      "summary:",
      `[{summary task type}] ${summaryLead} {target video + main reference relationships}`,
      "",
      "retention_analysis:",
      "{retention rows for tracked references}",
      "",
      "detailed_description:",
      "The proxy video remains visually minimal and static; audio is the intended output.",
      `[Shot 1] ${detailedLead} {audio events in playback order}. {synchronized sound / dialogue if present}.`,
      "",
      "overall_soundscape:",
      "{ambience + physical / non-verbal sounds, or N/A only if completely silent}",
      "",
      "non_diegetic_music:",
      "{audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A}",
    ].join("\n");
  }
  if (state.editorProfile === PROFILE.REF2VA) {
    // MiniMax's full-reference format is always these six sections in this order.
    // Reference presence alone never guesses semantic role; the user defines it.
    return [
      "subject_definitions:",
      "{define tracked reference content}",
      "",
      "summary:",
      "[{summary task type}] {target video + main reference relationships}",
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
    // Keyframe styles should come from the supplied image rather than an arbitrary
    // style preset. The editable field describes the actual image anchors.
    shot = "[Shot 1] The shot begins from @Image1, preserving its visual style, subject identity, composition, and scene anchors: {subject / scene / composition}. {action onset}. {continuous development}. {result / reaction}. {camera movement if needed}. {synchronized sound / dialogue if present}.";
  } else if (state.editorProfile === PROFILE.FL2VA) {
    const opening = state.keyframeRole === KEYFRAME_LAST ? "@Image2" : "@Image1";
    const ending = state.keyframeRole === KEYFRAME_LAST ? "@Image1" : "@Image2";
    shot = `[Shot 1] The shot begins from ${opening} and follows a continuous visual path toward ${ending}. {first-frame visible state}. {changes between first and last frame}. {approach to final frame}, reaching ${ending} as the final frame. {camera movement if needed}. {synchronized sound / dialogue if present}.`;
  } else if (state.editorProfile === PROFILE.L2VA) {
    shot = "[Shot 1] The shot begins from a plausible earlier state compatible with @Image1. {state before the final frame}. {motion toward the final frame}. {final-frame convergence}, landing on @Image1 as the final frame. {camera movement if needed}. {synchronized sound / dialogue if present}.";
  } else if (state.audioMode) {
    // Easy-specific proxy on the official base three-field grammar.
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
  const selected = state.modelSelection || CONDITIONING_MODEL_FL2VA;
  const builder = state.conditioningProfile === PROFILE.REF2VA ? "Reference" : "Text / first-last frames";
  const grammar = state.editorProfile === PROFILE.REF2VA ? "REF2VA" : state.editorProfile;
  const grammarNote = state.editorProfileSource === "mixed"
    ? " Prompt structure mixes Base and Reference markers."
    : state.editorProfileSource === "prompt"
      ? ` Prompt grammar recognized as ${grammar}.`
      : ` Writing helper follows ${grammar} until the prompt establishes a recognizable structure.`;
  const ignored = state.hasMixedInputFamilies
    ? " Reference media and endpoint frames require different native builders; disconnect one physical input family before queueing."
    : "";
  const audio = state.audioMode
    ? " Audio only is an Easy proxy: H3 still generates a joint AV latent and Easy keeps a disposable 32x32 visual stream."
    : "";
  const muted = state.mutedVideoAudioOrdinals?.length
    ? ` Embedded audio ignored for ${state.mutedVideoAudioOrdinals.map((ordinal) => `Video ${ordinal}`).join(", ")}.`
    : "";
  return `Provision: ${selected} from Easy Loader. Conditioning builder: ${builder}.${grammarNote} Provision, builder, and prompt grammar are independent. Downstream LoRAs and model patches are outside this node and are not inspected.${ignored}${audio}${muted}`;
}
