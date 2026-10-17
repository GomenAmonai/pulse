import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { Button, Field, inputClass } from "../../components/ui";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/errors";
import type { Monitor, MonitorInput } from "../../lib/types";

const INTERVALS = [30, 60, 120, 300, 600, 1800, 3600];
const label = (s: number) => (s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minute${s > 60 ? "s" : ""}` : "1 hour");

const EMPTY: MonitorInput = {
  name: "",
  url: "https://",
  method: "GET",
  interval_seconds: 60,
  timeout_seconds: 10,
  expected_status: 200,
  failure_threshold: 3,
  recovery_threshold: 2,
  status_page_id: null,
};

/** Create or edit a monitor in a side sheet. Errors come from the API, field by field. */
export function MonitorForm({ open, onClose, monitor }: { open: boolean; onClose: () => void; monitor?: Monitor }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={monitor ? "Edit monitor" : "New monitor"}
      description={monitor ? monitor.url : "Pulse will request this URL on a schedule and alert you when it fails."}
    >
      {/* Remount per open so the form starts from the monitor's current values. */}
      {open && <FormBody key={monitor?.id ?? "new"} monitor={monitor} onDone={onClose} />}
    </Sheet>
  );
}

function FormBody({ monitor, onDone }: { monitor?: Monitor; onDone: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const pages = useQuery({ queryKey: ["status-pages"], queryFn: api.statusPages });
  const [values, setValues] = useState<MonitorInput>(() => (monitor ? { ...EMPTY, ...monitor } : EMPTY));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof MonitorInput>(key: K, value: MonitorInput[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "", _: "" }));
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Partial<MonitorInput> = { ...values };
      if (!monitor) return api.createMonitor(body);
      // PATCH only what changed.
      for (const key of Object.keys(body) as (keyof MonitorInput)[]) if (body[key] === monitor[key]) delete body[key];
      return api.updateMonitor(monitor.id, body);
    },
    onSuccess: (saved) => {
      client.setQueryData(["monitor", saved.id], saved);
      void client.invalidateQueries({ queryKey: ["monitors"] });
      void client.invalidateQueries({ queryKey: ["status-pages"] });
      toast(monitor ? "Monitor saved" : `Monitoring ${saved.name}`, "success");
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 422) {
        const fields = error.fields;
        if (error.code === "blocked_target") fields.url = error.message;
        else if (error.code === "invalid") fields._ = error.message;
        setErrors(fields);
      } else toast(error.message, "error");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Field label="Name" error={errors.name}>
        <input
          className={inputClass}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Production API"
          aria-invalid={!!errors.name}
          maxLength={100}
        />
      </Field>
      <Field label="URL" error={errors.url} hint="Must resolve to a public address: localhost and private networks are refused.">
        <div className="flex gap-2">
          <select
            className={`${inputClass} w-24! shrink-0`}
            value={values.method}
            onChange={(e) => set("method", e.target.value as "GET" | "HEAD")}
            aria-label="HTTP method"
          >
            <option>GET</option>
            <option>HEAD</option>
          </select>
          <input
            className={`${inputClass} mono min-w-0`}
            value={values.url}
            onChange={(e) => set("url", e.target.value)}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!!errors.url}
          />
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Check every" error={errors.interval_seconds}>
          <select className={inputClass} value={values.interval_seconds} onChange={(e) => set("interval_seconds", Number(e.target.value))}>
            {INTERVALS.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeout, s" error={errors.timeout_seconds}>
          <input
            type="number"
            className={`${inputClass} mono`}
            min={1}
            max={30}
            value={values.timeout_seconds}
            onChange={(e) => set("timeout_seconds", Number(e.target.value))}
            aria-invalid={!!errors.timeout_seconds}
          />
        </Field>
        <Field label="Expected status" error={errors.expected_status}>
          <input
            type="number"
            className={`${inputClass} mono`}
            min={100}
            max={599}
            value={values.expected_status}
            onChange={(e) => set("expected_status", Number(e.target.value))}
            aria-invalid={!!errors.expected_status}
          />
        </Field>
        <Field label="Status page" error={errors.status_page_id}>
          <select
            className={inputClass}
            value={values.status_page_id ?? ""}
            onChange={(e) => set("status_page_id", e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Not shown</option>
            {pages.data?.map((p) => (
              <option key={p.id} value={p.id}>
                /{p.slug}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="rounded-lg border border-border p-4">
        <legend className="px-1 text-[13px] font-medium">Flap protection</legend>
        <p className="mb-4 text-[13px] text-muted">
          Open an incident after <b className="text-text">{values.failure_threshold}</b> failed checks in a row and resolve it
          after <b className="text-text">{values.recovery_threshold}</b> good ones, so one dropped packet doesn't page anyone.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Stepper label="Failures to open" value={values.failure_threshold} onChange={(v) => set("failure_threshold", v)} error={errors.failure_threshold} />
          <Stepper label="Successes to close" value={values.recovery_threshold} onChange={(v) => set("recovery_threshold", v)} error={errors.recovery_threshold} />
        </div>
      </fieldset>

      {errors._ && <p className="rounded-md bg-down-soft px-3 py-2 text-[13px] text-down">{errors._}</p>}

      <div className="flex justify-end gap-2 border-t border-border pt-5">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : monitor ? "Save changes" : "Create monitor"}
        </Button>
      </div>
    </form>
  );
}

function Stepper({ label, value, onChange, error }: { label: string; value: number; onChange: (v: number) => void; error?: string }) {
  return (
    <Field label={label} error={error}>
      <div className="flex h-10 items-center rounded-md border border-border">
        <button type="button" className="pressable h-full w-10 text-muted hover:text-text disabled:opacity-40" onClick={() => onChange(value - 1)} disabled={value <= 1} aria-label={`Decrease ${label}`}>
          −
        </button>
        <span className="mono flex-1 text-center text-sm">{value}</span>
        <button type="button" className="pressable h-full w-10 text-muted hover:text-text disabled:opacity-40" onClick={() => onChange(value + 1)} disabled={value >= 10} aria-label={`Increase ${label}`}>
          +
        </button>
      </div>
    </Field>
  );
}
