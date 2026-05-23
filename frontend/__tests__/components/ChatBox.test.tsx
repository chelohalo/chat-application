/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatBox } from '@/components/ChatBox';
import type { ChatMessage } from '@/lib/types';

function sseStreamBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(`data: ${f}\n\n`));
      }
      controller.close();
    },
  });
}

function sseResponse(frames: string[]): Response {
  return new Response(sseStreamBody(frames), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('<ChatBox />', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('renders initialMessages from the Server Component', () => {
    const initialMessages: ChatMessage[] = [
      {
        kind: 'user',
        id: 'srv-0',
        turnIndex: 0,
        content: 'what is a generic?',
        createdAt: Date.now() - 1000,
      },
      {
        kind: 'bot',
        id: 'srv-1',
        turnIndex: 1,
        content: 'A generic is a parameterized type...',
        createdAt: Date.now() - 500,
      },
    ];
    render(<ChatBox sessionId="abc" initialMessages={initialMessages} />);
    expect(screen.getByText('what is a generic?')).toBeInTheDocument();
    expect(
      screen.getByText('A generic is a parameterized type...'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/turn count/i)).toHaveTextContent('2 turns');
  });

  it('shows the optimistic user bubble immediately, before fetch resolves', async () => {
    let resolveFetch!: (r: Response) => void;
    global.fetch = jest.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ChatBox sessionId="abc" initialMessages={[]} />);
    await user.type(screen.getByLabelText('Message'), 'hello{enter}');

    // The optimistic user bubble must be in the DOM BEFORE we resolve the fetch.
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Resolve with a complete SSE stream so the action settles.
    await act(async () => {
      resolveFetch(
        sseResponse([
          JSON.stringify({ token: 'hi' }),
          JSON.stringify({ token: ' there' }),
          JSON.stringify({ done: true, turnIndex: 1 }),
        ]),
      );
    });

    await waitFor(() => expect(screen.getByText('hi there')).toBeInTheDocument());
    // User bubble survives (committed to base state).
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByLabelText(/turn count/i)).toHaveTextContent('2 turns');
  });

  it('rolls back the optimistic user bubble on error', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: 'Message cannot be empty.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ChatBox sessionId="abc" initialMessages={[]} />);
    await user.type(screen.getByLabelText('Message'), 'hello{enter}');

    // Error banner shows up.
    await waitFor(() =>
      expect(
        screen.getByRole('alert').textContent,
      ).toMatch(/Message cannot be empty/),
    );

    // The user bubble is rolled back because base state was never updated.
    await waitFor(() => expect(screen.queryByText('hello')).not.toBeInTheDocument());
    expect(screen.getByLabelText(/turn count/i)).toHaveTextContent('0 turns');
  });

  it('streams tokens into the live bot bubble and removes the cursor on done', async () => {
    global.fetch = jest.fn(async () =>
      sseResponse([
        JSON.stringify({ token: 'Hello' }),
        JSON.stringify({ token: ' world' }),
        JSON.stringify({ done: true, turnIndex: 1 }),
      ]),
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ChatBox sessionId="abc" initialMessages={[]} />);
    await user.type(screen.getByLabelText('Message'), 'hi{enter}');

    await waitFor(() =>
      expect(screen.getByText('Hello world')).toBeInTheDocument(),
    );
    // After done, base state has the bot bubble (no streaming flag) -> no live cursor.
    const bot = screen.getAllByTestId('bot-bubble').slice(-1)[0];
    expect(bot.querySelector('[aria-hidden]')).toBeNull();
  });

  it('on sessionExpired:true clears cookie and shows the expiry banner', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ sessionExpired: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    // Stub window.location.reload — happens via setTimeout(800ms); we don't await.
    const originalLocation = window.location;
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: { reload: jest.Mock } }).location = {
      reload: jest.fn(),
    };

    const user = userEvent.setup();
    render(<ChatBox sessionId="abc" initialMessages={[]} />);
    await user.type(screen.getByLabelText('Message'), 'hi{enter}');

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Session expired/),
    );
    // The second fetch call clears the cookie via DELETE /api/session.
    expect(fetchMock.mock.calls[1][0]).toBe('/api/session');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });

    // Restore.
    (window as unknown as { location: typeof originalLocation }).location =
      originalLocation;
  });
});
