/* share 共享者本地代理片：响应服务器的 share_fs 文件系统请求（list/read/write），
 * 通过 File System Access API 读写共享者本地所选文件夹；下载走 push 中转，上传走 pull 拉流，含 Range。 */
(function () {
  'use strict';
  if (!window.chatApp) return;
  const app = window.chatApp;
  const S = app._share;
  const socket = app.socket;

  function myToken() {
    return S.myShare ? (S.tokens.get(S.myShare.id) || '') : '';
  }

  function splitPath(p) {
    return String(p || '').split('/').filter(Boolean);
  }

  // 文件名安全过滤（服务器已净化，这里双保险）
  function isSafeName(name) {
    if (!name || name === '.' || name === '..' || name.length > 255) return false;
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (c < 32) return false;
    }
    return !/[\\/<>:"|?*]/.test(name);
  }

  function friendlyErr(err) {
    const name = err && err.name;
    if (name === 'NotFoundError') return '路径不存在';
    if (name === 'NotAllowedError') return '浏览器未授权该操作';
    if (name === 'TypeMismatchError') return '路径类型不符';
    return (err && err.message) || '操作失败';
  }

  async function resolveDir(parts) {
    let dir = S.myShare.dirHandle;
    for (const seg of parts) {
      if (!isSafeName(seg)) throw new Error('路径无效');
      dir = await dir.getDirectoryHandle(seg);
    }
    return dir;
  }

  async function localList(path) {
    const dir = await resolveDir(splitPath(path));
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        entries.push({ name, kind: 'dir' });
      } else {
        const f = await handle.getFile();
        entries.push({ name, kind: 'file', size: f.size, mtime: f.lastModified });
      }
    }
    return entries;
  }

  // 下载：先 ack 确认可读（含文件大小），再把内容 POST 推流给服务器中转。
  // Range：req.range 存在时按 start/end 切片（分段下载/断点续传），服务器回 206。
  async function localRead(req, reply) {
    const parts = splitPath(req.path);
    const name = parts.pop();
    if (!isSafeName(name)) return reply({ ok: false, error: '路径无效' });
    let file;
    try {
      const dir = await resolveDir(parts);
      file = await (await dir.getFileHandle(name)).getFile();
    } catch (err) {
      return reply({ ok: false, error: friendlyErr(err) });
    }
    let slice = file;
    let start = 0;
    let hasRange = false;
    if (req.range) {
      hasRange = true;
      // bytes=-N 表示"最后 N 字节"（start 缺省），归一化为绝对 start..end
      let rs = req.range.start;
      let re = req.range.end;
      if (rs === null && re !== null) {
        rs = Math.max(0, file.size - re);
        re = null;
      }
      rs = rs == null ? 0 : rs;
      if (rs >= file.size) {
        return reply({ ok: false, rangeError: true, size: file.size, error: '超出文件范围' });
      }
      const end = re == null ? file.size - 1 : Math.min(re, file.size - 1);
      slice = file.slice(rs, end + 1);
      start = rs;
    }
    reply({ ok: true, size: file.size });
    try {
      const url = `/api/share/${encodeURIComponent(S.myShare.id)}/push` +
        `?transferId=${encodeURIComponent(req.transferId)}` +
        `&token=${encodeURIComponent(myToken())}` +
        `&name=${encodeURIComponent(file.name)}&size=${slice.size}` +
        (hasRange ? `&start=${start}&total=${file.size}` : '');
      await fetch(url, { method: 'POST', body: slice });
    } catch (_) { /* 下载方已断开或网络错误 */ }
  }

  async function localFileExists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (err) {
      if (err && err.name === 'NotFoundError') return false;
      throw err;
    }
  }

  function withNumericSuffix(name, i) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) return `${name.slice(0, dot)} (${i})${name.slice(dot)}`;
    return `${name} (${i})`;
  }

  // 上传：创建本地文件，从服务器拉流写入磁盘
  async function localWrite(req) {
    if (!S.myShare.canWrite) return { ok: false, error: '共享者未开启写入权限' };
    const parts = splitPath(req.path);
    const rawName = parts.pop();
    if (!isSafeName(rawName)) return { ok: false, error: '文件名无效' };
    let dir;
    try {
      dir = await resolveDir(parts);
    } catch (err) {
      return { ok: false, error: friendlyErr(err) };
    }
    // 重名自动追加 (1)、(2)…
    let finalName = rawName;
    for (let i = 1; i <= 100 && (await localFileExists(dir, finalName)); i++) {
      finalName = withNumericSuffix(rawName, i);
    }
    try {
      const fh = await dir.getFileHandle(finalName, { create: true });
      const writable = await fh.createWritable();
      const resp = await fetch(
        `/api/share/${encodeURIComponent(S.myShare.id)}/pull` +
        `?transferId=${encodeURIComponent(req.transferId)}` +
        `&token=${encodeURIComponent(myToken())}`
      );
      if (!resp.ok || !resp.body) return { ok: false, error: '拉取上传数据失败' };
      await resp.body.pipeTo(writable);
      return { ok: true, savedAs: finalName };
    } catch (err) {
      return { ok: false, error: friendlyErr(err) };
    }
  }

  socket.on('share_fs', async (req, reply) => {
    reply = typeof reply === 'function' ? reply : () => {};
    if (!S.myShare || !req) return reply({ ok: false, error: '共享已取消' });
    try {
      if (req.op === 'list') {
        reply({ ok: true, entries: await localList(req.path) });
      } else if (req.op === 'read') {
        await localRead(req, reply);
      } else if (req.op === 'write') {
        reply(await localWrite(req));
      } else {
        reply({ ok: false, error: '未知操作' });
      }
    } catch (err) {
      reply({ ok: false, error: friendlyErr(err) });
    }
  });
})();
