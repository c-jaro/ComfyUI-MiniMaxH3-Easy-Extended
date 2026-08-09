import assert from "node:assert/strict";
import { DIALOGUE_LANGUAGE_OPTIONS, EDITOR_PLACEHOLDER_HELP, STABLE_DIALOGUE_LANGUAGES, CAMERA, TASK_TYPES, VISUAL_RETENTION, AUDIO_RETENTION } from "../web/h3_guidelines.js";
import { PROMPT_CHOICE_GROUPS, PLACEHOLDER_PRESET_GROUPS, presetChoicesForPlaceholder } from "../web/h3_prompt_choices.js";

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`PASS ${name}`);
}

check("choice mappings only reference real editor fields and groups", () => {
  for (const [field, groups] of Object.entries(PLACEHOLDER_PRESET_GROUPS)) {
    assert.ok(Object.hasOwn(EDITOR_PLACEHOLDER_HELP, field), `unknown field: ${field}`);
    assert.ok(groups.length > 0, `no groups: ${field}`);
    for (const group of groups) assert.ok(PROMPT_CHOICE_GROUPS[group]?.length, `${field}: missing group ${group}`);
  }
});

check("every Tab field has presets or an explicit contextual choice handler", () => {
  const contextualFields = new Set([
    "cut / transition",
    "camera movement if needed",
    "camera amplitude if needed",
    "camera speed if needed",
    "dialogue language",
    "summary task type",
    "additional task type if needed",
    "visual retention",
    "audio retention",
    "define tracked reference content",
    "retention rows for tracked references",
    "synchronized sound / dialogue if present",
    "ambience + physical / non-verbal sounds, or N/A only if completely silent",
    "audience-only score: instrumentation + tempo/rhythm + dynamic development, or N/A",
    "audio events in playback order",
    "spoken words",
    "speaker number from timeline",
    "speaker ID group",
    "visible text",
  ]);
  for (const field of Object.keys(EDITOR_PLACEHOLDER_HELP)) {
    assert.ok(
      presetChoicesForPlaceholder(field).length > 0 || contextualFields.has(field),
      `${field}: Tab field has neither presets nor an explicit contextual menu`,
    );
  }
});

check("every preset choice has usable text and metadata", () => {
  for (const [group, choices] of Object.entries(PROMPT_CHOICE_GROUPS)) {
    assert.ok(choices.length >= 4, `${group} should expose several choices`);
    const labels = new Set();
    for (const item of choices) {
      assert.ok(item.label?.trim(), `${group}: empty label`);
      assert.ok(item.insertText?.trim(), `${group}/${item.label}: empty insertText`);
      assert.ok(item.detail?.trim(), `${group}/${item.label}: empty detail`);
      assert.ok(!labels.has(item.label), `${group}: duplicate label ${item.label}`);
      labels.add(item.label);
    }
  }
});

check("requested common fields expose multiple presets", () => {
  for (const field of [
    "visual style",
    "shot size / framing",
    "viewpoint",
    "subject / scene",
    "action in playback order",
    "speaker identity",
    "voice traits",
    "instruments / sound sources",
    "tempo / rhythm",
    "musical pattern",
    "dynamic change",
  ]) {
    assert.ok(presetChoicesForPlaceholder(field).length >= 5, `${field} lacks useful presets`);
  }
});

check("subject presets stay category-level and grammatically fit the scaffolds", () => {
  const subjectScene = PROMPT_CHOICE_GROUPS.subjectScene;
  assert.deepEqual(subjectScene.map((item) => item.label), [
    "Person · generic", "Woman", "Man", "Child", "Fictional character", "Animal", "Object / prop", "Scene / environment", "Multiple subjects", "Subject + environment",
  ]);
  assert.equal(subjectScene.some((item) => /person or character|two people|small group|interacting people/i.test(item.insertText)), false);
  assert.ok(subjectScene.some((item) => item.insertText === "a woman"));
  assert.ok(subjectScene.some((item) => item.insertText === "a man"));
  assert.equal(subjectScene.every((item) => !item.insertText.includes("/")), true, "menu labels may use '/', generated prompt text should not");
  for (const item of PROMPT_CHOICE_GROUPS.trackedSubject) {
    assert.ok(item.insertText.startsWith("the "), `tracked subject must fit '@SubjectN is ...': ${item.insertText}`);
  }
});

check("motion-transfer helper fields are selectable", () => {
  for (const field of [
    "action / motion performance",
    "action / motion pattern",
    "pose sequence / timing / body mechanics",
  ]) {
    assert.ok(Object.hasOwn(EDITOR_PLACEHOLDER_HELP, field), `${field} missing tooltip/help`);
    assert.ok(presetChoicesForPlaceholder(field).length >= 5, `${field} missing presets`);
  }
});

check("sentence-level presets are complete clauses, not fragments", () => {
  for (const field of [
    "action onset", "continuous development", "result / reaction",
    "first-frame visible state", "changes between first and last frame",
    "approach to final frame", "state before the final frame",
    "motion toward the final frame", "final-frame convergence",
    "secondary motion / physical response", "audio event / timing",
    "diegetic music source / performance", "pause / silence duration",
  ]) {
    for (const item of presetChoicesForPlaceholder(field)) {
      assert.match(item.insertText, /^[A-Z]/, `${field}/${item.label}: expected sentence-level preset`);
    }
  }
});

check("within-shot timestamp presets are lower-case clauses", () => {
  for (const item of presetChoicesForPlaceholder("event within the current shot")) {
    assert.match(item.insertText, /^[a-z]/, `${item.label}: should fit 'At 00:02.000, ...'`);
  }
});

check("summary relationship presets are complete sentences", () => {
  const options = presetChoicesForPlaceholder("target video + main reference relationships");
  assert.ok(options.length >= 10);
  for (const item of options) {
    assert.ok(item.insertText.startsWith("The target video "), `${item.label}: missing summary subject`);
    assert.ok(item.insertText.endsWith("."), `${item.label}: missing summary punctuation`);
  }
});

check("new-shot viewpoint choices describe a view, not a bare angle", () => {
  const options = presetChoicesForPlaceholder("new shot content / viewpoint");
  for (const item of options) {
    assert.doesNotMatch(item.insertText, /^(?:eye level|a low angle|a high angle|directly overhead|ground level|behind the subject)$/i);
  }
  assert.ok(options.some((item) => item.insertText === "a low-angle view of the current subject or scene"));
});

check("shot-size presets fit uses-framing scaffold without article bugs", () => {
  for (const item of presetChoicesForPlaceholder("shot size / framing")) {
    const sentence = `The shot uses ${item.insertText} framing from eye level.`;
    assert.doesNotMatch(sentence, /\b(?:A|a) extreme close-up\b/);
    assert.doesNotMatch(sentence, /uses (?:a|an) .* framing/i);
  }
  assert.ok(presetChoicesForPlaceholder("shot size / framing").some((item) => item.insertText === "full-shot"));
});

check("tempo presets fit the score-has scaffold", () => {
  for (const item of presetChoicesForPlaceholder("tempo / rhythm")) {
    const sentence = `The score has ${item.insertText}.`;
    assert.doesNotMatch(sentence, /has at\b|has an? sustained tones at/i);
  }
});

check("full framing-viewpoint-subject combinations form natural sentences", () => {
  const sizes = presetChoicesForPlaceholder("shot size / framing");
  const views = presetChoicesForPlaceholder("viewpoint");
  const subjects = presetChoicesForPlaceholder("subject / scene");
  for (const size of sizes) {
    for (const view of views) {
      for (const subject of subjects) {
        const sentence = `The shot uses ${size.insertText} framing from ${view.insertText} and frames ${subject.insertText}.`;
        assert.doesNotMatch(sentence, /\b(?:person|character) or (?:person|character)\b/i);
        assert.doesNotMatch(sentence, /\bshot shot\b|\bframing framing\b/i);
        assert.doesNotMatch(sentence, /frames (?:person|character|animal|object|scene)\./i, `${size.label} / ${view.label} / ${subject.label}: category label leaked into prose`);
      }
    }
  }
  assert.equal(`The shot uses full-body framing from a low angle and frames a woman.`,
               `The shot uses ${sizes.find(x => x.label.startsWith("Full-body")).insertText} framing from ${views.find(x => x.label === "Low angle").insertText} and frames ${subjects.find(x => x.label === "Woman").insertText}.`);
});

check("physical-cause presets fit a driven-by sentence", () => {
  for (const item of presetChoicesForPlaceholder("physical cause / movement")) {
    const sentence = `Secondary motion is driven by ${item.insertText}.`;
    assert.doesNotMatch(sentence, /driven by (?:the )?(?:cause|movement)\b/i);
  }
});

check("preset insertion text never leaks editor meta syntax", () => {
  for (const [group, choices] of Object.entries(PROMPT_CHOICE_GROUPS)) {
    for (const item of choices) {
      assert.doesNotMatch(item.insertText, /[{}]/, `${group}/${item.label}: preset contains editor placeholder syntax`);
      assert.equal(item.insertText.includes("/"), false, `${group}/${item.label}: menu category separator leaked into prompt prose`);
    }
  }
});

check("subject-pose and environment presets fit their exact scaffold hosts", () => {
  for (const item of presetChoicesForPlaceholder("subject appearance / pose / frame position")) {
    const sentence = `The framed subject is ${item.insertText}.`;
    assert.doesNotMatch(sentence, /is (?:a|an|the) (?:pose|position|orientation|frame position)\b/i, item.label);
    assert.doesNotMatch(sentence, /is the subject\b/i, item.label);
  }
  for (const item of presetChoicesForPlaceholder("environment / lighting")) {
    const sentence = `The scene shows ${item.insertText}.`;
    assert.doesNotMatch(sentence, /shows (?:environment|lighting|scene)\./i, item.label);
  }
});

check("stable dialogue language set is complete and unique", () => {
  assert.deepEqual(STABLE_DIALOGUE_LANGUAGES, [
    "Arabic", "Chinese", "English", "French", "German", "Italian",
    "Japanese", "Korean", "Portuguese", "Russian", "Spanish",
  ]);
  assert.equal(new Set(STABLE_DIALOGUE_LANGUAGES).size, STABLE_DIALOGUE_LANGUAGES.length);
});

check("expanded dialogue language menu prioritizes requested languages", () => {
  assert.deepEqual(DIALOGUE_LANGUAGE_OPTIONS.slice(0, 5), ["English", "Russian", "Japanese", "Dutch", "French"]);
  assert.equal(new Set(DIALOGUE_LANGUAGE_OPTIONS).size, DIALOGUE_LANGUAGE_OPTIONS.length);
  for (const language of STABLE_DIALOGUE_LANGUAGES) assert.ok(DIALOGUE_LANGUAGE_OPTIONS.includes(language), `missing stable language ${language}`);
  for (const language of ["Dutch", "Ukrainian", "Polish", "Romanian", "Turkish", "Swedish", "Hindi", "Vietnamese"]) assert.ok(DIALOGUE_LANGUAGE_OPTIONS.includes(language), `missing expanded language ${language}`);
});

check("documented camera vocabulary is complete", () => {
  const labels = CAMERA.map(([label]) => label);
  assert.deepEqual(labels, [
    "Zoom In", "Zoom Out", "Push In", "Pull Out", "Pan Left", "Pan Right",
    "Truck Left", "Truck Right", "Tilt Up", "Tilt Down", "Pedestal Up", "Pedestal Down",
    "Arc Shot", "Tracking Shot", "Static Shot", "Shake Slightly", "Shake Strongly", "POV",
    "Roll Clockwise", "Roll Counterclockwise",
  ]);
});

check("reference task and retention fixed vocabularies stay complete", () => {
  assert.deepEqual(TASK_TYPES.map(([value]) => value), [
    "reference generation", "keyframe completion", "video editing", "video continuation", "audio reuse", "audio reference",
  ]);
  assert.deepEqual(VISUAL_RETENTION.map(([value]) => value), [
    "fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference",
  ]);
  assert.deepEqual(AUDIO_RETENTION.map(([value]) => value), [
    "fully_copy", "partially_copy", "reference", "weak_reference",
  ]);
});

console.log(`${checks} prompt choice checks passed`);
