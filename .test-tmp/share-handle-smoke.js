/* 共享句柄持久化（IndexedDB）冒烟测试：
 * - 桩 window.indexedDB（内存 Map 实现）
 * - save → load 往返（含 createdAt 补齐 + 句柄对象原样带回）
 * - clear → load 为 null
 * - queryPermission / requestPermission 透传句柄能力，并按 writable 选择 readwrite/read 模式
 * - isSupported 随 window.indexedDB 有无而切换
 */
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---------- 最小内存 IndexedDB 桩 ----------
function createFakeIndexedDB() {
  const kv = new Map();
  const db = {
    objectStoreNames: { contains: (n) => n === 'shares' },
    createObjectStore: () => {},
    transaction: (name, mode) => {
      const tx = {};
      tx.objectStore = () => ({
        put: (val, key) => { kv.set(key, val); return { result: undefined }; },
        get: (key) => ({ result: kv.has(key) ? kv.get(key) : undefined }),
        delete: (key) => { kv.delete(key); return { result: undefined }; }
      });
      queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
      return tx;
    },
    close: () => {}
  };
  return {
    open: () => {
      const req = { result: db, error: null };
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
}

const MODULE = path.join(__dirname, '..', 'public', 'client-parts', 'share-store.js');

async function main() {
  // 场景 1：无 indexedDB → isSupported false
  global.window = { chatApp: {} };
  delete global.window.indexedDB;
  require(MODULE);
  check('无 IndexedDB 时 isSupported=false', global.window.chatApp.shareStore.isSupported === false);

  // 场景 2：有 IndexedDB → 完整往返
  delete require.cache[require.resolve(MODULE)];
  global.window = { chatApp: {}, indexedDB: createFakeIndexedDB() };
  require(MODULE); // 重新执行 IIFE，挂到新的 window.chatApp
  const api = global.window.chatApp.shareStore;
  check('shareStore 挂载到 chatApp', !!api);
  check('有 IndexedDB 时 isSupported=true', api.isSupported === true);

  console.log('【save → load 往返】');
  const fakeHandle = { kind: 'directory', name: '共享盘', queryPermission() {}, requestPermission() {} };
  await api.save({ name: '我的共享', password: 'pw123', writable: true, handle: fakeHandle });
  const rec = await api.load();
  check('load 返回记录', rec && rec.name === '我的共享' && rec.writable === true && rec.password === 'pw123');
  check('createdAt 自动补齐', typeof rec.createdAt === 'number');
  check('句柄对象原样带回', rec.handle === fakeHandle && rec.handle.name === '共享盘');

  console.log('【覆盖保存 / 清除】');
  await api.save({ name: '覆盖后的共享', writable: false, handle: fakeHandle });
  const rec2 = await api.load();
  check('覆盖保存生效', rec2 && rec2.name === '覆盖后的共享' && rec2.writable === false);
  await api.clear();
  const rec3 = await api.load();
  check('clear 后 load 为 null', rec3 === null);

  console.log('【权限查询 / 请求】');
  const modesSeen = [];
  const permHandle = {
    queryPermission: (o) => { modesSeen.push(['query', o.mode]); return Promise.resolve('granted'); },
    requestPermission: (o) => { modesSeen.push(['request', o.mode]); return Promise.resolve('granted'); }
  };
  check('queryPermission(writable) 用 readwrite', (await api.queryPermission(permHandle, true)) === 'granted' && modesSeen[0][1] === 'readwrite');
  check('requestPermission(只读) 用 read', (await api.requestPermission(permHandle, false)) === 'granted' && modesSeen[1][1] === 'read');
  check('无句柄能力时返回 denied', (await api.queryPermission(null, true)) === 'denied' && (await api.requestPermission({}, false)) === 'denied');

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
