export const MODE_VIDEO = "Video + audio";
export const MODE_AUDIO = "Audio only (32x32 proxy)";
export const KEYFRAME_FIRST = "First frame";
export const KEYFRAME_LAST = "Last frame";
export const KEYFRAME_CANVAS_ADAPTIVE = "Opening frame; if absent, last frame";
export const KEYFRAME_CANVAS_FIXED = "Aspect ratio setting";

export const PROFILE = Object.freeze({
  T2VA: "T2VA",
  I2VA: "I2VA",
  L2VA: "L2VA",
  FL2VA: "FL2VA",
  REF2VA: "REF2VA",
});

export const REF_SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
];

export const BASE_SECTIONS = [
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music",
];

export const STABLE_DIALOGUE_LANGUAGES = Object.freeze([
  "Arabic",
  "Chinese",
  "English",
  "French",
  "German",
  "Italian",
  "Japanese",
  "Korean",
  "Portuguese",
  "Russian",
  "Spanish",
]);

// The model card names the 11 entries above as the stable set, but explicitly
// says additional dialogue languages are supported to varying degrees. Keep the
// UI useful without pretending those additional entries are equally supported.
// User-priority languages come first, then the rest of the stable set, then a
// broad set of common additional languages. Custom remains available last.
export const DIALOGUE_LANGUAGE_OPTIONS = Object.freeze([
  "English",
  "Russian",
  "Japanese",
  "Dutch",
  "French",
  "German",
  "Spanish",
  "Italian",
  "Portuguese",
  "Chinese",
  "Korean",
  "Arabic",
  "Ukrainian",
  "Polish",
  "Romanian",
  "Bulgarian",
  "Czech",
  "Slovak",
  "Slovenian",
  "Croatian",
  "Serbian",
  "Greek",
  "Turkish",
  "Danish",
  "Swedish",
  "Norwegian",
  "Finnish",
  "Hungarian",
  "Catalan",
  "Cantonese",
  "Hindi",
  "Bengali",
  "Urdu",
  "Thai",
  "Vietnamese",
  "Indonesian",
  "Malay",
  "Filipino",
  "Persian",
  "Hebrew",
  "Swahili",
  "Afrikaans",
  "Lithuanian",
  "Latvian",
  "Estonian",
]);

// [fixed value, when/why to use it, concrete example]
export const TASK_TYPES = [
  ["reference generation", "Reference guides content/style/action/camera; not a concrete frame, edit or continuation.", "@Image1 defines @Subject1's appearance."],
  ["keyframe completion", "Picture is a concrete first/key/last frame anchor.", "@Image1 is [Shot 1]'s first frame."],
  ["video editing", "Source video itself is modified.", "@Video1 is the footage being edited."],
  ["video continuation", "Target continues from the source ending state.", "The target continues from @Video1's ending state."],
  ["audio reuse", "Copy the actual source audio signal.", "Reuse part of @Audio1's signal."],
  ["audio reference", "Use audio properties/content without copying the signal.", "Match @Audio1's timbre without copying the waveform."],
];

// The explanatory clause after "-" is intentionally explicit. MiniMax's guide
// defines retention_analysis as describing HOW the tracked item is retained,
// transferred, copied, or referenced; a bare marker is too ambiguous to guide
// the user even if a downstream parser would technically accept the words.
export const VISUAL_RETENTION = [
  ["fully_preserved", "Keep the defined visual role intact.", "@Subject1: fully_preserved - preserve identity, outfit, proportions, and face.", "fully_preserved - preserve {identity / appearance / structure to keep}"],
  ["partially_preserved", "Keep some defined traits and change others.", "@Subject1: partially_preserved - keep face and outfit; change hair and pose.", "partially_preserved - keep {features retained}; change {features changed}"],
  ["attribute_transfer", "Apply referenced traits to a different target subject.", "@Subject2: attribute_transfer - transfer its nail design to @Subject1.", "attribute_transfer - transfer {attributes} to {target subject}"],
  ["weak_reference", "Keep only broad visual similarity.", "@Subject1: weak_reference - retain only silhouette and palette.", "weak_reference - retain only broad similarity in {style / category / composition / atmosphere}"],
];

export const AUDIO_RETENTION = [
  ["fully_copy", "Reuse the complete source signal as the complete final track.", "@Audio1: fully_copy - reuse @Audio1 1:1 as the complete final audio track.", "fully_copy - reuse the source audio 1:1 as the complete final audio track"],
  ["partially_copy", "Copy only part/layers, or modify the copied signal.", "@Audio1: partially_copy - reuse 0:00-0:04; replace the ending ambience.", "partially_copy - reuse {copied segment / layers}; then {what is added / removed / replaced}"],
  ["reference", "Do not copy the signal; match specific audible properties/content.", "@Audio1: reference - match the narrator timbre and delivery without copying the signal.", "reference - match {timbre / rhythm / music style / dialogue content / sound texture} without copying the source signal"],
  ["weak_reference", "Keep only broad audio similarity.", "@Audio1: weak_reference - retain only a sparse acoustic character.", "weak_reference - retain only broad similarity in {audio category / atmosphere}"],
];

// Named editor placeholders are intentionally explicit. They are temporary
// writing aids, not MiniMax syntax. Tab moves the caret into the next field,
// which opens its contextual menu. The validator flags any placeholder left in the final text.
export const EDITOR_PLACEHOLDER_HELP = Object.freeze({
  "identity / appearance / structure to keep": "Open field · exact traits that must stay intact.",
  "cut / transition": "Choose the shot change. Use camera motion instead when only distance or a slight angle changes.",
  "features retained": "Open field · traits that stay unchanged.",
  "features changed": "Open field · traits intentionally allowed to change.",
  "attributes": "Open field · exact traits to transfer.",
  "target subject": "Open field · destination subject for the transfer.",
  "style / category / composition / atmosphere": "Open field · broad visual qualities only.",
  "copied segment / layers": "Open field · copied time range or audio layers.",
  "what is added / removed / replaced": "Open field · changes made after copying audio.",
  "timbre / rhythm / music style / dialogue content / sound texture": "Open field · audio properties used as reference.",
  "audio category / atmosphere": "Open field · broad audio character only.",
  "tracked subject": "Open field · what this Subject represents.",
  "subject": "Open field · visible subject or tracked @SubjectN.",
  "setup / anticipation": "Open field · opening motion phase.",
  "main action / transition": "Open field · central motion phase.",
  "completion / landing": "Open field · motion resolution/final pose.",
  "timing / body mechanics / trajectory": "Open field · motion qualities to preserve.",
  "action / motion performance": "Open field · action or performance borrowed from a motion reference.",
  "action / motion pattern": "Open field · reusable action or movement pattern represented by the Subject.",
  "pose sequence / timing / body mechanics": "Open field · ordered poses, timing, trajectory, and body mechanics to follow.",
  "source contribution": "Open field · what this source contributes.",
  "overall action / premise": "Open field · high-level target action/premise.",
  "high-level shot progression": "Open field · major shot progression without timestamps.",
  "visual style": "Open field · overall rendering/look.",
  "lighting / color / material traits": "Open field · concrete style traits.",
  "subject / scene / composition": "Open field · visible frame anchors.",
  "pose / composition / state": "Open field · intermediate keyframe state.",
  "final pose / state / composition": "Open field · exact final visible state.",
  "what the picture anchors": "Open field · concrete frame properties fixed by the picture.",
  "what may change": "Open field · intentional changes relative to the picture.",
  "viewpoint / placement / spatial relationships": "Open field · composition relationships to preserve.",
  "overall appearance details": "Open field · major appearance traits from the primary reference.",
  "close-up detail": "Open field · exact secondary detail from the close-up reference.",
  "framing and viewpoint": "Open field · shot size + viewing angle.",
  "opening subject state": "Open field · appearance, pose, orientation and frame position at the start.",
  "action in playback order": "Open field · visible action from start to finish.",
  "first-frame visible state": "Open field · exact visible state in the first frame.",
  "changes between first and last frame": "Open field · observable intermediate changes connecting the endpoints.",
  "approach to final frame": "Open field · how the image progressively approaches the final frame.",
  "state before the final frame": "Open field · plausible visible state before the supplied final frame.",
  "motion toward the final frame": "Open field · visible action or transition leading toward the supplied final frame.",
  "final-frame convergence": "Open field · how the generated image progressively matches the supplied final frame.",
  "subject appearance / pose / frame position": "Open field · visible traits, pose, orientation and position in frame.",
  "environment / lighting": "Open field · location, background, important objects, lighting and weather.",
  "secondary motion / physical response": "Open field · hair, cloth, inertia, impacts, particles or other physical response.",
  "camera movement if needed": "Pick a MiniMax camera move or remove it.",
  "camera amplitude if needed": "Optional · omit, small or large.",
  "camera speed if needed": "Optional · omit, slow or fast.",
  "dialogue language": "Preferred/common languages are offered first. H3 documents 11 as stable; additional languages may work to varying degrees, and Custom accepts any language tag.",
  "summary task type": "Reference conditioning · choose the first actual task relation.",
  "additional task type if needed": "Optional reference relation · add another or finish.",
  "visual retention": "Reference conditioning · how this tracked visual item is retained.",
  "audio retention": "Choose the fixed audio retention marker, then fill its details.",
  "define tracked reference content": "Choose what each connected reference actually means before using it elsewhere.",
  "target video + main reference relationships": "Open field · high-level target premise, shot flow and main reference roles.",
  "retention rows for tracked references": "One row per standalone tracked definition; choose the matching visual/audio relationship.",
  "synchronized sound / dialogue if present": "Choose dialogue or diegetic sound, or remove when absent.",
  "ambience + physical / non-verbal sounds, or N/A only if completely silent": "1–4 sentences · ambience + physical/non-verbal sound; N/A only for complete silence.",
  "audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A": "1–3 sentences · instrumentation + tempo/rhythm + dynamics; no mood/function prose; N/A if none.",
  "audio events in playback order": "Audio-first mode · dialogue, lyrics, SFX, ambience, and other audible events from start to finish.",
  "audio event / timing": "Open field · exact audible event and when/how it happens.",
  "diegetic music source / performance": "Open field · music audible inside the scene, including source, instruments, rhythm and changes.",
  "pause / silence duration": "Open field · silent interval or deliberate pause in the audio timeline.",
  "ambient sources": "Open field · persistent environment/room sounds.",
  "foley / impacts / object sounds": "Open field · physical/object sounds.",
  "breathing / exertion / laughter / other": "Open field · non-verbal human sounds.",
  "instruments / sound sources": "Open field · audience-only score sources.",
  "tempo / rhythm": "Open field · score speed/rhythmic behavior.",
  "musical pattern": "Open field · what the score repeats/plays.",
  "dynamic change": "Open field · how volume/density/instrumentation evolves.",
  "spoken words": "Exact field · preserve the intended dialogue/lyrics in the original language.",
  "speaker identity": "First vocal event · identify who/what is speaking; reuse a tracked @SubjectN when appropriate.",
  "voice traits": "First vocal event · stable vocal traits such as pitch, timbre, speaking rate, or accent.",
  "speaker identity / voice traits": "Legacy combined field · establish who/what is speaking and stable visual/voice traits.",
  "target speaker description": "Open field · stable voice/source identity when no @SubjectN represents the speaker.",
  "speaker number from timeline": "Use the S-number established by actual vocal-event order in detailed_description.",
  "speaker ID group": "Group vocal event · comma-separated established S-IDs; any number of speakers may participate.",
  "shot size / framing": "Open field · shot-scale/framing term used in a natural uses-...-framing sentence.",
  "viewpoint": "Open field · camera angle/orientation.",
  "subject / scene": "Open field · what the shot frames.",
  "appearance / pose / orientation / frame position": "Open field · visible traits + pose + composition position.",
  "location / background / lighting / weather": "Open field · environment and lighting context.",
  "visible action stages / state changes": "Open field · observable action/state progression.",
  "physical cause / movement": "Open field · cause driving secondary motion.",
  "visible text": "Open field · exact on-screen text in double quotes.",
  "diegetic sounds": "Open field · scene sound at the moment it occurs.",
  "visual style + opening composition": "Open field · style + concrete opening composition.",
  "event within the current shot": "Open field · event at this time without a cut.",
  "new shot content / viewpoint": "Open field · what the cut reveals.",
  "cross-dissolve destination": "Open field · destination of the dissolve.",
  "fade destination": "Open field · visual state reached by the fade.",
  "wipe destination": "Open field · shot/scene revealed by the wipe.",
  "action onset": "I2VA flow · first motion away from the opening image.",
  "continuous development": "I2VA flow · continuous development after action onset.",
  "result / reaction": "I2VA flow · visible result or reaction.",
  "first-frame state": "FL2VA flow · state anchored by the opening image.",
  "intermediate changes": "FL2VA flow · observable changes between the two frames.",
  "narrowing differences": "FL2VA flow · changes that progressively approach the final image.",
  "plausible preceding state": "L2VA flow · plausible state before the supplied final frame.",
  "action / transition path": "L2VA flow · explicit path toward the final frame.",
  "gradual convergence": "L2VA flow · final approach toward the supplied last frame.",
});

// [label, insertion text, distinction/usage, example]
export const CAMERA = [
  ["Zoom In", "The camera zooms in.", "Lens changes tighter; camera stays put.", "The camera zooms in at slow speed."],
  ["Zoom Out", "The camera zooms out.", "Lens changes wider; camera stays put.", "The camera zooms out."],
  ["Push In", "The camera pushes in.", "Camera moves forward.", "The camera pushes in with small amplitude at slow speed."],
  ["Pull Out", "The camera pulls out.", "Camera moves backward.", "The camera pulls out."],
  ["Pan Left", "The camera pans left.", "Camera stays put; lens pivots left.", "The camera pans left."],
  ["Pan Right", "The camera pans right.", "Camera stays put; lens pivots right.", "The camera pans right."],
  ["Truck Left", "The camera trucks left.", "Whole camera translates left.", "The camera trucks left."],
  ["Truck Right", "The camera trucks right.", "Whole camera translates right.", "The camera trucks right."],
  ["Tilt Up", "The camera tilts up.", "Camera stays put; lens pivots up.", "The camera tilts up."],
  ["Tilt Down", "The camera tilts down.", "Camera stays put; lens pivots down.", "The camera tilts down."],
  ["Pedestal Up", "The camera moves upward on a pedestal.", "Whole camera moves up.", "The camera pedestals up."],
  ["Pedestal Down", "The camera moves downward on a pedestal.", "Whole camera moves down.", "The camera pedestals down."],
  ["Arc Shot", "The camera moves in an arc around the subject.", "Camera arcs around the subject.", "The camera arcs around @Subject1."],
  ["Tracking Shot", "The camera tracks the subject.", "Camera follows a moving subject.", "The camera tracks @Subject1."],
  ["Static Shot", "The camera holds a static shot.", "No camera/lens movement.", "The camera holds a static shot."],
  ["Shake Slightly", "The camera shakes slightly.", "Slight camera shake.", "The camera shakes slightly."],
  ["Shake Strongly", "The camera shakes strongly.", "Strong camera shake.", "The camera shakes strongly."],
  ["POV", "The shot uses a point-of-view camera.", "Subject point of view; say whose POV when needed.", "POV from @Subject1."],
  ["Roll Clockwise", "The camera rolls clockwise.", "Rotate around the lens axis clockwise.", "The camera rolls clockwise."],
  ["Roll Counterclockwise", "The camera rolls counterclockwise.", "Rotate around the lens axis counterclockwise.", "The camera rolls counterclockwise."],
];

// [label, rule/distinction, example]
export const DESCRIPTION_CONTROLS = [
  ["Framing & viewpoint", "Open · shot size + viewing angle.", "Medium-wide eye-level shot."],
  ["Subject appearance & position", "Open · visible traits + pose/orientation + frame position.", "Subject centered, in profile."],
  ["Environment & lighting", "Open · location/background + important objects + lighting/weather.", "Night station with cool fluorescent light."],
  ["Action & state changes", "Open · visible action in playback order.", "Reach, lift, open, settle."],
  ["Physical & secondary motion", "Open · inertia, cloth/hair, impacts, particles when relevant.", "Coat hem lags then settles."],
  ["Visible text", "Open · exact on-screen text in double quotes.", 'A sign reads "OPEN".'],
  ["Synchronized diegetic sound", "Open · scene sound at the moment it occurs.", "Footsteps and a brake squeal."],
];

export function descriptionOptions() {
  const scaffolds = new Map([
    ["Framing & viewpoint", "The shot uses {shot size / framing} framing from {viewpoint} and frames {subject / scene}."],
    ["Subject appearance & position", "{subject / scene} appears {appearance / pose / orientation / frame position}."],
    ["Environment & lighting", "The scene shows {location / background / lighting / weather}."],
    ["Action & state changes", "{visible action stages / state changes}."],
    ["Physical & secondary motion", "Secondary motion is driven by {physical cause / movement}."],
    ["Visible text", "Visible text reads \"{visible text}\"."],
    ["Synchronized diegetic sound", "Synchronized diegetic sound includes {diegetic sounds}."],
  ]);
  return DESCRIPTION_CONTROLS.map(([label, detail]) => {
    const scaffold = scaffolds.get(label) || `{${label.toLowerCase()}}`;
    return insertOption(label, detail, scaffold, "Open shot fields", firstPlaceholder(scaffold));
  });
}

function firstPlaceholder(text) {
  return String(text || "").match(/\{[^{}]+\}/)?.[0] || null;
}

export function insertOption(label, detail, insertText, group, select = null, example = null) {
  return { label, detail, insertText, group, select, example };
}

export function infoOption(label, detail, group, example = null) {
  return { label, detail, group, example, info: true };
}