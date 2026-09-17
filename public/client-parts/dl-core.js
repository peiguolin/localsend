/* dl-core：浏览器「共享文件分段下载器」核心（纯逻辑，依赖全部注入，Node 可独立测试）。
 * 特性：
 *   - 按 2MB 分段并发拉取（Range: bytes=start-end），进度回调
 *   - 暂停 / 继续 / 取消（AbortController 中断在途请求）
 *   - 断点持久化：storage 记录「哪些段已完成 + 段数据」→ 刷新页面后 restoreAll 续传（已下段不重下）
 *   - 全部段完成 → 组装 Blob → onDone(url) 供前端触发另存为
 * 依赖注入（opts）：
 *   fetchImpl   默认 window.fetch
 *   storage     { loadMeta, saveMeta, deleteMeta, listMeta, readSegment, writeSegment, deleteSegments }
 *               （浏览器端用 OPFS 实现；无则走内存降级：段 Blob 存内存、不跨刷新）
 *   createBlob/createUrl/revokeUrl
 * 进度/状态通过 onProgress / onState / onDone / onError 回调上报。
 */
(function () {
  'use strict';

  const app = window.chatApp;

  const SEGMENT_SIZE = 2 * 1024 * 1024;

  class SegmentDownloader {
    constructor(opts) {
      opts = opts || {};
      this.fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
      this.storage = opts.storage || null;
      this.createBlob = opts.createBlob || ((parts) => new Blob(parts));
      this.createUrl = opts.createUrl || ((blob) => URL.createObjectURL(blob));
      this.revokeUrl = opts.revokeUrl || ((u) => URL.revokeObjectURL(u));
      this.segmentSize = opts.segmentSize || SEGMENT_SIZE;
      this.concurrency = Math.max(1, opts.concurrency || 2);
      this.onProgress = opts.onProgress || null;
      this.onState = opts.onState || null;
      this.onDone = opts.onDone || null;
      this.onError = opts.onError || null;
      this._handles = new Map(); // key -> handle
    }

    all() { return Array.from(this._handles.values()); }
    handle(key) { return this._handles.get(String(key)) || null; }

    // 新建下载任务：cfg { key, url, name, size }
    newDownload(cfg) {
      const key = String(cfg.key || `${cfg.url}#${cfg.name}`);
      if (this._handles.has(key)) return this._handles.get(key);
      const size = Math.max(0, Number(cfg.size) || 0);
      const segments = [];
      for (let start = 0; start < size; start += this.segmentSize) {
        const end = Math.min(size, start + this.segmentSize);
        segments.push({ index: segments.length, start, end, size: end - start, done: false, fetching: false });
      }
      const h = {
        key, url: cfg.url, name: cfg.name, size, segments,
        doneBytes: 0, status: 'idle', error: '', paused: true, controller: null, _running: false
      };
      this._handles.set(key, h);
      this._persist(h);
      return h;
    }

    // 刷新恢复：读取持久化的任务，已下段不重下，未完成自动继续
    async restoreAll() {
      if (!this.storage || typeof this.storage.listMeta !== 'function') return;
      let keys = [];
      try { keys = await this.storage.listMeta(); } catch (_) { keys = []; }
      for (const key of keys) {
        if (this._handles.has(key)) continue;
        const meta = await this._loadPersisted(key);
        if (!meta || !meta.url) continue;
        const h = {
          key: meta.key, url: meta.url, name: meta.name, size: Math.max(0, Number(meta.size) || 0),
          segments: (meta.segments || []).map((s) => ({ ...s, done: !!s.done, fetching: false })),
          doneBytes: 0, status: 'idle', error: '', paused: true, controller: null, _running: false
        };
        // 校验已完成的段数据在存储里是否真实存在（否则回退为未完成）
        for (const s of h.segments) {
          if (s.done) {
            const blob = this.storage ? await this.storage.readSegment(h.key, s.index).catch(() => null) : null;
            if (blob) h.doneBytes += s.size;
            else s.done = false;
          }
        }
        this._handles.set(h.key, h);
        if (this.onState) this.onState(h);
        if (h.segments.length && h.segments.some((s) => !s.done)) {
          this.resume(h.key); // 自动续传未完成任务
        } else if (h.segments.length && h.segments.every((s) => s.done)) {
          this._finalize(h);
        }
      }
    }

    pause(key) {
      const h = this._handles.get(String(key));
      if (!h) return;
      h.paused = true;
      h.status = 'paused';
      if (this.onState) this.onState(h);
    }

    resume(key) {
      const h = this._handles.get(String(key));
      if (!h) return;
      h.paused = false;
      h.status = 'downloading';
      h.error = '';
      if (this.onState) this.onState(h);
      this._pump(h);
    }

    cancel(key) {
      const h = this._handles.get(String(key));
      if (!h) return;
      h.paused = true;
      h.status = 'cancelled';
      if (h.controller) { try { h.controller.abort(); } catch (_) {} h.controller = null; }
      if (this.storage) {
        Promise.all([
          this.storage.deleteMeta(h.key).catch(() => {}),
          this.storage.deleteSegments(h.key).catch(() => {})
        ]);
      }
      this._handles.delete(String(key));
      if (this.onState) this.onState(h);
    }

    // 从列表中移除（已完成任务清理）
    remove(key) {
      const h = this._handles.get(String(key));
      if (!h) return;
      if (h.controller) { try { h.controller.abort(); } catch (_) {} h.controller = null; }
      this._handles.delete(String(key));
      if (this.onState) this.onState(h);
    }

    // ---------- 内部 ----------
    _pump(h) {
      if (h._running || h.paused || h.status === 'cancelled' || h.status === 'done') return;
      if (!this.fetchImpl) { this._fail(h, '当前环境不支持 fetch'); return; }
      h._running = true;
      const workers = [];
      for (let i = 0; i < this.concurrency; i++) workers.push(this._worker(h));
      Promise.all(workers).finally(() => { h._running = false; });
    }

    async _worker(h) {
      while (!h.paused && h.status !== 'cancelled' && h.status !== 'done') {
        const seg = h.segments.find((s) => !s.done && !s.fetching);
        if (!seg) break;
        seg.fetching = true;
        try {
          const blob = await this._fetchSegment(h, seg);
          if (h.paused || h.status === 'cancelled') { seg.fetching = false; break; }
          if (this.storage) {
            await this.storage.writeSegment(h.key, seg.index, blob).catch(() => {});
          } else {
            seg.blob = blob; // 内存降级：段数据暂存内存
          }
          seg.done = true;
          h.doneBytes += seg.size;
          this._persist(h);
          if (this.onProgress) this.onProgress(h);
        } catch (err) {
          if (h.paused || h.status === 'cancelled') { seg.fetching = false; break; }
          this._fail(h, String((err && err.message) || err));
          return;
        }
        seg.fetching = false;
      }
      if (!h.paused && h.status !== 'cancelled' && h.segments.length && h.segments.every((s) => s.done)) {
        this._finalize(h);
      }
    }

    async _fetchSegment(h, seg) {
      if (!h.controller) h.controller = new AbortController();
      const res = await this.fetchImpl(h.url, {
        method: 'GET',
        headers: { Range: `bytes=${seg.start}-${seg.end - 1}` },
        signal: h.controller.signal
      });
      if (!res) throw new Error('无响应');
      if (res.status !== 206) throw new Error(`服务器未返回断点续传响应（HTTP ${res.status}）`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== seg.size) throw new Error('分段大小不符，文件可能已变化');
      return this.createBlob([buf]);
    }

    async _finalize(h) {
      if (h.status === 'done' || h.status === 'cancelled') return;
      h.status = 'done';
      h.paused = true;
      const parts = [];
      for (const s of h.segments) {
        const blob = this.storage
          ? await this.storage.readSegment(h.key, s.index).catch(() => null)
          : (s.blob || null);
        if (!blob) { this._fail(h, '部分分片丢失，请取消后重新下载'); return; }
        parts.push(blob);
      }
      const blob = this.createBlob(parts);
      const url = this.createUrl(blob);
      h.blobUrl = url;
      if (this.onDone) this.onDone(h, blob, url);
      if (this.onState) this.onState(h);
    }

    _fail(h, msg) {
      h.status = 'error';
      h.error = msg;
      h.paused = true;
      if (h.controller) { try { h.controller.abort(); } catch (_) {} }
      if (this.onError) this.onError(h);
      if (this.onState) this.onState(h);
    }

    async _persist(h) {
      if (!this.storage || !h) return;
      try {
        await this.storage.saveMeta(h.key, {
          key: h.key, url: h.url, name: h.name, size: h.size,
          segments: h.segments.map((s) => ({ index: s.index, start: s.start, end: s.end, size: s.size, done: s.done }))
        });
      } catch (_) { /* 持久化失败不阻塞下载 */ }
    }

    async _loadPersisted(key) {
      if (!this.storage) return null;
      try { return await this.storage.loadMeta(key); } catch (_) { return null; }
    }
  }

  app.dlCore = { SegmentDownloader };
})();
