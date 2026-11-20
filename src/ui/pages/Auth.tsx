import { useState } from "react";
import { deviceLabel, loginWithPasskey, setupWithPasskey } from "../api";
import { Button, Card, ErrorNote, Field, Input } from "../components";
import type { OwnerStatus } from "../main";

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center p-4">
      <Card className="w-full max-w-sm space-y-5 p-6">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <h1 className="text-lg font-semibold">{title}</h1>
        </div>
        {children}
      </Card>
    </div>
  );
}

export function SetupPage({ status, onDone }: { status: OwnerStatus; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!status.setupCodeConfigured) {
    return (
      <Frame title="Finish setup">
        <p className="text-sm text-subtle">
          This hub has no <code>SETUP_CODE</code> secret yet (or it's shorter than 24 characters). Add it in the Cloudflare dashboard under your Worker's <em>Settings → Variables and Secrets</em>, then reload this page.
        </p>
      </Frame>
    );
  }
  return (
    <Frame title={status.otherHostPasskeys > 0 && !status.hasPasskeys ? "Register a passkey for this address" : "Set up your hub"}>
      <p className="text-sm text-subtle">
        {status.otherHostPasskeys > 0 && !status.hasPasskeys
          ? `Passkeys only work on the address they were created on, and this is ${status.rpId}. Enter your setup code to add one here.`
          : "Enter the setup code you chose when deploying, then create a passkey. You'll use it to sign in from now on."}
      </p>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await setupWithPasskey(code.trim(), deviceLabel());
            onDone();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Setup code">
          <Input type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" className="w-full" busy={busy} disabled={code.length < 24}>
          Create passkey
        </Button>
      </form>
    </Frame>
  );
}

export function LoginPage({ status, onDone }: { status: OwnerStatus; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Frame title="Sign in">
      <p className="text-sm text-subtle">Use the passkey you registered for this hub.</p>
      <ErrorNote error={error} />
      <Button
        variant="primary"
        className="w-full"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await loginWithPasskey();
            onDone();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign in with passkey
      </Button>
      {!status.enrolOpen && !status.hasPasskeys && status.otherHostPasskeys > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Your passkeys were created on another address, and passkeys only work where they were made. To add one for {status.rpId}, set a new SETUP_CODE secret in the Cloudflare dashboard, then reload this page.
        </p>
      )}
      {status.enrolOpen && (
        <p className="text-center text-xs text-subtle">
          New device or address? <a className="underline" href="/setup">Use your setup code</a>
        </p>
      )}
    </Frame>
  );
}
