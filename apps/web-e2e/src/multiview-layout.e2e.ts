import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures';
import { expectInside, expectNoOverlap } from './ui-consistency.fixture';
import {
    addXtreamPortal,
    interceptXtreamRequests,
    MOCK_SERVER,
} from './xtream-series-playback.fixture';

/**
 * The multiview screen and its entry button in the live channel sidebar,
 * at the window widths a tiling window manager produces. The streams are
 * refused: layout does not depend on playback, and a failed tile still
 * shows its bar and notice.
 */

const WIDTHS = [660, 780, 860, 960, 1280];

test.beforeEach(async ({ page }) => {
    await page.route('https://**', (route) => route.abort());
    await interceptXtreamRequests(page);
    await page.route(`${MOCK_SERVER}/live/**`, (route) =>
        route.fulfill({ status: 503, body: 'Synthetic unavailable stream' })
    );
    await page.goto('/');
    await addXtreamPortal(page, { name: 'Multiview Layout Portal' });
});

async function boxOf(locator: Locator) {
    const box = await locator.boundingBox();
    expect(box, 'expected a layout box').not.toBeNull();
    return box as NonNullable<typeof box>;
}

function playlistPathOf(url: string): string {
    return new URL(url).pathname.replace(/\/(live|series|vod).*$/, '');
}

test('@ui @xtream multiview header and tiles stay inside a narrow pane', async ({
    page,
}) => {
    test.setTimeout(90_000);
    const playlistPath = playlistPathOf(page.url());
    // Two stream ids from the mock's first live category; the multiview
    // restores its tiles from this key.
    await page.evaluate(
        (key) => localStorage.setItem(key, JSON.stringify([10000, 10001])),
        `iptvnator-multiview-channels:${playlistPath.split('/').pop()}`
    );
    await page.goto(`${playlistPath}/live/multiview`);
    const header = page.locator('.multiview__header');
    const tiles = page.locator('app-multiview-tile');
    await expect(tiles).toHaveCount(2);

    for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        const label = `multiview ${width}px`;
        const controls = [
            header.locator('.multiview__back'),
            header.locator('.multiview__title'),
            header.locator('.multiview__mode'),
            header.locator('[data-test-id="multiview-layouts"]'),
            header.locator('.multiview__add'),
        ];
        await expectInside(
            header,
            header.locator(
                '.multiview__back, .multiview__title, .multiview__mode, [data-test-id="multiview-layouts"], .multiview__add'
            ),
            label
        );
        await expectNoOverlap(controls, label);
        // One line: wrapped, the pill grew taller than the header row.
        const mode = await boxOf(header.locator('.multiview__mode'));
        expect.soft(mode.height, `${label}: mode pill`).toBeLessThan(32);

        const grid = await boxOf(
            page.locator('[data-test-id="multiview-grid"]')
        );
        const first = await boxOf(tiles.nth(0));
        const second = await boxOf(tiles.nth(1));
        // A pane taller than wide stacks the two tiles.
        const stacked = second.y >= first.y + first.height - 1;
        expect
            .soft(stacked, `${label}: tiles stacked in a tall pane`)
            .toBe(grid.height > grid.width);
        for (const [index, tile] of [first, second].entries()) {
            expect
                .soft(tile.width, `${label}: tile ${index} width`)
                .toBeGreaterThan(160);
        }

        // The focused tile shows its bar; both actions stay on the tile.
        await expectInside(
            tiles.nth(0),
            tiles.nth(0).locator('.multiview-tile__action'),
            `${label} tile bar`
        );
    }

    // A hidden bar's buttons take no pointer: the second tile is neither
    // hovered nor focused.
    await page.mouse.move(1, 899);
    const remove = tiles
        .nth(1)
        .locator('[data-test-id="multiview-tile-remove"]');
    await expect(remove).toHaveCSS('pointer-events', 'none');
    await tiles.nth(1).hover();
    await expect(remove).toHaveCSS('pointer-events', 'auto');
});

test('@ui @xtream live sidebar header keeps the multiview button clickable and inside at its minimum width', async ({
    page,
}) => {
    const playlistPath = playlistPathOf(page.url());
    await page.evaluate(() =>
        localStorage.setItem('live-channels-sidebar-width', '250')
    );
    await page.goto(`${playlistPath}/live`);
    await page.locator('.context-panel .category-item').first().click();
    // Folding the category rail turns the title into a dropdown and adds
    // a "show categories" button: the fullest the header gets.
    await page.locator('[data-test-id="context-hide-categories"]').click();
    const header = page.locator('app-live-stream-layout .sidebar-header');
    await expect(
        header.locator('[data-test-id="live-category-dropdown"]')
    ).toBeVisible();

    for (const width of [860, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const label = `live sidebar ${width}px`;
        const entry = header.locator('[data-test-id="open-multiview"]');
        await expectInside(
            header,
            header.locator('button, app-multiview-entry-button'),
            label
        );
        await expectNoOverlap(
            [
                header.locator('.sidebar-show-categories'),
                header.locator('.category-dropdown'),
                entry,
            ],
            label
        );
        // The header is a window-drag region in Electron: the button must
        // opt out or a click there moves the window.
        expect(
            await entry.evaluate((element) =>
                getComputedStyle(element).getPropertyValue('app-region')
            )
        ).toBe('no-drag');
        const title = await header
            .locator('.category-dropdown .category-title')
            .boundingBox();
        expect
            .soft(title?.width ?? 0, `${label}: category title`)
            .toBeGreaterThan(24);
    }

    await header.locator('[data-test-id="open-multiview"]').click();
    await expect(page).toHaveURL(/\/live\/multiview$/);
});

test('@ui @xtream multiview saves, switches, renames and deletes named layouts', async ({
    page,
}) => {
    test.setTimeout(90_000);
    const playlistPath = playlistPathOf(page.url());
    const playlistId = playlistPath.split('/').pop();
    // A layout with a channel the playlist no longer has (99999999).
    await page.evaluate(
        ({ channelsKey, layoutsKey }) => {
            localStorage.setItem(channelsKey, JSON.stringify([10000, 10001]));
            localStorage.setItem(
                layoutsKey,
                JSON.stringify([
                    { name: 'Stale', xtreamIds: [10002, 99999999] },
                ])
            );
        },
        {
            channelsKey: `iptvnator-multiview-channels:${playlistId}`,
            layoutsKey: `iptvnator-multiview-layouts:${playlistId}`,
        }
    );
    await page.goto(`${playlistPath}/live/multiview`);
    const tiles = page.locator('app-multiview-tile');
    await expect(tiles).toHaveCount(2);

    const openMenu = () =>
        page.locator('[data-test-id="multiview-layouts"]').click();

    // Save the two tiles under a name.
    await openMenu();
    await page.locator('[data-test-id="multiview-layout-save"]').click();
    await page.locator('[data-test-id="multiview-layout-name"]').fill('Pair');
    await page.locator('[data-test-id="multiview-layout-name-submit"]').click();

    // Switching to the stale layout skips the missing channel and says so.
    await openMenu();
    await page
        .locator('[data-test-id="multiview-layout-apply"]', { hasText: 'Stale' })
        .click();
    await expect(tiles).toHaveCount(1);
    await expect(page.locator('mat-snack-bar-container')).toContainText(
        'no longer in this playlist'
    );

    // One click brings the saved pair back, marked as current.
    await openMenu();
    await page
        .locator('[data-test-id="multiview-layout-apply"]', { hasText: 'Pair' })
        .click();
    await expect(tiles).toHaveCount(2);
    await openMenu();
    await expect(
        page.locator('[data-test-id="multiview-layout-apply"]', {
            hasText: 'Pair',
        })
    ).toHaveAttribute('aria-current', 'true');

    // Rename, then delete.
    await page.locator('[data-test-id="multiview-layout-rename-menu"]').click();
    await page
        .locator('[data-test-id="multiview-layout-rename"]', { hasText: 'Pair' })
        .click();
    const nameField = page.locator('[data-test-id="multiview-layout-name"]');
    await expect(nameField).toHaveValue('Pair');
    await nameField.fill('Duo');
    await page.locator('[data-test-id="multiview-layout-name-submit"]').click();
    await openMenu();
    await page.locator('[data-test-id="multiview-layout-delete-menu"]').click();
    await page
        .locator('[data-test-id="multiview-layout-delete"]', { hasText: 'Duo' })
        .click();
    await page.getByRole('button', { name: 'Delete' }).last().click();

    await expect
        .poll(() =>
            page.evaluate(
                (key) => JSON.parse(localStorage.getItem(key) ?? '[]'),
                `iptvnator-multiview-layouts:${playlistId}`
            )
        )
        .toEqual([{ name: 'Stale', xtreamIds: [10002, 99999999] }]);
    // The last-used tiles are still what reopening restores.
    await page.reload();
    await expect(tiles).toHaveCount(2);
});
