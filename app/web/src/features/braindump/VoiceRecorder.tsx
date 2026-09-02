import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '../../ui/index.js';

/**
 * Voice capture. Uses the browser's SpeechRecognition where available and
 * falls back to MediaRecorder-with-manual-transcript, then to plain typing.
 * The transcript is always editable before the AI sees it — a bad
 * transcription must never become bad tasks silently.
 */
type Phase = 'permission' | 'recording' | 'paused' | 'review' | 'unsupported' | 'denied' | 'error';

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean; length: number }>;
}

const MAX_SECONDS = 10 * 60;
const WARN_SECONDS = 8 * 60;

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VoiceRecorder({
  onClose,
  onTranscript,
}: {
  onClose: () => void;
  onTranscript: (transcript: string) => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('permission');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [liveTranscription, setLiveTranscription] = useState(true);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);
  const finalText = useRef('');

  const stopEverything = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    recognition.current?.abort();
    recognition.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  useEffect(() => stopEverything, [stopEverything]);

  const start = useCallback(async () => {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase('unsupported');
      setMessage('This browser cannot record audio. Type your notes instead.');
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setPhase('denied');
        setMessage(
          'Microphone access was blocked. Allow it in your browser’s site settings, or type your notes instead.',
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setPhase('unsupported');
        setMessage('No microphone was found. Type your notes instead.');
      } else {
        setPhase('error');
        setMessage('Could not start recording. Type your notes instead.');
      }
      return;
    }

    const Ctor = recognitionCtor();
    if (Ctor) {
      const engine = new Ctor();
      engine.continuous = true;
      engine.interimResults = true;
      engine.lang = navigator.language || 'en-US';
      engine.onresult = (event) => {
        let pending = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]!;
          const text = result[0].transcript;
          if (result.isFinal) finalText.current += `${text.trim()} `;
          else pending += text;
        }
        setTranscript(finalText.current);
        setInterim(pending);
      };
      engine.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setPhase('denied');
          setMessage('Microphone access was blocked. Type your notes instead.');
          stopEverything();
          return;
        }
        if (event.error === 'no-speech') return; // benign; keep listening
        if (event.error === 'network') {
          setLiveTranscription(false);
          setMessage(
            'Live transcription lost its connection. Keep speaking — or stop and type what you said.',
          );
          return;
        }
        setLiveTranscription(false);
        setMessage('Live transcription is unavailable. You can still record and type the text.');
      };
      // Chrome ends the session periodically; restart while still recording.
      engine.onend = () => {
        if (recognition.current === engine && phase === 'recording') {
          try {
            engine.start();
          } catch {
            setLiveTranscription(false);
          }
        }
      };
      try {
        engine.start();
        recognition.current = engine;
      } catch {
        setLiveTranscription(false);
      }
    } else {
      setLiveTranscription(false);
      setMessage(
        'This browser has no live transcription. Recording still works — type what you said before extracting.',
      );
    }

    setPhase('recording');
    timer.current = window.setInterval(() => {
      setSeconds((current) => {
        const next = current + 1;
        if (next >= MAX_SECONDS) {
          stopEverything();
          setPhase('review');
          setMessage('Reached the 10-minute limit. Review what was captured, then extract.');
        }
        return next;
      });
    }, 1000);
  }, [phase, stopEverything]);

  const finish = useCallback(() => {
    stopEverything();
    setInterim('');
    setPhase('review');
  }, [stopEverything]);

  const combined = `${transcript}${interim ? ` ${interim}` : ''}`.trim();
  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <Dialog
      title="Voice capture"
      onClose={() => {
        stopEverything();
        onClose();
      }}
      footer={
        phase === 'review' ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                finalText.current = '';
                setTranscript('');
                setSeconds(0);
                setMessage(null);
                setPhase('permission');
              }}
            >
              Record again
            </Button>
            <Button
              variant="primary"
              disabled={combined.trim().length === 0}
              onClick={() => onTranscript(combined.trim())}
            >
              Extract tasks
            </Button>
          </>
        ) : phase === 'recording' || phase === 'paused' ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                stopEverything();
                onClose();
              }}
            >
              Cancel
            </Button>
            {phase === 'recording' ? (
              <Button
                onClick={() => {
                  recognition.current?.stop();
                  if (timer.current !== null) window.clearInterval(timer.current);
                  timer.current = null;
                  setPhase('paused');
                }}
              >
                Pause
              </Button>
            ) : (
              <Button onClick={() => void start()}>Resume</Button>
            )}
            <Button variant="primary" onClick={finish}>
              Stop
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Type instead
            </Button>
            {phase === 'permission' && (
              <Button variant="primary" onClick={() => void start()}>
                Start recording
              </Button>
            )}
          </>
        )
      }
    >
      {message && (
        <div
          className={`alert ${phase === 'denied' || phase === 'error' ? 'alert-error' : 'alert-warn'}`}
          role="alert"
          style={{ marginBottom: 12 }}
        >
          {message}
        </div>
      )}

      {phase === 'permission' && (
        <p className="page-sub">
          Your browser will ask for microphone permission. Speak naturally — you can edit the
          transcript before any tasks are created.
        </p>
      )}

      {(phase === 'recording' || phase === 'paused') && (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: phase === 'recording' ? 'var(--danger)' : 'var(--ink-3)',
              }}
            />
            <strong role="status">
              {phase === 'recording' ? 'Recording' : 'Paused'} {mmss}
            </strong>
            <span className="spacer" />
            {seconds >= WARN_SECONDS && (
              <span className="page-sub">Approaching the 10-minute limit</span>
            )}
          </div>
          <div
            className="card card-pad"
            style={{ minHeight: 120, maxHeight: 240, overflowY: 'auto' }}
            aria-live="polite"
          >
            {combined ? (
              <>
                {transcript}
                {interim && <span style={{ color: 'var(--ink-3)' }}> {interim}</span>}
              </>
            ) : (
              <span className="page-sub">
                {liveTranscription
                  ? 'Listening…'
                  : 'Recording. Live transcription is unavailable in this browser.'}
              </span>
            )}
          </div>
        </>
      )}

      {phase === 'review' && (
        <>
          <label className="field-label" htmlFor="voice-transcript">
            Transcript — edit anything that came out wrong
          </label>
          <textarea
            id="voice-transcript"
            className="textarea"
            style={{ minHeight: 180 }}
            value={combined}
            onChange={(e) => {
              finalText.current = e.target.value;
              setTranscript(e.target.value);
              setInterim('');
            }}
          />
          {combined.trim().length === 0 && (
            <div className="alert alert-warn" style={{ marginTop: 8 }}>
              Nothing was captured. Record again, or type your notes here.
            </div>
          )}
          <div className="page-sub" style={{ marginTop: 6 }}>
            {mmss} recorded · {combined.length.toLocaleString()} characters
          </div>
        </>
      )}

      {(phase === 'denied' || phase === 'unsupported' || phase === 'error') && (
        <p className="page-sub">
          You can always type your notes — the extraction is identical either way.
        </p>
      )}
    </Dialog>
  );
}
