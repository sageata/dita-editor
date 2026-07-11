// Image fallback behavior for the DITA Editor canvas.
//
// Loaded before canvas.js. This is display-only DOM behavior: it marks broken
// rendered images with a readable pill and never posts host messages.
(function () {
  function installBrokenImageFallback(doc, ImageCtor) {
    function markBrokenImage(img) {
      if (img.dataset.brokenHandled === '1') return; // once per element per render
      img.dataset.brokenHandled = '1';
      // Neutralise the broken <img> box so its native broken-image chrome cannot
      // paint over/under the pill. opacity:0 keeps the alt text in the AX tree.
      img.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      const pill = doc.createElement('span');
      pill.className = 'broken-image-label';
      pill.textContent = '\u26a0 ' + (img.getAttribute('alt') || 'missing image');
      pill.style.cssText =
        'display:inline-block;box-sizing:border-box;max-width:240px;padding:6px 10px;margin:2px 0;' +
        'background:#fff3f3;color:#8a1f1f;border:2px solid #cc5555;border-radius:6px;' +
        'font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'white-space:normal;word-break:break-all;vertical-align:middle;';
      img.insertAdjacentElement('afterend', pill);
    }

    // error events do not bubble; capture them so freshly-rendered broken
    // images are marked after every <main> swap too.
    doc.addEventListener(
      'error',
      (e) => {
        const img = e.target;
        if (img instanceof ImageCtor && img.classList.contains('image')) markBrokenImage(img);
      },
      true,
    );

    function scanBrokenImages(root) {
      const imgs = (root || doc).querySelectorAll('img.image');
      for (const img of imgs) {
        if (img.getAttribute('src') && img.complete && img.naturalWidth === 0) markBrokenImage(img);
      }
    }

    return scanBrokenImages;
  }

  window.DitaEditorCanvasImages = { installBrokenImageFallback: installBrokenImageFallback };
})();
