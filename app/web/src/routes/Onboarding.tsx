import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Org, ProjectDetail } from '@outcome/shared';
import { api, ApiError } from '../lib/api.js';
import { Button, Field } from '../ui/index.js';

/** Two-step setup: create the org, then the first project. */
export function Onboarding(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [orgName, setOrgName] = useState('');
  const [org, setOrg] = useState<Org | null>(null);
  const [projectName, setProjectName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setFields({});
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError) {
        setFields(err.fields);
        if (Object.keys(err.fields).length === 0) setError(err.body.detail ?? err.body.title);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card card card-pad" style={{ maxWidth: 440 }}>
        <div className="page-sub">Step {step} of 2</div>
        {step === 1 ? (
          <>
            <h1>Name your organization</h1>
            <p className="page-sub" style={{ marginBottom: 18 }}>
              This is the workspace your team shares.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const created = await api.post<Org>('/orgs', { name: orgName });
                  setOrg(created);
                  await queryClient.invalidateQueries({ queryKey: ['me'] });
                  setStep(2);
                });
              }}
              noValidate
            >
              {error && (
                <div className="alert alert-error" role="alert" style={{ marginBottom: 14 }}>
                  {error}
                </div>
              )}
              <Field label="Organization name" error={fields['name']} required>
                {(props) => (
                  <input
                    {...props}
                    className="input"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Northwind"
                    required
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" className="btn-block" loading={busy}>
                Continue
              </Button>
            </form>
          </>
        ) : (
          <>
            <h1>Create your first project</h1>
            <p className="page-sub" style={{ marginBottom: 18 }}>
              A project key is derived automatically — you can change it later.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const project = await api.post<ProjectDetail>(`/orgs/${org!.slug}/projects`, {
                    name: projectName,
                  });
                  navigate(`/o/${org!.slug}/p/${project.key}/board`, { replace: true });
                });
              }}
              noValidate
            >
              {error && (
                <div className="alert alert-error" role="alert" style={{ marginBottom: 14 }}>
                  {error}
                </div>
              )}
              <Field label="Project name" error={fields['name']} required>
                {(props) => (
                  <input
                    {...props}
                    className="input"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="Checkout Platform Migration"
                    required
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" className="btn-block" loading={busy}>
                Create project
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="btn-block"
                style={{ marginTop: 8 }}
                onClick={() => navigate(`/o/${org!.slug}`, { replace: true })}
              >
                Skip for now
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
