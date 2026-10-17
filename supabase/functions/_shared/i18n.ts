// Short reply templates for confirmations. Numbers are filled in by local code, never by AI.
type Lang = "en" | "hi" | "mr" | "hinglish";
type Key =
  | "confirm_sale" | "confirm_stock" | "stock_level" | "stock_unknown" | "confirm_khata_credit"
  | "confirm_khata_payment" | "confirm_wastage" | "not_found" | "done" | "ai_down";

const T: Record<Key, Record<Lang, string>> = {
  confirm_sale: { en: "Record sale: {items}. Total {total}. Confirm?", hinglish: "Sale likhu: {items}. Total {total}. Confirm karein?", hi: "बिक्री दर्ज करें: {items}. कुल {total}. पक्का करें?", mr: "विक्री नोंदवू: {items}. एकूण {total}. नक्की करायचे?" },
  confirm_stock: { en: "Add stock: {items}. Confirm?", hinglish: "Stock add karu: {items}. Confirm karein?", hi: "स्टॉक जोड़ें: {items}. पक्का करें?", mr: "स्टॉक वाढवू: {items}. नक्की करायचे?" },
  stock_level: { en: "{name}: {qty} {unit} left.", hinglish: "{name}: {qty} {unit} bacha hai.", hi: "{name}: {qty} {unit} बचा है।", mr: "{name}: {qty} {unit} शिल्लक आहे." },
  stock_unknown: { en: "I could not find {name}.", hinglish: "{name} nahi mila.", hi: "{name} नहीं मिला।", mr: "{name} सापडले नाही." },
  confirm_khata_credit: { en: "Add {amount} udhaar for {customer}. Confirm?", hinglish: "{customer} ke khate mein {amount} udhaar likhu?", hi: "{customer} के खाते में {amount} उधार लिखें?", mr: "{customer} च्या खात्यात {amount} उधार लिहू?" },
  confirm_khata_payment: { en: "{customer} paid {amount}. Confirm?", hinglish: "{customer} ne {amount} jama kiye. Confirm?", hi: "{customer} ने {amount} जमा किए। पक्का करें?", mr: "{customer} यांनी {amount} जमा केले. नक्की?" },
  confirm_wastage: { en: "Log wastage: {items}. Confirm?", hinglish: "Wastage likhu: {items}. Confirm?", hi: "बर्बादी दर्ज करें: {items}. पक्का करें?", mr: "नासाडी नोंदवू: {items}. नक्की?" },
  not_found: { en: "New item(s), will be created: {names}.", hinglish: "Naye item banenge: {names}.", hi: "नए आइटम बनेंगे: {names}.", mr: "नवीन आयटम तयार होतील: {names}." },
  done: { en: "Done ✅", hinglish: "Ho gaya ✅", hi: "हो गया ✅", mr: "झाले ✅" },
  ai_down: { en: "AI is busy right now. Please use the form instead.", hinglish: "AI abhi busy hai. Form se entry karein.", hi: "AI अभी व्यस्त है। कृपया फ़ॉर्म से एंट्री करें।", mr: "AI सध्या व्यस्त आहे. कृपया फॉर्म वापरा." },
};

export function t(lang: string, key: Key, vars: Record<string, string | number> = {}) {
  const s = T[key][(lang as Lang)] ?? T[key].en;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}
