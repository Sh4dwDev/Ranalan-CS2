// The bar under the top menu that tells a player about their own match, on every page.
// It checks every few seconds, and when something new happens (the vote opens, it's your
// turn, the match is ready on the server) it plays a sound and flashes the tab title.

const slot = document.getElementById('notice-slot');
const CHECK_MS = 5000;
const baseTitle = document.title;
let titleTimer = null;

function stored(name) {
  try { return localStorage.getItem(name); } catch { return null; }
}
function store(name, value) {
  try { localStorage.setItem(name, value); } catch { /* private window */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Two short tones. Browsers only allow sound after the player has clicked the page once.
function beep() {
  try {
    const audio = new AudioContext();
    [[660, 0], [880, 0.18]].forEach(([freq, at]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, audio.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + 0.16);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + at);
      osc.stop(audio.currentTime + at + 0.17);
    });
  } catch { /* no sound available */ }
}

function flashTitle(text) {
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? `(!) ${text}` : baseTitle;
  }, 1000);
}
function stopFlash() {
  clearInterval(titleTimer);
  titleTimer = null;
  document.title = baseTitle;
}
window.addEventListener('focus', stopFlash);
document.addEventListener('click', stopFlash);

// Desktop notifications only work on https or localhost, so on the LAN address this usually
// does nothing, and the sound and title do the job.
function desktopNotice(notice) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(notice.title, { body: notice.text, tag: 'ranalan-match' });
    n.onclick = () => { window.focus(); location.href = notice.href; };
  } catch { /* not allowed here */ }
}

function render(notice) {
  slot.replaceChildren();
  if (!notice || stored('notice-dismissed') === notice.key) return;
  // The home page already shows this as its big "Din kamp" card.
  if (document.querySelector(`.my-match[data-key="${CSS.escape(notice.key)}"]`)) return;

  const bar = el('div', `notice notice-${notice.kind}`);
  const textBox = el('div', 'notice-text');
  textBox.append(el('strong', null, notice.title), el('span', null, notice.text));
  bar.append(textBox);

  const actions = el('div', 'notice-actions');
  if (notice.connect) {
    const join = el('a', 'button small', 'Koble til');
    join.href = notice.connect.url;
    const copy = el('button', 'button small secondary', 'Kopier connect');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(notice.connect.command); } catch {
        const box = el('textarea');
        box.value = notice.connect.command;
        document.body.append(box);
        box.select();
        document.execCommand('copy');
        box.remove();
      }
      copy.textContent = 'Kopiert';
      setTimeout(() => { copy.textContent = 'Kopier connect'; }, 1500);
    });
    actions.append(join, copy);
  }
  if (location.pathname !== notice.href) {
    const open = el('a', notice.connect ? 'link' : 'button small', notice.button);
    open.href = notice.href;
    actions.append(open);
  }
  const close = el('button', 'notice-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Skjul');
  close.addEventListener('click', () => { store('notice-dismissed', notice.key); render(null); });
  actions.append(close);
  bar.append(actions);
  slot.append(bar);
}

async function check() {
  let notice = null;
  try {
    const res = await fetch('/api/notice', { cache: 'no-store' });
    if (!res.ok) return;
    ({ notice } = await res.json());
  } catch {
    return; // The site is unreachable for a moment. Keep showing what we had.
  }
  render(notice);
  if (notice?.alert && stored('notice-seen') !== notice.key) {
    store('notice-seen', notice.key);
    beep();
    if (document.hidden || !document.hasFocus()) flashTitle(notice.title);
    desktopNotice(notice);
  }
}

if (slot) {
  check();
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
