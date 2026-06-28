/**
 * Top-level tab switching (Test Cases / Try It). The response sub-tabs inside
 * Try It are handled by request-builder.js's own module-level listener.
 */

/** Activates a tab + its panel by name, deactivating the others. */
export function activateTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(`tab-${tab}`)?.classList.add('active');
}

/** Wires each tab button to activate its tab on click. */
export function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}
