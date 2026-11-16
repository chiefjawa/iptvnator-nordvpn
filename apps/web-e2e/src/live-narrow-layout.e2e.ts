import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { expectInside } from './ui-consistency.fixture';
import {
    addXtreamPortal,
    interceptXtreamRequests,
    MOCK_SERVER,
} from './xtream-series-playback.fixture';

/**
 * Xtream live TV with a channel playing, at the widths a tiling window
 * manager produces. The categories rail (≈320px), the channels rail (≥250px)
 * and the player cannot all fit below ~950px: the panels fold on their own
 * so the player keeps at least 320px, without changing the stored panel
 * preference. Streams are refused; layout does not depend on playback.
 */

const PLAYER_MIN = 320;
const PREFERENCE_KEY = 'live-sidebar-state:portal';

test.beforeEach(async ({ page }) => {
    await page.route('https://**', (route) => route.abort());
    await interceptXtreamRequests(page);
    await page.route(`${MOCK_SERVER}/live/**`, (route) =>
        route.fulfill({ status: 503, body: 'Synthetic unavailable stream' })
    );
    await page.goto('/');
    await addXtreamPortal(page, { name: 'Narrow Live Portal' });
});

async function widthOf(locator: Locator): Promise<number> {
    return (await locator.boundingBox())?.width ?? 0;
}

async function openChannel(page: Page) {
    const playlistPath = new URL(page.url()).pathname.replace(
        /\/(live|series|vod).*$/,
        ''
    );
    await page.goto(`${playlistPath}/live`);
    await page.locator('.context-panel .category-item').first().click();
    await page
        .locator('app-live-stream-layout [data-test-id="channel-item"]')
        .first()
        .click();
    await expect(
        page.locator('app-live-stream-layout .content-container')
    ).toBeVisible();
}

const player = (page: Page) =>
    page.locator('app-live-stream-layout .content-container');
const categoriesRail = (page: Page) =>
    page.locator('app-workspace-shell-context-sidebar');

test('@ui @xtream live TV folds its panels to keep the player usable in narrow windows', async ({
    page,
}) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openChannel(page);
    expect(await widthOf(categoriesRail(page))).toBeGreaterThan(200);

    for (const width of [860, 780, 660]) {
        await page.setViewportSize({ width, height: 900 });
        const label = `live ${width}px`;
        await expect
            .poll(() => widthOf(player(page)), { message: `${label}: player` })
            .toBeGreaterThanOrEqual(PLAYER_MIN);
        // Everything in the player column, the guide's date stepper
        // included, stays inside the window.
        const stepper = page.locator(
            'app-live-stream-layout .epg-timeline__stepper'
        );
        if (await stepper.isVisible()) {
            const box = await stepper.boundingBox();
            expect
                .soft((box?.x ?? 0) + (box?.width ?? 0), `${label}: stepper`)
                .toBeLessThanOrEqual(width);
        }
    }
    // The fold was the width's doing, not a stored choice.
    expect(
        await page.evaluate((key) => localStorage.getItem(key), PREFERENCE_KEY)
    ).not.toBe('categories-hidden');

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
        .poll(() => widthOf(categoriesRail(page)))
        .toBeGreaterThan(200);
    await expect(
        page.locator('app-live-stream-layout .sidebar')
    ).not.toHaveClass(/sidebar-collapsed/);
});

test('@ui @xtream a panel choice made in a narrow window holds while narrow and leaves the preference', async ({
    page,
}) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 780, height: 900 });
    await openChannel(page);
    await expect.poll(() => widthOf(categoriesRail(page))).toBeLessThan(50);

    // Bring the categories back by hand: respected although the player
    // shrinks.
    await page
        .locator('app-live-stream-layout .sidebar-show-categories')
        .click();
    await expect
        .poll(() => widthOf(categoriesRail(page)))
        .toBeGreaterThan(200);
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(500);
    expect(await widthOf(categoriesRail(page))).toBeGreaterThan(200);

    // Hide everything by hand, then widen: the stored preference (never
    // written while narrow) comes back.
    await page.keyboard.press('Control+b');
    await expect(
        page.locator('app-live-stream-layout .sidebar')
    ).toHaveClass(/sidebar-collapsed/);
    expect(
        await page.evaluate((key) => localStorage.getItem(key), PREFERENCE_KEY)
    ).toBeNull();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
        .poll(() => widthOf(categoriesRail(page)))
        .toBeGreaterThan(200);
    await expect(
        page.locator('app-live-stream-layout .sidebar')
    ).not.toHaveClass(/sidebar-collapsed/);
});

test('@ui @xtream live TV header keeps a trailing button inside at phone widths', async ({
    page,
}) => {
    await openChannel(page);
    const header = page.locator('.workspace-header');
    // The desktop app's Downloads group (Electron only): the same box at
    // the end of the header — 49px wide, after the header gap.
    await header.evaluate((element) => {
        const stand_in = element.ownerDocument.createElement('div');
        stand_in.setAttribute('data-test-id', 'downloads-stand-in');
        stand_in.style.cssText =
            'flex: none; width: 49px; height: 40px; margin-left: auto;';
        element.appendChild(stand_in);
    });
    for (const width of [400, 385, 360, 340]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(200);
        await expectInside(
            header,
            header.locator(':scope > *'),
            `header ${width}px`
        );
    }
});
