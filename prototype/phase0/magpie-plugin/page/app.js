(async () => {
  const status = document.getElementById('status');
  try {
    await magpie.ready;
    const response = await magpie.read('providers:list');
    const entries = Array.isArray(response) ? response : (response?.providers || response?.data || []);
    status.textContent = 'Native Magpie provider list (read-only)';
    for (const p of entries) {
      const li = document.createElement('li');
      li.textContent = `${p.name || p.id} (${p.id})`;
      document.getElementById('providers').appendChild(li);
    }
  } catch (err) { status.textContent = 'Bridge read unavailable: ' + String(err); }
})();
