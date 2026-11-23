import test from 'node:test';
import assert from 'node:assert/strict';
import { dockBounds, dockSide } from '../../electron/monitor-dock.js';

const area = { x: 0, y: 25, width: 1920, height: 1055 };

test('a monitor detached from the right panel opens against the right side of the main window, as high as it', () => {
  assert.deepEqual(dockBounds({ x: 100, y: 60, width: 960, height: 720 }, 'right', area, 480), { x: 1060, y: 60, width: 480, height: 720 });
});

test('from the left panel it opens against the left side', () => {
  assert.deepEqual(dockBounds({ x: 700, y: 60, width: 960, height: 720 }, 'left', area, 480), { x: 220, y: 60, width: 480, height: 720 });
});

test('what would go over the edge of the display is moved back against that edge', () => {
  assert.equal(dockBounds({ x: 1200, y: 60, width: 960, height: 720 }, 'right', area, 480).x, 1440); // 1920 - 480
  assert.equal(dockBounds({ x: 100, y: 60, width: 960, height: 720 }, 'left', area, 480).x, 0);
  assert.equal(dockBounds({ x: 100, y: -40, width: 960, height: 720 }, 'right', area, 480).y, 25); // above the work area
  assert.equal(dockBounds({ x: 100, y: 700, width: 960, height: 720 }, 'right', area, 480).y, 360); // 25 + 1055 - 720: below it
});

test('a main window higher than the display gives a monitor as high as the display', () => {
  const r = dockBounds({ x: 0, y: 0, width: 960, height: 1400 }, 'right', area, 480);
  assert.deepEqual([r.y, r.height], [25, 1055]);
});

test('only left and right name a side', () => {
  assert.deepEqual(['left', 'right', 'up', undefined, null, 5].map(dockSide), ['left', 'right', null, null, null, null]);
});
