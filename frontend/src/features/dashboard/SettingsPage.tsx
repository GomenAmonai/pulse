import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Send, Trash2, Webhook } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";

import { useToast } from "../../components/Toast";
import { Button, Card, Field, inputClass, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/errors";
import type { Channel, ChannelKind } from "../../lib/types";
import { Segmented } from "./MonitorDetail";

export function SettingsPage() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold title">Notifications</h1>
        <p className="mt-1 text-sm text-muted">Where Pulse sends incident opened and resolved events.</p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <Channels />
        <div className="space-y-6">
          <AddChannel />
          <StatusPages />
        </div>
      </div>
    </>
  );
}

function Channels() {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: ["channels"], queryFn: api.channels });
  const test = useMutation({
    mutationFn: (id: number) => api.testChannel(id),
    onSuccess: (result) => toast(result.detail, result.ok ? "success" : "error"),
    onError: (error) => toast(error.message, "error"),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteChannel(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["channels"] }),
  });

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-medium">Channels</h2>
      </div>
      {!query.data ? (
        <div className="p-5">
          <Skeleton className="h-12" />
        </div>
      ) : query.data.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-muted">No channels yet. Incidents are only shown in the dashboard.</p>
      ) : (
        <ul className="divide-y divide-border">
          <AnimatePresence initial={false}>
            {query.data.map((c) => (
              <motion.li
                key={c.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              >
                <ChannelRow channel={c} onTest={() => test.mutate(c.id)} testing={test.isPending && test.variables === c.id} onDelete={() => remove.mutate(c.id)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  );
}

function ChannelRow({ channel: c, onTest, testing, onDelete }: { channel: Channel; onTest: () => void; testing: boolean; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border text-muted">
        {c.kind === "webhook" ? <Webhook className="size-4" /> : <Send className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{c.name}</div>
        <div className="mono truncate text-xs text-muted">{c.target}</div>
      </div>
      <Button size="sm" onClick={onTest} disabled={testing}>
        {testing ? "Sending…" : "Send test"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${c.name}`}>
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

function AddChannel() {
  const client = useQueryClient();
  const [kind, setKind] = useState<ChannelKind>("webhook");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createChannel({ kind, name: name || (kind === "webhook" ? "Webhook" : "Telegram"), target }),
    onSuccess: (channel) => {
      void client.invalidateQueries({ queryKey: ["channels"] });
      setSecret(channel.secret ?? null);
      setName("");
      setTarget("");
    },
    onError: (e) => setError(e instanceof ApiError ? (e.fields._ ?? e.fields.target ?? e.message) : e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium">Add a channel</h2>
        <Segmented
          value={kind === "webhook" ? "Webhook" : "Telegram"}
          onChange={(v) => {
            setKind(v === "Webhook" ? "webhook" : "telegram");
            setError(null);
          }}
          options={["Webhook", "Telegram"]}
        />
      </div>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "webhook" ? "Ops webhook" : "On-call chat"} />
        </Field>
        <Field
          label={kind === "webhook" ? "URL" : "Chat id"}
          error={error ?? undefined}
          hint={
            kind === "webhook"
              ? "POSTed JSON, signed with HMAC-SHA256 in X-Pulse-Signature."
              : "Numeric chat id or @channel. Needs TELEGRAM_BOT_TOKEN on the server."
          }
        >
          <input
            className={`${inputClass} mono`}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setError(null);
            }}
            placeholder={kind === "webhook" ? "https://hooks.example.com/pulse" : "-1001234567890"}
            aria-invalid={!!error}
            autoCapitalize="off"
            spellCheck={false}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" disabled={create.isPending || !target}>
          Add channel
        </Button>
      </form>
      <AnimatePresence>{secret && <Secret value={secret} onDone={() => setSecret(null)} />}</AnimatePresence>
    </Card>
  );
}

function Secret({ value, onDone }: { value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.3 }}
      className="overflow-hidden"
    >
      <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3">
        <p className="text-[13px] font-medium">Signing secret</p>
        <p className="mt-0.5 text-xs text-muted">Shown once. Verify webhooks with it, then store it somewhere safe.</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="mono min-w-0 flex-1 truncate rounded bg-surface px-2 py-1.5 text-xs">{value}</code>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(value);
              setCopied(true);
            }}
            aria-label="Copy secret"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function StatusPages() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["status-pages"], queryFn: api.statusPages });
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () => api.createStatusPage({ slug, title }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["status-pages"] });
      setSlug("");
      setTitle("");
    },
    onError: (e) => setErrors(e instanceof ApiError ? (e.code === "slug_taken" ? { slug: e.message } : e.fields) : { _: e.message }),
  });

  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium">Status pages</h2>
      <p className="mt-1 text-[13px] text-muted">Public, no login. Attach monitors from the monitor form.</p>
      <ul className="mt-3 space-y-2">
        {query.data?.map((p) => (
          <li key={p.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
            <span>
              {p.title} <span className="text-xs text-muted">· {p.monitor_ids.length} monitors</span>
            </span>
            <Link to={`/status/${p.slug}`} className="mono text-xs underline underline-offset-4">
              /status/{p.slug}
            </Link>
          </li>
        ))}
      </ul>
      {query.data && query.data.length === 0 && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            create.mutate();
          }}
        >
          <Field label="Title" error={errors.title}>
            <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme" />
          </Field>
          <Field label="Address" error={errors.slug} hint="Lowercase letters, digits and dashes.">
            <input className={`${inputClass} mono`} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="acme" />
          </Field>
          <Button type="submit" className="w-full" disabled={!slug || !title || create.isPending}>
            Create status page
          </Button>
        </form>
      )}
    </Card>
  );
}
