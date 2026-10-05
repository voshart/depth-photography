/* Presentation-only compact workbench. Reuse the editor's existing actions;
 * do not duplicate depth state, image buffers, processing or export code.
 * This import also ensures the editor has installed its event handlers first.
 */
import './app.js?v=20261005-wasm3';

const $ = id => document.getElementById(id);
const toolbar = document.querySelector('.preview-toolbar');
const modeButtons = [...toolbar.querySelectorAll('[data-view]')];
const originalModes = toolbar.querySelector('.segmented');
const focusCards = document.querySelector('.focus-cards');
const detailCards = document.querySelector('.detail-cards');
const setAttr = (node, name, value) => {
  value = String(value);
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
};

// The hidden action buttons remain the canonical view actions for the editor.
// The visible select mirrors their selection/availability, including keyboard
// shortcuts, temporary picks, map-preview changes, imports and look restores.
const viewLabel = document.createElement('label');
viewLabel.className = 'view-control';
viewLabel.innerHTML = '<span class="visually-hidden">Preview mode</span>';
const viewSelect = document.createElement('select');
viewSelect.id = 'viewSelect';
viewSelect.setAttribute('aria-label', 'Preview mode');
viewSelect.title = 'Choose Focus, Compare, Depth, Detail 1 or Detail 2';
const names = { focus: 'Focus', compare: 'Compare', source: 'Depth', detail: 'Detail 1', detail2: 'Detail 2' };
for (const button of modeButtons) {
  const option = document.createElement('option');
  option.value = button.dataset.view;
  option.textContent = names[option.value];
  viewSelect.append(option);
}
viewLabel.append(viewSelect);
originalModes.hidden = true;
originalModes.setAttribute('aria-hidden', 'true');
toolbar.prepend(viewLabel);
viewSelect.addEventListener('change', () => {
  const button = modeButtons.find(b => b.dataset.view === viewSelect.value);
  if (!viewSelect.disabled && button && !button.disabled) button.click();
  syncWorkspace();
});
const navigationRow = document.createElement('div');
navigationRow.className = 'navigation-row';
toolbar.before(navigationRow);
navigationRow.append(toolbar, document.querySelector('.zoom-toolbar'));

function rail(id, label, target, parent) {
  const button = document.createElement('button');
  button.type = 'button'; button.id = id; button.className = 'secondary-rail';
  button.setAttribute('aria-controls', target);
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<span aria-hidden="true" class="rail-plus">+</span><span class="rail-label"></span>';
  button.querySelector('.rail-label').textContent = label;
  parent.append(button);
  return button;
}
const focusRail = rail('expandFocusB', 'Focus B', 'focusCardB', focusCards);
focusRail.title = 'Enable and expand Focus B';
focusRail.setAttribute('aria-label', 'Enable and expand Focus B');
focusRail.addEventListener('click', () => { $('focusSelectB').click(); syncWorkspace(); });
const detailRail = rail('expandDetail2', 'Detail 2', 'detailCard2', detailCards);
detailRail.dataset.layer = '1'; // Drop directly on the rail to load this slot.
detailRail.title = 'Add or edit Detail 2';
detailRail.setAttribute('aria-label', 'Expand Detail 2 controls');
detailRail.addEventListener('click', () => { $('detailSelect2').click(); syncWorkspace(); });

// An empty/bypassed Detail 2 can be opened without enabling a nonexistent image.
// Its close action only folds controls; the checkbox is still the bypass action.
const closeDetail = document.createElement('button');
closeDetail.type = 'button'; closeDetail.id = 'collapseDetail2';
closeDetail.className = 'quiet collapse-detail'; closeDetail.textContent = '×';
closeDetail.title = 'Collapse unused Detail 2 controls';
closeDetail.setAttribute('aria-label', 'Collapse unused Detail 2 controls');
$('detailSelect2').after(closeDetail);
closeDetail.addEventListener('click', () => { $('detailSelect1').click(); syncWorkspace(); });
$('detailEnabled2').addEventListener('change', () => {
  if (!$('detailEnabled2').checked) $('detailSelect1').click();
  syncWorkspace();
});

// Keep the live metadata nodes so the editor continues updating them. Move
// their footprint out of the canvas, not out of the application entirely.
const info = document.createElement('details');
info.className = 'workspace-information'; info.id = 'workspaceInformation';
info.innerHTML = '<summary>Image information &amp; navigation help</summary>';
info.append(document.querySelector('.preview-bottom'), document.querySelector('.app-footer'));
const navigationHelp = document.createElement('p');
navigationHelp.className = 'mini-note';
navigationHelp.textContent = 'Scroll or pinch to zoom. Pan with the hand tool, two fingers, or Space + drag. Fit shows the whole image; 100% uses source-pixel size. The preview is reduced for speed; PNG and native MP4 exports use the original inputs.';
info.append(navigationHelp);
$('settingsDialog').querySelector('.dialog-head').after(info);
$('imageFrame').setAttribute('aria-describedby', 'canvasHint');
$('exportBtn').setAttribute('aria-label', 'Export full-resolution PNG');
$('panBtn').setAttribute('aria-label', 'Pan image without changing focus');

// Guidance is contextual, rather than a permanent row under the image.
const empty = document.createElement('div');
empty.className = 'workspace-empty'; empty.id = 'workspaceEmpty';
empty.innerHTML = '<p>Open a depth map</p><div><button type="button" id="emptyOpen">Open image</button><button type="button" id="emptyExample">Try example</button></div><p class="mini-note">Images are processed on your device.</p>';
$('viewport').append(empty);
$('emptyOpen').addEventListener('click', () => $('openBtn').click());
$('emptyExample').addEventListener('click', () => $('exampleBtn').click());
const pickNotice = document.createElement('div');
pickNotice.className = 'workspace-pick-notice'; pickNotice.hidden = true;
pickNotice.setAttribute('role', 'status');
$('viewport').append(pickNotice);
const workspaceHelp = document.createElement('section');
workspaceHelp.className = 'compact-workspace-help';
workspaceHelp.innerHTML = '<h3>Compact workspace</h3><p>The preview dropdown replaces the Focus / Compare / Depth / Detail tabs. With Focus B off, A uses the available width; tap the + Focus B rail to enable and expand B. Turn B off to fold it again. Detail 2 stays folded until you select or load it. Turning it off folds its controls without discarding its image or settings. A loaded, enabled second layer stays visible even at 0% opacity.</p><p>Filename, pixel dimensions and navigation help are under Settings → Image information &amp; navigation help. The preview no longer reserves space for these notes. Advanced controls remain hidden until enabled.</p>';
$('helpDialog').querySelector('.help-steps').after(workspaceHelp);

function fold(card, button, group, folded, activeTarget) {
  const active = document.activeElement;
  const hidingFocus = folded ? card.contains(active) : button === active;
  card.hidden = folded; button.hidden = !folded;
  setAttr(group, 'data-single', folded);
  setAttr(button, 'aria-expanded', !folded);
  if (hidingFocus) (folded ? button : activeTarget).focus({ preventScroll: true });
}
let previousDetailEnabled = $('detailEnabled2').checked;
let pendingDetailCollapse = false;
function syncWorkspace() {
  const locked = $('openBtn').disabled;
  for (const button of modeButtons) {
    const option = [...viewSelect.options].find(o => o.value === button.dataset.view);
    option.disabled = button.disabled;
    if (button.getAttribute('aria-pressed') === 'true') viewSelect.value = option.value;
  }
  viewSelect.disabled = locked;
  if ($('videoBtn')) $('videoBtn').disabled = $('exportBtn').disabled;
  setAttr(document.body, 'data-compare', viewSelect.value === 'compare');
  focusRail.disabled = locked;
  detailRail.disabled = $('loadDetailBtn2').disabled;
  closeDetail.disabled = locked;
  fold($('focusCardB'), focusRail, focusCards, !$('secondEnabled').checked, $('focusSelectB'));

  const detailEnabled = $('detailEnabled2').checked;
  const selected = $('detailSelect2').getAttribute('aria-pressed') === 'true';
  // This also catches keyboard bypass and replacement of the source image.
  // No processing settings are changed; selecting slot 1 only changes the UI.
  if (previousDetailEnabled && !detailEnabled && selected) pendingDetailCollapse = true;
  if (!locked && pendingDetailCollapse) {
    pendingDetailCollapse = false;
    if (!detailEnabled && selected) $('detailSelect1').click();
  }
  previousDetailEnabled = detailEnabled;
  const detailOpen = detailEnabled || $('detailSelect2').getAttribute('aria-pressed') === 'true';
  closeDetail.hidden = detailEnabled;
  fold($('detailCard2'), detailRail, detailCards, !detailOpen, $('detailSelect2'));

  const hasImage = $('imageDimensions').textContent.trim() !== '—';
  empty.hidden = hasImage || locked;
  const picking = [$('pickBtn'), $('pickBtnB')].find(b => b.getAttribute('aria-pressed') === 'true');
  pickNotice.hidden = !hasImage || !picking || locked;
  const message = picking?.id === 'pickBtnB' ? 'Pick B · tap the image' : 'Pick A · tap the image';
  if (pickNotice.textContent !== message) pickNotice.textContent = message;
}

// Observe only editor-owned state signals. Our own attributes are deliberately
// outside these filters, preventing observer feedback/render loops.
const observer = new MutationObserver(syncWorkspace);
for (const node of modeButtons) observer.observe(node, { attributes: true, attributeFilter: ['aria-pressed', 'disabled'] });
observer.observe($('focusCardB'), { attributes: true, attributeFilter: ['data-enabled'] });
observer.observe($('detailCard2'), { attributes: true, attributeFilter: ['data-active'] });
observer.observe($('detailSelect2'), { attributes: true, attributeFilter: ['aria-pressed'] });
observer.observe($('openBtn'), { attributes: true, attributeFilter: ['disabled'] });
observer.observe($('imageDimensions'), { childList: true, characterData: true, subtree: true });
for (const node of [$('pickBtn'), $('pickBtnB')]) observer.observe(node, { attributes: true, attributeFilter: ['aria-pressed'] });
document.body.classList.add('compact-workspace');
syncWorkspace();
