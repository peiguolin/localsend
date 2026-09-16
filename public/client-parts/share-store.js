/* 共享句柄持久化（IndexedDB）：保存 FileSystemDirectoryHandle + 共享设置，
 * 页面刷新后自动恢复共享（权限已授予时）或提示一键恢复。
 * 纯逻辑模块，无 DOM / socket 依赖：可独立冒烟测试（Node 桩 indexedDB 验证）。
 * 挂到 window.chatApp.shareStore；share.js 在创建/取消共享时读写。
 * 说明：文件句柄（结构化克隆）只能存 IndexedDB，localStorage 放不下。
 */
(function () {
  'use strict';

  const S = window.chatApp = window.chatApp || {};

  const DB_NAME = 'localsend-share-store';
  const DB_VERSION = 1;
  const STORE = 'shares';
  const KEY = 'active'; // 每人同时只共享一个文件夹，单键即可

  function open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB 不可用'));
      let req;
      try { req = window.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }

  function withStore(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { db.close(); return reject(e); }
      const store = tx.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (e) { db.close(); return reject(e); }
      tx.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB 操作失败')); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB 操作中止')); };
    }));
  }

  const api = {
    // 保存共享记录：{ name, password, writable, handle, createdAt }
    save(rec) {
      const r = Object.assign({}, rec || {});
      r.createdAt = r.createdAt || Date.now();
      return withStore('readwrite', (store) => store.put(r, KEY));
    },

    // 读取上次共享记录（无则 null）
    load() {
      return withStore('readonly', (store) => store.get(KEY)).then((r) => r || null).catch(() => null);
    },

    // 清除记录（用户主动取消共享时调用，避免刷新后"复活"）
    clear() {
      return withStore('readwrite', (store) => store.delete(KEY));
    },

    // 查询句柄权限：writable=true 用 readwrite 模式查询
    queryPermission(handle, writable) {
      if (!handle || typeof handle.queryPermission !== 'function') return Promise.resolve('denied');
      return Promise.resolve().then(() => handle.queryPermission({ mode: writable ? 'readwrite' : 'read' }));
    },

    // 请求句柄权限（需用户手势；返回 'granted' | 'prompt' | 'denied'）
    requestPermission(handle, writable) {
      if (!handle || typeof handle.requestPermission !== 'function') return Promise.resolve('denied');
      return Promise.resolve().then(() => handle.requestPermission({ mode: writable ? 'readwrite' : 'read' }));
    },

    isSupported: typeof window !== 'undefined' && !!window.indexedDB
  };

  S.shareStore = api;
})();
