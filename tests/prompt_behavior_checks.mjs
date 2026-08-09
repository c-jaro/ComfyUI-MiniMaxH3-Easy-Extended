import assert from "node:assert/strict";
import { PROFILE, KEYFRAME_FIRST, KEYFRAME_CANVAS_ADAPTIVE, MODE_VIDEO, MODE_AUDIO, descriptionOptions } from "../web/h3_guidelines.js";
import { compilePromptPreview, effectiveTiming, firstLineForState, inferPromptStructure, nodeState, profileDescription, templateForState, validatePrompt } from "../web/h3_validator.js";

function state(profile, overrides = {}) {
  const timing = effectiveTiming(5);
  return {
    editorProfile: profile,
    conditioningProfile: profile,
    inputConditioningProfile: profile,
    editorProfileSource: "inputs",
    requestedSeconds: 5,
    effectiveSeconds: timing.seconds,
    frameCount: timing.frames,
    playbackFps: 24,
    keyframeRole: KEYFRAME_FIRST,
    keyframeCanvas: KEYFRAME_CANVAS_ADAPTIVE,
    canvasMode: "768P (native)",
    imageCount: profile === PROFILE.REF2VA ? 1 : (profile === PROFILE.T2VA ? 0 : 1),
    videoCount: 0,
    audioCount: 0,
    standaloneAudioCount: 0,
    pairedAudioCount: 0,
    mixedRefCount: profile === PROFILE.REF2VA ? 1 : 0,
    refs: profile === PROFILE.REF2VA ? [{ token: "@Image1", kind: "image", ordinal: 1 }] : [],
    orphanPairedAudioNames: [],
    refVideoFpsValues: [],
    refVideoFpsRawValues: [],
    refVideoSize: "768P native",
    refVideoTemporalFit: "Trim tail to valid H3 frame count",
    rawPlaybackFps: 24,
    ...overrides,
  };
}

function codes(result) {
  return new Set(result.issues.map((item) => item.code));
}

{
  const prompt = `integrated_multimodal_description:\n[Shot 1] Live-action, a medium shot frames a woman. The woman with a calm low voice (S1) says, <d>[English] Hello</d>\n\noverall_soundscape:\nRoom tone and soft footsteps continue.\n\nnon_diegetic_music:\nN/A`;
  const result = validatePrompt(prompt, state(PROFILE.T2VA));
  assert.equal(codes(result).has("dialogue-terminal-punctuation"), false, "base modes must not impose REF punctuation normalization");
  console.log("PASS base dialogue preserves punctuation contract");
}

{
  const prompt = `subject_definitions:
@Subject1 is the woman shown in @Image1.

summary:
[reference generation] The target video uses @Subject1 as the visible character.

retention_analysis:
@Subject1 (appears in [Shot 1]): fully_preserved - preserve her defined appearance.

detailed_description:
The target video uses a live-action cinematic style with soft neutral lighting.
[Shot 1] A medium shot frames @Subject1. The woman with a calm low voice (S1) says, <d>[English] Hello</d>

overall_soundscape:
Room tone and soft footsteps continue.

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, state(PROFILE.REF2VA));
  assert.equal(codes(result).has("dialogue-terminal-punctuation"), false, "Reference conditioning alone must not imply dialogue was copied from source audio");
  console.log("PASS new Reference-mode dialogue preserves user punctuation");
}

{
  const prompt = `subject_definitions:
@Audio1 is a directly reused soundtrack cue.

summary:
[audio reuse] The target video directly reuses @Audio1.

retention_analysis:
@Audio1: fully_copy - reuse the source cue.

detailed_description:
The target video uses a live-action cinematic style with neutral lighting.
[Shot 1] When @Audio1 reaches the phrase <d>[English] Hello</d>, the image remains static.

overall_soundscape:
Room tone continues.

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, state(PROFILE.REF2VA, {
    imageCount: 1,
    audioCount: 1,
    standaloneAudioCount: 1,
    mixedRefCount: 2,
    refs: [
      { token: "@Image1", kind: "image", ordinal: 1 },
      { token: "@Audio1", kind: "audio", ordinal: 1 },
    ],
  }));
  assert.equal(codes(result).has("dialogue-terminal-punctuation"), true, "directly reused @AudioN verbal content should use the reference-audio punctuation normalization");
  assert.equal(codes(result).has("dialogue-speaker"), false, "direct soundtrack verbal cues do not require an invented speaker ID");
  console.log("PASS direct reference-audio cue uses source-audio punctuation contract");
}

{
  const prompt = `subject_definitions:\n@Subject1 is the woman shown in @Image1.\n\nsummary:\n[reference generation] (S9) says, <d>[English] Invalid placement.</d> The target video uses @Subject1.\n\nretention_analysis:\n@Subject1 (appears in [Shot 1]): fully_preserved - preserve her defined appearance.\n\ndetailed_description:\nThe target video uses a live-action cinematic style with neutral lighting.\n[Shot 1] The woman with a calm low voice (S1) says, <d>[English] Valid timeline event.</d>\n\noverall_soundscape:\nRoom tone continues.\n\nnon_diegetic_music:\nN/A`;
  const result = validatePrompt(prompt, state(PROFILE.REF2VA));
  assert.equal(codes(result).has("dialogue-outside-timeline"), true, "invalid off-timeline dialogue should still be reported");
  assert.equal(codes(result).has("dialogue-speaker-order"), false, "off-timeline S9 must not consume the timeline speaker order");
  console.log("PASS speaker order uses actual target-timeline vocal events");
}

{
  const prompt = `integrated_multimodal_description:\n[Shot 1] Live-action opening.\n[Shot 2] At 00:03.000, the shot cuts to the final action.`;
  const line = firstLineForState(state(PROFILE.FL2VA, { imageCount: 2 }), prompt);
  assert.match(line, /Picture 2 \(from Shot 2\)/);
  console.log("PASS FL2VA alignment follows actual final shot");
}

{
  const scaffold = templateForState(state(PROFILE.REF2VA), "");
  assert.match(scaffold, /\{define tracked reference content\}/);
  assert.doesNotMatch(scaffold, /@Subject1/);
  assert.doesNotMatch(scaffold, /\[reference generation\]/);
  console.log("PASS Reference scaffold does not guess semantic role");
}

{
  const options = descriptionOptions();
  const labels = new Set(options.map((option) => option.label));
  assert.equal(labels.has("Visible text"), true);
  assert.equal(labels.has("Synchronized diegetic sound"), true);
  const visible = options.find((option) => option.label === "Visible text");
  assert.equal(visible.insertText, 'Visible text reads "{visible text}".');
  assert.equal(visible.select, "{visible text}");
  console.log("PASS shot-field option mapping executes and preserves visible-text quoting");
}

{
  const prompt = `integrated_multimodal_description:
[Shot 1] Live-action, two children with distinct voices (S1,S2) shout together, <d>[English] Wait for us!</d>

overall_soundscape:
Footsteps and room tone continue.

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, state(PROFILE.T2VA));
  assert.equal(codes(result).has("dialogue-speaker-order"), false, "compound IDs are valid when first vocal event establishes the participating speakers");
  console.log("PASS compound speaker IDs follow documented shared-vocal-event syntax");
}

{
  const prompt = `subject_definitions:
@Subject1 is the woman shown in @Image1.

summary:
[reference generation] The target uses @Subject1.

retention_analysis:
@Subject1 (appears in [Shot 1]): fully_preserved

detailed_description:
The target video uses a realistic visual style.
[Shot 1] A medium shot frames @Subject1.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, state(PROFILE.REF2VA));
  assert.equal(codes(result).has("retention-marker"), false);
  assert.equal(result.notes.some((item) => item.code === "retention-explanation"), true);
  console.log("PASS valid retention marker without explanation is advisory");
}

{
  const prompt = `subject_definitions:
@Subject1 is the woman shown in @Image1.
@Image1 provides the front view.

summary:
[reference generation] The target uses @Subject1.

retention_analysis:
@Subject1 (appears in [Shot 1]): fully_preserved - preserve identity.
@Image1: fully_preserved - preserve the frame.

detailed_description:
The target video uses a realistic visual style.
[Shot 1] A medium shot frames @Subject1.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, state(PROFILE.REF2VA));
  assert.equal(codes(result).has("split-source-provenance"), false);
  assert.equal(result.notes.some((item) => item.code === "split-source-provenance"), true);
  console.log("PASS source-provenance heuristic is advisory");
}

console.log("10 prompt behavior checks passed");

{
  const audioState = { ...state(PROFILE.T2VA), audioMode: true };
  const tpl = templateForState(audioState, "");
  assert.equal(tpl.includes("proxy video placeholder visuals"), false);
  assert.equal(tpl.includes("audio events in playback order"), true);
  console.log("PASS audio-first template uses audio-centric scaffold");
}

console.log("11 prompt behavior checks passed");

{
  const mixed = state(PROFILE.REF2VA, { mixedConditioningFamilies: false, keyframeCount: 1, referenceInputKinds: ["reference image"] });
  assert.match(profileDescription(mixed), /REF2VA-style prompt assistance/);
  console.log("PASS profile description keeps prompt assistance separate from routing");
}

{
  const audioState = { ...state(PROFILE.T2VA), audioMode: true, audioTask: "T2A proxy" };
  const prompt = `integrated_multimodal_description:
[Shot 1] The proxy video remains visually minimal and static.

overall_soundscape:
N/A

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, audioState);
  assert.equal(result.notes.some((item) => item.code === "audio-no-target"), true);
  console.log("PASS audio-first validator notices an explicitly empty audio target");
}

console.log("12 prompt behavior checks passed");

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }, { name: "playback_fps", value: 24 }],
    inputs: [{ name: "ref_image_0", link: 1 }],
  };
  const s = nodeState(node, "");
  assert.equal(s.editorProfile, PROFILE.REF2VA);
  assert.equal(s.conditioningFamily, "reference");
  assert.deepEqual(s.referenceInputKinds, ["reference image"]);
  assert.match(profileDescription(s), /REF2VA.*reference image/i);
  assert.equal(s.audioMode, false);
  console.log("PASS video mode infers Reference grammar from connected refs");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }, { name: "playback_fps", value: 24 }],
    inputs: [{ name: "keyframe_0", link: 1 }],
  };
  const s = nodeState(node, "");
  assert.equal(s.editorProfile, PROFILE.I2VA);
  assert.equal(s.conditioningFamily, "base");
  assert.equal(s.hasReferenceInputs, false);
  assert.match(profileDescription(s), /I2VA.*base prompt structure/i);
  console.log("PASS video mode infers endpoint grammar from connected keyframe");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_AUDIO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }, { name: "playback_fps", value: 24 }],
    inputs: [{ name: "ref_video_0", link: 1 }, { name: "ref_audio_0", link: 2 }],
  };
  const s = nodeState(node, "");
  assert.equal(s.editorProfile, PROFILE.REF2VA);
  assert.equal(s.audioMode, true);
  assert.equal(s.audioTask, "V2A+A2A proxy");
  console.log("PASS audio mode infers V2A+A2A prompt assistance from refs");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }],
    inputs: [{ name: "ref_audio_0", link: 7 }],
  };
  const s = nodeState(node, "");
  assert.equal(s.editorProfile, PROFILE.REF2VA);
  assert.equal(s.conditioningFamily, "reference");
  assert.equal(s.audioCount, 1);
  assert.deepEqual(s.referenceInputKinds, ["standalone reference audio"]);
  console.log("PASS standalone reference audio selects REF2VA structure");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }],
    inputs: [{ name: "ref_video_audio_0", link: 8 }],
  };
  const s = nodeState(node, "");
  const result = validatePrompt("", s);
  assert.equal(s.editorProfile, PROFILE.REF2VA);
  assert.deepEqual(s.referenceInputKinds, ["paired reference-video audio"]);
  assert.deepEqual(s.orphanPairedAudioNames, ["ref_video_audio_0"]);
  assert.equal(codes(result).has("orphan-video-audio"), true);
  console.log("PASS orphan paired soundtrack selects REF2VA family but remains a blocking wiring error");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }],
    inputs: [{ name: "ref_video_0", link: 8 }, { name: "ref_video_audio_0", link: 9 }],
  };
  const s = nodeState(node, "");
  assert.equal(s.editorProfile, PROFILE.REF2VA);
  assert.equal(s.videoCount, 1);
  assert.equal(s.audioCount, 1);
  assert.deepEqual(s.orphanPairedAudioNames, []);
  assert.deepEqual(s.referenceInputKinds, ["reference video", "paired reference-video audio"]);
  console.log("PASS paired reference-video soundtrack is REF2VA when its video is connected");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }, { name: "playback_fps", value: 24 }],
    inputs: [{ name: "keyframe_0", link: 1 }, { name: "ref_image_0", link: 2 }],
  };
  const s = nodeState(node, "");
  const result = validatePrompt("", s);
  assert.equal(codes(result).has("mixed-conditioning-families"), false);
  assert.equal(result.notes.some((item) => item.code === "ignored-keyframe-inputs"), true);
  console.log("PASS mixed endpoint+reference wiring is nonblocking and Reference inputs stay active");
}

console.log("19 prompt behavior checks passed");

{
  const node = {
    inputs: [
      { name: "ref_images.ref_image_0", link: 101 },
      { name: "ref_images.ref_image_1", link: 102 },
      { name: "ref_images.ref_image_2", link: 103 },
    ],
    widgets: [
      { name: "mode", value: MODE_VIDEO },
      { name: "seconds", value: 5 },
      { name: "keyframe_role", value: KEYFRAME_FIRST },
      { name: "keyframe_canvas", value: KEYFRAME_CANVAS_ADAPTIVE },
      { name: "canvas", value: "768P (native)" },
    ],
  };
  const inferred = nodeState(node, "");
  assert.equal(inferred.editorProfile, PROFILE.REF2VA);
  assert.equal(inferred.imageCount, 3);
  assert.deepEqual(inferred.refs.map((ref) => ref.token), ["@Image1", "@Image2", "@Image3"]);
  assert.deepEqual(inferred.refs.map((ref) => ref.inputName), ["ref_images.ref_image_0", "ref_images.ref_image_1", "ref_images.ref_image_2"]);
  console.log("PASS dotted V3 Autogrow image sockets infer REF2VA");
}

{
  const refState = state(PROFILE.REF2VA, { imageCount: 3, refs: [
    { token: "@Image1", kind: "image", ordinal: 1 },
    { token: "@Image2", kind: "image", ordinal: 2 },
    { token: "@Image3", kind: "image", ordinal: 3 },
  ] });
  assert.equal(compilePromptPreview("pose from <Image 3>", refState), "pose from <Picture 3>");
  const unresolved = validatePrompt(`subject_definitions:
@Subject1 is shown in <Image 9>.

summary:
[reference generation] use @Subject1.

retention_analysis:
@Subject1: fully_preserved

detailed_description:
[Shot 1] @Subject1 poses.

overall_soundscape:
N/A

non_diegetic_music:
N/A`, refState);
  assert.equal(codes(unresolved).has("unresolved-reference"), true);
  console.log("PASS <Image N> alias compiles and validates like @ImageN");
}

console.log("21 prompt behavior checks passed");


{
  const inferred = inferPromptStructure(`integrated_multimodal_description:
[Shot 1] A woman walks through a room.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`);
  assert.equal(inferred.family, "base");
  assert.equal(inferred.profileHint, PROFILE.T2VA);
  assert.equal(inferred.conflict, false);
  console.log("PASS integrated_multimodal_description identifies base prompt structure");
}

{
  const inferred = inferPromptStructure(`subject_definitions:
@Subject1 is the woman shown in @Image1.

summary:
[reference generation] Use @Subject1.

retention_analysis:
@Subject1: fully_preserved

detailed_description:
[Shot 1] @Subject1 turns.`);
  assert.equal(inferred.family, "reference");
  assert.equal(inferred.profileHint, PROFILE.REF2VA);
  assert.equal(inferred.conflict, false);
  console.log("PASS subject_definitions identifies REF2VA prompt structure");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }],
    inputs: [{ name: "ref_images.ref_image_0", link: 1 }],
  };
  const prompt = `integrated_multimodal_description:
[Shot 1] A woman walks.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`;
  const inferred = nodeState(node, prompt);
  assert.equal(inferred.editorProfile, PROFILE.T2VA);
  assert.equal(inferred.inputConditioningProfile, PROFILE.REF2VA);
  assert.equal(inferred.conditioningProfile, PROFILE.REF2VA);
  assert.equal(inferred.editorProfileSource, "prompt");
  assert.equal(inferred.ignoredReferenceInputs, false);
  const result = validatePrompt(prompt, inferred);
  assert.equal(codes(result).has("prompt-conditioning-mismatch"), false);
  assert.equal(result.notes.some((item) => item.code === "reference-route-overrides-prompt"), false);
  console.log("PASS base prompt structure keeps base assistance while connected Reference inputs still route REF2VA");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }],
    inputs: [],
  };
  const prompt = `subject_definitions:
{define tracked reference content}

summary:
{summary task type} {target video + main reference relationships}

retention_analysis:
{retention rows for tracked references}

detailed_description:
[Shot 1] {action in playback order}.

overall_soundscape:
N/A

non_diegetic_music:
N/A`;
  const inferred = nodeState(node, prompt);
  assert.equal(inferred.editorProfile, PROFILE.REF2VA);
  assert.equal(inferred.inputConditioningProfile, PROFILE.T2VA);
  assert.equal(inferred.conditioningProfile, PROFILE.T2VA);
  const result = validatePrompt(prompt, inferred);
  assert.equal(codes(result).has("missing-reference-conditioning"), false);
  assert.equal(result.notes.some((item) => item.code === "missing-reference-conditioning"), false);
  assert.match(profileDescription(inferred), /REF2VA.*subject_definitions/i);
  console.log("PASS pasted REF2VA structure changes assistance only while execution stays input-driven");
}

{
  const inferred = inferPromptStructure(`integrated_multimodal_description:
[Shot 1] Base content.

subject_definitions:
@Subject1 is something.`);
  assert.equal(inferred.family, "base");
  assert.equal(inferred.conflict, true);
  console.log("PASS mixed base and REF section markers are detected as ambiguous");
}

{
  const t2a = inferPromptStructure(`integrated_multimodal_description:
[Shot 1] The proxy video remains visually minimal and static; audio is the intended output. A woman speaks.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`);
  assert.equal(t2a.family, "base");
  assert.equal(t2a.outputIntent, "audio");
  assert.match(t2a.outputMarker, /audio-proxy/i);
  console.log("PASS T2A starter is recognizable from its stable audio-proxy signature");
}

{
  const r2a = inferPromptStructure(`subject_definitions:
@Subject1 is the speaker shown in @Image1.

summary:
[reference generation] Generate new audio.

retention_analysis:
@Subject1: fully_preserved - preserve identity.

detailed_description:
The proxy video remains visually minimal and static; audio is the intended output.
[Shot 1] A voice speaks.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`);
  assert.equal(r2a.family, "reference");
  assert.equal(r2a.outputIntent, "audio");
  console.log("PASS R2A starter is recognizable independently of REF family detection");
}

{
  const legacy = inferPromptStructure(`integrated_multimodal_description:
[Shot 1] The proxy video remains visually minimal and static. A voice speaks.

overall_soundscape:
N/A

non_diegetic_music:
N/A`);
  assert.equal(legacy.outputIntent, "audio");
  console.log("PASS pre-2.0.45 T2A starter remains recognizable");
}

{
  const node = {
    widgets: [{ name: "mode", value: MODE_VIDEO }, { name: "keyframe_role", value: KEYFRAME_FIRST }, { name: "seconds", value: 5 }],
    inputs: [],
  };
  const prompt = `integrated_multimodal_description:
[Shot 1] The proxy video remains visually minimal and static; audio is the intended output. A voice speaks.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`;
  const inferred = nodeState(node, prompt);
  assert.equal(inferred.promptAudioIntent, true);
  assert.equal(inferred.displayAudioMode, true);
  assert.match(profileDescription(inferred), /T2A.*Mode remains Video \+ audio/i);
  assert.equal(codes(validatePrompt(prompt, inferred)).has("prompt-mode-mismatch"), false);
  console.log("PASS audio prompt intent is surfaced without silently changing backend Mode");
}

{
  const audioState = {
    ...state(PROFILE.REF2VA, {
      editorProfile: PROFILE.T2VA,
      conditioningProfile: PROFILE.REF2VA,
      audioMode: true,
      audioTask: "A2A proxy",
      audioCount: 1,
    }),
  };
  const prompt = `integrated_multimodal_description:
[Shot 1] The proxy video remains visually minimal and static while @Audio1 supplies the intended audible source.

overall_soundscape:
N/A

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, audioState);
  assert.equal(result.notes.some((item) => item.code === "audio-no-target"), false);
  console.log("PASS Audio-first @AudioN alias counts as an audible target");
}

{
  const node = {
    widgets: [
      { name: "mode", value: MODE_VIDEO },
      { name: "keyframe_role", value: KEYFRAME_FIRST },
      { name: "seconds", value: 5 },
      { name: "ref_video_fps", value: 24 },
    ],
    inputs: [
      { name: "ref_image_0", link: 1 },
      { name: "ref_video_0", link: 2 },
      { name: "ref_video_audio_0", link: 3 },
    ],
  };
  const prompt = `integrated_multimodal_description:
[Shot 1] @Subject1 uses appearance from @Image1 and motion from @Video1 while @Audio1 plays.

overall_soundscape:
@Audio1 supplies the audible source cue.

non_diegetic_music:
N/A`;
  const s = nodeState(node, prompt);
  const result = validatePrompt(prompt, s);
  assert.equal(s.editorProfile, PROFILE.T2VA);
  assert.equal(s.conditioningProfile, PROFILE.REF2VA);
  assert.equal(codes(result).has("base-reference-type"), false);
  assert.equal(codes(result).has("unresolved-reference"), false);
  assert.match(result.compiledPreview, /<Subject 1>/);
  assert.match(result.compiledPreview, /<Picture 1>/);
  assert.match(result.compiledPreview, /<Video 1>/);
  assert.match(result.compiledPreview, /<Audio 1>/);
  console.log("PASS base editor grammar compiles physical media through the connected Reference route");
}

{
  const node = {
    widgets: [
      { name: "mode", value: MODE_VIDEO },
      { name: "keyframe_role", value: KEYFRAME_FIRST },
      { name: "seconds", value: 5 },
      { name: "ref_video_fps", value: 0 },
    ],
    inputs: [{ name: "ref_video_0", link: 2 }],
  };
  const prompt = `integrated_multimodal_description:
[Shot 1] Motion follows @Video1.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`;
  const result = validatePrompt(prompt, nodeState(node, prompt));
  assert.equal(codes(result).has("invalid-reference-video-fps-1"), true);
  console.log("PASS Reference-video FPS validation follows the physical route even under base prompt grammar");
}

{
  const node = {
    widgets: [
      { name: "mode", value: MODE_VIDEO },
      { name: "keyframe_role", value: KEYFRAME_FIRST },
      { name: "seconds", value: 5 },
    ],
    inputs: [{ name: "keyframe_0", link: 1 }],
  };
  const prompt = `subject_definitions:
@Subject1 is the tracked character shown in @Image1.

summary:
[reference generation] The target video uses @Subject1.

retention_analysis:
@Subject1 (appears in [Shot 1]): fully_preserved - preserve the defined appearance.

detailed_description:
The target video uses a live-action style.
[Shot 1] @Subject1 remains framed like @Image1.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`;
  const s = nodeState(node, prompt);
  const result = validatePrompt(prompt, s);
  assert.equal(s.editorProfile, PROFILE.REF2VA);
  assert.equal(s.conditioningProfile, PROFILE.I2VA);
  assert.equal(codes(result).has("base-reference-type"), true, "@Subject1 must remain physically invalid on the endpoint route");
  assert.match(result.compiledPreview, /@Subject1/);
  assert.match(result.compiledPreview, /<Picture 1>/);
  console.log("PASS REF editor grammar cannot invent Reference-media support on the endpoint route");
}

{
  const node = {
    widgets: [
      { name: "mode", value: MODE_VIDEO },
      { name: "keyframe_role", value: "Last frame" },
      { name: "seconds", value: 5 },
    ],
    inputs: [{ name: "keyframe_0", link: 1 }, { name: "keyframe_1", link: 2 }],
  };
  const prompt = `subject_definitions:
@Image1 is the first tracked frame and @Image2 is the second tracked frame.

summary:
[reference generation] Use @Image1 and @Image2.

retention_analysis:
@Image1: fully_preserved - preserve the frame.
@Image2: fully_preserved - preserve the frame.

detailed_description:
[Shot 1] Move from @Image1 toward @Image2.

overall_soundscape:
Room tone.

non_diegetic_music:
N/A`;
  const s = nodeState(node, prompt);
  const result = validatePrompt(prompt, s);
  assert.equal(s.editorProfile, PROFILE.REF2VA);
  assert.equal(s.conditioningProfile, PROFILE.FL2VA);
  assert.match(result.compiledPreview, /<Picture 2> is the first tracked frame/);
  assert.match(result.compiledPreview, /<Picture 1> is the second tracked frame/);
  console.log("PASS endpoint Picture numbering follows the physical FL2VA route under REF editor grammar");
}

console.log("36 prompt behavior checks passed");
