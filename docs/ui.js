/** Keep the inspector usable even when WebGL or the engine CDN fails. */
const panel = document.getElementById('toolPanel');
const toggle = document.getElementById('togglePanel');

function setPanelOpen(open, moveFocus = false) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.hidden = open;
  if (moveFocus) {
    (open ? document.getElementById('closePanel') : toggle).focus();
  }
}

toggle.onclick = () => setPanelOpen(true, true);
document.getElementById('closePanel').onclick = () => setPanelOpen(false, true);
document.getElementById('help').onclick = () => document.getElementById('guide').showModal();
document.getElementById('closeGuide').onclick = () => document.getElementById('guide').close();

window.addEventListener('viewer-error', () => setPanelOpen(true));
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
  if (document.getElementById('guide').open) return;
  if (event.key.toLowerCase() === 'h') {
    event.preventDefault();
    setPanelOpen(panel.hidden, true);
  } else if (event.key === 'Escape' && !panel.hidden) {
    setPanelOpen(false, true);
  }
});

import('./app.js').catch((error) => {
  document.getElementById('message').textContent = 'Không khởi tạo được renderer: ' + error.message;
  document.getElementById('message').classList.add('error');
  setPanelOpen(true);
});
