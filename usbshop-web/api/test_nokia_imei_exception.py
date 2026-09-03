from types import SimpleNamespace

from main import _product_requires_imei


class FakeConn:
    def __init__(self, category_name: str):
        self.category_name = category_name

    def execute(self, *args, **kwargs):
        return SimpleNamespace(fetchone=lambda: {"name": self.category_name})


def test_nokia_106_exception_is_not_imei_required():
    conn = FakeConn("Celulares")
    assert _product_requires_imei(conn, category_id=1, product_name="Nokia 106") is False
    assert _product_requires_imei(conn, category_id=1, product_name="Nokia 106 Dual SIM") is False
    assert _product_requires_imei(conn, category_id=1, product_name="Samsung A16") is True
