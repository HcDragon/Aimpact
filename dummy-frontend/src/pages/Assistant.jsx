// Assistant (questions, text and voice commands with confirmation) and alerts.
import { useEffect, useRef, useState } from "react";
import { Button, Card, Field, Form, Loaded, Page, Pill, Row, Select, Table, useLoad, useToast } from "../components/ui.jsx";
import { fn, from, loadProducts, mine, q, rpc } from "../lib/api.js";
import { fmtDateTime } from "../lib/format.js";
import { fileToBase64, startRecording } from "../lib/media.js";

export function Assistant() {
  const toast = useToast();
  const [log, setLog] = useState([{ role: "bot", text: "Ask about sales, profit or stock, or give a command like “2 maggi becha”, “50 parle g aaya”, “Mehta ji 200 udhaar”." }]);
  const [mode, setMode] = useState("auto");
  const [stopRec, setStopRec] = useState(null);
  const history = useRef([]);
  const box = useRef(null);
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight); }, [log]);
  const say = (role, text, extra) => setLog((l) => [...l, { role, text, ...extra }]);

  const showCommand = (res) => {
    if (res.transcript) say("user", "🎤 " + res.transcript);
    if (!res.ok && !res.reply) return say("bot", res.reason ?? "Could not understand. Please use the forms.");
    say("bot", res.reply + (res.ai === false ? "\n(rule-based parser: AI unavailable)" : ""));
    if (res.warnings?.length) say("bot", "⚠️ " + res.warnings.join("\n"));
    if (res.needs_confirmation) say("bot", null, { draft: res.draft, id: Math.random() });
  };

  const resolveDraft = (id, text) => setLog((l) => l.map((m) => (m.id === id ? { role: "bot", text } : m)));

  const send = async (v, form) => {
    const text = v.text.trim();
    if (!text) return;
    form.reset();
    say("user", text);
    if (mode === "question") {
      const r = await fn("assistant", { question: text, history: history.current });
      history.current.push({ role: "user", content: text }, { role: "assistant", content: r.answer });
      say("bot", r.answer + (r.ai ? "" : "\n(plain summary: AI unavailable)"));
    } else {
      const r = await fn("voice-command", { text });
      if (r.intent === "question") history.current.push({ role: "user", content: text }, { role: "assistant", content: r.reply });
      showCommand({ ...r, transcript: undefined });
    }
  };

  const toggleMic = async () => {
    if (stopRec) {
      const wav = await stopRec();
      setStopRec(null);
      say("bot", "⏳ Listening…");
      showCommand(await fn("voice-command", { audio_base64: await fileToBase64(wav), mime_type: "audio/wav" }));
      return;
    }
    try { const stop = await startRecording(); setStopRec(() => stop); } catch (e) { toast("Microphone: " + e.message, "err"); }
  };

  return (
    <Page title="Assistant" intro="Hindi, Marathi, English or Hinglish. Voice is transcribed by Gemini; commands and answers come from the chat model. Every number comes from the database, and commands always ask for confirmation.">
      <Card>
        <div ref={box} role="log" className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto p-1">
          {log.map((m, i) => (
            <div key={i} className={`max-w-[80%] whitespace-pre-wrap rounded-xl px-3 py-2 ${m.role === "user" ? "self-end bg-accent text-on-accent" : "self-start border border-line bg-surface-2"}`}>
              {m.draft ? (
                <Row>
                  <Button onClick={async () => { const r = await fn("voice-command", { confirm: true, draft: m.draft }); resolveDraft(m.id, r.reply); await loadProducts(); }}>✅ Confirm</Button>
                  <Button variant="secondary" onClick={() => resolveDraft(m.id, "Cancelled")}>Cancel</Button>
                </Row>
              ) : m.text}
            </div>
          ))}
        </div>
        <Form onSubmit={send} className="mt-3 flex flex-wrap items-end gap-2">
          <Select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value)} options={[["auto", "Auto (command or question)"], ["question", "Question only"]]} />
          <input name="text" aria-label="Message" placeholder="Type a question or command…" className="min-w-44 flex-1" />
          <button type="submit" className="cursor-pointer rounded-md border border-accent bg-accent px-3 py-1.5 text-on-accent">Send</button>
        </Form>
        <div className="mt-3"><Button variant="secondary" onClick={toggleMic}>{stopRec ? "⏹ Stop recording" : "🎤 Record voice note"}</Button></div>
      </Card>
    </Page>
  );
}

export function Alerts() {
  const toast = useToast();
  const [status, setStatus] = useState("open");
  const state = useLoad(() => q(mine("alerts").eq("status", status).order("created_at", { ascending: false }).limit(200)), [status]);
  return (
    <Page title="Alerts" intro="Recomputed daily at 06:00 IST and after every stock movement; linked Telegram chats get them at 07:00. New alerts pop up live.">
      <Card>
        <Row className="mb-3">
          <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)} options={[["open", "Open"], ["resolved", "Resolved"], ["dismissed", "Dismissed"]]} /></Field>
          <Button variant="secondary" onClick={async () => { const n = await rpc("refresh_alerts"); toast(`Checked stock and expiry (${n} stock alerts)`); state.reload(); }}>Re-check now</Button>
        </Row>
        <Loaded state={state}>{(rows) => (
          <Table rows={rows} rowKey={(a) => a.id} empty="No alerts" columns={[
            { label: "", render: (a) => <Pill tone={a.severity}>{a.kind.replace("_", " ")}</Pill> },
            { label: "Message", key: "message" },
            { label: "When", render: (a) => fmtDateTime(a.created_at) },
            { label: "", render: (a) => a.status === "open" && (
              <Button small variant="secondary" onClick={async () => { await q(from("alerts").update({ status: "dismissed" }).eq("id", a.id)); state.reload(); }}>Dismiss</Button>) },
          ]} />
        )}</Loaded>
      </Card>
    </Page>
  );
}
