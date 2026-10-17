// Business settings, staff, Telegram linking, and where each feature's numbers come from.
import { Send, ShieldCheck, Store, Users } from "lucide-react";
import { useState } from "react";
import { Button, Card, Field, Form, Loaded, Page, Row, Select, Submit, Table, useLoad, useToast } from "../components/ui.jsx";
import { current, from, q, rpc } from "../lib/api.js";
import { fmtDateTime } from "../lib/format.js";

const SOURCES = [
  { f: "Stock, GST, profit, reorder points", by: "Postgres functions", fallback: "always works" },
  { f: "Demand forecasts, bundles", by: "Nightly Python job (Prophet, Apriori)", fallback: "28-day average, rule-based levels" },
  { f: "Dead stock, perishable risk, prep list", by: "Postgres functions over forecasts", fallback: "uses averages" },
  { f: "Bill scan", by: "Gemini, then offline EasyOCR", fallback: "manual entry" },
  { f: "Voice / text commands", by: "Gemini transcription + chat model", fallback: "rule-based parser" },
  { f: "Assistant, insights, review sentiment", by: "Chat model (Groq / Grok)", fallback: "plain numeric summary" },
  { f: "Photo / text product search", by: "Gemini embeddings (pgvector)", fallback: "text search" },
];

export function Settings() {
  const toast = useToast();
  const b = current.business;
  const me = current.session.user.id;
  const [code, setCode] = useState(null);
  const staff = useLoad(() => q(from("staff_roles").select("user_id, role, created_at").eq("business_id", b.id)));
  const links = useLoad(() => q(from("telegram_links").select("*").eq("business_id", b.id).not("telegram_chat_id", "is", null)));
  const canEdit = ["owner", "manager"].includes(b.role);

  return (
    <Page title="Settings">
      <Card icon={Store} title={`Business (${b.business_type}, you are ${b.role})`}>
        <Form onSubmit={async (v) => {
          const row = { ...v, lead_time_days: Number(v.lead_time_days), expiry_alert_days: Number(v.expiry_alert_days), gstin: v.gstin || null };
          Object.assign(b, await q(from("businesses").update(row).eq("id", b.id).select().single()));
          toast("Saved");
        }}>
          <Row>
            <Field label="Name"><input name="name" defaultValue={b.name} /></Field>
            <Field label="Language"><Select name="language" defaultValue={b.language} options={[["hinglish", "Hinglish"], ["hi", "हिंदी"], ["mr", "मराठी"], ["en", "English"]]} /></Field>
            <Field label="City"><input name="city" defaultValue={b.city ?? ""} /></Field>
          </Row>
          <Row className="mt-2">
            <Field label="GSTIN"><input name="gstin" defaultValue={b.gstin ?? ""} /></Field>
            <Field label="State code"><input name="state_code" defaultValue={b.state_code ?? ""} size={4} /></Field>
            <Field label="Supplier lead time (days)"><input name="lead_time_days" type="number" defaultValue={b.lead_time_days} /></Field>
            <Field label="Warn before expiry (days)"><input name="expiry_alert_days" type="number" defaultValue={b.expiry_alert_days} /></Field>
          </Row>
          <div className="mt-3">{canEdit ? <Submit>Save</Submit> : <span className="text-muted">Only owners and managers can edit.</span>}</div>
        </Form>
        <p className="mt-3 text-muted">Lead time drives the reorder point: forecast demand and safety stock are summed over this many days.</p>
      </Card>

      <Card icon={Send} title="Telegram">
        <p className="mb-2 text-muted">Link a chat to get alerts and use voice or text commands from Telegram.</p>
        <Button onClick={async () => setCode(await rpc("create_telegram_link_code"))}>Get Telegram link code</Button>
        {code && <p className="mt-2">Send this to the bot within 15 minutes: <strong className="text-xl">/start {code}</strong></p>}
        <div className="mt-3">
          <Loaded state={links}>{(rows) => (
            <Table rows={rows} rowKey={(r) => r.id} empty="No Telegram chats linked yet." columns={[
              { label: "Chat", key: "telegram_chat_id" },
              { label: "Linked", render: (r) => fmtDateTime(r.linked_at) },
              { label: "", render: (r) => r.user_id === me && <Button small variant="secondary" onClick={async () => { await q(from("telegram_links").delete().eq("id", r.id)); links.reload(); }}>Unlink</Button> },
            ]} />
          )}</Loaded>
        </div>
      </Card>

      <Card icon={Users} title="Staff">
        <Form className="flex flex-wrap items-end gap-2" onSubmit={async (v) => { await rpc("add_staff", { p_login: v.login, p_role: v.role }); toast("Staff added"); staff.reload(); }}>
          <Field label="Phone (91…) or email they signed up with"><input name="login" required /></Field>
          <Field label="Role"><Select name="role" options={[["staff", "Staff"], ["manager", "Manager"]]} /></Field>
          {b.role === "owner" ? <Submit>Add staff</Submit> : <span className="text-muted">Only the owner can add staff.</span>}
        </Form>
        <div className="mt-3">
          <Loaded state={staff}>{(rows) => (
            <Table rows={rows} rowKey={(r) => r.user_id} columns={[
              { label: "User", render: (r) => (r.user_id === me ? "You" : r.user_id.slice(0, 8) + "…") },
              { label: "Role", key: "role" },
              { label: "Since", render: (r) => fmtDateTime(r.created_at) },
            ]} />
          )}</Loaded>
        </div>
      </Card>

      <Card icon={ShieldCheck} title="Where the numbers come from">
        <Table rows={SOURCES} rowKey={(r) => r.f} columns={[{ label: "Feature", key: "f" }, { label: "Computed by", key: "by" }, { label: "Without AI", key: "fallback" }]} />
      </Card>
    </Page>
  );
}
