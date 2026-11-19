import { Droplet } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorNote, Input } from '../components/ui';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Droplet className="mx-auto size-10 fill-blue-600 text-blue-600" />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Water Board Portal</h1>
          <p className="mt-1 text-sm text-slate-600">Sign in with your staff account</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <Input label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <ErrorNote error={error} />
          <Button type="submit" loading={busy} className="w-full">
            Sign in
          </Button>
        </form>
        {import.meta.env.DEV && (
          <p className="mt-4 text-center text-xs text-slate-500">Demo: admin@swm.local / Admin@123 (more logins in the backend README)</p>
        )}
      </div>
    </div>
  );
}
