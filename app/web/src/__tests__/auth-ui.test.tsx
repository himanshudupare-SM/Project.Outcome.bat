import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Login } from '../routes/Login.js';

/**
 * Sign-in and sign-up. Server-side validation errors have to land on the
 * right field, a wrong password must not say which half was wrong, and a
 * failure must never leave the user on a spinner.
 */

const ME = { user: { id: 'u1', name: 'Dana', email: 'dana@example.com' }, orgs: [{ slug: 'northwind', name: 'Northwind', role: 'owner' }] };

let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(respond(200, ME));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderAuth(mode: 'login' | 'signup', initial = `/${mode}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const seen: string[] = [];
  function Landing({ label }: { label: string }): JSX.Element {
    seen.push(label);
    return <div>{label}</div>;
  }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<Login mode="login" />} />
          <Route path="/signup" element={<Login mode="signup" />} />
          <Route path="/o/:orgSlug" element={<Landing label="org home" />} />
          <Route path="/onboarding" element={<Landing label="onboarding" />} />
          <Route path="/invite/:token" element={<Landing label="invite" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, seen };
}

describe('sign in', () => {
  it('sends the credentials and lands in the first org', async () => {
    const { client, seen } = renderAuth('login');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'demo-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(seen).toContain('org home'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'dana@example.com', password: 'demo-password-123' });
    // The session is primed so the shell does not flash a login screen.
    expect(client.getQueryData(['me'])).toEqual(ME);
  });

  it('never puts the password in the URL or a GET', async () => {
    renderAuth('login');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'demo-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).not.toContain('demo-password-123');
  });

  it('shows a generic failure that does not say which field was wrong', async () => {
    fetchMock.mockResolvedValue(
      respond(401, { type: 'invalid_credentials', title: 'Invalid credentials', status: 401, detail: 'Email or password is incorrect.' }),
    );
    renderAuth('login');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email or password is incorrect.');
    // No per-field hint that would confirm the account exists.
    expect(alert.textContent).not.toMatch(/no such (account|user)/i);
  });

  it('re-enables the button after a failure so the user can retry', async () => {
    fetchMock.mockResolvedValue(respond(401, { type: 'invalid_credentials', title: 'Invalid credentials', status: 401 }));
    renderAuth('login');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
  });

  it('reports a lost connection instead of failing silently', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAuth('login');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'demo-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/check your connection/i);
  });

  it('surfaces a rate-limit message rather than looking broken', async () => {
    fetchMock.mockResolvedValue(
      respond(429, { type: 'too_many_attempts', title: 'Too many attempts', status: 429, detail: 'Too many attempts. Try again in 15 minutes.' }),
    );
    renderAuth('login');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Try again in 15 minutes/);
  });

  it('carries an invite through the sign-in', async () => {
    const { seen } = renderAuth('login', '/login?invite=inv-token-1');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'demo-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(seen).toContain('invite'));
  });
});

describe('sign up', () => {
  it('asks for a name and states the password rule up front', () => {
    renderAuth('signup');
    expect(screen.getByLabelText(/Your name/)).toBeInTheDocument();
    expect(screen.getByText('At least 10 characters.')).toBeInTheDocument();
  });

  it('puts each server validation error on its own field', async () => {
    fetchMock.mockResolvedValue(
      respond(400, {
        type: 'validation_error',
        title: 'Invalid request',
        status: 400,
        fields: { email: 'Enter a valid email address.', password: 'Use at least 10 characters.' },
      }),
    );
    renderAuth('signup');
    await userEvent.type(screen.getByLabelText(/Your name/), 'Dana');
    await userEvent.type(screen.getByLabelText(/Email/), 'not-an-email');
    await userEvent.type(screen.getByLabelText(/Password/), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await screen.findByText('Enter a valid email address.');
    expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument();
    // Field-level errors replace the form banner rather than duplicating it.
    // (Each field error is itself an alert, so look for the banner directly.)
    expect(document.querySelector('.alert-error')).toBeNull();
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears previous field errors on the next attempt', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(400, { type: 'validation_error', title: 'Invalid request', status: 400, fields: { email: 'Enter a valid email address.' } }),
    );
    const { seen } = renderAuth('signup');
    await userEvent.type(screen.getByLabelText(/Your name/), 'Dana');
    await userEvent.type(screen.getByLabelText(/Email/), 'nope');
    await userEvent.type(screen.getByLabelText(/Password/), 'demo-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('Enter a valid email address.');

    fetchMock.mockResolvedValue(respond(200, ME));
    await userEvent.type(screen.getByLabelText(/Email/), '@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(seen).toContain('org home'));
  });

  it('sends a new account to onboarding, not to a missing org', async () => {
    fetchMock.mockResolvedValue(respond(200, { ...ME, orgs: [] }));
    const { seen } = renderAuth('signup');
    await userEvent.type(screen.getByLabelText(/Your name/), 'Dana');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'demo-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(seen).toContain('onboarding'));
  });

  it('reports an already-registered email without leaking more', async () => {
    fetchMock.mockResolvedValue(
      respond(409, { type: 'email_taken', title: 'Email already registered', status: 409, detail: 'That email is already registered. Try signing in.' }),
    );
    renderAuth('signup');
    await userEvent.type(screen.getByLabelText(/Your name/), 'Dana');
    await userEvent.type(screen.getByLabelText(/Email/), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'demo-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already registered/);
  });
});
