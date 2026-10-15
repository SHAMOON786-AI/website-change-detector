document.addEventListener('DOMContentLoaded', async () => {
  const serverInput = document.getElementById('server-url');
  const nameInput = document.getElementById('site-name');
  const urlInput = document.getElementById('site-url');
  const intervalSelect = document.getElementById('site-interval');
  const keywordsInput = document.getElementById('site-keywords');
  const selectorInput = document.getElementById('site-selector');
  const trackBtn = document.getElementById('track-btn');
  const statusBox = document.getElementById('status-box');
  const dashboardLink = document.getElementById('open-dashboard');

  // Load saved server URL
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['serverUrl'], (res) => {
      if (res.serverUrl) serverInput.value = res.serverUrl;
    });
  }

  // Get current active tab
  if (chrome && chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        const tab = tabs[0];
        urlInput.value = tab.url || '';
        nameInput.value = tab.title || tab.url || '';
      }
    });
  }

  dashboardLink.addEventListener('click', (e) => {
    e.preventDefault();
    const serverUrl = serverInput.value.trim() || 'http://localhost:3000';
    if (chrome && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: serverUrl });
    } else {
      window.open(serverUrl, '_blank');
    }
  });

  trackBtn.addEventListener('click', async () => {
    const serverUrl = serverInput.value.trim().replace(/\/$/, '') || 'http://localhost:3000';
    const url = urlInput.value.trim();
    const name = nameInput.value.trim();
    const intervalMs = Number(intervalSelect.value);
    const keywords = keywordsInput.value.trim();
    const selector = selectorInput.value.trim();

    if (!url) {
      showStatus('No valid target page URL found', 'error');
      return;
    }

    // Save server URL
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ serverUrl });
    }

    trackBtn.disabled = true;
    trackBtn.textContent = 'Registering...';

    try {
      const res = await fetch(`${serverUrl}/api/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          name,
          intervalMs,
          keywords,
          watchSelectors: selector ? [selector] : []
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showStatus('✅ Page added to monitoring queue!', 'success');
      } else {
        showStatus('❌ ' + (data.error || 'Failed to register'), 'error');
      }
    } catch (err) {
      showStatus('❌ Connection failed. Ensure server is running.', 'error');
    } finally {
      trackBtn.disabled = false;
      trackBtn.textContent = '🚀 Monitor This Page';
    }
  });

  function showStatus(msg, type) {
    statusBox.className = `status ${type}`;
    statusBox.textContent = msg;
    statusBox.style.display = 'block';
  }
});
