// @vitest-environment jsdom
/**
 * 地图视图数学（缩放对焦 / 拖拽坐标空间 / 钳制）。
 *
 * 这一组测试守的是一个"能跑但手感是坏的"缺陷：滚轮缩放时 offset 一点不补，
 * 而变换是 `p → o + z·p` ⇒ 缩放原点在 viewBox 左上角，一放大整张图就朝左上挤。
 * 这类 bug 不会报错、不会溢出，ui:audit 也量不到 —— 只能拿"锚点在屏幕上不动"
 * 这条不变量去断言。
 */

import { describe, expect, it } from 'vitest';
import {
  centerAnchor,
  clampView,
  clampZoom,
  clientToUser,
  contentSize,
  createViewState,
  resetView,
  userScalePerPx,
  zoomAt,
} from '../../src/ui/map/viewState.js';
import { ZOOM_MAX, ZOOM_MIN } from '../../src/core/constants.js';

/** 变换本身：`p → o + z·p`（p 是内容/user 坐标，o 是 offset，z 是 zoom）。 */
const screenOf = (view, p) => ({
  x: view.offsetX + view.zoom * p.x,
  y: view.offsetY + view.zoom * p.y,
});
/**
 * 锚点 a 是**画布坐标**（光标落在画面上的哪），不是内容坐标。
 * 所以“锚点不动”这条不变量要这样写：先算出此刻坐在 a 下面的那个内容点 p，
 * 缩放后再看 p 是否还在 a 上。拿 a 直接当 p 去算会得出“公式错了”的假结论
 * （第一版测试就踩了这个，只有 offset=0 时两种解释才重合）。
 */
const contentUnder = (view, a) => ({
  x: (a.x - view.offsetX) / view.zoom,
  y: (a.y - view.offsetY) / view.zoom,
});

describe('zoomAt：锚点在屏幕上不动', () => {
  it('以光标（任意画布点）为锚时，缩放前后“坐在光标下面那个节点”还在光标下', () => {
    const view = createViewState();
    view.zoom = 1;
    view.offsetX = -30;
    view.offsetY = 12;
    const anchor = { x: 400, y: 250 };
    const p = contentUnder(view, anchor);

    zoomAt(view, 1.1, anchor.x, anchor.y);
    const after = screenOf(view, p);

    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
    expect(view.zoom).toBeCloseTo(1.1, 6);
  });

  it('连续放大 20 次后锚点仍然不动（累积误差要收得住）', () => {
    const view = createViewState();
    view.offsetX = -64;
    view.offsetY = 21;
    const anchor = { x: 123, y: 456 };
    const p = contentUnder(view, anchor);
    for (let i = 0; i < 20; i += 1) zoomAt(view, 1.1, anchor.x, anchor.y);
    const after = screenOf(view, p);
    expect(view.zoom).toBe(ZOOM_MAX); // 到顶后停住，停住也不能把锚点推走
    expect(after.x).toBeCloseTo(anchor.x, 1);
    expect(after.y).toBeCloseTo(anchor.y, 1);
  });

  it('锚点取视口中心时，等于参考项目那条公式 tx = w/2 - (w/2 - tx)·ratio', () => {
    const width = 592;
    const height = 784;
    const view = createViewState();
    view.zoom = 0.8;
    view.offsetX = -77;
    view.offsetY = 45;
    const old = view.zoom;
    const factor = 1.1;
    const next = clampZoom(old * factor);
    const ratio = next / old;

    zoomAt(view, factor, width / 2, height / 2);
    expect(view.offsetX).toBeCloseTo(width / 2 - (width / 2 - -77) * ratio, 10);
    expect(view.offsetY).toBeCloseTo(height / 2 - (height / 2 - 45) * ratio, 10);
  });

  it('拿不到锚点（NaN）时只改 zoom，不写出 NaN offset', () => {
    const view = createViewState();
    view.offsetX = 5;
    view.offsetY = 7;
    zoomAt(view, 1.2, NaN, undefined);
    expect(Number.isFinite(view.offsetX)).toBe(true);
    expect(view.offsetX).toBe(5);
    expect(view.zoom).toBeCloseTo(1.2, 6);
  });

  it('缩到边界外会夹住，且夹住后锚点不被推走', () => {
    const view = createViewState();
    view.zoom = ZOOM_MIN;
    view.offsetX = -18;
    const anchor = { x: 100, y: 100 };
    const p = contentUnder(view, anchor);
    zoomAt(view, 1 / 1.1, anchor.x, anchor.y);
    expect(view.zoom).toBe(ZOOM_MIN);
    const after = screenOf(view, p);
    expect(after.x).toBeCloseTo(anchor.x, 6);
  });
});

describe('clampView：不许把地图拖进虚空', () => {
  it('内容比视口小时居中（小图停在角落看着像"地图丢了"）', () => {
    const view = createViewState();
    view.zoom = 0.5; // 内容 592×784 缩到 296×392，比视口小
    view.offsetX = -200;
    view.offsetY = -300;
    clampView(view, 592, 784);
    expect(view.offsetX).toBeCloseTo((592 - 296) / 2, 6);
    expect(view.offsetY).toBeCloseTo((784 - 392) / 2, 6);
  });

  it('内容比视口大时，最多拖到边缘对齐（不许露出空白边）', () => {
    const view = createViewState();
    view.zoom = 2;
    view.offsetX = 999;
    clampView(view, 592, 784);
    expect(view.offsetX).toBe(0); // 左边缘贴住
    view.offsetX = -9999;
    clampView(view, 592, 784);
    expect(view.offsetX).toBe(592 - 1184); // 右边缘贴住
  });

  it('拿不到内容尺寸时原样返回（jsdom 没有 viewBox.baseVal 也不能炸）', () => {
    const view = createViewState();
    view.offsetX = -1234;
    clampView(view, NaN, undefined);
    expect(view.offsetX).toBe(-1234);
  });
});

describe('坐标空间换算：拿不到就退回中心/像素，绝不假装换算成功', () => {
  it('没有 getScreenCTM 的 svg：clientToUser / userScalePerPx 都返回 null', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    expect(clientToUser(svg, 10, 20)).toBeNull();
    expect(userScalePerPx(svg)).toBeNull();
  });

  it('contentSize 读不到 viewBox 时返回 null，centerAnchor 随之给 null 锚点', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    expect(contentSize(svg)).toBeNull();
    expect(centerAnchor(svg)).toEqual({ x: null, y: null });
  });

  it('伪造一个带 CTM 的 svg：像素位移按 1/ctm.a 换算成 user 位移', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    // viewBox 592 宽渲染成 888px ⇒ 1 user = 1.5 CSS px，拖拽必须除回去
    svg.getScreenCTM = () => ({ a: 1.5, d: 1.5, inverse: () => ({}) });
    expect(userScalePerPx(svg)).toEqual({ sx: 1 / 1.5, sy: 1 / 1.5 });
  });

  it('CTM 退化（a=0）时不返回 Infinity，而是 null', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.getScreenCTM = () => ({ a: 0, d: 0 });
    expect(userScalePerPx(svg)).toBeNull();
  });
});

describe('视图状态仍是"可丢弃"的（裁决 5）', () => {
  it('resetView 把三个量归零，缩放/钳制都不影响它', () => {
    const view = createViewState();
    zoomAt(view, 1.5, 100, 100);
    clampView(view, 592, 784);
    resetView(view);
    expect(view).toMatchObject({ offsetX: 0, offsetY: 0, zoom: 1 });
  });

  it('视图对象里没有函数与不可克隆成员（快照要能被 deepClone）', () => {
    const view = createViewState();
    for (const value of Object.values(view)) {
      expect(['number', 'boolean']).toContain(typeof value);
    }
  });
});
