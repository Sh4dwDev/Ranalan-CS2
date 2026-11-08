// Admin page: tabs, and search, filters and "show more" for the long lists.
// Without this script every section is shown one after another.

const PAGE_SIZE = 50;
const panels = [...document.querySelectorAll('.admin-panel')];
const tabLinks = [...document.querySelectorAll('[data-tab-link]')];

function readTab() {
  try { return sessionStorage.getItem('admin-tab'); } catch { return null; }
}

function showTab(id, remember = true) {
  if (!panels.some((p) => p.id === id)) id = panels[0]?.id;
  panels.forEach((p) => { p.hidden = p.id !== id; });
  tabLinks.forEach((link) => {
    const active = link.dataset.tabLink === id;
    if (link.closest('.admin-tabs')) link.setAttribute('aria-current', active ? 'page' : 'false');
  });
  if (remember) {
    try { sessionStorage.setItem('admin-tab', id); } catch { /* private window */ }
  }
}

if (panels.length) {
  document.body.classList.add('admin-tabs-on');
  tabLinks.forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    showTab(link.dataset.tabLink);
    history.replaceState(null, '', `#${link.dataset.tabLink}`);
  }));
  // After a form posts back to /admin, the same tab opens again.
  showTab(location.hash.slice(1) || readTab() || 'kamper', false);
}

document.querySelectorAll('[data-list]').forEach((section) => {
  const rows = [...section.querySelectorAll('.admin-row')];
  const search = section.querySelector('[data-search-input]');
  const chips = [...section.querySelectorAll('[data-filter]')];
  const count = section.querySelector('[data-list-count]');
  const noHits = section.querySelector('[data-no-hits]');
  const more = section.querySelector('[data-show-more]');
  if (!rows.length) return;

  let filter = chips[0]?.dataset.filter || 'all';
  let limit = PAGE_SIZE;

  const matches = (row, f) => f === 'all' || row.dataset.groups.split(' ').includes(f);

  // Start on "Alle" if the first filter has nothing in it, like no matches going on.
  if (!rows.some((row) => matches(row, filter))) filter = 'all';

  function render() {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter((row) => matches(row, filter)
      && words.every((w) => row.dataset.search.includes(w)));
    rows.forEach((row) => { row.hidden = true; });
    hits.slice(0, limit).forEach((row) => { row.hidden = false; });
    chips.forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter)));
    count.textContent = hits.length === rows.length
      ? `${rows.length} totalt`
      : `${hits.length} av ${rows.length}`;
    noHits.hidden = hits.length > 0;
    more.hidden = hits.length <= limit;
    more.textContent = `Vis flere (${hits.length - limit} til)`;
  }

  search.addEventListener('input', () => { limit = PAGE_SIZE; render(); });
  chips.forEach((chip) => chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    limit = PAGE_SIZE;
    render();
  }));
  more.addEventListener('click', () => { limit += PAGE_SIZE; render(); });
  render();
});
