// EBO docs pages: Pagefind search (the index exists only in built sites) and a collapsed contents menu on narrow screens.
(() => {
  const menu = document.querySelector(".docs-menu");
  const narrow = matchMedia("(max-width: 860px)");
  const fit = () => { if (menu) menu.open = !narrow.matches; };
  fit(); narrow.addEventListener("change", fit);
  const host = document.getElementById("search");
  if (host && window.PagefindUI) {
    new PagefindUI({ element: host, bundlePath: host.dataset.bundle, showImages: false, showSubResults: true, resetStyles: false });
  } else host?.remove();
})();
