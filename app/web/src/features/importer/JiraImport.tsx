import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { STATUS_CATEGORIES, type DryRunReport, type ImportMapping, type ImportRun, type JiraCredentials, type JiraProjectSummary, type StatusCategory } from '@outcome/shared';
import { api, ApiError } from '../../lib/api.js';
import { useMembers, useProjects, useTaskInvalidation } from '../../lib/queries.js';
import { Button, EmptyState, Field, Pill, useToast } from '../../ui/index.js';

type Step = 'connect' | 'select' | 'mapping' | 'dryrun' | 'summary';

interface MappingSuggestion {
  statuses: Record<string, StatusCategory>;
  priorities: Record<string, 'urgent' | 'high' | 'medium' | 'low' | 'none'>;
  users: Record<string, string | null>;
  userNames: Record<string, string>;
  unmapped: { statuses: string[]; users: string[] };
}

const STATUS_LABEL: Record<StatusCategory, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
};

/**
 * Jira import wizard: connect, pick a project, review the mapping, dry-run,
 * then import. Nothing is written before the dry-run report is shown.
 */
export function JiraImport(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const toast = useToast();
  const projects = useProjects(orgSlug);
  const members = useMembers(orgSlug);
  const invalidate = useTaskInvalidation(orgSlug);

  const [step, setStep] = useState<Step>('connect');
  const [credentials, setCredentials] = useState<JiraCredentials>({
    baseUrl: '',
    email: '',
    apiToken: '',
  });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [jiraProjects, setJiraProjects] = useState<JiraProjectSummary[]>([]);
  const [projectKey, setProjectKey] = useState('');
  const [suggestion, setSuggestion] = useState<MappingSuggestion | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [failedItems, setFailedItems] = useState<
    Array<{ externalId: string; error: string | null; summary: string }>
  >([]);

  const handle = (err: unknown): void => {
    if (err instanceof ApiError) {
      setFields(err.fields);
      setError(Object.keys(err.fields).length > 0 ? null : (err.body.detail ?? err.body.title));
    } else {
      setError('Something went wrong. Try again.');
    }
  };
  const clearErrors = (): void => {
    setFields({});
    setError(null);
  };

  const connect = useMutation({
    mutationFn: () =>
      api.post<{ items: JiraProjectSummary[] }>(`/orgs/${orgSlug}/imports/jira/projects`, credentials),
    onSuccess: (result) => {
      clearErrors();
      setJiraProjects(result.items);
      setStep('select');
    },
    onError: handle,
  });

  const loadMapping = useMutation({
    mutationFn: (key: string) =>
      api.post<MappingSuggestion>(`/orgs/${orgSlug}/imports/jira/mapping`, {
        credentials,
        projectKey: key,
      }),
    onSuccess: (result, key) => {
      clearErrors();
      setSuggestion(result);
      setMapping({
        projectKey: key,
        targetProjectId: null,
        statuses: result.statuses,
        priorities: result.priorities,
        users: result.users,
        includeComments: true,
        includeSubtasks: true,
      });
      setStep('mapping');
    },
    onError: handle,
  });

  const dryRun = useMutation({
    mutationFn: () =>
      api.post<{ run: ImportRun; report: DryRunReport }>(`/orgs/${orgSlug}/imports/jira/run`, {
        credentials,
        mapping,
        dryRun: true,
      }),
    onSuccess: (result) => {
      clearErrors();
      setReport(result.report);
      setStep('dryrun');
    },
    onError: handle,
  });

  const execute = useMutation({
    mutationFn: () =>
      api.post<{ run: ImportRun; report: DryRunReport }>(`/orgs/${orgSlug}/imports/jira/run`, {
        credentials,
        mapping,
        dryRun: false,
      }),
    onSuccess: async (result) => {
      clearErrors();
      setRun(result.run);
      invalidate();
      void projects.refetch();
      if (result.run.status === 'completed_with_errors') {
        const items = await api.get<{ items: typeof failedItems }>(
          `/orgs/${orgSlug}/imports/${result.run.id}/items?onlyFailed=true`,
        );
        setFailedItems(items.items);
      }
      setStep('summary');
      toast.push('Import finished', 'success');
    },
    onError: handle,
  });

  const retry = useMutation({
    mutationFn: () => api.post<ImportRun>(`/orgs/${orgSlug}/imports/${run!.id}/retry`, credentials),
    onSuccess: async (result) => {
      setRun(result);
      const items = await api.get<{ items: typeof failedItems }>(
        `/orgs/${orgSlug}/imports/${result.id}/items?onlyFailed=true`,
      );
      setFailedItems(items.items);
      invalidate();
      toast.push('Retried the failed records', 'info');
    },
    onError: handle,
  });

  const steps: Step[] = ['connect', 'select', 'mapping', 'dryrun', 'summary'];
  const busy = connect.isPending || loadMapping.isPending || dryRun.isPending || execute.isPending;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import from Jira</h1>
          <div className="page-sub">
            Migrate projects, epics, issues, subtasks, comments and dependencies. You review the
            mapping and a dry run before anything is written.
          </div>
        </div>
      </div>

      <nav className="tabs" aria-label="Import steps">
        {steps.map((s, i) => (
          <span
            key={s}
            className={`tab ${step === s ? 'active' : ''}`}
            aria-current={step === s ? 'step' : undefined}
          >
            {i + 1}. {s === 'dryrun' ? 'dry run' : s}
          </span>
        ))}
      </nav>

      {error && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {step === 'connect' && (
        <div className="card card-pad" style={{ maxWidth: 560 }}>
          <Field
            label="Jira site URL"
            error={fields['baseUrl']}
            hint="For example https://acme.atlassian.net — https only."
            required
          >
            {(props) => (
              <input
                {...props}
                className="input"
                value={credentials.baseUrl}
                onChange={(e) => setCredentials({ ...credentials, baseUrl: e.target.value })}
                placeholder="https://acme.atlassian.net"
              />
            )}
          </Field>
          <Field label="Jira account email" error={fields['email']} required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="email"
                value={credentials.email}
                onChange={(e) => setCredentials({ ...credentials, email: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="API token"
            error={fields['apiToken']}
            hint="Create one in Atlassian account settings. It is used for this import only and never stored in plain text."
            required
          >
            {(props) => (
              <input
                {...props}
                className="input"
                type="password"
                value={credentials.apiToken}
                onChange={(e) => setCredentials({ ...credentials, apiToken: e.target.value })}
              />
            )}
          </Field>
          <Button
            variant="primary"
            loading={connect.isPending}
            disabled={!credentials.baseUrl || !credentials.email || !credentials.apiToken}
            onClick={() => connect.mutate()}
          >
            Connect to Jira
          </Button>
        </div>
      )}

      {step === 'select' && (
        <div className="card">
          {jiraProjects.length === 0 ? (
            <EmptyState title="No Jira projects visible" body="Check that this account can see them." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Key</th>
                  <th>Name</th>
                  <th style={{ width: 100 }}>Issues</th>
                  <th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {jiraProjects.map((p) => (
                  <tr key={p.key}>
                    <td className="ref">{p.key}</td>
                    <td>{p.name}</td>
                    <td className="num">{p.issueCount}</td>
                    <td>
                      <Button
                        size="sm"
                        loading={loadMapping.isPending && projectKey === p.key}
                        onClick={() => {
                          setProjectKey(p.key);
                          loadMapping.mutate(p.key);
                        }}
                      >
                        Map fields
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {step === 'mapping' && mapping && suggestion && (
        <div className="stack" style={{ maxWidth: 780 }}>
          <div className="card card-pad">
            <h2 style={{ marginBottom: 10 }}>Destination</h2>
            <Field label="Import into" hint="Create a new project, or merge into an existing one.">
              {(props) => (
                <select
                  {...props}
                  className="select"
                  value={mapping.targetProjectId ?? ''}
                  onChange={(e) => setMapping({ ...mapping, targetProjectId: e.target.value || null })}
                >
                  <option value="">Create a new project</option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.key}>
                      {p.key} — {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="row">
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={mapping.includeSubtasks}
                  onChange={(e) => setMapping({ ...mapping, includeSubtasks: e.target.checked })}
                />
                Import subtasks
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={mapping.includeComments}
                  onChange={(e) => setMapping({ ...mapping, includeComments: e.target.checked })}
                />
                Import comments
              </label>
            </div>
          </div>

          <div className="card card-pad">
            <h2 style={{ marginBottom: 4 }}>Statuses</h2>
            <div className="page-sub" style={{ marginBottom: 10 }}>
              Unmapped statuses import into Backlog.
            </div>
            {[...new Set([...Object.keys(suggestion.statuses), ...suggestion.unmapped.statuses])].map(
              (name) => (
                <div className="row" key={name} style={{ padding: '4px 0' }}>
                  <span style={{ flex: 1 }}>{name}</span>
                  {suggestion.unmapped.statuses.includes(name) && !mapping.statuses[name] && (
                    <Pill tone="warn">unmapped</Pill>
                  )}
                  <select
                    className="select"
                    style={{ width: 170 }}
                    value={mapping.statuses[name] ?? ''}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        statuses: e.target.value
                          ? { ...mapping.statuses, [name]: e.target.value as StatusCategory }
                          : Object.fromEntries(
                              Object.entries(mapping.statuses).filter(([k]) => k !== name),
                            ),
                      })
                    }
                    aria-label={`Map Jira status ${name}`}
                  >
                    <option value="">Backlog (default)</option>
                    {STATUS_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {STATUS_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </div>
              ),
            )}
          </div>

          <div className="card card-pad">
            <h2 style={{ marginBottom: 4 }}>People</h2>
            <div className="page-sub" style={{ marginBottom: 10 }}>
              Unmatched Jira users leave tasks unassigned — nothing is guessed.
            </div>
            {Object.keys(suggestion.userNames).length === 0 && (
              <div className="page-sub">No assignees in this project.</div>
            )}
            {Object.entries(suggestion.userNames).map(([accountId, name]) => (
              <div className="row" key={accountId} style={{ padding: '4px 0' }}>
                <span style={{ flex: 1 }}>{name}</span>
                {!mapping.users[accountId] && <Pill tone="warn">unmatched</Pill>}
                <select
                  className="select"
                  style={{ width: 200 }}
                  value={mapping.users[accountId] ?? ''}
                  onChange={(e) =>
                    setMapping({
                      ...mapping,
                      users: { ...mapping.users, [accountId]: e.target.value || null },
                    })
                  }
                  aria-label={`Map Jira user ${name}`}
                >
                  <option value="">Leave unassigned</option>
                  {members.data?.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="row">
            <Button variant="primary" loading={dryRun.isPending} onClick={() => dryRun.mutate()}>
              Preview import (dry run)
            </Button>
            <Button variant="ghost" onClick={() => setStep('select')}>
              Back
            </Button>
          </div>
        </div>
      )}

      {step === 'dryrun' && report && (
        <div className="stack" style={{ maxWidth: 820 }}>
          <div className="card card-pad">
            <h2>Dry run — nothing has been imported yet</h2>
            <div className="page-sub" style={{ marginBottom: 10 }}>
              Destination: {report.targetProjectName}
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {Object.entries(report.willCreate).map(([kind, count]) => (
                <span className="chip" key={kind}>
                  {count} {kind}
                  {count === 1 ? '' : 's'}
                </span>
              ))}
            </div>
          </div>

          {report.conflicts.length > 0 && (
            <div className="card card-pad">
              <h3 style={{ marginBottom: 8 }}>Conflicts ({report.conflicts.length})</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>Issue</th>
                    <th>What</th>
                    <th style={{ width: 200 }}>What we will do</th>
                  </tr>
                </thead>
                <tbody>
                  {report.conflicts.slice(0, 100).map((c, i) => (
                    <tr key={`${c.externalId}-${i}`}>
                      <td className="ref">{c.externalId}</td>
                      <td>{c.detail}</td>
                      <td className="page-sub">{c.resolution}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.unsupported.length > 0 && (
            <div className="card card-pad">
              <h3 style={{ marginBottom: 6 }}>Not supported ({report.unsupported.length})</h3>
              <div className="page-sub" style={{ marginBottom: 8 }}>
                Listed rather than dropped silently.
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {report.unsupported.slice(0, 50).map((u) => (
                  <li key={u} className="page-sub">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="row">
            <Button variant="primary" loading={execute.isPending} onClick={() => execute.mutate()}>
              Import for real
            </Button>
            <Button variant="ghost" onClick={() => setStep('mapping')}>
              Change the mapping
            </Button>
          </div>
        </div>
      )}

      {step === 'summary' && run && (
        <div className="stack" style={{ maxWidth: 820 }}>
          <div className="card card-pad">
            <div className="row" style={{ marginBottom: 8 }}>
              <h2 style={{ flex: 1 }}>Import {run.status.replace(/_/g, ' ')}</h2>
              {run.status === 'completed' ? (
                <Pill tone="good">No errors</Pill>
              ) : (
                <Pill tone="warn">Some records failed</Pill>
              )}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th style={{ width: 100 }}>Imported</th>
                  <th style={{ width: 100 }}>Skipped</th>
                  <th style={{ width: 100 }}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...new Set([
                    ...Object.keys(run.stats.imported),
                    ...Object.keys(run.stats.skipped),
                    ...Object.keys(run.stats.failed),
                  ]),
                ].map((kind) => (
                  <tr key={kind}>
                    <td>{kind}</td>
                    <td className="num">{run.stats.imported[kind] ?? 0}</td>
                    <td className="num">{run.stats.skipped[kind] ?? 0}</td>
                    <td className="num">{run.stats.failed[kind] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {run.stats.duplicates > 0 && (
              <div className="page-sub" style={{ marginTop: 8 }}>
                {run.stats.duplicates} issue(s) were skipped as duplicates of existing tasks.
              </div>
            )}
          </div>

          {failedItems.length > 0 && (
            <div className="card card-pad">
              <h3 style={{ marginBottom: 8 }}>Failed records ({failedItems.length})</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>Issue</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {failedItems.map((item) => (
                    <tr key={item.externalId}>
                      <td className="ref">{item.externalId}</td>
                      <td className="page-sub">{item.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button style={{ marginTop: 10 }} loading={retry.isPending} onClick={() => retry.mutate()}>
                Retry failed records
              </Button>
            </div>
          )}

          <div className="row">
            <Button
              variant="ghost"
              onClick={() => {
                setStep('connect');
                setRun(null);
                setReport(null);
                setFailedItems([]);
              }}
            >
              Import another project
            </Button>
          </div>
        </div>
      )}

      {busy && (
        <div className="alert" role="status" style={{ marginTop: 12 }}>
          Talking to Jira…
        </div>
      )}
    </>
  );
}
