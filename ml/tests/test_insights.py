"""Insight text contains no number absent from its input JSON."""

import json

from insights.generate import check_insights, new_numbers

FACTS = {"dead_stock": [{"name": "Horlicks 500g", "days_unsold": 75, "on_hand_value": 1740.0}],
         "bundles": [{"if_bought": "Bread", "also_buy": "Butter", "lift": 2.4}]}


def tips(text):
    return json.dumps({"tips": [{"title": "Clear old stock", "text": text, "source_keys": ["dead_stock"]}]})


def test_accepts_numbers_from_input():
    assert check_insights(tips("Horlicks has not sold in 75 days; Rs 1,740 is stuck in it."), FACTS)["valid"]


def test_rejects_invented_numbers():
    r = check_insights(tips("Give 20% off Horlicks to recover Rs 1740 within 75 days."), FACTS)
    assert not r["valid"] and "20" in r["errors"][0]


def test_rejects_rounded_or_derived_numbers():
    assert new_numbers("Bread buyers are 2 times likelier to buy butter", FACTS) == {"2"}
    assert new_numbers("about 1700 rupees", FACTS) == {"1700"}


def test_rejects_malformed_output():
    assert not check_insights("not json", FACTS)["valid"]
    assert not check_insights(json.dumps({"tips": [{"title": "x"}]}), FACTS)["valid"]
