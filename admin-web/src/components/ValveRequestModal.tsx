import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ValveRequest } from '../api/types';
import { formatMoney } from '../lib/format';
import { Button, ErrorNote, Modal, Select, Textarea, useToast } from './ui';

export interface ValveTarget {
  meterId: string;
  accountNo: string;
  holderName: string;
  amountDueCents?: number;
  overdueBills?: number;
}

const CUT_REASONS = ['Non-payment: overdue bills', 'Illegal connection or tampering', 'Requested by the consumer', 'Emergency or maintenance', 'Other'];
const RESTORE_REASONS = ['Outstanding balance paid', 'Payment plan agreed', 'Requested by the consumer', 'Maintenance completed', 'Other'];

/**
 * Request to cut or restore a consumer's supply. The request needs a reason and
 * is carried out only after a second officer approves it.
 */
export function ValveRequestModal({ target, action, onClose }: { target: ValveTarget | null; action: 'CLOSE' | 'OPEN'; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const reasons = action === 'CLOSE' ? CUT_REASONS : RESTORE_REASONS;
  const [reason, setReason] = useState(reasons[0]);
  const [note, setNote] = useState('');

  // Reset the form each time it opens; for a cut, default to non-payment only when bills are overdue.
  useEffect(() => {
    if (!target) return;
    setReason(action === 'CLOSE' && !target.overdueBills ? 'Other' : (action === 'CLOSE' ? CUT_REASONS : RESTORE_REASONS)[0]);
    setNote('');
  }, [target, action]);

  const submit = useMutation({
    mutationFn: () =>
      api<ValveRequest>('/valve-requests', {
        method: 'POST',
        body: { meterId: target!.meterId, action, reason: note.trim() ? `${reason}. ${note.trim()}` : reason },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['valve-requests'] });
      void qc.invalidateQueries({ queryKey: ['arrears'] });
      void qc.invalidateQueries({ queryKey: ['account'] });
      toast('Request sent for approval by a second officer');
      onClose();
    },
  });

  const needsNote = reason === 'Other';
  const cut = action === 'CLOSE';
  return (
    <Modal
      open={!!target}
      onClose={() => {
        submit.reset();
        onClose();
      }}
      title={cut ? 'Request supply disconnection' : 'Request supply reconnection'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={cut ? 'danger' : 'primary'} loading={submit.isPending} disabled={needsNote && !note.trim()} onClick={() => submit.mutate()}>
            {cut ? 'Request disconnection' : 'Request reconnection'}
          </Button>
        </>
      }
    >
      {target && (
        <>
          <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm">
            <p className="font-medium text-slate-900">{target.holderName}</p>
            <p className="text-slate-600">
              Account {target.accountNo} · Meter {target.meterId}
            </p>
            {target.amountDueCents !== undefined && (
              <p className="mt-1 text-slate-600">
                Balance due <span className="font-medium text-slate-900">{formatMoney(target.amountDueCents)}</span>
                {target.overdueBills ? ` · ${target.overdueBills} overdue bill${target.overdueBills === 1 ? '' : 's'}` : ''}
              </p>
            )}
          </div>
          {cut && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                This will stop all water to the property once approved. Check that the consumer has been sent a final reminder, and that the premises is not a hospital, care home or
                other sensitive user.
              </p>
            </div>
          )}
          <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          <Textarea
            label={needsNote ? 'Details (required)' : 'Details (optional)'}
            value={note}
            maxLength={250}
            onChange={(e) => setNote(e.target.value)}
            hint="Recorded in the audit log and shown to the approving officer."
          />
          <ErrorNote error={submit.error} />
        </>
      )}
    </Modal>
  );
}
