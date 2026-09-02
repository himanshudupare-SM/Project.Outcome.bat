import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import type { Braindump } from '@outcome/shared';
import { api, ApiError } from '../../lib/api.js';
import { useProjects } from '../../lib/queries.js';
import { Button, Field, useToast } from '../../ui/index.js';
import { ProposalReview } from './ProposalReview.js';
import { VoiceRecorder } from './VoiceRecorder.js';

/**
 * Brain Dump: type or speak, then review structured tasks before anything is
 * created. The three states (input / extracting / review) are explicit so the
 * user always knows nothing has been written yet.
 */
export function Capture(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const projects = useProjects(orgSlug);
  const [text, setText] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [dump, setDump] = useState<Braindump | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);

  const extract = useMutation({
    mutationFn: (input: { text: string; source: 'text' | 'voice' }) =>
      api.post<Braindump>(`/orgs/${orgSlug}/braindumps`, {
        ...input,
        projectId: projectKey || null,
      }),
    onSuccess: (result) => {
      setError(null);
      setFields({});
      setDump(result);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setFields(err.fields);
        setError(Object.keys(err.fields).length > 0 ? null : (err.body.detail ?? err.body.title));
      } else {
        setError('Extraction failed. Your text is safe — try again.');
      }
    },
  });

  if (dump?.proposal) {
    return (
      <ProposalReview
        orgSlug={orgSlug}
        dump={dump}
        defaultProjectKey={projectKey || (projects.data?.[0]?.key ?? '')}
        onDone={(createdCount, projectKeyUsed) => {
          toast.push(
            `Created ${createdCount} task${createdCount === 1 ? '' : 's'} in ${projectKeyUsed}`,
            'success',
          );
          navigate(`/o/${orgSlug}/p/${projectKeyUsed}/board`);
        }}
        onDiscard={() => {
          setDump(null);
          setText('');
        }}
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Brain dump</h1>
          <div className="page-sub">
            Say or type everything on your mind. You review the structured tasks before anything is
            created.
          </div>
        </div>
      </div>

      <div className="card card-pad" style={{ maxWidth: 780 }}>
        {error && (
          <div className="alert alert-error" role="alert" style={{ marginBottom: 14 }}>
            {error}{' '}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => extract.mutate({ text, source: 'text' })}
              style={{ marginLeft: 6 }}
            >
              Try again
            </Button>
          </div>
        )}

        <Field
          label="What needs doing?"
          error={fields['text']}
          hint="Plain speech is fine — deadlines, owners, and what is blocked on what."
        >
          {(props) => (
            <textarea
              {...props}
              className="textarea"
              style={{ minHeight: 190 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                'I need to finish the Codex workshop, ask engineering to check the MacBook ' +
                'integration, and prepare the GTM deck. The deck needs to be done before Friday ' +
                'and engineering is blocked until the API credentials arrive.'
              }
              disabled={extract.isPending}
            />
          )}
        </Field>

        <Field label="Project (optional)" hint="Scoping the dump improves duplicate detection.">
          {(props) => (
            <select
              {...props}
              className="select"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              disabled={extract.isPending}
            >
              <option value="">Not sure yet — suggest groupings</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <div className="row">
          <Button
            variant="primary"
            loading={extract.isPending}
            disabled={text.trim().length === 0}
            onClick={() => extract.mutate({ text, source: 'text' })}
          >
            {extract.isPending ? 'Extracting tasks…' : 'Extract tasks'}
          </Button>
          <Button variant="default" onClick={() => setVoiceOpen(true)} disabled={extract.isPending}>
            🎙 Use voice
          </Button>
          <span className="spacer" />
          <span className="page-sub">{text.length.toLocaleString()} characters</span>
        </div>

        {extract.isPending && (
          <div className="alert" style={{ marginTop: 12 }} role="status">
            Reading your notes, finding tasks, deadlines, owners and blockers… nothing is created
            until you approve it.
          </div>
        )}
      </div>

      {voiceOpen && (
        <VoiceRecorder
          onClose={() => setVoiceOpen(false)}
          onTranscript={(transcript) => {
            setVoiceOpen(false);
            setText(transcript);
            extract.mutate({ text: transcript, source: 'voice' });
          }}
        />
      )}
    </>
  );
}
