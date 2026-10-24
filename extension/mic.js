// AI in Chrome: side panels can't show the microphone prompt, so voice input asks once from this tab.
// The permission belongs to the extension, so the side panel can use the microphone afterwards.

const msg = document.getElementById('msg');
const retry = document.getElementById('retry');

async function ask() {
  retry.hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    msg.className = 'ok';
    msg.textContent = 'Microphone allowed. Going back to the side panel…';
    chrome.runtime.sendMessage({ type: 'aichrome-mic-granted' }).catch(() => {});
    setTimeout(async () => {
      const tab = await chrome.tabs.getCurrent();
      if (tab) chrome.tabs.remove(tab.id);
    }, 900);
  } catch (e) {
    msg.className = 'bad';
    msg.textContent = e?.name === 'NotFoundError'
      ? 'No microphone found. Plug one in and try again.'
      : 'The microphone was blocked. Click the icon at the right of the address bar to allow it, then try again.';
    retry.hidden = false;
  }
}

retry.addEventListener('click', ask);
ask();
