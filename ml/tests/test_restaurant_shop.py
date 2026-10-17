"""Ingredient demand, prep list, perishables, dead stock, bundles and matching on tiny inline frames."""

import datetime as dt

import pandas as pd
import pytest

from embeddings.match import match
from restaurant.ingredient_demand import ingredient_forecast, perishable_flags
from restaurant.prep_list import prep_list
from shop.bundles import bundle_rules
from shop.dead_stock import dead_stock
from tests.conftest import make_fc

TODAY = dt.date(2026, 10, 17)


def dish_fc():
    return pd.concat([make_fc("pbm", TODAY, [20.0, 10.0], [26.0, 14.0]),
                      make_fc("tikka", TODAY, [10.0, 5.0], [12.0, 7.0])])


RECIPES = pd.DataFrame({"dish_id": ["pbm", "pbm", "tikka"], "product_id": ["paneer", "butter", "paneer"],
                        "qty": [0.15, 0.02, 0.2]})


def test_ingredient_demand_is_forecast_times_recipe():
    ing = ingredient_forecast(dish_fc(), RECIPES)
    day0 = ing[(ing["item"] == "paneer") & (ing["ds"] == pd.Timestamp(TODAY))].iloc[0]
    assert day0["yhat"] == pytest.approx(20 * 0.15 + 10 * 0.2)
    assert day0["yhat_upper"] == pytest.approx(26 * 0.15 + 12 * 0.2)
    assert set(ing["method"]) == {"recipe"}


def test_prep_list_reduced_by_recent_wastage(cfg):
    waste = pd.DataFrame({"dish_id": ["pbm"] * 7, "qty": [6] * 7,
                          "date": [str(TODAY - dt.timedelta(days=i)) for i in range(1, 8)]})
    recipes = pd.DataFrame({"dish_id": ["pbm", "tikka"], "name": ["Paneer Butter Masala", "Paneer Tikka"]})
    out = {r["dish_id"]: r for r in prep_list(dish_fc(), recipes, waste, TODAY, cfg)}
    assert out["pbm"]["avg_daily_wastage"] == 3.0       # 42 over 14 days
    assert out["pbm"]["prep_portions"] == 17
    assert out["tikka"]["prep_portions"] == 10


def test_prep_list_cut_is_capped(cfg):
    waste = pd.DataFrame({"dish_id": ["pbm"] * 14, "qty": [50] * 14,
                          "date": [str(TODAY - dt.timedelta(days=i)) for i in range(1, 15)]})
    recipes = pd.DataFrame({"dish_id": ["pbm", "tikka"], "name": ["a", "b"]})
    out = {r["dish_id"]: r for r in prep_list(dish_fc(), recipes, waste, TODAY, cfg)}
    assert out["pbm"]["prep_portions"] == 14  # at most 30% off 20


def test_perishable_flag_uses_recorded_expiry():
    ing = ingredient_forecast(dish_fc(), RECIPES)  # paneer: 5 kg today, 2.5 kg tomorrow
    batches = pd.DataFrame({"batch_id": ["b1", "b2"], "product_id": ["paneer", "butter"],
                            "quantity": [12.0, 1.0], "cost_price": [380.0, 500.0],
                            "expiry_date": [str(TODAY + dt.timedelta(days=1)), None]})
    products = pd.DataFrame({"product_id": ["paneer", "butter"], "name": ["Paneer", "Butter"], "unit": ["kg", "kg"]})
    flags = perishable_flags(ing, batches, products, TODAY)
    assert len(flags) == 1  # butter has no recorded expiry, so it is never flagged
    f = flags[0]
    assert f["name"] == "Paneer" and f["forecast_use_before_expiry"] == 7.5 and f["at_risk_qty"] == 4.5


def test_dead_stock(cfg):
    products = pd.DataFrame({"product_id": ["a", "b", "c"], "name": ["A", "B", "C"]})
    sales = pd.DataFrame({"product_id": ["a", "b"], "qty": [1, 1],
                          "sold_at": [str(TODAY - dt.timedelta(days=2)), str(TODAY - dt.timedelta(days=70))]})
    batches = pd.DataFrame({"product_id": ["a", "b", "c"], "quantity": [5, 4, 2], "cost_price": [10, 50, 20]})
    out = {d["product_id"]: d for d in dead_stock(products, sales, batches, TODAY, cfg)}
    assert set(out) == {"b", "c"}
    assert out["b"]["on_hand_value"] == 200 and out["b"]["suggested_discount"] == "20-30%"
    assert out["c"]["days_unsold"] is None


def test_bundles_keep_only_lift_above_threshold(cfg):
    rows = []
    for i in range(100):
        basket = ["bread", "butter"] if i < 30 else (["bread"] if i < 60 else ["salt"])
        if i % 3 == 0:
            basket.append("milk")
        rows += [{"sale_id": f"s{i}", "product_id": p, "qty": 1, "sold_at": str(TODAY - dt.timedelta(days=1))}
                 for p in basket]
    products = pd.DataFrame({"product_id": ["bread", "butter", "salt", "milk"],
                             "name": ["Bread", "Butter", "Salt", "Milk"]})
    rules = bundle_rules(pd.DataFrame(rows), products, TODAY, cfg)
    assert rules and all(r["lift"] >= 1.2 for r in rules)
    assert {rules[0]["if_bought"], rules[0]["also_buy"]} == {"Bread", "Butter"}


def test_text_matching_maps_messy_names():
    products = pd.DataFrame({"product_id": ["m", "p", "k"],
                             "name": ["Maggi Masala Noodles 70g", "Parle-G Biscuit 80g", "Kissan Ketchup 500g"]})
    r = match("maggi", products)
    assert r["auto"] and r["best"]["product_id"] == "m"
    assert match("parle g 20 pkt", products)["best"]["product_id"] == "p"
    assert not match("sabun", products)["auto"]  # low confidence -> ask the owner
