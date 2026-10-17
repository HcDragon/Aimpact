#!/usr/bin/env bash
# End-to-end smoke test against the local stack (supabase start + functions serve).
# Works without any AI keys: every AI path must fall back cleanly.
set -eu
API=${API:-http://127.0.0.1:54321}
ANON=${ANON:-$(npx supabase status -o json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["ANON_KEY"])')}
SERVICE=${SERVICE:-$(npx supabase status -o json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["SERVICE_ROLE_KEY"])')}
SHOP=aaaaaaaa-0000-0000-0000-000000000001
REST=aaaaaaaa-0000-0000-0000-000000000002

login() {
  curl -s "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}
TOKEN=$(login shop@demo.test)
RTOKEN=$(login restaurant@demo.test)

fn()  { curl -s "$API/functions/v1/$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"; echo; }
rfn() { curl -s "$API/functions/v1/$1" -H "Authorization: Bearer $RTOKEN" -H 'Content-Type: application/json' -d "$2"; echo; }
sfn() { curl -s "$API/functions/v1/$1" -H "Authorization: Bearer $SERVICE" -H 'Content-Type: application/json' -d "$2"; echo; }
rpc() { curl -s "$API/rest/v1/rpc/$1" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"; echo; }

echo "== RLS: shop user cannot see restaurant data";  curl -s "$API/rest/v1/products?business_id=eq.$REST&select=name" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN"; echo
echo "== RLS: cross-business RPC is refused";         rpc dashboard "{\"p_business_id\":\"$REST\"}" | head -c 200; echo
echo "== assistant";            fn assistant "{\"business_id\":\"$SHOP\",\"question\":\"Aaj kitna becha?\"}" | head -c 400; echo
echo "== voice-command (text)"; fn voice-command "{\"business_id\":\"$SHOP\",\"text\":\"2 maggi becha\"}"
echo "== voice-command check";  fn voice-command "{\"business_id\":\"$SHOP\",\"text\":\"parle g kitna bacha hai\"}"
echo "== product-search text";  fn product-search "{\"business_id\":\"$SHOP\",\"text\":\"sunflower oil\"}" | head -c 400; echo
echo "== scan-bill (no key -> manual fallback)"; fn scan-bill "{\"business_id\":\"$SHOP\",\"image_base64\":\"data:image/png;base64,iVBORw0KGgo=\"}"
echo "== csv import preview";   rfn import-orders-csv "$(python3 -c 'import json; print(json.dumps({"business_id":"'$REST'","channel":"zomato","csv_text":"Order ID,Order Placed At,Items in order,Bill subtotal,Order Status\nZ1,15/10/2026 19:45,\"2 x Paneer Butter Masala, 3 x Butter Roti\",570,Delivered\nZ2,15/10/2026 20:10,1 x Chicken Biryani,280,Cancelled\nZ3,16/10/2026 13:05,1 x Dal Tadka|1 x Jeera Rce,300,Delivered\n"}))')"
echo "== bot: unknown chat";    sfn assistant '{"telegram_chat_id":42,"question":"hi"}'
echo "== bot: link code";       CODE=$(rpc create_telegram_link_code "{\"p_business_id\":\"$SHOP\"}" | tr -d '"'); sfn telegram-link "{\"action\":\"link\",\"code\":\"$CODE\",\"chat_id\":42}"
echo "== bot: as linked chat";  sfn voice-command '{"telegram_chat_id":42,"text":"sold 1 tata salt"}'
echo "== ai-worker";            sfn ai-worker '{"limit":3}'
echo "== notify-telegram";      sfn notify-telegram '{}'
echo "== non-service caller rejected"; fn ai-worker '{}'
