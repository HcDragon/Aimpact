"""Job writes only rows for the business it was run for."""

import pandas as pd
import pytest

from db import TABLES, BusinessScopeError, LocalStore


def rows(biz, n=2):
    r = {c: 0 for c in TABLES["forecasts"]}
    return pd.DataFrame([{**r, "business_id": biz, "product_id": f"p{i}"} for i in range(n)])


def test_rejects_rows_for_other_business(tmp_path):
    store = LocalStore(tmp_path)
    with pytest.raises(BusinessScopeError):
        store.write_forecasts("b1", pd.concat([rows("b1"), rows("b2")]))
    assert not (tmp_path / "forecasts.csv").exists()


def test_rerun_replaces_only_own_rows(tmp_path):
    store = LocalStore(tmp_path)
    store.write_forecasts("b1", rows("b1", 3))
    store.write_forecasts("b2", rows("b2", 2))
    store.write_forecasts("b1", rows("b1", 1))
    assert len(store.read("forecasts", "b1")) == 1
    assert len(store.read("forecasts", "b2")) == 2


def test_cannot_update_columns_ml_does_not_own(tmp_path):
    store = LocalStore(tmp_path)
    store.write_table("products", pd.DataFrame({"product_id": ["p1"], "business_id": ["b1"], "name": ["x"]}))
    with pytest.raises(PermissionError):
        store.update_columns("products", "b1", "product_id",
                             pd.DataFrame({"product_id": ["p1"], "business_id": ["b1"], "name": ["y"]}))
    store.update_columns("products", "b1", "product_id",
                         pd.DataFrame({"product_id": ["p1"], "business_id": ["b1"], "embedding": ["[1, 2]"]}))
    assert store.read("products", "b1")["embedding"].iloc[0] == "[1, 2]"
