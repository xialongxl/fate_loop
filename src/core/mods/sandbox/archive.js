/**
 * zip 投递：把一个 .zip 解成"包对象"（Map<路径, 文本>）。
 *
 * 为什么需要它：多文件包（作者把技能拆进 lib/）压成 zip 是最自然的分发形态。
 * 包对象本身与 zip 无关（就是 Map），所以这里**只负责解包与守门**，
 * 沙箱那边完全不知道 zip 存在。
 *
 * ⚠️ zip 是本项目第一个**外部可控的内存放大源**（zip bomb：几十 KB 的压缩包里
 * 塞几个 GB）。三条上限必须在**解压之前**判：fflate 的 `Unzip` 类在 `onfile`
 * 里先给出头部声明的解压大小，由我们决定是否调 `decompress()`。
 * 用 `unzip()` 函数（整包解完再回调）就没有这个闸门 —— 那是已经中招了。
 */

import { Unzip, UnzipInflate } from 'fflate';
import { MAX_PACK_FILES, normalizePackPath } from './pack.js';

/** 压缩包本身的上限。 */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
/** 解压后总大小上限。 */
export const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
/** 单个条目声明的解压大小上限。 */
export const MAX_ENTRY_BYTES = 512 * 1024;
/** 条目数上限（含被过滤掉的目录/不支持类型）。 */
export const MAX_ENTRIES = 256;
const ALLOWED_EXT = /\.(js|json|md|txt)$/i;

/** 所有条目共着一个顶层目录时（zip 一个文件夹的常见结果）把它剥掉。 */
function commonRootStripper(paths) {
  if (paths.length === 0) return (p) => p;
  const roots = new Set(paths.map((p) => p.split('/')[0]));
  if (roots.size !== 1) return (p) => p;
  const root = [...roots][0];
  if (!root || root.includes('.')) return (p) => p;
  return (p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
}

/** 把分片拼成一个 Uint8Array（ondata 可能多次回调）。 */
function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function readManifest(files) {
  const raw = files.get('pack.json') ?? files.get('manifest.json');
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 清单坏了不该让整个包读不出来：内容仍然合法，只是少了标题
    return {};
  }
}

/**
 * 解一个 zip。
 * @param {Uint8Array} bytes
 * @returns {Promise<{ok:true, files:Map<string,string>, entry:string, meta:object} | {ok:false, reason:string}>}
 */
export function unpackArchive(bytes) {
  return new Promise((resolve) => {
    if (!(bytes instanceof Uint8Array)) {
      resolve({ ok: false, reason: '不是二进制内容，无法解包' });
      return;
    }
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      resolve({ ok: false, reason: `压缩包超过 ${MAX_ARCHIVE_BYTES} 字节` });
      return;
    }

    const files = new Map();
    let total = 0;
    let entries = 0;
    /** 一旦定论（失败或收尾），后续回调全部闭嘴 —— resolve 只能有一次 */
    let settled = false;
    const stop = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const decoder = new TextDecoder('utf-8', { fatal: false });

    const finish = () => {
      const paths = [...files.keys()];
      if (paths.length === 0) {
        stop({ ok: false, reason: '压缩包里没有任何可用文件（只收 js/json/md/txt）' });
        return;
      }
      const demote = commonRootStripper(paths);
      const normalized = new Map();
      for (const [path, text] of files) {
        try {
          normalized.set(normalizePackPath(demote(path)), text);
        } catch (inner) {
          stop({ ok: false, reason: inner?.message ?? String(inner) });
          return;
        }
      }
      const meta = readManifest(normalized);
      const entry = typeof meta.entry === 'string' ? meta.entry : 'main.js';
      if (!normalized.has(entry)) {
        stop({
          ok: false,
          reason: `找不到入口 ${entry}（包内文件：${[...normalized.keys()].join(', ')}）`,
        });
        return;
      }
      stop({ ok: true, files: normalized, entry, meta });
    };

    const extractor = new Unzip();
    // Unzip 只内置 stored(0)；deflate(8) 要自己注册 —— 漏了的话 file.start() 会抛
    extractor.register(UnzipInflate);

    /**
     * 用 **Unzip 流而不是 unzip() 函数**：后者是"整包解完再回调"，
     * 没有逐文件闸门 —— 而 zip bomb 恰恰需要在解压之前按头部声明的
     * 大小（`originalSize`）决定要不要真解。
     *
     * fflate 0.8 的流式接口是 `file.start()` + `file.ondata`，
     * **没有 `file.decompress()`**（那是旧版文档里的名字）。
     */
    extractor.onfile = (file) => {
      if (settled) return;
      entries += 1;
      if (entries > MAX_ENTRIES) {
        stop({ ok: false, reason: `压缩包条目数超过 ${MAX_ENTRIES}` });
        return;
      }
      if (file.name === undefined || !ALLOWED_EXT.test(file.name)) return;
      const declared = file.originalSize ?? file.size ?? 0;
      if (declared > MAX_ENTRY_BYTES) {
        stop({ ok: false, reason: `${file.name} 解压后超过 ${MAX_ENTRY_BYTES} 字节` });
        return;
      }
      if (total + declared > MAX_UNCOMPRESSED_BYTES) {
        stop({ ok: false, reason: `包内容合计超过 ${MAX_UNCOMPRESSED_BYTES} 字节` });
        return;
      }
      if (files.size >= MAX_PACK_FILES) {
        stop({ ok: false, reason: `可加载的文件数超过 ${MAX_PACK_FILES}` });
        return;
      }

      const chunks = [];
      let seen = 0;
      file.ondata = (error, chunk, final) => {
        if (settled) return;
        if (error) {
          stop({ ok: false, reason: `解压失败（${file.name}）：${error?.message ?? String(error)}` });
          return;
        }
        const size = chunk?.byteLength ?? 0;
        seen += size;
        total += size;
        // 头部也可以吹小（声明 1KB、实际 100MB），所以边解边算总账，不等解完
        if (seen > MAX_ENTRY_BYTES || total > MAX_UNCOMPRESSED_BYTES) {
          stop({ ok: false, reason: `${file.name} 实际解压超过上限（zip bomb 防护）` });
          return;
        }
        if (size > 0) chunks.push(chunk);
        if (final) files.set(file.name, decoder.decode(concat(chunks, seen)));
      };
      try {
        file.start();
      } catch (error) {
        stop({ ok: false, reason: `${file.name} 无法解压：${error?.message ?? String(error)}` });
      }
    };

    extractor.push(bytes, true);
    // push(final) 之后 fflate 仍可能排了微任务；收尾也放微任务，保证顺序
    queueMicrotask(() => finish());
  });
}
