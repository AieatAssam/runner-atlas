// Theme switch. The head script in index.html applies the saved theme before paint; this only toggles it.
const KEY = 'atlas-theme';

function current(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function initTheme(): void {
  const button = document.getElementById('theme-switch');
  if (!button) return;
  const label = (): void => {
    const target = current() === 'dark' ? 'light' : 'dark';
    button.textContent = target === 'dark' ? 'Dark theme' : 'Light theme';
    button.setAttribute('aria-label', `Switch to ${target} theme`);
  };
  label();
  button.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Storage can be blocked; the theme still applies for this page view.
    }
    label();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', label);
}
