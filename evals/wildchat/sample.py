"""Sample real user first-turn messages from WildChat-1M (allenai, ODC-BY) via the HF rows API.
Fixed offsets → reproducible. Filters: non-toxic, question-like, 15–400 chars, no code/creative-writing/roleplay.
Writes wildchat-sample.json (200 messages). Usage: python3 sample.py"""
import json, random, re, time, urllib.request
random.seed(20261112)
offsets = sorted(random.sample(range(0, 800_000, 100), 40))
rows = []
for off in offsets:
    url = f"https://datasets-server.huggingface.co/rows?dataset=allenai/WildChat-1M&config=default&split=train&offset={off}&length=100"
    for attempt in range(4):
        try:
            rows += json.load(urllib.request.urlopen(url, timeout=40))["rows"]; break
        except Exception:
            time.sleep(3 * (attempt + 1))
QUESTION = re.compile(r"(\?|^(what|who|when|where|which|how|is|are|can|does|do|should|best|compare|price|latest|current|recommend|tell me|explain)\b)", re.I)
EXCLUDE = re.compile(r"(```|def |function |class |import |\{|\}|write (a|an|me)|story|poem|essay|roleplay|role-play|pretend|imagine|lyrics|rewrite|paraphrase|translate|summari[sz]e (this|the following)|act as|you are a|continue|fanfic|character|\bnsfw\b|sex)", re.I)
seen, keep = set(), []
for r in rows:
    row = r["row"]
    if row.get("toxic") or row.get("redacted"): continue
    conv = row.get("conversation") or []
    if not conv or conv[0].get("role") != "user": continue
    msg = re.sub(r"\s+", " ", conv[0]["content"]).strip()
    if not (15 <= len(msg) <= 400) or EXCLUDE.search(msg) or not QUESTION.search(msg): continue
    key = msg.lower()[:60]
    if key in seen: continue
    seen.add(key)
    keep.append({"lang": row.get("language"), "q": msg, "conversation_hash": row.get("conversation_hash")})
random.shuffle(keep)
en = [k for k in keep if k["lang"] == "English"]; other = [k for k in keep if k["lang"] != "English"]
sample = (en[:120] + other[:80])[:200]
random.shuffle(sample)
json.dump({"source": "allenai/WildChat-1M (ODC-BY), first user turns", "fetched_rows": len(rows), "candidates": len(keep), "cases": sample}, open("wildchat-sample.json", "w"), indent=1, ensure_ascii=False)
from collections import Counter
print(len(rows), "rows fetched,", len(keep), "candidates,", len(sample), "sampled"); print(Counter(s["lang"] for s in sample).most_common(8))
for s in sample[:12]: print(" -", s["lang"], "|", s["q"][:110])
