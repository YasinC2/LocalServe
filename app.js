// ============================================================
// app.js — LocalServe PWA Core Logic
// Manages tabs, IndexedDB, directory handles, file serving,
// and Service Worker communication
// ============================================================

(() => {
  'use strict';

  // ---- Constants ----
  const DB_NAME = 'LocalServeDB';
  const DB_VERSION = 1;
  const LOCAL_PREFIX = '/__local__/';
  const MAX_HISTORY = 50;
  const APP_VERSION = '1.0.0';

  // ---- State ----
  let db = null;
  let currentDirHandle = null;
  let currentFilePath = '';
  let currentSubDir = ''; // for file explorer navigation
  let explorerPath = []; // breadcrumb path segments
  let settings = {
    theme: 'dark',
    jsEnabled: true,
    autoHideMode: 'disabled', // 'disabled', 'single', 'double', 'triple'
  };
  let barsHidden = false;
  let clickCount = 0;
  let clickTimer = null;

  // ---- DOM References ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- Initialize ----
  async function init() {
    try {
      db = await openDB();
      await loadSettings();
      applyTheme();
      setupTabs();
      setupEventListeners();
      registerServiceWorker();
      await restoreLastSession();
      await renderFavorites();
    } catch (err) {
      console.error('Init error:', err);
    }
  }

  // ============================================================
  // IndexedDB
  // ============================================================
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains('lastState')) {
          database.createObjectStore('lastState');
        }
        if (!database.objectStoreNames.contains('favorites')) {
          database.createObjectStore('favorites', { keyPath: 'id', autoIncrement: true });
        }
        if (!database.objectStoreNames.contains('history')) {
          database.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        }
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbPut(store, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      const req = key !== null ? s.put(value, key) : s.put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const req = s.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGetAll(store) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const req = s.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      const req = s.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function dbClear(store) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      const req = s.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ============================================================
  // Settings Persistence
  // ============================================================
  async function loadSettings() {
    try {
      const saved = await dbGet('settings', 'userSettings');
      if (saved) {
        settings = { ...settings, ...saved };
      }
    } catch (e) {
      console.warn('Could not load settings:', e);
    }
  }

  async function saveSettings() {
    try {
      await dbPut('settings', 'userSettings', settings);
    } catch (e) {
      console.warn('Could not save settings:', e);
    }
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    const toggle = $('#themeToggle');
    if (toggle) toggle.checked = settings.theme === 'dark';
  }

  // ============================================================
  // Service Worker Registration
  // ============================================================
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => {
          console.log('[App] SW registered', reg);
          // Listen for updates
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                showUpdateBanner();
              }
            });
          });
        })
        .catch(err => console.error('[App] SW registration failed:', err));

      // Listen for messages from SW (file requests)
      navigator.serviceWorker.addEventListener('message', handleSWMessage);
    }
  }

  // ============================================================
  // SW Message Handling — Serve files from directory handle
  // ============================================================
  async function handleSWMessage(event) {
    if (!event.data || event.data.type !== 'GET_FILE') return;

    const filePath = event.data.path;
    const port = event.ports[0];

    if (!currentDirHandle) {
      port.postMessage({ error: 'No directory selected' });
      return;
    }

    try {
      const file = await getFileFromPath(currentDirHandle, filePath);
      if (!file) {
        port.postMessage({ error: 'File not found: ' + filePath });
        return;
      }

      // Determine if it's a text file or binary
      const textTypes = ['text/', 'application/javascript', 'application/json', 'application/xml', 'image/svg+xml', 'application/xhtml'];
      const isText = textTypes.some(t => file.type.startsWith(t)) || file.type === '';

      if (isText) {
        const text = await file.text();
        port.postMessage({ content: text, mimeType: file.type });
        // console.log('loaded as text!', file.name, file.type);
      } else {
        const buffer = await file.arrayBuffer();
        port.postMessage({ content: buffer, mimeType: file.type }, [buffer]);
        // console.log('loaded as buffer!', file.name, file.type);
      }
    } catch (err) {
      console.error('[App] Error reading file:', filePath, err);
      port.postMessage({ error: err.message });
    }
  }

  // ---- Navigate directory tree to find a file by path ----
  async function getFileFromPath(rootHandle, filePath) {
    // Normalize path
    let normalized = filePath.replace(/\\/g, '/');
    if (normalized.startsWith('/')) normalized = normalized.substring(1);
    if (normalized === '') normalized = 'index.html';

    const parts = normalized.split('/').filter(p => p && p !== '.');

    let current = rootHandle;

    // Traverse directories
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        current = await current.getDirectoryHandle(parts[i]);
      } catch {
        return null;
      }
    }

    // Get the file
    const fileName = parts[parts.length - 1];
    try {
      const fileHandle = await current.getFileHandle(fileName);
      return await fileHandle.getFile();
    } catch {
      // Maybe it's a directory with an index.html
      try {
        const dirHandle = await current.getDirectoryHandle(fileName);
        const indexHandle = await dirHandle.getFileHandle('index.html');
        return await indexHandle.getFile();
      } catch {
        return null;
      }
    }
  }

  // ============================================================
  // Tab Management
  // ============================================================
  function setupTabs() {
    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        switchTab(tabId);
      });
    });
  }

  function switchTab(tabId) {
    // Update buttons
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $(`.tab-btn[data-tab="${tabId}"]`).classList.add('active');

    // Update panes
    $$('.tab-pane').forEach(p => p.classList.remove('active'));
    $(`#${tabId}Tab`).classList.add('active');

    // Update top bar content
    updateTopBar(tabId);

    // Show/hide bars based on tab and settings
    if (tabId === 'player' && settings.autoHideMode !== 'disabled' && barsHidden) {
      hideBars();
    } else {
      showBars();
    }

    // Refresh tab content
    if (tabId === 'explorer') renderExplorer();
    if (tabId === 'history') renderHistory();
  }

  function updateTopBar(tabId) {
    const barTitle = $('#barTitle');
    const btnOpen = $('#btnOpenFolder');
    const btnFav = $('#btnAddFavorite');

    switch (tabId) {
      case 'player':
        btnOpen.style.display = '';
        btnFav.style.display = '';
        barTitle.textContent = currentFilePath || 'No file loaded';
        break;
      case 'explorer':
        btnOpen.style.display = '';
        btnFav.style.display = 'none';
        barTitle.textContent = 'File Explorer';
        break;
      case 'history':
        btnOpen.style.display = 'none';
        btnFav.style.display = 'none';
        barTitle.textContent = 'History';
        break;
      case 'settings':
        btnOpen.style.display = 'none';
        btnFav.style.display = 'none';
        barTitle.textContent = 'Settings';
        break;
    }
  }

  // ============================================================
  // Auto-hide Bars Logic
  // ============================================================
  function hideBars() {
    barsHidden = true;
    $('#topBar').classList.add('hidden');
    $('#bottomBar').classList.add('hidden');
    // Adjust tab content to fill
    $('#tabContent').style.marginTop = '0';
  }

  function showBars() {
    barsHidden = false;
    $('#topBar').classList.remove('hidden');
    $('#bottomBar').classList.remove('hidden');
  }

  function handleIframeClick() {
    if (settings.autoHideMode === 'disabled') return;
    const activeTab = $('.tab-btn.active')?.dataset.tab;
    if (activeTab !== 'player') return;

    clickCount++;
    clearTimeout(clickTimer);

    const requiredClicks = { single: 1, double: 2, triple: 3 }[settings.autoHideMode] || 1;

    clickTimer = setTimeout(() => {
      if (clickCount >= requiredClicks) {
        if (barsHidden) {
          showBars();
        } else {
          hideBars();
        }
      }
      clickCount = 0;
    }, 400);
  }

  // Detect edge hover/touch to show bars
  function setupEdgeDetection() {
    document.addEventListener('mousemove', (e) => {
      const activeTab = $('.tab-btn.active')?.dataset.tab;
      if (activeTab !== 'player' || !barsHidden) return;
      if (e.clientY < 20 || e.clientY > window.innerHeight - 20) {
        showBars();
      }
    });

    document.addEventListener('touchstart', (e) => {
      const activeTab = $('.tab-btn.active')?.dataset.tab;
      if (activeTab !== 'player' || !barsHidden) return;
      const touch = e.touches[0];
      if (touch.clientY < 30 || touch.clientY > window.innerHeight - 30) {
        showBars();
      }
    }, { passive: true });
  }

  // ============================================================
  // Directory Selection
  // ============================================================
  async function openFolder() {
    try {
      if (!window.showDirectoryPicker) {
        showToast('File System Access API not supported in this browser');
        return;
      }

      const handle = await window.showDirectoryPicker({ mode: 'read' });
      currentDirHandle = handle;
      explorerPath = [];
      currentSubDir = '';

      // Persist handle
      await dbPut('lastState', 'directoryHandle', handle);

      // Try to find and load index.html or default.html
      await autoLoadIndex(handle);

      // Refresh explorer
      const activeTab = $('.tab-btn.active')?.dataset.tab;
      if (activeTab === 'explorer') renderExplorer();

      showToast('Folder opened: ' + handle.name);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Error opening folder:', err);
        showToast('Error: ' + err.message);
      }
    }
  }

  async function autoLoadIndex(dirHandle) {
    const candidates = ['index.html', 'index.htm', 'default.html', 'default.htm'];
    for (const name of candidates) {
      try {
        await dirHandle.getFileHandle(name);
        await loadFileInPlayer(name);
        return;
      } catch {
        // File not found, try next
      }
    }
    // No index file found, show explorer
    showToast('No index.html found — browse files manually');
    switchTab('explorer');
  }

  // ============================================================
  // Session Restoration
  // ============================================================
  async function restoreLastSession() {
    try {
      const handle = await dbGet('lastState', 'directoryHandle');
      const lastPath = await dbGet('lastState', 'lastFilePath');

      if (handle) {
        // Request permission
        const permission = await handle.requestPermission({ mode: 'read' });
        if (permission === 'granted') {
          currentDirHandle = handle;
          if (lastPath) {
            await loadFileInPlayer(lastPath);
          } else {
            await autoLoadIndex(handle);
          }
        } else {
          showPlayerEmpty();
        }
      } else {
        showPlayerEmpty();
      }
    } catch (err) {
      console.log('No previous session to restore:', err.message);
      showPlayerEmpty();
    }
  }

  function showPlayerEmpty() {
    $('#contentFrame').style.display = 'none';
    $('#playerEmpty').style.display = 'flex';
  }

  function hidePlayerEmpty() {
    $('#contentFrame').style.display = '';
    $('#playerEmpty').style.display = 'none';
  }

  // ============================================================
  // File Loading in Player
  // ============================================================
  async function loadFileInPlayer(filePath) {
    if (!currentDirHandle) {
      showToast('No folder selected');
      return;
    }

    // Ensure SW is ready
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) {
      showToast('Service Worker not ready');
      return;
    }

    currentFilePath = filePath;
    hidePlayerEmpty();

    // Build the URL for the iframe
    const url = `${LOCAL_PREFIX}${filePath}`;
    const frame = $('#contentFrame');

    // Apply sandbox based on JS setting
    if (settings.jsEnabled) {
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
    } else {
      frame.setAttribute('sandbox', 'allow-same-origin allow-forms');
    }

    frame.src = url;

    // Update top bar title
    const barTitle = $('#barTitle');
    if (barTitle) barTitle.textContent = filePath;

    // Switch to player tab
    switchTab('player');

    // Persist last file path
    await dbPut('lastState', 'lastFilePath', filePath);

    // Add to history
    await addToHistory(filePath);

    // Setup iframe click detection for auto-hide
    frame.onload = () => {
      try {
        // Try to listen for clicks inside iframe (same-origin only)
        frame.contentWindow.addEventListener('click', handleIframeClick);
        frame.contentWindow.addEventListener('touchstart', handleIframeClick, { passive: true });
      } catch (e) {
        // Cross-origin, use overlay method
      }
    };
  }

  // ============================================================
  // History Management
  // ============================================================
  async function addToHistory(filePath) {
    try {
      const entry = {
        title: filePath.split('/').pop(),
        path: filePath,
        folderName: currentDirHandle?.name || 'Unknown',
        timestamp: Date.now()
      };

      await dbPut('history', null, entry);

      // Trim to max 50
      const all = await dbGetAll('history');
      if (all.length > MAX_HISTORY) {
        const excess = all.slice(0, all.length - MAX_HISTORY);
        for (const item of excess) {
          await dbDelete('history', item.id);
        }
      }
    } catch (e) {
      console.warn('Could not save history:', e);
    }
  }

  async function renderHistory() {
    const list = $('#historyList');
    const empty = $('#historyEmpty');
    const items = await dbGetAll('history');

    if (!items || items.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';

    // Sort by timestamp descending
    items.sort((a, b) => b.timestamp - a.timestamp);

    list.innerHTML = items.map(item => `
      <div class="history-item" data-path="${escapeAttr(item.path)}">
        <span class="h-title">📄 ${escapeHtml(item.title)}</span>
        <span class="h-path">${escapeHtml(item.path)}</span>
        <span class="h-time">${escapeHtml(item.folderName)} • ${formatTime(item.timestamp)}</span>
      </div>
    `).join('');

    // Click handler
    list.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', () => {
        loadFileInPlayer(el.dataset.path);
      });
    });
  }

  async function clearHistory() {
    await dbClear('history');
    renderHistory();
    showToast('History cleared');
  }

  // ============================================================
  // File Explorer
  // ============================================================
  async function renderExplorer() {
    const list = $('#explorerFileList');
    const breadcrumb = $('#explorerBreadcrumb');
    const empty = $('#explorerEmpty');
    const favSection = $('#favoritesSection');

    if (!currentDirHandle) {
      list.innerHTML = '';
      empty.style.display = 'flex';
      if (favSection) favSection.style.display = '';
      return;
    }

    empty.style.display = 'none';

    // Navigate to current sub-directory
    let dirHandle = currentDirHandle;
    for (const seg of explorerPath) {
      try {
        dirHandle = await dirHandle.getDirectoryHandle(seg);
      } catch {
        // Invalid path, reset
        explorerPath = [];
        dirHandle = currentDirHandle;
        break;
      }
    }

    // Build breadcrumb
    let breadcrumbHtml = `<span class="breadcrumb-item flex-align" data-idx="-1">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-folder">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    </svg>
    ${escapeHtml(currentDirHandle.name)}</span>`;
    explorerPath.forEach((seg, idx) => {
      breadcrumbHtml += `<span class="breadcrumb-sep">›</span>`;
      const isCurrent = idx === explorerPath.length - 1;
      breadcrumbHtml += `<span class="breadcrumb-item ${isCurrent ? 'current' : ''}" data-idx="${idx}">${escapeHtml(seg)}</span>`;
    });
    breadcrumb.innerHTML = breadcrumbHtml;

    // Breadcrumb click
    breadcrumb.querySelectorAll('.breadcrumb-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        if (idx === -1) {
          explorerPath = [];
        } else {
          explorerPath = explorerPath.slice(0, idx + 1);
        }
        renderExplorer();
      });
    });

    // List entries
    const entries = [];
    try {
      for await (const entry of dirHandle.values()) {
        entries.push({
          name: entry.name,
          kind: entry.kind,
          handle: entry
        });
      }
    } catch (err) {
      list.innerHTML = `<div class="explorer-empty"><span>Error reading directory: ${escapeHtml(err.message)}</span></div>`;
      return;
    }

    // Sort: folders first, then files, alphabetical
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Add parent directory entry if in sub-folder
    let html = '';
    if (explorerPath.length > 0) {
      html += `<div class="file-item" data-action="parent">
        <span class="file-icon">⬆️</span>
        <span class="file-name">..</span>
        <span class="file-size">Parent</span>
      </div>`;
    }

    for (const entry of entries) {
      const icon = getFileIcon(entry.name, entry.kind);
      let size = '';
      if (entry.kind === 'file') {
        try {
          const file = await entry.handle.getFile();
          size = formatSize(file.size);
        } catch { size = ''; }
      }
      html += `<div class="file-item" data-name="${escapeAttr(entry.name)}" data-kind="${entry.kind}">
        <span class="file-icon">${icon}</span>
        <span class="file-name">${escapeHtml(entry.name)}</span>
        <span class="file-size">${size}</span>
      </div>`;
    }

    list.innerHTML = html;

    // Click handlers
    list.querySelectorAll('.file-item').forEach(el => {
      el.addEventListener('click', () => {
        if (el.dataset.action === 'parent') {
          explorerPath.pop();
          renderExplorer();
          return;
        }

        const name = el.dataset.name;
        const kind = el.dataset.kind;

        if (kind === 'directory') {
          explorerPath.push(name);
          renderExplorer();
        } else {
          // Build full path relative to root
          const fullPath = [...explorerPath, name].join('/');
          const ext = name.split('.').pop().toLowerCase();
          if (['html', 'htm'].includes(ext)) {
            loadFileInPlayer(fullPath);
          } else {
            // Open non-HTML files too (images, etc.)
            loadFileInPlayer(fullPath);
          }
        }
      });
    });

    // Render favorites
    if (favSection) {
      await renderFavorites();
    }
  }

  function getFileIcon(name, kind) {
    if (kind === 'directory') return '📁';
    const ext = name.split('.').pop().toLowerCase();
    const iconMap = {
      html: '🌐', htm: '🌐',
      css: '🎨',
      js: '⚡', mjs: '⚡',
      json: '📋',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', ico: '🖼️', bmp: '🖼️', avif: '🖼️',
      mp4: '🎬', webm: '🎬', avi: '🎬',
      mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵',
      pdf: '📕',
      zip: '📦', rar: '📦', gz: '📦',
      txt: '📝', md: '📝',
      xml: '📰',
      woff: '🔤', woff2: '🔤', ttf: '🔤', otf: '🔤'
    };
    return iconMap[ext] || '📄';
  }

  // ============================================================
  // Favorites Management
  // ============================================================
  async function addToFavorites() {
    if (!currentDirHandle) {
      showToast('No folder selected');
      return;
    }

    // Check if already in favorites
    const existing = await dbGetAll('favorites');
    for (const fav of existing) {
      if (await currentDirHandle.isSameEntry(fav.handle)) {
        showToast('Already in favorites');
        return;
      }
    }

    const name = currentDirHandle.name;
    await dbPut('favorites', null, {
      name: name,
      handle: currentDirHandle,
      addedAt: Date.now()
    });

    showToast('Added to favorites: ' + name);
    await renderFavorites();
  }

  async function renderFavorites() {
    const container = $('#favoritesList');
    if (!container) return;

    const favs = await dbGetAll('favorites');

    if (!favs || favs.length === 0) {
      container.innerHTML = `<div class="flex-align" style="padding: 12px 16px; font-size: 13px; color: var(--text-muted);">No favorites yet. Open a folder and tap 
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="red" stroke="red" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-heart">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
      </svg>
      to add.</div>`;
      return;
    }

    container.innerHTML = favs.map(fav => `
      <div class="favorite-item" data-id="${fav.id}">
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-star">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        <span class="fav-name">${escapeHtml(fav.name)}</span>
        <span class="fav-remove" data-id="${fav.id}" title="Remove">✕</span>
      </div>
    `).join('');

    // Click to open
    container.querySelectorAll('.favorite-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        if (e.target.classList.contains('fav-remove')) return;

        const id = parseInt(el.dataset.id);
        const fav = favs.find(f => f.id === id);
        if (!fav) return;

        try {
          const permission = await fav.handle.requestPermission({ mode: 'read' });
          if (permission === 'granted') {
            currentDirHandle = fav.handle;
            explorerPath = [];
            await dbPut('lastState', 'directoryHandle', fav.handle);
            await autoLoadIndex(fav.handle);
            showToast('Opened: ' + fav.name);
          } else {
            showToast('Permission denied');
          }
        } catch (err) {
          showToast('Error: ' + err.message);
        }
      });
    });

    // Remove button
    container.querySelectorAll('.fav-remove').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(el.dataset.id);
        await dbDelete('favorites', id);
        await renderFavorites();
        showToast('Removed from favorites');
      });
    });
  }

  // ============================================================
  // Settings UI
  // ============================================================
  function setupEventListeners() {
    // Open folder button
    $('#btnOpenFolder').addEventListener('click', openFolder);

    // Add to favorites
    $('#btnAddFavorite').addEventListener('click', addToFavorites);

    // Theme toggle
    $('#themeToggle').addEventListener('change', (e) => {
      settings.theme = e.target.checked ? 'dark' : 'light';
      applyTheme();
      saveSettings();
    });

    // JS toggle
    $('#jsToggle').addEventListener('change', (e) => {
      settings.jsEnabled = e.target.checked;
      saveSettings();
      // Reload current file if any
      if (currentFilePath) {
        loadFileInPlayer(currentFilePath);
      }
    });
    $('#jsToggle').checked = settings.jsEnabled;

    // Auto-hide mode
    const autoHideSelect = $('#autoHideSelect');
    autoHideSelect.value = settings.autoHideMode;
    autoHideSelect.addEventListener('change', (e) => {
      settings.autoHideMode = e.target.value;
      saveSettings();
      if (settings.autoHideMode === 'disabled') {
        showBars();
      }
    });

    // Clear history
    $('#btnClearHistory').addEventListener('click', clearHistory);

    // Help button
    $('#btnHelp').addEventListener('click', () => showModal('helpModal'));

    // Modal close buttons
    $$('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal-overlay').classList.remove('show');
      });
    });

    // Close modal on overlay click
    $$('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('show');
      });
    });

    // Check for update
    $('#btnCheckUpdate').addEventListener('click', checkForUpdate);

    // Edge detection for auto-hide
    setupEdgeDetection();

    // Open folder from empty state
    $('#btnOpenFolderEmpty')?.addEventListener('click', openFolder);

    // Handle iframe overlay clicks for auto-hide
    $('#iframeOverlay')?.addEventListener('click', handleIframeClick);
  }

  // ============================================================
  // Update Checker
  // ============================================================
  async function checkForUpdate() {
    const statusEl = $('#updateStatus');
    const banner = $('#updateBanner');
    statusEl.textContent = 'Checking...';

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        statusEl.textContent = 'No Service Worker registered';
        return;
      }

      // Force update check
      await reg.update();

      // Check if there's a waiting worker
      if (reg.waiting) {
        banner.classList.add('show');
        statusEl.textContent = 'New version available!';
        $('#btnDoUpdate').onclick = () => {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          window.location.reload();
        };
      } else if (reg.installing) {
        statusEl.textContent = 'Installing update...';
        reg.installing.addEventListener('statechange', function () {
          if (this.state === 'installed') {
            banner.classList.add('show');
            statusEl.textContent = 'Update ready!';
            $('#btnDoUpdate').onclick = () => {
              reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
              window.location.reload();
            };
          }
        });
      } else {
        statusEl.textContent = 'You are on the latest version (v' + APP_VERSION + ')';
      }
    } catch (err) {
      statusEl.textContent = 'Error checking: ' + err.message;
    }
  }

  function showUpdateBanner() {
    const banner = $('#updateBanner');
    if (banner) {
      banner.classList.add('show');
      $('#btnDoUpdate').onclick = () => {
        navigator.serviceWorker.getRegistration().then(reg => {
          reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
          window.location.reload();
        });
      };
    }
  }

  // ============================================================
  // Helpers
  // ============================================================
  function showModal(id) {
    $(`#${id}`).classList.add('show');
  }

  function showToast(message) {
    let toast = $('#toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';

    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ============================================================
  // Boot
  // ============================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
