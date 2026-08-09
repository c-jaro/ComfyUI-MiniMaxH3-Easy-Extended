from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODES = ROOT / "h3easy" / "nodes.py"
EDITOR = ROOT / "web" / "minimax_h3_easy.js"
GUIDELINES = ROOT / "web" / "h3_guidelines.js"


def test_execute_uses_static_inputs_and_no_advanced_argument():
    tree = ast.parse(NODES.read_text(encoding="utf-8"))
    source = NODES.read_text(encoding="utf-8")
    assert 'def _advanced_input' not in source
    assert 'DynamicCombo.Input' not in source
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "MiniMaxH3Easy":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "execute":
                    args = [arg.arg for arg in item.args.args]
                    assert "advanced" not in args
                    for required in ["mode", "keyframe_role", "first_frame_resize", "ref_image_size", "canvas", "aspect_ratio", "width", "height", "seconds", "prompt"]:
                        assert required in args
                    return
    raise AssertionError("MiniMaxH3Easy.execute not found")


def test_standalone_audio_refs_are_explicitly_autogrow_up_to_three():
    source = NODES.read_text(encoding="utf-8")
    start = source.index('"ref_audios"')
    end = source.index('def _canvas_inputs', start)
    block = source[start:end]
    assert 'max=3' in block
    assert 'up to 3 clips' in block
    assert 'separate voice references' in block


def test_schema_defaults_are_native_canvas_and_five_seconds():
    source = NODES.read_text(encoding="utf-8")
    assert 'CANVAS_NATIVE,' in source[source.index('def _canvas_inputs'):source.index('class MiniMaxH3EasyLoader')]
    seconds = re.search(r'io\.Float\.Input\(\s*"seconds".*?default=([A-Z0-9_]+)', source, re.S)
    assert seconds and seconds.group(1) == "DEFAULT_SECONDS"


def test_frontend_repairs_only_invalid_core_defaults_by_widget_name():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function repairCoreWidgetDefaults"):source.index("function installPromptFirstLayout", source.index("function repairCoreWidgetDefaults"))]
    assert 'repairChoice("canvas", H3E_VALID.canvas, H3E_DEFAULTS.canvas)' in block
    assert 'repairChoice("aspect_ratio", H3E_VALID.aspectRatio, H3E_DEFAULTS.aspectRatio)' in block
    assert 'repairNumber("seconds", H3E_DEFAULTS.seconds, 1, 30)' in block
    assert 'repairNumber("ref_video_fps", H3E_DEFAULTS.refVideoFps, 1, 240)' in block
    assert 'repairNumber("ref_video_fps_2", H3E_DEFAULTS.refVideoFpsOverride, 0, 240' in block
    assert 'repairNumber("ref_video_fps_3", H3E_DEFAULTS.refVideoFpsOverride, 0, 240' in block
    assert "widgets_values" not in block


def test_only_mode_is_visually_before_prompt_editor():
    source = EDITOR.read_text(encoding="utf-8")
    layout = source[source.index("function installPromptFirstLayout"):source.index("function injectStyles")]
    assert 'if (widgetNameMatches(widget?.name, "mode")) { modeWidget = widget; continue; }' in layout
    assert 'if (widget === controller.widget) { promptWidget = widget; continue; }' in layout
    assert 'const durationWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "seconds"));' in layout
    assert 'const aspectWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "aspect_ratio"));' in layout
    assert 'const resolutionWidget = takeWidget((widget) => widgetNameMatches(widget?.name, "canvas"));' in layout
    assert 'return [modeWidget, promptWidget, ...afterPrompt, ...rest].filter(Boolean);' in layout
    assert "nodeState(" not in layout


def test_shot_autofill_uses_only_known_editor_placeholders():
    editor = EDITOR.read_text(encoding="utf-8")
    guidelines = GUIDELINES.read_text(encoding="utf-8")
    fn = editor[editor.index("function nextShotScaffold"):editor.index("function shotFieldOptions")]
    placeholders = {value for value in re.findall(r"(?<!\$)\{([^{}\n]+)\}", fn) if "," not in value}
    known_block = guidelines[guidelines.index("export const EDITOR_PLACEHOLDER_HELP"):guidelines.index("export const CAMERA =")]
    known = set(re.findall(r'^\s*"([^"]+)"\s*:', known_block, re.M))
    assert placeholders
    assert placeholders <= known, placeholders - known


def test_shot_context_is_inline_not_separate_button_help():
    source = EDITOR.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'const autofill = document.createElement("button")' not in controller
    assert 'const suggest = document.createElement("button")' not in controller
    assert 'openSuggestions()' not in controller
    assert 'autofillPromptOrShot()' not in controller
    hints = source[source.index("function contextHint"):source.index("function tokenEnd")]
    assert '"Shots · [ = next shot scaffold · @ = connected references · # = dialogue · Tab = next field"' in hints
    assert '"Summary · [ = task type · @ = tracked references · Tab = next field"' in hints

def test_mode_aware_shot_scaffold_matches_h3_flows():
    source = EDITOR.read_text(encoding="utf-8")
    fn = source[source.index("function nextShotScaffold"):source.index("function shotFieldOptions")]
    assert "PROFILE.I2VA" in fn and "{action onset}" in fn and "{continuous development}" in fn and "{result / reaction}" in fn
    assert "PROFILE.FL2VA" in fn and "{first-frame visible state}" in fn and "{changes between first and last frame}" in fn and "{approach to final frame}" in fn
    assert "PROFILE.L2VA" in fn and "{state before the final frame}" in fn and "{motion toward the final frame}" in fn and "{final-frame convergence}" in fn
    assert 'state.editorProfile === PROFILE.REF2VA' in fn and 'The target video uses {visual style}' in fn

def test_tab_selected_placeholder_opens_contextual_choice_menu():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("openSelectedPlaceholderChoices(state ="):source.index("choose(index)", source.index("openSelectedPlaceholderChoices(state ="))]
    assert 'kind: "placeholder"' in block
    assert 'start: placeholder.start' in block
    assert 'end: placeholder.end' in block
    assert 'placeholderContext(placeholder, state, textarea.value)' in block
    keydown = source[source.index('textarea.addEventListener("keydown", (event) => {'):source.index('textarea.addEventListener("blur"')]
    assert 'controller.openSelectedPlaceholderChoices(state, placeholder);' in keydown

def test_every_tab_field_gets_choices_and_open_fields_keep_custom_entry():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function placeholderContext"):source.index("function contextualOptions", source.index("function placeholderContext"))]
    assert 'return { label: "Open field", options: [] }' not in block
    assert 'const options = openPlaceholderOptions(placeholder, state, prompt);' in block
    assert 'customPlaceholderOption(placeholder)' in source
    assert 'const customEditing = Boolean(option.custom);' in source
    assert 'if (!customEditing) this.openSelectedPlaceholderChoices(state, placeholder);' in source
    assert 'label: "Camera options"' in block
    assert 'label: "Soundscape"' in block
    assert 'label: "Non-diegetic music"' in block




def test_placeholder_menu_highlights_exact_replacement_range_from_caret_or_tab():
    source = EDITOR.read_text(encoding="utf-8")
    detector = source[source.index("function editorPlaceholderAtSelection"):source.index("function highlightPlaceholderReplacement")]
    assert "const caretInside = start === end && start > from && start < to;" in detector
    assert "const exactReplacementSelected = start === from && end === to;" in detector
    assert "caretInside || exactReplacementSelected" in detector
    assert "start < to && end > from" not in detector
    highlighter = source[source.index("function highlightPlaceholderReplacement"):source.index("function selectAdjacentEditorPlaceholder")]
    assert "textarea.setSelectionRange(start, end);" in highlighter
    navigator = source[source.index("function selectAdjacentEditorPlaceholder"):source.index("// Keep stable schema IDs")]
    assert "textarea.setSelectionRange(start, start + match[0].length);" in navigator
    placeholder_menu = source[source.index("openSelectedPlaceholderChoices(state ="):source.index("choose(index)", source.index("openSelectedPlaceholderChoices(state ="))]
    assert placeholder_menu.count("highlightPlaceholderReplacement(textarea, placeholder);") >= 2
    assert "Highlighted text = replacement target" in source
    assert ".h3e-textarea::selection" in source
    click = source[source.index('textarea.addEventListener("click"'):source.index('textarea.addEventListener("select"')]
    assert "controller.suppressAutocomplete = false;" in click
    assert "controller.syncMenu();" in click
    keyup = source[source.index('textarea.addEventListener("keyup", (event) => {', source.index('textarea.addEventListener("keydown", (event) => {')):source.index('textarea.addEventListener("blur"')]
    assert "controller.suppressAutocomplete = false;" in keyup
    assert "controller.syncMenu();" in keyup


def test_custom_option_is_top_and_default_when_a_field_offers_custom():
    source = EDITOR.read_text(encoding="utf-8")
    helper = source[source.index("function customOptionsFirst"):source.index("function customPlaceholderOption")]
    assert "option?.custom ? custom : other" in helper
    placeholder_menu = source[source.index("openSelectedPlaceholderChoices(state ="):source.index("choose(index)", source.index("openSelectedPlaceholderChoices(state ="))]
    assert "const options = customOptionsFirst(context.options);" in placeholder_menu
    assert "options," in placeholder_menu
    choose = source[source.index("choose(index)"):source.index("const activateStatus")]
    assert "const customEditing = Boolean(option.custom);" in choose
    assert "customEditing," in choose
    replace = source[source.index("function replaceRange"):source.index("function sourceNodeForInput")]
    assert "isKnownEditorPlaceholder(selectText) && !selectPlaceholder" in replace
    assert "textarea.setSelectionRange(selectionStart, selectionStart + selectText.length);" in replace



def test_reference_options_show_prompt_alias_and_socket_name():
    source = EDITOR.read_text(encoding="utf-8")
    assert 'function referenceSocketLabel(ref)' in source
    assert 'function referenceSocketDetail(ref)' in source
    assert 'return inputName ? `${ref.token} · ${inputName}` : ref.token;' in source
    assert 'function referenceInputLeaf(inputName)' in source
    assert 'insertOption(referenceSocketLabel(ref), referenceContextDetail(ref, section), ref.token, "Connected references", null, referenceContextExample(ref, section))' in source


def test_connection_changes_refresh_inferred_profile_and_layout():
    source = EDITOR.read_text(encoding="utf-8")
    observers = source[source.index("function attachNodeObservers"):source.index("app.registerExtension", source.index("function attachNodeObservers"))]
    assert "const previousConnections = node.onConnectionsChange;" in observers
    assert "const connections = function (...args)" in observers
    assert "previousConnections?.apply(this, args)" in observers
    assert "refreshControllerFromNode(this, true);" in observers
    assert "node.onConnectionsChange = connections;" in observers


def test_empty_or_unstructured_first_line_tab_opens_starter_template_menu():
    source = EDITOR.read_text(encoding="utf-8")
    assert 'function starterTemplateAvailable(textarea)' in source
    assert 'function starterTemplateOptions(state)' in source
    starter_available = source[source.index("function starterTemplateAvailable"):source.index("function contextHint")]
    assert 'if (editorPlaceholders(source).length) return false;' in starter_available
    assert '"T2V / T2VA · base video"' in source
    assert '"R2V / REF2VA · full reference"' in source
    assert '"T2A · audio-focused proxy"' in source
    assert '"R2A / REF2A · reference-audio proxy"' in source
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'openStarterTemplates(state = this.getState())' in controller
    keydown = source[source.index('textarea.addEventListener("keydown", (event) => {'):source.index('textarea.addEventListener("blur"')]
    assert 'starterTemplateAvailable(textarea)' in keydown
    assert 'controller.openStarterTemplates(state);' in keydown

def test_shift_tab_moves_to_previous_placeholder_instead_of_forward():
    source = EDITOR.read_text(encoding="utf-8")
    helper = source[source.index("function selectAdjacentEditorPlaceholder"):source.index("function replaceRange", source.index("function selectAdjacentEditorPlaceholder"))]
    assert "direction = 1" in helper
    assert "direction < 0" in helper
    assert ".reverse().find" in helper
    keydown = source[source.index('textarea.addEventListener("keydown", (event) => {'):source.index('textarea.addEventListener("blur"')]
    assert "const direction = event.shiftKey ? -1 : 1;" in keydown
    assert "selectAdjacentEditorPlaceholder(textarea, direction)" in keydown
    assert "selectNextEditorPlaceholder" not in keydown


def test_visible_diagnostic_can_navigate_all_issues():
    source = EDITOR.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'diagnosticPrev.textContent = "‹";' in controller
    assert 'diagnosticNext.textContent = "›";' in controller
    assert "diagnosticIndex" in controller
    assert "currentDiagnostic()" in controller
    assert "navigateDiagnostic(delta)" in controller
    assert "bindDiagnosticNavigation" in controller
    assert "diagnosticCount.textContent" in controller


def test_camera_choices_are_hierarchical_not_flat_modifier_dump():
    source = EDITOR.read_text(encoding="utf-8")
    guidelines = GUIDELINES.read_text(encoding="utf-8")
    camera = source[source.index("function cameraSentenceOption"):source.index("function timingOptions")]
    assert "CAMERA_MODIFIERS" not in source
    assert "{camera amplitude if needed}{camera speed if needed}" in camera
    assert 'function cameraAmplitudeOptions()' in camera
    assert 'function cameraSpeedOptions()' in camera
    placeholders = guidelines[guidelines.index("export const EDITOR_PLACEHOLDER_HELP"):guidelines.index("export const CAMERA =")]
    assert '"camera amplitude if needed"' in placeholders
    assert '"camera speed if needed"' in placeholders


def test_dialogue_language_suggests_stable_and_expanded_languages_in_requested_order():
    source = EDITOR.read_text(encoding="utf-8")
    guidelines = GUIDELINES.read_text(encoding="utf-8")
    assert '<d>[{dialogue language}] {spoken words}</d>' in source
    assert "STABLE_DIALOGUE_LANGUAGES" in source
    assert "DIALOGUE_LANGUAGE_OPTIONS" in source
    assert "export const STABLE_DIALOGUE_LANGUAGES" in guidelines
    assert "export const DIALOGUE_LANGUAGE_OPTIONS" in guidelines
    for language in ["Arabic", "Chinese", "English", "French", "German", "Italian", "Japanese", "Korean", "Portuguese", "Russian", "Spanish"]:
        assert f'"{language}"' in guidelines
    language_options = guidelines[guidelines.index("export const DIALOGUE_LANGUAGE_OPTIONS"):guidelines.index("// [fixed value", guidelines.index("export const DIALOGUE_LANGUAGE_OPTIONS"))]
    positions = [language_options.index(f'"{language}"') for language in ["English", "Russian", "Japanese", "Dutch", "French"]]
    assert positions == sorted(positions)
    for language in ["Dutch", "Ukrainian", "Polish", "Romanian", "Turkish", "Swedish", "Hindi", "Vietnamese"]:
        assert f'"{language}"' in language_options
    language_block = source[source.index("function dialogueLanguageOption"):source.index("function existingShotOptions") ]
    assert 'Additional dialogue language; H3 support may vary.' in language_block
    assert 'preferred ? "Preferred"' in language_block
    placeholder = source[source.index("function placeholderContext"):source.index("function contextualOptions", source.index("function placeholderContext"))]
    assert 'if (key === "dialogue language")' in placeholder
    assert 'options: languagePlaceholderOptions(placeholder)' in placeholder
    assert 'Custom language…' in source


def test_summary_task_types_are_incremental_contextual_choices():
    source = EDITOR.read_text(encoding="utf-8")
    guidelines = GUIDELINES.read_text(encoding="utf-8")
    block = source[source.index("function summaryTaskTypesInPrompt"):source.index("function contextualOptions", source.index("function summaryTaskTypesInPrompt"))]
    assert "{additional task type if needed}" in block
    assert 'insertOption("Done", "No additional relation."' in block
    assert '.filter(([value]) => !used.has(value.toLowerCase()))' in block
    assert '"additional task type if needed"' in guidelines


def test_ref_template_does_not_assume_reference_role_task_or_retention():
    source = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    block = source[source.index("export function templateForState"):source.index("export function profileDescription")]
    assert '"{define tracked reference content}"' in block
    assert '"{summary task type} {target video + main reference relationships}"' in block
    assert '"{retention rows for tracked references}"' in block
    assert '"[reference generation] The target video uses @Subject1' not in block
    assert '"@Subject1 (appears in [Shot 1]): {visual retention}"' not in block



def test_later_shot_scaffold_does_not_repeat_overall_style_and_keyframe_modes_keep_converging():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function nextShotScaffold"):source.index("function shotFieldOptions")]
    # Overall style belongs only in Shot 1 for base modes and before Shot 1 for Reference mode.
    assert 'isFirst && state.editorProfile === PROFILE.T2VA' in block
    generic_tail = block[block.index('if (!isFirst && state.editorProfile === PROFILE.FL2VA)'):]
    assert 'return `${shot.text}{visual style}.' not in generic_tail
    assert 'if (!isFirst && state.editorProfile === PROFILE.FL2VA)' in block
    assert '{approach to final frame}.' in block
    assert '{approach to final frame} toward ${ending}' not in block
    assert 'if (!isFirst && state.editorProfile === PROFILE.L2VA)' in block
    assert '{final-frame convergence}.' in block
    assert '{final-frame convergence} toward @Image1' not in block


def test_new_speaker_scaffold_splits_identity_and_voice_traits_for_tab_choices():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function dialogueLine"):source.index("function audioOptions")]
    assert 'const speaker = establish ? `{speaker identity} with {voice traits} (S${id})` : `(S${id})`' in block
    assert 'dialogueLine(next, false, true)' in block
    assert 'dialogueLine(next, true, true)' in block
    guidelines = GUIDELINES.read_text(encoding="utf-8")
    assert '"speaker identity"' in guidelines
    assert '"voice traits"' in guidelines
    assert '"speaker identity / voice traits"' in guidelines  # legacy prompts remain recognized


def test_speaker_discovery_uses_actual_timeline_vocal_events_not_any_s_id_mention():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function knownSpeakerIds"):source.index("function nextSpeakerOrdinal")]
    assert 'timelineBodyForPrompt(prompt)' in block
    assert 'matchAll(/<d>' in block
    assert 'vocalClauseBeforeEditor' in block
    assert 'speakerIdsIn(timelineBodyForPrompt(prompt))' not in block


def test_dialogue_punctuation_rule_is_source_audio_contextual_not_mode_wide():
    source = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    block = source[source.index("function validateDialogue"):source.index("function generationInputIssues")]
    assert 'const audioSourceMatch = state.conditioningProfile === PROFILE.REF2VA' in block
    assert 'if (audioSourceMatch &&' in block
    assert 'if (state.editorProfile === PROFILE.REF2VA && !/<(?:scenetrans|cutoff)>/i.test(spoken)' not in block
    assert "source-audio" in block
    assert 'inTimeline && !speakerMatch && !audioSourceMatch' in block


def test_duration_is_user_setting_but_playback_is_fixed_native_24():
    editor = EDITOR.read_text(encoding="utf-8")
    nodes = NODES.read_text(encoding="utf-8")
    runtime = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    main = nodes[nodes.index('class MiniMaxH3Easy(io.ComfyNode):'):nodes.index('class MiniMaxH3EasyOutput')]
    assert '["seconds", "Requested duration (s)"]' in editor
    assert 'display_name="Requested duration (s)"' in nodes
    assert '"playback_fps"' not in main
    assert 'DEFAULT_PLAYBACK_FPS = 24.0' in runtime


def test_native_h3_calls_use_keyword_arguments_not_fragile_positions():
    runtime = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    ref = runtime[runtime.index("core_out = h3.MiniMaxH3ReferenceToVideo.execute"):runtime.index("conditioning, latent = core_out.result", runtime.index("core_out = h3.MiniMaxH3ReferenceToVideo.execute"))]
    base = runtime[runtime.index("core_out = h3.MiniMaxH3ImageToVideo.execute"):runtime.index("conditioning, latent = core_out.result", runtime.index("core_out = h3.MiniMaxH3ImageToVideo.execute"))]
    for field in ["clip=", "vae=", "audio_vae=", "prompt=", "width=", "height=", "length="]:
        assert field in ref
    for field in ["clip=", "vae=", "prompt=", "width=", "height=", "length=", "first_frame=", "last_frame="]:
        assert field in base


def test_docs_use_capability_requirement_not_unreleased_fixed_version():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    docs = (ROOT / "web" / "docs" / "MiniMaxH3EasyV4.md").read_text(encoding="utf-8")
    current = readme + "\n" + docs
    assert "native `comfy_extras.nodes_minimax_h3` support" in current
    assert "0.31.0 or newer" not in current

def test_option_lists_are_compact_and_hover_explains_them():
    source = EDITOR.read_text(encoding="utf-8")
    assert '.h3e-menu-detail { display:none;' in source
    assert '.h3e-menu-row.selected .h3e-menu-detail { display:block; }' in source
    assert '.h3e-menu-insert { display:none;' in source
    assert '.h3e-menu-row.selected .h3e-menu-insert { display:block; }' in source
    render = source[source.index("function renderMenu"):source.index("function makeController")]
    assert 'const tooltip = [option.detail' in render
    assert 'row.title = tooltip;' in render


def test_prompt_menu_supports_keyboard_hover_and_click_insertion():
    source = EDITOR.read_text(encoding="utf-8")
    render = source[source.index("function renderMenu"):source.index("function makeController")]
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'document.createElement("button")' not in render
    assert 'row.addEventListener("pointerdown"' in render
    assert 'row.addEventListener("pointerenter"' in render
    assert 'controller.choose(index);' in render
    assert '.h3e-menu-row.selected { background:rgba(81,132,220,.34); box-shadow:inset 3px 0 0 rgba(126,169,255,.9); }' in source
    assert 'status.addEventListener("click"' in controller
    assert 'status.title =' in controller


def test_tab_accepts_selected_menu_item_and_never_tabs_out_of_editor():
    source = EDITOR.read_text(encoding="utf-8")
    keydown = source[source.index('textarea.addEventListener("keydown", (event) => {'):source.index('textarea.addEventListener("blur"')]
    assert 'event.key === "Tab" && !event.shiftKey' in keydown
    assert 'controller.choose(controller.menuIndex);' in keydown
    tab_block = keydown[keydown.index('if (event.key === "Tab" && !event.ctrlKey'): ]
    assert 'event.preventDefault();' in tab_block
    assert 'Tab is an' in tab_block and 'never browser focus navigation' in tab_block
    render = source[source.index("function renderMenu"):source.index("function makeController")]
    assert 'Tab / Enter / click to insert' in render


def test_prompt_hot_path_avoids_graph_redraw_and_immediate_full_validation():
    source = EDITOR.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    commit = controller[controller.index("commit() {"):controller.index("scheduleRefresh(delay", controller.index("commit() {"))]
    assert "setDirtyCanvas" not in commit
    assert "this.scheduleRefresh(120)" in commit
    assert 'stateCache' in controller and 'externalRevision' in controller


def test_menu_arrow_navigation_does_not_rebuild_dom():
    source = EDITOR.read_text(encoding="utf-8")
    keydown = source[source.index('textarea.addEventListener("keydown", (event) => {'):source.index('textarea.addEventListener("blur"')]
    assert 'moveMenuSelection(controller, 1); return;' in keydown
    assert 'moveMenuSelection(controller, -1); return;' in keydown
    assert 'moveMenuSelection(controller, 1); renderMenu(controller)' not in keydown
    assert 'moveMenuSelection(controller, -1); renderMenu(controller)' not in keydown


def test_validator_compiles_prompt_preview_once_per_validation():
    source = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    state_block = source[source.index("export function nodeState"):source.index("function validateShots")]
    validate = source[source.index("export function validatePrompt"):source.index("function dedupe")]
    assert "compiledPreview = compilePromptPreview" not in state_block
    assert validate.count("compilePromptPreview(prompt, state)") == 1
    assert "compiledPreview," in validate



def test_bracket_trigger_inserts_full_next_shot_scaffold_and_focuses_cut_time_first():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function bracketOptions"):source.index("function speakerOptions")]
    assert 'const scaffold = nextShotScaffold(state, prompt);' in block
    assert 'later shots select the cut timestamp before any prose field' in block
    assert 'shot.selectText || firstEditorPlaceholder(scaffold)' in block


def test_visual_style_offers_documented_examples_reference_style_and_custom():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index('if (key === "visual style")'):source.index('if (["target subject"', source.index('if (key === "visual style")'))]
    assert 'styleSubjectOptions(prompt)' in block
    assert 'presetPlaceholderOptions(placeholder)' in block
    assert 'Custom visual style…' in block
    assert 'presets are examples, not a closed H3 enum' in block


def test_motion_helper_fields_are_known_and_have_presets():
    guidelines = GUIDELINES.read_text(encoding="utf-8")
    choices = (ROOT / "web" / "h3_prompt_choices.js").read_text(encoding="utf-8")
    for field in [
        "action / motion performance",
        "action / motion pattern",
        "pose sequence / timing / body mechanics",
    ]:
        assert f'"{field}"' in guidelines
        assert f'"{field}": [' in choices


def test_retention_row_tab_flow_selects_fixed_visual_or_audio_marker():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function missingRetentionOptions"):source.index("function audioLayerReferenceOptions")]
    assert 'definition.kind === "audio" ? "{audio retention}" : "{visual retention}"' in block
    assert 'retentionField, example)' in block
    assert ':\\\\s*`' in block  # JS source must keep \s for RegExp; a single template escape becomes plain s.
    context = source[source.index("function placeholderContext"):source.index("function contextualOptions", source.index("function placeholderContext"))]
    assert 'key === "visual retention" || key === "audio retention"' in context
    assert 'key === "audio retention" ? AUDIO_RETENTION : VISUAL_RETENTION' in context


def test_requested_prompt_dimensions_have_multiple_choice_presets():
    choices = (ROOT / "web" / "h3_prompt_choices.js").read_text(encoding="utf-8")
    for field in [
        "visual style",
        "shot size / framing",
        "viewpoint",
        "subject / scene",
        "action in playback order",
        "speaker identity",
        "voice traits",
        "instruments / sound sources",
        "tempo / rhythm",
        "dynamic change",
    ]:
        assert f'"{field}": [' in choices


def test_control_labels_are_self_explanatory():
    nodes = NODES.read_text(encoding="utf-8")
    editor = EDITOR.read_text(encoding="utf-8")
    for label in [
        'display_name="First/last frame images"',
        'display_name="Image 1 is"',
        'display_name="Video aspect ratio source"',
        'display_name="Opening frame resize"',
        'display_name="Ending frame resize"',
        'display_name="Output resolution"',
        'display_name="Requested duration (s)"',
        'display_name="Reference image resolution"',
        'display_name="Reference video end handling"',
    ]:
        assert label in nodes
    assert '["keyframe_canvas", "Video aspect ratio source"]' in editor
    assert '["first_frame_resize", "Opening frame resize"]' in editor
    assert '["last_frame_resize", "Ending frame resize"]' in editor
    assert '"Preserve full frame (pad edges)"' in (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    assert '"Fill output (crop edges)"' in (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    assert '"Stretch to output (distorts)"' in (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")


def test_prompt_status_and_visible_diagnostic_precede_textarea():
    source = EDITOR.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert "wrapper.append(modelLine, compiledLine, compiledPanel, routeNotice, head, diagnostic, textarea, menu, contextbar);" in controller
    assert 'diagnostic.classList.add("open");' in controller
    assert 'status.tabIndex = -1;' in controller
    assert 'status.tabIndex = actionable ? 0 : -1;' in controller
    assert 'controller.focusDiagnostic();' in controller


def test_prompt_helper_has_no_autofill_or_suggestions_buttons():
    source = EDITOR.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'autofill.addEventListener' not in controller
    assert 'suggest.addEventListener' not in controller
    assert 'h3e-suggest' not in source


def test_old_widget_choice_strings_are_mapped_to_clear_names():
    source = EDITOR.read_text(encoding="utf-8")
    runtime = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    assert '["Full Reference (REF2VA)", MODE_VIDEO]' in source
    assert '["References (REF2VA)", MODE_VIDEO]' in source
    assert '["Base / Keyframes (T2VA/I2VA/FL2VA/L2VA)", MODE_VIDEO]' in source
    assert '["Adaptive to keyframe (recommended)", KEYFRAME_CANVAS_ADAPTIVE]' in source
    assert 'LEGACY_MODE_REFERENCE' in runtime and 'LEGACY_MODE_BASE' in runtime
    assert 'LEGACY_KEYFRAME_CANVAS_ADAPTIVE' in runtime
    assert 'LEGACY_FIRST_FRAME_FIT_AUTO' in runtime


def test_removed_advanced_workflow_values_are_collapsed_before_load():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function migrateRemovedAdvancedSelector"):source.index("function migrateLegacyWorkflow")]
    assert 'text(values.at(-3)) === "on"' in block
    assert 'values.splice(values.length - 3, 2, fps);' in block
    assert '["on", "off"].includes(text(values.at(-2)))' in block
    assert 'values[values.length - 2] = H3E_DEFAULTS.playbackFps;' in block
    hook = source[source.index("beforeConfigureGraph(workflow)"):source.index("afterConfigureGraph()") ]
    assert hook.index("migrateRemovedAdvancedSelector(workflow)") < hook.index("migrateLegacyWorkflow(workflow)")


def test_v1_replacement_drops_advanced_and_old_playback_override():
    source = NODES.read_text(encoding="utf-8")
    block = source[source.index('old_node_id="MiniMaxH3Easy"'):source.index('output_mapping=[', source.index('old_node_id="MiniMaxH3Easy"'))]
    assert '"new_id": "playback_fps"' not in block
    assert '"new_id": "advanced"' not in block
    assert '"new_id": "advanced.playback_fps"' not in block


def test_visible_control_ids_match_backend_reads():
    nodes = NODES.read_text(encoding="utf-8")
    runtime = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    editor = EDITOR.read_text(encoding="utf-8")
    # Mode DynamicCombo children are read from the mode mapping under the same IDs.
    for control in [
        "keyframe_role", "keyframe_canvas", "first_frame_resize", "last_frame_resize",
        "ref_image_size", "ref_video_size", "ref_video_fps",
        "ref_video_fps_2", "ref_video_fps_3", "ref_video_temporal_fit",
    ]:
        assert f'"{control}"' in nodes
        assert f'"{control}"' in runtime
        assert f'["{control}",' in editor
    for group in ["keyframes", "ref_images", "ref_videos", "ref_video_audios", "ref_audios"]:
        assert f'"{group}"' in nodes
        assert f'mode.get("{group}")' in runtime
    # Canvas controls are static top-level values; playback is fixed to H3's native 24 fps.
    for control in ["canvas", "aspect_ratio", "width", "height"]:
        assert f'"{control}"' in nodes
        assert f'"{control}"' in runtime
    assert 'def resolve_playback_fps(value: float = DEFAULT_PLAYBACK_FPS)' in runtime
    assert 'out_fps = DEFAULT_PLAYBACK_FPS if selected_mode == MODE_AUDIO else resolve_playback_fps(playback_fps)' in runtime
    assert 'advanced' not in runtime.lower()


def test_full_default_contract_is_explicit_and_consistent():
    nodes = NODES.read_text(encoding="utf-8")
    runtime = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    defaults = (ROOT / "web" / "h3_defaults.js").read_text(encoding="utf-8")
    validator = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")

    expected_python = {
        "DEFAULT_MODE": "MODE_VIDEO",
        "DEFAULT_CANVAS": "CANVAS_NATIVE",
        "DEFAULT_KEYFRAME_ROLE": "KEYFRAME_FIRST",
        "DEFAULT_KEYFRAME_CANVAS": "KEYFRAME_CANVAS_ADAPTIVE",
        "DEFAULT_FIRST_FRAME_RESIZE": "FIRST_FRAME_FIT_PAD",
        "DEFAULT_LAST_FRAME_RESIZE": "FIRST_FRAME_FIT_CROP",
        "DEFAULT_REF_IMAGE_SIZE": "REF_IMAGE_MATCH",
        "DEFAULT_REF_VIDEO_SIZE": "REF_VIDEO_NATIVE",
        "DEFAULT_REF_VIDEO_TEMPORAL_FIT": "REF_VIDEO_TEMPORAL_CORE",
        "DEFAULT_SECONDS": "5.0",
        "DEFAULT_PLAYBACK_FPS": "24.0",
        "DEFAULT_ASPECT_RATIO": '"16:9"',
        "DEFAULT_CUSTOM_WIDTH": "1344",
        "DEFAULT_CUSTOM_HEIGHT": "768",
        "DEFAULT_REF_VIDEO_FPS": "24.0",
        "DEFAULT_REF_VIDEO_FPS_OVERRIDE": "0.0",
    }
    for name, value in expected_python.items():
        assert f"{name} = {value}" in runtime

    expected_frontend = [
        'mode: "Video + audio"',
        'canvas: "768P (native)"',
        'aspectRatio: "16:9"',
        'customWidth: 1344',
        'customHeight: 768',
        'seconds: 5',
        'playbackFps: 24',
        'keyframeRole: "First frame"',
        'keyframeCanvas: "Opening frame; if absent, last frame"',
        'firstFrameResize: "Preserve full frame (pad edges)"',
        'lastFrameResize: "Fill output (crop edges)"',
        'refImageSize: "Balanced to output area (may upscale)"',
        'refVideoSize: "768P native"',
        'refVideoFps: 24',
        'refVideoFpsOverride: 0',
        'refVideoTemporalFit: "Trim tail to valid H3 frame count"',
    ]
    for line in expected_frontend:
        assert line in defaults

    main = nodes[nodes.index('class MiniMaxH3Easy(io.ComfyNode):'):nodes.index('class MiniMaxH3EasyOutput')]
    assert 'io.DynamicCombo.Input' not in main
    assert 'options=[MODE_VIDEO, MODE_AUDIO]' in main
    assert '*_keyframe_inputs()' in main and '*_reference_inputs()' in main and '*_canvas_inputs()' in main
    assert 'default=DEFAULT_ASPECT_RATIO' in nodes
    assert 'default=DEFAULT_CUSTOM_WIDTH' in nodes
    assert 'default=DEFAULT_CUSTOM_HEIGHT' in nodes
    assert 'default=DEFAULT_SECONDS' in nodes
    main = nodes[nodes.index('class MiniMaxH3Easy(io.ComfyNode):'):nodes.index('class MiniMaxH3EasyOutput')]
    assert 'default=DEFAULT_PLAYBACK_FPS' not in main
    assert 'default=DEFAULT_REF_VIDEO_FPS' in nodes
    assert nodes.count('default=DEFAULT_REF_VIDEO_FPS_OVERRIDE') == 2
    assert 'default=DEFAULT_KEYFRAME_ROLE' in nodes
    assert 'default=DEFAULT_KEYFRAME_CANVAS' in nodes
    assert 'default=DEFAULT_FIRST_FRAME_RESIZE' in nodes
    assert 'default=DEFAULT_LAST_FRAME_RESIZE' in nodes
    assert 'default=DEFAULT_REF_IMAGE_SIZE' in nodes
    assert 'default=DEFAULT_REF_VIDEO_SIZE' in nodes
    assert 'default=DEFAULT_REF_VIDEO_TEMPORAL_FIT' in nodes

    assert 'H3E_DEFAULTS.seconds' in validator
    assert 'const playbackFps = 24;' in validator
    assert 'H3E_DEFAULTS.refVideoFps' in validator
    assert 'H3E_DEFAULTS.refVideoFpsOverride' in validator




def test_validator_uses_current_end_handling_label_and_native_playback():
    validator = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    defaults = (ROOT / "web" / "h3_defaults.js").read_text(encoding="utf-8")
    assert 'refVideoTemporalHold: "Keep last frame (pad to valid H3 length)"' in defaults
    assert 'String(state.refVideoTemporalFit) === H3E_VALUES.refVideoTemporalHold' in validator
    assert 'startsWith("Preserve endpoint")' not in validator
    assert 'rawPlaybackFps' not in validator
    assert '"Invalid output playback FPS"' not in validator
    assert 'const playbackFps = 24;' in validator
    assert 'String(state.refVideoSize) !== H3E_DEFAULTS.refVideoSize' in validator
    assert 'state.refVideoSize).startsWith("768P")' not in validator


def test_loader_routes_models_without_filename_capability_gates():
    source = NODES.read_text(encoding="utf-8")
    loading = (ROOT / "h3easy" / "model_loading.py").read_text(encoding="utf-8")
    block = source[source.index("class MiniMaxH3EasyLoader"):source.index("class MiniMaxH3Easy(io.ComfyNode)")]
    assert 'options=frame_options' in block
    assert 'options=reference_options' in block
    assert 'options=audio_options' in block
    assert 'default=frame_default' in block
    assert 'default=reference_default' in block
    assert 'default=audio_default' in block
    assert 'filenames are never capability gates' in block.lower()
    assert 're.search' not in loading
    assert '_has_role' not in loading
    assert '("diffusion_models", "unet_gguf")' in loading
    assert '("text_encoders", "clip_gguf")' in loading

def test_legacy_positional_migration_never_runs_on_current_v2_node():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function migrateLegacyWorkflow"):source.index("function textBeforeCaret")]
    assert 'if (node?.type !== "MiniMaxH3Easy") continue;' in block
    assert "MiniMaxH3EasyV2" not in block.split("continue;", 1)[0]


def test_info_reports_exact_routed_diffusion_model():
    source = (ROOT / "h3easy" / "nodes.py").read_text(encoding="utf-8")
    assert 'f"Diffusion model: {h3_context.diffusion_model}"' in source




def test_published_reference_envelope_is_advisory_not_a_frontend_capability_gate():
    source = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    validate_inputs = source[source.index("function validateReferenceInputs"):source.index("function validateReference(prompt, state)")]
    generation_notes = source[source.index("function generationNotes"):source.index("function validateReferenceInputs")]
    assert "Too many reference images" not in validate_inputs
    assert "Audio cannot be the sole" not in validate_inputs
    assert "Outside MiniMax's published Ref2VA input envelope" in generation_notes
    assert "does not use the published envelope as a checkpoint capability gate" in generation_notes

def test_context_dataclass_has_no_duplicate_field_annotations():
    source = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "MiniMaxH3Context":
            names = [
                stmt.target.id
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
            ]
            assert len(names) == len(set(names)), names
            assert names.count("diffusion_model") == 1
            return
    raise AssertionError("MiniMaxH3Context not found")


def test_published_audio_envelope_uses_standalone_count_not_presented_audio_namespace():
    source = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    state = source[source.index("export function nodeState"):source.index("function validateShots")]
    notes = source[source.index("function generationNotes"):source.index("function validateReferenceInputs")]
    assert "const standaloneAudioCount = standaloneAudioInputs.length;" in state
    assert "audioCount: referenceRouteActive ? audioCount : 0" in state
    assert "standaloneAudioCount: referenceRouteActive ? standaloneAudioCount : 0" in state
    assert "state.standaloneAudioCount > 3" in notes
    assert "state.audioCount > 3" not in notes


def test_duration_help_is_concise_and_validator_keeps_range_context():
    nodes = NODES.read_text(encoding="utf-8")
    validator = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    assert 'tooltip="H3 runs on its native 24 fps timeline and snaps to a valid frame count."' in nodes
    assert "state.requestedSeconds < 4 || state.requestedSeconds > 15" in validator
    assert "else if (state.requestedSeconds < 5)" in validator


def test_high_detail_reference_label_describes_current_comfy_no_upscale_behavior():
    runtime = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    defaults = (ROOT / "web" / "h3_defaults.js").read_text(encoding="utf-8")
    assert 'REF_IMAGE_MAX = "2048px short-edge cap (no upscale)"' in runtime
    assert '"2048px short-edge cap (no upscale)"' in defaults
    assert 'LEGACY_REF_IMAGE_MAX_DETAIL = "2048px short edge (maximum detail)"' in runtime



def test_playback_fps_is_not_a_generation_ui_setting():
    nodes = NODES.read_text(encoding="utf-8")
    editor = EDITOR.read_text(encoding="utf-8")
    validator = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    main = nodes[nodes.index('class MiniMaxH3Easy(io.ComfyNode):'):nodes.index('class MiniMaxH3EasyOutput')]
    assert 'display_name="Output playback FPS"' not in main
    assert '["playback_fps", "Output playback FPS"]' not in editor
    assert 'Output playback FPS must be a finite number' not in validator
    assert 'const playbackFps = 24;' in validator


def test_split_source_provenance_is_advisory_not_inferred_intent_error():
    validator = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    marker = '"split-source-provenance"'
    pos = validator.index(marker)
    block = validator[max(0, pos - 1400):pos + 200]
    assert 'notes.push(note(' in block
    assert 'issues.push(issue(' not in block[block.rfind('if (!independentRole'): ]


def test_unclear_suggestion_is_limited_to_reference_audio_context():
    editor = EDITOR.read_text(encoding="utf-8")
    dialogue = editor[editor.index("function dialogueOptions"):editor.index("function bracketOptions")]
    bracket = editor[editor.index("function bracketOptions"):editor.index("function speakerOptions")]
    assert 'state.editorProfile === PROFILE.REF2VA && state.audioCount > 0' in dialogue
    assert 'state.editorProfile === PROFILE.REF2VA && state.audioCount > 0' in bracket


def test_reference_scaffold_placeholder_exposes_role_choice_without_guessing_it():
    editor = EDITOR.read_text(encoding="utf-8")
    block = editor[editor.index('if (key === "define tracked reference content")'):editor.index('if (key === "retention rows for tracked references")')]
    assert '...subjectHelpers(state, prompt)' in block
    assert '...referenceOptions(state, prompt, "", "subject_definitions")' in block
    assert 'Choose a semantic Subject/helper, a connected asset role, or Custom.' in block
    assert 'Custom definition…' in block


def test_autocomplete_menu_is_inline_below_textarea_not_overlaying_selection():
    source = EDITOR.read_text(encoding="utf-8")
    assert '.h3e-menu { position:relative;' in source
    assert 'position:absolute' not in source[source.index('.h3e-menu {'):source.index('.h3e-menu.open')]
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'wrapper.append(modelLine, compiledLine, compiledPanel, routeNotice, head, diagnostic, textarea, menu, contextbar);' in controller
    assert controller.index('textarea, menu') > 0


def test_selected_model_line_sits_inside_editor_directly_below_mode_layout():
    source = EDITOR.read_text(encoding="utf-8")
    layout = source[source.index("function installPromptFirstLayout"):source.index("function injectStyles")]
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'return [modeWidget, promptWidget, ...afterPrompt, ...rest].filter(Boolean);' in layout
    assert 'modelLine.className = "h3e-model-line"' in controller
    assert 'wrapper.append(modelLine, compiledLine, compiledPanel, routeNotice, head, diagnostic, textarea, menu, contextbar);' in controller
    assert 'function selectedModelInfo(node, state)' in source
    assert 'state?.conditioningProfile === PROFILE.REF2VA' in source
    assert 'Selected model: ${selected}' in source
    assert 'subscribeModelSource(source, () =>' in controller


def test_compiled_prompt_is_visible_and_backend_output_has_no_debug_identifier():
    source = EDITOR.read_text(encoding="utf-8")
    nodes = NODES.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'compiledLine.className = "h3e-compiled-line"' in controller
    assert 'Compiled Prompt: ${compactCompiled || "(empty)"}' in controller
    assert 'compiledPanel.className = "h3e-compiled-panel"' in controller
    assert 'compiledPre.textContent = compiled || "(empty)"' in controller
    assert 'compiledLine.addEventListener("click"' in controller
    assert 'copyTextToClipboard(compiled)' in controller
    assert 'result.compiledPreview' in controller
    assert 'io.String.Output("compiled_prompt", display_name="Compiled Prompt")' in nodes
    assert 'compiled_prompt_debug' not in nodes


def test_at_reference_completion_cascades_into_role_templates():
    source = EDITOR.read_text(encoding="utf-8")
    reference = source[source.index("function referenceRoleVariants"):source.index("function subjectHelpers")]
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert "function referenceFollowupOptions" in reference
    assert "function timelineReferenceFollowupOptions" in reference
    assert "function endpointImageFollowupOptions" in reference
    assert "referenceRef: ref" in reference
    assert "referenceRef: subjectRef" in reference
    for label in ["signal reuse", "voice reference", "BGM style", "dialogue / lyric content", "sound-effect texture", "beat / rhythm / continuity"]:
        assert label in source
    assert 'openReferenceFollowup(ref, start, end, section' in controller
    assert 'kind: "reference-followup"' in controller
    assert 'if (!customEditing && option.referenceRef)' in controller
    assert 'Continue ${ref.token} · choose a role/template' in controller
    assert 'Keep ${ref.token} only' in source


def test_v4_schema_replaces_v2_dynamic_schema():
    nodes = NODES.read_text(encoding="utf-8")
    assert 'node_id="MiniMaxH3EasyV4"' in nodes
    assert 'old_node_id="MiniMaxH3EasyV2"' in nodes
    for mapping in ['"mode.keyframe_role"', '"mode.first_frame_resize"', '"mode.ref_image_size"', '"canvas.aspect_ratio"']:
        assert mapping in nodes


def test_easy_loader_audio_model_is_optional_override():
    source = (ROOT / "h3easy" / "nodes.py").read_text(encoding="utf-8")
    loading = (ROOT / "h3easy" / "model_loading.py").read_text(encoding="utf-8")
    assert '"audio_model"' in source
    assert 'display_name="Audio-only model override"' in source
    assert 'advanced=True' in source[source.index('display_name="Audio-only model override"'):source.index('],\n            outputs=', source.index('display_name="Audio-only model override"'))]
    assert 'AUTO_AUDIO_MODEL = "Auto (match conditioning)"' in loading
    assert 'route == "audio_ref2va"' in loading


def test_audio_mode_is_output_intent_not_dynamic_schema():
    runtime = (ROOT / "h3easy" / "runtime.py").read_text(encoding="utf-8")
    defaults = (ROOT / "web" / "h3_defaults.js").read_text(encoding="utf-8")
    nodes = NODES.read_text(encoding="utf-8")
    assert 'MODE_VIDEO = "Video + audio"' in runtime
    assert 'MODE_AUDIO = "Audio only (32x32 proxy)"' in runtime
    assert 'AUDIO_PROXY_WIDTH = 32' in runtime and 'AUDIO_PROXY_HEIGHT = 32' in runtime
    assert 'mode: "Video + audio"' in defaults
    assert 'options=[MODE_VIDEO, MODE_AUDIO]' in nodes


def test_schema_stays_static_while_irrelevant_widgets_auto_collapse():
    source = EDITOR.read_text(encoding="utf-8")
    nodes = NODES.read_text(encoding="utf-8")
    layout = source[source.index("function layoutVisibilityState"):source.index("function injectStyles")]
    assert 'DynamicCombo.Input' not in nodes
    assert 'function layoutVisibilityState(node, controller = null, routeState = null)' in layout
    assert 'function layoutWidgetVisibility(widget, controller, state)' in layout
    assert 'function syncLayoutWidgetVisibility(node, controller, routeState = null)' in layout
    assert 'widget.hidden = true;' in layout
    assert 'restoreLayoutWidgetVisibility(node);' in layout
    assert 'return [modeWidget, promptWidget, ...afterPrompt, ...rest].filter(Boolean);' in layout
    assert 'connectedInputs(node, "keyframe_").length' in layout
    assert 'connectedInputs(node, "ref_image_").length' in layout
    assert 'connectedInputs(node, "ref_video_").length' in layout
    assert 'if (is("ref_video_fps_2")) return state.videoCount > 1;' in layout
    assert 'if (is("ref_video_fps_3")) return state.videoCount > 2;' in layout
    assert 'Values remain present, serialized' in layout


def test_reference_trigger_never_fails_silently_when_no_reference_is_available():
    source = EDITOR.read_text(encoding="utf-8")
    trigger = source[source.index("function detectTrigger"):source.index("function replaceRange")]
    assert '"No connected references"' in trigger
    assert '"No defined reference labels here"' in trigger
    assert '"No matching reference"' in trigger
    assert 'Then type @ again.' in trigger


def test_audio_timeline_placeholder_is_keyboard_contextual():
    source = EDITOR.read_text(encoding="utf-8")
    assert 'function audioTimelineOptions(state, prompt, placeholder = null)' in source
    assert 'if (key === "audio events in playback order")' in source
    for label in ["Dialogue / narration", "Singing / lyrics", "Sound effect / foley", "Diegetic music", "Pause / silence"]:
        assert f'"{label}"' in source
    assert "Custom audio event / sequence…" in source


def test_audio_decode_helper_uses_native_nested_audio_decode():
    source = NODES.read_text(encoding="utf-8")
    assert 'class MiniMaxH3EasyAudioDecode' in source
    assert 'nodes_audio.vae_decode_audio(h3_context.audio_vae, samples)' in source


def test_audio_mode_profile_badge_shows_audio_intent_not_internal_ref_profile():
    source = EDITOR.read_text(encoding="utf-8")
    assert 'const profileLabel = state.mixedConditioningFamilies' in source
    assert '? "Mixed"' in source
    assert "state.displayAudioMode" in source
    assert "state.promptAudioIntent" in source
    assert 'state.editorProfile === PROFILE.REF2VA ? "R2A / REF2A" : "T2A"' in source
    assert 'state.audioTask || "Audio-first"' in source


def test_audio_decode_rejects_non_nested_latent_clearly():
    source = NODES.read_text(encoding="utf-8")
    assert 'expects a sampled H3 nested audio-video latent' in source


def test_ending_frame_resize_is_append_only_and_visually_grouped_with_opening_resize():
    nodes = NODES.read_text(encoding="utf-8")
    editor = EDITOR.read_text(encoding="utf-8")
    main = nodes[nodes.index('class MiniMaxH3Easy(io.ComfyNode):'):nodes.index('class MiniMaxH3EasyOutput')]
    assert main.index('_prompt_input(),') < main.index('"last_frame_resize"')
    assert 'Append-only compatibility input' in main
    layout = editor[editor.index("function installPromptFirstLayout"):editor.index("function injectStyles")]
    assert 'widgetNameMatches(widget?.name, "last_frame_resize")' in layout
    assert 'widgetNameMatches(widget?.name, "first_frame_resize")' in layout
    assert 'openingResizeIndex + 1' in layout
    replacement = nodes[nodes.index('new_node_id="MiniMaxH3EasyV4",\n            old_node_id="MiniMaxH3EasyV3"'): ]
    assert '{"new_id": "last_frame_resize", "set_value": DEFAULT_LAST_FRAME_RESIZE}' in replacement


def test_v3_to_v4_replacement_maps_every_static_input_by_id():
    source = NODES.read_text(encoding="utf-8")
    assert 'node_id="MiniMaxH3EasyV4"' in source
    block = source[source.index('new_node_id="MiniMaxH3EasyV4",\n            old_node_id="MiniMaxH3EasyV3"'): ]
    for input_id in [
        "h3_bundle", "mode", "prompt", "canvas", "aspect_ratio", "width", "height",
        "seconds", "keyframes", "keyframe_role", "keyframe_canvas",
        "first_frame_resize", "ref_image_size", "ref_images", "ref_video_size",
        "ref_video_fps", "ref_video_fps_2", "ref_video_fps_3", "ref_video_temporal_fit",
        "ref_videos", "ref_video_audios", "ref_audios",
    ]:
        assert f'{{"new_id": "{input_id}", "old_id": "{input_id}"}}' in block


def test_v3_autogrow_detection_matches_dotted_input_paths():
    source = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    block = source[source.index("function inputLeafName"):source.index("export function connectedInputs")]
    assert 'value.split(/[.:/]/).at(-1)' in block
    assert 'const value = inputLeafName(name);' in block
    assert '"ref_images.ref_image_2"' in block


def test_audio_proxy_canvas_is_internal_and_not_offered_as_ui_state():
    editor = EDITOR.read_text(encoding="utf-8")
    defaults = (ROOT / "web" / "h3_defaults.js").read_text(encoding="utf-8")
    nodes = NODES.read_text(encoding="utf-8")
    canvas_block = nodes[nodes.index("def _canvas_inputs()"):nodes.index("class MiniMaxH3EasyLoader")]
    assert 'audioProxyCanvas: "32x32 (audio proxy)"' in defaults  # compatibility/migration sentinel only
    assert 'if (is("canvas")) return state.videoMode;' in editor
    assert 'function syncAudioProxyCanvas(node)' not in editor
    assert 'migrateRemovedAudioProxyCanvas(workflow)' in editor
    assert 'node.widgets_values[index] = H3E_DEFAULTS.canvas;' in editor
    assert 'CANVAS_AUDIO_PROXY' not in canvas_block


def test_mode_scaffolds_use_natural_host_grammar_for_choice_fields():
    editor = EDITOR.read_text(encoding="utf-8")
    validator = (ROOT / "web" / "h3_validator.js").read_text(encoding="utf-8")
    assert 'The shot uses {shot size / framing} framing from {viewpoint}' in editor
    assert 'A {shot size / framing} shot' not in editor
    assert 'begins from ${opening}. {first-frame visible state}.' in editor
    assert 'starts before the supplied final frame. {state before the final frame}.' in editor
    assert 'The framed subject is {subject appearance / pose / frame position}.' in editor
    assert 'The framed subject is {subject appearance / pose / frame position}.' in validator
    assert 'The score has {tempo / rhythm}' in editor


def test_speaker_and_voice_helpers_do_not_assume_two_characters_or_first_subject():
    source = EDITOR.read_text(encoding="utf-8")
    role = source[source.index("function referenceRoleVariants"):source.index("function referenceOptions", source.index("function referenceRoleVariants"))]
    assert "knownSubjectSpeakerBindings(prompt)" in role
    assert "const firstSubject" not in role
    assert "subjects[0]" not in role
    speaker = source[source.index("function speakerOptions"):source.index("function retentionTriggerOptions", source.index("function speakerOptions"))]
    assert "{speaker ID group}" in speaker
    assert "firstTwo" not in speaker
    assert "slice(0, 2)" not in speaker
    group = source[source.index("function speakerGroupPlaceholderOptions"):source.index("function currentSectionBeforeCaret", source.index("function speakerGroupPlaceholderOptions"))]
    assert "All established" in group
    assert "Custom speaker group" in group



def test_prompt_editor_enhances_native_string_after_node_construction():
    nodes = NODES.read_text(encoding="utf-8")
    editor = EDITOR.read_text(encoding="utf-8")
    prompt_block = nodes[nodes.index("def _prompt_input"):nodes.index("def _keyframe_inputs")]
    assert 'io.String.Input(' in prompt_block
    assert 'multiline=False' in prompt_block
    assert 'dynamic_prompts=False' in prompt_block
    assert 'MINIMAX_H3_PROMPT' not in nodes
    assert '@io.comfytype' not in prompt_block
    assert 'getCustomWidgets()' not in editor
    assert 'function installPromptEditorForNode(node)' in editor
    node_created = editor[editor.index('  nodeCreated(node) {'):editor.index('  loadedGraphNode(node) {')]
    assert 'installPromptEditorForNode(node)' in node_created
    assert 'Enhance only after ComfyUI has successfully constructed the native node.' in node_created


def test_prompt_editor_failure_leaves_native_prompt_usable():
    editor = EDITOR.read_text(encoding="utf-8")
    installer = editor[editor.index("function installPromptEditorForNode"):editor.index("function refreshControllerFromNode")]
    assert 'findNativePromptWidget(node)' in installer
    assert 'serialize: false' in installer
    assert 'widget.serialize = false' in installer
    assert 'restoreNativePromptWidget(controller)' in installer
    assert 'keeping the native ComfyUI prompt widget usable' in installer
    assert 'nativePromptWidget.value = String(value ?? "")' in installer
    layout = editor[editor.index("function installPromptFirstLayout"):editor.index("function injectStyles")]
    assert 'if (widget === controller.nativePromptWidget) continue;' in layout


def test_prompt_backing_widget_avoids_double_dom_fullscreen_regression():
    nodes = NODES.read_text(encoding="utf-8")
    editor = EDITOR.read_text(encoding="utf-8")
    prompt_block = nodes[nodes.index("def _prompt_input"):nodes.index("def _keyframe_inputs")]
    assert 'multiline=False' in prompt_block
    assert 'dynamic_prompts=False' in prompt_block
    assert 'function repairPathologicalNodeSize(node)' in editor
    repair = editor[editor.index("function repairPathologicalNodeSize(node)"):editor.index("function hideNativePromptWidget", editor.index("function repairPathologicalNodeSize(node)"))]
    assert 'currentWidth > 1200' in repair
    assert 'currentHeight > 900' in repair
    assert 'targetWidth = 760' in repair
    assert 'targetHeight = 520' in repair
    installer = editor[editor.index("function installPromptEditorForNode"):editor.index("function refreshControllerFromNode")]
    assert 'getMaxHeight: () => 560' in installer
    assert 'repairPathologicalNodeSize(node);' in installer


def test_editor_imports_every_h3_default_symbol_it_uses():
    editor = EDITOR.read_text(encoding="utf-8")
    first_import = editor.splitlines()[1]
    assert 'H3E_VALUES' in editor
    assert 'H3E_VALUES' in first_import


def test_layout_failure_falls_back_instead_of_leaving_dom_overlay_unmanaged():
    editor = EDITOR.read_text(encoding="utf-8")
    layout = editor[editor.index("function installPromptFirstLayout"):editor.index("function injectStyles")]
    assert 'try {' in layout
    assert 'Widget layout failed; falling back to ComfyUI\'s native widget order.' in layout
    assert 'restoreLayoutWidgetVisibility(this);' in layout
    assert 'return previousGetLayoutWidgets.apply(this, args);' in layout


def test_workflow_load_repairs_only_clearly_pathological_legacy_sizes():
    editor = EDITOR.read_text(encoding="utf-8")
    hook = editor[editor.index('  beforeConfigureGraph(workflow) {'):editor.index('  afterConfigureGraph() {')]
    assert 'width > 1200' in hook and 'item.size[0] = 760' in hook
    assert 'height > 900' in hook and 'item.size[1] = 520' in hook



def test_tab_does_not_accept_untouched_default_custom_placeholder():
    source = EDITOR.read_text(encoding="utf-8")
    assert "menuSelectionExplicit: false" in source
    assert "if (explicit) controller.menuSelectionExplicit = true;" in source
    assert 'row.addEventListener("pointerenter", () => updateMenuSelection(controller, index, false, true));' in source
    keydown = source[source.index('textarea.addEventListener("keydown", (event) => {'):source.index('textarea.addEventListener("keyup", (event) => {', source.index('textarea.addEventListener("keydown", (event) => {'))]
    assert 'tabShouldAdvancePastUntouchedCustom(controller)' in keydown
    helper = source[source.index("function tabShouldAdvancePastUntouchedCustom"):source.index("function renderMenu")]
    assert 'controller?.trigger?.kind === "placeholder"' in helper
    assert 'Boolean(option?.custom)' in helper
    assert '!controller?.menuSelectionExplicit' in helper
    assert 'if (selectAdjacentEditorPlaceholder(textarea, 1))' in keydown
    assert 'controller.choose(controller.menuIndex);' in keydown


def test_fresh_shot_scaffold_uses_grammar_safe_hosts():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function nextShotScaffold"):source.index("function shotFieldOptions")]
    assert 'The shot uses {shot size / framing} framing from {viewpoint}' in block
    assert 'The framed subject is {subject appearance / pose / frame position}.' in block
    assert '${subject} has {subject appearance / pose / frame position}' not in block
    assert 'a {shot size / framing} shot from {viewpoint} frames' not in block


def test_cut_transition_presets_do_not_repeat_shot_to_new_shot():
    source = EDITOR.read_text(encoding="utf-8")
    block = source[source.index("function cutTransitionOptions"):source.index("function timingOptions")]
    assert '"the shot cuts to"' not in block
    assert '"the shot transitions to"' not in block
    assert '"the shot changes to"' not in block
    assert '"the shot switches to"' not in block
    assert '"the image cuts to"' in block
    assert '"the view changes to"' in block


def test_badge_distinguishes_prompt_audio_intent_from_backend_mode():
    source = EDITOR.read_text(encoding="utf-8")
    refresh = source[source.index("refresh() {"):source.index("syncMenu()", source.index("refresh() {"))]
    assert "state.displayAudioMode" in refresh
    assert "state.promptAudioIntent" in refresh
    assert 'state.editorProfile === PROFILE.REF2VA ? "R2A / REF2A" : "T2A"' in refresh



def test_validator_notes_are_clickable_and_navigable_without_becoming_errors():
    source = EDITOR.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function refreshControllerFromNode")]
    assert "notesExpanded: false" in controller
    assert 'diagnosticItems()' in controller
    assert 'return { kind: "note", items: notes };' in controller
    assert 'kind === "note" && !this.notesExpanded' in controller
    assert 'status.classList.toggle("is-actionable", inspectable);' in controller
    assert 'controller.notesExpanded = !controller.notesExpanded;' in controller
    assert 'diagnostic.classList.remove("open", "is-note");' in controller
    assert 'this.notesExpanded = false;' in controller


def test_completion_normalizes_only_boundary_punctuation():
    source = EDITOR.read_text(encoding="utf-8")
    helper = source[source.index("function normalizedReplacementEnd"):source.index("function replaceRange")]
    assert 'if (/[.!?]/.test(last) && /[.!?]/.test(source[safeEnd] || ""))' in helper
    assert 'while (/[.!?]/.test(source[safeEnd] || "")) safeEnd += 1;' in helper
    assert 'else if (/[,;:]/.test(last) && source[safeEnd] === last)' in helper
    replace = source[source.index("function replaceRange"):source.index("function sourceNodeForInput")]
    assert "normalizedReplacementEnd(source, safeStart, end, insertText)" in replace
    assert r"replace(/\.\./" not in replace


def test_duration_row_surfaces_exact_snapped_output_duration_and_frame_count():
    source = EDITOR.read_text(encoding="utf-8")
    helper = source[source.index("function updateDerivedWidgetLabels"):source.index("function makeController")]
    assert 'widgetNameMatches(widget?.name, "seconds")' in helper
    assert 'state?.effectiveSeconds' in helper
    assert 'const frames = Number(state?.frameCount);' in helper
    assert 'f · actual ${actual.toFixed(3)}s' in helper
    refresh = source[source.index("refresh() {"):source.index("syncMenu()", source.index("refresh() {"))]
    assert 'updateDerivedWidgetLabels(node, state);' in refresh


def test_output_resolution_row_surfaces_dimensions_and_megapixels_without_changing_enum_values():
    source = EDITOR.read_text(encoding="utf-8")
    helper = source[source.index("const OUTPUT_ASPECT_RATIOS"):source.index("function makeController")]
    assert 'function outputResolutionGeometry(node, state)' in helper
    assert '"768P (native)": 768' in helper
    assert 'nativeMaxPixels = 768 * 1344' in helper
    assert 'Math.round(nominalW / 32) * 32' in helper
    assert 'Output resolution · ${geometry.width}×${geometry.height} · ${formatted} MP' in helper
    assert 'Output resolution · endpoint-adaptive · ~${formatted} MP class' in helper
    assert 'Do not fabricate dimensions.' in helper
    defaults = (ROOT / "web" / "h3_defaults.js").read_text(encoding="utf-8")
    assert 'canvas: "768P (native)"' in defaults
    assert '"704P (draft)"' in defaults



def test_connected_input_route_controls_visibility_and_resolution_geometry():
    source = EDITOR.read_text(encoding="utf-8")
    layout = source[source.index("function layoutVisibilityState"):source.index("function layoutWidgetVisibility")]
    assert "activeRoute.conditioningProfile !== PROFILE.REF2VA" in layout
    assert "activeRoute.conditioningProfile === PROFILE.REF2VA" in layout
    assert "const keyframeCount = endpointRouteActive ? rawKeyframeCount : 0;" in layout
    assert "const imageCount = referenceRouteActive ? rawImageCount : 0;" in layout
    assert "const videoCount = referenceRouteActive ? rawVideoCount : 0;" in layout
    geometry = source[source.index("function outputResolutionGeometry"):source.index("function formatMegapixels")]
    assert "layoutVisibilityState(node, null, state)" in geometry
    refresh = source[source.index("refresh() {"):source.index("syncMenu()", source.index("refresh() {"))]
    assert "layoutRouteSignature" in refresh
    assert "syncLayoutWidgetVisibility(node, this, state);" in refresh
    assert "node.graph?.setDirtyCanvas?.(true, true);" in refresh


def test_mixed_route_gets_persistent_nonblocking_endpoint_notice():
    source = EDITOR.read_text(encoding="utf-8")
    controller = source[source.index("function makeController"):source.index("function attachNodeObservers")]
    assert 'routeNotice.textContent = "Reference route · endpoint frames connected but not forwarded"' in controller
    assert 'routeNotice.hidden = !state.ignoredKeyframeInputs;' in controller
    assert 'h3e-route-notice' in source


def test_current_schema_describes_connected_input_authoritative_conditioning_route():
    source = NODES.read_text(encoding="utf-8")
    assert "Prompt templates only affect editor assistance; they never enable, disable, or reroute connected media." in source
    assert "Used whenever Reference image/video/audio inputs are connected." in source

if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} UI contract checks passed")
