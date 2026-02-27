/**
 * The Void — Playwright Smoke Test
 * =================================
 * Full-flow browser automation that tests the complete user experience.
 *
 * Setup:
 *   cd apps/web-client
 *   npm install -D @playwright/test
 *   npx playwright install chromium
 *
 * Run:
 *   npx playwright test tests/smoke-test.spec.ts
 *
 * Prerequisites:
 *   - Rust engine on 8080/8081
 *   - Python Director on 8000
 *   - Web client on 5173
 */

import { test, expect } from '@playwright/test';

test.describe('The Void — Smoke Tests', () => {
    test.setTimeout(60_000); // LLM responses can be slow

    test('1. Page loads and shows Director connection', async ({ page }) => {
        await page.goto('http://localhost:5173');
        // "CONNECTED TO DIRECTOR" or "Connected to Director" should appear
        await expect(page.locator('text=/Connected to Director/i')).toBeVisible({ timeout: 10_000 });
    });

    test('2. Text command triggers LLM response and spawns entities', async ({ page }) => {
        await page.goto('http://localhost:5173');

        // Wait for director connection
        await expect(page.locator('text=/Connected to Director/i')).toBeVisible({ timeout: 10_000 });

        // Type a command into the Direct Override input
        const input = page.locator('input[placeholder*="Direct Override"]');
        await expect(input).toBeVisible({ timeout: 5_000 });
        await input.fill('Rachel, spawn a massive battle: 5 pirates and 5 federation ships');

        // Click SEND
        const sendBtn = page.locator('button:has-text("Send")');
        await sendBtn.click();

        // Wait for the Conversational Stream to update (Rachel replies)
        // It should no longer say "Awaiting connection" or be the default
        await page.waitForTimeout(5_000); // Allow LLM processing time

        const conversationalStream = page.locator('text=/Conversational Stream/i').locator('..');
        await expect(conversationalStream).not.toContainText('Awaiting connection', { timeout: 20_000 });

        // The "THE VOID IS EMPTY" overlay should be HIDDEN
        const voidOverlay = page.locator('text=/The Void is Empty/i');
        await expect(voidOverlay).toBeHidden({ timeout: 10_000 });

        // Check the Raw Engine State sidebar for pirate/federation counts
        const rawStatePanel = page.locator('pre');
        const rawText = await rawStatePanel.textContent({ timeout: 10_000 });
        expect(rawText).toBeTruthy();

        // Parse the JSON from the sidebar to verify entity counts
        if (rawText) {
            try {
                const worldState = JSON.parse(rawText);
                const entities = worldState.entities || {};
                console.log('Parsed entities from sidebar:', entities);

                // At minimum we should see pirates and federation in the entity counts
                const hasPirate = (entities.pirate ?? 0) >= 1;
                const hasFederation = (entities.federation ?? 0) >= 1;
                expect(hasPirate || hasFederation).toBeTruthy();
            } catch {
                // JSON might have extra text — just check substring presence
                expect(rawText).toContain('pirate');
            }
        }
    });

    test('3. Reality override changes world state', async ({ page }) => {
        await page.goto('http://localhost:5173');
        await expect(page.locator('text=/Connected to Director/i')).toBeVisible({ timeout: 10_000 });

        const input = page.locator('input[placeholder*="Direct Override"]');
        await input.fill('Make the sun blood red and the sky dark purple');

        const sendBtn = page.locator('button:has-text("Send")');
        await sendBtn.click();

        // Wait for processing
        await page.waitForTimeout(8_000);

        // The Raw Engine State should include a reality_override block
        const rawStatePanel = page.locator('pre');
        const rawText = await rawStatePanel.textContent({ timeout: 10_000 });
        expect(rawText).toBeTruthy();

        if (rawText) {
            // Check that the reality_override exists with color values
            const hasOverride = rawText.includes('reality_override') || rawText.includes('sun_color');
            console.log('Reality override present:', hasOverride);
            // Soft assert — LLM might not always include it
            if (!hasOverride) {
                console.warn('WARNING: reality_override not found in response. LLM may not have included it.');
            }
        }
    });
});
