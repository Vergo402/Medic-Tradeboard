// Defaults for the options page. `ruleInclude` MUST stay a real, non-empty,
// anchored pattern and must match sw.js's DEFAULTS.ruleInclude: new RegExp("")
// matches EVERY string, so an empty include pattern would make a RULE calendar
// hard-reject all of its events and silently hide every shift the user could
// have taken. `commitmentLabel` must match core/rowshape.js's
// DEFAULT_COMMITMENT_LABEL, which is what content/boot.js falls back to.
const DEFAULTS = {
  ruleInclude: '^Work\\b',
  ruleExclude: 'meeting',
  commitmentLabel: 'Commitment'
};

function setStatus(text, isError) {
  const status = document.getElementById('status');
  status.textContent = text;
  status.classList.toggle('error', Boolean(isError));
  if (!isError) {
    setTimeout(() => {
      status.textContent = '';
      status.classList.remove('error');
    }, 2000);
  }
}

function loadOptions() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    // A stored-but-empty include is repainted as the default, so the field the
    // user sees is always the pattern that will actually be applied.
    const include = (typeof items.ruleInclude === 'string' && items.ruleInclude.trim())
      ? items.ruleInclude
      : DEFAULTS.ruleInclude;
    const label = (typeof items.commitmentLabel === 'string' && items.commitmentLabel.trim())
      ? items.commitmentLabel
      : DEFAULTS.commitmentLabel;
    document.getElementById('ruleInclude').value = include;
    document.getElementById('ruleExclude').value = items.ruleExclude;
    document.getElementById('commitmentLabel').value = label;
  });
}

function saveOptions() {
  const includeField = document.getElementById('ruleInclude');
  const labelField = document.getElementById('commitmentLabel');

  // Never persist an empty include: it would compile to a match-everything
  // regex. Fall back to the default and show the user what was actually saved.
  const rawInclude = includeField.value;
  const blankInclude = rawInclude.trim() === '';
  const include = blankInclude ? DEFAULTS.ruleInclude : rawInclude;

  try {
    new RegExp(include, 'i');
  } catch (_err) {
    setStatus('Not saved — the include pattern is not a valid regex.', true);
    return;
  }

  const rawLabel = labelField.value;
  const commitmentLabel = rawLabel.trim() === '' ? DEFAULTS.commitmentLabel : rawLabel.trim();

  const options = {
    ruleInclude: include,
    ruleExclude: document.getElementById('ruleExclude').value,
    commitmentLabel
  };

  chrome.storage.local.set(options, () => {
    includeField.value = include;
    labelField.value = commitmentLabel;
    setStatus(blankInclude ? 'Saved — empty include pattern reset to the default.' : 'Saved');
  });
}

document.getElementById('save').addEventListener('click', saveOptions);
document.addEventListener('DOMContentLoaded', loadOptions);
