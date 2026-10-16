// AI in Chrome: on-page indicator (glowing frame + phantom cursor) while the agent acts on this tab.
(() => {
  if (window.__pilotIndicator) return;
  window.__pilotIndicator = true;

  const COLOR = '124, 92, 255';
  const IDLE_HIDE_MS = 5000;
  let host = null;
  let cursor = null;
  let ripple = null;
  let hideTimer = null;

  function build() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'chrome-pilot-indicator';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;display:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .glow { position: fixed; inset: 0; pointer-events: none;
          box-shadow: inset 0 0 0 2px rgba(${COLOR}, .9), inset 0 0 28px rgba(${COLOR}, .45);
          animation: pulse 2s ease-in-out infinite; }
        @keyframes pulse { 50% { box-shadow: inset 0 0 0 2px rgba(${COLOR}, .6), inset 0 0 14px rgba(${COLOR}, .25); } }
        .badge { position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
          font: 600 12px/1 system-ui, sans-serif; color: #fff; background: rgba(${COLOR}, .92);
          padding: 6px 10px; border-radius: 999px; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
        .cursor { position: fixed; top: 0; left: 0; width: 20px; height: 26px; opacity: 0;
          transition: transform 180ms cubic-bezier(.2,0,0,1), opacity 150ms;
          filter: drop-shadow(0 0 4px rgba(${COLOR}, .9)); }
        .ripple { position: fixed; top: 0; left: 0; width: 28px; height: 28px; margin: -14px 0 0 -14px;
          border-radius: 50%; border: 2px solid rgba(${COLOR}, .9); opacity: 0; }
        .ripple.on { animation: ripple 450ms ease-out; }
        @keyframes ripple { from { opacity: 1; scale: .3; } to { opacity: 0; scale: 1.4; } }
      </style>
      <div class="glow"></div>
      <div class="badge">AI in Chrome is controlling this tab</div>
      <div class="ripple"></div>
      <svg class="cursor" viewBox="0 0 20 26">
        <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z" fill="rgb(${COLOR})" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`;
    cursor = shadow.querySelector('.cursor');
    ripple = shadow.querySelector('.ripple');
    document.documentElement.appendChild(host);
  }

  function show() {
    build();
    host.style.display = '';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, IDLE_HIDE_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    if (host) host.style.display = 'none';
  }

  function move(x, y, click) {
    show();
    cursor.style.opacity = '1';
    cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (click) {
      ripple.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      ripple.classList.remove('on');
      void ripple.offsetWidth;
      ripple.classList.add('on');
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'pilot-indicator') return;
    if (msg.action === 'show') show();
    else if (msg.action === 'hide') hide();
    else if (msg.action === 'move') move(msg.x, msg.y, msg.click);
    // Let the frame repaint before a screenshot is taken.
    requestAnimationFrame(() => sendResponse(true));
    return true;
  });
})();
