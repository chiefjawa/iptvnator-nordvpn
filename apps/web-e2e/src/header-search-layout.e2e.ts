import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
    applyUiTheme,
    expectInside,
    expectNoOverlap,
} from './ui-consistency.fixture';
import {
    addXtreamPortal,
    interceptXtreamRequests,
} from './xtream-series-playback.fixture';

/**
 * Between the phone breakpoint (640px) and ~1000px the header search field
 * shrinks with the window, and a route's header buttons take more of it.
 * The input used to keep its intrinsic width, so the Ctrl+K badge was pushed
 * out of the field and painted under the keyboard-shortcuts button, and the
 * scope chip was squeezed to a sliver. Window widths a tiling window manager
 * produces (half of 1280/1366/1920 screens) all fall in this range.
 */

const WIDTHS = [660, 720, 780, 860, 960, 1000];

async function boxOf(locator: Locator) {
    const box = await locator.boundingBox();
    expect(box, 'expected a layout box').not.toBeNull();
    return box as NonNullable<typeof box>;
}

async function expectSearchFieldFits(page: Page, label: string) {
    const header = page.locator('app-workspace-shell-header');
    const field = header.locator('.search-field');
    await expect(field).toBeVisible();
    await expectInside(
        field,
        field.locator(
            'mat-icon:not(.command-trigger__icon), .search-chip, .search-chip__label, input, .command-trigger, .command-trigger__shortcut'
        ),
        label
    );
    await expectNoOverlap(
        [
            field.locator('.command-trigger__shortcut'),
            header.locator('.shortcuts-trigger'),
        ],
        `${label} badge vs shortcuts button`
    );
    await expectNoOverlap(
        [field, header.locator('.shortcuts-trigger')],
        `${label} field vs shortcuts button`
    );

    // The input stays usable; the chip either ellipsizes inside its own box
    // or gives way entirely.
    const input = await boxOf(field.locator('input'));
    expect.soft(input.width, `${label}: input width`).toBeGreaterThan(80);
    const chipLabel = field.locator('.search-chip--scope .search-chip__label');
    if (await chipLabel.isVisible()) {
        await expectInside(
            field.locator('.search-chip--scope'),
            chipLabel,
            `${label} chip`
        );
        const chipWidth = (await boxOf(chipLabel)).width;
        expect
            .soft(chipWidth, `${label}: chip keeps more than a letter`)
            .toBeGreaterThan(40);
    }
}

test.beforeEach(async ({ page }) => {
    await page.route('https://**', (route) => route.abort());
    await interceptXtreamRequests(page);
    await page.goto('/');
    await addXtreamPortal(page, { name: 'Header Layout Portal' });
});

test('@ui @xtream header search field keeps its contents inside at narrow desktop widths', async ({
    page,
}) => {
    test.setTimeout(90_000);
    const playlistPath = new URL(page.url()).pathname.replace(
        /\/(live|series|vod).*$/,
        ''
    );

    // Live with a category: a dismissible scope chip and the most header
    // buttons (sidebar toggle and the route's shortcut) leave the field
    // the least room.
    await page.goto(`${playlistPath}/live`);
    await page.locator('.context-panel .category-item').first().click();
    await expect(
        page.locator('[data-test-id="workspace-search-scope-clear"]')
    ).toBeAttached();
    for (const dark of [true, false]) {
        await applyUiTheme(page, dark);
        for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: 900 });
            await expectSearchFieldFits(page, `live ${width}px`);
        }
    }

    // Advanced search: the long static "Advanced search" chip.
    await page.goto(`${playlistPath}/search`);
    await expect(
        page.locator('app-workspace-shell-header .search-chip--scope')
    ).toBeAttached();
    for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await expectSearchFieldFits(page, `search ${width}px`);
    }
});
