import { useState, type FormEvent } from 'react';
import { createTimeOff, deleteTimeOff, type NewTimeOff } from '#/lib/api';
import { useAction } from '#/lib/hooks';
import type { ApiCall, Scope, TimeOffRequest, TimeOffStatus, TimeOffType, WhoAmI } from '#/lib/types';
import { Modal } from './modal';

/**
 * Returns today's date as `YYYY-MM-DD` for date inputs and Postgres `date` columns.
 *
 * It is the UTC date, so close to midnight it can differ from the local calendar day.
 */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Formats a request's date range, collapsing single-day requests to one date.
 */
function formatDates(r: TimeOffRequest) {
  return r.end_date === r.start_date ? r.start_date : `${r.start_date} → ${r.end_date}`;
}

/**
 * Shows a request's type as its color dot and label, falling back to the raw code for a type that is not
 * visible (or no longer exists).
 */
function TypeLabel({ type, code }: { type: TimeOffType | undefined; code: string }) {
  return (
    <>
      <span className="dot" style={{ background: type?.color }} />
      {type?.label ?? code}
    </>
  );
}

/**
 * Shows a request status as a colored badge; the stylesheet keys the color off the status name.
 */
function StatusBadge({ status }: { status: TimeOffStatus }) {
  return <span className={`status ${status}`}>{status}</span>;
}

/**
 * The admin scope toggle's choices, in display order.
 */
const SCOPES = [
  ['all', 'Everyone'],
  ['mine', 'Only mine'],
] as const;

/**
 * Lists the time-off requests row level security lets the current user see, with New request and per-row Delete dialogs.
 *
 * Admins get an Everyone / Only mine toggle and a Who column; rows owned by someone else get an admin-colored edge. Every PostgREST call a dialog makes is passed to `onCalls` for the request log.
 */
export function RequestsPanel(props: {
  requests: TimeOffRequest[];
  types: TimeOffType[];
  whoami: WhoAmI;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  onCalls: (calls: ApiCall[]) => void;
  onChanged: () => Promise<void>;
}) {
  const { requests, types, whoami, scope, onCalls, onChanged } = props;
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TimeOffRequest | null>(null);
  const typeByCode = new Map(types.map((t) => [t.code, t]));
  const showOwner = whoami.is_admin && scope === 'all';

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>
          Time off <span className="muted">({requests.length})</span>
        </h2>
        <div className="head-actions">
          {whoami.is_admin && (
            <div className="segmented">
              {SCOPES.map(([id, label]) => (
                <button key={id} className={scope === id ? 'active' : ''} onClick={() => props.onScopeChange(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <button className="btn primary" onClick={() => setCreating(true)}>
            New request
          </button>
        </div>
      </header>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {showOwner && <th>Who</th>}
              <th>Type</th>
              <th>Dates</th>
              <th className="num">Days</th>
              <th>Status</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.length === 0 && (
              <tr>
                <td colSpan={showOwner ? 7 : 6} className="empty">
                  No time off yet. Use <strong>New request</strong> to book some.
                </td>
              </tr>
            )}
            {requests.map((r) => {
              const mine = r.user_id === whoami.uid;
              return (
                <tr key={r.id} className={mine ? '' : 'others'}>
                  {showOwner && (
                    <td>
                      <div>{r.user_name ?? r.user_id}</div>
                      <div className="muted small">{r.user_email ?? r.user_id}</div>
                    </td>
                  )}
                  <td className="nowrap">
                    <TypeLabel type={typeByCode.get(r.type_code)} code={r.type_code} />
                  </td>
                  <td className="mono nowrap">
                    {formatDates(r)}
                    {r.half_day && <span className="muted"> ½</span>}
                  </td>
                  <td className="num mono">{r.days}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="reason">{r.reason ?? <span className="muted">–</span>}</td>
                  <td className="actions">
                    <button
                      className="btn danger small"
                      title={mine ? 'Delete your request' : 'Delete as admin'}
                      onClick={() => setDeleting(r)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {creating && (
        <NewRequestModal
          types={types}
          isAdmin={whoami.is_admin}
          onCalls={onCalls}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await onChanged();
          }}
        />
      )}
      {deleting && (
        <DeleteRequestModal
          request={deleting}
          type={typeByCode.get(deleting.type_code)}
          mine={deleting.user_id === whoami.uid}
          onCalls={onCalls}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

/**
 * Books time off through `createTimeOff`, defaulting to a one-day vacation starting today.
 *
 * Only admins see the `user_id` field for booking on someone else's behalf, since the insert policy rejects that for anyone else. PostgREST errors stay in the dialog, next to the form that caused them.
 */
function NewRequestModal({
  types,
  isAdmin,
  onCalls,
  onClose,
  onCreated,
}: {
  types: TimeOffType[];
  isAdmin: boolean;
  onCalls: (calls: ApiCall[]) => void;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [form, setForm] = useState<Required<NewTimeOff>>({
    type_code: types.find((t) => t.code === 'vacation')?.code ?? types[0]?.code ?? '',
    start_date: today(),
    end_date: today(),
    half_day: false,
    reason: '',
    user_id: '',
  });
  const { busy, error, run } = useAction();
  /**
   * Merges a partial update into the form so each input only names the fields it changes.
   */
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  /**
   * Creates the request, logs the PostgREST call whatever the outcome, and only closes the dialog when PostgREST accepted it.
   */
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const { result, calls } = await createTimeOff({ data: form });
      onCalls(calls);
      if (result.error) {
        return result.error;
      }
      await onCreated();
    });
  }

  return (
    <Modal title="New time off request" onClose={onClose} busy={busy}>
      <form onSubmit={submit}>
        <div className="modal-body form">
          <label>
            <span>Type</span>
            <select data-autofocus value={form.type_code} onChange={(e) => set({ type_code: e.target.value })}>
              {types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid">
            <label>
              <span>From</span>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) =>
                  set({
                    start_date: e.target.value,
                    end_date: form.end_date < e.target.value ? e.target.value : form.end_date,
                  })
                }
                required
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="date"
                value={form.end_date}
                min={form.start_date}
                disabled={form.half_day}
                onChange={(e) => set({ end_date: e.target.value })}
                required
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.half_day}
              onChange={(e) =>
                set({
                  half_day: e.target.checked,
                  end_date: e.target.checked ? form.start_date : form.end_date,
                })
              }
            />
            <span>Half day</span>
          </label>
          <label>
            <span>Reason</span>
            <textarea
              rows={2}
              value={form.reason}
              placeholder="Optional"
              onChange={(e) => set({ reason: e.target.value })}
            />
          </label>
          {isAdmin && (
            <label>
              <span>On behalf of (user_id)</span>
              <input
                value={form.user_id}
                placeholder="Leave empty to book for yourself"
                onChange={(e) => set({ user_id: e.target.value })}
              />
            </label>
          )}
          {error && <p className="error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Create request'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/**
 * Asks for confirmation before deleting a request, and says so explicitly when an admin is about to delete someone else's.
 *
 * Cancel carries `data-autofocus` so the safe choice has focus when the dialog opens.
 */
function DeleteRequestModal({
  request,
  type,
  mine,
  onCalls,
  onClose,
  onDeleted,
}: {
  request: TimeOffRequest;
  type: TimeOffType | undefined;
  mine: boolean;
  onCalls: (calls: ApiCall[]) => void;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const owner = request.user_name ?? request.user_email ?? request.user_id;

  /**
   * Deletes the request and logs the call; when RLS hides the row, the server reports zero deleted rows as an error and the dialog stays open.
   */
  function confirm() {
    void run(async () => {
      const { result, calls } = await deleteTimeOff({ data: { id: request.id } });
      onCalls(calls);
      if (result.error) {
        return result.error;
      }
      await onDeleted();
    });
  }

  return (
    <Modal title="Delete time off request?" onClose={onClose} busy={busy}>
      <div className="modal-body">
        {!mine && (
          <p className="notice">
            This request belongs to <strong>{owner}</strong>. You can delete it because you are an admin.
          </p>
        )}
        <dl className="kv summary">
          {!mine && (
            <>
              <dt>Who</dt>
              <dd>{owner}</dd>
            </>
          )}
          <dt>Type</dt>
          <dd>
            <TypeLabel type={type} code={request.type_code} />
          </dd>
          <dt>Dates</dt>
          <dd className="mono">
            {formatDates(request)}
            {request.half_day && ' (half day)'}
          </dd>
          <dt>Days</dt>
          <dd className="mono">{request.days}</dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={request.status} />
          </dd>
          {request.reason && (
            <>
              <dt>Reason</dt>
              <dd>{request.reason}</dd>
            </>
          )}
        </dl>
        <p className="muted small">This can't be undone.</p>
        {error && <p className="error">{error}</p>}
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn" data-autofocus disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn danger-solid" disabled={busy} onClick={confirm}>
          {busy ? 'Deleting…' : 'Delete request'}
        </button>
      </footer>
    </Modal>
  );
}
