import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Button, Dialog, EmptyState, ErrorState, Field, Pill, ToastProvider, formatDate, isOverdue, relativeTime, useToast } from '../ui/index.js';

/**
 * UI primitive behaviour and accessibility. These cover the pieces every
 * screen is built from, so a regression here is a regression everywhere.
 */

async function expectNoA11yViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    // Colour contrast cannot be evaluated in jsdom (no layout or paint).
    rules: { 'color-contrast': { enabled: false } },
  });
  const summary = results.violations
    .map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`)
    .join('\n');
  expect(summary, summary).toBe('');
}

describe('Button', () => {
  it('shows a spinner and blocks clicks while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Save/ });
    expect(button).toBeDisabled();
    await userEvent.click(button).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls its handler when idle', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Field', () => {
  it('links its label, hint and error to the control', () => {
    const { container } = render(
      <Field label="Email" hint="We never share it" required>
        {(props) => <input {...props} className="input" />}
      </Field>,
    );
    const input = screen.getByLabelText(/Email/);
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(container.querySelector('.field-hint')?.textContent).toBe('We never share it');
  });

  it('announces an error and marks the control invalid', async () => {
    const { container } = render(
      <Field label="Password" error="Use at least 10 characters">
        {(props) => <input {...props} type="password" className="input" />}
      </Field>,
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Use at least 10 characters');
    await expectNoA11yViolations(container);
  });
});

describe('Dialog', () => {
  it('is a modal with an accessible name, and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Dialog title="New project" onClose={onClose}>
        <input aria-label="Project name" />
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves focus into the dialog and keeps Tab inside it', async () => {
    render(
      <Dialog title="Focus test" onClose={() => undefined}>
        <input aria-label="First" />
        <input aria-label="Second" />
      </Dialog>,
    );
    await waitFor(() => expect(screen.getByLabelText('First')).toHaveFocus());

    // Tab from the last focusable element wraps back to the first.
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    await userEvent.tab();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('locks background scroll while open and restores it on unmount', () => {
    const { unmount } = render(
      <Dialog title="Scroll lock" onClose={() => undefined}>
        <p>body</p>
      </Dialog>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

describe('state components', () => {
  it('renders an empty state with a single primary action', async () => {
    const { container } = render(
      <EmptyState title="No projects yet" body="Create one to start." action={<Button>Create</Button>} />,
    );
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('offers a retry only when one is possible', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState message="Could not load" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(<ErrorState title="Admins only" message="Restricted." />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('toasts', () => {
  it('announces messages politely in a live region', async () => {
    function Trigger(): JSX.Element {
      const toast = useToast();
      return <Button onClick={() => toast.push('Blocker recorded', 'info')}>Notify</Button>;
    }
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Notify' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Blocker recorded');
  });
});

describe('formatting helpers', () => {
  it('formats a date without shifting it across timezones', () => {
    // A UTC date must not become the previous day for a negative-offset user.
    expect(formatDate('2026-09-02')).toMatch(/Sep\s*2/);
    expect(formatDate(null)).toBe('—');
  });

  it('describes recent times in words', () => {
    const now = new Date();
    expect(relativeTime(new Date(now.getTime() - 30_000).toISOString())).toBe('just now');
    expect(relativeTime(new Date(now.getTime() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(relativeTime(new Date(now.getTime() - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });

  it('treats a done task as never overdue', () => {
    expect(isOverdue('2020-01-01', 'todo')).toBe(true);
    expect(isOverdue('2020-01-01', 'done')).toBe(false);
    expect(isOverdue(null, 'todo')).toBe(false);
  });
});

describe('status pills', () => {
  it('never conveys state by colour alone', async () => {
    const { container } = render(
      <>
        <Pill tone="danger">Blocked</Pill>
        <Pill tone="good">On track</Pill>
        <Pill tone="warn">At risk</Pill>
      </>,
    );
    // Each pill carries its own text label, not just a colour class.
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('At risk')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
