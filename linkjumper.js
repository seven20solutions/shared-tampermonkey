// ==UserScript==
// @name         Ctrl+K Link Fuzzy Search + Editable Static Bookmarks
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Ctrl+K command palette with 10-page memory, persistent bookmarks, and bookmark renaming
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const PAGE_STORAGE_KEY = 'tm_link_palette_pages_v1';
    const BOOKMARK_STORAGE_KEY = 'tm_link_palette_bookmarks_v1';
    const MAX_PAGES = 10;
    const MAX_RESULTS = 12;
    const SHORTCUT_KEY = 'k';

    const state = {
        open: false,
        overlay: null,
        input: null,
        list: null,
        status: null,
        pages: [],
        bookmarks: [],
        allLinks: [],
        filtered: [],
        selectedIndex: 0,
        currentPageId: null,
        currentPageLinks: [],
        currentPageMeta: null,
        valueListenerId: null,
        started: false,
        toastEl: null,
        toastTimer: null,
        renameMode: false,
        renameWrap: null,
        renameInput: null,
        renameTarget: null,
    };

    function whenReady(fn) {
        if (document.body) {
            fn();
            return;
        }

        const obs = new MutationObserver(() => {
            if (document.body) {
                obs.disconnect();
                fn();
            }
        });

        obs.observe(document.documentElement, { childList: true, subtree: true });
    }

    function now() {
        return Date.now();
    }

    function pageIdFromUrl(url) {
        try {
            const u = new URL(url);
            return `${u.origin}${u.pathname}${u.search}`;
        } catch {
            return url;
        }
    }

    function visibleElement(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }

    function normalizeUrl(url) {
        try {
            return new URL(url, location.href).href;
        } catch {
            return url;
        }
    }

    function toast(message) {
        if (!document.body) return;

        if (!state.toastEl) {
            state.toastEl = document.createElement('div');
            state.toastEl.style.position = 'fixed';
            state.toastEl.style.left = '50%';
            state.toastEl.style.bottom = '24px';
            state.toastEl.style.transform = 'translateX(-50%)';
            state.toastEl.style.zIndex = '2147483647';
            state.toastEl.style.background = 'rgba(20,20,20,0.96)';
            state.toastEl.style.color = '#fff';
            state.toastEl.style.padding = '10px 14px';
            state.toastEl.style.borderRadius = '10px';
            state.toastEl.style.fontFamily = 'system-ui, -apple-system, sans-serif';
            state.toastEl.style.fontSize = '13px';
            state.toastEl.style.boxShadow = '0 10px 30px rgba(0,0,0,0.35)';
            state.toastEl.style.pointerEvents = 'none';
            state.toastEl.style.opacity = '0';
            state.toastEl.style.transition = 'opacity 120ms ease';
            document.body.appendChild(state.toastEl);
        }

        state.toastEl.textContent = message;
        state.toastEl.style.opacity = '1';

        clearTimeout(state.toastTimer);
        state.toastTimer = setTimeout(() => {
            if (state.toastEl) state.toastEl.style.opacity = '0';
        }, 1600);
    }

    function collectLinks() {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const seen = new Set();
        const pageUrl = location.href;
        const pageTitle = document.title || pageUrl;

        const links = [];
        for (const a of anchors) {
            if (!visibleElement(a)) continue;

            let href;
            try {
                href = normalizeUrl(a.href);
            } catch {
                continue;
            }

            const text =
                (a.innerText || a.textContent || a.getAttribute('aria-label') || href)
                    .replace(/\s+/g, ' ')
                    .trim();

            if (seen.has(href)) continue;
            seen.add(href);

            links.push({
                text,
                href,
                pageUrl,
                pageTitle,
                sourceLabel: 'Current page',
                kind: 'page',
            });
        }

        return {
            pageId: pageIdFromUrl(pageUrl),
            pageUrl,
            pageTitle,
            links,
        };
    }

    function loadJson(key, fallback) {
        const raw = GM_getValue(key, JSON.stringify(fallback));
        try {
            const parsed = JSON.parse(raw);
            return parsed ?? fallback;
        } catch {
            return fallback;
        }
    }

    function saveJson(key, value) {
        GM_setValue(key, JSON.stringify(value));
    }

    function loadPages() {
        const pages = loadJson(PAGE_STORAGE_KEY, []);
        return Array.isArray(pages) ? pages : [];
    }

    function loadBookmarks() {
        const bookmarks = loadJson(BOOKMARK_STORAGE_KEY, []);
        return Array.isArray(bookmarks) ? bookmarks : [];
    }

    function savePages(pages) {
        saveJson(PAGE_STORAGE_KEY, pages);
    }

    function saveBookmarks(bookmarks) {
        saveJson(BOOKMARK_STORAGE_KEY, bookmarks);
    }

    function upsertCurrentPage() {
        const current = collectLinks();
        state.currentPageId = current.pageId;
        state.currentPageLinks = current.links;
        state.currentPageMeta = {
            pageId: current.pageId,
            pageUrl: current.pageUrl,
            pageTitle: current.pageTitle,
            lastSeen: now(),
        };

        const pages = loadPages().filter(p => p.pageId !== current.pageId);
        pages.unshift({
            pageId: current.pageId,
            pageUrl: current.pageUrl,
            pageTitle: current.pageTitle,
            lastSeen: now(),
            links: current.links,
        });

        savePages(pages.slice(0, MAX_PAGES));
        state.pages = pages.slice(0, MAX_PAGES);
    }

    function rebuildIndex() {
        state.pages = loadPages();
        state.bookmarks = loadBookmarks();

        const flattened = [];
        const seen = new Set();

        const addItem = item => {
            const key = item.href;
            if (seen.has(key)) return;
            seen.add(key);
            flattened.push(item);
        };

        for (const bm of state.bookmarks) {
            addItem({
                text: bm.text || bm.href,
                href: bm.href,
                pageUrl: bm.pageUrl || bm.href,
                pageTitle: bm.pageTitle || 'Bookmark',
                sourceLabel: 'Bookmark',
                lastSeen: bm.savedAt || 0,
                kind: 'bookmark',
                bookmarkId: bm.href,
            });
        }

        for (const page of state.pages) {
            for (const link of page.links || []) {
                addItem({
                    text: link.text || link.href,
                    href: link.href,
                    pageUrl: page.pageUrl,
                    pageTitle: page.pageTitle,
                    sourceLabel: page.pageId === state.currentPageId ? 'Current page' : (page.pageTitle || page.pageUrl),
                    lastSeen: page.lastSeen || 0,
                    kind: 'page',
                });
            }
        }

        state.allLinks = flattened;
    }

    function scoreLink(query, item) {
        const q = query.toLowerCase().trim();
        if (!q) return 1;

        const text = (item.text || '').toLowerCase();
        const href = (item.href || '').toLowerCase();
        const title = (item.pageTitle || '').toLowerCase();
        const source = (item.sourceLabel || '').toLowerCase();

        if (text === q) return 5000;
        if (text.startsWith(q)) return 4000;
        if (text.includes(q)) return 2500;
        if (title.includes(q)) return 1200;
        if (source.includes(q)) return 1100;
        if (href.includes(q)) return 1000;

        let qi = 0;
        let score = 0;
        for (let i = 0; i < text.length && qi < q.length; i++) {
            if (text[i] === q[qi]) {
                score += 10;
                qi++;
            }
        }
        return qi === q.length ? score : -1;
    }

    function fuzzySearch(query) {
        return state.allLinks
            .map(item => ({ ...item, score: scoreLink(query, item) }))
            .filter(item => item.score >= 0)
            .sort((a, b) =>
                b.score - a.score ||
                (b.lastSeen || 0) - (a.lastSeen || 0) ||
                a.text.length - b.text.length
            )
            .slice(0, MAX_RESULTS);
    }

    function render() {
        if (!state.list || !state.status) return;

        state.list.innerHTML = '';

        const pageCount = state.pages.length;
        const bookmarkCount = state.bookmarks.length;
        state.status.textContent = `${state.filtered.length} result${state.filtered.length === 1 ? '' : 's'} • ${pageCount} page${pageCount === 1 ? '' : 's'} • ${bookmarkCount} bookmark${bookmarkCount === 1 ? '' : 's'}`;

        if (!state.filtered.length) {
            const empty = document.createElement('div');
            empty.style.padding = '12px';
            empty.style.color = '#9aa0a6';
            empty.textContent = 'No matching links';
            state.list.appendChild(empty);
            return;
        }

        state.filtered.forEach((item, idx) => {
            const row = document.createElement('div');
            row.style.padding = '10px 12px';
            row.style.cursor = 'pointer';
            row.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
            row.style.background = idx === state.selectedIndex ? '#284a7a' : 'transparent';

            const title = document.createElement('div');
            title.style.fontSize = '14px';
            title.style.fontWeight = '600';
            title.textContent = item.text || item.href;

            const meta = document.createElement('div');
            meta.style.fontSize = '12px';
            meta.style.color = '#a6a6a6';
            meta.style.wordBreak = 'break-all';
            meta.textContent = `${item.href} — ${item.sourceLabel}`;

            row.appendChild(title);
            row.appendChild(meta);

            row.addEventListener('mouseenter', () => {
                state.selectedIndex = idx;
                render();
            });

            row.addEventListener('click', () => navigate(item));

            state.list.appendChild(row);
        });
    }

    function close() {
        if (!state.open) return;
        state.open = false;
        state.overlay?.remove();
        state.overlay = null;
        state.input = null;
        state.list = null;
        state.status = null;
        state.filtered = [];
        state.selectedIndex = 0;
        exitRenameMode();
    }

    function navigate(item) {
        close();
        window.location.href = item.href;
    }

    function openPalette() {
        if (state.open) return;
        state.open = true;

        upsertCurrentPage();
        rebuildIndex();

        state.overlay = document.createElement('div');
        state.overlay.id = 'tm-link-palette';
        state.overlay.style.position = 'fixed';
        state.overlay.style.top = '12%';
        state.overlay.style.left = '50%';
        state.overlay.style.transform = 'translateX(-50%)';
        state.overlay.style.width = 'min(820px, 92vw)';
        state.overlay.style.zIndex = '2147483647';
        state.overlay.style.background = '#111';
        state.overlay.style.color = '#fff';
        state.overlay.style.border = '1px solid rgba(255,255,255,0.12)';
        state.overlay.style.borderRadius = '14px';
        state.overlay.style.boxShadow = '0 18px 48px rgba(0,0,0,0.45)';
        state.overlay.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        state.overlay.style.overflow = 'hidden';

        const header = document.createElement('div');
        header.style.padding = '12px';
        header.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
        header.style.background = '#151515';

        state.input = document.createElement('input');
        state.input.type = 'text';
        state.input.placeholder = 'Search links...';
        state.input.style.width = '100%';
        state.input.style.boxSizing = 'border-box';
        state.input.style.background = '#1b1b1b';
        state.input.style.color = '#fff';
        state.input.style.border = '1px solid rgba(255,255,255,0.12)';
        state.input.style.borderRadius = '10px';
        state.input.style.padding = '11px 12px';
        state.input.style.outline = 'none';
        state.input.style.fontSize = '14px';

        state.status = document.createElement('div');
        state.status.style.marginTop = '8px';
        state.status.style.fontSize = '12px';
        state.status.style.color = '#9aa0a6';

        state.list = document.createElement('div');
        state.list.style.maxHeight = '55vh';
        state.list.style.overflowY = 'auto';

        header.appendChild(state.input);
        header.appendChild(state.status);
        state.overlay.appendChild(header);
        state.overlay.appendChild(state.list);
        document.body.appendChild(state.overlay);

        state.input.addEventListener('input', () => {
            state.filtered = fuzzySearch(state.input.value);
            state.selectedIndex = 0;
            render();
        });

        state.input.addEventListener('keydown', onInputKeyDown);

        state.filtered = fuzzySearch('');
        state.selectedIndex = 0;
        render();

        setTimeout(() => state.input.focus(), 0);
    }

    function addBookmarkFromItem(item) {
        const bookmarks = loadBookmarks();
        const href = normalizeUrl(item.href);
        const existingIndex = bookmarks.findIndex(b => b.href === href);

        const bookmark = {
            href,
            text: item.text || href,
            pageUrl: item.pageUrl || location.href,
            pageTitle: item.pageTitle || document.title || href,
            savedAt: now(),
        };

        if (existingIndex >= 0) {
            bookmarks[existingIndex] = bookmark;
        } else {
            bookmarks.unshift(bookmark);
        }

        saveBookmarks(bookmarks);
        state.bookmarks = bookmarks;
        rebuildIndex();

        if (state.open) {
            state.filtered = fuzzySearch(state.input?.value || '');
            render();
        }

        toast(`Saved bookmark: ${bookmark.text}`);
    }

    function renameBookmark(item) {
        if (!item || item.kind !== 'bookmark') {
            toast('Select a bookmark first');
            return;
        }

        enterRenameMode(item);
    }

    function enterRenameMode(item) {
        exitRenameMode();

        state.renameMode = true;
        state.renameTarget = item;

        const row = document.createElement('div');
        row.style.padding = '10px 12px';
        row.style.borderTop = '1px solid rgba(255,255,255,0.08)';
        row.style.background = '#171717';
        row.style.display = 'flex';
        row.style.gap = '8px';
        row.style.alignItems = 'center';

        const label = document.createElement('div');
        label.textContent = 'Rename bookmark:';
        label.style.fontSize = '12px';
        label.style.color = '#9aa0a6';
        label.style.flex = '0 0 auto';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = item.text || item.href;
        input.style.flex = '1 1 auto';
        input.style.background = '#1b1b1b';
        input.style.color = '#fff';
        input.style.border = '1px solid rgba(255,255,255,0.12)';
        input.style.borderRadius = '10px';
        input.style.padding = '10px 12px';
        input.style.outline = 'none';
        input.style.fontSize = '14px';

        const save = () => {
            const newTitle = input.value.trim();
            if (!newTitle) {
                toast('Title cannot be empty');
                return;
            }

            const bookmarks = loadBookmarks();
            const idx = bookmarks.findIndex(b => b.href === item.href);
            if (idx >= 0) {
                bookmarks[idx].text = newTitle;
                bookmarks[idx].savedAt = now();
                saveBookmarks(bookmarks);
                state.bookmarks = bookmarks;
                rebuildIndex();
                if (state.open) {
                    state.filtered = fuzzySearch(state.input?.value || '');
                    render();
                }
                toast(`Renamed bookmark: ${newTitle}`);
            }

            exitRenameMode();
            state.input?.focus();
        };

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                save();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                exitRenameMode();
                state.input?.focus();
            }
        });

        row.appendChild(label);
        row.appendChild(input);
        state.list.appendChild(row);

        state.renameWrap = row;
        state.renameInput = input;

        setTimeout(() => input.focus(), 0);
    }

    function exitRenameMode() {
        state.renameMode = false;
        state.renameTarget = null;
        state.renameWrap?.remove();
        state.renameWrap = null;
        state.renameInput = null;
    }

    function addBookmarkForCurrentContext() {
        if (state.open && state.filtered.length > 0) {
            addBookmarkFromItem(state.filtered[state.selectedIndex]);
            return;
        }

        addBookmarkFromItem({
            href: location.href,
            text: document.title || location.href,
            pageUrl: location.href,
            pageTitle: document.title || location.href,
        });
    }

    function onInputKeyDown(e) {
        if (state.renameMode) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            state.selectedIndex = Math.min(state.selectedIndex + 1, state.filtered.length - 1);
            render();
            return;
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
            render();
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            const item = state.filtered[state.selectedIndex];
            if (item) navigate(item);
            return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }

        if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'e') {
            e.preventDefault();
            const item = state.filtered[state.selectedIndex];
            if (item && item.kind === 'bookmark') {
                renameBookmark(item);
            } else {
                toast('Select a bookmark to rename');
            }
        }
    }

    function onGlobalKeyDown(e) {
        if (e.key === 'Escape' && state.open) {
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
        }

        if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === SHORTCUT_KEY) {
            e.preventDefault();
            e.stopPropagation();
            if (state.open) close();
            else openPalette();
            return;
        }

        if (e.ctrlKey && e.metaKey && !e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            e.stopPropagation();
            addBookmarkForCurrentContext();
        }
    }

    function registerTabListener() {
        if (typeof GM_addValueChangeListener !== 'function') return;
        state.valueListenerId = GM_addValueChangeListener(PAGE_STORAGE_KEY, () => {
            if (state.open) {
                rebuildIndex();
                state.filtered = fuzzySearch(state.input?.value || '');
                render();
            }
        });
    }

    function attachDebugHooks() {
        window.__linkPalette = {
            open: openPalette,
            close,
            toggle: () => (state.open ? close() : openPalette()),
            reindex: () => {
                upsertCurrentPage();
                rebuildIndex();
                if (state.open) {
                    state.filtered = fuzzySearch(state.input?.value || '');
                    render();
                }
            },
            bookmarkCurrent: addBookmarkForCurrentContext,
            renameSelectedBookmark: () => {
                const item = state.filtered[state.selectedIndex];
                if (item && item.kind === 'bookmark') renameBookmark(item);
            },
            state,
        };
    }

    GM_registerMenuCommand('Re-index current page links', () => {
        upsertCurrentPage();
        rebuildIndex();
        if (state.open) {
            state.filtered = fuzzySearch(state.input?.value || '');
            render();
        }
    });

    GM_registerMenuCommand('Bookmark current page', () => {
        addBookmarkFromItem({
            href: location.href,
            text: document.title || location.href,
            pageUrl: location.href,
            pageTitle: document.title || location.href,
        });
    });

    function start() {
        if (state.started) return;
        state.started = true;

        registerTabListener();
        attachDebugHooks();
        upsertCurrentPage();
        rebuildIndex();

        document.addEventListener('keydown', onGlobalKeyDown, true);

        console.log('[Ctrl+K Link Palette] active');
        console.log('Ctrl+K opens palette');
        console.log('Ctrl+Cmd+S saves a static bookmark');
        console.log('Ctrl+E renames a selected bookmark');
    }

    whenReady(start);
})();
