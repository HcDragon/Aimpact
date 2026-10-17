import pandas as pd
import pytest

from settings import load_config


@pytest.fixture
def cfg():
    return load_config()


def make_fc(item, start, yhat, upper, lower=None, method="moving_avg"):
    ds = pd.date_range(start, periods=len(yhat), freq="D")
    return pd.DataFrame({"item": item, "ds": ds, "yhat": yhat, "yhat_upper": upper,
                         "yhat_lower": lower if lower is not None else [0.0] * len(yhat), "method": method})
