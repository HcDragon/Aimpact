"""Data access for the ML job.

LocalStore reads CSVs under ml/data/ for offline experiments and evaluation.

Production data lives in Supabase with the schema in supabase/migrations/. There,
forecasts are produced by forecasting/run_forecasts.py, which calls this package
through forecasting/model.py. This store is not a Supabase client.

The ML side only writes to `forecasts` and ML-owned columns
(products.embedding, reviews.sentiment/aspects). Every read and write is
scoped to one business_id.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from settings import load_config, ml_path

# Tables the job reads, with the columns it relies on (see PRD "Data contracts").
TABLES = {
    "businesses": ["business_id", "name", "type", "is_synthetic"],
    "products": ["product_id", "business_id", "name", "unit", "barcode", "category", "gst_rate", "supplier_id"],
    "sales": ["sale_id", "business_id", "sold_at", "total"],
    "sale_items": ["sale_id", "business_id", "product_id", "dish_id", "qty", "price", "sold_at"],
    "stock_batches": ["batch_id", "business_id", "product_id", "quantity", "cost_price", "expiry_date"],
    "suppliers": ["supplier_id", "business_id", "name", "lead_time_days"],
    "supplier_prices": ["supplier_id", "business_id", "product_id", "price", "pack_size", "effective_from"],
    "purchase_orders": ["po_id", "business_id", "product_id", "qty", "status"],
    "recipes": ["dish_id", "business_id", "name", "price"],
    "recipe_ingredients": ["dish_id", "business_id", "product_id", "qty", "unit"],
    "wastage_log": ["business_id", "dish_id", "product_id", "qty", "reason", "date"],
    "reviews": ["review_id", "business_id", "text", "source", "date", "sentiment", "aspects"],
    "forecasts": [
        "business_id", "product_id", "dish_id", "forecast_date", "yhat", "yhat_lower", "yhat_upper",
        "safety_stock", "reorder_point", "reorder_qty", "method", "reason", "model_version",
        "generated_at", "is_synthetic",
    ],
}

# Columns the ML side may update outside `forecasts`.
ML_OWNED_COLUMNS = {
    "products": {"embedding"},
    "reviews": {"sentiment", "aspects"},
}


class BusinessScopeError(ValueError):
    """Raised when a write would touch rows of a business other than the one being run."""


def _check_scope(df: pd.DataFrame, business_id: str) -> None:
    if df.empty:
        return
    others = set(df["business_id"].astype(str)) - {str(business_id)}
    if others:
        raise BusinessScopeError(f"refusing to write rows for other businesses: {sorted(others)}")


class LocalStore:
    def __init__(self, root: Path | None = None):
        cfg = load_config()
        self.root = Path(root) if root else ml_path(cfg["storage"]["local_dir"])

    def _file(self, table: str) -> Path:
        return self.root / f"{table}.csv"

    def read(self, table: str, business_id: str | None) -> pd.DataFrame:
        path = self._file(table)
        if not path.exists():
            return pd.DataFrame(columns=TABLES[table])
        df = pd.read_csv(path, dtype={"business_id": str, "product_id": str, "dish_id": str,
                                      "supplier_id": str, "sale_id": str, "barcode": str})
        if business_id is not None and "business_id" in df.columns:
            df = df[df["business_id"] == str(business_id)]
        return df.reset_index(drop=True)

    def write_table(self, table: str, df: pd.DataFrame) -> None:
        """Seeding only: replace a whole table."""
        self.root.mkdir(parents=True, exist_ok=True)
        df.to_csv(self._file(table), index=False)

    def write_forecasts(self, business_id: str, rows: pd.DataFrame) -> int:
        _check_scope(rows, business_id)
        existing = self.read("forecasts", None)
        keep = existing[existing["business_id"] != str(business_id)] if not existing.empty else existing
        out = pd.concat([keep, rows[TABLES["forecasts"]]], ignore_index=True) if not keep.empty else rows[TABLES["forecasts"]]
        self.write_table("forecasts", out)
        return len(rows)

    def update_columns(self, table: str, business_id: str, key: str, rows: pd.DataFrame) -> int:
        _check_owned(table, rows.columns, key)
        _check_scope(rows, business_id)
        df = self.read(table, None)
        updates = rows.set_index(key)
        mask = df["business_id"] == str(business_id)
        for col in updates.columns.drop("business_id", errors="ignore"):
            if col not in df.columns:
                df[col] = None
            df[col] = df[col].astype(object)
            mapped = df.loc[mask, key].map(updates[col])
            df.loc[mask & mapped.notna(), col] = mapped[mapped.notna()]
        self.write_table(table, df)
        return len(rows)


def _check_owned(table: str, columns, key: str) -> None:
    extra = set(columns) - {key, "business_id"} - ML_OWNED_COLUMNS.get(table, set())
    if extra:
        raise PermissionError(f"ML side does not own {table}.{sorted(extra)}")


def get_store(backend: str | None = None):
    backend = backend or load_config()["storage"]["backend"]
    if backend == "local":
        return LocalStore()
    if backend == "supabase":
        raise SystemExit("Supabase runs go through forecasting/run_forecasts.py (model: forecasting/model.py) "
                         "and forecasting/evaluate_forecasts.py; ml/ jobs only read local CSVs.")
    raise ValueError(f"unknown storage backend: {backend}")
