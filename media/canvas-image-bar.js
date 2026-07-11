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
    const announceNav = options.announceNav || noop;

    const imgBar = document.createElement('div');
    imgBar.setAttribute('role', 'toolbar');
    imgBar.setAttribute('aria-label', 'Image editing controls');
    imgBar.style.cssText =
      'position:absolute;display:none;align-items:center;gap:3px;z-index:50;font-family:sans-serif;' +
      'background:#fff;border:1px solid #bbb;border-radius:6px;padding:2px 4px;box-shadow:0 1px 4px rgba(0,0,0,0.18);';
    const changeImgBtn = makeBtn('⇄', 'Change image');
    const editAltBtn = makeBtn('Alt', 'Edit image alt text');
    changeImgBtn.tabIndex = -1;
    editAltBtn.tabIndex = -1;
    imgBar.append(changeImgBtn, editAltBtn);
    const buttons = [changeImgBtn, editAltBtn];
    document.body.appendChild(imgBar);
    let imgBarTargetId = null;
    let rovingIdx = 0;

    function setRoving(idx) {
      rovingIdx = Math.max(0, Math.min(idx, buttons.length - 1));
      for (let i = 0; i < buttons.length; i++) buttons[i].tabIndex = i === rovingIdx ? 0 : -1;
      return buttons[rovingIdx];
    }

    function focusRoving(idx) {
      const btn = setRoving(idx);
      btn.focus();
      announceNav(btn.getAttribute('aria-label') || btn.textContent || 'Image control');
    }

    function activateButton(btn) {
      if (btn === changeImgBtn && imgBarTargetId) vscode.postMessage({ type: 'pickImage', id: imgBarTargetId });
      if (btn === editAltBtn && imgBarTargetId) vscode.postMessage({ type: 'editImageAlt', id: imgBarTargetId });
    }

    function hide() {
      imgBar.style.display = 'none';
      for (const btn of buttons) btn.tabIndex = -1;
      imgBarTargetId = null;
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
      imgBar.style.display = 'flex';
      const activeIdx = buttons.indexOf(document.activeElement);
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
    imgBar.addEventListener('keydown', (e) => {
      const currentIdx = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        focusRoving(currentIdx < 0 ? 0 : Math.min(buttons.length - 1, currentIdx + 1));
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
        focusRoving(buttons.length - 1);
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        const btn = currentIdx >= 0 ? buttons[currentIdx] : null;
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
