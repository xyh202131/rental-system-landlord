import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const project = join(import.meta.dirname, '../..');
const assetsReady = existsSync(join(project, 'outputs/aholo/3FO4K4VCF7LG/meeting-room.spz')) && existsSync(join(project, '.data/furniture/plant.glb'));
const action = (page, name) => page.locator(`[data-action="${name}"]`);
const command = (page, name) => page.locator(`[data-furnishing-command="${name}"]`);
async function login(page) {
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-only-123');
  await page.getByRole('button', { name: '登录并继续' }).click();
  await expect(page.locator('.home-hero')).toBeVisible();
}
async function openRoom(page) {
  await action(page, 'sample').first().click();
  await expect(action(page, 'furnishing').filter({ hasText: '送入本地试摆' })).toBeVisible();
  await action(page, 'furnishing').filter({ hasText: '送入本地试摆' }).click();
  await expect(page.locator('#furnishing-viewer-status')).toContainText('房间已载入', { timeout: 40000 });
}

test('local room furnishing: add, adjust, save and reload a layout without generation requests', async ({ page }, testInfo) => {
  test.skip(!assetsReady, 'Local meeting-room SPZ and furniture GLB fixtures are not prepared.');
  test.setTimeout(120000);
  const errors = [], consoleErrors = [], warnings = [], generationRequests = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('request', request => { if (request.method() === 'POST' && /\/jobs|\/generate|\/api\/world/.test(request.url())) generationRequests.push(request.url()); });
  await login(page);
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); if (message.type() === 'warning') warnings.push(message.text()); });
  await openRoom(page);
  await expect(page.locator('.stepper')).toHaveCount(0);
  await expect(page.locator('#furnishing-source')).toHaveText('内置样例');
  await expect(page.locator('#furnishing-xray')).toBeChecked();
  await page.locator('[data-furnishing-command="add"][data-asset="plant"]').click();
  await expect(page.locator('#furnishing-count')).toHaveText('1', { timeout: 25000 });
  await command(page, 'focus').click();
  await expect(page.locator('#furnishing-viewer-status')).toContainText('已聚焦');
  const previousX = await page.locator('#furnishing-x').inputValue();
  await command(page, 'place').click();
  await page.locator('#furnishing-xray').uncheck();
  await expect(page.locator('#furnishing-visibility-hint')).toContainText('已关闭');
  await page.locator('#furnishing-xray').check();
  const canvas = page.locator('#furnishing-viewer canvas');
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width * .6, y: box.height * .65 } });
  await expect(page.locator('#furnishing-x')).not.toHaveValue(previousX);
  await command(page, 'place').click();
  await page.locator('#furnishing-x').fill('0.75');
  await page.locator('#furnishing-rotation').evaluate(input => { input.value = '35'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#furnishing-scale').evaluate(input => { input.value = '1.4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#layout-save-status')).toContainText('未保存');
  await command(page, 'focus').click();
  await expect(page.locator('#furnishing-viewer-status')).toContainText('已聚焦');
  await page.screenshot({ path: testInfo.outputPath('desktop-furniture.png'), fullPage: true });
  await command(page, 'save').click();
  await expect(page.locator('#layout-save-status')).toHaveText('布局已保存到本机');
  const roomId = await page.locator('#furnishing-room').inputValue();
  await page.reload();
  await expect(page.locator('#furnishing-viewer-status')).toContainText('房间已载入', { timeout: 40000 });
  await expect(page.locator('#furnishing-count')).toHaveText('1');
  await expect(page.locator('#furnishing-x')).toHaveValue('0.75');
  await expect(page.locator('#furnishing-rotation')).toHaveValue('35');
  await expect(page.locator('#furnishing-scale')).toHaveValue('1.4');
  const alternate = await page.locator('#furnishing-room option').evaluateAll(options => options.map(o => o.value));
  if (alternate.length > 1) {
    await page.locator('#furnishing-room').selectOption(alternate.find(id => id !== roomId));
    await expect(page.locator('#furnishing-viewer-status')).toContainText('房间已载入', { timeout: 40000 });
    await expect(page.locator('#furnishing-count')).toHaveText('0');
    await page.locator('#furnishing-room').selectOption(roomId);
    await expect(page.locator('#furnishing-viewer-status')).toContainText('房间已载入', { timeout: 40000 });
    await expect(page.locator('#furnishing-count')).toHaveText('1');
  }
  await command(page, 'remove').click();
  page.once('dialog', dialog => dialog.dismiss());
  await action(page, 'home').first().click();
  await expect(page.locator('#furnishing-root')).toBeVisible();
  await command(page, 'save').click();
  await expect(page.locator('#layout-save-status')).toHaveText('布局已保存到本机');
  await expect(page.locator('#furnishing-count')).toHaveText('0');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/furnishing\/sample-/);
  await testInfo.attach('browser-health', { body: JSON.stringify({ title: await page.title(), errors, consoleErrors, warnings, generationRequests }), contentType: 'application/json' });
  expect(generationRequests).toEqual([]); expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
});

test('furnishing mobile entry and recoverable save failure preserve unsaved placement', async ({ page }, testInfo) => {
  test.skip(!assetsReady, 'Local meeting-room SPZ and furniture GLB fixtures are not prepared.');
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page); await openRoom(page);
  await page.locator('[data-furnishing-command="add"][data-asset="plant"]').click();
  await expect(page.locator('#furnishing-count')).toHaveText('1', { timeout: 25000 });
  await page.route('**/api/furnishing/rooms/*/layout', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：本地保存暂不可用' }) }));
  await command(page, 'save').click();
  await expect(page.locator('#furnishing-error')).toContainText('保存暂不可用');
  await expect(page.locator('#layout-save-status')).toContainText('未保存');
  await expect(page.locator('#furnishing-count')).toHaveText('1');
  await page.unroute('**/api/furnishing/rooms/*/layout');
  await command(page, 'save').click();
  await expect(page.locator('#layout-save-status')).toHaveText('布局已保存到本机');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-furniture.png'), fullPage: true });
});
