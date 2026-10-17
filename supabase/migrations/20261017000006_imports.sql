-- Bulk sales import (Zomato / Swiggy CSV exports). Idempotent on (business, channel, external_order_id).
-- orders: [{external_order_id, sold_at, items: [{product_id, qty}]}]
create or replace function public.import_sales(p_business_id uuid, p_channel text, p_orders jsonb)
returns jsonb language plpgsql as $$
declare v_o jsonb; v_r jsonb; v_new int := 0; v_dup int := 0; v_err jsonb := '[]'::jsonb;
begin
  perform public.assert_member(p_business_id);
  if p_channel not in ('zomato', 'swiggy', 'other') then raise exception 'channel must be zomato, swiggy or other'; end if;
  perform set_config('app.skip_alerts', 'on', true);
  for v_o in select * from jsonb_array_elements(p_orders) loop
    begin
      v_r := public.record_sale(p_business_id, v_o -> 'items', 'online', p_channel, null,
        coalesce((v_o ->> 'sold_at')::timestamptz, now()), v_o ->> 'external_order_id');
      if (v_r ->> 'duplicate')::boolean then v_dup := v_dup + 1; else v_new := v_new + 1; end if;
    exception when others then
      v_err := v_err || jsonb_build_object('external_order_id', v_o ->> 'external_order_id', 'error', sqlerrm);
    end;
  end loop;
  perform set_config('app.skip_alerts', 'off', true);
  perform public.refresh_stock_alerts(p_business_id, null);
  return jsonb_build_object('imported', v_new, 'duplicates', v_dup, 'errors', v_err);
end;
$$;
