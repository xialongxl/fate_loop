/**
 * 样式覆盖守卫：JS/HTML 里写出来的 class，styles.css 必须得有规则。
 *
 * 为什么需要：本作排版靠类名驱动，一个没有规则的类**不会报错、不会变红**，
 * 只会安静地用默认样式渲染 —— "少写一条 CSS"表现为"这块看着就是不对"，
 * 通常要到肉眼 review 才发现。ui:audit 只抓零高度溢出那类极端症状，抓不到这个。
 * （本轮 .menu-prev / .transfer-bar / .seed-fingerprint 就是这么漏掉的。）
 *
 * 扫描口径：
 *  - class="..." / className="..." 里的**字面量** token
 *  - classList.add/toggle/remove/contains('x') 的字符串参数
 *  - 三元里的裸修饰类名（? 'is-xxx' : ''）
 *  带 ${...} 的动态名字无法静态验证：插值处换成哨兵，含哨兵的 token 丢弃
 *  （顺带排除 `q${n}` 剥完剩下的残片 `q` —— 那本来就不是类名）。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const CSS_PATH = fileURLToPath(new URL('../../src/ui/styles.css', import.meta.url));
const SENTINEL = '\u0000';

/**
 * 确认无需专属规则的修饰类（宿主元素的基类负责渲染，这里只作状态标记）：
 *  - is-buff / is-debuff —— buff 图标靠 .buff-icon 基类上色
 *  - is-selected —— 列表项选中态由 .bag-item.is-selected 这类复合规则覆盖
 */
const ALLOWLIST = new Set(['is-buff']);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (['.js', '.html'].includes(extname(full))) out.push(full);
  }
  return out;
}

function usedClasses() {
  const found = new Set();
  const literals = (raw) =>
    raw
      .split(/\s+/)
      .filter((token) => token && !token.includes(SENTINEL))
      .forEach((token) => found.add(token));

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8').replace(/\$\{[^}]*\}/g, SENTINEL);
    for (const m of text.matchAll(/\bclass(?:Name)?="([^"]*)"/g)) literals(m[1]);
    for (const m of text.matchAll(/\bclass(?:Name)?='([^']*)'/g)) literals(m[1]);
    for (const m of text.matchAll(/classList\.(?:add|toggle|remove|contains)\(\s*'([^']+)'/g)) found.add(m[1]);
    for (const m of text.matchAll(/\?\s*'((?:is-|has-)[a-z0-9-]+)'/g)) found.add(m[1]);
  }
  return [...found].sort();
}

function definedClasses(css) {
  const set = new Set();
  for (const m of css.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)) set.add(m[1]);
  return set;
}

describe('样式覆盖守卫', () => {
  const defined = definedClasses(readFileSync(CSS_PATH, 'utf8'));

  it('styles.css 里定义了很多类（防解析双双失效造成假绿）', () => {
    expect(defined.size).toBeGreaterThan(150);
  });

  it('确实扫到了足量类名（同上，双向防呆）', () => {
    expect(usedClasses().length).toBeGreaterThan(120);
  });

  it('JS/HTML 用到的每个类都在 styles.css 里有规则', () => {
    const missing = usedClasses().filter((cls) => !defined.has(cls) && !ALLOWLIST.has(cls));
    expect(
      missing,
        `这些类被写进了标记但 CSS 里没有规则，会以默认样式渲染：\n  ${missing.join('\n  ')}\n` +
        '补一条规则；确认无需样式时加进 ALLOWLIST 并写明为什么。',
    ).toEqual([]);
  });

  /**
   * 反向守卫：**同一个类不得在两个组件里各自定义布局（display）**。
   *
   * 这不是臆想的觊觎，是真实回归：P2 给熔炼面板写了 `.filter-row { display:grid
   *   + 62px 首列 }`，而序列屏与图鉴早就在用同名的 `.filter-row { display:flex
   *   + wrap }` —— 同名同特异度、背面的赢，于是技能库的流派 chips 被塞进
   *   一个“首列空着 62px”的两列网格里，第 7 个流派一来就折成 2×4。
   *   **它不溢出、不零高度、不遮字 —— ui:audit 量不到“没坏但塔了”。**
   *
   * 口径为什么这么窄（只抓“裸类名 + display + 跨文件”）：
   *  - 只看顶层规则：`@media` 里的覆盖是有意的
   *  - 跳过复合/伪类选择器：`.x:empty { display:none }` 是状态覆盖，不是第二份布局
   *  - 只报跨文件的：同一个组件里先定布局再改 display（如 .battle-stats ×4）
   *    今天就有 13 处，它们只有一个主人，不是本 bug 的形状——把它们一起报红
   *    只会让人把测试关掉。宁可窄而准。
   */
  it('同一个类不得在两个组件里各自定义 display（跨文件撞名）', () => {
    const css = stripMediaBlocks(readFileSync(CSS_PATH, 'utf8'));
    const definitions = new Map();
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\bdisplay\s*:/.test(body)) continue;
      if (/[:[>+~]/.test(selector)) continue; // 状态/复合选择器不算“第 N 份布局定义”
      for (const m of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)(?![\w-])/g)) {
        definitions.set(m[1], (definitions.get(m[1]) ?? 0) + 1);
      }
    }

    const owners = new Map();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bclass(?:Name)?="([^"]*)"/g)) {
        for (const cls of m[1].split(/\s+/)) {
          if (!cls || cls.includes(SENTINEL)) continue;
          if (!owners.has(cls)) owners.set(cls, new Set());
          owners.get(cls).add(file);
        }
      }
    }

    const collided = [...definitions]
      .filter(([cls, times]) => times > 1 && (owners.get(cls)?.size ?? 0) > 1)
      .map(([cls, times]) => {
        const where = [...(owners.get(cls) ?? [])].map((f) => f.slice(SRC.length + 1)).join('、');
        return `.${cls}：${times} 处裸定义 display，却用在 ${where}`;
      });

    expect(
      collided,
      `这些类被两个以上组件共用，而 CSS 里各自给了 display —— 后面的规则会静默改掉另一个的排版：\n  ${collided.join('\n  ')}\n` +
        '给其中一方换个带前缀的类名（别去调 grid 值 —— 撞名才是病根）。',
    ).toEqual([]);
  });
});

/** 剥掉 @media 块（里面的 display 覆盖是有意的响应式，不算撞名）。 */
function stripMediaBlocks(css) {
  let depth = 0;
  let out = '';
  for (let i = 0; i < css.length; i += 1) {
    if (css.startsWith('@media', i)) {
      depth += 1;
      i += 5;
      continue;
    }
    const ch = css[i];
    if (ch === '{') {
      if (depth > 0) continue;
    }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
    }
    if (depth === 0) out += ch;
  }
  return out;
}
