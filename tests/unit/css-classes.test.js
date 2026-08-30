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
});
