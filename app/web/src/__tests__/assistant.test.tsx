import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AssistantReply, ProposedAction } from '@outcome/shared';
import { Assistant } from '../features/assistant/Assistant.js';
import { ToastProvider } from '../ui/index.js';

/**
 * Assistant safety rules, from the UI side: facts are separated from opinion,
 * citations are real links, a refusal is shown as a refusal, and no proposed
 * change is ever sent to the server without an explicit click.
 */

const PROJECTS = [{ id: 'p1', key: 'ATLAS', name: 'Atlas', taskCount: 4, openBlockerCount: 1 }];

function action(over: Partial<ProposedAction> = {}): ProposedAction {
  return {
    tool: 'create_task',
    description: 'Create "Chase legal for the DPA" in Atlas.',
    targetRef: null,
    title: 'Chase legal for the DPA',
    body: null,
    assigneeName: null,
    priority: null,
    dueDate: null,
    blockingRef: null,
    highImpact: false,
    ...over,
  };
}

function reply(over: Partial<AssistantReply> = {}): AssistantReply {
  return {
    conversationId: '33333333-3333-4333-8333-333333333333',
    messageId: '44444444-4444-4444-8444-444444444444',
    answer: { facts: [], recommendations: [], cannotAnswer: null, proposedActions: [] },
    citations: [],
    actions: [],
    model: 'rules-v1',
    promptVersion: 'assistant-v1',
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let posted: Array<{ url: string; body: unknown }>;
let nextReply: AssistantReply;
let confirmStatus = 200;

beforeEach(() => {
  posted = [];
  confirmStatus = 200;
  nextReply = reply();
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const json = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if ((init?.method ?? 'GET') !== 'GET') {
      posted.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    }
    if (url.endsWith('/projects')) return Promise.resolve(json(PROJECTS));
    if (url.endsWith('/assistant/ask')) return Promise.resolve(json(nextReply));
    if (url.endsWith('/actions/confirm')) {
      return confirmStatus === 200
        ? Promise.resolve(json({ status: 'executed', result: { ref: 'ATLAS-9' } }))
        : Promise.resolve(
            json({ type: 'forbidden', title: 'Not allowed', status: 403, detail: 'You cannot edit that task.' }, 403),
          );
    }
    if (url.includes('/reject')) return Promise.resolve(json({ status: 'rejected' }));
    return Promise.resolve(json(null));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function renderAssistant() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/o/northwind/assistant']}>
          <Routes>
            <Route path="/o/:orgSlug/assistant" element={<Assistant />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function ask(text: string): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'Question' }), text);
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('Assistant', () => {
  it('will not send an empty question', async () => {
    renderAssistant();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Question' }), '   ');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    expect(posted.filter((p) => p.url.endsWith('/assistant/ask'))).toHaveLength(0);
  });

  it('separates what the data shows from what it recommends', async () => {
    nextReply = reply({
      answer: {
        facts: [{ text: 'ATLAS-3 has been blocked for 9 days.', refs: ['ATLAS-3'] }],
        recommendations: ['Escalate the credentials request to the platform team.'],
        cannotAnswer: null,
        proposedActions: [],
      },
      citations: [
        { ref: 'ATLAS-3', taskId: 't3', title: 'Check the integration', projectKey: 'ATLAS', number: 3, statusName: 'Blocked' },
      ],
    });
    renderAssistant();
    await ask('What is blocking us?');

    await screen.findByText('What the data shows');
    expect(screen.getByText('Recommendation')).toBeInTheDocument();
    expect(screen.getByText(/blocked for 9 days/)).toBeInTheDocument();
    expect(screen.getByText(/Escalate the credentials request/)).toBeInTheDocument();
  });

  it('renders a citation as a link to that task', async () => {
    nextReply = reply({
      answer: {
        facts: [{ text: 'ATLAS-3 is blocked.', refs: ['ATLAS-3'] }],
        recommendations: [],
        cannotAnswer: null,
        proposedActions: [],
      },
      citations: [
        { ref: 'ATLAS-3', taskId: 't3', title: 'Check the integration', projectKey: 'ATLAS', number: 3, statusName: 'Blocked' },
      ],
    });
    renderAssistant();
    await ask('What is blocking us?');

    const link = await screen.findByRole('link', { name: 'ATLAS-3' });
    expect(link).toHaveAttribute('href', '/o/northwind/p/ATLAS/t/3');
    expect(link).toHaveAttribute('title', 'Check the integration');
  });

  it('drops a ref the server did not resolve rather than linking nowhere', async () => {
    nextReply = reply({
      answer: {
        facts: [{ text: 'PRIVATE-1 is late.', refs: ['PRIVATE-1'] }],
        recommendations: [],
        cannotAnswer: null,
        proposedActions: [],
      },
      citations: [],
    });
    renderAssistant();
    await ask('Anything late?');

    await screen.findByText(/PRIVATE-1 is late/);
    expect(screen.queryByRole('link', { name: 'PRIVATE-1' })).not.toBeInTheDocument();
  });

  it('shows a refusal as a refusal, with no invented facts', async () => {
    nextReply = reply({
      answer: {
        facts: [],
        recommendations: [],
        cannotAnswer: 'I can only see tasks and blockers, so I cannot answer that.',
        proposedActions: [],
      },
    });
    renderAssistant();
    await ask('What is our revenue forecast?');

    await screen.findByText(/I can only see tasks and blockers/);
    expect(screen.queryByText('What the data shows')).not.toBeInTheDocument();
    expect(screen.queryByText('Recommendation')).not.toBeInTheDocument();
  });

  it('proposes a change without applying it, and says so', async () => {
    nextReply = reply({ actions: [{ id: 'a1', action: action(), status: 'proposed' }] });
    renderAssistant();
    await ask('Create a task to chase legal');

    await screen.findByText(/nothing is applied until you confirm/);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(posted.some((p) => p.url.includes('/actions/confirm'))).toBe(false);
  });

  it('demands a stronger confirmation for a high-impact change', async () => {
    nextReply = reply({
      actions: [
        {
          id: 'a1',
          action: action({ tool: 'update_task', description: 'Reassign ATLAS-3 to Marco.', targetRef: 'ATLAS-3', highImpact: true }),
          status: 'proposed',
        },
      ],
    });
    renderAssistant();
    await ask('Reassign ATLAS-3');

    await screen.findByText('High impact');
    expect(screen.getByRole('button', { name: 'Confirm this change' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('sends an explicit confirm flag only after the click, then marks it applied', async () => {
    nextReply = reply({ actions: [{ id: 'a1', action: action(), status: 'proposed' }] });
    renderAssistant();
    await ask('Create a task to chase legal');

    await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const call = posted.find((p) => p.url.includes('/actions/confirm'));
      expect(call?.body).toEqual({ actionId: 'a1', confirm: true });
    });
    // Both the action card and the toast say "Applied"; the card is the record.
    await waitFor(() => expect(screen.getAllByText('Applied').length).toBeGreaterThan(0));
    // Controls are gone, so it cannot be applied twice.
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('dismissing a proposal never calls confirm', async () => {
    nextReply = reply({ actions: [{ id: 'a1', action: action(), status: 'proposed' }] });
    renderAssistant();
    await ask('Create a task to chase legal');

    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await screen.findByText('Dismissed');
    expect(posted.some((p) => p.url.includes('/actions/confirm'))).toBe(false);
    expect(posted.some((p) => p.url.includes('/reject'))).toBe(true);
  });

  it('does not claim success when the server rejects the change', async () => {
    confirmStatus = 403;
    nextReply = reply({ actions: [{ id: 'a1', action: action(), status: 'proposed' }] });
    renderAssistant();
    await ask('Create a task to chase legal');

    await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await screen.findByText('You cannot edit that task.');
    expect(screen.queryAllByText('Applied')).toHaveLength(0);
  });

  it('surfaces an ask failure inline instead of losing the question', async () => {
    fetchMock.mockImplementation((url: string) => {
      const json = (p: unknown, s = 200): Response =>
        new Response(JSON.stringify(p), { status: s, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/projects')) return Promise.resolve(json(PROJECTS));
      return Promise.resolve(json({ type: 'ai_unavailable', title: 'AI unavailable', status: 503, detail: 'The assistant is temporarily unavailable.' }, 503));
    });
    renderAssistant();
    await ask('What is blocking us?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The assistant is temporarily unavailable.');
    expect(screen.getByText('What is blocking us?')).toBeInTheDocument();
  });

  it('shows which model and prompt produced the answer', async () => {
    nextReply = reply({ answer: { facts: [{ text: 'All clear.', refs: [] }], recommendations: [], cannotAnswer: null, proposedActions: [] } });
    renderAssistant();
    await ask('Status?');
    await screen.findByText(/rules-v1 · prompt assistant-v1/);
  });

  it('keeps the conversation id so follow-ups stay in context', async () => {
    nextReply = reply({ answer: { facts: [{ text: 'All clear.', refs: [] }], recommendations: [], cannotAnswer: null, proposedActions: [] } });
    renderAssistant();
    await ask('Status?');
    await screen.findByText(/All clear/);
    await ask('And next week?');

    await waitFor(() => {
      const asks = posted.filter((p) => p.url.endsWith('/assistant/ask'));
      expect(asks).toHaveLength(2);
      expect((asks[0]!.body as { conversationId: string | null }).conversationId).toBeNull();
      expect((asks[1]!.body as { conversationId: string | null }).conversationId).toBe(nextReply.conversationId);
    });
  });
});
