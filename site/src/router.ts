// Hash routing: "#methods" and every other fragment scroll to a static section. Both sections exist in the HTML.
export function initRouter(): void {
  const apply = (): void => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    target.scrollIntoView({ block: 'start', behavior });
    document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((a) => {
      if (a.hash === `#${id}`) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  };
  window.addEventListener('hashchange', apply);
  apply();
}
