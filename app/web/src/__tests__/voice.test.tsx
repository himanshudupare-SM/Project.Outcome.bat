import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceRecorder } from '../features/braindump/VoiceRecorder.js';

/**
 * Voice capture failure states. Every one of these is a real thing a browser
 * does, and in each case the user must still be able to get their notes in —
 * a dead end here loses the thought they were trying to capture.
 */

interface FakeEngine {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean; length: number }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

let engines: FakeEngine[] = [];
let startCalls = 0;
const track = { stop: vi.fn() };

function installSpeechRecognition(options: { failStart?: boolean } = {}): void {
  class Fake implements FakeEngine {
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: FakeEngine['onresult'] = null;
    onerror: FakeEngine['onerror'] = null;
    onend: FakeEngine['onend'] = null;
    constructor() {
      engines.push(this);
    }
    start(): void {
      startCalls += 1;
      if (options.failStart) throw new Error('already started');
    }
    stop = vi.fn();
    abort = vi.fn();
  }
  Object.assign(window, { SpeechRecognition: Fake });
}

function installMic(behaviour: 'ok' | { name: string } | 'missing'): void {
  if (behaviour === 'missing') {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    return;
  }
  const getUserMedia =
    behaviour === 'ok'
      ? vi.fn().mockResolvedValue({ getTracks: () => [track] })
      : vi.fn().mockRejectedValue(Object.assign(new Error('nope'), behaviour));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
}

function emit(engine: FakeEngine, text: string, isFinal: boolean): void {
  act(() => {
    engine.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: text }, isFinal, length: 1 }],
    });
  });
}

beforeEach(() => {
  engines = [];
  startCalls = 0;
  track.stop.mockClear();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  vi.useRealTimers();
});

function renderRecorder() {
  const onTranscript = vi.fn();
  const onClose = vi.fn();
  const utils = render(<VoiceRecorder onClose={onClose} onTranscript={onTranscript} />);
  return { ...utils, onTranscript, onClose };
}

describe('VoiceRecorder — entry', () => {
  it('always offers typing as a way out, before anything is recorded', () => {
    installMic('ok');
    renderRecorder();
    expect(screen.getByRole('dialog', { name: 'Voice capture' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Type instead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
  });

  it('warns that the transcript is editable before anything is created', () => {
    installMic('ok');
    renderRecorder();
    expect(screen.getByText(/edit the\s+transcript before any tasks are created/)).toBeInTheDocument();
  });
});

describe('VoiceRecorder — failure states', () => {
  it('explains a denied microphone and how to fix it', async () => {
    installMic({ name: 'NotAllowedError' });
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Microphone access was blocked/);
    expect(alert).toHaveTextContent(/site settings/);
    expect(screen.getByRole('button', { name: 'Type instead' })).toBeInTheDocument();
    // No retry button that would just fail again.
    expect(screen.queryByRole('button', { name: 'Start recording' })).not.toBeInTheDocument();
  });

  it('handles a machine with no microphone attached', async () => {
    installMic({ name: 'NotFoundError' });
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No microphone was found.');
  });

  it('handles a browser with no capture API at all', async () => {
    installMic('missing');
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This browser cannot record audio.');
  });

  it('falls back on an unexpected device error rather than hanging', async () => {
    installMic({ name: 'NotReadableError' });
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start recording.');
  });

  it('still records when the browser has no live transcription', async () => {
    installMic('ok');
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no live transcription/i);
    expect(await screen.findByText(/Recording. Live transcription is unavailable/)).toBeInTheDocument();
    // Recording continues, so the user can stop and type what they said.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('keeps recording when live transcription loses its connection', async () => {
    installMic('ok');
    installSpeechRecognition();
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));

    act(() => engines[0]!.onerror?.({ error: 'network' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/lost its connection/);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('ignores a silence event instead of showing a scary error', async () => {
    installMic('ok');
    installSpeechRecognition();
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));

    act(() => engines[0]!.onerror?.({ error: 'no-speech' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a permission revoked mid-recording as a denial and releases the mic', async () => {
    installMic('ok');
    installSpeechRecognition();
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));

    act(() => engines[0]!.onerror?.({ error: 'not-allowed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Microphone access was blocked/);
    expect(track.stop).toHaveBeenCalled();
  });

  it('recovers from a transcription engine that refuses to start', async () => {
    installMic('ok');
    installSpeechRecognition({ failStart: true });
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    // Still in the recording phase, just without live text.
    expect(await screen.findByText(/Live transcription is unavailable in this browser/)).toBeInTheDocument();
  });
});

describe('VoiceRecorder — transcript handling', () => {
  it('restarts a transcription session the browser ended on its own', async () => {
    installMic('ok');
    installSpeechRecognition();
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(startCalls).toBe(1));

    // Chrome ends the session periodically; it must come back by itself,
    // otherwise the rest of a long dump is silently not transcribed.
    act(() => engines[0]!.onend?.());
    expect(startCalls).toBe(2);
  });

  it('does not restart transcription once the user pauses', async () => {
    installMic('ok');
    installSpeechRecognition();
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(startCalls).toBe(1));

    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() => engines[0]!.onend?.());
    expect(startCalls).toBe(1);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('shows interim words as provisional and keeps only final text', async () => {
    installMic('ok');
    installSpeechRecognition();
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));

    emit(engines[0]!, 'prepare the deck', false);
    expect(await screen.findByText(/prepare the deck/)).toBeInTheDocument();
    emit(engines[0]!, 'prepare the GTM deck', true);
    await waitFor(() => expect(screen.getByText(/prepare the GTM deck/)).toBeInTheDocument());
  });

  it('lets the user correct a bad transcription before extraction', async () => {
    installMic('ok');
    installSpeechRecognition();
    const { onTranscript } = renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));
    emit(engines[0]!, 'prepare the GTFO deck', true);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    const box = screen.getByLabelText(/Transcript — edit anything that came out wrong/);
    await userEvent.clear(box);
    await userEvent.type(box, 'prepare the GTM deck');
    await userEvent.click(screen.getByRole('button', { name: 'Extract tasks' }));
    expect(onTranscript).toHaveBeenCalledWith('prepare the GTM deck');
  });

  it('refuses to extract from an empty recording, and says what to do', async () => {
    installMic('ok');
    installSpeechRecognition();
    const { onTranscript } = renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(screen.getByText(/Nothing was captured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Extract tasks' })).toBeDisabled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('stops a very long recording at the limit and keeps what it heard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installMic('ok');
    installSpeechRecognition();
    renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));
    emit(engines[0]!, 'a long stream of notes', true);

    // Just past the 8-minute warning.
    await act(async () => {
      vi.advanceTimersByTime(8 * 60 * 1000);
    });
    expect(screen.getByText(/Approaching the 10-minute limit/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Reached the 10-minute limit/);
    expect(screen.getByLabelText(/Transcript/)).toHaveValue('a long stream of notes');
    expect(track.stop).toHaveBeenCalled();
  });

  it('releases the microphone when the dialog is closed', async () => {
    installMic('ok');
    installSpeechRecognition();
    const { onClose } = renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(engines[0]!.abort).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('releases the microphone when unmounted mid-recording', async () => {
    installMic('ok');
    installSpeechRecognition();
    const { unmount } = renderRecorder();
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(engines).toHaveLength(1));

    unmount();
    expect(track.stop).toHaveBeenCalled();
  });
});
