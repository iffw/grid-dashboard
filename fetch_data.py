#!/usr/bin/env python3
"""网格看板备用取数脚本（在 Mac 本地运行）。

用途：当 index.html 在浏览器里直连 OKX 失败时，先跑这个脚本，
它会把 K 线数据写成本地文件 data/<交易对>_<周期>.json，
页面再次拉取时会自动改用本地文件。

用法：
    python3 fetch_data.py                     # 默认：三个标的，4H，90 天
    python3 fetch_data.py --bar 1H --days 30  # 换周期/天数
    python3 fetch_data.py --inst BTC-USDT-SWAP

只用 Python 标准库，不用装任何包。不需要 API 密钥（OKX 公共接口）。
"""
import argparse
import json
import time
import urllib.request
from pathlib import Path

BAR_HOURS = {"1H": 1, "4H": 4, "1D": 24}
BASE = "https://www.okx.com"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fetch_candles(inst, bar, days):
    need = int(days * 24 / BAR_HOURS[bar]) + 2
    by_ts = {}
    after = None
    while len(by_ts) < need:
        url = f"{BASE}/api/v5/market/history-candles?instId={inst}&bar={bar}&limit=100"
        if after:
            url += f"&after={after}"
        j = get_json(url)
        if j.get("code") != "0":
            raise RuntimeError(f"OKX 返回错误 {j.get('code')} {j.get('msg')}")
        rows = j.get("data") or []
        if not rows:
            break
        for r in rows:
            by_ts[int(r[0])] = {
                "ts": int(r[0]) // 1000,
                "o": float(r[1]), "h": float(r[2]),
                "l": float(r[3]), "c": float(r[4]),
                "volQuote": float(r[7]),
                "confirm": r[8],
            }
        after = rows[-1][0]
        if len(rows) < 100:
            break
        time.sleep(0.15)
    cutoff = time.time() - days * 86400 - BAR_HOURS[bar] * 3600
    out = [c for c in sorted(by_ts.values(), key=lambda x: x["ts"])
           if c["confirm"] == "1" and c["ts"] >= cutoff]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", action="append",
                    help="交易对，可多次给；默认三个首批标的")
    ap.add_argument("--bar", default="4H", choices=list(BAR_HOURS))
    ap.add_argument("--days", type=int, default=90)
    args = ap.parse_args()

    insts = args.inst or ["BTC-USDT-SWAP", "CRCL-USDT-SWAP", "SOXL-USDT-SWAP"]
    data_dir = Path(__file__).resolve().parent / "data"
    data_dir.mkdir(exist_ok=True)
    for inst in insts:
        candles = fetch_candles(inst, args.bar, args.days)
        path = data_dir / f"{inst}_{args.bar}.json"
        path.write_text(json.dumps(candles))
        if candles:
            print(f"{inst} {args.bar}: {len(candles)} 根 -> {path.name}")
        else:
            print(f"{inst} {args.bar}: 没拉到数据（检查网络或交易对名称）")


if __name__ == "__main__":
    main()
