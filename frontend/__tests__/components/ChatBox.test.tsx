/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatBox } from '@/components/ChatBox';
import type { ChatMessage, LlmHealth } from '@/lib/types';

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
    render(
      <ChatBox sessionId="abc" initialMessages={initialMessages} llmHealth={null} />,
    );
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
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={null} />);
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
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={null} />);
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
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={null} />);
    await user.type(screen.getByLabelText('Message'), 'hi{enter}');

    await waitFor(() =>
      expect(screen.getByText('Hello world')).toBeInTheDocument(),
    );
    // After done, base state has the bot bubble (no streaming flag) -> no live cursor.
    const bot = screen.getAllByTestId('bot-bubble').slice(-1)[0];
    expect(bot.querySelector('[aria-hidden]')).toBeNull();
  });

  it('shows the typing indicator while waiting for the first token, then hides it once a token arrives', async () => {
    // We hand-control the SSE stream so we can verify the indicator is in
    // the DOM during the (potentially long) "thinking" window before any
    // text comes back, and disappears as soon as the first token streams.
    let pushFrame!: (frame: string) => void;
    let closeStream!: () => void;
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        pushFrame = (f) =>
          controller.enqueue(encoder.encode(`data: ${f}\n\n`));
        closeStream = () => controller.close();
      },
    });
    global.fetch = jest.fn(
      async () =>
        new Response(streamBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={null} />);
    await user.type(screen.getByLabelText('Message'), 'hi{enter}');

    // Optimistic user bubble + typing indicator visible while we wait.
    await waitFor(() =>
      expect(screen.getByTestId('typing-indicator')).toBeInTheDocument(),
    );
    expect(screen.queryAllByTestId('bot-bubble')).toHaveLength(0);

    // First real token arrives → indicator must disappear, bot bubble appears.
    await act(async () => {
      pushFrame(JSON.stringify({ token: 'Hi' }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
      expect(screen.getByText('Hi')).toBeInTheDocument();
    });

    // Finalize so the action settles cleanly.
    await act(async () => {
      pushFrame(JSON.stringify({ done: true, turnIndex: 1 }));
      closeStream();
    });
    expect(screen.getByLabelText(/turn count/i)).toHaveTextContent('2 turns');
  });

  it('renders a persistent health banner when llmHealth reports issues', () => {
    const health: LlmHealth = {
      status: 'degraded',
      provider: 'openai',
      model: 'gpt-4o-mini',
      issues: [
        {
          kind: 'tools_unsupported',
          message: 'Model did not invoke the tool.',
          suggestion: 'Try llama-3.3-70b-versatile on Groq.',
        },
      ],
      lastChecked: Date.now(),
    };
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={health} />);
    const banner = screen.getByTestId('health-banner');
    expect(banner).toHaveTextContent(/openai/i);
    expect(banner).toHaveTextContent(/gpt-4o-mini/);
    expect(banner).toHaveTextContent(/Tools/);
    expect(banner).toHaveTextContent(/llama-3\.3-70b-versatile/);
  });

  it('hides the health banner when status is ok', () => {
    const health: LlmHealth = {
      status: 'ok',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      issues: [],
      lastChecked: Date.now(),
    };
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={health} />);
    expect(screen.queryByTestId('health-banner')).not.toBeInTheDocument();
  });

  it('swaps the typing indicator for a "Thinking..." indicator when {thinking:true} arrives', async () => {
    let pushFrame!: (frame: string) => void;
    let closeStream!: () => void;
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        pushFrame = (f) =>
          controller.enqueue(encoder.encode(`data: ${f}\n\n`));
        closeStream = () => controller.close();
      },
    });
    global.fetch = jest.fn(
      async () =>
        new Response(streamBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={null} />);
    await user.type(screen.getByLabelText('Message'), 'hi{enter}');

    // Initially shows typing dots (no thinking signal yet).
    await waitFor(() =>
      expect(screen.getByTestId('typing-indicator')).toBeInTheDocument(),
    );

    // Backend signals the model entered a <think> block — UI must swap to
    // the labelled Thinking indicator.
    await act(async () => {
      pushFrame(JSON.stringify({ thinking: true }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    // </think> arrives — back to typing dots (still no real tokens yet).
    await act(async () => {
      pushFrame(JSON.stringify({ thinking: false }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
      expect(screen.getByTestId('typing-indicator')).toBeInTheDocument();
    });

    // First real token replaces the indicator with the streaming bubble.
    await act(async () => {
      pushFrame(JSON.stringify({ token: 'Done.' }));
      pushFrame(JSON.stringify({ done: true, turnIndex: 1 }));
      closeStream();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument(),
    );
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
    render(<ChatBox sessionId="abc" initialMessages={[]} llmHealth={null} />);
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
