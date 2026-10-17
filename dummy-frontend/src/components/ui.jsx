// Shared UI building blocks styled with Tailwind (tokens in src/index.css).
import { CircleCheck, Inbox, Info, TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { METHOD_LABEL } from "../lib/format.js";
import { detectBarcode } from "../lib/media.js";

export const cx = (...c) => c.filter(Boolean).join(" ");

// ---------------------------------------------------------------- toasts
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, type = "ok") => {
    const id = Math.random();
    setItems((xs) => [...xs, { id, msg, type }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), type === "err" ? 7000 : 3500);
  }, []);
  const look = { ok: [CircleCheck, "text-ok"], err: [TriangleAlert, "text-crit"], info: [Info, "text-accent"] };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2" aria-live="polite">
        {items.map((t) => {
          const [Icon, tone] = look[t.type];
          return (
            <div key={t.id} className="flex max-w-sm items-start gap-2.5 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
              <Icon className={cx("mt-0.5 size-4 shrink-0", tone)} />
              <span>{t.msg}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- data loading
/** Runs `load` on mount and whenever deps change; returns { data, error, loading, reload }. */
export function useLoad(load, deps = []) {
  const [state, setState] = useState({ loading: true });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await load(), loading: false });
    } catch (error) {
      console.error(error);
      setState({ error, loading: false });
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/** Renders children(data) once loaded, with skeleton and error states. */
export function Loaded({ state, children }) {
  if (state.error) return <ErrorBox error={state.error} />;
  if (state.data === undefined) return <Skeleton />;
  return children(state.data);
}

export const Skeleton = () => (
  <div className="animate-pulse space-y-2.5 py-1" aria-label="Loading">
    {[80, 65, 72].map((w) => <div key={w} className="h-3.5 rounded bg-surface-2" style={{ width: `${w}%` }} />)}
  </div>
);

export function ErrorBox({ error }) {
  return (
    <div className="rounded-xl border border-crit/30 bg-crit/5 p-4">
      <div className="mb-1 flex items-center gap-2 font-semibold text-crit"><TriangleAlert className="size-4" />Could not load this</div>
      <pre className="whitespace-pre-wrap text-xs text-muted">{error.message ?? String(error)}</pre>
    </div>
  );
}

export function Empty({ children, icon: Icon = Inbox }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-muted">
      <Icon className="size-8 opacity-40" strokeWidth={1.5} />
      <p className="max-w-sm">{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------- layout
export function Page({ title, intro, actions, children }) {
  return (
    <div className="mx-auto max-w-[1280px]">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2>{title}</h2>
          {intro && <p className="mt-1 max-w-3xl text-muted">{intro}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, subtitle, icon: Icon, actions, children, className, flush }) {
  return (
    <section className={cx("mb-5 rounded-2xl border border-line bg-surface shadow-card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-1">
          <div className="flex items-start gap-2.5">
            {Icon && <span className="mt-0.5 grid size-7 place-items-center rounded-lg bg-accent/10 text-accent"><Icon className="size-4" /></span>}
            <div>
              {title && <h3>{title}</h3>}
              {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "pb-2" : "px-5 pt-3 pb-5"}>{children}</div>
    </section>
  );
}

export const Grid = ({ children, wideLeft }) => (
  <div className={cx("grid gap-5", wideLeft ? "lg:grid-cols-[3fr_2fr]" : "md:grid-cols-2 xl:grid-cols-3")}>{children}</div>
);
export const Row = ({ children, className }) => <div className={cx("flex flex-wrap items-end gap-2.5", className)}>{children}</div>;
export const Note = ({ children, className }) => <p className={cx("text-muted", className)}>{children}</p>;

export function Field({ label, children }) {
  return (
    <label className="flex w-fit max-w-full flex-col gap-1.5 text-xs font-medium text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Select({ options, value, defaultValue, ...rest }) {
  return (
    <select value={value} defaultValue={defaultValue} {...rest}>
      {options.map(([v, l]) => <option key={String(v)} value={v}>{l}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- numbers
export const Kpis = ({ children, cols = "lg:grid-cols-4" }) => <div className={cx("mb-5 grid grid-cols-2 gap-3", cols)}>{children}</div>;

const KPI_TONE = { accent: "bg-accent/10 text-accent", ok: "bg-ok/10 text-ok", warn: "bg-warn/10 text-warn", crit: "bg-crit/10 text-crit", pink: "bg-series-b/10 text-series-b" };
export function Kpi({ label, value, hint, icon: Icon, tone = "accent", plain }) {
  return (
    <div className={cx("min-w-0 rounded-2xl border border-line p-4", plain ? "bg-surface-2/60" : "bg-surface shadow-card")}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-muted">{label}</div>
        {Icon && <span className={cx("grid size-8 shrink-0 place-items-center rounded-lg", KPI_TONE[tone])}><Icon className="size-4" /></span>}
      </div>
      <div className="mt-1 text-[22px] leading-tight font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]">{value}</div>
      {hint && <div className="mt-1.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const PILL = {
  "": "bg-surface-2 text-muted ring-line", info: "bg-ok/10 text-ok ring-ok/20", ok: "bg-ok/10 text-ok ring-ok/20",
  warning: "bg-warn/10 text-warn ring-warn/25", critical: "bg-crit/10 text-crit ring-crit/20",
  positive: "bg-ok/10 text-ok ring-ok/20", neutral: "bg-warn/10 text-warn ring-warn/25", negative: "bg-crit/10 text-crit ring-crit/20",
  accent: "bg-accent/10 text-accent ring-accent/20",
  "method-prophet": "bg-series-b/10 text-series-b ring-series-b/20", "method-category": "bg-accent/10 text-accent ring-accent/20",
  "method-moving_average": "bg-accent/10 text-accent ring-accent/20", "method-seasonal_naive": "bg-warn/10 text-warn ring-warn/25",
  "method-rule": "bg-surface-2 text-muted ring-line",
};
export const Pill = ({ children, tone = "" }) => (
  <span className={cx("mr-1 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", PILL[tone] ?? PILL[""])}>{children}</span>
);
export const MethodPill = ({ method }) => <Pill tone={"method-" + method}>{METHOD_LABEL[method] ?? method ?? "-"}</Pill>;

export const Callout = ({ tone = "warn", icon: Icon, children }) => (
  <div className={cx("my-2 flex flex-wrap items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px]",
    tone === "ok" ? "bg-ok/10 text-ink ring-1 ring-ok/20" : tone === "info" ? "bg-accent/10 ring-1 ring-accent/20" : "bg-warn/10 ring-1 ring-warn/25")}>
    {Icon && <Icon className="size-4 shrink-0" />}{children}
  </div>
);

// ---------------------------------------------------------------- buttons
const BTN = {
  primary: "border-transparent bg-accent text-on-accent shadow-sm hover:bg-accent-strong",
  secondary: "border-line bg-surface text-ink shadow-xs hover:bg-surface-2",
  ghost: "border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-ink",
  link: "border-transparent bg-transparent p-0! h-auto! text-accent hover:underline text-left font-medium",
};
const btnClass = (variant, small, className) => cx(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-wait disabled:opacity-60",
  small ? "h-7 px-2.5 text-xs" : "h-9 px-3.5", BTN[variant], className);

/** Button whose async onClick disables it while running and reports errors as a toast. */
export function Button({ onClick, children, variant = "primary", small, icon: Icon, type = "button", className, ...rest }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    if (!onClick) return;
    setBusy(true);
    try { await onClick(e); } catch (err) { console.error(err); toast(err.message ?? String(err), "err"); } finally { setBusy(false); }
  };
  return (
    <button type={type} onClick={run} disabled={busy || rest.disabled} {...rest} className={btnClass(variant, small, className)}>
      {busy ? <Spinner /> : Icon && <Icon className={small ? "size-3.5" : "size-4"} />}
      {children}
    </button>
  );
}
const Spinner = () => <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />;

/** <form> whose async onSubmit(values, form) gets FormData values and reports errors as a toast. */
export function Form({ onSubmit, children, className }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { await onSubmit(Object.fromEntries(new FormData(e.currentTarget).entries()), e.currentTarget); }
    catch (err) { console.error(err); toast(err.message ?? String(err), "err"); }
    finally { setBusy(false); }
  };
  return <form onSubmit={submit} className={className}><fieldset disabled={busy} className="contents">{children}</fieldset></form>;
}
export const Submit = ({ children, variant = "primary", icon: Icon }) => (
  <button type="submit" className={btnClass(variant)}>{Icon && <Icon className="size-4" />}{children}</button>
);

// ---------------------------------------------------------------- tables
/** columns: [{ label, key?, render?(row), num? }] */
export function Table({ columns, rows, empty = "Nothing here yet.", rowKey }) {
  if (!rows?.length) return empty ? <Empty>{empty}</Empty> : null;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-line bg-surface-2/70">
            {columns.map((c, i) => (
              <th key={i} className={cx("px-5 py-2 text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted uppercase", c.num ? "text-right" : "text-left")}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r) : i} className="transition-colors hover:bg-surface-2/50">
              {columns.map((c, j) => (
                <td key={j} className={cx("px-5 py-2.5 align-middle", c.num && "text-right tabular-nums")}>{c.render ? c.render(r) : r[c.key] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- barcode scanner
/** Modal camera scanner; calls onResult(code | null). */
export function BarcodeScanner({ onResult }) {
  const video = useRef(null);
  const toast = useToast();
  useEffect(() => {
    const abort = new AbortController();
    let stream;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.current.srcObject = stream;
        await video.current.play();
        const code = await detectBarcode(video.current, abort.signal);
        if (!abort.signal.aborted) onResult(code);
      } catch (e) {
        toast("Camera not available: " + e.message, "err");
        onResult(null);
      }
    })();
    return () => { abort.abort(); stream?.getTracks().forEach((t) => t.stop()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-sm" role="dialog" aria-label="Barcode scanner">
      <div className="rounded-2xl bg-surface p-4 shadow-2xl">
        <p className="mb-3 font-medium">Point the camera at the barcode</p>
        <video ref={video} muted playsInline className="mb-3 block w-[min(80vw,480px)] rounded-xl" />
        <Button variant="secondary" onClick={() => onResult(null)}>Cancel</Button>
      </div>
    </div>
  );
}
