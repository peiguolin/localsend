/* dl-core 分段下载器单元测试（Node，全依赖注入）：
 *  - 完整下载：2MB 分段 Range 拉取 → 组装 Blob 字节与源一致
 *  - 暂停/继续：暂停后不再发请求；继续只拉剩余段（已下段不重下）
 *  - 刷新恢复：新实例 + 同一 storage → restoreAll 自动续传，只拉缺失段
 *  - 取消：中断在途请求、清空 meta 与段数据、不触发 onDone
 *  - 并发上限：同时请求数 ≤ concurrency
 */
'use strict';
const path = require('path');
const crypto = require('crypto');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout = 4000, step = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

// ---------- 注入环境 ----------
const app = { utils: {} };
global.window = { chatApp: app };
delete require.cache[require.resolve(path.join(__dirname, '..', 'public', 'client-parts', 'dl-core.js'))];
require(path.join(__dirname, '..', 'public', 'client-parts', 'dl-core.js'));
const { SegmentDownloader } = app.dlCore;

// 内存存储：模拟 OPFS（meta + 段数据），可在实例间共享模拟"刷新"
function memStorage() {
  const metas = new Map();
  const segs = new Map();
  return {
    async loadMeta(k) { return metas.get(k) || null; },
    async saveMeta(k, m) { metas.set(k, m); },
    async deleteMeta(k) { metas.delete(k); },
    async listMeta() { return Array.from(metas.keys()); },
    async readSegment(k, i) { const b = segs.get(`${k}:${i}`); return b ? new Blob([b]) : null; },
    async writeSegment(k, i, blob) { segs.set(`${k}:${i}`, new Uint8Array(await blob.arrayBuffer())); },
    async deleteSegments(k) { for (const key of Array.from(segs.keys())) if (key.startsWith(k + ':')) segs.delete(key); }
  };
}

// 可控 fetch 桩：按 Range 切源数据返回 206；记录请求
function makeFetch(source, delayMs) {
  const calls = [];
  let active = 0, maxActive = 0;
  const impl = (url, opts) => {
    calls.push({ url, range: (opts && opts.headers && opts.headers.Range) || '' });
    const m = /bytes=(\d+)-(\d+)/.exec(impl.lastRange = (opts && opts.headers && opts.headers.Range) || '');
    const start = Number(m[1]);
    const end = Number(m[2]);
    const slice = source.slice(start, end + 1);
    active++; maxActive = Math.max(maxActive, active);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        active--;
        if ((opts && opts.signal && opts.signal.aborted)) { reject(new DOMException('aborted', 'AbortError')); return; }
        resolve(new Response(slice, {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${source.length}`, 'Content-Length': String(slice.length) }
        }));
      }, delayMs || 5);
    });
  };
  impl.calls = calls;
  impl.maxActive = () => maxActive;
  return impl;
}

const SEG = 2 * 1024 * 1024;

(async () => {
  console.log('--- 完整下载：分段 Range 拉取 + 组装 ---');
  {
    const src = crypto.randomBytes(5 * 1024 * 1024 + 12345);
    const fetchImpl = makeFetch(src);
    const done = [];
    const dl = new SegmentDownloader({
      fetchImpl, storage: memStorage(), segmentSize: SEG, concurrency: 2,
      onDone: (h, blob) => done.push({ h, blob }),
      createUrl: (blob) => { blob; return 'blob:1'; }, revokeUrl: () => {}
    });
    const h = dl.newDownload({ key: 'full', url: '/f', name: 'full.bin', size: src.length });
    check('分段数正确（2MB/段）', h.segments.length === 3, String(h.segments.length));
    dl.resume('full');
    const ok = await waitFor(() => done.length === 1);
    check('下载完成回调触发', ok);
    if (done.length) {
      const bytes = new Uint8Array(await done[0].blob.arrayBuffer());
      check('组装字节与源一致', Buffer.compare(Buffer.from(bytes), Buffer.from(src)) === 0);
    }
    check('doneBytes 等于总大小', h.doneBytes === src.length, String(h.doneBytes));
    const ranges = fetchImpl.calls.map((c) => c.range);
    const lastRange = `bytes=${2 * SEG}-${src.length - 1}`;
    check('Range 覆盖全部段', ranges.includes('bytes=0-2097151') && ranges.includes('bytes=2097152-4194303') && ranges.includes(lastRange), JSON.stringify(ranges));
  }

  console.log('--- 暂停 / 继续：暂停不发请求，继续只拉剩余段 ---');
  {
    const src = crypto.randomBytes(5 * 1024 * 1024);
    const fetchImpl = makeFetch(src, 15);
    const done = [];
    const dl = new SegmentDownloader({
      fetchImpl, storage: memStorage(), segmentSize: SEG, concurrency: 2,
      onDone: (h, blob) => done.push({ h, blob }),
      createUrl: (b) => 'blob:2', revokeUrl: () => {}
    });
    const h = dl.newDownload({ key: 'pause', url: '/f', name: 'p.bin', size: src.length });
    dl.resume('pause');
    await waitFor(() => h.doneBytes >= SEG);
    dl.pause('pause');
    const callsAtPause = fetchImpl.calls.length;
    await sleep(60);
    check('暂停后不再发起请求', fetchImpl.calls.length === callsAtPause, `${fetchImpl.calls.length} vs ${callsAtPause}`);
    check('状态为已暂停', h.status === 'paused');
    dl.resume('pause');
    const ok = await waitFor(() => done.length === 1);
    check('继续后下载完成', ok);
    const firstRange = 'bytes=0-2097151';
    const firstCount = fetchImpl.calls.filter((c) => c.range === firstRange).length;
    check('已下段未重复请求（第 1 段只拉 1 次）', firstCount === 1, String(firstCount));
  }

  console.log('--- 刷新恢复：新实例 + 同一 storage → 只拉缺失段 ---');
  {
    const src = crypto.randomBytes(5 * 1024 * 1024);
    const storage = memStorage();
    const f1 = makeFetch(src, 15);
    const dl1 = new SegmentDownloader({ fetchImpl: f1, storage, segmentSize: SEG, concurrency: 2, createUrl: (b) => 'blob:3', revokeUrl: () => {} });
    const h1 = dl1.newDownload({ key: 'refresh', url: '/f', name: 'r.bin', size: src.length });
    dl1.resume('refresh');
    await waitFor(() => h1.doneBytes >= SEG);
    dl1.pause('refresh');
    const doneBytesBefore = h1.doneBytes;
    const doneSegsBefore = h1.segments.filter((s) => s.done).length;
    check('刷新前已下部分段', doneSegsBefore >= 1, String(doneSegsBefore));

    // 模拟刷新：全新实例 + 同一 storage
    const f2 = makeFetch(src, 10);
    const done2 = [];
    const dl2 = new SegmentDownloader({
      fetchImpl: f2, storage, segmentSize: SEG, concurrency: 2,
      onDone: (h, blob) => done2.push({ h, blob }),
      createUrl: (b) => 'blob:4', revokeUrl: () => {}
    });
    await dl2.restoreAll();
    const h2 = dl2.handle('refresh');
    check('恢复后任务重新挂载', !!h2);
    if (h2) {
      check('恢复后已下字节数保留', h2.doneBytes === doneBytesBefore, `${h2.doneBytes} vs ${doneBytesBefore}`);
      const ok = await waitFor(() => done2.length === 1);
      check('恢复后自动续传完成', ok);
      const bytes = new Uint8Array(await done2[0].blob.arrayBuffer());
      check('恢复后组装字节一致', Buffer.compare(Buffer.from(bytes), Buffer.from(src)) === 0);
      const redoneRanges = [];
      for (let i = 0; i < doneSegsBefore; i++) redoneRanges.push(`bytes=${i * SEG}-${(i + 1) * SEG - 1}`);
      const refetched = f2.calls.filter((c) => redoneRanges.includes(c.range)).length;
      check('已下段未被重新拉取', refetched === 0, String(refetched));
    }
  }

  console.log('--- 取消：清空存储、不触发 onDone ---');
  {
    const src = crypto.randomBytes(6 * 1024 * 1024);
    const storage = memStorage();
    const fetchImpl = makeFetch(src, 20);
    let doneCount = 0;
    const dl = new SegmentDownloader({
      fetchImpl, storage, segmentSize: SEG, concurrency: 2,
      onDone: () => { doneCount++; },
      createUrl: (b) => 'blob:5', revokeUrl: () => {}
    });
    const h = dl.newDownload({ key: 'cancel', url: '/f', name: 'c.bin', size: src.length });
    dl.resume('cancel');
    await waitFor(() => h.doneBytes > 0);
    dl.cancel('cancel');
    await sleep(80);
    check('状态为已取消', h.status === 'cancelled');
    check('存储 meta 已删除', (await storage.listMeta()).indexOf('cancel') === -1);
    check('存储段数据已删除', (await storage.readSegment('cancel', 0)) === null);
    check('未触发 onDone', doneCount === 0, String(doneCount));
    check('任务已从列表移除', dl.handle('cancel') === null);
    await sleep(60);
    const callsAfter = fetchImpl.calls.length;
    await sleep(60);
    check('取消后不再发起请求', fetchImpl.calls.length === callsAfter);
  }

  console.log('--- 并发上限 ---');
  {
    const src = crypto.randomBytes(6 * 1024 * 1024);
    const fetchImpl = makeFetch(src, 25);
    const dl = new SegmentDownloader({ fetchImpl, storage: memStorage(), segmentSize: SEG, concurrency: 2, createUrl: (b) => 'blob:6', revokeUrl: () => {} });
    const h = dl.newDownload({ key: 'cc', url: '/f', name: 'cc.bin', size: src.length });
    dl.resume('cc');
    await waitFor(() => h.status === 'done');
    check('同时请求数不超过并发上限 2', fetchImpl.maxActive() <= 2, String(fetchImpl.maxActive()));
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
