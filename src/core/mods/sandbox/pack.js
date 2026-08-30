/**
 * 第三方包对象：`{ id, version, files: Map<路径, 文本>, entry }`
 *
 * 设计文档 §5 的落点。两个决定：
 *
 * 1. **包 = 虚拟文件系统，不是单个字符串**。zip、文件夹拖拽、单文件、粘贴四种
 *    投递方式最后都归到这个形状，沙箱只认它。多文件是硬需求（作者要能拆模块），
 *    所以入口协议就按 ESM 来，不搞"一个文件里塞多个模块"的方言。
 * 2. **内容寻址**。存档与指纹记的是 hash 而不是文件名 —— 文件名会重名、会被改，
 *    而"装过哪个字节序列的包"必须问得出唯一答案。
 */

export const MAX_PACK_FILES = 32;
export const MAX_PACK_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 128 * 1024;
export const DEFAULT_ENTRY = 'main.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// 只收文本文件；二进制素材（图片/音频）明确不支持 —— 本作是纯文字游戏，
// 收了只会让沙箱多一层 ArrayBuffer 边界，收益为零。
const ALLOWED_EXT = /\.(js|json|md|txt)$/i;

class PackError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'PackError';
    this.detail = detail;
  }
}

/**
 * 路径规范化。**必须**拦掉 `..`、绝对路径、盘符、反斜杠：沙箱的模块加载器
 * 拿路径当键，一旦允许逃逸，包就能引用宿主机上的其它内容（虽然读不到，
 * 但 `import('../evil.js')` 会变成"为什么我的包在本地能跑"这种玄学 bug）。
 */
export function normalizePackPath(raw) {
  if (typeof raw !== 'string' || raw === '') throw new PackError('路径必须是非空字符串', { raw });
  const unified = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^[a-zA-Z]:/.test(unified) || unified.startsWith('/')) {
    throw new PackError(`包内路径不能是绝对路径：${raw}`, { raw });
  }
  const parts = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new PackError(`包内路径不能包含 ..：${raw}`, { raw });
    parts.push(segment);
  }
  if (parts.length === 0) throw new PackError(`包内路径为空：${raw}`, { raw });
  return parts.join('/');
}

/**
 * @param {{id:string, version:string, files:Map<string,string>|Object<string,string>, entry?:string}} spec
 * @returns {Readonly<{id:string, version:string, entry:string, files:ReadonlyMap<string,string>, bytes:number}>}
 */
export function createPack(spec) {
  if (spec === null || typeof spec !== 'object') throw new PackError('包定义必须是个对象', { spec });
  const { id, version } = spec;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new PackError(`包 id 需要是 "作者.名字" 形式（小写字母/数字/._-，且至少一个点），实际：${String(id)}`, {
      id,
    });
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new PackError(`包 version 需要是 x.y.z 三段数字，实际：${String(version)}`, { version });
  }

  const rawFiles =
    spec.files instanceof Map ? spec.files : new Map(Object.entries(spec.files ?? {}));
  if (rawFiles.size === 0) throw new PackError('包里一个文件都没有', { id });
  if (rawFiles.size > MAX_PACK_FILES) {
    throw new PackError(`包最多 ${MAX_PACK_FILES} 个文件，实际 ${rawFiles.size}`, { id });
  }

  const files = new Map();
  let bytes = 0;
  for (const [rawPath, text] of rawFiles) {
    const path = normalizePackPath(rawPath);
    if (!ALLOWED_EXT.test(path)) {
      throw new PackError(`不支持的文件类型（只收 js/json/md/txt）：${path}`, { path });
    }
    if (typeof text !== 'string') {
      throw new PackError(`包文件必须是文本，${path} 是 ${typeof text}`, { path });
    }
    const size = text.length;
    if (size > MAX_FILE_BYTES) {
      throw new PackError(`单个文件超过 ${MAX_FILE_BYTES} 字符：${path}`, { path, size });
    }
    bytes += size;
    if (bytes > MAX_PACK_BYTES) {
      throw new PackError(`包总大小超过 ${MAX_PACK_BYTES} 字符`, { id, bytes });
    }
    if (files.has(path)) throw new PackError(`路径规范化后重名：${path}`, { path });
    files.set(path, text);
  }

  const entry = normalizePackPath(spec.entry ?? DEFAULT_ENTRY);
  if (!files.has(entry)) {
    throw new PackError(`入口文件不在包里：${entry}（包内文件：${[...files.keys()].join(', ')}）`, {
      entry,
    });
  }

  return Object.freeze({ id, version, entry, files: new Map(files), bytes });
}

/**
 * 从文件名推包身份：`poc.app@1.2.3.js` / `poc.app-1.2.3.js` / `poc.app.js`。
 *
 * 为什么允许推：玩家拿到的是一个文件，要求他先读源码再手填 id 是把人往回逼。
 * 但推出来的东西**必须显示在安装确认里** —— 静默改身份才是真坑。
 * 不合规字符直接换 `-`，并保证 `作者.名字` 至少一个点（ID_RE 的要求）。
 */
export function derivePackIdentity(fileName) {
  const base = String(fileName ?? '').replace(/\.[^.]*$/, '').trim();
  const withVersion = /^(.+)[@-](\d+\.\d+\.\d+)$/.exec(base);
  const rawId = withVersion === null ? base : withVersion[1];
  let id = rawId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  if (id === '') id = 'unnamed';
  if (!id.includes('.')) id = `local.${id}`;
  // 版本号缺省时是 0.0.0 —— 它不是装饰，是"装了哪一版"的记录起点
  return { id, version: withVersion === null ? '0.0.0' : withVersion[2] };
}

/** 单个 .js 文件 → 一个包。给"直接拖一个脚本进来"这条最短路径用。 */
export function packFromSingleFile(text, { id, version, fileName = DEFAULT_ENTRY } = {}) {
  return createPack({ id, version, files: new Map([[fileName, String(text ?? '')]]) });
}

/**
 * 规范化序列化：路径排序 + 定界符。
 * 为什么不含 mtime/文件名顺序以外的东西 —— 任何"打包时才知道的信息"都会让
 * 同一个包在不同机器上得到不同 hash，那存档比对就毫无意义。
 */
export function canonicalPackText(pack) {
  const lines = [`fate-loop-pack:${pack.id}:${pack.version}`, `entry:${pack.entry}`];
  for (const path of [...pack.files.keys()].sort()) {
    const text = pack.files.get(path);
    lines.push(`file:${path}:${text.length}`);
    lines.push(text);
  }
  return lines.join('\n');
}

async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** FNV-1a 64 位（用两个 32 位拼）。只用于拿不到 WebCrypto 的场合（老环境/测试）。 */
function fnv1aHex(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c >> 8) & 0xff), 0x811c9dc5) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

/**
 * 包内容哈希。
 *
 * ⚠️ 它是**内容校验**，不是安全边界：hash 由宿主算，作者想伪造只需要换个字节。
 * 真正的边界是沙箱本身（见设计文档 §5.5）。它解决的问题是"存档里那份进度是在
 * 哪个字节序列下写的"，所以唯一要求是：同内容同 hash、改一个字节就变。
 *
 * @returns {Promise<{algo:'sha256'|'fnv1a', hex:string}>}
 */
export async function hashPack(pack) {
  const canonical = canonicalPackText(pack);
  const sha = await sha256Hex(canonical);
  if (sha !== null) return { algo: 'sha256', hex: sha.slice(0, 16) };
  return { algo: 'fnv1a', hex: fnv1aHex(canonical) };
}
