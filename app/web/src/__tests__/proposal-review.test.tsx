import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Braindump, ProposedTask } from '@outcome/shared';
import { ProposalReview } from '../features/braindump/ProposalReview.js';
import { ToastProvider } from '../ui/index.js';

/**
 * The approval gate. Nothing the model proposes may reach the database without
 * a human seeing it, and anything the model was unsure about has to be
 * confirmed first — so these are behaviour tests, not cosmetics.
 */

const MEMBERS = [
  { userId: '11111111-1111-4111-8111-111111111111', name: 'Priya Raman', email: 'priya@example.com', role: 'member' },
  { userId: '22222222-2222-4222-8222-222222222222', name: 'Marco Diaz', email: 'marco@example.com', role: 'admin' },
];

function proposedTask(over: Partial<ProposedTask> = {}): ProposedTask {
  return {
    key: 'T1',
    title: 'Prepare the GTM deck',
    description: '',
    suggestedGroup: null,
    priority: null,
    dueDate: null,
    assigneeHint: null,
    estimateDays: null,
    labels: [],
    dependsOnKeys: [],
    blocker: null,
    possibleDuplicateOf: [],
    sourceQuote: 'prepare the GTM deck',
    ...over,
  };
}

function dumpWith(tasks: ProposedTask[], questions: Braindump['proposal'] extends null ? never : { taskKey: string | null; field: string; question: string }[] = []): Braindump {
  return {
    id: 'dump-1',
    userId: 'user-1',
    projectId: null,
    source: 'text',
    rawInput: 'prepare the GTM deck',
    status: 'ready',
    proposal: { summary: `${tasks.length} task(s) found.`, tasks, questions, notes: [] },
    error: null,
    model: 'rules-v1',
    promptVersion: 'braindump-v1',
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
const approveCalls: unknown[] = [];

beforeEach(() => {
  approveCalls.length = 0;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const body = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/projects')) {
      return Promise.resolve(body([{ id: 'p1', key: 'ATLAS', name: 'Atlas', taskCount: 3, openBlockerCount: 0 }]));
    }
    if (url.endsWith('/members')) return Promise.resolve(body(MEMBERS));
    if (url.endsWith('/epics')) return Promise.resolve(body([]));
    if (url.endsWith('/labels')) return Promise.resolve(body([]));
    if (url.includes('/approve')) {
      approveCalls.push(JSON.parse(init?.body as string));
      return Promise.resolve(body({ created: [{ id: 't1', ref: 'ATLAS-9' }] }));
    }
    if (url.includes('/discard')) return Promise.resolve(body({ ok: true }));
    return Promise.resolve(body(null));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function renderReview(dump: Braindump, onDone = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ProposalReview
          orgSlug="northwind"
          dump={dump}
          defaultProjectKey="ATLAS"
          onDone={onDone}
          onDiscard={vi.fn()}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onDone };
}

describe('ProposalReview', () => {
  it('states plainly that nothing has been created yet', () => {
    renderReview(dumpWith([proposedTask()]));
    expect(screen.getByRole('heading', { name: 'Review before creating' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been created yet/)).toBeInTheDocument();
  });

  it('blocks creation while a selected task has an unanswered question', async () => {
    renderReview(
      dumpWith([proposedTask({ priority: { value: 'high', confidence: 'low', evidence: null } })], [
        { taskKey: 'T1', field: 'priority', question: 'Is this really high priority?' },
      ]),
    );

    expect(screen.getByText('Is this really high priority?')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: /^Create 1 task/ });
    expect(create).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Values look right' }));
    await waitFor(() => expect(create).toBeEnabled());
  });

  it('lets the user drop a task instead of answering its question', async () => {
    renderReview(
      dumpWith([proposedTask(), proposedTask({ key: 'T2', title: 'Chase the CX team' })], [
        { taskKey: 'T2', field: 'dueDate', question: 'When is this due?' },
      ]),
    );

    const create = screen.getByRole('button', { name: /^Create 2 tasks/ });
    expect(create).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include "Chase the CX team"' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Create 1 task/ })).toBeEnabled());
  });

  it('refuses to submit when everything has been unchecked', async () => {
    renderReview(dumpWith([proposedTask()]));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include "Prepare the GTM deck"' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Create 0 tasks/ })).toBeDisabled());
    expect(approveCalls).toHaveLength(0);
  });

  it('sends the edited values, not the model’s originals', async () => {
    const { onDone } = renderReview(dumpWith([proposedTask()]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const title = screen.getByRole('textbox', { name: 'Title for T1' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Prepare the Q4 GTM deck');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Priority for T1' }), 'urgent');
    await userEvent.click(screen.getByRole('button', { name: /^Create 1 task/ }));

    await waitFor(() => expect(approveCalls).toHaveLength(1));
    const payload = approveCalls[0] as { projectId: string; tasks: Array<{ title: string; priority: string }> };
    expect(payload.projectId).toBe('ATLAS');
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0]!.title).toBe('Prepare the Q4 GTM deck');
    expect(payload.tasks[0]!.priority).toBe('urgent');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(1, 'ATLAS'));
  });

  it('opts a suspected duplicate out by default but still shows it', async () => {
    renderReview(dumpWith([proposedTask({ possibleDuplicateOf: ['ATLAS-4'] })]));
    expect(screen.getByText(/Looks like existing ATLAS-4/)).toBeInTheDocument();
    // Pre-unchecked, so the safe outcome needs no action; the task is still on
    // screen and the user can opt back in.
    const include = screen.getByRole('checkbox', { name: 'Include "Prepare the GTM deck"' });
    expect(include).not.toBeChecked();
    expect(screen.getByRole('button', { name: /^Create 0 tasks/ })).toBeDisabled();
    await userEvent.click(include);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Create 1 task/ })).toBeEnabled());
  });

  it('resolves an unambiguous first-name hint to a real member once members load', async () => {
    renderReview(
      dumpWith([proposedTask({ assigneeHint: { value: 'priya', confidence: 'medium', evidence: 'ask priya' } })]),
    );
    const owner = await screen.findByRole('combobox', { name: 'Owner for T1' });
    await waitFor(() => expect((owner as HTMLSelectElement).value).toBe(MEMBERS[0]!.userId));
  });

  it('leaves an ambiguous or unknown name unassigned rather than guessing', async () => {
    renderReview(
      dumpWith([proposedTask({ assigneeHint: { value: 'someone in ops', confidence: 'low', evidence: null } })]),
    );
    const owner = await screen.findByRole('combobox', { name: 'Owner for T1' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((owner as HTMLSelectElement).value).toBe('');
  });

  it('shows the extraction provenance so the source is never hidden', () => {
    renderReview(dumpWith([proposedTask()]));
    expect(screen.getByText(/Extracted by rules-v1 using prompt braindump-v1/)).toBeInTheDocument();
  });

  it('surfaces a server refusal as an error instead of claiming success', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/approve')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ type: 'ai_budget_exceeded', title: 'Daily AI limit reached', status: 429, detail: 'Daily AI limit reached.' }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      const payload = url.endsWith('/members') ? MEMBERS : url.endsWith('/projects') ? [{ id: 'p1', key: 'ATLAS', name: 'Atlas', taskCount: 0, openBlockerCount: 0 }] : [];
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    });

    const { onDone } = renderReview(dumpWith([proposedTask()]));
    await userEvent.click(screen.getByRole('button', { name: /^Create 1 task/ }));
    const alert = await screen.findByText(/Daily AI limit reached/);
    expect(alert).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('counts only dependencies between tasks that are still selected', async () => {
    const { container } = renderReview(
      dumpWith([
        proposedTask(),
        proposedTask({ key: 'T2', title: 'Get the API credentials' }),
        proposedTask({ key: 'T3', title: 'Check the integration', dependsOnKeys: ['T2'] }),
      ]),
    );
    const summary = within(container).getByText('Dependencies').parentElement!;
    expect(summary.textContent).toMatch(/1$/);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include "Get the API credentials"' }));
    await waitFor(() => expect(within(container).getByText('Dependencies').parentElement!.textContent).toMatch(/0$/));
  });
});
