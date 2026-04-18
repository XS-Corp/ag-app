(function() {
  const badge = document.createElement('div');
  badge.id = 'ag-ext-activated';
  badge.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    background: linear-gradient(135deg, #6ea8fe, #a855f7);
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 5px 12px;
    border-radius: 999px;
    z-index: 999999;
    box-shadow: 0 2px 12px rgba(110,168,254,0.4);
    pointer-events: none;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.4s ease, transform 0.4s ease;
  `;
  badge.textContent = '✦ Activated';
  document.body.appendChild(badge);

  requestAnimationFrame(() => {
    badge.style.opacity = '1';
    badge.style.transform = 'translateY(0)';
  });

  setTimeout(() => {
    badge.style.opacity = '0';
    badge.style.transform = 'translateY(8px)';
    setTimeout(() => badge.remove(), 400);
  }, 3000);
})();
