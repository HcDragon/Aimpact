// Business settings, staff, Telegram linking.
import { busy, card, field, fmtDateTime, formValues, h, q, rpc, select, state, supabase, table, toast } from "../lib.js";

export async function settings() {
  const b = state.business;
  const isOwner = b.role === "owner";
  const form = h("form", {},
    h("div", { class: "row" },
      field("Name", h("input", { name: "name", value: b.name })),
      field("Language", select([["hinglish", "Hinglish"], ["hi", "हिंदी"], ["mr", "मराठी"], ["en", "English"]], b.language, { name: "language" })),
      field("City", h("input", { name: "city", value: b.city ?? "" }))),
    h("div", { class: "row" },
      field("GSTIN", h("input", { name: "gstin", value: b.gstin ?? "" })),
      field("State code", h("input", { name: "state_code", value: b.state_code ?? "", size: 4 })),
      field("Supplier lead time (days)", h("input", { name: "lead_time_days", type: "number", value: b.lead_time_days })),
      field("Warn before expiry (days)", h("input", { name: "expiry_alert_days", type: "number", value: b.expiry_alert_days }))),
    h("p", {}, h("button", { disabled: !["owner", "manager"].includes(b.role) }, "Save")));
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(form);
      const row = { ...v, lead_time_days: Number(v.lead_time_days), expiry_alert_days: Number(v.expiry_alert_days), gstin: v.gstin || null };
      const updated = await q(supabase.from("businesses").update(row).eq("id", b.id).select().single());
      Object.assign(b, updated);
      toast("Saved");
    });
  };

  // staff
  const staffList = h("div");
  async function loadStaff() {
    const rows = await q(supabase.from("staff_roles").select("user_id, role, created_at").eq("business_id", b.id));
    staffList.replaceChildren(table([
      { label: "User", render: (r) => r.user_id === state.session.user.id ? "You" : r.user_id.slice(0, 8) + "…" },
      { label: "Role", key: "role" },
      { label: "Since", render: (r) => fmtDateTime(r.created_at) },
    ], rows));
  }
  const staffForm = h("form", { class: "row" },
    field("Phone (91…) or email they signed up with", h("input", { name: "login", required: true })),
    field("Role", select([["staff", "Staff"], ["manager", "Manager"]], "staff", { name: "role" })),
    h("button", { disabled: !isOwner }, "Add staff"));
  staffForm.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(staffForm);
      await rpc("add_staff", { p_login: v.login, p_role: v.role });
      toast("Staff added");
      loadStaff();
    });
  };
  await loadStaff();

  // telegram
  const tgBox = h("div");
  async function loadLinks() {
    const rows = await q(supabase.from("telegram_links").select("*").eq("business_id", b.id).not("telegram_chat_id", "is", null));
    tgBox.replaceChildren(table([
      { label: "Chat", key: "telegram_chat_id" },
      { label: "Linked", render: (r) => fmtDateTime(r.linked_at) },
      { label: "", render: (r) => r.user_id === state.session.user.id ? h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
        await q(supabase.from("telegram_links").delete().eq("id", r.id));
        loadLinks();
      }) }, "Unlink") : "" },
    ], rows, { empty: "No Telegram chats linked yet." }));
  }
  const codeOut = h("p");
  const codeBtn = h("button", { onclick: (e) => busy(e.target, async () => {
    const code = await rpc("create_telegram_link_code");
    codeOut.replaceChildren("Send this to the bot within 15 minutes: ", h("strong", { style: { fontSize: "20px" } }, `/start ${code}`));
  }) }, "Get Telegram link code");
  await loadLinks();

  return h("div", {}, h("h2", {}, "Settings"),
    card(`Business (${b.business_type}, you are ${b.role})`, form),
    card("Telegram", h("p", { class: "muted" }, "Link a chat to get alerts and use voice/text commands from Telegram."), codeBtn, codeOut, tgBox),
    card("Staff", staffForm, h("p"), staffList));
}
