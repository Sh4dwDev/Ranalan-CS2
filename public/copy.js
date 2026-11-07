document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copy);
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      // Browsers block the clipboard API on plain http, so fall back to the older way.
      document.execCommand('copy');
    }
    const label = button.textContent;
    button.textContent = 'Kopiert';
    setTimeout(() => { button.textContent = label; }, 1500);
  });
});
