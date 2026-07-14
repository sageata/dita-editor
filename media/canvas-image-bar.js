// Selected-image action bar for the DITA Editor canvas.
//
// Loaded before canvas.js. This module owns the DOM for the image toolbar; the
// caller owns selection state and member resolution.
(function () {
  function noop() {}

  function installImageBar(options) {
    const document = options.document;
    const window = options.window;
    const vscode = options.vscode;
    const makeBtn = options.makeBtn;
    const getSelection = options.getSelection;
    const resolveMember = options.resolveMember;
    const getStructVersion = options.getStructVersion || (() => 0);
    const announceNav = options.announceNav || noop;

    const imgBar = document.createElement('div');
    imgBar.setAttribute('role', 'toolbar');
    imgBar.setAttribute('aria-label', 'Image editing controls');
    imgBar.style.cssText =
      'position:absolute;display:none;align-items:center;gap:3px;z-index:50;font-family:sans-serif;' +
      'background:#fff;border:1px solid #bbb;border-radius:6px;padding:2px 4px;box-shadow:0 1px 4px rgba(0,0,0,0.18);';
    const changeImgBtn = makeBtn('⇄', 'Change image');
    const editAltBtn = makeBtn('Alt', 'Edit image alt text');
    const resizeBtn = makeBtn('↔', 'Resize image');
    const alignLeftBtn = makeBtn('L', 'Align image left');
    const alignCenterBtn = makeBtn('C', 'Align image center');
    const alignRightBtn = makeBtn('R', 'Align image right');
    const alignTopBtn = makeBtn('T', 'Align image vertically top');
    const alignMiddleBtn = makeBtn('M', 'Align image vertically middle');
    const alignBottomBtn = makeBtn('B', 'Align image vertically bottom');
    const buttons = [changeImgBtn, editAltBtn, resizeBtn, alignLeftBtn, alignCenterBtn, alignRightBtn, alignTopBtn, alignMiddleBtn, alignBottomBtn];
    const verticalButtons = [alignTopBtn, alignMiddleBtn, alignBottomBtn];
    for (const btn of buttons) btn.tabIndex = -1;
    for (const btn of verticalButtons) btn.style.display = 'none';
    imgBar.append(...buttons);
    document.body.appendChild(imgBar);
    const resizeHandle = document.createElement('div');
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', 'Drag to resize image');
    resizeHandle.setAttribute('aria-orientation', 'horizontal');
    resizeHandle.style.cssText =
      'position:absolute;display:none;width:14px;height:14px;z-index:48;box-sizing:border-box;' +
      'background:#0b6bcb;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px #0b6bcb;' +
      'cursor:nwse-resize;touch-action:none;';
    resizeHandle.style.display = 'none';
    document.body.appendChild(resizeHandle);
    let imgBarTargetId = null;
    let imgBarTarget = null;
    let imgBarCellId = null;
    let rovingIdx = 0;
    let drag = null;

    function navigableButtons() {
      return buttons.filter((btn) => btn.style.display !== 'none');
    }

    function setRoving(idx) {
      const available = navigableButtons();
      rovingIdx = Math.max(0, Math.min(idx, available.length - 1));
      for (const btn of buttons) btn.tabIndex = -1;
      available[rovingIdx].tabIndex = 0;
      return available[rovingIdx];
    }

    function focusRoving(idx) {
      const btn = setRoving(idx);
      btn.focus();
      announceNav(btn.getAttribute('aria-label') || btn.textContent || 'Image control');
    }

    function activateButton(btn) {
      if (btn === changeImgBtn && imgBarTargetId) vscode.postMessage({ type: 'pickImage', id: imgBarTargetId });
      if (btn === editAltBtn && imgBarTargetId) vscode.postMessage({ type: 'editImageAlt', id: imgBarTargetId });
      if (btn === resizeBtn && imgBarTargetId) vscode.postMessage({ type: 'resizeImage', id: imgBarTargetId });
      const horizontal = btn === alignLeftBtn ? 'left' : btn === alignCenterBtn ? 'center' : btn === alignRightBtn ? 'right' : null;
      if (horizontal && imgBarTargetId) {
        vscode.postMessage({ type: 'setImageAlign', id: imgBarTargetId, align: horizontal });
      }
      const vertical = btn === alignTopBtn ? 'top' : btn === alignMiddleBtn ? 'middle' : btn === alignBottomBtn ? 'bottom' : null;
      if (vertical && imgBarCellId) vscode.postMessage({ type: 'setCalsAttr', id: imgBarCellId, attrName: 'valign', attrValue: vertical, baseStructVersion: getStructVersion() });
    }

    function hide() {
      imgBar.style.display = 'none';
      resizeHandle.style.display = 'none';
      for (const btn of buttons) btn.tabIndex = -1;
      imgBarTargetId = null;
      imgBarTarget = null;
      imgBarCellId = null;
      drag = null;
    }

    function positionResizeHandle(rect) {
      const sx = window.scrollX;
      const sy = window.scrollY;
      resizeHandle.style.left = rect.right + sx - 7 + 'px';
      resizeHandle.style.top = rect.bottom + sy - 7 + 'px';
    }

    function canvasZoom() {
      const main = document.querySelector('main');
      const zoom = main ? Number.parseFloat(main.style.zoom || '1') : 1;
      return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    }

    function update() {
      const main = document.querySelector('main');
      const selection = getSelection();
      const isImg = !!selection && selection.mode === 'single' && selection.unit === 'image';
      if (!isImg || !main) {
        hide();
        return;
      }
      const img = resolveMember(main, 'image', selection.id);
      if (!img) {
        hide();
        return;
      }
      imgBarTargetId = selection.id;
      imgBarTarget = img;
      const cell = img.closest('td[data-cell-id], th[data-cell-id]');
      imgBarCellId = cell ? cell.getAttribute('data-cell-id') : null;
      for (const btn of verticalButtons) btn.style.display = imgBarCellId ? '' : 'none';
      imgBar.style.display = 'flex';
      resizeHandle.style.display = 'block';
      const activeIdx = navigableButtons().indexOf(document.activeElement);
      setRoving(activeIdx >= 0 ? activeIdx : 0);
      const geom = window.DitaEditorCanvasGeom;
      const rect = geom ? geom.visualRect(img) : img.getBoundingClientRect();
      const MIN_GAP = 6;
      const sx = window.scrollX;
      const sy = window.scrollY;
      let top = rect.top + sy - imgBar.offsetHeight - MIN_GAP;
      if (top < sy + MIN_GAP) top = rect.top + sy + MIN_GAP;
      const left = Math.max(sx + MIN_GAP, rect.left + sx);
      imgBar.style.left = left + 'px';
      imgBar.style.top = top + 'px';
      positionResizeHandle(rect);
    }

    function isShown() {
      return imgBar.style.display !== 'none';
    }

    function focusChangeButton() {
      focusRoving(0);
    }

    changeImgBtn.addEventListener('click', () => {
      activateButton(changeImgBtn);
    });
    editAltBtn.addEventListener('click', () => {
      activateButton(editAltBtn);
    });
    resizeBtn.addEventListener('click', () => {
      activateButton(resizeBtn);
    });
    for (const btn of [alignLeftBtn, alignCenterBtn, alignRightBtn, alignTopBtn, alignMiddleBtn, alignBottomBtn]) {
      btn.addEventListener('click', () => activateButton(btn));
    }
    resizeHandle.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || !imgBarTarget || !imgBarTargetId) return;
      event.preventDefault();
      event.stopPropagation();
      const geom = window.DitaEditorCanvasGeom;
      const rect = geom ? geom.visualRect(imgBarTarget) : imgBarTarget.getBoundingClientRect();
      const zoom = canvasZoom();
      drag = {
        id: imgBarTargetId,
        image: imgBarTarget,
        startX: event.clientX,
        zoom: zoom,
        startWidth: rect.width / zoom,
        width: Math.round(rect.width / zoom),
      };
    });
    window.addEventListener('mousemove', (event) => {
      if (!drag || typeof event.clientX !== 'number') return;
      event.preventDefault();
      const maxWidth = Math.max(28, ((window.innerWidth || 1200) - 24) / drag.zoom);
      drag.width = Math.max(28, Math.min(maxWidth, Math.round(drag.startWidth + (event.clientX - drag.startX) / drag.zoom)));
      drag.image.style.width = drag.width + 'px';
      drag.image.style.height = 'auto';
      const geom = window.DitaEditorCanvasGeom;
      const rect = geom ? geom.visualRect(drag.image) : drag.image.getBoundingClientRect();
      positionResizeHandle(rect);
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const completed = drag;
      drag = null;
      vscode.postMessage({ type: 'setImageWidth', id: completed.id, width: completed.width + 'px' });
      announceNav('Image width ' + completed.width + ' pixels.');
    });
    imgBar.addEventListener('keydown', (e) => {
      const available = navigableButtons();
      const currentIdx = available.indexOf(document.activeElement);
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        focusRoving(currentIdx < 0 ? 0 : Math.min(available.length - 1, currentIdx + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        focusRoving(currentIdx < 0 ? 0 : Math.max(0, currentIdx - 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        focusRoving(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        focusRoving(available.length - 1);
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        const btn = currentIdx >= 0 ? available[currentIdx] : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        activateButton(btn);
      }
    });

    return {
      hide: hide,
      update: update,
      isShown: isShown,
      focusChangeButton: focusChangeButton,
    };
  }

  window.DitaEditorCanvasImageBar = { installImageBar: installImageBar };
})();
