import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { Role, StaffUser } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, ErrorNote, Input, Modal, PageHeader, Select, Spinner, Td, Table, useToast } from '../components/ui';
import { formatDate, ROLE_DESCRIPTION, ROLE_LABEL } from '../lib/format';

const ROLES = Object.keys(ROLE_LABEL) as Role[];

/** Readable temporary password, e.g. "Tank-4821-Reef". */
function tempPassword() {
  const words = ['River', 'Lake', 'Tank', 'Rain', 'Reef', 'Well', 'Pipe', 'Flow', 'Dam', 'Brook'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}-${1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000)}-${pick()}`;
}

export function StaffPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const users = useQuery({ queryKey: ['staff'], queryFn: () => api<StaffUser[]>('/users') });

  const toggle = useMutation({
    mutationFn: (u: StaffUser) => api<StaffUser>(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }),
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: ['staff'] });
      toast(u.active ? `${u.name} can sign in again` : `${u.name} is disabled and signed out`, u.active ? 'good' : 'warning');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'critical'),
  });

  return (
    <>
      <PageHeader
        title="Staff"
        description="Who can use this portal and what they can do. Disabling a person signs them out everywhere."
        actions={
          <Button icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
            Add staff member
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card padded={false}>
          {users.isLoading ? (
            <Spinner />
          ) : users.error ? (
            <div className="p-4">
              <ErrorNote error={users.error} />
            </div>
          ) : (
            <Table head={['Name', 'Role', 'Status', 'Added', '']}>
              {users.data!.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'bg-slate-50/60'}>
                  <Td>
                    <p className="font-medium text-slate-900">
                      {u.name} {u.id === user?.id && <span className="text-xs font-normal text-slate-500">(you)</span>}
                    </p>
                    <p className="text-xs text-slate-500">{u.email}</p>
                  </Td>
                  <Td>{ROLE_LABEL[u.role]}</Td>
                  <Td>{u.active ? <Badge tone="good">Active</Badge> : <Badge tone="neutral">Disabled</Badge>}</Td>
                  <Td className="whitespace-nowrap text-slate-500">{formatDate(u.createdAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(u)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={() => setResetting(u)}>
                        Reset password
                      </Button>
                      {u.id !== user?.id && (
                        <Button size="sm" variant={u.active ? 'ghost' : 'secondary'} loading={toggle.isPending && toggle.variables?.id === u.id} onClick={() => toggle.mutate(u)}>
                          {u.active ? 'Disable' : 'Enable'}
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Roles">
          <dl className="space-y-4 text-sm">
            {ROLES.map((r) => (
              <div key={r}>
                <dt className="font-medium text-slate-900">{ROLE_LABEL[r]}</dt>
                <dd className="text-slate-600">{ROLE_DESCRIPTION[r]}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <AddStaffModal open={adding} onClose={() => setAdding(false)} />
      <EditStaffModal user={editing} self={editing?.id === user?.id} onClose={() => setEditing(null)} />
      <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />
    </>
  );
}

function AddStaffModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('CUSTOMER_SERVICE');
  const [password, setPassword] = useState(tempPassword);

  const create = useMutation({
    mutationFn: () => api<StaffUser>('/users', { method: 'POST', body: { name: name.trim(), email: email.trim(), role, password } }),
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: ['staff'] });
      toast(`${u.name} added. Share the temporary password with them securely.`);
      setName('');
      setEmail('');
      setPassword(tempPassword());
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add staff member"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={name.trim().length < 2 || !email.includes('@') || password.length < 8} onClick={() => create.mutate()}>
            Add staff member
          </Button>
        </>
      }
    >
      <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input label="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="They sign in with this email." />
      <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} hint={ROLE_DESCRIPTION[role]}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </Select>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input label="Temporary password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters. Copy it now and ask them to change it." />
        </div>
        <Button variant="secondary" className="mb-6" onClick={() => setPassword(tempPassword())}>
          New
        </Button>
      </div>
      <ErrorNote error={create.error} />
    </Modal>
  );
}

function EditStaffModal({ user, self, onClose }: { user: StaffUser | null; self: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('CUSTOMER_SERVICE');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (user && loadedFor !== user.id) {
    setLoadedFor(user.id);
    setName(user.name);
    setRole(user.role);
  }

  const save = useMutation({
    mutationFn: () => api<StaffUser>(`/users/${user!.id}`, { method: 'PATCH', body: { name: name.trim(), role } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff'] });
      toast('Saved');
      setLoadedFor(null);
      onClose();
    },
  });

  return (
    <Modal
      open={!!user}
      onClose={() => {
        setLoadedFor(null);
        save.reset();
        onClose();
      }}
      title={`Edit ${user?.name ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={name.trim().length < 2} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
      <Select label="Role" value={role} disabled={self} onChange={(e) => setRole(e.target.value as Role)} hint={self ? 'You cannot change your own role.' : ROLE_DESCRIPTION[role]}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </Select>
      <ErrorNote error={save.error} />
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: StaffUser | null; onClose(): void }) {
  const toast = useToast();
  const [password, setPassword] = useState(tempPassword);
  const reset = useMutation({
    mutationFn: () => api<StaffUser>(`/users/${user!.id}`, { method: 'PATCH', body: { password } }),
    onSuccess: () => {
      toast(`Password changed. ${user?.name} has been signed out everywhere.`);
      setPassword(tempPassword());
      onClose();
    },
  });

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Reset password for ${user?.name ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={reset.isPending} disabled={password.length < 8} onClick={() => reset.mutate()}>
            Set password
          </Button>
        </>
      }
    >
      <Input label="New temporary password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Share it with them securely. They are signed out of all sessions." />
      <ErrorNote error={reset.error} />
    </Modal>
  );
}
