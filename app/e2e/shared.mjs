import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

/**
 * Shared setup for the end-to-end runs. Everything is overridable by
 * environment variable so the same scripts work locally, against a dev
 * container, and in CI.
 */
export const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
export const USER = process.env.E2E_EMAIL ?? 'dana@example.com';
export const PASSWORD = process.env.E2E_PASSWORD ?? 'demo-password-123';
export const ORG = process.env.E2E_ORG ?? 'northwind';
export const OUT = process.env.E2E_ARTIFACTS ?? new URL('./artifacts', import.meta.url).pathname;

mkdirSync(OUT, { recursive: true });

/**
 * Chromium is preinstalled in the dev image; CHROMIUM_PATH overrides it.
 * Without an explicit path playwright-core looks in its own download cache,
 * which we deliberately do not populate.
 */
export async function launch() {
  const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  return chromium.launch({ executablePath });
}

/** Collects page-level failures so a passing assertion cannot hide a 500. */
export function watchForFailures(page, sink) {
  page.on('pageerror', (e) => sink.push(`pageerror: ${e}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.status() !== 401) sink.push(`http ${r.status()} ${r.url()}`);
  });
}

export async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(USER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`/o/${ORG}`), { timeout: 20000 });
}
