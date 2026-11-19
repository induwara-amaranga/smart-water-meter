import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Printer, Search, UserPlus } from 'lucide-react';
import { type FormEvent, type ReactNode, useDeferredValue, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { CustomerRow, MeterRow, RegistrationResult, Zone } from '../api/types';
import { Badge, Button, Card, ErrorNote, Input, PageHeader, Select } from '../components/ui';

type CustomerMode = 'new' | 'existing';
type MeterMode = 'new' | 'existing' | 'later';

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{n}</span>
          {title}
        </span>
      }
    >
      {children}
    </Card>
  );
}

function Choice({ checked, onChange, title, detail }: { checked: boolean; onChange(): void; title: string; detail: string }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${checked ? 'border-blue-600 bg-blue-50/60 ring-1 ring-blue-600' : 'border-slate-300 hover:bg-slate-50'}`}>
      <input type="radio" checked={checked} onChange={onChange} className="mt-0.5 accent-blue-600" />
      <span>
        <span className="block font-medium text-slate-900">{title}</span>
        <span className="text-slate-600">{detail}</span>
      </span>
    </label>
  );
}

export function RegisterConsumerPage() {
  const [customerMode, setCustomerMode] = useState<CustomerMode>('new');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [search, setSearch] = useState('');
  const [existing, setExisting] = useState<CustomerRow | null>(null);

  const [address, setAddress] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [label, setLabel] = useState('Home');
  const [holderName, setHolderName] = useState('');

  const [meterMode, setMeterMode] = useState<MeterMode>('new');
  const [newMeterId, setNewMeterId] = useState('');
  const [existingMeterId, setExistingMeterId] = useState('');
  const [result, setResult] = useState<RegistrationResult | null>(null);

  const deferredSearch = useDeferredValue(search);
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<Zone[]>('/zones') });
  const meters = useQuery({ queryKey: ['meters', 'unassigned'], queryFn: () => api<MeterRow[]>('/meters?status=unassigned') });
  const customers = useQuery({
    queryKey: ['customers', deferredSearch],
    queryFn: () => api<CustomerRow[]>(`/customers?q=${encodeURIComponent(deferredSearch.trim())}`),
    enabled: customerMode === 'existing' && deferredSearch.trim().length >= 2,
  });

  const register = useMutation({
    mutationFn: () =>
      api<RegistrationResult>('/registrations', {
        method: 'POST',
        body: {
          customer: customerMode === 'existing' ? { existingId: existing!.id } : { name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined },
          account: { address: address.trim(), zoneId: zoneId ? Number(zoneId) : null, label: label.trim() || 'Home', holderName: holderName.trim() || undefined },
          meter:
            meterMode === 'existing' ? { mode: 'existing', meterId: existingMeterId } : meterMode === 'new' ? { mode: 'new', meterId: newMeterId.trim() || undefined } : { mode: 'later' },
        },
      }),
    onSuccess: setResult,
  });

  const customerOk = customerMode === 'existing' ? !!existing : name.trim().length >= 2 && (!!phone.trim() || !!email.trim());
  const meterOk = meterMode !== 'existing' || !!existingMeterId;
  const valid = customerOk && address.trim().length >= 3 && meterOk;

  function reset() {
    setResult(null);
    register.reset();
    setName('');
    setPhone('');
    setEmail('');
    setExisting(null);
    setSearch('');
    setAddress('');
    setHolderName('');
    setLabel('Home');
    setNewMeterId('');
    setExistingMeterId('');
    void meters.refetch();
  }

  if (result) return <RegistrationSlip result={result} onAnother={reset} />;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid) register.mutate();
  }

  return (
    <form onSubmit={submit}>
      <PageHeader
        title="Register consumer"
        description="Open a new service connection. The consumer can sign in to the Smart Water app with the mobile number or email you enter here, and will see the account straight away."
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Step n={1} title="Consumer">
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              <Choice checked={customerMode === 'new'} onChange={() => setCustomerMode('new')} title="New consumer" detail="First connection for this person" />
              <Choice checked={customerMode === 'existing'} onChange={() => setCustomerMode('existing')} title="Existing consumer" detail="Add another connection" />
            </div>
            {customerMode === 'new' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Input label="Full name" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
                </div>
                <Input label="Mobile number" placeholder="07X XXX XXXX" value={phone} onChange={(e) => setPhone(e.target.value)} hint="Used to sign in to the app (one-time code)." />
                <Input label="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                  <Input aria-label="Search consumers" placeholder="Search by name, mobile or email" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
                </div>
                {existing && (
                  <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{existing.name}</span> · {existing.phone ?? existing.email}
                    </span>
                    <Badge tone="info">Selected</Badge>
                  </div>
                )}
                <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                  {(customers.data ?? []).map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setExisting(c)} className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50">
                        <span>
                          <span className="font-medium text-slate-900">{c.name || '(no name)'}</span>
                          <span className="block text-slate-500">{c.phone ?? c.email}</span>
                        </span>
                        <span className="text-xs text-slate-500">{c.accounts} account(s)</span>
                      </button>
                    </li>
                  ))}
                  {search.trim().length >= 2 && customers.data?.length === 0 && <li className="px-3 py-3 text-sm text-slate-500">No consumers match.</li>}
                  {search.trim().length < 2 && <li className="px-3 py-3 text-sm text-slate-500">Type at least 2 characters.</li>}
                </ul>
              </div>
            )}
          </Step>

          <Step n={2} title="Service connection">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Input label="Premises address" required value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
              <Select label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                <option value="">Not set</option>
                {(zones.data ?? []).map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </Select>
              <Input label="Name shown in the app" value={label} onChange={(e) => setLabel(e.target.value)} hint="e.g. Home, Shop" />
              <div className="sm:col-span-2">
                <Input
                  label="Account holder (optional)"
                  value={holderName}
                  onChange={(e) => setHolderName(e.target.value)}
                  hint="Leave empty to use the consumer's name. Use a business name for commercial connections."
                />
              </div>
            </div>
          </Step>
        </div>

        <div className="space-y-6">
          <Step n={3} title="Meter">
            <div className="space-y-2">
              <Choice checked={meterMode === 'new'} onChange={() => setMeterMode('new')} title="Register a new meter" detail="Creates the meter's login secret and claim code to print and install." />
              <Choice checked={meterMode === 'existing'} onChange={() => setMeterMode('existing')} title="Use a meter already in stock" detail="Pick a registered meter that is not assigned yet." />
              <Choice checked={meterMode === 'later'} onChange={() => setMeterMode('later')} title="Assign later" detail="Open the account now and install the meter later." />
            </div>
            {meterMode === 'new' && (
              <div className="mt-4">
                <Input label="Meter ID (optional)" placeholder="Next free number, e.g. SWM-000124" value={newMeterId} onChange={(e) => setNewMeterId(e.target.value.toUpperCase())} />
              </div>
            )}
            {meterMode === 'existing' && (
              <div className="mt-4">
                <Select label="Unassigned meter" value={existingMeterId} onChange={(e) => setExistingMeterId(e.target.value)} required>
                  <option value="">Choose a meter…</option>
                  {(meters.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} {m.online ? '(online)' : ''}
                    </option>
                  ))}
                </Select>
                {meters.data?.length === 0 && <p className="mt-2 text-sm text-slate-500">No unassigned meters in stock.</p>}
              </div>
            )}
          </Step>

          <Card>
            <ErrorNote error={register.error} />
            <div className={`flex flex-wrap items-center justify-between gap-3 ${register.error ? 'mt-4' : ''}`}>
              <p className="text-sm text-slate-600">{valid ? 'Ready to register.' : 'Fill in the consumer, address and meter choice.'}</p>
              <Button type="submit" icon={<UserPlus className="size-4" />} loading={register.isPending} disabled={!valid}>
                Register consumer
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </form>
  );
}

function RegistrationSlip({ result, onAnother }: { result: RegistrationResult; onAnother(): void }) {
  const m = result.meter;
  return (
    <>
      <div className="no-print">
        <PageHeader
          title="Consumer registered"
          actions={
            <>
              <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()}>
                Print slip
              </Button>
              <Button variant="secondary" onClick={onAnother}>
                Register another
              </Button>
              <Link to={`/consumers/${result.account.id}`}>
                <Button>Open account</Button>
              </Link>
            </>
          }
        />
      </div>
      <div className="print-area max-w-2xl space-y-6">
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <CheckCircle2 className="mt-0.5 size-6 text-emerald-700" />
          <div>
            <p className="font-semibold text-slate-900">Account {result.account.accountNo} is open</p>
            <p className="mt-1 text-sm text-slate-700">
              {result.customer.name} can sign in to the Smart Water app with {result.customer.phone ?? result.customer.email} and a one-time code.
            </p>
          </div>
        </div>
        <Card title="Connection details">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <dt className="text-slate-500">Consumer</dt>
            <dd>{result.customer.name}</dd>
            <dt className="text-slate-500">Account number</dt>
            <dd className="font-medium">{result.account.accountNo}</dd>
            <dt className="text-slate-500">Address</dt>
            <dd>{result.account.address}</dd>
            <dt className="text-slate-500">Meter</dt>
            <dd className="font-mono">{m?.meterId ?? 'To be assigned'}</dd>
          </dl>
        </Card>
        {m?.deviceSecret && (
          <Card title="New meter credentials">
            <p className="mb-3 text-sm text-slate-600">Shown once only. Load the secret into the meter's firmware and stick the claim code label on the meter.</p>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-slate-500">Device secret (MQTT password)</dt>
                <dd className="mt-1 break-all rounded-md bg-slate-100 px-3 py-2 font-mono">{m.deviceSecret}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Claim code (for the meter label)</dt>
                <dd className="mt-1 rounded-md bg-slate-100 px-3 py-2 font-mono text-lg tracking-widest">{m.claimCode}</dd>
              </div>
              <div>
                <dt className="text-slate-500">QR code content</dt>
                <dd className="mt-1 break-all font-mono text-xs text-slate-600">{m.qr}</dd>
              </div>
            </dl>
          </Card>
        )}
      </div>
    </>
  );
}
